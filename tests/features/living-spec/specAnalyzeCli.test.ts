import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import type { SpecAnalysisResult } from '../../../src/features/living-spec/pipeline/types.js';
import { livingSpecDir, reportsDir } from '../../../src/features/living-spec/tools/stateStore.js';

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

  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-speccli-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0; // error paths set exit codes — keep vitest's own clean
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function initRepo(): Promise<SimpleGit> {
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 'test@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Test');
  return git;
}

/** Fixture repo: one staged source change + one staged non-source change. */
async function makeStagedRepo(): Promise<void> {
  const git = await initRepo();
  await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, 'src', 'greet.js'),
    'export function greet(name) {\n  return `hello ${name}`;\n}\n',
    'utf-8',
  );
  await fs.writeFile(path.join(tmpRoot, 'README.md'), 'old docs\n', 'utf-8');
  await git.add(['src/greet.js', 'README.md']);
  await git.commit('initial');

  await fs.writeFile(
    path.join(tmpRoot, 'src', 'greet.js'),
    'export function greet(name) {\n  const greeting = `hi ${name}`;\n  return greeting;\n}\n',
    'utf-8',
  );
  await fs.writeFile(path.join(tmpRoot, 'README.md'), 'new docs\n', 'utf-8');
  await git.add(['src/greet.js', 'README.md']);
}

async function listReports(): Promise<string[]> {
  try {
    return (await fs.readdir(reportsDir(tmpRoot))).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
}

async function readReport(name: string): Promise<SpecAnalysisResult> {
  const raw = await fs.readFile(path.join(reportsDir(tmpRoot), name), 'utf-8');
  return JSON.parse(raw) as SpecAnalysisResult;
}

describe('codexrev spec analyze', () => {
  it('writes the report JSON and prints a human summary', async () => {
    await makeStagedRepo();
    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text' });

    const reports = await listReports();
    expect(reports).toHaveLength(1);
    const result = await readReport(reports[0]);
    expect(`${result.changeId}.json`).toBe(reports[0]);
    expect(result.changeId).toMatch(/^[0-9a-f]{64}$/);

    // deterministic front half: files + empty semantic fields
    expect(result.files).toEqual([{ path: 'src/greet.js', lines: 3 }]);
    expect(result.implications).toEqual([]);
    expect(result.testDeltas).toEqual([]);
    expect(result.ursPatch.entries).toEqual([]);
    expect(result.driftStatus).toBe('no-semantic-change');
    expect(result.quality).toEqual({
      model: 'heuristic',
      latencyMs: expect.any(Number),
      schemaValid: true,
    });

    const summary = logs.join('\n');
    expect(summary).toContain('src/greet.js');
    expect(summary).toContain('+2 -1');
    expect(summary).toContain('1 file(s) changed');
    expect(summary).toContain('report written:');
    // non-source files are filtered out of the analysis
    expect(summary).not.toContain('README.md');
  });

  it('honors --dry-run: prints the summary but writes nothing', async () => {
    await makeStagedRepo();
    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text', dryRun: true });

    expect(await listReports()).toEqual([]);
    const summary = logs.join('\n');
    expect(summary).toContain('(dry-run) report not written');
    expect(summary).toContain('src/greet.js');
  });

  it('prints the SpecAnalysisResult with --output json', async () => {
    await makeStagedRepo();
    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'json' });

    // the only stdout payload is the JSON document
    const printed = logs.join('\n');
    const result = JSON.parse(printed) as SpecAnalysisResult;
    expect(result.implications).toEqual([]);
    expect(result.testDeltas).toEqual([]);
    expect(result.ursPatch.entries).toEqual([]);
    expect(result.files).toEqual([{ path: 'src/greet.js', lines: 3 }]);

    // and the report was still written alongside the printed JSON
    const reports = await listReports();
    expect(reports).toEqual([`${result.changeId}.json`]);
  });

  it('reports an empty diff as a zero-file result', async () => {
    await initRepo();
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'x\n', 'utf-8');
    await simpleGit({ baseDir: tmpRoot }).add('a.ts');
    await simpleGit({ baseDir: tmpRoot }).commit('initial');

    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text' });
    const reports = await listReports();
    expect(reports).toHaveLength(1);
    const result = await readReport(reports[0]);
    expect(result.files).toEqual([]);
    expect(logs.join('\n')).toContain('0 file(s) changed');
  });

  it('fails cleanly on a non-git project', async () => {
    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text' });
    expect(errors.join('\n')).toContain('is not a git repository');
    expect(process.exitCode).toBe(1);
    expect(await listReports()).toEqual([]);
  });

  it('creates the .codexrev/living-spec state layout on demand', async () => {
    await makeStagedRepo();
    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text' });
    for (const sub of ['urs', 'versions', 'proposals', 'reports']) {
      await expect(
        fs.access(path.join(livingSpecDir(tmpRoot), sub)),
      ).resolves.toBeUndefined();
    }
  });
});
