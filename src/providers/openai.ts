/**
 * Codexrev — OpenAI provider adapter.
 *
 * Thin subclass over the shared OpenAI-compatible base. Pins the
 * `provider` discriminator and the `defaultBaseUrl` from the registry;
 * all wire-format details (streaming, tool calls, finish reasons)
 * live in `_openaiCompat.ts`.
 */

import type { ContentGeneratorConfig } from '../core/types.js';
import { OpenAICompatGenerator } from './_openaiCompat.js';
import { providerMeta } from './registry.js';

export class OpenAIGenerator extends OpenAICompatGenerator {
  readonly provider = 'openai' as const;

  constructor(cfg: ContentGeneratorConfig) {
    const meta = providerMeta('openai');
    super(cfg, {
      defaultApiKey: 'openai', // overridden by cfg.apiKey in practice
      defaultBaseUrl: cfg.baseUrl ?? meta.defaultBaseUrl,
      supportsStreamingUsage: false,
      supportsTools: true,
    });
  }
}