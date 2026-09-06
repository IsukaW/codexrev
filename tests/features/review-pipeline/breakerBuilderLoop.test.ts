import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RETRIES_PER_FILE, runBreakerBuilderLoop } from '../../../src/features/review-pipeline/pipeline/breakerBuilderLoop.js';
import { ContextAggregator } from '../../../src/features/review-pipeline/pipeline/contextAggregator.js';
import { InteractionChannel } from '../../../src/core/interaction.js';
import type { ParsedDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { GenerateRequest, GenerateResponse } from '../../../src/core/types.js';
import type { RoleOutput } from '../../../src/features/review-pipeline/roles/roleContract.js';

const EMPTY_DIFF: ParsedDiff = { ref: 'staged', raw: '', files: [] };

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-bbloop-'));
  tmpRoot = await fs.realpath(raw);
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 't@t.dev');
  await git.addConfig('user.name', 'Test');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function jsonReply(body: unknown): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: JSON.stringify(body) }] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'completed',
  };
}

/** Distinguishes an editGenerator.ts call (unique system-prompt phrase) from a role-verdict call. */
function isEditGenCall(req: GenerateRequest): boolean {
  return (req.systemInstruction ?? '').includes('automated code-fixing assistant');
}

function passOutput(role: string): RoleOutput {
  return { role: role as RoleOutput['role'], verdict: 'pass', findings: [], summary: 'fixed', confidence: 0.9 };
}

describe('runBreakerBuilderLoop — resolved without any work', () => {
  it('returns "resolved" immediately with 0 iterations when nothing is blocking', async () => {
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({ role: 'ba', verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 });
    aggregator.addRoleOutput({ role: 'sec', verdict: 'flag', findings: [], summary: 'advisory only', confidence: 0.9 });

    const unusedLlm: ILLMProvider = {
      id: 'openai',
      generate: () => {
        throw new Error('must not call the LLM when nothing is blocking');
      },
      stream: () => {
        throw new Error('must not call the LLM when nothing is blocking');
      },
    };

    const result = await runBreakerBuilderLoop({ aggregator, llm: unusedLlm, model: 'm', cwd: tmpRoot, maxIterations: 5 });
    expect(result.outcome).toBe('resolved');
    expect(result.iterations).toBe(0);
    expect(result.fixAttempts).toEqual([]);
  });

  it('does not attempt a fix for an advisory (flag) finding — only "block" verdicts trigger the loop', async () => {
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'dev',
      verdict: 'flag',
      findings: [{ id: 'dev-1', severity: 'low', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'nit' }],
      summary: 'minor',
      confidence: 0.9,
    });
    const unusedLlm: ILLMProvider = {
      id: 'openai',
      generate: () => {
        throw new Error('flag-only findings must not trigger a fix attempt');
      },
      stream: () => {
        throw new Error('flag-only findings must not trigger a fix attempt');
      },
    };
    const result = await runBreakerBuilderLoop({ aggregator, llm: unusedLlm, model: 'm', cwd: tmpRoot, maxIterations: 5 });
    expect(result.outcome).toBe('resolved');
  });
});

describe('runBreakerBuilderLoop — deterministic fix path', () => {
  it('fixes a real TS7006 finding without calling the LLM, and the fix lands on disk', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'export function greet(name) {\n  return name;\n}\n', 'utf-8');

    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'build',
      verdict: 'block',
      findings: [
        {
          id: 'build-1',
          severity: 'high',
          file: 'a.ts',
          lineStart: 1,
          lineEnd: 1,
          description: "tsc TS7006: Parameter 'name' implicitly has an 'any' type.",
        },
      ],
      summary: 'tsc: 1 error(s)',
      confidence: 1,
    });

    const unusedLlm: ILLMProvider = {
      id: 'openai',
      generate: () => {
        throw new Error('deterministic fix should not need the LLM');
      },
      stream: () => {
        throw new Error('deterministic fix should not need the LLM');
      },
    };

    const result = await runBreakerBuilderLoop({ aggregator, llm: unusedLlm, model: 'm', cwd: tmpRoot, maxIterations: 5 });

    expect(result.fixAttempts).toHaveLength(1);
    expect(result.fixAttempts[0].fixerStage).toBe('deterministic');
    const content = await fs.readFile(path.join(tmpRoot, 'a.ts'), 'utf-8');
    expect(content).toContain('name: any');
    // Build's real re-run either confirms the fix (tsc unavailable in this
    // sandbox → reports 'flag', not 'block' — see build.test.ts's Phase 5
    // precedent) or genuinely passes if tsc happens to be resolvable; either
    // way the finding no longer blocks, so the loop resolves.
    expect(result.outcome).toBe('resolved');
  }, 30_000);
});

describe('runBreakerBuilderLoop — LLM fallback path', () => {
  it('falls back to the LLM for a non-TS finding, applies the fix, and re-run confirms resolution', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), "const q = 'SELECT * FROM users WHERE id=' + id;\n", 'utf-8');

    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [
        {
          id: 'sec-1',
          severity: 'critical',
          cwe: 'CWE-89',
          file: 'app.ts',
          lineStart: 1,
          lineEnd: 1,
          description: 'SQL injection via string concatenation.',
        },
      ],
      summary: 'SQL injection found.',
      confidence: 0.95,
    });

    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          return jsonReply({
            oldString: "const q = 'SELECT * FROM users WHERE id=' + id;",
            newString: "const q = 'SELECT * FROM users WHERE id=?'; const params = [id];",
            description: 'Switched to a parameterized query.',
          });
        }
        return jsonReply(passOutput('sec'));
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const result = await runBreakerBuilderLoop({ aggregator, llm: provider, model: 'm', cwd: tmpRoot, maxIterations: 5 });

    expect(result.outcome).toBe('resolved');
    expect(result.fixAttempts).toHaveLength(1);
    expect(result.fixAttempts[0].fixerStage).toBe('llm');
    expect(aggregator.getRoleOutput('sec')?.verdict).toBe('pass');
    const content = await fs.readFile(path.join(tmpRoot, 'app.ts'), 'utf-8');
    expect(content).toContain('const params = [id]');
  });
});

describe('runBreakerBuilderLoop — never stages its own edits (traceability)', () => {
  it('leaves the git index exactly as the user left it — the AI\'s fix stays unstaged', async () => {
    const git = simpleGit({ baseDir: tmpRoot });
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), "const q = 'SELECT * FROM users WHERE id=' + id;\n", 'utf-8');
    await git.add('app.ts');
    await git.commit('initial'); // gives HEAD a real commit for this test

    // Simulate the user having separately staged an unrelated file — this
    // must remain staged, untouched, after the fix loop runs.
    await fs.writeFile(path.join(tmpRoot, 'unrelated.ts'), 'export const y = 1;\n', 'utf-8');
    await git.add('unrelated.ts');

    // The user's own in-review change to app.ts — staged, exactly what a
    // real `codexrev review scan --fix` would see as the diff under review.
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), "const q = 'SELECT * FROM users WHERE id=' + userId;\n", 'utf-8');
    await git.add('app.ts');

    const statusBefore = await git.status();
    expect(statusBefore.staged).toEqual(expect.arrayContaining(['app.ts', 'unrelated.ts']));

    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [
        { id: 'sec-1', severity: 'critical', cwe: 'CWE-89', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'SQL injection.' },
      ],
      summary: 'SQL injection found.',
      confidence: 0.95,
    });

    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          return jsonReply({
            oldString: "const q = 'SELECT * FROM users WHERE id=' + userId;",
            newString: 'const q = "SELECT * FROM users WHERE id=?"; const params = [userId];',
            description: 'Switched to a parameterized query.',
          });
        }
        return jsonReply(passOutput('sec'));
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const result = await runBreakerBuilderLoop({ aggregator, llm: provider, model: 'm', cwd: tmpRoot, maxIterations: 5 });
    expect(result.outcome).toBe('resolved');
    expect(result.fixAttempts).toHaveLength(1);

    // The fix landed on disk...
    const content = await fs.readFile(path.join(tmpRoot, 'app.ts'), 'utf-8');
    expect(content).toContain('const params = [userId]');

    // ...but the index is untouched: still exactly what the user staged
    // themselves (the pre-fix version of app.ts, plus unrelated.ts) — the
    // AI's edit shows up only as an unstaged working-tree change.
    const statusAfter = await git.status();
    expect(statusAfter.staged).toEqual(expect.arrayContaining(['app.ts', 'unrelated.ts']));
    expect(statusAfter.not_added.includes('app.ts') || statusAfter.modified.includes('app.ts')).toBe(true);
  });
});

describe('runBreakerBuilderLoop — works on a brand-new repo with no commits yet', () => {
  it('resolves correctly when HEAD does not exist (everything staged, nothing ever committed)', async () => {
    const git = simpleGit({ baseDir: tmpRoot });
    // No commit at all — HEAD does not resolve to anything yet.
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), "const q = 'SELECT * FROM users WHERE id=' + id;\n", 'utf-8');
    await git.add('app.ts');

    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [
        { id: 'sec-1', severity: 'critical', cwe: 'CWE-89', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'SQL injection.' },
      ],
      summary: 'SQL injection found.',
      confidence: 0.95,
    });

    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          return jsonReply({
            oldString: "const q = 'SELECT * FROM users WHERE id=' + id;",
            newString: 'const q = "SELECT * FROM users WHERE id=?"; const params = [id];',
            description: 'Switched to a parameterized query.',
          });
        }
        return jsonReply(passOutput('sec'));
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const result = await runBreakerBuilderLoop({ aggregator, llm: provider, model: 'm', cwd: tmpRoot, maxIterations: 5 });
    expect(result.outcome).toBe('resolved');
    const content = await fs.readFile(path.join(tmpRoot, 'app.ts'), 'utf-8');
    expect(content).toContain('const params = [id]');
  });
});

describe('runBreakerBuilderLoop — escalation', () => {
  it('escalates after 1 iteration when neither fixer can produce a fix', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), 'const x = 1;\n', 'utf-8');

    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'dev',
      verdict: 'block',
      findings: [{ id: 'dev-1', severity: 'high', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'Some unfixable design issue.' }],
      summary: 'bad design',
      confidence: 0.9,
    });

    const decliningProvider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          return jsonReply({ oldString: null, newString: null, description: 'Cannot safely fix this.' });
        }
        return jsonReply(passOutput('dev'));
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const result = await runBreakerBuilderLoop({ aggregator, llm: decliningProvider, model: 'm', cwd: tmpRoot, maxIterations: 5 });
    expect(result.outcome).toBe('escalated');
    expect(result.iterations).toBe(1);
    expect(result.fixAttempts).toEqual([]);
    expect(result.unresolvedFindings).toHaveLength(1);
  });

  it('respects the per-file retry cap and escalates once it is exhausted', async () => {
    await fs.writeFile(path.join(tmpRoot, 'x.ts'), 'const bad = 1; // TARGET_LINE\n', 'utf-8');

    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [{ id: 'sec-1', severity: 'high', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'still broken' }],
      summary: 'still broken',
      confidence: 0.9,
    });

    // A deliberately no-op "fix" (oldString === newString) — this test is
    // purely about exercising the retry-cap mechanics deterministically,
    // not about realistic LLM behavior: the fix always "succeeds" (the
    // edit tool applies it) but the re-run role keeps reporting the SAME
    // finding as still blocking, forcing the retry cap to actually bind.
    const stuckProvider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          return jsonReply({ oldString: '// TARGET_LINE', newString: '// TARGET_LINE', description: 'no-op fix (test)' });
        }
        return jsonReply({
          role: 'sec',
          verdict: 'block',
          findings: [{ id: 'sec-1', severity: 'high', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'still broken' }],
          summary: 'still broken',
          confidence: 0.9,
        });
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const result = await runBreakerBuilderLoop({ aggregator, llm: stuckProvider, model: 'm', cwd: tmpRoot, maxIterations: 5 });

    expect(result.outcome).toBe('escalated');
    // 3 successful (no-op) fix attempts, then the 4th iteration's retry-cap
    // check skips the file entirely, applying nothing → escalates there.
    expect(result.fixAttempts).toHaveLength(MAX_RETRIES_PER_FILE);
    expect(result.iterations).toBe(MAX_RETRIES_PER_FILE + 1);
    expect(result.unresolvedFindings).toHaveLength(1);
  });

  it('escalates on hitting maxIterations while still blocking', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'const x = 1; // T1\n', 'utf-8');
    await fs.writeFile(path.join(tmpRoot, 'b.ts'), 'const y = 1; // T2\n', 'utf-8');

    // Two different files so the per-file retry cap (3) never binds within
    // 2 iterations — this isolates the maxIterations limit specifically.
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [
        { id: 'sec-1', severity: 'high', file: 'a.ts', lineStart: 1, lineEnd: 1, description: 'still broken a' },
        { id: 'sec-2', severity: 'high', file: 'b.ts', lineStart: 1, lineEnd: 1, description: 'still broken b' },
      ],
      summary: 'still broken',
      confidence: 0.9,
    });

    let callIndex = 0;
    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          callIndex++;
          const marker = callIndex % 2 === 1 ? '// T1' : '// T2';
          return jsonReply({ oldString: marker, newString: marker, description: 'no-op fix (test)' });
        }
        return jsonReply({
          role: 'sec',
          verdict: 'block',
          findings: [
            { id: 'sec-1', severity: 'high', file: 'a.ts', lineStart: 1, lineEnd: 1, description: 'still broken a' },
            { id: 'sec-2', severity: 'high', file: 'b.ts', lineStart: 1, lineEnd: 1, description: 'still broken b' },
          ],
          summary: 'still broken',
          confidence: 0.9,
        });
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const result = await runBreakerBuilderLoop({ aggregator, llm: provider, model: 'm', cwd: tmpRoot, maxIterations: 2 });
    expect(result.outcome).toBe('escalated');
    expect(result.iterations).toBe(2);
    expect(result.unresolvedFindings.length).toBeGreaterThan(0);
  });
});

describe('runBreakerBuilderLoop — interactive gate (LLM edits only)', () => {
  it('does NOT gate a deterministic fix, even with an interaction channel present', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'export function greet(name) {\n  return name;\n}\n', 'utf-8');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'build',
      verdict: 'block',
      findings: [
        { id: 'build-1', severity: 'high', file: 'a.ts', lineStart: 1, lineEnd: 1, description: "tsc TS7006: Parameter 'name' implicitly has an 'any' type." },
      ],
      summary: 'tsc error',
      confidence: 1,
    });

    let gateCalls = 0;
    const channel = new InteractionChannel();
    channel.onInteraction((event) => {
      if (event.type === 'stage_gate_request') {
        gateCalls++;
        channel.respondStageGate(event.request.id, 'continue');
      }
    });

    const unusedLlm: ILLMProvider = {
      id: 'openai',
      generate: () => {
        throw new Error('should not be called for a deterministic fix');
      },
      stream: () => {
        throw new Error('should not be called for a deterministic fix');
      },
    };

    await runBreakerBuilderLoop({ aggregator, llm: unusedLlm, model: 'm', cwd: tmpRoot, maxIterations: 5, interaction: channel });
    expect(gateCalls).toBe(0);
  }, 30_000);

  it('"skip" declines an LLM-generated edit — file stays unchanged', async () => {
    const original = "const q = 'SELECT * FROM users WHERE id=' + id;\n";
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), original, 'utf-8');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [{ id: 'sec-1', severity: 'critical', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'SQL injection.' }],
      summary: 'SQL injection',
      confidence: 0.9,
    });

    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          return jsonReply({
            oldString: "const q = 'SELECT * FROM users WHERE id=' + id;",
            newString: 'const q = "fixed";',
            description: 'fix',
          });
        }
        return jsonReply(passOutput('sec'));
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const channel = new InteractionChannel();
    channel.onInteraction((event) => {
      if (event.type === 'stage_gate_request') channel.respondStageGate(event.request.id, 'skip');
    });

    const result = await runBreakerBuilderLoop({ aggregator, llm: provider, model: 'm', cwd: tmpRoot, maxIterations: 5, interaction: channel });

    expect(result.outcome).toBe('escalated'); // nothing was applied this round
    const content = await fs.readFile(path.join(tmpRoot, 'app.ts'), 'utf-8');
    expect(content).toBe(original);
  });

  it('"abort" stops the loop immediately', async () => {
    const original = "const q = 'SELECT * FROM users WHERE id=' + id;\n";
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), original, 'utf-8');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [{ id: 'sec-1', severity: 'critical', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'SQL injection.' }],
      summary: 'SQL injection',
      confidence: 0.9,
    });

    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          return jsonReply({
            oldString: "const q = 'SELECT * FROM users WHERE id=' + id;",
            newString: 'const q = "fixed";',
            description: 'fix',
          });
        }
        return jsonReply(passOutput('sec'));
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const channel = new InteractionChannel();
    channel.onInteraction((event) => {
      if (event.type === 'stage_gate_request') channel.respondStageGate(event.request.id, 'abort');
    });

    const result = await runBreakerBuilderLoop({ aggregator, llm: provider, model: 'm', cwd: tmpRoot, maxIterations: 5, interaction: channel });
    expect(result.outcome).toBe('aborted');
    const content = await fs.readFile(path.join(tmpRoot, 'app.ts'), 'utf-8');
    expect(content).toBe(original);
  });
});

describe('runBreakerBuilderLoop — batched fix-confirm gate', () => {
  /** Sets up two files, each with one LLM-fixable blocking finding, from two different roles. */
  async function setUpTwoLlmFindings(): Promise<ContextAggregator> {
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), "const q = 'SELECT * FROM users WHERE id=' + id;\n", 'utf-8');
    await fs.writeFile(path.join(tmpRoot, 'greet.ts'), "return 'Hello, ' + name;\n", 'utf-8');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [{ id: 'sec-1', severity: 'critical', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'SQL injection.' }],
      summary: 'SQL injection',
      confidence: 0.9,
    });
    aggregator.addRoleOutput({
      role: 'qa',
      verdict: 'block',
      findings: [{ id: 'qa-1', severity: 'medium', file: 'greet.ts', lineStart: 1, lineEnd: 1, description: 'No null-name guard.' }],
      summary: 'missing guard',
      confidence: 0.9,
    });
    return aggregator;
  }

  const twoFileProvider: ILLMProvider = {
    id: 'openai',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      if (isEditGenCall(req)) {
        const text = (req.messages[0]?.parts[0] as { text: string }).text;
        if (text.includes('File: app.ts')) {
          return jsonReply({
            oldString: "const q = 'SELECT * FROM users WHERE id=' + id;",
            newString: 'const q = "fixed";',
            description: 'parameterize the query',
          });
        }
        return jsonReply({
          oldString: "return 'Hello, ' + name;",
          newString: "return 'Hello, ' + (name || 'stranger');",
          description: 'default to stranger',
        });
      }
      return jsonReply(passOutput((req.systemInstruction ?? '').includes('You are the Security Auditor') ? 'sec' : 'qa'));
    },
    async *stream() {
      yield { kind: 'finish', reason: 'stop' };
    },
  };

  it('asks exactly ONE gate decision for an iteration with multiple LLM-generated fixes', async () => {
    const aggregator = await setUpTwoLlmFindings();
    let gateCalls = 0;
    const channel = new InteractionChannel();
    channel.onInteraction((event) => {
      if (event.type === 'stage_gate_request') {
        gateCalls++;
        channel.respondStageGate(event.request.id, 'continue');
      }
    });

    const result = await runBreakerBuilderLoop({
      aggregator,
      llm: twoFileProvider,
      model: 'm',
      cwd: tmpRoot,
      maxIterations: 5,
      interaction: channel,
    });

    // One decision, but both fixes still land — batching a single gate
    // over N edits doesn't mean only the first edit gets applied.
    expect(gateCalls).toBe(1);
    expect(result.fixAttempts).toHaveLength(2);
    expect(await fs.readFile(path.join(tmpRoot, 'app.ts'), 'utf-8')).toContain('"fixed"');
    expect(await fs.readFile(path.join(tmpRoot, 'greet.ts'), 'utf-8')).toContain("|| 'stranger'");
  });

  it('reports every queued candidate via onFixBatchReady before the single gate fires', async () => {
    const aggregator = await setUpTwoLlmFindings();
    const channel = new InteractionChannel();
    channel.onInteraction((event) => {
      if (event.type === 'stage_gate_request') channel.respondStageGate(event.request.id, 'continue');
    });

    const batches: number[] = [];
    await runBreakerBuilderLoop({
      aggregator,
      llm: twoFileProvider,
      model: 'm',
      cwd: tmpRoot,
      maxIterations: 5,
      interaction: channel,
      onFixBatchReady: (candidates) => batches.push(candidates.length),
    });

    expect(batches).toEqual([2]);
  });

  it('"skip" on the batch gate declines every queued fix — both files stay unchanged', async () => {
    const aggregator = await setUpTwoLlmFindings();
    const channel = new InteractionChannel();
    channel.onInteraction((event) => {
      if (event.type === 'stage_gate_request') channel.respondStageGate(event.request.id, 'skip');
    });

    const result = await runBreakerBuilderLoop({
      aggregator,
      llm: twoFileProvider,
      model: 'm',
      cwd: tmpRoot,
      maxIterations: 5,
      interaction: channel,
    });

    expect(result.outcome).toBe('escalated');
    expect(result.fixAttempts).toHaveLength(0);
    expect(await fs.readFile(path.join(tmpRoot, 'app.ts'), 'utf-8')).not.toContain('"fixed"');
    expect(await fs.readFile(path.join(tmpRoot, 'greet.ts'), 'utf-8')).not.toContain("|| 'stranger'");
  });
});

describe('runBreakerBuilderLoop — de-duplicates findings that share a code location', () => {
  it(
    'generates exactly ONE fix for a location four roles all independently flagged, not four ' +
      '(reported live: BA/Dev/QA/PM all citing the same swapped Fibonacci init produced 4 near-duplicate proposals)',
    async () => {
      const original = 'let a = 1;\nlet b = 0;\n';
      await fs.writeFile(path.join(tmpRoot, 'fib.ts'), original, 'utf-8');
      const aggregator = new ContextAggregator(EMPTY_DIFF);

      // Four different roles, all blocking, all citing the SAME two lines
      // in the same file — realistic overlap, not identical ranges.
      const sameLocationRoles: Array<{ role: RoleOutput['role']; lineStart: number; lineEnd: number }> = [
        { role: 'ba', lineStart: 1, lineEnd: 2 },
        { role: 'dev', lineStart: 1, lineEnd: 2 },
        { role: 'qa', lineStart: 1, lineEnd: 1 },
        { role: 'pm', lineStart: 2, lineEnd: 2 },
      ];
      for (const { role, lineStart, lineEnd } of sameLocationRoles) {
        aggregator.addRoleOutput({
          role,
          verdict: 'block',
          findings: [{ id: `${role}-1`, severity: 'high', file: 'fib.ts', lineStart, lineEnd, description: `${role} says: swapped init values.` }],
          summary: 'swapped init values',
          confidence: 0.9,
        });
      }

      let generateEditCalls = 0;
      const provider: ILLMProvider = {
        id: 'openai',
        async generate(req: GenerateRequest): Promise<GenerateResponse> {
          if (isEditGenCall(req)) {
            generateEditCalls++;
            return jsonReply({ oldString: 'let a = 1;\nlet b = 0;', newString: 'let a = 0;\nlet b = 1;', description: 'swap init values' });
          }
          // Re-run happens for every one of the four originally-blocking
          // roles — reply as whichever role is actually being asked.
          const match = (req.systemInstruction ?? '').match(/"role":\s*"(\w+)"/);
          return jsonReply(passOutput((match?.[1] as RoleOutput['role']) ?? 'ba'));
        },
        async *stream() {
          yield { kind: 'finish', reason: 'stop' };
        },
      };

      const iterationCounts: number[] = [];
      const result = await runBreakerBuilderLoop({
        aggregator,
        llm: provider,
        model: 'm',
        cwd: tmpRoot,
        maxIterations: 5,
        onIterationStart: (_iteration, blockingFindingsCount) => iterationCounts.push(blockingFindingsCount),
      });

      // One representative location → one LLM call → one applied fix,
      // not four — even though FOUR roles' findings were blocking.
      expect(generateEditCalls).toBe(1);
      expect(result.fixAttempts).toHaveLength(1);
      expect(iterationCounts[0]).toBe(1);
      expect(await fs.readFile(path.join(tmpRoot, 'fib.ts'), 'utf-8')).toBe('let a = 0;\nlet b = 1;\n');
    },
  );

  it('does NOT dedupe findings on different files, or non-overlapping lines in the same file', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'let a = 1;\n', 'utf-8');
    await fs.writeFile(path.join(tmpRoot, 'b.ts'), 'let b = 1;\n', 'utf-8');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'ba',
      verdict: 'block',
      findings: [
        { id: 'ba-1', severity: 'high', file: 'a.ts', lineStart: 1, lineEnd: 1, description: 'issue in a.ts' },
        { id: 'ba-2', severity: 'high', file: 'b.ts', lineStart: 1, lineEnd: 1, description: 'issue in b.ts' },
      ],
      summary: 'two unrelated issues',
      confidence: 0.9,
    });

    const iterationCounts: number[] = [];
    await runBreakerBuilderLoop({
      aggregator,
      llm: {
        id: 'openai',
        async generate(req: GenerateRequest): Promise<GenerateResponse> {
          if (isEditGenCall(req)) return jsonReply({ oldString: null, newString: null, description: 'decline' });
          return jsonReply(passOutput('ba'));
        },
        async *stream() {
          yield { kind: 'finish', reason: 'stop' };
        },
      },
      model: 'm',
      cwd: tmpRoot,
      maxIterations: 1,
      onIterationStart: (_iteration, blockingFindingsCount) => iterationCounts.push(blockingFindingsCount),
    });

    // Two genuinely distinct locations — both must still get their own attempt.
    expect(iterationCounts[0]).toBe(2);
  });
});

describe('runBreakerBuilderLoop — callbacks', () => {
  it('fires onIterationStart, onFixCandidate, onFixAttempt, and onRoleRerun in order', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), "const q = 'SELECT * FROM users WHERE id=' + id;\n", 'utf-8');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({
      role: 'sec',
      verdict: 'block',
      findings: [{ id: 'sec-1', severity: 'critical', file: 'app.ts', lineStart: 1, lineEnd: 1, description: 'SQL injection.' }],
      summary: 'SQL injection',
      confidence: 0.9,
    });

    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (isEditGenCall(req)) {
          return jsonReply({
            oldString: "const q = 'SELECT * FROM users WHERE id=' + id;",
            newString: 'const q = "fixed";',
            description: 'fix',
          });
        }
        return jsonReply(passOutput('sec'));
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const events: string[] = [];
    await runBreakerBuilderLoop({
      aggregator,
      llm: provider,
      model: 'm',
      cwd: tmpRoot,
      maxIterations: 5,
      onIterationStart: () => events.push('iteration_start'),
      onFixCandidate: () => events.push('fix_candidate'),
      onFixAttempt: () => events.push('fix_attempt'),
      onRoleRerun: () => events.push('role_rerun'),
    });

    expect(events).toEqual(['iteration_start', 'fix_candidate', 'fix_attempt', 'role_rerun']);
  });
});
