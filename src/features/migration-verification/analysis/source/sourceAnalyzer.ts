/**
 * Feature 3 / Function 1 — AST-based source usage analyzer (Phase P4).
 *
 * Public API: `analyzeSourceUsages()`. Reads a target npm project through
 * `ReadOnlyFs`, parses each discovered JS/TS file IN MEMORY with ts-morph
 * (never writes to disk), and reports usages that match P3 compatibility
 * findings for which a documented matcher exists.
 *
 * Evidence rules:
 *   - Only P3 findings with a catalog-backed matcher run (no invented rules);
 *     findings without one produce a RULE_NOT_FOUND warning.
 *   - Unresolved P3 findings (version boundary not confirmed) may still
 *     locate usages, but confidence is capped at 'medium' and the finding
 *     links back to the P3 id for traceability.
 *   - Comments/strings are never matched (AST nodes only).
 *   - Files with parse errors are skipped with an ANALYZER_FAILED warning —
 *     one bad file never aborts the whole analysis.
 *
 * Coordinates: 1-based line, 1-based column (ts-morph convention);
 * `end` is the position just past the matched node (exclusive).
 */

import { Project, ts } from 'ts-morph';
import type { AnalysisIssue, CompatibilityFinding, Evidence } from '../types.js';
import { analysisIssue } from '../issues.js';
import { ReadOnlyFs } from '../readOnlyFs.js';
import type { CompatLookupResult } from '../compat/lookup.js';
import { discoverSourceFiles } from './discovery.js';
import { findMatcher, type RawMatch } from './matchers.js';

export interface SourceAnalyzerOptions {
  projectRoot: string;
  /** Results of P3 `lookupCompatibility` — the evidence guiding matching. */
  compatLookups: readonly CompatLookupResult[];
  extensions?: readonly string[];
  excludeDirs?: readonly string[];
}

export interface SourceUsage {
  /** Stable id: 'su-1', 'su-2', … assigned in sorted order. */
  id: string;
  /** POSIX-style path relative to the project root. */
  file: string;
  start: { line: number; column: number };
  /** Exclusive end position of the matched node. */
  end: { line: number; column: number };
  matchedPattern: string;
  /** Links back to the P3 catalog finding for full provenance. */
  catalogFindingId: string;
  package: string;
  severity: CompatibilityFinding['severity'];
  confidence: 'high' | 'medium';
  explanation: string;
  evidence: Evidence;
  limitation?: string;
}

export interface SourceAnalysisResult {
  filesScanned: number;
  usages: SourceUsage[];
  issues: AnalysisIssue[];
}

const SYNTAX_ERROR_CODE_MIN = 1000;
const SYNTAX_ERROR_CODE_MAX = 1999;

interface Candidate {
  relativePath: string;
  finding: CompatibilityFinding;
  match: RawMatch;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.relativePath !== b.relativePath) return a.relativePath < b.relativePath ? -1 : 1;
  if (a.match.start.line !== b.match.start.line) return a.match.start.line - b.match.start.line;
  if (a.match.start.column !== b.match.start.column) return a.match.start.column - b.match.start.column;
  if (a.finding.id !== b.finding.id) return a.finding.id < b.finding.id ? -1 : 1;
  return a.match.matchedPattern < b.match.matchedPattern ? -1 : 1;
}

export async function analyzeSourceUsages(opts: SourceAnalyzerOptions): Promise<SourceAnalysisResult> {
  const issues: AnalysisIssue[] = [];

  const discovery = await discoverSourceFiles({
    projectRoot: opts.projectRoot,
    extensions: opts.extensions,
    excludeDirs: opts.excludeDirs,
  });
  issues.push(...discovery.issues);

  // Flatten P3 findings, keeping each finding's provenance intact.
  const findings: CompatibilityFinding[] = [];
  const seenFindingIds = new Set<string>();
  for (const lookup of opts.compatLookups) {
    for (const f of lookup.findings) {
      if (seenFindingIds.has(f.id)) continue;
      seenFindingIds.add(f.id);
      findings.push(f);
    }
  }

  // Run a matcher only where the catalog documents a usage pattern.
  const matchedFindings: CompatibilityFinding[] = [];
  for (const f of findings) {
    if (findMatcher(f.id) !== undefined) {
      matchedFindings.push(f);
    } else {
      issues.push(
        analysisIssue(
          'RULE_NOT_FOUND',
          'warning',
          `no AST usage pattern is defined for catalog finding '${f.id}'; usage detection for it was skipped (no invented rules)`,
          f.id,
        ),
      );
    }
  }

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  const ro = new ReadOnlyFs(opts.projectRoot);

  const candidates: Candidate[] = [];
  let filesScanned = 0;

  for (const relPath of discovery.files) {
    let text: string;
    try {
      text = await ro.readFile(relPath);
    } catch (err) {
      issues.push(
        analysisIssue('ANALYZER_FAILED', 'warning', `cannot read file '${relPath}': ${(err as Error).message}`, relPath),
      );
      continue;
    }

    const sourceFile = project.createSourceFile(relPath, text, { overwrite: true });
    filesScanned++;

    const syntaxErrors = sourceFile
      .getPreEmitDiagnostics()
      .filter(
        (d) =>
          d.getCategory() === ts.DiagnosticCategory.Error &&
          d.getCode() >= SYNTAX_ERROR_CODE_MIN &&
          d.getCode() <= SYNTAX_ERROR_CODE_MAX,
      );
    if (syntaxErrors.length > 0) {
      const codes = [...new Set(syntaxErrors.map((d) => d.getCode()))].sort((a, b) => a - b).join(', ');
      issues.push(
        analysisIssue(
          'ANALYZER_FAILED',
          'warning',
          `parse errors in '${relPath}' (TS codes ${codes}); file skipped — analysis of other files continues`,
          relPath,
        ),
      );
      continue;
    }

    for (const finding of matchedFindings) {
      const matcher = findMatcher(finding.id);
      if (matcher === undefined) continue; // guarded above
      for (const match of matcher.collect({ sourceFile, relativePath: relPath })) {
        candidates.push({ relativePath: relPath, finding, match });
      }
    }
  }

  candidates.sort(compareCandidates);
  const usages: SourceUsage[] = candidates.map((c, i) => {
    const unresolvedFinding = c.finding.status !== 'confirmed';
    const limitationParts: string[] = [];
    if (c.match.limitation !== undefined) limitationParts.push(c.match.limitation);
    if (unresolvedFinding) {
      limitationParts.push('P3 finding is unresolved (version boundary not confirmed) — confidence capped at medium');
    }
    return {
      id: `su-${i + 1}`,
      file: c.relativePath,
      start: c.match.start,
      end: c.match.end,
      matchedPattern: c.match.matchedPattern,
      catalogFindingId: c.finding.id,
      package: c.finding.dependency,
      severity: c.finding.severity,
      confidence: unresolvedFinding ? 'medium' : c.match.confidence,
      explanation: c.match.explanation,
      evidence: {
        status: 'present',
        source: {
          kind: 'source-code',
          ref: `${c.relativePath}:${c.match.start.line}:${c.match.start.column}`,
        },
        excerpt: c.match.explanation,
        quality: c.match.confidence === 'high' && !unresolvedFinding ? 'exact' : 'heuristic',
      },
      ...(limitationParts.length > 0 ? { limitation: limitationParts.join(' | ') } : {}),
    };
  });

  return { filesScanned, usages, issues };
}
