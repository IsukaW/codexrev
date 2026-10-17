// Tests for the protected strict-mode configuration foundation.
//
// The POSIX protections (ownership, permission bits, ancestor directories, symlinks, inode identity)
// are exercised through an injected in-memory filesystem, so they run on every host and need no
// administrator rights. A few real-file tests run on whatever platform hosts the tests.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_CLOCK_SKEW_SECONDS,
  MAX_STRICT_CONFIG_BYTES,
  PROTECTED_CONFIG_LOCATIONS,
  STRICT_CONFIG_VERSION,
  isAbsoluteConfiguredPath,
  isLoadedStrictConfig,
  loadProtectedStrictConfig,
  loadStrictConfigAt,
  parseStrictConfig,
  protectedConfigLocation,
  type AclVerdict,
  type LoadStrictConfigRequest,
  type StrictConfigFileStat,
  type StrictConfigFs,
  type StrictConfigPlatform,
  type StrictConfigResult,
} from '../../../../src/features/action-safety/authorization/strictConfig.js';

// ---------------------------------------------------------------- fixtures

const LINUX_LOC = PROTECTED_CONFIG_LOCATIONS.linux;
const DARWIN_LOC = PROTECTED_CONFIG_LOCATIONS.darwin;
const WIN_LOC = PROTECTED_CONFIG_LOCATIONS.win32;

const config = (over: Record<string, unknown> = {}): Record<string, any> => ({
  version: 1,
  organization: 'acme',
  mode: 'strict',
  trustRootPath: '/etc/codexrev/trust-root.json',
  policyPath: '/etc/codexrev/policy.json',
  revocationListPath: '/etc/codexrev/revocation.json',
  minPolicyRevision: 5,
  minRevocationListVersion: 3,
  challengeStore: { kind: 'none' },
  ...over,
});

const winConfig = (over: Record<string, unknown> = {}): Record<string, any> =>
  config({
    trustRootPath: 'C:\\ProgramData\\codexrev\\trust-root.json',
    policyPath: 'C:\\ProgramData\\codexrev\\policy.json',
    revocationListPath: 'C:\\ProgramData\\codexrev\\revocation.json',
    ...over,
  });

const json = (doc: unknown): Buffer => Buffer.from(JSON.stringify(doc), 'utf-8');

interface Entry {
  kind: 'file' | 'dir' | 'symlink';
  mode: number;
  uid: number;
  ino?: string;
  dev?: string;
  content?: Buffer;
  size?: number;
}

const errno = (code: string): Error => Object.assign(new Error(`SECRET-FS-DETAIL /home/secret ${code}`), { code });

interface FakeOptions {
  realpaths?: Record<string, string>;
  realpathError?: string;
  openError?: string;
  /** what the OPEN handle reports, to simulate a swap between the check and the open */
  openStat?: Partial<Entry>;
  lstatErrors?: Record<string, string>;
  readReturns?: Buffer;
  readThrows?: boolean;
}

function fakeFs(entries: Record<string, Entry>, o: FakeOptions = {}): { fs: StrictConfigFs; log: { lstat: string[]; realpath: string[]; open: string[]; reads: number; closes: number } } {
  const log = { lstat: [] as string[], realpath: [] as string[], open: [] as string[], reads: 0, closes: 0 };
  const stat = (e: Entry, p: string): StrictConfigFileStat => ({
    isFile: e.kind === 'file',
    isDirectory: e.kind === 'dir',
    isSymbolicLink: e.kind === 'symlink',
    mode: e.mode,
    uid: e.uid,
    size: e.size ?? e.content?.length ?? 0,
    dev: e.dev ?? '1',
    ino: e.ino ?? p,
  });
  const impl: StrictConfigFs = {
    lstat(p) {
      log.lstat.push(p);
      const code = o.lstatErrors?.[p];
      if (code) throw errno(code);
      const e = entries[p];
      if (!e) throw errno('ENOENT');
      return stat(e, p);
    },
    realpath(p) {
      log.realpath.push(p);
      if (o.realpathError) throw errno(o.realpathError);
      return o.realpaths?.[p] ?? p;
    },
    openNoFollow(p) {
      log.open.push(p);
      if (o.openError) throw errno(o.openError);
      const e = entries[p];
      if (!e) throw errno('ENOENT');
      const seen = o.openStat ? { ...e, ...o.openStat } : e;
      return {
        fstat: () => stat(seen, p),
        readAll(max) {
          log.reads++;
          if (o.readThrows) throw errno('EIO');
          return (o.readReturns ?? e.content ?? Buffer.alloc(0)).subarray(0, max);
        },
        close() {
          log.closes++;
        },
      };
    },
  };
  return { fs: impl, log };
}

/** A well-protected POSIX installation: root-owned directories and a root-owned 0644 file. */
const posixWorld = (location: string, content: Buffer = json(config()), over: Record<string, Partial<Entry>> = {}): Record<string, Entry> => {
  const entries: Record<string, Entry> = { '/': { kind: 'dir', mode: 0o755, uid: 0 } };
  const parts = location.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts.slice(0, -1)) {
    cur += `/${part}`;
    entries[cur] = { kind: 'dir', mode: 0o755, uid: 0 };
  }
  entries[location] = { kind: 'file', mode: 0o644, uid: 0, content };
  for (const [p, patch] of Object.entries(over)) entries[p] = { ...(entries[p] as Entry), ...patch };
  return entries;
};

const winWorld = (content: Buffer = json(winConfig()), patch: Partial<Entry> = {}): Record<string, Entry> => ({ [WIN_LOC]: { kind: 'file', mode: 0o666, uid: 1000, content, ...patch } });

const load = (req: Partial<LoadStrictConfigRequest> & { fs: StrictConfigFs }, platform: StrictConfigPlatform = 'linux', location = LINUX_LOC): StrictConfigResult => loadStrictConfigAt({ location, platform, ...req });

const loadLinux = (entries: Record<string, Entry>, o: FakeOptions = {}, extra: Partial<LoadStrictConfigRequest> = {}) => {
  const f = fakeFs(entries, o);
  return { result: load({ fs: f.fs, ...extra }), log: f.log };
};

const loadWin = (entries: Record<string, Entry>, aclVerifier?: (l: string) => AclVerdict, o: FakeOptions = {}) => {
  const f = fakeFs(entries, o);
  return { result: loadStrictConfigAt({ location: WIN_LOC, platform: 'win32', fs: f.fs, ...(aclVerifier ? { aclVerifier } : {}) }), log: f.log };
};

const code = (r: StrictConfigResult | { status?: string; code?: string }): string | undefined => ('code' in r ? (r as { code?: string }).code : undefined);
const parse = (doc: unknown, platform: StrictConfigPlatform = 'linux') => parseStrictConfig(doc, platform);
const parseCode = (doc: unknown, platform: StrictConfigPlatform = 'linux'): string | undefined => {
  const r = parse(doc, platform);
  return 'code' in r ? r.code : undefined;
};

// ---------------------------------------------------------------- valid configuration

describe('a valid strict configuration', () => {
  it('loads from a protected POSIX location and returns a frozen, branded result', () => {
    const { result, log } = loadLinux(posixWorld(LINUX_LOC));
    expect(result.status).toBe('strict');
    if (result.status !== 'strict') return;
    expect(result.blocking).toBe(false);
    expect(result.config).toEqual({
      version: 1,
      organization: 'acme',
      mode: 'strict',
      trustRootPath: '/etc/codexrev/trust-root.json',
      policyPath: '/etc/codexrev/policy.json',
      revocationListPath: '/etc/codexrev/revocation.json',
      minPolicyRevision: 5,
      minRevocationListVersion: 3,
      challengeStore: { kind: 'none' },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config.challengeStore)).toBe(true);
    expect(result.protection.method).toBe('posix_owner_and_mode');
    expect(result.protection.limitations.join(' ')).toMatch(/root|privileged/);
    expect(isLoadedStrictConfig(result)).toBe(true);
    expect(isLoadedStrictConfig({ ...result })).toBe(false);
    expect(isLoadedStrictConfig({ status: 'strict', config: result.config, blocking: false })).toBe(false);
    expect(log.closes).toBe(1);
  });

  it('accepts an external challenge store identifier and a bounded clock-skew policy', () => {
    const doc = config({ challengeStore: { kind: 'external', storeId: 'acme-challenge-store.1' }, clockSkew: { maxSkewSeconds: 120 } });
    const r = loadLinux(posixWorld(LINUX_LOC, json(doc))).result;
    expect(r.status).toBe('strict');
    if (r.status === 'strict') {
      expect(r.config.challengeStore).toEqual({ kind: 'external', storeId: 'acme-challenge-store.1' });
      expect(r.config.clockSkew).toEqual({ maxSkewSeconds: 120 });
    }
  });

  it('leaves clockSkew absent when it is not configured, and accepts the bounds', () => {
    const r = parse(config());
    expect('config' in r && 'clockSkew' in r.config).toBe(false);
    for (const maxSkewSeconds of [0, 1, MAX_CLOCK_SKEW_SECONDS]) expect('config' in parse(config({ clockSkew: { maxSkewSeconds } })), String(maxSkewSeconds)).toBe(true);
  });

  it('loads from the macOS location (a path with a space)', () => {
    const doc = config({ trustRootPath: '/Library/Application Support/codexrev/trust-root.json', policyPath: '/Library/Application Support/codexrev/policy.json', revocationListPath: '/Library/Application Support/codexrev/revocation.json' });
    const f = fakeFs(posixWorld(DARWIN_LOC, json(doc)));
    expect(loadStrictConfigAt({ location: DARWIN_LOC, platform: 'darwin', fs: f.fs }).status).toBe('strict');
  });

  it('accepts the largest allowed revision floors', () => {
    const r = parse(config({ minPolicyRevision: Number.MAX_SAFE_INTEGER, minRevocationListVersion: 1 }));
    expect('config' in r && r.config.minPolicyRevision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts several accepted file modes', () => {
    for (const mode of [0o644, 0o600, 0o640, 0o444, 0o755]) {
      expect(loadLinux(posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { mode } })).result.status, mode.toString(8)).toBe('strict');
    }
  });
});

// ---------------------------------------------------------------- absent, unreadable, corrupt

describe('missing, unreadable and corrupt configuration are different answers', () => {
  it('a missing file is `not_configured`, which is not blocking and says it proves nothing', () => {
    const { result } = loadLinux({ '/': { kind: 'dir', mode: 0o755, uid: 0 } });
    expect(result.status).toBe('not_configured');
    if (result.status !== 'not_configured') return;
    expect(result.blocking).toBe(false);
    expect(result.notice).toMatch(/NOT proof/);
    expect(result.notice).toMatch(/CI/);
  });

  it('a missing parent directory is also `not_configured`', () => {
    const f = fakeFs({}, { lstatErrors: { [LINUX_LOC]: 'ENOTDIR' } });
    expect(load({ fs: f.fs }).status).toBe('not_configured');
  });

  it('any other stat error is `unreadable`, never "absent"', () => {
    for (const c of ['EACCES', 'EIO', 'EPERM', 'ELOOP', '']) {
      const f = fakeFs(posixWorld(LINUX_LOC), { lstatErrors: { [LINUX_LOC]: c || 'EWEIRD' } });
      const r = load({ fs: f.fs });
      expect(r.status, c).toBe('unreadable');
      expect(code(r)).toBe('stat_failed');
      expect(r).toMatchObject({ blocking: true, legacyFallback: 'forbidden' });
    }
  });

  it('a read failure is `unreadable`', () => {
    const r = loadLinux(posixWorld(LINUX_LOC), { readThrows: true }).result;
    expect(r).toMatchObject({ status: 'unreadable', code: 'read_failed', blocking: true });
  });

  it('corrupt JSON is `malformed`', () => {
    for (const text of ['{not json', '{"version":1,', 'null-ish', '{"version":1}}', '']) {
      const r = loadLinux(posixWorld(LINUX_LOC, Buffer.from(text))).result;
      expect(r.status, text).toBe('malformed');
      expect(r).toMatchObject({ blocking: true, legacyFallback: 'forbidden' });
    }
    expect(code(loadLinux(posixWorld(LINUX_LOC, Buffer.from('{not json'))).result)).toBe('invalid_json');
    expect(code(loadLinux(posixWorld(LINUX_LOC, Buffer.alloc(0))).result)).toBe('empty');
  });

  it('non-object JSON is malformed', () => {
    for (const text of ['[]', 'null', '5', '"strict"', 'true']) expect(code(loadLinux(posixWorld(LINUX_LOC, Buffer.from(text))).result), text).toBe('invalid_structure');
  });

  it('invalid UTF-8 is `malformed`, and a byte-order mark is not tolerated', () => {
    expect(code(loadLinux(posixWorld(LINUX_LOC, Buffer.from([0xff, 0xfe, 0xfd]))).result)).toBe('invalid_encoding');
    expect(code(loadLinux(posixWorld(LINUX_LOC, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json(config())]))).result)).toBe('invalid_json');
  });

  it('an oversized file is refused before it is read', () => {
    const big = Buffer.alloc(MAX_STRICT_CONFIG_BYTES + 1, 32);
    const { result, log } = loadLinux(posixWorld(LINUX_LOC, big));
    expect(code(result)).toBe('too_large');
    expect(log.reads).toBe(0);
    expect(log.closes).toBe(1);
  });

  it('a file whose reported size lies is still caught by the bounded read', () => {
    const { result } = loadLinux(posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { size: 10 } }), { readReturns: Buffer.alloc(MAX_STRICT_CONFIG_BYTES + 5, 32) });
    expect(code(result)).toBe('too_large');
  });

  it('a file at exactly the size limit is read (and then judged on content)', () => {
    const text = Buffer.concat([json(config()), Buffer.alloc(MAX_STRICT_CONFIG_BYTES - json(config()).length, 32)]);
    expect(text.length).toBe(MAX_STRICT_CONFIG_BYTES);
    expect(loadLinux(posixWorld(LINUX_LOC, text)).result.status).toBe('strict');
  });
});

// ---------------------------------------------------------------- schema

describe('schema validation', () => {
  it('reports an unsupported version as such, not as malformed', () => {
    for (const version of [0, 2, 3, 99, 1.5, -1]) {
      const r = loadLinux(posixWorld(LINUX_LOC, json(config({ version })))).result;
      expect(r.status, String(version)).toBe('unsupported_version');
      expect(code(r)).toBe('unsupported_version');
      expect(r).toMatchObject({ blocking: true, legacyFallback: 'forbidden' });
    }
    expect(STRICT_CONFIG_VERSION).toBe(1);
  });

  it('a missing or non-numeric version is malformed', () => {
    for (const version of ['1', null, true, [1], {}]) expect(parseCode(config({ version })), String(version)).toBe('invalid_structure');
    const doc = config();
    delete doc.version;
    expect(parseCode(doc)).toBe('invalid_structure');
  });

  it('rejects a wrong organization format', () => {
    for (const organization of ['', 'Acme', 'a b', '-acme', 'x'.repeat(65), 'acme/evil', 5, null, ['acme']]) {
      expect(parseCode(config({ organization })), String(organization)).toBe('invalid_organization');
    }
  });

  it('requires the mandatory strict declaration: only the literal "strict" is accepted', () => {
    for (const mode of ['advisory', 'Strict', 'STRICT', 'legacy', '', 'off', true, false, null, 1, ['strict']]) expect(parseCode(config({ mode })), String(mode)).toBe('invalid_mode');
    const doc = config();
    delete doc.mode;
    expect(parseCode(doc)).toBe('invalid_structure');
  });

  it('rejects missing paths and unexpected fields', () => {
    for (const field of ['trustRootPath', 'policyPath', 'revocationListPath', 'minPolicyRevision', 'minRevocationListVersion', 'challengeStore', 'organization']) {
      const doc = config();
      delete doc[field];
      expect(parseCode(doc), field).toBe('invalid_structure');
    }
    expect(parseCode(config({ extra: 1 }))).toBe('invalid_structure');
    expect(parseCode(config({ enabled: false }))).toBe('invalid_structure');
  });

  it('rejects any credential-like field: the configuration carries no secrets', () => {
    for (const field of ['password', 'token', 'apiKey', 'privateKey', 'bearerToken', 'secret', 'credentials', 'authorization']) {
      expect(parseCode(config({ [field]: 'x' })), field).toBe('invalid_structure');
    }
  });

  it('rejects relative, malformed and non-local paths (POSIX)', () => {
    const bad = ['relative/path.json', './x.json', '../x.json', '', 'trust-root.json', 'https://example.com/trust.json', 'file:///etc/x', '/etc//x', '/etc/../x', '/etc/./x', '/etc/x/', '/etc/a\u0000b', '/etc/a\nb', `/${'a'.repeat(1030)}`, '~/x.json', 5, null, ['/etc/x'], {}];
    for (const p of bad) expect(parseCode(config({ trustRootPath: p })), JSON.stringify(p)?.slice(0, 40)).toBe('invalid_path');
    for (const field of ['policyPath', 'revocationListPath']) expect(parseCode(config({ [field]: 'relative.json' })), field).toBe('invalid_path');
  });

  it('applies Windows path conventions on Windows: local drive paths only', () => {
    expect(isAbsoluteConfiguredPath('C:\\ProgramData\\x.json', 'win32')).toBe(true);
    expect(isAbsoluteConfiguredPath('d:\\a\\b.json', 'win32')).toBe(true);
    for (const p of ['C:/ProgramData/x.json', '\\\\server\\share\\x.json', '\\\\?\\C:\\x', 'C:x.json', 'x.json', '\\x.json', 'C:\\a\\..\\b.json', 'C:\\a\\.\\b.json', 'C:\\a\\\\b.json', 'C:\\a\\b:stream', 'C:\\a\\b ', 'C:\\a\\b.', 'C:\\a\\b*.json', 'C:\\a\\b\\']) {
      expect(isAbsoluteConfiguredPath(p, 'win32'), p).toBe(false);
    }
    expect(isAbsoluteConfiguredPath('/etc/x.json', 'win32')).toBe(false);
    expect(isAbsoluteConfiguredPath('C:\\x.json', 'linux')).toBe(false);
    expect(parseCode(winConfig(), 'win32')).toBeUndefined();
    expect(parseCode(winConfig({ policyPath: 'C:/x/policy.json' }), 'win32')).toBe('invalid_path');
    expect(parseCode(config(), 'win32')).toBe('invalid_path'); // POSIX paths are not accepted on Windows
  });

  it('rejects the same file named for more than one purpose', () => {
    const p = '/etc/codexrev/same.json';
    expect(parseCode(config({ trustRootPath: p, policyPath: p }))).toBe('duplicate_paths');
    expect(parseCode(config({ policyPath: p, revocationListPath: p }))).toBe('duplicate_paths');
    expect(parseCode(config({ trustRootPath: p, revocationListPath: p }))).toBe('duplicate_paths');
    expect(parseCode(winConfig({ trustRootPath: 'C:\\A\\x.json', policyPath: 'c:\\a\\X.json' }), 'win32')).toBe('duplicate_paths');
  });

  it('rejects invalid revision floors', () => {
    const floors = [0, -1, -5, 1.5, 0.5, '5', null, true, [5], {}, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 2 ** 60];
    for (const f of floors) {
      expect(parseCode(config({ minPolicyRevision: f })), `policy ${String(f)}`).toBe('invalid_revision_floor');
      expect(parseCode(config({ minRevocationListVersion: f })), `list ${String(f)}`).toBe('invalid_revision_floor');
    }
  });

  it('accepts only an explicit challenge-store declaration, with no endpoint, protocol or credential', () => {
    const ok = [{ kind: 'none' }, { kind: 'external', storeId: 'store-1' }];
    for (const s of ok) expect(parseCode(config({ challengeStore: s })), JSON.stringify(s)).toBeUndefined();
    const bad: unknown[] = [
      { kind: 'external' },
      { kind: 'external', storeId: '' },
      { kind: 'external', storeId: 'https://store.example.com' },
      { kind: 'external', storeId: 'host:443' },
      { kind: 'external', storeId: 'Store' },
      { kind: 'external', storeId: 'a'.repeat(65) },
      { kind: 'external', storeId: 5 },
      { kind: 'external', storeId: 'x', endpoint: 'https://e' },
      { kind: 'external', storeId: 'x', token: 't' },
      { kind: 'none', storeId: 'x' },
      { kind: 'managed' },
      { kind: 5 },
      {},
      null,
      'none',
      [],
    ];
    for (const s of bad) expect(parseCode(config({ challengeStore: s })), JSON.stringify(s)).toBe('invalid_challenge_store');
    const doc = config();
    delete doc.challengeStore;
    expect(parseCode(doc)).toBe('invalid_structure'); // the declaration cannot be omitted
  });

  it('bounds the optional clock-skew policy', () => {
    for (const skew of [{ maxSkewSeconds: -1 }, { maxSkewSeconds: MAX_CLOCK_SKEW_SECONDS + 1 }, { maxSkewSeconds: 1.5 }, { maxSkewSeconds: '5' }, { maxSkewSeconds: null }, {}, { maxSkewSeconds: 5, extra: 1 }, null, 5, 'x', []]) {
      expect(parseCode(config({ clockSkew: skew })), JSON.stringify(skew)).toBe('invalid_clock_skew');
    }
  });

  it('never throws on hostile documents', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); }, get: () => { throw new Error('boom'); } });
    const getter = config();
    Object.defineProperty(getter, 'organization', { get: () => { throw new Error('boom'); }, enumerable: true });
    for (const bad of [null, undefined, 5, 'x', [], hostile, getter, Object.create({ version: 1 })]) expect('code' in parse(bad)).toBe(true);
  });
});

// ---------------------------------------------------------------- location

describe('the protected location is a fixed constant', () => {
  it('has the documented fixed location per platform', () => {
    expect(PROTECTED_CONFIG_LOCATIONS).toEqual({
      linux: '/etc/codexrev/strict-authorization.json',
      darwin: '/Library/Application Support/codexrev/strict-authorization.json',
      win32: 'C:\\ProgramData\\codexrev\\strict-authorization.json',
    });
    expect(Object.isFrozen(PROTECTED_CONFIG_LOCATIONS)).toBe(true);
    expect(protectedConfigLocation('linux')).toBe(LINUX_LOC);
    expect(protectedConfigLocation('darwin')).toBe(DARWIN_LOC);
    expect(protectedConfigLocation('win32')).toBe(WIN_LOC);
  });

  it('has no location for an unsupported platform, and the loader refuses it', () => {
    for (const p of ['freebsd', 'aix', 'sunos', '', 'Linux', 'win64']) expect(protectedConfigLocation(p), p).toBeUndefined();
    const f = fakeFs(posixWorld(LINUX_LOC));
    const r = loadStrictConfigAt({ location: LINUX_LOC, platform: 'freebsd' as StrictConfigPlatform, fs: f.fs });
    expect(r).toMatchObject({ status: 'invalid_location', code: 'unsupported_platform', blocking: true });
    expect(f.log).toMatchObject({ lstat: [], open: [] });
  });

  it('refuses a location that is not a plain absolute path, before touching the filesystem', () => {
    for (const location of ['', 'relative.json', '/etc/../etc/x.json', '/etc//x.json', '/etc/x/', `${LINUX_LOC}\u0000`, 5 as unknown as string, undefined as unknown as string]) {
      const f = fakeFs(posixWorld(LINUX_LOC));
      const r = loadStrictConfigAt({ location, platform: 'linux', fs: f.fs });
      expect(r, String(location)).toMatchObject({ status: 'invalid_location', code: 'invalid_location_path' });
      expect(f.log.lstat).toEqual([]);
    }
  });

  it('the production entry point takes no arguments, so no value can redirect it', () => {
    expect(loadProtectedStrictConfig.length).toBe(0);
  });

  it('developer-controlled environment variables do not change the location or the answer', () => {
    const names = ['CODEXREV_HOME', 'CODEXREV_STRICT_CONFIG', 'CODEXREV_CONFIG', 'HOME', 'USERPROFILE', 'ProgramData', 'PROGRAMDATA', 'XDG_CONFIG_HOME', 'APPDATA', 'ALLUSERSPROFILE', 'NODE_ENV'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
      const before = loadLinux(posixWorld(LINUX_LOC));
      for (const n of names) process.env[n] = '/tmp/attacker-controlled';
      const after = loadLinux(posixWorld(LINUX_LOC));
      expect(after.result).toEqual(before.result);
      expect(after.log.lstat).toEqual(before.log.lstat);
      expect(after.log.open).toEqual([LINUX_LOC]);
      expect(protectedConfigLocation('linux')).toBe('/etc/codexrev/strict-authorization.json');
      expect(PROTECTED_CONFIG_LOCATIONS.win32).toBe('C:\\ProgramData\\codexrev\\strict-authorization.json');
      // the real entry point gives the same answer whatever the environment says
      const realBefore = (() => {
        for (const n of names) {
          if (saved[n] === undefined) delete process.env[n];
          else process.env[n] = saved[n];
        }
        return loadProtectedStrictConfig();
      })();
      for (const n of names) process.env[n] = '/tmp/attacker-controlled';
      expect(loadProtectedStrictConfig()).toEqual(realBefore);
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });

  it('changing the working directory does not change the location or the answer', () => {
    const cwd = vi.spyOn(process, 'cwd');
    try {
      const baseline = loadLinux(posixWorld(LINUX_LOC));
      cwd.mockReturnValue('/tmp/attacker-project');
      const moved = loadLinux(posixWorld(LINUX_LOC));
      expect(moved.result).toEqual(baseline.result);
      expect(moved.log.lstat).toEqual(baseline.log.lstat);
      const real = loadProtectedStrictConfig();
      cwd.mockReturnValue(path.join(os.tmpdir(), 'elsewhere'));
      expect(loadProtectedStrictConfig()).toEqual(real);
      expect(cwd).toHaveBeenCalledTimes(0); // the module never even asks
    } finally {
      cwd.mockRestore();
    }
  });

  it('a project-local file at the same name is never consulted', () => {
    const local = path.join(process.cwd(), 'strict-authorization.json');
    const f = fakeFs({ ...posixWorld(LINUX_LOC, json(config({ minPolicyRevision: 9 }))), [local.replace(/\\/g, '/')]: { kind: 'file', mode: 0o644, uid: 0, content: json(config({ minPolicyRevision: 1 })) } });
    const r = load({ fs: f.fs });
    expect(r.status === 'strict' && r.config.minPolicyRevision).toBe(9);
    expect(f.log.open).toEqual([LINUX_LOC]);
  });

  it('the source reads no environment variables or working directory, and uses only node:fs and node:path', () => {
    const full = fs.readFileSync(new URL('../../../../src/features/action-safety/authorization/strictConfig.ts', import.meta.url), 'utf-8');
    // the documentation comments name these things on purpose; only executable code is scanned
    const source = full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['process.env', 'process.cwd', 'homedir', 'tmpdir', 'child_process', 'execSync', 'spawn', "'node:os'", 'argv', 'fetch(', 'node:http', 'node:net']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['./trustRoot.js', 'node:fs', 'node:path']);
  });
});

// ---------------------------------------------------------------- POSIX protections

describe('POSIX symlink, ownership and permission protections', () => {
  it('rejects a symbolic link at the location', () => {
    const entries = posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { kind: 'symlink' } });
    const { result, log } = loadLinux(entries);
    expect(result).toMatchObject({ status: 'invalid_location', code: 'symlink', blocking: true, legacyFallback: 'forbidden' });
    expect(log.open).toEqual([]);
  });

  it('rejects a location that is not a regular file', () => {
    const entries = posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { kind: 'dir' } });
    expect(loadLinux(entries).result).toMatchObject({ status: 'invalid_location', code: 'not_regular_file' });
  });

  it('rejects path substitution: a symlinked directory in the path makes the real path differ', () => {
    const { result, log } = loadLinux(posixWorld(LINUX_LOC), { realpaths: { [LINUX_LOC]: '/home/attacker/strict-authorization.json' } });
    expect(result).toMatchObject({ status: 'invalid_location', code: 'path_substitution' });
    expect(log.open).toEqual([]);
  });

  it('a path that vanishes when resolved is path substitution; other resolution errors are unreadable', () => {
    expect(code(loadLinux(posixWorld(LINUX_LOC), { realpathError: 'ENOENT' }).result)).toBe('path_substitution');
    expect(code(loadLinux(posixWorld(LINUX_LOC), { realpathError: 'EACCES' }).result)).toBe('realpath_failed');
  });

  it('refuses to open through a symlink that appears at the last moment (O_NOFOLLOW)', () => {
    for (const c of ['ELOOP', 'EMLINK']) expect(code(loadLinux(posixWorld(LINUX_LOC), { openError: c }).result), c).toBe('symlink');
    expect(code(loadLinux(posixWorld(LINUX_LOC), { openError: 'ENOENT' }).result)).toBe('changed_during_load');
    expect(code(loadLinux(posixWorld(LINUX_LOC), { openError: 'EACCES' }).result)).toBe('read_failed');
  });

  it('detects a swap between the check and the open: the opened file must be the file that was inspected', () => {
    const inode = loadLinux(posixWorld(LINUX_LOC), { openStat: { ino: 'another-inode' } });
    expect(code(inode.result)).toBe('changed_during_load');
    expect(inode.log.reads).toBe(0);
    expect(inode.log.closes).toBe(1);
    expect(code(loadLinux(posixWorld(LINUX_LOC), { openStat: { dev: '2' } }).result)).toBe('changed_during_load');
    // the same file object that is no longer a regular file is refused for that reason
    expect(code(loadLinux(posixWorld(LINUX_LOC), { openStat: { kind: 'dir' } }).result)).toBe('not_regular_file');
  });

  it('on Windows the inode identifies the file; the device is not compared (Node reports it inconsistently there)', () => {
    // regression: a real Windows file has device 0 from lstat and the volume serial from fstat
    expect(loadWin(winWorld(), () => 'protected', { openStat: { dev: '1352902873' } }).result.status).toBe('strict');
    expect(code(loadWin(winWorld(), () => 'protected', { openStat: { ino: 'swapped' } }).result)).toBe('changed_during_load');
  });

  it('judges the open handle, not the earlier lstat: a file that became writable is caught', () => {
    const r = loadLinux(posixWorld(LINUX_LOC), { openStat: { mode: 0o666 } }).result;
    expect(code(r)).toBe('writable_by_others');
    expect(code(loadLinux(posixWorld(LINUX_LOC), { openStat: { uid: 1000 } }).result)).toBe('owner_not_allowed');
  });

  it('rejects a file that group or other users can write', () => {
    for (const mode of [0o664, 0o666, 0o662, 0o646, 0o620, 0o602, 0o777, 0o020, 0o002]) {
      const r = loadLinux(posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { mode } })).result;
      expect(r, mode.toString(8)).toMatchObject({ status: 'insecure', code: 'writable_by_others', blocking: true, legacyFallback: 'forbidden' });
    }
  });

  it('rejects incorrect ownership: only root by default', () => {
    const entries = posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { uid: 1000 } });
    expect(loadLinux(entries).result).toMatchObject({ status: 'insecure', code: 'owner_not_allowed' });
    expect(loadLinux(entries, {}, { allowedOwnerUids: [0, 1] }).result.status).toBe('insecure');
  });

  it('accepts a different administrator uid only when the policy explicitly names it', () => {
    const entries: Record<string, Entry> = {};
    for (const [p, e] of Object.entries(posixWorld(LINUX_LOC))) entries[p] = { ...e, uid: 1000 };
    expect(loadLinux(entries).result.status).toBe('insecure'); // default policy: root only
    expect(loadLinux(entries, {}, { allowedOwnerUids: [1000] }).result.status).toBe('strict');
  });

  it('rejects a parent directory that group or other users can write', () => {
    for (const dir of ['/etc/codexrev', '/etc', '/']) {
      for (const mode of [0o775, 0o777, 0o757, 0o722]) {
        const r = loadLinux(posixWorld(LINUX_LOC, json(config()), { [dir]: { mode } })).result;
        expect(r, `${dir} ${mode.toString(8)}`).toMatchObject({ status: 'insecure', code: 'ancestor_writable' });
      }
    }
  });

  it('rejects a parent directory owned by someone other than an administrator', () => {
    for (const dir of ['/etc/codexrev', '/etc', '/']) {
      expect(loadLinux(posixWorld(LINUX_LOC, json(config()), { [dir]: { uid: 1000 } })).result, dir).toMatchObject({ status: 'insecure', code: 'ancestor_owner_not_allowed' });
    }
  });

  it('rejects a parent that is a symlink or not a directory, and a parent that cannot be inspected', () => {
    expect(code(loadLinux(posixWorld(LINUX_LOC, json(config()), { '/etc/codexrev': { kind: 'symlink' } })).result)).toBe('ancestor_not_directory');
    expect(code(loadLinux(posixWorld(LINUX_LOC, json(config()), { '/etc': { kind: 'file' } })).result)).toBe('ancestor_not_directory');
    const f = fakeFs(posixWorld(LINUX_LOC), { lstatErrors: { '/etc': 'EACCES' } });
    expect(code(load({ fs: f.fs }))).toBe('stat_failed');
  });

  it('checks every ancestor up to the root, in the file system the loader was given', () => {
    const { log } = loadLinux(posixWorld(LINUX_LOC));
    expect(log.lstat).toEqual([LINUX_LOC, '/etc/codexrev', '/etc', '/']);
  });

  it('judges security BEFORE content: an insecure file is never parsed, however good or bad its content', () => {
    for (const content of [json(config()), Buffer.from('{not json')]) {
      const { result, log } = loadLinux(posixWorld(LINUX_LOC, content, { [LINUX_LOC]: { mode: 0o666 } }));
      expect(result.status).toBe('insecure');
      expect(log.reads).toBe(0);
      expect(log.closes).toBe(1);
    }
  });

  it('always closes the handle, whatever the outcome', () => {
    const cases: Array<[Buffer, Record<string, Partial<Entry>>]> = [
      [json(config()), {}],
      [Buffer.from('{not json'), {}],
      [json(config()), { [LINUX_LOC]: { uid: 1000 } }],
      [Buffer.alloc(MAX_STRICT_CONFIG_BYTES + 1), {}],
    ];
    for (const [content, over] of cases) expect(loadLinux(posixWorld(LINUX_LOC, content, over)).log.closes).toBe(1);
  });

  it('does not claim that permission checks stop a privileged attacker', () => {
    const r = loadLinux(posixWorld(LINUX_LOC)).result;
    if (r.status !== 'strict') throw new Error('setup');
    const text = r.protection.limitations.join(' ');
    expect(text).toMatch(/privileged/);
    expect(text).toMatch(/ACL/);
  });
});

// ---------------------------------------------------------------- Windows

describe('Windows: ACLs cannot be verified with built-in APIs', () => {
  it('a valid file with no verifier is `protection_unverified`, blocking, and returns no usable configuration', () => {
    const { result } = loadWin(winWorld());
    expect(result).toMatchObject({ status: 'protection_unverified', code: 'windows_acl_unverified', blocking: true, legacyFallback: 'forbidden' });
    expect('config' in result).toBe(false);
    expect(isLoadedStrictConfig(result)).toBe(false);
  });

  it('is established only by a verifier that answers exactly "protected"', () => {
    const { result } = loadWin(winWorld(), () => 'protected');
    expect(result.status).toBe('strict');
    if (result.status === 'strict') {
      expect(result.protection.method).toBe('windows_acl_verifier');
      expect(result.protection.limitations.join(' ')).toMatch(/verifier/);
    }
  });

  it('an "unprotected" verdict is insecure, and is judged before any content is read', () => {
    const { result, log } = loadWin(winWorld(Buffer.from('{not json')), () => 'unprotected');
    expect(result).toMatchObject({ status: 'insecure', code: 'windows_acl_unprotected' });
    expect(log.open).toEqual([]);
  });

  it('an "unknown" verdict, a throwing verifier and any other answer leave protection unverified', () => {
    const answers: Array<() => AclVerdict> = [() => 'unknown', () => { throw new Error('boom'); }, () => true as unknown as AclVerdict, () => 'yes' as unknown as AclVerdict, () => 'PROTECTED' as unknown as AclVerdict, () => undefined as unknown as AclVerdict, () => ({ trusted: true }) as unknown as AclVerdict];
    for (const verifier of answers) expect(loadWin(winWorld(), verifier).result, String(verifier)).toMatchObject({ status: 'protection_unverified', code: 'windows_acl_unverified' });
  });

  it('a caller-supplied boolean is not accepted as proof of protection', () => {
    const f = fakeFs(winWorld());
    for (const extra of [{ trusted: true }, { protected: true }, { trustedInstaller: true }, { aclVerified: true }]) {
      const r = loadStrictConfigAt({ location: WIN_LOC, platform: 'win32', fs: f.fs, ...extra } as unknown as LoadStrictConfigRequest);
      expect(r, JSON.stringify(extra)).toMatchObject({ status: 'protection_unverified' });
    }
  });

  it('POSIX owner and mode bits are ignored on Windows: they neither establish nor deny protection', () => {
    // a 0666 file owned by uid 1000 is fine with a verifier, and a 0600 root-owned file is still unverified without one
    expect(loadWin(winWorld(json(winConfig()), { mode: 0o666, uid: 1000 }), () => 'protected').result.status).toBe('strict');
    expect(loadWin(winWorld(json(winConfig()), { mode: 0o600, uid: 0 })).result.status).toBe('protection_unverified');
  });

  it('content problems are still reported as such, not hidden behind the protection status', () => {
    expect(loadWin(winWorld(Buffer.from('{not json'))).result).toMatchObject({ status: 'malformed', code: 'invalid_json' });
    expect(loadWin(winWorld(json(winConfig({ version: 2 })))).result.status).toBe('unsupported_version');
    expect(loadWin(winWorld(json(config()))).result).toMatchObject({ status: 'malformed', code: 'invalid_path' }); // POSIX paths on Windows
  });

  it('still refuses symlinks, substituted paths and swapped files on Windows', () => {
    expect(code(loadWin(winWorld(json(winConfig()), { kind: 'symlink' }), () => 'protected').result)).toBe('symlink');
    expect(code(loadWin(winWorld(), () => 'protected', { realpaths: { [WIN_LOC]: 'C:\\Users\\attacker\\strict-authorization.json' } }).result)).toBe('path_substitution');
    expect(code(loadWin(winWorld(), () => 'protected', { openStat: { ino: 'x' } }).result)).toBe('changed_during_load');
  });

  it('compares the resolved path without regard to case on Windows', () => {
    const upper = WIN_LOC.toUpperCase();
    expect(loadWin(winWorld(), () => 'protected', { realpaths: { [WIN_LOC]: upper } }).result.status).toBe('strict');
  });

  it('a missing file on Windows is `not_configured`, and the verifier is not consulted', () => {
    const verifier = vi.fn((): AclVerdict => 'protected');
    const { result } = loadWin({}, verifier);
    expect(result.status).toBe('not_configured');
    expect(verifier).not.toHaveBeenCalled();
  });

  it('does not examine ancestor directories on Windows (it cannot judge their ACLs)', () => {
    expect(loadWin(winWorld(), () => 'protected').log.lstat).toEqual([WIN_LOC]);
  });
});

// ---------------------------------------------------------------- states, safety, hostile input

describe('every failure blocks; only absence does not', () => {
  it('no failure status permits a fall back to legacy mode', () => {
    const results: StrictConfigResult[] = [
      loadLinux(posixWorld(LINUX_LOC, Buffer.from('{bad'))).result,
      loadLinux(posixWorld(LINUX_LOC, json(config({ version: 2 })))).result,
      loadLinux(posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { mode: 0o666 } })).result,
      loadLinux(posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { kind: 'symlink' } })).result,
      loadLinux(posixWorld(LINUX_LOC), { readThrows: true }).result,
      loadWin(winWorld()).result,
      loadStrictConfigAt({ location: LINUX_LOC, platform: 'plan9' as StrictConfigPlatform, fs: fakeFs({}).fs }),
    ];
    for (const r of results) {
      expect(r.blocking, r.status).toBe(true);
      expect(r).toMatchObject({ legacyFallback: 'forbidden' });
      expect(r.status).not.toBe('not_configured');
      expect(r.status).not.toBe('strict');
    }
    const absent = loadLinux({ '/': { kind: 'dir', mode: 0o755, uid: 0 } }).result;
    expect(absent.status).toBe('not_configured');
    expect(absent.blocking).toBe(false);
  });

  it('distinguishes the eight states', () => {
    const states = new Set<string>([
      loadLinux(posixWorld(LINUX_LOC)).result.status,
      loadLinux({}).result.status,
      loadLinux(posixWorld(LINUX_LOC), { readThrows: true }).result.status,
      loadLinux(posixWorld(LINUX_LOC, Buffer.from('{'))).result.status,
      loadLinux(posixWorld(LINUX_LOC, json(config({ version: 7 })))).result.status,
      loadLinux(posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { kind: 'symlink' } })).result.status,
      loadLinux(posixWorld(LINUX_LOC, json(config()), { [LINUX_LOC]: { mode: 0o666 } })).result.status,
      loadWin(winWorld()).result.status,
    ]);
    expect([...states].sort()).toEqual(['insecure', 'invalid_location', 'malformed', 'not_configured', 'protection_unverified', 'strict', 'unreadable', 'unsupported_version']);
  });
});

describe('safe messages and hostile input', () => {
  const SENTINEL = 'SENTINEL-SECRET-VALUE';

  it('failure messages are fixed text: they never echo file content, configured values or system error details', () => {
    const docs: Record<string, unknown>[] = [
      config({ organization: SENTINEL }),
      config({ trustRootPath: `relative/${SENTINEL}` }),
      config({ [SENTINEL]: 1 }),
      config({ mode: SENTINEL }),
      config({ challengeStore: { kind: 'external', storeId: SENTINEL } }),
      config({ minPolicyRevision: SENTINEL }),
      config({ password: SENTINEL }),
      config({ version: SENTINEL }),
    ];
    for (const doc of docs) {
      const r = loadLinux(posixWorld(LINUX_LOC, json(doc))).result;
      expect(r.status).not.toBe('strict');
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    }
    const sys = loadLinux(posixWorld(LINUX_LOC), { realpathError: 'EACCES' }).result;
    expect(JSON.stringify(sys)).not.toContain('SECRET-FS-DETAIL');
    expect(JSON.stringify(sys)).not.toContain('/home/secret');
    const lstatFail = loadLinux(posixWorld(LINUX_LOC), { lstatErrors: { [LINUX_LOC]: 'EACCES' } }).result;
    expect(JSON.stringify(lstatFail)).not.toContain('SECRET-FS-DETAIL');
    expect(JSON.stringify(loadLinux(posixWorld(LINUX_LOC, Buffer.from(`{"x":"${SENTINEL}`))).result)).not.toContain(SENTINEL);
  });

  it('an error thrown with a secret message is contained', () => {
    const throwing: StrictConfigFs = {
      lstat: () => { throw new Error(SENTINEL); },
      realpath: () => { throw new Error(SENTINEL); },
      openNoFollow: () => { throw new Error(SENTINEL); },
    };
    const r = load({ fs: throwing });
    expect(r.status).toBe('unreadable');
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it('every failure message is non-empty and carries a stable code', () => {
    const r = loadLinux(posixWorld(LINUX_LOC, Buffer.from('{'))).result;
    expect(r).toMatchObject({ code: 'invalid_json' });
    if ('message' in r) expect(r.message.length).toBeGreaterThan(10);
  });

  it('never throws on a hostile request or hostile filesystem', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); }, ownKeys: () => { throw new Error('boom'); }, getPrototypeOf: () => { throw new Error('boom'); } });
    for (const req of [undefined, null, 5, 'x', [], {}, hostile]) {
      const r = loadStrictConfigAt(req as unknown as LoadStrictConfigRequest);
      expect(r.status, JSON.stringify(typeof req)).not.toBe('strict');
      expect(r.status).not.toBe('not_configured');
    }
    const brokenFs = [
      { lstat: () => 5, realpath: () => 5, openNoFollow: () => 5 },
      { lstat: () => null, realpath: () => null, openNoFollow: () => null },
      hostile,
    ];
    for (const f of brokenFs) {
      const r = load({ fs: f as unknown as StrictConfigFs });
      expect(['strict', 'not_configured']).not.toContain(r.status);
    }
  });

  it('a handle that misbehaves cannot produce a strict result', () => {
    const entries = posixWorld(LINUX_LOC);
    const base = fakeFs(entries).fs;
    const lying: StrictConfigFs = {
      ...base,
      openNoFollow: () => ({
        fstat: () => { throw new Error('boom'); },
        readAll: () => Buffer.from('{}'),
        close: () => { throw new Error('close failed'); },
      }),
    };
    expect(load({ fs: lying }).status).not.toBe('strict');
  });
});

// ---------------------------------------------------------------- real files on the host platform

describe('real files, on whatever platform hosts the tests', () => {
  let dir: string;
  let file: string;
  const onWindows = process.platform === 'win32';
  const hostPlatform = (onWindows ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux') as StrictConfigPlatform;

  beforeAll(() => {
    // resolve links in the temporary directory first, so the path equals its own real path
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexrev-strictcfg-test-')));
    file = path.join(dir, 'strict-authorization.json');
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    fs.rmSync(file, { force: true });
  });

  const realConfig = (): Record<string, unknown> =>
    onWindows
      ? config({ trustRootPath: path.join(dir, 'trust.json'), policyPath: path.join(dir, 'policy.json'), revocationListPath: path.join(dir, 'revocation.json') })
      : config({ trustRootPath: path.join(dir, 'trust.json'), policyPath: path.join(dir, 'policy.json'), revocationListPath: path.join(dir, 'revocation.json') });

  it('a missing real file is `not_configured`', () => {
    expect(loadStrictConfigAt({ location: file, platform: hostPlatform }).status).toBe('not_configured');
  });

  it('reads a real file through the real filesystem implementation (verifier supplied on Windows; ancestors judged on POSIX)', () => {
    fs.writeFileSync(file, JSON.stringify(realConfig()));
    if (onWindows) {
      expect(loadStrictConfigAt({ location: file, platform: 'win32' }).status).toBe('protection_unverified');
      const r = loadStrictConfigAt({ location: file, platform: 'win32', aclVerifier: () => 'protected' });
      expect(r.status).toBe('strict');
      if (r.status === 'strict') expect(r.config.organization).toBe('acme');
    } else {
      fs.chmodSync(file, 0o644);
      const uid = process.getuid?.() ?? 0;
      // a temporary directory sits under a world-writable parent (or one owned by someone else): refused, as it should be
      const r = loadStrictConfigAt({ location: file, platform: hostPlatform, allowedOwnerUids: [uid] });
      expect(r).toMatchObject({ status: 'insecure', blocking: true });
      expect(['ancestor_writable', 'ancestor_owner_not_allowed']).toContain(code(r));
    }
  });

  it('refuses a real directory and a real unreadable-JSON file correctly', () => {
    fs.mkdirSync(file);
    expect(loadStrictConfigAt({ location: file, platform: hostPlatform }).status).toBe('invalid_location');
    fs.rmSync(file, { recursive: true, force: true });
    if (onWindows) {
      fs.writeFileSync(file, '{not json');
      expect(loadStrictConfigAt({ location: file, platform: 'win32', aclVerifier: () => 'protected' })).toMatchObject({ status: 'malformed', code: 'invalid_json' });
    }
  });

  it('refuses a real symbolic link when the platform lets the test create one', () => {
    const target = path.join(dir, 'real-target.json');
    fs.writeFileSync(target, JSON.stringify(realConfig()));
    try {
      fs.symlinkSync(target, file);
    } catch {
      fs.rmSync(target, { force: true });
      return; // creating symlinks needs a privilege this host does not grant: nothing to test here
    }
    try {
      const r = loadStrictConfigAt({ location: file, platform: hostPlatform, ...(onWindows ? { aclVerifier: () => 'protected' as AclVerdict } : {}) });
      expect(r).toMatchObject({ status: 'invalid_location', code: 'symlink', blocking: true });
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it('refuses a real oversized file without reading it all', () => {
    fs.writeFileSync(file, Buffer.alloc(MAX_STRICT_CONFIG_BYTES + 1, 32));
    const r = loadStrictConfigAt({ location: file, platform: hostPlatform, allowedOwnerUids: [process.getuid?.() ?? 0], ...(onWindows ? { aclVerifier: () => 'protected' as AclVerdict } : {}) });
    expect(['malformed', 'insecure']).toContain(r.status);
    if (onWindows) expect(code(r)).toBe('too_large');
  });
});
