/**
 * Codexrev — OS keychain wrapper.
 *
 * Persists the 32-byte data encryption key (DEK) used to seal project
 * secrets. The DEK is bound to the project's absolute path so the same
 * keychain account cannot be reused across different projects.
 *
 * Backend: `keytar` (Windows Credential Manager / macOS Keychain / Linux
 * libsecret via GNOME Keyring or KWallet). When the native module fails
 * to load (e.g. libsecret not installed on Linux), `isAvailable()`
 * returns `false` and all read/write calls throw a `SecretsError` with
 * install instructions. We never silently fall back to plaintext.
 *
 * The test suite can opt into an in-memory fake via
 * `CODEXREV_TEST_FAKE_KEYCHAIN=1` — see `tests/security/keychain.test.ts`.
 */

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SecretsError } from './secrets.js';

export const KEYCHAIN_SERVICE = 'codexrev';

let keytarModule: typeof import('keytar') | null = null;
let keytarLoadAttempted = false;
let keytarLoadError: Error | null = null;
const fakeStore: Map<string, string> = new Map();

function loadKeytar(): typeof import('keytar') | null {
  if (keytarLoadAttempted) return keytarModule;
  keytarLoadAttempted = true;
  if (process.env.CODEXREV_TEST_FAKE_KEYCHAIN === '1') {
    keytarModule = null;
    return null;
  }
  try {
    // `keytar` is a native module; required lazily so unit tests that
    // set the fake env var never touch it.
    keytarModule = require_keytar();
  } catch (err) {
    keytarLoadError = err as Error;
    keytarModule = null;
  }
  return keytarModule;
}

/**
 * `keytar` is a CommonJS native module. We use a runtime indirection so
 * esbuild can keep `keytar` external without us having to add a
 * CJS-only dependency from a TS source file.
 */
function require_keytar(): typeof import('keytar') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('keytar') as typeof import('keytar');
}

export function isAvailable(): boolean {
  if (process.env.CODEXREV_TEST_FAKE_KEYCHAIN === '1') return true;
  const m = loadKeytar();
  if (m) return true;
  return false;
}

export function unavailableReason(): string {
  if (isAvailable()) return 'available';
  if (process.env.CODEXREV_TEST_FAKE_KEYCHAIN === '1') return 'fake-mode-active';
  if (keytarLoadError) {
    return `keytar failed to load: ${keytarLoadError.message}. On Linux, install libsecret-1-0 (e.g. apt install libsecret-1-0).`;
  }
  return 'keytar not available (try installing libsecret-1-0 on Linux).';
}

export function projectKeychainKey(projectRoot: string): string {
  const abs = path.resolve(projectRoot);
  const hash = createHash('sha256').update(abs).digest('hex');
  const user = os.userInfo().username || 'unknown';
  return `${user}:${hash.slice(0, 32)}`;
}

function ensureAvailable(): void {
  if (!isAvailable()) {
    throw new SecretsError(`OS keychain is unavailable: ${unavailableReason()}`);
  }
}

export function getDek(projectRoot: string): Buffer | null {
  ensureAvailable();
  if (process.env.CODEXREV_TEST_FAKE_KEYCHAIN === '1') {
    const v = fakeStore.get(projectKeychainKey(projectRoot));
    return v ? Buffer.from(v, 'base64') : null;
  }
  const m = loadKeytar();
  if (!m) throw new SecretsError(`OS keychain is unavailable: ${unavailableReason()}`);
  return m.getPassword(KEYCHAIN_SERVICE, projectKeychainKey(projectRoot)).then((v) =>
    v ? Buffer.from(v, 'base64') : null,
  ) as unknown as Buffer | null;
}

export async function getDekAsync(projectRoot: string): Promise<Buffer | null> {
  ensureAvailable();
  if (process.env.CODEXREV_TEST_FAKE_KEYCHAIN === '1') {
    const v = fakeStore.get(projectKeychainKey(projectRoot));
    return v ? Buffer.from(v, 'base64') : null;
  }
  const m = loadKeytar();
  if (!m) throw new SecretsError(`OS keychain is unavailable: ${unavailableReason()}`);
  const v = await m.getPassword(KEYCHAIN_SERVICE, projectKeychainKey(projectRoot));
  return v ? Buffer.from(v, 'base64') : null;
}

export function setDek(projectRoot: string, dek: Buffer): Promise<void> {
  ensureAvailable();
  if (process.env.CODEXREV_TEST_FAKE_KEYCHAIN === '1') {
    fakeStore.set(projectKeychainKey(projectRoot), dek.toString('base64'));
    return Promise.resolve();
  }
  const m = loadKeytar();
  if (!m) throw new SecretsError(`OS keychain is unavailable: ${unavailableReason()}`);
  return m.setPassword(KEYCHAIN_SERVICE, projectKeychainKey(projectRoot), dek.toString('base64'));
}

export function deleteDek(projectRoot: string): Promise<boolean> {
  ensureAvailable();
  if (process.env.CODEXREV_TEST_FAKE_KEYCHAIN === '1') {
    return Promise.resolve(fakeStore.delete(projectKeychainKey(projectRoot)));
  }
  const m = loadKeytar();
  if (!m) throw new SecretsError(`OS keychain is unavailable: ${unavailableReason()}`);
  return m.deletePassword(KEYCHAIN_SERVICE, projectKeychainKey(projectRoot));
}

/** Test-only: clear the in-memory fake. Not exported via the public API surface. */
export function _resetFakeStore(): void {
  fakeStore.clear();
}