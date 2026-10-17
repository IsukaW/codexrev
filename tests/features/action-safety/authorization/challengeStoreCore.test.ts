// Tests for the challenge store CORE. Everything is real except the clock and the key material, which the
// tests control: real Ed25519 signatures, the real Phase 6B.8 client, the real filesystem persistence in a
// test-owned temporary directory. Nothing here is a protected store: it all runs in one test process.

import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeActionContextDigest, computeProofDigest } from '../../../../src/features/action-safety/authorization/challengeCommon.js';
import {
  DEFAULT_CHALLENGE_LIFETIME_MS,
  createChallengeStoreCore,
  createInProcessTransport,
  type AuthorityMaterial,
  type ChallengeStoreCore,
  type ChallengeStoreCoreConfig,
} from '../../../../src/features/action-safety/authorization/challengeStoreCore.js';
import { openFilesystemPersistence, type ChallengeStorePersistence } from '../../../../src/features/action-safety/authorization/challengeStorePersistence.js';
import { verifyChallengeToken } from '../../../../src/features/action-safety/authorization/challengeToken.js';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { verifyGrant, type VerifiedGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy } from '../../../../src/features/action-safety/authorization/policy.js';
import { computeContentDigest, createProof, type ActionContext } from '../../../../src/features/action-safety/authorization/proof.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import type { SignedEnvelope } from '../../../../src/features/action-safety/authorization/types.js';
import { generateRequestId, prepareConsumptionAttempt, requestChallengeToken, submitConsumption, type ChallengeStoreTransport } from '../../../../src/features/action-safety/authorization/trustedChallengeStoreClient.js';

// these tests do real file and signature work; on a loaded machine (the whole suite in parallel) the 5-second default is too tight
vi.setConfig({ testTimeout: 60_000 });

const START = Date.parse('2026-06-01T12:00:00Z');
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');
const raw = (k: Keys): string => exportRawPublicKey(k.publicKey).toString('base64url');
const id = (k: Keys): string => deriveKeyId(k.publicKey);
const entry = (k: Keys, purposes: string[], notAfter = '2027-01-01T00:00:00Z'): Record<string, unknown> => ({ keyId: id(k), publicKey: raw(k), purposes, notBefore: '2026-01-01T00:00:00Z', notAfter });
const sign = (doc: unknown, key: Keys, domain: 'policy' | 'grant' | 'revocation') => signEnvelope({ domain, payload: Buffer.from(JSON.stringify(doc)), privateKey: key.privateKey });
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

const CTX: ActionContext = { actionId: 'act-001', actionType: 'code_change', environment: 'development', target: 'payments-service', commit: 'a'.repeat(40), contentDigest: computeContentDigest(Buffer.from('diff')) };
const OTHER_CTX: ActionContext = { ...CTX, actionId: 'act-002' };

const policyDoc = (revision = 5, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 2, organization: 'acme', policyId: 'acme-policy', revision,
  issuedAt: '2026-05-01T00:00:00Z', effectiveAt: '2026-05-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
  permissions: ['code.change', 'deploy.production'],
  roles: [{ name: 'developer', permissions: ['code.change'] }, { name: 'release_engineer', permissions: ['code.change', 'deploy.production'] }, { name: 'tech_lead', permissions: [] }],
  rules: [{ action: 'code_change', environment: 'development', allowedRoles: ['developer', 'release_engineer'], requiredPermissions: ['code.change'] }],
  ...over,
});

let storeKey: Keys;
let policyKey: Keys;
let grantKey: Keys;
let revocationKey: Keys;
let outsider: Keys;
let aliceKey: Keys;
let bobKey: Keys;
let carolKey: Keys;
let root: TrustRoot;
let parent: string;

interface Person { key: Keys; grant: VerifiedGrant; envelope: SignedEnvelope }
let alice: Person;
let bob: Person;
let carol: Person;

const makeRoot = (organization: string, keys: Record<string, unknown>[]): TrustRoot => {
  const r = parseTrustRoot({ version: 1, organization, createdAt: '2026-01-01T00:00:00Z', keys });
  if (!r.ok) throw new Error(`setup: ${r.code}`);
  return r.trustRoot;
};

const person = (key: Keys, grantId: string, subjectId: string, roles: string[], over: Record<string, unknown> = {}, signer: Keys = grantKey): Person => {
  const envelope = sign({ version: 1, grantId, organization: 'acme', subject: { id: subjectId, type: 'human', publicKey: raw(key), keyId: id(key) }, roles, permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1, ...over }, signer, 'grant');
  const p = verifyPolicy(sign(policyDoc(), policyKey, 'policy'), root, new Date(START));
  if (!p.ok) throw new Error('setup policy');
  const g = verifyGrant(envelope, root, p.policy, new Date(START));
  if (!g.ok) throw new Error(`setup grant: ${g.code}`);
  return { key, grant: g, envelope };
};

beforeAll(() => {
  [storeKey, policyKey, grantKey, revocationKey, outsider, aliceKey, bobKey, carolKey] = Array.from({ length: 8 }, pair) as Keys[];
  root = makeRoot('acme', [entry(storeKey, ['challenge_store']), entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])]);
  alice = person(aliceKey, 'grant-alice-001', 'alice', ['developer']);
  bob = person(bobKey, 'grant-bob-001', 'bob', ['developer']);
  carol = person(carolKey, 'grant-carol-001', 'carol', ['tech_lead']);
  parent = mkdtempSync(join(tmpdir(), 'codexrev-core-'));
});
afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the harness

const revocationList = (nowMs: number, over: Record<string, unknown> = {}, signer: Keys = revocationKey): SignedEnvelope =>
  sign({ version: 1, organization: 'acme', listVersion: 3, issuedAt: iso(nowMs - 3600_000), nextUpdate: iso(nowMs + 48 * 3600_000), revokedGrantIds: [], revokedSubjectKeyIds: [], revokedIssuerKeyIds: [], ...over }, signer, 'revocation');

interface Env {
  readonly dir: string;
  readonly core: ChallengeStoreCore;
  readonly transport: ChallengeStoreTransport;
  readonly persistence: ChallengeStorePersistence;
  readonly clock: { ms: number; fail: boolean; badValue: boolean };
  readonly material: { policy: unknown; revocation: unknown; throws: boolean };
  readonly config: ChallengeStoreCoreConfig;
  now(): Date;
  advance(seconds: number): void;
  refreshRevocation(over?: Record<string, unknown>): void;
}

let dirCounter = 0;
async function setup(opts: { wrap?: (p: ChallengeStorePersistence) => ChallengeStorePersistence; lifetimeMs?: number; dir?: string; startMs?: number } = {}): Promise<Env> {
  const dir = opts.dir ?? join(parent, `store-${++dirCounter}`);
  const clock = { ms: opts.startMs ?? START, fail: false, badValue: false };
  const material = { policy: sign(policyDoc(), policyKey, 'policy') as unknown, revocation: revocationList(clock.ms) as unknown, throws: false };
  const base = await openFilesystemPersistence({ root: dir, storeId: 'store-1', storeGeneration: 'gen-1' });
  const persistence = opts.wrap ? opts.wrap(base) : base;
  const config: ChallengeStoreCoreConfig = {
    organization: 'acme',
    storeId: 'store-1',
    storeGeneration: 'gen-1',
    signingKey: storeKey.privateKey,
    trustRoot: root,
    authority: { current: (): AuthorityMaterial => { if (material.throws) throw new Error('SECRET-AUTHORITY-DETAIL'); return { policy: material.policy, revocation: material.revocation }; } },
    clock: { now: (): Date => { if (clock.fail) throw new Error('clock broken'); return (clock.badValue ? ('not a date' as unknown as Date) : new Date(clock.ms)); } },
    persistence,
    ...(opts.lifetimeMs ? { challengeLifetimeMs: opts.lifetimeMs } : {}),
  };
  const created = createChallengeStoreCore(config);
  if (!created.ok) throw new Error(`setup core: ${created.code}`);
  return {
    dir, core: created.core, transport: createInProcessTransport(created.core), persistence, clock, material, config,
    now: () => new Date(clock.ms),
    advance: (s) => { clock.ms += s * 1000; },
    refreshRevocation: (over = {}) => { material.revocation = revocationList(clock.ms, over); },
  };
}

const digestOrDefault = (context: ActionContext): string => {
  try {
    return computeActionContextDigest(context);
  } catch {
    return computeActionContextDigest(CTX); // an unparseable context: the store must still refuse it
  }
};
const rawIssueRequest = (who: Person, context: ActionContext = CTX, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  organization: 'acme', storeId: 'store-1', grantId: who.grant.grant.grantId, subjectId: who.grant.grant.subject.id, subjectKeyId: who.grant.grant.subject.keyId,
  context, contextDigest: digestOrDefault(context), grant: who.envelope, ...over,
});

const clientIssue = (env: Env, who: Person = alice, context: ActionContext = CTX) =>
  requestChallengeToken({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), requester: who.grant, grantEnvelope: who.envelope, context, now: env.now(), transport: env.transport, timeoutMs: 2000 });

/** issue a challenge through the real client and build a real proof for it */
async function issued(env: Env, who: Person = alice, context: ActionContext = CTX, proofLifetimeMs?: number) {
  const r = await clientIssue(env, who, context);
  if (!r.ok) throw new Error(`setup issue: ${r.code} ${r.detail ?? ''}`);
  const proof = createProof({ privateKey: who.key.privateKey, grant: who.grant, context, challenge: r.token.token.challenge, issuedAt: env.now(), ...(proofLifetimeMs ? { lifetimeMs: proofLifetimeMs } : {}) });
  const prep = prepareConsumptionAttempt({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), token: r.token, requester: who.grant, context, proof });
  if (!prep.ok) throw new Error(`setup attempt: ${prep.code}`);
  return { token: r.token, proof, attempt: prep.attempt, who, context };
}

const consumeVia = (env: Env, attempt: Awaited<ReturnType<typeof issued>>['attempt'], extra: Record<string, unknown> = {}) =>
  submitConsumption(attempt, env.transport, { now: env.now(), timeoutMs: 2000, ...extra });

const rawConsume = (env: Env, ctx: Awaited<ReturnType<typeof issued>>, over: Record<string, unknown> = {}) => env.core.consume({ ...ctx.attempt.request, ...over });
const res = (x: unknown): Record<string, unknown> => x as Record<string, unknown>;
const consumptionExists = (env: Env, challengeId: string): boolean => existsSync(join(env.dir, 'consumption', `${challengeId}.json`));
const consumptionCount = (env: Env): number => readdirSync(join(env.dir, 'consumption')).length;
const hostile = (): unknown => new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); }, has: () => { throw new Error('boom'); } });

// ================================================================ configuration

describe('store configuration', () => {
  it('creates a core only for a trusted challenge_store key inside its validity window', async () => {
    const env = await setup();
    expect(env.core.identity).toEqual({ organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', signingKeyId: id(storeKey) });
    expect(Object.isFrozen(env.core)).toBe(true);
  });

  it('refuses invalid or untrusted configuration with a fixed code', async () => {
    const env = await setup();
    const make = (over: Record<string, unknown>) => createChallengeStoreCore({ ...env.config, ...over } as ChallengeStoreCoreConfig);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ organization: 'globex' }, 'organization_mismatch'],
      [{ organization: 'Bad Org' }, 'invalid_config'],
      [{ storeId: 'Bad Id' }, 'invalid_config'],
      [{ storeGeneration: 'bad generation' }, 'invalid_config'],
      [{ trustRoot: { ...root } }, 'invalid_config'],
      [{ signingKey: outsider.privateKey }, 'signing_key_not_trusted'],
      [{ signingKey: policyKey.privateKey }, 'signing_key_not_trusted'], // trusted, but not for this purpose
      [{ signingKey: storeKey.publicKey }, 'invalid_signing_key'],
      [{ signingKey: 'a private key' }, 'invalid_signing_key'],
      [{ clock: { now: () => new Date('x') } }, 'invalid_clock'],
      [{ clock: { now: () => { throw new Error('x'); } } }, 'invalid_clock'],
      [{ clock: null }, 'invalid_config'],
      [{ authority: {} }, 'invalid_config'],
      [{ persistence: { getIssuance: () => undefined } }, 'invalid_config'],
      [{ challengeLifetimeMs: 999 }, 'invalid_config'],
      [{ challengeLifetimeMs: 11 * 60 * 1000 }, 'invalid_config'],
      [{ challengeLifetimeMs: 1.5 }, 'invalid_config'],
    ];
    for (const [over, code] of cases) expect(make(over), JSON.stringify(Object.keys(over))).toEqual({ ok: false, code });
    expect(createChallengeStoreCore(null as never)).toEqual({ ok: false, code: 'invalid_config' });
    expect(createChallengeStoreCore(hostile() as never).ok).toBe(false);
    // a store key whose window has ended
    const expiredRoot = makeRoot('acme', [entry(storeKey, ['challenge_store'], '2026-02-01T00:00:00Z')]);
    expect(make({ trustRoot: expiredRoot })).toEqual({ ok: false, code: 'signing_key_not_trusted' });
  });

  it('never generates a production key, and reads no environment, repository or assessment data', () => {
    const source = readFileSync(join(process.cwd(), 'src/features/action-safety/authorization/challengeStoreCore.ts'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/generateKeyPair|process\.env|process\.argv|readFileSync|readFile\b|loadTrustRoot|fetch\(|child_process|node:net|node:http|node:fs|Date\.now|new Date\(\)/);
    expect([...source.matchAll(/from '(node:[^']+)'/g)].map((m) => m[1])).toEqual(['node:crypto']);
  });
});

// ================================================================ issuance

describe('issuing a challenge', () => {
  it('issues a verified token for a valid grant, policy and action, and records it BEFORE returning it', async () => {
    const env = await setup();
    const answer = await env.core.issue(rawIssueRequest(alice));
    expect(answer.result).toBe('issued');
    const token = (answer as { token: SignedEnvelope }).token;
    const verified = verifyChallengeToken(token, root, { storeId: 'store-1', signingKeyId: id(storeKey), grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX }, env.now());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(Date.parse(verified.token.expiresAt) - Date.parse(verified.token.issuedAt)).toBe(DEFAULT_CHALLENGE_LIFETIME_MS);
    const record = await env.persistence.getIssuance(verified.token.challengeId);
    expect(record?.token).toEqual(token);
    expect(record?.grant).toEqual(alice.envelope);
    expect(record?.context).toEqual(CTX);
  });

  it('works end to end through the real client, which verifies the token itself', async () => {
    const env = await setup();
    const r = await clientIssue(env);
    expect(r.ok).toBe(true);
  });

  it('never lets a challenge outlive the grant or the policy', async () => {
    const env = await setup({ startMs: Date.parse('2026-07-31T23:58:00Z') });
    env.refreshRevocation();
    const r = await clientIssue(env);
    // the grant expires in two minutes; the challenge may not outlive it
    expect(r.ok).toBe(true);
    if (r.ok) expect(Date.parse(r.token.token.expiresAt)).toBeLessThanOrEqual(Date.parse('2026-08-01T00:00:00Z'));
    // in the grant's last second the challenge lives until exactly the grant's expiry
    const lastSecond = await setup({ startMs: Date.parse('2026-07-31T23:59:59.500Z') });
    lastSecond.refreshRevocation();
    const answer = res(await lastSecond.core.issue(rawIssueRequest(alice)));
    expect(answer.result).toBe('issued');
    expect(JSON.parse(Buffer.from((answer.token as SignedEnvelope).payload, 'base64url').toString('utf-8')).expiresAt).toBe('2026-08-01T00:00:00Z');
    // a policy that expires soon limits the challenge the same way
    const shortPolicy = await setup({ startMs: Date.parse('2026-06-01T12:00:00Z') });
    shortPolicy.material.policy = sign(policyDoc(5, { expiresAt: '2026-06-01T12:01:00Z' }), policyKey, 'policy');
    const limited = res(await shortPolicy.core.issue(rawIssueRequest(alice)));
    expect(JSON.parse(Buffer.from((limited.token as SignedEnvelope).payload, 'base64url').toString('utf-8')).expiresAt).toBe('2026-06-01T12:01:00Z');
  });

  it('refuses an invalid, forged, expired or foreign grant', async () => {
    const env = await setup();
    const cases: Array<[string, Person | { grant: VerifiedGrant; envelope: unknown }]> = [
      ['forged by an outsider', { grant: alice.grant, envelope: person(aliceKey, 'grant-alice-001', 'alice', ['developer'], {}, grantKey).envelope && sign({ version: 1, grantId: 'grant-alice-001', organization: 'acme', subject: { id: 'alice', type: 'human', publicKey: raw(aliceKey), keyId: id(aliceKey) }, roles: ['developer'], permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1 }, outsider, 'grant') }],
      ['unsigned grant document', { grant: alice.grant, envelope: { grantId: 'grant-alice-001', roles: ['developer'] } }],
      ['a client-side "verified" object', { grant: alice.grant, envelope: alice.grant }],
      ['an envelope for another domain', { grant: alice.grant, envelope: { ...alice.envelope, domain: 'policy' } }],
      ['tampered signature', { grant: alice.grant, envelope: { ...alice.envelope, signature: alice.envelope.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } }],
    ];
    for (const [label, p] of cases) expect(res(await env.core.issue(rawIssueRequest(alice, CTX, { grant: p.envelope }))), label).toMatchObject({ result: 'rejected', reason: 'unknown_grant' });
    // another organization's grant
    const otherOrg = sign({ version: 1, grantId: 'grant-alice-001', organization: 'globex', subject: { id: 'alice', type: 'human', publicKey: raw(aliceKey), keyId: id(aliceKey) }, roles: ['developer'], permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1 }, grantKey, 'grant');
    expect(res(await env.core.issue(rawIssueRequest(alice, CTX, { grant: otherOrg })))).toMatchObject({ reason: 'unknown_grant' });
    // an expired grant
    env.advance(70 * 24 * 3600);
    env.refreshRevocation();
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toMatchObject({ result: 'rejected', reason: 'unknown_grant' });
    // a grant that is not yet valid
    const early = await setup({ startMs: Date.parse('2026-05-20T00:00:00Z') });
    early.refreshRevocation();
    expect(res(await early.core.issue(rawIssueRequest(alice)))).toMatchObject({ reason: 'unknown_grant' });
  });

  it('refuses a revoked developer, by grant id or by subject key', async () => {
    const env = await setup();
    env.refreshRevocation({ revokedGrantIds: ['grant-alice-001'] });
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'grant_revoked' });
    env.refreshRevocation({ revokedSubjectKeyIds: [id(aliceKey)] });
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'grant_revoked' });
    expect((await env.core.issue(rawIssueRequest(bob))).result).toBe('issued'); // others are unaffected
  });

  it('refuses the wrong organization or store, and ids that differ from the verified grant', async () => {
    const env = await setup();
    for (const over of [{ organization: 'globex' }, { storeId: 'store-2' }, { grantId: 'grant-bob-001' }, { subjectId: 'bob' }, { subjectKeyId: id(bobKey) }]) {
      expect(res(await env.core.issue(rawIssueRequest(alice, CTX, over))), JSON.stringify(over)).toEqual({ result: 'rejected', reason: 'invalid_request' });
    }
  });

  it('refuses a requester without the role or permission, and an action the policy does not permit', async () => {
    const env = await setup();
    expect(res(await env.core.issue(rawIssueRequest(carol)))).toEqual({ result: 'rejected', reason: 'not_authorized' }); // tech_lead has no code.change
    expect(res(await env.core.issue(rawIssueRequest(alice, { ...CTX, actionType: 'deployment', environment: 'production' })))).toEqual({ result: 'rejected', reason: 'not_authorized' }); // no rule
    expect(res(await env.core.issue(rawIssueRequest(alice, { ...CTX, environment: 'production' })))).toEqual({ result: 'rejected', reason: 'not_authorized' });
    // a grant whose permissionScope removes the required permission
    const scoped = person(aliceKey, 'grant-alice-002', 'alice', ['developer'], { permissionScope: [] });
    expect(res(await env.core.issue(rawIssueRequest(scoped)))).toEqual({ result: 'rejected', reason: 'not_authorized' });
    // a context the contract does not know is malformed, not merely unauthorized
    expect(res(await env.core.issue(rawIssueRequest(alice, { ...CTX, actionType: 'launch_missiles' } as never, { contextDigest: computeActionContextDigest(CTX) })))).toEqual({ result: 'rejected', reason: 'invalid_request' });
  });

  it('refuses when revocation status cannot be established: stale, missing, forged or unverifiable lists never mean "not revoked"', async () => {
    const env = await setup();
    env.material.revocation = revocationList(env.clock.ms - 5 * 24 * 3600_000);
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    env.material.revocation = undefined;
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    env.material.revocation = revocationList(env.clock.ms, {}, outsider);
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    env.material.revocation = { not: 'a list' };
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
  });

  it('refuses when the policy cannot be verified or is not current, or its source fails', async () => {
    const env = await setup();
    env.material.policy = sign(policyDoc(), outsider, 'policy');
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    env.material.policy = undefined;
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    env.material.policy = sign(policyDoc(5, { expiresAt: '2026-05-30T00:00:00Z' }), policyKey, 'policy');
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    env.material.policy = sign(policyDoc(), policyKey, 'policy');
    env.material.throws = true;
    const answer = await env.core.issue(rawIssueRequest(alice));
    expect(answer).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(JSON.stringify(answer)).not.toContain('SECRET');
  });

  it('refuses a policy older than the grant allows', async () => {
    const env = await setup();
    const needsNewer = person(aliceKey, 'grant-alice-003', 'alice', ['developer'], { minPolicyRevision: 5 });
    env.material.policy = sign(policyDoc(4), policyKey, 'policy');
    expect(res(await env.core.issue(rawIssueRequest(needsNewer)))).toEqual({ result: 'rejected', reason: 'unknown_grant' });
  });

  it('refuses to issue when its own signing key is outside its trust-root window at the store’s time', async () => {
    const shortRoot = makeRoot('acme', [entry(storeKey, ['challenge_store'], '2026-06-01T12:30:00Z'), entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])]);
    const env = await setup();
    const created = createChallengeStoreCore({ ...env.config, trustRoot: shortRoot });
    if (!created.ok) throw new Error('setup');
    expect(await created.core.issue(rawIssueRequest(alice))).toMatchObject({ result: 'issued' });
    env.advance(31 * 60);
    env.refreshRevocation();
    expect(res(await created.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
  });

  it('returns NO token when the issuance record cannot be stored', async () => {
    const env = await setup({ wrap: (p) => ({ ...p, createIssuance: async () => { throw new Error('disk full'); } }) });
    const answer = await env.core.issue(rawIssueRequest(alice));
    expect(answer).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(JSON.stringify(answer)).not.toMatch(/token|challenge/);
    expect(readdirSync(join(env.dir, 'issuance'))).toEqual([]);
  });

  it('never overwrites on a challenge-id collision: it draws a new challenge, or gives up without a token', async () => {
    let collisions = 2;
    const env = await setup({ wrap: (p) => ({ ...p, createIssuance: async (r) => (collisions-- > 0 ? 'exists' : p.createIssuance(r)) }) });
    const answer = await env.core.issue(rawIssueRequest(alice));
    expect(answer.result).toBe('issued');
    expect(readdirSync(join(env.dir, 'issuance'))).toHaveLength(1);
    const always = await setup({ wrap: (p) => ({ ...p, createIssuance: async () => 'exists' as const }) });
    expect(res(await always.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(readdirSync(join(always.dir, 'issuance'))).toEqual([]);
  });

  it('rejects malformed and hostile requests without throwing', async () => {
    const env = await setup();
    const good = rawIssueRequest(alice);
    const bad: unknown[] = [undefined, null, 5, 'x', [], {}, hostile(), { ...good, extra: 1 }, { ...good, contextDigest: computeActionContextDigest(OTHER_CTX) }, { ...good, grant: 'a grant' }, { ...good, grant: null }, { ...good, context: null }, { ...good, subjectKeyId: 'xyz' }, { ...good, organization: 5 }];
    for (const [i, request] of bad.entries()) expect(res(await env.core.issue(request)), `request ${i}`).toEqual({ result: 'rejected', reason: 'invalid_request' });
    const missing = { ...good } as Record<string, unknown>;
    delete missing.grant;
    expect(res(await env.core.issue(missing))).toEqual({ result: 'rejected', reason: 'invalid_request' });
    expect(readdirSync(join(env.dir, 'issuance'))).toEqual([]);
  });
});

// ================================================================ consumption

describe('consuming a challenge', () => {
  it('consumes once with a valid signed proof and returns a receipt that the real client verifies', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const r = await consumeVia(env, ctx.attempt);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.receipt).toMatchObject({ challengeId: ctx.token.token.challengeId, requestId: ctx.attempt.requestId, proofDigest: computeProofDigest(ctx.proof), storeGeneration: 'gen-1' });
    expect(consumptionExists(env, ctx.token.token.challengeId)).toBe(true);
  });

  it('actually verifies the signed proof: possession of the subject key, not a digest', async () => {
    const env = await setup();
    const ctx = await issued(env);
    // 1. a proof whose signature is damaged, with a digest that matches the damaged proof
    const damaged = { ...ctx.proof, signature: ctx.proof.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
    expect(res(await rawConsume(env, ctx, { proof: damaged, proofDigest: computeProofDigest(damaged) }))).toEqual({ result: 'invalid_proof' });
    // 2. a proof signed by another key but claiming Alice's identity
    const forged = signEnvelope({ domain: 'proof', payload: Buffer.from(ctx.proof.payload, 'base64url'), privateKey: bobKey.privateKey });
    expect(res(await rawConsume(env, ctx, { proof: forged, proofDigest: computeProofDigest(forged) }))).toEqual({ result: 'invalid_proof' });
    // 3. a perfectly signed proof for a DIFFERENT action
    const otherAction = createProof({ privateKey: aliceKey.privateKey, grant: alice.grant, context: OTHER_CTX, challenge: ctx.token.token.challenge, issuedAt: env.now() });
    expect(res(await rawConsume(env, ctx, { proof: otherAction, proofDigest: computeProofDigest(otherAction) }))).toEqual({ result: 'invalid_proof' });
    // 4. a proof that does not contain this challenge
    const otherChallenge = createProof({ privateKey: aliceKey.privateKey, grant: alice.grant, context: CTX, challenge: randomBytes(32).toString('base64url'), issuedAt: env.now() });
    expect(res(await rawConsume(env, ctx, { proof: otherChallenge, proofDigest: computeProofDigest(otherChallenge) }))).toEqual({ result: 'invalid_proof' });
    // 5. a proof that is not a proof
    expect(res(await rawConsume(env, ctx, { proof: { hello: 'world' }, proofDigest: computeProofDigest(ctx.proof) }))).toMatchObject({ result: 'invalid_request' });
    expect(consumptionCount(env)).toBe(0);
    // ...and the genuine proof still works afterwards: failures consumed nothing
    expect((await consumeVia(env, ctx.attempt)).ok).toBe(true);
  });

  it('a digest alone is not enough: the matching digest of a proof the subject never signed is refused', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const stranger = signEnvelope({ domain: 'proof', payload: Buffer.from(ctx.proof.payload, 'base64url'), privateKey: outsider.privateKey });
    const answer = await rawConsume(env, ctx, { proof: stranger, proofDigest: computeProofDigest(stranger) });
    expect(res(answer).result).toBe('invalid_proof');
    expect(consumptionCount(env)).toBe(0);
  });

  it('refuses a request whose bindings differ from the issued challenge, consuming nothing', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ grantId: 'grant-bob-001' }, 'binding_mismatch'],
      [{ subjectId: 'bob' }, 'binding_mismatch'],
      [{ subjectKeyId: id(bobKey) }, 'binding_mismatch'],
      [{ contextDigest: computeActionContextDigest(OTHER_CTX) }, 'binding_mismatch'],
      [{ proofDigest: computeProofDigest(createProof({ privateKey: aliceKey.privateKey, grant: alice.grant, context: CTX, challenge: ctx.token.token.challenge, issuedAt: new Date(env.clock.ms + 1000) })) }, 'binding_mismatch'],
      [{ organization: 'globex' }, 'binding_mismatch'],
      [{ storeId: 'store-2' }, 'binding_mismatch'],
      [{ challengeId: generateRequestId().slice(0, 22) }, 'unknown_challenge'],
      [{ challenge: randomBytes(32).toString('base64url') }, 'unknown_challenge'],
    ];
    for (const [over, result] of cases) expect(res(await rawConsume(env, ctx, over)), JSON.stringify(Object.keys(over))).toEqual({ result });
    expect(consumptionCount(env)).toBe(0);
  });

  it('refuses a malformed or hostile consumption request without throwing', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const good = { ...ctx.attempt.request } as Record<string, unknown>;
    const bad: unknown[] = [undefined, null, 5, 'consumed', [], {}, hostile(), { ...good, extra: 1 }, { ...good, requestId: 'short' }, { ...good, challengeId: '../escape' }, { ...good, proofDigest: 'sha256:xyz' }, { ...good, proof: null }, { ...good, proof: undefined }, { ...good, challenge: 5 }];
    for (const [i, request] of bad.entries()) expect(res(await env.core.consume(request)), `request ${i}`).toEqual({ result: 'invalid_request' });
    const missing = { ...good };
    delete missing.proof;
    expect(res(await env.core.consume(missing))).toEqual({ result: 'invalid_request' });
    expect(consumptionCount(env)).toBe(0);
  });

  it('refuses an expired challenge by the STORE’s clock, whatever the client believes', async () => {
    const env = await setup();
    const ctx = await issued(env);
    env.advance(DEFAULT_CHALLENGE_LIFETIME_MS / 1000 - 1);
    env.refreshRevocation();
    // one second before expiry, inside the proof's own window too
    const late = createProof({ privateKey: aliceKey.privateKey, grant: alice.grant, context: CTX, challenge: ctx.token.token.challenge, issuedAt: new Date(env.clock.ms - 60_000) });
    expect(res(await rawConsume(env, ctx, { proof: late, proofDigest: computeProofDigest(late) })).result).toBe('consumed');
    const second = await issued(env);
    env.advance(DEFAULT_CHALLENGE_LIFETIME_MS / 1000);
    env.refreshRevocation();
    expect(res(await rawConsume(env, second))).toEqual({ result: 'expired' });
    expect(consumptionExists(env, second.token.token.challengeId)).toBe(false);
  });

  it('checks revocation and policy again at consumption time', { timeout: 60_000 }, async () => {
    const env = await setup();
    const revoked = await issued(env);
    env.refreshRevocation({ revokedGrantIds: ['grant-alice-001'] });
    expect(res(await rawConsume(env, revoked))).toEqual({ result: 'not_authorized' });
    expect(consumptionExists(env, revoked.token.token.challengeId)).toBe(false);

    const env2 = await setup();
    const stale = await issued(env2);
    env2.material.revocation = revocationList(env2.clock.ms - 5 * 24 * 3600_000);
    expect(res(await rawConsume(env2, stale))).toEqual({ result: 'unavailable' }); // freshness is re-applied

    const env3 = await setup();
    const policyChanged = await issued(env3);
    env3.material.policy = sign(policyDoc(5, { rules: [] }), policyKey, 'policy');
    expect(res(await rawConsume(env3, policyChanged))).toEqual({ result: 'not_authorized' }); // the action is no longer permitted
    env3.material.policy = sign(policyDoc(5), outsider, 'policy');
    expect(res(await rawConsume(env3, policyChanged))).toEqual({ result: 'unavailable' });
    env3.material.policy = sign(policyDoc(5), policyKey, 'policy');
    expect(res(await rawConsume(env3, policyChanged)).result).toBe('consumed'); // nothing was consumed by the refusals

    // a policy older than the grant requires (a rollback of the policy source) no longer authorizes
    const env4 = await setup();
    const demanding = person(aliceKey, 'grant-alice-004', 'alice', ['developer'], { minPolicyRevision: 5 });
    const downgraded = await issued(env4, demanding);
    env4.material.policy = sign(policyDoc(4), policyKey, 'policy');
    expect(res(await rawConsume(env4, downgraded))).toEqual({ result: 'not_authorized' });
    env4.material.policy = sign(policyDoc(5), policyKey, 'policy');
    expect(res(await rawConsume(env4, downgraded)).result).toBe('consumed');
  });

  it('a grant that stops being current cannot consume: the challenge never outlives it', async () => {
    const env = await setup({ startMs: Date.parse('2026-07-31T23:58:00Z') });
    env.refreshRevocation();
    const ctx = await issued(env, alice, CTX, 60_000);
    expect(Date.parse(ctx.token.token.expiresAt)).toBeLessThanOrEqual(Date.parse('2026-08-01T00:00:00Z'));
    env.advance(130); // past the grant's expiry
    env.refreshRevocation();
    expect(res(await rawConsume(env, ctx)).result).toBe('expired');
    expect(consumptionCount(env)).toBe(0);
  });

  it('returns no receipt for any refusal', async () => {
    const env = await setup();
    const ctx = await issued(env);
    for (const over of [{ grantId: 'grant-bob-001' }, { challenge: randomBytes(32).toString('base64url') }, { proof: { x: 1 } }]) {
      const answer = res(await rawConsume(env, ctx, over));
      expect(answer).not.toHaveProperty('receipt');
      expect(answer.result).not.toBe('consumed');
    }
  });
});

// ================================================================ atomicity and retries

describe('single use, idempotency and crashes', () => {
  it('a second request id for the same challenge is "already_used"', async () => {
    const env = await setup();
    const ctx = await issued(env);
    expect(res(await rawConsume(env, ctx)).result).toBe('consumed');
    expect(res(await rawConsume(env, ctx, { requestId: generateRequestId() }))).toEqual({ result: 'already_used' });
    expect(consumptionCount(env)).toBe(1);
  });

  it('the same request id returns the ORIGINAL receipt, identically, even after expiry or revocation', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const first = res(await rawConsume(env, ctx));
    const again = res(await rawConsume(env, ctx));
    expect(again).toEqual(first);
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    env.advance(3600);
    env.refreshRevocation({ revokedGrantIds: ['grant-alice-001'] });
    expect(res(await rawConsume(env, ctx))).toEqual(first); // an event that already happened is not undone
    expect(consumptionCount(env)).toBe(1);
  });

  it('the same request id with a changed proof, grant, subject or action is refused and consumes nothing more', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const first = res(await rawConsume(env, ctx));
    const other = createProof({ privateKey: aliceKey.privateKey, grant: alice.grant, context: CTX, challenge: ctx.token.token.challenge, issuedAt: new Date(env.clock.ms + 1000) });
    env.advance(2);
    expect(res(await rawConsume(env, ctx, { proof: other, proofDigest: computeProofDigest(other) }))).toEqual({ result: 'binding_mismatch' });
    for (const over of [{ grantId: 'grant-bob-001' }, { subjectId: 'bob' }, { contextDigest: computeActionContextDigest(OTHER_CTX) }]) {
      expect(res(await rawConsume(env, ctx, over)).result).toBe('binding_mismatch');
    }
    expect(res(await rawConsume(env, ctx))).toEqual(first);
    expect(consumptionCount(env)).toBe(1);
  });

  it('concurrent identical requests consume once, and every caller gets the same original receipt', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const answers = await Promise.all(Array.from({ length: 12 }, () => rawConsume(env, ctx)));
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(res(answers[0]).result).toBe('consumed');
    expect(consumptionCount(env)).toBe(1);
  });

  it('concurrent conflicting requests: at most one wins, the rest see "already_used"', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const ids = Array.from({ length: 10 }, () => generateRequestId());
    const answers = await Promise.all(ids.map((requestId) => rawConsume(env, ctx, { requestId })));
    const winners = answers.filter((a) => res(a).result === 'consumed');
    expect(winners).toHaveLength(1);
    expect(answers.filter((a) => res(a).result === 'already_used')).toHaveLength(9);
    expect(consumptionCount(env)).toBe(1);
    const winner = res(winners[0]).receipt as SignedEnvelope;
    const stored = JSON.parse(readFileSync(join(env.dir, 'consumption', `${ctx.token.token.challengeId}.json`), 'utf-8'));
    expect(stored.receipt).toEqual(winner);
  });

  it('two cores on the same directory (two processes) still consume once', async () => {
    const env = await setup();
    const second = createChallengeStoreCore({ ...env.config, persistence: await openFilesystemPersistence({ root: env.dir, storeId: 'store-1', storeGeneration: 'gen-1' }) });
    if (!second.ok) throw new Error('setup');
    const ctx = await issued(env);
    const answers = await Promise.all([env.core.consume({ ...ctx.attempt.request, requestId: generateRequestId() }), second.core.consume({ ...ctx.attempt.request, requestId: generateRequestId() }), env.core.consume({ ...ctx.attempt.request }), second.core.consume({ ...ctx.attempt.request })]);
    expect(answers.filter((a) => res(a).result === 'consumed').length).toBeGreaterThanOrEqual(1);
    expect(consumptionCount(env)).toBe(1);
    const receipts = new Set(answers.filter((a) => res(a).result === 'consumed').map((a) => JSON.stringify(res(a).receipt)));
    expect(receipts.size).toBe(1);
  });

  it('crash before the commit: nothing is consumed, no receipt escaped, and a retry consumes normally', async () => {
    let crash = true;
    const env = await setup({ wrap: (p) => ({ ...p, commitConsumption: async (r) => { if (crash) throw new Error('crash before commit'); return p.commitConsumption(r); } }) });
    const ctx = await issued(env);
    const answer = await rawConsume(env, ctx);
    expect(answer).toEqual({ result: 'unavailable' });
    expect(consumptionCount(env)).toBe(0);
    crash = false;
    const retry = res(await rawConsume(env, ctx));
    expect(retry.result).toBe('consumed');
    expect(consumptionCount(env)).toBe(1);
  });

  it('crash after the commit but before the response: no second consumption, and the retry returns the original receipt', async () => {
    let crash = true;
    const env = await setup({ wrap: (p) => ({ ...p, commitConsumption: async (r) => { const out = await p.commitConsumption(r); if (crash) throw new Error('crash after commit'); return out; } }) });
    const ctx = await issued(env);
    expect(await rawConsume(env, ctx)).toEqual({ result: 'unavailable' }); // the caller never saw a receipt
    expect(consumptionCount(env)).toBe(1); // yet the challenge IS consumed
    crash = false;
    expect(res(await rawConsume(env, ctx, { requestId: generateRequestId() }))).toEqual({ result: 'already_used' });
    const retry = res(await rawConsume(env, ctx)); // the same request id
    expect(retry.result).toBe('consumed');
    const stored = JSON.parse(readFileSync(join(env.dir, 'consumption', `${ctx.token.token.challengeId}.json`), 'utf-8'));
    expect(retry.receipt).toEqual(stored.receipt);
  });

  it('the real client recovers from a lost response: timeout, then the SAME attempt returns the original receipt', async () => {
    const env = await setup();
    const ctx = await issued(env);
    let dropped = false;
    const flaky: ChallengeStoreTransport = {
      issue: env.transport.issue,
      consume: async (req, opts) => {
        const answer = await env.transport.consume(req, opts);
        if (!dropped) {
          dropped = true;
          return new Promise(() => {});
        }
        return answer;
      },
    };
    const first = await submitConsumption(ctx.attempt, flaky, { now: env.now(), timeoutMs: 1500 }); // long enough for a loaded machine to finish the real consumption before the answer is lost
    expect(first).toMatchObject({ ok: false, state: 'indeterminate', code: 'timeout' });
    expect(consumptionCount(env)).toBe(1);
    const retry = await submitConsumption(ctx.attempt, flaky, { now: env.now(), timeoutMs: 2000 });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const stored = JSON.parse(readFileSync(join(env.dir, 'consumption', `${ctx.token.token.challengeId}.json`), 'utf-8'));
    expect(JSON.parse(Buffer.from(stored.receipt.payload, 'base64url').toString('utf-8')).receiptId).toBe(retry.receipt.receipt.receiptId);
  });

  it('survives a restart: a new core on the same directory honours earlier issuance and consumption', async () => {
    const env = await setup();
    const open1 = await issued(env);
    const done = await issued(env, bob);
    const firstReceipt = res(await rawConsume(env, done));
    // "restart": new persistence instance, new core, same directory
    const persistence = await openFilesystemPersistence({ root: env.dir, storeId: 'store-1', storeGeneration: 'gen-1' });
    const created = createChallengeStoreCore({ ...env.config, persistence });
    if (!created.ok) throw new Error('setup');
    const restarted = created.core;
    expect(res(await restarted.consume(done.attempt.request))).toEqual(firstReceipt);
    expect(res(await restarted.consume({ ...done.attempt.request, requestId: generateRequestId() }))).toEqual({ result: 'already_used' });
    expect(res(await restarted.consume(open1.attempt.request)).result).toBe('consumed'); // issued before the restart
  });
});

// ================================================================ storage and time failures

describe('storage, time and tampering', () => {
  it('fails closed when storage fails on read, and consumes nothing', async () => {
    let broken = false;
    const env = await setup({ wrap: (p) => ({ ...p, getIssuance: async (c) => { if (broken) throw new Error('/secret/path'); return p.getIssuance(c); } }) });
    const ctx = await issued(env);
    broken = true;
    expect(await rawConsume(env, ctx)).toEqual({ result: 'unavailable' });
    expect(consumptionCount(env)).toBe(0);
    broken = false;
    expect(res(await rawConsume(env, ctx)).result).toBe('consumed');
  });

  it('fails closed when an issuance record was tampered with or does not verify', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const path = join(env.dir, 'issuance', `${ctx.token.token.challengeId}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8'));
    // push the expiry out in the stored token: the store's own signature no longer matches
    const payload = JSON.parse(Buffer.from(record.token.payload, 'base64url').toString('utf-8'));
    payload.expiresAt = '2027-01-01T00:00:00Z';
    record.token.payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    writeFileSync(path, JSON.stringify(record));
    expect(res(await rawConsume(env, ctx))).toEqual({ result: 'unavailable' });
    expect(consumptionCount(env)).toBe(0);
    // a record signed by someone else is just as unacceptable
    const forged = signEnvelope({ domain: 'challenge', payload: Buffer.from(JSON.stringify(payload)), privateKey: outsider.privateKey });
    writeFileSync(path, JSON.stringify({ ...record, token: forged }));
    expect(res(await rawConsume(env, ctx))).toEqual({ result: 'unavailable' });
    // a record whose context was swapped no longer matches the signed digest
    const fresh = await issued(env);
    const p2 = join(env.dir, 'issuance', `${fresh.token.token.challengeId}.json`);
    const rec2 = JSON.parse(readFileSync(p2, 'utf-8'));
    rec2.context = OTHER_CTX;
    writeFileSync(p2, JSON.stringify(rec2));
    expect(res(await rawConsume(env, fresh))).toEqual({ result: 'unavailable' });
    expect(consumptionCount(env)).toBe(0);
  });

  it('fails closed when a stored consumption record is corrupt or not this store’s receipt', async () => {
    const env = await setup();
    const ctx = await issued(env);
    expect(res(await rawConsume(env, ctx)).result).toBe('consumed');
    const path = join(env.dir, 'consumption', `${ctx.token.token.challengeId}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8'));
    writeFileSync(path, JSON.stringify({ ...record, receipt: { ...record.receipt, signature: record.receipt.signature.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A')) } }));
    expect(res(await rawConsume(env, ctx))).toEqual({ result: 'unavailable' });
    writeFileSync(path, '{ broken');
    expect(res(await rawConsume(env, ctx))).toEqual({ result: 'unavailable' });
  });

  it('a deleted consumption record is DETECTED: the store blocks instead of consuming again (Phase 6B.10)', async () => {
    const env = await setup();
    const ctx = await issued(env);
    expect(res(await rawConsume(env, ctx)).result).toBe('consumed');
    rmSync(join(env.dir, 'consumption', `${ctx.token.token.challengeId}.json`));
    expect(res(await rawConsume(env, ctx, { requestId: generateRequestId() }))).toEqual({ result: 'unavailable' });
    expect(env.core.status()).toMatchObject({ phase: 'blocked', findings: ['consumption_record_missing'] });
    expect(consumptionExists(env, ctx.token.token.challengeId)).toBe(false); // and nothing was re-created
  });

  it('fails closed on a broken, invalid or backwards-moving clock', async () => {
    const env = await setup();
    const ctx = await issued(env);
    env.clock.fail = true;
    expect(res(await rawConsume(env, ctx))).toEqual({ result: 'unavailable' });
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    env.clock.fail = false;
    env.clock.badValue = true;
    expect(res(await rawConsume(env, ctx))).toEqual({ result: 'unavailable' });
    env.clock.badValue = false;
    env.clock.ms -= 3600_000; // moves backwards: refused, never trusted
    expect(res(await rawConsume(env, ctx))).toEqual({ result: 'unavailable' });
    expect(res(await env.core.issue(rawIssueRequest(alice)))).toEqual({ result: 'rejected', reason: 'unavailable' });
    env.clock.ms += 3600_000;
    expect(res(await rawConsume(env, ctx)).result).toBe('consumed'); // the clock is back at its high-water mark
    expect(consumptionCount(env)).toBe(1);
  });

  it('refuses to consume before the recorded issue time (a clock earlier than the issuance)', async () => {
    const env = await setup();
    const ctx = await issued(env);
    const earlier = createChallengeStoreCore({ ...env.config, clock: { now: () => new Date(env.clock.ms - 120_000) } });
    if (!earlier.ok) throw new Error('setup');
    expect(res(await earlier.core.consume(ctx.attempt.request))).toEqual({ result: 'unavailable' });
    expect(consumptionCount(env)).toBe(0);
  });
});

// ================================================================ leakage and scope

describe('leakage and scope', () => {
  it('no answer ever contains a challenge, a proof, a key, a path or an internal error message', async () => {
    const flag = { on: false, dir: '' };
    const env = await setup({ wrap: (p) => ({ ...p, getConsumption: async (c) => { if (flag.on) throw new Error(`SECRET ${flag.dir}`); return p.getConsumption(c); } }) });
    flag.dir = env.dir;
    const ctx = await issued(env);
    const secrets = [ctx.token.token.challenge, ctx.proof.payload, ctx.proof.signature, String(storeKey.privateKey.export({ format: 'jwk' }).d), String(aliceKey.privateKey.export({ format: 'jwk' }).d), env.dir, 'SECRET', 'ENOENT', 'Error:'];
    const answers: unknown[] = [];
    answers.push(await rawConsume(env, ctx, { challenge: randomBytes(32).toString('base64url') }));
    answers.push(await rawConsume(env, ctx, { proof: { bad: 1 } }));
    answers.push(await rawConsume(env, ctx, { grantId: 'grant-bob-001' }));
    env.material.throws = true;
    answers.push(await rawConsume(env, ctx));
    answers.push(await env.core.issue(rawIssueRequest(alice)));
    env.material.throws = false;
    flag.on = true;
    answers.push(await rawConsume(env, ctx));
    answers.push(await env.core.issue(hostile()));
    for (const a of answers) {
      const text = JSON.stringify(a);
      for (const secret of secrets) expect(text, secret.slice(0, 12)).not.toContain(secret);
    }
  });

  it('is separate from the assessment pipeline and the legacy contracts, and nothing else imports it', () => {
    const base = join(process.cwd(), 'src/features/action-safety/authorization');
    const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const file of ['challengeStoreCore.ts', 'challengeStorePersistence.ts']) {
      const text = strip(readFileSync(join(base, file), 'utf-8'));
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
      for (const forbidden of ['./twoPhaseAuthorization.js', './evaluateAuthorization.js', './strictAuthorityAdapter.js', './strictConfig.js', './actionContextCollector.js']) expect(imports, file).not.toContain(forbidden);
      expect(text, file).not.toMatch(/ChallengeStore\b|consumeChallenge/);
    }
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const offenders = walk(join(process.cwd(), 'src')).filter((f) => !f.startsWith(base) && !f.includes(`${join('action-safety', 'strict')}`) && !f.includes(`${join('action-safety', 'testing')}`) && /challengeStoreCore|challengeStorePersistence/.test(readFileSync(f, 'utf-8')));
    // the signed-authorization setup and assessment tool (strict/) is the one intended consumer; the scoring, gates and coordinator are not
    expect(offenders).toEqual([]);
  });

  it('writes only inside the test-owned store directories', async () => {
    const before = readdirSync(parent).filter((n) => !n.startsWith('store-'));
    const env = await setup();
    const ctx = await issued(env);
    await rawConsume(env, ctx);
    expect(readdirSync(parent).filter((n) => !n.startsWith('store-'))).toEqual(before);
    expect(readdirSync(env.dir).sort()).toEqual(['STORE.json', 'consumption', 'issuance', 'journal', 'tmp']);
    expect(readdirSync(join(env.dir, 'tmp'))).toEqual([]);
  });
});
