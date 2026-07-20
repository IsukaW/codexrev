/**
 * Codexrev — shared OpenAI-compatible adapter base.
 *
 * Used by every adapter that talks to an OpenAI-shaped HTTP API: the
 * real `openai` provider, plus LiteLLM, Ollama, and LM Studio. Centralising
 * the wire-format details here keeps the per-provider classes trivial
 * (they just pin the `provider` discriminator and the default base URL)
 * and avoids bugs like the old `LiteLLMGenerator.buildMessages` that
 * silently dropped `tool` messages.
 *
 * This file is intentionally NOT exported from `src/api/index.ts`. It is
 * an internal helper for the adapter subclasses.
 */

import OpenAI from 'openai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
  GenerateRequest,
  GenerateResponse,
  Message,
  ProviderCapabilities,
  ProviderId,
  StreamEvent,
  ToolCallPart,
  ToolDeclaration,
  ToolResultPart,
  UsageStats,
} from '../core/types.js';
import { ProviderError } from '../core/types.js';
import { LocalServerError } from '../utils/errors.js';

export interface OpenAICompatOptions {
  /** Sentinel API key used when the target server doesn't require one (e.g. local Ollama). */
  readonly defaultApiKey: string;
  /** Hard-coded fallback base URL when neither settings nor env supply one. */
  readonly defaultBaseUrl: string;
  /** Whether `stream()` populates `usage` on `finish` events. */
  readonly supportsStreamingUsage: boolean;
  /** Whether `tool_calls` may be emitted. */
  readonly supportsTools: boolean;
  /** Max retries inside the OpenAI SDK. Local servers usually want 0. */
  readonly maxRetries?: number;
}

export abstract class OpenAICompatGenerator implements ContentGenerator {
  abstract readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilities;
  protected readonly client: OpenAI;
  protected readonly defaultBaseUrl: string;
  protected readonly defaultApiKey: string;

  constructor(cfg: ContentGeneratorConfig, opts: OpenAICompatOptions) {
    this.defaultBaseUrl = opts.defaultBaseUrl;
    this.defaultApiKey = opts.defaultApiKey;
    this.capabilities = {
      supportsTools: opts.supportsTools,
      supportsStreamingUsage: opts.supportsStreamingUsage,
    };
    this.client = new OpenAI({
      apiKey: cfg.apiKey ?? opts.defaultApiKey,
      baseURL: cfg.baseUrl ?? opts.defaultBaseUrl,
      maxRetries: opts.maxRetries ?? 2,
    });
  }

  /** Resolved base URL — settings → env → hard-coded default. */
  protected resolveBaseUrl(cfg: ContentGeneratorConfig): string {
    return cfg.baseUrl ?? this.defaultBaseUrl;
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
      let finishReason:
        | 'stop'
        | 'length'
        | 'tool_calls'
        | 'content_filter'
        | 'function_call'
        | null = null;

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

      // The OpenAI SDK doesn't expose a cumulative-usage hook on the
      // incremental chunk path, so streaming usage is always undefined here.
      // Anthropic populates it on its own adapter — see anthropic.ts.
      const usage: UsageStats | undefined = undefined;
      const reason = mapStreamFinishReason(finishReason);
      yield { kind: 'finish', reason, usage };
    } catch (err) {
      throw this.toError(err);
    }
  }

  // ─── helpers ────────────────────────────────────────────────────
  protected toApiParams(req: GenerateRequest): OpenAI.ChatCompletionCreateParamsNonStreaming {
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

  protected toResponse(r: OpenAI.ChatCompletion): GenerateResponse {
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
      usage: toUsage(r.usage),
      finishReason: choice.finish_reason === 'length' ? 'max_tokens' : 'completed',
    };
  }

  protected toError(err: unknown): ProviderError {
    const e = err as {
      status?: number;
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    // Translate the connection-level errors into a friendly LocalServerError so
    // users with a missing daemon see a fix-it hint instead of a stack trace.
    const causeCode = e?.code ?? e?.cause?.code;
    if (
      causeCode === 'ECONNREFUSED' ||
      causeCode === 'ENOTFOUND' ||
      causeCode === 'EHOSTUNREACH' ||
      causeCode === 'ETIMEDOUT' ||
      causeCode === 'UND_ERR_SOCKET' ||
      causeCode === 'ECONNRESET'
    ) {
      throw new LocalServerError(this.provider, this.defaultBaseUrl, e?.message ?? causeCode ?? 'connection failed');
    }
    return new ProviderError(
      e?.message ?? `${this.provider} request failed`,
      this.provider,
      e?.status,
      e?.code,
      isRetryable(e?.status),
    );
  }
}

// ─── shared helpers (also re-used by the OpenAI subclass) ─────────

function isRetryable(status?: number): boolean {
  if (!status) return true;
  return status === 429 || status >= 500;
}

function mapFinishReason(
  r: string,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' {
  switch (r) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
    case 'function_call':
      return r;
    default:
      return 'stop';
  }
}

function mapStreamFinishReason(
  r: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null,
): 'stop' | 'max_tokens' | 'tool_use' {
  if (r === 'length') return 'max_tokens';
  if (r === 'tool_calls' || r === 'function_call') return 'tool_use';
  return 'stop';
}

export function safeJsonParse(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

function toUsage(u: OpenAI.CompletionUsage | undefined): UsageStats {
  if (!u) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
  };
}

function toOpenAIMessage(m: Message): OpenAI.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    const tr = m.parts.find((p): p is ToolResultPart => p.kind === 'tool_result');
    if (!tr) {
      return { role: 'tool', tool_call_id: '', content: '' };
    }
    const content = tr.content.map((p) => (p.kind === 'text' ? p.text : '')).join('');
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