/**
 * Codexrev — `review` command registration (Feature 2: review pipeline).
 *
 * Registers `codexrev review scan` as a yargs command, mirroring the
 * builder pattern already used for `extensions`/`models` in
 * `src/cli/index.ts`. Kept in its own module (Section 4 of the Feature 2
 * dev guide) so `src/cli/index.ts` only wires it in, it doesn't define it.
 */

import type { Argv } from 'yargs';

/**
 * Builder passed to `.command('review', description, reviewCommandBuilder)`
 * in `src/cli/index.ts`. Deliberately has no `.demandCommand(1)` at this
 * level (unlike `extensions`) — that combination currently breaks
 * `codexrev <cmd> --help` before the hand-rolled help screen ever runs
 * (see Phase 0 note); `models` avoids the same trap, and `review` follows
 * that pattern instead.
 */
export function reviewCommandBuilder<T>(y: Argv<T>): Argv<T> {
  return y.command('scan', 'Run the six-role review pipeline against a diff', (yy) =>
    yy
      .option('diff', {
        type: 'string',
        describe: 'Git ref to diff against (default: staged changes)',
      })
      .option('urs', {
        type: 'string',
        describe: 'Path to a URS document for the BA role to check against',
      })
      .option('output', {
        type: 'string',
        describe: 'Directory to write reports to (default: .codexrev/review-pipeline/reports)',
      })
      .option('fix', {
        type: 'boolean',
        default: false,
        describe: 'Attempt to fix blocking findings via the Breaker-Builder loop',
      })
      .option('max-iterations', {
        type: 'number',
        describe: 'Override the default Breaker-Builder iteration cap (never above 5, with --fix)',
      }),
  ) as Argv<T>;
}
