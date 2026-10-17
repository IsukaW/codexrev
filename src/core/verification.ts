// After Breaker-Builder applies changes, Resolver verifies green/red. Three
// strategies: tests (run the suite, check exit code), llm (ask it to judge), auto
// (tests first, fall back to llm if nothing detected).

import type { ContentGenerator } from './types.js';
import type { Settings } from '../config/schema.js';
import { runAgent } from './turn.js';
import type { Tool } from '../tools/registry.js';
import type { McpRegistry } from '../mcp/registry.js';
import { logger } from '../utils/logger.js';
import { detectTestCommand, runToolchainCommand, type TestCommand } from './toolchains/index.js';

export type VerificationMode = 'tests' | 'llm' | 'auto';

export interface VerificationResult {
  passed: boolean;
  details: string;
  strategy: 'tests' | 'llm';
}

export interface VerificationOptions {
  originalPrompt: string;
  /** what the Breaker-Builder changed */
  changesSummary: string;
  provider: ContentGenerator;
  tools: Map<string, Tool>;
  mcp: McpRegistry;
  settings: Settings;
  mode: VerificationMode;
  cwd?: string;
  signal?: AbortSignal;
}

// The test command comes from the shared toolchain registry (settings `toolchain.test` first,
// then package.json / Maven / Gradle / go / cargo / pytest / Makefile / rspec detection).
// It runs through the toolchain runner, not the `shell` tool: that tool's sandbox profile
// denies fork(), which every real test runner (npm, mvn, gradle, pytest-xdist) needs.
async function runTestSuite(
  test: TestCommand,
  cwd: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  try {
    const result = await runToolchainCommand(test.command, cwd, {
      timeoutMs: test.timeoutMs ?? 120_000,
      sandbox: settings.sandbox !== 'off',
      ...(signal ? { signal } : {}),
    });
    const details = result.timedOut ? `${test.label} timed out after ${Math.round((test.timeoutMs ?? 120_000) / 1000)}s\n${result.output}` : result.output;
    return { passed: result.code === 0, details, strategy: 'tests' };
  } catch (err) {
    return {
      passed: false,
      details: `Test execution failed: ${(err as Error).message}`,
      strategy: 'tests',
    };
  }
}

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

export async function runVerification(opts: VerificationOptions): Promise<VerificationResult> {
  const cwd = opts.cwd ?? process.cwd();
  const { mode } = opts;

  if (mode === 'tests') {
    const testCmd = await detectTestCommand(cwd, opts.settings.toolchain);
    if (testCmd) {
      logger.info('verification: running test suite', { cmd: testCmd.command });
      return runTestSuite(testCmd, cwd, opts.settings, opts.signal);
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

  // auto: try tests first, fall back to LLM
  const testCmd = await detectTestCommand(cwd, opts.settings.toolchain);
  if (testCmd) {
    logger.info('verification (auto): running test suite', { cmd: testCmd.command });
    const result = await runTestSuite(testCmd, cwd, opts.settings, opts.signal);
    // report as-is even on failure, don't fall back to LLM for a "maybe"
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
