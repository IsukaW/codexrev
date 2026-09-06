/**
 * Codexrev — provider metadata registry.
 *
 * Single source of truth for everything the rest of the codebase needs to
 * know about a provider without instantiating the adapter:
 *
 *   - the hard-coded default base URL (when no env var or settings key overrides it)
 *   - the default model name used in DEFAULT_SETTINGS
 *   - whether the provider requires an API key (local servers do not)
 *   - the env var names for key + base URL (when applicable)
 *   - capability flags used by the agent loop and embedders
 *
 * Adding a new provider = one new entry here. The factory in
 * `./index.ts` reads `PROVIDER_IDS` so the TypeScript exhaustiveness
 * check enforces that every entry has a constructor case.
 */

import type { ProviderId } from '../core/types.js';

/**
 * Per-request client timeout applied automatically to local model servers
 * (Ollama, LM Studio, LiteLLM) when the user doesn't set one explicitly.
 * The OpenAI SDK's own default is 10 minutes, which a larger local model
 * on modest hardware can genuinely exceed without being stuck — this is
 * NOT a hang-detection value, just enough slack for a slow-but-honest
 * response. Cloud providers keep the SDK default (fast APIs, no need).
 */
export const DEFAULT_LOCAL_TIMEOUT_MS = 30 * 60_000;

export interface ProviderMeta {
  readonly id: ProviderId;
  /** Human-readable label shown in CLI help and the init wizard. */
  readonly label: string;
  /** Hard-coded fallback base URL when nothing else is configured. May be empty for providers that set baseUrl elsewhere (e.g. Google Vertex). */
  readonly defaultBaseUrl: string;
  /** Default model name used by `DEFAULT_SETTINGS`. */
  readonly defaultModel: string;
  /** Whether the adapter refuses to function without an API key. */
  readonly requiresApiKey: boolean;
  /** Env var holding the API key. Absent when `requiresApiKey === false`. */
  readonly envKeyVar?: string;
  /** Env var holding the base URL. Absent when the provider has no base-URL knob. */
  readonly envBaseUrlVar?: string;
  /** Whether the adapter advertises tools/function-calling. */
  readonly supportsTools: boolean;
  /** Whether `stream()` populates `usage` on the `finish` event. */
  readonly supportsStreamingUsage: boolean;
}

export const PROVIDER_REGISTRY: Readonly<Record<ProviderId, ProviderMeta>> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    requiresApiKey: true,
    envKeyVar: 'OPENAI_API_KEY',
    envBaseUrlVar: 'OPENAI_BASE_URL',
    supportsTools: true,
    supportsStreamingUsage: false,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-5-sonnet-20241022',
    requiresApiKey: true,
    envKeyVar: 'ANTHROPIC_API_KEY',
    envBaseUrlVar: 'ANTHROPIC_BASE_URL',
    supportsTools: true,
    supportsStreamingUsage: true,
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    defaultBaseUrl: '',
    defaultModel: 'gemini-1.5-pro',
    requiresApiKey: true,
    envKeyVar: 'GOOGLE_API_KEY',
    supportsTools: true,
    supportsStreamingUsage: false,
  },
  litellm: {
    id: 'litellm',
    label: 'LiteLLM',
    defaultBaseUrl: 'http://localhost:4000',
    defaultModel: 'gpt-4o',
    requiresApiKey: false,
    envKeyVar: 'LITELLM_API_KEY',
    envBaseUrlVar: 'LITELLM_BASE_URL',
    supportsTools: true,
    supportsStreamingUsage: false,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    requiresApiKey: false,
    envKeyVar: 'OLLAMA_API_KEY',
    envBaseUrlVar: 'OLLAMA_BASE_URL',
    supportsTools: true,
    supportsStreamingUsage: false,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultModel: 'qwen2.5-7b-instruct',
    requiresApiKey: false,
    envKeyVar: 'LMSTUDIO_API_KEY',
    envBaseUrlVar: 'LMSTUDIO_BASE_URL',
    supportsTools: true,
    supportsStreamingUsage: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    envKeyVar: 'DEEPSEEK_API_KEY',
    envBaseUrlVar: 'DEEPSEEK_BASE_URL',
    supportsTools: true,
    supportsStreamingUsage: false,
  },
};

/** Tuple of every provider id, in registration order. Useful for `choices` arrays. */
export const PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY) as ProviderId[];

/** Predicate equivalent to `id in PROVIDER_REGISTRY`. */
export function isProviderId(s: string | undefined): s is ProviderId {
  return !!s && s in PROVIDER_REGISTRY;
}

/** Lookup helper — throws if the entry is missing (which the type system normally prevents). */
export function providerMeta(id: ProviderId): ProviderMeta {
  const meta = PROVIDER_REGISTRY[id];
  if (!meta) throw new Error(`unknown provider: ${String(id)}`);
  return meta;
}