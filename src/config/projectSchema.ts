/**
 * Codexrev — per-project `.codexrev/config.json` schema.
 *
 * Holds the project's AI-model configuration. The API key is stored as
 * AES-256-GCM ciphertext — the corresponding DEK lives in the OS
 * keychain (see ../security/keychain.ts).
 */

import type { ProviderId } from '../core/types.js';
import type { EncryptedPayload } from '../security/secrets.js';

export const PROJECT_CONFIG_SCHEMA_VERSION = 1 as const;

export interface ModelConfig {
  id: string;
  name: string;
  url?: string;
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  // auto-set for local vendors (ollama/lmstudio/litellm) at add-time, see
  // DEFAULT_LOCAL_TIMEOUT_MS in providers/registry.ts. cloud providers just use the SDK default.
  timeoutMs?: number;
  default?: boolean;
}

export interface ProviderConfigEntry {
  name: string;
  vendor: 'openai' | 'anthropic' | 'google' | 'ollama' | 'lmstudio' | 'litellm' | 'deepseek' | 'customendpoint';
  apiKey?: EncryptedPayload;
  baseUrl?: string;
  apiType?: 'chat-completions' | 'messages' | 'generateContent';
  models: ModelConfig[];
}

export interface ProjectConfig {
  schemaVersion: typeof PROJECT_CONFIG_SCHEMA_VERSION;
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  // legacy sealed key, from before providers[] existed — omitted once each provider owns its own
  apiKey?: EncryptedPayload;
  createdAt: string;
  updatedAt: string;
  providers?: ProviderConfigEntry[];
}