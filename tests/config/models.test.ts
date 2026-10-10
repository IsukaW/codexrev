import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProviders, addProvider, removeProvider, addModel, removeModel, setDefaultModel, getActiveModel, normalizeDefaults } from '../../src/config/models.js';
import { saveProjectConfig } from '../../src/config/projectConfig.js';
import { _resetFakeStore, setDek } from '../../src/security/keychain.js';
import { generateDek } from '../../src/security/secrets.js';
import type { ProjectConfig } from '../../src/config/projectSchema.js';

let tmpRoot: string;
const ORIGINAL_ENV = process.env.CODEXREV_TEST_FAKE_KEYCHAIN;

function baseCfg(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    schemaVersion: 1 as const,
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: { iv: 'a', tag: 'b', ciphertext: 'c' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-models-'));
  tmpRoot = await fs.realpath(raw);
  process.env.CODEXREV_TEST_FAKE_KEYCHAIN = '1';
  _resetFakeStore();
  const dek = generateDek();
  await setDek(tmpRoot, dek);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env.CODEXREV_TEST_FAKE_KEYCHAIN;
  else process.env.CODEXREV_TEST_FAKE_KEYCHAIN = ORIGINAL_ENV;
});

describe('listProviders', () => {
  it('returns empty array when no providers field', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    expect(await listProviders(tmpRoot)).toEqual([]);
  });

  it('returns providers from config', async () => {
    await saveProjectConfig(
      tmpRoot,
      baseCfg({
        providers: [
          { name: 'my-ollama', vendor: 'ollama', models: [{ id: 'llama3', name: 'llama3.1', default: true }] },
        ],
      }),
    );
    const providers = await listProviders(tmpRoot);
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('my-ollama');
    expect(providers[0].models).toHaveLength(1);
  });

  it('throws when no config exists', async () => {
    await expect(listProviders(tmpRoot)).rejects.toThrow(/No project config/);
  });
});

describe('addProvider', () => {
  it('adds a provider', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    const entry = await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint', baseUrl: 'https://api.deepseek.com/v1' });
    expect(entry.name).toBe('ds');
    expect(entry.vendor).toBe('customendpoint');
    expect(entry.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(entry.models).toEqual([]);
  });

  it('rejects duplicate provider name', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await expect(addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' })).rejects.toThrow(/already exists/);
  });

  it('allows same vendor with different names', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ollama-1', vendor: 'ollama' });
    await addProvider(tmpRoot, { name: 'ollama-2', vendor: 'ollama', baseUrl: 'http://remote:11434' });
    const providers = await listProviders(tmpRoot);
    expect(providers).toHaveLength(2);
  });
});

describe('removeProvider', () => {
  it('removes a provider and its models', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4' });
    await removeProvider(tmpRoot, 'ds');
    expect(await listProviders(tmpRoot)).toHaveLength(0);
  });

  it('throws for nonexistent provider', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await expect(removeProvider(tmpRoot, 'nope')).rejects.toThrow(/not found/);
  });
});

describe('addModel', () => {
  it('adds first model as default', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    const entry = await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4' });
    expect(entry.default).toBe(true);
  });

  it('adds second model as non-default', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4' });
    const second = await addModel(tmpRoot, 'ds', { id: 'ds-coder', name: 'deepseek-coder' });
    expect(second.default).toBe(false);
  });

  it('rejects duplicate model ID in same provider', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4' });
    await expect(addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4-pro' })).rejects.toThrow(/already exists/);
  });

  it('throws for nonexistent provider', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await expect(addModel(tmpRoot, 'nope', { id: 'x', name: 'x' })).rejects.toThrow(/not found/);
  });

  it('allows same model id in different providers', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'p1', vendor: 'ollama' });
    await addProvider(tmpRoot, { name: 'p2', vendor: 'ollama' });
    await addModel(tmpRoot, 'p1', { id: 'llama3', name: 'llama3.1' });
    await addModel(tmpRoot, 'p2', { id: 'llama3', name: 'llama3.1' });
    const providers = await listProviders(tmpRoot);
    expect(providers[0].models).toHaveLength(1);
    expect(providers[1].models).toHaveLength(1);
  });

  it('saves model capabilities', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    const entry = await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4', toolCalling: true, vision: true, maxInputTokens: 128000 });
    expect(entry.toolCalling).toBe(true);
    expect(entry.vision).toBe(true);
    expect(entry.maxInputTokens).toBe(128000);
  });
});

describe('removeModel', () => {
  it('removes a model', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4' });
    await removeModel(tmpRoot, 'ds', 'ds-v4');
    const providers = await listProviders(tmpRoot);
    expect(providers[0].models).toHaveLength(0);
  });

  it('promotes next model as default when removing active', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4' });
    await addModel(tmpRoot, 'ds', { id: 'ds-coder', name: 'deepseek-coder' });
    await removeModel(tmpRoot, 'ds', 'ds-v4');
    const providers = await listProviders(tmpRoot);
    expect(providers[0].models).toHaveLength(1);
    expect(providers[0].models[0].default).toBe(true);
  });

  it('throws for nonexistent model', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await expect(removeModel(tmpRoot, 'ds', 'nope')).rejects.toThrow(/not found/);
  });
});

describe('setDefaultModel', () => {
  it('switches the active model within a provider', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4' });
    await addModel(tmpRoot, 'ds', { id: 'ds-coder', name: 'deepseek-coder' });
    await setDefaultModel(tmpRoot, 'ds', 'ds-coder');
    const providers = await listProviders(tmpRoot);
    const active = providers[0].models.find((m) => m.id === 'ds-coder');
    const inactive = providers[0].models.find((m) => m.id === 'ds-v4');
    expect(active?.default).toBe(true);
    expect(inactive?.default).toBe(false);
  });

  it('throws for nonexistent model', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await expect(setDefaultModel(tmpRoot, 'ds', 'nope')).rejects.toThrow(/not found/);
  });
});

describe('global default marker', () => {
  it('a new provider\'s first model is NOT default when another provider already has one', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'p1', vendor: 'ollama' });
    await addModel(tmpRoot, 'p1', { id: 'a', name: 'a' });
    await addProvider(tmpRoot, { name: 'p2', vendor: 'ollama' });
    const second = await addModel(tmpRoot, 'p2', { id: 'b', name: 'b' });
    expect(second.default).toBe(false);

    const providers = await listProviders(tmpRoot);
    const defaults = providers.flatMap((p) => p.models).filter((m) => m.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('a');
  });

  it('setDefaultModel clears the marker in OTHER providers too', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'p1', vendor: 'ollama' });
    await addModel(tmpRoot, 'p1', { id: 'a', name: 'a' });
    await addProvider(tmpRoot, { name: 'p2', vendor: 'ollama' });
    await addModel(tmpRoot, 'p2', { id: 'b', name: 'b' });

    await setDefaultModel(tmpRoot, 'p2', 'b');

    const providers = await listProviders(tmpRoot);
    const defaults = providers.flatMap((p) => p.models).filter((m) => m.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('b');
  });

  it('listProviders heals a config with two default:true entries', async () => {
    await saveProjectConfig(
      tmpRoot,
      baseCfg({
        providers: [
          { name: 'p1', vendor: 'ollama', models: [{ id: 'a', name: 'a', default: true }] },
          { name: 'p2', vendor: 'ollama', models: [{ id: 'b', name: 'b', default: true }] },
        ],
      }),
    );
    const providers = await listProviders(tmpRoot);
    const defaults = providers.flatMap((p) => p.models).filter((m) => m.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('a'); // first in registry order wins
  });

  it('normalizeDefaults promotes the first model when none is marked', () => {
    const providers = [
      { name: 'p1', vendor: 'ollama' as const, models: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }] },
    ];
    expect(normalizeDefaults(providers)).toBe(true);
    expect(providers[0].models[0].default).toBe(true);
    expect(providers[0].models[1].default).toBe(false);
    expect(normalizeDefaults(providers)).toBe(false); // idempotent
  });
});

describe('getActiveModel', () => {
  it('returns the active model across providers', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    await addModel(tmpRoot, 'ds', { id: 'ds-v4', name: 'deepseek-v4' });
    const active = getActiveModel((await listProviders(tmpRoot)));
    expect(active?.model.id).toBe('ds-v4');
    expect(active?.provider.name).toBe('ds');
  });

  it('returns undefined when no providers have models', async () => {
    await saveProjectConfig(tmpRoot, baseCfg());
    await addProvider(tmpRoot, { name: 'ds', vendor: 'customendpoint' });
    expect(getActiveModel((await listProviders(tmpRoot)))).toBeUndefined();
  });
});
