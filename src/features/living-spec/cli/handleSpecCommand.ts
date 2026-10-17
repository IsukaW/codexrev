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
import {
  applyInferenceToResult,
  buildImplicationsLabel,
  runImplicationInference,
  type ImplicationsLabelFile,
} from '../pipeline/inferenceEngine.js';
import {
  createLLMPort,
  DEFAULT_INFERENCE_TIMEOUT_MS,
  isNetworkProvider,
  resolveInferenceTarget,
  type LLMPort,
} from '../pipeline/llmPort.js';
import { formatDiffForPrompt } from '../pipeline/promptBuilder.js';
import type { SpecProposal, SpecProposalStatus } from '../pipeline/types.js';
import { LivingSpecConfigError, LivingSpecError, LivingSpecProposalError } from '../tools/errors.js';
import {
  ensureStateDir,
  listProposalIds,
  listVersions,
  livingSpecDir,
  proposalsDir,
  readConfig,
  readProposal,
  readUrsExcerpt,
  readUrsState,
  saveImplicationsReport,
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
  /** Inference provider override (default: local). */
  provider?: string;
  /** Inference model override. */
  model?: string;
  /** Assert no network provider is used for inference. */
  offline?: boolean;
  /** Per-request inference timeout (ms). */
  timeout?: number;
}

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

    // Semantic back half: infer requirement implications from the diff. Runs
    // only when a model source is available (injected llm, --provider/--model,
    // or config.modelOverride); otherwise the deterministic result stands.
    let result = outcome.result;
    let label: ImplicationsLabelFile | null = null;

    if (shouldRunInference(cfg.modelOverride, flags, deps)) {
      const target = resolveInferenceTarget({
        provider: flags.provider,
        model: flags.model,
        modelOverride: cfg.modelOverride,
      });
      if (flags.offline && isNetworkProvider(target.provider)) {
        throw new LivingSpecConfigError(
          `--offline forbids the network provider "${target.provider}"; ` +
            'use a local provider (ollama, lmstudio, litellm).',
        );
      }
      const timeoutMs = flags.timeout ?? DEFAULT_INFERENCE_TIMEOUT_MS;
      const llm =
        deps?.llm ?? createLLMPort({ provider: target.provider, model: target.model, timeoutMs });
      const ursExcerpt = await readUrsExcerpt(root);
      const inferenceResult = await runImplicationInference(
        { diff: formatDiffForPrompt(outcome.extraction.files), ...(ursExcerpt ? { ursExcerpt } : {}) },
        llm,
        {
          model: target.model,
          provider: target.provider,
          timeoutMs,
          maxTimeoutRetries: 1,
        },
      );

      if (inferenceResult.ok) {
        result = applyInferenceToResult(outcome.result, inferenceResult);
      } else {
        // Failure policy (NFR4/NFR5): leave the prior deterministic result
        // untouched and surface a structured error instead.
        result = { ...outcome.result, inferenceError: inferenceResult.error };
        console.warn(
          `  ⚠ implication inference failed (${inferenceResult.error.code}): ${inferenceResult.error.message}`,
        );
      }
      label = buildImplicationsLabel({
        changeId: outcome.changeId,
        timestamp: outcome.result.timestamp,
        provider: target.provider,
        model: target.model,
        result: inferenceResult,
      });
    }

    const reportFile = flags.dryRun ? null : await saveReport(root, result);
    const labelFile =
      flags.dryRun || !label ? null : await saveImplicationsReport(root, outcome.changeId, label);

    if ((flags.output ?? 'text') === 'json') {
      if (outcome.extraction.truncated) printTruncationWarning(outcome.extraction);
      printAnalysisJson(result);
    } else {
      printAnalysisSummary(outcome, { root, reportFile });
      if (label) {
        console.log(
          `  implications:    ${result.implications.length} (model ${label.model}, ${
            label.ok ? 'ok' : `failed: ${label.error?.code ?? 'error'}`
          })`,
        );
        if (result.behaviourChangeSummary) {
          console.log(`  behaviour:       ${result.behaviourChangeSummary}`);
        }
        if (result.requiresUrsUpdate !== undefined) {
          console.log(`  URS update:      ${result.requiresUrsUpdate ? 'required' : 'not required'}`);
        }
        if (labelFile) console.log(`  labelled output: ${labelFile}`);
      }
    }
  } catch (err) {
    handleExpectedError(err);
  }
}

/** Inference runs when a model source is available (injection or config). */
function shouldRunInference(
  modelOverride: string | undefined,
  flags: SpecCommandFlags,
  deps?: SpecCommandDeps,
): boolean {
  return Boolean(
    deps?.llm ||
      flags.provider !== undefined ||
      flags.model !== undefined ||
      modelOverride !== undefined,
  );
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
