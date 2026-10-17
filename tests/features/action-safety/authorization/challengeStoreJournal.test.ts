// Unit tests for the journal: pure functions, in-memory keys, no filesystem.

import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGEABLE_FINDINGS,
  JOURNAL_FILE_NAME,
  ZERO_HASH,
  createJournalEntry,
  emptyJournalState,
  entryHash,
  extendJournal,
  journalFileName,
  recordDigest,
  type JournalEvent,
  type JournalFile,
  type JournalState,
} from '../../../../src/features/action-safety/authorization/challengeStoreJournal.js';
import { signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';

const T = (s: number): Date => new Date(Date.parse('2026-06-01T12:00:00Z') + s * 1000);
const id = (): string => randomBytes(16).toString('base64url');
const req = (): string => randomBytes(16).toString('base64url');
const dig = (c = 'a'): string => `sha256:${c.repeat(64)}`;

let key: KeyObject;
let other: KeyObject;
let ctx: { publicKey: KeyObject; organization: string; storeId: string; storeGeneration: string };
beforeAll(() => {
  key = generateKeyPairSync('ed25519').privateKey;
  other = generateKeyPairSync('ed25519').privateKey;
  ctx = { publicKey: createPublicKey(key), organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1' };
});

const GENESIS: JournalEvent = { kind: 'genesis', previousGeneration: null, previousSequence: null, previousHash: null };

/** build a valid chain of entries from events (each one second after the previous) */
function chain(events: JournalEvent[], signer: KeyObject = key, generation = 'gen-1'): JournalFile[] {
  const files: JournalFile[] = [];
  let previousHash = ZERO_HASH;
  events.forEach((event, i) => {
    const envelope = createJournalEntry({ privateKey: signer, organization: 'acme', storeId: 'store-1', storeGeneration: generation, sequence: i + 1, previousHash, at: T(i), event });
    files.push({ sequence: i + 1, envelope });
    previousHash = entryHash(envelope);
  });
  return files;
}
const issueEvent = (challengeId = id()): JournalEvent => ({ kind: 'issue', challengeId, tokenDigest: dig('b'), expiresAt: '2026-06-01T12:10:00Z' });
const failureOf = (files: JournalFile[], from: JournalState = emptyJournalState): string => {
  const r = extendJournal(from, files, ctx);
  return r.ok ? 'ok' : r.code;
};
const mutate = (file: JournalFile, change: (doc: Record<string, unknown>) => void, signer: KeyObject = key): JournalFile => {
  const doc = JSON.parse(Buffer.from(file.envelope.payload, 'base64url').toString('utf-8'));
  change(doc);
  return { sequence: file.sequence, envelope: signEnvelope({ domain: 'journal', payload: Buffer.from(JSON.stringify(doc)), privateKey: signer }) };
};

describe('journal entries', () => {
  it('builds a valid chain and describes what it contains', () => {
    const c = id();
    const files = chain([GENESIS, issueEvent(c), { kind: 'consume', challengeId: c, requestId: req(), receiptDigest: dig('c') }]);
    const r = extendJournal(emptyJournalState, files, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.headSequence).toBe(3);
    expect(r.state.headHash).toBe(entryHash(files[2]!.envelope));
    expect(r.state.hashes.get(1)).toBe(entryHash(files[0]!.envelope));
    expect(r.state.issued.get(c)?.sequence).toBe(2);
    expect(r.state.consumed.get(c)?.sequence).toBe(3);
    expect(r.state.lastAtMs).toBe(T(2).getTime());
  });

  it('can be extended incrementally, with the same result as a whole replay', () => {
    const files = chain([GENESIS, issueEvent(), issueEvent(), issueEvent()]);
    const whole = extendJournal(emptyJournalState, files, ctx);
    const first = extendJournal(emptyJournalState, files.slice(0, 2), ctx);
    expect(first.ok && whole.ok).toBe(true);
    if (!first.ok || !whole.ok) return;
    const rest = extendJournal(first.state, files.slice(2), ctx);
    expect(rest.ok && rest.state.headHash === whole.state.headHash && rest.state.issued.size === whole.state.issued.size).toBe(true);
    expect(Object.isFrozen(whole.state)).toBe(true);
  });

  it('names records by a digest of the whole signed envelope', () => {
    const a = signEnvelope({ domain: 'challenge', payload: Buffer.from('{"a":1}'), privateKey: key });
    const b = signEnvelope({ domain: 'challenge', payload: Buffer.from('{"a":2}'), privateKey: key });
    expect(recordDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(recordDigest(a)).toBe(recordDigest({ ...a }));
    expect(recordDigest(a)).not.toBe(recordDigest(b));
    expect(recordDigest({ ...a, domain: 'receipt' })).not.toBe(recordDigest(a)); // the domain is part of it
    expect(recordDigest({ ...a, signature: b.signature })).not.toBe(recordDigest(a));
    expect(entryHash(a)).not.toBe(recordDigest(a)); // the two digests never collide by construction
  });

  it('uses fixed-width file names that sort in order', () => {
    expect(journalFileName(7)).toBe('0000000000000007.json');
    expect(JOURNAL_FILE_NAME.test(journalFileName(123456))).toBe(true);
    for (const bad of ['7.json', '0000000000000007.JSON', '../0000000000000007.json', '0000000000000007.json.tmp', '000000000000000a.json']) expect(JOURNAL_FILE_NAME.test(bad)).toBe(false);
  });

  it('rejects building an invalid entry', () => {
    const base = { privateKey: key, organization: 'acme', storeId: 'store-1', storeGeneration: 'gen-1', sequence: 1, previousHash: ZERO_HASH, at: T(0), event: GENESIS };
    for (const bad of [{ sequence: 0 }, { sequence: 1.5 }, { previousHash: 'nope' }, { at: new Date('x') }]) expect(() => createJournalEntry({ ...base, ...bad })).toThrow('invalid journal entry');
  });
});

describe('detecting damage', () => {
  it('detects a deleted middle entry (gap), a deleted first entry, and a reordered chain', () => {
    const files = chain([GENESIS, issueEvent(), issueEvent(), issueEvent()]);
    expect(failureOf([files[0]!, files[2]!, files[3]!])).toBe('journal_gap');
    expect(failureOf([files[1]!, files[2]!])).toBe('journal_gap'); // starts at 2: the genesis is missing
    expect(failureOf([files[0]!, files[2]!, files[1]!, files[3]!])).toBe('journal_gap');
    expect(failureOf([files[0]!, files[1]!, files[1]!])).toBe('journal_chain_broken'); // a repeated entry
  });

  it('detects a changed entry, a forged entry, an entry signed by another key, and a wrong file name', () => {
    const files = chain([GENESIS, issueEvent(), issueEvent()]);
    const changed = mutate(files[1]!, (d) => { (d.event as Record<string, unknown>).tokenDigest = dig('d'); });
    expect(failureOf([files[0]!, changed, files[2]!])).toBe('journal_chain_broken'); // re-signed by the store key but the NEXT entry no longer chains
    expect(failureOf([files[0]!, mutate(files[1]!, () => undefined, other), files[2]!])).toBe('journal_bad_signature');
    expect(failureOf([files[0]!, { sequence: 2, envelope: { ...files[1]!.envelope, signature: files[1]!.envelope.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } }])).toBe('journal_bad_signature');
    expect(failureOf([files[0]!, { sequence: 3, envelope: files[1]!.envelope }])).toBe('journal_corrupt'); // file name says 3, the signed number says 2
    expect(failureOf([files[0]!, { sequence: 2, envelope: { ...files[1]!.envelope, domain: 'receipt' } as never }])).toBe('journal_corrupt');
  });

  it('detects an entry of another organization, store or generation', () => {
    expect(failureOf(chain([GENESIS], key, 'gen-2'))).toBe('journal_wrong_identity');
    const files = chain([GENESIS]);
    expect(failureOf([mutate(files[0]!, (d) => { d.storeId = 'store-2'; })])).toBe('journal_wrong_identity');
    expect(failureOf([mutate(files[0]!, (d) => { d.organization = 'globex'; })])).toBe('journal_wrong_identity');
  });

  it('detects time moving backwards inside the journal', () => {
    const files = chain([GENESIS, issueEvent(), issueEvent()]);
    const back = mutate(files[2]!, (d) => { d.at = '2026-06-01T11:00:00Z'; });
    expect(failureOf([files[0]!, files[1]!, back])).toBe('journal_time_regression');
  });

  it('requires a genesis first, and only first', () => {
    const noGenesis = chain([issueEvent()]);
    expect(failureOf(noGenesis)).toBe('journal_bad_genesis');
    expect(failureOf(chain([GENESIS, GENESIS]))).toBe('journal_bad_genesis');
  });

  it('refuses inconsistent events: a consumption without an issuance, a double consumption, a double issuance', () => {
    const c = id();
    const consume: JournalEvent = { kind: 'consume', challengeId: c, requestId: req(), receiptDigest: dig('c') };
    expect(failureOf(chain([GENESIS, consume]))).toBe('journal_bad_event');
    expect(failureOf(chain([GENESIS, issueEvent(c), consume, consume]))).toBe('journal_bad_event');
    expect(failureOf(chain([GENESIS, issueEvent(c), issueEvent(c)]))).toBe('journal_bad_event');
  });

  it('allows nothing after a seal, and a seal may not name its own generation', () => {
    expect(failureOf(chain([GENESIS, { kind: 'seal', nextGeneration: 'gen-2' }, issueEvent()]))).toBe('journal_after_seal');
    const sealed = extendJournal(emptyJournalState, chain([GENESIS, { kind: 'seal', nextGeneration: 'gen-2' }]), ctx);
    expect(sealed.ok && sealed.state.sealed).toEqual({ sequence: 2, nextGeneration: 'gen-2' });
    expect(failureOf(chain([GENESIS, { kind: 'seal', nextGeneration: 'gen-1' }]))).toBe('journal_bad_event');
  });

  it('validates recovery events strictly', () => {
    const ok: JournalEvent = { kind: 'recovery', quietUntil: '2026-06-01T12:30:00Z', acknowledged: ['consumption_record_missing'] };
    const r = extendJournal(emptyJournalState, chain([GENESIS, ok]), ctx);
    expect(r.ok && r.state.recoveries[0]).toMatchObject({ sequence: 2, acknowledged: ['consumption_record_missing'] });
    expect(failureOf(chain([GENESIS, { ...ok, quietUntil: '2026-06-01T11:00:00Z' } as JournalEvent]))).toBe('journal_bad_event'); // quiet period ends before it starts
    for (const acknowledged of [['journal_gap'], ['nonsense'], ['unjournaled_record', 'unjournaled_record'], Array(9).fill('unjournaled_record'), 'all']) {
      expect(failureOf(chain([GENESIS, { ...ok, acknowledged } as never])), JSON.stringify(acknowledged)).toBe('journal_corrupt');
    }
    // chain damage can never be acknowledged: only record-level losses are on the list
    expect([...ACKNOWLEDGEABLE_FINDINGS].some((c) => c.startsWith('journal_'))).toBe(false);
  });

  it('rejects malformed events and payloads without throwing', () => {
    const g = chain([GENESIS])[0]!;
    const bad: unknown[] = [
      mutate(g, (d) => { d.event = { kind: 'launch' }; }),
      mutate(g, (d) => { d.event = 'genesis'; }),
      mutate(g, (d) => { d.extra = 1; }),
      mutate(g, (d) => { delete d.at; }),
      mutate(g, (d) => { d.sequence = '1'; }),
      mutate(g, (d) => { d.version = 2; }),
      mutate(g, (d) => { d.event = { kind: 'genesis', previousGeneration: 'gen-0', previousSequence: null, previousHash: null }; }),
      { sequence: 1, envelope: 'not an envelope' },
      { sequence: 1, envelope: null },
      null,
    ];
    for (const [i, file] of bad.entries()) expect(failureOf([file as JournalFile]), `case ${i}`).toMatch(/journal_corrupt|journal_bad_signature/);
    expect(() => extendJournal(emptyJournalState, null as never, ctx)).not.toThrow();
  });

  it('records where a new generation came from', () => {
    const prev = dig('e');
    const files = chain([{ kind: 'genesis', previousGeneration: 'gen-0', previousSequence: 9, previousHash: prev }]);
    const r = extendJournal(emptyJournalState, files, ctx);
    expect(r.ok && r.state.genesis).toEqual({ kind: 'genesis', previousGeneration: 'gen-0', previousSequence: 9, previousHash: prev });
  });
});
