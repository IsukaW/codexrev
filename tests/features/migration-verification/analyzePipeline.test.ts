import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAnalyzeRequest } from '../../../src/features/migration-verification/analysis/validateRequest.js';
import { runAnalyzePipeline } from '../../../src/features/migration-verification/analysis/planBuilder.js';
import { renderPlanJson, renderPlanMarkdown } from '../../../src/features/migration-verification/analysis/renderPlan.js';
import { handleMigrateCommand } from '../../../src/features/migration-verification/cli/handleAnalyzeCommand.js';
import type { AnalyzeRequest } from '../../../src/features/migration-verification/analysis/types.js';

let tmpRoot: string;
let originalExitCode: number | undefined;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-mv-p6-'));
  tmpRoot = await fs.realpath(raw);
  await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      version: '1.0.0',
      dependencies: { 'react-dom': '^18.2.0', 'left-pad': '^1.3.0' },
    }),
  );
  await fs.writeFile(
    path.join(tmpRoot, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/react-dom': { version: '18.3.1' },
        'node_modules/left-pad': { version: '1.3.0' },
      },
    }),
  );
  await fs.writeFile(
    path.join(tmpRoot, 'src', 'app.tsx'),
    "import ReactDOM from 'react-dom';\nReactDOM.render(<App />, el);\n",
  );
  originalExitCode = process.exitCode;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

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

async function validRequest(over: Record<string, unknown> = {}): Promise<AnalyzeRequest> {
  return validateAnalyzeRequest({
    projectPath: tmpRoot,
    technology: 'node',
    dependencyName: 'react-dom',
    currentVersion: '18.3.1',
    targetVersion: '19.1.0',
    migration: { kind: 'api-rename', from: 'render', to: 'createRoot' },
    ...over,
  });
}

describe('P6 pipeline — end-to-end MigrationPlan assembly', () => {
  it('produces a schema-0.3.0 plan from the full P1-P5 chain', async () => {
    const { plan } = await runAnalyzePipeline(await validRequest());
    expect(plan.schemaVersion).toBe('0.3.0');
    expect(plan.project.ecosystem).toBe('npm');
    expect(plan.project.manifest?.name).toBe('fixture-app');
    const reactDom = plan.dependencies.find((d) => d.name === 'react-dom');
    expect(reactDom?.resolvedVersion).toBe('18.3.1');
    expect(reactDom?.targetVersion).toBe('19.1.0');
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0].status).toBe('confirmed');
    expect(plan.tasks[0].kind).toBe('update-manifest');
    expect(plan.tasks[0].id).toBe('act-1');
    expect(plan.tasks.some((t) => t.kind === 'rename-usage' || t.kind === 'manual-review')).toBe(true);
    expect(plan.summary.filesScanned).toBe(1);
    expect(plan.summary.filesAffected).toBe(1);
    expect(plan.summary.confirmedCount).toBe(1);
    expect(plan.summary.taskCount).toBe(plan.tasks.length);
    expect(plan.impact.nodes.some((n) => n.id === 'dep:react-dom')).toBe(true);
  });

  it('keeps unknown packages as explicit issues, never as "safe"', async () => {
    const { plan } = await runAnalyzePipeline(
      await validRequest({ dependencyName: 'left-pad', currentVersion: '1.3.0', targetVersion: '2.0.0' }),
    );
    expect(plan.findings).toEqual([]);
    expect(plan.tasks).toEqual([]);
    expect(plan.issues.some((i) => i.code === 'COMPAT_DATA_UNAVAILABLE')).toBe(true);
  });

  it('carries LOCKFILE_MISSING into the plan when the lockfile is absent', async () => {
    await fs.rm(path.join(tmpRoot, 'package-lock.json'));
    const { plan } = await runAnalyzePipeline(await validRequest());
    expect(plan.issues.some((i) => i.code === 'LOCKFILE_MISSING')).toBe(true);
    expect(plan.dependencies.find((d) => d.name === 'react-dom')?.resolvedVersion).toBeNull();
  });

  it('does not modify the analyzed project (read-only guarantee)', async () => {
    const before = await snapshotProject();
    const request = await validRequest();
    const { plan } = await runAnalyzePipeline(request);
    renderPlanJson(plan);
    renderPlanMarkdown(plan);
    const after = await snapshotProject();
    expect(after.size).toBe(before.size);
    for (const [rel, content] of before) expect(after.get(rel)).toBe(content);
  });

  it('is deterministic: identical inputs produce identical JSON', async () => {
    const a = renderPlanJson((await runAnalyzePipeline(await validRequest())).plan);
    const b = renderPlanJson((await runAnalyzePipeline(await validRequest())).plan);
    expect(a).toBe(b);
    expect(JSON.parse(a).schemaVersion).toBe('0.3.0');
  });
});

describe('P6 rendering', () => {
  it('renders a Markdown report with all sections and provenance', async () => {
    const { plan } = await runAnalyzePipeline(await validRequest());
    const md = renderPlanMarkdown(plan);
    expect(md).toContain('# Migration Plan');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Compatibility findings');
    expect(md).toContain('react-dom-19-removed-render');
    expect(md).toContain('https://react.dev/');
    expect(md).toContain('## Migration tasks');
    expect(md).toContain('act-1');
    expect(md).toContain('## Issues');
    expect(md).toContain('PROVISIONAL');
  });

  it('renders a readable JSON plan', async () => {
    const { plan } = await runAnalyzePipeline(await validRequest());
    const parsed = JSON.parse(renderPlanJson(plan));
    expect(parsed.summary.taskCount).toBe(parsed.tasks.length);
    expect(parsed.impact.nodes.length).toBeGreaterThan(0);
  });
});

describe('P6 CLI handler (handleMigrateCommand)', () => {
  it('prints a JSON plan and exits 0 on success', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    await handleMigrateCommand(['analyze'], {
      projectPath: tmpRoot,
      dependency: 'react-dom',
      currentVersion: '18.3.1',
      targetVersion: '19.1.0',
      from: 'render',
      to: 'createRoot',
    });
    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(chunks.join(''));
    expect(parsed.schemaVersion).toBe('0.3.0');
  });

  it('prints Markdown when --format markdown', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    await handleMigrateCommand(['analyze'], {
      projectPath: tmpRoot,
      dependency: 'react-dom',
      currentVersion: '18.3.1',
      targetVersion: '19.1.0',
      upgrade: true,
      format: 'markdown',
    });
    expect(process.exitCode ?? 0).toBe(0);
    expect(chunks.join('')).toContain('# Migration Plan');
  });

  it('exits 2 for a missing subcommand', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleMigrateCommand([], {});
    expect(process.exitCode).toBe(2);
  });

  it('exits 2 when --from is given without --to', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleMigrateCommand(['analyze'], { projectPath: tmpRoot, dependency: 'x', currentVersion: '1.0.0', targetVersion: '2.0.0', from: 'a' });
    expect(process.exitCode).toBe(2);
  });

  it('exits 1 with REQUEST_INVALID details when required flags are missing', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    await handleMigrateCommand(['analyze'], { projectPath: tmpRoot });
    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes('REQUEST_INVALID'))).toBe(true);
  });

  it('exits 1 for a non-npm project (analysis failure, no fabricated plan)', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-mv-bare-'));
    try {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
        errors.push(String(msg));
      });
      await handleMigrateCommand(['analyze'], {
        projectPath: bare,
        dependency: 'react-dom',
        currentVersion: '18.3.1',
        targetVersion: '19.1.0',
        upgrade: true,
      });
      expect(process.exitCode).toBe(1);
      expect(errors.some((e) => e.includes('could not analyze project'))).toBe(true);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('writes the plan via --out (outside the project) and reports it', async () => {
    const outFile = path.join(os.tmpdir(), `codexrev-mv-plan-${Date.now()}.json`);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    try {
      await handleMigrateCommand(['analyze'], {
        projectPath: tmpRoot,
        dependency: 'react-dom',
        currentVersion: '18.3.1',
        targetVersion: '19.1.0',
        from: 'render',
        to: 'createRoot',
        out: outFile,
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(errors.some((e) => e.includes('plan written to'))).toBe(true);
      const written = JSON.parse(await fs.readFile(outFile, 'utf-8'));
      expect(written.schemaVersion).toBe('0.3.0');
    } finally {
      await fs.rm(outFile, { force: true });
    }
  });

  it('rejects --out inside the analyzed project (read-only guarantee)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleMigrateCommand(['analyze'], {
      projectPath: tmpRoot,
      dependency: 'react-dom',
      currentVersion: '18.3.1',
      targetVersion: '19.1.0',
      upgrade: true,
      out: path.join(tmpRoot, 'plan.json'),
    });
    expect(process.exitCode).toBe(1);
    await expect(fs.stat(path.join(tmpRoot, 'plan.json'))).rejects.toThrow();
  });
});
