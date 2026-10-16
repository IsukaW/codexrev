import { describe, expect, it } from 'vitest';
import { assessAuthority, type AuthorityAssessmentInput } from '../../../src/features/action-safety/calculus/authority.js';
import { constrainDecision, evaluateGates, type GatePolicy } from '../../../src/features/action-safety/calculus/gates.js';
import { FactorInputError } from '../../../src/features/action-safety/calculus/scoring.js';
import type { EvidenceItem } from '../../../src/features/action-safety/model/types.js';

const NOW = '2025-01-10T12:00:00.000Z';
const FRESH = '2025-01-10T06:00:00.000Z';

const verified = (refs: string[], observedAt = FRESH): EvidenceItem => ({
  status: 'PASS',
  source: 'verified_system',
  observedAt,
  refs,
});

const ACTOR = { id: 'alice', kind: 'human' as const, roles: ['release-manager'] };

function fullInput(overrides: Partial<AuthorityAssessmentInput> = {}): AuthorityAssessmentInput {
  return {
    now: NOW,
    actor: ACTOR,
    identityVerification: verified(['sso:alice']),
    requiredRoles: ['release-manager'],
    requiredPermissions: ['deploy:prod'],
    granted: { permissions: ['deploy:prod', 'read:logs'], evidence: verified(['rbac:grant-1']) },
    requiredApprovals: 1,
    approvals: [{ approverId: 'bob', evidence: verified(['approval:bob']) }],
    ...overrides,
  };
}

describe('assessAuthority', () => {
  it('scores 1 when identity, roles, permissions and approvals are all verified', () => {
    const a = assessAuthority(fullInput());
    expect(a.factor).toBe('authority');
    expect(a.score).toBe(1);
    expect(a.missing).toEqual([]);
    expect(a.conflicts).toEqual([]);
    expect(a.evidenceRefs).toEqual(expect.arrayContaining(['sso:alice', 'rbac:grant-1', 'approval:bob']));
  });

  it('does not treat self-declared permissions as verified authority', () => {
    const selfDeclared: EvidenceItem = { status: 'PASS', source: 'self_declared', observedAt: FRESH };
    const a = assessAuthority(fullInput({ granted: { permissions: ['deploy:prod'], evidence: selfDeclared } }));
    expect(a.score).toBeCloseTo(0.65, 6); // permissions component is worth 0
    expect(a.uncertain.join(' ')).toMatch(/not trusted/);
  });

  it('treats a permission list with no proving record as unverified', () => {
    const a = assessAuthority(fullInput({ granted: { permissions: ['deploy:prod'] } }));
    expect(a.score).toBeCloseTo(0.65, 6);
    expect(a.missing).toContain('permission grant record');
  });

  it('reports missing grants and approvals', () => {
    const a = assessAuthority(fullInput({ granted: undefined, approvals: undefined }));
    expect(a.missing).toEqual(expect.arrayContaining(['granted permissions', 'human approvals']));
    expect(a.score).toBeLessThan(0.5);
  });

  it('gives partial credit when only some required permissions are granted', () => {
    const a = assessAuthority(
      fullInput({ requiredPermissions: ['deploy:prod', 'db:migrate'], granted: { permissions: ['deploy:prod'], evidence: verified(['g']) } }),
    );
    expect(a.score).toBeLessThan(1);
    expect(a.uncertain.join(' ')).toMatch(/db:migrate/);
  });

  it('ignores an actor approving their own action', () => {
    const a = assessAuthority(fullInput({ approvals: [{ approverId: 'alice', evidence: verified(['self']) }] }));
    expect(a.uncertain.join(' ')).toMatch(/cannot approve their own action/);
    expect(a.missing).toContain('human approvals');
    expect(a.score).toBeCloseTo(0.75, 6);
  });

  it('counts the same approver only once', () => {
    const a = assessAuthority(
      fullInput({
        requiredApprovals: 2,
        approvals: [
          { approverId: 'bob', evidence: verified(['a1']) },
          { approverId: 'bob', evidence: verified(['a2']) },
        ],
      }),
    );
    expect(a.breakdown.find((c) => c.name === 'human approvals')!.value).toBeCloseTo(0.5, 6);
  });

  it('gives partial credit when fewer approvals than required are present', () => {
    const a = assessAuthority(fullInput({ requiredApprovals: 2 }));
    expect(a.score).toBeCloseTo(0.875, 6);
  });

  it('lets an explicit rejection zero the approvals and flags the conflict if others approved', () => {
    const a = assessAuthority(
      fullInput({
        approvals: [
          { approverId: 'bob', evidence: verified(['a']) },
          { approverId: 'carol', evidence: { status: 'FAIL', refs: ['rej'] } },
        ],
      }),
    );
    expect(a.breakdown.find((c) => c.name === 'human approvals')!.value).toBe(0);
    expect(a.conflicts).toEqual(['some approvers approved while another explicitly rejected']);
    expect(a.score).toBeCloseTo(0.75, 6);
  });

  it('caps the score when identity is not verified', () => {
    const a = assessAuthority(fullInput({ identityVerification: undefined }));
    expect(a.score).toBeCloseTo(0.3, 6);
    expect(a.missing).toContain('identity verification');
    expect(a.adjustments.map((x) => x.name)).toEqual(['unverified identity cap']);
  });

  it('gives less credit to stale approvals than fresh ones, with an exact boundary at the max age', () => {
    const nowMs = Date.parse(NOW);
    const limit = 72 * 3_600_000;
    const approval = (observedAt: string) => fullInput({ approvals: [{ approverId: 'bob', evidence: verified(['a'], observedAt) }] });
    const atLimit = assessAuthority(approval(new Date(nowMs - limit).toISOString()));
    const over = assessAuthority(approval(new Date(nowMs - limit - 1).toISOString()));
    expect(atLimit.score).toBe(1);
    expect(over.score).toBeCloseTo(0.875, 6);
    expect(over.uncertain.join(' ')).toMatch(/older than/);
  });

  it('treats UNKNOWN identity as uncertain and caps the score', () => {
    const a = assessAuthority(fullInput({ identityVerification: { status: 'UNKNOWN' } }));
    expect(a.uncertain.join(' ')).toMatch(/unknown/);
    expect(a.score).toBeLessThanOrEqual(0.3);
  });

  it('counts roles only as claimed: missing a required role lowers the score and is reported', () => {
    const a = assessAuthority(fullInput({ actor: { ...ACTOR, roles: [] } }));
    expect(a.score).toBeLessThan(1);
    expect(a.uncertain.join(' ')).toMatch(/does not hold required role/);
  });

  it('applies only the components that are required', () => {
    const a = assessAuthority({ now: NOW, actor: ACTOR, identityVerification: verified(['sso']) });
    expect(a.score).toBe(1);
    expect(a.breakdown.filter((c) => c.applied).map((c) => c.name)).toEqual(['identity verified']);
  });

  it('direction: more verified authority gives a higher score', () => {
    const none = assessAuthority(fullInput({ identityVerification: undefined, granted: undefined, approvals: undefined })).score;
    const some = assessAuthority(fullInput({ approvals: undefined })).score;
    const all = assessAuthority(fullInput()).score;
    expect(none).toBeLessThan(some);
    expect(some).toBeLessThan(all);
  });

  it('is deterministic', () => {
    expect(assessAuthority(fullInput())).toEqual(assessAuthority(fullInput()));
  });

  it('rejects invalid input', () => {
    expect(() => assessAuthority(fullInput({ requiredApprovals: 1.5 }))).toThrow(FactorInputError);
    expect(() => assessAuthority(fullInput({ requiredApprovals: -1 }))).toThrow(FactorInputError);
    expect(() => assessAuthority(fullInput({ now: 'nope' }))).toThrow(FactorInputError);
  });

  it('a perfect authority score cannot override a failing Critical Safety Gate', () => {
    expect(assessAuthority(fullInput()).score).toBe(1);
    const policy: GatePolicy = {
      authorization: { required: false },
      humanApproval: { required: true },
      recovery: { required: false, whenIrreversible: false },
      buildTests: { required: false },
      supportingEvidence: { required: false },
    };
    const gates = evaluateGates({
      action: { identity: { id: 'a', type: 'deployment', description: 'd' }, environment: 'production', impact: 'high', irreversible: false },
      authority: { actor: ACTOR },
      evidence: {},
      policy,
    });
    expect(constrainDecision('ALLOW', gates)).toBe('ESCALATE');
  });
});
