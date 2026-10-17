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
import type { LLMPort } from '../pipeline/llmPort.js';
import { seedUrsDocument } from '../pipeline/ursModel.js';
import { validatePatch } from '../pipeline/ursPatcher.js';
import { acceptPatch, listVersionSnapshots, recordVersion } from '../pipeline/versionStore.js';
import type { SpecProposal, SpecProposalStatus } from '../pipeline/types.js';
import { LivingSpecError, LivingSpecProposalError } from '../tools/errors.js';
import {
  ensureStateDir,
  listProposalIds,
  livingSpecDir,
  proposalsDir,
  readConfig,
  readDriftAlerts,
  readProposal,
  readUrsDocument,
  readUrsState,
  saveProposal,
  ursMarkdownPath,
} from '../tools/stateStore.js';
import {
  printAnalysisJson,
  printAnalysisSummary,
  printOutputSideSummary,
  printTruncationWarning,
} from './specOutput.js';
import { runAnalysisPass } from './analysisPass.js';
import { runWatchSession } from './runWatchSession.js';

export interface SpecCommandFlags {
  diff?: string;
  project?: string;
  output?: 'json' | 'text';
  dryRun?: boolean;
  debounce?: number;
  paths?: string;
  /** Inference provider override (default: local). */
  provider?: string;
  /** Inference model override. */
  model?: string;
  /** Assert no network provider is used for inference. */
  offline?: boolean;
  /** Per-request inference timeout (ms). */
  timeout?: number;
}

const STATUS_ALERT_LIMIT = 5;

/** Injectable collaborators (tests pass a fake `llm` — never a real network call). */
export interface SpecCommandDeps {
  llm?: LLMPort;
}

export async function handleSpecCommand(
  rest: ReadonlyArray<string | number>,
  flags: SpecCommandFlags,
  deps?: SpecCommandDeps,
): Promise<void> {
  const sub = String(rest[0] ?? '');
  switch (sub) {
    case 'analyze':
      return analyzeCommand(flags, deps);
    case 'init-urs':
      return initUrsCommand(flags);
    case 'watch':
      return watchCommand(flags, deps);
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

async function analyzeCommand(flags: SpecCommandFlags, deps?: SpecCommandDeps): Promise<void> {
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

    // Full pipeline back half: implications → drift → proposals → test deltas,
    // drift alerts and the change-impact summary (all persisted with the report).
    const pass = await runAnalysisPass(root, outcome, {
      ...(deps?.llm ? { llm: deps.llm } : {}),
      ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.offline !== undefined ? { offline: flags.offline } : {}),
      ...(flags.timeout !== undefined ? { timeoutMs: flags.timeout } : {}),
      ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
    });
    const result = pass.result;

    if ((flags.output ?? 'text') === 'json') {
      if (outcome.extraction.truncated) printTruncationWarning(outcome.extraction);
      printAnalysisJson(result);
    } else {
      printAnalysisSummary(outcome, { root, reportFile: pass.reportFile });
      if (pass.label) {
        console.log(
          `  implications:    ${result.implications.length} (model ${pass.label.model}, ${
            pass.label.ok ? 'ok' : `failed: ${pass.label.error?.code ?? 'error'}`
          })`,
        );
        if (result.behaviourChangeSummary) {
          console.log(`  behaviour:       ${result.behaviourChangeSummary}`);
        }
        if (result.requiresUrsUpdate !== undefined && result.requiresUrsUpdate !== null) {
          console.log(`  URS update:      ${result.requiresUrsUpdate ? 'required' : 'not required'}`);
        }
        if (pass.labelFile) console.log(`  labelled output: ${pass.labelFile}`);
      }
      console.log(`  drift:           ${result.driftStatus}`);
      if (result.proposalIds && result.proposalIds.length > 0) {
        console.log(`  proposals:       ${result.proposalIds.join(', ')} (pending — accept/reject/defer)`);
      }
      printOutputSideSummary(pass);
    }
  } catch (err) {
    handleExpectedError(err);
  }
}

async function initUrsCommand(flags: SpecCommandFlags): Promise<void> {
  try {
    const root = resolveProject(flags);
    await ensureStateDir(root);
    const existing = await readUrsDocument(root);
    if (existing) {
      console.log(`Living URS already exists at ${ursMarkdownPath(root)} — leaving it untouched.`);
      return;
    }
    const now = new Date().toISOString();
    const doc = seedUrsDocument();
    const { version } = await recordVersion(root, {
      changeId: 'seed',
      action: 'seed',
      timestamp: now,
      doc,
    });
    console.log(`Seeded living URS skeleton at ${ursMarkdownPath(root)} (v${version}).`);
  } catch (err) {
    handleExpectedError(err);
  }
}

async function watchCommand(flags: SpecCommandFlags, deps?: SpecCommandDeps): Promise<void> {
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
      ...(deps?.llm ? { llm: deps.llm } : {}),
      ...(flags.offline !== undefined ? { offline: flags.offline } : {}),
      ...(flags.timeout !== undefined ? { timeoutMs: flags.timeout } : {}),
      output: flags.output ?? 'text',
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
    // Deferred proposals stay visible until resolved (human gate).
    const open: SpecProposal[] = [];
    for (const id of await listProposalIds(root)) {
      const proposal = await readProposal(root, id);
      if (proposal && (proposal.status === 'pending' || proposal.status === 'deferred')) {
        open.push(proposal);
      }
    }
    // Latest drift alerts from the append-only log (bounded list).
    const allAlerts = await readDriftAlerts(root);
    const alerts = allAlerts.slice(-STATUS_ALERT_LIMIT);

    console.log(`Living Specification Engine — status (${root})`);
    console.log(`  state dir:         ${livingSpecDir(root)}`);
    console.log(`  watched paths:     ${cfg.watchedPaths.join(', ')}`);
    console.log(`  debounce:          ${cfg.debounceMs} ms`);
    console.log(`  model override:    ${cfg.modelOverride ?? '(settings default)'}`);
    console.log(
      `  URS version:       ${state ? `v${state.version} (updated ${state.updatedAt})` : 'none yet'}`,
    );
    console.log(
      `  open proposals:    ${open.length > 0 ? '' : '(none)'}`,
    );
    for (const p of open) {
      const drift = p.driftStatus ? ` [${p.driftStatus}]` : '';
      const sections = p.sectionsTouched?.length ? ` → ${p.sectionsTouched.join(', ')}` : '';
      console.log(`    ${p.id}  ${p.status}${drift}  ${p.title}${sections}`);
    }
    console.log(
      `  drift alerts:      ${allAlerts.length > 0 ? `${allAlerts.length} recorded (latest ${alerts.length})` : '(none)'}`,
    );
    for (const alert of alerts) {
      console.log(
        `    ${alert.timestamp}  ${alert.severity.padEnd(8)}  ${alert.file} — ${alert.reason}`,
      );
    }
  } catch (err) {
    handleExpectedError(err);
  }
}

async function historyCommand(flags: SpecCommandFlags): Promise<void> {
  try {
    const root = resolveProject(flags);
    await ensureStateDir(root);
    const snapshots = await listVersionSnapshots(root);
    if (snapshots.length === 0) {
      console.log('No URS versions recorded yet.');
      return;
    }
    console.log('URS versions:');
    for (const v of snapshots) {
      console.log(`  v${v.version}  ${v.action.padEnd(6)}  change ${v.changeId}  ${v.timestamp}`);
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

    if (decision === 'accept') {
      // NFR4/FR13: the patch is applied ONLY on accept. Reject/defer never
      // touch the URS. Accepting a scoped patch bumps the URS version and
      // records an append-only, changeId-traceable snapshot (NFR7).
      if (proposal.patch) {
        // Reject malformed patches outright — a corrupt proposal is never applied.
        const check = validatePatch(proposal.patch);
        if (!check.ok) {
          throw new LivingSpecProposalError(
            `proposal "${id}" has a malformed patch: ${check.errors.join('; ')}`,
          );
        }
        const { version } = await acceptPatch(root, {
          changeId: proposal.changeId,
          timestamp: new Date().toISOString(),
          patch: proposal.patch,
        });
        console.log(`✓ proposal ${id} accepted — URS updated to v${version}`);
      } else {
        console.log(`✓ proposal ${id} accepted (no patch to apply)`);
      }
    } else {
      console.log(`✓ proposal ${id} ${status}`);
    }

    await saveProposal(root, { ...proposal, status });
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
  console.error('  init-urs [--project <path>]');
  console.error('  analyze [--diff <ref>] [--project <path>] [--output json|text] [--dry-run]');
  console.error('  watch   [--debounce <ms>] [--paths <globs>] [--output json|text] [--dry-run]');
  console.error('  status | history');
  console.error('  accept <id> | reject <id> | defer <id>');
}
