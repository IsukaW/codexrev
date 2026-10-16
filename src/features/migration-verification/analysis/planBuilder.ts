/**
 * Feature 3 / Function 1 — final analysis pipeline & MigrationPlan assembly
 * (Phase P6).
 *
 * `runAnalyzePipeline` chains the existing phases without duplicating logic:
 *   P1 request (already validated) -> P2 dependency analysis ->
 *   P3 compatibility lookup -> P4 source analysis -> P5 planMigration ->
 *   MigrationPlan (schemaVersion 0.3.0) assembly.
 *
 * Honesty rules preserved end-to-end:
 *   - no npm project identified => AnalysisPipelineError (CLI exit 1);
 *     the pipeline never fabricates a plan for an unanalyzable project.
 *   - warnings/unresolved findings/cycle diagnostics stay in plan.issues.
 *   - deterministic: no timestamps; equivalent inputs + unchanged project
 *     state produce equivalent serialized plans.
 */

import { CodexrevError } from '../../../utils/errors.js';
import type {
  AnalysisIssue,
  AnalyzeRequest,
  DependencyInfo,
  ImpactGraph,
  MigrationPlan,
  MigrationTask,
  ProjectInfo,
} from './types.js';
import { analyzeDependencies } from './dependencyAnalyzer.js';
import { lookupCompatibility, type CompatLookupResult } from './compat/lookup.js';
import { analyzeSourceUsages, type SourceAnalysisResult } from './source/sourceAnalyzer.js';
import { planMigration } from './planning.js';

export class AnalysisPipelineError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_MIGRATION_ANALYSIS_FAILED', false);
    this.name = 'AnalysisPipelineError';
  }
}

export interface PlanAssemblyInput {
  request: AnalyzeRequest;
  project: ProjectInfo;
  dependencies: readonly DependencyInfo[];
  compatLookups: readonly CompatLookupResult[];
  sourceAnalysis: SourceAnalysisResult;
  impact: ImpactGraph;
  tasks: readonly MigrationTask[];
  planningIssues: readonly AnalysisIssue[];
  dependencyIssues: readonly AnalysisIssue[];
}

/** Pure assembler: MigrationPlan per the existing schema contract. */
export function assembleMigrationPlan(input: PlanAssemblyInput): MigrationPlan {
  const findingById = new Map<string, MigrationPlan['findings'][number]>();
  for (const lookup of input.compatLookups) {
    for (const f of lookup.findings) if (!findingById.has(f.id)) findingById.set(f.id, f);
  }
  const findings = [...findingById.values()];

  const findingIds = new Set(findings.map((f) => f.id));
  const unlinkedUsages = input.sourceAnalysis.usages.filter((u) => !findingIds.has(u.catalogFindingId));

  const issues: AnalysisIssue[] = [
    ...input.dependencyIssues,
    ...input.compatLookups.flatMap((l) => l.issues),
    ...input.sourceAnalysis.issues,
    ...input.planningIssues,
  ];

  const issuesByCode: Record<string, number> = {};
  for (const issue of issues) issuesByCode[issue.code] = (issuesByCode[issue.code] ?? 0) + 1;

  return {
    schemaVersion: '0.3.0',
    request: input.request,
    project: input.project,
    dependencies: [...input.dependencies],
    findings,
    impact: input.impact,
    tasks: [...input.tasks],
    issues,
    summary: {
      filesScanned: input.sourceAnalysis.filesScanned,
      filesAffected: new Set(input.sourceAnalysis.usages.map((u) => u.file)).size,
      findingCount: findings.length,
      confirmedCount: findings.filter((f) => f.status === 'confirmed').length,
      // Unresolved = findings whose version boundary was not confirmed PLUS
      // usages that could not be linked to any finding. Never conflated
      // with "safe".
      unresolvedCount:
        findings.filter((f) => f.status === 'unresolved').length + unlinkedUsages.length,
      taskCount: input.tasks.length,
      issuesByCode,
    },
  };
}

export interface AnalyzePipelineResult {
  plan: MigrationPlan;
  sourceAnalysis: SourceAnalysisResult;
}

/**
 * End-to-end pipeline over an already-validated request. Throws
 * `AnalysisPipelineError` when no npm project can be identified (the
 * pipeline never invents project data).
 */
export async function runAnalyzePipeline(request: AnalyzeRequest): Promise<AnalyzePipelineResult> {
  const deps = await analyzeDependencies({
    projectRoot: request.projectPath,
    targetDependency: request.dependencyName,
    targetVersion: request.targetVersion,
  });
  if (deps.project === null) {
    const detail = deps.issues.map((i) => i.message).join('; ') || 'unknown reason';
    throw new AnalysisPipelineError(`could not analyze project: ${detail}`);
  }

  // Compatibility lookup is catalog-driven for the migration target.
  const compatLookups: CompatLookupResult[] = [
    lookupCompatibility({ package: request.dependencyName, targetVersion: request.targetVersion }),
  ];

  const sourceAnalysis = await analyzeSourceUsages({
    projectRoot: request.projectPath,
    compatLookups,
  });

  const planned = planMigration({
    dependencies: deps.dependencies,
    compatLookups,
    usages: sourceAnalysis.usages,
  });

  const plan = assembleMigrationPlan({
    request,
    project: deps.project,
    dependencies: deps.dependencies,
    compatLookups,
    sourceAnalysis,
    impact: planned.graph,
    tasks: planned.tasks,
    planningIssues: planned.issues,
    dependencyIssues: deps.issues,
  });

  return { plan, sourceAnalysis };
}
