// Tests for the shared challenge-artifact helpers: the canonical action-context digest, the challenge
// hash and the proof digest. Each is checked against an independent computation of its documented layout.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSnapshotDigest } from '../../../../src/features/action-safety/authorization/actionContextCollector.js';
import {
  ACTION_CONTEXT_DIGEST_DOMAIN,
  CHALLENGE_HASH_DOMAIN,
  ChallengeArtifactError,
  MAX_CHALLENGE_LIFETIME_MS,
  PROOF_DIGEST_DOMAIN,
  computeActionContextDigest,
  computeChallengeHash,
  computeProofDigest,
  isRandomId,
  isRequestId,
  wholeSecondsText,
} from '../../../../src/features/action-safety/authorization/challengeCommon.js';
import { buildSigningInput, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { computeContentDigest, generateChallenge, type ActionContext } from '../../../../src/features/action-safety/authorization/proof.js';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  actionId: 'act-001',
  actionType: 'code_change',
  environment: 'development',
  target: 'payments-service',
  commit: 'a'.repeat(40),
  contentDigest: computeContentDigest(Buffer.from('diff')),
  ...over,
});

const sha = (...parts: Array<string | Buffer>): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return `sha256:${h.digest('hex')}`;
};

describe('the canonical action-context digest', () => {
  it('matches an independent computation of the documented byte layout', () => {
    const c = ctx();
    const expected = sha(
      `${ACTION_CONTEXT_DIGEST_DOMAIN}\n` +
        `actionId=S${c.actionId.length}:${c.actionId}\n` +
        `actionType=S${c.actionType.length}:${c.actionType}\n` +
        `environment=S${c.environment.length}:${c.environment}\n` +
        `target=S${c.target.length}:${c.target}\n` +
        `commit=S40:${c.commit}\n` +
        `contentDigest=S${c.contentDigest.length}:${c.contentDigest}\n`,
    );
    expect(computeActionContextDigest(c)).toBe(expected);
    expect(ACTION_CONTEXT_DIGEST_DOMAIN).toBe('codexrev-action-context-v1');
  });

  it('has the exact sha256 format and is deterministic', () => {
    const d = computeActionContextDigest(ctx());
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeActionContextDigest(ctx())).toBe(d);
    expect(computeActionContextDigest({ ...ctx() })).toBe(d);
  });

  it('encodes a null commit differently from any string, in the documented way', () => {
    const c = ctx({ actionType: 'configuration_change', commit: null });
    const expected = sha(
      `${ACTION_CONTEXT_DIGEST_DOMAIN}\nactionId=S7:act-001\nactionType=S20:configuration_change\nenvironment=S11:development\ntarget=S16:payments-service\ncommit=N\ncontentDigest=S71:${c.contentDigest}\n`,
    );
    expect(computeActionContextDigest(c)).toBe(expected);
    expect(computeActionContextDigest(c)).not.toBe(computeActionContextDigest(ctx({ actionType: 'configuration_change', commit: 'a'.repeat(40) })));
  });

  it('changes when any one of the six fields changes', () => {
    const base = computeActionContextDigest(ctx());
    const variants: Array<Partial<ActionContext>> = [
      { actionId: 'act-002' },
      { actionType: 'deployment' },
      { environment: 'production' },
      { target: 'billing-service' },
      { commit: 'b'.repeat(40) },
      { actionType: 'configuration_change', commit: null }, // a code change must name a commit, so use a type that need not
      { contentDigest: computeContentDigest(Buffer.from('another diff')) },
    ];
    const seen = new Set<string>([base]);
    for (const v of variants) seen.add(computeActionContextDigest(ctx(v)));
    expect(seen.size).toBe(variants.length + 1);
  });

  it('is length-safe: values that would collide under a naive join stay distinct', () => {
    // under a naive "a" + "bc" versus "ab" + "c" join these would be equal
    const a = computeActionContextDigest(ctx({ actionId: 'a', target: 'bc' }));
    const b = computeActionContextDigest(ctx({ actionId: 'ab', target: 'c' }));
    expect(a).not.toBe(b);
  });

  it('is not the Git snapshot digest, and does not depend on it except through the contentDigest field', () => {
    const snapshot = computeSnapshotDigest({ objectFormat: 'sha1', commit: 'a'.repeat(40), tree: 'd'.repeat(40), entries: [] });
    const c = ctx({ contentDigest: snapshot });
    expect(computeActionContextDigest(c)).not.toBe(snapshot);
    expect(ACTION_CONTEXT_DIGEST_DOMAIN).not.toBe('codexrev-git-snapshot-v1');
  });

  it('refuses an invalid context with a fixed message', () => {
    for (const bad of [null, undefined, 5, {}, ctx({ actionId: 'has space' }), ctx({ actionType: 'launch' as never }), { ...ctx(), extra: 1 }, ctx({ commit: null })]) {
      expect(() => computeActionContextDigest(bad as ActionContext), JSON.stringify(bad)).toThrow(ChallengeArtifactError);
    }
    try {
      computeActionContextDigest(ctx({ target: 'SECRET TARGET' }));
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

describe('the challenge hash', () => {
  it('is the domain-separated SHA-256 of the 32 raw bytes', () => {
    const c = generateChallenge();
    expect(computeChallengeHash(c)).toBe(sha(`${CHALLENGE_HASH_DOMAIN}\n`, Buffer.from(c, 'base64url')));
    expect(CHALLENGE_HASH_DOMAIN).toBe('codexrev-challenge-hash-v1');
  });

  it('does not equal a plain hash of the challenge, in either encoding, and differs per challenge', () => {
    const c = generateChallenge();
    const h = computeChallengeHash(c);
    expect(h).not.toBe(sha(Buffer.from(c, 'base64url')));
    expect(h).not.toBe(sha(c));
    expect(computeChallengeHash(generateChallenge())).not.toBe(h);
    expect(computeChallengeHash(c)).toBe(h);
  });

  it('never contains the challenge, and refuses an invalid one without echoing it', () => {
    const c = generateChallenge();
    expect(computeChallengeHash(c)).not.toContain(c);
    for (const bad of ['', 'short', `${c}=`, 5, null, undefined]) expect(() => computeChallengeHash(bad as string)).toThrow(ChallengeArtifactError);
    try {
      computeChallengeHash('SECRET-NOT-A-CHALLENGE');
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

describe('the proof digest', () => {
  const key = generateKeyPairSync('ed25519');
  const proofEnvelope = (payload = '{"a":1}') => signEnvelope({ domain: 'proof', payload: Buffer.from(payload), privateKey: key.privateKey });

  it('covers exactly the signing input plus the signature', () => {
    const env = proofEnvelope();
    const expected = sha(`${PROOF_DIGEST_DOMAIN}\n`, buildSigningInput('proof', Buffer.from(env.payload, 'base64url')), Buffer.from(env.signature, 'base64url'));
    expect(computeProofDigest(env)).toBe(expected);
    expect(PROOF_DIGEST_DOMAIN).toBe('codexrev-proof-digest-v1');
  });

  it('accepts the envelope as JSON text, and differs per proof', () => {
    const a = proofEnvelope('{"a":1}');
    const b = proofEnvelope('{"a":2}');
    expect(computeProofDigest(JSON.stringify(a))).toBe(computeProofDigest(a));
    expect(computeProofDigest(a)).not.toBe(computeProofDigest(b));
    expect(computeProofDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when the payload or the signature changes', () => {
    const env = proofEnvelope();
    const sig = Buffer.from(env.signature, 'base64url');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(computeProofDigest({ ...env, signature: sig.toString('base64url') })).not.toBe(computeProofDigest(env));
    expect(computeProofDigest({ ...env, payload: Buffer.from('{"a":3}').toString('base64url') })).not.toBe(computeProofDigest(env));
  });

  it('refuses anything that is not a well-formed PROOF envelope', () => {
    const env = proofEnvelope();
    const other = signEnvelope({ domain: 'grant', payload: Buffer.from('{}'), privateKey: key.privateKey });
    const bad: unknown[] = [null, undefined, 5, 'nope', '{', {}, [], other, { ...env, extra: 1 }, { ...env, version: 2 }, { ...env, payload: '!!' }, { ...env, signature: 'AAAA' }, { ...env, payload: '' }, 'x'.repeat(2_000_000)];
    for (const [i, b] of bad.entries()) expect(() => computeProofDigest(b), `input ${i}`).toThrow(ChallengeArtifactError);
  });
});

describe('identifier shapes and small helpers', () => {
  it('accepts only canonical 16-byte random ids and 16–48 byte request ids', () => {
    const id = Buffer.alloc(16, 7).toString('base64url');
    expect(isRandomId(id)).toBe(true);
    for (const bad of ['', 'short', `${id}=`, `${id}A`, 'A'.repeat(21), 5, null, Buffer.alloc(17).toString('base64url'), 'AAAAAAAAAAAAAAAAAAAAAB']) {
      expect(isRandomId(bad), String(bad)).toBe(false);
    }
    expect(isRequestId(Buffer.alloc(16, 1).toString('base64url'))).toBe(true);
    expect(isRequestId(Buffer.alloc(48, 1).toString('base64url'))).toBe(true);
    for (const bad of ['', 'short', Buffer.alloc(15).toString('base64url'), Buffer.alloc(49).toString('base64url'), 5, null, 'has space has space has space']) {
      expect(isRequestId(bad), String(bad)).toBe(false);
    }
  });

  it('formats times as whole seconds in the strict form, and bounds the lifetime at ten minutes', () => {
    expect(wholeSecondsText(Date.UTC(2026, 5, 1, 12, 0, 0, 999))).toBe('2026-06-01T12:00:00Z');
    expect(MAX_CHALLENGE_LIFETIME_MS).toBe(600_000);
  });
});
