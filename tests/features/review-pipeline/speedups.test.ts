import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runBreakerBuilderLoop } from '../../../src/features/review-pipeline/pipeline/breakerBuilderLoop.js';
import { ContextAggregator } from '../../../src/features/review-pipeline/pipeline/contextAggregator.js';
import { prewarmFixEnvironment } from '../../../src/features/review-pipeline/pipeline/fixPrewarm.js';
import { runLlmRole } from '../../../src/features/review-pipeline/pipeline/llmRoleRunner.js';
import { runPipeline } from '../../../src/features/review-pipeline/pipeline/orchestrator.js';
import { createRoleCache, fingerprintTree } from '../../../src/features/review-pipeline/pipeline/reviewCache.js';
import { RoleMetrics } from '../../../src/features/review-pipeline/pipeline/roleMetrics.js';
import { roleVerdictAuditEntry } from '../../../src/features/review-pipeline/tools/auditLogger.js';
import type { ParsedDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { RoleRunContext } from '../../../src/features/review-pipeline/pipeline/roleRunContext.js';
import type { GenerateRequest, GenerateResponse } from '../../../src/core/types.js';
import type { Finding, RoleOutput } from '../../../src/features/review-pipeline/roles/roleContract.js';

const EMPTY_DIFF: ParsedDiff = { ref: 'staged', raw: '', files: [] };
let tmpRoot: string;

// sandboxes are made in os.tmpdir(); use a directory of our own so another test file running in
// parallel (and making its own sandboxes) cannot show up in the leftover checks below
const realTmpdir = process.env.TMPDIR;
let privateTmp: string;
beforeAll(async () => {
  privateTmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-speed-tmp-')));
  process.env.TMPDIR = privateTmp;
});
afterAll(async () => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  await fs.rm(privateTmp, { recursive: true, force: true });
});

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-speed-')));
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 't@t.dev');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(tmpRoot, 'app.js'), 'buggy\n');
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const reply = (text: string): GenerateResponse => ({
  message: { role: 'assistant', parts: [{ kind: 'text', text }] },
  usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
  finishReason: 'completed',
});
const passJson = (role: string): string => JSON.stringify({ role, verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 });

function countingLlm(): { llm: ILLMProvider; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    llm: {
      id: 'openai',
      async generate(req: GenerateRequest) {
        n++;
        const role = /"role": "(\w+)"/.exec(req.systemInstruction ?? '')?.[1] ?? 'dev';
        return reply(passJson(role));
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    },
  };
}

function ctxFor(llm: ILLMProvider, extra: Partial<RoleRunContext> = {}): RoleRunContext {
  return { llm, model: 'm', diff: EMPTY_DIFF, aggregator: new ContextAggregator(EMPTY_DIFF), cwd: tmpRoot, ...extra };
}

// ── timing ──────────────────────────────────────────────────────────────────

describe('timing', () => {
  it('counts model calls and tokens per role, and a cached answer costs none', async () => {
    const { llm } = countingLlm();
    const metrics = new RoleMetrics();
    await runLlmRole('dev', 'You are dev.', ctxFor(llm, { metrics }));
    const t = metrics.snapshot(1234);
    expect(t).toMatchObject({ durationMs: 1234, llmCalls: 1, inputTokens: 1000, outputTokens: 200 });
    expect(t.cached).toBeUndefined();
  });

  it('runPipeline reports a timing for every role that ran (Build, which has no model, reports 0 calls)', async () => {
    const { llm } = countingLlm();
    const result = await runPipeline({ diff: EMPTY_DIFF, llm, model: 'm', cwd: tmpRoot });
    expect(Object.keys(result.timings).sort()).toEqual(['architect', 'ba', 'build', 'dev', 'pm', 'qa']);
    expect(result.timings.ba!.llmCalls).toBe(1);
    expect(result.timings.build!.llmCalls).toBe(0);
  });

  it('is written to the audit entry when given, and absent otherwise', () => {
    const out: RoleOutput = { role: 'dev', verdict: 'pass', findings: [], summary: 's', confidence: 1 };
    expect(roleVerdictAuditEntry('r', out)).not.toHaveProperty('durationMs');
    const withTiming = roleVerdictAuditEntry('r', out, { durationMs: 5, llmCalls: 2, inputTokens: 3, outputTokens: 4, cached: true });
    expect(withTiming).toMatchObject({ durationMs: 5, llmCalls: 2, inputTokens: 3, outputTokens: 4, cached: true });
  });
});

// ── cache ───────────────────────────────────────────────────────────────────

describe('review cache', () => {
  it('answers an identical question without calling the model, and says so', async () => {
    const cache = createRoleCache(tmpRoot);
    const a = countingLlm();
    const first = await runLlmRole('dev', 'You are dev.', ctxFor(a.llm, { cache }));
    expect(a.calls()).toBe(1);

    const b = countingLlm();
    const metrics = new RoleMetrics();
    const second = await runLlmRole('dev', 'You are dev.', ctxFor(b.llm, { cache: createRoleCache(tmpRoot), metrics }));
    expect(b.calls()).toBe(0);
    expect(second).toEqual(first);
    expect(metrics.snapshot(1).cached).toBe(true);
  });

  it('asks again when the code changes — also a file the diff does not mention (roles read those with tools)', async () => {
    const cache = createRoleCache(tmpRoot);
    await runLlmRole('dev', 'You are dev.', ctxFor(countingLlm().llm, { cache }));

    await fs.writeFile(path.join(tmpRoot, 'caller.js'), 'a new caller outside the diff\n');
    const b = countingLlm();
    await runLlmRole('dev', 'You are dev.', ctxFor(b.llm, { cache: createRoleCache(tmpRoot) }));
    expect(b.calls()).toBe(1);
  });

  it('asks again when the diff, the URS, the role prompt or the model change', async () => {
    const seed = countingLlm();
    await runLlmRole('dev', 'You are dev.', ctxFor(seed.llm, { cache: createRoleCache(tmpRoot) }));
    const variants: Array<[string, Partial<RoleRunContext>, string]> = [
      ['urs', { urs: 'REQ-1' }, 'You are dev.'],
      ['model', { model: 'other-model' }, 'You are dev.'],
      ['prompt', {}, 'You are a stricter dev.'],
      ['diff', { diff: { ref: 'staged', raw: 'x', files: [{ path: 'a.ts', status: 'modified', hunks: [] }] } }, 'You are dev.'],
    ];
    for (const [label, extra, prompt] of variants) {
      const probe = countingLlm();
      await runLlmRole('dev', prompt, ctxFor(probe.llm, { cache: createRoleCache(tmpRoot), ...extra }));
      expect(probe.calls(), label).toBe(1);
    }
  });

  it('is shared with a fix-verification run: same code and same earlier findings hit, the extra note does not break the match', async () => {
    const cache = createRoleCache(tmpRoot);
    await runLlmRole('dev', 'You are dev.', ctxFor(countingLlm().llm, { cache, verification: { previouslyBlocking: [], appliedFixes: [{ file: 'a.js', description: 'x' }] } }));
    const probe = countingLlm();
    await runLlmRole('dev', 'You are dev.', ctxFor(probe.llm, { cache: createRoleCache(tmpRoot) })); // a later plain scan
    expect(probe.calls()).toBe(0);
  });

  it('never stores a failure, and a corrupt entry is just a miss', async () => {
    const cache = createRoleCache(tmpRoot);
    const broken: ILLMProvider = { id: 'openai', generate: async () => reply('not json at all'), async *stream() { yield { kind: 'finish', reason: 'stop' }; } };
    await expect(runLlmRole('dev', 'You are dev.', ctxFor(broken, { cache }))).rejects.toThrow();
    const dir = path.join(tmpRoot, '.codexrev/review-pipeline/cache');
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);

    await runLlmRole('dev', 'You are dev.', ctxFor(countingLlm().llm, { cache }));
    const [file] = await fs.readdir(dir);
    await fs.writeFile(path.join(dir, file!), '{ corrupt');
    const probe = countingLlm();
    await runLlmRole('dev', 'You are dev.', ctxFor(probe.llm, { cache: createRoleCache(tmpRoot) }));
    expect(probe.calls()).toBe(1);
  });

  it('fingerprints content, ignores .codexrev, and refuses to guess outside a git repo', async () => {
    const before = await fingerprintTree(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, '.codexrev'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, '.codexrev/audit.jsonl'), 'noise\n');
    expect(await fingerprintTree(tmpRoot)).toBe(before);
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'changed\n');
    expect(await fingerprintTree(tmpRoot)).not.toBe(before);

    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-nogit-'));
    try {
      expect(await fingerprintTree(plain)).toBeNull();
      const noGit = countingLlm();
      await runLlmRole('dev', 'You are dev.', ctxFor(noGit.llm, { cwd: plain, cache: createRoleCache(plain) }));
      await runLlmRole('dev', 'You are dev.', ctxFor(noGit.llm, { cwd: plain, cache: createRoleCache(plain) }));
      expect(noGit.calls()).toBe(2); // no fingerprint, no caching
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});

// ── fix loop: redundant checks and prewarming ───────────────────────────────

const FIXED = '{"status":"fixed","description":"done"}';
type Step = { tool: string; args: Record<string, unknown> } | string;

function agentLlm(script: readonly Step[]): ILLMProvider {
  return {
    id: 'openai',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const sys = req.systemInstruction ?? '';
      if (sys.includes('You are the Fixer')) {
        const turn = req.messages.filter((m) => m.role === 'tool').length;
        const step = script[turn] ?? FIXED;
        return typeof step === 'string'
          ? reply(step)
          : { ...reply(''), message: { role: 'assistant', parts: [{ kind: 'tool_call', id: `c${turn}`, name: step.tool, arguments: step.args }] } };
      }
      return reply(passJson(/"role": "(\w+)"/.exec(sys)?.[1] ?? 'dev'));
    },
    async *stream() {
      yield { kind: 'finish', reason: 'stop' };
    },
  };
}

const blockingDev = (): RoleOutput => ({
  role: 'dev',
  verdict: 'block',
  summary: 'b',
  confidence: 0.9,
  findings: [{ id: 'dev-1', severity: 'high', file: 'app.js', lineStart: 1, lineEnd: 1, description: 'wrong value' } as Finding],
});

async function testProject(): Promise<string> {
  // every run of the project's tests leaves one mark in a file OUTSIDE the project, so runs can be counted
  const counter = path.join(tmpRoot, '..', `runs-${path.basename(tmpRoot)}.txt`);
  await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node count.js' } }));
  await fs.writeFile(path.join(tmpRoot, 'count.js'), `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');`);
  return counter;
}
const runsOf = async (counter: string): Promise<number> => (await fs.readFile(counter, 'utf-8').catch(() => '')).length;
const leftovers = async (): Promise<string[]> => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('codexrev-sandbox-'));

const loopOpts = { model: 'm', maxIterations: 2, finalVerification: true, agent: true, validate: true, validationOptions: { testTimeoutMs: 60_000 } } as const;

describe('--fix does not repeat a check it just did', () => {
  it('skips the post-fix build + tests when the fixer already got OK on exactly these edits', async () => {
    const counter = await testProject();
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blockingDev());
    const result = await runBreakerBuilderLoop({
      ...loopOpts, aggregator, cwd: tmpRoot,
      llm: agentLlm([{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } }, { tool: 'run_checks', args: {} }, FIXED]),
    });
    expect(result.outcome).toBe('resolved');
    expect(await runsOf(counter)).toBe(2); // baseline + the fixer's own run_checks; no third run to "accept"
    await fs.rm(counter, { force: true });
  }, 60_000);

  it('still checks when the fixer edited after its last OK (or never ran run_checks)', async () => {
    const counter = await testProject();
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blockingDev());
    const result = await runBreakerBuilderLoop({
      ...loopOpts, aggregator, cwd: tmpRoot,
      llm: agentLlm([
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } },
        { tool: 'run_checks', args: {} },
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'fixed', new_string: 'fixed again' } },
        FIXED,
      ]),
    });
    expect(result.outcome).toBe('resolved');
    expect(await runsOf(counter)).toBe(3); // baseline + run_checks + the acceptance check of the final state
    await fs.rm(counter, { force: true });
  }, 60_000);

  it('reports where the time went', async () => {
    await testProject();
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blockingDev());
    const result = await runBreakerBuilderLoop({
      ...loopOpts, aggregator, cwd: tmpRoot,
      llm: agentLlm([{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } }, FIXED]),
    });
    expect(Array.isArray(result.timings ?? [])).toBe(true);
    for (const row of result.timings ?? []) expect(row.ms).toBeGreaterThanOrEqual(1000); // sub-second phases are not worth a line
  }, 60_000);
});

describe('--fix prepares its temporary copy while the scan runs', () => {
  it('adopts the prepared copy and its baseline when the project is unchanged (no second baseline run)', async () => {
    const counter = await testProject();
    const before = await leftovers();
    const prewarmed = prewarmFixEnvironment(tmpRoot, EMPTY_DIFF, true, { testTimeoutMs: 60_000 });
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blockingDev());
    const result = await runBreakerBuilderLoop({
      ...loopOpts, aggregator, cwd: tmpRoot, prewarmed,
      llm: agentLlm([{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } }, { tool: 'run_checks', args: {} }, FIXED]),
    });
    expect(result.outcome).toBe('resolved');
    expect(await runsOf(counter)).toBe(2); // prewarm's baseline + run_checks (a fresh baseline would have made it 3)
    expect(result.notes?.join(' ') ?? '').not.toContain('discarded');
    expect((await leftovers()).filter((n) => !before.includes(n))).toEqual([]);
    await fs.rm(counter, { force: true });
  }, 60_000);

  it('throws the prepared copy away and starts fresh when the project changed in the meantime', async () => {
    const counter = await testProject();
    const before = await leftovers();
    const prewarmed = prewarmFixEnvironment(tmpRoot, EMPTY_DIFF, true, { testTimeoutMs: 60_000 });
    await prewarmed; // copy taken…
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'buggy and then edited by the user\n'); // …then the user edits
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blockingDev());
    const result = await runBreakerBuilderLoop({
      ...loopOpts, aggregator, cwd: tmpRoot, prewarmed,
      llm: agentLlm([{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } }, { tool: 'run_checks', args: {} }, FIXED]),
    });
    expect(result.notes?.join(' ')).toContain('project changed while the review was running');
    expect(await runsOf(counter)).toBe(3); // stale baseline + fresh baseline + run_checks
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('fixed and then edited by the user\n'); // applied to what is really there
    expect((await leftovers()).filter((n) => !before.includes(n))).toEqual([]);
    await fs.rm(counter, { force: true });
  }, 60_000);

  it('cleans up a prepared copy that nothing ended up needing', async () => {
    await testProject();
    const before = await leftovers();
    const prewarmed = prewarmFixEnvironment(tmpRoot, EMPTY_DIFF, true, { testTimeoutMs: 60_000 });
    const result = await runBreakerBuilderLoop({
      ...loopOpts, aggregator: new ContextAggregator(EMPTY_DIFF), cwd: tmpRoot, prewarmed, llm: agentLlm([]), // nothing blocking
    });
    expect(result.outcome).toBe('resolved');
    expect((await leftovers()).filter((n) => !before.includes(n))).toEqual([]);
  }, 60_000);
});
