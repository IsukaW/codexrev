// Test-only fake of the shared ContentGenerator interface, for the interpretation tests.
// It records every request it receives, so tests can inspect exactly what would have been
// sent to a model, and it never touches the network. Lives under testing/ like the other fixtures.

import type { ContentGenerator, GenerateRequest, GenerateResponse, ProviderId, StreamEvent } from '../../../core/types.js';

export interface FakeGenerator extends ContentGenerator {
  /** every request received, in order */
  readonly calls: GenerateRequest[];
}

export function textResponse(text: string, extraParts: GenerateResponse['message']['parts'] = []): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }, ...extraParts] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'completed',
  };
}

function build(provider: ProviderId, impl: (req: GenerateRequest) => Promise<GenerateResponse>): FakeGenerator {
  const calls: GenerateRequest[] = [];
  return {
    provider,
    capabilities: { supportsTools: false, supportsStreamingUsage: false },
    calls,
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      calls.push(req);
      return impl(req);
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<StreamEvent> {
      throw new Error('stream is not used by the interpretation layer');
    },
  };
}

/** Replies with a fixed string, or computes one from the request. */
export function fakeGenerator(
  reply: string | GenerateResponse | ((req: GenerateRequest) => string | GenerateResponse | Promise<string | GenerateResponse>),
  provider: ProviderId = 'ollama',
): FakeGenerator {
  return build(provider, async (req) => {
    const r = typeof reply === 'function' ? await reply(req) : reply;
    return typeof r === 'string' ? textResponse(r) : r;
  });
}

/** Rejects every call with the given error. */
export function failingGenerator(error: unknown, provider: ProviderId = 'ollama'): FakeGenerator {
  return build(provider, async () => {
    throw error;
  });
}

/** Never answers, to exercise the timeout. */
export function hangingGenerator(provider: ProviderId = 'ollama'): FakeGenerator {
  return build(provider, () => new Promise<GenerateResponse>(() => undefined));
}

/** A schema-version-1 response body for the given observations. */
export function observationsJson(observations: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, summary: 'Model summary.', observations, ...extra });
}

export function observation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'obs-1',
    category: 'evidence_gap',
    kind: 'information_gap',
    significance: 'medium',
    description: 'No security report was supplied.',
    references: [],
    ...over,
  };
}
