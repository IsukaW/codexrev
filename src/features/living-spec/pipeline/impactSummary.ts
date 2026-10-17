/**
 * Change-impact summary (FR11) — one concise summary per analysis.
 *
 * PURE and deterministic: it merges the diff's exact file/line facts with the
 * implication `sourceRefs`, lists the URS requirement ids the change touches,
 * and derives a recommended next action from the drift classification. No
 * LLM, fs or CLI concerns here.
 */

import type {
  DiffFile,
  ExtractedDiff,
} from './diffExtractor.js';
import type { DriftComparison } from './driftComparator.js';
import type {
  SpecImpactFileRef,
  SpecImpactSummary,
  SpecImplication,
  SpecProposal,
} from './types.js';

/** One pointer back into the change: `path:line`, `path:a-b` or bare `path`. */
export interface SourceRefParts {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
}

/**
 * Parses a contract `sourceRefs` entry. Splits on the last `:` so the rule is
 * repo-relative-path safe; a ref without a line number yields just the path.
 */
export function parseSourceRef(ref: string): SourceRefParts {
  const trimmed = ref.trim();
  const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (!m || m[1].length === 0) return { path: trimmed };
  return {
    path: m[1],
    line: Number(m[2]),
    ...(m[3] !== undefined ? { endLine: Number(m[3]) } : {}),
  };
}

const MAX_REF_LINES = 200;

/** Line numbers a `sourceRefs` entry points at (ranges expand, capped). */
export function sourceRefLines(ref: string): readonly number[] {
  const { line, endLine } = parseSourceRef(ref);
  if (line === undefined) return [];
  const end = endLine !== undefined && endLine >= line ? endLine : line;
  const out: number[] = [];
  for (let n = line; n <= end && out.length < MAX_REF_LINES; n++) out.push(n);
  return out;
}

/**
 * Exact changed line numbers for one diff file: new-file numbering for added /
 * context lines, old-file numbering for removed ones. Context lines are not
 * changes and are skipped.
 */
export function changedLineNumbers(file: DiffFile): readonly number[] {
  const out = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const n =
        line.type === 'add'
          ? line.newLineNumber
          : line.type === 'del'
            ? line.oldLineNumber
            : undefined;
      if (n !== undefined) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const ACTIONABLE = new Set(['new', 'modified', 'conflicting']);

/** Deterministic id for a brand-new requirement (mirrors the patcher's form). */
function proposedRequirementId(implicationId: string): string {
  return `req-${implicationId}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * The URS requirement id an implication is linked to: the matched section, the
 * proposal's scoped section, or the derived id for a brand-new requirement.
 */
export function linkedRequirementIdFor(
  imp: SpecImplication,
  drift: DriftComparison,
  proposals: readonly SpecProposal[] = [],
): string {
  const d = drift.perImplication.find((x) => x.implicationId === imp.id);
  if (d?.matchedSectionId !== undefined) return d.matchedSectionId;
  const proposal = proposals.find((p) => p.implicationIds.includes(imp.id));
  const fromProposal = proposal?.sectionsTouched?.[0];
  return fromProposal ?? proposedRequirementId(imp.id);
}

function nextActionFor(overall: DriftComparison['overall'], proposals: number): string {
  switch (overall) {
    case 'conflicting':
      return proposals > 0
        ? 'Resolve the conflicting requirement(s) before merging — reconcile or decide the pending proposals.'
        : 'Resolve the conflicting requirement(s) before merging.';
    case 'modified':
      return proposals > 0
        ? 'Review the pending URS proposals for the modified requirement(s) and accept/reject/defer.'
        : 'Review the modified requirement(s) against the living URS.';
    case 'new':
      return proposals > 0
        ? 'Review the new requirement proposal(s) and accept/reject/defer.'
        : 'Record the new requirement(s) in the living URS.';
    case 'aligned':
      return 'No URS action required — keep existing tests green.';
    default:
      return 'No action required.';
  }
}

export interface ImpactSummaryParams {
  readonly implications: readonly SpecImplication[];
  readonly drift: DriftComparison;
  readonly extraction: ExtractedDiff;
  /** Proposals generated for this change (adds their section ids). */
  readonly proposals?: readonly SpecProposal[];
}

/**
 * Builds the change-impact summary: affected requirement ids, affected
 * files/lines (merged from the diff hunks and implication sourceRefs), a
 * recommended next action and a confidence in [0, 1].
 */
export function buildImpactSummary(params: ImpactSummaryParams): SpecImpactSummary {
  const { implications, drift, extraction } = params;
  const proposals = params.proposals ?? [];

  // Affected requirement ids — one per actionable implication, document order.
  const requirementIds: string[] = [];
  for (const imp of implications) {
    const d = drift.perImplication.find((x) => x.implicationId === imp.id);
    if (!d || !ACTIONABLE.has(d.status)) continue;
    const id = linkedRequirementIdFor(imp, drift, proposals);
    if (!requirementIds.includes(id)) requirementIds.push(id);
  }

  // Affected files/lines — exact diff facts first, then implication pointers.
  const linesByPath = new Map<string, Set<number>>();
  for (const file of extraction.files) {
    const set = linesByPath.get(file.path) ?? new Set<number>();
    for (const n of changedLineNumbers(file)) set.add(n);
    linesByPath.set(file.path, set);
  }
  for (const imp of implications) {
    for (const ref of imp.sourceRefs) {
      const { path } = parseSourceRef(ref);
      const set = linesByPath.get(path) ?? new Set<number>();
      for (const n of sourceRefLines(ref)) set.add(n);
      linesByPath.set(path, set);
    }
  }
  const affectedFiles: SpecImpactFileRef[] = [...linesByPath.entries()]
    .map(([path, lines]) => ({ path, lines: [...lines].sort((a, b) => a - b) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const confidence =
    implications.length === 0
      ? 1
      : implications.reduce((sum, imp) => sum + imp.confidence, 0) / implications.length;

  return {
    affectedRequirementIds: requirementIds,
    affectedFiles,
    recommendedNextAction: nextActionFor(drift.overall, proposals.length),
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}
