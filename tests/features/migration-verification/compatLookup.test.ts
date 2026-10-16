import { describe, expect, it } from 'vitest';
import { lookupCompatibility } from '../../../src/features/migration-verification/analysis/compat/lookup.js';
import { BUILTIN_COMPAT_CATALOG } from '../../../src/features/migration-verification/analysis/compat/builtinCatalog.js';
import { parseExactVersion, compareExact } from '../../../src/features/migration-verification/analysis/compat/exactVersion.js';

describe('exact version utilities', () => {
  it('parses exact versions (with and without v prefix)', () => {
    expect(parseExactVersion('19.0.0')).toEqual([19, 0, 0]);
    expect(parseExactVersion('v2.5.3')).toEqual([2, 5, 3]);
  });

  it('returns null for ranges, prereleases and build metadata — never guessed', () => {
    expect(parseExactVersion('^19.0.0')).toBeNull();
    expect(parseExactVersion('~1.2.0')).toBeNull();
    expect(parseExactVersion('19.0.0-rc.1')).toBeNull();
    expect(parseExactVersion('19.0.0+build.5')).toBeNull();
    expect(parseExactVersion('latest')).toBeNull();
    expect(parseExactVersion('')).toBeNull();
  });

  it('compares numerically, not lexicographically', () => {
    expect(compareExact([9, 0, 0], [10, 0, 0])).toBe(-1);
    expect(compareExact([2, 5, 0], [2, 5, 0])).toBe(0);
  });
});

describe('lookupCompatibility — matching and provenance', () => {
  it('returns a confirmed finding for a matching package and affected version', () => {
    const r = lookupCompatibility({ package: 'react-dom', targetVersion: '19.1.0' });
    expect(r.verdict).toBe('affected');
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.id).toBe('react-dom-19-removed-render');
    expect(f.kind).toBe('removed-api');
    expect(f.dependency).toBe('react-dom');
    expect(f.api).toBe('ReactDOM.render');
    expect(f.status).toBe('confirmed');
    expect(f.evidence.status).toBe('present');
    expect(f.evidence.quality).toBe('exact');
    expect(f.evidence.source?.kind).toBe('builtin-catalog');
    expect(f.evidence.source?.uri).toContain('https://react.dev/');
    expect(f.message).toContain('createRoot'); // migration guidance surfaced
    expect(r.issues).toEqual([]);
  });

  it('surfaces lru-cache v7+ breaking changes (benchmark-relevant)', () => {
    const r = lookupCompatibility({ package: 'lru-cache', targetVersion: '10.2.0' });
    expect(r.verdict).toBe('affected');
    expect(r.findings[0].id).toBe('lru-cache-7-renamed-options');
    expect(r.findings[0].evidence.source?.uri).toContain('node-lru-cache');
  });

  it('surfaces highlight.js v11 deprecation', () => {
    const r = lookupCompatibility({ package: 'highlight.js', targetVersion: '11.9.0' });
    expect(r.findings[0].kind).toBe('deprecated-api');
    expect(r.findings[0].status).toBe('confirmed');
  });
});

describe('lookupCompatibility — version boundaries', () => {
  it('treats the lower boundary as inclusive (19.0.0 is affected)', () => {
    const r = lookupCompatibility({ package: 'react-dom', targetVersion: '19.0.0' });
    expect(r.verdict).toBe('affected');
  });

  it('does not report affected findings below the boundary (unaffected 18.3.1)', () => {
    const r = lookupCompatibility({ package: 'react-dom', targetVersion: '18.3.1' });
    expect(r.verdict).toBe('no-known-issues');
    expect(r.findings).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('does not report lru-cache findings below v7', () => {
    const r = lookupCompatibility({ package: 'lru-cache', targetVersion: '6.5.2' });
    expect(r.verdict).toBe('no-known-issues');
  });

  it('treats the upper boundary as exclusive (affectedUntil not included)', () => {
    const catalog = [
      {
        id: 'demo-2to3',
        package: 'demo',
        category: 'breaking-change',
        severity: 'medium',
        affectedFrom: '2.0.0',
        affectedUntil: '3.0.0',
        description: 'demo breakage in 2.x',
        source: { kind: 'release-notes', uri: 'https://example.com/demo/notes' },
        confidence: 'high',
        reviewStatus: 'verified',
      },
    ];
    expect(lookupCompatibility({ package: 'demo', targetVersion: '2.5.0' }, catalog).verdict).toBe('affected');
    expect(lookupCompatibility({ package: 'demo', targetVersion: '1.9.9' }, catalog).verdict).toBe('no-known-issues');
    expect(lookupCompatibility({ package: 'demo', targetVersion: '3.0.0' }, catalog).verdict).toBe('no-known-issues');
  });
});

describe('lookupCompatibility — unknown and insufficient evidence', () => {
  it('reports an unknown package as no-known-issues with a warning — never confirmed-safe', () => {
    const r = lookupCompatibility({ package: 'left-pad', targetVersion: '2.0.0' });
    expect(r.verdict).toBe('no-known-issues');
    expect(r.findings).toEqual([]);
    const issue = r.issues.find((i) => i.code === 'COMPAT_DATA_UNAVAILABLE');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('NOT evidence of compatibility');
  });

  it('does not silently evaluate range targets — unresolved, not confirmed', () => {
    const r = lookupCompatibility({ package: 'react-dom', targetVersion: '^19.0.0' });
    expect(r.verdict).toBe('unresolved');
    expect(r.findings[0].status).toBe('unresolved');
    expect(r.findings[0].evidence.status).toBe('missing');
    expect(r.issues.some((i) => i.code === 'COMPAT_VERSION_UNEVALUATED')).toBe(true);
  });

  it('treats prerelease targets as unresolved', () => {
    const r = lookupCompatibility({ package: 'react-dom', targetVersion: '19.0.0-rc.1' });
    expect(r.verdict).toBe('unresolved');
  });

  it('keeps unverified entries unresolved even in range', () => {
    const catalog = [
      {
        id: 'demo-unverified',
        package: 'demo',
        category: 'breaking-change',
        severity: 'low',
        affectedFrom: '1.0.0',
        description: 'unverified claim',
        source: { kind: 'release-notes', uri: 'http://example.com/notes' },
        confidence: 'low',
        reviewStatus: 'unverified',
      },
    ];
    const r = lookupCompatibility({ package: 'demo', targetVersion: '1.2.0' }, catalog);
    expect(r.verdict).toBe('unresolved');
    expect(r.findings[0].status).toBe('unresolved');
  });
});

describe('lookupCompatibility — malformed catalog data', () => {
  it('skips malformed entries with a warning and still processes valid ones', () => {
    const catalog = [
      'not-an-object',
      { id: 'bad', package: 'demo', category: 'nope', severity: 'low', affectedFrom: '1.0.0', description: 'x', source: { kind: 'changelog', uri: 'https://x' }, confidence: 'low', reviewStatus: 'unverified' },
      { id: 'bad-version', package: 'demo', category: 'breaking-change', severity: 'low', affectedFrom: '^1.0.0', description: 'x', source: { kind: 'changelog', uri: 'https://x' }, confidence: 'low', reviewStatus: 'unverified' },
      {
        id: 'demo-valid',
        package: 'demo',
        category: 'deprecated-api',
        severity: 'info',
        affectedFrom: '2.0.0',
        description: 'valid entry',
        source: { kind: 'official-docs', uri: 'https://example.com/demo' },
        confidence: 'medium',
        reviewStatus: 'verified',
      },
    ];
    const r = lookupCompatibility({ package: 'demo', targetVersion: '2.1.0' }, catalog);
    expect(r.verdict).toBe('affected');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].id).toBe('demo-valid');
    expect(r.issues.filter((i) => i.code === 'ANALYZER_FAILED').length).toBe(3);
  });

  it('rejects a verified entry without an https source', () => {
    const catalog = [
      {
        id: 'demo-no-https',
        package: 'demo',
        category: 'breaking-change',
        severity: 'low',
        affectedFrom: '1.0.0',
        description: 'claim without https source',
        source: { kind: 'changelog', uri: 'http://insecure.example.com/x' },
        confidence: 'low',
        reviewStatus: 'verified',
      },
    ];
    const r = lookupCompatibility({ package: 'demo', targetVersion: '1.0.0' }, catalog);
    expect(r.findings).toEqual([]);
    expect(r.issues.some((i) => i.code === 'ANALYZER_FAILED' && i.message.includes('https://'))).toBe(true);
  });
});

describe('lookupCompatibility — determinism and catalog integrity', () => {
  it('produces byte-identical results across repeated calls', () => {
    const a = JSON.stringify(lookupCompatibility({ package: 'lru-cache', targetVersion: '10.2.0' }));
    const b = JSON.stringify(lookupCompatibility({ package: 'lru-cache', targetVersion: '10.2.0' }));
    expect(a).toBe(b);
  });

  it('every built-in catalog entry passes validation', () => {
    for (const entry of BUILTIN_COMPAT_CATALOG) {
      const r = lookupCompatibility({ package: entry.package, targetVersion: entry.affectedFrom });
      expect(r.issues.filter((i) => i.code === 'ANALYZER_FAILED')).toEqual([]);
    }
  });
});
