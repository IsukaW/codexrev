/**
 * Build Analyst role. The only role that isn't an LLM call — it detects
 * the project's toolchain from marker files and shells out to the
 * matching checker (reuses the `shell` tool from builtin.ts), then
 * normalizes the output into `Finding[]` so the rest of the pipeline
 * doesn't need to know this role is different.
 *
 * Dispatch:
 *   tsconfig.json  → tsc
 *   go.mod         → go vet
 *   Cargo.toml     → cargo check
 *   pyproject.toml → mypy
 *
 * Polyglot repos can trip more than one marker — we run all of them and
 * pool the findings. Resolver gives Build failures their own weight
 * (0.4), separate from BA/Architect/Dev/QA/PM.
 *
 * Fallback for buildless JS projects: without any of the four markers
 * this used to just pass with no real check. Now it runs `node --check`
 * against the changed .js/.mjs/.cjs files (only what's in the diff, not
 * the whole repo). Syntax errors only, no type checking — a real TS
 * parser is out of scope here.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { builtinTools } from '../../../tools/builtin.js';
import type { Tool } from '../../../tools/registry.js';
import type { Finding, RoleOutput } from './roleContract.js';
import type { RoleRunContext } from '../pipeline/roleRunContext.js';

interface CompilerDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly code?: string;
}

interface BuildTarget {
  readonly marker: string;
  readonly toolLabel: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly parse: (output: string) => CompilerDiagnostic[];
}

export function parseTsc(output: string): CompilerDiagnostic[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    results.push({ file: m[1], line: parseInt(m[2], 10), severity: m[4] as 'error' | 'warning', message: m[6], code: m[5] });
  }
  return results;
}

export function parseGoVet(output: string): CompilerDiagnostic[] {
  const re = /^(.+?):(\d+):(\d+):\s*(.*)$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    if (m[1].startsWith('#')) continue; // package header lines from `go vet`, not a diagnostic
    results.push({ file: m[1], line: parseInt(m[2], 10), severity: 'error', message: m[4] });
  }
  return results;
}

export function parseCargoCheck(output: string): CompilerDiagnostic[] {
  const re = /^(.+?):(\d+):(\d+):\s*(error|warning)(\[[^\]]+\])?:\s*(.*)$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    results.push({
      file: m[1],
      line: parseInt(m[2], 10),
      severity: m[4] as 'error' | 'warning',
      message: m[6],
      ...(m[5] ? { code: m[5].slice(1, -1) } : {}),
    });
  }
  return results;
}

export function parseMypy(output: string): CompilerDiagnostic[] {
  const re = /^(.+?):(\d+)(?::\d+)?:\s*(error|warning):\s*(.*)$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    let message = m[4];
    let code: string | undefined;
    const codeMatch = message.match(/\s\[([\w-]+)\]$/);
    if (codeMatch) {
      code = codeMatch[1];
      message = message.slice(0, codeMatch.index).trim();
    }
    results.push({ file: m[1], line: parseInt(m[2], 10), severity: m[3] as 'error' | 'warning', message, ...(code ? { code } : {}) });
  }
  return results;
}

const JS_FALLBACK_EXTENSIONS: readonly string[] = ['.js', '.mjs', '.cjs'];

// node --check doesn't print a single-line "file:line: message" like the
// other tools — it dumps file:line, a caret pointer, then a SyntaxError
// line — so this gets its own parser instead of reusing tsc/cargo's shape.
export function parseNodeCheck(output: string, file: string): CompilerDiagnostic[] {
  if (!output.trim()) return [];
  const errorMatch = output.match(/^(\w*Error): (.*)$/m);
  if (!errorMatch) return [];
  const lineMatch = output.match(/:(\d+)$/m);
  const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
  return [{ file, line, severity: 'error', message: `${errorMatch[1]}: ${errorMatch[2]}` }];
}

// Returns null when there's no JS in the diff — caller falls back to a plain pass.
async function runNodeSyntaxFallback(
  ctx: RoleRunContext,
  shell: Tool,
): Promise<{ findings: Finding[]; toolSummary: string } | null> {
  const jsFiles = ctx.diff.files
    .filter((f) => f.status !== 'deleted')
    .map((f) => f.path)
    .filter((p) => JS_FALLBACK_EXTENSIONS.includes(path.extname(p)));

  if (jsFiles.length === 0) return null;

  const findings: Finding[] = [];
  let errorCount = 0;

  for (const file of jsFiles) {
    const result = await shell.execute({ command: `node --check ${JSON.stringify(file)}`, timeout: 15_000 }, { cwd: ctx.cwd });
    if (!result.isError) continue;

    const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    const diagnostics = parseNodeCheck(output, file);
    errorCount++;
    if (diagnostics.length > 0) {
      const d = diagnostics[0];
      findings.push({
        id: `build-${findings.length + 1}`,
        severity: 'high',
        file: d.file,
        lineStart: d.line,
        lineEnd: d.line,
        description: `node --check: ${d.message}`,
      });
    } else {
      // node --check failed but the output didn't match the expected
      // shape (e.g. node itself isn't on PATH) — flag it without
      // claiming a specific line number we don't actually have.
      findings.push({
        id: `build-${findings.length + 1}`,
        severity: 'medium',
        file,
        lineStart: 1,
        lineEnd: 1,
        description: `node --check reported a problem with ${file} but its output could not be parsed: ${(output.trim() || 'no output').slice(0, 200)}`,
      });
    }
  }

  return {
    findings,
    toolSummary: `node --check (fallback — no tsconfig.json/go.mod/Cargo.toml/pyproject.toml found): ${errorCount} error(s) across ${jsFiles.length} JS file(s) in the diff`,
  };
}

const TARGETS: readonly BuildTarget[] = [
  { marker: 'tsconfig.json', toolLabel: 'tsc', command: 'npx --no-install tsc --noEmit --pretty false', timeoutMs: 120_000, parse: parseTsc },
  { marker: 'go.mod', toolLabel: 'go vet', command: 'go vet ./...', timeoutMs: 120_000, parse: parseGoVet },
  { marker: 'Cargo.toml', toolLabel: 'cargo check', command: 'cargo check --message-format=short', timeoutMs: 180_000, parse: parseCargoCheck },
  { marker: 'pyproject.toml', toolLabel: 'mypy', command: 'mypy .', timeoutMs: 120_000, parse: parseMypy },
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runBuildRole(ctx: RoleRunContext): Promise<RoleOutput> {
  const detected: BuildTarget[] = [];
  for (const target of TARGETS) {
    if (await fileExists(path.join(ctx.cwd, target.marker))) detected.push(target);
  }

  const shell = builtinTools().find((t) => t.name === 'shell');

  if (detected.length === 0) {
    const fallback = shell ? await runNodeSyntaxFallback(ctx, shell) : null;
    if (fallback) {
      const hasErrors = fallback.findings.some((f) => f.severity === 'high');
      return {
        role: 'build',
        verdict: hasErrors ? 'block' : 'pass',
        findings: fallback.findings,
        summary: fallback.toolSummary,
        confidence: 1,
      };
    }
    return {
      role: 'build',
      verdict: 'pass',
      findings: [],
      summary:
        'No recognized build configuration found (tsconfig.json, go.mod, Cargo.toml, pyproject.toml), and no JS files in this diff to syntax-check — nothing for the Build role to check.',
      confidence: 1,
    };
  }

  if (!shell) {
    return {
      role: 'build',
      verdict: 'flag',
      findings: [
        {
          id: 'build-0',
          severity: 'medium',
          file: '.',
          lineStart: 1,
          lineEnd: 1,
          description: 'Internal error: the shell tool is unavailable, so the Build role could not run any compiler checks.',
        },
      ],
      summary: 'Build role could not run — shell tool unavailable.',
      confidence: 1,
    };
  }

  const findings: Finding[] = [];
  const toolSummaries: string[] = [];
  let sawExecFailure = false;

  for (const target of detected) {
    const result = await shell.execute({ command: target.command, timeout: target.timeoutMs }, { cwd: ctx.cwd });
    const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    const diagnostics = target.parse(output);

    if (result.isError && diagnostics.length === 0) {
      // The tool exited non-zero but produced nothing we recognize as a
      // diagnostic — most likely it isn't installed / reachable in this
      // environment. That's an infra gap, not evidence the code is broken.
      sawExecFailure = true;
      findings.push({
        id: `build-${findings.length + 1}`,
        severity: 'medium',
        file: target.marker,
        lineStart: 1,
        lineEnd: 1,
        description: `Could not run "${target.toolLabel}" in this environment: ${(output.trim() || 'command failed with no output').slice(0, 300)}.`,
      });
      toolSummaries.push(`${target.toolLabel}: could not run`);
      continue;
    }

    for (const d of diagnostics) {
      findings.push({
        id: `build-${findings.length + 1}`,
        severity: d.severity === 'error' ? 'high' : 'medium',
        file: d.file,
        lineStart: d.line,
        lineEnd: d.line,
        description: d.code ? `${target.toolLabel} ${d.code}: ${d.message}` : `${target.toolLabel}: ${d.message}`,
      });
    }
    const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
    const warnCount = diagnostics.filter((d) => d.severity === 'warning').length;
    toolSummaries.push(`${target.toolLabel}: ${errorCount} error(s), ${warnCount} warning(s)`);
  }

  const hasErrors = findings.some((f) => f.severity === 'high');
  const verdict: RoleOutput['verdict'] = hasErrors ? 'block' : sawExecFailure || findings.length > 0 ? 'flag' : 'pass';

  return {
    role: 'build',
    verdict,
    findings,
    summary: `Ran ${detected.length} build check(s): ${toolSummaries.join('; ')}.`,
    confidence: 1,
  };
}
