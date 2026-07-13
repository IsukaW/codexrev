/**
 * Codexrev — LiteLLM provider adapter.
 *
 * LiteLLM exposes an OpenAI-compatible HTTP API, so this adapter
 * re-uses the OpenAI client with a custom base URL.
 */

import OpenAI from 'openai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
  GenerateRequest,
  GenerateResponse,
  StreamEvent,
  UsageStats,
} from '../core/types.js';
import { ProviderError } from '../core/types.js';

export class LiteLLMGenerator implements ContentGenerator {
  readonly provider = 'litellm' as const;
  private readonly client: OpenAI;

  constructor(cfg: ContentGeneratorConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey ?? 'litellm',
      baseURL: cfg.baseUrl ?? 'http://localhost:4000',
      maxRetries: 2,
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    try {
      // Reuse the OpenAI client — LiteLLM is wire-compatible.
      const r = await this.client.chat.completions.create({
        model: req.model,
        messages: buildMessages(req),
        tools: req.tools?.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> },
        })),
        temperature: req.temperature,
        top_p: req.topP,
        max_tokens: req.maxOutputTokens,
        stream: false,
      });
      const choice = r.choices[0];
      const text = choice.message.content ?? '';
      const toolCalls = (choice.message.tool_calls ?? []).map((tc) => ({
        kind: 'tool_call' as const,
        id: tc.id,
        name: tc.function.name,
        arguments: safeJsonParse(tc.function.arguments),
      }));
      return {
        message: { role: 'assistant', parts: [{ kind: 'text' as const, text }, ...toolCalls] },
        usage: {
          inputTokens: r.usage?.prompt_tokens ?? 0,
          outputTokens: r.usage?.completion_tokens ?? 0,
          totalTokens: r.usage?.total_tokens ?? 0,
        },
        finishReason:
          choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'completed',
      };
    } catch (err) {
      throw new ProviderError(
        (err as Error).message ?? 'litellm request failed',
        'litellm',
        (err as { status?: number }).status,
        (err as { code?: string }).code,
        true,
      );
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    try {
      const stream = await this.client.chat.completions.create({
        model: req.model,
        messages: buildMessages(req),
        tools: req.tools?.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> },
        })),
        temperature: req.temperature,
        top_p: req.topP,
        max_tokens: req.maxOutputTokens,
        stream: true,
      });
      yield { kind: 'message_start', messageId: `msg_${Date.now()}` };
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) yield { kind: 'text_delta', text: choice.delta.content };
        for (const tc of choice.delta?.tool_calls ?? []) {
          if (tc.function?.name) {
            yield {
              kind: 'tool_call',
              toolCall: {
                kind: 'tool_call',
                id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
                name: tc.function.name,
                arguments: safeJsonParse(tc.function.arguments ?? ''),
              },
            };
          }
        }
      }
      // Stream does not expose a finalChatCompletion() hook in this OpenAI SDK
      // version — skip usage and yield a finish event with no usage.
      const usage: UsageStats | undefined = undefined;
      yield { kind: 'finish', reason: 'stop', usage };
    } catch (err) {
      throw new ProviderError(
        (err as Error).message ?? 'litellm stream failed',
        'litellm',
        (err as { status?: number }).status,
        undefined,
        true,
      );
    }
  }
}

function buildMessages(req: GenerateRequest) {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  if (req.systemInstruction) out.push({ role: 'system', content: req.systemInstruction });
  for (const m of req.messages) {
    if (m.role === 'user') {
      const text = m.parts
        .filter((p) => p.kind === 'text')
        .map((p) => (p as { kind: 'text'; text: string }).text)
        .join('');
      out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = m.parts
        .filter((p) => p.kind === 'text')
        .map((p) => (p as { kind: 'text'; text: string }).text)
        .join('');
      out.push({ role: 'assistant', content: text });
    }
  }
  return out;
}

function safeJsonParse(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}
