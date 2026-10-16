/**
 * Feature 3 / Function 1 — plan rendering (Phase P6).
 *
 * Deterministic serializers for the MigrationPlan contract:
 *   - `renderPlanJson`: stable JSON (schema-conformant, no timestamps)
 *   - `renderPlanMarkdown`: human-readable report with summary, evidence
 *     provenance, priorities + reasons, and explicit limitations
 */

import type { MigrationPlan } from './types.js';

export function renderPlanJson(plan: MigrationPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderPlanMarkdown(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push('# Migration Plan');
  lines.push('');
  lines.push(`- **Schema version:** ${plan.schemaVersion}`);
  lines.push(`- **Project:** ${plan.project.manifest?.name ?? '(unnamed)'} (${plan.project.ecosystem}) — \`${plan.project.manifestPath ?? 'no manifest'}\``);
  lines.push(`- **Migration target:** \`${plan.request.dependencyName}\` ${plan.request.currentVersion} → ${plan.request.targetVersion} (${plan.request.migration.kind})`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Files scanned | ${plan.summary.filesScanned} |`);
  lines.push(`| Files affected | ${plan.summary.filesAffected} |`);
  lines.push(`| Findings (confirmed / total) | ${plan.summary.confirmedCount} / ${plan.summary.findingCount} |`);
  lines.push(`| Unresolved items | ${plan.summary.unresolvedCount} |`);
  lines.push(`| Tasks | ${plan.summary.taskCount} |`);
  lines.push(`| Issues | ${plan.issues.length} |`);
  lines.push('');

  lines.push('## Dependencies');
  lines.push('');
  if (plan.dependencies.length === 0) {
    lines.push('_(none reported)_');
  } else {
    lines.push('| Package | Relation | Declared | Resolved | Scope | Evidence ref |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const d of plan.dependencies) {
      lines.push(
        `| ${escapeCell(d.name)} | ${d.relation} | ${escapeCell(d.declaredRange ?? '(none)')} | ${escapeCell(d.resolvedVersion ?? '(unknown)')} | ${d.scope} | ${escapeCell(d.evidence.source?.ref ?? '-')} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Compatibility findings');
  lines.push('');
  if (plan.findings.length === 0) {
    lines.push('_No catalog findings apply — absence of data is NOT evidence of compatibility._');
  } else {
    lines.push('| Id | Kind | Severity | Status | Source |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const f of plan.findings) {
      lines.push(
        `| ${escapeCell(f.id)} | ${f.kind} | ${f.severity} | ${f.status} | ${escapeCell(f.evidence.source?.uri ?? f.evidence.source?.ref ?? '-')} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Impact graph');
  lines.push('');
  const nodeKinds = new Map<string, number>();
  for (const n of plan.impact.nodes) nodeKinds.set(n.type, (nodeKinds.get(n.type) ?? 0) + 1);
  const edgeKinds = new Map<string, number>();
  for (const e of plan.impact.edges) edgeKinds.set(e.kind, (edgeKinds.get(e.kind) ?? 0) + 1);
  lines.push(`- Nodes (${plan.impact.nodes.length}): ${[...nodeKinds.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  lines.push(`- Edges (${plan.impact.edges.length}): ${[...edgeKinds.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  lines.push('');

  lines.push('## Migration tasks (deterministic order)');
  lines.push('');
  if (plan.tasks.length === 0) {
    lines.push('_(no actionable tasks)_');
  } else {
    for (const t of plan.tasks) {
      const target =
        t.target.dependency !== undefined
          ? `dependency \`${t.target.dependency}\``
          : `\`${t.target.file}:${t.target.lineStart}\``;
      lines.push(`### ${t.id} — ${t.kind} (${t.priority}, ${t.strategy})`);
      lines.push('');
      lines.push(`- Target: ${target}`);
      lines.push(`- Rationale: ${escapeCell(t.rationale)}`);
      if (t.dependsOn.length > 0) lines.push(`- Requires: ${t.dependsOn.join(', ')}`);
      if (t.unresolvedReason !== undefined) lines.push(`- Unresolved: ${escapeCell(t.unresolvedReason)}`);
      if (t.priorityReasons !== undefined && t.priorityReasons.length > 0) {
        lines.push('- Priority reasons:');
        for (const r of t.priorityReasons) lines.push(`  - ${escapeCell(r)}`);
      }
      lines.push('');
    }
  }

  lines.push('## Issues');
  lines.push('');
  if (plan.issues.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const i of plan.issues) {
      lines.push(`- **${i.severity}** \`${i.code}\`: ${escapeCell(i.message)}`);
    }
  }
  lines.push('');

  lines.push('## Limitations');
  lines.push('');
  lines.push('- Prioritization tiers are PROVISIONAL engineering assumptions — not experimentally validated risk scores.');
  lines.push('- Unknown or missing compatibility data is reported as unknown, never as "compatible".');
  lines.push('- This is an analysis and planning output only: no source files were modified (read-only guarantee).');
  lines.push('');
  return lines.join('\n');
}
