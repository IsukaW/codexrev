/**
 * `spec` command dispatch. `analyze` / `watch` are Feature 1 scaffolds —
 * they acknowledge their flags and exit 0. `status`, `history` and
 * `accept` / `reject` / `defer` already work against the state store, so
 * the state layout can be exercised end-to-end before the analyzer lands.
 */

import path from 'node:path';
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
} from '../tools/stateStore.js';

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
  console.log('[codexrev spec] analyze is not implemented yet (Feature 1 scaffold).');
  console.log(
    `[codexrev spec] planned input: project=${resolveProject(flags)} diff=${flags.diff ?? 'staged'} output=${flags.output ?? 'text'}${flags.dryRun ? ' dry-run' : ''}`,
  );
  return Promise.resolve();
}

async function watchCommand(flags: SpecCommandFlags): Promise<void> {
  console.log('[codexrev spec] watch is not implemented yet (Feature 1 scaffold).');
  console.log(
    `[codexrev spec] planned input: project=${resolveProject(flags)} debounce=${flags.debounce ?? 800}ms paths=${flags.paths ?? '(config.json)'}${flags.dryRun ? ' dry-run' : ''}`,
  );
  return Promise.resolve();
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
