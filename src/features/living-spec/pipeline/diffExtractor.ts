/**
 * Deterministic diff extraction for the Living Specification Engine.
 *
 * Reads a diff from a git ref (default: staged changes) with the `simple-git`
 * dependency and parses the unified diff with the `diff` package's
 * parsePatch() — same approach as the review pipeline's diffReader, but
 * implemented independently for this feature (paths stay repo-relative per
 * the living-spec contract, and the output is a *minimal* view).
 *
 * Guarantees:
 *   - exact old/new line numbers on every parsed line;
 *   - a minimal diff view: changed lines + at most `contextLines` context
 *     lines around each change cluster — never whole files;
 *   - configurable glob filtering from `.codexrev/living-spec/config.json`
 *     (default: source files only), with node_modules/dist/.git/.codexrev
 *     always excluded;
 *   - an explicit truncation flag when the raw diff exceeds `maxBytes`.
 *
 * No LLM calls — this module is pure mechanics.
 */

import nodePath from 'node:path';
import { parsePatch } from 'diff';
import { simpleGit } from 'simple-git';
import { LivingSpecDiffError } from '../tools/errors.js';
import {
  createPathMatcher,
  isAlwaysExcludedPath,
  normalizeRelPath,
  type PathMatcher,
} from '../tools/pathMatcher.js';

export const DEFAULT_CONTEXT_LINES = 3;
export const DEFAULT_MAX_DIFF_BYTES = 200 * 1024; // 200 KB

/** Default analysis filter: source files only, whatever the extension says. */
export const DEFAULT_SOURCE_GLOBS: readonly string[] = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.py',
  '**/*.java',
  '**/*.go',
  '**/*.rs',
];

export type DiffLineType = 'add' | 'del' | 'context';

export interface DiffLine {
  readonly type: DiffLineType;
  /** Line content with the leading +/-/space marker stripped. */
  readonly content: string;
  /** Exact line number in the old file (del/context lines). */
  readonly oldLineNumber?: number;
  /** Exact line number in the new file (add/context lines). */
  readonly newLineNumber?: number;
}

export interface DiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Changed lines + at most `contextLines` context lines per change cluster. */
  readonly lines: readonly DiffLine[];
  /** True when context lines were elided to keep the view minimal. */
  readonly contextTruncated: boolean;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  /** Repo-relative path (forward slashes); old path if the file was deleted. */
  readonly path: string;
  /** Set only for renames. */
  readonly oldPath?: string;
  readonly status: FileChangeStatus;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly hunks: readonly DiffHunk[];
  /** The minimal diff view for this file (unified-diff text, limited context). */
  readonly minimalPatch: string;
}

export interface ExtractedDiff {
  /** `'staged'` when no ref was given, otherwise the requested ref. */
  readonly ref: string;
  readonly files: readonly DiffFile[];
  /** True when the raw diff exceeded `maxBytes` and had to be cut. */
  readonly truncated: boolean;
  readonly totalBytes: number;
  /** Files left out entirely when the diff was truncated. */
  readonly omittedPaths: readonly string[];
  /** Raw unified diff as parsed (truncated to `maxBytes` when flagged). */
  readonly raw: string;
  readonly maxBytes: number;
}

export interface DiffExtractorOptions {
  /** Git ref to diff against; omitted = staged changes (`git diff --cached`). */
  readonly ref?: string;
  /** Glob filter for analysed files (default: source files only). */
  readonly includePaths?: readonly string[];
  /** Context lines kept around changes in the minimal view (default: 3). */
  readonly contextLines?: number;
  /** Truncation guard for the raw diff (default: 200 KB). */
  readonly maxBytes?: number;
  /** Optional git pathspec narrowing (used by the watch session). */
  readonly paths?: readonly string[];
}

// ── Path / name helpers ────────────────────────────────────────────────

// git quotes paths containing special chars: "a/my file.ts"
function unquoteGitPath(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return p;
}

// strips git's a/ b/ prefix; /dev/null becomes undefined
function stripGitPrefix(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const p = unquoteGitPath(raw.trim());
  if (p === '/dev/null') return undefined;
  return p.replace(/^[ab]\//, '');
}

// ── Minimal-view trimming ──────────────────────────────────────────────

/**
 * Keeps every changed line plus at most `contextLines` context lines around
 * each change cluster (before/after), dropping the rest. Line numbers on the
 * kept lines stay exact — dropped context is never renumbered away.
 */
export function toMinimalLines(
  all: readonly DiffLine[],
  contextLines: number,
): { lines: DiffLine[]; contextTruncated: boolean } {
  const changeIndexes: number[] = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].type !== 'context') changeIndexes.push(i);
  }

  const keep = new Set<number>();
  if (changeIndexes.length === 0) {
    // context-only hunk (git never emits one) — keep a bounded head
    const kept = all.slice(0, Math.max(0, contextLines));
    return { lines: [...kept], contextTruncated: kept.length < all.length };
  }

  for (const i of changeIndexes) keep.add(i);

  const first = changeIndexes[0];
  const last = changeIndexes[changeIndexes.length - 1];
  // leading run: the `contextLines` lines closest to the first change
  for (let i = first - 1; i >= 0 && first - i <= contextLines; i--) keep.add(i);
  // trailing run: the `contextLines` lines closest to the last change
  for (let i = last + 1; i < all.length && i - last <= contextLines; i++) keep.add(i);
  // interior runs between two change clusters: bounded on both sides
  for (let c = 0; c + 1 < changeIndexes.length; c++) {
    const gapStart = changeIndexes[c] + 1;
    const gapEnd = changeIndexes[c + 1] - 1;
    for (let i = gapStart; i <= gapEnd && i - gapStart < contextLines; i++) keep.add(i);
    for (let i = gapEnd; i >= gapStart && gapEnd - i < contextLines; i--) keep.add(i);
  }

  const lines = all.filter((_, i) => keep.has(i));
  return { lines, contextTruncated: lines.length < all.length };
}

// ── Patch normalization ────────────────────────────────────────────────

function normalizeHunk(
  hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] },
  contextLines: number,
): DiffHunk {
  let oldLineNo = hunk.oldStart;
  let newLineNo = hunk.newStart;
  const all: DiffLine[] = [];

  for (const raw of hunk.lines) {
    const marker = raw[0];
    if (marker === '\\') continue; // "\ No newline at end of file"
    const content = raw.slice(1);
    if (marker === '+') {
      all.push({ type: 'add', content, newLineNumber: newLineNo });
      newLineNo++;
    } else if (marker === '-') {
      all.push({ type: 'del', content, oldLineNumber: oldLineNo });
      oldLineNo++;
    } else {
      all.push({ type: 'context', content, oldLineNumber: oldLineNo, newLineNumber: newLineNo });
      oldLineNo++;
      newLineNo++;
    }
  }

  const { lines, contextTruncated } = toMinimalLines(all, contextLines);
  return {
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines,
    contextTruncated,
  };
}

function renderMinimalPatch(
  status: FileChangeStatus,
  oldPath: string | undefined,
  path: string,
  hunks: readonly DiffHunk[],
): string {
  if (hunks.length === 0) return '';
  const out: string[] = [`--- a/${oldPath ?? path}`];
  out.push(status === 'deleted' ? '+++ /dev/null' : `+++ b/${path}`);
  for (const h of hunks) {
    out.push(h.header);
    for (const line of h.lines) {
      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      out.push(`${marker}${line.content}`);
    }
  }
  return `${out.join('\n')}\n`;
}

// ── Section handling (one raw section per file) ────────────────────────

const DIFF_GIT_RE = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/;
const RENAME_FROM_RE = /^rename from (.+)$/m;
const RENAME_TO_RE = /^rename to (.+)$/m;

function firstLine(section: string): string {
  const nl = section.indexOf('\n');
  return nl === -1 ? section : section.slice(0, nl);
}

function sectionHeaderPaths(section: string): { oldPath?: string; newPath?: string } {
  const from = RENAME_FROM_RE.exec(section);
  const to = RENAME_TO_RE.exec(section);
  if (from && to) {
    return {
      oldPath: normalizeRelPath(unquoteGitPath(from[1])),
      newPath: normalizeRelPath(unquoteGitPath(to[1])),
    };
  }
  const m = DIFF_GIT_RE.exec(firstLine(section));
  if (m) {
    return {
      oldPath: normalizeRelPath(unquoteGitPath(m[1])),
      newPath: normalizeRelPath(unquoteGitPath(m[2])),
    };
  }
  return {};
}

/** Best-effort display path for a raw section (used for omitted-file reports). */
function sectionDisplayPath(section: string): string {
  const { oldPath, newPath } = sectionHeaderPaths(section);
  return newPath ?? oldPath ?? '(unknown)';
}

function splitDiffSections(raw: string): string[] {
  if (!raw.trim()) return [];
  const parts = raw.split(/^(?=diff --git )/m);
  return parts.filter((s) => s.trim().length > 0);
}

function cutToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  let cut = buf.subarray(0, Math.max(0, maxBytes)).toString('utf-8');
  const nl = cut.lastIndexOf('\n');
  if (nl >= 0) cut = cut.slice(0, nl + 1);
  return cut;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

interface TruncatedSections {
  readonly included: readonly string[];
  readonly truncated: boolean;
  readonly omittedPaths: readonly string[];
  readonly totalBytes: number;
}

/**
 * Never parses a half-written file patch: whole sections are kept while they
 * fit `maxBytes`; only when the very first section is larger than the whole
 * budget is it cut at the last complete line. Truncation is always explicit.
 */
function applyMaxBytes(sections: readonly string[], maxBytes: number): TruncatedSections {
  const totalBytes = sections.reduce((n, s) => n + byteLength(s), 0);
  if (totalBytes <= maxBytes) {
    return { included: [...sections], truncated: false, omittedPaths: [], totalBytes };
  }

  const included: string[] = [];
  let used = 0;
  let firstOmitted = sections.length;
  for (let i = 0; i < sections.length; i++) {
    const size = byteLength(sections[i]);
    if (used + size <= maxBytes) {
      included.push(sections[i]);
      used += size;
      continue;
    }
    if (included.length === 0) {
      included.push(cutToBytes(sections[i], maxBytes));
      firstOmitted = i + 1;
    } else {
      firstOmitted = i;
    }
    break;
  }

  const omittedPaths = sections.slice(firstOmitted).map(sectionDisplayPath);
  return { included, truncated: true, omittedPaths, totalBytes };
}

// ── Section → DiffFile ─────────────────────────────────────────────────

interface RawPatch {
  oldFileName?: string;
  newFileName?: string;
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
}

function normalizeSection(
  section: string,
  contextLines: number,
  repoRoot: string,
  projectRoot: string,
): DiffFile | null {
  let patches: RawPatch[] = [];
  try {
    patches = parsePatch(section) as unknown as RawPatch[];
  } catch {
    patches = [];
  }
  const patch = patches[0];

  // parsePatch() reads names from ---/+++ headers; pure renames and binary
  // changes only carry `rename from/to` / `diff --git` names. When parsePatch
  // saw a name header it wins outright — the fallback must not resurrect a
  // `/dev/null` side (which is exactly how adds/deletes are marked).
  const header = sectionHeaderPaths(section);
  const sawPatchNames =
    patch !== undefined &&
    (patch.oldFileName !== undefined || patch.newFileName !== undefined);
  const oldPathRaw = sawPatchNames ? stripGitPrefix(patch.oldFileName) : header.oldPath;
  const newPathRaw = sawPatchNames ? stripGitPrefix(patch.newFileName) : header.newPath;
  if (oldPathRaw === undefined && newPathRaw === undefined) return null;

  let status: FileChangeStatus;
  if (oldPathRaw === undefined && newPathRaw !== undefined) status = 'added';
  else if (newPathRaw === undefined && oldPathRaw !== undefined) status = 'deleted';
  else if (oldPathRaw !== newPathRaw) status = 'renamed';
  else status = 'modified';

  const path = status === 'deleted' ? (oldPathRaw as string) : (newPathRaw as string);

  const hunks = (patch?.hunks ?? []).map((h) => normalizeHunk(h, contextLines));
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.type === 'add') linesAdded++;
      else if (line.type === 'del') linesRemoved++;
    }
  }

  // git reports paths relative to the repo root; keep them relative to the
  // target project so consumers can join them onto the project root directly.
  const rewrite = (p: string): string => {
    if (nodePath.resolve(repoRoot) === nodePath.resolve(projectRoot)) return normalizeRelPath(p);
    return normalizeRelPath(nodePath.relative(projectRoot, nodePath.join(repoRoot, p)));
  };
  const finalPath = rewrite(path);
  const finalOldPath = status === 'renamed' ? rewrite(oldPathRaw as string) : undefined;

  return {
    path: finalPath,
    ...(finalOldPath !== undefined ? { oldPath: finalOldPath } : {}),
    status,
    linesAdded,
    linesRemoved,
    hunks,
    minimalPatch: renderMinimalPatch(status, finalOldPath, finalPath, hunks),
  };
}

// ── Public API ─────────────────────────────────────────────────────────

function buildFileFilter(includePaths: readonly string[]): PathMatcher {
  const matches = createPathMatcher(includePaths);
  return (relPath: string): boolean => {
    const p = normalizeRelPath(relPath);
    return !isAlwaysExcludedPath(p) && matches(p);
  };
}

/**
 * Extracts and filters the diff for `projectRoot`.
 *
 * Throws `LivingSpecDiffError` when the project is not a git repository or
 * `git diff` fails.
 */
export async function extractDiff(
  projectRoot: string,
  options: DiffExtractorOptions = {},
): Promise<ExtractedDiff> {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const includePaths = options.includePaths ?? DEFAULT_SOURCE_GLOBS;

  const git = simpleGit({ baseDir: projectRoot });
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    throw new LivingSpecDiffError(`"${projectRoot}" is not a git repository.`);
  }

  const ref = options.ref;
  const args: string[] = ref ? [ref] : ['--cached'];
  args.push(`--unified=${Math.max(0, contextLines)}`);
  if (options.paths && options.paths.length > 0) {
    args.push('--', ...options.paths.map(normalizeRelPath));
  }

  let raw: string;
  try {
    raw = await git.diff(args);
  } catch (err) {
    const detail = (err as Error).message ?? String(err);
    throw new LivingSpecDiffError(
      ref ? `git diff against "${ref}" failed: ${detail}` : `git diff --cached failed: ${detail}`,
    );
  }

  const resolvedRef = ref ?? 'staged';
  const sections = splitDiffSections(raw);
  const { included, truncated, omittedPaths, totalBytes } = applyMaxBytes(sections, maxBytes);

  if (included.length === 0) {
    return {
      ref: resolvedRef,
      files: [],
      truncated: false,
      totalBytes: 0,
      omittedPaths: [],
      raw: '',
      maxBytes,
    };
  }

  const repoRoot = (await git.revparse(['--show-toplevel'])).trim();
  const filter = buildFileFilter(includePaths);
  const files: DiffFile[] = [];
  for (const section of included) {
    const file = normalizeSection(section, contextLines, repoRoot, projectRoot);
    if (!file) continue;
    const candidatePaths = file.oldPath ? [file.path, file.oldPath] : [file.path];
    if (candidatePaths.some((p) => filter(p))) files.push(file);
  }

  return {
    ref: resolvedRef,
    files,
    truncated,
    totalBytes,
    omittedPaths,
    raw: included.join(''),
    maxBytes,
  };
}
