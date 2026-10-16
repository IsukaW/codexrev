/**
 * Dependency Collector: finds package manifest and lockfile changes among the
 * changed files and, for package.json, works out which dependencies were
 * added, removed or re-versioned.
 *
 * Read-only: it reads the old version of a file from git (`cat-file blob`, no
 * filters) and the new version from the working tree. It never installs
 * packages, runs a package manager, or runs any script.
 *
 * It reports FACTS about versions. It cannot know whether a change is
 * compatible, so whenever anything dependency-related changed the
 * compatibility status is UNKNOWN; it is NOT_APPLICABLE only when nothing
 * dependency-related changed. Not every major bump is breaking, and not every
 * breaking change is a major bump, so a bump is flagged, never judged.
 */

import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import { createReadOnlyGit, type ChangedFile, type GitCollection } from './gitCollector.js';
import { readProjectTextFile } from './safeFiles.js';
import { COLLECTION_LIMITS, clip } from './types.js';

export type DependencySection = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
const SECTIONS: readonly DependencySection[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

export type MajorChange = 'major_upgrade' | 'major_downgrade' | 'no_major_change' | 'possibly_breaking_0x' | 'unknown' | 'not_applicable';

export interface DependencyChange {
  readonly manifest: string;
  readonly ecosystem: 'npm';
  readonly section: DependencySection;
  readonly name: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly from?: string;
  readonly to?: string;
  readonly majorChange: MajorChange;
}

export interface DependencyCollection {
  readonly state: 'collected' | 'not_collected';
  readonly observedAt: string;
  /** package.json files that changed */
  readonly manifestsChanged: readonly string[];
  readonly lockfilesChanged: readonly string[];
  /** manifests of other ecosystems: change noticed, contents not analysed */
  readonly unparsedManifests: readonly string[];
  readonly changes: readonly DependencyChange[];
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly majorUpgrades: number;
    readonly unknownMajor: number;
  };
  /** UNKNOWN whenever anything dependency-related changed or could not be determined */
  readonly compatibility: 'NOT_APPLICABLE' | 'UNKNOWN';
  readonly limitations: readonly string[];
}

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);
const OTHER_MANIFESTS = new Set([
  'requirements.txt', 'pyproject.toml', 'pipfile', 'pipfile.lock', 'poetry.lock', 'go.mod', 'go.sum',
  'cargo.toml', 'cargo.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock',
]);

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function inNodeModules(p: string): boolean {
  return p.split('/').includes('node_modules');
}

/** "^1.2.3" -> {major 1, minor 2}. Undefined for anything that is not a plain semver-style range. */
export function parseVersionSpec(spec: string): { major: number; minor?: number } | undefined {
  const s = spec.trim();
  if (s.includes('||')) return undefined;
  const m = /^[\^~>=<v\s]*(\d+)(?:\.(\d+|x|\*))?/i.exec(s);
  if (!m) return undefined;
  const minor = m[2] !== undefined && /^\d+$/.test(m[2]) ? Number(m[2]) : undefined;
  return { major: Number(m[1]), ...(minor !== undefined ? { minor } : {}) };
}

export function classifyMajorChange(from: string, to: string): MajorChange {
  const a = parseVersionSpec(from);
  const b = parseVersionSpec(to);
  if (!a || !b) return 'unknown';
  if (b.major > a.major) return 'major_upgrade';
  if (b.major < a.major) return 'major_downgrade';
  // 0.x versions may break on a minor bump, which a major comparison cannot see
  if (a.major === 0 && a.minor !== undefined && b.minor !== undefined && a.minor !== b.minor) return 'possibly_breaking_0x';
  return 'no_major_change';
}

type DepMap = Record<string, string>;

function readSections(text: string): Record<DependencySection, DepMap> | undefined {
  if (text.trim() === '') return { dependencies: {}, devDependencies: {}, peerDependencies: {}, optionalDependencies: {} };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const out = {} as Record<DependencySection, DepMap>;
  for (const section of SECTIONS) {
    const raw = (json as Record<string, unknown>)[section];
    const map: DepMap = {};
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [name, version] of Object.entries(raw)) if (typeof version === 'string') map[name] = version;
    }
    out[section] = map;
  }
  return out;
}

async function baseText(git: SimpleGit, base: string | undefined, file: ChangedFile): Promise<string | undefined> {
  // a file that is new in the working tree has no old version
  if (!base || file.change === 'untracked' || file.change === 'added') return '';
  const spec = `${base}:${file.path}`;
  try {
    const size = Number((await git.raw(['cat-file', '-s', spec])).trim());
    if (!Number.isFinite(size) || size > COLLECTION_LIMITS.maxManifestBytes) return undefined;
    return await git.raw(['cat-file', 'blob', spec]);
  } catch {
    return '';
  }
}

export async function collectDependencies(opts: { git: GitCollection; now: string }): Promise<DependencyCollection> {
  const { git: g } = opts;
  const empty = (state: DependencyCollection['state'], compatibility: DependencyCollection['compatibility'], limitations: string[]): DependencyCollection => ({
    state,
    observedAt: opts.now,
    manifestsChanged: [],
    lockfilesChanged: [],
    unparsedManifests: [],
    changes: [],
    counts: { added: 0, removed: 0, changed: 0, majorUpgrades: 0, unknownMajor: 0 },
    compatibility,
    limitations,
  });

  if (g.state !== 'collected' || !g.repoRoot) {
    return empty('not_collected', 'UNKNOWN', ['dependency changes could not be determined because git state was not collected']);
  }

  const limitations: string[] = [];
  const manifests: ChangedFile[] = [];
  const lockfilesChanged: string[] = [];
  const unparsed: string[] = [];
  for (const f of g.files) {
    if (inNodeModules(f.path)) continue;
    const name = baseName(f.path).toLowerCase();
    if (name === 'package.json') manifests.push(f);
    else if (LOCKFILES.has(name)) lockfilesChanged.push(f.path);
    else if (OTHER_MANIFESTS.has(name)) unparsed.push(f.path);
  }
  if (unparsed.length > 0) limitations.push(`changes to non-npm manifests were noticed but not analysed: ${unparsed.join(', ')}`);
  if (g.truncated) limitations.push('the changed-file list was truncated, so some dependency files may be missing');

  const git = createReadOnlyGit(g.repoRoot);
  const base = g.diffBase ?? g.head;
  const changes: DependencyChange[] = [];

  for (const f of manifests) {
    const oldText = await baseText(git, base, f);
    let newText: string | undefined = '';
    if (f.change !== 'deleted') {
      const read = await readProjectTextFile(g.repoRoot, path.join(g.repoRoot, f.path), COLLECTION_LIMITS.maxManifestBytes);
      newText = read.ok ? read.text : undefined;
      if (!read.ok) limitations.push(`${f.path}: current file not analysed (${read.reason})`);
    }
    if (oldText === undefined) limitations.push(`${f.path}: previous version not analysed (unreadable or larger than the size limit)`);
    if (oldText === undefined || newText === undefined) continue;

    const before = readSections(oldText);
    const after = readSections(newText);
    if (!before || !after) {
      limitations.push(`${f.path}: not valid JSON in the ${!before ? 'previous' : 'current'} version, dependencies not compared`);
      continue;
    }
    for (const section of SECTIONS) {
      const names = [...new Set([...Object.keys(before[section]), ...Object.keys(after[section])])].sort();
      for (const name of names) {
        const from = before[section][name];
        const to = after[section][name];
        if (from === to) continue;
        const base_ = { manifest: f.path, ecosystem: 'npm' as const, section, name };
        if (from === undefined) changes.push({ ...base_, change: 'added', to: clip(to, 100), majorChange: 'not_applicable' });
        else if (to === undefined) changes.push({ ...base_, change: 'removed', from: clip(from, 100), majorChange: 'not_applicable' });
        else changes.push({ ...base_, change: 'changed', from: clip(from, 100), to: clip(to, 100), majorChange: classifyMajorChange(from, to) });
      }
    }
  }

  const counts = {
    added: changes.filter((c) => c.change === 'added').length,
    removed: changes.filter((c) => c.change === 'removed').length,
    changed: changes.filter((c) => c.change === 'changed').length,
    majorUpgrades: changes.filter((c) => c.majorChange === 'major_upgrade').length,
    unknownMajor: changes.filter((c) => c.change === 'changed' && c.majorChange === 'unknown').length,
  };
  const anything = manifests.length > 0 || lockfilesChanged.length > 0 || unparsed.length > 0;
  if (anything) limitations.push('compatibility of the changed dependencies cannot be established from version numbers alone');

  return {
    state: 'collected',
    observedAt: opts.now,
    manifestsChanged: manifests.map((m) => m.path),
    lockfilesChanged,
    unparsedManifests: unparsed,
    changes,
    counts,
    compatibility: anything ? 'UNKNOWN' : 'NOT_APPLICABLE',
    limitations,
  };
}
