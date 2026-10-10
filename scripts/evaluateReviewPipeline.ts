#!/usr/bin/env -S npx tsx
/**
 * Codexrev — review pipeline evaluation script.
 *
 * Not part of `npm test` / CI — like `checkReviewProviders.ts`, this is
 * a manual, throwaway-style script called for by Phase 10's Definition
 * of Done: "a short results table (accuracy, false-positive rate,
 * latency, convergence rate) ready to drop into the evaluation section
 * of the write-up." It needs a REAL model actually answering, so it is
 * never run automatically and never fabricates a result — if the
 * configured provider is unreachable, it fails loudly rather than
 * printing invented numbers.
 *
 * Fixtures + harness live in
 * `src/features/review-pipeline/testing/detectionFixtures.ts`, shared
 * with `tests/features/review-pipeline/liveDetection.test.ts` (the
 * opt-in vitest integration test for Phase 10's "New" bullet 2) so the
 * two never drift apart on what "the synthetic diffs" actually are —
 * this script adds the results-table/latency/convergence-rate
 * reporting on top.
 *
 * What this deliberately does NOT attempt (see the Decision Log —
 * Phase 10 row on scope): the full Juliet Test Suite / NIST SARD corpus
 * (not bundled with this repo — no dataset shipped or downloaded here),
 * and a local-vs-cloud comparison (needs a configured cloud provider
 * API key, which this environment did not have when this script was
 * written). Both are left as a documented gap, not silently skipped —
 * see the "Not covered by this run" section this script writes into
 * `docs/review-pipeline-evaluation-results.md`.
 *
 * Usage:
 *   npx tsx scripts/evaluateReviewPipeline.ts [--provider <id>] [--model <name>]
 *
 * Defaults to `--provider ollama` (a local daemon needs no API key to
 * try). Pass `--provider openai` etc. with the relevant key configured
 * (`codexrev models add` / env var) to run the same battery against a
 * cloud model instead — the results table records which one ran.
 *
 * Each of this script's four detection fixtures runs the FULL six-role
 * pipeline, so total runtime scales with however slow the target model
 * is — expect several minutes per fixture against a local ~12B model on
 * a laptop, which is itself a real (and reportable) latency data point.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CONVERGENCE_FIXTURE_FILES,
  DETECTION_FIXTURES,
  fixtureLlmProvider,
  makeFixtureRepo,
  runDetectionFixture,
  type DetectionResult,
} from '../src/features/review-pipeline/testing/detectionFixtures.js';
import { readDiff } from '../src/features/review-pipeline/pipeline/diffReader.js';
import { runPipeline } from '../src/features/review-pipeline/pipeline/orchestrator.js';
import { resolve } from '../src/features/review-pipeline/pipeline/resolverEngine.js';
import { runBreakerBuilderLoop } from '../src/features/review-pipeline/pipeline/breakerBuilderLoop.js';
import { DEFAULT_SETTINGS } from '../src/config/schema.js';
import type { ProviderId } from '../src/core/types.js';

// ── CLI args ─────────────────────────────────────────────────────────

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const providerId = argValue('--provider', 'ollama') as ProviderId;
const modelName = argValue('--model', providerId === 'ollama' ? 'gemma4:12b-mlx' : DEFAULT_SETTINGS.model);

// ── Convergence measurement ──────────────────────────────────────────

interface ConvergenceResult {
  readonly deterministicFixes: number;
  readonly llmFixes: number;
  readonly outcome: string;
  readonly latencyMs: number;
}

async function runConvergenceFixture(): Promise<ConvergenceResult> {
  const cwd = await makeFixtureRepo(CONVERGENCE_FIXTURE_FILES);
  try {
    const llm = fixtureLlmProvider(providerId, modelName);
    const diff = await readDiff(cwd);

    const start = Date.now();
    const pipeline = await runPipeline({ diff, llm, model: modelName, cwd });
    // Same failure mode as `runDetectionFixture` — an incomplete scan
    // (fewer than six role outputs) would resolve trivially to "nothing
    // blocking" and get silently reported as a real 0%-deterministic-
    // fixes convergence rate. Fail loudly instead.
    if (pipeline.outcome !== 'completed') {
      const detail = pipeline.outcome === 'errored' ? `: ${(pipeline.error as Error | undefined)?.message ?? String(pipeline.error)}` : '';
      throw new Error(`Pipeline did not complete for the convergence fixture (outcome: ${pipeline.outcome}, ${pipeline.ranRoles.length}/6 roles ran)${detail}`);
    }
    const resolverResult = resolve(pipeline.aggregator.toJSON().roleOutputs, DEFAULT_SETTINGS.reviewPipeline.resolverWeights);

    let deterministicFixes = 0;
    let llmFixes = 0;
    let outcome = 'not-attempted (nothing blocking)';

    if (resolverResult.decision === 'block' || resolverResult.decision === 'request_changes') {
      const bb = await runBreakerBuilderLoop({
        aggregator: pipeline.aggregator,
        llm,
        model: modelName,
        cwd,
        maxIterations: DEFAULT_SETTINGS.reviewPipeline.maxFixIterations,
      });
      deterministicFixes = bb.fixAttempts.filter((f) => f.fixerStage === 'deterministic').length;
      llmFixes = bb.fixAttempts.filter((f) => f.fixerStage === 'llm').length;
      outcome = bb.outcome;
    }

    return { deterministicFixes, llmFixes, outcome, latencyMs: Date.now() - start };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

// ── Report ───────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

interface FixtureRunOutcome {
  readonly fixture: (typeof DETECTION_FIXTURES)[number];
  readonly result?: DetectionResult;
  readonly error?: string;
}

async function main(): Promise<void> {
  console.log(`Review pipeline evaluation — provider=${providerId} model=${modelName}\n`);

  // Each fixture is a fully independent run — one crashing (a local
  // model's idle keep-alive expiring mid-battery is a real, observed
  // failure mode, not hypothetical) must not lose every OTHER fixture's
  // already-real data. Caught per-fixture, recorded as an explicit
  // error row — never silently reinterpreted as a clean result (that
  // was the actual bug this rewrite fixes: an incomplete/errored
  // pipeline run used to read back as "all roles passed").
  const outcomes: FixtureRunOutcome[] = [];
  for (const fixture of DETECTION_FIXTURES) {
    console.log(`Running: ${fixture.name}...`);
    try {
      const r = await runDetectionFixture(fixture, providerId, modelName);
      outcomes.push({ fixture, result: r });
      const verdict = r.flagged ? `flagged by [${r.flaggedBy.join(', ')}]` : 'all roles passed';
      console.log(`  → ${verdict} (${fmtMs(r.latencyMs)})\n`);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      outcomes.push({ fixture, error: message });
      console.log(`  → ERROR (excluded from the results table below): ${message}\n`);
    }
  }

  console.log('Running: Breaker-Builder convergence...');
  let convergence: ConvergenceResult | undefined;
  let convergenceError: string | undefined;
  try {
    convergence = await runConvergenceFixture();
    console.log(`  → ${convergence.outcome}: ${convergence.deterministicFixes} deterministic, ${convergence.llmFixes} LLM (${fmtMs(convergence.latencyMs)})\n`);
  } catch (err) {
    convergenceError = (err as Error).message ?? String(err);
    console.log(`  → ERROR (excluded from the results table below): ${convergenceError}\n`);
  }

  const detectionResults = outcomes.flatMap((o) => (o.result ? [o.result] : []));
  const erroredFixtures = outcomes.filter((o) => o.error);
  const vulnCases = detectionResults.filter((r) => r.fixture.expectRole !== null);
  const cleanCases = detectionResults.filter((r) => r.fixture.expectRole === null);
  const truePositives = vulnCases.filter((r) => r.flagged).length;
  const accuracy = vulnCases.length > 0 ? truePositives / vulnCases.length : NaN;
  const falsePositives = cleanCases.filter((r) => r.flagged).length;
  const falsePositiveRate = cleanCases.length > 0 ? falsePositives / cleanCases.length : NaN;
  const avgLatencyMs =
    detectionResults.length > 0 ? detectionResults.reduce((sum, r) => sum + r.latencyMs, 0) / detectionResults.length : NaN;
  const totalConvergenceFixes = convergence ? convergence.deterministicFixes + convergence.llmFixes : 0;
  const convergenceRate = convergence && totalConvergenceFixes > 0 ? convergence.deterministicFixes / totalConvergenceFixes : NaN;

  const lines: string[] = [];
  lines.push(`# Review Pipeline Evaluation Results`);
  lines.push('');
  lines.push(`Run ${new Date().toISOString()} · provider \`${providerId}\` · model \`${modelName}\``);
  lines.push('');
  lines.push("Small-scale, real (not fabricated) measurement — NOT the full Juliet Test Suite / NIST SARD corpus, and NOT a local-vs-cloud comparison (see this file's footer for what remains undone and why).");
  if (erroredFixtures.length > 0 || convergenceError) {
    lines.push('');
    lines.push(
      `**${erroredFixtures.length + (convergenceError ? 1 : 0)} of ${DETECTION_FIXTURES.length + 1} runs errored** (see "Errored runs" below) and are excluded from every metric — a crashed run is never counted as a pass.`,
    );
  }
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Detection accuracy | ${truePositives}/${vulnCases.length} (${isNaN(accuracy) ? 'n/a' : `${(accuracy * 100).toFixed(0)}%`}) |`);
  lines.push(`| False-positive rate | ${falsePositives}/${cleanCases.length} (${isNaN(falsePositiveRate) ? 'n/a' : `${(falsePositiveRate * 100).toFixed(0)}%`}) |`);
  lines.push(`| Avg. latency per full six-role scan | ${isNaN(avgLatencyMs) ? 'n/a' : fmtMs(avgLatencyMs)} (target: ≤5 min) |`);
  lines.push(
    `| Breaker-Builder convergence rate | ${isNaN(convergenceRate) ? 'n/a' : `${(convergenceRate * 100).toFixed(0)}%`} (${convergence ? `${convergence.deterministicFixes} deterministic / ${totalConvergenceFixes} total fixes` : 'not measured — run errored'}) |`,
  );
  lines.push('');
  lines.push('## Per-fixture detail');
  lines.push('');
  lines.push('| Fixture | Expected role | Flagged? | Flagged by | Latency |');
  lines.push('|---|---|---|---|---|');
  for (const r of detectionResults) {
    lines.push(`| ${r.fixture.name} | ${r.fixture.expectRole ?? '(none — clean baseline)'} | ${r.flagged ? 'yes' : 'no'} | ${r.flaggedBy.join(', ') || '—'} | ${fmtMs(r.latencyMs)} |`);
  }
  lines.push('');
  if (convergence) {
    lines.push(`Convergence fixture: 1 deterministic-fixable finding (TS7006) — outcome \`${convergence.outcome}\`, ${convergence.deterministicFixes} deterministic fix(es), ${convergence.llmFixes} LLM fix(es), ${fmtMs(convergence.latencyMs)}.`);
  } else {
    lines.push(`Convergence fixture: errored — ${convergenceError}`);
  }
  if (erroredFixtures.length > 0) {
    lines.push('');
    lines.push('## Errored runs (excluded above, not treated as a pass)');
    lines.push('');
    for (const o of erroredFixtures) {
      lines.push(`- **${o.fixture.name}**: ${o.error}`);
    }
  }
  lines.push('');
  lines.push('## Not covered by this run');
  lines.push('');
  lines.push("- **Full Juliet Test Suite / NIST SARD benchmark** — not bundled with this repo; this script's 4 hand-written fixtures are a small illustrative sample, not that corpus.");
  lines.push('- **Local-vs-cloud comparison** — re-run this script with `--provider openai` (or another configured cloud provider) and diff the two results tables.');

  const outPath = path.join(process.cwd(), 'docs', 'review-pipeline-evaluation-results.md');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`\nResults written to ${outPath}`);
}

main().catch((err) => {
  console.error('Review pipeline evaluation failed:', err);
  process.exitCode = 1;
});
