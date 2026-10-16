import { describe, expect, it } from 'vitest';
import {
  MAX_WIDTH,
  MIN_WIDTH,
  PLAIN_OPTIONS,
  createStyle,
  detectRenderOptions,
  padRight,
  stripAnsi,
  visibleLength,
  wrapText,
} from '../../../../src/features/action-safety/cli/terminalStyle.js';

const tty = (columns?: number) => ({ isTTY: true, ...(columns !== undefined ? { columns } : {}) });
const pipe = { isTTY: false } as const;

describe('detectRenderOptions: color', () => {
  it('colors a real terminal and not a pipe', () => {
    expect(detectRenderOptions({}, tty(100), 'linux').color).toBe(true);
    expect(detectRenderOptions({}, pipe, 'linux').color).toBe(false);
    expect(detectRenderOptions({}, {}, 'linux').color).toBe(false);
  });

  it('NO_COLOR disables color, even on a terminal', () => {
    expect(detectRenderOptions({ NO_COLOR: '1' }, tty(), 'linux').color).toBe(false);
    expect(detectRenderOptions({ NO_COLOR: 'anything' }, tty(), 'linux').color).toBe(false);
  });

  it('an empty NO_COLOR is ignored, as the convention says', () => {
    expect(detectRenderOptions({ NO_COLOR: '' }, tty(), 'linux').color).toBe(true);
  });

  it('FORCE_COLOR turns color on even when piped', () => {
    for (const v of ['1', '2', '3', 'true', '']) expect(detectRenderOptions({ FORCE_COLOR: v }, pipe, 'linux').color, v).toBe(true);
  });

  it('FORCE_COLOR=0 or false turns color off even on a terminal', () => {
    expect(detectRenderOptions({ FORCE_COLOR: '0' }, tty(), 'linux').color).toBe(false);
    expect(detectRenderOptions({ FORCE_COLOR: 'false' }, tty(), 'linux').color).toBe(false);
  });

  it('NO_COLOR wins over FORCE_COLOR', () => {
    expect(detectRenderOptions({ NO_COLOR: '1', FORCE_COLOR: '1' }, tty(), 'linux').color).toBe(false);
    expect(detectRenderOptions({ NO_COLOR: '1', FORCE_COLOR: '1' }, pipe, 'linux').color).toBe(false);
  });

  it('a dumb terminal gets no color unless forced', () => {
    expect(detectRenderOptions({ TERM: 'dumb' }, tty(), 'linux').color).toBe(false);
    expect(detectRenderOptions({ TERM: 'dumb', FORCE_COLOR: '1' }, tty(), 'linux').color).toBe(true);
  });
});

describe('detectRenderOptions: unicode and width', () => {
  it('uses Unicode only on a real terminal that handles it', () => {
    expect(detectRenderOptions({ LANG: 'en_US.UTF-8' }, tty(), 'linux').unicode).toBe(true);
    expect(detectRenderOptions({ LANG: 'en_US.UTF-8' }, pipe, 'linux').unicode).toBe(false); // piped: ASCII
    expect(detectRenderOptions({ LANG: 'C' }, tty(), 'linux').unicode).toBe(false);
    expect(detectRenderOptions({ LANG: 'POSIX' }, tty(), 'linux').unicode).toBe(false);
    expect(detectRenderOptions({ TERM: 'dumb' }, tty(), 'linux').unicode).toBe(false);
  });

  it('on Windows only modern terminals get Unicode', () => {
    expect(detectRenderOptions({}, tty(), 'win32').unicode).toBe(false); // legacy console
    expect(detectRenderOptions({ WT_SESSION: 'x' }, tty(), 'win32').unicode).toBe(true);
    expect(detectRenderOptions({ TERM_PROGRAM: 'vscode' }, tty(), 'win32').unicode).toBe(true);
  });

  it('forced color on a pipe does not switch to Unicode', () => {
    expect(detectRenderOptions({ FORCE_COLOR: '1', LANG: 'en_US.UTF-8' }, pipe, 'linux')).toMatchObject({ color: true, unicode: false });
  });

  it('uses the terminal width, clamped to a readable range, and 80 when unknown', () => {
    expect(detectRenderOptions({}, tty(120), 'linux').width).toBe(MAX_WIDTH);
    expect(detectRenderOptions({}, tty(20), 'linux').width).toBe(MIN_WIDTH);
    expect(detectRenderOptions({}, tty(72), 'linux').width).toBe(72);
    expect(detectRenderOptions({}, tty(), 'linux').width).toBe(80);
    expect(detectRenderOptions({}, pipe, 'linux').width).toBe(80);
    expect(detectRenderOptions({}, { isTTY: true, columns: Number.NaN }, 'linux').width).toBe(80);
  });

  it('the default plain options have no color, no Unicode and a fixed width', () => {
    expect(PLAIN_OPTIONS).toEqual({ color: false, unicode: false, width: 80 });
  });
});

describe('text helpers', () => {
  it('measures and pads on visible text, ignoring ANSI codes', () => {
    const painted = '\x1b[1;31mFAIL\x1b[0m';
    expect(visibleLength(painted)).toBe(4);
    expect(stripAnsi(painted)).toBe('FAIL');
    expect(visibleLength(padRight(painted, 10))).toBe(10);
    expect(padRight('abc', 2)).toBe('abc');
  });

  it('wraps at word boundaries with a hanging indent and never exceeds the width', () => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps running through the long forest path';
    const lines = wrapText(text, 30, '    ', '  * ');
    expect(lines[0].startsWith('  * ')).toBe(true);
    for (const l of lines.slice(1)) expect(l.startsWith('    ')).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    expect(lines.map((l) => l.trim().replace(/^\*\s*/, '')).join(' ')).toBe(text);
  });

  it('splits a word that is longer than the line instead of overflowing', () => {
    const lines = wrapText('x'.repeat(100), 40, '  ');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
    expect(lines.join('').replace(/\s/g, '')).toBe('x'.repeat(100));
  });

  it('keeps empty input to a single empty line', () => {
    expect(wrapText('', 40, '  ')).toEqual(['  ']);
  });
});

describe('createStyle', () => {
  it('adds no escape codes when color is off', () => {
    const st = createStyle(PLAIN_OPTIONS);
    expect(st.paint('x', 'red', { bold: true })).toBe('x');
    expect(st.bold('x')).toBe('x');
    expect(st.dim('x')).toBe('x');
    expect(st.heading('Title')).not.toContain(String.fromCharCode(27));
  });

  it('adds semantic color codes when color is on', () => {
    const st = createStyle({ color: true, unicode: false, width: 80 });
    expect(st.paint('x', 'green')).toBe('\x1b[32mx\x1b[0m');
    expect(st.paint('x', 'yellow')).toBe('\x1b[33mx\x1b[0m');
    expect(st.paint('x', 'red', { bold: true })).toBe('\x1b[1;31mx\x1b[0m');
    expect(st.paint('x', 'cyan')).toBe('\x1b[36mx\x1b[0m');
    expect(st.dim('x')).toBe('\x1b[2mx\x1b[0m');
  });

  it('uses ASCII symbols and [###---] bars without Unicode, and blocks with it', () => {
    const ascii = createStyle({ color: false, unicode: false, width: 80 });
    const uni = createStyle({ color: false, unicode: true, width: 80 });
    expect(ascii.bar(0.5, 12, 'green')).toBe('[#####-----]');
    expect(uni.bar(0.5, 10, 'green')).toBe('█████░░░░░');
    expect([ascii.sym.pass, ascii.sym.fail, ascii.sym.unknown]).toEqual(['+', 'x', '?']);
    expect([uni.sym.pass, uni.sym.fail, uni.sym.unknown]).toEqual(['✔', '✖', '?']);
    for (const v of Object.values(ascii.sym)) expect(/^[\x20-\x7e]+$/.test(v), v).toBe(true);
  });

  it('bars clamp out-of-range values and keep a constant visible width', () => {
    const st = createStyle({ color: true, unicode: true, width: 80 });
    expect(visibleLength(st.bar(-1, 20, 'red'))).toBe(20);
    expect(visibleLength(st.bar(2, 20, 'red'))).toBe(20);
    expect(visibleLength(st.bar(0.37, 20, 'yellow'))).toBe(20);
  });

  it('headings fill the width', () => {
    for (const unicode of [false, true]) {
      const st = createStyle({ color: false, unicode, width: 60 });
      expect(visibleLength(st.heading('Safety score'))).toBe(60);
    }
  });
});
