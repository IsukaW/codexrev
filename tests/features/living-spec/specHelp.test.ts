import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderSpecHelp, SPEC_SUBCOMMANDS } from '../../../src/features/living-spec/cli/specHelp.js';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';

function captureHelp(sub?: string): string {
  let out = '';
  renderSpecHelp(sub, (s) => {
    out += s;
  });
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('renderSpecHelp — hand-rolled per-command screen', () => {
  it('lists every subcommand, the global flags and the exit codes', () => {
    const help = captureHelp();
    expect(help).toContain('codexrev spec');
    for (const sub of SPEC_SUBCOMMANDS) expect(help).toContain(sub);
    expect(help).toContain('--project');
    expect(help).toContain('--output');
    expect(help).toContain('--quiet');
    expect(help).toContain('Exit codes');
    expect(help).toContain('analyze flags');
    expect(help).toContain('watch flags');
    expect(help).toContain('accept <id>');
  });

  it('narrows to a subcommand details section when asked', () => {
    const help = captureHelp('watch');
    expect(help).toContain('Details — codexrev spec watch');
    expect(help).toContain('deduped');
    expect(help).toContain('Ctrl+C');
  });

  it('accepts an unknown sub string without a details section', () => {
    const help = captureHelp('nonsense');
    expect(help).not.toContain('Details —');
    expect(help).toContain('analyze'); // the base screen still renders
  });
});

describe('spec help dispatch', () => {
  it('`spec help` prints the screen on stdout and exits 0', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    await handleSpecCommand(['help'], {});
    const out = writes.join('');
    expect(out).toContain('codexrev spec');
    expect(out).toContain('Subcommands');
    expect(process.exitCode ?? 0).toBe(0);

    // and with a subcommand argument
    writes.length = 0;
    await handleSpecCommand(['help', 'analyze'], {});
    expect(writes.join('')).toContain('Details — codexrev spec analyze');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('no subcommand still prints short usage on stderr with exit code 2', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await handleSpecCommand([], {});
    expect(errors.join('\n')).toContain('usage: codexrev spec <subcommand>');
    expect(process.exitCode).toBe(2);
  });

  it('an unknown subcommand prints usage with exit code 2', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await handleSpecCommand(['frobnicate'], {});
    expect(errors.join('\n')).toContain('Unknown spec subcommand: frobnicate');
    expect(errors.join('\n')).toContain('usage: codexrev spec <subcommand>');
    expect(process.exitCode).toBe(2);
  });
});
