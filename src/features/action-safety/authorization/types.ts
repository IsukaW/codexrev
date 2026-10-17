/**
 * Types and constants for the Ed25519 signed-envelope foundation.
 *
 * Scope of this layer: it can prove that SOME private key signed exact bytes
 * for a stated purpose (the signing domain). It says nothing about whether
 * that key is trusted, whether the signer is allowed to do anything, or
 * whether the content means what it claims. Those are later phases.
 */

import { CodexrevError } from '../../../utils/errors.js';

/** Envelope format version. A different value is rejected, never "best-effort" read. */
export const ENVELOPE_FORMAT_VERSION = 1 as const;

/**
 * What an envelope is for. A signature made for one domain never verifies for another.
 *
 *   policy / grant / proof / revocation   authorization artifacts
 *   challenge / receipt                              a challenge store's signed challenge token, and its
 *                                                    signed consumption receipt (authorization artifacts,
 *                                                    signed by a `challenge_store` key)
 *   journal                                          an entry of the challenge store's append-only recovery
 *                                                    journal (signed by the store's `challenge_store` key)
 *   evidence_pack                                    the signed Evidence Pack (a separate feature;
 *                                                    reserved here only so it stays separate)
 */
export const SIGNING_DOMAINS = ['policy', 'grant', 'proof', 'revocation', 'challenge', 'receipt', 'journal', 'evidence_pack'] as const;
export type SigningDomain = (typeof SIGNING_DOMAINS)[number];

export function isSigningDomain(x: unknown): x is SigningDomain {
  return typeof x === 'string' && (SIGNING_DOMAINS as readonly string[]).includes(x);
}

/**
 * Each domain family signs under its own namespace string, so the Evidence Pack can
 * never be confused with an authorization artifact even if the same key signed both
 * (which our key rules will also forbid in a later phase).
 */
export const AUTHORIZATION_NAMESPACE = 'CODEXREV-AUTHZ-ENVELOPE-V1';
export const PROVENANCE_NAMESPACE = 'CODEXREV-PROVENANCE-ENVELOPE-V1';

export const DOMAIN_NAMESPACES: Readonly<Record<SigningDomain, string>> = {
  policy: AUTHORIZATION_NAMESPACE,
  grant: AUTHORIZATION_NAMESPACE,
  proof: AUTHORIZATION_NAMESPACE,
  revocation: AUTHORIZATION_NAMESPACE,
  challenge: AUTHORIZATION_NAMESPACE,
  receipt: AUTHORIZATION_NAMESPACE,
  journal: AUTHORIZATION_NAMESPACE,
  evidence_pack: PROVENANCE_NAMESPACE,
};

/** Largest payload accepted, in bytes. Checked before anything expensive happens. */
export const MAX_PAYLOAD_BYTES = 1_048_576;
/** Longest possible Base64url text for a maximum-size payload (no padding). */
export const MAX_ENCODED_PAYLOAD_CHARS = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3);
/** Longest serialized envelope accepted by verifyEnvelopeText. */
export const MAX_ENVELOPE_TEXT_BYTES = MAX_ENCODED_PAYLOAD_CHARS + 4096;

export const ED25519_SIGNATURE_BYTES = 64;
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** Key identifier: lowercase hex SHA-256 of the raw 32-byte Ed25519 public key (64 characters). */
export type KeyId = string;

/**
 * The signed envelope. Exactly these five fields; anything else is rejected.
 * There is deliberately NO public-key field: the verifier is always given the
 * trusted key from outside and never takes one from the envelope.
 */
export interface SignedEnvelope {
  readonly version: typeof ENVELOPE_FORMAT_VERSION;
  readonly domain: SigningDomain;
  /** which key the signer says it used; checked against the trusted key, never used to find one */
  readonly keyId: KeyId;
  /** the exact signed bytes, Base64url without padding */
  readonly payload: string;
  /** Ed25519 signature (64 bytes), Base64url without padding */
  readonly signature: string;
}

/** Why verification (or JSON decoding) failed. Distinguishes "malformed" from "signature does not match". */
export type VerifyFailureCode =
  | 'malformed_envelope'
  | 'envelope_too_large'
  | 'unsupported_version'
  | 'unknown_domain'
  | 'domain_mismatch'
  | 'malformed_payload_encoding'
  | 'empty_payload'
  | 'payload_too_large'
  | 'malformed_signature_encoding'
  | 'invalid_signature_length'
  | 'invalid_public_key'
  | 'key_id_mismatch'
  | 'signature_invalid';

export interface VerifiedEnvelope {
  readonly ok: true;
  readonly domain: SigningDomain;
  readonly keyId: KeyId;
  /** the exact bytes that were signed and verified */
  readonly payload: Buffer;
}

export interface VerificationFailure {
  readonly ok: false;
  readonly code: VerifyFailureCode;
  /** fixed, safe text: never contains payload, signature or key material */
  readonly message: string;
}

export type VerifyResult = VerifiedEnvelope | VerificationFailure;

export type JsonPayloadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: 'invalid_json'; readonly message: string };

export type CryptoErrorReason = 'unknown_domain' | 'empty_payload' | 'payload_too_large' | 'invalid_private_key' | 'invalid_public_key';

/**
 * Thrown by the TRUSTED-side functions (signing, key derivation/import), whose inputs come
 * from code or administrators. Messages are fixed text and never include key material.
 * Verification of untrusted artifacts never throws: it returns a VerificationFailure.
 */
export class AuthorizationCryptoError extends CodexrevError {
  constructor(
    readonly reason: CryptoErrorReason,
    message: string,
  ) {
    super(message, 'CODEXREV_AUTHZ_CRYPTO_ERROR', false);
    this.name = 'AuthorizationCryptoError';
  }
}
