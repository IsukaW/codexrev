import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateAnalyzeRequest } from '../../../src/features/migration-verification/analysis/validateRequest.js';
import { runAnalyzePipeline } from '../../../src/features/migration-verification/analysis/planBuilder.js';

// Committed P7 fixture: a frozen React 18 npm project whose src/index.jsx
// genuinely calls ReactDOM.render (removed in react-dom 19), plus a
// comment/string-only false-positive control file.
const FIXTURE = fileURLToPath(new URL('../../fixtures/function1/react18-react19', import.meta.url));

async function snapshotFixture(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.set(path.relative(FIXTURE, abs), await fs.readFile(abs, 'utf-8'));
    }
  }
  await walk(FIXTURE);
  return out;
}

describe('P7 fixture validation — react18-react19 (Function 1 end-to-end)', () => {
  it('detects the confirmed react-dom 19 finding and the real render usage', async () => {
    const request = await validateAnalyzeRequest({
      projectPath: FIXTURE,
      technology: 'node',
      dependencyName: 'react-dom',
      currentVersion: '18.3.1',
      targetVersion: '19.1.0',
      migration: { kind: 'api-rename', from: 'render', to: 'createRoot' },
    });
    const { plan } = await runAnalyzePipeline(request);

    // P2: dependency analysis over the synthetic lockfile
    const reactDom = plan.dependencies.find((d) => d.name === 'react-dom');
    expect(reactDom?.relation).toBe('direct');
    expect(reactDom?.resolvedVersion).toBe('18.3.1');
    expect(reactDom?.targetVersion).toBe('19.1.0');

    // P3: catalog finding confirmed against the 19.1.0 target
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0].id).toBe('react-dom-19-removed-render');
    expect(plan.findings[0].status).toBe('confirmed');
    expect(plan.findings[0].evidence.source?.uri).toContain('react.dev');

    // P4: usage located on the real call site; false-positive control clean
    expect(plan.summary.filesScanned).toBe(2);
    expect(plan.summary.filesAffected).toBe(1);
    const usageTask = plan.tasks.find((t) => t.kind === 'rename-usage');
    expect(usageTask?.target.file).toBe('src/index.jsx');
    expect(usageTask?.target.lineStart).toBe(4); // line 3 is blank; render call is on line 4
    expect(plan.tasks.some((t) => t.target.file === 'src/no-usage.js')).toBe(false);

    // P5/P6: deterministic plan with manifest prerequisite first
    expect(plan.tasks[0].id).toBe('act-1');
    expect(plan.tasks[0].kind).toBe('update-manifest');
    expect(usageTask?.dependsOn).toEqual(['act-1']);
    expect(plan.summary.confirmedCount).toBe(1);
    expect(plan.schemaVersion).toBe('0.3.0');
  });

  it('leaves the fixture byte-identical (read-only guarantee on the committed fixture)', async () => {
    const before = await snapshotFixture();
    expect(before.size).toBe(5); // package.json, package-lock.json, README.md, src/index.jsx, src/no-usage.js
    const request = await validateAnalyzeRequest({
      projectPath: FIXTURE,
      technology: 'node',
      dependencyName: 'react-dom',
      currentVersion: '18.3.1',
      targetVersion: '19.1.0',
      migration: { kind: 'api-rename', from: 'render', to: 'createRoot' },
    });
    const { plan } = await runAnalyzePipeline(request);
    expect(plan.tasks.length).toBeGreaterThan(0);
    const after = await snapshotFixture();
    expect(after.size).toBe(before.size);
    for (const [rel, content] of before) expect(after.get(rel)).toBe(content);
  });
});
