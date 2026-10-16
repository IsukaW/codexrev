/**
 * Types for the local-LLM contextual interpretation layer.
 *
 * The model is an ADVISORY observer. Its output is a list of unverified
 * contextual observations (concerns and information gaps). It never produces
 * a safety score, a factor value, a gate result or an ALLOW/ESCALATE/BLOCK
 * decision, and nothing in this file can carry one: the response schema has no
 * such fields and the validator rejects any extra field.
 */

import type { ProviderId } from '../../../core/types.js';

/** Version of the response contract the model is asked to follow. Bump on any breaking change. */
export const INTERPRETATION_SCHEMA_VERSION = 1 as const;

export const OBSERVATION_CATEGORIES = [
  'security_sensitive_change',
  'data_loss_or_migration',
  'production_impact',
  'cross_module_impact',
  'dependency_compatibility',
  'recovery_uncertainty',
  'evidence_gap',
] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

/** A concern is a possible risk; an information gap is something the evidence does not show. */
export const OBSERVATION_KINDS = ['concern', 'information_gap'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const OBSERVATION_SIGNIFICANCE = ['info', 'low', 'medium', 'high'] as const;
export type ObservationSignificance = (typeof OBSERVATION_SIGNIFICANCE)[number];

/**
 * One validated observation. `verified: false` and `source` are set by this
 * code, never read from the model: whatever the model says, it is an unverified
 * claim and must not be treated as evidence.
 */
export interface ContextualObservation {
  readonly id: string;
  readonly category: ObservationCategory;
  readonly kind: ObservationKind;
  readonly significance: ObservationSignificance;
  readonly description: string;
  /** evidence record ids or changed-file paths that exist in the collected bundle */
  readonly references: readonly string[];
  /** the model's own 0..1 confidence, if it gave one; it is not a probability we vouch for */
  readonly confidence?: number;
  readonly verified: false;
  readonly source: 'llm_interpretation';
}

export type InterpretationStatus = 'COMPLETED' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'ERROR';

export type InterpretationFailureKind =
  | 'config_error'
  | 'no_model'
  | 'not_local'
  | 'server_unreachable'
  | 'unsupported_provider'
  | 'input_too_large'
  | 'timeout'
  | 'provider_error'
  | 'empty_response'
  | 'oversized_response'
  | 'invalid_json'
  | 'schema_violation'
  | 'all_observations_rejected'
  | 'unexpected';

export interface RejectedObservation {
  /** position in the model's array */
  readonly index: number;
  readonly reason: string;
}

export interface PromptStats {
  readonly promptChars: number;
  readonly filesListed: number;
  readonly filesOmitted: number;
  readonly diffFilesIncluded: number;
  readonly diffFilesOmitted: number;
  /** how many secret-looking values were masked before anything was sent */
  readonly redactions: number;
  readonly truncated: boolean;
}

export interface ContextInterpretation {
  readonly status: InterpretationStatus;
  readonly schemaVersion: typeof INTERPRETATION_SCHEMA_VERSION;
  /** why the status is not COMPLETED */
  readonly failureKind?: InterpretationFailureKind;
  readonly reason?: string;
  /** the model's own short summary; unverified */
  readonly summary?: string;
  readonly observations: readonly ContextualObservation[];
  readonly rejectedObservations: readonly RejectedObservation[];
  /** which configured model produced this; absent when no model was reached */
  readonly provider?: { readonly id: ProviderId; readonly model: string; readonly local: boolean };
  /** absent when nothing was built or sent */
  readonly promptStats?: PromptStats;
  /** places where untrusted input looked like it was trying to instruct the model */
  readonly injectionIndicators: readonly string[];
  readonly limitations: readonly string[];
  /** always true: this layer can only advise, never decide or verify */
  readonly advisoryOnly: true;
}
