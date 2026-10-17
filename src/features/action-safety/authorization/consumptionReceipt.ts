/**
 * Signed consumption receipts.
 *
 * A receipt is a challenge store's signed statement: "I recorded the consumption of this challenge, for
 * this grant and subject, for this exact action, in answer to this request." It is signed under the
 * `receipt` domain (a different domain from the challenge token, so a signature for one never verifies
 * as the other) by a key the administrator trust root trusts for the `challenge_store` purpose.
 *
 * WHAT A VERIFIED RECEIPT MEANS: a trusted store key attests that consumption was recorded, and every
 * bound field equals what the verifier independently expected. It is NOT proof that an action
 * executed, NOT proof that the action is authorized (grants and proofs are verified
 * elsewhere), and NOT a guarantee that an executor which does not check it will not accept the same
 * receipt twice: the receipt id and the optional sequence let an executor that KEEPS state detect
 * duplicates, nothing more. The verifier applies no clock-skew tolerance; trusted-time handling is a
 * later phase.
 *
 * NO LEAKAGE. The receipt carries a domain-separated HASH of the challenge, never the challenge. The
 * verified receipt, and every error, omit the challenge, the proof and the signature.
 *
 * PAYLOAD (version 1), exactly these fields (plus `sequence` when present), signed as UTF-8 JSON in
 * this fixed order:
 *   version, organization, storeId, storeGeneration, receiptId, challengeId, challengeHash, grantId,
 *   subjectId, subjectKeyId, contextDigest, proofDigest, requestId, issuedAt, consumedAt, expiresAt,
 *   [sequence]
 *  - receiptId:     16 random bytes (22 Base64url characters), unique per receipt
 *  - challengeHash: computeChallengeHash(challenge)
 *  - contextDigest: computeActionContextDigest of the exact six-field action context
 *  - proofDigest:   computeProofDigest of the signed proof envelope
 *  - requestId:     the requester's idempotency key (16 to 48 random bytes, Base64url)
 *  - issuedAt, expiresAt: the challenge's STORE issue time and expiry, equal to the token's
 *  - consumedAt:    STORE time of consumption; issuedAt <= consumedAt < expiresAt
 *  - sequence:      OPTIONAL positive integer. Meaning, exactly: assigned by the store at the moment
 *                   of consumption; strictly greater than the sequence of every receipt the SAME
 *                   (storeId, storeGeneration) issued earlier; unique within that pair; gaps allowed;
 *                   restarts only with a new storeGeneration. One receipt alone cannot show ordering:
 *                   an executor that records the highest sequence per (storeId, storeGeneration) can
 *                   notice a repeat or a drop (for example after a database rollback), but cannot
 *                   prove it has seen every receipt.
 */

import { KeyObject, randomBytes } from 'node:crypto';
import { signEnvelope } from './envelope.js';
import { GRANT_ID_PATTERN, SUBJECT_ID_PATTERN } from './grant.js';
import { ARTIFACT_MESSAGES, verifyTrustedEnvelope, type ArtifactFailureCode } from './signedArtifact.js';
import { ORGANIZATION_ID, hasExactFields, isPlainObject, parseUtcTimestamp, type TrustRoot } from './trustRoot.js';
import { parseActionContext, type ActionContext } from './proof.js';
import { isVerifiedChallengeToken, type VerifiedChallengeToken } from './challengeToken.js';
import type { KeyId, SignedEnvelope } from './types.js';
import {
  ChallengeArtifactError,
  GENERATION_ID_PATTERN,
  KEY_ID_PATTERN,
  MAX_CHALLENGE_LIFETIME_MS,
  SHA256_DIGEST_PATTERN,
  STORE_ID_PATTERN,
  computeActionContextDigest,
  computeChallengeHash,
  computeProofDigest,
  isRandomId,
  isRequestId,
  wholeSecondsText,
} from './challengeCommon.js';

export const CONSUMPTION_RECEIPT_VERSION = 1 as const;

export interface ConsumptionReceiptDocument {
  readonly version: typeof CONSUMPTION_RECEIPT_VERSION;
  readonly organization: string;
  readonly storeId: string;
  readonly storeGeneration: string;
  readonly receiptId: string;
  readonly challengeId: string;
  /** hash of the challenge: the challenge itself is never in a receipt */
  readonly challengeHash: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: KeyId;
  readonly contextDigest: string;
  readonly proofDigest: string;
  readonly requestId: string;
  readonly issuedAt: string;
  readonly consumedAt: string;
  readonly expiresAt: string;
  /** see the file header for the exact ordering semantics */
  readonly sequence?: number;
}

const REQUIRED_FIELDS = [
  'version', 'organization', 'storeId', 'storeGeneration', 'receiptId', 'challengeId', 'challengeHash', 'grantId', 'subjectId', 'subjectKeyId',
  'contextDigest', 'proofDigest', 'requestId', 'issuedAt', 'consumedAt', 'expiresAt',
] as const;

class SchemaError extends Error {}
const bad = (path: string, why: string): never => {
  throw new SchemaError(`${path} ${why}`);
};

function buildReceipt(value: unknown): ConsumptionReceiptDocument {
  if (!isPlainObject(value)) return bad('receipt', 'must be an object');
  const hasSequence = Object.prototype.hasOwnProperty.call(value, 'sequence');
  if (!hasExactFields(value, hasSequence ? [...REQUIRED_FIELDS, 'sequence'] : REQUIRED_FIELDS)) return bad('receipt', 'has missing or unexpected fields');
  const v = value;
  if (typeof v.organization !== 'string' || !ORGANIZATION_ID.test(v.organization)) return bad('receipt.organization', 'is invalid');
  if (typeof v.storeId !== 'string' || !STORE_ID_PATTERN.test(v.storeId)) return bad('receipt.storeId', 'is invalid');
  if (typeof v.storeGeneration !== 'string' || !GENERATION_ID_PATTERN.test(v.storeGeneration)) return bad('receipt.storeGeneration', 'is invalid');
  if (!isRandomId(v.receiptId)) return bad('receipt.receiptId', 'must be 16 random bytes as strict Base64url');
  if (!isRandomId(v.challengeId)) return bad('receipt.challengeId', 'must be 16 random bytes as strict Base64url');
  if (typeof v.challengeHash !== 'string' || !SHA256_DIGEST_PATTERN.test(v.challengeHash)) return bad('receipt.challengeHash', 'must be sha256: followed by 64 lowercase hex characters');
  if (typeof v.grantId !== 'string' || !GRANT_ID_PATTERN.test(v.grantId)) return bad('receipt.grantId', 'is invalid');
  if (typeof v.subjectId !== 'string' || !SUBJECT_ID_PATTERN.test(v.subjectId)) return bad('receipt.subjectId', 'is invalid');
  if (typeof v.subjectKeyId !== 'string' || !KEY_ID_PATTERN.test(v.subjectKeyId)) return bad('receipt.subjectKeyId', 'is invalid');
  if (typeof v.contextDigest !== 'string' || !SHA256_DIGEST_PATTERN.test(v.contextDigest)) return bad('receipt.contextDigest', 'must be sha256: followed by 64 lowercase hex characters');
  if (typeof v.proofDigest !== 'string' || !SHA256_DIGEST_PATTERN.test(v.proofDigest)) return bad('receipt.proofDigest', 'must be sha256: followed by 64 lowercase hex characters');
  if (!isRequestId(v.requestId)) return bad('receipt.requestId', 'must be a Base64url idempotency key of 16 to 48 bytes');
  const issued = parseUtcTimestamp(v.issuedAt);
  const consumed = parseUtcTimestamp(v.consumedAt);
  const expires = parseUtcTimestamp(v.expiresAt);
  if (issued === null || consumed === null || expires === null) return bad('receipt times', 'must be valid UTC timestamps');
  if (!(issued <= consumed && consumed < expires)) return bad('receipt times', 'must satisfy issuedAt <= consumedAt < expiresAt');
  if (expires - issued > MAX_CHALLENGE_LIFETIME_MS) return bad('receipt times', 'span longer than the supported maximum');
  if (hasSequence && (typeof v.sequence !== 'number' || !Number.isSafeInteger(v.sequence) || v.sequence < 1)) return bad('receipt.sequence', 'must be a positive whole number');
  return Object.freeze({
    version: CONSUMPTION_RECEIPT_VERSION,
    organization: v.organization,
    storeId: v.storeId,
    storeGeneration: v.storeGeneration,
    receiptId: v.receiptId,
    challengeId: v.challengeId,
    challengeHash: v.challengeHash,
    grantId: v.grantId,
    subjectId: v.subjectId,
    subjectKeyId: v.subjectKeyId,
    contextDigest: v.contextDigest,
    proofDigest: v.proofDigest,
    requestId: v.requestId,
    issuedAt: v.issuedAt as string,
    consumedAt: v.consumedAt as string,
    expiresAt: v.expiresAt as string,
    ...(hasSequence ? { sequence: v.sequence as number } : {}),
  });
}

function serialize(d: ConsumptionReceiptDocument): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: d.version,
      organization: d.organization,
      storeId: d.storeId,
      storeGeneration: d.storeGeneration,
      receiptId: d.receiptId,
      challengeId: d.challengeId,
      challengeHash: d.challengeHash,
      grantId: d.grantId,
      subjectId: d.subjectId,
      subjectKeyId: d.subjectKeyId,
      contextDigest: d.contextDigest,
      proofDigest: d.proofDigest,
      requestId: d.requestId,
      issuedAt: d.issuedAt,
      consumedAt: d.consumedAt,
      expiresAt: d.expiresAt,
      ...(d.sequence !== undefined ? { sequence: d.sequence } : {}),
    }),
    'utf-8',
  );
}

// ---------------------------------------------------------------- creating (trusted service side)

export interface CreateConsumptionReceiptParams {
  /** the store's Ed25519 private key. For isolated tests and a future trusted service only. */
  readonly privateKey: KeyObject;
  readonly organization: string;
  readonly storeId: string;
  readonly storeGeneration: string;
  readonly challengeId: string;
  /** the challenge: it is only HASHED into the receipt and never stored in it */
  readonly challenge: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: string;
  readonly context: ActionContext;
  /** the signed proof envelope that was presented */
  readonly proof: unknown;
  readonly requestId: string;
  /** the challenge's store issue time and expiry, and the store time of consumption */
  readonly challengeIssuedAt: Date;
  readonly challengeExpiresAt: Date;
  readonly consumedAt: Date;
  /** optional; see the file header for its exact semantics */
  readonly sequence?: number;
}

/** Signs a consumption receipt. A fresh random receipt id is generated here. Throws ChallengeArtifactError for bad trusted-side input. */
export function createConsumptionReceipt(params: CreateConsumptionReceiptParams): SignedEnvelope {
  const { privateKey } = params;
  if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new ChallengeArtifactError('invalid_private_key', 'expected an Ed25519 private key');
  for (const d of [params.challengeIssuedAt, params.challengeExpiresAt, params.consumedAt]) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new ChallengeArtifactError('invalid_time', 'a receipt time is not a valid date');
  }
  if (params.sequence !== undefined && (typeof params.sequence !== 'number' || !Number.isSafeInteger(params.sequence) || params.sequence < 1)) {
    throw new ChallengeArtifactError('invalid_sequence', 'the sequence must be a positive whole number');
  }
  const contextDigest = computeActionContextDigest(params.context);
  const challengeHash = computeChallengeHash(params.challenge);
  const proofDigest = computeProofDigest(params.proof);
  let doc: ConsumptionReceiptDocument;
  try {
    doc = buildReceipt({
      version: CONSUMPTION_RECEIPT_VERSION,
      organization: params.organization,
      storeId: params.storeId,
      storeGeneration: params.storeGeneration,
      receiptId: randomBytes(16).toString('base64url'),
      challengeId: params.challengeId,
      challengeHash,
      grantId: params.grantId,
      subjectId: params.subjectId,
      subjectKeyId: params.subjectKeyId,
      contextDigest,
      proofDigest,
      requestId: params.requestId,
      issuedAt: wholeSecondsText(params.challengeIssuedAt.getTime()),
      consumedAt: wholeSecondsText(params.consumedAt.getTime()),
      expiresAt: wholeSecondsText(params.challengeExpiresAt.getTime()),
      ...(params.sequence !== undefined ? { sequence: params.sequence } : {}),
    });
  } catch (err) {
    throw new ChallengeArtifactError(err instanceof SchemaError && /times/.test(err.message) ? 'invalid_time' : 'invalid_identifier', 'a field of the consumption receipt is invalid');
  }
  return signEnvelope({ domain: 'receipt', payload: serialize(doc), privateKey });
}

// ---------------------------------------------------------------- verifying (client or executor side)

export type ReceiptFailureCode =
  | ArtifactFailureCode
  | 'invalid_expected'
  | 'unsupported_receipt_version'
  | 'receipt_invalid'
  | 'organization_mismatch'
  | 'store_mismatch'
  | 'store_generation_mismatch'
  | 'signing_key_mismatch'
  | 'challenge_mismatch'
  | 'grant_mismatch'
  | 'subject_mismatch'
  | 'context_mismatch'
  | 'proof_mismatch'
  | 'request_mismatch'
  | 'time_mismatch'
  | 'consumed_in_future';

const MESSAGES: Readonly<Record<ReceiptFailureCode, string>> = {
  ...ARTIFACT_MESSAGES,
  invalid_expected: 'the expected token, action context, proof or request id is invalid',
  unsupported_receipt_version: 'the consumption receipt format version is not supported',
  receipt_invalid: 'the consumption receipt is invalid',
  organization_mismatch: 'the consumption receipt belongs to a different organization than the trust root',
  store_mismatch: 'the consumption receipt was issued by a different store than the challenge token',
  store_generation_mismatch: 'the consumption receipt was issued by a different store generation than the challenge token',
  signing_key_mismatch: 'the consumption receipt was signed by a different key than the challenge token',
  challenge_mismatch: 'the consumption receipt is for a different challenge',
  grant_mismatch: 'the consumption receipt is for a different grant',
  subject_mismatch: 'the consumption receipt is for a different subject or key',
  context_mismatch: 'the consumption receipt is for a different action',
  proof_mismatch: 'the consumption receipt is for a different proof',
  request_mismatch: 'the consumption receipt answers a different request',
  time_mismatch: 'the consumption receipt times differ from the challenge token times',
  consumed_in_future: 'the consumption receipt says the challenge was consumed in the future',
};

export interface ConsumptionReceiptFailure {
  readonly ok: false;
  readonly code: ReceiptFailureCode;
  /** fixed text: never the challenge, the proof, a signature or a key */
  readonly message: string;
  readonly envelopeCode?: string;
}

const failure = (code: ReceiptFailureCode, detail?: string, envelopeCode?: string): ConsumptionReceiptFailure => ({
  ok: false,
  code,
  message: detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code],
  ...(envelopeCode ? { envelopeCode } : {}),
});

/** What the verifier expects, taken from independent, already verified sources. */
export interface ExpectedReceipt {
  /** the VERIFIED token the challenge came from: store, generation, challenge, grant, subject, key and times are taken from it */
  readonly token: VerifiedChallengeToken;
  /** the exact action context the consumption must be for */
  readonly context: ActionContext;
  /** the signed proof envelope that was presented for consumption */
  readonly proof: unknown;
  /** the idempotency key the requester used */
  readonly requestId: string;
  /** the key a registry maps to this store, when known */
  readonly signingKeyId?: string;
}

export interface VerifiedConsumptionReceipt {
  readonly ok: true;
  /** the receipt fields. There is no challenge here, only its hash. */
  readonly receipt: ConsumptionReceiptDocument;
  readonly signingKeyId: KeyId;
}

export type ConsumptionReceiptResult = VerifiedConsumptionReceipt | ConsumptionReceiptFailure;

const verifiedReceipts = new WeakSet<object>();
/** True only for a result of a successful verifyConsumptionReceipt. A plain object, a copy or a JSON clone is not one. */
export const isVerifiedConsumptionReceipt = (x: unknown): x is VerifiedConsumptionReceipt => typeof x === 'object' && x !== null && verifiedReceipts.has(x);

/**
 * Verifies a signed consumption receipt (envelope object or JSON text) against a validated trust root
 * and independently supplied expectations, at an injected time. Never throws. The signature and the
 * signer's `challenge_store` purpose are checked before the payload is read, and every field is then
 * compared with the expectation. A valid result is an attestation of recorded consumption, nothing more.
 */
export function verifyConsumptionReceipt(input: unknown, trustRoot: TrustRoot, expected: ExpectedReceipt, now: Date): ConsumptionReceiptResult {
  try {
    return verifyUnchecked(input, trustRoot, expected, now);
  } catch {
    return failure('signature_verification_failed');
  }
}

function verifyUnchecked(input: unknown, trustRoot: TrustRoot, expected: ExpectedReceipt, now: Date): ConsumptionReceiptResult {
  if (!isPlainObject(expected) || !isVerifiedChallengeToken(expected.token) || !isRequestId(expected.requestId)) return failure('invalid_expected');
  if (expected.signingKeyId !== undefined && (typeof expected.signingKeyId !== 'string' || !KEY_ID_PATTERN.test(expected.signingKeyId))) return failure('invalid_expected');
  let contextDigest: string;
  let proofDigest: string;
  let challengeHash: string;
  const token = expected.token.token;
  try {
    if (!parseActionContext(expected.context).ok) return failure('invalid_expected');
    contextDigest = computeActionContextDigest(expected.context);
    proofDigest = computeProofDigest(expected.proof);
    challengeHash = computeChallengeHash(token.challenge);
  } catch {
    return failure('invalid_expected');
  }

  const artifact = verifyTrustedEnvelope(input, 'receipt', 'challenge_store', trustRoot, now);
  if (!artifact.ok) return failure(artifact.code, undefined, artifact.envelopeCode);

  const raw = artifact.value;
  if (!isPlainObject(raw) || raw.version !== CONSUMPTION_RECEIPT_VERSION) return failure('unsupported_receipt_version');
  let r: ConsumptionReceiptDocument;
  try {
    r = buildReceipt(raw);
  } catch (err) {
    return failure('receipt_invalid', err instanceof SchemaError ? err.message : undefined);
  }

  if (r.organization !== trustRoot.organization || r.organization !== token.organization) return failure('organization_mismatch');
  // the same store, and the same key, that issued the token must be the one that attests the consumption
  if (artifact.signingKeyId !== expected.token.signingKeyId || (expected.signingKeyId !== undefined && artifact.signingKeyId !== expected.signingKeyId)) return failure('signing_key_mismatch');
  if (r.storeId !== token.storeId) return failure('store_mismatch');
  if (r.storeGeneration !== token.storeGeneration) return failure('store_generation_mismatch');
  if (r.challengeId !== token.challengeId || r.challengeHash !== challengeHash) return failure('challenge_mismatch');
  if (r.grantId !== token.grantId) return failure('grant_mismatch');
  if (r.subjectId !== token.subjectId || r.subjectKeyId !== token.subjectKeyId) return failure('subject_mismatch');
  if (r.contextDigest !== contextDigest || r.contextDigest !== token.contextDigest) return failure('context_mismatch');
  if (r.proofDigest !== proofDigest) return failure('proof_mismatch');
  if (r.requestId !== expected.requestId) return failure('request_mismatch');
  if (r.issuedAt !== token.issuedAt || r.expiresAt !== token.expiresAt) return failure('time_mismatch');
  // (issuedAt <= consumedAt < expiresAt was already enforced by the schema)
  if ((parseUtcTimestamp(r.consumedAt) as number) > now.getTime()) return failure('consumed_in_future');

  const result: VerifiedConsumptionReceipt = Object.freeze({ ok: true as const, receipt: r, signingKeyId: artifact.signingKeyId });
  verifiedReceipts.add(result);
  return result;
}
