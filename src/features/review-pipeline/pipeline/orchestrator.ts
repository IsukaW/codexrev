/**
 * Codexrev — Feature 2 (review-pipeline) six-role sequential orchestrator.
 *
 * Runs the six roles in strict order (BA → Dev → Build → Sec → QA →
 * PM, per Section 2), feeding each one the same `ContextAggregator` +
 * `ILLMProvider` and appending its output before the next role starts —
 * the literal "full context accumulation" from the methodology.
 *
 * Interactive mode (an `InteractionChannel` is passed in) pauses for a
 * Continue/Details/Skip/Abort gate after every role, reusing the
 * `StageGateRequest`/`StageGateDecision` plumbing added to
 * `core/interaction.ts` in this phase. Non-interactive mode (no
 * channel — CI / `--print`) runs straight through with no gates.
 */

import { ROLE_LABELS, ROLE_ORDER, type RoleId, type RoleOutput } from '../roles/roleContract.js';
import { runBaRole } from '../roles/ba.js';
import { runDevRole } from '../roles/dev.js';
import { runBuildRole } from '../roles/build.js';
import { runSecRole } from '../roles/sec.js';
import { runQaRole } from '../roles/qa.js';
import { runPmRole } from '../roles/pm.js';
import { ContextAggregator } from './contextAggregator.js';
import type { ParsedDiff } from './diffReader.js';
import type { ILLMProvider } from './illmProvider.js';
import type { RoleRunContext } from './roleRunContext.js';
import { InteractionChannel } from '../../../core/interaction.js';

/** Exported so Phase 8's `breakerBuilderLoop.ts` can re-run individual roles without duplicating this map. */
export const ROLE_RUNNERS: Readonly<Record<RoleId, (ctx: RoleRunContext) => Promise<RoleOutput>>> = {
  ba: runBaRole,
  dev: runDevRole,
  build: runBuildRole,
  sec: runSecRole,
  qa: runQaRole,
  pm: runPmRole,
};

export type PipelineOutcome = 'completed' | 'skipped' | 'aborted' | 'errored';

export interface RunPipelineOptions {
  readonly diff: ParsedDiff;
  readonly urs?: string;
  readonly llm: ILLMProvider;
  readonly model: string;
  readonly cwd: string;
  /**
   * When provided, the orchestrator pauses for a Continue/Details/Skip/
   * Abort gate after every role via `channel.requestStageGate()`. Omit
   * for non-interactive (CI / `--print`) mode, which runs straight
   * through.
   */
  readonly interaction?: InteractionChannel;
  /**
   * Called right before each role starts (i.e. right before its LLM
   * call, or right before the Build role shells out). This is how the
   * CLI shows "Business Analyst — running…" with a spinner instead of
   * going quiet for however long the model call takes.
   */
  readonly onRoleStart?: (role: RoleId) => void;
  /**
   * Called immediately after each role finishes, before the gate (if
   * any) — and *awaited* before moving on. This is how the CLI prints
   * the verdict, captures the full `RoleOutput` for "Details", and (from
   * Phase 6) appends that role's audit-log entry — awaiting it means the
   * entry is flushed to `.codexrev/audit.jsonl` before the next role
   * even starts, so a crash mid-run still leaves an honest, complete
   * trail up to the last role that actually finished.
   */
  readonly onRoleComplete?: (output: RoleOutput) => void | Promise<void>;
}

export interface PipelineRunResult {
  readonly outcome: PipelineOutcome;
  /** Final accumulated context — pass straight to Phase 6's Resolver / Phase 7's report renderer. */
  readonly aggregator: ContextAggregator;
  readonly ranRoles: readonly RoleId[];
  /** Roles never run because a Skip/Abort gate decision or a role error stopped the pipeline early. */
  readonly skippedRoles: readonly RoleId[];
  /** Set only when `outcome === 'errored'` — the error a role threw (e.g. a `ProviderError`). */
  readonly error?: unknown;
}

/**
 * Runs all six roles in `ROLE_ORDER`, in strict sequence, feeding each
 * one the shared `ContextAggregator` + `ILLMProvider`.
 *
 * Gate semantics (interactive mode only):
 *   - 'continue' → proceed to the next role.
 *   - 'details'  → re-prompt the same gate (the CLI has already shown
 *                  the role's full findings via `onRoleComplete`).
 *   - 'skip'     → stop running further roles; the roles already
 *                  completed are kept, so the Resolver/report can still
 *                  work from a partial run.
 *   - 'abort'    → stop immediately; same partial-result shape as
 *                  'skip', distinguished by `outcome: 'aborted'` so a
 *                  caller (e.g. the audit logger in Phase 6) can record
 *                  it distinctly.
 *
 * A role throwing (e.g. a `ProviderError` from a bad API key) does
 * NOT propagate out of this function — it's caught and turned into
 * `outcome: 'errored'` with the underlying error attached, same
 * partial-result shape as skip/abort. This guarantees the caller always
 * gets a normal result to resolve + audit-log (Golden Rule: never skip
 * the audit log, even on failure) — `runReviewSession.ts` re-throws
 * `result.error` itself, after writing the audit trail, so the outward
 * error-surfacing behavior callers already depend on is unchanged.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineRunResult> {
  const aggregator = new ContextAggregator(opts.diff, opts.urs);
  const ranRoles: RoleId[] = [];

  for (let i = 0; i < ROLE_ORDER.length; i++) {
    const role = ROLE_ORDER[i];
    const ctx: RoleRunContext = {
      llm: opts.llm,
      model: opts.model,
      diff: opts.diff,
      urs: opts.urs,
      aggregator,
      cwd: opts.cwd,
    };

    opts.onRoleStart?.(role);
    let output: RoleOutput;
    try {
      output = await ROLE_RUNNERS[role](ctx);
    } catch (error) {
      return { outcome: 'errored', aggregator, ranRoles, skippedRoles: ROLE_ORDER.slice(i), error };
    }
    aggregator.addRoleOutput(output);
    ranRoles.push(role);
    await opts.onRoleComplete?.(output);

    if (opts.interaction) {
      const decision = await runGateUntilDecided(opts.interaction, role, output);
      if (decision === 'skip' || decision === 'abort') {
        return {
          outcome: decision === 'skip' ? 'skipped' : 'aborted',
          aggregator,
          ranRoles,
          skippedRoles: ROLE_ORDER.slice(i + 1),
        };
      }
    }
  }

  return { outcome: 'completed', aggregator, ranRoles, skippedRoles: [] };
}

/** Loops the stage gate for one role until a non-'details' decision comes back. */
async function runGateUntilDecided(
  channel: InteractionChannel,
  role: RoleId,
  output: RoleOutput,
): Promise<'continue' | 'skip' | 'abort'> {
  for (;;) {
    const decision = await channel.requestStageGate(role, ROLE_LABELS[role], output.verdict, output.summary);
    if (decision !== 'details') return decision;
    // 'details' loops back around — the CLI-side subscriber is expected
    // to have already printed the full findings before responding.
  }
}
