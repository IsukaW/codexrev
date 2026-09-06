/**
 * Codexrev — bridges `runPipeline()`/`runBreakerBuilderLoop()`'s plain
 * callbacks into a live React state update for the persistent
 * interactive Ink session.
 *
 * Neither is a generator, both are promise-returning functions with
 * `onXStart`/`onXComplete`-style callbacks — this tiny typed event bus
 * is the standard way to feed that into a mounted React tree via
 * `useEffect`, without either one needing to know anything about Ink or
 * React.
 */

import { EventEmitter } from 'node:events';
import type { RoleId, RoleOutput } from '../roles/roleContract.js';
import type { FixAttemptRecord, FixCandidate } from '../pipeline/breakerBuilderLoop.js';

export type ReviewSessionEvent =
  | { readonly type: 'role_start'; readonly role: RoleId }
  | { readonly type: 'role_complete'; readonly output: RoleOutput }
  | { readonly type: 'fix_iteration_start'; readonly iteration: number; readonly blockingFindingsCount: number }
  | { readonly type: 'fix_candidate'; readonly candidate: FixCandidate }
  | { readonly type: 'fix_batch_ready'; readonly candidates: readonly FixCandidate[]; readonly iteration: number }
  | { readonly type: 'fix_attempt'; readonly record: FixAttemptRecord }
  | { readonly type: 'fix_role_rerun'; readonly output: RoleOutput };

export class ReviewSessionEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: ReviewSessionEvent): void {
    this.emitter.emit('event', event);
  }

  /** Returns an unsubscribe function. */
  subscribe(handler: (event: ReviewSessionEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}
