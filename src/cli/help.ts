/**
 * Codexrev — friendly, colored CLI help.
 *
 * Replaces yargs' default `--help` output with a hand-formatted screen
 * that uses ANSI colors (auto-disabled when stdout is not a TTY). No
 * external chalk/picocolors dep — keeps the bundle lean.
 */

import { PROVIDER_IDS } from '../providers/registry.js';

const PALETTE = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
} as const;

const NO_COLOR_PALETTE = {
  reset: '',
  bold: '',
  dim: '',
  cyan: '',
  green: '',
  yellow: '',
  magenta: '',
  gray: '',
  red: '',
} as const;

function colors(forceColor: boolean) {
  const useColor = forceColor || process.stdout.isTTY === true;
  return useColor ? PALETTE : NO_COLOR_PALETTE;
}

const VERSION = '0.1.0';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string): number => s.replace(ANSI_RE, '').length;

export function renderHelp(): void {
  const c = colors(false);
  const dim = (s: string) => `${c.dim}${s}${c.reset}`;
  const b = (s: string) => `${c.bold}${s}${c.reset}`;
  const cyan = (s: string) => `${c.cyan}${s}${c.reset}`;
  const green = (s: string) => `${c.green}${s}${c.reset}`;
  const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
  const gray = (s: string) => `${c.gray}${s}${c.reset}`;

  const W = 70;

  const heading = (s: string): void => {
    process.stdout.write(`\n${b(cyan(s))}\n${gray('─'.repeat(W))}\n`);
  };

  process.stdout.write('\n');
  process.stdout.write(`${b(cyan('  ⚡ codexrev'))}  ${dim(`v${VERSION}`)}\n`);
  process.stdout.write(
    `${dim('  Multi-provider, agentic command-line AI assistant.')}\n`,
  );

  heading('Usage');
  process.stdout.write(`  ${green('$')} ${b('codexrev')} ${dim('[prompt]')}\n`);
  process.stdout.write(`  ${green('$')} ${b('codexrev')} ${cyan('init')} ${dim('[flags]')}\n`);
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('extensions')} ${dim('<list|install|uninstall>')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models')} ${dim('<list|add|remove|use>')}\n`,
  );

  heading('Commands');
  process.stdout.write(
    `  ${b(cyan('init'))}            ${'Initialize this project with an encrypted .codexrev/config.json'}\n`,
  );
  process.stdout.write(
    `  ${b(cyan('extensions'))}      ${'Manage installed extensions  '}${dim('(~/.codexrev/extensions/)')}\n`,
  );
  process.stdout.write(
    `  ${b(cyan('models'))}          ${'Manage AI provider models  '}${dim('(add, list, use, remove)')}\n`,
  );

  const writeRow = (flag: string, arg: string, desc: string): void => {
    const left = `  ${green(flag)} ${arg ? yellow(arg) : ''}`;
    const l = visibleLength(left);
    process.stdout.write(
      `${left.padEnd(W - desc.length - 2 + (left.length - l))}  ${dim(desc)}\n`,
    );
  };

  heading('Options');
  const rows: Array<[string, string, string]> = [
    ['--provider', '<name>', PROVIDER_IDS.join(' | ')],
    ['--model', '<name>', 'Model name (provider-specific)'],
    ['--sandbox', '<mode>', 'auto | seatbelt | docker | podman | off'],
    ['--theme', '<name>', 'dark | light | solarized | monokai | nord'],
    ['--telemetry', '', 'Enable OpenTelemetry export'],
    ['--no-update', '', 'Skip background update check'],
    ['--print, -p', '<prompt>', 'Run non-interactively, print result'],
    ['--output-format', '<fmt>', 'text | json | stream-json  (default: text)'],
    ['--approval-mode', '<mode>', 'always | on-request | never'],
    ['--debug', '', 'Verbose debug logging'],
    ['--help, -h', '', 'Show this help screen'],
    ['--version', '', 'Show codexrev version'],
  ];
  for (const [flag, arg, desc] of rows) writeRow(flag, arg, desc);

  heading('Init flags (with `codexrev init`)');
  const initRows: Array<[string, string, string]> = [
    ['--provider', '<name>', 'LLM provider'],
    ['--model', '<name>', 'Model name'],
    ['--api-key', '<key>', 'Provider API key (non-interactive only)'],
    ['--base-url', '<url>', 'Provider base URL (optional)'],
    ['--reset', '', 'Replace existing config'],
    ['--non-interactive', '', 'Skip TUI wizard (CI / scripting)'],
  ];
  for (const [flag, arg, desc] of initRows) writeRow(flag, arg, desc);

  heading('Examples');
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')}\n${dim('      launches the interactive TUI')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('"refactor src/api/handler.ts to use async/await"')}\n`,
  );
  process.stdout.write(`  ${green('$')} ${b('codexrev')} -p ${cyan('"summarize this repo"')}\n`);
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('init')} --provider openai --model gpt-4o --api-key ${yellow('$OPENAI_API_KEY')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('init')} --provider ollama --model llama3.1 ${dim('  # no --api-key needed')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('init')} ${dim('  # launches the TUI wizard')}\n`,
  );

  heading('Models management');
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models add')}${dim('                                              interactive wizard (requires TTY)')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models list')}${dim('                                           list all providers & models')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models use')} ${yellow('<id>')} --provider ${yellow('<name>')}${dim('            set active model')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models remove provider')} ${yellow('<name>')}${dim('                 remove a provider')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models remove model')} ${yellow('<id>')} --provider ${yellow('<name>')}${dim('     remove a model')}\n`,
  );

  heading('Models examples');
  process.stdout.write(
    `  ${dim('# Launch interactive wizard — step by step (requires TTY)')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models add')}\n`,
  );
  process.stdout.write(
    `  ${dim('# Switch active model and list')}\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models use')} ${yellow('claude-sonnet-4-20250514')} --provider anthropic-team\n`,
  );
  process.stdout.write(
    `  ${green('$')} ${b('codexrev')} ${cyan('models list')}\n`,
  );

  heading('Models flags');
  const modelRows: Array<[string, string, string]> = [
    ['--provider', '<name>', 'Provider name (for remove model, use)'],
  ];
  for (const [flag, arg, desc] of modelRows) writeRow(flag, arg, desc);

  heading('Learn more');
  process.stdout.write(
    `  ${dim('docs:   ')} ${cyan('https://github.com/codexrev/codexrev#readme')}\n`,
  );
  process.stdout.write(`  ${dim('config: ')} ${cyan('docs/cli/configuration.md')}\n`);
  process.stdout.write(
    `  ${dim('issues: ')} ${cyan('https://github.com/codexrev/codexrev/issues')}\n`,
  );

  process.stdout.write('\n');
}

export function renderVersion(): void {
  const c = colors(false);
  process.stdout.write(`\n${c.bold}${c.cyan}codexrev${c.reset} ${c.dim}v${VERSION}${c.reset}\n\n`);
}