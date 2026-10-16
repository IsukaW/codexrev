/**
 * Feature 3 / Function 1 — deterministic migration-task prioritization (P5).
 *
 * POLICY (explicit, testable, NOT a validated risk model — the numbers are
 * explainable tiers, not measured probabilities):
 *
 *   base tier by compatibility severity:
 *     critical|high -> 'high', medium -> 'medium', low|info -> 'low'
 *   downgrades:
 *     transitive dependency: high->medium, medium->low (direct impact is
 *       less certain than a declared direct dependency)
 *     'possible' match class (heuristic evidence or unresolved P3 finding):
 *       capped at 'medium' (never claimed high-confidence)
 *   manual-review tasks (unresolved usage, finding with no located usages):
 *     priority 'medium' — visible to a human, never dropped
 *
 * Prerequisite model: each 'update-manifest' task for (package, finding)
 * gates that finding's usage tasks ('requires-before'), so the dependency
 * change is ordered before the call-site edits.
 *
 * Every task carries `priorityReasons` explaining its tier — the number is
 * never presented alone.
 */

import type {
  AnalysisIssue,
  CompatibilityFinding,
  DependencyInfo,
  MigrationTask,
} from '../types.js';
import type { CompatLookupResult } from '../compat/lookup.js';
import type { RuleResolution } from '../rules/ruleRegistry.js';
import type { TaskSortContext } from '../impact/order.js';

const SEVERITY_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export interface TaskCandidate {
  /** Stable internal handle; final 'act-N' ids are assigned in task order. */
  handle: string;
  task: Omit<MigrationTask, 'id'>;
  context: TaskSortContext;
}

export interface TaskBuildResult {
  candidates: TaskCandidate[];
  issues: AnalysisIssue[];
}

export function severityRankOf(severity: string | undefined): number {
  return severity !== undefined ? (SEVERITY_RANK[severity] ?? 0) : 0;
}

function relationRankOf(dep: DependencyInfo | null): number {
  if (dep === null) return 2;
  return dep.relation === 'direct' ? 0 : 1;
}

function baseTier(severity: CompatibilityFinding['severity']): MigrationTask['priority'] {
  if (severity === 'critical' || severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function tierFor(
  severity: CompatibilityFinding['severity'],
  dep: DependencyInfo | null,
  matchClass: 'confirmed' | 'possible',
  reasons: string[],
): MigrationTask['priority'] {
  let tier = baseTier(severity);
  reasons.push(`severity '${severity}' -> base priority '${tier}'`);
  if (dep?.relation === 'transitive' && tier !== 'low') {
    tier = tier === 'high' ? 'medium' : 'low';
    reasons.push(`transitive dependency -> downgraded to '${tier}'`);
  } else if (dep?.relation === 'direct') {
    reasons.push('direct dependency (no downgrade)');
  } else {
    reasons.push('dependency relation unknown (no downgrade applied)');
  }
  if (matchClass === 'possible' && tier === 'high') {
    tier = 'medium';
    reasons.push("match class 'possible' -> capped at 'medium'");
  }
  return tier;
}

function depByName(dependencies: readonly DependencyInfo[]): Map<string, DependencyInfo> {
  const m = new Map<string, DependencyInfo>();
  for (const d of dependencies) if (!m.has(d.name)) m.set(d.name, d);
  return m;
}

export function buildMigrationTasks(
  resolutions: readonly RuleResolution[],
  compatLookups: readonly CompatLookupResult[],
  dependencies: readonly DependencyInfo[],
): TaskBuildResult {
  const issues: AnalysisIssue[] = [];
  const candidates: TaskCandidate[] = [];
  const byHandle = new Map<string, TaskCandidate>();
  const deps = depByName(dependencies);

  const upsert = (c: TaskCandidate): void => {
    if (!byHandle.has(c.handle)) {
      byHandle.set(c.handle, c);
      candidates.push(c);
    }
  };

  // 1) update-manifest prerequisite per (package, finding).
  for (const res of resolutions) {
    if (res.finding === null) continue;
    const finding = res.finding;
    const pkg = finding.dependency;
    const dep = res.dependency;
    const handle = `manifest:${pkg}:${finding.id}`;
    const reasons: string[] = [];
    const priority = tierFor(finding.severity, dep, 'confirmed', reasons);
    upsert({
      handle,
      task: {
        priority,
        kind: 'update-manifest',
        target: { dependency: pkg },
        ruleId: finding.ruleId ?? finding.id,
        dependsOn: [],
        strategy: 'manual',
        rationale: `upgrade dependency '${pkg}' (declared ${dep?.declaredRange ?? 'unknown'}, resolved ${dep?.resolvedVersion ?? 'unknown'}) to address finding '${finding.id}'`,
        priorityReasons: reasons,
      },
      context: {
        severityRank: severityRankOf(finding.severity),
        relationRank: relationRankOf(dep),
        dependency: pkg,
        findingId: finding.id,
        file: '',
        line: 0,
        column: 0,
      },
    });
  }

  // 2) per-usage tasks (or manual-review for weaker matches).
  for (const res of resolutions) {
    const usage = res.usage;
    if (res.finding !== null) {
      const finding = res.finding;
      const dep = res.dependency;
      const handle = `usage:${usage.file}:${usage.start.line}:${usage.start.column}@${finding.id}`;
      const reasons = [...res.reasons];
      const matchClass: 'confirmed' | 'possible' = res.matchClass === 'confirmed' ? 'confirmed' : 'possible';
      const priority = tierFor(finding.severity, dep, matchClass, reasons);
      const confirmed = res.matchClass === 'confirmed';
      upsert({
        handle,
        task: {
          priority,
          kind: confirmed ? 'rename-usage' : 'manual-review',
          target: { file: usage.file, lineStart: usage.start.line, lineEnd: usage.end.line },
          ruleId: finding.ruleId ?? finding.id,
          dependsOn: [`manifest:${finding.dependency}:${finding.id}`],
          strategy: confirmed ? 'deterministic-rule' : 'manual',
          rationale: `address ${usage.matchedPattern} at ${usage.file}:${usage.start.line} per catalog finding '${finding.id}'`,
          priorityReasons: reasons,
        },
        context: {
          severityRank: severityRankOf(finding.severity),
          relationRank: relationRankOf(dep),
          dependency: finding.dependency,
          findingId: finding.id,
          file: usage.file,
          line: usage.start.line,
          column: usage.start.column,
        },
      });
    } else {
      // Unresolved usage — kept visible as an explicit manual-review task.
      const handle = `unresolved:${usage.file}:${usage.start.line}:${usage.start.column}@${usage.catalogFindingId}`;
      upsert({
        handle,
        task: {
          priority: 'medium',
          kind: 'manual-review',
          target: { file: usage.file, lineStart: usage.start.line, lineEnd: usage.end.line },
          ruleId: null,
          dependsOn: [],
          strategy: 'unresolved',
          rationale: `usage of possibly-affected API at ${usage.file}:${usage.start.line} could not be linked to a catalog finding`,
          unresolvedReason: `catalog finding '${usage.catalogFindingId}' unavailable from compatibility results`,
          priorityReasons: ["unresolved linkage -> manual-review at 'medium' (never dropped, never claimed safe)"],
        },
        context: {
          severityRank: 0,
          relationRank: 2,
          dependency: usage.package,
          findingId: usage.catalogFindingId,
          file: usage.file,
          line: usage.start.line,
          column: usage.start.column,
        },
      });
    }
  }

  // 3) findings with NO located usages must not disappear either.
  const referencedFindingIds = new Set(
    resolutions.filter((r) => r.finding !== null).map((r) => (r.finding as CompatibilityFinding).id),
  );
  const seenFindingIds = new Set<string>();
  for (const lookup of compatLookups) {
    for (const finding of lookup.findings) {
      if (referencedFindingIds.has(finding.id) || seenFindingIds.has(finding.id)) continue;
      seenFindingIds.add(finding.id);
      const pkg = finding.dependency;
      const dep = deps.get(pkg) ?? null;
      const reasons: string[] = [];
      const priority = tierFor(finding.severity, dep, 'possible', reasons);
      upsert({
        handle: `manifest:${pkg}:${finding.id}`,
        task: {
          priority,
          kind: 'update-manifest',
          target: { dependency: pkg },
          ruleId: finding.ruleId ?? finding.id,
          dependsOn: [],
          strategy: 'manual',
          rationale: `upgrade dependency '${pkg}' to address finding '${finding.id}' (no declared range evidence)`,
          priorityReasons: reasons,
        },
        context: {
          severityRank: severityRankOf(finding.severity),
          relationRank: relationRankOf(dep),
          dependency: pkg,
          findingId: finding.id,
          file: '',
          line: 0,
          column: 0,
        },
      });
      upsert({
        handle: `no-usage:${finding.id}`,
        task: {
          priority: 'medium',
          kind: 'manual-review',
          target: { dependency: pkg },
          ruleId: finding.ruleId ?? finding.id,
          dependsOn: [`manifest:${pkg}:${finding.id}`],
          strategy: 'manual',
          rationale: `finding '${finding.id}' affects package '${pkg}' but no source usages were located — verify upgrade safety manually`,
          unresolvedReason: 'no-located-usages',
          priorityReasons: ["finding without located usages -> manual-review at 'medium'"],
        },
        context: {
          severityRank: severityRankOf(finding.severity),
          relationRank: relationRankOf(dep),
          dependency: pkg,
          findingId: finding.id,
          file: '',
          line: 0,
          column: 0,
        },
      });
    }
  }

  // NOTE: prioritization tiers are PROVISIONAL engineering assumptions —
  // not experimentally validated risk probabilities (see phase-05 report).
  return { candidates, issues };
}
