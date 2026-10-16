import { describe, expect, it } from 'vitest';
import { assessBlastRadius, type BlastRadiusInput } from '../../../src/features/action-safety/calculus/blastRadius.js';
import { FactorInputError } from '../../../src/features/action-safety/calculus/scoring.js';

const ISOLATED_DEV: BlastRadiusInput = {
  environment: 'development',
  affectedFileCount: 2,
  affectedModuleCount: 1,
  criticality: 'low',
  sharedModulesModified: 0,
  dependencyReach: 0,
  affectedServiceCount: 1,
  scope: 'local',
  evidenceRefs: ['analysis:impact-1'],
};

const PROD_INFRA: BlastRadiusInput = {
  environment: 'production',
  affectedFileCount: 100,
  affectedModuleCount: 20,
  criticality: 'critical',
  sharedModulesModified: 5,
  dependencyReach: 50,
  affectedServiceCount: 10,
  scope: 'infrastructure_wide',
};

const filesComponent = (n: number) =>
  assessBlastRadius({ ...ISOLATED_DEV, affectedFileCount: n }).breakdown.find((c) => c.name === 'affected files')!;

describe('assessBlastRadius', () => {
  it('scores a production-wide critical infrastructure change higher than an isolated development change', () => {
    const dev = assessBlastRadius(ISOLATED_DEV);
    const prod = assessBlastRadius(PROD_INFRA);
    expect(dev.factor).toBe('blastRadius');
    expect(prod.score).toBeGreaterThan(dev.score);
    expect(dev.score).toBeLessThan(0.15);
    expect(prod.score).toBe(1);
  });

  it('passes evidence references through', () => {
    expect(assessBlastRadius(ISOLATED_DEV).evidenceRefs).toEqual(['analysis:impact-1']);
  });

  it('direction: riskier environments score higher, all else equal', () => {
    const score = (environment: BlastRadiusInput['environment']) => assessBlastRadius({ ...ISOLATED_DEV, environment }).score;
    expect(score('development')).toBeLessThan(score('testing'));
    expect(score('testing')).toBeLessThan(score('staging'));
    expect(score('staging')).toBeLessThan(score('production'));
  });

  it('direction: more files, shared modules, services and criticality raise the score', () => {
    const base = assessBlastRadius(ISOLATED_DEV).score;
    expect(assessBlastRadius({ ...ISOLATED_DEV, affectedFileCount: 30 }).score).toBeGreaterThan(base);
    expect(assessBlastRadius({ ...ISOLATED_DEV, sharedModulesModified: 3 }).score).toBeGreaterThan(base);
    expect(assessBlastRadius({ ...ISOLATED_DEV, affectedServiceCount: 4, scope: 'service' }).score).toBeGreaterThan(base);
    expect(assessBlastRadius({ ...ISOLATED_DEV, criticality: 'critical' }).score).toBeGreaterThan(base);
  });

  it('does not assume missing dimensions are small: they get the unknown-risk value and are reported missing', () => {
    const a = assessBlastRadius({ environment: 'development' });
    expect(a.missing).toHaveLength(7);
    expect(a.score).toBeCloseTo(0.25 * 0.05 + 0.75 * 0.7, 6);
    expect(a.score).toBeGreaterThan(assessBlastRadius(ISOLATED_DEV).score);
  });

  it('applies a floor to database-wide changes however small everything else is', () => {
    const a = assessBlastRadius({ ...ISOLATED_DEV, scope: 'database_wide' });
    expect(a.score).toBe(0.7);
    expect(a.adjustments.map((x) => x.name)).toEqual(['database-wide floor']);
  });

  it('applies a floor to infrastructure-wide and to critical-in-production changes', () => {
    expect(assessBlastRadius({ ...ISOLATED_DEV, scope: 'infrastructure_wide' }).score).toBeGreaterThanOrEqual(0.8);
    const crit = assessBlastRadius({ ...ISOLATED_DEV, environment: 'production', criticality: 'critical' });
    expect(crit.score).toBeGreaterThanOrEqual(0.8);
    expect(crit.adjustments.map((x) => x.name)).toContain('critical-in-production floor');
  });

  it('handles boundary counts: 0, just under saturation, exactly at it, and far above it', () => {
    expect(filesComponent(0).value).toBe(0);
    expect(filesComponent(49).value).toBeLessThan(1);
    expect(filesComponent(50).value).toBe(1);
    expect(filesComponent(5000).value).toBe(1);
  });

  it('rejects negative, NaN and infinite counts', () => {
    expect(() => assessBlastRadius({ ...ISOLATED_DEV, affectedFileCount: -1 })).toThrow(FactorInputError);
    expect(() => assessBlastRadius({ ...ISOLATED_DEV, affectedModuleCount: Number.NaN })).toThrow(FactorInputError);
    expect(() => assessBlastRadius({ ...ISOLATED_DEV, dependencyReach: Number.POSITIVE_INFINITY })).toThrow(FactorInputError);
  });

  it('flags a conflict when scope says local but several services are affected', () => {
    const a = assessBlastRadius({ ...ISOLATED_DEV, scope: 'local', affectedServiceCount: 3 });
    expect(a.conflicts).toEqual(['scope is "local" but 3 services are affected']);
  });

  it('keeps the score inside [0, 1] and shows a breakdown that adds up', () => {
    for (const inp of [ISOLATED_DEV, PROD_INFRA, { environment: 'staging' as const }]) {
      const a = assessBlastRadius(inp);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(1);
      expect(a.breakdown.reduce((n, c) => n + c.effectiveWeight, 0)).toBeCloseTo(1, 6);
    }
  });

  it('honours configuration overrides', () => {
    const a = assessBlastRadius({ ...ISOLATED_DEV, config: { environmentRisk: { development: 1 } } });
    expect(a.score).toBeGreaterThan(assessBlastRadius(ISOLATED_DEV).score);
  });

  it('rejects invalid configuration', () => {
    expect(() => assessBlastRadius({ ...ISOLATED_DEV, config: { unknownRisk: 3 } })).toThrow(FactorInputError);
    expect(() => assessBlastRadius({ ...ISOLATED_DEV, config: { weights: { environment: -1 } } })).toThrow(FactorInputError);
  });

  it('is deterministic', () => {
    expect(assessBlastRadius(PROD_INFRA)).toEqual(assessBlastRadius(PROD_INFRA));
  });
});
