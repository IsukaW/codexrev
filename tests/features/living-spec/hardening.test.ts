/**
 * Failure-path hardening sweep — one test per adversarial path the pipeline
 * must survive (research evidence: NFR robustness). Pairs with the existing
 * suites (malformed output + schema-invalid payload live in
 * specAnalyzeInference.test.ts; extraction/truncation parsing in
 * diffExtractor.test.ts; exactly-once semantics in changeBuffer.test.ts).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import type { SpecAnalysisResult } from '../../../src/features/living-spec/pipeline/types.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import { ChangeBuffer, hashContent } from '../../../src/features/living-spec/pipeline/changeBuffer.js';
import {
  readConfig,
  readUrsDocument,
  reportsDir,
  writeConfig,
  writeUrsDocument,
} from '../../../src/features/living-spec/tools/stateStore.js';
import type { GenerateResponse } from '../../../src/core/types.js';

let tmpRoot: string;
let logs: string[];
let errors: string[];
let warns: string[];

beforeEach(async () => {
  logs = [];
  errors = [];
  warns = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  });
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-hardening-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

/** One commit, then a staged one-line change to src/greet.js. */
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
    finishReason: 'completed',
  };
}

function goodPayload() {
  return JSON.stringify({
    implications: [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The greeting must greet the caller with a short salutation.',
        rationale: 'salutation literal changed',
        confidence: 0.88,
        sourceRefs: [{ path: 'src/greet.js', line: 2 }],
        category: 'behaviour',
      },
    ],
    behaviourChangeSummary: 'Salutation changed from hello to hi.',
    requiresUrsUpdate: true,
  });
}

async function readReport(): Promise<SpecAnalysisResult> {
  const names = (await fs.readdir(reportsDir(tmpRoot))).filter(
    (n) => n.endsWith('.json') && !n.endsWith('.implications.json'),
  );
  return JSON.parse(
    await fs.readFile(path.join(reportsDir(tmpRoot), names[0]), 'utf-8'),
  ) as SpecAnalysisResult;
}

describe('hardening: model failures leave the deterministic result standing', () => {
  it('model timeout → structured timeout error, run still completes (NFR5)', async () => {
    await makeStagedRepo();
    const hanging: LLMPort = {
      provider: 'ollama',
      model: 'hanging',
      generate: () => new Promise<GenerateResponse>(() => undefined),
    };
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', model: 'hanging', timeout: 80 },
      { llm: hanging },
    );

    const report = await readReport();
    expect(report.inferenceError).toMatchObject({ code: 'timeout', retryable: true });
    expect(report.implications).toEqual([]);
    expect(report.files).toEqual([{ path: 'src/greet.js', lines: 2 }]);
    expect(warns.join('\n')).toContain('--dry-run'); // actionable next step
    expect(process.exitCode ?? 0).toBe(0);
  }, 15_000);

  it('model-server unavailable → provider_unavailable + actionable hint', async () => {
    await makeStagedRepo();
    const refused: LLMPort = {
      provider: 'ollama',
      model: 'down',
      generate: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      },
    };
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', model: 'down' },
      { llm: refused },
    );

    const report = await readReport();
    expect(report.inferenceError).toMatchObject({ code: 'provider_unavailable' });
    const warnText = warns.join('\n');
    expect(warnText).toContain('provider_unavailable');
    expect(warnText).toContain('start ollama / lm studio');
    expect(warnText).toContain('--dry-run');
  });
});

describe('hardening: input coverage', () => {
  it('unsupported file types only → clean zero-file analysis', async () => {
    const git = await initRepo();
    await fs.writeFile(path.join(tmpRoot, 'README.md'), '# old\n', 'utf-8');
    await git.add('README.md');
    await git.commit('initial');
    await fs.writeFile(path.join(tmpRoot, 'README.md'), '# new docs\n', 'utf-8');
    await git.add('README.md');

    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text' });

    const report = await readReport();
    expect(report.files).toEqual([]);
    expect(report.testDeltas).toEqual([]);
    expect(report.driftAlerts).toEqual([]);
    expect(logs.join('\n')).toContain('0 file(s) changed');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('missing prior URS → model implications classify as new with scoped proposals', async () => {
    await makeStagedRepo();
    // no init-urs: readUrsDocument returns null → empty URS path
    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', model: 'm' },
      { llm: { provider: 'ollama', model: 'm', generate: async () => response(goodPayload()) } },
    );

    const report = await readReport();
    expect(report.driftStatus).toBe('new');
    expect(report.proposalIds).toHaveLength(1);
    expect(report.testDeltas[0].linkedRequirementId).toBe('req-imp-1');
    expect(report.impactSummary.affectedRequirementIds).toEqual(['req-imp-1']);
    expect(errors.join('\n')).toBe('');
  });

  it('oversized diff → truncation is flagged with a maxBytes hint', async () => {
    const git = await initRepo();
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    await fs.writeFile(path.join(tmpRoot, 'src', 'big.js'), before, 'utf-8');
    await git.add('src/big.js');
    await git.commit('initial');
    const after = Array.from({ length: 200 }, (_, i) => `changed line ${i}`).join('\n');
    await fs.writeFile(path.join(tmpRoot, 'src', 'big.js'), after, 'utf-8');
    await git.add('src/big.js');

    const cfg = await readConfig(tmpRoot);
    await writeConfig(tmpRoot, { ...cfg, maxBytes: 1024 });

    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text' });

    const warnText = warns.join('\n');
    expect(warnText).toContain('truncated at 1024');
    expect(warnText).toContain('maxBytes');
    expect(warnText).toContain('results are partial');
    // the run still produced a (partial) report
    const report = await readReport();
    expect(report.files.length).toBeGreaterThan(0);
  });
});

describe('hardening: repeated save events (NFR3 — ≥95% suppressed)', () => {
  it('100 pushes of 2 effective states produce exactly 1 analysed batch', async () => {
    let batches = 0;
    const buffer = new ChangeBuffer({
      debounceMs: 0,
      onBatch: () => {
        batches++;
      },
    });
    const first = hashContent('state one');
    const second = hashContent('state two');
    const outcomes: string[] = [];

    // burst while pending: one effective state re-saved 50× → no re-analysis
    outcomes.push(buffer.push({ path: 'src/a.js', hash: first }));
    for (let i = 0; i < 50; i++) outcomes.push(buffer.push({ path: 'src/a.js', hash: first }));
    buffer.flush();
    // after analysis: identical content re-saved 49× → deduped
    for (let i = 0; i < 49; i++) outcomes.push(buffer.push({ path: 'src/a.js', hash: first }));
    // one genuinely new state → a second batch (2 batches total for 101 events)
    outcomes.push(buffer.push({ path: 'src/a.js', hash: second }));
    buffer.flush();
    buffer.dispose();

    expect(batches).toBe(2);
    const suppressed = outcomes.filter((o) => o === 'unchanged' || o === 'deduped').length;
    expect(suppressed / outcomes.length).toBeGreaterThanOrEqual(0.95);
    expect(outcomes.filter((o) => o === 'scheduled')).toHaveLength(2);
  });
});

describe('hardening: crash mid-URS-write stays atomic', () => {
  it('a crash before the commit leaves the previous URS fully intact', async () => {
    const v1 = {
      schemaVersion: 1 as const,
      title: 'URS',
      sections: [
        {
          id: 'req-a',
          title: 'A',
          text: 'original text',
          type: 'functional' as const,
          version: 1,
          lastChangeId: 'seed',
          sourceRefs: [],
        },
      ],
    };
    const v2 = {
      ...v1,
      sections: [{ ...v1.sections[0], text: 'replacement text' }],
    };
    await writeUrsDocument(tmpRoot, v1);

    await expect(
      writeUrsDocument(tmpRoot, v2, undefined, {
        beforeCommit: () => {
          throw new Error('simulated crash before rename');
        },
      }),
    ).rejects.toThrow('simulated crash before rename');

    // live JSON + markdown still carry v1 — never a half-written document
    expect(await readUrsDocument(tmpRoot)).toEqual(v1);
    const md = await fs.readFile(
      path.join(tmpRoot, '.codexrev', 'living-spec', 'urs', 'urs.md'),
      'utf-8',
    );
    expect(md).toContain('original text');
    expect(md).not.toContain('replacement text');
  });
});

describe('hardening: offline run performs zero external HTTP calls', () => {
  it('a full analyze with an injected provider never touches fetch', async () => {
    await makeStagedRepo();
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted during offline analysis');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', model: 'm', offline: true },
      { llm: { provider: 'ollama', model: 'm', generate: async () => response(goodPayload()) } },
    );

    // the injected port replaces the provider adapter entirely; the pipeline
    // path (extraction → inference → drift → outputs) must not reach the network
    expect(fetchSpy).not.toHaveBeenCalled();
    const report = await readReport();
    expect(report.implications).toHaveLength(1);
    expect(report.driftStatus).toBe('new');
  });
});
