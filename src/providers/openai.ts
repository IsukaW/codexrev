/**
 * Codexrev — OpenAI provider adapter.
 *
 * Wraps the official `openai` SDK and normalises its responses into
 * Codexrev's `ContentGenerator` interface.
 */

import OpenAI from 'openai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
  GenerateRequest,
  GenerateResponse,
  Message,
  StreamEvent,
  ToolCallPart,
  ToolDeclaration,
  ToolResultPart,
  UsageStats,
} from '../core/types.js';
import { ProviderError } from '../core/types.js';

export class OpenAIGenerator implements ContentGenerator {
  readonly provider = 'openai' as const;
  private readonly client: OpenAI;

  constructor(cfg: ContentGeneratorConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      maxRetries: 2,
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    try {
      const params = this.toApiParams(req);
      const r = await this.client.chat.completions.create({ ...params });
      return this.toResponse(r);
    } catch (err) {
      throw this.toError(err);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    try {
      const baseParams = this.toApiParams(req);
      const stream = await this.client.chat.completions.create({
        ...baseParams,
        stream: true,
      });
      const messageId = `msg_${Date.now()}`;
      yield { kind: 'message_start', messageId };
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' = 'stop';

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
        const delta = choice.delta;
        if (delta?.content) {
          yield { kind: 'text_delta', text: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            const existing = toolCalls.get(idx);
            if (existing) {
              if (tc.function?.arguments) existing.args += tc.function.arguments;
            } else {
              toolCalls.set(idx, {
                id: tc.id ?? `call_${idx}`,
                name: tc.function?.name ?? '',
                args: tc.function?.arguments ?? '',
              });
            }
          }
        }
      }

      for (const tc of toolCalls.values()) {
        yield {
          kind: 'tool_call',
          toolCall: {
            kind: 'tool_call',
            id: tc.id,
            name: tc.name,
            arguments: safeJsonParse(tc.args),
          } as ToolCallPart,
        };
      }

      const stats: UsageStats | undefined = undefined;
      yield {
        kind: 'finish',
        reason:
          finishReason === 'tool_calls'
            ? 'tool_use'
            : finishReason === 'length'
              ? 'max_tokens'
              : 'stop',
        usage: stats,
      };
    } catch (err) {
      throw this.toError(err);
    }
  }

  // ─── helpers ────────────────────────────────────────────────────
  private toApiParams(req: GenerateRequest): OpenAI.ChatCompletionCreateParamsNonStreaming {
    const messages: OpenAI.ChatCompletionMessageParam[] = req.messages.map(toOpenAIMessage);
    if (req.systemInstruction) {
      messages.unshift({ role: 'system', content: req.systemInstruction });
    }
    const tools = req.tools?.length ? req.tools.map(toOpenAITool) : undefined;
    return {
      model: req.model,
      messages,
      tools,
      tool_choice: tools ? ('auto' as const) : undefined,
      temperature: req.temperature,
      top_p: req.topP,
      max_tokens: req.maxOutputTokens,
      stop: req.stopSequences ? [...req.stopSequences] : undefined,
    };
  }

  private toResponse(r: OpenAI.ChatCompletion): GenerateResponse {
    const choice = r.choices[0];
    const text = choice.message.content ?? '';
    const toolCalls: ToolCallPart[] = (choice.message.tool_calls ?? []).map((tc) => ({
      kind: 'tool_call' as const,
      id: tc.id,
      name: tc.function.name,
      arguments: safeJsonParse(tc.function.arguments),
    }));
    const parts: Message['parts'] = [];
    if (text) parts.push({ kind: 'text', text });
    parts.push(...toolCalls);
    return {
      message: { role: 'assistant', parts },
      usage: this.toUsage(r.usage),
      finishReason:
        choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'completed',
    };
  }

  private toUsage(u: OpenAI.CompletionUsage | undefined): UsageStats {
    if (!u) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return {
      inputTokens: u.prompt_tokens,
      outputTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
    };
  }

  private toError(err: unknown): ProviderError {
    const e = err as { status?: number; code?: string; message?: string };
    return new ProviderError(
      e?.message ?? 'openai request failed',
      'openai',
      e?.status,
      e?.code,
      isRetryable(e?.status),
    );
  }
}

function isRetryable(status?: number): boolean {
  if (!status) return true;
  return status === 429 || status >= 500;
}

function mapFinishReason(r: string): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' {
  switch (r) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
    case 'function_call':
      return r as 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
    default:
      return 'stop';
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

function toOpenAIMessage(m: Message): OpenAI.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    const tr = m.parts.find((p): p is ToolResultPart => p.kind === 'tool_result');
    if (!tr) {
      return { role: 'tool', tool_call_id: '', content: '' };
    }
    const content = tr.content
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join('');
    return { role: 'tool', tool_call_id: tr.toolCallId, content };
  }
  if (m.role === 'assistant') {
    const text = m.parts
      .filter((p) => p.kind === 'text')
      .map((p) => (p as { kind: 'text'; text: string }).text)
      .join('');
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = m.parts
      .filter((p) => p.kind === 'tool_call')
      .map((p) => {
        const tc = p as ToolCallPart;
        return {
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        };
      });
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
  }
  const text = m.parts
    .filter((p) => p.kind === 'text')
    .map((p) => (p as { kind: 'text'; text: string }).text)
    .join('');
  return { role: 'user', content: text };
}

function toOpenAITool(t: ToolDeclaration): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  };
}
