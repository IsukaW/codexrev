import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAnalyzeRequest } from '../../../src/features/migration-verification/analysis/validateRequest.js';
import { RequestValidationError } from '../../../src/features/migration-verification/analysis/issues.js';
import type { AnalysisIssue } from '../../../src/features/migration-verification/analysis/types.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-mv-req-'));
  tmpRoot = await fs.realpath(raw);
  await fs.mkdir(path.join(tmpRoot, 'src'));
  await fs.writeFile(path.join(tmpRoot, 'src', 'pricing.ts'), 'export const x = 1;\n');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function baseRequest(): Record<string, unknown> {
  return {
    projectPath: tmpRoot,
    technology: 'node',
    dependencyName: 'utilx',
    currentVersion: '1.4.2',
    targetVersion: '2.0.0',
    migration: { kind: 'api-rename', from: 'formatPrice', to: 'formatMoney' },
  };
}

async function expectIssues(input: unknown): Promise<ReadonlyArray<AnalysisIssue>> {
  try {
    await validateAnalyzeRequest(input);
  } catch (err) {
    if (err instanceof RequestValidationError) return err.issues;
    throw err;
  }
  throw new Error('expected RequestValidationError to be thrown');
}

describe('validateAnalyzeRequest — valid input', () => {
  it('accepts a minimal valid Node.js request and fills optional defaults', async () => {
    const req = await validateAnalyzeRequest(baseRequest());
    expect(req.technology).toBe('node');
    expect(req.dependencyName).toBe('utilx');
    expect(req.currentVersion).toBe('1.4.2');
    expect(req.targetVersion).toBe('2.0.0');
    expect(req.include).toEqual(['**/*.{js,jsx,ts,tsx,mjs,cjs}']);
    expect(req.exclude).toContain('**/node_modules/**');
    expect(req.outputFormat).toBe('json');
  });

  it('accepts a JavaScript/TypeScript api-rename migration and preserves it', async () => {
    const req = await validateAnalyzeRequest(baseRequest());
    expect(req.migration).toEqual({ kind: 'api-rename', from: 'formatPrice', to: 'formatMoney' });
  });

  it('accepts a dependency-upgrade migration', async () => {
    const input = baseRequest();
    input.migration = { kind: 'dependency-upgrade', package: 'utilx' };
    const req = await validateAnalyzeRequest(input);
    expect(req.migration).toEqual({ kind: 'dependency-upgrade', package: 'utilx' });
  });

  it('accepts semver syntax variants', async () => {
    const input = baseRequest();
    input.currentVersion = '^1.4.2';
    input.targetVersion = 'v2.0.0-beta.1+build.5';
    const req = await validateAnalyzeRequest(input);
    expect(req.currentVersion).toBe('^1.4.2');
    expect(req.targetVersion).toBe('v2.0.0-beta.1+build.5');
  });

  it('accepts optional compat data, rules and an outPath outside the project', async () => {
    const compat = path.join(os.tmpdir(), `codexrev-mv-compat-${Date.now()}.json`);
    await fs.writeFile(compat, '[]');
    try {
      const input = baseRequest();
      input.compatDataPath = compat;
      input.rulesPaths = [compat];
      input.outPath = path.join(tmpRoot, '..', 'outside-artifacts');
      input.include = ['src/**/*.ts'];
      input.outputFormat = 'markdown';
      const req = await validateAnalyzeRequest(input);
      expect(req.compatDataPath).toBe(compat);
      expect(req.rulesPaths).toEqual([compat]);
      expect(req.outputFormat).toBe('markdown');
      expect(req.include).toEqual(['src/**/*.ts']);
    } finally {
      await fs.rm(compat, { force: true });
    }
  });

  it('normalizes relative paths to absolute', async () => {
    const input = baseRequest();
    input.projectPath = '.';
    const req = await validateAnalyzeRequest(input);
    expect(path.isAbsolute(req.projectPath)).toBe(true);
  });
});

describe('validateAnalyzeRequest — missing required fields', () => {
  const fields = ['projectPath', 'technology', 'dependencyName', 'currentVersion', 'targetVersion', 'migration'];
  for (const field of fields) {
    it(`rejects a request with missing ${field}`, async () => {
      const input = baseRequest();
      delete input[field];
      const issues = await expectIssues(input);
      expect(
        issues.some((i) => i.code === 'REQUEST_INVALID' && i.message.includes(field)),
      ).toBe(true);
    });
  }

  it('rejects empty-string required fields', async () => {
    const input = baseRequest();
    input.dependencyName = '   ';
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.code === 'REQUEST_INVALID' && i.message.includes('dependencyName'))).toBe(true);
  });

  it('rejects a non-object request', async () => {
    const issues = await expectIssues('not a request');
    expect(issues[0].code).toBe('REQUEST_INVALID');
  });
});

describe('validateAnalyzeRequest — invalid project paths', () => {
  it('rejects a projectPath that does not exist', async () => {
    const input = baseRequest();
    input.projectPath = path.join(tmpRoot, 'no-such-dir');
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.code === 'REQUEST_INVALID' && i.message.includes('does not exist'))).toBe(true);
  });

  it('rejects a projectPath that is a file, not a directory', async () => {
    const input = baseRequest();
    input.projectPath = path.join(tmpRoot, 'src', 'pricing.ts');
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.code === 'REQUEST_INVALID' && i.message.includes('must be a directory'))).toBe(true);
  });
});

describe('validateAnalyzeRequest — unsupported technologies', () => {
  for (const tech of ['java', 'python', 'go']) {
    it(`rejects technology '${tech}' as ECOSYSTEM_UNSUPPORTED`, async () => {
      const input = baseRequest();
      input.technology = tech;
      const issues = await expectIssues(input);
      const hit = issues.find((i) => i.code === 'ECOSYSTEM_UNSUPPORTED');
      expect(hit).toBeDefined();
      expect(hit?.message).toContain('future scope');
    });
  }

  it('rejects a non-string technology as REQUEST_INVALID', async () => {
    const input = baseRequest();
    input.technology = 42;
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.code === 'REQUEST_INVALID' && i.message.includes('technology'))).toBe(true);
  });
});

describe('validateAnalyzeRequest — version syntax', () => {
  for (const bad of ['1.4', 'latest', '1.2.3.4', 'abc', '^']) {
    it(`rejects invalid version string '${bad}'`, async () => {
      const input = baseRequest();
      input.currentVersion = bad;
      const issues = await expectIssues(input);
      expect(issues.some((i) => i.code === 'VERSION_INVALID' && i.message.includes('currentVersion'))).toBe(true);
    });
  }

  it('rejects equal current and target versions', async () => {
    const input = baseRequest();
    input.targetVersion = input.currentVersion;
    const issues = await expectIssues(input);
    expect(
      issues.some((i) => i.code === 'VERSION_INVALID' && i.message.includes('must differ')),
    ).toBe(true);
  });

  it('does not perform version comparison — differing syntax is accepted', async () => {
    const input = baseRequest();
    input.currentVersion = '1.4.2';
    input.targetVersion = '^1.4.2';
    const req = await validateAnalyzeRequest(input);
    expect(req.currentVersion).toBe('1.4.2');
  });
});

describe('validateAnalyzeRequest — invalid migration configuration', () => {
  it('rejects a non-object migration', async () => {
    const input = baseRequest();
    input.migration = 'rename';
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.message.includes('migration'))).toBe(true);
  });

  it('rejects an unknown migration kind', async () => {
    const input = baseRequest();
    input.migration = { kind: 'framework-swap', from: 'a', to: 'b' };
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.message.includes('api-rename'))).toBe(true);
  });

  it('rejects api-rename with a missing field', async () => {
    const input = baseRequest();
    input.migration = { kind: 'api-rename', from: 'formatPrice' };
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.message.includes('migration.to'))).toBe(true);
  });

  it('rejects api-rename where from equals to', async () => {
    const input = baseRequest();
    input.migration = { kind: 'api-rename', from: 'formatPrice', to: 'formatPrice' };
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.message.includes('must differ'))).toBe(true);
  });

  it('rejects api-rename with non-identifier names', async () => {
    const input = baseRequest();
    input.migration = { kind: 'api-rename', from: 'format-price', to: '2formatMoney' };
    const issues = await expectIssues(input);
    expect(issues.filter((i) => i.message.includes('identifier')).length).toBe(2);
  });

  it('rejects dependency-upgrade without a package', async () => {
    const input = baseRequest();
    input.migration = { kind: 'dependency-upgrade' };
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.message.includes('migration.package'))).toBe(true);
  });
});

describe('validateAnalyzeRequest — read-only guarantee and optional paths', () => {
  it('rejects an outPath inside the project', async () => {
    const input = baseRequest();
    input.outPath = path.join(tmpRoot, 'reports');
    const issues = await expectIssues(input);
    expect(
      issues.some((i) => i.code === 'REQUEST_INVALID' && i.message.includes('outside projectPath')),
    ).toBe(true);
  });

  it('rejects an outPath equal to the project', async () => {
    const input = baseRequest();
    input.outPath = tmpRoot;
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.message.includes('outside projectPath'))).toBe(true);
  });

  it('rejects a missing compatDataPath file', async () => {
    const input = baseRequest();
    input.compatDataPath = path.join(tmpRoot, 'no-such-compat.json');
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.message.includes('compatDataPath'))).toBe(true);
  });

  it('rejects a missing rulesPaths entry', async () => {
    const input = baseRequest();
    input.rulesPaths = [path.join(tmpRoot, 'no-such-rules.json')];
    const issues = await expectIssues(input);
    expect(issues.some((i) => i.message.includes('rulesPaths'))).toBe(true);
  });

  it('collects multiple issues in one rejection', async () => {
    const input = baseRequest();
    input.currentVersion = '1.4';
    input.migration = { kind: 'api-rename', from: 'a' };
    const issues = await expectIssues(input);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});
