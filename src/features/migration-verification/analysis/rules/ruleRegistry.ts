/**
 * Feature 3 / Function 1 — rule registry (Phase P5).
 *
 * Resolves P4 source usages to their P3 compatibility findings (via the
 * stable `catalogFindingId`) and to P2 dependency-analysis entries (via the
 * package name). Every usage produces a resolution — nothing is discarded;
 * anything that cannot be fully linked is classified and reported, never
 * treated as proof that a migration is safe.
 *
 * Match classes:
 *   'confirmed' — P3 finding confirmed AND usage confidence high with exact
 *                 evidence AND the package is known to dependency analysis.
 *   'possible'  — linkage exists but something is weaker (unresolved P3
 *                 finding, heuristic/name-only usage, etc.).
 *   'unresolved'— the catalog finding id was not returned by compatibility
 *                 lookup; the usage keeps a resolution + explicit issues.
 */

import type { AnalysisIssue, CompatibilityFinding, DependencyInfo } from '../types.js';
import { analysisIssue } from '../issues.js';
import type { CompatLookupResult } from '../compat/lookup.js';
import type { SourceUsage } from '../source/sourceAnalyzer.js';

export type RuleMatchClass = 'confirmed' | 'possible' | 'unresolved';

export interface RuleResolution {
  usage: SourceUsage;
  finding: CompatibilityFinding | null;
  dependency: DependencyInfo | null;
  matchClass: RuleMatchClass;
  /** Human-readable explanation trail (feeds task rationale/priority reasons). */
  reasons: string[];
}

export interface RuleRegistryResult {
  resolutions: RuleResolution[];
  issues: AnalysisIssue[];
}

export interface RuleRegistryInput {
  usages: readonly SourceUsage[];
  compatLookups: readonly CompatLookupResult[];
  dependencies: readonly DependencyInfo[];
}

export function resolveUsages(input: RuleRegistryInput): RuleRegistryResult {
  const issues: AnalysisIssue[] = [];

  const findingById = new Map<string, CompatibilityFinding>();
  for (const lookup of input.compatLookups) {
    for (const f of lookup.findings) {
      if (!findingById.has(f.id)) findingById.set(f.id, f);
    }
  }
  const depByName = new Map<string, DependencyInfo>();
  for (const d of input.dependencies) {
    if (!depByName.has(d.name)) depByName.set(d.name, d);
  }

  const resolutions: RuleResolution[] = input.usages.map((usage) => {
    const reasons: string[] = [];
    const finding = findingById.get(usage.catalogFindingId) ?? null;
    const dependency =
      depByName.get(finding?.dependency ?? usage.package) ?? depByName.get(usage.package) ?? null;

    if (finding === null) {
      reasons.push(`catalog finding '${usage.catalogFindingId}' was not returned by compatibility lookup`);
      issues.push(
        analysisIssue(
          'COMPAT_DATA_UNAVAILABLE',
          'warning',
          `usage at ${usage.file}:${usage.start.line} references catalog finding '${usage.catalogFindingId}' which is absent from compatibility results — classified unresolved, NOT safe`,
          usage.catalogFindingId,
        ),
      );
    } else {
      reasons.push(
        `matched catalog finding '${finding.id}' (${finding.kind}, severity ${finding.severity}, status ${finding.status})`,
      );
    }

    if (dependency === null) {
      reasons.push(`package '${usage.package}' has no entry in dependency analysis`);
      issues.push(
        analysisIssue(
          'DEPENDENCY_UNRESOLVED',
          'warning',
          `package '${usage.package}' used at ${usage.file}:${usage.start.line} was not found in dependency analysis`,
          usage.package,
        ),
      );
    } else {
      reasons.push(`package '${usage.package}' is a ${dependency.relation} dependency (scope ${dependency.scope})`);
    }

    reasons.push(`usage confidence ${usage.confidence}, evidence quality ${usage.evidence.quality}`);

    let matchClass: RuleMatchClass;
    if (finding === null) {
      matchClass = 'unresolved';
    } else if (
      finding.status === 'confirmed' &&
      usage.confidence === 'high' &&
      usage.evidence.quality === 'exact' &&
      dependency !== null
    ) {
      matchClass = 'confirmed';
    } else {
      matchClass = 'possible';
    }

    return { usage, finding, dependency, matchClass, reasons };
  });

  return { resolutions, issues };
}
