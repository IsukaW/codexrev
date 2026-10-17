/**
 * JSON Schema for the bootstrap model output — the structure a local LLM must
 * return when generating a living URS from existing source code (controllers,
 * services, handlers and other business-logic homes).
 *
 * STRICT on purpose (additionalProperties: false, bounded arrays, well-formed
 * source refs): a generated URS becomes the authoritative Version 0 only after
 * the user approves it, so nothing malformed ever reaches the approval screen —
 * the failure is surfaced instead (NFR5). Validated with ajv, compiled once
 * lazily; pure module (no fs, no provider).
 */

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsDefault from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import type { UrsRequirementType } from '../pipeline/types.js';

// ajv-formats ships CommonJS: depending on the interop path the default
// import is the plugin itself or a module object holding it as `.default`.
const addFormats: FormatsPlugin =
  addFormatsDefault.default ?? (addFormatsDefault as unknown as FormatsPlugin);

/** One requirement section as produced by the bootstrap model. */
export interface BootstrappedSection {
  /** Stable kebab-case id, unique within the payload. */
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly type: UrsRequirementType;
  /** Pointers back into the scanned code (`path` + 1-based line). */
  readonly sourceRefs: readonly { readonly path: string; readonly line: number }[];
}

/** The exact object the model must return (and nothing else). */
export interface UrsBootstrapOutput {
  readonly sections: readonly BootstrappedSection[];
  /** One/two-sentence overview of the system that was analysed. */
  readonly summary: string;
}

const SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'text', 'type', 'sourceRefs'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    title: { type: 'string', minLength: 1 },
    text: { type: 'string', minLength: 1 },
    type: { enum: ['functional', 'nfr'] },
    sourceRefs: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line'],
        properties: {
          path: { type: 'string', minLength: 1 },
          line: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;

export const URS_BOOTSTRAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'summary'],
  properties: {
    sections: { type: 'array', minItems: 1, items: SECTION_SCHEMA },
    summary: { type: 'string', minLength: 1 },
  },
} as const;

let validator: ValidateFunction<UrsBootstrapOutput> | undefined;

function getValidator(): ValidateFunction<UrsBootstrapOutput> {
  if (validator) return validator;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  validator = ajv.compile<UrsBootstrapOutput>(URS_BOOTSTRAP_SCHEMA);
  return validator;
}

export interface UrsBootstrapValidationSuccess {
  readonly ok: true;
  readonly value: UrsBootstrapOutput;
}

export interface UrsBootstrapValidationFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type UrsBootstrapValidationResult =
  | UrsBootstrapValidationSuccess
  | UrsBootstrapValidationFailure;

function formatError(e: ErrorObject): string {
  const at = e.instancePath || '/';
  return `${at} ${e.message ?? 'is invalid'}`;
}

/**
 * STRICT validation of a parsed bootstrap payload. Returns a discriminated
 * result instead of throwing so the CLI can refuse the approval step cleanly.
 */
export function validateUrsBootstrapOutput(raw: unknown): UrsBootstrapValidationResult {
  const validate = getValidator();
  if (validate(raw)) {
    const value = raw as UrsBootstrapOutput;
    const ids = new Set(value.sections.map((s) => s.id));
    if (ids.size !== value.sections.length) {
      return { ok: false, errors: ['/sections duplicate section ids'] };
    }
    return { ok: true, value };
  }
  return { ok: false, errors: (validate.errors ?? []).map(formatError) };
}
