import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  escapeHtml,
  renderAnalysisHtml,
  reportHtmlFileName,
} from '../../../src/features/living-spec/tools/reportHtml.js';
import { makeSpecAnalysisResult } from '../../../src/features/living-spec/testing/fixtures.js';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import { reportsDir } from '../../../src/features/living-spec/tools/stateStore.js';
import type { SpecAnalysisResult } from '../../../src/features/living-spec/pipeline/types.js';

/** Fixture with every optional field exercised (all report details present). */
function richResult(overrides: Partial<SpecAnalysisResult> = {}): SpecAnalysisResult {
  return makeSpecAnalysisResult({
    implications: [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The greeting must include the caller name.',
        confidence: 0.8,
        sourceRefs: ['src/greet.js:3-18'],
        category: 'behaviour',
        rationale: 'The greeting literal now interpolates the name.',
      },
    ],
    behaviourChangeSummary: 'The greeting salutation changed from hello to hi.',
    requiresUrsUpdate: true,
    proposalIds: ['prop-1'],
    inferenceError: { code: 'provider_unavailable', message: 'ECONNREFUSED', retryable: true },
    ...overrides,
  });
}

describe('reportHtmlFileName — human-readable naming', () => {
  it('produces sortable analyze-<date>-<time>-<file>-<id8>.html names', () => {
    const result = makeSpecAnalysisResult({
      changeId: '5e9beb9e6e0d93a2d7017d8621e0dd9cd05a4384104a28005289161e5777914b',
      timestamp: '2026-10-18T06:08:51.143Z',
      files: [{ path: 'src/greet.js', lines: 3 }],
    });
    expect(reportHtmlFileName(result)).toBe('analyze-20261018-060851-greet-5e9beb9e.html');
    expect(reportHtmlFileName(result)).toMatch(
      /^analyze-\d{8}-\d{6}-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}\.html$/,
    );
  });

  it('stays readable and safe for awkward inputs', () => {
    const noFiles = makeSpecAnalysisResult({ changeId: 'abc123', files: [] });
    expect(reportHtmlFileName(noFiles)).toBe(
      'analyze-20261017-000000-no-changes-abc123.html',
    );

    const deep = makeSpecAnalysisResult({
      changeId: 'ffffffff',
      timestamp: 'no-timestamp',
      files: [{ path: 'very/deep/My Component!.TS', lines: 1 }],
    });
    const name = reportHtmlFileName(deep);
    expect(name).toContain('unknown-time');
    expect(name).toMatch(/^analyze-unknown-time-my-component-ffffffff\.html$/);
    expect(name).not.toMatch(/[^A-Za-z0-9._-]/); // filesystem-safe
  });
});

describe('renderAnalysisHtml — every report detail in one interactive artifact', () => {
  const html = renderAnalysisHtml(richResult(), { ref: 'staged', jsonFile: 'chg.json' });

  it('is a complete, self-contained offline document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('<style>'); // inline CSS
    expect(html).toContain("getElementById('q')"); // inline filter script
    // no external assets — opens from disk with networking disabled
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('renders every SpecAnalysisResult detail', () => {
    const r = richResult();
    // overview / identity
    expect(html).toContain(r.changeId);
    expect(html).toContain(r.timestamp);
    expect(html).toContain('staged'); // diff ref
    expect(html).toContain('modified'); // drift chip
    // behaviour + URS update flag
    expect(html).toContain('salutation changed from hello to hi');
    expect(html).toContain('required');
    // files
    expect(html).toContain('src/greet.js');
    // implications: text, ids, category, confidence, source refs, rationale
    expect(html).toContain('The greeting must include the caller name.');
    expect(html).toContain('imp-1');
    expect(html).toContain('behaviour');
    expect(html).toContain('src/greet.js:3-18');
    expect(html).toContain('caller name');
    // URS patch + proposals
    expect(html).toContain('Document the caller-name requirement.');
    expect(html).toContain('sec-greeting');
    expect(html).toContain('prop-1');
    expect(html).toContain('codexrev spec accept|reject|defer');
    // test deltas: all contract fields
    const delta = r.testDeltas[0];
    expect(html).toContain(delta.id);
    expect(html).toContain(escapeHtml(delta.title));
    expect(html).toContain(delta.type);
    expect(html).toContain(delta.linkedRequirementId);
    expect(html).toContain(delta.linkedImplicationId);
    expect(html).toContain(escapeHtml(delta.expected));
    expect(html).toContain(delta.priority);
    expect(html).toContain(escapeHtml(delta.rationale));
    expect(html).toContain('call greet(&quot;ada&quot;)'); // steps escaped
    expect(html).toContain('Preconditions');
    // impact summary
    expect(html).toContain('Change-impact summary');
    expect(html).toContain('src/greet.js:2, 3');
    expect(html).toContain('Review the pending URS proposals');
    expect(html).toContain('80%'); // confidence 0.8
    // drift alerts: every NFR6 field
    const alert = r.driftAlerts[0];
    expect(html).toContain(alert.severity.toUpperCase());
    expect(html).toContain(escapeHtml(alert.reason));
    expect(html).toContain(escapeHtml(alert.proposedNextAction));
    expect(html).toContain(alert.timestamp);
    expect(html).toContain('sec-greeting');
    // quality + failure banner (NFR5)
    expect(html).toContain('heuristic');
    expect(html).toContain('Schema valid');
    expect(html).toContain('provider_unavailable');
    expect(html).toContain('ECONNREFUSED');
    expect(html).toContain('NOT applied');
    expect(html).toContain('NFR5');
    // sibling machine report link
    expect(html).toContain('href="./chg.json"');
  });

  it('offers interactive affordances: TOC anchors, collapsible sections, row filter', () => {
    for (const anchor of ['#files', '#implications', '#patch', '#deltas', '#impact', '#alerts', '#quality']) {
      expect(html).toContain(`href="${anchor}"`);
      expect(html).toContain(`id="${anchor.slice(1)}"`);
    }
    expect(html).toContain('<details');
    expect(html).toContain('<summary>');
    expect(html).toContain('data-search');
    expect(html).toContain('type="search"');
    expect(html).toContain('prefers-color-scheme'); // dark-mode aware
  });

  it('escapes hostile content (code and model output are untrusted)', () => {
    const hostile = richResult({
      implications: [
        {
          id: 'imp-x',
          kind: 'functional',
          text: '<script>alert(1)</script> "quoted" & \'single\'',
          confidence: 0.5,
          sourceRefs: ['src/a"><img onerror=alert(2)>.js:1'],
        },
      ],
      files: [{ path: 'src/<iframe>.js', lines: 1 }],
    });
    const out = renderAnalysisHtml(hostile);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).not.toContain('<img onerror=');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;iframe&gt;');
    expect(escapeHtml(`<b>&'"`)).toBe('&lt;b&gt;&amp;&#39;&quot;');
  });

  it('renders the minimal deterministic report without optional sections breaking', () => {
    const minimal = makeSpecAnalysisResult({
      behaviourChangeSummary: null,
      requiresUrsUpdate: null,
      inferenceError: null,
      proposalIds: [],
      driftAlerts: [],
      implications: [],
      testDeltas: [],
      ursPatch: { summary: 'No URS updates proposed.', entries: [] },
    });
    const out = renderAnalysisHtml(minimal);
    expect(out).toContain('not evaluated (deterministic run)');
    expect(out).toContain('No requirement implications');
    expect(out).toContain('No incremental test-case deltas');
    expect(out).toContain('No drift alerts');
    expect(out).toContain('No URS updates proposed');
    expect(out).not.toContain('NOT applied'); // no failure banner
  });
});

describe('codexrev spec analyze — HTML artifact on disk', () => {
  let tmpRoot: string;
  let logs: string[];

  beforeEach(async () => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-html-'));
    tmpRoot = await fs.realpath(raw);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeStagedRepo(): Promise<void> {
    const git = simpleGit({ baseDir: tmpRoot });
    await git.init();
    await git.addConfig('user.email', 'test@codexrev.dev');
    await git.addConfig('user.name', 'Codexrev Test');
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'src', 'greet.js'),
      'export function greet(name) {\n  return `hello ${name}`;\n}\n',
      'utf-8',
    );
    await git.add('src/greet.js');
    await git.commit('initial');
    await fs.writeFile(
      path.join(tmpRoot, 'src', 'greet.js'),
      'export function greet(name) {\n  return `hi ${name}`;\n}\n',
      'utf-8',
    );
    await git.add('src/greet.js');
  }

  it('writes a human-named HTML twin next to every report and prints it', async () => {
    await makeStagedRepo();
    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text' });

    const names = await fs.readdir(reportsDir(tmpRoot));
    const htmlName = names.find((n) => /^analyze-.*\.html$/.test(n));
    expect(htmlName).toMatch(/^analyze-\d{8}-\d{6}-greet-[0-9a-f]{8}\.html$/);

    const html = await fs.readFile(path.join(reportsDir(tmpRoot), htmlName!), 'utf-8');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('src/greet.js');
    // the stable JSON contract report still exists beside it
    expect(names.filter((n) => n.endsWith('.json'))).toHaveLength(1);
    // and the text summary points the user at the artifact
    expect(logs.join('\n')).toContain('html artifact:');
    expect(logs.join('\n')).toContain(htmlName!);
  }, 20_000);

  it('writes no HTML on --dry-run', async () => {
    await makeStagedRepo();
    await handleSpecCommand(['analyze'], { project: tmpRoot, output: 'text', dryRun: true });
    const names = await fs.readdir(reportsDir(tmpRoot)).catch(() => [] as string[]);
    expect(names.filter((n) => n.endsWith('.html'))).toHaveLength(0);
  }, 20_000);
});
