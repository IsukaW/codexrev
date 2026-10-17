import { describe, expect, it } from 'vitest';
import {
  createPathMatcher,
  globToRegExp,
  isAlwaysExcludedPath,
  normalizeRelPath,
} from '../../../src/features/living-spec/tools/pathMatcher.js';

describe('normalizeRelPath', () => {
  it('normalizes windows separators and strips ./ prefixes', () => {
    expect(normalizeRelPath('src\\a.ts')).toBe('src/a.ts');
    expect(normalizeRelPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeRelPath('src/a.ts')).toBe('src/a.ts');
  });
});

describe('globToRegExp / createPathMatcher', () => {
  it('matches ** globs at any depth, including root level', () => {
    const match = createPathMatcher(['**/*.ts']);
    expect(match('a.ts')).toBe(true);
    expect(match('src/deep/a.ts')).toBe(true);
    expect(match('src/a.js')).toBe(false);
  });

  it('keeps * and ? inside one path segment', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false);
    expect(globToRegExp('src/a?.ts').test('src/ab.ts')).toBe(true);
  });

  it('expands {a,b} groups', () => {
    const match = createPathMatcher(['**/*.{ts,tsx}']);
    expect(match('src/a.ts')).toBe(true);
    expect(match('src/a.tsx')).toBe(true);
    expect(match('src/a.js')).toBe(false);
  });

  it('matches any of several globs', () => {
    const match = createPathMatcher(['src/**', 'test/**']);
    expect(match('src/x/a.ts')).toBe(true);
    expect(match('test/a.ts')).toBe(true);
    expect(match('other/a.ts')).toBe(false);
  });
});

describe('isAlwaysExcludedPath', () => {
  it('excludes node_modules, dist, .git and .codexrev at any depth', () => {
    expect(isAlwaysExcludedPath('node_modules/x/a.ts')).toBe(true);
    expect(isAlwaysExcludedPath('packages/x/dist/a.ts')).toBe(true);
    expect(isAlwaysExcludedPath('.git/config')).toBe(true);
    expect(isAlwaysExcludedPath('.codexrev/living-spec/config.json')).toBe(true);
  });

  it('keeps ordinary source paths', () => {
    expect(isAlwaysExcludedPath('src/a.ts')).toBe(false);
    expect(isAlwaysExcludedPath('distributed/a.ts')).toBe(false);
    expect(isAlwaysExcludedPath('')).toBe(false);
  });
});
