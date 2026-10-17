/* global AbortController, AbortSignal */
// Tests for the trusted challenge store CLIENT contract. In-memory Ed25519 keys only; offline.
//
// IMPORTANT: `createSimulatedStore` below is a TEST SIMULATION of a protected store. It exists only in this
// file, it is not durable, not protected and not a store implementation. It signs real tokens and receipts
// so the client's verification can be exercised, and it can be told to misbehave.

import { readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { URL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeActionContextDigest, computeChallengeHash, computeProofDigest, isRequestId, wholeSecondsText } from '../../../../src/features/action-safety/authorization/challengeCommon.js';
import { createChallengeToken, isVerifiedChallengeToken, type CreateChallengeTokenParams } from '../../../../src/features/action-safety/authorization/challengeToken.js';
import { isVerifiedConsumptionReceipt } from '../../../../src/features/action-safety/authorization/consumptionReceipt.js';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { verifyGrant, type VerifiedGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy } from '../../../../src/features/action-safety/authorization/policy.js';
import { computeContentDigest, createProof, type ActionContext } from '../../../../src/features/action-safety/authorization/proof.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import type { SignedEnvelope } from '../../../../src/features/action-safety/authorization/types.js';
import {
  DEFAULT_STORE_TIMEOUT_MS,
  MAX_STORE_TIMEOUT_MS,
  generateRequestId,
  isConsumptionAttempt,
  prepareConsumptionAttempt,
  requestChallengeToken,
  submitConsumption,
  type ChallengeStoreTransport,
  type ConsumptionAttempt,
  type ConsumeResult,
  type IssueResult,
  type RequestChallengeParams,
  type StoreConsumeRequest,
  type StoreIssueRequest,
} from '../../../../src/features/action-safety/authorization/trustedChallengeStoreClient.js';

const T0 = new Date('2026-06-01T12:00:00Z');
const NOW = new Date('2026-06-01T12:01:00Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');
const raw = (k: Keys): string => exportRawPublicKey(k.publicKey).toString('base64url');
const id = (k: Keys): string => deriveKeyId(k.publicKey);
const entry = (k: Keys, purposes: string[]): Record<string, unknown> => ({ keyId: id(k), publicKey: raw(k), purposes, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' });

const CTX: ActionContext = { actionId: 'act-001', actionType: 'code_change', environment: 'development', target: 'payments-service', commit: 'a'.repeat(40), contentDigest: computeContentDigest(Buffer.from('diff')) };
const OTHER_CTX: ActionContext = { ...CTX, actionId: 'act-002' };

let storeKey: Keys;
let otherStoreKey: Keys;
let policyKey: Keys;
let grantKey: Keys;
let outsider: Keys;
let aliceKey: Keys;
let bobKey: Keys;
let root: TrustRoot;
const envelopeOf = new WeakMap<object, SignedEnvelope>();
let alice: VerifiedGrant;
let bob: VerifiedGrant;

const makeRoot = (organization: string, keys: Record<string, unknown>[]): TrustRoot => {
  const r = parseTrustRoot({ version: 1, organization, createdAt: '2026-01-01T00:00:00Z', keys });
  if (!r.ok) throw new Error(`setup: ${r.code}`);
  return r.trustRoot;
};

beforeAll(() => {
  [storeKey, otherStoreKey, policyKey, grantKey, outsider, aliceKey, bobKey] = Array.from({ length: 7 }, pair) as Keys[];
  root = makeRoot('acme', [entry(storeKey, ['challenge_store']), entry(otherStoreKey, ['challenge_store']), entry(policyKey, ['policy']), entry(grantKey, ['grant'])]);
  const policyDoc = {
    version: 2, organization: 'acme', policyId: 'acme-policy', revision: 5,
    issuedAt: '2026-05-01T00:00:00Z', effectiveAt: '2026-05-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
    permissions: ['code.change'], roles: [{ name: 'developer', permissions: ['code.change'] }], rules: [],
  };
  const p = verifyPolicy(signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(policyDoc)), privateKey: policyKey.privateKey }), root, T0);
  if (!p.ok) throw new Error(`setup policy: ${p.code}`);
  const grantFor = (who: Keys, grantId: string, subjectId: string): VerifiedGrant => {
    const signed = signEnvelope({
        domain: 'grant',
        payload: Buffer.from(JSON.stringify({ version: 1, grantId, organization: 'acme', subject: { id: subjectId, type: 'human', publicKey: raw(who), keyId: id(who) }, roles: ['developer'], permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1 })),
        privateKey: grantKey.privateKey,
    });
    const g = verifyGrant(signed, root, p.policy, T0);
    if (!g.ok) throw new Error(`setup grant: ${g.code}`);
    envelopeOf.set(g, signed);
    return g;
  };
  alice = grantFor(aliceKey, 'grant-alice-001', 'alice');
  bob = grantFor(bobKey, 'grant-bob-001', 'bob');
});

// ---------------------------------------------------------------- the simulated store (TEST DOUBLE ONLY)

interface Behaviors {
  /** replaces the real issuance answer */
  issueResponse?: (req: StoreIssueRequest) => unknown;
  /** merged into the token the store signs (to simulate a store that signs the wrong thing) */
  tokenParams?: Partial<CreateChallengeTokenParams>;
  tokenSigner?: Keys;
  /** replaces the real consumption answer; `real()` performs the genuine, idempotent consumption */
  consumeResponse?: (req: StoreConsumeRequest, real: () => unknown) => unknown;
  /** merged into the receipt payload before signing */
  receiptOverrides?: Record<string, unknown>;
  receiptSigner?: Keys;
  /** perform the consumption, then never answer (the first time): a crash or a lost response */
  dropNextConsumeResponse?: boolean;
  /** never answer at all */
  hangIssue?: boolean;
  hangConsume?: boolean;
  throwIssue?: boolean;
  throwConsume?: boolean;
}

function createSimulatedStore(behaviors: Behaviors = {}) {
  const issued = new Map<string, { challenge: string; expiresAt: string; issuedAt: string; contextDigest: string; grantId: string; subjectId: string; subjectKeyId: string; organization: string }>();
  const consumed = new Map<string, { requestId: string; envelope: SignedEnvelope }>();
  const log = { issue: [] as StoreIssueRequest[], consume: [] as StoreConsumeRequest[], signals: [] as AbortSignal[] };

  const doConsume = (req: StoreConsumeRequest): unknown => {
    const rec = issued.get(req.challengeId);
    if (!rec || rec.challenge !== req.challenge) return { result: 'unknown_challenge' };
    const done = consumed.get(req.challengeId);
    if (done) return done.requestId === req.requestId ? { result: 'consumed', receipt: done.envelope } : { result: 'already_used' };
    if (T0.getTime() + 40_000 >= Date.parse(rec.expiresAt)) return { result: 'expired' };
    if (rec.organization !== req.organization || rec.grantId !== req.grantId || rec.subjectId !== req.subjectId || rec.subjectKeyId !== req.subjectKeyId || rec.contextDigest !== req.contextDigest) return { result: 'binding_mismatch' };
    const payload = {
      version: 1,
      organization: req.organization,
      storeId: req.storeId,
      storeGeneration: 'gen-1',
      receiptId: randomBytes(16).toString('base64url'),
      challengeId: req.challengeId,
      challengeHash: computeChallengeHash(rec.challenge),
      grantId: req.grantId,
      subjectId: req.subjectId,
      subjectKeyId: req.subjectKeyId,
      contextDigest: req.contextDigest,
      proofDigest: req.proofDigest,
      requestId: req.requestId,
      issuedAt: rec.issuedAt,
      consumedAt: wholeSecondsText(T0.getTime() + 40_000),
      expiresAt: rec.expiresAt,
      ...behaviors.receiptOverrides,
    };
    const envelope = signEnvelope({ domain: 'receipt', payload: Buffer.from(JSON.stringify(payload)), privateKey: (behaviors.receiptSigner ?? storeKey).privateKey });
    consumed.set(req.challengeId, { requestId: req.requestId, envelope });
    return { result: 'consumed', receipt: envelope };
  };

  const transport: ChallengeStoreTransport = {
    async issue(req, { signal }) {
      log.issue.push(req);
      log.signals.push(signal);
      if (behaviors.throwIssue) throw new Error('SECRET-TRANSPORT-DETAIL');
      if (behaviors.hangIssue) return new Promise(() => {});
      if (behaviors.issueResponse) return behaviors.issueResponse(req);
      const env = createChallengeToken({
        privateKey: (behaviors.tokenSigner ?? storeKey).privateKey,
        organization: req.organization,
        storeId: req.storeId,
        storeGeneration: 'gen-1',
        grantId: req.grantId,
        subjectId: req.subjectId,
        subjectKeyId: req.subjectKeyId,
        context: req.context,
        issuedAt: T0,
        ...behaviors.tokenParams,
      });
      const p = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
      issued.set(p.challengeId, { challenge: p.challenge, expiresAt: p.expiresAt, issuedAt: p.issuedAt, contextDigest: p.contextDigest, grantId: p.grantId, subjectId: p.subjectId, subjectKeyId: p.subjectKeyId, organization: p.organization });
      return { result: 'issued', token: env };
    },
    async consume(req, { signal }) {
      log.consume.push(req);
      log.signals.push(signal);
      if (behaviors.throwConsume) throw new Error('SECRET-TRANSPORT-DETAIL');
      if (behaviors.hangConsume) return new Promise(() => {});
      if (behaviors.consumeResponse) return behaviors.consumeResponse(req, () => doConsume(req));
      const answer = doConsume(req);
      if (behaviors.dropNextConsumeResponse) {
        behaviors.dropNextConsumeResponse = false;
        return new Promise(() => {}); // consumed on the store side, but the answer never arrives
      }
      return answer;
    },
  };
  return { transport, log, consumed, issued, behaviors };
}

// ---------------------------------------------------------------- helpers

const issueParams = (transport: ChallengeStoreTransport, over: Partial<RequestChallengeParams> = {}): RequestChallengeParams => {
  const merged = { trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), requester: alice, context: CTX, now: NOW, transport, timeoutMs: 200, ...over };
  return { grantEnvelope: envelopeOf.get(merged.requester as object) ?? { not: 'the grant' }, ...merged };
};

const issue = (transport: ChallengeStoreTransport, over: Partial<RequestChallengeParams> = {}): Promise<IssueResult> => requestChallengeToken(issueParams(transport, over));
const codeOf = (r: { ok: boolean; code?: string }): string | undefined => (r.ok ? undefined : r.code);
const detailOf = (r: { ok: boolean; detail?: string }): string | undefined => (r.ok ? undefined : r.detail);

/** issue a real token from the simulated store and build a real proof with its challenge */
async function issued(store = createSimulatedStore(), requester: VerifiedGrant = alice, key: Keys = aliceKey, context: ActionContext = CTX) {
  const r = await issue(store.transport, { requester, context });
  if (!r.ok) throw new Error(`setup issue: ${r.code}`);
  const proof = createProof({ privateKey: key.privateKey, grant: requester, context, challenge: r.token.token.challenge, issuedAt: at(30) });
  return { store, token: r.token, proof, requester, context };
}

const attemptFor = (ctx: Awaited<ReturnType<typeof issued>>, over: Record<string, unknown> = {}): ConsumptionAttempt => {
  const r = prepareConsumptionAttempt({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), token: ctx.token, requester: ctx.requester, context: ctx.context, proof: ctx.proof, ...over });
  if (!r.ok) throw new Error(`setup attempt: ${r.code} ${r.detail ?? ''}`);
  return r.attempt;
};

const submit = (attempt: ConsumptionAttempt, transport: ChallengeStoreTransport, over: Record<string, unknown> = {}): Promise<ConsumeResult> =>
  submitConsumption(attempt, transport, { now: NOW, timeoutMs: 200, ...over });

// ================================================================ issuance

describe('requesting a challenge token', () => {
  it('returns a VERIFIED token for the right store, key, requester and action', async () => {
    const store = createSimulatedStore();
    const r = await issue(store.transport);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isVerifiedChallengeToken(r.token)).toBe(true);
    expect(r.token.token).toMatchObject({ organization: 'acme', storeId: 'store-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), contextDigest: computeActionContextDigest(CTX) });
    expect(r.token.signingKeyId).toBe(id(storeKey));
    expect(r.timeSource).toBe('caller_supplied');
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('sends only what the store needs, taken from the verified grant and the trust root', async () => {
    const store = createSimulatedStore();
    await issue(store.transport);
    expect(store.log.issue).toHaveLength(1);
    expect(store.log.issue[0]).toEqual({ organization: 'acme', storeId: 'store-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, contextDigest: computeActionContextDigest(CTX), grant: envelopeOf.get(alice) });
    expect(JSON.stringify(store.log.issue[0])).not.toContain(String(aliceKey.privateKey.export({ format: 'jwk' }).d));
  });

  it('rejects a token for the wrong store, whichever side is wrong', async () => {
    const r = await issue(createSimulatedStore({ tokenParams: { storeId: 'store-2' } }).transport);
    expect(r).toMatchObject({ ok: false, code: 'wrong_store', source: 'local_verification', detail: 'store_mismatch' });
    const pinnedElsewhere = await issue(createSimulatedStore({ tokenParams: { storeId: 'store-1' } }).transport, { storeId: 'store-9' });
    expect(codeOf(pinnedElsewhere)).toBe('wrong_store');
  });

  it('rejects a token for the wrong store generation when one is expected', async () => {
    const store = createSimulatedStore({ tokenParams: { storeGeneration: 'gen-2' } });
    expect(await issue(store.transport)).toMatchObject({ ok: true }); // no expectation: the generation is whatever the signed token says
    expect(await issue(createSimulatedStore({ tokenParams: { storeGeneration: 'gen-2' } }).transport, { storeGeneration: 'gen-1' })).toMatchObject({ ok: false, code: 'wrong_store', detail: 'store_generation_mismatch' });
  });

  it('rejects a token signed by a key that is not the PINNED key, however trusted that other key is', async () => {
    expect(await issue(createSimulatedStore({ tokenSigner: otherStoreKey }).transport)).toMatchObject({ ok: false, code: 'wrong_issuer', detail: 'signing_key_mismatch' });
    expect(await issue(createSimulatedStore({ tokenSigner: outsider }).transport)).toMatchObject({ ok: false, code: 'wrong_issuer', detail: 'unknown_signing_key' });
    expect(await issue(createSimulatedStore({ tokenSigner: policyKey }).transport)).toMatchObject({ ok: false, code: 'wrong_issuer', detail: 'key_purpose_not_allowed' });
    expect(await issue(createSimulatedStore({ tokenSigner: aliceKey }).transport)).toMatchObject({ ok: false, code: 'wrong_issuer' });
  });

  it('does not let the response choose its own key: a response that offers one is malformed', async () => {
    const inject = (extra: Record<string, unknown>) => createSimulatedStore({ issueResponse: () => ({ result: 'issued', token: createChallengeToken({ privateKey: outsider.privateKey, organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, issuedAt: T0 }), ...extra }) });
    expect(codeOf(await issue(inject({ signingKey: raw(outsider) }).transport))).toBe('malformed_response');
    expect(codeOf(await issue(inject({ publicKey: raw(outsider) }).transport))).toBe('malformed_response');
    expect(codeOf(await issue(inject({}).transport))).toBe('wrong_issuer');
  });

  it('rejects a token for the wrong organization', async () => {
    expect(await issue(createSimulatedStore({ tokenParams: { organization: 'globex' } }).transport)).toMatchObject({ ok: false, code: 'binding_mismatch', detail: 'organization_mismatch' });
  });

  it('rejects a token for the wrong grant, subject or subject key', async () => {
    expect(await issue(createSimulatedStore({ tokenParams: { grantId: 'grant-bob-001' } }).transport)).toMatchObject({ code: 'binding_mismatch', detail: 'grant_mismatch' });
    expect(await issue(createSimulatedStore({ tokenParams: { subjectId: 'bob' } }).transport)).toMatchObject({ code: 'binding_mismatch', detail: 'subject_mismatch' });
    expect(await issue(createSimulatedStore({ tokenParams: { subjectKeyId: id(bobKey) } }).transport)).toMatchObject({ code: 'binding_mismatch', detail: 'subject_mismatch' });
  });

  it('rejects a token for a different action context', async () => {
    expect(await issue(createSimulatedStore({ tokenParams: { context: OTHER_CTX } }).transport)).toMatchObject({ ok: false, code: 'binding_mismatch', detail: 'context_mismatch' });
  });

  it('rejects an expired token and a not-yet-valid token, using the caller-supplied time', async () => {
    expect(await issue(createSimulatedStore({ tokenParams: { issuedAt: at(-1200) } }).transport)).toMatchObject({ ok: false, code: 'expired', detail: 'token_expired' });
    expect(await issue(createSimulatedStore({ tokenParams: { issuedAt: at(600) } }).transport)).toMatchObject({ ok: false, code: 'not_yet_valid' });
    expect((await issue(createSimulatedStore().transport, { now: at(599) })).ok).toBe(true);
    expect(codeOf(await issue(createSimulatedStore().transport, { now: at(600) }))).toBe('expired');
  });

  it('rejects unsigned, forged and tampered tokens', async () => {
    const real = createChallengeToken({ privateKey: storeKey.privateKey, organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, issuedAt: T0 });
    const payload = JSON.parse(Buffer.from(real.payload, 'base64url').toString('utf-8'));
    const respond = (token: unknown) => createSimulatedStore({ issueResponse: () => ({ result: 'issued', token }) }).transport;
    expect(codeOf(await issue(respond(payload)))).toBe('malformed_response'); // a bare payload is not an envelope
    expect(codeOf(await issue(respond('a token')))).toBe('malformed_response');
    expect(codeOf(await issue(respond({ ...real, signature: '' })))).toMatch(/malformed_response|invalid_signature/);
    const sig = Buffer.from(real.signature, 'base64url');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(codeOf(await issue(respond({ ...real, signature: sig.toString('base64url') })))).toBe('invalid_signature');
    payload.grantId = 'grant-bob-001';
    expect(codeOf(await issue(respond({ ...real, payload: Buffer.from(JSON.stringify(payload)).toString('base64url') })))).toBe('invalid_signature');
    expect(codeOf(await issue(respond({ ...real, domain: 'receipt' })))).toBe('malformed_response');
  });

  it('rejects malformed transport responses', async () => {
    const real = createChallengeToken({ privateKey: storeKey.privateKey, organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, issuedAt: T0 });
    const hostile = new Proxy({}, { get: (_t, p) => { if (p === 'then') return undefined; throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    const bad: unknown[] = [undefined, null, 5, 'issued', 'consumed', true, [], {}, { result: 'issued' }, { result: 'issued', token: real, extra: 1 }, { token: real }, { result: 'rejected' }, { result: 'rejected', reason: 'because' }, { result: 'rejected', reason: 'unknown_grant', extra: 1 }, { result: 'ok', token: real }, hostile];
    for (const [i, response] of bad.entries()) {
      const r = await issue(createSimulatedStore({ issueResponse: () => response }).transport);
      expect(r.ok, `response ${i}`).toBe(false);
      expect(codeOf(r), `response ${i}`).toBe('malformed_response');
    }
  });

  it('reports a store rejection as such, and marks it as an unsigned statement', async () => {
    for (const reason of ['invalid_request', 'unknown_grant', 'grant_revoked', 'rate_limited', 'unavailable']) {
      const r = await issue(createSimulatedStore({ issueResponse: () => ({ result: 'rejected', reason }) }).transport);
      expect(r).toMatchObject({ ok: false, code: 'store_rejected', source: 'store_reported', detail: reason });
    }
  });

  it('sends nothing when the pinned key is not a trusted store key, or an input is invalid', async () => {
    const calls = (store: ReturnType<typeof createSimulatedStore>) => store.log.issue.length;
    const s1 = createSimulatedStore();
    expect(await issue(s1.transport, { signingKeyId: id(outsider) })).toMatchObject({ code: 'wrong_issuer', detail: 'pinned_key_unknown_key' });
    expect(await issue(s1.transport, { signingKeyId: id(policyKey) })).toMatchObject({ code: 'wrong_issuer', detail: 'pinned_key_purpose_not_allowed' });
    const invalid: Array<Partial<RequestChallengeParams>> = [
      { trustRoot: { ...root } },
      { storeId: 'Store 1' },
      { signingKeyId: 'xyz' },
      { storeGeneration: 'bad generation' },
      { requester: { ...alice } },
      { requester: null as unknown as VerifiedGrant },
      { context: { ...CTX, target: 'bad target' } },
      { now: new Date('x') },
      { timeoutMs: 0 },
      { timeoutMs: -1 },
      { timeoutMs: 1.5 },
      { timeoutMs: MAX_STORE_TIMEOUT_MS + 1 },
      { timeoutMs: '5' as unknown as number },
      { timeoutMs: Number.NaN },
      { grantEnvelope: 'a grant' },
      { grantEnvelope: null },
      { transport: {} as ChallengeStoreTransport },
      { transport: null as unknown as ChallengeStoreTransport },
    ];
    for (const over of invalid) {
      const r = await issue(s1.transport, over);
      expect(codeOf(r), JSON.stringify(Object.keys(over))).toMatch(/invalid_request/);
    }
    expect(calls(s1)).toBe(0);
  });

  it('refuses a grant from another organization than the trust root before sending anything', async () => {
    const globexRoot = makeRoot('globex', [entry(storeKey, ['challenge_store'])]);
    const store = createSimulatedStore();
    expect(codeOf(await issue(store.transport, { trustRoot: globexRoot }))).toBe('invalid_request');
    expect(store.log.issue).toHaveLength(0);
  });
});

// ================================================================ consumption

describe('consuming a challenge', () => {
  it('returns a VERIFIED receipt for the exact token, context, proof, request id and pinned key', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    const r = await submit(attempt, ctx.store.transport);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toBe('consumed');
    expect(isVerifiedConsumptionReceipt(r.receipt)).toBe(true);
    expect(r.receipt.receipt).toMatchObject({ challengeId: ctx.token.token.challengeId, requestId: attempt.requestId, proofDigest: computeProofDigest(ctx.proof), contextDigest: computeActionContextDigest(CTX) });
    expect(r.requestId).toBe(attempt.requestId);
    expect(r.timeSource).toBe('caller_supplied');
    expect(isConsumptionAttempt(attempt)).toBe(true);
    expect(Object.isFrozen(attempt)).toBe(true);
  });

  it('binds the request to the token, the requester, the action, the proof digest and the request id', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    expect(attempt.request).toEqual({
      requestId: attempt.requestId,
      organization: 'acme',
      storeId: 'store-1',
      challengeId: ctx.token.token.challengeId,
      challenge: ctx.token.token.challenge,
      grantId: 'grant-alice-001',
      subjectId: 'alice',
      subjectKeyId: id(aliceKey),
      contextDigest: computeActionContextDigest(CTX),
      proofDigest: computeProofDigest(ctx.proof),
      proof: ctx.proof,
    });
    expect(attempt.request.proof).not.toBe(ctx.proof); // a copy: later changes by the caller cannot alter the request
  });

  it('uses a request id of 16 random bytes, Base64url, that the receipt verifier accepts', async () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateRequestId()));
    expect(ids.size).toBe(200);
    for (const v of ids) {
      expect(isRequestId(v)).toBe(true);
      expect(v).toHaveLength(22);
    }
    const ctx = await issued();
    expect(isRequestId(attemptFor(ctx).requestId)).toBe(true);
  });

  it('refuses to prepare an attempt that does not match the verified token', async () => {
    const ctx = await issued();
    const base = { trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), token: ctx.token, requester: alice, context: CTX, proof: ctx.proof };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ token: { ...ctx.token } }, 'token'],
      [{ token: JSON.parse(JSON.stringify(ctx.token)) }, 'token'],
      [{ token: null }, 'token'],
      [{ trustRoot: { ...root } }, 'trust_root'],
      [{ storeId: 'store-2' }, 'token_store_mismatch'],
      [{ signingKeyId: id(otherStoreKey) }, 'token_store_mismatch'],
      [{ requester: bob }, 'requester'],
      [{ requester: { ...alice } }, 'requester'],
      [{ context: OTHER_CTX }, 'context'],
      [{ context: { ...CTX, target: 'bad target' } }, 'context'],
      [{ proof: { not: 'a proof' } }, 'proof'],
      [{ proof: undefined }, 'proof'],
    ];
    for (const [over, detail] of cases) {
      const r = prepareConsumptionAttempt({ ...base, ...over } as never);
      expect(r.ok, detail).toBe(false);
      expect(detailOf(r as never), detail).toBe(detail);
    }
  });

  it('accepts the issuance result itself as well as the bare verified token', async () => {
    const store = createSimulatedStore();
    const r = await issue(store.transport);
    if (!r.ok) throw new Error('setup');
    const proof = createProof({ privateKey: aliceKey.privateKey, grant: alice, context: CTX, challenge: r.token.token.challenge, issuedAt: at(30) });
    expect(prepareConsumptionAttempt({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), token: r, requester: alice, context: CTX, proof }).ok).toBe(true);
  });
});

describe('what counts as consumption: only a genuine, matching, signed receipt', () => {
  const run = async (behaviors: Behaviors) => {
    const ctx = await issued(createSimulatedStore(behaviors));
    return { ctx, result: await submit(attemptFor(ctx), ctx.store.transport) };
  };

  it('never accepts a bare "consumed", or "consumed" without a receipt', async () => {
    for (const response of ['consumed', { result: 'consumed' }, { result: 'consumed', receipt: null }, { result: 'consumed', receipt: 'consumed' }, { result: 'consumed', receipt: {} }, { result: 'consumed', receipt: true }, { result: 'consumed', receipt: { result: 'consumed' } }, { result: 'consumed', consumed: true }, { consumed: true }, { result: 'consumed', receipt: 'x', extra: 1 }]) {
      const { result } = await run({ consumeResponse: () => response });
      expect(result.ok, JSON.stringify(response)).toBe(false);
      expect((result as { state: string }).state).toBe('indeterminate');
      expect(codeOf(result)).toBe('malformed_response');
    }
  });

  it('never accepts an unsigned receipt, a forged receipt or a tampered receipt', async () => {
    const good = await run({});
    if (!good.result.ok) throw new Error('setup');
    const env = good.ctx.store.consumed.get(good.ctx.token.token.challengeId)?.envelope as SignedEnvelope;
    const payload = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    expect(codeOf((await run({ consumeResponse: () => ({ result: 'consumed', receipt: payload }) })).result)).toBe('malformed_response'); // unsigned payload
    expect(codeOf((await run({ receiptSigner: outsider })).result)).toBe('wrong_issuer'); // forged by an unknown key
    const sig = Buffer.from(env.signature, 'base64url');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(codeOf((await run({ consumeResponse: (_r, real) => ({ ...(real() as object), receipt: { ...env, signature: sig.toString('base64url') } }) })).result)).toBe('invalid_signature');
  });

  it('rejects a genuine receipt from the wrong key or the wrong store', async () => {
    expect(await run({ receiptSigner: otherStoreKey }).then((r) => r.result)).toMatchObject({ ok: false, code: 'wrong_issuer', detail: 'signing_key_mismatch', state: 'indeterminate' });
    expect(await run({ receiptOverrides: { storeId: 'store-2' } }).then((r) => r.result)).toMatchObject({ code: 'wrong_store', detail: 'store_mismatch' });
    expect(await run({ receiptOverrides: { storeGeneration: 'gen-2' } }).then((r) => r.result)).toMatchObject({ code: 'wrong_store', detail: 'store_generation_mismatch' });
    expect(await run({ receiptOverrides: { organization: 'globex' } }).then((r) => r.result)).toMatchObject({ code: 'binding_mismatch', detail: 'organization_mismatch' });
  });

  it('rejects a genuine receipt for another challenge, proof, requester, action or request id', async () => {
    const other = await issued(createSimulatedStore(), bob, bobKey);
    const wrongChallenge = await run({ receiptOverrides: { challengeHash: computeChallengeHash(other.token.token.challenge) } });
    expect(wrongChallenge.result).toMatchObject({ ok: false, code: 'binding_mismatch', detail: 'challenge_mismatch' });
    const wrongChallengeId = await run({ receiptOverrides: { challengeId: other.token.token.challengeId } });
    expect(wrongChallengeId.result).toMatchObject({ code: 'binding_mismatch', detail: 'challenge_mismatch' });
    expect(await run({ receiptOverrides: { proofDigest: computeProofDigest(other.proof) } }).then((r) => r.result)).toMatchObject({ code: 'binding_mismatch', detail: 'proof_mismatch' });
    expect(await run({ receiptOverrides: { requestId: generateRequestId() } }).then((r) => r.result)).toMatchObject({ code: 'binding_mismatch', detail: 'request_mismatch' });
    expect(await run({ receiptOverrides: { contextDigest: computeActionContextDigest(OTHER_CTX) } }).then((r) => r.result)).toMatchObject({ code: 'binding_mismatch', detail: 'context_mismatch' });
    expect(await run({ receiptOverrides: { grantId: 'grant-bob-001' } }).then((r) => r.result)).toMatchObject({ code: 'binding_mismatch', detail: 'grant_mismatch' });
    expect(await run({ receiptOverrides: { subjectId: 'bob' } }).then((r) => r.result)).toMatchObject({ code: 'binding_mismatch', detail: 'subject_mismatch' });
    expect(await run({ receiptOverrides: { issuedAt: '2026-06-01T12:00:01Z' } }).then((r) => r.result)).toMatchObject({ code: 'binding_mismatch', detail: 'time_mismatch' });
  });

  it('reports a storeâ€™s own refusals as rejections, without success', async () => {
    for (const [result, code] of [['already_used', 'already_used'], ['expired', 'expired'], ['unknown_challenge', 'unknown_challenge'], ['binding_mismatch', 'binding_mismatch'], ['invalid_request', 'store_rejected']] as const) {
      const { result: r } = await run({ consumeResponse: () => ({ result }) });
      expect(r).toMatchObject({ ok: false, state: 'unverified_refusal', code, source: 'store_reported', detail: result, authenticated: false });
      expect(r).not.toHaveProperty('receipt');
      expect((r as { retryWith?: unknown }).retryWith).toBeUndefined();
    }
  });

  it('an unsigned refusal is never an authenticated decision, and never proves what the store holds', async () => {
    // the store really consumed, the answer is lost, and a hostile transport then fakes "already_used"
    const ctx = await issued(createSimulatedStore({ dropNextConsumeResponse: true }));
    const attempt = attemptFor(ctx);
    const lost = await submit(attempt, ctx.store.transport, { timeoutMs: 30 });
    expect(lost).toMatchObject({ ok: false, state: 'indeterminate', authenticated: false });
    const fake: ChallengeStoreTransport = { issue: ctx.store.transport.issue, consume: async () => ({ result: 'already_used' }) };
    const refused = await submit(attempt, fake);
    expect(refused).toMatchObject({ ok: false, state: 'unverified_refusal', source: 'store_reported', authenticated: false });
    expect(refused).not.toHaveProperty('receipt');
    expect(refused).not.toHaveProperty('retryWith');
    // the real store still answers the same attempt with the ORIGINAL receipt
    expect((await submit(attempt, ctx.store.transport)).ok).toBe(true);
    // a fake refusal also cannot erase a verified success
    expect((await submit(attempt, fake)).ok).toBe(true);
  });

  it('no failure of any kind claims to be authenticated, and only a verified receipt is ok', async () => {
    const results: unknown[] = [];
    results.push(await issue(createSimulatedStore({ throwIssue: true }).transport));
    results.push(await issue(createSimulatedStore({ issueResponse: () => ({ result: 'rejected', reason: 'unknown_grant' }) }).transport));
    results.push(await issue(createSimulatedStore({ tokenSigner: outsider }).transport));
    for (const response of [{ result: 'already_used' }, { result: 'expired' }, { result: 'binding_mismatch' }, 'consumed', { result: 'consumed' }]) {
      const c = await issued(createSimulatedStore({ consumeResponse: () => response }));
      results.push(await submit(attemptFor(c), c.store.transport));
    }
    for (const r of results as Array<{ ok: boolean; authenticated?: boolean }>) {
      expect(r.ok).toBe(false);
      expect(r.authenticated).toBe(false);
    }
  });

  it('an unexpected error after a send is indeterminate, never a definitive refusal', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    const poisoned = { ...ctx.store.transport } as ChallengeStoreTransport;
    const hostileValue = new Proxy({}, { get: (_t, p) => { if (p === 'then') return undefined; throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    poisoned.consume = async () => hostileValue;
    const r = await submit(attempt, poisoned);
    expect(r).toMatchObject({ ok: false, state: 'indeterminate', authenticated: false });
  });

  it('treats a store that says "unavailable" as ambiguous and retryable, and the new refusal reasons as unverified refusals', async () => {
    const ctx = await issued(createSimulatedStore({ consumeResponse: () => ({ result: 'unavailable' }) }));
    const attempt = attemptFor(ctx);
    const r = await submit(attempt, ctx.store.transport, { maxAttempts: 2 });
    expect(r).toMatchObject({ ok: false, state: 'indeterminate', code: 'transport_unavailable', source: 'store_reported', authenticated: false });
    expect((r as { retryWith?: unknown }).retryWith).toBe(attempt);
    expect(ctx.store.log.consume).toHaveLength(2);
    for (const result of ['invalid_proof', 'not_authorized']) {
      const c = await issued(createSimulatedStore({ consumeResponse: () => ({ result }) }));
      expect(await submit(attemptFor(c), c.store.transport)).toMatchObject({ ok: false, state: 'unverified_refusal', code: 'store_rejected', detail: result, authenticated: false });
    }
    expect(await issue(createSimulatedStore({ issueResponse: () => ({ result: 'rejected', reason: 'not_authorized' }) }).transport)).toMatchObject({ code: 'store_rejected', detail: 'not_authorized' });
  });

  it('rejects malformed statuses', async () => {
    for (const response of [{ result: 'maybe' }, { result: 'CONSUMED' }, { result: 'already_used', receipt: 'x' }, { result: 5 }, { result: undefined }, [], null, undefined, 5, new Proxy({}, { get: (_t, p) => { if (p === 'then') return undefined; throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } })]) {
      const { result } = await run({ consumeResponse: () => response });
      expect(result.ok).toBe(false);
      expect(codeOf(result)).toBe('malformed_response');
    }
  });

  it('a duplicate consumption of the same challenge under another request id is refused by the store', async () => {
    const ctx = await issued();
    const first = await submit(attemptFor(ctx), ctx.store.transport);
    expect(first.ok).toBe(true);
    const answer = await ctx.store.transport.consume({ ...ctx.store.log.consume[0]!, requestId: generateRequestId() }, { signal: new AbortController().signal });
    expect(answer).toEqual({ result: 'already_used' });
  });
});

// ================================================================ retries

describe('retries and indeterminate outcomes', () => {
  it('keeps one request id for one logical attempt: preparing again returns the same attempt', async () => {
    const ctx = await issued();
    const a = attemptFor(ctx);
    const b = attemptFor(ctx);
    expect(b).toBe(a);
    expect(b.requestId).toBe(a.requestId);
    const concurrent = await Promise.all(Array.from({ length: 5 }, async () => attemptFor(ctx)));
    expect(new Set(concurrent.map((x) => x.requestId)).size).toBe(1);
  });

  it('refuses a second, different attempt for the same single-use challenge (no silent new request id)', async () => {
    const ctx = await issued();
    attemptFor(ctx);
    const otherProof = createProof({ privateKey: aliceKey.privateKey, grant: alice, context: CTX, challenge: ctx.token.token.challenge, issuedAt: at(31) });
    const r = prepareConsumptionAttempt({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), token: ctx.token, requester: alice, context: CTX, proof: otherProof });
    expect(r).toMatchObject({ ok: false, code: 'invalid_request', detail: 'attempt_conflict' });
  });

  it('sends the same request id on every send of the attempt', async () => {
    const ctx = await issued(createSimulatedStore({ throwConsume: true }));
    const attempt = attemptFor(ctx);
    await submit(attempt, ctx.store.transport);
    await submit(attempt, ctx.store.transport);
    await submit(attempt, ctx.store.transport, { maxAttempts: 2 });
    const ids = ctx.store.log.consume.map((r) => r.requestId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(attempt.requestId);
  });

  it('once a receipt is verified the attempt has that one outcome: later calls return it without asking again', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    const a = await submit(attempt, ctx.store.transport);
    const b = await submit(attempt, ctx.store.transport);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.receipt).toBe(a.receipt);
    expect(ctx.store.log.consume).toHaveLength(1);
  });

  it('concurrent sends of one attempt cannot produce two different success claims', async () => {
    let n = 0;
    const ctx = await issued(createSimulatedStore({ consumeResponse: (req, real) => {
      real(); // the genuine consumption happens once
      const first = ctx.store.consumed.get(req.challengeId)!.envelope;
      if (n++ === 0) return { result: 'consumed', receipt: first };
      // a buggy or hostile store: a second, different but validly signed receipt for the same request
      const payload = JSON.parse(Buffer.from(first.payload, 'base64url').toString('utf-8'));
      payload.receiptId = generateRequestId();
      return { result: 'consumed', receipt: signEnvelope({ domain: 'receipt', payload: Buffer.from(JSON.stringify(payload)), privateKey: storeKey.privateKey }) };
    } }));
    const attempt = attemptFor(ctx);
    const results = await Promise.all([submit(attempt, ctx.store.transport), submit(attempt, ctx.store.transport)]);
    const wins = results.filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toMatchObject({ state: 'indeterminate', code: 'binding_mismatch', detail: 'receipt_conflict' });
    const later = await submit(attempt, ctx.store.transport);
    expect(later.ok && wins[0]?.ok && later.receipt === wins[0].receipt).toBe(true);
  });

  it('a different proof or action cannot reuse an existing attempt', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    const otherProof = createProof({ privateKey: aliceKey.privateKey, grant: alice, context: CTX, challenge: ctx.token.token.challenge, issuedAt: at(35) });
    expect(detailOf(prepareConsumptionAttempt({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), token: ctx.token, requester: alice, context: CTX, proof: otherProof }) as never)).toBe('attempt_conflict');
    expect(detailOf(prepareConsumptionAttempt({ trustRoot: root, storeId: 'store-1', signingKeyId: id(storeKey), token: ctx.token, requester: alice, context: OTHER_CTX, proof: ctx.proof }) as never)).toBe('context');
    expect(attemptFor(ctx)).toBe(attempt);
  });

  it('refuses a retry that names a different request id, and sends nothing', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    const r = await submit(attempt, ctx.store.transport, { requestId: generateRequestId() });
    expect(r).toMatchObject({ ok: false, state: 'not_attempted', code: 'invalid_request', detail: 'request_id_changed' });
    expect(ctx.store.log.consume).toHaveLength(0);
    expect((await submit(attempt, ctx.store.transport, { requestId: attempt.requestId })).ok).toBe(true);
  });

  it('a timeout after the store consumed is INDETERMINATE: no success, no new challenge, and the same attempt comes back', async () => {
    const ctx = await issued(createSimulatedStore({ dropNextConsumeResponse: true }));
    const attempt = attemptFor(ctx);
    const first = await submit(attempt, ctx.store.transport, { timeoutMs: 40 });
    expect(first.ok).toBe(false);
    expect(first).toMatchObject({ state: 'indeterminate', code: 'timeout', source: 'transport' });
    expect((first as { retryWith?: ConsumptionAttempt }).retryWith).toBe(attempt);
    expect(ctx.store.consumed.has(ctx.token.token.challengeId)).toBe(true); // the store DID consume
    expect(ctx.store.log.issue).toHaveLength(1); // and nothing issued a new challenge
  });

  it('the retry with the same attempt returns the ORIGINAL receipt', async () => {
    const ctx = await issued(createSimulatedStore({ dropNextConsumeResponse: true }));
    const attempt = attemptFor(ctx);
    const first = await submit(attempt, ctx.store.transport, { timeoutMs: 40 });
    const retry = await submit((first as { retryWith: ConsumptionAttempt }).retryWith, ctx.store.transport);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const original = ctx.store.consumed.get(ctx.token.token.challengeId)?.envelope as SignedEnvelope;
    expect(JSON.parse(Buffer.from(original.payload, 'base64url').toString('utf-8')).receiptId).toBe(retry.receipt.receipt.receiptId);
    expect(ctx.store.log.consume.map((r) => r.requestId)).toEqual([attempt.requestId, attempt.requestId]);
  });

  it('can retry inside one call, bounded, always with the same request id', async () => {
    const ctx = await issued(createSimulatedStore({ dropNextConsumeResponse: true }));
    const attempt = attemptFor(ctx);
    const r = await submit(attempt, ctx.store.transport, { timeoutMs: 40, maxAttempts: 2 });
    expect(r.ok).toBe(true);
    expect(ctx.store.log.consume).toHaveLength(2);
    expect(new Set(ctx.store.log.consume.map((x) => x.requestId))).toEqual(new Set([attempt.requestId]));
  });

  it('gives up after the bounded number of sends, still indeterminate and still retryable', async () => {
    const ctx = await issued(createSimulatedStore({ hangConsume: true }));
    const attempt = attemptFor(ctx);
    const r = await submit(attempt, ctx.store.transport, { timeoutMs: 20, maxAttempts: 3 });
    expect(r).toMatchObject({ ok: false, state: 'indeterminate', code: 'timeout' });
    expect(ctx.store.log.consume).toHaveLength(3);
    expect((r as { retryWith?: ConsumptionAttempt }).retryWith).toBe(attempt);
    for (const bad of [0, 6, 1.5, '2', -1, Number.NaN]) expect(codeOf(await submit(attempt, ctx.store.transport, { maxAttempts: bad as number })), String(bad)).toBe('invalid_request');
    expect(ctx.store.log.consume).toHaveLength(3);
  });

  it('a verification failure is not retried automatically and offers no retry: a bad answer says nothing about the store', async () => {
    const ctx = await issued(createSimulatedStore({ receiptSigner: outsider }));
    const r = await submit(attemptFor(ctx), ctx.store.transport, { maxAttempts: 3 });
    expect(r).toMatchObject({ ok: false, state: 'indeterminate', code: 'wrong_issuer' });
    expect((r as { retryWith?: unknown }).retryWith).toBeUndefined();
    expect(ctx.store.log.consume).toHaveLength(1);
  });

  it('an unreachable store is indeterminate and retryable', async () => {
    const ctx = await issued(createSimulatedStore({ throwConsume: true }));
    const r = await submit(attemptFor(ctx), ctx.store.transport);
    expect(r).toMatchObject({ ok: false, state: 'indeterminate', code: 'transport_unavailable' });
    expect((r as { retryWith?: unknown }).retryWith).toBeDefined();
  });
});

// ================================================================ reliability

describe('reliability, hostile input and leakage', () => {
  it('a transport that never answers cannot hang the client: issuance and consumption both time out', async () => {
    const t0 = Date.now();
    const issue1 = await issue(createSimulatedStore({ hangIssue: true }).transport, { timeoutMs: 30 });
    expect(issue1).toMatchObject({ ok: false, code: 'timeout', source: 'transport' });
    const ctx = await issued(createSimulatedStore({ hangConsume: true }));
    const consume1 = await submit(attemptFor(ctx), ctx.store.transport, { timeoutMs: 30 });
    expect(consume1).toMatchObject({ ok: false, state: 'indeterminate', code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('aborts the signal handed to the transport when it stops waiting, and says that this cannot undo a committed operation', async () => {
    const store = createSimulatedStore({ hangIssue: true });
    await issue(store.transport, { timeoutMs: 20 });
    expect(store.log.signals[0]?.aborted).toBe(true);
    const source = readFileSync(new URL('../../../../src/features/action-safety/authorization/trustedChallengeStoreClient.ts', import.meta.url), 'utf-8');
    expect(source).toContain('cannot cancel an operation the store');
    expect(source).toContain('caller-supplied');
  });

  it('a transport that throws or rejects is "unavailable", and its message is never repeated', async () => {
    const throwing = await issue(createSimulatedStore({ throwIssue: true }).transport);
    expect(throwing).toMatchObject({ ok: false, code: 'transport_unavailable' });
    expect(JSON.stringify(throwing)).not.toContain('SECRET');
    const syncThrow: ChallengeStoreTransport = { issue: () => { throw new Error('SECRET-SYNC'); }, consume: () => { throw new Error('SECRET-SYNC'); } };
    const r = await issue(syncThrow);
    expect(r).toMatchObject({ ok: false, code: 'transport_unavailable' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    const rejecting: ChallengeStoreTransport = { issue: () => Promise.reject(new Error('SECRET-REJECT')), consume: () => Promise.reject(new Error('SECRET-REJECT')) };
    expect(JSON.stringify(await issue(rejecting))).not.toContain('SECRET');
  });

  it('a late answer after a timeout is ignored and causes no unhandled rejection', async () => {
    const late: ChallengeStoreTransport = { issue: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late failure')), 60)), consume: () => Promise.reject(new Error('x')) };
    const r = await issue(late, { timeoutMs: 15 });
    expect(codeOf(r)).toBe('timeout');
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the late rejection happen; the test fails on an unhandled rejection
  });

  it('refuses invalid timeouts and bad options for consumption, without sending', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    for (const timeoutMs of [0, -1, 1.5, MAX_STORE_TIMEOUT_MS + 1, '5', Number.NaN, null]) {
      expect(codeOf(await submit(attempt, ctx.store.transport, { timeoutMs: timeoutMs as number })), String(timeoutMs)).toBe('invalid_request');
    }
    for (const now of [new Date('x'), '2026-06-01', null, undefined]) expect(codeOf(await submitConsumption(attempt, ctx.store.transport, { now: now as Date })), String(now)).toBe('invalid_request');
    expect(codeOf(await submitConsumption(attempt, ctx.store.transport, null as never))).toBe('invalid_request');
    expect(codeOf(await submitConsumption(attempt, {} as ChallengeStoreTransport, { now: NOW }))).toBe('invalid_request');
    expect(ctx.store.log.consume).toHaveLength(0);
    expect(DEFAULT_STORE_TIMEOUT_MS).toBe(10_000);
    expect(MAX_STORE_TIMEOUT_MS).toBe(120_000);
  });

  it('refuses forged attempts and hostile arguments without throwing', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    const hostile = new Proxy({}, { get: (_t, p) => { if (p === 'then') return undefined; throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); }, has: () => { throw new Error('boom'); } });
    for (const forged of [{ ...attempt }, JSON.parse(JSON.stringify(attempt)), Object.create(attempt), { kind: 'consumption_attempt', requestId: attempt.requestId, request: attempt.request }, null, undefined, 5, 'attempt', hostile]) {
      const r = await submitConsumption(forged as ConsumptionAttempt, ctx.store.transport, { now: NOW });
      expect(r.ok).toBe(false);
      expect(isConsumptionAttempt(forged)).toBe(false);
    }
    expect(ctx.store.log.consume).toHaveLength(0);
    for (const p of [undefined, null, 5, 'x', [], {}, hostile]) {
      expect((await requestChallengeToken(p as RequestChallengeParams)).ok).toBe(false);
      expect(prepareConsumptionAttempt(p as never).ok).toBe(false);
    }
    const hostileTransport = new Proxy({}, { get: () => { throw new Error('boom'); } });
    expect(codeOf(await issue(hostileTransport as ChallengeStoreTransport))).toBe('invalid_request');
    expect((await submit(attempt, hostileTransport as ChallengeStoreTransport)).ok).toBe(false);
  });

  it('handles concurrent issuance and concurrent consumption of one attempt', async () => {
    const store = createSimulatedStore();
    const tokens = await Promise.all(Array.from({ length: 5 }, () => issue(store.transport)));
    expect(tokens.every((t) => t.ok)).toBe(true);
    expect(new Set(tokens.map((t) => (t.ok ? t.token.token.challengeId : ''))).size).toBe(5);

    const ctx = await issued();
    const attempt = attemptFor(ctx);
    const results = await Promise.all(Array.from({ length: 4 }, () => submit(attempt, ctx.store.transport)));
    expect(results.every((r) => r.ok)).toBe(true);
    const receiptIds = new Set(results.map((r) => (r.ok ? r.receipt.receipt.receiptId : '')));
    expect(receiptIds.size).toBe(1); // one consumption, one original receipt, returned to every duplicate request
  });

  it('is deterministic: verifying the same response twice gives the same result', async () => {
    const ctx = await issued();
    const attempt = attemptFor(ctx);
    const a = await submit(attempt, ctx.store.transport);
    const b = await submit(attempt, ctx.store.transport);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.receipt).toEqual(b.receipt);
    const tokenA = await issue(createSimulatedStore({ tokenParams: { storeId: 'store-2' } }).transport);
    const tokenB = await issue(createSimulatedStore({ tokenParams: { storeId: 'store-2' } }).transport);
    expect(tokenA).toEqual(tokenB);
  });

  it('never puts a challenge, a proof, a signature or a key in a result', async () => {
    const outcomes: unknown[] = [];
    const base = await issued();
    const challenge = base.token.token.challenge;
    const proofPayload = base.proof.payload;
    const proofSignature = base.proof.signature;
    outcomes.push(base.token);
    outcomes.push(await submit(attemptFor(base), base.store.transport));
    for (const behaviors of [{ receiptSigner: outsider }, { receiptOverrides: { requestId: generateRequestId() } }, { consumeResponse: () => 'consumed' }, { hangConsume: true }, { throwConsume: true }, { consumeResponse: () => ({ result: 'already_used' }) }] as Behaviors[]) {
      const c = await issued(createSimulatedStore(behaviors));
      outcomes.push(await submit(attemptFor(c), c.store.transport, { timeoutMs: 20 }));
      outcomes.push((c.token.token.challenge, c.token.token.challengeId));
    }
    for (const o of outcomes.slice(1)) {
      const text = JSON.stringify(o);
      for (const secret of [challenge, proofPayload, proofSignature, raw(aliceKey), String(aliceKey.privateKey.export({ format: 'jwk' }).d), String(storeKey.privateKey.export({ format: 'jwk' }).d)]) expect(text).not.toContain(secret);
    }
    // the VERIFIED token naturally carries the challenge the requester must use; a RECEIPT result does not
    const ok = await submit(attemptFor(await issued()), createSimulatedStore().transport);
    void ok;
    const consumed = await issued();
    const result = await submit(attemptFor(consumed), consumed.store.transport);
    expect(JSON.stringify(result)).not.toContain(consumed.token.token.challenge);
  });
});

// ================================================================ compatibility and scope

describe('compatibility and scope', () => {
  const read = (name: string): string => {
    const full = readFileSync(new URL(`../../../../src/features/action-safety/authorization/${name}`, import.meta.url), 'utf-8');
    return full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  };

  it('does not touch the legacy contracts and does not import them', async () => {
    const text = read('trustedChallengeStoreClient.ts');
    const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const forbidden of ['./twoPhaseAuthorization.js', './evaluateAuthorization.js', './strictAuthorityAdapter.js', './actionContextCollector.js', './strictConfig.js']) expect(imports).not.toContain(forbidden);
    expect(text).not.toMatch(/ChallengeStore\b|consumeChallenge/);
    const proof = await import('../../../../src/features/action-safety/authorization/proof.js');
    const two = await import('../../../../src/features/action-safety/authorization/twoPhaseAuthorization.js');
    const evalMod = await import('../../../../src/features/action-safety/authorization/evaluateAuthorization.js');
    expect(proof.consumeChallenge.length).toBe(2);
    expect(two.prepareAuthorization.length).toBe(1);
    expect(two.finalizeAuthorization.length).toBe(1);
    expect(evalMod.evaluateAuthorization.length).toBe(1);
    expect(readFileSync(new URL('../../../../src/features/action-safety/authorization/proof.ts', import.meta.url), 'utf-8')).toContain("Promise<'consumed' | 'already_used'>");
  });

  it('offers no adapter to the legacy store contract', async () => {
    const mod = await import('../../../../src/features/action-safety/authorization/trustedChallengeStoreClient.js');
    for (const name of Object.keys(mod)) expect(name, name).not.toMatch(/adapter|legacy|compat|asStore|toChallengeStore/i);
  });

  it('performs no file, network, process, environment or clock-reading operations', () => {
    const text = read('trustedChallengeStoreClient.ts');
    for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:https', 'node:dgram', 'node:tls', 'child_process', 'fetch(', 'process.env', 'process.cwd', 'Date.now', 'new Date()', 'require(']) expect(text, forbidden).not.toContain(forbidden);
    const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => i?.startsWith('node:'))).toEqual(['node:crypto']);
  });

  it('is not wired into anything outside the authorization folder', () => {
    const root2 = new URL('../../../../src/features/action-safety/', import.meta.url);
    const offenders: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
        if (e.isDirectory()) {
          // `strict` (the signed-authorization tool) and its `testing` helper are the intended consumers; scoring, gates and the coordinator are not
          if (e.name !== 'authorization' && e.name !== 'strict' && e.name !== 'testing') walk(child);
        } else if (e.name.endsWith('.ts') && readFileSync(child, 'utf-8').includes('trustedChallengeStoreClient')) offenders.push(e.name);
      }
    };
    walk(root2);
    expect(offenders).toEqual([]);
  });
});

