// Key profiles and organization initialization. Generated artifacts are checked with the EXISTING verifiers.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyId } from '../../../../src/features/action-safety/authorization/envelope.js';
import { verifyPolicy, requirementsFor } from '../../../../src/features/action-safety/authorization/policy.js';
import { verifyRevocationList } from '../../../../src/features/action-safety/authorization/revocation.js';
import { findTrustedKey, parseTrustRootBytes } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import { initOrganization } from '../../../../src/features/action-safety/strict/admin.js';
import { AUTHORITY_FILES, REVOCATION_MAX_AGE_HOURS, loadAuthority } from '../../../../src/features/action-safety/strict/authority.js';
import { generateKeyProfile, loadPrivateKey, readPublicKeyFile, validateKeyName, WINDOWS_KEY_WARNING } from '../../../../src/features/action-safety/strict/keyStore.js';
import { StrictCliError } from '../../../../src/features/action-safety/strict/files.js';
import { runStrictCli } from '../../../../src/features/action-safety/strict/run.js';
import { NOW } from '../../../../src/features/action-safety/testing/strictFixture.js';

let root: string;
let counter = 0;
const fresh = (name: string): string => join(root, `${name}-${++counter}`);
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'codexrev-strict-keys-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const rejects = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof StrictCliError ? e.message : `unexpected: ${String(e)}`;
  }
};

describe('key generation', () => {
  it('creates a real Ed25519 key pair whose id is the existing key id, and a validated shareable public file', async () => {
    const keysDir = fresh('keys');
    const made = await generateKeyProfile({ name: 'alice', keysDir, now: NOW });
    const loaded = await loadPrivateKey({ name: 'alice', keysDir, platform: 'win32' });
    expect(loaded.keyId).toBe(made.keyId);
    expect(loaded.keyId).toBe(deriveKeyId(loaded.publicKey));
    expect(loaded.privateKey.asymmetricKeyType).toBe('ed25519');
    const pub = await readPublicKeyFile(made.publicPath);
    expect(pub.keyId).toBe(made.keyId);
    expect(pub.publicKeyRaw).toBe(loaded.publicKeyRaw);
    expect(readdirSync(keysDir).sort()).toEqual(['alice.key', 'alice.pub.json']);
  });

  it('gives every key its own id', async () => {
    const keysDir = fresh('keys');
    const ids = new Set<string>();
    for (const name of ['a1', 'a2', 'a3', 'a4']) ids.add((await generateKeyProfile({ name, keysDir, now: NOW })).keyId);
    expect(ids.size).toBe(4);
  });

  it('never overwrites an existing key, and leaves it untouched', async () => {
    const keysDir = fresh('keys');
    const first = await generateKeyProfile({ name: 'alice', keysDir, now: NOW });
    const before = readFileSync(first.privatePath, 'utf-8');
    expect(await rejects(generateKeyProfile({ name: 'alice', keysDir, now: NOW }))).toMatch(/already exists/);
    expect(readFileSync(first.privatePath, 'utf-8')).toBe(before);
    // a lone leftover public file also blocks the name
    writeFileSync(join(keysDir, 'bob.pub.json'), '{}');
    expect(await rejects(generateKeyProfile({ name: 'bob', keysDir, now: NOW }))).toMatch(/already exists/);
  });

  it('refuses names that could escape the keys directory or are not simple words', async () => {
    const keysDir = fresh('keys');
    for (const bad of ['../evil', '..\\evil', 'a/b', 'a\\b', '', ' ', 'A', 'ALICE', 'a.b', '.hidden', '-x', 'x'.repeat(33), 'a b', 'a\0b', '..', 'C:evil', 5, null, undefined]) {
      expect(() => validateKeyName(bad), String(bad)).toThrow(StrictCliError);
      expect(await rejects(generateKeyProfile({ name: bad as string, keysDir, now: NOW })), String(bad)).toMatch(/key name/);
    }
    expect(readdirSync(root).filter((n) => n.startsWith('evil'))).toEqual([]);
    expect(validateKeyName('alice')).toBe('alice');
    expect(validateKeyName('lead-1_a')).toBe('lead-1_a');
  });

  it('refuses a keys directory inside a Git working tree', async () => {
    const repo = fresh('repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(await rejects(generateKeyProfile({ name: 'alice', keysDir: join(repo, 'keys'), now: NOW }))).toMatch(/Git working tree/);
    expect(await rejects(generateKeyProfile({ name: 'alice', keysDir: join(repo, 'a', 'b', 'keys'), now: NOW }))).toMatch(/Git working tree/);
    expect(readdirSync(repo)).toEqual(['.git']); // nothing was written there
    await expect(loadPrivateKey({ name: 'alice', keysDir: join(repo, 'keys') })).rejects.toThrow(/Git working tree/);
  });

  it('refuses a keys directory that is a link or a file', async () => {
    const real = fresh('real');
    mkdirSync(real);
    const link = fresh('link');
    let linked = true;
    try {
      symlinkSync(real, link, 'junction');
    } catch {
      linked = false;
    }
    if (linked) expect(await rejects(generateKeyProfile({ name: 'alice', keysDir: link, now: NOW }))).toMatch(/real directory/);
    const file = fresh('file');
    writeFileSync(file, 'x');
    expect(await rejects(generateKeyProfile({ name: 'alice', keysDir: file, now: NOW }))).toMatch(/real directory/);
  });

  it('stores the private key in a file that is not world-readable on POSIX, and says plainly what Windows does not provide', async () => {
    const keysDir = fresh('keys');
    const made = await generateKeyProfile({ name: 'alice', keysDir, now: NOW });
    if (process.platform !== 'win32') expect(statSync(made.privatePath).mode & 0o077).toBe(0);
    expect(made.warnings).toEqual(process.platform === 'win32' ? [WINDOWS_KEY_WARNING] : []);
    expect((await generateKeyProfile({ name: 'carol', keysDir, now: NOW, platform: 'win32' })).warnings).toEqual([WINDOWS_KEY_WARNING]);
    expect((await generateKeyProfile({ name: 'dave', keysDir, now: NOW, platform: 'linux' })).warnings).toEqual([]);
    expect(WINDOWS_KEY_WARNING).toMatch(/not checked or enforced/);
    expect(WINDOWS_KEY_WARNING).not.toMatch(/secure|safe/i);
  });

  it('refuses to load a key readable by others (POSIX rule), a non-Ed25519 key and a garbage file', async () => {
    const keysDir = fresh('keys');
    await generateKeyProfile({ name: 'alice', keysDir, now: NOW });
    // this host's modes are not POSIX modes; asking for the POSIX rule shows the refusal path
    if (process.platform === 'win32') expect(await rejects(loadPrivateKey({ name: 'alice', keysDir, platform: 'linux' }))).toMatch(/readable by other accounts/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    writeFileSync(join(keysDir, 'rsa.key'), rsa, { mode: 0o600 });
    expect(await rejects(loadPrivateKey({ name: 'rsa', keysDir, platform: 'win32' }))).toMatch(/not an Ed25519 key/);
    writeFileSync(join(keysDir, 'junk.key'), 'not a key', { mode: 0o600 });
    expect(await rejects(loadPrivateKey({ name: 'junk', keysDir, platform: 'win32' }))).toMatch(/could not be read/);
    expect(await rejects(loadPrivateKey({ name: 'nobody', keysDir }))).toMatch(/keygen --name nobody/);
  });

  it('rejects a tampered or inconsistent public key file', async () => {
    const keysDir = fresh('keys');
    const a = await generateKeyProfile({ name: 'alice', keysDir, now: NOW });
    const b = await generateKeyProfile({ name: 'bob', keysDir, now: NOW });
    const doc = JSON.parse(readFileSync(a.publicPath, 'utf-8'));
    const file = join(keysDir, 'tampered.pub.json');
    writeFileSync(file, JSON.stringify({ ...doc, keyId: b.keyId }));
    expect(await rejects(readPublicKeyFile(file))).toMatch(/inconsistent/);
    writeFileSync(file, JSON.stringify({ ...doc, publicKey: 'AAAA' }));
    expect(await rejects(readPublicKeyFile(file))).toMatch(/valid Ed25519/);
    writeFileSync(file, JSON.stringify({ ...doc, extra: 1 }));
    expect(await rejects(readPublicKeyFile(file))).toMatch(/unexpected format/);
    writeFileSync(file, 'nope');
    expect(await rejects(readPublicKeyFile(file))).toMatch(/not valid JSON/);
  });

  it('never prints or logs the private key, in any command output', async () => {
    const keysDir = fresh('keys');
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => NOW };
    expect(await runStrictCli(['keygen', '--name', 'alice', '--keys-dir', keysDir], io)).toBe(0);
    expect(await runStrictCli(['keygen', '--name', 'alice', '--keys-dir', keysDir], io)).toBe(1);
    expect(await runStrictCli(['keygen', '--name', '../x', '--keys-dir', keysDir], io)).toBe(1);
    const loaded = await loadPrivateKey({ name: 'alice', keysDir, platform: 'win32' });
    const secrets = [String(loaded.privateKey.export({ format: 'jwk' }).d), readFileSync(join(keysDir, 'alice.key'), 'utf-8').split('\n')[1] ?? 'x', 'BEGIN PRIVATE KEY'];
    const everything = [...out, ...err].join('\n');
    for (const s of secrets) expect(everything).not.toContain(s);
    expect(everything).toContain(loaded.keyId);
  });
});

describe('organization initialization', () => {
  const setupKeys = async (names: string[] = ['admin']): Promise<string> => {
    const keysDir = fresh('keys');
    for (const n of names) await generateKeyProfile({ name: n, keysDir, now: NOW });
    return keysDir;
  };

  it('creates a trust root, a signed policy and a signed revocation list that the existing verifiers accept', async () => {
    const keysDir = await setupKeys();
    const dir = fresh('authority');
    const r = await initOrganization({ organization: 'acme', dir, adminKey: 'admin', keysDir, now: NOW });
    const a = await loadAuthority(dir, NOW);
    expect(a.organization).toBe('acme');
    expect(r.adminKeyId).toBe((await loadPrivateKey({ name: 'admin', keysDir, platform: 'win32' })).keyId);
    for (const purpose of ['policy', 'grant', 'revocation'] as const) expect(findTrustedKey(a.trustRoot, r.adminKeyId, purpose, NOW).ok).toBe(true);
    expect(findTrustedKey(a.trustRoot, r.adminKeyId, 'challenge_store', NOW).ok).toBe(false);
    // independent re-verification, straight from the files
    const rootFile = parseTrustRootBytes(readFileSync(join(dir, AUTHORITY_FILES.trustRoot)));
    expect(rootFile.ok).toBe(true);
    if (!rootFile.ok) return;
    expect(verifyPolicy(JSON.parse(readFileSync(join(dir, AUTHORITY_FILES.policy), 'utf-8')), rootFile.trustRoot, NOW).ok).toBe(true);
    const list = verifyRevocationList(JSON.parse(readFileSync(join(dir, AUTHORITY_FILES.revocation), 'utf-8')), rootFile.trustRoot, NOW, { maxAgeHours: REVOCATION_MAX_AGE_HOURS });
    expect(list.ok && list.list.listVersion).toBe(1);
    expect(list.ok && list.list.revokedGrantIds).toEqual([]);
  });

  it('writes a deny-by-default demo policy: only the ten predefined level rules exist', async () => {
    const keysDir = await setupKeys();
    const dir = fresh('authority');
    await initOrganization({ organization: 'acme', dir, adminKey: 'admin', keysDir, now: NOW });
    const { policy } = await loadAuthority(dir, NOW);
    const dev = requirementsFor(policy, 'code_change', 'development');
    expect(dev).toMatchObject({ permitted: true, requiredRoles: ['l1', 'l2', 'l3', 'l4', 'l5'], requiredPermissions: ['code.modify'] });
    const prod = requirementsFor(policy, 'deployment', 'production');
    expect(prod).toMatchObject({ permitted: true, requiredRoles: ['l4', 'l5'], requiredPermissions: ['deployment.production'] });
    // no separate approval: the answer has no approval fields at all
    expect(prod).not.toHaveProperty('requiredIndependentApprovals');
    expect(prod).not.toHaveProperty('approverRoles');
    for (const [action, env] of [['code_change', 'production'], ['code_change', 'staging'], ['deployment', 'development'], ['deployment', 'testing'], ['rollback', 'staging'], ['rollback', 'development'], ['dependency_upgrade', 'production'], ['dependency_upgrade', 'testing'], ['code_change', 'testing']] as const) {
      expect(requirementsFor(policy, action, env), `${action} in ${env}`).toMatchObject({ permitted: false });
    }
    expect(requirementsFor(policy, 'launch_missiles', 'production')).toMatchObject({ permitted: false, reason: 'unknown_action' });
    expect(requirementsFor(policy, 'deployment', 'moon')).toMatchObject({ permitted: false, reason: 'unknown_environment' });
  });

  it('never writes the administrator private key into the authority directory', async () => {
    const keysDir = await setupKeys();
    const dir = fresh('authority');
    await initOrganization({ organization: 'acme', dir, adminKey: 'admin', keysDir, now: NOW });
    const admin = await loadPrivateKey({ name: 'admin', keysDir, platform: 'win32' });
    const secret = String(admin.privateKey.export({ format: 'jwk' }).d);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(dir)) {
      const text = readFileSync(f, 'utf-8');
      expect(text, f).not.toContain(secret);
      expect(text, f).not.toContain('PRIVATE KEY');
      expect(f).not.toMatch(/\.key$/);
    }
  });

  it('refuses a keys directory inside the authority directory (and the other way round)', async () => {
    const dir = fresh('authority');
    const keysInside = join(dir, 'keys');
    await generateKeyProfile({ name: 'admin', keysDir: keysInside, now: NOW });
    expect(await rejects(initOrganization({ organization: 'acme', dir, adminKey: 'admin', keysDir: keysInside, now: NOW }))).toMatch(/must be separate/);
    const outer = fresh('outer');
    const authorityInsideKeys = join(outer, 'authority');
    await generateKeyProfile({ name: 'admin', keysDir: outer, now: NOW });
    expect(await rejects(initOrganization({ organization: 'acme', dir: authorityInsideKeys, adminKey: 'admin', keysDir: outer, now: NOW }))).toMatch(/must be separate/);
  });

  it('never overwrites an existing organization', async () => {
    const keysDir = await setupKeys(['admin', 'other']);
    const dir = fresh('authority');
    await initOrganization({ organization: 'acme', dir, adminKey: 'admin', keysDir, now: NOW });
    const before = Object.fromEntries([AUTHORITY_FILES.trustRoot, AUTHORITY_FILES.policy, AUTHORITY_FILES.revocation].map((f) => [f, readFileSync(join(dir, f), 'utf-8')]));
    expect(await rejects(initOrganization({ organization: 'acme', dir, adminKey: 'admin', keysDir, now: NOW }))).toMatch(/already initialized/);
    expect(await rejects(initOrganization({ organization: 'evil', dir, adminKey: 'other', keysDir, now: NOW }))).toMatch(/already initialized/);
    for (const [f, text] of Object.entries(before)) expect(readFileSync(join(dir, f), 'utf-8'), f).toBe(text);
    // a half-prepared directory (one of the files present) is also refused, and nothing else is written
    const partial = fresh('partial');
    mkdirSync(partial);
    writeFileSync(join(partial, AUTHORITY_FILES.policy), 'x');
    expect(await rejects(initOrganization({ organization: 'acme', dir: partial, adminKey: 'admin', keysDir, now: NOW }))).toMatch(/already initialized/);
    expect(readdirSync(partial)).toEqual([AUTHORITY_FILES.policy]);
  });

  it('lists an optional challenge-store key in the trust root, with only that purpose', async () => {
    const keysDir = await setupKeys(['admin', 'store']);
    const dir = fresh('authority');
    const r = await initOrganization({ organization: 'acme', dir, adminKey: 'admin', storeKey: 'store', keysDir, now: NOW });
    const a = await loadAuthority(dir, NOW);
    expect(r.storeKeyId).toBeDefined();
    expect(findTrustedKey(a.trustRoot, r.storeKeyId, 'challenge_store', NOW).ok).toBe(true);
    expect(findTrustedKey(a.trustRoot, r.storeKeyId, 'grant', NOW).ok).toBe(false);
    expect(await rejects(initOrganization({ organization: 'acme', dir: fresh('authority'), adminKey: 'admin', storeKey: 'admin', keysDir, now: NOW }))).toMatch(/different key/);
  });

  it('refuses bad input before writing anything', async () => {
    const keysDir = await setupKeys();
    for (const org of ['Acme', 'a b', '', '../x', 'x'.repeat(65)]) {
      const dir = fresh('authority');
      expect(await rejects(initOrganization({ organization: org, dir, adminKey: 'admin', keysDir, now: NOW })), org).toMatch(/organization id/);
      expect(() => readdirSync(dir)).toThrow();
    }
    for (const days of [0, -1, 1.5, 4000]) expect(await rejects(initOrganization({ organization: 'acme', dir: fresh('authority'), adminKey: 'admin', keysDir, now: NOW, policyDays: days })), String(days)).toMatch(/--policy-days/);
    expect(await rejects(initOrganization({ organization: 'acme', dir: fresh('authority'), adminKey: 'nobody', keysDir, now: NOW }))).toMatch(/keygen --name nobody/);
  });

  it('is available through the command line with readable results', async () => {
    const keysDir = await setupKeys();
    const dir = fresh('authority');
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => NOW };
    expect(await runStrictCli(['admin', 'init', '--org', 'acme', '--dir', dir, '--admin-key', 'admin', '--keys-dir', keysDir], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Initialized organization "acme"/);
    expect(out.join('\n')).toMatch(/NOT written to the authority directory/);
    expect(await runStrictCli(['admin', 'init', '--org', 'acme', '--dir', dir, '--admin-key', 'admin', '--keys-dir', keysDir], io)).toBe(1);
    expect(err.join('\n')).toMatch(/already initialized/);
  });
});
