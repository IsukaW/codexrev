/**
 * Exit codes for `codexrev safety`. Documented here once, used everywhere.
 *
 *   0   completed assessment, final decision ALLOW   (the ONLY approval-equivalent code)
 *   1   invalid input: unreadable or malformed --input file, unusable --diff,
 *       or an unusable policy/request found while assessing
 *   2   usage error: missing or unknown arguments or subcommand
 *   3   incomplete: the assessment could not be completed as the policy requires
 *       (a MANDATORY local-model interpretation was unavailable or invalid), or the
 *       subcommand is not implemented yet (verify, history). Never 0.
 *   4   internal error: an unexpected failure while assessing. Never 0.
 *   10  completed assessment, final decision ESCALATE (a human must decide)
 *   11  completed assessment, final decision BLOCK
 *
 * Why not the review command's 0/1/2 (approve / block / escalate)? In Feature 4
 * 1 and 2 already mean "invalid input" and "usage error", and a completed BLOCK
 * must never be confusable with bad input, so decisions get their own range.
 * Other features' exit codes are untouched.
 */

import type { AssessmentOutcome } from '../pipeline/assessmentCoordinator.js';

export const SAFETY_EXIT_CODES = {
  allow: 0,
  invalidInput: 1,
  usage: 2,
  incomplete: 3,
  /** verify / history: the capability does not exist yet. Same value as `incomplete`, on purpose: also never 0. */
  notImplemented: 3,
  internalError: 4,
  escalate: 10,
  block: 11,
} as const;

/** Maps an assessment outcome to a process exit code. Only a COMPLETED ALLOW can return 0. */
export function exitCodeForOutcome(outcome: AssessmentOutcome): number {
  if (outcome.status === 'FAILED') {
    return outcome.failureKind === 'invalid_input' ? SAFETY_EXIT_CODES.invalidInput : SAFETY_EXIT_CODES.internalError;
  }
  if (outcome.status === 'INCOMPLETE_INTERPRETATION') return SAFETY_EXIT_CODES.incomplete;
  switch (outcome.finalDecision) {
    case 'ALLOW':
      return SAFETY_EXIT_CODES.allow;
    case 'ESCALATE':
      return SAFETY_EXIT_CODES.escalate;
    case 'BLOCK':
      return SAFETY_EXIT_CODES.block;
  }
}
