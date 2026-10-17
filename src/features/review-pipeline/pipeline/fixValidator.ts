// Objective check of a candidate fix, run inside the sandbox (never the real
// project): does the project still build, and do its tests still pass?
//
// "Still" matters — the user's change may already have build errors or failing
// tests before any fix is tried. So a baseline is taken once up front, and a fix
// is only rejected for what it makes WORSE: new build errors, or tests that
// passed before and fail now. If the baseline was already failing, the tests
// can't serve as a gate and the verdict says so instead of silently passing.

import path from 'node:path';
import { runBuildRole } from '../roles/build.js';
import { ContextAggregator } from './contextAggregator.js';
import type { ParsedDiff } from './diffReader.js';
import type { ILLMProvider } from './illmProvider.js';
import { detectTestCommand as detectToolchainTestCommand, planTestCommands, runToolchainCommand, stripBuildToolNoise, type ToolchainOptions } from '../../../core/toolchains/index.js';

export type TestStatus = 'pass' | 'fail' | 'not-run';

export interface ValidationSnapshot {
  /** stable identity of each build error (file + message, no line numbers — those shift with edits) */
  readonly buildErrorKeys: readonly string[];
  /** false when the toolchain could not run here, so "no errors" proves nothing */
  readonly buildVerified: boolean;
  readonly buildSummary: string;
  readonly tests: { readonly status: TestStatus; readonly command?: string; readonly output: string };
}

export interface ValidationVerdict {
  readonly acceptable: boolean;
  /** why the fix was rejected (empty when acceptable) */
  readonly reasons: readonly string[];
  /** non-blocking caveats, e.g. "tests were already failing, not used as a gate" */
  readonly notes: readonly string[];
}

export interface ValidationOptions {
  readonly runTests?: boolean; // default true
  /** overrides the toolchain's own default (5 min; 15 min for Maven/Gradle) */
  readonly testTimeoutMs?: number;
  /** settings `toolchain` (explicit build/test commands) + sandbox permission */
  readonly toolchain?: ToolchainOptions;
}

const DEFAULT_TEST_TIMEOUT_MS = 300_000;

const unusedLlm: ILLMProvider = {
  id: 'openai',
  generate: () => {
    throw new Error('validation never calls the LLM');
  },
  stream: () => {
    throw new Error('validation never calls the LLM');
  },
};

// kept for callers/tests that only need the command; the detection itself lives in the toolchain registry
export async function detectTestCommand(dir: string, toolchain?: ToolchainOptions): Promise<{ command: string; label: string; timeoutMs?: number } | null> {
  return detectToolchainTestCommand(dir, toolchain);
}

// test output names files by the temporary copy's absolute path, which means nothing to the fixer (or a person)
// and pushes the actual failure out of the trimmed tail; the project-relative path is what they can act on
function projectRelative(output: string, dir: string): string {
  const variants = new Set([dir, dir.replace(/^\/private(?=\/)/, ''), `/private${dir}`]);
  let out = output;
  for (const v of variants) out = out.split(`${v}${path.sep}`).join('');
  return out;
}

export async function runValidation(dir: string, diff: ParsedDiff, opts: ValidationOptions = {}): Promise<ValidationSnapshot> {
  const build = await runBuildRole({
    llm: unusedLlm,
    model: '',
    diff,
    aggregator: new ContextAggregator(diff),
    cwd: dir,
    toolchain: opts.toolchain,
  });
  const buildErrorKeys = build.findings.filter((f) => f.severity === 'high').map((f) => `${f.file}|${f.description}`);
  // "Could not run" findings are medium; no findings + a "nothing to check" summary means nothing was verified either
  const buildVerified = !build.findings.some((f) => /Could not run/i.test(f.description)) && !/nothing for the Build role to check/i.test(build.summary);

  let tests: ValidationSnapshot['tests'] = { status: 'not-run', output: 'no test command detected' };
  if (opts.runTests !== false) {
    // one suite per module the change touches (a monorepo's backend AND frontend), see core/toolchains/modules.ts
    const suites = await planTestCommands(dir, diff.files.map((f) => f.path), opts.toolchain);
    const results: Array<{ label: string; status: TestStatus; output: string }> = [];
    for (const suite of suites) {
      const label = suite.dir === '.' ? suite.label : `${suite.label} (${suite.dir})`;
      // not under the OS sandbox: in the temporary copy node_modules is a symlink to the real project's,
      // and test runners write caches through it, which a write-restricted profile would turn into failures
      const timeoutMs = opts.testTimeoutMs ?? suite.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
      const r = await runToolchainCommand(suite.command, path.join(dir, suite.dir), { timeoutMs, sandbox: false });
      results.push(
        r.timedOut
          ? { label, status: 'not-run', output: `${label} timed out — treated as inconclusive` }
          : { label, status: r.code === 0 ? 'pass' : 'fail', output: projectRelative(stripBuildToolNoise(r.output), dir) },
      );
    }
    if (results.length > 0) {
      // a failing suite is what matters for the gate, and the part of the output worth keeping
      const status: TestStatus = results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'not-run') ? 'not-run' : 'pass';
      const shown = status === 'fail' ? results.filter((r) => r.status === 'fail') : results;
      const output = shown.length === 1 ? shown[0]!.output : shown.map((r) => `── ${r.label} ──\n${r.output.slice(-1500)}`).join('\n\n');
      tests = { status, command: results.map((r) => r.label).join(', '), output: output.slice(-3000) };
    }
  }
  return { buildErrorKeys, buildVerified, buildSummary: build.summary, tests };
}

export function compareValidation(baseline: ValidationSnapshot, after: ValidationSnapshot): ValidationVerdict {
  const reasons: string[] = [];
  const notes: string[] = [];

  const before = new Set(baseline.buildErrorKeys);
  const introduced = after.buildErrorKeys.filter((k) => !before.has(k));
  if (introduced.length > 0) {
    reasons.push(`introduces ${introduced.length} new build error(s): ${introduced.slice(0, 3).map((k) => k.split('|')[1]).join(' | ')}`);
  }
  if (!after.buildVerified) notes.push('build could not be verified in this environment — no build gate applied');

  if (after.tests.status === 'not-run') {
    notes.push(`tests not run (${after.tests.output})`);
  } else if (baseline.tests.status === 'pass' && after.tests.status === 'fail') {
    reasons.push(`tests passed before this fix but fail after it (${after.tests.command}): ${after.tests.output.slice(-500)}`);
  } else if (baseline.tests.status === 'fail') {
    notes.push(`tests were already failing before the fix (${baseline.tests.command}) — not used as a gate`);
  }
  return { acceptable: reasons.length === 0, reasons, notes };
}
