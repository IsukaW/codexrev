import { describe, expect, it } from 'vitest';
import {
  assessReversibility,
  type ReversibilityInput,
} from '../../../src/features/action-safety/calculus/reversibility.js';
import { FactorInputError } from '../../../src/features/action-safety/calculus/scoring.js';
import type { EvidenceItem } from '../../../src/features/action-safety/model/types.js';

const NOW = '2025-01-10T12:00:00.000Z';
const FRESH = '2025-01-10T06:00:00.000Z'; // 6h old
const STALE = '2024-12-01T00:00:00.000Z'; // well past the 168h limit

const verified = (refs: string[], observedAt = FRESH): EvidenceItem => ({
  status: 'PASS',
  source: 'verified_system',
  observedAt,
  refs,
});

const PLAN: EvidenceItem = { status: 'PASS', refs: ['doc:rollback-plan'] };

function input(overrides: Partial<ReversibilityInput> = {}): ReversibilityInput {
  return {
    now: NOW,
    irreversible: false,
    rollbackPlan: PLAN,
    rollbackTest: verified(['ci:rollback-test']),
    backup: verified(['backup:snap-1']),
    ...overrides,
  };
}

describe('assessReversibility', () => {
  it('scores 1 for a reversible action with a plan, a tested rollback and a verified backup', () => {
    const a = assessReversibility(input());
    expect(a.factor).toBe('reversibility');
    expect(a.score).toBe(1);
    expect(a.missing).toEqual([]);
    expect(a.uncertain).toEqual([]);
    expect(a.adjustments).toEqual([]);
    expect(a.evidenceRefs).toEqual(['doc:rollback-plan', 'ci:rollback-test', 'backup:snap-1']);
  });

  it('does not treat a written rollback plan alone as verified recovery', () => {
    const a = assessReversibility(input({ rollbackTest: undefined, backup: undefined }));
    expect(a.score).toBeCloseTo(0.2, 6);
    expect(a.score).toBeLessThan(assessReversibility(input()).score);
    expect(a.missing).toEqual(['rollback test', 'backup']);
  });

  it('caps the score when the only recovery evidence is stale', () => {
    const a = assessReversibility(input({ rollbackTest: verified(['t'], STALE), backup: verified(['b'], STALE) }));
    expect(a.score).toBeCloseTo(0.25, 6);
    expect(a.adjustments.map((x) => x.name)).toContain('unverified recovery cap');
    expect(a.uncertain.length).toBe(2);
  });

  it('gives nothing for a PASS from a self-declared source', () => {
    const selfDeclared: EvidenceItem = { status: 'PASS', source: 'self_declared', observedAt: FRESH };
    const a = assessReversibility(input({ rollbackTest: selfDeclared, backup: selfDeclared }));
    expect(a.score).toBeCloseTo(0.2, 6); // only the plan counts
    expect(a.uncertain.join(' ')).toMatch(/not trusted/);
  });

  it('scores 0 when nothing is provided and lists everything as missing', () => {
    const a = assessReversibility({ now: NOW, irreversible: false });
    expect(a.score).toBe(0);
    expect(a.missing).toEqual(['rollback plan', 'rollback test', 'backup']);
  });

  it('lowers the score for irreversible and destructive actions even with full evidence', () => {
    const irreversible = assessReversibility(input({ irreversible: true }));
    expect(irreversible.score).toBeCloseTo(0.5, 6);
    const both = assessReversibility(input({ irreversible: true, destructive: true }));
    expect(both.score).toBeCloseTo(0.4, 6);
    expect(both.adjustments.map((x) => x.name)).toEqual(['irreversible penalty', 'destructive penalty']);
  });

  it('scores an irreversible action with no recovery evidence at 0', () => {
    expect(assessReversibility({ now: NOW, irreversible: true }).score).toBe(0);
  });

  it('treats UNKNOWN evidence as uncertain and worth almost nothing', () => {
    const a = assessReversibility(input({ rollbackTest: { status: 'UNKNOWN' }, backup: { status: 'UNKNOWN' } }));
    // raw 0.2 + 0.04 + 0.04 = 0.28, but unknown is not verified recovery, so the 0.25 cap applies
    expect(a.score).toBeCloseTo(0.25, 6);
    expect(a.adjustments.map((x) => x.name)).toEqual(['unverified recovery cap']);
    expect(a.uncertain.length).toBe(2);
    expect(a.score).toBeLessThan(assessReversibility(input()).score);
  });

  it('treats a FAILED rollback test as worth 0', () => {
    const a = assessReversibility(input({ rollbackTest: { status: 'FAIL' }, backup: undefined }));
    expect(a.score).toBeCloseTo(0.2, 6);
  });

  it('reports a conflict when the rollback test passed but no plan is recorded', () => {
    const a = assessReversibility(input({ rollbackPlan: undefined }));
    expect(a.conflicts).toEqual(['rollback test reports PASS but no rollback plan is recorded']);
  });

  it('applies the freshness boundary exactly: at the limit is fresh, one millisecond over is stale', () => {
    const limitMs = 168 * 3_600_000;
    const nowMs = Date.parse(NOW);
    const atLimit = new Date(nowMs - limitMs).toISOString();
    const over = new Date(nowMs - limitMs - 1).toISOString();
    expect(assessReversibility(input({ rollbackTest: verified(['t'], atLimit), backup: undefined })).adjustments).toEqual([]);
    expect(
      assessReversibility(input({ rollbackTest: verified(['t'], over), backup: undefined })).adjustments.map((x) => x.name),
    ).toContain('unverified recovery cap');
  });

  it('does not trust a timestamp in the future or a missing timestamp as fresh', () => {
    const future = verified(['t'], '2025-02-01T00:00:00.000Z');
    const noDate: EvidenceItem = { status: 'PASS', source: 'verified_system', refs: ['t'] };
    expect(assessReversibility(input({ rollbackTest: future, backup: undefined })).uncertain.join(' ')).toMatch(/future/);
    expect(assessReversibility(input({ rollbackTest: noDate, backup: undefined })).uncertain.join(' ')).toMatch(/timestamp/);
  });

  it('keeps the score inside [0, 1] and the breakdown adds up', () => {
    const a = assessReversibility(input());
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(a.breakdown.reduce((n, c) => n + c.contribution, 0)).toBeCloseTo(1, 6);
    expect(a.breakdown.reduce((n, c) => n + c.effectiveWeight, 0)).toBeCloseTo(1, 6);
  });

  it('direction: more verified recovery gives a higher score', () => {
    const none = assessReversibility({ now: NOW, irreversible: false }).score;
    const plan = assessReversibility(input({ rollbackTest: undefined, backup: undefined })).score;
    const planTest = assessReversibility(input({ backup: undefined })).score;
    const all = assessReversibility(input()).score;
    expect(none).toBeLessThan(plan);
    expect(plan).toBeLessThan(planTest);
    expect(planTest).toBeLessThan(all);
  });

  it('is deterministic', () => {
    expect(assessReversibility(input())).toEqual(assessReversibility(input()));
  });

  it('rejects an invalid "now" and invalid configuration', () => {
    expect(() => assessReversibility(input({ now: 'yesterday-ish' }))).toThrow(FactorInputError);
    expect(() => assessReversibility(input({ config: { weights: { rollbackPlan: -1 } } }))).toThrow(FactorInputError);
    expect(() => assessReversibility(input({ config: { irreversiblePenalty: 2 } }))).toThrow(FactorInputError);
  });

  it('honours configuration overrides', () => {
    const a = assessReversibility(input({ irreversible: true, config: { irreversiblePenalty: 0.9 } }));
    expect(a.score).toBeCloseTo(0.9, 6);
  });
});
