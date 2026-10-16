/**
 * Feature 3 / Function 1 — minimal read-only filesystem abstraction (Phase P1).
 *
 * Function 1 analyzes and plans; it must NEVER modify the target project.
 * All future analysis phases read through `ReadOnlyFs`; every write-named
 * method throws unconditionally, and reads are confined to the project root.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { CodexrevError } from '../../../utils/errors.js';

export class ReadOnlyViolationError extends CodexrevError {
  constructor(operation: string) {
    super(
      `write operation '${operation}' is not permitted: analysis is read-only with respect to the target project`,
      'CODEXREV_MIGRATION_READ_ONLY',
      false,
    );
    this.name = 'ReadOnlyViolationError';
  }
}

export class PathEscapeError extends CodexrevError {
  constructor(target: string, root: string) {
    super(
      `path '${target}' resolves outside the read-only project root '${root}'`,
      'CODEXREV_MIGRATION_PATH_ESCAPE',
      false,
    );
    this.name = 'PathEscapeError';
  }
}

export interface ReadOnlyDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export class ReadOnlyFs {
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = path.resolve(projectRoot);
  }

  /** Resolve `target` against the root; throw if it escapes the root. */
  private resolveWithin(target: string): string {
    const resolved = path.resolve(this.root, target);
    const rel = path.relative(this.root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PathEscapeError(resolved, this.root);
    }
    return resolved;
  }

  async readFile(target: string): Promise<string> {
    return fsp.readFile(this.resolveWithin(target), 'utf-8');
  }

  async exists(target: string): Promise<boolean> {
    try {
      await fsp.stat(this.resolveWithin(target));
      return true;
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      return false;
    }
  }

  async listDir(target: string): Promise<string[]> {
    return fsp.readdir(this.resolveWithin(target));
  }

  /** Directory entries with type flags (additive in P4 — needed for
   *  symlink-aware, read-only source discovery). */
  async listDirEntries(target: string): Promise<readonly ReadOnlyDirEntry[]> {
    const entries = await fsp.readdir(this.resolveWithin(target), { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      isSymbolicLink: e.isSymbolicLink(),
    }));
  }

  async writeFile(_target: string, _content: string): Promise<never> {
    throw new ReadOnlyViolationError('writeFile');
  }

  async appendFile(_target: string, _content: string): Promise<never> {
    throw new ReadOnlyViolationError('appendFile');
  }

  async mkdir(_target: string): Promise<never> {
    throw new ReadOnlyViolationError('mkdir');
  }

  async remove(_target: string): Promise<never> {
    throw new ReadOnlyViolationError('remove');
  }
}
