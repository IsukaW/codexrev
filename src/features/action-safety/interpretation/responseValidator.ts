/**
 * Strict validation of the model's response. Model output is untrusted data:
 * it is accepted only if it matches the versioned schema exactly.
 *
 * Expected shape (schemaVersion 1):
 *   { "schemaVersion": 1, "summary": "<optional text>", "observations": [ {
 *       "id", "category", "kind", "significance", "description",
 *       "references": [..optional..], "confidence": <optional 0..1> } ] }
 *
 * Two kinds of problem:
 *   structural  (bad JSON, wrong types, unknown field or category, bad
 *               severity, duplicate id, too long, too many) -> the WHOLE
 *               response is rejected; a model that breaks the contract is not
 *               partially trusted.
 *   fabricated  (an observation cites a file or evidence id that is not in
 *               the collected bundle) -> only that observation is dropped and
 *               recorded; if every observation is dropped the response is
 *               rejected as unusable.
 *
 * There is deliberately no field for a decision, score, verification or
 * status, and unknown fields are rejected, so the model cannot smuggle one in.
 */

import {
  INTERPRETATION_SCHEMA_VERSION,
  OBSERVATION_CATEGORIES,
  OBSERVATION_KINDS,
  OBSERVATION_SIGNIFICANCE,
  type ContextualObservation,
  type InterpretationFailureKind,
  type RejectedObservation,
} from './types.js';

export const MAX_RESPONSE_CHARS = 20_000;
export const MAX_OBSERVATIONS = 25;
export const MAX_DESCRIPTION_CHARS = 600;
export const MAX_SUMMARY_CHARS = 600;
export const MAX_REFERENCES = 10;
export const MAX_REFERENCE_CHARS = 200;

export type ValidationResult =
  | {
      readonly ok: true;
      readonly summary?: string;
      readonly observations: readonly ContextualObservation[];
      readonly rejected: readonly RejectedObservation[];
    }
  | {
      readonly ok: false;
      readonly kind: Extract<
        InterpretationFailureKind,
        'empty_response' | 'oversized_response' | 'invalid_json' | 'schema_violation' | 'all_observations_rejected'
      >;
      readonly reason: string;
    };

const TOP_LEVEL_KEYS = ['schemaVersion', 'summary', 'observations'] as const;
const OBSERVATION_KEYS = ['id', 'category', 'kind', 'significance', 'description', 'references', 'confidence'] as const;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

class SchemaViolation extends Error {}

function violation(path: string, detail: string): never {
  throw new SchemaViolation(`${path}: ${detail}`);
}

// control characters have no place in the text we show or store (newline and tab are fine)
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) return true;
  }
  return false;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function text(path: string, x: unknown, max: number, required: boolean): string | undefined {
  if (x === undefined && !required) return undefined;
  if (typeof x !== 'string') violation(path, 'expected a string');
  const s = (x as string).trim();
  if (required && s.length === 0) violation(path, 'must not be empty');
  if (s.length > max) violation(path, `is longer than the ${max}-character limit`);
  if (hasControlChars(s)) violation(path, 'contains control characters');
  return s;
}

function oneOf<T extends string>(path: string, x: unknown, valid: readonly T[]): T {
  if (typeof x !== 'string' || !(valid as readonly string[]).includes(x)) violation(path, `must be one of: ${valid.join(', ')}`);
  return x as T;
}

// accepts bare JSON, or JSON in one fenced block (a common model habit); anything else is not accepted
function extractJson(raw: string): string {
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(raw);
  return fenced ? fenced[1] : raw;
}

export function validateInterpretationResponse(raw: string, allowedReferences: ReadonlySet<string>): ValidationResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, kind: 'empty_response', reason: 'the model returned an empty response' };
  if (trimmed.length > MAX_RESPONSE_CHARS) {
    return { ok: false, kind: 'oversized_response', reason: `the model response is longer than the ${MAX_RESPONSE_CHARS}-character limit` };
  }

  let json: unknown;
  try {
    json = JSON.parse(extractJson(trimmed));
  } catch {
    return { ok: false, kind: 'invalid_json', reason: 'the model response is not valid JSON' };
  }

  try {
    if (!isRecord(json)) violation('$', 'expected a JSON object');
    const top = json as Record<string, unknown>;
    for (const k of Object.keys(top)) {
      if (!(TOP_LEVEL_KEYS as readonly string[]).includes(k)) violation(`$.${k}`, 'unexpected field');
    }
    if (top.schemaVersion !== INTERPRETATION_SCHEMA_VERSION) violation('$.schemaVersion', `must be ${INTERPRETATION_SCHEMA_VERSION}`);
    const summary = text('$.summary', top.summary, MAX_SUMMARY_CHARS, false);
    if (!Array.isArray(top.observations)) violation('$.observations', 'expected an array');
    const list = top.observations as unknown[];
    if (list.length > MAX_OBSERVATIONS) violation('$.observations', `at most ${MAX_OBSERVATIONS} observations are allowed (got ${list.length})`);

    const accepted: ContextualObservation[] = [];
    const rejected: RejectedObservation[] = [];
    const seenIds = new Set<string>();

    list.forEach((item, index) => {
      const at = `$.observations[${index}]`;
      if (!isRecord(item)) violation(at, 'expected an object');
      const o = item as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (!(OBSERVATION_KEYS as readonly string[]).includes(k)) violation(`${at}.${k}`, 'unexpected field');
      }
      const id = text(`${at}.id`, o.id, 40, true) as string;
      if (!ID_PATTERN.test(id)) violation(`${at}.id`, 'may contain only letters, digits, ".", "_" and "-"');
      if (seenIds.has(id)) violation(`${at}.id`, `duplicate id "${id}"`);
      seenIds.add(id);
      const category = oneOf(`${at}.category`, o.category, OBSERVATION_CATEGORIES);
      const kind = oneOf(`${at}.kind`, o.kind, OBSERVATION_KINDS);
      const significance = oneOf(`${at}.significance`, o.significance, OBSERVATION_SIGNIFICANCE);
      const description = text(`${at}.description`, o.description, MAX_DESCRIPTION_CHARS, true) as string;

      let references: string[] = [];
      if (o.references !== undefined) {
        if (!Array.isArray(o.references)) violation(`${at}.references`, 'expected an array of strings');
        const refs = o.references as unknown[];
        if (refs.length > MAX_REFERENCES) violation(`${at}.references`, `at most ${MAX_REFERENCES} references are allowed`);
        references = refs.map((r, i) => text(`${at}.references[${i}]`, r, MAX_REFERENCE_CHARS, true) as string);
      }

      let confidence: number | undefined;
      if (o.confidence !== undefined) {
        if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
          violation(`${at}.confidence`, 'must be a number between 0 and 1');
        }
        confidence = o.confidence as number;
      }

      // a citation of something that was never collected is fabrication, not a formatting slip
      const unknownRefs = references.filter((r) => !allowedReferences.has(r));
      if (unknownRefs.length > 0) {
        rejected.push({ index, reason: `cites reference(s) not present in the collected evidence: ${unknownRefs.slice(0, 3).join(', ')}` });
        return;
      }

      accepted.push({
        id,
        category,
        kind,
        significance,
        description,
        references,
        ...(confidence !== undefined ? { confidence } : {}),
        verified: false,
        source: 'llm_interpretation',
      });
    });

    if (list.length > 0 && accepted.length === 0) {
      return { ok: false, kind: 'all_observations_rejected', reason: `every observation (${list.length}) cited references that do not exist in the collected evidence` };
    }
    return { ok: true, ...(summary ? { summary } : {}), observations: accepted, rejected };
  } catch (err) {
    if (err instanceof SchemaViolation) return { ok: false, kind: 'schema_violation', reason: err.message };
    throw err;
  }
}
