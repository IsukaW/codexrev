import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWatchSession } from '../../../src/features/living-spec/cli/runWatchSession.js';
import type { AnalysisOutcome } from '../../../src/features/living-spec/pipeline/analysisRunner.js';
import { reportsDir } from '../../../src/features/living-spec/tools/stateStore.js';

let tmpRoot: string;
let logs: string[];

beforeEach(async () => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-specwatch-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await fn();
    if (hit !== null) return hit;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await sleep(100);
  }
}

describe('runWatchSession (foreground session, real chokidar provider)', () => {
  it('analyzes a debounced save, writes the report and stops cleanly', async () => {
    const git = simpleGit({ baseDir: tmpRoot });
    await git.init();
    await git.addConfig('user.email', 'test@codexrev.dev');
    await git.addConfig('user.name', 'Codexrev Test');
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'src', 'greet.js'),
      'export function greet() {\n  return 1;\n}\n',
      'utf-8',
    );
    await git.add('src/greet.js');
    await git.commit('initial');

    const controller = new globalThis.AbortController();
    let resolveBatch: (outcome: AnalysisOutcome) => void = () => undefined;
    const batchDone = new Promise<AnalysisOutcome>((resolve) => {
      resolveBatch = resolve;
    });

    const session = runWatchSession({
      projectRoot: tmpRoot,
      debounceMs: 100,
      stopSignal: controller.signal,
      onBatchAnalyzed: (outcome) => resolveBatch(outcome),
    });

    // let chokidar's initial scan settle, then save a real change
    await sleep(1000);
    await fs.writeFile(
      path.join(tmpRoot, 'src', 'greet.js'),
      'export function greet() {\n  return 2;\n}\n',
      'utf-8',
    );

    const outcome = await Promise.race([
      batchDone,
      sleep(15_000).then(() => {
        throw new Error('watch session produced no batch within 15 s');
      }),
    ]);
    expect(outcome.result.files.map((f) => f.path)).toContain('src/greet.js');
    expect(outcome.result.changeId).toMatch(/^[0-9a-f]{64}$/);

    // the batch analysis persisted its report like `analyze` does
    await waitFor(async () => {
      const names = await fs.readdir(reportsDir(tmpRoot)).catch(() => [] as string[]);
      return names.find((n) => n === `${outcome.result.changeId}.json`) ?? null;
    }, 5_000);

    // the foreground session ends cleanly on the stop signal (what Ctrl+C fires)
    controller.abort();
    await session;
    expect(logs.join('\n')).toContain('watch session stopped');
  }, 30_000);
});
