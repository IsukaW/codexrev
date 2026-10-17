/**
 * JSON Schema for the optional LLM refinement of test-case deltas.
 *
 * The deterministic rule synthesizer is always authoritative for delta
 * identity and linkage (`id`, `type`, `linkedImplicationId`,
 * `linkedRequirementId`); the model may only refine the presentation fields.
 * Anything schema-invalid is discarded wholesale and the deterministic deltas
 * stand (see pipeline/testDeltaSynthesizer.ts) — same fail-safe policy as the
 * implication output.
 *
 * Validated with ajv + ajv-formats, compiled once lazily. Pure module (no fs,
 * no provider) so it stays unit-testable.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsDefault from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import type {
  SpecTestCaseDelta,
  SpecTestDeltaType,
  SpecTestPriority,
} from '../pipeline/types.js';

// ajv-formats ships CommonJS: depending on the interop path the default
// import is the plugin itself or a module object holding it as `.default`.
const addFormats: FormatsPlugin =
  addFormatsDefault.default ?? (addFormatsDefault as unknown as FormatsPlugin);

export const TEST_DELTA_TYPES: readonly SpecTestDeltaType[] = ['new', 'update', 'obsolete'];
export const TEST_DELTA_PRIORITIES: readonly SpecTestPriority[] = ['low', 'medium', 'high'];

/** The exact object the model must return (and nothing else). */
export interface TestDeltaRefinementOutput {
  readonly deltas: readonly SpecTestCaseDelta[];
}

const TEST_DELTA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deltas'],
  properties: {
    deltas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'title',
          'type',
          'linkedImplicationId',
          'linkedRequirementId',
          'preconditions',
          'steps',
          'expected',
          'priority',
          'rationale',
        ],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          type: { enum: [...TEST_DELTA_TYPES] },
          linkedImplicationId: { type: 'string', minLength: 1 },
          linkedRequirementId: { type: 'string', minLength: 1 },
          preconditions: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          expected: { type: 'string', minLength: 1 },
          priority: { enum: [...TEST_DELTA_PRIORITIES] },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

let validator: ValidateFunction<TestDeltaRefinementOutput> | undefined;

function getValidator(): ValidateFunction<TestDeltaRefinementOutput> {
  if (validator) return validator;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  validator = ajv.compile<TestDeltaRefinementOutput>(TEST_DELTA_SCHEMA);
  return validator;
}

export interface TestDeltaValidationSuccess {
  readonly ok: true;
  readonly value: TestDeltaRefinementOutput;
}

export interface TestDeltaValidationFailure {
  readonly ok: false;
  /** Human-readable ajv error summaries, one per violation. */
  readonly errors: readonly string[];
}

export type TestDeltaValidationResult = TestDeltaValidationSuccess | TestDeltaValidationFailure;

function formatError(e: ErrorObject): string {
  const at = e.instancePath || '/';
  return `${at} ${e.message ?? 'is invalid'}`;
}

/**
 * STRICT validation of a parsed refinement payload. Returns a discriminated
 * result instead of throwing so the caller can keep the deterministic deltas.
 */
export function validateTestDeltaOutput(raw: unknown): TestDeltaValidationResult {
  const validate = getValidator();
  if (validate(raw)) {
    return { ok: true, value: raw as TestDeltaRefinementOutput };
  }
  return { ok: false, errors: (validate.errors ?? []).map(formatError) };
}
