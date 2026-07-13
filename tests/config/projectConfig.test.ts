import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteProjectConfig,
  ensureProjectConfigDir,
  loadProjectConfig,
  projectConfigDir,
  projectConfigPath,
  saveProjectConfig,
} from '../../src/config/projectConfig.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('projectConfig', () => {
  it('reports correct paths', () => {
    expect(projectConfigDir('/x')).toBe(path.join('/x', '.codexrev'));
    expect(projectConfigPath('/x')).toBe(path.join('/x', '.codexrev', 'config.json'));
  });

  it('creates the directory', async () => {
    const dir = await ensureProjectConfigDir(tmpRoot);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('round-trips a config', async () => {
    const cfg = {
      schemaVersion: 1 as const,
      provider: 'openai' as const,
      model: 'gpt-4o',
      apiKey: { iv: 'a', tag: 'b', ciphertext: 'c' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    await saveProjectConfig(tmpRoot, cfg);
    const loaded = await loadProjectConfig(tmpRoot);
    expect(loaded).toEqual(cfg);
  });

  it('returns null when no file', async () => {
    expect(await loadProjectConfig(tmpRoot)).toBeNull();
  });

  it('rejects wrong schema version', async () => {
    await fs.mkdir(projectConfigDir(tmpRoot), { recursive: true });
    await fs.writeFile(
      projectConfigPath(tmpRoot),
      JSON.stringify({ schemaVersion: 999, provider: 'openai', model: 'x', apiKey: {} }),
      'utf-8',
    );
    await expect(loadProjectConfig(tmpRoot)).rejects.toThrow(/schemaVersion/);
  });

  it('deletes config', async () => {
    await saveProjectConfig(tmpRoot, {
      schemaVersion: 1,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: { iv: '', tag: '', ciphertext: '' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(await deleteProjectConfig(tmpRoot)).toBe(true);
    expect(await deleteProjectConfig(tmpRoot)).toBe(false);
  });
});