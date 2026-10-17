// Signed grants and revocation. Every generated artifact is re-checked with the existing verifiers.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { permissionsOfLevel } from '../../../../src/features/action-safety/authorization/levels.js';
import { effectivePermissions, levelOf, verifyGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { checkRevocation, verifyRevocationList } from '../../../../src/features/action-safety/authorization/revocation.js';
import { issueGrant, revokeGrants } from '../../../../src/features/action-safety/strict/admin.js';
import { AUTHORITY_FILES, REVOCATION_MAX_AGE_HOURS, loadAuthority } from '../../../../src/features/action-safety/strict/authority.js';
import { StrictCliError, readJsonFile } from '../../../../src/features/action-safety/strict/files.js';
import { generateKeyProfile, loadPrivateKey } from '../../../../src/features/action-safety/strict/keyStore.js';
import { runStrictCli } from '../../../../src/features/action-safety/strict/run.js';
import { NOW, later, setupOrganization, verifiedGrantOf, type Fixture } from '../../../../src/features/action-safety/testing/strictFixture.js';

let f: Fixture;
beforeAll(async () => {
  f = await setupOrganization({ withRepo: false });
});
afterAll(() => f.cleanup());

const rejects = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof StrictCliError ? e.message : `unexpected: ${String(e)}`;
  }
};
const grantsDir = (): string => join(f.authorityDir, AUTHORITY_FILES.grantsDir);
const issue = (over: Partial<Parameters<typeof issueGrant>[0]> = {}) =>
  issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'alice', pubkeyFile: join(f.keysDir, 'alice.pub.json'), roles: ['l1'], days: 30, now: NOW, ...over });

describe('grants', () => {
  it('issues an L1 grant that the existing verifier accepts, with the policy revision and the expiry', async () => {
    const g = await verifiedGrantOf(f, f.grants.bob);
    expect(g.grant).toMatchObject({ organization: 'acme', roles: ['l1'], minPolicyRevision: f.authority.policy.revision, permissionScope: null });
    expect(g.grant.subject).toMatchObject({ id: 'bob', type: 'human' });
    expect(Date.parse(g.grant.expiresAt) - Date.parse(g.grant.notBefore)).toBe(30 * 24 * 3600 * 1000);
    expect(g.policyRevision).toBe(f.authority.policy.revision);
    // the permissions come from the SIGNED POLICY, not from anything in the grant
    const eff = effectivePermissions(g, f.authority.policy);
    expect(eff).toMatchObject({ ok: true, permissions: ['code.modify'] });
    expect(levelOf(g)).toBe('l1');
  });

  it('issues an L2 grant with exactly the L2 permissions, from the registry and not from the grant', async () => {
    const g = await verifiedGrantOf(f, f.grants.lead1);
    expect(g.grant.roles).toEqual(['l2']);
    expect(effectivePermissions(g, f.authority.policy)).toMatchObject({ ok: true, permissions: permissionsOfLevel('l2') });
  });

  it('gives every grant a unique id, even for the same subject', async () => {
    const a = await issue();
    const b = await issue();
    expect(a.grantId).not.toBe(b.grantId);
    expect(new Set(readdirSync(grantsDir())).size).toBe(readdirSync(grantsDir()).length);
  });

  it('refuses a key that is not an authorized issuer in the trust root', async () => {
    expect(await rejects(issue({ adminKey: 'mallory' }))).toMatch(/not an authorized grant issuer/);
    expect(await rejects(issue({ adminKey: 'alice' }))).toMatch(/not an authorized grant issuer/);
    expect(await rejects(issue({ adminKey: 'nobody' }))).toMatch(/keygen --name nobody/);
  });

  it('a grant signed by anyone else does not verify, even with the same content', async () => {
    const mallory = await loadPrivateKey({ name: 'mallory', keysDir: f.keysDir, platform: 'win32' });
    const real = await readJsonFile(f.grants.bob.file, 'grant');
    const payload = (real as { payload: string }).payload;
    const forged = signEnvelope({ domain: 'grant', payload: Buffer.from(payload, 'base64url'), privateKey: mallory.privateKey });
    const r = verifyGrant(forged, f.authority.trustRoot, f.authority.policy, NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('unknown_signing_key');
  });

  it('an expired grant no longer verifies, and a not-yet-valid moment is refused too', async () => {
    const short = await issue({ days: 1, roles: ['l1'] });
    const env = await readJsonFile(short.file, 'grant');
    expect(verifyGrant(env, f.authority.trustRoot, f.authority.policy, NOW).ok).toBe(true);
    const expired = verifyGrant(env, f.authority.trustRoot, f.authority.policy, later(2));
    expect(!expired.ok && expired.code).toBe('grant_expired');
    const early = verifyGrant(env, f.authority.trustRoot, f.authority.policy, new Date(NOW.getTime() - 3600_000));
    expect(early.ok).toBe(false);
  });

  it('a tampered grant fails: extra roles, a longer expiry or a swapped subject key cannot be added by editing the file', async () => {
    const file = f.grants.bob.file;
    const env = (await readJsonFile(file, 'grant')) as { payload: string; signature: string; [k: string]: unknown };
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['more levels', { roles: ['l1', 'l5'] }],
      ['a higher level (L1 edited to L5)', { roles: ['l5'] }],
      ['a longer expiry', { expiresAt: '2030-01-01T00:00:00Z' }],
      ['a lower policy requirement', { minPolicyRevision: 0 }],
      ['a permission scope', { permissionScope: ['code.modify'] }],
      ['another subject', { subject: { ...doc.subject, id: 'lead1' } }],
    ];
    for (const [label, change] of attempts) {
      const edited = { ...env, payload: Buffer.from(JSON.stringify({ ...doc, ...change })).toString('base64url') };
      const r = verifyGrant(edited, f.authority.trustRoot, f.authority.policy, NOW);
      expect(r.ok, label).toBe(false);
      expect(!r.ok && r.code, label).toBe('signature_verification_failed');
    }
    const flipped = { ...env, signature: env.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
    expect(verifyGrant(flipped, f.authority.trustRoot, f.authority.policy, NOW).ok).toBe(false);
    // the edits above never touched the real file
    expect(verifyGrant(await readJsonFile(file, 'grant'), f.authority.trustRoot, f.authority.policy, NOW).ok).toBe(true);
  });

  it('refuses roles and permissions the signed policy does not define, before anything is written', async () => {
    const before = readdirSync(grantsDir()).length;
    expect(await rejects(issue({ roles: ['admin'] }))).toMatch(/unsupported role "admin"/);
    expect(await rejects(issue({ roles: ['l1', 'root'] }))).toMatch(/unsupported role "root"/);
    expect(await rejects(issue({ roles: [] }))).toMatch(/at least one/);
    // under the level policy a grant names exactly one level
    expect(await rejects(issue({ roles: ['l1', 'l2'] }))).toMatch(/exactly one CodeXRev level/);
    expect(await rejects(issue({ roles: ['l1'], permissionScope: ['deployment.staging'] }))).toMatch(/not acceptable under the signed policy/);
    expect(await rejects(issue({ roles: ['l1'], permissionScope: ['deployment.production'] }))).toMatch(/not acceptable under the signed policy/); // escalation beyond the level
    expect(readdirSync(grantsDir()).length).toBe(before);
  });

  it('can narrow the permissions a role gives, but never widen them', async () => {
    const narrow = await issue({ roles: ['l4'], permissionScope: ['code.modify'] });
    const g = await verifiedGrantOf(f, narrow);
    expect(effectivePermissions(g, f.authority.policy)).toMatchObject({ ok: true, permissions: ['code.modify'] });
  });

  it('refuses bad input: expiry period, subject, and public key files', async () => {
    for (const days of [0, -5, 1.5, 91, 365, Number.NaN]) expect(await rejects(issue({ days })), String(days)).toMatch(/--days/);
    for (const subject of ['', ' ', '../x', 'a b', 'x'.repeat(129)]) expect(await rejects(issue({ subject })), subject).toMatch(/subject/);
    expect(await rejects(issue({ type: 'robot' as never }))).toMatch(/--type/);
    expect(await rejects(issue({ pubkeyFile: join(f.keysDir, 'nope.pub.json') }))).toMatch(/not found/);
    writeFileSync(join(f.root, 'bad.pub.json'), '{"version":1}');
    expect(await rejects(issue({ pubkeyFile: join(f.root, 'bad.pub.json') }))).toMatch(/unexpected format/);
    // a company signing key cannot be the subject of a grant
    expect(await rejects(issue({ pubkeyFile: join(f.keysDir, 'admin.pub.json') }))).toMatch(/company signing key/);
  });

  it('refuses a keys directory inside the authority directory', async () => {
    expect(await rejects(issue({ keysDir: join(f.authorityDir, 'keys') }))).toMatch(/must be separate/);
  });

  it('works through the command line, including a service account and the --level option', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => NOW };
    const base = ['admin', 'grant', '--dir', f.authorityDir, '--admin-key', 'admin', '--keys-dir', f.keysDir, '--pubkey', join(f.keysDir, 'bob.pub.json')];
    expect(await runStrictCli([...base, '--subject', 'ci-bot', '--level', 'L1', '--days', '10', '--type', 'service'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Issued grant grant-ci-bot-/);
    expect(await runStrictCli([...base, '--subject', 'bob2', '--level', 'l2', '--days', '10'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/level: +L2/);
    expect(await runStrictCli([...base, '--subject', 'x', '--role', 'l1,l2', '--days', '10'], io)).toBe(1); // two levels
    expect(await runStrictCli([...base, '--subject', 'x', '--level', 'L6', '--days', '10'], io)).toBe(2);
    expect(await runStrictCli([...base, '--subject', 'x', '--level', 'L1', '--role', 'l1', '--days', '10'], io)).toBe(2);
    expect(await runStrictCli([...base, '--subject', 'x', '--days', '10'], io)).toBe(2); // neither
    expect(await runStrictCli([...base, '--subject', 'x', '--role', 'admin', '--days', '10'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/unsupported role/);
    expect(await runStrictCli([...base, '--subject', 'x', '--level', 'L1'], io)).toBe(2); // --days missing
    expect(await runStrictCli([...base, '--subject', 'x', '--level', 'L1', '--days', 'ten'], io)).toBe(2);
    expect(await runStrictCli([...base, '--subject', 'x', '--level', 'L1', '--days', '3', '--bogus', '1'], io)).toBe(2);
  });
});

describe('revocation', () => {
  const current = async () => (await loadAuthority(f.authorityDir, NOW)).revocation;

  it('adds the grant to a re-signed list with a higher version, and the existing checker then reports it revoked', async () => {
    const victim = await issue({ subject: 'bob', pubkeyFile: join(f.keysDir, 'bob.pub.json') });
    const v = await verifiedGrantOf(f, victim);
    const before = await current();
    expect(checkRevocation(v, before, NOW).status).toBe('not_listed');
    const r = await revokeGrants({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, grantIds: [victim.grantId], now: NOW });
    expect(r).toMatchObject({ changed: true, listVersion: before.list.listVersion + 1 });
    const after = await current();
    expect(after.list.revokedGrantIds).toContain(victim.grantId);
    expect(after.list.listVersion).toBe(before.list.listVersion + 1);
    expect(checkRevocation(v, after, NOW)).toMatchObject({ status: 'revoked', revokedBy: ['grant_id'] });
    // other grants are unaffected
    expect(checkRevocation(await verifiedGrantOf(f, f.grants.lead1), after, NOW).status).toBe('not_listed');
    // the file on disk verifies independently
    const env = JSON.parse(readFileSync(join(f.authorityDir, AUTHORITY_FILES.revocation), 'utf-8'));
    expect(verifyRevocationList(env, f.authority.trustRoot, NOW, { maxAgeHours: REVOCATION_MAX_AGE_HOURS }).ok).toBe(true);
  });

  it('does not add a grant twice and does not change the version when nothing is new', async () => {
    const g = await issue({ subject: 'bob', pubkeyFile: join(f.keysDir, 'bob.pub.json') });
    await revokeGrants({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, grantIds: [g.grantId], now: NOW });
    const file = join(f.authorityDir, AUTHORITY_FILES.revocation);
    const bytes = readFileSync(file, 'utf-8');
    const version = (await current()).list.listVersion;
    const again = await revokeGrants({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, grantIds: [g.grantId, g.grantId], now: NOW });
    expect(again).toMatchObject({ changed: false, alreadyRevoked: [g.grantId], listVersion: version });
    expect(readFileSync(file, 'utf-8')).toBe(bytes); // not rewritten
    const list = (await current()).list.revokedGrantIds;
    expect(list.filter((x) => x === g.grantId)).toHaveLength(1);
    // a mix: one new, one old
    const h = await issue({ subject: 'bob', pubkeyFile: join(f.keysDir, 'bob.pub.json') });
    const mixed = await revokeGrants({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, grantIds: [g.grantId, h.grantId], now: NOW });
    expect(mixed).toMatchObject({ changed: true, listVersion: version + 1, alreadyRevoked: [g.grantId] });
  });

  it('increments the version by one with every change, and keeps earlier entries', async () => {
    const v0 = (await current()).list;
    const a = await issue();
    const b = await issue();
    await revokeGrants({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, grantIds: [a.grantId], now: NOW });
    await revokeGrants({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, grantIds: [b.grantId], now: NOW });
    const v2 = (await current()).list;
    expect(v2.listVersion).toBe(v0.listVersion + 2);
    expect(v2.revokedGrantIds).toEqual(expect.arrayContaining([...v0.revokedGrantIds, a.grantId, b.grantId]));
  });

  it('leaves no staging files behind', async () => {
    const names = readdirSync(f.authorityDir);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(grantsDir()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a key that is not an authorized revocation issuer, and invalid grant ids', async () => {
    expect(await rejects(revokeGrants({ dir: f.authorityDir, adminKey: 'mallory', keysDir: f.keysDir, grantIds: ['grant-x'], now: NOW }))).toMatch(/not an authorized revocation issuer/);
    for (const id of ['', '../x', 'a b', 'x'.repeat(70)]) expect(await rejects(revokeGrants({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, grantIds: [id], now: NOW })), id).toMatch(/not a valid grant id/);
  });

  it('refuses to build on a tampered list, so an attacker cannot make the administrator sign it', async () => {
    const file = join(f.authorityDir, AUTHORITY_FILES.revocation);
    const good = readFileSync(file, 'utf-8');
    const env = JSON.parse(good);
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    writeFileSync(file, JSON.stringify({ ...env, payload: Buffer.from(JSON.stringify({ ...doc, revokedGrantIds: [] })).toString('base64url') }));
    expect(await rejects(revokeGrants({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, grantIds: ['grant-x'], now: NOW }))).toMatch(/revocation list is not acceptable/);
    writeFileSync(file, good);
    expect((await current()).list.listVersion).toBeGreaterThan(0);
  });

  it('can renew a list that has become stale without losing its entries, and still refuses everything else while it is stale', async () => {
    const keysDir = join(f.root, 'keys-renew');
    await generateKeyProfile({ name: 'admin', keysDir, now: NOW });
    const { initOrganization } = await import('../../../../src/features/action-safety/strict/admin.js');
    const dir = join(f.root, 'authority-renew');
    await initOrganization({ organization: 'acme', dir, adminKey: 'admin', keysDir, now: NOW });
    const t1 = later(40);
    await expect(loadAuthority(dir, t1)).rejects.toThrow(/admin refresh-revocation/); // ordinary use is refused
    expect(await rejects(issueGrant({ dir, adminKey: 'admin', keysDir, subject: 'alice', pubkeyFile: join(f.keysDir, 'alice.pub.json'), roles: ['l1'], days: 5, now: t1 }))).toMatch(/revocation list is not acceptable/);
    const r = await revokeGrants({ dir, adminKey: 'admin', keysDir, grantIds: [], now: t1 });
    expect(r).toMatchObject({ changed: true, listVersion: 2 });
    expect((await loadAuthority(dir, t1)).revocation.list.listVersion).toBe(2);
  });

  it('works through the command line', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => NOW };
    const g = await issue();
    const base = ['admin', 'revoke', '--dir', f.authorityDir, '--admin-key', 'admin', '--keys-dir', f.keysDir];
    expect(await runStrictCli([...base, '--grant', g.grantId], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Revocation list is now version/);
    expect(await runStrictCli([...base, '--grant', g.grantId], io)).toBe(0);
    expect(out.join('\n')).toMatch(/already revoked/);
    expect(await runStrictCli(base, io)).toBe(2);
    expect(await runStrictCli(['admin', 'refresh-revocation', '--dir', f.authorityDir, '--admin-key', 'admin', '--keys-dir', f.keysDir], io)).toBe(0);
    expect(await runStrictCli(['admin', 'refresh-revocation', '--dir', f.authorityDir, '--admin-key', 'admin', '--keys-dir', f.keysDir, '--grant', 'x'], io)).toBe(2);
  });
});
