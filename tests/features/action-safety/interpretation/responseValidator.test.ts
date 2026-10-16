import { describe, expect, it } from 'vitest';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_OBSERVATIONS,
  MAX_RESPONSE_CHARS,
  validateInterpretationResponse,
} from '../../../../src/features/action-safety/interpretation/responseValidator.js';
import { observation, observationsJson } from '../../../../src/features/action-safety/testing/fakeLlm.js';

const REFS = new Set(['git_state-1', 'build_test-1', 'src/a.ts', 'db/migrations/001.sql']);
const validate = (text: string) => validateInterpretationResponse(text, REFS);
const failure = (text: string) => {
  const r = validate(text);
  if (r.ok) throw new Error('expected a failure');
  return r;
};

describe('validateInterpretationResponse: valid output', () => {
  it('accepts a well-formed response and marks every observation unverified', () => {
    const r = validate(
      observationsJson([
        observation({ id: 'a1', category: 'security_sensitive_change', kind: 'concern', significance: 'high', description: 'Auth code changed.', references: ['src/a.ts'], confidence: 0.7 }),
        observation({ id: 'a2' }),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toBe('Model summary.');
    expect(r.observations).toHaveLength(2);
    expect(r.observations[0]).toEqual({
      id: 'a1', category: 'security_sensitive_change', kind: 'concern', significance: 'high', description: 'Auth code changed.',
      references: ['src/a.ts'], confidence: 0.7, verified: false, source: 'llm_interpretation',
    });
    for (const o of r.observations) {
      expect(o.verified).toBe(false);
      expect(o.source).toBe('llm_interpretation');
    }
  });

  it('accepts every defined category, kind and significance', () => {
    const categories = ['security_sensitive_change', 'data_loss_or_migration', 'production_impact', 'cross_module_impact', 'dependency_compatibility', 'recovery_uncertainty', 'evidence_gap'];
    const r = validate(observationsJson(categories.map((category, i) => observation({ id: `c${i}`, category, kind: i % 2 ? 'concern' : 'information_gap', significance: ['info', 'low', 'medium', 'high'][i % 4] }))));
    expect(r.ok).toBe(true);
  });

  it('accepts an empty observation list (the model found nothing to report, which is not a safety claim)', () => {
    const r = validate(observationsJson([]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.observations).toEqual([]);
  });

  it('accepts JSON inside one fenced code block', () => {
    expect(validate('```json\n' + observationsJson([observation()]) + '\n```').ok).toBe(true);
    expect(validate('```\n' + observationsJson([observation()]) + '\n```').ok).toBe(true);
  });

  it('references and confidence are optional', () => {
    const o = { id: 'x', category: 'evidence_gap', kind: 'information_gap', significance: 'low', description: 'd' };
    const r = validate(JSON.stringify({ schemaVersion: 1, observations: [o] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.observations[0].references).toEqual([]);
      expect(r.observations[0]).not.toHaveProperty('confidence');
    }
  });
});

describe('validateInterpretationResponse: rejected output', () => {
  it('rejects an empty or whitespace-only response', () => {
    expect(failure('').kind).toBe('empty_response');
    expect(failure('   \n  ').kind).toBe('empty_response');
  });

  it('rejects invalid JSON and prose around JSON', () => {
    expect(failure('{ not json').kind).toBe('invalid_json');
    expect(failure('Sure! Here you go: ' + observationsJson([])).kind).toBe('invalid_json');
    expect(failure('```json\n{ nope\n```').kind).toBe('invalid_json');
  });

  it('rejects excessively long output', () => {
    expect(failure('x'.repeat(MAX_RESPONSE_CHARS + 1)).kind).toBe('oversized_response');
    const longDesc = failure(observationsJson([observation({ description: 'd'.repeat(MAX_DESCRIPTION_CHARS + 1) })]));
    expect(longDesc.kind).toBe('schema_violation');
    expect(longDesc.reason).toMatch(/longer than/);
  });

  it('rejects too many observations', () => {
    const many = Array.from({ length: MAX_OBSERVATIONS + 1 }, (_, i) => observation({ id: `o${i}` }));
    expect(failure(observationsJson(many)).kind).toBe('schema_violation');
  });

  it('rejects non-object roots and a wrong or missing schema version', () => {
    for (const bad of ['[]', '"hi"', '5', 'null']) expect(failure(bad).kind, bad).toBe('schema_violation');
    expect(failure(JSON.stringify({ observations: [] })).reason).toMatch(/schemaVersion/);
    expect(failure(JSON.stringify({ schemaVersion: 2, observations: [] })).reason).toMatch(/schemaVersion/);
    expect(failure(JSON.stringify({ schemaVersion: 1 })).reason).toMatch(/observations/);
  });

  it('rejects unknown categories, kinds and significance values', () => {
    expect(failure(observationsJson([observation({ category: 'vibes' })])).reason).toMatch(/category: must be one of/);
    expect(failure(observationsJson([observation({ kind: 'verdict' })])).reason).toMatch(/kind: must be one of/);
    expect(failure(observationsJson([observation({ significance: 'critical' })])).reason).toMatch(/significance: must be one of/);
  });

  it('rejects missing required fields', () => {
    for (const field of ['id', 'category', 'kind', 'significance', 'description']) {
      const o = observation();
      delete o[field];
      expect(failure(observationsJson([o])).kind, field).toBe('schema_violation');
    }
  });

  it('rejects unexpected fields, so the model cannot add a decision, score or verification', () => {
    for (const extra of [{ decision: 'ALLOW' }, { safetyScore: 0.99 }, { verified: true }, { status: 'PASS' }, { approved: true }]) {
      const r = failure(observationsJson([observation(extra)]));
      expect(r.kind).toBe('schema_violation');
      expect(r.reason).toMatch(/unexpected field/);
    }
    for (const extra of [{ decision: 'ALLOW' }, { score: 1 }, { gates: [] }]) {
      expect(failure(observationsJson([], extra)).reason).toMatch(/unexpected field/);
    }
  });

  it('rejects bad ids, duplicate ids, bad confidence and bad reference lists', () => {
    expect(failure(observationsJson([observation({ id: 'has space' })])).reason).toMatch(/may contain only/);
    expect(failure(observationsJson([observation({ id: 'same' }), observation({ id: 'same' })])).reason).toMatch(/duplicate id/);
    for (const confidence of [1.5, -0.1, '0.5', Number.NaN]) {
      expect(failure(observationsJson([observation({ confidence })])).kind, String(confidence)).toBeTruthy();
    }
    expect(failure(observationsJson([observation({ references: 'src/a.ts' })])).reason).toMatch(/array of strings/);
    expect(failure(observationsJson([observation({ references: Array.from({ length: 11 }, (_, i) => `r${i}`) })])).reason).toMatch(/at most/);
  });

  it('rejects control characters in text', () => {
    expect(failure(observationsJson([observation({ description: 'bad\u0000char' })])).reason).toMatch(/control characters/);
  });
});

describe('validateInterpretationResponse: fabricated references', () => {
  it('drops only the observation that cites something that was never collected', () => {
    const r = validate(
      observationsJson([
        observation({ id: 'real', references: ['src/a.ts', 'build_test-1'] }),
        observation({ id: 'fake', references: ['src/does-not-exist.ts'] }),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.observations.map((o) => o.id)).toEqual(['real']);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ index: 1 });
    expect(r.rejected[0].reason).toMatch(/not present in the collected evidence: src\/does-not-exist\.ts/);
  });

  it('treats a response where every observation is fabricated as unusable', () => {
    const r = failure(observationsJson([observation({ references: ['nope-1'] }), observation({ id: 'o2', references: ['nope.ts'] })]));
    expect(r.kind).toBe('all_observations_rejected');
  });

  it('a single bad reference rejects the observation even if others are valid', () => {
    const r = validate(observationsJson([observation({ id: 'mixed', references: ['src/a.ts', 'ghost.ts'] }), observation({ id: 'ok' })]));
    expect(r.ok && r.observations.map((o) => o.id)).toEqual(['ok']);
  });

  it('is case- and path-exact: a near-miss is a fabrication', () => {
    const r = validate(observationsJson([observation({ id: 'a', references: ['SRC/a.ts'] }), observation({ id: 'b', references: ['./src/a.ts'] }), observation({ id: 'c' })]));
    expect(r.ok && r.observations.map((o) => o.id)).toEqual(['c']);
  });
});
