// Test-only fixtures for the collector tests (temporary git repositories and fixed timestamps).
// Lives under testing/ like the review pipeline's fixtures, so tsc and the build treat it like any other source.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

export const NOW = '2025-01-10T12:00:00.000Z';
export const FRESH = '2025-01-10T06:00:00.000Z'; // 6 hours before NOW
export const STALE = '2024-12-01T00:00:00.000Z'; // far older than any limit

export interface TempRepo {
  readonly dir: string;
  readonly git: SimpleGit;
  write(rel: string, text: string): Promise<void>;
  remove(): Promise<void>;
  commitAll(message: string): Promise<void>;
  /** sha1 of every file under .git, to prove nothing there changed */
  snapshotGitDir(): Promise<Record<string, string>>;
}

export async function makeTempDir(prefix = 'codexrev-safety-'): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function makeRepo(): Promise<TempRepo> {
  const dir = await makeTempDir('codexrev-safety-repo-');
  const git = simpleGit({ baseDir: dir });
  await git.init();
  await git.addConfig('user.email', 'test@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Test');
  await git.addConfig('commit.gpgsign', 'false');

  const write = async (rel: string, text: string): Promise<void> => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, 'utf-8');
  };

  return {
    dir,
    git,
    write,
    remove: () => fs.rm(dir, { recursive: true, force: true }),
    async commitAll(message: string) {
      await git.add('.');
      await git.commit(message);
    },
    async snapshotGitDir() {
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
    },
  };
}

export const pkg = (deps: Record<string, string> = {}, dev: Record<string, string> = {}, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps, devDependencies: dev, ...extra }, null, 2) + '\n';

/**
 * Makes the shared configuration loader see an empty CodeXRev home and a cloud
 * provider, so a test that runs the real assess path can never reach (or
 * depend on) a model server on the developer's machine: a cloud provider is
 * refused as "not local" before anything is sent. Call the returned function to restore.
 */
export function isolateModelConfig(): () => void {
  const keys = ['CODEXREV_HOME', 'CODEXREV_PROVIDER', 'CODEXREV_MODEL', 'OLLAMA_BASE_URL', 'LMSTUDIO_BASE_URL', 'LITELLM_BASE_URL', 'OPENAI_BASE_URL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.CODEXREV_HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'codexrev-safety-home-'));
  process.env.CODEXREV_PROVIDER = 'openai';
  for (const k of ['CODEXREV_MODEL', 'OLLAMA_BASE_URL', 'LMSTUDIO_BASE_URL', 'LITELLM_BASE_URL', 'OPENAI_BASE_URL']) delete process.env[k];
  const home = process.env.CODEXREV_HOME;
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fsSync.rmSync(home, { recursive: true, force: true });
  };
}
