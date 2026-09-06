// Runs the six roles in strict order, feeding each the same aggregator +
// provider and appending its output before the next role starts.
//
// Interactive mode (InteractionChannel passed in) pauses for a
// Continue/Details/Skip/Abort gate after each role. Non-interactive (CI,
// --print) just runs straight through.

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

// exported so breakerBuilderLoop.ts can re-run individual roles without its own copy of this map
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
  readonly interaction?: InteractionChannel; // omit for non-interactive (CI/--print), runs straight through
  readonly onRoleStart?: (role: RoleId) => void; // fires right before a role's LLM call (or Build's shell-out) so the CLI can show a spinner
  // fires right after a role finishes, awaited before moving on — CLI uses this to print the
  // verdict and append the audit-log entry; awaiting it means the entry is flushed before the
  // next role starts, so a crash mid-run still leaves a complete trail up to the last role that ran
  readonly onRoleComplete?: (output: RoleOutput) => void | Promise<void>;
}

export interface PipelineRunResult {
  readonly outcome: PipelineOutcome;
  readonly aggregator: ContextAggregator; // final accumulated context, feed straight to Resolver/report renderer
  readonly ranRoles: readonly RoleId[];
  readonly skippedRoles: readonly RoleId[]; // never ran because a skip/abort or a role error stopped things early
  readonly error?: unknown; // set only when outcome === 'errored'
}

// Gate semantics in interactive mode: 'continue' moves to the next role,
// 'details' re-prompts the same gate (CLI already printed findings via
// onRoleComplete), 'skip' stops but keeps completed roles so the Resolver
// can still work off a partial run, 'abort' does the same but tagged
// outcome: 'aborted' so the audit logger can tell them apart.
//
// A role throwing doesn't propagate out of here — it's caught into
// outcome: 'errored' with the error attached, same partial shape as skip/abort,
// so runReviewSession can always write the audit trail before re-throwing.
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

// loops the gate for one role until a non-'details' decision comes back
async function runGateUntilDecided(
  channel: InteractionChannel,
  role: RoleId,
  output: RoleOutput,
): Promise<'continue' | 'skip' | 'abort'> {
  for (;;) {
    const decision = await channel.requestStageGate(role, ROLE_LABELS[role], output.verdict, output.summary);
    if (decision !== 'details') return decision;
    // 'details' loops back — CLI already printed the full findings before responding
  }
}
