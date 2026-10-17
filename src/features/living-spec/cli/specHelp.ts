/**
 * Hand-rolled help screen for `codexrev spec <subcommand>` — same style as
 * src/cli/help.ts (palette + aligned rows, no chalk, no yargs screen). One
 * screen covers the whole command; pass a subcommand to narrow the flag
 * section and examples. Colors auto-off when stdout is not a TTY.
 *
 * Route: `codexrev spec help [sub]`, or `codexrev spec <sub> --help`.
 */

const PALETTE = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
} as const;

const NO_COLOR_PALETTE = {
  reset: '',
  bold: '',
  dim: '',
  cyan: '',
  green: '',
  yellow: '',
  gray: '',
} as const;

export const SPEC_SUBCOMMANDS = [
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

export type SpecSubcommand = (typeof SPEC_SUBCOMMANDS)[number];

export function isSpecSubcommand(s: string): s is SpecSubcommand {
  return (SPEC_SUBCOMMANDS as readonly string[]).includes(s);
}

type SpecPaletteShape = Record<keyof typeof PALETTE, string>;

function colors(): SpecPaletteShape {
  return process.stdout.isTTY === true ? PALETTE : NO_COLOR_PALETTE;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string): number => s.replace(ANSI_RE, '').length;

type Writer = (s: string) => void;

/**
 * Renders the spec help screen. `write` is injectable for tests; the
 * default is stdout, matching `src/cli/help.ts`.
 */
export function renderSpecHelp(sub: string | undefined, write: Writer = defaultWrite): void {
  const c = colors();
  const b = (s: string) => `${c.bold}${s}${c.reset}`;
  const dim = (s: string) => `${c.dim}${s}${c.reset}`;
  const cyan = (s: string) => `${c.cyan}${s}${c.reset}`;
  const green = (s: string) => `${c.green}${s}${c.reset}`;
  const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
  const gray = (s: string) => `${c.gray}${s}${c.reset}`;

  const W = 78;
  const heading = (s: string): void => {
    write(`\n${b(cyan(s))}\n${gray('─'.repeat(W))}\n`);
  };
  const writeRow = (flag: string, arg: string, desc: string): void => {
    const left = `  ${green(flag)} ${arg ? yellow(arg) : ''}`;
    const l = visibleLength(left);
    write(`${left.padEnd(W - desc.length - 2 + (left.length - l))}  ${dim(desc)}\n`);
  };

  write(`\n${b(cyan('  codexrev spec'))} ${dim('— Living Specification Engine')}\n`);
  write(
    `${dim('  Analyzes changes and keeps a living URS in sync: implications, drift,\n')}` +
      `${dim('  scoped proposals, test-case deltas and drift alerts.')}\n`,
  );

  heading('Usage');
  write(`  ${green('$')} ${b('codexrev spec')} ${cyan('<subcommand>')} ${dim('[flags]')}\n`);
  write(`  ${green('$')} ${b('codexrev spec')} ${cyan('help')} ${dim('[analyze|bootstrap|watch|eval|status|history|accept|reject|defer]')}\n`);

  heading('Subcommands');
  const subcommandRows: Array<[string, string]> = [
    ['analyze', 'Analyze a diff once: implications, drift, proposals, test deltas'],
    ['bootstrap', 'Generate URS Version 0 from implemented code (approval required)'],
    ['watch', 'Foreground watch session over saves (Ctrl+C to stop — never a daemon)'],
    ['eval', 'Replay the labelled scenario corpus → evaluation report (research)'],
    ['status', 'URS version, open proposals, latest drift alerts'],
    ['history', 'URS versions with their trigger change ids'],
    ['accept <id>', 'Apply a pending proposal (the only path that updates the URS)'],
    ['reject <id>', 'Record a rejection — the URS is untouched'],
    ['defer <id>', 'Keep a proposal open and visible in status'],
  ];
  for (const [name, desc] of subcommandRows) writeRow(name, '', desc);

  heading('Global flags (all subcommands)');
  writeRow('--project', '<path>', 'Target project root (default: cwd)');
  writeRow('--output', '<fmt>', 'text | json  (default: text)');
  writeRow('--quiet', '', 'Suppress progress output (analyze/watch)');
  writeRow('--help, -h', '', 'Show this help screen');

  heading('analyze flags');
  writeRow('--diff', '<ref>', 'Git ref to diff against (default: staged changes)');
  writeRow('--dry-run', '', 'Deterministic analysis only — no model calls, nothing written');
  writeRow('--provider', '<name>', 'Inference provider override (default: local)');
  writeRow('--model', '<name>', 'Inference model override (e.g. qwen2.5-coder)');
  writeRow('--offline', '', 'Assert a local provider is used (no public network)');
  writeRow('--timeout', '<ms>', 'Per-request inference timeout (default: 120000)');

  heading('bootstrap flags');
  writeRow('--dry-run', '', 'Preview the generated URS without asking to save');
  writeRow('--yes', '', 'Approve the draft as URS Version 0 non-interactively (required off-TTY)');
  writeRow('--provider', '<name>', 'Inference provider override (default: local)');
  writeRow('--model', '<name>', 'Inference model override');
  writeRow('--offline', '', 'Assert a local provider is used (no public network)');

  heading('watch flags');
  writeRow('--debounce', '<ms>', 'Quiet period per change batch (default: 800)');
  writeRow('--paths', '<globs>', 'Comma-separated globs (overrides config watchedPaths)');
  writeRow('--dry-run', '', 'Deterministic analysis only — no model calls, nothing written');

  heading('eval flags');
  writeRow('--corpus', '<dir>', 'Scenario corpus directory (default: tests/…/fixtures/scenarios)');
  writeRow('--mode', '<mode>', 'A|B|C · batch|single-pass|full · live · all (default: all)');
  writeRow('--live', '', 'Use a live local model instead of the offline scripted provider');

  heading('Exit codes');
  writeRow('0', '', 'Success');
  writeRow('1', '', 'Error (bad config, unknown proposal, failed analysis)');
  writeRow('2', '', 'Bad usage (unknown subcommand or missing id)');

  heading('Examples');
  write(`  ${green('$')} ${b('codexrev spec')} ${cyan('analyze')} --diff HEAD~1${dim('   # one-shot analysis of the last commit')}\n`);
  write(`  ${green('$')} ${b('codexrev spec')} ${cyan('analyze')} --dry-run${dim('       # deterministic preview, nothing written')}\n`);
  write(`  ${green('$')} ${b('codexrev spec')} ${cyan('watch')} --debounce 500${dim('     # live watch session with the TUI view')}\n`);
  write(`  ${green('$')} ${b('codexrev spec')} ${cyan('status')} --output json${dim('     # machine-readable status for CI')}\n`);
  write(`  ${green('$')} ${b('codexrev spec')} ${cyan('accept')} ${yellow('<proposal-id>')}\n`);

  if (sub && isSpecSubcommand(sub)) {
    heading(`Details — codexrev spec ${sub}`);
    for (const line of subcommandDetails(sub)) write(`  ${dim(line)}\n`);
  }

  write(`\n${dim('State lives in <target-project>/.codexrev/living-spec/ — see docs/living-spec.md.')}\n\n`);
}

function subcommandDetails(sub: SpecSubcommand): string[] {
  switch (sub) {
    case 'analyze':
      return [
        'Extracts the diff, infers requirement implications (when a model is configured),',
        'compares them with the living URS, proposes scoped updates (pending until accepted)',
        'and writes reports/<changeId>.json. --dry-run runs the deterministic half only.',
      ];
    case 'bootstrap':
      return [
        'For projects WITHOUT a living URS: scans the implemented code (controllers,',
        'services, handlers and other business-logic homes first), asks the model to derive',
        'requirement sections with source references, and shows the draft for approval.',
        'On yes (interactive [y/N] on a TTY, or --yes for scripts — required off-TTY) it is',
        'saved as URS Version 0 in BOTH formats: urs/urs.json (+ .md) and urs/urs.pdf, plus',
        'the versions/v0 snapshot pair. --dry-run previews without saving; an existing URS',
        'is never overwritten (use spec analyze + accept to evolve it).',
      ];
    case 'watch':
      return [
        'Watches saves, debounces them per path and analyses each effective change through',
        'the full pipeline. Identical content is deduped (never analysed twice). On a TTY a',
        'live view shows pipeline progress; in pipes/CI the same events print as plain lines.',
      ];
    case 'eval':
      return [
        'Replays the labelled scenario corpus through three comparison modes (batch /',
        'single-pass / full) and computes implication precision/recall/F1, drift accuracy,',
        'false-alert rate on refactors, scoped-update correctness, test-delta relevance,',
        'latency (median/P95) and peak RSS. Writes reports/eval-<timestamp>.json + .md.',
        'Offline by default (scripted provider); --live uses a local model. See',
        'docs/living-spec-evaluation.md for reproduction and the requirements mapping.',
      ];
    case 'status':
      return [
        'Shows the URS version, open (pending/deferred) proposals with their drift status,',
        'and the latest drift alerts from the append-only reports/alerts.jsonl log.',
      ];
    case 'history':
      return ['Lists the append-only URS version snapshots, each with its trigger change id.'];
    case 'accept':
    case 'reject':
    case 'defer':
      return [
        'Acts on one pending proposal. Only `accept` applies the scoped patch: it bumps the',
        'URS version and records a snapshot. Reject/defer never touch the URS; deferred',
        'proposals stay visible in `codexrev spec status` until resolved.',
      ];
  }
}

function defaultWrite(s: string): void {
  process.stdout.write(s);
}
