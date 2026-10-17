/**
 * The signed company authorization policy.
 *
 * The company, not the developer, decides what an action needs. A policy says which roles may
 * perform which action in which environment and which permissions they must hold. There is no
 * per-action approval: authority comes from signed role-based grants. It is signed by a company key that
 * the locally installed trust root authorizes for the `policy` purpose.
 *
 * Verification order (each step fails closed with an explicit code):
 *   validated trust root -> envelope is for the `policy` domain -> signing key is in the trust
 *   root -> key is trusted for `policy` -> key is within its validity window -> signature (Phase 1
 *   verifier) -> ONLY THEN parse the payload -> version -> schema -> organization -> time window.
 *
 * A policy can never redefine its own signing authority: the schema has no key fields at all, and
 * the signing key is looked up in the trust root, never in the policy.
 *
 * Deny by default: a rule exists only for an (action, environment) pair the policy explicitly
 * allows. Anything else is denied. This module only says what must be PROVEN; it never accepts
 * a developer's claimed roles or permissions (grants are verified separately).
 *
 * Two different numbers: `version` is the document FORMAT version (how to read the file) and
 * `revision` is the company's POLICY revision (which edition of the rules this is). Grants state
 * the minimum revision they were issued for.
 *
 * Limitation (rollback): a stateless local verifier cannot tell that an older, still-valid signed
 * policy has replaced a newer one. Comparing revisions does NOT fix this: an attacker who supplies
 * an old policy supplies its old revision too. Anti-rollback needs persistent, administrator-
 * protected tracking of the highest revision seen, which is a later integration requirement and
 * is deliberately not faked here.
 */

import { parseVerifiedJsonPayload, verifyEnvelope } from './envelope.js';
import { MAX_ENVELOPE_TEXT_BYTES, type KeyId, type VerifyFailureCode } from './types.js';
import { ACTION_TYPES, TARGET_ENVIRONMENTS, type ActionType, type TargetEnvironment } from '../model/types.js';
import { LEVEL_POLICY_VERSION, levelPolicyMismatch } from './levels.js';
import { ORGANIZATION_ID, findTrustedKey, hasExactFields, isPlainObject, isValidatedTrustRoot, parseUtcTimestamp, type TrustRoot } from './trustRoot.js';

/**
 * Policy format versions. Version 1 (per-action approvals) is rejected, never reinterpreted.
 * Version 2 is the generic role/permission format. Version 3 is the CodeXRev level format: it must contain EXACTLY
 * the five levels, permissions and rules of the registry in levels.ts (anything else is refused). Version 3 is the
 * current version; the strict tooling requires it, so nothing is silently downgraded to a custom-role policy.
 */
export const POLICY_VERSION = LEVEL_POLICY_VERSION;
export const SUPPORTED_POLICY_VERSIONS = [2, LEVEL_POLICY_VERSION] as const;
export type PolicyVersion = (typeof SUPPORTED_POLICY_VERSIONS)[number];

export const MAX_POLICY_ROLES = 50;
export const MAX_POLICY_PERMISSIONS = 200;
export const MAX_POLICY_RULES = 200;

// ---------------------------------------------------------------- types

export interface PolicyRole {
  readonly name: string;
  readonly permissions: readonly string[];
}

export interface PolicyRule {
  readonly action: ActionType;
  readonly environment: TargetEnvironment;
  /** the requester must hold at least one of these roles */
  readonly allowedRoles: readonly string[];
  /** ...and every one of these permissions */
  readonly requiredPermissions: readonly string[];
}

export interface PolicyDocument {
  /** the document FORMAT version (how to read this file). Not the company's policy revision. */
  readonly version: PolicyVersion;
  readonly organization: string;
  readonly policyId: string;
  /**
   * The company's policy revision: a positive safe integer the company increments with each new
   * policy. It is inside the signed payload, so it cannot be altered without breaking the signature.
   * Comparing revisions is NOT rollback protection: a stateless verifier cannot know that a higher
   * revision ever existed (see the header note).
   */
  readonly revision: number;
  readonly issuedAt: string;
  readonly effectiveAt: string;
  readonly expiresAt: string;
  /** the catalogue of permission names this policy knows */
  readonly permissions: readonly string[];
  readonly roles: readonly PolicyRole[];
  readonly rules: readonly PolicyRule[];
}

export type PolicyFailureCode =
  | 'invalid_trust_root'
  | 'invalid_evaluation_time'
  | 'envelope_malformed'
  | 'wrong_domain'
  | 'unknown_signing_key'
  | 'key_purpose_not_allowed'
  | 'signing_key_not_yet_valid'
  | 'signing_key_expired'
  | 'signature_verification_failed'
  | 'payload_not_json'
  | 'unsupported_policy_version'
  | 'policy_invalid'
  | 'organization_mismatch'
  | 'policy_not_yet_effective'
  | 'policy_expired';

const MESSAGES: Readonly<Record<PolicyFailureCode, string>> = {
  invalid_trust_root: 'the trust root is not a validated trust root',
  invalid_evaluation_time: 'the evaluation time is not a valid date',
  envelope_malformed: 'the policy envelope is not a well-formed signed envelope',
  wrong_domain: 'the envelope was not signed for the policy domain',
  unknown_signing_key: 'the policy signing key is not in the trust root',
  key_purpose_not_allowed: 'the signing key is not trusted for signing policies',
  signing_key_not_yet_valid: 'the policy signing key is not valid yet',
  signing_key_expired: 'the policy signing key has expired',
  signature_verification_failed: 'the policy signature could not be verified',
  payload_not_json: 'the verified policy payload is not valid JSON',
  unsupported_policy_version: 'the policy format version is not supported',
  policy_invalid: 'the policy is invalid',
  organization_mismatch: 'the policy belongs to a different organization than the trust root',
  policy_not_yet_effective: 'the policy is not effective yet',
  policy_expired: 'the policy has expired',
};

export interface PolicyFailure {
  readonly ok: false;
  readonly code: PolicyFailureCode;
  /** fixed, safe text; for policy_invalid it also names the (code-defined) location of the problem */
  readonly message: string;
  /** the Phase 1 failure code, when signature/envelope verification was the cause */
  readonly envelopeCode?: VerifyFailureCode;
}

const failure = (code: PolicyFailureCode, detail?: string, envelopeCode?: VerifyFailureCode): PolicyFailure => ({
  ok: false,
  code,
  message: detail ? `${MESSAGES[code]}: ${detail}` : MESSAGES[code],
  ...(envelopeCode ? { envelopeCode } : {}),
});

export interface VerifiedPolicy {
  readonly ok: true;
  readonly policy: PolicyDocument;
  /** the trust-root key that signed it */
  readonly signingKeyId: KeyId;
}

export type PolicyResult = VerifiedPolicy | PolicyFailure;

/** Only policies that passed verifyPolicy are accepted by requirementsFor. */
const verified = new WeakSet<object>();

/** True only for a policy object returned by a successful verifyPolicy. Later phases use it to refuse unverified policies. */
export const isVerifiedPolicy = (x: unknown): x is PolicyDocument => typeof x === 'object' && x !== null && verified.has(x);

/** The shape of role and permission names, shared so grants cannot use a different notion of a valid name. */
export const NAME_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;

// ---------------------------------------------------------------- schema validation

class SchemaError extends Error {}
const bad = (path: string, why: string): never => {
  throw new SchemaError(`${path} ${why}`);
};

const NAME = NAME_PATTERN;
const POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const POLICY_FIELDS = ['version', 'organization', 'policyId', 'revision', 'issuedAt', 'effectiveAt', 'expiresAt', 'permissions', 'roles', 'rules'] as const;
const ROLE_FIELDS = ['name', 'permissions'] as const;
const RULE_FIELDS = ['action', 'environment', 'allowedRoles', 'requiredPermissions'] as const;

function exact(x: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(x)) return bad(path, 'must be an object');
  if (!hasExactFields(x, fields)) return bad(path, 'has missing or unexpected fields');
  return x;
}

function nameList(x: unknown, path: string, opts: { min: number; max: number; known?: ReadonlySet<string> }): string[] {
  if (!Array.isArray(x)) return bad(path, 'must be a list');
  if (x.length < opts.min) return bad(path, 'has too few entries');
  if (x.length > opts.max) return bad(path, 'has too many entries');
  const seen = new Set<string>();
  for (const item of x as unknown[]) {
    if (typeof item !== 'string' || !NAME.test(item)) return bad(path, 'contains an invalid name');
    if (seen.has(item)) return bad(path, 'contains a duplicate');
    if (opts.known && !opts.known.has(item)) return bad(path, 'refers to an undefined name');
    seen.add(item);
  }
  return [...seen];
}

/** Validates an untrusted policy document (already signature-verified by verifyPolicy). Throws SchemaError. */
function buildPolicy(value: unknown): PolicyDocument {
  const doc = exact(value, 'policy', POLICY_FIELDS);

  const organization = doc.organization;
  if (typeof organization !== 'string' || !ORGANIZATION_ID.test(organization)) return bad('policy.organization', 'is invalid');
  const policyId = doc.policyId;
  if (typeof policyId !== 'string' || !POLICY_ID.test(policyId)) return bad('policy.policyId', 'is invalid');

  const revision = doc.revision;
  // positive whole number that a JSON number can represent exactly: no 0, negatives, fractions or unsafe integers
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return bad('policy.revision', 'must be a positive whole number');

  const issued = parseUtcTimestamp(doc.issuedAt);
  const effective = parseUtcTimestamp(doc.effectiveAt);
  const expires = parseUtcTimestamp(doc.expiresAt);
  if (issued === null || effective === null || expires === null) return bad('policy times', 'must be valid UTC timestamps');
  if (!(issued <= effective && effective < expires)) return bad('policy times', 'must satisfy issuedAt <= effectiveAt < expiresAt');

  const permissions = nameList(doc.permissions, 'policy.permissions', { min: 0, max: MAX_POLICY_PERMISSIONS });
  const permissionSet = new Set(permissions);

  if (!Array.isArray(doc.roles)) return bad('policy.roles', 'must be a list');
  if (doc.roles.length > MAX_POLICY_ROLES) return bad('policy.roles', 'has too many entries');
  const roles: PolicyRole[] = [];
  const roleNames = new Set<string>();
  (doc.roles as unknown[]).forEach((raw, i) => {
    const at = `policy.roles[${i}]`;
    const role = exact(raw, at, ROLE_FIELDS);
    if (typeof role.name !== 'string' || !NAME.test(role.name)) return bad(`${at}.name`, 'is invalid');
    if (roleNames.has(role.name)) return bad(`${at}.name`, 'duplicates another role');
    roleNames.add(role.name);
    roles.push(Object.freeze({ name: role.name, permissions: Object.freeze(nameList(role.permissions, `${at}.permissions`, { min: 0, max: MAX_POLICY_PERMISSIONS, known: permissionSet })) }));
  });
  const permissionsOf = new Map(roles.map((r) => [r.name, new Set(r.permissions)]));

  if (!Array.isArray(doc.rules)) return bad('policy.rules', 'must be a list');
  if (doc.rules.length > MAX_POLICY_RULES) return bad('policy.rules', 'has too many entries');
  const rules: PolicyRule[] = [];
  const pairs = new Set<string>();
  (doc.rules as unknown[]).forEach((raw, i) => {
    const at = `policy.rules[${i}]`;
    const rule = exact(raw, at, RULE_FIELDS);
    if (typeof rule.action !== 'string' || !(ACTION_TYPES as readonly string[]).includes(rule.action)) return bad(`${at}.action`, 'is not a known action type');
    if (typeof rule.environment !== 'string' || !(TARGET_ENVIRONMENTS as readonly string[]).includes(rule.environment)) return bad(`${at}.environment`, 'is not a known environment');
    const action = rule.action as ActionType;
    const environment = rule.environment as TargetEnvironment;
    const pair = `${action}/${environment}`;
    if (pairs.has(pair)) return bad(at, 'duplicates another rule for the same action and environment');
    pairs.add(pair);

    const allowedRoles = nameList(rule.allowedRoles, `${at}.allowedRoles`, { min: 1, max: MAX_POLICY_ROLES, known: roleNames });
    const requiredPermissions = nameList(rule.requiredPermissions, `${at}.requiredPermissions`, { min: 0, max: MAX_POLICY_PERMISSIONS, known: permissionSet });
    // a rule must be satisfiable by every role it allows: no role may be allowed without holding the permissions
    for (const role of allowedRoles) {
      const held = permissionsOf.get(role);
      if (!held || !requiredPermissions.every((p) => held.has(p))) return bad(`${at}.allowedRoles`, 'allows a role that lacks a required permission');
    }

    rules.push(
      Object.freeze({
        action,
        environment,
        allowedRoles: Object.freeze(allowedRoles),
        requiredPermissions: Object.freeze(requiredPermissions),
      }),
    );
  });

  const version = doc.version as PolicyVersion;
  if (version === LEVEL_POLICY_VERSION) {
    const mismatch = levelPolicyMismatch({ permissions, roles, rules });
    if (mismatch) return bad('policy', `is not the CodeXRev level policy: ${mismatch}`);
  }

  return Object.freeze({
    version,
    organization,
    policyId,
    revision,
    issuedAt: doc.issuedAt as string,
    effectiveAt: doc.effectiveAt as string,
    expiresAt: doc.expiresAt as string,
    permissions: Object.freeze(permissions),
    roles: Object.freeze(roles),
    rules: Object.freeze(rules),
  });
}

/** Schema check only, without any signature. For tooling and tests: the result is NOT trusted and cannot be passed to requirementsFor. */
export function parsePolicyDocument(value: unknown): { ok: true; policy: PolicyDocument } | PolicyFailure {
  try {
    if (isPlainObject(value) && !(SUPPORTED_POLICY_VERSIONS as readonly unknown[]).includes(value.version)) return failure('unsupported_policy_version');
    return { ok: true, policy: buildPolicy(value) };
  } catch (err) {
    return failure('policy_invalid', err instanceof SchemaError ? err.message : undefined);
  }
}

// ---------------------------------------------------------------- verification

const ENVELOPE_CODE_TO_FAILURE: Partial<Record<VerifyFailureCode, PolicyFailureCode>> = {
  domain_mismatch: 'wrong_domain',
  unknown_domain: 'wrong_domain',
};

/**
 * Verifies a signed policy envelope (object, or JSON text of the envelope) against a validated
 * trust root at an injected time, and returns the validated policy. Never throws; nothing from
 * the envelope is trusted until the signature has been verified with a trust-root key.
 */
export function verifyPolicy(input: unknown, trustRoot: TrustRoot, now: Date): PolicyResult {
  try {
    return verifyUnchecked(input, trustRoot, now);
  } catch {
    return failure('signature_verification_failed');
  }
}

function verifyUnchecked(input: unknown, trustRoot: TrustRoot, now: Date): PolicyResult {
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
  if (envelope.domain !== 'policy') return failure('wrong_domain');
  const lookup = findTrustedKey(trustRoot, envelope.keyId, 'policy', now);
  if (!lookup.ok) {
    const code: Record<typeof lookup.code, PolicyFailureCode> = {
      invalid_trust_root: 'invalid_trust_root',
      invalid_evaluation_time: 'invalid_evaluation_time',
      unknown_key: 'unknown_signing_key',
      purpose_not_allowed: 'key_purpose_not_allowed',
      key_not_yet_valid: 'signing_key_not_yet_valid',
      key_expired: 'signing_key_expired',
    };
    return failure(code[lookup.code]);
  }

  const result = verifyEnvelope(envelope, { expectedDomain: 'policy', trustedPublicKey: lookup.key.publicKey });
  if (!result.ok) {
    const mapped = ENVELOPE_CODE_TO_FAILURE[result.code];
    if (mapped) return failure(mapped, undefined, result.code);
    const malformed: readonly VerifyFailureCode[] = ['malformed_envelope', 'envelope_too_large', 'unsupported_version', 'malformed_payload_encoding', 'empty_payload', 'payload_too_large', 'malformed_signature_encoding', 'invalid_signature_length'];
    return failure(malformed.includes(result.code) ? 'envelope_malformed' : 'signature_verification_failed', undefined, result.code);
  }

  // only now is the payload parsed
  const parsed = parseVerifiedJsonPayload(result);
  if (!parsed.ok) return failure('payload_not_json');
  const checked = parsePolicyDocument(parsed.value);
  if (!checked.ok) return checked;
  const policy = checked.policy;

  if (policy.organization !== trustRoot.organization) return failure('organization_mismatch');
  if (now.getTime() < (parseUtcTimestamp(policy.effectiveAt) as number)) return failure('policy_not_yet_effective');
  if (now.getTime() >= (parseUtcTimestamp(policy.expiresAt) as number)) return failure('policy_expired');

  verified.add(policy);
  return { ok: true, policy, signingKeyId: lookup.key.keyId };
}

// ---------------------------------------------------------------- requirement lookup

export interface PolicyReference {
  readonly policyId: string;
  readonly organization: string;
  /** document format version */
  readonly version: number;
  /** company policy revision */
  readonly revision: number;
  readonly effectiveAt: string;
  readonly expiresAt: string;
}

export type DenyReason = 'invalid_policy' | 'unknown_action' | 'unknown_environment' | 'no_matching_rule';

export type Requirements =
  | { readonly permitted: false; readonly reason: DenyReason; readonly policy?: PolicyReference }
  | {
      readonly permitted: true;
      readonly requiredRoles: readonly string[];
      readonly requiredPermissions: readonly string[];
      readonly policy: PolicyReference;
    };

/**
 * What the company policy says must be PROVEN for this action in this environment. Pure and
 * deterministic. It does not check any claims: a developer saying "I am a release engineer" proves
 * nothing here. Deny by default: unknown actions, unknown environments and pairs without a rule
 * are not permitted, and so is anything that is not a verified policy.
 */
export function requirementsFor(policy: PolicyDocument, actionType: unknown, environment: unknown): Requirements {
  if (typeof policy !== 'object' || policy === null || !verified.has(policy)) return { permitted: false, reason: 'invalid_policy' };
  const ref: PolicyReference = {
    policyId: policy.policyId,
    organization: policy.organization,
    version: policy.version,
    revision: policy.revision,
    effectiveAt: policy.effectiveAt,
    expiresAt: policy.expiresAt,
  };
  if (typeof actionType !== 'string' || !(ACTION_TYPES as readonly string[]).includes(actionType)) return { permitted: false, reason: 'unknown_action', policy: ref };
  if (typeof environment !== 'string' || !(TARGET_ENVIRONMENTS as readonly string[]).includes(environment)) return { permitted: false, reason: 'unknown_environment', policy: ref };

  const rule = policy.rules.find((r) => r.action === actionType && r.environment === environment);
  if (!rule) return { permitted: false, reason: 'no_matching_rule', policy: ref };
  return {
    permitted: true,
    requiredRoles: [...rule.allowedRoles],
    requiredPermissions: [...rule.requiredPermissions],
    policy: ref,
  };
}
