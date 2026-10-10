// DeepSeek's API is OpenAI-compatible (/chat/completions, default
// https://api.deepseek.com/v1) so this is just a thin subclass, same pattern as
// openai.ts. Needs DEEPSEEK_API_KEY or --api-key.

import type { ContentGeneratorConfig } from '../core/types.js';
import { OpenAICompatGenerator } from './_openaiCompat.js';
import { providerMeta } from './registry.js';

export class DeepSeekGenerator extends OpenAICompatGenerator {
  readonly provider = 'deepseek' as const;

  constructor(cfg: ContentGeneratorConfig) {
    const meta = providerMeta('deepseek');
    super(cfg, {
      defaultApiKey: 'deepseek', // overridden by cfg.apiKey in practice
      defaultBaseUrl: cfg.baseUrl ?? meta.defaultBaseUrl,
      supportsStreamingUsage: false,
      supportsTools: true,
    });
  }
}
