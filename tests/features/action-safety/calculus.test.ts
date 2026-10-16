import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALCULUS_CONFIG,
  FACTOR_IDS,
  calculateSafetyScore,
  type CalculusConfig,
} from '../../../src/features/action-safety/calculus/calculus.js';
import { constrainDecision, evaluateGates, type GateInput } from '../../../src/features/action-safety/calculus/gates.js';
import { FactorInputError } from '../../../src/features/action-safety/calculus/scoring.js';
import type { FactorAssessment, FactorId } from '../../../src/features/action-safety/model/types.js';

function stub(factor: FactorId, score: number): FactorAssessment {
  return { factor, score, explanation: 'test', evidenceRefs: [], missing: [], uncertain: [], conflicts: [], breakdown: [], adjustments: [] };
}

function assessments(r: number, b: number, a: number, e: number): FactorAssessment[] {
  return [stub('reversibility', r), stub('blastRadius', b), stub('authority', a), stub('evidenceStrength', e)];
}

const weights = (reversibility: number, blastRadius: number, authority: number, evidenceStrength: number): CalculusConfig => ({
  id: 'test-weights',
  provisional: false,
  weights: { reversibility, blastRadius, authority, evidenceStrength },
});

const score = (r: number, b: number, a: number, e: number, cfg?: CalculusConfig) =>
  calculateSafetyScore(assessments(r, b, a, e), cfg).safetyScore;

describe('calculateSafetyScore', () => {
  it('gives 1 when R, A and E are 1 and Blast Radius is 0', () => {
    expect(score(1, 0, 1, 1)).toBe(1);
  });

  it('gives 0 when R, A and E are 0 and Blast Radius is 1', () => {
    expect(score(0, 1, 0, 0)).toBe(0);
  });

  it('computes the equal-weight example: R=0.30, B=0.85, A=1.00, E=0.85 -> 0.575', () => {
    const r = calculateSafetyScore(assessments(0.3, 0.85, 1, 0.85));
    expect(r.safetyScore).toBeCloseTo(0.575, 12);
    expect(r.contributions.reversibility).toBeCloseTo(0.075, 12);
    expect(r.contributions.blastRadius).toBeCloseTo(0.0375, 12); // 0.25 * (1 - 0.85)
    expect(r.contributions.authority).toBeCloseTo(0.25, 12);
    expect(r.contributions.evidenceStrength).toBeCloseTo(0.2125, 12);
    expect(r.adjustedBlastRadius).toBeCloseTo(0.15, 12);
  });

  it('reports the four original scores, the weights, the terms and the configuration used', () => {
    const r = calculateSafetyScore(assessments(0.3, 0.85, 1, 0.85));
    expect(r.factors).toEqual({ reversibility: 0.3, blastRadius: 0.85, authority: 1, evidenceStrength: 0.85 });
    expect(r.weights).toEqual(DEFAULT_CALCULUS_CONFIG.weights);
    expect(r.terms.map((t) => t.symbol)).toEqual(['R', 'B', 'A', 'E']);
    expect(r.terms.find((t) => t.factor === 'blastRadius')).toMatchObject({ factorScore: 0.85, termValue: expect.closeTo(0.15, 12) });
    expect(r.terms.reduce((n, t) => n + t.contribution, 0)).toBeCloseTo(r.safetyScore, 12);
    expect(r.config).toEqual({ id: 'equal-weights-provisional-v1', provisional: true });
    expect(r.explanation).toMatch(/provisional/);
    expect(r.formula).toContain('(1 - B)');
  });

  it('uses equal weights of 0.25 as the provisional default', () => {
    expect(DEFAULT_CALCULUS_CONFIG.provisional).toBe(true);
    for (const id of FACTOR_IDS) expect(DEFAULT_CALCULUS_CONFIG.weights[id]).toBe(0.25);
  });

  it('changes the result correctly when weights change', () => {
    // R=1, B=1 (so 1-B=0), A=0, E=0: only the reversibility weight matters
    expect(score(1, 1, 0, 0, weights(0.7, 0.1, 0.1, 0.1))).toBeCloseTo(0.7, 12);
    // all weight on (1 - B)
    expect(score(0, 0.2, 0, 0, weights(0, 1, 0, 0))).toBeCloseTo(0.8, 12);
    // same factors, different weights, different score
    const equal = score(0.3, 0.85, 1, 0.85);
    const authorityHeavy = score(0.3, 0.85, 1, 0.85, weights(0.1, 0.1, 0.7, 0.1));
    expect(authorityHeavy).toBeCloseTo(0.1 * 0.3 + 0.1 * 0.15 + 0.7 * 1 + 0.1 * 0.85, 12);
    expect(authorityHeavy).not.toBeCloseTo(equal, 3);
  });

  it('decreases the score when Blast Radius increases and everything else is fixed', () => {
    const scores = [0, 0.25, 0.5, 0.75, 1].map((b) => score(0.6, b, 0.6, 0.6));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
  });

  it('increases the score when Reversibility, Authority or Evidence Strength increases', () => {
    expect(score(0.8, 0.5, 0.5, 0.5)).toBeGreaterThan(score(0.2, 0.5, 0.5, 0.5));
    expect(score(0.5, 0.5, 0.8, 0.5)).toBeGreaterThan(score(0.5, 0.5, 0.2, 0.5));
    expect(score(0.5, 0.5, 0.5, 0.8)).toBeGreaterThan(score(0.5, 0.5, 0.5, 0.2));
  });

  it('ignores a factor whose weight is 0', () => {
    const cfg = weights(0, 0.5, 0.25, 0.25);
    expect(score(0, 0.5, 0.5, 0.5, cfg)).toBeCloseTo(score(1, 0.5, 0.5, 0.5, cfg), 12);
  });

  it('keeps the score in [0, 1] for uneven weights and extreme inputs', () => {
    const cfg = weights(0.1, 0.2, 0.3, 0.4);
    for (const [r, b, a, e] of [[1, 0, 1, 1], [0, 1, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0]] as const) {
      const s = score(r, b, a, e, cfg);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(score(1, 0, 1, 1, cfg)).toBe(1);
  });

  it('does not round the score (only the explanation text is rounded)', () => {
    const r = calculateSafetyScore(assessments(1 / 3, 0, 1 / 7, 0.123456789));
    expect(r.safetyScore).toBeCloseTo((1 / 3 + 1 + 1 / 7 + 0.123456789) * 0.25, 14);
    expect(String(r.safetyScore).length).toBeGreaterThan(8);
  });

  describe('input validation', () => {
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['below 0', -0.01],
      ['above 1', 1.01],
    ])('rejects a factor score that is %s', (_label, bad) => {
      for (let i = 0; i < 4; i++) {
        const list = assessments(0.5, 0.5, 0.5, 0.5);
        list[i] = stub(list[i].factor, bad);
        expect(() => calculateSafetyScore(list)).toThrow(FactorInputError);
      }
    });

    it('does not clamp an out-of-range score into range', () => {
      expect(() => calculateSafetyScore(assessments(1.5, 0, 1, 1))).toThrow(/between 0 and 1/);
    });

    it('rejects a non-numeric score', () => {
      const list = assessments(0.5, 0.5, 0.5, 0.5);
      list[0] = { ...list[0], score: '0.5' as unknown as number };
      expect(() => calculateSafetyScore(list)).toThrow(FactorInputError);
    });

    it('rejects missing factors', () => {
      expect(() => calculateSafetyScore(assessments(0.5, 0.5, 0.5, 0.5).slice(0, 3))).toThrow(/missing assessment.*evidenceStrength/);
      expect(() => calculateSafetyScore([])).toThrow(/missing assessment/);
    });

    it('rejects duplicate factors, even when four assessments are given', () => {
      const list = assessments(0.5, 0.5, 0.5, 0.5);
      list[3] = stub('authority', 0.5);
      expect(() => calculateSafetyScore(list)).toThrow(/duplicate assessment for factor authority/);
    });

    it('rejects an invalid factor identifier', () => {
      const list = assessments(0.5, 0.5, 0.5, 0.5);
      list[0] = stub('luck' as unknown as FactorId, 0.5);
      expect(() => calculateSafetyScore(list)).toThrow(/unknown factor identifier/);
    });
  });

  describe('weight validation', () => {
    const run = (cfg: CalculusConfig) => () => calculateSafetyScore(assessments(0.5, 0.5, 0.5, 0.5), cfg);

    it('rejects negative weights, even if they sum to 1', () => {
      expect(run(weights(-0.1, 0.4, 0.4, 0.3))).toThrow(/must not be negative/);
    });

    it('rejects non-finite weights', () => {
      expect(run(weights(Number.NaN, 0.5, 0.25, 0.25))).toThrow(FactorInputError);
      expect(run(weights(Number.POSITIVE_INFINITY, 0, 0, 0))).toThrow(FactorInputError);
    });

    it('rejects weights that do not sum to 1', () => {
      expect(run(weights(0.25, 0.25, 0.25, 0.3))).toThrow(/sum to 1/);
      expect(run(weights(0.2, 0.2, 0.2, 0.2))).toThrow(/sum to 1/);
    });

    it('accepts floating-point noise within the tolerance (0.1 + 0.2 + 0.3 + 0.4)', () => {
      expect(run(weights(0.1, 0.2, 0.3, 0.4))).not.toThrow();
      expect(run(weights(1 / 3, 1 / 3, 1 / 3, 0))).not.toThrow();
    });

    it('rejects a missing weight and an unknown weight key', () => {
      const missing = { id: 'x', provisional: false, weights: { reversibility: 0.5, blastRadius: 0.5, authority: 0 } } as unknown as CalculusConfig;
      expect(run(missing)).toThrow(/evidenceStrength/);
      const extra = {
        id: 'x',
        provisional: false,
        weights: { reversibility: 0.25, blastRadius: 0.25, authority: 0.25, evidenceStrength: 0.25, luck: 0 },
      } as unknown as CalculusConfig;
      expect(run(extra)).toThrow(/unknown factor/);
    });
  });

  it('gives identical results for identical inputs', () => {
    expect(calculateSafetyScore(assessments(0.3, 0.85, 1, 0.85))).toEqual(calculateSafetyScore(assessments(0.3, 0.85, 1, 0.85)));
  });

  it('does not mutate its inputs', () => {
    const list = assessments(0.3, 0.85, 1, 0.85);
    const snapshot = JSON.stringify(list);
    calculateSafetyScore(list);
    expect(JSON.stringify(list)).toBe(snapshot);
  });

  it('returns a score only: no decision field', () => {
    const r = calculateSafetyScore(assessments(1, 0, 1, 1));
    expect(r).not.toHaveProperty('decision');
  });

  it('a hypothetical high score cannot alter the Critical Safety Gate results', () => {
    const gateInput: GateInput = {
      action: { identity: { id: 'a', type: 'deployment', description: 'd' }, environment: 'production', impact: 'high', irreversible: true },
      authority: { actor: { id: 'alice', kind: 'human', roles: [] } }, // no authorization recorded
      evidence: { buildTests: { status: 'FAIL' } },
      policy: {
        authorization: { required: true },
        humanApproval: { required: false },
        recovery: { required: false, whenIrreversible: false },
        buildTests: { required: true },
        supportingEvidence: { required: false },
      },
    };
    const before = evaluateGates(gateInput);
    const perfect = calculateSafetyScore(assessments(1, 0, 1, 1));
    expect(perfect.safetyScore).toBe(1);
    const after = evaluateGates(gateInput);

    expect(after).toEqual(before);
    expect(after.consequence).toBe('BLOCK');
    // even if a later decision step wanted to ALLOW because the score is perfect, the gates still win
    expect(constrainDecision('ALLOW', after)).toBe('BLOCK');
  });
});
