/**
 * Scoped URS patcher — turns drift classifications into human-gated, scoped
 * update proposals (FR8/FR12/FR13) and applies accepted patches.
 *
 * Scoping guarantee (SO4): a patch touches ONLY the requirement sections it
 * lists. `applyPatch` rebuilds the document leaving every untouched section as
 * the *same* value (byte-identical text), so an accepted update never rewrites
 * unrelated requirements.
 *
 * Patches are never applied without an explicit `accept` (NFR4) — this module
 * only *generates* proposals and *applies* them when the gate calls for it.
 */

import type {
  ScopedUrsPatch,
  SpecImplication,
  SpecUrsPatch,
  UrsDocument,
  UrsProposal,
  UrsRequirementOp,
  UrsSection,
  SpecTimestamp,
} from './types.js';
import type { DriftComparison, ImplicationDrift } from './driftComparator.js';

export type { DriftComparison, ImplicationDrift } from './driftComparator.js';

export interface PatchValidationSuccess {
  readonly ok: true;
}
export interface PatchValidationFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type PatchValidationResult = PatchValidationSuccess | PatchValidationFailure;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateSectionShape(section: unknown, at: string, errors: string[]): void {
  if (!isRecord(section)) {
    errors.push(`${at} must be an object`);
    return;
  }
  if (typeof section.id !== 'string' || section.id.length === 0) {
    errors.push(`${at}.id must be a non-empty string`);
  }
  if (typeof section.title !== 'string') errors.push(`${at}.title must be a string`);
  if (typeof section.text !== 'string') errors.push(`${at}.text must be a string`);
  if (section.type !== 'functional' && section.type !== 'nfr') {
    errors.push(`${at}.type must be "functional" | "nfr"`);
  }
}

/**
 * Strict validation of a proposed patch — malformed patches are rejected
 * outright (never applied). Returns a discriminated result, no throwing.
 */
export function validatePatch(raw: unknown): PatchValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ['patch must be an object'] };
  }
  if (typeof raw.summary !== 'string') errors.push('patch.summary must be a string');
  const ops = raw.ops;
  if (!Array.isArray(ops)) {
    return { ok: false, errors: [...errors, 'patch.ops must be an array'] };
  }

  const seen = new Set<string>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const at = `ops[${i}]`;
    if (!isRecord(op)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (op.op !== 'add' && op.op !== 'modify' && op.op !== 'remove') {
      errors.push(`${at}.op must be "add" | "modify" | "remove"`);
    }
    if (typeof op.sectionId !== 'string' || op.sectionId.length === 0) {
      errors.push(`${at}.sectionId must be a non-empty string`);
    } else {
      if (seen.has(op.sectionId)) errors.push(`${at}.sectionId "${op.sectionId}" is duplicated`);
      seen.add(op.sectionId);
    }
    if (typeof op.markdown !== 'string') errors.push(`${at}.markdown must be a string`);

    if (op.op === 'add' || op.op === 'modify') {
      validateSectionShape(op.section, `${at}.section`, errors);
      if (isRecord(op.section) && typeof op.section.id === 'string' && op.section.id !== op.sectionId) {
        errors.push(`${at}.section.id must equal ${at}.sectionId`);
      }
    }
    if (op.op === 'remove' && op.section !== undefined) {
      errors.push(`${at}.section must be absent for a remove op`);
    }
    if (op.op === 'remove' && typeof op.markdown === 'string' && op.markdown.length > 0) {
      errors.push(`${at}.markdown must be empty for a remove op`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function withStamp(
  section: UrsSection,
  stamp?: { version: number; changeId: string },
): UrsSection {
  if (!stamp) return section;
  return { ...section, version: stamp.version, lastChangeId: stamp.changeId };
}

/**
 * Applies a scoped patch to a document. Untouched sections are preserved as-is
 * (identical values → byte-identical rendered markdown). Optionally stamps the
 * resulting version/lastChangeId onto the touched sections.
 */
export function applyPatch(
  doc: UrsDocument,
  patch: ScopedUrsPatch,
  stamp?: { version: number; changeId: string },
): UrsDocument {
  const byId = new Map<string, UrsRequirementOp>();
  for (const op of patch.ops) byId.set(op.sectionId, op);

  const sections: UrsSection[] = [];
  for (const s of doc.sections) {
    const op = byId.get(s.id);
    if (!op) {
      sections.push(s); // untouched — identical value
      continue;
    }
    if (op.op === 'remove') continue;
    const next = op.section ?? { ...s, text: op.markdown };
    sections.push(withStamp(next, stamp));
  }

  // brand-new sections (add ops that didn't replace an existing id) go at the end
  for (const op of patch.ops) {
    if (op.op === 'add' && !doc.sections.some((s) => s.id === op.sectionId) && op.section) {
      sections.push(withStamp(op.section, stamp));
    }
  }

  return { ...doc, sections };
}

// ── Proposal generation ───────────────────────────────────────────────

const ACTIONABLE: ReadonlySet<string> = new Set(['new', 'modified', 'conflicting']);

function deriveTitle(imp: SpecImplication): string {
  const words = imp.text.trim().replace(/\s+/g, ' ').split(' ');
  const title = words.slice(0, 8).join(' ').replace(/[.,;:]$/, '');
  return title.length > 0 ? title : 'Requirement';
}

function deriveNewSectionId(imp: SpecImplication, doc: UrsDocument): string {
  const base = `req-${imp.id}`.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!doc.sections.some((s) => s.id === base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!doc.sections.some((s) => s.id === candidate)) return candidate;
  }
}

function buildSectionFor(
  imp: SpecImplication,
  drift: ImplicationDrift,
  doc: UrsDocument,
  changeId: string,
): UrsSection {
  const existing =
    drift.matchedSectionId !== undefined
      ? doc.sections.find((s) => s.id === drift.matchedSectionId)
      : undefined;

  if (existing) {
    // modify / conflicting — update the existing requirement in place
    return {
      ...existing,
      text: imp.text,
      sourceRefs: Array.from(new Set([...existing.sourceRefs, ...imp.sourceRefs])),
      lastChangeId: changeId,
    };
  }
  // new — brand-new scoped requirement
  return {
    id: deriveNewSectionId(imp, doc),
    title: deriveTitle(imp),
    text: imp.text,
    type: imp.kind === 'nfr' ? 'nfr' : 'functional',
    version: 0,
    lastChangeId: changeId,
    sourceRefs: [...imp.sourceRefs],
  };
}

/**
 * Generates one scoped `UrsProposal` per actionable implication (new / modified
 * / conflicting). Aligned and inert implications produce no proposal. Each
 * proposal's patch touches only its own section (SO4).
 */
export function generateProposals(params: {
  implications: readonly SpecImplication[];
  drift: DriftComparison;
  doc: UrsDocument;
  changeId: string;
  timestamp: SpecTimestamp;
}): readonly UrsProposal[] {
  const { implications, drift, doc, changeId, timestamp } = params;
  const driftById = new Map(drift.perImplication.map((d) => [d.implicationId, d]));
  const proposals: UrsProposal[] = [];
  let n = 0;

  for (const imp of implications) {
    const d = driftById.get(imp.id);
    if (!d || !ACTIONABLE.has(d.status)) continue;

    n += 1;
    const section = buildSectionFor(imp, d, doc, changeId);
    const op: UrsRequirementOp = {
      op: d.status === 'new' ? 'add' : 'modify',
      sectionId: section.id,
      section,
      markdown: section.text,
    };
    const patch: ScopedUrsPatch = {
      summary: `${d.status === 'new' ? 'Add' : 'Update'} requirement "${section.title}"`,
      ops: [op],
    };

    proposals.push({
      id: `${changeId}-${n}`,
      changeId,
      createdAt: timestamp,
      title: deriveTitle(imp),
      status: 'pending',
      implicationIds: [imp.id],
      driftStatus: d.status,
      sectionsTouched: [section.id],
      patch,
      rationale: imp.rationale ?? `Requirement "${section.title}" ${d.status} by this change.`,
    });
  }

  return proposals;
}

/** Collapses proposals into the report's `ursPatch` (contract shape). */
export function proposalsToUrsPatch(proposals: readonly UrsProposal[]): SpecUrsPatch {
  const entries = proposals.flatMap((p) =>
    p.patch.ops.map((op) => ({
      op: op.op,
      sectionId: op.sectionId,
      markdown: op.markdown,
    })),
  );
  const summary =
    proposals.length === 0
      ? 'No URS updates proposed.'
      : `${proposals.length} scoped URS update proposal(s).`;
  return { summary, entries };
}
