/**
 * Company-issued authorization grants.
 *
 * A grant is a company statement: "this subject (with this public key) holds these roles until
 * this date." It is signed under the `grant` domain by a company key that the trust root trusts
 * for the `grant` purpose.
 *
 * WHAT A VERIFIED GRANT MEANS: the company authorized the named subject. It does NOT mean the
 * person making a request holds the subject's private key (proof of possession is a later phase),
 * that the grant is not revoked (see revocation.ts), or that any particular action is allowed.
 * Nothing here infers identity from a Git name, e-mail or operating-system user.
 *
 * Roles are the primary mechanism and must exist in the verified policy, which defines what each
 * role can do. An optional `permissionScope` may only NARROW what the roles give; it can never
 * add a permission. `effectivePermissions` computes the result but authorizes nothing.
 */

import type { KeyObject } from 'node:crypto';
import { deriveKeyId, importRawPublicKey } from './envelope.js';
import { LEVEL_POLICY_VERSION, isLevelId, type LevelId } from './levels.js';
import { NAME_PATTERN, isVerifiedPolicy, type PolicyDocument } from './policy.js';
import { verifyTrustedEnvelope, type ArtifactFailureCode } from './signedArtifact.js';
import { ORGANIZATION_ID, hasExactFields, isPlainObject, isValidatedTrustRoot, parseUtcTimestamp, type TrustRoot } from './trustRoot.js';
import type { KeyId } from './types.js';

export const GRANT_VERSION = 1 as const;
export const SUBJECT_TYPES = ['human', 'service'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** Longest allowed gap between notBefore and expiresAt. Short-lived grants limit the damage of a lost key. */
export const MAX_GRANT_LIFETIME_DAYS = 90;
export const MAX_GRANT_LIFETIME_MS = MAX_GRANT_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
export const MAX_GRANT_ROLES = 20;
export const MAX_GRANT_PERMISSIONS = 200;

/** Identifier shapes (also used by revocation lists, so both agree on what a grant id looks like). */
export const GRANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SUBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export interface GrantSubject {
  readonly id: string;
  readonly type: SubjectType;
  /** raw Ed25519 public key, strict Base64url. A grant never contains a private key. */
  readonly publicKey: string;
  readonly keyId: KeyId;
  /** optional human-readable name; it is inside the signed payload, so it cannot be changed without breaking the signature */
  readonly displayName?: string;
}

export interface GrantDocument {
  readonly version: typeof GRANT_VERSION;
  readonly grantId: string;
  readonly organization: string;
  readonly subject: GrantSubject;
  readonly roles: readonly string[];
  /** null = no narrowing; a list = only these permissions, and only those the roles already give */
  readonly permissionScope: readonly string[] | null;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  /** the grant is only valid under a company policy whose REVISION is at least this (not the document format version) */
  readonly minPolicyRevision: number;
}

export type GrantFailureCode =
  | ArtifactFailureCode
  | 'invalid_policy'
  | 'policy_not_current'
  | 'unsupported_grant_version'
  | 'grant_invalid'
  | 'organization_mismatch'
  | 'subject_key_invalid'
  | 'subject_key_id_mismatch'
  | 'subject_key_is_company_key'
  | 'grant_not_yet_valid'
  | 'grant_expired'
  | 'lifetime_exceeds_maximum'
  | 'policy_revision_too_old'
  | 'unknown_role'
  | 'unknown_permission'
  | 'permission_escalation';

const MESSAGES: Readonly<Record<GrantFailureCode, string>> = {
  invalid_trust_root: 'the trust root is not a validated trust root',
  invalid_evaluation_time: 'the evaluation time is not a valid date',
  envelope_malformed: 'the grant envelope is not a well-formed signed envelope',
  wrong_domain: 'the envelope was not signed for the grant domain',
  unknown_signing_key: 'the grant issuer key is not in the trust root',
  key_purpose_not_allowed: 'the issuer key is not trusted for signing grants',
  signing_key_not_yet_valid: 'the grant issuer key is not valid yet',
  signing_key_expired: 'the grant issuer key has expired',
  signature_verification_failed: 'the grant signature could not be verified',
  payload_not_json: 'the verified grant payload is not valid JSON',
  invalid_policy: 'the policy is not a verified company policy',
  policy_not_current: 'the policy is not in effect at the evaluation time',
  unsupported_grant_version: 'the grant format version is not supported',
  grant_invalid: 'the grant is invalid',
  organization_mismatch: 'the grant belongs to a different organization than the trust root and policy',
  subject_key_invalid: 'the grant subject key is not a valid Ed25519 public key',
  subject_key_id_mismatch: 'the grant subject key identifier does not match its public key',
  subject_key_is_company_key: 'the grant subject key is a company signing key',
  grant_not_yet_valid: 'the grant is not valid yet',
  grant_expired: 'the grant has expired',
  lifetime_exceeds_maximum: 'the grant lifetime exceeds the supported maximum',
  policy_revision_too_old: 'the grant requires a newer policy revision than the verified policy',
  unknown_role: 'the grant assigns a role the policy does not define',
  unknown_permission: 'the grant names a permission the policy does not define',
  permission_escalation: 'the grant scope names a permission that its roles do not give',
};

export interface GrantFailure {
  readonly ok: false;
  readonly code: GrantFailureCode;
  /** fixed, safe text; for grant_invalid it also names the (code-defined) location of the problem */
  readonly message: string;
  readonly envelopeCode?: string;
}

const failure = (code: GrantFailureCode, detail?: string, envelopeCode?: string): GrantFailure => ({
  ok: false,
  code,
  message: detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code],
  ...(envelopeCode ? { envelopeCode } : {}),
});

export interface VerifiedGrant {
  readonly ok: true;
  readonly grant: GrantDocument;
  /** the company key that signed it, from the trust root */
  readonly issuerKeyId: KeyId;
  /** the subject's key, for the future proof-of-possession check */
  readonly subjectPublicKey: KeyObject;
  /** the policy this grant was verified against: its identifier... */
  readonly policyId: string;
  /** ...and its revision */
  readonly policyRevision: number;
}

export type GrantResult = VerifiedGrant | GrantFailure;

const verifiedGrants = new WeakSet<object>();
/** True only for a result returned by a successful verifyGrant. */
export const isVerifiedGrant = (x: unknown): x is VerifiedGrant => typeof x === 'object' && x !== null && verifiedGrants.has(x);

// ---------------------------------------------------------------- schema

class SchemaError extends Error {}
const bad = (path: string, why: string): never => {
  throw new SchemaError(`${path} ${why}`);
};

const GRANT_FIELDS = ['version', 'grantId', 'organization', 'subject', 'roles', 'permissionScope', 'issuedAt', 'notBefore', 'expiresAt', 'minPolicyRevision'] as const;
const SUBJECT_FIELDS = ['id', 'type', 'publicKey', 'keyId'] as const;

function names(x: unknown, path: string, max: number): string[] {
  if (!Array.isArray(x)) return bad(path, 'must be a list');
  if (x.length > max) return bad(path, 'has too many entries');
  const seen = new Set<string>();
  for (const item of x as unknown[]) {
    if (typeof item !== 'string' || !NAME_PATTERN.test(item)) return bad(path, 'contains an invalid name');
    if (seen.has(item)) return bad(path, 'contains a duplicate');
    seen.add(item);
  }
  return [...seen];
}

/** Structure only: shape, types, duplicates and timestamp order. Policy-dependent checks come later. */
function buildGrant(value: unknown): GrantDocument {
  if (!isPlainObject(value) || !hasExactFields(value, GRANT_FIELDS)) return bad('grant', 'has missing or unexpected fields');
  const { grantId, organization, subject, issuedAt, notBefore, expiresAt, minPolicyRevision } = value;
  if (typeof grantId !== 'string' || !GRANT_ID_PATTERN.test(grantId)) return bad('grant.grantId', 'is invalid');
  if (typeof organization !== 'string' || !ORGANIZATION_ID.test(organization)) return bad('grant.organization', 'is invalid');

  if (!isPlainObject(subject) || !hasExactFields(subject, 'displayName' in subject ? [...SUBJECT_FIELDS, 'displayName'] : SUBJECT_FIELDS)) return bad('grant.subject', 'has missing or unexpected fields');
  if ('displayName' in subject && (typeof subject.displayName !== 'string' || subject.displayName.trim() === '' || subject.displayName.length > 80)) return bad('grant.subject.displayName', 'must be 1 to 80 characters');
  if (typeof subject.id !== 'string' || !SUBJECT_ID_PATTERN.test(subject.id)) return bad('grant.subject.id', 'is invalid');
  if (typeof subject.type !== 'string' || !(SUBJECT_TYPES as readonly string[]).includes(subject.type)) return bad('grant.subject.type', 'must be human or service');
  if (typeof subject.publicKey !== 'string' || subject.publicKey.length === 0 || subject.publicKey.length > 64) return bad('grant.subject.publicKey', 'is invalid');
  if (typeof subject.keyId !== 'string' || !/^[0-9a-f]{64}$/.test(subject.keyId)) return bad('grant.subject.keyId', 'is invalid');

  const roles = names(value.roles, 'grant.roles', MAX_GRANT_ROLES);
  const scope = value.permissionScope === null ? null : names(value.permissionScope, 'grant.permissionScope', MAX_GRANT_PERMISSIONS);

  const issued = parseUtcTimestamp(issuedAt);
  const from = parseUtcTimestamp(notBefore);
  const to = parseUtcTimestamp(expiresAt);
  if (issued === null || from === null || to === null) return bad('grant times', 'must be valid UTC timestamps');
  if (!(issued <= from && from < to)) return bad('grant times', 'must satisfy issuedAt <= notBefore < expiresAt');

  // same rule as a policy revision: a positive whole number that JSON can represent exactly
  if (typeof minPolicyRevision !== 'number' || !Number.isSafeInteger(minPolicyRevision) || minPolicyRevision < 1) {
    return bad('grant.minPolicyRevision', 'must be a positive whole number');
  }

  return Object.freeze({
    version: GRANT_VERSION,
    grantId,
    organization,
    subject: Object.freeze({ id: subject.id, type: subject.type as SubjectType, publicKey: subject.publicKey, keyId: subject.keyId, ...('displayName' in subject ? { displayName: subject.displayName as string } : {}) }),
    roles: Object.freeze(roles),
    permissionScope: scope === null ? null : Object.freeze(scope),
    issuedAt: issuedAt as string,
    notBefore: notBefore as string,
    expiresAt: expiresAt as string,
    minPolicyRevision,
  });
}

// ---------------------------------------------------------------- permissions

/** The permissions a set of roles gives under a policy, or null when a role is not defined by it. */
function rolePermissions(policy: PolicyDocument, roles: readonly string[]): Set<string> | null {
  const out = new Set<string>();
  for (const name of roles) {
    const role = policy.roles.find((r) => r.name === name);
    if (!role) return null;
    for (const p of role.permissions) out.add(p);
  }
  return out;
}

// ---------------------------------------------------------------- verification

/**
 * Verifies a signed grant (envelope object or JSON text) against a validated trust root and a
 * verified policy at an injected time. Never throws. Nothing in the grant is trusted before the
 * signature has been verified with a trust-root key that has the `grant` purpose.
 */
export function verifyGrant(input: unknown, trustRoot: TrustRoot, policy: PolicyDocument, now: Date): GrantResult {
  try {
    return verifyUnchecked(input, trustRoot, policy, now);
  } catch {
    return failure('signature_verification_failed');
  }
}

function verifyUnchecked(input: unknown, trustRoot: TrustRoot, policy: PolicyDocument, now: Date): GrantResult {
  if (!isVerifiedPolicy(policy)) return failure('invalid_policy');
  if (!isValidatedTrustRoot(trustRoot)) return failure('invalid_trust_root');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return failure('invalid_evaluation_time');

  const artifact = verifyTrustedEnvelope(input, 'grant', 'grant', trustRoot, now);
  if (!artifact.ok) return failure(artifact.code, undefined, artifact.envelopeCode);

  // only now is the payload interpreted
  const raw = artifact.value;
  if (!isPlainObject(raw) || raw.version !== GRANT_VERSION) return failure('unsupported_grant_version');
  let grant: GrantDocument;
  try {
    grant = buildGrant(raw);
  } catch (err) {
    return failure('grant_invalid', err instanceof SchemaError ? err.message : undefined);
  }

  // the grant, the trust root and the policy must all belong to the same organization
  if (grant.organization !== trustRoot.organization || grant.organization !== policy.organization) return failure('organization_mismatch');

  // the subject's key: valid, self-consistent, and never a company signing key
  let subjectKey: KeyObject;
  try {
    subjectKey = importRawPublicKey(grant.subject.publicKey);
  } catch {
    return failure('subject_key_invalid');
  }
  if (deriveKeyId(subjectKey) !== grant.subject.keyId) return failure('subject_key_id_mismatch');
  if (grant.subject.keyId === artifact.signingKeyId || trustRoot.keys.some((k) => k.keyId === grant.subject.keyId)) return failure('subject_key_is_company_key');

  // time (the policy must be in effect too: a grant is only meaningful under a current policy)
  const t = now.getTime();
  if (t < (parseUtcTimestamp(policy.effectiveAt) as number) || t >= (parseUtcTimestamp(policy.expiresAt) as number)) return failure('policy_not_current');
  const from = parseUtcTimestamp(grant.notBefore) as number;
  const to = parseUtcTimestamp(grant.expiresAt) as number;
  if (to - from > MAX_GRANT_LIFETIME_MS) return failure('lifetime_exceeds_maximum');
  if (t < from) return failure('grant_not_yet_valid');
  if (t >= to) return failure('grant_expired');

  // the company policy REVISION (not the document format version). Meeting the minimum is one
  // prerequisite only: it neither authorizes anything nor proves no newer policy exists.
  if (policy.revision < grant.minPolicyRevision) return failure('policy_revision_too_old');

  // under a level policy (version 3) a grant binds the subject to EXACTLY ONE CodeXRev level; changing the level
  // means a new grant signed by the administrator (the roles are inside the signed payload)
  if (policy.version === LEVEL_POLICY_VERSION && !(grant.roles.length === 1 && isLevelId(grant.roles[0]))) return failure('grant_invalid', 'grant.roles must be exactly one CodeXRev level (l1 to l5)');

  // roles and permissions against the signed policy
  const given = rolePermissions(policy, grant.roles);
  if (given === null) return failure('unknown_role');
  if (grant.permissionScope) {
    const known = new Set(policy.permissions);
    for (const p of grant.permissionScope) if (!known.has(p)) return failure('unknown_permission');
    for (const p of grant.permissionScope) if (!given.has(p)) return failure('permission_escalation');
  }

  const result: VerifiedGrant = Object.freeze({
    ok: true as const,
    grant,
    issuerKeyId: artifact.signingKeyId,
    subjectPublicKey: subjectKey,
    policyId: policy.policyId,
    policyRevision: policy.revision,
  });
  verifiedGrants.add(result);
  return result;
}

/** The CodeXRev level a verified grant assigns, or undefined for a grant under a generic (version 2) policy. */
export function levelOf(verified: VerifiedGrant): LevelId | undefined {
  if (!isVerifiedGrant(verified)) return undefined;
  const [only] = verified.grant.roles;
  return verified.grant.roles.length === 1 && isLevelId(only) ? only : undefined;
}

// ---------------------------------------------------------------- effective permissions

export type EffectivePermissionsResult =
  | { readonly ok: true; readonly roles: readonly string[]; readonly permissions: readonly string[] }
  | { readonly ok: false; readonly code: 'invalid_grant' | 'invalid_policy' | 'policy_mismatch' | 'unknown_role' };

/**
 * The permissions a verified grant carries under a verified policy: what the assigned roles give,
 * narrowed (never widened) by the grant's permission scope. Sorted and deterministic. This does
 * NOT authorize anything: a later phase compares it with `requirementsFor(...)` and checks that
 * the requester holds the subject's private key and that the grant is not revoked.
 */
export function effectivePermissions(verified: VerifiedGrant, policy: PolicyDocument): EffectivePermissionsResult {
  if (!isVerifiedGrant(verified)) return { ok: false, code: 'invalid_grant' };
  if (!isVerifiedPolicy(policy)) return { ok: false, code: 'invalid_policy' };
  // the grant was verified against one specific policy revision; a different one (even a newer
  // revision with the same id) can change what a role means, so the grant must be verified again
  if (policy.policyId !== verified.policyId || policy.revision !== verified.policyRevision || policy.organization !== verified.grant.organization) {
    return { ok: false, code: 'policy_mismatch' };
  }
  const given = rolePermissions(policy, verified.grant.roles);
  if (given === null) return { ok: false, code: 'unknown_role' };
  const scope = verified.grant.permissionScope;
  const permissions = [...given].filter((p) => scope === null || scope.includes(p)).sort();
  return { ok: true, roles: [...verified.grant.roles].sort(), permissions };
}
