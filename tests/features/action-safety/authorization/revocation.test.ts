// Tests for signed revocation lists and revocation checking. In-memory keys only; offline and deterministic.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { verifyGrant, type VerifiedGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy, type PolicyDocument } from '../../../../src/features/action-safety/authorization/policy.js';
import {
  DEFAULT_MAX_LIST_AGE_HOURS,
  MAX_LIST_AGE_HOURS_LIMIT,
  checkRevocation,
  isVerifiedRevocationList,
  verifyRevocationList,
  type RevocationListResult,
  type VerifiedRevocationList,
} from '../../../../src/features/action-safety/authorization/revocation.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';

const NOW = new Date('2026-06-01T00:00:00Z');
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');
const raw = (k: Keys): string => exportRawPublicKey(k.publicKey).toString('base64url');
const id = (k: Keys): string => deriveKeyId(k.publicKey);

const entry = (k: Keys, purposes: string[]): Record<string, unknown> => ({
  keyId: id(k),
  publicKey: raw(k),
  purposes,
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2027-01-01T00:00:00Z',
});

const makeRoot = (organization: string, keys: Record<string, unknown>[]): TrustRoot => {
  const r = parseTrustRoot({ version: 1, organization, createdAt: '2026-01-01T00:00:00Z', keys });
  if (!r.ok) throw new Error(`setup: ${r.code}`);
  return r.trustRoot;
};

const policyDoc = (organization: string): Record<string, unknown> => ({
  version: 2,
  organization,
  policyId: `${organization}-policy`,
  revision: 5,
  issuedAt: '2026-05-01T00:00:00Z',
  effectiveAt: '2026-05-01T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z',
  permissions: ['code.change'],
  roles: [{ name: 'developer', permissions: ['code.change'] }],
  rules: [],
});

let policyKey: Keys;
let grantKey: Keys;
let revocationKey: Keys;
let outsider: Keys;
let alice: Keys;
let root: TrustRoot;
let grant: VerifiedGrant;

const sign = (doc: unknown, key: Keys = revocationKey, domain: 'revocation' | 'grant' | 'policy' = 'revocation') =>
  signEnvelope({ domain, payload: Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)), privateKey: key.privateKey });

const makeGrant = (organization: string, tr: TrustRoot): VerifiedGrant => {
  const p = verifyPolicy(sign(policyDoc(organization), policyKey, 'policy'), tr, NOW);
  if (!p.ok) throw new Error(`setup policy: ${p.code}`);
  const g = verifyGrant(
    sign(
      {
        version: 1,
        grantId: 'grant-alice-001',
        organization,
        subject: { id: 'alice', type: 'human', publicKey: raw(alice), keyId: id(alice) },
        roles: ['developer'],
        permissionScope: null,
        issuedAt: '2026-05-25T00:00:00Z',
        notBefore: '2026-05-25T00:00:00Z',
        expiresAt: '2026-08-01T00:00:00Z',
        minPolicyRevision: 1,
      },
      grantKey,
      'grant',
    ),
    tr,
    p.policy as PolicyDocument,
    NOW,
  );
  if (!g.ok) throw new Error(`setup grant: ${g.code}`);
  return g;
};

beforeAll(() => {
  policyKey = pair();
  grantKey = pair();
  revocationKey = pair();
  outsider = pair();
  alice = pair();
  root = makeRoot('acme', [entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])]);
  grant = makeGrant('acme', root);
});

const listDoc = (over: Record<string, unknown> = {}): Record<string, any> => ({
  version: 1,
  organization: 'acme',
  listVersion: 7,
  issuedAt: '2026-05-31T00:00:00Z',
  nextUpdate: '2026-06-07T00:00:00Z',
  revokedGrantIds: [],
  revokedSubjectKeyIds: [],
  revokedIssuerKeyIds: [],
  ...over,
});

const verify = (doc: unknown, key: Keys = revocationKey, at: Date = NOW, tr: TrustRoot = root, opts?: { maxAgeHours?: number }): RevocationListResult => verifyRevocationList(sign(doc, key), tr, at, opts);
const codeOf = (r: RevocationListResult): string | undefined => (r.ok ? undefined : r.code);
const must = (r: RevocationListResult): VerifiedRevocationList => {
  if (!r.ok) throw new Error(`expected a valid list: ${r.code} ${r.message}`);
  return r;
};

describe('valid signed revocation list', () => {
  it('verifies and returns a typed, frozen, branded list', () => {
    const r = must(verify(listDoc({ revokedGrantIds: ['grant-x'], revokedSubjectKeyIds: [id(outsider)] })));
    expect(r.list.listVersion).toBe(7);
    expect(r.list.revokedGrantIds).toEqual(['grant-x']);
    expect(r.signingKeyId).toBe(id(revocationKey));
    expect(r.maxAgeMs).toBe(DEFAULT_MAX_LIST_AGE_HOURS * 3_600_000);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.list.revokedGrantIds)).toBe(true);
    expect(isVerifiedRevocationList(r)).toBe(true);
    expect(isVerifiedRevocationList({ ...r })).toBe(false);
  });

  it('accepts an empty list and envelope text', () => {
    expect(verify(listDoc()).ok).toBe(true);
    expect(verifyRevocationList(JSON.stringify(sign(listDoc())), root, NOW).ok).toBe(true);
  });
});

describe('authenticity', () => {
  it('rejects a tampered list', () => {
    const env = sign(listDoc());
    const tampered = listDoc({ revokedGrantIds: [] , listVersion: 99 });
    expect(codeOf(verifyRevocationList({ ...env, payload: Buffer.from(JSON.stringify(tampered)).toString('base64url') }, root, NOW))).toBe('signature_verification_failed');
    expect(codeOf(verifyRevocationList({ ...env, signature: sign(listDoc({ listVersion: 8 })).signature }, root, NOW))).toBe('signature_verification_failed');
  });

  it('rejects a wrong signing key: unknown key, or a forged key id', () => {
    expect(codeOf(verify(listDoc(), outsider))).toBe('unknown_signing_key');
    expect(codeOf(verifyRevocationList({ ...sign(listDoc(), outsider), keyId: id(revocationKey) }, root, NOW))).toBe('signature_verification_failed');
  });

  it('rejects wrong key purposes: grant and policy keys cannot sign revocation lists', () => {
    expect(codeOf(verify(listDoc(), grantKey))).toBe('key_purpose_not_allowed');
    expect(codeOf(verify(listDoc(), policyKey))).toBe('key_purpose_not_allowed');
  });

  it('a revocation key cannot sign grants', () => {
    const p = verifyPolicy(sign(policyDoc('acme'), policyKey, 'policy'), root, NOW);
    if (!p.ok) throw new Error('setup');
    const g = verifyGrant(
      sign({ version: 1, grantId: 'g', organization: 'acme', subject: { id: 'alice', type: 'human', publicKey: raw(alice), keyId: id(alice) }, roles: [], permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1 }, revocationKey, 'grant'),
      root,
      p.policy,
      NOW,
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe('key_purpose_not_allowed');
  });

  it('rejects the wrong signing domain', () => {
    expect(codeOf(verifyRevocationList(sign(listDoc(), revocationKey, 'grant'), root, NOW))).toBe('wrong_domain');
    expect(codeOf(verifyRevocationList(sign(listDoc(), revocationKey, 'policy'), root, NOW))).toBe('wrong_domain');
  });

  it('rejects an unvalidated trust root, a bad time and hostile input without throwing', () => {
    expect(codeOf(verifyRevocationList(sign(listDoc()), { ...root }, NOW))).toBe('invalid_trust_root');
    expect(codeOf(verifyRevocationList(sign(listDoc()), root, new Date('x')))).toBe('invalid_evaluation_time');
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    for (const c of [null, undefined, 5, [], 'nope', '{', {}, hostile]) expect(verifyRevocationList(c, root, NOW).ok).toBe(false);
  });

  it('does not parse the payload before the signature', () => {
    expect(codeOf(verifyRevocationList(sign('{ no', outsider), root, NOW))).toBe('unknown_signing_key');
    expect(codeOf(verifyRevocationList(sign('{ no'), root, NOW))).toBe('payload_not_json');
  });

  it('rejects a cross-organization list', () => {
    expect(codeOf(verify(listDoc({ organization: 'globex' })))).toBe('organization_mismatch');
    const globexRoot = makeRoot('globex', [entry(revocationKey, ['revocation'])]);
    expect(codeOf(verify(listDoc(), revocationKey, NOW, globexRoot))).toBe('organization_mismatch');
  });
});

describe('freshness', () => {
  it('rejects a stale list: older than the freshness window although nextUpdate is still ahead', () => {
    expect(codeOf(verify(listDoc({ issuedAt: '2026-05-25T00:00:00Z', nextUpdate: '2026-06-20T00:00:00Z' })))).toBe('list_stale');
    expect(codeOf(verify(listDoc({ issuedAt: '2026-05-28T00:00:00Z' })))).toBe('list_stale'); // 4 days
    expect(verify(listDoc({ issuedAt: '2026-05-29T00:00:00Z' })).ok).toBe(true); // exactly 72 hours
  });

  it('lets a caller choose a different window, within limits', () => {
    const old = listDoc({ issuedAt: '2026-05-25T00:00:00Z', nextUpdate: '2026-06-20T00:00:00Z' });
    expect(verify(old, revocationKey, NOW, root, { maxAgeHours: 24 * 10 }).ok).toBe(true);
    expect(codeOf(verify(listDoc(), revocationKey, NOW, root, { maxAgeHours: 1 }))).toBe('list_stale');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_LIST_AGE_HOURS_LIMIT + 1, '72']) {
      expect(codeOf(verify(listDoc(), revocationKey, NOW, root, { maxAgeHours: bad as number })), String(bad)).toBe('invalid_options');
    }
  });

  it('rejects a list issued in the future', () => {
    expect(codeOf(verify(listDoc({ issuedAt: '2026-06-02T00:00:00Z', nextUpdate: '2026-06-09T00:00:00Z' })))).toBe('list_not_yet_issued');
  });

  it('rejects a list past its next-update time (exclusive end)', () => {
    expect(codeOf(verify(listDoc({ issuedAt: '2026-05-25T00:00:00Z', nextUpdate: '2026-05-31T00:00:00Z' })))).toBe('list_expired');
    expect(codeOf(verify(listDoc({ issuedAt: '2026-05-31T00:00:00Z', nextUpdate: '2026-06-01T00:00:00Z' })))).toBe('list_expired');
  });
});

describe('list structure', () => {
  it('rejects unsupported versions', () => {
    for (const version of [0, 2, '1', null]) expect(codeOf(verify(listDoc({ version }))), String(version)).toBe('unsupported_list_version');
    for (const payload of ['[]', 'null', '7']) expect(codeOf(verifyRevocationList(sign(payload), root, NOW)), payload).toBe('unsupported_list_version');
  });

  it('rejects missing and extra fields', () => {
    expect(codeOf(verify(listDoc({ extra: 1 })))).toBe('list_invalid');
    for (const field of ['organization', 'listVersion', 'issuedAt', 'nextUpdate', 'revokedGrantIds', 'revokedSubjectKeyIds', 'revokedIssuerKeyIds']) {
      const doc = listDoc();
      delete doc[field];
      expect(codeOf(verify(doc)), field).toBe('list_invalid');
    }
  });

  it('rejects duplicate and malformed entries', () => {
    expect(codeOf(verify(listDoc({ revokedGrantIds: ['a', 'a'] })))).toBe('list_invalid');
    expect(codeOf(verify(listDoc({ revokedSubjectKeyIds: [id(alice), id(alice)] })))).toBe('list_invalid');
    expect(codeOf(verify(listDoc({ revokedIssuerKeyIds: [id(alice), id(alice)] })))).toBe('list_invalid');
    for (const bad of ['', 'has space', 5, null, {}, '-x', 'x'.repeat(65)]) expect(codeOf(verify(listDoc({ revokedGrantIds: [bad] }))), String(bad)).toBe('list_invalid');
    for (const bad of ['abc', id(alice).toUpperCase(), `${id(alice)}0`, id(alice).slice(1), 5, null]) {
      expect(codeOf(verify(listDoc({ revokedSubjectKeyIds: [bad] }))), String(bad)).toBe('list_invalid');
      expect(codeOf(verify(listDoc({ revokedIssuerKeyIds: [bad] }))), String(bad)).toBe('list_invalid');
    }
    for (const notList of ['a', {}, 5, null]) expect(codeOf(verify(listDoc({ revokedGrantIds: notList }))), String(notList)).toBe('list_invalid');
  });

  it('rejects bad list versions, timestamps and spans', () => {
    for (const listVersion of [0, -1, 1.5, '7', null, Number.NaN]) expect(codeOf(verify(listDoc({ listVersion }))), String(listVersion)).toBe('list_invalid');
    for (const bad of ['soon', '2026-02-31T00:00:00Z', '2026-05-31', '2026-05-31T00:00:00+01:00', 5, null]) {
      expect(codeOf(verify(listDoc({ issuedAt: bad }))), String(bad)).toBe('list_invalid');
      expect(codeOf(verify(listDoc({ nextUpdate: bad }))), String(bad)).toBe('list_invalid');
    }
    expect(codeOf(verify(listDoc({ nextUpdate: '2026-05-31T00:00:00Z' })))).toBe('list_invalid'); // not after issuedAt
    expect(codeOf(verify(listDoc({ nextUpdate: '2026-09-01T00:00:00Z' })))).toBe('list_invalid'); // span over 30 days
    expect(codeOf(verify(listDoc({ organization: 'Bad Org' })))).toBe('list_invalid');
  });

  it('failure messages never echo submitted text', () => {
    const r = verify(listDoc({ 'SENTINEL-FIELD': 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('SENTINEL');
  });
});

describe('checking a grant against a list', () => {
  const list = (over: Record<string, unknown> = {}) => verify(listDoc(over));

  it('a revoked grant id is explicitly revoked', () => {
    expect(checkRevocation(grant, list({ revokedGrantIds: ['grant-alice-001'] }), NOW)).toEqual({ status: 'revoked', revokedBy: ['grant_id'], listVersion: 7 });
  });

  it('a revoked subject key is explicitly revoked, even under a different grant id', () => {
    expect(checkRevocation(grant, list({ revokedSubjectKeyIds: [id(alice)] }), NOW)).toMatchObject({ status: 'revoked', revokedBy: ['subject_key'] });
  });

  it('a revoked issuer key is explicitly revoked', () => {
    expect(checkRevocation(grant, list({ revokedIssuerKeyIds: [id(grantKey)] }), NOW)).toMatchObject({ status: 'revoked', revokedBy: ['issuer_key'] });
  });

  it('reports every reason when several match', () => {
    const r = checkRevocation(grant, list({ revokedGrantIds: ['grant-alice-001'], revokedSubjectKeyIds: [id(alice)], revokedIssuerKeyIds: [id(grantKey)] }), NOW);
    expect(r).toMatchObject({ status: 'revoked', revokedBy: ['grant_id', 'subject_key', 'issuer_key'] });
  });

  it('a grant absent from a verified, fresh list is "not_listed", which is not authorization', () => {
    const r = checkRevocation(grant, list({ revokedGrantIds: ['someone-else'], revokedSubjectKeyIds: [id(outsider)] }), NOW);
    expect(r).toEqual({ status: 'not_listed', listVersion: 7, listIssuedAt: '2026-05-31T00:00:00Z', listNextUpdate: '2026-06-07T00:00:00Z' });
    expect('authorized' in r).toBe(false);
  });

  it('does not confuse key id spaces: a subject key id listed as an issuer key does not revoke', () => {
    expect(checkRevocation(grant, list({ revokedIssuerKeyIds: [id(alice)] }), NOW).status).toBe('not_listed');
    expect(checkRevocation(grant, list({ revokedSubjectKeyIds: [id(grantKey)] }), NOW).status).toBe('not_listed');
    expect(checkRevocation(grant, list({ revokedGrantIds: [id(alice)] }), NOW).status).toBe('not_listed');
  });

  it('a missing required list is unavailable, never clean', () => {
    expect(checkRevocation(grant, undefined, NOW)).toEqual({ status: 'unavailable', reason: 'no_list' });
    expect(checkRevocation(grant, null as unknown as undefined, NOW)).toEqual({ status: 'unavailable', reason: 'no_list' });
  });

  it('a failed verification is unavailable: every failure kind, never "not revoked"', () => {
    const failures = [
      verify(listDoc(), outsider),
      verify(listDoc(), grantKey),
      verify(listDoc({ issuedAt: '2026-05-01T00:00:00Z', nextUpdate: '2026-05-20T00:00:00Z' })),
      verify(listDoc({ organization: 'globex' })),
      verify(listDoc({ extra: 1 })),
    ];
    for (const f of failures) {
      expect(f.ok).toBe(false);
      expect(checkRevocation(grant, f, NOW)).toEqual({ status: 'unavailable', reason: 'list_unverified' });
    }
  });

  it('refuses a hand-built list, even one that names the grant as clean', () => {
    const fake = { ok: true, list: listDoc(), signingKeyId: id(revocationKey), maxAgeMs: 1e12 } as unknown as RevocationListResult;
    expect(checkRevocation(grant, fake, NOW)).toEqual({ status: 'unavailable', reason: 'list_unverified' });
  });

  it('refuses an unverified grant', () => {
    expect(checkRevocation({ ...grant }, list(), NOW)).toEqual({ status: 'unavailable', reason: 'grant_unverified' });
    expect(checkRevocation(null as unknown as VerifiedGrant, list(), NOW)).toEqual({ status: 'unavailable', reason: 'grant_unverified' });
  });

  it('re-applies freshness when checking: a list that has gone stale or expired is unavailable', () => {
    const l = list();
    expect(checkRevocation(grant, l, new Date('2026-06-03T00:00:00Z')).status).toBe('not_listed'); // 72h exactly
    expect(checkRevocation(grant, l, new Date('2026-06-03T00:00:01Z'))).toEqual({ status: 'unavailable', reason: 'list_stale' });
    expect(checkRevocation(grant, l, new Date('2026-06-08T00:00:00Z'))).toEqual({ status: 'unavailable', reason: 'list_expired' });
    expect(checkRevocation(grant, l, new Date('2026-05-30T00:00:00Z'))).toEqual({ status: 'unavailable', reason: 'list_not_yet_issued' });
    expect(checkRevocation(grant, l, new Date('nope'))).toEqual({ status: 'unavailable', reason: 'invalid_evaluation_time' });
  });

  it('an explicit revocation still wins after the list has gone stale (an old revocation never un-revokes)', () => {
    const l = list({ revokedGrantIds: ['grant-alice-001'] });
    expect(checkRevocation(grant, l, new Date('2026-06-20T00:00:00Z')).status).toBe('revoked');
  });

  it('uses the freshness window the list was verified under', () => {
    const l = verify(listDoc({ issuedAt: '2026-05-25T00:00:00Z', nextUpdate: '2026-06-20T00:00:00Z' }), revocationKey, NOW, root, { maxAgeHours: 24 * 10 });
    expect(checkRevocation(grant, l, NOW).status).toBe('not_listed');
    expect(checkRevocation(grant, l, new Date('2026-06-10T00:00:00Z'))).toEqual({ status: 'unavailable', reason: 'list_stale' });
  });

  it('a list from another organization says nothing about this grant', () => {
    const globexRoot = makeRoot('globex', [entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])]);
    const globexGrant = makeGrant('globex', globexRoot);
    const acmeList = list();
    expect(checkRevocation(globexGrant, acmeList, NOW)).toEqual({ status: 'unavailable', reason: 'organization_mismatch' });
    expect(checkRevocation(globexGrant, verify(listDoc({ organization: 'globex' }), revocationKey, NOW, globexRoot), NOW).status).toBe('not_listed');
  });

  it('is pure and deterministic', () => {
    const l = list({ revokedGrantIds: ['grant-alice-001'] });
    expect(checkRevocation(grant, l, NOW)).toEqual(checkRevocation(grant, l, NOW));
  });
});
