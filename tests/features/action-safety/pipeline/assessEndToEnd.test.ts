// The real CLI entry point (src/cli/index.ts) in a child process: proves the decision and the exit
// code actually reach the shell. Slow to start from source, so the runs happen in parallel.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, type TempRepo } from '../../../../src/features/action-safety/testing/fixtures.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

let repo: TempRepo;
let home: string;

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const attested = () => ({ status: 'PASS', source: 'human_attested', observedAt: hoursAgo(1), refs: ['ref:x'] });

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-safety-e2e-home-'));
  repo = await makeRepo();
  await repo.write('.gitignore', 'reports/\n');
  await repo.write('src/a.ts', 'one\n');
  await repo.commitAll('base');
  await repo.write('src/a.ts', 'one\ntwo\n');
  await repo.write('reports/tests.json', JSON.stringify({ tool: 'vitest', kind: 'test', status: 'pass', timestamp: hoursAgo(1), summary: { total: 3, passed: 3, failed: 0 } }));
  await repo.write('reports/sec.sarif', JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: hoursAgo(1) }], results: [] }] }));
  await repo.write(
    'reports/input.json',
    JSON.stringify({
      action: { impact: 'low', irreversible: false, blastRadius: { criticality: 'low', scope: 'local', sharedModulesModified: 0, dependencyReach: 0, affectedServiceCount: 1 } },
      actor: { id: 'alice', kind: 'human', roles: ['developer'] },
      authority: {
        identityVerification: attested(), authorization: attested(), requiredRoles: ['developer'], requiredPermissions: ['deploy'],
        grantedPermissions: { permissions: ['deploy'], evidence: attested() }, requiredApprovals: 1, approvals: [{ approverId: 'bob', evidence: attested() }],
      },
      reports: { buildTests: ['reports/tests.json'], security: ['reports/sec.sarif'] },
      recovery: { rollbackPlan: attested(), rollbackTest: attested(), backup: attested() },
    }),
  );
}, 60_000);

afterAll(async () => {
  await repo.remove();
  await fs.rm(home, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', TSX_LOADER, CLI, ...args],
      // a cloud provider is configured, so the model is refused and nothing is ever sent anywhere
      { cwd, env: { ...process.env, CODEXREV_HOME: home, CODEXREV_PROVIDER: 'openai', CODEXREV_LOG_LEVEL: 'silent' }, timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('codexrev safety assess (real CLI entry point)', () => {
  it('ALLOW exits 0, ESCALATE exits 10, BLOCK exits 11, invalid input exits 1', async () => {
    const [allow, escalate, block, invalid] = await Promise.all([
      runCli(['safety', 'assess', '--action', 'deployment', '--target', 'development', '--input', 'reports/input.json'], repo.dir),
      runCli(['safety', 'assess', '--action', 'deployment', '--target', 'production', '--input', 'reports/input.json'], repo.dir),
      runCli(['safety', 'assess', '--action', 'deployment', '--target', 'development'], repo.dir), // nothing supplied
      runCli(['safety', 'assess', '--action', 'deployment', '--target', 'development', '--input', 'reports/does-not-exist.json'], repo.dir),
    ]);

    expect(allow.code).toBe(0);
    expect(allow.stdout).toMatch(/FINAL DECISION: ALLOW/);
    expect(allow.stdout).toMatch(/The proposed action was NOT executed/);
    expect(allow.stdout).toMatch(/SAFETY SCORE +0\.\d{3}/);

    expect(escalate.code).toBe(10);
    expect(escalate.stdout).toMatch(/FINAL DECISION: ESCALATE/);

    expect(block.code).toBe(11);
    expect(block.stdout).toMatch(/FINAL DECISION: BLOCK/);

    expect(invalid.code).toBe(1);
    expect(invalid.stdout).not.toMatch(/FINAL DECISION/);
    expect(invalid.stderr).toMatch(/input file not found/);
  }, 120_000);
});
