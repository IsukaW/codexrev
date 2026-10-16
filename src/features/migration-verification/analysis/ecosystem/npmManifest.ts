/**
 * Feature 3 / Function 1 — npm manifest and lockfile parsing (Phase P2).
 *
 * Pure, side-effect-free parsers (no filesystem access — easy to unit test):
 *   - package.json → declared dependencies in all four scopes
 *   - package-lock.json v1 (dependencies tree) and v2/v3 (packages map)
 *     → resolved versions, including transitive entries
 *
 * "Never invent": malformed input yields a structured ANALYZER_FAILED issue
 * and null/partial data — versions are never guessed or repaired.
 */

import type { AnalysisIssue } from '../types.js';
import { analysisIssue } from '../issues.js';

export type DependencyScope = 'runtime' | 'dev' | 'optional' | 'peer';
export type LockedScope = DependencyScope | 'unknown';

export interface ManifestDependency {
  name: string;
  declaredRange: string;
  scope: DependencyScope;
}

export interface NpmManifest {
  name: string | null;
  version: string | null;
  /** Sorted: name asc, then scope asc. Deterministic. */
  dependencies: ManifestDependency[];
}

export interface LockedPackage {
  name: string;
  /** null when the lockfile entry carries no version — never invented. */
  resolvedVersion: string | null;
  scope: LockedScope;
  /** Location inside the lockfile, used as the evidence ref. */
  key: string;
  /** True when hoisted at the top level (`node_modules/<name>` / v1 root). */
  topLevel: boolean;
}

const SCOPE_FIELDS: readonly { field: string; scope: DependencyScope }[] = [
  { field: 'dependencies', scope: 'runtime' },
  { field: 'devDependencies', scope: 'dev' },
  { field: 'optionalDependencies', scope: 'optional' },
  { field: 'peerDependencies', scope: 'peer' },
];

export function scopeField(scope: DependencyScope): string {
  return SCOPE_FIELDS.find((f) => f.scope === scope)?.field ?? 'dependencies';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse `package.json` text. Returns null on malformed input (with issues). */
export function parseNpmManifest(text: string, issues: AnalysisIssue[]): NpmManifest | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    issues.push(
      analysisIssue(
        'ANALYZER_FAILED',
        'error',
        `package.json is not valid JSON: ${(err as Error).message}`,
        'package.json',
      ),
    );
    return null;
  }
  if (!isPlainObject(json)) {
    issues.push(
      analysisIssue('ANALYZER_FAILED', 'error', 'package.json must contain a JSON object', 'package.json'),
    );
    return null;
  }

  const name = typeof json.name === 'string' ? json.name : null;
  const version = typeof json.version === 'string' ? json.version : null;
  const deps: ManifestDependency[] = [];

  for (const { field, scope } of SCOPE_FIELDS) {
    const block = json[field];
    if (block === undefined) continue;
    if (!isPlainObject(block)) {
      issues.push(
        analysisIssue(
          'ANALYZER_FAILED',
          'warning',
          `${field} must be an object of name→range entries; ignored`,
          field,
        ),
      );
      continue;
    }
    for (const [depName, range] of Object.entries(block)) {
      if (typeof range !== 'string' || range.trim() === '') {
        issues.push(
          analysisIssue(
            'ANALYZER_FAILED',
            'warning',
            `dependency '${depName}' in ${field} has an invalid version range; ignored`,
            depName,
          ),
        );
        continue;
      }
      deps.push({ name: depName, declaredRange: range.trim(), scope });
    }
  }

  deps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  return { name, version, dependencies: deps };
}

function flagsScope(node: Record<string, unknown>): LockedScope {
  if (node.dev === true) return 'dev';
  if (node.optional === true) return 'optional';
  if (node.peer === true) return 'peer';
  return 'unknown';
}

/** v2/v3 `packages` map: "node_modules/foo", "node_modules/a/node_modules/b". */
function parsePackagesMap(packages: Record<string, unknown>, out: LockedPackage[]): void {
  const marker = 'node_modules/';
  for (const [key, node] of Object.entries(packages)) {
    if (key === '' || !key.includes(marker) || !isPlainObject(node)) continue;
    const name = key.slice(key.lastIndexOf(marker) + marker.length);
    if (name === '') continue;
    out.push({
      name,
      resolvedVersion: typeof node.version === 'string' ? node.version : null,
      scope: flagsScope(node),
      key: `packages.${key}`,
      topLevel: key === `${marker}${name}`,
    });
  }
}

/** v1 `dependencies` tree, recursively (nested copies = distinct versions). */
function parseDependenciesTree(
  tree: Record<string, unknown>,
  pathPrefix: string,
  out: LockedPackage[],
): void {
  for (const [name, node] of Object.entries(tree)) {
    if (!isPlainObject(node)) continue;
    const key = pathPrefix === '' ? `dependencies.${name}` : `${pathPrefix}.dependencies.${name}`;
    out.push({
      name,
      resolvedVersion: typeof node.version === 'string' ? node.version : null,
      scope: flagsScope(node),
      key,
      topLevel: pathPrefix === '',
    });
    const nested = node.dependencies;
    if (isPlainObject(nested)) {
      parseDependenciesTree(nested, key, out);
    }
  }
}

/**
 * Parse `package-lock.json` text. Supported formats:
 *   - v2/v3: top-level `packages` map
 *   - v1: `dependencies` tree
 * Returns null for unrecognized/malformed formats (with issues).
 */
export function parseNpmLockfile(text: string, issues: AnalysisIssue[]): LockedPackage[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    issues.push(
      analysisIssue(
        'ANALYZER_FAILED',
        'warning',
        `package-lock.json is not valid JSON: ${(err as Error).message}; resolved versions unavailable`,
        'package-lock.json',
      ),
    );
    return null;
  }
  if (!isPlainObject(json)) {
    issues.push(
      analysisIssue(
        'ANALYZER_FAILED',
        'warning',
        'package-lock.json must contain a JSON object; resolved versions unavailable',
        'package-lock.json',
      ),
    );
    return null;
  }

  const out: LockedPackage[] = [];
  if (isPlainObject(json.packages)) {
    parsePackagesMap(json.packages, out);
    return out;
  }
  if (isPlainObject(json.dependencies)) {
    parseDependenciesTree(json.dependencies, '', out);
    return out;
  }
  issues.push(
    analysisIssue(
      'ANALYZER_FAILED',
      'warning',
      'unrecognized package-lock.json format (expected a v2/v3 "packages" map or a v1 "dependencies" tree); transitive analysis unavailable',
      'package-lock.json',
    ),
  );
  return null;
}
