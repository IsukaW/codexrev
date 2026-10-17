/**
 * Signing-key profiles for the three roles (administrator, developer, team lead).
 *
 * A profile is two files in a keys directory, by default `<CodeXRev home>/keys` (`~/.codexrev/keys`):
 *   <name>.key        the PRIVATE key (PKCS#8 PEM), created exclusively with mode 0600
 *   <name>.pub.json   the shareable PUBLIC key: { version, name, keyId, publicKey, createdAt }
 * The key id is the existing one (hex SHA-256 of the raw public key, `deriveKeyId`).
 *
 * Safeguards: a profile name is a short lowercase word (no path separators or dots, so it cannot
 * reach another directory); an existing key is never overwritten; a keys directory inside a Git
 * working tree, or a symbolic link, is refused; the private key is never printed or logged, and
 * error messages never contain it.
 *
 * PLATFORM NOTE, stated plainly: on POSIX the key file is mode 0600 and a more permissive file is
 * refused when loaded. On Windows file modes carry no meaning, so nothing here proves that other
 * accounts cannot read the file; it must be protected with the operating system's access controls
 * (keep the directory in your own user profile). This code does not inspect Windows ACLs.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getCodexrevPaths } from '../../../utils/paths.js';
import { deriveKeyId, exportRawPublicKey, importRawPublicKey } from '../authorization/envelope.js';
import { isPlainObject, hasExactFields } from '../authorization/trustRoot.js';
import { StrictCliError, isInsideGitWorktree, pathExists, readJsonFile, writeNewFile } from './files.js';

export const KEY_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const PUBLIC_KEY_FILE_VERSION = 1 as const;

export interface PublicKeyFile {
  readonly version: typeof PUBLIC_KEY_FILE_VERSION;
  readonly name: string;
  readonly keyId: string;
  /** the raw 32-byte Ed25519 public key, Base64url */
  readonly publicKey: string;
  readonly createdAt: string;
}

export const WINDOWS_KEY_WARNING =
  'Windows file permissions are not checked or enforced by CodeXRev: protect this directory with your account\'s access controls (keep it in your own user profile). Mode 0600 does not prove that other accounts cannot read it.';

export function defaultKeysDir(): string {
  return path.join(getCodexrevPaths().root, 'keys');
}

export function validateKeyName(name: unknown, label = 'key name'): string {
  if (typeof name !== 'string' || !KEY_NAME.test(name)) throw new StrictCliError(`${label} must be 1-32 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit`);
  return name;
}

async function checkedKeysDir(dir: string, create: boolean): Promise<string> {
  const resolved = path.resolve(dir);
  if (await isInsideGitWorktree(resolved)) throw new StrictCliError('refusing a keys directory inside a Git working tree: a private key must never be placed where it could be committed');
  let st;
  try {
    st = await fs.lstat(resolved);
  } catch {
    if (!create) throw new StrictCliError('the keys directory does not exist');
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    return resolved;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new StrictCliError('the keys directory must be a real directory, not a link or a file');
  return resolved;
}

export interface GeneratedKey {
  readonly name: string;
  readonly keyId: string;
  readonly privatePath: string;
  readonly publicPath: string;
  readonly warnings: readonly string[];
}

/** Generates a key pair and saves it. Never overwrites: an existing profile is an error. */
export async function generateKeyProfile(options: { readonly name: string; readonly keysDir: string; readonly now: Date; readonly platform?: NodeJS.Platform; }): Promise<GeneratedKey> {
  const name = validateKeyName(options.name);
  const dir = await checkedKeysDir(options.keysDir, true);
  const privatePath = path.join(dir, `${name}.key`);
  const publicPath = path.join(dir, `${name}.pub.json`);
  if ((await pathExists(privatePath)) || (await pathExists(publicPath))) throw new StrictCliError(`a key named "${name}" already exists: choose another name (existing keys are never overwritten)`);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  if (!(await writeNewFile(privatePath, pem, 0o600))) throw new StrictCliError(`a key named "${name}" already exists: choose another name (existing keys are never overwritten)`);
  const file: PublicKeyFile = { version: PUBLIC_KEY_FILE_VERSION, name, keyId: deriveKeyId(publicKey), publicKey: exportRawPublicKey(publicKey).toString('base64url'), createdAt: options.now.toISOString() };
  if (!(await writeNewFile(publicPath, `${JSON.stringify(file, null, 2)}\n`))) {
    await fs.unlink(privatePath).catch(() => undefined);
    throw new StrictCliError(`a key named "${name}" already exists: choose another name (existing keys are never overwritten)`);
  }
  const platform = options.platform ?? process.platform;
  return { name, keyId: file.keyId, privatePath, publicPath, warnings: platform === 'win32' ? [WINDOWS_KEY_WARNING] : [] };
}

export interface LoadedKey {
  readonly name: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyId: string;
  /** raw public key, Base64url, as written into grants and the trust root */
  readonly publicKeyRaw: string;
}

/** Loads a private key by profile name. The key must be Ed25519, and on POSIX not readable by others. */
export async function loadPrivateKey(options: { readonly name: string; readonly keysDir: string; readonly platform?: NodeJS.Platform }): Promise<LoadedKey> {
  const name = validateKeyName(options.name);
  const dir = await checkedKeysDir(options.keysDir, false);
  const file = path.join(dir, `${name}.key`);
  let st;
  try {
    st = await fs.lstat(file);
  } catch {
    throw new StrictCliError(`no key named "${name}" in the keys directory (create one with: keygen --name ${name})`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new StrictCliError(`the key file for "${name}" is not a regular file`);
  if ((options.platform ?? process.platform) !== 'win32' && (st.mode & 0o077) !== 0) throw new StrictCliError(`the key file for "${name}" is readable by other accounts: run chmod 600 on it, or create a new key`);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(await fs.readFile(file, 'utf-8'));
  } catch {
    throw new StrictCliError(`the key file for "${name}" could not be read as a private key`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new StrictCliError(`the key "${name}" is not an Ed25519 key`);
  const publicKey = createPublicKey(privateKey);
  return { name, privateKey, publicKey, keyId: deriveKeyId(publicKey), publicKeyRaw: exportRawPublicKey(publicKey).toString('base64url') };
}

export interface ReadPublicKey {
  readonly keyId: string;
  readonly publicKeyRaw: string;
  readonly publicKey: KeyObject;
}

/** Reads and validates a shareable public-key file: the id must be the id of the key in the file. */
export async function readPublicKeyFile(filePath: string): Promise<ReadPublicKey> {
  const doc = await readJsonFile(path.resolve(filePath), 'the public key file');
  if (!isPlainObject(doc) || !hasExactFields(doc, ['version', 'name', 'keyId', 'publicKey', 'createdAt']) || doc.version !== PUBLIC_KEY_FILE_VERSION) throw new StrictCliError('the public key file has an unexpected format');
  if (typeof doc.publicKey !== 'string' || typeof doc.keyId !== 'string') throw new StrictCliError('the public key file has an unexpected format');
  let key: KeyObject;
  try {
    key = importRawPublicKey(doc.publicKey);
  } catch {
    throw new StrictCliError('the public key file does not contain a valid Ed25519 public key');
  }
  if (deriveKeyId(key) !== doc.keyId) throw new StrictCliError('the public key file is inconsistent: its key id is not the id of its key');
  return { keyId: doc.keyId, publicKeyRaw: doc.publicKey, publicKey: key };
}

/**
 * Copies one key profile from `fromDir` into `toDir` (same name), for provisioning a machine with a key it must hold,
 * such as the local challenge-store key. Never overwrites: if the destination already has that profile it must be
 * the SAME key (same key id), otherwise this is an error. Both keys directories must be outside Git working trees.
 * Returns whether anything was copied.
 */
export async function importKeyProfile(options: { readonly name: string; readonly fromDir: string; readonly toDir: string }): Promise<{ readonly keyId: string; readonly imported: boolean }> {
  const name = validateKeyName(options.name);
  const source = await loadPrivateKey({ name, keysDir: options.fromDir }); // validates location, type and permissions
  const toDir = await checkedKeysDir(options.toDir, true);
  const target = path.join(toDir, `${name}.key`);
  if (await pathExists(target)) {
    const existing = await loadPrivateKey({ name, keysDir: toDir });
    if (existing.keyId !== source.keyId) throw new StrictCliError(`the keys directory already has a different key named "${name}": it is never overwritten`);
    return { keyId: source.keyId, imported: false };
  }
  const pem = source.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicFile: PublicKeyFile = { version: PUBLIC_KEY_FILE_VERSION, name, keyId: source.keyId, publicKey: source.publicKeyRaw, createdAt: new Date().toISOString() };
  const publicPath = path.join(toDir, `${name}.pub.json`);
  if (!(await writeNewFile(target, pem, 0o600))) throw new StrictCliError(`a key named "${name}" already exists: it is never overwritten`);
  if (!(await writeNewFile(publicPath, `${JSON.stringify(publicFile, null, 2)}\n`))) {
    await fs.unlink(target).catch(() => undefined);
    throw new StrictCliError(`a key named "${name}" already exists: it is never overwritten`);
  }
  return { keyId: source.keyId, imported: true };
}
