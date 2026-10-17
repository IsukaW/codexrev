/**
 * Living Specification Engine — stable integration contract.
 *
 * The types in this file are the FEATURE 1 public contract: analysis
 * results are persisted as JSON and may be consumed by other features
 * (review pipeline, checkpointing, CI hooks) later. Keep them:
 *   - JSON-serializable (no Dates, Maps, Sets or class instances),
 *   - additive-only (new OPTIONAL fields are fine; never rename or
 *     repurpose an existing field without a deliberate contract bump).
 *
 * No CLI, fs or provider concerns belong here — pure domain shapes only.
 */

/** ISO-8601 UTC timestamp, e.g. `2026-10-17T09:20:16.797Z`. */
export type SpecTimestamp = string;

/** A file touched by the analysed change. */
export interface SpecChangeFile {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
  /** Number of added + removed lines attributed to this file. */
  readonly lines: number;
}

export type SpecImplicationKind = 'functional' | 'nfr';

/** Broad category a requirement implication falls under (optional label). */
export type SpecImplicationCategory =
  | 'security'
  | 'performance'
  | 'api'
  | 'validation'
  | 'behaviour'
  | 'other';

/** A requirement-level implication derived from the change. */
export interface SpecImplication {
  readonly id: string;
  readonly kind: SpecImplicationKind;
  /** Requirement statement in plain language. */
  readonly text: string;
  /** Confidence in [0, 1]. */
  readonly confidence: number;
  /** Pointers back into the change (file:line refs, hunk ids, commit ids). */
  readonly sourceRefs: readonly string[];
  /** Why the change implies this requirement (set by model-backed inference). */
  readonly rationale?: string;
  /** Optional category label (set by model-backed inference). */
  readonly category?: SpecImplicationCategory;
}

/** How the change relates to the current living URS. */
export type SpecDriftStatus =
  | 'aligned'
  | 'modified'
  | 'new'
  | 'conflicting'
  | 'no-semantic-change';

export type SpecUrsPatchOp = 'add' | 'modify' | 'remove';

export interface SpecUrsPatchEntry {
  readonly op: SpecUrsPatchOp;
  /** Stable id of the URS section this entry applies to. */
  readonly sectionId: string;
  /** Markdown body for the section after this entry (empty for `remove`). */
  readonly markdown: string;
}

/** The minimal edit set that turns the current living URS into the new one. */
export interface SpecUrsPatch {
  readonly summary: string;
  readonly entries: readonly SpecUrsPatchEntry[];
}

/** A test case added/updated alongside the requirement change. */
export interface SpecTestCaseDelta {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly string[];
  /** Id of the `SpecImplication` this test case verifies. */
  readonly linkedImplicationId: string;
}

export interface SpecAnalysisQuality {
  /** Model that produced the analysis (`'heuristic'` for rule-only runs). */
  readonly model: string;
  readonly latencyMs: number;
  /** True when the result validated against the contract schema. */
  readonly schemaValid: boolean;
  /** Token usage reported by the model, when the provider supplies it. */
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
}

/**
 * THE stable contract — one of these is persisted per analysed change.
 * Other features may consume this JSON later; extend it additively only.
 */
export interface SpecAnalysisResult {
  /** Id of the analysed change (commit sha, `staged`, `worktree`, ...). */
  readonly changeId: string;
  readonly timestamp: SpecTimestamp;
  readonly files: readonly SpecChangeFile[];
  readonly implications: readonly SpecImplication[];
  readonly driftStatus: SpecDriftStatus;
  readonly ursPatch: SpecUrsPatch;
  readonly testDeltas: readonly SpecTestCaseDelta[];
  readonly quality: SpecAnalysisQuality;
  /** One/two-sentence summary of the observable behaviour change (model runs). */
  readonly behaviourChangeSummary?: string;
  /** True when the change means the living URS must be updated (model runs). */
  readonly requiresUrsUpdate?: boolean;
  /** Structured inference failure, when the semantic half could not run. */
  readonly inferenceError?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type SpecProposalStatus = 'pending' | 'accepted' | 'rejected' | 'deferred';

/** A pending URS update the user must accept / reject / defer. */
export interface SpecProposal {
  readonly id: string;
  /** Change that produced the proposal. */
  readonly changeId: string;
  readonly createdAt: SpecTimestamp;
  readonly title: string;
  readonly status: SpecProposalStatus;
  /** Ids of the `SpecImplication` entries this proposal realises. */
  readonly implicationIds: readonly string[];
}

/** A drift alert recorded against the living URS. */
export interface SpecDriftAlert {
  readonly id: string;
  readonly changeId: string;
  readonly status: SpecDriftStatus;
  readonly at: SpecTimestamp;
  readonly message?: string;
}

/** JSON state living next to the URS markdown in `urs/state.json`. */
export interface SpecUrsState {
  readonly schemaVersion: 1;
  /** Monotonic URS version counter — 0 means nothing accepted yet. */
  readonly version: number;
  readonly updatedAt: SpecTimestamp;
  /** Most recent drift alerts, newest last. */
  readonly lastDriftAlerts: readonly SpecDriftAlert[];
}

/** A versioned URS snapshot recorded under `versions/`. */
export interface SpecUrsVersion {
  readonly version: number;
  /** Triggering change id (commit sha, `staged`, ...). */
  readonly changeId: string;
  readonly createdAt: SpecTimestamp;
}
