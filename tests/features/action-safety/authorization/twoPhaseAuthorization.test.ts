// Tests for two-phase authorization: prepareAuthorization, attestSafetyDecision, finalizeAuthorization.
// In-memory Ed25519 keys only; offline and deterministic.
//
// IMPORTANT: `simulatedStore` is a TEST DOUBLE. It models atomic single-use semantics inside one process so
// the use of a challenge store can be exercised. It is NOT durable, NOT protected from the person being
// checked, and gives NO real replay protection. Real protection needs an external trusted store.

import { readFileSync } from 'node:fs';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { URL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyId, exportRawPublicKey, signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { evaluateAuthorization, type AuthorizationEvaluation, type EvaluateAuthorizationParams } from '../../../../src/features/action-safety/authorization/evaluateAuthorization.js';
import { verifyGrant, type VerifiedGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import { verifyPolicy, type PolicyDocument } from '../../../../src/features/action-safety/authorization/policy.js';
import { computeContentDigest, createProof, generateChallenge, type ActionContext, type ChallengeStore } from '../../../../src/features/action-safety/authorization/proof.js';
import { verifyRevocationList, type RevocationListResult } from '../../../../src/features/action-safety/authorization/revocation.js';
import { parseTrustRoot, type TrustRoot } from '../../../../src/features/action-safety/authorization/trustRoot.js';
import {
  attestSafetyDecision,
  finalizeAuthorization,
  isFinalizedAuthorization,
  isPreparedAuthorization,
  isSafetyDecisionAttestation,
  prepareAuthorization,
  type FinalizeAuthorizationParams,
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

const policyDoc = (revision = 5): Record<string, unknown> => ({
  version: 2,
  organization: 'acme',
  policyId: 'acme-policy',
  revision,
  issuedAt: '2026-05-01T00:00:00Z',
  effectiveAt: '2026-05-01T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z',
  permissions: ['code.change', 'deploy.production'],
  roles: [
    { name: 'developer', permissions: ['code.change'] },
    { name: 'release_engineer', permissions: ['code.change', 'deploy.production'] },
    { name: 'tech_lead', permissions: [] },
  ],
  rules: [
    { action: 'code_change', environment: 'development', allowedRoles: ['developer', 'release_engineer'], requiredPermissions: ['code.change'] },
    { action: 'deployment', environment: 'production', allowedRoles: ['release_engineer'], requiredPermissions: ['deploy.production'] },
  ],
});

const signRaw = (doc: unknown, key: Keys, domain: 'proof' | 'grant' | 'policy' | 'revocation') => signEnvelope({ domain, payload: Buffer.from(JSON.stringify(doc)), privateKey: key.privateKey });

let policyKey: Keys;
let grantKey: Keys;
let revocationKey: Keys;
let rajKey: Keys;
let aliceKey: Keys;
let root: TrustRoot;
let policy: PolicyDocument;
let raj: VerifiedGrant;
let alice: VerifiedGrant;

const verifiedPolicy = (revision: number): PolicyDocument => {
  const p = verifyPolicy(signRaw(policyDoc(revision), policyKey, 'policy'), root, T0);
  if (!p.ok) throw new Error(`setup policy: ${p.code}`);
  return p.policy;
};

const issueGrant = (who: Keys, grantId: string, subjectId: string, roles: string[]): VerifiedGrant => {
  const g = verifyGrant(
    signRaw(
      { version: 1, grantId, organization: 'acme', subject: { id: subjectId, type: 'human', publicKey: raw(who), keyId: id(who) }, roles, permissionScope: null, issuedAt: '2026-05-25T00:00:00Z', notBefore: '2026-05-25T00:00:00Z', expiresAt: '2026-08-01T00:00:00Z', minPolicyRevision: 1 },
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
  [policyKey, grantKey, revocationKey, rajKey, aliceKey] = Array.from({ length: 5 }, pair) as Keys[];
  const r = parseTrustRoot({ version: 1, organization: 'acme', createdAt: '2026-01-01T00:00:00Z', keys: [entry(policyKey, ['policy']), entry(grantKey, ['grant']), entry(revocationKey, ['revocation'])] });
  if (!r.ok) throw new Error('setup trust root');
  root = r.trustRoot;
  policy = verifiedPolicy(5);
  raj = issueGrant(rajKey, 'grant-raj-001', 'raj', ['release_engineer']);
  alice = issueGrant(aliceKey, 'grant-alice-001', 'alice', ['developer']);
});

// ---------------------------------------------------------------- builders

const prodDeploy = (over: Partial<ActionContext> = {}): ActionContext => ({
  actionId: 'act-deploy-1',
  actionType: 'deployment',
  environment: 'production',
  target: 'payments-service',
  commit: 'b'.repeat(40),
  contentDigest: computeContentDigest(Buffer.from('{"deploy":"payments-service","build":"1.4.2"}')),
  ...over,
});
const devChange = (): ActionContext => ({ actionId: 'act-dev-1', actionType: 'code_change', environment: 'development', target: 'payments-service', commit: 'a'.repeat(40), contentDigest: computeContentDigest(Buffer.from('diff')) });

/** A simulation only: see the header of this file. */
const simulatedStore = (): ChallengeStore & { calls: Array<{ challenge: string; grantId: string; actionId: string; expiresAt: string }> } => {
  const used = new Set<string>();
  const calls: Array<{ challenge: string; grantId: string; actionId: string; expiresAt: string }> = [];
  return {
    calls,
    async consume(e) {
      calls.push({ ...e });
      if (used.has(e.challenge)) return 'already_used';
      used.add(e.challenge); // check-and-record in one synchronous step: atomic within this process
      return 'consumed';
    },
  };
};

const list = (over: Record<string, unknown> = {}, maxAgeHours?: number): RevocationListResult =>
  verifyRevocationList(
    signRaw({ version: 1, organization: 'acme', listVersion: 3, issuedAt: '2026-06-01T00:00:00Z', nextUpdate: '2026-06-05T00:00:00Z', revokedGrantIds: [], revokedSubjectKeyIds: [], revokedIssuerKeyIds: [], ...over }, revocationKey, 'revocation'),
    root,
    T0,
    maxAgeHours === undefined ? {} : { maxAgeHours },
  );

type Built = EvaluateAuthorizationParams & { challengeStore: ReturnType<typeof simulatedStore> };

/** A complete, valid production deployment by `raj` (a release engineer), prepared at `from`. */
const params = (over: Partial<EvaluateAuthorizationParams> = {}, from: Date = T0): Built => {
  const context = prodDeploy();
  const challenge = generateChallenge();
  return {
    trustRoot: root,
    policy,
    requester: raj,
    revocation: list(),
    context,
    challenge,
    proof: createProof({ privateKey: rajKey.privateKey, grant: raj, context, challenge, issuedAt: from }),
    challengeStore: simulatedStore(),
    now: from,
    ...over,
  } as Built;
};

const devParams = (): Built => {
  const context = devChange();
  const challenge = generateChallenge();
  return params({ requester: alice, context, challenge, proof: createProof({ privateKey: aliceKey.privateKey, grant: alice, context, challenge, issuedAt: T0 }) });
};

const ready = (p: Built): PreparedAuthorization => {
  const r = prepareAuthorization(p);
  if (r.outcome !== 'ready_for_finalization') throw new Error(`setup: not ready (${r.outcome}) ${JSON.stringify(Object.entries(r.checks).map(([k, v]) => `${k}:${v.status}:${v.code}`))}`);
  return r;
};

interface FinOver {
  decision?: 'ALLOW' | 'ESCALATE' | 'BLOCK';
  context?: ActionContext;
  challenge?: string;
  store?: ChallengeStore | undefined;
  now?: Date;
  refresh?: FinalizeAuthorizationParams['refresh'];
  attestation?: FinalizeAuthorizationParams['safetyDecision'];
}

const finalize = (p: Built, prep: PreparedAuthorization, o: FinOver = {}): Promise<FinalizedAuthorization> =>
  finalizeAuthorization({
    prepared: prep,
    // key presence, not `??`: a deliberately null or undefined value must reach the code under test
    safetyDecision: 'attestation' in o ? o.attestation : attestSafetyDecision(prep, o.decision ?? 'ALLOW', 'context' in o ? (o.context as ActionContext) : p.context),
    context: 'context' in o ? (o.context as ActionContext) : p.context,
    challenge: 'challenge' in o ? (o.challenge as string) : p.challenge,
    ...('store' in o ? (o.store ? { challengeStore: o.store } : {}) : { challengeStore: p.challengeStore }),
    now: 'now' in o ? (o.now as Date) : at(T0, 120),
    ...(o.refresh ? { refresh: o.refresh } : {}),
  });

const codes = (e: { checks: object }): Record<string, string> =>
  Object.fromEntries(Object.entries(e.checks as Record<string, { status: string; code: string }>).map(([k, v]) => [k, `${v.status}:${v.code}`]));

// ================================================================ preparation

describe('prepareAuthorization', () => {
  it('with every prerequisite valid it is ready for finalization, not authorized, and leaves the challenge pending', () => {
    const p = params();
    const r = prepareAuthorization(p);
    expect(r.outcome).toBe('ready_for_finalization');
    expect(codes(r)).toEqual({
      policy: 'passed:policy_permits_action',
      requesterGrant: 'passed:grant_valid',
      requesterRevocation: 'passed:grant_not_revoked',
      roles: 'passed:role_eligible',
      permissions: 'passed:permissions_sufficient',
      proofOfPossession: 'passed:proof_valid',
      challengeConsumption: 'pending:challenge_pending',
    });
    expect(r.replayProtection).toBe('not_enforced');
    expect(r.executionPerformed).toBe(false);
    expect(r.preparedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(r.requirements).toMatchObject({ requiredRoles: ['release_engineer'], requiredPermissions: ['deploy.production'] });
    expect(r).not.toHaveProperty('approvalEntries');
    expect(isPreparedAuthorization(r)).toBe(true);
    expect(isPreparedAuthorization({ ...r })).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
    expect(r.outcome).not.toBe('authorized');
  });

  it('never calls the challenge store, even when one is supplied', () => {
    const p = params();
    prepareAuthorization(p);
    prepareAuthorization(p);
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('without a challenge store it is incomplete, not ready', () => {
    for (const challengeStore of [undefined, {} as ChallengeStore, { consume: 'nope' } as unknown as ChallengeStore, null as unknown as ChallengeStore]) {
      const r = prepareAuthorization(params({ challengeStore }));
      expect(r.outcome).toBe('incomplete');
      expect(r.checks.challengeConsumption).toMatchObject({ status: 'incomplete', code: 'no_challenge_store' });
    }
  });

  it('an invalid policy is denied', () => {
    const r = prepareAuthorization(params({ policy: { ...policy } }));
    expect(r.outcome).toBe('denied');
    expect(r.checks.policy.code).toBe('policy_unverified');
    expect(r.checks.challengeConsumption.status).toBe('not_evaluated');
  });

  it('an invalid or forged requester grant is denied', () => {
    for (const requester of [{ ...raj }, { ok: true, verified: true }, null, undefined, 5] as unknown[]) {
      const r = prepareAuthorization(params({ requester: requester as VerifiedGrant }));
      expect(r.outcome).toBe('denied');
      expect(r.checks.requesterGrant.code).toBe('requester_unverified');
    }
  });

  it('a revoked requester is denied', () => {
    const r = prepareAuthorization(params({ revocation: list({ revokedGrantIds: ['grant-raj-001'] }) }));
    expect(r.outcome).toBe('denied');
    expect(r.checks.requesterRevocation).toMatchObject({ status: 'failed', code: 'grant_revoked' });
  });

  it('missing or unusable revocation information is incomplete', () => {
    const stale = list({ issuedAt: '2026-05-24T00:00:00Z', nextUpdate: '2026-06-10T00:00:00Z' });
    for (const revocation of [undefined, stale]) {
      const r = prepareAuthorization(params({ revocation }));
      expect(r.outcome).toBe('incomplete');
      expect(r.checks.requesterRevocation.status).toBe('incomplete');
    }
  });

  it('a missing proof is incomplete and an invalid proof is denied', () => {
    expect(prepareAuthorization(params({ proof: undefined })).outcome).toBe('incomplete');
    const wrong = prepareAuthorization(params({ challenge: generateChallenge() }));
    expect(wrong.outcome).toBe('denied');
    expect(wrong.checks.proofOfPossession).toMatchObject({ code: 'proof_invalid', detail: 'wrong_challenge' });
  });

  it('missing revocation information is incomplete, never ready', () => {
    const r = prepareAuthorization(params({ revocation: undefined }));
    expect(r.outcome).toBe('incomplete');
    expect(r.checks.requesterRevocation.status).toBe('incomplete');
  });

  it('malformed and hostile inputs are denied without throwing, and are never ready', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    const inputs: unknown[] = [undefined, null, 5, 'x', [], {}, hostile];
    for (const [i, bad] of inputs.entries()) {
      const r = prepareAuthorization(bad as EvaluateAuthorizationParams);
      expect(r.outcome, `input ${i}`).not.toBe('ready_for_finalization');
      expect(isPreparedAuthorization(r)).toBe(true);
    }
    for (const key of ['trustRoot', 'policy', 'requester', 'context', 'challenge', 'now'] as const) {
      const p: Record<string, unknown> = { ...params() };
      delete p[key];
      expect(prepareAuthorization(p as unknown as EvaluateAuthorizationParams).outcome, key).not.toBe('ready_for_finalization');
    }
  });

  it('a development change by a developer prepares: no approval is needed or invented', () => {
    const r = prepareAuthorization(devParams());
    expect(r.outcome).toBe('ready_for_finalization');
    expect(Object.keys(r.checks)).not.toContain('approvals');
  });

  it('reports the same prerequisite diagnostics as evaluateAuthorization, apart from the deferred consumption', async () => {
    const variants: Array<Partial<EvaluateAuthorizationParams>> = [{}, { revocation: undefined }, { policy: { ...policy } }, { challenge: generateChallenge() }, { proof: undefined }];
    for (const over of variants) {
      const p = params(over);
      const evaluated: AuthorizationEvaluation = await evaluateAuthorization({ ...p, challengeStore: simulatedStore() });
      const prep = prepareAuthorization(p);
      const strip = (c: Record<string, { status: string; code: string }>) => {
        const { challengeConsumption, ...rest } = c;
        void challengeConsumption;
        return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, `${v.status}:${v.code}`]));
      };
      expect(strip(prep.checks as never)).toEqual(strip(evaluated.checks as never));
    }
  });
});

// ================================================================ finalization

describe('finalizeAuthorization: the successful path', () => {
  it('consumes the challenge once, after a trusted ALLOW, and returns authorized', async () => {
    const p = params();
    const prep = ready(p);
    const f = await finalize(p, prep);
    expect(f.outcome).toBe('authorized');
    expect(codes(f)).toEqual({
      policy: 'passed:policy_permits_action',
      requesterGrant: 'passed:grant_valid',
      requesterRevocation: 'passed:grant_not_revoked',
      roles: 'passed:role_eligible',
      permissions: 'passed:permissions_sufficient',
      proofOfPossession: 'passed:proof_valid',
      challengeConsumption: 'passed:challenge_consumed',
      finalization: 'passed:finalization_ready',
    });
    expect(f.replayProtection).toBe('consumed');
    expect(f.executionPerformed).toBe(false);
    expect(p.challengeStore.calls).toEqual([{ challenge: p.challenge, grantId: 'grant-raj-001', actionId: 'act-deploy-1', expiresAt: '2026-06-01T12:05:00Z' }]);
    expect(isFinalizedAuthorization(f)).toBe(true);
    expect(isFinalizedAuthorization({ ...f })).toBe(false);
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('works for a development change by a developer', async () => {
    const p = devParams();
    expect((await finalize(p, ready(p))).outcome).toBe('authorized');
    expect(p.challengeStore.calls).toHaveLength(1);
  });

  it('the store was untouched until finalization', async () => {
    const p = params();
    const prep = ready(p);
    expect(p.challengeStore.calls).toHaveLength(0);
    await finalize(p, prep);
    expect(p.challengeStore.calls).toHaveLength(1);
  });

  it('accepts a refreshed policy and revocation list that keep the prepared policy identity', async () => {
    const p = params();
    const prep = ready(p);
    const f = await finalize(p, prep, { refresh: { policy: verifiedPolicy(5), revocation: list({ listVersion: 4 }) } });
    expect(f.outcome).toBe('authorized');
  });

  it('is the only place `authorized` can come from: preparation never returns it', () => {
    const variants: Array<Partial<EvaluateAuthorizationParams>> = [{}, { revocation: undefined }, { challengeStore: undefined }];
    for (const over of variants) expect(prepareAuthorization(params(over)).outcome).not.toBe('authorized');
  });
});

describe('finalizeAuthorization: the safety decision', () => {
  it('a safety BLOCK prevents consumption', async () => {
    const p = params();
    const f = await finalize(p, ready(p), { decision: 'BLOCK' });
    expect(f.outcome).toBe('denied');
    expect(f.checks.finalization).toMatchObject({ status: 'failed', code: 'safety_not_allow', detail: 'BLOCK' });
    expect(f.checks.challengeConsumption.status).toBe('not_evaluated');
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('a safety ESCALATE prevents consumption', async () => {
    const p = params();
    const f = await finalize(p, ready(p), { decision: 'ESCALATE' });
    expect(f.outcome).toBe('denied');
    expect(f.checks.finalization).toMatchObject({ code: 'safety_not_allow', detail: 'ESCALATE' });
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('an unrecognized decision is recorded as BLOCK', async () => {
    const p = params();
    const prep = ready(p);
    for (const decision of ['allow', 'MAYBE', '', null, undefined, 5, { toString: () => 'ALLOW' }] as unknown[]) {
      const f = await finalize(p, prep, { attestation: attestSafetyDecision(prep, decision as 'ALLOW', p.context) });
      expect(f.outcome, String(decision)).toBe('denied');
    }
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('a missing safety decision is incomplete and consumes nothing', async () => {
    const p = params();
    for (const attestation of [undefined, null]) {
      const f = await finalize(p, ready(p), { attestation: attestation as never });
      expect(f.outcome).toBe('incomplete');
      expect(f.checks.finalization.code).toBe('safety_decision_missing');
    }
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('a forged safety decision is denied: plain objects, strings and copies are not attestations', async () => {
    const p = params();
    const prep = ready(p);
    const real = attestSafetyDecision(prep, 'ALLOW', p.context);
    const forgeries: unknown[] = [
      { kind: 'safety_decision_attestation', decision: 'ALLOW', issuer: 'unauthenticated_in_process' },
      'ALLOW',
      true,
      { decision: 'ALLOW' },
      { ...real },
      Object.create(real),
      5,
    ];
    for (const attestation of forgeries) {
      const f = await finalize(p, prep, { attestation: attestation as never });
      expect(f.outcome, JSON.stringify(attestation)).toBe('denied');
      expect(f.checks.finalization.code).toBe('safety_decision_untrusted');
    }
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('an attestation made for another prepared result or another action is refused', async () => {
    const p = params();
    const prep = ready(p);
    const q = params();
    const otherPrep = ready(q);
    const forOther = attestSafetyDecision(otherPrep, 'ALLOW', q.context);
    expect((await finalize(p, prep, { attestation: forOther })).checks.finalization.code).toBe('safety_decision_mismatch');
    const forOtherContext = attestSafetyDecision(prep, 'ALLOW', prodDeploy({ actionId: 'act-other' }));
    expect((await finalize(p, prep, { attestation: forOtherContext })).checks.finalization.code).toBe('safety_decision_mismatch');
    const forBadContext = attestSafetyDecision(prep, 'ALLOW', null as unknown as ActionContext);
    expect((await finalize(p, prep, { attestation: forBadContext })).checks.finalization.code).toBe('safety_decision_mismatch');
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('the attestation says plainly that it is not authenticated', () => {
    const p = params();
    const a = attestSafetyDecision(ready(p), 'ALLOW', p.context);
    expect(a).toMatchObject({ kind: 'safety_decision_attestation', decision: 'ALLOW', issuer: 'unauthenticated_in_process' });
    expect(isSafetyDecisionAttestation(a)).toBe(true);
    expect(isSafetyDecisionAttestation({ ...a })).toBe(false);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('attesting never throws, even for hostile input', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    const p = params();
    expect(() => attestSafetyDecision(ready(p), 'ALLOW', hostile as unknown as ActionContext)).not.toThrow();
    expect(() => attestSafetyDecision(hostile as unknown as PreparedAuthorization, 'ALLOW', p.context)).not.toThrow();
  });

  it('a BLOCK now does not spend the prepared result: a later ALLOW for the same unspent challenge can still finalize', async () => {
    const p = params();
    const prep = ready(p);
    expect((await finalize(p, prep, { decision: 'BLOCK' })).outcome).toBe('denied');
    expect((await finalize(p, prep, { decision: 'ALLOW' })).outcome).toBe('authorized');
    expect(p.challengeStore.calls).toHaveLength(1);
  });
});

describe('finalizeAuthorization: the prepared result', () => {
  it('refuses forged or copied preparation objects', async () => {
    const p = params();
    const prep = ready(p);
    const attestation = attestSafetyDecision(prep, 'ALLOW', p.context);
    const forgeries: unknown[] = [{ ...prep }, { outcome: 'ready_for_finalization', checks: prep.checks }, JSON.parse(JSON.stringify(prep)), null, undefined, 'ready', 5, Object.create(prep)];
    for (const forged of forgeries) {
      const f = await finalizeAuthorization({ prepared: forged as PreparedAuthorization, safetyDecision: attestation, context: p.context, challenge: p.challenge, challengeStore: p.challengeStore, now: at(T0, 60) });
      expect(f.outcome, JSON.stringify(forged)).toBe('denied');
      expect(f.checks.finalization.code).toBe('prepared_invalid');
    }
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('refuses to finalize a result that was not ready', async () => {
    const denied = params({ revocation: list({ revokedGrantIds: ['grant-raj-001'] }) });
    const incomplete = params({ revocation: undefined });
    for (const [p, outcome] of [[denied, 'denied'], [incomplete, 'incomplete']] as const) {
      const prep = prepareAuthorization(p);
      const f = await finalize(p, prep);
      expect(f.outcome).toBe(outcome);
      expect(f.checks.finalization.code).toBe('prepared_not_ready');
      expect(p.challengeStore.calls).toHaveLength(0);
    }
  });

  it('keeps its own copy of the prepared evidence: changing the caller’s objects afterwards changes nothing', async () => {
    const p = params();
    const prep = ready(p);
    (p.proof as { payload: string }).payload = 'tampered-after-preparation';
    (p.context as { target: string }).target = 'other-target';
    expect((await finalize(p, prep, { context: prodDeploy() })).outcome).toBe('authorized');
  });
});

describe('finalizeAuthorization: the action binding', () => {
  const changes: Array<[string, Partial<ActionContext>]> = [
    ['action id', { actionId: 'act-other' }],
    ['action type', { actionType: 'rollback' }],
    ['environment', { environment: 'staging' }],
    ['target', { target: 'billing-service' }],
    ['commit', { commit: 'c'.repeat(40) }],
    ['commit removed', { commit: null }],
    ['content digest', { contentDigest: computeContentDigest(Buffer.from('changed after preparation')) }],
  ];

  for (const [name, change] of changes) {
    it(`fails closed when the ${name} changed`, async () => {
      const p = params();
      const prep = ready(p);
      const f = await finalize(p, prep, { context: prodDeploy(change), attestation: attestSafetyDecision(prep, 'ALLOW', p.context) });
      expect(f.outcome).toBe('denied');
      expect(f.checks.finalization.code).toBe('context_changed');
      expect(f.checks.challengeConsumption.status).toBe('not_evaluated');
      expect(p.challengeStore.calls).toHaveLength(0);
    });
  }

  it('fails closed when the expected challenge changed, and for malformed contexts and challenges', async () => {
    const p = params();
    const prep = ready(p);
    const att = attestSafetyDecision(prep, 'ALLOW', p.context);
    expect((await finalize(p, prep, { challenge: generateChallenge(), attestation: att })).checks.finalization.code).toBe('challenge_changed');
    expect((await finalize(p, prep, { challenge: `${p.challenge}x`, attestation: att })).checks.finalization.code).toBe('challenge_changed');
    expect((await finalize(p, prep, { challenge: 5 as unknown as string, attestation: att })).checks.finalization.code).toBe('challenge_changed');
    expect((await finalize(p, prep, { context: null as unknown as ActionContext, attestation: att })).checks.finalization.code).toBe('context_changed');
    expect((await finalize(p, prep, { context: { ...prodDeploy(), extra: 1 } as unknown as ActionContext, attestation: att })).checks.finalization.code).toBe('context_changed');
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('does not take the context from the proof: the proof matches the prepared context, and a different supplied context is refused', async () => {
    const p = params();
    const prep = ready(p);
    const other = prodDeploy({ actionId: 'act-from-somewhere-else' });
    const f = await finalize(p, prep, { context: other, attestation: attestSafetyDecision(prep, 'ALLOW', other) });
    expect(f.outcome).toBe('denied');
    expect(p.challengeStore.calls).toHaveLength(0);
  });
});

describe('finalizeAuthorization: revalidation of time-sensitive state', () => {
  it('re-checks proof expiry: an expired proof is denied and nothing is consumed', async () => {
    const p = params();
    const prep = ready(p);
    const f = await finalize(p, prep, { now: at(T0, 6 * 60) });
    expect(f.outcome).toBe('denied');
    expect(f.checks.proofOfPossession).toMatchObject({ status: 'failed', code: 'proof_invalid', detail: 'expired_proof' });
    expect(f.checks.challengeConsumption.status).toBe('not_evaluated');
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('re-checks the requester grant window', async () => {
    const p = params();
    const prep = ready(p);
    const f = await finalize(p, prep, { now: new Date('2026-08-02T00:00:00Z') });
    expect(f.outcome).toBe('denied');
    expect(f.checks.requesterGrant).toMatchObject({ status: 'failed', code: 'grant_expired' });
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('re-checks revocation freshness: a list that went stale after preparation is incomplete', async () => {
    const from = new Date('2026-06-01T12:59:00Z');
    const shortWindow = list({}, 13); // issued 00:00; fresh for 13 hours
    expect(shortWindow.ok).toBe(true);
    const p = params({ revocation: shortWindow }, from);
    const prep = ready(p);
    const f = await finalize(p, prep, { now: at(from, 120) }); // 13:01, 13h01 after issue
    expect(f.outcome).toBe('incomplete');
    expect(f.checks.requesterRevocation).toMatchObject({ status: 'incomplete', code: 'revocation_unavailable', detail: 'list_stale' });
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('re-checks whether the requester has been revoked since preparation', async () => {
    const p = params();
    const prep = ready(p);
    const f = await finalize(p, prep, { refresh: { revocation: list({ revokedGrantIds: ['grant-raj-001'] }) } });
    expect(f.outcome).toBe('denied');
    expect(f.checks.requesterRevocation).toMatchObject({ status: 'failed', code: 'grant_revoked' });
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('a revocation source that disappeared is incomplete, not clean', async () => {
    const p = params();
    const f = await finalize(p, ready(p), { refresh: { revocation: undefined } });
    expect(f.outcome).toBe('incomplete');
    expect(f.checks.requesterRevocation.detail).toBe('no_list');
    expect(p.challengeStore.calls).toHaveLength(0);
  });

  it('rejects a changed policy revision (or identity)', async () => {
    const p = params();
    const prep = ready(p);
    const f = await finalize(p, prep, { refresh: { policy: verifiedPolicy(6) } });
    expect(f.outcome).toBe('denied');
    expect(f.checks.finalization.code).toBe('policy_changed');
    expect(p.challengeStore.calls).toHaveLength(0);
    const forged = await finalize(p, prep, { refresh: { policy: { ...policy } } });
    expect(forged.outcome).toBe('denied');
    expect(forged.checks.policy.code).toBe('policy_unverified');
  });

  it('re-checks that the policy is still in effect', async () => {
    const p = params();
    const prep = ready(p);
    const f = await finalize(p, prep, { now: new Date('2026-12-05T00:00:00Z') });
    expect(f.outcome).toBe('denied');
    expect(f.checks.policy.code).toBe('policy_not_current');
  });

  it('refuses a finalization time that is earlier than the preparation time, or invalid', async () => {
    const p = params();
    const prep = ready(p);
    expect((await finalize(p, prep, { now: at(T0, -60) })).checks.finalization.code).toBe('time_went_backwards');
    for (const now of [new Date('x'), '2026-06-01' as unknown as Date, null as unknown as Date]) {
      expect((await finalize(p, prep, { now })).checks.finalization.code).toBe('invalid_evaluation_time');
    }
    expect(p.challengeStore.calls).toHaveLength(0);
  });

});

describe('finalizeAuthorization: the challenge store', () => {
  it('a missing store at finalization is incomplete, consumes nothing, and does not spend the prepared result', async () => {
    const p = params();
    const prep = ready(p);
    for (const store of [undefined, {} as ChallengeStore, null as unknown as ChallengeStore]) {
      const f = await finalize(p, prep, { store: store as ChallengeStore | undefined });
      expect(f.outcome).toBe('incomplete');
      expect(f.checks.challengeConsumption).toMatchObject({ status: 'incomplete', code: 'no_challenge_store' });
      expect(f.replayProtection).toBe('not_enforced');
    }
    // once a working store is available the same prepared result can still be finalized
    expect((await finalize(p, prep)).outcome).toBe('authorized');
  });

  it('an unavailable store (throws, rejects, nonsense) is incomplete', async () => {
    const broken: ChallengeStore[] = [
      { consume: () => { throw new Error('disk gone'); } },
      { consume: async () => { throw new Error('db down'); } },
      { consume: async () => 'maybe' as never },
      { consume: async () => undefined as never },
    ];
    for (const store of broken) {
      const p = params();
      const f = await finalize(p, ready(p), { store });
      expect(f.outcome).toBe('incomplete');
      expect(f.checks.challengeConsumption).toMatchObject({ status: 'incomplete', code: 'challenge_store_unavailable' });
      expect(f.replayProtection).toBe('not_enforced');
    }
  });

  it('an already used challenge is denied: the store, not this module, decides single use across calls', async () => {
    const store = simulatedStore();
    const p = params({ challengeStore: store });
    // two independent preparations of the same proof: the second stands for another process
    const first = ready(p);
    const second = ready(p);
    expect((await finalize(p, first)).outcome).toBe('authorized');
    const again = await finalize(p, second);
    expect(again.outcome).toBe('denied');
    expect(again.checks.challengeConsumption).toMatchObject({ status: 'failed', code: 'challenge_already_used' });
    expect(again.replayProtection).toBe('not_enforced');
    expect(store.calls).toHaveLength(2);
  });

  it('a successful consumption authorizes exactly once with the simulated atomic store', async () => {
    const p = params();
    const f = await finalize(p, ready(p));
    expect(f).toMatchObject({ outcome: 'authorized', replayProtection: 'consumed' });
  });
});

describe('repeated finalization', () => {
  it('a prepared result cannot be finalized twice in this process, and the store is not asked again', async () => {
    const p = params();
    const prep = ready(p);
    const att = attestSafetyDecision(prep, 'ALLOW', p.context);
    expect((await finalize(p, prep, { attestation: att })).outcome).toBe('authorized');
    const second = await finalize(p, prep, { attestation: att });
    expect(second.outcome).toBe('denied');
    expect(second.checks.finalization.code).toBe('already_finalized');
    expect(second.replayProtection).toBe('not_enforced');
    // even with a fresh attestation
    const third = await finalize(p, prep);
    expect(third.checks.finalization.code).toBe('already_finalized');
    expect(p.challengeStore.calls).toHaveLength(1);
  });

  it('an attestation cannot be reused for another prepared result', async () => {
    const p = params();
    const prep = ready(p);
    const att = attestSafetyDecision(prep, 'ALLOW', p.context);
    await finalize(p, prep, { attestation: att });
    const q = params();
    const other = ready(q);
    expect((await finalize(q, other, { attestation: att })).checks.finalization.code).toBe('safety_decision_mismatch');
    expect(q.challengeStore.calls).toHaveLength(0);
  });

  it('two concurrent finalizations reach the store at most once', async () => {
    const p = params();
    const prep = ready(p);
    const [a, b] = await Promise.all([finalize(p, prep), finalize(p, prep)]);
    expect([a.outcome, b.outcome].sort()).toEqual(['authorized', 'denied']);
    expect(p.challengeStore.calls).toHaveLength(1);
  });

  it('a prepared result is not an authorization token: it carries no authorized outcome and cannot be passed as a finalized one', async () => {
    const p = params();
    const prep = ready(p);
    expect(isFinalizedAuthorization(prep)).toBe(false);
    expect(prep.outcome).toBe('ready_for_finalization');
    expect('authorized' in prep).toBe(false);
  });

  it('a finalization after the store was consumed elsewhere is decided by the store, whatever this process remembers', async () => {
    const store = simulatedStore();
    const p = params({ challengeStore: store });
    await store.consume({ challenge: p.challenge, grantId: 'grant-raj-001', actionId: 'act-deploy-1', expiresAt: '2026-06-01T12:05:00Z' });
    const f = await finalize(p, ready(p));
    expect(f.outcome).toBe('denied');
    expect(f.checks.challengeConsumption.code).toBe('challenge_already_used');
  });
});

describe('safety, leakage and independence', () => {
  it('never leaks the challenge, digest, target, commit, proof contents or keys', async () => {
    const p = params();
    const prep = ready(p);
    const outputs = [prep, await finalize(p, prep), await finalize(params(), prepareAuthorization(params({ revocation: undefined })))];
    const proof = p.proof as { signature: string; payload: string };
    for (const out of outputs) {
      const text = JSON.stringify(out);
      for (const secret of [p.challenge, p.context.contentDigest, 'payments-service', 'b'.repeat(40), proof.signature, proof.payload, raw(rajKey), String(rajKey.privateKey.export({ format: 'jwk' }).d)]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('is deterministic given the same inputs and store answers', async () => {
    const run = async () => {
      const p = params();
      const prep = ready(p);
      return codes(await finalize(p, prep));
    };
    expect(await run()).toEqual(await run());
  });

  it('invariant: `authorized` only appears with every check satisfied, the challenge consumed and one store call', async () => {
    const variants: Array<[Partial<EvaluateAuthorizationParams>, FinOver]> = [
      [{}, {}],
      [{}, { decision: 'BLOCK' }],
      [{}, { now: at(T0, 400) }],
      [{ revocation: undefined }, {}],
      [{ revocation: undefined }, {}],
      [{}, { refresh: { revocation: list({ revokedGrantIds: ['grant-raj-001'] }) } }],
      [{}, { refresh: { policy: verifiedPolicy(6) } }],
      [{}, { context: prodDeploy({ target: 'x' }) }],
    ];
    for (const [over, fin] of variants) {
      const p = params(over);
      const prep = prepareAuthorization(p);
      const f = await finalize(p, prep, fin);
      if (f.outcome === 'authorized') {
        for (const c of Object.values(f.checks)) expect(['passed', 'not_required']).toContain(c.status);
        expect(f.replayProtection).toBe('consumed');
        expect(p.challengeStore.calls).toHaveLength(1);
      } else {
        expect(Object.values(f.checks).some((c) => c.status !== 'passed' && c.status !== 'not_required')).toBe(true);
        expect(p.challengeStore.calls.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never throws on hostile finalization parameters, and never authorizes them', async () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    const inputs: unknown[] = [undefined, null, 5, 'x', [], {}, hostile];
    for (const [i, bad] of inputs.entries()) {
      const f = await finalizeAuthorization(bad as FinalizeAuthorizationParams);
      expect(f.outcome, `input ${i}`).not.toBe('authorized');
      expect(isFinalizedAuthorization(f)).toBe(true);
    }
    const p = params();
    const prep = ready(p);
    const f = await finalizeAuthorization({ prepared: prep, safetyDecision: attestSafetyDecision(prep, 'ALLOW', p.context), context: hostile as never, challenge: hostile as never, now: hostile as never, challengeStore: hostile as never });
    expect(f.outcome).not.toBe('authorized');
  });

  it('does not execute anything, and the source has no execution, filesystem, Git, network or environment access', () => {
    const full = readFileSync(new URL('../../../../src/features/action-safety/authorization/twoPhaseAuthorization.ts', import.meta.url), 'utf-8');
    const source = full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['child_process', 'node:fs', "from 'fs'", 'process.env', 'process.cwd', 'fetch(', 'node:http', 'node:net', 'simple-git', 'Math.random', 'execSync', 'spawn']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.every((i) => i?.startsWith('./') || i === '../model/types.js')).toBe(true);
  });
});

describe('compatibility with evaluateAuthorization', () => {
  it('evaluateAuthorization still consumes the challenge itself and keeps its codes', async () => {
    const p = params();
    const e = await evaluateAuthorization(p);
    expect(e.outcome).toBe('authorized');
    expect(e.checks.challengeConsumption).toMatchObject({ status: 'passed', code: 'challenge_consumed' });
    expect(p.challengeStore.calls).toHaveLength(1);
    const none = await evaluateAuthorization({ ...params(), challengeStore: undefined });
    expect(none.checks.challengeConsumption).toMatchObject({ status: 'incomplete', code: 'no_challenge_store' });
  });

  it('the new `pending` status never appears in an evaluateAuthorization result', async () => {
    for (const over of [{}, { revocation: undefined }, { challengeStore: undefined }] as Array<Partial<EvaluateAuthorizationParams>>) {
      const e = await evaluateAuthorization(params(over));
      for (const c of Object.values(e.checks)) expect(c.status).not.toBe('pending');
    }
  });
});
