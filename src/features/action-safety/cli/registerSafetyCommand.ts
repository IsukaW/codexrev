/**
 * Registers `codexrev safety assess|verify|history` as a yargs command, same
 * builder pattern as review/models in src/cli/index.ts. Kept separate so
 * index.ts just wires it in instead of defining it inline.
 */

import type { Argv } from 'yargs';

// no .demandCommand(1) and no .demandOption() on purpose, same reason as
// `review`: yargs would exit with its own generic message (and break
// `codexrev <cmd> --help`) before our handler can print a controlled one
export function safetyCommandBuilder<T>(y: Argv<T>): Argv<T> {
  return y
    .command('assess', 'Assess a proposed DevOps action before it is executed', (yy) =>
      yy
        .option('action', {
          type: 'string',
          describe: 'Proposed action: deployment | rollback | database_migration | configuration_change | dependency_upgrade | code_change',
        })
        .option('target', {
          type: 'string',
          describe: 'Target environment: development | testing | staging | production',
        })
        .option('input', {
          type: 'string',
          describe: 'Path to a structured action/evidence JSON file',
        })
        .option('diff', {
          type: 'string',
          describe: 'Git revision to compare against',
        })
        .option('output', {
          type: 'string',
          describe: 'Where to write the Evidence Pack',
        }),
    )
    .command('verify', 'Verify a signed Evidence Pack', (yy) =>
      yy.option('file', {
        type: 'string',
        describe: 'Path to the Evidence Pack to verify',
      }),
    )
    .command('history', 'Show previous local safety assessments') as Argv<T>;
}
