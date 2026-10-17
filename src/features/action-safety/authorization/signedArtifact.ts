/**
 * The common first half of verifying any company-signed artifact (grants, revocation lists):
 *
 *   validated trust root -> envelope is for the expected domain -> signing key found in the trust
 *   root -> key trusted for the expected PURPOSE -> key inside its validity window -> signature
 *   (Phase 1 verifier) -> only then is the payload parsed as JSON.
 *
 * The signing key is only ever resolved from the trust root, never from the artifact. Whatever
 * the payload says is untrusted in shape until the caller validates it. Never throws.
 */

import { parseVerifiedJsonPayload, verifyEnvelope } from './envelope.js';
import { MAX_ENVELOPE_TEXT_BYTES, type KeyId, type SigningDomain, type VerifyFailureCode } from './types.js';
import { findTrustedKey, isPlainObject, isValidatedTrustRoot, type KeyPurpose, type TrustRoot, type TrustedKey } from './trustRoot.js';

export type ArtifactFailureCode =
  | 'invalid_trust_root'
  | 'invalid_evaluation_time'
  | 'envelope_malformed'
  | 'wrong_domain'
  | 'unknown_signing_key'
  | 'key_purpose_not_allowed'
  | 'signing_key_not_yet_valid'
  | 'signing_key_expired'
  | 'signature_verification_failed'
  | 'payload_not_json';

export const ARTIFACT_MESSAGES: Readonly<Record<ArtifactFailureCode, string>> = {
  invalid_trust_root: 'the trust root is not a validated trust root',
  invalid_evaluation_time: 'the evaluation time is not a valid date',
  envelope_malformed: 'the envelope is not a well-formed signed envelope',
  wrong_domain: 'the envelope was not signed for the expected domain',
  unknown_signing_key: 'the signing key is not in the trust root',
  key_purpose_not_allowed: 'the signing key is not trusted for this purpose',
  signing_key_not_yet_valid: 'the signing key is not valid yet',
  signing_key_expired: 'the signing key has expired',
  signature_verification_failed: 'the signature could not be verified',
  payload_not_json: 'the verified payload is not valid JSON',
};

export interface ArtifactFailure {
  readonly ok: false;
  readonly code: ArtifactFailureCode;
  readonly message: string;
  /** the Phase 1 failure code, when envelope or signature verification was the cause */
  readonly envelopeCode?: VerifyFailureCode;
}

export interface VerifiedArtifact {
  readonly ok: true;
  /** the parsed JSON payload: signature-verified, but still untrusted in SHAPE */
  readonly value: unknown;
  readonly signingKey: TrustedKey;
  readonly signingKeyId: KeyId;
}

const failure = (code: ArtifactFailureCode, envelopeCode?: VerifyFailureCode): ArtifactFailure => ({
  ok: false,
  code,
  message: ARTIFACT_MESSAGES[code],
  ...(envelopeCode ? { envelopeCode } : {}),
});

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

export function verifyTrustedEnvelope(input: unknown, domain: SigningDomain, purpose: KeyPurpose, trustRoot: TrustRoot, now: Date): VerifiedArtifact | ArtifactFailure {
  try {
    if (!isValidatedTrustRoot(trustRoot)) return failure('invalid_trust_root');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return failure('invalid_evaluation_time');

    let envelope = input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf-8') > MAX_ENVELOPE_TEXT_BYTES) return failure('envelope_malformed');
      try {
        envelope = JSON.parse(input);
      } catch {
        return failure('envelope_malformed');
      }
    }
    if (!isPlainObject(envelope)) return failure('envelope_malformed');

    // read only what is needed to FIND the trusted key; the Phase 1 verifier re-checks everything
    if (envelope.domain !== domain) return failure('wrong_domain');
    const lookup = findTrustedKey(trustRoot, envelope.keyId, purpose, now);
    if (!lookup.ok) {
      const map = {
        invalid_trust_root: 'invalid_trust_root',
        invalid_evaluation_time: 'invalid_evaluation_time',
        unknown_key: 'unknown_signing_key',
        purpose_not_allowed: 'key_purpose_not_allowed',
        key_not_yet_valid: 'signing_key_not_yet_valid',
        key_expired: 'signing_key_expired',
      } as const;
      return failure(map[lookup.code]);
    }

    const result = verifyEnvelope(envelope, { expectedDomain: domain, trustedPublicKey: lookup.key.publicKey });
    if (!result.ok) {
      if (result.code === 'domain_mismatch' || result.code === 'unknown_domain') return failure('wrong_domain', result.code);
      return failure(MALFORMED.includes(result.code) ? 'envelope_malformed' : 'signature_verification_failed', result.code);
    }

    // only now is the payload parsed
    const parsed = parseVerifiedJsonPayload(result);
    if (!parsed.ok) return failure('payload_not_json');
    return { ok: true, value: parsed.value, signingKey: lookup.key, signingKeyId: lookup.key.keyId };
  } catch {
    return failure('signature_verification_failed');
  }
}
