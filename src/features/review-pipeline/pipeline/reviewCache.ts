// Reuse of a role's judgement when asking again could only give the same question.
//
// Key = the exact prompt the role would be sent (its own system prompt, the diff, the URS, what
// earlier roles found) + the model + a fingerprint of every non-ignored file in the working tree.
// The fingerprint matters because roles read files OUTSIDE the diff with their tools: the same diff
// next to a changed caller is a different question. Anything that changes the question changes the
// key, so a hit is never a stale answer — it is the answer that would have been asked for anyway.
// (What it does give up is a second, differently-worded opinion on identical input; --no-cache asks again.)
//
// Lives in .codexrev/review-pipeline/cache/, one small JSON per judgement. Failures are never stored.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { validateRoleOutput, type RoleOutput } from '../roles/roleContract.js';

const CACHE_VERSION = 'v1';
const MAX_ENTRIES = 300;
const MAX_HASHED_FILE_BYTES = 2 * 1024 * 1024;

export interface RoleCache {
  keyFor(parts: { model: string; systemInstruction: string; userPrompt: string }): Promise<string | null>;
  get(key: string): Promise<RoleOutput | null>;
  put(key: string, output: RoleOutput): Promise<void>;
  /** the working tree changed (the fix loop edited files) — fingerprint again on next use */
  refresh(): void;
}

const sha = (...parts: string[]): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex');
};

// sha256 over path + content of every tracked or untracked-but-not-ignored file; null outside a git repo
export async function fingerprintTree(cwd: string): Promise<string | null> {
  let listing: string;
  try {
    listing = await simpleGit({ baseDir: cwd }).raw(['ls-files', '-co', '--exclude-standard', '-z']);
  } catch {
    return null;
  }
  const files = [...new Set(listing.split('\0').filter((f) => f.length > 0 && !f.startsWith('.codexrev/')))].sort();
  const hashes = new Array<string>(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < files.length; i = next++) {
      const full = path.join(cwd, files[i]!);
      try {
        const stat = await fs.stat(full);
        hashes[i] = stat.size > MAX_HASHED_FILE_BYTES ? `big:${stat.size}:${stat.mtimeMs}` : sha(await fs.readFile(full, 'utf-8').catch(async () => (await fs.readFile(full)).toString('base64')));
      } catch {
        hashes[i] = 'missing'; // tracked but deleted in the working tree
      }
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  return sha(...files.flatMap((f, i) => [f, hashes[i]!]));
}

export function createRoleCache(cwd: string): RoleCache {
  const dir = path.join(cwd, '.codexrev', 'review-pipeline', 'cache');
  let fingerprint: Promise<string | null> | undefined;

  return {
    refresh: () => {
      fingerprint = undefined;
    },
    async keyFor({ model, systemInstruction, userPrompt }) {
      fingerprint ??= fingerprintTree(cwd);
      const tree = await fingerprint;
      return tree === null ? null : sha(CACHE_VERSION, model, systemInstruction, userPrompt, tree);
    },
    async get(key) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, `${key}.json`), 'utf-8')) as { output?: unknown };
        return validateRoleOutput(parsed.output);
      } catch {
        return null; // absent, unreadable or no longer a valid RoleOutput — just ask the model
      }
    },
    async put(key, output) {
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({ createdAt: new Date().toISOString(), output }), 'utf-8');
        const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
        if (names.length > MAX_ENTRIES) {
          const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(dir, n))).mtimeMs })));
          stats.sort((a, b) => a.t - b.t);
          await Promise.all(stats.slice(0, names.length - MAX_ENTRIES).map((s) => fs.rm(path.join(dir, s.n), { force: true })));
        }
      } catch {
        // a cache that cannot write is just a cache that does not help
      }
    },
  };
}
