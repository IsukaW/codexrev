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
  /** Per-request client timeout (ms) — see `ContentGeneratorConfig.timeoutMs`'s docstring. Undefined leaves the SDK default (10 min) untouched. */
  timeoutMs?: number;
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

/**
 * Feature 2 (review-pipeline) — Resolver Engine weights, per role.
 * Defaults are the Section 2 authoritative values from the Feature 2 dev
 * guide: BA 0.2, Dev 0.3, Sec 0.3, QA 0.15, PM 0.05, plus a weight applied
 * specifically to Build-role failures (deterministic role — no LLM verdict
 * of its own, so it isn't part of the BA/Dev/Sec/QA/PM split).
 */
export interface ReviewPipelineResolverWeights {
  ba: number;
  dev: number;
  sec: number;
  qa: number;
  pm: number;
  buildFailure: number;
}

/**
 * Feature 2 (review-pipeline) settings — configurable without code changes
 * per the proposal's Configurability NFR. Lives under `settings.reviewPipeline`
 * so `.codexrev/settings.json` can override it like any other settings key
 * (see `loadSettings()` in `../config/loader.js` — plain deep-merge, no
 * allowlist, so this namespace needs no special-casing there).
 */
export interface ReviewPipelineSettings {
  resolverWeights: ReviewPipelineResolverWeights;
  /**
   * Max Breaker-Builder iterations for one `--fix` run. Hard-capped at
   * `MAX_FIX_ITERATIONS_CEILING` (5) regardless of what's configured here —
   * see `validateReviewPipelineSettings()`. This is a *different* knob from
   * `maxFixAttempts` above, which belongs to the pre-existing, unrelated
   * Agent-mode fix loop (`core/pipeline.ts` / `fixLoop.ts`).
   */
  maxFixIterations: number;
}

/** Hard ceiling from the proposal's NFRs — never exceed 5 Breaker-Builder iterations overall. */
export const MAX_FIX_ITERATIONS_CEILING = 5;

/** Throws if `reviewPipeline` settings violate a hard NFR limit. */
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
  /** Tool execution timeout (ms). 0 = no timeout. */
  toolTimeoutMs: number;
  /** Maximum number of agent turns per request. */
  maxTurns: number;
  /** Approval policy for shell commands. */
  approvalMode: 'always' | 'on-request' | 'never';
  /**
   * When true, skip every tool-approval prompt (shell / write_file / edit)
   * regardless of `approvalMode`. The "YOLO" switch — surfaced and toggled
   * from the in-TUI Control Panel.
   */
  bypassApprovals: boolean;
  /** Default interaction mode on startup. */
  defaultMode: InteractionMode;
  /** Maximum number of fix-loop iterations in Agent mode. */
  maxFixAttempts: number;
  /** Verification strategy for the fix loop. */
  verificationMode: VerificationMode;
  /** Extra metadata stored on the user's machine only. */
  metadata: Record<string, unknown>;
  /** Feature 2 (review-pipeline): Resolver weights + Breaker-Builder cap. */
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
    resolverWeights: { ba: 0.2, dev: 0.3, sec: 0.3, qa: 0.15, pm: 0.05, buildFailure: 0.4 },
    maxFixIterations: MAX_FIX_ITERATIONS_CEILING,
  },
};
