/**
 * Human-facing output for `codexrev spec analyze` / `spec watch`.
 * Kept in the cli/ layer so the pipeline modules stay console-free.
 */

import type { AnalysisOutcome } from '../pipeline/analysisRunner.js';
import type { ChangeBatch } from '../pipeline/changeBuffer.js';
import type { DiffFile, ExtractedDiff } from '../pipeline/diffExtractor.js';
import type { SpecAnalysisResult } from '../pipeline/types.js';

const MAX_LISTED_FILES = 25;

function delta(added: number, removed: number): string {
  return `+${added} -${removed}`;
}

export function formatFileLine(file: DiffFile): string {
  const name =
    file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return `  ${delta(file.linesAdded, file.linesRemoved).padEnd(10)} ${file.status.padEnd(8)} ${name}`;
}

export function printTruncationWarning(extraction: ExtractedDiff): void {
  const shown = extraction.omittedPaths.slice(0, 5).join(', ');
  const more =
    extraction.omittedPaths.length > 5 ? ` (+${extraction.omittedPaths.length - 5} more)` : '';
  const omitted =
    extraction.omittedPaths.length > 0
      ? `: ${extraction.omittedPaths.length} file(s) omitted${shown ? ` — ${shown}${more}` : ''}`
      : ': partial file cut at the limit';
  console.warn(
    `  ⚠ diff truncated at ${extraction.maxBytes} bytes (${extraction.totalBytes} bytes total)${omitted}`,
  );
}

/** `--output text` summary: files changed, lines added/removed, warnings. */
export function printAnalysisSummary(
  outcome: AnalysisOutcome,
  opts: { root: string; reportFile: string | null },
): void {
  const { result, extraction } = outcome;
  const totalAdded = extraction.files.reduce((n, f) => n + f.linesAdded, 0);
  const totalRemoved = extraction.files.reduce((n, f) => n + f.linesRemoved, 0);

  console.log(`Living Specification Engine — analysis of ${extraction.ref} in ${opts.root}`);
  console.log(`  change id:  ${result.changeId}`);
  console.log(
    `  ${extraction.files.length} file(s) changed: ${delta(totalAdded, totalRemoved)}`,
  );
  for (const file of extraction.files.slice(0, MAX_LISTED_FILES)) {
    console.log(formatFileLine(file));
  }
  if (extraction.files.length > MAX_LISTED_FILES) {
    console.log(`  … and ${extraction.files.length - MAX_LISTED_FILES} more file(s)`);
  }
  if (extraction.truncated) printTruncationWarning(extraction);
  console.log(
    opts.reportFile ? `  report written: ${opts.reportFile}` : '  (dry-run) report not written',
  );
}

/** `--output json`: the SpecAnalysisResult and nothing else on stdout. */
export function printAnalysisJson(result: SpecAnalysisResult): void {
  console.log(JSON.stringify(result, null, 2));
}

/** Per-event summary lines for one debounced watch batch. */
export function printWatchBatchSummary(
  outcome: AnalysisOutcome,
  batch: ChangeBatch,
  reportFile: string | null,
): void {
  const stamp = new Date(batch.emittedAt).toTimeString().slice(0, 8);
  const { extraction } = outcome;
  const totalAdded = extraction.files.reduce((n, f) => n + f.linesAdded, 0);
  const totalRemoved = extraction.files.reduce((n, f) => n + f.linesRemoved, 0);

  console.log(
    `[${stamp}] change ${outcome.changeId.slice(0, 12)} — ${extraction.files.length} file(s) ` +
      `${delta(totalAdded, totalRemoved)} (from ${batch.paths.join(', ')})`,
  );
  for (const file of extraction.files) console.log(formatFileLine(file));
  if (extraction.truncated) printTruncationWarning(extraction);
  if (reportFile) console.log(`  report written: ${reportFile}`);
}
