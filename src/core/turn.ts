/**
 * Codexrev — agent turn manager.
 *
 * The "turn" is a single user → model → tool(s) → model exchange. The
 * agent loop keeps running turns until the model emits `stop` or the
 * user aborts. Streaming yields a stream of `AgentEvent`s the UI can
 * render in real-time.
 */

import type {
  ContentGenerator,
  Message,
  StreamEvent,
  ToolCallPart,
  ToolResultPart,
  UsageStats,
} from './types.js';
import { ProviderError } from './types.js';
import type { Tool, ToolContext, ToolResult } from '../tools/registry.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { Settings } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export type AgentEvent =
  | { kind: 'message_start' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_call'; toolCall: ToolCallPart }
  | { kind: 'tool_result'; toolResult: ToolResultPart }
  | { kind: 'usage'; usage: UsageStats }
  | { kind: 'turn_complete'; turns: number; reason: string }
  | { kind: 'error'; error: ProviderError };

export interface AgentResult {
  finalText: string;
  messages: Message[];
  usage: UsageStats;
  turns: number;
  finishReason: string;
}

export interface RunAgentOptions {
  prompt: string;
  provider: ContentGenerator;
  tools: Map<string, Tool>;
  mcp: McpRegistry;
  settings: Settings;
  stream: boolean;
  signal?: AbortSignal;
}

/** Build a system instruction that includes the current working directory. */
function buildSystemInstruction(settings: Settings): string {
  return [
    'You are Codexrev, a multi-provider agentic CLI assistant.',
    `Working directory: ${process.cwd()}`,
    `Provider: ${settings.provider}`,
    `Model: ${settings.model}`,
    'When you need to use tools, prefer the most specific tool. If the user has not yet approved a destructive action, ask for confirmation.',
  ].join('\n');
}

async function executeToolCall(
  call: ToolCallPart,
  tools: Map<string, Tool>,
  mcp: McpRegistry,
  ctx: ToolContext,
): Promise<ToolResult> {
  const builtin = tools.get(call.name);
  if (builtin) {
    return await builtin.execute(call.arguments, ctx);
  }
  // Otherwise, route to MCP
  return await mcp.callTool(call.name, call.arguments);
}

/**
 * Run the agent loop until the model emits `stop`, hits max turns,
 * or is aborted. With `stream: false` returns a final `AgentResult`;
 * with `stream: true` returns an async iterable of `AgentEvent`s.
 */
export function runAgent(opts: RunAgentOptions & { stream: false }): Promise<AgentResult>;
export function runAgent(opts: RunAgentOptions & { stream: true }): AsyncIterable<AgentEvent>;
export function runAgent(
  opts: RunAgentOptions,
): Promise<AgentResult> | AsyncIterable<AgentEvent> {
  if (opts.stream) {
    return streamAgent(opts);
  }
  return collectAgent(opts);
}

async function collectAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const events: AgentEvent[] = [];
  let finalText = '';
  let usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let turns = 0;
  let finishReason = 'completed';

  for await (const event of streamAgent(opts)) {
    events.push(event);
    if (event.kind === 'text_delta') finalText += event.text;
    if (event.kind === 'usage') usage = event.usage;
    if (event.kind === 'turn_complete') {
      turns = event.turns;
      finishReason = event.reason;
    }
  }

  return { finalText, messages: [], usage, turns, finishReason };
}

async function* streamAgent(opts: RunAgentOptions): AsyncIterable<AgentEvent> {
  const { prompt, provider, tools, mcp, settings, signal } = opts;
  const messages: Message[] = [{ role: 'user', parts: [{ kind: 'text', text: prompt }] }];
  const systemInstruction = buildSystemInstruction(settings);

  // Aggregate tool declarations from builtins + MCP
  const toolDecls = [
    ...Array.from(tools.values()).map((t) => t.declaration),
    ...(await mcp.listToolDeclarations()),
  ];

  let turns = 0;
  let aggregateUsage: UsageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (let turn = 0; turn < settings.maxTurns; turn++) {
    turns = turn + 1;
    if (signal?.aborted) {
      yield { kind: 'turn_complete', turns, reason: 'aborted' };
      return;
    }

    yield { kind: 'message_start' };
    let text = '';
    const toolCalls: ToolCallPart[] = [];
    let lastFinish: StreamEvent | null = null;

    try {
      for await (const ev of provider.stream({
        model: settings.model,
        messages,
        tools: toolDecls,
        systemInstruction,
        temperature: settings.temperature,
        topP: settings.topP,
        maxOutputTokens: settings.maxOutputTokens,
        signal,
      })) {
        lastFinish = ev;
        if (ev.kind === 'text_delta') {
          text += ev.text;
          yield { kind: 'text_delta', text: ev.text };
        } else if (ev.kind === 'tool_call') {
          toolCalls.push(ev.toolCall);
          yield { kind: 'tool_call', toolCall: ev.toolCall };
        } else if (ev.kind === 'finish' && ev.usage) {
          aggregateUsage = addUsage(aggregateUsage, ev.usage);
          yield { kind: 'usage', usage: ev.usage };
        } else if (ev.kind === 'error') {
          yield { kind: 'error', error: ev.error };
          yield { kind: 'turn_complete', turns, reason: 'error' };
          return;
        }
      }
    } catch (err) {
      const error =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              (err as Error).message,
              provider.provider,
              undefined,
              undefined,
              true,
            );
      yield { kind: 'error', error };
      yield { kind: 'turn_complete', turns, reason: 'error' };
      return;
    }

    // Append the assistant message
    const assistantParts: Message['parts'] = [];
    if (text) assistantParts.push({ kind: 'text', text });
    for (const tc of toolCalls) assistantParts.push(tc);
    messages.push({ role: 'assistant', parts: assistantParts });

    // No tool calls → conversation is done
    if (toolCalls.length === 0) {
      const reason = lastFinish?.kind === 'finish' ? lastFinish.reason : 'completed';
      yield { kind: 'turn_complete', turns, reason };
      return;
    }

    // Execute each tool call sequentially
    const ctx: ToolContext = { cwd: process.cwd(), signal };
    for (const call of toolCalls) {
      try {
        const result = await executeToolCall(call, tools, mcp, ctx);
        const toolResult: ToolResultPart = {
          kind: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content: resultToContent(result),
          isError: result.isError,
        };
        messages.push({ role: 'tool', parts: [toolResult] });
        yield { kind: 'tool_result', toolResult };
      } catch (err) {
        const toolResult: ToolResultPart = {
          kind: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content: [{ kind: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
        messages.push({ role: 'tool', parts: [toolResult] });
        yield { kind: 'tool_result', toolResult };
        logger.warn('tool execution failed', { tool: call.name, error: (err as Error).message });
      }
    }
  }

  yield { kind: 'turn_complete', turns, reason: 'max_turns' };
}

function addUsage(a: UsageStats, b: UsageStats): UsageStats {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

function resultToContent(result: ToolResult): Array<{ kind: 'text'; text: string }> {
  if (typeof result.output === 'string') {
    return [{ kind: 'text', text: result.output }];
  }
  return [{ kind: 'text', text: JSON.stringify(result.output, null, 2) }];
}
