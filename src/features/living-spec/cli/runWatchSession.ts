/**
 * Foreground watch session for `codexrev spec watch`.
 *
 * The session runs ONLY while the command is alive: it watches through the
 * swappable `WatcherPort` (chokidar by default), feeds every save through the
 * shared changeBuffer + diffExtractor path, prints a summary per debounced
 * change event and exits cleanly on Ctrl+C. It never installs a daemon,
 * service or git hook — analysis is triggered only by this explicit command.
 */

import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import {
  runDeterministicAnalysis,
  type AnalysisOutcome,
} from '../pipeline/analysisRunner.js';
import { ChangeBuffer, hashContent, type ChangeBatch } from '../pipeline/changeBuffer.js';
import { DEFAULT_SOURCE_GLOBS } from '../pipeline/diffExtractor.js';
import { LivingSpecError } from '../tools/errors.js';
import {
  createPathMatcher,
  isAlwaysExcludedPath,
} from '../tools/pathMatcher.js';
import { readConfig, saveReport } from '../tools/stateStore.js';
import { createChokidarWatcher } from '../watch/chokidarWatcher.js';
import type { WatchEvent, WatcherFactory } from '../watch/watcherPort.js';
import { printWatchBatchSummary } from './specOutput.js';

/**
 * Saved files are worktree changes; `git diff HEAD` covers staged + unstaged
 * edits against the last commit (extraction falls back gracefully when the
 * repo has no commit yet — the error is reported per batch, not fatal).
 */
const WATCH_REF = 'HEAD';

export interface WatchSessionOptions {
  readonly projectRoot: string;
  /** Quiet period per path before a change is analysed (ms). */
  readonly debounceMs?: number;
  /** Globs to watch (overrides config.json watchedPaths). */
  readonly watchedPaths?: readonly string[];
  /** Report drift without persisting anything. */
  readonly dryRun?: boolean;
  /** Swappable watcher provider (chokidar by default). */
  readonly createWatcher?: WatcherFactory;
  /** Ends the foreground session when aborted (in addition to Ctrl+C). */
  readonly stopSignal?: AbortSignal;
  /** Test hook invoked after each analysed batch. */
  readonly onBatchAnalyzed?: (outcome: AnalysisOutcome) => void;
}

async function hashEvent(projectRoot: string, event: WatchEvent): Promise<string | null> {
  if (event.kind === 'unlink') return hashContent(`unlink:${event.path}`);
  try {
    const content = await fs.readFile(nodePath.join(projectRoot, event.path));
    return hashContent(content.toString('utf-8'));
  } catch {
    return null; // file vanished mid-save — a later event covers the change
  }
}

export async function runWatchSession(options: WatchSessionOptions): Promise<void> {
  const root = options.projectRoot;
  const cfg = await readConfig(root);
  const debounceMs = options.debounceMs ?? cfg.debounceMs;
  const watchedPaths = options.watchedPaths ?? cfg.watchedPaths;
  const dryRun = options.dryRun === true;

  const watchMatcher = createPathMatcher([...watchedPaths]);
  const includeMatcher = createPathMatcher([...(cfg.includePaths ?? DEFAULT_SOURCE_GLOBS)]);
  const shouldWatch = (relPath: string): boolean =>
    !isAlwaysExcludedPath(relPath) && watchMatcher(relPath) && includeMatcher(relPath);

  // batch analyses are serialized so overlapping save bursts stay ordered
  let analyzing: Promise<void> = Promise.resolve();

  const analyzeBatch = async (batch: ChangeBatch): Promise<void> => {
    try {
      const outcome = await runDeterministicAnalysis(root, {
        ref: WATCH_REF,
        paths: batch.paths,
        includePaths: cfg.includePaths,
        contextLines: cfg.contextLines,
        maxBytes: cfg.maxBytes,
      });
      if (outcome.extraction.files.length === 0 && !outcome.extraction.truncated) {
        const stamp = new Date(batch.emittedAt).toTimeString().slice(0, 8);
        console.log(
          `[${stamp}] no effective diff for ${batch.paths.join(', ')} — nothing analysed`,
        );
        return;
      }
      const reportFile = dryRun ? null : await saveReport(root, outcome.result);
      printWatchBatchSummary(outcome, batch, reportFile);
      options.onBatchAnalyzed?.(outcome);
    } catch (err) {
      if (err instanceof LivingSpecError) {
        console.error(`[codexrev spec] ${err.message}`);
      } else {
        console.error(
          `[codexrev spec] analysis failed: ${(err as Error).stack ?? String(err)}`,
        );
      }
    }
  };

  const buffer = new ChangeBuffer({
    debounceMs,
    onBatch: (batch) => {
      analyzing = analyzing.then(() => analyzeBatch(batch));
    },
  });

  const watcher = (options.createWatcher ?? createChokidarWatcher)(root, shouldWatch);
  watcher.onEvent((event) => {
    void hashEvent(root, event).then((hash) => {
      if (hash !== null) buffer.push({ path: event.path, hash });
    });
  });
  watcher.onError((error) => {
    console.error(`[codexrev spec] watcher error: ${error.message}`);
  });

  await watcher.start();
  console.log(`[codexrev spec] watching ${root}`);
  console.log(
    `  debounce ${debounceMs} ms · watched ${watchedPaths.join(', ')} · press Ctrl+C to stop`,
  );

  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      buffer.dispose();
      await watcher.close().catch(() => undefined);
      await analyzing.catch(() => undefined);
      console.log('[codexrev spec] watch session stopped');
      resolveDone();
    })();
  };

  const onSignal = (): void => stop();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let onAbort: (() => void) | undefined;
  if (options.stopSignal) {
    if (options.stopSignal.aborted) stop();
    else {
      onAbort = () => stop();
      options.stopSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    await done;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (options.stopSignal && onAbort) options.stopSignal.removeEventListener('abort', onAbort);
  }
}
