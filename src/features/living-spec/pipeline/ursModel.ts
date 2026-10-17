/**
 * Living URS representation — the machine-processable JSON state plus the
 * human-readable Markdown rendering.
 *
 * The structured `UrsDocument` is the source of truth; `urs.md` is a
 * deterministic rendering of it. Every requirement lives in a `UrsSection`
 * keyed by its stable `id`, and each section is delimited in the markdown by
 * `<!-- req:<id> -->` markers so downstream patching can reason about (and
 * surgically touch) individual sections without touching their neighbours.
 *
 * This module is PURE (no fs, no clock) apart from an injectable timestamp on
 * the seed factory — so it stays trivially unit-testable.
 */

import type {
  UrsDocument,
  UrsRequirementType,
  UrsSection,
} from './types.js';

export const URS_REQUIREMENT_TYPES: readonly UrsRequirementType[] = ['functional', 'nfr'];

/** Section-start marker used in `urs.md` (stable, machine-scannable). */
export function sectionOpenMarker(id: string): string {
  return `<!-- req:${id} -->`;
}

/** Section-end marker used in `urs.md`. */
export function sectionCloseMarker(id: string): string {
  return `<!-- /req:${id} -->`;
}

/** The markdown block for a single section (deterministic, verbatim body). */
export function sectionMarkdownBlock(section: UrsSection): string {
  return [
    sectionOpenMarker(section.id),
    `## ${section.title}`,
    '',
    section.text,
    sectionCloseMarker(section.id),
  ].join('\n');
}

/**
 * Renders the whole living URS to markdown. Pure and deterministic: a section
 * whose data is unchanged renders byte-identically, so scoped patching leaves
 * untouched sections byte-identical in the rendered document.
 */
export function renderUrsMarkdown(doc: UrsDocument): string {
  const header = `# ${doc.title}`;
  if (doc.sections.length === 0) return `${header}\n`;
  const blocks = doc.sections.map(sectionMarkdownBlock);
  return `${header}\n\n${blocks.join('\n\n')}\n`;
}

/** Finds a section by its stable id. */
export function findSection(doc: UrsDocument, id: string): UrsSection | undefined {
  return doc.sections.find((s) => s.id === id);
}

/** Creates a starter URS skeleton (Feature 2 seed support). */
export function seedUrsDocument(): UrsDocument {
  return {
    schemaVersion: 1,
    title: 'User Requirements Specification',
    sections: [
      {
        id: 'req-overview',
        title: 'Overview',
        text:
          'This living URS is generated and maintained by codexrev. Each requirement ' +
          'below is a scoped section that is updated only through accepted proposals.',
        type: 'functional',
        version: 0,
        lastChangeId: 'seed',
        sourceRefs: [],
      },
    ],
  };
}

// ── JSON parsing / validation ─────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSection(raw: unknown, index: number): UrsSection {
  if (!isRecord(raw)) {
    throw new Error(`URS section[${index}] must be an object`);
  }
  const { id, title, text, type, version, lastChangeId, sourceRefs } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`URS section[${index}].id must be a non-empty string`);
  }
  if (typeof title !== 'string') throw new Error(`URS section[${index}].title must be a string`);
  if (typeof text !== 'string') throw new Error(`URS section[${index}].text must be a string`);
  if (type !== 'functional' && type !== 'nfr') {
    throw new Error(`URS section[${index}].type must be "functional" | "nfr"`);
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(`URS section[${index}].version must be a non-negative integer`);
  }
  if (typeof lastChangeId !== 'string') {
    throw new Error(`URS section[${index}].lastChangeId must be a string`);
  }
  if (!Array.isArray(sourceRefs) || sourceRefs.some((r) => typeof r !== 'string')) {
    throw new Error(`URS section[${index}].sourceRefs must be a string[]`);
  }
  return {
    id,
    title,
    text,
    type,
    version,
    lastChangeId,
    sourceRefs: sourceRefs as string[],
  };
}

/** Validates + normalizes raw JSON into an `UrsDocument`; throws on bad shape. */
export function parseUrsDocument(raw: unknown): UrsDocument {
  if (!isRecord(raw)) throw new Error('URS document must be an object');
  if (raw.schemaVersion !== 1) throw new Error('URS document.schemaVersion must be 1');
  if (typeof raw.title !== 'string') throw new Error('URS document.title must be a string');
  if (!Array.isArray(raw.sections)) throw new Error('URS document.sections must be an array');

  const sections = raw.sections.map(parseSection);
  const seen = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.id)) throw new Error(`duplicate URS section id: ${s.id}`);
    seen.add(s.id);
  }
  return { schemaVersion: 1, title: raw.title, sections };
}

/** Convenience: serialize a document back to pretty JSON. */
export function serializeUrsDocument(doc: UrsDocument): string {
  return JSON.stringify(doc, null, 2);
}
