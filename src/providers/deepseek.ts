/**
 * Codexrev — DeepSeek provider adapter.
 *
 * DeepSeek exposes an OpenAI-compatible HTTP API at `/chat/completions`
 * (default `https://api.deepseek.com/v1`), so this is a thin subclass
 * over the shared OpenAI-compatible base — same pattern as `openai.ts`.
 * Requires `DEEPSEEK_API_KEY` (or an explicit `--api-key`), same as any
 * other cloud provider.
 */

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
