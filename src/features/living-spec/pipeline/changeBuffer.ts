/**
 * Change debounce + dedupe engine for the Living Specification Engine.
 *
 * Pure and deterministic: time comes in through an injectable `Clock` and all
 * scheduling goes through an injectable `TimerPort`, so tests drive it with
 * fake time instead of sleeping. No fs, no git, no LLM.
 *
 * Semantics (NFR3 — controlled save events are processed exactly once):
 *   - per-path debounce: rapid saves of one path coalesce into ONE change
 *     carrying the latest content hash;
 *   - hash dedupe: an effective change whose hash was already analysed is
 *     never emitted twice — including save spam and revert-to-analysed-state;
 *   - grouped emit: paths that settle in the same tick are emitted as one
 *     multi-file batch (a rename saves both sides together);
 *   - `changeId` = stable hash of ref + file list + diff content, used
 *     everywhere downstream (report ids, result ids).
 */

import { createHash } from 'node:crypto';
import { normalizeRelPath } from '../tools/pathMatcher.js';

/** Matches `codexrev spec watch --debounce`'s default. */
export const DEFAULT_DEBOUNCE_MS = 800;

export interface Clock {
  now(): number;
}

/** Opaque handle returned by `TimerPort.schedule`. */
export type TimerHandle = unknown;

export interface TimerPort {
  schedule(fn: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const systemTimers: TimerPort = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** One observed file change: project-relative path + content hash. */
export interface ChangeEvent {
  readonly path: string;
  readonly hash: string;
}

/**
 * What `ChangeBuffer.push` did with an event — lets callers (the watch
 * session's live view) report dedupe instead of guessing (NFR3).
 */
export type PushOutcome =
  /** Debounced; will be emitted in a future batch (content differs). */
  | 'scheduled'
  /** Identical to the pending content — still part of the same quiet period. */
  | 'unchanged'
  /** Identical to the last ANALYSED state — dropped, never analysed twice. */
  | 'deduped'
  /** The buffer was disposed; the event was ignored. */
  | 'ignored';

/** A coalesced set of effective changes ready to be analysed. */
export interface ChangeBatch {
  /** Sorted project-relative paths. */
  readonly paths: readonly string[];
  /** Latest content hash per path (same keys as `paths`). */
  readonly hashes: Readonly<Record<string, string>>;
  /** Paths dropped since the previous batch (identical hash already analysed). */
  readonly droppedDuplicates: readonly string[];
  /** `clock.now()` at emission time. */
  readonly emittedAt: number;
}

export interface ChangeBufferOptions {
  /** Quiet period per path before it settles (default: 800 ms). */
  readonly debounceMs?: number;
  readonly clock?: Clock;
  readonly timers?: TimerPort;
  readonly onBatch?: (batch: ChangeBatch) => void;
}

/** sha256 hex of a content string — the hash used in `ChangeEvent`. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Stable change id: sha256 over ref + sorted file list + diff content.
 * Identical inputs always produce the same id; the file-list order does not
 * matter because it is normalized before hashing.
 */
export function computeChangeId(input: {
  ref: string;
  files: readonly string[];
  diffContent: string;
}): string {
  const files = [...new Set(input.files.map(normalizeRelPath))].sort();
  const payload = [
    'codexrev-living-spec/change/v1',
    `ref=${input.ref}`,
    `files=${files.join('\n')}`,
    input.diffContent,
  ].join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export class ChangeBuffer {
  readonly debounceMs: number;

  private readonly clock: Clock;
  private readonly timers: TimerPort;
  private readonly onBatch: ((batch: ChangeBatch) => void) | undefined;

  /** Latest un-settled hash per path. */
  private readonly pending = new Map<string, string>();
  /** Settled paths waiting for the grouped emit. */
  private readonly ready = new Map<string, string>();
  /** Last hash actually analysed per path. */
  private readonly lastEmitted = new Map<string, string>();
  private readonly debounceHandles = new Map<string, TimerHandle>();
  private readonly dropped = new Set<string>();
  private emitHandle: TimerHandle | null = null;
  private disposed = false;

  constructor(options: ChangeBufferOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (this.debounceMs < 0) throw new RangeError('debounceMs must be >= 0');
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.onBatch = options.onBatch;
  }

  /** Records a change event; debounces per path and dedupes by hash. Returns what happened. */
  push(event: ChangeEvent): PushOutcome {
    if (this.disposed) return 'ignored';
    const { path, hash } = event;

    if (this.lastEmitted.get(path) === hash) {
      // identical effective change already analysed — never twice (NFR3).
      // A pending/ready different hash means the file was reverted to an
      // already-analysed state: drop that too, the net change is zero.
      this.clearPath(path);
      this.dropped.add(path);
      return 'deduped';
    }
    if (this.pending.get(path) === hash) {
      // unchanged pending content re-saved — the quiet period restarts only
      // when the effective content actually changes
      return 'unchanged';
    }

    this.pending.set(path, hash);
    this.cancelDebounce(path);
    this.debounceHandles.set(
      path,
      this.timers.schedule(() => this.onPathSettled(path), this.debounceMs),
    );
    return 'scheduled';
  }

  /** Paths with un-settled or settled-but-unemitted changes. */
  pendingPaths(): string[] {
    return [...new Set([...this.pending.keys(), ...this.ready.keys()])].sort();
  }

  /** Settles and emits everything now. Returns the batch, or null if empty. */
  flush(): ChangeBatch | null {
    for (const handle of this.debounceHandles.values()) this.timers.cancel(handle);
    this.debounceHandles.clear();
    if (this.emitHandle !== null) {
      this.timers.cancel(this.emitHandle);
      this.emitHandle = null;
    }
    for (const [path, hash] of this.pending) this.ready.set(path, hash);
    this.pending.clear();
    return this.emit();
  }

  /** Cancels all timers and forgets everything. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.debounceHandles.values()) this.timers.cancel(handle);
    this.debounceHandles.clear();
    if (this.emitHandle !== null) {
      this.timers.cancel(this.emitHandle);
      this.emitHandle = null;
    }
    this.pending.clear();
    this.ready.clear();
    this.dropped.clear();
  }

  private clearPath(path: string): void {
    this.pending.delete(path);
    this.ready.delete(path);
    this.cancelDebounce(path);
  }

  private cancelDebounce(path: string): void {
    const handle = this.debounceHandles.get(path);
    if (handle !== undefined) {
      this.timers.cancel(handle);
      this.debounceHandles.delete(path);
    }
  }

  private onPathSettled(path: string): void {
    this.debounceHandles.delete(path);
    const hash = this.pending.get(path);
    if (hash === undefined) return;
    this.pending.delete(path);
    this.ready.set(path, hash);
    this.scheduleEmit();
  }

  // paths settle together (a rename saves both sides in one tick); the 0 ms
  // grouping timer lets them arrive in a single multi-file batch
  private scheduleEmit(): void {
    if (this.emitHandle !== null) return;
    this.emitHandle = this.timers.schedule(() => {
      this.emitHandle = null;
      this.emit();
    }, 0);
  }

  private emit(): ChangeBatch | null {
    if (this.ready.size === 0) {
      this.dropped.clear();
      return null;
    }
    const paths = [...this.ready.keys()].sort();
    const hashes: Record<string, string> = {};
    for (const [path, hash] of this.ready) hashes[path] = hash;
    const batch: ChangeBatch = {
      paths,
      hashes,
      droppedDuplicates: [...this.dropped].sort(),
      emittedAt: this.clock.now(),
    };
    for (const path of paths) this.lastEmitted.set(path, hashes[path]);
    this.ready.clear();
    this.dropped.clear();
    this.onBatch?.(batch);
    return batch;
  }
}
