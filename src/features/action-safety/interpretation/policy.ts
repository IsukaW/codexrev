/**
 * What an unavailable or invalid interpretation means for the final decision.
 *
 * Interpretation is advisory, but an assessment policy can say it is
 * MANDATORY. When it is, anything other than a COMPLETED interpretation
 * prevents ALLOW: the decision is raised to at least the configured fallback
 * (ESCALATE or BLOCK). Like the Critical Safety Gates, this can only make a
 * decision stricter, never looser, and a COMPLETED interpretation never makes
 * one looser either (its observations carry no weight in any decision).
 *
 * This is a pure helper for the future full pipeline. It is not wired into the
 * CLI yet, because that pipeline does not produce a decision yet.
 */

import { CodexrevError } from '../../../utils/errors.js';
import type { Decision } from '../model/types.js';
import type { ContextInterpretation } from './types.js';

export class InterpretationPolicyError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_ACTION_SAFETY_INTERPRETATION_POLICY_ERROR', false);
    this.name = 'InterpretationPolicyError';
  }
}

export interface InterpretationPolicy {
  /** when true, a missing or unusable interpretation prevents ALLOW */
  readonly mandatory: boolean;
  /** the least strict decision allowed while interpretation is missing or unusable */
  readonly onFailure: 'ESCALATE' | 'BLOCK';
}

/** Interpretation is advisory unless a policy says otherwise. */
export const DEFAULT_INTERPRETATION_POLICY: InterpretationPolicy = { mandatory: false, onFailure: 'ESCALATE' };

const STRICTNESS: Readonly<Record<Decision, number>> = { ALLOW: 0, ESCALATE: 1, BLOCK: 2 };

export interface InterpretationConstraint {
  readonly decision: Decision;
  /** true if the interpretation status made the decision stricter */
  readonly changed: boolean;
  readonly reason?: string;
}

export function constrainDecisionByInterpretation(
  decision: Decision,
  interpretation: Pick<ContextInterpretation, 'status' | 'reason'>,
  policy: InterpretationPolicy = DEFAULT_INTERPRETATION_POLICY,
): InterpretationConstraint {
  if (policy.onFailure !== 'ESCALATE' && policy.onFailure !== 'BLOCK') {
    throw new InterpretationPolicyError(`interpretation policy onFailure must be ESCALATE or BLOCK (got ${JSON.stringify(policy.onFailure)})`);
  }
  if (!policy.mandatory || interpretation.status === 'COMPLETED') return { decision, changed: false };
  if (STRICTNESS[decision] >= STRICTNESS[policy.onFailure]) {
    return { decision, changed: false, reason: `interpretation is mandatory and ${interpretation.status}, but the decision was already ${decision}` };
  }
  return {
    decision: policy.onFailure,
    changed: true,
    reason: `interpretation is mandatory but ${interpretation.status}${interpretation.reason ? ` (${interpretation.reason})` : ''}, so ALLOW is not permitted`,
  };
}
