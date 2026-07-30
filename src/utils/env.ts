/**
 * Codexrev — environment helpers.
 *
 * Centralises every read of `process.env` so the rest of the codebase
 * can be unit-tested in isolation. The per-provider getters are kept
 * stable for embedders that import `ENV` from the public API surface;
 * the factory in `src/providers/index.ts` actually resolves keys and
 * base URLs through `PROVIDER_REGISTRY` and bypasses these getters
 * internally.
 */

import { providerMeta } from '../providers/registry.js';
import { isProviderId } from '../providers/registry.js';

export const ENV = {
  provider: () => (process.env.CODEXREV_PROVIDER ?? 'openai').toLowerCase(),
  model: () => {
    const explicit = process.env.CODEXREV_MODEL;
    if (explicit) return explicit;
    const p = ENV.provider();
    return isProviderId(p) ? providerMeta(p).defaultModel : 'gpt-4o';
  },

  openaiApiKey: () => process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: () => process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',

  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY ?? '',
  anthropicBaseUrl: () => process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',

  googleApiKey: () => process.env.GOOGLE_API_KEY ?? '',
  googleUseVertex: () => process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true',

  litellmApiKey: () => process.env.LITELLM_API_KEY ?? '',
  litellmBaseUrl: () => process.env.LITELLM_BASE_URL ?? 'http://localhost:4000',

  ollamaApiKey: () => process.env.OLLAMA_API_KEY ?? '',
  ollamaBaseUrl: () => process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',

  lmstudioApiKey: () => process.env.LMSTUDIO_API_KEY ?? '',
  lmstudioBaseUrl: () => process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1',

  home: () => process.env.CODEXREV_HOME ?? '~/.codexrev',
  sandbox: () => (process.env.CODEXREV_SANDBOX ?? 'auto').toLowerCase(),
  telemetry: () => process.env.CODEXREV_TELEMETRY === 'true',
  theme: () => process.env.CODEXREV_THEME ?? 'dark',
  logLevel: () => (process.env.CODEXREV_LOG_LEVEL ?? 'info').toLowerCase(),
  noUpdate: () => process.env.CODEXREV_NO_UPDATE === '1',
};