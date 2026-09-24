// A "turn" is one user -> model -> tool(s) -> model exchange. The loop keeps running
// turns until the model stops or the user aborts; streaming mode yields AgentEvents
// as they happen so the UI can render live.

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
import type { InteractionChannel } from './interaction.js';
import { logger } from '../utils/logger.js';

export type AgentEvent =
  | { kind: 'message_start' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_call'; toolCall: ToolCallPart }
  | { kind: 'tool_result'; toolResult: ToolResultPart }
  | { kind: 'usage'; usage: UsageStats }
  | { kind: 'turn_complete'; turns: number; reason: string }
  | { kind: 'error'; error: ProviderError }
  // pipeline / fix-loop events
  | { kind: 'pipeline_phase'; phase: 'committee' | 'breaker-builder' | 'resolver'; description: string }
  | { kind: 'fix_iteration'; attempt: number; maxAttempts: number; status: 'red' | 'green' | 'checking'; summary: string }
  | { kind: 'clarification_prompt'; question: string; suggestions: readonly string[] }
  | { kind: 'clarification_response'; answer: string };

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
  /** extra system-prompt text for the current mode */
  systemPromptSuffix?: string;
  /** replaces the default system instruction entirely — pipeline phases use this */
  systemInstructionOverride?: string;
  // prior messages to prepend, e.g. when switching Plan -> Agent so the agent still
  // sees what was discussed/planned
  contextMessages?: Message[];
  // when set, mutating tools (shell/write_file/edit) get gated through
  // interactionChannel.requestApproval() unless bypassApprovals/approvalMode says otherwise
  interactionChannel?: InteractionChannel;
}

function buildSystemInstruction(settings: Settings, suffix?: string): string {
  const parts = [
    'You are Codexrev, a multi-provider agentic CLI assistant.',
    `Current date: ${new Date().toISOString()} (${new Date().toDateString()})`,
    `Working directory: ${process.cwd()}`,
    `Provider: ${settings.provider}`,
    `Model: ${settings.model}`,
    `Shell sandbox: ${settings.sandbox}`,
    'When you need to use tools, prefer the most specific tool. If the user has not yet approved a destructive action, ask for confirmation.',
  ];
  if (suffix) parts.push(suffix);
  return parts.join('\n');
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
  // not a builtin, so it must be an MCP tool
  return await mcp.callTool(call.name, call.arguments);
}

// runs until the model stops, hits max turns, or gets aborted. stream:false collects
// everything into an AgentResult; stream:true gives back the raw AgentEvent iterable.
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
  let finalText = '';
  let usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let turns = 0;
  let finishReason = 'completed';
  // streamAgent populates this with the full transcript (context + user
  // prompt + assistant/tool turns) so callers of the non-streaming API
  // can persist it and carry session memory into the next `send()`.
  const sink: { messages: Message[] } = { messages: [] };

  for await (const event of streamAgent(opts, sink)) {
    if (event.kind === 'text_delta') finalText += event.text;
    if (event.kind === 'usage') usage = event.usage;
    if (event.kind === 'turn_complete') {
      turns = event.turns;
      finishReason = event.reason;
    }
  }

  return { finalText, messages: sink.messages, usage, turns, finishReason };
}

async function* streamAgent(
  opts: RunAgentOptions,
  sink?: { messages: Message[] },
): AsyncIterable<AgentEvent> {
  const { prompt, provider, tools, mcp, settings, signal, systemPromptSuffix, systemInstructionOverride, contextMessages, interactionChannel } = opts;

  // Build the tool-approval gate. `undefined` → tools run without asking.
  const approvalsActive =
    !!interactionChannel && !settings.bypassApprovals && settings.approvalMode !== 'never';
  const sessionApproved = new Set<string>();
  const askApproval = approvalsActive
    ? async (toolName: string, args: unknown): Promise<boolean> => {
        if (sessionApproved.has(toolName)) return true;
        const summary = describeToolCall(toolName, args);
        const decision = await interactionChannel!.requestApproval(toolName, summary);
        if (decision === 'approve-session') {
          sessionApproved.add(toolName);
          return true;
        }
        return decision === 'approve';
      }
    : undefined;
  // Prepend any prior conversation context, then add the current user prompt
  const messages: Message[] = [
    ...(contextMessages ?? []),
    { role: 'user', parts: [{ kind: 'text', text: prompt }] },
  ];
  if (sink) sink.messages = messages;
  const systemInstruction = systemInstructionOverride ?? buildSystemInstruction(settings, systemPromptSuffix);

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
    const ctx: ToolContext = { cwd: process.cwd(), signal, ask: askApproval };
    for (const call of toolCalls) {
      try {
        const result = await executeToolCall(call, tools, mcp, ctx);
        const toolResult: ToolResultPart = {
          kind: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          content: resultToContent(result),
          isError: result.isError,
          metadata: result.metadata,
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

// one-line summary of a tool call for the approval prompt
function describeToolCall(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (toolName === 'shell' && typeof a.command === 'string') return a.command;
  if ((toolName === 'write_file' || toolName === 'edit') && typeof a.file_path === 'string') {
    return `${toolName === 'edit' ? 'edit' : 'write'} ${a.file_path}`;
  }
  return `${toolName}(${JSON.stringify(a).slice(0, 120)})`;
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
