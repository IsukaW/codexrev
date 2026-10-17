import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EVAL_MODES,
  checkUpdateCorrectness,
  deltaTopicCoverage,
  fScore,
  matchImplications,
  median,
  p95,
  renderEvalMarkdown,
  runEvaluation,
  saveEvalReport,
  type EvalMode,
} from '../../../src/features/living-spec/testing/evaluationHarness.js';
import {
  loadEvalScenarios,
  validateEvalScenario,
  type EvalScenario,
} from '../../../src/features/living-spec/testing/evalScenario.js';
import { LivingSpecEvalError } from '../../../src/features/living-spec/tools/errors.js';
import { generateProposals } from '../../../src/features/living-spec/pipeline/ursPatcher.js';
import { compareDrift } from '../../../src/features/living-spec/pipeline/driftComparator.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import type { GenerateResponse } from '../../../src/core/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = path.join(HERE, 'fixtures', 'scenarios');

function response(text: string): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'completed',
  };
}

function port(text: string | Error): LLMPort {
  return {
    provider: 'ollama',
    model: 'scripted',
    generate: async () => {
      if (text instanceof Error) throw text;
      return response(text);
    },
  };
}

describe('scenario corpus (labelled fixtures)', () => {
  it('loads ≥12 valid scenarios covering every required change family', async () => {
    const scenarios = await loadEvalScenarios(CORPUS_DIR);
    expect(scenarios.length).toBeGreaterThanOrEqual(12);

    const ids = scenarios.map((s) => s.id);
    expect(ids).toEqual([...ids].sort()); // deterministic order
    const categories = new Set(scenarios.map((s) => s.category));
    for (const required of [
      'behaviour',
      'validation',
      'performance',
      'api',
      'security',
      'refactor',
    ]) {
      expect(categories).toContain(required);
    }
    // required families: new behaviour, changed validation, removed behaviour,
    // error handling, performance, API change, security, refactor-only ≥ 3
    expect(ids).toContain('new-behaviour-greeting');
    expect(ids).toContain('validation-email-plus-tags');
    expect(ids).toContain('removed-logout-endpoint');
    expect(ids).toContain('error-handling-propagate-timeout');
    expect(ids).toContain('performance-page-size-limit');
    expect(ids).toContain('api-interface-rename-serialize');
    expect(ids).toContain('security-token-validation-required');
    expect(scenarios.filter((s) => s.isRefactor).length).toBeGreaterThanOrEqual(3);

    // every scenario carries all three evidence parts
    for (const s of scenarios) {
      expect(s.diff.files.length).toBeGreaterThan(0);
      expect(s.urs.sections.length).toBeGreaterThan(0);
      expect(s.expected.driftStatus).toBeTruthy();
      expect(s.expected.testDeltaTopics).toBeInstanceOf(Array);
    }
  });

  it('rejects malformed scenarios with a coded eval error', () => {
    const base = (): Record<string, unknown> => ({
      id: 'valid-id',
      title: 't',
      category: 'behaviour',
      isRefactor: false,
      diff: { files: [{ path: 'a.js', before: 'x', after: 'y' }] },
      urs: { sections: [{ id: 'r', title: 'T', text: 'text' }] },
      expected: { driftStatus: 'new', implications: [], testDeltaTopics: [] },
    });
    expect(validateEvalScenario(base()).id).toBe('valid-id');
    expect(() => validateEvalScenario({ ...base(), id: 'Bad Id!' })).toThrow(LivingSpecEvalError);
    expect(() =>
      validateEvalScenario({ ...base(), expected: { ...base().expected, driftStatus: 'sideways' } }),
    ).toThrow(/driftStatus/);
    expect(() =>
      validateEvalScenario({
        ...base(),
        diff: { files: [{ path: 'a.js', before: 'same', after: 'same' }] },
      }),
    ).toThrow(/identical/);
    expect(() => validateEvalScenario({ ...base(), diff: { files: [] } })).toThrow(/non-empty/);
    expect(() => validateEvalScenario('nope')).toThrow(/object/);
  });

  it('fails clearly on a missing corpus directory', async () => {
    await expect(loadEvalScenarios(path.join(os.tmpdir(), 'definitely-not-a-corpus'))).rejects.toThrow(
      LivingSpecEvalError,
    );
  });
});

describe('metric primitives', () => {
  it('computes median and nearest-rank P95', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(p95([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBe(100);
    expect(p95([1])).toBe(1);
    expect(p95([])).toBe(0);
  });

  it('computes the F1 from precision and recall', () => {
    expect(fScore(1, 1)).toBe(1);
    expect(fScore(0, 0)).toBe(0);
    expect(fScore(0.5, 0.5)).toBeCloseTo(0.5, 6);
    expect(fScore(2 / 3, 1)).toBeCloseTo(0.8, 6);
  });

  it('matches expected against predicted implications greedily', () => {
    const predicted = [
      { id: 'a', kind: 'functional' as const, text: 'The greeting must include the caller name.', confidence: 0.9, sourceRefs: [] },
      { id: 'b', kind: 'functional' as const, text: 'Unrelated extra prediction.', confidence: 0.9, sourceRefs: [] },
    ];
    const hit = matchImplications(['The greeting must include the caller name.'], predicted, 0.4);
    expect(hit).toEqual({ tp: 1, fp: 1, fn: 0 });

    const miss = matchImplications(['Pagination caps must apply everywhere.'], predicted, 0.4);
    expect(miss).toEqual({ tp: 0, fp: 2, fn: 1 });

    const none = matchImplications([], predicted, 0.4);
    expect(none).toEqual({ tp: 0, fp: 2, fn: 0 });
  });

  it('scores test-delta topic coverage as a token subset match', () => {
    const deltas = [
      {
        id: 't1',
        title: 'Reject invalid access tokens',
        type: 'new' as const,
        linkedImplicationId: 'i1',
        linkedRequirementId: 'r1',
        preconditions: [],
        steps: ['send a request with an expired token'],
        expected: 'the request is rejected as unauthorized',
        priority: 'high' as const,
        rationale: 'security rule',
      },
    ];
    expect(deltaTopicCoverage(['access token'], deltas)).toBe(1);
    expect(deltaTopicCoverage(['unauthorized'], deltas)).toBe(1);
    expect(deltaTopicCoverage(['quantum entanglement'], deltas)).toBe(0);
    expect(deltaTopicCoverage([], deltas)).toBe(1);
    expect(deltaTopicCoverage(['access token'], [])).toBe(0);
  });
});

describe('runEvaluation — offline scripted run over the real corpus', () => {
  it('produces the full report with the designed mode comparison', async () => {
    const scenarios = await loadEvalScenarios(CORPUS_DIR);
    const report = await runEvaluation({ scenarios, corpusDir: CORPUS_DIR });

    expect(report.schemaVersion).toBe(1);
    expect(report.corpus.scenarioCount).toBe(scenarios.length);
    expect(report.provider).toEqual({ model: 'label-echo', live: false });
    expect(report.modes).toEqual(EVAL_MODES);
    expect(report.notes).toHaveLength(3);
    expect(report.scenarios).toHaveLength(scenarios.length * EVAL_MODES.length);

    const full = report.aggregate.full!;
    expect(full.implication).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(full.driftAccuracy).toBe(1);
    expect(full.falseAlertRate).toBe(0);
    expect(full.refactorScenarios).toBeGreaterThanOrEqual(3);
    expect(full.updateCorrectnessRate).toBe(1);
    expect(full.deltaRelevanceMean).toBeGreaterThan(0.5);
    expect(full.latencyMedianMs).toBeGreaterThanOrEqual(0);
    expect(full.latencyP95Ms).toBeGreaterThanOrEqual(full.latencyMedianMs);
    expect(full.peakRssBytes).toBeGreaterThan(0);

    // floor baseline: no model → no implications, chance-level drift
    const batch = report.aggregate.batch!;
    expect(batch.implication.recall).toBe(0);
    expect(batch.driftAccuracy).toBeLessThan(0.5);
    expect(batch.updateCorrectnessRate).toBeNull();

    // single-pass exercises the baseline schema path end-to-end
    expect(report.aggregate['single-pass']!.driftAccuracy).toBe(1);
    expect(report.scenarios.every((r) => r.inferenceError === null)).toBe(true);
  }, 30_000);

  it('computes precision/recall exactly for an imperfect provider', async () => {
    // drop the first expected implication and add one wrong prediction:
    // scenario with 2 expected → tp=1 fp=1 fn=1 → P=R=F1=0.5 (micro over 1 scenario)
    const scenario: EvalScenario = validateEvalScenario({
      id: 'imperfect-fixture',
      title: 'two expected implications',
      category: 'behaviour',
      isRefactor: false,
      diff: {
        files: [{ path: 'src/a.js', before: 'const a = 1;\n', after: 'const a = 2;\n' }],
      },
      urs: { sections: [{ id: 'req-x', title: 'X', text: 'Something entirely unrelated here.' }] },
      expected: {
        driftStatus: 'new',
        implications: [
          { text: 'Alpha requirement about widget rotation.' },
          { text: 'Beta requirement about cache eviction.' },
        ],
        testDeltaTopics: [],
      },
    });

    const report = await runEvaluation({
      scenarios: [scenario],
      modes: ['full'],
      createProvider: () =>
        port(
          JSON.stringify({
            implications: [
              {
                id: 'imp-1',
                kind: 'functional',
                text: 'Alpha requirement about widget rotation.',
                rationale: 'r',
                confidence: 0.9,
                sourceRefs: [{ path: 'src/a.js', line: 1 }],
              },
              {
                id: 'imp-2',
                kind: 'functional',
                text: 'Totally wrong extra implication about logging.',
                rationale: 'r',
                confidence: 0.9,
                sourceRefs: [{ path: 'src/a.js', line: 1 }],
              },
            ],
            behaviourChangeSummary: 'x',
            requiresUrsUpdate: true,
          }),
        ),
    });

    const row = report.scenarios[0];
    expect(row.implication).toMatchObject({ expected: 2, predicted: 2, tp: 1, fp: 1, fn: 1 });
    expect(row.implication.precision).toBeCloseTo(0.5, 6);
    expect(row.implication.recall).toBeCloseTo(0.5, 6);
    expect(row.implication.f1).toBeCloseTo(0.5, 6);
  });

  it('records a structured inference error and degrades instead of crashing on malformed output', async () => {
    const scenarios = await loadEvalScenarios(CORPUS_DIR);
    const report = await runEvaluation({
      scenarios: scenarios.slice(0, 1),
      modes: ['full'],
      createProvider: () => port('not json at all'),
    });
    const row = report.scenarios[0];
    expect(row.inferenceError).toBe('malformed_output');
    expect(row.implication.recall).toBe(0);
    expect(row.drift.correct).toBe(false);
  });

  it('records timeouts as structured inference errors', async () => {
    const scenarios = await loadEvalScenarios(CORPUS_DIR);
    const hanging: LLMPort = {
      provider: 'ollama',
      model: 'hanging',
      generate: () => new Promise<GenerateResponse>(() => undefined),
    };
    const report = await runEvaluation({
      scenarios: scenarios.slice(0, 1),
      modes: ['single-pass'],
      createProvider: () => hanging,
      timeoutMs: 25,
    });
    expect(report.scenarios[0].inferenceError).toBe('timeout');
  }, 15_000);
});

describe('checkUpdateCorrectness (scoped-sections invariant, SO4)', () => {
  const doc = {
    schemaVersion: 1 as const,
    title: 'URS',
    sections: [
      {
        id: 'req-a',
        title: 'A',
        text: 'Requirement A must hold.',
        type: 'functional' as const,
        version: 1,
        lastChangeId: 'x',
        sourceRefs: [],
      },
      {
        id: 'req-b',
        title: 'B',
        text: 'Requirement B must hold.',
        type: 'functional' as const,
        version: 1,
        lastChangeId: 'x',
        sourceRefs: [],
      },
    ],
  };

  it('accepts proposals whose patches touch only their own section', () => {
    const implications = [
      {
        id: 'imp-1',
        kind: 'functional' as const,
        text: 'Requirement A must hold with the new bound.',
        confidence: 0.9,
        sourceRefs: [],
      },
    ];
    const drift = compareDrift(implications, doc);
    const proposals = generateProposals({
      implications,
      drift,
      doc,
      changeId: 'chg',
      timestamp: '2026-10-17T00:00:00.000Z',
    });
    expect(
      checkUpdateCorrectness(
        { implications, drift, proposals, deltas: [], alerts: [], inferenceError: null },
        doc,
      ),
    ).toBe(true);
  });

  it('rejects an actionable drift with no proposals, and patches touching foreign sections', () => {
    const implications = [
      {
        id: 'imp-1',
        kind: 'functional' as const,
        text: 'Requirement A must hold with the new bound.',
        confidence: 0.9,
        sourceRefs: [],
      },
    ];
    const drift = compareDrift(implications, doc);
    // actionable drift but no proposals → mechanism broken
    expect(
      checkUpdateCorrectness(
        { implications, drift, proposals: [], deltas: [], alerts: [], inferenceError: null },
        doc,
      ),
    ).toBe(false);

    // a patch that claims to touch req-b but actually modifies req-a
    const good = generateProposals({
      implications,
      drift,
      doc,
      changeId: 'chg',
      timestamp: '2026-10-17T00:00:00.000Z',
    });
    const tampered = good.map((p) => ({
      ...p,
      sectionsTouched: ['req-b'],
      patch: { ...p.patch!, ops: [{ ...p.patch!.ops[0], sectionId: 'req-b' }] },
    }));
    // 'modify' of a section id that does exist but content-wise mismatch is
    // fine for scoping; make it truly foreign instead:
    const foreign = good.map((p) => ({
      ...p,
      patch: { ...p.patch!, ops: [{ ...p.patch!.ops[0], sectionId: 'req-missing' }] },
    }));
    expect(
      checkUpdateCorrectness(
        { implications, drift, proposals: tampered, deltas: [], alerts: [], inferenceError: null },
        doc,
      ),
    ).toBe(false);
    expect(
      checkUpdateCorrectness(
        { implications, drift, proposals: foreign, deltas: [], alerts: [], inferenceError: null },
        doc,
      ),
    ).toBe(false);
  });
});

describe('renderEvalMarkdown + saveEvalReport', () => {
  it('renders the summary and per-scenario tables', async () => {
    const scenarios = await loadEvalScenarios(CORPUS_DIR);
    const report = await runEvaluation({ scenarios, modes: ['batch'] as EvalMode[] });
    const md = renderEvalMarkdown(report);
    expect(md).toContain('# Living-spec evaluation');
    expect(md).toContain(`${scenarios.length} scenarios`);
    expect(md).toContain('## Mode definitions');
    expect(md).toContain('| Mode | Implication P |');
    expect(md).toContain('| batch |');
    expect(md).toContain('## Per-scenario results');
    expect(md).toContain('| removed-logout-endpoint | behaviour | batch | conflicting |');
    expect(md).not.toContain('| full |'); // unrequested modes stay out
  }, 30_000);

  it('writes eval-<timestamp>.json and .md that round-trip', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-eval-')));
    try {
      const scenarios = await loadEvalScenarios(CORPUS_DIR);
      const report = await runEvaluation({ scenarios, modes: ['batch'] });
      const saved = await saveEvalReport(tmp, report);
      expect(saved.jsonPath).toMatch(/eval-.*\.json$/);
      expect(saved.mdPath).toMatch(/eval-.*\.md$/);

      const parsed = JSON.parse(await fs.readFile(saved.jsonPath, 'utf-8'));
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.scenarios).toHaveLength(scenarios.length);
      const md = await fs.readFile(saved.mdPath, 'utf-8');
      expect(md).toContain('Summary by mode');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
