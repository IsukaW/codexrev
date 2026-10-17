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

// The failure from a live --fix run: the endpoint starts the response, then the connection drops
// ("Invalid response body while trying to fetch …: read ECONNRESET"). The SDK does not retry that.
describe('createLLMProvider — a connection dropped mid-response', () => {
  let server: Server;
  let baseUrl: string;
  let requests = 0;
  let failFirst = 1;

  beforeEach(async () => {
    requests = 0;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests++;
        if (requests <= failFirst) {
          // headers and half a body, then a TCP reset — what produces the SDK's "read ECONNRESET"
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
          res.write('{"id":"chatcmpl-test","choi');
          setTimeout(() => req.socket.resetAndDestroy(), 20);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/v1`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const settings = (): Settings => ({
    ...DEFAULT_SETTINGS,
    provider: 'openai',
    providers: { ...DEFAULT_SETTINGS.providers, openai: { provider: 'openai', model: 'm', apiKey: 'k', baseUrl } },
  });
  const ask = { model: 'm', messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] }] };

  it('retries, tells the caller why, and succeeds', async () => {
    failFirst = 2;
    const retries: string[] = [];
    const llm = createLLMProvider(settings(), undefined, { delaysMs: [0, 0, 0], onRetry: (r) => retries.push(`${r.attempt}/${r.of} ${r.reason}`) });
    const res = await llm.generate(ask);
    expect(res.message.parts).toEqual([{ kind: 'text', text: 'OK' }]);
    expect(requests).toBe(3);
    expect(retries).toEqual([expect.stringMatching(/^2\/4 connection dropped/), expect.stringMatching(/^3\/4 connection dropped/)]);
  });

  it('gives up after the last retry with an error that does not tell you to start a running service', async () => {
    failFirst = 99;
    const llm = createLLMProvider(settings(), undefined, { delaysMs: [0, 0] });
    const err = (await llm.generate(ask).catch((e: unknown) => e)) as Error;
    expect(requests).toBe(3);
    expect(err.message).not.toMatch(/Start the openai service/);
  });
});

describe('transientReason', () => {
  it('retries dropped connections, 429 and 5xx; not bad requests, and not a local server that is not running', async () => {
    const { transientReason } = await import('../../../src/features/review-pipeline/pipeline/illmProvider.js');
    const { ProviderError } = await import('../../../src/core/types.js');
    expect(transientReason(new Error('Invalid response body while trying to fetch https://x/v1/chat/completions: read ECONNRESET'), 'openai')).toMatch(/connection dropped/);
    expect(transientReason(new ProviderError('slow down', 'openai', 429), 'openai')).toMatch(/429/);
    expect(transientReason(new ProviderError('boom', 'openai', 503), 'openai')).toMatch(/503/);
    expect(transientReason(new ProviderError('bad model', 'openai', 400), 'openai')).toBeNull();
    expect(transientReason(new ProviderError('no key', 'openai', 401), 'openai')).toBeNull();
    expect(transientReason(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }), 'ollama')).toBeNull();
    expect(transientReason(new Error('Request timed out.'), 'openai')).toBeNull(); // the configured timeoutMs, not a network blip
  });
});
