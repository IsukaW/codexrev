/**
 * Evidence orchestrator: runs every collector for one proposed action and
 * normalizes what they found into a single EvidenceBundle.
 *
 * Everything here is read-only and local. A collector that fails (unreadable
 * report, git trouble) produces UNKNOWN evidence with the reason recorded; it
 * never aborts the run, and nothing is ever turned into a PASS to fill a gap.
 *
 * Each normalized EvidenceRecord says what kind of thing it is (a FACT about
 * what changed, or an ASSERTION about safety), where it came from (observed in
 * git, imported from a report file, typed in by the user, or not collected at
 * all), how far it is trusted, whether it is stale, and what limits it.
 * Record ids are deterministic (`<type>-<n>`), so the same inputs and the same
 * "now" always give the same bundle.
 */

import type { AssessmentRequest, StatedBlastRadius } from '../cli/assessmentInput.js';
import type { GatePolicy } from '../calculus/gates.js';
import { DEFAULT_AUTHORITY_CONFIG } from '../calculus/authority.js';
import { DEFAULT_EVIDENCE_STRENGTH_CONFIG } from '../calculus/evidenceStrength.js';
import { DEFAULT_REVERSIBILITY_CONFIG } from '../calculus/reversibility.js';
import { hoursToMs, parseNow } from '../calculus/scoring.js';
import type { ActionType, EvidenceSource, EvidenceStatus, ImpactLevel, TargetEnvironment } from '../model/types.js';
import { collectAuthority, type AuthorityCollection } from './authorityCollector.js';
import { collectBuildTests, type BuildTestCollection } from './buildTestCollector.js';
import { collectDependencies, type DependencyCollection } from './dependencyCollector.js';
import { collectGit, type GitCollection } from './gitCollector.js';
import { collectRecovery, type RecoveryCollection } from './recoveryCollector.js';
import { collectSecurityFindings, type SecurityCollection } from './securityCollector.js';
import {
  clip,
  isStale,
  isTrustedSource,
  normalizeUserClaim,
  type EvidenceOrigin,
  type EvidenceRecord,
  type EvidenceRole,
  type EvidenceType,
  type NormalizedClaim,
} from './types.js';

export interface StatedAction {
  readonly id?: string;
  readonly description?: string;
  readonly impact?: ImpactLevel;
  readonly irreversible?: boolean;
  readonly destructive?: boolean;
  /** impact dimensions the input file STATES (git cannot observe them): estimates, not evidence */
  readonly blastRadius?: StatedBlastRadius;
}

export interface EvidenceBundle {
  readonly collectedAt: string;
  readonly request: { readonly actionType: ActionType; readonly environment: TargetEnvironment; readonly diffRef?: string };
  readonly git: GitCollection;
  readonly dependencies: DependencyCollection;
  readonly buildTests: BuildTestCollection;
  readonly securityFindings: SecurityCollection;
  readonly authority: AuthorityCollection;
  readonly recovery: RecoveryCollection;
  /** what the input file said about the action itself: claims about the action, not evidence */
  readonly statedAction: StatedAction;
  readonly policy?: GatePolicy;
  /** user-supplied dependency-compatibility claim, capped like any other claim */
  readonly dependencyCompatibilityClaim?: NormalizedClaim;
  /** user-supplied general supporting-evidence claim */
  readonly supportingClaim?: NormalizedClaim;
  readonly records: readonly EvidenceRecord[];
  /** collector-level caveats (per-record caveats are on the records) */
  readonly limitations: readonly string[];
}

export interface CollectEvidenceOptions {
  readonly cwd: string;
  readonly request: AssessmentRequest;
  /** ISO time, passed in so a bundle is reproducible; only the CLI boundary reads the clock */
  readonly now: string;
}

function failureMessage(err: unknown): string {
  return clip(String((err as Error)?.message ?? err).split('\n')[0]);
}

async function safely<T>(name: string, run: () => Promise<T>, fallback: (message: string) => T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    return fallback(`${name} collector failed unexpectedly: ${failureMessage(err)}`);
  }
}

export async function collectEvidence(opts: CollectEvidenceOptions): Promise<EvidenceBundle> {
  const { cwd, request, now } = opts;
  const input = request.input;

  const git = await safely(
    'git',
    () => collectGit({ cwd, ...(request.diffRef !== undefined ? { diffRef: request.diffRef } : {}), now }),
    (m): GitCollection => ({
      state: 'error', observedAt: now, detached: false, hasCommits: false, files: [],
      counts: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, modules: [], excluded: [], truncated: false, limitations: [m],
    }),
  );
  const dependencies = await safely(
    'dependency',
    () => collectDependencies({ git, now }),
    (m): DependencyCollection => ({
      state: 'not_collected', observedAt: now, manifestsChanged: [], lockfilesChanged: [], unparsedManifests: [], changes: [],
      counts: { added: 0, removed: 0, changed: 0, majorUpgrades: 0, unknownMajor: 0 }, compatibility: 'UNKNOWN', limitations: [m],
    }),
  );
  const buildTests = await safely(
    'build/test',
    () => collectBuildTests({ cwd, reportPaths: input?.reports?.buildTests ?? [], ...(input?.evidence?.buildTests ? { claim: input.evidence.buildTests } : {}) }),
    (m): BuildTestCollection => ({ reports: [], unreadable: [], limitations: [m] }),
  );
  const securityFindings = await safely(
    'security',
    () => collectSecurityFindings({ cwd, reportPaths: input?.reports?.security ?? [], ...(input?.evidence?.securityFindings ? { claim: input.evidence.securityFindings } : {}) }),
    (m): SecurityCollection => ({ reports: [], unreadable: [], failAtOrAbove: 'high', limitations: [m] }),
  );
  const authority = collectAuthority({ ...(input?.actor ? { actor: input.actor } : {}), ...(input?.authority ? { authority: input.authority } : {}) });
  const recovery = collectRecovery({
    ...(input?.recovery ? { recovery: input.recovery } : {}),
    ...(input?.evidence?.recovery ? { legacyClaim: input.evidence.recovery } : {}),
    now,
  });

  const dependencyCompatibilityClaim = input?.evidence?.dependencyCompatibility
    ? normalizeUserClaim('dependency compatibility claim', input.evidence.dependencyCompatibility)
    : undefined;
  const supportingClaim = input?.evidence?.supporting ? normalizeUserClaim('supporting evidence claim', input.evidence.supporting) : undefined;

  const limitations = [
    ...git.limitations.map((l) => `[git] ${l}`),
    ...dependencies.limitations.map((l) => `[dependencies] ${l}`),
    ...buildTests.limitations.map((l) => `[build/test] ${l}`),
    ...securityFindings.limitations.map((l) => `[security] ${l}`),
    ...authority.limitations.map((l) => `[authority] ${l}`),
    ...recovery.limitations.map((l) => `[recovery] ${l}`),
    ...(dependencyCompatibilityClaim?.limitations ?? []).map((l) => `[dependencies] ${l}`),
    ...(supportingClaim?.limitations ?? []).map((l) => `[supporting] ${l}`),
  ];

  const parts = { git, dependencies, buildTests, securityFindings, authority, recovery, dependencyCompatibilityClaim, supportingClaim };
  return {
    collectedAt: now,
    request: { actionType: request.actionType, environment: request.environment, ...(request.diffRef !== undefined ? { diffRef: request.diffRef } : {}) },
    git,
    dependencies,
    buildTests,
    securityFindings,
    authority,
    recovery,
    statedAction: { ...(input?.action ?? {}) },
    ...(input?.policy ? { policy: input.policy } : {}),
    ...(dependencyCompatibilityClaim ? { dependencyCompatibilityClaim } : {}),
    ...(supportingClaim ? { supportingClaim } : {}),
    records: normalizeEvidence(parts, now),
    limitations,
  };
}

// ---------------------------------------------------------------- normalization

export interface CollectorOutputs {
  readonly git: GitCollection;
  readonly dependencies: DependencyCollection;
  readonly buildTests: BuildTestCollection;
  readonly securityFindings: SecurityCollection;
  readonly authority: AuthorityCollection;
  readonly recovery: RecoveryCollection;
  readonly dependencyCompatibilityClaim?: NormalizedClaim | undefined;
  readonly supportingClaim?: NormalizedClaim | undefined;
}

const HOUR = (h: number): number => hoursToMs(h);

// how old an assertion may be before it counts as stale; reuses the assessors' own limits
function maxAgeMs(type: EvidenceType, details: Readonly<Record<string, unknown>> | undefined): number {
  const es = DEFAULT_EVIDENCE_STRENGTH_CONFIG.maxAgeHours;
  switch (type) {
    case 'build_test':
      return HOUR(es.buildTests);
    case 'security_findings':
      return HOUR(es.securityFindings);
    case 'dependency_compatibility':
      return HOUR(es.dependencyCompatibility);
    case 'recovery':
      return HOUR(Math.min(DEFAULT_REVERSIBILITY_CONFIG.maxAgeHours.rollbackTest, DEFAULT_REVERSIBILITY_CONFIG.maxAgeHours.backup));
    case 'authority': {
      const kind = details?.authorityKind;
      const ah = DEFAULT_AUTHORITY_CONFIG.maxAgeHours;
      if (kind === 'permission_grant') return HOUR(ah.permissions);
      return HOUR(ah.identity);
    }
    default:
      return Number.POSITIVE_INFINITY;
  }
}

type Draft = Omit<EvidenceRecord, 'id' | 'stale' | 'details' | 'observedAt' | 'refs' | 'limitations'> & {
  observedAt?: string | undefined;
  details?: Record<string, unknown>;
  refs?: readonly string[];
  limitations?: readonly string[];
};

/**
 * Turns collector outputs into the flat, ordered list of EvidenceRecords.
 * Pure: the same inputs and `now` always produce deep-equal output.
 */
export function normalizeEvidence(c: CollectorOutputs, now: string): EvidenceRecord[] {
  const nowMs = parseNow(now);
  const drafts: Draft[] = [];
  const add = (d: Draft): void => void drafts.push(d);

  const notCollected = (type: EvidenceType, summary: string, limitations: readonly string[]): Draft => ({
    type, role: 'assertion', origin: 'not_collected', source: 'self_declared', trusted: false, status: 'UNKNOWN', summary, limitations,
  });
  const claimDraft = (type: EvidenceType, claim: NormalizedClaim, summary: string, details: Record<string, unknown>): Draft => ({
    type, role: 'assertion', origin: 'user_supplied', source: claim.item.source ?? 'self_declared', trusted: claim.trusted, status: claim.item.status,
    observedAt: claim.item.observedAt, summary, details, refs: claim.item.refs ?? [], limitations: claim.limitations,
  });

  // --- git facts (observed by this tool, read-only)
  const g = c.git;
  if (g.state === 'collected') {
    add({
      type: 'git_state', role: 'fact', origin: 'observed_git', source: 'verified_system', trusted: true, status: 'PASS', observedAt: g.observedAt,
      summary: `${g.counts.total} changed file(s): ${g.counts.staged} staged, ${g.counts.unstaged} unstaged, ${g.counts.untracked} untracked` +
        (g.branch ? ` on branch "${g.branch}"` : g.detached ? ' (detached HEAD)' : ''),
      details: { branch: g.branch, head: g.head, diffRef: g.diffRef, diffBase: g.diffBase, counts: g.counts, modules: g.modules, excluded: g.excluded, truncated: g.truncated },
      refs: g.head ? [`git:HEAD:${g.head}`] : [],
      limitations: g.limitations,
    });
  } else {
    add({
      type: 'git_state', role: 'fact', origin: 'observed_git', source: 'verified_system', trusted: true, status: 'UNKNOWN', observedAt: g.observedAt,
      summary: g.state === 'not_a_repository' ? 'not a git repository: no change information' : 'git state could not be collected',
      limitations: g.limitations,
    });
  }

  // --- dependency facts, then the compatibility assertion
  const d = c.dependencies;
  add({
    type: 'dependency_change', role: 'fact', origin: 'observed_git', source: 'verified_system', trusted: true,
    status: d.state === 'collected' ? 'PASS' : 'UNKNOWN', observedAt: d.observedAt,
    summary: d.state === 'collected'
      ? `${d.counts.added} added, ${d.counts.removed} removed, ${d.counts.changed} re-versioned dependencies (${d.counts.majorUpgrades} major upgrade(s)); ` +
        `${d.lockfilesChanged.length} lockfile(s) changed`
      : 'dependency changes could not be determined',
    details: { manifestsChanged: d.manifestsChanged, lockfilesChanged: d.lockfilesChanged, unparsedManifests: d.unparsedManifests, counts: d.counts, changes: d.changes.slice(0, 100) },
    refs: [...d.manifestsChanged, ...d.lockfilesChanged],
    limitations: d.limitations,
  });
  if (c.dependencyCompatibilityClaim) {
    // a supplied claim IS the compatibility assertion. The tool's own "versions alone prove nothing"
    // note is only an absence of evidence, so it must not compete with (and always override) a real claim.
    add(claimDraft('dependency_compatibility', c.dependencyCompatibilityClaim, `user-supplied dependency compatibility claim: ${c.dependencyCompatibilityClaim.item.status}`, {}));
  } else {
    add({
      type: 'dependency_compatibility', role: 'assertion', origin: d.state === 'collected' ? 'observed_git' : 'not_collected', source: 'verified_system', trusted: true,
      status: d.compatibility, observedAt: d.observedAt,
      summary: d.compatibility === 'NOT_APPLICABLE' ? 'no dependency-related files changed' : 'dependency compatibility is not established by version numbers alone',
      limitations: d.compatibility === 'UNKNOWN' ? ['compatibility needs evidence beyond version numbers (tests, release notes, a compatibility report)'] : [],
    });
  }

  // --- build / test
  const bt = c.buildTests;
  for (const r of bt.reports) {
    add({
      type: 'build_test', role: 'assertion', origin: 'imported_report', source: 'automated_tool', trusted: isTrustedSource('automated_tool'), status: r.status,
      observedAt: r.observedAt,
      summary: `${r.tool}: ${r.status}` + (r.summary ? `, ${r.summary.passed}/${r.summary.total} passed, ${r.summary.failed} failed` : ''),
      details: { format: r.format, kind: r.kind, tool: r.tool, summary: r.summary, observedAtFrom: r.observedAtFrom, authenticityVerified: false },
      refs: [r.file],
      limitations: [...r.limitations, 'report file integrity is not verified: a file can be edited'],
    });
  }
  for (const u of bt.unreadable) {
    add({ ...notCollected('build_test', `build/test report could not be read: ${u.reason}`, [`"${clip(u.file, 120)}": ${u.reason}`]), refs: [u.file] });
  }
  if (bt.claim) add(claimDraft('build_test', bt.claim, `user-supplied build/test claim: ${bt.claim.item.status}`, {}));
  if (bt.reports.length === 0 && bt.unreadable.length === 0 && !bt.claim) {
    add(notCollected('build_test', 'no build/test result was supplied', ['no report was supplied, so nothing is known about build and test results']));
  }

  // --- security findings
  const sf = c.securityFindings;
  for (const r of sf.reports) {
    add({
      type: 'security_findings', role: 'assertion', origin: 'imported_report', source: 'automated_tool', trusted: isTrustedSource('automated_tool'), status: r.status,
      observedAt: r.observedAt,
      summary: `${r.tool}: ${r.totalFindings} finding(s)` + (r.status === 'FAIL' ? ` including severity at or above "${sf.failAtOrAbove}"` : ''),
      details: { format: r.format, tool: r.tool, totalFindings: r.totalFindings, bySeverity: r.bySeverity, findings: r.findings.slice(0, 50), observedAtFrom: r.observedAtFrom, authenticityVerified: false },
      refs: [r.file],
      limitations: [...r.limitations, 'report file integrity is not verified: a file can be edited'],
    });
  }
  for (const u of sf.unreadable) {
    add({ ...notCollected('security_findings', `security report could not be read: ${u.reason}`, [`"${clip(u.file, 120)}": ${u.reason}`]), refs: [u.file] });
  }
  if (sf.claim) add(claimDraft('security_findings', sf.claim, `user-supplied security claim: ${sf.claim.item.status}`, {}));
  if (sf.reports.length === 0 && sf.unreadable.length === 0 && !sf.claim) {
    add(notCollected('security_findings', 'no security report was supplied', ['no scan report was supplied: this does NOT mean no vulnerabilities exist']));
  }

  // --- authority (user-supplied claims only)
  const a = c.authority;
  let authorityCount = 0;
  const authorityClaim = (claim: NormalizedClaim | undefined, kind: string, summary: string, extra: Record<string, unknown> = {}): void => {
    if (!claim) return;
    authorityCount++;
    add(claimDraft('authority', claim, `${summary}: ${claim.item.status}`, { authorityKind: kind, ...extra }));
  };
  authorityClaim(a.identityVerification, 'identity_verification', 'identity verification');
  authorityClaim(a.authorization, 'authorization', 'authorization record');
  authorityClaim(a.grantedPermissions?.evidence, 'permission_grant', 'permission grant record', { permissions: a.grantedPermissions?.permissions });
  if (authorityCount === 0) add(notCollected('authority', 'no authorization record was supplied', ['authority is never inferred from the git user or repository ownership']));

  // --- recovery (user-supplied claims only)
  const rc = c.recovery;
  let recoveryCount = 0;
  const recoveryClaim = (claim: NormalizedClaim | undefined, kind: string, summary: string): void => {
    if (!claim) return;
    recoveryCount++;
    add(claimDraft('recovery', claim, `${summary}: ${claim.item.status}`, { recoveryKind: kind }));
  };
  recoveryClaim(rc.rollbackPlan, 'rollback_plan', 'rollback plan (documented, not proof)');
  recoveryClaim(rc.rollbackTest, 'rollback_test', 'rollback test');
  recoveryClaim(rc.backup, 'backup', 'backup / recovery point');
  recoveryClaim(rc.legacyClaim, 'claim', 'recovery claim');
  if (recoveryCount === 0) add(notCollected('recovery', 'no rollback plan, rollback test or backup record was supplied', ['recovery was not evidenced; a script existing in the repository is not proof recovery works']));

  // --- ids and freshness
  const counters = new Map<EvidenceType, number>();
  return drafts.map((dr): EvidenceRecord => {
    const n = (counters.get(dr.type) ?? 0) + 1;
    counters.set(dr.type, n);
    const stale =
      dr.role === 'assertion' && dr.origin !== 'not_collected' && dr.status !== 'NOT_APPLICABLE'
        ? isStale(dr.observedAt, nowMs, maxAgeMs(dr.type, dr.details))
        : undefined;
    const limitations = [...(dr.limitations ?? [])];
    if (stale === true && dr.observedAt === undefined) limitations.push('no timestamp: the age of this evidence cannot be shown');
    return {
      id: `${dr.type}-${n}`,
      type: dr.type,
      role: dr.role as EvidenceRole,
      origin: dr.origin as EvidenceOrigin,
      source: dr.source as EvidenceSource,
      trusted: dr.trusted,
      status: dr.status as EvidenceStatus,
      ...(dr.observedAt !== undefined ? { observedAt: dr.observedAt } : {}),
      ...(stale !== undefined ? { stale } : {}),
      summary: dr.summary,
      ...(dr.details ? { details: dr.details } : {}),
      refs: dr.refs ?? [],
      limitations,
    };
  });
}

/** Short human-readable lines describing a bundle, for the CLI. */
export function describeEvidenceBundle(b: EvidenceBundle): string[] {
  const lines: string[] = [];
  const g = b.git;
  if (g.state === 'collected') {
    lines.push(
      `git: ${g.counts.total} changed file(s) (${g.counts.staged} staged, ${g.counts.unstaged} unstaged, ${g.counts.untracked} untracked)` +
        (g.branch ? ` on "${g.branch}"` : '') + (g.diffRef ? `, compared with ${g.diffRef}` : ''),
    );
  } else {
    lines.push(`git: ${g.state === 'not_a_repository' ? 'not a git repository' : 'could not be collected'}`);
  }
  const d = b.dependencies;
  lines.push(d.state === 'collected' ? `dependencies: ${d.changes.length} change(s), ${d.lockfilesChanged.length} lockfile(s) changed, compatibility ${d.compatibility}` : 'dependencies: not determined');
  const byType = (t: EvidenceType): EvidenceRecord[] => b.records.filter((r) => r.type === t && r.role === 'assertion');
  const statusLine = (label: string, t: EvidenceType): string => {
    const rs = byType(t);
    const parts = rs.map((r) => `${r.status}${r.origin === 'not_collected' ? ' (nothing supplied)' : r.stale ? ' (stale)' : ''}${r.origin !== 'not_collected' && !r.trusted ? ' (untrusted)' : ''}`);
    return `${label}: ${parts.join(', ')}`;
  };
  lines.push(statusLine('build/test', 'build_test'));
  lines.push(statusLine('security findings', 'security_findings'));
  lines.push(statusLine('authority', 'authority'));
  lines.push(statusLine('recovery', 'recovery'));
  return lines;
}
