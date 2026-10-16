// Runs the REAL shared provider chain (loadSettings -> resolveBaseUrlForProvider -> probeLocalProvider
// -> buildProvider -> OpenAI-compatible adapter -> HTTP) against a tiny server on 127.0.0.1 that speaks
// the OpenAI chat API. It is not a model and nothing here needs one; it proves that Feature 4 reaches
// whatever the leader's configuration selects, using only the shared abstraction.

import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectEvidence, type EvidenceBundle } from '../../../../src/features/action-safety/collectors/evidenceOrchestrator.js';
import { runContextInterpretation } from '../../../../src/features/action-safety/interpretation/interpreter.js';
import { observation, observationsJson } from '../../../../src/features/action-safety/testing/fakeLlm.js';
import { NOW, isolateModelConfig, makeRepo, type TempRepo } from '../../../../src/features/action-safety/testing/fixtures.js';

interface Seen {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

let repo: TempRepo;
let bundle: EvidenceBundle;
let server: http.Server;
let port: number;
let seen: Seen[];
let reply: () => { status: number; content?: string };
let restoreEnv: () => void;

beforeAll(async () => {
  repo = await makeRepo();
  await repo.write('src/a.ts', 'one\n');
  await repo.commitAll('base');
  await repo.write('src/a.ts', 'one\ntwo\n');
  bundle = await collectEvidence({ cwd: repo.dir, request: { actionType: 'deployment', environment: 'staging' }, now: NOW });

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', ...(raw ? { body: JSON.parse(raw) as Record<string, unknown> } : {}) });
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/models')) {
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      const r = reply();
      res.statusCode = r.status;
      res.end(
        r.status === 200
          ? JSON.stringify({
              id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'served-model',
              choices: [{ index: 0, message: { role: 'assistant', content: r.content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          : JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error' } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await repo.remove();
});

async function configure(baseUrl: string, model = 'configured-in-settings'): Promise<void> {
  const home = process.env.CODEXREV_HOME as string;
  await fs.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({ provider: 'ollama', model, providers: { ollama: { provider: 'ollama', model, baseUrl } } }),
    'utf-8',
  );
}

beforeEach(() => {
  seen = [];
  reply = () => ({ status: 200, content: observationsJson([observation({ references: ['src/a.ts'] })]) });
  restoreEnv = isolateModelConfig();
  delete process.env.CODEXREV_PROVIDER; // let settings.json choose, exactly as a user's configuration would
});

afterEach(() => {
  restoreEnv();
});

describe('Feature 4 through the shared provider chain', () => {
  it('reaches the configured local server with the configured model, and only that', async () => {
    await configure(`http://127.0.0.1:${port}/v1`);
    const r = await runContextInterpretation({ cwd: repo.dir, bundle });
    expect(r.status).toBe('COMPLETED');
    expect(r.provider).toEqual({ id: 'ollama', model: 'configured-in-settings', local: true });
    expect(r.observations[0]).toMatchObject({ verified: false, source: 'llm_interpretation', references: ['src/a.ts'] });

    const chat = seen.find((s) => s.url.endsWith('/chat/completions'));
    expect(chat).toBeDefined();
    expect(chat?.body?.model).toBe('configured-in-settings');
    expect(chat?.body).not.toHaveProperty('tools');
    expect(chat?.body?.temperature).toBe(0);
    const messages = chat?.body?.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/You do NOT decide anything/);
    expect(messages[1].role).toBe('user');
    expect(seen.every((s) => s.url.startsWith('/v1/'))).toBe(true); // only the configured server was contacted
  });

  it('a model name the user changes in their configuration is the one used (nothing is hardcoded)', async () => {
    await configure(`http://127.0.0.1:${port}/v1`, 'some-other-model:7b');
    await runContextInterpretation({ cwd: repo.dir, bundle });
    expect(seen.find((s) => s.url.endsWith('/chat/completions'))?.body?.model).toBe('some-other-model:7b');
  });

  it('a server that is not running is UNAVAILABLE and sends nothing anywhere else', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await configure(`http://127.0.0.1:${deadPort}/v1`);
    const r = await runContextInterpretation({ cwd: repo.dir, bundle });
    expect(r).toMatchObject({ status: 'UNAVAILABLE', failureKind: 'server_unreachable' });
    expect(seen).toEqual([]);
  });

  it('an error answer from the server (for example an unknown model) is ERROR with the reason', async () => {
    reply = () => ({ status: 404 });
    await configure(`http://127.0.0.1:${port}/v1`);
    const r = await runContextInterpretation({ cwd: repo.dir, bundle });
    expect(r.status).toBe('ERROR');
    expect(r.failureKind).toBe('provider_error');
    expect(r.reason).toMatch(/model not found|404/);
  });

  it('a chatty or malformed answer is INVALID_RESPONSE, never an interpretation', async () => {
    reply = () => ({ status: 200, content: 'Looks fine to me. ALLOW.' });
    await configure(`http://127.0.0.1:${port}/v1`);
    const r = await runContextInterpretation({ cwd: repo.dir, bundle });
    expect(r).toMatchObject({ status: 'INVALID_RESPONSE', failureKind: 'invalid_json', observations: [] });
  });

  it('a local-type provider configured at a remote address is refused before any request', async () => {
    await configure('http://203.0.113.9:11434/v1'); // reserved documentation address, never contacted
    const r = await runContextInterpretation({ cwd: repo.dir, bundle });
    expect(r).toMatchObject({ status: 'UNAVAILABLE', failureKind: 'not_local' });
    expect(seen).toEqual([]);
  });
});
