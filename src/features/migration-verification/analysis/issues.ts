/**
 * Feature 3 / Function 1 — structured analysis issues and validation errors.
 *
 * Issues are the explicit evidence/error report required by the proposal:
 * missing manifests, unsupported ecosystems, unavailable compatibility data,
 * analyzer failures etc. are reported as data, never silently swallowed.
 */

import { CodexrevError } from '../../../utils/errors.js';
import type { AnalysisIssue, AnalysisIssueCode } from './types.js';

export const ANALYSIS_ISSUE_CODES: readonly AnalysisIssueCode[] = [
  'REQUEST_INVALID',
  'VERSION_INVALID',
  'MANIFEST_MISSING',
  'ECOSYSTEM_UNSUPPORTED',
  'LOCKFILE_MISSING',
  'COMPAT_DATA_UNAVAILABLE',
  'COMPAT_VERSION_UNEVALUATED',
  'DEPENDENCY_UNRESOLVED',
  'RULE_NOT_FOUND',
  'ORDER_CYCLE',
  'ANALYZER_FAILED',
];

export function analysisIssue(
  code: AnalysisIssueCode,
  severity: 'error' | 'warning',
  message: string,
  context?: string,
): AnalysisIssue {
  return context === undefined ? { code, severity, message } : { code, severity, message, context };
}

export function requestInvalid(message: string, context?: string): AnalysisIssue {
  return analysisIssue('REQUEST_INVALID', 'error', message, context);
}

export function versionInvalid(message: string, context?: string): AnalysisIssue {
  return analysisIssue('VERSION_INVALID', 'error', message, context);
}

export function ecosystemUnsupported(message: string, context?: string): AnalysisIssue {
  return analysisIssue('ECOSYSTEM_UNSUPPORTED', 'error', message, context);
}

/**
 * Thrown by request validation when one or more fields are invalid.
 * Carries the full issue list so callers can report every problem at once.
 */
export class RequestValidationError extends CodexrevError {
  constructor(
    public readonly issues: ReadonlyArray<AnalysisIssue>,
    message?: string,
  ) {
    const summary = message ?? issues.map((i) => `[${i.code}] ${i.message}`).join('; ');
    super(summary, 'CODEXREV_MIGRATION_REQUEST_INVALID', false);
    this.name = 'RequestValidationError';
  }
}
