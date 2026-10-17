/**
 * Ed25519 signed envelopes, using only Node's built-in `node:crypto`.
 *
 * How it works, in short:
 *   1. The payload is a sequence of bytes (usually UTF-8 JSON). Those exact bytes are signed.
 *   2. The bytes are never re-serialized: what was signed is what is verified, so JSON key
 *      order and whitespace cannot matter or be exploited.
 *   3. The signature does not cover the bytes alone: it covers a "signing input" that starts
 *      with a namespace, the domain and the payload length. A signature made for one purpose
 *      therefore never verifies for another.
 *   4. The verifier is handed the trusted public key from outside. The envelope carries only a
 *      key id, which must match that key; it can never introduce a key.
 *
 * What a valid result means: "the holder of the trusted private key signed exactly these bytes
 * for this domain." It does NOT mean the key is allowed to authorize anything (trust roots,
 * policies, grants, expiry and revocation are later phases).
 *
 * Verification of untrusted input never throws and never reveals raw crypto errors or content.
 */

import { KeyObject, createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import {
  AuthorizationCryptoError,
  DOMAIN_NAMESPACES,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  ENVELOPE_FORMAT_VERSION,
  MAX_ENCODED_PAYLOAD_CHARS,
  MAX_ENVELOPE_TEXT_BYTES,
  MAX_PAYLOAD_BYTES,
  isSigningDomain,
  type JsonPayloadResult,
  type KeyId,
  type SignedEnvelope,
  type SigningDomain,
  type VerificationFailure,
  type VerifiedEnvelope,
  type VerifyFailureCode,
  type VerifyResult,
} from './types.js';

// ---------------------------------------------------------------- encoding

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const KEY_ID = /^[0-9a-f]{64}$/;

/**
 * Strict, canonical Base64url (no padding). Returns null for anything else: wrong
 * alphabet, padding, impossible length, or non-canonical trailing bits (text that
 * decodes fine but would not re-encode to itself). One input, one meaning.
 */
function decodeBase64url(text: string): Buffer | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

// ---------------------------------------------------------------- keys

const isEd25519 = (key: unknown, type: 'public' | 'private'): key is KeyObject =>
  key instanceof KeyObject && key.type === type && key.asymmetricKeyType === 'ed25519';

/** The raw 32-byte public key. Throws AuthorizationCryptoError for anything that is not an Ed25519 public key. */
export function exportRawPublicKey(publicKey: KeyObject): Buffer {
  if (!isEd25519(publicKey, 'public')) throw new AuthorizationCryptoError('invalid_public_key', 'expected an Ed25519 public key');
  const x = publicKey.export({ format: 'jwk' }).x;
  const raw = typeof x === 'string' ? decodeBase64url(x) : null;
  if (!raw || raw.length !== ED25519_PUBLIC_KEY_BYTES) throw new AuthorizationCryptoError('invalid_public_key', 'unsupported public key material');
  return raw;
}

/**
 * Imports a raw Ed25519 public key, given as 32 bytes or as strict Base64url text.
 * Anything else (wrong length, bad encoding, wrong type) throws AuthorizationCryptoError.
 */
export function importRawPublicKey(raw: Uint8Array | string): KeyObject {
  const bytes = typeof raw === 'string' ? decodeBase64url(raw) : raw instanceof Uint8Array ? Buffer.from(raw) : null;
  if (!bytes || bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new AuthorizationCryptoError('invalid_public_key', `an Ed25519 public key is exactly ${ED25519_PUBLIC_KEY_BYTES} bytes, strictly encoded`);
  }
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') }, format: 'jwk' });
  } catch {
    throw new AuthorizationCryptoError('invalid_public_key', 'unsupported public key material');
  }
}

/**
 * A stable identifier for a public key: lowercase hex SHA-256 of its raw 32 bytes
 * (64 characters). The same key always gives the same id, and different keys differ.
 */
export function deriveKeyId(publicKey: KeyObject): KeyId {
  return createHash('sha256').update(exportRawPublicKey(publicKey)).digest('hex');
}

// ---------------------------------------------------------------- signing input

/**
 * What is actually signed: an unambiguous header (namespace, domain and payload length in
 * ASCII) followed by the exact payload bytes. Because the domain and length are inside the
 * signed bytes, a signature cannot be replayed under another domain or on a shortened payload.
 */
export function buildSigningInput(domain: SigningDomain, payload: Uint8Array): Buffer {
  const header = `${DOMAIN_NAMESPACES[domain]} ${domain.length} ${domain} ${payload.length} `;
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}

// ---------------------------------------------------------------- sign

export interface SignEnvelopeParams {
  readonly domain: SigningDomain;
  /** the exact bytes to sign; they are signed as they are and never re-serialized */
  readonly payload: Uint8Array;
  readonly privateKey: KeyObject;
}

/**
 * Signs payload bytes for one domain. This is a TRUSTED-side function: bad input throws
 * AuthorizationCryptoError (with fixed, secret-free text). Empty payloads are refused.
 */
export function signEnvelope(params: SignEnvelopeParams): SignedEnvelope {
  const { domain, payload, privateKey } = params;
  if (!isSigningDomain(domain)) throw new AuthorizationCryptoError('unknown_domain', 'unknown signing domain');
  if (!(payload instanceof Uint8Array)) throw new AuthorizationCryptoError('empty_payload', 'the payload must be bytes');
  if (payload.length === 0) throw new AuthorizationCryptoError('empty_payload', 'an empty payload cannot be signed');
  if (payload.length > MAX_PAYLOAD_BYTES) throw new AuthorizationCryptoError('payload_too_large', `the payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  if (!isEd25519(privateKey, 'private')) throw new AuthorizationCryptoError('invalid_private_key', 'expected an Ed25519 private key');

  const bytes = Buffer.from(payload);
  const keyId = deriveKeyId(createPublicKey(privateKey));
  const signature = cryptoSign(null, buildSigningInput(domain, bytes), privateKey);
  return {
    version: ENVELOPE_FORMAT_VERSION,
    domain,
    keyId,
    payload: bytes.toString('base64url'),
    signature: signature.toString('base64url'),
  };
}

// ---------------------------------------------------------------- verify

const MESSAGES: Readonly<Record<VerifyFailureCode, string>> = {
  malformed_envelope: 'the envelope is not a well-formed signed envelope',
  envelope_too_large: 'the envelope is larger than the allowed size',
  unsupported_version: 'the envelope format version is not supported',
  unknown_domain: 'the envelope names an unknown signing domain',
  domain_mismatch: 'the envelope was made for a different signing domain than expected',
  malformed_payload_encoding: 'the payload is not strictly encoded Base64url',
  empty_payload: 'the payload is empty',
  payload_too_large: 'the payload is larger than the allowed size',
  malformed_signature_encoding: 'the signature is not strictly encoded Base64url',
  invalid_signature_length: 'the signature does not have the length of an Ed25519 signature',
  invalid_public_key: 'the trusted key is not a usable Ed25519 public key',
  key_id_mismatch: 'the envelope key id does not match the trusted key',
  signature_invalid: 'the signature does not match the payload, domain and trusted key',
};

const fail = (code: VerifyFailureCode): VerificationFailure => ({ ok: false, code, message: MESSAGES[code] });

const ENVELOPE_FIELDS = ['version', 'domain', 'keyId', 'payload', 'signature'] as const;

const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export interface VerifyEnvelopeOptions {
  /** the domain the caller expects; an envelope for any other domain is rejected */
  readonly expectedDomain: SigningDomain;
  /**
   * The trusted public key, supplied by the caller. It is never taken from the envelope,
   * and a valid signature from this key is not, by itself, authorization.
   */
  readonly trustedPublicKey: KeyObject;
}

/**
 * Verifies an envelope object (untrusted input of unknown shape) against a trusted key.
 * Never throws. Cheap checks come first, so oversized or malformed input is rejected
 * before any decoding or cryptography.
 */
export function verifyEnvelope(input: unknown, options: VerifyEnvelopeOptions): VerifyResult {
  try {
    return verifyUnchecked(input, options);
  } catch {
    // a safe failure, never a raw exception from the crypto layer
    return fail('signature_invalid');
  }
}

function verifyUnchecked(input: unknown, options: VerifyEnvelopeOptions): VerifyResult {
  // 1. shape: exactly the five fields, all of the right primitive type
  if (!isPlainObject(input)) return fail('malformed_envelope');
  const keys = Object.keys(input);
  if (keys.length !== ENVELOPE_FIELDS.length || !ENVELOPE_FIELDS.every((f) => Object.prototype.hasOwnProperty.call(input, f))) {
    return fail('malformed_envelope');
  }
  const { version, domain, keyId, payload, signature } = input;
  if (typeof version !== 'number' || typeof domain !== 'string' || typeof keyId !== 'string' || typeof payload !== 'string' || typeof signature !== 'string') {
    return fail('malformed_envelope');
  }

  // 2. version and domain
  if (version !== ENVELOPE_FORMAT_VERSION) return fail('unsupported_version');
  if (!isSigningDomain(domain) || !isSigningDomain(options.expectedDomain)) return fail('unknown_domain');
  if (domain !== options.expectedDomain) return fail('domain_mismatch');

  // 3. key id syntax
  if (!KEY_ID.test(keyId)) return fail('malformed_envelope');

  // 4. sizes, BEFORE decoding anything
  if (payload.length > MAX_ENCODED_PAYLOAD_CHARS) return fail('payload_too_large');
  if (signature.length > 4 * Math.ceil(ED25519_SIGNATURE_BYTES / 3)) return fail('invalid_signature_length');

  // 5. strict canonical encodings
  const payloadBytes = decodeBase64url(payload);
  if (!payloadBytes) return fail('malformed_payload_encoding');
  if (payloadBytes.length === 0) return fail('empty_payload');
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) return fail('payload_too_large');
  const signatureBytes = decodeBase64url(signature);
  if (!signatureBytes) return fail('malformed_signature_encoding');
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) return fail('invalid_signature_length');

  // 6. the trusted key: must be an Ed25519 public key, and the envelope's key id must be ITS id
  if (!isEd25519(options.trustedPublicKey, 'public')) return fail('invalid_public_key');
  let trustedId: KeyId;
  try {
    trustedId = deriveKeyId(options.trustedPublicKey);
  } catch {
    return fail('invalid_public_key');
  }
  if (keyId !== trustedId) return fail('key_id_mismatch');

  // 7. the signature itself, over the domain-separated signing input of the exact bytes
  const valid = cryptoVerify(null, buildSigningInput(domain, payloadBytes), options.trustedPublicKey, signatureBytes);
  if (!valid) return fail('signature_invalid');
  return { ok: true, domain, keyId, payload: payloadBytes };
}

/**
 * Verifies an envelope given as JSON text. The text length is limited first; text that is not
 * JSON is a malformed envelope. Same guarantees as verifyEnvelope.
 */
export function verifyEnvelopeText(text: unknown, options: VerifyEnvelopeOptions): VerifyResult {
  if (typeof text !== 'string') return fail('malformed_envelope');
  if (Buffer.byteLength(text, 'utf-8') > MAX_ENVELOPE_TEXT_BYTES) return fail('envelope_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('malformed_envelope');
  }
  return verifyEnvelope(parsed, options);
}

/**
 * Decodes a VERIFIED payload as UTF-8 JSON. Only a verified result can be passed in, so JSON is
 * never parsed before the signature has been checked. Invalid UTF-8 or invalid JSON is a safe
 * failure. The parsed value is still untrusted in SHAPE: callers must validate it.
 */
export function parseVerifiedJsonPayload(verified: VerifiedEnvelope): JsonPayloadResult {
  try {
    // fatal: invalid UTF-8 is an error, not silently replaced; ignoreBOM: a BOM stays and fails JSON
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(verified.payload);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, code: 'invalid_json', message: 'the verified payload is not valid UTF-8 JSON' };
  }
}
