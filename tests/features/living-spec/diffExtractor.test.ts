import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_GLOBS,
  extractDiff,
} from '../../../src/features/living-spec/pipeline/diffExtractor.js';
import { LivingSpecDiffError } from '../../../src/features/living-spec/tools/errors.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-diffextractor-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function initRepo(): Promise<SimpleGit> {
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 'test@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Test');
  return git;
}

async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

describe('extractDiff — repository handling', () => {
  it('throws LivingSpecDiffError when the project is not a git repository', async () => {
    await expect(extractDiff(tmpRoot)).rejects.toThrow(LivingSpecDiffError);
  });

  it('returns an empty extraction when nothing is staged', async () => {
    await initRepo();
    const extracted = await extractDiff(tmpRoot);
    expect(extracted.ref).toBe('staged');
    expect(extracted.files).toEqual([]);
    expect(extracted.raw).toBe('');
    expect(extracted.truncated).toBe(false);
    expect(extracted.omittedPaths).toEqual([]);
  });
});

describe('extractDiff — statuses and exact line numbers', () => {
  it('parses a modified file with exact old/new line numbers', async () => {
    const git = await initRepo();
    await writeFile('greet.ts', 'line1\nline2 old\nline3\nline4\n');
    await git.add('greet.ts');
    await git.commit('initial');

    await writeFile('greet.ts', 'line1\nline2 new\nline2b added\nline3\nline4\n');
    await git.add('greet.ts');

    const extracted = await extractDiff(tmpRoot);
    expect(extracted.files).toHaveLength(1);

    const file = extracted.files[0];
    expect(file.path).toBe('greet.ts');
    expect(file.status).toBe('modified');
    expect(file.oldPath).toBeUndefined();
    expect(file.linesAdded).toBe(2);
    expect(file.linesRemoved).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const lines = file.hunks[0].lines;
    expect(lines.find((l) => l.type === 'del')).toEqual({
      type: 'del',
      content: 'line2 old',
      oldLineNumber: 2,
    });
    expect(lines.filter((l) => l.type === 'add')).toEqual([
      { type: 'add', content: 'line2 new', newLineNumber: 2 },
      { type: 'add', content: 'line2b added', newLineNumber: 3 },
    ]);
    for (const c of lines.filter((l) => l.type === 'context')) {
      expect(c.oldLineNumber).toBeDefined();
      expect(c.newLineNumber).toBeDefined();
    }

    // hunk header numbers are exact too
    const hunk = file.hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(file.minimalPatch).toContain('@@ -');
  });

  it('classifies a new file as "added" with lines numbered from 1', async () => {
    const git = await initRepo();
    await writeFile('base.ts', 'x\n');
    await git.add('base.ts');
    await git.commit('base');

    await writeFile('new.ts', 'hello\nworld\n');
    await git.add('new.ts');

    const extracted = await extractDiff(tmpRoot);
    expect(extracted.files).toHaveLength(1);
    const file = extracted.files[0];
    expect(file.path).toBe('new.ts');
    expect(file.status).toBe('added');
    expect(file.oldPath).toBeUndefined();
    expect(file.linesAdded).toBe(2);
    expect(file.linesRemoved).toBe(0);
    expect(file.hunks[0].lines).toEqual([
      { type: 'add', content: 'hello', newLineNumber: 1 },
      { type: 'add', content: 'world', newLineNumber: 2 },
    ]);
  });

  it('classifies a removed file as "deleted" keeping old line numbers', async () => {
    const git = await initRepo();
    await writeFile('gone.ts', 'a\nb\nc\n');
    await git.add('gone.ts');
    await git.commit('base');

    await fs.rm(path.join(tmpRoot, 'gone.ts'));
    await git.add('gone.ts');

    const extracted = await extractDiff(tmpRoot);
    expect(extracted.files).toHaveLength(1);
    const file = extracted.files[0];
    expect(file.path).toBe('gone.ts');
    expect(file.status).toBe('deleted');
    expect(file.linesRemoved).toBe(3);
    expect(file.hunks[0].lines.map((l) => l.oldLineNumber)).toEqual([1, 2, 3]);
  });

  it('classifies a renamed file as "renamed" with both paths', async () => {
    const git = await initRepo();
    // long, mostly-unchanged content so git detects the rename, with one
    // content edit so it emits a normal ---/+++ patch
    await writeFile('old.ts', `export const x = 1;\n${'// filler\n'.repeat(20)}`);
    await git.add('old.ts');
    await git.commit('initial');

    await fs.rename(path.join(tmpRoot, 'old.ts'), path.join(tmpRoot, 'new.ts'));
    await writeFile('new.ts', `export const x = 2;\n${'// filler\n'.repeat(20)}`);
    await git.add(['old.ts', 'new.ts']);

    const extracted = await extractDiff(tmpRoot);
    expect(extracted.files).toHaveLength(1);
    const file = extracted.files[0];
    expect(file.status).toBe('renamed');
    expect(file.path).toBe('new.ts');
    expect(file.oldPath).toBe('old.ts');
    expect(file.minimalPatch).toContain('old.ts');
  });

  it('classifies a pure rename (no content change) via rename headers', async () => {
    const git = await initRepo();
    await writeFile('old.ts', `${'// filler\n'.repeat(20)}export const x = 1;\n`);
    await git.add('old.ts');
    await git.commit('initial');

    await fs.rename(path.join(tmpRoot, 'old.ts'), path.join(tmpRoot, 'new.ts'));
    await git.add(['old.ts', 'new.ts']);

    const extracted = await extractDiff(tmpRoot);
    expect(extracted.files).toHaveLength(1);
    const file = extracted.files[0];
    expect(file.status).toBe('renamed');
    expect(file.path).toBe('new.ts');
    expect(file.oldPath).toBe('old.ts');
    expect(file.hunks).toHaveLength(0);
  });

  it('diffs against an explicit ref instead of staged changes', async () => {
    const git = await initRepo();
    await writeFile('a.ts', 'v1\n');
    await git.add('a.ts');
    await git.commit('first');
    const firstHash = (await git.revparse(['HEAD'])).trim();

    await writeFile('a.ts', 'v2\n');
    await git.add('a.ts');
    await git.commit('second');

    const extracted = await extractDiff(tmpRoot, { ref: firstHash });
    expect(extracted.ref).toBe(firstHash);
    expect(extracted.files).toHaveLength(1);
    expect(extracted.files[0].path).toBe('a.ts');
    expect(extracted.files[0].linesAdded).toBe(1);
  });
});

describe('extractDiff — glob filtering', () => {
  async function stageMixedChange(): Promise<void> {
    const git = await initRepo();
    for (const p of ['src/app.ts', 'notes.md', 'node_modules/lib.ts', 'dist/gen.ts']) {
      await writeFile(p, 'v1\n');
      await git.add(p);
    }
    await git.commit('initial');
    for (const p of ['src/app.ts', 'notes.md', 'node_modules/lib.ts', 'dist/gen.ts']) {
      await writeFile(p, 'v2\n');
      await git.add(p);
    }
  }

  it('keeps source files only by default and always excludes node_modules/dist', async () => {
    await stageMixedChange();
    const extracted = await extractDiff(tmpRoot);
    expect(extracted.files.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('honors a custom includePaths glob', async () => {
    await stageMixedChange();
    const extracted = await extractDiff(tmpRoot, { includePaths: ['**/*.md'] });
    expect(extracted.files.map((f) => f.path)).toEqual(['notes.md']);
  });

  it('always excludes .codexrev state paths even when the config matches them', async () => {
    const git = await initRepo();
    await writeFile('.codexrev/living-spec/notes.ts', 'v1\n');
    await writeFile('src/app.ts', 'v1\n');
    await git.add(['.codexrev', 'src']);
    await git.commit('initial');

    await writeFile('.codexrev/living-spec/notes.ts', 'v2\n');
    await writeFile('src/app.ts', 'v2\n');
    await git.add(['.codexrev', 'src']);

    const extracted = await extractDiff(tmpRoot, { includePaths: ['**/*'] });
    expect(extracted.files.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('exposes the default source globs for ts/tsx/js/jsx/py/java/go/rs', () => {
    const exts = DEFAULT_SOURCE_GLOBS.map((g) => g.replace('**/*', '')).sort();
    expect(exts).toEqual(['.go', '.java', '.js', '.jsx', '.py', '.rs', '.ts', '.tsx'].sort());
  });
});

describe('extractDiff — minimal diff view', () => {
  it('keeps changed lines plus at most 3 context lines, never the whole file', async () => {
    const git = await initRepo();
    const body = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile('big.ts', `${body}\n`);
    await git.add('big.ts');
    await git.commit('initial');

    await writeFile(
      'big.ts',
      `${body
        .split('\n')
        .map((l, i) => (i === 14 ? 'line15 changed' : l))
        .join('\n')}\n`,
    );
    await git.add('big.ts');

    const extracted = await extractDiff(tmpRoot);
    const file = extracted.files[0];
    const hunk = file.hunks[0];

    // 3 context + (del, add) + 3 context — nothing else
    expect(hunk.lines).toHaveLength(8);
    expect(hunk.contextTruncated).toBe(false);
    expect(hunk.lines[3]).toEqual({ type: 'del', content: 'line15', oldLineNumber: 15 });
    expect(hunk.lines[4]).toEqual({ type: 'add', content: 'line15 changed', newLineNumber: 15 });

    expect(file.minimalPatch).toContain('line15 changed');
    expect(file.minimalPatch).toContain(' line12\n');
    expect(file.minimalPatch).toContain(' line18\n');
    // never the whole file
    expect(file.minimalPatch).not.toContain(' line1\n');
    expect(file.minimalPatch).not.toContain(' line30\n');
  });

  it('honors a configurable contextLines value', async () => {
    const git = await initRepo();
    const body = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile('big.ts', `${body}\n`);
    await git.add('big.ts');
    await git.commit('initial');
    await writeFile('big.ts', `${body.replace('line15', 'line15 changed')}\n`);
    await git.add('big.ts');

    const extracted = await extractDiff(tmpRoot, { contextLines: 1 });
    const lines = extracted.files[0].hunks[0].lines;
    expect(lines.map((l) => l.content)).toEqual([
      'line14',
      'line15',
      'line15 changed',
      'line16',
    ]);
  });
});

describe('extractDiff — truncation guard', () => {
  it('flags a truncated diff explicitly and omits whole files', async () => {
    const git = await initRepo();
    for (let f = 0; f < 8; f++) {
      await writeFile(`src/file${f}.ts`, 'v1\n');
    }
    await git.add('src');
    await git.commit('initial');
    for (let f = 0; f < 8; f++) {
      await writeFile(`src/file${f}.ts`, `v2 of file ${f}\n${'padding\n'.repeat(20)}`);
    }
    await git.add('src');

    const full = await extractDiff(tmpRoot);
    expect(full.files).toHaveLength(8);
    expect(full.truncated).toBe(false);

    const maxBytes = Math.floor(full.totalBytes / 2);
    const cut = await extractDiff(tmpRoot, { maxBytes });
    expect(cut.truncated).toBe(true);
    expect(cut.totalBytes).toBe(full.totalBytes);
    expect(cut.omittedPaths.length).toBeGreaterThan(0);
    expect(cut.files.length).toBeGreaterThan(0);
    expect(cut.files.length).toBeLessThan(8);
    expect(Buffer.byteLength(cut.raw, 'utf-8')).toBeLessThanOrEqual(maxBytes);
    // included files are still fully parsed, never half a patch
    for (const file of cut.files) {
      expect(file.status).toBe('modified');
      expect(file.linesAdded).toBeGreaterThan(0);
    }
  });

  it('cuts a single oversized file at the byte limit and still flags it', async () => {
    const git = await initRepo();
    await writeFile('huge.ts', 'v1\n');
    await git.add('huge.ts');
    await git.commit('initial');
    await writeFile('huge.ts', `${'a line of padding\n'.repeat(200)}`);
    await git.add('huge.ts');

    const cut = await extractDiff(tmpRoot, { maxBytes: 500 });
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.raw, 'utf-8')).toBeLessThanOrEqual(500);
    expect(cut.files.length).toBe(1);
  });
});
