import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import type {
  SpecAnalysisResult,
  SpecTestCaseDelta,
} from '../../../src/features/living-spec/pipeline/types.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import { reportsDir } from '../../../src/features/living-spec/tools/stateStore.js';
import type { GenerateResponse } from '../../../src/core/types.js';

/** Every field of the stable contract — each must be populated or null. */
const CONTRACT_FIELDS: ReadonlyArray<keyof SpecAnalysisResult> = [
  'changeId',
  'timestamp',
  'files',
  'implications',
  'driftStatus',
  'ursPatch',
  'testDeltas',
  'quality',
  'impactSummary',
  'driftAlerts',
  'behaviourChangeSummary',
  'requiresUrsUpdate',
  'inferenceError',
  'proposalIds',
];

let tmpRoot: string;
let logs: string[];

beforeEach(async () => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-contract-'));
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
  await git.add('src/greet.js');
  await git.commit('initial');
  await fs.writeFile(
    path.join(tmpRoot, 'src', 'greet.js'),
    'export function greet(name) {\n  return `hi ${name}`;\n}\n',
    'utf-8',
  );
  await git.add('src/greet.js');
}

function response(text: string): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  };
}

function fakePort(text: string): LLMPort {
  return { provider: 'lmstudio', model: 'm', generate: async () => response(text) };
}

function payload() {
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

async function readReport(): Promise<SpecAnalysisResult> {
  const names = (await fs.readdir(reportsDir(tmpRoot)).catch(() => [] as string[])).filter(
    (n) => n.endsWith('.json') && !n.endsWith('.implications.json'),
  );
  expect(names).toHaveLength(1);
  return JSON.parse(
    await fs.readFile(path.join(reportsDir(tmpRoot), names[0]), 'utf-8'),
  ) as SpecAnalysisResult;
}

function expectContractComplete(result: SpecAnalysisResult): void {
  const keys = Object.keys(result);
  for (const field of CONTRACT_FIELDS) {
    expect(keys).toContain(field);
    expect(result[field]).not.toBeUndefined(); // populated or explicitly null
  }
}

function expectValidDelta(delta: SpecTestCaseDelta): void {
  expect(delta).toEqual({
    id: expect.any(String),
    title: expect.any(String),
    type: expect.stringMatching(/^(new|update|obsolete)$/),
    linkedImplicationId: expect.any(String),
    linkedRequirementId: expect.any(String),
    preconditions: expect.any(Array),
    steps: expect.any(Array),
    expected: expect.any(String),
    priority: expect.stringMatching(/^(low|medium|high)$/),
    rationale: expect.any(String),
  });
}

describe('spec analyze — output contract completeness', () => {
  it('populates every SpecAnalysisResult field when the semantic half runs', async () => {
    await makeStagedRepo();
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'json', model: 'm' },
      { llm: fakePort(JSON.stringify(payload())) },
    );

    const report = await readReport();
    expectContractComplete(report);

    // --output json prints the same complete contract document
    const printed = JSON.parse(logs.join('\n')) as SpecAnalysisResult;
    expect(printed).toEqual(report);

    // test deltas: linked, incremental and full-shape (FR10/SO5)
    expect(report.testDeltas.length).toBeGreaterThan(0);
    for (const d of report.testDeltas) expectValidDelta(d);
    expect(report.testDeltas[0].linkedImplicationId).toBe('imp-1');
    expect(report.testDeltas[0].linkedRequirementId).toBeTruthy();

    // impact summary: file/line refs present and matching the diff (FR11)
    expect(report.impactSummary.affectedFiles).toEqual([
      { path: 'src/greet.js', lines: [2] },
    ]);
    expect(report.impactSummary.affectedRequirementIds.length).toBeGreaterThan(0);
    expect(report.impactSummary.recommendedNextAction).toBeTruthy();
    expect(report.impactSummary.confidence).toBeGreaterThan(0);

    // drift alerts: NFR6 shape (may be empty — this change is 'new', not drift)
    expect(Array.isArray(report.driftAlerts)).toBe(true);

    expect(report.behaviourChangeSummary).toBe('The greeting salutation changed from "hello" to "hi".');
    expect(report.requiresUrsUpdate).toBe(true);
    expect(report.inferenceError).toBeNull();
    expect(report.proposalIds?.length).toBe(1);
  });

  it('populates every field with explicit nulls on the deterministic path', async () => {
    await makeStagedRepo();
    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text' });

    const report = await readReport();
    expectContractComplete(report);

    expect(report.implications).toEqual([]);
    expect(report.testDeltas).toEqual([]);
    expect(report.driftAlerts).toEqual([]);
    expect(report.behaviourChangeSummary).toBeNull();
    expect(report.requiresUrsUpdate).toBeNull();
    expect(report.inferenceError).toBeNull();
    expect(report.proposalIds).toEqual([]);
    expect(report.impactSummary).toEqual({
      affectedRequirementIds: [],
      affectedFiles: [{ path: 'src/greet.js', lines: [2] }],
      recommendedNextAction: 'No action required.',
      confidence: 1,
    });
  });
});
