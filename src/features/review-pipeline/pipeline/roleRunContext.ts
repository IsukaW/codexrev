/**
 * Codexrev — Feature 2 (review-pipeline) role run context.
 *
 * The single object every role function receives. Kept in its own
 * module (rather than defined in `orchestrator.ts`) so role files never
 * need to import the orchestrator itself, only this narrow context type
 * plus `roleContract.ts` — matching the guide's "roles ... consuming
 * the same ContextAggregator + ILLMProvider" framing.
 */

import type { ParsedDiff } from './diffReader.js';
import type { ContextAggregator } from './contextAggregator.js';
import type { ILLMProvider } from './illmProvider.js';

export interface RoleRunContext {
  /** Shared across all LLM-backed roles — never a specific provider import (Phase 2). */
  readonly llm: ILLMProvider;
  /** Model name to request from `llm` (resolved by the caller from Settings). */
  readonly model: string;
  readonly diff: ParsedDiff;
  readonly urs?: string;
  /** Read-only view of everything accumulated by earlier roles. */
  readonly aggregator: ContextAggregator;
  /** Repo root — used by the deterministic Build role to detect + run the toolchain. */
  readonly cwd: string;
}
