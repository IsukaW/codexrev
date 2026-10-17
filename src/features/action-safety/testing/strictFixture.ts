// Shared TEST fixture for the strict-authorization setup tests: an organization created through the real
// commands, with real keys in a temporary keys directory. Lives beside the other test helpers (fixtures.ts,
// fakeLlm.ts); nothing in the product imports it.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyGrant, type VerifiedGrant } from '../authorization/grant.js';
import { loadAuthority, type LoadedAuthority } from '../strict/authority.js';
import { initOrganization, issueGrant, type GrantResult } from '../strict/admin.js';
import { readJsonFile } from '../strict/files.js';
import { generateKeyProfile } from '../strict/keyStore.js';

export const NOW = new Date('2026-06-01T12:00:00Z');
export const later = (days: number, from: Date = NOW): Date => new Date(from.getTime() + days * 24 * 3600 * 1000);

export interface Fixture {
  readonly root: string;
  readonly keysDir: string;
  readonly authorityDir: string;
  readonly repo: string;
  readonly authority: LoadedAuthority;
  readonly grants: { readonly alice: GrantResult; readonly bob: GrantResult; readonly lead1: GrantResult };
  cleanup(): void;
}

/** a clean Git repository with one commit */
export function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, '.gitignore'), 'reports/\n');
  writeFileSync(join(dir, 'app.txt'), 'version 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
}

export function commitChange(dir: string, name = 'app.txt', content = 'version 2\n'): void {
  writeFileSync(join(dir, name), content);
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'second'], { cwd: dir, stdio: 'ignore' });
}

export function copyDir(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}

/** Creates keys admin, alice, bob, lead1, mallory; initializes "acme"; grants alice (L4), bob (L1), lead1 (L2). */
export async function setupOrganization(options: { withRepo?: boolean } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'codexrev-strict-'));
  const keysDir = join(root, 'keys');
  const authorityDir = join(root, 'authority');
  const repo = join(root, 'repo');
  for (const name of ['admin', 'alice', 'bob', 'lead1', 'mallory', 'store']) await generateKeyProfile({ name, keysDir, now: NOW });
  await initOrganization({ organization: 'acme', dir: authorityDir, adminKey: 'admin', storeKey: 'store', keysDir, now: NOW });
  const grant = (subject: string, role: string): Promise<GrantResult> =>
    issueGrant({ dir: authorityDir, adminKey: 'admin', keysDir, subject, pubkeyFile: join(keysDir, `${subject}.pub.json`), roles: [role], days: 30, now: NOW });
  const grants = { alice: await grant('alice', 'l4'), bob: await grant('bob', 'l1'), lead1: await grant('lead1', 'l2') };
  if (options.withRepo !== false) makeRepo(repo);
  const authority = await loadAuthority(authorityDir, NOW);
  return { root, keysDir, authorityDir, repo, authority, grants, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function verifiedGrantOf(f: Fixture, result: GrantResult, now: Date = NOW): Promise<VerifiedGrant> {
  const envelope = await readJsonFile(result.file, 'grant');
  const g = verifyGrant(envelope, f.authority.trustRoot, f.authority.policy, now);
  if (!g.ok) throw new Error(`fixture grant did not verify: ${g.code}`);
  return g;
}

// ---------------------------------------------------------------- evidence for the (non-authority) gates

import type { ContextInterpretation } from '../interpretation/types.js';

const hoursBefore = (now: Date, h: number): string => new Date(now.getTime() - h * 3_600_000).toISOString();
const attested = (now: Date) => ({ status: 'PASS', source: 'human_attested', observedAt: hoursBefore(now, 1), refs: ['ref:x'] });

/**
 * Writes build/test and security reports under `reports/` (ignored by Git, so the tree stays clean) and an
 * input file with the NON-authority evidence needed for an ALLOW. `claims` adds the kind of authority claims a
 * developer could type into the file; strict mode must ignore them.
 */
export function writeEvidence(repo: string, now: Date, options: { claims?: boolean; recovery?: boolean; buildTests?: boolean; extra?: Record<string, unknown> } = {}): string {
  mkdirSync(join(repo, 'reports'), { recursive: true });
  writeFileSync(join(repo, 'reports', 'tests.json'), JSON.stringify({ tool: 'vitest', kind: 'test', status: 'pass', timestamp: hoursBefore(now, 1), summary: { total: 3, passed: 3, failed: 0 } }));
  writeFileSync(join(repo, 'reports', 'sec.sarif'), JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: hoursBefore(now, 1) }], results: [] }] }));
  const input: Record<string, unknown> = {
    action: { impact: 'low', irreversible: false, blastRadius: { criticality: 'low', scope: 'local', sharedModulesModified: 0, dependencyReach: 0, affectedServiceCount: 1 } },
    ...(options.buildTests === false ? {} : { reports: { buildTests: ['reports/tests.json'], security: ['reports/sec.sarif'] } }),
    ...(options.recovery === false ? {} : { recovery: { rollbackPlan: attested(now), rollbackTest: attested(now), backup: attested(now) } }),
    ...(options.claims
      ? {
          actor: { id: 'alice', kind: 'human', roles: ['l5'] },
          authority: { identityVerification: attested(now), authorization: attested(now), grantedPermissions: { permissions: ['deployment.production'], evidence: attested(now) } },
          policy: { authorization: { required: false }, recovery: { required: false, whenIrreversible: false }, buildTests: { required: false }, supportingEvidence: { required: false } },
        }
      : {}),
    ...options.extra,
  };
  writeFileSync(join(repo, 'reports', 'input.json'), JSON.stringify(input));
  return 'reports/input.json';
}

/** A local-model interpretation that is simply not available (advisory by default): nothing depends on a model. */
export const noInterpretation = async (): Promise<ContextInterpretation> => ({
  status: 'UNAVAILABLE',
  schemaVersion: 1,
  failureKind: 'unexpected',
  reason: 'no model in tests',
  observations: [],
  rejectedObservations: [],
  injectionIndicators: [],
  limitations: [],
  advisoryOnly: true,
});
