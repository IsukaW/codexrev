import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import type { SpecAnalysisResult } from '../../../src/features/living-spec/pipeline/types.js';
import type { ImplicationsLabelFile } from '../../../src/features/living-spec/pipeline/inferenceEngine.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import { reportsDir } from '../../../src/features/living-spec/tools/stateStore.js';
import type { GenerateResponse } from '../../../src/core/types.js';

let tmpRoot: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-specinfer-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function initRepo(): Promise<SimpleGit> {
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 'test@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Test');
  return git;
}

async function makeStagedRepo(): Promise<void> {
  const git = await initRepo();
  await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, 'src', 'greet.js'),
    'export function greet(name) {\n  return `hello ${name}`;\n}\n',
    'utf-8',
  );
  await git.add(['src/greet.js']);
  await git.commit('initial');
  await fs.writeFile(
    path.join(tmpRoot, 'src', 'greet.js'),
    'export function greet(name) {\n  return `hi ${name}`;\n}\n',
    'utf-8',
  );
  await git.add(['src/greet.js']);
}

function response(text: string): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    finishReason: 'stop',
  };
}

function goodPayload() {
  return {
    implications: [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The greeting must greet the caller with a short salutation.',
        rationale: 'The greeting literal changed from "hello" to "hi".',
        confidence: 0.88,
        sourceRefs: [{ path: 'src/greet.js', line: 2 }],
        category: 'behaviour',
      },
    ],
    behaviourChangeSummary: 'The greeting salutation changed from "hello" to "hi".',
    requiresUrsUpdate: true,
  };
}

function fakePort(text: string): LLMPort {
  return {
    provider: 'lmstudio',
    model: 'qwen2.5-coder',
    generate: async () => response(text),
  };
}

async function readReports(): Promise<{
  report: SpecAnalysisResult | null;
  label: ImplicationsLabelFile | null;
  reportNames: string[];
}> {
  let names: string[] = [];
  try {
    names = await fs.readdir(reportsDir(tmpRoot));
  } catch {
    names = [];
  }
  const labelName = names.find((n) => n.endsWith('.implications.json'));
  const reportName = names.find((n) => n.endsWith('.json') && !n.endsWith('.implications.json'));
  const report = reportName
    ? ((await fs.readFile(path.join(reportsDir(tmpRoot), reportName), 'utf-8')) as string)
    : null;
  const label = labelName
    ? ((await fs.readFile(path.join(reportsDir(tmpRoot), labelName), 'utf-8')) as string)
    : null;
  return {
    report: report ? (JSON.parse(report) as SpecAnalysisResult) : null,
    label: label ? (JSON.parse(label) as ImplicationsLabelFile) : null,
    reportNames: names,
  };
}

describe('codexrev spec analyze — implication inference wiring', () => {
  it('wires inferred implications, behaviour summary and quality into the report JSON', async () => {
    await makeStagedRepo();
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', model: 'qwen2.5-coder' },
      { llm: fakePort(JSON.stringify(goodPayload())) },
    );

    const { report } = await readReports();
    expect(report).not.toBeNull();
    const r = report as SpecAnalysisResult;

    expect(r.implications).toHaveLength(1);
    expect(r.implications[0]).toMatchObject({
      id: 'imp-1',
      kind: 'functional',
      text: expect.stringContaining('greet'),
      confidence: 0.88,
      rationale: expect.any(String),
      category: 'behaviour',
    });
    // sourceRefs mapped from {path,line} to the contract's "path:line" strings
    expect(r.implications[0].sourceRefs).toEqual(['src/greet.js:2']);

    expect(r.behaviourChangeSummary).toContain('hello');
    expect(r.requiresUrsUpdate).toBe(true);

    expect(r.quality.model).toBe('qwen2.5-coder');
    expect(r.quality.schemaValid).toBe(true);
    expect(r.quality.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.quality.usage).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });

    // deterministic fields carried through
    expect(r.files).toEqual([{ path: 'src/greet.js', lines: 2 }]);
    expect(r.changeId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits the evaluation-friendly labelled output next to the report', async () => {
    await makeStagedRepo();
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', model: 'qwen2.5-coder' },
      { llm: fakePort(JSON.stringify(goodPayload())) },
    );

    const { report, label, reportNames } = await readReports();
    expect(reportNames).toContain(`${(report as SpecAnalysisResult).changeId}.implications.json`);
    expect(label).not.toBeNull();
    const l = label as ImplicationsLabelFile;
    expect(l.schemaVersion).toBe(1);
    expect(l.ok).toBe(true);
    expect(l.model).toBe('qwen2.5-coder');
    expect(l.implications).toHaveLength(1);
    // labelled file keeps the MODEL shape: sourceRefs are {path,line} objects
    expect(l.implications[0].sourceRefs).toEqual([{ path: 'src/greet.js', line: 2 }]);
    expect(l.behaviourChangeSummary).toBeTruthy();
    expect(l.requiresUrsUpdate).toBe(true);
  });

  it('defaults to a local Qwen-family model and passes the --offline guard', async () => {
    await makeStagedRepo();
    // No --model/--provider: resolves to the local default; --offline is valid
    // because the default provider runs locally.
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', offline: true },
      { llm: fakePort(JSON.stringify(goodPayload())) },
    );

    const { label } = await readReports();
    const l = label as ImplicationsLabelFile;
    expect(l.ok).toBe(true);
    expect(l.provider).toBe('lmstudio');
    expect(l.model).toMatch(/qwen/i);
  });
});

describe('codexrev spec analyze — failure policy (prior state unchanged)', () => {
  it('keeps the prior deterministic report untouched and records a structured error on malformed output', async () => {
    await makeStagedRepo();
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text' },
      { llm: fakePort('this is not JSON at all') },
    );

    const { report, label } = await readReports();
    const r = report as SpecAnalysisResult;
    // prior authoritative state untouched: no implications applied
    expect(r.implications).toEqual([]);
    expect(r.behaviourChangeSummary).toBeNull();
    expect(r.requiresUrsUpdate).toBeNull();
    expect(r.quality).toEqual({
      model: 'heuristic',
      latencyMs: expect.any(Number),
      schemaValid: true,
    });
    expect(r.inferenceError).toMatchObject({ code: 'malformed_output', retryable: false });

    // labelled file records the failure for evaluation, with no fake implications
    const l = label as ImplicationsLabelFile;
    expect(l.ok).toBe(false);
    expect(l.implications).toEqual([]);
    expect(l.error?.code).toBe('malformed_output');
  });

  it('leaves prior state untouched on a schema-invalid payload', async () => {
    await makeStagedRepo();
    const bad = goodPayload();
    (bad.implications[0] as { confidence: number }).confidence = 1.5;
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text' },
      { llm: fakePort(JSON.stringify(bad)) },
    );

    const { report, label } = await readReports();
    const r = report as SpecAnalysisResult;
    expect(r.implications).toEqual([]);
    expect(r.quality.model).toBe('heuristic');
    expect(r.inferenceError).toMatchObject({ code: 'schema_invalid' });
    expect((label as ImplicationsLabelFile).ok).toBe(false);
    expect((label as ImplicationsLabelFile).error?.code).toBe('schema_invalid');
  });
});

describe('codexrev spec analyze — offline guard', () => {
  it('rejects a network provider when --offline is set', async () => {
    await makeStagedRepo();
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', offline: true, provider: 'openai', model: 'gpt-4o' },
      { llm: fakePort(JSON.stringify(goodPayload())) },
    );
    // offline violation surfaces as a user-facing error, nothing persisted
    const { reportNames } = await readReports();
    expect(reportNames).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
