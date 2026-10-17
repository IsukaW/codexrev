/**
 * Two-phase authorization: PREPARE, then FINALIZE.
 *
 * `evaluateAuthorization` consumes the proof's challenge as soon as the prerequisites pass. That burns
 * the challenge even when the ordinary safety assessment later blocks or escalates the action. This
 * module splits that step in two so the irreversible part can wait for the safety decision:
 *
 *   prepareAuthorization    runs every prerequisite check (the same six checks, from
 *                           runAuthorizationChecks) and NEVER touches the challenge store. It can
 *                           return `ready_for_finalization`, never `authorized`. The challenge check
 *                           is reported as `pending`, not `passed`.
 *   attestSafetyDecision    wraps the safety assessment's final decision for ONE prepared result.
 *   finalizeAuthorization   requires an ALLOW attestation, re-binds to the exact action context and
 *                           challenge, RE-RUNS every time-sensitive check at the finalization time,
 *                           and only then asks the store to consume the challenge. It returns
 *                           `authorized` only if consumption succeeded. Revalidation failure, a
 *                           missing store or a failed consumption all block.
 *
 * Outcomes: ready_for_finalization (preparation only) | authorized (finalization only, challenge
 * consumed) | denied | incomplete. Denied and incomplete both block.
 *
 * WHAT IS REVALIDATED at finalization, by the existing verifiers, never by trusting preparation:
 * policy effectiveness, requester grant window, requester revocation freshness and status, proof
 * expiry and binding, and the policy revision the grants were verified against. A trusted caller may supply
 * a refreshed policy or revocation list through `refresh`; a refreshed policy must keep the prepared
 * policy id and revision.
 *
 * WHAT IS BOUND: the action id, type, environment, target, commit, content digest and the expected
 * challenge. The finalizing caller must supply them AGAIN (from its own re-check of the action) and
 * they must equal what was prepared. They are never taken from the proof.
 *
 * THE SAFETY-DECISION BOUNDARY IS NOT AUTHENTICATED. There is no existing trusted safety-decision
 * type that this subsystem can use without modifying the assessment pipeline, so `attestSafetyDecision`
 * is a typed hand-off: a branded object tied to one prepared result and one action context. TypeScript
 * brands and WeakMaps stop accidents and plain-object forgery; they do NOT stop code running in the
 * same process from calling `attestSafetyDecision(prepared, 'ALLOW', ...)` on its own. Anything that
 * can call it can claim ALLOW. Finalization is therefore only meaningful when the TRUSTED PIPELINE
 * is the sole caller: that is an integration requirement of the later stage, not something this
 * module can enforce. Attestations say `issuer: 'unauthenticated_in_process'` on purpose.
 *
 * REPLAY. A prepared result is not a reusable token. Within one process, a prepared result and an
 * attestation can each be finalized once (tracked in WeakSets). That is NOT replay protection: it
 * disappears with the process and with a copied or re-prepared result. The only protection against
 * a second consumption of the same challenge, across calls or processes, is the external challenge
 * store's atomic single-use semantics, exactly as in evaluateAuthorization.
 *
 * Nothing here reads files, Git, the network or the environment, and it never executes an action.
 */

import type { Decision } from '../model/types.js';
import {
  check,
  checkRunSatisfied,
  notEvaluated,
  runAuthorizationChecks,
  type AuthorizationChecks,
  type AuthorizationRequirements,
  type Check,
  type EvaluateAuthorizationParams,
} from './evaluateAuthorization.js';
import { isVerifiedPolicy, type PolicyDocument } from './policy.js';
import { consumeChallenge, parseActionContext, type ActionContext, type ChallengeStore } from './proof.js';
import type { RevocationListResult } from './revocation.js';
import type { TrustRoot } from './trustRoot.js';
import type { VerifiedGrant } from './grant.js';

export type PreparedOutcome = 'ready_for_finalization' | 'denied' | 'incomplete';
export type FinalizedOutcome = 'authorized' | 'denied' | 'incomplete';

/** The result of preparation: every prerequisite checked, the challenge NOT consumed. */
export interface PreparedAuthorization {
  readonly outcome: PreparedOutcome;
  /** the seven checks; `challengeConsumption` is `pending` when ready, never `passed` */
  readonly checks: AuthorizationChecks;
  readonly requirements?: AuthorizationRequirements;
  /** when preparation happened (the evaluation time it was given) */
  readonly preparedAt: string;
  /** always 'not_enforced': nothing has been consumed yet */
  readonly replayProtection: 'not_enforced';
  readonly executionPerformed: false;
}

export interface FinalizationChecks extends AuthorizationChecks {
  /** prepared result, safety decision, action binding and time: everything specific to finalizing */
  readonly finalization: Check;
}

export interface FinalizedAuthorization {
  readonly outcome: FinalizedOutcome;
  readonly checks: FinalizationChecks;
  readonly requirements?: AuthorizationRequirements;
  /** set only when finalization itself failed unexpectedly */
  readonly reason?: 'finalization_failed';
  /** 'consumed' only when the supplied store recorded this proof's challenge as used */
  readonly replayProtection: 'consumed' | 'not_enforced';
  /** this subsystem never executes anything: `authorized` means the prerequisites are met and the challenge is spent, not "run it" */
  readonly executionPerformed: false;
}

export interface SafetyDecisionAttestation {
  readonly kind: 'safety_decision_attestation';
  readonly decision: Decision;
  /** says plainly that nothing authenticates who made this attestation (see the file header) */
  readonly issuer: 'unauthenticated_in_process';
}

const DECISIONS: readonly Decision[] = ['ALLOW', 'ESCALATE', 'BLOCK'];

// ---------------------------------------------------------------- brands (in-process only)

interface Captured {
  readonly trustRoot: TrustRoot;
  readonly policy: PolicyDocument;
  readonly requester: VerifiedGrant;
  readonly revocation: RevocationListResult | undefined;
  readonly context: ActionContext;
  readonly challenge: string;
  readonly proof: unknown;
  readonly preparedAtMs: number;
}

const prepared = new WeakSet<object>();
/** what a READY prepared result needs in order to be re-checked later; unreachable from outside this module */
const captured = new WeakMap<object, Captured>();
const attestations = new WeakMap<object, { readonly prepared: object; readonly decision: Decision; readonly context: ActionContext | undefined }>();
const finalizedResults = new WeakSet<object>();
/** in-process bookkeeping only: this is NOT durable replay protection */
const spentPrepared = new WeakSet<object>();
const spentAttestations = new WeakSet<object>();

/**
 * What a genuine ready or authorized result was ABOUT: the verified requester grant, the verified
 * policy it was checked under, the action context, and when it was evaluated. Read-only facts taken
 * from objects that were already verified; no new authority. Used by strictAuthorityAdapter.ts.
 */
export interface AuthorizationSubject {
  readonly requester: VerifiedGrant;
  readonly policy: PolicyDocument;
  readonly context: ActionContext;
  /** ISO time of the evaluation that produced the result (preparation time, or finalization time) */
  readonly evaluatedAt: string;
}

const subjects = new WeakMap<object, AuthorizationSubject>();

/**
 * The subject of a genuine prepared result that is ready, or of a genuine finalized result that is
 * authorized. Undefined for anything else (denied, incomplete, forged, copied, cloned).
 */
export const authorizationSubjectOf = (result: unknown): AuthorizationSubject | undefined => (typeof result === 'object' && result !== null ? subjects.get(result) : undefined);

export const isPreparedAuthorization = (x: unknown): x is PreparedAuthorization => typeof x === 'object' && x !== null && prepared.has(x);
export const isFinalizedAuthorization = (x: unknown): x is FinalizedAuthorization => typeof x === 'object' && x !== null && finalizedResults.has(x);
export const isSafetyDecisionAttestation = (x: unknown): x is SafetyDecisionAttestation => typeof x === 'object' && x !== null && attestations.has(x);

// ---------------------------------------------------------------- helpers

const hasStore = (s: unknown): s is ChallengeStore => typeof (s as { consume?: unknown } | undefined)?.consume === 'function';

const sameContext = (a: ActionContext, b: ActionContext): boolean =>
  a.actionId === b.actionId && a.actionType === b.actionType && a.environment === b.environment && a.target === b.target && a.commit === b.commit && a.contentDigest === b.contentDigest;

/** A private copy of signed JSON, so later changes to the caller's object cannot alter what was prepared. */
function cloneJson<T>(x: T): T {
  if (typeof x !== 'object' || x === null) return x;
  try {
    return JSON.parse(JSON.stringify(x)) as T;
  } catch {
    return x; // not plain JSON: the verifier will refuse it anyway
  }
}

const isSatisfied = (c: Check): boolean => c.status === 'passed' || c.status === 'not_required';

function blankChecks(policy: Check): AuthorizationChecks {
  return {
    policy,
    requesterGrant: notEvaluated(),
    requesterRevocation: notEvaluated(),
    roles: notEvaluated(),
    permissions: notEvaluated(),
    proofOfPossession: notEvaluated(),
    challengeConsumption: notEvaluated(),
  };
}

// ---------------------------------------------------------------- phase A: prepare

function buildPrepared(checks: AuthorizationChecks, preparedAt: string, extra: Partial<PreparedAuthorization>): PreparedAuthorization {
  const all = Object.values(checks);
  const outcome: PreparedOutcome = all.some((c) => c.status === 'failed')
    ? 'denied'
    : all.every((c) => c.status === 'passed' || c.status === 'not_required' || (c.status === 'pending' && c === checks.challengeConsumption))
      ? 'ready_for_finalization'
      : 'incomplete';
  const result: PreparedAuthorization = Object.freeze({
    outcome,
    checks: Object.freeze(checks),
    preparedAt,
    replayProtection: 'not_enforced' as const,
    executionPerformed: false as const,
    ...extra,
  });
  prepared.add(result);
  return result;
}

/**
 * Phase A. Verifies every prerequisite EXCEPT consuming the challenge, and never calls the challenge
 * store (it only checks that one was supplied). The best outcome is `ready_for_finalization`: it is
 * not an authorization and cannot be used as one. Never throws.
 */
export function prepareAuthorization(params: EvaluateAuthorizationParams): PreparedAuthorization {
  try {
    const run = runAuthorizationChecks(params);
    const satisfied = checkRunSatisfied(run);
    // a store must exist for finalization to be possible, so its absence is reported now, not later
    const consumption: Check = !satisfied ? notEvaluated() : !hasStore(params.challengeStore) ? check('incomplete', 'no_challenge_store') : check('pending', 'challenge_pending');
    const checks: AuthorizationChecks = { ...run.base, challengeConsumption: consumption };
    const preparedAt = params.now.toISOString();
    const result = buildPrepared(checks, preparedAt, {
      ...(run.extra.requirements ? { requirements: run.extra.requirements } : {}),
    });

    if (result.outcome === 'ready_for_finalization' && run.verifiedProof) {
      const ctx = parseActionContext(params.context);
      if (ctx.ok) {
        subjects.set(result, Object.freeze({ requester: params.requester, policy: params.policy, context: ctx.context, evaluatedAt: preparedAt }));
        captured.set(result, {
          trustRoot: params.trustRoot,
          policy: params.policy,
          requester: params.requester,
          revocation: params.revocation,
          context: ctx.context,
          challenge: params.challenge,
          proof: cloneJson(params.proof),
          preparedAtMs: params.now.getTime(),
        });
      }
    }
    return result;
  } catch {
    // fail closed: an unexpected error is a denial, never readiness
    return buildPrepared(blankChecks(check('failed', 'policy_unverified')), '', {});
  }
}

// ---------------------------------------------------------------- the safety-decision hand-off

/**
 * Ties a safety decision to ONE prepared result and ONE action context. See the file header: this
 * is a typed hand-off, NOT an authenticated boundary. Only the trusted pipeline may call it, and only
 * with the decision the assessment actually reached. An unrecognized decision is recorded as BLOCK.
 * Never throws.
 */
export function attestSafetyDecision(preparedResult: PreparedAuthorization, decision: Decision, context: ActionContext): SafetyDecisionAttestation {
  const normalized: Decision = DECISIONS.includes(decision) ? decision : 'BLOCK';
  let ctx: ActionContext | undefined;
  try {
    const parsed = parseActionContext(context);
    if (parsed.ok) ctx = parsed.context;
  } catch {
    ctx = undefined;
  }
  const attestation: SafetyDecisionAttestation = Object.freeze({ kind: 'safety_decision_attestation' as const, decision: normalized, issuer: 'unauthenticated_in_process' as const });
  attestations.set(attestation, { prepared: preparedResult, decision: normalized, context: ctx });
  return attestation;
}

// ---------------------------------------------------------------- phase B: finalize

export interface FinalizeAuthorizationParams {
  /** the result of prepareAuthorization */
  readonly prepared: PreparedAuthorization;
  /** from attestSafetyDecision, for THIS prepared result. Without it nothing is consumed. */
  readonly safetyDecision: SafetyDecisionAttestation | undefined;
  /** the action as the trusted caller sees it NOW: must equal the prepared context exactly */
  readonly context: ActionContext;
  /** the expected challenge: must equal the prepared one exactly */
  readonly challenge: string;
  /** the trusted, atomic, persistent single-use store. Without one the best outcome is `incomplete`. */
  readonly challengeStore?: ChallengeStore;
  /** injected finalization time: every time-sensitive check is re-run at this instant */
  readonly now: Date;
  /**
   * Optional fresher evidence from the trusted caller. A refreshed policy must keep the prepared
   * policy id and revision. Include the `revocation` key to replace the prepared revocation list
   * (`undefined` means "none available now"); omit it to keep the prepared one, whose freshness is
   * re-checked at `now` either way.
   */
  readonly refresh?: { readonly policy?: PolicyDocument; readonly revocation?: RevocationListResult | undefined };
}

function buildFinal(checks: FinalizationChecks, extra: Partial<FinalizedAuthorization> = {}, subject?: AuthorizationSubject): FinalizedAuthorization {
  const all = Object.values(checks);
  const outcome: FinalizedOutcome = all.some((c) => c.status === 'failed') ? 'denied' : all.every(isSatisfied) ? 'authorized' : 'incomplete';
  const result: FinalizedAuthorization = Object.freeze({
    outcome,
    checks: Object.freeze(checks),
    replayProtection: checks.challengeConsumption.code === 'challenge_consumed' ? ('consumed' as const) : ('not_enforced' as const),
    executionPerformed: false as const,
    ...extra,
  });
  finalizedResults.add(result);
  if (subject && outcome === 'authorized') subjects.set(result, subject);
  return result;
}

/** A finalization that stopped before re-running the checks: the seven checks are not evaluated. */
const stopped = (finalization: Check): FinalizedAuthorization => buildFinal({ ...blankChecks(notEvaluated()), finalization });

/**
 * Phase B. Consumes the challenge only after: a valid prepared result, a trusted ALLOW attestation
 * for it, an unchanged action context and challenge, and a full re-run of the time-sensitive checks
 * at `now`. Returns `authorized` only if the store consumed the challenge. Never throws; never
 * executes anything. See the file header for the replay and trust-boundary limits.
 */
export async function finalizeAuthorization(params: FinalizeAuthorizationParams): Promise<FinalizedAuthorization> {
  try {
    return await finalizeUnchecked(params);
  } catch {
    return buildFinal({ ...blankChecks(notEvaluated()), finalization: check('failed', 'prepared_invalid') }, { reason: 'finalization_failed' });
  }
}

async function finalizeUnchecked(params: FinalizeAuthorizationParams): Promise<FinalizedAuthorization> {
  const { prepared: result, safetyDecision, context, challenge, challengeStore, now, refresh } = params;

  // 1. the prepared result: genuine, ready, and not already used (in this process)
  if (!isPreparedAuthorization(result)) return stopped(check('failed', 'prepared_invalid'));
  const cap = captured.get(result);
  if (result.outcome !== 'ready_for_finalization' || !cap) return stopped(check(result.outcome === 'incomplete' ? 'incomplete' : 'failed', 'prepared_not_ready'));
  if (spentPrepared.has(result)) return stopped(check('failed', 'already_finalized'));
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return stopped(check('failed', 'invalid_evaluation_time'));
  if (now.getTime() < cap.preparedAtMs) return stopped(check('failed', 'time_went_backwards'));

  // 2. the safety decision: present, issued for THIS prepared result and context, unused, and ALLOW
  if (safetyDecision === undefined || safetyDecision === null) return stopped(check('incomplete', 'safety_decision_missing'));
  const att = attestations.get(safetyDecision);
  if (!att) return stopped(check('failed', 'safety_decision_untrusted'));
  if (att.prepared !== result || att.context === undefined || !sameContext(att.context, cap.context)) return stopped(check('failed', 'safety_decision_mismatch'));
  if (spentAttestations.has(safetyDecision)) return stopped(check('failed', 'already_finalized'));
  if (att.decision !== 'ALLOW') return stopped(check('failed', 'safety_not_allow', att.decision));

  // 3. the action is exactly the prepared one, with the exact challenge, under the same policy
  const now_ctx = parseActionContext(context);
  if (!now_ctx.ok || !sameContext(now_ctx.context, cap.context)) return stopped(check('failed', 'context_changed'));
  if (typeof challenge !== 'string' || challenge !== cap.challenge) return stopped(check('failed', 'challenge_changed'));
  const policy = refresh?.policy ?? cap.policy;
  if (isVerifiedPolicy(policy) && (policy.policyId !== cap.policy.policyId || policy.revision !== cap.policy.revision)) return stopped(check('failed', 'policy_changed'));
  const revocation = refresh && 'revocation' in refresh ? refresh.revocation : cap.revocation;

  // 4. re-run every time-sensitive prerequisite at the finalization time, with the existing verifiers
  const run = runAuthorizationChecks({
    trustRoot: cap.trustRoot,
    policy,
    requester: cap.requester,
    revocation,
    context: cap.context,
    challenge: cap.challenge,
    proof: cap.proof,
    now,
  });
  const extra: Partial<FinalizedAuthorization> = { ...(run.extra.requirements ? { requirements: run.extra.requirements } : {}) };
  const ready = check('passed', 'finalization_ready');
  if (!checkRunSatisfied(run) || !run.verifiedProof) return buildFinal({ ...run.base, challengeConsumption: notEvaluated(), finalization: ready }, extra);

  // 5. the store must exist; without one nothing can be consumed
  if (!hasStore(challengeStore)) return buildFinal({ ...run.base, challengeConsumption: check('incomplete', 'no_challenge_store'), finalization: ready }, extra);

  // 6. the ONE irreversible step. Marked spent BEFORE the store is called, synchronously, so a second
  // concurrent call in this process cannot also reach the store. (In-process only: not durable.)
  spentPrepared.add(result);
  spentAttestations.add(safetyDecision);
  const outcome = await consumeChallenge(run.verifiedProof, challengeStore);
  const consumption =
    outcome === 'consumed' ? check('passed', 'challenge_consumed') : outcome === 'already_used' ? check('failed', 'challenge_already_used') : check('incomplete', 'challenge_store_unavailable');
  const subject: AuthorizationSubject = Object.freeze({ requester: cap.requester, policy, context: cap.context, evaluatedAt: now.toISOString() });
  return buildFinal({ ...run.base, challengeConsumption: consumption, finalization: ready }, extra, subject);
}
