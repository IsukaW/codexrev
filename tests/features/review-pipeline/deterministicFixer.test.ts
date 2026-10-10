import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractTsCode,
  SUPPORTED_TS_CODES,
  tryDeterministicFix,
} from '../../../src/features/review-pipeline/tools/deterministicFixer.js';
import type { Finding } from '../../../src/features/review-pipeline/roles/roleContract.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-detfix-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function baseFinding(overrides: Partial<Finding>): Finding {
  return {
    id: 'build-1',
    severity: 'high',
    file: 'a.ts',
    lineStart: 1,
    lineEnd: 1,
    description: 'placeholder',
    ...overrides,
  };
}

describe('extractTsCode', () => {
  it('extracts a TS code from a Build-role-shaped description', () => {
    expect(extractTsCode(baseFinding({ description: "tsc TS2339: Property 'foo' does not exist." }))).toBe('TS2339');
  });

  it('returns null when no TS code is present', () => {
    expect(extractTsCode(baseFinding({ description: 'SQL injection via string concatenation.' }))).toBeNull();
  });
});

describe('SUPPORTED_TS_CODES', () => {
  it('covers the Section 2 seed codes', () => {
    expect(SUPPORTED_TS_CODES).toEqual(expect.arrayContaining(['TS7006', 'TS2307', 'TS2339']));
  });
});

describe('tryDeterministicFix — TS7006 (implicit any)', () => {
  it('adds an explicit ": any" to the named parameter', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'export function greet(name) {\n  return `hi ${name}`;\n}\n', 'utf-8');
    const finding = baseFinding({
      description: "tsc TS7006: Parameter 'name' implicitly has an 'any' type.",
      lineStart: 1,
      lineEnd: 1,
    });
    const fix = await tryDeterministicFix(finding, tmpRoot);
    expect(fix).not.toBeNull();
    expect(fix?.oldString).toBe('export function greet(name) {');
    expect(fix?.newString).toBe('export function greet(name: any) {');
    expect(fix?.description).toMatch(/TS7006/);
  });

  it('does not re-match a parameter that already has a type annotation', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'export function greet(name: string) {\n  return name;\n}\n', 'utf-8');
    const finding = baseFinding({ description: "tsc TS7006: Parameter 'name' implicitly has an 'any' type.", lineStart: 1, lineEnd: 1 });
    const fix = await tryDeterministicFix(finding, tmpRoot);
    expect(fix).toBeNull();
  });
});

describe('tryDeterministicFix — TS2307 (missing module extension)', () => {
  it('appends .js to a relative import with no extension', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), "import { helper } from './utils';\n", 'utf-8');
    const finding = baseFinding({
      description: "tsc TS2307: Cannot find module './utils' or its corresponding type declarations.",
      lineStart: 1,
      lineEnd: 1,
    });
    const fix = await tryDeterministicFix(finding, tmpRoot);
    expect(fix?.newString).toBe("import { helper } from './utils.js';");
  });

  it('does not fire for a non-relative (bare package) specifier', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), "import { z } from 'zod';\n", 'utf-8');
    const finding = baseFinding({
      description: "tsc TS2307: Cannot find module 'zod' or its corresponding type declarations.",
      lineStart: 1,
      lineEnd: 1,
    });
    expect(await tryDeterministicFix(finding, tmpRoot)).toBeNull();
  });

  it('does not fire when the specifier already has an extension', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), "import { helper } from './utils.js';\n", 'utf-8');
    const finding = baseFinding({
      description: "tsc TS2307: Cannot find module './utils.js' or its corresponding type declarations.",
      lineStart: 1,
      lineEnd: 1,
    });
    expect(await tryDeterministicFix(finding, tmpRoot)).toBeNull();
  });
});

describe('tryDeterministicFix — TS2339 (Did you mean typo)', () => {
  it('applies the compiler-suggested replacement', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'const x = user.nmae;\n', 'utf-8');
    const finding = baseFinding({
      description: "tsc TS2339: Property 'nmae' does not exist on type 'User'. Did you mean 'name'?",
      lineStart: 1,
      lineEnd: 1,
    });
    const fix = await tryDeterministicFix(finding, tmpRoot);
    expect(fix?.newString).toBe('const x = user.name;');
  });

  it('does not fire without a "Did you mean" hint — too risky to guess', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'const x = user.bogus;\n', 'utf-8');
    const finding = baseFinding({
      description: "tsc TS2339: Property 'bogus' does not exist on type 'User'.",
      lineStart: 1,
      lineEnd: 1,
    });
    expect(await tryDeterministicFix(finding, tmpRoot)).toBeNull();
  });
});

describe('tryDeterministicFix — fallthrough cases', () => {
  it('returns null for an unrecognized TS code', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'const x = 1;\n', 'utf-8');
    const finding = baseFinding({ description: 'tsc TS9999: some future error code.', lineStart: 1, lineEnd: 1 });
    expect(await tryDeterministicFix(finding, tmpRoot)).toBeNull();
  });

  it('returns null for a non-Build finding (no TS code at all)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'const x = 1;\n', 'utf-8');
    const finding = baseFinding({ description: 'Hardcoded credential found.', lineStart: 1, lineEnd: 1 });
    expect(await tryDeterministicFix(finding, tmpRoot)).toBeNull();
  });

  it('returns null when the finding points past the end of the file', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.ts'), 'const x = 1;\n', 'utf-8');
    const finding = baseFinding({ description: "tsc TS7006: Parameter 'x' implicitly has an 'any' type.", lineStart: 999, lineEnd: 999 });
    expect(await tryDeterministicFix(finding, tmpRoot)).toBeNull();
  });

  it('returns null when the file does not exist', async () => {
    const finding = baseFinding({ file: 'missing.ts', description: "tsc TS7006: Parameter 'x' implicitly has an 'any' type." });
    expect(await tryDeterministicFix(finding, tmpRoot)).toBeNull();
  });
});
