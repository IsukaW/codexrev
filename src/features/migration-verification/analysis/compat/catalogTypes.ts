/**
 * Feature 3 / Function 1 — compatibility catalog models and validation (Phase P3).
 *
 * A catalog entry is a *traceable claim* about a package version boundary,
 * backed by an official source. Validation rejects anything malformed or
 * evidentially insufficient (e.g. a 'verified' status without an https URI)
 * so lookups can never surface an unverifiable claim as confirmed.
 */

import { parseExactVersion } from './exactVersion.js';

export type CompatCategory =
  | 'deprecated-api'
  | 'breaking-change'
  | 'removed-api'
  | 'version-constraint'
  | 'dependency-conflict';

export type CompatSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type CompatConfidence = 'high' | 'medium' | 'low';
export type CompatReviewStatus = 'verified' | 'unverified';

export interface CompatSourceRef {
  kind: 'official-docs' | 'release-notes' | 'deprecation-notice' | 'changelog';
  uri: string;
}

export interface CompatCatalogEntry {
  /** Stable identifier, e.g. 'react-dom-19-removed-render'. */
  id: string;
  package: string;
  category: CompatCategory;
  /** Affected API symbol(s), when applicable. */
  api?: string;
  severity: CompatSeverity;
  /** Inclusive lower boundary (exact 'X.Y.Z'). */
  affectedFrom: string;
  /** Exclusive upper boundary (exact 'X.Y.Z'); absent = open-ended. */
  affectedUntil?: string;
  description: string;
  migrationGuidance?: string;
  source: CompatSourceRef;
  confidence: CompatConfidence;
  /** Only 'verified' entries (with an https source) can yield confirmed findings. */
  reviewStatus: CompatReviewStatus;
}

export type CatalogValidationResult =
  | { ok: true; entry: CompatCatalogEntry }
  | { ok: false; reason: string };

const CATEGORIES: readonly string[] = [
  'deprecated-api',
  'breaking-change',
  'removed-api',
  'version-constraint',
  'dependency-conflict',
];
const SEVERITIES: readonly string[] = ['info', 'low', 'medium', 'high', 'critical'];
const SOURCE_KINDS: readonly string[] = ['official-docs', 'release-notes', 'deprecation-notice', 'changelog'];
const CONFIDENCES: readonly string[] = ['high', 'medium', 'low'];
const REVIEW_STATUSES: readonly string[] = ['verified', 'unverified'];

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function oneOf(v: unknown, allowed: readonly string[]): boolean {
  return typeof v === 'string' && allowed.includes(v);
}

export function validateCatalogEntry(x: unknown): CatalogValidationResult {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    return { ok: false, reason: 'entry must be an object' };
  }
  const r = x as Record<string, unknown>;
  if (!nonEmptyString(r.id)) return { ok: false, reason: 'id must be a non-empty string' };
  if (!nonEmptyString(r.package)) return { ok: false, reason: `${r.id}: package must be a non-empty string` };
  if (!oneOf(r.category, CATEGORIES)) return { ok: false, reason: `${r.id}: invalid category` };
  if (!oneOf(r.severity, SEVERITIES)) return { ok: false, reason: `${r.id}: invalid severity` };
  if (!nonEmptyString(r.description)) return { ok: false, reason: `${r.id}: description must be a non-empty string` };
  if (parseExactVersion(String(r.affectedFrom ?? '')) === null) {
    return { ok: false, reason: `${r.id}: affectedFrom must be an exact version (X.Y.Z)` };
  }
  if (r.affectedUntil !== undefined && parseExactVersion(String(r.affectedUntil)) === null) {
    return { ok: false, reason: `${r.id}: affectedUntil must be an exact version (X.Y.Z)` };
  }
  if (typeof r.source !== 'object' || r.source === null) {
    return { ok: false, reason: `${r.id}: source must be an object` };
  }
  const src = r.source as Record<string, unknown>;
  if (!oneOf(src.kind, SOURCE_KINDS)) return { ok: false, reason: `${r.id}: invalid source.kind` };
  if (!nonEmptyString(src.uri)) return { ok: false, reason: `${r.id}: source.uri must be a non-empty string` };
  if (!oneOf(r.confidence, CONFIDENCES)) return { ok: false, reason: `${r.id}: invalid confidence` };
  if (!oneOf(r.reviewStatus, REVIEW_STATUSES)) return { ok: false, reason: `${r.id}: invalid reviewStatus` };
  // Evidential sufficiency: a 'verified' claim must cite an https source.
  if (r.reviewStatus === 'verified' && !(src.uri as string).startsWith('https://')) {
    return { ok: false, reason: `${r.id}: reviewStatus 'verified' requires an https:// source uri` };
  }
  return { ok: true, entry: r as unknown as CompatCatalogEntry };
}
