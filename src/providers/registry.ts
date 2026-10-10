// Single source of truth for provider metadata without instantiating the adapter:
// default base URL, default model, whether it needs an API key, env var names,
// capability flags. Add a provider by adding one entry here — index.ts reads
// PROVIDER_IDS so TS exhaustiveness checking forces a constructor case too.

import type { ProviderId } from '../core/types.js';

// applied to local model servers (Ollama/LM Studio/LiteLLM) when the user hasn't set
// their own. SDK default is 10min, which a big model on slow hardware can genuinely
// blow past without actually being stuck — this just buys slack, it's not a hang
// detector. Cloud providers keep the SDK default since they're fast anyway.
export const DEFAULT_LOCAL_TIMEOUT_MS = 30 * 60_000;

export interface ProviderMeta {
  readonly id: ProviderId;
  readonly label: string;
  /** may be empty for providers that set baseUrl elsewhere, e.g. Google Vertex */
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly requiresApiKey: boolean;
  /** absent when requiresApiKey is false */
  readonly envKeyVar?: string;
  /** absent when there's no base-URL knob */
  readonly envBaseUrlVar?: string;
  readonly supportsTools: boolean;
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

// every provider id, in registration order — handy for `choices` arrays
export const PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY) as ProviderId[];

export function isProviderId(s: string | undefined): s is ProviderId {
  return !!s && s in PROVIDER_REGISTRY;
}

// throws if missing, which the type system shouldn't normally let happen
export function providerMeta(id: ProviderId): ProviderMeta {
  const meta = PROVIDER_REGISTRY[id];
  if (!meta) throw new Error(`unknown provider: ${String(id)}`);
  return meta;
}