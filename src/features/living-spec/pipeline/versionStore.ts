/**
 * Append-only version history for the living URS (NFR7).
 *
 * Every accepted update is recorded as a self-contained snapshot under
 * `versions/v<N>.json`: the resulting `urs.md` + `urs.json` plus traceability
 * metadata {version, changeId, timestamp, action}. The live URS pair is
 * committed via temp+rename so a crash mid-write never corrupts the previous
 * document — only a completed write replaces it.
 *
 * Updates are PATCH-based: the caller supplies a scoped `ScopedUrsPatch`, which
 * is applied to the current document (never regenerating the whole thing).
 */

import type {
  ScopedUrsPatch,
  SpecTimestamp,
  UrsDocument,
  UrsVersionAction,
  UrsVersionSnapshot,
} from './types.js';
import { applyPatch } from './ursPatcher.js';
import { renderUrsMarkdown, seedUrsDocument } from './ursModel.js';
import {
  readUrsDocument,
  readUrsState,
  versionPath,
  versionsDir,
  writeFileAtomic,
  writeUrsDocument,
  writeUrsState,
} from '../tools/stateStore.js';
import { promises as fs } from 'node:fs';

export interface RecordVersionParams {
  changeId: string;
  action: UrsVersionAction;
  timestamp: SpecTimestamp;
  doc: UrsDocument;
  markdown?: string;
  /** Explicit version (defaults to current + 1). */
  version?: number;
  /**
   * Test seam: runs after the live URS temp write, before its commit. Throwing
   * here simulates a crash mid-write and must leave the previous URS intact.
   */
  beforeCommit?: () => void | Promise<void>;
}

export interface RecordVersionResult {
  readonly version: number;
  readonly snapshot: UrsVersionSnapshot;
}

/**
 * Commits `doc` as the next URS version: writes the live pair (atomic), the
 * append-only snapshot, then bumps the version counter. Returns the recorded
 * version + snapshot.
 */
export async function recordVersion(
  projectRoot: string,
  params: RecordVersionParams,
): Promise<RecordVersionResult> {
  const state = await readUrsState(projectRoot);
  const version = params.version ?? (state?.version ?? 0) + 1;
  const markdown = params.markdown ?? renderUrsMarkdown(params.doc);

  const snapshot: UrsVersionSnapshot = {
    version,
    changeId: params.changeId,
    timestamp: params.timestamp,
    createdAt: params.timestamp,
    action: params.action,
    markdown,
    urs: params.doc,
  };

  // 1. live URS pair — atomic (temp + rename); fault seam here keeps the
  //    previous URS intact on a crash and leaves no orphan snapshot.
  await writeUrsDocument(projectRoot, params.doc, markdown, {
    beforeCommit: params.beforeCommit,
  });
  // 2. append-only history snapshot.
  await writeFileAtomic(versionPath(projectRoot, version), JSON.stringify(snapshot, null, 2));
  // 3. bump the monotonic version counter.
  await writeUrsState(projectRoot, {
    schemaVersion: 1,
    version,
    updatedAt: params.timestamp,
    lastDriftAlerts: state?.lastDriftAlerts ?? [],
  });

  return { version, snapshot };
}

export interface AcceptPatchParams {
  changeId: string;
  timestamp: SpecTimestamp;
  patch: ScopedUrsPatch;
  beforeCommit?: () => void | Promise<void>;
}

export interface AcceptPatchResult {
  readonly version: number;
  readonly snapshot: UrsVersionSnapshot;
  readonly doc: UrsDocument;
  readonly markdown: string;
}

/**
 * Applies an accepted scoped patch to the current URS and records the result
 * as the next version. Touches only the sections named in the patch (SO4).
 */
export async function acceptPatch(
  projectRoot: string,
  params: AcceptPatchParams,
): Promise<AcceptPatchResult> {
  const current = (await readUrsDocument(projectRoot)) ?? seedUrsDocument();
  const state = await readUrsState(projectRoot);
  const nextVersion = (state?.version ?? 0) + 1;

  const patched = applyPatch(current, params.patch, {
    version: nextVersion,
    changeId: params.changeId,
  });
  const markdown = renderUrsMarkdown(patched);

  const { version, snapshot } = await recordVersion(projectRoot, {
    changeId: params.changeId,
    action: 'accept',
    timestamp: params.timestamp,
    doc: patched,
    markdown,
    version: nextVersion,
    beforeCommit: params.beforeCommit,
  });

  return { version, snapshot, doc: patched, markdown };
}

/** Reads one version snapshot (or null when absent). */
export async function readVersionSnapshot(
  projectRoot: string,
  version: number,
): Promise<UrsVersionSnapshot | null> {
  try {
    const raw = await fs.readFile(versionPath(projectRoot, version), 'utf-8');
    return JSON.parse(raw) as UrsVersionSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** All version snapshots, oldest first (append-only history). */
export async function listVersionSnapshots(
  projectRoot: string,
): Promise<readonly UrsVersionSnapshot[]> {
  let names: string[];
  try {
    names = await fs.readdir(versionsDir(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: UrsVersionSnapshot[] = [];
  for (const name of names) {
    const m = /^v(\d+)\.json$/.exec(name);
    if (!m) continue;
    const snap = await readVersionSnapshot(projectRoot, Number(m[1]));
    if (snap) out.push(snap);
  }
  return out.sort((a, b) => a.version - b.version);
}
