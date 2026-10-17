/**
 * Living Specification Engine — error classes.
 *
 * Every expected failure in this feature subclasses `LivingSpecError`,
 * which carries a `CODEXREV_LIVING_SPEC_*` code so callers can react to
 * specific failure kinds without string-matching messages.
 */

import { CodexrevError } from '../../../utils/errors.js';

export class LivingSpecError extends CodexrevError {
  constructor(message: string, code: string = 'CODEXREV_LIVING_SPEC_ERROR', retryable = false) {
    super(message, code, retryable);
    this.name = 'LivingSpecError';
  }
}

/** Invalid or corrupt `.codexrev/living-spec/config.json`. */
export class LivingSpecConfigError extends LivingSpecError {
  constructor(message: string) {
    super(message, 'CODEXREV_LIVING_SPEC_CONFIG');
    this.name = 'LivingSpecConfigError';
  }
}

/** Unreadable or malformed state under `.codexrev/living-spec/`. */
export class LivingSpecStateError extends LivingSpecError {
  constructor(message: string) {
    super(message, 'CODEXREV_LIVING_SPEC_STATE');
    this.name = 'LivingSpecStateError';
  }
}

/** Unknown or non-pending URS proposal targeted by accept/reject/defer. */
export class LivingSpecProposalError extends LivingSpecError {
  constructor(message: string) {
    super(message, 'CODEXREV_LIVING_SPEC_PROPOSAL');
    this.name = 'LivingSpecProposalError';
  }
}

/** Diff extraction failed (not a git repo, git diff failure, unusable patch). */
export class LivingSpecDiffError extends LivingSpecError {
  constructor(message: string) {
    super(message, 'CODEXREV_LIVING_SPEC_DIFF');
    this.name = 'LivingSpecDiffError';
  }
}

/** The watch session could not start or its watcher provider failed. */
export class LivingSpecWatchError extends LivingSpecError {
  constructor(message: string) {
    super(message, 'CODEXREV_LIVING_SPEC_WATCH');
    this.name = 'LivingSpecWatchError';
  }
}
