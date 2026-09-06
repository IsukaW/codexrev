/**
 * Codexrev — Feature 2 (review-pipeline) Breaker-Builder loop.
 *
 * Runs after the six-role scan when `--fix` is set and the Resolver's
 * decision is Block or Request Changes (wired in `runReviewSession.ts`).
 * Each iteration:
 *   1. Collects "blocking findings" — findings belonging to a role
 *      whose OWN verdict is `'block'` (not `'flag'` — an advisory
 *      finding shouldn't trigger an automatic edit).
 *   2. For each, tries `deterministicFixer.ts` first, falls back to
 *      `editGenerator.ts` (LLM) — per Section 2's exact order.
 *   3. Applies accepted fixes via the shared `edit` tool
 *      (`src/tools/builtin.ts`) — never writes files directly, and never
 *      `git add`s them either (see below).
 *
 *      Deterministic fixes (narrow, compiler-verified, mechanical) apply
 *      immediately, ungated, same as before. LLM-generated edits are
 *      gated — but as ONE batched decision per iteration, not one gate
 *      per finding: every LLM fix for the iteration is generated first
 *      (streamed to the UI via `onFixCandidate` as each is computed, so
 *      the user watches them arrive), then shown together and confirmed
 *      with a single Apply-all/Skip-all/Abort choice. Gating each edit
 *      individually — the original Phase 8 design — turned an iteration
 *      with several findings into that many interruptions for what's
 *      really one decision ("do these look right"), and the awkward
 *      role-oriented wording those per-fix gates borrowed made it worse
 *      (see the Decision Log). Batching does not weaken the gate itself:
 *      declining still leaves every one of those findings unresolved,
 *      same as declining used to.
 *   4. Re-reads the diff so the roles re-run against what actually
 *      changed. Deliberately diffs the WORKING TREE against HEAD
 *      (`git diff HEAD`), not the index against HEAD (`git diff
 *      --cached`, the default scan mode) — the `edit` tool only touches
 *      the working tree, and re-staging the AI's own edits into the same
 *      index as whatever the user staged would make the two
 *      indistinguishable. `git diff HEAD` shows the combined picture
 *      (user's original change + the AI's fix) to the roles that need
 *      it, while the AI's edits stay visibly *unstaged* — `git status`
 *      still tells the user exactly what the AI changed versus what they
 *      staged themselves. When the original scan used an explicit
 *      `--diff <ref>` rather than the staged default, that same `ref` is
 *      reused here instead — it's already a working-tree comparison, so
 *      it already picks up the AI's edits with no special-casing needed.
 *      In a repo with no commits yet (`HEAD` doesn't resolve to anything
 *      — e.g. everything was `git add`ed but never committed), `git diff
 *      HEAD` fails outright, unlike `--cached`, which git special-cases
 *      to work against an empty tree; `resolveWorkingTreeDiffRef()` below
 *      detects that and substitutes git's well-known empty-tree hash so
 *      the fix loop still works on a brand-new repo.
 *   5. Re-runs ONLY the roles that were blocking (not the full six).
 *
 * "Phantom-finding filtering" (Section 2: a finding that no longer
 * reproduces after a fix shouldn't be re-flagged) falls out naturally
 * from step 5 — a re-run role produces a fresh, independent verdict
 * from the current code, not a diff against its own prior findings, so
 * a fixed issue simply doesn't reappear. No separate identity-tracking
 * logic is needed, which also avoids the much harder problem of
 * matching "the same" finding across two independently-generated LLM
 * outputs.
 *
 * Hard limits (Golden Rule — never exceed): `maxIterations` (passed in,
 * already capped at `MAX_FIX_ITERATIONS_CEILING` by
 * `validateReviewPipelineSettings()` in Phase 3) and
 * `MAX_RETRIES_PER_FILE` (3, per Section 2 — not user-configurable,
 * same as the guide frames both numbers as fixed invariants).
 */

import { simpleGit } from 'simple-git';
import { ROLE_LABELS, ROLE_ORDER, type Finding, type RoleId, type RoleOutput } from '../roles/roleContract.js';
import { ROLE_RUNNERS } from './orchestrator.js';
import { readDiff } from './diffReader.js';
import { tryDeterministicFix } from '../tools/deterministicFixer.js';
import { generateEdit } from './editGenerator.js';
import { builtinTools } from '../../../tools/builtin.js';
import type { ContextAggregator } from './contextAggregator.js';
import type { ILLMProvider } from './illmProvider.js';
import type { RoleRunContext } from './roleRunContext.js';
import type { InteractionChannel } from '../../../core/interaction.js';

/** Per-file retry cap — a hard limit, not configurable (Section 2 / Golden Rule). */
export const MAX_RETRIES_PER_FILE = 3;

export type FixerStage = 'deterministic' | 'llm';

export interface FixAttemptRecord {
  readonly iteration: number;
  readonly role: RoleId;
  readonly findingId: string;
  readonly file: string;
  readonly fixerStage: FixerStage;
  readonly description: string;
  readonly oldString: string;
  readonly newString: string;
}

export type BreakerBuilderOutcome = 'resolved' | 'escalated' | 'skipped' | 'aborted';

export interface BreakerBuilderResult {
  readonly outcome: BreakerBuilderOutcome;
  readonly iterations: number;
  readonly fixAttempts: readonly FixAttemptRecord[];
  /** Findings still attached to a blocking role's verdict when the loop stopped. */
  readonly unresolvedFindings: readonly Finding[];
}

export interface RunBreakerBuilderLoopOptions {
  /** Same aggregator the initial scan used — re-run roles replace their entry in place (Phase 4's `replaceRoleOutput`). */
  readonly aggregator: ContextAggregator;
  readonly llm: ILLMProvider;
  readonly model: string;
  readonly cwd: string;
  readonly diffRef?: string;
  readonly urs?: string;
  /** Already clamped to `MAX_FIX_ITERATIONS_CEILING` by the caller (settings validation, Phase 3). */
  readonly maxIterations: number;
  /**
   * When provided, pauses for a single Apply-all/Details/Skip-all/Abort
   * gate before applying an iteration's LLM-generated edits as a batch
   * (not deterministic ones — those are narrow, compiler-verified,
   * mechanical fixes; see the Decision Log for why only LLM edits are
   * gated, and for why the gate covers the whole batch rather than one
   * edit at a time). Omit for non-interactive mode.
   */
  readonly interaction?: InteractionChannel;
  readonly onIterationStart?: (iteration: number, blockingFindingsCount: number) => void;
  /**
   * Called the moment a fixer (deterministic or LLM) produces a
   * candidate fix, BEFORE it's queued/applied — lets the UI stream each
   * one in as it's generated, ahead of the batch gate. Same pattern as
   * `orchestrator.ts`'s `onRoleComplete`-before-gate.
   */
  readonly onFixCandidate?: (candidate: FixCandidate) => void;
  /**
   * Called once per iteration, right before the batch gate, with every
   * LLM-generated candidate awaiting that one Apply-all decision — this
   * is the full list the CLI renders together in the "Details" panel,
   * without re-deriving it from the `onFixCandidate` stream.
   */
  readonly onFixBatchReady?: (candidates: readonly FixCandidate[], iteration: number) => void;
  /**
   * Called right after a fix is applied. Awaited (`void | Promise<void>`,
   * same contract as `orchestrator.ts`'s `onRoleComplete`) because the
   * caller uses this to append the fix's audit entry (Phase 9) —
   * awaiting keeps those appends strictly sequential, matching
   * `appendAuditEntry`'s own single-writer assumption (unawaited
   * concurrent appends could race on its read-modify-write cycle).
   */
  readonly onFixAttempt?: (record: FixAttemptRecord) => void | Promise<void>;
  readonly onRoleRerun?: (output: RoleOutput) => void;
}

export interface FixCandidate {
  readonly role: RoleId;
  readonly finding: Finding;
  readonly fixerStage: FixerStage;
  readonly oldString: string;
  readonly newString: string;
  readonly description: string;
}

interface BlockingFinding {
  readonly role: RoleId;
  readonly finding: Finding;
}

/** Git's well-known empty-tree object hash — valid in any repo, no commits required. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The ref to diff the working tree against when refreshing the diff
 * mid-loop. Reuses `diffRef` as-is when the scan was already ref-based.
 * Otherwise this needs a stand-in for the (undefined) 'staged' default
 * that still means "working tree vs HEAD" — but `HEAD` itself doesn't
 * resolve in a repo with no commits yet, so this checks for that and
 * substitutes the empty-tree hash instead.
 */
async function resolveWorkingTreeDiffRef(cwd: string, diffRef: string | undefined): Promise<string> {
  if (diffRef) return diffRef;
  const git = simpleGit({ baseDir: cwd });
  const hasHead = await git
    .revparse(['--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false);
  return hasHead ? 'HEAD' : EMPTY_TREE_SHA;
}

function collectBlockingRoles(aggregator: ContextAggregator): RoleId[] {
  return ROLE_ORDER.filter((role) => aggregator.getRoleOutput(role)?.verdict === 'block');
}

function collectBlockingFindings(aggregator: ContextAggregator, blockingRoles: readonly RoleId[]): BlockingFinding[] {
  const out: BlockingFinding[] = [];
  for (const role of blockingRoles) {
    const output = aggregator.getRoleOutput(role);
    if (!output) continue;
    for (const finding of output.findings) {
      out.push({ role, finding });
    }
  }
  return out;
}

/** Same file, overlapping line range — i.e. two findings citing the same underlying code. */
function locationsOverlap(a: Finding, b: Finding): boolean {
  return a.file === b.file && a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
}

/**
 * Collapses blocking findings down to one representative per unique
 * (file, overlapping-line-range) location, first-seen order (`blocking`
 * is already in `ROLE_ORDER`, so BA's wording wins over Dev's, Dev's
 * over QA's, etc. — an arbitrary but deterministic tie-break).
 *
 * Multiple roles independently flagging the exact same bug — the
 * reported case: BA, Dev, QA, and PM all separately citing the same
 * swapped Fibonacci initializers — otherwise each triggered their own,
 * separately LLM-generated fix attempt for the identical lines: wasted
 * model calls (and real wall-clock time), and a batch gate cluttered
 * with 4-5 near-duplicate proposals for what's really one edit. Once
 * the one representative's fix is applied, every other role's matching
 * finding disappears on its own at the next re-run (the underlying code
 * is simply gone), so this needs no separate "already covered" tracking
 * beyond the location check itself.
 */
function dedupeByLocation(findings: readonly BlockingFinding[]): BlockingFinding[] {
  const out: BlockingFinding[] = [];
  for (const candidate of findings) {
    if (out.some((kept) => locationsOverlap(kept.finding, candidate.finding))) continue;
    out.push(candidate);
  }
  return out;
}

async function applyFix(fix: { file: string; oldString: string; newString: string }, cwd: string): Promise<boolean> {
  const editTool = builtinTools().find((t) => t.name === 'edit');
  if (!editTool) return false;
  try {
    const result = await editTool.execute({ file_path: fix.file, old_string: fix.oldString, new_string: fix.newString }, { cwd });
    return !result.isError;
  } catch {
    // The `edit` tool throws (ToolError) when old_string isn't found — a
    // race between reading the file and applying the fix, or a fix
    // computed against now-stale content. Treat as "couldn't apply".
    return false;
  }
}

/**
 * Loops the batch fix-confirm gate for one iteration's whole set of
 * LLM-generated edits until a non-'details' decision comes back. Stage
 * is namespaced `fix-batch:<iteration>` — distinct from the old
 * per-finding `fix:<findingId>` namespace — so the CLI can tell a batch
 * gate apart from a role gate (and, before this redesign, from a
 * per-finding fix gate) purely from `request.stage`.
 */
async function gateForFixBatch(
  channel: InteractionChannel,
  iteration: number,
  candidates: readonly FixCandidate[],
): Promise<'continue' | 'skip' | 'abort'> {
  const stage = `fix-batch:${iteration}`;
  const count = candidates.length;
  const stageLabel = `${count} proposed fix${count === 1 ? '' : 'es'} ready for review`;
  const summary =
    count === 1
      ? `1 fix to ${candidates[0]!.finding.file}:${candidates[0]!.finding.lineStart} — see details below.`
      : `${count} fixes across ${new Set(candidates.map((c) => c.finding.file)).size} file(s) — see details below.`;
  for (;;) {
    const decision = await channel.requestStageGate(stage, stageLabel, 'llm', summary);
    if (decision !== 'details') return decision;
    // 'details' loops back — the CLI-side subscriber has already shown
    // the full old/new string diff for every candidate before
    // responding, same pattern as the role gate in orchestrator.ts.
  }
}

export async function runBreakerBuilderLoop(opts: RunBreakerBuilderLoopOptions): Promise<BreakerBuilderResult> {
  const fileRetryCounts = new Map<string, number>();
  const fixAttempts: FixAttemptRecord[] = [];

  for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
    const blockingRoles = collectBlockingRoles(opts.aggregator);
    const blocking = collectBlockingFindings(opts.aggregator, blockingRoles);

    if (blocking.length === 0) {
      return { outcome: 'resolved', iterations: iteration - 1, fixAttempts, unresolvedFindings: [] };
    }

    // One fix attempt per unique code LOCATION, not per finding — see
    // `dedupeByLocation`'s docstring. `blocking` (the full, un-deduped
    // list) is still what's reported on escalate/abort below, since
    // every one of those findings genuinely needs to clear on a re-run,
    // dedup or not.
    const toFix = dedupeByLocation(blocking);
    opts.onIterationStart?.(iteration, toFix.length);

    let appliedAny = false;
    const pendingLlmFixes: FixCandidate[] = [];

    // Phase 1 — generate every candidate fix for this iteration.
    // Deterministic fixes apply immediately (ungated, as always). LLM
    // fixes are queued instead of applied here — they're all gated
    // together, once, after this loop (see this file's docstring).
    for (const { role, finding } of toFix) {
      const retries = fileRetryCounts.get(finding.file) ?? 0;
      if (retries >= MAX_RETRIES_PER_FILE) continue;

      let fix = await tryDeterministicFix(finding, opts.cwd);
      let stage: FixerStage = 'deterministic';
      if (!fix) {
        fix = await generateEdit(finding, { llm: opts.llm, model: opts.model, cwd: opts.cwd });
        stage = 'llm';
      }
      if (!fix) continue; // neither fixer could produce a confident fix this round

      const candidate: FixCandidate = {
        role,
        finding,
        fixerStage: stage,
        oldString: fix.oldString,
        newString: fix.newString,
        description: fix.description,
      };
      opts.onFixCandidate?.(candidate);

      if (stage === 'llm') {
        pendingLlmFixes.push(candidate);
        continue;
      }

      const applied = await applyFix(fix, opts.cwd);
      if (!applied) continue;

      fileRetryCounts.set(finding.file, retries + 1);
      appliedAny = true;
      const record: FixAttemptRecord = {
        iteration,
        role,
        findingId: finding.id,
        file: finding.file,
        fixerStage: stage,
        description: fix.description,
        oldString: fix.oldString,
        newString: fix.newString,
      };
      fixAttempts.push(record);
      await opts.onFixAttempt?.(record);
    }

    // Phase 2 — one batch decision covering every queued LLM fix.
    if (pendingLlmFixes.length > 0) {
      let decision: 'continue' | 'skip' | 'abort' = 'continue';
      if (opts.interaction) {
        opts.onFixBatchReady?.(pendingLlmFixes, iteration);
        decision = await gateForFixBatch(opts.interaction, iteration, pendingLlmFixes);
      }

      if (decision === 'abort') {
        return { outcome: 'aborted', iterations: iteration, fixAttempts, unresolvedFindings: blocking.map((b) => b.finding) };
      }

      if (decision === 'continue') {
        for (const candidate of pendingLlmFixes) {
          const retries = fileRetryCounts.get(candidate.finding.file) ?? 0;
          if (retries >= MAX_RETRIES_PER_FILE) continue;

          const applied = await applyFix(
            { file: candidate.finding.file, oldString: candidate.oldString, newString: candidate.newString },
            opts.cwd,
          );
          if (!applied) continue;

          fileRetryCounts.set(candidate.finding.file, retries + 1);
          appliedAny = true;
          const record: FixAttemptRecord = {
            iteration,
            role: candidate.role,
            findingId: candidate.finding.id,
            file: candidate.finding.file,
            fixerStage: candidate.fixerStage,
            description: candidate.description,
            oldString: candidate.oldString,
            newString: candidate.newString,
          };
          fixAttempts.push(record);
          opts.onFixAttempt?.(record);
        }
      }
      // decision === 'skip' — none of the queued LLM fixes are applied;
      // every finding they would have addressed stays unresolved, same
      // as declining a single fix used to.
    }

    if (!appliedAny) {
      // Nothing could be fixed this round (every finding either hit its
      // file's retry cap, or both fixers declined) — looping further
      // would just repeat the same outcome. Escalate now instead of
      // burning the remaining iteration budget.
      return { outcome: 'escalated', iterations: iteration, fixAttempts, unresolvedFindings: blocking.map((b) => b.finding) };
    }

    // Diff the working tree against HEAD (or the empty tree, on a repo
    // with no commits yet), not the index against HEAD — see this file's
    // docstring and `resolveWorkingTreeDiffRef()` for why. Either way,
    // the AI's edits are visible to the re-run roles WITHOUT ever
    // touching the git index.
    const refreshedDiff = await readDiff(opts.cwd, await resolveWorkingTreeDiffRef(opts.cwd, opts.diffRef));

    for (const role of blockingRoles) {
      const ctx: RoleRunContext = {
        llm: opts.llm,
        model: opts.model,
        diff: refreshedDiff,
        urs: opts.urs,
        aggregator: opts.aggregator,
        cwd: opts.cwd,
      };
      const output = await ROLE_RUNNERS[role](ctx);
      opts.aggregator.replaceRoleOutput(output);
      opts.onRoleRerun?.(output);
    }
  }

  // Iteration budget exhausted — check once more whether it actually converged
  // on the very last re-run before declaring escalation.
  const stillBlocking = collectBlockingFindings(opts.aggregator, collectBlockingRoles(opts.aggregator));
  if (stillBlocking.length === 0) {
    return { outcome: 'resolved', iterations: opts.maxIterations, fixAttempts, unresolvedFindings: [] };
  }
  return {
    outcome: 'escalated',
    iterations: opts.maxIterations,
    fixAttempts,
    unresolvedFindings: stillBlocking.map((b) => b.finding),
  };
}

/** For UI/report code that wants a role's plain-English label alongside a fix attempt. */
export function fixAttemptRoleLabel(record: FixAttemptRecord): string {
  return ROLE_LABELS[record.role];
}
