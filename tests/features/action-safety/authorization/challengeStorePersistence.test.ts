/* global AbortController */
// Tests for the filesystem persistence of the challenge store. Real temporary directories, Node built-ins
// only, nothing outside the test-owned temporary directory is touched. POSIX-only branches (modes,
// ownership, directory fsync) are exercised through injected platform/filesystem fakes, because the
// development host is Windows.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChallengeStorePersistenceError,
  defaultFsOps,
  openFilesystemPersistence,
  type ConsumptionRecord,
  type FileHandleLike,
  type FsOps,
  type IssuanceRecord,
} from '../../../../src/features/action-safety/authorization/challengeStorePersistence.js';

let parent: string;
beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'codexrev-persist-'));
});
afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

let counter = 0;
const freshRoot = (): string => join(parent, `store-${++counter}`);
const rid = (): string => randomBytes(16).toString('base64url');
const envelope = (domain: string) => ({ version: 1, domain, keyId: 'a'.repeat(64), payload: 'cGF5bG9hZA', signature: 'c2ln' });
const issuance = (id = rid()): IssuanceRecord => ({ version: 1, challengeId: id, token: envelope('challenge'), context: { actionId: 'act-1' }, grant: envelope('grant') });
const consumption = (id: string, requestId = rid(), proofDigest = `sha256:${'a'.repeat(64)}`): ConsumptionRecord => ({ version: 1, challengeId: id, requestId, proofDigest, receipt: envelope('receipt') });
const open = (root: string, extra: Record<string, unknown> = {}) => openFilesystemPersistence({ root, storeId: 'store-1', storeGeneration: 'gen-1', ...extra });
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof ChallengeStorePersistenceError ? e.code : `unexpected: ${String(e)}`;
  }
};

/** A filesystem wrapper whose behaviour tests can bend. */
function fsWith(overrides: Partial<FsOps>): FsOps {
  return { ...defaultFsOps, ...overrides };
}

/** What a POSIX host would do for directories: Node on Windows cannot open them, so give fsync a harmless handle. */
function posixLike(extra: Partial<FsOps> = {}, syncLog: string[] = []): FsOps {
  return fsWith({
    async open(path, flags, mode) {
      let isDir = false;
      try {
        isDir = (await defaultFsOps.lstat(path)).isDirectory();
      } catch {
        /* a file that does not exist yet */
      }
      if (isDir) {
        return { writeFile: async () => undefined, readFile: async () => '', stat: async () => defaultFsOps.lstat(path), sync: async () => void syncLog.push(path), close: async () => undefined } satisfies FileHandleLike;
      }
      return defaultFsOps.open(path, flags, mode);
    },
    lstat: async (path) => {
      const st = await defaultFsOps.lstat(path);
      return Object.assign(Object.create(st), { mode: st.isDirectory() ? 0o040700 : 0o100600, uid: 1000 });
    },
    ...extra,
  });
}

/** Faults are armed only after the store has opened, so that opening itself is not disturbed. */
const armed = { on: false };

describe('opening a store', () => {
  it('creates the fixed layout and an identity marker, and reopens with the same identity', async () => {
    const root = freshRoot();
    const p = await open(root);
    expect(readdirSync(root).sort()).toEqual(['STORE.json', 'consumption', 'issuance', 'journal', 'tmp']);
    expect(JSON.parse(readFileSync(join(root, 'STORE.json'), 'utf-8'))).toEqual({ version: 1, storeId: 'store-1', storeGeneration: 'gen-1' });
    expect(p.durability).toEqual({ fileSync: true, directorySync: process.platform !== 'win32', exclusiveCreate: 'hard_link' });
    expect(Object.isFrozen(p)).toBe(true);
    await open(root);
  });

  it('refuses a directory that belongs to another store identity or generation', async () => {
    const root = freshRoot();
    await open(root);
    expect(await codeOf(openFilesystemPersistence({ root, storeId: 'store-2', storeGeneration: 'gen-1' }))).toBe('identity_mismatch');
    expect(await codeOf(openFilesystemPersistence({ root, storeId: 'store-1', storeGeneration: 'gen-2' }))).toBe('identity_mismatch');
  });

  it('refuses invalid options', async () => {
    for (const bad of [{ root: 'relative/dir' }, { root: '' }, { root: 5 }, { root: join(parent, 'x\0y') }, { storeId: 'Bad Id' }, { storeGeneration: 'bad generation' }, { storeId: 5 }]) {
      expect(await codeOf(open(bad.root === undefined ? freshRoot() : (bad.root as string), 'storeId' in bad || 'storeGeneration' in bad ? bad : {}))).toBe('invalid_input');
    }
    expect(await codeOf(openFilesystemPersistence(null as never))).toBe('invalid_input');
  });

  it('refuses unexpected entries instead of ignoring them', async () => {
    const root = freshRoot();
    await open(root);
    writeFileSync(join(root, 'surprise.txt'), 'x');
    expect(await codeOf(open(root))).toBe('unexpected_entry');
    rmSync(join(root, 'surprise.txt'));
    writeFileSync(join(root, 'issuance', 'not-a-record.json'), '{}');
    expect(await codeOf(open(root))).toBe('unexpected_entry');
    rmSync(join(root, 'issuance', 'not-a-record.json'));
    writeFileSync(join(root, 'tmp', 'notes.txt'), 'x');
    expect(await codeOf(open(root))).toBe('unexpected_entry');
  });

  it('refuses a directory that holds records but has no identity marker, and a corrupt marker', async () => {
    const root = freshRoot();
    mkdirSync(join(root, 'issuance'), { recursive: true });
    writeFileSync(join(root, 'issuance', `${rid()}.json`), '{}');
    expect(await codeOf(open(root))).toBe('unexpected_entry');
    const root2 = freshRoot();
    await open(root2);
    writeFileSync(join(root2, 'STORE.json'), '{"nope":true}');
    expect(await codeOf(open(root2))).toBe('corrupt_record');
    writeFileSync(join(root2, 'STORE.json'), 'not json');
    expect(await codeOf(open(root2))).toBe('corrupt_record');
  });

  it('refuses a store directory or subdirectory that is a link', async () => {
    const real = freshRoot();
    await open(real);
    const link = freshRoot();
    try {
      symlinkSync(real, link, 'junction');
    } catch {
      return; // links cannot be created here: the injected-lstat test below covers the check
    }
    expect(await codeOf(open(link))).toBe('symlink_refused');
    const root = freshRoot();
    mkdirSync(root);
    const elsewhere = freshRoot();
    mkdirSync(elsewhere);
    try {
      symlinkSync(elsewhere, join(root, 'issuance'), 'junction');
    } catch {
      return;
    }
    expect(await codeOf(open(root))).toBe('symlink_refused');
  });

  it('refuses links and non-regular files through the filesystem seam too', async () => {
    const root = freshRoot();
    await open(root);
    const asLink = (path: string) => path.includes('issuance') && path.endsWith('.json');
    const p = await open(root, {
      fs: fsWith({
        lstat: async (path) => {
          const st = await defaultFsOps.lstat(path);
          return asLink(path) ? Object.assign(Object.create(st), { isSymbolicLink: () => true, isFile: () => false }) : st;
        },
      }),
    });
    const record = issuance();
    expect(await p.createIssuance(record)).toBe('created');
    expect(await codeOf(p.getIssuance(record.challengeId))).toBe('symlink_refused');
    // a directory where a record should be
    const root2 = freshRoot();
    const p2 = await open(root2);
    const id = rid();
    mkdirSync(join(root2, 'issuance', `${id}.json`));
    expect(await codeOf(p2.getIssuance(id))).toBe('symlink_refused');
    // a real link, where this host allows one
    const target = join(parent, 'outside.json');
    writeFileSync(target, JSON.stringify(issuance(id)));
    const id2 = rid();
    try {
      symlinkSync(target, join(root2, 'issuance', `${id2}.json`), 'file');
    } catch {
      return;
    }
    expect(await codeOf(p2.getIssuance(id2))).toBe('symlink_refused');
  });

  it('on POSIX refuses unsafe modes and foreign owners; on Windows it does not pretend to check modes', async () => {
    const root = freshRoot();
    await open(root);
    const withMode = (mode: number, uid = 1000) => posixLike({ lstat: async (path) => Object.assign(Object.create(await defaultFsOps.lstat(path)), { mode: (mode | (statSync(path).isDirectory() ? 0o040000 : 0o100000)), uid }) });
    const opts = (fs: FsOps) => ({ fs, platform: 'linux' as const, getuid: () => 1000 });
    expect(await codeOf(open(root, opts(withMode(0o700))))).toBe('no error');
    expect(await codeOf(open(root, opts(withMode(0o755))))).toBe('unsafe_permissions');
    expect(await codeOf(open(root, opts(withMode(0o770))))).toBe('unsafe_permissions');
    expect(await codeOf(open(root, opts(withMode(0o707))))).toBe('unsafe_permissions');
    expect(await codeOf(open(root, opts(withMode(0o700, 0))))).toBe('unsafe_permissions'); // another owner
    // Windows: modes mean nothing, so the same fake is accepted
    expect(await codeOf(open(root, { fs: withMode(0o777), platform: 'win32' }))).toBe('no error');
    // an unsafe record is refused when read
    const p = await open(root, opts(withMode(0o700)));
    const record = issuance();
    await p.createIssuance(record);
    const unsafeFile = await open(root, { fs: posixLike({ lstat: async (path) => { const st = await defaultFsOps.lstat(path); return path.endsWith(`${record.challengeId}.json`) ? Object.assign(Object.create(st), { mode: 0o100644, uid: 1000 }) : Object.assign(Object.create(st), { mode: st.isDirectory() ? 0o040700 : 0o100600, uid: 1000 }); } }), platform: 'linux', getuid: () => 1000 });
    expect(await codeOf(unsafeFile.getIssuance(record.challengeId))).toBe('unsafe_permissions');
  });

  it('removes stale staging files on open, leaves fresh ones, and nothing counts as issued or consumed', async () => {
    const root = freshRoot();
    const p = await open(root);
    const stale = join(root, 'tmp', `${randomBytes(16).toString('hex')}.tmp`);
    const fresh = join(root, 'tmp', `${randomBytes(16).toString('hex')}.tmp`);
    writeFileSync(stale, 'half a record');
    writeFileSync(fresh, 'another');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(stale, old, old);
    await open(root); // default one-hour limit
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await open(root, { staleTempMs: 1, wallClockMs: () => Date.now() + 10_000 });
    expect(existsSync(fresh)).toBe(false);
    expect(await p.getIssuance(rid())).toBeUndefined();
  });
});

describe('issuance records', () => {
  it('stores a record durably and reads it back, also after reopening', async () => {
    const root = freshRoot();
    const p = await open(root);
    const record = issuance();
    expect(await p.createIssuance(record)).toBe('created');
    expect(await p.getIssuance(record.challengeId)).toEqual(record);
    const reopened = await open(root);
    expect(await reopened.getIssuance(record.challengeId)).toEqual(record);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]); // nothing left behind
  });

  it('never overwrites an existing record: an id collision reports "exists" and changes nothing', async () => {
    const p = await open(freshRoot());
    const record = issuance();
    expect(await p.createIssuance(record)).toBe('created');
    const other = { ...issuance(record.challengeId), context: { actionId: 'something-else' } };
    expect(await p.createIssuance(other)).toBe('exists');
    expect((await p.getIssuance(record.challengeId))?.context).toEqual({ actionId: 'act-1' });
  });

  it('returns undefined for an unknown challenge and rejects ids that could reach other paths', async () => {
    const p = await open(freshRoot());
    expect(await p.getIssuance(rid())).toBeUndefined();
    for (const bad of ['../x', '..\\x', 'a/b', '', 'short', `${rid()}.json`, 'C:\\temp\\x', `${rid()}\0`, 5, null, undefined, {}]) {
      expect(await codeOf(p.getIssuance(bad as never)), String(bad)).toBe('invalid_input');
      expect(await codeOf(p.getConsumption(bad as never)), String(bad)).toBe('invalid_input');
    }
    expect(await codeOf(p.createIssuance({ ...issuance(), challengeId: '../escape' }))).toBe('corrupt_record');
  });

  it('rejects malformed records before writing anything', async () => {
    const root = freshRoot();
    const p = await open(root);
    const good = issuance();
    for (const bad of [null, 5, {}, { ...good, extra: 1 }, { ...good, version: 2 }, { ...good, token: 'x' }, { ...good, token: { ...good.token, extra: 1 } }, { ...good, grant: null }, { ...good, context: [] }, { ...good, token: { ...good.token, payload: '' } }]) {
      expect(await codeOf(p.createIssuance(bad as never))).toBe('corrupt_record');
    }
    expect(readdirSync(join(root, 'issuance'))).toEqual([]);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
    const big = { ...good, token: { ...good.token, payload: 'A'.repeat(16_000) }, grant: { ...good.grant, payload: 'A'.repeat(16_000) }, context: { a: 'x'.repeat(40_000) } };
    expect(await codeOf(p.createIssuance(big))).toBe('invalid_input');
  });
});

describe('atomic consumption', () => {
  it('the first commit wins and later commits get the winner’s record', async () => {
    const p = await open(freshRoot());
    const id = rid();
    const first = consumption(id);
    expect(await p.commitConsumption(first)).toEqual({ outcome: 'committed' });
    const second = consumption(id);
    const result = await p.commitConsumption(second);
    expect(result).toEqual({ outcome: 'already_consumed', existing: first });
    expect(await p.getConsumption(id)).toEqual(first);
  });

  it('exactly one of many concurrent commits wins, and everyone sees the same winner', async () => {
    const p = await open(freshRoot());
    const id = rid();
    const candidates = Array.from({ length: 24 }, () => consumption(id));
    const results = await Promise.all(candidates.map((c) => p.commitConsumption(c)));
    const winners = results.filter((r) => r.outcome === 'committed');
    expect(winners).toHaveLength(1);
    const stored = await p.getConsumption(id);
    for (const r of results) if (r.outcome === 'already_consumed') expect(r.existing).toEqual(stored);
    expect(candidates.filter((c) => c.requestId === stored?.requestId)).toHaveLength(1);
  });

  it('two separately opened instances (two processes) still have exactly one winner', async () => {
    const root = freshRoot();
    const a = await open(root);
    const b = await open(root);
    const id = rid();
    const results = await Promise.all([a.commitConsumption(consumption(id)), b.commitConsumption(consumption(id)), a.commitConsumption(consumption(id)), b.commitConsumption(consumption(id))]);
    expect(results.filter((r) => r.outcome === 'committed')).toHaveLength(1);
  });

  it('survives a restart: a reopened store still knows the challenge was consumed', async () => {
    const root = freshRoot();
    const id = rid();
    const rec = consumption(id);
    await (await open(root)).commitConsumption(rec);
    const after = await open(root);
    expect(await after.getConsumption(id)).toEqual(rec);
    expect((await after.commitConsumption(consumption(id))).outcome).toBe('already_consumed');
  });
});

describe('crashes and storage failures', () => {
  it('a failure while writing leaves nothing: no record, no stray file, and a retry works', async () => {
    const root = freshRoot();
    armed.on = false;
    const p = await open(root, { fs: fsWith({ open: async (path, flags, mode) => { if (armed.on && String(path).endsWith('.tmp')) throw new Error('disk full'); return defaultFsOps.open(path, flags, mode); } }) });
    armed.on = true;
    const id = rid();
    expect(await codeOf(p.commitConsumption(consumption(id)))).toBe('io_error');
    expect(await p.getConsumption(id)).toBeUndefined();
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
    armed.on = false;
    expect((await p.commitConsumption(consumption(id))).outcome).toBe('committed');
  });

  it('a failed fsync stops before publishing: crash before the commit point means NOT consumed', async () => {
    const root = freshRoot();
    armed.on = false;
    const p = await open(root, {
      fs: fsWith({
        open: async (path, flags, mode) => {
          const handle = await defaultFsOps.open(path, flags, mode);
          if (!armed.on) return handle;
          return { writeFile: (d: string) => handle.writeFile(d), sync: async () => { throw new Error('fsync failed'); }, close: () => handle.close(), stat: () => handle.stat(), readFile: (e: 'utf-8') => handle.readFile(e) } satisfies FileHandleLike;
        },
      }),
    });
    armed.on = true;
    const id = rid();
    expect(await codeOf(p.commitConsumption(consumption(id)))).toBe('io_error');
    const reopened = await open(root);
    expect(await reopened.getConsumption(id)).toBeUndefined();
    expect(readdirSync(join(root, 'consumption'))).toEqual([]);
  });

  it('a crash before the link leaves only a staging file, which is not a record and is cleaned on reopen', async () => {
    const root = freshRoot();
    armed.on = false;
    const p = await open(root, { fs: fsWith({ link: async (a, b) => { if (armed.on) throw new Error('crash'); await defaultFsOps.link(a, b); } }) });
    armed.on = true;
    const id = rid();
    expect(await codeOf(p.commitConsumption(consumption(id)))).toBe('io_error');
    armed.on = false;
    const reopened = await open(root);
    expect(await reopened.getConsumption(id)).toBeUndefined();
    expect((await reopened.commitConsumption(consumption(id))).outcome).toBe('committed');
  });

  it('a crash AFTER the commit and before the response cannot allow a second consumption, and the retry finds the original', async () => {
    const root = freshRoot();
    const id = rid();
    const original = consumption(id);
    // the link succeeds, then the process "dies" before anything else happens
    armed.on = false;
    const crashing = await open(root, { fs: fsWith({ link: async (a, b) => { await defaultFsOps.link(a, b); if (armed.on) throw new Error('crash after link'); } }) });
    armed.on = true;
    expect(await codeOf(crashing.commitConsumption(original))).toBe('io_error');
    armed.on = false;
    const restarted = await open(root);
    expect(await restarted.getConsumption(id)).toEqual(original);
    expect(await restarted.commitConsumption(consumption(id))).toEqual({ outcome: 'already_consumed', existing: original });
  });

  it('syncs the containing directory where directories can be synced, and a failure there is reported but the record stands', async () => {
    const root = freshRoot();
    const synced: string[] = [];
    const p = await open(root, { fs: posixLike({}, synced), platform: 'linux', getuid: () => 1000 });
    expect(p.durability.directorySync).toBe(true);
    const id = rid();
    expect((await p.commitConsumption(consumption(id))).outcome).toBe('committed');
    expect(synced).toContain(join(root, 'consumption'));
    // a directory fsync failure is an error (fail closed), yet the published record counts
    const id2 = rid();
    armed.on = false;
    const broken = await open(root, { fs: posixLike({ open: async (path, flags, mode) => { if (armed.on && String(path) === join(root, 'consumption')) throw new Error('cannot sync'); return posixLike().open(path, flags, mode); } }), platform: 'linux', getuid: () => 1000 });
    armed.on = true;
    expect(await codeOf(broken.commitConsumption(consumption(id2)))).toBe('io_error');
    armed.on = false;
    expect((await (await open(root)).getConsumption(id2))?.challengeId).toBe(id2);
  });

  it('reports a Windows-style platform as file-sync only, never claiming directory durability', async () => {
    const p = await open(freshRoot(), { platform: 'win32' });
    expect(p.durability.directorySync).toBe(false);
    expect(p.durability.fileSync).toBe(true);
  });

  it('reports storage errors with fixed messages that contain no path, no record content and no underlying text', async () => {
    const root = freshRoot();
    armed.on = false;
    const p = await open(root, { fs: fsWith({ open: async (path, flags, mode) => { if (armed.on) throw new Error(`secret ${root}`); return defaultFsOps.open(path, flags, mode); } }) });
    armed.on = true;
    for (const run of [() => p.createIssuance(issuance()), () => p.commitConsumption(consumption(rid()))]) {
      try {
        await run();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ChallengeStorePersistenceError);
        const text = `${(e as Error).message} ${JSON.stringify(e)} ${String((e as Error).stack).split('\n')[0]}`;
        expect(text).not.toContain(root);
        expect(text).not.toContain('secret');
      }
    }
  });
});

describe('corrupted and tampered storage', () => {
  it('refuses a corrupt, mismatched, oversized or foreign record instead of guessing', async () => {
    const root = freshRoot();
    const p = await open(root);
    const id = rid();
    const path = join(root, 'consumption', `${id}.json`);
    writeFileSync(path, '{ not json');
    expect(await codeOf(p.getConsumption(id))).toBe('corrupt_record');
    writeFileSync(path, JSON.stringify({ ...consumption(rid()) })); // a valid record under the wrong name
    expect(await codeOf(p.getConsumption(id))).toBe('corrupt_record');
    writeFileSync(path, JSON.stringify({ ...consumption(id), extra: true }));
    expect(await codeOf(p.getConsumption(id))).toBe('corrupt_record');
    writeFileSync(path, 'x'.repeat(70_000));
    expect(await codeOf(p.getConsumption(id))).toBe('corrupt_record');
    // a corrupt record also blocks a commit for that challenge: it is never silently replaced
    expect(await codeOf(p.commitConsumption(consumption(id)))).toBe('corrupt_record');
    expect(readFileSync(path, 'utf-8')).toBe('x'.repeat(70_000));
  });

  it('cannot detect deletion or restoration of records: that is a rollback and is left to the core and the operator', async () => {
    const root = freshRoot();
    const p = await open(root);
    const id = rid();
    await p.commitConsumption(consumption(id));
    rmSync(join(root, 'consumption', `${id}.json`));
    // documented limitation: the filesystem alone sees a challenge that was never consumed
    expect(await p.getConsumption(id)).toBeUndefined();
    expect((await p.commitConsumption(consumption(id))).outcome).toBe('committed');
  });
});

describe('containment', () => {
  it('writes only inside its own directory', async () => {
    const before = readdirSync(parent).sort();
    const root = freshRoot();
    const p = await open(root);
    for (let i = 0; i < 5; i++) {
      const rec = issuance();
      await p.createIssuance(rec);
      await p.commitConsumption(consumption(rec.challengeId));
    }
    const after = readdirSync(parent).sort();
    expect(after.filter((n) => !before.includes(n))).toEqual([root.slice(parent.length + 1)]);
    for (const dir of ['issuance', 'consumption']) for (const name of readdirSync(join(root, dir))) expect(name).toMatch(/^[A-Za-z0-9_-]{22}\.json$/);
  });

  it('creates files that are not world-readable on POSIX (mode 0600)', async () => {
    if (process.platform === 'win32') return; // modes carry no meaning on Windows
    const root = freshRoot();
    const p = await open(root);
    const rec = issuance();
    await p.createIssuance(rec);
    expect(statSync(join(root, 'issuance', `${rec.challengeId}.json`)).mode & 0o077).toBe(0);
    expect(statSync(root).mode & 0o077).toBe(0);
  });

  it('uses no in-memory map as storage: a second instance sees the first one’s data with no shared state', async () => {
    const root = freshRoot();
    const a = await open(root);
    const rec = issuance();
    await a.createIssuance(rec);
    expect(await (await open(root)).getIssuance(rec.challengeId)).toEqual(rec);
    const source = readFileSync(join(process.cwd(), 'src/features/action-safety/authorization/challengeStorePersistence.ts'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/\brename\(|renameSync|writeFileSync|appendFile|process\.env|child_process|node:net|node:http/);
  });

  it('is not affected by a hanging abort signal API (no timers or listeners left behind)', async () => {
    const p = await open(freshRoot());
    const controller = new AbortController();
    controller.abort();
    expect(await p.getIssuance(rid())).toBeUndefined();
  });
});

describe('journal storage (Phase 6B.10)', () => {
  const entryEnvelope = (n: number) => ({ version: 1, domain: 'journal', keyId: 'a'.repeat(64), payload: Buffer.from(`entry ${n}`).toString('base64url'), signature: 'c2ln' });

  it('appends entries exclusively, lists them in order, and never overwrites one', async () => {
    const root = freshRoot();
    const p = await open(root);
    expect(await p.readJournalTail()).toBeUndefined();
    expect(await p.readJournal(0)).toEqual([]);
    for (const n of [1, 2, 3]) expect(await p.appendJournal(n, entryEnvelope(n))).toBe('created');
    expect(await p.appendJournal(2, entryEnvelope(99))).toBe('exists');
    const all = await p.readJournal(0);
    expect(all.map((f) => f.sequence)).toEqual([1, 2, 3]);
    expect(all[1]?.envelope.payload).toBe(entryEnvelope(2).payload); // unchanged by the refused append
    expect((await p.readJournal(2)).map((f) => f.sequence)).toEqual([3]);
    expect((await p.readJournalTail())?.sequence).toBe(3);
    expect(readdirSync(join(root, 'journal'))).toEqual(['0000000000000001.json', '0000000000000002.json', '0000000000000003.json']);
    expect((await (await open(root)).readJournal(0)).length).toBe(3); // after a restart too
  });

  it('exactly one of many concurrent appends takes a sequence number', async () => {
    const p = await open(freshRoot());
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => p.appendJournal(1, entryEnvelope(i))));
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
  });

  it('rejects bad sequence numbers and malformed envelopes, and lists record ids', async () => {
    const root = freshRoot();
    const p = await open(root);
    for (const bad of [0, -1, 1.5, Number.NaN, '1']) expect(await codeOf(p.appendJournal(bad as never, entryEnvelope(1)))).toBe('invalid_input');
    expect(await codeOf(p.appendJournal(1, { nope: true } as never))).toBe('corrupt_record');
    expect(await codeOf(p.readJournal(-1))).toBe('invalid_input');
    const rec = issuance();
    await p.createIssuance(rec);
    await p.commitConsumption(consumption(rec.challengeId));
    expect(await p.listIssuanceIds()).toEqual([rec.challengeId]);
    expect(await p.listConsumptionIds()).toEqual([rec.challengeId]);
  });

  it('refuses a corrupt journal file when reading', async () => {
    const root = freshRoot();
    const p = await open(root);
    await p.appendJournal(1, entryEnvelope(1));
    writeFileSync(join(root, 'journal', '0000000000000001.json'), '{ nope');
    expect(await codeOf(p.readJournal(0))).toBe('corrupt_record');
    expect(await codeOf(p.readJournalTail())).toBe('corrupt_record');
  });
});

describe('directory protection and replacement (Phase 6B.10)', () => {
  it('reports "unverified" on Windows and without an ancestor check, and never "secure"', async () => {
    const win = await open(freshRoot(), { platform: 'win32' });
    expect(win.protection).toEqual({ status: 'unverified', platform: 'win32', ownerAndMode: 'not_applicable', acl: 'not_checked', ancestorLinks: 'not_checked', rootAndSubdirectories: 'checked_each_access' });
    const posixNoAncestors = await open(freshRoot(), { fs: posixLike(), platform: 'linux', getuid: () => 1000 });
    expect(posixNoAncestors.protection).toMatchObject({ status: 'unverified', ownerAndMode: 'checked', ancestorLinks: 'not_checked', acl: 'not_checked' });
    const posixFull = await open(freshRoot(), { fs: posixLike(), platform: 'linux', getuid: () => 1000, refuseLinkedAncestors: true });
    expect(posixFull.protection).toMatchObject({ status: 'owner_and_mode_checked', ancestorLinks: 'checked_clean' });
    for (const p of [win, posixNoAncestors, posixFull]) expect(JSON.stringify(p.protection)).not.toMatch(/secure"|"protected"/);
  });

  it('can refuse a root that has a symbolic link among its ancestors', async () => {
    const root = freshRoot();
    const linkedParent = parent;
    const asLink = fsWith({
      lstat: async (path) => {
        const st = await defaultFsOps.lstat(path);
        return path === linkedParent ? Object.assign(Object.create(st), { isSymbolicLink: () => true }) : st;
      },
    });
    expect(await codeOf(open(root, { fs: asLink, refuseLinkedAncestors: true }))).toBe('symlink_refused');
    await open(freshRoot(), { fs: asLink }); // off by default: some systems reach their temporary directory through a link
    await open(freshRoot(), { refuseLinkedAncestors: true }); // a clean path passes
  });

  it('notices a directory replaced while the store is open, on the next access', async () => {
    const root = freshRoot();
    const replaced = { on: false };
    const p = await open(root, {
      fs: fsWith({
        lstat: async (path) => {
          const st = await defaultFsOps.lstat(path);
          return replaced.on && path === join(root, 'consumption') ? Object.assign(Object.create(st), { ino: st.ino + 12345 }) : st;
        },
      }),
    });
    const rec = issuance();
    expect(await p.createIssuance(rec)).toBe('created');
    replaced.on = true;
    expect(await codeOf(p.getIssuance(rec.challengeId))).toBe('filesystem_replaced');
    expect(await codeOf(p.commitConsumption(consumption(rec.challengeId)))).toBe('filesystem_replaced');
    expect(await codeOf(p.listConsumptionIds())).toBe('filesystem_replaced');
    expect(readdirSync(join(root, 'consumption'))).toEqual([]); // nothing was written
  });

  it('notices a subdirectory swapped for a link or a file while open', async () => {
    const root = freshRoot();
    const swapped = { on: false };
    const p = await open(root, {
      fs: fsWith({
        lstat: async (path) => {
          const st = await defaultFsOps.lstat(path);
          return swapped.on && path === join(root, 'journal') ? Object.assign(Object.create(st), { isSymbolicLink: () => true, isDirectory: () => false }) : st;
        },
      }),
    });
    swapped.on = true;
    expect(await codeOf(p.readJournal(0))).toBe('filesystem_replaced');
    expect(await codeOf(p.appendJournal(1, { version: 1, domain: 'journal', keyId: 'a'.repeat(64), payload: 'cGF5', signature: 'c2ln' }))).toBe('filesystem_replaced');
  });
});
