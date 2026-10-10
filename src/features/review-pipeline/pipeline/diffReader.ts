// Reads --diff <ref> (default: staged) via git diff, using the simple-git dep
// that's already in the project. Parses the raw unified diff with the `diff`
// package's parsePatch() rather than hand-rolling a parser.
//
// Line numbers here need to be exactly right, not approximate — the change-coverage
// map keys off them (changed line -> role verdict).

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

export interface DiffLine {
  readonly type: DiffLineType;
  readonly content: string; // leading +/-/space marker stripped
  readonly oldLineNumber?: number; // set for del/context
  readonly newLineNumber?: number; // set for add/context
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
  readonly path: string; // new path, or old path if deleted
  readonly oldPath?: string; // only set on rename
  readonly status: FileChangeStatus;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly ref: string; // 'staged' for the default, or whatever ref was diffed
  readonly files: readonly DiffFile[];
  readonly raw: string; // full raw unified diff, given to roles alongside the structured form
}

// strips git's a/ b/ prefix, /dev/null becomes undefined
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

// git diff paths are always relative to repo root, not cwd. Fine when cwd IS
// the root, but breaks every consumer that joins finding.file onto cwd (Build
// role, deterministicFixer, editGenerator, the edit tool, roles' own grep/read_file
// calls) once you run scan from a subdirectory — path segments double up and
// point nowhere. Rewriting to cwd-relative once here means nothing downstream
// needs to know or care.
function rewriteFileToCwdRelative(file: DiffFile, repoRoot: string, cwd: string): DiffFile {
  const newPath = nodePath.relative(cwd, nodePath.join(repoRoot, file.path));
  if (file.status !== 'renamed' || !file.oldPath) {
    return { ...file, path: newPath };
  }
  const newOldPath = nodePath.relative(cwd, nodePath.join(repoRoot, file.oldPath));
  return { ...file, path: newPath, oldPath: newOldPath };
}

// ref omitted -> diffs staged changes (git diff --cached), which is the default
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
