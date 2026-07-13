import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, generateDek, SecretsError } from '../../src/security/secrets.js';

describe('secrets (AES-256-GCM)', () => {
  it('round-trips a plaintext', () => {
    const dek = generateDek();
    const pt = 'sk-test-abcdef-1234567890';
    const payload = encrypt(pt, dek);
    expect(payload.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(payload.tag).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(payload.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decrypt(payload, dek)).toBe(pt);
  });

  it('produces a different IV each call', () => {
    const dek = generateDek();
    const a = encrypt('same plaintext', dek);
    const b = encrypt('same plaintext', dek);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects decryption with the wrong key', () => {
    const dek = generateDek();
    const payload = encrypt('sk-secret', dek);
    const wrongDek = generateDek();
    expect(() => decrypt(payload, wrongDek)).toThrow(SecretsError);
  });

  it('rejects tampered ciphertext', () => {
    const dek = generateDek();
    const payload = encrypt('sk-secret', dek);
    // flip one bit in the ciphertext
    const tampered = {
      ...payload,
      ciphertext: (() => {
        const buf = Buffer.from(payload.ciphertext, 'base64');
        buf[0] = buf[0] ^ 0xff;
        return buf.toString('base64');
      })(),
    };
    expect(() => decrypt(tampered, dek)).toThrow(SecretsError);
  });

  it('rejects wrong-size DEK', () => {
    expect(() => encrypt('x', Buffer.alloc(16))).toThrow(SecretsError);
    expect(() => decrypt({ iv: '', tag: '', ciphertext: '' }, Buffer.alloc(8))).toThrow(SecretsError);
  });
});