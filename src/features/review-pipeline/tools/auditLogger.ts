/**
 * Audit trail for the review pipeline: appends a run_start marker, one line
 * per role verdict, one per Breaker-Builder fix attempt, and a final
 * resolver-decision line to .codexrev/audit.jsonl. Append-only, never
 * cleared or rotated. Callers write each entry as soon as that step
 * finishes (not batched) so a crash mid-run still leaves a partial trail.
 * Entries share a runId per invocation so readers can group by run.
 *
 * No generic atomic-write helper exists elsewhere to reuse, so the
 * tmp-file + rename pattern from saveProjectConfig is duplicated here.
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
  /** 'staged', or the git ref this run was scanned against (--diff <ref>) */
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

// one Breaker-Builder fix attempt — fixer stage, file, before/after, iteration.
// written the moment the loop applies the edit, same as roleVerdictAuditEntry
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

// call once, before the first role starts
export function runStartAuditEntry(runId: string, diffRef: string): RunStartAuditEntry {
  return { type: 'run_start', timestamp: nowIso(), runId, diffRef };
}

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

// final entry for the resolver's decision, call once after the pipeline stops
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

// atomic append: read current content, add the line, write to tmp, rename over
// original. not safe against two concurrent `codexrev review` processes on
// the same repo, same caveat saveProjectConfig already has
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
