/**
 * Shared types and helpers for the evidence collectors.
 *
 * Every collector is READ-ONLY: it observes git state and reads files the user
 * pointed it at. It never runs tests, builds, package managers, migrations,
 * rollbacks or arbitrary commands, and it never turns missing information into
 * a PASS. When something cannot be established the record says UNKNOWN and
 * explains why in `limitations`.
 */

import type { EvidenceItem, EvidenceSource, EvidenceStatus } from '../model/types.js';
import { EVIDENCE_SOURCES } from '../model/types.js';
import { DEFAULT_CREDIT_CONFIG } from '../calculus/scoring.js';

export type EvidenceType =
  | 'git_state'
  | 'dependency_change'
  | 'dependency_compatibility'
  | 'build_test'
  | 'security_findings'
  | 'authority'
  | 'recovery';

/**
 * fact      - describes what changed (git state, dependency changes). Input to
 *             Blast Radius. It is NOT proof that anything is safe.
 * assertion - claims a safety property (tests pass, recovery verified, ...).
 */
export type EvidenceRole = 'fact' | 'assertion';

/**
 * Where a record came from:
 *   observed_git    - read directly from the local git repository by this tool
 *   imported_report - parsed from a structured report file (test, build, security)
 *   user_supplied   - a claim typed into the --input file (not independently checkable)
 *   not_collected   - nothing was supplied; the record exists only to say UNKNOWN
 */
export type EvidenceOrigin = 'observed_git' | 'imported_report' | 'user_supplied' | 'not_collected';

export interface EvidenceRecord {
  /** deterministic: `<type>-<n>`, numbered in collection order */
  readonly id: string;
  readonly type: EvidenceType;
  readonly role: EvidenceRole;
  readonly origin: EvidenceOrigin;
  /** effective source after capping (see capSource); decides how much the assessors trust it */
  readonly source: EvidenceSource;
  /** true if the source counts as verification in scoring (not self-declared) */
  readonly trusted: boolean;
  readonly status: EvidenceStatus;
  readonly observedAt?: string;
  /** set by the orchestrator once "now" is known; true = older than allowed (or undated) */
  readonly stale?: boolean;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly refs: readonly string[];
  /** collection errors and caveats for this record */
  readonly limitations: readonly string[];
}

/** Hard caps so a huge repository or report cannot exhaust memory or flood output. */
export const COLLECTION_LIMITS = {
  maxReportBytes: 5_000_000,
  maxManifestBytes: 1_000_000,
  maxChangedFiles: 5000,
  maxFileChecks: 500,
  maxFindingsKept: 500,
  maxTextChars: 300,
} as const;

export function isTrustedSource(source: EvidenceSource): boolean {
  return DEFAULT_CREDIT_CONFIG.reliability[source] >= DEFAULT_CREDIT_CONFIG.minTrustedReliability;
}

/**
 * Claims typed into an input file cannot be checked by this tool, so their
 * declared source is capped: nobody can promote their own claim to
 * "verified_system" by writing it in the file. Returns the effective source and
 * whether capping changed anything. (EVIDENCE_SOURCES is ordered most to least trusted.)
 */
export function capSource(declared: EvidenceSource | undefined, cap: EvidenceSource): { source: EvidenceSource; capped: boolean } {
  const wanted = declared ?? 'self_declared';
  const wantedRank = EVIDENCE_SOURCES.indexOf(wanted);
  const capRank = EVIDENCE_SOURCES.indexOf(cap);
  const source = EVIDENCE_SOURCES[Math.max(wantedRank, capRank)];
  return { source, capped: source !== wanted };
}

/** What the CLI can honestly vouch for in a user-supplied claim: at best a human attesting. */
export const USER_CLAIM_SOURCE_CAP: EvidenceSource = 'human_attested';

export interface NormalizedClaim {
  readonly item: EvidenceItem;
  readonly trusted: boolean;
  readonly limitations: readonly string[];
}

/** Normalizes a user-supplied EvidenceItem: caps its source and notes what changed. */
export function normalizeUserClaim(label: string, item: EvidenceItem): NormalizedClaim {
  const { source, capped } = capSource(item.source, USER_CLAIM_SOURCE_CAP);
  const limitations: string[] = [];
  if (item.source === undefined) limitations.push(`${label}: no source stated, treated as self-declared`);
  if (capped && item.source !== undefined) {
    limitations.push(`${label}: declared source "${item.source}" cannot be verified from an input file, capped to "${source}"`);
  }
  return { item: { ...item, source }, trusted: isTrustedSource(source), limitations };
}

export function clip(text: string, max: number = COLLECTION_LIMITS.maxTextChars): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function newestTimestamp(...values: ReadonlyArray<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v === undefined) continue;
    const ms = Date.parse(v);
    if (!Number.isNaN(ms) && ms > bestMs) {
      best = v;
      bestMs = ms;
    }
  }
  return best;
}

export function uniq(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

/**
 * Freshness rule shared with the assessors (creditFor in calculus/scoring.ts):
 * evidence is stale when it is older than the limit, and also when its age
 * cannot be shown (no timestamp, invalid timestamp, or a timestamp in the future).
 */
export function isStale(observedAt: string | undefined, nowMs: number, maxAgeMs: number): boolean {
  if (observedAt === undefined) return true;
  const observed = Date.parse(observedAt);
  if (Number.isNaN(observed)) return true;
  const age = nowMs - observed;
  return age < 0 || age > maxAgeMs;
}
