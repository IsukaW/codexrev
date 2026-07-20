/**
 * Codexrev — Google Gemini provider adapter.
 *
 * Wraps the official `@google/genai` SDK and normalises its responses
 * into Codexrev's `ContentGenerator` interface.
 */

import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
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

export class GoogleGenerator implements ContentGenerator {
  readonly provider = 'google' as const;
  readonly capabilities = {
    supportsTools: true,
    supportsStreamingUsage: false,
  } as const;
  private readonly client: GoogleGenAI;

  constructor(cfg: ContentGeneratorConfig) {
    if (!cfg.apiKey) {
      throw new ProviderError(
        'Google provider requires GOOGLE_API_KEY',
        'google',
        undefined,
        undefined,
        false,
      );
    }
    this.client = new GoogleGenAI({ apiKey: cfg.apiKey });
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    try {
      const params = this.toApiParams(req);
      const r = await this.client.models.generateContent({
        model: req.model,
        ...params,
      });
      return this.toResponse(r);
    } catch (err) {
      throw this.toError(err);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    try {
      const params = this.toApiParams(req);
      const messageId = `msg_${Date.now()}`;
      yield { kind: 'message_start', messageId };
      const result = await this.client.models.generateContentStream({
        model: req.model,
        ...params,
      });
      for await (const chunk of result) {
        const text = chunk.text ?? '';
        if (text) yield { kind: 'text_delta', text };
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if ('functionCall' in part && part.functionCall) {
            const fc = part.functionCall;
            yield {
              kind: 'tool_call',
              toolCall: {
                kind: 'tool_call',
                id: fc.id ?? `call_${Math.random().toString(36).slice(2)}`,
                name: fc.name ?? '',
                arguments: fc.args ?? {},
              } as ToolCallPart,
            };
          }
        }
      }
      yield { kind: 'finish', reason: 'stop' };
    } catch (err) {
      throw this.toError(err);
    }
  }

  // ─── helpers ────────────────────────────────────────────────────
  private toApiParams(req: GenerateRequest) {
    const contents = req.messages.map(toGoogleContent);
    const tools = req.tools?.length
      ? [{ functionDeclarations: req.tools.map(toGoogleTool) as never }]
      : undefined;
    return {
      contents: contents as never,
      systemInstruction: req.systemInstruction ?? '',
      config: {
        temperature: req.temperature,
        topP: req.topP,
        maxOutputTokens: req.maxOutputTokens,
        stopSequences: req.stopSequences as string[] | undefined,
        tools,
      },
    };
  }

  private toResponse(r: GenerateContentResponse): GenerateResponse {
    const parts: Message['parts'] = [];
    const cand = r.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if ('text' in part && part.text) {
        parts.push({ kind: 'text', text: part.text });
      } else if ('functionCall' in part && part.functionCall) {
        const fc = part.functionCall;
        parts.push({
          kind: 'tool_call',
          id: fc.id ?? `call_${Math.random().toString(36).slice(2)}`,
          name: fc.name ?? '',
          arguments: fc.args ?? {},
        });
      }
    }
    const meta = r.usageMetadata;
    const usage: UsageStats = {
      inputTokens: meta?.promptTokenCount ?? 0,
      outputTokens: meta?.candidatesTokenCount ?? 0,
      totalTokens: meta?.totalTokenCount ?? 0,
    };
    return {
      message: { role: 'assistant', parts },
      usage,
      finishReason: cand?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'completed',
    };
  }

  private toError(err: unknown): ProviderError {
    const e = err as { status?: number; code?: string; message?: string };
    return new ProviderError(
      e?.message ?? 'google request failed',
      'google',
      e?.status,
      e?.code,
      isRetryable(e?.status),
    );
  }
}

function isRetryable(status?: number): boolean {
  if (!status) return true;
  return status === 429 || status === 503 || status >= 500;
}

function toGoogleContent(m: Message) {
  if (m.role === 'user') {
    return {
      role: 'user' as const,
      parts: m.parts
        .filter((p) => p.kind === 'text')
        .map((p) => ({ text: (p as { kind: 'text'; text: string }).text })),
    };
  }
  if (m.role === 'assistant') {
    const parts: unknown[] = [];
    for (const p of m.parts) {
      if (p.kind === 'text') parts.push({ text: p.text });
      else if (p.kind === 'tool_call') {
        parts.push({ functionCall: { name: p.name, args: p.arguments, id: p.id } });
      }
    }
    return { role: 'model' as const, parts };
  }
  if (m.role === 'tool') {
    const parts: unknown[] = [];
    for (const p of m.parts) {
      if (p.kind === 'tool_result') {
        const tr = p as ToolResultPart;
        const text = tr.content
          .filter((c) => c.kind === 'text')
          .map((c) => (c as { kind: 'text'; text: string }).text)
          .join('\n');
        parts.push({
          functionResponse: { name: tr.name, id: tr.toolCallId, response: { result: text, isError: tr.isError } },
        });
      }
    }
    return { role: 'user' as const, parts };
  }
  return { role: 'user' as const, parts: [{ text: '' }] };
}

function toGoogleTool(t: ToolDeclaration) {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as Record<string, unknown>,
  };
}
