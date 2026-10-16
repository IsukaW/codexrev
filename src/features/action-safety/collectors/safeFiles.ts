/**
 * Safe, read-only file access for collectors. Report paths come from a user
 * supplied input file, so they are treated as untrusted:
 *   - the real path (symlinks resolved) must stay inside the project directory
 *   - only regular files, below a size cap
 *   - failures return a short reason; file contents never appear in messages
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export type SafeReadResult =
  | { readonly ok: true; readonly text: string; readonly modifiedAt: string; readonly absolutePath: string }
  | { readonly ok: false; readonly reason: string; readonly absolutePath: string };

export async function readProjectTextFile(root: string, userPath: string, maxBytes: number): Promise<SafeReadResult> {
  const absolutePath = path.resolve(root, userPath);
  const fail = (reason: string): SafeReadResult => ({ ok: false, reason, absolutePath });

  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return fail('project directory is not accessible');
  }

  let realFile: string;
  try {
    realFile = await fs.realpath(absolutePath);
  } catch (err) {
    return fail((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : 'file is not accessible');
  }

  const rel = path.relative(realRoot, realFile);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return fail('path is outside the project directory');
  }

  try {
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) return fail('not a regular file');
    if (stat.size > maxBytes) return fail(`file is larger than the ${maxBytes}-byte limit`);
    const text = await fs.readFile(realFile, 'utf-8');
    return { ok: true, text, modifiedAt: stat.mtime.toISOString(), absolutePath };
  } catch {
    return fail('file could not be read');
  }
}
