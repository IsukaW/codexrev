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
  if (isFakeMode()) {
    keytarModule = null;
    return null;
  }
  try {
    keytarModule = require_keytar();
  } catch (err) {
    keytarLoadError = err as Error;
    keytarModule = null;
  }
  return keytarModule;
}

function require_keytar(): typeof import('keytar') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('keytar') as typeof import('keytar');
}

export function isFakeMode(): boolean {
  return process.env.CODEXREV_TEST_FAKE_KEYCHAIN === '1';
}

export function isAvailable(): boolean {
  if (isFakeMode()) return true;
  return loadKeytar() !== null;
}

export function unavailableReason(): string {
  if (isAvailable()) return 'available';
  if (isFakeMode()) return 'fake-mode-active';
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

export async function getDek(projectRoot: string): Promise<Buffer | null> {
  ensureAvailable();
  const account = projectKeychainKey(projectRoot);
  if (isFakeMode()) {
    const v = fakeStore.get(account);
    return v ? Buffer.from(v, 'base64') : null;
  }
  const m = loadKeytar();
  if (!m) throw new SecretsError(`OS keychain is unavailable: ${unavailableReason()}`);
  const v = await m.getPassword(KEYCHAIN_SERVICE, account);
  return v ? Buffer.from(v, 'base64') : null;
}

export async function setDek(projectRoot: string, dek: Buffer): Promise<void> {
  ensureAvailable();
  const account = projectKeychainKey(projectRoot);
  if (isFakeMode()) {
    fakeStore.set(account, dek.toString('base64'));
    return;
  }
  const m = loadKeytar();
  if (!m) throw new SecretsError(`OS keychain is unavailable: ${unavailableReason()}`);
  await m.setPassword(KEYCHAIN_SERVICE, account, dek.toString('base64'));
}

export async function deleteDek(projectRoot: string): Promise<boolean> {
  ensureAvailable();
  const account = projectKeychainKey(projectRoot);
  if (isFakeMode()) {
    return fakeStore.delete(account);
  }
  const m = loadKeytar();
  if (!m) throw new SecretsError(`OS keychain is unavailable: ${unavailableReason()}`);
  return m.deletePassword(KEYCHAIN_SERVICE, account);
}

/** Test-only: clear the in-memory fake. Not part of the public API surface. */
export function _resetFakeStore(): void {
  fakeStore.clear();
}