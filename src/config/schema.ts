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
import { ConfigError } from '../utils/errors.js';

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
  // undefined leaves the SDK default (10min) alone, see ContentGeneratorConfig.timeoutMs
  timeoutMs?: number;
}

export interface McpServerEntry {
  name: string; // shown in the CLI's /mcp list
  transport: 'stdio' | 'sse' | 'http';
  // stdio
  command?: string;
  args?: string[];
  // sse/http
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  trust?: boolean;
  timeoutMs?: number;
}

// Resolver Engine weights per role, review-pipeline feature. Defaults below match
// the Section 2 values from the dev guide; buildFailure covers the deterministic
// Build role which has no LLM verdict of its own so it's outside the BA/Architect/Dev/QA/PM split.
export interface ReviewPipelineResolverWeights {
  ba: number;
  architect: number;
  dev: number;
  qa: number;
  pm: number;
  buildFailure: number;
}

// Lives under settings.reviewPipeline, overridable from .codexrev/settings.json like
// anything else (loadSettings() just deep-merges, no allowlist needed here).
export interface ReviewPipelineSettings {
  resolverWeights: ReviewPipelineResolverWeights;
  // capped at MAX_FIX_ITERATIONS_CEILING regardless of config, see validateReviewPipelineSettings().
  // not the same knob as maxFixAttempts above — that's the older Agent-mode fix loop.
  maxFixIterations: number;
}

// never exceed 5 Breaker-Builder iterations, per the proposal's NFRs
export const MAX_FIX_ITERATIONS_CEILING = 5;

export function validateReviewPipelineSettings(rp: ReviewPipelineSettings): void {
  if (rp.maxFixIterations > MAX_FIX_ITERATIONS_CEILING) {
    throw new ConfigError(
      `reviewPipeline.maxFixIterations (${rp.maxFixIterations}) exceeds the hard limit of ` +
        `${MAX_FIX_ITERATIONS_CEILING} Breaker-Builder iterations (see the proposal's NFRs).`,
    );
  }
  if (rp.maxFixIterations < 1) {
    throw new ConfigError('reviewPipeline.maxFixIterations must be at least 1.');
  }
  const weights = rp.resolverWeights;
  for (const [role, weight] of Object.entries(weights)) {
    if (typeof weight !== 'number' || Number.isNaN(weight) || weight < 0) {
      throw new ConfigError(`reviewPipeline.resolverWeights.${role} must be a non-negative number.`);
    }
  }
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
  toolTimeoutMs: number; // 0 = no timeout
  maxTurns: number;
  approvalMode: 'always' | 'on-request' | 'never';
  // "YOLO" switch — skips every tool-approval prompt regardless of approvalMode.
  // toggled from the in-TUI Control Panel.
  bypassApprovals: boolean;
  defaultMode: InteractionMode;
  maxFixAttempts: number; // agent-mode fix loop cap
  verificationMode: VerificationMode;
  metadata: Record<string, unknown>; // machine-local, not synced anywhere
  reviewPipeline: ReviewPipelineSettings;
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
  bypassApprovals: false,
  defaultMode: 'ask',
  maxFixAttempts: 5,
  verificationMode: 'auto',
  metadata: {},
  reviewPipeline: {
    resolverWeights: { ba: 0.2, architect: 0.3, dev: 0.3, qa: 0.15, pm: 0.05, buildFailure: 0.4 },
    maxFixIterations: MAX_FIX_ITERATIONS_CEILING,
  },
};
