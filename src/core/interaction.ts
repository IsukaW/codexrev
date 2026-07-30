/**
 * Codexrev — interaction channel for mid-run pauses.
 *
 * Provides an async producer-consumer mechanism for the agent pipeline
 * to pause and wait on user input (clarification questions, fix-confirm
 * decisions). The UI subscribes to events and sends responses back.
 */

import { EventEmitter } from 'node:events';

/** A pending clarification request from the pipeline. */
export interface ClarificationRequest {
  readonly id: string;
  readonly question: string;
  readonly suggestions: readonly string[];
  readonly context?: string;
}

/** A pending fix-confirm request from the fix loop. */
export interface FixConfirmRequest {
  readonly id: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly summary: string;
  readonly status: 'red' | 'green' | 'checking';
}

export type InteractionEvent =
  | { type: 'clarification_request'; request: ClarificationRequest }
  | { type: 'fix_confirm_request'; request: FixConfirmRequest }
  | { type: 'abort' };

/**
 * Shared channel between the pipeline and the UI.
 *
 * The pipeline calls `requestClarification()` / `requestFixConfirmation()`
 * which return Promises that block until the UI calls `respond*()`.
 */
export class InteractionChannel {
  private readonly emitter = new EventEmitter();
  private nextId = 1;
  private aborted = false;

  // ── Pipeline side (producer) ────────────────────────────────────

  /** Ask the user a clarification question. Blocks until answered. */
  requestClarification(
    question: string,
    suggestions: readonly string[] = [],
    context?: string,
  ): Promise<string> {
    if (this.aborted) return Promise.reject(new Error('interaction aborted'));

    const id = String(this.nextId++);
    const request: ClarificationRequest = { id, question, suggestions, context };

    return new Promise<string>((resolve) => {
      const handler = (response: { id: string; answer: string }) => {
        if (response.id === id) {
          this.emitter.off('clarification_response', handler);
          resolve(response.answer);
        }
      };
      this.emitter.on('clarification_response', handler);
      this.emitter.emit('interaction', {
        type: 'clarification_request',
        request,
      } satisfies InteractionEvent);
    });
  }

  /** Ask the user whether to continue or stop the fix loop. Blocks until answered. */
  requestFixConfirmation(
    attempt: number,
    maxAttempts: number,
    summary: string,
    status: 'red' | 'green' | 'checking',
  ): Promise<'continue' | 'stop'> {
    if (this.aborted) return Promise.reject(new Error('interaction aborted'));

    const id = String(this.nextId++);
    const request: FixConfirmRequest = { id, attempt, maxAttempts, summary, status };

    return new Promise<'continue' | 'stop'>((resolve) => {
      const handler = (response: { id: string; decision: 'continue' | 'stop' }) => {
        if (response.id === id) {
          this.emitter.off('fix_confirm_response', handler);
          resolve(response.decision);
        }
      };
      this.emitter.on('fix_confirm_response', handler);
      this.emitter.emit('interaction', {
        type: 'fix_confirm_request',
        request,
      } satisfies InteractionEvent);
    });
  }

  // ── UI side (consumer) ──────────────────────────────────────────

  /** Subscribe to interaction events from the pipeline. */
  onInteraction(handler: (event: InteractionEvent) => void): () => void {
    this.emitter.on('interaction', handler);
    return () => this.emitter.off('interaction', handler);
  }

  /** Send a clarification answer back to the pipeline. */
  respondClarification(id: string, answer: string): void {
    this.emitter.emit('clarification_response', { id, answer });
  }

  /** Send a fix-confirm decision back to the pipeline. */
  respondFixConfirmation(id: string, decision: 'continue' | 'stop'): void {
    this.emitter.emit('fix_confirm_response', { id, decision });
  }

  /** Abort all pending requests. Promises reject with an Error. */
  abort(): void {
    this.aborted = true;
    this.emitter.emit('interaction', { type: 'abort' } satisfies InteractionEvent);
  }

  /** Reset the aborted state (for reuse across prompts). */
  reset(): void {
    this.aborted = false;
  }
}
