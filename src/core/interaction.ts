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

/**
 * A pending approval gate shown after one stage of a multi-stage
 * pipeline finishes (e.g. Feature 2's review pipeline, after every
 * role). Deliberately generic — no Feature-2-specific `Finding[]` shape
 * here, so this stays usable by any future multi-stage pipeline; the
 * caller that owns the richer payload (e.g. the review CLI) renders
 * "Details" itself from data it already has, rather than round-tripping
 * it through this channel.
 */
export interface StageGateRequest {
  readonly id: string;
  /** Machine identifier for the stage that just finished (e.g. a RoleId). */
  readonly stage: string;
  /** Human-readable label for the stage (e.g. "Business Analyst"). */
  readonly stageLabel: string;
  /** Short outcome label for the stage (e.g. "pass" | "flag" | "block"). */
  readonly status: string;
  readonly summary: string;
}

/** Decision from a `StageGateRequest`. 'details' re-prompts after the caller shows more info. */
export type StageGateDecision = 'continue' | 'details' | 'skip' | 'abort';

/** A pending tool-execution approval gate (shell / write_file / edit). */
export interface ApprovalRequest {
  readonly id: string;
  /** Tool being invoked, e.g. "shell". */
  readonly toolName: string;
  /** Human-readable one-line description of what will run. */
  readonly summary: string;
}

/** Decision from an `ApprovalRequest`. */
export type ApprovalDecision = 'approve' | 'approve-session' | 'deny';

export type InteractionEvent =
  | { type: 'clarification_request'; request: ClarificationRequest }
  | { type: 'fix_confirm_request'; request: FixConfirmRequest }
  | { type: 'stage_gate_request'; request: StageGateRequest }
  | { type: 'approval_request'; request: ApprovalRequest }
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

  /**
   * Ask the user to continue/see details/skip the rest/abort after one
   * pipeline stage finishes. Blocks until answered. On 'details' the
   * caller is expected to render more info and call this again for the
   * same stage — this method itself does not loop.
   */
  requestStageGate(
    stage: string,
    stageLabel: string,
    status: string,
    summary: string,
  ): Promise<StageGateDecision> {
    if (this.aborted) return Promise.reject(new Error('interaction aborted'));

    const id = String(this.nextId++);
    const request: StageGateRequest = { id, stage, stageLabel, status, summary };

    return new Promise<StageGateDecision>((resolve) => {
      const handler = (response: { id: string; decision: StageGateDecision }) => {
        if (response.id === id) {
          this.emitter.off('stage_gate_response', handler);
          resolve(response.decision);
        }
      };
      this.emitter.on('stage_gate_response', handler);
      this.emitter.emit('interaction', {
        type: 'stage_gate_request',
        request,
      } satisfies InteractionEvent);
    });
  }

  /**
   * Ask the user to approve a single tool invocation. Blocks until the
   * UI responds. Returns the raw decision so the caller can implement
   * "approve for the rest of this session".
   */
  requestApproval(toolName: string, summary: string): Promise<ApprovalDecision> {
    if (this.aborted) return Promise.resolve('deny');

    const id = String(this.nextId++);
    const request: ApprovalRequest = { id, toolName, summary };

    return new Promise<ApprovalDecision>((resolve) => {
      const handler = (response: { id: string; decision: ApprovalDecision }) => {
        if (response.id === id) {
          this.emitter.off('approval_response', handler);
          resolve(response.decision);
        }
      };
      this.emitter.on('approval_response', handler);
      this.emitter.emit('interaction', {
        type: 'approval_request',
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

  /** Send a stage-gate decision back to the pipeline. */
  respondStageGate(id: string, decision: StageGateDecision): void {
    this.emitter.emit('stage_gate_response', { id, decision });
  }

  /** Send a tool-approval decision back to the agent loop. */
  respondApproval(id: string, decision: ApprovalDecision): void {
    this.emitter.emit('approval_response', { id, decision });
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
