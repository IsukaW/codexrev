// End-to-end routing check: runs the real CLI entry point (src/cli/index.ts)
// in a child process, so it proves the shared yargs chain really hands
// `codexrev safety ...` to the Feature 4 handler and leaves other commands alone.
// Startup from source is slow (several seconds), so the checks run in parallel.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
// absolute, because the child runs in a temp cwd where a bare `tsx` would not resolve
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

let home: string;
let work: string;

beforeAll(async () => {
  // keep the CLI's ~/.codexrev bootstrap and the working dir away from the real ones
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-safety-home-'));
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-safety-work-'));
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', TSX_LOADER, CLI, ...args],
      { cwd: work, env: { ...process.env, CODEXREV_HOME: home, CODEXREV_PROVIDER: 'openai', CODEXREV_LOG_LEVEL: 'silent' }, timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('codexrev safety (real CLI entry point)', () => {
  it('routes safety subcommands to the Feature 4 handler with the documented exit codes', async () => {
    const [assess, missing, bogus, history, verify, noSub, shadow] = await Promise.all([
      runCli(['safety', 'assess', '--action', 'deployment', '--target', 'production']),
      runCli(['safety', 'assess', '--target', 'production']),
      runCli(['safety', 'bogus']),
      runCli(['safety', 'history']),
      runCli(['safety', 'verify']),
      runCli(['safety']),
      // a trailing word that is also a shared command name must not re-route
      runCli(['safety', 'history', 'review']),
    ]);

    expect(assess.code).toBe(11); // nothing supplied, so the mandatory gates BLOCK
    expect(assess.stdout).toMatch(/FINAL DECISION: BLOCK/);
    expect(assess.stdout).toMatch(/The proposed action was NOT executed/);

    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/--action is required/);

    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toMatch(/Unknown safety subcommand: bogus/);

    expect(history.code).toBe(3);
    expect(history.stdout).toMatch(/Audit history is not connected/);

    expect(verify.code).toBe(2);
    expect(verify.stderr).toMatch(/--file/);

    expect(noSub.code).toBe(2);
    expect(noSub.stderr).toMatch(/usage: codexrev safety assess/);

    expect(shadow.code).toBe(3);
    expect(shadow.stdout).toMatch(/Audit history is not connected/);
    expect(shadow.stdout).not.toMatch(/review/i);

    // nothing was written into the working directory
    expect(await fs.readdir(work)).toEqual([]);
  }, 120_000);

  it('shows the Safety section in `codexrev -h` and leaves other help untouched', async () => {
    const help = await runCli(['-h']);
    expect(help.code).toBe(0);
    // eslint-disable-next-line no-control-regex
    const text = help.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toMatch(/Evaluate proposed DevOps actions before execution/);
    expect(text).toMatch(/Safety flags/);
    expect(text).toMatch(/Review flags/);
  }, 120_000);
});
