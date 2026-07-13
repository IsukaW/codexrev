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

export interface ProjectConfig {
  schemaVersion: typeof PROJECT_CONFIG_SCHEMA_VERSION;
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  apiKey: EncryptedPayload;
  createdAt: string;
  updatedAt: string;
}