/**
 * Typed event bus for one `codexrev spec watch` session — the seam between
 * the pipeline and the session UI (the persistent Ink tree on a TTY, the
 * plain-line fallback in CI/pipes). Neither side knows about the other:
 * runWatchSession emits, the view/reducer subscribes.
 *
 * Same narrow pattern as review-pipeline's `reviewSessionEvents.ts`, but
 * self-contained (no shared imports between features).
 */

import { EventEmitter } from 'node:events';
import type { SpecChangeDriftAlert, SpecDriftStatus } from '../pipeline/types.js';

/** Stages of one analysed batch, in pipeline order. 'diff' is pre-pass. */
export type SpecWatchStage = 'diff' | 'infer' | 'compare' | 'proposal' | 'outputs' | 'persist';

export type SpecSessionEvent =
  | {
      readonly type: 'session_start';
      readonly at: number;
      readonly root: string;
      readonly watchedPaths: readonly string[];
      readonly debounceMs: number;
    }
  /** A save was seen and pushed into the debounce buffer. */
  | { readonly type: 'change_detected'; readonly at: number; readonly path: string }
  /** A save matched the last analysed state — dropped, never re-analysed (NFR3). */
  | { readonly type: 'change_deduped'; readonly at: number; readonly path: string }
  | { readonly type: 'batch_start'; readonly at: number; readonly paths: readonly string[] }
  /** One pipeline stage of the current batch has begun. */
  | { readonly type: 'stage'; readonly at: number; readonly stage: SpecWatchStage }
  /** The batch produced no effective diff — nothing analysed. */
  | {
      readonly type: 'batch_skipped';
      readonly at: number;
      readonly paths: readonly string[];
      readonly reason: string;
    }
  /** One batch fully analysed (report JSON written unless --dry-run). */
  | {
      readonly type: 'batch_complete';
      readonly at: number;
      readonly changeId: string;
      readonly driftStatus: SpecDriftStatus;
      readonly proposals: number;
      readonly testDeltas: number;
      readonly alerts: readonly SpecChangeDriftAlert[];
      readonly reportFile: string | null;
      /** Model inference failure code, when the semantic half could not run. */
      readonly inferenceError?: string;
    }
  | { readonly type: 'batch_error'; readonly at: number; readonly message: string }
  /** Ctrl+C (or the stop signal) — the session is shutting down. */
  | { readonly type: 'stopped'; readonly at: number };

export class SpecSessionEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: SpecSessionEvent): void {
    this.emitter.emit('event', event);
  }

  /** Returns an unsubscribe function. */
  subscribe(handler: (event: SpecSessionEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}
