/**
 * Registers `codexrev spec ...` as yargs subcommands, same builder pattern
 * as the review feature. Kept separate so index.ts just wires it in
 * instead of defining it inline.
 */

import type { Argv } from 'yargs';

// no .demandCommand(1) here on purpose — like `models`/`review`, that breaks
// `codexrev <cmd> --help` before the hand-rolled help screen runs
export function specCommandBuilder<T>(y: Argv<T>): Argv<T> {
  return y
    .command('init-urs', 'Seed a starter living URS skeleton if none exists', (yy) =>
      yy.option('project', {
        type: 'string',
        describe: 'Target project root (default: current directory)',
      }),
    )
    .command('analyze', 'Analyze a diff and propose living-URS updates (in development)', (yy) =>
      yy
        .option('diff', {
          type: 'string',
          default: 'staged',
          describe: 'Git ref to diff against (default: staged changes)',
        })
        .option('project', {
          type: 'string',
          describe: 'Target project root (default: current directory)',
        })
        .option('output', {
          type: 'string',
          choices: ['json', 'text'] as const,
          default: 'text',
          describe: 'Report format',
        })
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Analyze without writing proposals or reports',
        })
        .option('provider', {
          type: 'string',
          describe: 'Inference provider override (default: local — ollama/lmstudio)',
        })
        .option('model', {
          type: 'string',
          describe: 'Inference model override (e.g. a Qwen-family code model)',
        })
        .option('offline', {
          type: 'boolean',
          default: false,
          describe: 'Assert no network provider is used for inference',
        })
        .option('timeout', {
          type: 'number',
          describe: 'Per-request inference timeout in ms (default: 120000)',
        }),
    )
    .command('watch', 'Watch source changes and keep the living URS in sync (in development)', (yy) =>
      yy
        .option('debounce', {
          type: 'number',
          default: 800,
          describe: 'Quiet period per change batch before analyzing (ms)',
        })
        .option('paths', {
          type: 'string',
          describe: 'Comma-separated globs to watch (overrides config.json watchedPaths)',
        })
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Report drift without persisting anything',
        }),
    )
    .command(
      'status',
      'Show the current URS version, pending proposals and last drift alerts',
      (yy) => yy,
    )
    .command('history', 'List URS versions with their trigger change ids', (yy) => yy)
    .command('accept <id>', 'Accept a pending URS proposal', (yy) =>
      yy.positional('id', { type: 'string', describe: 'Proposal id' }),
    )
    .command('reject <id>', 'Reject a pending URS proposal', (yy) =>
      yy.positional('id', { type: 'string', describe: 'Proposal id' }),
    )
    .command('defer <id>', 'Defer a pending URS proposal', (yy) =>
      yy.positional('id', { type: 'string', describe: 'Proposal id' }),
    ) as Argv<T>;
}
