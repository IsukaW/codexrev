import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyEditsAtomically, asksOnlyForTests, collectActionableFindings, groupFixTasks, isTestFile, runBreakerBuilderLoop, splitTemporaryTests } from '../../../src/features/review-pipeline/pipeline/breakerBuilderLoop.js';
import { ContextAggregator } from '../../../src/features/review-pipeline/pipeline/contextAggregator.js';
import { runFixAgent, type FixTask } from '../../../src/features/review-pipeline/pipeline/fixAgent.js';
import { createSandbox } from '../../../src/features/review-pipeline/pipeline/fixSandbox.js';
import { compareValidation, detectTestCommand, runValidation, type ValidationSnapshot } from '../../../src/features/review-pipeline/pipeline/fixValidator.js';
import { findLocalTscBinary, parseJsonc, resolveTscReferencedProjects, runBuildRole } from '../../../src/features/review-pipeline/roles/build.js';
import { readDiff, type ParsedDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { GenerateRequest, GenerateResponse } from '../../../src/core/types.js';
import type { Finding, RoleOutput } from '../../../src/features/review-pipeline/roles/roleContract.js';

const EMPTY_DIFF: ParsedDiff = { ref: 'staged', raw: '', files: [] };
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

let tmpRoot: string;

// keep this file's sandboxes in a directory of its own so test files running in parallel don't show up in leftover checks
const realTmpdir = process.env.TMPDIR;
let privateTmp: string;
beforeAll(async () => {
  privateTmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-robust-tmp-')));
  process.env.TMPDIR = privateTmp;
});
afterAll(async () => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  await fs.rm(privateTmp, { recursive: true, force: true });
});

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-robust-')));
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 't@t.dev');
  await git.addConfig('user.name', 'Test');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ── scripted LLM ────────────────────────────────────────────────────────────

type Step = { tool: string; args: Record<string, unknown> } | string; // a tool call, or the final text

const textReply = (text: string): GenerateResponse => ({
  message: { role: 'assistant', parts: [{ kind: 'text', text }] },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  finishReason: 'completed',
});

const toolReply = (tool: string, args: Record<string, unknown>, n: number): GenerateResponse => ({
  message: { role: 'assistant', parts: [{ kind: 'tool_call', id: `call-${n}`, name: tool, arguments: args }] },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  finishReason: 'tool_calls' as GenerateResponse['finishReason'],
});

interface Script {
  /** one list of steps per fixer conversation (attempt) */
  readonly agent: readonly (readonly Step[])[];
  readonly role: (role: string, nth: number) => RoleOutput;
  /** called on every LLM call — lets a test observe the REAL project while a fix is being tried */
  readonly onCall?: () => Promise<void>;
}

function scriptedLlm(script: Script): { llm: ILLMProvider; roleCalls: string[]; agentConversations: () => number } {
  const roleCalls: string[] = [];
  let conversation = -1;
  const llm: ILLMProvider = {
    id: 'openai',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      await script.onCall?.();
      const sys = req.systemInstruction ?? '';
      if (sys.includes('You are the Fixer')) {
        if (req.messages.length === 1) conversation++;
        const steps = script.agent[Math.min(conversation, script.agent.length - 1)]!;
        const toolTurns = req.messages.filter((m) => m.role === 'tool').length;
        const step = steps[toolTurns] ?? '{"status":"cannot_fix","description":"script exhausted"}';
        return typeof step === 'string' ? textReply(step) : toolReply(step.tool, step.args, toolTurns);
      }
      const role = /"role": "(\w+)"/.exec(sys)?.[1] ?? 'unknown';
      roleCalls.push(role);
      return textReply(JSON.stringify(script.role(role, roleCalls.filter((r) => r === role).length)));
    },
    async *stream() {
      yield { kind: 'finish', reason: 'stop' };
    },
  };
  return { llm, roleCalls, agentConversations: () => conversation + 1 };
}

const pass = (role: string): RoleOutput => ({ role: role as RoleOutput['role'], verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 });
const finding = (id: string, file = 'app.js'): Finding => ({ id, severity: 'high', file, lineStart: 1, lineEnd: 1, description: `problem ${id}` });
const blocking = (role: string, id: string, file = 'app.js'): RoleOutput => ({
  role: role as RoleOutput['role'],
  verdict: 'block',
  findings: [finding(id, file)],
  summary: 'blocks',
  confidence: 0.9,
});
const FIXED = '{"status":"fixed","description":"done"}';

async function sandboxLeftovers(): Promise<string[]> {
  return (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('codexrev-sandbox-'));
}

// ── sandbox ─────────────────────────────────────────────────────────────────

describe('createSandbox', () => {
  it('copies the working tree, skips heavy dirs, links node_modules, and cleanup never touches the real node_modules', async () => {
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'node_modules/pkg'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'src/a.ts'), 'uncommitted change\n');
    await fs.writeFile(path.join(tmpRoot, 'node_modules/pkg/index.js'), 'dep\n');
    await fs.writeFile(path.join(tmpRoot, 'dist/out.js'), 'built\n');

    const sandbox = await createSandbox(tmpRoot);
    expect(await fs.readFile(path.join(sandbox.dir, 'src/a.ts'), 'utf-8')).toBe('uncommitted change\n');
    await expect(fs.access(path.join(sandbox.dir, 'dist'))).rejects.toThrow();
    await expect(fs.access(path.join(sandbox.dir, '.git'))).rejects.toThrow();
    expect((await fs.lstat(path.join(sandbox.dir, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(sandbox.dir, 'node_modules/pkg/index.js'), 'utf-8')).toBe('dep\n');

    await sandbox.cleanup();
    await expect(fs.access(sandbox.dir)).rejects.toThrow();
    expect(await fs.readFile(path.join(tmpRoot, 'node_modules/pkg/index.js'), 'utf-8')).toBe('dep\n'); // symlink unlinked, target intact
  });
});

// ── validation ──────────────────────────────────────────────────────────────

describe('compareValidation', () => {
  const snap = (over: Partial<ValidationSnapshot> = {}): ValidationSnapshot => ({
    buildErrorKeys: [],
    buildVerified: true,
    buildSummary: '',
    tests: { status: 'pass', command: 'npm test', output: '' },
    ...over,
  });

  it('accepts a fix that changes nothing for the worse', () => {
    expect(compareValidation(snap(), snap()).acceptable).toBe(true);
  });
  it('rejects new build errors but ignores ones that already existed', () => {
    const base = snap({ buildErrorKeys: ['a.ts|old error'] });
    expect(compareValidation(base, snap({ buildErrorKeys: ['a.ts|old error'] })).acceptable).toBe(true);
    const verdict = compareValidation(base, snap({ buildErrorKeys: ['a.ts|old error', 'b.ts|new error'] }));
    expect(verdict.acceptable).toBe(false);
    expect(verdict.reasons[0]).toContain('new error');
  });
  it('rejects tests that passed before and fail now', () => {
    expect(compareValidation(snap(), snap({ tests: { status: 'fail', command: 'npm test', output: 'boom' } })).acceptable).toBe(false);
  });
  it('does not gate on tests that were already failing, and says so', () => {
    const failing = snap({ tests: { status: 'fail', command: 'npm test', output: 'x' } });
    const verdict = compareValidation(failing, failing);
    expect(verdict.acceptable).toBe(true);
    expect(verdict.notes.join(' ')).toContain('already failing');
  });
});

describe('runValidation', () => {
  it('runs the project tests for real and reports pass/fail', async () => {
    await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
    await fs.writeFile(path.join(tmpRoot, 'test.js'), "process.exit(require('fs').readFileSync('app.js','utf8').includes('BAD') ? 1 : 0);");
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'fine\n');
    expect((await detectTestCommand(tmpRoot))?.label).toBe('npm test');
    expect((await runValidation(tmpRoot, EMPTY_DIFF)).tests.status).toBe('pass');
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'BAD\n');
    expect((await runValidation(tmpRoot, EMPTY_DIFF)).tests.status).toBe('fail');
  }, 60_000);

  it('ignores npm\'s placeholder test script', async () => {
    await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(await detectTestCommand(tmpRoot)).toBeNull();
  });
});

// ── Build role: the vacuous-pass bugs found on a real Vite project ──────────

describe('Build role — TypeScript project discovery', () => {
  it('parses tsconfig-style JSON with comments and trailing commas', () => {
    expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1, 2,], }')).toEqual({ a: 'http://x', b: [1, 2] });
  });

  it('detects a solution-style tsconfig (files: [] + references) and lists the referenced projects', async () => {
    await fs.writeFile(path.join(tmpRoot, 'tsconfig.json'), '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./missing.json" }] }');
    await fs.writeFile(path.join(tmpRoot, 'tsconfig.app.json'), '{}');
    expect(await resolveTscReferencedProjects(tmpRoot)).toEqual(['./tsconfig.app.json']);
  });

  it('leaves an ordinary tsconfig alone', async () => {
    await fs.writeFile(path.join(tmpRoot, 'tsconfig.json'), '{ "include": ["src"], "references": [{ "path": "./x" }] }');
    expect(await resolveTscReferencedProjects(tmpRoot)).toEqual([]);
  });

  it('really type-checks a solution-style project (a plain `tsc --noEmit` there checks zero files and always passes)', async () => {
    await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'dir');
    await fs.mkdir(path.join(tmpRoot, 'src'));
    await fs.writeFile(path.join(tmpRoot, 'tsconfig.json'), '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }');
    await fs.writeFile(
      path.join(tmpRoot, 'tsconfig.app.json'),
      '{ "compilerOptions": { "noEmit": true, "strict": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler" }, "include": ["src"] }',
    );
    await fs.writeFile(path.join(tmpRoot, 'src/a.ts'), "export const n: number = 'not a number';\n");

    expect(await findLocalTscBinary(tmpRoot)).toContain('node_modules/.bin/tsc');
    const out = await runBuildRole({ llm: {} as ILLMProvider, model: '', diff: EMPTY_DIFF, aggregator: new ContextAggregator(EMPTY_DIFF), cwd: tmpRoot });
    expect(out.verdict).toBe('block');
    expect(out.findings.some((f) => f.description.includes('TS2322'))).toBe(true);
    expect(out.summary).toContain('solution-style');
  }, 60_000);

  it('says so (flag, not a silent pass) when TypeScript is not installed', async () => {
    await fs.writeFile(path.join(tmpRoot, 'tsconfig.json'), '{ "include": ["src"] }');
    const out = await runBuildRole({ llm: {} as ILLMProvider, model: '', diff: EMPTY_DIFF, aggregator: new ContextAggregator(EMPTY_DIFF), cwd: tmpRoot });
    // (an ancestor of the temp dir could in theory hold a node_modules; accept either honest outcome)
    if (out.verdict === 'flag') expect(out.findings[0]!.description).toContain('not installed');
    else expect(out.verdict).toBe('pass');
  });
});

// ── fixer agent ─────────────────────────────────────────────────────────────

describe('runFixAgent', () => {
  const task = (): FixTask => ({ findings: [{ role: 'dev', finding: finding('dev-1') }], otherBlocking: [] });

  it('edits several files, records them, and rollback restores everything (including deleting created files)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'one\n');
    await fs.writeFile(path.join(tmpRoot, 'other.js'), 'two\n');
    const { llm } = scriptedLlm({
      agent: [[
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'one', new_string: 'ONE' } },
        { tool: 'edit', args: { file_path: 'other.js', old_string: 'two', new_string: 'TWO' } },
        { tool: 'write_file', args: { file_path: 'tests/app.test.js', content: '// new test\n' } },
        FIXED,
      ]],
      role: pass,
    });
    const outcome = await runFixAgent(task(), { llm, model: 'm', sandboxDir: tmpRoot });
    expect(outcome?.edits.map((e) => `${e.kind}:${e.file}`)).toEqual(['edit:app.js', 'edit:other.js', 'write:tests/app.test.js']);
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('ONE\n');
    expect(await fs.readFile(path.join(tmpRoot, 'tests/app.test.js'), 'utf-8')).toBe('// new test\n');

    await outcome!.rollback();
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('one\n');
    expect(await fs.readFile(path.join(tmpRoot, 'other.js'), 'utf-8')).toBe('two\n');
    await expect(fs.access(path.join(tmpRoot, 'tests/app.test.js'))).rejects.toThrow();
  });

  it('refuses paths outside the project, node_modules, .git and lockfiles — the model gets an error, nothing is written', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'one\n');
    await fs.mkdir(path.join(tmpRoot, 'node_modules'));
    const outside = path.join(os.tmpdir(), `codexrev-escape-${process.pid}.txt`);
    const { llm } = scriptedLlm({
      agent: [[
        { tool: 'write_file', args: { file_path: '../escape.txt', content: 'x' } },
        { tool: 'write_file', args: { file_path: outside, content: 'x' } },
        { tool: 'write_file', args: { file_path: 'node_modules/evil.js', content: 'x' } },
        { tool: 'write_file', args: { file_path: 'package-lock.json', content: '{}' } },
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'one', new_string: 'ok' } },
        FIXED,
      ]],
      role: pass,
    });
    const outcome = await runFixAgent(task(), { llm, model: 'm', sandboxDir: tmpRoot });
    expect(outcome?.edits).toHaveLength(1);
    await expect(fs.access(path.join(tmpRoot, '..', 'escape.txt'))).rejects.toThrow();
    await expect(fs.access(outside)).rejects.toThrow();
    await expect(fs.access(path.join(tmpRoot, 'node_modules/evil.js'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpRoot, 'package-lock.json'))).rejects.toThrow();
  });

  it('rejects an ambiguous old_string and inserts replacement text literally ("$&" is not special)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'foo\nfoo\nbar\n');
    const { llm } = scriptedLlm({
      agent: [[
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'foo', new_string: 'X' } }, // appears twice → error, no edit
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'bar', new_string: "a$&b$'c" } },
        FIXED,
      ]],
      role: pass,
    });
    const outcome = await runFixAgent(task(), { llm, model: 'm', sandboxDir: tmpRoot });
    expect(outcome?.edits).toHaveLength(1);
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe("foo\nfoo\na$&b$'c\n");
  });

  it('returns null (and changes nothing) when the agent makes no edits or declines', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'one\n');
    const { llm } = scriptedLlm({ agent: [['{"status":"cannot_fix","description":"unsure"}']], role: pass });
    expect(await runFixAgent(task(), { llm, model: 'm', sandboxDir: tmpRoot })).toBeNull();
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('one\n');
  });
});

describe('applyEditsAtomically / groupFixTasks', () => {
  it('applies none of a multi-file fix when one edit cannot apply', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.js'), 'a\n');
    await fs.writeFile(path.join(tmpRoot, 'b.js'), 'b\n');
    const outcome = await applyEditsAtomically(
      tmpRoot,
      [
        { kind: 'edit', file: 'a.js', oldString: 'a', newString: 'A' },
        { kind: 'edit', file: 'b.js', oldString: 'does not exist', newString: 'B' },
      ],
      'x',
    );
    expect(outcome).toBeNull();
    expect(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf-8')).toBe('a\n');
  });

  it('puts every finding into ONE fixer task (root causes span files); splits only a very large set, by file', () => {
    const b = (id: string, file: string) => ({ role: 'dev' as const, finding: finding(id, file) });
    const tasks = groupFixTasks([b('1', 'x.ts'), b('2', 'y.ts'), b('3', 'x.ts')]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.findings.map((f) => f.finding.id)).toEqual(['1', '2', '3']);
    expect(groupFixTasks([b('1', 'x.ts'), b('3', 'x.ts')], true)).toHaveLength(2); // single-edit fallback: one per finding

    const many = Array.from({ length: 30 }, (_, i) => b(`f${i}`, `file${i % 3}.ts`));
    const split = groupFixTasks(many);
    expect(split.length).toBeGreaterThan(1);
    for (const t of split) {
      expect(t.findings.length).toBeLessThanOrEqual(20);
      // a file's findings never straddle two tasks
      const files = new Set(t.findings.map((f) => f.finding.file));
      for (const other of split.filter((o) => o !== t)) expect(other.findings.some((f) => files.has(f.finding.file))).toBe(false);
    }
  });

  it('collects block findings plus medium+ flags, skipping the Director, low/info and Build environment gaps', () => {
    const agg = new ContextAggregator(EMPTY_DIFF);
    agg.addRoleOutput(blocking('architect', 'arch-1'));
    agg.addRoleOutput({ role: 'qa', verdict: 'flag', confidence: 0.9, summary: 's', findings: [{ ...finding('qa-1'), severity: 'low' }, { ...finding('qa-2'), severity: 'medium' }] });
    agg.addRoleOutput({ role: 'build', verdict: 'flag', confidence: 1, summary: 's', findings: [{ ...finding('b-1'), severity: 'medium', description: 'Could not run "tsc" in this environment: x' }] });
    agg.addRoleOutput({ role: 'pm', verdict: 'flag', confidence: 0.9, summary: 's', findings: [{ ...finding('pm-1'), severity: 'medium' }] });
    expect(collectActionableFindings(agg, false).map((f) => f.finding.id)).toEqual(['arch-1']);
    expect(collectActionableFindings(agg, true).map((f) => f.finding.id)).toEqual(['arch-1', 'qa-2']); // most severe first
  });
});

// ── the loop, robust mode ───────────────────────────────────────────────────

describe('runBreakerBuilderLoop — robust mode', () => {
  async function project(): Promise<void> {
    await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
    await fs.writeFile(path.join(tmpRoot, 'test.js'), "process.exit(require('fs').readFileSync('app.js','utf8').includes('BAD') ? 1 : 0);");
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'buggy\n');
  }

  it('rejects a fix that breaks the tests (the real project never sees it), retries with the failure as feedback, then applies the good one and re-checks with all roles', async () => {
    await project();
    const before = await sandboxLeftovers();
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blocking('dev', 'dev-1'));

    const seenByRealProject: string[] = [];
    const { llm, roleCalls } = scriptedLlm({
      agent: [
        [{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'BAD' } }, FIXED],
        [{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } }, FIXED],
      ],
      role: pass,
      onCall: async () => {
        seenByRealProject.push(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8'));
      },
    });

    const result = await runBreakerBuilderLoop({
      aggregator, llm, model: 'm', cwd: tmpRoot, maxIterations: 3,
      finalVerification: true, agent: true, validate: true, validationOptions: { testTimeoutMs: 60_000 },
    });

    expect(result.outcome).toBe('resolved');
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('fixed\n');
    expect(seenByRealProject.some((c) => c.includes('BAD'))).toBe(false);
    expect(result.fixAttempts).toHaveLength(1);
    expect(result.fixAttempts[0]!.newString).toBe('fixed');
    expect(result.notes?.join(' ')).toMatch(/rejected by the checks and rolled back: .*tests passed before/);
    // the full verification pass ran every LLM role on the final code
    for (const role of ['ba', 'architect', 'dev', 'qa', 'pm']) expect(roleCalls).toContain(role);
    // and nothing is left behind in the temp dir
    expect((await sandboxLeftovers()).filter((n) => !before.includes(n))).toEqual([]);
  }, 120_000);

  it('does NOT report "resolved" when the full re-check disagrees with the cheap one (the stale-verdict bug)', async () => {
    // BA's "flag" describes the code BEFORE the fix; dev's re-run passes; BA blocks the moment it is asked again.
    const run = async (finalVerification: boolean) => {
      await fs.writeFile(path.join(tmpRoot, 'app.js'), 'buggy\n');
      await fs.writeFile(path.join(tmpRoot, 'package.json'), '{}');
      const aggregator = new ContextAggregator(EMPTY_DIFF);
      aggregator.addRoleOutput({ role: 'ba', verdict: 'flag', findings: [], summary: 'stale — judged the code before the fix', confidence: 0.9 });
      aggregator.addRoleOutput(blocking('dev', 'dev-1'));
      const { llm } = scriptedLlm({
        agent: [[{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } }, FIXED]],
        role: (role, nth) => (role === 'ba' && nth === 1 ? blocking('ba', 'ba-1') : pass(role)),
      });
      const result = await runBreakerBuilderLoop({ aggregator, llm, model: 'm', cwd: tmpRoot, maxIterations: 1, agent: true, finalVerification });
      return { result, aggregator };
    };

    // old behaviour: only the blocking roles are re-run, so the stale BA flag survives and the loop says "resolved"
    const cheap = await run(false);
    expect(cheap.result.outcome).toBe('resolved');
    expect(cheap.aggregator.getRoleOutput('ba')?.verdict).toBe('flag');

    // with the full re-check the loop sees what a fresh `review scan` would see
    const full = await run(true);
    expect(full.result.outcome).toBe('escalated');
    expect(full.result.unresolvedFindings.map((f) => f.id)).toEqual(['ba-1']);
    expect(full.aggregator.getRoleOutput('ba')?.verdict).toBe('block'); // fresh verdict replaced the stale flag
  });

  it('keeps going when the full re-check finds something new, and resolves once that is fixed too', async () => {
    await project();
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blocking('dev', 'dev-1'));

    const { llm } = scriptedLlm({
      agent: [
        [{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed1' } }, FIXED],
        [{ tool: 'edit', args: { file_path: 'app.js', old_string: 'fixed1', new_string: 'fixed2' } }, FIXED],
      ],
      role: (role, nth) => (role === 'ba' && nth === 1 ? blocking('ba', 'ba-1') : pass(role)),
    });
    const result = await runBreakerBuilderLoop({
      aggregator, llm, model: 'm', cwd: tmpRoot, maxIterations: 3,
      finalVerification: true, agent: true,
    });
    expect(result.outcome).toBe('resolved');
    expect(result.fixAttempts.map((f) => f.newString)).toEqual(['fixed1', 'fixed2']);
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('fixed2\n');
  });

  it('applies a multi-file fix (code + test) as one unit and reports each edit', async () => {
    await project();
    await fs.writeFile(path.join(tmpRoot, 'other.js'), 'caller\n');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blocking('dev', 'dev-1'));
    const { llm } = scriptedLlm({
      agent: [[
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } },
        { tool: 'edit', args: { file_path: 'other.js', old_string: 'caller', new_string: 'caller(fixed)' } },
        { tool: 'write_file', args: { file_path: 'app.test.js', content: '// covers the fix\n' } },
        FIXED,
      ]],
      role: pass,
    });
    const result = await runBreakerBuilderLoop({ aggregator, llm, model: 'm', cwd: tmpRoot, maxIterations: 2, finalVerification: true, agent: true });
    expect(result.outcome).toBe('resolved');
    expect(result.fixAttempts.map((f) => f.file)).toEqual(['app.js', 'other.js', 'app.test.js']);
    expect(await fs.readFile(path.join(tmpRoot, 'other.js'), 'utf-8')).toBe('caller(fixed)\n');
    expect(await fs.readFile(path.join(tmpRoot, 'app.test.js'), 'utf-8')).toBe('// covers the fix\n');
  });

  it('fixes medium findings from flagging roles in the SAME first pass, and re-reviews once (no extra partial pass)', async () => {
    await project();
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blocking('dev', 'dev-1'));
    aggregator.addRoleOutput({ role: 'qa', verdict: 'flag', confidence: 0.9, summary: 's', findings: [{ ...finding('qa-1', 'other.js'), severity: 'medium' }] });
    await fs.writeFile(path.join(tmpRoot, 'other.js'), 'untested\n');

    let fixerPrompt = '';
    const { llm, roleCalls, agentConversations } = scriptedLlm({
      agent: [[
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } },
        { tool: 'edit', args: { file_path: 'other.js', old_string: 'untested', new_string: 'tested' } },
        FIXED,
      ]],
      role: pass,
    });
    const spy: ILLMProvider = {
      ...llm,
      generate: async (req) => {
        if ((req.systemInstruction ?? '').includes('You are the Fixer') && req.messages.length === 1) {
          fixerPrompt = JSON.stringify(req.messages[0]);
        }
        return llm.generate(req);
      },
    };
    const result = await runBreakerBuilderLoop({
      aggregator, llm: spy, model: 'm', cwd: tmpRoot, maxIterations: 3,
      finalVerification: true, agent: true, fixAdvisory: true,
    });
    expect(result.outcome).toBe('resolved');
    expect(result.iterations).toBe(1);
    expect(agentConversations()).toBe(1); // both findings, one conversation
    expect(fixerPrompt).toContain('dev-1');
    expect(fixerPrompt).toContain('qa-1');
    expect(await fs.readFile(path.join(tmpRoot, 'other.js'), 'utf-8')).toBe('tested\n');
    // exactly one re-review: every LLM role once, nothing re-run twice
    expect([...roleCalls].sort()).toEqual(['architect', 'ba', 'dev', 'pm', 'qa']);
  });

  it('gives the fixer a run_checks tool so it repairs its own test breakage in the same conversation', async () => {
    await project();
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blocking('dev', 'dev-1'));
    const checkResults: string[] = [];
    const { llm, agentConversations } = scriptedLlm({
      agent: [[
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'BAD' } },
        { tool: 'run_checks', args: {} },
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'BAD', new_string: 'fixed' } },
        { tool: 'run_checks', args: {} },
        FIXED,
      ]],
      role: pass,
    });
    const spy: ILLMProvider = {
      ...llm,
      generate: async (req) => {
        const last = req.messages[req.messages.length - 1];
        if (last?.role === 'tool') {
          for (const p of last.parts) if (p.kind === 'tool_result' && p.name === 'run_checks') checkResults.push(JSON.stringify(p.content));
        }
        return llm.generate(req);
      },
    };
    const result = await runBreakerBuilderLoop({
      aggregator, llm: spy, model: 'm', cwd: tmpRoot, maxIterations: 2,
      finalVerification: true, agent: true, validate: true, validationOptions: { testTimeoutMs: 60_000 },
    });
    expect(checkResults).toHaveLength(2);
    expect(checkResults[0]).toContain('PROBLEMS');
    expect(checkResults[1]).toContain('OK');
    expect(agentConversations()).toBe(1); // no rejected attempt, no retry
    expect(result.outcome).toBe('resolved');
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('fixed\n');
  }, 120_000);

  it('stops chasing medium-only findings after the second round (each round is a full review), reporting what is left', async () => {
    await project();
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({ role: 'qa', verdict: 'flag', confidence: 0.9, summary: 's', findings: [{ ...finding('qa-0'), severity: 'medium' }] });
    let n = 0;
    const { llm } = scriptedLlm({
      // every round changes the file; QA always finds one more medium thing
      agent: [0, 1, 2, 3].map((i) => [{ tool: 'write_file', args: { file_path: 'app.js', content: `round ${i}\n` } }, FIXED] as const),
      role: (role) => (role === 'qa' ? { role: 'qa', verdict: 'flag', confidence: 0.9, summary: 's', findings: [{ ...finding(`qa-${++n}`), severity: 'medium' }] } : pass(role)),
    });
    const result = await runBreakerBuilderLoop({
      aggregator, llm, model: 'm', cwd: tmpRoot, maxIterations: 5,
      finalVerification: true, agent: true, fixAdvisory: true,
    });
    expect(result.outcome).toBe('resolved'); // nothing blocks
    expect(result.iterations).toBe(2);
    expect(result.notes?.join(' ')).toContain('medium finding(s) were still open');
  });
});

describe('runFixAgent — reads', () => {
  it('lets the fixer grep the whole project (path ".")', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'needle\n');
    const results: string[] = [];
    const { llm } = scriptedLlm({
      agent: [[{ tool: 'grep', args: { pattern: 'needle', path: '.' } }, { tool: 'edit', args: { file_path: 'app.js', old_string: 'needle', new_string: 'found' } }, FIXED]],
      role: pass,
    });
    const spy: ILLMProvider = {
      ...llm,
      generate: async (req) => {
        const last = req.messages[req.messages.length - 1];
        if (last?.role === 'tool') for (const p of last.parts) if (p.kind === 'tool_result') results.push(JSON.stringify(p.content));
        return llm.generate(req);
      },
    };
    await runFixAgent({ findings: [{ role: 'dev', finding: finding('d') }], otherBlocking: [] }, { llm: spy, model: 'm', sandboxDir: tmpRoot });
    expect(results[0]).toContain('app.js');
    expect(results[0]).not.toContain('outside the project');
  });
});

describe('temporary tests', () => {
  it('recognises test files across ecosystems', () => {
    for (const f of ['src/a.test.ts', 'src/a.spec.tsx', 'tests/x.js', 'src/__tests__/a.ts', 'pkg/a_test.go', 'tests/test_a.py', 'test_b.py']) expect(isTestFile(f)).toBe(true);
    for (const f of ['src/app.ts', 'src/contest.ts', 'src/latest/a.ts', 'README.md']) expect(isTestFile(f)).toBe(false);
  });

  it('recognises findings that only ask for more tests, but not defects that happen to mention tests', () => {
    const f = (description: string) => ({ ...finding('x'), description });
    expect(asksOnlyForTests(f('There is no test covering the new 100-char rule.'))).toBe(true);
    expect(asksOnlyForTests(f('TodoStats has zero behavioral coverage.'))).toBe(true);
    expect(asksOnlyForTests(f('The new rule is untested.'))).toBe(true);
    expect(asksOnlyForTests(f('The polling effect leaks its interval, and no test notices.'))).toBe(false);
    expect(asksOnlyForTests(f('Stale poll can revert a completed mutation (test missing too).'))).toBe(false);
    // deleting the suite is a defect in the change (undone by restoring the files), not a request for more tests
    expect(asksOnlyForTests(f('The diff deletes the entire test suite — app.test.js — with no replacement tests.'))).toBe(false);
  });

  it('keeps new test files out of the real project but keeps edits to tests that already exist', async () => {
    await fs.writeFile(path.join(tmpRoot, 'old.test.js'), 'old\n');
    const split = await splitTemporaryTests(
      [
        { kind: 'edit', file: 'app.js', oldString: 'a', newString: 'b' },
        { kind: 'write', file: 'new.test.js', oldString: '', newString: 'x' },
        { kind: 'edit', file: 'new.test.js', oldString: 'x', newString: 'y' },
        { kind: 'edit', file: 'old.test.js', oldString: 'old', newString: 'updated' },
        { kind: 'write', file: 'helper.js', oldString: '', newString: 'not a test' },
      ],
      tmpRoot,
    );
    expect(split.temporary.map((e) => e.file)).toEqual(['new.test.js', 'new.test.js']);
    expect(split.keep.map((e) => e.file)).toEqual(['app.js', 'old.test.js', 'helper.js']);
  });

  async function runWith(temporaryTests: boolean) {
    await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }));
    // the new test file is what proves the fix: the suite runs it if it exists
    await fs.writeFile(path.join(tmpRoot, 'check.js'), "const fs=require('fs');if(fs.existsSync('app.test.js')&&!fs.readFileSync('app.js','utf8').includes('fixed'))process.exit(1);");
    await fs.writeFile(path.join(tmpRoot, 'app.js'), 'buggy\n');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput(blocking('dev', 'dev-1'));
    const { llm } = scriptedLlm({
      agent: [[
        { tool: 'write_file', args: { file_path: 'app.test.js', content: '// proves the fix\n' } },
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } },
        FIXED,
      ]],
      role: pass,
    });
    const result = await runBreakerBuilderLoop({
      aggregator, llm, model: 'm', cwd: tmpRoot, maxIterations: 2,
      finalVerification: true, agent: true, validate: true, validationOptions: { testTimeoutMs: 60_000 }, temporaryTests,
    });
    return result;
  }

  it('applies only the production fix when tests are temporary, and says so', async () => {
    const result = await runWith(true);
    expect(result.outcome).toBe('resolved');
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('fixed\n');
    await expect(fs.access(path.join(tmpRoot, 'app.test.js'))).rejects.toThrow();
    expect(result.fixAttempts.map((f) => f.file)).toEqual(['app.js']);
    expect(result.notes?.join(' ')).toContain('1 new test file(s) were written to prove the fixes work and then discarded');
  }, 120_000);

  it('keeps them when asked to', async () => {
    const result = await runWith(false);
    expect(result.outcome).toBe('resolved');
    expect(await fs.readFile(path.join(tmpRoot, 'app.test.js'), 'utf-8')).toBe('// proves the fix\n');
    expect(result.fixAttempts.map((f) => f.file).sort()).toEqual(['app.js', 'app.test.js']);
  }, 120_000);

  it('does not send "add tests" findings to the fixer when tests are temporary', () => {
    const agg = new ContextAggregator(EMPTY_DIFF);
    agg.addRoleOutput({ role: 'qa', verdict: 'flag', confidence: 0.9, summary: 's', findings: [
      { ...finding('q1'), severity: 'medium', description: 'No test covers the new polling behavior.' },
      { ...finding('q2'), severity: 'medium', description: 'A stale poll can revert a completed mutation.' },
    ] });
    expect(collectActionableFindings(agg, true, false).map((f) => f.finding.id)).toEqual(['q1', 'q2']);
    expect(collectActionableFindings(agg, true, true).map((f) => f.finding.id)).toEqual(['q2']);
  });
});

// The run this guards against: a commit deleted the test suite, every role flagged it, the fixer
// rewrote the file as a "new" (temporary, discarded) test, and the loop went round again and
// escalated "with 0 blocking findings". Now the deletion is undone in the first pass.
describe('runBreakerBuilderLoop — a change that deletes test files', () => {
  const NO_TESTS = "const fs=require('fs');if(!fs.existsSync('app.test.js')){console.log('No test files found');process.exit(1)}require('./app.test.js');";
  const ORIGINAL_TEST = "process.exit(require('fs').readFileSync('app.js','utf8').includes('v1')?0:1);\n";

  // commit 1: app + its test; commit 2: the change under review deletes the test (and changes app.js to `appAfter`)
  async function history(appAfter: string): Promise<{ base: string; diff: ParsedDiff }> {
    const git = simpleGit({ baseDir: tmpRoot });
    await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }));
    await fs.writeFile(path.join(tmpRoot, 'check.js'), NO_TESTS);
    await fs.writeFile(path.join(tmpRoot, 'app.js'), '// v1 buggy\n');
    await fs.writeFile(path.join(tmpRoot, 'app.test.js'), ORIGINAL_TEST);
    await git.add('.');
    await git.commit('base');
    const base = (await git.revparse(['HEAD'])).trim();
    await fs.rm(path.join(tmpRoot, 'app.test.js'));
    await fs.writeFile(path.join(tmpRoot, 'app.js'), appAfter);
    await git.add('.');
    await git.commit('the change');
    return { base, diff: await readDiff(tmpRoot, base) };
  }

  function flagged(diff: ParsedDiff): ContextAggregator {
    const aggregator = new ContextAggregator(diff);
    aggregator.addRoleOutput(blocking('dev', 'dev-1'));
    aggregator.addRoleOutput({ role: 'ba', verdict: 'flag', confidence: 0.9, summary: 's', findings: [
      { ...finding('ba-1', 'app.test.js'), severity: 'medium', description: 'The diff deletes the entire test suite (app.test.js) with no replacement tests.' },
    ] });
    return aggregator;
  }

  const run = (aggregator: ContextAggregator, llm: ILLMProvider, diffRef: string) =>
    runBreakerBuilderLoop({
      aggregator, llm, model: 'm', cwd: tmpRoot, diffRef, maxIterations: 3,
      finalVerification: true, agent: true, validate: true, fixAdvisory: true, temporaryTests: true, validationOptions: { testTimeoutMs: 60_000 },
    });

  it('restores the deleted test file in the first pass, keeps it, and resolves in ONE iteration', async () => {
    const { base, diff } = await history('// v1 buggy v2\n');
    const { llm, agentConversations } = scriptedLlm({
      agent: [[{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } }, FIXED]],
      role: pass,
    });
    const result = await run(flagged(diff), llm, base);

    expect(result.outcome).toBe('resolved');
    expect(result.iterations).toBe(1);
    expect(agentConversations()).toBe(1);
    expect(await fs.readFile(path.join(tmpRoot, 'app.test.js'), 'utf-8')).toBe(ORIGINAL_TEST);
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('// v1 fixed v2\n');
    expect(result.fixAttempts.map((f) => [f.file, f.fixerStage])).toEqual([['app.test.js', 'deterministic'], ['app.js', 'llm']]);
    expect(result.notes?.join(' ') ?? '').not.toMatch(/temporary|discarded/);
  }, 120_000);

  it('when the restored test fails against the changed code, the fixer updates it in the SAME pass and both land together', async () => {
    const { base, diff } = await history('// v2 buggy\n'); // the change renamed v1 → v2, so the old test fails
    let realTestDuringFix: string | null = 'unset';
    const { llm, agentConversations } = scriptedLlm({
      agent: [[
        { tool: 'edit', args: { file_path: 'app.test.js', old_string: "includes('v1')", new_string: "includes('v2')" } },
        { tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } },
        FIXED,
      ]],
      role: pass,
      onCall: async () => {
        realTestDuringFix = await fs.readFile(path.join(tmpRoot, 'app.test.js'), 'utf-8').catch(() => null);
      },
    });
    const result = await run(flagged(diff), llm, base);

    expect(result.outcome).toBe('resolved');
    expect(result.iterations).toBe(1);
    expect(agentConversations()).toBe(1);
    expect(await fs.readFile(path.join(tmpRoot, 'app.test.js'), 'utf-8')).toBe(ORIGINAL_TEST.replace('v1', 'v2'));
    expect(await fs.readFile(path.join(tmpRoot, 'app.js'), 'utf-8')).toBe('// v2 fixed\n');
    expect(realTestDuringFix).not.toBe(ORIGINAL_TEST); // the failing restored copy never reached the project on its own
  }, 120_000);

  it('leaves the deletion for a human (nothing half-applied) when the fixer cannot make the restored test pass', async () => {
    const { base, diff } = await history('// v2 buggy\n');
    const { llm } = scriptedLlm({
      agent: [[{ tool: 'edit', args: { file_path: 'app.js', old_string: 'buggy', new_string: 'fixed' } }, FIXED]],
      role: pass,
    });
    const result = await run(flagged(diff), llm, base);

    await expect(fs.access(path.join(tmpRoot, 'app.test.js'))).rejects.toThrow();
    expect(result.notes?.join(' ')).toMatch(/Restoring app\.test\.js was left for a human/);
  }, 120_000);

  it('reports "resolved", not "escalated with 0 blocking findings", when only advisory work was left and nothing could be applied', async () => {
    await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }));
    await fs.writeFile(path.join(tmpRoot, 'app.js'), '// ok\n');
    const aggregator = new ContextAggregator(EMPTY_DIFF);
    aggregator.addRoleOutput({ role: 'qa', verdict: 'flag', confidence: 0.9, summary: 's', findings: [
      { ...finding('qa-1'), severity: 'medium', description: 'A stale poll can revert a completed mutation.' },
    ] });
    const { llm } = scriptedLlm({
      agent: [[{ tool: 'write_file', args: { file_path: 'app.test.js', content: '// probe\n' } }, FIXED]],
      role: pass,
    });
    const result = await runBreakerBuilderLoop({
      aggregator, llm, model: 'm', cwd: tmpRoot, maxIterations: 3,
      finalVerification: true, agent: true, validate: true, fixAdvisory: true, temporaryTests: true, validationOptions: { testTimeoutMs: 60_000 },
    });
    expect(result.outcome).toBe('resolved');
    expect(result.unresolvedFindings).toEqual([]);
  }, 120_000);
});
