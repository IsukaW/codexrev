// Compiler/checker output → CompilerDiagnostic[]. One parser per output shape, not per
// language: javac's shape is shared by Maven-less Java and Gradle, mypy's by gcc/clang.
// Paths are made relative to the project root when the tool printed absolute ones, so a
// finding points at the same file the diff and the reviewers talk about.

import path from 'node:path';

export interface CompilerDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly code?: string;
}

export type DiagnosticParser = (output: string, cwd: string) => CompilerDiagnostic[];

function relativeTo(cwd: string, file: string): string {
  const cleaned = file.replace(/^file:\/\//, '');
  if (!path.isAbsolute(cleaned)) return cleaned;
  const rel = path.relative(cwd, cleaned);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  // /private/tmp vs /tmp and similar: compare without the macOS /private prefix
  const strip = (p: string): string => p.replace(/^\/private(?=\/)/, '');
  const alt = path.relative(strip(cwd), strip(cleaned));
  return !alt.startsWith('..') && !path.isAbsolute(alt) ? alt.split(path.sep).join('/') : cleaned;
}

// one diagnostic per location: tools repeat themselves (Maven prints every compile error twice,
// the second time with less detail), and the first, fullest report is the one worth keeping
function dedupe(diagnostics: CompilerDiagnostic[]): CompilerDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.file}|${d.line}|${d.severity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseTsc(output: string): CompilerDiagnostic[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    results.push({ file: m[1]!, line: parseInt(m[2]!, 10), severity: m[4] as 'error' | 'warning', message: m[6]!, code: m[5]! });
  }
  return results;
}

export function parseGoVet(output: string): CompilerDiagnostic[] {
  const re = /^(.+?):(\d+):(\d+):\s*(.*)$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    if (m[1]!.startsWith('#')) continue; // package header lines from `go vet`, not a diagnostic
    results.push({ file: m[1]!, line: parseInt(m[2]!, 10), severity: 'error', message: m[4]! });
  }
  return results;
}

export function parseCargoCheck(output: string): CompilerDiagnostic[] {
  const re = /^(.+?):(\d+):(\d+):\s*(error|warning)(\[[^\]]+\])?:\s*(.*)$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    results.push({
      file: m[1]!,
      line: parseInt(m[2]!, 10),
      severity: m[4] as 'error' | 'warning',
      message: m[6]!,
      ...(m[5] ? { code: m[5].slice(1, -1) } : {}),
    });
  }
  return results;
}

// also the shape of gcc/clang (`file:line:col: error: msg`)
export function parseMypy(output: string): CompilerDiagnostic[] {
  const re = /^(.+?):(\d+)(?::\d+)?:\s*(error|warning):\s*(.*)$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    let message = m[4]!;
    let code: string | undefined;
    const codeMatch = message.match(/\s\[([\w-]+)\]$/);
    if (codeMatch) {
      code = codeMatch[1];
      message = message.slice(0, codeMatch.index).trim();
    }
    results.push({ file: m[1]!, line: parseInt(m[2]!, 10), severity: m[3] as 'error' | 'warning', message, ...(code ? { code } : {}) });
  }
  return results;
}

// node --check doesn't print a single-line "file:line: message" like the
// other tools — it dumps file:line, a caret pointer, then a SyntaxError
// line — so this gets its own parser instead of reusing tsc/cargo's shape.
export function parseNodeCheck(output: string, file: string): CompilerDiagnostic[] {
  if (!output.trim()) return [];
  const errorMatch = output.match(/^(\w*Error): (.*)$/m);
  if (!errorMatch) return [];
  const lineMatch = output.match(/:(\d+)$/m);
  const line = lineMatch ? parseInt(lineMatch[1]!, 10) : 1;
  return [{ file, line, severity: 'error', message: `${errorMatch[1]}: ${errorMatch[2]}` }];
}

// javac's indented follow-up lines ("symbol: variable y", "location: class App") carry the
// part of the message that says WHAT is missing — kept, the source excerpt and caret are not
function withDetails(lines: readonly string[], start: number, message: string): string {
  const details: string[] = [];
  for (let i = start + 1; i < lines.length && details.length < 3; i++) {
    const raw = lines[i]!;
    const m = /^\s+(symbol|location|required|found|reason)\s*:\s*(.*)$/.exec(raw.replace(/^\[(ERROR|WARNING)\](?=\s)/, '')); // Maven's summary repeats them with its prefix
    if (m) details.push(`${m[1]}: ${m[2]!.trim()}`);
    else if (/^\S/.test(raw)) break; // indented source excerpt / caret lines are skipped; anything else ends this diagnostic
  }
  return details.length > 0 ? `${message} (${details.join(', ')})` : message;
}

// Maven (maven-compiler-plugin, also kotlin-maven-plugin):
//   [ERROR] /abs/src/main/java/demo/App.java:[3,20] cannot find symbol
//   [WARNING] /abs/src/main/java/demo/App.java:[7,5] [deprecation] ...
// Maven prints each compile error twice (under COMPILATION ERROR and again in the failure summary).
export function parseMaven(output: string, cwd: string): CompilerDiagnostic[] {
  const lines = output.split(/\r?\n/);
  const results: CompilerDiagnostic[] = [];
  lines.forEach((line, i) => {
    const m = /^\[(ERROR|WARNING)\]\s+(?:file:\/\/)?(\/?[^\s:[][^:[]*?\.\w+):\[(\d+)(?:,\d+)?\]\s*(.*)$/.exec(line);
    if (!m) return;
    results.push({
      file: relativeTo(cwd, m[2]!),
      line: parseInt(m[3]!, 10),
      severity: m[1] === 'ERROR' ? 'error' : 'warning',
      message: withDetails(lines, i, m[4]!.trim()),
    });
  });
  return dedupe(results);
}

// javac, and Gradle (which prints javac's own output), plus the Kotlin compiler's form:
//   src/main/java/demo/App.java:3: error: cannot find symbol
//   e: file:///abs/src/main/kotlin/App.kt:3:5 Unresolved reference: y
//   w: /abs/src/main/kotlin/App.kt:9:1 'foo' is deprecated
export function parseJavac(output: string, cwd: string): CompilerDiagnostic[] {
  const lines = output.split(/\r?\n/);
  const results: CompilerDiagnostic[] = [];
  lines.forEach((line, i) => {
    const j = /^(.+?\.(?:java|groovy|scala)):(\d+):\s*(error|warning):\s*(.*)$/.exec(line);
    if (j) {
      results.push({ file: relativeTo(cwd, j[1]!), line: parseInt(j[2]!, 10), severity: j[3] as 'error' | 'warning', message: withDetails(lines, i, j[4]!.trim()) });
      return;
    }
    const k = /^([ew]):\s+(?:file:\/\/)?(.+?\.kts?):(\d+):(?:\d+:?)?\s*(.*)$/.exec(line);
    if (k) results.push({ file: relativeTo(cwd, k[2]!), line: parseInt(k[3]!, 10), severity: k[1] === 'e' ? 'error' : 'warning', message: k[4]!.trim() });
  });
  return dedupe(results);
}

// .NET (dotnet build / msbuild): src/App.cs(12,5): error CS0103: The name 'y' does not exist ... [/abs/App.csproj]
export function parseDotnet(output: string, cwd: string): CompilerDiagnostic[] {
  const re = /^\s*(.+?\.(?:cs|fs|vb))\((\d+),\d+\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.*?)(?:\s+\[[^\]]+\])?$/gm;
  const results: CompilerDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) {
    results.push({ file: relativeTo(cwd, m[1]!), line: parseInt(m[2]!, 10), severity: m[3] as 'error' | 'warning', message: m[5]!, code: m[4]! });
  }
  return dedupe(results);
}

// For a user-configured build command, whose tool we don't know: every shape above that is
// specific enough not to misread ordinary log lines (go vet's bare `file:line:col: msg` is not).
// Several shapes can match one line (javac's is also mypy's), so the first, more specific parser wins per location.
export function parseAnyCompilerOutput(output: string, cwd: string): CompilerDiagnostic[] {
  const seen = new Set<string>();
  return ([
    ...parseTsc(output).map((d) => ({ ...d, file: relativeTo(cwd, d.file) })),
    ...parseDotnet(output, cwd),
    ...parseMaven(output, cwd),
    ...parseJavac(output, cwd),
    ...parseCargoCheck(output).map((d) => ({ ...d, file: relativeTo(cwd, d.file) })),
    ...parseMypy(output).map((d) => ({ ...d, file: relativeTo(cwd, d.file) })),
  ] as CompilerDiagnostic[]).filter((d) => {
    const key = `${d.file}|${d.line}|${d.severity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Lines build tools print on every failure that say nothing about this one: Maven's help footer and
// timing banner, Gradle's "* Try:" advice, npm's log-file pointer. Dropped before output is trimmed
// to its tail for a person or the fixer, so the tail is the failing test and its expected/actual values.
const NOISE = [
  /^\[INFO\]/,
  /^\[ERROR\]\s*$/,
  /^\[ERROR\] (-> \[Help \d+\]|\[Help \d+\] http|To see the full stack trace|Re-run Maven using|For more information about the errors|Please refer to )/,
  /^\[WARNING\]\s*$/,
  /^(\* Try:|> Run with --(stacktrace|info|debug|scan)|> Get more help at|\* Get more help at|BUILD FAILED in |Deprecated Gradle features were used|You can use '--warning-mode all'|For more on this, please refer to)/,
  /^npm (ERR|error)! (A complete log of this run|Lifecycle script|code ELIFECYCLE|errno|$)/,
  // stack frames inside the runtime or the test framework: the frame in the project's own code is what places the failure
  /^\s+at (System\.|Microsoft\.|Xunit\.|NUnit\.|java\.base\/|java\.|jdk\.internal\.|sun\.reflect\.|org\.junit\.|org\.apache\.maven\.|org\.gradle\.|node:internal\/|process\.processTicksAndRejections)/,
  /^\s+at .*\((node:internal\/|internal\/)/,
  /^\s+\.\.\. \d+ more$/,
];
export function stripBuildToolNoise(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !NOISE.some((re) => re.test(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
