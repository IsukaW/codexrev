/**
 * Feature 3 / Function 1 — npm dependency analysis (Phase P2).
 *
 * Produces `ProjectInfo` + `DependencyInfo[]` for an npm project:
 *   - direct dependencies from package.json (all four scopes)
 *   - transitive dependencies from package-lock.json (v1 and v2/v3)
 *   - declared ranges kept separate from resolved versions
 *   - missing resolved-version data is `null` + explicit issue — never invented
 *
 * Deterministic: same inputs produce the same output ordering
 * (direct before transitive, then name, resolved version, scope).
 * Read-only: all project access goes through `ReadOnlyFs`.
 */

import type { AnalysisIssue, DependencyInfo, ProjectInfo } from './types.js';
import { analysisIssue } from './issues.js';
import { ReadOnlyFs } from './readOnlyFs.js';
import {
  NPM_LOCKFILE_FILE,
  NPM_MANIFEST_FILE,
  detectEcosystem,
} from './ecosystem/detect.js';
import {
  parseNpmLockfile,
  parseNpmManifest,
  scopeField,
  type DependencyScope,
  type LockedPackage,
} from './ecosystem/npmManifest.js';

export interface DependencyAnalysisOptions {
  projectRoot: string;
  /** The dependency the migration targets (from AnalyzeRequest) — optional.
   *  If it cannot be found, a DEPENDENCY_UNRESOLVED issue is reported. */
  targetDependency?: string;
  /** Target version for `targetDependency`, recorded (not compared). */
  targetVersion?: string;
}

export interface DependencyAnalysis {
  /** null when the project cannot be identified as npm (see issues). */
  project: ProjectInfo | null;
  /** Deterministic order: direct before transitive, then name/version/scope. */
  dependencies: DependencyInfo[];
  issues: AnalysisIssue[];
}

const RELATION_RANK: Record<'direct' | 'transitive', number> = { direct: 0, transitive: 1 };

function compareDependencies(a: DependencyInfo, b: DependencyInfo): number {
  const rel = RELATION_RANK[a.relation] - RELATION_RANK[b.relation];
  if (rel !== 0) return rel;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  const av = a.resolvedVersion ?? '';
  const bv = b.resolvedVersion ?? '';
  if (av !== bv) return av < bv ? -1 : 1;
  return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0;
}

export async function analyzeDependencies(
  opts: DependencyAnalysisOptions,
): Promise<DependencyAnalysis> {
  const ro = new ReadOnlyFs(opts.projectRoot);
  const issues: AnalysisIssue[] = [];

  const detection = await detectEcosystem(ro);
  issues.push(...detection.issues);
  if (detection.ecosystem !== 'npm' || detection.manifestPath === null) {
    return { project: null, dependencies: [], issues };
  }

  const manifest = parseNpmManifest(await ro.readFile(NPM_MANIFEST_FILE), issues);
  if (manifest === null) {
    return { project: null, dependencies: [], issues };
  }

  let locked: LockedPackage[] | null = null;
  if (detection.lockfilePath !== null) {
    locked = parseNpmLockfile(await ro.readFile(NPM_LOCKFILE_FILE), issues);
  }

  // Top-level lockfile entries give resolved versions for direct dependencies.
  const topLevelByName = new Map<string, LockedPackage>();
  for (const pkg of locked ?? []) {
    if (pkg.topLevel && !topLevelByName.has(pkg.name)) {
      topLevelByName.set(pkg.name, pkg);
    }
  }

  const dependencies: DependencyInfo[] = [];
  const directNames = new Set<string>();

  for (const dep of manifest.dependencies) {
    directNames.add(dep.name);
    const lockedPkg = topLevelByName.get(dep.name);
    dependencies.push({
      name: dep.name,
      relation: 'direct',
      declaredRange: dep.declaredRange,
      // null = resolved version unavailable (no lockfile data) — never invented
      resolvedVersion: lockedPkg?.resolvedVersion ?? null,
      scope: dep.scope,
      targetVersion: dep.name === opts.targetDependency ? opts.targetVersion ?? null : null,
      conflicts: [],
      evidence: {
        status: 'present',
        source: {
          kind: 'manifest',
          ref: `package.json#${scopeField(dep.scope)}.${dep.name}`,
        },
        quality: 'exact',
      },
    });
  }

  // Transitive: lockfile entries whose name is not a direct dependency
  // (npm hoists transitives to the top level too, so position is not the
  // criterion — the manifest is). Nested duplicates (same name at a
  // different version) are kept as separate entries — npm legitimately
  // resolves multiple versions of one name.
  const seenTransitive = new Set<string>();
  for (const pkg of locked ?? []) {
    if (directNames.has(pkg.name)) continue;
    const identity = `${pkg.name}@${pkg.resolvedVersion ?? ''}`;
    if (seenTransitive.has(identity)) continue;
    seenTransitive.add(identity);
    dependencies.push({
      name: pkg.name,
      relation: 'transitive',
      declaredRange: null,
      resolvedVersion: pkg.resolvedVersion,
      scope: pkg.scope === 'unknown' ? 'unknown' : pkg.scope,
      targetVersion: pkg.name === opts.targetDependency ? opts.targetVersion ?? null : null,
      conflicts: [],
      evidence: {
        status: pkg.resolvedVersion === null ? 'missing' : 'present',
        source: {
          kind: 'lockfile',
          ref: `package-lock.json#${pkg.key}`,
        },
        quality: 'exact',
      },
    });
  }

  dependencies.sort(compareDependencies);

  if (opts.targetDependency !== undefined && !dependencies.some((d) => d.name === opts.targetDependency)) {
    issues.push(
      analysisIssue(
        'DEPENDENCY_UNRESOLVED',
        'error',
        `target dependency '${opts.targetDependency}' was not found in package.json or the lockfile`,
        opts.targetDependency,
      ),
    );
  }

  const project: ProjectInfo = {
    root: ro.root,
    ecosystem: 'npm',
    manifestPath: detection.manifestPath,
    manifest: {
      name: manifest.name,
      projectVersion: manifest.version,
      packageManager: 'npm',
    },
    lockfilePath: detection.lockfilePath,
  };

  return { project, dependencies, issues };
}

/** Exported for reuse by later phases (P3+ evidence refs). */
export type { DependencyScope };
