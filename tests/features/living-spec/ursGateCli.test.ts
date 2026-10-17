import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import {
  readProposal,
  readUrsDocument,
  readUrsState,
  reportsDir,
  saveProposal,
} from '../../../src/features/living-spec/tools/stateStore.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import type { GenerateResponse } from '../../../src/core/types.js';

let tmpRoot: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-gate-'));
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
  await fs.writeFile(path.join(tmpRoot, 'src', 'greet.js'), 'export function greet() {\n  return "hi";\n}\n', 'utf-8');
  await git.add(['src/greet.js']);
  await git.commit('initial');
  await fs.writeFile(path.join(tmpRoot, 'src', 'greet.js'), 'export function greet() {\n  return "hello";\n}\n', 'utf-8');
  await git.add(['src/greet.js']);
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

/** A distinct, brand-new requirement the seeded URS does not cover. */
function newRequirementPayload() {
  return {
    implications: [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The system must persist the last greeting used by each caller.',
        rationale: 'The greeting path now writes to storage.',
        confidence: 0.9,
        sourceRefs: [{ path: 'src/greet.js', line: 2 }],
      },
    ],
    behaviourChangeSummary: 'Greeting is now persisted per caller.',
    requiresUrsUpdate: true,
  };
}

/** Seed the URS, run analyze with a fake LLM, and return the proposal id. */
async function seedAnalyzeAndGetProposal(): Promise<string> {
  await makeStagedRepo();
  await handleSpecCommand(['init-urs'], { project: tmpRoot });
  await handleSpecCommand(
    ['analyze'],
    { project: tmpRoot, output: 'text', model: 'm' },
    { llm: fakePort(JSON.stringify(newRequirementPayload())) },
  );
  const names = await fs.readdir(reportsDir(tmpRoot));
  const reportName = names.find((n) => n.endsWith('.json') && !n.endsWith('.implications.json'))!;
  const report = JSON.parse(
    await fs.readFile(path.join(reportsDir(tmpRoot), reportName), 'utf-8'),
  ) as { proposalIds: string[] };
  expect(report.proposalIds).toHaveLength(1);
  return report.proposalIds[0];
}

describe('codexrev spec accept/reject/defer — human gate e2e', () => {
  it('accept applies the scoped patch, bumps the URS version and marks the proposal', async () => {
    const id = await seedAnalyzeAndGetProposal();
    expect((await readUrsState(tmpRoot))?.version).toBe(1);

    await handleSpecCommand(['accept', id], { project: tmpRoot });

    // URS updated: new requirement landed, version bumped
    const doc = await readUrsDocument(tmpRoot);
    expect(doc?.sections.some((s) => s.text.includes('persist the last greeting'))).toBe(true);
    expect((await readUrsState(tmpRoot))?.version).toBe(2);

    // proposal marked accepted (NFR4: only accept makes it authoritative)
    expect((await readProposal(tmpRoot, id))?.status).toBe('accepted');
    expect(logs.join('\n')).toMatch(/accepted — URS updated to v2/);
  });

  it('reject records the decision and leaves the URS untouched', async () => {
    const id = await seedAnalyzeAndGetProposal();
    await handleSpecCommand(['reject', id], { project: tmpRoot });

    expect((await readProposal(tmpRoot, id))?.status).toBe('rejected');
    // URS unchanged: still just the seed, no version bump
    expect((await readUrsState(tmpRoot))?.version).toBe(1);
    const doc = await readUrsDocument(tmpRoot);
    expect(doc?.sections.some((s) => s.text.includes('persist the last greeting'))).toBe(false);
  });

  it('defer keeps the proposal listed in status and leaves the URS untouched', async () => {
    const id = await seedAnalyzeAndGetProposal();
    await handleSpecCommand(['defer', id], { project: tmpRoot });

    expect((await readProposal(tmpRoot, id))?.status).toBe('deferred');
    expect((await readUrsState(tmpRoot))?.version).toBe(1);

    logs.length = 0;
    await handleSpecCommand(['status'], { project: tmpRoot });
    const status = logs.join('\n');
    expect(status).toContain(id);
    expect(status).toContain('deferred');
  });

  it('rejects re-deciding an already-resolved proposal', async () => {
    const id = await seedAnalyzeAndGetProposal();
    await handleSpecCommand(['accept', id], { project: tmpRoot });
    logs.length = 0;
    errors.length = 0;
    await handleSpecCommand(['accept', id], { project: tmpRoot });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('already');
  });

  it('rejects a malformed patch and leaves the URS untouched', async () => {
    await makeStagedRepo();
    await handleSpecCommand(['init-urs'], { project: tmpRoot });
    // A remove op that illegally carries a section is malformed.
    await saveProposal(tmpRoot, {
      id: 'bad-1',
      changeId: 'chg',
      createdAt: '2026-10-17T00:00:00.000Z',
      title: 'bad',
      status: 'pending',
      implicationIds: [],
      driftStatus: 'modified',
      sectionsTouched: ['req-overview'],
      patch: {
        summary: 'bad',
        ops: [
          {
            op: 'remove',
            sectionId: 'req-overview',
            section: { id: 'req-overview', title: 'x', text: 'x', type: 'functional', version: 1, lastChangeId: 'c', sourceRefs: [] },
            markdown: '',
          },
        ],
      },
      rationale: 'x',
    });

    errors.length = 0;
    await handleSpecCommand(['accept', 'bad-1'], { project: tmpRoot });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('malformed');
    expect((await readUrsState(tmpRoot))?.version).toBe(1);
  });
});
