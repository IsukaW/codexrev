// The adapter between the legacy ChallengeStore interface and the signed challenge protocol.
// It must answer 'consumed' ONLY after a signed receipt was verified.

import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChallengeStoreCore, type ChallengeStoreCore } from '../../../../src/features/action-safety/authorization/challengeStoreCore.js';
import { openFilesystemPersistence } from '../../../../src/features/action-safety/authorization/challengeStorePersistence.js';
import { signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { consumeChallenge, createProof, verifyProof, type ActionContext } from '../../../../src/features/action-safety/authorization/proof.js';
import { requestChallengeToken } from '../../../../src/features/action-safety/authorization/trustedChallengeStoreClient.js';
import { createInProcessTransport } from '../../../../src/features/action-safety/authorization/challengeStoreCore.js';
import { createVerifiedStoreAdapter } from '../../../../src/features/action-safety/strict/storeAdapter.js';
import { loadPrivateKey } from '../../../../src/features/action-safety/strict/keyStore.js';
import { NOW, setupOrganization, verifiedGrantOf, type Fixture } from '../../../../src/features/action-safety/testing/strictFixture.js';
import { readJsonFile } from '../../../../src/features/action-safety/strict/files.js';

let f: Fixture;
let n = 0;
const CTX: ActionContext = { actionId: 'act-1', actionType: 'code_change', environment: 'development', target: 'my-app', commit: 'a'.repeat(40), contentDigest: `sha256:${'b'.repeat(64)}` };
beforeAll(async () => {
  f = await setupOrganization({ withRepo: false });
}, 60_000);
afterAll(() => f.cleanup());

async function setup(wrapCore: (core: ChallengeStoreCore) => ChallengeStoreCore = (c) => c) {
  const storeKey = await loadPrivateKey({ name: 'store', keysDir: f.keysDir, platform: 'win32' });
  const alice = await verifiedGrantOf(f, f.grants.alice);
  const aliceKey = await loadPrivateKey({ name: 'alice', keysDir: f.keysDir, platform: 'win32' });
  const persistence = await openFilesystemPersistence({ root: join(f.root, `adapter-store-${++n}`), storeId: 'local-demo', storeGeneration: 'gen-1' });
  const material = { policy: f.authority.policyEnvelope, revocation: f.authority.revocationEnvelope };
  const created = createChallengeStoreCore({ organization: 'acme', storeId: 'local-demo', storeGeneration: 'gen-1', signingKey: storeKey.privateKey, trustRoot: f.authority.trustRoot, authority: { current: () => material }, clock: { now: () => NOW }, persistence });
  if (!created.ok) throw new Error(`core: ${created.code}`);
  const core = wrapCore(created.core);
  const grantEnvelope = await readJsonFile(f.grants.alice.file, 'grant');
  const issued = await requestChallengeToken({ trustRoot: f.authority.trustRoot, storeId: 'local-demo', signingKeyId: storeKey.keyId, requester: alice, grantEnvelope, context: CTX, now: NOW, transport: createInProcessTransport(created.core), timeoutMs: 2000 });
  if (!issued.ok) throw new Error(`issue: ${issued.code}`);
  const proof = createProof({ privateKey: aliceKey.privateKey, grant: alice, context: CTX, challenge: issued.token.token.challenge, issuedAt: NOW });
  const adapter = createVerifiedStoreAdapter({ core, trustRoot: f.authority.trustRoot, storeId: 'local-demo', storeKeyId: storeKey.keyId, token: issued.token, requester: alice, context: CTX, proof, now: () => NOW });
  const entry = { challenge: issued.token.token.challenge, grantId: alice.grant.grantId, actionId: CTX.actionId, expiresAt: '2026-06-01T12:05:00Z' };
  return { adapter, entry, core, issued, alice, proof, storeKey };
}

describe('the verified store adapter', () => {
  it('answers "consumed" only after the signed protocol returned a verified receipt, and keeps no challenge', async () => {
    const { adapter, entry } = await setup();
    expect(adapter.consumption()).toBeUndefined();
    expect(await adapter.consume(entry)).toBe('consumed');
    const c = adapter.consumption();
    expect(c?.receiptId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(c)).not.toContain(entry.challenge);
    expect(adapter.failure()).toBeUndefined();
  });

  it('is single-use: a second call answers "already_used" and never reaches the store again', async () => {
    const { adapter, entry } = await setup();
    expect(await adapter.consume(entry)).toBe('consumed');
    expect(await adapter.consume(entry)).toBe('already_used');
  });

  it('refuses a call for another challenge, grant or action (it throws, which the evaluator reads as "unavailable")', async () => {
    for (const change of [{ challenge: 'x'.repeat(43) }, { grantId: 'grant-other' }, { actionId: 'act-other' }]) {
      const { adapter, entry } = await setup();
      await expect(adapter.consume({ ...entry, ...change })).rejects.toThrow();
      expect(adapter.consumption()).toBeUndefined();
      expect(adapter.failure()).toBe('consume_request_mismatch');
    }
  });

  it('never turns a bare "consumed", a missing receipt, a forged receipt or a silent store into success', { timeout: 60_000 }, async () => {
    const bare = await setup((core) => ({ ...core, consume: async () => 'consumed' as never }));
    await expect(bare.adapter.consume(bare.entry)).rejects.toThrow();
    expect(bare.adapter.consumption()).toBeUndefined();
    const noReceipt = await setup((core) => ({ ...core, consume: async () => ({ result: 'consumed' }) as never }));
    await expect(noReceipt.adapter.consume(noReceipt.entry)).rejects.toThrow();
    // a receipt signed by a key the trust root does not know
    const stranger = await loadPrivateKey({ name: 'mallory', keysDir: f.keysDir, platform: 'win32' });
    const forged = await setup((core) => ({
      ...core,
      consume: async (req) => {
        const real = (await core.consume(req)) as { result: string; receipt?: { payload: string } };
        return real.receipt ? ({ result: 'consumed', receipt: signEnvelope({ domain: 'receipt', payload: Buffer.from(real.receipt.payload, 'base64url'), privateKey: stranger.privateKey }) } as never) : (real as never);
      },
    }));
    await expect(forged.adapter.consume(forged.entry)).rejects.toThrow();
    expect(forged.adapter.consumption()).toBeUndefined();
    const silent = await setup((core) => ({ ...core, consume: () => new Promise(() => {}) }));
    const started = Date.now();
    const timed = createVerifiedStoreAdapter({ core: silent.core, trustRoot: f.authority.trustRoot, storeId: 'local-demo', storeKeyId: silent.storeKey.keyId, token: silent.issued.token, requester: silent.alice, context: CTX, proof: silent.proof, now: () => NOW, timeoutMs: 50 });
    await expect(timed.consume(silent.entry)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(30_000); // it returned instead of waiting forever (the bound is loose so a loaded machine does not make this flaky)
    expect(timed.consumption()).toBeUndefined();
  });

  it('works with the real evaluator entry point: consumeChallenge turns a throw into "unavailable", never "consumed"', async () => {
    const ok = await setup();
    const verified = verifyProof(ok.proof, ok.alice, CTX, ok.issued.token.token.challenge, NOW);
    if (!verified.ok) throw new Error('setup');
    expect(await consumeChallenge(verified, ok.adapter)).toBe('consumed');
    const bad = await setup((core) => ({ ...core, consume: async () => 'consumed' as never }));
    const v2 = verifyProof(bad.proof, bad.alice, CTX, bad.issued.token.token.challenge, NOW);
    if (!v2.ok) throw new Error('setup');
    expect(await consumeChallenge(v2, bad.adapter)).toBe('unavailable');
  });

  it('maps the store’s own "already used" refusal to the legacy answer, but only as a refusal', async () => {
    const used = await setup((core) => ({ ...core, consume: async () => ({ result: 'already_used' }) as never }));
    expect(await used.adapter.consume(used.entry)).toBe('already_used');
    expect(used.adapter.consumption()).toBeUndefined();
  });
});
