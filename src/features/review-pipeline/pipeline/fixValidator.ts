// Objective check of a candidate fix, run inside the sandbox (never the real
// project): does the project still build, and do its tests still pass?
//
// "Still" matters — the user's change may already have build errors or failing
// tests before any fix is tried. So a baseline is taken once up front, and a fix
// is only rejected for what it makes WORSE: new build errors, or tests that
// passed before and fail now. If the baseline was already failing, the tests
// can't serve as a gate and the verdict says so instead of silently passing.

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runBuildRole } from '../roles/build.js';
import { ContextAggregator } from './contextAggregator.js';
import type { ParsedDiff } from './diffReader.js';
import type { ILLMProvider } from './illmProvider.js';

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
  readonly testTimeoutMs?: number; // default 5 min
}

const DEFAULT_TEST_TIMEOUT_MS = 300_000;
const NPM_PLACEHOLDER_TEST = /no test specified/i;

const unusedLlm: ILLMProvider = {
  id: 'openai',
  generate: () => {
    throw new Error('validation never calls the LLM');
  },
  stream: () => {
    throw new Error('validation never calls the LLM');
  },
};

export async function detectTestCommand(dir: string): Promise<{ command: string; label: string } | null> {
  const pkgPath = path.join(dir, 'package.json');
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.test;
    if (script && !NPM_PLACEHOLDER_TEST.test(script)) return { command: 'npm test --silent', label: 'npm test' };
  } catch {
    // no package.json / unreadable — try the other ecosystems
  }
  if (await exists(path.join(dir, 'go.mod'))) return { command: 'go test ./...', label: 'go test' };
  if (await exists(path.join(dir, 'Cargo.toml'))) return { command: 'cargo test --quiet', label: 'cargo test' };
  if ((await exists(path.join(dir, 'pytest.ini'))) || (await exists(path.join(dir, 'tests')))) {
    if (await exists(path.join(dir, 'pyproject.toml')) || (await exists(path.join(dir, 'pytest.ini')))) {
      return { command: 'python3 -m pytest -q', label: 'pytest' };
    }
  }
  return null;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (!error) return resolve({ code: 0, output, timedOut: false });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        resolve({ code: typeof e.code === 'number' ? e.code : 1, output, timedOut: e.killed === true });
      },
    );
  });
}

export async function runValidation(dir: string, diff: ParsedDiff, opts: ValidationOptions = {}): Promise<ValidationSnapshot> {
  const build = await runBuildRole({
    llm: unusedLlm,
    model: '',
    diff,
    aggregator: new ContextAggregator(diff),
    cwd: dir,
  });
  const buildErrorKeys = build.findings.filter((f) => f.severity === 'high').map((f) => `${f.file}|${f.description}`);
  // "Could not run" findings are medium; no findings + a "nothing to check" summary means nothing was verified either
  const buildVerified = !build.findings.some((f) => /Could not run/i.test(f.description)) && !/nothing for the Build role to check/i.test(build.summary);

  let tests: ValidationSnapshot['tests'] = { status: 'not-run', output: 'no test command detected' };
  if (opts.runTests !== false) {
    const detected = await detectTestCommand(dir);
    if (detected) {
      const r = await runShell(detected.command, dir, opts.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS);
      if (r.timedOut) {
        tests = { status: 'not-run', command: detected.label, output: `${detected.label} timed out — treated as inconclusive` };
      } else {
        tests = { status: r.code === 0 ? 'pass' : 'fail', command: detected.label, output: r.output.slice(-3000) };
      }
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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
