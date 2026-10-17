/**
 * Living URS → PDF: a hand-rolled, zero-dependency PDF 1.4 renderer.
 *
 * WHY hand-rolled: the living URS is a linear text document (title, wrapped
 * headings, paragraphs, source refs), so a minimal writer is a few hundred
 * lines of Buffer assembly — pulling pdfkit/puppeteer into the dependency
 * tree for one export path would bloat the shipped bundle for nothing. The
 * module is PURE (no fs, no console): it only maps an `UrsDocument` to a
 * `Buffer`, callers decide where the bytes land, and the same input yields
 * a byte-identical PDF.
 *
 * LIMITATION: Latin/WinAnsi text only — base-14 Helvetica with
 * /WinAnsiEncoding. `toWinAnsi` maps U+0000–U+00FF plus common typographic
 * characters; any unmappable char renders as `?`.
 */

import type { UrsDocument } from '../pipeline/types.js';

// ── Layout constants ──────────────────────────────────────────────────

/** A4 portrait (pt). */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
/** Line advance = font size × this. */
const LINE_HEIGHT = 1.4;
/** Width heuristic: advance ≈ factor × font size per character. */
const WIDTH_REGULAR = 0.5;
const WIDTH_BOLD = 0.53;

const TITLE_SIZE = 18;
const SUBTITLE_SIZE = 9;
const HEADING_SIZE = 14;
const BODY_SIZE = 11;
const REF_SIZE = 9;

/** Gray fill for the subtitle (`0.45 g`); every later run resets to `0 g`. */
const GRAY_SUBTITLE = 0.45;
/** Gray fill for the dim `Referenced in:` line. */
const GRAY_DIM = 0.55;

// Vertical gaps (pt): title block → body, separator between sections,
// heading → body, between body paragraphs, body → source refs.
const TITLE_GAP = 18;
const SUBTITLE_GAP = 4;
const SECTION_GAP = 14;
const HEADING_GAP = 5;
const PARAGRAPH_GAP = 6;
const REF_GAP = 7;

// ── WinAnsi text encoding ─────────────────────────────────────────────

/**
 * Typographic chars outside Latin-1 → their WinAnsi (cp1252) bytes.
 * `© ® ° ± × ÷ § ¶` are already Latin-1 (U+0000–U+00FF) so they pass
 * through the direct rule below; anything still unmappable becomes `?`.
 */
const WIN_ANSI_OVERRIDES = new Map<number, number>([
  [0x2013, 0x96], // – en dash
  [0x2014, 0x97], // — em dash
  [0x2018, 0x91], // ‘ left single quote
  [0x2019, 0x92], // ’ right single quote
  [0x201c, 0x93], // “ left double quote
  [0x201d, 0x94], // ” right double quote
  [0x2026, 0x85], // … ellipsis
  [0x2122, 0x99], // ™ trademark
  [0x2022, 0x95], // • bullet
  [0x20ac, 0x80], // € euro
]);

/**
 * Maps text onto WinAnsiEncoding code units: U+0000–U+00FF pass through
 * directly, known typographic chars map to their cp1252 bytes, every other
 * code point becomes `?`. The result encodes 1:1 as a latin1 Buffer.
 */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xff) out += ch;
    else out += String.fromCharCode(WIN_ANSI_OVERRIDES.get(cp) ?? 0x3f);
  }
  return out;
}

/** Escapes + wraps raw text as a PDF literal string `(...)`. */
function pdfString(text: string): string {
  const escaped = toWinAnsi(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, '\\n');
  return `(${escaped})`;
}

// ── Word wrapping ─────────────────────────────────────────────────────

/** Counts code points so a surrogate pair counts (and breaks) as one unit. */
function countChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

function measure(text: string, size: number, bold: boolean): number {
  return countChars(text) * size * (bold ? WIDTH_BOLD : WIDTH_REGULAR);
}

/** Splits an over-long word into chunks that each fit; pairs stay whole. */
function hardBreakWord(word: string, maxWidth: number, size: number, bold: boolean): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const ch of word) {
    const candidate = current + ch;
    if (current !== '' && measure(candidate, size, bold) > maxWidth) {
      chunks.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/** Deterministic greedy word wrap against the content width. */
function wrapText(text: string, size: number, bold: boolean): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const joined = line === '' ? word : `${line} ${word}`;
    if (measure(joined, size, bold) <= CONTENT_WIDTH) {
      line = joined;
      continue;
    }
    if (line !== '') {
      lines.push(line);
      line = '';
    }
    if (measure(word, size, bold) <= CONTENT_WIDTH) {
      line = word;
      continue;
    }
    const chunks = hardBreakWord(word, CONTENT_WIDTH, size, bold);
    for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
    line = chunks[chunks.length - 1];
  }
  if (line !== '') lines.push(line);
  return lines;
}

// ── Page layout (shared by renderer + page estimator) ─────────────────

type PdfFont = 'F1' | 'F2';

/** One placed text line; `text` is raw — WinAnsi-encoded at serialization. */
interface PdfTextRun {
  readonly y: number;
  readonly font: PdfFont;
  readonly size: number;
  readonly gray: number;
  readonly text: string;
}

interface LayoutState {
  readonly pages: PdfTextRun[][];
  y: number;
}

function roundPt(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Drops the cursor (a vertical gap); pagination resolves on placement. */
function dropCursor(state: LayoutState, points: number): void {
  state.y = roundPt(state.y - points);
}

/** Places one line; once y drops below the bottom margin, starts a new page. */
function placeLine(
  state: LayoutState,
  font: PdfFont,
  size: number,
  gray: number,
  text: string,
): void {
  if (state.y < MARGIN) {
    state.pages.push([]);
    state.y = PAGE_HEIGHT - MARGIN;
  }
  state.pages[state.pages.length - 1].push({ y: state.y, font, size, gray, text });
  dropCursor(state, size * LINE_HEIGHT);
}

function layoutPages(
  doc: UrsDocument,
  opts?: { title?: string; subtitle?: string },
): PdfTextRun[][] {
  const state: LayoutState = { pages: [[]], y: PAGE_HEIGHT - MARGIN };

  for (const line of wrapText(opts?.title ?? doc.title, TITLE_SIZE, true)) {
    placeLine(state, 'F2', TITLE_SIZE, 0, line);
  }
  if (opts?.subtitle) {
    dropCursor(state, SUBTITLE_GAP);
    for (const line of wrapText(opts.subtitle, SUBTITLE_SIZE, false)) {
      placeLine(state, 'F1', SUBTITLE_SIZE, GRAY_SUBTITLE, line);
    }
  }
  dropCursor(state, TITLE_GAP);

  doc.sections.forEach((section, index) => {
    if (index > 0) dropCursor(state, SECTION_GAP);
    for (const line of wrapText(`## ${section.title}`, HEADING_SIZE, true)) {
      placeLine(state, 'F2', HEADING_SIZE, 0, line);
    }
    dropCursor(state, HEADING_GAP);
    section.text.split('\n').forEach((paragraph, pIndex) => {
      if (pIndex > 0) dropCursor(state, PARAGRAPH_GAP);
      if (paragraph.trim().length === 0) return;
      for (const line of wrapText(paragraph, BODY_SIZE, false)) {
        placeLine(state, 'F1', BODY_SIZE, 0, line);
      }
    });
    if (section.sourceRefs.length > 0) {
      dropCursor(state, REF_GAP);
      const refs = `Referenced in: ${section.sourceRefs.join(', ')}`;
      for (const line of wrapText(refs, REF_SIZE, false)) {
        placeLine(state, 'F1', REF_SIZE, GRAY_DIM, line);
      }
    }
  });

  return state.pages;
}

/**
 * Page count `renderUrsPdf` will produce — runs the exact same layout pass
 * the renderer serializes, so estimator and output can never disagree.
 */
export function estimateUrsPdfPages(
  doc: UrsDocument,
  opts?: { title?: string; subtitle?: string },
): number {
  return layoutPages(doc, opts).length;
}

// ── PDF file assembly ─────────────────────────────────────────────────

function formatPt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function serializePage(runs: readonly PdfTextRun[]): Buffer {
  let stream = '';
  for (const run of runs) {
    // Each run carries its own BT…ET with explicit Tf/g/Tm, so the subtitle
    // gray is implicitly reset by the next run's `0 g`.
    stream +=
      `BT /${run.font} ${run.size} Tf ${run.gray} g ` +
      `1 0 0 1 ${formatPt(MARGIN)} ${formatPt(run.y)} Tm ` +
      `(${pdfString(run.text)}) Tj\nET\n`;
  }
  return Buffer.from(stream, 'latin1');
}

/**
 * One xref entry, byte-exact `'%010d %05d %s\r\n'` → 20 bytes: 10-digit
 * offset, space, 5-digit gen, space, f/n flag, 2-byte EOL (the standard
 * fixed-stride xref entry parsers expect).
 */
function xrefEntry(offset: number, inUse: boolean): string {
  const generation = inUse ? '00000' : '65535';
  const flag = inUse ? 'n' : 'f';
  return `${String(offset).padStart(10, '0')} ${generation} ${flag}\r\n`;
}

/**
 * Renders the living URS as a minimal PDF 1.4 `Buffer` (A4, WinAnsi
 * Helvetica). Object layout: 1 catalog, 2 pages, 3 F1, 4 F2, then per page
 * a page object followed by its content-stream object. Offsets are tracked
 * while the file is assembled from Buffer chunks, so the xref is byte-accurate.
 */
export function renderUrsPdf(
  doc: UrsDocument,
  opts?: { title?: string; subtitle?: string },
): Buffer {
  const pages = layoutPages(doc, opts);
  const objectCount = 4 + pages.length * 2;
  const offsets = new Array<number>(objectCount + 1).fill(0);
  const chunks: Buffer[] = [];
  let cursor = 0;

  const push = (data: Buffer | string): void => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    chunks.push(buf);
    cursor += buf.length;
  };
  const beginObject = (num: number): void => {
    offsets[num] = cursor;
    push(`${num} 0 obj\n`);
  };

  push('%PDF-1.4\n');
  push('%\u00e2\u00e3\u00cf\u00d3\n'); // binary marker: file has non-ASCII bytes

  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  beginObject(3);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
  beginObject(4);
  push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n',
  );

  pages.forEach((runs, i) => {
    const pageNum = 5 + i * 2;
    const contentNum = pageNum + 1;
    beginObject(pageNum);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const content = serializePage(runs);
    beginObject(contentNum);
    push(`<< /Length ${content.length} >>\nstream\n`);
    push(content);
    push('\nendstream\nendobj\n');
  });

  const xrefOffset = cursor;
  const size = objectCount + 1;
  let xref = `xref\r\n0 ${size}\r\n`;
  xref += xrefEntry(0, false);
  for (let num = 1; num <= objectCount; num++) xref += xrefEntry(offsets[num], true);
  push(xref);
  push(`trailer\r\n<< /Size ${size} /Root 1 0 R >>\r\nstartxref\r\n${xrefOffset}\r\n%%EOF\r\n`);

  return Buffer.concat(chunks);
}
