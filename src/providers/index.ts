/**
 * Codexrev — provider factory.
 *
 * Given a Settings object, returns a ContentGenerator bound to the
 * configured provider. The dispatch is driven by `PROVIDER_REGISTRY` so
 * adding a new provider only requires one entry in `registry.ts`.
 */

import type { ContentGenerator, ContentGeneratorConfig, ProviderId } from '../core/types.js';
import type { Settings } from '../config/schema.js';
import { AuthError } from '../utils/errors.js';

import { OpenAIGenerator } from './openai.js';
import { AnthropicGenerator } from './anthropic.js';
import { GoogleGenerator } from './google.js';
import { LiteLLMGenerator } from './litellm.js';
import { OllamaGenerator } from './ollama.js';
import { LMStudioGenerator } from './lmstudio.js';
import { DeepSeekGenerator } from './deepseek.js';
import { providerMeta } from './registry.js';

export interface ProviderHandle {
  readonly provider: ContentGenerator;
  readonly id: ProviderId;
}

function buildConfig(settings: Settings): ContentGeneratorConfig {
  const meta = providerMeta(settings.provider);
  const ps = settings.providers[settings.provider] ?? {
    provider: settings.provider,
    model: settings.model,
  };

  let apiKey: string | undefined;
  if (ps.apiKey) {
    apiKey = ps.apiKey;
  } else if (meta.envKeyVar) {
    apiKey = process.env[meta.envKeyVar] || undefined;
  }

  let baseUrl: string | undefined;
  if (ps.baseUrl) {
    baseUrl = ps.baseUrl;
  } else if (meta.envBaseUrlVar) {
    const fromEnv = process.env[meta.envBaseUrlVar];
    baseUrl = fromEnv || undefined;
  }

  return {
    provider: settings.provider,
    model: ps.model ?? settings.model,
    apiKey: apiKey || undefined,
    baseUrl,
    maxOutputTokens: settings.maxOutputTokens,
    temperature: settings.temperature,
    topP: settings.topP,
    timeoutMs: ps.timeoutMs,
  };
}

function assertKey(cfg: ContentGeneratorConfig): void {
  const meta = providerMeta(cfg.provider);
  if (!meta.requiresApiKey) return; // local servers are key-less by design
  if (!cfg.apiKey) {
    const hint = meta.envKeyVar ? `Set ${meta.envKeyVar} or use /auth.` : 'Configure credentials.';
    throw new AuthError(`No API key configured for provider "${cfg.provider}". ${hint}`);
  }
}

export function buildProvider(settings: Settings): ContentGenerator {
  const cfg = buildConfig(settings);
  // API key check is deferred to the first request so users can run
  // `--help` and similar without configuring a key first. assertKey is
  // only invoked from `requireKey` (used by the /auth slash command).
  switch (cfg.provider) {
    case 'openai':
      return new OpenAIGenerator(cfg);
    case 'anthropic':
      return new AnthropicGenerator(cfg);
    case 'google':
      return new GoogleGenerator(cfg);
    case 'litellm':
      return new LiteLLMGenerator(cfg);
    case 'ollama':
      return new OllamaGenerator(cfg);
    case 'lmstudio':
      return new LMStudioGenerator(cfg);
    case 'deepseek':
      return new DeepSeekGenerator(cfg);
    default: {
      const exhaustive: never = cfg.provider;
      throw new Error(`unknown provider: ${String(exhaustive)}`);
    }
  }
}

/** Helper used by the /auth slash command. Throws for providers that don't need a key. */
export function requireKey(settings: Settings): string {
  const cfg = buildConfig(settings);
  assertKey(cfg);
  if (!cfg.apiKey) {
    // Provider doesn't require a key — there's nothing meaningful to return.
    return '';
  }
  return cfg.apiKey;
}