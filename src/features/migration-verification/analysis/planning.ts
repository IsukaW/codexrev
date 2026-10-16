/**
 * Feature 3 / Function 1 — P5 orchestration (rule registry → impact graph →
 * prioritized, deterministically ordered tasks).
 *
 * `planMigration` is a pure function over P2/P3/P4 outputs. It:
 *   1. resolves usages to findings/dependencies (rules/ruleRegistry),
 *   2. builds the dependency/finding/usage impact graph (impact/graph),
 *   3. builds priority-assigned task candidates (tasks/prioritizer),
 *   4. topologically orders them with cycle diagnostics (impact/order),
 *   5. assigns final stable ids `act-N` in the final order and rewrites
 *      `dependsOn` handles to those ids,
 *   6. appends task nodes/edges to the graph.
 * Identical inputs always produce identical output (sorted maps/arrays).
 */

import type { AnalysisIssue, DependencyInfo, ImpactGraph, MigrationTask } from './types.js';
import type { CompatLookupResult } from './compat/lookup.js';
import type { SourceUsage } from './source/sourceAnalyzer.js';
import { resolveUsages } from './rules/ruleRegistry.js';
import { appendTaskNodes, buildImpactGraph, usageNodeId } from './impact/graph.js';
import { orderTasks, type TaskSortContext } from './impact/order.js';
import { buildMigrationTasks } from './tasks/prioritizer.js';

export interface PlanMigrationInput {
  dependencies: readonly DependencyInfo[];
  compatLookups: readonly CompatLookupResult[];
  usages: readonly SourceUsage[];
}

export interface PlannedMigration {
  graph: ImpactGraph;
  /** Final tasks in deterministic order (acyclic); cyclic tasks appended. */
  tasks: MigrationTask[];
  issues: AnalysisIssue[];
}

export function planMigration(input: PlanMigrationInput): PlannedMigration {
  const registry = resolveUsages({
    usages: input.usages,
    compatLookups: input.compatLookups,
    dependencies: input.dependencies,
  });

  const graphBuild = buildImpactGraph(registry.resolutions, input.dependencies);
  const built = buildMigrationTasks(registry.resolutions, input.compatLookups, input.dependencies);

  // Internal ordering uses stable handles; final ids are assigned after sort.
  const contextByHandle = new Map<string, TaskSortContext>(
    built.candidates.map((c) => [c.handle, c.context]),
  );
  const handleTasks = built.candidates.map((c) => ({ ...c.task, id: c.handle }));
  const orderResult = orderTasks(handleTasks, contextByHandle);

  const candidateByHandle = new Map(built.candidates.map((c) => [c.handle, c]));
  const sequence = [...orderResult.order, ...orderResult.cyclic];
  const handleToId = new Map<string, string>(
    sequence.map((t, i) => [t.id, `act-${i + 1}`]),
  );

  const tasks: MigrationTask[] = sequence.map((t, i) => {
    const candidate = candidateByHandle.get(t.id);
    return {
      ...t,
      id: `act-${i + 1}`,
      dependsOn: (candidate?.task.dependsOn ?? []).map((d) => handleToId.get(d) ?? d),
    };
  });

  // Link tasks back to usage nodes for graph traceability.
  const usageIdByKey = new Map<string, string>();
  for (const res of registry.resolutions) {
    if (res.finding === null) continue;
    const u = res.usage;
    usageIdByKey.set(
      `${u.file}:${u.start.line}:${u.end.line}`,
      usageNodeId(u.file, u.start.line, u.start.column, u.catalogFindingId),
    );
  }
  const graph = appendTaskNodes(graphBuild.graph, tasks, usageIdByKey);

  return {
    graph,
    tasks,
    issues: [...registry.issues, ...graphBuild.issues, ...built.issues, ...orderResult.issues],
  };
}
