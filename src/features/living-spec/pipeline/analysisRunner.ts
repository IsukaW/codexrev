/**
 * Deterministic analysis runner — the front half of the living-spec pipeline.
 *
 * Runs diff extraction + change buffering and builds a `SpecAnalysisResult`
 * out of the mechanics alone: files touched, per-file line counts, and the
 * stable changeId. Requirement implications, drift semantics and test deltas
 * belong to the analyzer back half and stay empty here.
 *
 * No LLM calls — deterministic code only.
 */

import { ChangeBuffer, computeChangeId, hashContent, type ChangeBatch } from './changeBuffer.js';
import { extractDiff, type DiffExtractorOptions, type ExtractedDiff } from './diffExtractor.js';
import type { SpecAnalysisResult, SpecChangeFile } from './types.js';

export interface AnalysisOptions extends DiffExtractorOptions {
  /** Injectable timestamp source (defaults to `new Date().toISOString()`). */
  readonly now?: () => string;
  /** Injectable monotonic-ish clock for latency measurement (ms). */
  readonly elapsedMs?: () => number;
}

export interface AnalysisOutcome {
  readonly result: SpecAnalysisResult;
  readonly extraction: ExtractedDiff;
  readonly changeId: string;
  /** Buffered effective changes that fed this analysis (null when empty). */
  readonly batch: ChangeBatch | null;
}

export function buildSpecAnalysisResult(params: {
  changeId: string;
  timestamp: string;
  extraction: ExtractedDiff;
  latencyMs: number;
}): SpecAnalysisResult {
  const files: SpecChangeFile[] = params.extraction.files.map((f) => ({
    path: f.path,
    lines: f.linesAdded + f.linesRemoved,
  }));

  return {
    changeId: params.changeId,
    timestamp: params.timestamp,
    files,
    implications: [],
    // The deterministic front half performs no semantic comparison against
    // the URS — this is the contract's neutral value until the analyzer back
    // half (LLM) lands.
    driftStatus: 'no-semantic-change',
    ursPatch: {
      summary: 'Deterministic diff extraction only — no URS updates proposed.',
      entries: [],
    },
    testDeltas: [],
    quality: { model: 'heuristic', latencyMs: params.latencyMs, schemaValid: true },
  };
}

/**
 * Extracts the diff, runs every changed file through the change buffer
 * (debounce/dedupe path shared with `spec watch`), derives the stable
 * changeId and returns the deterministic analysis result.
 */
export async function runDeterministicAnalysis(
  projectRoot: string,
  options: AnalysisOptions = {},
): Promise<AnalysisOutcome> {
  const elapsedMs = options.elapsedMs ?? (() => Date.now());
  const now = options.now ?? (() => new Date().toISOString());
  const started = elapsedMs();

  const extraction = await extractDiff(projectRoot, options);

  const buffer = new ChangeBuffer({ debounceMs: 0 });
  for (const file of extraction.files) {
    buffer.push({
      path: file.path,
      hash: hashContent(
        `${file.status}\n${file.oldPath ?? ''}\n${file.path}\n${file.minimalPatch}`,
      ),
    });
  }
  const batch = buffer.flush();
  buffer.dispose();

  const changeId = computeChangeId({
    ref: extraction.ref,
    files: extraction.files.map((f) => f.path),
    diffContent: extraction.raw,
  });

  const latencyMs = Math.max(0, elapsedMs() - started);
  const result = buildSpecAnalysisResult({
    changeId,
    timestamp: now(),
    extraction,
    latencyMs,
  });

  return { result, extraction, changeId, batch };
}
