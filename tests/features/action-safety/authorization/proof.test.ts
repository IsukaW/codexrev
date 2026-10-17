// Tests for developer proof of possession. In-memory Ed25519 keys only; offline and deterministic.
// Nothing here touches Git or the filesystem: contexts are supplied explicitly, as a future trusted collector would.

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { verifyGrant, type VerifiedGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy } from '../../../../src/features/action-safety/authorization/policy.js';
import {
  CHALLENGE_BYTES,
  MAX_PROOF_LIFETIME_MS,
  ProofError,
  computeContentDigest,
  consumeChallenge,
  createProof,
  generateChallenge,
  isValidChallenge,
  isVerifiedProof,
  parseActionContext,
  verifyProof,
  type ActionContext,
  type ChallengeStore,
  type ProofResult,
  type VerifiedProof,
} from '../../../../src/features/action-safety/authorization/proof.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import { CodexrevError } from '../../../../src/utils/errors.js';

const NOW = new Date('2026-06-01T12:00:00Z');
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');
const raw = (k: Keys): string => exportRawPublicKey(k.publicKey).toString('base64url');
const id = (k: Keys): string => deriveKeyId(k.publicKey);
const at = (offsetSeconds: number): Date => new Date(NOW.getTime() + offsetSeconds * 1000);

const entry = (k: Keys, purposes: string[]): Record<string, unknown> => ({
  keyId: id(k),
  publicKey: raw(k),
  purposes,
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2027-01-01T00:00:00Z',
});

let policyKey: Keys;
let grantKey: Keys;
let alice: Keys;
let bob: Keys;
let outsider: Keys;
let root: TrustRoot;
let aliceGrant: VerifiedGrant;
let bobGrant: VerifiedGrant;

const COMMIT = 'a'.repeat(40);
const devCtx = (): ActionContext => ({
  actionId: 'act-001',
  actionType: 'code_change',
  environment: 'development',
  target: 'payments-service',
  commit: COMMIT,
  contentDigest: computeContentDigest(Buffer.from('diff --git a/x b/x\n+change\n')),
});
const prodCtx = (): ActionContext => ({
  actionId: 'act-002',
  actionType: 'deployment',
  environment: 'production',
  target: 'payments-service',
  commit: 'b'.repeat(40),
  contentDigest: computeContentDigest(Buffer.from('{"deploy":"payments-service","build":"1.4.2"}')),
});

const signRaw = (doc: unknown, key: Keys = alice, domain: 'proof' | 'grant' | 'policy' | 'revocation' = 'proof') =>
  signEnvelope({ domain, payload: Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)), privateKey: key.privateKey });

const grantFor = (who: Keys, grantId: string, subjectId: string): VerifiedGrant => {
  const policyDoc = {
    version: 2,
    organization: 'acme',
    policyId: 'acme-policy',
    revision: 5,
    issuedAt: '2026-05-01T00:00:00Z',
    effectiveAt: '2026-05-01T00:00:00Z',
    expiresAt: '2026-12-01T00:00:00Z',
    permissions: ['code.change'],
    roles: [{ name: 'developer', permissions: ['code.change'] }],
    rules: [],
  };
  const p = verifyPolicy(signRaw(policyDoc, policyKey, 'policy'), root, NOW);
  if (!p.ok) throw new Error(`setup policy: ${p.code}`);
  const g = verifyGrant(
    signRaw(
      {
        version: 1,
        grantId,
        organization: 'acme',
        subject: { id: subjectId, type: 'human', publicKey: raw(who), keyId: id(who) },
        roles: ['developer'],
        permissionScope: null,
        issuedAt: '2026-05-25T00:00:00Z',
        notBefore: '2026-05-25T00:00:00Z',
        expiresAt: '2026-08-01T00:00:00Z',
        minPolicyRevision: 1,
      },
      grantKey,
      'grant',
    ),
    root,
    p.policy,
    NOW,
  );
  if (!g.ok) throw new Error(`setup grant: ${g.code}`);
  return g;
};

beforeAll(() => {
  policyKey = pair();
  grantKey = pair();
  alice = pair();
  bob = pair();
  outsider = pair();
  const r = parseTrustRoot({ version: 1, organization: 'acme', createdAt: '2026-01-01T00:00:00Z', keys: [entry(policyKey, ['policy']), entry(grantKey, ['grant'])] });
  if (!r.ok) throw new Error('setup trust root');
  root = r.trustRoot;
  aliceGrant = grantFor(alice, 'grant-alice-001', 'alice');
  bobGrant = grantFor(bob, 'grant-bob-001', 'bob');
});

const challenge = generateChallenge();
const proofFor = (ctx: ActionContext = devCtx(), ch: string = challenge, issuedAt: Date = NOW) => createProof({ privateKey: alice.privateKey, grant: aliceGrant, context: ctx, challenge: ch, issuedAt });
const verify = (env: unknown, ctx: ActionContext = devCtx(), ch: string = challenge, when: Date = NOW, grant: VerifiedGrant = aliceGrant): ProofResult => verifyProof(env, grant, ctx, ch, when);
const codeOf = (r: ProofResult): string | undefined => (r.ok ? undefined : r.code);
const rawDoc = (over: Record<string, unknown> = {}): Record<string, any> => ({
  version: 1,
  organization: 'acme',
  grantId: 'grant-alice-001',
  subjectId: 'alice',
  subjectKeyId: id(alice),
  ...devCtx(),
  challenge,
  issuedAt: '2026-06-01T12:00:00Z',
  expiresAt: '2026-06-01T12:05:00Z',
  ...over,
});

describe('valid proofs', () => {
  it('verifies a development code change signed with the grant subject key', () => {
    const r = verify(proofFor());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proof).toMatchObject({ organization: 'acme', grantId: 'grant-alice-001', subjectId: 'alice', subjectKeyId: id(alice), actionType: 'code_change', environment: 'development', target: 'payments-service', commit: COMMIT, challenge });
      expect(r.proof.issuedAt).toBe('2026-06-01T12:00:00Z');
      expect(r.proof.expiresAt).toBe('2026-06-01T12:05:00Z');
      expect(Object.isFrozen(r)).toBe(true);
      expect(isVerifiedProof(r)).toBe(true);
      expect(isVerifiedProof({ ...r })).toBe(false);
    }
  });

  it('verifies a production deployment context', () => {
    expect(verify(proofFor(prodCtx()), prodCtx()).ok).toBe(true);
  });

  it('supports a context without a commit for actions where none applies', () => {
    const ctx: ActionContext = { ...prodCtx(), actionType: 'configuration_change', commit: null };
    expect(verify(proofFor(ctx), ctx).ok).toBe(true);
  });

  it('digests binary content exactly, independently of any text encoding', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const digest = computeContentDigest(bytes);
    expect(digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeContentDigest(new Uint8Array(bytes))).toBe(digest);
    expect(computeContentDigest(Buffer.from([0]))).not.toBe(computeContentDigest(Buffer.alloc(0)));
    const ctx = { ...devCtx(), contentDigest: digest };
    expect(verify(proofFor(ctx), ctx).ok).toBe(true);
    expect(() => computeContentDigest('text' as unknown as Uint8Array)).toThrow(ProofError);
  });

  it('is deterministic: the same inputs give the same signed proof, and matching is exact equality', () => {
    expect(proofFor()).toEqual(proofFor());
    expect(verify(proofFor())).toEqual(verify(proofFor()));
  });

  it('accepts the envelope as JSON text', () => {
    expect(verify(JSON.stringify(proofFor())).ok).toBe(true);
  });

  it('states that replay protection is not enforced, and is not an authorization decision', () => {
    const r = verify(proofFor());
    if (!r.ok) throw new Error('setup');
    expect(r.replayProtection).toBe('not_enforced');
    for (const word of ['authorized', 'permitted', 'allowed', 'decision']) expect(word in r).toBe(false);
  });

  it('carries no private key material anywhere in the proof', () => {
    const env = proofFor();
    const d = String(alice.privateKey.export({ format: 'jwk' }).d);
    expect(JSON.stringify(env)).not.toContain(d);
    expect(Buffer.from(env.payload, 'base64url').toString()).not.toContain(d);
    expect(Object.keys(env).sort()).toEqual(['domain', 'keyId', 'payload', 'signature', 'version']);
  });

  it('signs with the proof domain and carries the subject key id', () => {
    const env = proofFor();
    expect(env.domain).toBe('proof');
    expect(env.keyId).toBe(id(alice));
  });
});

describe('signature security', () => {
  it('createProof refuses a private key that does not belong to the grant', () => {
    expect(() => createProof({ privateKey: bob.privateKey, grant: aliceGrant, context: devCtx(), challenge, issuedAt: NOW })).toThrowError(expect.objectContaining({ reason: 'key_mismatch' }));
  });

  it('rejects a proof signed by the wrong private key, however it is labelled', () => {
    const byBob = signRaw(rawDoc(), bob); // claims alice's identity, signed by bob
    expect(codeOf(verify(byBob))).toBe('wrong_subject');
    const forgedId = { ...byBob, keyId: id(alice) }; // bob's signature, alice's key id
    expect(codeOf(verify(forgedId))).toBe('invalid_signature');
    expect(codeOf(verify(signRaw(rawDoc(), outsider)))).toBe('wrong_subject');
  });

  it('rejects a tampered payload', () => {
    const env = proofFor();
    const changed = rawDoc({ target: 'other-service' });
    const forged = { ...env, payload: Buffer.from(JSON.stringify(changed)).toString('base64url') };
    expect(codeOf(verify(forged))).toBe('invalid_signature');
    const flipped = Buffer.from(env.payload, 'base64url');
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    expect(codeOf(verify({ ...env, payload: flipped.toString('base64url') }))).toBe('invalid_signature');
  });

  it('rejects a tampered signature', () => {
    const env = proofFor();
    const sig = Buffer.from(env.signature, 'base64url');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(codeOf(verify({ ...env, signature: sig.toString('base64url') }))).toBe('invalid_signature');
    expect(codeOf(verify({ ...env, signature: proofFor(prodCtx()).signature }))).toBe('invalid_signature');
  });

  it('rejects the wrong signing domain, and relabelling does not help', () => {
    const asGrant = signRaw(rawDoc(), alice, 'grant');
    expect(codeOf(verify(asGrant))).toBe('wrong_domain');
    expect(codeOf(verify(signRaw(rawDoc(), alice, 'revocation')))).toBe('wrong_domain');
    expect(codeOf(verify({ ...asGrant, domain: 'proof' }))).toBe('invalid_signature');
  });

  it('rejects a forged key id that is not the subject key id', () => {
    expect(codeOf(verify({ ...proofFor(), keyId: id(bob) }))).toBe('wrong_subject');
    expect(codeOf(verify({ ...proofFor(), keyId: '0'.repeat(64) }))).toBe('wrong_subject');
    expect(codeOf(verify({ ...proofFor(), keyId: 'nonsense' }))).toBe('malformed_proof');
  });

  it('never takes the verification key from the proof: extra key fields are rejected', () => {
    expect(codeOf(verify({ ...signRaw(rawDoc(), outsider), publicKey: raw(outsider) }))).toBe('malformed_proof');
    expect(codeOf(verify(signRaw(rawDoc({ publicKey: raw(outsider) }), alice)))).toBe('malformed_proof');
  });

  it('requires a verified grant', () => {
    expect(codeOf(verify(proofFor(), devCtx(), challenge, NOW, { ...aliceGrant }))).toBe('grant_unverified');
    expect(codeOf(verify(proofFor(), devCtx(), challenge, NOW, null as unknown as VerifiedGrant))).toBe('grant_unverified');
    expect(codeOf(verify(proofFor(), devCtx(), challenge, NOW, aliceGrant.grant as unknown as VerifiedGrant))).toBe('grant_unverified');
    expect(() => createProof({ privateKey: alice.privateKey, grant: { ...aliceGrant }, context: devCtx(), challenge, issuedAt: NOW })).toThrowError(expect.objectContaining({ reason: 'invalid_grant' }));
  });

  it("rejects another developer's grant: alice's proof does not verify against bob's grant", () => {
    expect(codeOf(verify(proofFor(), devCtx(), challenge, NOW, bobGrant))).toBe('wrong_subject');
    const byBob = createProof({ privateKey: bob.privateKey, grant: bobGrant, context: devCtx(), challenge, issuedAt: NOW });
    expect(verify(byBob, devCtx(), challenge, NOW, bobGrant).ok).toBe(true);
    expect(codeOf(verify(byBob))).toBe('wrong_subject'); // against alice's grant
  });

  it('a proof naming another grant is rejected even when signed by the right key', () => {
    expect(codeOf(verify(signRaw(rawDoc({ grantId: 'grant-bob-001' }))))).toBe('wrong_grant');
    expect(codeOf(verify(signRaw(rawDoc({ subjectId: 'bob' }))))).toBe('wrong_subject');
    expect(codeOf(verify(signRaw(rawDoc({ subjectKeyId: id(bob) }))))).toBe('wrong_subject');
    expect(codeOf(verify(signRaw(rawDoc({ organization: 'globex' }))))).toBe('wrong_organization');
  });

  it('rejects malformed envelopes, and survives hostile ones, without throwing', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    for (const c of [null, undefined, 5, [], 'nope', '{', {}, hostile, 'x'.repeat(2_000_000)]) expect(verify(c).ok).toBe(false);
    expect(codeOf(verify('{'))).toBe('malformed_proof');
    expect(codeOf(verify({ ...proofFor(), payload: '!!' }))).toBe('malformed_proof');
  });

  it('does not parse the payload before the signature: bad JSON signed by another key is a signature problem', () => {
    expect(codeOf(verify(signRaw('{ nope', bob)))).toBe('wrong_subject');
    expect(codeOf(verify(signRaw('{ nope', alice)))).toBe('malformed_proof');
  });
});

describe('action binding', () => {
  const proof = (): ReturnType<typeof proofFor> => proofFor();

  it('rejects a wrong action id and a wrong action type', () => {
    expect(codeOf(verify(proof(), { ...devCtx(), actionId: 'act-999' }))).toBe('wrong_action');
    expect(codeOf(verify(proof(), { ...devCtx(), actionType: 'rollback' }))).toBe('wrong_action');
  });

  it('rejects a wrong environment', () => {
    for (const environment of ['production', 'staging', 'testing'] as const) expect(codeOf(verify(proof(), { ...devCtx(), environment })), environment).toBe('wrong_environment');
  });

  it('rejects a wrong target', () => {
    expect(codeOf(verify(proof(), { ...devCtx(), target: 'billing-service' }))).toBe('wrong_target');
    expect(codeOf(verify(proof(), { ...devCtx(), target: 'payments-service2' }))).toBe('wrong_target');
  });

  it('rejects a wrong Git HEAD, including a single changed character and the missing commit', () => {
    expect(codeOf(verify(proof(), { ...devCtx(), commit: 'c'.repeat(40) }))).toBe('wrong_commit');
    expect(codeOf(verify(proof(), { ...devCtx(), commit: `${'a'.repeat(39)}b` }))).toBe('wrong_commit');
    const noCommit: ActionContext = { ...prodCtx(), commit: null };
    expect(codeOf(verify(proofFor(noCommit), { ...noCommit, commit: 'a'.repeat(40) }))).toBe('wrong_commit');
    expect(codeOf(verify(proofFor(prodCtx()), { ...prodCtx(), commit: null }))).toBe('wrong_commit');
  });

  it('rejects a wrong content digest', () => {
    expect(codeOf(verify(proof(), { ...devCtx(), contentDigest: computeContentDigest(Buffer.from('another change')) }))).toBe('wrong_content');
  });

  it('rejects a wrong challenge, and a signed challenge is not trusted just because it is signed', () => {
    expect(codeOf(verify(proof(), devCtx(), generateChallenge()))).toBe('wrong_challenge');
    // the developer picks their own challenge and signs it: still rejected, the verifier's expected value decides
    const own = generateChallenge();
    expect(codeOf(verify(proofFor(devCtx(), own), devCtx(), challenge))).toBe('wrong_challenge');
    expect(verify(proofFor(devCtx(), own), devCtx(), own).ok).toBe(true);
  });

  it("rejects reusing a proof for another action: every other action's context fails", () => {
    const forDev = proofFor(devCtx());
    expect(codeOf(verify(forDev, prodCtx()))).toMatch(/wrong_action/);
    const sameButProd: ActionContext = { ...devCtx(), environment: 'production' };
    expect(codeOf(verify(forDev, sameButProd))).toBe('wrong_environment');
  });

  it('rejects reusing a proof for another grant', () => {
    expect(codeOf(verify(signRaw(rawDoc({ grantId: 'grant-alice-002' }))))).toBe('wrong_grant');
  });

  it('the signed proof binds every field: changing any one in the signed text breaks it against the real request', () => {
    const fields: Array<[string, unknown, string]> = [
      ['actionId', 'act-777', 'wrong_action'],
      ['actionType', 'deployment', 'wrong_action'],
      ['environment', 'staging', 'wrong_environment'],
      ['target', 'elsewhere', 'wrong_target'],
      ['commit', 'd'.repeat(40), 'wrong_commit'],
      ['contentDigest', computeContentDigest(Buffer.from('x')), 'wrong_content'],
      ['challenge', generateChallenge(), 'wrong_challenge'],
    ];
    for (const [field, value, code] of fields) expect(codeOf(verify(signRaw(rawDoc({ [field]: value })))), field).toBe(code);
  });

  it('refuses an invalid expected context or challenge before looking at the proof', () => {
    expect(codeOf(verify(proof(), { ...devCtx(), commit: null }))).toBe('invalid_expected_context'); // code change needs a commit
    expect(codeOf(verify(proof(), { ...devCtx(), extra: 1 } as unknown as ActionContext))).toBe('invalid_expected_context');
    expect(codeOf(verify(proof(), null as unknown as ActionContext))).toBe('invalid_expected_context');
    expect(codeOf(verify(proof(), devCtx(), 'short'))).toBe('invalid_expected_challenge');
    expect(codeOf(verify(proof(), devCtx(), `${challenge}=`))).toBe('invalid_expected_challenge');
    expect(codeOf(verify(proof(), devCtx(), null as unknown as string))).toBe('invalid_expected_challenge');
  });

  it('failure messages never leak the challenge, digest, target, commit or keys', () => {
    const ctx = { ...devCtx(), target: 'SENTINEL-TARGET' };
    const results = [verify(proof(), ctx), verify(proof(), devCtx(), generateChallenge()), verify(signRaw(rawDoc(), bob))];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        for (const secret of ['SENTINEL', challenge, devCtx().contentDigest, COMMIT, raw(alice)]) expect(r.message).not.toContain(secret);
      }
    }
  });
});

describe('time', () => {
  it('accepts a proof within its five minutes and rejects it from the expiry instant on', () => {
    const env = proofFor();
    expect(verify(env, devCtx(), challenge, at(0)).ok).toBe(true);
    expect(verify(env, devCtx(), challenge, at(299)).ok).toBe(true);
    expect(codeOf(verify(env, devCtx(), challenge, at(300)))).toBe('expired_proof');
    expect(codeOf(verify(env, devCtx(), challenge, at(3600)))).toBe('expired_proof');
  });

  it('rejects a future-issued proof (no clock skew tolerance)', () => {
    const env = proofFor();
    expect(codeOf(verify(env, devCtx(), challenge, at(-1)))).toBe('future_proof');
    expect(codeOf(verify(signRaw(rawDoc({ issuedAt: '2026-06-01T12:10:00Z', expiresAt: '2026-06-01T12:15:00Z' }))))).toBe('future_proof');
  });

  it('rejects an excessive lifetime and accepts exactly the maximum', () => {
    expect(MAX_PROOF_LIFETIME_MS).toBe(300_000);
    expect(codeOf(verify(signRaw(rawDoc({ expiresAt: '2026-06-01T12:05:01Z' }))))).toBe('proof_lifetime_too_long');
    expect(codeOf(verify(signRaw(rawDoc({ expiresAt: '2026-06-01T13:00:00Z' }))))).toBe('proof_lifetime_too_long');
    expect(verify(signRaw(rawDoc({ expiresAt: '2026-06-01T12:05:00Z' }))).ok).toBe(true);
  });

  it('createProof refuses an excessive or tiny lifetime, and honours a shorter one', () => {
    for (const lifetimeMs of [MAX_PROOF_LIFETIME_MS + 1, 0, -1, 999, 1.5, Number.NaN]) {
      expect(() => createProof({ privateKey: alice.privateKey, grant: aliceGrant, context: devCtx(), challenge, issuedAt: NOW, lifetimeMs }), String(lifetimeMs)).toThrowError(expect.objectContaining({ reason: 'invalid_lifetime' }));
    }
    const short = createProof({ privateKey: alice.privateKey, grant: aliceGrant, context: devCtx(), challenge, issuedAt: NOW, lifetimeMs: 60_000 });
    expect(verify(short, devCtx(), challenge, at(59)).ok).toBe(true);
    expect(codeOf(verify(short, devCtx(), challenge, at(60)))).toBe('expired_proof');
  });

  it('rejects a proof that would outlive the grant: the grant expiry is never extended', () => {
    // the grant ends 2026-08-01T00:00:00Z
    const issued = new Date('2026-07-31T23:58:00Z');
    expect(() => createProof({ privateKey: alice.privateKey, grant: aliceGrant, context: devCtx(), challenge, issuedAt: issued })).toThrowError(expect.objectContaining({ reason: 'outside_grant' }));
    const forged = signRaw(rawDoc({ issuedAt: '2026-07-31T23:58:00Z', expiresAt: '2026-08-01T00:03:00Z' }));
    expect(codeOf(verify(forged, devCtx(), challenge, issued))).toBe('proof_outside_grant');
    // inside the grant it is fine
    expect(verify(proofFor(devCtx(), challenge, new Date('2026-07-31T23:50:00Z')), devCtx(), challenge, new Date('2026-07-31T23:50:00Z')).ok).toBe(true);
  });

  it('rejects a proof issued before the grant became valid', () => {
    expect(codeOf(verify(signRaw(rawDoc({ issuedAt: '2026-05-24T00:00:00Z', expiresAt: '2026-05-24T00:05:00Z' }))))).toBe('proof_outside_grant');
    expect(() => proofFor(devCtx(), challenge, new Date('2026-05-24T00:00:00Z'))).toThrowError(expect.objectContaining({ reason: 'outside_grant' }));
  });

  it('refuses to accept anything once the grant itself is not current', () => {
    const env = proofFor();
    expect(codeOf(verify(env, devCtx(), challenge, new Date('2026-08-02T00:00:00Z')))).toBe('grant_not_current');
    expect(codeOf(verify(env, devCtx(), challenge, new Date('2026-05-01T00:00:00Z')))).toBe('grant_not_current');
  });

  it('rejects invalid timestamps and orderings', () => {
    for (const bad of ['tomorrow', '2026-02-31T00:00:00Z', '2026-06-01', '2026-06-01T12:00:00+01:00', 5, null]) {
      expect(codeOf(verify(signRaw(rawDoc({ issuedAt: bad })))), String(bad)).toBe('malformed_proof');
      expect(codeOf(verify(signRaw(rawDoc({ expiresAt: bad })))), String(bad)).toBe('malformed_proof');
    }
    expect(codeOf(verify(signRaw(rawDoc({ expiresAt: '2026-06-01T12:00:00Z' }))))).toBe('malformed_proof');
    expect(codeOf(verify(signRaw(rawDoc({ expiresAt: '2026-06-01T11:00:00Z' }))))).toBe('malformed_proof');
  });

  it('rejects an invalid evaluation time', () => {
    expect(codeOf(verify(proofFor(), devCtx(), challenge, new Date('x')))).toBe('invalid_evaluation_time');
    expect(codeOf(verify(proofFor(), devCtx(), challenge, '2026-06-01' as unknown as Date))).toBe('invalid_evaluation_time');
  });

  it('createProof rejects an invalid issue time', () => {
    expect(() => proofFor(devCtx(), challenge, new Date('x'))).toThrowError(expect.objectContaining({ reason: 'invalid_time' }));
  });
});

describe('input validation', () => {
  const FIELDS = ['version', 'organization', 'grantId', 'subjectId', 'subjectKeyId', 'actionId', 'actionType', 'environment', 'target', 'commit', 'contentDigest', 'challenge', 'issuedAt', 'expiresAt'];

  it('rejects every missing field', () => {
    for (const field of FIELDS) {
      const doc = rawDoc();
      delete doc[field];
      expect(codeOf(verify(signRaw(doc))), field).toMatch(/malformed_proof|unsupported_proof_version/);
    }
  });

  it('rejects extra fields', () => {
    for (const extra of ['publicKey', 'privateKey', 'approval', 'role', 'extra']) expect(codeOf(verify(signRaw(rawDoc({ [extra]: 'x' })))), extra).toBe('malformed_proof');
  });

  it('rejects invalid identifiers', () => {
    const cases: Array<[string, unknown]> = [
      ['organization', 'Bad Org'],
      ['organization', 5],
      ['grantId', 'has space'],
      ['grantId', ''],
      ['subjectId', ''],
      ['subjectId', 'x'.repeat(129)],
      ['subjectKeyId', 'abc'],
      ['subjectKeyId', id(alice).toUpperCase()],
      ['actionId', ''],
      ['actionId', 'has space'],
      ['actionId', 'x'.repeat(129)],
      ['actionId', 5],
      ['target', ''],
      ['target', 'with space'],
      ['target', 'line\nbreak'],
      ['target', '../escape'],
      ['actionType', 'launch'],
      ['actionType', 'Deployment'],
      ['environment', 'prod'],
      ['environment', 5],
      ['commit', 'xyz'],
      ['commit', 'A'.repeat(40)],
      ['commit', 'a'.repeat(39)],
      ['commit', 'a'.repeat(41)],
      ['commit', 5],
    ];
    for (const [field, value] of cases) expect(codeOf(verify(signRaw(rawDoc({ [field]: value })))), `${field}=${String(value)}`).toBe('malformed_proof');
    expect(codeOf(verify(signRaw(rawDoc({ commit: null }))))).toBe('malformed_proof'); // a code change must name a commit
  });

  it('rejects invalid digest encodings', () => {
    const hex = 'a'.repeat(64);
    for (const bad of ['', hex, `sha1:${hex}`, `sha256:${hex.toUpperCase()}`, `sha256:${hex.slice(1)}`, `sha256:${hex}0`, `SHA256:${hex}`, `sha256: ${hex}`, `sha256:${'g'.repeat(64)}`, 5, null]) {
      expect(codeOf(verify(signRaw(rawDoc({ contentDigest: bad })))), String(bad)).toBe('malformed_proof');
    }
  });

  it('rejects invalid challenge lengths and encodings inside a proof', () => {
    const good = generateChallenge();
    for (const bad of ['', 'short', `${good}A`, good.slice(1), `${good}=`, good.replace(/.$/, '!'), 'A'.repeat(44), 5, null]) {
      expect(codeOf(verify(signRaw(rawDoc({ challenge: bad })))), String(bad)).toBe('malformed_proof');
    }
  });

  it('rejects unsupported proof versions', () => {
    for (const version of [0, 2, '1', null, 1.5]) expect(codeOf(verify(signRaw(rawDoc({ version })))), String(version)).toBe('unsupported_proof_version');
    for (const payload of ['[]', 'null', '7', '"x"']) expect(codeOf(verify(signRaw(payload))), payload).toBe('unsupported_proof_version');
  });

  it('createProof rejects bad trusted-side input with a structured, secret-free error', () => {
    const base = { privateKey: alice.privateKey, grant: aliceGrant, context: devCtx(), challenge, issuedAt: NOW };
    expect(() => createProof({ ...base, context: { ...devCtx(), commit: null } })).toThrowError(expect.objectContaining({ reason: 'invalid_context' }));
    expect(() => createProof({ ...base, context: { ...devCtx(), target: 'bad target' } })).toThrowError(expect.objectContaining({ reason: 'invalid_context' }));
    expect(() => createProof({ ...base, context: null as unknown as ActionContext })).toThrowError(expect.objectContaining({ reason: 'invalid_context' }));
    expect(() => createProof({ ...base, challenge: 'weak' })).toThrowError(expect.objectContaining({ reason: 'invalid_challenge' }));
    expect(() => createProof({ ...base, privateKey: alice.publicKey })).toThrowError(expect.objectContaining({ reason: 'invalid_private_key' }));
    expect(() => createProof({ ...base, privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })).toThrowError(expect.objectContaining({ reason: 'invalid_private_key' }));
    expect(() => createProof({ ...base, privateKey: 'key' as unknown as KeyObject })).toThrowError(expect.objectContaining({ reason: 'invalid_private_key' }));
    try {
      createProof({ ...base, privateKey: bob.privateKey });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProofError);
      expect(err).toBeInstanceOf(CodexrevError);
      expect((err as CodexrevError).code).toBe('CODEXREV_AUTHZ_PROOF_ERROR');
      expect((err as Error).message).not.toContain(String(bob.privateKey.export({ format: 'jwk' }).d));
      expect((err as Error).message).not.toContain(raw(bob));
    }
  });

  it('parseActionContext is strict and never throws', () => {
    expect(parseActionContext(devCtx()).ok).toBe(true);
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    for (const bad of [null, undefined, 5, 'x', [], hostile, { ...devCtx(), extra: 1 }, { ...devCtx(), actionType: 'nope' }]) expect(parseActionContext(bad).ok).toBe(false);
    const missing: Record<string, unknown> = { ...devCtx() };
    delete missing.target;
    expect(parseActionContext(missing).ok).toBe(false);
  });
});

describe('challenge generation', () => {
  it('produces 32 random bytes as 43 strict Base64url characters', () => {
    const c = generateChallenge();
    expect(CHALLENGE_BYTES).toBe(32);
    expect(c).toHaveLength(43);
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(c, 'base64url')).toHaveLength(32);
    expect(Buffer.from(c, 'base64url').toString('base64url')).toBe(c);
    expect(isValidChallenge(c)).toBe(true);
  });

  it('differs on every call', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateChallenge()));
    expect(set.size).toBe(200);
  });

  it('is not all zeros, and uses all of its bytes (no obvious fixed pattern)', () => {
    const bytes = Buffer.concat(Array.from({ length: 64 }, () => Buffer.from(generateChallenge(), 'base64url')));
    expect(bytes.some((b) => b !== 0)).toBe(true);
    expect(new Set(bytes).size).toBeGreaterThan(200);
  });

  it('isValidChallenge rejects weak or non-canonical values', () => {
    const c = generateChallenge();
    for (const bad of ['', 'abc', c.slice(1), `${c}A`, `${c}=`, 'A'.repeat(42), 5, null, undefined, {}, ` ${c}`, `${c}\n`]) expect(isValidChallenge(bad), String(bad)).toBe(false);
    // 43 characters whose final character carries non-zero padding bits is a second spelling of the same bytes: refused
    expect(isValidChallenge(`${'A'.repeat(42)}B`)).toBe(false);
    expect(isValidChallenge('A'.repeat(43))).toBe(true);
  });
});

describe('single use is an interface, not an implemented guarantee', () => {
  const verified = (): VerifiedProof => {
    const r = verify(proofFor());
    if (!r.ok) throw new Error('setup');
    return r;
  };

  // A test-only fake. It is NOT durable and exists only to exercise the interface.
  const fakeStore = (): ChallengeStore => {
    const seen = new Set<string>();
    return {
      async consume({ challenge: c }) {
        if (seen.has(c)) return 'already_used';
        seen.add(c);
        return 'consumed';
      },
    };
  };

  it('passes the proof challenge, grant, action and expiry to the store and reports its answer', async () => {
    const calls: unknown[] = [];
    const store: ChallengeStore = { consume: async (entry) => (calls.push(entry), 'consumed') };
    expect(await consumeChallenge(verified(), store)).toBe('consumed');
    expect(calls).toEqual([{ challenge, grantId: 'grant-alice-001', actionId: 'act-001', expiresAt: '2026-06-01T12:05:00Z' }]);
  });

  it('a store can report reuse', async () => {
    const store = fakeStore();
    expect(await consumeChallenge(verified(), store)).toBe('consumed');
    expect(await consumeChallenge(verified(), store)).toBe('already_used');
  });

  it('fails closed: a throwing, rejecting, nonsensical or missing store is "unavailable"', async () => {
    const v = verified();
    expect(await consumeChallenge(v, { consume: () => { throw new Error('disk gone'); } })).toBe('unavailable');
    expect(await consumeChallenge(v, { consume: async () => { throw new Error('db down'); } })).toBe('unavailable');
    expect(await consumeChallenge(v, { consume: async () => 'maybe' as never })).toBe('unavailable');
    expect(await consumeChallenge(v, { consume: async () => undefined as never })).toBe('unavailable');
    expect(await consumeChallenge(v, undefined as unknown as ChallengeStore)).toBe('unavailable');
    expect(await consumeChallenge(v, {} as ChallengeStore)).toBe('unavailable');
  });

  it('refuses to consume anything that is not a verified proof', async () => {
    let called = false;
    const store: ChallengeStore = { consume: async () => ((called = true), 'consumed') };
    expect(await consumeChallenge({ ...verified() }, store)).toBe('unavailable');
    expect(called).toBe(false);
  });

  it('without a store, verification still works but reports replay protection as not enforced', () => {
    const r = verify(proofFor());
    expect(r.ok && r.replayProtection).toBe('not_enforced');
    // the same proof verifies twice: nothing in verifyProof itself prevents reuse within the window
    expect(verify(proofFor()).ok).toBe(true);
    expect(verify(proofFor()).ok).toBe(true);
  });
});
