/**
 * The challenge store's append-only, signed, hash-chained JOURNAL.
 *
 * WHY. Per-challenge records (issuance, consumption) are signed, so they cannot be forged, but a record can
 * simply be DELETED, and a deleted consumption record would let a challenge be consumed again. The journal
 * gives the store something to compare the records against. Every issuance and consumption is also written
 * as a journal entry, each entry is signed by the store key (domain `journal`), carries the next sequence
 * number and the hash of the previous entry, and names the record it describes by a digest. Therefore:
 *   - a missing or replaced RECORD that a surviving entry refers to is detected;
 *   - a deleted, reordered, altered or forged MIDDLE entry breaks the chain or a signature and is detected;
 *   - the store time of the last entry survives a restart, so a clock that moved backwards is detected.
 *
 * WHAT IT CANNOT DO. The journal sits in the same directory as the records. Whoever can delete the newest
 * journal entries together with the newest records, or restore an older complete copy of the whole directory,
 * produces a state that is internally consistent: nothing local can prove that anything is missing. Only a
 * trusted EXTERNAL ANCHOR that remembers the latest sequence number outside the directory can notice (see
 * `RollbackAnchor` in challengeStoreCore.ts). This file never claims otherwise.
 *
 * CRASH CONSISTENCY. The single commit point of an operation is still the exclusive creation of the
 * per-challenge record. The journal entry is written AFTER it and is derived from it, so no mutable
 * "high-water mark" is ever updated in place: an interrupted operation leaves a record without an entry,
 * which recovery can recognise and complete (it never leaves an entry without its record, because the
 * record is written first). Entries themselves are created exclusively, so two writers cannot both take
 * the same sequence number.
 *
 * Entry payload (signed, fixed field order): version, organization, storeId, storeGeneration, sequence,
 * previousHash, at, event. The first entry is always `genesis`; the last entry of a retired generation is
 * `seal`; a trusted operator may add `recovery` entries.
 */

import { createHash, type KeyObject } from 'node:crypto';
import { GENERATION_ID_PATTERN, SHA256_DIGEST_PATTERN, STORE_ID_PATTERN, isRandomId, isRequestId, wholeSecondsText } from './challengeCommon.js';
import { signEnvelope, verifyEnvelope } from './envelope.js';
import { ORGANIZATION_ID, hasExactFields, isPlainObject, parseUtcTimestamp } from './trustRoot.js';
import type { SignedEnvelope } from './types.js';

export const JOURNAL_VERSION = 1 as const;
export const ZERO_HASH = `sha256:${'0'.repeat(64)}`;
export const JOURNAL_SEQUENCE_DIGITS = 16;
export const MAX_RECOVERY_ACKNOWLEDGEMENTS = 8;

/** The only findings an operator may acknowledge in a recovery entry: record-level losses, never chain damage. */
export const ACKNOWLEDGEABLE_FINDINGS = ['issuance_record_missing', 'issuance_record_mismatch', 'consumption_record_missing', 'consumption_record_mismatch', 'unjournaled_record'] as const;
export type AcknowledgeableFinding = (typeof ACKNOWLEDGEABLE_FINDINGS)[number];

export type JournalEvent =
  | { readonly kind: 'genesis'; readonly previousGeneration: string | null; readonly previousSequence: number | null; readonly previousHash: string | null }
  | { readonly kind: 'issue'; readonly challengeId: string; readonly tokenDigest: string; readonly expiresAt: string }
  | { readonly kind: 'consume'; readonly challengeId: string; readonly requestId: string; readonly receiptDigest: string }
  | { readonly kind: 'recovery'; readonly quietUntil: string; readonly acknowledged: readonly AcknowledgeableFinding[] }
  | { readonly kind: 'seal'; readonly nextGeneration: string };

export interface JournalDocument {
  readonly version: typeof JOURNAL_VERSION;
  readonly organization: string;
  readonly storeId: string;
  readonly storeGeneration: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly at: string;
  readonly event: JournalEvent;
}

// ---------------------------------------------------------------- digests

/** The hash that the NEXT entry carries as `previousHash`: over the whole signed envelope. */
export function entryHash(envelope: { readonly payload: string; readonly signature: string }): string {
  return `sha256:${createHash('sha256').update(`codexrev-journal-entry-v1\n${envelope.payload}\n${envelope.signature}`, 'utf-8').digest('hex')}`;
}

/** The digest by which a journal entry names a stored token or receipt: over the whole signed envelope. */
export function recordDigest(envelope: { readonly domain: string; readonly payload: string; readonly signature: string }): string {
  return `sha256:${createHash('sha256').update(`codexrev-store-record-v1\n${envelope.domain}\n${envelope.payload}\n${envelope.signature}`, 'utf-8').digest('hex')}`;
}

// ---------------------------------------------------------------- building

const serializeEvent = (e: JournalEvent): Record<string, unknown> => {
  switch (e.kind) {
    case 'genesis':
      return { kind: 'genesis', previousGeneration: e.previousGeneration, previousSequence: e.previousSequence, previousHash: e.previousHash };
    case 'issue':
      return { kind: 'issue', challengeId: e.challengeId, tokenDigest: e.tokenDigest, expiresAt: e.expiresAt };
    case 'consume':
      return { kind: 'consume', challengeId: e.challengeId, requestId: e.requestId, receiptDigest: e.receiptDigest };
    case 'recovery':
      return { kind: 'recovery', quietUntil: e.quietUntil, acknowledged: [...e.acknowledged] };
    case 'seal':
      return { kind: 'seal', nextGeneration: e.nextGeneration };
  }
};

export interface CreateJournalEntryParams {
  readonly privateKey: KeyObject;
  readonly organization: string;
  readonly storeId: string;
  readonly storeGeneration: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly at: Date;
  readonly event: JournalEvent;
}

/** Signs one journal entry. Trusted-side only; throws for bad input (the message is fixed text). */
export function createJournalEntry(p: CreateJournalEntryParams): SignedEnvelope {
  if (!Number.isSafeInteger(p.sequence) || p.sequence < 1 || !SHA256_DIGEST_PATTERN.test(p.previousHash) || !(p.at instanceof Date) || Number.isNaN(p.at.getTime())) throw new Error('invalid journal entry');
  const doc = {
    version: JOURNAL_VERSION,
    organization: p.organization,
    storeId: p.storeId,
    storeGeneration: p.storeGeneration,
    sequence: p.sequence,
    previousHash: p.previousHash,
    at: wholeSecondsText(p.at.getTime()),
    event: serializeEvent(p.event),
  };
  return signEnvelope({ domain: 'journal', payload: Buffer.from(JSON.stringify(doc), 'utf-8'), privateKey: p.privateKey });
}

// ---------------------------------------------------------------- parsing one entry

const ts = (x: unknown): x is string => parseUtcTimestamp(x) !== null;

function parseEvent(x: unknown): JournalEvent | undefined {
  if (!isPlainObject(x) || typeof x.kind !== 'string') return undefined;
  switch (x.kind) {
    case 'genesis': {
      if (!hasExactFields(x, ['kind', 'previousGeneration', 'previousSequence', 'previousHash'])) return undefined;
      const none = x.previousGeneration === null && x.previousSequence === null && x.previousHash === null;
      const some = typeof x.previousGeneration === 'string' && GENERATION_ID_PATTERN.test(x.previousGeneration) && Number.isSafeInteger(x.previousSequence) && (x.previousSequence as number) >= 1 && typeof x.previousHash === 'string' && SHA256_DIGEST_PATTERN.test(x.previousHash);
      return none || some ? (x as unknown as JournalEvent) : undefined;
    }
    case 'issue':
      return hasExactFields(x, ['kind', 'challengeId', 'tokenDigest', 'expiresAt']) && isRandomId(x.challengeId) && typeof x.tokenDigest === 'string' && SHA256_DIGEST_PATTERN.test(x.tokenDigest) && ts(x.expiresAt) ? (x as unknown as JournalEvent) : undefined;
    case 'consume':
      return hasExactFields(x, ['kind', 'challengeId', 'requestId', 'receiptDigest']) && isRandomId(x.challengeId) && isRequestId(x.requestId) && typeof x.receiptDigest === 'string' && SHA256_DIGEST_PATTERN.test(x.receiptDigest) ? (x as unknown as JournalEvent) : undefined;
    case 'recovery': {
      if (!hasExactFields(x, ['kind', 'quietUntil', 'acknowledged']) || !ts(x.quietUntil) || !Array.isArray(x.acknowledged) || x.acknowledged.length > MAX_RECOVERY_ACKNOWLEDGEMENTS) return undefined;
      const seen = new Set<string>();
      for (const a of x.acknowledged as unknown[]) {
        if (typeof a !== 'string' || !(ACKNOWLEDGEABLE_FINDINGS as readonly string[]).includes(a) || seen.has(a)) return undefined;
        seen.add(a);
      }
      return x as unknown as JournalEvent;
    }
    case 'seal':
      return hasExactFields(x, ['kind', 'nextGeneration']) && typeof x.nextGeneration === 'string' && GENERATION_ID_PATTERN.test(x.nextGeneration) ? (x as unknown as JournalEvent) : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- the state a valid journal describes

export interface IssuedEntry {
  readonly sequence: number;
  readonly tokenDigest: string;
  readonly expiresAtMs: number;
}
export interface ConsumedEntry {
  readonly sequence: number;
  readonly requestId: string;
  readonly receiptDigest: string;
}
export interface RecoveryEntry {
  readonly sequence: number;
  readonly atMs: number;
  readonly quietUntilMs: number;
  readonly acknowledged: readonly AcknowledgeableFinding[];
}

export interface JournalState {
  readonly headSequence: number;
  readonly headHash: string;
  /** the hash of every entry by sequence number, so an external anchor can be compared with the chain */
  readonly hashes: ReadonlyMap<number, string>;
  /** store time (whole seconds) of the newest entry: the clock may not be earlier than this */
  readonly lastAtMs: number;
  readonly genesis: Extract<JournalEvent, { kind: 'genesis' }> | undefined;
  readonly issued: ReadonlyMap<string, IssuedEntry>;
  readonly consumed: ReadonlyMap<string, ConsumedEntry>;
  /** every recovery event, in order */
  readonly recoveries: readonly RecoveryEntry[];
  /** set once the generation has been retired by a `seal` entry */
  readonly sealed: { readonly sequence: number; readonly nextGeneration: string } | undefined;
}

export const emptyJournalState: JournalState = Object.freeze({
  headSequence: 0,
  headHash: ZERO_HASH,
  hashes: new Map(),
  lastAtMs: Number.NEGATIVE_INFINITY,
  genesis: undefined,
  issued: new Map(),
  consumed: new Map(),
  recoveries: [],
  sealed: undefined,
});

export type JournalFailureCode =
  | 'journal_corrupt'
  | 'journal_bad_signature'
  | 'journal_gap'
  | 'journal_chain_broken'
  | 'journal_wrong_identity'
  | 'journal_time_regression'
  | 'journal_bad_genesis'
  | 'journal_bad_event'
  | 'journal_after_seal';

export type JournalReplay = { readonly ok: true; readonly state: JournalState } | { readonly ok: false; readonly code: JournalFailureCode };

export interface JournalContext {
  readonly publicKey: KeyObject;
  readonly organization: string;
  readonly storeId: string;
  readonly storeGeneration: string;
}

/** One entry file: the sequence number its NAME claims, and the envelope it contains. */
export interface JournalFile {
  readonly sequence: number;
  readonly envelope: SignedEnvelope;
}

/**
 * Verifies `files` as the continuation of `from` and returns the resulting state. Everything is checked:
 * signature, identity, contiguous sequence, the chain of hashes, non-decreasing time, a genesis first, and
 * the consistency of events (a consumption needs an earlier issuance and happens once; nothing follows a
 * seal). Returns the first problem found; never throws.
 */
export function extendJournal(from: JournalState, files: readonly JournalFile[], ctx: JournalContext): JournalReplay {
  try {
    let headSequence = from.headSequence;
    let headHash = from.headHash;
    let lastAtMs = from.lastAtMs;
    let genesis = from.genesis;
    let sealed = from.sealed;
    const issued = new Map(from.issued);
    const consumed = new Map(from.consumed);
    const hashes = new Map(from.hashes);
    const recoveries = [...from.recoveries];

    for (const file of files) {
      const verified = verifyEnvelope(file.envelope, { expectedDomain: 'journal', trustedPublicKey: ctx.publicKey });
      if (!verified.ok) return { ok: false, code: verified.code === 'signature_invalid' || verified.code === 'key_id_mismatch' ? 'journal_bad_signature' : 'journal_corrupt' };
      let doc: unknown;
      try {
        doc = JSON.parse(verified.payload.toString('utf-8'));
      } catch {
        return { ok: false, code: 'journal_corrupt' };
      }
      if (!isPlainObject(doc) || !hasExactFields(doc, ['version', 'organization', 'storeId', 'storeGeneration', 'sequence', 'previousHash', 'at', 'event'])) return { ok: false, code: 'journal_corrupt' };
      const event = parseEvent(doc.event);
      const atMs = parseUtcTimestamp(doc.at);
      if (doc.version !== JOURNAL_VERSION || !event || atMs === null || typeof doc.organization !== 'string' || !ORGANIZATION_ID.test(doc.organization) || typeof doc.storeId !== 'string' || !STORE_ID_PATTERN.test(doc.storeId)) return { ok: false, code: 'journal_corrupt' };
      if (typeof doc.storeGeneration !== 'string' || typeof doc.sequence !== 'number' || typeof doc.previousHash !== 'string' || !SHA256_DIGEST_PATTERN.test(doc.previousHash)) return { ok: false, code: 'journal_corrupt' };
      if (doc.organization !== ctx.organization || doc.storeId !== ctx.storeId || doc.storeGeneration !== ctx.storeGeneration) return { ok: false, code: 'journal_wrong_identity' };

      // order: the file name, the signed sequence, and the chain must all agree
      if (doc.sequence !== file.sequence) return { ok: false, code: 'journal_corrupt' };
      if (doc.sequence !== headSequence + 1) return { ok: false, code: doc.sequence > headSequence + 1 ? 'journal_gap' : 'journal_chain_broken' };
      if (doc.previousHash !== headHash) return { ok: false, code: 'journal_chain_broken' };
      if (sealed) return { ok: false, code: 'journal_after_seal' };
      if (atMs < lastAtMs) return { ok: false, code: 'journal_time_regression' };

      if (doc.sequence === 1 && event.kind !== 'genesis') return { ok: false, code: 'journal_bad_genesis' };
      if (doc.sequence > 1 && event.kind === 'genesis') return { ok: false, code: 'journal_bad_genesis' };

      switch (event.kind) {
        case 'genesis':
          genesis = event;
          break;
        case 'issue':
          if (issued.has(event.challengeId)) return { ok: false, code: 'journal_bad_event' };
          issued.set(event.challengeId, { sequence: doc.sequence, tokenDigest: event.tokenDigest, expiresAtMs: parseUtcTimestamp(event.expiresAt) as number });
          break;
        case 'consume':
          if (!issued.has(event.challengeId) || consumed.has(event.challengeId)) return { ok: false, code: 'journal_bad_event' };
          consumed.set(event.challengeId, { sequence: doc.sequence, requestId: event.requestId, receiptDigest: event.receiptDigest });
          break;
        case 'recovery': {
          const quietUntilMs = parseUtcTimestamp(event.quietUntil) as number;
          if (quietUntilMs < atMs) return { ok: false, code: 'journal_bad_event' };
          recoveries.push({ sequence: doc.sequence, atMs, quietUntilMs, acknowledged: [...event.acknowledged] });
          break;
        }
        case 'seal':
          if (event.nextGeneration === ctx.storeGeneration) return { ok: false, code: 'journal_bad_event' };
          sealed = { sequence: doc.sequence, nextGeneration: event.nextGeneration };
          break;
      }
      headSequence = doc.sequence;
      headHash = entryHash(file.envelope);
      hashes.set(doc.sequence, headHash);
      lastAtMs = atMs;
    }
    return { ok: true, state: Object.freeze({ headSequence, headHash, hashes, lastAtMs, genesis, issued, consumed, recoveries, sealed }) };
  } catch {
    return { ok: false, code: 'journal_corrupt' };
  }
}

/** Entry file names: a fixed-width sequence number, so a directory listing sorts in order. */
export const journalFileName = (sequence: number): string => `${String(sequence).padStart(JOURNAL_SEQUENCE_DIGITS, '0')}.json`;
export const JOURNAL_FILE_NAME = new RegExp(`^[0-9]{${JOURNAL_SEQUENCE_DIGITS}}\\.json$`);
