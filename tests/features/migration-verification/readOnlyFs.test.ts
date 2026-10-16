import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PathEscapeError,
  ReadOnlyFs,
  ReadOnlyViolationError,
} from '../../../src/features/migration-verification/analysis/readOnlyFs.js';

let tmpRoot: string;
let fixtureFile: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-mv-fs-'));
  tmpRoot = await fs.realpath(raw);
  fixtureFile = path.join(tmpRoot, 'a.txt');
  await fs.writeFile(fixtureFile, 'hello');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('ReadOnlyFs — reads', () => {
  it('reads a file inside the project root', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    await expect(ro.readFile('a.txt')).resolves.toBe('hello');
  });

  it('reports existence inside the root', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    await expect(ro.exists('a.txt')).resolves.toBe(true);
    await expect(ro.exists('missing.txt')).resolves.toBe(false);
  });

  it('lists a directory inside the root', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    await expect(ro.listDir('.')).resolves.toContain('a.txt');
  });

  it('rejects reads that escape the project root', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    const outside = path.join(os.tmpdir(), 'codexrev-mv-outside.txt');
    await expect(ro.readFile(outside)).rejects.toBeInstanceOf(PathEscapeError);
    await expect(ro.exists(outside)).rejects.toBeInstanceOf(PathEscapeError);
    await expect(ro.readFile(path.join('..', 'escape.txt'))).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe('ReadOnlyFs — write guarantees', () => {
  it('writeFile always throws ReadOnlyViolationError', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    await expect(ro.writeFile('a.txt', 'changed')).rejects.toBeInstanceOf(ReadOnlyViolationError);
  });

  it('appendFile always throws ReadOnlyViolationError', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    await expect(ro.appendFile('a.txt', 'more')).rejects.toBeInstanceOf(ReadOnlyViolationError);
  });

  it('mkdir always throws ReadOnlyViolationError', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    await expect(ro.mkdir('new-dir')).rejects.toBeInstanceOf(ReadOnlyViolationError);
  });

  it('remove always throws ReadOnlyViolationError', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    await expect(ro.remove('a.txt')).rejects.toBeInstanceOf(ReadOnlyViolationError);
  });

  it('attempted writes leave the project unchanged', async () => {
    const ro = new ReadOnlyFs(tmpRoot);
    await expect(ro.writeFile('a.txt', 'changed')).rejects.toThrow('read-only');
    await expect(ro.remove('a.txt')).rejects.toThrow();
    const after = await fs.readFile(fixtureFile, 'utf-8');
    expect(after).toBe('hello');
  });
});
