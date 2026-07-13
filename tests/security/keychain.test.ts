import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetFakeStore,
  deleteDek,
  getDek,
  isAvailable,
  projectKeychainKey,
  setDek,
} from '../../src/security/keychain.js';

const ORIGINAL_ENV = process.env.CODEXREV_TEST_FAKE_KEYCHAIN;

describe('keychain (fake mode)', () => {
  beforeEach(() => {
    process.env.CODEXREV_TEST_FAKE_KEYCHAIN = '1';
    _resetFakeStore();
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CODEXREV_TEST_FAKE_KEYCHAIN;
    else process.env.CODEXREV_TEST_FAKE_KEYCHAIN = ORIGINAL_ENV;
  });

  it('reports available in fake mode', () => {
    expect(isAvailable()).toBe(true);
  });

  it('binds DEK to project path', async () => {
    const root = '/tmp/proj-a';
    const dek = Buffer.from('a'.repeat(32));
    await setDek(root, dek);
    const got = await getDek(root);
    expect(got?.toString('hex')).toBe(dek.toString('hex'));
    const other = await getDek('/tmp/proj-b');
    expect(other).toBeNull();
  });

  it('produces a deterministic, per-path key', () => {
    const k1 = projectKeychainKey('/tmp/proj-a');
    const k2 = projectKeychainKey('/tmp/proj-a');
    const k3 = projectKeychainKey('/tmp/proj-b');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('deletes DEK', async () => {
    const root = '/tmp/proj-c';
    await setDek(root, Buffer.alloc(32, 1));
    expect(await deleteDek(root)).toBe(true);
    expect(await deleteDek(root)).toBe(false);
    expect(await getDek(root)).toBeNull();
  });
});