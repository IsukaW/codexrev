/**
 * Registers `codexrev review scan` as a yargs command, same builder pattern
 * as extensions/models in src/cli/index.ts. Kept separate so index.ts just
 * wires it in instead of defining it inline.
 */

import type { Argv } from 'yargs';

// no .demandCommand(1) here on purpose — like `models`, that breaks
// `codexrev <cmd> --help` before the hand-rolled help screen runs
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
