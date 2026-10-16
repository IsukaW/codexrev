import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectGit,
  isSensitivePath,
  modulePathOf,
  parseNameStatusZ,
  parseNumstatZ,
  validateDiffRef,
} from '../../../../src/features/action-safety/collectors/gitCollector.js';

const NOW = '2025-01-10T12:00:00.000Z';

let dir: string;
let git: SimpleGit;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-safety-git-')));
  git = simpleGit({ baseDir: dir });
  await git.init();
  await git.addConfig('user.email', 'test@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Test');
  await git.addConfig('commit.gpgsign', 'false');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, text: string) => {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf-8');
};

async function commitBase(): Promise<void> {
  await write('a.ts', 'one\n');
  await write('b.ts', 'one\n');
  await git.add('.');
  await git.commit('base');
}

// hash of every file under .git, so "read-only" can be proven byte for byte
async function snapshotGitDir(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[path.relative(dir, p)] = createHash('sha1').update(await fs.readFile(p)).digest('hex');
    }
  };
  await walk(path.join(dir, '.git'));
  return out;
}

describe('collectGit: changes', () => {
  it('keeps staged, unstaged and untracked changes apart', async () => {
    await commitBase();
    await write('a.ts', 'one\ntwo\n');
    await git.add('a.ts'); // staged
    await write('b.ts', 'one\nthree\nfour\n'); // unstaged
    await write('src/new.ts', 'x\n'); // untracked

    const r = await collectGit({ cwd: dir, now: NOW });
    expect(r.state).toBe('collected');
    expect(r.counts).toEqual({ total: 3, staged: 1, unstaged: 1, untracked: 1, conflicted: 0 });
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(by['a.ts']).toMatchObject({ change: 'modified', staged: true, unstaged: false, untracked: false, insertions: 1, deletions: 0 });
    expect(by['b.ts']).toMatchObject({ change: 'modified', staged: false, unstaged: true, untracked: false, insertions: 2 });
    expect(by['src/new.ts']).toMatchObject({ change: 'untracked', staged: false, unstaged: false, untracked: true });
    expect(r.modules).toEqual(['.', 'src']);
  });

  it('reports the branch and HEAD commit', async () => {
    await commitBase();
    const r = await collectGit({ cwd: dir, now: NOW });
    expect(r.branch).toBeTruthy();
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
    expect(r.hasCommits).toBe(true);
    expect(r.detached).toBe(false);
    expect(r.repoRoot && path.resolve(r.repoRoot)).toBe(path.resolve(dir));
  });

  it('reports a clean tree as zero changes', async () => {
    await commitBase();
    const r = await collectGit({ cwd: dir, now: NOW });
    expect(r.counts.total).toBe(0);
    expect(r.files).toEqual([]);
  });

  it('classifies added and deleted files, and a file both staged and modified again', async () => {
    await commitBase();
    await write('c.ts', 'new\n');
    await git.add('c.ts');
    await write('c.ts', 'new\nmore\n'); // staged add, then edited again
    await fs.rm(path.join(dir, 'b.ts'));
    const r = await collectGit({ cwd: dir, now: NOW });
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(by['c.ts']).toMatchObject({ change: 'added', staged: true, unstaged: true });
    expect(by['b.ts']).toMatchObject({ change: 'deleted', unstaged: true });
  });

  it('handles file names with spaces and non-ASCII characters', async () => {
    await commitBase();
    await write('my docs/résumé notes.md', 'hi\n');
    const r = await collectGit({ cwd: dir, now: NOW });
    expect(r.files.map((f) => f.path)).toContain('my docs/résumé notes.md');
  });

  it('works in a repository with no commits yet and says so', async () => {
    await write('first.ts', 'x\n');
    const r = await collectGit({ cwd: dir, now: NOW });
    expect(r.state).toBe('collected');
    expect(r.hasCommits).toBe(false);
    expect(r.head).toBeUndefined();
    expect(r.files.map((f) => f.path)).toEqual(['first.ts']);
    expect(r.limitations.join(' ')).toMatch(/no commits/);
  });

  it('lists repository-root-relative paths even when run from a subdirectory', async () => {
    await commitBase();
    await write('src/deep/new.ts', 'x\n');
    const r = await collectGit({ cwd: path.join(dir, 'src'), now: NOW });
    expect(r.files.map((f) => f.path)).toEqual(['src/deep/new.ts']);
  });
});

describe('collectGit: --diff', () => {
  it('compares the working tree with a revision', async () => {
    await commitBase();
    await write('a.ts', 'one\ntwo\n');
    await git.add('a.ts');
    await git.commit('second');
    await write('b.ts', 'changed\n'); // uncommitted
    const r = await collectGit({ cwd: dir, diffRef: 'HEAD~1', now: NOW });
    expect(r.diffRef).toBe('HEAD~1');
    expect(r.diffBase).toMatch(/^[0-9a-f]{40}$/);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(['a.ts', 'b.ts']);
    expect(by['a.ts'].vsRef).toBe(true);
    expect(by['b.ts'].vsRef).toBe(true);
  });

  it('rejects refs that could be read as options or contain shell metacharacters, without running git', async () => {
    await commitBase();
    for (const bad of ['--output=pwned.txt', '-p', 'main; touch pwned', 'a b', '$(touch pwned)', 'a..b', '']) {
      const r = await collectGit({ cwd: dir, diffRef: bad, now: NOW });
      expect(r.state, bad).toBe('error');
      expect(r.diffRefError, bad).toMatch(/invalid --diff revision/);
      expect(r.files).toEqual([]);
    }
    await expect(fs.access(path.join(dir, 'pwned.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'pwned'))).rejects.toThrow();
  });

  it('reports a well-formed ref that does not exist as a user error', async () => {
    await commitBase();
    const r = await collectGit({ cwd: dir, diffRef: 'no-such-branch', now: NOW });
    expect(r.state).toBe('error');
    expect(r.diffRefError).toMatch(/does not resolve to a commit/);
  });

  it('validateDiffRef accepts normal revisions', () => {
    for (const ok of ['main', 'HEAD~3', 'v1.2.3', 'origin/feature/x', 'abc1234', '@{u}', 'main^']) {
      expect(validateDiffRef(ok), ok).toBeUndefined();
    }
  });
});

describe('collectGit: other states', () => {
  it('reports a directory that is not a repository, without failing', async () => {
    const plain = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-safety-plain-')));
    try {
      const r = await collectGit({ cwd: plain, diffRef: 'main', now: NOW });
      expect(r.state).toBe('not_a_repository');
      expect(r.files).toEqual([]);
      expect(r.limitations.join(' ')).toMatch(/not a git repository/);
      expect(r.limitations.join(' ')).toMatch(/--diff was therefore not applied/);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it('flags sensitive and binary files as excluded and never reads them', async () => {
    await commitBase();
    await write('.env', 'SECRET=hunter2\n');
    await write('.env.example', 'SECRET=\n');
    await write('keys/server.pem', 'PRIVATE\n');
    await fs.writeFile(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await git.add('logo.bin');
    const r = await collectGit({ cwd: dir, now: NOW });
    const ex = Object.fromEntries(r.excluded.map((e) => [e.path, e.reason]));
    expect(ex['.env']).toBe('sensitive');
    expect(ex['keys/server.pem']).toBe('sensitive');
    expect(ex['.env.example']).toBeUndefined();
    expect(ex['logo.bin']).toBe('binary');
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('is deterministic for an unchanged repository', async () => {
    await commitBase();
    await write('a.ts', 'one\ntwo\n');
    expect(await collectGit({ cwd: dir, now: NOW })).toEqual(await collectGit({ cwd: dir, now: NOW }));
  });
});

describe('collectGit: environment isolation', () => {
  it('ignores EDITOR, PAGER, GIT_DIR and GIT_INDEX_FILE inherited from the caller shell', async () => {
    await commitBase();
    await write('new.ts', 'x\n');
    const saved = { ...process.env };
    process.env.EDITOR = 'vim';
    process.env.PAGER = 'less';
    process.env.GIT_DIR = path.join(dir, 'does-not-exist');
    process.env.GIT_INDEX_FILE = path.join(dir, 'also-missing');
    try {
      const r = await collectGit({ cwd: dir, now: NOW });
      expect(r.state).toBe('collected');
      expect(r.files.map((f) => f.path)).toEqual(['new.ts']);
    } finally {
      for (const k of ['EDITOR', 'PAGER', 'GIT_DIR', 'GIT_INDEX_FILE']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe('collectGit: read-only', () => {
  it('does not change a single byte under .git or the working tree', async () => {
    await commitBase();
    await write('a.ts', 'one\ntwo\n');
    await git.add('a.ts');
    await write('b.ts', 'edited\n');
    await write('new.ts', 'x\n');
    const beforeGit = await snapshotGitDir();
    const beforeStatus = await git.raw(['status', '--porcelain']);
    const beforeTree = await fs.readFile(path.join(dir, 'b.ts'), 'utf-8');

    await collectGit({ cwd: dir, now: NOW });
    await collectGit({ cwd: dir, diffRef: 'HEAD', now: NOW });

    expect(await snapshotGitDir()).toEqual(beforeGit);
    expect(await git.raw(['status', '--porcelain'])).toBe(beforeStatus);
    expect(await fs.readFile(path.join(dir, 'b.ts'), 'utf-8')).toBe(beforeTree);
    await expect(fs.access(path.join(dir, '.git', 'index.lock'))).rejects.toThrow();
  });
});

describe('git helpers', () => {
  it('modulePathOf groups by directory', () => {
    expect(modulePathOf('README.md')).toBe('.');
    expect(modulePathOf('docs/a.md')).toBe('docs');
    expect(modulePathOf('src/cli/index.ts')).toBe('src/cli');
    expect(modulePathOf('src/features/action-safety/cli/a.ts')).toBe('src/features/action-safety');
    expect(modulePathOf('packages/web/src/x.ts')).toBe('packages/web');
  });

  it('isSensitivePath flags likely secrets but not samples', () => {
    for (const p of ['.env', '.env.production', 'a/b/.env.local', 'id_rsa', 'certs/site.pem', 'x/credentials.json', '.npmrc']) {
      expect(isSensitivePath(p), p).toBe(true);
    }
    for (const p of ['.env.example', 'src/env.ts', 'docs/keys.md', 'secrets.md']) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });

  it('parses git -z name-status and numstat output', () => {
    expect(parseNameStatusZ('M\0a.ts\0A\0b c.ts\0')).toEqual([
      { code: 'M', path: 'a.ts' },
      { code: 'A', path: 'b c.ts' },
    ]);
    expect(parseNameStatusZ('')).toEqual([]);
    const n = parseNumstatZ('3\t1\ta.ts\0-\t-\timg.png\0');
    expect(n.get('a.ts')).toEqual({ insertions: 3, deletions: 1, binary: false });
    expect(n.get('img.png')).toEqual({ binary: true });
  });
});
