/**
 * Strict authorization evidence adapter.
 *
 * Translates a GENUINE two-phase authorization result (twoPhaseAuthorization.ts) into the structures
 * the existing Feature 4 assessment already understands: an Authority-factor input
 * (`AuthorityAssessmentInput`), an `AuthorityContext` for the mandatory gates, and the strict part of
 * the gate policy. It is a pure, deterministic translation. It is NOT connected to the assessment
 * pipeline, it does not change the Authority formula or the gate engine, and it never executes anything.
 *
 * THREE STATES, as a discriminated union, never a boolean:
 *   provisional  a PreparedAuthorization that is `ready_for_finalization`. Every signed prerequisite
 *                passed, but the challenge has NOT been consumed. The view offers verified evidence for
 *                a provisional safety calculation ONLY, under the deliberately different property name
 *                `provisionalGateInputs`, and says `authorizationPermitsFinalAllow: false`. A final
 *                ALLOW is forbidden until finalizeAuthorization succeeds.
 *   finalized    a FinalizedAuthorization with outcome `authorized` and the challenge consumed. Its
 *                gate view is named `gateInputs`. `authorizationPermitsFinalAllow: true` means only
 *                that AUTHORIZATION no longer forbids ALLOW: the score thresholds and every other
 *                mandatory gate still apply, and nothing is executed.
 *   blocked      anything else: denied, incomplete, not a genuine result, or inconsistent. No positive
 *                evidence is produced; the Authorization gate is FAIL (denied or unrecognized) or
 *                UNKNOWN (incomplete), both of which BLOCK.
 * A provisional view cannot be passed off as finalized by flipping a flag: the states have different
 * shapes, and only a genuine finalized result can produce the finalized one.
 *
 * WHAT IS TRUSTED. Only results this subsystem produced (checked by brand, not by shape). Plain objects
 * such as `{ outcome: 'authorized' }`, clones and JSON round-trips are `blocked`. Nothing is read from
 * assessment JSON: no claimed identity, role, permission or gate policy. The evidence the
 * adapter writes carries the provenance `verified_system`, which an input file can never obtain
 * (claims there are capped at `human_attested`), so the Authority factor and gates see it as
 * cryptographically verified, and only when the evaluator actually verified it.
 *
 * AUTHORITY. The formula is untouched; only its inputs are built, from verified facts:
 * the requester's identity (valid company grant, not revoked, proof of possession), roles from the
 * grant, required roles/permissions from the verified policy and effective permissions
 * from the grant under the policy. There is no separate approval input. Where the policy
 * allows several roles ("any of"), the Authority input lists the required role(s) the requester
 * actually holds, because the Authority formula counts roles as "all of". Blocked views synthesize no
 * positive evidence.
 *
 * GATES. The four-gate architecture is used; there is no fifth gate. This adapter supplies
 * the AUTHORIZATION part. The other three gates (recovery, build/test, supporting evidence) need a TRUSTED policy
 * source that this adapter does not have, so it does not invent one: `completeStrictGatePolicy`
 * combines the strict part with rules a trusted caller supplies, and refuses anything incomplete.
 *
 * LIMITS: the safety-decision attestation behind finalization is unauthenticated in-process; the
 * challenge store, the action-context collection and CI enforcement are outside this module.
 */

import { effectivePermissions } from './grant.js';
import type { AuthorizationRequirements, Check } from './evaluateAuthorization.js';
import { authorizationSubjectOf, isFinalizedAuthorization, isPreparedAuthorization, type FinalizedAuthorization, type PreparedAuthorization } from './twoPhaseAuthorization.js';
import type { AuthorityAssessmentInput } from '../calculus/authority.js';
import type { GatePolicy } from '../calculus/gates.js';
import { IMPACT_LEVELS, type ActorIdentity, type AuthorityContext, type EvidenceItem, type EvidenceStatus } from '../model/types.js';

export type StrictAuthorizationReason =
  | 'AUTHORIZATION_PROVISIONAL_PENDING_FINALIZATION'
  | 'AUTHORIZATION_FINALIZED'
  | 'AUTHORIZATION_DENIED'
  | 'AUTHORIZATION_INCOMPLETE'
  | 'AUTHORIZATION_RESULT_UNRECOGNIZED'
  | 'AUTHORIZATION_RESULT_INCONSISTENT'
  | 'INVALID_EVALUATION_TIME';

/** The strict part of the gate policy. Authorization is always required. */
export interface StrictGatePolicyPart {
  readonly authorization: GatePolicy['authorization'];
}

export interface UnmetCheck {
  readonly check: string;
  readonly status: Check['status'];
  readonly code: Check['code'];
}

interface ViewCommon {
  /** the verified company requirements for this action, when the policy was available */
  readonly requirements?: AuthorizationRequirements;
  /** the Authority-factor input, built only from verified facts (compatible with assessAuthority) */
  readonly authorityInput: AuthorityAssessmentInput;
  /** the strict part of the gate policy */
  readonly gatePolicy: StrictGatePolicyPart;
  readonly reasonCodes: readonly StrictAuthorizationReason[];
  /** what this view does not cover or cannot establish */
  readonly limitations: readonly string[];
  /** this subsystem never executes anything */
  readonly executionPerformed: false;
}

export interface ProvisionalStrictAuthorization extends ViewCommon {
  readonly state: 'provisional';
  readonly challengeConsumption: 'pending';
  readonly authorizationFinalized: false;
  /** a final ALLOW is forbidden until finalizeAuthorization succeeds */
  readonly authorizationPermitsFinalAllow: false;
  /** for a provisional safety calculation ONLY. Deliberately not named `gateInputs`. */
  readonly provisionalGateInputs: AuthorityContext;
  readonly nextStep: 'finalizeAuthorization';
}

export interface FinalizedStrictAuthorization extends ViewCommon {
  readonly state: 'finalized';
  readonly challengeConsumption: 'consumed';
  readonly authorizationFinalized: true;
  /** AUTHORIZATION no longer forbids ALLOW. The score and every other mandatory gate still apply. */
  readonly authorizationPermitsFinalAllow: true;
  readonly gateInputs: AuthorityContext;
}

export interface BlockedStrictAuthorization extends ViewCommon {
  readonly state: 'blocked';
  readonly challengeConsumption: 'not_consumed';
  readonly authorizationFinalized: false;
  readonly authorizationPermitsFinalAllow: false;
  readonly gateInputs: AuthorityContext;
  readonly consequence: 'BLOCK';
  /** the checks that were not satisfied, as safe codes (empty when the result was not genuine) */
  readonly unmetChecks: readonly UnmetCheck[];
}

export type StrictAuthorizationView = ProvisionalStrictAuthorization | FinalizedStrictAuthorization | BlockedStrictAuthorization;

const views = new WeakSet<object>();
/** True only for a view produced by adaptAuthorization. A hand-built view is not one. */
export const isStrictAuthorizationView = (x: unknown): x is StrictAuthorizationView => typeof x === 'object' && x !== null && views.has(x);

// ---------------------------------------------------------------- helpers

/** Stand-in actor when nobody was verified. It claims nothing: no roles, no authority. Same value the collectors use. */
export const UNVERIFIED_ACTOR: ActorIdentity = Object.freeze({ id: '(unidentified)', kind: 'agent', roles: Object.freeze([]) as readonly string[] });

const LIMITATIONS: readonly string[] = Object.freeze([
  'only the AUTHORIZATION gate rule is produced here: the recovery, build/test and supporting-evidence gates need a trusted policy source (see completeStrictGatePolicy)',
  'the safety-decision attestation behind finalization is unauthenticated in-process: only the trusted pipeline may issue it',
  'single use of the challenge depends on an external, trusted, atomic, persistent challenge store',
  'the action context (commit, content digest) is supplied by the caller, not collected from the repository',
]);

const verified = (status: EvidenceStatus, observedAt: string, refs: readonly string[]): EvidenceItem => ({ status, source: 'verified_system', observedAt, refs });


function unmetOf(checks: object): UnmetCheck[] {
  return Object.entries(checks as Record<string, Check>)
    .filter(([, c]) => c.status !== 'passed' && c.status !== 'not_required')
    .map(([check, c]) => ({ check, status: c.status, code: c.code }));
}

function freeze<T extends StrictAuthorizationView>(view: T): T {
  const done = Object.freeze(view);
  views.add(done);
  return done;
}

const INVALID_TIME = '1970-01-01T00:00:00.000Z';

// ---------------------------------------------------------------- blocked views

function blocked(reason: StrictAuthorizationReason, kind: 'denied' | 'incomplete' | 'unrecognized', now: Date, result?: PreparedAuthorization | FinalizedAuthorization): BlockedStrictAuthorization {
  const genuine = kind !== 'unrecognized' && result !== undefined;
  const requirements = genuine ? result.requirements : undefined;
  const nowText = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : INVALID_TIME;
  const evaluatedAt = nowText;
  const refs = [`authorization:${kind}`];
  // negative evidence from a genuine result is system-verified; an unrecognized object earns no provenance at all
  const item = (status: EvidenceStatus): EvidenceItem => (genuine ? verified(status, evaluatedAt, refs) : { status, refs });

  const authorizationStatus: EvidenceStatus = kind === 'incomplete' ? 'UNKNOWN' : 'FAIL';

  const authorityInput: AuthorityAssessmentInput = {
    now: nowText,
    actor: UNVERIFIED_ACTOR,
    ...(requirements && requirements.requiredRoles.length > 0 ? { requiredRoles: requirements.requiredRoles } : {}),
    ...(requirements && requirements.requiredPermissions.length > 0 ? { requiredPermissions: requirements.requiredPermissions } : {}),
  };

  return freeze({
    state: 'blocked',
    challengeConsumption: 'not_consumed',
    authorizationFinalized: false,
    authorizationPermitsFinalAllow: false,
    gateInputs: { actor: UNVERIFIED_ACTOR, authorization: item(authorizationStatus) },
    consequence: 'BLOCK',
    ...(requirements ? { requirements } : {}),
    authorityInput,
    gatePolicy: { authorization: { required: true } },
    unmetChecks: genuine ? unmetOf(result.checks) : [],
    reasonCodes: [reason],
    limitations: LIMITATIONS,
    executionPerformed: false,
  });
}

// ---------------------------------------------------------------- adaptation

/**
 * Translates a genuine two-phase result into a strict authorization view at the assessment time
 * `now`. Pure and deterministic; never throws. Anything that is not a genuine result is `blocked`.
 */
export function adaptAuthorization(result: PreparedAuthorization | FinalizedAuthorization, now: Date): StrictAuthorizationView {
  try {
    return adaptUnchecked(result, now);
  } catch {
    return blocked('AUTHORIZATION_RESULT_UNRECOGNIZED', 'unrecognized', now);
  }
}

function adaptUnchecked(result: PreparedAuthorization | FinalizedAuthorization, now: Date): StrictAuthorizationView {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return blocked('INVALID_EVALUATION_TIME', 'unrecognized', now);

  const finalized = isFinalizedAuthorization(result);
  const prepared = isPreparedAuthorization(result);
  if (!finalized && !prepared) return blocked('AUTHORIZATION_RESULT_UNRECOGNIZED', 'unrecognized', now);

  // definitive and incomplete results: no positive evidence, BLOCK
  if (result.outcome === 'denied') return blocked('AUTHORIZATION_DENIED', 'denied', now, result);
  if (result.outcome === 'incomplete') return blocked('AUTHORIZATION_INCOMPLETE', 'incomplete', now, result);

  // from here the outcome is `authorized` (finalized) or `ready_for_finalization` (prepared)
  const consumed = finalized && result.outcome === 'authorized' && result.checks.challengeConsumption.code === 'challenge_consumed' && result.replayProtection === 'consumed';
  const pending = prepared && result.outcome === 'ready_for_finalization' && result.checks.challengeConsumption.status === 'pending';
  if (!consumed && !pending) return blocked('AUTHORIZATION_RESULT_INCONSISTENT', 'denied', now, result);

  // every prerequisite must really be satisfied; the only non-passed check allowed is the pending consumption of a prepared result
  const others = Object.entries(result.checks).filter(([name]) => name !== 'challengeConsumption' && name !== 'finalization');
  if (!others.every(([, c]) => (c as Check).status === 'passed' || (c as Check).status === 'not_required')) return blocked('AUTHORIZATION_RESULT_INCONSISTENT', 'denied', now, result);
  if (finalized && result.checks.finalization.status !== 'passed') return blocked('AUTHORIZATION_RESULT_INCONSISTENT', 'denied', now, result);

  const subject = authorizationSubjectOf(result);
  const requirements = result.requirements;
  if (!subject || !requirements) return blocked('AUTHORIZATION_RESULT_UNRECOGNIZED', 'unrecognized', now);

  const grant = subject.requester.grant;
  const effective = effectivePermissions(subject.requester, subject.policy);
  const heldRequiredRoles = requirements.requiredRoles.filter((r) => grant.roles.includes(r));
  if (!effective.ok || heldRequiredRoles.length === 0) return blocked('AUTHORIZATION_RESULT_INCONSISTENT', 'denied', now, result);

  const at = subject.evaluatedAt;
  const grantRefs = [`grant:${grant.grantId}`, `policy:${subject.policy.policyId}@${subject.policy.revision}`];
  const actor: ActorIdentity = { id: grant.subject.id, kind: grant.subject.type, roles: [...grant.roles] };

  const authorityInput: AuthorityAssessmentInput = {
    now: now.toISOString(),
    actor,
    // the company grant, not revoked, with proof of possession: this is what "identity verified" means here
    identityVerification: verified('PASS', at, [...grantRefs, 'proof-of-possession']),
    requiredRoles: heldRequiredRoles,
    ...(requirements.requiredPermissions.length > 0 ? { requiredPermissions: requirements.requiredPermissions } : {}),
    granted: { permissions: effective.permissions, evidence: verified('PASS', at, grantRefs) },
  };

  const gateContext: AuthorityContext = {
    actor,
    authorization: verified('PASS', at, grantRefs),
  };
  const common: ViewCommon = {
    requirements,
    authorityInput,
    gatePolicy: { authorization: { required: true } },
    reasonCodes: [consumed ? 'AUTHORIZATION_FINALIZED' : 'AUTHORIZATION_PROVISIONAL_PENDING_FINALIZATION'],
    limitations: LIMITATIONS,
    executionPerformed: false,
  };

  if (consumed) {
    return freeze({ ...common, state: 'finalized', challengeConsumption: 'consumed', authorizationFinalized: true, authorizationPermitsFinalAllow: true, gateInputs: gateContext });
  }
  return freeze({
    ...common,
    state: 'provisional',
    challengeConsumption: 'pending',
    authorizationFinalized: false,
    authorizationPermitsFinalAllow: false,
    provisionalGateInputs: gateContext,
    nextStep: 'finalizeAuthorization',
  });
}

// ---------------------------------------------------------------- the other three gates

/** The rules for the gates this adapter does NOT produce. They must come from a trusted source. */
export interface OtherGateRules {
  readonly recovery: GatePolicy['recovery'];
  readonly buildTests: GatePolicy['buildTests'];
  readonly supportingEvidence: GatePolicy['supportingEvidence'];
}

export type GatePolicyResult =
  | { readonly ok: true; readonly policy: GatePolicy }
  | { readonly ok: false; readonly code: 'not_a_strict_view' | 'incomplete_gate_rules' | 'authorization_rules_not_accepted' };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isConsequence = (x: unknown): boolean => x === undefined || x === 'BLOCK' || x === 'ESCALATE';

/**
 * Combines the strict AUTHORIZATION rule from a genuine view with the rules for the
 * other three gates, which a TRUSTED caller supplies. Nothing is defaulted: a missing or malformed
 * rule, or an attempt to include an authorization rule, is refused. The adapter cannot tell
 * whether the supplied rules are trustworthy; where they come from is the caller's responsibility.
 */
export function completeStrictGatePolicy(view: StrictAuthorizationView, others: OtherGateRules): GatePolicyResult {
  try {
    if (!isStrictAuthorizationView(view)) return { ok: false, code: 'not_a_strict_view' };
    if (!isRecord(others)) return { ok: false, code: 'incomplete_gate_rules' };
    if ('authorization' in others) return { ok: false, code: 'authorization_rules_not_accepted' };
    const { recovery, buildTests, supportingEvidence } = others;
    const okRecovery = isRecord(recovery) && isBool(recovery.required) && isBool(recovery.whenIrreversible) && (recovery.minImpact === undefined || (IMPACT_LEVELS as readonly unknown[]).includes(recovery.minImpact));
    const okBuild = isRecord(buildTests) && isBool(buildTests.required);
    const okSupporting = isRecord(supportingEvidence) && isBool(supportingEvidence.required) && isConsequence(supportingEvidence.consequence);
    if (!okRecovery || !okBuild || !okSupporting) return { ok: false, code: 'incomplete_gate_rules' };
    return {
      ok: true,
      policy: {
        authorization: view.gatePolicy.authorization,
        recovery: { ...recovery },
        buildTests: { ...buildTests },
        supportingEvidence: { ...supportingEvidence },
      },
    };
  } catch {
    return { ok: false, code: 'incomplete_gate_rules' };
  }
}
