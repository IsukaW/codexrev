// Tool-using fixer for the --fix loop. Unlike editGenerator.ts (one finding, one file,
// a +/-30 line window, one string replacement) this works the way an engineer would:
// it reads the files, greps the callers, and changes whatever the ROOT CAUSE needs —
// several files, tests included — in the sandbox copy of the project, never the real one.
//
// Everything it does is recorded as a plain edit list so the caller can (1) validate the
// result in the sandbox, (2) roll the sandbox back if validation fails, and (3) replay the
// exact same edits onto the real project through the shared edit/write_file tools once
// the user has confirmed them.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { builtinTools } from '../../../tools/builtin.js';
import type { Tool } from '../../../tools/registry.js';
import type { ContentPart, Message, ToolCallPart, ToolDeclaration } from '../../../core/types.js';
import { ROLE_LABELS, type Finding, type RoleId } from '../roles/roleContract.js';
import { extractJson, formatDiffForPrompt, generateWithRetry } from './llmRoleRunner.js';
import type { ParsedDiff } from './diffReader.js';
import type { ILLMProvider } from './illmProvider.js';

const MAX_AGENT_TURNS = 24;
const DIFF_CONTEXT_CHARS = 40_000;
const READ_TOOLS = ['read_file', 'glob', 'grep'] as const;
const WRITE_TOOLS = ['edit', 'write_file'] as const;
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', '.git', '.codexrev']);
const FORBIDDEN_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock)$/;

export interface FixTaskFinding {
  readonly role: RoleId;
  readonly finding: Finding;
}

export interface FixTask {
  /** the findings this task must resolve — normally every actionable finding of the iteration */
  readonly findings: readonly FixTaskFinding[];
  /** findings handled by a different task this iteration — context only, so fixes don't contradict each other */
  readonly otherBlocking: readonly FixTaskFinding[];
}

export interface AgentEdit {
  readonly kind: 'edit' | 'write';
  readonly file: string; // project-relative, posix separators
  readonly oldString: string; // '' when a file was created
  readonly newString: string;
  readonly replaceAll?: boolean;
}

export interface AgentFixOutcome {
  readonly edits: readonly AgentEdit[];
  readonly description: string;
  /** findings the agent reported it deliberately left alone, with its reason */
  readonly unfixed?: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /** the agent's last run_checks reported OK and it has not edited anything since, so the copy is already verified */
  readonly verifiedClean?: boolean;
  /** restores every file this run touched to its pre-run content (deleting files it created) */
  rollback(): Promise<void>;
}

export interface FixAgentContext {
  readonly llm: ILLMProvider;
  readonly model: string;
  readonly sandboxDir: string;
  readonly maxTurns?: number;
  /** the change under review, so the fixer knows what the author was trying to do */
  readonly diff?: ParsedDiff;
  /** build + tests in the sandbox against the pre-fix baseline; offered to the model as the run_checks tool */
  readonly runChecks?: () => Promise<string>;
  /** new test files are discarded after verification instead of being kept in the project */
  readonly temporaryTests?: boolean;
}

const RUN_CHECKS_DECLARATION: ToolDeclaration = {
  name: 'run_checks',
  description:
    "Run the project's build/type-check and test suite on your current edits and compare with the state before you started. Returns OK, or the new build errors / newly failing tests to fix.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const SYSTEM_PROMPT = `
You are the Fixer in an automated code-review pipeline. Reviewers found problems in a change; you repair ALL of them in one pass, inside a throwaway copy of the project. Your edits are checked (build + tests) and re-reviewed by every reviewer before anyone relies on them, so a half-fix or a fix that creates a new problem is wasted work — aim to make the next review come back clean.

You have read tools (read_file, glob, grep), write tools (edit, write_file) and, when available, run_checks. Work like a careful senior engineer:
1. Understand first: read the change under review, read each cited file in full, and grep for callers and existing tests before editing.
2. Fix the ROOT CAUSE, end to end. When several findings share a cause — e.g. a validation rule added in a service while its caller and the UI cannot report the failure — fix every layer involved so behavior is consistent. Moving a problem to another file is not a fix.
3. Fix every finding listed, most severe first. Medium findings matter too: the goal is a change the reviewers approve.
4. Make the smallest COMPLETE change. Keep the author's intent, public signatures and existing behavior unless a finding requires changing them; if you change a signature, update every caller you found. Do not reformat, rename or tidy unrelated code; follow the patterns the codebase already uses.
5. Before you finish, review your own edits for the regressions fixes usually cause:
   - async/UI state: double submission while a request is in flight, state updated after unmount, a loading/error flag that is never reset or is shared by two features so one clears the other's message;
   - errors: every new failure path is surfaced to the caller/user, nothing is swallowed, the original error is kept;
   - input kept or cleared at the right moment (e.g. only after success), boundaries (0, empty, max, max+1) behave as intended;
   - tests: new or changed behavior has a test in the project's existing framework and style that would fail without your fix and asserts real values, not just "does not throw". Never add production code whose only purpose is to make a test possible (reset hooks, test-only exports or flags); use the project's own seams, fake timers or dependency injection instead.
6. Never: add dependencies; edit lockfiles or build/tooling config; delete or weaken existing tests or assertions; silence problems with \`any\`/\`as\` casts, \`@ts-ignore\`, empty catch blocks, or by removing the check that found the problem.
7. \`edit\` needs old_string to match the file exactly once — include enough surrounding lines to be unique. Paths are relative to the project root.
8. If run_checks is available, call it after your edits. If it reports new build errors or failing tests, fix them and call it again. Finish only when it reports OK (or you have explained why it cannot).
9. If a finding is wrong (the code is already correct) or cannot be fixed safely without a product decision, leave it and say why instead of guessing.

When finished, reply with ONLY this JSON:
{"status": "fixed" | "partial" | "cannot_fix", "description": "two or three plain sentences: what was wrong and what you changed", "unfixed": [{"id": "<finding id>", "reason": "why it was left"}]}
`.trim();

function describeFinding({ role, finding }: FixTaskFinding): string {
  const fix = finding.suggestedFix ? `\n   Reviewer's suggested fix: ${finding.suggestedFix}` : '';
  return `- id ${finding.id} (${ROLE_LABELS[role]}) [${finding.severity}] ${finding.file}:${finding.lineStart}-${finding.lineEnd}\n   ${finding.description}${fix}`;
}

function buildUserPrompt(task: FixTask, diff: ParsedDiff | undefined, canRunChecks: boolean, temporaryTests: boolean, feedback?: string): string {
  const parts: string[] = [];
  if (diff && diff.files.length > 0) {
    parts.push(`## The change under review (what the author changed)\n\n${formatDiffForPrompt(diff, DIFF_CONTEXT_CHARS)}`);
  }
  parts.push(`## Findings to resolve (most severe first)\n\n${task.findings.map(describeFinding).join('\n')}`);
  if (task.otherBlocking.length > 0) {
    parts.push(
      `## Findings handled in a separate pass (context only — do not undo or contradict them)\n\n${task.otherBlocking
        .slice(0, 12)
        .map(describeFinding)
        .join('\n')}`,
    );
  }
  if (feedback) {
    parts.push(
      `## Your previous attempt was REJECTED and rolled back\n\n${feedback}\n\nThe project is back to its original state. Fix the cause of the rejection and try again.`,
    );
  }
  if (temporaryTests) {
    parts.push(
      'NEW test files you create are TEMPORARY: they run in this throwaway copy to prove your fix works and are then deleted — only your production-code changes (and edits to test files that already exist, including deleted test files that were restored for you) reach the project. So write them to verify, keep them small and focused, and do not add production code (hooks, exports, flags) that exists only to make something testable. Findings that merely ask for more tests are out of scope.',
    );
  }
  if (canRunChecks) parts.push('run_checks is available — use it before you finish.');
  return parts.join('\n\n');
}

// A path is usable only if it stays inside the sandbox. node_modules is a symlink to the real
// project's, and .git/lockfiles must never change, so those are refused for writes.
async function guardPath(sandboxDir: string, p: unknown, forWrite: boolean): Promise<{ rel: string; abs: string } | string> {
  if (typeof p !== 'string' || p.length === 0) return 'file_path is required';
  const abs = path.resolve(sandboxDir, p);
  const rel = path.relative(sandboxDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return `path "${p}" is outside the project`;
  if (rel === '' && forWrite) return 'file_path must name a file, not the project root';
  const posix = rel.split(path.sep).join('/');
  if (forWrite) {
    if (posix.split('/').some((seg) => FORBIDDEN_SEGMENTS.has(seg))) return `writing to "${posix}" is not allowed`;
    if (FORBIDDEN_FILES.test(posix)) return `"${posix}" is a lockfile and must not be edited`;
    // resolve symlinks on the nearest existing ancestor so a link cannot lead out of the sandbox
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const realRoot = await fs.realpath(sandboxDir);
        if (path.relative(realRoot, real).startsWith('..')) return `"${posix}" resolves outside the project`;
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
  }
  return { rel: posix, abs };
}

function extractText(parts: readonly ContentPart[]): string {
  return parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
}

export async function runFixAgent(task: FixTask, ctx: FixAgentContext, feedback?: string): Promise<AgentFixOutcome | null> {
  const preImages = new Map<string, string | null>(); // abs path -> original content, null = did not exist
  const edits: AgentEdit[] = [];
  let checkedCleanAtEditCount: number | null = null;
  const all = builtinTools();
  const readTools = new Map(all.filter((t) => (READ_TOOLS as readonly string[]).includes(t.name)).map((t) => [t.name, t]));
  const declarations: ToolDeclaration[] = [...READ_TOOLS, ...WRITE_TOOLS]
    .map((name) => all.find((t) => t.name === name)?.declaration)
    .filter((d): d is ToolDeclaration => d !== undefined);
  if (ctx.runChecks) declarations.push(RUN_CHECKS_DECLARATION);

  async function remember(abs: string): Promise<void> {
    if (preImages.has(abs)) return;
    preImages.set(abs, await fs.readFile(abs, 'utf-8').catch(() => null));
  }

  async function runTool(call: ToolCallPart): Promise<string> {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    try {
      if (call.name === 'edit') {
        const guarded = await guardPath(ctx.sandboxDir, args.file_path, true);
        if (typeof guarded === 'string') return `Error: ${guarded}`;
        const { old_string, new_string } = args;
        if (typeof old_string !== 'string' || typeof new_string !== 'string' || old_string.length === 0) {
          return 'Error: old_string (non-empty) and new_string are required';
        }
        const orig = await fs.readFile(guarded.abs, 'utf-8').catch(() => null);
        if (orig === null) return `Error: ${guarded.rel} does not exist (use write_file to create a file)`;
        const count = orig.split(old_string).length - 1;
        const replaceAll = args.replace_all === true;
        if (count === 0) return `Error: old_string not found in ${guarded.rel}`;
        if (count > 1 && !replaceAll) return `Error: old_string appears ${count} times in ${guarded.rel}; include more surrounding lines so it is unique (or set replace_all)`;
        await remember(guarded.abs);
        // function replacer: new_string must be inserted literally ("$&" etc. are not special)
        const updated = replaceAll ? orig.split(old_string).join(new_string) : orig.replace(old_string, () => new_string);
        await fs.writeFile(guarded.abs, updated, 'utf-8');
        edits.push({ kind: 'edit', file: guarded.rel, oldString: old_string, newString: new_string, ...(replaceAll ? { replaceAll: true } : {}) });
        return `edited ${guarded.rel}`;
      }
      if (call.name === 'run_checks') {
        if (!ctx.runChecks) return 'Error: run_checks is not available in this run';
        const report = await ctx.runChecks();
        checkedCleanAtEditCount = report.startsWith('OK') ? edits.length : null;
        return report;
      }
      if (call.name === 'write_file') {
        const guarded = await guardPath(ctx.sandboxDir, args.file_path, true);
        if (typeof guarded === 'string') return `Error: ${guarded}`;
        if (typeof args.content !== 'string') return 'Error: content must be a string';
        await remember(guarded.abs);
        const before = preImages.get(guarded.abs) ?? '';
        await fs.mkdir(path.dirname(guarded.abs), { recursive: true });
        await fs.writeFile(guarded.abs, args.content, 'utf-8');
        edits.push({ kind: 'write', file: guarded.rel, oldString: before, newString: args.content });
        return `wrote ${guarded.rel}`;
      }
      const tool = readTools.get(call.name);
      if (!tool) return `Error: unknown tool "${call.name}"`;
      // keep read tools inside the sandbox too
      const safeArgs = { ...args };
      for (const key of ['file_path', 'path', 'cwd'] as const) {
        if (key in safeArgs) {
          const g = await guardPath(ctx.sandboxDir, safeArgs[key], false);
          if (typeof g === 'string') return `Error: ${g}`;
          safeArgs[key] = g.abs;
        }
      }
      const result = await (tool as Tool).execute(safeArgs, { cwd: ctx.sandboxDir });
      const out = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      return result.isError ? `Error: ${out}` : out.length > 20_000 ? `${out.slice(0, 20_000)}\n[output truncated]` : out;
    } catch (err) {
      return `Error: ${(err as Error).message ?? String(err)}`;
    }
  }

  const messages: Message[] = [{ role: 'user', parts: [{ kind: 'text', text: buildUserPrompt(task, ctx.diff, ctx.runChecks !== undefined, ctx.temporaryTests === true, feedback) }] }];
  let finalText = '';
  const maxTurns = ctx.maxTurns ?? MAX_AGENT_TURNS;
  for (let turn = 0; ; turn++) {
    const last = turn >= maxTurns;
    const res = await generateWithRetry(ctx.llm, {
      model: ctx.model,
      systemInstruction: SYSTEM_PROMPT,
      messages,
      ...(last ? {} : { tools: declarations }),
      temperature: 0.1,
    });
    messages.push({ role: 'assistant', parts: res.message.parts });
    const calls = res.message.parts.filter((p): p is ToolCallPart => p.kind === 'tool_call');
    if (calls.length === 0 || last) {
      finalText = extractText(res.message.parts);
      break;
    }
    for (const call of calls) {
      messages.push({
        role: 'tool',
        parts: [{ kind: 'tool_result', toolCallId: call.id, name: call.name, content: [{ kind: 'text', text: await runTool(call) }] }],
      });
    }
  }

  async function rollback(): Promise<void> {
    for (const [abs, original] of preImages) {
      if (original === null) await fs.rm(abs, { force: true });
      else await fs.writeFile(abs, original, 'utf-8');
    }
    preImages.clear();
  }

  if (edits.length === 0) return null;

  let description = fallbackDescription(task, edits);
  let unfixed: Array<{ id: string; reason: string }> | undefined;
  try {
    const json = extractJson(finalText) as { status?: unknown; description?: unknown; unfixed?: unknown };
    if (typeof json.description === 'string' && json.description.trim().length > 0) description = json.description.trim();
    if (Array.isArray(json.unfixed)) {
      unfixed = json.unfixed
        .filter((u): u is { id: unknown; reason: unknown } => typeof u === 'object' && u !== null)
        .map((u) => ({ id: String(u.id ?? ''), reason: String(u.reason ?? '') }))
        .filter((u) => u.id.length > 0);
    }
    if (json.status === 'cannot_fix') {
      await rollback();
      return null;
    }
  } catch {
    // the edit list is the source of truth, a missing closing JSON is not fatal
  }
  return {
    edits,
    description,
    rollback,
    ...(unfixed && unfixed.length > 0 ? { unfixed } : {}),
    ...(checkedCleanAtEditCount === edits.length ? { verifiedClean: true } : {}),
  };
}

// used when the model never sent its closing JSON — still says what was addressed and where
function fallbackDescription(task: FixTask, edits: readonly AgentEdit[]): string {
  const files = [...new Set(edits.map((e) => e.file))];
  const lead = task.findings[0]?.finding.description ?? '';
  const first = lead.length > 120 ? `${lead.slice(0, 117)}…` : lead;
  return `Addressed ${task.findings.length} finding(s) across ${files.length} file(s)${first ? ` — starting with: ${first}` : ''}.`;
}

/** Applies one recorded edit to a project directory using the shared edit/write_file tools. */
export async function applyAgentEdit(edit: AgentEdit, dir: string): Promise<boolean> {
  const tool = builtinTools().find((t) => t.name === (edit.kind === 'write' ? 'write_file' : 'edit'));
  if (!tool) return false;
  try {
    const result =
      edit.kind === 'write'
        ? await tool.execute({ file_path: edit.file, content: edit.newString }, { cwd: dir })
        : await tool.execute(
            { file_path: edit.file, old_string: edit.oldString, new_string: edit.newString, ...(edit.replaceAll ? { replace_all: true } : {}) },
            { cwd: dir },
          );
    return !result.isError;
  } catch {
    return false;
  }
}
