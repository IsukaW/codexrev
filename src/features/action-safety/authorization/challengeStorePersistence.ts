/**
 * Durable, atomic persistence for the challenge store core.
 *
 * WHAT THIS IS. A small abstraction (`ChallengeStorePersistence`) plus one filesystem implementation
 * built only from Node built-ins. It records issued challenges, decides the single winner of a
 * consumption, and returns the original receipt on a duplicate. It is NOT a protected store by itself:
 * run inside a developer-controlled process, whoever controls the process controls the directory.
 *
 * FILESYSTEM ASSUMPTIONS (the operator must provide these; none is verified beyond what is listed):
 *  - The store directory belongs to a dedicated account and is not writable by the people being checked.
 *    On POSIX this implementation refuses a directory or record that is not owned by the current user or
 *    is accessible to group/other. On Windows file modes carry no meaning, so protection must come from
 *    ACLs set by the operator; nothing here checks them.
 *  - The directory is on a local filesystem with working hard links (`link`) and `fsync`. Network
 *    filesystems with weak link/fsync semantics are not supported.
 *  - Only this implementation writes the directory. Ancestors of the root are not checked for symlinks;
 *    the root and its subdirectories are (they must be real directories, never links).
 *
 * LAYOUT (fixed; names are built only from validated identifiers, never from request text):
 *   <root>/STORE.json          identity marker: storeId + storeGeneration, created once
 *   <root>/issuance/<id>.json  one record per issued challenge
 *   <root>/consumption/<id>.json  one record per consumed challenge (contains the exact signed receipt)
 *   <root>/journal/<n>.json    the signed, hash-chained journal (see challengeStoreJournal.ts), one file per entry
 *   <root>/tmp/                staging area for files being written
 * Any other entry makes opening fail: unexpected files are never ignored silently.
 *
 * ATOMICITY. A record is written to `tmp/` (exclusive create, mode 0600), flushed with fsync, closed, and
 * then published with a HARD LINK to its final name. `link` fails with EEXIST if the name exists, so it is
 * an exclusive create: exactly one concurrent writer can win, and a record never appears half-written.
 * `rename` is deliberately not used: it replaces an existing target and is not a compare-and-set.
 * The winner of `commitConsumption` is therefore whoever links first; every other caller reads the
 * winner's record.
 *
 * DURABILITY. File contents are fsynced before they are published. After publishing, the containing
 * directory is fsynced where the platform supports opening directories (POSIX). Windows cannot open a
 * directory for fsync from Node: there `durability.directorySync` is false and a power loss right after
 * a commit could lose the directory entry. Callers must not claim stronger durability than this reports.
 *
 * CRASH RECOVERY. A crash before the link leaves only a file in `tmp/`: nothing was issued or consumed.
 * A crash after the link leaves a complete record (and maybe a stray tmp file): the record counts, and a
 * retry finds it. Stray tmp files are removed when the store is opened (`staleTempMs`).
 *
 * LIMITS. A record can be deleted or the whole directory restored from a backup by anyone who controls
 * it: that is a ROLLBACK and a filesystem cannot detect it. The core signs what it stores, so records
 * cannot be forged or altered undetected, but they can be removed. See the core's header.
 *
 * Errors carry fixed codes and messages: never a path, a challenge or a record's content.
 */

import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { GENERATION_ID_PATTERN, SHA256_DIGEST_PATTERN, STORE_ID_PATTERN, isRandomId, isRequestId } from './challengeCommon.js';
import { JOURNAL_FILE_NAME, journalFileName } from './challengeStoreJournal.js';
import { hasExactFields, isPlainObject } from './trustRoot.js';

export const PERSISTENCE_FORMAT_VERSION = 1 as const;
export const MAX_RECORD_BYTES = 64 * 1024;
export const DEFAULT_STALE_TEMP_MS = 60 * 60 * 1000;

export type PersistenceErrorCode =
  | 'invalid_input'
  | 'io_error'
  | 'corrupt_record'
  | 'unexpected_entry'
  | 'unsafe_permissions'
  | 'symlink_refused'
  | 'identity_mismatch'
  | 'filesystem_replaced';

const MESSAGES: Readonly<Record<PersistenceErrorCode, string>> = {
  invalid_input: 'the persistence request is invalid',
  io_error: 'the challenge store storage operation failed',
  corrupt_record: 'a stored challenge record is corrupt',
  unexpected_entry: 'the challenge store directory contains an unexpected entry',
  unsafe_permissions: 'the challenge store directory or a record has unsafe permissions or ownership',
  symlink_refused: 'the challenge store refuses links and non-regular files',
  identity_mismatch: 'the challenge store directory belongs to a different store identity',
  filesystem_replaced: 'the challenge store directory was replaced while the store was open',
};

/** Thrown for every storage problem. The message is fixed text; the code is the only detail. */
export class ChallengeStorePersistenceError extends Error {
  constructor(readonly code: PersistenceErrorCode) {
    super(MESSAGES[code]);
    this.name = 'ChallengeStorePersistenceError';
  }
}
const fail = (code: PersistenceErrorCode): never => {
  throw new ChallengeStorePersistenceError(code);
};

// ---------------------------------------------------------------- records

/** A signed envelope as stored: exactly the five envelope fields, all text. */
export interface StoredEnvelope {
  readonly version: number;
  readonly domain: string;
  readonly keyId: string;
  readonly payload: string;
  readonly signature: string;
}

export interface IssuanceRecord {
  readonly version: typeof PERSISTENCE_FORMAT_VERSION;
  readonly challengeId: string;
  /** the signed challenge token, exactly as returned to the requester. It contains the challenge, so the directory is as sensitive as the signing key. */
  readonly token: StoredEnvelope;
  /** the action the challenge is for (its digest is inside the signed token) */
  readonly context: Readonly<Record<string, unknown>>;
  /** the signed grant the requester presented, kept so the proof can be checked at consumption */
  readonly grant: StoredEnvelope;
}

export interface ConsumptionRecord {
  readonly version: typeof PERSISTENCE_FORMAT_VERSION;
  readonly challengeId: string;
  readonly requestId: string;
  readonly proofDigest: string;
  /** the exact signed receipt returned to the requester; replays return this same envelope */
  readonly receipt: StoredEnvelope;
}

export type CommitResult = { readonly outcome: 'committed' } | { readonly outcome: 'already_consumed'; readonly existing: ConsumptionRecord };

export interface PersistenceDurability {
  /** file contents are fsynced before a record is published */
  readonly fileSync: true;
  /** false where directories cannot be fsynced (Windows): the directory entry may be lost on power failure */
  readonly directorySync: boolean;
  readonly exclusiveCreate: 'hard_link';
}

/**
 * What this process could and could not establish about the protection of the directory. It NEVER says
 * the directory is secure: a process owned by the person being checked cannot know that. `unverified`
 * means the operator must provide the protection (a dedicated account, ACLs) and nothing here checked it.
 */
export interface ProtectionReport {
  readonly status: 'unverified' | 'owner_and_mode_checked';
  readonly platform: string;
  /** POSIX: owner and 0077 mode were verified. Windows: file modes carry no meaning, so nothing was verified. */
  readonly ownerAndMode: 'checked' | 'not_applicable';
  /** access-control lists are never inspected by this implementation */
  readonly acl: 'not_checked';
  /** only when the operator asked for it: no ancestor directory of the root is a symbolic link */
  readonly ancestorLinks: 'checked_clean' | 'not_checked';
  /** the root and its subdirectories were verified to be real directories (not links) when opened and again on every access */
  readonly rootAndSubdirectories: 'checked_each_access';
}

/** A journal file as read back: the sequence its NAME claims, and its contents. */
export interface StoredJournalFile {
  readonly sequence: number;
  readonly envelope: StoredEnvelope;
}

export interface ChallengeStorePersistence {
  readonly durability: PersistenceDurability;
  readonly protection: ProtectionReport;
  /** every journal file with a sequence greater than `after`, in order. Throws on a malformed or unexpected file. */
  readJournal(after: number): Promise<StoredJournalFile[]>;
  /** the newest journal file, or undefined when there is none */
  readJournalTail(): Promise<StoredJournalFile | undefined>;
  /** durable exclusive create of one journal entry: 'exists' (and no change) if that sequence number is taken */
  appendJournal(sequence: number, envelope: StoredEnvelope): Promise<'created' | 'exists'>;
  listIssuanceIds(): Promise<string[]>;
  listConsumptionIds(): Promise<string[]>;
  /** durable exclusive create: 'exists' (and no change) if the challenge id is already recorded */
  createIssuance(record: IssuanceRecord): Promise<'created' | 'exists'>;
  getIssuance(challengeId: string): Promise<IssuanceRecord | undefined>;
  /** atomic: exactly one caller per challenge gets 'committed'; the others get the winner's record */
  commitConsumption(record: ConsumptionRecord): Promise<CommitResult>;
  getConsumption(challengeId: string): Promise<ConsumptionRecord | undefined>;
}

const ENVELOPE_FIELDS = ['version', 'domain', 'keyId', 'payload', 'signature'] as const;

function parseEnvelope(x: unknown): StoredEnvelope {
  if (!isPlainObject(x) || !hasExactFields(x, ENVELOPE_FIELDS)) return fail('corrupt_record');
  if (typeof x.version !== 'number' || ![x.domain, x.keyId, x.payload, x.signature].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 16_384)) return fail('corrupt_record');
  return Object.freeze({ version: x.version, domain: x.domain as string, keyId: x.keyId as string, payload: x.payload as string, signature: x.signature as string });
}

export function parseIssuanceRecord(x: unknown): IssuanceRecord {
  if (!isPlainObject(x) || !hasExactFields(x, ['version', 'challengeId', 'token', 'context', 'grant'])) return fail('corrupt_record');
  if (x.version !== PERSISTENCE_FORMAT_VERSION || !isRandomId(x.challengeId) || !isPlainObject(x.context)) return fail('corrupt_record');
  return Object.freeze({ version: PERSISTENCE_FORMAT_VERSION, challengeId: x.challengeId, token: parseEnvelope(x.token), context: Object.freeze({ ...x.context }), grant: parseEnvelope(x.grant) });
}

export function parseConsumptionRecord(x: unknown): ConsumptionRecord {
  if (!isPlainObject(x) || !hasExactFields(x, ['version', 'challengeId', 'requestId', 'proofDigest', 'receipt'])) return fail('corrupt_record');
  if (x.version !== PERSISTENCE_FORMAT_VERSION || !isRandomId(x.challengeId) || !isRequestId(x.requestId)) return fail('corrupt_record');
  if (typeof x.proofDigest !== 'string' || !SHA256_DIGEST_PATTERN.test(x.proofDigest)) return fail('corrupt_record');
  return Object.freeze({ version: PERSISTENCE_FORMAT_VERSION, challengeId: x.challengeId, requestId: x.requestId, proofDigest: x.proofDigest, receipt: parseEnvelope(x.receipt) });
}

// ---------------------------------------------------------------- the filesystem seam

export interface FileHandleLike {
  writeFile(data: string): Promise<void>;
  readFile(encoding: 'utf-8'): Promise<string>;
  sync(): Promise<void>;
  stat(): Promise<nodeFs.Stats>;
  close(): Promise<void>;
}

/** The only filesystem operations used. Tests wrap it to inject crashes and failures. */
export interface FsOps {
  open(path: string, flags: number | string, mode?: number): Promise<FileHandleLike>;
  link(existing: string, created: string): Promise<void>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<nodeFs.Stats>;
  mkdir(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

export const defaultFsOps: FsOps = {
  open: (p, flags, mode) => nodeFs.promises.open(p, flags, mode) as Promise<FileHandleLike>,
  link: (a, b) => nodeFs.promises.link(a, b),
  unlink: (p) => nodeFs.promises.unlink(p),
  lstat: (p) => nodeFs.promises.lstat(p),
  mkdir: async (p, mode) => {
    await nodeFs.promises.mkdir(p, { mode });
  },
  readdir: (p) => nodeFs.promises.readdir(p),
};

const errno = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined);

export interface FilesystemPersistenceOptions {
  /** absolute path of the store directory, chosen by the operator (never from assessment data or the environment) */
  readonly root: string;
  readonly storeId: string;
  readonly storeGeneration: string;
  readonly fs?: FsOps;
  /** injectable for tests; defaults to process.platform */
  readonly platform?: NodeJS.Platform;
  /** injectable for tests; defaults to process.getuid */
  readonly getuid?: () => number | undefined;
  /** stray staging files older than this are removed on open (default one hour) */
  readonly staleTempMs?: number;
  /** injectable for tests; defaults to Date.now. Used only to age staging files */
  readonly wallClockMs?: () => number;
  /**
   * Refuse a root that has a symbolic link anywhere among its ancestors. Off by default because some
   * systems legitimately reach their temporary directories through links; an operator who controls the
   * path should turn it on.
   */
  readonly refuseLinkedAncestors?: boolean;
}

const RECORD_NAME = /^[A-Za-z0-9_-]{22}\.json$/;
const TMP_NAME = /^[0-9a-f]{32}\.tmp$/;
const MARKER = 'STORE.json';
const DIRS = ['issuance', 'consumption', 'journal', 'tmp'] as const;

/**
 * Opens (and on first use initializes) a filesystem store. Throws ChallengeStorePersistenceError when
 * the directory is unsafe, belongs to another store identity, or contains anything unexpected.
 */
export async function openFilesystemPersistence(options: FilesystemPersistenceOptions): Promise<ChallengeStorePersistence> {
  if (!isPlainObject(options)) return fail('invalid_input');
  const { root, storeId, storeGeneration } = options;
  if (typeof root !== 'string' || !nodePath.isAbsolute(root) || root.includes('\0')) return fail('invalid_input');
  if (typeof storeId !== 'string' || !STORE_ID_PATTERN.test(storeId) || typeof storeGeneration !== 'string' || !GENERATION_ID_PATTERN.test(storeGeneration)) return fail('invalid_input');
  const fs = options.fs ?? defaultFsOps;
  const platform = options.platform ?? process.platform;
  const posix = platform !== 'win32';
  const getuid = options.getuid ?? ((): number | undefined => process.getuid?.());
  const staleTempMs = options.staleTempMs ?? DEFAULT_STALE_TEMP_MS;
  const wallClockMs = options.wallClockMs ?? ((): number => Date.now());

  const rootDir = nodePath.resolve(root);
  const dirOf = (name: (typeof DIRS)[number]): string => nodePath.join(rootDir, name);

  const checkOwner = (st: nodeFs.Stats): void => {
    if (!posix) return;
    const uid = getuid();
    if ((st.mode & 0o077) !== 0 || (uid !== undefined && st.uid !== uid)) fail('unsafe_permissions');
  };

  const io = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof ChallengeStorePersistenceError) throw e;
      return fail('io_error');
    }
  };

  const requireRealDirectory = async (path: string): Promise<void> => {
    const st = await io(() => fs.lstat(path));
    if (st.isSymbolicLink()) fail('symlink_refused');
    if (!st.isDirectory()) fail('unexpected_entry');
    checkOwner(st);
  };

  const ensureDirectory = async (path: string): Promise<void> => {
    try {
      await fs.mkdir(path, 0o700);
    } catch (e) {
      if (errno(e) !== 'EEXIST') return fail('io_error');
    }
    await requireRealDirectory(path);
  };

  // ---- identity, layout and contents
  let rootExisted = true;
  try {
    await fs.lstat(rootDir);
  } catch (e) {
    if (errno(e) !== 'ENOENT') return fail('io_error');
    rootExisted = false;
  }
  if (!rootExisted) await ensureDirectory(rootDir);
  else await requireRealDirectory(rootDir);
  for (const d of DIRS) await ensureDirectory(dirOf(d));

  if (options.refuseLinkedAncestors === true) {
    let current = nodePath.dirname(rootDir);
    for (;;) {
      const st = await io(() => fs.lstat(current));
      if (st.isSymbolicLink()) fail('symlink_refused');
      const up = nodePath.dirname(current);
      if (up === current) break;
      current = up;
    }
  }

  // remember which directories these are: replacing one while the store is open is detected on every access
  const identityOf = async (path: string): Promise<number> => (await io(() => fs.lstat(path))).ino;
  const watched = new Map<string, number>();
  for (const dir of [rootDir, ...DIRS.map(dirOf)]) watched.set(dir, await identityOf(dir));
  const assertStable = async (): Promise<void> => {
    for (const [dir, ino] of watched) {
      const st = await io(() => fs.lstat(dir));
      if (st.isSymbolicLink() || !st.isDirectory()) fail('filesystem_replaced');
      if (ino !== 0 && st.ino !== 0 && st.ino !== ino) fail('filesystem_replaced');
    }
  };

  const markerPath = nodePath.join(rootDir, MARKER);
  const rootEntries = await io(() => fs.readdir(rootDir));
  for (const name of rootEntries) if (name !== MARKER && !(DIRS as readonly string[]).includes(name)) fail('unexpected_entry');

  const marker = JSON.stringify({ version: PERSISTENCE_FORMAT_VERSION, storeId, storeGeneration });

  const writeNew = async (dir: string, finalName: string, text: string): Promise<'created' | 'exists'> => {
    if (Buffer.byteLength(text, 'utf-8') > MAX_RECORD_BYTES) return fail('invalid_input');
    await assertStable();
    const tmpPath = nodePath.join(dirOf('tmp'), `${randomBytes(16).toString('hex')}.tmp`);
    const finalPath = nodePath.join(dir, finalName);
    let handle: FileHandleLike | undefined;
    try {
      handle = await fs.open(tmpPath, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY, 0o600);
      await handle.writeFile(text);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch {
      try {
        await handle?.close();
      } catch {
        /* the original failure is what matters */
      }
      await fs.unlink(tmpPath).catch(() => undefined);
      return fail('io_error');
    }
    let created = false;
    try {
      await fs.link(tmpPath, finalPath);
      created = true;
    } catch (e) {
      await fs.unlink(tmpPath).catch(() => undefined);
      if (errno(e) === 'EEXIST') return 'exists';
      return fail('io_error');
    }
    // published: from here on the record counts, even if a later step fails
    await fs.unlink(tmpPath).catch(() => undefined);
    if (created) await syncDirectory(dir);
    return 'created';
  };

  const syncDirectory = async (dir: string): Promise<void> => {
    if (!directorySync) return;
    let handle: FileHandleLike | undefined;
    try {
      handle = await fs.open(dir, nodeFs.constants.O_RDONLY);
      await handle.sync();
    } catch {
      return fail('io_error');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
  // Windows cannot open a directory for fsync from Node; elsewhere a failure to do so is an error
  const directorySync = posix;

  const readText = async (path: string): Promise<string | undefined> => {
    await assertStable();
    let st: nodeFs.Stats;
    try {
      st = await fs.lstat(path);
    } catch (e) {
      if (errno(e) === 'ENOENT') return undefined;
      return fail('io_error');
    }
    if (st.isSymbolicLink() || !st.isFile()) return fail('symlink_refused');
    if (st.size > MAX_RECORD_BYTES) return fail('corrupt_record');
    checkOwner(st);
    let handle: FileHandleLike | undefined;
    try {
      handle = await fs.open(path, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0));
      const again = await handle.stat();
      if (!again.isFile() || again.ino !== st.ino) return fail('symlink_refused');
      return await handle.readFile('utf-8');
    } catch (e) {
      if (e instanceof ChallengeStorePersistenceError) throw e;
      return fail('io_error');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  const readJson = async (path: string): Promise<unknown> => {
    const text = await readText(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return fail('corrupt_record');
    }
  };

  // marker: create once, afterwards it must match exactly
  if (rootEntries.includes(MARKER)) {
    const found = await readJson(markerPath);
    if (!isPlainObject(found) || !hasExactFields(found, ['version', 'storeId', 'storeGeneration']) || found.version !== PERSISTENCE_FORMAT_VERSION) return fail('corrupt_record');
    if (found.storeId !== storeId || found.storeGeneration !== storeGeneration) return fail('identity_mismatch');
  } else {
    // a directory that already holds records but has no marker is not ours to adopt
    for (const d of ['issuance', 'consumption', 'journal'] as const) if ((await io(() => fs.readdir(dirOf(d)))).length > 0) fail('unexpected_entry');
    if ((await writeNew(rootDir, MARKER, marker)) === 'exists') {
      const found = await readJson(markerPath);
      if (!isPlainObject(found) || found.storeId !== storeId || found.storeGeneration !== storeGeneration) return fail('identity_mismatch');
    }
  }

  for (const d of ['issuance', 'consumption'] as const) for (const name of await io(() => fs.readdir(dirOf(d)))) if (!RECORD_NAME.test(name)) fail('unexpected_entry');
  for (const name of await io(() => fs.readdir(dirOf('journal')))) if (!JOURNAL_FILE_NAME.test(name)) fail('unexpected_entry');

  // crash recovery: remove stray staging files; anything else in tmp/ is unexpected
  for (const name of await io(() => fs.readdir(dirOf('tmp')))) {
    if (!TMP_NAME.test(name)) fail('unexpected_entry');
    const path = nodePath.join(dirOf('tmp'), name);
    try {
      const st = await fs.lstat(path);
      if (!st.isFile()) fail('symlink_refused');
      if (wallClockMs() - st.mtimeMs >= staleTempMs) await fs.unlink(path);
    } catch (e) {
      if (e instanceof ChallengeStorePersistenceError) throw e;
      if (errno(e) !== 'ENOENT') return fail('io_error');
    }
  }

  const idOf = (challengeId: unknown): string => (isRandomId(challengeId) ? challengeId : fail('invalid_input'));
  const issuancePath = (id: string): string => nodePath.join(dirOf('issuance'), `${id}.json`);
  const consumptionPath = (id: string): string => nodePath.join(dirOf('consumption'), `${id}.json`);

  const getConsumption = async (challengeId: string): Promise<ConsumptionRecord | undefined> => {
    const id = idOf(challengeId);
    const found = await readJson(consumptionPath(id));
    if (found === undefined) return undefined;
    const record = parseConsumptionRecord(found);
    if (record.challengeId !== id) return fail('corrupt_record');
    return record;
  };

  const idsIn = async (dir: 'issuance' | 'consumption'): Promise<string[]> => {
    await assertStable();
    const names = await io(() => fs.readdir(dirOf(dir)));
    return names.map((n) => (RECORD_NAME.test(n) ? n.slice(0, -'.json'.length) : fail('unexpected_entry')));
  };

  const journalNumbers = async (): Promise<number[]> => {
    await assertStable();
    const names = await io(() => fs.readdir(dirOf('journal')));
    return names.map((n) => (JOURNAL_FILE_NAME.test(n) ? Number(n.slice(0, -'.json'.length)) : fail('unexpected_entry'))).sort((a, b) => a - b);
  };

  const readJournalFile = async (sequence: number): Promise<StoredJournalFile> => {
    const found = await readJson(nodePath.join(dirOf('journal'), journalFileName(sequence)));
    if (found === undefined) return fail('corrupt_record'); // listed a moment ago and gone now
    return Object.freeze({ sequence, envelope: parseEnvelope(found) });
  };

  const protection: ProtectionReport = Object.freeze({
    status: posix && options.refuseLinkedAncestors === true ? ('owner_and_mode_checked' as const) : ('unverified' as const),
    platform,
    ownerAndMode: posix ? ('checked' as const) : ('not_applicable' as const),
    acl: 'not_checked' as const,
    ancestorLinks: options.refuseLinkedAncestors === true ? ('checked_clean' as const) : ('not_checked' as const),
    rootAndSubdirectories: 'checked_each_access' as const,
  });

  const persistence: ChallengeStorePersistence = {
    durability: Object.freeze({ fileSync: true as const, directorySync, exclusiveCreate: 'hard_link' as const }),
    protection,

    async readJournal(after) {
      if (!Number.isSafeInteger(after) || after < 0) return fail('invalid_input');
      const out: StoredJournalFile[] = [];
      for (const n of await journalNumbers()) if (n > after) out.push(await readJournalFile(n));
      return out;
    },

    async readJournalTail() {
      const numbers = await journalNumbers();
      const last = numbers[numbers.length - 1];
      return last === undefined ? undefined : readJournalFile(last);
    },

    async appendJournal(sequence, envelope) {
      if (!Number.isSafeInteger(sequence) || sequence < 1) return fail('invalid_input');
      return writeNew(dirOf('journal'), journalFileName(sequence), JSON.stringify(parseEnvelope(envelope)));
    },

    listIssuanceIds: () => idsIn('issuance'),
    listConsumptionIds: () => idsIn('consumption'),

    async createIssuance(record) {
      const parsed = parseIssuanceRecord(record);
      return writeNew(dirOf('issuance'), `${parsed.challengeId}.json`, JSON.stringify(parsed));
    },

    async getIssuance(challengeId) {
      const id = idOf(challengeId);
      const found = await readJson(issuancePath(id));
      if (found === undefined) return undefined;
      const record = parseIssuanceRecord(found);
      if (record.challengeId !== id) return fail('corrupt_record');
      return record;
    },

    async commitConsumption(record) {
      const parsed = parseConsumptionRecord(record);
      const outcome = await writeNew(dirOf('consumption'), `${parsed.challengeId}.json`, JSON.stringify(parsed));
      if (outcome === 'created') return { outcome: 'committed' as const };
      const existing = await getConsumption(parsed.challengeId);
      if (!existing) return fail('corrupt_record');
      return { outcome: 'already_consumed' as const, existing };
    },

    getConsumption,
  };
  return Object.freeze(persistence);
}
