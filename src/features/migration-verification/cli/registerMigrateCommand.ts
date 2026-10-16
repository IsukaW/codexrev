/**
 * `migrate` command registration (Phase P6). Mirrors the review-pipeline
 * pattern: a yargs builder kept separate so src/cli/index.ts only wires it.
 *
 * NOTE (documented deviation): the proposal names Commander.js for Feature 3
 * CLI handling, but the existing CodeXRev CLI is built on yargs and all
 * sibling commands (init/extensions/models/review) register through it.
 * Retaining yargs keeps one consistent framework; switching would be a
 * platform-wide change beyond this feature's scope.
 */

import type { Argv } from 'yargs';

export function migrateCommandBuilder<T>(y: Argv<T>): Argv<T> {
  return y.command(
    'analyze',
    'Analyze an npm project and produce an evidence-backed migration plan',
    (yy) =>
      yy
        .option('project-path', {
          type: 'string',
          describe: 'Path to the npm project to analyze (default: current directory)',
        })
        .option('dependency', {
          type: 'string',
          demandOption: true,
          describe: 'Dependency being migrated',
        })
        .option('current-version', {
          type: 'string',
          demandOption: true,
          describe: 'Current version (as declared or resolved)',
        })
        .option('target-version', {
          type: 'string',
          demandOption: true,
          describe: 'Target version of the migration',
        })
        .option('from', {
          type: 'string',
          describe: 'API name being renamed (must be combined with --to)',
        })
        .option('to', {
          type: 'string',
          describe: 'New API name (must be combined with --from)',
        })
        .option('upgrade', {
          type: 'boolean',
          default: false,
          describe: 'Dependency-upgrade migration (no API rename)',
        })
        .option('format', {
          type: 'string',
          choices: ['json', 'markdown'] as const,
          default: 'json' as const,
          describe: 'Plan output format (named --format to avoid the global --output-format)',
        })
        .option('out', {
          type: 'string',
          describe: 'Write the plan to this file (must be outside the analyzed project)',
        }),
  ) as Argv<T>;
}
