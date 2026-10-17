/**
 * Shared fixtures for living-spec tests (and future evaluation scripts).
 * Factories return contract-shaped JSON so tests assert against realistic
 * data instead of hand-rolled literals — see ../pipeline/types.ts for the
 * stable integration contract these mirror.
 */

import type { SpecAnalysisResult, SpecProposal, SpecUrsState } from '../pipeline/types.js';

export function makeSpecAnalysisResult(
  overrides: Partial<SpecAnalysisResult> = {},
): SpecAnalysisResult {
  return {
    changeId: 'staged',
    timestamp: '2026-10-17T00:00:00.000Z',
    files: [{ path: 'src/greet.js', lines: 12 }],
    implications: [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The greeting must include the caller name.',
        confidence: 0.8,
        sourceRefs: ['src/greet.js:3-18'],
      },
    ],
    driftStatus: 'modified',
    ursPatch: {
      summary: 'Document the caller-name requirement.',
      entries: [
        {
          op: 'modify',
          sectionId: 'sec-greeting',
          markdown: '### Greeting\n\nThe greeting must include the caller name.',
        },
      ],
    },
    testDeltas: [
      {
        id: 'test-1',
        title: 'greets with the caller name',
        type: 'update',
        linkedImplicationId: 'imp-1',
        linkedRequirementId: 'sec-greeting',
        preconditions: ['The greeting service is running.'],
        steps: ['call greet("ada")', 'expect output to contain "ada"'],
        expected: 'The greeting includes the caller name "ada".',
        priority: 'high',
        rationale: 'The greeting now includes the caller name (imp-1).',
      },
    ],
    quality: { model: 'heuristic', latencyMs: 0, schemaValid: true },
    impactSummary: {
      affectedRequirementIds: ['sec-greeting'],
      affectedFiles: [{ path: 'src/greet.js', lines: [2, 3] }],
      recommendedNextAction:
        'Review the pending URS proposals for the modified requirement(s) and accept/reject/defer.',
      confidence: 0.8,
    },
    driftAlerts: [
      {
        changeId: 'staged',
        file: 'src/greet.js',
        reason: 'Requirement "Greeting" (sec-greeting) is modified by this change: The greeting must include the caller name.',
        affectedRequirement: 'sec-greeting',
        proposedNextAction:
          'Confirm the requirement update for sec-greeting, then decide proposal prop-1 (codexrev spec accept|reject|defer prop-1).',
        severity: 'warning',
        timestamp: '2026-10-17T00:00:00.000Z',
      },
    ],
    behaviourChangeSummary: null,
    requiresUrsUpdate: null,
    inferenceError: null,
    proposalIds: [],
    ...overrides,
  };
}

export function makeSpecProposal(overrides: Partial<SpecProposal> = {}): SpecProposal {
  return {
    id: 'prop-1',
    changeId: 'staged',
    createdAt: '2026-10-17T00:00:00.000Z',
    title: 'Document the caller-name requirement',
    status: 'pending',
    implicationIds: ['imp-1'],
    ...overrides,
  };
}

export function makeSpecUrsState(overrides: Partial<SpecUrsState> = {}): SpecUrsState {
  return {
    schemaVersion: 1,
    version: 0,
    updatedAt: '2026-10-17T00:00:00.000Z',
    lastDriftAlerts: [],
    ...overrides,
  };
}
