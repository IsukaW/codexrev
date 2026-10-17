import { describe, expect, it } from 'vitest';
import yargs from 'yargs';
import type { Argv } from 'yargs';
import { specCommandBuilder } from '../../../src/features/living-spec/cli/registerSpecCommand.js';

const SUBCOMMANDS = [
  'analyze',
  'bootstrap',
  'watch',
  'eval',
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
  it('exposes every subcommand', async () => {
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

  it('accepts --quiet on analyze and watch', async () => {
    for (const sub of ['analyze', 'watch'] as const) {
      const argv = await buildSpec().parseAsync([sub, '--quiet']);
      expect(argv.quiet).toBe(true);
    }
  });

  it('exposes the global flags on every read/decision subcommand', async () => {
    for (const sub of ['status', 'history'] as const) {
      const argv = await buildSpec().parseAsync([
        sub,
        '--project',
        '/tmp/proj',
        '--output',
        'json',
        '--quiet',
      ]);
      expect(argv.project).toBe('/tmp/proj');
      expect(argv.output).toBe('json');
      expect(argv.quiet).toBe(true);
    }
    const decide = await buildSpec().parseAsync([
      'accept',
      'prop-42',
      '--project',
      '/tmp/proj',
      '--output',
      'json',
    ]);
    expect(decide.id).toBe('prop-42');
    expect(decide.project).toBe('/tmp/proj');
    expect(decide.output).toBe('json');
  });

  it('registers the eval flags with all three modes', async () => {
    const argv = await buildSpec().parseAsync([
      'eval',
      '--corpus',
      '/tmp/corpus',
      '--mode',
      'full',
      '--live',
    ]);
    expect(argv._[0]).toBe('eval');
    expect(argv.corpus).toBe('/tmp/corpus');
    expect(argv.mode).toBe('full');
    expect(argv.live).toBe(true);

    const defaults = await buildSpec().parseAsync(['eval']);
    expect(defaults.mode).toBe('all');
    expect(defaults.live).toBe(false);
    // yargs rejects unknown choices (defer the call so a sync throw becomes
    // the rejection .rejects expects)
    await expect(
      Promise.resolve().then(() => buildSpec().parseAsync(['eval', '--mode', 'sideways'])),
    ).rejects.toThrow(/Invalid values/);
  });

  it('registers bootstrap with its approval and preview flags', async () => {
    const argv = await buildSpec().parseAsync(['bootstrap', '--yes', '--dry-run', '--model', 'm']);
    expect(argv._[0]).toBe('bootstrap');
    expect(argv.yes).toBe(true);
    expect(argv.dryRun).toBe(true);
    expect(argv.model).toBe('m');

    const defaults = await buildSpec().parseAsync(['bootstrap']);
    expect(defaults.yes).toBe(false);
    expect(defaults.dryRun).toBe(false);
  });
});
