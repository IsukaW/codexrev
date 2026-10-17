import { describe, expect, it } from 'vitest';
import {
  validateImplicationOutput,
  type ImplicationOutput,
} from '../../../src/features/living-spec/tools/implicationSchema.js';

function goodPayload(): ImplicationOutput {
  return {
    implications: [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The greeting must include the caller name.',
        rationale: 'The diff changes the greeting format to interpolate the name.',
        confidence: 0.85,
        sourceRefs: [{ path: 'src/greet.js', line: 3 }],
        category: 'behaviour',
      },
      {
        id: 'imp-2',
        kind: 'nfr',
        text: 'The greeting path must not leak stack traces.',
        rationale: 'Error handling was added around the greeting.',
        confidence: 0.4,
        sourceRefs: [
          { path: 'src/greet.js', line: 5 },
          { path: 'src/greet.js', line: 9 },
        ],
      },
    ],
    behaviourChangeSummary: 'The greeting now interpolates the caller name.',
    requiresUrsUpdate: true,
  };
}

describe('implication output schema', () => {
  it('accepts a well-formed payload', () => {
    const res = validateImplicationOutput(goodPayload());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.implications).toHaveLength(2);
  });

  it('accepts an empty implications list (e.g. no behavioural change)', () => {
    const res = validateImplicationOutput({
      implications: [],
      behaviourChangeSummary: 'No observable behaviour change.',
      requiresUrsUpdate: false,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a missing implications field', () => {
    const res = validateImplicationOutput({
      behaviourChangeSummary: 'x',
      requiresUrsUpdate: true,
    });
    expect(res.ok).toBe(false);
  });

  it('rejects a missing top-level summary / flag', () => {
    expect(validateImplicationOutput({ implications: [] }).ok).toBe(false);
    expect(
      validateImplicationOutput({ implications: [], behaviourChangeSummary: 'x' }).ok,
    ).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    const over = goodPayload();
    (over.implications[0] as { confidence: number }).confidence = 1.5;
    expect(validateImplicationOutput(over).ok).toBe(false);

    const under = goodPayload();
    (under.implications[0] as { confidence: number }).confidence = -0.1;
    expect(validateImplicationOutput(under).ok).toBe(false);
  });

  it('rejects a confidence that is not a number', () => {
    const bad = goodPayload();
    (bad.implications[0] as { confidence: unknown }).confidence = '0.9';
    expect(validateImplicationOutput(bad).ok).toBe(false);
  });

  it('rejects bad source refs (missing line, missing path, non-positive line)', () => {
    const missingLine = goodPayload();
    (missingLine.implications[0] as { sourceRefs: unknown[] }).sourceRefs = [
      { path: 'src/greet.js' },
    ];
    expect(validateImplicationOutput(missingLine).ok).toBe(false);

    const missingPath = goodPayload();
    (missingPath.implications[0] as { sourceRefs: unknown[] }).sourceRefs = [{ line: 3 }];
    expect(validateImplicationOutput(missingPath).ok).toBe(false);

    const zeroLine = goodPayload();
    (zeroLine.implications[0] as { sourceRefs: unknown[] }).sourceRefs = [
      { path: 'src/greet.js', line: 0 },
    ];
    expect(validateImplicationOutput(zeroLine).ok).toBe(false);

    const floatLine = goodPayload();
    (floatLine.implications[0] as { sourceRefs: unknown[] }).sourceRefs = [
      { path: 'src/greet.js', line: 3.5 },
    ];
    expect(validateImplicationOutput(floatLine).ok).toBe(false);
  });

  it('rejects a missing required implication field (id / kind / text / rationale)', () => {
    for (const key of ['id', 'kind', 'text', 'rationale'] as const) {
      const bad = goodPayload();
      delete (bad.implications[0] as Record<string, unknown>)[key];
      expect(validateImplicationOutput(bad).ok, `expected rejection when ${key} is missing`).toBe(
        false,
      );
    }
  });

  it('rejects an invalid kind or category', () => {
    const badKind = goodPayload();
    (badKind.implications[0] as { kind: unknown }).kind = 'security';
    expect(validateImplicationOutput(badKind).ok).toBe(false);

    const badCategory = goodPayload();
    (badCategory.implications[0] as { category: unknown }).category = 'nope';
    expect(validateImplicationOutput(badCategory).ok).toBe(false);
  });

  it('rejects unknown extra properties (strict schema)', () => {
    const bad = goodPayload();
    (bad as Record<string, unknown>).extra = 'junk';
    expect(validateImplicationOutput(bad).ok).toBe(false);

    const badImp = goodPayload();
    (badImp.implications[0] as Record<string, unknown>).unexpected = 1;
    expect(validateImplicationOutput(badImp).ok).toBe(false);
  });

  it('returns human-readable errors on failure', () => {
    const res = validateImplicationOutput({ implications: 'nope' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });
});
