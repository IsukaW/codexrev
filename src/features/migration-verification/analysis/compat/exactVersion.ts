/**
 * Feature 3 / Function 1 — exact-version boundary utilities (Phase P3).
 *
 * Deliberately MINIMAL: only exact numeric `X.Y.Z` versions (optional `v`
 * prefix) are comparable. Ranges (^, ~, >=), prerelease and build-metadata
 * versions return null — callers must treat that as INSUFFICIENT EVIDENCE,
 * never as a comparison. This is not a semver engine; full range semantics
 * are intentionally out of scope for P3 (see phase-03 report limitations).
 */

export type ExactVersion = readonly [number, number, number];

export function parseExactVersion(v: string): ExactVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareExact(a: ExactVersion, b: ExactVersion): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/** Does `target` fall inside [affectedFrom, affectedUntil) ? */
export function inAffectedRange(
  target: ExactVersion,
  affectedFrom: ExactVersion,
  affectedUntil: ExactVersion | null,
): boolean {
  if (compareExact(target, affectedFrom) < 0) return false;
  if (affectedUntil !== null && compareExact(target, affectedUntil) >= 0) return false;
  return true;
}
