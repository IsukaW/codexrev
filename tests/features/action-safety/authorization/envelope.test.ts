// Unit tests for the Ed25519 signed-envelope foundation. Pure and in-memory: keys are generated per run,
// nothing is read from or written to disk, and nothing depends on the machine, the network or git.

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSigningInput,
  deriveKeyId,
  parseVerifiedJsonPayload,
  signEnvelope,
  verifyEnvelope,
  verifyEnvelopeText,
} from '../../../../src/features/action-safety/authorization/envelope.js';
import {
  AUTHORIZATION_NAMESPACE,
  AuthorizationCryptoError,
  ED25519_SIGNATURE_BYTES,
  MAX_ENCODED_PAYLOAD_CHARS,
  MAX_ENVELOPE_TEXT_BYTES,
  MAX_PAYLOAD_BYTES,
  PROVENANCE_NAMESPACE,
  SIGNING_DOMAINS,
  type SignedEnvelope,
  type SigningDomain,
  type VerifyFailureCode,
  type VerifyResult,
} from '../../../../src/features/action-safety/authorization/types.js';

const newKeys = (): { publicKey: KeyObject; privateKey: KeyObject } => generateKeyPairSync('ed25519');
const bytes = (s: string): Buffer => Buffer.from(s, 'utf-8');
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const A = newKeys();
const B = newKeys();

const sign = (payload: Uint8Array = bytes('{"hello":"world"}'), domain: SigningDomain = 'grant', keys = A): SignedEnvelope =>
  signEnvelope({ domain, payload, privateKey: keys.privateKey });
const verify = (env: unknown, domain: SigningDomain = 'grant', keys = A): VerifyResult =>
  verifyEnvelope(env, { expectedDomain: domain, trustedPublicKey: keys.publicKey });

function failed(r: VerifyResult, code: VerifyFailureCode): void {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.code).toBe(code);
    expect(r.message.length).toBeGreaterThan(0);
  }
}

// a valid envelope with one field replaced
const withField = (env: SignedEnvelope, field: string, value: unknown): Record<string, unknown> => ({ ...env, [field]: value });

describe('signing and verification', () => {
  it('produces an envelope with exactly the five documented fields', () => {
    const env = sign();
    expect(Object.keys(env).sort()).toEqual(['domain', 'keyId', 'payload', 'signature', 'version']);
    expect(env.version).toBe(1);
    expect(env.domain).toBe('grant');
    expect(env.keyId).toBe(deriveKeyId(A.publicKey));
    expect(env.payload).toBe(Buffer.from('{"hello":"world"}').toString('base64url'));
    expect(env.signature).toHaveLength(86); // 64 bytes, Base64url, no padding
    expect(env.signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('verifies a valid envelope and returns the exact signed bytes', () => {
    const r = verify(sign());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.equals(bytes('{"hello":"world"}'))).toBe(true);
      expect(r.domain).toBe('grant');
      expect(r.keyId).toBe(deriveKeyId(A.publicKey));
    }
  });

  it('works for every signing domain', () => {
    for (const domain of SIGNING_DOMAINS) {
      const r = verify(sign(bytes(`payload for ${domain}`), domain), domain);
      expect(r.ok, domain).toBe(true);
    }
  });

  it('verifies the same envelope after a JSON text round trip', () => {
    const env = sign();
    const r = verifyEnvelopeText(JSON.stringify(env), { expectedDomain: 'grant', trustedPublicKey: A.publicKey });
    expect(r.ok).toBe(true);
  });

  it('does not modify the envelope it verifies', () => {
    const env = Object.freeze(sign());
    expect(verify(env).ok).toBe(true);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('is deterministic: same key, domain and payload give an identical envelope, and verification repeats', () => {
    const first = sign();
    const second = sign();
    expect(second).toEqual(first);
    expect(verify(first)).toEqual(verify(first));
    expect(verify(first)).toEqual(verify(second));
  });

  it('does not depend on the machine or time: the signing input is a pure function of domain and bytes', () => {
    expect(buildSigningInput('grant', bytes('x')).equals(buildSigningInput('grant', bytes('x')))).toBe(true);
  });
});

describe('payload content', () => {
  it('preserves non-ASCII UTF-8 exactly', () => {
    const text = 'café — 日本語 — 🔐 — Ünïcödé';
    const r = verify(sign(bytes(text)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.toString('utf-8')).toBe(text);
      expect(r.payload.equals(bytes(text))).toBe(true);
    }
  });

  it('preserves arbitrary binary bytes, including 0x00 and 0xff', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const r = verify(sign(all));
    expect(r.ok && r.payload.equals(all)).toBe(true);
    const edge = Buffer.from([0x00, 0xff, 0x00, 0x80, 0x7f]);
    const e = verify(sign(edge));
    expect(e.ok && e.payload.equals(edge)).toBe(true);
  });

  it('signs only the visible window of a Uint8Array view', () => {
    const backing = Buffer.from('xxxxSECRETxxxx');
    const view = backing.subarray(4, 10);
    const r = verify(sign(view));
    expect(r.ok && r.payload.toString()).toBe('SECRET');
  });

  it('the signed bytes are what is verified, whatever their JSON key order', () => {
    const one = bytes('{"a":1,"b":2}');
    const two = bytes('{"b":2,"a":1}');
    const envOne = sign(one);
    const envTwo = sign(two);
    expect(envOne.signature).not.toBe(envTwo.signature);
    const r1 = verify(envOne);
    const r2 = verify(envTwo);
    expect(r1.ok && r1.payload.equals(one)).toBe(true);
    expect(r2.ok && r2.payload.equals(two)).toBe(true);
    // swapping one envelope's payload for the reordered, semantically equal one is still a tamper
    failed(verify({ ...envOne, payload: envTwo.payload }), 'signature_invalid');
  });

  it('accepts a payload of exactly the maximum size and refuses one byte more', () => {
    const max = Buffer.alloc(MAX_PAYLOAD_BYTES, 0x61);
    const r = verify(sign(max));
    expect(r.ok && r.payload.length).toBe(MAX_PAYLOAD_BYTES);
    expect(() => sign(Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x61))).toThrow(AuthorizationCryptoError);
  });
});

describe('verified JSON payloads', () => {
  const verified = (text: string | Buffer) => {
    const r = verify(sign(typeof text === 'string' ? bytes(text) : text));
    if (!r.ok) throw new Error('expected a verified envelope');
    return r;
  };

  it('parses a verified JSON payload', () => {
    const value = { id: 'g-1', roles: ['developer'], nested: { n: 1, ok: true, none: null } };
    const parsed = parseVerifiedJsonPayload(verified(JSON.stringify(value)));
    expect(parsed).toEqual({ ok: true, value });
  });

  it('parses JSON values that are not objects', () => {
    expect(parseVerifiedJsonPayload(verified('42'))).toEqual({ ok: true, value: 42 });
    expect(parseVerifiedJsonPayload(verified('null'))).toEqual({ ok: true, value: null });
  });

  it('reports invalid JSON AFTER a successful signature check, without throwing', () => {
    const v = verified('{ this is not json');
    expect(v.ok).toBe(true); // the signature is fine: the bytes are exactly what was signed
    const parsed = parseVerifiedJsonPayload(v);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe('invalid_json');
      expect(parsed.message).not.toContain('this is not json');
    }
  });

  it('treats invalid UTF-8 and a byte-order mark as invalid JSON instead of silently repairing them', () => {
    expect(parseVerifiedJsonPayload(verified(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])))).toMatchObject({ ok: false, code: 'invalid_json' });
    expect(parseVerifiedJsonPayload(verified(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('{}')])))).toMatchObject({ ok: false, code: 'invalid_json' });
  });

  it('never reaches JSON parsing for a tampered payload: the signature failure comes first', () => {
    const env = sign(bytes('{"ok":true}'));
    const tampered = { ...env, payload: Buffer.from('not json at all').toString('base64url') };
    failed(verify(tampered), 'signature_invalid');
  });

  it('keeps UTF-8 content intact through signing and parsing', () => {
    const parsed = parseVerifiedJsonPayload(verified(JSON.stringify({ name: '日本語 🔐 café' })));
    expect(parsed).toEqual({ ok: true, value: { name: '日本語 🔐 café' } });
  });
});

describe('tamper detection', () => {
  it('rejects a changed payload', () => {
    const env = sign(bytes('amount=100'));
    failed(verify({ ...env, payload: bytes('amount=900').toString('base64url') }), 'signature_invalid');
  });

  it('rejects a truncated or extended payload', () => {
    const env = sign(bytes('amount=100'));
    failed(verify({ ...env, payload: bytes('amount=10').toString('base64url') }), 'signature_invalid');
    failed(verify({ ...env, payload: bytes('amount=1000').toString('base64url') }), 'signature_invalid');
  });

  it('rejects any flipped bit in the signature', () => {
    const env = sign();
    const sig = Buffer.from(env.signature, 'base64url');
    for (const byteIndex of [0, 1, 31, 32, 62, 63]) {
      const bad = Buffer.from(sig);
      bad[byteIndex] ^= 0x01;
      failed(verify({ ...env, signature: bad.toString('base64url') }), 'signature_invalid');
    }
  });

  it("rejects another envelope's signature", () => {
    const one = sign(bytes('one'));
    const two = sign(bytes('two'));
    failed(verify({ ...one, signature: two.signature }), 'signature_invalid');
  });

  it('rejects a changed payload even when the signature field is left untouched and well-formed', () => {
    const env = sign(bytes('{"role":"developer"}'));
    failed(verify({ ...env, payload: bytes('{"role":"admin"}').toString('base64url') }), 'signature_invalid');
  });
});

describe('keys and key identifiers', () => {
  it('rejects a signature made by a different private key (different key id)', () => {
    failed(verify(sign(bytes('x'), 'grant', B), 'grant', A), 'key_id_mismatch');
  });

  it("rejects a forged key id: another key's signature relabelled with the trusted key's id", () => {
    const forged = { ...sign(bytes('x'), 'grant', B), keyId: deriveKeyId(A.publicKey) };
    failed(verify(forged, 'grant', A), 'signature_invalid');
  });

  it('rejects an envelope whose key id is not the trusted key', () => {
    const env = sign();
    failed(verify({ ...env, keyId: 'a'.repeat(64) }), 'key_id_mismatch');
    failed(verify({ ...env, keyId: deriveKeyId(B.publicKey) }), 'key_id_mismatch');
  });

  it('rejects malformed key ids', () => {
    const env = sign();
    for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), `${env.keyId}0`, env.keyId.slice(1), ` ${env.keyId}`, env.keyId.toUpperCase()]) {
      failed(verify({ ...env, keyId: bad }), 'malformed_envelope');
    }
  });

  it('never takes a key from the envelope: an attacker signing with their own key and key id still fails', () => {
    const attacker = newKeys();
    const attackerEnvelope = sign(bytes('{"role":"admin"}'), 'grant', attacker);
    failed(verify(attackerEnvelope, 'grant', A), 'key_id_mismatch');
    // and an envelope cannot even carry a key field
    failed(verify({ ...attackerEnvelope, publicKey: 'whatever' }, 'grant', A), 'malformed_envelope');
    failed(verify({ ...attackerEnvelope, key: 'whatever' }, 'grant', A), 'malformed_envelope');
  });
});

describe('signing domains', () => {
  it('rejects a signature reused for a different domain (expected domain differs)', () => {
    failed(verify(sign(bytes('x'), 'grant'), 'revocation'), 'domain_mismatch');
  });

  it('rejects a signature whose domain label was rewritten (the signed input no longer matches)', () => {
    const env = sign(bytes('x'), 'grant');
    failed(verify({ ...env, domain: 'revocation' }, 'revocation'), 'signature_invalid');
    failed(verify({ ...env, domain: 'policy' }, 'policy'), 'signature_invalid');
  });

  it('keeps the Evidence Pack domain separate from every authorization domain', () => {
    const pack = sign(bytes('pack'), 'evidence_pack');
    for (const other of SIGNING_DOMAINS.filter((d) => d !== 'evidence_pack')) {
      failed(verify(pack, other), 'domain_mismatch');
      failed(verify({ ...pack, domain: other }, other), 'signature_invalid');
    }
    const grant = sign(bytes('pack'), 'grant');
    failed(verify({ ...grant, domain: 'evidence_pack' }, 'evidence_pack'), 'signature_invalid');
  });

  it('signs under a different namespace for the Evidence Pack than for authorization artifacts', () => {
    const payload = bytes('same bytes');
    const authz = buildSigningInput('policy', payload).toString('latin1');
    const pack = buildSigningInput('evidence_pack', payload).toString('latin1');
    expect(authz.startsWith(`${AUTHORIZATION_NAMESPACE} 6 policy ${payload.length} `)).toBe(true);
    expect(pack.startsWith(`${PROVENANCE_NAMESPACE} 13 evidence_pack ${payload.length} `)).toBe(true);
    expect(authz).not.toBe(pack);
  });

  it('rejects a signature over the bare payload: the domain prefix is part of what is signed', () => {
    const payload = bytes('{"hello":"world"}');
    const bare = cryptoSign(null, payload, A.privateKey); // a valid Ed25519 signature, but with no domain separation
    const forged: SignedEnvelope = {
      version: 1,
      domain: 'grant',
      keyId: deriveKeyId(A.publicKey),
      payload: payload.toString('base64url'),
      signature: bare.toString('base64url'),
    };
    failed(verify(forged), 'signature_invalid');
    // and a signature that covers the domain but not the payload length is rejected as well
    const noLength = cryptoSign(null, Buffer.concat([Buffer.from(`${AUTHORIZATION_NAMESPACE} 5 grant `, 'ascii'), payload]), A.privateKey);
    failed(verify({ ...forged, signature: noLength.toString('base64url') }), 'signature_invalid');
  });

  it('gives every domain a different signing input for the same payload', () => {
    const inputs = SIGNING_DOMAINS.map((d) => buildSigningInput(d, bytes('x')).toString('latin1'));
    expect(new Set(inputs).size).toBe(SIGNING_DOMAINS.length);
  });

  it('rejects an unknown domain, in the envelope and as the expected domain', () => {
    const env = sign();
    failed(verify({ ...env, domain: 'admin' }), 'unknown_domain');
    failed(verify({ ...env, domain: '' }), 'unknown_domain');
    failed(verify({ ...env, domain: 'GRANT' }), 'unknown_domain');
    failed(verifyEnvelope(env, { expectedDomain: 'nonsense' as SigningDomain, trustedPublicKey: A.publicKey }), 'unknown_domain');
  });

  it('refuses to sign for an unknown domain', () => {
    expect(() => signEnvelope({ domain: 'admin' as SigningDomain, payload: bytes('x'), privateKey: A.privateKey })).toThrow(AuthorizationCryptoError);
    try {
      signEnvelope({ domain: 'admin' as SigningDomain, payload: bytes('x'), privateKey: A.privateKey });
    } catch (err) {
      expect((err as AuthorizationCryptoError).reason).toBe('unknown_domain');
    }
  });
});

describe('format version', () => {
  it('rejects unsupported versions', () => {
    const env = sign();
    for (const v of [0, 2, 3, -1, 1.5, 99]) failed(verify(withField(env, 'version', v)), 'unsupported_version');
  });

  it('rejects a version that is not a number', () => {
    const env = sign();
    for (const v of ['1', null, undefined, true, [1], {}]) failed(verify(withField(env, 'version', v)), 'malformed_envelope');
  });
});

describe('payload encoding and size', () => {
  it('refuses to sign an empty payload', () => {
    expect(() => sign(new Uint8Array(0))).toThrow(AuthorizationCryptoError);
    try {
      sign(new Uint8Array(0));
    } catch (err) {
      expect((err as AuthorizationCryptoError).reason).toBe('empty_payload');
    }
  });

  it('rejects a forged envelope with an empty payload', () => {
    failed(verify(withField(sign(), 'payload', '')), 'empty_payload');
  });

  it('rejects a payload that is not bytes when signing', () => {
    expect(() => signEnvelope({ domain: 'grant', payload: 'text' as unknown as Uint8Array, privateKey: A.privateKey })).toThrow(AuthorizationCryptoError);
    expect(() => signEnvelope({ domain: 'grant', payload: null as unknown as Uint8Array, privateKey: A.privateKey })).toThrow(AuthorizationCryptoError);
  });

  it('rejects an oversized payload before decoding it', () => {
    const env = sign();
    failed(verify(withField(env, 'payload', 'A'.repeat(MAX_ENCODED_PAYLOAD_CHARS + 1))), 'payload_too_large');
    failed(verify(withField(env, 'payload', 'A'.repeat(5_000_000))), 'payload_too_large');
  });

  it('rejects malformed Base64url payloads', () => {
    const env = sign();
    for (const bad of ['!!!!', 'ab=c', 'QQ==', 'QQ=', 'a+b/', 'ab cd', 'ab\ncd', 'abéd', 'Q', 'QQQQQ', 'a b']) {
      failed(verify(withField(env, 'payload', bad)), 'malformed_payload_encoding');
    }
  });

  it('rejects non-canonical Base64url (text that decodes but would not re-encode to itself)', () => {
    const env = sign();
    expect(Buffer.from('QR', 'base64url').equals(Buffer.from('QQ', 'base64url'))).toBe(true); // same bytes, two spellings
    failed(verify(withField(env, 'payload', 'QR')), 'malformed_payload_encoding');
  });

  it('rejects a payload that is not a string', () => {
    const env = sign();
    for (const bad of [123, null, undefined, [], {}, true]) failed(verify(withField(env, 'payload', bad)), 'malformed_envelope');
  });
});

describe('signature encoding and length', () => {
  it('rejects malformed Base64url signatures', () => {
    const env = sign();
    for (const bad of ['!!!!', `${env.signature.slice(0, -1)}=`, `${env.signature}==`, env.signature.replace(/[A-Za-z]/, '+'), `${env.signature.slice(0, 40)} ${env.signature.slice(41)}`]) {
      failed(verify(withField(env, 'signature', bad)), 'malformed_signature_encoding');
    }
  });

  it('rejects a non-canonical spelling of an otherwise valid signature', () => {
    const env = sign();
    const last = env.signature.at(-1) as string;
    const index = BASE64URL_ALPHABET.indexOf(last);
    const nonCanonical = env.signature.slice(0, -1) + BASE64URL_ALPHABET[index | 1]; // sets a bit that must be zero
    expect(nonCanonical).not.toBe(env.signature);
    failed(verify(withField(env, 'signature', nonCanonical)), 'malformed_signature_encoding');
  });

  it('rejects signatures of the wrong length', () => {
    const env = sign();
    for (const length of [0, 1, 32, 63, 65, 96, 128]) {
      failed(verify(withField(env, 'signature', Buffer.alloc(length, 7).toString('base64url'))), 'invalid_signature_length');
    }
    failed(verify(withField(env, 'signature', 'A'.repeat(500))), 'invalid_signature_length');
    expect(ED25519_SIGNATURE_BYTES).toBe(64);
  });

  it('rejects a signature that is not a string', () => {
    const env = sign();
    for (const bad of [123, null, undefined, [], {}]) failed(verify(withField(env, 'signature', bad)), 'malformed_envelope');
  });
});

describe('envelope structure', () => {
  it('rejects unexpected extra fields', () => {
    const env = sign();
    for (const [name, value] of [['extra', 1], ['__proto__x', {}], ['publicKey', 'k'], ['comment', 'hi'], ['signatures', []]] as const) {
      failed(verify({ ...env, [name]: value }), 'malformed_envelope');
    }
  });

  it('rejects missing fields', () => {
    const env = sign();
    for (const field of ['version', 'domain', 'keyId', 'payload', 'signature'] as const) {
      const copy: Record<string, unknown> = { ...env };
      delete copy[field];
      failed(verify(copy), 'malformed_envelope');
    }
  });

  it('rejects anything that is not a plain object', () => {
    for (const bad of [null, undefined, [], [sign()], 'envelope', 42, true, () => sign(), Symbol('x')]) {
      failed(verify(bad), 'malformed_envelope');
    }
  });

  it('does not accept inherited fields in place of own fields', () => {
    failed(verify(Object.create({ ...sign() })), 'malformed_envelope');
  });
});

describe('envelope text', () => {
  const opts = { expectedDomain: 'grant' as SigningDomain, trustedPublicKey: A.publicKey };

  it('rejects text that is not JSON, not a string, or too large (without parsing it)', () => {
    failed(verifyEnvelopeText('{ nope', opts), 'malformed_envelope');
    failed(verifyEnvelopeText('', opts), 'malformed_envelope');
    for (const bad of [null, undefined, 5, {}, Buffer.from('{}')]) failed(verifyEnvelopeText(bad, opts), 'malformed_envelope');
    failed(verifyEnvelopeText('x'.repeat(MAX_ENVELOPE_TEXT_BYTES + 1), opts), 'envelope_too_large');
  });

  it('rejects JSON that is valid but not an envelope', () => {
    for (const text of ['null', '[]', '"x"', '123', '{}', '{"version":1}']) failed(verifyEnvelopeText(text, opts), 'malformed_envelope');
  });

  it('still detects tampering inside envelope text', () => {
    const env = sign(bytes('x'));
    failed(verifyEnvelopeText(JSON.stringify({ ...env, payload: bytes('y').toString('base64url') }), opts), 'signature_invalid');
  });
});

describe('safe failure and no secret leakage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never throws on hostile or garbage input and always returns a structured failure', () => {
    const hostile: unknown[] = [
      undefined, null, 0, -1, NaN, Infinity, '', 'x', [], {}, true, Symbol('s'), () => 1, 10n, new Date(),
      { version: 1 }, { version: 1, domain: 'grant', keyId: 'x', payload: 'x', signature: 'x' },
      new Proxy({}, { ownKeys: () => { throw new Error('boom'); } }),
      new Proxy({}, { get: () => { throw new Error('boom'); } }),
      Object.create(null),
    ];
    for (const input of hostile) {
      expect(() => verifyEnvelope(input, { expectedDomain: 'grant', trustedPublicKey: A.publicKey })).not.toThrow();
      const r = verifyEnvelope(input, { expectedDomain: 'grant', trustedPublicKey: A.publicKey });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).not.toContain('boom');
    }
  });

  it('failure messages are fixed text: they never echo the payload, signature or key', () => {
    const secret = 'TOP-SECRET-PAYLOAD-MARKER';
    const env = sign(bytes(secret));
    const results = [
      verify({ ...env, signature: 'A'.repeat(86) }),
      verify({ ...env, payload: bytes('other').toString('base64url') }),
      verify({ ...env, keyId: 'b'.repeat(64) }),
      verify({ ...env, domain: 'revocation' }),
      verify({ ...env, extra: secret }),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        for (const forbidden of [secret, env.payload, env.signature, env.keyId, 'PRIVATE', 'BEGIN']) expect(r.message).not.toContain(forbidden);
      }
    }
  });

  it('signing errors never contain key material', () => {
    const jwk = A.privateKey.export({ format: 'jwk' });
    const messages: string[] = [];
    for (const attempt of [
      () => signEnvelope({ domain: 'grant', payload: bytes('x'), privateKey: A.publicKey }),
      () => signEnvelope({ domain: 'grant', payload: bytes('x'), privateKey: 'not a key' as unknown as KeyObject }),
      () => signEnvelope({ domain: 'grant', payload: new Uint8Array(0), privateKey: A.privateKey }),
    ]) {
      try {
        attempt();
      } catch (err) {
        messages.push(String((err as Error).message));
      }
    }
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      expect(m).not.toContain(String(jwk.d));
      expect(m).not.toContain(String(jwk.x));
      expect(m).not.toMatch(/PRIVATE|BEGIN/);
    }
  });

  it('never logs anything while signing and verifying', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const env = sign();
    verify(env);
    verify({ ...env, signature: 'A'.repeat(86) });
    verify(null);
    try {
      signEnvelope({ domain: 'grant', payload: bytes('x'), privateKey: A.publicKey });
    } catch {
      // expected
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('does not leave the signing key on the envelope', () => {
    const env = sign();
    const jwk = A.privateKey.export({ format: 'jwk' });
    expect(JSON.stringify(env)).not.toContain(String(jwk.d));
  });
});
