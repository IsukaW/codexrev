import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings } from '../../src/config/loader.js';
import { _resetFakeStore, setDek } from '../../src/security/keychain.js';
import { encrypt, generateDek } from '../../src/security/secrets.js';
import { saveProjectConfig } from '../../src/config/projectConfig.js';

let tmpRoot: string;
const ORIGINAL_ENV = process.env.CODEXREV_TEST_FAKE_KEYCHAIN;
const ORIGINAL_HOME = process.env.CODEXREV_HOME;
let origCwd: string;

beforeEach(async () => {
  origCwd = process.cwd();
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-loader-'));
  tmpRoot = await fs.realpath(raw);
  process.env.CODEXREV_TEST_FAKE_KEYCHAIN = '1';
  process.env.CODEXREV_HOME = path.join(tmpRoot, '.codexrev-home');
  _resetFakeStore();
});

afterEach(async () => {
  process.chdir(origCwd);
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env.CODEXREV_TEST_FAKE_KEYCHAIN;
  else process.env.CODEXREV_TEST_FAKE_KEYCHAIN = ORIGINAL_ENV;
  if (ORIGINAL_HOME === undefined) delete process.env.CODEXREV_HOME;
  else process.env.CODEXREV_HOME = ORIGINAL_HOME;
});

describe('loadSettings with project config', () => {
  it('uses defaults when nothing exists', async () => {
    process.chdir(tmpRoot);
    const s = await loadSettings();
    expect(s.provider).toBe('openai');
    expect(s.providers.openai.model).toBe('gpt-4o');
    expect(s.providers.openai.apiKey).toBeUndefined();
    // Registry-driven defaults: local providers should be wired even when
    // nothing has been persisted yet.
    expect(s.providers.ollama.model).toBe('llama3.1');
    expect(s.providers.lmstudio.model).toBe('qwen2.5-7b-instruct');
    expect(s.providers.litellm.model).toBe('gpt-4o');
  });

  it('merges project config and decrypts the api key', async () => {
    process.chdir(tmpRoot);
    const dek = generateDek();
    await setDek(tmpRoot, dek);
    await saveProjectConfig(tmpRoot, {
      schemaVersion: 1,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: encrypt('sk-ant-test-xyz', dek),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const s = await loadSettings();
    expect(s.provider).toBe('anthropic');
    expect(s.model).toBe('claude-3-5-sonnet-20241022');
    expect(s.providers.anthropic.apiKey).toBe('sk-ant-test-xyz');
  });

  it('throws when DEK is missing', async () => {
    process.chdir(tmpRoot);
    const dek = generateDek();
    // save config but DO NOT set the DEK
    await saveProjectConfig(tmpRoot, {
      schemaVersion: 1,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: encrypt('sk-test', dek),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    await expect(loadSettings()).rejects.toThrow(/no matching DEK/);
  });

  it('resolves active model from providers array', async () => {
    process.chdir(tmpRoot);
    const dek = generateDek();
    await setDek(tmpRoot, dek);
    await saveProjectConfig(tmpRoot, {
      schemaVersion: 1,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: encrypt('sk-test', dek),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      providers: [
        { name: 'my-openai', vendor: 'openai', models: [
          { id: 'gpt4', name: 'gpt-4o', default: false },
          { id: 'gpt4-turbo', name: 'gpt-4-turbo', default: true },
        ]},
      ],
    });

    const s = await loadSettings();
    expect(s.model).toBe('gpt4-turbo');
    expect(s.providers.openai.model).toBe('gpt4-turbo');
  });

  it('resolves active model with per-provider API key', async () => {
    process.chdir(tmpRoot);
    const dek = generateDek();
    await setDek(tmpRoot, dek);
    await saveProjectConfig(tmpRoot, {
      schemaVersion: 1,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: encrypt('sk-legacy', dek),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      providers: [
        { name: 'my-ds', vendor: 'customendpoint', baseUrl: 'https://api.deepseek.com/v1', apiKey: encrypt('sk-ds-test', dek), models: [
          { id: 'ds-v4', name: 'deepseek-v4', default: true },
        ]},
      ],
    });

    const s = await loadSettings();
    expect(s.model).toBe('ds-v4');
    expect(s.providers.openai.apiKey).toBe('sk-ds-test');
  });

  it('falls back to legacy single-key path when no providers', async () => {
    process.chdir(tmpRoot);
    const dek = generateDek();
    await setDek(tmpRoot, dek);
    await saveProjectConfig(tmpRoot, {
      schemaVersion: 1,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: encrypt('sk-test', dek),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const s = await loadSettings();
    expect(s.model).toBe('gpt-4o');
    expect(s.providers.openai.apiKey).toBe('sk-test');
  });

  it('falls back to static model when providers has no models', async () => {
    process.chdir(tmpRoot);
    const dek = generateDek();
    await setDek(tmpRoot, dek);
    await saveProjectConfig(tmpRoot, {
      schemaVersion: 1,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: encrypt('sk-test', dek),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      providers: [
        { name: 'my-openai', vendor: 'openai', models: [] },
      ],
    });

    const s = await loadSettings();
    expect(s.model).toBe('gpt-4o');
  });

  it('throws on tampered ciphertext', async () => {
    process.chdir(tmpRoot);
    const dek = generateDek();
    await setDek(tmpRoot, dek);
    const sealed = encrypt('sk-test', dek);
    // tamper with ciphertext
    const tampered = {
      ...sealed,
      ciphertext: (() => {
        const buf = Buffer.from(sealed.ciphertext, 'base64');
        buf[0] = buf[0] ^ 0xff;
        return buf.toString('base64');
      })(),
    };
    await saveProjectConfig(tmpRoot, {
      schemaVersion: 1,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: tampered,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await expect(loadSettings()).rejects.toThrow(/decrypt API key/);
  });
});