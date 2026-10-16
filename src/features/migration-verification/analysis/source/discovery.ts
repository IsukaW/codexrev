/**
 * Feature 3 / Function 1 — deterministic source-file discovery (Phase P4).
 *
 * Walks the target project root through `ReadOnlyFs` (root-confined, no
 * writes) and returns JS/TS source files in a deterministic order.
 *
 * Default include: extensions .js .jsx .ts .tsx .mjs .cjs (case-insensitive).
 * Default exclude: directories named node_modules, dist, build, coverage,
 * .git, .next, .cache, .codexrev, and ANY dot-directory, plus any symlinked
 * file or directory (never followed — prevents escaping the project root).
 * Unreadable directories/files are reported as ANALYZER_FAILED warnings and
 * skipped; discovery never crashes.
 */

import path from 'node:path';
import type { AnalysisIssue } from '../types.js';
import { analysisIssue } from '../issues.js';
import { ReadOnlyFs } from '../readOnlyFs.js';

export const DEFAULT_SOURCE_EXTENSIONS: readonly string[] = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
];

export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.cache',
  '.codexrev',
];

export interface SourceDiscoveryOptions {
  projectRoot: string;
  extensions?: readonly string[];
  excludeDirs?: readonly string[];
}

export interface SourceDiscoveryResult {
  /** POSIX-style relative paths, sorted ascending (deterministic). */
  files: string[];
  issues: AnalysisIssue[];
}

export async function discoverSourceFiles(opts: SourceDiscoveryOptions): Promise<SourceDiscoveryResult> {
  const ro = new ReadOnlyFs(opts.projectRoot);
  const extensions = (opts.extensions ?? DEFAULT_SOURCE_EXTENSIONS).map((e) => e.toLowerCase());
  const excluded = new Set(opts.excludeDirs ?? DEFAULT_EXCLUDED_DIRS);
  const issues: AnalysisIssue[] = [];
  const files: string[] = [];

  async function walk(relDir: string): Promise<void> {
    let entries;
    try {
      entries = await ro.listDirEntries(relDir === '' ? '.' : relDir);
    } catch (err) {
      issues.push(
        analysisIssue(
          'ANALYZER_FAILED',
          'warning',
          `cannot read directory '${relDir || '.'}': ${(err as Error).message}`,
          relDir || '.',
        ),
      );
      return;
    }
    // Deterministic order: process entries sorted by name.
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink) continue; // never follow symlinks
      if (entry.isDirectory) {
        if (excluded.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue; // any dot-directory
        await walk(relPath);
      } else if (entry.isFile) {
        const ext = path.posix.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) files.push(relPath);
      }
    }
  }

  await walk('');
  files.sort(); // POSIX codepoint order — deterministic across runs
  return { files, issues };
}
