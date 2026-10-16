import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDependencies, classifyMajorChange, parseVersionSpec } from '../../../../src/features/action-safety/collectors/dependencyCollector.js';
import { collectGit } from '../../../../src/features/action-safety/collectors/gitCollector.js';
import { NOW, makeRepo, makeTempDir, pkg, type TempRepo } from '../../../../src/features/action-safety/testing/fixtures.js';

let repo: TempRepo;

beforeEach(async () => {
  repo = await makeRepo();
});

afterEach(async () => {
  await repo.remove();
});

const collect = async (diffRef?: string) => {
  const git = await collectGit({ cwd: repo.dir, ...(diffRef ? { diffRef } : {}), now: NOW });
  return collectDependencies({ git, now: NOW });
};

describe('collectDependencies: package.json changes', () => {
  it('reports added, removed and re-versioned dependencies and flags major bumps without judging them', async () => {
    await repo.write('package.json', pkg({ a: '^1.0.0', b: '^2.1.0', c: '1.0.0', f: 'workspace:*' }, { d: '^0.1.0', g: '^3.0.0' }));
    await repo.commitAll('base');
    await repo.write('package.json', pkg({ a: '^2.0.0', c: '1.0.0', e: '^1.0.0', f: 'workspace:^' }, { d: '^0.2.0', g: '^3.4.0' }));

    const r = await collect();
    expect(r.state).toBe('collected');
    const by = Object.fromEntries(r.changes.map((c) => [`${c.section}:${c.name}`, c]));
    expect(by['dependencies:a']).toMatchObject({ change: 'changed', from: '^1.0.0', to: '^2.0.0', majorChange: 'major_upgrade' });
    expect(by['dependencies:b']).toMatchObject({ change: 'removed', from: '^2.1.0' });
    expect(by['dependencies:e']).toMatchObject({ change: 'added', to: '^1.0.0' });
    expect(by['dependencies:c']).toBeUndefined(); // unchanged
    expect(by['devDependencies:d']).toMatchObject({ majorChange: 'possibly_breaking_0x' });
    expect(by['devDependencies:g']).toMatchObject({ majorChange: 'no_major_change' }); // a minor bump is not flagged
    expect(by['dependencies:f']).toMatchObject({ majorChange: 'unknown' });
    expect(r.counts).toEqual({ added: 1, removed: 1, changed: 4, majorUpgrades: 1, unknownMajor: 1 });
    expect(r.manifestsChanged).toEqual(['package.json']);
    expect(r.compatibility).toBe('UNKNOWN');
    expect(r.limitations.join(' ')).toMatch(/compatibility .* cannot be established/);
  });

  it('treats a brand-new package.json as all additions, and a deleted one as all removals', async () => {
    await repo.write('old/package.json', pkg({ gone: '^1.0.0' }));
    await repo.commitAll('base');
    await fs.rm(path.join(repo.dir, 'old', 'package.json'));
    await repo.write('new/package.json', pkg({ fresh: '^1.0.0' }));
    const r = await collect();
    const by = Object.fromEntries(r.changes.map((c) => [c.name, c.change]));
    expect(by).toEqual({ gone: 'removed', fresh: 'added' });
  });

  it('works for a nested package.json in a monorepo and records which manifest changed', async () => {
    await repo.write('packages/web/package.json', pkg({ react: '^18.0.0' }));
    await repo.commitAll('base');
    await repo.write('packages/web/package.json', pkg({ react: '^19.0.0' }));
    const r = await collect();
    expect(r.manifestsChanged).toEqual(['packages/web/package.json']);
    expect(r.changes[0]).toMatchObject({ manifest: 'packages/web/package.json', majorChange: 'major_upgrade' });
  });

  it('compares with a --diff revision', async () => {
    await repo.write('package.json', pkg({ a: '^1.0.0' }));
    await repo.commitAll('base');
    await repo.write('package.json', pkg({ a: '^2.0.0' }));
    await repo.commitAll('bump');
    const r = await collect('HEAD~1');
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ name: 'a', from: '^1.0.0', to: '^2.0.0' });
  });
});

describe('collectDependencies: other files', () => {
  it('notices a lockfile change and stays UNKNOWN about compatibility', async () => {
    await repo.write('package.json', pkg({ a: '^1.0.0' }));
    await repo.write('package-lock.json', '{"lockfileVersion":3}\n');
    await repo.commitAll('base');
    await repo.write('package-lock.json', '{"lockfileVersion":3,"x":1}\n');
    const r = await collect();
    expect(r.lockfilesChanged).toEqual(['package-lock.json']);
    expect(r.changes).toEqual([]);
    expect(r.compatibility).toBe('UNKNOWN');
  });

  it('notices non-npm manifests but does not pretend to analyse them', async () => {
    await repo.write('requirements.txt', 'flask==2.0.0\n');
    await repo.commitAll('base');
    await repo.write('requirements.txt', 'flask==3.0.0\n');
    const r = await collect();
    expect(r.unparsedManifests).toEqual(['requirements.txt']);
    expect(r.changes).toEqual([]);
    expect(r.compatibility).toBe('UNKNOWN');
    expect(r.limitations.join(' ')).toMatch(/not analysed/);
  });

  it('reports NOT_APPLICABLE only when nothing dependency-related changed', async () => {
    await repo.write('src/a.ts', 'one\n');
    await repo.write('package.json', pkg({ a: '^1.0.0' }));
    await repo.commitAll('base');
    await repo.write('src/a.ts', 'two\n');
    const r = await collect();
    expect(r.compatibility).toBe('NOT_APPLICABLE');
    expect(r.manifestsChanged).toEqual([]);
  });

  it('ignores files under node_modules', async () => {
    await repo.write('src/a.ts', 'one\n');
    await repo.commitAll('base');
    await repo.write('node_modules/x/package.json', pkg({ y: '^1.0.0' }));
    const r = await collect();
    expect(r.manifestsChanged).toEqual([]);
  });

  it('records malformed manifests as a limitation instead of failing', async () => {
    await repo.write('package.json', pkg({ a: '^1.0.0' }));
    await repo.commitAll('base');
    await repo.write('package.json', '{ this is not json');
    const r = await collect();
    expect(r.state).toBe('collected');
    expect(r.changes).toEqual([]);
    expect(r.limitations.join(' ')).toMatch(/package\.json: not valid JSON/);
    expect(r.compatibility).toBe('UNKNOWN');
  });

  it('is UNKNOWN (not NOT_APPLICABLE) when git state was not collected', async () => {
    const plain = await makeTempDir();
    try {
      const git = await collectGit({ cwd: plain, now: NOW });
      const r = await collectDependencies({ git, now: NOW });
      expect(r.state).toBe('not_collected');
      expect(r.compatibility).toBe('UNKNOWN');
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});

describe('collectDependencies: never installs or runs anything', () => {
  it('does not run lifecycle scripts or create node_modules', async () => {
    const marker = path.join(repo.dir, 'PWNED.txt');
    await repo.write('package.json', pkg({ a: '^1.0.0' }));
    await repo.commitAll('base');
    await repo.write(
      'package.json',
      pkg({ a: '^2.0.0' }, {}, { scripts: { preinstall: `node -e "require('fs').writeFileSync('PWNED.txt','x')"`, postinstall: 'echo hi' } }),
    );
    const before = await repo.snapshotGitDir();
    await collect();
    await expect(fs.access(marker)).rejects.toThrow();
    await expect(fs.access(path.join(repo.dir, 'node_modules'))).rejects.toThrow();
    expect(await repo.snapshotGitDir()).toEqual(before);
  });
});

describe('version helpers', () => {
  it.each([
    ['^1.2.3', 1, 2],
    ['~2.0.0', 2, 0],
    ['>=3', 3, undefined],
    ['v4.1.0', 4, 1],
    ['1.x', 1, undefined],
  ])('parses %s', (spec, major, minor) => {
    const p = parseVersionSpec(spec);
    expect(p?.major).toBe(major);
    expect(p?.minor).toBe(minor);
  });

  it.each(['latest', '*', 'workspace:*', 'git+https://x/y.git', 'npm:other@^1', '^1.0.0 || ^2.0.0', 'file:../x'])('cannot parse %s', (spec) => {
    expect(parseVersionSpec(spec)).toBeUndefined();
  });

  it('classifies major changes', () => {
    expect(classifyMajorChange('^1.0.0', '^2.0.0')).toBe('major_upgrade');
    expect(classifyMajorChange('^2.0.0', '^1.9.0')).toBe('major_downgrade');
    expect(classifyMajorChange('^1.0.0', '^1.5.0')).toBe('no_major_change');
    expect(classifyMajorChange('^0.1.0', '^0.2.0')).toBe('possibly_breaking_0x');
    expect(classifyMajorChange('latest', '^2.0.0')).toBe('unknown');
  });
});
