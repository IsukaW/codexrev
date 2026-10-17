/**
 * JSON Schema for the implication-inference model output.
 *
 * This is the shape the local LLM must produce for `codexrev spec analyze`.
 * It is deliberately TIGHT (additionalProperties: false, required fields,
 * bounded confidence, well-formed source refs) because a malformed or
 * hallucinated payload is never applied or persisted as authoritative —
 * anything that fails validation is discarded and surfaced as a structured
 * error instead (see pipeline/inferenceEngine.ts).
 *
 * The schema is validated with ajv + ajv-formats and compiled once, lazily.
 * This module is pure (no fs, no provider) so it stays unit-testable.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsDefault from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';

// ajv-formats ships CommonJS: depending on the interop path the default
// import is the plugin itself or a module object holding it as `.default`.
const addFormats: FormatsPlugin =
  addFormatsDefault.default ?? (addFormatsDefault as unknown as FormatsPlugin);

export type ImplicationKind = 'functional' | 'nfr';

export type ImplicationCategory =
  | 'security'
  | 'performance'
  | 'api'
  | 'validation'
  | 'behaviour'
  | 'other';

/** A pointer back into the analysed change: a file path plus a 1-based line. */
export interface ImplicationSourceRef {
  readonly path: string;
  readonly line: number;
}

/** One requirement-level implication inferred from the diff. */
export interface InferredImplication {
  readonly id: string;
  readonly kind: ImplicationKind;
  /** Requirement statement in plain language. */
  readonly text: string;
  /** Why the diff implies this requirement. */
  readonly rationale: string;
  /** Calibrated certainty in [0, 1]. */
  readonly confidence: number;
  readonly sourceRefs: readonly ImplicationSourceRef[];
  readonly category?: ImplicationCategory;
}

/** The exact object the model must return (and nothing else). */
export interface ImplicationOutput {
  readonly implications: readonly InferredImplication[];
  readonly behaviourChangeSummary: string;
  readonly requiresUrsUpdate: boolean;
}

export const IMPLICATION_KINDS: readonly ImplicationKind[] = ['functional', 'nfr'];
export const IMPLICATION_CATEGORIES: readonly ImplicationCategory[] = [
  'security',
  'performance',
  'api',
  'validation',
  'behaviour',
  'other',
];

const SOURCE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'line'],
  properties: {
    path: { type: 'string', minLength: 1 },
    line: { type: 'integer', minimum: 1 },
  },
} as const;

const IMPLICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'text', 'rationale', 'confidence', 'sourceRefs'],
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: { enum: [...IMPLICATION_KINDS] },
    text: { type: 'string', minLength: 1 },
    rationale: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    sourceRefs: { type: 'array', items: SOURCE_REF_SCHEMA },
    category: { enum: [...IMPLICATION_CATEGORIES] },
  },
} as const;

/** The full model-output schema: `{ implications, behaviourChangeSummary, requiresUrsUpdate }`. */
export const IMPLICATION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['implications', 'behaviourChangeSummary', 'requiresUrsUpdate'],
  properties: {
    implications: { type: 'array', items: IMPLICATION_SCHEMA },
    behaviourChangeSummary: { type: 'string' },
    requiresUrsUpdate: { type: 'boolean' },
  },
} as const;

let validator: ValidateFunction<ImplicationOutput> | undefined;

function getValidator(): ValidateFunction<ImplicationOutput> {
  if (validator) return validator;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  validator = ajv.compile<ImplicationOutput>(IMPLICATION_OUTPUT_SCHEMA);
  return validator;
}

export interface ImplicationValidationSuccess {
  readonly ok: true;
  readonly value: ImplicationOutput;
}

export interface ImplicationValidationFailure {
  readonly ok: false;
  /** Human-readable ajv error summaries, one per violation. */
  readonly errors: readonly string[];
}

export type ImplicationValidationResult =
  | ImplicationValidationSuccess
  | ImplicationValidationFailure;

function formatError(e: ErrorObject): string {
  const at = e.instancePath || '/';
  return `${at} ${e.message ?? 'is invalid'}`;
}

/**
 * STRICT validation of a parsed model payload. Returns a discriminated result
 * instead of throwing so callers can decide the failure policy. `raw` is never
 * mutated; the success branch hands back the same object typed as
 * `ImplicationOutput`.
 */
export function validateImplicationOutput(raw: unknown): ImplicationValidationResult {
  const validate = getValidator();
  if (validate(raw)) {
    return { ok: true, value: raw as ImplicationOutput };
  }
  return { ok: false, errors: (validate.errors ?? []).map(formatError) };
}
