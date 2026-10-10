// Powers /checkpoint and /rewind. Uses a shadow git repo per session
// (~/.codexrev/checkpoints/<session-id>/) to snapshot files the agent has touched —
// file blob mirrors plus a JSON metadata entry per checkpoint. Paths get normalized
// relative to the user-supplied root, and commit() copies files into the shadow repo
// so a snapshot doesn't depend on the working directory still having them.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { simpleGit, type SimpleGit } from 'simple-git';

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

export interface CheckpointRecord {
  readonly id: string;
  readonly hash: string;
  readonly label: string;
  readonly createdAt: string;
  readonly files: ReadonlyArray<string>;
}

function isoNow(): string {
  return new Date().toISOString();
}

function newSessionId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export interface CheckpointOptions {
  /** defaults to a fresh random hex */
  sessionId?: string;
  rootDir: string;
}

export class CheckpointService {
  readonly sessionId: string;
  readonly rootDir: string;
  readonly shadowDir: string;
  readonly metadataFile: string;

  private git: SimpleGit | null;
  private initialised: Promise<void>;

  constructor(opts: CheckpointOptions) {
    this.sessionId = opts.sessionId ?? newSessionId();
    this.rootDir = path.resolve(opts.rootDir);
    const codexrevHome = path.join(os.homedir(), '.codexrev', 'checkpoints');
    this.shadowDir = path.join(codexrevHome, this.sessionId);
    this.metadataFile = path.join(this.shadowDir, 'meta.json');
    this.git = null as unknown as SimpleGit;
    this.initialised = this.init();
  }

  // sets up the shadow repo on first use; later calls just resolve the cached promise
  private async init(): Promise<void> {
    await fs.mkdir(this.shadowDir, { recursive: true });
    this.git = simpleGit({ baseDir: this.shadowDir });
    try {
      await this.git.raw(['rev-parse', '--git-dir']);
    } catch {
      await this.git.init();
      // needs its own commit identity, separate from whatever the user has configured
      await this.git.addConfig('user.email', 'codexrev@local', false, 'local');
      await this.git.addConfig('user.name', 'Codexrev Checkpoint', false, 'local');
      const readme = path.join(this.shadowDir, 'README');
      await fs.writeFile(readme, 'Codexrev shadow repo for session checkpoints.\n', 'utf8');
      await this.git.add('README');
      await this.git.commit('init: shadow checkpoint repo');
    }
  }

  private async readMeta(): Promise<Record<string, CheckpointRecord>> {
    try {
      const raw = await fs.readFile(this.metadataFile, 'utf8');
      return JSON.parse(raw) as Record<string, CheckpointRecord>;
    } catch {
      return {}; // no metadata file yet
    }
  }

  private async writeMeta(meta: Record<string, CheckpointRecord>): Promise<void> {
    await fs.writeFile(this.metadataFile, JSON.stringify(meta, null, 2), 'utf8');
  }

  // snapshots the given files: commits them into the shadow repo and records metadata
  async commit(label: string, files: ReadonlyArray<string>): Promise<CheckpointRecord> {
    await this.initialised;
    if (!this.git) throw new CheckpointError('checkpoint service not initialised');
    const git = this.git;
    if (!label.trim()) throw new CheckpointError('checkpoint label cannot be empty');
    if (files.length === 0) throw new CheckpointError('no files to checkpoint');

    const id = crypto.randomBytes(6).toString('hex');
    const rels: string[] = [];

    for (const f of files) {
      const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(this.rootDir, f);
      if (!abs.startsWith(this.rootDir)) {
        throw new CheckpointError(`file outside rootDir: ${f}`);
      }
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      const rel = path.relative(this.rootDir, abs).replace(/\\/g, '/');
      const dst = path.join(this.shadowDir, 'files', rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(abs, dst);
      rels.push(rel);
    }

    if (rels.length === 0) throw new CheckpointError('all files missing');

    await fs.mkdir(path.join(this.shadowDir, 'files'), { recursive: true });
    await git.add('files');

    // id goes in the commit subject so we can find it later
    await git.raw(['commit', '-m', `${id} ${label}`]);
    const fullHash = (await git.raw(['rev-parse', 'HEAD'])).trim();

    const record: CheckpointRecord = {
      id,
      hash: fullHash,
      label,
      createdAt: isoNow(),
      files: rels,
    };

    const meta = await this.readMeta();
    meta[id] = record;
    await this.writeMeta(meta);
    return record;
  }

  // restores files from a checkpoint, returns what actually got restored
  async restore(id: string): Promise<ReadonlyArray<string>> {
    await this.initialised;
    const meta = await this.readMeta();
    const record = meta[id];
    if (!record) throw new CheckpointError(`unknown checkpoint: ${id}`);

    const restored: string[] = [];
    for (const rel of record.files) {
      const src = path.join(this.shadowDir, 'files', rel);
      const dst = path.resolve(this.rootDir, rel);
      try {
        await fs.copyFile(src, dst);
        restored.push(rel);
      } catch {
        // file no longer exists in the shadow, skip it
      }
    }
    return restored;
  }

  // newest first
  async list(): Promise<ReadonlyArray<CheckpointRecord>> {
    await this.initialised;
    const meta = await this.readMeta();
    return Object.values(meta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // diffs a checkpoint's snapshot against the current working tree
  async diff(id: string): Promise<string> {
    await this.initialised;
    const meta = await this.readMeta();
    const record = meta[id];
    if (!record) throw new CheckpointError(`unknown checkpoint: ${id}`);

    const out: string[] = [];
    for (const rel of record.files) {
      const src = path.join(this.shadowDir, 'files', rel);
      const dst = path.resolve(this.rootDir, rel);
      const [before, after] = await Promise.all([
        fs.readFile(src, 'utf8').catch(() => ''),
        fs.readFile(dst, 'utf8').catch(() => ''),
      ]);
      if (before === after) continue;
      out.push(`--- ${rel}`);
      out.push(`+++ ${rel}`);
      // quick line-level diff, nothing fancy
      const beforeLines = before.split(/\r?\n/);
      const afterLines = after.split(/\r?\n/);
      const max = Math.max(beforeLines.length, afterLines.length);
      for (let i = 0; i < max; i++) {
        const b = beforeLines[i] ?? '';
        const a = afterLines[i] ?? '';
        if (b === a) out.push(` ${b}`);
        else {
          if (b) out.push(`-${b}`);
          if (a) out.push(`+${a}`);
        }
      }
    }
    return out.join('\n');
  }

  // deletes metadata only, the shadow commit itself stays around
  async remove(id: string): Promise<void> {
    await this.initialised;
    const meta = await this.readMeta();
    if (!meta[id]) throw new CheckpointError(`unknown checkpoint: ${id}`);
    delete meta[id];
    await this.writeMeta(meta);
  }
}

export function openCheckpoints(opts?: { sessionId?: string; rootDir?: string }): CheckpointService {
  return new CheckpointService({
    sessionId: opts?.sessionId,
    rootDir: opts?.rootDir ?? process.cwd(),
  });
}