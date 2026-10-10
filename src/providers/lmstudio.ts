// LM Studio speaks OpenAI-compatible at /v1/chat/completions (default
// http://localhost:1234/v1), thin subclass over the shared base. No API key needed by
// default — health.ts's probe gives a friendly error if the local server isn't up.
// Tool calling works for models that have it toggled on in LM Studio's UI.

import type { ContentGeneratorConfig } from '../core/types.js';
import { OpenAICompatGenerator } from './_openaiCompat.js';
import { providerMeta } from './registry.js';

export class LMStudioGenerator extends OpenAICompatGenerator {
  readonly provider = 'lmstudio' as const;

  constructor(cfg: ContentGeneratorConfig) {
    const meta = providerMeta('lmstudio');
    super(cfg, {
      defaultApiKey: 'lmstudio',
      defaultBaseUrl: cfg.baseUrl ?? meta.defaultBaseUrl,
      supportsStreamingUsage: false,
      supportsTools: true,
      maxRetries: 0, // fail fast on local drops
    });
  }
}