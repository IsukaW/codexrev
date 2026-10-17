/**
 * Authority (A): how much VERIFIED authority backs this action?
 * 0 = insufficient authority, 1 = fully verified authority. Higher is safer.
 *
 * Self-declared claims are not verification: a PASS from an untrusted source
 * (see scoring.ts) earns nothing. The actor's role list in ActorIdentity is
 * only a claim, so roles count only to the extent identity is verified.
 *
 * Scoring, in plain steps:
 *   1. Components, weighted (defaults 0.25 / 0.25 / 0.5):
 *        identity verified  - credit of the identity evidence (always applies)
 *        required roles     - share of required roles the actor holds x identity credit
 *        permissions        - share of required permissions in the grant record x credit of that record
 *      Roles and permissions apply only when something is required.
 *   2. If identity is not verified the whole score is capped at 0.3.
 *
 * (An earlier version had a fourth component for independent per-action human approvals, with weights
 * 0.2 / 0.2 / 0.35 / 0.25. That mechanism was removed; the remaining weights keep the same proportions
 * rounded to 0.25 / 0.25 / 0.5. A fully verified requester still scores 1.0.)
 *
 * This is a score only. A missing mandatory authorization is handled by the Critical Safety
 * Gates, whatever this score says.
 */

import type { ActorIdentity, EvidenceItem, FactorAssessment, ScoreAdjustment } from '../model/types.js';
import {
  DEFAULT_CREDIT_CONFIG,
  adjustScore,
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
  };
  readonly maxAgeHours: {
    readonly identity: number;
    readonly permissions: number;
  };
  readonly unverifiedIdentityCap: number;
  readonly credit: EvidenceCreditConfig;
}

export const DEFAULT_AUTHORITY_CONFIG: AuthorityConfig = {
  weights: { identity: 0.25, roles: 0.25, permissions: 0.5 },
  maxAgeHours: { identity: 720, permissions: 720 },
  unverifiedIdentityCap: 0.3,
  credit: DEFAULT_CREDIT_CONFIG,
};

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
  readonly config?: DeepPartial<AuthorityConfig>;
}

export function assessAuthority(input: AuthorityAssessmentInput): FactorAssessment {
  const cfg = mergeConfig(DEFAULT_AUTHORITY_CONFIG, input.config);
  validateWeights('authority.weights', cfg.weights);
  validateCreditConfig(cfg.credit);
  assertUnitInterval('authority.unverifiedIdentityCap', cfg.unverifiedIdentityCap);
  const nowMs = parseNow(input.now);

  const missing: string[] = [];
  const uncertain: string[] = [];
  const conflicts: string[] = []; // kept for the factor result shape; authority has no conflicting evidence of its own
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
