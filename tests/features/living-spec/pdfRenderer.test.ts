import { describe, expect, it } from 'vitest';
import {
  estimateUrsPdfPages,
  renderUrsPdf,
  toWinAnsi,
} from '../../../src/features/living-spec/tools/pdfRenderer.js';
import type { UrsDocument } from '../../../src/features/living-spec/pipeline/types.js';

function doc(sections: UrsDocument['sections']): UrsDocument {
  return { schemaVersion: 1, title: 'User Requirements Specification', sections };
}

function section(overrides: Partial<UrsDocument['sections'][number]> = {}): UrsDocument['sections'][number] {
  return {
    id: 'req-example',
    title: 'Example requirement',
    text: 'The system must do the thing.',
    type: 'functional',
    version: 0,
    lastChangeId: 'bootstrap',
    sourceRefs: ['src/controllers/example.js:12'],
    ...overrides,
  };
}

/** Parses the byte-exact xref table and verifies every object offset. */
function verifyXref(pdf: Buffer): { objects: number; pages: number } {
  const start = pdf.lastIndexOf('startxref');
  expect(start).toBeGreaterThan(-1);
  const xrefOffset = Number(pdf.toString('latin1').slice(start).match(/startxref\s+(\d+)/)?.[1]);
  expect(Number.isInteger(xrefOffset)).toBe(true);
  expect(pdf.subarray(xrefOffset, xrefOffset + 4).toString('latin1')).toBe('xref');

  const table = pdf.toString('latin1').slice(xrefOffset);
  const entries = table.split('\r\n').slice(2); // 'xref' + '0 N' headers
  let count = 0;
  for (const entry of entries) {
    const m = /^(\d{10}) (\d{5}) (f|n)$/.exec(entry);
    if (!m) break;
    count++;
    if (m[3] === 'f') continue; // free entry 0 points nowhere
    const offset = Number(m[1]);
    const at = pdf.subarray(offset, offset + 20).toString('latin1');
    expect(at).toMatch(/^\d+ 0 obj/); // offset resolves to an object header
  }
  expect(count).toBeGreaterThan(4);

  const body = pdf.toString('latin1');
  const pages = (body.match(/\/Type \/Page[^s]/g) ?? []).length;
  return { objects: count, pages };
}

/** Extracts every `( … ) Tj` show-text payload (already WinAnsi). */
function extractText(pdf: Buffer): string {
  const body = pdf.toString('latin1');
  return [...body.matchAll(/\((.*)\) Tj/g)]
    .map((m) => m[1].replace(/\\([()\\])/g, '$1'))
    .join('\n');
}

describe('renderUrsPdf', () => {
  it('produces a structurally valid PDF with a byte-accurate xref', () => {
    const pdf = renderUrsPdf(doc([section()]));
    expect(pdf.subarray(0, 6).toString('latin1')).toBe('%PDF-1');
    expect(pdf.toString('latin1')).toContain('%%EOF');
    const { objects } = verifyXref(pdf);
    expect(objects).toBeGreaterThanOrEqual(6); // catalog+pages+2 fonts+page+content
  });

  it('renders the title, sections and source references into the text layer', () => {
    const pdf = renderUrsPdf(
      doc([
        section(),
        section({
          id: 'req-auth',
          title: 'Login must verify the password',
          text: 'The login controller must reject wrong passwords.',
          type: 'nfr',
          sourceRefs: ['src/controllers/auth.js:4', 'src/service.js:9-11'],
        }),
      ]),
      { subtitle: 'Version 0 · bootstrap · 2026-10-17' },
    );
    const text = extractText(pdf);
    expect(text).toContain('User Requirements Specification');
    expect(text).toContain('Version 0');
    expect(text).toContain('Example requirement');
    expect(text).toContain('Login must verify the password');
    expect(text).toContain('src/controllers/example.js:12');
    expect(text).toContain('src/controllers/auth.js:4');
    expect(text).toContain('src/service.js:9-11');
  });

  it('escapes parentheses, backslashes and non-WinAnsi characters safely', () => {
    const pdf = renderUrsPdf(
      doc([
        section({
          title: 'Escapes (nested (deeply)) and a back\\slash',
          text: 'Must handle a(b) and C:\\path — plus 中文 dropped to question marks.',
        }),
      ]),
    );
    // structure survives hostile text
    verifyXref(pdf);
    const text = extractText(pdf);
    expect(text).toContain('Escapes (nested (deeply)) and a back\\slash');
    expect(text).toContain('Must handle a(b) and C:\\path');
    expect(text).toContain('\u0097'); // WinAnsi em-dash byte (0x97) survives extraction
    expect(text).not.toContain('中'); // unmappable → '?'
  });

  it('maps typographic characters via WinAnsi and replaces unmappable ones', () => {
    expect(toWinAnsi('plain ASCII 123')).toBe('plain ASCII 123');
    expect(toWinAnsi('café')).toBe('café'); // Latin-1 passes through
    expect(toWinAnsi('a—b')).toBe('a\x97b'); // em dash → cp1252 byte 0x97
    expect(toWinAnsi('x中文y')).toBe('x??y');
    // the rendered byte for an em dash is WinAnsi 0x97
    const pdf = renderUrsPdf(doc([section({ text: 'dash — here' })]));
    expect(pdf.includes(Buffer.from([0x97]))).toBe(true);
  });

  it('paginates long documents and the page count matches the estimator', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      section({
        id: `req-${i + 1}`,
        title: `Requirement number ${i + 1}`,
        text: `The system must handle requirement number ${i + 1} correctly. `.repeat(4),
        sourceRefs: [`src/area/module-${i + 1}.js:${i + 1}`],
      }),
    );
    const longDoc = doc(many);
    const pdf = renderUrsPdf(longDoc);
    const { pages } = verifyXref(pdf);
    const estimated = estimateUrsPdfPages(longDoc);
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBe(estimated);
    expect(pdf.toString('latin1')).toContain(`/Count ${pages}`);
  });
});
