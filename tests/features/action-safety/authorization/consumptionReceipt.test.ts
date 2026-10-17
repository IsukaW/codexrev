// Tests for signed consumption receipts. In-memory Ed25519 keys only; offline and deterministic.
//
// A receipt attests that a trusted store recorded consumption. These tests never build a store: they sign
// receipts directly with a test key, which is exactly what a future trusted service would do.

import { readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { URL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ChallengeArtifactError,
  computeActionContextDigest,
  computeChallengeHash,
  computeProofDigest,
} from '../../../../src/features/action-safety/authorization/challengeCommon.js';
import { createChallengeToken, verifyChallengeToken, type ExpectedChallenge, type VerifiedChallengeToken } from '../../../../src/features/action-safety/authorization/challengeToken.js';
import {
  CONSUMPTION_RECEIPT_VERSION,
  createConsumptionReceipt,
  isVerifiedConsumptionReceipt,
  verifyConsumptionReceipt,
  type ConsumptionReceiptResult,
  type CreateConsumptionReceiptParams,
  type ExpectedReceipt,
} from '../../../../src/features/action-safety/authorization/consumptionReceipt.js';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { verifyGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy } from '../../../../src/features/action-safety/authorization/policy.js';
import { computeContentDigest, createProof, generateChallenge, type ActionContext } from '../../../../src/features/action-safety/authorization/proof.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import { SIGNING_DOMAINS, type SignedEnvelope } from '../../../../src/features/action-safety/authorization/types.js';
import { CodexrevError } from '../../../../src/utils/errors.js';

const T0 = new Date('2026-06-01T12:00:00Z');
const NOW = new Date('2026-06-01T12:03:00Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');
const raw = (k: Keys): string => exportRawPublicKey(k.publicKey).toString('base64url');
const id = (k: Keys): string => deriveKeyId(k.publicKey);
const entry = (k: Keys, purposes: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  keyId: id(k),
  publicKey: raw(k),
  purposes,
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2027-01-01T00:00:00Z',
  ...over,
});

const CTX: ActionContext = { actionId: 'act-001', actionType: 'code_change', environment: 'development', target: 'payments-service', commit: 'a'.repeat(40), contentDigest: computeContentDigest(Buffer.from('diff')) };
const REQ = Buffer.alloc(16, 9).toString('base64url');
const REQ2 = Buffer.alloc(16, 8).toString('base64url');

let storeKey: Keys;
let otherStoreKey: Keys;
let policyKey: Keys;
let expiredKey: Keys;
let futureKey: Keys;
let outsider: Keys;
let aliceKey: Keys;
let root: TrustRoot;
let vt: VerifiedChallengeToken; // the verified challenge the receipts are about
let PROOF: SignedEnvelope;
let PROOF2: SignedEnvelope;

const makeRoot = (organization: string, keys: Record<string, unknown>[]): TrustRoot => {
  const r = parseTrustRoot({ version: 1, organization, createdAt: '2026-01-01T00:00:00Z', keys });
  if (!r.ok) throw new Error(`setup: ${r.code}`);
  return r.trustRoot;
};

beforeAll(() => {
  [storeKey, otherStoreKey, policyKey, expiredKey, futureKey, outsider, aliceKey] = Array.from({ length: 7 }, pair) as Keys[];
  root = makeRoot('acme', [
    entry(storeKey, ['challenge_store']),
    entry(otherStoreKey, ['challenge_store']),
    entry(policyKey, ['policy']),
    entry(expiredKey, ['challenge_store'], { notAfter: '2026-03-01T00:00:00Z' }),
    entry(futureKey, ['challenge_store'], { notBefore: '2026-09-01T00:00:00Z' }),
  ]);
  const env = createChallengeToken({ privateKey: storeKey.privateKey, organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, issuedAt: T0 });
  const expected: ExpectedChallenge = { storeId: 'store-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX };
  const v = verifyChallengeToken(env, root, expected, at(30));
  if (!v.ok) throw new Error(`setup token: ${v.code}`);
  vt = v;
  PROOF = signEnvelope({ domain: 'proof', payload: Buffer.from('{"proof":"one"}'), privateKey: aliceKey.privateKey });
  PROOF2 = signEnvelope({ domain: 'proof', payload: Buffer.from('{"proof":"two"}'), privateKey: aliceKey.privateKey });
});

const receipt = (over: Partial<CreateConsumptionReceiptParams> & Record<string, unknown> = {}, key: Keys = storeKey): SignedEnvelope =>
  createConsumptionReceipt({
    privateKey: key.privateKey,
    organization: 'acme',
    storeId: 'store-1',
    storeGeneration: 'gen-1',
    challengeId: vt.token.challengeId,
    challenge: vt.token.challenge,
    grantId: 'grant-alice-001',
    subjectId: 'alice',
    subjectKeyId: id(aliceKey),
    context: CTX,
    proof: PROOF,
    requestId: REQ,
    challengeIssuedAt: new Date(vt.token.issuedAt),
    challengeExpiresAt: new Date(vt.token.expiresAt),
    consumedAt: at(120),
    ...over,
  } as CreateConsumptionReceiptParams);

const expectedFor = (over: Partial<ExpectedReceipt> = {}): ExpectedReceipt => ({ token: vt, context: CTX, proof: PROOF, requestId: REQ, ...over });
const verify = (env: unknown, over: Partial<ExpectedReceipt> = {}, now: Date = NOW, tr: TrustRoot = root): ConsumptionReceiptResult => verifyConsumptionReceipt(env, tr, expectedFor(over), now);
const codeOf = (r: ConsumptionReceiptResult): string | undefined => (r.ok ? undefined : r.code);
const payloadOf = (env: SignedEnvelope): Record<string, any> => JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
const resign = (env: SignedEnvelope, change: (p: Record<string, any>) => void, key: Keys = storeKey, domain: (typeof SIGNING_DOMAINS)[number] = 'receipt'): SignedEnvelope => {
  const p = payloadOf(env);
  change(p);
  return signEnvelope({ domain, payload: Buffer.from(JSON.stringify(p)), privateKey: key.privateKey });
};

describe('a valid signed consumption receipt', () => {
  it('verifies and returns a branded, frozen result with every bound field', () => {
    const env = receipt({ sequence: 41 });
    const r = verify(env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt).toMatchObject({
      version: CONSUMPTION_RECEIPT_VERSION,
      organization: 'acme',
      storeId: 'store-1',
      storeGeneration: 'gen-1',
      challengeId: vt.token.challengeId,
      challengeHash: computeChallengeHash(vt.token.challenge),
      grantId: 'grant-alice-001',
      subjectId: 'alice',
      subjectKeyId: id(aliceKey),
      contextDigest: computeActionContextDigest(CTX),
      proofDigest: computeProofDigest(PROOF),
      requestId: REQ,
      issuedAt: '2026-06-01T12:00:00Z',
      consumedAt: '2026-06-01T12:02:00Z',
      expiresAt: '2026-06-01T12:10:00Z',
      sequence: 41,
    });
    expect(r.receipt.receiptId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.signingKeyId).toBe(id(storeKey));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.receipt)).toBe(true);
    expect(isVerifiedConsumptionReceipt(r)).toBe(true);
    expect(env.domain).toBe('receipt');
  });

  it('accepts JSON text, and a receipt without a sequence number', () => {
    expect(verify(JSON.stringify(receipt())).ok).toBe(true);
    const r = verify(receipt());
    expect(r.ok && 'sequence' in r.receipt).toBe(false);
  });

  it('generates a fresh receipt id every time', () => {
    const ids = new Set(Array.from({ length: 100 }, () => payloadOf(receipt()).receiptId));
    expect(ids.size).toBe(100);
  });

  it('is still valid long after the challenge expired: it records something that happened', () => {
    expect(verify(receipt(), {}, new Date('2026-12-01T00:00:00Z')).ok).toBe(true);
  });

  it('LIMITATION: it is verified against the signing key as of the verification time, so it stops verifying once that key’s window ends', () => {
    // the trust root's key windows are checked against `now`; audit-time verification as of consumedAt is a later phase
    expect(verify(receipt(), {}, new Date('2027-01-01T00:00:00Z')).ok).toBe(false);
    expect(codeOf(verify(receipt(), {}, new Date('2027-01-01T00:00:00Z')))).toBe('signing_key_expired');
  });

  it('the result makes no claim beyond the attestation: no authorization, execution or reuse fields', () => {
    const r = verify(receipt());
    if (!r.ok) throw new Error('setup');
    expect(Object.keys(r).sort()).toEqual(['ok', 'receipt', 'signingKeyId']);
    for (const word of ['authorized', 'executed', 'authorization', 'permitted']) expect(word in r).toBe(false);
  });

  it('works with a real, genuinely created proof', () => {
    const policyDoc = {
      version: 2, organization: 'acme', policyId: 'acme-policy', revision: 5,
      issuedAt: '2026-05-01T00:00:00Z', effectiveAt: '2026-05-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
      permissions: ['code.change'], roles: [{ name: 'developer', permissions: ['code.change'] }], rules: [],
    };
    const grantKey = pair();
    const fullRoot = makeRoot('acme', [entry(storeKey, ['challenge_store']), entry(policyKey, ['policy']), entry(grantKey, ['grant'])]);
    const p = verifyPolicy(signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(policyDoc)), privateKey: policyKey.privateKey }), fullRoot, T0);
    if (!p.ok) throw new Error(`setup policy: ${p.code}`);
    const g = verifyGrant(
      signEnvelope({
        domain: 'grant',
        payload: Buffer.from(JSON.stringify({ version: 1, grantId: 'grant-alice-001', organization: 'acme', subject: { id: 'alice', type: 'human', publicKey: raw(aliceKey), keyId: id(aliceKey) }, roles: ['developer'], permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1 })),
        privateKey: grantKey.privateKey,
      }),
      fullRoot,
      p.policy,
      T0,
    );
    if (!g.ok) throw new Error(`setup grant: ${g.code}`);
    // the proof's challenge is the one the store issued
    const proof = createProof({ privateKey: aliceKey.privateKey, grant: g, context: CTX, challenge: vt.token.challenge, issuedAt: at(30) });
    const env = receipt({ proof });
    const r = verifyConsumptionReceipt(env, fullRoot, { token: vt, context: CTX, proof, requestId: REQ }, NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && r.receipt.proofDigest).toBe(computeProofDigest(proof));
  });
});

describe('no challenge leakage', () => {
  it('the signed payload, the verified receipt and every error omit the challenge', () => {
    const challenge = vt.token.challenge;
    const env = receipt();
    expect(Buffer.from(env.payload, 'base64url').toString('utf-8')).not.toContain(challenge);
    expect(JSON.stringify(env)).not.toContain(challenge);
    const ok = verify(env);
    expect(JSON.stringify(ok)).not.toContain(challenge);
    expect(JSON.stringify(ok)).not.toContain(Buffer.from(challenge, 'base64url').toString('hex'));
    const failures = [
      verify(env, { requestId: REQ2 }),
      verify(resign(env, (p) => { p.challengeHash = computeChallengeHash(generateChallenge()); })),
      verify(resign(env, (p) => { p.extra = 1; })),
      verify(env, { proof: PROOF2 }),
      verify({ ...env, payload: '!!' }),
    ];
    for (const f of failures) {
      expect(f.ok).toBe(false);
      expect(JSON.stringify(f)).not.toContain(challenge);
    }
    expect('challenge' in payloadOf(env)).toBe(false);
    expect(payloadOf(env).challengeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('createConsumptionReceipt errors do not echo the challenge, the proof or the key', () => {
    try {
      receipt({ challenge: 'SECRET-NOT-A-CHALLENGE' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

describe('domain separation between tokens and receipts', () => {
  it('a challenge token cannot be presented as a receipt, and a receipt cannot be presented as a token', () => {
    const tokenEnv = createChallengeToken({ privateKey: storeKey.privateKey, organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, issuedAt: T0 });
    expect(codeOf(verify(tokenEnv))).toBe('wrong_domain');
    const env = receipt();
    const asToken = verifyChallengeToken(env, root, { storeId: 'store-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX }, NOW);
    expect(asToken.ok).toBe(false);
    expect(!asToken.ok && asToken.code).toBe('wrong_domain');
  });

  it('relabelling the domain breaks the signature: the same key and the same bytes sign differently per domain', () => {
    const env = receipt();
    expect(codeOf(verify({ ...env, domain: 'challenge' }))).toBe('wrong_domain');
    const payload = Buffer.from(env.payload, 'base64url');
    const asChallenge = signEnvelope({ domain: 'challenge', payload, privateKey: storeKey.privateKey });
    const asReceipt = signEnvelope({ domain: 'receipt', payload, privateKey: storeKey.privateKey });
    expect(asChallenge.signature).not.toBe(asReceipt.signature);
    expect(codeOf(verify({ ...asChallenge, domain: 'receipt' }))).toBe('signature_verification_failed');
  });

  it('other authorization domains and the Evidence Pack domain are refused', () => {
    for (const domain of ['proof', 'grant', 'policy', 'revocation', 'evidence_pack'] as const) {
      const env = resign(receipt(), () => {}, storeKey, domain);
      expect(codeOf(verify(env)), domain).toBe('wrong_domain');
    }
  });
});

describe('signer and trust', () => {
  it('rejects an unknown signer, a wrong-purpose key, and a key outside its window', () => {
    expect(codeOf(verify(receipt({}, outsider)))).toBe('unknown_signing_key');
    expect(codeOf(verify(receipt({}, policyKey)))).toBe('key_purpose_not_allowed');
    expect(codeOf(verify(receipt({}, expiredKey)))).toBe('signing_key_expired');
    expect(codeOf(verify(receipt({}, futureKey)))).toBe('signing_key_not_yet_valid');
  });

  it('requires the same store key that issued the token, and honours a registry pin', () => {
    expect(codeOf(verify(receipt({}, otherStoreKey)))).toBe('signing_key_mismatch');
    expect(verify(receipt(), { signingKeyId: id(storeKey) }).ok).toBe(true);
    expect(codeOf(verify(receipt(), { signingKeyId: id(otherStoreKey) }))).toBe('signing_key_mismatch');
  });

  it('rejects an unvalidated trust root and a bad time', () => {
    expect(codeOf(verify(receipt(), {}, NOW, { ...root }))).toBe('invalid_trust_root');
    expect(codeOf(verify(receipt(), {}, new Date('x')))).toBe('invalid_evaluation_time');
  });

  it('never takes a key from the receipt', () => {
    expect(codeOf(verify({ ...receipt(), publicKey: raw(outsider) }))).toBe('envelope_malformed');
    expect(codeOf(verify(resign(receipt(), (p) => { p.publicKey = raw(outsider); })))).toBe('receipt_invalid');
  });
});

describe('every bound field is compared with the independent expectation', () => {
  it('rejects the wrong organization', () => {
    expect(codeOf(verify(resign(receipt(), (p) => { p.organization = 'globex'; })))).toBe('organization_mismatch');
    const globexRoot = makeRoot('globex', [entry(storeKey, ['challenge_store'])]);
    expect(codeOf(verify(receipt(), {}, NOW, globexRoot))).toBe('organization_mismatch');
  });

  it('rejects the wrong store and the wrong store generation', () => {
    expect(codeOf(verify(receipt({ storeId: 'store-2' })))).toBe('store_mismatch');
    expect(codeOf(verify(receipt({ storeGeneration: 'gen-2' })))).toBe('store_generation_mismatch');
  });

  it('rejects the wrong challenge: another id, or another challenge value', () => {
    expect(codeOf(verify(receipt({ challengeId: Buffer.alloc(16, 3).toString('base64url') })))).toBe('challenge_mismatch');
    expect(codeOf(verify(receipt({ challenge: generateChallenge() })))).toBe('challenge_mismatch');
  });

  it('rejects the wrong grant, subject or subject key', () => {
    expect(codeOf(verify(receipt({ grantId: 'grant-bob-001' })))).toBe('grant_mismatch');
    expect(codeOf(verify(receipt({ subjectId: 'bob' })))).toBe('subject_mismatch');
    expect(codeOf(verify(receipt({ subjectKeyId: id(outsider) })))).toBe('subject_mismatch');
  });

  it('rejects the wrong action context: a receipt for another action, and an expectation for another action', () => {
    const variants: Array<Partial<ActionContext>> = [
      { actionId: 'act-002' },
      { actionType: 'rollback' },
      { environment: 'production' },
      { target: 'billing-service' },
      { commit: 'b'.repeat(40) },
      { contentDigest: computeContentDigest(Buffer.from('changed')) },
    ];
    for (const v of variants) {
      const other = { ...CTX, ...v };
      expect(codeOf(verify(receipt({ context: other }))), `receipt ${JSON.stringify(v)}`).toBe('context_mismatch');
      expect(codeOf(verify(receipt(), { context: other })), `expected ${JSON.stringify(v)}`).toBe('context_mismatch');
    }
  });

  it('rejects a context digest that was changed after signing', () => {
    expect(codeOf(verify(resign(receipt(), (p) => { p.contextDigest = computeActionContextDigest({ ...CTX, target: 'x' }); })))).toBe('context_mismatch');
  });

  it('rejects the wrong proof digest: a receipt for another proof, and another proof presented', () => {
    expect(codeOf(verify(receipt({ proof: PROOF2 })))).toBe('proof_mismatch');
    expect(codeOf(verify(receipt(), { proof: PROOF2 }))).toBe('proof_mismatch');
    const sig = Buffer.from(PROOF.signature, 'base64url');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(codeOf(verify(receipt(), { proof: { ...PROOF, signature: sig.toString('base64url') } }))).toBe('proof_mismatch');
  });

  it('rejects the wrong request id', () => {
    expect(codeOf(verify(receipt({ requestId: REQ2 })))).toBe('request_mismatch');
    expect(codeOf(verify(receipt(), { requestId: REQ2 }))).toBe('request_mismatch');
  });

  it('rejects times that differ from the token: a receipt cannot move the challenge window', () => {
    // (each shifted window still fits the ten-minute maximum, so the receipt can be signed and the mismatch is what is caught)
    expect(codeOf(verify(receipt({ challengeIssuedAt: at(30) })))).toBe('time_mismatch');
    expect(codeOf(verify(receipt({ challengeExpiresAt: at(300) })))).toBe('time_mismatch');
    expect(codeOf(verify(receipt({ challengeExpiresAt: at(590) })))).toBe('time_mismatch');
  });

  it('rejects consumption that is claimed to be in the future', () => {
    expect(codeOf(verify(receipt({ consumedAt: at(500) }), {}, NOW))).toBe('consumed_in_future');
    expect(verify(receipt({ consumedAt: at(500) }), {}, at(500)).ok).toBe(true);
  });
});

describe('timestamp validity inside the receipt', () => {
  it('rejects consumption before issue, at or after expiry, and malformed times', () => {
    expect(codeOf(verify(resign(receipt(), (p) => { p.consumedAt = '2026-06-01T11:59:59Z'; })))).toBe('receipt_invalid');
    expect(codeOf(verify(resign(receipt(), (p) => { p.consumedAt = p.expiresAt; })))).toBe('receipt_invalid');
    expect(codeOf(verify(resign(receipt(), (p) => { p.consumedAt = '2026-06-01T12:30:00Z'; })))).toBe('receipt_invalid');
    for (const bad of ['tomorrow', '2026-02-31T00:00:00Z', '2026-06-01', '2026-06-01T12:00:00+01:00', 5, null]) {
      expect(codeOf(verify(resign(receipt(), (p) => { p.consumedAt = bad; }))), String(bad)).toBe('receipt_invalid');
    }
  });

  it('rejects a window longer than the maximum lifetime', () => {
    expect(codeOf(verify(resign(receipt(), (p) => { p.expiresAt = '2026-06-01T12:10:01Z'; })))).toBe('receipt_invalid');
  });

  it('createConsumptionReceipt refuses the same orderings', () => {
    for (const over of [{ consumedAt: at(-5) }, { consumedAt: new Date(vt.token.expiresAt) }, { consumedAt: at(100000) }, { challengeExpiresAt: new Date(T0.getTime() - 1000) }, { consumedAt: new Date('x') }]) {
      expect(() => receipt(over as never), JSON.stringify(over)).toThrow(ChallengeArtifactError);
    }
  });
});

describe('the optional sequence number', () => {
  it('accepts positive whole numbers, and rejects everything else', () => {
    for (const sequence of [1, 2, 1000, Number.MAX_SAFE_INTEGER]) expect(verify(receipt({ sequence })).ok, String(sequence)).toBe(true);
    for (const bad of [0, -1, 1.5, '1', null, true, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(codeOf(verify(resign(receipt({ sequence: 1 }), (p) => { p.sequence = bad; }))), String(bad)).toBe('receipt_invalid');
      expect(() => receipt({ sequence: bad as number }), String(bad)).toThrow(ChallengeArtifactError);
    }
  });

  it('is carried exactly; an absent sequence stays absent', () => {
    const r = verify(receipt({ sequence: 7 }));
    expect(r.ok && r.receipt.sequence).toBe(7);
    // JSON drops an undefined value, so this payload simply has no sequence field
    const without = verify(resign(receipt({ sequence: 7 }), (p) => { p.sequence = undefined; }));
    expect(without.ok && 'sequence' in without.receipt).toBe(false);
  });

  it('documents its meaning: per (storeId, storeGeneration), assigned at consumption, strictly increasing, gaps allowed', () => {
    const source = readFileSync(new URL('../../../../src/features/action-safety/authorization/consumptionReceipt.ts', import.meta.url), 'utf-8');
    expect(source).toContain('strictly greater than the sequence of every receipt the SAME');
    expect(source).toContain('gaps allowed');
    expect(source).toContain('restarts only with a new storeGeneration');
  });
});

describe('tampering and malformed receipts', () => {
  it('rejects a changed payload and a changed signature', () => {
    const env = receipt();
    const doc = payloadOf(env);
    doc.requestId = REQ2;
    expect(codeOf(verify({ ...env, payload: Buffer.from(JSON.stringify(doc)).toString('base64url') }, { requestId: REQ2 }))).toBe('signature_verification_failed');
    const sig = Buffer.from(env.signature, 'base64url');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(codeOf(verify({ ...env, signature: sig.toString('base64url') }))).toBe('signature_verification_failed');
    expect(codeOf(verify({ ...receipt({}, outsider), keyId: id(storeKey) }))).toBe('signature_verification_failed');
  });

  it('rejects unknown, missing and malformed fields', () => {
    expect(codeOf(verify(resign(receipt(), (p) => { p.extra = 1; })))).toBe('receipt_invalid');
    expect(codeOf(verify(resign(receipt(), (p) => { p.challenge = vt.token.challenge; })))).toBe('receipt_invalid'); // the raw challenge is not an accepted field
    for (const field of ['organization', 'storeId', 'storeGeneration', 'receiptId', 'challengeId', 'challengeHash', 'grantId', 'subjectId', 'subjectKeyId', 'contextDigest', 'proofDigest', 'requestId', 'issuedAt', 'consumedAt', 'expiresAt']) {
      expect(codeOf(verify(resign(receipt(), (p) => { delete p[field]; }))), field).toBe('receipt_invalid');
    }
    const cases: Array<[string, unknown]> = [
      ['receiptId', 'short'],
      ['challengeId', 'short'],
      ['challengeHash', 'a'.repeat(64)],
      ['proofDigest', `sha1:${'a'.repeat(64)}`],
      ['contextDigest', 'nope'],
      ['requestId', 'short'],
      ['storeId', 'Store 1'],
      ['subjectKeyId', 'abc'],
    ];
    for (const [field, value] of cases) expect(codeOf(verify(resign(receipt(), (p) => { p[field] = value; }))), `${field}=${String(value)}`).toBe('receipt_invalid');
  });

  it('rejects unsupported versions, non-object payloads and non-JSON, and reads nothing before the signature', () => {
    for (const version of [0, 2, '1', null]) expect(codeOf(verify(resign(receipt(), (p) => { p.version = version; }))), String(version)).toBe('unsupported_receipt_version');
    for (const payload of ['[]', 'null', '7']) expect(codeOf(verify(signEnvelope({ domain: 'receipt', payload: Buffer.from(payload), privateKey: storeKey.privateKey }))), payload).toBe('unsupported_receipt_version');
    expect(codeOf(verify(signEnvelope({ domain: 'receipt', payload: Buffer.from('{ no'), privateKey: outsider.privateKey })))).toBe('unknown_signing_key');
    expect(codeOf(verify(signEnvelope({ domain: 'receipt', payload: Buffer.from('{ no'), privateKey: storeKey.privateKey })))).toBe('payload_not_json');
  });

  it('survives hostile envelopes without throwing', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    const env = receipt();
    for (const c of [null, undefined, 5, [], 'nope', '{', {}, hostile, { ...env, payload: '!!' }, { ...env, extra: 1 }, 'x'.repeat(2_000_000)]) expect(verify(c).ok).toBe(false);
  });
});

describe('forged expectations and forged verified objects', () => {
  it('refuses an expected token that is not a genuine verified token', () => {
    const forged: unknown[] = [{ ...vt }, JSON.parse(JSON.stringify(vt)), Object.create(vt), { ok: true, token: vt.token, signingKeyId: vt.signingKeyId }, null, undefined, 5, 'token'];
    for (const token of forged) expect(codeOf(verify(receipt(), { token: token as VerifiedChallengeToken })), JSON.stringify(token)?.slice(0, 20)).toBe('invalid_expected');
  });

  it('refuses invalid expectations', () => {
    const env = receipt();
    expect(codeOf(verify(env, { requestId: 'short' }))).toBe('invalid_expected');
    expect(codeOf(verify(env, { context: { ...CTX, target: 'bad target' } }))).toBe('invalid_expected');
    expect(codeOf(verify(env, { proof: { not: 'a proof' } }))).toBe('invalid_expected');
    expect(codeOf(verify(env, { proof: undefined }))).toBe('invalid_expected');
    expect(codeOf(verify(env, { signingKeyId: 'xyz' }))).toBe('invalid_expected');
    expect(codeOf(verifyConsumptionReceipt(env, root, null as unknown as ExpectedReceipt, NOW))).toBe('invalid_expected');
  });

  it('a plain object, a copy or a JSON clone is not a verified receipt', () => {
    const real = verify(receipt());
    if (!real.ok) throw new Error('setup');
    for (const f of [{ ...real }, JSON.parse(JSON.stringify(real)), Object.create(real), { ok: true, receipt: real.receipt, signingKeyId: real.signingKeyId }, null, undefined, 5, {}]) {
      expect(isVerifiedConsumptionReceipt(f)).toBe(false);
    }
    expect(isVerifiedConsumptionReceipt(real)).toBe(true);
  });
});

describe('scope: legacy contracts are untouched and nothing makes a bare "consumed" look trusted', () => {
  const source = (name: string): string => {
    const full = readFileSync(new URL(`../../../../src/features/action-safety/authorization/${name}`, import.meta.url), 'utf-8');
    return full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  };

  it('the new modules do not import the legacy store contract or the evaluators, and offer no adapter', async () => {
    for (const name of ['challengeToken.ts', 'consumptionReceipt.ts', 'challengeCommon.ts']) {
      const imports = [...source(name).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const forbidden of ['./twoPhaseAuthorization.js', './evaluateAuthorization.js', './strictAuthorityAdapter.js', './actionContextCollector.js', './strictConfig.js']) expect(imports, `${name} imports ${forbidden}`).not.toContain(forbidden);
      expect(source(name)).not.toMatch(/ChallengeStore|consumeChallenge/);
    }
    const token = await import('../../../../src/features/action-safety/authorization/challengeToken.js');
    const rcpt = await import('../../../../src/features/action-safety/authorization/consumptionReceipt.js');
    for (const exported of [...Object.keys(token), ...Object.keys(rcpt)]) expect(exported, exported).not.toMatch(/adapter|legacy|compat|asStore|toChallengeStore/i);
  });

  it('the legacy store contract still treats a bare answer as the legacy contract says, with its own limits stated', async () => {
    const proof = await import('../../../../src/features/action-safety/authorization/proof.js');
    // unchanged: a one-word answer is still only the LEGACY contract's answer, and nothing here upgrades it
    expect(proof.consumeChallenge.length).toBe(2);
    const text = readFileSync(new URL('../../../../src/features/action-safety/authorization/proof.ts', import.meta.url), 'utf-8');
    expect(text).toContain("Promise<'consumed' | 'already_used'>");
  });

  it('the new modules read no files, clocks, environment, network or processes', () => {
    for (const name of ['challengeToken.ts', 'consumptionReceipt.ts', 'challengeCommon.ts']) {
      const text = source(name);
      for (const forbidden of ['node:fs', 'child_process', 'process.env', 'process.cwd', 'Date.now', 'new Date()', 'fetch(', 'node:http', 'node:net']) expect(text, `${name}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('nothing outside the authorization folder imports them yet', () => {
    const root = new URL('../../../../src/features/action-safety/', import.meta.url);
    const offenders: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
        if (e.isDirectory()) {
          // `strict` is the setup tooling (keys, grants, approvals), not the assessment: it may use these modules
          if (e.name !== 'authorization' && e.name !== 'strict') walk(child);
        } else if (e.name.endsWith('.ts')) {
          const text = readFileSync(child, 'utf-8');
          if (/challengeToken|consumptionReceipt|challengeCommon/.test(text)) offenders.push(e.name);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('trusted-side signing', () => {
  it('refuses bad input with structured, secret-free errors', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ privateKey: storeKey.publicKey }, 'invalid_private_key'],
      [{ privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }, 'invalid_private_key'],
      [{ privateKey: 'key' }, 'invalid_private_key'],
      [{ context: { ...CTX, target: 'bad target' } }, 'invalid_context'],
      [{ proof: { not: 'a proof' } }, 'invalid_proof_envelope'],
      [{ proof: undefined }, 'invalid_proof_envelope'],
      [{ challenge: 'weak' }, 'invalid_challenge'],
      [{ requestId: 'short' }, 'invalid_identifier'],
      [{ storeId: 'Store 1' }, 'invalid_identifier'],
      [{ challengeId: 'short' }, 'invalid_identifier'],
      [{ sequence: 0 }, 'invalid_sequence'],
    ];
    for (const [over, reason] of cases) {
      try {
        receipt(over as never);
        expect.unreachable(reason);
      } catch (err) {
        expect(err).toBeInstanceOf(ChallengeArtifactError);
        expect(err).toBeInstanceOf(CodexrevError);
        expect((err as ChallengeArtifactError).reason, reason).toBe(reason);
        expect((err as CodexrevError).code).toBe('CODEXREV_AUTHZ_CHALLENGE_ARTIFACT_ERROR');
        expect((err as Error).message).not.toContain(String(storeKey.privateKey.export({ format: 'jwk' }).d));
        expect((err as Error).message).not.toContain(vt.token.challenge);
      }
    }
  });
});
