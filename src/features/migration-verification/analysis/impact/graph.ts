/**
 * Feature 3 / Function 1 — impact/reachability graph (Phase P5).
 *
 * Node kinds: dependency (from P2), finding (from P3), usage (from P4),
 * task (from P5 prioritizer). Every node/edge has a stable prefixed id and
 * carries evidence back to the analysis result that produced it.
 *
 * WHAT REACHABILITY MEANS HERE (and what it does NOT prove):
 *   - Dependency presence/relations come from P2's FLAT DependencyInfo list.
 *     P2 does not record parent->child transitive edges, so this graph does
 *     NOT fabricate a transitive hierarchy: transitive dependencies appear
 *     as nodes with `relation: transitive` metadata only. A dependency
 *     being reachable in the lockfile does NOT prove its API is used —
 *     usage evidence is the separate finding->usage edge chain.
 *
 * Graphology was NOT added: a small typed adjacency list plus a
 * deterministic topological sort (see impact/order.ts) covers P5's needs
 * without a new dependency (decision recorded in the phase-05 report).
 *
 * Cycles: detected on directed ordering edges (task requires-before) via
 * `detectOrderCycles`; diagnostics use the ORDER_CYCLE issue code — a cyclic
 * graph never silently claims a valid topological order.
 */

import type { AnalysisIssue, ImpactEdge, ImpactGraph, ImpactNode } from '../types.js';
import { analysisIssue } from '../issues.js';
import type { RuleResolution } from '../rules/ruleRegistry.js';
import type { MigrationTask } from '../types.js';

export function dependencyNodeId(pkg: string): string {
  return `dep:${pkg}`;
}
export function findingNodeId(findingId: string): string {
  return `finding:${findingId}`;
}
export function usageNodeId(file: string, line: number, column: number, findingId: string): string {
  return `usage:${file}:${line}:${column}@${findingId}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortGraphInPlace(graph: ImpactGraph): void {
  graph.nodes.sort((a, b) => compareStrings(a.id, b.id));
  graph.edges.sort(
    (a, b) =>
      compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.kind, b.kind),
  );
}

export interface ImpactGraphBuildResult {
  graph: ImpactGraph;
  issues: AnalysisIssue[];
}

/**
 * Build the dependency/finding/usage portion of the impact graph from rule
 * resolutions. Deterministic: nodes and edges are sorted by stable ids.
 */
export function buildImpactGraph(
  resolutions: readonly RuleResolution[],
  allDependencies: readonly { name: string; relation: 'direct' | 'transitive' }[],
): ImpactGraphBuildResult {
  const issues: AnalysisIssue[] = [];
  const nodes = new Map<string, ImpactNode>();
  const edges: ImpactEdge[] = [];
  const edgeSeen = new Set<string>();

  const addNode = (node: ImpactNode): void => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (from: string, to: string, kind: ImpactEdge['kind'], evidence: ImpactEdge['evidence']): void => {
    const key = `${from}->${to}#${kind}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, kind, evidence });
  };

  // All P2 dependencies become nodes (direct and transitive).
  for (const dep of allDependencies) {
    addNode({
      type: 'dependency',
      id: dependencyNodeId(dep.name),
      label: `${dep.name} (${dep.relation})`,
    });
  }

  for (const res of resolutions) {
    const usage = res.usage;
    const usageId = usageNodeId(usage.file, usage.start.line, usage.start.column, usage.catalogFindingId);

    if (res.finding !== null) {
      const depId = dependencyNodeId(res.finding.dependency);
      if (!nodes.has(depId)) {
        // Package unknown to P2 — represent it explicitly as unresolved.
        addNode({ type: 'dependency', id: depId, label: `${usage.package} (unresolved dependency)`, unresolved: true });
        issues.push(
          analysisIssue(
            'DEPENDENCY_UNRESOLVED',
            'warning',
            `finding '${res.finding.id}' references package '${res.finding.dependency}' which is absent from dependency analysis`,
            res.finding.dependency,
          ),
        );
      }
      const findingId = findingNodeId(res.finding.id);
      addNode({ type: 'finding', id: findingId, label: `${res.finding.id} (${res.finding.kind})` });
      // dependency -> finding: "this dependency has this compatibility finding"
      addEdge(depId, findingId, 'has-finding', res.finding.evidence);
      // finding -> usage: located source evidence
      addNode({ type: 'usage', id: usageId, label: `${usage.file}:${usage.start.line} (${usage.matchedPattern})` });
      addEdge(findingId, usageId, 'located-at', usage.evidence);
    } else {
      // Usage without a known finding: keep the usage visible, unresolved.
      addNode({ type: 'usage', id: usageId, label: `${usage.file}:${usage.start.line} (unresolved finding)`, unresolved: true });
    }
  }

  const graph: ImpactGraph = { nodes: [...nodes.values()], edges };
  sortGraphInPlace(graph);
  return { graph, issues };
}

/**
 * Append task nodes and their ordering edges to the graph.
 * `task.dependsOn` produces `requires-before` edges (prerequisite -> task);
 * `covers` edges link a task to the usage node it addresses, when known.
 */
export function appendTaskNodes(
  graph: ImpactGraph,
  tasks: readonly MigrationTask[],
  usageIdByHandle: ReadonlyMap<string, string>,
): ImpactGraph {
  const nodes: ImpactNode[] = [...graph.nodes];
  const edges: ImpactEdge[] = [...graph.edges];
  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const task of tasks) {
    if (!nodeIds.has(task.id)) {
      nodes.push({ type: 'task', id: task.id, label: `${task.id} (${task.kind}, ${task.priority})` });
      nodeIds.add(task.id);
    }
    for (const dep of task.dependsOn) {
      edges.push({
        from: dep,
        to: task.id,
        kind: 'requires-before',
        evidence: { status: 'present', source: { kind: 'manifest', ref: `task:${dep}->${task.id}` }, quality: 'exact' },
      });
    }
    const handle = task.target.file !== undefined ? usageIdByHandle.get(`${task.target.file}:${task.target.lineStart}:${task.target.lineEnd}`) : undefined;
    if (handle !== undefined && nodeIds.has(handle)) {
      edges.push({
        from: task.id,
        to: handle,
        kind: 'covers',
        evidence: { status: 'present', source: { kind: 'source-code', ref: handle }, quality: 'exact' },
      });
    }
  }

  const merged: ImpactGraph = { nodes, edges };
  sortGraphInPlace(merged);
  return merged;
}

/**
 * Detect cycles among directed edges (any kind — used for ordering edges).
 * Deterministic: nodes and neighbors are visited in sorted order.
 * Returns cycle member-id lists (one per distinct cycle, sorted).
 */
export function detectOrderCycles(graph: ImpactGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  const nodeIds = [...new Set([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.from), ...graph.edges.map((e) => e.to)])].sort(compareStrings);
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const list of adjacency.values()) list.sort(compareStrings);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();

  function dfs(u: string, stack: string[]): void {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adjacency.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(v);
        const cycle = stack.slice(start).sort(compareStrings);
        const key = cycle.join('|');
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(cycle);
        }
      } else if (c === WHITE) {
        dfs(v, stack);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  }

  for (const id of nodeIds) {
    if ((color.get(id) ?? WHITE) === WHITE) dfs(id, []);
  }
  cycles.sort((a, b) => compareStrings(a[0] ?? '', b[0] ?? ''));
  return cycles;
}
