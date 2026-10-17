// Unit tests for key identifiers and Ed25519 key handling. In-memory only: keys are generated per run.

import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveKeyId,
  exportRawPublicKey,
  importRawPublicKey,
  signEnvelope,
  verifyEnvelope,
} from '../../../../src/features/action-safety/authorization/envelope.js';
import {
  AuthorizationCryptoError,
  DOMAIN_NAMESPACES,
  ED25519_PUBLIC_KEY_BYTES,
  MAX_ENCODED_PAYLOAD_CHARS,
  MAX_ENVELOPE_TEXT_BYTES,
  MAX_PAYLOAD_BYTES,
  SIGNING_DOMAINS,
  isSigningDomain,
} from '../../../../src/features/action-safety/authorization/types.js';
import { CodexrevError } from '../../../../src/utils/errors.js';

const ed = (): { publicKey: KeyObject; privateKey: KeyObject } => generateKeyPairSync('ed25519');
const payload = Buffer.from('payload');

let wrong: Record<string, { publicKey: KeyObject; privateKey: KeyObject }>;

beforeAll(() => {
  wrong = {
    rsa: generateKeyPairSync('rsa', { modulusLength: 2048 }),
    x25519: generateKeyPairSync('x25519'),
    ed448: generateKeyPairSync('ed448'),
    ec: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  };
});

const rawOf = (key: KeyObject): Buffer => Buffer.from(String(key.export({ format: 'jwk' }).x), 'base64url');

describe('stable key identifiers', () => {
  it('is 64 lowercase hex characters', () => {
    expect(deriveKeyId(ed().publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the SHA-256 of the raw 32-byte public key, computed independently', () => {
    const { publicKey } = ed();
    expect(deriveKeyId(publicKey)).toBe(createHash('sha256').update(rawOf(publicKey)).digest('hex'));
  });

  it('is stable: the same key always gives the same id', () => {
    const { publicKey } = ed();
    expect(deriveKeyId(publicKey)).toBe(deriveKeyId(publicKey));
    expect(deriveKeyId(publicKey)).toBe(deriveKeyId(publicKey));
  });

  it('is the same for the same key however it was loaded: derived, re-imported from raw bytes, or round-tripped through PEM', () => {
    const { publicKey, privateKey } = ed();
    const id = deriveKeyId(publicKey);
    expect(deriveKeyId(createPublicKey(privateKey))).toBe(id);
    expect(deriveKeyId(importRawPublicKey(rawOf(publicKey)))).toBe(id);
    expect(deriveKeyId(importRawPublicKey(rawOf(publicKey).toString('base64url')))).toBe(id);
    expect(deriveKeyId(createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })))).toBe(id);
  });

  it('is different for different keys', () => {
    const ids = new Set(Array.from({ length: 25 }, () => deriveKeyId(ed().publicKey)));
    expect(ids.size).toBe(25);
  });

  it('matches the key id inside an envelope signed with that key', () => {
    const { publicKey, privateKey } = ed();
    expect(signEnvelope({ domain: 'grant', payload, privateKey }).keyId).toBe(deriveKeyId(publicKey));
  });
});

describe('raw public key export and import', () => {
  it('exports exactly 32 bytes', () => {
    expect(exportRawPublicKey(ed().publicKey)).toHaveLength(ED25519_PUBLIC_KEY_BYTES);
  });

  it('round-trips, and the imported key verifies signatures', () => {
    const { publicKey, privateKey } = ed();
    const imported = importRawPublicKey(exportRawPublicKey(publicKey));
    expect(imported.type).toBe('public');
    expect(imported.asymmetricKeyType).toBe('ed25519');
    const env = signEnvelope({ domain: 'policy', payload, privateKey });
    expect(verifyEnvelope(env, { expectedDomain: 'policy', trustedPublicKey: imported }).ok).toBe(true);
  });

  it('accepts strict Base64url text and Uint8Array input', () => {
    const { publicKey } = ed();
    const raw = exportRawPublicKey(publicKey);
    expect(deriveKeyId(importRawPublicKey(raw.toString('base64url')))).toBe(deriveKeyId(publicKey));
    expect(deriveKeyId(importRawPublicKey(new Uint8Array(raw)))).toBe(deriveKeyId(publicKey));
  });

  it('rejects keys of the wrong length', () => {
    for (const length of [0, 1, 31, 33, 64]) {
      expect(() => importRawPublicKey(Buffer.alloc(length, 1)), String(length)).toThrow(AuthorizationCryptoError);
    }
  });

  it('rejects text that is not strictly encoded', () => {
    const text = exportRawPublicKey(ed().publicKey).toString('base64url');
    for (const bad of ['', '!!!', `${text}=`, `${text.slice(0, -1)}+`,` ${text}`, `${text}\n`, text.slice(1), 'A'.repeat(44)]) {
      expect(() => importRawPublicKey(bad), JSON.stringify(bad)).toThrow(AuthorizationCryptoError);
    }
  });

  it('rejects input that is neither bytes nor text', () => {
    for (const bad of [null, undefined, 5, {}, [], Array.from({ length: 32 }, () => 1), true] as unknown[]) {
      expect(() => importRawPublicKey(bad as string), String(bad)).toThrow(AuthorizationCryptoError);
    }
  });
});

describe('invalid key types and key material', () => {
  const notEd25519PublicKeys = (): Array<[string, unknown]> => [
    ['a private Ed25519 key', ed().privateKey],
    ['an RSA public key', wrong.rsa.publicKey],
    ['an X25519 public key', wrong.x25519.publicKey],
    ['an Ed448 public key', wrong.ed448.publicKey],
    ['an EC public key', wrong.ec.publicKey],
    ['a PEM string', ed().publicKey.export({ type: 'spki', format: 'pem' })],
    ['a Buffer of raw bytes', rawOf(ed().publicKey)],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a look-alike object', { type: 'public', asymmetricKeyType: 'ed25519', export: () => ({ x: 'AAAA' }) }],
  ];

  it('refuses to derive a key id from anything but an Ed25519 public key', () => {
    for (const [name, key] of notEd25519PublicKeys()) {
      expect(() => deriveKeyId(key as KeyObject), name).toThrow(AuthorizationCryptoError);
      try {
        deriveKeyId(key as KeyObject);
      } catch (err) {
        expect((err as AuthorizationCryptoError).reason, name).toBe('invalid_public_key');
      }
    }
  });

  it('refuses to export raw bytes from anything but an Ed25519 public key', () => {
    for (const [name, key] of notEd25519PublicKeys()) expect(() => exportRawPublicKey(key as KeyObject), name).toThrow(AuthorizationCryptoError);
  });

  it('refuses to sign with anything but an Ed25519 private key', () => {
    const { publicKey } = ed();
    const bad: Array<[string, unknown]> = [
      ['an Ed25519 PUBLIC key', publicKey],
      ['an RSA private key', wrong.rsa.privateKey],
      ['an X25519 private key', wrong.x25519.privateKey],
      ['an Ed448 private key', wrong.ed448.privateKey],
      ['an EC private key', wrong.ec.privateKey],
      ['a string', 'not a key'],
      ['null', null],
      ['undefined', undefined],
      ['an object', { type: 'private' }],
    ];
    for (const [name, key] of bad) {
      expect(() => signEnvelope({ domain: 'grant', payload, privateKey: key as KeyObject }), name).toThrow(AuthorizationCryptoError);
      try {
        signEnvelope({ domain: 'grant', payload, privateKey: key as KeyObject });
      } catch (err) {
        expect((err as AuthorizationCryptoError).reason, name).toBe('invalid_private_key');
      }
    }
  });

  it('refuses to verify with anything but an Ed25519 public key as the trusted key', () => {
    const signer = ed();
    const env = signEnvelope({ domain: 'grant', payload, privateKey: signer.privateKey });
    for (const [name, key] of notEd25519PublicKeys()) {
      const r = verifyEnvelope(env, { expectedDomain: 'grant', trustedPublicKey: key as KeyObject });
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.code, name).toBe('invalid_public_key');
    }
  });

  it('a private key used as the "trusted" key is rejected, never silently converted', () => {
    const signer = ed();
    const env = signEnvelope({ domain: 'grant', payload, privateKey: signer.privateKey });
    const r = verifyEnvelope(env, { expectedDomain: 'grant', trustedPublicKey: signer.privateKey });
    expect(r.ok).toBe(false);
  });

  it('key errors are structured CodexrevErrors with a stable code and a secret-free message', () => {
    const { privateKey } = ed();
    const jwk = privateKey.export({ format: 'jwk' });
    try {
      deriveKeyId(privateKey);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationCryptoError);
      expect(err).toBeInstanceOf(CodexrevError);
      expect((err as CodexrevError).code).toBe('CODEXREV_AUTHZ_CRYPTO_ERROR');
      expect((err as Error).message).not.toContain(String(jwk.d));
      expect((err as Error).message).not.toContain(String(jwk.x));
    }
  });
});

describe('constants', () => {
  it('defines the eight signing domains, including the separate Evidence Pack domain', () => {
    expect([...SIGNING_DOMAINS]).toEqual(['policy', 'grant', 'proof', 'revocation', 'challenge', 'receipt', 'journal', 'evidence_pack']);
    for (const d of SIGNING_DOMAINS) expect(isSigningDomain(d)).toBe(true);
    for (const bad of ['', 'Policy', 'admin', null, undefined, 1, {}]) expect(isSigningDomain(bad)).toBe(false);
  });

  it('keeps the Evidence Pack in its own namespace, apart from all authorization domains', () => {
    const authz = new Set(SIGNING_DOMAINS.filter((d) => d !== 'evidence_pack').map((d) => DOMAIN_NAMESPACES[d]));
    expect(authz.size).toBe(1);
    expect(authz.has(DOMAIN_NAMESPACES.evidence_pack)).toBe(false);
  });

  it('has consistent size limits', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(1_048_576);
    expect(MAX_ENCODED_PAYLOAD_CHARS).toBe(Buffer.alloc(MAX_PAYLOAD_BYTES).toString('base64url').length);
    expect(MAX_ENVELOPE_TEXT_BYTES).toBeGreaterThan(MAX_ENCODED_PAYLOAD_CHARS);
  });
});
