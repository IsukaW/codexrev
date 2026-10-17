// Tests for the strict authorization evidence adapter. In-memory Ed25519 keys only; offline and deterministic.
// The existing Authority assessor and gate engine are used for real: nothing about them is mocked.
//
// IMPORTANT: `simulatedStore` is a TEST DOUBLE modelling atomic single use inside one process. It is NOT
// durable, NOT protected, and gives NO real replay protection.

import { readFileSync } from 'node:fs';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { URL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { assessAuthority, DEFAULT_AUTHORITY_CONFIG } from '../../../../src/features/action-safety/calculus/authority.js';
import { constrainDecision, evaluateGates } from '../../../../src/features/action-safety/calculus/gates.js';
import { UNIDENTIFIED_ACTOR } from '../../../../src/features/action-safety/collectors/evidenceAdapters.js';
import type { EvidenceSnapshot, ProposedAction } from '../../../../src/features/action-safety/model/types.js';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { evaluateAuthorization, type EvaluateAuthorizationParams } from '../../../../src/features/action-safety/authorization/evaluateAuthorization.js';
import { verifyGrant, type VerifiedGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy, type PolicyDocument } from '../../../../src/features/action-safety/authorization/policy.js';
import { computeContentDigest, createProof, generateChallenge, type ActionContext, type ChallengeStore } from '../../../../src/features/action-safety/authorization/proof.js';
import { verifyRevocationList, type RevocationListResult } from '../../../../src/features/action-safety/authorization/revocation.js';
import {
  UNVERIFIED_ACTOR,
  adaptAuthorization,
  completeStrictGatePolicy,
  isStrictAuthorizationView,
  type BlockedStrictAuthorization,
  type FinalizedStrictAuthorization,
  type OtherGateRules,
  type ProvisionalStrictAuthorization,
  type StrictAuthorizationView,
} from '../../../../src/features/action-safety/authorization/strictAuthorityAdapter.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import {
  attestSafetyDecision,
  authorizationSubjectOf,
  finalizeAuthorization,
  prepareAuthorization,
  type FinalizedAuthorization,
  type PreparedAuthorization,
} from '../../../../src/features/action-safety/authorization/twoPhaseAuthorization.js';

const T0 = new Date('2026-06-01T12:00:00Z');
const at = (from: Date, seconds: number): Date => new Date(from.getTime() + seconds * 1000);
type Keys = { publicKey: KeyObject; privateKey: KeyObject };
const pair = (): Keys => generateKeyPairSync('ed25519');
const raw = (k: Keys): string => exportRawPublicKey(k.publicKey).toString('base64url');
const id = (k: Keys): string => deriveKeyId(k.publicKey);
const entry = (k: Keys, purposes: string[]): Record<string, unknown> => ({ keyId: id(k), publicKey: raw(k), purposes, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' });

const policyDoc = (): Record<string, unknown> => ({
  version: 2,
  organization: 'acme',
  policyId: 'acme-policy',
  revision: 5,
  issuedAt: '2026-05-01T00:00:00Z',
  effectiveAt: '2026-05-01T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z',
  permissions: ['code.change', 'deploy.production', 'db.migrate'],
  roles: [
    { name: 'developer', permissions: ['code.change'] },
    { name: 'release_engineer', permissions: ['code.change', 'deploy.production'] },
    { name: 'dba', permissions: ['db.migrate'] },
    { name: 'tech_lead', permissions: [] },
    { name: 'security_reviewer', permissions: [] },
  ],
  rules: [
    { action: 'code_change', environment: 'development', allowedRoles: ['developer', 'release_engineer'], requiredPermissions: ['code.change'] },
    { action: 'deployment', environment: 'production', allowedRoles: ['release_engineer'], requiredPermissions: ['deploy.production'] },
    { action: 'database_migration', environment: 'production', allowedRoles: ['dba'], requiredPermissions: ['db.migrate'] },
  ],
});

const signRaw = (doc: unknown, key: Keys, domain: 'proof' | 'grant' | 'policy' | 'revocation') => signEnvelope({ domain, payload: Buffer.from(JSON.stringify(doc)), privateKey: key.privateKey });

let policyKey: Keys;
let grantKey: Keys;
let revocationKey: Keys;
let rajKey: Keys;
let aliceKey: Keys;
let danaKey: Keys;
let root: TrustRoot;
let policy: PolicyDocument;
let raj: VerifiedGrant;
let alice: VerifiedGrant;
let dana: VerifiedGrant;

const issueGrant = (who: Keys, grantId: string, subjectId: string, roles: string[], type: 'human' | 'service' = 'human'): VerifiedGrant => {
  const g = verifyGrant(
    signRaw(
      { version: 1, grantId, organization: 'acme', subject: { id: subjectId, type, publicKey: raw(who), keyId: id(who) }, roles, permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1 },
      grantKey,
      'grant',
    ),
    root,
    policy,
    T0,
  );
  if (!g.ok) throw new Error(`setup grant ${grantId}: ${g.code}`);
  return g;
};

beforeAll(() => {
  [policyKey, grantKey, revocationKey, rajKey, aliceKey, danaKey] = Array.from({ length: 6 }, pair) as Keys[];
  const r = parseTrustRoot({ version: 1, organization: 'acme', createdAt: '2026-01-01T00:00:00Z', keys: [entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])] });
  if (!r.ok) throw new Error('setup trust root');
  root = r.trustRoot;
  const p = verifyPolicy(signRaw(policyDoc(), policyKey, 'policy'), root, T0);
  if (!p.ok) throw new Error(`setup policy: ${p.code}`);
  policy = p.policy;
  raj = issueGrant(rajKey, 'grant-raj-001', 'raj', ['release_engineer']);
  alice = issueGrant(aliceKey, 'grant-alice-001', 'alice', ['developer']);
  dana = issueGrant(danaKey, 'grant-dana-001', 'dana', ['dba']);
});

// ---------------------------------------------------------------- builders

const COMMIT = 'b'.repeat(40);
const prodDeploy = (): ActionContext => ({ actionId: 'act-deploy-1', actionType: 'deployment', environment: 'production', target: 'payments-service', commit: COMMIT, contentDigest: computeContentDigest(Buffer.from('{"deploy":"payments-service"}')) });
const devChange = (): ActionContext => ({ actionId: 'act-dev-1', actionType: 'code_change', environment: 'development', target: 'payments-service', commit: 'a'.repeat(40), contentDigest: computeContentDigest(Buffer.from('diff')) });
const migration = (): ActionContext => ({ ...prodDeploy(), actionId: 'act-migrate-1', actionType: 'database_migration', target: 'payments-db', contentDigest: computeContentDigest(Buffer.from('ALTER TABLE t ADD c int;')) });

const simulatedStore = (): ChallengeStore & { calls: unknown[] } => {
  const used = new Set<string>();
  const calls: unknown[] = [];
  return {
    calls,
    async consume(e) {
      calls.push(e);
      if (used.has(e.challenge)) return 'already_used';
      used.add(e.challenge);
      return 'consumed';
    },
  };
};



const list = (over: Record<string, unknown> = {}): RevocationListResult =>
  verifyRevocationList(
    signRaw({ version: 1, organization: 'acme', listVersion: 3, issuedAt: '2026-06-01T00:00:00Z', nextUpdate: '2026-06-05T00:00:00Z', revokedGrantIds: [], revokedSubjectKeyIds: [], revokedIssuerKeyIds: [], ...over }, revocationKey, 'revocation'),
    root,
    T0,
  );

type Built = EvaluateAuthorizationParams & { challengeStore: ReturnType<typeof simulatedStore> };

const params = (over: Partial<EvaluateAuthorizationParams> = {}): Built => {
  const context = prodDeploy();
  const challenge = generateChallenge();
  return {
    trustRoot: root,
    policy,
    requester: raj,
    revocation: list(),
    context,
    challenge,
    proof: createProof({ privateKey: rajKey.privateKey, grant: raj, context, challenge, issuedAt: T0 }),
    challengeStore: simulatedStore(),
    now: T0,
    ...over,
  } as Built;
};

const devParams = (): Built => {
  const context = devChange();
  const challenge = generateChallenge();
  return params({ requester: alice, context, challenge, proof: createProof({ privateKey: aliceKey.privateKey, grant: alice, context, challenge, issuedAt: T0 }) });
};

const migrationParams = (): Built => {
  const context = migration();
  const challenge = generateChallenge();
  return params({
    requester: dana,
    context,
    challenge,
    proof: createProof({ privateKey: danaKey.privateKey, grant: dana, context, challenge, issuedAt: T0 }),
  });
};

const prepared = (p: Built): PreparedAuthorization => prepareAuthorization(p);
// `store` is null for "no store": an `undefined` argument would silently fall back to the default
const finalized = async (p: Built, decision: 'ALLOW' | 'BLOCK' = 'ALLOW', store: ChallengeStore | null = p.challengeStore): Promise<FinalizedAuthorization> => {
  const prep = prepared(p);
  return finalizeAuthorization({ prepared: prep, safetyDecision: attestSafetyDecision(prep, decision, p.context), context: p.context, challenge: p.challenge, ...(store ? { challengeStore: store } : {}), now: at(T0, 120) });
};

const NOW = at(T0, 180);
const adapt = (r: unknown, now: Date = NOW): StrictAuthorizationView => adaptAuthorization(r as PreparedAuthorization, now);
const finalView = async (p: Built): Promise<FinalizedStrictAuthorization> => {
  const v = adapt(await finalized(p));
  if (v.state !== 'finalized') throw new Error(`setup: expected finalized, got ${v.state}`);
  return v;
};
const provisionalView = (p: Built): ProvisionalStrictAuthorization => {
  const v = adapt(prepared(p));
  if (v.state !== 'provisional') throw new Error(`setup: expected provisional, got ${v.state}`);
  return v;
};

const action: ProposedAction = { identity: { id: 'a', type: 'deployment', description: 'd' }, environment: 'production', impact: 'high', irreversible: false };
const passEvidence: EvidenceSnapshot = {
  buildTests: { status: 'PASS', source: 'automated_tool', observedAt: T0.toISOString() },
  supporting: { status: 'PASS', source: 'automated_tool', observedAt: T0.toISOString() },
  recovery: { status: 'PASS', source: 'automated_tool', observedAt: T0.toISOString() },
};
const others: OtherGateRules = {
  recovery: { required: true, whenIrreversible: true, minImpact: 'medium' },
  buildTests: { required: true },
  supportingEvidence: { required: true },
};

function gates(view: StrictAuthorizationView, evidence: EvidenceSnapshot = passEvidence) {
  const complete = completeStrictGatePolicy(view, others);
  if (!complete.ok) throw new Error(`setup gate policy: ${complete.code}`);
  const authority = view.state === 'provisional' ? view.provisionalGateInputs : view.gateInputs;
  return evaluateGates({ action, authority, evidence, policy: complete.policy });
}
const gate = (e: ReturnType<typeof gates>, id: string) => e.results.find((r) => r.gate === id);

// ================================================================ genuine results and states

describe('genuine two-phase results', () => {
  it('a genuine authorized finalization becomes a finalized view with the challenge consumed', async () => {
    const view = await finalView(params());
    expect(view).toMatchObject({
      state: 'finalized',
      challengeConsumption: 'consumed',
      authorizationFinalized: true,
      authorizationPermitsFinalAllow: true,
      executionPerformed: false,
      reasonCodes: ['AUTHORIZATION_FINALIZED'],
    });
    expect('provisionalGateInputs' in view).toBe(false);
    expect(view.requirements).toMatchObject({ requiredRoles: ['release_engineer'], requiredPermissions: ['deploy.production'] });
    expect(view.gatePolicy).toEqual({ authorization: { required: true } });
    expect(isStrictAuthorizationView(view)).toBe(true);
    expect(isStrictAuthorizationView({ ...view })).toBe(false);
    expect(Object.isFrozen(view)).toBe(true);
  });

  it('a genuine ready-for-finalization result becomes a PROVISIONAL view, never a finalized one', () => {
    const view = provisionalView(params());
    expect(view).toMatchObject({
      state: 'provisional',
      challengeConsumption: 'pending',
      authorizationFinalized: false,
      authorizationPermitsFinalAllow: false,
      nextStep: 'finalizeAuthorization',
      reasonCodes: ['AUTHORIZATION_PROVISIONAL_PENDING_FINALIZATION'],
    });
    // the provisional gate view has a different name, so it cannot be consumed as a finalized one by accident
    expect('gateInputs' in view).toBe(false);
    expect(view.provisionalGateInputs.authorization).toMatchObject({ status: 'PASS', source: 'verified_system' });
  });

  it('the two states have different shapes: a provisional view cannot be turned finalized by changing a flag', () => {
    const view = provisionalView(params());
    const tampered = { ...view, authorizationFinalized: true, state: 'finalized', authorizationPermitsFinalAllow: true } as unknown as StrictAuthorizationView;
    expect(isStrictAuthorizationView(tampered)).toBe(false); // not produced by the adapter
    expect('gateInputs' in tampered).toBe(false); // and it still has no finalized gate view
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => { (view as { state: string }).state = 'finalized'; }).toThrow();
  });

  it('a denied preparation is blocked, with the Authorization gate FAIL', () => {
    const view = adapt(prepared(params({ revocation: list({ revokedGrantIds: ['grant-raj-001'] }) })));
    expect(view).toMatchObject({ state: 'blocked', consequence: 'BLOCK', reasonCodes: ['AUTHORIZATION_DENIED'], authorizationPermitsFinalAllow: false, challengeConsumption: 'not_consumed' });
    const b = view as BlockedStrictAuthorization;
    expect(b.gateInputs.authorization?.status).toBe('FAIL');
    expect(b.unmetChecks).toEqual([
      { check: 'requesterRevocation', status: 'failed', code: 'grant_revoked' },
      { check: 'challengeConsumption', status: 'not_evaluated', code: 'not_attempted' },
    ]);
  });

  it('an incomplete preparation is blocked, with the Authorization gate UNKNOWN', () => {
    const view = adapt(prepared(params({ revocation: undefined }))) as BlockedStrictAuthorization;
    expect(view).toMatchObject({ state: 'blocked', consequence: 'BLOCK', reasonCodes: ['AUTHORIZATION_INCOMPLETE'] });
    expect(view.gateInputs.authorization?.status).toBe('UNKNOWN');
    expect(view.unmetChecks.map((u) => u.check)).toContain('requesterRevocation');
  });

  it('a finalization that was not authorized is blocked, whatever the reason', async () => {
    const denied = adapt(await finalized(params(), 'BLOCK'));
    expect(denied).toMatchObject({ state: 'blocked', reasonCodes: ['AUTHORIZATION_DENIED'] });
    const noStore = adapt(await finalized(params(), 'ALLOW', null));
    expect(noStore).toMatchObject({ state: 'blocked', reasonCodes: ['AUTHORIZATION_INCOMPLETE'] });
    const used = params();
    const first = prepared(used);
    const second = prepared(used);
    for (const prep of [first, second]) {
      await finalizeAuthorization({ prepared: prep, safetyDecision: attestSafetyDecision(prep, 'ALLOW', used.context), context: used.context, challenge: used.challenge, challengeStore: used.challengeStore, now: at(T0, 60) });
    }
    const replay = await finalizeAuthorization({ prepared: second, safetyDecision: attestSafetyDecision(second, 'ALLOW', used.context), context: used.context, challenge: used.challenge, challengeStore: used.challengeStore, now: at(T0, 60) });
    expect(adapt(replay).state).toBe('blocked');
  });

  it('a blocked result never carries positive evidence or full authorization', async () => {
    const results = [prepared(params({ proof: undefined })), prepared(params({ revocation: undefined })), await finalized(params(), 'BLOCK')];
    for (const r of results) {
      const v = adapt(r) as BlockedStrictAuthorization;
      expect(v.state).toBe('blocked');
      expect(v.authorityInput.identityVerification).toBeUndefined();
      expect(v.authorityInput.granted).toBeUndefined();
      expect(v.authorityInput).not.toHaveProperty('approvals');
      expect(v.authorityInput.actor).toEqual(UNVERIFIED_ACTOR);
      expect(v.gateInputs.authorization?.status).not.toBe('PASS');
      expect(v.gateInputs).not.toHaveProperty('humanApproval');
      expect(v.authorizationPermitsFinalAllow).toBe(false);
    }
  });

  it('is deterministic and does not read the clock: the same inputs give the same view', async () => {
    const f = await finalized(params());
    expect(adapt(f)).toEqual(adapt(f));
    expect(adapt(f).state).toBe('finalized');
  });
});

describe('forged, cloned and unrecognized results', () => {
  it('rejects fabricated success objects and anything that is not a genuine result', async () => {
    const real = await finalized(params());
    const prep = prepared(params());
    const forgeries: unknown[] = [
      { outcome: 'authorized' },
      { outcome: 'authorized', checks: real.checks, replayProtection: 'consumed', executionPerformed: false },
      { ...real },
      { ...prep },
      JSON.parse(JSON.stringify(real)),
      JSON.parse(JSON.stringify(prep)),
      Object.create(real),
      Object.create(prep),
      { outcome: 'ready_for_finalization', checks: prep.checks },
      { state: 'finalized', authorizationFinalized: true },
      null,
      undefined,
      5,
      'authorized',
      true,
      [],
      {},
    ];
    for (const [i, forged] of forgeries.entries()) {
      const v = adapt(forged);
      expect(v.state, `forgery ${i}`).toBe('blocked');
      expect(v.reasonCodes).toEqual(['AUTHORIZATION_RESULT_UNRECOGNIZED']);
      const b = v as BlockedStrictAuthorization;
      expect(b.gateInputs.authorization).toMatchObject({ status: 'FAIL' });
      expect(b.gateInputs.authorization?.source).toBeUndefined(); // an unrecognized object earns no provenance
      expect(b.authorityInput.identityVerification).toBeUndefined();
      expect(b.unmetChecks).toEqual([]);
    }
  });

  it('does not accept the one-shot evaluateAuthorization result: only the two-phase results are recognized', async () => {
    const p = params();
    const oneShot = await evaluateAuthorization({ ...p, challengeStore: simulatedStore() });
    expect(oneShot.outcome).toBe('authorized');
    expect(adapt(oneShot).state).toBe('blocked');
  });

  it('survives hostile objects and an invalid assessment time', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    expect(adapt(hostile).state).toBe('blocked');
    const prep = prepared(params());
    for (const now of [new Date('x'), '2026-06-01' as unknown as Date, null as unknown as Date, undefined as unknown as Date]) {
      const v = adaptAuthorization(prep, now); // called directly: the adapt() helper would replace undefined with its default
      expect(v.state).toBe('blocked');
      expect(v.reasonCodes).toEqual(['INVALID_EVALUATION_TIME']);
    }
  });

  it('a genuine result with a tampered check is not trusted', async () => {
    const real = await finalized(params());
    const forged = { ...real, checks: { ...real.checks, challengeConsumption: { ...real.checks.challengeConsumption, status: 'passed' } } };
    expect(adapt(forged).state).toBe('blocked');
  });
});

// ================================================================ Authority

describe('Authority input from verified facts', () => {
  it('builds identity, roles, permissions and requirements from the grant and the verified policy', async () => {
    const v = await finalView(params());
    const a = v.authorityInput;
    expect(a.now).toBe(NOW.toISOString());
    expect(a.actor).toEqual({ id: 'raj', kind: 'human', roles: ['release_engineer'] });
    expect(a.identityVerification).toMatchObject({ status: 'PASS', source: 'verified_system', observedAt: '2026-06-01T12:02:00.000Z' });
    expect(a.identityVerification?.refs).toContain('grant:grant-raj-001');
    expect(a.identityVerification?.refs).toContain('policy:acme-policy@5');
    expect(a.requiredRoles).toEqual(['release_engineer']);
    expect(a.requiredPermissions).toEqual(['deploy.production']);
    expect(a.granted?.permissions).toEqual(['code.change', 'deploy.production']);
    expect(a.granted?.evidence).toMatchObject({ status: 'PASS', source: 'verified_system' });
    expect(a).not.toHaveProperty('requiredApprovals');
    expect(a).not.toHaveProperty('approvals');
  });

  it('a service subject is a service actor', async () => {
    const svcKey = pair();
    const svc = issueGrant(svcKey, 'grant-svc-001', 'svc-ci', ['release_engineer'], 'service');
    const context = prodDeploy();
    const challenge = generateChallenge();
    const p = params({ requester: svc, challenge, proof: createProof({ privateKey: svcKey.privateKey, grant: svc, context, challenge, issuedAt: T0 }) });
    const a = (await finalView(p)).authorityInput;
    expect(a.actor).toEqual({ id: 'svc-ci', kind: 'service', roles: ['release_engineer'] });
    expect(assessAuthority(a).score).toBe(1);
  });

  it('lists the required role the requester actually holds, because the formula counts roles as "all of"', async () => {
    const p = devParams(); // policy allows developer OR release_engineer; alice is a developer
    const a = (await finalView(p)).authorityInput;
    expect(a.requiredRoles).toEqual(['developer']);
    expect(assessAuthority(a).score).toBe(1);
  });

  it('has no approval input at all: authority comes from the signed grant and the policy only', async () => {
    for (const make of [() => params(), () => devParams(), () => migrationParams()]) {
      const a = (await finalView(make())).authorityInput;
      expect('requiredApprovals' in a).toBe(false);
      expect('approvals' in a).toBe(false);
    }
  });

  it('feeds the EXISTING Authority assessor unchanged: full verified authority scores 1', async () => {
    for (const make of [() => params(), () => devParams(), () => migrationParams()]) {
      const r = assessAuthority((await finalView(make())).authorityInput);
      expect(r.score).toBe(1);
      expect(r.missing).toEqual([]);
      expect(r.uncertain).toEqual([]);
      expect(r.breakdown.map((c) => c.weight)).toEqual([DEFAULT_AUTHORITY_CONFIG.weights.identity, DEFAULT_AUTHORITY_CONFIG.weights.roles, DEFAULT_AUTHORITY_CONFIG.weights.permissions]);
    }
  });

  it('a provisional view feeds the assessor the same verified evidence', () => {
    expect(assessAuthority(provisionalView(params()).authorityInput).score).toBe(1);
  });

  it('verified provenance earns more than any self-declared claim could (claims cap at human_attested = 0.7)', async () => {
    const verifiedInput = (await finalView(params())).authorityInput;
    const claimed = {
      ...verifiedInput,
      identityVerification: { ...verifiedInput.identityVerification!, source: 'human_attested' as const },
      granted: { permissions: verifiedInput.granted!.permissions, evidence: { ...verifiedInput.granted!.evidence!, source: 'human_attested' as const } },
    };
    expect(assessAuthority(verifiedInput).score).toBe(1);
    expect(assessAuthority(claimed).score).toBeLessThan(1);
    expect(assessAuthority(claimed).score).toBeCloseTo(0.7, 2);
  });

  it('old verified evidence is stale and earns less (freshness still applies)', async () => {
    const v = await finalView(params());
    const later = { ...v.authorityInput, now: new Date(NOW.getTime() + 800 * 3600_000).toISOString() };
    expect(assessAuthority(later).score).toBeLessThan(1);
  });

  it('gives no positive credit for failed or incomplete authorization', () => {
    const blockedViews = [prepared(params({ revocation: undefined })), prepared(params({ revocation: list({ revokedGrantIds: ['grant-raj-001'] }) })), prepared(params({ proof: undefined }))].map((r) => adapt(r) as BlockedStrictAuthorization);
    for (const v of blockedViews) {
      const r = assessAuthority(v.authorityInput);
      expect(r.score).toBeLessThanOrEqual(0.3); // identity is not verified: the existing cap applies
      expect(v.authorityInput.identityVerification).toBeUndefined();
    }
    expect(assessAuthority(blockedViews[0]!.authorityInput).score).toBe(0);
  });

  it('carries no developer-supplied claim: the adapter has no parameter for one', () => {
    expect(adaptAuthorization.length).toBe(2);
    const view = provisionalView(params());
    expect(view.authorityInput.actor.roles).toEqual(['release_engineer']);
  });
});

// ================================================================ gates

describe('mapping to the four gates', () => {
  it('the Authorization gate is always required, in every state', async () => {
    const views = [await finalView(params()), provisionalView(params()), adapt(prepared(params({ revocation: undefined }))), adapt(null), await finalView(devParams())];
    for (const v of views) expect(v.gatePolicy.authorization).toEqual({ required: true });
  });

  it('a verified, finalized authorization passes the Authorization gate and leaves no consequence', async () => {
    const v = await finalView(params());
    expect(v.gatePolicy).toEqual({ authorization: { required: true } });
    const e = gates(v);
    expect(gate(e, 'AUTHORIZATION')).toMatchObject({ status: 'PASS', consequence: 'BLOCK' });
    expect(e.consequence).toBeNull();
  });

  it('the same mapping holds for a developer change and a dba migration: no gate depends on any approval', async () => {
    for (const make of [() => devParams(), () => migrationParams()]) {
      const v = await finalView(make());
      expect(v.gatePolicy).toEqual({ authorization: { required: true } });
      expect(v.gateInputs).not.toHaveProperty('humanApproval');
      expect(gate(gates(v), 'AUTHORIZATION')?.status).toBe('PASS');
    }
  });

  it('denied maps to Authorization FAIL and BLOCK, and a would-be ALLOW is forced to BLOCK', () => {
    const v = adapt(prepared(params({ revocation: list({ revokedGrantIds: ['grant-raj-001'] }) })));
    const e = gates(v);
    expect(gate(e, 'AUTHORIZATION')).toMatchObject({ status: 'FAIL', consequence: 'BLOCK' });
    expect(e.consequence).toBe('BLOCK');
    expect(constrainDecision('ALLOW', e)).toBe('BLOCK');
  });

  it('incomplete maps to Authorization UNKNOWN and BLOCK', () => {
    const v = adapt(prepared(params({ revocation: undefined })));
    const e = gates(v);
    expect(gate(e, 'AUTHORIZATION')).toMatchObject({ status: 'UNKNOWN', consequence: 'BLOCK' });
    expect(constrainDecision('ALLOW', e)).toBe('BLOCK');
  });

  it('a provisional view never represents a completed ALLOW: it has no finalized gate view and forbids a final ALLOW', () => {
    const v = provisionalView(params());
    expect(v.authorizationPermitsFinalAllow).toBe(false);
    expect(v.authorizationFinalized).toBe(false);
    expect('gateInputs' in v).toBe(false);
    // the provisional gate view exists for a provisional safety calculation only
    expect(gate(gates(v), 'AUTHORIZATION')?.status).toBe('PASS');
    expect(v.limitations.join(' ')).toMatch(/attestation|single use/);
  });

  it('there is no Human Approval gate: an unrecognized object is blocked and has no approval rule either', () => {
    const v = adapt({ outcome: 'authorized', requirements: { requiredRoles: [], requiredPermissions: [] } });
    expect(v.state).toBe('blocked');
    expect(v.gatePolicy).toEqual({ authorization: { required: true } });
    expect(gate(gates(v), 'HUMAN_APPROVAL')).toBeUndefined();
  });

  it('other mandatory gates stay active: finalized authorization does not bypass them', async () => {
    const v = await finalView(params());
    const missingBuild = gates(v, { supporting: passEvidence.supporting!, recovery: passEvidence.recovery! });
    expect(gate(missingBuild, 'AUTHORIZATION')?.status).toBe('PASS');
    expect(gate(missingBuild, 'BUILD_TEST_RESULTS')?.status).toBe('UNKNOWN');
    expect(constrainDecision('ALLOW', missingBuild)).toBe('BLOCK');
    const noRecovery = gates(v, { buildTests: passEvidence.buildTests!, supporting: passEvidence.supporting! });
    expect(gate(noRecovery, 'VERIFIED_RECOVERY')?.status).toBe('FAIL');
  });

  it('a high Authority score does not bypass a mandatory gate', async () => {
    const v = await finalView(params());
    expect(assessAuthority(v.authorityInput).score).toBe(1);
    expect(constrainDecision('ALLOW', gates(v, {}))).toBe('BLOCK');
  });

  it('uses exactly four gates: Authorization, Recovery, Build/Test and Supporting Evidence', async () => {
    const e = gates(await finalView(params()));
    expect(e.results.map((r) => r.gate).sort()).toEqual(['AUTHORIZATION', 'BUILD_TEST_RESULTS', 'SUPPORTING_EVIDENCE', 'VERIFIED_RECOVERY']);
  });
});

describe('completing the gate policy needs a trusted source for the other gates', () => {
  it('combines the strict rules with supplied rules and defaults nothing', async () => {
    const v = await finalView(params());
    const r = completeStrictGatePolicy(v, others);
    expect(r).toEqual({
      ok: true,
      policy: {
        authorization: { required: true },
        recovery: { required: true, whenIrreversible: true, minImpact: 'medium' },
        buildTests: { required: true },
        supportingEvidence: { required: true },
      },
    });
  });

  it('refuses a policy that is incomplete or malformed rather than inventing defaults', async () => {
    const v = await finalView(params());
    const bad: unknown[] = [
      {},
      { recovery: others.recovery, buildTests: others.buildTests },
      { ...others, recovery: { required: 'yes', whenIrreversible: true } },
      { ...others, recovery: { required: true } },
      { ...others, recovery: { required: true, whenIrreversible: true, minImpact: 'enormous' } },
      { ...others, buildTests: null },
      { ...others, supportingEvidence: { required: true, consequence: 'ALLOW' } },
      null,
      undefined,
      5,
      'policy',
      [],
    ];
    for (const o of bad) expect(completeStrictGatePolicy(v, o as OtherGateRules), JSON.stringify(o)).toEqual({ ok: false, code: 'incomplete_gate_rules' });
  });

  it('refuses any developer-supplied authorization rule, including a disabled gate policy', async () => {
    const v = await finalView(params());
    for (const extra of [{ authorization: { required: false } }, { authorization: { required: true } }]) {
      expect(completeStrictGatePolicy(v, { ...others, ...extra } as unknown as OtherGateRules)).toEqual({ ok: false, code: 'authorization_rules_not_accepted' });
    }
  });

  it('a removed approval rule supplied by a caller is not carried into the policy', async () => {
    const v = await finalView(params());
    const r = completeStrictGatePolicy(v, { ...others, humanApproval: { required: false } } as unknown as OtherGateRules);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.policy).sort()).toEqual(['authorization', 'buildTests', 'recovery', 'supportingEvidence']);
  });

  it('only completes the policy for a genuine view', async () => {
    const v = await finalView(params());
    for (const fake of [{ ...v }, { gatePolicy: { authorization: { required: false } } }, null, undefined, 'view']) {
      expect(completeStrictGatePolicy(fake as unknown as StrictAuthorizationView, others)).toEqual({ ok: false, code: 'not_a_strict_view' });
    }
  });

  it('never throws on hostile rules', async () => {
    const v = await finalView(params());
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); }, has: () => { throw new Error('boom'); } });
    expect(completeStrictGatePolicy(v, hostile as unknown as OtherGateRules).ok).toBe(false);
  });

  it('states the limitation plainly in every view', async () => {
    for (const v of [await finalView(params()), provisionalView(params()), adapt(null)]) {
      expect(v.limitations.join(' ')).toMatch(/recovery, build\/test and supporting-evidence gates need a trusted policy source/);
      expect(v.limitations.join(' ')).toMatch(/unauthenticated in-process/);
      expect(v.limitations.join(' ')).toMatch(/challenge store/);
    }
  });
});

// ================================================================ privilege confusion, leakage, scope

describe('privilege confusion and safety properties', () => {
  it('a valid grant alone, a valid proof alone, or a prepared result alone is never finalized authorization', () => {
    const p = params();
    const prep = prepared(p);
    expect(adapt(prep).state).toBe('provisional');
    for (const missing of [{ proof: undefined }, { revocation: undefined }, { challengeStore: undefined }] as Array<Partial<EvaluateAuthorizationParams>>) {
      expect(adapt(prepared(params(missing))).state, JSON.stringify(Object.keys(missing))).toBe('blocked');
    }
  });

  it('only a finalized view can say authorization permits a final ALLOW', async () => {
    const all = [await finalView(params()), provisionalView(params()), adapt(prepared(params({ revocation: undefined }))), adapt(undefined)];
    expect(all.map((v) => [v.state, v.authorizationPermitsFinalAllow])).toEqual([
      ['finalized', true],
      ['provisional', false],
      ['blocked', false],
      ['blocked', false],
    ]);
  });

  it('reads only branded facts: the subject accessor refuses copies and non-ready results', async () => {
    const f = await finalized(params());
    expect(authorizationSubjectOf(f)?.requester.grant.subject.id).toBe('raj');
    expect(authorizationSubjectOf({ ...f })).toBeUndefined();
    expect(authorizationSubjectOf(prepared(params({ revocation: undefined })))).toBeUndefined();
    expect(authorizationSubjectOf(null)).toBeUndefined();
  });

  it('never leaks the challenge, digest, target, commit, signatures, payloads or keys', async () => {
    const p = params();
    const f = await finalized(p);
    const proof = p.proof as { signature: string; payload: string };
    const views = [adapt(f), adapt(prepared(params())), adapt(prepared(params({ revocation: undefined }))), adapt(null)];
    for (const v of views) {
      const text = JSON.stringify(v);
      for (const secret of [p.challenge, p.context.contentDigest, 'payments-service', COMMIT, proof.signature, proof.payload, raw(rajKey), String(rajKey.privateKey.export({ format: 'jwk' }).d)]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('uses the same unidentified actor as the existing collectors', () => {
    expect(UNVERIFIED_ACTOR).toEqual(UNIDENTIFIED_ACTOR);
  });

  it('is not wired in: it imports no pipeline, CLI or collector code, and touches no filesystem, Git, network or environment', () => {
    const full = readFileSync(new URL('../../../../src/features/action-safety/authorization/strictAuthorityAdapter.ts', import.meta.url), 'utf-8');
    const source = full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../calculus/authority.js', '../calculus/gates.js', '../model/types.js', './evaluateAuthorization.js', './grant.js', './twoPhaseAuthorization.js']);
    for (const forbidden of ['child_process', 'node:fs', 'process.env', 'process.cwd', 'fetch(', 'node:http', 'simple-git', 'Math.random', 'Date.now', 'new Date()']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
