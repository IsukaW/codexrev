// Accumulates role outputs as the pipeline runs. Starts with { diff, urs? },
// and the orchestrator appends each role's RoleOutput here as it finishes so
// later roles' prompts can see what earlier ones found. Resolver and the
// report renderer both read the final snapshot via toJSON().
//
// Doesn't enforce ROLE_ORDER itself — that's the orchestrator's job. Just
// guarantees a role's output isn't silently overwritten, and keeps completion order.

import type { ParsedDiff } from './diffReader.js';
import type { RoleId, RoleOutput } from '../roles/roleContract.js';
import { CodexrevError } from '../../../utils/errors.js';

export class ContextAggregatorError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_CONTEXT_AGGREGATOR_ERROR', false);
    this.name = 'ContextAggregatorError';
  }
}

export interface AggregatedContext {
  readonly diff: ParsedDiff;
  readonly urs?: string;
  readonly roleOutputs: Readonly<Partial<Record<RoleId, RoleOutput>>>; // keyed by role, insertion order = finish order
}

export class ContextAggregator {
  private readonly diff: ParsedDiff;
  private readonly urs?: string;
  private readonly roleOutputs = new Map<RoleId, RoleOutput>(); // Map keeps insertion order, toJSON relies on that

  constructor(diff: ParsedDiff, urs?: string) {
    this.diff = diff;
    this.urs = urs;
  }

  // throws if the role already has a result — re-runs should go through
  // replaceRoleOutput instead, which is explicit about overwriting
  addRoleOutput(output: RoleOutput): void {
    if (this.roleOutputs.has(output.role)) {
      throw new ContextAggregatorError(
        `role "${output.role}" already has a recorded output in this context — use replaceRoleOutput() to re-run it.`,
      );
    }
    this.roleOutputs.set(output.role, output);
  }

  // overwrites in place, keeps original position. used by the breaker-builder
  // loop when it re-runs only the roles that were blocking
  replaceRoleOutput(output: RoleOutput): void {
    this.roleOutputs.set(output.role, output);
  }

  getRoleOutput(role: RoleId): RoleOutput | undefined {
    return this.roleOutputs.get(role);
  }

  hasRoleOutput(role: RoleId): boolean {
    return this.roleOutputs.has(role);
  }

  get completedRoles(): readonly RoleId[] {
    return [...this.roleOutputs.keys()];
  }

  toJSON(): AggregatedContext {
    return {
      diff: this.diff,
      ...(this.urs !== undefined ? { urs: this.urs } : {}),
      roleOutputs: Object.fromEntries(this.roleOutputs) as Partial<Record<RoleId, RoleOutput>>,
    };
  }
}
