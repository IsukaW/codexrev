// Fix-check-confirm loop: runs the pipeline (Committee -> Breaker-Builder -> Resolver)
// and retries automatically when verification fails. On red, we ask the user whether
// to keep going or bail with whatever's already applied.

import type { ContentGenerator } from './types.js';
import type { AgentEvent } from './turn.js';
import type { Tool } from '../tools/registry.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { Settings } from '../config/schema.js';
import type { InteractionChannel } from './interaction.js';
import { runPipeline, type PipelineOptions, type PipelineResult } from './pipeline.js';
import type { VerificationMode } from './verification.js';
import { runAgent } from './turn.js';
import { filterReadOnlyTools } from './modes.js';
import type { Message } from './types.js';

export interface FixLoopOptions {
  prompt: string;
  provider: ContentGenerator;
  tools: Map<string, Tool>;
  mcp: McpRegistry;
  settings: Settings;
  interactionChannel: InteractionChannel;
  maxFixAttempts?: number;
  verificationMode?: VerificationMode;
  signal?: AbortSignal;
  /** prior context, e.g. carried over from Plan mode */
  contextMessages?: Message[];
}

export interface FixLoopResult {
  passed: boolean;
  attempts: number;
  lastResult: PipelineResult;
  stoppedByUser: boolean;
}

const BREAKER_BUILDER_RETRY_PROMPT = [
  'You are the BREAKER-BUILDER agent — retrying a fix after verification failure.',
  'The previous attempt was marked RED by the Resolver.',
  '',
  'Instructions:',
  '1. Read the Resolver\'s feedback carefully.',
  '2. Examine the current state of the affected files.',
  '3. Make targeted fixes to address the issues identified.',
  '4. Do not redo work that was already correct.',
  '5. If something is unclear, call ask_user for clarification.',
].join('\n');

// Top-level entry point for Agent mode.
export async function* runFixLoop(
  opts: FixLoopOptions,
): AsyncGenerator<AgentEvent, FixLoopResult> {
  const maxAttempts = opts.maxFixAttempts ?? 5;
  const { interactionChannel, signal } = opts;

  let attempts = 0;
  let stoppedByUser = false;
  let lastResult: PipelineResult | null = null;
  let previousErrors = '';

  // first pass: full pipeline
  attempts = 1;
  const pipelineOpts: PipelineOptions = {
    prompt: opts.prompt,
    provider: opts.provider,
    tools: opts.tools,
    mcp: opts.mcp,
    settings: opts.settings,
    interactionChannel,
    signal,
    contextMessages: opts.contextMessages,
  };

  for await (const ev of runPipeline(pipelineOpts)) {
    yield ev;
  }

  // for-await only gives us yielded events, not the generator's return value,
  // so run it again through the delegating wrapper to actually get the result
  lastResult = yield* runPipelineWithResult(pipelineOpts);

  yield {
    kind: 'fix_iteration',
    attempt: 1,
    maxAttempts,
    status: lastResult.passed ? 'green' : 'red',
    summary: lastResult.passed
      ? 'Verification passed on first attempt.'
      : `Verification failed: ${lastResult.verification.slice(0, 200)}`,
  };

  if (lastResult.passed) {
    return { passed: true, attempts: 1, lastResult, stoppedByUser: false };
  }

  previousErrors = lastResult.verification;

  // retry loop
  while (attempts < maxAttempts) {
    const decision = await interactionChannel.requestFixConfirmation(
      attempts,
      maxAttempts,
      previousErrors.slice(0, 300),
      'red',
    );

    if (decision === 'stop') {
      stoppedByUser = true;
      break;
    }

    attempts++;

    // re-run Breaker-Builder + Resolver with the failure context attached
    const retryPrompt = [
      '--- Original Request ---',
      opts.prompt,
      '',
      '--- Previous Verification Failure ---',
      previousErrors,
      '',
      'Please fix the issues identified above.',
    ].join('\n');

    const retryResult = yield* runRetryIteration({
      ...pipelineOpts,
      prompt: retryPrompt,
      systemPromptSuffix: BREAKER_BUILDER_RETRY_PROMPT,
    }, previousErrors);

    lastResult = retryResult;

    yield {
      kind: 'fix_iteration',
      attempt: attempts,
      maxAttempts,
      status: retryResult.passed ? 'green' : 'red',
      summary: retryResult.passed
        ? `Verification passed on attempt ${attempts}.`
        : `Attempt ${attempts} failed: ${retryResult.verification.slice(0, 200)}`,
    };

    if (retryResult.passed) {
      return { passed: true, attempts, lastResult, stoppedByUser: false };
    }

    previousErrors = retryResult.verification;
  }

  return {
    passed: false,
    attempts,
    lastResult: lastResult!,
    stoppedByUser,
  };
}

// Same as runPipeline, just typed so the return value is captured via yield*.
async function* runPipelineWithResult(
  opts: PipelineOptions,
): AsyncGenerator<AgentEvent, PipelineResult> {
  return yield* runPipeline(opts);
}

// One retry iteration: Breaker-Builder then Resolver. Skips Committee, no need to
// re-analyze what we already analyzed.
async function* runRetryIteration(
  opts: PipelineOptions & { systemPromptSuffix: string },
  previousErrors: string,
): AsyncGenerator<AgentEvent, PipelineResult> {
  yield {
    kind: 'pipeline_phase',
    phase: 'breaker-builder',
    description: 'Retrying fix based on verification feedback…',
  };

  let implementation = '';
  for await (const ev of runAgent({
    prompt: opts.prompt,
    provider: opts.provider,
    tools: opts.tools,
    mcp: opts.mcp,
    settings: opts.settings,
    stream: true,
    signal: opts.signal,
    systemInstructionOverride: opts.systemPromptSuffix,
    contextMessages: opts.contextMessages,
    interactionChannel: opts.interactionChannel,
  })) {
    if (ev.kind === 'text_delta') implementation += ev.text;
    if (ev.kind !== 'pipeline_phase' && ev.kind !== 'fix_iteration') {
      yield ev;
    }
  }

  yield {
    kind: 'pipeline_phase',
    phase: 'resolver',
    description: 'Verifying retry changes…',
  };

  const verTools = filterReadOnlyTools(opts.tools);
  // resolver needs shell too, for running tests
  const shellTool = opts.tools.get('shell');
  if (shellTool) verTools.set('shell', shellTool);

  const resolverPrompt = [
    'You are the RESOLVER agent. Verify the latest changes.',
    '',
    `Original request: ${opts.prompt}`,
    '',
    `Previous issues: ${previousErrors}`,
    '',
    'Changes just made:',
    implementation.slice(0, 2000),
    '',
    'Check if the issues are now resolved. Start with "GREEN:" or "RED:".',
  ].join('\n');

  let verification = '';
  for await (const ev of runAgent({
    prompt: resolverPrompt,
    provider: opts.provider,
    tools: verTools,
    mcp: opts.mcp,
    settings: opts.settings,
    stream: true,
    signal: opts.signal,
    contextMessages: opts.contextMessages,
  })) {
    if (ev.kind === 'text_delta') verification += ev.text;
    if (ev.kind !== 'pipeline_phase' && ev.kind !== 'fix_iteration') {
      yield ev;
    }
  }

  const passed = /^\s*GREEN:/im.test(verification);
  return {
    committeeAnalysis: '',
    implementation,
    verification,
    passed,
  };
}
