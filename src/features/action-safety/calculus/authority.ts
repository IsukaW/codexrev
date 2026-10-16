/**
 * Authority (A): how much VERIFIED authority backs this action?
 * 0 = insufficient authority, 1 = fully verified authority. Higher is safer.
 *
 * Self-declared claims are not verification: a PASS from an untrusted source
 * (see scoring.ts) earns nothing. The actor's role list in ActorIdentity is
 * only a claim, so roles count only to the extent identity is verified.
 *
 * Scoring, in plain steps:
 *   1. Components, weighted (defaults 0.2 / 0.2 / 0.35 / 0.25):
 *        identity verified  - credit of the identity evidence (always applies)
 *        required roles     - share of required roles the actor holds x identity credit
 *        permissions        - share of required permissions in the grant record x credit of that record
 *        human approvals    - credit from distinct approvers other than the actor, divided by
 *                             the number required (capped at 1)
 *      Roles, permissions and approvals apply only when something is required.
 *   2. An explicit rejection by any approver sets the approvals component to 0.
 *   3. If identity is not verified the whole score is capped at 0.3.
 *
 * This is a score only. A missing mandatory authorization or approval is
 * handled by the Critical Safety Gates, whatever this score says.
 */

import type { ActorIdentity, EvidenceItem, FactorAssessment, ScoreAdjustment } from '../model/types.js';
import {
  DEFAULT_CREDIT_CONFIG,
  FactorInputError,
  adjustScore,
  assertNonNegativeNumber,
  assertUnitInterval,
  creditFor,
  finalizeScore,
  hoursToMs,
  mergeConfig,
  parseNow,
  uniqueRefs,
  validateCreditConfig,
  validateWeights,
  weightedAverage,
  type Credit,
  type DeepPartial,
  type EvidenceCreditConfig,
  type RawComponent,
} from './scoring.js';

export interface AuthorityConfig {
  readonly weights: {
    readonly identity: number;
    readonly roles: number;
    readonly permissions: number;
    readonly approvals: number;
  };
  readonly maxAgeHours: {
    readonly identity: number;
    readonly permissions: number;
    readonly approval: number;
  };
  readonly unverifiedIdentityCap: number;
  readonly credit: EvidenceCreditConfig;
}

export const DEFAULT_AUTHORITY_CONFIG: AuthorityConfig = {
  weights: { identity: 0.2, roles: 0.2, permissions: 0.35, approvals: 0.25 },
  maxAgeHours: { identity: 720, permissions: 720, approval: 72 },
  unverifiedIdentityCap: 0.3,
  credit: DEFAULT_CREDIT_CONFIG,
};

export interface ApprovalRecord {
  readonly approverId: string;
  /** PASS = approved, FAIL = explicitly rejected */
  readonly evidence: EvidenceItem;
}

export interface GrantedPermissions {
  readonly permissions: readonly string[];
  /** the record proving the grant (e.g. from an access-control system). Without it the grant is just a claim. */
  readonly evidence?: EvidenceItem;
}

export interface AuthorityAssessmentInput {
  readonly now: string;
  readonly actor: ActorIdentity;
  /** proof that the actor is who they say they are (and holds the roles listed) */
  readonly identityVerification?: EvidenceItem;
  readonly requiredRoles?: readonly string[];
  readonly requiredPermissions?: readonly string[];
  readonly granted?: GrantedPermissions;
  /** how many distinct human approvals the policy asks for */
  readonly requiredApprovals?: number;
  readonly approvals?: readonly ApprovalRecord[];
  readonly config?: DeepPartial<AuthorityConfig>;
}

export function assessAuthority(input: AuthorityAssessmentInput): FactorAssessment {
  const cfg = mergeConfig(DEFAULT_AUTHORITY_CONFIG, input.config);
  validateWeights('authority.weights', cfg.weights);
  validateCreditConfig(cfg.credit);
  assertUnitInterval('authority.unverifiedIdentityCap', cfg.unverifiedIdentityCap);
  const nowMs = parseNow(input.now);
  const requiredApprovals = input.requiredApprovals ?? 0;
  assertNonNegativeNumber('requiredApprovals', requiredApprovals);
  if (!Number.isInteger(requiredApprovals)) throw new FactorInputError('requiredApprovals must be an integer');

  const missing: string[] = [];
  const uncertain: string[] = [];
  const conflicts: string[] = [];
  const refLists: Array<readonly string[] | undefined> = [];

  const note = (label: string, c: Credit): void => {
    refLists.push(c.refs);
    if (c.state === 'missing') missing.push(label);
    else if (c.state === 'unknown' || c.state === 'stale' || c.state === 'untrusted' || c.state === 'not_applicable') {
      uncertain.push(c.note);
    }
  };

  // identity
  const identity = creditFor('identity verification', input.identityVerification, {
    nowMs,
    maxAgeMs: hoursToMs(cfg.maxAgeHours.identity),
    config: cfg.credit,
  });
  note('identity verification', identity);

  // roles: the actor's own role list is a claim, so it is scaled by identity credit
  const requiredRoles = input.requiredRoles ?? [];
  const heldRoles = requiredRoles.filter((r) => input.actor.roles.includes(r));
  const roleShare = requiredRoles.length === 0 ? 1 : heldRoles.length / requiredRoles.length;
  if (requiredRoles.length > heldRoles.length) {
    const lacking = requiredRoles.filter((r) => !heldRoles.includes(r));
    uncertain.push(`actor "${input.actor.id}" does not hold required role(s): ${lacking.join(', ')}`);
  }

  // permissions: share covered by the grant, scaled by how trustworthy the grant record is
  const requiredPerms = input.requiredPermissions ?? [];
  const granted = new Set(input.granted?.permissions ?? []);
  const coveredPerms = requiredPerms.filter((p) => granted.has(p));
  const permShare = requiredPerms.length === 0 ? 1 : coveredPerms.length / requiredPerms.length;
  const grantCredit = creditFor('permission grant record', input.granted?.evidence, {
    nowMs,
    maxAgeMs: hoursToMs(cfg.maxAgeHours.permissions),
    config: cfg.credit,
  });
  if (requiredPerms.length > 0) {
    if (!input.granted) missing.push('granted permissions');
    else note('permission grant record', grantCredit);
    if (coveredPerms.length < requiredPerms.length) {
      const lacking = requiredPerms.filter((p) => !granted.has(p));
      uncertain.push(`required permission(s) not granted: ${lacking.join(', ')}`);
    }
  }

  // approvals: distinct approvers, never the actor themselves
  const byApprover = new Map<string, Credit[]>();
  let rejected = false;
  for (const a of input.approvals ?? []) {
    if (a.approverId === input.actor.id) {
      uncertain.push(`approval by "${a.approverId}" ignored: actors cannot approve their own action`);
      continue;
    }
    const c = creditFor(`approval by ${a.approverId}`, a.evidence, {
      nowMs,
      maxAgeMs: hoursToMs(cfg.maxAgeHours.approval),
      config: cfg.credit,
    });
    note(`approval by ${a.approverId}`, c);
    if (c.state === 'failed') rejected = true;
    byApprover.set(a.approverId, [...(byApprover.get(a.approverId) ?? []), c]);
  }
  const approverValues = [...byApprover.values()].map((cs) => Math.max(...cs.map((c) => c.value)));
  const hasValidApproval = approverValues.some((v) => v > 0);
  if (rejected && hasValidApproval) conflicts.push('some approvers approved while another explicitly rejected');
  if (requiredApprovals > 0 && byApprover.size === 0) missing.push('human approvals');
  const approvalSum = approverValues.reduce((n, v) => n + v, 0);
  const approvalsValue = rejected ? 0 : requiredApprovals === 0 ? 1 : Math.min(1, approvalSum / requiredApprovals);

  const raw: RawComponent[] = [
    { name: 'identity verified', weight: cfg.weights.identity, value: identity.value, note: identity.note, applied: true },
    {
      name: 'required roles',
      weight: cfg.weights.roles,
      value: roleShare * identity.value,
      note: `${heldRoles.length}/${requiredRoles.length} required roles held, scaled by identity credit`,
      applied: requiredRoles.length > 0,
    },
    {
      name: 'required permissions',
      weight: cfg.weights.permissions,
      value: permShare * grantCredit.value,
      note: `${coveredPerms.length}/${requiredPerms.length} required permissions granted, scaled by grant-record credit (${grantCredit.state})`,
      applied: requiredPerms.length > 0,
    },
    {
      name: 'human approvals',
      weight: cfg.weights.approvals,
      value: approvalsValue,
      note: rejected
        ? 'an approver explicitly rejected'
        : `${byApprover.size} distinct approver(s) on record, ${requiredApprovals} required`,
      applied: requiredApprovals > 0,
    },
  ];
  const { score: base, breakdown } = weightedAverage(raw);

  const adjustments: ScoreAdjustment[] = [];
  let score = base;
  if (identity.state !== 'verified') {
    score = adjustScore(
      adjustments,
      'unverified identity cap',
      score,
      Math.min(score, cfg.unverifiedIdentityCap),
      `identity is not verified (${identity.state}), so nothing else can be fully trusted`,
    );
  }
  score = finalizeScore(score);

  const explanation =
    `Authority ${score.toFixed(2)}: identity ${identity.state}` +
    (requiredPerms.length > 0 ? `, ${coveredPerms.length}/${requiredPerms.length} permissions granted` : '') +
    (requiredApprovals > 0 ? `, ${approverValues.filter((v) => v > 0).length}/${requiredApprovals} valid approvals` : '') +
    (rejected ? ', an approval was rejected' : '') +
    '.';

  return {
    factor: 'authority',
    score,
    explanation,
    evidenceRefs: uniqueRefs(...refLists),
    missing,
    uncertain,
    conflicts,
    breakdown,
    adjustments,
  };
}
