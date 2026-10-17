/**
 * Developer proof of possession.
 *
 * A verified grant (grant.ts) says the company authorized a subject holding a certain PUBLIC key.
 * That alone does not show that the person asking for an action holds the matching PRIVATE key.
 * A proof closes that gap: the developer signs a short statement binding their grant to ONE
 * specific action, and we verify it with the public key from the verified grant.
 *
 * WHAT A VERIFIED PROOF MEANS: someone controlling the grant subject's private key signed exactly
 * this context (organization, grant, subject, action, environment, target, commit, content digest,
 * challenge) within a short window. It does NOT mean:
 *   - that the person is who they claim: a stolen key proves possession of the key only;
 *   - that the grant is not revoked: revocation is checked separately (revocation.ts) and a valid
 *     proof never overrides a revoked or unverifiable grant;
 *   - that the expected action context is true: this module only COMPARES the signed proof with
 *     values the caller supplies. A caller-supplied commit or digest proves nothing about the real
 *     repository. A later phase must obtain them from trusted local collection;
 *   - that the proof has not been used before (see "Replay" below);
 *   - that the action is authorized. That decision needs ALL of: a verified company policy, a
 *     verified grant, fresh revocation information with the grant not revoked, a valid proof,
 *     the required permissions. None of it is wired into
 *     the assessment pipeline yet.
 *
 * Challenge: the VERIFIER creates a random challenge and later supplies it independently of the
 * proof. A challenge read from the proof is only compared against that expected value; being
 * signed does not make it trustworthy.
 *
 * Replay: a proof is bounded in time (5 minutes at most), but timestamps alone do not stop reuse
 * inside the window. Real single-use needs a trusted, persistent challenge store. This module only
 * defines the `ChallengeStore` interface and fails closed when no working store answers. Replay
 * protection is therefore INCOMPLETE: every verified proof says `replayProtection: 'not_enforced'`.
 *
 * Nothing here calls Git or reads the filesystem. Verification never throws.
 */

import { KeyObject, createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { CodexrevError } from '../../../utils/errors.js';
import { ACTION_TYPES, TARGET_ENVIRONMENTS, type ActionType, type TargetEnvironment } from '../model/types.js';
import { deriveKeyId, parseVerifiedJsonPayload, signEnvelope, verifyEnvelope } from './envelope.js';
import { GRANT_ID_PATTERN, SUBJECT_ID_PATTERN, isVerifiedGrant, type VerifiedGrant } from './grant.js';
import { ORGANIZATION_ID, hasExactFields, isPlainObject, parseUtcTimestamp } from './trustRoot.js';
import { MAX_ENVELOPE_TEXT_BYTES, type KeyId, type SignedEnvelope, type VerifyFailureCode } from './types.js';

export const PROOF_VERSION = 1 as const;
/** Longest a proof may live (issuedAt to expiresAt). No clock-skew tolerance is applied anywhere. */
export const MAX_PROOF_LIFETIME_MS = 5 * 60 * 1000;
/** Challenge size: 32 random bytes (256 bits). */
export const CHALLENGE_BYTES = 32;

// ---------------------------------------------------------------- identifiers and digests

/** Same shape rules everywhere, so a proof and a request cannot disagree about what a valid value looks like. */
export const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;
/** A Git object name: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. */
export const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** "sha256:" followed by 64 lowercase hex characters: the algorithm is part of the value, so it is never ambiguous. */
export const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{64}$/;
const CHALLENGE_TEXT = /^[A-Za-z0-9_-]{43}$/;

/**
 * Digest of exact content bytes, for the caller (or a future trusted collector) to compute over
 * the proposed change or the exact action specification. Works for binary content. Pure: it does
 * not read any file.
 */
export function computeContentDigest(content: Uint8Array): string {
  if (!(content instanceof Uint8Array)) throw new ProofError('invalid_context', 'content must be bytes');
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

// ---------------------------------------------------------------- challenge

function decodeChallenge(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !CHALLENGE_TEXT.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  // canonical only: one value, one spelling
  return bytes.length === CHALLENGE_BYTES && bytes.toString('base64url') === text ? bytes : null;
}

/** True for a well-formed challenge: 32 bytes as strict Base64url (43 characters). */
export const isValidChallenge = (x: unknown): x is string => decodeChallenge(x) !== null;

/**
 * A fresh, unpredictable challenge from Node's cryptographically secure random generator.
 * The verifier creates it, hands it to the developer, and later passes it to verifyProof as the
 * expected challenge. Generating it does not by itself make a proof single-use.
 */
export function generateChallenge(): string {
  return randomBytes(CHALLENGE_BYTES).toString('base64url');
}

// ---------------------------------------------------------------- action context

/**
 * The exact action a proof is bound to. For a code change, `commit` is the Git HEAD and
 * `contentDigest` the digest of the proposed changed content. For other actions the digest covers
 * the exact action specification. `commit` is null when no commit applies, except for
 * code changes, which must name one.
 */
export interface ActionContext {
  readonly actionId: string;
  readonly actionType: ActionType;
  readonly environment: TargetEnvironment;
  readonly target: string;
  readonly commit: string | null;
  readonly contentDigest: string;
}

const CONTEXT_FIELDS = ['actionId', 'actionType', 'environment', 'target', 'commit', 'contentDigest'] as const;

class SchemaError extends Error {}
const bad = (path: string, why: string): never => {
  throw new SchemaError(`${path} ${why}`);
};

/** Validates the context fields found on `o`. Throws SchemaError. */
function contextFrom(o: Record<string, unknown>, at: string): ActionContext {
  const { actionId, actionType, environment, target, commit, contentDigest } = o;
  if (typeof actionId !== 'string' || !ACTION_ID_PATTERN.test(actionId)) return bad(`${at}.actionId`, 'is invalid');
  if (typeof actionType !== 'string' || !(ACTION_TYPES as readonly string[]).includes(actionType)) return bad(`${at}.actionType`, 'is not a known action type');
  if (typeof environment !== 'string' || !(TARGET_ENVIRONMENTS as readonly string[]).includes(environment)) return bad(`${at}.environment`, 'is not a known environment');
  if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) return bad(`${at}.target`, 'is invalid');
  if (commit !== null && (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit))) return bad(`${at}.commit`, 'must be null or a lowercase hex Git object name');
  if (commit === null && actionType === 'code_change') return bad(`${at}.commit`, 'is required for a code change');
  if (typeof contentDigest !== 'string' || !CONTENT_DIGEST_PATTERN.test(contentDigest)) return bad(`${at}.contentDigest`, 'must be sha256: followed by 64 lowercase hex characters');
  return Object.freeze({ actionId, actionType: actionType as ActionType, environment: environment as TargetEnvironment, target, commit, contentDigest });
}

export type ContextResult = { readonly ok: true; readonly context: ActionContext } | { readonly ok: false; readonly message: string };

/** Strict validation of an action context of unknown shape. Never throws. */
export function parseActionContext(input: unknown): ContextResult {
  try {
    if (!isPlainObject(input) || !hasExactFields(input, CONTEXT_FIELDS)) return { ok: false, message: 'context has missing or unexpected fields' };
    return { ok: true, context: contextFrom(input, 'context') };
  } catch (err) {
    return { ok: false, message: err instanceof SchemaError ? err.message : 'context is invalid' };
  }
}

// ---------------------------------------------------------------- proof document

export interface ProofDocument extends ActionContext {
  readonly version: typeof PROOF_VERSION;
  readonly organization: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: KeyId;
  readonly challenge: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const PROOF_FIELDS = ['version', 'organization', 'grantId', 'subjectId', 'subjectKeyId', ...CONTEXT_FIELDS, 'challenge', 'issuedAt', 'expiresAt'] as const;

function buildProof(value: unknown): ProofDocument {
  if (!isPlainObject(value) || !hasExactFields(value, PROOF_FIELDS)) return bad('proof', 'has missing or unexpected fields');
  const { organization, grantId, subjectId, subjectKeyId, challenge, issuedAt, expiresAt } = value;
  if (typeof organization !== 'string' || !ORGANIZATION_ID.test(organization)) return bad('proof.organization', 'is invalid');
  if (typeof grantId !== 'string' || !GRANT_ID_PATTERN.test(grantId)) return bad('proof.grantId', 'is invalid');
  if (typeof subjectId !== 'string' || !SUBJECT_ID_PATTERN.test(subjectId)) return bad('proof.subjectId', 'is invalid');
  if (typeof subjectKeyId !== 'string' || !KEY_ID.test(subjectKeyId)) return bad('proof.subjectKeyId', 'is invalid');
  const context = contextFrom(value, 'proof');
  if (!isValidChallenge(challenge)) return bad('proof.challenge', 'must be 32 random bytes as strict Base64url');
  const issued = parseUtcTimestamp(issuedAt);
  const expires = parseUtcTimestamp(expiresAt);
  if (issued === null || expires === null) return bad('proof times', 'must be valid UTC timestamps');
  if (!(issued < expires)) return bad('proof times', 'must satisfy issuedAt < expiresAt');
  return Object.freeze({
    version: PROOF_VERSION,
    organization,
    grantId,
    subjectId,
    subjectKeyId,
    ...context,
    challenge,
    issuedAt: issuedAt as string,
    expiresAt: expiresAt as string,
  });
}

/** The exact bytes that are signed: fields in one fixed order, so the same proof is always the same bytes. */
function serialize(doc: ProofDocument): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: doc.version,
      organization: doc.organization,
      grantId: doc.grantId,
      subjectId: doc.subjectId,
      subjectKeyId: doc.subjectKeyId,
      actionId: doc.actionId,
      actionType: doc.actionType,
      environment: doc.environment,
      target: doc.target,
      commit: doc.commit,
      contentDigest: doc.contentDigest,
      challenge: doc.challenge,
      issuedAt: doc.issuedAt,
      expiresAt: doc.expiresAt,
    }),
    'utf-8',
  );
}

// ---------------------------------------------------------------- creating a proof (developer side)

export type ProofErrorReason = 'invalid_grant' | 'invalid_context' | 'invalid_challenge' | 'invalid_time' | 'invalid_lifetime' | 'invalid_private_key' | 'key_mismatch' | 'outside_grant';

/** Thrown by createProof (trusted-side input). Messages are fixed text and never include key material. */
export class ProofError extends CodexrevError {
  constructor(
    readonly reason: ProofErrorReason,
    message: string,
  ) {
    super(message, 'CODEXREV_AUTHZ_PROOF_ERROR', false);
    this.name = 'ProofError';
  }
}

export interface CreateProofParams {
  /** the developer's Ed25519 private key; it must match the public key in the verified grant */
  readonly privateKey: KeyObject;
  readonly grant: VerifiedGrant;
  readonly context: ActionContext;
  /** the verifier-issued challenge (see generateChallenge) */
  readonly challenge: string;
  /** injected so tests are deterministic */
  readonly issuedAt: Date;
  /** defaults to, and may not exceed, MAX_PROOF_LIFETIME_MS */
  readonly lifetimeMs?: number;
}

/**
 * Signs a proof binding the grant to one action. The private key stays with the caller: it is used
 * to sign and is never copied into the proof. Throws ProofError for bad trusted-side input,
 * including a key that does not belong to the grant, a proof that would outlive the grant, or one
 * issued outside the grant's validity.
 */
export function createProof(params: CreateProofParams): SignedEnvelope {
  const { privateKey, grant, context, challenge, issuedAt } = params;
  if (!isVerifiedGrant(grant)) throw new ProofError('invalid_grant', 'a verified grant is required');
  const parsed = parseActionContext(context);
  if (!parsed.ok) throw new ProofError('invalid_context', 'the action context is invalid');
  if (!isValidChallenge(challenge)) throw new ProofError('invalid_challenge', 'the challenge is not 32 random bytes as strict Base64url');
  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) throw new ProofError('invalid_time', 'the issue time is not a valid date');
  const lifetime = params.lifetimeMs ?? MAX_PROOF_LIFETIME_MS;
  if (typeof lifetime !== 'number' || !Number.isInteger(lifetime) || lifetime < 1000 || lifetime > MAX_PROOF_LIFETIME_MS) {
    throw new ProofError('invalid_lifetime', 'the proof lifetime must be a whole number of milliseconds from 1000 up to the maximum');
  }

  let ownKeyId: KeyId;
  try {
    if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key');
    ownKeyId = deriveKeyId(createPublicKey(privateKey));
  } catch {
    throw new ProofError('invalid_private_key', 'expected an Ed25519 private key');
  }
  if (ownKeyId !== grant.grant.subject.keyId) throw new ProofError('key_mismatch', 'the private key does not belong to the grant subject');

  const issued = issuedAt.getTime();
  // whole seconds only, so the signed timestamps round-trip exactly
  const issuedText = new Date(Math.floor(issued / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const expiresText = new Date(Math.floor(issued / 1000) * 1000 + lifetime).toISOString().replace('.000Z', 'Z');
  const from = parseUtcTimestamp(grant.grant.notBefore) as number;
  const to = parseUtcTimestamp(grant.grant.expiresAt) as number;
  if ((parseUtcTimestamp(issuedText) as number) < from || (parseUtcTimestamp(expiresText) as number) > to) {
    throw new ProofError('outside_grant', 'the proof would fall outside the validity of the grant');
  }

  const doc = buildProof({
    version: PROOF_VERSION,
    organization: grant.grant.organization,
    grantId: grant.grant.grantId,
    subjectId: grant.grant.subject.id,
    subjectKeyId: grant.grant.subject.keyId,
    ...parsed.context,
    challenge,
    issuedAt: issuedText,
    expiresAt: expiresText,
  });
  return signEnvelope({ domain: 'proof', payload: serialize(doc), privateKey });
}

// ---------------------------------------------------------------- verifying a proof

export type ProofFailureCode =
  | 'grant_unverified'
  | 'invalid_evaluation_time'
  | 'invalid_expected_context'
  | 'invalid_expected_challenge'
  | 'grant_not_current'
  | 'malformed_proof'
  | 'wrong_domain'
  | 'unsupported_proof_version'
  | 'invalid_signature'
  | 'wrong_organization'
  | 'wrong_grant'
  | 'wrong_subject'
  | 'wrong_action'
  | 'wrong_environment'
  | 'wrong_target'
  | 'wrong_commit'
  | 'wrong_content'
  | 'wrong_challenge'
  | 'proof_lifetime_too_long'
  | 'proof_outside_grant'
  | 'future_proof'
  | 'expired_proof';

const MESSAGES: Readonly<Record<ProofFailureCode, string>> = {
  grant_unverified: 'a verified grant is required',
  invalid_evaluation_time: 'the evaluation time is not a valid date',
  invalid_expected_context: 'the expected action context is invalid',
  invalid_expected_challenge: 'the expected challenge is not 32 random bytes as strict Base64url',
  grant_not_current: 'the grant is not valid at the evaluation time',
  malformed_proof: 'the proof is not a well-formed signed proof',
  wrong_domain: 'the envelope was not signed for the proof domain',
  unsupported_proof_version: 'the proof format version is not supported',
  invalid_signature: 'the proof signature does not match the grant subject key',
  wrong_organization: 'the proof is for a different organization',
  wrong_grant: 'the proof was made for a different grant',
  wrong_subject: 'the proof was made by a different subject or key',
  wrong_action: 'the proof was made for a different action',
  wrong_environment: 'the proof was made for a different environment',
  wrong_target: 'the proof was made for a different target',
  wrong_commit: 'the proof was made for a different Git commit',
  wrong_content: 'the proof was made for different content',
  wrong_challenge: 'the proof does not contain the expected challenge',
  proof_lifetime_too_long: 'the proof lifetime exceeds the supported maximum',
  proof_outside_grant: 'the proof is not within the validity of the grant',
  future_proof: 'the proof is issued in the future',
  expired_proof: 'the proof has expired',
};

export interface ProofFailure {
  readonly ok: false;
  readonly code: ProofFailureCode;
  /** fixed, safe text: never the payload, the action contents, the challenge or any key */
  readonly message: string;
  readonly envelopeCode?: VerifyFailureCode;
}

const failure = (code: ProofFailureCode, detail?: string, envelopeCode?: VerifyFailureCode): ProofFailure => ({
  ok: false,
  code,
  message: detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code],
  ...(envelopeCode ? { envelopeCode } : {}),
});

/**
 * A proof whose signature verified under the grant subject's key and whose signed context equals
 * the expected context and challenge. This is NOT an authorization decision (see the file header).
 */
export interface VerifiedProof {
  readonly ok: true;
  readonly proof: ProofDocument;
  /** always 'not_enforced': nothing here prevents the same proof from being presented twice within its window */
  readonly replayProtection: 'not_enforced';
}

export type ProofResult = VerifiedProof | ProofFailure;

const verifiedProofs = new WeakSet<object>();
/** True only for a result returned by a successful verifyProof. */
export const isVerifiedProof = (x: unknown): x is VerifiedProof => typeof x === 'object' && x !== null && verifiedProofs.has(x);

const MALFORMED: readonly VerifyFailureCode[] = [
  'malformed_envelope',
  'envelope_too_large',
  'unsupported_version',
  'malformed_payload_encoding',
  'empty_payload',
  'payload_too_large',
  'malformed_signature_encoding',
  'invalid_signature_length',
];

/**
 * Verifies a signed proof (envelope object or JSON text) against a VERIFIED grant and an
 * independently supplied expected action context and challenge, at an injected time. Never throws.
 *
 * The verification key is the subject public key of the verified grant; nothing in the proof can
 * supply or replace it. The payload is parsed only after the signature verified.
 */
export function verifyProof(input: unknown, grant: VerifiedGrant, expected: ActionContext, expectedChallenge: string, now: Date): ProofResult {
  try {
    return verifyUnchecked(input, grant, expected, expectedChallenge, now);
  } catch {
    return failure('invalid_signature');
  }
}

/** Constant-time comparison of two canonical challenges. */
function sameChallenge(a: string, b: string): boolean {
  const x = decodeChallenge(a);
  const y = decodeChallenge(b);
  return x !== null && y !== null && timingSafeEqual(x, y);
}

function verifyUnchecked(input: unknown, grant: VerifiedGrant, expected: ActionContext, expectedChallenge: string, now: Date): ProofResult {
  if (!isVerifiedGrant(grant)) return failure('grant_unverified');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return failure('invalid_evaluation_time');
  const ctx = parseActionContext(expected);
  if (!ctx.ok) return failure('invalid_expected_context');
  if (!isValidChallenge(expectedChallenge)) return failure('invalid_expected_challenge');

  const t = now.getTime();
  const grantFrom = parseUtcTimestamp(grant.grant.notBefore) as number;
  const grantTo = parseUtcTimestamp(grant.grant.expiresAt) as number;
  if (t < grantFrom || t >= grantTo) return failure('grant_not_current');

  let envelope = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf-8') > MAX_ENVELOPE_TEXT_BYTES) return failure('malformed_proof');
    try {
      envelope = JSON.parse(input);
    } catch {
      return failure('malformed_proof');
    }
  }
  if (!isPlainObject(envelope)) return failure('malformed_proof');
  if (envelope.domain !== 'proof') return failure('wrong_domain');

  // the ONLY verification key is the verified grant's subject key
  const result = verifyEnvelope(envelope, { expectedDomain: 'proof', trustedPublicKey: grant.subjectPublicKey });
  if (!result.ok) {
    if (result.code === 'domain_mismatch' || result.code === 'unknown_domain') return failure('wrong_domain', undefined, result.code);
    if (result.code === 'key_id_mismatch') return failure('wrong_subject', undefined, result.code);
    return failure(MALFORMED.includes(result.code) ? 'malformed_proof' : 'invalid_signature', undefined, result.code);
  }

  // only now is the payload interpreted
  const parsed = parseVerifiedJsonPayload(result);
  if (!parsed.ok) return failure('malformed_proof');
  if (!isPlainObject(parsed.value) || parsed.value.version !== PROOF_VERSION) return failure('unsupported_proof_version');
  let proof: ProofDocument;
  try {
    proof = buildProof(parsed.value);
  } catch (err) {
    return failure('malformed_proof', err instanceof SchemaError ? err.message : undefined);
  }

  // time: bounded lifetime, inside the grant, and valid right now (no skew tolerance)
  const issued = parseUtcTimestamp(proof.issuedAt) as number;
  const expires = parseUtcTimestamp(proof.expiresAt) as number;
  if (expires - issued > MAX_PROOF_LIFETIME_MS) return failure('proof_lifetime_too_long');
  if (issued < grantFrom || expires > grantTo) return failure('proof_outside_grant');
  if (t < issued) return failure('future_proof');
  if (t >= expires) return failure('expired_proof');

  // the proof must be about THIS grant and subject
  if (proof.organization !== grant.grant.organization) return failure('wrong_organization');
  if (proof.grantId !== grant.grant.grantId) return failure('wrong_grant');
  if (proof.subjectId !== grant.grant.subject.id || proof.subjectKeyId !== grant.grant.subject.keyId) return failure('wrong_subject');

  // ...and about exactly the expected action, which the caller supplied independently
  const want = ctx.context;
  if (proof.actionId !== want.actionId || proof.actionType !== want.actionType) return failure('wrong_action');
  if (proof.environment !== want.environment) return failure('wrong_environment');
  if (proof.target !== want.target) return failure('wrong_target');
  if (proof.commit !== want.commit) return failure('wrong_commit');
  if (proof.contentDigest !== want.contentDigest) return failure('wrong_content');
  if (!sameChallenge(proof.challenge, expectedChallenge)) return failure('wrong_challenge');

  const verified: VerifiedProof = Object.freeze({ ok: true as const, proof, replayProtection: 'not_enforced' as const });
  verifiedProofs.add(verified);
  return verified;
}

// ---------------------------------------------------------------- single use (interface only)

/**
 * What a future TRUSTED, PERSISTENT challenge store must provide. `consume` must atomically record
 * the challenge as used and report whether this call was the first. It must survive restarts and
 * be protected from the developer being checked. No implementation is provided here on purpose:
 * an in-memory map would vanish with the process and would not be durable replay protection.
 */
export interface ChallengeStore {
  consume(entry: { readonly challenge: string; readonly grantId: string; readonly actionId: string; readonly expiresAt: string }): Promise<'consumed' | 'already_used'>;
}

export type ChallengeOutcome = 'consumed' | 'already_used' | 'unavailable';

/**
 * Asks a store to consume a verified proof's challenge. Fails closed: anything other than a clear
 * answer from the store, including a throw, a rejection or an unknown value, is 'unavailable', and
 * 'unavailable' must be treated as "not single-use".
 */
export async function consumeChallenge(verified: VerifiedProof, store: ChallengeStore): Promise<ChallengeOutcome> {
  try {
    if (!isVerifiedProof(verified) || typeof store?.consume !== 'function') return 'unavailable';
    const { challenge, grantId, actionId, expiresAt } = verified.proof;
    const outcome = await store.consume({ challenge, grantId, actionId, expiresAt });
    return outcome === 'consumed' || outcome === 'already_used' ? outcome : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
