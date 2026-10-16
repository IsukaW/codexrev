// The one object every role function receives. Lives in its own module so
// role files import this instead of orchestrator.ts directly.

import type { ParsedDiff } from './diffReader.js';
import type { ContextAggregator } from './contextAggregator.js';
import type { ILLMProvider } from './illmProvider.js';
import type { Finding, RoleId } from '../roles/roleContract.js';
import type { RoleMetrics } from './roleMetrics.js';
import type { RoleCache } from './reviewCache.js';

// Present only when roles are re-judging code after the --fix loop edited it.
// Informational: roles must still judge the CURRENT code by the same standard as a
// fresh review (so a --fix run and a later plain `review scan` agree), but get to
// see what used to block and what changed, so an incomplete fix is noticed.
export interface VerificationContext {
  readonly previouslyBlocking: ReadonlyArray<{ readonly role: RoleId; readonly finding: Finding }>;
  readonly appliedFixes: ReadonlyArray<{ readonly file: string; readonly description: string }>;
}

export interface RoleRunContext {
  readonly llm: ILLMProvider;
  readonly model: string; // resolved by the caller from Settings
  readonly diff: ParsedDiff;
  readonly urs?: string;
  readonly aggregator: ContextAggregator; // read-only view of what earlier roles found
  readonly cwd: string; // repo root, mainly for the Build role's toolchain detection
  readonly verification?: VerificationContext;
  /** filled in by runLlmRole as it calls the model; observation only */
  readonly metrics?: RoleMetrics;
  /** when set, an identical role judgement of identical code is reused instead of asking the model again */
  readonly cache?: RoleCache;
}
