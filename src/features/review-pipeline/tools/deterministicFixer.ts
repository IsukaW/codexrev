/**
 * Codexrev — Feature 2 (review-pipeline) deterministic fixer.
 *
 * Regex-based patches for known TypeScript compiler error codes, tried
 * BEFORE the LLM-based `editGenerator.ts` in the Breaker-Builder loop
 * (Phase 8). Only the Build role's findings carry a `TS\d+` code in
 * their description (`build.ts`'s `${toolLabel} ${code}: ${message}`
 * format), so this only ever fires for Build findings — everything
 * else falls straight through to the LLM path, which is correct: these
 * three codes are narrow, well-understood, mechanical fixes; nothing
 * else in the six-role contract is safe to pattern-match this way.
 *
 * Seed codes (Section 2, "TS7006/TS2307/TS2339 to start" — extend the
 * list as needed, logging any new code added to the Decision Log):
 *   TS7006 — implicit 'any' parameter → add an explicit ': any'.
 *   TS2307 — cannot find module (relative, no extension) → append
 *            '.js', matching this repo's own NodeNext/ESM convention
 *            (and most modern TS project configs) requiring explicit
 *            extensions on relative imports.
 *   TS2339 — property does not exist, WITH a compiler-supplied
 *            "Did you mean 'X'?" suggestion → apply that exact
 *            suggestion. Without a "Did you mean" hint, TS2339 is not
 *            safe to guess at, so no fix is returned.
 *
 * Each handler returns an `{oldString, newString}` pair scoped to a
 * single source line (not a full rewritten file) — the caller applies
 * it via the shared `edit` tool (`src/tools/builtin.ts`), never
 * writing files directly, per Phase 8's reuse instruction.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Finding } from '../roles/roleContract.js';

export interface DeterministicFixResult {
  readonly file: string;
  readonly oldString: string;
  readonly newString: string;
  readonly description: string;
}

type Handler = (finding: Finding, line: string) => DeterministicFixResult | null;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fixImplicitAny(finding: Finding, line: string): DeterministicFixResult | null {
  const m = finding.description.match(/Parameter '([^']+)' implicitly has an 'any' type/);
  if (!m) return null;
  const paramName = m[1];
  // Negative lookahead avoids re-matching a parameter that's already typed
  // (e.g. a previous fix attempt, or a same-named param elsewhere on the line).
  const re = new RegExp(`\\b${escapeRegExp(paramName)}\\b(?!\\s*:)`);
  if (!re.test(line)) return null;
  return {
    file: finding.file,
    oldString: line,
    newString: line.replace(re, `${paramName}: any`),
    description: `Added an explicit ": any" to parameter '${paramName}' (TS7006).`,
  };
}

function fixMissingModuleExtension(finding: Finding, line: string): DeterministicFixResult | null {
  const m = finding.description.match(/Cannot find module '([^']+)'/);
  if (!m) return null;
  const spec = m[1];
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null; // only relative specifiers
  if (/\.[a-zA-Z]+$/.test(spec)) return null; // already has an extension — not this case
  const quoted = new RegExp(`(['"])${escapeRegExp(spec)}\\1`);
  if (!quoted.test(line)) return null;
  return {
    file: finding.file,
    oldString: line,
    newString: line.replace(quoted, (_full, q: string) => `${q}${spec}.js${q}`),
    description: `Appended a ".js" extension to the relative import "${spec}" (TS2307).`,
  };
}

function fixDidYouMeanTypo(finding: Finding, line: string): DeterministicFixResult | null {
  const m = finding.description.match(/Property '([^']+)' does not exist on type '[^']*'\.\s*Did you mean '([^']+)'\?/);
  if (!m) return null;
  const [, wrong, suggested] = m;
  const re = new RegExp(`\\.${escapeRegExp(wrong)}\\b`);
  if (!re.test(line)) return null;
  return {
    file: finding.file,
    oldString: line,
    newString: line.replace(re, `.${suggested}`),
    description: `Replaced '.${wrong}' with the compiler-suggested '.${suggested}' (TS2339).`,
  };
}

const TS_CODE_HANDLERS: Readonly<Record<string, Handler>> = {
  TS7006: fixImplicitAny,
  TS2307: fixMissingModuleExtension,
  TS2339: fixDidYouMeanTypo,
};

/** TS codes this fixer knows how to attempt — for logging/reporting, not a guarantee of success. */
export const SUPPORTED_TS_CODES: readonly string[] = Object.keys(TS_CODE_HANDLERS);

/** Extracts a `TSxxxx` code from a Build-role finding's description, if present. */
export function extractTsCode(finding: Finding): string | null {
  const m = finding.description.match(/\b(TS\d{4,5})\b/);
  return m ? m[1] : null;
}

/**
 * Attempts a deterministic fix for `finding`. Returns `null` when the
 * finding isn't a recognized TS code, the finding's line can't be read,
 * or the handler can't confidently produce a fix — the caller should
 * fall through to `editGenerator.ts` in every `null` case.
 */
export async function tryDeterministicFix(finding: Finding, cwd: string): Promise<DeterministicFixResult | null> {
  const code = extractTsCode(finding);
  if (!code) return null;
  const handler = TS_CODE_HANDLERS[code];
  if (!handler) return null;

  const full = path.isAbsolute(finding.file) ? finding.file : path.join(cwd, finding.file);
  let content: string;
  try {
    content = await fs.readFile(full, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const lineIdx = finding.lineStart - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  return handler(finding, lines[lineIdx]);
}
