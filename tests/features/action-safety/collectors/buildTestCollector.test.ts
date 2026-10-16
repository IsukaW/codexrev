import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectBuildTests, parseBuildTestReport } from '../../../../src/features/action-safety/collectors/buildTestCollector.js';
import { FRESH, makeTempDir } from '../../../../src/features/action-safety/testing/fixtures.js';

const MTIME = '2025-01-09T00:00:00.000Z';
const parse = (obj: unknown) => parseBuildTestReport('r.json', typeof obj === 'string' ? obj : JSON.stringify(obj), MTIME);

describe('parseBuildTestReport: formats', () => {
  it('parses a generic passing report and keeps tool, kind, timestamp and counts', () => {
    const r = parse({ tool: 'vitest', kind: 'test', status: 'PASS', timestamp: FRESH, summary: { total: 10, passed: 10, failed: 0, skipped: 0 } });
    expect(r).toMatchObject({ format: 'generic', tool: 'vitest', kind: 'test', status: 'PASS', observedAt: FRESH, observedAtFrom: 'report' });
    expect(r.summary).toEqual({ total: 10, passed: 10, failed: 0, skipped: 0 });
  });

  it('parses a generic failing build report', () => {
    expect(parse({ tool: 'tsc', kind: 'build', status: 'failed', timestamp: FRESH })).toMatchObject({ status: 'FAIL', kind: 'build' });
  });

  it('maps an unrecognised status word to UNKNOWN, never PASS', () => {
    expect(parse({ tool: 'x', status: 'sorta-ok', timestamp: FRESH }).status).toBe('UNKNOWN');
  });

  it('does not let a "pass" status hide failures counted in the summary', () => {
    const r = parse({ tool: 'x', status: 'pass', timestamp: FRESH, summary: { total: 5, passed: 4, failed: 1 } });
    expect(r.status).toBe('FAIL');
    expect(r.limitations.join(' ')).toMatch(/counts failures/);
  });

  it('parses Jest/Vitest JSON: pass, fail, and zero tests', () => {
    const base = { numTotalTests: 4, numPassedTests: 4, numFailedTests: 0, numPendingTests: 0, success: true, startTime: Date.parse(FRESH) };
    expect(parse(base)).toMatchObject({ format: 'jest_json', status: 'PASS', observedAt: FRESH, observedAtFrom: 'report' });
    expect(parse({ ...base, numPassedTests: 3, numFailedTests: 1, success: false }).status).toBe('FAIL');
    const empty = parse({ ...base, numTotalTests: 0, numPassedTests: 0 });
    expect(empty.status).toBe('UNKNOWN');
    expect(empty.limitations.join(' ')).toMatch(/zero tests/);
  });

  it('parses JUnit XML: pass and fail, from testsuites totals', () => {
    const ok = '<?xml version="1.0"?><testsuites tests="6" failures="0" errors="0"><testsuite name="a" tests="6" timestamp="2025-01-10T06:00:00"/></testsuites>';
    const bad = '<testsuites tests="6" failures="1" errors="1"><testsuite name="a" tests="6"/></testsuites>';
    expect(parse(ok)).toMatchObject({ format: 'junit_xml', status: 'PASS', summary: { total: 6, failed: 0 } });
    expect(parse(bad)).toMatchObject({ status: 'FAIL', summary: { failed: 2 } });
  });

  it('never assumes anything about an unrecognised or malformed report', () => {
    for (const text of ['not json at all', '{}', '[]', '{"hello":"world"}', '']) {
      const r = parse(text);
      expect(r.status, text).toBe('UNKNOWN');
      expect(r.format).toBe('unrecognized');
    }
  });

  it('uses the file modification time when the report has no timestamp, and says so', () => {
    const r = parse({ tool: 'x', status: 'pass' });
    expect(r.observedAt).toBe(MTIME);
    expect(r.observedAtFrom).toBe('file_modified_time');
    expect(r.limitations.join(' ')).toMatch(/modification time/);
  });

  it('reports no timestamp at all when neither exists', () => {
    const r = parseBuildTestReport('r.json', JSON.stringify({ tool: 'x', status: 'pass' }), undefined);
    expect(r.observedAt).toBeUndefined();
    expect(r.observedAtFrom).toBe('none');
  });
});

describe('collectBuildTests: files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const put = (rel: string, text: string) => fs.writeFile(path.join(dir, rel), text, 'utf-8');

  it('reads several reports and keeps them separate', async () => {
    await put('ok.json', JSON.stringify({ tool: 'vitest', status: 'pass', timestamp: FRESH }));
    await put('bad.json', JSON.stringify({ tool: 'tsc', kind: 'build', status: 'fail', timestamp: FRESH }));
    const c = await collectBuildTests({ cwd: dir, reportPaths: ['ok.json', 'bad.json'] });
    expect(c.reports.map((r) => [r.tool, r.status])).toEqual([['vitest', 'PASS'], ['tsc', 'FAIL']]);
    expect(c.unreadable).toEqual([]);
  });

  it('reports a missing file as unreadable, not as a result', async () => {
    const c = await collectBuildTests({ cwd: dir, reportPaths: ['nope.json'] });
    expect(c.reports).toEqual([]);
    expect(c.unreadable).toEqual([{ file: 'nope.json', reason: 'file not found' }]);
    expect(c.limitations.join(' ')).toMatch(/was not read: file not found/);
  });

  it('says plainly when nothing was supplied', async () => {
    const c = await collectBuildTests({ cwd: dir, reportPaths: [] });
    expect(c.reports).toEqual([]);
    expect(c.claim).toBeUndefined();
    expect(c.limitations.join(' ')).toMatch(/no build\/test report or claim was supplied/);
  });

  it('refuses paths outside the project directory, including ../ and absolute paths', async () => {
    const outside = await makeTempDir('codexrev-safety-outside-');
    try {
      await fs.writeFile(path.join(outside, 'secret.json'), JSON.stringify({ tool: 'x', status: 'pass', timestamp: FRESH }));
      const rel = path.relative(dir, path.join(outside, 'secret.json'));
      const c = await collectBuildTests({ cwd: dir, reportPaths: [rel, path.join(outside, 'secret.json')] });
      expect(c.reports).toEqual([]);
      expect(c.unreadable.map((u) => u.reason)).toEqual(['path is outside the project directory', 'path is outside the project directory']);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlink that points outside the project', async () => {
    const outside = await makeTempDir('codexrev-safety-outside-');
    try {
      await fs.writeFile(path.join(outside, 'target.json'), JSON.stringify({ tool: 'x', status: 'pass', timestamp: FRESH }));
      try {
        await fs.symlink(path.join(outside, 'target.json'), path.join(dir, 'link.json'));
      } catch {
        return; // creating symlinks needs privileges on some systems; nothing to test then
      }
      const c = await collectBuildTests({ cwd: dir, reportPaths: ['link.json'] });
      expect(c.reports).toEqual([]);
      expect(c.unreadable[0].reason).toBe('path is outside the project directory');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses directories and oversized files, and survives malformed content', async () => {
    await fs.mkdir(path.join(dir, 'adir'));
    await put('big.json', 'x'.repeat(5_000_001));
    await put('broken.json', '{ "tool": ');
    const c = await collectBuildTests({ cwd: dir, reportPaths: ['adir', 'big.json', 'broken.json'] });
    expect(c.unreadable.map((u) => u.reason)).toEqual(['not a regular file', 'file is larger than the 5000000-byte limit']);
    expect(c.reports).toHaveLength(1);
    expect(c.reports[0]).toMatchObject({ format: 'unrecognized', status: 'UNKNOWN' });
  });

  it('rejects paths with a NUL byte safely', async () => {
    const c = await collectBuildTests({ cwd: dir, reportPaths: ['bad\0name.json'] });
    expect(c.reports).toEqual([]);
    expect(c.unreadable).toHaveLength(1);
  });

  it('caps an inline claim at human_attested and notes it', async () => {
    const c = await collectBuildTests({ cwd: dir, reportPaths: [], claim: { status: 'PASS', source: 'verified_system', observedAt: FRESH } });
    expect(c.claim?.item.source).toBe('human_attested');
    expect(c.claim?.trusted).toBe(true);
    expect(c.claim?.limitations.join(' ')).toMatch(/cannot be verified from an input file/);
  });

  it('treats a claim with no source as self-declared and untrusted', async () => {
    const c = await collectBuildTests({ cwd: dir, reportPaths: [], claim: { status: 'PASS' } });
    expect(c.claim?.item.source).toBe('self_declared');
    expect(c.claim?.trusted).toBe(false);
  });

  it('never runs anything: a report that names a command only gets parsed', async () => {
    await put('r.json', JSON.stringify({ tool: 'x; touch RAN.txt', status: 'pass', timestamp: FRESH, command: 'touch RAN.txt' }));
    await collectBuildTests({ cwd: dir, reportPaths: ['r.json'] });
    await expect(fs.access(path.join(dir, 'RAN.txt'))).rejects.toThrow();
  });
});
