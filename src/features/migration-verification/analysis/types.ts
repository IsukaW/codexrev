/**
 * Feature 3 / Function 1 — core contracts.
 *
 * Compatibility Analysis & Migration Planning (proposal stages 1–4).
 * Mirrors section 3 of docs/feature03/function1_design_and_roadmap.md.
 * Nothing in Function 1 transforms code; it only analyzes and plans.
 */

/** Only 'node' (JavaScript/TypeScript, npm) is implemented. 'java' is a
 *  retained proposal requirement (Maven/Gradle) for a future phase. */
export type Technology = 'node';

export type MigrationConfig =
  | { kind: 'api-rename'; from: string; to: string }
  | { kind: 'dependency-upgrade'; package: string };

export interface AnalyzeRequest {
  projectPath: string;
  technology: Technology;
  dependencyName: string;
  /** REQUIRED (proposal: "source and target versions"). Syntax is validated
   *  in Function 1; version *comparison* is not implemented. */
  currentVersion: string;
  targetVersion: string;
  migration: MigrationConfig;
  compatDataPath?: string;
  upstreamFindingsPath?: string;
  rulesPaths?: string[];
  include?: string[];
  exclude?: string[];
  outputFormat?: 'json' | 'markdown';
  /** Write target for artifacts — must resolve OUTSIDE projectPath
   *  (analysis is read-only with respect to the target project). */
  outPath?: string;
}

export interface ProjectInfo {
  root: string;
  ecosystem: 'npm'; // future: 'maven' | 'gradle' | 'pip'
  manifestPath: string | null;
  manifest: {
    name: string | null;
    projectVersion: string | null;
    packageManager: 'npm';
  } | null;
  lockfilePath: string | null;
}

export interface DependencyConflict {
  message: string;
  evidence: Evidence;
}

export interface DependencyInfo {
  name: string;
  relation: 'direct' | 'transitive';
  declaredRange: string | null;
  resolvedVersion: string | null; // null = missing evidence (e.g. no lockfile data)
  scope: 'runtime' | 'dev' | 'optional' | 'peer' | 'unknown';
  targetVersion: string | null;
  conflicts: DependencyConflict[];
  evidence: Evidence;
}

export type EvidenceStatus = 'present' | 'missing' | 'not_applicable';

export interface Evidence {
  status: EvidenceStatus;
  source?: {
    kind:
      | 'supplied-compat-data'
      | 'builtin-catalog'
      | 'upstream-component'
      | 'manifest'
      | 'lockfile'
      | 'source-code'
      | 'heuristic';
    ref: string;
    uri?: string;
  };
  excerpt?: string;
  /** Heuristic evidence can never silently outrank exact evidence. */
  quality: 'exact' | 'heuristic';
}

export interface CompatibilityFinding {
  id: string;
  kind:
    | 'breaking-change'
    | 'deprecated-api'
    | 'api-rename'
    | 'behavior-change'
    | 'dependency-conflict'
    | 'transitive-risk'
    | 'version-constraint'
    | 'removed-api'
    | 'unresolved';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  dependency: string;
  api?: string;
  location?: { file: string; lineStart: number; lineEnd: number };
  message: string;
  evidence: Evidence;
  ruleId: string | null;
  status: 'confirmed' | 'suspected' | 'unresolved';
}

export interface MigrationRule {
  id: string;
  appliesTo: { technology: Technology; dependency?: string; versionRange?: string };
  match: { kind: 'api-rename'; api: string } | { kind: 'finding'; findingKind: CompatibilityFinding['kind'] };
  action: { type: 'rename'; from: string; to: string } | { type: 'manual-review'; note: string };
  source: { kind: 'builtin' | 'user'; ref: string; uri?: string };
  rationale: string;
}

export interface ImpactNode {
  type: 'file' | 'api' | 'dependency' | 'task' | 'finding' | 'usage';
  id: string;
  /** Human-readable node label (P5, optional). */
  label?: string;
  /** True when the node represents an unresolved/unknown relationship (P5). */
  unresolved?: boolean;
}

export interface ImpactEdge {
  from: string;
  to: string;
  kind: 'imports' | 'uses-api' | 'calls' | 'requires-before' | 'manifest-affects' | 'has-finding' | 'located-at' | 'covers';
  evidence: Evidence;
}

export interface ImpactGraph {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

export interface MigrationTask {
  id: string;
  priority: 'high' | 'medium' | 'low';
  kind: 'rename-usage' | 'update-manifest' | 'manual-review';
  target: { file?: string; lineStart?: number; lineEnd?: number; dependency?: string };
  ruleId: string | null;
  dependsOn: string[];
  /** Function 1 never generates code: 'unresolved'/'manual' tasks carry reasons. */
  strategy: 'deterministic-rule' | 'manual' | 'unresolved';
  rationale: string;
  unresolvedReason?: string;
  /** Structured explanations of why this priority was assigned (P5). */
  priorityReasons?: string[];
}

export type AnalysisIssueCode =
  | 'REQUEST_INVALID'
  | 'VERSION_INVALID'
  | 'MANIFEST_MISSING'
  | 'ECOSYSTEM_UNSUPPORTED'
  | 'LOCKFILE_MISSING'
  | 'COMPAT_DATA_UNAVAILABLE'
  | 'COMPAT_VERSION_UNEVALUATED'
  | 'DEPENDENCY_UNRESOLVED'
  | 'RULE_NOT_FOUND'
  | 'ORDER_CYCLE'
  | 'ANALYZER_FAILED';

export interface AnalysisIssue {
  code: AnalysisIssueCode;
  severity: 'error' | 'warning';
  message: string;
  context?: string;
}

export interface MigrationPlan {
  schemaVersion: '0.3.0';
  request: AnalyzeRequest;
  project: ProjectInfo;
  dependencies: DependencyInfo[];
  findings: CompatibilityFinding[];
  impact: ImpactGraph;
  tasks: MigrationTask[];
  issues: AnalysisIssue[];
  summary: {
    filesScanned: number;
    filesAffected: number;
    findingCount: number;
    confirmedCount: number;
    unresolvedCount: number;
    taskCount: number;
    issuesByCode: Record<string, number>;
  };
}
