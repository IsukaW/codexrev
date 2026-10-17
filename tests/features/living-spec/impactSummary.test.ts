import { describe, expect, it } from 'vitest';
import {
  buildImpactSummary,
  changedLineNumbers,
  parseSourceRef,
} from '../../../src/features/living-spec/pipeline/impactSummary.js';
import type { DriftComparison } from '../../../src/features/living-spec/pipeline/driftComparator.js';
import type { ExtractedDiff } from '../../../src/features/living-spec/pipeline/diffExtractor.js';
import type {
  SpecImplication,
  SpecProposal,
} from '../../../src/features/living-spec/pipeline/types.js';

/**
 * Fixture diff: one modified file with a 2-line change at lines 2-3 of the new
 * file (line 2 replaced, line 3 added) plus exact line numbers on every line.
 */
function makeExtraction(): ExtractedDiff {
  return {
    ref: 'staged',
    files: [
      {
        path: 'src/greet.js',
        status: 'modified',
        linesAdded: 2,
        linesRemoved: 1,
        hunks: [
          {
            header: '@@ -1,3 +1,4 @@',
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            lines: [
              { type: 'del', content: 'old line', oldLineNumber: 2 },
              { type: 'add', content: 'new line', newLineNumber: 2 },
              { type: 'add', content: 'extra line', newLineNumber: 3 },
              { type: 'context', content: 'context line', oldLineNumber: 3, newLineNumber: 4 },
            ],
            contextTruncated: false,
          },
        ],
        minimalPatch: '@@ -1,3 +1,4 @@\n-old line\n+new line\n+extra line\n context line',
      },
    ],
    truncated: false,
    totalBytes: 128,
    omittedPaths: [],
    raw: 'diff --git a/src/greet.js b/src/greet.js',
    maxBytes: 204800,
  };
}

function imp(overrides: Partial<SpecImplication> & { id: string }): SpecImplication {
  return {
    kind: 'functional',
    text: 'The greeting must include the caller name.',
    confidence: 0.9,
    sourceRefs: ['src/greet.js:2'],
    ...overrides,
  };
}

const NEW_DRIFT: DriftComparison = {
  overall: 'new',
  perImplication: [{ implicationId: 'imp-1', status: 'new', similarity: 0 }],
};

describe('parseSourceRef', () => {
  it('parses path:line, path:a-b and bare paths', () => {
    expect(parseSourceRef('src/greet.js:2')).toEqual({ path: 'src/greet.js', line: 2 });
    expect(parseSourceRef('src/greet.js:3-18')).toEqual({
      path: 'src/greet.js',
      line: 3,
      endLine: 18,
    });
    expect(parseSourceRef('src/greet.js')).toEqual({ path: 'src/greet.js' });
  });
});

describe('buildImpactSummary', () => {
  it('lists every diff file with its exact changed lines (matches the diff)', () => {
    const extraction = makeExtraction();
    const summary = buildImpactSummary({
      implications: [],
      drift: { overall: 'no-semantic-change', perImplication: [] },
      extraction,
    });

    expect(summary.affectedFiles).toEqual([
      { path: 'src/greet.js', lines: [2, 3] },
    ]);
    // the lines are exactly the diff's changed lines (context lines excluded)
    for (const file of extraction.files) {
      const entry = summary.affectedFiles.find((f) => f.path === file.path);
      expect(entry).toBeDefined();
      expect(entry?.lines).toEqual(changedLineNumbers(file));
    }
  });

  it('merges implication sourceRefs into the file/line references', () => {
    const summary = buildImpactSummary({
      implications: [
        imp({ id: 'imp-1', sourceRefs: ['src/greet.js:2', 'src/greet.js:3'] }),
      ],
      drift: NEW_DRIFT,
      extraction: makeExtraction(),
    });

    // sourceRef lines coincide with the diff lines here — the merged view
    // still matches the diff exactly
    expect(summary.affectedFiles).toEqual([
      { path: 'src/greet.js', lines: [2, 3] },
    ]);

    // a pointer outside the changed cluster is kept as extra provenance
    const wider = buildImpactSummary({
      implications: [imp({ id: 'imp-1', sourceRefs: ['src/greet.js:3-4'] })],
      drift: NEW_DRIFT,
      extraction: makeExtraction(),
    });
    expect(wider.affectedFiles[0].lines).toContain(4);
    // ...but every diff-changed line is always present
    for (const n of [2, 3]) expect(wider.affectedFiles[0].lines).toContain(n);
  });

  it('collects affected requirement ids from drift matches and proposals', () => {
    const implications = [
      imp({ id: 'imp-a', text: 'Matched requirement changed.' }),
      imp({ id: 'imp-b', text: 'A brand new requirement appears.' }),
    ];
    const drift: DriftComparison = {
      overall: 'modified',
      perImplication: [
        { implicationId: 'imp-a', status: 'modified', matchedSectionId: 'sec-greeting', similarity: 0.5 },
        { implicationId: 'imp-b', status: 'new', similarity: 0 },
      ],
    };
    const proposals: SpecProposal[] = [
      {
        id: 'prop-1',
        changeId: 'chg',
        createdAt: '2026-10-17T00:00:00.000Z',
        title: 'New requirement',
        status: 'pending',
        implicationIds: ['imp-b'],
        driftStatus: 'new',
        sectionsTouched: ['req-imp-b'],
      },
    ];

    const summary = buildImpactSummary({
      implications,
      drift,
      extraction: makeExtraction(),
      proposals,
    });
    expect(summary.affectedRequirementIds).toEqual(['sec-greeting', 'req-imp-b']);
  });

  it('derives the recommended next action and confidence from the drift', () => {
    const extraction = makeExtraction();
    const conflicting: DriftComparison = {
      overall: 'conflicting',
      perImplication: [
        { implicationId: 'imp-1', status: 'conflicting', matchedSectionId: 'sec-1', similarity: 0.4 },
      ],
    };
    const summary = buildImpactSummary({
      implications: [imp({ id: 'imp-1', confidence: 0.5 }), imp({ id: 'imp-2', confidence: 0.7 })],
      drift: conflicting,
      extraction,
    });
    expect(summary.recommendedNextAction).toContain('conflicting requirement');
    expect(summary.confidence).toBeCloseTo(0.6, 5);

    const empty = buildImpactSummary({
      implications: [],
      drift: { overall: 'no-semantic-change', perImplication: [] },
      extraction,
    });
    expect(empty.recommendedNextAction).toBe('No action required.');
    expect(empty.confidence).toBe(1);
  });
});
