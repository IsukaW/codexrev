/**
 * The combined authorization evaluator.
 *
 * It answers one question: given a trusted company policy, a verified requester grant, revocation
 * information, a proof of possession and the required roles and permissions, are ALL the authorization PREREQUISITES satisfied for this exact action?
 *
 * It coordinates the existing verifiers (policy.ts, grant.ts, revocation.ts, proof.ts)
 * and adds no cryptography of its own. It NEVER executes, schedules or triggers the proposed
 * action: `authorized` means "the prerequisites are met", never "go and run it". The result
 * carries `executionPerformed: false` to say so.
 *
 * INPUTS. Anything that carries trust must already be a verified, branded object produced by the
 * existing verifiers: the trust root, the policy, the requester grant and the revocation list.
 * Plain objects such as `{ verified: true }` are rejected. Only the signed proof
 * arrives as a raw artifact, and it is verified here by the existing verifier. The
 * expected action context and challenge are supplied separately, by the caller, from a trusted
 * source; they are never derived from the proof. Nothing is read from the
 * working directory, Git, the network or the environment, and time is injected.
 *
 * OUTCOMES (each prevents execution unless it is `authorized`):
 *   authorized  every check passed (or is not required) AND the proof's challenge was consumed
 *               by the supplied challenge store.
 *   denied      something definitive failed: the policy forbids the action, the requester lacks a
 *               role or permission, the grant is revoked or invalid, the proof is invalid, or the
 *               challenge was already used.
 *   incomplete  nothing definitive failed, but required trustworthy evidence is missing or
 *               infrastructure is unavailable: no or stale revocation information, no proof,
 *               no (or an unavailable) challenge store.
 * Precedence: any failed check -> denied; otherwise any incomplete / not evaluated check ->
 * incomplete; otherwise authorized. A mandatory check that is missing or unknown can therefore
 * never produce `authorized`.
 *
 * ORDER. Checks run cheapest first, and none stops the others, so the result explains every
 * problem at once: (1) policy, trust root and action context; (2) requester grant; (3) requester
 * revocation; (4) roles; (5) permissions; (6) proof of possession. They are pure
 * and fast. The ONE irreversible step, (7) consuming the proof's challenge, comes last and only
 * runs when every earlier check passed, so a challenge is never burned by a request that was going
 * to fail anyway, and nothing can fail after it.
 *
 * REPLAY. A valid proof alone is replayable inside its window (proof.ts reports
 * `replayProtection: 'not_enforced'`). So without a challenge store that atomically records the
 * challenge as used, the best possible result is `incomplete`. This module never creates a store.
 * `authorized` is only as strong as the supplied store: real protection needs an external,
 * trusted store with atomic, persistent single-use semantics, which this module cannot verify.
 *
 * Limits: the expected commit and digest are caller-supplied and not checked against any real
 * repository; revocation freshness and policy revision comparison are not rollback protection.
 * Evaluation never throws.
 */

import { effectivePermissions, isVerifiedGrant, type VerifiedGrant } from './grant.js';
import { isVerifiedPolicy, requirementsFor, type PolicyDocument, type PolicyReference } from './policy.js';
import { consumeChallenge, parseActionContext, verifyProof, type ActionContext, type ChallengeStore, type VerifiedProof } from './proof.js';
import { checkRevocation, type RevocationListResult } from './revocation.js';
import { isValidatedTrustRoot, parseUtcTimestamp, type TrustRoot } from './trustRoot.js';

export type AuthorizationOutcome = 'authorized' | 'denied' | 'incomplete';
/** `pending` appears only in a PREPARED result (see twoPhaseAuthorization.ts): the check is deliberately deferred, not passed. */
export type CheckStatus = 'passed' | 'failed' | 'incomplete' | 'not_required' | 'not_evaluated' | 'pending';

export type CheckCode =
  // policy
  | 'policy_permits_action'
  | 'trust_root_invalid'
  | 'policy_unverified'
  | 'invalid_evaluation_time'
  | 'invalid_context'
  | 'organization_mismatch'
  | 'policy_not_current'
  | 'action_not_permitted'
  // requester grant
  | 'grant_valid'
  | 'requester_unverified'
  | 'grant_policy_mismatch'
  | 'grant_not_yet_valid'
  | 'grant_expired'
  // requester revocation
  | 'grant_not_revoked'
  | 'grant_revoked'
  | 'revocation_unavailable'
  // roles and permissions
  | 'role_eligible'
  | 'role_missing'
  | 'roles_unavailable'
  | 'permissions_sufficient'
  | 'permission_missing'
  | 'permissions_unavailable'
  // proof
  | 'proof_valid'
  | 'proof_missing'
  | 'proof_invalid'
  // challenge consumption
  | 'challenge_consumed'
  | 'challenge_already_used'
  | 'challenge_store_unavailable'
  | 'no_challenge_store'
  | 'not_attempted'
  // two-phase preparation and finalization (twoPhaseAuthorization.ts)
  | 'challenge_pending'
  | 'finalization_ready'
  | 'prepared_invalid'
  | 'prepared_not_ready'
  | 'already_finalized'
  | 'safety_decision_missing'
  | 'safety_decision_untrusted'
  | 'safety_decision_mismatch'
  | 'safety_not_allow'
  | 'context_changed'
  | 'challenge_changed'
  | 'policy_changed'
  | 'time_went_backwards';

const MESSAGES: Readonly<Record<CheckCode, string>> = {
  policy_permits_action: 'the company policy permits this action in this environment',
  trust_root_invalid: 'the trust root is not a validated trust root',
  policy_unverified: 'the policy is not a verified company policy',
  invalid_evaluation_time: 'the evaluation time is not a valid date',
  invalid_context: 'the expected action context is invalid',
  organization_mismatch: 'the trust root, policy and requester grant belong to different organizations',
  policy_not_current: 'the policy is not in effect at the evaluation time',
  action_not_permitted: 'the company policy does not permit this action in this environment',
  grant_valid: 'the requester grant is verified, current and matches the policy',
  requester_unverified: 'the requester grant is not a verified grant',
  grant_policy_mismatch: 'the requester grant was verified against a different policy revision',
  grant_not_yet_valid: 'the requester grant is not valid yet',
  grant_expired: 'the requester grant has expired',
  grant_not_revoked: 'a verified, fresh revocation list does not list the requester grant',
  grant_revoked: 'the requester grant is revoked',
  revocation_unavailable: 'revocation status could not be established',
  role_eligible: 'the requester holds a role the policy allows for this action',
  role_missing: 'the requester holds no role the policy allows for this action',
  roles_unavailable: 'the requester roles could not be established',
  permissions_sufficient: 'the requester effective permissions include every required permission',
  permission_missing: 'the requester lacks a permission the policy requires',
  permissions_unavailable: 'the requester permissions could not be established',
  proof_valid: 'the proof of possession is valid for this action and challenge',
  proof_missing: 'no proof of possession was supplied',
  proof_invalid: 'the proof of possession is not valid for this action',
  challenge_consumed: 'the proof challenge was consumed by the challenge store',
  challenge_already_used: 'the proof challenge was already used',
  challenge_store_unavailable: 'the challenge store did not give a clear answer',
  no_challenge_store: 'no challenge store was supplied, so single use cannot be enforced',
  not_attempted: 'not attempted because an earlier check did not pass',
  challenge_pending: 'the challenge has not been consumed: it is consumed only at finalization, after the safety assessment allows the action',
  finalization_ready: 'the prepared authorization, the safety decision and the action binding are in order',
  prepared_invalid: 'the prepared authorization is not a result of prepareAuthorization',
  prepared_not_ready: 'the prepared authorization was not ready for finalization',
  already_finalized: 'this prepared authorization or safety decision was already used for a finalization',
  safety_decision_missing: 'no safety decision was supplied, so the action cannot be finalized',
  safety_decision_untrusted: 'the safety decision is not an attestation issued for finalization',
  safety_decision_mismatch: 'the safety decision was attested for a different prepared authorization or action',
  safety_not_allow: 'the safety assessment did not ALLOW the action, so the challenge was not consumed',
  context_changed: 'the action context at finalization differs from the one that was prepared',
  challenge_changed: 'the expected challenge at finalization differs from the one that was prepared',
  policy_changed: 'the policy identity or revision at finalization differs from the one that was prepared',
  time_went_backwards: 'the finalization time is earlier than the preparation time',
};

export interface Check {
  readonly status: CheckStatus;
  readonly code: CheckCode;
  /** fixed text for the code */
  readonly message: string;
  /**
   * Optional extra explanation, drawn only from safe vocabularies: a failure code from another
   * module, names of roles or permissions defined by the company policy, or counts. Never a
   * challenge, digest, target, commit, payload or key.
   */
  readonly detail?: string;
}

export const check = (status: CheckStatus, code: CheckCode, detail?: string): Check => ({ status, code, message: MESSAGES[code], ...(detail ? { detail } : {}) });
export const notEvaluated = (): Check => check('not_evaluated', 'not_attempted');

export interface AuthorizationChecks {
  readonly policy: Check;
  readonly requesterGrant: Check;
  readonly requesterRevocation: Check;
  readonly roles: Check;
  readonly permissions: Check;
  readonly proofOfPossession: Check;
  readonly challengeConsumption: Check;
}

export interface AuthorizationRequirements {
  readonly policy: PolicyReference;
  readonly requiredRoles: readonly string[];
  readonly requiredPermissions: readonly string[];
}

export interface AuthorizationEvaluation {
  readonly outcome: AuthorizationOutcome;
  /** one explainable status per prerequisite */
  readonly checks: AuthorizationChecks;
  /** what the COMPANY policy requires for this action (never what the requester claimed), when known */
  readonly requirements?: AuthorizationRequirements;
  /** set only when evaluation itself failed unexpectedly */
  readonly reason?: 'evaluation_failed';
  /** 'consumed' only when the supplied store atomically recorded this proof's challenge; otherwise single use is not enforced */
  readonly replayProtection: 'consumed' | 'not_enforced';
  /** this evaluator never executes anything: `authorized` means the prerequisites are met, not "run it" */
  readonly executionPerformed: false;
}

const evaluations = new WeakSet<object>();
/** True only for a result produced by evaluateAuthorization. A hand-built `{ outcome: 'authorized' }` is not one. */
export const isAuthorizationEvaluation = (x: unknown): x is AuthorizationEvaluation => typeof x === 'object' && x !== null && evaluations.has(x);

export interface EvaluateAuthorizationParams {
  /** a validated trust root (from parseTrustRoot / loadTrustRoot) */
  readonly trustRoot: TrustRoot;
  /** a verified policy (from verifyPolicy) */
  readonly policy: PolicyDocument;
  /** the requester's verified grant (from verifyGrant against this same policy) */
  readonly requester: VerifiedGrant;
  /** the result of verifyRevocationList, or undefined when none is available */
  readonly revocation: RevocationListResult | undefined;
  /** the action being assessed, from a trusted source: NOT taken from the proof */
  readonly context: ActionContext;
  /** the verifier-issued challenge, supplied independently of the proof */
  readonly challenge: string;
  /** the requester's signed proof envelope (object or JSON text), verified here */
  readonly proof: unknown;
  /** a trusted, atomic, persistent single-use store. Without one, the best outcome is `incomplete`. */
  readonly challengeStore?: ChallengeStore;
  /** injected evaluation time */
  readonly now: Date;
}

function finish(checks: AuthorizationChecks, extra: Partial<AuthorizationEvaluation> = {}): AuthorizationEvaluation {
  const all = Object.values(checks);
  const outcome: AuthorizationOutcome = all.some((c) => c.status === 'failed')
    ? 'denied'
    : all.every((c) => c.status === 'passed' || c.status === 'not_required')
      ? 'authorized'
      : 'incomplete';
  const result: AuthorizationEvaluation = Object.freeze({
    outcome,
    checks: Object.freeze(checks),
    replayProtection: checks.challengeConsumption.code === 'challenge_consumed' ? ('consumed' as const) : ('not_enforced' as const),
    executionPerformed: false as const,
    ...extra,
  });
  evaluations.add(result);
  return result;
}

/**
 * Evaluates every authorization prerequisite for one exact action. Deterministic given its inputs
 * and the store's answers; never throws; never executes anything. See the file header for the
 * outcome rules, the order of checks and the replay limitation.
 */
export async function evaluateAuthorization(params: EvaluateAuthorizationParams): Promise<AuthorizationEvaluation> {
  try {
    return await evaluateUnchecked(params);
  } catch {
    // fail closed: an unexpected error is a denial, never an authorization
    return finish(
      {
        policy: check('failed', 'policy_unverified'),
        requesterGrant: notEvaluated(),
        requesterRevocation: notEvaluated(),
        roles: notEvaluated(),
        permissions: notEvaluated(),
        proofOfPossession: notEvaluated(),
        challengeConsumption: notEvaluated(),
      },
      { reason: 'evaluation_failed' },
    );
  }
}

/** Everything except consuming the challenge: the six pure checks, plus what they found. */
export interface AuthorizationCheckRun {
  readonly base: Omit<AuthorizationChecks, 'challengeConsumption'>;
  readonly extra: Partial<AuthorizationEvaluation>;
  /** the verified proof, when the proof check passed */
  readonly verifiedProof?: VerifiedProof;
}

/** True when every check in a run passed (or is not required) AND a verified proof exists. */
export const checkRunSatisfied = (run: AuthorizationCheckRun): boolean =>
  Object.values(run.base).every((c) => c.status === 'passed' || c.status === 'not_required') && run.verifiedProof !== undefined;

async function evaluateUnchecked(params: EvaluateAuthorizationParams): Promise<AuthorizationEvaluation> {
  const { challengeStore } = params;
  const { base, extra, verifiedProof } = runAuthorizationChecks(params);

  // ---- 8. the ONE irreversible step: consume the challenge, only if everything else already passed
  if (!(Object.values(base).every((c) => c.status === 'passed' || c.status === 'not_required') && verifiedProof !== undefined)) {
    return finish({ ...base, challengeConsumption: notEvaluated() }, extra);
  }
  if (!challengeStore) return finish({ ...base, challengeConsumption: check('incomplete', 'no_challenge_store') }, extra);
  const outcome = await consumeChallenge(verifiedProof, challengeStore);
  const consumption =
    outcome === 'consumed' ? check('passed', 'challenge_consumed') : outcome === 'already_used' ? check('failed', 'challenge_already_used') : check('incomplete', 'challenge_store_unavailable');
  return finish({ ...base, challengeConsumption: consumption }, extra);
}

/**
 * Steps 1 to 6 of the evaluation: policy, requester grant, requester revocation, roles, permissions,
 * proof of possession. Pure apart from the signature checks: it never consumes a
 * challenge and never calls a challenge store. `evaluateAuthorization` adds the consumption step;
 * `prepareAuthorization` and `finalizeAuthorization` (twoPhaseAuthorization.ts) split it in two.
 * May throw on hostile input: callers wrap it so that a throw becomes a denial.
 */
export function runAuthorizationChecks(params: EvaluateAuthorizationParams): AuthorizationCheckRun {
  const { trustRoot, policy, requester, revocation, context, challenge, proof, now } = params;

  // ---- 1. policy, trust root, action context and the company's requirements (cheap, no signatures)
  const policyStage = ((): { check: Check; ctx?: ActionContext; requirements?: AuthorizationRequirements } => {
    if (!isValidatedTrustRoot(trustRoot)) return { check: check('failed', 'trust_root_invalid') };
    if (!isVerifiedPolicy(policy)) return { check: check('failed', 'policy_unverified') };
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { check: check('failed', 'invalid_evaluation_time') };
    const parsed = parseActionContext(context);
    if (!parsed.ok) return { check: check('failed', 'invalid_context') };
    const known = parsed.context;
    if (trustRoot.organization !== policy.organization || (isVerifiedGrant(requester) && requester.grant.organization !== policy.organization)) return { check: check('failed', 'organization_mismatch'), ctx: known };
    const t = now.getTime();
    if (t < (parseUtcTimestamp(policy.effectiveAt) as number) || t >= (parseUtcTimestamp(policy.expiresAt) as number)) return { check: check('failed', 'policy_not_current'), ctx: known };
    // what the COMPANY requires: nothing supplied by the requester can change this
    const need = requirementsFor(policy, known.actionType, known.environment);
    if (!need.permitted) return { check: check('failed', 'action_not_permitted', need.reason), ctx: known };
    return {
      check: check('passed', 'policy_permits_action'),
      ctx: known,
      requirements: {
        policy: need.policy,
        requiredRoles: need.requiredRoles,
        requiredPermissions: need.requiredPermissions,
      },
    };
  })();
  const policyCheck = policyStage.check;
  const { ctx, requirements } = policyStage;
  const policyOk = policyCheck.status === 'passed' && requirements !== undefined && ctx !== undefined;
  const requesterVerified = isVerifiedGrant(requester);

  // ---- 2. requester grant: verified, against THIS policy revision, and current
  const requesterGrant = ((): Check => {
    if (!requesterVerified) return check('failed', 'requester_unverified');
    if (!isVerifiedPolicy(policy)) return notEvaluated();
    if (requester.policyId !== policy.policyId || requester.policyRevision !== policy.revision) return check('failed', 'grant_policy_mismatch');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return notEvaluated();
    const t = now.getTime();
    if (t < (parseUtcTimestamp(requester.grant.notBefore) as number)) return check('failed', 'grant_not_yet_valid');
    if (t >= (parseUtcTimestamp(requester.grant.expiresAt) as number)) return check('failed', 'grant_expired');
    return check('passed', 'grant_valid');
  })();

  // ---- 3. requester revocation: only an explicit `not_listed` passes
  const requesterRevocation = ((): Check => {
    if (!requesterVerified || !(now instanceof Date) || Number.isNaN(now.getTime())) return notEvaluated();
    const status = checkRevocation(requester, revocation, now);
    if (status.status === 'not_listed') return check('passed', 'grant_not_revoked');
    if (status.status === 'revoked') return check('failed', 'grant_revoked', status.revokedBy.join(','));
    return check('incomplete', 'revocation_unavailable', status.reason);
  })();

  // ---- 4 and 5. roles and permissions, from the verified grant under the verified policy
  let granted: readonly string[] | undefined;
  let roleNames: readonly string[] | undefined;
  if (requesterVerified && isVerifiedPolicy(policy)) {
    const effective = effectivePermissions(requester, policy);
    if (effective.ok) {
      granted = effective.permissions;
      roleNames = effective.roles;
    }
  }
  const roles = ((): Check => {
    if (!policyOk || !requirements || !requesterVerified) return notEvaluated();
    if (!roleNames) return check('failed', 'roles_unavailable');
    return roleNames.some((r) => requirements?.requiredRoles.includes(r)) ? check('passed', 'role_eligible') : check('failed', 'role_missing');
  })();
  const permissions = ((): Check => {
    if (!policyOk || !requirements || !requesterVerified) return notEvaluated();
    if (!granted) return check('failed', 'permissions_unavailable');
    const missing = requirements.requiredPermissions.filter((p) => !granted?.includes(p));
    return missing.length === 0 ? check('passed', 'permissions_sufficient') : check('failed', 'permission_missing', missing.join(','));
  })();

  // ---- 6. proof of possession, against the independently supplied context and challenge
  const proofStage = ((): { check: Check; verified?: VerifiedProof } => {
    if (!requesterVerified || !ctx || !(now instanceof Date) || Number.isNaN(now.getTime())) return { check: notEvaluated() };
    if (proof === undefined || proof === null) return { check: check('incomplete', 'proof_missing') };
    const result = verifyProof(proof, requester, ctx, challenge, now);
    if (!result.ok) return { check: check('failed', 'proof_invalid', result.code) };
    return { check: check('passed', 'proof_valid'), verified: result };
  })();
  const proofOfPossession = proofStage.check;
  const verifiedProof = proofStage.verified;

  const base = { policy: policyCheck, requesterGrant, requesterRevocation, roles, permissions, proofOfPossession };
  const extra: Partial<AuthorizationEvaluation> = { ...(requirements ? { requirements } : {}) };

  return { base, extra, ...(verifiedProof ? { verifiedProof } : {}) };
}
