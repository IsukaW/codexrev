/**
 * Codexrev — Feature 2 (review-pipeline) git diff ingestion.
 *
 * Resolves `--diff <ref>` (default: staged changes) via `git diff`,
 * reusing the same `simple-git` dependency already used by
 * `services/checkpoint.ts` — no new git-shelling code. Parses the raw
 * unified diff into per-file hunks with per-line old/new line numbers,
 * reusing the already-installed `diff` package's `parsePatch()` for the
 * unified-diff grammar instead of hand-rolling one.
 *
 * The per-line line numbers are what Phase 7's git change-coverage map
 * keys off of (each changed line → the role verdict that covers it), so
 * they need to be right, not just "close enough for a prompt".
 */

import nodePath from 'node:path';
import { simpleGit } from 'simple-git';
import { parsePatch } from 'diff';
import { CodexrevError } from '../../../utils/errors.js';

export class DiffReaderError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_DIFF_READER_ERROR', false);
    this.name = 'DiffReaderError';
  }
}

export type DiffLineType = 'add' | 'del' | 'context';

/** One line inside a hunk, with the line number(s) it corresponds to on each side. */
export interface DiffLine {
  readonly type: DiffLineType;
  /** Line content, with the leading +/-/space marker stripped. */
  readonly content: string;
  /** Set for 'del' and 'context' lines — the line's number in the old file. */
  readonly oldLineNumber?: number;
  /** Set for 'add' and 'context' lines — the line's number in the new file. */
  readonly newLineNumber?: number;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  /** Current path — the new path, or the old path for a deleted file. */
  readonly path: string;
  /** Only set when the file was renamed (old path differs from `path`). */
  readonly oldPath?: string;
  readonly status: FileChangeStatus;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  /** 'staged' for the default (`git diff --cached`), or the ref that was diffed against. */
  readonly ref: string;
  readonly files: readonly DiffFile[];
  /** Full raw unified diff text — handed to roles as prompt context alongside the structured form. */
  readonly raw: string;
}

/** Strips git's `a/`/`b/` prefix and normalizes `/dev/null` to undefined. */
function stripGitPrefix(p: string): string | undefined {
  if (p === '/dev/null') return undefined;
  return p.replace(/^[ab]\//, '');
}

function normalizeHunk(h: {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}): DiffHunk {
  let oldLineNo = h.oldStart;
  let newLineNo = h.newStart;
  const lines: DiffLine[] = [];

  for (const raw of h.lines) {
    const marker = raw[0];
    if (marker === '\\') continue; // "\ No newline at end of file" — not a real content line
    const content = raw.slice(1);
    if (marker === '+') {
      lines.push({ type: 'add', content, newLineNumber: newLineNo });
      newLineNo++;
    } else if (marker === '-') {
      lines.push({ type: 'del', content, oldLineNumber: oldLineNo });
      oldLineNo++;
    } else {
      lines.push({ type: 'context', content, oldLineNumber: oldLineNo, newLineNumber: newLineNo });
      oldLineNo++;
      newLineNo++;
    }
  }

  return { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines };
}

function normalizeFile(patch: {
  oldFileName?: string;
  newFileName?: string;
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
}): DiffFile {
  const oldPath = patch.oldFileName ? stripGitPrefix(patch.oldFileName) : undefined;
  const newPath = patch.newFileName ? stripGitPrefix(patch.newFileName) : undefined;

  let status: FileChangeStatus;
  if (oldPath === undefined && newPath !== undefined) status = 'added';
  else if (newPath === undefined && oldPath !== undefined) status = 'deleted';
  else if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath) status = 'renamed';
  else status = 'modified';

  const path = status === 'deleted' ? (oldPath as string) : (newPath as string);

  return {
    path,
    ...(status === 'renamed' ? { oldPath } : {}),
    status,
    hunks: patch.hunks.map(normalizeHunk),
  };
}

/**
 * `git diff` always reports file paths relative to the repo ROOT, never
 * relative to the caller's cwd — a fact that's invisible when `cwd` IS
 * the repo root, but breaks every downstream consumer that joins
 * `finding.file` onto `cwd` (the Build role, `deterministicFixer.ts`,
 * `editGenerator.ts`, the `edit` tool, a role's own `read_file`/`grep`
 * tool calls) the moment `codexrev review scan` is run from a
 * subdirectory of a larger repo (e.g. this repo's own `testProject/`
 * sample dir) — paths like `testProject/src/fib.js` get joined onto a
 * cwd that's ALREADY `.../testProject`, doubling the segment into a
 * path that doesn't exist. Rewriting every path to be cwd-relative here,
 * once, at the source, means every downstream consumer's existing
 * "just join this onto cwd" logic is simply correct, with no changes
 * needed anywhere else.
 */
function rewriteFileToCwdRelative(file: DiffFile, repoRoot: string, cwd: string): DiffFile {
  const newPath = nodePath.relative(cwd, nodePath.join(repoRoot, file.path));
  if (file.status !== 'renamed' || !file.oldPath) {
    return { ...file, path: newPath };
  }
  const newOldPath = nodePath.relative(cwd, nodePath.join(repoRoot, file.oldPath));
  return { ...file, path: newPath, oldPath: newOldPath };
}

/**
 * Reads and parses the diff for `codexrev review scan`.
 *
 * @param cwd - Repo root to run `git diff` in.
 * @param ref - Git ref to diff against (e.g. `HEAD~1`, a branch, a commit
 *   SHA). Omit to diff staged changes (`git diff --cached`) — the default
 *   per Phase 1's `--diff` flag description.
 */
export async function readDiff(cwd: string, ref?: string): Promise<ParsedDiff> {
  const git = simpleGit({ baseDir: cwd });

  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    throw new DiffReaderError(`"${cwd}" is not a git repository.`);
  }

  let raw: string;
  try {
    raw = ref ? await git.diff([ref]) : await git.diff(['--cached']);
  } catch (err) {
    const detail = (err as Error).message ?? String(err);
    throw new DiffReaderError(
      ref ? `git diff against "${ref}" failed: ${detail}` : `git diff --cached failed: ${detail}`,
    );
  }

  if (!raw.trim()) {
    return { ref: ref ?? 'staged', files: [], raw: '' };
  }

  const patches = parsePatch(raw);
  let files = patches.map(normalizeFile);

  const repoRoot = (await git.revparse(['--show-toplevel'])).trim();
  if (nodePath.resolve(repoRoot) !== nodePath.resolve(cwd)) {
    files = files.map((f) => rewriteFileToCwdRelative(f, repoRoot, cwd));
  }

  return { ref: ref ?? 'staged', files, raw };
}
