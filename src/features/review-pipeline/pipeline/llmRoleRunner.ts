/**
 * Codexrev — Feature 2 (review-pipeline) shared LLM-role runner.
 *
 * Five of the six roles (`ba`, `dev`, `sec`, `qa`, `pm` — everything but
 * the deterministic `build` role) are "call the model, get JSON back" —
 * but as of this revision, the model can call read-only tools
 * (`read_file`, `glob`, `grep`, reused from `src/tools/builtin.ts`) on
 * its way there. The diff alone can't show a role that a changed
 * function is called from three other files, or that a "fix" for file A
 * would break file B — those files aren't in the diff at all. Giving
 * roles the same read-only tool access the Ask/Plan modes already have
 * (`core/modes.ts`'s `filterReadOnlyTools` covers the same three tools)
 * lets them actually check before verdicting, instead of guessing from
 * a diff in isolation.
 *
 * This module is the one place that:
 *   - formats the diff + accumulated context into a prompt,
 *   - appends the shared JSON-contract instructions (identical wording
 *     for every role, so the model always sees the same schema),
 *   - runs the tool-call loop against `ILLMProvider` (bounded by
 *     `MAX_TOOL_TURNS` — a role exploring the repo is still a single
 *     scan step, not an open-ended agent session),
 *   - extracts + validates the final JSON reply against `roleContract.ts`,
 *     with exactly one corrective retry (`requestCorrectiveJson`) if that
 *     fails — needed in practice because some local models (seen with an
 *     Ollama-served model) don't reliably use real structured tool
 *     calling and instead write out a fake tool call as plain text (e.g.
 *     Llama's `<tool_call><function=...>` chat-template convention),
 *     which lands as ordinary response text rather than a real tool call.
 *
 * Keeping this in one module (instead of duplicating prompt/parsing/
 * tool-loop logic across `roles/ba.ts`, `dev.ts`, etc.) is exactly the
 * kind of duplication the Dev role itself would flag.
 */

import {
  ROLE_LABELS,
  ROLE_ORDER,
  RoleContractError,
  validateRoleOutput,
  type RoleId,
  type RoleOutput,
} from '../roles/roleContract.js';
import { builtinTools } from '../../../tools/builtin.js';
import type { Tool } from '../../../tools/registry.js';
import type { ContentPart, Message, TextPart, ToolCallPart, ToolDeclaration } from '../../../core/types.js';
import type { DiffFile, ParsedDiff } from './diffReader.js';
import type { RoleRunContext } from './roleRunContext.js';

// ── Read-only tool access ────────────────────────────────────────────

/** Same three tools `core/modes.ts`'s Ask/Plan modes are restricted to — read-only, no repo mutation. */
const ROLE_TOOL_NAMES = ['read_file', 'glob', 'grep'] as const;

/** Hard cap on tool round-trips per role, per scan — a review step, not an open-ended agent session. */
const MAX_TOOL_TURNS = 6;

function roleTools(): Tool[] {
  const names: readonly string[] = ROLE_TOOL_NAMES;
  return builtinTools().filter((t) => names.includes(t.name));
}

function roleToolDeclarations(): readonly ToolDeclaration[] {
  return roleTools().map((t) => t.declaration);
}

// ── Diff / context formatting ───────────────────────────────────────

/**
 * Renders a `ParsedDiff` with explicit per-line numbers computed by
 * `diffReader.ts`, instead of leaving the model to count lines from
 * raw `@@ -a,b +c,d @@` hunk headers. Findings' `lineStart`/`lineEnd`
 * feed Phase 7's change-coverage map, so precision here matters more
 * than it would for a purely illustrative diff view.
 */
export function formatDiffForPrompt(diff: ParsedDiff): string {
  if (diff.files.length === 0) return '(no changes)';

  const parts: string[] = [];
  for (const file of diff.files) {
    parts.push(formatFileForPrompt(file));
  }
  return parts.join('\n\n');
}

function formatFileForPrompt(file: DiffFile): string {
  const header =
    file.status === 'renamed'
      ? `File: ${file.oldPath} → ${file.path} (renamed)`
      : `File: ${file.path} (${file.status})`;

  const hunkLines: string[] = [];
  for (const hunk of file.hunks) {
    hunkLines.push(`  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        hunkLines.push(`  [+${line.newLineNumber}] + ${line.content}`);
      } else if (line.type === 'del') {
        hunkLines.push(`  [-${line.oldLineNumber}] - ${line.content}`);
      } else {
        hunkLines.push(`  [ ${line.newLineNumber}]   ${line.content}`);
      }
    }
  }
  return [header, ...hunkLines].join('\n');
}

/** Renders every prior role's completed output, in the order they ran — the "context accumulation." */
export function formatPriorContextForPrompt(ctx: RoleRunContext): string {
  const completed = ctx.aggregator.completedRoles;
  if (completed.length === 0) return '(no prior role findings yet — you are the first role to run)';

  const parts: string[] = [];
  for (const role of completed) {
    const output = ctx.aggregator.getRoleOutput(role);
    if (!output) continue;
    parts.push(formatRoleOutputForPrompt(role, output));
  }
  return parts.join('\n\n');
}

function formatRoleOutputForPrompt(role: RoleId, output: RoleOutput): string {
  const lines = [`### ${ROLE_LABELS[role]} — verdict: ${output.verdict} (confidence ${output.confidence})`, output.summary];
  if (output.findings.length === 0) {
    lines.push('(no findings)');
  } else {
    for (const f of output.findings) {
      const cwe = f.cwe ? ` (${f.cwe})` : '';
      lines.push(`- [${f.severity}] ${f.file}:${f.lineStart}-${f.lineEnd}${cwe} — ${f.description}`);
    }
  }
  return lines.join('\n');
}

// ── Shared JSON-contract instructions ───────────────────────────────

/**
 * Appended to every LLM role's system prompt. Identical wording across
 * roles keeps the contract predictable for the model and for
 * `validateRoleOutput()`. The plain-English requirement is the
 * proposal's Usability NFR — this is where it's enforced at the prompt
 * level, not just in report rendering later.
 */
export function roleContractInstructions(role: RoleId): string {
  return `
You have read-only tools available: read_file, glob, and grep. Use them when the diff alone isn't enough to judge a change safely — for example, to check where a changed function is called from elsewhere in the repo, to see the full definition of a type/class only partially shown in the diff, or to check whether a change could break a file that ISN'T part of this diff. Do not guess about code you haven't looked at when a quick read_file/grep would tell you for certain. Call tools as many times as you need (there is a turn limit, so be purposeful), then STOP calling tools and respond with ONLY the final JSON object described below — no further tool calls after that point.

You must respond with ONLY a single JSON object — no prose before or after it, no markdown code fence — matching exactly this shape:

{
  "role": "${role}",
  "verdict": "pass" | "flag" | "block",
  "findings": [
    {
      "id": "string, unique within your findings (e.g. "${role}-1")",
      "severity": "info" | "low" | "medium" | "high" | "critical",
      "cwe": "optional CWE reference, e.g. "CWE-89" — omit if not applicable",
      "file": "path to the affected file, exactly as shown in the diff",
      "lineStart": <integer, from the [n] / [+n] / [-n] markers shown in the diff>,
      "lineEnd": <integer, >= lineStart>,
      "description": "plain-English explanation a non-security developer can understand — no jargon without a one-line explanation",
      "suggestedFix": "optional — a concrete suggestion for how to fix this"
    }
  ],
  "summary": "one or two plain-English sentences summarizing your pass over the diff",
  "confidence": <number between 0 and 1>
}

Rules:
- "verdict" must be "block" if you found any finding you believe should stop this change from merging, "flag" if you have concerns worth a human look but nothing blocking, "pass" if you have no concerns.
- Only report findings that are actually visible in the diff shown to you. Use the exact line numbers shown in brackets in the diff (e.g. a line marked "[+42]" is line 42 in the new file).
- If you have zero findings, return "findings": [] and "verdict": "pass".
- Write "description" and "summary" in plain English a developer without a security background can follow.
`.trim();
}

// ── JSON extraction ─────────────────────────────────────────────────

export class LlmRoleResponseError extends RoleContractError {}

/**
 * Extracts a JSON object from an LLM's raw text reply. Tries a strict
 * parse first (the common case, since the prompt asks for JSON only),
 * then falls back to stripping a markdown code fence, then to the
 * outermost `{...}` span — models occasionally add a stray sentence
 * despite instructions not to.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  throw new LlmRoleResponseError(`could not extract a JSON object from the model's response: ${trimmed.slice(0, 200)}`);
}

function extractText(parts: readonly ContentPart[]): string {
  return parts
    .filter((p): p is TextPart => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

function extractToolCalls(parts: readonly ContentPart[]): ToolCallPart[] {
  return parts.filter((p): p is ToolCallPart => p.kind === 'tool_call');
}

/** Executes one tool call against the role's read-only tool set, never throwing — errors become a tool result the model can react to. */
async function executeRoleToolCall(call: ToolCallPart, tools: ReadonlyMap<string, Tool>, cwd: string): Promise<string> {
  const tool = tools.get(call.name);
  if (!tool) return `Error: unknown tool "${call.name}". Available tools: ${[...tools.keys()].join(', ')}.`;
  try {
    const result = await tool.execute(call.arguments, { cwd });
    const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    return result.isError ? `Error: ${output}` : output;
  } catch (err) {
    return `Error: ${(err as Error).message ?? String(err)}`;
  }
}

interface ToolLoopResult {
  readonly text: string;
  /** Full conversation so far, including the final assistant turn — reused for the corrective retry in `runLlmRole` if `text` isn't valid JSON. */
  readonly messages: Message[];
}

/**
 * Runs the tool-call loop: sends `messages` + the role's read-only
 * tools, executes any tool calls the model makes and feeds the results
 * back, and returns the model's final text once it stops calling tools
 * (or `MAX_TOOL_TURNS` is hit, in which case one last no-tools call
 * forces a final answer).
 */
async function runToolLoop(systemInstruction: string, initialUserPrompt: string, ctx: RoleRunContext): Promise<ToolLoopResult> {
  const tools = new Map(roleTools().map((t) => [t.name, t]));
  const declarations = roleToolDeclarations();
  const messages: Message[] = [{ role: 'user', parts: [{ kind: 'text', text: initialUserPrompt }] }];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const res = await ctx.llm.generate({
      model: ctx.model,
      systemInstruction,
      messages,
      tools: declarations,
      temperature: 0.2,
    });

    const toolCalls = extractToolCalls(res.message.parts);
    messages.push({ role: 'assistant', parts: res.message.parts });
    if (toolCalls.length === 0) {
      return { text: extractText(res.message.parts), messages };
    }

    for (const call of toolCalls) {
      const text = await executeRoleToolCall(call, tools, ctx.cwd);
      messages.push({
        role: 'tool',
        parts: [{ kind: 'tool_result', toolCallId: call.id, name: call.name, content: [{ kind: 'text', text }] }],
      });
    }
  }

  // Turn budget exhausted — ask once more without `tools` so the model
  // must answer from what it already gathered, rather than looping forever.
  const finalRes = await ctx.llm.generate({ model: ctx.model, systemInstruction, messages, temperature: 0.2 });
  messages.push({ role: 'assistant', parts: finalRes.message.parts });
  return { text: extractText(finalRes.message.parts), messages };
}

/**
 * One corrective retry when the model's "final" text isn't valid JSON —
 * most often because a model without reliable native tool-calling wrote
 * out a fake tool call as plain text instead of using the real
 * `tool_calls` mechanism (seen in practice with some local/Ollama-served
 * models using a Llama-style `<tool_call>...</tool_call>` chat-template
 * convention that never reaches the API as a structured call). Rather
 * than pattern-matching every local model's own hallucinated tool-call
 * syntax, this just tells the model plainly what went wrong and asks
 * again with `tools` omitted, forcing a real answer. Exactly one retry —
 * if this also fails to parse, the caller's error is the real error.
 */
async function requestCorrectiveJson(
  systemInstruction: string,
  messages: readonly Message[],
  ctx: RoleRunContext,
  parseErrorMessage: string,
): Promise<unknown> {
  const retryMessages: Message[] = [
    ...messages,
    {
      role: 'user',
      parts: [
        {
          kind: 'text',
          text: `Your previous response could not be parsed (${parseErrorMessage}). Do not call any tools and do not describe a tool call as text — respond with ONLY the JSON object described earlier, nothing else.`,
        },
      ],
    },
  ];
  const res = await ctx.llm.generate({ model: ctx.model, systemInstruction, messages: retryMessages, temperature: 0.1 });
  return extractJson(extractText(res.message.parts));
}

// ── The shared runner ────────────────────────────────────────────────

/**
 * Calls the model for one LLM-backed role and returns a validated
 * `RoleOutput`. `roleSystemPrompt` is that role's own lens (e.g. the Sec
 * role's OWASP/CVSS framing) — this function appends the shared JSON
 * contract instructions on top of it, and runs the read-only tool loop
 * (`read_file`/`glob`/`grep`) so the role can inspect the wider repo,
 * not just the diff, before verdicting.
 */
export async function runLlmRole(
  role: RoleId,
  roleSystemPrompt: string,
  ctx: RoleRunContext,
): Promise<RoleOutput> {
  const systemInstruction = `${roleSystemPrompt}\n\n${roleContractInstructions(role)}`;

  const userPrompt = `
## Diff under review (ref: ${ctx.diff.ref})

${formatDiffForPrompt(ctx.diff)}

## Requirements document (URS)

${ctx.urs ?? '(none provided)'}

## Findings from earlier roles in this review

${formatPriorContextForPrompt(ctx)}
`.trim();

  const { text, messages } = await runToolLoop(systemInstruction, userPrompt, ctx);
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    if (!(err instanceof LlmRoleResponseError)) throw err;
    json = await requestCorrectiveJson(systemInstruction, messages, ctx, err.message);
  }
  const parsed = validateRoleOutput(json);

  if (parsed.role !== role) {
    throw new LlmRoleResponseError(
      `expected role "${role}" but the model returned output for role "${parsed.role}"`,
    );
  }

  return parsed;
}

/** Re-exported for role files that want the fixed execution order without a second import. */
export { ROLE_ORDER };
