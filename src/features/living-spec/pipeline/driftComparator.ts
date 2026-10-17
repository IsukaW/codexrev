/**
 * Drift comparator — classifies each implication against the current living
 * URS (FR7/SO3). PURE and deterministic: matching runs on requirement ids and
 * source refs first, then falls back to a text-similarity heuristic which is
 * injectable (swappable) so the classifier can be tuned without touching the
 * matching logic.
 *
 * Each implication is classified as one of the `SpecDriftStatus` values:
 *   - 'no-semantic-change' — inert implication (no behavioural requirement)
 *   - 'new'                — no matching URS requirement
 *   - 'aligned'            — matches an existing requirement almost verbatim
 *   - 'modified'           — matches an existing requirement but changed
 *   - 'conflicting'        — contradicts an existing requirement
 */

import type {
  SpecDriftStatus,
  SpecImplication,
  UrsDocument,
  UrsSection,
} from './types.js';

/** A swappable text-similarity heuristic returning a score in [0, 1]. */
export type SimilarityFn = (a: string, b: string) => number;

export interface DriftOptions {
  /** Similarity heuristic (default: token-overlap / Jaccard). */
  readonly similarity?: SimilarityFn;
  /** Minimum similarity for a text-only match (default 0.2). */
  readonly matchThreshold?: number;
  /** Minimum similarity to call a match "aligned" (default 0.9). */
  readonly alignedThreshold?: number;
}

export interface ImplicationDrift {
  readonly implicationId: string;
  readonly status: SpecDriftStatus;
  /** URS section this implication matched, when any. */
  readonly matchedSectionId?: string;
  /** Similarity to the matched section (0 when unmatched / inert). */
  readonly similarity: number;
}

export interface DriftComparison {
  /** Most significant per-implication status for the whole change. */
  readonly overall: SpecDriftStatus;
  readonly perImplication: readonly ImplicationDrift[];
}

/** Default similarity: Jaccard overlap over normalized word tokens. */
export function tokenOverlapSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 1 : inter / union;
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 1) out.add(raw);
  }
  return out;
}

const NEGATION_RE =
  /\b(no longer|not|never|must not|shall not|cannot|can't|won't|doesn't|removed|disable[sd]?|forbid[sd]?|denies|rejects|unrestricted|no requirement)\b/i;

function hasNegation(text: string): boolean {
  return NEGATION_RE.test(text);
}

/** Deterministic contradiction signal: a negation flip on a shared topic. */
function isContradiction(a: string, b: string): boolean {
  if (hasNegation(a) === hasNegation(b)) return false;
  // require some shared topic so an unrelated negation isn't a "conflict"
  return tokenOverlapSimilarity(a, b) > 0;
}

function isInert(imp: SpecImplication): boolean {
  return imp.text.trim().length === 0 || imp.confidence === 0;
}

interface SectionMatch {
  readonly section: UrsSection;
  readonly similarity: number;
}

/** id match → ref match → similarity match, in that deterministic order. */
function matchSection(
  imp: SpecImplication,
  doc: UrsDocument,
  similarity: SimilarityFn,
  matchThreshold: number,
): SectionMatch | null {
  // 1. exact requirement-id match
  const byId = doc.sections.find((s) => s.id === imp.id);
  if (byId) return { section: byId, similarity: similarity(imp.text, byId.text) };

  // 2. source-ref overlap (deterministic pointer into the same code)
  const impRefs = new Set(imp.sourceRefs);
  const refMatches = doc.sections.filter((s) => s.sourceRefs.some((r) => impRefs.has(r)));
  if (refMatches.length > 0) {
    let best = refMatches[0];
    let bestSim = similarity(imp.text, best.text);
    for (const s of refMatches.slice(1)) {
      const sim = similarity(imp.text, s.text);
      if (sim > bestSim) {
        best = s;
        bestSim = sim;
      }
    }
    return { section: best, similarity: bestSim };
  }

  // 3. text similarity fallback (swappable heuristic)
  let best: UrsSection | null = null;
  let bestSim = 0;
  for (const s of doc.sections) {
    const sim = similarity(imp.text, s.text);
    if (sim >= matchThreshold && sim > bestSim) {
      best = s;
      bestSim = sim;
    }
  }
  return best ? { section: best, similarity: bestSim } : null;
}

/** Classifies a single implication against the current URS state. */
export function classifyImplication(
  imp: SpecImplication,
  doc: UrsDocument,
  options: DriftOptions = {},
): ImplicationDrift {
  const similarity = options.similarity ?? tokenOverlapSimilarity;
  const matchThreshold = options.matchThreshold ?? 0.2;
  const alignedThreshold = options.alignedThreshold ?? 0.9;

  if (isInert(imp)) {
    return {
      implicationId: imp.id,
      status: 'no-semantic-change',
      similarity: 0,
    };
  }

  const match = matchSection(imp, doc, similarity, matchThreshold);
  if (!match) {
    return { implicationId: imp.id, status: 'new', similarity: 0 };
  }

  const { section, similarity: sim } = match;
  let status: SpecDriftStatus;
  if (isContradiction(imp.text, section.text)) {
    status = 'conflicting';
  } else if (sim >= alignedThreshold) {
    status = 'aligned';
  } else {
    status = 'modified';
  }

  return {
    implicationId: imp.id,
    status,
    matchedSectionId: section.id,
    similarity: sim,
  };
}

// Most significant first — a change "relates to the URS" by its worst signal.
const OVERALL_PRIORITY: readonly SpecDriftStatus[] = [
  'conflicting',
  'new',
  'modified',
  'aligned',
  'no-semantic-change',
];

/** Classifies every implication and derives the overall drift for the change. */
export function compareDrift(
  implications: readonly SpecImplication[],
  doc: UrsDocument,
  options: DriftOptions = {},
): DriftComparison {
  const perImplication = implications.map((imp) => classifyImplication(imp, doc, options));
  if (perImplication.length === 0) {
    return { overall: 'no-semantic-change', perImplication };
  }
  const present = new Set(perImplication.map((d) => d.status));
  const overall = OVERALL_PRIORITY.find((s) => present.has(s)) ?? 'no-semantic-change';
  return { overall, perImplication };
}
