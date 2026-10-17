// Per-file syntax checks for projects with no build configuration (a folder of Python scripts,
// plain Java compiled by hand, a PHP site, shell scripts...). Only the files the change touched
// are checked, each with the language's own checker:
//
//   .js .mjs .cjs     node --check
//   .py               python3 compile() — not py_compile, which writes __pycache__ into the project
//   .java             javac on the changed files, with -sourcepath set from their package
//                     declarations so classes they use from the project resolve too
//   .rb               ruby -c
//   .php              php -l
//   .sh .bash         bash -n
//   .go               gofmt -e (a Go file outside a module; with go.mod, go vet runs instead)
//   .c / .cc .cpp     cc / c++ -fsyntax-only — reported as warnings (flag) only: without the
//                     build's include paths and defines, an error may be the environment's
//
// What cannot be checked is said, never passed silently: a file whose checker is not installed
// is "could not run", and a file in a language with no built-in checker (TypeScript without a
// tsconfig, Kotlin, C#...) is listed as not verified. Both make the Build role flag, not pass.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseGoVet,
  parseJavac,
  parseNodeCheck,
  type CompilerDiagnostic,
} from './parsers.js';
import { onPath, runToolchainCommand } from './run.js';

export interface SyntaxDiagnostic extends CompilerDiagnostic {
  /** the checker that reported it, e.g. "node --check" */
  readonly label: string;
}

export interface SyntaxCheckReport {
  /** one entry per checker that ran: how many files, how many errors */
  readonly checks: ReadonlyArray<{ readonly label: string; readonly files: number; readonly errors: number }>;
  readonly diagnostics: readonly SyntaxDiagnostic[];
  /** a checker that applies but is not installed, or failed in a way that says nothing about the code */
  readonly couldNotRun: ReadonlyArray<{ readonly label: string; readonly files: readonly string[]; readonly reason: string }>;
  /** changed source files in a language with no built-in checker */
  readonly unverified: readonly string[];
  /** caveats about what a check could not see (e.g. Java libraries that are not available) */
  readonly notes: readonly string[];
}

export interface SyntaxCheckOptions {
  readonly sandbox?: boolean;
  /** per-file timeout (javac gets several times this, it checks the files as one batch) */
  readonly timeoutMs?: number;
}

const PER_FILE_TIMEOUT_MS = 20_000;
const MAX_FILES_PER_CHECKER = 200;

// source files nothing here can check; listed so the summary says so instead of passing them
const UNCHECKED_SOURCE = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.jsx', '.vue', '.svelte', '.kt', '.kts', '.scala', '.groovy', '.swift', '.cs', '.fs',
  '.vb', '.rs', '.dart', '.lua', '.ex', '.exs', '.erl', '.clj', '.hs', '.ml', '.r', '.jl', '.m', '.mm', '.pl', '.zig',
]);

// ── parsers for the checkers' own output (captured from the real tools) ────

// Python traceback; the frame that names the file is the one with the line:
//   File "bad.py", line 1
//     def f(:
//   SyntaxError: invalid syntax
export function parsePythonCompile(output: string, file: string): CompilerDiagnostic[] {
  const error = /^(\w*(?:Error|Warning)):\s*(.*)$/m.exec(output.split(/\r?\n/).reverse().join('\n'));
  if (!error) return [];
  const frames = [...output.matchAll(/File "([^"]+)", line (\d+)/g)];
  const own = frames.reverse().find((m) => m[1] !== '<string>');
  return [{ file, line: own ? parseInt(own[2]!, 10) : 1, severity: 'error', message: `${error[1]}: ${error[2]}` }];
}

// ruby -c: "bad.rb:3: syntax error, unexpected end-of-input" (Ruby 3.4's prism: "ruby: bad.rb:3: syntax errors found (SyntaxError)")
export function parseRubyCheck(output: string, file: string): CompilerDiagnostic[] {
  const m = /(?:^|\s)(\S+\.rb):(\d+):\s*(.*)$/m.exec(output);
  return m ? [{ file, line: parseInt(m[2]!, 10), severity: 'error', message: m[3]!.trim() }] : [];
}

// php -l: "PHP Parse error:  syntax error, unexpected end of file in bad.php on line 3"
export function parsePhpLint(output: string, file: string): CompilerDiagnostic[] {
  const m = /(?:PHP )?(?:Parse|Fatal) error:\s*(.*?) in \S.*? on line (\d+)/.exec(output);
  return m ? [{ file, line: parseInt(m[2]!, 10), severity: 'error', message: m[1]!.trim() }] : [];
}

// bash -n: "bad.sh: line 3: syntax error: unexpected end of file"
export function parseBashCheck(output: string, file: string): CompilerDiagnostic[] {
  const results: CompilerDiagnostic[] = [];
  for (const m of output.matchAll(/^.+?: line (\d+): (.*)$/gm)) results.push({ file, line: parseInt(m[1]!, 10), severity: 'error', message: m[2]!.trim() });
  return results;
}

// gofmt -e: "bad.go:4:1: expected operand, found '}'" — one per location, gofmt repeats itself
export function parseGofmt(output: string, file: string): CompilerDiagnostic[] {
  const seen = new Set<number>();
  return parseGoVet(output)
    .filter((d) => (seen.has(d.line) ? false : (seen.add(d.line), true)))
    .map((d) => ({ ...d, file }));
}

// cc/c++ -fsyntax-only: "bad.c:1:22: error: expected ';' after return statement" (also "fatal error:")
export function parseClang(output: string, file: string): CompilerDiagnostic[] {
  const results: CompilerDiagnostic[] = [];
  for (const m of output.matchAll(/^(.+?):(\d+):\d+:\s*(fatal error|error|warning):\s*(.*)$/gm)) {
    if (path.basename(m[1]!) !== path.basename(file)) continue; // from an included header: not this file's line
    results.push({ file, line: parseInt(m[2]!, 10), severity: m[3] === 'warning' ? 'warning' : 'error', message: m[4]!.trim() });
  }
  return results;
}

// ── checkers ────────────────────────────────────────────────────────────────

interface PerFileChecker {
  readonly label: string;
  readonly extensions: readonly string[];
  /** the program that must be installed */
  readonly tool: () => Promise<string | null>;
  readonly command: (tool: string, file: string) => string;
  readonly parse: (output: string, file: string) => CompilerDiagnostic[];
  /** the environment, not the code, is the likely cause of this output: the file counts as not checked */
  readonly environmental?: (output: string) => boolean;
  /** report errors as warnings: the checker cannot see everything the real build would provide */
  readonly advisory?: boolean;
}

const q = (s: string): string => JSON.stringify(s);
const firstOnPath = (...names: string[]) => async (): Promise<string | null> => {
  for (const n of names) if (await onPath(n)) return n;
  return null;
};

const PY_COMPILE = "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')";

const PER_FILE: readonly PerFileChecker[] = [
  { label: 'node --check', extensions: ['.js', '.mjs', '.cjs'], tool: firstOnPath('node'), command: (t, f) => `${t} --check ${q(f)}`, parse: parseNodeCheck },
  { label: 'python compile', extensions: ['.py'], tool: firstOnPath('python3', 'python'), command: (t, f) => `${t} -c ${q(PY_COMPILE)} ${q(f)}`, parse: parsePythonCompile },
  { label: 'ruby -c', extensions: ['.rb'], tool: firstOnPath('ruby'), command: (t, f) => `${t} -c ${q(f)}`, parse: parseRubyCheck },
  { label: 'php -l', extensions: ['.php'], tool: firstOnPath('php'), command: (t, f) => `${t} -l ${q(f)}`, parse: parsePhpLint },
  { label: 'bash -n', extensions: ['.sh', '.bash'], tool: firstOnPath('bash'), command: (t, f) => `${t} -n ${q(f)}`, parse: parseBashCheck },
  { label: 'gofmt -e', extensions: ['.go'], tool: firstOnPath('gofmt'), command: (t, f) => `${t} -e -l ${q(f)}`, parse: parseGofmt },
  {
    label: 'cc -fsyntax-only',
    extensions: ['.c'],
    tool: firstOnPath('cc', 'gcc', 'clang'),
    command: (t, f) => `${t} -fsyntax-only ${q(f)}`,
    parse: parseClang,
    environmental: (o) => /fatal error: .*(file not found|No such file)/i.test(o),
    advisory: true,
  },
  {
    label: 'c++ -fsyntax-only',
    extensions: ['.cc', '.cpp', '.cxx'],
    tool: firstOnPath('c++', 'g++', 'clang++'),
    command: (t, f) => `${t} -std=c++17 -fsyntax-only ${q(f)}`,
    parse: parseClang,
    environmental: (o) => /fatal error: .*(file not found|No such file)/i.test(o),
    advisory: true,
  },
];

// javac needs the package's root, not the file's folder: src/demo/A.java declaring `package demo;` → src
async function javaSourceRoot(root: string, file: string): Promise<string> {
  const dir = path.posix.dirname(file);
  const text = await fs.readFile(path.join(root, file), 'utf-8').catch(() => '');
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
  if (!pkg) return dir;
  const suffix = pkg.replace(/\./g, '/');
  if (dir === suffix) return '.';
  return dir.endsWith(`/${suffix}`) ? dir.slice(0, -suffix.length - 1) : dir;
}

// a missing library, as javac says it: the code may be fine, the dependency just isn't here
const MISSING_LIBRARY = /^package [\w.]+ does not exist/;
const UNRESOLVED = /^(package [\w.]+ does not exist|cannot find symbol|cannot access )/;

async function checkJava(root: string, files: readonly string[], opts: SyntaxCheckOptions): Promise<{ diagnostics: CompilerDiagnostic[]; couldNotRun?: string; note?: string }> {
  const javac = await firstOnPath('javac')();
  if (!javac) return { diagnostics: [], couldNotRun: 'javac is not installed (install a JDK, or set toolchain.build in .codexrev/settings.json).' };
  const roots = [...new Set(await Promise.all(files.map((f) => javaSourceRoot(root, f))))];
  const jars = (await Promise.all(['lib', 'libs'].map(async (d) => ((await fs.stat(path.join(root, d)).catch(() => null))?.isDirectory() ? `${d}/*` : null)))).filter(
    (d): d is string => d !== null,
  );
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-javac-'));
  try {
    const command = [
      javac,
      '-proc:none -implicit:none -nowarn -Xlint:none -encoding UTF-8',
      `-d ${q(out)}`,
      `-sourcepath ${q(roots.join(path.delimiter))}`,
      ...(jars.length > 0 ? [`-cp ${q(jars.join(path.delimiter))}`] : []),
      ...files.map(q),
    ].join(' ');
    const r = await runToolchainCommand(command, root, { timeoutMs: (opts.timeoutMs ?? PER_FILE_TIMEOUT_MS) * 6, sandbox: opts.sandbox });
    if (r.timedOut) return { diagnostics: [], couldNotRun: 'javac timed out.' };
    const diagnostics = parseJavac(r.output, root);
    if (r.code !== 0 && diagnostics.length === 0) return { diagnostics: [], couldNotRun: (r.output.trim() || 'javac failed with no output').slice(-300) };
    // A plain-Java project's libraries (Spring, JUnit...) are usually not on this machine's classpath. Then
    // "cannot find symbol" says nothing about the code, so only the errors that do not depend on them count.
    if (!diagnostics.some((d) => MISSING_LIBRARY.test(d.message))) return { diagnostics };
    const kept = diagnostics.filter((d) => !UNRESOLVED.test(d.message));
    return {
      diagnostics: kept,
      note: `javac could not resolve ${diagnostics.length - kept.length} reference(s) to libraries that are not available here, so it checked syntax and in-project types only — set toolchain.build (e.g. your mvn/gradle/javac command with the classpath) for a full check.`,
    };
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
}

/**
 * Syntax-check the changed source files of a project with no build configuration.
 * Null when the change touches no source file at all (docs, config...), so there is nothing to check.
 */
export async function runSyntaxChecks(root: string, changedFiles: readonly string[], opts: SyntaxCheckOptions = {}): Promise<SyntaxCheckReport | null> {
  const files = changedFiles.map((f) => f.replace(/\\/g, '/'));
  const ext = (f: string): string => path.posix.extname(f).toLowerCase();
  const checks: Array<{ label: string; files: number; errors: number }> = [];
  const diagnostics: SyntaxDiagnostic[] = [];
  const couldNotRun: Array<{ label: string; files: string[]; reason: string }> = [];
  const notes: string[] = [];
  let relevant = false;

  for (const checker of PER_FILE) {
    const mine = files.filter((f) => checker.extensions.includes(ext(f))).slice(0, MAX_FILES_PER_CHECKER);
    if (mine.length === 0) continue;
    relevant = true;
    const tool = await checker.tool();
    if (!tool) {
      couldNotRun.push({ label: checker.label, files: mine, reason: `${checker.label.split(' ')[0]} is not installed.` });
      continue;
    }
    let errors = 0;
    const blind: string[] = [];
    for (const file of mine) {
      const r = await runToolchainCommand(checker.command(tool, file), root, { timeoutMs: opts.timeoutMs ?? PER_FILE_TIMEOUT_MS, sandbox: opts.sandbox });
      if (r.code === 0 && !r.output.includes('warning:')) continue;
      if (r.timedOut || checker.environmental?.(r.output)) {
        blind.push(file);
        continue;
      }
      const found = checker.parse(r.output, file);
      if (found.length === 0) {
        if (r.code !== 0) blind.push(file); // failed without a diagnostic we understand: unknown, not a defect
        continue;
      }
      for (const d of found) {
        const severity = checker.advisory ? 'warning' : d.severity;
        if (severity === 'error') errors++;
        diagnostics.push({ ...d, severity, label: checker.label });
      }
    }
    checks.push({ label: checker.label, files: mine.length, errors });
    if (blind.length > 0) {
      couldNotRun.push({ label: checker.label, files: blind, reason: checker.environmental ? 'its includes or dependencies are not available here.' : 'the checker failed without a usable diagnostic.' });
    }
  }

  const java = files.filter((f) => ext(f) === '.java').slice(0, MAX_FILES_PER_CHECKER);
  if (java.length > 0) {
    relevant = true;
    const r = await checkJava(root, java, opts);
    if (r.couldNotRun) couldNotRun.push({ label: 'javac', files: java, reason: r.couldNotRun });
    else checks.push({ label: 'javac', files: java.length, errors: r.diagnostics.filter((d) => d.severity === 'error').length });
    diagnostics.push(...r.diagnostics.map((d) => ({ ...d, label: 'javac' })));
    if (r.note) notes.push(r.note);
  }

  const unverified = files.filter((f) => UNCHECKED_SOURCE.has(ext(f)));
  if (!relevant && unverified.length === 0) return null;
  return { checks, diagnostics, couldNotRun, unverified, notes };
}
