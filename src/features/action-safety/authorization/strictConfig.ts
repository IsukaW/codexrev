/**
 * Protected strict-mode configuration: the foundation only. Nothing here is wired into the CLI or
 * the assessment pipeline, and loading a configuration changes no behaviour by itself.
 *
 * WHAT THE FILE IS. An administrator-installed JSON file at a FIXED, platform-specific location.
 * It declares that strict authorization is mandatory for this organization and says WHERE the
 * trusted materials are expected: the trust root, the signed policy and the signed revocation list,
 * plus floors for the policy revision and the revocation-list version, a statement about the
 * challenge store, and an optional clock-skew bound. It contains no credentials of any kind.
 *
 * WHAT THE FILE IS NOT. Reading it does not, by itself:
 *   - verify the signed policy or the signed revocation list (policy.ts / revocation.ts do that);
 *   - establish the integrity of the CodeXRev executable (whoever can replace the binary can ignore
 *     this file entirely);
 *   - prove that the operating system protects the file (see "Protection" below);
 *   - provide a trusted clock, a working challenge store, or any enforcement of a deployment.
 * The presence of a valid file does NOT make authorization secure; it only tells the later stages
 * what a protected installation expects.
 *
 * LOCATION. The production location is a constant per platform (see PROTECTED_CONFIG_LOCATIONS).
 * It is never taken from the working directory, project or user settings, environment variables,
 * CLI flags or an assessment JSON file: this module does not read `process.env` or `process.cwd()`
 * at all. The production entry point `loadProtectedStrictConfig()` takes NO path. A path can only be
 * supplied to `loadStrictConfigAt`, which exists for tests and trusted installers; callers must
 * never feed it a developer-controlled value.
 *
 * STATES. The loader returns exactly one of:
 *   strict                 a valid strict configuration from a location whose protection was checked
 *   not_configured         nothing at the location. NOT proof that strict mode was never installed
 *                          (an attacker able to delete the file produces the same answer): a
 *                          protected CI runner must independently require strict mode
 *   unreadable             present but could not be read
 *   malformed              unusable content (not UTF-8, not JSON, wrong shape, bad values)
 *   unsupported_version    a configuration format version this code does not read
 *   invalid_location       symlink, not a regular file, path substitution, unsupported platform
 *   insecure               permissions or ownership that let someone else modify it
 *   protection_unverified  valid content, but protection could not be verified (always the case on
 *                          Windows unless a trusted verifier is supplied)
 * Every state except `not_configured` is `blocking`: the caller must NOT fall back to legacy mode.
 * A corrupt or insecure configuration is never treated as "no configuration".
 *
 * PROTECTION (POSIX). Checked on the OPEN FILE HANDLE where possible, so the file that is checked is
 * the file that is read:
 *   - the leaf is opened with O_NOFOLLOW, so a symlink at the final component is refused;
 *   - the real path must equal the expected path (no symlinked directory in the path);
 *   - the handle must describe the same file (device and inode) that lstat saw, which catches a swap
 *     between the check and the open;
 *   - the file and EVERY ancestor directory must be owned by an allowed administrator uid (default
 *     root) and must not be group- or world-writable.
 * Residual risks, stated plainly: a privileged attacker (root, or anyone who can change the
 * ancestors' ownership) defeats all of this; a directory that is replaced after the ancestor walk is
 * not re-checked; mode bits say nothing about ACLs, extended attributes, mounts or immutable flags.
 * These checks make accidental or low-privilege tampering harder. They are not a security boundary
 * against an administrator.
 *
 * PROTECTION (WINDOWS). POSIX mode bits and uids say nothing about Windows ACLs, and Node's built-in
 * APIs cannot read ACLs. So by default a Windows installation is `protection_unverified`, even for a
 * valid file. A trusted installer or protected runtime may supply an `aclVerifier` function, which
 * is the only way to establish protection there; its answer must be exactly 'protected'. A boolean
 * flag such as `trusted: true` is deliberately not accepted anywhere. (A function is also supplied
 * by the caller: it is a seam for a trusted component, not proof in itself.)
 *
 * Nothing here throws for bad configuration: every outcome is a typed, safe result whose messages
 * are fixed text and never echo file content.
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { ORGANIZATION_ID, hasExactFields, isPlainObject } from './trustRoot.js';

export const STRICT_CONFIG_VERSION = 1 as const;
export const MAX_STRICT_CONFIG_BYTES = 16_384;
export const MAX_CONFIGURED_PATH_CHARS = 1024;
/** Upper bound for a configured clock-skew allowance: no more than the lifetime of a proof. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export type StrictConfigPlatform = 'linux' | 'darwin' | 'win32';
export const STRICT_CONFIG_PLATFORMS: readonly StrictConfigPlatform[] = ['linux', 'darwin', 'win32'];

/**
 * Fixed, administrator-controlled locations. They are constants on purpose: not derived from the
 * environment, the working directory or any setting. (Windows uses the conventional ProgramData
 * location on drive C: as a constant, because the ProgramData environment variable is
 * developer-controlled and must not be trusted.)
 */
export const PROTECTED_CONFIG_LOCATIONS: Readonly<Record<StrictConfigPlatform, string>> = Object.freeze({
  linux: '/etc/codexrev/strict-authorization.json',
  darwin: '/Library/Application Support/codexrev/strict-authorization.json',
  win32: 'C:\\ProgramData\\codexrev\\strict-authorization.json',
});

/** The fixed location for a platform, or undefined for a platform this module does not support. */
export function protectedConfigLocation(platform: string): string | undefined {
  return (STRICT_CONFIG_PLATFORMS as readonly string[]).includes(platform) ? PROTECTED_CONFIG_LOCATIONS[platform as StrictConfigPlatform] : undefined;
}

// ---------------------------------------------------------------- configuration

export type ChallengeStoreSetting =
  /** an explicit declaration that no trusted challenge store is configured: replay protection is then unavailable */
  | { readonly kind: 'none' }
  /** names a store the later integration will resolve. An opaque identifier only: no endpoint, protocol or credential. */
  | { readonly kind: 'external'; readonly storeId: string };

export interface StrictConfig {
  readonly version: typeof STRICT_CONFIG_VERSION;
  readonly organization: string;
  /** mandatory declaration: the only accepted value is 'strict' */
  readonly mode: 'strict';
  /** absolute paths where the trusted materials are EXPECTED. They are not verified by this module. */
  readonly trustRootPath: string;
  readonly policyPath: string;
  readonly revocationListPath: string;
  /** the lowest company policy revision that may be accepted */
  readonly minPolicyRevision: number;
  /** the lowest revocation-list version that may be accepted */
  readonly minRevocationListVersion: number;
  readonly challengeStore: ChallengeStoreSetting;
  /** bound for a FUTURE trusted time source: how far the local clock may differ from it. Absent = not configured. */
  readonly clockSkew?: { readonly maxSkewSeconds: number };
}

// ---------------------------------------------------------------- results

export type StrictConfigFailureStatus = 'unreadable' | 'malformed' | 'unsupported_version' | 'invalid_location' | 'insecure' | 'protection_unverified';

export type StrictConfigFailureCode =
  | 'stat_failed'
  | 'realpath_failed'
  | 'read_failed'
  | 'empty'
  | 'too_large'
  | 'invalid_encoding'
  | 'invalid_json'
  | 'invalid_structure'
  | 'invalid_organization'
  | 'invalid_mode'
  | 'invalid_path'
  | 'duplicate_paths'
  | 'invalid_revision_floor'
  | 'invalid_challenge_store'
  | 'invalid_clock_skew'
  | 'unsupported_version'
  | 'unsupported_platform'
  | 'invalid_location_path'
  | 'symlink'
  | 'not_regular_file'
  | 'path_substitution'
  | 'changed_during_load'
  | 'writable_by_others'
  | 'owner_not_allowed'
  | 'ancestor_not_directory'
  | 'ancestor_writable'
  | 'ancestor_owner_not_allowed'
  | 'windows_acl_unprotected'
  | 'windows_acl_unverified';

const MESSAGES: Readonly<Record<StrictConfigFailureCode, string>> = {
  stat_failed: 'the strict configuration location could not be inspected',
  realpath_failed: 'the strict configuration path could not be resolved',
  read_failed: 'the strict configuration file could not be read',
  empty: 'the strict configuration file is empty',
  too_large: 'the strict configuration file is larger than the allowed size',
  invalid_encoding: 'the strict configuration file is not valid UTF-8 text',
  invalid_json: 'the strict configuration file is not valid JSON',
  invalid_structure: 'the strict configuration does not have the expected structure',
  invalid_organization: 'the strict configuration organization identifier is invalid',
  invalid_mode: 'the strict configuration does not declare the mandatory strict mode',
  invalid_path: 'a path in the strict configuration is not a valid absolute path for this platform',
  duplicate_paths: 'the strict configuration names the same file for more than one purpose',
  invalid_revision_floor: 'a minimum version in the strict configuration is not a positive whole number',
  invalid_challenge_store: 'the challenge store setting in the strict configuration is invalid',
  invalid_clock_skew: 'the clock skew setting in the strict configuration is invalid',
  unsupported_version: 'the strict configuration format version is not supported',
  unsupported_platform: 'this platform has no protected strict configuration location',
  invalid_location_path: 'the protected strict configuration location is not a valid absolute path',
  symlink: 'the strict configuration location is a symbolic link',
  not_regular_file: 'the strict configuration location is not a regular file',
  path_substitution: 'the strict configuration path resolves somewhere else, so a link is in the path',
  changed_during_load: 'the strict configuration file changed while it was being loaded',
  writable_by_others: 'the strict configuration file can be modified by group or other users',
  owner_not_allowed: 'the strict configuration file is not owned by an allowed administrator',
  ancestor_not_directory: 'a parent of the strict configuration file is not a plain directory',
  ancestor_writable: 'a parent directory of the strict configuration file can be modified by group or other users',
  ancestor_owner_not_allowed: 'a parent directory of the strict configuration file is not owned by an allowed administrator',
  windows_acl_unprotected: 'the strict configuration file is not protected by an administrator-only access list',
  windows_acl_unverified: 'the protection of the strict configuration file could not be verified on this platform',
};

const STATUS_OF: Readonly<Record<StrictConfigFailureCode, StrictConfigFailureStatus>> = {
  stat_failed: 'unreadable',
  realpath_failed: 'unreadable',
  read_failed: 'unreadable',
  empty: 'malformed',
  too_large: 'malformed',
  invalid_encoding: 'malformed',
  invalid_json: 'malformed',
  invalid_structure: 'malformed',
  invalid_organization: 'malformed',
  invalid_mode: 'malformed',
  invalid_path: 'malformed',
  duplicate_paths: 'malformed',
  invalid_revision_floor: 'malformed',
  invalid_challenge_store: 'malformed',
  invalid_clock_skew: 'malformed',
  unsupported_version: 'unsupported_version',
  unsupported_platform: 'invalid_location',
  invalid_location_path: 'invalid_location',
  symlink: 'invalid_location',
  not_regular_file: 'invalid_location',
  path_substitution: 'invalid_location',
  changed_during_load: 'invalid_location',
  writable_by_others: 'insecure',
  owner_not_allowed: 'insecure',
  ancestor_not_directory: 'insecure',
  ancestor_writable: 'insecure',
  ancestor_owner_not_allowed: 'insecure',
  windows_acl_unprotected: 'insecure',
  windows_acl_unverified: 'protection_unverified',
};

/** Why a failure must not become legacy mode. */
const FAILURE_NOTICE = 'a strict configuration that cannot be used must block: it is never treated as "no configuration" and must not fall back to legacy mode';

export interface StrictConfigFailure {
  readonly status: StrictConfigFailureStatus;
  readonly code: StrictConfigFailureCode;
  /** fixed text: never file content, never a configured path */
  readonly message: string;
  /** always true: the caller must block */
  readonly blocking: true;
  readonly legacyFallback: 'forbidden';
  readonly notice: string;
}

export interface StrictConfigNotConfigured {
  readonly status: 'not_configured';
  readonly message: string;
  /** false: there is nothing to enforce from this file. See `notice`. */
  readonly blocking: false;
  readonly notice: string;
}

export type ProtectionMethod = 'posix_owner_and_mode' | 'windows_acl_verifier';

export interface ProtectionReport {
  readonly method: ProtectionMethod;
  /** what this check does NOT establish, for display and logging */
  readonly limitations: readonly string[];
}

export interface StrictConfigLoaded {
  readonly status: 'strict';
  readonly config: StrictConfig;
  readonly protection: ProtectionReport;
  readonly blocking: false;
}

export type StrictConfigResult = StrictConfigLoaded | StrictConfigNotConfigured | StrictConfigFailure;

const NOT_CONFIGURED_NOTICE =
  'no strict configuration was found at the protected location. This is NOT proof that strict mode was never installed: removing the file looks identical. A protected CI runner must independently require strict mode.';

const failure = (code: StrictConfigFailureCode): StrictConfigFailure => ({
  status: STATUS_OF[code],
  code,
  message: MESSAGES[code],
  blocking: true,
  legacyFallback: 'forbidden',
  notice: FAILURE_NOTICE,
});

const notConfigured = (): StrictConfigNotConfigured => ({
  status: 'not_configured',
  message: 'no strict configuration is installed at the protected location',
  blocking: false,
  notice: NOT_CONFIGURED_NOTICE,
});

const validated = new WeakSet<object>();
/** True only for a result produced by this module's loader. A hand-built `{ status: 'strict' }` is not one. */
export const isLoadedStrictConfig = (x: unknown): x is StrictConfigLoaded => typeof x === 'object' && x !== null && validated.has(x);

// ---------------------------------------------------------------- filesystem abstraction

export interface StrictConfigFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  /** permission bits (POSIX); meaningless on Windows */
  readonly mode: number;
  /** owner (POSIX); meaningless on Windows */
  readonly uid: number;
  readonly size: number;
  /** identity of the file object, as text, so two stats can be compared for "same file" */
  readonly dev: string;
  readonly ino: string;
}

export interface StrictConfigHandle {
  fstat(): StrictConfigFileStat;
  /** reads at most `maxBytes` bytes from the open handle */
  readAll(maxBytes: number): Buffer;
  close(): void;
}

/** Filesystem access, injectable so every branch can be tested without administrator rights. */
export interface StrictConfigFs {
  /** does not follow a symbolic link at the final component */
  lstat(path: string): StrictConfigFileStat;
  realpath(path: string): string;
  /** opens WITHOUT following a symbolic link at the final component */
  openNoFollow(path: string): StrictConfigHandle;
}

function toStat(s: nodeFs.BigIntStats): StrictConfigFileStat {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    mode: Number(s.mode),
    uid: Number(s.uid),
    size: Number(s.size),
    dev: String(s.dev),
    ino: String(s.ino),
  };
}

/** The real filesystem, using only Node's built-in `fs`. */
export const realStrictConfigFs: StrictConfigFs = {
  lstat: (p) => toStat(nodeFs.lstatSync(p, { bigint: true })),
  realpath: (p) => nodeFs.realpathSync(p),
  openNoFollow(p) {
    // O_NOFOLLOW exists on POSIX only; on Windows the lstat and real-path checks are what remain
    const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0);
    const fd = nodeFs.openSync(p, flags);
    return {
      fstat: () => toStat(nodeFs.fstatSync(fd, { bigint: true })),
      readAll(maxBytes) {
        const size = Number(nodeFs.fstatSync(fd, { bigint: true }).size);
        const buffer = Buffer.alloc(Math.min(size, maxBytes));
        let offset = 0;
        while (offset < buffer.length) {
          const n = nodeFs.readSync(fd, buffer, offset, buffer.length - offset, null);
          if (n === 0) break;
          offset += n;
        }
        return buffer.subarray(0, offset);
      },
      close: () => nodeFs.closeSync(fd),
    };
  },
};

// ---------------------------------------------------------------- loading

export type AclVerdict = 'protected' | 'unprotected' | 'unknown';

export interface LoadStrictConfigRequest {
  /** the file to load. FOR TESTS AND TRUSTED INSTALLERS ONLY: never pass a developer-controlled value. */
  readonly location: string;
  readonly platform: StrictConfigPlatform;
  readonly fs?: StrictConfigFs;
  /** uids accepted as administrators on POSIX. Default: root only. */
  readonly allowedOwnerUids?: readonly number[];
  /**
   * The only way to establish protection on Windows: a trusted component's verdict about the file's
   * access list. Must return exactly 'protected'. Without it, Windows is `protection_unverified`.
   */
  readonly aclVerifier?: (location: string) => AclVerdict;
}

const ROOT_UID = 0;
const GROUP_OR_OTHER_WRITE = 0o022;
// control characters (including NUL and DEL) are never valid in a configured path
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;
const WINDOWS_BAD_SEGMENT = /[<>:"|?*]|[. ]$/;

const errorCode = (err: unknown): string => (typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '');

const isPlatform = (x: unknown): x is StrictConfigPlatform => (STRICT_CONFIG_PLATFORMS as readonly unknown[]).includes(x);

/**
 * True for a plain absolute path in the convention of `platform`: no control characters, no `.` or
 * `..` segments, no empty segments (doubled separators), no trailing separator, bounded length. On
 * Windows only local drive paths (`C:\...`) are accepted: UNC and device paths cannot be protected here.
 */
export function isAbsoluteConfiguredPath(value: unknown, platform: StrictConfigPlatform): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONFIGURED_PATH_CHARS || hasControlChar(value)) return false;
  if (platform === 'win32') {
    if (!WINDOWS_DRIVE_PATH.test(value) || !nodePath.win32.isAbsolute(value)) return false;
    const segments = value.slice(3).split('\\');
    return segments.every((s) => s !== '' && s !== '.' && s !== '..' && !WINDOWS_BAD_SEGMENT.test(s));
  }
  if (!value.startsWith('/') || !nodePath.posix.isAbsolute(value)) return false;
  const segments = value.slice(1).split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Loads and validates the strict configuration at an explicit location. Never throws. See the file
 * header for the states, the protection checks and their limits.
 */
export function loadStrictConfigAt(request: LoadStrictConfigRequest): StrictConfigResult {
  try {
    return loadUnchecked(request);
  } catch {
    // fail closed: an unexpected error is an unusable configuration, never "not configured"
    return failure('read_failed');
  }
}

/**
 * The production entry point. It takes NO arguments: the location is the fixed constant for the
 * current platform, so no developer-controlled value (environment, working directory, flag, input
 * file, setting) can change where the configuration is read from. On a Windows installation the
 * result is `protection_unverified` until a trusted runtime supplies an ACL verifier.
 */
export function loadProtectedStrictConfig(): StrictConfigResult {
  const platform = process.platform;
  if (!isPlatform(platform)) return failure('unsupported_platform');
  return loadStrictConfigAt({ location: PROTECTED_CONFIG_LOCATIONS[platform], platform });
}

function loadUnchecked(request: LoadStrictConfigRequest): StrictConfigResult {
  const { platform, location } = request;
  const fs = request.fs ?? realStrictConfigFs;
  const owners = request.allowedOwnerUids ?? [ROOT_UID];
  if (!isPlatform(platform)) return failure('unsupported_platform');
  if (!isAbsoluteConfiguredPath(location, platform)) return failure('invalid_location_path');
  const posix = platform !== 'win32';

  // 1. what is at the location, without following a link
  let leaf: StrictConfigFileStat;
  try {
    leaf = fs.lstat(location);
  } catch (err) {
    // a missing file or parent directory is "not configured"; any other problem is "unreadable", never "absent"
    return ['ENOENT', 'ENOTDIR'].includes(errorCode(err)) ? notConfigured() : failure('stat_failed');
  }
  if (leaf.isSymbolicLink) return failure('symlink');
  if (!leaf.isFile) return failure('not_regular_file');

  // 2. no link anywhere in the path: the real path must be the path itself
  let real: string;
  try {
    real = fs.realpath(location);
  } catch (err) {
    return ['ENOENT', 'ENOTDIR'].includes(errorCode(err)) ? failure('path_substitution') : failure('realpath_failed');
  }
  if (platform === 'win32' ? real.toLowerCase() !== location.toLowerCase() : real !== location) return failure('path_substitution');

  // 3. POSIX: every ancestor directory must be administrator-owned and not writable by group or others
  if (posix) {
    let dir = nodePath.posix.dirname(location);
    for (;;) {
      let st: StrictConfigFileStat;
      try {
        st = fs.lstat(dir);
      } catch {
        return failure('stat_failed');
      }
      if (st.isSymbolicLink || !st.isDirectory) return failure('ancestor_not_directory');
      if (!owners.includes(st.uid)) return failure('ancestor_owner_not_allowed');
      if ((st.mode & GROUP_OR_OTHER_WRITE) !== 0) return failure('ancestor_writable');
      const parent = nodePath.posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 4. Windows: protection can only be established by a trusted verifier
  let aclVerdict: AclVerdict | undefined;
  if (!posix) {
    if (request.aclVerifier) {
      try {
        aclVerdict = request.aclVerifier(location);
      } catch {
        aclVerdict = 'unknown';
      }
    }
    if (aclVerdict === 'unprotected') return failure('windows_acl_unprotected');
  }

  // 5. open WITHOUT following a link, then check and read the SAME handle
  let handle: StrictConfigHandle;
  try {
    handle = fs.openNoFollow(location);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ELOOP' || code === 'EMLINK') return failure('symlink');
    return ['ENOENT', 'ENOTDIR'].includes(code) ? failure('changed_during_load') : failure('read_failed');
  }
  try {
    const open = handle.fstat();
    // Same file object? The inode is compared everywhere. The device is compared on POSIX only: on
    // Windows, Node reports a device of 0 from lstat but the volume serial from fstat for the very
    // same file, so comparing it there would reject every legitimate load.
    if (open.ino !== leaf.ino || (posix && open.dev !== leaf.dev)) return failure('changed_during_load');
    if (!open.isFile) return failure('not_regular_file');
    if (posix) {
      if (!owners.includes(open.uid)) return failure('owner_not_allowed');
      if ((open.mode & GROUP_OR_OTHER_WRITE) !== 0) return failure('writable_by_others');
    }
    if (open.size > MAX_STRICT_CONFIG_BYTES) return failure('too_large');

    let bytes: Buffer;
    try {
      bytes = handle.readAll(MAX_STRICT_CONFIG_BYTES + 1);
    } catch {
      return failure('read_failed');
    }

    const parsed = parseStrictConfigBytes(bytes, platform);
    if ('code' in parsed) return parsed;

    if (!posix) {
      // valid content, but without a trusted verifier nothing establishes who can modify the file
      if (aclVerdict !== 'protected') return failure('windows_acl_unverified');
    }
    const protection: ProtectionReport = posix
      ? {
          method: 'posix_owner_and_mode',
          limitations: [
            'owner and mode bits only: ACLs, extended attributes, mounts and immutable flags are not examined',
            'a privileged attacker (root) can change the file and its parents regardless',
            'a parent directory replaced after the check is not re-checked',
          ],
        }
      : {
          method: 'windows_acl_verifier',
          limitations: ['protection rests entirely on the verdict of the supplied verifier, which this module cannot check', 'a privileged attacker can change the file regardless'],
        };
    const result: StrictConfigLoaded = Object.freeze({ status: 'strict' as const, config: parsed.config, protection: Object.freeze(protection), blocking: false as const });
    validated.add(result);
    return result;
  } finally {
    try {
      handle.close();
    } catch {
      // nothing useful to do: the result has already been decided
    }
  }
}

// ---------------------------------------------------------------- parsing and validation

const REQUIRED_FIELDS = ['version', 'organization', 'mode', 'trustRootPath', 'policyPath', 'revocationListPath', 'minPolicyRevision', 'minRevocationListVersion', 'challengeStore'] as const;
const STORE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Strict UTF-8 text (no BOM tolerated as content), then JSON, then the schema. Never throws. */
export function parseStrictConfigBytes(bytes: Uint8Array, platform: StrictConfigPlatform): { readonly config: StrictConfig } | StrictConfigFailure {
  try {
    if (bytes.length === 0) return failure('empty');
    if (bytes.length > MAX_STRICT_CONFIG_BYTES) return failure('too_large');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return failure('invalid_encoding');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return failure('invalid_json');
    }
    return parseStrictConfig(json, platform);
  } catch {
    return failure('invalid_structure');
  }
}

/** Validates an already-parsed document. Never throws. */
export function parseStrictConfig(input: unknown, platform: StrictConfigPlatform): { readonly config: StrictConfig } | StrictConfigFailure {
  try {
    return parseUnchecked(input, platform);
  } catch {
    return failure('invalid_structure');
  }
}

const isFloor = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 1;

function parseUnchecked(input: unknown, platform: StrictConfigPlatform): { readonly config: StrictConfig } | StrictConfigFailure {
  if (!isPlainObject(input)) return failure('invalid_structure');
  // the version is judged first, so a future format is reported as such rather than as "malformed"
  if (typeof input.version === 'number' && input.version !== STRICT_CONFIG_VERSION) return failure('unsupported_version');

  // required fields exactly, plus optionally clockSkew; anything else (including any credential-like field) is rejected
  const hasSkew = Object.prototype.hasOwnProperty.call(input, 'clockSkew');
  if (!hasExactFields(input, hasSkew ? [...REQUIRED_FIELDS, 'clockSkew'] : REQUIRED_FIELDS)) return failure('invalid_structure');
  if (input.version !== STRICT_CONFIG_VERSION) return failure('invalid_structure');

  const { organization, mode, trustRootPath, policyPath, revocationListPath, minPolicyRevision, minRevocationListVersion, challengeStore } = input;
  if (typeof organization !== 'string' || !ORGANIZATION_ID.test(organization)) return failure('invalid_organization');
  if (mode !== 'strict') return failure('invalid_mode');

  if (!isAbsoluteConfiguredPath(trustRootPath, platform) || !isAbsoluteConfiguredPath(policyPath, platform) || !isAbsoluteConfiguredPath(revocationListPath, platform)) {
    return failure('invalid_path');
  }
  const same = (a: string, b: string): boolean => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(trustRootPath, policyPath) || same(trustRootPath, revocationListPath) || same(policyPath, revocationListPath)) return failure('duplicate_paths');

  if (!isFloor(minPolicyRevision) || !isFloor(minRevocationListVersion)) return failure('invalid_revision_floor');

  let store: ChallengeStoreSetting;
  if (!isPlainObject(challengeStore)) return failure('invalid_challenge_store');
  if (challengeStore.kind === 'none' && hasExactFields(challengeStore, ['kind'])) store = Object.freeze({ kind: 'none' as const });
  else if (challengeStore.kind === 'external' && hasExactFields(challengeStore, ['kind', 'storeId']) && typeof challengeStore.storeId === 'string' && STORE_ID.test(challengeStore.storeId)) {
    store = Object.freeze({ kind: 'external' as const, storeId: challengeStore.storeId });
  } else return failure('invalid_challenge_store');

  let clockSkew: StrictConfig['clockSkew'];
  if (hasSkew) {
    const skew = input.clockSkew;
    const seconds = isPlainObject(skew) ? skew.maxSkewSeconds : undefined;
    if (!isPlainObject(skew) || !hasExactFields(skew, ['maxSkewSeconds']) || typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 0 || seconds > MAX_CLOCK_SKEW_SECONDS) {
      return failure('invalid_clock_skew');
    }
    clockSkew = Object.freeze({ maxSkewSeconds: seconds });
  }

  return {
    config: Object.freeze({
      version: STRICT_CONFIG_VERSION,
      organization,
      mode: 'strict' as const,
      trustRootPath,
      policyPath,
      revocationListPath,
      minPolicyRevision,
      minRevocationListVersion,
      challengeStore: store,
      ...(clockSkew ? { clockSkew } : {}),
    }),
  };
}
