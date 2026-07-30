import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeLocalProvider, resolveBaseUrlForProvider } from '../../src/providers/health.js';
import { LocalServerError } from '../../src/utils/errors.js';
import { providerMeta } from '../../src/providers/registry.js';

describe('resolveBaseUrlForProvider', () => {
  it('uses the registry default when no settings or env override', () => {
    const prev = process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_BASE_URL;
    try {
      expect(resolveBaseUrlForProvider('ollama')).toBe(
        providerMeta('ollama').defaultBaseUrl,
      );
    } finally {
      if (prev !== undefined) process.env.OLLAMA_BASE_URL = prev;
    }
  });

  it('prefers the env var over the registry default', () => {
    const prev = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://example.test:9999/v1';
    try {
      expect(resolveBaseUrlForProvider('ollama')).toBe('http://example.test:9999/v1');
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = prev;
    }
  });

  it('prefers settings baseUrl over env var', () => {
    const prev = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://env.test/v1';
    try {
      expect(resolveBaseUrlForProvider('ollama', 'http://settings.test/v1')).toBe(
        'http://settings.test/v1',
      );
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = prev;
    }
  });
});

describe('probeLocalProvider', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    // Start a tiny stub server that responds to /models.
    server = createServer((req, res) => {
      if (req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('resolves silently on a 2xx from /models', async () => {
    await expect(probeLocalProvider('ollama', baseUrl)).resolves.toBeUndefined();
  });

  it('throws LocalServerError on a non-2xx response', async () => {
    // Point at a port that's not listening — connect refused.
    await expect(probeLocalProvider('ollama', 'http://127.0.0.1:1')).rejects.toBeInstanceOf(
      LocalServerError,
    );
  });

  it('LocalServerError message names the provider and the base URL', async () => {
    try {
      await probeLocalProvider('lmstudio', 'http://127.0.0.1:1');
      throw new Error('expected probe to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(LocalServerError);
      const e = err as LocalServerError;
      expect(e.provider).toBe('lmstudio');
      expect(e.baseUrl).toBe('http://127.0.0.1:1');
      expect(e.message).toMatch(/lmstudio/);
      expect(e.message).toContain('http://127.0.0.1:1');
      expect(e.message.toLowerCase()).toMatch(/start|open|load/i); // fix-it hint
      expect(e.retryable).toBe(false);
    }
  });
});