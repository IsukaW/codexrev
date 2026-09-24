// Shared JSON shape all six roles emit (ba/architect/dev/build/qa/pm). ContextAggregator
// collects one RoleOutput per role, ResolverEngine reads all six for the final
// decision, reportRenderer turns Finding[] into the per-role report sections.
//
// The five LLM roles hand this back as parsed JSON, so validateRoleOutput is a
// real runtime check, not just a type — model output is untrusted until checked.
// Build is deterministic (no LLM) but normalizes into the same shape so nothing
// downstream has to special-case it.

import { CodexrevError } from '../../../utils/errors.js';

// also doubles as each role's file stem under roles/ (ba.ts, architect.ts, ...)
export type RoleId = 'ba' | 'architect' | 'dev' | 'build' | 'qa' | 'pm';

/** Fixed execution order, always sequential. */
export const ROLE_ORDER: readonly RoleId[] = ['ba', 'architect', 'dev', 'build', 'qa', 'pm'];

export const ROLE_LABELS: Readonly<Record<RoleId, string>> = {
  ba: 'Business Analyst',
  architect: 'Architect',
  dev: 'Developer',
  build: 'Build Analyst',
  qa: 'QA Engineer',
  pm: 'Director of Engineering',
};

const ROLE_IDS = new Set<RoleId>(ROLE_ORDER);

export type Verdict = 'pass' | 'flag' | 'block';

const VERDICTS = new Set<Verdict>(['pass', 'flag', 'block']);

// low -> high. resolver's conflict rules bump a finding one notch up this list.
export const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

const SEVERITIES = new Set<Severity>(SEVERITY_ORDER);

/** Bumps severity one level up, capped at critical. */
export function bumpSeverity(sev: Severity): Severity {
  const idx = SEVERITY_ORDER.indexOf(sev);
  return SEVERITY_ORDER[Math.min(idx + 1, SEVERITY_ORDER.length - 1)];
}

/** One issue raised by a role — also what the change-coverage map keys off (file + line range -> verdict). */
export interface Finding {
  readonly id: string; // unique within one role's output, e.g. "arch-1"
  readonly severity: Severity;
  readonly cwe?: string; // CWE ref like "CWE-89", set by roles doing security-flavored analysis (Feature 4 scores this independently now, no in-pipeline role owns it)
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly description: string; // plain english, meant for a non-security dev to read
  readonly suggestedFix?: string; // free text or a diff-shaped suggestion; EditGenerator consumes this
}

export interface RoleOutput {
  readonly role: RoleId;
  readonly verdict: Verdict;
  readonly findings: readonly Finding[];
  readonly summary: string;
  readonly confidence: number; // 0 (none) to 1 (certain)
}

export class RoleContractError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_ROLE_CONTRACT_ERROR', false);
    this.name = 'RoleContractError';
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function fail(path: string, detail: string): never {
  throw new RoleContractError(`invalid role output at "${path}": ${detail}`);
}

// Throws on the first violation found.
export function validateFinding(x: unknown, path: string): Finding {
  if (!isRecord(x)) fail(path, 'expected an object');
  const r = x as Record<string, unknown>;

  if (typeof r.id !== 'string' || r.id.length === 0) fail(`${path}.id`, 'expected a non-empty string');
  if (typeof r.severity !== 'string' || !SEVERITIES.has(r.severity as Severity)) {
    fail(`${path}.severity`, `expected one of ${SEVERITY_ORDER.join(', ')}`);
  }
  if (r.cwe !== undefined && typeof r.cwe !== 'string') fail(`${path}.cwe`, 'expected a string when present');
  if (typeof r.file !== 'string' || r.file.length === 0) fail(`${path}.file`, 'expected a non-empty string');
  if (typeof r.lineStart !== 'number' || !Number.isFinite(r.lineStart) || r.lineStart < 1) {
    fail(`${path}.lineStart`, 'expected an integer >= 1');
  }
  if (typeof r.lineEnd !== 'number' || !Number.isFinite(r.lineEnd) || r.lineEnd < (r.lineStart as number)) {
    fail(`${path}.lineEnd`, 'expected an integer >= lineStart');
  }
  if (typeof r.description !== 'string' || r.description.length === 0) {
    fail(`${path}.description`, 'expected a non-empty string');
  }
  if (r.suggestedFix !== undefined && typeof r.suggestedFix !== 'string') {
    fail(`${path}.suggestedFix`, 'expected a string when present');
  }

  return {
    id: r.id,
    severity: r.severity as Severity,
    ...(r.cwe !== undefined ? { cwe: r.cwe as string } : {}),
    file: r.file,
    lineStart: r.lineStart,
    lineEnd: r.lineEnd,
    description: r.description,
    ...(r.suggestedFix !== undefined ? { suggestedFix: r.suggestedFix as string } : {}),
  };
}

// Validates one role's raw JSON (usually parsed straight out of an LLM response).
// Error message is path-qualified so callers can surface exactly what was wrong.
export function validateRoleOutput(x: unknown): RoleOutput {
  if (!isRecord(x)) fail('$', 'expected an object');
  const r = x as Record<string, unknown>;

  if (typeof r.role !== 'string' || !ROLE_IDS.has(r.role as RoleId)) {
    fail('$.role', `expected one of ${ROLE_ORDER.join(', ')}`);
  }
  if (typeof r.verdict !== 'string' || !VERDICTS.has(r.verdict as Verdict)) {
    fail('$.verdict', `expected one of ${[...VERDICTS].join(', ')}`);
  }
  if (!Array.isArray(r.findings)) fail('$.findings', 'expected an array');
  if (typeof r.summary !== 'string' || r.summary.length === 0) {
    fail('$.summary', 'expected a non-empty string');
  }
  if (
    typeof r.confidence !== 'number' ||
    !Number.isFinite(r.confidence) ||
    r.confidence < 0 ||
    r.confidence > 1
  ) {
    fail('$.confidence', 'expected a number between 0 and 1');
  }

  const findings = (r.findings as unknown[]).map((f, i) => validateFinding(f, `$.findings[${i}]`));

  return {
    role: r.role as RoleId,
    verdict: r.verdict as Verdict,
    findings,
    summary: r.summary,
    confidence: r.confidence,
  };
}
