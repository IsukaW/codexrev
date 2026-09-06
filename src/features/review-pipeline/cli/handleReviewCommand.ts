/**
 * Codexrev — `review` command dispatch (Feature 2: review pipeline).
 *
 * `scan` runs the six-role orchestrator (Phase 5), resolves a decision
 * (Phase 6's `resolverEngine.ts`), and — when `--fix` is set and that
 * decision is Block or Request Changes — runs the Breaker-Builder loop
 * (Phase 8's `breakerBuilderLoop.ts`) before rendering the final
 * JSON/Markdown/HTML report (Phase 7's `reportRenderer.ts`, `--output`
 * selects the directory) and exiting with the mapped code.
 */

import { CodexrevError } from '../../../utils/errors.js';
import { ProviderError } from '../../../core/types.js';
import { exitCodeForDecision } from '../pipeline/resolverEngine.js';
import { runReviewSession } from './runReviewSession.js';

export interface ReviewScanFlags {
  diff?: string;
  urs?: string;
  output?: string;
  fix?: boolean;
  maxIterations?: number;
  /** The global `--print`/`-p` flag — forces non-interactive mode when set, per Phase 5's DoD. */
  print?: string;
}

export async function handleReviewCommand(
  rest: ReadonlyArray<string | number>,
  flags: ReviewScanFlags,
): Promise<void> {
  const sub = String(rest[0] ?? '');
  switch (sub) {
    case 'scan':
      return scanCommand(flags);
    case '':
      printReviewUsage();
      process.exitCode = 2;
      return;
    default:
      console.error(`Unknown review subcommand: ${sub}`);
      printReviewUsage();
      process.exitCode = 2;
  }
}

async function scanCommand(flags: ReviewScanFlags): Promise<void> {
  try {
    const { resolver, breakerBuilder } = await runReviewSession({
      cwd: process.cwd(),
      diffRef: flags.diff,
      ursPath: flags.urs,
      forceNonInteractive: !!flags.print,
      outputDir: flags.output,
      fix: flags.fix,
      maxIterations: flags.maxIterations,
    });
    // 0 = Approve, 1 = Block or Request Changes (see resolverEngine.ts's
    // exitCodeForDecision docstring for the Request-Changes mapping
    // decision), 2 = Escalate — the Breaker-Builder loop hit its hard
    // limits (max iterations, or every remaining finding hit its
    // per-file retry cap) with blocking findings still unresolved.
    process.exitCode = breakerBuilder?.outcome === 'escalated' ? 2 : exitCodeForDecision(resolver.decision);
  } catch (err) {
    // CodexrevError covers our own errors (DiffReaderError, RoleContractError,
    // ConfigError, ...); ProviderError is a separate hierarchy (core/types.ts,
    // shared with the general agent loop) — both are expected, user-facing
    // failure modes here (bad diff, bad LLM JSON, missing/invalid API key),
    // not bugs, so print a clean message instead of a raw stack trace.
    if (err instanceof CodexrevError || err instanceof ProviderError) {
      console.error(`[codexrev review] ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function printReviewUsage(): void {
  console.error('usage: codexrev review scan [--diff <ref>] [--urs <path>] [--output <dir>] [--fix] [--max-iterations <n>]');
}
