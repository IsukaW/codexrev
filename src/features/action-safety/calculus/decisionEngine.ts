/**
 * The Decision Engine: combines the weighted Safety Score with the Critical
 * Safety Gate results into one of ALLOW / ESCALATE / BLOCK.
 *
 * Two steps, always in this order:
 *   1. Score -> preliminary decision, using configurable thresholds:
 *        score >= allowAtOrAbove                   -> ALLOW
 *        escalateAtOrAbove <= score < allowAtOrAbove -> ESCALATE
 *        score < escalateAtOrAbove                 -> BLOCK
 *   2. Gates constrain it (constrainDecision in gates.ts):
 *        any triggered gate that requires BLOCK    -> BLOCK
 *        else any triggered gate that escalates    -> at least ESCALATE
 *        else the preliminary decision stands.
 *
 * So a gate can only make the outcome stricter, never looser: a perfect score
 * cannot beat a blocking gate, and an ESCALATE gate can never end in ALLOW.
 * A gate is triggered when its status is FAIL or UNKNOWN, so missing or
 * unknown mandatory evidence never counts as passing.
 *
 * The gate summary passed in is NOT trusted: the engine recomputes it from the
 * raw gate results and rejects the input if the two disagree.
 *
 * Pure and deterministic. No LLM, no I/O, no clock. It only produces a
 * decision; it never executes, approves or rolls back anything.
 */

import { CodexrevError } from '../../../utils/errors.js';
import type { Decision, GateConsequence, GateId, GateResult, GateStatus, NormalizedScore } from '../model/types.js';
import type { ActionSafetyResult } from './calculus.js';
import { constrainDecision, summarizeGateResults, type GateEvaluation } from './gates.js';

export class DecisionInputError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_ACTION_SAFETY_DECISION_INPUT_ERROR', false);
    this.name = 'DecisionInputError';
  }
}

export interface DecisionPolicy {
  /** names this threshold configuration in results */
  readonly id: string;
  /** true while the thresholds are illustrative and not yet calibrated by research evaluation */
  readonly provisional: boolean;
  /** score at or above this -> ALLOW (before gates) */
  readonly allowAtOrAbove: number;
  /** score at or above this, and below allowAtOrAbove -> ESCALATE; below it -> BLOCK */
  readonly escalateAtOrAbove: number;
}

/**
 * PROVISIONAL, ILLUSTRATIVE THRESHOLDS. These are starting values, not
 * research findings, and must be calibrated during the research evaluation.
 */
export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  id: 'score-thresholds-provisional-v1',
  provisional: true,
  allowAtOrAbove: 0.8,
  escalateAtOrAbove: 0.5,
};

/**
 * Scores come out of the calculus unrounded, so a score that is mathematically
 * exactly 0.80 can arrive as 0.7999999999999999. A score within this distance
 * below a threshold counts as being at it. 1e-12 is far above floating-point
 * noise and far below any real difference in a score.
 */
export const SCORE_COMPARISON_EPSILON = 1e-12;

export type DecisionReasonCode =
  | 'SCORE_AT_OR_ABOVE_ALLOW_THRESHOLD'
  | 'SCORE_IN_ESCALATE_BAND'
  | 'SCORE_BELOW_ESCALATE_THRESHOLD'
  | 'ALL_GATES_CLEAR'
  | `GATE_${GateId}_FAILED`
  | `GATE_${GateId}_UNKNOWN`
  | 'GATES_OVERRODE_SCORE_DECISION'
  | 'FINAL_ALLOW'
  | 'FINAL_ESCALATE'
  | 'FINAL_BLOCK';

export interface ActionDecisionResult {
  readonly decision: Decision;
  /** what the score alone would have decided, before the gates were applied */
  readonly preliminaryDecision: Decision;
  readonly safetyScore: NormalizedScore;
  /** the threshold configuration used */
  readonly thresholds: {
    readonly id: string;
    readonly provisional: boolean;
    readonly allowAtOrAbove: number;
    readonly escalateAtOrAbove: number;
  };
  /** the scoring configuration that produced the score, passed through for traceability */
  readonly scoringConfig: { readonly id: string; readonly provisional: boolean };
  readonly gateResults: readonly GateResult[];
  /** gates with status FAIL or UNKNOWN, recomputed by the engine */
  readonly triggeredGates: readonly GateResult[];
  /** the strictest consequence among triggered gates, or null if none triggered */
  readonly gateConsequence: GateConsequence | null;
  /** true only when the gates made the final decision different from the score-based one */
  readonly gatesOverrodeScore: boolean;
  readonly reasonCodes: readonly DecisionReasonCode[];
  readonly explanation: string;
}

const GATE_IDS_RECORD: Readonly<Record<GateId, true>> = {
  AUTHORIZATION: true,
  HUMAN_APPROVAL: true,
  VERIFIED_RECOVERY: true,
  BUILD_TEST_RESULTS: true,
  SUPPORTING_EVIDENCE: true,
};
// the record above makes TypeScript fail to compile if a GateId is ever added and forgotten here
const GATE_IDS = Object.keys(GATE_IDS_RECORD) as readonly GateId[];
const GATE_STATUSES: readonly GateStatus[] = ['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'];

export function validateDecisionPolicy(policy: DecisionPolicy): void {
  if (typeof policy.id !== 'string' || policy.id.length === 0) throw new DecisionInputError('decision policy id must be a non-empty string');
  if (typeof policy.provisional !== 'boolean') throw new DecisionInputError('decision policy "provisional" must be true or false');
  for (const [name, v] of [
    ['allowAtOrAbove', policy.allowAtOrAbove],
    ['escalateAtOrAbove', policy.escalateAtOrAbove],
  ] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new DecisionInputError(`decision threshold ${name} must be a finite number (got ${String(v)})`);
    if (v < 0 || v > 1) throw new DecisionInputError(`decision threshold ${name} must be between 0 and 1 (got ${v})`);
  }
  if (!(policy.escalateAtOrAbove < policy.allowAtOrAbove)) {
    throw new DecisionInputError(
      `escalateAtOrAbove (${policy.escalateAtOrAbove}) must be strictly below allowAtOrAbove (${policy.allowAtOrAbove})`,
    );
  }
}

function validateCalculus(calculus: ActionSafetyResult): void {
  const s: unknown = calculus?.safetyScore;
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1) {
    throw new DecisionInputError(`safetyScore must be a finite number between 0 and 1 (got ${String(s)})`);
  }
}

// checks every gate result is well-formed and present exactly once, then
// recomputes the summary and compares it with the one the caller supplied
function recomputeGateSummary(gates: GateEvaluation): GateEvaluation {
  if (!gates || !Array.isArray(gates.results)) throw new DecisionInputError('gate evaluation must contain a results array');
  const seen = new Set<GateId>();
  for (const r of gates.results) {
    if (!r || !(GATE_IDS as readonly string[]).includes(r.gate)) {
      throw new DecisionInputError(`gate evaluation contains an unknown gate: ${JSON.stringify(r?.gate)}`);
    }
    if (seen.has(r.gate)) throw new DecisionInputError(`gate evaluation contains gate ${r.gate} more than once`);
    seen.add(r.gate);
    if (!GATE_STATUSES.includes(r.status)) throw new DecisionInputError(`gate ${r.gate} has an invalid status: ${JSON.stringify(r.status)}`);
    if (r.consequence !== 'BLOCK' && r.consequence !== 'ESCALATE') {
      throw new DecisionInputError(`gate ${r.gate} has an invalid consequence: ${JSON.stringify(r.consequence)}`);
    }
    if (typeof r.explanation !== 'string' || !Array.isArray(r.evidenceRefs)) {
      throw new DecisionInputError(`gate ${r.gate} result is malformed (explanation or evidenceRefs)`);
    }
  }
  const absent = GATE_IDS.filter((g) => !seen.has(g));
  if (absent.length > 0) {
    throw new DecisionInputError(`gate evaluation is missing gate result(s): ${absent.join(', ')} (a skipped gate cannot be treated as passing)`);
  }

  const recomputed = summarizeGateResults(gates.results);
  const suppliedIds = Array.isArray(gates.triggered) ? gates.triggered.map((t) => t?.gate).sort().join(',') : null;
  const recomputedIds = recomputed.triggered.map((t) => t.gate).sort().join(',');
  if (suppliedIds !== recomputedIds || gates.consequence !== recomputed.consequence) {
    throw new DecisionInputError(
      `gate evaluation summary is inconsistent with its results: supplied triggered=[${suppliedIds}] consequence=${String(gates.consequence)}, ` +
        `recomputed triggered=[${recomputedIds}] consequence=${String(recomputed.consequence)}`,
    );
  }
  return recomputed;
}

function scoreDecision(score: number, policy: DecisionPolicy): { decision: Decision; code: DecisionReasonCode } {
  if (score >= policy.allowAtOrAbove - SCORE_COMPARISON_EPSILON) return { decision: 'ALLOW', code: 'SCORE_AT_OR_ABOVE_ALLOW_THRESHOLD' };
  if (score >= policy.escalateAtOrAbove - SCORE_COMPARISON_EPSILON) return { decision: 'ESCALATE', code: 'SCORE_IN_ESCALATE_BAND' };
  return { decision: 'BLOCK', code: 'SCORE_BELOW_ESCALATE_THRESHOLD' };
}

const show = (n: number): string => n.toFixed(3);

export function decideAction(
  calculus: ActionSafetyResult,
  gates: GateEvaluation,
  policy: DecisionPolicy = DEFAULT_DECISION_POLICY,
): ActionDecisionResult {
  validateDecisionPolicy(policy);
  validateCalculus(calculus);
  const evaluation = recomputeGateSummary(gates);

  const score = calculus.safetyScore;
  const { decision: preliminaryDecision, code: scoreCode } = scoreDecision(score, policy);
  const decision = constrainDecision(preliminaryDecision, evaluation);
  const gatesOverrodeScore = decision !== preliminaryDecision;

  const triggered = evaluation.triggered;
  const passed = evaluation.results.filter((r) => r.status === 'PASS');
  const notRequired = evaluation.results.filter((r) => r.status === 'NOT_APPLICABLE');

  const reasonCodes: DecisionReasonCode[] = [scoreCode];
  if (triggered.length === 0) reasonCodes.push('ALL_GATES_CLEAR');
  for (const t of triggered) reasonCodes.push(t.status === 'FAIL' ? `GATE_${t.gate}_FAILED` : `GATE_${t.gate}_UNKNOWN`);
  if (gatesOverrodeScore) reasonCodes.push('GATES_OVERRODE_SCORE_DECISION');
  reasonCodes.push(`FINAL_${decision}`);

  // ---- explanation, built only from the inputs, never claiming anything ran
  const scoreLine =
    `Score: the Safety Score ${show(score)} maps to ${preliminaryDecision} ` +
    (preliminaryDecision === 'ALLOW'
      ? `(at or above the ALLOW threshold ${show(policy.allowAtOrAbove)}).`
      : preliminaryDecision === 'ESCALATE'
        ? `(at or above ${show(policy.escalateAtOrAbove)} and below ${show(policy.allowAtOrAbove)}).`
        : `(below ${show(policy.escalateAtOrAbove)}).`) +
    ` Thresholds "${policy.id}"${policy.provisional ? ' are provisional and not yet calibrated' : ''}.`;

  const gateLines: string[] = [];
  if (passed.length > 0) gateLines.push(`Gates passed: ${passed.map((g) => g.gate).join(', ')}.`);
  if (notRequired.length > 0) gateLines.push(`Gates not required by policy: ${notRequired.map((g) => g.gate).join(', ')}.`);
  for (const t of triggered) {
    gateLines.push(`Gate ${t.gate} ${t.status === 'FAIL' ? 'FAILED' : 'has UNKNOWN evidence'} and requires ${t.consequence}: ${t.explanation}`);
  }
  if (triggered.length === 0) gateLines.push('No Critical Safety Gate was triggered.');

  const finalLine = gatesOverrodeScore
    ? `The gates changed the decision from ${preliminaryDecision} to ${decision}, because ` +
      (evaluation.consequence === 'BLOCK' ? 'at least one triggered gate requires BLOCK' : 'a triggered gate requires at least ESCALATE') +
      ', and a gate can only make a decision stricter.'
    : triggered.length > 0
      ? `The triggered gate(s) did not change the decision, because the score-based decision ${preliminaryDecision} is already at least as strict.`
      : 'The gates did not change the score-based decision.';

  const explanation =
    [scoreLine, ...gateLines, finalLine, `Final decision: ${decision}.`].join(' ') +
    ' This is an assessment only; no action was executed.';

  return {
    decision,
    preliminaryDecision,
    safetyScore: score,
    thresholds: {
      id: policy.id,
      provisional: policy.provisional,
      allowAtOrAbove: policy.allowAtOrAbove,
      escalateAtOrAbove: policy.escalateAtOrAbove,
    },
    scoringConfig: { id: calculus.config.id, provisional: calculus.config.provisional },
    gateResults: evaluation.results.map((r) => ({ ...r })),
    triggeredGates: triggered.map((r) => ({ ...r })),
    gateConsequence: evaluation.consequence,
    gatesOverrodeScore,
    reasonCodes,
    explanation,
  };
}
