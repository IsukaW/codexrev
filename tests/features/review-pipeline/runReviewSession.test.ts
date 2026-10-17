import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReviewSession } from '../../../src/features/review-pipeline/cli/runReviewSession.js';
import { readAuditLog } from '../../../src/features/review-pipeline/tools/auditLogger.js';
import { exitCodeForDecision } from '../../../src/features/review-pipeline/pipeline/resolverEngine.js';
import { ROLE_ORDER } from '../../../src/features/review-pipeline/roles/roleContract.js';
import { ProviderError } from '../../../src/core/types.js';
import type { ILLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { GenerateRequest, GenerateResponse } from '../../../src/core/types.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-review-session-'));
  tmpRoot = await fs.realpath(raw);
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 'test@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Test');
  await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'export const x = 1;\n', 'utf-8');
  await git.add('a.ts');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function failingProvider(): ILLMProvider {
  return {
    id: 'openai',
    async generate(_req: GenerateRequest): Promise<GenerateResponse> {
      throw new ProviderError('401 Incorrect API key provided: openai.', 'openai', 401, 'invalid_api_key', false);
    },
    stream() {
      throw new ProviderError('401 Incorrect API key provided: openai.', 'openai', 401, 'invalid_api_key', false);
    },
  };
}

function passingProvider(): ILLMProvider {
  return {
    id: 'openai',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const match = (req.systemInstruction ?? '').match(/"role":\s*"(\w+)"/);
      const role = match ? match[1] : 'ba';
      return {
        message: {
          role: 'assistant',
          parts: [{ kind: 'text', text: JSON.stringify({ role, verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 }) }],
        },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'completed',
      };
    },
    async *stream() {
      yield { kind: 'finish', reason: 'stop' };
    },
  };
}

function jsonReply(body: unknown): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: JSON.stringify(body) }] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'completed',
  };
}

/** Whether the model's prompt still shows the leaked connection — false once the fix has landed on disk. */
function promptShowsLeakedConnection(req: GenerateRequest): boolean {
  const text = req.messages
    .flatMap((m) => m.parts)
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
  return text.includes('LEAK: connection never released');
}

/**
 * Blocks with a resource-lifecycle finding on Architect as long as
 * `app.ts` still leaks the connection, generates a real fix for it via
 * the editGenerator system prompt, and passes every role once the
 * (content-driven, not call-counted) check shows the fix has actually
 * landed — so `runBreakerBuilderLoop` genuinely resolves, the same way
 * a real model re-scanning fixed code would.
 */
function fixingProvider(): ILLMProvider {
  return {
    id: 'openai',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const si = req.systemInstruction ?? '';
      if (si.includes('automated code-fixing assistant')) {
        return jsonReply({
          oldString: 'return conn.query(id); // LEAK: connection never released',
          newString: 'try {\n    return conn.query(id);\n  } finally {\n    conn.release();\n  }',
          description: 'Release the connection in a finally block to fix the leak.',
        });
      }
      const match = si.match(/"role":\s*"(\w+)"/);
      const role = match ? match[1] : 'ba';
      if (role === 'architect' && promptShowsLeakedConnection(req)) {
        return jsonReply({
          role: 'architect',
          verdict: 'block',
          findings: [
            { id: 'arch-1', severity: 'critical', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'Database connection is acquired but never released.' },
          ],
          summary: 'Found a resource-lifecycle violation.',
          confidence: 0.95,
        });
      }
      return jsonReply({ role, verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 });
    },
    async *stream() {
      yield { kind: 'finish', reason: 'stop' };
    },
  };
}

/**
 * Same shape as `fixingProvider()`, except the Architect role's RE-RUN
 * (after its fix has landed — detected the same content-driven way)
 * throws instead of passing, reproducing the reported crash: a real
 * `--fix` run hit a provider error ("400 Param Incorrect") partway
 * through the fix loop, after the batch gate had already been answered
 * and at least one fix already applied.
 */
function crashingFixProvider(): ILLMProvider {
  return {
    id: 'openai',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const si = req.systemInstruction ?? '';
      if (si.includes('automated code-fixing assistant')) {
        return jsonReply({
          oldString: 'return conn.query(id); // LEAK: connection never released',
          newString: 'try {\n    return conn.query(id);\n  } finally {\n    conn.release();\n  }',
          description: 'Release the connection in a finally block to fix the leak.',
        });
      }
      const match = si.match(/"role":\s*"(\w+)"/);
      const role = match ? match[1] : 'ba';
      if (role === 'architect') {
        if (promptShowsLeakedConnection(req)) {
          return jsonReply({
            role: 'architect',
            verdict: 'block',
            findings: [
              { id: 'arch-1', severity: 'critical', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'Database connection is acquired but never released.' },
            ],
            summary: 'Found a resource-lifecycle violation.',
            confidence: 0.95,
          });
        }
        // The re-run after the fix landed — this is where the reported crash happened.
        throw new ProviderError('400 Param Incorrect', 'openai', 400, 'invalid_request', false);
      }
      return jsonReply({ role, verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 });
    },
    async *stream() {
      yield { kind: 'finish', reason: 'stop' };
    },
  };
}

describe('runReviewSession — fix loop crash resilience (reported live: a mid-loop ProviderError skipped both reports)', () => {
  // Later live report: the loop crashing on a dropped connection also threw the run's result away and showed
  // the pre-fix verdict as if nothing had been applied. A model that cannot be reached now ends the loop as
  // 'interrupted' instead of crashing it, and the session reports what was and was not re-reviewed.
  it('ends the loop as interrupted, keeps the audit trail and both reports, and keeps the pre-fix decision for fixes no review has seen', async () => {
    const git = simpleGit({ baseDir: tmpRoot });
    const appFile = path.join(tmpRoot, 'app.ts');
    await fs.writeFile(appFile, "const conn = pool.acquire();\nreturn conn.query(id); // LEAK: connection never released\n", 'utf-8');
    await git.add('app.ts');

    const result = await runReviewSession({
      cwd: tmpRoot,
      forceNonInteractive: true,
      fix: true,
      fixStrategy: 'classic', // pins the original single-edit loop; the robust path has its own tests (fixRobust.test.ts)
      maxIterations: 3,
      llmOverride: crashingFixProvider(),
    });

    expect(result.breakerBuilder?.outcome).toBe('interrupted');
    // the fix landed, but the re-run that would have judged it never finished
    expect(result.breakerBuilder?.fixAttempts).toHaveLength(1);
    expect(result.breakerBuilder?.interruption?.verdictCurrent).toBe(false);

    // The fix that DID land is durably audit-logged — `onFixAttempt` is
    // awaited per-fix, so this entry was written before the re-run failed.
    const entries = await readAuditLog(tmpRoot);
    expect(entries.some((e) => e.type === 'fix_attempt')).toBe(true);

    // The run still ends with a resolver_decision line (Golden Rule:
    // never skip the audit log) — the PRE-FIX decision, since no complete
    // review has seen the applied fix.
    const last = entries[entries.length - 1];
    expect(last.type).toBe('resolver_decision');
    if (last.type === 'resolver_decision') {
      expect(last.decision).toBe('block'); // Architect's pre-fix veto, unchanged
    }
    expect(result.resolver.decision).toBe('block');

    // Both reports are written: the scan report, and a fix report that records what was applied and why it stopped.
    const reportsDir = path.join(tmpRoot, '.codexrev', 'review-pipeline', 'reports');
    const files = await fs.readdir(reportsDir);
    expect(files.some((f) => f.startsWith('scan-') && f.endsWith('.html'))).toBe(true);
    expect(files.some((f) => f.startsWith('fix-') && f.endsWith('.html'))).toBe(true);
  });
});

describe('runReviewSession — Phase 9 (post-fix HTML report & audit update)', () => {
  it(
    'after --fix resolves a real blocking finding, writes fix_attempt audit entries and a paired fix-<timestamp>.html ' +
      'report describing what was actually changed',
    async () => {
      const git = simpleGit({ baseDir: tmpRoot });
      const appFile = path.join(tmpRoot, 'app.ts');
      await fs.writeFile(appFile, "const conn = pool.acquire();\nreturn conn.query(id); // LEAK: connection never released\n", 'utf-8');
      await git.add('app.ts');

      const result = await runReviewSession({
        cwd: tmpRoot,
        forceNonInteractive: true,
        fix: true,
        fixStrategy: 'classic', // pins the original single-edit loop; the robust path has its own tests (fixRobust.test.ts)
        maxIterations: 3,
        llmOverride: fixingProvider(),
      });

      // The fix loop genuinely resolved it (content-driven check above,
      // not a scripted 2nd-call response) — the file on disk changed.
      expect(result.breakerBuilder?.outcome).toBe('resolved');
      expect(result.breakerBuilder?.fixAttempts).toHaveLength(1);
      expect(await fs.readFile(appFile, 'utf-8')).toContain('conn.release()');
      expect(result.resolver.decision).toBe('approve');

      // One fix_attempt audit entry, sharing the run's id, carrying the
      // fixer stage / file / before-after state / iteration (Phase 9
      // "New" bullet 1).
      const entries = await readAuditLog(tmpRoot);
      const fixEntries = entries.filter((e) => e.type === 'fix_attempt');
      expect(fixEntries).toHaveLength(1);
      const [fixEntry] = fixEntries;
      if (fixEntry.type === 'fix_attempt') {
        expect(fixEntry.runId).toBe(entries[0].runId);
        expect(fixEntry.file).toBe('app.ts');
        expect(fixEntry.fixerStage).toBe('llm');
        expect(fixEntry.iteration).toBe(1);
        expect(fixEntry.oldString).toContain('LEAK: connection never released');
        expect(fixEntry.newString).toContain('conn.release()');
      }

      // Paired fix-<timestamp>.html report, alongside the scan report
      // (Phase 9 "New" bullet 3 / DoD: two HTML files after a --fix run).
      expect(result.fixReportPath).toBeDefined();
      expect(path.dirname(result.fixReportPath!)).toBe(path.dirname(result.reportPaths!.html));
      expect(path.basename(result.fixReportPath!)).toMatch(/^fix-\d{8}-\d{6}\.html$/);

      const fixReportHtml = await fs.readFile(result.fixReportPath!, 'utf-8');
      expect(fixReportHtml).toContain('Codexrev Fix Summary');
      expect(fixReportHtml).toContain('Resolved');
      expect(fixReportHtml).toContain('app.ts');
      expect(fixReportHtml).toContain('Release the connection');
      expect(fixReportHtml).not.toContain('Still Unresolved');
    },
  );

  it('does not write a fix report when --fix is not passed, even though the scan itself still blocks', async () => {
    const git = simpleGit({ baseDir: tmpRoot });
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), "const conn = pool.acquire();\nreturn conn.query(id); // LEAK: connection never released\n", 'utf-8');
    await git.add('app.ts');

    const result = await runReviewSession({ cwd: tmpRoot, forceNonInteractive: true, llmOverride: fixingProvider() });

    expect(result.resolver.decision).toBe('block');
    expect(result.breakerBuilder).toBeUndefined();
    expect(result.fixReportPath).toBeUndefined();
    const entries = await readAuditLog(tmpRoot);
    expect(entries.some((e) => e.type === 'fix_attempt')).toBe(false);
  });
});

describe('runReviewSession', () => {
  it(
    "propagates a ProviderError from the LLM out to the caller (regression: this must NOT crash with a raw stack trace at the CLI layer — see handleReviewCommand.ts's catch) " +
      'AND still writes a complete audit trail first (Golden Rule: never skip the audit log, even on failure)',
    async () => {
      await expect(
        runReviewSession({
          cwd: tmpRoot,
          forceNonInteractive: true,
          llmOverride: failingProvider(),
        }),
      ).rejects.toBeInstanceOf(ProviderError);

      const entries = await readAuditLog(tmpRoot);
      // run_start, then no role_verdict entries (BA failed before producing
      // one), but the final resolver_decision line is still written,
      // recording the partial/errored outcome — and both share one runId.
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe('run_start');
      expect(entries[1].type).toBe('resolver_decision');
      expect(entries[0].runId).toBe(entries[1].runId);
      if (entries[1].type === 'resolver_decision') {
        expect(entries[1].pipelineOutcome).toBe('errored');
        expect(entries[1].ranRoles).toEqual([]);
      }

      // No report is written when zero roles completed — every section
      // would just read "did not run", so there's nothing reviewer-facing
      // to save. The audit trail above is the durable record instead
      // (reported live: this case used to silently write a content-free
      // report no one was told about).
      const reportsDir = path.join(tmpRoot, '.codexrev', 'review-pipeline', 'reports');
      await expect(fs.readdir(reportsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('DOES still write a report when the pipeline errors after at least one role completed', async () => {
    let calls = 0;
    const failsAfterFirstRole: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        calls += 1;
        if (calls > 1) {
          throw new ProviderError('500 upstream error', 'openai', 500, undefined, true);
        }
        const match = (req.systemInstruction ?? '').match(/"role":\s*"(\w+)"/);
        const role = match ? match[1] : 'ba';
        return {
          message: {
            role: 'assistant',
            parts: [{ kind: 'text', text: JSON.stringify({ role, verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 }) }],
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      stream() {
        throw new ProviderError('500 upstream error', 'openai', 500, undefined, true);
      },
    };

    await expect(
      runReviewSession({ cwd: tmpRoot, forceNonInteractive: true, llmOverride: failsAfterFirstRole }),
    ).rejects.toBeInstanceOf(ProviderError);

    const reportsDir = path.join(tmpRoot, '.codexrev', 'review-pipeline', 'reports');
    const files = await fs.readdir(reportsDir);
    expect(files.some((f) => f.startsWith('scan-') && f.endsWith('.html'))).toBe(true);
  });

  it('runs the full pipeline end to end against a real staged diff with a working fake provider', async () => {
    const result = await runReviewSession({ cwd: tmpRoot, forceNonInteractive: true, llmOverride: passingProvider() });
    expect(result.pipeline.outcome).toBe('completed');
    expect(result.pipeline.ranRoles).toHaveLength(6);
    // All six roles passed, no findings — the weighted score is 0 → Approve.
    expect(result.resolver.decision).toBe('approve');
    expect(exitCodeForDecision(result.resolver.decision)).toBe(0);
  });

  it('writes a run_start marker, one audit.jsonl line per role in ROLE_ORDER, plus a final resolver_decision line, all sharing one runId (Phase 6 DoD)', async () => {
    await runReviewSession({ cwd: tmpRoot, forceNonInteractive: true, llmOverride: passingProvider() });

    const entries = await readAuditLog(tmpRoot);
    expect(entries).toHaveLength(8);
    expect(entries[0].type).toBe('run_start');
    for (let i = 0; i < ROLE_ORDER.length; i++) {
      const entry = entries[i + 1];
      expect(entry.type).toBe('role_verdict');
      if (entry.type === 'role_verdict') {
        expect(entry.role).toBe(ROLE_ORDER[i]);
      }
    }
    const runId = entries[0].runId;
    expect(entries.every((e) => e.runId === runId)).toBe(true);

    const last = entries[7];
    expect(last.type).toBe('resolver_decision');
    if (last.type === 'resolver_decision') {
      expect(last.pipelineOutcome).toBe('completed');
      expect(last.decision).toBe('approve');
    }
  });
});
