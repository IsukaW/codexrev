/**
 * Adapters from an EvidenceBundle to the inputs the existing gates and the
 * four factor assessors already accept. Pure functions: they decide nothing,
 * run nothing, and never turn UNKNOWN into PASS.
 *
 * The gate view is deliberately stricter than the raw records. A gate only
 * sees PASS when the evidence passed AND comes from a trusted source AND is not
 * stale; otherwise it sees UNKNOWN. (The gates themselves ignore timestamps and
 * sources, so this is where "a self-declared or out-of-date PASS must not open
 * a gate" is enforced.) The assessors get the raw items instead, because they
 * apply source trust and freshness to the score themselves.
 */

import type { AuthorityAssessmentInput } from '../calculus/authority.js';
import type { BlastRadiusInput } from '../calculus/blastRadius.js';
import type { EvidenceKindInput, EvidenceStrengthInput } from '../calculus/evidenceStrength.js';
import type { ReversibilityInput } from '../calculus/reversibility.js';
import type {
  ActorIdentity,
  AuthorityContext,
  EvidenceItem,
  EvidenceSnapshot,
  EvidenceStatus,
  ProposedAction,
} from '../model/types.js';
import type { EvidenceBundle } from './evidenceOrchestrator.js';
import { newestTimestamp, uniq, type EvidenceRecord, type EvidenceType, type NormalizedClaim } from './types.js';

/**
 * Stand-in used ONLY when no actor was identified. It claims nothing: no
 * roles, no authority. (The gates need some actor label for their messages.)
 */
export const UNIDENTIFIED_ACTOR: ActorIdentity = { id: '(unidentified)', kind: 'agent', roles: [] };

/** The status a gate is allowed to see for a record: PASS only if trusted and not stale. */
export function gateStatusOf(r: EvidenceRecord): EvidenceStatus {
  if (r.status === 'PASS') return r.trusted && r.stale !== true ? 'PASS' : 'UNKNOWN';
  return r.status;
}

/**
 * Combines several statuses: any FAIL wins, then any UNKNOWN, otherwise PASS.
 * NOT_APPLICABLE entries are ignored; if only those exist the result is
 * NOT_APPLICABLE. No entries at all gives undefined (nothing was collected).
 */
export function aggregateStatus(statuses: readonly EvidenceStatus[]): EvidenceStatus | undefined {
  if (statuses.length === 0) return undefined;
  const applicable = statuses.filter((s) => s !== 'NOT_APPLICABLE');
  if (applicable.length === 0) return 'NOT_APPLICABLE';
  if (applicable.includes('FAIL')) return 'FAIL';
  if (applicable.includes('UNKNOWN')) return 'UNKNOWN';
  return 'PASS';
}

function recordsOf(b: EvidenceBundle, type: EvidenceType, kind?: (r: EvidenceRecord) => boolean): EvidenceRecord[] {
  return b.records.filter((r) => r.type === type && r.role === 'assertion' && (kind ? kind(r) : true));
}

function itemFromRecords(records: readonly EvidenceRecord[], status: EvidenceStatus): EvidenceItem {
  const observedAt = newestTimestamp(...records.map((r) => r.observedAt));
  return { status, refs: uniq(records.flatMap((r) => [...r.refs])), ...(observedAt ? { observedAt } : {}) };
}

const authorityKind = (r: EvidenceRecord): unknown => r.details?.authorityKind;

/** What the Critical Safety Gates should see (see the file comment for the strict view). */
export function toGateInputs(b: EvidenceBundle): { authority: AuthorityContext; evidence: EvidenceSnapshot } {
  const actor = b.authority.actor ?? UNIDENTIFIED_ACTOR;

  // authorization: explicit authorization record(s) only
  const authz = recordsOf(b, 'authority', (r) => authorityKind(r) === 'authorization');
  const authorization = authz.length > 0 ? itemFromRecords(authz, aggregateStatus(authz.map(gateStatusOf)) ?? 'UNKNOWN') : undefined;

  const bt = recordsOf(b, 'build_test');
  const buildTests = itemFromRecords(bt, aggregateStatus(bt.map(gateStatusOf)) ?? 'UNKNOWN');

  // supporting evidence: security findings, dependency compatibility and any general claim
  const sup = [...recordsOf(b, 'security_findings'), ...recordsOf(b, 'dependency_compatibility')];
  const supportStatuses = sup.map(gateStatusOf);
  if (b.supportingClaim) {
    const c = b.supportingClaim;
    supportStatuses.push(c.item.status === 'PASS' ? (c.trusted ? 'PASS' : 'UNKNOWN') : c.item.status);
  }
  const supporting = itemFromRecords(sup, aggregateStatus(supportStatuses) ?? 'UNKNOWN');

  return {
    authority: { actor, ...(authorization ? { authorization } : {}) },
    evidence: { buildTests, supporting, ...(b.recovery.gateEvidence ? { recovery: b.recovery.gateEvidence } : {}) },
  };
}

/**
 * Impact facts git can actually observe (file and module counts), plus the
 * dimensions it cannot observe (criticality, scope, shared modules, dependency
 * reach, service count) ONLY if the input file stated them. Those are the
 * author's estimates, not evidence, and are reported as such. Anything not
 * stated is left unset, and the assessor treats it as a risky unknown.
 */
export function toBlastRadiusInput(b: EvidenceBundle): BlastRadiusInput {
  const git = b.git;
  const stated = b.statedAction.blastRadius;
  return {
    environment: b.request.environment,
    ...(git.state === 'collected'
      ? { affectedFileCount: git.counts.total, affectedModuleCount: git.modules.length, evidenceRefs: git.head ? [`git:HEAD:${git.head}`] : [] }
      : {}),
    ...(stated?.criticality !== undefined ? { criticality: stated.criticality } : {}),
    ...(stated?.scope !== undefined ? { scope: stated.scope } : {}),
    ...(stated?.sharedModulesModified !== undefined ? { sharedModulesModified: stated.sharedModulesModified } : {}),
    ...(stated?.dependencyReach !== undefined ? { dependencyReach: stated.dependencyReach } : {}),
    ...(stated?.affectedServiceCount !== undefined ? { affectedServiceCount: stated.affectedServiceCount } : {}),
  };
}

const itemOf = (c: NormalizedClaim | undefined): EvidenceItem | undefined => c?.item;

export function toReversibilityInput(b: EvidenceBundle, now: string): { input: ReversibilityInput; assumptions: string[] } {
  const assumptions: string[] = [];
  let irreversible = b.statedAction.irreversible;
  if (irreversible === undefined) {
    irreversible = true;
    assumptions.push('the input did not say whether the action is irreversible: assumed irreversible (the conservative choice)');
  }
  const plan = itemOf(b.recovery.rollbackPlan);
  const test = itemOf(b.recovery.rollbackTest ?? b.recovery.legacyClaim);
  const backup = itemOf(b.recovery.backup);
  return {
    input: {
      now,
      irreversible,
      ...(b.statedAction.destructive !== undefined ? { destructive: b.statedAction.destructive } : {}),
      ...(plan ? { rollbackPlan: plan } : {}),
      ...(test ? { rollbackTest: test } : {}),
      ...(backup ? { backup } : {}),
    },
    assumptions,
  };
}

export function toAuthorityInput(b: EvidenceBundle, now: string): AuthorityAssessmentInput {
  const a = b.authority;
  const identity = itemOf(a.identityVerification);
  const grantEvidence = itemOf(a.grantedPermissions?.evidence);
  return {
    now,
    actor: a.actor ?? UNIDENTIFIED_ACTOR,
    ...(identity ? { identityVerification: identity } : {}),
    ...(a.requiredRoles.length > 0 ? { requiredRoles: a.requiredRoles } : {}),
    ...(a.requiredPermissions.length > 0 ? { requiredPermissions: a.requiredPermissions } : {}),
    ...(a.grantedPermissions ? { granted: { permissions: a.grantedPermissions.permissions, ...(grantEvidence ? { evidence: grantEvidence } : {}) } } : {}),
  };
}

function rawItems(b: EvidenceBundle, type: EvidenceType): EvidenceItem[] {
  return recordsOf(b, type, (r) => r.origin !== 'not_collected').map((r) => ({
    status: r.status,
    refs: r.refs,
    ...(r.observedAt ? { observedAt: r.observedAt } : {}),
    source: r.source,
  }));
}

/**
 * Evidence-strength input. Which kinds are `required` is a policy matter, so
 * it can be overridden; the default requires everything except dependency
 * compatibility, which is required only when dependency files changed.
 */
export function toEvidenceStrengthInput(
  b: EvidenceBundle,
  now: string,
  required: Partial<Record<'buildTests' | 'securityFindings' | 'dependencyCompatibility' | 'recoveryVerification', boolean>> = {},
): EvidenceStrengthInput {
  const kind = (isRequired: boolean, records: EvidenceItem[]): EvidenceKindInput => ({ required: isRequired, records });
  const recovery = b.recovery.gateEvidence ? [b.recovery.gateEvidence] : [];
  return {
    now,
    buildTests: kind(required.buildTests ?? true, rawItems(b, 'build_test')),
    securityFindings: kind(required.securityFindings ?? true, rawItems(b, 'security_findings')),
    dependencyCompatibility: kind(required.dependencyCompatibility ?? b.dependencies.compatibility === 'UNKNOWN', rawItems(b, 'dependency_compatibility')),
    recoveryVerification: kind(required.recoveryVerification ?? true, recovery),
  };
}

/**
 * The action as the gates need it. Impact and irreversibility come from the
 * input file; when the file is silent the most cautious value is used and the
 * assumption is returned so it can be shown, never hidden.
 */
export function toProposedAction(b: EvidenceBundle): { action: ProposedAction; assumptions: string[] } {
  const assumptions: string[] = [];
  const s = b.statedAction;
  let impact = s.impact;
  if (impact === undefined) {
    impact = 'high';
    assumptions.push('the input did not state the action\'s impact: assumed "high" (the conservative choice)');
  }
  let irreversible = s.irreversible;
  if (irreversible === undefined) {
    irreversible = true;
    assumptions.push('the input did not say whether the action is irreversible: assumed irreversible (the conservative choice)');
  }
  return {
    action: {
      identity: {
        id: s.id ?? `${b.request.actionType}:${b.request.environment}`,
        type: b.request.actionType,
        description: s.description ?? `${b.request.actionType} to ${b.request.environment}`,
      },
      environment: b.request.environment,
      impact,
      irreversible,
    },
    assumptions,
  };
}
