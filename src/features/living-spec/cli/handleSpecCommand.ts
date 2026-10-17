/**
 * `spec` command dispatch. `analyze` is the deterministic front half of the
 * pipeline end-to-end (diff extraction + buffering → report JSON), `watch`
 * is the foreground session over the same path. `status`, `history` and
 * `accept` / `reject` / `defer` work against the state store.
 *
 * Analysis is triggered ONLY by these explicit commands — there is no
 * auto file-save daemon, service or git hook.
 */

import path from 'node:path';
import { runDeterministicAnalysis } from '../pipeline/analysisRunner.js';
import type { SpecProposal, SpecProposalStatus } from '../pipeline/types.js';
import { LivingSpecError, LivingSpecProposalError } from '../tools/errors.js';
import {
  ensureStateDir,
  listProposalIds,
  listVersions,
  livingSpecDir,
  proposalsDir,
  readConfig,
  readProposal,
  readUrsState,
  saveProposal,
  saveReport,
} from '../tools/stateStore.js';
import {
  printAnalysisJson,
  printAnalysisSummary,
  printTruncationWarning,
} from './specOutput.js';
import { runWatchSession } from './runWatchSession.js';

export interface SpecCommandFlags {
  diff?: string;
  project?: string;
  output?: 'json' | 'text';
  dryRun?: boolean;
  debounce?: number;
  paths?: string;
}

export async function handleSpecCommand(
  rest: ReadonlyArray<string | number>,
  flags: SpecCommandFlags,
): Promise<void> {
  const sub = String(rest[0] ?? '');
  switch (sub) {
    case 'analyze':
      return analyzeCommand(flags);
    case 'watch':
      return watchCommand(flags);
    case 'status':
      return statusCommand(flags);
    case 'history':
      return historyCommand(flags);
    case 'accept':
    case 'reject':
    case 'defer':
      return decideCommand(sub, rest[1], flags);
    case '':
      printSpecUsage();
      process.exitCode = 2;
      return;
    default:
      console.error(`Unknown spec subcommand: ${sub}`);
      printSpecUsage();
      process.exitCode = 2;
  }
}

function resolveProject(flags: SpecCommandFlags): string {
  return path.resolve(flags.project ?? process.cwd());
}

async function analyzeCommand(flags: SpecCommandFlags): Promise<void> {
  try {
    const root = resolveProject(flags);
    await ensureStateDir(root);
    const cfg = await readConfig(root);
    // yargs defaults --diff to the sentinel 'staged'; extraction reads the
    // index (git diff --cached) when no ref is requested.
    const ref = flags.diff && flags.diff !== 'staged' ? flags.diff : undefined;

    const outcome = await runDeterministicAnalysis(root, {
      ref,
      includePaths: cfg.includePaths,
      contextLines: cfg.contextLines,
      maxBytes: cfg.maxBytes,
    });

    const reportFile = flags.dryRun ? null : await saveReport(root, outcome.result);
    if ((flags.output ?? 'text') === 'json') {
      if (outcome.extraction.truncated) printTruncationWarning(outcome.extraction);
      printAnalysisJson(outcome.result);
    } else {
      printAnalysisSummary(outcome, { root, reportFile });
    }
  } catch (err) {
    handleExpectedError(err);
  }
}

async function watchCommand(flags: SpecCommandFlags): Promise<void> {
  try {
    const root = resolveProject(flags);
    await ensureStateDir(root);
    const watchedPaths = flags.paths
      ? flags.paths
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined;
    await runWatchSession({
      projectRoot: root,
      debounceMs: flags.debounce,
      watchedPaths,
      dryRun: flags.dryRun,
    });
  } catch (err) {
    handleExpectedError(err);
  }
}

async function statusCommand(flags: SpecCommandFlags): Promise<void> {
  try {
    const root = resolveProject(flags);
    await ensureStateDir(root);
    const cfg = await readConfig(root);
    const state = await readUrsState(root);
    const pending: SpecProposal[] = [];
    for (const id of await listProposalIds(root)) {
      const proposal = await readProposal(root, id);
      if (proposal && proposal.status === 'pending') pending.push(proposal);
    }
    const alerts = state?.lastDriftAlerts ?? [];

    console.log(`Living Specification Engine — status (${root})`);
    console.log(`  state dir:         ${livingSpecDir(root)}`);
    console.log(`  watched paths:     ${cfg.watchedPaths.join(', ')}`);
    console.log(`  debounce:          ${cfg.debounceMs} ms`);
    console.log(`  model override:    ${cfg.modelOverride ?? '(settings default)'}`);
    console.log(
      `  URS version:       ${state ? `v${state.version} (updated ${state.updatedAt})` : 'none yet'}`,
    );
    console.log(
      `  pending proposals: ${pending.length > 0 ? pending.map((p) => p.id).join(', ') : '(none)'}`,
    );
    console.log(`  drift alerts:      ${alerts.length > 0 ? `${alerts.length} (latest last)` : '(none)'}`);
    for (const alert of alerts.slice(-3)) {
      console.log(`    ${alert.at}  ${alert.status}  ${alert.changeId}${alert.message ? ` — ${alert.message}` : ''}`);
    }
  } catch (err) {
    handleExpectedError(err);
  }
}

async function historyCommand(flags: SpecCommandFlags): Promise<void> {
  try {
    const root = resolveProject(flags);
    await ensureStateDir(root);
    const versions = await listVersions(root);
    if (versions.length === 0) {
      console.log('No URS versions recorded yet.');
      return;
    }
    console.log('URS versions:');
    for (const v of versions) {
      console.log(`  v${v.version}  change ${v.changeId}  ${v.createdAt}`);
    }
  } catch (err) {
    handleExpectedError(err);
  }
}

async function decideCommand(
  decision: 'accept' | 'reject' | 'defer',
  rawId: string | number | undefined,
  flags: SpecCommandFlags,
): Promise<void> {
  try {
    const id = String(rawId ?? '');
    if (!id) {
      console.error(`usage: codexrev spec ${decision} <id>`);
      process.exitCode = 2;
      return;
    }
    const root = resolveProject(flags);
    await ensureStateDir(root);
    const proposal = await readProposal(root, id);
    if (!proposal) {
      throw new LivingSpecProposalError(`proposal "${id}" not found under ${proposalsDir(root)}`);
    }
    if (proposal.status !== 'pending') {
      throw new LivingSpecProposalError(`proposal "${id}" is already ${proposal.status}`);
    }
    const status: SpecProposalStatus =
      decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'deferred';
    await saveProposal(root, { ...proposal, status });
    console.log(`✓ proposal ${id} ${status}`);
  } catch (err) {
    handleExpectedError(err);
  }
}

function handleExpectedError(err: unknown): void {
  // expected user-facing failures (bad config, unknown proposal), not bugs
  if (err instanceof LivingSpecError) {
    console.error(`[codexrev spec] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  throw err;
}

function printSpecUsage(): void {
  console.error('usage: codexrev spec <subcommand> [flags]');
  console.error('  analyze [--diff <ref>] [--project <path>] [--output json|text] [--dry-run]');
  console.error('  watch   [--debounce <ms>] [--paths <globs>] [--dry-run]');
  console.error('  status | history');
  console.error('  accept <id> | reject <id> | defer <id>');
}
