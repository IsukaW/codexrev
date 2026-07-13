/**
 * Codexrev — symmetric encryption primitives for at-rest secrets.
 *
 * AES-256-GCM with a random 96-bit IV per encryption. The 32-byte data
 * encryption key (DEK) is supplied by the caller and is expected to be
 * persisted in the OS keychain — see ./keychain.ts. We never log keys
 * or plaintext and never accept a hard-coded key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CodexrevError } from '../utils/errors.js';

export class SecretsError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_SECRETS_ERROR', false);
    this.name = 'SecretsError';
  }
}

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedPayload {
  /** Base64-encoded random IV (12 bytes). */
  iv: string;
  /** Base64-encoded GCM auth tag (16 bytes). */
  tag: string;
  /** Base64-encoded ciphertext (same length as plaintext). */
  ciphertext: string;
}

export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encrypt(plaintext: string, dek: Buffer): EncryptedPayload {
  if (!dek || dek.length !== KEY_BYTES) {
    throw new SecretsError(`DEK must be ${KEY_BYTES} bytes (got ${dek?.length ?? 0})`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, dek, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ct.toString('base64'),
  };
}

export function decrypt(payload: EncryptedPayload, dek: Buffer): string {
  if (!dek || dek.length !== KEY_BYTES) {
    throw new SecretsError(`DEK must be ${KEY_BYTES} bytes (got ${dek?.length ?? 0})`);
  }
  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    iv = Buffer.from(payload.iv, 'base64');
    tag = Buffer.from(payload.tag, 'base64');
    ct = Buffer.from(payload.ciphertext, 'base64');
  } catch (err) {
    throw new SecretsError(`malformed ciphertext envelope: ${(err as Error).message}`);
  }
  if (iv.length !== IV_BYTES) {
    throw new SecretsError(`invalid IV length: ${iv.length} (expected ${IV_BYTES})`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new SecretsError(`invalid auth tag length: ${tag.length} (expected ${TAG_BYTES})`);
  }
  try {
    const decipher = createDecipheriv(ALGO, dek, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf-8');
  } catch (err) {
    throw new SecretsError(`decryption failed (tampered ciphertext or wrong key): ${(err as Error).message}`);
  }
}