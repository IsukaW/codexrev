/**
 * Codexrev — Ollama provider adapter.
 *
 * Ollama exposes an OpenAI-compatible HTTP API at `/v1/chat/completions`
 * (default `http://localhost:11434/v1`), so this is a thin subclass over
 * the shared OpenAI-compatible base. The Ollama daemon does not require
 * authentication, so the OpenAI client is constructed with a sentinel
 * apiKey; the connectivity probe (`providers/health.ts`) reports a
 * friendly `LocalServerError` when the daemon is not running.
 *
 * No automatic model loading: if the requested model has not been
 * `ollama pull`ed, the server returns 404 and the SDK surfaces it as a
 * standard `ProviderError`.
 */

import type { ContentGeneratorConfig } from '../core/types.js';
import { OpenAICompatGenerator } from './_openaiCompat.js';
import { providerMeta } from './registry.js';

export class OllamaGenerator extends OpenAICompatGenerator {
  readonly provider = 'ollama' as const;

  constructor(cfg: ContentGeneratorConfig) {
    const meta = providerMeta('ollama');
    super(cfg, {
      defaultApiKey: 'ollama', // Ollama does not require authentication
      defaultBaseUrl: cfg.baseUrl ?? meta.defaultBaseUrl,
      supportsStreamingUsage: false, // Ollama's OpenAI layer does not surface usage on chunks
      supportsTools: true, // depends on the model; the server reports failures as 4xx
      maxRetries: 0, // fail fast — local servers shouldn't be retried on transient connection drops
    });
  }
}