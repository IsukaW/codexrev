import { describe, expect, it } from 'vitest';
import {
  constrainDecision,
  evaluateGates,
  type GateInput,
  type GatePolicy,
} from '../../../src/features/action-safety/calculus/gates.js';
import type {
  EvidenceSnapshot,
  AuthorityContext,
  GateId,
  ProposedAction,
} from '../../../src/features/action-safety/model/types.js';

const ALL_REQUIRED: GatePolicy = {
  authorization: { required: true },
  recovery: { required: true, whenIrreversible: true, minImpact: 'high' },
  buildTests: { required: true },
  supportingEvidence: { required: true },
};

const NOTHING_REQUIRED: GatePolicy = {
  authorization: { required: false },
  recovery: { required: false, whenIrreversible: true },
  buildTests: { required: false },
  supportingEvidence: { required: false },
};

const ACTION: ProposedAction = {
  identity: { id: 'act-1', type: 'database_migration', description: 'drop legacy column' },
  environment: 'production',
  impact: 'high',
  irreversible: true,
};

const GOOD_AUTHORITY: AuthorityContext = {
  actor: { id: 'alice', kind: 'human', roles: ['release-manager'] },
  authorization: { status: 'PASS', refs: ['rbac:release-manager'] },
};

const GOOD_EVIDENCE: EvidenceSnapshot = {
  buildTests: { status: 'PASS', refs: ['ci:run-7'] },
  supporting: { status: 'PASS', refs: ['review:9'] },
  recovery: { status: 'PASS', refs: ['backup:2024-snap'] },
};

function input(overrides: Partial<GateInput> = {}): GateInput {
  return { action: ACTION, authority: GOOD_AUTHORITY, evidence: GOOD_EVIDENCE, policy: ALL_REQUIRED, ...overrides };
}

function result(i: GateInput, gate: GateId) {
  return evaluateGates(i).results.find((r) => r.gate === gate)!;
}

describe('evaluateGates', () => {
  it('passes every gate and imposes no constraint when all mandatory conditions are satisfied', () => {
    const ev = evaluateGates(input());
    expect(ev.results).toHaveLength(4);
    expect(ev.results.every((r) => r.status === 'PASS')).toBe(true);
    expect(ev.triggered).toEqual([]);
    expect(ev.consequence).toBeNull();
    expect(constrainDecision('ALLOW', ev)).toBe('ALLOW');
  });

  it('carries evidence references through to the gate result', () => {
    expect(result(input(), 'AUTHORIZATION').evidenceRefs).toEqual(['rbac:release-manager']);
    expect(result(input(), 'BUILD_TEST_RESULTS').evidenceRefs).toEqual(['ci:run-7']);
  });

  it('is deterministic: same input gives deep-equal output', () => {
    expect(evaluateGates(input())).toEqual(evaluateGates(input()));
  });

  describe('authorization', () => {
    it('fails and blocks when authorization is missing', () => {
      const i = input({ authority: { actor: GOOD_AUTHORITY.actor } });
      const r = result(i, 'AUTHORIZATION');
      expect(r.status).toBe('FAIL');
      expect(r.consequence).toBe('BLOCK');
      expect(evaluateGates(i).consequence).toBe('BLOCK');
    });

    it('fails when authorization is explicitly denied', () => {
      const i = input({ authority: { ...GOOD_AUTHORITY, authorization: { status: 'FAIL' } } });
      expect(result(i, 'AUTHORIZATION').status).toBe('FAIL');
    });
  });

  describe('no human approval gate', () => {
    it('evaluates exactly four gates, and none of them is a Human Approval gate', () => {
      const ev = evaluateGates(input());
      expect(ev.results.map((r) => r.gate).sort()).toEqual(['AUTHORIZATION', 'BUILD_TEST_RESULTS', 'SUPPORTING_EVIDENCE', 'VERIFIED_RECOVERY']);
    });

    it('a stray humanApproval entry in the authority context or policy is ignored: it can neither pass nor fail anything', () => {
      const noApproval = evaluateGates(input());
      const stray = evaluateGates(
        input({
          authority: { ...GOOD_AUTHORITY, humanApproval: { status: 'FAIL' } } as unknown as AuthorityContext,
          policy: { ...ALL_REQUIRED, humanApproval: { required: true, consequence: 'BLOCK' } } as unknown as GatePolicy,
        }),
      );
      expect(stray).toEqual(noApproval);
    });
  });

  describe('verified recovery', () => {
    it('blocks an irreversible action with no recovery evidence', () => {
      const i = input({ evidence: { ...GOOD_EVIDENCE, recovery: undefined } });
      const r = result(i, 'VERIFIED_RECOVERY');
      expect(r.status).toBe('FAIL');
      expect(r.consequence).toBe('BLOCK');
      expect(evaluateGates(i).consequence).toBe('BLOCK');
    });

    it('is required for a reversible action only when impact meets the policy threshold', () => {
      const reversibleHigh = input({ action: { ...ACTION, irreversible: false }, evidence: { ...GOOD_EVIDENCE, recovery: undefined } });
      expect(result(reversibleHigh, 'VERIFIED_RECOVERY').status).toBe('FAIL');

      const reversibleLow = input({
        action: { ...ACTION, irreversible: false, impact: 'low' },
        evidence: { ...GOOD_EVIDENCE, recovery: undefined },
      });
      expect(result(reversibleLow, 'VERIFIED_RECOVERY').status).toBe('NOT_APPLICABLE');
    });

    it('does not treat unverified (UNKNOWN) recovery as verified', () => {
      const i = input({ evidence: { ...GOOD_EVIDENCE, recovery: { status: 'UNKNOWN' } } });
      expect(result(i, 'VERIFIED_RECOVERY').status).toBe('UNKNOWN');
      expect(evaluateGates(i).consequence).toBe('BLOCK');
    });
  });

  describe('build/test results', () => {
    it('blocks when mandatory tests failed', () => {
      const i = input({ evidence: { ...GOOD_EVIDENCE, buildTests: { status: 'FAIL', refs: ['ci:run-8'] } } });
      const r = result(i, 'BUILD_TEST_RESULTS');
      expect(r).toMatchObject({ status: 'FAIL', consequence: 'BLOCK', evidenceRefs: ['ci:run-8'] });
      expect(evaluateGates(i).consequence).toBe('BLOCK');
    });

    it('is UNKNOWN (not PASS) and still blocks when results are missing', () => {
      const i = input({ evidence: { ...GOOD_EVIDENCE, buildTests: undefined } });
      expect(result(i, 'BUILD_TEST_RESULTS').status).toBe('UNKNOWN');
      expect(evaluateGates(i).consequence).toBe('BLOCK');
    });
  });

  describe('supporting evidence', () => {
    it('never passes when mandatory evidence is missing', () => {
      const i = input({ evidence: { ...GOOD_EVIDENCE, supporting: undefined } });
      const r = result(i, 'SUPPORTING_EVIDENCE');
      expect(r.status).not.toBe('PASS');
      expect(r.status).toBe('UNKNOWN');
      expect(constrainDecision('ALLOW', evaluateGates(i))).toBe('ESCALATE');
    });

    it('honours a BLOCK consequence from policy', () => {
      const policy: GatePolicy = { ...ALL_REQUIRED, supportingEvidence: { required: true, consequence: 'BLOCK' } };
      const i = input({ policy, evidence: { ...GOOD_EVIDENCE, supporting: undefined } });
      expect(evaluateGates(i).consequence).toBe('BLOCK');
    });
  });

  describe('unknown evidence', () => {
    it('treats UNKNOWN as not safe on every gate that is required', () => {
      const unknown = { status: 'UNKNOWN' } as const;
      const i = input({
        authority: { actor: GOOD_AUTHORITY.actor, authorization: unknown },
        evidence: { buildTests: unknown, supporting: unknown, recovery: unknown },
      });
      const ev = evaluateGates(i);
      expect(ev.results.map((r) => r.status)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
      expect(ev.triggered).toHaveLength(4);
      expect(ev.consequence).toBe('BLOCK');
    });
  });

  describe('not applicable', () => {
    it('reports NOT_APPLICABLE for every gate the policy does not require, even with no evidence at all', () => {
      const i = input({
        policy: NOTHING_REQUIRED,
        authority: { actor: GOOD_AUTHORITY.actor },
        evidence: {},
      });
      const ev = evaluateGates(i);
      expect(ev.results.every((r) => r.status === 'NOT_APPLICABLE')).toBe(true);
      expect(ev.triggered).toEqual([]);
      expect(ev.consequence).toBeNull();
    });

    it('does not accept NOT_APPLICABLE evidence for a gate the policy requires', () => {
      const i = input({ evidence: { ...GOOD_EVIDENCE, buildTests: { status: 'NOT_APPLICABLE' } } });
      const r = result(i, 'BUILD_TEST_RESULTS');
      expect(r.status).toBe('UNKNOWN');
      expect(r.explanation).toMatch(/NOT_APPLICABLE/);
      expect(evaluateGates(i).consequence).toBe('BLOCK');
    });

    it('only requires the gates the policy names, not every gate', () => {
      const policy: GatePolicy = { ...NOTHING_REQUIRED, buildTests: { required: true } };
      const i = input({ policy, authority: { actor: GOOD_AUTHORITY.actor }, evidence: GOOD_EVIDENCE });
      const ev = evaluateGates(i);
      expect(ev.results.filter((r) => r.status === 'NOT_APPLICABLE')).toHaveLength(3);
      expect(ev.consequence).toBeNull();
    });
  });

  describe('multiple failing gates', () => {
    it('reports every failing gate and BLOCK wins over ESCALATE', () => {
      const i = input({
        authority: { actor: GOOD_AUTHORITY.actor }, // no authorization (BLOCK)
        evidence: { ...GOOD_EVIDENCE, buildTests: { status: 'FAIL' }, recovery: undefined, supporting: undefined }, // and missing supporting evidence (ESCALATE)
      });
      const ev = evaluateGates(i);
      expect(ev.triggered.map((r) => r.gate).sort()).toEqual(
        ['AUTHORIZATION', 'BUILD_TEST_RESULTS', 'SUPPORTING_EVIDENCE', 'VERIFIED_RECOVERY'].sort(),
      );
      expect(ev.consequence).toBe('BLOCK');
    });
  });

  describe('independence from the Safety Score', () => {
    it('a very high hypothetical score cannot override a blocking gate', () => {
      const hypotheticalScore = 0.99;
      const scoreSaysAllow = hypotheticalScore >= 0.8 ? 'ALLOW' : 'ESCALATE';
      const i = input({ evidence: { ...GOOD_EVIDENCE, buildTests: { status: 'FAIL' } } });
      expect(scoreSaysAllow).toBe('ALLOW');
      expect(constrainDecision(scoreSaysAllow, evaluateGates(i))).toBe('BLOCK');
    });

    it('never loosens a decision: a BLOCK from elsewhere stays BLOCK under an ESCALATE gate', () => {
      const i = input({ evidence: { ...GOOD_EVIDENCE, supporting: undefined } }); // supporting evidence defaults to ESCALATE
      const ev = evaluateGates(i);
      expect(ev.consequence).toBe('ESCALATE');
      expect(constrainDecision('BLOCK', ev)).toBe('BLOCK');
      expect(constrainDecision('ESCALATE', ev)).toBe('ESCALATE');
    });
  });
});
