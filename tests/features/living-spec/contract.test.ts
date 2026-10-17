import { describe, expect, it } from 'vitest';
import {
  makeSpecAnalysisResult,
  makeSpecProposal,
  makeSpecUrsState,
} from '../../../src/features/living-spec/testing/fixtures.js';

// The stable integration contract is consumed as plain JSON by other
// features later — round-tripping through JSON must be lossless.
describe('living-spec stable contract', () => {
  it('SpecAnalysisResult survives a JSON round-trip unchanged', () => {
    const result = makeSpecAnalysisResult();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('SpecAnalysisResult carries every contract field', () => {
    const result = makeSpecAnalysisResult();
    expect(Object.keys(result).sort()).toEqual(
      [
        'changeId',
        'driftStatus',
        'files',
        'implications',
        'quality',
        'testDeltas',
        'timestamp',
        'ursPatch',
      ].sort(),
    );
    expect(result.implications[0]).toEqual({
      id: expect.any(String),
      kind: expect.stringMatching(/^(functional|nfr)$/),
      text: expect.any(String),
      confidence: expect.any(Number),
      sourceRefs: expect.any(Array),
    });
    expect(result.testDeltas[0]).toEqual({
      id: expect.any(String),
      title: expect.any(String),
      steps: expect.any(Array),
      linkedImplicationId: expect.any(String),
    });
    expect(result.quality).toEqual({
      model: expect.any(String),
      latencyMs: expect.any(Number),
      schemaValid: expect.any(Boolean),
    });
    expect([
      'aligned',
      'modified',
      'new',
      'conflicting',
      'no-semantic-change',
    ]).toContain(result.driftStatus);
  });

  it('proposal and URS state fixtures survive JSON round-trips', () => {
    const proposal = makeSpecProposal();
    const state = makeSpecUrsState();
    expect(JSON.parse(JSON.stringify(proposal))).toEqual(proposal);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
