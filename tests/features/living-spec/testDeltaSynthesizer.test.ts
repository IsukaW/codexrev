import { describe, expect, it } from 'vitest';
import {
  deltaTypeFor,
  ruleBasedTestDeltas,
  synthesizeTestDeltas,
} from '../../../src/features/living-spec/pipeline/testDeltaSynthesizer.js';
import type { DriftComparison } from '../../../src/features/living-spec/pipeline/driftComparator.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import type {
  SpecImplication,
  SpecImplicationCategory,
  SpecProposal,
  SpecTestCaseDelta,
} from '../../../src/features/living-spec/pipeline/types.js';
import type { GenerateResponse } from '../../../src/core/types.js';

function imp(overrides: Partial<SpecImplication> & { id: string }): SpecImplication {
  return {
    kind: 'functional',
    text: 'The system must do the thing.',
    confidence: 0.9,
    sourceRefs: ['src/greet.js:2'],
    ...overrides,
  };
}

function driftOf(
  entries: DriftComparison['perImplication'],
  overall: DriftComparison['overall'] = 'new',
): DriftComparison {
  return { overall, perImplication: entries };
}

function response(text: string): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  };
}

function fakePort(text: string | Error): LLMPort {
  return {
    provider: 'lmstudio',
    model: 'test-model',
    generate: async () => {
      if (text instanceof Error) throw text;
      return response(text);
    },
  };
}

function validDelta(overrides: Partial<SpecTestCaseDelta> = {}): SpecTestCaseDelta {
  return {
    id: 'test-imp-1',
    title: 'Refined title',
    type: 'new',
    linkedImplicationId: 'imp-1',
    linkedRequirementId: 'req-imp-1',
    preconditions: ['refined precondition'],
    steps: ['refined step one', 'refined step two'],
    expected: 'Refined expected outcome.',
    priority: 'high',
    rationale: 'Refined rationale.',
    ...overrides,
  };
}

const CATEGORY_CASES: ReadonlyArray<{
  category: SpecImplicationCategory;
  expected: string;
  priority: 'low' | 'medium' | 'high';
}> = [
  { category: 'api', expected: 'The API honours the contract', priority: 'high' },
  { category: 'validation', expected: 'Invalid inputs are rejected', priority: 'medium' },
  { category: 'security', expected: 'Unauthorized attempts are denied', priority: 'high' },
  { category: 'performance', expected: 'Performance stays within the stated budget', priority: 'medium' },
  { category: 'behaviour', expected: 'The observed behaviour matches the requirement', priority: 'medium' },
];

describe('ruleBasedTestDeltas — deterministic skeletons per change category', () => {
  for (const { category, expected, priority } of CATEGORY_CASES) {
    it(`produces the ${category} skeleton`, () => {
      const implications = [imp({ id: 'imp-1', category, text: 'The changed thing must hold.' })];
      const drift = driftOf([{ implicationId: 'imp-1', status: 'new', similarity: 0 }]);

      const deltas = ruleBasedTestDeltas({ implications, drift });
      expect(deltas).toHaveLength(1);
      expect(deltas[0].expected).toContain(expected);
      expect(deltas[0].priority).toBe(priority);
      expect(deltas[0].type).toBe('new');
      expect(deltas[0].steps.length).toBeGreaterThan(0);
      expect(deltas[0].preconditions.length).toBeGreaterThan(0);
      expect(deltas[0].rationale).toContain('imp-1');
    });
  }

  it('maps drift status to delta type, retiring removal-flavoured edits', () => {
    expect(deltaTypeFor('new', 'anything')).toBe('new');
    expect(deltaTypeFor('modified', 'The greeting must change.')).toBe('update');
    expect(deltaTypeFor('conflicting', 'The greeting must change.')).toBe('update');
    expect(deltaTypeFor('modified', 'The legacy greeting is no longer emitted.')).toBe('obsolete');
    expect(deltaTypeFor('conflicting', 'Support for the old format was removed.')).toBe('obsolete');

    const implications = [
      imp({ id: 'imp-a', text: 'The greeting must change.' }),
      imp({ id: 'imp-b', text: 'The legacy greeting is no longer emitted.' }),
    ];
    const drift = driftOf([
      { implicationId: 'imp-a', status: 'modified', matchedSectionId: 'sec-a', similarity: 0.5 },
      { implicationId: 'imp-b', status: 'conflicting', matchedSectionId: 'sec-b', similarity: 0.4 },
    ]);
    const deltas = ruleBasedTestDeltas({ implications, drift });
    expect(deltas.map((d) => d.type)).toEqual(['update', 'obsolete']);
  });

  it('links every delta to its implication id and requirement id', () => {
    const implications = [
      imp({ id: 'imp-matched', text: 'Matched requirement changed.' }),
      imp({ id: 'imp-proposed', text: 'A brand new requirement appears.' }),
      imp({ id: 'imp-derived', text: 'Another brand new requirement appears.' }),
    ];
    const drift = driftOf([
      { implicationId: 'imp-matched', status: 'modified', matchedSectionId: 'sec-greeting', similarity: 0.5 },
      { implicationId: 'imp-proposed', status: 'new', similarity: 0 },
      { implicationId: 'imp-derived', status: 'new', similarity: 0 },
    ]);
    const proposals: SpecProposal[] = [
      {
        id: 'prop-1',
        changeId: 'chg',
        createdAt: '2026-10-17T00:00:00.000Z',
        title: 'New requirement',
        status: 'pending',
        implicationIds: ['imp-proposed'],
        driftStatus: 'new',
        sectionsTouched: ['req-imp-proposed'],
      },
    ];

    const deltas = ruleBasedTestDeltas({ implications, drift, proposals });
    expect(deltas.map((d) => [d.linkedImplicationId, d.linkedRequirementId])).toEqual([
      ['imp-matched', 'sec-greeting'],
      ['imp-proposed', 'req-imp-proposed'],
      ['imp-derived', 'req-imp-derived'],
    ]);
    for (const d of deltas) {
      expect(d.id).toBe(`test-${d.linkedImplicationId}`);
    }
  });

  it('never emits deltas for aligned or inert implications', () => {
    const implications = [
      imp({ id: 'imp-aligned', text: 'Same as before.' }),
      imp({ id: 'imp-inert', text: 'Ignored.', confidence: 0 }),
    ];
    const drift = driftOf([
      { implicationId: 'imp-aligned', status: 'aligned', matchedSectionId: 'sec-1', similarity: 0.95 },
      { implicationId: 'imp-inert', status: 'no-semantic-change', similarity: 0 },
    ]);
    expect(ruleBasedTestDeltas({ implications, drift })).toEqual([]);
  });
});

describe('synthesizeTestDeltas — optional LLM refinement with deterministic fallback', () => {
  const implications = [imp({ id: 'imp-1', category: 'api', text: 'The API must return the greeting.' })];
  const drift = driftOf([
    { implicationId: 'imp-1', status: 'new', similarity: 0 },
  ]);

  it('refines presentation fields while keeping rule-owned identity and links', async () => {
    const refined = JSON.stringify({
      deltas: [
        validDelta({
          title: 'Refined API title',
          preconditions: ['server up'],
          steps: ['call the endpoint'],
          expected: 'Refined expected.',
          priority: 'low',
          rationale: 'Model rationale.',
        }),
        // unknown ids are ignored — the delta set never drifts from the rules
        validDelta({ id: 'test-injected', linkedImplicationId: 'imp-ghost' }),
      ],
    });
    const synthesis = await synthesizeTestDeltas({
      implications,
      drift,
      llm: fakePort(refined),
    });

    expect(synthesis.refined).toBe(true);
    expect(synthesis.refinementError).toBeUndefined();
    expect(synthesis.deltas).toHaveLength(1);
    expect(synthesis.deltas[0]).toMatchObject({
      id: 'test-imp-1',
      title: 'Refined API title',
      type: 'new',
      linkedImplicationId: 'imp-1',
      linkedRequirementId: 'req-imp-1',
      preconditions: ['server up'],
      steps: ['call the endpoint'],
      expected: 'Refined expected.',
      priority: 'low',
      rationale: 'Model rationale.',
    });
  });

  it('keeps valid deterministic deltas when the LLM call fails', async () => {
    const synthesis = await synthesizeTestDeltas({
      implications,
      drift,
      llm: fakePort(new Error('connection refused')),
    });

    expect(synthesis.refined).toBe(false);
    expect(synthesis.refinementError?.code).toBe('provider_error');
    expect(synthesis.deltas).toEqual(synthesis.deterministic);
    expect(synthesis.deltas).toHaveLength(1);
  });

  it('keeps valid deterministic deltas when the LLM times out', async () => {
    const hanging: LLMPort = {
      provider: 'lmstudio',
      model: 'test-model',
      generate: () => new Promise<GenerateResponse>(() => undefined),
    };
    const synthesis = await synthesizeTestDeltas({
      implications,
      drift,
      llm: hanging,
      timeoutMs: 20,
    });

    expect(synthesis.refined).toBe(false);
    expect(synthesis.refinementError?.code).toBe('timeout');
    expect(synthesis.deltas).toEqual(synthesis.deterministic);
  });

  it('keeps valid deterministic deltas when the LLM output is malformed', async () => {
    const synthesis = await synthesizeTestDeltas({
      implications,
      drift,
      llm: fakePort('this is not JSON at all'),
    });

    expect(synthesis.refined).toBe(false);
    expect(synthesis.refinementError?.code).toBe('malformed_output');
    expect(synthesis.deltas).toEqual(synthesis.deterministic);
  });

  it('keeps valid deterministic deltas when the LLM output fails schema validation', async () => {
    const synthesis = await synthesizeTestDeltas({
      implications,
      drift,
      llm: fakePort(JSON.stringify({ deltas: [{ id: 'broken' }] })),
    });

    expect(synthesis.refined).toBe(false);
    expect(synthesis.refinementError?.code).toBe('schema_invalid');
    expect(synthesis.deltas).toEqual(synthesis.deterministic);
  });

  it('runs rules only (no model call) when no llm is supplied', async () => {
    const synthesis = await synthesizeTestDeltas({ implications, drift });
    expect(synthesis.refined).toBe(false);
    expect(synthesis.deltas).toEqual(ruleBasedTestDeltas({ implications, drift }));

    // and a fully deterministic run always yields contract-valid deltas
    for (const d of synthesis.deltas) {
      expect(d).toEqual({
        id: expect.any(String),
        title: expect.any(String),
        type: expect.stringMatching(/^(new|update|obsolete)$/),
        linkedImplicationId: expect.any(String),
        linkedRequirementId: expect.any(String),
        preconditions: expect.any(Array),
        steps: expect.any(Array),
        expected: expect.any(String),
        priority: expect.stringMatching(/^(low|medium|high)$/),
        rationale: expect.any(String),
      });
    }
  });

  it('never calls the model when there is nothing to refine', async () => {
    let called = false;
    const llm: LLMPort = {
      provider: 'lmstudio',
      model: 'test-model',
      generate: async () => {
        called = true;
        return response('{}');
      },
    };
    const synthesis = await synthesizeTestDeltas({
      implications: [imp({ id: 'imp-aligned', text: 'Same as before.' })],
      drift: driftOf([
        { implicationId: 'imp-aligned', status: 'aligned', matchedSectionId: 'sec-1', similarity: 0.95 },
      ]),
      llm,
    });
    expect(called).toBe(false);
    expect(synthesis.deltas).toEqual([]);
    expect(synthesis.refined).toBe(false);
  });
});
