import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEBOUNCE_MS,
  LIVING_SPEC_SUBDIRS,
  configPath,
  defaultLivingSpecConfig,
  ensureStateDir,
  livingSpecDir,
  listProposalIds,
  listVersions,
  proposalPath,
  readConfig,
  readProposal,
  readUrsState,
  saveProposal,
  saveVersion,
  validateLivingSpecConfig,
  writeConfig,
  writeUrsState,
} from '../../../src/features/living-spec/tools/stateStore.js';
import {
  LivingSpecConfigError,
  LivingSpecProposalError,
} from '../../../src/features/living-spec/tools/errors.js';
import {
  makeSpecProposal,
  makeSpecUrsState,
} from '../../../src/features/living-spec/testing/fixtures.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-living-spec-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('ensureStateDir', () => {
  it('creates the .codexrev/living-spec layout', async () => {
    const dir = await ensureStateDir(tmpRoot);
    expect(dir).toBe(livingSpecDir(tmpRoot));
    for (const sub of LIVING_SPEC_SUBDIRS) {
      const stat = await fs.stat(path.join(dir, sub));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('seeds a valid default config.json', async () => {
    await ensureStateDir(tmpRoot);
    const cfg = await readConfig(tmpRoot);
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.debounceMs).toBe(DEFAULT_DEBOUNCE_MS);
    expect(cfg.watchedPaths).toEqual(['**/*']);
    expect(validateLivingSpecConfig(cfg)).toEqual(cfg);
  });

  it('is idempotent and never overwrites an existing config', async () => {
    await ensureStateDir(tmpRoot);
    const first = await readConfig(tmpRoot);
    await ensureStateDir(tmpRoot);
    expect(await readConfig(tmpRoot)).toEqual(first);
  });
});

describe('config.json validation (ajv + ajv-formats)', () => {
  it('returns defaults when no config.json exists', async () => {
    const cfg = await readConfig(tmpRoot);
    expect(cfg.debounceMs).toBe(DEFAULT_DEBOUNCE_MS);
  });

  it('round-trips a custom config', async () => {
    await ensureStateDir(tmpRoot);
    const cfg = {
      ...defaultLivingSpecConfig(),
      watchedPaths: ['src/**', 'test/**'],
      debounceMs: 250,
      modelOverride: 'openai/gpt-4o-mini',
    };
    await writeConfig(tmpRoot, cfg);
    expect(await readConfig(tmpRoot)).toEqual(cfg);
  });

  it('rejects invalid field types against the schema', async () => {
    await ensureStateDir(tmpRoot);
    await fs.writeFile(
      configPath(tmpRoot),
      JSON.stringify({ ...defaultLivingSpecConfig(), debounceMs: 'fast' }),
      'utf-8',
    );
    await expect(readConfig(tmpRoot)).rejects.toThrow(LivingSpecConfigError);
    await expect(readConfig(tmpRoot)).rejects.toThrow(/debounceMs/);
  });

  it('rejects empty watchedPaths and out-of-range debounce', () => {
    expect(() => validateLivingSpecConfig({ ...defaultLivingSpecConfig(), watchedPaths: [] }))
      .toThrow(LivingSpecConfigError);
    expect(() => validateLivingSpecConfig({ ...defaultLivingSpecConfig(), debounceMs: -1 }))
      .toThrow(LivingSpecConfigError);
    expect(() => validateLivingSpecConfig({ ...defaultLivingSpecConfig(), debounceMs: 61_000 }))
      .toThrow(LivingSpecConfigError);
  });

  it('rejects unknown properties (config is closed for extension)', () => {
    expect(() =>
      validateLivingSpecConfig({ ...defaultLivingSpecConfig(), surprise: true }),
    ).toThrow(LivingSpecConfigError);
  });

  it('rejects timestamps that are not date-time (ajv-formats)', () => {
    expect(() =>
      validateLivingSpecConfig({ ...defaultLivingSpecConfig(), createdAt: 'yesterday' }),
    ).toThrow(LivingSpecConfigError);
  });

  it('refuses to write an invalid config', async () => {
    await expect(
      writeConfig(tmpRoot, { ...defaultLivingSpecConfig(), debounceMs: -5 }),
    ).rejects.toThrow(LivingSpecConfigError);
  });

  it('reports errors with the living-spec config code', () => {
    try {
      validateLivingSpecConfig({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as LivingSpecConfigError).code).toBe('CODEXREV_LIVING_SPEC_CONFIG');
    }
  });
});

describe('proposal + version persistence', () => {
  it('round-trips a pending proposal', async () => {
    await ensureStateDir(tmpRoot);
    const proposal = makeSpecProposal();
    await saveProposal(tmpRoot, proposal);
    expect(await readProposal(tmpRoot, proposal.id)).toEqual(proposal);
    expect(await listProposalIds(tmpRoot)).toEqual([proposal.id]);
  });

  it('returns null for an unknown proposal', async () => {
    await ensureStateDir(tmpRoot);
    expect(await readProposal(tmpRoot, 'nope')).toBeNull();
  });

  it('rejects proposal ids that escape the proposals directory', async () => {
    await ensureStateDir(tmpRoot);
    expect(() => proposalPath(tmpRoot, '..')).toThrow(LivingSpecProposalError);
    expect(() => proposalPath(tmpRoot, '../secrets')).toThrow(LivingSpecProposalError);
    await expect(readProposal(tmpRoot, '../secrets')).rejects.toThrow(LivingSpecProposalError);
  });

  it('lists URS versions sorted by version', async () => {
    await ensureStateDir(tmpRoot);
    await saveVersion(tmpRoot, { version: 2, changeId: 'bbb', createdAt: '2026-10-17T00:00:00.000Z' });
    await saveVersion(tmpRoot, { version: 1, changeId: 'aaa', createdAt: '2026-10-16T00:00:00.000Z' });
    const versions = await listVersions(tmpRoot);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0].changeId).toBe('aaa');
  });

  it('round-trips the URS state and reports null when absent', async () => {
    expect(await readUrsState(tmpRoot)).toBeNull();
    await ensureStateDir(tmpRoot);
    const state = makeSpecUrsState({ version: 3 });
    await writeUrsState(tmpRoot, state);
    expect(await readUrsState(tmpRoot)).toEqual(state);
  });
});
