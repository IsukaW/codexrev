/**
 * Codexrev — configuration schema.
 *
 * Defines every option Codexrev understands, with sensible defaults.
 * The settings file is validated against this schema at load time.
 */

import type { ProviderId } from '../core/types.js';
import { PROVIDER_IDS, providerMeta } from '../providers/registry.js';
import type { InteractionMode } from '../core/modes.js';
import type { VerificationMode } from '../core/verification.js';

export type SandboxMode = 'auto' | 'seatbelt' | 'docker' | 'podman' | 'off';
export type ThemeName = 'dark' | 'light' | 'solarized' | 'monokai' | 'nord';

export interface ProviderSettings {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface McpServerEntry {
  /** Unique identifier used in the CLI's /mcp list. */
  name: string;
  /** Either "stdio", "sse", or "http". */
  transport: 'stdio' | 'sse' | 'http';
  /** stdio: command + args. */
  command?: string;
  args?: string[];
  /** sse/http: url + headers. */
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  trust?: boolean;
  timeoutMs?: number;
}

export interface Settings {
  provider: ProviderId;
  model: string;
  providers: Record<ProviderId, ProviderSettings>;
  maxOutputTokens: number;
  temperature: number;
  topP: number;
  theme: ThemeName;
  sandbox: SandboxMode;
  telemetry: boolean;
  checkpointing: boolean;
  mcpServers: Record<string, McpServerEntry>;
  /** Tool execution timeout (ms). 0 = no timeout. */
  toolTimeoutMs: number;
  /** Maximum number of agent turns per request. */
  maxTurns: number;
  /** Approval policy for shell commands. */
  approvalMode: 'always' | 'on-request' | 'never';
  /** Default interaction mode on startup. */
  defaultMode: InteractionMode;
  /** Maximum number of fix-loop iterations in Agent mode. */
  maxFixAttempts: number;
  /** Verification strategy for the fix loop. */
  verificationMode: VerificationMode;
  /** Extra metadata stored on the user's machine only. */
  metadata: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  model: 'gpt-4o',
  providers: Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, { provider: id, model: providerMeta(id).defaultModel }]),
  ) as Settings['providers'],
  maxOutputTokens: 8192,
  temperature: 0.7,
  topP: 1.0,
  theme: 'dark',
  sandbox: 'auto',
  telemetry: false,
  checkpointing: true,
  mcpServers: {},
  toolTimeoutMs: 60_000,
  maxTurns: 50,
  approvalMode: 'on-request',
  defaultMode: 'ask',
  maxFixAttempts: 5,
  verificationMode: 'auto',
  metadata: {},
};
