// Tests for the company trust root. Keys are generated in memory per run; the loader tests use an
// isolated temporary directory that is removed afterwards and only ever holds PUBLIC keys.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeyId, exportRawPublicKey } from '../../../../src/features/action-safety/authorization/envelope.js';
import {
  KEY_PURPOSES,
  MAX_TRUST_ROOT_BYTES,
  MAX_TRUST_ROOT_KEYS,
  findTrustedKey,
  isValidatedTrustRoot,
  loadTrustRoot,
  parseTrustRoot,
  parseTrustRootBytes,
  parseUtcTimestamp,
  type TrustRoot,
  type TrustRootFileAccess,
} from '../../../../src/features/action-safety/authorization/trustRoot.js';

const pair = (): { publicKey: KeyObject; privateKey: KeyObject } => generateKeyPairSync('ed25519');

const entryFor = (publicKey: KeyObject, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  keyId: deriveKeyId(publicKey),
  publicKey: exportRawPublicKey(publicKey).toString('base64url'),
  purposes: ['policy'],
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2027-01-01T00:00:00Z',
  ...over,
});

const rootDoc = (keys: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  organization: 'acme',
  createdAt: '2026-01-01T00:00:00Z',
  keys,
  ...over,
});

const code = (r: { ok: boolean; code?: string }): string | undefined => (r.ok ? undefined : r.code);

let a: KeyObject;
let b: KeyObject;
beforeAll(() => {
  a = pair().publicKey;
  b = pair().publicKey;
});

describe('trust root structure', () => {
  it('accepts a valid trust root and returns a validated, frozen object', () => {
    const r = parseTrustRoot(rootDoc([entryFor(a, { purposes: ['policy', 'revocation'] }), entryFor(b, { purposes: ['grant'] })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isValidatedTrustRoot(r.trustRoot)).toBe(true);
    expect(r.trustRoot.organization).toBe('acme');
    expect(r.trustRoot.keys).toHaveLength(2);
    expect(r.trustRoot.keys[0]?.purposes).toEqual(['policy', 'revocation']);
    expect(Object.isFrozen(r.trustRoot)).toBe(true);
    expect(Object.isFrozen(r.trustRoot.keys)).toBe(true);
  });

  it('a hand-built object is not a validated trust root', () => {
    const r = parseTrustRoot(rootDoc([entryFor(a)]));
    if (!r.ok) throw new Error('setup');
    expect(isValidatedTrustRoot({ ...r.trustRoot })).toBe(false);
    expect(isValidatedTrustRoot(null)).toBe(false);
  });

  it('supports exactly the purposes policy, grant, revocation and challenge_store', () => {
    expect([...KEY_PURPOSES]).toEqual(['policy', 'grant', 'revocation', 'challenge_store']);
  });

  it('accepts the challenge_store purpose, alone or beside others, and keeps the signing-domain names out of the purpose list', () => {
    expect(parseTrustRoot(rootDoc([entryFor(a, { purposes: ['challenge_store'] })])).ok).toBe(true);
    expect(parseTrustRoot(rootDoc([entryFor(a, { purposes: ['policy', 'challenge_store'] })])).ok).toBe(true);
    // 'challenge' and 'receipt' are SIGNING DOMAINS, not key purposes
    for (const p of ['challenge', 'receipt', 'challenge-store', 'CHALLENGE_STORE']) {
      expect(code(parseTrustRoot(rootDoc([entryFor(a, { purposes: [p] })]))), p).toBe('unsupported_purpose');
    }
  });

  it('rejects an invalid Ed25519 public key', () => {
    for (const publicKey of ['', 'AAAA', 'A'.repeat(42), `${exportRawPublicKey(a).toString('base64url')}=`, 'not base64!', 5, null]) {
      expect(code(parseTrustRoot(rootDoc([entryFor(a, { publicKey })]))), String(publicKey)).toMatch(/invalid_public_key|malformed/);
    }
  });

  it('rejects a public key that is not Ed25519 (a 32-byte value of another kind is rejected by key id, a PEM by encoding)', () => {
    const pem = a.export({ type: 'spki', format: 'pem' });
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { publicKey: pem })])))).toBe('invalid_public_key');
  });

  it('rejects an incorrect key identifier, including the id of a different real key', () => {
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { keyId: deriveKeyId(b) })])))).toBe('key_id_mismatch');
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { keyId: 'f'.repeat(64) })])))).toBe('key_id_mismatch');
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { keyId: deriveKeyId(a).toUpperCase() })])))).toBe('key_id_mismatch');
  });

  it('rejects duplicate key identifiers', () => {
    expect(code(parseTrustRoot(rootDoc([entryFor(a), entryFor(a, { purposes: ['grant'] })])))).toBe('duplicate_key_id');
  });

  it('rejects missing key purposes', () => {
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { purposes: [] })])))).toBe('missing_purposes');
    const noField = entryFor(a);
    delete noField.purposes;
    expect(code(parseTrustRoot(rootDoc([noField])))).toBe('malformed');
  });

  it('rejects unsupported, repeated and non-string purposes', () => {
    for (const p of ['approval', 'proof', 'evidence_pack', 'admin', 'POLICY', '*', '']) {
      expect(code(parseTrustRoot(rootDoc([entryFor(a, { purposes: [p] })]))), p).toBe('unsupported_purpose');
    }
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { purposes: [1] })])))).toBe('unsupported_purpose');
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { purposes: ['policy', 'policy'] })])))).toBe('duplicate_purpose');
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { purposes: 'policy' })])))).toBe('malformed');
  });

  it('rejects invalid validity windows', () => {
    const win = (notBefore: unknown, notAfter: unknown) => parseTrustRoot(rootDoc([entryFor(a, { notBefore, notAfter })]));
    expect(code(win('2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z'))).toBe('invalid_validity_window');
    expect(code(win('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'))).toBe('invalid_validity_window');
    for (const bad of ['yesterday', '2026-02-31T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00+02:00', '2026-01-01 00:00:00Z', 1767225600, null]) {
      expect(code(win(bad, '2027-01-01T00:00:00Z')), String(bad)).toBe('invalid_timestamp');
      expect(code(win('2026-01-01T00:00:00Z', bad)), String(bad)).toBe('invalid_timestamp');
    }
  });

  it('rejects unsupported trust-root versions', () => {
    for (const version of [0, 2, 1.5, 99, -1]) expect(code(parseTrustRoot(rootDoc([entryFor(a)], { version }))), String(version)).toBe('unsupported_version');
    for (const version of ['1', null, true]) expect(code(parseTrustRoot(rootDoc([entryFor(a)], { version }))), String(version)).toBe('malformed');
  });

  it('rejects extra and missing fields, at the root and on each key', () => {
    expect(code(parseTrustRoot(rootDoc([entryFor(a)], { extra: 1 })))).toBe('malformed');
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { extra: true })])))).toBe('malformed');
    expect(code(parseTrustRoot(rootDoc([entryFor(a, { privateKey: 'x' })])))).toBe('malformed');
    for (const field of ['version', 'organization', 'createdAt', 'keys']) {
      const doc = rootDoc([entryFor(a)]);
      delete doc[field];
      expect(code(parseTrustRoot(doc)), field).toBe('malformed');
    }
    for (const field of ['keyId', 'publicKey', 'notBefore', 'notAfter']) {
      const entry = entryFor(a);
      delete entry[field];
      expect(code(parseTrustRoot(rootDoc([entry]))), field).toBe('malformed');
    }
  });

  it('rejects non-objects, bad key lists and bad organizations', () => {
    for (const bad of [null, undefined, 5, 'x', [], true]) expect(code(parseTrustRoot(bad)), String(bad)).toBe('malformed');
    expect(code(parseTrustRoot(rootDoc([])))).toBe('no_keys');
    expect(code(parseTrustRoot(rootDoc('nope' as unknown as unknown[])))).toBe('malformed');
    expect(code(parseTrustRoot(rootDoc([null])))).toBe('malformed');
    expect(code(parseTrustRoot(rootDoc(Array.from({ length: MAX_TRUST_ROOT_KEYS + 1 }, () => entryFor(a)))))).toBe('too_many_keys');
    for (const organization of ['', 'Acme', 'a b', '-acme', 'x'.repeat(65), 5]) {
      expect(code(parseTrustRoot(rootDoc([entryFor(a)], { organization }))), String(organization)).toMatch(/invalid_organization|malformed/);
    }
    expect(code(parseTrustRoot(rootDoc([entryFor(a)], { createdAt: 'soon' })))).toBe('invalid_timestamp');
  });

  it('never throws on hostile input', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    expect(code(parseTrustRoot(hostile))).toBe('malformed');
    const trapped = rootDoc([new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); } })]);
    expect(parseTrustRoot(trapped).ok).toBe(false);
  });

  it('failure messages are fixed text that never echo the input', () => {
    const r = parseTrustRoot(rootDoc([entryFor(a, { publicKey: 'SECRET-LOOKING-VALUE' })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('SECRET');
  });
});

describe('timestamps', () => {
  it('accepts strict UTC timestamps only', () => {
    expect(parseUtcTimestamp('2026-06-01T12:30:45Z')).toBe(Date.UTC(2026, 5, 1, 12, 30, 45));
    expect(parseUtcTimestamp('2026-06-01T12:30:45.250Z')).toBe(Date.UTC(2026, 5, 1, 12, 30, 45, 250));
    for (const bad of ['2026-06-01', '2026-06-01T12:30:45', '2026-06-01T12:30:45+00:00', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-06-01T25:00:00Z', 5, null, undefined, '']) {
      expect(parseUtcTimestamp(bad), String(bad)).toBeNull();
    }
  });
});

describe('key lookup: purposes and validity windows', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  let root: TrustRoot;
  beforeAll(() => {
    const r = parseTrustRoot(
      rootDoc([
        entryFor(a, { purposes: ['policy'] }),
        entryFor(b, { purposes: ['grant', 'revocation'], notBefore: '2026-09-01T00:00:00Z', notAfter: '2026-12-01T00:00:00Z' }),
      ]),
    );
    if (!r.ok) throw new Error('setup');
    root = r.trustRoot;
  });

  it('returns a key for its declared purpose inside its window', () => {
    const r = findTrustedKey(root, deriveKeyId(a), 'policy', now);
    expect(r.ok).toBe(true);
  });

  it('refuses a key for a purpose it was not declared for', () => {
    expect(findTrustedKey(root, deriveKeyId(a), 'grant', now)).toEqual({ ok: false, code: 'purpose_not_allowed' });
    expect(findTrustedKey(root, deriveKeyId(a), 'revocation', now)).toEqual({ ok: false, code: 'purpose_not_allowed' });
    expect(findTrustedKey(root, deriveKeyId(b), 'policy', new Date('2026-10-01T00:00:00Z'))).toEqual({ ok: false, code: 'purpose_not_allowed' });
  });

  it('refuses unknown keys and non-string key ids', () => {
    expect(findTrustedKey(root, deriveKeyId(pair().publicKey), 'policy', now)).toEqual({ ok: false, code: 'unknown_key' });
    for (const id of [undefined, null, 5, {}, '']) expect(findTrustedKey(root, id, 'policy', now), String(id)).toEqual({ ok: false, code: 'unknown_key' });
  });

  it('enforces the validity window: inclusive start, exclusive end', () => {
    expect(findTrustedKey(root, deriveKeyId(b), 'grant', now)).toEqual({ ok: false, code: 'key_not_yet_valid' });
    expect(findTrustedKey(root, deriveKeyId(b), 'grant', new Date('2026-09-01T00:00:00Z')).ok).toBe(true);
    expect(findTrustedKey(root, deriveKeyId(b), 'grant', new Date('2026-11-30T23:59:59Z')).ok).toBe(true);
    expect(findTrustedKey(root, deriveKeyId(b), 'grant', new Date('2026-12-01T00:00:00Z'))).toEqual({ ok: false, code: 'key_expired' });
  });

  it('refuses an invalid evaluation time and an unvalidated trust root', () => {
    expect(findTrustedKey(root, deriveKeyId(a), 'policy', new Date('nope'))).toEqual({ ok: false, code: 'invalid_evaluation_time' });
    expect(findTrustedKey(root, deriveKeyId(a), 'policy', '2026-06-01' as unknown as Date)).toEqual({ ok: false, code: 'invalid_evaluation_time' });
    expect(findTrustedKey({ ...root }, deriveKeyId(a), 'policy', now)).toEqual({ ok: false, code: 'invalid_trust_root' });
  });
});

describe('trust-root text and bytes', () => {
  const good = (): Buffer => Buffer.from(JSON.stringify(rootDoc([entryFor(a)])), 'utf-8');

  it('parses valid bytes', () => {
    expect(parseTrustRootBytes(good()).ok).toBe(true);
  });

  it('rejects empty, oversized, non-UTF-8, BOM-prefixed and non-JSON bytes', () => {
    expect(code(parseTrustRootBytes(Buffer.alloc(0)))).toBe('empty');
    expect(code(parseTrustRootBytes(Buffer.alloc(MAX_TRUST_ROOT_BYTES + 1, 32)))).toBe('too_large');
    expect(code(parseTrustRootBytes(Buffer.from([0xff, 0xfe, 0xfd])))).toBe('invalid_encoding');
    expect(code(parseTrustRootBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good()])))).toBe('invalid_json');
    expect(code(parseTrustRootBytes(Buffer.from('{not json')))).toBe('invalid_json');
    expect(code(parseTrustRootBytes(Buffer.from('[]')))).toBe('malformed');
    expect(code(parseTrustRootBytes(Buffer.from('null')))).toBe('malformed');
  });
});

describe('loading the trust root', () => {
  let dir: string;
  let location: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codexrev-trustroot-test-'));
    location = join(dir, 'trust-root.json');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a valid trust root from an explicit absolute path', () => {
    writeFileSync(location, JSON.stringify(rootDoc([entryFor(a)])));
    const r = loadTrustRoot({ location });
    expect(r.ok).toBe(true);
  });

  it('fails explicitly when the file is missing (no fallback, nothing created)', () => {
    const missing = join(dir, 'does-not-exist.json');
    expect(code(loadTrustRoot({ location: missing }))).toBe('not_found');
  });

  it('fails when the location is a directory', () => {
    const sub = join(dir, 'a-directory');
    mkdirSync(sub);
    expect(code(loadTrustRoot({ location: sub }))).toBe('not_a_file');
  });

  it('fails for an oversized file without reading it all', () => {
    const big = join(dir, 'big.json');
    writeFileSync(big, Buffer.alloc(MAX_TRUST_ROOT_BYTES + 1, 32));
    expect(code(loadTrustRoot({ location: big }))).toBe('too_large');
  });

  it('fails for an empty file, invalid JSON and an invalid trust root', () => {
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '');
    expect(code(loadTrustRoot({ location: empty }))).toBe('empty');
    const junk = join(dir, 'junk.json');
    writeFileSync(junk, '{oops');
    expect(code(loadTrustRoot({ location: junk }))).toBe('invalid_json');
    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, JSON.stringify(rootDoc([])));
    expect(code(loadTrustRoot({ location: invalid }))).toBe('no_keys');
  });

  it('requires an absolute path: relative, empty and non-string locations are rejected', () => {
    for (const bad of ['trust-root.json', './trust-root.json', '', '..\\x', undefined, null, 5]) {
      expect(code(loadTrustRoot({ location: bad as string })), String(bad)).toBe('path_invalid');
    }
    expect(code(loadTrustRoot({ location: `${location}\0.json` }))).toBe('path_invalid');
    expect(code(loadTrustRoot(undefined as never))).toBe('path_invalid');
  });

  it('refuses a trust root stored inside the project repository', () => {
    writeFileSync(location, JSON.stringify(rootDoc([entryFor(a)])));
    expect(code(loadTrustRoot({ location, excludedRoots: [dir] }))).toBe('path_inside_project');
    expect(code(loadTrustRoot({ location, excludedRoots: [join(dir, 'unrelated')] }))).toBeUndefined();
    expect(code(loadTrustRoot({ location, excludedRoots: [join(dir, '..')] }))).toBe('path_inside_project');
  });

  it('does not treat a sibling directory with a similar name as inside the project', () => {
    writeFileSync(location, JSON.stringify(rootDoc([entryFor(a)])));
    expect(loadTrustRoot({ location, excludedRoots: [`${dir}-other`] }).ok).toBe(true);
  });

  it('supports injected file access, and maps access errors to explicit failures', () => {
    const text = Buffer.from(JSON.stringify(rootDoc([entryFor(a)])));
    const access = (over: Partial<TrustRootFileAccess> = {}): TrustRootFileAccess => ({ realpath: (p) => p, readFile: () => text, ...over });
    const abs = join(dir, 'virtual.json');
    expect(loadTrustRoot({ location: abs }, access()).ok).toBe(true);
    const denied = Object.assign(new Error('x'), { code: 'EACCES' });
    expect(code(loadTrustRoot({ location: abs }, access({ readFile: () => { throw denied; } })))).toBe('unreadable');
    expect(code(loadTrustRoot({ location: abs }, access({ realpath: () => { throw denied; } })))).toBe('unreadable');
    expect(code(loadTrustRoot({ location: abs }, access({ readFile: () => { throw new Error('weird'); } })))).toBe('unreadable');
    expect(code(loadTrustRoot({ location: abs }, access({ readFile: () => Buffer.alloc(MAX_TRUST_ROOT_BYTES + 1) })))).toBe('too_large');
  });

  it('never silently falls back: every failure carries an explicit code and no trust root', () => {
    const r = loadTrustRoot({ location: join(dir, 'nope.json') });
    expect(r.ok).toBe(false);
    expect('trustRoot' in r).toBe(false);
  });
});
