import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERPRETATION_POLICY,
  InterpretationPolicyError,
  constrainDecisionByInterpretation,
  type InterpretationPolicy,
} from '../../../../src/features/action-safety/interpretation/policy.js';
import type { ContextInterpretation } from '../../../../src/features/action-safety/interpretation/types.js';
import type { Decision } from '../../../../src/features/action-safety/model/types.js';

const status = (s: ContextInterpretation['status'], reason?: string) => ({ status: s, ...(reason ? { reason } : {}) });
const MANDATORY_ESCALATE: InterpretationPolicy = { mandatory: true, onFailure: 'ESCALATE' };
const MANDATORY_BLOCK: InterpretationPolicy = { mandatory: true, onFailure: 'BLOCK' };

describe('constrainDecisionByInterpretation', () => {
  it('is advisory by default: a missing interpretation changes nothing', () => {
    for (const s of ['UNAVAILABLE', 'INVALID_RESPONSE', 'ERROR'] as const) {
      expect(constrainDecisionByInterpretation('ALLOW', status(s))).toEqual({ decision: 'ALLOW', changed: false });
    }
    expect(DEFAULT_INTERPRETATION_POLICY.mandatory).toBe(false);
  });

  it('when mandatory, any status other than COMPLETED prevents ALLOW', () => {
    for (const s of ['UNAVAILABLE', 'INVALID_RESPONSE', 'ERROR'] as const) {
      const r = constrainDecisionByInterpretation('ALLOW', status(s, 'model down'), MANDATORY_ESCALATE);
      expect(r.decision, s).toBe('ESCALATE');
      expect(r.changed).toBe(true);
      expect(r.reason).toMatch(/mandatory but .*model down.*ALLOW is not permitted/);
    }
  });

  it('can be configured to BLOCK instead of ESCALATE', () => {
    expect(constrainDecisionByInterpretation('ALLOW', status('UNAVAILABLE'), MANDATORY_BLOCK).decision).toBe('BLOCK');
    expect(constrainDecisionByInterpretation('ESCALATE', status('ERROR'), MANDATORY_BLOCK).decision).toBe('BLOCK');
  });

  it('only ever makes a decision stricter, never looser', () => {
    const order: Decision[] = ['ALLOW', 'ESCALATE', 'BLOCK'];
    for (const d of order) {
      for (const policy of [MANDATORY_ESCALATE, MANDATORY_BLOCK, DEFAULT_INTERPRETATION_POLICY]) {
        for (const s of ['COMPLETED', 'UNAVAILABLE', 'INVALID_RESPONSE', 'ERROR'] as const) {
          const r = constrainDecisionByInterpretation(d, status(s), policy);
          expect(order.indexOf(r.decision)).toBeGreaterThanOrEqual(order.indexOf(d));
        }
      }
    }
    expect(constrainDecisionByInterpretation('BLOCK', status('UNAVAILABLE'), MANDATORY_ESCALATE)).toMatchObject({ decision: 'BLOCK', changed: false });
  });

  it('a COMPLETED interpretation never changes a decision, in either direction', () => {
    for (const d of ['ALLOW', 'ESCALATE', 'BLOCK'] as const) {
      expect(constrainDecisionByInterpretation(d, status('COMPLETED'), MANDATORY_BLOCK)).toEqual({ decision: d, changed: false });
    }
  });

  it('rejects an invalid policy', () => {
    expect(() => constrainDecisionByInterpretation('ALLOW', status('ERROR'), { mandatory: true, onFailure: 'ALLOW' as never })).toThrow(InterpretationPolicyError);
  });
});
