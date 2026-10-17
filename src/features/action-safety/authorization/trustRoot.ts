/**
 * The company trust root: which Ed25519 public keys are trusted, and for what.
 *
 * IMPORTANT: a trust root is a locally installed TRUST ANCHOR, not a certificate. It is not
 * signed and cannot authenticate itself. A well-formed trust-root file proves nothing; its
 * security comes entirely from how it is installed and protected:
 *
 *   - it must live OUTSIDE the project repository, in a location only administrators can write;
 *   - its location must come from protected installation configuration. Ordinary environment
 *     variables and user-writable paths are NOT administrator-protected, so a future strict-mode
 *     activation must not rely solely on developer-controlled configuration;
 *   - nothing in a developer's assessment input may supply, point to, or replace it.
 *
 * This module therefore never searches the working directory, never falls back to a default or
 * empty trust root, and never generates keys. If the trust root is missing, unreadable or invalid
 * the result is an explicit failure (fail closed).
 *
 * Key purposes are declared per key and enforced on every lookup: a key trusted only for grants
 * can never sign a policy. Purposes here are the artifacts a COMPANY key signs. A developer proof
 * is signed by an individual key that grants and policies introduce (later phases),
 * and the Evidence Pack has its own separate provenance key, so neither can appear here.
 *
 * Nothing in this file throws for untrusted input: parsing returns a structured result.
 */

import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { deriveKeyId, importRawPublicKey } from './envelope.js';
import type { KeyId } from './types.js';

export const TRUST_ROOT_VERSION = 1 as const;
/**
 * Purposes a company key may be trusted for. Anything else is rejected. `challenge_store` is the key
 * a challenge store signs its challenge tokens and consumption receipts with; it is a different
 * purpose from policy, grant and revocation, so a key trusted for one of those can never sign them.
 */
export const KEY_PURPOSES = ['policy', 'grant', 'revocation', 'challenge_store'] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

export const MAX_TRUST_ROOT_BYTES = 65_536;
export const MAX_TRUST_ROOT_KEYS = 64;

export type TrustRootFailureCode =
  | 'path_invalid'
  | 'path_inside_project'
  | 'not_found'
  | 'not_a_file'
  | 'unreadable'
  | 'too_large'
  | 'empty'
  | 'invalid_encoding'
  | 'invalid_json'
  | 'malformed'
  | 'unsupported_version'
  | 'invalid_organization'
  | 'invalid_timestamp'
  | 'no_keys'
  | 'too_many_keys'
  | 'invalid_public_key'
  | 'key_id_mismatch'
  | 'duplicate_key_id'
  | 'missing_purposes'
  | 'unsupported_purpose'
  | 'duplicate_purpose'
  | 'invalid_validity_window';

const MESSAGES: Readonly<Record<TrustRootFailureCode, string>> = {
  path_invalid: 'the trust root location must be an absolute path',
  path_inside_project: 'the trust root must be stored outside the project repository',
  not_found: 'the trust root file does not exist',
  not_a_file: 'the trust root location is not a regular file',
  unreadable: 'the trust root file could not be read',
  too_large: 'the trust root file is larger than the allowed size',
  empty: 'the trust root file is empty',
  invalid_encoding: 'the trust root file is not valid UTF-8 text',
  invalid_json: 'the trust root file is not valid JSON',
  malformed: 'the trust root does not have the expected structure',
  unsupported_version: 'the trust root format version is not supported',
  invalid_organization: 'the trust root organization identifier is invalid',
  invalid_timestamp: 'a trust root timestamp is not a valid UTC timestamp',
  no_keys: 'the trust root declares no keys',
  too_many_keys: 'the trust root declares more keys than allowed',
  invalid_public_key: 'a trust root public key is not a valid Ed25519 public key',
  key_id_mismatch: 'a declared key identifier does not match its public key',
  duplicate_key_id: 'the trust root declares the same key more than once',
  missing_purposes: 'a trust root key does not declare any purpose',
  unsupported_purpose: 'a trust root key declares an unsupported purpose',
  duplicate_purpose: 'a trust root key repeats a purpose',
  invalid_validity_window: 'a trust root key has an invalid validity window',
};

export interface TrustRootFailure {
  readonly ok: false;
  readonly code: TrustRootFailureCode;
  /** fixed, safe text */
  readonly message: string;
}

export const trustRootFailure = (code: TrustRootFailureCode): TrustRootFailure => ({ ok: false, code, message: MESSAGES[code] });

export interface TrustedKey {
  readonly keyId: KeyId;
  readonly publicKey: KeyObject;
  readonly purposes: readonly KeyPurpose[];
  /** validity window, inclusive start, exclusive end (epoch milliseconds) */
  readonly notBefore: number;
  readonly notAfter: number;
}

export interface TrustRoot {
  readonly version: typeof TRUST_ROOT_VERSION;
  readonly organization: string;
  readonly createdAt: string;
  readonly keys: readonly TrustedKey[];
}

export type TrustRootResult = { readonly ok: true; readonly trustRoot: TrustRoot } | TrustRootFailure;

/** Only objects produced by parseTrustRoot are accepted by the policy verifier; a hand-built object is not. */
const validated = new WeakSet<object>();
export const isValidatedTrustRoot = (x: unknown): x is TrustRoot => typeof x === 'object' && x !== null && validated.has(x);

// ---------------------------------------------------------------- shared helpers

export const ORGANIZATION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Strict UTC timestamp ("2026-01-31T09:00:00Z", optional milliseconds) to epoch milliseconds.
 * Null for anything else, including impossible dates such as 2026-02-31 and local-time offsets.
 */
export function parseUtcTimestamp(x: unknown): number | null {
  if (typeof x !== 'string' || !TIMESTAMP.test(x)) return null;
  const ms = Date.parse(x);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19) === x.slice(0, 19) ? ms : null;
}

export const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

/** True when the object has exactly these own fields: nothing missing, nothing extra. */
export const hasExactFields = (obj: Record<string, unknown>, fields: readonly string[]): boolean => {
  const own = Object.keys(obj);
  return own.length === fields.length && fields.every((f) => Object.prototype.hasOwnProperty.call(obj, f));
};

// ---------------------------------------------------------------- parsing

const ROOT_FIELDS = ['version', 'organization', 'createdAt', 'keys'] as const;
const KEY_FIELDS = ['keyId', 'publicKey', 'purposes', 'notBefore', 'notAfter'] as const;

/**
 * Validates an untrusted trust-root document and returns a validated, frozen trust root.
 * Never throws. Every rule below fails closed.
 */
export function parseTrustRoot(input: unknown): TrustRootResult {
  try {
    return parseUnchecked(input);
  } catch {
    return trustRootFailure('malformed');
  }
}

function parseUnchecked(input: unknown): TrustRootResult {
  if (!isPlainObject(input) || !hasExactFields(input, ROOT_FIELDS)) return trustRootFailure('malformed');
  const { version, organization, createdAt, keys } = input;
  if (typeof version !== 'number' || !Array.isArray(keys)) return trustRootFailure('malformed');
  if (version !== TRUST_ROOT_VERSION) return trustRootFailure('unsupported_version');
  if (typeof organization !== 'string' || !ORGANIZATION_ID.test(organization)) return trustRootFailure('invalid_organization');
  if (parseUtcTimestamp(createdAt) === null) return trustRootFailure('invalid_timestamp');
  if (keys.length === 0) return trustRootFailure('no_keys');
  if (keys.length > MAX_TRUST_ROOT_KEYS) return trustRootFailure('too_many_keys');

  const seen = new Set<string>();
  const trusted: TrustedKey[] = [];
  for (const entry of keys as unknown[]) {
    const key = parseKey(entry);
    if ('ok' in key) return key;
    if (seen.has(key.keyId)) return trustRootFailure('duplicate_key_id');
    seen.add(key.keyId);
    trusted.push(key);
  }

  const trustRoot: TrustRoot = Object.freeze({
    version: TRUST_ROOT_VERSION,
    organization,
    createdAt: createdAt as string,
    keys: Object.freeze(trusted),
  });
  validated.add(trustRoot);
  return { ok: true, trustRoot };
}

function parseKey(entry: unknown): TrustedKey | TrustRootFailure {
  if (!isPlainObject(entry) || !hasExactFields(entry, KEY_FIELDS)) return trustRootFailure('malformed');
  const { keyId, publicKey, purposes, notBefore, notAfter } = entry;
  if (typeof keyId !== 'string' || typeof publicKey !== 'string' || !Array.isArray(purposes)) return trustRootFailure('malformed');

  let key: KeyObject;
  try {
    key = importRawPublicKey(publicKey);
  } catch {
    return trustRootFailure('invalid_public_key');
  }
  // the declared id must be the id of THIS key: it can never name a different key
  if (keyId !== deriveKeyId(key)) return trustRootFailure('key_id_mismatch');

  if (purposes.length === 0) return trustRootFailure('missing_purposes');
  const declared = new Set<string>();
  for (const p of purposes as unknown[]) {
    if (typeof p !== 'string' || !(KEY_PURPOSES as readonly string[]).includes(p)) return trustRootFailure('unsupported_purpose');
    if (declared.has(p)) return trustRootFailure('duplicate_purpose');
    declared.add(p);
  }

  const from = parseUtcTimestamp(notBefore);
  const to = parseUtcTimestamp(notAfter);
  if (from === null || to === null) return trustRootFailure('invalid_timestamp');
  if (from >= to) return trustRootFailure('invalid_validity_window');

  return Object.freeze({
    keyId,
    publicKey: key,
    purposes: Object.freeze([...declared] as KeyPurpose[]),
    notBefore: from,
    notAfter: to,
  });
}

/** Parses trust-root text: bounded size, strict UTF-8, no BOM, then JSON. Never throws. */
export function parseTrustRootBytes(bytes: Uint8Array): TrustRootResult {
  if (bytes.length === 0) return trustRootFailure('empty');
  if (bytes.length > MAX_TRUST_ROOT_BYTES) return trustRootFailure('too_large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return trustRootFailure('invalid_encoding');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return trustRootFailure('invalid_json');
  }
  return parseTrustRoot(json);
}

// ---------------------------------------------------------------- key lookup

export type KeyLookupFailureCode = 'invalid_trust_root' | 'invalid_evaluation_time' | 'unknown_key' | 'purpose_not_allowed' | 'key_not_yet_valid' | 'key_expired';

export type KeyLookupResult = { readonly ok: true; readonly key: TrustedKey } | { readonly ok: false; readonly code: KeyLookupFailureCode };

/**
 * Finds a key by id and checks that it is trusted for THIS purpose at THIS time. A key that is
 * unknown, not authorized for the purpose, not yet valid or expired is never returned.
 * Callers pass the evaluation time in; nothing here reads the clock.
 */
export function findTrustedKey(trustRoot: TrustRoot, keyId: unknown, purpose: KeyPurpose, now: Date): KeyLookupResult {
  if (!isValidatedTrustRoot(trustRoot)) return { ok: false, code: 'invalid_trust_root' };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { ok: false, code: 'invalid_evaluation_time' };
  const key = typeof keyId === 'string' ? trustRoot.keys.find((k) => k.keyId === keyId) : undefined;
  if (!key) return { ok: false, code: 'unknown_key' };
  if (!key.purposes.includes(purpose)) return { ok: false, code: 'purpose_not_allowed' };
  const t = now.getTime();
  if (t < key.notBefore) return { ok: false, code: 'key_not_yet_valid' };
  if (t >= key.notAfter) return { ok: false, code: 'key_expired' };
  return { ok: true, key };
}

// ---------------------------------------------------------------- loading

/** File access, injectable so tests need no real administrator-owned location. */
export interface TrustRootFileAccess {
  /** resolves symbolic links; throws an error with a `code` (e.g. ENOENT) when the path does not exist */
  readonly realpath: (path: string) => string;
  /** reads a regular file of at most maxBytes; throws an error with a `code` (ENOTFILE, E2BIG, ENOENT...) otherwise */
  readonly readFile: (path: string, maxBytes: number) => Buffer;
}

const fsError = (code: string): Error => Object.assign(new Error(code), { code });

export const defaultFileAccess: TrustRootFileAccess = {
  realpath: (path) => realpathSync(path),
  readFile: (path, maxBytes) => {
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw fsError('ENOTFILE');
      if (stat.size > maxBytes) throw fsError('E2BIG');
      // read at most the size seen above: a file that grows afterwards cannot exceed the limit
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const n = readSync(fd, buffer, offset, stat.size - offset, null);
        if (n === 0) break;
        offset += n;
      }
      return buffer.subarray(0, offset);
    } finally {
      closeSync(fd);
    }
  },
};

export interface LoadTrustRootOptions {
  /**
   * Absolute path of the administrator-installed trust root. It must come from protected
   * installation configuration, never from an assessment input file and never from a search.
   */
  readonly location: string;
  /** directories the trust root must NOT be inside (typically the project repository root) */
  readonly excludedRoots?: readonly string[];
}

const errorCode = (err: unknown): string => (typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '');

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Loads and validates the trust root from an explicit location. There is no fallback: a missing,
 * unreadable, oversized, malformed or invalid file is a failure, never an empty or permissive trust root.
 */
export function loadTrustRoot(options: LoadTrustRootOptions, access: TrustRootFileAccess = defaultFileAccess): TrustRootResult {
  try {
    const location: unknown = options?.location;
    if (typeof location !== 'string' || location.length === 0 || location.includes('\0') || !isAbsolute(location)) return trustRootFailure('path_invalid');

    let real: string;
    try {
      real = access.realpath(location);
    } catch (err) {
      return trustRootFailure(['ENOENT', 'ENOTDIR'].includes(errorCode(err)) ? 'not_found' : 'unreadable');
    }

    for (const root of options.excludedRoots ?? []) {
      let excluded = resolve(root);
      try {
        excluded = access.realpath(excluded);
      } catch {
        // an excluded root that cannot be resolved is still compared by its absolute path
      }
      if (isInside(excluded, real) || isInside(excluded, resolve(location))) return trustRootFailure('path_inside_project');
    }

    let bytes: Buffer;
    try {
      bytes = access.readFile(real, MAX_TRUST_ROOT_BYTES);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'E2BIG') return trustRootFailure('too_large');
      if (code === 'ENOTFILE' || code === 'EISDIR') return trustRootFailure('not_a_file');
      if (code === 'ENOENT' || code === 'ENOTDIR') return trustRootFailure('not_found');
      return trustRootFailure('unreadable');
    }
    return parseTrustRootBytes(bytes);
  } catch {
    return trustRootFailure('unreadable');
  }
}
