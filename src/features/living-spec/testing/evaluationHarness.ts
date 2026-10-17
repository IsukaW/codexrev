/**
 * Evaluation harness — the controlled-evaluation layer of the design-science
 * study. Replays a labelled scenario corpus through the living-spec pipeline
 * in three comparison modes, all consuming the SAME inputs:
 *
 *   A) `batch`       — manual/batch analysis: the deterministic front half
 *                      only (diff extraction, no model, no URS semantics).
 *                      The pre-feature status quo / floor.
 *   B) `single-pass` — one code→requirement prompt WITHOUT the prior-URS
 *                      comparison: the model must also GUESS the drift
 *                      status from the diff alone. Comparing B with C
 *                      isolates the drift mechanism (comparator + URS).
 *   C) `full`        — the shipped pipeline, explicit invocation:
 *                      implications (schema-validated) → driftComparator →
 *                      scoped proposals → test deltas → drift alerts.
 *
 * Everything is injectable (llmPort, clock) so CI runs offline against the
 * deterministic label-echo provider — no network — while `--live` swaps in a
 * real local model. Modes are evaluation-only: nothing here ships as a user
 * workflow beyond `codexrev spec eval`.
 */

import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { reportsDir } from '../tools/stateStore.js';
import { LivingSpecEvalError } from '../tools/errors.js';
import { compareDrift, tokenOverlapSimilarity, type DriftComparison } from '../pipeline/driftComparator.js';
import {
  extractJson,
  generateWithTimeout,
  runImplicationInference,
} from '../pipeline/inferenceEngine.js';
import { formatDiffForPrompt } from '../pipeline/promptBuilder.js';
import { renderUrsMarkdown } from '../pipeline/ursModel.js';
import { applyPatch, generateProposals, validatePatch } from '../pipeline/ursPatcher.js';
import { buildDriftAlerts } from '../pipeline/driftAlert.js';
import { synthesizeTestDeltas } from '../pipeline/testDeltaSynthesizer.js';
import type { LLMPort } from '../pipeline/llmPort.js';
import type {
  SpecDriftStatus,
  SpecImplication,
  SpecTestCaseDelta,
  UrsDocument,
} from '../pipeline/types.js';
import {
  buildSinglePassPrompt,
  buildSyntheticExtraction,
  createLabelEchoProvider,
  validateSinglePassOutput,
  type EvalScenario,
} from './evalScenario.js';

export type EvalMode = 'batch' | 'single-pass' | 'full';

export const EVAL_MODES: readonly EvalMode[] = ['batch', 'single-pass', 'full'];

export const EVAL_MODE_NOTES: Record<EvalMode, string> = {
  batch:
    'Baseline A — manual/batch: deterministic front half only (no model, no URS semantics).',
  'single-pass':
    'Baseline B — single code→requirement prompt without prior-URS comparison; the model guesses driftStatus from the diff alone.',
  full:
    'C — the full shipped pipeline: schema-validated implications → drift comparator → scoped proposals → test deltas → drift alerts.',
};

// ── Report shapes ─────────────────────────────────────────────────────

export interface ScenarioImplicationMetrics {
  readonly expected: number;
  readonly predicted: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface ScenarioMetrics {
  readonly scenarioId: string;
  readonly category: string;
  readonly isRefactor: boolean;
  readonly mode: EvalMode;
  readonly latencyMs: number;
  readonly rssBytes: number;
  /** Null when the semantic half ran (or was not asked for). */
  readonly inferenceError: string | null;
  readonly implication: ScenarioImplicationMetrics;
  readonly drift: {
    readonly expected: SpecDriftStatus;
    readonly predicted: SpecDriftStatus;
    readonly correct: boolean;
  };
  /** An alert-worthy prediction on a refactor-only change. */
  readonly falseAlert: boolean;
  /** Scoped-update mechanism check (full mode only; null elsewhere). */
  readonly updateCorrectness: boolean | null;
  /** Fraction of expected test-delta topics covered (rule-match or judge). */
  readonly deltaRelevance: number | null;
}

export interface ModeAggregate {
  readonly mode: EvalMode;
  readonly scenarios: number;
  /** Micro-averaged over all implications in the mode. */
  readonly implication: { readonly precision: number; readonly recall: number; readonly f1: number };
  readonly driftAccuracy: number;
  readonly falseAlertRate: number;
  readonly refactorScenarios: number;
  readonly updateCorrectnessRate: number | null;
  readonly deltaRelevanceMean: number | null;
  readonly latencyMedianMs: number;
  readonly latencyP95Ms: number;
  readonly peakRssBytes: number;
}

export interface EvalReport {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Total wall-clock duration of the evaluation run (ms). */
  readonly durationMs: number;
  readonly corpus: {
    readonly dir: string | null;
    readonly scenarioCount: number;
  };
  readonly modes: readonly EvalMode[];
  readonly provider: { readonly model: string; readonly live: boolean };
  readonly matchThreshold: number;
  /** Definitions of the comparison modes (assessed evidence). */
  readonly notes: readonly string[];
  readonly aggregate: Readonly<Partial<Record<EvalMode, ModeAggregate>>>;
  readonly scenarios: readonly ScenarioMetrics[];
}

// ── Metric primitives ─────────────────────────────────────────────────

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank P95 (assessed latency budget evidence). */
export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

export function fScore(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/**
 * Greedy expected↔predicted matching by token overlap. A predicted
 * implication "matches" an expected one when the overlap reaches the
 * threshold; each prediction and each expectation is used at most once.
 */
export function matchImplications(
  expectedTexts: readonly string[],
  predicted: readonly SpecImplication[],
  threshold: number,
): { readonly tp: number; readonly fp: number; readonly fn: number } {
  const unmatched = new Set<number>(predicted.map((_, i) => i));
  let tp = 0;
  for (const text of expectedTexts) {
    let best = -1;
    let bestSim = threshold;
    for (const i of unmatched) {
      const sim = tokenOverlapSimilarity(text, predicted[i].text);
      if (sim >= bestSim) {
        best = i;
        bestSim = sim;
      }
    }
    if (best >= 0) {
      unmatched.delete(best);
      tp++;
    }
  }
  return { tp, fp: unmatched.size, fn: expectedTexts.length - tp };
}

/** Fraction of expected test-delta topics whose tokens appear in a delta. */
export function deltaTopicCoverage(
  topics: readonly string[],
  deltas: readonly SpecTestCaseDelta[],
): number {
  if (topics.length === 0) return 1;
  const corpus = deltas
    .map((d) => `${d.title} ${d.expected} ${d.rationale} ${d.steps.join(' ')} ${d.preconditions.join(' ')}`)
    .join(' ')
    .toLowerCase();
  const corpusTokens = new Set(corpus.split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  let covered = 0;
  for (const topic of topics) {
    const tokens = topic.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    if (tokens.length > 0 && tokens.every((t) => corpusTokens.has(t))) covered++;
  }
  return ratio(covered, topics.length);
}

// ── Per-scenario pipeline runs ────────────────────────────────────────

function buildUrsDoc(scenario: EvalScenario): UrsDocument {
  return {
    schemaVersion: 1,
    title: `Eval URS for ${scenario.id}`,
    sections: scenario.urs.sections.map((s) => ({
      id: s.id,
      title: s.title,
      text: s.text,
      type: 'functional',
      version: 1,
      lastChangeId: 'prior',
      sourceRefs: [],
    })),
  };
}

function asComparison(driftStatus: SpecDriftStatus, implications: readonly SpecImplication[]): DriftComparison {
  return {
    overall: driftStatus,
    perImplication: implications.map((imp) => ({
      implicationId: imp.id,
      status: driftStatus,
      similarity: 0,
    })),
  };
}

const ACTIONABLE = new Set(['new', 'modified', 'conflicting']);

interface ModeRun {
  readonly implications: readonly SpecImplication[];
  readonly drift: DriftComparison;
  readonly proposals: ReturnType<typeof generateProposals>;
  readonly deltas: readonly SpecTestCaseDelta[];
  readonly alerts: ReturnType<typeof buildDriftAlerts>;
  readonly inferenceError: string | null;
}

async function runBatchMode(scenario: EvalScenario): Promise<ModeRun> {
  void scenario;
  return {
    implications: [],
    drift: { overall: 'no-semantic-change', perImplication: [] },
    proposals: [],
    deltas: [],
    alerts: [],
    inferenceError: null,
  };
}

function classifyGenerateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return /timed out|abort/i.test(message) ? 'timeout' : 'provider_error';
}

async function runSinglePassMode(
  scenario: EvalScenario,
  llm: LLMPort,
  model: string,
  timeoutMs: number,
): Promise<ModeRun> {
  const extraction = buildSyntheticExtraction(scenario);
  const prompt = buildSinglePassPrompt(formatDiffForPrompt(extraction.files));
  let payload: unknown;
  try {
    const response = await generateWithTimeout(
      llm,
      {
        model,
        systemInstruction: prompt.system,
        messages: [{ role: 'user', parts: [{ kind: 'text', text: prompt.user }] }],
        temperature: 0.2,
      },
      timeoutMs,
    );
    payload = extractJson(
      response.message.parts
        .filter((p) => p.kind === 'text')
        .map((p) => p.text)
        .join(''),
    );
  } catch (err) {
    return {
      implications: [],
      drift: { overall: 'no-semantic-change', perImplication: [] },
      proposals: [],
      deltas: [],
      alerts: [],
      inferenceError: classifyGenerateError(err),
    };
  }

  const validated = validateSinglePassOutput(payload);
  if (!validated.ok) {
    return {
      implications: [],
      drift: { overall: 'no-semantic-change', perImplication: [] },
      proposals: [],
      deltas: [],
      alerts: [],
      inferenceError: `schema_invalid: ${validated.errors.join('; ')}`,
    };
  }

  const implications: SpecImplication[] = validated.value.implications.map((imp, i) => ({
    id: imp.id || `imp-${i + 1}`,
    kind: imp.kind,
    text: imp.text,
    confidence: imp.confidence,
    sourceRefs: imp.sourceRefs.map((r) => `${r.path}:${r.line}`),
    rationale: imp.rationale,
    ...(imp.category !== undefined ? { category: imp.category } : {}),
  }));
  const drift = asComparison(validated.value.driftStatus, implications);
  // Baseline B has no patcher and no comparator by design — deltas are still
  // derived by rule from the guessed drift so delta relevance is comparable.
  const synthesis = await synthesizeTestDeltas({ implications, drift });
  return {
    implications,
    drift,
    proposals: [],
    deltas: synthesis.deltas,
    alerts: buildDriftAlerts({
      changeId: `eval-${scenario.id}`,
      timestamp: '1970-01-01T00:00:00.000Z',
      implications,
      drift,
    }),
    inferenceError: null,
  };
}

async function runFullMode(
  scenario: EvalScenario,
  priorDoc: UrsDocument,
  llm: LLMPort,
  model: string,
  providerLabel: string,
  timeoutMs: number,
): Promise<ModeRun> {
  const extraction = buildSyntheticExtraction(scenario);
  const inference = await runImplicationInference(
    {
      diff: formatDiffForPrompt(extraction.files),
      ursExcerpt: renderUrsMarkdown(priorDoc),
    },
    llm,
    { model, provider: providerLabel, timeoutMs, maxTimeoutRetries: 0 },
  );
  if (!inference.ok) {
    return {
      implications: [],
      drift: { overall: 'no-semantic-change', perImplication: [] },
      proposals: [],
      deltas: [],
      alerts: [],
      inferenceError: inference.error.code,
    };
  }
  const implications: SpecImplication[] = inference.output.implications.map((imp, i) => ({
    id: imp.id || `imp-${i + 1}`,
    kind: imp.kind,
    text: imp.text,
    confidence: imp.confidence,
    sourceRefs: imp.sourceRefs.map((r) => `${r.path}:${r.line}`),
    rationale: imp.rationale,
    ...(imp.category !== undefined ? { category: imp.category } : {}),
  }));
  const drift = compareDrift(implications, priorDoc);
  const proposals = generateProposals({
    implications,
    drift,
    doc: priorDoc,
    changeId: `eval-${scenario.id}`,
    timestamp: '1970-01-01T00:00:00.000Z',
  });
  const synthesis = await synthesizeTestDeltas({ implications, drift, proposals });
  return {
    implications,
    drift,
    proposals,
    deltas: synthesis.deltas,
    alerts: buildDriftAlerts({
      changeId: `eval-${scenario.id}`,
      timestamp: '1970-01-01T00:00:00.000Z',
      implications,
      drift,
      doc: priorDoc,
      proposals,
    }),
    inferenceError: null,
  };
}

/**
 * Scoped-update mechanism check (SO4): every proposal must carry a valid
 * patch that touches ONLY its own section — applying it leaves every
 * untouched section byte-identical, `modify` ops target existing sections,
 * `add` ops target new ones — and proposals appear exactly when the overall
 * drift is actionable.
 */
export function checkUpdateCorrectness(
  run: ModeRun,
  priorDoc: UrsDocument,
): boolean {
  if (ACTIONABLE.has(run.drift.overall) !== (run.proposals.length > 0)) return false;
  for (const proposal of run.proposals) {
    const patch = proposal.patch;
    if (!patch || !validatePatch(patch).ok) return false;
    const listed = new Set(patch.ops.map((op) => op.sectionId));
    // sectionsTouched must equal the ops' sections (nothing extra)
    if ((proposal.sectionsTouched ?? []).some((id) => !listed.has(id))) return false;
    for (const op of patch.ops) {
      const existed = priorDoc.sections.some((s) => s.id === op.sectionId);
      if (op.op === 'modify' && !existed) return false;
      if (op.op === 'add' && existed) return false;
    }
    const applied = applyPatch(priorDoc, patch);
    for (const section of priorDoc.sections) {
      if (listed.has(section.id)) continue;
      const after = applied.sections.find((s) => s.id === section.id);
      if (JSON.stringify(after) !== JSON.stringify(section)) return false;
    }
  }
  return true;
}

// ── The harness ───────────────────────────────────────────────────────

export interface EvaluationOptions {
  readonly scenarios: readonly EvalScenario[];
  readonly corpusDir?: string | null;
  readonly modes?: readonly EvalMode[];
  /** Offline provider factory (default: the deterministic label echo). */
  readonly createProvider?: (scenario: EvalScenario, mode: 'single-pass' | 'full') => LLMPort;
  /** Live local model: replaces the provider for single-pass and full. */
  readonly live?: { readonly llm: LLMPort; readonly model: string };
  /** Topic/text match threshold (default 0.4). */
  readonly matchThreshold?: number;
  /** Per-request timeout for model calls (default 30 s). */
  readonly timeoutMs?: number;
  readonly now?: () => string;
}

async function deltaJudgeScore(
  live: { llm: LLMPort; model: string },
  scenario: EvalScenario,
  deltas: readonly SpecTestCaseDelta[],
): Promise<number | null> {
  if (deltas.length === 0 || scenario.expected.testDeltaTopics.length === 0) return null;
  const response = await generateWithTimeout(
    live.llm,
    {
      model: live.model,
      systemInstruction:
        'You grade test-case deltas against expected test topics. Return ONLY {"score": <0..1>}.',
      messages: [
        {
          role: 'user',
          parts: [
            {
              kind: 'text',
              text: JSON.stringify({
                expectedTopics: scenario.expected.testDeltaTopics,
                deltas,
              }),
            },
          ],
        },
      ],
      temperature: 0,
    },
    30_000,
  );
  const parsed: unknown = extractJson(
    response.message.parts
      .filter((p) => p.kind === 'text')
      .map((p) => p.text)
      .join(''),
  );
  const score =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { score?: unknown }).score
      : undefined;
  return typeof score === 'number' && score >= 0 && score <= 1 ? score : null;
}

export async function runEvaluation(options: EvaluationOptions): Promise<EvalReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const started = performance.now();
  const modes = options.modes ?? EVAL_MODES;
  const threshold = options.matchThreshold ?? 0.4;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const createProvider = options.createProvider ?? createLabelEchoProvider;
  const rssBaseline = process.memoryUsage().rss;

  const records: ScenarioMetrics[] = [];
  let peakRss = rssBaseline;

  for (const mode of modes) {
    for (const scenario of options.scenarios) {
      const priorDoc = buildUrsDoc(scenario);
      const llm =
        mode === 'batch'
          ? undefined
          : options.live
            ? options.live.llm
            : createProvider(scenario, mode);
      const model = options.live?.model ?? 'label-echo';

      const t0 = performance.now();
      let run: ModeRun;
      try {
        run =
          mode === 'batch'
            ? await runBatchMode(scenario)
            : mode === 'single-pass'
              ? await runSinglePassMode(scenario, llm as LLMPort, model, timeoutMs)
              : await runFullMode(
                  scenario,
                  priorDoc,
                  llm as LLMPort,
                  model,
                  options.live ? String(llm?.provider ?? 'live') : 'eval-scripted',
                  timeoutMs,
                );
      } catch (err) {
        throw new LivingSpecEvalError(
          `eval run failed for ${scenario.id} (${mode}): ${(err as Error).message}`,
        );
      }
      const latencyMs = performance.now() - t0;

      const implication = (() => {
        const m = matchImplications(
          scenario.expected.implications.map((i) => i.text),
          run.implications,
          threshold,
        );
        const precision = ratio(m.tp, m.tp + m.fp);
        const recall = ratio(m.tp, m.tp + m.fn);
        return {
          expected: scenario.expected.implications.length,
          predicted: run.implications.length,
          ...m,
          precision,
          recall,
          f1: fScore(precision, recall),
        };
      })();

      let deltaRelevance = deltaTopicCoverage(scenario.expected.testDeltaTopics, run.deltas);
      if (options.live && run.deltas.length > 0) {
        const judged = await deltaJudgeScore(options.live, scenario, run.deltas).catch(() => null);
        if (judged !== null) deltaRelevance = judged;
      }

      const rssBytes = process.memoryUsage().rss;
      peakRss = Math.max(peakRss, rssBytes);

      records.push({
        scenarioId: scenario.id,
        category: scenario.category,
        isRefactor: scenario.isRefactor,
        mode,
        latencyMs,
        rssBytes,
        inferenceError: run.inferenceError,
        implication,
        drift: {
          expected: scenario.expected.driftStatus,
          predicted: run.drift.overall,
          correct: run.drift.overall === scenario.expected.driftStatus,
        },
        falseAlert: scenario.isRefactor && run.alerts.length > 0,
        updateCorrectness:
          mode === 'full' ? checkUpdateCorrectness(run, priorDoc) : null,
        deltaRelevance,
      });
    }
  }

  const aggregate: Partial<Record<EvalMode, ModeAggregate>> = {};
  for (const mode of modes) {
    const rows = records.filter((r) => r.mode === mode);
    const tp = rows.reduce((n, r) => n + r.implication.tp, 0);
    const fp = rows.reduce((n, r) => n + r.implication.fp, 0);
    const fn = rows.reduce((n, r) => n + r.implication.fn, 0);
    const precision = ratio(tp, tp + fp);
    const recall = ratio(tp, tp + fn);
    const refactorRows = rows.filter((r) => r.isRefactor);
    const correctnessRows = rows.filter((r) => r.updateCorrectness !== null);
    const relevanceRows = rows.filter((r) => r.deltaRelevance !== null);
    aggregate[mode] = {
      mode,
      scenarios: rows.length,
      implication: { precision, recall, f1: fScore(precision, recall) },
      driftAccuracy: ratio(rows.filter((r) => r.drift.correct).length, rows.length),
      falseAlertRate: ratio(refactorRows.filter((r) => r.falseAlert).length, refactorRows.length),
      refactorScenarios: refactorRows.length,
      updateCorrectnessRate:
        correctnessRows.length === 0
          ? null
          : ratio(correctnessRows.filter((r) => r.updateCorrectness === true).length, correctnessRows.length),
      deltaRelevanceMean:
        relevanceRows.length === 0
          ? null
          : relevanceRows.reduce((n, r) => n + (r.deltaRelevance ?? 0), 0) / relevanceRows.length,
      latencyMedianMs: median(rows.map((r) => r.latencyMs)),
      latencyP95Ms: p95(rows.map((r) => r.latencyMs)),
      peakRssBytes: peakRss,
    };
  }

  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: now(),
    durationMs: Math.max(0, performance.now() - started),
    corpus: {
      dir: options.corpusDir ?? null,
      scenarioCount: options.scenarios.length,
    },
    modes,
    provider: {
      model: options.live?.model ?? 'label-echo',
      live: options.live !== undefined,
    },
    matchThreshold: threshold,
    notes: modes.map((m) => EVAL_MODE_NOTES[m]),
    aggregate,
    scenarios: records,
  };
}

// ── Rendering + persistence ───────────────────────────────────────────

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const num = (v: number | null, digits = 2): string => (v === null ? 'n/a' : v.toFixed(digits));

/** Markdown evidence rendering: summary table + per-scenario detail. */
export function renderEvalMarkdown(report: EvalReport): string {
  const lines: string[] = [
    `# Living-spec evaluation — ${report.startedAt}`,
    '',
    `Corpus: **${report.corpus.scenarioCount} scenarios**` +
      (report.corpus.dir ? ` (\`${report.corpus.dir}\`)` : '') +
      ` · provider: **${report.provider.model}** (${report.provider.live ? 'live model' : 'offline scripted'}) · text-match threshold ${report.matchThreshold}`,
    '',
    '## Mode definitions',
    '',
    ...report.notes.map((n) => `- ${n}`),
    '',
    '## Summary by mode',
    '',
    '| Mode | Implication P | R | F1 | Drift acc. | False-alert rate | Update correct. | Δ relevance | Latency med / P95 (ms) | Peak RSS (MB) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const mode of report.modes) {
    const a = report.aggregate[mode];
    if (!a) continue;
    lines.push(
      `| ${mode} | ${pct(a.implication.precision)} | ${pct(a.implication.recall)} | ${pct(a.implication.f1)} | ${pct(a.driftAccuracy)} | ${pct(a.falseAlertRate)} (${a.refactorScenarios} refactor) | ${
        a.updateCorrectnessRate === null ? 'n/a' : pct(a.updateCorrectnessRate)
      } | ${num(a.deltaRelevanceMean)} | ${a.latencyMedianMs.toFixed(1)} / ${a.latencyP95Ms.toFixed(1)} | ${(a.peakRssBytes / 1024 / 1024).toFixed(1)} |`,
    );
  }

  lines.push(
    '',
    '## Per-scenario results',
    '',
    '| Scenario | Category | Mode | Expected drift | Predicted | ✔ | Imp P/R/F1 | Δ relevance | Update OK | Latency (ms) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const r of report.scenarios) {
    lines.push(
      `| ${r.scenarioId} | ${r.category} | ${r.mode} | ${r.drift.expected} | ${r.drift.predicted} | ${
        r.drift.correct ? '✔' : '✖'
      } | ${num(r.implication.precision)}/${num(r.implication.recall)}/${num(r.implication.f1)} | ${num(
        r.deltaRelevance,
      )} | ${r.updateCorrectness === null ? 'n/a' : r.updateCorrectness ? '✔' : '✖'} | ${r.latencyMs.toFixed(1)} |`,
    );
  }

  const failures = report.scenarios.filter((r) => r.inferenceError !== null);
  if (failures.length > 0) {
    lines.push('', '## Inference failures', '');
    for (const f of failures) {
      lines.push(`- ${f.scenarioId} (${f.mode}): \`${f.inferenceError}\``);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Writes `reports/eval-<timestamp>.json` + `.md`; returns both paths. */
export async function saveEvalReport(
  projectRoot: string,
  report: EvalReport,
): Promise<{ readonly jsonPath: string; readonly mdPath: string }> {
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const dir = reportsDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `eval-${stamp}.json`);
  const mdPath = path.join(dir, `eval-${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  await fs.writeFile(mdPath, renderEvalMarkdown(report), 'utf-8');
  return { jsonPath, mdPath };
}
