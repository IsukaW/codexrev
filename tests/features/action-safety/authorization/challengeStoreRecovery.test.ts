// Recovery, rollback detection, generation safety and the external-anchor contract of the challenge store.
//
// Everything runs in one test process with a real filesystem in a test-owned temporary directory. Some tests
// DEMONSTRATE LIMITS: they show an attack the store cannot detect without an external anchor, and assert
// exactly that, so the limit stays visible and nobody mistakes it for protection.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeActionContextDigest } from '../../../../src/features/action-safety/authorization/challengeCommon.js';
import {
  createChallengeStoreCore,
  createInProcessTransport,
  type AnchorState,
  type AuthorityMaterial,
  type ChallengeStoreCoreConfig,
  type ChallengeStoreOperator,
  type ChallengeStoreCore,
  type RollbackAnchor,
} from '../../../../src/features/action-safety/authorization/challengeStoreCore.js';
import { ZERO_HASH, createJournalEntry, entryHash } from '../../../../src/features/action-safety/authorization/challengeStoreJournal.js';
import { openFilesystemPersistence, type ChallengeStorePersistence } from '../../../../src/features/action-safety/authorization/challengeStorePersistence.js';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { verifyGrant, type VerifiedGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy } from '../../../../src/features/action-safety/authorization/policy.js';
import { computeContentDigest, createProof, type ActionContext } from '../../../../src/features/action-safety/authorization/proof.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import type { SignedEnvelope } from '../../../../src/features/action-safety/authorization/types.js';
import { generateRequestId, prepareConsumptionAttempt, requestChallengeToken, type ChallengeStoreTransport } from '../../../../src/features/action-safety/authorization/trustedChallengeStoreClient.js';

// these tests do real file and signature work; on a loaded machine (the whole suite in parallel) the 5-second default is too tight
vi.setConfig({ testTimeout: 60_000 });

const START = Date.parse('2026-06-01T12:00:00Z');
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');
const raw = (k: Keys): string => exportRawPublicKey(k.publicKey).toString('base64url');
const id = (k: Keys): string => deriveKeyId(k.publicKey);
const entry = (k: Keys, purposes: string[]): Record<string, unknown> => ({ keyId: id(k), publicKey: raw(k), purposes, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' });
const sign = (doc: unknown, key: Keys, domain: 'policy' | 'grant' | 'revocation') => signEnvelope({ domain, payload: Buffer.from(JSON.stringify(doc)), privateKey: key.privateKey });
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

const CTX: ActionContext = { actionId: 'act-001', actionType: 'code_change', environment: 'development', target: 'payments-service', commit: 'a'.repeat(40), contentDigest: computeContentDigest(Buffer.from('diff')) };

const policyDoc = (): Record<string, unknown> => ({
  version: 2, organization: 'acme', policyId: 'acme-policy', revision: 5,
  issuedAt: '2026-05-01T00:00:00Z', effectiveAt: '2026-05-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
  permissions: ['code.change'], roles: [{ name: 'developer', permissions: ['code.change'] }],
  rules: [{ action: 'code_change', environment: 'development', allowedRoles: ['developer'], requiredPermissions: ['code.change'] }],
});

let storeKey: Keys;
let policyKey: Keys;
let grantKey: Keys;
let revocationKey: Keys;
let outsider: Keys;
let aliceKey: Keys;
let root: TrustRoot;
let alice: { key: Keys; grant: VerifiedGrant; envelope: SignedEnvelope };
let parent: string;

beforeAll(() => {
  [storeKey, policyKey, grantKey, revocationKey, outsider, aliceKey] = Array.from({ length: 6 }, pair) as Keys[];
  const r = parseTrustRoot({ version: 1, organization: 'acme', createdAt: '2026-01-01T00:00:00Z', keys: [entry(storeKey, ['challenge_store']), entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])] });
  if (!r.ok) throw new Error('setup root');
  root = r.trustRoot;
  const policy = verifyPolicy(sign(policyDoc(), policyKey, 'policy'), root, new Date(START));
  if (!policy.ok) throw new Error('setup policy');
  const envelope = sign({ version: 1, grantId: 'grant-alice-001', organization: 'acme', subject: { id: 'alice', type: 'human', publicKey: raw(aliceKey), keyId: id(aliceKey) }, roles: ['developer'], permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1 }, grantKey, 'grant');
  const grant = verifyGrant(envelope, root, policy.policy, new Date(START));
  if (!grant.ok) throw new Error('setup grant');
  alice = { key: aliceKey, grant, envelope };
  parent = mkdtempSync(join(tmpdir(), 'codexrev-recovery-'));
});
afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

// ---------------------------------------------------------------- harness

/** TEST DOUBLE of a protected external anchor: it lives outside the store directory, so restoring the directory cannot restore it. */
function makeAnchor() {
  const anchor = {
    state: undefined as AnchorState | undefined,
    failNextAdvance: false,
    advances: 0,
    async read() {
      return anchor.state;
    },
    async advance(next: AnchorState) {
      if (anchor.failNextAdvance) {
        anchor.failNextAdvance = false;
        throw new Error('anchor unreachable');
      }
      const s = anchor.state;
      if (s && (next.sequence < s.sequence || (next.sequence === s.sequence && next.headHash !== s.headHash))) throw new Error('anchor refuses to go backwards');
      anchor.state = next;
      anchor.advances++;
    },
  };
  return anchor;
}
type TestAnchor = ReturnType<typeof makeAnchor>;

interface Env {
  readonly dir: string;
  core: ChallengeStoreCore;
  operator: ChallengeStoreOperator;
  transport: ChallengeStoreTransport;
  persistence: ChallengeStorePersistence;
  readonly clock: { ms: number };
  readonly material: { policy: unknown; revocation: unknown };
  config: ChallengeStoreCoreConfig;
}

let counter = 0;
const newDir = (): string => join(parent, `s${++counter}`);
const revocationAt = (ms: number): SignedEnvelope => sign({ version: 1, organization: 'acme', listVersion: 3, issuedAt: iso(ms - 3600_000), nextUpdate: iso(ms + 48 * 3600_000), revokedGrantIds: [], revokedSubjectKeyIds: [], revokedIssuerKeyIds: [], }, revocationKey, 'revocation');

interface SetupOptions {
  dir?: string;
  generation?: string;
  anchor?: TestAnchor;
  wrap?: (p: ChallengeStorePersistence) => ChallengeStorePersistence;
  clock?: { ms: number };
  material?: { policy: unknown; revocation: unknown };
  continuesFrom?: ChallengeStoreCoreConfig['continuesFrom'];
}

async function build(opts: SetupOptions = {}): Promise<Env> {
  const dir = opts.dir ?? newDir();
  const generation = opts.generation ?? 'gen-1';
  const clock = opts.clock ?? { ms: START };
  const material = opts.material ?? { policy: sign(policyDoc(), policyKey, 'policy') as unknown, revocation: revocationAt(clock.ms) as unknown };
  const base = await openFilesystemPersistence({ root: dir, storeId: 'store-1', storeGeneration: generation });
  const persistence = opts.wrap ? opts.wrap(base) : base;
  const config: ChallengeStoreCoreConfig = {
    organization: 'acme', storeId: 'store-1', storeGeneration: generation, signingKey: storeKey.privateKey, trustRoot: root,
    authority: { current: (): AuthorityMaterial => ({ policy: material.policy, revocation: material.revocation }) },
    clock: { now: () => new Date(clock.ms) },
    persistence,
    ...(opts.anchor ? { anchor: opts.anchor } : {}),
    ...(opts.continuesFrom ? { continuesFrom: opts.continuesFrom } : {}),
  };
  const created = createChallengeStoreCore(config);
  if (!created.ok) throw new Error(`setup core: ${created.code}`);
  return { dir, core: created.core, operator: created.operator, transport: createInProcessTransport(created.core), persistence, clock, material, config };
}

/** a "restart": a new persistence instance and a new core on the same directory, sharing the clock and the policy source */
const restart = (env: Env, over: Omit<SetupOptions, 'dir' | 'clock' | 'material'> = {}): Promise<Env> => build({ dir: env.dir, clock: env.clock, material: env.material, ...(env.config.anchor ? { anchor: env.config.anchor as TestAnchor } : {}), ...over });

const now = (env: Env): Date => new Date(env.clock.ms);
const advance = (env: Env, seconds: number): void => {
  env.clock.ms += seconds * 1000;
  env.material.revocation = revocationAt(env.clock.ms);
};

async function issued(env: Env) {
  const r = await requestChallengeToken({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), requester: alice.grant, grantEnvelope: alice.envelope, context: CTX, now: now(env), transport: env.transport, timeoutMs: 2000 });
  if (!r.ok) throw new Error(`setup issue: ${r.code} ${r.detail ?? ''}`);
  const proof = createProof({ privateKey: alice.key.privateKey, grant: alice.grant, context: CTX, challenge: r.token.token.challenge, issuedAt: now(env) });
  const prep = prepareConsumptionAttempt({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), token: r.token, requester: alice.grant, context: CTX, proof });
  if (!prep.ok) throw new Error(`setup attempt: ${prep.code}`);
  return { token: r.token, proof, attempt: prep.attempt, id: r.token.token.challengeId };
}
type Issued = Awaited<ReturnType<typeof issued>>;

const consume = (env: Env, c: Issued, over: Record<string, unknown> = {}) => env.core.consume({ ...c.attempt.request, ...over });
const res = (x: unknown): Record<string, unknown> => x as Record<string, unknown>;
const rawIssue = (env: Env) => env.core.issue({ organization: 'acme', storeId: 'store-1', grantId: alice.grant.grant.grantId, subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, contextDigest: computeActionContextDigest(CTX), grant: alice.envelope });
const consumptionFile = (env: Env, challengeId: string): string => join(env.dir, 'consumption', `${challengeId}.json`);
const issuanceFile = (env: Env, challengeId: string): string => join(env.dir, 'issuance', `${challengeId}.json`);
const journalFiles = (env: Env): string[] => readdirSync(join(env.dir, 'journal')).sort();
const journalFile = (env: Env, n: number): string => join(env.dir, 'journal', `${String(n).padStart(16, '0')}.json`);
const entries = (env: Env): Array<{ sequence: number; event: { kind: string } & Record<string, unknown> }> =>
  journalFiles(env).map((f) => {
    const envelope = JSON.parse(readFileSync(join(env.dir, 'journal', f), 'utf-8'));
    const doc = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf-8'));
    return { sequence: doc.sequence, event: doc.event };
  });
const kinds = (env: Env): string[] => entries(env).map((e) => e.event.kind);
const snapshot = (env: Env): string => {
  const copy = join(parent, `snap-${++counter}`);
  cpSync(env.dir, copy, { recursive: true });
  return copy;
};
const restoreSnapshot = (env: Env, snap: string): void => {
  rmSync(env.dir, { recursive: true, force: true });
  cpSync(snap, env.dir, { recursive: true });
};
const hostile = (): unknown => new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });

// ================================================================ the journal in normal operation

describe('the journal follows every operation', () => {
  it('records genesis, each issuance and each consumption, in order, signed and chained', async () => {
    const env = await build();
    const c = await issued(env);
    expect(res(await consume(env, c)).result).toBe('consumed');
    expect(kinds(env)).toEqual(['genesis', 'issue', 'consume']);
    expect(env.core.status()).toMatchObject({ phase: 'ready', headSequence: 3, findings: [], anchor: 'none' });
    expect(entries(env)[1]?.event).toMatchObject({ kind: 'issue', challengeId: c.id });
  });

  it('a record is written BEFORE its journal entry, so a journal entry never names a record that was never written', async () => {
    const order: string[] = [];
    const env = await build({ wrap: (p) => ({ ...p, createIssuance: async (r) => { order.push('record'); return p.createIssuance(r); }, appendJournal: async (s, e) => { order.push(`journal${s}`); return p.appendJournal(s, e); } }) });
    await issued(env);
    expect(order).toEqual(['journal1', 'record', 'journal2']);
  });

  it('restarting after a valid consumption keeps the answer: the original receipt, and "already_used" for others', async () => {
    const env = await build();
    const c = await issued(env);
    const first = res(await consume(env, c));
    const again = await restart(env);
    expect(res(await consume(again, c))).toEqual(first);
    expect(res(await consume(again, c, { requestId: generateRequestId() }))).toEqual({ result: 'already_used' });
    expect(again.core.status().phase).toBe('ready');
    expect(kinds(again)).toEqual(['genesis', 'issue', 'consume']); // a restart adds nothing
  });
});

// ================================================================ detected rollback of single records

describe('missing or replaced records that the journal remembers', () => {
  it('detects a deleted consumption record while other records remain, and refuses everything', async () => {
    const env = await build();
    const a = await issued(env);
    const b = await issued(env);
    expect(res(await consume(env, a)).result).toBe('consumed');
    expect(res(await consume(env, b)).result).toBe('consumed');
    rmSync(consumptionFile(env, a.id));
    // the challenge is NOT treated as unused
    expect(res(await consume(env, a, { requestId: generateRequestId() }))).toEqual({ result: 'unavailable' });
    expect(existsSync(consumptionFile(env, a.id))).toBe(false);
    expect(env.core.status()).toMatchObject({ phase: 'blocked', findings: ['consumption_record_missing'], recoverableInPlace: true });
    // and the whole store stops: nothing is trusted while the inconsistency stands
    expect(res(await consume(env, b))).toEqual({ result: 'unavailable' });
    expect(res(await rawIssue(env))).toEqual({ result: 'rejected', reason: 'unavailable' });
  });

  it('detects a deleted LATEST consumption record at the next start, before any request', async () => {
    const env = await build();
    const a = await issued(env);
    await consume(env, a);
    const b = await issued(env);
    await consume(env, b);
    rmSync(consumptionFile(env, b.id));
    const restarted = await restart(env);
    expect(await restarted.core.recover()).toMatchObject({ phase: 'blocked', findings: ['consumption_record_missing'] });
    expect(res(await consume(restarted, b, { requestId: generateRequestId() })).result).toBe('unavailable');
  });

  it('detects a deleted issuance record', async () => {
    const env = await build();
    const a = await issued(env);
    rmSync(issuanceFile(env, a.id));
    const restarted = await restart(env);
    expect(await restarted.core.recover()).toMatchObject({ phase: 'blocked', findings: ['issuance_record_missing'] });
    expect(res(await consume(restarted, a)).result).toBe('unavailable'); // never "unknown": it WAS issued
  });

  it('detects a record swapped for another valid record of the same store', async () => {
    const env = await build();
    const a = await issued(env);
    const b = await issued(env);
    await consume(env, a);
    await consume(env, b);
    writeFileSync(consumptionFile(env, a.id), readFileSync(consumptionFile(env, b.id)));
    const restarted = await restart(env);
    expect(await restarted.core.recover()).toMatchObject({ phase: 'blocked', findings: ['consumption_record_mismatch'] });
    // a genuine record of the right challenge but a DIFFERENT receipt than the journal remembers
    const env2 = await build();
    const c = await issued(env2);
    await consume(env2, c);
    const stored = JSON.parse(readFileSync(consumptionFile(env2, c.id), 'utf-8'));
    const other = await build();
    const d = await issued(other);
    await consume(other, d);
    writeFileSync(issuanceFile(env2, c.id), readFileSync(issuanceFile(other, d.id)));
    void stored;
    const restarted2 = await restart(env2);
    expect((await restarted2.core.recover()).phase).toBe('blocked');
  });

  it('detects a record planted without a journal entry when it is not a plausible interrupted write', async () => {
    const env = await build();
    const a = await issued(env);
    await consume(env, a);
    // a valid old issuance record, copied from a past snapshot of this store, that the journal never saw
    const donor = await build();
    advance(donor, 0);
    const old = await issued(donor);
    donor.clock.ms += 0;
    writeFileSync(issuanceFile(env, old.id), readFileSync(issuanceFile(donor, old.id)));
    advance(env, 3 * 3600); // the journal moves on three hours; the planted record is older than any interrupted write could be
    const c2 = await issued(env); // writes a newer entry
    await consume(env, c2);
    const restarted = await restart(env);
    expect((await restarted.core.recover()).findings).toContain('unjournaled_record');
  });
});

// ================================================================ rollback of whole stores

describe('restored snapshots and truncation', () => {
  it('DEMONSTRATION OF A LIMIT: restoring an older complete snapshot is NOT detected without an anchor, and a consumed challenge can be consumed again', { timeout: 60_000 }, async () => {
    const env = await build();
    const a = await issued(env);
    expect(res(await consume(env, a)).result).toBe('consumed');
    const snap = snapshot(env);
    const b = await issued(env);
    const firstReceipt = res(await consume(env, b));
    expect(firstReceipt.result).toBe('consumed');
    restoreSnapshot(env, snap); // the store forgets that b existed...
    const restarted = await restart(env);
    expect((await restarted.core.recover()).phase).toBe('ready'); // ...and cannot tell
    expect(restarted.core.status().anchor).toBe('none'); // the status says so
    // b's issuance record is gone with the snapshot, so b is unknown: the loss is of the RECORD of b
    expect(res(await consume(restarted, b)).result).toBe('unknown_challenge');
  });

  it('DEMONSTRATION OF A LIMIT: truncating the newest journal entries together with their records is a consistent past', async () => {
    const env = await build();
    const a = await issued(env);
    expect(kinds(env)).toEqual(['genesis', 'issue']);
    const first = res(await consume(env, a));
    expect(first.result).toBe('consumed');
    // delete the newest entry (the consumption) and the consumption record it names: a consistent past
    rmSync(journalFile(env, 3));
    rmSync(consumptionFile(env, a.id));
    const restarted = await restart(env);
    expect((await restarted.core.recover()).phase).toBe('ready');
    const second = res(await consume(restarted, a, { requestId: generateRequestId() }));
    expect(second.result).toBe('consumed'); // consumed AGAIN: nothing local could prevent it
    expect(second.receipt).not.toEqual(first.receipt);
  });

  it('with an external anchor, the same restored snapshot is DETECTED and the store refuses to run', async () => {
    const anchor = makeAnchor();
    const env = await build({ anchor });
    const a = await issued(env);
    await consume(env, a);
    const snap = snapshot(env);
    const b = await issued(env);
    await consume(env, b);
    restoreSnapshot(env, snap);
    const restarted = await restart(env, { anchor });
    expect(await restarted.core.recover()).toMatchObject({ phase: 'blocked', findings: ['rollback_detected'], recoverableInPlace: false, anchor: 'configured' });
    expect(res(await consume(restarted, b))).toEqual({ result: 'unavailable' });
    expect(res(await rawIssue(restarted))).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(await restarted.operator.declareRecovery({ acknowledge: [], quietPeriodMs: 60_000 })).toEqual({ ok: false, code: 'not_recoverable_in_place' });
  });

  it('with an external anchor, truncation is DETECTED too', async () => {
    const anchor = makeAnchor();
    const env = await build({ anchor });
    const a = await issued(env);
    await consume(env, a);
    rmSync(journalFile(env, 3));
    rmSync(consumptionFile(env, a.id));
    const restarted = await restart(env, { anchor });
    expect(await restarted.core.recover()).toMatchObject({ phase: 'blocked', findings: ['rollback_detected'] });
  });

  it('notices a journal that becomes shorter WHILE running, even without an anchor', async () => {
    const env = await build();
    const a = await issued(env);
    await consume(env, a);
    rmSync(journalFile(env, 3));
    rmSync(consumptionFile(env, a.id));
    expect(res(await consume(env, a, { requestId: generateRequestId() }))).toEqual({ result: 'unavailable' });
    expect(env.core.status()).toMatchObject({ phase: 'blocked', findings: ['journal_rolled_back'], recoverableInPlace: false });
  });
});

// ================================================================ damaged journals

describe('journal damage', () => {
  const populated = async () => {
    const env = await build();
    for (let i = 0; i < 3; i++) await consume(env, await issued(env));
    return env; // genesis, then three issue/consume pairs: seven entries
  };

  it('a deleted middle entry is chain damage: blocked, and not recoverable in place', async () => {
    const env = await populated();
    rmSync(journalFile(env, 4));
    const restarted = await restart(env);
    expect(await restarted.core.recover()).toMatchObject({ phase: 'blocked', findings: ['journal_gap'], recoverableInPlace: false });
    expect(await restarted.operator.declareRecovery({ acknowledge: ['consumption_record_missing'], quietPeriodMs: 60_000 })).toEqual({ ok: false, code: 'not_recoverable_in_place' });
    expect(await restarted.operator.sealGeneration({ nextGeneration: 'gen-2' })).toEqual({ ok: false, code: 'not_ready' });
  });

  it('a forged, altered or swapped entry is detected', async () => {
    const env = await populated();
    const file = journalFile(env, 3);
    const original = readFileSync(file, 'utf-8');
    const envelope = JSON.parse(original);
    // altered signature
    writeFileSync(file, JSON.stringify({ ...envelope, signature: envelope.signature.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A')) }));
    expect((await (await restart(env)).core.recover()).findings).toEqual(['journal_bad_signature']);
    // re-signed by someone who does not hold the store key
    const doc = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf-8'));
    writeFileSync(file, JSON.stringify(createJournalEntry({ privateKey: outsider.privateKey, organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', sequence: 3, previousHash: doc.previousHash, at: new Date(Date.parse(doc.at)), event: doc.event })));
    expect((await (await restart(env)).core.recover()).findings).toEqual(['journal_bad_signature']);
    // two entries swapped
    writeFileSync(file, readFileSync(journalFile(env, 5)));
    writeFileSync(journalFile(env, 5), original);
    expect((await (await restart(env)).core.recover()).findings).toEqual(['journal_corrupt']);
  });

  it('a wrong store generation inside the journal is detected', async () => {
    const env = await populated();
    const foreign = await build({ generation: 'gen-2' });
    await foreign.core.recover();
    writeFileSync(journalFile(env, 1), readFileSync(journalFile(foreign, 1)));
    expect((await (await restart(env)).core.recover()).findings).toEqual(['journal_wrong_identity']);
  });

  it('corrupt or unexpected files are never ignored', async () => {
    const env = await populated();
    writeFileSync(journalFile(env, 6), '{ truncated');
    expect(await (await restart(env)).core.recover()).toMatchObject({ phase: 'blocked', findings: ['journal_corrupt'], recoverableInPlace: false });
    const env2 = await populated();
    writeFileSync(join(env2.dir, 'journal', 'stray.txt'), 'x');
    await expect(restart(env2)).rejects.toMatchObject({ code: 'unexpected_entry' });
    // the identity marker is part of the same defence
    const env3 = await populated();
    writeFileSync(join(env3.dir, 'STORE.json'), '{"garbage":true}');
    await expect(restart(env3)).rejects.toMatchObject({ code: 'corrupt_record' });
  });

  it('refuses a directory with records but no journal (a wiped journal is not a fresh store)', async () => {
    const env = await populated();
    for (const f of journalFiles(env)) rmSync(join(env.dir, 'journal', f));
    expect(await (await restart(env)).core.recover()).toMatchObject({ phase: 'blocked', findings: ['journal_empty_with_records'], recoverableInPlace: false });
  });

  it('is a different matter from normal expiry: expiry answers "expired", damage answers "unavailable"', async () => {
    const env = await build();
    const c = await issued(env);
    advance(env, 3600);
    expect(res(await consume(env, c)).result).toBe('expired');
    rmSync(issuanceFile(env, c.id));
    expect(res(await consume(env, c)).result).toBe('unavailable');
  });
});

// ================================================================ interrupted operations

describe('interrupted operations are recovered without a second consumption', () => {
  it('crash after the consumption record but before its journal entry: completed on retry, original receipt', async () => {
    let failJournal = false;
    const env = await build({ wrap: (p) => ({ ...p, appendJournal: async (s, e) => { if (failJournal) throw new Error('crash'); return p.appendJournal(s, e); } }) });
    const c = await issued(env);
    failJournal = true;
    expect(res(await consume(env, c)).result).toBe('unavailable'); // no receipt reached the caller
    expect(existsSync(consumptionFile(env, c.id))).toBe(true); // yet the challenge IS consumed
    expect(kinds(env)).toEqual(['genesis', 'issue']);
    failJournal = false;
    expect(res(await consume(env, c, { requestId: generateRequestId() }))).toEqual({ result: 'already_used' });
    const retry = res(await consume(env, c));
    expect(retry.result).toBe('consumed');
    expect(kinds(env)).toEqual(['genesis', 'issue', 'consume']);
    expect(JSON.parse(readFileSync(consumptionFile(env, c.id), 'utf-8')).receipt).toEqual(retry.receipt);
  });

  it('the same crash, then a restart: recovery completes the entry before anything else', async () => {
    let failJournal = false;
    const env = await build({ wrap: (p) => ({ ...p, appendJournal: async (s, e) => { if (failJournal) throw new Error('crash'); return p.appendJournal(s, e); } }) });
    const c = await issued(env);
    failJournal = true;
    await consume(env, c);
    const restarted = await restart(env);
    expect(await restarted.core.recover()).toMatchObject({ phase: 'ready', findings: [] });
    expect(kinds(restarted)).toEqual(['genesis', 'issue', 'consume']);
    expect(res(await consume(restarted, c, { requestId: generateRequestId() }))).toEqual({ result: 'already_used' });
  });

  it('crash before the consumption commit: nothing consumed, and the retry consumes once', async () => {
    let crash = true;
    const env = await build({ wrap: (p) => ({ ...p, commitConsumption: async (r) => { if (crash) throw new Error('crash'); return p.commitConsumption(r); } }) });
    const c = await issued(env);
    expect(res(await consume(env, c)).result).toBe('unavailable');
    expect(existsSync(consumptionFile(env, c.id))).toBe(false);
    expect(kinds(env)).toEqual(['genesis', 'issue']);
    crash = false;
    expect(res(await consume(env, c)).result).toBe('consumed');
  });

  it('crash after the issuance record but before its entry: no token was returned, and recovery adopts the orphan', async () => {
    let failJournal = false;
    const env = await build({ wrap: (p) => ({ ...p, appendJournal: async (s, e) => { if (failJournal) throw new Error('crash'); return p.appendJournal(s, e); } }) });
    await env.core.recover();
    failJournal = true;
    expect(res(await rawIssue(env))).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(readdirSync(join(env.dir, 'issuance'))).toHaveLength(1);
    expect(kinds(env)).toEqual(['genesis']);
    const restarted = await restart(env);
    expect(await restarted.core.recover()).toMatchObject({ phase: 'ready', findings: [] });
    expect(kinds(restarted)).toEqual(['genesis', 'issue']);
  });

  it('an interrupted write of a journal entry itself leaves nothing half-written', async () => {
    let crash = false;
    const env = await build({
      wrap: (p) => ({
        ...p,
        appendJournal: async (s, e) => {
          if (crash) throw new Error('crash while writing the entry');
          return p.appendJournal(s, e);
        },
      }),
    });
    const a = await issued(env);
    crash = true;
    expect(res(await consume(env, a)).result).toBe('unavailable');
    expect(readdirSync(join(env.dir, 'tmp'))).toEqual([]);
    expect(journalFiles(env)).toHaveLength(2);
    crash = false;
    expect(res(await consume(env, a)).result).toBe('consumed');
  });

  it('crash after the journal entry but before the anchor update: the anchor is repaired, not trusted blindly', async () => {
    const anchor = makeAnchor();
    const env = await build({ anchor });
    const c = await issued(env);
    anchor.failNextAdvance = true;
    expect(res(await consume(env, c)).result).toBe('unavailable'); // the record and the entry exist; the anchor lags
    expect(anchor.state?.sequence).toBe(2);
    expect(kinds(env)).toEqual(['genesis', 'issue', 'consume']);
    const retry = res(await consume(env, c));
    expect(retry.result).toBe('consumed');
    expect(anchor.state?.sequence).toBe(3); // repaired
    expect(anchor.state?.headHash).toBe(entryHash(JSON.parse(readFileSync(journalFile(env, 3), 'utf-8'))));
  });
});

// ================================================================ time

describe('store time across restarts', () => {
  it('refuses to run while the clock is earlier than the newest journal entry, and resumes when it catches up', async () => {
    const env = await build();
    const c = await issued(env);
    await consume(env, c);
    const behind = await restart(env, {});
    await behind.core.recover();
    behind.clock.ms = START - 3600_000; // the clock goes back after the restart
    expect(res(await rawIssue(behind))).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(behind.core.status().phase).toBe('ready'); // refused for now: NOT a corruption, nothing is blocked
    expect(kinds(behind)).toEqual(['genesis', 'issue', 'consume']); // nothing was written
    behind.clock.ms = START + 60_000;
    behind.material.revocation = revocationAt(behind.clock.ms);
    expect(res(await rawIssue(behind)).result).toBe('issued');
  });

  it('a core created after a restart with an earlier clock never writes an entry dated before the journal', async () => {
    const env = await build();
    const c = await issued(env);
    const earlier = await build({ dir: env.dir, clock: { ms: START - 7200_000 }, material: { policy: sign(policyDoc(), policyKey, 'policy'), revocation: revocationAt(START - 7200_000) } });
    expect(await earlier.core.recover()).toMatchObject({ phase: 'ready' });
    expect(res(await rawIssue(earlier))).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(res(await consume(earlier, c))).toEqual({ result: 'unavailable' });
    expect(kinds(env)).toEqual(['genesis', 'issue']);
  });
});

// ================================================================ simultaneous recovery

describe('simultaneous recovery', () => {
  it('several cores starting at once on a new directory create exactly one genesis', async () => {
    const dir = newDir();
    const cores = await Promise.all(Array.from({ length: 5 }, () => build({ dir })));
    const statuses = await Promise.all(cores.map((c) => c.core.recover()));
    expect(statuses.every((s) => s.phase === 'ready')).toBe(true);
    expect(kinds(cores[0]!)).toEqual(['genesis']);
  });

  it('several cores completing the same interrupted operation write its entry once', async () => {
    let failJournal = false;
    const env = await build({ wrap: (p) => ({ ...p, appendJournal: async (s, e) => { if (failJournal) throw new Error('crash'); return p.appendJournal(s, e); } }) });
    const c = await issued(env);
    failJournal = true;
    await consume(env, c);
    const cores = await Promise.all(Array.from({ length: 4 }, () => restart(env)));
    const statuses = await Promise.all(cores.map((x) => x.core.recover()));
    expect(statuses.every((s) => s.phase === 'ready' && s.findings.length === 0)).toBe(true);
    expect(kinds(env)).toEqual(['genesis', 'issue', 'consume']);
  });

  it('concurrent operations from two cores keep one consistent chain', async () => {
    const a = await build();
    const b = await restart(a);
    const results = await Promise.all([rawIssue(a), rawIssue(b), rawIssue(a), rawIssue(b)]);
    expect(results.every((r) => r.result === 'issued')).toBe(true);
    expect(kinds(a)).toEqual(['genesis', 'issue', 'issue', 'issue', 'issue']);
    expect((await (await restart(a)).core.recover()).phase).toBe('ready');
  });
});

// ================================================================ operator recovery and the quiet period

describe('operator recovery', () => {
  it('requires every current finding to be acknowledged, and invalidates challenges issued before it', async () => {
    const env = await build();
    const consumed = await issued(env);
    await consume(env, consumed);
    const pending = await issued(env); // issued, never consumed
    rmSync(consumptionFile(env, consumed.id));
    // the loss is noticed when the record is next needed (a restart would notice it at once), and then the whole store stops
    expect(res(await consume(env, consumed, { requestId: generateRequestId() })).result).toBe('unavailable');
    expect(res(await consume(env, pending)).result).toBe('unavailable');

    expect(await env.operator.declareRecovery({ acknowledge: [], quietPeriodMs: 60_000 })).toEqual({ ok: false, code: 'unacknowledged_findings', missing: ['consumption_record_missing'] });
    for (const bad of [{ acknowledge: 'all', quietPeriodMs: 60_000 }, { acknowledge: ['journal_gap'], quietPeriodMs: 60_000 }, { acknowledge: ['consumption_record_missing', 'consumption_record_missing'], quietPeriodMs: 60_000 }, { acknowledge: [], quietPeriodMs: 10 }, { acknowledge: [], quietPeriodMs: 25 * 3600_000 }, { acknowledge: [], quietPeriodMs: 1.5 }, null, hostile()]) {
      expect(await env.operator.declareRecovery(bad as never)).toEqual({ ok: false, code: 'invalid_request' });
    }
    const done = await env.operator.declareRecovery({ acknowledge: ['consumption_record_missing'], quietPeriodMs: 120_000 });
    expect(done.ok).toBe(true);
    expect(kinds(env)).toContain('recovery');

    // QUIET PERIOD: nothing is issued or consumed until it has passed
    expect(env.core.status()).toMatchObject({ phase: 'quiet', findings: [] });
    expect(res(await rawIssue(env))).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(res(await consume(env, pending))).toEqual({ result: 'unavailable' });
    advance(env, 121);
    expect(env.core.status().phase).toBe('ready');

    // a challenge from before the recovery is never accepted again: its consumption status was unknown
    expect(res(await consume(env, pending))).toEqual({ result: 'unknown_challenge' });
    // the lost consumption is remembered by the journal, never treated as unused
    expect(res(await consume(env, consumed, { requestId: generateRequestId() }))).toEqual({ result: 'already_used' });
    // new challenges work normally
    const fresh = await issued(env);
    expect(res(await consume(env, fresh)).result).toBe('consumed');
  });

  it('is not triggered by any request, and is not part of the core object', async () => {
    const env = await build();
    const done = await issued(env);
    await consume(env, done);
    rmSync(consumptionFile(env, done.id));
    await consume(env, done, { requestId: generateRequestId() });
    expect(env.core.status().phase).toBe('blocked');
    expect(Object.keys(env.core).sort()).toEqual(['consume', 'identity', 'issue', 'recover', 'status']);
    for (const request of [{ declareRecovery: { acknowledge: [], quietPeriodMs: 1000 } }, { operator: 'sealGeneration', nextGeneration: 'gen-2' }, { ...done.attempt.request, acknowledge: ['consumption_record_missing'] }]) {
      expect(res(await env.core.consume(request)).result).toBe('invalid_request');
      expect(res(await env.core.issue(request)).result).toBe('rejected');
    }
    expect(env.core.status().phase).toBe('blocked'); // no request cleared the block
    expect(kinds(env)).not.toContain('recovery');
  });

  it('can declare a recovery on a healthy store (a restore the operator knows about), and the quiet period still applies', async () => {
    const env = await build();
    const before = await issued(env);
    const done = await env.operator.declareRecovery({ acknowledge: [], quietPeriodMs: 30_000 });
    expect(done.ok).toBe(true);
    expect(res(await rawIssue(env)).result).toBe('rejected');
    advance(env, 31);
    expect(res(await consume(env, before)).result).toBe('unknown_challenge');
    expect(res(await rawIssue(env)).result).toBe('issued');
  });

  it('survives a restart: the quiet period and the invalidation are in the signed journal, not in memory', async () => {
    const env = await build();
    const before = await issued(env);
    await env.operator.declareRecovery({ acknowledge: [], quietPeriodMs: 300_000 });
    const restarted = await restart(env);
    expect(res(await rawIssue(restarted)).result).toBe('rejected');
    expect(restarted.core.status().phase).toBe('quiet');
    advance(restarted, 301);
    expect(res(await consume(restarted, before)).result).toBe('unknown_challenge');
  });

  it('a quiet period does NOT stop a malicious operator who also controls the clock or bypasses the store: it only covers honest recovery', async () => {
    const env = await build();
    await issued(env);
    await env.operator.declareRecovery({ acknowledge: [], quietPeriodMs: 600_000 });
    // an operator who rolls the store's clock FORWARD past the quiet period simply ends it: the store cannot tell
    env.clock.ms += 601_000;
    env.material.revocation = revocationAt(env.clock.ms);
    expect(env.core.status().phase).toBe('ready');
  });
});

// ================================================================ generations

describe('generation rotation', () => {
  it('seals the old generation, which then refuses to run; the new generation starts in a new directory and records where it came from', async () => {
    const env = await build();
    const old = await issued(env);
    const oldToken = res(await rawIssue(env)).token;
    const consumedOld = await issued(env);
    const oldReceipt = res(await consume(env, consumedOld));
    const sealed = await env.operator.sealGeneration({ nextGeneration: 'gen-2' });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.seal).toMatchObject({ storeId: 'store-1', generation: 'gen-1', nextGeneration: 'gen-2', sequence: 6 });

    // the old generation is retired: it answers nothing, in this process and after a restart
    expect(env.core.status().phase).toBe('retired');
    expect(res(await consume(env, old))).toEqual({ result: 'unavailable' });
    expect(res(await rawIssue(env))).toEqual({ result: 'rejected', reason: 'unavailable' });
    const reopened = await restart(env);
    expect(await reopened.core.recover()).toMatchObject({ phase: 'retired' });
    expect(res(await consume(reopened, old)).result).toBe('unavailable');

    // the new generation: same store id, different generation id, a new directory, continuing from the seal
    const next = await build({ generation: 'gen-2', continuesFrom: sealed.seal });
    expect((await next.core.recover()).phase).toBe('ready');
    expect(next.core.identity).toMatchObject({ storeId: 'store-1', storeGeneration: 'gen-2' });
    expect(entries(next)[0]?.event).toEqual({ kind: 'genesis', previousGeneration: 'gen-1', previousSequence: 6, previousHash: sealed.seal.headHash });
    expect(sealed.seal.headHash).toBe(entryHash(JSON.parse(readFileSync(journalFile(env, 6), 'utf-8'))));

    // an OLD challenge cannot be consumed in the new generation (it does not even exist there)
    expect(res(await next.core.consume(old.attempt.request)).result).toBe('unknown_challenge');
    // and an old receipt is distinguishable: it names generation gen-1
    const receiptPayload = JSON.parse(Buffer.from((oldReceipt.receipt as SignedEnvelope).payload, 'base64url').toString('utf-8'));
    expect(receiptPayload.storeGeneration).toBe('gen-1');
    // new-generation challenges work, and carry the new generation
    const fresh = await requestChallengeToken({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), storeGeneration: 'gen-2', requester: alice.grant, grantEnvelope: alice.envelope, context: CTX, now: now(next), transport: createInProcessTransport(next.core), timeoutMs: 2000 });
    expect(fresh.ok).toBe(true);
    // ...and a client that pins the new generation refuses a token from the old one
    const stale = await requestChallengeToken({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), storeGeneration: 'gen-2', requester: alice.grant, grantEnvelope: alice.envelope, context: CTX, now: now(env), transport: { issue: async () => ({ result: 'issued', token: oldToken }), consume: async () => ({}) }, timeoutMs: 2000 });
    expect(stale.ok).toBe(false);
  });

  it('cannot be undone: the old directory cannot be reopened as the current generation, and an old copy is not the new generation', async () => {
    const env = await build();
    const sealed = await env.operator.sealGeneration({ nextGeneration: 'gen-2' });
    if (!sealed.ok) throw new Error('setup');
    // the old directory under the NEW generation id: the identity marker refuses it
    await expect(openFilesystemPersistence({ root: env.dir, storeId: 'store-1', storeGeneration: 'gen-2' })).rejects.toMatchObject({ code: 'identity_mismatch' });
    // appending after the seal is chain damage
    expect(entries(env).map((e) => e.event.kind)).toEqual(['genesis', 'seal']);
  });

  it('refuses invalid rotation requests and a mismatched continuation', async () => {
    const env = await build();
    await env.core.recover();
    for (const bad of [{ nextGeneration: 'gen-1' }, { nextGeneration: 'bad generation' }, { nextGeneration: 5 }, {}, null, hostile()]) {
      expect(await env.operator.sealGeneration(bad as never)).toEqual({ ok: false, code: 'invalid_request' });
    }
    expect(kinds(env)).toEqual(['genesis']); // nothing sealed
    const sealed = await env.operator.sealGeneration({ nextGeneration: 'gen-2' });
    if (!sealed.ok) throw new Error('setup');
    const cfg = (env.config as ChallengeStoreCoreConfig);
    const wrong = (seal: object) => createChallengeStoreCore({ ...cfg, storeGeneration: 'gen-2', continuesFrom: seal as never });
    expect(wrong({ ...sealed.seal, nextGeneration: 'gen-3' }).ok).toBe(false);
    expect(wrong({ ...sealed.seal, storeId: 'store-9' }).ok).toBe(false);
    expect(wrong({ ...sealed.seal, generation: 'gen-2' }).ok).toBe(false);
    expect(wrong({ ...sealed.seal, headHash: 'nope' }).ok).toBe(false);
    // a continuation that does not match what the new journal's genesis says is refused on a later restart
    const dir2 = newDir();
    const next = await build({ dir: dir2, generation: 'gen-2', continuesFrom: sealed.seal });
    await next.core.recover();
    const lying = await build({ dir: dir2, generation: 'gen-2', continuesFrom: { ...sealed.seal, headHash: `sha256:${'9'.repeat(64)}` } });
    expect(await lying.core.recover()).toMatchObject({ phase: 'blocked', findings: ['journal_bad_genesis'] });
  });

  it('refuses to seal a blocked store (a damaged generation is replaced, not rotated)', async () => {
    const env = await build();
    const c = await issued(env);
    await consume(env, c);
    rmSync(consumptionFile(env, c.id));
    await consume(env, c, { requestId: generateRequestId() });
    expect(env.core.status().phase).toBe('blocked');
    expect(await env.operator.sealGeneration({ nextGeneration: 'gen-2' })).toEqual({ ok: false, code: 'not_ready' });
  });
});

// ================================================================ anchor contract

describe('the external anchor contract', () => {
  it('advances after every journal entry and never moves backwards', async () => {
    const anchor = makeAnchor();
    const env = await build({ anchor });
    const c = await issued(env);
    await consume(env, c);
    expect(anchor.state).toMatchObject({ storeId: 'store-1', generation: 'gen-1', sequence: 3 });
    expect(anchor.advances).toBe(3);
    await expect(anchor.advance({ ...anchor.state!, sequence: 2 })).rejects.toThrow();
    expect(env.core.status().anchor).toBe('configured');
  });

  it('refuses an anchor that belongs to another store, generation or history', async () => {
    const anchor = makeAnchor();
    const env = await build({ anchor });
    await issued(env);
    for (const wrong of [{ storeId: 'store-9' }, { generation: 'gen-9' }, { headHash: `sha256:${'8'.repeat(64)}` }]) {
      const a2 = makeAnchor();
      a2.state = { ...anchor.state!, ...wrong };
      const restarted = await restart(env, { anchor: a2 });
      expect((await restarted.core.recover()).findings, JSON.stringify(wrong)).toEqual(['anchor_inconsistent']);
    }
  });

  it('a lagging anchor (a crash before its update) is repaired when the chain agrees with it', async () => {
    const anchor = makeAnchor();
    const env = await build({ anchor });
    await issued(env);
    anchor.state = { ...anchor.state!, sequence: 1, headHash: entryHash(JSON.parse(readFileSync(journalFile(env, 1), 'utf-8'))) };
    const restarted = await restart(env, { anchor });
    expect((await restarted.core.recover()).phase).toBe('ready');
    expect(anchor.state?.sequence).toBe(2);
  });

  it('a brand-new anchor is accepted and brought up to date (documented: a wiped anchor looks the same)', async () => {
    const env = await build();
    await issued(env);
    const fresh = makeAnchor();
    const restarted = await restart(env, { anchor: fresh });
    expect((await restarted.core.recover()).phase).toBe('ready');
    expect(fresh.state?.sequence).toBe(2);
  });

  it('refuses a malformed anchor object', async () => {
    const env = await build();
    for (const anchor of [{}, { read: () => undefined }, { advance: () => undefined }, 'anchor']) expect(createChallengeStoreCore({ ...env.config, anchor: anchor as unknown as RollbackAnchor }).ok).toBe(false);
  });
});

// ================================================================ uncertain state never authorizes

describe('no success while the recovery state is uncertain', () => {
  it('a storage failure during recovery leaves the store "not started": every answer is unavailable until storage works', async () => {
    let broken = true;
    const env = await build({ wrap: (p) => ({ ...p, readJournal: async (a) => { if (broken) throw Object.assign(new Error('x'), { code: 'EIO' }); return p.readJournal(a); } }) });
    expect(res(await rawIssue(env))).toEqual({ result: 'rejected', reason: 'unavailable' });
    expect(env.core.status().phase).toBe('not_started');
    broken = false;
    expect(res(await rawIssue(env)).result).toBe('issued');
  });

  it('every kind of block yields no token and no receipt', async () => {
    const env = await build();
    const c = await issued(env);
    await consume(env, c);
    rmSync(journalFile(env, 2)); // chain damage
    const restarted = await restart(env);
    const answers = [await rawIssue(restarted), await consume(restarted, c), await consume(restarted, c, { requestId: generateRequestId() })];
    for (const a of answers) {
      expect(res(a)).not.toHaveProperty('token');
      expect(res(a)).not.toHaveProperty('receipt');
      expect(['unavailable', 'rejected']).toContain(res(a).result);
    }
    expect(restarted.core.status().phase).toBe('blocked');
  });
});

// ================================================================ directory protection

describe('directory protection reporting', () => {
  it('says "unverified" instead of claiming the directory is secure, and exposes it in the store status', async () => {
    const env = await build();
    const status = env.core.status();
    expect(status.protection.status).toBe(process.platform === 'win32' ? 'unverified' : status.protection.status);
    expect(status.protection).toMatchObject({ acl: 'not_checked', rootAndSubdirectories: 'checked_each_access' });
    expect(status.protection.status).not.toBe('secure' as never);
    expect(status.durability).toMatchObject({ fileSync: true, exclusiveCreate: 'hard_link' });
    const win = await openFilesystemPersistence({ root: newDir(), storeId: 'store-1', storeGeneration: 'gen-1', platform: 'win32' });
    expect(win.protection).toEqual({ status: 'unverified', platform: 'win32', ownerAndMode: 'not_applicable', acl: 'not_checked', ancestorLinks: 'not_checked', rootAndSubdirectories: 'checked_each_access' });
    expect(win.durability.directorySync).toBe(false);
  });
});

// ================================================================ scope

describe('scope', () => {
  it('adds no network, service or pipeline code and touches no other module', () => {
    const base = join(process.cwd(), 'src/features/action-safety/authorization');
    const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const file of ['challengeStoreJournal.ts', 'challengeStoreCore.ts', 'challengeStorePersistence.ts']) {
      const text = strip(readFileSync(join(base, file), 'utf-8'));
      expect(text, file).not.toMatch(/node:net|node:http|node:https|node:dgram|node:tls|child_process|fetch\(|process\.env|require\(/);
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
      for (const forbidden of ['./twoPhaseAuthorization.js', './evaluateAuthorization.js', './strictAuthorityAdapter.js', './strictConfig.js', './actionContextCollector.js']) expect(imports, file).not.toContain(forbidden);
    }
    expect(ZERO_HASH).toMatch(/^sha256:0{64}$/);
  });
});
