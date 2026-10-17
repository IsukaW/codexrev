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
import readline from 'node:readline/promises';
import { runDeterministicAnalysis } from '../pipeline/analysisRunner.js';
import {
  createLLMPort,
  DEFAULT_INFERENCE_TIMEOUT_MS,
  isNetworkProvider,
  resolveInferenceTarget,
  type LLMPort,
} from '../pipeline/llmPort.js';
import { extractJson, generateWithTimeout } from '../pipeline/inferenceEngine.js';
import { renderUrsMarkdown, seedUrsDocument } from '../pipeline/ursModel.js';
import {
  bootstrapOutputToDocument,
  buildBootstrapPrompt,
  collectBootstrapFiles,
  summarizeScan,
} from '../pipeline/ursBootstrapper.js';
import { validateUrsBootstrapOutput } from '../tools/ursBootstrapSchema.js';
import { validatePatch } from '../pipeline/ursPatcher.js';
import { acceptPatch, listVersionSnapshots, recordVersion } from '../pipeline/versionStore.js';
import type { SpecProposal, SpecProposalStatus } from '../pipeline/types.js';
import {
  LivingSpecBootstrapError,
  LivingSpecConfigError,
  LivingSpecError,
  LivingSpecProposalError,
} from '../tools/errors.js';
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
  ursJsonPath,
  ursMarkdownPath,
  ursPdfPath,
  versionPdfPath,
  versionPath,
} from '../tools/stateStore.js';
import {
  printAnalysisJson,
  printOutputSideSummary,
  printAnalysisSummary,
  printTruncationWarning,
} from './specOutput.js';
import {
  renderBootstrapApproved,
  renderBootstrapPreview,
  renderDecisionResult,
  renderDriftLine,
  renderHistoryReport,
  renderImplicationsSection,
  renderSpecUsage,
  renderStatusReport,
} from './reportRenderer.js';
import { renderSpecHelp } from './specHelp.js';
import { runAnalysisPass } from './analysisPass.js';
import { runWatchSession } from './runWatchSession.js';
import { loadEvalScenarios } from '../testing/evalScenario.js';
import {
  EVAL_MODES,
  renderEvalMarkdown,
  runEvaluation,
  saveEvalReport,
  type EvalMode,
} from '../testing/evaluationHarness.js';

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
  /** Suppress progress output (analyze/watch). */
  quiet?: boolean;
  /** `eval`: scenario corpus directory. */
  corpus?: string;
  /** `eval`: comparison mode (batch | single-pass | full | all). */
  mode?: string;
  /** `eval`: run against a live local model instead of the offline default. */
  live?: boolean;
  /** `bootstrap`: skip the interactive approval (required off-TTY). */
  yes?: boolean;
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
    case 'bootstrap':
      return bootstrapCommand(flags, deps);
    case 'eval':
      return evalCommand(flags, deps);
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
    case 'help':
      // full hand-rolled help screen — stdout, exit 0
      renderSpecHelp(rest[1] === undefined ? undefined : String(rest[1]));
      return;
    case '':
      console.error(renderSpecUsage());
      process.exitCode = 2;
      return;
    default:
      console.error(`Unknown spec subcommand: ${sub}`);
      console.error(renderSpecUsage());
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
    // --dry-run is deterministic-only: no model calls, nothing written.
    const pass = await runAnalysisPass(root, outcome, {
      ...(deps?.llm ? { llm: deps.llm } : {}),
      ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.offline !== undefined ? { offline: flags.offline } : {}),
      ...(flags.timeout !== undefined ? { timeoutMs: flags.timeout } : {}),
      ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
      ...(flags.dryRun ? { deterministicOnly: true } : {}),
    });
    const result = pass.result;

    if ((flags.output ?? 'text') === 'json') {
      if (outcome.extraction.truncated) printTruncationWarning(outcome.extraction);
      printAnalysisJson(result);
    } else if (!flags.quiet) {
      printAnalysisSummary(outcome, { root, reportFile: pass.reportFile });
      if (pass.label) {
        console.log(
          `  ${pass.label.ok ? 'model' : 'model failed'}:    ${pass.label.model}${
            pass.label.ok ? '' : ` (${pass.label.error?.code ?? 'error'})`
          }`,
        );
        if (result.behaviourChangeSummary) {
          console.log(`  behaviour:       ${result.behaviourChangeSummary}`);
        }
        if (result.requiresUrsUpdate !== undefined && result.requiresUrsUpdate !== null) {
          console.log(`  URS update:      ${result.requiresUrsUpdate ? 'required' : 'not required'}`);
        }
        if (pass.labelFile) console.log(`  labelled output: ${pass.labelFile}`);
      }
      for (const line of renderImplicationsSection(result.implications)) console.log(line);
      console.log(renderDriftLine(result));
      printOutputSideSummary(pass);
    }
  } catch (err) {
    handleExpectedError(err);
  }
}

/**
 * `codexrev spec bootstrap` — generates the INITIAL living URS (Version 0)
 * from the project's implemented code (controllers/services/handlers first),
 * shows the draft with its source references, and only writes it after an
 * explicit approval: interactive `[y/N]` on a TTY, `--yes` for scripts/CI
 * (required off-TTY, exit 2 otherwise). The approved URS lands in BOTH
 * formats — `urs/urs.json` (+md) and `urs/urs.pdf` — plus the Version 0
 * snapshot `versions/v0.json` + `versions/v0.pdf` (NFR7). `--dry-run`
 * previews without ever asking to save.
 */
async function bootstrapCommand(flags: SpecCommandFlags, deps?: SpecCommandDeps): Promise<void> {
  try {
    const root = resolveProject(flags);
    await ensureStateDir(root);

    if (await readUrsDocument(root)) {
      throw new LivingSpecBootstrapError(
        `a living URS already exists at ${ursJsonPath(root)} — bootstrap only initialises a ` +
          'project without one; evolve the existing URS with `codexrev spec analyze` + accept',
      );
    }

    const cfg = await readConfig(root);
    const files = await collectBootstrapFiles(root, { includePaths: cfg.includePaths });
    if (files.length === 0) {
      throw new LivingSpecBootstrapError(
        `no source files matched the include paths under ${root} — ` +
          'check includePaths in .codexrev/living-spec/config.json',
      );
    }

    // Bootstrap is inherently model-backed (reading business logic requires
    // inference): same target resolution + offline guard as analyze.
    const target = resolveInferenceTarget({
      ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(cfg.modelOverride !== undefined ? { modelOverride: cfg.modelOverride } : {}),
    });
    if (flags.offline && isNetworkProvider(target.provider)) {
      throw new LivingSpecConfigError(
        `--offline forbids the network provider "${target.provider}"; ` +
          'use a local provider (ollama, lmstudio, litellm).',
      );
    }
    const timeoutMs = flags.timeout ?? DEFAULT_INFERENCE_TIMEOUT_MS;
    const llm = deps?.llm ?? createLLMPort({ provider: target.provider, model: target.model, timeoutMs });

    const prompt = buildBootstrapPrompt(files);
    let response: Awaited<ReturnType<typeof generateWithTimeout>>;
    try {
      response = await generateWithTimeout(
        llm,
        {
          model: target.model,
          systemInstruction: prompt.system,
          messages: [{ role: 'user', parts: [{ kind: 'text', text: prompt.user }] }],
          temperature: 0.2,
        },
        timeoutMs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LivingSpecBootstrapError(
        `could not reach the model (${target.provider}/${target.model}): ${message}\n` +
          '  → start ollama / lm studio (e.g. `ollama serve`) and retry — nothing was written',
      );
    }

    let rawPayload: unknown;
    try {
      rawPayload = extractJson(
        response.message.parts
          .filter((p) => p.kind === 'text')
          .map((p) => p.text)
          .join(''),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LivingSpecBootstrapError(
        `the model returned malformed output (NFR5): ${message} — ` +
          'nothing was written; retry or try a different model',
      );
    }

    const validated = validateUrsBootstrapOutput(rawPayload);
    if (!validated.ok) {
      throw new LivingSpecBootstrapError(
        `the model returned an invalid URS payload (NFR5): ${validated.errors.join('; ')} — ` +
          'nothing was written; retry or try a different model',
      );
    }
    const built = bootstrapOutputToDocument(validated.value, {
      files,
      changeId: 'bootstrap',
    });
    const markdown = renderUrsMarkdown(built.doc);
    const scanSummary = summarizeScan(files);
    const jsonMode = (flags.output ?? 'text') === 'json';

    // ── preview (always shown in text mode — including before approval) ──
    const previewLines = renderBootstrapPreview({
      root,
      scanSummary,
      summary: built.summary,
      doc: built.doc,
      droppedSections: built.droppedSections,
      droppedRefs: built.droppedRefs,
    });
    if (!jsonMode) for (const line of previewLines) console.log(line);

    if (flags.dryRun) {
      if (jsonMode) {
        console.log(
          JSON.stringify(
            {
              dryRun: true,
              approved: false,
              scan: scanSummary,
              summary: built.summary,
              document: built.doc,
              markdown,
            },
            null,
            2,
          ),
        );
      } else {
        console.log('');
        console.log(markdown);
        console.log('(dry-run) nothing written — re-run without --dry-run to approve and save');
      }
      return;
    }

    // ── approval gate (NFR4) ─────────────────────────────────────────────
    let approved: boolean;
    if (flags.yes) {
      approved = true;
    } else if (!jsonMode && process.stdin.isTTY === true) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question('Accept this as URS Version 0? [y/N] ');
        approved = /^(y|yes)$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    } else {
      console.error(
        'approval required — nothing written: re-run with --yes to accept the generated URS ' +
          'as Version 0 (interactive approval needs a TTY)',
      );
      process.exitCode = 2;
      return;
    }

    if (!approved) {
      console.log('declined — no URS was written');
      return;
    }

    const { version } = await recordVersion(root, {
      changeId: 'bootstrap',
      action: 'bootstrap',
      timestamp: new Date().toISOString(),
      doc: built.doc,
      markdown,
      version: 0,
    });
    const paths = {
      jsonPath: ursJsonPath(root),
      markdownPath: ursMarkdownPath(root),
      pdfPath: ursPdfPath(root),
      versionJsonPath: versionPath(root, version),
      versionPdfPath: versionPdfPath(root, version),
    };

    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            dryRun: false,
            approved: true,
            version,
            scan: scanSummary,
            summary: built.summary,
            paths,
            document: built.doc,
          },
          null,
          2,
        ),
      );
    } else {
      for (const line of renderBootstrapApproved({ root, version, ...paths })) {
        console.log(line);
      }
    }
  } catch (err) {
    handleExpectedError(err);
  }
}

/**
 * `codexrev spec eval` — the controlled-evaluation entry point (research
 * methodology). Replays the labelled scenario corpus through the comparison
 * modes and writes `reports/eval-<timestamp>.json` + a Markdown summary.
 * Evaluation-only: the baseline modes live in the harness, not in the CLI
 * surface — the command itself has exactly one job.
 */
async function evalCommand(flags: SpecCommandFlags, deps?: SpecCommandDeps): Promise<void> {
  try {
    const root = resolveProject(flags);
    await ensureStateDir(root);

    const rawMode = flags.mode ?? 'all';
    let modes: readonly EvalMode[];
    // research naming (docs/cli/commands.md): A = manual/batch, B = single-pass
    // without prior-URS comparison, C = full pipeline; `live` runs the whole
    // corpus against a real local model instead of the offline label echo.
    let wantLive = flags.live === true;
    switch (rawMode) {
      case 'all':
        modes = EVAL_MODES;
        break;
      case 'A':
      case 'batch':
        modes = ['batch'];
        break;
      case 'B':
      case 'single-pass':
        modes = ['single-pass'];
        break;
      case 'C':
      case 'full':
        modes = ['full'];
        break;
      case 'live':
        modes = EVAL_MODES;
        wantLive = true;
        break;
      default:
        // bad flag value = bad usage (exit 2), not a runtime error
        console.error(
          `invalid --mode "${rawMode}" — expected one of: A, B, C, ${EVAL_MODES.join(', ')}, live (or all)`,
        );
        process.exitCode = 2;
        return;
    }

    const corpusDir = flags.corpus
      ? path.resolve(flags.corpus)
      : path.join(root, 'tests', 'features', 'living-spec', 'fixtures', 'scenarios');
    const scenarios = await loadEvalScenarios(corpusDir);

    // Offline default: the deterministic label-echo provider (no network).
    // `--mode live` / --live (or an injected llm) swaps in a real local model
    // for the two model-backed modes; batch stays deterministic by definition.
    let live: { llm: LLMPort; model: string } | undefined;
    if (wantLive || deps?.llm) {
      const target = resolveInferenceTarget({
        ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
        ...(flags.model !== undefined ? { model: flags.model } : {}),
      });
      if (flags.offline && deps?.llm === undefined && isNetworkProvider(target.provider)) {
        throw new LivingSpecConfigError(
          `--offline forbids the network provider "${target.provider}"; ` +
            'use a local provider (ollama, lmstudio, litellm).',
        );
      }
      const timeoutMs = flags.timeout ?? DEFAULT_INFERENCE_TIMEOUT_MS;
      const llm =
        deps?.llm ??
        createLLMPort({ provider: target.provider, model: target.model, timeoutMs });
      live = { llm, model: flags.model ?? deps?.llm?.model ?? target.model };
    }

    const report = await runEvaluation({
      scenarios,
      corpusDir,
      modes,
      ...(live ? { live } : {}),
      ...(flags.timeout !== undefined ? { timeoutMs: flags.timeout } : {}),
    });
    const saved = await saveEvalReport(root, report);

    if ((flags.output ?? 'text') === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (!flags.quiet) console.log(renderEvalMarkdown(report));
      console.log(`\n  report written: ${saved.jsonPath}`);
      console.log(`  summary:        ${saved.mdPath}`);
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
      ...(flags.quiet !== undefined ? { quiet: flags.quiet } : {}),
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

    if ((flags.output ?? 'text') === 'json') {
      console.log(
        JSON.stringify(
          {
            projectRoot: root,
            stateDir: livingSpecDir(root),
            watchedPaths: cfg.watchedPaths,
            debounceMs: cfg.debounceMs,
            modelOverride: cfg.modelOverride ?? null,
            ursVersion: state?.version ?? null,
            ursUpdatedAt: state?.updatedAt ?? null,
            openProposals: open,
            driftAlerts: allAlerts.slice(-STATUS_ALERT_LIMIT),
            driftAlertsTotal: allAlerts.length,
          },
          null,
          2,
        ),
      );
      return;
    }

    for (const line of renderStatusReport({
      root,
      stateDir: livingSpecDir(root),
      watchedPaths: cfg.watchedPaths,
      debounceMs: cfg.debounceMs,
      modelOverride: cfg.modelOverride ?? null,
      ursVersion: state ? `v${state.version} (updated ${state.updatedAt})` : 'none yet',
      openProposals: open,
      alerts: allAlerts,
      alertsTotal: allAlerts.length,
      alertLimit: STATUS_ALERT_LIMIT,
    })) {
      console.log(line);
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
    if ((flags.output ?? 'text') === 'json') {
      console.log(JSON.stringify(snapshots, null, 2));
      return;
    }
    for (const line of renderHistoryReport(snapshots)) console.log(line);
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
        await saveProposal(root, { ...proposal, status });
        emitDecision(decision, { ...proposal, status }, flags, version);
        return;
      }
      await saveProposal(root, { ...proposal, status });
      emitDecision(decision, { ...proposal, status }, flags);
      return;
    }

    await saveProposal(root, { ...proposal, status });
    emitDecision(decision, { ...proposal, status }, flags);
  } catch (err) {
    handleExpectedError(err);
  }
}

/** Prints (or JSON-prints) one resolved decision. */
function emitDecision(
  decision: 'accept' | 'reject' | 'defer',
  proposal: SpecProposal,
  flags: SpecCommandFlags,
  version?: number,
): void {
  if ((flags.output ?? 'text') === 'json') {
    console.log(
      JSON.stringify(
        {
          decision,
          proposalId: proposal.id,
          status: proposal.status,
          ...(version !== undefined ? { ursVersion: version } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const line of renderDecisionResult({
    decision,
    proposal,
    ...(version !== undefined ? { version } : {}),
  })) {
    console.log(line);
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
