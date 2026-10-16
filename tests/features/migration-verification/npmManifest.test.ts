import { describe, expect, it } from 'vitest';
import {
  parseNpmLockfile,
  parseNpmManifest,
  scopeField,
} from '../../../src/features/migration-verification/analysis/ecosystem/npmManifest.js';
import type { AnalysisIssue } from '../../../src/features/migration-verification/analysis/types.js';

function newIssues(): AnalysisIssue[] {
  return [];
}

describe('parseNpmManifest', () => {
  it('extracts direct dependencies from all four scopes with scope labels', () => {
    const text = JSON.stringify({
      name: 'fixture-app',
      version: '1.0.0',
      dependencies: { utilx: '^1.4.2' },
      devDependencies: { vitest: '^2.1.8' },
      optionalDependencies: { fsevents: '^2.3.3' },
      peerDependencies: { react: '>=18' },
    });
    const issues = newIssues();
    const manifest = parseNpmManifest(text, issues);
    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe('fixture-app');
    expect(manifest?.version).toBe('1.0.0');
    expect(issues).toEqual([]);
    expect(manifest?.dependencies).toEqual([
      { name: 'fsevents', declaredRange: '^2.3.3', scope: 'optional' },
      { name: 'react', declaredRange: '>=18', scope: 'peer' },
      { name: 'utilx', declaredRange: '^1.4.2', scope: 'runtime' },
      { name: 'vitest', declaredRange: '^2.1.8', scope: 'dev' },
    ]);
  });

  it('sorts dependencies deterministically regardless of input order', () => {
    const a = parseNpmManifest(
      JSON.stringify({ dependencies: { b: '1.0.0', a: '1.0.0', c: '1.0.0' } }),
      newIssues(),
    );
    const b = parseNpmManifest(
      JSON.stringify({ dependencies: { c: '1.0.0', a: '1.0.0', b: '1.0.0' } }),
      newIssues(),
    );
    expect(a?.dependencies.map((d) => d.name)).toEqual(['a', 'b', 'c']);
    expect(a).toEqual(b);
  });

  it('uses null name/version when the manifest omits them — never invented', () => {
    const manifest = parseNpmManifest(JSON.stringify({ dependencies: {} }), newIssues());
    expect(manifest?.name).toBeNull();
    expect(manifest?.version).toBeNull();
  });

  it('ignores invalid version-range entries with a warning issue', () => {
    const issues = newIssues();
    const manifest = parseNpmManifest(
      JSON.stringify({ dependencies: { utilx: '^1.4.2', broken: 42, empty: '  ' } }),
      issues,
    );
    expect(manifest?.dependencies).toEqual([{ name: 'utilx', declaredRange: '^1.4.2', scope: 'runtime' }]);
    expect(issues.filter((i) => i.code === 'ANALYZER_FAILED' && i.severity === 'warning').length).toBe(2);
  });

  it('ignores a non-object dependency block with a warning issue', () => {
    const issues = newIssues();
    const manifest = parseNpmManifest(JSON.stringify({ dependencies: ['not-an-object'] }), issues);
    expect(manifest?.dependencies).toEqual([]);
    expect(issues.some((i) => i.code === 'ANALYZER_FAILED')).toBe(true);
  });

  it('rejects malformed JSON with an ANALYZER_FAILED issue and null', () => {
    const issues = newIssues();
    expect(parseNpmManifest('{ not json', issues)).toBeNull();
    expect(issues[0].code).toBe('ANALYZER_FAILED');
    expect(issues[0].severity).toBe('error');
  });

  it('rejects a non-object manifest root', () => {
    const issues = newIssues();
    expect(parseNpmManifest('[1,2,3]', issues)).toBeNull();
    expect(issues[0].code).toBe('ANALYZER_FAILED');
  });

  it('maps scopes back to manifest fields for evidence refs', () => {
    expect(scopeField('runtime')).toBe('dependencies');
    expect(scopeField('dev')).toBe('devDependencies');
    expect(scopeField('optional')).toBe('optionalDependencies');
    expect(scopeField('peer')).toBe('peerDependencies');
  });
});

describe('parseNpmLockfile — v2/v3 packages map', () => {
  const text = JSON.stringify({
    name: 'fixture-app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-app', version: '1.0.0' },
      'node_modules/utilx': { version: '1.4.2' },
      'node_modules/left-pad': { version: '1.3.0', dev: true },
      'node_modules/@scope/pkg': { version: '2.0.0' },
      'node_modules/utilx/node_modules/tiny': { version: '0.1.0', optional: true },
      'node_modules/versionless': {},
    },
  });

  it('extracts direct and transitive entries with names, versions and flags', () => {
    const issues = newIssues();
    const locked = parseNpmLockfile(text, issues);
    expect(issues).toEqual([]);
    expect(locked).toHaveLength(5);
    const byName = new Map(locked?.map((p) => [p.name, p]));
    expect(byName.get('utilx')).toMatchObject({ resolvedVersion: '1.4.2', topLevel: true, scope: 'unknown' });
    expect(byName.get('left-pad')).toMatchObject({ resolvedVersion: '1.3.0', topLevel: true, scope: 'dev' });
    expect(byName.get('@scope/pkg')).toMatchObject({ resolvedVersion: '2.0.0', topLevel: true });
    expect(byName.get('tiny')).toMatchObject({ resolvedVersion: '0.1.0', topLevel: false, scope: 'optional' });
  });

  it('records null for an entry without a version — never invented', () => {
    const locked = parseNpmLockfile(text, newIssues());
    expect(locked?.find((p) => p.name === 'versionless')?.resolvedVersion).toBeNull();
  });
});

describe('parseNpmLockfile — v1 dependencies tree', () => {
  const text = JSON.stringify({
    name: 'fixture-app',
    lockfileVersion: 1,
    dependencies: {
      utilx: {
        version: '1.4.2',
        requires: { 'left-pad': '^1.0.0' },
        dependencies: { deep: { version: '0.9.0' } },
      },
      'left-pad': { version: '1.3.0', dev: true },
    },
  });

  it('walks nested dependencies and marks top-level entries', () => {
    const issues = newIssues();
    const locked = parseNpmLockfile(text, issues);
    expect(issues).toEqual([]);
    expect(locked).toHaveLength(3);
    const byName = new Map(locked?.map((p) => [p.name, p]));
    expect(byName.get('utilx')).toMatchObject({ resolvedVersion: '1.4.2', topLevel: true });
    expect(byName.get('left-pad')).toMatchObject({ resolvedVersion: '1.3.0', scope: 'dev' });
    expect(byName.get('deep')).toMatchObject({ resolvedVersion: '0.9.0', topLevel: false });
    expect(byName.get('deep')?.key).toBe('dependencies.utilx.dependencies.deep');
  });
});

describe('parseNpmLockfile — degraded inputs', () => {
  it('rejects malformed JSON with a warning and null', () => {
    const issues = newIssues();
    expect(parseNpmLockfile('{ nope', issues)).toBeNull();
    expect(issues[0].code).toBe('ANALYZER_FAILED');
    expect(issues[0].severity).toBe('warning');
  });

  it('rejects an unrecognized lockfile format with a warning and null', () => {
    const issues = newIssues();
    expect(parseNpmLockfile(JSON.stringify({ lockfileVersion: 99 }), issues)).toBeNull();
    expect(issues.some((i) => i.message.includes('unrecognized'))).toBe(true);
  });
});
