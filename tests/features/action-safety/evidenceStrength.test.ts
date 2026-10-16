import { describe, expect, it } from 'vitest';
import {
  assessEvidenceStrength,
  type EvidenceStrengthInput,
} from '../../../src/features/action-safety/calculus/evidenceStrength.js';
import { FactorInputError } from '../../../src/features/action-safety/calculus/scoring.js';
import type { EvidenceItem } from '../../../src/features/action-safety/model/types.js';

const NOW = '2025-01-10T12:00:00.000Z';
const FRESH = '2025-01-10T06:00:00.000Z';
const STALE = '2024-12-01T00:00:00.000Z';

const pass = (ref: string, over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  status: 'PASS',
  source: 'verified_system',
  observedAt: FRESH,
  refs: [ref],
  ...over,
});

function strong(overrides: Partial<EvidenceStrengthInput> = {}): EvidenceStrengthInput {
  return {
    now: NOW,
    buildTests: { required: true, records: [pass('ci:tests')] },
    securityFindings: { required: true, records: [pass('scan:sec')] },
    dependencyCompatibility: { required: true, records: [pass('deps:compat')] },
    recoveryVerification: { required: true, records: [pass('recovery:v')] },
    ...overrides,
  };
}

const withTests = (records: EvidenceItem[] | undefined) =>
  assessEvidenceStrength(strong({ buildTests: { required: true, records } })).score;

describe('assessEvidenceStrength', () => {
  it('scores 1 when every required kind has fresh, verified, passing evidence', () => {
    const a = assessEvidenceStrength(strong());
    expect(a.factor).toBe('evidenceStrength');
    expect(a.score).toBe(1);
    expect(a.missing).toEqual([]);
    expect(a.uncertain).toEqual([]);
    expect(a.evidenceRefs).toEqual(['ci:tests', 'scan:sec', 'deps:compat', 'recovery:v']);
  });

  it('scores lower and reports missing evidence when a required kind has no records', () => {
    const a = assessEvidenceStrength(strong({ securityFindings: { required: true } }));
    expect(a.score).toBeCloseTo(0.3 + 0.1 + 0.2 + 0.2 * 0.75, 6);
    expect(a.missing).toEqual(['security findings']);
  });

  it('caps the score when mandatory tests failed, even if everything else is perfect', () => {
    const a = assessEvidenceStrength(strong({ buildTests: { required: true, records: [{ status: 'FAIL', refs: ['ci:fail'] }] } }));
    expect(a.score).toBeLessThanOrEqual(0.3);
    expect(a.adjustments.map((x) => x.name)).toEqual(['failed or conflicting evidence cap']);
  });

  it('treats conflicting pass and fail records as a conflict and scores that kind 0', () => {
    const a = assessEvidenceStrength(
      strong({ buildTests: { required: true, records: [pass('ci:a'), { status: 'FAIL', refs: ['ci:b'] }] } }),
    );
    expect(a.conflicts).toEqual(['build/test results: records both pass and fail']);
    expect(a.score).toBeLessThanOrEqual(0.3);
  });

  it('scores unknown evidence below verified evidence and flags it uncertain', () => {
    const a = assessEvidenceStrength(strong({ buildTests: { required: true, records: [{ status: 'UNKNOWN' }] } }));
    expect(a.score).toBeCloseTo(0.03 + 0.7, 6);
    expect(a.uncertain.join(' ')).toMatch(/unknown/);
  });

  it('scores stale evidence below fresh evidence', () => {
    const a = assessEvidenceStrength(strong({ buildTests: { required: true, records: [pass('ci:old', { observedAt: STALE })] } }));
    expect(a.score).toBeCloseTo(0.85, 6);
    expect(a.uncertain.join(' ')).toMatch(/older than/);
  });

  it('gives no credit to a pass from an untrusted (self-declared) source', () => {
    const a = assessEvidenceStrength(strong({ buildTests: { required: true, records: [pass('ci:x', { source: 'self_declared' })] } }));
    expect(a.score).toBeCloseTo(0.7, 6);
    expect(a.uncertain.join(' ')).toMatch(/not trusted/);
  });

  it('direction: verified > stale > unknown, and failed, missing or untrusted are all below verified', () => {
    const verified = withTests([pass('a')]);
    const stale = withTests([pass('a', { observedAt: STALE })]);
    const unknown = withTests([{ status: 'UNKNOWN' }]);
    expect(verified).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(unknown);
    for (const worse of [withTests([{ status: 'FAIL' }]), withTests(undefined), withTests([pass('a', { source: 'self_declared' })])]) {
      expect(worse).toBeLessThan(verified);
    }
    expect(unknown).toBeGreaterThan(withTests([{ status: 'FAIL' }]));
  });

  it('uses the weakest record when a kind has several', () => {
    const a = assessEvidenceStrength(
      strong({ buildTests: { required: true, records: [pass('ci:1'), pass('ci:2', { observedAt: STALE })] } }),
    );
    expect(a.breakdown.find((c) => c.name === 'build/test results')!.value).toBeCloseTo(0.5, 6);
  });

  it('leaves out kinds that are not required and not provided, rather than scoring them 0', () => {
    const a = assessEvidenceStrength({ now: NOW, buildTests: { required: true, records: [pass('ci')] } });
    expect(a.score).toBe(1);
    expect(a.breakdown.filter((c) => c.applied).map((c) => c.name)).toEqual(['build/test results', 'completeness']);
  });

  it('still scores an optional kind that happens to be provided', () => {
    const a = assessEvidenceStrength({
      now: NOW,
      buildTests: { required: true, records: [pass('ci')] },
      securityFindings: { required: false, records: [{ status: 'FAIL' }] },
    });
    expect(a.score).toBeLessThanOrEqual(0.3);
  });

  it('never invents evidence: nothing required and nothing provided scores 0', () => {
    const a = assessEvidenceStrength({ now: NOW });
    expect(a.score).toBe(0);
    expect(a.missing).toEqual(['any evidence at all']);
  });

  it('does not accept NOT_APPLICABLE records for required evidence', () => {
    const a = assessEvidenceStrength(strong({ buildTests: { required: true, records: [{ status: 'NOT_APPLICABLE' }] } }));
    expect(a.uncertain.join(' ')).toMatch(/NOT_APPLICABLE/);
    expect(a.score).toBeLessThan(1);
  });

  it('applies the freshness boundary exactly (24h for build/test results)', () => {
    const nowMs = Date.parse(NOW);
    const limit = 24 * 3_600_000;
    const at = withTests([pass('a', { observedAt: new Date(nowMs - limit).toISOString() })]);
    const over = withTests([pass('a', { observedAt: new Date(nowMs - limit - 1).toISOString() })]);
    expect(at).toBe(1);
    expect(over).toBeLessThan(1);
  });

  it('keeps the score inside [0, 1] with a breakdown that adds up', () => {
    for (const inp of [strong(), { now: NOW }, strong({ buildTests: { required: true, records: [{ status: 'FAIL' as const }] } })]) {
      const a = assessEvidenceStrength(inp);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(1);
    }
    const sum = assessEvidenceStrength(strong()).breakdown.reduce((n, c) => n + c.effectiveWeight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('is deterministic', () => {
    expect(assessEvidenceStrength(strong())).toEqual(assessEvidenceStrength(strong()));
  });

  it('rejects invalid configuration and input', () => {
    expect(() => assessEvidenceStrength(strong({ config: { failedEvidenceCap: 2 } }))).toThrow(FactorInputError);
    expect(() => assessEvidenceStrength(strong({ now: 'x' }))).toThrow(FactorInputError);
  });
});
