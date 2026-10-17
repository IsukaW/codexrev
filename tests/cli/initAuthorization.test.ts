// Simple employee onboarding in `codexrev init`: employee id, name and level -> a signed, read-only certificate, which
// `codexrev safety assess --strict` finds and verifies automatically. Temporary directories, a fake keychain and a
// temporary CODEXREV_HOME / CODEXREV_ADMIN_DIR only: no real keys, keychain, home directory or repository is touched.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/cli/init.js';
import type { AuthPrompter } from '../../src/cli/initAuthorization.js';
import { loadProjectConfig } from '../../src/config/projectConfig.js';
import { _resetFakeStore } from '../../src/security/keychain.js';
import { signEnvelope } from '../../src/features/action-safety/authorization/envelope.js';
import { verifyGrant } from '../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy } from '../../src/features/action-safety/authorization/policy.js';
import { verifyRevocationList } from '../../src/features/action-safety/authorization/revocation.js';
import { strictAssessCommand } from '../../src/features/action-safety/cli/strictAssessCommand.js';
import { initOrganization, revokeGrants } from '../../src/features/action-safety/strict/admin.js';
import { loadAuthority } from '../../src/features/action-safety/strict/authority.js';
import { generateKeyProfile, loadPrivateKey } from '../../src/features/action-safety/strict/keyStore.js';
import {
  projectAuthorizationPaths,
  projectAuthorizationStatus,
  readProjectAuthorization,
  readTrustedFingerprint,
  refreshProjectAuthority,
  strictOptionsFromProject,
  trustedRootsPath,
} from '../../src/features/action-safety/strict/projectAuthorization.js';
import { NOW, later, makeRepo, noInterpretation, writeEvidence } from '../../src/features/action-safety/testing/strictFixture.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 }); // onboarding generates keys and verifies a signed organization

const KEEP = ['CODEXREV_TEST_FAKE_KEYCHAIN', 'CODEXREV_HOME', 'CODEXREV_ADMIN_DIR', 'CODEXREV_TRUST_ROOT_SHA256'] as const;
const original: Record<string, string | undefined> = {};

let root: string;
let adminDir: string;
let project: string;
let home: string;
let errors: string[];
let logs: string[];
let counter = 0;

async function provisionIssuer(dir: string, organization: string, adminKeyName = 'admin'): Promise<void> {
  const keys = path.join(dir, 'keys');
  for (const name of [adminKeyName, 'store']) await generateKeyProfile({ name, keysDir: keys, now: NOW });
  await initOrganization({ organization, dir: path.join(dir, 'authority'), adminKey: adminKeyName, storeKey: 'store', keysDir: keys, now: NOW });
}

beforeAll(async () => {
  for (const k of KEEP) original[k] = process.env[k];
  root = mkdtempSync(path.join(os.tmpdir(), 'codexrev-employee-'));
  adminDir = path.join(root, 'admin');
  await provisionIssuer(adminDir, 'acme');
});
afterAll(() => {
  for (const k of KEEP) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  counter += 1;
  project = await fs.mkdtemp(path.join(root, `project-${counter}-`));
  home = path.join(root, `home-${counter}`);
  process.env.CODEXREV_TEST_FAKE_KEYCHAIN = '1';
  process.env.CODEXREV_HOME = home; // employee keys and the trusted-roots file go here
  process.env.CODEXREV_ADMIN_DIR = adminDir;
  delete process.env.CODEXREV_TRUST_ROOT_SHA256;
  _resetFakeStore();
  process.exitCode = undefined;
  errors = [];
  logs = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const provider = { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test-abc', nonInteractive: true } as const;
const scripted = (over: Record<string, unknown> = {}) => ({ employeeId: 'EMP001', employeeName: 'Alice', level: 'L2', ...over });
const text = (): string => `${logs.join('\n')}\n${errors.join('')}`;

/** a project that is a Git repository with evidence, so a strict assessment can run */
function gitProject(): void {
  makeRepo(project);
  writeEvidence(project, NOW);
}

async function onboard(level = 'L2', extra: Record<string, unknown> = {}, at: Date = NOW): Promise<void> {
  await runInit({ cwd: project, ...provider, authorization: scripted({ level, ...extra }), now: () => at });
  expect(process.exitCode, 'onboarding succeeded').toBeUndefined();
  logs = [];
  errors = [];
}

/** answers by matching the question text; arrays are consumed in order */
function prompter(answers: Array<[RegExp, string | string[]]>): AuthPrompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async ask(question, fallback) {
      asked.push(question);
      const hit = answers.find(([re]) => re.test(question));
      const given = hit ? hit[1] : '';
      const answer = Array.isArray(given) ? (given.shift() ?? '') : given;
      return answer === '' && fallback !== undefined ? fallback : answer;
    },
  };
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else out.push(`${path.join(d, e.name).slice(dir.length)}:${readFileSync(path.join(d, e.name), 'utf-8').length}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

const certificatePath = async (): Promise<string> => path.join(projectAuthorizationPaths(project).configDir, (await readProjectAuthorization(project))!.grantFile);

const assess = async (action = 'code_change', target = 'development', at: Date = NOW, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; text: string }> => {
  const lines: string[] = [];
  const errs: string[] = [];
  const code = await strictAssessCommand({ action, target, input: 'reports/input.json', strict: true }, project, { out: (l) => lines.push(l), err: (l) => errs.push(l), now: () => at, env, hooks: { interpreter: noInterpretation } });
  return { code, text: `${lines.join('\n')}\n${errs.join('\n')}` };
};

describe('codexrev init is unchanged for provider setup', () => {
  it('without authorization flags and without a terminal it writes only the provider configuration', async () => {
    await runInit({ cwd: project, ...provider });
    expect(await loadProjectConfig(project)).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
    expect(await readProjectAuthorization(project)).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    expect(text()).not.toMatch(/authorization/i);
  });
});

describe('employee onboarding', () => {
  it('asks only the employee id, the name and the level, and prints the simple screens', async () => {
    await runInit({ cwd: project, ...provider });
    logs = [];
    const p = prompter([
      [/Set up employee authorization/, 'y'],
      [/Employee ID/, 'EMP001'],
      [/Employee Name/, 'Alice'],
      [/Select level/, ['9', '2']], // an invalid answer first
    ]);
    await runInit({ cwd: project, ...provider, nonInteractive: false, authPrompter: p, now: () => NOW });
    expect(process.exitCode).toBeUndefined();
    expect(p.asked).toEqual(['Set up employee authorization? (Y/n)', 'Employee ID', 'Employee Name', 'Select level', 'Select level']);
    const screen = logs.join('\n');
    expect(screen).toMatch(/1\. L1 - Developer Level 1[\s\S]*5\. L5 - Developer Level 5/);
    expect(screen).toContain('Generating signed authorization certificate...');
    expect(screen).toContain('Employee authorization configured successfully!');
    expect(screen).toContain('Employee: Alice');
    expect(screen).toContain('Employee ID: EMP001');
    expect(screen).toContain('Authorization Level: L2');
    expect(screen).toContain('Certificate Status: Active');
    expect(screen).toContain('CodeXRev initialization completed.');
  });

  it('answering no changes nothing', async () => {
    await runInit({ cwd: project, ...provider });
    const p = prompter([[/Set up employee authorization/, 'n']]);
    await runInit({ cwd: project, ...provider, nonInteractive: false, authPrompter: p, now: () => NOW });
    expect(p.asked).toHaveLength(1);
    expect(await readProjectAuthorization(project)).toBeUndefined();
  });

  it('every level L1 to L5 produces a valid signed certificate with the employee details, timestamps and issuer key, saved read-only', async () => {
    for (const level of ['L1', 'L2', 'L3', 'L4', 'L5']) {
      project = await fs.mkdtemp(path.join(root, `lv-${counter}-${level}-`));
      await onboard(level, { employeeId: `EMP-${level}`, employeeName: `Emp ${level}` });
      const record = (await readProjectAuthorization(project))!;
      expect(record, level).toMatchObject({ level: level.toLowerCase(), developer: { subject: `EMP-${level}` } });
      const cert = await certificatePath();
      expect(statSync(cert).mode & 0o222, `${level} read-only`).toBe(0);
      // the certificate is the existing signed grant: verify it with the existing verifier against the issuer's trust root
      const authority = await loadAuthority(path.join(adminDir, 'authority'), NOW);
      const grant = verifyGrant(JSON.parse(readFileSync(cert, 'utf-8')), authority.trustRoot, authority.policy, NOW);
      expect(grant.ok, level).toBe(true);
      if (!grant.ok) continue;
      expect(grant.grant.roles).toEqual([level.toLowerCase()]);
      expect(grant.grant.subject).toMatchObject({ id: `EMP-${level}`, displayName: `Emp ${level}`, type: 'human' }); // employee id and name are signed
      expect(grant.grant.grantId).toBe(record.grantId);
      expect(grant.grant.issuedAt).toBe('2026-06-01T12:00:00Z');
      expect(Date.parse(grant.grant.expiresAt) - Date.parse(grant.grant.notBefore)).toBe(30 * 24 * 3600 * 1000);
      expect(grant.issuerKeyId).toBe((await loadPrivateKey({ name: 'admin', keysDir: path.join(adminDir, 'keys') })).keyId);
    }
  });

  it('keeps private keys out of the project and the issuer key away from the employee keys', async () => {
    await onboard();
    const keys = path.join(home, 'keys');
    expect(readdirSync(keys).sort()).toEqual(['emp-emp001.key', 'emp-emp001.pub.json', 'store.key', 'store.pub.json']);
    const adminPem = readFileSync(path.join(adminDir, 'keys', 'admin.key'), 'utf-8').split('\n')[1] as string;
    for (const f of readdirSync(keys)) expect(readFileSync(path.join(keys, f), 'utf-8')).not.toContain(adminPem);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(path.join(project, '.codexrev'))) expect(readFileSync(f, 'utf-8'), f).not.toMatch(/PRIVATE KEY|sk-test/);
    expect(await readTrustedFingerprint(project)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('without provisioned signing credentials nothing is issued, the message is clear and the provider configuration is intact', async () => {
    process.env.CODEXREV_ADMIN_DIR = path.join(root, 'nowhere');
    await runInit({ cwd: project, ...provider, authorization: scripted(), now: () => NOW });
    expect(process.exitCode).toBe(1);
    expect(errors.join('')).toMatch(/signing credentials are not provisioned on this machine/);
    expect(errors.join('')).toMatch(/provider configuration was not changed/);
    expect(await loadProjectConfig(project)).toMatchObject({ provider: 'openai' });
    expect(await readProjectAuthorization(project)).toBeUndefined();
    expect(existsSync(path.join(project, '.codexrev', 'authority'))).toBe(false);
    expect(text()).not.toContain('configured successfully');
  });

  it('a signing key that the organization does not trust cannot issue a certificate', async () => {
    const other = path.join(root, `impostor-${counter}`);
    await provisionIssuer(other, 'acme', 'admin');
    // the impostor directory has its own organization; swap in a different "admin" key that its trust root does not list
    const strangers = path.join(root, `stranger-keys-${counter}`);
    await generateKeyProfile({ name: 'admin', keysDir: strangers, now: NOW });
    rmSync(path.join(other, 'keys', 'admin.key'), { force: true });
    writeFileSync(path.join(other, 'keys', 'admin.key'), readFileSync(path.join(strangers, 'admin.key')));
    process.env.CODEXREV_ADMIN_DIR = other;
    await runInit({ cwd: project, ...provider, authorization: scripted(), now: () => NOW });
    expect(process.exitCode).toBe(1);
    expect(errors.join('')).toMatch(/not trusted for signing certificates/);
    expect(await readProjectAuthorization(project)).toBeUndefined();
  });

  it('a malformed request is refused before anything is written', async () => {
    await runInit({ cwd: project, ...provider, authorization: scripted({ level: 'L9' }) });
    expect(process.exitCode).toBe(2);
    expect(errors.join('')).toMatch(/--level must be one of L1, L2, L3, L4, L5/);
    expect(await loadProjectConfig(project)).toBeNull();
  });
});

describe('an existing certificate is never replaced by init', () => {
  it('re-running init shows it, asks nothing and changes nothing', async () => {
    await onboard();
    const before = snapshot(path.join(project, '.codexrev'));
    const p = prompter([]);
    await runInit({ cwd: project, ...provider, nonInteractive: false, authPrompter: p, now: () => NOW });
    const screen = logs.join('\n');
    expect(screen).toContain('Employee authorization is already configured.');
    expect(screen).toContain('Employee: Alice');
    expect(screen).toContain('Authorization Level: L2');
    expect(screen).toContain('Certificate Status: Active');
    expect(screen).toContain('Authorization changes require administrator credentials.');
    expect(p.asked).toEqual([]);
    expect(snapshot(path.join(project, '.codexrev'))).toEqual(before);
  });

  it('selecting a higher level is refused and the certificate stays as it was', async () => {
    await onboard('L2');
    const before = snapshot(path.join(project, '.codexrev'));
    await runInit({ cwd: project, ...provider, authorization: scripted({ level: 'L5' }), now: () => NOW });
    expect(process.exitCode).toBe(1);
    expect(errors.join('')).toMatch(/NOT applied: init never replaces an existing certificate/);
    expect(await readProjectAuthorization(project)).toMatchObject({ level: 'l2' });
    expect(snapshot(path.join(project, '.codexrev'))).toEqual(before);
  });

  it('init --reset replaces only the provider configuration', async () => {
    await onboard();
    const record = await readProjectAuthorization(project);
    const cert = await certificatePath();
    const before = readFileSync(cert, 'utf-8');
    await runInit({ cwd: project, ...provider, model: 'gpt-4.1', reset: true, authorization: scripted({ level: 'L5' }), now: () => NOW });
    expect(await loadProjectConfig(project)).toMatchObject({ model: 'gpt-4.1' });
    expect(await readProjectAuthorization(project)).toEqual(record);
    expect(readFileSync(cert, 'utf-8')).toBe(before);
  });

  it('removing the record and running init with some other signing authority is refused: the project fingerprint was provisioned outside the project', async () => {
    await onboard();
    rmSync(projectAuthorizationPaths(project).recordFile);
    const other = path.join(root, `own-authority-${counter}`);
    await provisionIssuer(other, 'acme');
    process.env.CODEXREV_ADMIN_DIR = other;
    await runInit({ cwd: project, ...provider, authorization: scripted({ level: 'L5' }), now: () => NOW });
    expect(process.exitCode).toBe(1);
    expect(errors.join('')).toMatch(/different trust-root fingerprint is already provisioned/);
    expect(await readProjectAuthorization(project)).toBeUndefined();
  });
});

describe('strict assessment finds and verifies the certificate automatically', () => {
  it('a valid L1 certificate is discovered with nothing typed, and the assessment runs on its permissions', async () => {
    gitProject();
    await onboard('L1');
    const options = await strictOptionsFromProject(project, { action: 'code_change', environment: 'development', target: 'x' });
    expect(options.grantFile).toBe(await certificatePath());
    const r = await assess('code_change', 'development');
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/Developer grant:\s+VERIFIED/);
    expect(r.text).toMatch(/Final Decision: ALLOW/);
  });

  it('authorization levels are enforced: an L2 certificate verifies but cannot deploy to production', async () => {
    gitProject();
    await onboard('L2');
    const r = await assess('deployment', 'production');
    expect(r.code).toBe(11);
    expect(r.text).toMatch(/Developer grant:\s+VERIFIED/);
    expect(r.text).toMatch(/permission_missing|role_missing/);
  });

  it('an L4 certificate may request a production deployment and it is still assessed by the safety gates', async () => {
    gitProject();
    await onboard('L4');
    const r = await assess('deployment', 'production');
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/Safety Score/);
  });

  it('a certificate edited from L2 to L5 fails the signature check: BLOCK', async () => {
    gitProject();
    await onboard('L2');
    const cert = await certificatePath();
    chmodSync(cert, 0o644); // read-only is only a safeguard; the signature is the protection
    const env = JSON.parse(readFileSync(cert, 'utf-8'));
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    writeFileSync(cert, JSON.stringify({ ...env, payload: Buffer.from(JSON.stringify({ ...doc, roles: ['l5'] })).toString('base64url') }));
    const r = await assess('deployment', 'production');
    expect(r.code).toBe(11);
    expect(r.text).toMatch(/Final Decision: BLOCK/);
    expect(r.text).toMatch(/signature_verification_failed/);
  });

  it('editing the employee name or id in the certificate also breaks the signature', async () => {
    gitProject();
    await onboard('L2');
    const cert = await certificatePath();
    chmodSync(cert, 0o644);
    const env = JSON.parse(readFileSync(cert, 'utf-8'));
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    writeFileSync(cert, JSON.stringify({ ...env, payload: Buffer.from(JSON.stringify({ ...doc, subject: { ...doc.subject, displayName: 'Mallory' } })).toString('base64url') }));
    expect((await assess()).text).toMatch(/signature_verification_failed/);
  });

  it('a certificate signed with the employee own key is rejected: BLOCK', async () => {
    gitProject();
    await onboard('L2');
    const cert = await certificatePath();
    const key = await loadPrivateKey({ name: 'emp-emp001', keysDir: path.join(home, 'keys') });
    const env = JSON.parse(readFileSync(cert, 'utf-8'));
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    chmodSync(cert, 0o644);
    writeFileSync(cert, JSON.stringify(signEnvelope({ domain: 'grant', payload: Buffer.from(JSON.stringify({ ...doc, roles: ['l5'] })), privateKey: key.privateKey })));
    const r = await assess('deployment', 'production');
    expect(r.code).toBe(11);
    expect(r.text).toMatch(/unknown_signing_key/);
  });

  it('an expired certificate is rejected', async () => {
    gitProject();
    await onboard('L1', { grantDays: 1 });
    const r = await assess('code_change', 'development', later(2));
    expect(r.code).toBe(11);
    expect(r.text).toMatch(/grant_expired/);
    expect((await projectAuthorizationStatus(project, later(2)))?.status).toBe('Expired');
  });

  it('a revoked certificate is rejected once the revocation is refreshed from the issuer folder', async () => {
    gitProject();
    await onboard('L1');
    const grantId = (await readProjectAuthorization(project))!.grantId;
    await revokeGrants({ dir: path.join(adminDir, 'authority'), adminKey: 'admin', keysDir: path.join(adminDir, 'keys'), grantIds: [grantId], now: NOW });
    await refreshProjectAuthority(project, path.join(adminDir, 'authority'), NOW);
    const r = await assess('code_change', 'development');
    expect(r.code).toBe(11);
    expect(r.text).toMatch(/grant_revoked/);
    expect((await projectAuthorizationStatus(project, NOW))?.status).toBe('Revoked');
    // revocation of this test's certificate does not affect other projects' tests: use a fresh grant next time
  });

  it('replacing the project files with an attacker organization is refused: the independently trusted fingerprint does not match', async () => {
    gitProject();
    await onboard('L1');
    const attacker = path.join(root, `attacker-${counter}`);
    await provisionIssuer(attacker, 'acme', 'evil-admin');
    const evilKeys = path.join(attacker, 'keys');
    const { issueGrant } = await import('../../src/features/action-safety/strict/admin.js');
    const record = (await readProjectAuthorization(project))!;
    const g = await issueGrant({ dir: path.join(attacker, 'authority'), adminKey: 'evil-admin', keysDir: evilKeys, subject: 'EMP001', pubkeyFile: path.join(home, 'keys', 'emp-emp001.pub.json'), roles: ['l5'], days: 30, now: NOW });
    const { authorityDir, recordFile } = projectAuthorizationPaths(project);
    rmSync(authorityDir, { recursive: true, force: true });
    mkdirp(path.join(authorityDir, 'grants'));
    for (const f of ['trust-root.json', 'policy.signed.json', 'revocation.signed.json']) writeFileSync(path.join(authorityDir, f), readFileSync(path.join(attacker, 'authority', f)));
    writeFileSync(path.join(authorityDir, 'grants', `${g.grantId}.grant.json`), readFileSync(g.file));
    const evilPin = (await import('../../src/features/action-safety/strict/authority.js')).trustRootFingerprint(readFileSync(path.join(authorityDir, 'trust-root.json')));
    writeFileSync(recordFile, JSON.stringify({ ...record, trustRootSha256: evilPin, grantId: g.grantId, grantFile: `authority/grants/${g.grantId}.grant.json`, level: 'l5' }));
    const r = await assess('deployment', 'production');
    expect(r.code).toBe(3);
    expect(r.text).toMatch(/different trust root than the independently trusted fingerprint/);
    expect(r.text).not.toMatch(/Final Decision/);
  });

  it('without any independently trusted fingerprint the assessment fails safely', async () => {
    gitProject();
    await onboard('L1');
    rmSync(trustedRootsPath(), { force: true });
    const r = await assess();
    expect(r.code).toBe(3);
    expect(r.text).toMatch(/no independently trusted trust-root fingerprint.*CODEXREV_TRUST_ROOT_SHA256/);
  });

  it('a fingerprint supplied from outside that differs from the record is refused, and a matching one works', async () => {
    gitProject();
    await onboard('L1');
    expect((await assess('code_change', 'development', NOW, { CODEXREV_TRUST_ROOT_SHA256: 'a'.repeat(64) })).code).toBe(3);
    const pin = (await readTrustedFingerprint(project))!;
    rmSync(trustedRootsPath(), { force: true });
    expect((await assess('code_change', 'development', NOW, { CODEXREV_TRUST_ROOT_SHA256: pin })).code).toBe(0);
  });

  it('with no saved certificate, or a malformed record, assessment stops: no fall-back to claims in an input file', async () => {
    gitProject();
    const none = await assess();
    expect(none.code).toBe(3);
    expect(none.text).toMatch(/no signed authorization is set up.*Self-declared authorization is never accepted/);
    mkdirp(path.join(project, '.codexrev'));
    writeFileSync(path.join(project, '.codexrev', 'authorization.json'), JSON.stringify({ version: 1, level: 'l5' }));
    const bad = await assess();
    expect(bad.code).toBe(3);
    expect(bad.text).toMatch(/not valid/);
    expect(bad.text).not.toMatch(/Final Decision/);
  });
});

describe('the challenge-store key cannot act as the issuer', () => {
  it('it cannot sign a certificate, a policy or a revocation list that verifies', async () => {
    await onboard('L1');
    const authority = await loadAuthority(projectAuthorizationPaths(project).authorityDir, NOW);
    const store = await loadPrivateKey({ name: 'store', keysDir: path.join(home, 'keys') });
    const sign = (domain: 'grant' | 'policy' | 'revocation', file: string) => signEnvelope({ domain, payload: Buffer.from((JSON.parse(readFileSync(file, 'utf-8')) as { payload: string }).payload, 'base64url'), privateKey: store.privateKey });
    const dir = projectAuthorizationPaths(project).authorityDir;
    expect(verifyGrant(sign('grant', await certificatePath()), authority.trustRoot, authority.policy, NOW)).toMatchObject({ ok: false, code: 'key_purpose_not_allowed' });
    expect(verifyPolicy(sign('policy', path.join(dir, 'policy.signed.json')), authority.trustRoot, NOW)).toMatchObject({ ok: false, code: 'key_purpose_not_allowed' });
    expect(verifyRevocationList(sign('revocation', path.join(dir, 'revocation.signed.json')), authority.trustRoot, NOW)).toMatchObject({ ok: false });
  });
});

function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
