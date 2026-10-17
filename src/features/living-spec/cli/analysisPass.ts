/**
 * Shared analysis pass for `spec analyze` and `spec watch`.
 *
 * Runs the pipeline back half over one deterministic `AnalysisOutcome` and
 * fills the full output-side contract on the report JSON:
 *
 *   implications (optional LLM) → drift comparison → scoped proposals →
 *   test-case deltas (rules + optional refinement) → drift alerts →
 *   change-impact summary → persistence (report, proposals, alerts.jsonl).
 *
 * Failure policy (NFR4/NFR5): the semantic half may fail — the deterministic
 * result stands, the failure is surfaced as `inferenceError`, and the
 * rule-based test deltas / impact summary are still produced. Nothing becomes
 * authoritative without `spec accept`.
 */

import { compareDrift, type DriftComparison } from '../pipeline/driftComparator.js';
import {
  applyInferenceToResult,
  buildImplicationsLabel,
  runImplicationInference,
  type ImplicationsLabelFile,
} from '../pipeline/inferenceEngine.js';
import { buildImpactSummary } from '../pipeline/impactSummary.js';
import { buildDriftAlerts } from '../pipeline/driftAlert.js';
import {
  createLLMPort,
  DEFAULT_INFERENCE_TIMEOUT_MS,
  isNetworkProvider,
  resolveInferenceTarget,
  type LLMPort,
} from '../pipeline/llmPort.js';
import { formatDiffForPrompt } from '../pipeline/promptBuilder.js';
import {
  synthesizeTestDeltas,
  type TestDeltaSynthesis,
} from '../pipeline/testDeltaSynthesizer.js';
import { generateProposals, proposalsToUrsPatch } from '../pipeline/ursPatcher.js';
import type {
  SpecAnalysisResult,
  SpecChangeDriftAlert,
  SpecImpactSummary,
  SpecTestCaseDelta,
  UrsDocument,
  UrsProposal,
} from '../pipeline/types.js';
import type { AnalysisOutcome } from '../pipeline/analysisRunner.js';
import { LivingSpecConfigError } from '../tools/errors.js';
import {
  appendDriftAlerts,
  readConfig,
  readUrsDocument,
  readUrsExcerpt,
  saveImplicationsReport,
  saveProposal,
  saveReport,
} from '../tools/stateStore.js';

const EMPTY_URS: UrsDocument = {
  schemaVersion: 1,
  title: 'User Requirements Specification',
  sections: [],
};

export interface AnalysisPassOptions {
  /** Injected model port (tests pass a fake — never a real network call). */
  readonly llm?: LLMPort;
  /** Inference provider override (default: local). */
  readonly provider?: string;
  /** Inference model override. */
  readonly model?: string;
  /** Assert no network provider is used for inference. */
  readonly offline?: boolean;
  /** Per-request inference timeout (ms). */
  readonly timeoutMs?: number;
  /** Compute everything but persist nothing. */
  readonly dryRun?: boolean;
}

export interface AnalysisPassResult {
  /** The report JSON — every contract field populated (or explicitly null). */
  readonly result: SpecAnalysisResult;
  readonly drift: DriftComparison;
  readonly proposals: readonly UrsProposal[];
  readonly testDeltas: readonly SpecTestCaseDelta[];
  readonly driftAlerts: readonly SpecChangeDriftAlert[];
  readonly impactSummary: SpecImpactSummary;
  readonly synthesis: TestDeltaSynthesis;
  /** Evaluation label file contents (null when inference did not run). */
  readonly label: ImplicationsLabelFile | null;
  readonly reportFile: string | null;
  readonly labelFile: string | null;
}

/** Inference runs when a model source is available (injection or config). */
export function shouldRunInference(
  modelOverride: string | undefined,
  options: AnalysisPassOptions,
): boolean {
  return Boolean(
    options.llm ||
      options.provider !== undefined ||
      options.model !== undefined ||
      modelOverride !== undefined,
  );
}

export async function runAnalysisPass(
  projectRoot: string,
  outcome: AnalysisOutcome,
  options: AnalysisPassOptions = {},
): Promise<AnalysisPassResult> {
  const cfg = await readConfig(projectRoot);
  const dryRun = options.dryRun === true;

  // ── Semantic back half (optional LLM): requirement implications ─────
  let result: SpecAnalysisResult = outcome.result;
  let label: ImplicationsLabelFile | null = null;
  let llm: LLMPort | undefined;

  if (shouldRunInference(cfg.modelOverride, options)) {
    const target = resolveInferenceTarget({
      provider: options.provider,
      model: options.model,
      modelOverride: cfg.modelOverride,
    });
    if (options.offline && isNetworkProvider(target.provider)) {
      throw new LivingSpecConfigError(
        `--offline forbids the network provider "${target.provider}"; ` +
          'use a local provider (ollama, lmstudio, litellm).',
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
    llm =
      options.llm ??
      createLLMPort({ provider: target.provider, model: target.model, timeoutMs });
    const ursExcerpt = await readUrsExcerpt(projectRoot);
    const inferenceResult = await runImplicationInference(
      {
        diff: formatDiffForPrompt(outcome.extraction.files),
        ...(ursExcerpt ? { ursExcerpt } : {}),
      },
      llm,
      {
        model: target.model,
        provider: target.provider,
        timeoutMs,
        maxTimeoutRetries: 1,
      },
    );

    if (inferenceResult.ok) {
      result = applyInferenceToResult(outcome.result, inferenceResult);
    } else {
      // Failure policy (NFR4/NFR5): leave the prior deterministic result
      // untouched and surface a structured error instead.
      result = { ...outcome.result, inferenceError: inferenceResult.error };
      console.warn(
        `  ⚠ implication inference failed (${inferenceResult.error.code}): ${inferenceResult.error.message}`,
      );
    }
    label = buildImplicationsLabel({
      changeId: outcome.changeId,
      timestamp: outcome.result.timestamp,
      provider: target.provider,
      model: target.model,
      result: inferenceResult,
    });
  }

  // ── Deterministic drift + scoped proposals ──────────────────────────
  const ursDoc = (await readUrsDocument(projectRoot)) ?? EMPTY_URS;
  const drift = compareDrift(result.implications, ursDoc);
  const proposals = generateProposals({
    implications: result.implications,
    drift,
    doc: ursDoc,
    changeId: outcome.changeId,
    timestamp: result.timestamp,
  });

  // ── Output side: test deltas, drift alerts, change-impact summary ───
  const synthesis = await synthesizeTestDeltas({
    implications: result.implications,
    drift,
    proposals,
    ...(llm ? { llm, model: llm.model } : {}),
  });
  if (synthesis.refinementError) {
    console.warn(
      `  ⚠ test-delta refinement failed (${synthesis.refinementError.code}); ` +
        'using deterministic rule output',
    );
  }
  const driftAlerts = buildDriftAlerts({
    changeId: outcome.changeId,
    timestamp: result.timestamp,
    implications: result.implications,
    drift,
    doc: ursDoc,
    proposals,
  });
  const impactSummary = buildImpactSummary({
    implications: result.implications,
    drift,
    extraction: outcome.extraction,
    proposals,
  });

  result = {
    ...result,
    driftStatus: drift.overall,
    ursPatch: proposalsToUrsPatch(proposals),
    proposalIds: proposals.map((p) => p.id),
    testDeltas: synthesis.deltas,
    driftAlerts,
    impactSummary,
  };

  // ── Persistence (NFR4: nothing is authoritative before accept) ──────
  let reportFile: string | null = null;
  let labelFile: string | null = null;
  if (!dryRun) {
    for (const p of proposals) await saveProposal(projectRoot, p);
    await appendDriftAlerts(projectRoot, driftAlerts);
    reportFile = await saveReport(projectRoot, result);
    if (label) labelFile = await saveImplicationsReport(projectRoot, outcome.changeId, label);
  }

  return {
    result,
    drift,
    proposals,
    testDeltas: synthesis.deltas,
    driftAlerts,
    impactSummary,
    synthesis,
    label,
    reportFile,
    labelFile,
  };
}
