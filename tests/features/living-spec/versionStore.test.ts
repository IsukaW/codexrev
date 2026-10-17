import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptPatch,
  listVersionSnapshots,
  recordVersion,
} from '../../../src/features/living-spec/pipeline/versionStore.js';
import { seedUrsDocument } from '../../../src/features/living-spec/pipeline/ursModel.js';
import {
  readUrsDocument,
  readUrsState,
  ursMarkdownPath,
} from '../../../src/features/living-spec/tools/stateStore.js';
import type {
  ScopedUrsPatch,
  UrsDocument,
} from '../../../src/features/living-spec/pipeline/types.js';

const NOW = '2026-10-17T00:00:00.000Z';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-vstore-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function addPatch(id: string, text: string): ScopedUrsPatch {
  return {
    summary: `add ${id}`,
    ops: [
      {
        op: 'add',
        sectionId: id,
        section: {
          id,
          title: id,
          text,
          type: 'functional',
          version: 0,
          lastChangeId: 'chg',
          sourceRefs: [],
        },
        markdown: text,
      },
    ],
  };
}

async function seed(): Promise<UrsDocument> {
  const doc = seedUrsDocument();
  await recordVersion(tmpRoot, {
    changeId: 'seed',
    action: 'seed',
    timestamp: NOW,
    doc,
  });
  return doc;
}

describe('versionStore — accept bumps version and is traceable (NFR7)', () => {
  it('accept bumps the version and records a changeId-traceable snapshot', async () => {
    await seed();
    expect((await readUrsState(tmpRoot))?.version).toBe(1);

    const { version, snapshot } = await acceptPatch(tmpRoot, {
      changeId: 'chg-42',
      timestamp: NOW,
      patch: addPatch('req-new', 'New requirement body.'),
    });

    expect(version).toBe(2);
    expect(snapshot.version).toBe(2);
    expect(snapshot.changeId).toBe('chg-42');
    expect(snapshot.action).toBe('accept');
    expect(snapshot.timestamp).toBe(NOW);
    expect(snapshot.urs.sections.some((s) => s.id === 'req-new')).toBe(true);
    expect(snapshot.markdown).toContain('New requirement body.');

    expect((await readUrsState(tmpRoot))?.version).toBe(2);
    expect((await readUrsDocument(tmpRoot))?.sections.some((s) => s.id === 'req-new')).toBe(true);
  });

  it('history is append-only and keeps both snapshots traceable to their changeIds', async () => {
    await seed();
    await acceptPatch(tmpRoot, { changeId: 'chg-1', timestamp: NOW, patch: addPatch('req-a', 'A') });

    const snaps = await listVersionSnapshots(tmpRoot);
    expect(snaps.map((s) => s.version)).toEqual([1, 2]);
    expect(snaps.map((s) => s.changeId)).toEqual(['seed', 'chg-1']);
    expect(snaps.map((s) => s.action)).toEqual(['seed', 'accept']);
    // each snapshot carries the full urs.md/json state
    for (const s of snaps) {
      expect(s.urs.schemaVersion).toBe(1);
      expect(typeof s.markdown).toBe('string');
    }
  });
});

describe('versionStore — crash mid-write leaves the previous URS intact', () => {
  it('keeps the previous URS when the commit is interrupted (temp + rename)', async () => {
    const seedDoc = await seed();
    const prevMarkdown = await fs.readFile(ursMarkdownPath(tmpRoot), 'utf-8');
    const prevJson = await fs.readFile(path.join(tmpRoot, '.codexrev/living-spec/urs/urs.json'), 'utf-8');

    // Simulate a crash between the temp write and the rename/commit.
    await expect(
      acceptPatch(tmpRoot, {
        changeId: 'chg-crash',
        timestamp: NOW,
        patch: addPatch('req-crash', 'This must never land.'),
        beforeCommit: () => {
          throw new Error('simulated crash mid-write');
        },
      }),
    ).rejects.toThrow('simulated crash');

    // previous URS fully intact — never a half-written document
    expect(await fs.readFile(ursMarkdownPath(tmpRoot), 'utf-8')).toBe(prevMarkdown);
    expect(
      await fs.readFile(path.join(tmpRoot, '.codexrev/living-spec/urs/urs.json'), 'utf-8'),
    ).toBe(prevJson);
    expect(await readUrsDocument(tmpRoot)).toEqual(seedDoc);
    expect((await readUrsState(tmpRoot))?.version).toBe(1);

    // and the crashed update left no committed version snapshot
    const snaps = await listVersionSnapshots(tmpRoot);
    expect(snaps.map((s) => s.version)).toEqual([1]);
    expect(snaps.some((s) => s.changeId === 'chg-crash')).toBe(false);
  });
});
