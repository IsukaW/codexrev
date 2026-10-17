/**
 * Pure view-state for one `spec watch` session: events → reducer → render.
 *
 * The reducer is the single source of truth for BOTH renderers — the Ink
 * tree (TTY) and the plain-line fallback (CI/pipes / --quiet) — so neither
 * the pipeline nor either renderer computes counts or "what's on screen"
 * on its own. No React, no fs, no console here: fully unit-testable.
 */

import type { SpecChangeDriftAlert, SpecDriftStatus } from '../pipeline/types.js';
import type { SpecSessionEvent, SpecWatchStage } from './specSessionEvents.js';

/** Bounded event log kept for the live view (oldest dropped first). */
export const MAX_SESSION_LOG = 60;
/** Bounded alert list kept for the live view (running count keeps growing). */
export const MAX_SESSION_ALERTS = 20;

export interface SpecSessionCounts {
  /** Batches fully analysed. */
  readonly analyzed: number;
  /** Saves dropped as identical-to-already-analysed (NFR3). */
  readonly deduped: number;
  readonly proposals: number;
  readonly alerts: number;
  readonly errors: number;
  readonly reports: number;
}

export interface SpecSessionLogEntry {
  readonly key: number;
  readonly kind: SpecSessionEvent['type'];
  /** Single-line human text for this event. */
  readonly text: string;
}

export interface SpecSessionState {
  readonly started: boolean;
  readonly root: string;
  readonly watchedPaths: readonly string[];
  readonly debounceMs: number;
  readonly startedAt: number;
  /** Current pipeline stage while a batch is in flight. */
  readonly stage: SpecWatchStage | null;
  /** Paths currently inside their debounce window. */
  readonly pendingPaths: readonly string[];
  readonly latestDrift: SpecDriftStatus | null;
  readonly alerts: readonly SpecChangeDriftAlert[];
  readonly counts: SpecSessionCounts;
  readonly lastChangeId: string | null;
  readonly log: readonly SpecSessionLogEntry[];
  readonly stopped: boolean;
}

export function initialSpecSessionState(): SpecSessionState {
  return {
    started: false,
    root: '',
    watchedPaths: [],
    debounceMs: 0,
    startedAt: 0,
    stage: null,
    pendingPaths: [],
    latestDrift: null,
    alerts: [],
    counts: { analyzed: 0, deduped: 0, proposals: 0, alerts: 0, errors: 0, reports: 0 },
    lastChangeId: null,
    log: [],
    stopped: false,
  };
}

function withLog(
  state: SpecSessionState,
  entry: Omit<SpecSessionLogEntry, 'key'>,
): readonly SpecSessionLogEntry[] {
  const next = [...state.log, { key: state.log.length + 1, ...entry }];
  return next.length > MAX_SESSION_LOG ? next.slice(next.length - MAX_SESSION_LOG) : next;
}

/** The one-line plain text for an event (shared by the non-TTY fallback). */
export function formatSpecEvent(event: SpecSessionEvent): string {
  switch (event.type) {
    case 'session_start':
      return `watching ${event.root} — ${event.watchedPaths.join(', ')} (debounce ${event.debounceMs} ms, Ctrl+C to stop)`;
    case 'change_detected':
      return `debouncing ${event.path}`;
    case 'change_deduped':
      return `deduped ${event.path} (identical to the last analysed state)`;
    case 'batch_start':
      return `analysing ${event.paths.join(', ')}`;
    case 'stage':
      return `stage ${event.stage}`;
    case 'batch_skipped':
      return `skipped ${event.paths.join(', ')} — ${event.reason}`;
    case 'batch_complete': {
      const parts = [
        `drift ${event.driftStatus}`,
        `${event.proposals} proposal(s)`,
        `${event.testDeltas} test delta(s)`,
        `${event.alerts.length} alert(s)`,
      ];
      if (event.inferenceError) parts.push(`model ${event.inferenceError} — deterministic only`);
      if (event.reportFile) parts.push('report written');
      return `analyzed ${event.changeId.slice(0, 12)} — ${parts.join(' · ')}`;
    }
    case 'batch_error':
      return `analysis failed: ${event.message}`;
    case 'stopped':
      return 'watch session stopped';
  }
}

/** The plain shutdown summary printed once, right after the session ends. */
export function formatSessionShutdown(state: SpecSessionState): string[] {
  const { counts } = state;
  const lines = [
    `Session summary — ${counts.analyzed} batch(es) analyzed, ${counts.deduped} save(s) deduped, ` +
      `${counts.proposals} proposal(s), ${counts.alerts} alert(s), ${counts.reports} report(s) written`,
  ];
  if (counts.errors > 0) lines.push(`  ${counts.errors} batch(es) failed — see errors above`);
  if (state.alerts.length > 0) {
    const worst = state.alerts.filter((a) => a.severity === 'critical').length;
    if (worst > 0) {
      lines.push(`  ${worst} critical drift alert(s) — run \`codexrev spec status\` for details`);
    }
  }
  return lines;
}

/**
 * The session-state reducer: the ONLY place session state changes. Returns a
 * new state object (no mutation) so React can consume it directly.
 */
export function reduceSpecSession(
  state: SpecSessionState,
  event: SpecSessionEvent,
): SpecSessionState {
  switch (event.type) {
    case 'session_start':
      return {
        ...state,
        started: true,
        root: event.root,
        watchedPaths: event.watchedPaths,
        debounceMs: event.debounceMs,
        startedAt: event.at,
        log: withLog(state, { kind: event.type, text: formatSpecEvent(event) }),
      };
    case 'change_detected': {
      const pending = state.pendingPaths.includes(event.path)
        ? state.pendingPaths
        : [...state.pendingPaths, event.path];
      return { ...state, pendingPaths: pending, log: withLog(state, { kind: event.type, text: formatSpecEvent(event) }) };
    }
    case 'change_deduped':
      return {
        ...state,
        counts: { ...state.counts, deduped: state.counts.deduped + 1 },
        log: withLog(state, { kind: event.type, text: formatSpecEvent(event) }),
      };
    case 'batch_start':
      return {
        ...state,
        stage: 'diff',
        pendingPaths: state.pendingPaths.filter((p) => !event.paths.includes(p)),
        log: withLog(state, { kind: event.type, text: formatSpecEvent(event) }),
      };
    case 'stage':
      return { ...state, stage: event.stage };
    case 'batch_skipped':
      return {
        ...state,
        stage: null,
        log: withLog(state, { kind: event.type, text: formatSpecEvent(event) }),
      };
    case 'batch_complete': {
      const alerts = [...state.alerts, ...event.alerts];
      return {
        ...state,
        stage: null,
        latestDrift: event.driftStatus,
        alerts: alerts.length > MAX_SESSION_ALERTS ? alerts.slice(alerts.length - MAX_SESSION_ALERTS) : alerts,
        lastChangeId: event.changeId,
        counts: {
          ...state.counts,
          analyzed: state.counts.analyzed + 1,
          proposals: state.counts.proposals + event.proposals,
          alerts: state.counts.alerts + event.alerts.length,
          reports: state.counts.reports + (event.reportFile ? 1 : 0),
        },
        log: withLog(state, { kind: event.type, text: formatSpecEvent(event) }),
      };
    }
    case 'batch_error':
      return {
        ...state,
        stage: null,
        counts: { ...state.counts, errors: state.counts.errors + 1 },
        log: withLog(state, { kind: event.type, text: formatSpecEvent(event) }),
      };
    case 'stopped':
      return { ...state, stopped: true, stage: null, pendingPaths: [] };
  }
}
