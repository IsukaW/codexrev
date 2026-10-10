// Breaker-Builder loop. Runs after the six-role scan when --fix is set and the
// resolver came back Block or Request Changes.
//
// Per iteration: grab findings from roles that actually verdicted 'block' (not
// 'flag' — advisory stuff shouldn't trigger an auto-edit), try the deterministic
// fixer first and fall back to the LLM editGenerator, then apply through the
// shared `edit` tool (never write files directly, never git add).
//
// Deterministic fixes are narrow/compiler-verified so they just apply, no gate.
// LLM edits get gated, but as one batched Apply-all/Skip-all/Abort per iteration
// instead of per finding — used to gate each edit individually and that turned
// a 5-finding iteration into 5 interruptions for what's really one call ("do
// these look right"). Declining the batch still leaves every finding in it
// unresolved, same as before.
//
// Re-diffing mid-loop: we diff the working tree against HEAD, not the index
// against HEAD like the initial scan does. The edit tool only touches the
// working tree, and if we staged the AI's own edits into the same index the
// user staged, `git status` couldn't tell the two apart anymore. Diffing HEAD
// shows roles the combined picture (user's change + AI's fix) while keeping
// the AI's edits visibly unstaged. If the scan used an explicit --diff ref,
// we just reuse that ref instead. On a repo with no commits yet, HEAD doesn't
// resolve at all (unlike --cached, which git special-cases against an empty
// tree), so resolveWorkingTreeDiffRef() below falls back to git's well-known
// empty-tree hash.
//
// Only the roles that were blocking get re-run, not all six. That's also
// what makes phantom-finding filtering free: a re-run role judges the current
// code fresh, it's not diffing against its own old findings, so a fix that
// actually worked just doesn't get re-flagged. No id-matching needed across
// two independently generated LLM outputs, which would've been a mess anyway.
//
// Hard limits, not configurable: maxIterations (already capped upstream by
// validateReviewPipelineSettings) and MAX_RETRIES_PER_FILE (3).

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

// per-file retry cap, hard limit, not configurable
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
  readonly unresolvedFindings: readonly Finding[]; // still attached to a blocking verdict when the loop stopped
}

export interface RunBreakerBuilderLoopOptions {
  readonly aggregator: ContextAggregator; // same one the initial scan used; re-run roles replace their entry in place
  readonly llm: ILLMProvider;
  readonly model: string;
  readonly cwd: string;
  readonly diffRef?: string;
  readonly urs?: string;
  readonly maxIterations: number; // already clamped by settings validation upstream
  // when set, pauses for one Apply-all/Details/Skip-all/Abort gate per iteration's
  // batch of LLM edits (deterministic fixes never gate). omit for non-interactive mode.
  readonly interaction?: InteractionChannel;
  readonly onIterationStart?: (iteration: number, blockingFindingsCount: number) => void;
  // fires the moment a fixer produces a candidate, before it's queued/applied,
  // so the UI can stream them in ahead of the batch gate
  readonly onFixCandidate?: (candidate: FixCandidate) => void;
  // fires once per iteration right before the gate, with the full candidate list —
  // this is what the "Details" panel renders, no need to rebuild it from onFixCandidate
  readonly onFixBatchReady?: (candidates: readonly FixCandidate[], iteration: number) => void;
  // awaited because the caller appends an audit entry here and appendAuditEntry
  // assumes a single writer — firing these concurrently could race its read-modify-write
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

// git's well-known empty-tree hash, works in any repo even with zero commits
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Ref to diff the working tree against on refresh. Reuses diffRef when the scan
// was already ref-based; otherwise falls back to HEAD, except HEAD doesn't
// resolve on a brand-new repo with no commits, so we substitute the empty tree.
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

// same file + overlapping line range = two findings pointing at the same code
function locationsOverlap(a: Finding, b: Finding): boolean {
  return a.file === b.file && a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
}

// Collapses blocking findings to one per overlapping location, first-seen order
// (blocking is already in ROLE_ORDER so BA beats Dev beats QA etc — arbitrary
// but deterministic). Without this, BA/Dev/QA/PM all flagging the same swapped
// Fibonacci initializers meant 4 separate LLM fix attempts for identical lines.
// Once the representative's fix lands, the other findings just vanish on the
// next re-run since the code they pointed at is gone — no dedup bookkeeping needed.
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
    // edit tool throws when old_string isn't found — stale content or a race
    // between reading the file and applying the fix. just count it as failed.
    return false;
  }
}

// loops the batch gate until something other than 'details' comes back.
// stage is namespaced fix-batch:<iteration> so the CLI can tell it apart
// from a role gate purely from request.stage
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
    // 'details' loops back — CLI already showed the full diff for each candidate
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

    // one fix per unique location, not per finding (see dedupeByLocation) —
    // but `blocking` itself, un-deduped, is still what we report on escalate/abort
    const toFix = dedupeByLocation(blocking);
    opts.onIterationStart?.(iteration, toFix.length);

    let appliedAny = false;
    const pendingLlmFixes: FixCandidate[] = [];

    // generate every candidate for this iteration first. deterministic fixes
    // apply right away; LLM fixes get queued for the batch gate below.
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

    // one batch decision for every queued LLM fix
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
      // 'skip' — nothing queued gets applied, stays unresolved
    }

    if (!appliedAny) {
      // everything either hit its retry cap or both fixers declined — looping
      // more would just repeat the same result, so escalate now
      return { outcome: 'escalated', iterations: iteration, fixAttempts, unresolvedFindings: blocking.map((b) => b.finding) };
    }

    // working tree vs HEAD (or empty tree), never the index — see top of file
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

  // ran out of iterations — check once more if the last re-run actually cleared it
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

// plain-English role label for a fix attempt, for UI/report code
export function fixAttemptRoleLabel(record: FixAttemptRecord): string {
  return ROLE_LABELS[record.role];
}
