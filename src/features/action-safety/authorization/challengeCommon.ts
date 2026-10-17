/**
 * Shared definitions for the two challenge artifacts (challengeToken.ts, consumptionReceipt.ts):
 * identifier shapes, bounds, and three small digests with exact byte layouts. Pure; no I/O.
 *
 * THE ACTION-CONTEXT DIGEST (what a token and a receipt are bound to)
 * SHA-256 over these exact UTF-8 bytes:
 *   "codexrev-action-context-v1\n"
 *   then, for each of the six fields in THIS order: actionId, actionType, environment, target,
 *   commit, contentDigest:
 *     a string value:  <field>=S<byte length of the value>:<value>\n
 *     a null commit:   commit=N\n
 * The byte length makes every string self-delimiting (a value containing "\n" or "=" cannot pose as
 * another field), and "S"/"N" make a null distinguishable from any string. The context is validated
 * with the existing action-context parser first, so only a well-formed context has a digest. The
 * result is `sha256:<64 lowercase hex>`.
 * This is NOT the Git snapshot digest. That one (actionContextCollector.ts) summarizes a repository's
 * tree and is itself ONE FIELD (`contentDigest`) inside the context hashed here. They answer different
 * questions and use different domain strings.
 *
 * THE CHALLENGE HASH: SHA-256 over "codexrev-challenge-hash-v1\n" followed by the 32 raw challenge
 * bytes (not the Base64url text). A receipt carries this hash, never the challenge itself.
 *
 * THE PROOF DIGEST: SHA-256 over "codexrev-proof-digest-v1\n", then the exact signing input of the
 * proof (buildSigningInput('proof', payload): namespace, domain, payload length and payload bytes),
 * then the 64 signature bytes. So it covers precisely what the developer signed plus the signature,
 * and two different proofs cannot share a digest.
 *
 * Signing helpers elsewhere take private keys for isolated tests and a future trusted service. No key
 * is generated or stored here, and nothing in this module reads a file, a clock or the environment.
 */

import { createHash } from 'node:crypto';
import { CodexrevError } from '../../../utils/errors.js';
import { buildSigningInput } from './envelope.js';
import { isValidChallenge, parseActionContext, type ActionContext } from './proof.js';
import { isPlainObject, hasExactFields } from './trustRoot.js';
import { ED25519_SIGNATURE_BYTES, ENVELOPE_FORMAT_VERSION, MAX_ENVELOPE_TEXT_BYTES } from './types.js';

export const ACTION_CONTEXT_DIGEST_DOMAIN = 'codexrev-action-context-v1';
export const CHALLENGE_HASH_DOMAIN = 'codexrev-challenge-hash-v1';
export const PROOF_DIGEST_DOMAIN = 'codexrev-proof-digest-v1';

/** Longest a challenge may live, from the store's issue time to its expiry. */
export const MAX_CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;

/** A store identifier: the same shape strictConfig.ts accepts for `challengeStore.storeId`. */
export const STORE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An opaque generation identifier: changes when a store is restored or re-created. */
export const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 16 random bytes as strict Base64url (22 characters): challenge ids and receipt ids. */
export const RANDOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** A client-chosen idempotency key: 16 to 48 random bytes as Base64url. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const KEY_ID_PATTERN = /^[0-9a-f]{64}$/;

export type ChallengeArtifactErrorReason =
  | 'invalid_context'
  | 'invalid_challenge'
  | 'invalid_identifier'
  | 'invalid_time'
  | 'invalid_lifetime'
  | 'invalid_private_key'
  | 'invalid_proof_envelope'
  | 'invalid_sequence';

/** Thrown by the TRUSTED-side helpers (digests, signing). Messages are fixed text: never a challenge, key or proof. */
export class ChallengeArtifactError extends CodexrevError {
  constructor(
    readonly reason: ChallengeArtifactErrorReason,
    message: string,
  ) {
    super(message, 'CODEXREV_AUTHZ_CHALLENGE_ARTIFACT_ERROR', false);
    this.name = 'ChallengeArtifactError';
  }
}

function canonicalBytes(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/** True for exactly 16 random bytes written as canonical Base64url (22 characters). */
export const isRandomId = (x: unknown): x is string => RANDOM_ID_PATTERN.test(String(x)) && canonicalBytes(x)?.length === 16;

/** True for a canonical Base64url idempotency key of 16 to 48 bytes. */
export const isRequestId = (x: unknown): x is string => {
  if (typeof x !== 'string' || !REQUEST_ID_PATTERN.test(x)) return false;
  const bytes = canonicalBytes(x);
  return bytes !== null && bytes.length >= 16 && bytes.length <= 48;
};

const enc = (name: string, value: string | null): string => (value === null ? `${name}=N\n` : `${name}=S${Buffer.byteLength(value, 'utf-8')}:${value}\n`);

/** The canonical digest of the six-field action context. See the file header for the exact layout. */
export function computeActionContextDigest(context: ActionContext): string {
  const parsed = parseActionContext(context);
  if (!parsed.ok) throw new ChallengeArtifactError('invalid_context', 'the action context is invalid');
  const c = parsed.context;
  const text = ACTION_CONTEXT_DIGEST_DOMAIN + '\n' + enc('actionId', c.actionId) + enc('actionType', c.actionType) + enc('environment', c.environment) + enc('target', c.target) + enc('commit', c.commit) + enc('contentDigest', c.contentDigest);
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')}`;
}

/** The domain-separated hash of a challenge, over its 32 raw bytes. A receipt carries this instead of the challenge. */
export function computeChallengeHash(challenge: string): string {
  if (!isValidChallenge(challenge)) throw new ChallengeArtifactError('invalid_challenge', 'the challenge is not 32 random bytes as strict Base64url');
  return `sha256:${createHash('sha256').update(Buffer.from(`${CHALLENGE_HASH_DOMAIN}\n`, 'utf-8')).update(Buffer.from(challenge, 'base64url')).digest('hex')}`;
}

/**
 * The digest of a signed proof envelope (object or JSON text), over exactly what was signed plus the
 * signature. It does NOT verify the signature: the receipt's verifier compares it with the digest of
 * the proof it was handed, and the proof is verified by verifyProof.
 */
export function computeProofDigest(proof: unknown): string {
  let envelope = proof;
  if (typeof proof === 'string') {
    if (Buffer.byteLength(proof, 'utf-8') > MAX_ENVELOPE_TEXT_BYTES) throw new ChallengeArtifactError('invalid_proof_envelope', 'the proof envelope is not a well-formed signed proof');
    try {
      envelope = JSON.parse(proof);
    } catch {
      throw new ChallengeArtifactError('invalid_proof_envelope', 'the proof envelope is not a well-formed signed proof');
    }
  }
  const fail = (): never => {
    throw new ChallengeArtifactError('invalid_proof_envelope', 'the proof envelope is not a well-formed signed proof');
  };
  if (!isPlainObject(envelope) || !hasExactFields(envelope, ['version', 'domain', 'keyId', 'payload', 'signature'])) return fail();
  if (envelope.version !== ENVELOPE_FORMAT_VERSION || envelope.domain !== 'proof' || typeof envelope.keyId !== 'string') return fail();
  const payload = canonicalBytes(envelope.payload);
  const signature = canonicalBytes(envelope.signature);
  if (!payload || payload.length === 0 || !signature || signature.length !== ED25519_SIGNATURE_BYTES) return fail();
  const hash = createHash('sha256').update(Buffer.from(`${PROOF_DIGEST_DOMAIN}\n`, 'utf-8')).update(buildSigningInput('proof', payload)).update(signature);
  return `sha256:${hash.digest('hex')}`;
}

/** Whole seconds, UTC, in the strict timestamp form the earlier phases use. */
export function wholeSecondsText(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Everything that identifies WHO and WHAT a challenge is for. */
export interface ChallengeBinding {
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: string;
}
