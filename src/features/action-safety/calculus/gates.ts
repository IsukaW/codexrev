/**
 * Critical Safety Gates: pure, deterministic yes/no checks that run
 * independently of the weighted Safety Score. No LLM, no I/O, no clock.
 *
 * How a gate is judged:
 *   - policy says the gate is not required  -> NOT_APPLICABLE
 *   - evidence PASS                         -> PASS
 *   - evidence FAIL                         -> FAIL
 *   - evidence UNKNOWN, or marked NOT_APPLICABLE although policy requires it
 *     -> UNKNOWN
 *   - evidence missing entirely: FAIL for the control gates (authorization,
 *     recovery), UNKNOWN for the evidence gates (tests, supporting)
 *
 * Only PASS and NOT_APPLICABLE let an action through. FAIL and UNKNOWN both
 * trigger the gate's consequence, so unknown is never treated as safe.
 *
 * Consequences: authorization, recovery and build/test gates always BLOCK.
 * Supporting evidence defaults to ESCALATE and the policy may raise it to BLOCK.
 *
 * FOUR gates: authorization, recovery, build/test and supporting evidence. (An earlier design had a fifth,
 * independent per-action human-approval gate. It was removed: authority now comes from administrator-signed,
 * reusable role grants, verified by the Authorization gate.)
 */

import { CodexrevError } from '../../../utils/errors.js';
import {
  IMPACT_LEVELS,
  type Decision,
  type EvidenceItem,
  type GateConsequence,
  type GateId,
  type GateResult,
  type GateStatus,
  type ImpactLevel,
  type ProposedAction,
  type AuthorityContext,
  type EvidenceSnapshot,
} from '../model/types.js';

export class GatePolicyError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_ACTION_SAFETY_GATE_POLICY_ERROR', false);
    this.name = 'GatePolicyError';
  }
}

/** Policy for a gate whose consequence is fixed (always BLOCK). */
export interface FixedGateRule {
  readonly required: boolean;
}

/** Policy for a gate whose consequence can be configured. Omitted = ESCALATE. */
export interface ConfigurableGateRule {
  readonly required: boolean;
  readonly consequence?: GateConsequence;
}

export interface RecoveryGateRule {
  readonly required: boolean;
  /** require verified recovery for irreversible actions */
  readonly whenIrreversible: boolean;
  /** require verified recovery for actions at or above this impact level */
  readonly minImpact?: ImpactLevel;
}

/**
 * Says which gates are mandatory. There is deliberately no default policy:
 * the caller states every rule, so no production policy is baked in here.
 */
export interface GatePolicy {
  readonly authorization: FixedGateRule;
  readonly recovery: RecoveryGateRule;
  readonly buildTests: FixedGateRule;
  readonly supportingEvidence: ConfigurableGateRule;
}

export interface GateInput {
  readonly action: ProposedAction;
  readonly authority: AuthorityContext;
  readonly evidence: EvidenceSnapshot;
  readonly policy: GatePolicy;
}

export interface GateEvaluation {
  readonly results: readonly GateResult[];
  /** gates that did not pass and are required, i.e. the ones that force a consequence */
  readonly triggered: readonly GateResult[];
  /** 'BLOCK' if any triggered gate blocks, else 'ESCALATE' if any escalates, else null (no constraint) */
  readonly consequence: GateConsequence | null;
}

function validateConsequence(gate: GateId, value: unknown): GateConsequence {
  if (value === 'BLOCK' || value === 'ESCALATE') return value;
  throw new GatePolicyError(`policy for gate ${gate} has an invalid consequence: ${JSON.stringify(value)} (expected BLOCK or ESCALATE)`);
}

function refsOf(item: EvidenceItem | undefined): readonly string[] {
  return item?.refs ? [...item.refs] : [];
}

function notRequired(gate: GateId, consequence: GateConsequence, why: string): GateResult {
  return { gate, status: 'NOT_APPLICABLE', explanation: `Not required by policy: ${why}`, evidenceRefs: [], consequence };
}

interface JudgeParams {
  readonly gate: GateId;
  readonly label: string;
  readonly item: EvidenceItem | undefined;
  readonly missingStatus: Extract<GateStatus, 'FAIL' | 'UNKNOWN'>;
  readonly consequence: GateConsequence;
}

// shared judging for a required gate, see the table at the top of the file
function judge(p: JudgeParams): GateResult {
  const { gate, label, item, consequence } = p;
  const base = { gate, evidenceRefs: refsOf(item), consequence };
  if (!item) {
    return { ...base, status: p.missingStatus, explanation: `${label} is required but no record was provided.` };
  }
  switch (item.status) {
    case 'PASS':
      return { ...base, status: 'PASS', explanation: `${label} confirmed.` };
    case 'FAIL':
      return { ...base, status: 'FAIL', explanation: `${label} failed.` };
    case 'UNKNOWN':
      return { ...base, status: 'UNKNOWN', explanation: `${label} could not be determined.` };
    case 'NOT_APPLICABLE':
      // policy requires it, so the record cannot claim it does not apply
      return {
        ...base,
        status: 'UNKNOWN',
        explanation: `${label} is required by policy but was marked NOT_APPLICABLE, which is not accepted for a mandatory gate.`,
      };
  }
}

export function evaluateAuthorizationGate(input: GateInput): GateResult {
  const rule = input.policy.authorization;
  if (!rule.required) return notRequired('AUTHORIZATION', 'BLOCK', 'authorization gate disabled');
  return judge({
    gate: 'AUTHORIZATION',
    label: `Authorization for actor "${input.authority.actor.id}"`,
    item: input.authority.authorization,
    missingStatus: 'FAIL',
    consequence: 'BLOCK',
  });
}

function impactRank(level: ImpactLevel): number {
  return IMPACT_LEVELS.indexOf(level);
}

// recovery is only demanded when policy asks for it AND this action matches
// one of the policy's triggers (irreversible, or impact at/above a threshold)
function recoveryRequired(input: GateInput): { required: boolean; why: string } {
  const rule = input.policy.recovery;
  if (!rule.required) return { required: false, why: 'recovery gate disabled' };
  const { irreversible, impact } = input.action;
  if (rule.whenIrreversible && irreversible) return { required: true, why: 'action is irreversible' };
  if (rule.minImpact !== undefined && impactRank(impact) >= impactRank(rule.minImpact)) {
    return { required: true, why: `impact "${impact}" is at or above "${rule.minImpact}"` };
  }
  return { required: false, why: 'action is neither irreversible nor above the impact threshold' };
}

export function evaluateRecoveryGate(input: GateInput): GateResult {
  const need = recoveryRequired(input);
  if (!need.required) return notRequired('VERIFIED_RECOVERY', 'BLOCK', need.why);
  return judge({
    gate: 'VERIFIED_RECOVERY',
    label: `Verified recovery (${need.why})`,
    item: input.evidence.recovery,
    missingStatus: 'FAIL',
    consequence: 'BLOCK',
  });
}

export function evaluateBuildTestGate(input: GateInput): GateResult {
  const rule = input.policy.buildTests;
  if (!rule.required) return notRequired('BUILD_TEST_RESULTS', 'BLOCK', 'build/test gate disabled');
  return judge({
    gate: 'BUILD_TEST_RESULTS',
    label: 'Build/test results',
    item: input.evidence.buildTests,
    missingStatus: 'UNKNOWN',
    consequence: 'BLOCK',
  });
}

export function evaluateSupportingEvidenceGate(input: GateInput): GateResult {
  const rule = input.policy.supportingEvidence;
  const consequence = validateConsequence('SUPPORTING_EVIDENCE', rule.consequence ?? 'ESCALATE');
  if (!rule.required) return notRequired('SUPPORTING_EVIDENCE', consequence, 'supporting-evidence gate disabled');
  return judge({
    gate: 'SUPPORTING_EVIDENCE',
    label: 'Supporting evidence',
    item: input.evidence.supporting,
    missingStatus: 'UNKNOWN',
    consequence,
  });
}

// PASS and NOT_APPLICABLE are the only statuses that do not trigger a gate
function isTriggered(r: GateResult): boolean {
  return r.status === 'FAIL' || r.status === 'UNKNOWN';
}

/**
 * Derives the summary (triggered gates and overall consequence) from raw gate
 * results. evaluateGates uses it, and the Decision Engine uses it to recompute
 * the summary of a GateEvaluation it was handed instead of trusting its fields.
 */
export function summarizeGateResults(results: readonly GateResult[]): GateEvaluation {
  const triggered = results.filter(isTriggered);
  const consequence: GateConsequence | null = triggered.some((r) => r.consequence === 'BLOCK')
    ? 'BLOCK'
    : triggered.length > 0
      ? 'ESCALATE'
      : null;
  return { results, triggered, consequence };
}

/** Runs all four gates, each on its own. Takes no Safety Score, so it cannot be influenced by one. */
export function evaluateGates(input: GateInput): GateEvaluation {
  return summarizeGateResults([
    evaluateAuthorizationGate(input),
    evaluateRecoveryGate(input),
    evaluateBuildTestGate(input),
    evaluateSupportingEvidenceGate(input),
  ]);
}

/**
 * Applies gate results to a decision that came from somewhere else (later,
 * the weighted score). A decision can only get stricter, never looser:
 * a BLOCK gate forces BLOCK, an ESCALATE gate turns ALLOW into ESCALATE,
 * and with no triggered gate the proposed decision is returned unchanged.
 */
export function constrainDecision(proposed: Decision, evaluation: GateEvaluation): Decision {
  if (evaluation.consequence === 'BLOCK') return 'BLOCK';
  if (evaluation.consequence === 'ESCALATE') return proposed === 'BLOCK' ? 'BLOCK' : 'ESCALATE';
  return proposed;
}
