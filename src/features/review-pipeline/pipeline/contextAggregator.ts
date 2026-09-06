/**
 * Codexrev — Feature 2 (review-pipeline) context accumulator.
 *
 * The literal implementation of "context accumulation" from the
 * methodology: starts with `{ diff, urs? }`, and after each role
 * finishes, the orchestrator (Phase 5) appends that role's full
 * `RoleOutput` here so every subsequent role's prompt can be built with
 * everything found so far. The Resolver Engine (Phase 6) and the report
 * renderer (Phase 7) both read the final snapshot via `toJSON()`.
 *
 * Deliberately does not enforce `ROLE_ORDER` (BA → Dev → Build → Sec →
 * QA → PM) — driving that sequence is the orchestrator's job, not the
 * accumulator's. This class only guarantees two things: no role's
 * output can be silently overwritten, and the accumulated snapshot
 * preserves the order roles actually completed in.
 */

import type { ParsedDiff } from './diffReader.js';
import type { RoleId, RoleOutput } from '../roles/roleContract.js';
import { CodexrevError } from '../../../utils/errors.js';

export class ContextAggregatorError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_CONTEXT_AGGREGATOR_ERROR', false);
    this.name = 'ContextAggregatorError';
  }
}

/** JSON-serializable snapshot of everything accumulated so far. */
export interface AggregatedContext {
  readonly diff: ParsedDiff;
  readonly urs?: string;
  /** One key per completed role, inserted in the order each role finished. */
  readonly roleOutputs: Readonly<Partial<Record<RoleId, RoleOutput>>>;
}

export class ContextAggregator {
  private readonly diff: ParsedDiff;
  private readonly urs?: string;
  /** A `Map` preserves insertion order — that's what makes `toJSON()`'s key order meaningful. */
  private readonly roleOutputs = new Map<RoleId, RoleOutput>();

  constructor(diff: ParsedDiff, urs?: string) {
    this.diff = diff;
    this.urs = urs;
  }

  /**
   * Append one role's completed output. Throws if that role has already
   * recorded a result — a role contract violation, not a normal-flow
   * case (re-runs after a fix, e.g. Phase 8, go through
   * `replaceRoleOutput` instead, which is explicit about overwriting).
   */
  addRoleOutput(output: RoleOutput): void {
    if (this.roleOutputs.has(output.role)) {
      throw new ContextAggregatorError(
        `role "${output.role}" already has a recorded output in this context — use replaceRoleOutput() to re-run it.`,
      );
    }
    this.roleOutputs.set(output.role, output);
  }

  /**
   * Explicitly overwrite a role's output, keeping its original position
   * in iteration order. Used by Phase 8's Breaker-Builder loop, which
   * re-runs only the roles that failed rather than the full six.
   */
  replaceRoleOutput(output: RoleOutput): void {
    this.roleOutputs.set(output.role, output);
  }

  getRoleOutput(role: RoleId): RoleOutput | undefined {
    return this.roleOutputs.get(role);
  }

  hasRoleOutput(role: RoleId): boolean {
    return this.roleOutputs.has(role);
  }

  /** Roles completed so far, in the order they finished. */
  get completedRoles(): readonly RoleId[] {
    return [...this.roleOutputs.keys()];
  }

  /** Snapshot for the next role's prompt, the Resolver, or the report renderer. */
  toJSON(): AggregatedContext {
    return {
      diff: this.diff,
      ...(this.urs !== undefined ? { urs: this.urs } : {}),
      roleOutputs: Object.fromEntries(this.roleOutputs) as Partial<Record<RoleId, RoleOutput>>,
    };
  }
}
