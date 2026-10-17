// Tests for company-issued grants and effective permissions. In-memory keys only; offline and deterministic.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import {
  MAX_GRANT_LIFETIME_DAYS,
  effectivePermissions,
  isVerifiedGrant,
  verifyGrant,
  type GrantResult,
  type VerifiedGrant,
} from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy, type PolicyDocument } from '../../../../src/features/action-safety/authorization/policy.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';

const NOW = new Date('2026-06-01T00:00:00Z');
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');
const raw = (k: Keys): string => exportRawPublicKey(k.publicKey).toString('base64url');

const entry = (k: Keys, purposes: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  keyId: deriveKeyId(k.publicKey),
  publicKey: raw(k),
  purposes,
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2027-01-01T00:00:00Z',
  ...over,
});

const policyDoc = (): Record<string, unknown> => ({
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
  rules: [],
});

let policyKey: Keys;
let grantKey: Keys;
let revocationKey: Keys;
let outsider: Keys;
let alice: Keys; // a developer
let root: TrustRoot;
let policy: PolicyDocument;

const makeRoot = (organization: string, keys: Record<string, unknown>[]): TrustRoot => {
  const r = parseTrustRoot({ version: 1, organization, createdAt: '2026-01-01T00:00:00Z', keys });
  if (!r.ok) throw new Error(`setup: ${r.code}`);
  return r.trustRoot;
};

beforeAll(() => {
  policyKey = pair();
  grantKey = pair();
  revocationKey = pair();
  outsider = pair();
  alice = pair();
  root = makeRoot('acme', [entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])]);
  const signed = signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(policyDoc())), privateKey: policyKey.privateKey });
  const v = verifyPolicy(signed, root, NOW);
  if (!v.ok) throw new Error(`setup: ${v.code}`);
  policy = v.policy;
});

const grantDoc = (over: Record<string, unknown> = {}, subject: Keys = alice): Record<string, any> => ({
  version: 1,
  grantId: 'grant-alice-001',
  organization: 'acme',
  subject: { id: 'alice', type: 'human', publicKey: raw(subject), keyId: deriveKeyId(subject.publicKey) },
  roles: ['developer'],
  permissionScope: null,
  issuedAt: '2026-05-25T00:00:00Z',
  notBefore: '2026-05-25T00:00:00Z',
  expiresAt: '2026-08-01T00:00:00Z',
  minPolicyRevision: 5,
  ...over,
});

const sign = (doc: unknown, key: Keys = grantKey, domain: 'grant' | 'policy' | 'revocation' = 'grant') =>
  signEnvelope({ domain, payload: Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)), privateKey: key.privateKey });

const verify = (doc: unknown, key: Keys = grantKey, at: Date = NOW, tr: TrustRoot = root, pol: PolicyDocument = policy): GrantResult => verifyGrant(sign(doc, key), tr, pol, at);
const codeOf = (r: GrantResult): string | undefined => (r.ok ? undefined : r.code);
const must = (r: GrantResult): VerifiedGrant => {
  if (!r.ok) throw new Error(`expected a valid grant: ${r.code} ${r.message}`);
  return r;
};

describe('valid signed grant', () => {
  it('verifies and returns a typed, frozen, branded result', () => {
    const r = must(verify(grantDoc()));
    expect(r.grant.grantId).toBe('grant-alice-001');
    expect(r.grant.subject).toMatchObject({ id: 'alice', type: 'human' });
    expect(r.issuerKeyId).toBe(deriveKeyId(grantKey.publicKey));
    expect(r.policyId).toBe('acme-policy-2026-05');
    expect(deriveKeyId(r.subjectPublicKey)).toBe(deriveKeyId(alice.publicKey));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.grant.roles)).toBe(true);
    expect(isVerifiedGrant(r)).toBe(true);
    expect(isVerifiedGrant({ ...r })).toBe(false);
  });

  it('accepts a service subject, several roles and a permission scope', () => {
    const r = verify(grantDoc({ roles: ['developer', 'dba'], permissionScope: ['db.migrate'], subject: { id: 'svc-ci@acme', type: 'service', publicKey: raw(alice), keyId: deriveKeyId(alice.publicKey) } }));
    expect(r.ok).toBe(true);
  });

  it('accepts envelope JSON text', () => {
    expect(verifyGrant(JSON.stringify(sign(grantDoc())), root, policy, NOW).ok).toBe(true);
  });

  it('does not infer or need any identity from the environment: the same grant verifies identically', () => {
    expect(verify(grantDoc())).toEqual(verify(grantDoc()));
  });

  it('never contains a private key and the result exposes only the public subject key', () => {
    const r = must(verify(grantDoc()));
    expect(JSON.stringify(r.grant)).not.toContain(String(alice.privateKey.export({ format: 'jwk' }).d));
    expect(r.subjectPublicKey.type).toBe('public');
  });
});

describe('issuer trust', () => {
  it('rejects a wrong issuer: an unknown key signing a perfectly valid grant', () => {
    expect(codeOf(verify(grantDoc(), outsider))).toBe('unknown_signing_key');
  });

  it("rejects a developer signing their own grant with their personal key", () => {
    expect(codeOf(verify(grantDoc(), alice))).toBe('unknown_signing_key');
  });

  it('rejects wrong signing purposes: policy-only and revocation-only keys cannot sign grants', () => {
    expect(codeOf(verify(grantDoc(), policyKey))).toBe('key_purpose_not_allowed');
    expect(codeOf(verify(grantDoc(), revocationKey))).toBe('key_purpose_not_allowed');
  });

  it('rejects an issuer key outside its validity window', () => {
    const expired = pair();
    const future = pair();
    const r = makeRoot('acme', [
      entry(grantKey, ['grant']),
      entry(expired, ['grant'], { notAfter: '2026-03-01T00:00:00Z' }),
      entry(future, ['grant'], { notBefore: '2026-09-01T00:00:00Z' }),
    ]);
    expect(codeOf(verify(grantDoc(), expired, NOW, r))).toBe('signing_key_expired');
    expect(codeOf(verify(grantDoc(), future, NOW, r))).toBe('signing_key_not_yet_valid');
  });

  it('rejects a wrong signing domain, and relabelling does not help', () => {
    const asPolicy = sign(grantDoc(), grantKey, 'policy');
    expect(codeOf(verifyGrant(asPolicy, root, policy, NOW))).toBe('wrong_domain');
    expect(codeOf(verifyGrant({ ...asPolicy, domain: 'grant' }, root, policy, NOW))).toBe('signature_verification_failed');
    expect(codeOf(verifyGrant(sign(grantDoc(), grantKey, 'revocation'), root, policy, NOW))).toBe('wrong_domain');
  });

  it('rejects a tampered grant and a forged key id', () => {
    const env = sign(grantDoc());
    const forged = grantDoc({ roles: ['release_engineer'] });
    expect(codeOf(verifyGrant({ ...env, payload: Buffer.from(JSON.stringify(forged)).toString('base64url') }, root, policy, NOW))).toBe('signature_verification_failed');
    const byOutsider = { ...sign(grantDoc(), outsider), keyId: deriveKeyId(grantKey.publicKey) };
    expect(codeOf(verifyGrant(byOutsider, root, policy, NOW))).toBe('signature_verification_failed');
  });

  it('a grant cannot supply its own issuer key: extra key fields are rejected', () => {
    expect(codeOf(verify(grantDoc({ issuerPublicKey: raw(outsider) })))).toBe('grant_invalid');
    expect(codeOf(verify(grantDoc({ privateKey: 'x' })))).toBe('grant_invalid');
  });

  it('rejects an unvalidated trust root, an unverified policy and a bad evaluation time', () => {
    expect(codeOf(verifyGrant(sign(grantDoc()), { ...root }, policy, NOW))).toBe('invalid_trust_root');
    expect(codeOf(verifyGrant(sign(grantDoc()), root, { ...policy }, NOW))).toBe('invalid_policy');
    expect(codeOf(verifyGrant(sign(grantDoc()), root, policyDoc() as unknown as PolicyDocument, NOW))).toBe('invalid_policy');
    expect(codeOf(verifyGrant(sign(grantDoc()), root, policy, new Date('x')))).toBe('invalid_evaluation_time');
  });

  it('rejects malformed envelopes and hostile inputs without throwing', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    for (const c of [null, undefined, 5, [], 'nope', '{', {}, hostile]) expect(verifyGrant(c, root, policy, NOW).ok).toBe(false);
  });

  it('does not parse the payload before the signature: bad JSON from an unknown key reports the key', () => {
    expect(codeOf(verifyGrant(sign('{ no', outsider), root, policy, NOW))).toBe('unknown_signing_key');
    expect(codeOf(verifyGrant(sign('{ no'), root, policy, NOW))).toBe('payload_not_json');
  });
});

describe('time and lifetime', () => {
  it('rejects an expired grant (end is exclusive)', () => {
    expect(codeOf(verify(grantDoc({ expiresAt: '2026-05-30T00:00:00Z' })))).toBe('grant_expired');
    expect(codeOf(verify(grantDoc(), grantKey, new Date('2026-08-01T00:00:00Z')))).toBe('grant_expired');
  });

  it('rejects a grant that is not valid yet (start is inclusive)', () => {
    expect(codeOf(verify(grantDoc({ issuedAt: '2026-05-01T00:00:00Z', notBefore: '2026-07-01T00:00:00Z' })))).toBe('grant_not_yet_valid');
    expect(verify(grantDoc(), grantKey, new Date('2026-05-25T00:00:00Z')).ok).toBe(true);
  });

  it('rejects a grant whose lifetime exceeds the maximum, and accepts exactly the maximum', () => {
    expect(MAX_GRANT_LIFETIME_DAYS).toBe(90);
    expect(codeOf(verify(grantDoc({ expiresAt: '2026-09-01T00:00:00Z' })))).toBe('lifetime_exceeds_maximum');
    expect(codeOf(verify(grantDoc({ notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-23T00:00:01Z' })))).toBe('lifetime_exceeds_maximum');
    expect(verify(grantDoc({ expiresAt: '2026-08-23T00:00:00Z' })).ok).toBe(true);
  });

  it('rejects invalid timestamps and orderings', () => {
    for (const bad of ['tomorrow', '2026-02-31T00:00:00Z', '2026-05-25', '2026-05-25T00:00:00+01:00', 5, null]) {
      expect(codeOf(verify(grantDoc({ notBefore: bad }))), String(bad)).toBe('grant_invalid');
      expect(codeOf(verify(grantDoc({ expiresAt: bad }))), String(bad)).toBe('grant_invalid');
      expect(codeOf(verify(grantDoc({ issuedAt: bad }))), String(bad)).toBe('grant_invalid');
    }
    expect(codeOf(verify(grantDoc({ expiresAt: '2026-05-25T00:00:00Z' })))).toBe('grant_invalid');
    expect(codeOf(verify(grantDoc({ issuedAt: '2026-05-26T00:00:00Z' })))).toBe('grant_invalid');
  });

  it('rejects a grant when the policy is not in effect at the evaluation time', () => {
    expect(codeOf(verify(grantDoc({ issuedAt: '2026-12-02T00:00:00Z', notBefore: '2026-12-02T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }), grantKey, new Date('2026-12-05T00:00:00Z')))).toBe('policy_not_current');
  });
});

describe('organization, subject and policy compatibility', () => {
  it('rejects a cross-organization grant', () => {
    expect(codeOf(verify(grantDoc({ organization: 'globex' })))).toBe('organization_mismatch');
    const globexRoot = makeRoot('globex', [entry(grantKey, ['grant'])]);
    expect(codeOf(verify(grantDoc(), grantKey, NOW, globexRoot))).toBe('organization_mismatch');
  });

  it('rejects a grant that requires a newer policy revision than the verified policy (policy is revision 5)', () => {
    expect(codeOf(verify(grantDoc({ minPolicyRevision: 6 })))).toBe('policy_revision_too_old');
    expect(codeOf(verify(grantDoc({ minPolicyRevision: 1000 })))).toBe('policy_revision_too_old');
    expect(codeOf(verify(grantDoc({ minPolicyRevision: Number.MAX_SAFE_INTEGER })))).toBe('policy_revision_too_old');
  });

  it('accepts a grant that requires the same revision as the verified policy', () => {
    expect(verify(grantDoc({ minPolicyRevision: 5 })).ok).toBe(true);
  });

  it('accepts a grant that requires an older revision than the verified policy', () => {
    for (const minPolicyRevision of [1, 2, 4]) expect(verify(grantDoc({ minPolicyRevision })).ok, String(minPolicyRevision)).toBe(true);
  });

  it('rejects a grant minimum revision that is missing, zero, negative, fractional, unsafe or not a number', () => {
    for (const bad of [0, -1, -5, 1.5, 4.5, Number.MAX_SAFE_INTEGER + 1, 2 ** 60, '5', null, true, [5], Number.NaN]) {
      expect(codeOf(verify(grantDoc({ minPolicyRevision: bad }))), String(bad)).toBe('grant_invalid');
    }
    const doc = grantDoc();
    delete doc.minPolicyRevision;
    expect(codeOf(verify(doc))).toBe('grant_invalid');
  });

  it('the old field name is gone: a grant using minPolicyVersion is rejected as having an unexpected field', () => {
    const doc = grantDoc();
    delete doc.minPolicyRevision;
    doc.minPolicyVersion = 1;
    expect(codeOf(verify(doc))).toBe('grant_invalid');
    expect(codeOf(verify(grantDoc({ minPolicyVersion: 1 })))).toBe('grant_invalid');
  });

  it('compares against the policy REVISION, never the document format version', () => {
    // format version 2, revision 5: a minimum of 3 is above the format version but below the revision.
    // Under the old (wrong) comparison against the format version it would have been rejected.
    expect(policy.version).toBe(2);
    expect(policy.revision).toBe(5);
    expect(verify(grantDoc({ minPolicyRevision: 3 })).ok).toBe(true);
  });

  it('tampering with the minimum revision of a signed grant breaks the signature', () => {
    const env = sign(grantDoc({ minPolicyRevision: 6 }));
    const lowered = grantDoc({ minPolicyRevision: 1 });
    const forged = { ...env, payload: Buffer.from(JSON.stringify(lowered)).toString('base64url') };
    expect(codeOf(verifyGrant(forged, root, policy, NOW))).toBe('signature_verification_failed');
    // the honestly signed one stays rejected for the real reason
    expect(codeOf(verifyGrant(env, root, policy, NOW))).toBe('policy_revision_too_old');
  });

  it('the grant records the policy id and revision it was verified against', () => {
    const g = must(verify(grantDoc({ minPolicyRevision: 3 })));
    expect(g.policyId).toBe('acme-policy-2026-05');
    expect(g.policyRevision).toBe(5);
    expect(g.grant.minPolicyRevision).toBe(3);
  });

  it('a revision comparison alone authorizes nothing: the verified grant carries no decision', () => {
    const g = must(verify(grantDoc({ minPolicyRevision: 5 })));
    expect('authorized' in g).toBe(false);
    expect('permitted' in g).toBe(false);
  });

  it('a newer revision of the policy can satisfy the grant, but only once the grant is verified against it', () => {
    const newer = { ...policyDoc(), revision: 6 };
    const v = verifyPolicy(signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(newer)), privateKey: policyKey.privateKey }), root, NOW);
    if (!v.ok) throw new Error('setup');
    const doc = grantDoc({ minPolicyRevision: 6 });
    expect(codeOf(verify(doc))).toBe('policy_revision_too_old'); // revision 5 policy
    expect(verify(doc, grantKey, NOW, root, v.policy).ok).toBe(true); // revision 6 policy
  });

  it('rejects an invalid subject public key', () => {
    const subject = (publicKey: unknown) => ({ id: 'alice', type: 'human', publicKey, keyId: deriveKeyId(alice.publicKey) });
    for (const k of ['', 'AAAA', 'A'.repeat(42), `${raw(alice)}=`, '!!!', raw(alice).replace(/[-_]/g, '+') + '+']) {
      expect(codeOf(verify(grantDoc({ subject: subject(k) }))), k).toMatch(/subject_key_invalid|grant_invalid/);
    }
    expect(codeOf(verify(grantDoc({ subject: subject(5) })))).toBe('grant_invalid');
    expect(codeOf(verify(grantDoc({ subject: subject(alice.publicKey.export({ type: 'spki', format: 'pem' })) })))).toBe('grant_invalid');
    expect(codeOf(verify(grantDoc({ subject: subject('A'.repeat(42)) })))).toBe('subject_key_invalid');
  });

  it('rejects an incorrect subject key identifier', () => {
    const wrongId = (keyId: string) => grantDoc({ subject: { id: 'alice', type: 'human', publicKey: raw(alice), keyId } });
    expect(codeOf(verify(wrongId(deriveKeyId(outsider.publicKey))))).toBe('subject_key_id_mismatch');
    expect(codeOf(verify(wrongId('0'.repeat(64))))).toBe('subject_key_id_mismatch');
    expect(codeOf(verify(wrongId('xyz')))).toBe('grant_invalid');
    expect(codeOf(verify(wrongId(deriveKeyId(alice.publicKey).toUpperCase())))).toBe('grant_invalid');
  });

  it('rejects a subject key that is a company key: the subject must be distinct from the signing authority', () => {
    expect(codeOf(verify(grantDoc({}, grantKey)))).toBe('subject_key_is_company_key');
    expect(codeOf(verify(grantDoc({}, policyKey)))).toBe('subject_key_is_company_key');
    expect(codeOf(verify(grantDoc({}, revocationKey)))).toBe('subject_key_is_company_key');
  });

  it('rejects conflicting or malformed subject identity fields', () => {
    const ok = grantDoc().subject;
    for (const subject of [
      { ...ok, type: 'robot' },
      { ...ok, type: 'Human' },
      { ...ok, id: '' },
      { ...ok, id: 'has space' },
      { ...ok, id: 'x'.repeat(129) },
      { ...ok, email: 'a@b.c' },
      { ...ok, gitUser: 'alice' },
      { id: ok.id, type: ok.type, publicKey: ok.publicKey },
      null,
      'alice',
    ]) {
      expect(codeOf(verify(grantDoc({ subject }))), JSON.stringify(subject)).toBe('grant_invalid');
    }
  });
});

describe('roles and permissions against the signed policy', () => {
  it('rejects an undefined company role', () => {
    expect(codeOf(verify(grantDoc({ roles: ['ceo'] })))).toBe('unknown_role');
    expect(codeOf(verify(grantDoc({ roles: ['developer', 'ceo'] })))).toBe('unknown_role');
  });

  it('rejects an unknown permission in the scope', () => {
    expect(codeOf(verify(grantDoc({ permissionScope: ['root.access'] })))).toBe('unknown_permission');
  });

  it('rejects a permission escalation attempt: a scope can narrow but never add', () => {
    expect(codeOf(verify(grantDoc({ roles: ['developer'], permissionScope: ['code.change', 'deploy.production'] })))).toBe('permission_escalation');
    expect(codeOf(verify(grantDoc({ roles: [], permissionScope: ['code.change'] })))).toBe('permission_escalation');
  });

  it('rejects duplicate roles and duplicate permissions', () => {
    expect(codeOf(verify(grantDoc({ roles: ['developer', 'developer'] })))).toBe('grant_invalid');
    expect(codeOf(verify(grantDoc({ permissionScope: ['code.change', 'code.change'] })))).toBe('grant_invalid');
  });

  it('rejects malformed role and scope lists', () => {
    for (const roles of ['developer', {}, [5], ['Developer'], ['__proto__'], [''], null, undefined]) {
      expect(codeOf(verify(grantDoc({ roles }))), JSON.stringify(roles)).toBe('grant_invalid');
    }
    for (const scope of ['code.change', {}, [5], undefined]) expect(codeOf(verify(grantDoc({ permissionScope: scope }))), JSON.stringify(scope)).toBe('grant_invalid');
    expect(codeOf(verify(grantDoc({ roles: Array.from({ length: 21 }, (_, i) => `r${i}`) })))).toBe('grant_invalid');
  });

  it('rejects unsupported grant versions and structural problems', () => {
    for (const version of [0, 2, '1', null]) expect(codeOf(verify(grantDoc({ version }))), String(version)).toBe('unsupported_grant_version');
    for (const payload of ['[]', 'null', '5']) expect(codeOf(verifyGrant(sign(payload), root, policy, NOW)), payload).toBe('unsupported_grant_version');
    for (const field of ['grantId', 'organization', 'subject', 'roles', 'permissionScope', 'issuedAt', 'notBefore', 'expiresAt', 'minPolicyRevision']) {
      const doc = grantDoc();
      delete doc[field];
      expect(codeOf(verify(doc)), field).toBe('grant_invalid');
    }
    for (const grantId of ['', 'has space', 5, 'x'.repeat(65), '-x']) expect(codeOf(verify(grantDoc({ grantId }))), String(grantId)).toBe('grant_invalid');
  });

  it('failure messages never echo submitted text or key material', () => {
    const r = verify(grantDoc({ 'SENTINEL-FIELD': 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain('SENTINEL');
      expect(r.message).not.toContain(raw(alice));
    }
  });
});

describe('effective permissions', () => {
  const grantFor = (over: Record<string, unknown>): VerifiedGrant => must(verify(grantDoc(over)));
  const perms = (g: VerifiedGrant) => {
    const r = effectivePermissions(g, policy);
    if (!r.ok) throw new Error(r.code);
    return r.permissions;
  };

  it('developer role: code changes only', () => {
    expect(perms(grantFor({ roles: ['developer'] }))).toEqual(['code.change']);
  });

  it('release engineer role: code, staging and production deployment', () => {
    expect(perms(grantFor({ roles: ['release_engineer'] }))).toEqual(['code.change', 'deploy.production', 'deploy.staging']);
  });

  it('multiple roles: the sorted union, with no duplicates', () => {
    expect(perms(grantFor({ roles: ['developer', 'release_engineer', 'dba'] }))).toEqual(['code.change', 'db.migrate', 'deploy.production', 'deploy.staging']);
    const r = effectivePermissions(grantFor({ roles: ['dba', 'developer'] }), policy);
    expect(r).toMatchObject({ ok: true, roles: ['dba', 'developer'] });
  });

  it('a restrictive permission scope narrows what the roles give', () => {
    expect(perms(grantFor({ roles: ['release_engineer'], permissionScope: ['deploy.staging'] }))).toEqual(['deploy.staging']);
    expect(perms(grantFor({ roles: ['release_engineer'], permissionScope: [] }))).toEqual([]);
  });

  it('no role: no permissions', () => {
    expect(perms(grantFor({ roles: [] }))).toEqual([]);
  });

  it('no matching permission: a role never yields permissions it does not hold', () => {
    const p = perms(grantFor({ roles: ['developer'] }));
    expect(p).not.toContain('deploy.production');
    expect(p).not.toContain('db.migrate');
    expect(perms(grantFor({ roles: ['tech_lead'] }))).toEqual([]);
  });

  it('is deterministic and returns copies', () => {
    const g = grantFor({ roles: ['release_engineer'] });
    const first = effectivePermissions(g, policy);
    expect(effectivePermissions(g, policy)).toEqual(first);
    if (first.ok) (first.permissions as string[]).length = 0;
    expect(perms(g)).toHaveLength(3);
  });

  it('refuses unverified grants, unverified policies and a policy the grant was not verified against', () => {
    const g = grantFor({});
    expect(effectivePermissions({ ...g }, policy)).toEqual({ ok: false, code: 'invalid_grant' });
    expect(effectivePermissions(g, { ...policy })).toEqual({ ok: false, code: 'invalid_policy' });
    const other = { ...policyDoc(), policyId: 'acme-policy-newer' };
    const v = verifyPolicy(signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(other)), privateKey: policyKey.privateKey }), root, NOW);
    if (!v.ok) throw new Error('setup');
    expect(effectivePermissions(g, v.policy)).toEqual({ ok: false, code: 'policy_mismatch' });
  });

  it('refuses a different revision of the same policy id: the grant must be verified against it again', () => {
    const g = grantFor({});
    const sameIdNewRevision = { ...policyDoc(), revision: 6 };
    const v = verifyPolicy(signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(sameIdNewRevision)), privateKey: policyKey.privateKey }), root, NOW);
    if (!v.ok) throw new Error('setup');
    expect(v.policy.policyId).toBe(policy.policyId);
    expect(effectivePermissions(g, v.policy)).toEqual({ ok: false, code: 'policy_mismatch' });
    // once re-verified against the new revision it works again
    const again = verifyGrant(sign(grantDoc()), root, v.policy, NOW);
    if (!again.ok) throw new Error('setup');
    expect(effectivePermissions(again, v.policy).ok).toBe(true);
  });

  it('does not authorize: the result carries no decision, only permission names', () => {
    const r = effectivePermissions(grantFor({}), policy);
    expect(Object.keys(r).sort()).toEqual(['ok', 'permissions', 'roles']);
  });
});
