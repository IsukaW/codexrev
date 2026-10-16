/**
 * Security Findings Collector: ingests security reports that ALREADY exist.
 * It does not scan anything, and it has no knowledge of any other feature's
 * security review: its own small normalized finding shape is defined here.
 *
 * Supported formats: SARIF 2.1 (`runs[].results[]`), npm audit JSON (v6
 * `advisories` and v7+ `vulnerabilities`), and a generic
 * `{"tool", "timestamp", "findings":[{"id","severity","file","description"}]}`.
 *
 * Absence of a report is UNKNOWN, never PASS: not having scanned says nothing
 * about whether vulnerabilities exist. A report that was read and has no
 * finding at or above the configured severity is PASS, but only for what that
 * report covered. Finding text is clipped and no code snippets are kept.
 */

import type { EvidenceItem, EvidenceStatus } from '../model/types.js';
import { readProjectTextFile } from './safeFiles.js';
import { COLLECTION_LIMITS, clip, normalizeUserClaim, type NormalizedClaim } from './types.js';

export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface SecurityFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly ruleId?: string;
  readonly file?: string;
  readonly description: string;
  readonly tool: string;
}

export type SecurityFormat = 'sarif' | 'npm_audit' | 'generic' | 'unrecognized';

export interface SecurityReport {
  readonly file: string;
  readonly format: SecurityFormat;
  readonly tool: string;
  readonly status: EvidenceStatus;
  readonly observedAt?: string;
  readonly observedAtFrom: 'report' | 'file_modified_time' | 'none';
  readonly totalFindings: number;
  /** capped at COLLECTION_LIMITS.maxFindingsKept */
  readonly findings: readonly SecurityFinding[];
  readonly bySeverity: Readonly<Record<FindingSeverity, number>>;
  readonly limitations: readonly string[];
}

export interface SecurityCollection {
  readonly reports: readonly SecurityReport[];
  readonly unreadable: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
  readonly claim?: NormalizedClaim;
  /** findings at or above this severity make a report FAIL */
  readonly failAtOrAbove: FindingSeverity;
  readonly limitations: readonly string[];
}

const MAX_REPORTS = 50;

function asSeverity(x: unknown): FindingSeverity | undefined {
  const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
  if (s === 'moderate') return 'medium';
  if (s === 'warning') return 'medium';
  if (s === 'error') return 'high';
  if (s === 'note') return 'low';
  if (s === 'none') return 'info';
  return (FINDING_SEVERITIES as readonly string[]).includes(s) ? (s as FindingSeverity) : undefined;
}

// GitHub-style numeric "security-severity" (CVSS score)
function severityFromScore(score: unknown): FindingSeverity | undefined {
  const n = typeof score === 'string' ? Number(score) : score;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (n >= 9) return 'critical';
  if (n >= 7) return 'high';
  if (n >= 4) return 'medium';
  if (n > 0) return 'low';
  return 'info';
}

function isoOrUndefined(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Date.parse(x)) ? x.trim() : undefined;
}

function rec(x: unknown): Record<string, unknown> | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

interface Parsed {
  format: SecurityFormat;
  tool: string;
  observedAt?: string;
  findings: SecurityFinding[];
  limitations: string[];
}

function parseSarif(r: Record<string, unknown>): Parsed {
  const findings: SecurityFinding[] = [];
  const limitations: string[] = [];
  let tool = 'sarif';
  let observedAt: string | undefined;
  const runs = Array.isArray(r.runs) ? r.runs : [];
  for (const run of runs) {
    const run_ = rec(run);
    if (!run_) continue;
    const driver = rec(rec(run_.tool)?.driver);
    const toolName = typeof driver?.name === 'string' ? clip(driver.name, 80) : 'sarif';
    if (tool === 'sarif') tool = toolName;
    const inv = Array.isArray(run_.invocations) ? rec(run_.invocations[0]) : undefined;
    observedAt ??= isoOrUndefined(inv?.endTimeUtc) ?? isoOrUndefined(inv?.startTimeUtc);
    const results = Array.isArray(run_.results) ? run_.results : [];
    results.forEach((res, i) => {
      const x = rec(res);
      if (!x) return;
      const props = rec(x.properties);
      const severity = severityFromScore(props?.['security-severity']) ?? asSeverity(x.level) ?? 'medium';
      const loc = Array.isArray(x.locations) ? rec(rec(rec(x.locations[0])?.physicalLocation)?.artifactLocation) : undefined;
      const ruleId = typeof x.ruleId === 'string' ? clip(x.ruleId, 100) : undefined;
      const message = typeof rec(x.message)?.text === 'string' ? (rec(x.message)?.text as string) : '(no message)';
      findings.push({
        id: `${toolName}:${ruleId ?? 'result'}:${i + 1}`,
        severity,
        ...(ruleId ? { ruleId } : {}),
        ...(typeof loc?.uri === 'string' ? { file: clip(loc.uri, 200) } : {}),
        description: clip(message),
        tool: toolName,
      });
    });
  }
  if (runs.length === 0) limitations.push('the SARIF file has no runs, so it says nothing about the project');
  return { format: 'sarif', tool, ...(observedAt ? { observedAt } : {}), findings, limitations };
}

function parseNpmAudit(r: Record<string, unknown>): Parsed {
  const findings: SecurityFinding[] = [];
  const vulns = rec(r.vulnerabilities);
  if (vulns) {
    for (const [name, v] of Object.entries(vulns)) {
      const x = rec(v);
      const severity = asSeverity(x?.severity) ?? 'medium';
      findings.push({ id: `npm-audit:${clip(name, 100)}`, severity, description: clip(`vulnerable dependency "${name}" (${severity})`), tool: 'npm audit' });
    }
  }
  const advisories = rec(r.advisories);
  if (advisories) {
    for (const [id, a] of Object.entries(advisories)) {
      const x = rec(a);
      findings.push({
        id: `npm-audit:advisory-${clip(id, 40)}`,
        severity: asSeverity(x?.severity) ?? 'medium',
        description: clip(typeof x?.title === 'string' ? x.title : 'npm advisory'),
        tool: 'npm audit',
      });
    }
  }
  return { format: 'npm_audit', tool: 'npm audit', findings, limitations: ['npm audit output carries no timestamp'] };
}

function parseGeneric(r: Record<string, unknown>): Parsed {
  const tool = typeof r.tool === 'string' ? clip(r.tool, 80) : 'unknown';
  const findings: SecurityFinding[] = [];
  const limitations: string[] = [];
  const list = Array.isArray(r.findings) ? r.findings : [];
  list.forEach((f, i) => {
    const x = rec(f);
    const severity = asSeverity(x?.severity);
    if (!x || !severity) {
      limitations.push(`finding #${i + 1} has no valid severity and was treated as medium`);
    }
    findings.push({
      id: typeof x?.id === 'string' ? clip(x.id, 100) : `${tool}:finding:${i + 1}`,
      severity: severity ?? 'medium',
      ...(typeof x?.ruleId === 'string' ? { ruleId: clip(x.ruleId, 100) } : {}),
      ...(typeof x?.file === 'string' ? { file: clip(x.file, 200) } : {}),
      description: clip(typeof x?.description === 'string' ? x.description : '(no description)'),
      tool,
    });
  });
  const observedAt = isoOrUndefined(r.timestamp);
  return { format: 'generic', tool, ...(observedAt ? { observedAt } : {}), findings, limitations };
}

const SEVERITY_RANK = (s: FindingSeverity): number => FINDING_SEVERITIES.indexOf(s);

/** Pure parsing of one security report. */
export function parseSecurityReport(
  file: string,
  text: string,
  modifiedAt: string | undefined,
  failAtOrAbove: FindingSeverity = 'high',
): SecurityReport {
  let parsed: Parsed | undefined;
  try {
    const r = rec(JSON.parse(text));
    if (r) {
      if (Array.isArray(r.runs) || typeof r.$schema === 'string' && r.$schema.includes('sarif')) parsed = parseSarif(r);
      else if (r.vulnerabilities !== undefined || r.advisories !== undefined || r.auditReportVersion !== undefined) parsed = parseNpmAudit(r);
      else if (Array.isArray(r.findings)) parsed = parseGeneric(r);
    }
  } catch {
    parsed = undefined;
  }

  const bySeverity: Record<FindingSeverity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  if (!parsed) {
    return {
      file,
      format: 'unrecognized',
      tool: 'unknown',
      status: 'UNKNOWN',
      observedAtFrom: 'none',
      totalFindings: 0,
      findings: [],
      bySeverity,
      limitations: ['security report format not recognised (expected SARIF, npm audit JSON, or generic findings JSON); no result was assumed'],
    };
  }

  for (const f of parsed.findings) bySeverity[f.severity]++;
  const limitations = [...parsed.limitations];
  const failing = parsed.findings.some((f) => SEVERITY_RANK(f.severity) >= SEVERITY_RANK(failAtOrAbove));
  const status: EvidenceStatus = failing ? 'FAIL' : 'PASS';
  if (!failing) limitations.push(`no finding at or above "${failAtOrAbove}" in this report; this says nothing about what the report did not scan`);

  let observedAt = parsed.observedAt;
  let observedAtFrom: SecurityReport['observedAtFrom'] = 'report';
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
  if (parsed.findings.length > COLLECTION_LIMITS.maxFindingsKept) {
    limitations.push(`${parsed.findings.length} findings in the report; only the first ${COLLECTION_LIMITS.maxFindingsKept} are kept`);
  }

  return {
    file,
    format: parsed.format,
    tool: parsed.tool,
    status,
    ...(observedAt !== undefined ? { observedAt } : {}),
    observedAtFrom,
    totalFindings: parsed.findings.length,
    findings: parsed.findings.slice(0, COLLECTION_LIMITS.maxFindingsKept),
    bySeverity,
    limitations,
  };
}

export interface SecurityCollectOptions {
  readonly cwd: string;
  readonly reportPaths: readonly string[];
  readonly claim?: EvidenceItem;
  readonly failAtOrAbove?: FindingSeverity;
}

export async function collectSecurityFindings(opts: SecurityCollectOptions): Promise<SecurityCollection> {
  const failAtOrAbove = opts.failAtOrAbove ?? 'high';
  const limitations: string[] = [];
  const reports: SecurityReport[] = [];
  const unreadable: Array<{ file: string; reason: string }> = [];

  const paths = opts.reportPaths.slice(0, MAX_REPORTS);
  if (opts.reportPaths.length > MAX_REPORTS) limitations.push(`only the first ${MAX_REPORTS} security reports were read`);

  for (const file of paths) {
    const read = await readProjectTextFile(opts.cwd, file, COLLECTION_LIMITS.maxReportBytes);
    if (!read.ok) {
      unreadable.push({ file, reason: read.reason });
      limitations.push(`security report "${clip(file, 120)}" was not read: ${read.reason}`);
      continue;
    }
    reports.push(parseSecurityReport(file, read.text, read.modifiedAt, failAtOrAbove));
  }

  const claim = opts.claim ? normalizeUserClaim('security claim', opts.claim) : undefined;
  if (reports.length === 0 && unreadable.length === 0 && !claim) {
    limitations.push('no security report was supplied: this does NOT mean no vulnerabilities exist, only that none were checked');
  }
  return { reports, unreadable, ...(claim ? { claim } : {}), failAtOrAbove, limitations };
}
