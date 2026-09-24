// The one object every role function receives. Lives in its own module so
// role files import this instead of orchestrator.ts directly.

import type { ParsedDiff } from './diffReader.js';
import type { ContextAggregator } from './contextAggregator.js';
import type { ILLMProvider } from './illmProvider.js';

export interface RoleRunContext {
  readonly llm: ILLMProvider;
  readonly model: string; // resolved by the caller from Settings
  readonly diff: ParsedDiff;
  readonly urs?: string;
  readonly aggregator: ContextAggregator; // read-only view of what earlier roles found
  readonly cwd: string; // repo root, mainly for the Build role's toolchain detection
}
