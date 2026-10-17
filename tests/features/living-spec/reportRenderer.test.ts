import { describe, expect, it } from 'vitest';
import {
  padAnsi,
  renderAnalyzeHeader,
  renderDecisionResult,
  renderDriftLine,
  renderFileLine,
  renderHistoryReport,
  renderImplicationsSection,
  renderInferenceFailure,
  renderOutputSideSection,
  renderSpecUsage,
  renderStatusReport,
  renderTruncationNotice,
  visibleLength,
} from '../../../src/features/living-spec/cli/reportRenderer.js';
import { formatDriftAlert } from '../../../src/features/living-spec/pipeline/driftAlert.js';
import type { ExtractedDiff } from '../../../src/features/living-spec/pipeline/diffExtractor.js';
import type {
  SpecAnalysisResult,
  SpecChangeDriftAlert,
  SpecImplication,
  SpecProposal,
  SpecTestCaseDelta,
  UrsVersionSnapshot,
} from '../../../src/features/living-spec/pipeline/types.js';
import { makeSpecAnalysisResult } from '../../../src/features/living-spec/testing/fixtures.js';

// Vitest runs with a non-TTY stdout, so the palette is the NO_COLOR variant
// and every rendered string is plain text — exactly what piped/CI output sees.

function makeExtraction(overrides: Partial<ExtractedDiff> = {}): ExtractedDiff {
  return {
    ref: 'staged',
    files: [
      {
        path: 'src/greet.js',
        status: 'modified',
        linesAdded: 2,
        linesRemoved: 1,
        hunks: [],
        minimalPatch: '',
      },
    ],
    truncated: false,
    totalBytes: 128,
    omittedPaths: [],
    raw: 'diff',
    maxBytes: 204800,
    ...overrides,
  };
}

describe('renderAnalyzeHeader', () => {
  it('renders the change id, file totals, file table and report location', () => {
    const result = makeSpecAnalysisResult();
    const lines = renderAnalyzeHeader({
      extraction: makeExtraction(),
      result,
      root: '/repo',
      reportFile: '/repo/.codexrev/living-spec/reports/staged.json',
    }).join('\n');

    expect(lines).toContain('analysis of staged in /repo');
    expect(lines).toContain(result.changeId);
    expect(lines).toContain('1 file(s) changed: +2 -1');
    expect(lines).toContain('src/greet.js');
    expect(lines).toContain('+2 -1');
    expect(lines).toContain('modified');
    expect(lines).toContain('report written: /repo/.codexrev/living-spec/reports/staged.json');
  });

  it('says the dry run wrote nothing', () => {
    const lines = renderAnalyzeHeader({
      extraction: makeExtraction(),
      result: makeSpecAnalysisResult(),
      root: '/repo',
      reportFile: null,
    }).join('\n');
    expect(lines).toContain('(dry-run) report not written');
    expect(lines).not.toContain('report written:');
  });

  it('shows the rename direction for renamed files', () => {
    const line = renderFileLine({
      path: 'src/new.js',
      oldPath: 'src/old.js',
      status: 'renamed',
      linesAdded: 0,
      linesRemoved: 0,
      hunks: [],
      minimalPatch: '',
    });
    expect(line).toContain('src/old.js → src/new.js');
  });
});

describe('renderImplicationsSection', () => {
  it('renders an aligned table with kind, confidence, category and id', () => {
    const implications: SpecImplication[] = [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The greeting must include the caller name.',
        confidence: 0.88,
        sourceRefs: ['src/greet.js:2'],
        category: 'behaviour',
      },
      {
        id: 'imp-2',
        kind: 'nfr',
        text: 'Analysis must finish under 2 s.',
        confidence: 0.6,
        sourceRefs: ['src/greet.js:3'],
      },
    ];
    const out = renderImplicationsSection(implications).join('\n');
    expect(out).toContain('requirement implications (2)');
    expect(out).toContain('KIND');
    expect(out).toContain('CONF');
    expect(out).toContain('CATEGORY');
    expect(out).toContain('functional');
    expect(out).toContain('0.88');
    expect(out).toContain('behaviour');
    expect(out).toContain('nfr');
    expect(out).toMatch(/nfr\s+0\.60\s+-/); // absent category shows as a placeholder
  });

  it('marks the deterministic-only case', () => {
    expect(renderImplicationsSection([]).join('\n')).toContain('deterministic analysis only');
  });
});

describe('renderOutputSideSection', () => {
  const deltas: SpecTestCaseDelta[] = [
    {
      id: 'test-imp-1',
      title: 'Cover: greeting',
      type: 'new',
      linkedImplicationId: 'imp-1',
      linkedRequirementId: 'req-imp-1',
      preconditions: [],
      steps: ['do the thing'],
      expected: 'works',
      priority: 'high',
      rationale: 'rule',
    },
    {
      id: 'test-imp-2',
      title: 'Rework: greeting',
      type: 'update',
      linkedImplicationId: 'imp-2',
      linkedRequirementId: 'sec-greeting',
      preconditions: [],
      steps: ['do the thing'],
      expected: 'works',
      priority: 'low',
      rationale: 'rule',
    },
  ];
  const alert: SpecChangeDriftAlert = {
    changeId: 'chg',
    file: 'src/greet.js',
    reason: 'Requirement "Greeting" (sec-greeting) conflicts with this change.',
    affectedRequirement: 'sec-greeting',
    proposedNextAction: 'Reconcile the conflict with requirement sec-greeting.',
    severity: 'critical',
    timestamp: '2026-10-17T00:00:00.000Z',
  };
  const impact: SpecAnalysisResult['impactSummary'] = {
    affectedRequirementIds: ['req-imp-1', 'sec-greeting'],
    affectedFiles: [{ path: 'src/greet.js', lines: [2, 3] }],
    recommendedNextAction: 'Review the pending URS proposals.',
    confidence: 0.88,
  };

  it('renders the aligned delta table, impact block and alerts', () => {
    const out = renderOutputSideSection({
      testDeltas: deltas,
      driftAlerts: [alert],
      impactSummary: impact,
      synthesis: { refined: false },
    }).join('\n');

    expect(out).toContain('test deltas:     2 (1 new, 1 update, 0 obsolete — rules)');
    expect(out).toContain('TYPE');
    expect(out).toContain('PRIORITY');
    expect(out).toContain('REQUIREMENT');
    expect(out).toContain('NEW');
    expect(out).toContain('UPDATE');
    expect(out).toContain('test-imp-1');
    expect(out).toContain('req-imp-1');

    expect(out).toContain('requirements: req-imp-1, sec-greeting');
    expect(out).toContain('files: src/greet.js:2,3');
    expect(out).toContain('next: Review the pending URS proposals.');
    expect(out).toContain('confidence: 0.88');

    expect(out).toContain('drift alerts:    1');
    expect(out).toContain('CRITICAL');
    expect(out).toContain(formatDriftAlert(alert).trim());
  });

  it('marks LLM-refined deltas and the empty case', () => {
    const out = renderOutputSideSection({
      testDeltas: [],
      driftAlerts: [],
      impactSummary: { ...impact, affectedFiles: [], affectedRequirementIds: [] },
      synthesis: { refined: true },
    }).join('\n');
    expect(out).toContain('test deltas:     0');
    expect(out).toContain('drift alerts:    (none)');
    expect(out).toContain('requirements: (none)');
    expect(out).toContain('files: (none)');
  });
});

describe('renderDriftLine', () => {
  it('shows the drift status and pending proposal ids', () => {
    const result = makeSpecAnalysisResult({ proposalIds: ['chg-1', 'chg-2'] });
    const out = renderDriftLine(result);
    expect(out).toContain('drift:           modified');
    expect(out).toContain('proposals:       chg-1, chg-2 (pending — accept/reject/defer)');
  });

  it('omits the proposals line when there are none', () => {
    const out = renderDriftLine(makeSpecAnalysisResult({ proposalIds: [] }));
    expect(out).toContain('drift:');
    expect(out).not.toContain('proposals:');
  });
});

describe('failure-path UX', () => {
  it('tells the user to start the model server when it is unavailable', () => {
    const out = renderInferenceFailure('provider_unavailable', 'ECONNREFUSED 127.0.0.1:1234').join('\n');
    expect(out).toContain('provider_unavailable');
    expect(out).toContain('start ollama / lm studio');
    expect(out).toContain('--dry-run');
  });

  it('suggests --dry-run on a timeout', () => {
    const out = renderInferenceFailure('timeout', 'timed out').join('\n');
    expect(out).toContain('--dry-run');
  });

  it('explains that malformed model output was never applied (NFR5)', () => {
    const out = renderInferenceFailure('malformed_output', 'no JSON found').join('\n');
    expect(out).toContain('nothing was applied or persisted');
    expect(out).toContain('NFR5');
    expect(out).toContain('deterministic analysis stands');
    expect(out).not.toContain('--dry-run');
  });

  it('explains schema-invalid output too', () => {
    expect(renderInferenceFailure('schema_invalid', '/implications 0 is too short').join('\n')).toContain(
      'nothing was applied or persisted',
    );
  });

  it('explains truncation and how to widen it', () => {
    const out = renderTruncationNotice(
      makeExtraction({
        truncated: true,
        totalBytes: 5000,
        maxBytes: 1000,
        omittedPaths: ['src/a.ts', 'src/b.ts'],
      }),
    );
    expect(out).toContain('truncated at 1000 of 5000 bytes');
    expect(out).toContain('2 file(s) omitted');
    expect(out).toContain('src/a.ts, src/b.ts');
    expect(out).toContain('maxBytes');
    expect(out).toContain('results are partial');
  });
});

describe('status / history / decisions', () => {
  const alert: SpecChangeDriftAlert = {
    changeId: 'chg',
    file: 'src/greet.js',
    reason: 'conflict',
    affectedRequirement: 'sec-greeting',
    proposedNextAction: 'reconcile',
    severity: 'critical',
    timestamp: '2026-10-17T00:00:00.000Z',
  };
  const proposal: SpecProposal = {
    id: 'prop-1',
    changeId: 'chg',
    createdAt: '2026-10-17T00:00:00.000Z',
    title: 'Update greeting',
    status: 'deferred',
    driftStatus: 'modified',
    sectionsTouched: ['sec-greeting'],
    implicationIds: ['imp-1'],
  };

  it('renders the status report with proposals and a bounded alert tail', () => {
    const out = renderStatusReport({
      root: '/repo',
      stateDir: '/repo/.codexrev/living-spec',
      watchedPaths: ['**/*.ts', '**/*.js'],
      debounceMs: 800,
      modelOverride: null,
      ursVersion: 'v2 (updated 2026-10-17T00:00:00.000Z)',
      openProposals: [proposal],
      alerts: [alert],
      alertsTotal: 7,
      alertLimit: 5,
    }).join('\n');

    expect(out).toContain('status (/repo)');
    expect(out).toContain('watched paths:     **/*.ts, **/*.js');
    expect(out).toContain('debounce:          800 ms');
    expect(out).toContain('model override:    (settings default)');
    expect(out).toContain('URS version:       v2 (updated 2026-10-17T00:00:00.000Z)');
    expect(out).toContain('prop-1  deferred [modified]  Update greeting → sec-greeting');
    expect(out).toContain('drift alerts:      7 recorded (latest 1)');
    expect(out).toContain('critical');
    expect(out).toContain('src/greet.js');
  });

  it('renders the empty status case', () => {
    const out = renderStatusReport({
      root: '/repo',
      stateDir: '/repo/.codexrev/living-spec',
      watchedPaths: ['**/*'],
      debounceMs: 800,
      modelOverride: 'ollama/llama3.1',
      ursVersion: 'none yet',
      openProposals: [],
      alerts: [],
      alertsTotal: 0,
      alertLimit: 5,
    }).join('\n');
    expect(out).toContain('open proposals:    (none)');
    expect(out).toContain('drift alerts:      (none)');
    expect(out).toContain('model override:    ollama/llama3.1');
    expect(out).toContain('URS version:       none yet');
  });

  it('renders the history table with version, action and change id', () => {
    const snapshots: UrsVersionSnapshot[] = [
      {
        version: 1,
        changeId: 'seed',
        createdAt: '2026-10-17T00:00:00.000Z',
        timestamp: '2026-10-17T00:00:00.000Z',
        action: 'seed',
        markdown: '',
        urs: { schemaVersion: 1, title: 'URS', sections: [] },
      },
      {
        version: 2,
        changeId: 'chg-abc',
        createdAt: '2026-10-17T01:00:00.000Z',
        timestamp: '2026-10-17T01:00:00.000Z',
        action: 'accept',
        markdown: '',
        urs: { schemaVersion: 1, title: 'URS', sections: [] },
      },
    ];
    const out = renderHistoryReport(snapshots).join('\n');
    expect(out).toContain('URS versions:');
    expect(out).toContain('v1');
    expect(out).toContain('seed');
    expect(out).toContain('v2');
    expect(out).toContain('accept');
    expect(out).toContain('chg-abc');
  });

  it('renders the empty history case', () => {
    expect(renderHistoryReport([]).join('\n')).toBe('No URS versions recorded yet.');
  });

  it('renders decision results with the proposal id and outcome', () => {
    expect(renderDecisionResult({ decision: 'accept', proposal, version: 3 }).join('\n')).toBe(
      '✓ proposal prop-1 accepted — URS updated to v3',
    );
    expect(
      renderDecisionResult({ decision: 'accept', proposal: { ...proposal, id: 'prop-2' } }).join('\n'),
    ).toBe('✓ proposal prop-2 accepted (no patch to apply)');
    expect(renderDecisionResult({ decision: 'reject', proposal }).join('\n')).toContain(
      '✓ proposal prop-1 rejected',
    );
    expect(renderDecisionResult({ decision: 'defer', proposal }).join('\n')).toContain(
      '✓ proposal prop-1 deferred',
    );
  });
});

describe('renderSpecUsage', () => {
  it('lists the subcommands and global flags', () => {
    const usage = renderSpecUsage();
    expect(usage).toContain('usage: codexrev spec <subcommand>');
    expect(usage).toContain('analyze');
    expect(usage).toContain('watch');
    expect(usage).toContain('accept <id>');
    expect(usage).toContain('--project <path>');
    expect(usage).toContain('--quiet');
    expect(usage).toContain('codexrev spec help');
  });
});

describe('padAnsi / visibleLength', () => {
  it('pads by visible width, ignoring ANSI codes', () => {
    const colored = '\x1b[31merr\x1b[0m';
    expect(visibleLength(colored)).toBe(3);
    expect(visibleLength(padAnsi(colored, 6))).toBe(6);
    expect(visibleLength(padAnsi('err', 6, 'right'))).toBe(6);
    expect(padAnsi('err', 6)).toBe('err   ');
  });
});
