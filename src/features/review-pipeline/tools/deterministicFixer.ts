/**
 * Regex patches for known TS compiler error codes, tried before the LLM
 * editGenerator in the Breaker-Builder loop. Only Build-role findings carry
 * a TS\d+ code, so this never fires for anything else.
 *
 * Handled so far: TS7006 (implicit any param, add ": any"), TS2307 (missing
 * relative import extension, append ".js" per our NodeNext/ESM setup), and
 * TS2339 only when the compiler gives a "Did you mean 'X'?" hint — without
 * that hint it's not safe to guess.
 *
 * Each handler returns an {oldString, newString} pair for one line, applied
 * via the shared edit tool rather than writing the file directly.
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
  // negative lookahead so we don't re-match a param that's already typed
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

// returns null if the code isn't recognized, the line can't be read, or the
// handler isn't confident — caller falls through to editGenerator.ts either way
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
