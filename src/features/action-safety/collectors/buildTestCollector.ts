/**
 * Build/Test Evidence Collector: reads test and build result files that
 * ALREADY exist. It never runs a test, a build or any command.
 *
 * Supported report formats:
 *   generic     {"tool": "...", "kind": "test"|"build", "status": "pass"|"fail"|"unknown",
 *                "timestamp": "<ISO>", "summary": {"total":n,"passed":n,"failed":n,"skipped":n}}
 *   jest_json   Jest / Vitest `--json` / `--reporter=json` output (has numTotalTests)
 *   junit_xml   JUnit-style XML (testsuite / testsuites attributes only)
 *
 * What it preserves: the tool, the status, the timestamp (and where the
 * timestamp came from), the counts. What it never does: treat a missing,
 * unreadable or unrecognised report as PASS, or a run with zero tests as PASS.
 */

import type { EvidenceItem, EvidenceStatus } from '../model/types.js';
import { readProjectTextFile } from './safeFiles.js';
import { COLLECTION_LIMITS, clip, normalizeUserClaim, type NormalizedClaim } from './types.js';

export type BuildTestFormat = 'generic' | 'jest_json' | 'junit_xml' | 'unrecognized';

export interface TestCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface BuildTestReport {
  /** path as the user gave it */
  readonly file: string;
  readonly format: BuildTestFormat;
  readonly tool: string;
  readonly kind: 'test' | 'build' | 'unknown';
  readonly status: EvidenceStatus;
  readonly observedAt?: string;
  readonly observedAtFrom: 'report' | 'file_modified_time' | 'none';
  readonly summary?: TestCounts;
  readonly limitations: readonly string[];
}

export interface BuildTestCollection {
  readonly reports: readonly BuildTestReport[];
  readonly unreadable: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
  /** an inline claim from the input file, with its source capped */
  readonly claim?: NormalizedClaim;
  readonly limitations: readonly string[];
}

const MAX_REPORTS = 50;

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
}

function isoOrUndefined(x: unknown): string | undefined {
  if (typeof x === 'number' && Number.isFinite(x) && x > 0) {
    const d = new Date(x);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Date.parse(x))) return x.trim();
  return undefined;
}

function mapStatusWord(word: unknown): EvidenceStatus {
  const w = typeof word === 'string' ? word.trim().toLowerCase() : '';
  if (['pass', 'passed', 'success', 'succeeded', 'ok'].includes(w)) return 'PASS';
  if (['fail', 'failed', 'failure', 'error', 'errored'].includes(w)) return 'FAIL';
  return 'UNKNOWN';
}

// zero tests ran is not evidence that tests pass
function guardEmptyRun(status: EvidenceStatus, kind: BuildTestReport['kind'], counts: TestCounts | undefined, limitations: string[]): EvidenceStatus {
  if (status === 'PASS' && kind !== 'build' && counts !== undefined && counts.total === 0) {
    limitations.push('the report shows zero tests, which is not evidence that tests pass');
    return 'UNKNOWN';
  }
  return status;
}

function xmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

/** Pure parsing of one report's text. `modifiedAt` is the file's mtime, used only if the report has no timestamp. */
export function parseBuildTestReport(file: string, text: string, modifiedAt: string | undefined): BuildTestReport {
  const limitations: string[] = [];
  let format: BuildTestFormat = 'unrecognized';
  let tool = 'unknown';
  let kind: BuildTestReport['kind'] = 'unknown';
  let status: EvidenceStatus = 'UNKNOWN';
  let observedAt: string | undefined;
  let summary: TestCounts | undefined;

  let json: unknown;
  let jsonOk = false;
  try {
    json = JSON.parse(text);
    jsonOk = true;
  } catch {
    jsonOk = false;
  }

  if (jsonOk && typeof json === 'object' && json !== null && !Array.isArray(json)) {
    const r = json as Record<string, unknown>;
    if (num(r.numTotalTests) !== undefined) {
      format = 'jest_json';
      tool = 'jest/vitest json reporter';
      kind = 'test';
      const total = num(r.numTotalTests) ?? 0;
      const failed = num(r.numFailedTests) ?? 0;
      const passed = num(r.numPassedTests) ?? Math.max(0, total - failed);
      const skipped = num(r.numPendingTests) ?? 0;
      summary = { total, passed, failed, skipped };
      const failedSuites = (num(r.numFailedTestSuites) ?? 0) + (num(r.numRuntimeErrorTestSuites) ?? 0);
      if (failed > 0 || failedSuites > 0 || r.success === false) status = 'FAIL';
      else if (r.success === true || r.success === undefined) status = 'PASS';
      observedAt = isoOrUndefined(r.startTime);
    } else if (typeof r.tool === 'string' && r.status !== undefined) {
      format = 'generic';
      tool = clip(r.tool, 80);
      kind = r.kind === 'build' ? 'build' : r.kind === 'test' ? 'test' : 'unknown';
      status = mapStatusWord(r.status);
      observedAt = isoOrUndefined(r.timestamp);
      const s = r.summary;
      if (typeof s === 'object' && s !== null) {
        const sr = s as Record<string, unknown>;
        if (num(sr.total) !== undefined) {
          summary = { total: num(sr.total) ?? 0, passed: num(sr.passed) ?? 0, failed: num(sr.failed) ?? 0, skipped: num(sr.skipped) ?? 0 };
          if ((summary.failed ?? 0) > 0 && status === 'PASS') {
            status = 'FAIL';
            limitations.push('report status says pass but its summary counts failures: treated as failed');
          }
        }
      }
    }
  } else if (!jsonOk && /<testsuite\b/.test(text)) {
    format = 'junit_xml';
    tool = 'junit xml';
    kind = 'test';
    const rootMatch = /<testsuites\b([^>]*)>/.exec(text);
    const rootAttrs = rootMatch ? xmlAttributes(rootMatch[1]) : {};
    const suites = [...text.matchAll(/<testsuite\b([^>]*)>/g)].map((m) => xmlAttributes(m[1]));
    const source = rootAttrs.tests !== undefined ? [rootAttrs] : suites;
    if (rootAttrs.tests === undefined && suites.length > 1) limitations.push('totals are summed over all testsuite elements; nested suites could be counted twice');
    const sum = (key: string): number => source.reduce((n, a) => n + (Number.isFinite(Number(a[key])) ? Number(a[key]) : 0), 0);
    const total = sum('tests');
    const failed = sum('failures') + sum('errors');
    const skipped = sum('skipped') + sum('disabled');
    summary = { total, passed: Math.max(0, total - failed - skipped), failed, skipped };
    status = failed > 0 ? 'FAIL' : 'PASS';
    observedAt = isoOrUndefined(suites.find((a) => a.timestamp)?.timestamp);
  }

  if (format === 'unrecognized') {
    limitations.push('report format not recognised (expected generic JSON, Jest/Vitest JSON, or JUnit XML); no result was assumed');
  }
  status = guardEmptyRun(status, kind, summary, limitations);

  let observedAtFrom: BuildTestReport['observedAtFrom'] = 'report';
  if (observedAt === undefined) {
    if (modifiedAt !== undefined) {
      observedAt = modifiedAt;
      observedAtFrom = 'file_modified_time';
      limitations.push('the report has no timestamp; the file modification time is used instead');
    } else {
      observedAtFrom = 'none';
      limitations.push('the report has no timestamp, so its age cannot be shown');
    }
  }

  return { file, format, tool, kind, status, ...(observedAt !== undefined ? { observedAt } : {}), observedAtFrom, ...(summary ? { summary } : {}), limitations };
}

export interface BuildTestCollectOptions {
  readonly cwd: string;
  readonly reportPaths: readonly string[];
  readonly claim?: EvidenceItem;
}

export async function collectBuildTests(opts: BuildTestCollectOptions): Promise<BuildTestCollection> {
  const limitations: string[] = [];
  const reports: BuildTestReport[] = [];
  const unreadable: Array<{ file: string; reason: string }> = [];

  const paths = opts.reportPaths.slice(0, MAX_REPORTS);
  if (opts.reportPaths.length > MAX_REPORTS) limitations.push(`only the first ${MAX_REPORTS} build/test reports were read`);

  for (const file of paths) {
    const read = await readProjectTextFile(opts.cwd, file, COLLECTION_LIMITS.maxReportBytes);
    if (!read.ok) {
      unreadable.push({ file, reason: read.reason });
      limitations.push(`build/test report "${clip(file, 120)}" was not read: ${read.reason}`);
      continue;
    }
    reports.push(parseBuildTestReport(file, read.text, read.modifiedAt));
  }

  const claim = opts.claim ? normalizeUserClaim('build/test claim', opts.claim) : undefined;
  if (reports.length === 0 && unreadable.length === 0 && !claim) {
    limitations.push('no build/test report or claim was supplied, so nothing is known about build and test results');
  }
  return { reports, unreadable, ...(claim ? { claim } : {}), limitations };
}
