// LLM fallback for findings deterministicFixer.ts can't handle (which is most
// of them — the deterministic path only covers three narrow TS codes). Gives
// the model a +/-30 line window around the finding and asks for a minimal
// string-replacement edit. Reuses llmRoleRunner's extractJson for parsing.
// Never touches disk itself, just returns {oldString, newString} for the caller
// to apply via the edit tool.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractJson, LlmRoleResponseError } from './llmRoleRunner.js';
import type { Finding } from '../roles/roleContract.js';
import type { ILLMProvider } from './illmProvider.js';

const CONTEXT_WINDOW_LINES = 30;

export interface EditGeneratorResult {
  readonly file: string;
  readonly oldString: string;
  readonly newString: string;
  readonly description: string;
}

export interface EditGeneratorContext {
  readonly llm: ILLMProvider;
  readonly model: string;
  readonly cwd: string;
}

function buildContextWindow(content: string, lineStart: number, lineEnd: number): { text: string; from: number; to: number } {
  const lines = content.split('\n');
  const from = Math.max(1, lineStart - CONTEXT_WINDOW_LINES);
  const to = Math.min(lines.length, lineEnd + CONTEXT_WINDOW_LINES);
  const numbered = lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}: ${l}`)
    .join('\n');
  return { text: numbered, from, to };
}

const SYSTEM_PROMPT = `
You are an automated code-fixing assistant working inside a code review pipeline. You will be given one finding from a review and a window of the surrounding source file (with line numbers). Produce the SMALLEST possible string-replacement edit that addresses the finding, without changing unrelated code, formatting, or behavior beyond what the finding requires.

Respond with ONLY a JSON object, no prose before or after it, matching exactly this shape:

{
  "oldString": "the exact, verbatim substring to replace — must appear in the shown source EXACTLY ONCE, and be as short as possible while remaining unambiguous",
  "newString": "the replacement text",
  "description": "one plain-English sentence describing the fix"
}

If you cannot confidently produce a safe, minimal fix from the context shown, respond with:
{ "oldString": null, "newString": null, "description": "why not, in plain English" }

Do not include line-number prefixes in "oldString" or "newString" — those are only shown to you for orientation, they are not part of the actual file content.
`.trim();

// Returns null if the model declines, its JSON doesn't parse, or oldString
// doesn't actually appear exactly once in the real file (sanity check before
// the edit tool ever sees it).
export async function generateEdit(finding: Finding, ctx: EditGeneratorContext): Promise<EditGeneratorResult | null> {
  const full = path.isAbsolute(finding.file) ? finding.file : path.join(ctx.cwd, finding.file);
  let content: string;
  try {
    content = await fs.readFile(full, 'utf-8');
  } catch {
    return null;
  }

  const window = buildContextWindow(content, finding.lineStart, finding.lineEnd);

  const userPrompt = `
## Finding

Severity: ${finding.severity}
File: ${finding.file}
Lines: ${finding.lineStart}-${finding.lineEnd}
${finding.cwe ? `CWE: ${finding.cwe}\n` : ''}Description: ${finding.description}
${finding.suggestedFix ? `Suggested fix (from the reviewer): ${finding.suggestedFix}\n` : ''}

## Source context (lines ${window.from}-${window.to} of ${finding.file})

${window.text}
`.trim();

  const res = await ctx.llm.generate({
    model: ctx.model,
    systemInstruction: SYSTEM_PROMPT,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: userPrompt }] }],
    temperature: 0.1,
  });

  const text = res.message.parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    if (err instanceof LlmRoleResponseError) return null;
    throw err;
  }

  if (!isRecord(json)) return null;
  const oldString = json.oldString;
  const newString = json.newString;
  const description = json.description;

  if (typeof oldString !== 'string' || typeof newString !== 'string' || oldString.length === 0) {
    return null; // model declined, or gave a malformed response — either way, not fixable this round
  }

  // Safety check: oldString must appear exactly once in the real file —
  // otherwise applying it via the `edit` tool could silently patch the
  // wrong occurrence (the tool itself only checks "found at least once").
  const occurrences = content.split(oldString).length - 1;
  if (occurrences !== 1) return null;

  return {
    file: finding.file,
    oldString,
    newString,
    description: typeof description === 'string' && description.length > 0 ? description : 'LLM-generated fix.',
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
