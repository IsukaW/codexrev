/**
 * Registers `codexrev spec ...` as yargs subcommands, same builder pattern
 * as the review feature. Kept separate so index.ts just wires it in
 * instead of defining it inline.
 *
 * Global flags (--project/--output/--quiet) are attached to EVERY
 * subcommand; index.ts also registers them on the spec parent command so
 * they parse regardless of position.
 */

import type { Argv } from 'yargs';

/** Global flags shared by every spec subcommand. */
function withGlobalFlags<T>(yy: Argv<T>): Argv<T> {
  return yy
    .option('project', {
      type: 'string',
      describe: 'Target project root (default: current directory)',
    })
    .option('output', {
      type: 'string',
      choices: ['json', 'text'] as const,
      default: 'text' as const,
      describe: 'Report format',
    })
    .option('quiet', {
      type: 'boolean',
      default: undefined,
      describe: 'Suppress progress output (analyze/watch)',
    });
}

// no .demandCommand(1) here on purpose — like `models`/`review`, that breaks
// `codexrev <cmd> --help` before the hand-rolled help screen runs
export function specCommandBuilder<T>(y: Argv<T>): Argv<T> {
  return y
    .command('init-urs', 'Seed a starter living URS skeleton if none exists', (yy) =>
      withGlobalFlags(yy),
    )
    .command('analyze', 'Analyze a diff and propose living-URS updates', (yy) =>
      withGlobalFlags(yy)
        .option('diff', {
          type: 'string',
          default: 'staged',
          describe: 'Git ref to diff against (default: staged changes)',
        })
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Deterministic analysis only — no model calls, nothing written',
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
    .command('bootstrap', 'Generate URS Version 0 from the implemented code (approval required)', (yy) =>
      withGlobalFlags(yy)
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Preview the generated URS without asking to save',
        })
        .option('yes', {
          type: 'boolean',
          default: false,
          describe: 'Approve the draft as URS Version 0 non-interactively (required off-TTY)',
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
    .command('watch', 'Watch source changes and keep the living URS in sync', (yy) =>
      withGlobalFlags(yy)
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
          describe: 'Deterministic analysis only — no model calls, nothing written',
        }),
    )
    .command('eval', 'Replay the labelled scenario corpus and write an evaluation report', (yy) =>
      withGlobalFlags(yy)
        .option('corpus', {
          type: 'string',
          describe: 'Scenario corpus directory (default: tests/features/living-spec/fixtures/scenarios)',
        })
        .option('mode', {
          type: 'string',
          choices: ['A', 'B', 'C', 'batch', 'single-pass', 'full', 'live', 'all'] as const,
          default: 'all',
          describe: 'A/batch · B/single-pass · C/full · live (local model) · all (default)',
        })
        .option('live', {
          type: 'boolean',
          default: false,
          describe: 'Run the model-backed modes against a live local model (default: offline scripted provider)',
        }),
    )
    .command('status', 'Show the current URS version, pending proposals and last drift alerts', (yy) =>
      withGlobalFlags(yy),
    )
    .command('history', 'List URS versions with their trigger change ids', (yy) =>
      withGlobalFlags(yy),
    )
    .command('accept <id>', 'Accept a pending URS proposal', (yy) =>
      withGlobalFlags(yy).positional('id', { type: 'string', describe: 'Proposal id' }),
    )
    .command('reject <id>', 'Reject a pending URS proposal', (yy) =>
      withGlobalFlags(yy).positional('id', { type: 'string', describe: 'Proposal id' }),
    )
    .command('defer <id>', 'Defer a pending URS proposal', (yy) =>
      withGlobalFlags(yy).positional('id', { type: 'string', describe: 'Proposal id' }),
    ) as Argv<T>;
}
