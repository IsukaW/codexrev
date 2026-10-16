import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../../../src/config/schema.js';
import type { ContentGenerator, ProviderId } from '../../../../src/core/types.js';
import { ConfigError, LocalServerError } from '../../../../src/utils/errors.js';
import { isLoopbackUrl, selectInterpretationProvider } from '../../../../src/features/action-safety/interpretation/providerSelection.js';
import { fakeGenerator } from '../../../../src/features/action-safety/testing/fakeLlm.js';
import { isolateModelConfig } from '../../../../src/features/action-safety/testing/fixtures.js';

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = isolateModelConfig();
});
afterEach(() => {
  restoreEnv();
});

function settingsFor(provider: ProviderId, model: string, baseUrl?: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    provider,
    model,
    providers: { ...DEFAULT_SETTINGS.providers, [provider]: { provider, model, ...(baseUrl ? { baseUrl } : {}) } },
  };
}

function makeDeps(settings: Settings, opts: { probeError?: unknown; buildError?: unknown } = {}) {
  const generator = fakeGenerator('{}', settings.provider);
  const deps = {
    loadSettings: vi.fn(async () => settings),
    buildProvider: vi.fn((s: Settings): ContentGenerator => {
      if (opts.buildError) throw opts.buildError;
      void s;
      return generator;
    }),
    probeLocalProvider: vi.fn(async () => {
      if (opts.probeError) throw opts.probeError;
    }),
  };
  return { deps, generator };
}

describe('selectInterpretationProvider: uses the shared configuration', () => {
  it('uses the configured local provider and model, whatever they are', async () => {
    for (const [provider, model, url] of [
      ['ollama', 'qwen2.5-coder', 'http://localhost:11434/v1'],
      ['lmstudio', 'some-local-model', 'http://127.0.0.1:1234/v1'],
      ['litellm', 'proxy-model', 'http://localhost:4000'],
    ] as const) {
      const { deps, generator } = makeDeps(settingsFor(provider, model, url));
      const sel = await selectInterpretationProvider({ cwd: '/x', deps });
      expect(sel.ok, provider).toBe(true);
      if (!sel.ok) continue;
      expect(sel).toMatchObject({ providerId: provider, model, local: true, authorizedNonLocal: false });
      expect(sel.generator).toBe(generator);
      expect(deps.loadSettings).toHaveBeenCalledWith('/x');
      expect(deps.probeLocalProvider).toHaveBeenCalledWith(provider, url);
    }
  });

  it('builds the provider from the loaded settings and nothing else', async () => {
    const settings = settingsFor('ollama', 'm', 'http://localhost:11434/v1');
    const { deps } = makeDeps(settings);
    await selectInterpretationProvider({ cwd: '/x', deps });
    expect(deps.buildProvider).toHaveBeenCalledTimes(1);
    expect(deps.buildProvider).toHaveBeenCalledWith(settings);
  });

  it('falls back to the settings-level model when the provider entry has none', async () => {
    const settings = settingsFor('ollama', '', 'http://localhost:11434/v1');
    const sel = await selectInterpretationProvider({ cwd: '/x', deps: makeDeps({ ...settings, model: 'top-level-model' }).deps });
    expect(sel.ok && sel.model).toBe('top-level-model');
  });
});

describe('selectInterpretationProvider: local-first privacy', () => {
  it('refuses a cloud provider and sends nothing', async () => {
    for (const provider of ['openai', 'anthropic', 'google', 'deepseek'] as const) {
      const { deps, generator } = makeDeps(settingsFor(provider, 'big-model'));
      const sel = await selectInterpretationProvider({ cwd: '/x', deps });
      expect(sel.ok, provider).toBe(false);
      if (sel.ok) continue;
      expect(sel).toMatchObject({ status: 'UNAVAILABLE', failureKind: 'not_local' });
      expect(sel.reason).toMatch(/not a local model server/);
      expect(sel.reason).toMatch(/Nothing from the repository was sent/);
      expect(deps.buildProvider).not.toHaveBeenCalled();
      expect(deps.probeLocalProvider).not.toHaveBeenCalled();
      expect(generator.calls).toEqual([]);
    }
  });

  it('refuses a "local-type" server configured at a remote or LAN address', async () => {
    for (const url of ['http://gpu-box.example.com:11434/v1', 'http://192.168.1.50:11434/v1', 'https://remote.example.org/v1']) {
      const { deps } = makeDeps(settingsFor('ollama', 'm', url));
      const sel = await selectInterpretationProvider({ cwd: '/x', deps });
      expect(sel.ok, url).toBe(false);
      if (!sel.ok) expect(sel.failureKind).toBe('not_local');
      expect(deps.buildProvider).not.toHaveBeenCalled();
    }
  });

  it('does not put credentials or paths from the base URL in its message', async () => {
    const { deps } = makeDeps(settingsFor('ollama', 'm', 'https://user:hunter2@remote.example.com/secret/path'));
    const sel = await selectInterpretationProvider({ cwd: '/x', deps });
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.reason).not.toContain('hunter2');
      expect(sel.reason).not.toContain('/secret/path');
    }
  });

  it('uses a non-local provider only with explicit authorization, and says so', async () => {
    const { deps } = makeDeps(settingsFor('openai', 'gpt-4o'));
    const sel = await selectInterpretationProvider({ cwd: '/x', allowNonLocalProvider: true, deps });
    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel).toMatchObject({ local: false, authorizedNonLocal: true });
    // a cloud provider is not probed like a local server
    expect(deps.probeLocalProvider).not.toHaveBeenCalled();
  });

  it('authorization is off by default and only exactly `true` enables it', async () => {
    for (const v of [undefined, false]) {
      const { deps } = makeDeps(settingsFor('openai', 'gpt-4o'));
      const sel = await selectInterpretationProvider({ cwd: '/x', ...(v === undefined ? {} : { allowNonLocalProvider: v }), deps });
      expect(sel.ok).toBe(false);
    }
  });

  it('the default CodeXRev configuration (a cloud provider) is refused without any network use', async () => {
    const sel = await selectInterpretationProvider({ cwd: process.cwd() });
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.failureKind).toBe('not_local');
  });

  it('recognises loopback addresses only', () => {
    for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:1234', 'http://[::1]:8080/v1', 'http://api.localhost:3000']) expect(isLoopbackUrl(u), u).toBe(true);
    for (const u of ['http://10.0.0.5:1234', 'http://example.com', 'http://localhost.evil.com', 'not a url', '']) expect(isLoopbackUrl(u), u).toBe(false);
  });
});

describe('selectInterpretationProvider: failure handling and no fallback', () => {
  it('reports a model server that is not running as UNAVAILABLE and never tries another provider', async () => {
    const settings = settingsFor('ollama', 'm', 'http://localhost:11434/v1');
    // a cloud provider with a key is configured too: it must never be used as a fallback
    const withCloud: Settings = { ...settings, providers: { ...settings.providers, openai: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-should-never-be-used-0000' } } };
    const { deps, generator } = makeDeps(withCloud, { probeError: new LocalServerError('ollama', 'http://localhost:11434/v1', 'connection refused') });
    const sel = await selectInterpretationProvider({ cwd: '/x', deps });
    expect(sel).toMatchObject({ ok: false, status: 'UNAVAILABLE', failureKind: 'server_unreachable' });
    if (!sel.ok) expect(sel.reason).toMatch(/ollama serve/);
    expect(deps.buildProvider).not.toHaveBeenCalled();
    expect(generator.calls).toEqual([]);
  });

  it('reports a configuration that cannot be loaded as UNAVAILABLE', async () => {
    const deps = { loadSettings: vi.fn(async () => { throw new ConfigError('keychain unavailable'); }), buildProvider: vi.fn(), probeLocalProvider: vi.fn() };
    const sel = await selectInterpretationProvider({ cwd: '/x', deps: deps as never });
    expect(sel).toMatchObject({ ok: false, status: 'UNAVAILABLE', failureKind: 'config_error' });
    if (!sel.ok) expect(sel.reason).toMatch(/keychain unavailable/);
    expect(deps.buildProvider).not.toHaveBeenCalled();
  });

  it('reports no configured model as UNAVAILABLE', async () => {
    const settings = { ...settingsFor('ollama', '', 'http://localhost:11434/v1'), model: '' };
    const sel = await selectInterpretationProvider({ cwd: '/x', deps: makeDeps(settings).deps });
    expect(sel).toMatchObject({ ok: false, failureKind: 'no_model' });
  });

  it('reports an unsupported or unbuildable provider as UNAVAILABLE', async () => {
    const { deps } = makeDeps(settingsFor('ollama', 'm', 'http://localhost:11434/v1'), { buildError: new Error('adapter exploded') });
    const sel = await selectInterpretationProvider({ cwd: '/x', deps });
    expect(sel).toMatchObject({ ok: false, failureKind: 'unsupported_provider' });
    const unknown = await selectInterpretationProvider({ cwd: '/x', deps: makeDeps({ ...DEFAULT_SETTINGS, provider: 'mystery' as ProviderId }).deps });
    expect(unknown).toMatchObject({ ok: false, failureKind: 'unsupported_provider' });
  });

  it('masks secrets that appear in error text', async () => {
    const deps = { loadSettings: vi.fn(async () => { throw new ConfigError('failed with api_key=sk-abcdefghijklmnop12345'); }), buildProvider: vi.fn(), probeLocalProvider: vi.fn() };
    const sel = await selectInterpretationProvider({ cwd: '/x', deps: deps as never });
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.reason).not.toContain('sk-abcdefghijklmnop12345');
  });
});
