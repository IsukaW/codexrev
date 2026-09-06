/**
 * Codexrev — Feature 2 (review-pipeline) Resolver Engine.
 *
 * Turns the six roles' verdicts into exactly one final decision —
 * Approve / Request Changes / Block — using the weighted scoring from
 * Section 2 (configurable via `settings.reviewPipeline.resolverWeights`,
 * Phase 3), plus the conflict rules from Section 2:
 *
 *   - "Sec always wins on exploitability": if the Security Auditor's
 *     own verdict is 'block', the final decision is forced to Block
 *     regardless of the weighted score.
 *   - "BA + QA both flag the same issue → upgrade severity by 1": when
 *     a BA finding and a QA finding land on the same file with
 *     overlapping line ranges, both are treated as independently
 *     corroborated and their severity is bumped one level
 *     (`bumpSeverity()`, Phase 3). If that bump reaches 'critical', the
 *     decision floor is raised to at least Request Changes.
 *
 * Neither the exact score thresholds (Approve/Request Changes/Block
 * cutoffs) nor the severity-bump-forces-a-floor rule are given verbatim
 * in the guide — logged as Phase 6 decisions (see the Decision Log in
 * `../README.md`).
 *
 * Scoring formula, revised post-Phase-8: the original per-role
 * contribution was `weight × verdictScore` alone (pass=0/flag=0.5/
 * block=1) — it threw away two signals the role contract already
 * carries: `confidence` (a low-confidence 'block' swung the score
 * exactly as hard as a certain one) and the actual `severity` of a
 * role's findings (a 'flag' with one 'info'-level nit scored identically
 * to a 'flag' citing a 'critical' CWE). `roleRiskScore()` below blends
 * verdict, worst-finding severity, and confidence — see its own
 * docstring for the exact math, and the Decision Log for why this
 * redesign happened.
 */

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

/** One finding from any role, tagged with its origin and (if a conflict rule fired) its pre-bump severity. */
export interface ResolvedFinding extends Finding {
  readonly role: RoleId;
  /** Present only when a conflict rule changed `severity` from what the role originally reported. */
  readonly originalSeverity?: Severity;
}

/** A conflict rule that fired during resolution — kept for the audit trail and the Phase 7 report. */
export interface ConflictRuleApplication {
  readonly rule: 'sec-exploitability-veto' | 'ba-qa-overlap-severity-bump';
  readonly description: string;
  readonly affectedFindingIds: readonly string[];
}

export interface ResolverResult {
  readonly decision: ResolverDecision;
  /** Final weighted risk score, clamped to [0, 1]. Higher = more likely to Block. */
  readonly score: number;
  /** Each role's contribution to `score` (weight × verdict score for BA/Dev/Sec/QA/PM; the additive Build-failure term for Build). */
  readonly perRoleContribution: Readonly<Partial<Record<RoleId, number>>>;
  readonly resolvedFindings: readonly ResolvedFinding[];
  readonly appliedRules: readonly ConflictRuleApplication[];
  /** Plain-English explanation of how the decision was reached (Usability NFR). */
  readonly rationale: string;
  /** Roles that had no output when this resolution ran (partial pipeline run — skip/abort). */
  readonly missingRoles: readonly RoleId[];
}

const VERDICT_SCORE: Readonly<Record<Verdict, number>> = { pass: 0, flag: 0.5, block: 1 };

/** Point value of each severity level, for the finding-evidence half of `roleRiskScore()`. */
const SEVERITY_POINTS: Readonly<Record<Severity, number>> = {
  info: 0.1,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1.0,
};

/** BA/Dev/Sec/QA/PM share the configurable weighted split (Build is scored separately — see below). */
const WEIGHTED_ROLES: readonly RoleId[] = ['ba', 'dev', 'sec', 'qa', 'pm'];

function maxFindingSeverityPoints(findings: readonly Finding[]): number {
  if (findings.length === 0) return 0;
  return Math.max(...findings.map((f) => SEVERITY_POINTS[f.severity]));
}

/**
 * A role's risk contribution BEFORE its resolver weight is applied,
 * blending three signals:
 *
 *   1. The role's own verdict (`pass`/`flag`/`block`) — its holistic
 *      judgment call, which may rest on things a single finding's
 *      severity label doesn't fully capture.
 *   2. The worst individual finding's severity — an evidence-based
 *      floor/ceiling that protects against a role under-calling its own
 *      verdict for something severe (e.g. verdicting only 'flag' while
 *      citing a 'critical'-severity CWE finding; `max()` below means the
 *      severity wins in that case). Multiple findings beyond the worst
 *      one add a small, capped bonus — ten 'medium' issues are worse
 *      than one, but not ten times worse.
 *   3. The role's own stated `confidence` — a low-confidence verdict
 *      should not swing the final decision as hard as a certain one.
 *
 * Returns a value in [0, 1]; the caller multiplies by that role's
 * configured weight.
 */
export function roleRiskScore(output: RoleOutput): number {
  const verdictBase = VERDICT_SCORE[output.verdict];
  const severityBase = maxFindingSeverityPoints(output.findings);
  const countBonus = output.findings.length > 1 ? Math.min(0.15, 0.03 * (output.findings.length - 1)) : 0;
  const evidenceBase = Math.min(1, severityBase + countBonus);
  return Math.max(verdictBase, evidenceBase) * output.confidence;
}

// Score thresholds — a Phase 6 judgment call, not given verbatim in the guide (see Decision Log).
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

/**
 * Applies the "BA + QA same issue → severity+1" conflict rule. Returns
 * the full pooled `ResolvedFinding[]` from every role that ran (with
 * any bumped severities applied) plus the rule application record, if
 * it fired at least once.
 */
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

/**
 * Resolves the final decision from whatever role outputs are available.
 * Missing roles (a Skip/Abort stopped the pipeline early — Phase 5)
 * simply contribute 0 to the score; `missingRoles` records which ones,
 * so the rationale and the audit log stay honest about a partial run.
 */
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

  // Build stays a flat all-or-nothing weight (not the severity-scaled
  // roleRiskScore above) — deliberately: build.ts only ever assigns
  // 'high' severity to a genuine compiler error and reserves 'block' for
  // exactly that case, while a 'flag' there means "couldn't run the
  // tool" (an environment gap, not evidence of a code problem) and must
  // contribute nothing. Reusing roleRiskScore would need Build's own
  // "environment issue" findings excluded from the severity math to
  // preserve that distinction — not worth the complexity when Build's
  // severity grading is already effectively binary in practice.
  const buildOutput = roleOutputs.build;
  const buildContribution = buildOutput?.verdict === 'block' ? weights.buildFailure : 0;
  perRoleContribution.build = buildContribution;

  const score = clamp01(baseScore + buildContribution);
  let decision = scoreToDecision(score);

  const appliedRules: ConflictRuleApplication[] = [];

  // Conflict rule: Sec always wins on exploitability.
  const secOutput = roleOutputs.sec;
  if (secOutput?.verdict === 'block') {
    decision = atLeast(decision, 'block');
    appliedRules.push({
      rule: 'sec-exploitability-veto',
      description: 'Security Auditor found an exploitable issue — this forces Block regardless of the weighted score.',
      affectedFindingIds: secOutput.findings.map((f) => f.id),
    });
  }

  // Conflict rule: BA + QA same issue → severity+1.
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

  const missingRoles = (['ba', 'dev', 'build', 'sec', 'qa', 'pm'] as const).filter((r) => !roleOutputs[r]);

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

  const verdictSummary = (['ba', 'dev', 'build', 'sec', 'qa', 'pm'] as const)
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

/**
 * Maps a `ResolverDecision` to the non-interactive exit code — 0 =
 * Approve, 1 = Block, per Section 2's exit-code table. "Request
 * Changes" isn't in that table; per the guide's own instruction to
 * propose and log a mapping, it's treated as exit code 1 for CI
 * purposes (a script gating on `$? === 0` should not proceed on
 * anything short of Approve). Exit code 2 ("Escalate") is reserved for
 * Phase 8's Breaker-Builder exhaustion path — the Resolver itself never
 * emits it.
 */
export function exitCodeForDecision(decision: ResolverDecision): 0 | 1 {
  return decision === 'approve' ? 0 : 1;
}
