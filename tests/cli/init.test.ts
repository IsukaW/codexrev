import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/init.js';
import { _resetFakeStore, getDek, setDek } from '../../src/security/keychain.js';
import { loadProjectConfig, projectConfigPath } from '../../src/config/projectConfig.js';

let tmpRoot: string;
const ORIGINAL_ENV = process.env.CODEXREV_TEST_FAKE_KEYCHAIN;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-init-'));
  process.env.CODEXREV_TEST_FAKE_KEYCHAIN = '1';
  _resetFakeStore();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env.CODEXREV_TEST_FAKE_KEYCHAIN;
  else process.env.CODEXREV_TEST_FAKE_KEYCHAIN = ORIGINAL_ENV;
});

describe('runInit', () => {
  it('writes encrypted config and DEK in non-interactive mode', async () => {
    await runInit({
      cwd: tmpRoot,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test-abc',
      nonInteractive: true,
    });

    const cfg = await loadProjectConfig(tmpRoot);
    expect(cfg).not.toBeNull();
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.model).toBe('gpt-4o');
    expect(cfg?.apiKey.iv).toBeTruthy();
    expect(cfg?.apiKey.ciphertext).toBeTruthy();

    const dek = await getDek(tmpRoot);
    expect(dek).not.toBeNull();
    expect(dek?.length).toBe(32);
  });

  it('refuses to overwrite existing config without --reset', async () => {
    await runInit({
      cwd: tmpRoot,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      nonInteractive: true,
    });

    const beforePath = projectConfigPath(tmpRoot);
    const beforeStat = await fs.stat(beforePath);

    await runInit({
      cwd: tmpRoot,
      provider: 'anthropic',
      model: 'claude',
      apiKey: 'sk-other',
      nonInteractive: true,
    });

    const afterStat = await fs.stat(beforePath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('--reset replaces existing config', async () => {
    await runInit({
      cwd: tmpRoot,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      nonInteractive: true,
    });
    // Force a different DEK so we can prove --reset wrote a new one
    await setDek(tmpRoot, Buffer.alloc(32, 7));

    await runInit({
      cwd: tmpRoot,
      provider: 'anthropic',
      model: 'claude',
      apiKey: 'sk-new',
      reset: true,
      nonInteractive: true,
    });

    const cfg = await loadProjectConfig(tmpRoot);
    expect(cfg?.provider).toBe('anthropic');
    const dek = await getDek(tmpRoot);
    expect(dek?.equals(Buffer.alloc(32, 7))).toBe(false);
  });

  it('rejects incomplete non-interactive flags', async () => {
    await runInit({
      cwd: tmpRoot,
      provider: 'openai',
      // model and apiKey missing
      nonInteractive: true,
    });
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });
});