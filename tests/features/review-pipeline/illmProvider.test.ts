import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/config/schema.js';
import { PROVIDER_IDS } from '../../../src/providers/registry.js';

describe('createLLMProvider (ILLMProvider wrapper)', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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

  function settingsFor(provider: Settings['provider']): Settings {
    return {
      ...DEFAULT_SETTINGS,
      provider,
      providers: {
        ...DEFAULT_SETTINGS.providers,
        [provider]: { provider, model: 'test-model', apiKey: 'k', baseUrl },
      },
    };
  }

  it('exposes every registered provider id as a valid target', () => {
    // Sanity: the wrapper's `providerId` override param must accept every
    // id the registry knows about, including the Phase 2 deepseek addition.
    expect(PROVIDER_IDS).toContain('deepseek');
  });

  it('binds to settings.provider by default', async () => {
    const settings = settingsFor('deepseek');
    const llm = createLLMProvider(settings);
    expect(llm.id).toBe('deepseek');
    const res = await llm.generate({
      model: 'test-model',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    });
    expect(res.message.parts).toEqual([{ kind: 'text', text: 'OK' }]);
  });

  it('can target a provider other than settings.provider without mutating settings', async () => {
    const settings = settingsFor('deepseek');
    settings.providers.openai = { provider: 'openai', model: 'test-model', apiKey: 'k', baseUrl };
    const original = settings.provider;

    const llm = createLLMProvider(settings, 'openai');
    expect(llm.id).toBe('openai');
    expect(settings.provider).toBe(original); // unmutated

    const res = await llm.generate({
      model: 'test-model',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    });
    expect(res.message.parts).toEqual([{ kind: 'text', text: 'OK' }]);
  });
});
