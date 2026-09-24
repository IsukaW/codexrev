/**
 * `review` command dispatch. `scan` runs the six-role orchestrator, resolves
 * a decision, and (with --fix, on Block/Request Changes) runs the
 * Breaker-Builder loop before writing the JSON/Markdown/HTML report.
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
  /** global --print/-p flag — forces non-interactive mode */
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
    // 0 approve, 1 block/request changes, 2 escalate (fix loop hit its
    // iteration/retry limits with blocking findings still open)
    process.exitCode = breakerBuilder?.outcome === 'escalated' ? 2 : exitCodeForDecision(resolver.decision);
  } catch (err) {
    // both are expected user-facing failures (bad diff, bad LLM json, bad api key), not bugs
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
