// Tests for the signed company policy and the deny-by-default requirement lookup.
// All keys are generated in memory per run; nothing is written to disk.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import {
  parsePolicyDocument,
  requirementsFor,
  verifyPolicy,
  type PolicyDocument,
  type PolicyResult,
} from '../../../../src/features/action-safety/authorization/policy.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import { ACTION_TYPES, TARGET_ENVIRONMENTS } from '../../../../src/features/action-safety/model/types.js';

const NOW = new Date('2026-06-01T00:00:00Z');
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');

const entry = (k: Keys, purposes: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  keyId: deriveKeyId(k.publicKey),
  publicKey: exportRawPublicKey(k.publicKey).toString('base64url'),
  purposes,
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2027-01-01T00:00:00Z',
  ...over,
});

/** A small realistic company policy. Tests clone and tweak it. */
const goodPolicy = (): Record<string, any> => ({
  version: 2,
  organization: 'acme',
  policyId: 'acme-policy-2026-05',
  revision: 5,
  issuedAt: '2026-05-01T00:00:00Z',
  effectiveAt: '2026-05-01T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z',
  permissions: ['code.change', 'deploy.staging', 'deploy.production', 'db.migrate'],
  roles: [
    { name: 'developer', permissions: ['code.change'] },
    { name: 'release_engineer', permissions: ['code.change', 'deploy.staging', 'deploy.production'] },
    { name: 'dba', permissions: ['db.migrate'] },
    { name: 'tech_lead', permissions: [] },
  ],
  rules: [
    { action: 'code_change', environment: 'development', allowedRoles: ['developer', 'release_engineer'], requiredPermissions: ['code.change'] },
    { action: 'deployment', environment: 'staging', allowedRoles: ['release_engineer'], requiredPermissions: ['deploy.staging'] },
    { action: 'deployment', environment: 'production', allowedRoles: ['release_engineer'], requiredPermissions: ['deploy.production'] },
    { action: 'database_migration', environment: 'production', allowedRoles: ['dba'], requiredPermissions: ['db.migrate'] },
  ],
});

let policyKey: Keys;
let grantKey: Keys;
let expiredKey: Keys;
let futureKey: Keys;
let outsider: Keys;
let root: TrustRoot;
let otherOrgRoot: TrustRoot;

const trustRoot = (organization: string, keys: Record<string, unknown>[]): TrustRoot => {
  const r = parseTrustRoot({ version: 1, organization, createdAt: '2026-01-01T00:00:00Z', keys });
  if (!r.ok) throw new Error(`setup: ${r.code}`);
  return r.trustRoot;
};

beforeAll(() => {
  policyKey = pair();
  grantKey = pair();
  expiredKey = pair();
  futureKey = pair();
  outsider = pair();
  root = trustRoot('acme', [
    entry(policyKey, ['policy']),
    entry(grantKey, ['grant']),
    entry(expiredKey, ['policy'], { notBefore: '2025-01-01T00:00:00Z', notAfter: '2026-03-01T00:00:00Z' }),
    entry(futureKey, ['policy'], { notBefore: '2026-09-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' }),
  ]);
  otherOrgRoot = trustRoot('globex', [entry(policyKey, ['policy'])]);
});

const sign = (doc: unknown, key: Keys = policyKey, domain: 'policy' | 'grant' = 'policy') =>
  signEnvelope({ domain, payload: Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)), privateKey: key.privateKey });

const verify = (doc: unknown, key: Keys = policyKey, at: Date = NOW, tr: TrustRoot = root): PolicyResult => verifyPolicy(sign(doc, key), tr, at);
const failCode = (r: PolicyResult): string | undefined => (r.ok ? undefined : r.code);
const must = (r: PolicyResult): PolicyDocument => {
  if (!r.ok) throw new Error(`expected a valid policy: ${r.code} ${r.message}`);
  return r.policy;
};

describe('valid company-signed policy', () => {
  it('verifies, returns the policy and the signing key id', () => {
    const r = verify(goodPolicy());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signingKeyId).toBe(deriveKeyId(policyKey.publicKey));
      expect(r.policy.policyId).toBe('acme-policy-2026-05');
      expect(r.policy.rules).toHaveLength(4);
      expect(Object.isFrozen(r.policy)).toBe(true);
      expect(Object.isFrozen(r.policy.rules)).toBe(true);
    }
  });

  it('accepts the envelope as JSON text', () => {
    expect(verifyPolicy(JSON.stringify(sign(goodPolicy())), root, NOW).ok).toBe(true);
  });

  it('is valid exactly from effectiveAt (inclusive) until expiresAt (exclusive)', () => {
    expect(verify(goodPolicy(), policyKey, new Date('2026-05-01T00:00:00Z')).ok).toBe(true);
    expect(verify(goodPolicy(), policyKey, new Date('2026-11-30T23:59:59Z')).ok).toBe(true);
    expect(failCode(verify(goodPolicy(), policyKey, new Date('2026-12-01T00:00:00Z')))).toBe('policy_expired');
  });

  it('accepts an empty rule list: a policy that denies everything is valid', () => {
    const doc = goodPolicy();
    doc.rules = [];
    const p = must(verify(doc));
    expect(requirementsFor(p, 'code_change', 'development')).toMatchObject({ permitted: false, reason: 'no_matching_rule' });
  });
});

describe('signature and trust failures', () => {
  it('rejects a tampered policy (payload changed after signing)', () => {
    const env = sign(goodPolicy());
    const tampered = goodPolicy();
    tampered.rules[1].allowedRoles = ['developer'];
    const forged = { ...env, payload: Buffer.from(JSON.stringify(tampered)).toString('base64url') };
    const r = verifyPolicy(forged, root, NOW);
    expect(failCode(r)).toBe('signature_verification_failed');
  });

  it('rejects a wrong signing key (envelope claims a trusted key id but was signed by another key)', () => {
    const env = sign(goodPolicy(), outsider);
    const claimsTrusted = { ...env, keyId: deriveKeyId(policyKey.publicKey) };
    expect(failCode(verifyPolicy(claimsTrusted, root, NOW))).toBe('signature_verification_failed');
  });

  it('rejects an unknown signing key even though its signature is cryptographically valid', () => {
    const env = sign(goodPolicy(), outsider);
    const r = verifyPolicy(env, root, NOW);
    expect(failCode(r)).toBe('unknown_signing_key');
  });

  it('rejects a key without the policy purpose (a grant-only key cannot sign a policy)', () => {
    expect(failCode(verify(goodPolicy(), grantKey))).toBe('key_purpose_not_allowed');
  });

  it('rejects a key whose validity window has ended or has not started', () => {
    expect(failCode(verify(goodPolicy(), expiredKey))).toBe('signing_key_expired');
    expect(failCode(verify(goodPolicy(), futureKey))).toBe('signing_key_not_yet_valid');
  });

  it('rejects an envelope signed for another domain, even by a policy key', () => {
    const env = signEnvelope({ domain: 'grant', payload: Buffer.from(JSON.stringify(goodPolicy())), privateKey: policyKey.privateKey });
    expect(failCode(verifyPolicy(env, root, NOW))).toBe('wrong_domain');
    // relabelling the domain does not help: the domain is inside the signed bytes
    expect(failCode(verifyPolicy({ ...env, domain: 'policy' }, root, NOW))).toBe('signature_verification_failed');
  });

  it('a policy cannot add or change signing authority: it has no key fields, and extra fields are rejected', () => {
    const doc = goodPolicy();
    doc.trustedKeys = [{ keyId: deriveKeyId(outsider.publicKey), purposes: ['policy'] }];
    expect(failCode(verify(doc))).toBe('policy_invalid');
    const withKeys = goodPolicy();
    withKeys.keys = [];
    expect(failCode(verify(withKeys))).toBe('policy_invalid');
  });

  it('signing with a policy key that the policy itself names changes nothing: authority comes from the trust root only', () => {
    // an outsider signs a policy containing their own key; it is still an unknown signer
    const doc = goodPolicy();
    doc.signedBy = deriveKeyId(outsider.publicKey);
    expect(failCode(verify(doc, outsider))).toBe('unknown_signing_key');
  });

  it('rejects an unvalidated (hand-built) trust root', () => {
    expect(failCode(verifyPolicy(sign(goodPolicy()), { ...root }, NOW))).toBe('invalid_trust_root');
    expect(failCode(verifyPolicy(sign(goodPolicy()), { version: 1, organization: 'acme', createdAt: 'x', keys: [] } as unknown as TrustRoot, NOW))).toBe('invalid_trust_root');
    expect(failCode(verifyPolicy(sign(goodPolicy()), null as unknown as TrustRoot, NOW))).toBe('invalid_trust_root');
  });

  it('rejects an invalid evaluation time', () => {
    expect(failCode(verifyPolicy(sign(goodPolicy()), root, new Date('nope')))).toBe('invalid_evaluation_time');
    expect(failCode(verifyPolicy(sign(goodPolicy()), root, '2026-06-01' as unknown as Date))).toBe('invalid_evaluation_time');
  });

  it('rejects malformed envelopes without throwing', () => {
    const env = sign(goodPolicy());
    const cases: unknown[] = [null, undefined, 5, [], 'not json', '{', {}, { ...env, extra: 1 }, { ...env, payload: '!!' }, { ...env, signature: 'AAAA' }, { ...env, version: 2 }, { ...env, keyId: 5 }];
    for (const c of cases) {
      const r = verifyPolicy(c, root, NOW);
      expect(r.ok, JSON.stringify(c)).toBe(false);
    }
    expect(failCode(verifyPolicy({ ...env, payload: '!!' }, root, NOW))).toBe('envelope_malformed');
    expect(failCode(verifyPolicy({ ...env, version: 2 }, root, NOW))).toBe('envelope_malformed');
    expect(failCode(verifyPolicy('x'.repeat(2_000_000), root, NOW))).toBe('envelope_malformed');
  });

  it('survives hostile input objects', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    expect(verifyPolicy(hostile, root, NOW).ok).toBe(false);
  });

  it('does not parse the payload before the signature is verified: bad JSON signed by an unknown key reports the key, not the JSON', () => {
    expect(failCode(verifyPolicy(sign('{ not json', outsider), root, NOW))).toBe('unknown_signing_key');
  });

  it('reports a verified but non-JSON payload explicitly', () => {
    expect(failCode(verifyPolicy(sign('{ not json'), root, NOW))).toBe('payload_not_json');
    const binary = signEnvelope({ domain: 'policy', payload: Buffer.from([0xff, 0xfe]), privateKey: policyKey.privateKey });
    expect(failCode(verifyPolicy(binary, root, NOW))).toBe('payload_not_json');
  });

  it('failure messages never contain payload content or key material', () => {
    const doc = goodPolicy();
    doc.organization = 'SENTINEL-ORG';
    const r = verifyPolicy(sign(doc), root, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain('SENTINEL');
      expect(r.message).not.toContain(exportRawPublicKey(policyKey.publicKey).toString('base64url'));
    }
  });
});

describe('organization and time', () => {
  it('rejects a policy from another organization (policy says globex, trust root says acme)', () => {
    const doc = goodPolicy();
    doc.organization = 'globex';
    expect(failCode(verify(doc))).toBe('organization_mismatch');
  });

  it('rejects a policy signed by a trusted key of a trust root belonging to another organization', () => {
    expect(failCode(verify(goodPolicy(), policyKey, NOW, otherOrgRoot))).toBe('organization_mismatch');
  });

  it('rejects an expired policy', () => {
    const doc = goodPolicy();
    doc.expiresAt = '2026-05-15T00:00:00Z';
    expect(failCode(verify(doc))).toBe('policy_expired');
  });

  it('rejects a policy that is not effective yet', () => {
    const doc = goodPolicy();
    doc.issuedAt = '2026-05-01T00:00:00Z';
    doc.effectiveAt = '2026-07-01T00:00:00Z';
    expect(failCode(verify(doc))).toBe('policy_not_yet_effective');
  });

  it('rejects invalid time windows', () => {
    const swap = (over: Record<string, string>) => {
      const doc = { ...goodPolicy(), ...over };
      return failCode(verify(doc));
    };
    expect(swap({ effectiveAt: '2026-12-01T00:00:00Z', expiresAt: '2026-05-01T00:00:00Z' })).toBe('policy_invalid');
    expect(swap({ expiresAt: '2026-05-01T00:00:00Z' })).toBe('policy_invalid'); // expires == effective
    expect(swap({ issuedAt: '2026-05-02T00:00:00Z' })).toBe('policy_invalid'); // issued after effective
    for (const bad of ['tomorrow', '2026-02-31T00:00:00Z', '2026-05-01', '2026-05-01T00:00:00+01:00']) {
      expect(swap({ effectiveAt: bad }), bad).toBe('policy_invalid');
    }
  });
});

describe('policy structure', () => {
  const mutate = (fn: (d: Record<string, any>) => void): PolicyResult => {
    const doc = goodPolicy();
    fn(doc);
    return verify(doc);
  };

  it('rejects unsupported policy versions', () => {
    for (const version of [0, 1, 4, 1.5, '2', null]) expect(failCode(mutate((d) => (d.version = version))), String(version)).toBe('unsupported_policy_version');
    expect(failCode(mutate((d) => delete d.version))).toBe('unsupported_policy_version');
  });

  it('rejects non-object and structurally wrong policies', () => {
    for (const payload of ['[]', 'null', '5', '"x"']) expect(failCode(verifyPolicy(sign(payload), root, NOW)), payload).toMatch(/policy_invalid|unsupported_policy_version/);
    expect(failCode(mutate((d) => (d.extra = true)))).toBe('policy_invalid');
    for (const field of ['organization', 'policyId', 'revision', 'issuedAt', 'effectiveAt', 'expiresAt', 'permissions', 'roles', 'rules']) {
      expect(failCode(mutate((d) => delete d[field])), field).toBe('policy_invalid');
    }
    expect(failCode(mutate((d) => (d.policyId = 'has spaces')))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.organization = 'Bad Org')))).toBe('policy_invalid');
  });

  it('rejects invalid role definitions', () => {
    expect(failCode(mutate((d) => (d.roles = 'dev')))).toBe('policy_invalid');
    expect(failCode(mutate((d) => d.roles.push({ name: 'developer', permissions: [] })))).toBe('policy_invalid'); // duplicate
    expect(failCode(mutate((d) => d.roles.push({ name: 'Bad Name', permissions: [] })))).toBe('policy_invalid');
    expect(failCode(mutate((d) => d.roles.push({ name: 'x' })))).toBe('policy_invalid'); // missing permissions
    expect(failCode(mutate((d) => d.roles.push({ name: 'x', permissions: [], admin: true })))).toBe('policy_invalid');
    expect(failCode(mutate((d) => d.roles.push(null)))).toBe('policy_invalid');
    expect(failCode(mutate((d) => d.roles.push({ name: '__proto__', permissions: [] })))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.roles = Array.from({ length: 51 }, (_, i) => ({ name: `r${i}`, permissions: [] })))))).toBe('policy_invalid');
  });

  it('rejects invalid permission definitions', () => {
    expect(failCode(mutate((d) => d.roles[0].permissions.push('not.in.catalogue')))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.roles[0].permissions = ['code.change', 'code.change'])))).toBe('policy_invalid');
    expect(failCode(mutate((d) => d.permissions.push('code.change')))).toBe('policy_invalid'); // duplicate in catalogue
    expect(failCode(mutate((d) => d.permissions.push('Bad Permission')))).toBe('policy_invalid');
    expect(failCode(mutate((d) => d.permissions.push(5)))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.rules[0].requiredPermissions = ['db.migrate'])))).toBe('policy_invalid'); // allowed roles lack it
    expect(failCode(mutate((d) => (d.rules[0].requiredPermissions = ['undefined.perm'])))).toBe('policy_invalid');
  });

  it('has no approval fields: a version 1 style rule or policy is rejected, not reinterpreted', () => {
    // the per-action approval requirement was removed from the schema: its fields are unexpected now
    expect(failCode(mutate((d) => (d.rules[2].approvals = { count: 1, approverRoles: ['tech_lead'], independent: true })))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.minimumRequirements = { approvalsByEnvironment: {} })))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.rules[0].approverRoles = ['tech_lead'])))).toBe('policy_invalid');
  });

  it('rejects duplicate or ambiguous rules', () => {
    expect(failCode(mutate((d) => d.rules.push({ ...d.rules[1] })))).toBe('policy_invalid');
    // a conflicting duplicate that would loosen production must be rejected too
    expect(failCode(mutate((d) => d.rules.push({ ...d.rules[2] })))).toBe('policy_invalid');
  });

  it('rejects rules naming unknown actions, environments or roles, and empty role lists', () => {
    expect(failCode(mutate((d) => (d.rules[0].action = 'launch_missiles')))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.rules[0].environment = 'prod')))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.rules[0].action = 5)))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.rules[0].allowedRoles = ['ghost'])))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.rules[0].allowedRoles = [])))).toBe('policy_invalid');
    expect(failCode(mutate((d) => (d.rules = 'all')))).toBe('policy_invalid');
    expect(failCode(mutate((d) => d.rules.push(5)))).toBe('policy_invalid');
  });

  it('parsePolicyDocument checks structure only and its result cannot be used for lookups', () => {
    const parsed = parsePolicyDocument(goodPolicy());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(requirementsFor(parsed.policy, 'code_change', 'development')).toEqual({ permitted: false, reason: 'invalid_policy' });
  });

  it('failure messages for invalid policies name only code-defined locations, never submitted text', () => {
    const doc = goodPolicy();
    doc['SENTINEL-FIELD'] = 1;
    const r = verify(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('SENTINEL');
  });
});

describe('policy revision (separate from the document format version)', () => {
  const withRevision = (revision: unknown): PolicyResult => {
    const doc = goodPolicy();
    doc.revision = revision;
    return verify(doc);
  };

  it('accepts a valid revision and exposes it, alongside the unchanged format version', () => {
    const p = must(withRevision(5));
    expect(p.revision).toBe(5);
    expect(p.version).toBe(2);
    expect(must(withRevision(1)).revision).toBe(1);
    expect(must(withRevision(Number.MAX_SAFE_INTEGER)).revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects a missing revision', () => {
    const doc = goodPolicy();
    delete doc.revision;
    expect(failCode(verify(doc))).toBe('policy_invalid');
  });

  it('rejects zero and negative revisions', () => {
    for (const r of [0, -1, -5, Number.MIN_SAFE_INTEGER]) expect(failCode(withRevision(r)), String(r)).toBe('policy_invalid');
  });

  it('rejects fractional revisions', () => {
    for (const r of [1.5, 0.5, 4.999999, 5.0000001]) expect(failCode(withRevision(r)), String(r)).toBe('policy_invalid');
  });

  it('rejects unsafe-integer revisions, including values JSON would silently round', () => {
    expect(failCode(withRevision(Number.MAX_SAFE_INTEGER + 1))).toBe('policy_invalid');
    expect(failCode(withRevision(2 ** 60))).toBe('policy_invalid');
    // written as digits in the signed text, 2^53 + 1 parses to a different, unsafe number
    const text = JSON.stringify(goodPolicy()).replace('"revision":5', '"revision":9007199254740993');
    expect(failCode(verifyPolicy(sign(text), root, NOW))).toBe('policy_invalid');
  });

  it('rejects non-numeric revisions', () => {
    for (const r of ['5', null, true, [5], { n: 5 }, Number.NaN, Number.POSITIVE_INFINITY]) expect(failCode(withRevision(r)), String(r)).toBe('policy_invalid');
  });

  it('keeps the format version independent of the revision', () => {
    expect(must(withRevision(2)).version).toBe(2);
    expect(must(withRevision(250)).version).toBe(2);
    // a different format version is rejected whatever the revision is
    for (const version of [1, 5, 0]) {
      const doc = goodPolicy();
      doc.version = version;
      expect(failCode(verify(doc)), String(version)).toBe('unsupported_policy_version');
    }
    // a revision does not make an unsupported format acceptable, and vice versa
    const both = goodPolicy();
    both.version = 5;
    both.revision = 1;
    expect(failCode(verify(both))).toBe('unsupported_policy_version');
  });

  it('the revision is inside the signed payload: changing it after signing breaks the signature', () => {
    const env = sign(goodPolicy());
    const bumped = goodPolicy();
    bumped.revision = 6;
    const forged = { ...env, payload: Buffer.from(JSON.stringify(bumped)).toString('base64url') };
    expect(failCode(verifyPolicy(forged, root, NOW))).toBe('signature_verification_failed');
    // and a re-signed policy with another revision is a different, equally valid policy
    expect(must(verify(bumped)).revision).toBe(6);
  });

  it('a policy with a revision still reports it through the requirement lookup', () => {
    const p = must(withRevision(9));
    expect(requirementsFor(p, 'deployment', 'production').policy).toMatchObject({ version: 2, revision: 9 });
    expect(requirementsFor(p, 'rollback', 'production').policy).toMatchObject({ version: 2, revision: 9 });
  });
});

describe('requirement lookup (deny by default)', () => {
  let policy: PolicyDocument;
  beforeAll(() => {
    policy = must(verify(goodPolicy()));
  });

  it('development code change: developers or release engineers', () => {
    const r = requirementsFor(policy, 'code_change', 'development');
    expect(r).toMatchObject({ permitted: true, requiredRoles: ['developer', 'release_engineer'], requiredPermissions: ['code.change'] });
  });

  it('staging deployment: release engineer only', () => {
    expect(requirementsFor(policy, 'deployment', 'staging')).toMatchObject({ permitted: true, requiredRoles: ['release_engineer'], requiredPermissions: ['deploy.staging'] });
  });

  it('production deployment: a release engineer with the production permission, and no separate approval', () => {
    const r = requirementsFor(policy, 'deployment', 'production');
    expect(r).toMatchObject({ permitted: true, requiredRoles: ['release_engineer'], requiredPermissions: ['deploy.production'] });
    // nothing about approvals exists in the answer
    expect(Object.keys(r).sort()).toEqual(['permitted', 'policy', 'requiredPermissions', 'requiredRoles']);
  });

  it('production database migration: DBA with the migration permission', () => {
    expect(requirementsFor(policy, 'database_migration', 'production')).toMatchObject({ permitted: true, requiredRoles: ['dba'], requiredPermissions: ['db.migrate'] });
  });

  it('includes the policy identity and version in every answer', () => {
    const ref = { policyId: 'acme-policy-2026-05', organization: 'acme', version: 2, revision: 5, effectiveAt: '2026-05-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' };
    expect(requirementsFor(policy, 'deployment', 'production').policy).toEqual(ref);
    expect(requirementsFor(policy, 'deployment', 'testing').policy).toEqual(ref);
  });

  it('denies an action the policy never mentions in an environment it does cover (no matching rule)', () => {
    expect(requirementsFor(policy, 'deployment', 'development')).toMatchObject({ permitted: false, reason: 'no_matching_rule' });
    expect(requirementsFor(policy, 'code_change', 'production')).toMatchObject({ permitted: false, reason: 'no_matching_rule' });
    expect(requirementsFor(policy, 'rollback', 'production')).toMatchObject({ permitted: false, reason: 'no_matching_rule' });
    expect(requirementsFor(policy, 'database_migration', 'staging')).toMatchObject({ permitted: false, reason: 'no_matching_rule' });
  });

  it('denies unknown actions and unknown environments, including look-alikes and non-strings', () => {
    for (const bad of ['launch', 'Deployment', 'deployment ', '', '__proto__', 'constructor', null, undefined, 5, {}, ['deployment']]) {
      expect(requirementsFor(policy, bad, 'staging'), String(bad)).toMatchObject({ permitted: false, reason: 'unknown_action' });
    }
    for (const bad of ['prod', 'Production', 'production ', '', '__proto__', null, undefined, 5, {}]) {
      expect(requirementsFor(policy, 'deployment', bad), String(bad)).toMatchObject({ permitted: false, reason: 'unknown_environment' });
    }
  });

  it('a denial carries no requirements that could be mistaken for a grant', () => {
    const r = requirementsFor(policy, 'rollback', 'production');
    expect(r.permitted).toBe(false);
    expect('requiredRoles' in r).toBe(false);
  });

  it('denies everything for anything that is not a verified policy', () => {
    for (const fake of [goodPolicy(), { ...policy }, null, undefined, 5] as unknown[]) {
      expect(requirementsFor(fake as PolicyDocument, 'code_change', 'development')).toEqual({ permitted: false, reason: 'invalid_policy' });
    }
  });

  it('every action/environment pair is either an explicit rule or denied', () => {
    let permitted = 0;
    for (const action of ACTION_TYPES) {
      for (const env of TARGET_ENVIRONMENTS) {
        const r = requirementsFor(policy, action, env);
        if (r.permitted) permitted += 1;
        else expect(r.reason).toBe('no_matching_rule');
      }
    }
    expect(permitted).toBe(4);
  });

  it('is deterministic and returns copies that cannot alter the policy', () => {
    const first = requirementsFor(policy, 'deployment', 'production');
    expect(requirementsFor(policy, 'deployment', 'production')).toEqual(first);
    if (!first.permitted) throw new Error('setup');
    (first.requiredRoles as string[]).push('developer');
    const again = requirementsFor(policy, 'deployment', 'production');
    expect(again).toMatchObject({ requiredRoles: ['release_engineer'] });
  });

  it('the policy itself is immutable', () => {
    expect(() => {
      (policy.rules as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (policy.rules[0] as { action: string }).action = 'rollback';
    }).toThrow();
    expect(() => {
      (policy.rules[2]!.allowedRoles as string[]).push('developer');
    }).toThrow();
  });

  it('ignores developer claims entirely: the lookup takes no claimed roles or permissions', () => {
    expect(requirementsFor.length).toBe(3);
    const r = requirementsFor(policy, 'deployment', 'production');
    expect(r.permitted && r.requiredRoles).toEqual(['release_engineer']);
  });
});
