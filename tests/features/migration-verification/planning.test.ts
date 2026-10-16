import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planMigration } from '../../../src/features/migration-verification/analysis/planning.js';
import { resolveUsages } from '../../../src/features/migration-verification/analysis/rules/ruleRegistry.js';
import { orderTasks, type TaskSortContext } from '../../../src/features/migration-verification/analysis/impact/order.js';
import { lookupCompatibility } from '../../../src/features/migration-verification/analysis/compat/lookup.js';
import { analyzeSourceUsages } from '../../../src/features/migration-verification/analysis/source/sourceAnalyzer.js';
import { analyzeDependencies } from '../../../src/features/migration-verification/analysis/dependencyAnalyzer.js';
import type { DependencyInfo, MigrationTask, SourceUsage } from '../../../src/features/migration-verification/analysis/types.js';

// ---- real P3 lookups (evidence must not be fabricated) ----
const reactDom = lookupCompatibility({ package: 'react-dom', targetVersion: '19.1.0' }); // high, confirmed
const lruCache = lookupCompatibility({ package: 'lru-cache', targetVersion: '10.2.0' }); // medium, confirmed
const hljs = lookupCompatibility({ package: 'highlight.js', targetVersion: '11.9.0' }); // low, confirmed

function makeUsage(over: Partial<SourceUsage> = {}): SourceUsage {
  return {
    id: 'su-1',
    file: 'src/app.tsx',
    start: { line: 2, column: 1 },
    end: { line: 2, column: 16 },
    matchedPattern: 'ReactDOM.render member access/call',
    catalogFindingId: 'react-dom-19-removed-render',
    package: 'react-dom',
    severity: 'high',
    confidence: 'high',
    explanation: 'test usage',
    evidence: { status: 'present', source: { kind: 'source-code', ref: 'src/app.tsx:2:1' }, quality: 'exact' },
    ...over,
  };
}

function makeDep(over: Partial<DependencyInfo> = {}): DependencyInfo {
  return {
    name: 'react-dom',
    relation: 'direct',
    declaredRange: '^19.0.0',
    resolvedVersion: '19.1.0',
    scope: 'runtime',
    targetVersion: null,
    conflicts: [],
    evidence: { status: 'present', source: { kind: 'manifest', ref: 'package.json#dependencies.react-dom' }, quality: 'exact' },
    ...over,
  };
}

describe('P5 rule registry — linkage and unresolved handling', () => {
  it('links a finding to a usage and dependency with confirmed class', () => {
    const r = resolveUsages({ usages: [makeUsage()], compatLookups: [reactDom], dependencies: [makeDep()] });
    expect(r.issues).toEqual([]);
    expect(r.resolutions).toHaveLength(1);
    const res = r.resolutions[0];
    expect(res.finding?.id).toBe('react-dom-19-removed-render');
    expect(res.dependency?.name).toBe('react-dom');
    expect(res.matchClass).toBe('confirmed');
    expect(res.reasons.length).toBeGreaterThan(0);
  });

  it('keeps a usage whose catalog finding is missing as unresolved with an issue', () => {
    const r = resolveUsages({ usages: [makeUsage({ catalogFindingId: 'ghost-finding' })], compatLookups: [], dependencies: [makeDep()] });
    expect(r.resolutions[0].matchClass).toBe('unresolved');
    expect(r.resolutions[0].finding).toBeNull();
    expect(r.issues.some((i) => i.code === 'COMPAT_DATA_UNAVAILABLE')).toBe(true);
  });

  it('reports an unresolved dependency relationship without dropping the usage', () => {
    const r = resolveUsages({ usages: [makeUsage()], compatLookups: [reactDom], dependencies: [makeDep({ name: 'left-pad' })] });
    expect(r.resolutions[0].dependency).toBeNull();
    expect(r.resolutions[0].finding).not.toBeNull();
    expect(r.issues.some((i) => i.code === 'DEPENDENCY_UNRESOLVED')).toBe(true);
  });

  it('classifies heuristic usages as possible, not confirmed', () => {
    const r = resolveUsages({ usages: [makeUsage({ confidence: 'medium', evidence: { status: 'present', quality: 'heuristic' } })], compatLookups: [reactDom], dependencies: [makeDep()] });
    expect(r.resolutions[0].matchClass).toBe('possible');
  });
});

describe('P5 planning — priorities and task kinds (documented policy)', () => {
  it('maps severity to priority for confirmed direct dependencies', () => {
    const plan = planMigration({
      dependencies: [makeDep(), makeDep({ name: 'lru-cache' }), makeDep({ name: 'highlight.js' })],
      compatLookups: [reactDom, lruCache, hljs],
      usages: [
        makeUsage(),
        makeUsage({ id: 'su-2', file: 'src/a.ts', start: { line: 1, column: 1 }, end: { line: 1, column: 12 }, catalogFindingId: 'lru-cache-7-renamed-options', package: 'lru-cache', severity: 'medium', matchedPattern: 'LRU' }),
        makeUsage({ id: 'su-3', file: 'src/b.ts', start: { line: 1, column: 1 }, end: { line: 1, column: 12 }, catalogFindingId: 'highlightjs-11-deprecated-highlightblock', package: 'highlight.js', severity: 'low', matchedPattern: 'hljs' }),
      ],
    });
    const manifestByPkg = new Map(plan.tasks.filter((t) => t.kind === 'update-manifest').map((t) => [t.target.dependency, t]));
    expect(manifestByPkg.get('react-dom')?.priority).toBe('high');
    expect(manifestByPkg.get('lru-cache')?.priority).toBe('medium');
    expect(manifestByPkg.get('highlight.js')?.priority).toBe('low');
  });

  it('downgrades transitive dependencies one tier', () => {
    const build = (relation: 'direct' | 'transitive') =>
      planMigration({ dependencies: [makeDep({ relation })], compatLookups: [reactDom], usages: [makeUsage()] });
    const direct = build('direct').tasks.find((t) => t.kind === 'update-manifest');
    const transitive = build('transitive').tasks.find((t) => t.kind === 'update-manifest');
    expect(direct?.priority).toBe('high');
    expect(transitive?.priority).toBe('medium');
  });

  it('caps possible matches at medium and keeps them as manual-review with reasons', () => {
    const plan = planMigration({
      dependencies: [makeDep()],
      compatLookups: [reactDom],
      usages: [makeUsage({ confidence: 'medium', evidence: { status: 'present', quality: 'heuristic' } })],
    });
    const usageTask = plan.tasks.find((t) => t.target.file !== undefined);
    expect(usageTask?.kind).toBe('manual-review');
    expect(usageTask?.priority).toBe('medium');
    expect(usageTask?.priorityReasons?.some((r) => r.includes('capped'))).toBe(true);
  });

  it('keeps unresolved usages as manual-review tasks that never disappear', () => {
    const plan = planMigration({ dependencies: [makeDep()], compatLookups: [], usages: [makeUsage({ catalogFindingId: 'ghost-finding' })] });
    const task = plan.tasks.find((t) => t.strategy === 'unresolved');
    expect(task?.kind).toBe('manual-review');
    expect(task?.unresolvedReason).toContain('ghost-finding');
    expect(plan.issues.some((i) => i.code === 'COMPAT_DATA_UNAVAILABLE')).toBe(true);
  });

  it('creates manifest + manual-review tasks for findings with no located usages', () => {
    const plan = planMigration({ dependencies: [makeDep()], compatLookups: [reactDom], usages: [] });
    expect(plan.tasks.map((t) => t.kind).sort()).toEqual(['manual-review', 'update-manifest']);
    const manual = plan.tasks.find((t) => t.kind === 'manual-review');
    expect(manual?.unresolvedReason).toBe('no-located-usages');
  });

  it('orders the manifest prerequisite before its usage tasks and links dependsOn', () => {
    const plan = planMigration({ dependencies: [makeDep()], compatLookups: [reactDom], usages: [makeUsage()] });
    const manifest = plan.tasks.find((t) => t.kind === 'update-manifest');
    const usageTask = plan.tasks.find((t) => t.kind === 'rename-usage');
    expect(manifest).toBeDefined();
    expect(usageTask).toBeDefined();
    expect(plan.tasks.indexOf(manifest as MigrationTask)).toBeLessThan(plan.tasks.indexOf(usageTask as MigrationTask));
    expect(usageTask?.dependsOn).toEqual([manifest?.id]);
  });

  it('breaks ties deterministically: package name, then file/line', () => {
    const plan = planMigration({
      dependencies: [makeDep(), makeDep({ name: 'lru-cache' })],
      compatLookups: [reactDom, lruCache],
      usages: [
        makeUsage({ id: 'su-1', file: 'src/z.ts', start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }),
        makeUsage({ id: 'su-2', file: 'src/a.ts', start: { line: 5, column: 1 }, end: { line: 5, column: 2 }, catalogFindingId: 'lru-cache-7-renamed-options', package: 'lru-cache', severity: 'medium' }),
        makeUsage({ id: 'su-3', file: 'src/z.ts', start: { line: 9, column: 1 }, end: { line: 9, column: 2 } }),
      ],
    });
    // equal priority (medium) & severity among lru tasks; react-dom tasks rank higher by severity.
    const priorities = plan.tasks.map((t) => t.priority);
    expect(priorities[0]).toBe('high');
    const manifests = plan.tasks.filter((t) => t.kind === 'update-manifest').map((t) => t.target.dependency);
    expect(manifests).toEqual(['react-dom', 'lru-cache']);
  });

  it('is deterministic across repeated runs (tasks + graph serialization)', () => {
    const input = {
      dependencies: [makeDep(), makeDep({ name: 'lru-cache', relation: 'transitive' })],
      compatLookups: [reactDom, lruCache],
      usages: [
        makeUsage(),
        makeUsage({ id: 'su-2', file: 'src/a.ts', catalogFindingId: 'lru-cache-7-renamed-options', package: 'lru-cache', severity: 'medium' }),
      ],
    };
    const a = planMigration(input);
    const b = planMigration(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const nodeIds = a.graph.nodes.map((n) => n.id);
    expect(nodeIds).toEqual([...nodeIds].sort());
  });

  it('handles empty inputs cleanly', () => {
    const plan = planMigration({ dependencies: [], compatLookups: [], usages: [] });
    expect(plan.graph.nodes).toEqual([]);
    expect(plan.graph.edges).toEqual([]);
    expect(plan.tasks).toEqual([]);
    expect(plan.issues).toEqual([]);
  });
});

describe('P5 graph — traceability and cycles', () => {
  it('traces usage -> finding -> dependency with preserved evidence, plus task edges', () => {
    const plan = planMigration({ dependencies: [makeDep()], compatLookups: [reactDom], usages: [makeUsage()] });
    const { nodes, edges } = plan.graph;
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.has('dep:react-dom')).toBe(true);
    expect(ids.has('finding:react-dom-19-removed-render')).toBe(true);
    expect(ids.has('usage:src/app.tsx:2:1@react-dom-19-removed-render')).toBe(true);
    const depToFinding = edges.find((e) => e.from === 'dep:react-dom' && e.to === 'finding:react-dom-19-removed-render' && e.kind === 'has-finding');
    expect(depToFinding?.evidence.source?.kind).toBe('builtin-catalog');
    const findingToUsage = edges.find((e) => e.from === 'finding:react-dom-19-removed-render' && e.kind === 'located-at');
    expect(findingToUsage?.evidence.source?.kind).toBe('source-code');
    expect(edges.some((e) => e.kind === 'requires-before' && e.from.startsWith('act-'))).toBe(true);
    expect(edges.some((e) => e.kind === 'covers')).toBe(true);
  });

  it('marks dependencies unknown to P2 as unresolved nodes instead of fabricating edges', () => {
    const plan = planMigration({ dependencies: [makeDep({ name: 'left-pad' })], compatLookups: [reactDom], usages: [makeUsage()] });
    const node = plan.graph.nodes.find((n) => n.id === 'dep:react-dom');
    expect(node?.unresolved).toBe(true);
    expect(plan.issues.some((i) => i.code === 'DEPENDENCY_UNRESOLVED')).toBe(true);
  });

  it('reports prerequisite cycles as ORDER_CYCLE instead of a false valid order', () => {
    const ctx = new Map<string, TaskSortContext>();
    const mk = (id: string, dependsOn: string[]): MigrationTask => ({
      id, priority: 'medium', kind: 'rename-usage',
      target: { file: `${id}.ts`, lineStart: 1, lineEnd: 1 },
      ruleId: null, dependsOn, strategy: 'manual', rationale: id,
    });
    ctx.set('a', { severityRank: 3, relationRank: 0, dependency: 'x', findingId: 'f', file: 'a.ts', line: 1, column: 1 });
    ctx.set('b', { severityRank: 3, relationRank: 0, dependency: 'x', findingId: 'f', file: 'b.ts', line: 1, column: 1 });
    const result = orderTasks([mk('a', ['b']), mk('b', ['a'])], ctx);
    expect(result.order).toEqual([]);
    expect(result.cyclic.map((t) => t.id).sort()).toEqual(['a', 'b']);
    expect(result.issues.some((i) => i.code === 'ORDER_CYCLE' && i.severity === 'error')).toBe(true);
  });
});

// ---- regression: P2 + P3 + P4 behavior intact through the P5 pipeline ----
let tmpRoot: string;
beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-mv-p5-'));
  tmpRoot = await fs.realpath(raw);
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('P5 regression — P2/P3/P4 behavior intact through planMigration', () => {
  it('runs the real P2 -> P3 -> P4 -> P5 chain on a synthetic fixture project', async () => {
    await fs.writeFile(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'react-dom': '^18.2.0' } }),
    );
    await fs.writeFile(
      path.join(tmpRoot, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/react-dom': { version: '18.3.1' } },
      }),
    );
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'src', 'app.tsx'),
      "import ReactDOM from 'react-dom';\nReactDOM.render(<App />, el);\n",
    );

    const deps = await analyzeDependencies({ projectRoot: tmpRoot, targetDependency: 'react-dom', targetVersion: '19.1.0' });
    expect(deps.dependencies.find((d) => d.name === 'react-dom')?.resolvedVersion).toBe('18.3.1'); // P2 intact

    const lookups = [lookupCompatibility({ package: 'react-dom', targetVersion: '19.1.0' })];
    expect(lookups[0].verdict).toBe('affected'); // P3 intact

    const src = await analyzeSourceUsages({ projectRoot: tmpRoot, compatLookups: lookups });
    expect(src.usages).toHaveLength(1); // P4 intact

    const plan = planMigration({ dependencies: deps.dependencies, compatLookups: lookups, usages: src.usages });
    expect(plan.tasks.map((t) => t.kind).sort()).toEqual(['rename-usage', 'update-manifest']);
    expect(plan.tasks[0].kind).toBe('update-manifest');
    expect(plan.graph.nodes.some((n) => n.id === 'dep:react-dom')).toBe(true);
  });
});
