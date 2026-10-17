/**
 * Signed revocation lists, and checking a grant against one.
 *
 * A list is signed under the `revocation` domain by a company key trusted for the `revocation`
 * purpose (a grant-signing key cannot sign it, and a revocation key cannot sign grants).
 *
 * Absence from a list is NOT proof that a grant is active. A grant is "not listed" only in a
 * verified, fresh, same-organization list; otherwise its status is "unavailable", and callers
 * must treat unavailable exactly like a failure to authorize. Even "not listed" is only one
 * prerequisite for authorization.
 *
 * OFFLINE LIMITATION: a stateless verifier cannot know it holds the NEWEST list. A list that is
 * authentic and still within its freshness window may predate a revocation issued after it, and an
 * attacker who can withhold updates can keep serving an older list until it goes stale. The
 * freshness window bounds that exposure; closing it needs a protected update mechanism (and
 * persistent tracking of the highest `listVersion` seen), which is a later integration step.
 */

import type { KeyId } from './types.js';
import { GRANT_ID_PATTERN, isVerifiedGrant, type VerifiedGrant } from './grant.js';
import { verifyTrustedEnvelope, type ArtifactFailureCode } from './signedArtifact.js';
import { ORGANIZATION_ID, hasExactFields, isPlainObject, isValidatedTrustRoot, parseUtcTimestamp, type TrustRoot } from './trustRoot.js';

export const REVOCATION_LIST_VERSION = 1 as const;

/** How old (since issuedAt) a list may be and still count as fresh. */
export const DEFAULT_MAX_LIST_AGE_HOURS = 72;
/** The most a caller may relax freshness to, and the longest nextUpdate gap a list may declare. */
export const MAX_LIST_AGE_HOURS_LIMIT = 24 * 30;
export const MAX_REVOCATION_ENTRIES = 10_000;

const HOUR_MS = 3_600_000;

export type RevocationFailureCode =
  | ArtifactFailureCode
  | 'invalid_options'
  | 'unsupported_list_version'
  | 'list_invalid'
  | 'organization_mismatch'
  | 'list_not_yet_issued'
  | 'list_expired'
  | 'list_stale';

const MESSAGES: Readonly<Record<RevocationFailureCode, string>> = {
  invalid_trust_root: 'the trust root is not a validated trust root',
  invalid_evaluation_time: 'the evaluation time is not a valid date',
  envelope_malformed: 'the revocation list envelope is not a well-formed signed envelope',
  wrong_domain: 'the envelope was not signed for the revocation domain',
  unknown_signing_key: 'the revocation list signing key is not in the trust root',
  key_purpose_not_allowed: 'the signing key is not trusted for signing revocation lists',
  signing_key_not_yet_valid: 'the revocation list signing key is not valid yet',
  signing_key_expired: 'the revocation list signing key has expired',
  signature_verification_failed: 'the revocation list signature could not be verified',
  payload_not_json: 'the verified revocation list payload is not valid JSON',
  invalid_options: 'the freshness option is not valid',
  unsupported_list_version: 'the revocation list format version is not supported',
  list_invalid: 'the revocation list is invalid',
  organization_mismatch: 'the revocation list belongs to a different organization than the trust root',
  list_not_yet_issued: 'the revocation list is issued in the future',
  list_expired: 'the revocation list has passed its next-update time',
  list_stale: 'the revocation list is older than the allowed freshness window',
};

export interface RevocationFailure {
  readonly ok: false;
  readonly code: RevocationFailureCode;
  readonly message: string;
  readonly envelopeCode?: string;
}

const failure = (code: RevocationFailureCode, detail?: string, envelopeCode?: string): RevocationFailure => ({
  ok: false,
  code,
  message: detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code],
  ...(envelopeCode ? { envelopeCode } : {}),
});

export interface RevocationListDocument {
  readonly version: typeof REVOCATION_LIST_VERSION;
  readonly organization: string;
  /** increases with every list the company issues */
  readonly listVersion: number;
  readonly issuedAt: string;
  readonly nextUpdate: string;
  readonly revokedGrantIds: readonly string[];
  readonly revokedSubjectKeyIds: readonly KeyId[];
  readonly revokedIssuerKeyIds: readonly KeyId[];
}

export interface VerifiedRevocationList {
  readonly ok: true;
  readonly list: RevocationListDocument;
  readonly signingKeyId: KeyId;
  /** the freshness window this list was verified under, re-applied when a grant is checked */
  readonly maxAgeMs: number;
}

export type RevocationListResult = VerifiedRevocationList | RevocationFailure;

const verifiedLists = new WeakSet<object>();
export const isVerifiedRevocationList = (x: unknown): x is VerifiedRevocationList => typeof x === 'object' && x !== null && verifiedLists.has(x);

// ---------------------------------------------------------------- schema

class SchemaError extends Error {}
const bad = (path: string, why: string): never => {
  throw new SchemaError(`${path} ${why}`);
};

const FIELDS = ['version', 'organization', 'listVersion', 'issuedAt', 'nextUpdate', 'revokedGrantIds', 'revokedSubjectKeyIds', 'revokedIssuerKeyIds'] as const;
const KEY_ID = /^[0-9a-f]{64}$/;

function entries(x: unknown, path: string, pattern: RegExp): string[] {
  if (!Array.isArray(x)) return bad(path, 'must be a list');
  if (x.length > MAX_REVOCATION_ENTRIES) return bad(path, 'has too many entries');
  const seen = new Set<string>();
  for (const item of x as unknown[]) {
    if (typeof item !== 'string' || !pattern.test(item)) return bad(path, 'contains a malformed entry');
    if (seen.has(item)) return bad(path, 'contains a duplicate');
    seen.add(item);
  }
  return [...seen];
}

function buildList(value: unknown): RevocationListDocument {
  if (!isPlainObject(value) || !hasExactFields(value, FIELDS)) return bad('list', 'has missing or unexpected fields');
  const { organization, listVersion, issuedAt, nextUpdate } = value;
  if (typeof organization !== 'string' || !ORGANIZATION_ID.test(organization)) return bad('list.organization', 'is invalid');
  if (typeof listVersion !== 'number' || !Number.isInteger(listVersion) || listVersion < 1 || listVersion > Number.MAX_SAFE_INTEGER) {
    return bad('list.listVersion', 'must be a positive whole number');
  }
  const issued = parseUtcTimestamp(issuedAt);
  const next = parseUtcTimestamp(nextUpdate);
  if (issued === null || next === null) return bad('list times', 'must be valid UTC timestamps');
  if (!(issued < next)) return bad('list times', 'must satisfy issuedAt < nextUpdate');
  if (next - issued > MAX_LIST_AGE_HOURS_LIMIT * HOUR_MS) return bad('list times', 'span longer than the supported maximum');

  return Object.freeze({
    version: REVOCATION_LIST_VERSION,
    organization,
    listVersion,
    issuedAt: issuedAt as string,
    nextUpdate: nextUpdate as string,
    revokedGrantIds: Object.freeze(entries(value.revokedGrantIds, 'list.revokedGrantIds', GRANT_ID_PATTERN)),
    revokedSubjectKeyIds: Object.freeze(entries(value.revokedSubjectKeyIds, 'list.revokedSubjectKeyIds', KEY_ID)),
    revokedIssuerKeyIds: Object.freeze(entries(value.revokedIssuerKeyIds, 'list.revokedIssuerKeyIds', KEY_ID)),
  });
}

// ---------------------------------------------------------------- freshness

type Freshness = 'fresh' | 'not_yet_issued' | 'expired' | 'stale';

function freshness(list: RevocationListDocument, now: number, maxAgeMs: number): Freshness {
  const issued = parseUtcTimestamp(list.issuedAt) as number;
  const next = parseUtcTimestamp(list.nextUpdate) as number;
  if (now < issued) return 'not_yet_issued';
  if (now >= next) return 'expired';
  if (now - issued > maxAgeMs) return 'stale';
  return 'fresh';
}

export interface VerifyRevocationOptions {
  /** how old a list may be, in hours (default 72, at most 720). A list older than this is stale even before nextUpdate. */
  readonly maxAgeHours?: number;
}

// ---------------------------------------------------------------- verification

/**
 * Verifies a signed revocation list (envelope object or JSON text) against a validated trust root
 * at an injected time. Never throws. A list that is not authentic, not from this organization,
 * issued in the future, past its next-update time or older than the freshness window is a
 * failure, never an empty list.
 */
export function verifyRevocationList(input: unknown, trustRoot: TrustRoot, now: Date, options: VerifyRevocationOptions = {}): RevocationListResult {
  try {
    if (!isValidatedTrustRoot(trustRoot)) return failure('invalid_trust_root');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return failure('invalid_evaluation_time');
    const hours = options?.maxAgeHours ?? DEFAULT_MAX_LIST_AGE_HOURS;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > MAX_LIST_AGE_HOURS_LIMIT) return failure('invalid_options');
    const maxAgeMs = hours * HOUR_MS;

    const artifact = verifyTrustedEnvelope(input, 'revocation', 'revocation', trustRoot, now);
    if (!artifact.ok) return failure(artifact.code, undefined, artifact.envelopeCode);

    const raw = artifact.value;
    if (!isPlainObject(raw) || raw.version !== REVOCATION_LIST_VERSION) return failure('unsupported_list_version');
    let list: RevocationListDocument;
    try {
      list = buildList(raw);
    } catch (err) {
      return failure('list_invalid', err instanceof SchemaError ? err.message : undefined);
    }
    if (list.organization !== trustRoot.organization) return failure('organization_mismatch');

    const state = freshness(list, now.getTime(), maxAgeMs);
    if (state === 'not_yet_issued') return failure('list_not_yet_issued');
    if (state === 'expired') return failure('list_expired');
    if (state === 'stale') return failure('list_stale');

    const result: VerifiedRevocationList = Object.freeze({ ok: true as const, list, signingKeyId: artifact.signingKeyId, maxAgeMs });
    verifiedLists.add(result);
    return result;
  } catch {
    return failure('signature_verification_failed');
  }
}

// ---------------------------------------------------------------- checking a grant

export type RevokedBy = 'grant_id' | 'subject_key' | 'issuer_key';

export type UnavailableReason =
  | 'no_list'
  | 'list_unverified'
  | 'grant_unverified'
  | 'invalid_evaluation_time'
  | 'organization_mismatch'
  | 'list_not_yet_issued'
  | 'list_expired'
  | 'list_stale';

export type RevocationStatus =
  /** the verified list names the grant, its subject key or its issuer key: not usable */
  | { readonly status: 'revoked'; readonly revokedBy: readonly RevokedBy[]; readonly listVersion: number }
  /** a verified, fresh list does not mention it. NOT authorization: only one prerequisite. */
  | { readonly status: 'not_listed'; readonly listVersion: number; readonly listIssuedAt: string; readonly listNextUpdate: string }
  /** revocation status cannot be established: treat exactly like "not authorized" */
  | { readonly status: 'unavailable'; readonly reason: UnavailableReason };

/**
 * Pure revocation check. `list` is the result of verifyRevocationList, or undefined when no list
 * is available; a failed or missing list is `unavailable`, never "not revoked". Freshness is
 * re-applied at `now`.
 *
 * An explicit entry always wins: a grant named by an authentic list is revoked even if that list
 * has since gone stale, because an old revocation never un-revokes anything.
 */
export function checkRevocation(grant: VerifiedGrant, list: RevocationListResult | undefined, now: Date): RevocationStatus {
  if (!isVerifiedGrant(grant)) return { status: 'unavailable', reason: 'grant_unverified' };
  if (list === undefined || list === null) return { status: 'unavailable', reason: 'no_list' };
  if (!isVerifiedRevocationList(list)) return { status: 'unavailable', reason: 'list_unverified' };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { status: 'unavailable', reason: 'invalid_evaluation_time' };
  if (list.list.organization !== grant.grant.organization) return { status: 'unavailable', reason: 'organization_mismatch' };

  const revokedBy: RevokedBy[] = [];
  if (list.list.revokedGrantIds.includes(grant.grant.grantId)) revokedBy.push('grant_id');
  if (list.list.revokedSubjectKeyIds.includes(grant.grant.subject.keyId)) revokedBy.push('subject_key');
  if (list.list.revokedIssuerKeyIds.includes(grant.issuerKeyId)) revokedBy.push('issuer_key');
  if (revokedBy.length > 0) return { status: 'revoked', revokedBy, listVersion: list.list.listVersion };

  const state = freshness(list.list, now.getTime(), list.maxAgeMs);
  if (state === 'not_yet_issued') return { status: 'unavailable', reason: 'list_not_yet_issued' };
  if (state === 'expired') return { status: 'unavailable', reason: 'list_expired' };
  if (state === 'stale') return { status: 'unavailable', reason: 'list_stale' };
  return { status: 'not_listed', listVersion: list.list.listVersion, listIssuedAt: list.list.issuedAt, listNextUpdate: list.list.nextUpdate };
}
