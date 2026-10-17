/**
 * Small, careful file helpers for the strict-authorization setup commands. Node built-ins only.
 *
 *  - writeNewFile      creates a file that must not exist: written to a staging file, fsynced, then
 *                      published with a hard link (which fails if the name exists), so a crash never
 *                      leaves a half-written file under the real name and nothing is overwritten.
 *  - replaceFile       replaces an existing file atomically (staging file + rename), for the revocation list.
 *  - readTextFile      reads a bounded regular file; links and other file types are refused.
 *  - isInsideGitWorktree  true if any ancestor directory contains a `.git` entry (no git process is run).
 *
 * Assumption, stated plainly: the directories involved are controlled by their owner. A directory that
 * someone else can replace while a command runs is outside what these helpers can defend.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class StrictCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictCliError';
  }
}

export const MAX_ARTIFACT_BYTES = 1_048_576;

const staging = (target: string): string => `${target}.${randomBytes(8).toString('hex')}.tmp`;

async function writeStaged(target: string, text: string, mode: number): Promise<string> {
  const tmp = staging(target);
  const handle = await fs.open(tmp, 'wx', mode);
  try {
    await handle.writeFile(text, 'utf-8');
    await handle.sync();
  } catch (e) {
    await handle.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
  await handle.close();
  return tmp;
}

/** Creates `target`, which must not exist. Returns false (and changes nothing) when it already exists. */
export async function writeNewFile(target: string, text: string, mode = 0o644): Promise<boolean> {
  const tmp = await writeStaged(target, text, mode);
  try {
    await fs.link(tmp, target);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

/** Replaces `target` atomically: readers see the old file or the new one, never a partial file. */
export async function replaceFile(target: string, text: string, mode = 0o644): Promise<void> {
  const tmp = await writeStaged(target, text, mode);
  try {
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Reads a regular file of at most `maxBytes`. Symbolic links, directories and oversized files are refused. */
export async function readTextFile(p: string, label: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<string> {
  let st;
  try {
    st = await fs.lstat(p);
  } catch {
    throw new StrictCliError(`${label} not found`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new StrictCliError(`${label} is not a regular file`);
  if (st.size > maxBytes) throw new StrictCliError(`${label} is too large`);
  return fs.readFile(p, 'utf-8');
}

/** Like readTextFile but returns the exact bytes (for fingerprints). */
export async function readFileBytes(p: string, label: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<Buffer> {
  let st;
  try {
    st = await fs.lstat(p);
  } catch {
    throw new StrictCliError(`${label} not found`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new StrictCliError(`${label} is not a regular file`);
  if (st.size > maxBytes) throw new StrictCliError(`${label} is too large`);
  return fs.readFile(p);
}

export async function readJsonFile(p: string, label: string): Promise<unknown> {
  const text = await readTextFile(p, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new StrictCliError(`${label} is not valid JSON`);
  }
}

/** True if `p` or any ancestor contains a `.git` entry: the path would be inside a Git working tree. */
export async function isInsideGitWorktree(p: string): Promise<boolean> {
  let current = path.resolve(p);
  for (;;) {
    if (await pathExists(path.join(current, '.git'))) return true;
    const up = path.dirname(current);
    if (up === current) return false;
    current = up;
  }
}

/** True if `inner` is `outer` or lies inside it (compared on resolved absolute paths). */
export function isWithin(outer: string, inner: string): boolean {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
