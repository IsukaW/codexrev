import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeDependencies } from '../../../src/features/migration-verification/analysis/dependencyAnalyzer.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-mv-dep-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeProject(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

async function snapshotProject(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.set(path.relative(tmpRoot, abs), await fs.readFile(abs, 'utf-8'));
    }
  }
  await walk(tmpRoot);
  return out;
}

const MANIFEST = JSON.stringify({
  name: 'fixture-app',
  version: '1.0.0',
  dependencies: { utilx: '^1.4.2', zeta: '~2.0.0' },
  devDependencies: { vitest: '^2.1.8' },
  optionalDependencies: { fsevents: '^2.3.3' },
  peerDependencies: { react: '>=18' },
});

const LOCK_V3 = JSON.stringify({
  name: 'fixture-app',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture-app', version: '1.0.0' },
    'node_modules/utilx': { version: '1.4.2' },
    'node_modules/zeta': { version: '2.0.1' },
    'node_modules/vitest': { version: '2.1.9', dev: true },
    'node_modules/fsevents': { version: '2.3.3', optional: true },
    'node_modules/react': { version: '18.3.1' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/utilx/node_modules/tiny': { version: '0.1.0' },
    'node_modules/versionless': {},
  },
});

describe('analyzeDependencies — valid npm project', () => {
  it('reports project info and direct dependencies with evidence refs', async () => {
    await writeProject({ 'package.json': MANIFEST, 'package-lock.json': LOCK_V3 });
    const { project, dependencies, issues } = await analyzeDependencies({ projectRoot: tmpRoot });
    expect(issues).toEqual([]);
    expect(project?.ecosystem).toBe('npm');
    expect(project?.manifest).toEqual({ name: 'fixture-app', projectVersion: '1.0.0', packageManager: 'npm' });
    expect(project?.manifestPath).toBe(path.join(tmpRoot, 'package.json'));
    expect(project?.lockfilePath).toBe(path.join(tmpRoot, 'package-lock.json'));

    const direct = dependencies.filter((d) => d.relation === 'direct');
    expect(direct.map((d) => d.name)).toEqual(['fsevents', 'react', 'utilx', 'vitest', 'zeta']);
    const utilx = direct.find((d) => d.name === 'utilx');
    expect(utilx).toMatchObject({
      declaredRange: '^1.4.2',
      resolvedVersion: '1.4.2',
      scope: 'runtime',
    });
    expect(utilx?.evidence).toEqual({
      status: 'present',
      source: { kind: 'manifest', ref: 'package.json#dependencies.utilx' },
      quality: 'exact',
    });
  });

  it('preserves dev, optional and peer scopes', async () => {
    await writeProject({ 'package.json': MANIFEST, 'package-lock.json': LOCK_V3 });
    const { dependencies } = await analyzeDependencies({ projectRoot: tmpRoot });
    const byName = new Map(dependencies.filter((d) => d.relation === 'direct').map((d) => [d.name, d]));
    expect(byName.get('vitest')?.scope).toBe('dev');
    expect(byName.get('fsevents')?.scope).toBe('optional');
    expect(byName.get('react')?.scope).toBe('peer');
    expect(byName.get('vitest')?.evidence.source?.ref).toBe('package.json#devDependencies.vitest');
  });

  it('records declared ranges separately from resolved versions', async () => {
    await writeProject({ 'package.json': MANIFEST, 'package-lock.json': LOCK_V3 });
    const { dependencies } = await analyzeDependencies({ projectRoot: tmpRoot });
    const zeta = dependencies.find((d) => d.name === 'zeta');
    expect(zeta?.declaredRange).toBe('~2.0.0');
    expect(zeta?.resolvedVersion).toBe('2.0.1');
  });

  it('tracks the target dependency and its target version', async () => {
    await writeProject({ 'package.json': MANIFEST, 'package-lock.json': LOCK_V3 });
    const { dependencies } = await analyzeDependencies({
      projectRoot: tmpRoot,
      targetDependency: 'utilx',
      targetVersion: '2.0.0',
    });
    const utilx = dependencies.find((d) => d.name === 'utilx');
    expect(utilx?.targetVersion).toBe('2.0.0');
    expect(dependencies.find((d) => d.name === 'zeta')?.targetVersion).toBeNull();
  });
});

describe('analyzeDependencies — transitive dependencies', () => {
  it('extracts transitive deps from a v2/v3 lockfile', async () => {
    await writeProject({ 'package.json': MANIFEST, 'package-lock.json': LOCK_V3 });
    const { dependencies } = await analyzeDependencies({ projectRoot: tmpRoot });
    const transitive = dependencies.filter((d) => d.relation === 'transitive');
    expect(transitive.map((d) => d.name)).toEqual(['left-pad', 'tiny', 'versionless']);
    expect(transitive.find((d) => d.name === 'left-pad')).toMatchObject({
      declaredRange: null,
      resolvedVersion: '1.3.0',
    });
    expect(transitive.find((d) => d.name === 'tiny')?.resolvedVersion).toBe('0.1.0');
    expect(transitive.find((d) => d.name === 'tiny')?.evidence.source?.ref).toBe(
      'package-lock.json#packages.node_modules/utilx/node_modules/tiny',
    );
  });

  it('extracts transitive deps from a v1 lockfile tree', async () => {
    await writeProject({
      'package.json': JSON.stringify({ name: 'fixture-app', version: '1.0.0', dependencies: { utilx: '^1.4.2' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          utilx: { version: '1.4.2', dependencies: { deep: { version: '0.9.0' } } },
          'left-pad': { version: '1.3.0' },
        },
      }),
    });
    const { dependencies } = await analyzeDependencies({ projectRoot: tmpRoot });
    const transitive = dependencies.filter((d) => d.relation === 'transitive');
    expect(transitive.map((d) => d.name)).toEqual(['deep', 'left-pad']);
    expect(transitive.find((d) => d.name === 'deep')?.resolvedVersion).toBe('0.9.0');
    expect(transitive.find((d) => d.name === 'deep')?.evidence.source?.ref).toBe(
      'package-lock.json#dependencies.utilx.dependencies.deep',
    );
  });

  it('represents missing resolved-version info explicitly', async () => {
    await writeProject({ 'package.json': MANIFEST, 'package-lock.json': LOCK_V3 });
    const { dependencies } = await analyzeDependencies({ projectRoot: tmpRoot });
    const versionless = dependencies.find((d) => d.name === 'versionless');
    expect(versionless?.resolvedVersion).toBeNull();
    expect(versionless?.evidence.status).toBe('missing');
  });
});

describe('analyzeDependencies — degraded projects', () => {
  it('reports MANIFEST_MISSING when package.json is absent', async () => {
    await writeProject({ 'index.js': '// nothing\n' });
    const { project, dependencies, issues } = await analyzeDependencies({ projectRoot: tmpRoot });
    expect(project).toBeNull();
    expect(dependencies).toEqual([]);
    expect(issues.some((i) => i.code === 'MANIFEST_MISSING' && i.severity === 'error')).toBe(true);
  });

  it('reports ANALYZER_FAILED for a malformed package.json', async () => {
    await writeProject({ 'package.json': '{ this is not json' });
    const { project, issues } = await analyzeDependencies({ projectRoot: tmpRoot });
    expect(project).toBeNull();
    expect(issues.some((i) => i.code === 'ANALYZER_FAILED' && i.severity === 'error')).toBe(true);
  });

  it('reports LOCKFILE_MISSING and null resolved versions when the lockfile is absent', async () => {
    await writeProject({ 'package.json': MANIFEST });
    const { dependencies, issues } = await analyzeDependencies({ projectRoot: tmpRoot });
    expect(issues.some((i) => i.code === 'LOCKFILE_MISSING' && i.severity === 'warning')).toBe(true);
    const direct = dependencies.filter((d) => d.relation === 'direct');
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.every((d) => d.resolvedVersion === null)).toBe(true);
    expect(dependencies.filter((d) => d.relation === 'transitive')).toEqual([]);
  });

  it('reports ECOSYSTEM_UNSUPPORTED for a non-npm project', async () => {
    await writeProject({ 'pom.xml': '<project/>\n' });
    const { project, dependencies, issues } = await analyzeDependencies({ projectRoot: tmpRoot });
    expect(project).toBeNull();
    expect(dependencies).toEqual([]);
    const issue = issues.find((i) => i.code === 'ECOSYSTEM_UNSUPPORTED');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('future scope');
  });

  it('reports DEPENDENCY_UNRESOLVED for an unknown target dependency', async () => {
    await writeProject({ 'package.json': MANIFEST, 'package-lock.json': LOCK_V3 });
    const { issues } = await analyzeDependencies({ projectRoot: tmpRoot, targetDependency: 'no-such-pkg' });
    expect(issues.some((i) => i.code === 'DEPENDENCY_UNRESOLVED' && i.context === 'no-such-pkg')).toBe(true);
  });
});

describe('analyzeDependencies — determinism and read-only guarantee', () => {
  it('orders multiple dependencies deterministically (direct first, then name)', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        dependencies: { zeta: '1.0.0', alpha: '1.0.0', mid: '1.0.0' },
      }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/zeta': { version: '1.0.0' },
          'node_modules/alpha': { version: '1.0.0' },
          'node_modules/mid': { version: '1.0.0' },
          'node_modules/trans-b': { version: '1.0.0' },
          'node_modules/trans-a': { version: '1.0.0' },
        },
      }),
    });
    const first = await analyzeDependencies({ projectRoot: tmpRoot });
    const second = await analyzeDependencies({ projectRoot: tmpRoot });
    expect(first.dependencies.map((d) => `${d.relation}:${d.name}`)).toEqual([
      'direct:alpha',
      'direct:mid',
      'direct:zeta',
      'transitive:trans-a',
      'transitive:trans-b',
    ]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('does not modify any project file', async () => {
    await writeProject({
      'package.json': MANIFEST,
      'package-lock.json': LOCK_V3,
      'src/index.js': 'export const x = 1;\n',
    });
    const before = await snapshotProject();
    await analyzeDependencies({ projectRoot: tmpRoot, targetDependency: 'utilx', targetVersion: '2.0.0' });
    const after = await snapshotProject();
    expect(after.size).toBe(before.size);
    for (const [rel, content] of before) {
      expect(after.get(rel)).toBe(content);
    }
  });
});
