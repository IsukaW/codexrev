/**
 * Feature 3 / Function 1 — deterministic compatibility lookup (Phase P3).
 *
 * Pure function, no I/O, no network. Given a package name and a migration
 * TARGET version, returns the catalog findings that apply, with provenance.
 *
 * Explicit evidence rules (see phase-03 report):
 *   - Unknown package (no catalog entry) => verdict 'no-known-issues' +
 *     COMPAT_DATA_UNAVAILABLE warning. UNKNOWN IS NEVER CONFIRMED-SAFE.
 *   - Target version not exact (ranges like '^19.0.0', prereleases) =>
 *     boundary NOT evaluated: finding status 'unresolved' +
 *     COMPAT_VERSION_UNEVALUATED issue. Declared ranges are never assumed
 *     resolved — P2's lockfile data supplies exact versions.
 *   - 'confirmed' requires: exact target inside the affected range AND
 *     reviewStatus 'verified' AND an https source URI.
 */

import type { AnalysisIssue, CompatibilityFinding } from '../types.js';
import { analysisIssue } from '../issues.js';
import { validateCatalogEntry, type CompatCatalogEntry } from './catalogTypes.js';
import { BUILTIN_COMPAT_CATALOG } from './builtinCatalog.js';
import { inAffectedRange, parseExactVersion } from './exactVersion.js';

export interface CompatLookupInput {
  package: string;
  /** Migration target version as declared (may be a range — never assumed resolved). */
  targetVersion: string;
}

export type CompatVerdict = 'affected' | 'unresolved' | 'no-known-issues';

export interface CompatLookupResult {
  package: string;
  verdict: CompatVerdict;
  findings: CompatibilityFinding[];
  issues: AnalysisIssue[];
}

function entryApplies(
  entry: CompatCatalogEntry,
  target: ReturnType<typeof parseExactVersion>,
): boolean {
  if (target === null) return true; // cannot decide boundary -> surface as unresolved
  const from = parseExactVersion(entry.affectedFrom);
  const until = entry.affectedUntil !== undefined ? parseExactVersion(entry.affectedUntil) : null;
  if (from === null || (entry.affectedUntil !== undefined && until === null)) {
    return true; // validator should prevent this; be safe, surface as unresolved
  }
  return inAffectedRange(target, from, until);
}

function toFinding(
  entry: CompatCatalogEntry,
  pkg: string,
  confirmed: boolean,
): CompatibilityFinding {
  const message =
    entry.migrationGuidance !== undefined
      ? `${entry.description} Migration: ${entry.migrationGuidance}`
      : entry.description;
  return {
    id: entry.id,
    kind: entry.category,
    severity: entry.severity,
    dependency: pkg,
    api: entry.api,
    message,
    evidence: {
      status: confirmed ? 'present' : 'missing',
      source: { kind: 'builtin-catalog', ref: entry.id, uri: entry.source.uri },
      quality: confirmed ? 'exact' : 'heuristic',
    },
    ruleId: null,
    status: confirmed ? 'confirmed' : 'unresolved',
  };
}

/**
 * Deterministic catalog lookup. The catalog parameter exists for tests and
 * future data sources; the default is the curated built-in catalog.
 */
export function lookupCompatibility(
  input: CompatLookupInput,
  catalog: readonly unknown[] = BUILTIN_COMPAT_CATALOG,
): CompatLookupResult {
  const issues: AnalysisIssue[] = [];

  // Validate entries up front; malformed ones are skipped with a warning.
  const valid: CompatCatalogEntry[] = [];
  for (const raw of catalog) {
    const res = validateCatalogEntry(raw);
    if (res.ok) {
      valid.push(res.entry);
    } else {
      issues.push(analysisIssue('ANALYZER_FAILED', 'warning', `malformed catalog entry skipped: ${res.reason}`));
    }
  }

  const matches = valid.filter((e) => e.package === input.package);
  if (matches.length === 0) {
    issues.push(
      analysisIssue(
        'COMPAT_DATA_UNAVAILABLE',
        'warning',
        `no built-in compatibility catalog entry for '${input.package}': absence of data is NOT evidence of compatibility`,
        input.package,
      ),
    );
    return { package: input.package, verdict: 'no-known-issues', findings: [], issues };
  }

  const target = parseExactVersion(input.targetVersion);
  if (target === null) {
    issues.push(
      analysisIssue(
        'COMPAT_VERSION_UNEVALUATED',
        'warning',
        `target version '${input.targetVersion}' is not an exact version (X.Y.Z); catalog boundaries were NOT evaluated — compatibility is unresolved, not confirmed-safe`,
        input.package,
      ),
    );
  }

  const findings: CompatibilityFinding[] = [];
  for (const entry of matches) {
    if (!entryApplies(entry, target)) continue; // version outside affected range
    const confirmed =
      target !== null && entry.reviewStatus === 'verified' && entry.source.uri.startsWith('https://');
    findings.push(toFinding(entry, input.package, confirmed));
  }

  const verdict: CompatVerdict =
    findings.length === 0
      ? 'no-known-issues'
      : findings.some((f) => f.status === 'confirmed')
        ? 'affected'
        : 'unresolved';

  return { package: input.package, verdict, findings, issues };
}
