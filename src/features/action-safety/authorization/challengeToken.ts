/**
 * Signed challenge tokens.
 *
 * A challenge token is a challenge store's signed statement: "I issued this challenge to this
 * requester, for this one action, until this time." It is signed under the `challenge` domain by a key
 * the administrator trust root trusts for the `challenge_store` purpose. A client verifies it OFFLINE
 * against that trust root, so a challenge the developer made up (or one from an unknown signer) is
 * refused before any store is contacted. This replaces "whatever challenge the caller passes in".
 *
 * WHAT A VERIFIED TOKEN MEANS: a trusted store key signed these exact fields. It does NOT mean the
 * challenge has not been used (a token cannot say that; only shared, trusted state can: see the
 * consumption receipt and the later store), that the requester is authorized, or that the issuing
 * clock is right. The trust root has no key-to-store mapping, so any `challenge_store` key could
 * CLAIM any store id: pass `signingKeyId` (the key a future registry maps to the store) to close
 * that. The verifier applies no clock-skew tolerance; trusted-time handling is a later phase.
 *
 * PAYLOAD (version 1), exactly these fields, signed as UTF-8 JSON in this fixed order:
 *   version, organization, storeId, storeGeneration, challengeId, challenge, grantId, subjectId,
 *   subjectKeyId, contextDigest, issuedAt, expiresAt
 *  - challengeId: 16 random bytes (22 Base64url characters), unique per challenge, assigned by the store
 *  - challenge:   32 cryptographically random bytes (strict Base64url), the value the developer signs
 *                 into the proof; it is secret-like until used, so errors and receipts never echo it
 *  - contextDigest: computeActionContextDigest of the exact six-field action context
 *  - issuedAt / expiresAt: STORE time, strict UTC; the lifetime may not exceed MAX_CHALLENGE_LIFETIME_MS
 *
 * Verified tokens are branded and deeply immutable. A plain object, a copy or a JSON clone is not one.
 * Signing helpers take a private key for isolated tests and a future trusted service. This module
 * generates and stores no key.
 */

import { KeyObject, randomBytes } from 'node:crypto';
import { signEnvelope } from './envelope.js';
import { GRANT_ID_PATTERN, SUBJECT_ID_PATTERN } from './grant.js';
import { ARTIFACT_MESSAGES, verifyTrustedEnvelope, type ArtifactFailureCode } from './signedArtifact.js';
import { ORGANIZATION_ID, hasExactFields, isPlainObject, parseUtcTimestamp, type TrustRoot } from './trustRoot.js';
import { isValidChallenge, generateChallenge, parseActionContext, type ActionContext } from './proof.js';
import type { KeyId, SignedEnvelope } from './types.js';
import {
  ChallengeArtifactError,
  GENERATION_ID_PATTERN,
  KEY_ID_PATTERN,
  MAX_CHALLENGE_LIFETIME_MS,
  SHA256_DIGEST_PATTERN,
  STORE_ID_PATTERN,
  computeActionContextDigest,
  isRandomId,
  wholeSecondsText,
} from './challengeCommon.js';

export const CHALLENGE_TOKEN_VERSION = 1 as const;

export interface ChallengeTokenDocument {
  readonly version: typeof CHALLENGE_TOKEN_VERSION;
  readonly organization: string;
  readonly storeId: string;
  readonly storeGeneration: string;
  readonly challengeId: string;
  /** the secret-like value the requester signs into the proof */
  readonly challenge: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: KeyId;
  readonly contextDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const TOKEN_FIELDS = ['version', 'organization', 'storeId', 'storeGeneration', 'challengeId', 'challenge', 'grantId', 'subjectId', 'subjectKeyId', 'contextDigest', 'issuedAt', 'expiresAt'] as const;

class SchemaError extends Error {}
const bad = (path: string, why: string): never => {
  throw new SchemaError(`${path} ${why}`);
};

function buildToken(value: unknown): ChallengeTokenDocument {
  if (!isPlainObject(value) || !hasExactFields(value, TOKEN_FIELDS)) return bad('token', 'has missing or unexpected fields');
  const { organization, storeId, storeGeneration, challengeId, challenge, grantId, subjectId, subjectKeyId, contextDigest, issuedAt, expiresAt } = value;
  if (typeof organization !== 'string' || !ORGANIZATION_ID.test(organization)) return bad('token.organization', 'is invalid');
  if (typeof storeId !== 'string' || !STORE_ID_PATTERN.test(storeId)) return bad('token.storeId', 'is invalid');
  if (typeof storeGeneration !== 'string' || !GENERATION_ID_PATTERN.test(storeGeneration)) return bad('token.storeGeneration', 'is invalid');
  if (!isRandomId(challengeId)) return bad('token.challengeId', 'must be 16 random bytes as strict Base64url');
  if (!isValidChallenge(challenge)) return bad('token.challenge', 'must be 32 random bytes as strict Base64url');
  if (typeof grantId !== 'string' || !GRANT_ID_PATTERN.test(grantId)) return bad('token.grantId', 'is invalid');
  if (typeof subjectId !== 'string' || !SUBJECT_ID_PATTERN.test(subjectId)) return bad('token.subjectId', 'is invalid');
  if (typeof subjectKeyId !== 'string' || !KEY_ID_PATTERN.test(subjectKeyId)) return bad('token.subjectKeyId', 'is invalid');
  if (typeof contextDigest !== 'string' || !SHA256_DIGEST_PATTERN.test(contextDigest)) return bad('token.contextDigest', 'must be sha256: followed by 64 lowercase hex characters');
  const issued = parseUtcTimestamp(issuedAt);
  const expires = parseUtcTimestamp(expiresAt);
  if (issued === null || expires === null) return bad('token times', 'must be valid UTC timestamps');
  if (!(issued < expires)) return bad('token times', 'must satisfy issuedAt < expiresAt');
  return Object.freeze({
    version: CHALLENGE_TOKEN_VERSION,
    organization,
    storeId,
    storeGeneration,
    challengeId,
    challenge,
    grantId,
    subjectId,
    subjectKeyId,
    contextDigest,
    issuedAt: issuedAt as string,
    expiresAt: expiresAt as string,
  });
}

/** The exact bytes that are signed: fixed field order, so the same token is always the same bytes. */
function serialize(d: ChallengeTokenDocument): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: d.version,
      organization: d.organization,
      storeId: d.storeId,
      storeGeneration: d.storeGeneration,
      challengeId: d.challengeId,
      challenge: d.challenge,
      grantId: d.grantId,
      subjectId: d.subjectId,
      subjectKeyId: d.subjectKeyId,
      contextDigest: d.contextDigest,
      issuedAt: d.issuedAt,
      expiresAt: d.expiresAt,
    }),
    'utf-8',
  );
}

// ---------------------------------------------------------------- creating (trusted service side)

export interface CreateChallengeTokenParams {
  /** the store's Ed25519 private key. For isolated tests and a future trusted service only. */
  readonly privateKey: KeyObject;
  readonly organization: string;
  readonly storeId: string;
  readonly storeGeneration: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: string;
  /** the exact action the challenge is for */
  readonly context: ActionContext;
  /** the STORE's time of issue */
  readonly issuedAt: Date;
  /** defaults to, and may not exceed, MAX_CHALLENGE_LIFETIME_MS */
  readonly lifetimeMs?: number;
}

/**
 * Signs a challenge token. The 32-byte challenge and the 16-byte challenge id are generated HERE from
 * the system's secure random source: the caller cannot choose them. Throws ChallengeArtifactError for
 * bad trusted-side input; the message never contains key material or the challenge.
 */
export function createChallengeToken(params: CreateChallengeTokenParams): SignedEnvelope {
  const { privateKey, issuedAt } = params;
  if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new ChallengeArtifactError('invalid_private_key', 'expected an Ed25519 private key');
  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) throw new ChallengeArtifactError('invalid_time', 'the issue time is not a valid date');
  const lifetime = params.lifetimeMs ?? MAX_CHALLENGE_LIFETIME_MS;
  if (typeof lifetime !== 'number' || !Number.isInteger(lifetime) || lifetime < 1000 || lifetime > MAX_CHALLENGE_LIFETIME_MS) {
    throw new ChallengeArtifactError('invalid_lifetime', 'the challenge lifetime must be a whole number of milliseconds from 1000 up to the maximum');
  }
  const contextDigest = computeActionContextDigest(params.context);
  const start = Math.floor(issuedAt.getTime() / 1000) * 1000;
  let doc: ChallengeTokenDocument;
  try {
    doc = buildToken({
      version: CHALLENGE_TOKEN_VERSION,
      organization: params.organization,
      storeId: params.storeId,
      storeGeneration: params.storeGeneration,
      challengeId: randomBytes(16).toString('base64url'),
      challenge: generateChallenge(),
      grantId: params.grantId,
      subjectId: params.subjectId,
      subjectKeyId: params.subjectKeyId,
      contextDigest,
      issuedAt: wholeSecondsText(start),
      expiresAt: wholeSecondsText(start + lifetime),
    });
  } catch {
    throw new ChallengeArtifactError('invalid_identifier', 'an identifier in the challenge token is invalid');
  }
  return signEnvelope({ domain: 'challenge', payload: serialize(doc), privateKey });
}

// ---------------------------------------------------------------- verifying (client side)

export type ChallengeTokenFailureCode =
  | ArtifactFailureCode
  | 'invalid_expected'
  | 'unsupported_token_version'
  | 'token_invalid'
  | 'organization_mismatch'
  | 'store_mismatch'
  | 'store_generation_mismatch'
  | 'signing_key_mismatch'
  | 'grant_mismatch'
  | 'subject_mismatch'
  | 'context_mismatch'
  | 'lifetime_exceeds_maximum'
  | 'token_not_yet_valid'
  | 'token_expired';

const MESSAGES: Readonly<Record<ChallengeTokenFailureCode, string>> = {
  ...ARTIFACT_MESSAGES,
  invalid_expected: 'the expected store, requester or action context is invalid',
  unsupported_token_version: 'the challenge token format version is not supported',
  token_invalid: 'the challenge token is invalid',
  organization_mismatch: 'the challenge token belongs to a different organization than the trust root',
  store_mismatch: 'the challenge token was issued by a different store than expected',
  store_generation_mismatch: 'the challenge token was issued by a different store generation than expected',
  signing_key_mismatch: 'the challenge token was signed by a different store key than expected',
  grant_mismatch: 'the challenge token was issued for a different grant',
  subject_mismatch: 'the challenge token was issued for a different subject or key',
  context_mismatch: 'the challenge token was issued for a different action',
  lifetime_exceeds_maximum: 'the challenge token lifetime exceeds the supported maximum',
  token_not_yet_valid: 'the challenge token is not valid yet',
  token_expired: 'the challenge token has expired',
};

export interface ChallengeTokenFailure {
  readonly ok: false;
  readonly code: ChallengeTokenFailureCode;
  /** fixed text; for token_invalid it also names the (code-defined) location. Never the challenge. */
  readonly message: string;
  readonly envelopeCode?: string;
}

const failure = (code: ChallengeTokenFailureCode, detail?: string, envelopeCode?: string): ChallengeTokenFailure => ({
  ok: false,
  code,
  message: detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code],
  ...(envelopeCode ? { envelopeCode } : {}),
});

/** What the verifier expects, from sources independent of the token. */
export interface ExpectedChallenge {
  readonly storeId: string;
  /** if given, the token's store generation must equal it */
  readonly storeGeneration?: string;
  /** the key a registry maps to this store. Without it any `challenge_store` key could claim any store id. */
  readonly signingKeyId?: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: string;
  readonly context: ActionContext;
}

export interface VerifiedChallengeToken {
  readonly ok: true;
  readonly token: ChallengeTokenDocument;
  /** the trust-root key that signed it */
  readonly signingKeyId: KeyId;
}

export type ChallengeTokenResult = VerifiedChallengeToken | ChallengeTokenFailure;

const verifiedTokens = new WeakSet<object>();
/** True only for a result of a successful verifyChallengeToken. A plain object, a copy or a JSON clone is not one. */
export const isVerifiedChallengeToken = (x: unknown): x is VerifiedChallengeToken => typeof x === 'object' && x !== null && verifiedTokens.has(x);

/**
 * Verifies a signed challenge token (envelope object or JSON text) against a validated trust root, the
 * requester and action it must be for, and an injected time. Never throws. Order: the signature and the
 * signer's `challenge_store` purpose first; only then is the payload read.
 */
export function verifyChallengeToken(input: unknown, trustRoot: TrustRoot, expected: ExpectedChallenge, now: Date): ChallengeTokenResult {
  try {
    return verifyUnchecked(input, trustRoot, expected, now);
  } catch {
    return failure('signature_verification_failed');
  }
}

function verifyUnchecked(input: unknown, trustRoot: TrustRoot, expected: ExpectedChallenge, now: Date): ChallengeTokenResult {
  if (!isPlainObject(expected)) return failure('invalid_expected');
  const ctx = parseActionContext(expected.context);
  if (
    typeof expected.storeId !== 'string' || !STORE_ID_PATTERN.test(expected.storeId) ||
    (expected.storeGeneration !== undefined && (typeof expected.storeGeneration !== 'string' || !GENERATION_ID_PATTERN.test(expected.storeGeneration))) ||
    (expected.signingKeyId !== undefined && (typeof expected.signingKeyId !== 'string' || !KEY_ID_PATTERN.test(expected.signingKeyId))) ||
    typeof expected.grantId !== 'string' || !GRANT_ID_PATTERN.test(expected.grantId) ||
    typeof expected.subjectId !== 'string' || !SUBJECT_ID_PATTERN.test(expected.subjectId) ||
    typeof expected.subjectKeyId !== 'string' || !KEY_ID_PATTERN.test(expected.subjectKeyId) ||
    !ctx.ok
  ) {
    return failure('invalid_expected');
  }

  const artifact = verifyTrustedEnvelope(input, 'challenge', 'challenge_store', trustRoot, now);
  if (!artifact.ok) return failure(artifact.code, undefined, artifact.envelopeCode);

  // only now is the payload interpreted
  const raw = artifact.value;
  if (!isPlainObject(raw) || raw.version !== CHALLENGE_TOKEN_VERSION) return failure('unsupported_token_version');
  let token: ChallengeTokenDocument;
  try {
    token = buildToken(raw);
  } catch (err) {
    return failure('token_invalid', err instanceof SchemaError ? err.message : undefined);
  }

  if (token.organization !== trustRoot.organization) return failure('organization_mismatch');
  if (expected.signingKeyId !== undefined && artifact.signingKeyId !== expected.signingKeyId) return failure('signing_key_mismatch');
  if (token.storeId !== expected.storeId) return failure('store_mismatch');
  if (expected.storeGeneration !== undefined && token.storeGeneration !== expected.storeGeneration) return failure('store_generation_mismatch');
  if (token.grantId !== expected.grantId) return failure('grant_mismatch');
  if (token.subjectId !== expected.subjectId || token.subjectKeyId !== expected.subjectKeyId) return failure('subject_mismatch');
  if (token.contextDigest !== computeActionContextDigest(ctx.context)) return failure('context_mismatch');

  const issued = parseUtcTimestamp(token.issuedAt) as number;
  const expires = parseUtcTimestamp(token.expiresAt) as number;
  if (expires - issued > MAX_CHALLENGE_LIFETIME_MS) return failure('lifetime_exceeds_maximum');
  const t = now.getTime();
  if (t < issued) return failure('token_not_yet_valid');
  if (t >= expires) return failure('token_expired');

  const result: VerifiedChallengeToken = Object.freeze({ ok: true as const, token, signingKeyId: artifact.signingKeyId });
  verifiedTokens.add(result);
  return result;
}
