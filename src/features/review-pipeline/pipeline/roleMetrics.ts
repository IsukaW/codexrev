// What a role cost: wall time, LLM round trips and tokens. Observation only — nothing in the
// pipeline's behavior depends on it. It exists so a slow run can be explained from data (which
// role, how many tool turns, how many tokens) instead of guessed at.

import type { UsageStats } from '../../../core/types.js';

export interface RoleTiming {
  readonly durationMs: number;
  /** model round trips (tool turns + the final answer + any corrective retry) */
  readonly llmCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** answer came from the review cache, no model was called */
  readonly cached?: boolean;
}

export class RoleMetrics {
  private calls = 0;
  private input = 0;
  private output = 0;
  private fromCache = false;

  markCached(): void {
    this.fromCache = true;
  }

  record(usage: UsageStats | undefined): void {
    this.calls++;
    this.input += usage?.inputTokens ?? 0;
    this.output += usage?.outputTokens ?? 0;
  }

  snapshot(durationMs: number): RoleTiming {
    return {
      durationMs,
      llmCalls: this.calls,
      inputTokens: this.input,
      outputTokens: this.output,
      ...(this.fromCache ? { cached: true } : {}),
    };
  }
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
