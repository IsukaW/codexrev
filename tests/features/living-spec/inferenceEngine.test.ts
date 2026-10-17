import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  type GenerateRequest,
  type GenerateResponse,
} from '../../../src/core/types.js';
import {
  runImplicationInference,
  type InferenceResult,
} from '../../../src/features/living-spec/pipeline/inferenceEngine.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';

const OPTIONS = {
  model: 'qwen2.5-coder',
  provider: 'lmstudio',
  timeoutMs: 1_000,
  maxTimeoutRetries: 0,
} as const;

function goodPayload() {
  return {
    implications: [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The greeting must include the caller name.',
        rationale: 'The greeting format changed.',
        confidence: 0.9,
        sourceRefs: [{ path: 'src/greet.js', line: 3 }],
      },
    ],
    behaviourChangeSummary: 'The greeting now greets by name.',
    requiresUrsUpdate: true,
  };
}

function textResponse(text: string): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
    finishReason: 'stop',
  };
}

function port(run: (req: GenerateRequest) => Promise<GenerateResponse>): {
  llm: LLMPort;
  calls: () => number;
} {
  let calls = 0;
  return {
    llm: {
      provider: 'lmstudio',
      model: 'qwen2.5-coder',
      generate: (req) => {
        calls++;
        return run(req);
      },
    },
    calls: () => calls,
  };
}

function goodPort() {
  return port(async () => textResponse(JSON.stringify(goodPayload())));
}

const INPUT = { diff: '--- a/src/greet.js\n+hi\n' };

describe('runImplicationInference — success', () => {
  it('parses, validates and returns the output with quality metadata', async () => {
    const { llm } = goodPort();
    const res = await runImplicationInference(INPUT, llm, OPTIONS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.implications).toHaveLength(1);
      expect(res.output.requiresUrsUpdate).toBe(true);
      expect(res.quality.model).toBe('qwen2.5-coder');
      expect(res.quality.schemaValid).toBe(true);
      expect(res.quality.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.quality.usage).toEqual({
        inputTokens: 10,
        outputTokens: 6,
        totalTokens: 16,
      });
    }
  });

  it('extracts JSON wrapped in a code fence', async () => {
    const { llm } = port(async () =>
      textResponse('```json\n' + JSON.stringify(goodPayload()) + '\n```'),
    );
    const res = await runImplicationInference(INPUT, llm, OPTIONS);
    expect(res.ok).toBe(true);
  });
});

describe('runImplicationInference — failure policy (prior state untouched)', () => {
  it('returns a structured timeout error and no output when the model hangs', async () => {
    const { llm, calls } = port(() => new Promise<GenerateResponse>(() => undefined));
    const res = await runImplicationInference(INPUT, llm, {
      ...OPTIONS,
      timeoutMs: 25,
      maxTimeoutRetries: 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('timeout');
      expect(res.error.retryable).toBe(true);
    }
    expect('output' in res).toBe(false);
    expect(calls()).toBe(1);
  });

  it('retries once on timeout (configurable) then gives up', async () => {
    const { llm, calls } = port(() => new Promise<GenerateResponse>(() => undefined));
    const res = await runImplicationInference(INPUT, llm, {
      ...OPTIONS,
      timeoutMs: 20,
      maxTimeoutRetries: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('timeout');
    expect(calls()).toBe(2);
  });

  it('does not retry on timeout when retries are disabled', async () => {
    const { llm, calls } = port(() => new Promise<GenerateResponse>(() => undefined));
    await runImplicationInference(INPUT, llm, {
      ...OPTIONS,
      timeoutMs: 15,
      maxTimeoutRetries: 0,
    });
    expect(calls()).toBe(1);
  });

  it('returns a malformed_output error for non-JSON text', async () => {
    const { llm } = port(async () => textResponse('sorry, I cannot produce that right now'));
    const res = await runImplicationInference(INPUT, llm, OPTIONS);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('malformed_output');
      expect(res.error.retryable).toBe(false);
    }
    expect('output' in res).toBe(false);
  });

  it('returns a schema_invalid error and never yields the bad output', async () => {
    const bad = goodPayload();
    (bad.implications[0] as { confidence: number }).confidence = 1.5;
    const { llm } = port(async () => textResponse(JSON.stringify(bad)));
    const res = await runImplicationInference(INPUT, llm, OPTIONS);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('schema_invalid');
      expect(res.quality.schemaValid).toBe(false);
    }
    expect('output' in res).toBe(false);
  });

  it('returns provider_unavailable without retrying on a dropped connection', async () => {
    const { llm, calls } = port(() =>
      Promise.reject(new ProviderError('connect ECONNREFUSED 127.0.0.1:1234', 'lmstudio')),
    );
    const res = await runImplicationInference(INPUT, llm, {
      ...OPTIONS,
      maxTimeoutRetries: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('provider_unavailable');
    expect(calls()).toBe(1);
  });

  it('records quality metadata (model id) even on failure', async () => {
    const { llm } = port(async () => textResponse('not json'));
    const res: InferenceResult = await runImplicationInference(INPUT, llm, OPTIONS);
    expect(res.quality.model).toBe('qwen2.5-coder');
    expect(res.quality.provider).toBe('lmstudio');
    expect(res.quality.schemaValid).toBe(false);
    expect(res.quality.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
