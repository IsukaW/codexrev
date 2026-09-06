import { describe, expect, it } from 'vitest';
import {
  ContextAggregator,
  ContextAggregatorError,
} from '../../../src/features/review-pipeline/pipeline/contextAggregator.js';
import type { ParsedDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { RoleOutput } from '../../../src/features/review-pipeline/roles/roleContract.js';

const SAMPLE_DIFF: ParsedDiff = {
  ref: 'staged',
  raw: 'diff --git a/x.ts b/x.ts\n',
  files: [{ path: 'x.ts', status: 'modified', hunks: [] }],
};

function roleOutput(role: RoleOutput['role'], verdict: RoleOutput['verdict'] = 'pass'): RoleOutput {
  return { role, verdict, findings: [], summary: `${role} summary`, confidence: 0.9 };
}

describe('ContextAggregator', () => {
  it('starts with just { diff, urs? } and no role outputs', () => {
    const agg = new ContextAggregator(SAMPLE_DIFF, 'some URS text');
    const snapshot = agg.toJSON();
    expect(snapshot.diff).toBe(SAMPLE_DIFF);
    expect(snapshot.urs).toBe('some URS text');
    expect(snapshot.roleOutputs).toEqual({});
  });

  it('omits urs entirely when not given', () => {
    const agg = new ContextAggregator(SAMPLE_DIFF);
    expect('urs' in agg.toJSON()).toBe(false);
  });

  it('produces a growing JSON object, one key per completed role, in order (Phase 4 DoD)', () => {
    const agg = new ContextAggregator(SAMPLE_DIFF);

    agg.addRoleOutput(roleOutput('ba'));
    expect(Object.keys(agg.toJSON().roleOutputs)).toEqual(['ba']);

    agg.addRoleOutput(roleOutput('dev'));
    expect(Object.keys(agg.toJSON().roleOutputs)).toEqual(['ba', 'dev']);

    agg.addRoleOutput(roleOutput('build'));
    agg.addRoleOutput(roleOutput('sec', 'block'));
    agg.addRoleOutput(roleOutput('qa'));
    agg.addRoleOutput(roleOutput('pm'));

    const finalSnapshot = agg.toJSON();
    expect(Object.keys(finalSnapshot.roleOutputs)).toEqual(['ba', 'dev', 'build', 'sec', 'qa', 'pm']);
    expect(finalSnapshot.roleOutputs.sec?.verdict).toBe('block');
    expect(agg.completedRoles).toEqual(['ba', 'dev', 'build', 'sec', 'qa', 'pm']);
  });

  it('preserves completion order even when roles run out of ROLE_ORDER', () => {
    const agg = new ContextAggregator(SAMPLE_DIFF);
    agg.addRoleOutput(roleOutput('pm'));
    agg.addRoleOutput(roleOutput('ba'));
    expect(agg.completedRoles).toEqual(['pm', 'ba']);
  });

  it('throws if the same role is added twice via addRoleOutput', () => {
    const agg = new ContextAggregator(SAMPLE_DIFF);
    agg.addRoleOutput(roleOutput('ba'));
    expect(() => agg.addRoleOutput(roleOutput('ba', 'flag'))).toThrow(ContextAggregatorError);
  });

  it('replaceRoleOutput overwrites in place without moving its position (Phase 8 re-run support)', () => {
    const agg = new ContextAggregator(SAMPLE_DIFF);
    agg.addRoleOutput(roleOutput('ba'));
    agg.addRoleOutput(roleOutput('dev'));
    agg.addRoleOutput(roleOutput('build'));

    agg.replaceRoleOutput(roleOutput('dev', 'block'));

    expect(agg.completedRoles).toEqual(['ba', 'dev', 'build']);
    expect(agg.getRoleOutput('dev')?.verdict).toBe('block');
  });

  it('hasRoleOutput / getRoleOutput reflect current state', () => {
    const agg = new ContextAggregator(SAMPLE_DIFF);
    expect(agg.hasRoleOutput('ba')).toBe(false);
    expect(agg.getRoleOutput('ba')).toBeUndefined();
    agg.addRoleOutput(roleOutput('ba'));
    expect(agg.hasRoleOutput('ba')).toBe(true);
    expect(agg.getRoleOutput('ba')?.role).toBe('ba');
  });
});
