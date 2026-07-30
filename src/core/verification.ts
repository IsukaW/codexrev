/**
 * Codexrev — verification module.
 *
 * After the Breaker-Builder applies changes, the Resolver runs
 * verification to determine if the fix succeeded (green) or failed
 * (red). Three strategies:
 *
 *   - tests:  Run the project's test suite via shell, check exit code.
 *   - llm:    Ask the LLM to evaluate the current state.
 *   - auto:   Try tests first; fall back to LLM if no test runner detected.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ContentGenerator } from './types.js';
import type { Settings } from '../config/schema.js';
import { runAgent } from './turn.js';
import type { Tool } from '../tools/registry.js';
import type { McpRegistry } from '../mcp/registry.js';
import { logger } from '../utils/logger.js';

export type VerificationMode = 'tests' | 'llm' | 'auto';

export interface VerificationResult {
  passed: boolean;
  details: string;
  strategy: 'tests' | 'llm';
}

export interface VerificationOptions {
  /** The original user prompt for context. */
  originalPrompt: string;
  /** Summary of changes made by the Breaker-Builder. */
  changesSummary: string;
  provider: ContentGenerator;
  tools: Map<string, Tool>;
  mcp: McpRegistry;
  settings: Settings;
  mode: VerificationMode;
  cwd?: string;
  signal?: AbortSignal;
}

/**
 * Detect the project's test runner by looking for config files.
 * Returns the test command or null if none detected.
 */
async function detectTestRunner(cwd: string): Promise<string | null> {
  const checks: Array<{ file: string; cmd: string }> = [
    { file: 'package.json', cmd: '' }, // needs special parsing
    { file: 'pytest.ini', cmd: 'pytest' },
    { file: 'pyproject.toml', cmd: 'pytest' },
    { file: 'setup.cfg', cmd: 'pytest' },
    { file: 'go.mod', cmd: 'go test ./...' },
    { file: 'Cargo.toml', cmd: 'cargo test' },
    { file: 'Makefile', cmd: '' }, // needs special parsing
    { file: 'Gemfile', cmd: 'bundle exec rspec' },
  ];

  for (const { file, cmd } of checks) {
    try {
      await fs.access(path.join(cwd, file));
      if (file === 'package.json') {
        const raw = await fs.readFile(path.join(cwd, file), 'utf-8');
        const pkg = JSON.parse(raw);
        if (pkg.scripts?.test) {
          return 'npm test';
        }
        // Check for common test runners
        if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) return 'npx vitest run';
        if (pkg.devDependencies?.jest || pkg.dependencies?.jest) return 'npx jest';
      } else if (file === 'Makefile') {
        const raw = await fs.readFile(path.join(cwd, 'Makefile'), 'utf-8');
        if (/^test\s*:/m.test(raw)) return 'make test';
      } else if (cmd) {
        return cmd;
      }
    } catch {
      // file doesn't exist, continue
    }
  }
  return null;
}

/** Run the project's test suite and check the exit code. */
async function runTestSuite(
  testCmd: string,
  cwd: string,
  tools: Map<string, Tool>,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const shellTool = tools.get('shell');
  if (!shellTool) {
    return { passed: false, details: 'shell tool not available', strategy: 'tests' };
  }

  try {
    const result = await shellTool.execute(
      { command: testCmd, timeout: 120_000 },
      { cwd, signal },
    );
    const passed = !result.isError;
    return {
      passed,
      details: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
      strategy: 'tests',
    };
  } catch (err) {
    return {
      passed: false,
      details: `Test execution failed: ${(err as Error).message}`,
      strategy: 'tests',
    };
  }
}

/** Ask the LLM to evaluate whether the changes were successful. */
async function runLlmEvaluation(
  originalPrompt: string,
  changesSummary: string,
  provider: ContentGenerator,
  tools: Map<string, Tool>,
  mcp: McpRegistry,
  settings: Settings,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const evalPrompt = [
    'You are the Resolver agent. Evaluate whether the recent changes successfully address the original request.',
    '',
    `Original request: ${originalPrompt}`,
    '',
    `Changes made: ${changesSummary}`,
    '',
    'Instructions:',
    '1. Examine the current state of the affected files using read-only tools.',
    '2. Determine if the changes are correct and complete.',
    '3. Your final answer MUST start with either "GREEN:" (success) or "RED:" (failure).',
    '4. After the status keyword, provide a brief explanation.',
    '',
    'Example: GREEN: All tests pass and the implementation matches the requirements.',
    'Example: RED: The edit introduced a syntax error in line 15.',
  ].join('\n');

  let responseText = '';
  try {
    for await (const ev of runAgent({
      prompt: evalPrompt,
      provider,
      tools,
      mcp,
      settings,
      stream: true,
      signal,
    })) {
      if (ev.kind === 'text_delta') {
        responseText += ev.text;
      }
    }
  } catch (err) {
    return {
      passed: false,
      details: `LLM evaluation failed: ${(err as Error).message}`,
      strategy: 'llm',
    };
  }

  const passed = /^\s*GREEN:/im.test(responseText);
  return { passed, details: responseText, strategy: 'llm' };
}

/**
 * Run verification using the configured strategy.
 */
export async function runVerification(opts: VerificationOptions): Promise<VerificationResult> {
  const cwd = opts.cwd ?? process.cwd();
  const { mode } = opts;

  if (mode === 'tests') {
    const testCmd = await detectTestRunner(cwd);
    if (testCmd) {
      logger.info('verification: running test suite', { cmd: testCmd });
      return runTestSuite(testCmd, cwd, opts.tools, opts.signal);
    }
    return {
      passed: false,
      details: 'No test runner detected. Configure one or use verification mode "llm" or "auto".',
      strategy: 'tests',
    };
  }

  if (mode === 'llm') {
    logger.info('verification: running LLM evaluation');
    return runLlmEvaluation(
      opts.originalPrompt,
      opts.changesSummary,
      opts.provider,
      opts.tools,
      opts.mcp,
      opts.settings,
      opts.signal,
    );
  }

  // mode === 'auto': try tests first, fall back to LLM
  const testCmd = await detectTestRunner(cwd);
  if (testCmd) {
    logger.info('verification (auto): running test suite', { cmd: testCmd });
    const result = await runTestSuite(testCmd, cwd, opts.tools, opts.signal);
    // If tests ran but failed, still report — don't fall back to LLM for a "maybe"
    return result;
  }

  logger.info('verification (auto): no test runner found, falling back to LLM evaluation');
  return runLlmEvaluation(
    opts.originalPrompt,
    opts.changesSummary,
    opts.provider,
    opts.tools,
    opts.mcp,
    opts.settings,
    opts.signal,
  );
}
