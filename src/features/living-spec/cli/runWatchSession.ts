/**
 * Foreground watch session for `codexrev spec watch`.
 *
 * The session runs ONLY while the command is alive: it watches through the
 * swappable `WatcherPort` (chokidar by default), feeds every save through
 * the shared changeBuffer + diffExtractor path and runs the full pipeline
 * back half per debounced change. It never installs a daemon, service or
 * git hook — analysis is triggered only by this explicit command.
 *
 * UI seam (events → reducer → render): every lifecycle step is emitted as
 * a typed `SpecSessionEvent`. On a TTY the persistent `SpecSessionView`
 * Ink tree renders them; in pipes/CI (or --quiet-off text mode) the same
 * events print as plain lines; --output json prints the raw report JSON
 * per batch. A plain shutdown summary prints once at the end.
 */

import React from 'react';
import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import { render, type Instance } from 'ink';
import {
  runDeterministicAnalysis,
  type AnalysisOutcome,
} from '../pipeline/analysisRunner.js';
import { ChangeBuffer, hashContent, type ChangeBatch } from '../pipeline/changeBuffer.js';
import { DEFAULT_SOURCE_GLOBS } from '../pipeline/diffExtractor.js';
import type { LLMPort } from '../pipeline/llmPort.js';
import { LivingSpecError } from '../tools/errors.js';
import { createPathMatcher, isAlwaysExcludedPath } from '../tools/pathMatcher.js';
import { readConfig } from '../tools/stateStore.js';
import { createChokidarWatcher } from '../watch/chokidarWatcher.js';
import type { WatchEvent, WatcherFactory } from '../watch/watcherPort.js';
import { runAnalysisPass } from './analysisPass.js';
import { printAnalysisJson, printOutputSideSummary, printWatchBatchSummary } from './specOutput.js';
import { SpecSessionEventBus, type SpecSessionEvent } from './specSessionEvents.js';
import {
  formatSessionShutdown,
  formatSpecEvent,
  initialSpecSessionState,
  reduceSpecSession,
  type SpecSessionState,
} from './specSessionState.js';
import { SpecSessionView } from './SpecSessionView.js';

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
  /** Report drift without persisting anything (deterministic-only). */
  readonly dryRun?: boolean;
  /** Swappable watcher provider (chokidar by default). */
  readonly createWatcher?: WatcherFactory;
  /** Ends the foreground session when aborted (in addition to Ctrl+C). */
  readonly stopSignal?: AbortSignal;
  /** Test hook invoked after each analysed batch. */
  readonly onBatchAnalyzed?: (outcome: AnalysisOutcome) => void;
  /** Injected model port for the semantic half (tests pass a fake). */
  readonly llm?: LLMPort;
  /** Assert no network provider is used for inference. */
  readonly offline?: boolean;
  /** Per-request inference timeout (ms). */
  readonly timeoutMs?: number;
  /** Per-batch report format (default: text summary). */
  readonly output?: 'json' | 'text';
  /** Suppress progress output (the plain shutdown summary is kept off too). */
  readonly quiet?: boolean;
  /** Test seam: skip the Ink view even on a TTY (force the plain fallback). */
  readonly forceNonInteractive?: boolean;
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
  const output = options.output ?? 'text';
  const quiet = options.quiet === true;

  // A TTY gets the live Ink view (text mode, not quiet); pipes/CI get the
  // same events as plain lines; --output json prints raw report JSON per
  // batch (machine mode — no event lines, no view).
  const interactive =
    !quiet && output === 'text' && options.forceNonInteractive !== true && process.stdout.isTTY === true;
  const plainLines = !interactive && !quiet && output === 'text';

  // events → reducer → render: one bus feeds the Ink tree (if any), the
  // plain-line fallback, and the shutdown summary state — never the pipeline
  const bus = new SpecSessionEventBus();
  let state: SpecSessionState = initialSpecSessionState();
  const unsubscribe = bus.subscribe((event: SpecSessionEvent) => {
    state = reduceSpecSession(state, event);
    if (!plainLines) return;
    if (event.type === 'batch_error') console.error(`[codexrev spec] ${event.message}`);
    else console.log(formatSpecEvent(event));
  });
  const emit = (event: SpecSessionEvent): void => bus.emit(event);
  const now = (): number => Date.now();

  const app: Instance | undefined = interactive
    ? render(React.createElement(SpecSessionView, { events: bus }))
    : undefined;

  const watchMatcher = createPathMatcher([...watchedPaths]);
  const includeMatcher = createPathMatcher([...(cfg.includePaths ?? DEFAULT_SOURCE_GLOBS)]);
  const shouldWatch = (relPath: string): boolean =>
    !isAlwaysExcludedPath(relPath) && watchMatcher(relPath) && includeMatcher(relPath);

  // batch analyses are serialized so overlapping save bursts stay ordered
  let analyzing: Promise<void> = Promise.resolve();

  const analyzeBatch = async (batch: ChangeBatch): Promise<void> => {
    emit({ type: 'batch_start', at: now(), paths: batch.paths });
    try {
      const outcome = await runDeterministicAnalysis(root, {
        ref: WATCH_REF,
        paths: batch.paths,
        includePaths: cfg.includePaths,
        contextLines: cfg.contextLines,
        maxBytes: cfg.maxBytes,
      });
      if (outcome.extraction.files.length === 0 && !outcome.extraction.truncated) {
        emit({ type: 'batch_skipped', at: now(), paths: batch.paths, reason: 'no effective diff' });
        return;
      }
      // Same pipeline back half as `spec analyze`: implications (when a model
      // is configured) → drift → proposals → test deltas + drift alerts +
      // change-impact summary, all persisted with the report JSON.
      const pass = await runAnalysisPass(root, outcome, {
        ...(options.llm ? { llm: options.llm } : {}),
        ...(options.offline !== undefined ? { offline: options.offline } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        dryRun,
        onStage: (stage) => emit({ type: 'stage', at: now(), stage }),
      });
      if (output === 'json') {
        printAnalysisJson(pass.result);
      } else if (plainLines) {
        printWatchBatchSummary(outcome, batch, pass.reportFile, pass.reportHtmlFile);
        printOutputSideSummary(pass);
      }
      emit({
        type: 'batch_complete',
        at: now(),
        changeId: outcome.changeId,
        driftStatus: pass.result.driftStatus,
        proposals: pass.proposals.length,
        testDeltas: pass.testDeltas.length,
        alerts: pass.driftAlerts,
        reportFile: pass.reportFile,
        ...(pass.result.inferenceError ? { inferenceError: pass.result.inferenceError.code } : {}),
      });
      options.onBatchAnalyzed?.(outcome);
    } catch (err) {
      const message =
        err instanceof LivingSpecError ? err.message : ((err as Error).stack ?? String(err));
      emit({ type: 'batch_error', at: now(), message });
      if (!plainLines) console.error(`[codexrev spec] ${message}`);
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
      if (hash === null) return; // file vanished mid-save — a later event covers it
      const outcome = buffer.push({ path: event.path, hash });
      if (outcome === 'deduped') {
        emit({ type: 'change_deduped', at: now(), path: event.path });
      } else if (outcome === 'scheduled') {
        emit({ type: 'change_detected', at: now(), path: event.path });
      }
      // 'unchanged': identical content re-saved inside the same quiet period
    });
  });
  watcher.onError((error) => {
    console.error(`[codexrev spec] watcher error: ${error.message}`);
  });

  await watcher.start();
  emit({ type: 'session_start', at: now(), root, watchedPaths, debounceMs });

  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    emit({ type: 'stopped', at: now() });
    void (async () => {
      buffer.dispose();
      await watcher.close().catch(() => undefined);
      await analyzing.catch(() => undefined);
      unsubscribe();
      app?.unmount();
      if (!quiet && output === 'text') {
        // The TTY view never prints plain lines, so make sure the stop is
        // acknowledged on stdout there too, then always close with the
        // shared shutdown summary (analyzed / deduped / proposals / …).
        if (!plainLines) console.log('[codexrev spec] watch session stopped');
        for (const line of formatSessionShutdown(state)) console.log(line);
      }
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
