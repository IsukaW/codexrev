// Tests for signed challenge tokens. In-memory Ed25519 keys only; offline and deterministic.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ChallengeArtifactError,
  MAX_CHALLENGE_LIFETIME_MS,
  computeActionContextDigest,
} from '../../../../src/features/action-safety/authorization/challengeCommon.js';
import {
  CHALLENGE_TOKEN_VERSION,
  createChallengeToken,
  isVerifiedChallengeToken,
  verifyChallengeToken,
  type ChallengeTokenResult,
  type ExpectedChallenge,
} from '../../../../src/features/action-safety/authorization/challengeToken.js';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { computeContentDigest, isValidChallenge, type ActionContext } from '../../../../src/features/action-safety/authorization/proof.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import { SIGNING_DOMAINS, type SignedEnvelope } from '../../../../src/features/action-safety/authorization/types.js';
import { CodexrevError } from '../../../../src/utils/errors.js';

const T0 = new Date('2026-06-01T12:00:00Z');
const NOW = new Date('2026-06-01T12:01:00Z');
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

let storeKey: Keys;
let otherStoreKey: Keys;
let policyKey: Keys;
let grantOnlyKey: Keys;
let expiredKey: Keys;
let futureKey: Keys;
let outsider: Keys;
let aliceKey: Keys;
let root: TrustRoot;

const makeRoot = (organization: string, keys: Record<string, unknown>[]): TrustRoot => {
  const r = parseTrustRoot({ version: 1, organization, createdAt: '2026-01-01T00:00:00Z', keys });
  if (!r.ok) throw new Error(`setup: ${r.code}`);
  return r.trustRoot;
};

beforeAll(() => {
  [storeKey, otherStoreKey, policyKey, grantOnlyKey, expiredKey, futureKey, outsider, aliceKey] = Array.from({ length: 8 }, pair) as Keys[];
  root = makeRoot('acme', [
    entry(storeKey, ['challenge_store']),
    entry(otherStoreKey, ['challenge_store']),
    entry(policyKey, ['policy']),
    entry(grantOnlyKey, ['grant']),
    entry(expiredKey, ['challenge_store'], { notAfter: '2026-03-01T00:00:00Z' }),
    entry(futureKey, ['challenge_store'], { notBefore: '2026-09-01T00:00:00Z' }),
  ]);
});

const token = (over: Record<string, unknown> = {}, key: Keys = storeKey): SignedEnvelope =>
  createChallengeToken({
    privateKey: key.privateKey,
    organization: 'acme',
    storeId: 'store-1',
    storeGeneration: 'gen-1',
    grantId: 'grant-alice-001',
    subjectId: 'alice',
    subjectKeyId: id(aliceKey),
    context: CTX,
    issuedAt: T0,
    ...over,
  } as never);

const expectedFor = (over: Partial<ExpectedChallenge> = {}): ExpectedChallenge => ({ storeId: 'store-1', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, ...over });
const verify = (env: unknown, over: Partial<ExpectedChallenge> = {}, now: Date = NOW, tr: TrustRoot = root): ChallengeTokenResult => verifyChallengeToken(env, tr, expectedFor(over), now);
const codeOf = (r: ChallengeTokenResult): string | undefined => (r.ok ? undefined : r.code);
const payloadOf = (env: SignedEnvelope): Record<string, any> => JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
const resign = (env: SignedEnvelope, change: (p: Record<string, any>) => void, key: Keys = storeKey, domain: (typeof SIGNING_DOMAINS)[number] = 'challenge'): SignedEnvelope => {
  const p = payloadOf(env);
  change(p);
  return signEnvelope({ domain, payload: Buffer.from(JSON.stringify(p)), privateKey: key.privateKey });
};

describe('a valid signed challenge token', () => {
  it('verifies, and returns a branded, deeply frozen result with every bound field', () => {
    const env = token();
    const r = verify(env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token).toMatchObject({
      version: CHALLENGE_TOKEN_VERSION,
      organization: 'acme',
      storeId: 'store-1',
      storeGeneration: 'gen-1',
      grantId: 'grant-alice-001',
      subjectId: 'alice',
      subjectKeyId: id(aliceKey),
      contextDigest: computeActionContextDigest(CTX),
      issuedAt: '2026-06-01T12:00:00Z',
      expiresAt: '2026-06-01T12:10:00Z',
    });
    expect(r.signingKeyId).toBe(id(storeKey));
    expect(isValidChallenge(r.token.challenge)).toBe(true);
    expect(r.token.challengeId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.token)).toBe(true);
    expect(isVerifiedChallengeToken(r)).toBe(true);
    expect(() => { (r.token as { storeId: string }).storeId = 'x'; }).toThrow();
  });

  it('signs under the challenge domain with the store key', () => {
    const env = token();
    expect(env.domain).toBe('challenge');
    expect(env.keyId).toBe(id(storeKey));
  });

  it('accepts the envelope as JSON text', () => {
    expect(verify(JSON.stringify(token())).ok).toBe(true);
  });

  it('generates the challenge and the challenge id itself: every token is different', () => {
    const a = payloadOf(token());
    const b = payloadOf(token());
    expect(a.challenge).not.toBe(b.challenge);
    expect(a.challengeId).not.toBe(b.challengeId);
    const challenges = new Set(Array.from({ length: 100 }, () => payloadOf(token()).challenge));
    expect(challenges.size).toBe(100);
  });

  it('honours a shorter lifetime, and the exact maximum', () => {
    expect(payloadOf(token({ lifetimeMs: 60_000 })).expiresAt).toBe('2026-06-01T12:01:00Z');
    expect(MAX_CHALLENGE_LIFETIME_MS).toBe(600_000);
    expect(verify(token({ lifetimeMs: MAX_CHALLENGE_LIFETIME_MS })).ok).toBe(true);
  });

  it('is bound to the exact action context digest, not to the Git snapshot digest', () => {
    expect(payloadOf(token()).contextDigest).toBe(computeActionContextDigest(CTX));
    expect(payloadOf(token()).contextDigest).not.toBe(CTX.contentDigest);
  });

  it('accepts a store generation and signing key expectation when they match', () => {
    expect(verify(token(), { storeGeneration: 'gen-1', signingKeyId: id(storeKey) }).ok).toBe(true);
  });

  it('does not depend on the clock beyond the injected time: valid exactly from issue until expiry', () => {
    const env = token();
    expect(verify(env, {}, at(0)).ok).toBe(true);
    expect(verify(env, {}, at(599)).ok).toBe(true);
    expect(codeOf(verify(env, {}, at(600)))).toBe('token_expired');
    expect(codeOf(verify(env, {}, at(-1)))).toBe('token_not_yet_valid');
  });
});

describe('signing domain, signer and trust', () => {
  it('rejects the wrong signing domain, and relabelling does not help', () => {
    for (const domain of ['receipt', 'proof', 'grant', 'policy', 'revocation'] as const) {
      const env = resign(token(), () => {}, storeKey, domain);
      expect(codeOf(verify(env)), domain).toBe('wrong_domain');
      expect(codeOf(verify({ ...env, domain: 'challenge' })), `${domain} relabelled`).toBe('signature_verification_failed');
    }
  });

  it('uses the authorization namespace, apart from the Evidence Pack namespace (domain separation)', () => {
    const env = token();
    const asPack = { ...env, domain: 'evidence_pack' };
    expect(codeOf(verify(asPack))).toBe('wrong_domain');
  });

  it('rejects an unknown signer even though its signature is valid', () => {
    expect(codeOf(verify(token({}, outsider)))).toBe('unknown_signing_key');
  });

  it('rejects a developer-created token: unsigned, or signed with their own key', () => {
    const doc = payloadOf(token());
    // a bare payload is not an envelope at all; a hand-made envelope names a key the trust root does not know
    expect(codeOf(verify(doc))).toBe('wrong_domain');
    expect(codeOf(verify({ version: 1, domain: 'challenge', keyId: id(aliceKey), payload: Buffer.from(JSON.stringify(doc)).toString('base64url'), signature: '' }))).toBe('unknown_signing_key');
    // even naming the real store key, an empty or invented signature is refused
    expect(verify({ version: 1, domain: 'challenge', keyId: id(storeKey), payload: Buffer.from(JSON.stringify(doc)).toString('base64url'), signature: '' }).ok).toBe(false);
    expect(codeOf(verify(token({}, aliceKey)))).toBe('unknown_signing_key');
  });

  it('rejects a key with the wrong purpose: policy, grant and revocation keys cannot sign tokens', () => {
    expect(codeOf(verify(token({}, policyKey)))).toBe('key_purpose_not_allowed');
    expect(codeOf(verify(token({}, grantOnlyKey)))).toBe('key_purpose_not_allowed');
  });

  it('rejects an issuer key outside its validity window (the trust model has no other form of revocation)', () => {
    expect(codeOf(verify(token({}, expiredKey)))).toBe('signing_key_expired');
    expect(codeOf(verify(token({}, futureKey)))).toBe('signing_key_not_yet_valid');
  });

  it('rejects a token signed by another trusted store key when the registry pins the store key', () => {
    const env = token({}, otherStoreKey);
    expect(verify(env).ok).toBe(true); // without a pin any challenge_store key is accepted: stated limitation
    expect(codeOf(verify(env, { signingKeyId: id(storeKey) }))).toBe('signing_key_mismatch');
  });

  it('rejects an unvalidated trust root and a bad evaluation time', () => {
    expect(codeOf(verify(token(), {}, NOW, { ...root }))).toBe('invalid_trust_root');
    expect(codeOf(verify(token(), {}, new Date('x')))).toBe('invalid_evaluation_time');
    expect(codeOf(verify(token(), {}, '2026-06-01' as unknown as Date))).toBe('invalid_evaluation_time');
  });

  it('never takes a key from the token: extra key fields are rejected', () => {
    expect(codeOf(verify({ ...token(), publicKey: raw(outsider) }))).toBe('envelope_malformed');
    expect(codeOf(verify(resign(token(), (p) => { p.publicKey = raw(outsider); })))).toBe('token_invalid');
  });
});

describe('what the token must be for', () => {
  it('rejects the wrong organization, in the token and in the trust root', () => {
    expect(codeOf(verify(resign(token(), (p) => { p.organization = 'globex'; })))).toBe('organization_mismatch');
    const globexRoot = makeRoot('globex', [entry(storeKey, ['challenge_store'])]);
    expect(codeOf(verify(token(), {}, NOW, globexRoot))).toBe('organization_mismatch');
  });

  it('rejects the wrong store and the wrong store generation', () => {
    expect(codeOf(verify(token(), { storeId: 'store-2' }))).toBe('store_mismatch');
    expect(codeOf(verify(token({ storeId: 'store-2' })))).toBe('store_mismatch');
    expect(codeOf(verify(token(), { storeGeneration: 'gen-2' }))).toBe('store_generation_mismatch');
    expect(codeOf(verify(token({ storeGeneration: 'gen-2' }), { storeGeneration: 'gen-1' }))).toBe('store_generation_mismatch');
  });

  it('rejects the wrong grant, subject or subject key', () => {
    expect(codeOf(verify(token(), { grantId: 'grant-bob-001' }))).toBe('grant_mismatch');
    expect(codeOf(verify(token(), { subjectId: 'bob' }))).toBe('subject_mismatch');
    expect(codeOf(verify(token(), { subjectKeyId: id(outsider) }))).toBe('subject_mismatch');
    expect(codeOf(verify(token({ grantId: 'grant-bob-001' })))).toBe('grant_mismatch');
  });

  it('rejects a token issued for a different action: each of the six context fields', () => {
    const env = token();
    const variants: Array<Partial<ActionContext>> = [
      { actionId: 'act-002' },
      { actionType: 'rollback' },
      { environment: 'production' },
      { target: 'billing-service' },
      { commit: 'b'.repeat(40) },
      { contentDigest: computeContentDigest(Buffer.from('changed after issue')) },
    ];
    for (const v of variants) expect(codeOf(verify(env, { context: { ...CTX, ...v } })), JSON.stringify(v)).toBe('context_mismatch');
  });

  it('rejects a tampered digest inside a validly signed token', () => {
    expect(codeOf(verify(resign(token(), (p) => { p.contextDigest = computeActionContextDigest({ ...CTX, target: 'x' }); })))).toBe('context_mismatch');
  });

  it('rejects invalid expectations before anything else', () => {
    const env = token();
    const bad: Array<Partial<ExpectedChallenge>> = [
      { storeId: '' },
      { storeId: 'Store 1' },
      { storeGeneration: 'bad generation' },
      { signingKeyId: 'xyz' },
      { grantId: '' },
      { subjectId: 'has space' },
      { subjectKeyId: 'abc' },
      { context: { ...CTX, target: 'bad target' } },
      { context: null as unknown as ActionContext },
    ];
    for (const b of bad) expect(codeOf(verify(env, b)), JSON.stringify(b)).toBe('invalid_expected');
    expect(codeOf(verifyChallengeToken(env, root, null as unknown as ExpectedChallenge, NOW))).toBe('invalid_expected');
  });
});

describe('timestamps and lifetime', () => {
  it('rejects an expired token and a not-yet-valid token', () => {
    const env = token();
    expect(codeOf(verify(env, {}, at(601)))).toBe('token_expired');
    expect(codeOf(verify(env, {}, at(3600)))).toBe('token_expired');
    expect(codeOf(verify(env, {}, at(-60)))).toBe('token_not_yet_valid');
  });

  it('rejects a lifetime beyond the maximum', () => {
    expect(codeOf(verify(resign(token(), (p) => { p.expiresAt = '2026-06-01T12:10:01Z'; })))).toBe('lifetime_exceeds_maximum');
    expect(codeOf(verify(resign(token(), (p) => { p.expiresAt = '2026-07-01T12:00:00Z'; })))).toBe('lifetime_exceeds_maximum');
  });

  it('rejects invalid timestamp ordering', () => {
    expect(codeOf(verify(resign(token(), (p) => { p.expiresAt = p.issuedAt; })))).toBe('token_invalid');
    expect(codeOf(verify(resign(token(), (p) => { p.expiresAt = '2026-06-01T11:00:00Z'; })))).toBe('token_invalid');
  });

  it('rejects malformed timestamps', () => {
    for (const bad of ['tomorrow', '2026-02-31T00:00:00Z', '2026-06-01', '2026-06-01T12:00:00+01:00', 5, null]) {
      expect(codeOf(verify(resign(token(), (p) => { p.issuedAt = bad; }))), String(bad)).toBe('token_invalid');
      expect(codeOf(verify(resign(token(), (p) => { p.expiresAt = bad; }))), String(bad)).toBe('token_invalid');
    }
  });
});

describe('tampering and malformed tokens', () => {
  it('rejects a changed payload and a changed signature', () => {
    const env = token();
    const doc = payloadOf(env);
    doc.grantId = 'grant-bob-001';
    expect(codeOf(verify({ ...env, payload: Buffer.from(JSON.stringify(doc)).toString('base64url') }, { grantId: 'grant-bob-001' }))).toBe('signature_verification_failed');
    const sig = Buffer.from(env.signature, 'base64url');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(codeOf(verify({ ...env, signature: sig.toString('base64url') }))).toBe('signature_verification_failed');
  });

  it('rejects a forged key id', () => {
    expect(codeOf(verify({ ...token({}, outsider), keyId: id(storeKey) }))).toBe('signature_verification_failed');
  });

  it('rejects unknown, missing and misspelled fields', () => {
    expect(codeOf(verify(resign(token(), (p) => { p.extra = 1; })))).toBe('token_invalid');
    expect(codeOf(verify(resign(token(), (p) => { p.signingKey = raw(outsider); })))).toBe('token_invalid');
    for (const field of ['organization', 'storeId', 'storeGeneration', 'challengeId', 'challenge', 'grantId', 'subjectId', 'subjectKeyId', 'contextDigest', 'issuedAt', 'expiresAt']) {
      expect(codeOf(verify(resign(token(), (p) => { delete p[field]; }))), field).toBe('token_invalid');
    }
  });

  it('rejects malformed values', () => {
    const cases: Array<[string, unknown]> = [
      ['challenge', ''],
      ['challenge', 'short'],
      ['challenge', `${payloadOf(token()).challenge}=`],
      ['challenge', 5],
      ['challengeId', 'short'],
      ['challengeId', 'A'.repeat(22).replace(/.$/, 'B')],
      ['storeId', 'Store 1'],
      ['storeGeneration', ''],
      ['subjectKeyId', 'abc'],
      ['contextDigest', 'a'.repeat(64)],
      ['contextDigest', `sha1:${'a'.repeat(64)}`],
      ['organization', 'Bad Org'],
    ];
    for (const [field, value] of cases) expect(codeOf(verify(resign(token(), (p) => { p[field] = value; }))), `${field}=${String(value)}`).toBe('token_invalid');
  });

  it('rejects unsupported versions and non-object payloads', () => {
    for (const version of [0, 2, '1', null]) expect(codeOf(verify(resign(token(), (p) => { p.version = version; }))), String(version)).toBe('unsupported_token_version');
    for (const payload of ['[]', 'null', '7', '"x"']) {
      expect(codeOf(verify(signEnvelope({ domain: 'challenge', payload: Buffer.from(payload), privateKey: storeKey.privateKey }))), payload).toBe('unsupported_token_version');
    }
  });

  it('does not parse the payload before the signature', () => {
    expect(codeOf(verify(signEnvelope({ domain: 'challenge', payload: Buffer.from('{ not json'), privateKey: outsider.privateKey })))).toBe('unknown_signing_key');
    expect(codeOf(verify(signEnvelope({ domain: 'challenge', payload: Buffer.from('{ not json'), privateKey: storeKey.privateKey })))).toBe('payload_not_json');
  });

  it('rejects malformed envelopes and survives hostile input without throwing', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    const env = token();
    for (const c of [null, undefined, 5, [], 'nope', '{', {}, hostile, { ...env, payload: '!!' }, { ...env, version: 2 }, { ...env, extra: 1 }, 'x'.repeat(2_000_000)]) {
      expect(verify(c).ok).toBe(false);
    }
    expect(verifyChallengeToken(env, root, hostile as unknown as ExpectedChallenge, NOW).ok).toBe(false);
  });
});

describe('verified tokens cannot be forged', () => {
  it('a plain object, a spread copy, a JSON clone or an inherited object is not a verified token', () => {
    const real = verify(token());
    if (!real.ok) throw new Error('setup');
    const forgeries: unknown[] = [{ ...real }, JSON.parse(JSON.stringify(real)), Object.create(real), { ok: true, token: real.token, signingKeyId: real.signingKeyId }, null, undefined, 5, 'token', {}];
    for (const f of forgeries) expect(isVerifiedChallengeToken(f)).toBe(false);
    expect(isVerifiedChallengeToken(real)).toBe(true);
  });
});

describe('leakage and trusted-side errors', () => {
  it('never puts the challenge in a failure message', () => {
    const env = token();
    const challenge = payloadOf(env).challenge;
    const results = [verify(env, { grantId: 'grant-bob-001' }), verify(env, { context: { ...CTX, target: 'x' } }), verify(env, {}, at(9999)), verify(resign(env, (p) => { p.extra = 1; })), verify(resign(env, (p) => { p.challengeId = 'bad'; }))];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(challenge);
    }
  });

  it('createChallengeToken refuses bad trusted-side input with structured, secret-free errors', () => {
    const base = { privateKey: storeKey.privateKey, organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', grantId: 'g1', subjectId: 'alice', subjectKeyId: id(aliceKey), context: CTX, issuedAt: T0 };
    const cases: Array<[Partial<typeof base> & Record<string, unknown>, string]> = [
      [{ privateKey: storeKey.publicKey }, 'invalid_private_key'],
      [{ privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }, 'invalid_private_key'],
      [{ privateKey: 'key' as never }, 'invalid_private_key'],
      [{ issuedAt: new Date('x') }, 'invalid_time'],
      [{ lifetimeMs: MAX_CHALLENGE_LIFETIME_MS + 1 }, 'invalid_lifetime'],
      [{ lifetimeMs: 999 }, 'invalid_lifetime'],
      [{ lifetimeMs: 0 }, 'invalid_lifetime'],
      [{ lifetimeMs: 1.5 }, 'invalid_lifetime'],
      [{ context: { ...CTX, target: 'bad target' } as ActionContext }, 'invalid_context'],
      [{ storeId: 'Store 1' }, 'invalid_identifier'],
      [{ storeGeneration: '' }, 'invalid_identifier'],
      [{ grantId: 'has space' }, 'invalid_identifier'],
      [{ subjectKeyId: 'abc' }, 'invalid_identifier'],
      [{ organization: 'Bad Org' }, 'invalid_identifier'],
    ];
    for (const [over, reason] of cases) {
      try {
        createChallengeToken({ ...base, ...over } as never);
        expect.unreachable(reason);
      } catch (err) {
        expect(err).toBeInstanceOf(ChallengeArtifactError);
        expect(err).toBeInstanceOf(CodexrevError);
        expect((err as ChallengeArtifactError).reason, reason).toBe(reason);
        expect((err as Error).message).not.toContain(String(storeKey.privateKey.export({ format: 'jwk' }).d));
      }
    }
  });

  it('generates and stores no key: the module takes a key only as an argument', () => {
    expect(createChallengeToken.length).toBe(1);
  });
});
