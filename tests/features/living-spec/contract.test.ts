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
        'behaviourChangeSummary',
        'changeId',
        'driftAlerts',
        'driftStatus',
        'files',
        'impactSummary',
        'implications',
        'inferenceError',
        'proposalIds',
        'quality',
        'requiresUrsUpdate',
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
      type: expect.stringMatching(/^(new|update|obsolete)$/),
      linkedImplicationId: expect.any(String),
      linkedRequirementId: expect.any(String),
      preconditions: expect.any(Array),
      steps: expect.any(Array),
      expected: expect.any(String),
      priority: expect.stringMatching(/^(low|medium|high)$/),
      rationale: expect.any(String),
    });
    expect(result.quality).toEqual({
      model: expect.any(String),
      latencyMs: expect.any(Number),
      schemaValid: expect.any(Boolean),
    });
    expect(result.impactSummary).toEqual({
      affectedRequirementIds: expect.any(Array),
      affectedFiles: [
        { path: expect.any(String), lines: expect.any(Array) },
      ],
      recommendedNextAction: expect.any(String),
      confidence: expect.any(Number),
    });
    expect(result.driftAlerts[0]).toEqual({
      changeId: expect.any(String),
      file: expect.any(String),
      reason: expect.any(String),
      affectedRequirement: expect.any(String),
      proposedNextAction: expect.any(String),
      severity: expect.stringMatching(/^(info|warning|critical)$/),
      timestamp: expect.any(String),
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
