/**
 * Small terminal toolkit for the assessment report: capability detection,
 * ANSI colors, wrapping, alignment and bars. No dependencies.
 *
 * Principles:
 *   - Color is decoration, never the message. Every status and decision is also
 *     a WORD (PASS, BLOCK ...) and a symbol; the plain-text fallback loses nothing.
 *   - Layout is computed on the VISIBLE text, and styling is applied last, so
 *     escape codes can never break alignment or wrapping.
 *   - ANSI only goes to a real terminal, unless FORCE_COLOR asks for it; NO_COLOR
 *     always wins. Unicode (box lines, block bars) only where it is reliable;
 *     everywhere else the report uses plain ASCII.
 */

export interface RenderOptions {
  /** emit ANSI color/bold codes */
  readonly color: boolean;
  /** use Unicode symbols and block characters; otherwise ASCII only */
  readonly unicode: boolean;
  /** usable width in columns, already clamped */
  readonly width: number;
}

/** Deterministic, escape-free, ASCII output: used when nothing says otherwise (and in pure tests). */
export const PLAIN_OPTIONS: RenderOptions = { color: false, unicode: false, width: 80 };

export const MIN_WIDTH = 40;
export const MAX_WIDTH = 100;
const DEFAULT_WIDTH = 80;

interface StreamLike {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

function unicodeIsReliable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.TERM === 'dumb') return false;
  if (platform === 'win32') {
    // legacy consoles mangle box characters; Windows Terminal, VS Code and ConEmu are fine
    return Boolean(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode' || env.ConEmuANSI === 'ON' || /^xterm/.test(env.TERM ?? '');
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (locale === '') return true;
  if (/^(C|POSIX)$/i.test(locale)) return false;
  return /utf-?8/i.test(locale) || !/\./.test(locale);
}

/**
 * Decides how to render, from the environment and the output stream.
 *   color:   NO_COLOR (any non-empty value) always disables it. Otherwise
 *            FORCE_COLOR (anything but 0/false) enables it even when piped;
 *            FORCE_COLOR=0/false disables it. With neither, only a real terminal gets color.
 *   unicode: only on a real terminal that handles it; never when piped.
 *   width:   the terminal's columns, clamped to 40..100; 80 when unknown (piped).
 */
export function detectRenderOptions(
  env: NodeJS.ProcessEnv = process.env,
  stream: StreamLike = process.stdout,
  platform: NodeJS.Platform = process.platform,
): RenderOptions {
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const force = env.FORCE_COLOR?.toLowerCase();
  const forcedOff = force === '0' || force === 'false';
  const forcedOn = force !== undefined && !forcedOff;
  const isTty = stream.isTTY === true;
  const color = !noColor && !forcedOff && (forcedOn || (isTty && env.TERM !== 'dumb'));
  const unicode = isTty && unicodeIsReliable(env, platform);
  const columns = typeof stream.columns === 'number' && Number.isFinite(stream.columns) && stream.columns > 0 ? stream.columns : DEFAULT_WIDTH;
  return { color, unicode, width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(columns))) };
}

// ---------------------------------------------------------------- text helpers (layout on visible text only)

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, '');
export const visibleLength = (s: string): number => stripAnsi(s).length;

export function padRight(s: string, width: number): string {
  const n = width - visibleLength(s);
  return n > 0 ? s + ' '.repeat(n) : s;
}

/**
 * Word-wraps `text` to `width` columns. `indent` is the hanging indent for
 * continuation lines; `first` is the prefix of the first line (defaults to the
 * indent). A word longer than the line is split rather than overflowing.
 */
export function wrapText(text: string, width: number, indent = '', first: string = indent): string[] {
  const lines: string[] = [];
  let prefix = first;
  let line = '';
  const room = (): number => Math.max(8, width - prefix.length);
  const flush = (): void => {
    lines.push(prefix + line);
    prefix = indent;
    line = '';
  };
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    let w = word;
    while (w.length > room()) {
      if (line.length > 0) flush();
      const cut = room();
      lines.push(prefix + w.slice(0, cut));
      prefix = indent;
      w = w.slice(cut);
    }
    if (line.length === 0) line = w;
    else if (line.length + 1 + w.length <= room()) line += ` ${w}`;
    else {
      flush();
      line = w;
    }
  }
  if (line.length > 0 || lines.length === 0) flush();
  return lines;
}

// ---------------------------------------------------------------- styling

export type Tone = 'green' | 'yellow' | 'red' | 'cyan' | 'gray' | 'plain';

export interface Style {
  readonly options: RenderOptions;
  paint(text: string, tone: Tone, opts?: { bold?: boolean; dim?: boolean }): string;
  bold(text: string): string;
  dim(text: string): string;
  /** symbols and drawing characters, Unicode or ASCII */
  readonly sym: Readonly<Record<'pass' | 'fail' | 'unknown' | 'na' | 'allow' | 'escalate' | 'block' | 'incomplete' | 'bullet' | 'arrow' | 'dot' | 'up' | 'sub', string>>;
  heading(title: string): string;
  /** a horizontal bar for a 0..1 value: Unicode blocks, or [###---] in ASCII */
  bar(value: number, width: number, tone: Tone): string;
}

const TONE_CODE: Record<Tone, string> = { green: '32', yellow: '33', red: '31', cyan: '36', gray: '90', plain: '' };

export function createStyle(options: RenderOptions): Style {
  const u = options.unicode;
  const sym = u
    ? { pass: '✔', fail: '✖', unknown: '?', na: '–', allow: '✔', escalate: '▲', block: '✖', incomplete: '◐', bullet: '•', arrow: '→', dot: '·', up: '▲', sub: '↳' }
    : { pass: '+', fail: 'x', unknown: '?', na: '-', allow: '+', escalate: '^', block: 'x', incomplete: '~', bullet: '*', arrow: '->', dot: '|', up: '^', sub: '`-' };

  const wrapCode = (code: string, text: string): string => (options.color && code !== '' ? `\x1b[${code}m${text}\x1b[0m` : text);

  const paint: Style['paint'] = (text, tone, opts = {}) => {
    const codes = [opts.bold ? '1' : '', opts.dim ? '2' : '', TONE_CODE[tone]].filter((c) => c !== '').join(';');
    return wrapCode(codes, text);
  };

  const hline = u ? '─' : '-';
  return {
    options,
    paint,
    bold: (t) => wrapCode('1', t),
    dim: (t) => wrapCode('2', t),
    sym,
    heading(title: string): string {
      const lead = `${hline}${hline} `;
      const fill = Math.max(2, options.width - lead.length - title.length - 1);
      return paint(lead, 'cyan') + paint(title, 'cyan', { bold: true }) + paint(` ${hline.repeat(fill)}`, 'cyan');
    },
    bar(value: number, width: number, tone: Tone): string {
      const v = Math.min(1, Math.max(0, value));
      const inner = Math.max(4, width - (u ? 0 : 2));
      const filled = Math.round(v * inner);
      if (u) return paint('█'.repeat(filled), tone) + paint('░'.repeat(inner - filled), 'gray');
      return `[${paint('#'.repeat(filled), tone)}${'-'.repeat(inner - filled)}]`;
    },
  };
}
