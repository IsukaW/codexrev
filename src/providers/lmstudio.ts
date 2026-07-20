/**
 * Codexrev — LM Studio provider adapter.
 *
 * LM Studio exposes an OpenAI-compatible HTTP API at `/v1/chat/completions`
 * (default `http://localhost:1234/v1`), so this is a thin subclass over
 * the shared OpenAI-compatible base. LM Studio does not require an API
 * key by default (it's optional in the desktop app); the connectivity
 * probe (`providers/health.ts`) reports a friendly `LocalServerError`
 * when the user hasn't started the local server.
 *
 * Tool/function calling is supported at the OpenAI-compatible layer
 * for chat models that have it enabled in LM Studio's UI.
 */

import type { ContentGeneratorConfig } from '../core/types.js';
import { OpenAICompatGenerator } from './_openaiCompat.js';
import { providerMeta } from './registry.js';

export class LMStudioGenerator extends OpenAICompatGenerator {
  readonly provider = 'lmstudio' as const;

  constructor(cfg: ContentGeneratorConfig) {
    const meta = providerMeta('lmstudio');
    super(cfg, {
      defaultApiKey: 'lmstudio', // LM Studio does not require authentication by default
      defaultBaseUrl: cfg.baseUrl ?? meta.defaultBaseUrl,
      supportsStreamingUsage: false,
      supportsTools: true,
      maxRetries: 0, // fail fast on local connection drops
    });
  }
}