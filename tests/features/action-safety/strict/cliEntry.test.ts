// The command-line surface: usage handling, and the standalone entry point actually built and run.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, USAGE, runStrictCli } from '../../../../src/features/action-safety/strict/run.js';
import { NOW } from '../../../../src/features/action-safety/testing/strictFixture.js';

const collect = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => NOW } };
};

describe('usage handling', () => {
  it('prints help for help flags (exit 0) and for no command (exit 2)', async () => {
    for (const flag of ['help', '--help', '-h']) {
      const c = collect();
      expect(await runStrictCli([flag], c.io)).toBe(EXIT.ok);
      expect(c.out.join('\n')).toBe(USAGE);
    }
    expect(await runStrictCli([], collect().io)).toBe(EXIT.usage);
    expect(USAGE).toMatch(/keygen/);
    expect(USAGE).toMatch(/admin init/);
    expect(USAGE).toMatch(/assess/);
    expect(USAGE).toMatch(/verify/);
    // the per-action approval command was removed with the approval workflow
    expect(USAGE).not.toMatch(/\bapprove\b/i);
    expect(USAGE).not.toMatch(/--approval/);
  });

  it('reports unknown commands, unknown options and missing options as usage errors, readably', async () => {
    const cases: string[][] = [['bogus'], ['admin'], ['admin', 'bogus'], ['keygen'], ['keygen', '--name', 'a', '--nope', 'x'], ['keygen', 'extra'], ['approve', '--dir'], ['approve'], ['admin', 'init', '--org', 'acme']];
    for (const argv of cases) {
      const c = collect();
      expect(await runStrictCli(argv, c.io), argv.join(' ')).toBe(EXIT.usage);
      expect(c.err.join('\n')).toMatch(/usage|unknown/i);
    }
  });

  it('never shows a stack trace or an internal exception message for an unexpected failure', async () => {
    const c = collect();
    const code = await runStrictCli(['keygen', '--name', 'ok-name', '--keys-dir', '\0bad'], c.io);
    expect(code).not.toBe(EXIT.ok);
    expect(c.err.join('\n')).not.toMatch(/\bat \w|node_modules|\.ts:\d+/);
  });
});

describe('the standalone entry point', () => {
  let dir: string;
  let built: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codexrev-entry-'));
    // the bundle keeps npm packages external (like the main build), so it must sit where node_modules can be found
    built = mkdtempSync(join(process.cwd(), 'dist', 'strict-entry-test-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(built, { recursive: true, force: true });
  });

  it('builds with esbuild into dist-style output and runs: key generation and help, from the bundle', { timeout: 60_000 }, async () => {
    const outfile = join(built, 'cli.js');
    await build({ entryPoints: [join(process.cwd(), 'src/features/action-safety/strict/cli.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', outfile, logLevel: 'silent' });
    const help = spawnSync(process.execPath, [outfile, '--help'], { encoding: 'utf-8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('keygen');
    const keysDir = join(dir, 'keys');
    const run = spawnSync(process.execPath, [outfile, 'keygen', '--name', 'alice', '--keys-dir', keysDir], { encoding: 'utf-8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/key id:\s+[0-9a-f]{64}/);
    expect(run.stdout).not.toContain('PRIVATE KEY');
    expect(readdirSync(keysDir).sort()).toEqual(['alice.key', 'alice.pub.json']);
    const again = spawnSync(process.execPath, [outfile, 'keygen', '--name', 'alice', '--keys-dir', keysDir], { encoding: 'utf-8' });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
    const bad = spawnSync(process.execPath, [outfile, 'wat'], { encoding: 'utf-8' });
    expect(bad.status).toBe(2);
  });
});

describe('scope', () => {
  it('does not use the shared CLI or another feature, and has no network, service or database code', async () => {
    const { readFileSync, readdirSync: ls } = await import('node:fs');
    const base = join(process.cwd(), 'src/features/action-safety/strict');
    for (const file of ls(base).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(base, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
      // it uses the Feature 4 assessment modules (that is its job) but never the shared CLI or another feature
      for (const i of imports) expect(i, file).not.toMatch(/^(\.\.\/){3}cli\/|review-pipeline|features\/(?!action-safety)/);
      expect(text, file).not.toMatch(/node:net|node:http|node:https|node:dgram|node:tls|fetch\(|sqlite|process\.env/);
    }
  });
});
