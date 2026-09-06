/**
 * Codexrev — Feature 2 (review-pipeline) audit trail.
 *
 * Appends one `run_start` marker, one JSON line per role verdict, one
 * line per Breaker-Builder fix attempt (Phase 9, when `--fix` runs),
 * and one final line for the Resolver's decision, to
 * `.codexrev/audit.jsonl` (exact path per Section 1/2 of the dev guide)
 * — structured, chronologically-ordered, append-only. Every pipeline
 * run must produce an audit entry, even one that stops early via
 * Skip/Abort (Golden Rule) — callers append each entry the moment that
 * step finishes, not batched at the end, so a hard crash mid-run (or
 * mid-fix-loop) still leaves a partial, honest trail.
 *
 * The log accumulates across every run ever made in a project — it is
 * never cleared or rotated (that's the point of an audit trail). Every
 * entry carries a shared `runId` (one random id per `codexrev review
 * scan` invocation) so a reader — human or `readAuditLog()` — can tell
 * where one run ends and the next begins, and filter/group by run,
 * without depending on blank lines or timestamp gaps.
 *
 * There's no separately exported generic atomic-write helper in
 * `src/config/` to reuse directly — `saveProjectConfig()`'s tmp+rename
 * logic is inlined for the single `.codexrev/config.json` file. This
 * reuses that *pattern* (tmp file + `fs.rename`) rather than duplicating
 * unrelated code, and reuses `ensureProjectConfigDir`/`projectConfigDir`
 * as-is for path handling since `audit.jsonl` lives in the same
 * `.codexrev/` directory.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureProjectConfigDir, projectConfigDir } from '../../../config/projectConfig.js';
import type { RoleId, RoleOutput, Verdict } from '../roles/roleContract.js';
import type { PipelineOutcome } from '../pipeline/orchestrator.js';
import type { ResolverDecision } from '../pipeline/resolverEngine.js';
import type { FixAttemptRecord, FixerStage } from '../pipeline/breakerBuilderLoop.js';

export const AUDIT_LOG_FILENAME = 'audit.jsonl';

export function auditLogPath(projectRoot: string): string {
  return path.join(projectConfigDir(projectRoot), AUDIT_LOG_FILENAME);
}

/** Generates a fresh id for one `codexrev review scan` invocation — call once per run. */
export function newAuditRunId(): string {
  return randomBytes(6).toString('hex');
}

export interface RunStartAuditEntry {
  readonly type: 'run_start';
  readonly timestamp: string;
  readonly runId: string;
  /** 'staged', or the git ref this run was scanned against (`--diff <ref>`). */
  readonly diffRef: string;
}

export interface RoleVerdictAuditEntry {
  readonly type: 'role_verdict';
  readonly timestamp: string;
  readonly runId: string;
  readonly role: RoleId;
  readonly verdict: Verdict;
  readonly findingsCount: number;
  readonly confidence: number;
  readonly summary: string;
}

export interface ResolverDecisionAuditEntry {
  readonly type: 'resolver_decision';
  readonly timestamp: string;
  readonly runId: string;
  readonly decision: ResolverDecision;
  readonly score: number;
  readonly rationale: string;
  readonly appliedRules: readonly string[];
  readonly ranRoles: readonly RoleId[];
  readonly skippedRoles: readonly RoleId[];
  readonly pipelineOutcome: PipelineOutcome;
}

/**
 * One Breaker-Builder fix attempt (Phase 9's "New" bullet 1: which
 * fixer stage, which file, before/after code state, iteration number).
 * Written the moment `breakerBuilderLoop.ts` applies the edit — same
 * "append as it happens, not batched at the end" discipline as
 * `roleVerdictAuditEntry`, so a hard crash mid-fix-loop still leaves an
 * honest partial trail of what was actually changed.
 */
export interface FixAttemptAuditEntry {
  readonly type: 'fix_attempt';
  readonly timestamp: string;
  readonly runId: string;
  readonly iteration: number;
  readonly role: RoleId;
  readonly findingId: string;
  readonly file: string;
  readonly fixerStage: FixerStage;
  readonly description: string;
  readonly oldString: string;
  readonly newString: string;
}

export type AuditEntry = RunStartAuditEntry | RoleVerdictAuditEntry | ResolverDecisionAuditEntry | FixAttemptAuditEntry;

function nowIso(): string {
  return new Date().toISOString();
}

/** Builds the entry that marks the start of one run — call once, before the first role starts. */
export function runStartAuditEntry(runId: string, diffRef: string): RunStartAuditEntry {
  return { type: 'run_start', timestamp: nowIso(), runId, diffRef };
}

/** Builds the audit entry for one completed role — call right after that role finishes. */
export function roleVerdictAuditEntry(runId: string, output: RoleOutput): RoleVerdictAuditEntry {
  return {
    type: 'role_verdict',
    timestamp: nowIso(),
    runId,
    role: output.role,
    verdict: output.verdict,
    findingsCount: output.findings.length,
    confidence: output.confidence,
    summary: output.summary,
  };
}

/** Builds the final audit entry for the Resolver's decision — call once, after the pipeline stops. */
export function resolverDecisionAuditEntry(
  runId: string,
  params: {
    decision: ResolverDecision;
    score: number;
    rationale: string;
    appliedRules: readonly string[];
    ranRoles: readonly RoleId[];
    skippedRoles: readonly RoleId[];
    pipelineOutcome: PipelineOutcome;
  },
): ResolverDecisionAuditEntry {
  return { type: 'resolver_decision', timestamp: nowIso(), runId, ...params };
}

/** Builds the audit entry for one Breaker-Builder fix attempt — call right after that fix is applied. */
export function fixAttemptAuditEntry(runId: string, record: FixAttemptRecord): FixAttemptAuditEntry {
  return {
    type: 'fix_attempt',
    timestamp: nowIso(),
    runId,
    iteration: record.iteration,
    role: record.role,
    findingId: record.findingId,
    file: record.file,
    fixerStage: record.fixerStage,
    description: record.description,
    oldString: record.oldString,
    newString: record.newString,
  };
}

/**
 * Appends one entry to `.codexrev/audit.jsonl`, atomically (read the
 * current content, append the new line, write to a tmp file, rename
 * over the original — same tmp+rename pattern as `saveProjectConfig`).
 * Never truncates or reorders existing lines — the log accumulates
 * across every run; see this file's docstring for how `runId` keeps
 * runs distinguishable as it grows. Not safe against two concurrent
 * `codexrev review` processes racing on the same repo (same caveat
 * `saveProjectConfig` already has) — out of scope here.
 */
export async function appendAuditEntry(projectRoot: string, entry: AuditEntry): Promise<void> {
  const dir = await ensureProjectConfigDir(projectRoot);
  const file = auditLogPath(projectRoot);
  const line = JSON.stringify(entry);

  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const updated = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n${line}\n` : `${existing}${line}\n`;

  const tmp = path.join(dir, `.${AUDIT_LOG_FILENAME}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, updated, 'utf-8');
  await fs.rename(tmp, file);
}

/** Reads back every entry currently in `.codexrev/audit.jsonl`, in file order. Returns `[]` if the file doesn't exist yet. */
export async function readAuditLog(projectRoot: string): Promise<AuditEntry[]> {
  const file = auditLogPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

/** Groups a flat audit log into one array of entries per `runId`, in the order each run started. */
export function groupAuditLogByRun(entries: readonly AuditEntry[]): AuditEntry[][] {
  const order: string[] = [];
  const byRun = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    if (!byRun.has(entry.runId)) {
      byRun.set(entry.runId, []);
      order.push(entry.runId);
    }
    byRun.get(entry.runId)!.push(entry);
  }
  return order.map((id) => byRun.get(id)!);
}
