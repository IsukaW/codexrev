import { describe, expect, it } from 'vitest';
import {
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  isProviderId,
  providerMeta,
} from '../../src/providers/registry.js';
import type { ProviderId } from '../../src/core/types.js';

describe('provider registry', () => {
  it('contains every ProviderId', () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_REGISTRY[id]).toBeDefined();
      expect(PROVIDER_REGISTRY[id].id).toBe(id);
    }
  });

  it('exposes all six configured providers', () => {
    expect(PROVIDER_IDS).toEqual([
      'openai',
      'anthropic',
      'google',
      'litellm',
      'ollama',
      'lmstudio',
    ]);
  });

  it('every entry has the required metadata fields', () => {
    for (const id of PROVIDER_IDS) {
      const meta = PROVIDER_REGISTRY[id];
      expect(typeof meta.label).toBe('string');
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.defaultModel).toBe('string');
      expect(meta.defaultModel.length).toBeGreaterThan(0);
      // defaultBaseUrl may be '' for providers without a base-URL knob (e.g. Google Vertex)
      expect(typeof meta.defaultBaseUrl).toBe('string');
      expect(typeof meta.requiresApiKey).toBe('boolean');
      expect(typeof meta.supportsTools).toBe('boolean');
      expect(typeof meta.supportsStreamingUsage).toBe('boolean');
    }
  });

  it('cloud providers require an API key, local providers do not', () => {
    expect(PROVIDER_REGISTRY.openai.requiresApiKey).toBe(true);
    expect(PROVIDER_REGISTRY.anthropic.requiresApiKey).toBe(true);
    expect(PROVIDER_REGISTRY.google.requiresApiKey).toBe(true);
    expect(PROVIDER_REGISTRY.litellm.requiresApiKey).toBe(false);
    expect(PROVIDER_REGISTRY.ollama.requiresApiKey).toBe(false);
    expect(PROVIDER_REGISTRY.lmstudio.requiresApiKey).toBe(false);
  });

  it('local providers have a defaultBaseUrl', () => {
    expect(PROVIDER_REGISTRY.litellm.defaultBaseUrl).toBe('http://localhost:4000');
    expect(PROVIDER_REGISTRY.ollama.defaultBaseUrl).toBe('http://localhost:11434/v1');
    expect(PROVIDER_REGISTRY.lmstudio.defaultBaseUrl).toBe('http://localhost:1234/v1');
  });

  it('local providers set the env-base-URL var', () => {
    expect(PROVIDER_REGISTRY.ollama.envBaseUrlVar).toBe('OLLAMA_BASE_URL');
    expect(PROVIDER_REGISTRY.lmstudio.envBaseUrlVar).toBe('LMSTUDIO_BASE_URL');
    expect(PROVIDER_REGISTRY.litellm.envBaseUrlVar).toBe('LITELLM_BASE_URL');
  });

  it('isProviderId is a type guard', () => {
    const known: ProviderId = 'ollama';
    expect(isProviderId(known)).toBe(true);
    expect(isProviderId('openai')).toBe(true);
    expect(isProviderId('lmstudio')).toBe(true);
    expect(isProviderId('made-up')).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
    expect(isProviderId('')).toBe(false);
  });

  it('providerMeta returns the matching entry', () => {
    expect(providerMeta('ollama').id).toBe('ollama');
    expect(providerMeta('lmstudio').id).toBe('lmstudio');
    expect(providerMeta('openai').defaultModel).toBe('gpt-4o');
  });

  it('PROVIDER_IDS is in stable order', () => {
    // Sanity: order shouldn't be random between runs.
    expect(PROVIDER_IDS.indexOf('ollama')).toBeLessThan(PROVIDER_IDS.indexOf('lmstudio'));
  });
});