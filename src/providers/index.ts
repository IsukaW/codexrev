/**
 * Codexrev — provider factory.
 *
 * Given a Settings object, returns a ContentGenerator bound to the
 * configured provider.
 */

import type { ContentGenerator, ContentGeneratorConfig, ProviderId } from '../core/types.js';
import type { Settings } from '../config/schema.js';
import { ENV } from '../utils/env.js';
import { AuthError } from '../utils/errors.js';

import { OpenAIGenerator } from './openai.js';
import { AnthropicGenerator } from './anthropic.js';
import { GoogleGenerator } from './google.js';
import { LiteLLMGenerator } from './litellm.js';

export interface ProviderHandle {
  readonly provider: ContentGenerator;
  readonly id: ProviderId;
}

function buildConfig(settings: Settings): ContentGeneratorConfig {
  const ps = settings.providers[settings.provider] ?? {
    provider: settings.provider,
    model: settings.model,
  };
  let apiKey: string | undefined;
  let baseUrl: string | undefined;

  switch (settings.provider) {
    case 'openai':
      apiKey = ps.apiKey ?? ENV.openaiApiKey();
      baseUrl = ps.baseUrl ?? ENV.openaiBaseUrl();
      break;
    case 'anthropic':
      apiKey = ps.apiKey ?? ENV.anthropicApiKey();
      baseUrl = ps.baseUrl ?? ENV.anthropicBaseUrl();
      break;
    case 'google':
      apiKey = ps.apiKey ?? ENV.googleApiKey();
      break;
    case 'litellm':
      apiKey = ps.apiKey ?? ENV.litellmApiKey();
      baseUrl = ps.baseUrl ?? ENV.litellmBaseUrl();
      break;
  }

  return {
    provider: settings.provider,
    model: ps.model ?? settings.model,
    apiKey: apiKey || undefined,
    baseUrl,
    maxOutputTokens: settings.maxOutputTokens,
    temperature: settings.temperature,
    topP: settings.topP,
  };
}

function assertKey(cfg: ContentGeneratorConfig): void {
  if (!cfg.apiKey) {
    throw new AuthError(
      `No API key configured for provider "${cfg.provider}". ` +
        `Set ${envVarFor(cfg.provider)} or use /auth.`,
    );
  }
}

function envVarFor(p: ProviderId): string {
  switch (p) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
    case 'litellm':
      return 'LITELLM_API_KEY';
  }
}

export function buildProvider(settings: Settings): ContentGenerator {
  const cfg = buildConfig(settings);
  // API key check is deferred to the first request so users can run
  // `--help` and similar without configuring a key first.
  switch (cfg.provider) {
    case 'openai':
      return new OpenAIGenerator(cfg);
    case 'anthropic':
      return new AnthropicGenerator(cfg);
    case 'google':
      return new GoogleGenerator(cfg);
    case 'litellm':
      return new LiteLLMGenerator(cfg);
    default: {
      const exhaustive: never = cfg.provider;
      throw new Error(`unknown provider: ${String(exhaustive)}`);
    }
  }
}

/** Helper used by the /auth slash command. */
export function requireKey(settings: Settings): string {
  const cfg = buildConfig(settings);
  assertKey(cfg);
  return cfg.apiKey as string;
}
