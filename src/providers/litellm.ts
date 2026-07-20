/**
 * Codexrev — LiteLLM provider adapter.
 *
 * LiteLLM exposes an OpenAI-compatible HTTP API, so this is a thin
 * subclass over the shared OpenAI-compatible base. Migrating to the
 * shared helper also fixes a pre-existing bug where the LiteLLM
 * adapter silently dropped `tool` messages from the conversation.
 */

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