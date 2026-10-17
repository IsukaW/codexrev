import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import { reportsDir } from '../../../src/features/living-spec/tools/stateStore.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import type { EvalReport } from '../../../src/features/living-spec/testing/evaluationHarness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(HERE, 'fixtures', 'scenarios');

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
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-evalexec-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function listEvalReports(): Promise<{ json: string[]; md: string[] }> {
  const names = await fs.readdir(reportsDir(tmpRoot)).catch(() => [] as string[]);
  return {
    json: names.filter((n) => /^eval-.*\.json$/.test(n)),
    md: names.filter((n) => /^eval-.*\.md$/.test(n)),
  };
}

describe('codexrev spec eval — offline run', () => {
  it('runs offline, prints the Markdown summary and writes both report files', async () => {
    await handleSpecCommand(['eval'], { project: tmpRoot, corpus: CORPUS_DIR });

    const { json, md } = await listEvalReports();
    expect(json).toHaveLength(1);
    expect(md).toHaveLength(1);

    const report = JSON.parse(
      await fs.readFile(path.join(reportsDir(tmpRoot), json[0]), 'utf-8'),
    ) as EvalReport;
    expect(report.schemaVersion).toBe(1);
    expect(report.provider).toEqual({ model: 'label-echo', live: false });
    expect(report.modes).toEqual(['batch', 'single-pass', 'full']);
    expect(report.corpus.scenarioCount).toBeGreaterThanOrEqual(12);
    expect(report.aggregate.full!.driftAccuracy).toBe(1);

    const printed = logs.join('\n');
    expect(printed).toContain('# Living-spec evaluation');
    expect(printed).toContain('| Mode | Implication P |');
    expect(printed).toContain('report written:');
    expect(printed).toContain('summary:');
    expect(process.exitCode ?? 0).toBe(0);
  }, 30_000);

  it('prints only the report JSON with --output json', async () => {
    await handleSpecCommand(['eval'], {
      project: tmpRoot,
      corpus: CORPUS_DIR,
      output: 'json',
      mode: 'full',
    });

    const report = JSON.parse(logs.join('\n')) as EvalReport;
    expect(report.modes).toEqual(['full']);
    expect(report.aggregate.full!.implication.f1).toBe(1);
    // ...and the files were still written alongside
    const { json } = await listEvalReports();
    expect(json).toHaveLength(1);
  }, 30_000);

  it('accepts the research mode aliases A / B / C', async () => {
    await handleSpecCommand(['eval'], {
      project: tmpRoot,
      corpus: CORPUS_DIR,
      mode: 'B',
      output: 'json',
    });
    const report = JSON.parse(logs.join('\n')) as EvalReport;
    expect(report.modes).toEqual(['single-pass']);

    logs.length = 0;
    await handleSpecCommand(['eval'], {
      project: tmpRoot,
      corpus: CORPUS_DIR,
      mode: 'C',
      output: 'json',
    });
    expect((JSON.parse(logs.join('\n')) as EvalReport).modes).toEqual(['full']);
  }, 30_000);

  it('runs the whole corpus against the live provider with --mode live', async () => {
    const fakeLive: LLMPort = {
      provider: 'ollama',
      model: 'live-model',
      generate: async (req) => {
        const system = req.systemInstruction ?? '';
        const text = system.includes('grade')
          ? JSON.stringify({ score: 0.9 })
          : system.includes('GUESS')
            ? JSON.stringify({
                implications: [],
                driftStatus: 'no-semantic-change',
                behaviourChangeSummary: 'live baseline run',
                requiresUrsUpdate: false,
              })
            : JSON.stringify({
                implications: [],
                behaviourChangeSummary: 'live baseline run',
                requiresUrsUpdate: false,
              });
        return {
          message: { role: 'assistant', parts: [{ kind: 'text', text }] },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed' as const,
        };
      },
    };
    await handleSpecCommand(
      ['eval'],
      { project: tmpRoot, corpus: CORPUS_DIR, mode: 'live', output: 'json' },
      { llm: fakeLive },
    );
    const report = JSON.parse(logs.join('\n')) as EvalReport;
    expect(report.modes).toEqual(['batch', 'single-pass', 'full']);
    expect(report.provider).toEqual({ model: 'live-model', live: true });
    expect(report.scenarios).toHaveLength(42);
    expect(report.scenarios.every((r) => r.inferenceError === null)).toBe(true);
  }, 30_000);

  it('rejects an unknown --mode as bad usage (exit 2)', async () => {
    await handleSpecCommand(['eval'], { project: tmpRoot, corpus: CORPUS_DIR, mode: 'sideways' });
    expect(process.exitCode).toBe(2);
    expect(errors.join('\n')).toContain('invalid --mode "sideways"');
    expect(await listEvalReports()).toEqual({ json: [], md: [] });
  });

  it('fails cleanly (exit 1) when the corpus is missing', async () => {
    await handleSpecCommand(['eval'], {
      project: tmpRoot,
      corpus: path.join(tmpRoot, 'no-such-corpus'),
    });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('cannot read scenario corpus');
    expect(await listEvalReports()).toEqual({ json: [], md: [] });
  });
});
