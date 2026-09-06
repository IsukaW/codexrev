/**
 * Codexrev — Feature 2 (review-pipeline) role contract.
 *
 * The shared JSON shape every one of the six roles must emit
 * (`roles/ba.ts`, `dev.ts`, `build.ts`, `sec.ts`, `qa.ts`, `pm.ts` — built
 * in Phase 5). This is the "lingua franca" of the pipeline: the
 * `ContextAggregator` (Phase 4) accumulates one `RoleOutput` per role, the
 * `ResolverEngine` (Phase 6) reads all six to produce one final decision,
 * and `reportRenderer.ts` (Phase 7) renders `Finding[]` straight into the
 * HTML report's per-role sections and the git change-coverage map.
 *
 * Five LLM roles return this shape as parsed JSON from the model — that
 * makes `validateRoleOutput` a *runtime* check, not just a compile-time
 * type, since an LLM's JSON output is untrusted input until proven
 * otherwise. The sixth role (Build) is deterministic (no LLM call) but
 * still normalizes its compiler output into the exact same shape, so the
 * rest of the pipeline never needs to special-case it.
 */

import { CodexrevError } from '../../../utils/errors.js';

// ── Role identity ────────────────────────────────────────────────────

/**
 * The six roles, in their fixed identifiers. Also doubles as each role's
 * source-file stem under `roles/` (`ba.ts`, `dev.ts`, ...).
 */
export type RoleId = 'ba' | 'dev' | 'build' | 'sec' | 'qa' | 'pm';

/** Strictly-sequential execution order — see Section 2 of the dev guide. */
export const ROLE_ORDER: readonly RoleId[] = ['ba', 'dev', 'build', 'sec', 'qa', 'pm'];

/** Full display names (Section 2's authoritative role names) — used by the HTML/MD report. */
export const ROLE_LABELS: Readonly<Record<RoleId, string>> = {
  ba: 'Business Analyst',
  dev: 'Developer',
  build: 'Build Analyst',
  sec: 'Security Auditor',
  qa: 'QA Engineer',
  pm: 'Director of Engineering',
};

const ROLE_IDS = new Set<RoleId>(ROLE_ORDER);

// ── Verdict & severity ───────────────────────────────────────────────

/** A role's per-review verdict. */
export type Verdict = 'pass' | 'flag' | 'block';

const VERDICTS = new Set<Verdict>(['pass', 'flag', 'block']);

/** Ordered low → high. Conflict rules (Phase 6) bump a finding one level up this list. */
export const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

const SEVERITIES = new Set<Severity>(SEVERITY_ORDER);

/** Bumps a severity one level up `SEVERITY_ORDER`, capped at 'critical'. */
export function bumpSeverity(sev: Severity): Severity {
  const idx = SEVERITY_ORDER.indexOf(sev);
  return SEVERITY_ORDER[Math.min(idx + 1, SEVERITY_ORDER.length - 1)];
}

// ── Finding ──────────────────────────────────────────────────────────

/**
 * One issue raised by a role. This is the unit the git change-coverage
 * map keys off of (`file` + `lineStart`..`lineEnd` → the role verdict
 * that covers it) and what the HTML report renders per role.
 */
export interface Finding {
  /** Stable id, unique within one role's output (e.g. "sec-1", "qa-3"). */
  readonly id: string;
  readonly severity: Severity;
  /** CWE reference (e.g. "CWE-89"), when applicable — mainly the Sec role. */
  readonly cwe?: string;
  /** Path to the affected file, relative to the repo root. */
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** Plain-English explanation — this is what a non-security developer reads (Usability NFR). */
  readonly description: string;
  /** Optional proposed fix — free text or a diff-shaped suggestion, consumed by Phase 8's EditGenerator. */
  readonly suggestedFix?: string;
}

// ── Role output ──────────────────────────────────────────────────────

/** The shared JSON contract every role emits. */
export interface RoleOutput {
  readonly role: RoleId;
  readonly verdict: Verdict;
  readonly findings: readonly Finding[];
  /** Plain-English summary of this role's pass over the diff. */
  readonly summary: string;
  /** The role's confidence in its own verdict, 0 (none) – 1 (certain). */
  readonly confidence: number;
}

// ── Validation ───────────────────────────────────────────────────────

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

/** Validates and narrows one `Finding`. Throws `RoleContractError` on the first violation. */
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

/**
 * Validates and narrows one role's raw JSON output (typically
 * `JSON.parse`d straight from an LLM response) into a `RoleOutput`.
 * Throws `RoleContractError` with a path-qualified message on the first
 * violation found, so a role's `EditGenerator`/orchestrator can surface
 * exactly what the model got wrong.
 */
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
