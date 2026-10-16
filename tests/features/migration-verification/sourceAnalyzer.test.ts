import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeSourceUsages } from '../../../src/features/migration-verification/analysis/source/sourceAnalyzer.js';
import { lookupCompatibility } from '../../../src/features/migration-verification/analysis/compat/lookup.js';
import type { CompatLookupResult } from '../../../src/features/migration-verification/analysis/compat/lookup.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-mv-src-'));
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

// Real P3 lookups — the evidence guiding P4 matching.
const reactDomAffected: CompatLookupResult[] = [lookupCompatibility({ package: 'react-dom', targetVersion: '19.1.0' })];
const lruAffected: CompatLookupResult[] = [lookupCompatibility({ package: 'lru-cache', targetVersion: '10.2.0' })];
const hljsAffected: CompatLookupResult[] = [lookupCompatibility({ package: 'highlight.js', targetVersion: '11.9.0' })];

describe('sourceAnalyzer — verified removed API detection (react-dom)', () => {
  it('detects ReactDOM.render from a default import with exact position', async () => {
    await writeProject({ 'src/app.tsx': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n" });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.filesScanned).toBe(1);
    expect(r.usages).toHaveLength(1);
    const u = r.usages[0];
    expect(u.file).toBe('src/app.tsx');
    expect(u.start).toEqual({ line: 2, column: 1 });
    expect(u.end).toEqual({ line: 2, column: 16 });
    expect(u.catalogFindingId).toBe('react-dom-19-removed-render');
    expect(u.package).toBe('react-dom');
    expect(u.confidence).toBe('high');
    expect(u.severity).toBe('high');
    expect(u.evidence.source).toEqual({ kind: 'source-code', ref: 'src/app.tsx:2:1' });
    expect(u.id).toBe('su-1');
  });

  it('supports namespace import syntax', async () => {
    await writeProject({ 'a.ts': "import * as RD from 'react-dom';\nRD.render(a, b);\n" });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.usages).toHaveLength(1);
    expect(r.usages[0].confidence).toBe('high');
  });

  it('supports property access without a call', async () => {
    await writeProject({ 'b.ts': "import ReactDOM from 'react-dom';\nconst fn = ReactDOM.render;\n" });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.usages).toHaveLength(1);
    expect(r.usages[0].start).toEqual({ line: 2, column: 12 });
  });

  it('supports CommonJS require', async () => {
    await writeProject({ 'c.js': "const ReactDOM = require('react-dom');\nReactDOM.render(el);\n" });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.usages).toHaveLength(1);
    expect(r.usages[0].confidence).toBe('high');
  });

  it('handles JSX inside .tsx', async () => {
    await writeProject({
      'x.tsx': "import ReactDOM from 'react-dom';\nReactDOM.render(<App />, document.getElementById('root'));\n",
    });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.usages).toHaveLength(1);
  });
});

describe('sourceAnalyzer — comments and strings are never matched', () => {
  it('ignores usages appearing only in comments', async () => {
    await writeProject({ 'commented.ts': '// ReactDOM.render(el);\n/* ReactDOM.render(el); */\n' });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.usages).toEqual([]);
  });

  it('ignores usages appearing only in strings', async () => {
    await writeProject({ 'strings.ts': "const s = 'ReactDOM.render(el)';\nconst t = `ReactDOM.render(el)`;\n" });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.usages).toEqual([]);
  });
});

describe('sourceAnalyzer — unrelated identifiers do not match', () => {
  it('does not match .render on unrelated receivers', async () => {
    await writeProject({ 'unrelated.ts': 'element.render(x);\nfoo.bar.render();\n' });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.usages).toEqual([]);
  });
});

describe('sourceAnalyzer — lru-cache and highlight.js matchers', () => {
  it('detects lru-cache v7-renamed constructor options and instance members', async () => {
    await writeProject({
      'cache.ts':
        "import { LRU } from 'lru-cache';\nconst cache = new LRU({ maxAge: 1000 });\ncache.prune();\ncache.reset();\nconst n = cache.length;\n",
    });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: lruAffected });
    const patterns = r.usages.map((u) => u.matchedPattern);
    expect(patterns).toEqual([
      "LRU constructor option 'maxAge'",
      "LRU instance member 'prune'",
      "LRU instance member 'reset'",
      "LRU instance member 'length'",
    ]);
    expect(r.usages.every((u) => u.confidence === 'high')).toBe(true);
  });

  it('does not match .length on arrays or unrelated objects', async () => {
    await writeProject({ 'arr.ts': 'const n = items.length;\nitems.reset();\n' });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: lruAffected });
    expect(r.usages).toEqual([]);
  });

  it('detects highlightBlock with import evidence (high) and by member name (medium fallback)', async () => {
    await writeProject({
      'hl.ts': "import hljs from 'highlight.js';\nhljs.highlightBlock(el);\n",
      'hl2.ts': 'other.highlightBlock(x);\n',
    });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: hljsAffected });
    expect(r.usages).toHaveLength(2);
    const withImport = r.usages.find((u) => u.file === 'hl.ts');
    const fallback = r.usages.find((u) => u.file === 'hl2.ts');
    expect(withImport?.confidence).toBe('high');
    expect(fallback?.confidence).toBe('medium');
    expect(fallback?.limitation).toContain('without import evidence');
  });
});

describe('sourceAnalyzer — discovery and exclusions', () => {
  it('handles .js, .ts and .tsx files', async () => {
    await writeProject({
      'a.js': "const ReactDOM = require('react-dom');\nReactDOM.render(el);\n",
      'b.ts': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n",
      'c.tsx': "import ReactDOM from 'react-dom';\nReactDOM.render(<App />, el);\n",
    });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.filesScanned).toBe(3);
    expect(r.usages).toHaveLength(3);
  });

  it('excludes node_modules, dist, coverage and dot-directories', async () => {
    await writeProject({
      'src/good.tsx': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n",
      'node_modules/react-dom/index.js': "const R = require('react-dom');\nR.render(el);\n",
      'dist/bundle.ts': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n",
      'coverage/report.ts': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n",
      '.hidden/secret.ts': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n",
    });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.filesScanned).toBe(1);
    expect(r.usages).toHaveLength(1);
    expect(r.usages[0].file).toBe('src/good.tsx');
  });

  it('reports multiple matches in one file with stable ids', async () => {
    await writeProject({
      'multi.tsx':
        "import ReactDOM from 'react-dom';\nReactDOM.render(<A />, el);\nReactDOM.render(<B />, el2);\n",
    });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.usages.map((u) => u.id)).toEqual(['su-1', 'su-2']);
    expect(r.usages.map((u) => u.start.line)).toEqual([2, 3]);
  });
});

describe('sourceAnalyzer — degraded inputs', () => {
  it('reports parse errors without crashing and still analyzes other files', async () => {
    await writeProject({
      'broken.ts': 'const x = ;\n',
      'ok.ts': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n",
    });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    const issue = r.issues.find((i) => i.code === 'ANALYZER_FAILED' && i.message.includes('parse errors'));
    expect(issue?.context).toBe('broken.ts');
    expect(r.usages).toHaveLength(1);
    expect(r.usages[0].file).toBe('ok.ts');
  });

  it('handles an empty project (no source files) without issues', async () => {
    await writeProject({ 'README.md': '# empty\n' });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    expect(r.filesScanned).toBe(0);
    expect(r.usages).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});

describe('sourceAnalyzer — evidence rules', () => {
  it('reports nothing for a package with no compatibility findings (unknown ≠ matched)', async () => {
    await writeProject({ 'x.ts': 'leftPad("1");\n' });
    const leftPad = lookupCompatibility({ package: 'left-pad', targetVersion: '2.0.0' });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: [leftPad] });
    expect(r.usages).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('reports RULE_NOT_FOUND for a finding without a documented matcher', async () => {
    await writeProject({ 'x.ts': 'export const x = 1;\n' });
    const fake: CompatLookupResult = {
      package: 'demo-x',
      verdict: 'affected',
      findings: [
        {
          id: 'demo-x-fake-finding',
          kind: 'breaking-change',
          severity: 'medium',
          dependency: 'demo-x',
          message: 'fabricated for test',
          evidence: { status: 'present', source: { kind: 'builtin-catalog', ref: 'demo-x-fake-finding' }, quality: 'exact' },
          ruleId: null,
          status: 'confirmed',
        },
      ],
      issues: [],
    };
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: [fake] });
    expect(r.usages).toEqual([]);
    expect(r.issues.some((i) => i.code === 'RULE_NOT_FOUND' && i.context === 'demo-x-fake-finding')).toBe(true);
  });

  it('caps confidence at medium and flags the limitation for unresolved P3 findings', async () => {
    await writeProject({ 'r.ts': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n" });
    const unresolved = lookupCompatibility({ package: 'react-dom', targetVersion: '^19.0.0' });
    const r = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: [unresolved] });
    expect(r.usages).toHaveLength(1);
    expect(r.usages[0].confidence).toBe('medium');
    expect(r.usages[0].limitation).toContain('unresolved');
    expect(r.usages[0].evidence.quality).toBe('heuristic');
  });
});

describe('sourceAnalyzer — determinism and read-only guarantee', () => {
  it('produces byte-identical results across repeated runs', async () => {
    await writeProject({
      'a.ts': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n",
      'b.tsx': "import { LRU } from 'lru-cache';\nconst c = new LRU({ maxAge: 1 });\nc.prune();\n",
    });
    const lookups = [...reactDomAffected, ...lruAffected];
    const first = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: lookups });
    const second = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: lookups });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('leaves every source file byte-identical (read-only guarantee)', async () => {
    await writeProject({
      'a.ts': "import ReactDOM from 'react-dom';\nReactDOM.render(el);\n",
      'src/b.tsx': "import ReactDOM from 'react-dom';\nReactDOM.render(<App />, el);\n",
    });
    const before = await snapshotProject();
    await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: reactDomAffected });
    const after = await snapshotProject();
    expect(after.size).toBe(before.size);
    for (const [rel, content] of before) expect(after.get(rel)).toBe(content);
  });
});
