import { describe, expect, it } from 'vitest';
import yargs from 'yargs';
import type { Argv } from 'yargs';
import { specCommandBuilder } from '../../../src/features/living-spec/cli/registerSpecCommand.js';

const SUBCOMMANDS = [
  'analyze',
  'watch',
  'status',
  'history',
  'accept',
  'reject',
  'defer',
] as const;

interface CommandAwareArgv {
  getHelp(): Promise<string>;
}

function buildSpec(): Argv<Record<string, unknown>> & CommandAwareArgv {
  const base = yargs().scriptName('codexrev').exitProcess(false).help(false);
  return specCommandBuilder<Record<string, unknown>>(
    base as unknown as Argv<Record<string, unknown>>,
  ) as unknown as Argv<Record<string, unknown>> & CommandAwareArgv;
}

describe('specCommandBuilder', () => {
  it('exposes all seven subcommands', async () => {
    const help = await buildSpec().getHelp();
    for (const sub of SUBCOMMANDS) {
      expect(help).toContain(`codexrev ${sub}`);
    }
  });

  it('describes every subcommand in the generated help', async () => {
    const help = await buildSpec().getHelp();
    // yargs wraps the help at ~80 cols and can split words mid-way, so
    // compare against a whitespace-free haystack.
    const flat = help.replace(/\s+/g, '');
    // analyze/watch run the full pipeline — the help describes the real job.
    expect(flat).toContain('Analyzeadiffandproposeliving-URSupdates');
    expect(flat).toContain('WatchsourcechangesandkeepthelivingURSinsync');
    expect(flat).toContain('AcceptapendingURSproposal');
  });

  it('defaults analyze to a staged diff, text output, no dry-run', async () => {
    const argv = await buildSpec().parseAsync(['analyze']);
    expect(argv._[0]).toBe('analyze');
    expect(argv.diff).toBe('staged');
    expect(argv.output).toBe('text');
    expect(argv.dryRun).toBe(false);
  });

  it('passes analyze flags through', async () => {
    const argv = await buildSpec().parseAsync([
      'analyze',
      '--diff',
      'HEAD~1',
      '--project',
      '/tmp/proj',
      '--output',
      'json',
      '--dry-run',
    ]);
    expect(argv.diff).toBe('HEAD~1');
    expect(argv.project).toBe('/tmp/proj');
    expect(argv.output).toBe('json');
    expect(argv.dryRun).toBe(true);
  });

  it('defaults watch to an 800 ms debounce, text output, no dry-run', async () => {
    const argv = await buildSpec().parseAsync(['watch']);
    expect(argv._[0]).toBe('watch');
    expect(argv.debounce).toBe(800);
    expect(argv.output).toBe('text');
    expect(argv.dryRun).toBe(false);
  });

  it('passes watch flags through', async () => {
    const argv = await buildSpec().parseAsync([
      'watch',
      '--debounce',
      '1500',
      '--paths',
      'src/**,test/**',
      '--output',
      'json',
      '--dry-run',
    ]);
    expect(argv.debounce).toBe(1500);
    expect(argv.paths).toBe('src/**,test/**');
    expect(argv.output).toBe('json');
    expect(argv.dryRun).toBe(true);
  });

  it('binds the proposal id positional for accept/reject/defer', async () => {
    for (const decision of ['accept', 'reject', 'defer'] as const) {
      const argv = await buildSpec().parseAsync([decision, 'prop-42']);
      expect(argv._[0]).toBe(decision);
      expect(argv.id).toBe('prop-42');
    }
  });
});
