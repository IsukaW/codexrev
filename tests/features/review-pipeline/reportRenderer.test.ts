import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildChangeCoverageMap,
  defaultReportsDir,
  fixReportPath,
  formatTimestampForFilename,
  renderFixReportHtml,
  renderReportHtml,
  renderReportJson,
  renderReportMarkdown,
  reportPaths,
  saveFixReport,
  saveReport,
  type FixReportData,
  type ReportData,
} from '../../../src/features/review-pipeline/cli/reportRenderer.js';
import { resolve } from '../../../src/features/review-pipeline/pipeline/resolverEngine.js';
import { DEFAULT_SETTINGS } from '../../../src/config/schema.js';
import type { ParsedDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { RoleOutput } from '../../../src/features/review-pipeline/roles/roleContract.js';
import type { FixAttemptRecord } from '../../../src/features/review-pipeline/pipeline/breakerBuilderLoop.js';

const WEIGHTS = DEFAULT_SETTINGS.reviewPipeline.resolverWeights;

const DIFF_WITH_FINDING: ParsedDiff = {
  ref: 'staged',
  raw: 'diff --git a/app.ts b/app.ts\n',
  files: [
    {
      path: 'app.ts',
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { type: 'context', content: 'function getUser(id) {', oldLineNumber: 1, newLineNumber: 1 },
            { type: 'add', content: '  const q = `SELECT * FROM users WHERE id=${id}`;', newLineNumber: 2 },
            { type: 'add', content: '  return db.query(q);', newLineNumber: 3 },
          ],
        },
      ],
    },
  ],
};

function roleOutputs(): Readonly<Partial<Record<RoleOutput['role'], RoleOutput>>> {
  return {
    ba: { role: 'ba', verdict: 'pass', findings: [], summary: 'No drift.', confidence: 0.9 },
    dev: { role: 'dev', verdict: 'pass', findings: [], summary: 'Looks fine structurally.', confidence: 0.9 },
    build: { role: 'build', verdict: 'pass', findings: [], summary: 'No build config.', confidence: 1 },
    sec: {
      role: 'sec',
      verdict: 'block',
      findings: [
        {
          id: 'sec-1',
          severity: 'critical',
          cwe: 'CWE-89',
          file: 'app.ts',
          lineStart: 2,
          lineEnd: 2,
          description: 'SQL injection via unsanitized <id> & "quotes"',
          suggestedFix: 'Use a parameterized query.',
        },
      ],
      summary: 'Found a SQL injection vector.',
      confidence: 0.95,
    },
    qa: { role: 'qa', verdict: 'pass', findings: [], summary: 'Nothing untested that stands out.', confidence: 0.8 },
    pm: { role: 'pm', verdict: 'flag', findings: [], summary: 'Sec finding is the headline here.', confidence: 0.85 },
  };
}

function makeReportData(): ReportData {
  const outputs = roleOutputs();
  const resolver = resolve(outputs, WEIGHTS);
  return {
    runId: 'test-run-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    diff: DIFF_WITH_FINDING,
    roleOutputs: outputs,
    resolver,
    pipelineOutcome: 'completed',
    ranRoles: ['ba', 'dev', 'build', 'sec', 'qa', 'pm'],
    skippedRoles: [],
  };
}

describe('buildChangeCoverageMap', () => {
  it('maps every added line, with findings attached where they overlap', () => {
    const data = makeReportData();
    const coverage = buildChangeCoverageMap(data.diff, data.resolver.resolvedFindings);
    expect(coverage).toHaveLength(2); // two added lines
    const line2 = coverage.find((c) => c.line === 2);
    const line3 = coverage.find((c) => c.line === 3);
    expect(line2?.findings).toHaveLength(1);
    expect(line2?.findings[0].role).toBe('sec');
    expect(line3?.findings).toHaveLength(0);
  });

  it('returns [] for a diff with no added lines', () => {
    const emptyDiff: ParsedDiff = { ref: 'staged', raw: '', files: [] };
    expect(buildChangeCoverageMap(emptyDiff, [])).toEqual([]);
  });
});

describe('renderReportJson', () => {
  it('produces valid JSON with the decision, all six roles, and the coverage map', () => {
    const data = makeReportData();
    const parsed = JSON.parse(renderReportJson(data));
    expect(parsed.decision.value).toBe('block'); // Sec veto forces Block
    expect(parsed.decision.label).toBe('Block');
    expect(parsed.roles).toHaveLength(6);
    const secRole = parsed.roles.find((r: { role: string }) => r.role === 'sec');
    expect(secRole.findings).toHaveLength(1);
    expect(parsed.changeCoverage).toHaveLength(2);
  });

  it('marks a role that did not run', () => {
    const data = makeReportData();
    const partial: ReportData = { ...data, roleOutputs: { ba: data.roleOutputs.ba } };
    const parsed = JSON.parse(renderReportJson(partial));
    const dev = parsed.roles.find((r: { role: string }) => r.role === 'dev');
    expect(dev.ran).toBe(false);
    expect(dev.verdict).toBeNull();
  });
});

describe('renderReportMarkdown', () => {
  it('includes the decision banner, role sections, and a findings table', () => {
    const md = renderReportMarkdown(makeReportData());
    expect(md).toContain('# Codexrev Review — Block');
    expect(md).toContain('### Security Auditor — BLOCK (1 finding)');
    expect(md).toContain('CWE-89');
    expect(md).toContain('## Change Coverage Map');
  });

  it('escapes pipe characters in descriptions so the markdown table does not break', () => {
    const data = makeReportData();
    const withPipe: ReportData = {
      ...data,
      roleOutputs: {
        ...data.roleOutputs,
        dev: {
          role: 'dev',
          verdict: 'flag',
          findings: [{ id: 'dev-1', severity: 'low', file: 'x.ts', lineStart: 1, lineEnd: 1, description: 'a | b' }],
          summary: 's',
          confidence: 0.5,
        },
      },
    };
    const md = renderReportMarkdown(withPipe);
    expect(md).toContain('a \\| b');
  });
});

describe('renderReportHtml', () => {
  it('is a well-formed self-contained document with the decision banner and role sections', () => {
    const html = renderReportHtml(makeReportData());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>Codexrev Review — Block</title>');
    expect(html).toContain('Security Auditor');
    expect(html).toContain('CWE-89');
    // Self-contained: no external stylesheet/script references.
    expect(html).not.toMatch(/<link[^>]*rel=["']stylesheet/i);
    expect(html).not.toMatch(/<script[^>]*src=/i);
  });

  it('HTML-escapes finding descriptions (untrusted LLM text) to prevent injection', () => {
    const data = makeReportData();
    const malicious: ReportData = {
      ...data,
      roleOutputs: {
        ...data.roleOutputs,
        dev: {
          role: 'dev',
          verdict: 'flag',
          findings: [
            { id: 'dev-1', severity: 'low', file: 'x.ts', lineStart: 1, lineEnd: 1, description: '<script>alert(1)</script>' },
          ],
          summary: '<img src=x onerror=alert(1)>',
          confidence: 0.5,
        },
      },
    };
    const html = renderReportHtml(malicious);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders the change-coverage map with the flagged line visible', () => {
    const html = renderReportHtml(makeReportData());
    expect(html).toContain('SELECT * FROM users');
    expect(html).toContain('sev-critical');
  });
});

describe('formatTimestampForFilename', () => {
  it('produces a colon-free, filesystem-safe timestamp', () => {
    const ts = formatTimestampForFilename(new Date('2026-03-04T05:06:07Z'));
    expect(ts).toBe('20260304-050607');
    expect(ts).not.toMatch(/[:/\\]/);
  });
});

describe('reportPaths', () => {
  it('builds json/md/html paths sharing the scan-<timestamp> base name', () => {
    const paths = reportPaths('/tmp/reports', '20260101-000000');
    expect(paths.json).toBe('/tmp/reports/scan-20260101-000000.json');
    expect(paths.md).toBe('/tmp/reports/scan-20260101-000000.md');
    expect(paths.html).toBe('/tmp/reports/scan-20260101-000000.html');
  });
});

describe('defaultReportsDir', () => {
  it('resolves to .codexrev/review-pipeline/reports per Section 4 of the dev guide', () => {
    expect(defaultReportsDir('/repo')).toBe('/repo/.codexrev/review-pipeline/reports');
  });
});

describe('saveReport', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-report-'));
    tmpRoot = await fs.realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('creates the reports dir and writes all three files with matching content', async () => {
    const dir = defaultReportsDir(tmpRoot);
    const paths = await saveReport(makeReportData(), dir);

    expect(paths.dir).toBe(dir);
    for (const p of [paths.json, paths.md, paths.html]) {
      expect(path.isAbsolute(p)).toBe(true);
    }

    const [jsonContent, mdContent, htmlContent] = await Promise.all([
      fs.readFile(paths.json, 'utf-8'),
      fs.readFile(paths.md, 'utf-8'),
      fs.readFile(paths.html, 'utf-8'),
    ]);

    expect(() => JSON.parse(jsonContent)).not.toThrow();
    expect(mdContent).toContain('# Codexrev Review');
    expect(htmlContent).toContain('<!doctype html>');
  });
});

// ── Phase 9: fix-summary report ─────────────────────────────────────

const SAMPLE_FIX_ATTEMPT: FixAttemptRecord = {
  iteration: 1,
  role: 'sec',
  findingId: 'sec-1',
  file: 'app.ts',
  fixerStage: 'llm',
  description: 'Parameterize the query to remove the SQL injection.',
  oldString: "const q = 'SELECT * FROM users WHERE id=' + id;",
  newString: 'const q = "SELECT * FROM users WHERE id=?"; // bound separately',
};

function makeFixReportData(overrides: Partial<FixReportData> = {}): FixReportData {
  return {
    runId: 'test-run-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    outcome: 'resolved',
    iterations: 1,
    fixAttempts: [SAMPLE_FIX_ATTEMPT],
    unresolvedFindings: [],
    ...overrides,
  };
}

describe('fixReportPath', () => {
  it('builds a fix-<timestamp>.html path, matching Phase 9\'s exact naming', () => {
    expect(fixReportPath('/tmp/reports', '20260101-000000')).toBe('/tmp/reports/fix-20260101-000000.html');
  });
});

describe('renderFixReportHtml', () => {
  it('is a well-formed self-contained document with the outcome banner', () => {
    const html = renderFixReportHtml(makeFixReportData());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>Codexrev Fix Summary — Resolved</title>');
    expect(html).not.toMatch(/<link[^>]*rel=["']stylesheet/i);
    expect(html).not.toMatch(/<script[^>]*src=/i);
  });

  it('shows the fixer stage, file, and before/after code for each fix attempt', () => {
    const html = renderFixReportHtml(makeFixReportData());
    expect(html).toContain('LLM EditGenerator');
    expect(html).toContain('app.ts');
    expect(html).toContain('SELECT * FROM users WHERE id=');
    expect(html).toContain('bound separately');
  });

  it('labels a deterministic fix distinctly from an LLM one', () => {
    const html = renderFixReportHtml(
      makeFixReportData({ fixAttempts: [{ ...SAMPLE_FIX_ATTEMPT, fixerStage: 'deterministic' }] }),
    );
    expect(html).toContain('DeterministicFixer');
    expect(html).not.toContain('LLM EditGenerator');
  });

  it('lists findings that remain unresolved after hitting the loop\'s limits', () => {
    const html = renderFixReportHtml(
      makeFixReportData({
        outcome: 'escalated',
        unresolvedFindings: [
          { id: 'qa-1', severity: 'medium', file: 'greet.ts', lineStart: 3, lineEnd: 3, description: 'No null-name guard.' },
        ],
      }),
    );
    expect(html).toContain('<title>Codexrev Fix Summary — Escalated</title>');
    expect(html).toContain('Still Unresolved');
    expect(html).toContain('No null-name guard.');
  });

  it('omits the "Still Unresolved" section when nothing is left unresolved', () => {
    const html = renderFixReportHtml(makeFixReportData());
    expect(html).not.toContain('Still Unresolved');
  });

  it('says plainly when no fixes were applied at all', () => {
    const html = renderFixReportHtml(makeFixReportData({ fixAttempts: [], outcome: 'aborted' }));
    expect(html).toContain('No fixes were applied.');
  });

  it('HTML-escapes fix descriptions and before/after code (untrusted LLM text)', () => {
    const html = renderFixReportHtml(
      makeFixReportData({
        fixAttempts: [
          {
            ...SAMPLE_FIX_ATTEMPT,
            description: '<script>alert(1)</script>',
            oldString: '<img src=x onerror=alert(1)>',
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('saveFixReport', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-fixreport-'));
    tmpRoot = await fs.realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('creates the reports dir and writes one fix-<timestamp>.html file', async () => {
    const dir = defaultReportsDir(tmpRoot);
    const writtenPath = await saveFixReport(makeFixReportData(), dir);

    expect(path.isAbsolute(writtenPath)).toBe(true);
    expect(path.dirname(writtenPath)).toBe(dir);
    expect(path.basename(writtenPath)).toMatch(/^fix-\d{8}-\d{6}\.html$/);

    const content = await fs.readFile(writtenPath, 'utf-8');
    expect(content).toContain('<!doctype html>');
    expect(content).toContain('Codexrev Fix Summary');
  });
});
