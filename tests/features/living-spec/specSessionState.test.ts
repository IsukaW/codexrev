import { describe, expect, it } from 'vitest';
import {
  formatSessionShutdown,
  formatSpecEvent,
  initialSpecSessionState,
  reduceSpecSession,
  MAX_SESSION_ALERTS,
  type SpecSessionState,
} from '../../../src/features/living-spec/cli/specSessionState.js';
import type { SpecSessionEvent } from '../../../src/features/living-spec/cli/specSessionEvents.js';
import { SpecSessionEventBus } from '../../../src/features/living-spec/cli/specSessionEvents.js';
import { ChangeBuffer, hashContent } from '../../../src/features/living-spec/pipeline/changeBuffer.js';
import type { SpecChangeDriftAlert } from '../../../src/features/living-spec/pipeline/types.js';

function alert(overrides: Partial<SpecChangeDriftAlert> = {}): SpecChangeDriftAlert {
  return {
    changeId: 'chg',
    file: 'src/greet.js',
    reason: 'conflict',
    affectedRequirement: 'sec-greeting',
    proposedNextAction: 'reconcile',
    severity: 'critical',
    timestamp: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

function start(state: SpecSessionState = initialSpecSessionState()): SpecSessionState {
  return reduceSpecSession(state, {
    type: 'session_start',
    at: 1,
    root: '/repo',
    watchedPaths: ['**/*.js'],
    debounceMs: 800,
  });
}

function complete(
  state: SpecSessionState,
  overrides: Partial<Extract<SpecSessionEvent, { type: 'batch_complete' }>> = {},
): SpecSessionState {
  return reduceSpecSession(state, {
    type: 'batch_complete',
    at: 2,
    changeId: 'abcdef1234567890',
    driftStatus: 'conflicting',
    proposals: 1,
    testDeltas: 2,
    alerts: [alert()],
    reportFile: '/repo/report.json',
    ...overrides,
  });
}

describe('reduceSpecSession — session lifecycle', () => {
  it('records the session start', () => {
    const state = start();
    expect(state.started).toBe(true);
    expect(state.root).toBe('/repo');
    expect(state.watchedPaths).toEqual(['**/*.js']);
    expect(state.debounceMs).toBe(800);
    expect(state.log).toHaveLength(1);
    expect(state.log[0].text).toContain('watching /repo');
  });

  it('tracks debounce pending paths and clears them when the batch starts', () => {
    let state = start();
    state = reduceSpecSession(state, { type: 'change_detected', at: 2, path: 'src/a.js' });
    state = reduceSpecSession(state, { type: 'change_detected', at: 3, path: 'src/b.js' });
    expect(state.pendingPaths).toEqual(['src/a.js', 'src/b.js']);

    state = reduceSpecSession(state, { type: 'batch_start', at: 4, paths: ['src/a.js'] });
    expect(state.stage).toBe('diff');
    expect(state.pendingPaths).toEqual(['src/b.js']);
  });

  it('walks the stage trail and clears it on completion', () => {
    let state = start();
    state = reduceSpecSession(state, { type: 'batch_start', at: 2, paths: ['src/a.js'] });
    expect(state.stage).toBe('diff');
    for (const stage of ['infer', 'compare', 'proposal', 'outputs', 'persist'] as const) {
      state = reduceSpecSession(state, { type: 'stage', at: 3, stage });
      expect(state.stage).toBe(stage);
    }
    state = complete(state);
    expect(state.stage).toBeNull();
  });

  it('clears the stage on skip and error', () => {
    let state = start();
    state = reduceSpecSession(state, { type: 'batch_start', at: 2, paths: ['src/a.js'] });
    state = reduceSpecSession(state, {
      type: 'batch_skipped',
      at: 3,
      paths: ['src/a.js'],
      reason: 'no effective diff',
    });
    expect(state.stage).toBeNull();
    expect(state.log[state.log.length - 1].text).toContain('no effective diff');

    state = reduceSpecSession(state, { type: 'batch_start', at: 4, paths: ['src/a.js'] });
    state = reduceSpecSession(state, { type: 'batch_error', at: 5, message: 'boom' });
    expect(state.stage).toBeNull();
    expect(state.counts.errors).toBe(1);
  });

  it('marks the session stopped', () => {
    let state = start();
    state = reduceSpecSession(state, { type: 'stopped', at: 9 });
    expect(state.stopped).toBe(true);
    expect(state.stage).toBeNull();
  });
});

describe('reduceSpecSession — running counts', () => {
  it('counts deduped saves (NFR3)', () => {
    let state = start();
    state = reduceSpecSession(state, { type: 'change_deduped', at: 2, path: 'src/a.js' });
    state = reduceSpecSession(state, { type: 'change_deduped', at: 3, path: 'src/a.js' });
    expect(state.counts.deduped).toBe(2);
  });

  it('accumulates analyzed batches, proposals, alerts, reports and latest drift', () => {
    let state = start();
    state = complete(state);
    expect(state.counts).toMatchObject({ analyzed: 1, proposals: 1, alerts: 1, reports: 1 });
    expect(state.latestDrift).toBe('conflicting');
    expect(state.lastChangeId).toBe('abcdef1234567890');

    state = complete(state, { driftStatus: 'new', proposals: 2, testDeltas: 0, alerts: [] });
    expect(state.counts).toMatchObject({ analyzed: 2, proposals: 3, alerts: 1, reports: 2 });
    expect(state.latestDrift).toBe('new');
  });

  it('does not count a dry-run batch as a written report', () => {
    let state = start();
    state = complete(state, { reportFile: null });
    expect(state.counts.reports).toBe(0);
  });

  it('bounds the live alert list but keeps the running count', () => {
    let state = start();
    const alerts = Array.from({ length: MAX_SESSION_ALERTS + 5 }, (_, i) =>
      alert({ changeId: `chg-${i}` }),
    );
    state = complete(state, { alerts });
    expect(state.alerts).toHaveLength(MAX_SESSION_ALERTS);
    expect(state.counts.alerts).toBe(MAX_SESSION_ALERTS + 5);
    expect(state.alerts[0].changeId).toBe('chg-5'); // oldest trimmed
  });
});

describe('formatSpecEvent — plain-line fallback', () => {
  it('renders one readable line per event', () => {
    expect(
      formatSpecEvent({ type: 'change_detected', at: 1, path: 'src/a.js' }),
    ).toBe('debouncing src/a.js');
    expect(
      formatSpecEvent({ type: 'change_deduped', at: 1, path: 'src/a.js' }),
    ).toBe('deduped src/a.js (identical to the last analysed state)');
    expect(formatSpecEvent({ type: 'batch_start', at: 1, paths: ['src/a.js'] })).toBe(
      'analysing src/a.js',
    );
    expect(
      formatSpecEvent({
        type: 'batch_complete',
        at: 1,
        changeId: 'abcdef1234567890',
        driftStatus: 'new',
        proposals: 1,
        testDeltas: 2,
        alerts: [],
        reportFile: '/r.json',
      }),
    ).toBe(
      'analyzed abcdef123456 — drift new · 1 proposal(s) · 2 test delta(s) · 0 alert(s) · report written',
    );
    expect(
      formatSpecEvent({
        type: 'batch_complete',
        at: 1,
        changeId: 'abcdef1234567890',
        driftStatus: 'no-semantic-change',
        proposals: 0,
        testDeltas: 0,
        alerts: [],
        reportFile: null,
        inferenceError: 'provider_unavailable',
      }),
    ).toContain('model provider_unavailable — deterministic only');
    expect(formatSpecEvent({ type: 'batch_error', at: 1, message: 'boom' })).toBe(
      'analysis failed: boom',
    );
    expect(formatSpecEvent({ type: 'stopped', at: 1 })).toBe('watch session stopped');
  });
});

describe('formatSessionShutdown', () => {
  it('summarizes the session counts and flags critical alerts', () => {
    let state = start();
    state = complete(state);
    state = reduceSpecSession(state, { type: 'change_deduped', at: 3, path: 'src/a.js' });
    const lines = formatSessionShutdown(state).join('\n');
    expect(lines).toContain('1 batch(es) analyzed');
    expect(lines).toContain('1 save(s) deduped');
    expect(lines).toContain('1 proposal(s)');
    expect(lines).toContain('1 report(s) written');
    expect(lines).toContain('1 critical drift alert(s)');
    expect(lines).toContain('codexrev spec status');
  });

  it('reports failures when any batch failed', () => {
    let state = start();
    state = reduceSpecSession(state, { type: 'batch_error', at: 2, message: 'boom' });
    expect(formatSessionShutdown(state).join('\n')).toContain('1 batch(es) failed');
  });

  it('stays to a single counts line for a quiet session', () => {
    const lines = formatSessionShutdown(start());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('0 batch(es) analyzed');
  });
});

describe('SpecSessionEventBus', () => {
  it('delivers events to subscribers and unsubscribes cleanly', () => {
    const bus = new SpecSessionEventBus();
    const seen: SpecSessionEvent[] = [];
    const unsubscribe = bus.subscribe((e) => seen.push(e));
    bus.emit({ type: 'change_detected', at: 1, path: 'a' });
    unsubscribe();
    bus.emit({ type: 'change_detected', at: 2, path: 'b' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'change_detected', path: 'a' });
  });
});

describe('ChangeBuffer push outcomes — the dedupe signal the view counts', () => {
  it('reports scheduled → deduped for an identical re-save after analysis', () => {
    const buffer = new ChangeBuffer({ debounceMs: 0 });
    const hash = hashContent('hello');
    expect(buffer.push({ path: 'src/a.js', hash })).toBe('scheduled');
    expect(buffer.push({ path: 'src/a.js', hash })).toBe('unchanged'); // same quiet period
    buffer.flush();
    expect(buffer.push({ path: 'src/a.js', hash })).toBe('deduped'); // analysed already
    buffer.dispose();
    expect(buffer.push({ path: 'src/a.js', hash })).toBe('ignored');
  });
});
