/**
 * Bridges runPipeline()/runBreakerBuilderLoop()'s callbacks into React state
 * updates for the persistent Ink session. Both are just promise-returning
 * functions with onXStart/onXComplete callbacks, so a small typed event bus
 * is the easiest way to feed a mounted tree via useEffect without either one
 * knowing about Ink or React.
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
