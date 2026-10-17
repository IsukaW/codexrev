// Throwaway copy of the user's working tree, used by the --fix loop to try an
// edit and run the build/tests against it BEFORE anything touches the real project.
// Always removed again (cleanup() in the caller's finally, plus a best-effort sync
// removal on process exit if the CLI is killed mid-run).
//
// What is copied: the working tree as it is right now (so the user's uncommitted
// change is included), minus heavy/derived directories. node_modules is symlinked
// rather than copied so tests can run without a reinstall — which also means nothing
// may ever write through it, see fixAgent.ts's path guard.

import { promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DERIVED_DIRS } from '../../../core/toolchains/index.js';

// never copied (build output, caches — the toolchain registry's list); node_modules is symlinked separately below
const SKIP_DIRS = DERIVED_DIRS;

export interface Sandbox {
  /** absolute path of the copy */
  readonly dir: string;
  /** removes the copy (and only the copy — the node_modules symlink is unlinked, not followed) */
  cleanup(): Promise<void>;
}

export async function createSandbox(cwd: string): Promise<Sandbox> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-sandbox-')));
  const removeSync = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };
  process.once('exit', removeSync);

  try {
    await fs.cp(cwd, dir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => src === cwd || !SKIP_DIRS.has(path.basename(src)),
    });
    const nodeModules = path.join(cwd, 'node_modules');
    if (await exists(nodeModules)) {
      await fs.symlink(nodeModules, path.join(dir, 'node_modules'), 'dir');
    }
  } catch (err) {
    process.removeListener('exit', removeSync);
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }

  return {
    dir,
    cleanup: async () => {
      process.removeListener('exit', removeSync);
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
