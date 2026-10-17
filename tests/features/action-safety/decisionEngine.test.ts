import { describe, expect, it } from 'vitest';
import { calculateSafetyScore, type ActionSafetyResult } from '../../../src/features/action-safety/calculus/calculus.js';
import {
  DEFAULT_DECISION_POLICY,
  DecisionInputError,
  decideAction,
  type DecisionPolicy,
} from '../../../src/features/action-safety/calculus/decisionEngine.js';
import {
  evaluateGates,
  type GateEvaluation,
  type GateInput,
  type GatePolicy,
} from '../../../src/features/action-safety/calculus/gates.js';
import type { Decision, FactorAssessment, FactorId } from '../../../src/features/action-safety/model/types.js';

function stub(factor: FactorId, score: number): FactorAssessment {
  return { factor, score, explanation: 'test', evidenceRefs: [], missing: [], uncertain: [], conflicts: [], breakdown: [], adjustments: [] };
}

// a real calculus result built from factor values
function calcFor(r: number, b: number, a: number, e: number): ActionSafetyResult {
  return calculateSafetyScore([stub('reversibility', r), stub('blastRadius', b), stub('authority', a), stub('evidenceStrength', e)]);
}

const HIGH = calcFor(0.95, 0.05, 0.95, 0.95); // 0.95
const MEDIUM = calcFor(0.6, 0.5, 0.8, 0.7); // 0.65
const LOW = calcFor(0.1, 0.95, 0.3, 0.2); // 0.1625

// a real result with only the score replaced, to hit exact threshold values
const calcAt = (score: number): ActionSafetyResult => ({ ...calcFor(0.5, 0.5, 0.5, 0.5), safetyScore: score });

const ALL_REQUIRED: GatePolicy = {
  authorization: { required: true },
  recovery: { required: true, whenIrreversible: true },
  buildTests: { required: true },
  supportingEvidence: { required: true },
};

const GOOD: GateInput = {
  action: { identity: { id: 'act-1', type: 'database_migration', description: 'drop column' }, environment: 'production', impact: 'high', irreversible: true },
  authority: {
    actor: { id: 'alice', kind: 'human', roles: ['release-manager'] },
    authorization: { status: 'PASS', refs: ['rbac:1'] },
  },
  evidence: {
    buildTests: { status: 'PASS', refs: ['ci:1'] },
    supporting: { status: 'PASS', refs: ['review:1'] },
    recovery: { status: 'PASS', refs: ['backup:1'] },
  },
  policy: ALL_REQUIRED,
};

const gatesFor = (over: Partial<GateInput> = {}): GateEvaluation => evaluateGates({ ...GOOD, ...over });

const withoutAuthorization = () => gatesFor({ authority: { actor: GOOD.authority.actor } });
const withoutRecovery = () => gatesFor({ evidence: { ...GOOD.evidence, recovery: undefined } });
const withFailedTests = () => gatesFor({ evidence: { ...GOOD.evidence, buildTests: { status: 'FAIL' } } });
const withoutSupporting = () => gatesFor({ evidence: { ...GOOD.evidence, supporting: undefined } });

describe('decideAction: score thresholds with all gates passing', () => {
  it('high score -> ALLOW', () => {
    const r = decideAction(HIGH, gatesFor());
    expect(r.decision).toBe('ALLOW');
    expect(r.preliminaryDecision).toBe('ALLOW');
    expect(r.gatesOverrodeScore).toBe(false);
    expect(r.triggeredGates).toEqual([]);
    expect(r.reasonCodes).toEqual(['SCORE_AT_OR_ABOVE_ALLOW_THRESHOLD', 'ALL_GATES_CLEAR', 'FINAL_ALLOW']);
  });

  it('medium score -> ESCALATE', () => {
    const r = decideAction(MEDIUM, gatesFor());
    expect(r.decision).toBe('ESCALATE');
    expect(r.reasonCodes).toEqual(['SCORE_IN_ESCALATE_BAND', 'ALL_GATES_CLEAR', 'FINAL_ESCALATE']);
  });

  it('low score -> BLOCK', () => {
    const r = decideAction(LOW, gatesFor());
    expect(r.decision).toBe('BLOCK');
    expect(r.gatesOverrodeScore).toBe(false);
    expect(r.reasonCodes).toEqual(['SCORE_BELOW_ESCALATE_THRESHOLD', 'ALL_GATES_CLEAR', 'FINAL_BLOCK']);
  });

  it('exactly 0.80 -> ALLOW', () => {
    expect(decideAction(calcAt(0.8), gatesFor()).decision).toBe('ALLOW');
  });

  it('exactly 0.50 -> ESCALATE', () => {
    expect(decideAction(calcAt(0.5), gatesFor()).decision).toBe('ESCALATE');
  });

  it('treats scores just below a threshold consistently (floating-point noise vs a real difference)', () => {
    expect(decideAction(calcAt(0.8 - 1e-13), gatesFor()).decision).toBe('ALLOW'); // noise
    expect(decideAction(calcAt(0.8 - 1e-6), gatesFor()).decision).toBe('ESCALATE'); // real
    expect(decideAction(calcAt(0.5 - 1e-13), gatesFor()).decision).toBe('ESCALATE'); // noise
    expect(decideAction(calcAt(0.5 - 1e-6), gatesFor()).decision).toBe('BLOCK'); // real
    expect(decideAction(calcAt(0), gatesFor()).decision).toBe('BLOCK');
    expect(decideAction(calcAt(1), gatesFor()).decision).toBe('ALLOW');
  });

  it('uses a custom policy when given one', () => {
    const strict: DecisionPolicy = { id: 'strict', provisional: false, allowAtOrAbove: 0.99, escalateAtOrAbove: 0.9 };
    const r = decideAction(HIGH, gatesFor(), strict);
    expect(r.decision).toBe('ESCALATE');
    expect(r.thresholds).toEqual({ id: 'strict', provisional: false, allowAtOrAbove: 0.99, escalateAtOrAbove: 0.9 });
  });
});

describe('decideAction: gate precedence', () => {
  it('high score + missing authorization -> BLOCK', () => {
    const r = decideAction(HIGH, withoutAuthorization());
    expect(r.decision).toBe('BLOCK');
    expect(r.preliminaryDecision).toBe('ALLOW');
    expect(r.gatesOverrodeScore).toBe(true);
    expect(r.triggeredGates.map((g) => g.gate)).toEqual(['AUTHORIZATION']);
    expect(r.reasonCodes).toEqual([
      'SCORE_AT_OR_ABOVE_ALLOW_THRESHOLD',
      'GATE_AUTHORIZATION_FAILED',
      'GATES_OVERRODE_SCORE_DECISION',
      'FINAL_BLOCK',
    ]);
  });

  it('high score + missing verified recovery -> BLOCK', () => {
    const r = decideAction(HIGH, withoutRecovery());
    expect(r.decision).toBe('BLOCK');
    expect(r.triggeredGates.map((g) => g.gate)).toEqual(['VERIFIED_RECOVERY']);
  });

  it('high score + failed mandatory tests -> BLOCK', () => {
    const r = decideAction(HIGH, withFailedTests());
    expect(r.decision).toBe('BLOCK');
    expect(r.triggeredGates.map((g) => g.gate)).toEqual(['BUILD_TEST_RESULTS']);
  });

  it('high score + missing supporting evidence -> ESCALATE, and it is UNKNOWN, never passing', () => {
    const r = decideAction(HIGH, withoutSupporting());
    expect(r.decision).toBe('ESCALATE');
    expect(r.triggeredGates[0]).toMatchObject({ gate: 'SUPPORTING_EVIDENCE', status: 'UNKNOWN' });
    expect(r.reasonCodes).toContain('GATE_SUPPORTING_EVIDENCE_UNKNOWN');
  });

  it('with several failing gates, BLOCK takes precedence over ESCALATE', () => {
    const gates = gatesFor({
      authority: { actor: GOOD.authority.actor }, // no authorization (BLOCK)
      evidence: { ...GOOD.evidence, supporting: undefined, recovery: undefined },
    });
    const r = decideAction(HIGH, gates);
    expect(r.decision).toBe('BLOCK');
    expect(r.triggeredGates.map((g) => g.gate).sort()).toEqual(['AUTHORIZATION', 'SUPPORTING_EVIDENCE', 'VERIFIED_RECOVERY']);
    expect(r.gateConsequence).toBe('BLOCK');
    expect(r.reasonCodes).toContain('GATE_SUPPORTING_EVIDENCE_UNKNOWN');
  });

  it('an ESCALATE gate does not turn a low-score BLOCK into ESCALATE, and does not count as an override', () => {
    const r = decideAction(LOW, withoutSupporting());
    expect(r.decision).toBe('BLOCK');
    expect(r.gatesOverrodeScore).toBe(false);
    expect(r.explanation).toMatch(/did not change the decision/);
  });

  it('a blocking gate is never weakened by the score, at any score', () => {
    const blockers = [withoutAuthorization(), withoutRecovery(), withFailedTests()];
    for (let i = 0; i <= 100; i++) {
      for (const gates of blockers) expect(decideAction(calcAt(i / 100), gates).decision).toBe('BLOCK');
    }
  });

  it('an ESCALATE gate never ends in ALLOW, at any score', () => {
    const allowed: Decision[] = [];
    for (let i = 0; i <= 100; i++) {
      const r = decideAction(calcAt(i / 100), withoutSupporting()).decision;
      if (r === 'ALLOW') allowed.push(r);
    }
    expect(allowed).toEqual([]);
  });

  it('honours a policy that makes missing supporting evidence BLOCK', () => {
    const gates = gatesFor({
      policy: { ...ALL_REQUIRED, supportingEvidence: { required: true, consequence: 'BLOCK' } },
      evidence: { ...GOOD.evidence, supporting: undefined },
    });
    expect(decideAction(HIGH, gates).decision).toBe('BLOCK');
  });

  it('lists gates that were not required without treating them as triggered', () => {
    const gates = gatesFor({ policy: { ...ALL_REQUIRED, recovery: { required: false, whenIrreversible: false } }, evidence: { ...GOOD.evidence, recovery: undefined } });
    const r = decideAction(HIGH, gates);
    expect(r.decision).toBe('ALLOW');
    expect(r.explanation).toMatch(/not required by policy: VERIFIED_RECOVERY/);
  });
});

describe('decideAction: result contents and explanation', () => {
  it('reports the score, all gate results, thresholds and provisional flags', () => {
    const r = decideAction(MEDIUM, withoutSupporting());
    expect(r.safetyScore).toBeCloseTo(0.65, 12);
    expect(r.gateResults).toHaveLength(4);
    expect(r.thresholds).toEqual({ id: 'score-thresholds-provisional-v1', provisional: true, allowAtOrAbove: 0.8, escalateAtOrAbove: 0.5 });
    expect(r.scoringConfig).toEqual({ id: 'equal-weights-provisional-v1', provisional: true });
  });

  it('explains the score mapping, passed and triggered gates, the override and the final decision', () => {
    const r = decideAction(HIGH, withoutAuthorization());
    expect(r.explanation).toMatch(/Safety Score 0\.950 maps to ALLOW/);
    expect(r.explanation).toMatch(/provisional/);
    expect(r.explanation).toMatch(/Gates passed: .*BUILD_TEST_RESULTS/);
    expect(r.explanation).toMatch(/Gate AUTHORIZATION FAILED and requires BLOCK/);
    expect(r.explanation).toMatch(/changed the decision from ALLOW to BLOCK/);
    expect(r.explanation).toMatch(/Final decision: BLOCK\./);
    expect(r.explanation).toMatch(/no action was executed/);
  });

  it('exposes only a decision and never claims execution', () => {
    const r = decideAction(HIGH, gatesFor());
    expect(r.explanation).not.toMatch(/was executed successfully|deployed|rolled back/);
    expect(Object.keys(r)).not.toContain('execute');
  });
});

describe('decideAction: threshold validation', () => {
  const run = (policy: DecisionPolicy) => () => decideAction(HIGH, gatesFor(), policy);
  const policy = (allow: number, escalate: number): DecisionPolicy => ({ id: 'p', provisional: false, allowAtOrAbove: allow, escalateAtOrAbove: escalate });

  it('rejects non-finite thresholds', () => {
    expect(run(policy(Number.NaN, 0.5))).toThrow(DecisionInputError);
    expect(run(policy(0.8, Number.POSITIVE_INFINITY))).toThrow(DecisionInputError);
  });

  it('rejects thresholds outside [0, 1]', () => {
    expect(run(policy(1.1, 0.5))).toThrow(/between 0 and 1/);
    expect(run(policy(0.8, -0.1))).toThrow(/between 0 and 1/);
  });

  it('requires the escalate boundary to be strictly below the allow boundary', () => {
    expect(run(policy(0.5, 0.5))).toThrow(/strictly below/);
    expect(run(policy(0.4, 0.6))).toThrow(/strictly below/);
  });

  it('accepts the boundaries 0 and 1', () => {
    expect(run(policy(1, 0))).not.toThrow();
  });

  it('rejects a missing id or a non-boolean provisional flag', () => {
    expect(run({ ...policy(0.8, 0.5), id: '' })).toThrow(DecisionInputError);
    expect(run({ ...policy(0.8, 0.5), provisional: 'yes' as unknown as boolean })).toThrow(DecisionInputError);
  });

  it('ships a provisional default policy with the specified thresholds', () => {
    expect(DEFAULT_DECISION_POLICY).toMatchObject({ provisional: true, allowAtOrAbove: 0.8, escalateAtOrAbove: 0.5 });
  });
});

describe('decideAction: malformed or inconsistent inputs', () => {
  const badScore = (s: number): ActionSafetyResult => ({ ...HIGH, safetyScore: s });

  it('rejects an invalid Safety Score instead of clamping it', () => {
    for (const s of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.5]) {
      expect(() => decideAction(badScore(s), gatesFor())).toThrow(DecisionInputError);
    }
  });

  it('rejects a summary that hides a triggered gate (empty triggered list over a FAIL result)', () => {
    const real = withoutAuthorization();
    expect(() => decideAction(HIGH, { ...real, triggered: [], consequence: null })).toThrow(/inconsistent/);
  });

  it('rejects a summary whose consequence was weakened from BLOCK to ESCALATE or null', () => {
    const real = withoutAuthorization();
    expect(() => decideAction(HIGH, { ...real, consequence: 'ESCALATE' })).toThrow(/inconsistent/);
    expect(() => decideAction(HIGH, { ...real, consequence: null })).toThrow(/inconsistent/);
  });

  it('rejects a summary that invents a triggered gate', () => {
    const real = gatesFor();
    const invented = { ...real.results[0], status: 'FAIL' as const };
    expect(() => decideAction(HIGH, { ...real, triggered: [invented], consequence: 'BLOCK' })).toThrow(/inconsistent/);
  });

  it('rejects results that were edited to PASS while the summary still says triggered', () => {
    const real = withoutAuthorization();
    const edited = real.results.map((r) => (r.gate === 'AUTHORIZATION' ? { ...r, status: 'PASS' as const } : r));
    expect(() => decideAction(HIGH, { ...real, results: edited })).toThrow(/inconsistent/);
  });

  it('rejects missing, duplicate and unknown gates', () => {
    const real = gatesFor();
    expect(() => decideAction(HIGH, { ...real, results: real.results.slice(1) })).toThrow(/missing gate/);
    expect(() => decideAction(HIGH, { ...real, results: [...real.results, real.results[0]] })).toThrow(/more than once/);
    const unknown = { ...real.results[0], gate: 'LUCK' as unknown as typeof real.results[0]['gate'] };
    expect(() => decideAction(HIGH, { ...real, results: [unknown, ...real.results.slice(1)] })).toThrow(/unknown gate/);
  });

  it('rejects invalid gate statuses, consequences and a non-array results field', () => {
    const real = gatesFor();
    const bad = (patch: Record<string, unknown>) => ({ ...real, results: [{ ...real.results[0], ...patch }, ...real.results.slice(1)] });
    expect(() => decideAction(HIGH, bad({ status: 'MAYBE' }))).toThrow(/invalid status/);
    expect(() => decideAction(HIGH, bad({ consequence: 'ALLOW' }))).toThrow(/invalid consequence/);
    expect(() => decideAction(HIGH, bad({ evidenceRefs: 'x' }))).toThrow(/malformed/);
    expect(() => decideAction(HIGH, { ...real, results: undefined as unknown as GateEvaluation['results'] })).toThrow(DecisionInputError);
  });

  it('accepts an honest summary built directly from the gates', () => {
    expect(() => decideAction(HIGH, withoutAuthorization())).not.toThrow();
  });
});

describe('decideAction: purity', () => {
  it('gives identical output for identical inputs', () => {
    expect(decideAction(MEDIUM, withoutSupporting())).toEqual(decideAction(MEDIUM, withoutSupporting()));
  });

  it('does not mutate its inputs', () => {
    const gates = withoutAuthorization();
    const policy = { ...DEFAULT_DECISION_POLICY };
    const snapshot = JSON.stringify([HIGH, gates, policy]);
    decideAction(HIGH, gates, policy);
    expect(JSON.stringify([HIGH, gates, policy])).toBe(snapshot);
  });

  it('returns copies of gate results, so changing the output cannot change the input', () => {
    const gates = withoutAuthorization();
    const r = decideAction(HIGH, gates);
    (r.gateResults[0] as { status: string }).status = 'PASS';
    expect(gates.results[0].status).not.toBe('PASS');
  });
});
