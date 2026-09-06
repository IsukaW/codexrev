/**
 * Codexrev — drives one `codexrev review scan` run end to end.
 *
 * Wires together everything built in Phases 2-9: loads settings, reads
 * the diff (`diffReader.ts`), builds the shared `ILLMProvider`
 * (`illmProvider.ts`), runs the six-role orchestrator, resolves a
 * decision (`resolverEngine.ts`) — and, when `--fix` is set and that
 * decision is Block or Request Changes, runs the Breaker-Builder loop
 * (`breakerBuilderLoop.ts`) before finalizing anything. Only ONE
 * `resolver_decision` audit line is written per run — the FINAL
 * decision (post-fix, if the loop ran) — matching Phase 6's "one final
 * line" wording; Phase 9 adds one `fix_attempt` audit line per applied
 * fix alongside it (appended the moment each fix lands, same
 * "never batch, never skip" discipline as role verdicts), plus a
 * second, fix-summary HTML report once the loop has run. Appends every
 * role verdict to `.codexrev/audit.jsonl` (`auditLogger.ts`) as it
 * happens, even on a Skip/Abort/error partial run (Golden Rule: never
 * skip the audit log), and renders the final JSON/Markdown/HTML scan
 * report (`reportRenderer.ts`) to `.codexrev/review-pipeline/reports/`
 * (or `--output <dir>`) reflecting that same final state — UNLESS the
 * pipeline errored before a single role completed, in which case there
 * is nothing reviewer-facing to show and no report is written (the audit
 * entry above is still the durable record of the attempt) — plus, when
 * `--fix` ran, a paired `fix-<timestamp>.html` in the same directory.
 *
 * Non-interactive mode (no TTY, or `--print`) prints plain ANSI verdict
 * lines as roles complete (`verdictPrinter.ts`) — no Ink involved.
 * Interactive mode mounts ONE persistent Ink app (`ReviewSessionView`)
 * for the whole session, fix loop included — deliberately not a fresh
 * mount per gate; see that file's docstring for the raw-mode bug that
 * caused.
 *
 * Kept separate from `handleReviewCommand.ts` so it's independently
 * testable without going through yargs argument parsing.
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
  /** Force non-interactive mode regardless of TTY (e.g. the global `--print` flag was set). */
  readonly forceNonInteractive?: boolean;
  /** `--output <dir>` — overrides the default `.codexrev/review-pipeline/reports/` location. */
  readonly outputDir?: string;
  /** `--fix` — attempt the Breaker-Builder loop if the scan's decision is Block or Request Changes. */
  readonly fix?: boolean;
  /** `--max-iterations <n>` — overrides `settings.reviewPipeline.maxFixIterations` for this run, still clamped to the hard ceiling (5). */
  readonly maxIterations?: number;
  /** Test-only override — bypasses `createLLMProvider(settings)` when given. */
  readonly llmOverride?: ILLMProvider;
}

export interface ReviewSessionResult {
  readonly pipeline: PipelineRunResult;
  readonly resolver: ResolverResult;
  /** Undefined exactly when no report was written — the pipeline errored before any role completed. */
  readonly reportPaths?: ReportPaths;
  /** Set only when `--fix` actually triggered the loop (decision was Block/Request Changes and the scan completed). */
  readonly breakerBuilder?: BreakerBuilderResult;
  /** Absolute path to the Phase 9 fix-summary HTML report — set exactly when `breakerBuilder` is. */
  readonly fixReportPath?: string;
}

export async function runReviewSession(opts: ReviewSessionOptions): Promise<ReviewSessionResult> {
  const settings = await loadSettings(opts.cwd);

  const urs = opts.ursPath ? await fs.readFile(opts.ursPath, 'utf-8') : undefined;
  const diff = await readDiff(opts.cwd, opts.diffRef);

  const llm = opts.llmOverride ?? createLLMProvider(settings);
  const model = settings.providers[settings.provider]?.model ?? settings.model;

  const interactive = !opts.forceNonInteractive && process.stdout.isTTY === true;

  // One id per invocation — every entry this run writes carries it, so
  // `audit.jsonl` (which accumulates across every run forever) stays
  // groupable/readable as it grows. See auditLogger.ts's docstring.
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
  /** Set when the fix loop itself throws (not a role verdict, a crash mid-loop) — rethrown after the audit/report tail below, never silently swallowed. */
  let fixLoopError: unknown;

  // Interactive mode keeps ONE Ink app mounted across both the scan and
  // (if it runs) the fix loop — same reasoning as Phase 5's single-mount
  // fix for the raw-mode bug, just extended to cover the whole session.
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

    // Resolve once to see whether --fix is even warranted. Not printed or
    // audit-logged yet — only the FINAL decision (post-fix, if the loop
    // runs) gets the one "resolver_decision" audit line and console
    // banner, per this file's docstring.
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
            // Audit-logged unconditionally, same as role verdicts (Golden
            // Rule: every fix attempt gets an entry, Phase 9's "New" bullet
            // 1) — independent of whether the mode also displays it.
            if (interactive) events!.emit({ type: 'fix_attempt', record });
            else printFixAttempt(record);
            await onFixAttemptAudit(record);
          },
          onRoleRerun: interactive
            ? (output) => events!.emit({ type: 'fix_role_rerun', output })
            : (output) => printVerdictLine(output),
        });
        if (!interactive) printBreakerBuilderOutcome(breakerBuilder);
        // Recompute — the loop mutated `pipeline.aggregator` in place via
        // `replaceRoleOutput`, so this reflects the post-fix state.
        resolverResult = resolve(pipeline.aggregator.toJSON().roleOutputs, settings.reviewPipeline.resolverWeights);

        // Second HTML report (Phase 9's "New" bullet 2/3) — what the loop
        // actually changed, saved to the same reports dir as the scan
        // report so the two sit side by side, paired by sharing `runId`.
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
        // Unlike a role failing during the scan (which `runPipeline`
        // catches internally and turns into `outcome: 'errored'` — see
        // that file's docstring), a role RE-RUN failing mid-fix-loop
        // (e.g. a ProviderError, a transient "400" from the provider)
        // used to propagate straight out of this whole function via the
        // catch at the bottom, skipping every line below here — audit
        // trail AND both HTML reports, even though the scan itself
        // already completed successfully and any fixes applied before
        // the crash are already durably audit-logged one by one (see
        // `onFixAttempt` above). Reported live: a real `--fix` run hit a
        // provider error mid-loop and neither report ever got written.
        // Caught here instead, so control still reaches the unmount +
        // audit + report tail below with whatever state exists —
        // `resolverResult` stays at its PRE-FIX value (still accurate:
        // the loop crashing means none of its edits are known-good) —
        // and `fixLoopError` is rethrown only at the very end, once
        // that tail has run, matching how `pipeline.error` is already
        // handled for a scan-time failure.
        fixLoopError = err;
      }
    }

    unmountApp();
    if (fixLoopError) {
      // Visible before the raw error reprints via `handleReviewCommand.ts`'s
      // catch — otherwise the last thing on screen is a stale fix-confirm
      // gate with no indication *why* nothing happened after it.
      console.error('\nBreaker-Builder loop failed before it could finish — see the error below. The pre-fix scan results are still saved.');
    }
    if (interactive) {
      if (breakerBuilder) printBreakerBuilderOutcome(breakerBuilder);
      printPipelineOutcome(pipeline);
    }

    // Resolve + audit-log unconditionally — even for outcome === 'errored'
    // — so a role failure still leaves a complete, honest trail (Golden
    // Rule). The console banner is skipped on 'errored' — a decision based
    // on zero completed roles would be actively misleading right before
    // the real error prints; the audit entry stays complete either way.
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

    // Render + save the report — UNLESS the pipeline errored before any
    // role even completed. With zero role outputs, every section of the
    // report would just read "did not run" — there's no real content to
    // show, so writing one is noise the user has to notice and discard
    // (reported live: a 0/6 early failure still silently wrote a file no
    // one was told about). The audit trail above is still written
    // unconditionally (Golden Rule: never skip the audit log) — that's
    // the durable record of "a run was attempted and failed"; the HTML/
    // JSON/MD report is specifically the reviewer-facing deliverable,
    // which only exists once at least one role actually produced a
    // verdict. Always an absolute path — --output may be given relative
    // to the caller's cwd, and the DoD calls for printing an absolute one.
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
      // Alongside the scan report path, per Phase 9's "New" bullet 3 —
      // only printed when the fix loop actually ran (`fixReportPathValue`
      // is set exactly when `breakerBuilder` is).
      if (fixReportPathValue) printFixReportPath(fixReportPathValue);
    } else {
      console.log('\nNo report generated — the pipeline failed before any role completed. The attempt is still recorded in the audit log.');
    }

    if (pipeline.outcome === 'errored') {
      // Audit trail (and the report, if any role completed) are written —
      // now surface the original error exactly as before
      // (handleReviewCommand.ts still catches CodexrevError/ProviderError
      // and prints a clean message + sets the exit code).
      throw pipeline.error;
    }

    if (fixLoopError) {
      // Same reasoning as the `pipeline.outcome === 'errored'` branch
      // above, for a crash mid-fix-loop instead of mid-scan — the audit
      // trail and both reports are already written (reflecting the
      // pre-fix decision, since the loop never finished), so the
      // original error can now surface exactly as it would have before
      // this was caught.
      throw fixLoopError;
    }

    return { pipeline, resolver: resolverResult, reportPaths: paths, breakerBuilder, fixReportPath: fixReportPathValue };
  } catch (err) {
    unmountApp();
    throw err;
  }
}
