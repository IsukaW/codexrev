/**
 * Feature 3 / Function 1 — deterministic task ordering (Phase P5).
 *
 * Kahn topological sort over `requires-before` prerequisites with a stable
 * ready-set comparator (priority desc, severity rank desc, direct-before-
 * transitive, then package/finding/file/line/column/id ascending).
 *
 * Cycles: tasks participating in a prerequisite cycle are EXCLUDED from the
 * order and reported via an ORDER_CYCLE issue — a cyclic graph never
 * silently claims a valid topological order.
 */

import type { AnalysisIssue, MigrationTask } from '../types.js';
import { analysisIssue } from '../issues.js';

const PRIORITY_RANK: Record<MigrationTask['priority'], number> = { high: 2, medium: 1, low: 0 };

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface TaskSortContext {
  /** severity rank (critical=5 … info=0); default 0 when unknown. */
  severityRank: number;
  /** 0 = direct dependency, 1 = transitive, 2 = unknown. */
  relationRank: number;
  dependency: string;
  findingId: string;
  file: string;
  line: number;
  column: number;
}

/** Stable comparator over (task, context). Identical inputs ⇒ identical order. */
export function compareTasks(
  [aTask, aCtx]: readonly [MigrationTask, TaskSortContext],
  [bTask, bCtx]: readonly [MigrationTask, TaskSortContext],
): number {
  return (
    PRIORITY_RANK[bTask.priority] - PRIORITY_RANK[aTask.priority] ||
    bCtx.severityRank - aCtx.severityRank ||
    aCtx.relationRank - bCtx.relationRank ||
    compareStrings(aCtx.dependency, bCtx.dependency) ||
    compareStrings(aCtx.findingId, bCtx.findingId) ||
    compareStrings(aCtx.file, bCtx.file) ||
    aCtx.line - bCtx.line ||
    aCtx.column - bCtx.column ||
    compareStrings(aTask.id, bTask.id)
  );
}

export interface TaskOrderResult {
  /** Tasks in deterministic order (acyclic prefix only). */
  order: MigrationTask[];
  /** Tasks excluded because they participate in a prerequisite cycle. */
  cyclic: MigrationTask[];
  issues: AnalysisIssue[];
}

/**
 * Order `tasks` respecting each task's `dependsOn` prerequisites.
 * `tasks` must carry unique ids; `dependsOn` refers to those ids.
 */
export function orderTasks(
  tasks: readonly MigrationTask[],
  contexts: ReadonlyMap<string, TaskSortContext>,
): TaskOrderResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const outgoing = new Map<string, string[]>(); // prereq -> dependents
  const indegree = new Map<string, number>();

  for (const t of tasks) {
    indegree.set(t.id, 0);
    outgoing.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) {
        // Unknown prerequisite — not fabricating an ordering constraint.
        continue;
      }
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      outgoing.get(dep)?.push(t.id);
    }
  }

  const ready = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0);
  const readyCmp = (a: MigrationTask, b: MigrationTask): number =>
    compareTasks(
      [a, contexts.get(a.id) ?? fallbackContext(a)],
      [b, contexts.get(b.id) ?? fallbackContext(b)],
    );
  ready.sort(readyCmp);

  const order: MigrationTask[] = [];
  const emitted = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift() as MigrationTask;
    order.push(next);
    emitted.add(next.id);
    for (const dependent of outgoing.get(next.id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        const t = byId.get(dependent);
        if (t !== undefined) {
          ready.push(t);
          ready.sort(readyCmp);
        }
      }
    }
  }

  const cyclic = tasks.filter((t) => !emitted.has(t.id));
  const issues: AnalysisIssue[] = [];
  if (cyclic.length > 0) {
    issues.push(
      analysisIssue(
        'ORDER_CYCLE',
        'error',
        `prerequisite cycle detected among tasks: ${cyclic.map((t) => t.id).sort(compareStrings).join(', ')} — no valid topological order exists for them`,
        cyclic.map((t) => t.id).sort(compareStrings).join(','),
      ),
    );
  }
  return { order, cyclic, issues };
}

function fallbackContext(t: MigrationTask): TaskSortContext {
  return {
    severityRank: 0,
    relationRank: 2,
    dependency: t.target.dependency ?? '',
    findingId: t.ruleId ?? '',
    file: t.target.file ?? '',
    line: t.target.lineStart ?? 0,
    column: 0,
  };
}
