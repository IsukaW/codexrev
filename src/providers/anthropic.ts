/**
 * Codexrev — Anthropic provider adapter.
 *
 * Wraps the official `@anthropic-ai/sdk` and normalises its responses
 * into Codexrev's `ContentGenerator` interface.
 */

import Anthropic from '@anthropic-ai/sdk';
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

export class AnthropicGenerator implements ContentGenerator {
  readonly provider = 'anthropic' as const;
  readonly capabilities = {
    supportsTools: true,
    supportsStreamingUsage: true,
  } as const;
  private readonly client: Anthropic;

  constructor(cfg: ContentGeneratorConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      maxRetries: 2,
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    try {
      const params = this.toApiParams(req);
      const r = await this.client.messages.create({ ...params, stream: false });
      return this.toResponse(r);
    } catch (err) {
      throw this.toError(err);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    try {
      const params = this.toApiParams(req);
      const stream = this.client.messages.stream({ ...params });
      const messageId = `msg_${Date.now()}`;
      yield { kind: 'message_start', messageId };
      const toolCalls = new Map<string, { id: string; name: string; args: string }>();
      let usage: UsageStats | undefined;
      let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' = 'end_turn';

      for await (const ev of stream) {
        if (ev.type === 'content_block_start') {
          const block = ev.content_block;
          if (block.type === 'tool_use') {
            toolCalls.set(block.id, { id: block.id, name: block.name, args: '' });
          }
        } else if (ev.type === 'content_block_delta') {
          const delta = ev.delta;
          if (delta.type === 'text_delta') {
            yield { kind: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            for (const tc of toolCalls.values()) {
              if (String(tc.id) === String(ev.index) || toolCalls.size === 1) {
                tc.args += delta.partial_json;
                break;
              }
            }
          }
        } else if (ev.type === 'content_block_stop') {
          // nothing to do
        } else if (ev.type === 'message_delta') {
          if (ev.delta.stop_reason) {
            // Cast through `unknown` so TS doesn't narrow the local.
            stopReason = ev.delta.stop_reason as unknown as typeof stopReason;
          }
          if (ev.usage) {
            const u = ev.usage as Anthropic.MessageDeltaUsage & {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
              cacheReadTokens: u.cache_read_input_tokens,
              cacheWriteTokens: u.cache_creation_input_tokens,
            };
          }
        } else if (ev.type === 'message_stop') {
          break;
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

      // Re-widen via double-cast — flow analysis collapses the union otherwise.
      const sr = stopReason as unknown as 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';
      const finishReason: 'stop' | 'max_tokens' | 'tool_use' =
        sr === 'max_tokens'
          ? 'max_tokens'
          : sr === 'tool_use'
            ? 'tool_use'
            : 'stop';
      yield {
        kind: 'finish',
        reason: finishReason,
        usage,
      };
    } catch (err) {
      throw this.toError(err);
    }
  }

  // ─── helpers ────────────────────────────────────────────────────
  private toApiParams(req: GenerateRequest) {
    const system = req.systemInstruction ?? '';
    const messages: Anthropic.MessageParam[] = [];
    for (const m of req.messages) {
      if (m.role === 'user') {
        const text = m.parts
          .filter((p) => p.kind === 'text')
          .map((p) => (p as { kind: 'text'; text: string }).text)
          .join('\n');
        messages.push({ role: 'user', content: text });
      } else if (m.role === 'assistant') {
        const blocks: Anthropic.ContentBlock[] = [];
        for (const p of m.parts) {
          if (p.kind === 'text') blocks.push({ type: 'text', text: p.text });
          else if (p.kind === 'tool_call') {
            blocks.push({
              type: 'tool_use',
              id: p.id,
              name: p.name,
              input: (p.arguments as Record<string, unknown>) ?? {},
            });
          }
        }
        messages.push({ role: 'assistant', content: blocks });
      } else if (m.role === 'tool') {
        for (const p of m.parts) {
          if (p.kind === 'tool_result') {
            const tr = p as ToolResultPart;
            const text = tr.content
              .filter((c) => c.kind === 'text')
              .map((c) => (c as { kind: 'text'; text: string }).text)
              .join('\n');
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: tr.toolCallId,
                  content: text,
                  is_error: tr.isError,
                },
              ],
            });
          }
        }
      }
    }
    const tools: Anthropic.Tool[] | undefined = req.tools?.map(toAnthropicTool);
    return {
      model: req.model,
      system,
      messages,
      tools,
      max_tokens: req.maxOutputTokens ?? 4096,
      temperature: req.temperature,
      top_p: req.topP,
      stop_sequences: req.stopSequences as string[] | undefined,
    };
  }

  private toResponse(r: Anthropic.Message): GenerateResponse {
    const parts: Message['parts'] = [];
    for (const block of r.content) {
      if (block.type === 'text') {
        parts.push({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({
          kind: 'tool_call',
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }
    return {
      message: { role: 'assistant', parts },
      usage: {
        inputTokens: r.usage.input_tokens,
        outputTokens: r.usage.output_tokens,
        totalTokens: r.usage.input_tokens + r.usage.output_tokens,
        cacheReadTokens: (r.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
        cacheWriteTokens: (r.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
      },
      finishReason: r.stop_reason === 'max_tokens' ? 'max_tokens' : 'completed',
    };
  }

  private toError(err: unknown): ProviderError {
    const e = err as { status?: number; code?: string; message?: string };
    return new ProviderError(
      e?.message ?? 'anthropic request failed',
      'anthropic',
      e?.status,
      e?.code,
      isRetryable(e?.status),
    );
  }
}

function isRetryable(status?: number): boolean {
  if (!status) return true;
  return status === 429 || status === 529 || status >= 500;
}

function safeJsonParse(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

function toAnthropicTool(t: ToolDeclaration): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  };
}
