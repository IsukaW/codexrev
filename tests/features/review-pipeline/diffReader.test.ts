import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffReaderError, readDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-diffreader-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function initRepo(): Promise<ReturnType<typeof simpleGit>> {
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 'test@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Test');
  return git;
}

describe('readDiff', () => {
  it('throws DiffReaderError when cwd is not a git repo', async () => {
    await expect(readDiff(tmpRoot)).rejects.toThrow(DiffReaderError);
  });

  it('returns an empty result when there are no staged changes', async () => {
    await initRepo();
    const parsed = await readDiff(tmpRoot);
    expect(parsed.ref).toBe('staged');
    expect(parsed.files).toEqual([]);
    expect(parsed.raw).toBe('');
  });

  it('parses a staged modification with correct per-line numbers', async () => {
    const git = await initRepo();
    const file = path.join(tmpRoot, 'greet.ts');
    await fs.writeFile(file, 'line1\nline2 old\nline3\nline4\n', 'utf-8');
    await git.add('greet.ts');
    await git.commit('initial');

    await fs.writeFile(file, 'line1\nline2 new\nline2b added\nline3\nline4\n', 'utf-8');
    await git.add('greet.ts');

    const parsed = await readDiff(tmpRoot);
    expect(parsed.ref).toBe('staged');
    expect(parsed.files).toHaveLength(1);

    const f = parsed.files[0];
    expect(f.path).toBe('greet.ts');
    expect(f.status).toBe('modified');
    expect(f.hunks).toHaveLength(1);

    const lines = f.hunks[0].lines;
    const del = lines.find((l) => l.type === 'del');
    expect(del).toEqual({ type: 'del', content: 'line2 old', oldLineNumber: 2 });

    const adds = lines.filter((l) => l.type === 'add');
    expect(adds).toEqual([
      { type: 'add', content: 'line2 new', newLineNumber: 2 },
      { type: 'add', content: 'line2b added', newLineNumber: 3 },
    ]);

    const context = lines.filter((l) => l.type === 'context');
    expect(context.length).toBeGreaterThan(0);
    for (const c of context) {
      expect(c.oldLineNumber).toBeDefined();
      expect(c.newLineNumber).toBeDefined();
    }

    expect(parsed.raw).toContain('diff --git');
  });

  it('classifies a newly added file as "added"', async () => {
    const git = await initRepo();
    await fs.writeFile(path.join(tmpRoot, 'base.ts'), 'x\n', 'utf-8');
    await git.add('base.ts');
    await git.commit('base');

    await fs.writeFile(path.join(tmpRoot, 'new.ts'), 'hello\n', 'utf-8');
    await git.add('new.ts');

    const parsed = await readDiff(tmpRoot);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].path).toBe('new.ts');
    expect(parsed.files[0].status).toBe('added');
    expect(parsed.files[0].oldPath).toBeUndefined();
  });

  it('classifies a deleted file as "deleted"', async () => {
    const git = await initRepo();
    await fs.writeFile(path.join(tmpRoot, 'gone.ts'), 'x\n', 'utf-8');
    await git.add('gone.ts');
    await git.commit('base');

    await fs.rm(path.join(tmpRoot, 'gone.ts'));
    await git.add('gone.ts');

    const parsed = await readDiff(tmpRoot);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].path).toBe('gone.ts');
    expect(parsed.files[0].status).toBe('deleted');
  });

  it('diffs against an explicit ref instead of staged changes', async () => {
    const git = await initRepo();
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'v1\n', 'utf-8');
    await git.add('a.ts');
    await git.commit('first');
    const firstHash = (await git.revparse(['HEAD'])).trim();

    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'v2\n', 'utf-8');
    await git.add('a.ts');
    await git.commit('second');

    const parsed = await readDiff(tmpRoot, firstHash);
    expect(parsed.ref).toBe(firstHash);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].path).toBe('a.ts');
  });
});

describe(
  'readDiff — running from a subdirectory of a larger repo ' +
    '(reproduces the reported bug: git reports repo-root-relative paths, not cwd-relative ones)',
  () => {
    it('rewrites file paths to be relative to cwd, not the repo root, when cwd is a subdirectory', async () => {
      const git = await initRepo();
      await fs.mkdir(path.join(tmpRoot, 'testProject', 'src'), { recursive: true });
      const file = path.join(tmpRoot, 'testProject', 'src', 'fib.js');
      await fs.writeFile(file, 'function fib() { return 1; }\n', 'utf-8');
      await git.add('testProject/src/fib.js');
      await git.commit('initial');

      await fs.writeFile(file, 'function fib() { return 2; }\n', 'utf-8');
      await git.add('testProject/src/fib.js');

      // Read the diff with cwd set to the SUBDIRECTORY, not the repo root —
      // exactly `codexrev review scan` run from inside `testProject/`.
      const subCwd = path.join(tmpRoot, 'testProject');
      const parsed = await readDiff(subCwd);

      expect(parsed.files).toHaveLength(1);
      // Must be cwd-relative ("src/fib.js"), NOT repo-root-relative
      // ("testProject/src/fib.js") — the latter is what caused
      // path.join(cwd, file) to double up into ".../testProject/testProject/src/fib.js".
      expect(parsed.files[0].path).toBe(path.join('src', 'fib.js'));

      // The critical regression check: joining the reported path onto
      // cwd must resolve to a file that actually exists.
      const resolved = path.join(subCwd, parsed.files[0].path);
      await expect(fs.access(resolved)).resolves.toBeUndefined();
    });

    it('is a no-op when cwd already IS the repo root (existing behavior unchanged)', async () => {
      const git = await initRepo();
      await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'v1\n', 'utf-8');
      await git.add('a.ts');
      await git.commit('initial');
      await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'v2\n', 'utf-8');
      await git.add('a.ts');

      const parsed = await readDiff(tmpRoot);
      expect(parsed.files[0].path).toBe('a.ts');
    });

    it('rewrites both sides of a rename correctly', async () => {
      const git = await initRepo();
      await fs.mkdir(path.join(tmpRoot, 'testProject', 'src'), { recursive: true });
      const oldFile = path.join(tmpRoot, 'testProject', 'src', 'old.ts');
      // Long, mostly-unchanged content with one edit — long enough for git
      // to detect a rename (not add+delete), but WITH a content change so
      // git emits a normal `--- a/... +++ b/...` diff (a pure content-free
      // rename uses a different "rename from/to" header parsePatch doesn't
      // read file names from — a separate, pre-existing gap, not this bug).
      await fs.writeFile(oldFile, `export const x = 1;\n${'// filler\n'.repeat(20)}`, 'utf-8');
      await git.add('testProject/src/old.ts');
      await git.commit('initial');

      const newFile = path.join(tmpRoot, 'testProject', 'src', 'new.ts');
      await fs.rename(oldFile, newFile);
      await fs.writeFile(newFile, `export const x = 2;\n${'// filler\n'.repeat(20)}`, 'utf-8');
      await git.add(['testProject/src/old.ts', 'testProject/src/new.ts']);

      const subCwd = path.join(tmpRoot, 'testProject');
      const parsed = await readDiff(subCwd);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].status).toBe('renamed');
      expect(parsed.files[0].path).toBe(path.join('src', 'new.ts'));
      expect(parsed.files[0].oldPath).toBe(path.join('src', 'old.ts'));
    });
  },
);
