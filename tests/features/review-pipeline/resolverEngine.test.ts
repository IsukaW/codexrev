import { describe, expect, it } from 'vitest';
import { exitCodeForDecision, resolve, roleRiskScore } from '../../../src/features/review-pipeline/pipeline/resolverEngine.js';
import { DEFAULT_SETTINGS } from '../../../src/config/schema.js';
import type { Finding, RoleId, RoleOutput } from '../../../src/features/review-pipeline/roles/roleContract.js';

const WEIGHTS = DEFAULT_SETTINGS.reviewPipeline.resolverWeights; // ba .2, architect .3, dev .3, qa .15, pm .05, buildFailure .4

// Confidence defaults to 1 here so weight-math tests use clean, exact
// numbers — confidence-scaling itself gets its own dedicated tests below.
function role(role: RoleId, verdict: RoleOutput['verdict'], findings: Finding[] = [], confidence = 1): RoleOutput {
  return { role, verdict, findings, summary: `${role} summary`, confidence };
}

function allPass(): Readonly<Partial<Record<RoleId, RoleOutput>>> {
  return {
    ba: role('ba', 'pass'),
    architect: role('architect', 'pass'),
    dev: role('dev', 'pass'),
    build: role('build', 'pass'),
    qa: role('qa', 'pass'),
    pm: role('pm', 'pass'),
  };
}

describe('resolverEngine — weighted scoring (full confidence, no findings)', () => {
  it('all pass → score 0, decision approve', () => {
    const result = resolve(allPass(), WEIGHTS);
    expect(result.score).toBe(0);
    expect(result.decision).toBe('approve');
    expect(result.missingRoles).toEqual([]);
  });

  it('a single low-weight flag stays under the Request Changes threshold', () => {
    // pm weight 0.05, verdict 'flag' → score 0.5 * 0.05 = 0.025
    const roles = { ...allPass(), pm: role('pm', 'flag') };
    const result = resolve(roles, WEIGHTS);
    expect(result.score).toBeCloseTo(0.025, 5);
    expect(result.decision).toBe('approve');
  });

  it('dev blocking alone (weight 0.3) lands in Request Changes', () => {
    const roles = { ...allPass(), dev: role('dev', 'block') };
    const result = resolve(roles, WEIGHTS);
    expect(result.score).toBeCloseTo(0.3, 5);
    expect(result.decision).toBe('request_changes');
  });

  it('dev + ba both blocking (0.3 + 0.2 = 0.5) still Request Changes, not yet Block', () => {
    const roles = { ...allPass(), dev: role('dev', 'block'), ba: role('ba', 'block') };
    const result = resolve(roles, WEIGHTS);
    expect(result.score).toBeCloseTo(0.5, 5);
    expect(result.decision).toBe('request_changes');
  });

  it('dev + ba + qa all blocking (0.3+0.2+0.15=0.65) crosses into Block', () => {
    const roles = { ...allPass(), dev: role('dev', 'block'), ba: role('ba', 'block'), qa: role('qa', 'block') };
    const result = resolve(roles, WEIGHTS);
    expect(result.score).toBeCloseTo(0.65, 5);
    expect(result.decision).toBe('block');
  });

  it('a Build failure (verdict block) adds the buildFailure weight (0.4) on top of the base score', () => {
    const roles = { ...allPass(), build: role('build', 'block', [
      { id: 'build-1', severity: 'high', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'tsc error' },
    ]) };
    const result = resolve(roles, WEIGHTS);
    expect(result.score).toBeCloseTo(0.4, 5);
    expect(result.perRoleContribution.build).toBeCloseTo(0.4, 5);
  });

  it('a Build "flag" (environment issue, not a real failure) contributes nothing to the score', () => {
    const roles = { ...allPass(), build: role('build', 'flag', [
      { id: 'build-1', severity: 'medium', file: 'tsconfig.json', lineStart: 1, lineEnd: 1, description: 'could not run tsc' },
    ]) };
    const result = resolve(roles, WEIGHTS);
    expect(result.score).toBe(0);
    expect(result.decision).toBe('approve');
  });

  it('score is clamped to 1 even when base score + build failure exceed it', () => {
    const roles = {
      ...allPass(),
      ba: role('ba', 'block'),
      architect: role('architect', 'block'),
      dev: role('dev', 'block'),
      qa: role('qa', 'block'),
      pm: role('pm', 'block'),
      build: role('build', 'block'),
    };
    const result = resolve(roles, WEIGHTS);
    expect(result.score).toBe(1);
    expect(result.decision).toBe('block');
  });
});

describe('roleRiskScore — the redesigned per-role formula', () => {
  it('a bare verdict with no findings scores exactly the verdict value, at full confidence', () => {
    expect(roleRiskScore(role('dev', 'pass'))).toBe(0);
    expect(roleRiskScore(role('dev', 'flag'))).toBe(0.5);
    expect(roleRiskScore(role('dev', 'block'))).toBe(1);
  });

  it('confidence scales the score down — a shaky verdict swings the decision less than a certain one', () => {
    expect(roleRiskScore(role('dev', 'block', [], 1))).toBe(1);
    expect(roleRiskScore(role('dev', 'block', [], 0.5))).toBeCloseTo(0.5, 5);
    expect(roleRiskScore(role('dev', 'block', [], 0.1))).toBeCloseTo(0.1, 5);
  });

  it("a severe finding overrides an under-called verdict — the old formula couldn't see this at all", () => {
    // Old formula: verdict 'flag' always scored 0.5, no matter what the
    // finding said. New formula: a 'critical' finding wins via max().
    const output = role('architect', 'flag', [
      { id: 'arch-1', severity: 'critical', file: 'db.ts', lineStart: 1, lineEnd: 1, description: 'Database connection is acquired but never released, leaking a connection on every call.' },
    ]);
    expect(roleRiskScore(output)).toBe(1); // max(0.5 verdict, 1.0 severity) * 1 confidence
  });

  it("the role's own verdict still wins when it's more severe than its cited findings", () => {
    // A role that verdicts 'block' but only cites a 'low'-severity finding
    // (e.g. its concern isn't fully captured by one finding's label) still
    // scores as a block — the verdict is a floor, not overridden downward.
    const output = role('dev', 'block', [{ id: 'dev-1', severity: 'low', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'x' }]);
    expect(roleRiskScore(output)).toBe(1); // max(1.0 verdict, 0.25 severity)
  });

  it('multiple findings add a small, capped bonus beyond the worst one', () => {
    const oneFinding = role('qa', 'flag', [{ id: 'qa-1', severity: 'medium', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'a' }]);
    const fiveFindings = role('qa', 'flag', [
      { id: 'qa-1', severity: 'medium', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'a' },
      { id: 'qa-2', severity: 'medium', file: 'x.ts', lineStart: 2, lineEnd: 2, description: 'b' },
      { id: 'qa-3', severity: 'medium', file: 'x.ts', lineStart: 3, lineEnd: 3, description: 'c' },
      { id: 'qa-4', severity: 'medium', file: 'x.ts', lineStart: 4, lineEnd: 4, description: 'd' },
      { id: 'qa-5', severity: 'medium', file: 'x.ts', lineStart: 5, lineEnd: 5, description: 'e' },
    ]);
    const scoreOne = roleRiskScore(oneFinding);
    const scoreFive = roleRiskScore(fiveFindings);
    expect(scoreFive).toBeGreaterThan(scoreOne);
    expect(scoreFive - scoreOne).toBeLessThanOrEqual(0.15); // capped bonus, not proportional to count
  });

  it('a full-confidence critical block cannot exceed 1 regardless of extra findings', () => {
    const output = role('architect', 'block', [
      { id: 'arch-1', severity: 'critical', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'a' },
      { id: 'arch-2', severity: 'critical', file: 'x.ts', lineStart: 2, lineEnd: 2, description: 'b' },
      { id: 'arch-3', severity: 'critical', file: 'x.ts', lineStart: 3, lineEnd: 3, description: 'c' },
    ]);
    expect(roleRiskScore(output)).toBe(1);
  });
});

describe('resolverEngine — a severe finding drives the overall score even under a soft verdict', () => {
  it('a low-confidence "flag" citing a critical finding still contributes meaningfully (severity overrides the verdict-only view)', () => {
    // Architect verdicts only 'flag' (soft) but the finding itself is
    // 'critical' — under the OLD formula this contributed just
    // weight*0.5 regardless. Under the new formula, severity wins:
    // weight * 1.0 * confidence.
    const roles = { ...allPass(), architect: role('architect', 'flag', [
      { id: 'arch-1', severity: 'critical', file: 'db.ts', lineStart: 1, lineEnd: 1, description: 'Database connection is acquired but never released, leaking a connection on every call.' },
    ], 0.8) };
    const result = resolve(roles, WEIGHTS);
    // weight .3 * max(0.5, 1.0) * 0.8 confidence = 0.24
    expect(result.perRoleContribution.architect).toBeCloseTo(0.24, 5);
  });
});

describe('resolverEngine — conflict rule: Architect always wins on architectural integrity', () => {
  it('forces Block even when the weighted score alone would only be Request Changes or Approve', () => {
    // Architect alone blocking contributes 0.3 to the score (Request
    // Changes range), but the veto rule must force it to Block outright
    // regardless of the number.
    const roles = { ...allPass(), architect: role('architect', 'block', [
      { id: 'arch-1', severity: 'critical', file: 'db.ts', lineStart: 1, lineEnd: 1, description: 'Database connection is acquired but never released, leaking a connection on every call.' },
    ]) };
    const result = resolve(roles, WEIGHTS);
    expect(result.decision).toBe('block');
    expect(result.appliedRules.some((r) => r.rule === 'architect-integrity-veto')).toBe(true);
  });

  it('does not fire when Architect only flags (not blocks)', () => {
    const roles = { ...allPass(), architect: role('architect', 'flag') };
    const result = resolve(roles, WEIGHTS);
    expect(result.appliedRules.some((r) => r.rule === 'architect-integrity-veto')).toBe(false);
  });
});

describe('resolverEngine — conflict rule: BA + QA same issue → severity+1', () => {
  it('bumps both findings\' severity when BA and QA overlap on file + line range', () => {
    const roles = {
      ...allPass(),
      ba: role('ba', 'flag', [
        { id: 'ba-1', severity: 'medium', file: 'app.ts', lineStart: 10, lineEnd: 12, description: 'behavioral drift' },
      ]),
      qa: role('qa', 'flag', [
        { id: 'qa-1', severity: 'medium', file: 'app.ts', lineStart: 11, lineEnd: 11, description: 'missing test' },
      ]),
    };
    const result = resolve(roles, WEIGHTS);
    const rule = result.appliedRules.find((r) => r.rule === 'ba-qa-overlap-severity-bump');
    expect(rule).toBeDefined();
    expect(rule?.affectedFindingIds).toEqual(expect.arrayContaining(['ba:ba-1', 'qa:qa-1']));

    const baFinding = result.resolvedFindings.find((f) => f.role === 'ba' && f.id === 'ba-1');
    const qaFinding = result.resolvedFindings.find((f) => f.role === 'qa' && f.id === 'qa-1');
    expect(baFinding?.severity).toBe('high'); // bumped from medium
    expect(baFinding?.originalSeverity).toBe('medium');
    expect(qaFinding?.severity).toBe('high');
  });

  it('does not bump findings on different files or non-overlapping lines', () => {
    const roles = {
      ...allPass(),
      ba: role('ba', 'flag', [{ id: 'ba-1', severity: 'medium', file: 'app.ts', lineStart: 10, lineEnd: 12, description: 'x' }]),
      qa: role('qa', 'flag', [{ id: 'qa-1', severity: 'medium', file: 'other.ts', lineStart: 11, lineEnd: 11, description: 'y' }]),
    };
    const result = resolve(roles, WEIGHTS);
    expect(result.appliedRules.some((r) => r.rule === 'ba-qa-overlap-severity-bump')).toBe(false);
    expect(result.resolvedFindings.find((f) => f.id === 'ba-1')?.originalSeverity).toBeUndefined();
  });

  it('a bump that reaches "critical" raises the decision floor to at least Request Changes', () => {
    const roles = {
      ...allPass(),
      ba: role('ba', 'flag', [{ id: 'ba-1', severity: 'high', file: 'app.ts', lineStart: 5, lineEnd: 5, description: 'x' }]),
      qa: role('qa', 'flag', [{ id: 'qa-1', severity: 'high', file: 'app.ts', lineStart: 5, lineEnd: 5, description: 'y' }]),
    };
    const result = resolve(roles, WEIGHTS);
    expect(result.decision).toBe('request_changes');
  });

  it('includes every role\'s findings in resolvedFindings, tagged with their role, even when unaffected', () => {
    const roles = { ...allPass(), dev: role('dev', 'flag', [{ id: 'dev-1', severity: 'low', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'nit' }]) };
    const result = resolve(roles, WEIGHTS);
    const devFinding = result.resolvedFindings.find((f) => f.id === 'dev-1');
    expect(devFinding?.role).toBe('dev');
    expect(devFinding?.originalSeverity).toBeUndefined();
  });
});

describe('resolverEngine — partial runs (Skip/Abort/error)', () => {
  it('missing roles contribute 0 and are listed in missingRoles', () => {
    const roles: Readonly<Partial<Record<RoleId, RoleOutput>>> = { ba: role('ba', 'pass'), dev: role('dev', 'pass') };
    const result = resolve(roles, WEIGHTS);
    expect(result.missingRoles).toEqual(['architect', 'build', 'qa', 'pm']);
    expect(result.rationale).toMatch(/partial run/i);
  });

  it('resolves cleanly (does not throw) on a completely empty role set', () => {
    const result = resolve({}, WEIGHTS);
    expect(result.decision).toBe('approve');
    expect(result.missingRoles).toHaveLength(6);
  });
});

describe('exitCodeForDecision', () => {
  it('approve → 0', () => {
    expect(exitCodeForDecision('approve')).toBe(0);
  });
  it('request_changes → 1 (per the logged Phase 6 decision)', () => {
    expect(exitCodeForDecision('request_changes')).toBe(1);
  });
  it('block → 1', () => {
    expect(exitCodeForDecision('block')).toBe(1);
  });
});
