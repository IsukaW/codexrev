// Turns six role verdicts into one final decision (Approve/Request Changes/Block)
// using weighted scoring (weights configurable via settings.reviewPipeline.resolverWeights)
// plus two conflict rules:
//
// - Architect always wins on architectural integrity: if Architect's own verdict
//   is 'block', final decision is forced to Block no matter what the weighted
//   score says. This fires because a role's own judgement that a change breaks
//   the system's architectural integrity (a boundary crossed, a resource leaked,
//   a sensitive-data flow that shouldn't exist) shouldn't be out-voted by an
//   average across roles that weren't looking at that lens at all.
// - BA + QA flagging the same spot independently counts as corroboration —
//   bump both findings' severity one level. If that bump reaches critical,
//   the decision floor goes up to at least Request Changes.
//
// The exact score thresholds and the "bump forces a floor" rule aren't spelled
// out anywhere upstream, they're our own call (see the Decision Log in ../README.md).
//
// roleRiskScore() blends verdict + worst finding severity + confidence instead
// of just weight * verdictScore, because the naive version let a low-confidence
// 'block' swing the score as hard as a certain one, and a 'flag' with one info-level
// nit scored the same as a 'flag' citing a critical CWE.

import {
  bumpSeverity,
  ROLE_LABELS,
  type Finding,
  type RoleId,
  type RoleOutput,
  type Severity,
  type Verdict,
} from '../roles/roleContract.js';
import type { ReviewPipelineResolverWeights } from '../../../config/schema.js';

export type ResolverDecision = 'approve' | 'request_changes' | 'block';

export const RESOLVER_DECISION_LABELS: Readonly<Record<ResolverDecision, string>> = {
  approve: 'Approve',
  request_changes: 'Request Changes',
  block: 'Block',
};

export interface ResolvedFinding extends Finding {
  readonly role: RoleId;
  readonly originalSeverity?: Severity; // set only when a conflict rule bumped severity
}

// a conflict rule that fired during resolution, kept for the audit trail / report
export interface ConflictRuleApplication {
  readonly rule: 'architect-integrity-veto' | 'ba-qa-overlap-severity-bump';
  readonly description: string;
  readonly affectedFindingIds: readonly string[];
}

export interface ResolverResult {
  readonly decision: ResolverDecision;
  readonly score: number; // clamped [0,1], higher = more likely to block
  readonly perRoleContribution: Readonly<Partial<Record<RoleId, number>>>; // weight * risk score per role, Build's is the flat additive term
  readonly resolvedFindings: readonly ResolvedFinding[];
  readonly appliedRules: readonly ConflictRuleApplication[];
  readonly rationale: string;
  readonly missingRoles: readonly RoleId[]; // no output when this ran, i.e. a partial run (skip/abort)
}

const VERDICT_SCORE: Readonly<Record<Verdict, number>> = { pass: 0, flag: 0.5, block: 1 };

const SEVERITY_POINTS: Readonly<Record<Severity, number>> = {
  info: 0.1,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1.0,
};

// BA/Architect/Dev/QA/PM share the configurable weight split; Build is scored separately below
const WEIGHTED_ROLES: readonly RoleId[] = ['ba', 'architect', 'dev', 'qa', 'pm'];

function maxFindingSeverityPoints(findings: readonly Finding[]): number {
  if (findings.length === 0) return 0;
  return Math.max(...findings.map((f) => SEVERITY_POINTS[f.severity]));
}

// A role's risk contribution before its weight is applied. Blends the role's
// own verdict, the worst finding's severity (so a role can't under-call itself
// by saying 'flag' while citing a critical CWE — max() lets severity win), a
// small capped bonus for extra findings beyond the worst one (ten mediums are
// worse than one, but not 10x worse), and confidence (a shaky verdict shouldn't
// swing the decision as hard as a certain one). Returns [0,1].
export function roleRiskScore(output: RoleOutput): number {
  const verdictBase = VERDICT_SCORE[output.verdict];
  const severityBase = maxFindingSeverityPoints(output.findings);
  const countBonus = output.findings.length > 1 ? Math.min(0.15, 0.03 * (output.findings.length - 1)) : 0;
  const evidenceBase = Math.min(1, severityBase + countBonus);
  return Math.max(verdictBase, evidenceBase) * output.confidence;
}

// thresholds are our own call, not spelled out upstream (see Decision Log)
const BLOCK_THRESHOLD = 0.6;
const REQUEST_CHANGES_THRESHOLD = 0.3;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function scoreToDecision(score: number): ResolverDecision {
  if (score >= BLOCK_THRESHOLD) return 'block';
  if (score >= REQUEST_CHANGES_THRESHOLD) return 'request_changes';
  return 'approve';
}

const DECISION_RANK: Readonly<Record<ResolverDecision, number>> = { approve: 0, request_changes: 1, block: 2 };

function atLeast(decision: ResolverDecision, floor: ResolverDecision): ResolverDecision {
  return DECISION_RANK[floor] > DECISION_RANK[decision] ? floor : decision;
}

function rangesOverlap(a: Finding, b: Finding): boolean {
  return a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
}

// applies the BA+QA overlap bump, returns the pooled findings from every role
// that ran plus the rule-application record if it fired at least once
function applyBaQaOverlapRule(
  roleOutputs: Readonly<Partial<Record<RoleId, RoleOutput>>>,
): { resolvedFindings: ResolvedFinding[]; application?: ConflictRuleApplication } {
  const bumpedIds = new Set<string>();
  const baFindings = roleOutputs.ba?.findings ?? [];
  const qaFindings = roleOutputs.qa?.findings ?? [];

  for (const ba of baFindings) {
    for (const qa of qaFindings) {
      if (ba.file === qa.file && rangesOverlap(ba, qa)) {
        bumpedIds.add(`ba:${ba.id}`);
        bumpedIds.add(`qa:${qa.id}`);
      }
    }
  }

  const resolvedFindings: ResolvedFinding[] = [];
  for (const role of Object.keys(roleOutputs) as RoleId[]) {
    const output = roleOutputs[role];
    if (!output) continue;
    for (const finding of output.findings) {
      const key = `${role}:${finding.id}`;
      if (bumpedIds.has(key)) {
        resolvedFindings.push({ ...finding, role, severity: bumpSeverity(finding.severity), originalSeverity: finding.severity });
      } else {
        resolvedFindings.push({ ...finding, role });
      }
    }
  }

  if (bumpedIds.size === 0) return { resolvedFindings };

  return {
    resolvedFindings,
    application: {
      rule: 'ba-qa-overlap-severity-bump',
      description:
        'Business Analyst and QA Engineer independently flagged the same location — treated as corroborated and bumped one severity level.',
      affectedFindingIds: [...bumpedIds],
    },
  };
}

// resolves the final decision from whatever role outputs exist. missing roles
// (a skip/abort stopped the pipeline early) just contribute 0 to the score —
// missingRoles records which ones so the rationale stays honest about a partial run
export function resolve(
  roleOutputs: Readonly<Partial<Record<RoleId, RoleOutput>>>,
  weights: ReviewPipelineResolverWeights,
): ResolverResult {
  const perRoleContribution: Partial<Record<RoleId, number>> = {};
  let weightSum = 0;
  let weightedTotal = 0;

  for (const role of WEIGHTED_ROLES) {
    const w = weights[role as Exclude<RoleId, 'build'>];
    weightSum += w;
    const output = roleOutputs[role];
    const contribution = output ? w * roleRiskScore(output) : 0;
    perRoleContribution[role] = contribution;
    weightedTotal += contribution;
  }
  const baseScore = weightSum > 0 ? weightedTotal / weightSum : 0;

  // Build stays flat all-or-nothing on purpose, not the severity-scaled score
  // above — it only ever assigns 'high' to a real compiler error and reserves
  // 'block' for that, while 'flag' there just means the tool couldn't run
  // (an environment gap, not a code problem) and should contribute nothing.
  // Reusing roleRiskScore would need Build's env-failure findings excluded
  // from the severity math, not worth it since Build's grading is basically binary anyway.
  const buildOutput = roleOutputs.build;
  const buildContribution = buildOutput?.verdict === 'block' ? weights.buildFailure : 0;
  perRoleContribution.build = buildContribution;

  const score = clamp01(baseScore + buildContribution);
  let decision = scoreToDecision(score);

  const appliedRules: ConflictRuleApplication[] = [];

  // Architect always wins on architectural integrity
  const architectOutput = roleOutputs.architect;
  if (architectOutput?.verdict === 'block') {
    decision = atLeast(decision, 'block');
    appliedRules.push({
      rule: 'architect-integrity-veto',
      description: 'Architect found an architectural-integrity violation — this forces Block regardless of the weighted score.',
      affectedFindingIds: architectOutput.findings.map((f) => f.id),
    });
  }

  // BA + QA same issue -> severity+1
  const { resolvedFindings, application } = applyBaQaOverlapRule(roleOutputs);
  if (application) {
    appliedRules.push(application);
    const reachedCritical = resolvedFindings.some(
      (f) => application.affectedFindingIds.includes(`${f.role}:${f.id}`) && f.severity === 'critical',
    );
    if (reachedCritical) {
      decision = atLeast(decision, 'request_changes');
    }
  }

  const missingRoles = (['ba', 'architect', 'dev', 'build', 'qa', 'pm'] as const).filter((r) => !roleOutputs[r]);

  const rationale = buildRationale(decision, score, roleOutputs, appliedRules, missingRoles);

  return {
    decision,
    score,
    perRoleContribution,
    resolvedFindings,
    appliedRules,
    rationale,
    missingRoles,
  };
}

function buildRationale(
  decision: ResolverDecision,
  score: number,
  roleOutputs: Readonly<Partial<Record<RoleId, RoleOutput>>>,
  appliedRules: readonly ConflictRuleApplication[],
  missingRoles: readonly RoleId[],
): string {
  const parts: string[] = [];
  parts.push(`Final decision: ${RESOLVER_DECISION_LABELS[decision]} (risk score ${score.toFixed(2)}).`);

  const verdictSummary = (['ba', 'architect', 'dev', 'build', 'qa', 'pm'] as const)
    .map((role) => {
      const output = roleOutputs[role];
      return output ? `${ROLE_LABELS[role]}: ${output.verdict}` : `${ROLE_LABELS[role]}: did not run`;
    })
    .join(', ');
  parts.push(`Role verdicts — ${verdictSummary}.`);

  for (const rule of appliedRules) {
    parts.push(`Rule applied — ${rule.description}`);
  }

  if (missingRoles.length > 0) {
    parts.push(
      `Note: this was a partial run — ${missingRoles.length} role(s) did not run (${missingRoles
        .map((r) => ROLE_LABELS[r])
        .join(', ')}). The decision above is based only on the roles that completed.`,
    );
  }

  return parts.join(' ');
}

// 0 = Approve, 1 = everything else (a CI script gating on $?===0 shouldn't
// proceed on Request Changes either). exit code 2 ("Escalate") belongs to the
// breaker-builder exhaustion path, the resolver itself never emits it.
export function exitCodeForDecision(decision: ResolverDecision): 0 | 1 {
  return decision === 'approve' ? 0 : 1;
}
