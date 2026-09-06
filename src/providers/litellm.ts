// LiteLLM's API is OpenAI-compatible, so this is a thin subclass over the shared base.
// Moving to the shared helper also fixed a bug where this adapter used to silently
// drop tool messages.

import type { ContentGeneratorConfig } from '../core/types.js';
import { OpenAICompatGenerator } from './_openaiCompat.js';
import { providerMeta } from './registry.js';

export class LiteLLMGenerator extends OpenAICompatGenerator {
  readonly provider = 'litellm' as const;

  constructor(cfg: ContentGeneratorConfig) {
    const meta = providerMeta('litellm');
    super(cfg, {
      defaultApiKey: 'litellm',
      defaultBaseUrl: cfg.baseUrl ?? meta.defaultBaseUrl,
      supportsStreamingUsage: false,
      supportsTools: true,
    });
  }
}