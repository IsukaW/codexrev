/**
 * Thin console wrappers around the pure `reportRenderer` for the analyze /
 * watch text output. Kept in the cli/ layer so the pipeline modules stay
 * console-free; --output json prints the raw SpecAnalysisResult only.
 */

import type { AnalysisOutcome } from '../pipeline/analysisRunner.js';
import type { ChangeBatch } from '../pipeline/changeBuffer.js';
import type { ExtractedDiff } from '../pipeline/diffExtractor.js';
import type { SpecAnalysisResult } from '../pipeline/types.js';
import {
  renderAnalyzeHeader,
  renderFileLine,
  renderOutputSideSection,
  renderTruncationNotice,
} from './reportRenderer.js';

/** The output side of one analysis: test deltas, drift alerts, impact summary. */
export interface OutputSideView {
  readonly testDeltas: SpecAnalysisResult['testDeltas'];
  readonly driftAlerts: SpecAnalysisResult['driftAlerts'];
  readonly impactSummary: SpecAnalysisResult['impactSummary'];
  readonly synthesis: {
    readonly refined: boolean;
    readonly refinementError?: { readonly code: string; readonly message: string };
  };
}

export function printTruncationWarning(extraction: ExtractedDiff): void {
  console.warn(renderTruncationNotice(extraction));
}

/** `--output text` summary: files changed, lines added/removed, warnings. */
export function printAnalysisSummary(
  outcome: AnalysisOutcome,
  opts: { root: string; reportFile: string | null; htmlFile?: string | null },
): void {
  for (const line of renderAnalyzeHeader({
    extraction: outcome.extraction,
    result: outcome.result,
    root: opts.root,
    reportFile: opts.reportFile,
  })) {
    console.log(line);
  }
  if (opts.htmlFile) console.log(`  html artifact:  ${opts.htmlFile}`);
  if (outcome.extraction.truncated) printTruncationWarning(outcome.extraction);
}

/** `--output json`: the SpecAnalysisResult and nothing else on stdout. */
export function printAnalysisJson(result: SpecAnalysisResult): void {
  console.log(JSON.stringify(result, null, 2));
}

/** `--output text` lines for the test deltas, impact summary and drift alerts. */
export function printOutputSideSummary(view: OutputSideView): void {
  for (const line of renderOutputSideSection(view)) console.log(line);
}

/** Per-event summary lines for one debounced watch batch. */
export function printWatchBatchSummary(
  outcome: AnalysisOutcome,
  batch: ChangeBatch,
  reportFile: string | null,
  htmlFile?: string | null,
): void {
  const stamp = new Date(batch.emittedAt).toTimeString().slice(0, 8);
  const { extraction } = outcome;
  const totalAdded = extraction.files.reduce((n, f) => n + f.linesAdded, 0);
  const totalRemoved = extraction.files.reduce((n, f) => n + f.linesRemoved, 0);

  console.log(
    `[${stamp}] change ${outcome.changeId.slice(0, 12)} — ${extraction.files.length} file(s) ` +
      `+${totalAdded} -${totalRemoved} (from ${batch.paths.join(', ')})`,
  );
  for (const file of extraction.files) console.log(renderFileLine(file));
  if (reportFile) console.log(`  report written: ${reportFile}`);
  if (htmlFile) console.log(`  html artifact:  ${htmlFile}`);
}
