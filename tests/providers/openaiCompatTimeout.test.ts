/**
 * Codexrev — `ContentGeneratorConfig.timeoutMs` override (OpenAI-compat
 * providers: OpenAI, DeepSeek, Ollama, LM Studio, LiteLLM).
 *
 * Reported live: a local Ollama model (12B, on modest hardware) was
 * genuinely still working, just slower than the OpenAI SDK's
 * hard-coded 10-minute default timeout — which `ContentGeneratorConfig`
 * had no way to override, silently killing legitimate-if-slow local-
 * model requests. `DeepSeekGenerator` is used here (any OpenAI-compat
 * subclass exercises the same shared `_openaiCompat.ts` code path) with
 * a real local HTTP server that deliberately responds late, so the
 * timeout being asserted is the real SDK behavior, not a mock.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeepSeekGenerator } from '../../src/providers/deepseek.js';
import type { ContentGeneratorConfig, GenerateRequest } from '../../src/core/types.js';

describe('ContentGeneratorConfig.timeoutMs (OpenAI-compat providers)', () => {
  let server: Server;
  let baseUrl: string;
  let responseDelayMs = 0;

  beforeEach(async () => {
    server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        );
      }, responseDelayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const req: GenerateRequest = {
    model: 'deepseek-chat',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'ping' }] }],
  };

  it('rejects once a short configured timeout elapses, even though the server would eventually respond', async () => {
    responseDelayMs = 500;
    const cfg: ContentGeneratorConfig = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k', baseUrl, timeoutMs: 100 };
    const gen = new DeepSeekGenerator(cfg);

    await expect(gen.generate(req)).rejects.toThrow();
  }, 10_000);

  it('succeeds when the response arrives within a generous configured timeout — a slow-but-working request is not killed', async () => {
    responseDelayMs = 300;
    const cfg: ContentGeneratorConfig = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k', baseUrl, timeoutMs: 5_000 };
    const gen = new DeepSeekGenerator(cfg);

    const res = await gen.generate(req);
    expect(res.message.parts).toEqual([{ kind: 'text', text: 'OK' }]);
  }, 10_000);

  it('leaves the SDK default untouched when timeoutMs is omitted (regression: existing behavior for every other caller)', async () => {
    responseDelayMs = 50;
    const cfg: ContentGeneratorConfig = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k', baseUrl };
    const gen = new DeepSeekGenerator(cfg);

    const res = await gen.generate(req);
    expect(res.message.parts).toEqual([{ kind: 'text', text: 'OK' }]);
  });
});
