// Tests for the trusted Git action-context collector.
//
// Real Git is used on disposable repositories created ONLY inside a test-owned temporary directory; the
// CodeXRev repository itself is never touched. Fake runners cover failures that cannot be provoked
// reliably (git missing, timeouts). Nothing here needs administrator rights.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeContentDigest, parseActionContext } from '../../../../src/features/action-safety/authorization/proof.js';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  GIT_NULL_DEVICE,
  GIT_SNAPSHOT_DIGEST_DOMAIN,
  MAX_GIT_TIMEOUT_MS,
  buildGitEnvironment,
  collectActionContext,
  collectGitSnapshot,
  computeSnapshotDigest,
  isCollectedActionContext,
  realGitRunner,
  recheckActionContext,
  type ActionContextResult,
  type ActionMetadata,
  type CollectedActionContext,
  type GitRunResult,
  type GitRunner,
  type SnapshotEntry,
} from '../../../../src/features/action-safety/authorization/actionContextCollector.js';

// ---------------------------------------------------------------- disposable repositories

/** Independent of the code under test: the "no file" path that works with Git on every platform. */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

let base: string;
let counter = 0;

/** Git for TEST SETUP: isolated from the developer's own configuration so every machine behaves alike. */
function g(dir: string, ...args: string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('GIT_')) env[k] = v;
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'protocol.file.allow=always', ...args], {
    cwd: dir,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(dir: string, files: Record<string, string | Buffer>): void {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function commit(dir: string, files: Record<string, string | Buffer>, message = 'change'): void {
  write(dir, files);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', message);
}

interface RepoOptions {
  objectFormat?: 'sha1' | 'sha256';
  name?: string;
  files?: Record<string, string | Buffer>;
  empty?: boolean;
}

const DEFAULT_FILES = { 'README.md': 'hello\n', 'src/app.ts': 'export const a = 1;\n', 'docs/guide.md': 'guide\n' };
/** A finished default repository, built once and copied: copying is far cheaper than running git again for every test. */
let template: string;

function makeRepo(o: RepoOptions = {}): string {
  const dir = path.join(base, o.name ?? `repo-${++counter}`);
  if (!o.files && !o.empty && o.objectFormat === undefined && template) {
    fs.cpSync(template, dir, { recursive: true });
    g(dir, 'status', '--porcelain'); // one refresh, so the copied index matches this directory and later reads have nothing to update
    return dir;
  }
  fs.mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q', ...(o.objectFormat === 'sha256' ? ['--object-format=sha256'] : []), '-b', 'main');
  if (!o.empty) {
    commit(dir, o.files ?? DEFAULT_FILES, 'initial');
    g(dir, 'status', '--porcelain'); // let git settle the index so later reads have nothing to refresh
  }
  return dir;
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'codexrev-actionctx-test-')));
  template = makeRepo({ name: 'template' });
}, 120_000);
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const META: ActionMetadata = { actionId: 'act-code-1', actionType: 'code_change', environment: 'development', target: 'payments-service' };
const ctx = (repositoryPath: string, over: Record<string, unknown> = {}, metadata: unknown = META) => collectActionContext({ repositoryPath, metadata: metadata as ActionMetadata, ...over });
const must = (r: ActionContextResult): CollectedActionContext => {
  if (r.outcome !== 'collected') throw new Error(`expected collected, got ${r.code}`);
  return r;
};
const codeOf = (r: { outcome: string; code?: string }): string | undefined => (r.outcome === 'incomplete' ? r.code : undefined);

/** A runner that records every git invocation and delegates to the real git. */
function spyRunner(): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, runner: async (args, options) => (calls.push([...args]), realGitRunner(args, options)) };
}

/** The subcommand of one recorded invocation, skipping the global options the collector always adds. */
function subcommand(args: readonly string[]): string {
  const a = [...args];
  while (a.length > 0) {
    if (a[0] === '-c') a.splice(0, 2);
    else if (a[0]?.startsWith('--no-optional-locks')) a.shift();
    else break;
  }
  return a[0] ?? '';
}

const fake = (fn: (args: readonly string[]) => GitRunResult | undefined): GitRunner => async (args, options) => fn(args) ?? realGitRunner(args, options);

const DIGEST = /^sha256:[0-9a-f]{64}$/;

// real git is slow to spawn on some hosts: allow generous time
const T = 60_000;

// ================================================================ repository states

describe('repository states', () => {
  it('collects a clean repository: the commit, tree and digest come from Git', { timeout: T }, async () => {
    const dir = makeRepo();
    const r = await collectGitSnapshot({ repositoryPath: dir });
    expect(r.outcome).toBe('collected');
    if (r.outcome !== 'collected') return;
    const s = r.snapshot;
    expect(s.commit).toBe(g(dir, 'rev-parse', 'HEAD').trim());
    expect(s.tree).toBe(g(dir, 'rev-parse', 'HEAD^{tree}').trim());
    expect(s.contentDigest).toMatch(DIGEST);
    expect(s.entryCount).toBe(3);
    expect(s.repository).toMatchObject({ objectFormat: 'sha1', linkedWorktree: false, detachedHead: false, requestedBelowRoot: false });
    expect(s.repository.root).toBe(fs.realpathSync(dir));
    expect(r.authorization).toBe('not_evaluated');
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('works from a nested working directory and finds the same repository and digest', { timeout: T }, async () => {
    const dir = makeRepo();
    const top = await collectGitSnapshot({ repositoryPath: dir });
    const nested = await collectGitSnapshot({ repositoryPath: path.join(dir, 'src') });
    if (top.outcome !== 'collected' || nested.outcome !== 'collected') throw new Error('setup');
    expect(nested.snapshot.repository.requestedBelowRoot).toBe(true);
    expect(nested.snapshot.repository.root).toBe(top.snapshot.repository.root);
    expect(nested.snapshot.contentDigest).toBe(top.snapshot.contentDigest);
  });

  it('supports a detached HEAD', { timeout: T }, async () => {
    const dir = makeRepo();
    commit(dir, { 'second.txt': 'two\n' });
    g(dir, 'checkout', '-q', '--detach', 'HEAD~1');
    g(dir, 'status', '--porcelain');
    const r = await collectGitSnapshot({ repositoryPath: dir });
    expect(r.outcome).toBe('collected');
    if (r.outcome === 'collected') {
      expect(r.snapshot.repository.detachedHead).toBe(true);
      expect(r.snapshot.commit).toBe(g(dir, 'rev-parse', 'HEAD').trim());
    }
  });

  it('refuses a directory that is not a repository, without falling back to anything else', { timeout: T }, async () => {
    const plain = path.join(base, 'plain-dir');
    fs.mkdirSync(plain);
    expect(codeOf(await collectGitSnapshot({ repositoryPath: plain }))).toBe('repository_unusable');
  });

  it('refuses a missing path, a file, and a relative path', { timeout: T }, async () => {
    const dir = makeRepo();
    expect(codeOf(await collectGitSnapshot({ repositoryPath: path.join(base, 'does-not-exist') }))).toBe('path_invalid');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: path.join(dir, 'README.md') }))).toBe('not_a_directory');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: 'relative/repo' }))).toBe('path_invalid');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: '' }))).toBe('path_invalid');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: `${dir}\0` }))).toBe('path_invalid');
  });

  it('refuses a repository with no commits: there is no HEAD to bind', { timeout: T }, async () => {
    const dir = makeRepo({ empty: true });
    expect(codeOf(await collectGitSnapshot({ repositoryPath: dir }))).toBe('no_commits');
  });

  it('refuses a bare repository', { timeout: T }, async () => {
    const dir = path.join(base, 'bare.git');
    fs.mkdirSync(dir);
    g(dir, 'init', '-q', '--bare');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: dir }))).toBe('bare_repository_unsupported');
  });

  it('refuses a path inside the .git directory (not a working tree)', { timeout: T }, async () => {
    const dir = makeRepo();
    expect(codeOf(await collectGitSnapshot({ repositoryPath: path.join(dir, '.git') }))).toBe('not_in_work_tree');
  });

  it('supports a linked worktree and identifies its repository by the shared common directory', { timeout: T }, async () => {
    const dir = makeRepo();
    const wt = path.join(base, `wt-${++counter}`);
    g(dir, 'worktree', 'add', '-q', '-b', 'feature', wt);
    g(wt, 'status', '--porcelain');
    const main = await collectGitSnapshot({ repositoryPath: dir });
    const linked = await collectGitSnapshot({ repositoryPath: wt });
    if (main.outcome !== 'collected' || linked.outcome !== 'collected') throw new Error(`setup: ${JSON.stringify([main, linked])}`);
    expect(linked.snapshot.repository.linkedWorktree).toBe(true);
    expect(linked.snapshot.repository.root).toBe(fs.realpathSync(wt));
    expect(linked.snapshot.repository.commonDir).toBe(main.snapshot.repository.commonDir);
    expect(linked.snapshot.repository.gitDir).not.toBe(linked.snapshot.repository.commonDir);
    expect(linked.snapshot.contentDigest).toBe(main.snapshot.contentDigest); // same commit, same tree, same files
  });

  it('fails closed on submodules: a tree containing one, and a repository that is one', { timeout: T }, async () => {
    const lib = makeRepo({ name: 'lib-repo', files: { 'lib.txt': 'library\n' } });
    const superDir = makeRepo({ name: 'super-repo' });
    g(superDir, 'submodule', 'add', '-q', lib, 'vendor/lib');
    g(superDir, 'commit', '-q', '-m', 'add submodule');
    g(superDir, 'status', '--porcelain');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: superDir }))).toBe('submodules_unsupported');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: path.join(superDir, 'vendor', 'lib') }))).toBe('submodule_repository_unsupported');
  });

  it('a submodule that changed is not clean either', { timeout: T }, async () => {
    const lib = makeRepo({ name: 'lib2-repo', files: { 'lib.txt': 'library\n' } });
    const superDir = makeRepo({ name: 'super2-repo' });
    g(superDir, 'submodule', 'add', '-q', lib, 'vendor/lib');
    g(superDir, 'commit', '-q', '-m', 'add submodule');
    write(path.join(superDir, 'vendor', 'lib'), { 'lib.txt': 'changed library\n' });
    const r = await collectGitSnapshot({ repositoryPath: superDir });
    expect(r.outcome).toBe('incomplete');
  });

  it('git unavailable and git failures are incomplete, with their own codes', async () => {
    const dir = makeRepo();
    const none = await collectGitSnapshot({ repositoryPath: dir, runner: async () => ({ ok: false, kind: 'unavailable' }) });
    expect(codeOf(none)).toBe('git_unavailable');
    const failing = await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('status') ? { ok: false, kind: 'exit', exitCode: 1 } : undefined)) });
    expect(codeOf(failing)).toBe('git_command_failed');
    const crash = await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('ls-tree') ? { ok: false, kind: 'error' } : undefined)) });
    expect(codeOf(crash)).toBe('git_command_failed');
    const threw = await collectGitSnapshot({ repositoryPath: dir, runner: async () => { throw new Error('SECRET runner failure'); } });
    expect(threw.outcome).toBe('incomplete');
    expect(JSON.stringify(threw)).not.toContain('SECRET');
  });

  it('a repository it cannot read reports as unusable (git exit 128), not as clean', async () => {
    const dir = makeRepo();
    const r = await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('--is-bare-repository') ? { ok: false, kind: 'exit', exitCode: 128 } : undefined)) });
    expect(codeOf(r)).toBe('repository_unusable');
  });

  it('pins the repository: a different root than expected is refused', { timeout: T }, async () => {
    const a = makeRepo();
    const b = makeRepo();
    expect((await collectGitSnapshot({ repositoryPath: a, expectedRoot: a })).outcome).toBe('collected');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: a, expectedRoot: b }))).toBe('repository_mismatch');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: a, expectedRoot: 'relative' }))).toBe('invalid_request');
  });
});

// ================================================================ cleanliness

describe('the working tree must be clean', () => {
  const dirtyCase = async (mutate: (dir: string) => void) => {
    const dir = makeRepo();
    mutate(dir);
    return collectGitSnapshot({ repositoryPath: dir });
  };

  it('refuses a staged modification', { timeout: T }, async () => {
    const r = await dirtyCase((d) => { write(d, { 'README.md': 'staged change\n' }); g(d, 'add', 'README.md'); });
    expect(r).toMatchObject({ outcome: 'incomplete', code: 'working_tree_dirty', workingTree: { staged: 1 } });
  });

  it('refuses an unstaged modification', { timeout: T }, async () => {
    const r = await dirtyCase((d) => write(d, { 'README.md': 'unstaged change\n' }));
    expect(r).toMatchObject({ outcome: 'incomplete', code: 'working_tree_dirty', workingTree: { unstaged: 1, staged: 0 } });
  });

  it('refuses an untracked file: it is never silently ignored', { timeout: T }, async () => {
    const r = await dirtyCase((d) => write(d, { 'new-file.txt': 'new\n' }));
    expect(r).toMatchObject({ outcome: 'incomplete', code: 'working_tree_dirty', workingTree: { untracked: 1 } });
  });

  it('refuses an untracked file deep in a new directory', { timeout: T }, async () => {
    const r = await dirtyCase((d) => write(d, { 'a/b/c/deep.txt': 'deep\n' }));
    expect(r).toMatchObject({ code: 'working_tree_dirty', workingTree: { untracked: 1 } });
  });

  it('refuses a deleted file', { timeout: T }, async () => {
    const r = await dirtyCase((d) => fs.rmSync(path.join(d, 'README.md')));
    expect(r).toMatchObject({ code: 'working_tree_dirty', workingTree: { deleted: 1 } });
  });

  it('refuses a renamed file', { timeout: T }, async () => {
    const r = await dirtyCase((d) => g(d, 'mv', 'README.md', 'RENAMED.md'));
    expect(r).toMatchObject({ code: 'working_tree_dirty', workingTree: { renamed: 1, staged: 1 } });
  });

  it('refuses unmerged (conflicted) paths', { timeout: T }, async () => {
    const dir = makeRepo();
    g(dir, 'checkout', '-q', '-b', 'side');
    commit(dir, { 'README.md': 'side\n' });
    g(dir, 'checkout', '-q', 'main');
    commit(dir, { 'README.md': 'main\n' });
    try {
      g(dir, 'merge', 'side');
    } catch {
      // the conflict is the point
    }
    const r = await collectGitSnapshot({ repositoryPath: dir });
    expect(r).toMatchObject({ outcome: 'incomplete', code: 'working_tree_dirty' });
    if (r.outcome === 'incomplete') expect(r.workingTree?.unmerged).toBeGreaterThan(0);
  });

  it('accepts a clean tree after committed changes, with a new commit', { timeout: T }, async () => {
    const dir = makeRepo();
    const before = await collectGitSnapshot({ repositoryPath: dir });
    commit(dir, { 'README.md': 'committed change\n' });
    g(dir, 'status', '--porcelain');
    const after = await collectGitSnapshot({ repositoryPath: dir });
    if (before.outcome !== 'collected' || after.outcome !== 'collected') throw new Error('setup');
    expect(after.snapshot.commit).not.toBe(before.snapshot.commit);
  });

  it('reports no file names or contents in a dirty result: only counts', { timeout: T }, async () => {
    const r = await dirtyCase((d) => write(d, { 'SECRET-NAME.txt': 'SECRET-CONTENT\n' }));
    const text = JSON.stringify(r);
    expect(text).not.toContain('SECRET-NAME');
    expect(text).not.toContain('SECRET-CONTENT');
    expect(r).toMatchObject({ workingTree: { untracked: 1 } });
  });

  it('LIMITATION: ignored files are neither reported nor hashed, so they cannot make the tree dirty', { timeout: T }, async () => {
    const dir = makeRepo();
    commit(dir, { '.gitignore': 'build/\n*.log\n' }, 'ignore rules');
    g(dir, 'status', '--porcelain');
    const before = await collectGitSnapshot({ repositoryPath: dir });
    write(dir, { 'build/output.bin': 'artifact', 'debug.log': 'log' });
    const after = await collectGitSnapshot({ repositoryPath: dir });
    expect(after.outcome).toBe('collected');
    if (before.outcome === 'collected' && after.outcome === 'collected') expect(after.snapshot.contentDigest).toBe(before.snapshot.contentDigest);
  });

  it('refuses index flags that would hide changes from git status (assume-unchanged, skip-worktree)', { timeout: T }, async () => {
    const a = makeRepo();
    g(a, 'update-index', '--assume-unchanged', 'README.md');
    write(a, { 'README.md': 'hidden change\n' });
    expect(codeOf(await collectGitSnapshot({ repositoryPath: a }))).toBe('index_flags_unsupported');
    const b = makeRepo();
    g(b, 'update-index', '--skip-worktree', 'README.md');
    write(b, { 'README.md': 'hidden change\n' });
    expect(codeOf(await collectGitSnapshot({ repositoryPath: b }))).toBe('index_flags_unsupported');
  });

  it('never treats truncated, failed or garbled status output as clean', async () => {
    const dir = makeRepo();
    const limited = await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('status') ? { ok: false, kind: 'output_limit' } : undefined)) });
    expect(codeOf(limited)).toBe('git_output_too_large');
    const timedOut = await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('status') ? { ok: false, kind: 'timeout' } : undefined)) });
    expect(codeOf(timedOut)).toBe('git_timeout');
    const garbled = await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('status') ? { ok: true, stdout: Buffer.from('garbage that is not porcelain v2') } : undefined)) });
    expect(codeOf(garbled)).toBe('status_unparseable');
    const sneaky = await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('status') ? { ok: true, stdout: Buffer.from('1 X') } : undefined)) });
    expect(sneaky.outcome).toBe('incomplete');
  });

  it('refuses a tree listing that was cut short', async () => {
    const dir = makeRepo();
    const r = await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('ls-tree') ? { ok: true, stdout: Buffer.from('100644 blob ' + 'a'.repeat(40) + '\tREAD') } : undefined)) });
    expect(codeOf(r)).toBe('tree_unparseable');
  });
});

// ================================================================ the digest

describe('the snapshot digest', () => {
  const oid = (c: string): string => c.repeat(40);
  const entry = (p: string | Buffer, mode = '100644', o = oid('a')): SnapshotEntry => ({ mode, type: 'blob', oid: o, path: Uint8Array.from(typeof p === 'string' ? Buffer.from(p, 'utf-8') : p) });
  const base1 = { objectFormat: 'sha1' as const, commit: oid('c'), tree: oid('d') };

  it('has the exact format proof.ts expects', () => {
    expect(computeSnapshotDigest({ ...base1, entries: [entry('a.txt')] })).toMatch(DIGEST);
    expect(parseActionContext({ actionId: 'a', actionType: 'code_change', environment: 'development', target: 't', commit: oid('c'), contentDigest: computeSnapshotDigest({ ...base1, entries: [] }) }).ok).toBe(true);
  });

  it('matches an independent computation of the documented byte layout', () => {
    const entries = [entry('b.txt', '100755', oid('b')), entry('a.txt')];
    const expected = createHash('sha256')
      .update(`${GIT_SNAPSHOT_DIGEST_DOMAIN}\nobject-format:sha1\ncommit:${oid('c')}\ntree:${oid('d')}\nentries:2\n`)
      .update(`100644 blob ${oid('a')}\t5:a.txt\n`)
      .update(`100755 blob ${oid('b')}\t5:b.txt\n`)
      .digest('hex');
    expect(computeSnapshotDigest({ ...base1, entries })).toBe(`sha256:${expected}`);
    expect(GIT_SNAPSHOT_DIGEST_DOMAIN).toBe('codexrev-git-snapshot-v1');
  });

  it('does not depend on the order entries are supplied in (sorted by raw path bytes)', () => {
    const entries = [entry('z.txt'), entry('a/b.txt'), entry('a-b'), entry('a.txt'), entry('M.txt')];
    const forward = computeSnapshotDigest({ ...base1, entries });
    expect(computeSnapshotDigest({ ...base1, entries: [...entries].reverse() })).toBe(forward);
    expect(computeSnapshotDigest({ ...base1, entries: [entries[2]!, entries[0]!, entries[4]!, entries[1]!, entries[3]!] })).toBe(forward);
  });

  it('sorts by bytes, not by locale or case: uppercase sorts before lowercase', () => {
    const a = computeSnapshotDigest({ ...base1, entries: [entry('Z.txt'), entry('a.txt')] });
    const manual = createHash('sha256')
      .update(`${GIT_SNAPSHOT_DIGEST_DOMAIN}\nobject-format:sha1\ncommit:${oid('c')}\ntree:${oid('d')}\nentries:2\n`)
      .update(`100644 blob ${oid('a')}\t5:Z.txt\n100644 blob ${oid('a')}\t5:a.txt\n`)
      .digest('hex');
    expect(a).toBe(`sha256:${manual}`);
  });

  it('keeps raw path bytes: non-UTF-8 and non-ASCII paths are distinct and are never decoded', () => {
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "caf" + 0xE9, not valid UTF-8
    const utf8 = Buffer.from('café', 'utf-8');
    const d1 = computeSnapshotDigest({ ...base1, entries: [entry(latin)] });
    const d2 = computeSnapshotDigest({ ...base1, entries: [entry(utf8)] });
    expect(d1).not.toBe(d2);
    expect(computeSnapshotDigest({ ...base1, entries: [entry(utf8)] })).toBe(d2);
  });

  it('length-prefixes paths, so a path containing newlines or tabs cannot forge another entry', () => {
    const forged = entry(`a\n100644 blob ${oid('a')}\t1:b`);
    const honest = [entry('a'), entry('b')];
    const d1 = computeSnapshotDigest({ ...base1, entries: [forged] });
    const d2 = computeSnapshotDigest({ ...base1, entries: honest });
    expect(d1).not.toBe(d2);
    // and an entry count that differs cannot be hidden either
    expect(computeSnapshotDigest({ ...base1, entries: [entry('a')] })).not.toBe(computeSnapshotDigest({ ...base1, entries: [entry('a'), entry('a2')] }));
  });

  it('binds every input: mode, object id, path, commit, tree and object format each change the digest', () => {
    const reference = computeSnapshotDigest({ ...base1, entries: [entry('a.txt')] });
    const variants = [
      computeSnapshotDigest({ ...base1, entries: [entry('a.txt', '100755')] }),
      computeSnapshotDigest({ ...base1, entries: [entry('a.txt', '120000')] }),
      computeSnapshotDigest({ ...base1, entries: [entry('a.txt', '100644', oid('b'))] }),
      computeSnapshotDigest({ ...base1, entries: [entry('b.txt')] }),
      computeSnapshotDigest({ ...base1, commit: oid('e'), entries: [entry('a.txt')] }),
      computeSnapshotDigest({ ...base1, tree: oid('e'), entries: [entry('a.txt')] }),
      computeSnapshotDigest({ ...base1, objectFormat: 'sha256', entries: [entry('a.txt')] }),
    ];
    for (const v of variants) expect(v).not.toBe(reference);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('is domain separated: it is not the plain hash of any simple input', () => {
    const d = computeSnapshotDigest({ ...base1, entries: [] });
    expect(d).not.toBe(computeContentDigest(Buffer.from('')));
    expect(d).not.toBe(computeContentDigest(Buffer.from(`commit:${oid('c')}\ntree:${oid('d')}\n`)));
  });

  it('is stable across repeated collection of an unchanged repository', { timeout: T }, async () => {
    const dir = makeRepo();
    const a = await collectGitSnapshot({ repositoryPath: dir });
    const b = await collectGitSnapshot({ repositoryPath: dir });
    if (a.outcome !== 'collected' || b.outcome !== 'collected') throw new Error('setup');
    expect(b.snapshot).toEqual(a.snapshot);
  });

  it('equals an independent computation from Git’s own listing', { timeout: T }, async () => {
    const dir = makeRepo({ files: { 'a.txt': 'one\n', 'dir/b.txt': 'two\n', 'dir/sub/c.txt': 'three\n', 'with space.txt': 'x\n', 'caf\u00e9.txt': 'accent\n', 'run.sh': 'echo hi\n' } });
    g(dir, 'update-index', '--chmod=+x', 'run.sh');
    g(dir, 'commit', '-q', '-m', 'exec bit');
    g(dir, 'status', '--porcelain');
    const r = await collectGitSnapshot({ repositoryPath: dir });
    if (r.outcome !== 'collected') throw new Error(`setup: ${JSON.stringify(r)}`);
    const raw = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE } });
    const entries: SnapshotEntry[] = raw
      .toString('latin1')
      .split('\0')
      .filter(Boolean)
      .map((rec) => {
        const tab = rec.indexOf('\t');
        const [mode, , id] = rec.slice(0, tab).split(' ') as [string, string, string];
        return { mode, type: 'blob' as const, oid: id, path: Uint8Array.from(Buffer.from(rec.slice(tab + 1), 'latin1')) };
      });
    expect(entries).toHaveLength(6);
    expect(entries.some((e) => e.mode === '100755')).toBe(true);
    expect(computeSnapshotDigest({ objectFormat: 'sha1', commit: r.snapshot.commit, tree: r.snapshot.tree, entries })).toBe(r.snapshot.contentDigest);
  });

  it('changes when the committed content changes, and when the file set changes', { timeout: T }, async () => {
    const dir = makeRepo();
    const digests: string[] = [];
    const take = async () => {
      const r = await collectGitSnapshot({ repositoryPath: dir });
      if (r.outcome !== 'collected') throw new Error('setup');
      digests.push(r.snapshot.contentDigest);
    };
    await take();
    commit(dir, { 'README.md': 'changed content\n' });
    await take();
    commit(dir, { 'extra.txt': 'a new file\n' });
    await take();
    fs.rmSync(path.join(dir, 'extra.txt'));
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'remove it');
    await take();
    expect(new Set(digests).size).toBe(4);
  });

  it('differs for different repositories, even with identical files (the commit is part of the digest)', { timeout: T }, async () => {
    const one = makeRepo({ files: { 'a.txt': 'same\n' } });
    const two = makeRepo({ files: { 'a.txt': 'same\n' } });
    const other = makeRepo({ files: { 'a.txt': 'different\n' } });
    const [a, b, c] = await Promise.all([one, two, other].map((repositoryPath) => collectGitSnapshot({ repositoryPath })));
    if (a?.outcome !== 'collected' || b?.outcome !== 'collected' || c?.outcome !== 'collected') throw new Error('setup');
    expect(a.snapshot.tree).toBe(b.snapshot.tree); // same content, same tree...
    expect(a.snapshot.contentDigest).not.toBe(c.snapshot.contentDigest);
    if (a.snapshot.commit !== b.snapshot.commit) expect(a.snapshot.contentDigest).not.toBe(b.snapshot.contentDigest);
  });

  it('works for SHA-256 repositories: 64-hex ids, its own object format, same digest format', { timeout: T }, async () => {
    const files = { 'a.txt': 'same\n', 'b/c.txt': 'nested\n' };
    const sha1 = makeRepo({ files });
    const sha256 = makeRepo({ files, objectFormat: 'sha256' });
    const r1 = await collectGitSnapshot({ repositoryPath: sha1 });
    const r2 = await collectGitSnapshot({ repositoryPath: sha256 });
    if (r1.outcome !== 'collected' || r2.outcome !== 'collected') throw new Error(`setup: ${JSON.stringify([r1, r2])}`);
    expect(r1.snapshot.commit).toHaveLength(40);
    expect(r2.snapshot.commit).toHaveLength(64);
    expect(r2.snapshot.tree).toHaveLength(64);
    expect(r2.snapshot.repository.objectFormat).toBe('sha256');
    expect(r2.snapshot.contentDigest).toMatch(DIGEST);
    expect(r1.snapshot.contentDigest).not.toBe(r2.snapshot.contentDigest);
    const asContext = await ctx(sha256);
    expect(asContext.outcome).toBe('collected');
  });

  it('LIMITATION: it binds the whole HEAD snapshot, not a reviewed change against a base', () => {
    // ActionContext has one commit and one digest and no base revision; the metadata accepts none either
    const parsed = parseActionContext({ actionId: 'a', actionType: 'code_change', environment: 'development', target: 't', commit: oid('c'), contentDigest: computeSnapshotDigest({ ...base1, entries: [] }) });
    expect(parsed.ok && Object.keys(parsed.context).sort()).toEqual(['actionId', 'actionType', 'commit', 'contentDigest', 'environment', 'target']);
  });
});

// ================================================================ action context

describe('action-context construction', () => {
  it('builds a valid context from observed Git state plus externally supplied metadata', { timeout: T }, async () => {
    const dir = makeRepo();
    const r = must(await ctx(dir));
    expect(parseActionContext(r.context).ok).toBe(true);
    expect(r.context).toEqual({ ...META, commit: r.git.commit, contentDigest: r.git.contentDigest });
    expect(r.context.commit).toBe(g(dir, 'rev-parse', 'HEAD').trim());
    expect(r.externallySupplied).toEqual(['actionId', 'actionType', 'environment', 'target']);
    expect(r.observed).toEqual(['commit', 'contentDigest']);
    expect(r.ignoredMetadataFields).toEqual([]);
    expect(r.authorization).toBe('not_evaluated');
    expect(isCollectedActionContext(r)).toBe(true);
    expect(isCollectedActionContext({ ...r })).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('rejects invalid metadata before starting any git process', async () => {
    const dir = makeRepo();
    const { runner, calls } = spyRunner();
    const bad: Array<Record<string, unknown>> = [
      { ...META, actionId: '' },
      { ...META, actionId: 'has space' },
      { ...META, actionId: 'x'.repeat(129) },
      { ...META, actionType: 'launch_missiles' },
      { ...META, actionType: 5 },
      { ...META, environment: 'prod' },
      { ...META, environment: null },
      { ...META, target: '' },
      { ...META, target: 'with space' },
      { ...META, target: '../escape' },
      { ...META, target: 'line\nbreak' },
      { actionType: 'code_change', environment: 'development', target: 't' },
    ];
    for (const m of bad) expect(codeOf(await ctx(dir, { runner }, m)), JSON.stringify(m)).toBe('invalid_action_metadata');
    // called directly: the ctx() helper would replace an undefined argument with its default metadata
    for (const m of [null, undefined, 5, 'meta', []]) {
      expect(codeOf(await collectActionContext({ repositoryPath: dir, runner, metadata: m as unknown as ActionMetadata })), String(m)).toBe('invalid_action_metadata');
    }
    expect(calls).toEqual([]);
  });

  it('ignores a caller-supplied commit or digest and uses what Git reports', { timeout: T }, async () => {
    const dir = makeRepo();
    const honest = must(await ctx(dir));
    const lying = must(await ctx(dir, {}, { ...META, commit: 'c'.repeat(40), contentDigest: `sha256:${'1'.repeat(64)}`, base: 'main~5', diffRef: 'origin/main' }));
    expect(lying.context.commit).toBe(honest.context.commit);
    expect(lying.context.contentDigest).toBe(honest.context.contentDigest);
    expect(lying.context.commit).not.toBe('c'.repeat(40));
    expect(lying.ignoredMetadataFields).toEqual(['base', 'commit', 'contentDigest', 'diffRef']);
  });

  it('is unsupported for every action type a Git snapshot cannot stand for, without starting git', async () => {
    const dir = makeRepo();
    const { runner, calls } = spyRunner();
    for (const actionType of ['rollback', 'database_migration', 'configuration_change', 'dependency_upgrade']) {
      const r = await ctx(dir, { runner }, { ...META, actionType });
      expect(r, actionType).toMatchObject({ outcome: 'incomplete', code: 'non_git_artifact_binding_unavailable' });
    }
    expect(calls).toEqual([]);
  });

  it('binds a deployment to the clean HEAD snapshot like a code change, and only to that', { timeout: T }, async () => {
    const dir = makeRepo();
    const code = await ctx(dir, {}, META);
    const deploy = await ctx(dir, {}, { ...META, actionType: 'deployment', environment: 'production' });
    expect(code.outcome).toBe('collected');
    expect(deploy.outcome).toBe('collected');
    if (code.outcome !== 'collected' || deploy.outcome !== 'collected') return;
    expect(deploy.context).toMatchObject({ actionType: 'deployment', environment: 'production', commit: code.context.commit, contentDigest: code.context.contentDigest });
  });

  it('propagates a non-authorizable repository state instead of a context', { timeout: T }, async () => {
    const dir = makeRepo();
    write(dir, { 'dirty.txt': 'x' });
    expect(codeOf(await ctx(dir))).toBe('working_tree_dirty');
  });

  it('does not claim to verify the supplied fields: it labels them as externally supplied', { timeout: T }, async () => {
    const r = must(await ctx(makeRepo()));
    for (const f of ['actionId', 'actionType', 'environment', 'target']) expect(r.externallySupplied).toContain(f);
    expect(r.externallySupplied).not.toContain('commit');
    expect(r.externallySupplied).not.toContain('contentDigest');
  });
});

// ================================================================ recheck

describe('rechecking before finalization', () => {
  it('reports `unchanged` for an unchanged repository, with a fresh context equal to the old one', { timeout: T }, async () => {
    const dir = makeRepo();
    const first = must(await ctx(dir));
    const again = await recheckActionContext(first);
    expect(again.outcome).toBe('unchanged');
    if (again.outcome === 'unchanged') {
      expect(again.current.context).toEqual(first.context);
      expect(isCollectedActionContext(again.current)).toBe(true);
    }
  });

  it('detects a new HEAD commit and reports exactly what moved', { timeout: T }, async () => {
    const dir = makeRepo();
    const first = must(await ctx(dir));
    commit(dir, { 'README.md': 'changed after authorization was prepared\n' });
    const again = await recheckActionContext(first);
    expect(again.outcome).toBe('changed');
    if (again.outcome === 'changed') {
      expect(again.changed).toEqual(expect.arrayContaining(['commit', 'tree', 'contentDigest']));
      expect(again.current?.context.commit).not.toBe(first.context.commit);
    }
  });

  it('detects a switch to another commit with identical files (the commit is bound)', { timeout: T }, async () => {
    const dir = makeRepo();
    const first = must(await ctx(dir));
    g(dir, 'commit', '-q', '--allow-empty', '-m', 'same tree, new commit');
    const again = await recheckActionContext(first);
    expect(again.outcome).toBe('changed');
    if (again.outcome === 'changed') {
      expect(again.changed).toContain('commit');
      expect(again.changed).toContain('contentDigest');
      expect(again.changed).not.toContain('tree');
    }
  });

  it('treats a dirty working tree after the first collection as a change', { timeout: T }, async () => {
    const dir = makeRepo();
    const first = must(await ctx(dir));
    write(dir, { 'README.md': 'edited after preparation\n' });
    expect(await recheckActionContext(first)).toMatchObject({ outcome: 'changed', changed: ['workingTree'] });
    g(dir, 'checkout', '--', 'README.md');
    write(dir, { 'untracked.txt': 'x' });
    expect(await recheckActionContext(first)).toMatchObject({ outcome: 'changed', changed: ['workingTree'] });
  });

  it('is unchanged when only an ignored file appears (documented limitation)', { timeout: T }, async () => {
    const dir = makeRepo();
    commit(dir, { '.gitignore': '*.log\n' });
    g(dir, 'status', '--porcelain');
    const first = must(await ctx(dir));
    write(dir, { 'build.log': 'noise' });
    expect((await recheckActionContext(first)).outcome).toBe('unchanged');
  });

  it('detects changed action metadata', { timeout: T }, async () => {
    const first = must(await ctx(makeRepo()));
    expect(await recheckActionContext(first, { metadata: META })).toMatchObject({ outcome: 'unchanged' });
    expect(await recheckActionContext(first, { metadata: { ...META, target: 'other-service' } })).toMatchObject({ outcome: 'changed', changed: ['target'] });
    expect(await recheckActionContext(first, { metadata: { ...META, actionId: 'act-2', environment: 'production' } })).toMatchObject({ outcome: 'changed', changed: ['actionId', 'environment'] });
    expect(codeOf(await recheckActionContext(first, { metadata: { ...META, actionType: 'deployment' } }) as never)).toBeUndefined();
    expect(await recheckActionContext(first, { metadata: { ...META, actionType: 'deployment' } })).toMatchObject({ outcome: 'changed', changed: ['actionType'] });
    expect(codeOf((await recheckActionContext(first, { metadata: { ...META, target: '' } })) as never)).toBe('invalid_action_metadata');
  });

  it('detects a different repository at the same location', { timeout: T }, async () => {
    const dir = makeRepo();
    const first = must(await ctx(dir));
    const otherRoot = makeRepo();
    // a second observation that reports another working-tree root is a mismatch, not a quiet success
    // real output, with only the first line (the working-tree root) replaced
    const lying: GitRunner = async (args, options) => {
      const real = await realGitRunner(args, options);
      if (!real.ok || !args.includes('--show-toplevel')) return real;
      const all = real.stdout.toString('utf-8').split('\n');
      all[0] = otherRoot;
      return { ok: true, stdout: Buffer.from(all.join('\n')) };
    };
    expect(await recheckActionContext(first, { runner: lying })).toMatchObject({ outcome: 'changed', changed: ['repository'] });
  });

  it('detects a repository replaced by another with the same path', { timeout: T }, async () => {
    const dir = makeRepo({ name: 'replaceable' });
    const first = must(await ctx(dir));
    fs.rmSync(dir, { recursive: true, force: true });
    makeRepo({ name: 'replaceable', files: { 'other.txt': 'a different project\n' } });
    const again = await recheckActionContext(first);
    expect(again.outcome).toBe('changed');
    if (again.outcome === 'changed') expect(again.changed).toEqual(expect.arrayContaining(['commit', 'contentDigest']));
  });

  it('a failed second collection is incomplete, never "unchanged"', { timeout: T }, async () => {
    const dir = makeRepo();
    const first = must(await ctx(dir));
    expect(codeOf((await recheckActionContext(first, { runner: async () => ({ ok: false, kind: 'unavailable' }) })) as never)).toBe('git_unavailable');
    expect(codeOf((await recheckActionContext(first, { runner: fake((a) => (a.includes('ls-tree') ? { ok: false, kind: 'timeout' } : undefined)) })) as never)).toBe('git_timeout');
    fs.rmSync(dir, { recursive: true, force: true });
    expect((await recheckActionContext(first)).outcome).toBe('incomplete');
  });

  it('only rechecks a genuine collected context, and always the same repository path', { timeout: T }, async () => {
    const dir = makeRepo();
    const first = must(await ctx(dir));
    for (const forged of [{ ...first }, JSON.parse(JSON.stringify(first)), null, undefined, 5, {}, 'context']) {
      expect(codeOf((await recheckActionContext(forged as unknown as CollectedActionContext)) as never), JSON.stringify(forged)?.slice(0, 20)).toBe('previous_not_genuine');
    }
    // there is no option to point the recheck at another repository
    const calls = spyRunner();
    await recheckActionContext(first, { runner: calls.runner });
    expect(calls.calls.length).toBeGreaterThan(0);
  });

  it('the recheck compares exact fields, never a summary', { timeout: T }, async () => {
    const dir = makeRepo();
    const first = must(await ctx(dir));
    const again = await recheckActionContext(first);
    if (again.outcome !== 'unchanged') throw new Error('setup');
    expect(again.current.git.commit).toBe(first.git.commit);
    expect(again.current.git.tree).toBe(first.git.tree);
    expect(again.current.git.contentDigest).toBe(first.git.contentDigest);
    expect(again.current.git.repository).toEqual(first.git.repository);
  });
});

// ================================================================ git safety

describe('Git execution safety', () => {
  it('uses only read commands, with argument arrays, and never modifies the repository', { timeout: T }, async () => {
    const dir = makeRepo();
    const snapshotOf = (): string => {
      const parts = [fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf-8'), fs.statSync(path.join(dir, '.git', 'index')).mtimeMs.toString(), createHash('sha256').update(fs.readFileSync(path.join(dir, '.git', 'index'))).digest('hex')];
      return parts.join('|');
    };
    const before = snapshotOf();
    const { runner, calls } = spyRunner();
    const first = must(await ctx(dir, { runner }));
    await recheckActionContext(first, { runner });
    expect(snapshotOf()).toBe(before);

    const used = new Set(calls.map((c) => subcommand(c)));
    const allowed = new Set(['--version', 'rev-parse', 'config', 'symbolic-ref', 'ls-files', 'status', 'ls-tree']);
    for (const u of used) expect(allowed.has(u), u).toBe(true);
    for (const forbidden of ['add', 'commit', 'checkout', 'reset', 'clean', 'stash', 'merge', 'rebase', 'fetch', 'pull', 'push', 'gc', 'update-index', 'worktree', 'init', 'clone', 'tag', 'branch', 'restore', 'rm', 'mv', 'apply', 'am', 'cherry-pick']) {
      expect(used.has(forbidden), forbidden).toBe(false);
    }
    // config is only ever read
    for (const c of calls.filter((x) => subcommand(x) === 'config')) expect(c).toContain('--list');
    // arguments are plain tokens: the repository path is only the working directory
    for (const c of calls) for (const arg of c) expect(arg.includes(dir), arg).toBe(false);
    // the global options are always applied
    for (const c of calls.filter((x) => x[0] !== '--version')) {
      expect(c.slice(0, 3)).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false']);
    }
  });

  it('gives git an allowlisted, isolated environment', () => {
    const hostile: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      GIT_DIR: '/evil/.git',
      GIT_WORK_TREE: '/evil',
      GIT_INDEX_FILE: '/evil/index',
      GIT_CONFIG_GLOBAL: '/evil/gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.pager',
      GIT_CONFIG_VALUE_0: 'evil',
      GIT_EXTERNAL_DIFF: '/evil/diff',
      GIT_SSH_COMMAND: 'evil',
      GIT_ASKPASS: 'evil',
      GIT_PAGER: 'evil',
      GIT_NO_REPLACE_OBJECTS: '0',
      EDITOR: 'evil',
      PAGER: 'evil',
      GITHUB_TOKEN: 'secret-token',
      NPM_TOKEN: 'secret-token',
      HTTPS_PROXY: 'http://evil',
    };
    const env = buildGitEnvironment(hostile);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SystemRoot).toBe('C:\\Windows');
    for (const dropped of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'EDITOR', 'PAGER', 'GITHUB_TOKEN', 'NPM_TOKEN', 'HTTPS_PROXY']) {
      expect(env[dropped], dropped).toBeUndefined();
    }
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      LC_ALL: 'C',
    });
    expect(JSON.stringify(env)).not.toContain('secret-token');
    // regression: os.devNull is `\\.\nul` on Windows, which Git for Windows rejects; the explicit constant works
    expect(GIT_NULL_DEVICE).toBe(NULL_DEVICE);
    expect(GIT_NULL_DEVICE).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
    expect(GIT_NULL_DEVICE).not.toContain('\\\\.\\');
  });

  it('is not redirected by inherited Git environment variables', { timeout: T }, async () => {
    const target = makeRepo();
    const decoy = makeRepo({ files: { 'decoy.txt': 'a different repository\n' } });
    const expected = await collectGitSnapshot({ repositoryPath: target });
    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_OBJECT_DIRECTORY', 'GIT_EXTERNAL_DIFF'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
      process.env.GIT_DIR = path.join(decoy, '.git');
      process.env.GIT_WORK_TREE = decoy;
      process.env.GIT_INDEX_FILE = path.join(decoy, '.git', 'index');
      process.env.GIT_COMMON_DIR = path.join(decoy, '.git');
      process.env.GIT_OBJECT_DIRECTORY = path.join(decoy, '.git', 'objects');
      process.env.GIT_EXTERNAL_DIFF = 'evil';
      const r = await collectGitSnapshot({ repositoryPath: target });
      expect(r).toEqual(expected);
      if (r.outcome === 'collected') expect(r.snapshot.repository.root).toBe(fs.realpathSync(target));
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });

  it('ignores the developer’s global and system Git configuration, including filter commands and autocrlf', { timeout: T }, async () => {
    const dir = makeRepo();
    const marker = path.join(base, 'global-filter-ran.txt');
    const globalConfig = path.join(base, `global-${++counter}.gitconfig`);
    fs.writeFileSync(globalConfig, `[core]\n\tautocrlf = true\n\tfsmonitor = true\n[filter "evil"]\n\tclean = node -e "require('fs').writeFileSync(process.argv[1],'x')" "${marker.replace(/\\/g, '/')}"\n[alias]\n\tstatus = !echo pwned\n`);
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, h: process.env.HOME, u: process.env.USERPROFILE };
    try {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.HOME = base;
      process.env.USERPROFILE = base;
      fs.writeFileSync(path.join(base, '.gitconfig'), fs.readFileSync(globalConfig));
      const r = await collectGitSnapshot({ repositoryPath: dir });
      expect(r.outcome).toBe('collected');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.h === undefined) delete process.env.HOME;
      else process.env.HOME = saved.h;
      if (saved.u === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.u;
      fs.rmSync(path.join(base, '.gitconfig'), { force: true });
    }
  });

  it('refuses repository configuration that would run a program or hide files, and does not run it', { timeout: T }, async () => {
    const dir = makeRepo();
    const marker = path.join(dir, 'pwned.txt');
    g(dir, 'config', 'filter.evil.clean', `node -e "require('fs').writeFileSync('pwned.txt','x')"`);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n');
    const r = await collectGitSnapshot({ repositoryPath: dir });
    expect(r).toMatchObject({ outcome: 'incomplete', code: 'unsafe_repository_configuration' });
    expect(fs.existsSync(marker)).toBe(false);
    for (const key of ['filter.x.smudge', 'filter.x.process']) {
      const other = makeRepo();
      g(other, 'config', key, 'something');
      expect(codeOf(await collectGitSnapshot({ repositoryPath: other })), key).toBe('unsafe_repository_configuration');
    }
    const sparse = makeRepo();
    g(sparse, 'config', 'core.sparseCheckout', 'true');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: sparse }))).toBe('unsafe_repository_configuration');
  });

  it('does not run an fsmonitor hook, aliases or repository hooks', { timeout: T }, async () => {
    const dir = makeRepo();
    const marker = 'executed.txt';
    const run = `node -e "require('fs').writeFileSync('${marker}','x')"`;
    g(dir, 'config', 'core.fsmonitor', run);
    g(dir, 'config', 'alias.status', `!${run}`);
    g(dir, 'config', 'alias.rev-parse', `!${run}`);
    g(dir, 'config', 'alias.ls-tree', `!${run}`);
    for (const hook of ['post-index-change', 'post-checkout', 'post-merge', 'reference-transaction']) {
      fs.writeFileSync(path.join(dir, '.git', 'hooks', hook), `#!/bin/sh\necho x > "${path.join(dir, marker).replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    }
    const r = await collectGitSnapshot({ repositoryPath: dir });
    expect(r.outcome).toBe('collected');
    expect(fs.existsSync(path.join(dir, marker))).toBe(false);
  });

  it('is not fooled by replacement objects: refs/replace cannot change what HEAD contains', { timeout: T }, async () => {
    const dir = makeRepo({ files: { 'a.txt': 'original\n' } });
    const original = g(dir, 'rev-parse', 'HEAD').trim();
    commit(dir, { 'a.txt': 'real latest content\n' });
    g(dir, 'status', '--porcelain');
    const latest = g(dir, 'rev-parse', 'HEAD').trim();
    g(dir, 'replace', latest, original); // with replacements honoured, HEAD would look like the OLD commit
    const r = await collectGitSnapshot({ repositoryPath: dir });
    if (r.outcome !== 'collected') throw new Error(`setup: ${JSON.stringify(r)}`);
    expect(r.snapshot.commit).toBe(latest);
    const realTree = execFileSync('git', ['rev-parse', `${latest}^{tree}`], { cwd: dir, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE }, encoding: 'utf-8' }).trim();
    expect(r.snapshot.tree).toBe(realTree);
  });

  it('a hostile repository path is only ever a working directory: shell metacharacters and option-like names do nothing', { timeout: T }, async () => {
    const evil = path.join(base, 'evil & echo pwned ; $(touch pwned) `id`');
    const optionLike = path.join(base, '--upload-pack=evil');
    for (const dir of [evil, optionLike]) {
      fs.mkdirSync(dir, { recursive: true });
      g(dir, 'init', '-q', '-b', 'main');
      commit(dir, { 'a.txt': 'x\n' });
      g(dir, 'status', '--porcelain');
      const r = await collectGitSnapshot({ repositoryPath: dir });
      expect(r.outcome, dir).toBe('collected');
    }
    for (const stray of [path.join(base, 'pwned'), path.join(evil, 'pwned'), path.join(process.cwd(), 'pwned')]) expect(fs.existsSync(stray), stray).toBe(false);
  });

  it('kills a command that runs too long', async () => {
    const result = await realGitRunner(['hash-object', '--stdin'], { cwd: base, env: buildGitEnvironment(), timeoutMs: 400, maxOutputBytes: 1024 }); // waits for stdin forever
    expect(result).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('stops a command that produces too much output', { timeout: T }, async () => {
    const dir = makeRepo();
    const result = await realGitRunner(['ls-files'], { cwd: dir, env: buildGitEnvironment(), timeoutMs: 20_000, maxOutputBytes: 8 });
    expect(result).toMatchObject({ ok: false, kind: 'output_limit' });
  });

  it('runs a real command and reports a missing git executable and a non-zero exit distinctly', { timeout: T }, async () => {
    const dir = makeRepo();
    const ok = await realGitRunner(['--version'], { cwd: dir, env: buildGitEnvironment(), timeoutMs: 20_000, maxOutputBytes: 1024 });
    expect(ok.ok && ok.stdout.toString()).toMatch(/^git version /);
    const exit = await realGitRunner(['rev-parse', '--verify', 'no-such-ref-at-all'], { cwd: dir, env: buildGitEnvironment(), timeoutMs: 20_000, maxOutputBytes: 1024 });
    expect(exit).toMatchObject({ ok: false, kind: 'exit' });
    const missing = await realGitRunner(['--version'], { cwd: dir, env: { PATH: path.join(base, 'no-such-bin-dir') }, timeoutMs: 5000, maxOutputBytes: 1024 });
    expect(missing.ok).toBe(false);
  });

  it('reports excessive output and a timeout from the collector as incomplete', async () => {
    const dir = makeRepo();
    expect(codeOf(await collectGitSnapshot({ repositoryPath: dir, runner: async () => ({ ok: false, kind: 'output_limit' }) }))).toBe('git_output_too_large');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: dir, runner: async () => ({ ok: false, kind: 'timeout' }) }))).toBe('git_timeout');
    expect(codeOf(await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('ls-files') ? { ok: false, kind: 'output_limit' } : undefined)) }))).toBe('git_output_too_large');
  });

  it('passes bounded time and output limits to every command', { timeout: T }, async () => {
    const dir = makeRepo();
    const seen: Array<{ timeoutMs: number; maxOutputBytes: number }> = [];
    const runner: GitRunner = async (args, options) => (seen.push({ timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes }), realGitRunner(args, options));
    await collectGitSnapshot({ repositoryPath: dir, runner });
    expect(seen.length).toBeGreaterThan(5);
    for (const s of seen) {
      expect(s.timeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS);
      expect(s.maxOutputBytes).toBeGreaterThan(0);
      expect(s.maxOutputBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    }
    const custom: number[] = [];
    await collectGitSnapshot({ repositoryPath: dir, timeoutMs: 5000, runner: async (a, o) => (custom.push(o.timeoutMs), realGitRunner(a, o)) });
    expect(new Set(custom)).toEqual(new Set([5000]));
  });
});

// ================================================================ hostile input, leakage and scope

describe('hostile input, leakage and scope', () => {
  it('never throws on hostile requests', async () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    const dir = base;
    const requests: unknown[] = [undefined, null, 5, 'repo', [], {}, hostile, { repositoryPath: 5 }, { repositoryPath: hostile }, { repositoryPath: dir, timeoutMs: 0 }, { repositoryPath: dir, timeoutMs: -1 }, { repositoryPath: dir, timeoutMs: 1.5 }, { repositoryPath: dir, timeoutMs: MAX_GIT_TIMEOUT_MS + 1 }, { repositoryPath: dir, timeoutMs: '5' }, { repositoryPath: dir, runner: 'not a function' }, { repositoryPath: dir, expectedRoot: 5 }];
    for (const [i, req] of requests.entries()) {
      const r = await collectGitSnapshot(req as never);
      expect(r.outcome, `request ${i}`).toBe('incomplete');
    }
    for (const [i, req] of [undefined, null, 5, {}, hostile, { repositoryPath: dir, metadata: hostile }].entries()) {
      const r = await collectActionContext(req as never);
      expect(r.outcome, `context request ${i}`).toBe('incomplete');
    }
    expect((await recheckActionContext(hostile as never)).outcome).toBe('incomplete');
  });

  it('does not leak file contents, file names or diffs in any result or message', { timeout: T }, async () => {
    const dir = makeRepo({ files: { 'SECRET-FILE-NAME.txt': 'SECRET-FILE-CONTENT\n', 'README.md': 'hello\n' } });
    const results: unknown[] = [];
    results.push(await ctx(dir));
    write(dir, { 'SECRET-FILE-NAME.txt': 'SECRET-CHANGED-CONTENT\n', 'SECRET-NEW-FILE.txt': 'x' });
    results.push(await ctx(dir));
    results.push(await collectGitSnapshot({ repositoryPath: dir, runner: async () => { throw new Error('SECRET-FILE-CONTENT in an error'); } }));
    results.push(await collectGitSnapshot({ repositoryPath: dir, runner: fake((a) => (a.includes('status') ? { ok: true, stdout: Buffer.from('SECRET-FILE-CONTENT') } : undefined)) }));
    for (const r of results) {
      const text = JSON.stringify(r);
      for (const secret of ['SECRET-FILE-CONTENT', 'SECRET-FILE-NAME', 'SECRET-CHANGED-CONTENT', 'SECRET-NEW-FILE']) expect(text, secret).not.toContain(secret);
    }
  });

  it('is read-only and independent of the real project: nothing here touches the CodeXRev repository', () => {
    expect(base.startsWith(fs.realpathSync(tmpdir()))).toBe(true);
    expect(base.includes('codexrev-actionctx-test-')).toBe(true);
  });

  it('does not execute anything: results carry no authorization and the source has no shell, deployment or write commands', () => {
    const full = fs.readFileSync(new URL('../../../../src/features/action-safety/authorization/actionContextCollector.ts', import.meta.url), 'utf-8');
    const source = full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/shell:\s*true/);
    expect(source).not.toMatch(/(?<![.\w])(exec|execSync|spawn|spawnSync|fork)\(/); // a bare call, not RegExp.exec
    expect(source).not.toContain('node:http');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('Math.random');
    // ('commit' is also Git's object type in a tree listing, so it is covered by the behavioural test above instead)
    for (const write of ["'add'", "'checkout'", "'reset'", "'clean'", "'update-index'", "'init'", "'fetch'", "'push'", "'stash'"]) expect(source, write).not.toContain(write);
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['./proof.js', 'node:child_process', 'node:crypto', 'node:fs', 'node:path']);
  });

  it('is not wired into the assessment: nothing outside the authorization folder imports it', () => {
    const root = new URL('../../../../src/features/action-safety/', import.meta.url);
    const offenders: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
        if (e.isDirectory()) {
          // `strict` is the setup tooling (keys, grants, approvals), not the assessment: it may use these modules
          if (e.name !== 'authorization' && e.name !== 'strict') walk(child);
        } else if (e.name.endsWith('.ts') && fs.readFileSync(child, 'utf-8').includes('actionContextCollector')) offenders.push(e.name);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
