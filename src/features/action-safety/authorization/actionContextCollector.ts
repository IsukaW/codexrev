/**
 * Trusted Git action-context collector (read-only).
 *
 * It OBSERVES a local Git repository and builds the action context that the
 * developer proof must match. The commit and the content digest are never taken from the
 * caller or the proof: they come only from what Git reports about the actual repository.
 * It is not connected to the assessment pipeline and it executes nothing but read-only Git commands.
 *
 * WHAT IT ESTABLISHES (and nothing more)
 *   - which repository was examined (real root, git dir, common dir, object format);
 *   - the exact HEAD commit and its tree;
 *   - that the working tree is CLEAN: no staged, unstaged, untracked, deleted, renamed or unmerged
 *     entries, no submodule changes, and no index flags that hide changes from `git status`;
 *   - a deterministic SHA-256 digest of the committed HEAD snapshot (see below);
 *   - that nothing moved while it looked (HEAD and status are read before and after the digest).
 * It does NOT authenticate anybody, prove authorization, verify a deployment target, or bind the
 * deployed artifact. The repository path must come from a trusted runner: a path is not evidence that
 * a repository is the right one (`expectedRoot` lets the runner pin it).
 *
 * THE DIGEST (HEAD snapshot, version 1). SHA-256 over these exact bytes, in this order:
 *   "codexrev-git-snapshot-v1\n"               domain separation: no other use can produce it
 *   "object-format:" + (sha1|sha256) + "\n"    so a SHA-1 and a SHA-256 repository never collide
 *   "commit:" + <HEAD commit id> + "\n"
 *   "tree:"   + <HEAD tree id>   + "\n"
 *   "entries:" + <count> + "\n"
 *   for every entry of `git ls-tree -r -z --full-tree <commit>`, sorted by raw PATH BYTES (a memcmp,
 *   not Git's tree order, not locale order):
 *     <mode> SP <type> SP <object id> TAB <byte length of path> ":" <raw path bytes> "\n"
 * Paths are raw bytes (never decoded, so odd encodings cannot collide) and length-prefixed (so a path
 * containing a newline or tab cannot forge another entry). The result is `sha256:<64 lowercase hex>`,
 * the exact format proof.ts expects. What it covers: every file, symlink, mode and path in the
 * committed tree, plus the commit that points at it. HOW the file CONTENT is covered: through Git's
 * own object ids (blob ids are hashes of the content). So the digest is only as collision-resistant
 * as the repository's object hash: SHA-256 repositories get SHA-256 strength throughout; SHA-1
 * repositories rely on SHA-1 for the file-content links (Git's collision detection applies).
 *
 * THE REVIEW-BASE LIMITATION. `ActionContext` has one commit and one digest. It has no place for a
 * base revision, so a digest of "the diff against a base" cannot be bound to a signed context
 * without redefining its meaning, and a base chosen by the developer would be developer-controlled
 * even if Git resolves it. So this first implementation binds the WHOLE HEAD SNAPSHOT of a clean
 * tree, not a reviewed change. A reviewed-diff binding needs a trusted base in the signed context.
 *
 * ONLY `code_change` AND `deployment` ARE SUPPORTED. A Git snapshot does not prove a database
 * migration's contents or a configuration rollout, so for the other action types the result is
 * `incomplete` ('non_git_artifact_binding_unavailable'): that binding needs a non-Git source.
 * `deployment` (added for the university prototype) binds "deploy THIS COMMIT": the signed context
 * names the clean HEAD snapshot that is meant to be deployed. It does NOT prove that the artifact
 * which is actually deployed was built from that commit; that needs a build-artifact digest.
 *
 * GIT SAFETY. Every command is an argument array (no shell, the repository path is only ever the
 * working directory), with bounded time and output. The environment is an allowlist, so inherited
 * GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG*, GIT_EXTERNAL_DIFF, EDITOR and similar cannot
 * redirect or hijack Git. User and system config are disabled (GIT_CONFIG_GLOBAL points at the null
 * device, GIT_CONFIG_NOSYSTEM=1): this also keeps a developer's global `filter.*.clean` commands and
 * `core.autocrlf` out of the cleanliness check. Replacement objects are ignored
 * (GIT_NO_REPLACE_OBJECTS=1), the fsmonitor hook is disabled, and optional locks are off so reading
 * never refreshes the index. Repository-local config that would make `git status` run a program
 * (`filter.*.clean|smudge|process`) or hide files (sparse checkout) is refused, not run. Only
 * read commands are used: --version, rev-parse, config --list, symbolic-ref, ls-files, status, ls-tree.
 * A truncated, timed-out or failed command is never read as "clean": it makes the result incomplete.
 *
 * LIMITS, plainly: ignored files (and anything hidden by `.git/info/exclude`) are neither hashed nor
 * reported, so a clean tree can still differ from what a build sees; files changed by Git filters or
 * generated outside Git are invisible; line-ending conversion differences (e.g. a developer's global
 * `core.autocrlf`, which is deliberately not read) can make a checkout look dirty unless the
 * repository normalizes with `.gitattributes`; the `git` executable is found through PATH, which the
 * runner must control; and a recheck cannot stop a change made AFTER it. The protected executor must
 * verify the deployed artifact itself.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseActionContext, type ActionContext } from './proof.js';

// ---------------------------------------------------------------- constants

export const GIT_SNAPSHOT_DIGEST_DOMAIN = 'codexrev-git-snapshot-v1';
export const DEFAULT_GIT_TIMEOUT_MS = 20_000;
export const MAX_GIT_TIMEOUT_MS = 120_000;
/** Output cap for ordinary commands. */
export const MAX_SMALL_OUTPUT_BYTES = 64 * 1024;
/** Output cap for status. Larger output is treated as incomplete, never as clean. */
export const MAX_STATUS_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Output cap for the tree and index listings. A larger repository is refused, not truncated. */
export const MAX_LISTING_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_REPOSITORY_PATH_CHARS = 1024;

/**
 * The "no file" path handed to GIT_CONFIG_GLOBAL. Not `os.devNull`: on Windows that is `\\.\nul`, which
 * Git for Windows rejects ("unable to access '\\.\nul'"), while plain `NUL` works.
 */
export const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export type GitObjectFormat = 'sha1' | 'sha256';
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// ---------------------------------------------------------------- reason codes

export type CollectorCode =
  | 'invalid_request'
  | 'path_invalid'
  | 'not_a_directory'
  | 'git_unavailable'
  | 'git_timeout'
  | 'git_output_too_large'
  | 'git_command_failed'
  | 'repository_unusable'
  | 'repository_mismatch'
  | 'bare_repository_unsupported'
  | 'not_in_work_tree'
  | 'submodule_repository_unsupported'
  | 'unsupported_object_format'
  | 'no_commits'
  | 'head_unreadable'
  | 'unsafe_repository_configuration'
  | 'index_flags_unsupported'
  | 'working_tree_dirty'
  | 'status_unparseable'
  | 'tree_unreadable'
  | 'tree_unparseable'
  | 'submodules_unsupported'
  | 'changed_during_collection'
  | 'invalid_action_metadata'
  | 'non_git_artifact_binding_unavailable'
  | 'previous_not_genuine';

const MESSAGES: Readonly<Record<CollectorCode, string>> = {
  invalid_request: 'the collection request is invalid',
  path_invalid: 'the repository path is not a valid absolute path',
  not_a_directory: 'the repository path is not a directory',
  git_unavailable: 'the git executable could not be run',
  git_timeout: 'a git command took too long',
  git_output_too_large: 'a git command produced more output than allowed',
  git_command_failed: 'a git command failed',
  repository_unusable: 'the path is not inside a usable git repository',
  repository_mismatch: 'the repository found is not the expected repository',
  bare_repository_unsupported: 'bare repositories are not supported',
  not_in_work_tree: 'the path is not inside a working tree',
  submodule_repository_unsupported: 'a repository that is itself a submodule is not supported',
  unsupported_object_format: 'the repository object format is not supported',
  no_commits: 'the repository has no commits, so there is no HEAD to bind',
  head_unreadable: 'HEAD could not be resolved to a commit',
  unsafe_repository_configuration: 'the repository configuration would make git run a program or hide files, so the working tree cannot be observed safely',
  index_flags_unsupported: 'the index marks files so that changes to them would be hidden from git status',
  working_tree_dirty: 'the working tree is not clean',
  status_unparseable: 'the git status output could not be interpreted',
  tree_unreadable: 'the HEAD tree could not be read',
  tree_unparseable: 'the HEAD tree listing could not be interpreted',
  submodules_unsupported: 'the HEAD tree contains submodules, whose content this snapshot does not cover',
  changed_during_collection: 'the repository changed while it was being observed',
  invalid_action_metadata: 'the action metadata is invalid',
  non_git_artifact_binding_unavailable: 'a Git snapshot cannot represent this kind of action: its artifact binding must come from a non-Git source',
  previous_not_genuine: 'the previous context was not produced by this collector',
};

// ---------------------------------------------------------------- git runner

export interface GitRunOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type GitRunResult =
  | { readonly ok: true; readonly stdout: Buffer }
  | { readonly ok: false; readonly kind: 'unavailable' | 'timeout' | 'output_limit' | 'exit' | 'error'; readonly exitCode?: number };

/** Runs `git <args>`. Injectable so tests can simulate failures; the real one never uses a shell. */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitRunResult>;

/** The real runner: execFile with an argument array, no shell, bounded time and output. */
export const realGitRunner: GitRunner = (args, options) =>
  new Promise((resolve) => {
    try {
      execFile(
        'git',
        [...args],
        { cwd: options.cwd, env: { ...options.env }, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes, windowsHide: true, encoding: 'buffer', shell: false },
        (err, stdout) => {
          if (!err) return resolve({ ok: true, stdout });
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (e.code === 'ENOENT') return resolve({ ok: false, kind: 'unavailable' });
          if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ ok: false, kind: 'output_limit' });
          if (e.killed || e.signal) return resolve({ ok: false, kind: 'timeout' });
          if (typeof e.code === 'number') return resolve({ ok: false, kind: 'exit', exitCode: e.code });
          return resolve({ ok: false, kind: 'error' });
        },
      );
    } catch {
      resolve({ ok: false, kind: 'error' });
    }
  });

/** Environment variables Git needs to run locally. Everything else (GIT_*, EDITOR, PAGER, SSH_*, tokens...) is dropped. */
const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
]);

/** The exact environment given to git: the allowlist plus constants that isolate it from outside influence. */
export function buildGitEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1', // no system config
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE, // no user config (replaces ~/.gitconfig and the XDG file)
    GIT_ATTR_NOSYSTEM: '1', // no system attributes
    GIT_NO_REPLACE_OBJECTS: '1', // refs/replace/* cannot change what a commit or tree is
    GIT_OPTIONAL_LOCKS: '0', // reading never refreshes .git/index
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  };
}

/** Options placed before every subcommand: no locks, no fsmonitor hook. */
const GLOBAL_OPTIONS: readonly string[] = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

// ---------------------------------------------------------------- result types

export interface GitRepositorySummary {
  /** real, resolved working-tree root as Git reports it */
  readonly root: string;
  readonly gitDir: string;
  /** shared by all worktrees of one repository */
  readonly commonDir: string;
  readonly objectFormat: GitObjectFormat;
  readonly linkedWorktree: boolean;
  readonly detachedHead: boolean;
  /** true when the requested path was below the root (a nested directory) */
  readonly requestedBelowRoot: boolean;
}

export interface WorkingTreeCounts {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly deleted: number;
  readonly renamed: number;
  readonly unmerged: number;
  readonly submodule: number;
}

export interface GitSnapshot {
  readonly repository: GitRepositorySummary;
  readonly commit: string;
  readonly tree: string;
  /** `sha256:<64 hex>`, see the file header */
  readonly contentDigest: string;
  readonly entryCount: number;
}

export interface CollectorIncomplete {
  readonly outcome: 'incomplete';
  readonly code: CollectorCode;
  /** fixed text: never file contents, paths inside the repository, or diffs */
  readonly message: string;
  /** only for working_tree_dirty: how many entries of each kind (no names) */
  readonly workingTree?: WorkingTreeCounts;
  readonly authorization: 'not_evaluated';
}

export interface SnapshotRequest {
  /** a directory inside the repository, from a TRUSTED runner. Not evidence by itself. */
  readonly repositoryPath: string;
  /** pin the working-tree root: the repository found must have exactly this real root */
  readonly expectedRoot?: string;
  readonly timeoutMs?: number;
  /** replaces the real git runner (tests) */
  readonly runner?: GitRunner;
}

export type GitSnapshotResult = { readonly outcome: 'collected'; readonly snapshot: GitSnapshot; readonly authorization: 'not_evaluated' } | CollectorIncomplete;

const incomplete = (code: CollectorCode, workingTree?: WorkingTreeCounts): CollectorIncomplete => ({
  outcome: 'incomplete',
  code,
  message: MESSAGES[code],
  ...(workingTree ? { workingTree } : {}),
  authorization: 'not_evaluated',
});

// ---------------------------------------------------------------- the canonical digest

export interface SnapshotEntry {
  readonly mode: string;
  readonly type: 'blob';
  readonly oid: string;
  /** raw path bytes */
  readonly path: Uint8Array;
}

/**
 * The canonical snapshot digest (see the file header for the exact byte layout). Pure. The entries
 * are sorted here, so the result does not depend on the order they are supplied in.
 */
export function computeSnapshotDigest(input: { readonly objectFormat: GitObjectFormat; readonly commit: string; readonly tree: string; readonly entries: readonly SnapshotEntry[] }): string {
  const entries = [...input.entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const parts: Buffer[] = [
    Buffer.from(`${GIT_SNAPSHOT_DIGEST_DOMAIN}\nobject-format:${input.objectFormat}\ncommit:${input.commit}\ntree:${input.tree}\nentries:${entries.length}\n`, 'ascii'),
  ];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.type} ${e.oid}\t${e.path.length}:`, 'ascii'), Buffer.from(e.path), Buffer.from('\n', 'ascii'));
  }
  return `sha256:${createHash('sha256').update(Buffer.concat(parts)).digest('hex')}`;
}

// ---------------------------------------------------------------- git helpers

class Stop extends Error {
  constructor(readonly result: CollectorIncomplete) {
    super(result.code);
  }
}

interface Session {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly run: GitRunner;
}

/** Runs one read-only git command; any failure stops the collection with a safe reason. */
async function git(s: Session, args: readonly string[], maxOutputBytes = MAX_SMALL_OUTPUT_BYTES, opts: { exitMeans?: CollectorCode; allowExit?: readonly number[] } = {}): Promise<Buffer | { exit: number }> {
  const r = await s.run([...GLOBAL_OPTIONS, ...args], { cwd: s.cwd, env: s.env, timeoutMs: s.timeoutMs, maxOutputBytes });
  if (r.ok) return r.stdout;
  if (r.kind === 'unavailable') throw new Stop(incomplete('git_unavailable'));
  if (r.kind === 'timeout') throw new Stop(incomplete('git_timeout'));
  if (r.kind === 'output_limit') throw new Stop(incomplete('git_output_too_large'));
  if (r.kind === 'exit' && r.exitCode !== undefined && opts.allowExit?.includes(r.exitCode)) return { exit: r.exitCode };
  if (r.kind === 'exit' && r.exitCode === 128 && opts.exitMeans) throw new Stop(incomplete(opts.exitMeans));
  throw new Stop(incomplete('git_command_failed'));
}

const text = (b: Buffer | { exit: number }): string => (Buffer.isBuffer(b) ? b.toString('utf-8').trim() : '');

/** Output split into trimmed lines, without the empty line a trailing newline leaves behind. */
const lines = (b: Buffer): string[] => b.toString('utf-8').split(/\r?\n/).map((l) => l.trim()).filter((l, i, all) => l !== '' || i < all.length - 1);

async function realPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Repository-local config that would make git run a program for `status`, or hide files from it. */
function unsafeConfig(listing: Buffer): boolean {
  for (const entry of listing.toString('utf-8').split('\0')) {
    if (entry === '') continue;
    const nl = entry.indexOf('\n');
    const key = (nl === -1 ? entry : entry.slice(0, nl)).toLowerCase();
    const value = nl === -1 ? '' : entry.slice(nl + 1).toLowerCase();
    if (/^filter\..+\.(clean|smudge|process)$/.test(key)) return true;
    if (key === 'core.sparsecheckout' && value !== 'false' && value !== 'no' && value !== 'off' && value !== '0') return true;
  }
  return false;
}

/** Counts the entries of `git status --porcelain=v2 -z`. Returns undefined for output it cannot interpret. */
function parseStatus(out: Buffer): WorkingTreeCounts | undefined {
  const c = { staged: 0, unstaged: 0, untracked: 0, deleted: 0, renamed: 0, unmerged: 0, submodule: 0 };
  const tokens = out.toString('utf-8').split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === '') continue;
    const kind = t.slice(0, 2);
    if (kind === '? ') {
      c.untracked++;
    } else if (kind === 'u ') {
      c.unmerged++;
    } else if (kind === '1 ' || kind === '2 ') {
      const fields = t.split(' ');
      const xy = fields[1] ?? '';
      if (xy.length !== 2) return undefined;
      if (xy[0] !== '.') c.staged++;
      if (xy[1] !== '.') c.unstaged++;
      if (xy.includes('D')) c.deleted++;
      if (fields[2]?.startsWith('S')) c.submodule++;
      if (kind === '2 ') {
        c.renamed++;
        i++; // a rename carries the original path as the next token
      }
    } else {
      return undefined;
    }
  }
  return c;
}

const isClean = (c: WorkingTreeCounts): boolean => Object.values(c).every((n) => n === 0);

function validateRequest(req: SnapshotRequest): CollectorIncomplete | undefined {
  if (typeof req !== 'object' || req === null) return incomplete('invalid_request');
  const p = req.repositoryPath;
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_REPOSITORY_PATH_CHARS || p.includes('\0') || !path.isAbsolute(p)) return incomplete('path_invalid');
  if (req.expectedRoot !== undefined && (typeof req.expectedRoot !== 'string' || !path.isAbsolute(req.expectedRoot) || req.expectedRoot.includes('\0'))) return incomplete('invalid_request');
  const t = req.timeoutMs;
  if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_GIT_TIMEOUT_MS)) return incomplete('invalid_request');
  if (req.runner !== undefined && typeof req.runner !== 'function') return incomplete('invalid_request');
  return undefined;
}

// ---------------------------------------------------------------- collection

/**
 * Observes the repository and returns a clean, supported HEAD snapshot, or says why it could not.
 * Never throws. Read-only. See the file header for what is and is not established.
 */
export async function collectGitSnapshot(request: SnapshotRequest): Promise<GitSnapshotResult> {
  try {
    const invalid = validateRequest(request);
    if (invalid) return invalid;
    return await collectUnchecked(request);
  } catch (err) {
    return err instanceof Stop ? err.result : incomplete('git_command_failed');
  }
}

async function collectUnchecked(request: SnapshotRequest): Promise<GitSnapshotResult> {
  let cwd: string;
  try {
    const stat = await fs.stat(request.repositoryPath);
    if (!stat.isDirectory()) return incomplete('not_a_directory');
    cwd = await fs.realpath(request.repositoryPath);
  } catch {
    return incomplete('path_invalid');
  }
  const s: Session = { cwd, env: buildGitEnvironment(), timeoutMs: request.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, run: request.runner ?? realGitRunner };

  // 1. the repository: what it is and whether it is a supported shape. The first command also shows
  // whether git can run at all (an unavailable git is reported as such). Few commands on purpose:
  // each one is a process, and the collector runs twice around every finalization.
  const shape = (await git(s, ['rev-parse', '--is-bare-repository', '--is-inside-work-tree'], MAX_SMALL_OUTPUT_BYTES, { exitMeans: 'repository_unusable' })) as Buffer;
  const [bare, insideWorkTree] = lines(shape);
  if (bare === 'true') return incomplete('bare_repository_unsupported');
  if (bare !== 'false') return incomplete('repository_unusable');
  if (insideWorkTree !== 'true') return incomplete('not_in_work_tree');

  // the details come back as one line each, in the order asked; the superproject line is LAST because
  // it prints nothing at all for an ordinary repository
  const details = (await git(s, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir', '--show-object-format', '--show-superproject-working-tree'])) as Buffer;
  const [rootText, gitDirText, commonText, format, superproject] = lines(details);
  if (!rootText || !gitDirText || !commonText) return incomplete('repository_unusable');
  if (format !== 'sha1' && format !== 'sha256') return incomplete('unsupported_object_format');
  if (superproject !== undefined && superproject !== '') return incomplete('submodule_repository_unsupported');

  const root = await realPath(rootText);
  const gitDir = await realPath(gitDirText);
  const commonDir = await realPath(commonText);
  if (request.expectedRoot !== undefined && !samePath(root, await realPath(request.expectedRoot))) return incomplete('repository_mismatch');

  // 2. repository-local configuration that would make `git status` run a program, or hide files
  if (unsafeConfig(await git(s, ['config', '--list', '-z'], MAX_SMALL_OUTPUT_BYTES * 4) as Buffer)) return incomplete('unsafe_repository_configuration');

  // 3. HEAD, resolved ONCE to a commit id; everything later reads that id, never the moving name "HEAD"
  const headOut = await git(s, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], MAX_SMALL_OUTPUT_BYTES, { allowExit: [1] });
  const commit = text(headOut);
  if (!Buffer.isBuffer(headOut) || commit === '') {
    // no HEAD commit: an empty repository, or an unreadable HEAD. Both block; say which when we can.
    const probe = await git(s, ['rev-parse', '--verify', '-q', 'HEAD'], MAX_SMALL_OUTPUT_BYTES, { allowExit: [1] });
    return incomplete(Buffer.isBuffer(probe) ? 'head_unreadable' : 'no_commits');
  }
  if (!OID.test(commit) || commit.length !== (format === 'sha1' ? 40 : 64)) return incomplete('head_unreadable');
  const symbolic = await git(s, ['symbolic-ref', '-q', 'HEAD'], MAX_SMALL_OUTPUT_BYTES, { allowExit: [1] });
  const detachedHead = !Buffer.isBuffer(symbolic);

  // 4. nothing may hide a change from `git status`: no assume-unchanged / skip-worktree flags
  const flags = (await git(s, ['ls-files', '-v', '-z'], MAX_LISTING_OUTPUT_BYTES)) as Buffer;
  for (const entry of flags.toString('utf-8').split('\0')) {
    // H = ordinary tracked file. M = unmerged: not a hiding flag, and the status check below reports it as dirty.
    if (entry !== '' && !entry.startsWith('H ') && !entry.startsWith('M ')) return incomplete('index_flags_unsupported');
  }

  // 5. the working tree must be clean. Truncated output was already refused above, so empty means empty.
  const counts = await readStatus(s);
  if (!isClean(counts)) return incomplete('working_tree_dirty', counts);

  // 6. the HEAD snapshot: tree id and the full recursive listing of THIS commit
  const tree = text(await git(s, ['rev-parse', '--verify', `${commit}^{tree}`], MAX_SMALL_OUTPUT_BYTES, { exitMeans: 'tree_unreadable' }));
  if (!OID.test(tree) || tree.length !== commit.length) return incomplete('tree_unreadable');
  const listing = (await git(s, ['ls-tree', '-r', '-z', '--full-tree', commit], MAX_LISTING_OUTPUT_BYTES)) as Buffer;
  const parsed = parseTree(listing, commit.length);
  if ('code' in parsed) return incomplete(parsed.code);
  const contentDigest = computeSnapshotDigest({ objectFormat: format, commit, tree, entries: parsed.entries });

  // 7. nothing may have moved while we looked
  const again = text(await git(s, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], MAX_SMALL_OUTPUT_BYTES, { allowExit: [1] }));
  if (again !== commit) return incomplete('changed_during_collection');
  if (!isClean(await readStatus(s))) return incomplete('changed_during_collection');

  return {
    outcome: 'collected',
    snapshot: Object.freeze({
      repository: Object.freeze({ root, gitDir, commonDir, objectFormat: format, linkedWorktree: !samePath(gitDir, commonDir), detachedHead, requestedBelowRoot: !samePath(cwd, root) }),
      commit,
      tree,
      contentDigest,
      entryCount: parsed.entries.length,
    }),
    authorization: 'not_evaluated',
  };
}

async function readStatus(s: Session): Promise<WorkingTreeCounts> {
  const out = (await git(s, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none', '--renames'], MAX_STATUS_OUTPUT_BYTES)) as Buffer;
  const counts = parseStatus(out);
  if (!counts) throw new Stop(incomplete('status_unparseable'));
  return counts;
}

function parseTree(listing: Buffer, oidLength: number): { entries: SnapshotEntry[] } | { code: CollectorCode } {
  const entries: SnapshotEntry[] = [];
  let start = 0;
  while (start < listing.length) {
    const end = listing.indexOf(0, start);
    if (end === -1) return { code: 'tree_unparseable' }; // an entry without its terminator: the output was cut short
    const record = listing.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(9);
    if (tab === -1) return { code: 'tree_unparseable' };
    const header = record.subarray(0, tab).toString('ascii');
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]+)$/.exec(header);
    if (!match || (match[3] as string).length !== oidLength) return { code: 'tree_unparseable' };
    if (match[2] === 'commit') return { code: 'submodules_unsupported' };
    entries.push({ mode: match[1] as string, type: 'blob', oid: match[3] as string, path: Uint8Array.from(record.subarray(tab + 1)) });
  }
  return { entries };
}

// ---------------------------------------------------------------- action context

/** Action metadata supplied by the TRUSTED CALLER. The collector does not verify any of it. */
export interface ActionMetadata {
  readonly actionId: string;
  readonly actionType: ActionContext['actionType'];
  readonly environment: ActionContext['environment'];
  readonly target: string;
}

export const EXTERNALLY_SUPPLIED_FIELDS = ['actionId', 'actionType', 'environment', 'target'] as const;
export const OBSERVED_FIELDS = ['commit', 'contentDigest'] as const;

export interface ContextRequest extends SnapshotRequest {
  readonly metadata: ActionMetadata;
}

export interface CollectedActionContext {
  readonly outcome: 'collected';
  /** valid for proof.ts: commit and contentDigest are OBSERVED, the rest is supplied */
  readonly context: ActionContext;
  readonly git: GitSnapshot;
  /** which context fields came from the caller and were not verified by this collector */
  readonly externallySupplied: readonly (typeof EXTERNALLY_SUPPLIED_FIELDS)[number][];
  /** which context fields this collector observed itself */
  readonly observed: readonly (typeof OBSERVED_FIELDS)[number][];
  /** metadata fields the caller passed that are not accepted (e.g. a claimed commit or digest); they were ignored */
  readonly ignoredMetadataFields: readonly string[];
  /** this is an observation, not an authorization */
  readonly authorization: 'not_evaluated';
}

export type ActionContextResult = CollectedActionContext | CollectorIncomplete;

const collected = new WeakSet<object>();
const origins = new WeakMap<object, { readonly request: ContextRequest; readonly metadata: ActionMetadata }>();
/** True only for a result produced by collectActionContext / recheck. A hand-built context is not one. */
export const isCollectedActionContext = (x: unknown): x is CollectedActionContext => typeof x === 'object' && x !== null && collected.has(x);

/** Action types whose context a Git HEAD snapshot may stand for. */
export const SNAPSHOT_BOUND_ACTIONS: readonly ActionContext['actionType'][] = Object.freeze(['code_change', 'deployment']);

const PLACEHOLDER_COMMIT = 'a'.repeat(40);
const PLACEHOLDER_DIGEST = `sha256:${'0'.repeat(64)}`;

/** Validates the metadata with the existing action-context parser, before any git process is started. */
function checkMetadata(meta: unknown): { metadata: ActionMetadata; ignored: string[] } | CollectorIncomplete {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return incomplete('invalid_action_metadata');
  const m = meta as Record<string, unknown>;
  const allowed: ReadonlySet<string> = new Set(EXTERNALLY_SUPPLIED_FIELDS);
  const ignored = Object.keys(m).filter((k) => !allowed.has(k)).sort();
  // placeholders only prove the four supplied fields are well formed; they are never used as values
  const parsed = parseActionContext({ actionId: m.actionId, actionType: m.actionType, environment: m.environment, target: m.target, commit: PLACEHOLDER_COMMIT, contentDigest: PLACEHOLDER_DIGEST });
  if (!parsed.ok) return incomplete('invalid_action_metadata');
  const c = parsed.context;
  return { metadata: Object.freeze({ actionId: c.actionId, actionType: c.actionType, environment: c.environment, target: c.target }), ignored };
}

/**
 * Collects the Git state and combines it with the caller's action metadata into an `ActionContext`.
 * Only `code_change` and `deployment` are supported (see SNAPSHOT_BOUND_ACTIONS): for any other action
 * type the Git snapshot cannot stand for the artifact, so the result is `incomplete`. Any `commit` or `contentDigest` in the metadata is ignored
 * and reported; the values come from Git. Never throws.
 */
export async function collectActionContext(request: ContextRequest): Promise<ActionContextResult> {
  try {
    const invalid = validateRequest(request);
    if (invalid) return invalid;
    const checked = checkMetadata(request.metadata);
    if ('outcome' in checked) return checked;
    if (!SNAPSHOT_BOUND_ACTIONS.includes(checked.metadata.actionType)) return incomplete('non_git_artifact_binding_unavailable');

    const snap = await collectGitSnapshot(request);
    if (snap.outcome !== 'collected') return snap;
    return build(request, checked.metadata, snap.snapshot, checked.ignored);
  } catch {
    return incomplete('git_command_failed');
  }
}

function build(request: ContextRequest, metadata: ActionMetadata, git: GitSnapshot, ignored: readonly string[]): ActionContextResult {
  const parsed = parseActionContext({ ...metadata, commit: git.commit, contentDigest: git.contentDigest });
  if (!parsed.ok) return incomplete('invalid_action_metadata');
  const result: CollectedActionContext = Object.freeze({
    outcome: 'collected' as const,
    context: parsed.context,
    git,
    externallySupplied: EXTERNALLY_SUPPLIED_FIELDS,
    observed: OBSERVED_FIELDS,
    ignoredMetadataFields: Object.freeze([...ignored]),
    authorization: 'not_evaluated' as const,
  });
  collected.add(result);
  origins.set(result, { request: Object.freeze({ ...request }), metadata });
  return result;
}

// ---------------------------------------------------------------- recheck

export type ChangedField = 'repository' | 'commit' | 'tree' | 'contentDigest' | 'entryCount' | 'objectFormat' | 'actionId' | 'actionType' | 'environment' | 'target' | 'workingTree' | 'metadata';

export type RecheckResult =
  | { readonly outcome: 'unchanged'; readonly current: CollectedActionContext; readonly authorization: 'not_evaluated' }
  | { readonly outcome: 'changed'; readonly changed: readonly ChangedField[]; readonly current?: CollectedActionContext; readonly authorization: 'not_evaluated' }
  | CollectorIncomplete;

export interface RecheckOptions {
  /** if given, must equal the metadata of the previous collection; a difference is a change */
  readonly metadata?: ActionMetadata;
  /** replaces the runner used for the first collection (tests) */
  readonly runner?: GitRunner;
}

/**
 * Re-observes the SAME repository (same path, same pinned root, same metadata as the previous
 * collection) and compares every security-relevant field exactly: repository identity, object format,
 * commit, tree, content digest, entry count and the four action fields. A dirty tree is a change.
 * A failed second collection is `incomplete`, never `unchanged`. Read-only; never throws.
 *
 * A recheck narrows the window for a change, it cannot close it: anything changed AFTER the recheck
 * is invisible to it. The protected executor must verify the deployed artifact itself.
 */
export async function recheckActionContext(previous: CollectedActionContext, options: RecheckOptions = {}): Promise<RecheckResult> {
  try {
    const origin = isCollectedActionContext(previous) ? origins.get(previous) : undefined;
    if (!origin) return incomplete('previous_not_genuine');

    const changed: ChangedField[] = [];
    if (options.metadata !== undefined) {
      const given = checkMetadata(options.metadata);
      if ('outcome' in given) return given;
      const before = origin.metadata;
      const m = given.metadata;
      for (const f of EXTERNALLY_SUPPLIED_FIELDS) if (m[f] !== before[f]) changed.push(f);
      if (changed.length > 0) return { outcome: 'changed', changed, authorization: 'not_evaluated' };
    }

    const again = await collectGitSnapshot({
      repositoryPath: origin.request.repositoryPath,
      expectedRoot: previous.git.repository.root, // the same repository, pinned: never a different one
      ...(origin.request.timeoutMs !== undefined ? { timeoutMs: origin.request.timeoutMs } : {}),
      ...((options.runner ?? origin.request.runner) ? { runner: (options.runner ?? origin.request.runner) as GitRunner } : {}),
    });
    if (again.outcome !== 'collected') {
      if (again.code === 'working_tree_dirty') return { outcome: 'changed', changed: ['workingTree'], authorization: 'not_evaluated' };
      if (again.code === 'repository_mismatch') return { outcome: 'changed', changed: ['repository'], authorization: 'not_evaluated' };
      return again;
    }

    const a = previous.git;
    const b = again.snapshot;
    if (!samePath(a.repository.root, b.repository.root) || !samePath(a.repository.gitDir, b.repository.gitDir) || !samePath(a.repository.commonDir, b.repository.commonDir)) changed.push('repository');
    if (a.repository.objectFormat !== b.repository.objectFormat) changed.push('objectFormat');
    if (a.commit !== b.commit) changed.push('commit');
    if (a.tree !== b.tree) changed.push('tree');
    if (a.contentDigest !== b.contentDigest) changed.push('contentDigest');
    if (a.entryCount !== b.entryCount) changed.push('entryCount');

    // the action fields are the same metadata as before; commit and digest were compared through the snapshot above
    const rebuilt = build({ ...origin.request }, origin.metadata, b, []);
    if (rebuilt.outcome !== 'collected') return rebuilt;
    if (changed.length > 0) return { outcome: 'changed', changed, current: rebuilt, authorization: 'not_evaluated' };
    return { outcome: 'unchanged', current: rebuilt, authorization: 'not_evaluated' };
  } catch {
    return incomplete('git_command_failed');
  }
}
