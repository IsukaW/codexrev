import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectSecurityFindings, parseSecurityReport } from '../../../../src/features/action-safety/collectors/securityCollector.js';
import { FRESH, makeTempDir } from '../../../../src/features/action-safety/testing/fixtures.js';

const MTIME = '2025-01-09T00:00:00.000Z';
const parse = (obj: unknown, fail?: 'low' | 'medium' | 'high' | 'critical') =>
  parseSecurityReport('s.json', typeof obj === 'string' ? obj : JSON.stringify(obj), MTIME, fail);

const sarif = (results: unknown[], extra: Record<string, unknown> = {}) => ({
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: FRESH }], results, ...extra }],
});

const sarifResult = (level: string, ruleId: string, uri: string, text = 'problem', props?: unknown) => ({
  ruleId,
  level,
  message: { text },
  locations: [{ physicalLocation: { artifactLocation: { uri } } }],
  ...(props ? { properties: props } : {}),
});

describe('parseSecurityReport', () => {
  it('parses SARIF, keeping tool, severity, rule, file and timestamp', () => {
    const r = parse(sarif([sarifResult('error', 'js/sql-injection', 'src/db.ts', 'SQL built from user input'), sarifResult('note', 'js/style', 'src/a.ts')]));
    expect(r).toMatchObject({ format: 'sarif', tool: 'CodeQL', observedAt: FRESH, observedAtFrom: 'report', totalFindings: 2, status: 'FAIL' });
    expect(r.findings[0]).toMatchObject({ severity: 'high', ruleId: 'js/sql-injection', file: 'src/db.ts', description: 'SQL built from user input', tool: 'CodeQL' });
    expect(r.bySeverity).toMatchObject({ high: 1, low: 1 });
  });

  it('prefers a numeric security-severity score over the SARIF level', () => {
    const r = parse(sarif([sarifResult('warning', 'r', 'f.ts', 'x', { 'security-severity': '9.8' })]));
    expect(r.findings[0].severity).toBe('critical');
  });

  it('parses npm audit output (v7 vulnerabilities and v6 advisories)', () => {
    const v7 = parse({ auditReportVersion: 2, vulnerabilities: { lodash: { severity: 'high' }, minimist: { severity: 'moderate' } } });
    expect(v7).toMatchObject({ format: 'npm_audit', tool: 'npm audit', totalFindings: 2, status: 'FAIL' });
    expect(v7.bySeverity).toMatchObject({ high: 1, medium: 1 });
    const v6 = parse({ advisories: { '1': { severity: 'low', title: 'tiny issue' } } });
    expect(v6).toMatchObject({ format: 'npm_audit', status: 'PASS' });
  });

  it('parses generic findings and treats a missing severity as medium, with a note', () => {
    const r = parse({ tool: 'scanner', timestamp: FRESH, findings: [{ id: 'F1', severity: 'critical', file: 'a.ts', description: 'bad' }, { description: 'no severity' }] });
    expect(r).toMatchObject({ format: 'generic', tool: 'scanner', totalFindings: 2, status: 'FAIL' });
    expect(r.findings[1].severity).toBe('medium');
    expect(r.limitations.join(' ')).toMatch(/no valid severity/);
  });

  it('is PASS with zero findings, but says that only covers what the report scanned', () => {
    const r = parse(sarif([]));
    expect(r.status).toBe('PASS');
    expect(r.totalFindings).toBe(0);
    expect(r.limitations.join(' ')).toMatch(/says nothing about what the report did not scan/);
  });

  it('honours the configured failure threshold', () => {
    const medium = sarif([sarifResult('warning', 'r', 'f.ts')]);
    expect(parse(medium).status).toBe('PASS'); // default threshold: high
    expect(parse(medium, 'medium').status).toBe('FAIL');
    expect(parse(sarif([sarifResult('note', 'r', 'f.ts')]), 'low').status).toBe('FAIL');
  });

  it('treats an empty SARIF file (no runs) as PASS only with an explicit caveat', () => {
    const r = parse({ version: '2.1.0', runs: [] });
    expect(r.limitations.join(' ')).toMatch(/no runs/);
  });

  it('never assumes anything about an unrecognised or malformed report', () => {
    for (const text of ['garbage', '{}', '[]', '{"hello":1}', '']) {
      const r = parse(text);
      expect(r.status, text).toBe('UNKNOWN');
      expect(r.format).toBe('unrecognized');
    }
  });

  it('clips long descriptions and caps how many findings are kept', () => {
    const many = Array.from({ length: 600 }, (_, i) => sarifResult('note', `r${i}`, 'f.ts', 'x'.repeat(1000)));
    const r = parse(sarif(many));
    expect(r.totalFindings).toBe(600);
    expect(r.findings).toHaveLength(500);
    expect(r.findings[0].description.length).toBeLessThanOrEqual(301);
    expect(r.limitations.join(' ')).toMatch(/only the first 500/);
  });

  it('falls back to the file modification time and says so', () => {
    const r = parse({ tool: 'x', findings: [] });
    expect(r.observedAt).toBe(MTIME);
    expect(r.observedAtFrom).toBe('file_modified_time');
  });
});

describe('collectSecurityFindings', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not claim "no vulnerabilities" when no report was supplied', async () => {
    const c = await collectSecurityFindings({ cwd: dir, reportPaths: [] });
    expect(c.reports).toEqual([]);
    expect(c.limitations.join(' ')).toMatch(/does NOT mean no vulnerabilities exist/);
  });

  it('reads reports from inside the project and refuses ones outside it', async () => {
    await fs.writeFile(path.join(dir, 'ok.sarif'), JSON.stringify(sarif([])));
    const outside = await makeTempDir('codexrev-safety-outside-');
    try {
      await fs.writeFile(path.join(outside, 'x.sarif'), JSON.stringify(sarif([])));
      const c = await collectSecurityFindings({ cwd: dir, reportPaths: ['ok.sarif', path.join(outside, 'x.sarif'), 'missing.sarif'] });
      expect(c.reports).toHaveLength(1);
      expect(c.unreadable.map((u) => u.reason)).toEqual(['path is outside the project directory', 'file not found']);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('does not copy source code from a report into the result', async () => {
    const secret = 'AWS_SECRET_ACCESS_KEY=abcdef123456';
    const report = sarif([
      { ruleId: 'r', level: 'error', message: { text: 'hard-coded credential' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { snippet: { text: secret } } } }] },
    ]);
    await fs.writeFile(path.join(dir, 's.sarif'), JSON.stringify(report));
    const c = await collectSecurityFindings({ cwd: dir, reportPaths: ['s.sarif'] });
    expect(JSON.stringify(c)).not.toContain(secret);
  });

  it('caps an inline claim and reports the configured threshold', async () => {
    const c = await collectSecurityFindings({ cwd: dir, reportPaths: [], claim: { status: 'PASS', source: 'verified_system' }, failAtOrAbove: 'medium' });
    expect(c.claim?.item.source).toBe('human_attested');
    expect(c.failAtOrAbove).toBe('medium');
  });
});
