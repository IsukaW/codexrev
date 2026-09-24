/**
 * Drives one `codexrev review scan` run end to end: loads settings, reads
 * the diff, builds the LLM provider, runs the six-role orchestrator,
 * resolves a decision, and (with --fix, on Block/Request Changes) runs the
 * Breaker-Builder loop before writing anything final.
 *
 * Only one resolver_decision audit line gets written per run — the final
 * decision, post-fix if the loop ran. Fix attempts each get their own audit
 * line the moment they land, same as role verdicts, plus a paired
 * fix-summary HTML report once the loop has run. Every role verdict goes to
 * audit.jsonl as it happens, even on a partial/errored run — the audit log
 * is never skipped. The scan report itself is skipped when the pipeline
 * errored before any role completed, since there'd be nothing to show.
 *
 * Non-interactive mode (no TTY, or --print) prints plain ANSI verdict lines
 * as roles complete. Interactive mode keeps one Ink app mounted for the
 * whole session including the fix loop — not remounted per gate, see
 * ReviewSessionView for the raw-mode bug that caused.
 *
 * Split out from handleReviewCommand.ts so it's testable without yargs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { render } from 'ink';
import React from 'react';
import { loadSettings } from '../../../config/loader.js';
import { MAX_FIX_ITERATIONS_CEILING } from '../../../config/schema.js';
import { createLLMProvider } from '../pipeline/illmProvider.js';
import { readDiff } from '../pipeline/diffReader.js';
import { runPipeline, type PipelineRunResult } from '../pipeline/orchestrator.js';
import { resolve, type ResolverResult } from '../pipeline/resolverEngine.js';
import { runBreakerBuilderLoop, type BreakerBuilderResult, type FixAttemptRecord } from '../pipeline/breakerBuilderLoop.js';
import { InteractionChannel } from '../../../core/interaction.js';
import {
  printBreakerBuilderOutcome,
  printFixAttempt,
  printFixIterationStart,
  printFixReportPath,
  printPipelineOutcome,
  printResolverDecision,
  printReportPaths,
  printVerdictLine,
} from './verdictPrinter.js';
import { ReviewSessionView } from './ReviewSessionView.js';
import { ReviewSessionEventBus } from './reviewSessionEvents.js';
import {
  appendAuditEntry,
  fixAttemptAuditEntry,
  newAuditRunId,
  resolverDecisionAuditEntry,
  roleVerdictAuditEntry,
  runStartAuditEntry,
} from '../tools/auditLogger.js';
import { defaultReportsDir, saveFixReport, saveReport, type ReportPaths } from './reportRenderer.js';
import type { ILLMProvider } from '../pipeline/illmProvider.js';
import type { RoleOutput } from '../roles/roleContract.js';

export interface ReviewSessionOptions {
  readonly cwd: string;
  readonly diffRef?: string;
  readonly ursPath?: string;
  /** forces non-interactive mode regardless of TTY (--print) */
  readonly forceNonInteractive?: boolean;
  /** --output <dir>, overrides the default reports location */
  readonly outputDir?: string;
  /** --fix, attempt the Breaker-Builder loop on Block/Request Changes */
  readonly fix?: boolean;
  /** --max-iterations, still clamped to the hard ceiling */
  readonly maxIterations?: number;
  /** test-only, bypasses createLLMProvider(settings) */
  readonly llmOverride?: ILLMProvider;
}

export interface ReviewSessionResult {
  readonly pipeline: PipelineRunResult;
  readonly resolver: ResolverResult;
  /** undefined when no report was written (pipeline errored before any role completed) */
  readonly reportPaths?: ReportPaths;
  /** set only when --fix actually triggered the loop */
  readonly breakerBuilder?: BreakerBuilderResult;
  /** absolute path to the fix-summary HTML report, set whenever breakerBuilder is */
  readonly fixReportPath?: string;
}

export async function runReviewSession(opts: ReviewSessionOptions): Promise<ReviewSessionResult> {
  const settings = await loadSettings(opts.cwd);

  const urs = opts.ursPath ? await fs.readFile(opts.ursPath, 'utf-8') : undefined;
  const diff = await readDiff(opts.cwd, opts.diffRef);

  const llm = opts.llmOverride ?? createLLMProvider(settings);
  const model = settings.providers[settings.provider]?.model ?? settings.model;

  const interactive = !opts.forceNonInteractive && process.stdout.isTTY === true;

  // one id per invocation so audit.jsonl stays groupable as it grows
  const runId = newAuditRunId();
  await appendAuditEntry(opts.cwd, runStartAuditEntry(runId, diff.ref));

  const onRoleCompleteAudit = async (output: RoleOutput): Promise<void> => {
    await appendAuditEntry(opts.cwd, roleVerdictAuditEntry(runId, output));
  };

  const onFixAttemptAudit = async (record: FixAttemptRecord): Promise<void> => {
    await appendAuditEntry(opts.cwd, fixAttemptAuditEntry(runId, record));
  };

  let pipeline: PipelineRunResult;
  let breakerBuilder: BreakerBuilderResult | undefined;
  let fixReportPathValue: string | undefined;
  /** set when the fix loop itself crashes; rethrown after the audit/report tail below */
  let fixLoopError: unknown;

  // one Ink app mounted across the scan and (if it runs) the fix loop —
  // same fix as the raw-mode bug, just covering the whole session now
  const interaction = interactive ? new InteractionChannel() : undefined;
  const events = interactive ? new ReviewSessionEventBus() : undefined;
  const app =
    interactive && events && interaction
      ? render(React.createElement(ReviewSessionView, { events, interactionChannel: interaction }))
      : undefined;
  let appUnmounted = false;
  const unmountApp = (): void => {
    if (appUnmounted) return;
    appUnmounted = true;
    app?.unmount();
  };

  try {
    pipeline = await runPipeline({
      diff,
      urs,
      llm,
      model,
      cwd: opts.cwd,
      interaction,
      onRoleStart: interactive ? (role) => events!.emit({ type: 'role_start', role }) : undefined,
      onRoleComplete: async (output) => {
        if (interactive) events!.emit({ type: 'role_complete', output });
        else printVerdictLine(output);
        await onRoleCompleteAudit(output);
      },
    });
    if (!interactive) printPipelineOutcome(pipeline);

    // resolve once just to check whether --fix is warranted — not printed
    // or audit-logged yet, only the final (post-fix) decision gets that
    let resolverResult = resolve(pipeline.aggregator.toJSON().roleOutputs, settings.reviewPipeline.resolverWeights);

    const shouldAttemptFix =
      !!opts.fix &&
      pipeline.outcome === 'completed' &&
      (resolverResult.decision === 'block' || resolverResult.decision === 'request_changes');

    if (shouldAttemptFix) {
      const maxIterations = Math.min(opts.maxIterations ?? settings.reviewPipeline.maxFixIterations, MAX_FIX_ITERATIONS_CEILING);
      try {
        breakerBuilder = await runBreakerBuilderLoop({
          aggregator: pipeline.aggregator,
          llm,
          model,
          cwd: opts.cwd,
          diffRef: opts.diffRef,
          urs,
          maxIterations,
          interaction,
          onIterationStart: interactive
            ? (iteration, blockingFindingsCount) => events!.emit({ type: 'fix_iteration_start', iteration, blockingFindingsCount })
            : printFixIterationStart,
          onFixCandidate: interactive ? (candidate) => events!.emit({ type: 'fix_candidate', candidate }) : undefined,
          onFixBatchReady: interactive
            ? (candidates, iteration) => events!.emit({ type: 'fix_batch_ready', candidates, iteration })
            : undefined,
          onFixAttempt: async (record) => {
            // audit-logged unconditionally, same as role verdicts, regardless of display mode
            if (interactive) events!.emit({ type: 'fix_attempt', record });
            else printFixAttempt(record);
            await onFixAttemptAudit(record);
          },
          onRoleRerun: interactive
            ? (output) => events!.emit({ type: 'fix_role_rerun', output })
            : (output) => printVerdictLine(output),
        });
        if (!interactive) printBreakerBuilderOutcome(breakerBuilder);
        // recompute — loop mutated pipeline.aggregator in place, so this reflects post-fix state
        resolverResult = resolve(pipeline.aggregator.toJSON().roleOutputs, settings.reviewPipeline.resolverWeights);

        // second HTML report, saved alongside the scan report and paired by runId
        const fixReportDir = opts.outputDir ? path.resolve(opts.cwd, opts.outputDir) : defaultReportsDir(opts.cwd);
        fixReportPathValue = await saveFixReport(
          {
            runId,
            generatedAt: new Date().toISOString(),
            outcome: breakerBuilder.outcome,
            iterations: breakerBuilder.iterations,
            fixAttempts: breakerBuilder.fixAttempts,
            unresolvedFindings: breakerBuilder.unresolvedFindings,
          },
          fixReportDir,
        );
      } catch (err) {
        // caught here (not left to propagate) so the unmount/audit/report
        // tail below still runs even if a role re-run crashes mid-loop —
        // used to just blow past all of that and we'd lose both reports
        // even though the scan already succeeded and fixes so far were
        // already logged one by one via onFixAttempt. resolverResult stays
        // at its pre-fix value since a crashed loop means no edit here is
        // trustworthy; fixLoopError gets rethrown at the very end, after
        // the tail runs, same handling as pipeline.error below.
        fixLoopError = err;
      }
    }

    unmountApp();
    if (fixLoopError) {
      // shown before the raw error reprints upstream, otherwise the last
      // thing on screen is a stale fix-confirm gate with no explanation
      console.error('\nBreaker-Builder loop failed before it could finish — see the error below. The pre-fix scan results are still saved.');
    }
    if (interactive) {
      if (breakerBuilder) printBreakerBuilderOutcome(breakerBuilder);
      printPipelineOutcome(pipeline);
    }

    // audit-log unconditionally even on 'errored' so a failed run still
    // leaves a complete trail; skip the console banner though, since a
    // decision based on zero completed roles would be misleading here
    if (pipeline.outcome !== 'errored') {
      printResolverDecision(resolverResult);
    }

    await appendAuditEntry(
      opts.cwd,
      resolverDecisionAuditEntry(runId, {
        decision: resolverResult.decision,
        score: resolverResult.score,
        rationale: resolverResult.rationale,
        appliedRules: resolverResult.appliedRules.map((r) => r.rule),
        ranRoles: pipeline.ranRoles,
        skippedRoles: pipeline.skippedRoles,
        pipelineOutcome: pipeline.outcome,
      }),
    );

    // skip the report if the pipeline errored before any role completed —
    // with zero outputs every section would just say "did not run", so
    // writing one is just noise. audit trail above still covers the attempt.
    // always resolve to an absolute path since --output can be relative.
    const hasReportableContent = pipeline.outcome !== 'errored' || pipeline.ranRoles.length > 0;
    let paths: ReportPaths | undefined;
    if (hasReportableContent) {
      const reportDir = opts.outputDir ? path.resolve(opts.cwd, opts.outputDir) : defaultReportsDir(opts.cwd);
      paths = await saveReport(
        {
          runId,
          generatedAt: new Date().toISOString(),
          diff,
          roleOutputs: pipeline.aggregator.toJSON().roleOutputs,
          resolver: resolverResult,
          pipelineOutcome: pipeline.outcome,
          ranRoles: pipeline.ranRoles,
          skippedRoles: pipeline.skippedRoles,
        },
        reportDir,
      );
      printReportPaths(paths);
      // only printed when the fix loop actually ran
      if (fixReportPathValue) printFixReportPath(fixReportPathValue);
    } else {
      console.log('\nNo report generated — the pipeline failed before any role completed. The attempt is still recorded in the audit log.');
    }

    if (pipeline.outcome === 'errored') {
      // audit/report already written above, now let the original error surface
      throw pipeline.error;
    }

    if (fixLoopError) {
      // same deal, but for a crash mid-fix-loop instead of mid-scan
      throw fixLoopError;
    }

    return { pipeline, resolver: resolverResult, reportPaths: paths, breakerBuilder, fixReportPath: fixReportPathValue };
  } catch (err) {
    unmountApp();
    throw err;
  }
}
