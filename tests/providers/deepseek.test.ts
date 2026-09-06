import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeepSeekGenerator } from '../../src/providers/deepseek.js';
import type { ContentGeneratorConfig, GenerateRequest } from '../../src/core/types.js';

describe('DeepSeekGenerator', () => {
  let server: Server;
  let baseUrl: string;
  let lastRequestBody: unknown;

  beforeEach(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastRequestBody = JSON.parse(body || '{}');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'OK' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is discriminated as the "deepseek" provider', () => {
    const cfg: ContentGeneratorConfig = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k', baseUrl };
    const gen = new DeepSeekGenerator(cfg);
    expect(gen.provider).toBe('deepseek');
    expect(gen.capabilities.supportsTools).toBe(true);
  });

  it('generates a response through the OpenAI-compatible wire format', async () => {
    const cfg: ContentGeneratorConfig = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k', baseUrl };
    const gen = new DeepSeekGenerator(cfg);
    const req: GenerateRequest = {
      model: 'deepseek-chat',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'ping' }] }],
    };
    const res = await gen.generate(req);
    expect(res.finishReason).toBe('completed');
    expect(res.message.parts).toEqual([{ kind: 'text', text: 'OK' }]);
    expect(res.usage.totalTokens).toBe(6);
    expect((lastRequestBody as { model: string }).model).toBe('deepseek-chat');
  });
});
