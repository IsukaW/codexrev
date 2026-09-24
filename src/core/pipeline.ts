// Multi-agent pipeline: three sequential runAgent() calls, each with its own system
// prompt and tool subset — Committee (read-only analysis), Breaker-Builder (writes),
// Resolver (verification, read-only + shell). Yields pipeline_phase events so the UI
// can show progress.

import type { ContentGenerator } from './types.js';
import type { AgentEvent } from './turn.js';
import { runAgent } from './turn.js';
import type { Tool } from '../tools/registry.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { Settings } from '../config/schema.js';
import type { InteractionChannel } from './interaction.js';
import { filterReadOnlyTools } from './modes.js';

export interface PipelineOptions {
  prompt: string;
  provider: ContentGenerator;
  tools: Map<string, Tool>;
  mcp: McpRegistry;
  settings: Settings;
  interactionChannel: InteractionChannel;
  signal?: AbortSignal;
  /** forwarded to every phase, e.g. context carried over from Plan mode */
  contextMessages?: import('./types.js').Message[];
}

function readOnlyToolSet(allTools: Map<string, Tool>): Map<string, Tool> {
  return filterReadOnlyTools(allTools);
}

// read + shell only, for verification
function verificationToolSet(allTools: Map<string, Tool>): Map<string, Tool> {
  const allowed = new Set(['read_file', 'glob', 'grep', 'web_fetch', 'web_search', 'shell', 'ask_user']);
  const filtered = new Map<string, Tool>();
  for (const [name, tool] of allTools) {
    if (allowed.has(name)) filtered.set(name, tool);
  }
  return filtered;
}

// system prompts per phase

const COMMITTEE_PROMPT = [
  'You are the COMMITTEE agent — the analysis phase of a multi-agent pipeline.',
  'Your job is to deeply analyze the user\'s request and produce a structured assessment.',
  '',
  'Output format:',
  '1. **Problem Summary** — what the user wants, in your own words.',
  '2. **Affected Files** — which files need to be examined or modified.',
  '3. **Proposed Approach** — step-by-step plan for the Breaker-Builder.',
  '4. **Risk Assessment** — what could go wrong, edge cases, dependencies.',
  '',
  'You MUST use read-only tools only. Do not modify any files.',
  'If the request is ambiguous, call ask_user to get clarification before proceeding.',
].join('\n');

const BREAKER_BUILDER_PROMPT = [
  'You are the BREAKER-BUILDER agent — the implementation phase of a multi-agent pipeline.',
  'You receive the Committee\'s analysis and implement the necessary changes.',
  '',
  'Instructions:',
  '1. Follow the Committee\'s plan step by step.',
  '2. Use edit/write_file tools to make code changes.',
  '3. Use shell to run any necessary build or compile commands.',
  '4. After each change, briefly explain what you did and why.',
  '5. If something is unclear, call ask_user for clarification.',
  '',
  'Be precise and careful. Prefer minimal, targeted edits over large rewrites.',
].join('\n');

function buildResolverPrompt(originalPrompt: string, changesSummary: string): string {
  return [
    'You are the RESOLVER agent — the verification phase of a multi-agent pipeline.',
    'Your job is to verify that the changes made by the Breaker-Builder are correct.',
    '',
    `Original request: ${originalPrompt}`,
    '',
    `Changes made: ${changesSummary}`,
    '',
    'Instructions:',
    '1. Examine the modified files using read-only tools.',
    '2. Run the project\'s test suite via shell if available.',
    '3. Check for syntax errors, logical issues, and missing pieces.',
    '4. Your final assessment MUST start with "GREEN:" or "RED:" followed by explanation.',
    '',
    'GREEN: The changes are correct and complete.',
    'RED: There are issues that need to be fixed (describe them).',
  ].join('\n');
}

// pipeline phases

// Phase A: Committee, read-only analysis.
async function* runCommittee(
  opts: PipelineOptions,
): AsyncGenerator<AgentEvent, string> {
  yield { kind: 'pipeline_phase', phase: 'committee', description: 'Analyzing the request…' };

  let analysis = '';
  const roTools = readOnlyToolSet(opts.tools);

  for await (const ev of runAgent({
    prompt: opts.prompt,
    provider: opts.provider,
    tools: roTools,
    mcp: opts.mcp,
    settings: opts.settings,
    stream: true,
    signal: opts.signal,
    systemInstructionOverride: COMMITTEE_PROMPT,
    contextMessages: opts.contextMessages,
  })) {
    if (ev.kind === 'text_delta') analysis += ev.text;
    // don't forward pipeline_phase/fix_iteration from the sub-call, only the outer one matters
    if (ev.kind !== 'pipeline_phase' && ev.kind !== 'fix_iteration') {
      yield ev;
    }
  }

  return analysis;
}

// Phase B: Breaker-Builder, implementation.
async function* runBreakerBuilder(
  opts: PipelineOptions,
  committeeAnalysis: string,
): AsyncGenerator<AgentEvent, string> {
  yield { kind: 'pipeline_phase', phase: 'breaker-builder', description: 'Implementing changes…' };

  const enhancedPrompt = [
    '--- Committee Analysis ---',
    committeeAnalysis,
    '--- End Analysis ---',
    '',
    'Based on the analysis above, implement the necessary changes.',
    opts.prompt,
  ].join('\n');

  let implementation = '';
  for await (const ev of runAgent({
    prompt: enhancedPrompt,
    provider: opts.provider,
    tools: opts.tools,
    mcp: opts.mcp,
    settings: opts.settings,
    stream: true,
    signal: opts.signal,
    systemInstructionOverride: BREAKER_BUILDER_PROMPT,
    contextMessages: opts.contextMessages,
    interactionChannel: opts.interactionChannel,
  })) {
    if (ev.kind === 'text_delta') implementation += ev.text;
    if (ev.kind !== 'pipeline_phase' && ev.kind !== 'fix_iteration') {
      yield ev;
    }
  }

  return implementation;
}

// Phase C: Resolver, verification.
async function* runResolver(
  opts: PipelineOptions,
  originalPrompt: string,
  changesSummary: string,
): AsyncGenerator<AgentEvent, string> {
  yield { kind: 'pipeline_phase', phase: 'resolver', description: 'Verifying changes…' };

  const verTools = verificationToolSet(opts.tools);
  let result = '';

  for await (const ev of runAgent({
    prompt: buildResolverPrompt(originalPrompt, changesSummary),
    provider: opts.provider,
    tools: verTools,
    mcp: opts.mcp,
    settings: opts.settings,
    stream: true,
    signal: opts.signal,
    systemInstructionOverride: undefined, // uses the full resolver prompt
    contextMessages: opts.contextMessages,
  })) {
    if (ev.kind === 'text_delta') result += ev.text;
    if (ev.kind !== 'pipeline_phase' && ev.kind !== 'fix_iteration') {
      yield ev;
    }
  }

  return result;
}

export interface PipelineResult {
  committeeAnalysis: string;
  implementation: string;
  verification: string;
  passed: boolean;
}

// Single pass through Committee -> Breaker-Builder -> Resolver. runFixLoop() wraps
// this and retries on failure.
export async function* runPipeline(
  opts: PipelineOptions,
): AsyncGenerator<AgentEvent, PipelineResult> {
  const analysis = yield* runCommittee(opts);
  const implementation = yield* runBreakerBuilder(opts, analysis);
  const verification = yield* runResolver(opts, opts.prompt, implementation);

  const passed = /^\s*GREEN:/im.test(verification);

  return {
    committeeAnalysis: analysis,
    implementation,
    verification,
    passed,
  };
}
