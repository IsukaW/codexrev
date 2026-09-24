// Ollama speaks OpenAI-compatible at /v1/chat/completions (default
// http://localhost:11434/v1) — thin subclass, sentinel apiKey since the daemon needs
// no auth. health.ts's probe reports LocalServerError if it's not running.
// No auto-pull: an unpulled model just 404s and shows up as a normal ProviderError.

import type { ContentGeneratorConfig } from '../core/types.js';
import { OpenAICompatGenerator } from './_openaiCompat.js';
import { providerMeta } from './registry.js';

export class OllamaGenerator extends OpenAICompatGenerator {
  readonly provider = 'ollama' as const;

  constructor(cfg: ContentGeneratorConfig) {
    const meta = providerMeta('ollama');
    super(cfg, {
      defaultApiKey: 'ollama',
      defaultBaseUrl: cfg.baseUrl ?? meta.defaultBaseUrl,
      supportsStreamingUsage: false, // its OpenAI layer doesn't surface usage on chunks
      supportsTools: true, // model-dependent, server 4xxs if unsupported
      maxRetries: 0, // don't retry local connection drops
    });
  }
}