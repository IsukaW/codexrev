/**
 * Git Collector: observes the local git repository, read-only.
 *
 * Collects the branch, HEAD, and which files changed, keeping staged,
 * unstaged and untracked changes apart. With `--diff <ref>` it also compares
 * the working tree against that revision.
 *
 * Safety:
 *   - uses simple-git with argument ARRAYS only (never a shell string)
 *   - the --diff ref is validated, then resolved to a commit SHA; later
 *     commands only ever see the SHA, so a ref can never act as an option
 *   - only read commands (rev-parse, symbolic-ref, diff, ls-files, cat-file);
 *     no checkout, add, commit, stash, fetch or anything that changes state
 *   - GIT_OPTIONAL_LOCKS=0 stops git refreshing .git/index as a side effect,
 *     and --no-ext-diff/--no-textconv stop repo-configured programs from running
 *   - no file contents are collected here, only paths and line counts
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { COLLECTION_LIMITS, clip } from './types.js';

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'type_changed' | 'conflicted' | 'untracked';

export interface ChangedFile {
  /** repository-root-relative, forward slashes */
  readonly path: string;
  readonly change: ChangeKind;
  /** a change is staged in the index */
  readonly staged: boolean;
  /** the working tree differs from the index */
  readonly unstaged: boolean;
  readonly untracked: boolean;
  /** differs from the --diff revision (only set when --diff was used) */
  readonly vsRef: boolean;
  readonly insertions?: number;
  readonly deletions?: number;
  readonly binary?: boolean;
  /** directory-based grouping, see modulePathOf */
  readonly module: string;
}

export type ExcludedReason = 'sensitive' | 'unreadable' | 'too_large' | 'binary';

export interface ExcludedFile {
  readonly path: string;
  readonly reason: ExcludedReason;
}

export interface GitCollection {
  readonly state: 'collected' | 'not_a_repository' | 'error';
  readonly observedAt: string;
  readonly repoRoot?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly head?: string;
  readonly hasCommits: boolean;
  /** the --diff value as given, if any */
  readonly diffRef?: string;
  /** the commit SHA the ref resolved to */
  readonly diffBase?: string;
  /** set when the --diff ref is invalid or does not resolve: a user input error */
  readonly diffRefError?: string;
  readonly files: readonly ChangedFile[];
  readonly counts: {
    readonly total: number;
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
    readonly conflicted: number;
  };
  readonly modules: readonly string[];
  readonly excluded: readonly ExcludedFile[];
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface GitCollectOptions {
  readonly cwd: string;
  readonly diffRef?: string;
  /** ISO time, passed in so the result is reproducible */
  readonly now: string;
}

// letters, digits and the punctuation real revisions use (HEAD~2, v1.0.0, origin/main, @{u}, main^)
const REF_PATTERN = /^[A-Za-z0-9._/@{}~^+-]+$/;

/** Returns a problem description, or undefined if the ref is acceptable. */
export function validateDiffRef(ref: string): string | undefined {
  if (ref.length === 0 || ref.length > 200) return 'must be 1-200 characters';
  if (ref.startsWith('-')) return 'must not start with "-" (it would be read as an option)';
  if (!REF_PATTERN.test(ref)) return 'contains characters that are not valid in a git revision';
  if (ref.includes('..')) return 'ranges are not supported, give a single revision';
  return undefined;
}

const WORKSPACE_ROOTS = new Set(['packages', 'apps', 'libs', 'services', 'modules']);

/**
 * Groups a file into a module by directory: root files are ".", workspace
 * roots (packages/, apps/ ...) group by two levels, src/ by up to three,
 * anything else by its top-level directory. A heuristic, stated as such.
 */
export function modulePathOf(filePath: string): string {
  const dirs = filePath.split('/').slice(0, -1);
  if (dirs.length === 0) return '.';
  if (WORKSPACE_ROOTS.has(dirs[0]) && dirs.length > 1) return dirs.slice(0, 2).join('/');
  if (dirs[0] === 'src') return dirs.slice(0, Math.min(dirs.length, 3)).join('/');
  return dirs[0];
}

const SENSITIVE_NAME =
  /(^|\/)(\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml))$/i;
const SAMPLE_NAME = /\.(example|sample|template)$/i;

/** Files that probably hold secrets. Their paths are listed but their contents are never read. */
export function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_NAME.test(filePath) && !SAMPLE_NAME.test(filePath);
}

export function parseNameStatusZ(out: string): Array<{ code: string; path: string }> {
  const tokens = out.split('\0');
  const result: Array<{ code: string; path: string }> = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    if (tokens[i] === '') break;
    result.push({ code: tokens[i].trim(), path: tokens[i + 1] });
  }
  return result;
}

export function parseNumstatZ(out: string): Map<string, { insertions?: number; deletions?: number; binary: boolean }> {
  const map = new Map<string, { insertions?: number; deletions?: number; binary: boolean }>();
  for (const record of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record.replace(/^\n/, ''));
    if (!m) continue;
    map.set(m[3], m[1] === '-' ? { binary: true } : { insertions: Number(m[1]), deletions: Number(m[2]), binary: false });
  }
  return map;
}

const GIT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'USERNAME', 'USERDOMAIN',
]);

/**
 * A git handle that can only observe:
 *   - the environment is an allowlist, so GIT_DIR / GIT_INDEX_FILE / GIT_EDITOR /
 *     EDITOR / PAGER from the caller's shell cannot redirect or hijack commands
 *   - core.fsmonitor=false stops a repository-configured fsmonitor hook from
 *     running. simple-git refuses to set that option unless explicitly allowed
 *     (its guard exists for untrusted input); the value here is a constant.
 */
export function createReadOnlyGit(cwd: string): SimpleGit {
  // allowlist, not blocklist: only what git needs to run locally. Everything else
  // (EDITOR, PAGER, GIT_*, SSH_*, proxies, tokens...) is left out on purpose.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && GIT_ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return simpleGit({ baseDir: cwd, config: ['core.fsmonitor=false'], unsafe: { allowUnsafeFsMonitor: true } }).env({
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
}

async function attempt(git: SimpleGit, args: readonly string[]): Promise<string | undefined> {
  try {
    return await git.raw([...args]);
  } catch {
    return undefined;
  }
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-renames', '-z'] as const;

function emptyCollection(opts: GitCollectOptions, state: GitCollection['state'], limitations: string[], extra: Partial<GitCollection> = {}): GitCollection {
  return {
    state,
    observedAt: opts.now,
    detached: false,
    hasCommits: false,
    ...(opts.diffRef !== undefined ? { diffRef: opts.diffRef } : {}),
    files: [],
    counts: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    modules: [],
    excluded: [],
    truncated: false,
    limitations,
    ...extra,
  };
}

function changeFromCode(code: string): ChangeKind {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'T':
      return 'type_changed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

interface Draft {
  staged: string | undefined;
  unstaged: string | undefined;
  vsRef: string | undefined;
  untracked: boolean;
}

export async function collectGit(opts: GitCollectOptions): Promise<GitCollection> {
  if (opts.diffRef !== undefined) {
    const problem = validateDiffRef(opts.diffRef);
    if (problem) {
      return emptyCollection(opts, 'error', [`--diff "${clip(opts.diffRef, 60)}" is not usable: ${problem}`], {
        diffRefError: `invalid --diff revision: ${problem}`,
      });
    }
  }

  let git: SimpleGit;
  try {
    git = createReadOnlyGit(opts.cwd);
    // a thrown error (git missing, unreadable directory) is a failure, not "not a repository"
    if (!(await git.checkIsRepo())) {
      return emptyCollection(opts, 'not_a_repository', [
        'not a git repository: no change information could be observed' +
          (opts.diffRef !== undefined ? ' (--diff was therefore not applied)' : ''),
      ]);
    }
  } catch (err) {
    return emptyCollection(opts, 'error', [`git could not be started: ${clip(String((err as Error).message).split('\n')[0])}`]);
  }

  const limitations: string[] = [];
  try {
    const repoRoot = (await attempt(git, ['rev-parse', '--show-toplevel']))?.trim();
    if (!repoRoot) return emptyCollection(opts, 'error', ['could not determine the repository root']);

    const branchOut = (await attempt(git, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim();
    const head = (await attempt(git, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || undefined;
    const detached = !branchOut;
    if (!head) limitations.push('repository has no commits yet: nothing to compare against HEAD');

    let diffBase: string | undefined;
    if (opts.diffRef !== undefined) {
      const resolved = (await attempt(git, ['rev-parse', '--verify', '--quiet', `${opts.diffRef}^{commit}`]))?.trim();
      if (!resolved) {
        return emptyCollection(opts, 'error', [`--diff "${clip(opts.diffRef, 60)}" does not resolve to a commit in this repository`], {
          repoRoot,
          diffRefError: `--diff revision "${clip(opts.diffRef, 60)}" does not resolve to a commit`,
          ...(branchOut ? { branch: branchOut } : {}),
          ...(head ? { head } : {}),
          detached,
          hasCommits: Boolean(head),
        });
      }
      diffBase = resolved;
    }

    const drafts = new Map<string, Draft>();
    const draft = (p: string): Draft => {
      let d = drafts.get(p);
      if (!d) {
        d = { staged: undefined, unstaged: undefined, vsRef: undefined, untracked: false };
        drafts.set(p, d);
      }
      return d;
    };

    const stagedOut = await attempt(git, ['diff', '--cached', '--name-status', ...DIFF_FLAGS, '--']);
    const unstagedOut = await attempt(git, ['diff', '--name-status', ...DIFF_FLAGS, '--']);
    const untrackedOut = await attempt(git, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']);
    if (stagedOut === undefined) limitations.push('could not list staged changes');
    if (unstagedOut === undefined) limitations.push('could not list unstaged changes');
    if (untrackedOut === undefined) limitations.push('could not list untracked files');

    for (const e of parseNameStatusZ(stagedOut ?? '')) draft(e.path).staged = e.code;
    for (const e of parseNameStatusZ(unstagedOut ?? '')) draft(e.path).unstaged = e.code;
    for (const p of (untrackedOut ?? '').split('\0')) if (p) draft(p).untracked = true;

    if (diffBase) {
      const refOut = await attempt(git, ['diff', '--name-status', ...DIFF_FLAGS, diffBase, '--']);
      if (refOut === undefined) limitations.push('could not compare the working tree with the --diff revision');
      for (const e of parseNameStatusZ(refOut ?? '')) draft(e.path).vsRef = e.code;
    }

    const numstatBase = diffBase ?? head;
    let numstat = new Map<string, { insertions?: number; deletions?: number; binary: boolean }>();
    if (numstatBase) {
      const out = await attempt(git, ['diff', '--numstat', ...DIFF_FLAGS, numstatBase, '--']);
      if (out === undefined) limitations.push('could not count changed lines');
      else numstat = parseNumstatZ(out);
    } else {
      limitations.push('line counts unavailable without a base commit');
    }

    // with --diff, the changed set is "differs from that revision" (plus untracked); otherwise staged + unstaged + untracked
    const relevant = [...drafts.entries()]
      .filter(([, d]) => (diffBase ? d.vsRef !== undefined || d.untracked : true))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    let truncated = false;
    let kept = relevant;
    if (relevant.length > COLLECTION_LIMITS.maxChangedFiles) {
      truncated = true;
      kept = relevant.slice(0, COLLECTION_LIMITS.maxChangedFiles);
      limitations.push(`${relevant.length} changed files found; only the first ${COLLECTION_LIMITS.maxChangedFiles} are listed`);
    }

    const files: ChangedFile[] = kept.map(([p, d]) => {
      const code = diffBase ? d.vsRef : d.staged ?? d.unstaged;
      let change: ChangeKind;
      if (d.untracked && code === undefined) change = 'untracked';
      else if (d.staged?.startsWith('A') || (diffBase && d.vsRef?.startsWith('A'))) change = 'added';
      else if (d.staged?.startsWith('D') || d.unstaged?.startsWith('D') || (diffBase && d.vsRef?.startsWith('D'))) change = 'deleted';
      else if (d.staged?.startsWith('U') || d.unstaged?.startsWith('U')) change = 'conflicted';
      else change = changeFromCode(code ?? 'M');
      const stats = numstat.get(p);
      return {
        path: p,
        change,
        staged: d.staged !== undefined,
        unstaged: d.unstaged !== undefined,
        untracked: d.untracked,
        vsRef: d.vsRef !== undefined,
        ...(stats && !stats.binary ? { insertions: stats.insertions, deletions: stats.deletions } : {}),
        ...(stats?.binary ? { binary: true } : {}),
        module: modulePathOf(p),
      };
    });

    // note files whose contents must not (or cannot) be read; never read them here
    const excluded: ExcludedFile[] = [];
    let checked = 0;
    for (const f of files) {
      if (isSensitivePath(f.path)) {
        excluded.push({ path: f.path, reason: 'sensitive' });
        continue;
      }
      if (f.binary) {
        excluded.push({ path: f.path, reason: 'binary' });
        continue;
      }
      if (f.change === 'deleted') continue;
      if (checked >= COLLECTION_LIMITS.maxFileChecks) {
        if (checked === COLLECTION_LIMITS.maxFileChecks) limitations.push(`file readability was only checked for the first ${COLLECTION_LIMITS.maxFileChecks} files`);
        checked++;
        continue;
      }
      checked++;
      const abs = path.join(repoRoot, f.path);
      try {
        const stat = await fs.stat(abs);
        await fs.access(abs, fsConstants.R_OK);
        if (stat.isFile() && stat.size > COLLECTION_LIMITS.maxReportBytes) excluded.push({ path: f.path, reason: 'too_large' });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') excluded.push({ path: f.path, reason: 'unreadable' });
      }
    }

    const counts = {
      total: files.length,
      staged: files.filter((f) => f.staged).length,
      unstaged: files.filter((f) => f.unstaged).length,
      untracked: files.filter((f) => f.untracked).length,
      conflicted: files.filter((f) => f.change === 'conflicted').length,
    };

    return {
      state: 'collected',
      observedAt: opts.now,
      repoRoot,
      ...(branchOut ? { branch: branchOut } : {}),
      detached,
      ...(head ? { head } : {}),
      hasCommits: Boolean(head),
      ...(opts.diffRef !== undefined ? { diffRef: opts.diffRef } : {}),
      ...(diffBase ? { diffBase } : {}),
      files,
      counts,
      modules: [...new Set(files.map((f) => f.module))].sort(),
      excluded,
      truncated,
      limitations,
    };
  } catch (err) {
    return emptyCollection(opts, 'error', [`git collection failed: ${clip(String((err as Error).message).split('\n')[0])}`]);
  }
}
