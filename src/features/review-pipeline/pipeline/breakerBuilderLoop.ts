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
// Optional hardening, all off by default for library callers and switched on by
// runReviewSession (see the options below):
//   finalVerification  the roles that were NOT blocking are never re-run by the cheap
//                      path above, so their verdicts describe code that no longer exists.
//                      With this on, once the cheap re-run comes back clear (and again if
//                      the loop stops for any other reason after editing), ALL six roles
//                      judge the final code from scratch and that result replaces the
//                      aggregator — the decision the user sees is then what a fresh
//                      `review scan` of the same code would produce, not a mixture of
//                      fresh and stale verdicts.
//   agent / validate   fixes are produced by a tool-using agent that can change several
//                      files (fixAgent.ts) and are tried in a throwaway copy of the
//                      project first (fixSandbox.ts); a fix that breaks the build or
//                      previously-passing tests is rolled back and retried once with the
//                      failure as feedback (fixValidator.ts). The real project only ever
//                      receives fixes that survived that. The agent gets every finding of
//                      the iteration in ONE conversation (root causes usually span several
//                      findings) plus a run_checks tool, so it fixes its own build/test
//                      breakage before handing over instead of costing a whole retry.
//   fixAdvisory        medium+ findings of flagging roles are fixed too, in the same pass.
//
// Findings on a file the change DELETED are answered by restoring that file from the diff's
// base (restoreDeletedFiles), in the first pass, before the fixer runs — never left to the
// model, which used to rewrite it as a "new" (temporary, discarded) test file round after round.
//
// With finalVerification on, the cheap "re-run only the blocking roles" step is skipped:
// the full six-role pass that follows would replace those verdicts anyway, and on a slow
// model that redundant partial pass was a third of a --fix run's wall time.
//
// Hard limits, not configurable: maxIterations (already capped upstream by
// validateReviewPipelineSettings) and MAX_RETRIES_PER_FILE (3).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { ROLE_LABELS, ROLE_ORDER, SEVERITY_ORDER, type Finding, type RoleId, type RoleOutput } from '../roles/roleContract.js';
import { ROLE_RUNNERS } from './orchestrator.js';
import { readDiff } from './diffReader.js';
import { tryDeterministicFix } from '../tools/deterministicFixer.js';
import { generateEdit } from './editGenerator.js';
import { createSandbox, type Sandbox } from './fixSandbox.js';
import type { ParsedDiff } from './diffReader.js';
import { compareValidation, runValidation, type ValidationOptions, type ValidationSnapshot } from './fixValidator.js';
import { applyAgentEdit, runFixAgent, type AgentEdit, type AgentFixOutcome, type FixTask, type FixTaskFinding } from './fixAgent.js';
import { runPipeline } from './orchestrator.js';
import type { PrewarmedFix } from './fixPrewarm.js';
import { fingerprintTree, type RoleCache } from './reviewCache.js';
import type { VerificationContext } from './roleRunContext.js';
import { builtinTools } from '../../../tools/builtin.js';
import { TEST_FILE, type ToolchainOptions } from '../../../core/toolchains/index.js';
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
  /** caveats worth showing the user: fixes the checks rejected, tests that could not gate, etc. */
  readonly notes?: readonly string[];
  /** where the fix's wall time went, by phase (observation only) */
  readonly timings?: ReadonlyArray<{ readonly label: string; readonly ms: number }>;
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
  /** run all six roles on the final code before reporting (see header) */
  readonly finalVerification?: boolean;
  /** produce fixes with the multi-file tool-using agent instead of the single-edit fallback */
  readonly agent?: boolean;
  /**
   * also fix medium-or-worse findings of roles that only flagged (not just roles that blocked),
   * so one --fix run aims for a change the reviewers approve rather than one they merely don't block
   */
  readonly fixAdvisory?: boolean;
  /**
   * NEW test files the fixer writes exist only in the temporary copy, as proof that the fix works,
   * and are discarded with it; only the production fix (and updates to tests that already existed)
   * reaches the project. Findings that merely ask for more tests are not sent to the fixer then.
   */
  readonly temporaryTests?: boolean;
  /** temporary copy + baseline prepared while the scan ran (fixPrewarm.ts); adopted only if the project is unchanged */
  readonly prewarmed?: Promise<PrewarmedFix | undefined>;
  /** shared with the scan so a fixed-then-unchanged state is not re-judged (reviewCache.ts) */
  readonly cache?: RoleCache;
  /** try every fix in a sandbox copy and reject it if it breaks the build or passing tests */
  readonly validate?: boolean;
  readonly validationOptions?: ValidationOptions;
  /** progress text for the long-running steps (sandbox setup, test runs, verification) */
  readonly onStatus?: (message: string) => void;
  /** settings `toolchain` + sandbox permission, for the Build role in every re-review */
  readonly toolchain?: ToolchainOptions;
}

export interface FixCandidate {
  readonly role: RoleId;
  readonly finding: Finding;
  readonly fixerStage: FixerStage;
  readonly oldString: string;
  readonly newString: string;
  readonly description: string;
  /** set for fixes produced in sandbox mode: how to replay this exact edit on the real project */
  readonly agentEdit?: AgentEdit;
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

const MEDIUM = SEVERITY_ORDER.indexOf('medium');
// a medium-only round (nothing blocking any more) is allowed at most this many times in total —
// reviewers can always find one more medium thing, and each round costs a full review
const MAX_ADVISORY_ITERATIONS = 2;

// What --fix works on: every finding of a role that blocked, and — with includeAdvisory —
// the medium-or-worse findings of roles that only flagged. Left out: the Director's flags
// (a synthesis of the other roles, not new evidence) and Build environment gaps (nothing in
// the code to change). Most severe first, so the fixer and the user see what matters first.
export function collectActionableFindings(aggregator: ContextAggregator, includeAdvisory: boolean, skipTestRequests = false): BlockingFinding[] {
  const out = collectBlockingFindings(aggregator, collectBlockingRoles(aggregator));
  if (includeAdvisory) {
    for (const role of ROLE_ORDER) {
      const output = aggregator.getRoleOutput(role);
      if (!output || output.verdict !== 'flag' || role === 'pm') continue;
      for (const finding of output.findings) {
        if (SEVERITY_ORDER.indexOf(finding.severity) < MEDIUM) continue;
        if (role === 'build' && /^Could not run/i.test(finding.description)) continue;
        out.push({ role, finding });
      }
    }
  }
  return (skipTestRequests ? out.filter((b) => !asksOnlyForTests(b.finding)) : out)
    .map((b, i) => ({ b, i }))
    .sort((x, y) => SEVERITY_ORDER.indexOf(y.b.finding.severity) - SEVERITY_ORDER.indexOf(x.b.finding.severity) || x.i - y.i)
    .map((x) => x.b);
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

// ── sandbox-mode helpers (agent / validate) ─────────────────────────────────


export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file.replace(/\\/g, '/'));
}

// "add tests" can't be satisfied when tests are temporary, so a finding that only asks for them
// would keep the loop busy for nothing
const MISSING_TESTS = /\b(no|missing|lacks?|lacking|without|zero|absent|not covered|uncovered)\b[^.\n]{0,60}\b(tests?|test coverage|coverage|assertions?)\b|\buntested\b/i;
export function asksOnlyForTests(finding: Finding): boolean {
  // "the change deletes the test suite" is a defect in the change, undone by restoring the files (see restoreDeletedFiles)
  if (/\b(delet|remov)/i.test(finding.description)) return false;
  return MISSING_TESTS.test(finding.description) && !/\b(wrong|incorrect|crash|leak|throws?|fails?|bug|regress)/i.test(finding.description.slice(0, 160));
}

// Splits a fix into what reaches the project and what stays in the copy: brand-new test files
// (and any later edit of them) are temporary; edits to tests that already exist are kept,
// since behavior the fix changed would otherwise leave those tests failing. `restored` are
// files the change deleted and the loop brought back — they existed before, so they are kept.
export async function splitTemporaryTests(
  edits: readonly AgentEdit[],
  cwd: string,
  restored: ReadonlySet<string> = new Set(),
): Promise<{ keep: AgentEdit[]; temporary: AgentEdit[] }> {
  const temporaryFiles = new Set<string>();
  for (const e of edits) {
    if (e.kind === 'write' && isTestFile(e.file) && !restored.has(e.file) && !(await fileExistsAt(path.join(cwd, e.file)))) temporaryFiles.add(e.file);
  }
  return {
    keep: edits.filter((e) => !temporaryFiles.has(e.file)),
    temporary: edits.filter((e) => temporaryFiles.has(e.file)),
  };
}

// The version a deleted file is restored from: 'A...B' diffs from their merge base, 'A..B' from
// A, a single ref from itself (against the working tree), and the default staged diff from HEAD.
async function diffBaseRef(cwd: string, diffRef: string | undefined): Promise<string> {
  if (!diffRef) return 'HEAD';
  if (diffRef.includes('...')) {
    const [a, b] = diffRef.split('...');
    return (await simpleGit({ baseDir: cwd }).raw(['merge-base', a || 'HEAD', b || 'HEAD'])).trim();
  }
  if (diffRef.includes('..')) return diffRef.split('..')[0] || 'HEAD';
  return diffRef;
}

export interface DeletedFileRestore {
  readonly edits: AgentEdit[];
  /** the findings the restore answers — they are not sent to the fixer */
  readonly covered: BlockingFinding[];
  readonly base: string;
}

// A finding that points at a file the change deleted is about the deletion itself: there is no
// other code there to fix. Undoing it is a revert, so the file comes back exactly as it was at
// the diff's base instead of being regenerated by the model. Leaving it to the fixer failed
// every time: "restore the tests" reads as a request for more tests (out of scope), and a test
// file absent from the project counts as a new, temporary one, so a rewritten copy was thrown
// away and the same finding came back in every round. Files the finding's text names (one
// finding often lists every deleted suite) are restored with it.
export async function restoreDeletedFiles(
  findings: readonly BlockingFinding[],
  diff: ParsedDiff,
  cwd: string,
  diffRef: string | undefined,
): Promise<DeletedFileRestore | null> {
  const deleted = diff.files.filter((f) => f.status === 'deleted').map((f) => f.path);
  if (deleted.length === 0) return null;
  const covered = findings.filter((b) => deleted.includes(b.finding.file));
  if (covered.length === 0) return null;
  const named = (file: string): boolean =>
    covered.some((b) => b.finding.file === file || b.finding.description.includes(path.posix.basename(file)));
  const base = await diffBaseRef(cwd, diffRef).catch(() => '');
  if (!base) return null;
  const git = simpleGit({ baseDir: cwd });
  const edits: AgentEdit[] = [];
  for (const file of deleted.filter(named)) {
    if (await fileExistsAt(path.join(cwd, file))) continue; // already back (an earlier round, or the user)
    const content = await git.show([`${base}:./${file}`]).catch(() => null);
    if (content === null || content.includes('\0')) continue; // not in the base, or binary
    edits.push({ kind: 'write', file, oldString: '', newString: content });
  }
  return edits.length > 0 ? { edits, covered, base } : null;
}

// vitest/jest/pytest wording for "there was nothing to run" — the usual reason a suite fails right after its files were deleted
// (vitest, jest, pytest, Maven surefire, Gradle)
const NO_TESTS_FOUND = /no test(s| files)? (were )?(found|ran|collected|to run|executed)|no tests? suites? found|no tests found for given includes/i;

async function fileExistsAt(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface PendingGroup {
  readonly candidates: FixCandidate[];
  /** how to undo this group in the sandbox if the real project cannot take it */
  readonly outcome: AgentFixOutcome;
  /** the edits that reach the real project (all of them unless temporary tests were split off) */
  readonly keepEdits: readonly AgentEdit[];
  /** restored deleted files this group carries (see restoreDeletedFiles): undone with it */
  readonly restore?: AgentFixOutcome;
}

// restored files that did not work with the changed code on their own, waiting in the sandbox for the fixer's update
interface CarriedRestore {
  readonly edits: readonly AgentEdit[];
  readonly inSandbox: AgentFixOutcome;
  readonly candidates: readonly FixCandidate[];
}

// id of the finding that asks the fixer to bring restored files up to date
const RESTORED_FILES_ID = 'restored-files';

function restoreCandidates(restore: DeletedFileRestore, description: string): FixCandidate[] {
  const lead = restore.covered[0]!;
  return restore.edits.map((e) => ({
    role: lead.role,
    finding: { ...lead.finding, file: e.file, lineStart: 1, lineEnd: 1 },
    fixerStage: 'deterministic' as const,
    oldString: '',
    newString: e.newString,
    description,
    agentEdit: e,
  }));
}

const MAX_TASKS_PER_ITERATION = 8;
const MAX_FINDINGS_PER_TASK = 20;
const MAX_AGENT_ATTEMPTS_PER_TASK = 2; // the second one gets the validation failure as feedback

// Normally ONE task holding every finding: findings in different files are often the same
// root cause (a service rule its UI can't surface), and one conversation fixes that end to
// end with one build/test check instead of several. Only a very large set is split — by
// file, packed into tasks of at most MAX_FINDINGS_PER_TASK — to keep each prompt focused.
// perFinding is the single-edit fallback's shape (one finding per edit).
export function groupFixTasks(findings: readonly BlockingFinding[], perFinding = false): FixTask[] {
  let groups: BlockingFinding[][];
  if (perFinding) {
    groups = findings.map((f) => [f]);
  } else if (findings.length <= MAX_FINDINGS_PER_TASK) {
    groups = findings.length > 0 ? [[...findings]] : [];
  } else {
    const byFile = new Map<string, BlockingFinding[]>();
    for (const f of findings) {
      const list = byFile.get(f.finding.file) ?? [];
      list.push(f);
      byFile.set(f.finding.file, list);
    }
    groups = [];
    let current: BlockingFinding[] = [];
    for (const list of byFile.values()) {
      if (current.length > 0 && current.length + list.length > MAX_FINDINGS_PER_TASK) {
        groups.push(current);
        current = [];
      }
      current.push(...list);
    }
    if (current.length > 0) groups.push(current);
  }
  return groups.slice(0, MAX_TASKS_PER_ITERATION).map((group) => ({
    findings: group as FixTaskFinding[],
    otherBlocking: findings.filter((f) => !group.includes(f)),
  }));
}

// Applies edits to a directory all-or-nothing: if any edit cannot be applied, the ones
// already applied are undone. A multi-file fix half-applied to the user's project would
// be worse than no fix.
export async function applyEditsAtomically(dir: string, edits: readonly AgentEdit[], description: string): Promise<AgentFixOutcome | null> {
  const preImages = new Map<string, string | null>();
  for (const e of edits) {
    const abs = path.join(dir, e.file);
    if (!preImages.has(abs)) preImages.set(abs, await fs.readFile(abs, 'utf-8').catch(() => null));
  }
  const rollback = async (): Promise<void> => {
    for (const [abs, original] of preImages) {
      if (original === null) await fs.rm(abs, { force: true });
      else await fs.writeFile(abs, original, 'utf-8');
    }
  };
  for (const e of edits) {
    if (!(await applyAgentEdit(e, dir))) {
      await rollback();
      return null;
    }
  }
  return { edits, description, rollback };
}

function candidateFor(task: FixTask, edit: AgentEdit, description: string): FixCandidate {
  const lead = task.findings[0]!;
  const sameFile = edit.file === lead.finding.file;
  return {
    role: lead.role,
    finding: sameFile ? lead.finding : { ...lead.finding, file: edit.file, lineStart: 1, lineEnd: 1 },
    fixerStage: 'llm',
    oldString: edit.oldString,
    newString: edit.newString,
    description,
    agentEdit: edit,
  };
}

function recordFor(iteration: number, c: FixCandidate): FixAttemptRecord {
  return {
    iteration,
    role: c.role,
    findingId: c.finding.id,
    file: c.finding.file,
    fixerStage: c.fixerStage,
    description: c.description,
    oldString: c.oldString,
    newString: c.newString,
  };
}

export async function runBreakerBuilderLoop(opts: RunBreakerBuilderLoopOptions): Promise<BreakerBuilderResult> {
  const fileRetryCounts = new Map<string, number>();
  const fixAttempts: FixAttemptRecord[] = [];
  const notes: string[] = [];
  const addNote = (n: string): void => {
    if (!notes.includes(n)) notes.push(n);
  };
  const status = (message: string): void => opts.onStatus?.(message);

  // wall time by phase, for the report (observation only)
  const phaseMs = new Map<string, number>();
  let checksInsideFixerMs = 0;
  async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      phaseMs.set(label, (phaseMs.get(label) ?? 0) + (Date.now() - startedAt));
    }
  }
  const timingRows = (): Array<{ label: string; ms: number }> =>
    [...phaseMs.entries()]
      .map(([label, ms]) => ({ label, ms: label === 'fixer (model work)' ? Math.max(0, ms - checksInsideFixerMs) : ms }))
      .filter((r) => r.ms >= 1000)
      .sort((a, b) => b.ms - a.ms);

  const sandboxed = opts.agent === true || opts.validate === true;
  let sandbox: Sandbox | undefined;
  let baseline: ValidationSnapshot | undefined;
  let initialBlocking: BlockingFinding[] | undefined;
  let temporaryTestFiles = 0;
  let baselineNotesAdded = false;
  // the last run_checks that came back OK, valid only until the next edit (fixAgent reports when it is)
  let lastCleanCheck: ValidationSnapshot | null = null;
  // the change as it stands now (the original diff until a fix lands), given to the fixer and to the checks
  let currentDiff: ParsedDiff = opts.aggregator.toJSON().diff;
  // true while the aggregator holds a complete, current six-role pass over the code as it is now
  let fullPassCurrent = true;

  const verification = (): VerificationContext | undefined =>
    initialBlocking && fixAttempts.length > 0
      ? {
          previouslyBlocking: initialBlocking.map((b) => ({ role: b.role, finding: b.finding })),
          appliedFixes: fixAttempts.map((f) => ({ file: f.file, description: f.description })),
        }
      : undefined;

  const result = (outcome: BreakerBuilderOutcome, iterations: number, unresolved: readonly Finding[]): BreakerBuilderResult => {
    const rows = timingRows();
    const all = temporaryTestFiles > 0
      ? [`${temporaryTestFiles} new test file(s) were written to prove the fixes work and then discarded; only the production changes were applied. Set reviewPipeline.fixKeepNewTests to keep them.`, ...notes]
      : notes;
    return {
      outcome,
      iterations,
      fixAttempts,
      unresolvedFindings: unresolved,
      ...(all.length > 0 ? { notes: all } : {}),
      ...(rows.length > 0 ? { timings: rows } : {}),
    };
  };

  // all six roles judge the code as it is now; replaces whatever the aggregator held
  async function verifyFully(): Promise<void> {
    status('Re-reviewing the fixed code with all six roles…');
    const diff = await readDiff(opts.cwd, await resolveWorkingTreeDiffRef(opts.cwd, opts.diffRef));
    currentDiff = diff;
    opts.cache?.refresh(); // the files changed, so the earlier fingerprint no longer describes them
    const pass = await timed('re-review (all six roles)', () =>
      runPipeline({
        diff,
        urs: opts.urs,
        llm: opts.llm,
        model: opts.model,
        cwd: opts.cwd,
        verification: verification(),
        cache: opts.cache,
        toolchain: opts.toolchain,
        onRoleComplete: (output) => opts.onRoleRerun?.(output),
      }),
    );
    if (pass.outcome === 'errored') throw pass.error;
    for (const role of pass.ranRoles) {
      const output = pass.aggregator.getRoleOutput(role);
      if (output) opts.aggregator.replaceRoleOutput(output);
    }
    fullPassCurrent = true;
  }

  // every way out of the loop except an abort goes through here, so the state the caller
  // resolves is a complete re-judgement of the final code whenever any edit was made
  async function conclude(iterations: number): Promise<BreakerBuilderResult> {
    if (opts.finalVerification && !fullPassCurrent) await verifyFully();
    const still = collectBlockingFindings(opts.aggregator, collectBlockingRoles(opts.aggregator));
    if (opts.fixAdvisory) {
      const left = collectActionableFindings(opts.aggregator, true, opts.temporaryTests === true).length - still.length;
      if (left > 0) addNote(`${left} medium finding(s) were still open at the end and are left for a human — see the scan report.`);
    }
    return result(still.length === 0 ? 'resolved' : 'escalated', iterations, still.map((b) => b.finding));
  }

  try {
    for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
      let blockingRoles = collectBlockingRoles(opts.aggregator);
      let blocking = collectBlockingFindings(opts.aggregator, blockingRoles);

      // the cheap re-run came back clear — before believing it, let every role re-judge
      if (blocking.length === 0 && opts.finalVerification && !fullPassCurrent) {
        await verifyFully();
        blockingRoles = collectBlockingRoles(opts.aggregator);
        blocking = collectBlockingFindings(opts.aggregator, blockingRoles);
      }
      const actionable = opts.fixAdvisory ? collectActionableFindings(opts.aggregator, true, opts.temporaryTests === true) : blocking;
      if (actionable.length === 0) return result('resolved', iteration - 1, []);
      if (blocking.length === 0 && iteration > MAX_ADVISORY_ITERATIONS) return await conclude(iteration - 1);
      initialBlocking ??= actionable;

      // one fix per unique location, not per finding (see dedupeByLocation) —
      // but `blocking` itself, un-deduped, is still what we report on escalate/abort
      const toFix = dedupeByLocation(actionable);
      opts.onIterationStart?.(iteration, toFix.length);

      let appliedAny = false;

      if (sandboxed) {
        if (!sandbox) {
          const pre = await opts.prewarmed;
          // adopt the copy prepared during the scan only if the project is exactly as it was when it was taken
          if (pre && pre.fingerprint !== null && pre.fingerprint === (await fingerprintTree(opts.cwd))) {
            sandbox = pre.sandbox;
            baseline = pre.baseline;
            phaseMs.set('temp copy + baseline (during the scan)', pre.preparationMs);
          } else {
            if (pre) addNote('The project changed while the review was running, so the temporary copy prepared in advance was discarded and a new one was made.');
            status('Creating a temporary copy of the project to try fixes in…');
            sandbox = await timed('temp copy', () => createSandbox(opts.cwd));
          }
        }
        if (opts.validate && !baseline) {
          status('Measuring the build and test baseline in the temporary copy…');
          const sbForBaseline = sandbox;
          baseline = await timed('baseline build + tests', () => runValidation(sbForBaseline.dir, opts.aggregator.toJSON().diff, opts.validationOptions));
        }
        if (opts.validate && baseline && !baselineNotesAdded) {
          baselineNotesAdded = true;
          if (!baseline.buildVerified) addNote('The build could not be verified in this environment, so fixes were not gated on it.');
          if (baseline.tests.status === 'fail') addNote(`Tests were already failing before any fix (${baseline.tests.command}), so they were not used to gate fixes.`);
          if (baseline.tests.status === 'not-run') addNote(`Tests were not run (${baseline.tests.output}), so fixes were not gated on them.`);
        }
        const sb = sandbox;

        // restored test files that fail against the changed code — only a problem when it is clearly
        // them failing: the suite passed before, or it failed only because there was nothing to run
        let carried: CarriedRestore | undefined;
        const restoredTestsFail = (snapshot: ValidationSnapshot): boolean =>
          snapshot.tests.status === 'fail' && !!baseline && (baseline.tests.status !== 'fail' || NO_TESTS_FOUND.test(baseline.tests.output));
        // checkRestored: also hold the restored files to passing (for the check of the restore itself and of the fix that carries it)
        const judge = (snapshot: ValidationSnapshot, checkRestored: boolean): { acceptable: boolean; reasons: string[]; notes: readonly string[] } => {
          const verdict = compareValidation(baseline!, snapshot);
          const reasons = [...verdict.reasons];
          if (checkRestored && restoredTestsFail(snapshot) && !reasons.some((r) => r.startsWith('tests passed before'))) {
            reasons.push(`the restored tests fail (${snapshot.tests.command}): ${snapshot.tests.output.slice(-500)}`);
          }
          return { acceptable: reasons.length === 0, reasons, notes: verdict.notes };
        };

        // `alreadyVerified`: the fixer's own last run_checks was OK and nothing was edited after it, so the copy
        // is in exactly the state that was just checked — running the same build + tests again cannot say more
        const accept = async (task: FixTask, alreadyVerified?: ValidationSnapshot | null): Promise<'ok' | string> => {
          if (!opts.validate || !baseline) return 'ok';
          let snapshot: ValidationSnapshot;
          if (alreadyVerified) {
            snapshot = alreadyVerified;
          } else {
            status(`Checking the fix${task.findings.length > 1 ? `es (${task.findings.length} findings)` : ` to ${task.findings[0]!.finding.file}`} — build + tests…`);
            snapshot = await timed('build + tests (fix checks)', () => runValidation(sb.dir, currentDiff, opts.validationOptions));
          }
          const verdict = judge(snapshot, task.findings.some((f) => f.finding.id === RESTORED_FILES_ID));
          if (!verdict.acceptable) return verdict.reasons.join('; ');
          baseline = { ...snapshot, tests: snapshot.tests.status === 'not-run' ? baseline.tests : snapshot.tests };
          return 'ok';
        };

        // a deletion the reviewers flagged is undone first, by restoring the files (see restoreDeletedFiles).
        // If they come back clean they go straight to the project like any deterministic fix; if they no
        // longer build or pass against the changed code, the fixer brings them up to date in this same
        // pass and they reach the project together with its fix — never as a broken half.
        const needsAgent: BlockingFinding[] = [];
        let fixable = toFix;
        const restore = await restoreDeletedFiles(toFix, currentDiff, opts.cwd, opts.diffRef);
        if (restore) {
          const files = restore.edits.map((e) => e.file);
          const description = `Restored ${files.join(', ')} as of ${restore.base}: the change deleted ${files.length === 1 ? 'it' : 'them'} and the reviewers flagged the deletion.`;
          const inSandbox = await applyEditsAtomically(sb.dir, restore.edits, description);
          if (inSandbox) {
            fixable = toFix.filter((b) => !restore.covered.includes(b));
            const candidates = restoreCandidates(restore, description);
            for (const c of candidates) opts.onFixCandidate?.(c);
            let problems: string[] = [];
            let snapshot: ValidationSnapshot | undefined;
            if (opts.validate && baseline) {
              status(`Checking the restored file${files.length === 1 ? '' : 's'} — build + tests…`);
              snapshot = await timed('build + tests (fix checks)', () => runValidation(sb.dir, currentDiff, opts.validationOptions));
              problems = judge(snapshot, true).reasons;
            }
            const real = problems.length === 0 ? await applyEditsAtomically(opts.cwd, restore.edits, description) : null;
            if (real) {
              if (snapshot && baseline) baseline = { ...snapshot, tests: snapshot.tests.status === 'not-run' ? baseline.tests : snapshot.tests };
              appliedAny = true;
              for (const c of candidates) {
                const record = recordFor(iteration, c);
                fixAttempts.push(record);
                await opts.onFixAttempt?.(record);
              }
            } else if (problems.length > 0) {
              carried = { edits: restore.edits, inSandbox, candidates };
              const lead = restore.covered[0]!;
              needsAgent.push({
                role: lead.role,
                finding: {
                  id: RESTORED_FILES_ID,
                  severity: 'high',
                  file: files[0]!,
                  lineStart: 1,
                  lineEnd: 1,
                  description:
                    `The change deleted ${files.join(', ')}, and the reviewers flagged that (${restore.covered.length} finding(s)). ` +
                    `They have been restored exactly as they were at ${restore.base}, but against the changed code: ${problems.join('; ')}. ` +
                    'Bring the restored files up to date with the change\'s intended new behavior: keep every assertion that still applies, ' +
                    'change only what the change legitimately altered, and cover the new behavior the reviewers named. Do not delete them or weaken them to pass.',
                },
              });
            } else {
              await inSandbox.rollback();
            }
          }
        }

        // deterministic fixes next, same as before — tried in the sandbox, then applied for real, ungated
        for (const b of fixable) {
          const retries = fileRetryCounts.get(b.finding.file) ?? 0;
          if (retries >= MAX_RETRIES_PER_FILE) continue;
          const fix = await tryDeterministicFix(b.finding, opts.cwd);
          if (!fix) {
            needsAgent.push(b);
            continue;
          }
          const edit: AgentEdit = { kind: 'edit', file: fix.file, oldString: fix.oldString, newString: fix.newString };
          const candidate: FixCandidate = { role: b.role, finding: b.finding, fixerStage: 'deterministic', oldString: fix.oldString, newString: fix.newString, description: fix.description, agentEdit: edit };
          opts.onFixCandidate?.(candidate);
          const inSandbox = await applyEditsAtomically(sb.dir, [edit], fix.description);
          if (!inSandbox) continue;
          const verdict = await accept({ findings: [b], otherBlocking: [] });
          if (verdict !== 'ok') {
            await inSandbox.rollback();
            addNote(`A fix to ${fix.file} was rejected by the checks and rolled back: ${verdict}`);
            continue;
          }
          const real = await applyEditsAtomically(opts.cwd, [edit], fix.description);
          if (!real) {
            await inSandbox.rollback();
            continue;
          }
          fileRetryCounts.set(fix.file, retries + 1);
          appliedAny = true;
          const record = recordFor(iteration, candidate);
          fixAttempts.push(record);
          await opts.onFixAttempt?.(record);
        }

        // everything else: the fixer (agent, or the single-edit LLM when agent is off)
        const pending: PendingGroup[] = [];
        const tasks = groupFixTasks(needsAgent, opts.agent !== true).map((t) => ({
          ...t,
          otherBlocking: actionable.filter((b) => !t.findings.includes(b) && !restore?.covered.includes(b)),
        }));
        // offered to the agent as its run_checks tool: same comparison as accept(), but it does not reject anything —
        // it tells the agent what it broke while it can still fix it in the same conversation
        const runChecks =
          opts.validate && baseline
            ? async (): Promise<string> => {
                status('Fixer is running the build and tests on its edits…');
                const startedAt = Date.now();
                const snapshot = await runValidation(sb.dir, currentDiff, opts.validationOptions);
                const spent = Date.now() - startedAt;
                phaseMs.set('build + tests (fix checks)', (phaseMs.get('build + tests (fix checks)') ?? 0) + spent);
                checksInsideFixerMs += spent; // happened inside the fixer's wall time, reported separately from its model work
                const verdict = judge(snapshot, carried !== undefined);
                const caveats = verdict.notes.length > 0 ? ` (${verdict.notes.join('; ')})` : '';
                lastCleanCheck = verdict.acceptable ? snapshot : null;
                // tests that were already failing do not block, but the output still helps when the failures are in files it touched
                const failingTail = snapshot.tests.status === 'fail' ? `\n\nTest output (end):\n${snapshot.tests.output.slice(-1500)}` : '';
                if (verdict.acceptable) return `OK — ${snapshot.buildSummary} Tests: ${snapshot.tests.status}.${caveats}${failingTail}`;
                const testTail = snapshot.tests.status === 'fail' ? `\n\nTest output (end):\n${snapshot.tests.output.slice(-2500)}` : '';
                return `PROBLEMS — fix these before finishing:\n- ${verdict.reasons.join('\n- ')}${testTail}`;
              }
            : undefined;
        for (const task of tasks) {
          const carries = carried !== undefined && task.findings.some((f) => f.finding.id === RESTORED_FILES_ID);
          if (!carries && task.findings.every((f) => (fileRetryCounts.get(f.finding.file) ?? 0) >= MAX_RETRIES_PER_FILE)) continue;
          let feedback: string | undefined;
          for (let attempt = 1; attempt <= MAX_AGENT_ATTEMPTS_PER_TASK; attempt++) {
            const what = task.findings.length > 1 ? `${task.findings.length} findings` : task.findings[0]!.finding.file;
            status(`Fixing ${what}${attempt > 1 ? ' (second attempt, with the check failure as feedback)' : ''}…`);
            let outcome: AgentFixOutcome | null;
            lastCleanCheck = null;
            if (opts.agent) {
              outcome = await timed('fixer (model work)', () =>
                runFixAgent(
                  task,
                  { llm: opts.llm, model: opts.model, sandboxDir: sb.dir, diff: currentDiff, temporaryTests: opts.temporaryTests === true, ...(runChecks ? { runChecks } : {}) },
                  feedback,
                ),
              );
            } else {
              const generated = await timed('fixer (model work)', () => generateEdit(task.findings[0]!.finding, { llm: opts.llm, model: opts.model, cwd: opts.cwd }));
              outcome = generated
                ? await applyEditsAtomically(sb.dir, [{ kind: 'edit', file: generated.file, oldString: generated.oldString, newString: generated.newString }], generated.description)
                : null;
            }
            if (!outcome) break; // declined / nothing to change
            const verdict = await accept(task, outcome.verifiedClean ? lastCleanCheck : null);
            if (verdict !== 'ok') {
              await outcome.rollback();
              feedback = verdict;
              addNote(`A fix to ${task.findings[0]!.finding.file} was rejected by the checks and rolled back: ${verdict}`);
              continue;
            }
            for (const u of outcome.unfixed ?? []) addNote(`The fixer left finding ${u.id} unchanged: ${u.reason}`);
            let toApply: readonly AgentEdit[] = outcome.edits;
            if (opts.temporaryTests) {
              const { keep, temporary } = await splitTemporaryTests(outcome.edits, opts.cwd, new Set(carries ? carried!.edits.map((e) => e.file) : []));
              if (temporary.length > 0) {
                temporaryTestFiles += new Set(temporary.map((e) => e.file)).size;
                toApply = keep;
              }
            }
            if (toApply.length === 0 && !carries) {
              await outcome.rollback();
              addNote('The fixer only produced new test files, which are temporary — nothing to apply.');
              break;
            }
            const candidates = toApply.map((e) => candidateFor(task, e, outcome!.description));
            for (const c of candidates) opts.onFixCandidate?.(c);
            // the restored files go first: the fixer's edits to them apply on top of the restored content
            pending.push(
              carries
                ? { candidates: [...carried!.candidates, ...candidates], outcome, keepEdits: [...carried!.edits, ...toApply], restore: carried!.inSandbox }
                : { candidates, outcome, keepEdits: toApply },
            );
            if (carries) carried = undefined;
            break;
          }
          if (carries && carried) {
            // the fixer could not make the restored files work with the change — leave the deletion for a human
            // rather than bring back files that break the build or the tests
            await carried.inSandbox.rollback();
            addNote(`Restoring ${carried.edits.map((e) => e.file).join(', ')} was left for a human: the restored files do not work with the changed code and the fixer could not bring them up to date.`);
            carried = undefined;
          }
        }

        if (pending.length > 0) {
          const flat = pending.flatMap((g) => g.candidates);
          let decision: 'continue' | 'skip' | 'abort' = 'continue';
          if (opts.interaction) {
            opts.onFixBatchReady?.(flat, iteration);
            decision = await gateForFixBatch(opts.interaction, iteration, flat);
          }
          if (decision === 'abort') {
            for (const g of pending) {
              await g.outcome.rollback();
              await g.restore?.rollback();
            }
            return result('aborted', iteration, blocking.map((b) => b.finding));
          }
          for (const g of pending) {
            const files = new Set(g.candidates.map((c) => c.finding.file));
            const overCap = [...files].some((f) => (fileRetryCounts.get(f) ?? 0) >= MAX_RETRIES_PER_FILE);
            const real =
              decision === 'continue' && !overCap
                ? await applyEditsAtomically(opts.cwd, g.keepEdits, g.outcome.description)
                : null;
            if (!real) {
              await g.outcome.rollback(); // keep the sandbox identical to the real project
              await g.restore?.rollback();
              continue;
            }
            for (const f of files) fileRetryCounts.set(f, (fileRetryCounts.get(f) ?? 0) + 1);
            appliedAny = true;
            for (const c of g.candidates) {
              const record = recordFor(iteration, c);
              fixAttempts.push(record);
              await opts.onFixAttempt?.(record);
            }
          }
        }
      } else {
        const pendingLlmFixes: FixCandidate[] = [];

        // a flagged deletion is undone by restoring the files (no checks to run in this mode)
        let fixable = toFix;
        const restore = await restoreDeletedFiles(toFix, currentDiff, opts.cwd, opts.diffRef);
        if (restore) {
          const files = restore.edits.map((e) => e.file);
          const description = `Restored ${files.join(', ')} as of ${restore.base}: the change deleted ${files.length === 1 ? 'it' : 'them'} and the reviewers flagged the deletion.`;
          if (await applyEditsAtomically(opts.cwd, restore.edits, description)) {
            fixable = toFix.filter((b) => !restore.covered.includes(b));
            appliedAny = true;
            for (const c of restoreCandidates(restore, description)) {
              opts.onFixCandidate?.(c);
              const record = recordFor(iteration, c);
              fixAttempts.push(record);
              await opts.onFixAttempt?.(record);
            }
          }
        }

        // generate every candidate for this iteration first. deterministic fixes
        // apply right away; LLM fixes get queued for the batch gate below.
        for (const { role, finding } of fixable) {
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
            return result('aborted', iteration, blocking.map((b) => b.finding));
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
      }

      if (!appliedAny) {
        // everything either hit its retry cap or both fixers declined — looping more would just
        // repeat the same result. Resolved if nothing is blocking (what was attempted was advisory),
        // escalated otherwise; conclude() decides, never "escalated with 0 blocking findings".
        return await conclude(iteration);
      }
      fullPassCurrent = false;

      // the full re-review IS the re-check — a partial pass first would only be thrown away
      if (opts.finalVerification) {
        await verifyFully();
        continue;
      }

      // working tree vs HEAD (or empty tree), never the index — see top of file
      const refreshedDiff = await readDiff(opts.cwd, await resolveWorkingTreeDiffRef(opts.cwd, opts.diffRef));

      const rerun = new Set<RoleId>(blockingRoles);
      for (const role of ROLE_ORDER.filter((r) => rerun.has(r))) {
        const ctx: RoleRunContext = {
          llm: opts.llm,
          model: opts.model,
          diff: refreshedDiff,
          urs: opts.urs,
          aggregator: opts.aggregator,
          cwd: opts.cwd,
          verification: verification(),
          toolchain: opts.toolchain,
        };
        const output = await timed('re-review (blocking roles)', () => ROLE_RUNNERS[role](ctx));
        opts.aggregator.replaceRoleOutput(output);
        opts.onRoleRerun?.(output);
      }
    }

    // ran out of iterations — check once more if the last re-run actually cleared it
    return await conclude(opts.maxIterations);
  } finally {
    await sandbox?.cleanup();
    // a copy prepared during the scan that this run never adopted (nothing needed fixing, or the project changed)
    const pre = await opts.prewarmed;
    if (pre && pre.sandbox !== sandbox) await pre.sandbox.cleanup().catch(() => undefined);
  }
}

// plain-English role label for a fix attempt, for UI/report code
export function fixAttemptRoleLabel(record: FixAttemptRecord): string {
  return ROLE_LABELS[record.role];
}
