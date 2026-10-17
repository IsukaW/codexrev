// Tests for the combined authorization evaluator. In-memory Ed25519 keys only; offline and deterministic.
//
// IMPORTANT: `simulatedStore` below is a TEST DOUBLE. It models atomic single-use semantics inside one
// process so the evaluator's use of a challenge store can be exercised. It is NOT durable, NOT protected
// from the person being checked, and gives NO real replay protection. Real protection needs an external
// trusted store with atomic, persistent semantics.

import { readFileSync } from 'node:fs';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { URL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import {
  evaluateAuthorization,
  isAuthorizationEvaluation,
  type AuthorizationEvaluation,
  type EvaluateAuthorizationParams,
} from '../../../../src/features/action-safety/authorization/evaluateAuthorization.js';
import { verifyGrant, type VerifiedGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy, type PolicyDocument } from '../../../../src/features/action-safety/authorization/policy.js';
import { computeContentDigest, createProof, generateChallenge, type ActionContext, type ChallengeStore } from '../../../../src/features/action-safety/authorization/proof.js';
import { verifyRevocationList, type RevocationListResult } from '../../../../src/features/action-safety/authorization/revocation.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';

const NOW = new Date('2026-06-01T12:00:00Z');
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

const policyDoc = (revision = 5): Record<string, unknown> => ({
  version: 2,
  organization: 'acme',
  policyId: 'acme-policy',
  revision,
  issuedAt: '2026-05-01T00:00:00Z',
  effectiveAt: '2026-05-01T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z',
  permissions: ['code.change', 'deploy.staging', 'deploy.production', 'db.migrate'],
  roles: [
    { name: 'developer', permissions: ['code.change'] },
    { name: 'release_engineer', permissions: ['code.change', 'deploy.staging', 'deploy.production'] },
    { name: 'dba', permissions: ['db.migrate'] },
    { name: 'tech_lead', permissions: [] },
    { name: 'security_reviewer', permissions: [] },
  ],
  rules: [
    { action: 'code_change', environment: 'development', allowedRoles: ['developer', 'release_engineer'], requiredPermissions: ['code.change'] },
    { action: 'deployment', environment: 'staging', allowedRoles: ['release_engineer'], requiredPermissions: ['deploy.staging'] },
    { action: 'deployment', environment: 'production', allowedRoles: ['release_engineer'], requiredPermissions: ['deploy.production'] },
    { action: 'database_migration', environment: 'production', allowedRoles: ['dba'], requiredPermissions: ['db.migrate'] },
  ],
});

const signRaw = (doc: unknown, key: Keys, domain: 'proof' | 'grant' | 'policy' | 'revocation') =>
  signEnvelope({ domain, payload: Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)), privateKey: key.privateKey });

let policyKey: Keys;
let grantKey: Keys;
let revocationKey: Keys;
let outsider: Keys;
let rajKey: Keys;
let aliceKey: Keys;
let danaKey: Keys;
let raeKey: Keys;
let lead1Key: Keys;
let devKey: Keys;
let root: TrustRoot;
let policy: PolicyDocument;
let raj: VerifiedGrant; // release engineer AND tech lead
let alice: VerifiedGrant; // developer
let dana: VerifiedGrant; // dba
let rae: VerifiedGrant; // release engineer whose grant is scoped down to code.change only
let dev: VerifiedGrant; // developer: may not deploy to production

const verifiedPolicy = (revision: number): PolicyDocument => {
  const p = verifyPolicy(signRaw(policyDoc(revision), policyKey, 'policy'), root, NOW);
  if (!p.ok) throw new Error(`setup policy: ${p.code}`);
  return p.policy;
};

const issueGrant = (who: Keys, grantId: string, subjectId: string, roles: string[], over: Record<string, unknown> = {}, pol: PolicyDocument = policy): VerifiedGrant => {
  const g = verifyGrant(
    signRaw(
      {
        version: 1,
        grantId,
        organization: 'acme',
        subject: { id: subjectId, type: 'human', publicKey: raw(who), keyId: id(who) },
        roles,
        permissionScope: null,
        issuedAt: '2026-05-25T00:00:00Z',
        notBefore: '2026-05-25T00:00:00Z',
        expiresAt: '2026-08-01T00:00:00Z',
        minPolicyRevision: 1,
        ...over,
      },
      grantKey,
      'grant',
    ),
    root,
    pol,
    NOW,
  );
  if (!g.ok) throw new Error(`setup grant ${grantId}: ${g.code}`);
  return g;
};

beforeAll(() => {
  [policyKey, grantKey, revocationKey, outsider, rajKey, aliceKey, danaKey, raeKey, lead1Key, devKey] = Array.from({ length: 10 }, pair) as Keys[];
  const r = parseTrustRoot({
    version: 1,
    organization: 'acme',
    createdAt: '2026-01-01T00:00:00Z',
    keys: [entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])],
  });
  if (!r.ok) throw new Error('setup trust root');
  root = r.trustRoot;
  policy = verifiedPolicy(5);
  raj = issueGrant(rajKey, 'grant-raj-001', 'raj', ['release_engineer', 'tech_lead']);
  alice = issueGrant(aliceKey, 'grant-alice-001', 'alice', ['developer']);
  dana = issueGrant(danaKey, 'grant-dana-001', 'dana', ['dba']);
  rae = issueGrant(raeKey, 'grant-rae-001', 'rae', ['release_engineer'], { permissionScope: ['code.change'] });
  dev = issueGrant(devKey, 'grant-dev-001', 'dev', ['developer']);
});

// ---------------------------------------------------------------- scenario builders

const COMMIT = 'b'.repeat(40);
const prodDeploy = (over: Partial<ActionContext> = {}): ActionContext => ({
  actionId: 'act-deploy-1',
  actionType: 'deployment',
  environment: 'production',
  target: 'payments-service',
  commit: COMMIT,
  contentDigest: computeContentDigest(Buffer.from('{"deploy":"payments-service","build":"1.4.2"}')),
  ...over,
});
const devChange = (): ActionContext => ({ actionId: 'act-dev-1', actionType: 'code_change', environment: 'development', target: 'payments-service', commit: 'a'.repeat(40), contentDigest: computeContentDigest(Buffer.from('diff --git a/x b/x')) });
const migration = (): ActionContext => prodDeploy({ actionId: 'act-migrate-1', actionType: 'database_migration', target: 'payments-db', contentDigest: computeContentDigest(Buffer.from('ALTER TABLE t ADD c int;')) });

/** A simulation only: see the header of this file. */
const simulatedStore = (): ChallengeStore & { calls: Array<{ challenge: string; grantId: string; actionId: string; expiresAt: string }> } => {
  const used = new Set<string>();
  const calls: Array<{ challenge: string; grantId: string; actionId: string; expiresAt: string }> = [];
  return {
    calls,
    async consume(entry) {
      calls.push({ ...entry });
      if (used.has(entry.challenge)) return 'already_used';
      used.add(entry.challenge); // check-and-record in one synchronous step: atomic within this process
      return 'consumed';
    },
  };
};

const list = (over: Record<string, unknown> = {}, maxAgeHours?: number): RevocationListResult =>
  verifyRevocationList(
    signRaw({ version: 1, organization: 'acme', listVersion: 3, issuedAt: '2026-06-01T00:00:00Z', nextUpdate: '2026-06-05T00:00:00Z', revokedGrantIds: [], revokedSubjectKeyIds: [], revokedIssuerKeyIds: [], ...over }, revocationKey, 'revocation'),
    root,
    NOW,
    maxAgeHours === undefined ? {} : { maxAgeHours },
  );

type Scenario = EvaluateAuthorizationParams & { challengeStore: ReturnType<typeof simulatedStore> };

/** A complete, valid production deployment by `raj` (a release engineer). Tests then break one thing. */
const scenario = (over: Partial<EvaluateAuthorizationParams> = {}, at: Date = NOW): Scenario => {
  const context = prodDeploy();
  const challenge = generateChallenge();
  // when `at` lies outside the grants, signing refuses; fall back to artifacts made at NOW, which are then simply out of date
  const orNow = <T>(make: (issuedAt: Date) => T): T => {
    try {
      return make(at);
    } catch {
      return make(NOW);
    }
  };
  return {
    trustRoot: root,
    policy,
    requester: raj,
    revocation: list(),
    context,
    challenge,
    proof: orNow((issuedAt) => createProof({ privateKey: rajKey.privateKey, grant: raj, context, challenge, issuedAt })),
    challengeStore: simulatedStore(),
    now: at,
    ...over,
  } as Scenario;
};

const devScenario = (over: Partial<EvaluateAuthorizationParams> = {}): Scenario => {
  const context = devChange();
  const challenge = generateChallenge();
  return scenario({ requester: alice, context, challenge, proof: createProof({ privateKey: aliceKey.privateKey, grant: alice, context, challenge, issuedAt: NOW }), ...over });
};

const migrationScenario = (over: Partial<EvaluateAuthorizationParams> = {}): Scenario => {
  const context = migration();
  const challenge = generateChallenge();
  return scenario({
    requester: dana,
    context,
    challenge,
    proof: createProof({ privateKey: danaKey.privateKey, grant: dana, context, challenge, issuedAt: NOW }),
    ...over,
  });
};

const run = (s: EvaluateAuthorizationParams): Promise<AuthorizationEvaluation> => evaluateAuthorization(s);
const storeCalls = (s: Scenario): number => s.challengeStore.calls.length;
const codes = (e: AuthorizationEvaluation): Record<string, string> => Object.fromEntries(Object.entries(e.checks).map(([k, v]) => [k, `${v.status}:${v.code}`]));

// ---------------------------------------------------------------- tests

describe('every prerequisite satisfied', () => {
  it('authorizes a production deployment by a release engineer with a verified grant and proof, without any separate approval, and a consumed challenge', async () => {
    const s = scenario();
    const e = await run(s);
    expect(e.outcome).toBe('authorized');
    expect(codes(e)).toEqual({
      policy: 'passed:policy_permits_action',
      requesterGrant: 'passed:grant_valid',
      requesterRevocation: 'passed:grant_not_revoked',
      roles: 'passed:role_eligible',
      permissions: 'passed:permissions_sufficient',
      proofOfPossession: 'passed:proof_valid',
      challengeConsumption: 'passed:challenge_consumed',
    });
    expect(e.replayProtection).toBe('consumed');
    expect(e.executionPerformed).toBe(false);
    expect(e.requirements).toMatchObject({ requiredRoles: ['release_engineer'], requiredPermissions: ['deploy.production'], policy: { policyId: 'acme-policy', revision: 5 } });
    expect(storeCalls(s)).toBe(1);
    expect(isAuthorizationEvaluation(e)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
  });

  it('authorizes a permitted development code change by a developer', async () => {
    const s = devScenario();
    const e = await run(s);
    expect(e.outcome).toBe('authorized');
    expect(storeCalls(s)).toBe(1);
  });

  it('authorizes a production database migration by a dba, again without any approval', async () => {
    const e = await run(migrationScenario());
    expect(e.outcome).toBe('authorized');
    expect(Object.keys(e.checks)).not.toContain('approvals');
  });

  it('every check carries a fixed message, and there is no approval check at all', async () => {
    const e = await run(scenario());
    for (const c of Object.values(e.checks)) expect(c.message.length).toBeGreaterThan(5);
    expect(Object.keys(e.checks).sort()).toEqual(['challengeConsumption', 'permissions', 'policy', 'proofOfPossession', 'requesterGrant', 'requesterRevocation', 'roles']);
    expect(e).not.toHaveProperty('approvalEntries');
  });
});

describe('policy and roles', () => {
  it('denies a prohibited action and never consumes the challenge', async () => {
    const s = scenario({ context: prodDeploy({ actionType: 'rollback' }) });
    const e = await run(s);
    expect(e.outcome).toBe('denied');
    expect(e.checks.policy).toMatchObject({ status: 'failed', code: 'action_not_permitted', detail: 'no_matching_rule' });
    expect(e.requirements).toBeUndefined();
    expect(storeCalls(s)).toBe(0);
  });

  it('denies an unknown action or environment as an invalid context', async () => {
    for (const bad of [{ actionType: 'launch_missiles' }, { environment: 'moon' }, { actionType: 5 }, { environment: null }]) {
      const s = scenario({ context: { ...prodDeploy(), ...bad } as unknown as ActionContext });
      const e = await run(s);
      expect(e.outcome, JSON.stringify(bad)).toBe('denied');
      expect(e.checks.policy.code).toBe('invalid_context');
      expect(storeCalls(s)).toBe(0);
    }
  });

  it('denies a permitted-looking action in an environment the policy does not cover', async () => {
    const e = await run(scenario({ context: prodDeploy({ environment: 'testing' }) }));
    expect(e).toMatchObject({ outcome: 'denied' });
    expect(e.checks.policy).toMatchObject({ code: 'action_not_permitted', detail: 'no_matching_rule' });
  });

  it('denies a requester without an eligible role', async () => {
    const context = prodDeploy();
    const challenge = generateChallenge();
    const s = scenario({ requester: dev, challenge, proof: createProof({ privateKey: devKey.privateKey, grant: dev, context, challenge, issuedAt: NOW }) });
    const e = await run(s);
    expect(e.outcome).toBe('denied');
    expect(e.checks.roles).toMatchObject({ status: 'failed', code: 'role_missing' });
    expect(e.checks.proofOfPossession.status).toBe('passed'); // a valid proof does not make up for a missing role
    expect(storeCalls(s)).toBe(0);
  });

  it('denies a requester with the role but without a required permission (restricted grant scope)', async () => {
    const context = prodDeploy({ environment: 'staging', actionId: 'act-stage-1' });
    const challenge = generateChallenge();
    const s = scenario({ requester: rae, context, challenge, proof: createProof({ privateKey: raeKey.privateKey, grant: rae, context, challenge, issuedAt: NOW }), });
    const e = await run(s);
    expect(e.outcome).toBe('denied');
    expect(e.checks.roles).toMatchObject({ status: 'passed', code: 'role_eligible' });
    expect(e.checks.permissions).toMatchObject({ status: 'failed', code: 'permission_missing', detail: 'deploy.staging' });
    expect(storeCalls(s)).toBe(0);
  });

  it('a restricted scope still allows what it keeps', async () => {
    const context = devChange();
    const challenge = generateChallenge();
    const e = await run(scenario({ requester: rae, context, challenge, proof: createProof({ privateKey: raeKey.privateKey, grant: rae, context, challenge, issuedAt: NOW }) }));
    expect(e.outcome).toBe('authorized');
  });

  it('denies when the grant was verified against a different policy revision', async () => {
    const p6 = verifiedPolicy(6);
    const e = await run(scenario({ policy: p6 }));
    expect(e.outcome).toBe('denied');
    expect(e.checks.requesterGrant).toMatchObject({ status: 'failed', code: 'grant_policy_mismatch' });
    // effective permissions are never computed against a policy the grant was not verified for
    expect(e.checks.roles).toMatchObject({ status: 'failed', code: 'roles_unavailable' });
    expect(e.checks.permissions).toMatchObject({ status: 'failed', code: 'permissions_unavailable' });
  });

  it('requires the policy to be a verified policy and the trust root a validated trust root', async () => {
    expect((await run(scenario({ policy: { ...policy } }))).checks.policy.code).toBe('policy_unverified');
    expect((await run(scenario({ policy: policyDoc() as unknown as PolicyDocument }))).outcome).toBe('denied');
    expect((await run(scenario({ trustRoot: { ...root } }))).checks.policy.code).toBe('trust_root_invalid');
  });

  it('denies when the policy is not in effect at the evaluation time', async () => {
    const e = await run(scenario({}, new Date('2026-12-05T00:00:00Z')));
    expect(e.outcome).toBe('denied');
    expect(e.checks.policy.code).toBe('policy_not_current');
  });

  it('denies when the requester belongs to another organization than the trust root', async () => {
    const globexRoot = parseTrustRoot({ version: 1, organization: 'globex', createdAt: '2026-01-01T00:00:00Z', keys: [entry(policyKey, ['policy'])] });
    if (!globexRoot.ok) throw new Error('setup');
    const e = await run(scenario({ trustRoot: globexRoot.trustRoot }));
    expect(e.outcome).toBe('denied');
    expect(e.checks.policy.code).toBe('organization_mismatch');
  });

  it('never lets the requester lower the policy: requirements come from the policy, whatever extra fields are passed', async () => {
    const context = prodDeploy();
    const challenge = generateChallenge();
    const s = scenario({ requester: dev, challenge, proof: createProof({ privateKey: devKey.privateKey, grant: dev, context, challenge, issuedAt: NOW }) });
    const e = await run({ ...s, requiredRoles: [], requiredPermissions: [] } as EvaluateAuthorizationParams);
    expect(e.requirements?.requiredRoles).toEqual(['release_engineer']);
    expect(e.requirements?.requiredPermissions).toEqual(['deploy.production']);
    expect(e.outcome).toBe('denied');
    expect(e.checks.roles.status).toBe('failed');
  });
});

describe('requester verification and revocation', () => {
  it('denies a forged or unverified grant', async () => {
    for (const fake of [{ ...raj }, { ok: true, verified: true, grant: raj.grant }, null, undefined, 5, 'raj']) {
      const s = scenario({ requester: fake as unknown as VerifiedGrant });
      const e = await run(s);
      expect(e.outcome, JSON.stringify(fake)).toBe('denied');
      expect(e.checks.requesterGrant.code).toBe('requester_unverified');
      expect(storeCalls(s)).toBe(0);
    }
  });

  it('denies an expired grant', async () => {
    // the grant ends 2026-08-01; the policy runs until 2026-12-01, so only the grant is out of date
    const at = new Date('2026-08-02T00:00:00Z');
    const e = await run(scenario({ revocation: undefined }, at));
    expect(e.outcome).toBe('denied');
    expect(e.checks.requesterGrant).toMatchObject({ status: 'failed', code: 'grant_expired' });
    expect(e.checks.policy.status).toBe('passed');
  });

  it('denies a grant that is not valid yet', async () => {
    const e = await run(scenario({}, new Date('2026-05-20T00:00:00Z')));
    expect(e.outcome).toBe('denied');
    expect(e.checks.requesterGrant.code).toBe('grant_not_yet_valid');
  });

  it('denies a revoked grant, by grant id, subject key or issuer key, even with a valid proof', async () => {
    for (const revoke of [{ revokedGrantIds: ['grant-raj-001'] }, { revokedSubjectKeyIds: [id(rajKey)] }, { revokedIssuerKeyIds: [id(grantKey)] }]) {
      const s = scenario({ revocation: list(revoke) });
      const e = await run(s);
      expect(e.outcome, JSON.stringify(revoke)).toBe('denied');
      expect(e.checks.requesterRevocation).toMatchObject({ status: 'failed', code: 'grant_revoked' });
      expect(e.checks.proofOfPossession.status).toBe('passed');
      expect(storeCalls(s)).toBe(0);
    }
  });

  it('a missing revocation list is incomplete, never clean', async () => {
    const s = scenario({ revocation: undefined });
    const e = await run(s);
    expect(e.outcome).toBe('incomplete');
    expect(e.checks.requesterRevocation).toMatchObject({ status: 'incomplete', code: 'revocation_unavailable', detail: 'no_list' });
    expect(storeCalls(s)).toBe(0);
  });

  it('a stale or invalid revocation list is incomplete, never clean', async () => {
    const staleAtVerification = list({ issuedAt: '2026-05-24T00:00:00Z', nextUpdate: '2026-06-10T00:00:00Z' });
    expect(staleAtVerification.ok).toBe(false);
    const forged = verifyRevocationList(signRaw({ version: 1 }, outsider, 'revocation'), root, NOW);
    for (const revocation of [staleAtVerification, forged, list({ organization: 'globex' }), { ok: true } as never]) {
      const s = scenario({ revocation });
      const e = await run(s);
      expect(e.outcome).toBe('incomplete');
      expect(e.checks.requesterRevocation).toMatchObject({ status: 'incomplete', detail: 'list_unverified' });
      expect(storeCalls(s)).toBe(0);
    }
  });

  it('a list that went stale between verification and evaluation is incomplete', async () => {
    const shortWindow = list({}, 13); // 12 hours old at NOW: fresh, but only for another hour
    expect(shortWindow.ok).toBe(true);
    const later = new Date('2026-06-01T13:30:00Z');
    const s = scenario({ revocation: shortWindow }, later);
    const e = await run(s);
    expect(e.outcome).toBe('incomplete');
    expect(e.checks.requesterRevocation).toMatchObject({ status: 'incomplete', detail: 'list_stale' });
    expect(await run(scenario({ revocation: shortWindow }, NOW))).toMatchObject({ outcome: 'authorized' });
  });
});

describe('proof of possession', () => {
  it('a valid proof matching the action passes', async () => {
    expect((await run(scenario())).checks.proofOfPossession).toMatchObject({ status: 'passed', code: 'proof_valid' });
  });

  it('denies a wrong challenge: the expected challenge is supplied independently of the proof', async () => {
    const s = scenario({ challenge: generateChallenge() });
    const e = await run(s);
    expect(e.outcome).toBe('denied');
    expect(e.checks.proofOfPossession).toMatchObject({ status: 'failed', code: 'proof_invalid', detail: 'wrong_challenge' });
    expect(storeCalls(s)).toBe(0);
  });

  it('denies a proof made for a different action, digest or commit', async () => {
    const cases: Array<[Partial<ActionContext>, string]> = [
      [{ actionId: 'act-other' }, 'wrong_action'],
      [{ contentDigest: computeContentDigest(Buffer.from('another change')) }, 'wrong_content'],
      [{ commit: 'c'.repeat(40) }, 'wrong_commit'],
      [{ target: 'billing-service' }, 'wrong_target'],
    ];
    for (const [change, detail] of cases) {
      const s = scenario({ context: prodDeploy(change) }); // the proof were made for the original action
      const e = await run(s);
      expect(e.outcome, detail).toBe('denied');
      expect(e.checks.proofOfPossession).toMatchObject({ status: 'failed', detail });
      expect(storeCalls(s)).toBe(0);
    }
  });

  it('denies an expired proof', async () => {
    const context = prodDeploy();
    const challenge = generateChallenge();
    const old = createProof({ privateKey: rajKey.privateKey, grant: raj, context, challenge, issuedAt: new Date('2026-06-01T11:00:00Z') });
    const s = scenario({ challenge, proof: old });
    const e = await run(s);
    expect(e.outcome).toBe('denied');
    expect(e.checks.proofOfPossession).toMatchObject({ code: 'proof_invalid', detail: 'expired_proof' });
  });

  it("denies a proof signed with the wrong key (another person's key under the requester's grant)", async () => {
    const context = prodDeploy();
    const challenge = generateChallenge();
    const doc = {
      version: 1, organization: 'acme', grantId: 'grant-raj-001', subjectId: 'raj', subjectKeyId: id(rajKey), ...context, challenge,
      issuedAt: '2026-06-01T12:00:00Z', expiresAt: '2026-06-01T12:05:00Z',
    };
    const e = await run(scenario({ challenge, proof: signRaw(doc, lead1Key, 'proof') }));
    expect(e.outcome).toBe('denied');
    expect(e.checks.proofOfPossession).toMatchObject({ status: 'failed', detail: 'wrong_subject' });
  });

  it("denies another developer's proof", async () => {
    const context = prodDeploy();
    const challenge = generateChallenge();
    const aliceProof = createProof({ privateKey: aliceKey.privateKey, grant: alice, context, challenge, issuedAt: NOW });
    const e = await run(scenario({ challenge, proof: aliceProof }));
    expect(e.outcome).toBe('denied');
    expect(e.checks.proofOfPossession.status).toBe('failed');
  });

  it('a missing proof is incomplete, and malformed proofs are denied', async () => {
    const s = scenario({ proof: undefined });
    const e = await run(s);
    expect(e.outcome).toBe('incomplete');
    expect(e.checks.proofOfPossession).toMatchObject({ status: 'incomplete', code: 'proof_missing' });
    expect(storeCalls(s)).toBe(0);
    for (const proof of ['nope', 5, {}, [], '{', { domain: 'proof' }]) expect((await run(scenario({ proof }))).outcome, JSON.stringify(proof)).toBe('denied');
  });
});

describe('challenge consumption and replay', () => {
  it('a valid proof with no challenge store is incomplete, not authorized', async () => {
    const s = scenario({ challengeStore: undefined });
    const e = await run(s);
    expect(e.outcome).toBe('incomplete');
    expect(e.checks.challengeConsumption).toMatchObject({ status: 'incomplete', code: 'no_challenge_store' });
    expect(e.replayProtection).toBe('not_enforced');
    for (const name of ['policy', 'requesterGrant', 'requesterRevocation', 'roles', 'permissions', 'proofOfPossession'] as const) expect(e.checks[name].status).toMatch(/passed|not_required/);
  });

  it('an unavailable challenge store is incomplete (throws, rejects, nonsense, missing method)', async () => {
    const broken: ChallengeStore[] = [
      { consume: () => { throw new Error('disk gone'); } },
      { consume: async () => { throw new Error('db down'); } },
      { consume: async () => 'maybe' as never },
      { consume: async () => undefined as never },
      {} as ChallengeStore,
    ];
    for (const challengeStore of broken) {
      const e = await run(scenario({ challengeStore }));
      expect(e.outcome).toBe('incomplete');
      expect(e.checks.challengeConsumption).toMatchObject({ status: 'incomplete', code: 'challenge_store_unavailable' });
      expect(e.replayProtection).toBe('not_enforced');
    }
  });

  it('consumes the challenge exactly once, with the proof challenge, grant, action and expiry, only after everything else passed', async () => {
    const s = scenario();
    const e = await run(s);
    expect(e.outcome).toBe('authorized');
    expect(s.challengeStore.calls).toEqual([{ challenge: s.challenge, grantId: 'grant-raj-001', actionId: 'act-deploy-1', expiresAt: '2026-06-01T12:05:00Z' }]);
  });

  it('reusing an already consumed challenge is denied', async () => {
    const s = scenario();
    expect((await run(s)).outcome).toBe('authorized');
    const again = await run(s); // same proof, same challenge, same store
    expect(again.outcome).toBe('denied');
    expect(again.checks.challengeConsumption).toMatchObject({ status: 'failed', code: 'challenge_already_used' });
    expect(again.replayProtection).toBe('not_enforced');
    expect(storeCalls(s)).toBe(2);
  });

  it('a different challenge in the same store is not blocked', async () => {
    const store = simulatedStore();
    expect((await run(scenario({ challengeStore: store }))).outcome).toBe('authorized');
    expect((await run(scenario({ challengeStore: store }))).outcome).toBe('authorized');
    expect(store.calls).toHaveLength(2);
  });

  it('never consumes the challenge when any earlier check did not pass', async () => {
    const failing: Array<[string, Partial<EvaluateAuthorizationParams>]> = [
      ['no revocation list', { revocation: undefined }],
      ['wrong challenge', { challenge: generateChallenge() }],
      ['prohibited action', { context: prodDeploy({ actionType: 'rollback' }) }],
      ['unverified requester', { requester: { ...raj } }],
      ['missing proof', { proof: undefined }],
    ];
    for (const [name, over] of failing) {
      const s = scenario(over);
      const e = await run(s);
      expect(e.outcome, name).not.toBe('authorized');
      expect(e.checks.challengeConsumption, name).toMatchObject({ status: 'not_evaluated', code: 'not_attempted' });
      expect(storeCalls(s), name).toBe(0);
    }
  });
});

describe('no per-action approval', () => {
  it('approval material supplied by a caller is ignored: it neither blocks nor authorizes anything', async () => {
    const withExtra = { ...scenario(), approvals: ['anything', null, { approval: 'forged' }] } as unknown as EvaluateAuthorizationParams;
    const e = await run(withExtra);
    expect(e.outcome).toBe('authorized');
    const withoutGrant = { ...scenario({ requester: dev }), approvals: [{ approval: 'forged', grant: raj }] } as unknown as EvaluateAuthorizationParams;
    expect((await run(withoutGrant)).outcome).not.toBe('authorized');
  });

  it('a release engineer needs only the grant, but every other prerequisite still applies', async () => {
    expect((await run(scenario())).outcome).toBe('authorized');
    const lacking = await run(scenario({ revocation: undefined }));
    expect(lacking.outcome).toBe('incomplete');
    expect((await run(scenario({ challenge: generateChallenge() }))).outcome).toBe('denied');
  });
});

describe('combined behaviour', () => {
  it('each prerequisite failing on its own prevents authorization and is reported on its own check', async () => {
    const cases: Array<[keyof AuthorizationEvaluation['checks'], Partial<EvaluateAuthorizationParams>, 'failed' | 'incomplete']> = [
      ['policy', { context: prodDeploy({ actionType: 'rollback' }) }, 'failed'],
      ['requesterGrant', { requester: { ...raj } }, 'failed'],
      ['requesterRevocation', { revocation: list({ revokedGrantIds: ['grant-raj-001'] }) }, 'failed'],
      ['proofOfPossession', { challenge: generateChallenge() }, 'failed'],
    ];
    for (const [name, over, status] of cases) {
      const s = scenario(over);
      const e = await run(s);
      expect(e.checks[name].status, name).toBe(status);
      expect(e.outcome, name).toBe(status === 'failed' ? 'denied' : 'incomplete');
      expect(storeCalls(s), name).toBe(0);
    }
    const noStore = await run(scenario({ challengeStore: undefined }));
    expect(noStore.checks.challengeConsumption.status).toBe('incomplete');
    expect(noStore.outcome).toBe('incomplete');
    // roles and permissions
    const context = prodDeploy();
    const challenge = generateChallenge();
    const noRole = await run(scenario({ requester: dev, challenge, proof: createProof({ privateKey: devKey.privateKey, grant: dev, context, challenge, issuedAt: NOW }) }));
    expect(noRole.checks.roles.status).toBe('failed');
    const stagingCtx = prodDeploy({ environment: 'staging', actionId: 'act-stage-1' });
    const ch2 = generateChallenge();
    const noPerm = await run(scenario({ requester: rae, context: stagingCtx, challenge: ch2, proof: createProof({ privateKey: raeKey.privateKey, grant: rae, context: stagingCtx, challenge: ch2, issuedAt: NOW }) }));
    expect(noPerm.checks.permissions.status).toBe('failed');
    expect(noPerm.checks.roles.status).toBe('passed');
  });

  it('reports multiple simultaneous failures together, and a definitive failure outranks missing evidence', async () => {
    const s = scenario({ revocation: list({ revokedGrantIds: ['grant-raj-001'] }), challenge: generateChallenge() });
    const e = await run(s);
    expect(e.outcome).toBe('denied');
    expect(e.checks.requesterRevocation.status).toBe('failed');
    expect(e.checks.proofOfPossession.status).toBe('failed');
    expect(e.checks.policy.status).toBe('passed');
    expect(storeCalls(s)).toBe(0);
  });

  it('never throws on missing or malformed parameters, and never authorizes them', async () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    const inputs: unknown[] = [undefined, null, 5, 'x', [], {}, hostile];
    for (const [i, bad] of inputs.entries()) {
      const e = await evaluateAuthorization(bad as EvaluateAuthorizationParams);
      expect(e.outcome, `input ${i}`).not.toBe('authorized');
      expect(isAuthorizationEvaluation(e)).toBe(true);
    }
  });

  it('omitting any single parameter never produces authorization', async () => {
    for (const key of ['trustRoot', 'policy', 'requester', 'revocation', 'context', 'challenge', 'proof', 'challengeStore', 'now'] as const) {
      const s = scenario();
      const params: Record<string, unknown> = { ...s };
      delete params[key];
      const e = await evaluateAuthorization(params as unknown as EvaluateAuthorizationParams);
      expect(e.outcome, key).not.toBe('authorized');
    }
  });

  it('survives hostile values inside otherwise valid parameters', async () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    for (const key of ['trustRoot', 'policy', 'requester', 'revocation', 'context', 'challenge', 'proof', 'challengeStore', 'now'] as const) {
      const e = await evaluateAuthorization({ ...scenario(), [key]: hostile } as unknown as EvaluateAuthorizationParams);
      expect(e.outcome, key).not.toBe('authorized');
    }
  });

  it('cannot be fooled by fabricated success objects, and a fabricated evaluation is not recognised', async () => {
    const fake = { ...scenario(), trustRoot: { verified: true }, policy: { verified: true }, requester: { verified: true, ok: true }, revocation: { ok: true, status: 'not_listed' } } as never;
    const e = await run(fake);
    expect(e.outcome).toBe('denied');
    expect(isAuthorizationEvaluation({ outcome: 'authorized', checks: {}, executionPerformed: false })).toBe(false);
    expect(isAuthorizationEvaluation({ ...e })).toBe(false);
    expect(isAuthorizationEvaluation(null)).toBe(false);
  });

  it('never leaks the challenge, digest, target, commit, signatures or keys', async () => {
    const scenarios = [scenario(), scenario({ challenge: generateChallenge() }), scenario({ revocation: undefined }), scenario({ challengeStore: undefined })];
    for (const s of scenarios) {
      const text = JSON.stringify(await run(s));
      const proof = s.proof as { signature: string; payload: string };
      for (const secret of [s.challenge, s.context.contentDigest, 'payments-service', COMMIT, proof.signature, proof.payload, raw(rajKey), String(rajKey.privateKey.export({ format: 'jwk' }).d)]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('is deterministic: the same inputs give the same outcome and reason codes', async () => {
    const make = (): Scenario => {
      const s = scenario({ revocation: undefined });
      return s;
    };
    const a = make();
    const b = { ...a, challengeStore: simulatedStore() };
    expect(codes(await run(a))).toEqual(codes(await run(b)));
    const ok1 = scenario();
    const ok2 = { ...ok1, challengeStore: simulatedStore() };
    expect(codes(await run(ok1))).toEqual(codes(await run(ok2)));
  });

  it('invariant: `authorized` only ever appears with every mandatory check satisfied and the challenge consumed', async () => {
    const variants: Array<Partial<EvaluateAuthorizationParams>> = [
      {}, { revocation: undefined }, { challengeStore: undefined }, { proof: undefined }, { challenge: generateChallenge() },
      { requester: { ...raj } }, { context: prodDeploy({ actionType: 'rollback' }) }, { revocation: list({ revokedGrantIds: ['grant-raj-001'] }) },
      { policy: verifiedPolicy(6) }, { now: new Date('2026-12-05T00:00:00Z') },
    ];
    for (const over of variants) {
      const s = scenario(over);
      const e = await run(s);
      if (e.outcome === 'authorized') {
        for (const c of Object.values(e.checks)) expect(['passed', 'not_required']).toContain(c.status);
        expect(e.checks.challengeConsumption.status).toBe('passed');
        expect(e.replayProtection).toBe('consumed');
        expect(storeCalls(s)).toBe(1);
      } else {
        expect(Object.values(e.checks).some((c) => c.status !== 'passed' && c.status !== 'not_required')).toBe(true);
      }
    }
    expect((await run(scenario())).outcome).toBe('authorized');
  });

  it('does not execute anything: the result says so, parameters carry no callbacks, and the source has no execution or I/O imports', async () => {
    const e = await run(scenario());
    expect(e.executionPerformed).toBe(false);
    const source = readFileSync(new URL('../../../../src/features/action-safety/authorization/evaluateAuthorization.ts', import.meta.url), 'utf-8');
    for (const forbidden of ['child_process', 'node:fs', "from 'fs'", 'process.env', 'fetch(', 'node:http', 'node:net', 'simple-git', 'Math.random', 'new Map(', 'new Set(']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
