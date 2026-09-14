import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAuditEntry,
  auditLogPath,
  fixAttemptAuditEntry,
  groupAuditLogByRun,
  newAuditRunId,
  readAuditLog,
  resolverDecisionAuditEntry,
  roleVerdictAuditEntry,
  runStartAuditEntry,
} from '../../../src/features/review-pipeline/tools/auditLogger.js';
import type { RoleOutput } from '../../../src/features/review-pipeline/roles/roleContract.js';
import type { FixAttemptRecord } from '../../../src/features/review-pipeline/pipeline/breakerBuilderLoop.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-audit-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const SAMPLE_ROLE_OUTPUT: RoleOutput = {
  role: 'ba',
  verdict: 'pass',
  findings: [],
  summary: 'All good.',
  confidence: 0.9,
};

describe('auditLogPath', () => {
  it('resolves to .codexrev/audit.jsonl under the project root', () => {
    expect(auditLogPath(tmpRoot)).toBe(path.join(tmpRoot, '.codexrev', 'audit.jsonl'));
  });
});

describe('readAuditLog', () => {
  it('returns [] when the file does not exist yet', async () => {
    expect(await readAuditLog(tmpRoot)).toEqual([]);
  });
});

describe('appendAuditEntry', () => {
  it('creates .codexrev/ and writes the first entry as a single JSON line', async () => {
    const runId = newAuditRunId();
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(runId, SAMPLE_ROLE_OUTPUT));

    const raw = await fs.readFile(auditLogPath(tmpRoot), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('role_verdict');
    expect(parsed.role).toBe('ba');
    expect(parsed.runId).toBe(runId);
  });

  it('appends without disturbing earlier lines, preserving chronological order', async () => {
    const runId = newAuditRunId();
    await appendAuditEntry(tmpRoot, runStartAuditEntry(runId, 'staged'));
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(runId, { ...SAMPLE_ROLE_OUTPUT, role: 'ba' }));
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(runId, { ...SAMPLE_ROLE_OUTPUT, role: 'dev' }));
    await appendAuditEntry(
      tmpRoot,
      resolverDecisionAuditEntry(runId, {
        decision: 'approve',
        score: 0,
        rationale: 'all clear',
        appliedRules: [],
        ranRoles: ['ba', 'dev'],
        skippedRoles: ['build', 'architect', 'qa', 'pm'],
        pipelineOutcome: 'skipped',
      }),
    );

    const entries = await readAuditLog(tmpRoot);
    expect(entries).toHaveLength(4);
    expect(entries[0].type).toBe('run_start');
    expect(entries[1].type).toBe('role_verdict');
    expect(entries[2].type).toBe('role_verdict');
    expect(entries[3].type).toBe('resolver_decision');
    if (entries[0].type === 'run_start') expect(entries[0].diffRef).toBe('staged');
    if (entries[1].type === 'role_verdict') expect(entries[1].role).toBe('ba');
    if (entries[2].type === 'role_verdict') expect(entries[2].role).toBe('dev');
    if (entries[3].type === 'resolver_decision') {
      expect(entries[3].decision).toBe('approve');
      expect(entries[3].pipelineOutcome).toBe('skipped');
      expect(entries[3].skippedRoles).toEqual(['build', 'architect', 'qa', 'pm']);
    }
    // Every entry from this run shares the same id.
    expect(entries.every((e) => e.runId === runId)).toBe(true);
  });

  it('each line is valid standalone JSON (JSONL, not one big JSON array)', async () => {
    const runId = newAuditRunId();
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(runId, SAMPLE_ROLE_OUTPUT));
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(runId, { ...SAMPLE_ROLE_OUTPUT, role: 'dev' }));

    const raw = await fs.readFile(auditLogPath(tmpRoot), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('every entry carries a timestamp', async () => {
    const runId = newAuditRunId();
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(runId, SAMPLE_ROLE_OUTPUT));
    const [entry] = await readAuditLog(tmpRoot);
    expect(entry.timestamp).toBeDefined();
    expect(new Date(entry.timestamp).toString()).not.toBe('Invalid Date');
  });
});

const SAMPLE_FIX_ATTEMPT: FixAttemptRecord = {
  iteration: 1,
  role: 'architect',
  findingId: 'arch-1',
  file: 'app.ts',
  fixerStage: 'llm',
  description: 'parameterize the query',
  oldString: "const q = 'SELECT * FROM users WHERE id=' + id;",
  newString: 'const q = "fixed";',
};

describe('fixAttemptAuditEntry (Phase 9)', () => {
  it('appends one entry per fix attempt, carrying the fixer stage, file, before/after state, and iteration', async () => {
    const runId = newAuditRunId();
    await appendAuditEntry(tmpRoot, fixAttemptAuditEntry(runId, SAMPLE_FIX_ATTEMPT));

    const [entry] = await readAuditLog(tmpRoot);
    expect(entry.type).toBe('fix_attempt');
    expect(entry.runId).toBe(runId);
    if (entry.type === 'fix_attempt') {
      expect(entry.iteration).toBe(1);
      expect(entry.role).toBe('architect');
      expect(entry.findingId).toBe('arch-1');
      expect(entry.file).toBe('app.ts');
      expect(entry.fixerStage).toBe('llm');
      expect(entry.oldString).toContain('SELECT * FROM users');
      expect(entry.newString).toContain('fixed');
    }
  });

  it('interleaves correctly with role_verdict and resolver_decision entries, all sharing one runId', async () => {
    const runId = newAuditRunId();
    await appendAuditEntry(tmpRoot, runStartAuditEntry(runId, 'staged'));
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(runId, { ...SAMPLE_ROLE_OUTPUT, role: 'architect', verdict: 'block' }));
    await appendAuditEntry(tmpRoot, fixAttemptAuditEntry(runId, SAMPLE_FIX_ATTEMPT));
    await appendAuditEntry(tmpRoot, fixAttemptAuditEntry(runId, { ...SAMPLE_FIX_ATTEMPT, iteration: 2, findingId: 'arch-2' }));
    await appendAuditEntry(
      tmpRoot,
      resolverDecisionAuditEntry(runId, {
        decision: 'approve',
        score: 0,
        rationale: 'fixed',
        appliedRules: [],
        ranRoles: ['architect'],
        skippedRoles: [],
        pipelineOutcome: 'completed',
      }),
    );

    const entries = await readAuditLog(tmpRoot);
    expect(entries.map((e) => e.type)).toEqual(['run_start', 'role_verdict', 'fix_attempt', 'fix_attempt', 'resolver_decision']);
    expect(entries.every((e) => e.runId === runId)).toBe(true);
  });
});

describe('newAuditRunId', () => {
  it('produces a different id each call', () => {
    expect(newAuditRunId()).not.toBe(newAuditRunId());
  });
});

describe('groupAuditLogByRun — solves "the log keeps growing, where does each run start?"', () => {
  it('splits a multi-run log into one array per run, in run-start order', async () => {
    const run1 = newAuditRunId();
    const run2 = newAuditRunId();

    await appendAuditEntry(tmpRoot, runStartAuditEntry(run1, 'staged'));
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(run1, { ...SAMPLE_ROLE_OUTPUT, role: 'ba' }));
    await appendAuditEntry(
      tmpRoot,
      resolverDecisionAuditEntry(run1, {
        decision: 'approve',
        score: 0,
        rationale: 'r1',
        appliedRules: [],
        ranRoles: ['ba'],
        skippedRoles: ['dev', 'build', 'architect', 'qa', 'pm'],
        pipelineOutcome: 'skipped',
      }),
    );
    await appendAuditEntry(tmpRoot, runStartAuditEntry(run2, 'HEAD~1'));
    await appendAuditEntry(tmpRoot, roleVerdictAuditEntry(run2, { ...SAMPLE_ROLE_OUTPUT, role: 'ba' }));

    const entries = await readAuditLog(tmpRoot);
    const runs = groupAuditLogByRun(entries);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(3);
    expect(runs[1]).toHaveLength(2);
    expect(runs[0].every((e) => e.runId === run1)).toBe(true);
    expect(runs[1].every((e) => e.runId === run2)).toBe(true);
    expect(runs[0][0].type).toBe('run_start');
    expect(runs[1][0].type).toBe('run_start');
  });

  it('returns [] for an empty log', () => {
    expect(groupAuditLogByRun([])).toEqual([]);
  });
});
