/**
 * The Action-Safety coordinator: connects the existing Feature 4 modules, in
 * order, into one assessment. It adds no scoring or decision logic of its own;
 * every number and every decision comes from the module that owns it.
 *
 *   evidence bundle
 *     -> evidenceAdapters          (assessor and gate inputs, with the trust and freshness rules)
 *     -> assessReversibility / assessBlastRadius / assessAuthority / assessEvidenceStrength
 *     -> calculateSafetyScore      (SafetyScore = aR + b(1-B) + gA + dE, from the four REAL results)
 *     -> evaluateGates             (five Critical Safety Gates, independent of the score)
 *     -> decideAction              (score thresholds, then gates may only make it stricter)
 *     -> constrainDecisionByInterpretation  (a mandatory-but-unusable interpretation prevents ALLOW)
 *
 * The local-model interpretation is advisory. It is passed through and
 * reported, and it can influence the outcome in exactly one way: when a policy
 * makes it MANDATORY and it is unavailable or invalid, which can only make the
 * decision stricter. Its observations never touch a factor, a gate or a score.
 *
 * Results keep three decisions apart so nothing is hidden:
 *   preliminaryDecision   what the score alone says
 *   deterministicDecision after the Critical Safety Gates
 *   finalDecision         after the interpretation policy
 *
 * Outcomes:
 *   COMPLETED                   a decision was reached with every required input
 *   INCOMPLETE_INTERPRETATION   interpretation was mandatory but not completed; the
 *                               conservative decision is reported, flagged as limited
 *   FAILED                      the assessment could not be completed (invalid input
 *                               or an internal error); there is NO decision at all
 *
 * Pure and deterministic for a given bundle, interpretation, policy and `now`.
 * It never executes the proposed action and performs no I/O.
 */

import { DEFAULT_CALCULUS_CONFIG, calculateSafetyScore, type ActionSafetyResult, type CalculusConfig } from '../calculus/calculus.js';
import { assessAuthority } from '../calculus/authority.js';
import { assessBlastRadius } from '../calculus/blastRadius.js';
import { DEFAULT_DECISION_POLICY, DecisionInputError, decideAction, type ActionDecisionResult, type DecisionPolicy, type DecisionReasonCode } from '../calculus/decisionEngine.js';
import { assessEvidenceStrength } from '../calculus/evidenceStrength.js';
import { GatePolicyError, evaluateGates, evaluateRecoveryGate, type GateEvaluation, type GatePolicy } from '../calculus/gates.js';
import { assessReversibility } from '../calculus/reversibility.js';
import { FactorInputError } from '../calculus/scoring.js';
import type { EvidenceBundle } from '../collectors/evidenceOrchestrator.js';
import {
  toAuthorityInput,
  toBlastRadiusInput,
  toEvidenceStrengthInput,
  toGateInputs,
  toProposedAction,
  toReversibilityInput,
} from '../collectors/evidenceAdapters.js';
import { maskSecrets } from '../interpretation/contextBuilder.js';
import {
  DEFAULT_INTERPRETATION_POLICY,
  InterpretationPolicyError,
  constrainDecisionByInterpretation,
  type InterpretationConstraint,
  type InterpretationPolicy,
} from '../interpretation/policy.js';
import type { ContextInterpretation } from '../interpretation/types.js';
import type { Decision, FactorAssessment, FactorId, ProposedAction } from '../model/types.js';

/**
 * PROVISIONAL gate policy, used only when the input file states none. It is
 * deliberately conservative and not specific to any environment: every gate is
 * mandatory, and verified recovery is required for irreversible actions and for
 * anything of medium or higher impact. A project that wants different rules
 * states them in the input file's `policy`.
 */
export const DEFAULT_GATE_POLICY: GatePolicy = {
  authorization: { required: true },
  humanApproval: { required: true },
  recovery: { required: true, whenIrreversible: true, minImpact: 'medium' },
  buildTests: { required: true },
  supportingEvidence: { required: true },
};

export interface AssessmentPolicy {
  /** weights for R, B, A, E (provisional defaults) */
  readonly calculus: CalculusConfig;
  /** score thresholds (provisional defaults) */
  readonly decision: DecisionPolicy;
  /** which gates are mandatory; falls back to the bundle's policy, then to DEFAULT_GATE_POLICY */
  readonly gates?: GatePolicy;
  /** advisory by default */
  readonly interpretation: InterpretationPolicy;
}

export interface AssessmentInputs {
  /** collected evidence; it also carries the validated action type, target environment and stated details */
  readonly bundle: EvidenceBundle;
  readonly interpretation: ContextInterpretation;
  /** ISO time used for every freshness check, so the result is reproducible */
  readonly now: string;
  readonly policy?: Partial<AssessmentPolicy>;
}

export type InterpretationReasonCode =
  | 'INTERPRETATION_COMPLETED'
  | `INTERPRETATION_${'UNAVAILABLE' | 'INVALID_RESPONSE' | 'ERROR'}_ADVISORY`
  | `INTERPRETATION_${'UNAVAILABLE' | 'INVALID_RESPONSE' | 'ERROR'}_MANDATORY`
  | 'INTERPRETATION_POLICY_RAISED_DECISION'
  | `FINAL_DECISION_${Decision}`;

export type AssessmentReasonCode = DecisionReasonCode | InterpretationReasonCode;

export interface PolicyInUse {
  readonly calculusConfigId: string;
  readonly calculusProvisional: boolean;
  readonly decisionPolicyId: string;
  readonly decisionPolicyProvisional: boolean;
  /** where the gate policy came from; 'default_provisional' means nobody stated one */
  readonly gatePolicySource: 'assessment_policy' | 'input_file' | 'default_provisional';
  readonly interpretationPolicy: InterpretationPolicy;
}

export interface AssessmentSuccess {
  readonly status: 'COMPLETED' | 'INCOMPLETE_INTERPRETATION';
  readonly action: ProposedAction;
  /** after the interpretation policy: the decision to act on */
  readonly finalDecision: Decision;
  /** after the Critical Safety Gates, before the interpretation policy */
  readonly deterministicDecision: Decision;
  /** from the Safety Score alone */
  readonly preliminaryDecision: Decision;
  readonly safetyScore: number;
  readonly factors: Readonly<Record<FactorId, FactorAssessment>>;
  readonly calculus: ActionSafetyResult;
  readonly gates: GateEvaluation;
  /** the full Decision Engine result */
  readonly decision: ActionDecisionResult;
  readonly interpretation: ContextInterpretation;
  readonly interpretationConstraint: InterpretationConstraint;
  /** true if the interpretation policy changed the outcome */
  readonly interpretationRaisedDecision: boolean;
  readonly policy: PolicyInUse;
  readonly reasonCodes: readonly AssessmentReasonCode[];
  /** evidence the assessors or gates found missing, uncertain or contradictory, tagged by source */
  readonly evidenceGaps: {
    readonly missing: readonly string[];
    readonly uncertain: readonly string[];
    readonly conflicts: readonly string[];
  };
  /** conservative assumptions that were needed because the input was silent */
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
  readonly explanation: string;
  /** notice that weights, thresholds and/or the gate policy are provisional research values */
  readonly provisionalNotice: string;
  /** always false: this tool assesses, it never performs the proposed action */
  readonly executed: false;
}

export interface AssessmentFailure {
  readonly status: 'FAILED';
  /** which step could not complete */
  readonly stage: string;
  /** invalid_input = the request or a policy is unusable; internal_error = anything unexpected */
  readonly failureKind: 'invalid_input' | 'internal_error';
  readonly reason: string;
  /** deliberately no decision of any kind */
  readonly executed: false;
}

export type AssessmentOutcome = AssessmentSuccess | AssessmentFailure;

class StageError extends Error {
  constructor(
    readonly stage: string,
    readonly cause_: unknown,
  ) {
    super(String((cause_ as Error)?.message ?? cause_));
  }
}

function inStage<T>(stage: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new StageError(stage, err);
  }
}

const isInputProblem = (e: unknown): boolean =>
  e instanceof FactorInputError || e instanceof DecisionInputError || e instanceof GatePolicyError || e instanceof InterpretationPolicyError;

function failure(stage: string, err: unknown): AssessmentFailure {
  const message = maskSecrets(String((err as Error)?.message ?? err).split('\n')[0].slice(0, 300)).text;
  return { status: 'FAILED', stage, failureKind: isInputProblem(err) ? 'invalid_input' : 'internal_error', reason: message, executed: false };
}

function tag(prefix: string, items: readonly string[]): string[] {
  return items.map((i) => `[${prefix}] ${i}`);
}

export function assessAction(inputs: AssessmentInputs): AssessmentOutcome {
  try {
    return assess(inputs);
  } catch (err) {
    if (err instanceof StageError) return failure(err.stage, err.cause_);
    return failure('coordinator', err);
  }
}

function assess(inputs: AssessmentInputs): AssessmentSuccess {
  const { bundle, interpretation, now } = inputs;
  const calculusConfig = inputs.policy?.calculus ?? DEFAULT_CALCULUS_CONFIG;
  const decisionPolicy = inputs.policy?.decision ?? DEFAULT_DECISION_POLICY;
  const interpretationPolicy = inputs.policy?.interpretation ?? DEFAULT_INTERPRETATION_POLICY;
  const gatePolicy = inputs.policy?.gates ?? bundle.policy ?? DEFAULT_GATE_POLICY;
  const gatePolicySource: PolicyInUse['gatePolicySource'] = inputs.policy?.gates ? 'assessment_policy' : bundle.policy ? 'input_file' : 'default_provisional';

  // 1-2. the validated action, and what the gates are allowed to see (trusted and fresh evidence only)
  const { action, assumptions: actionAssumptions } = inStage('evidence adapters', () => toProposedAction(bundle));
  const gateInputs = inStage('evidence adapters', () => toGateInputs(bundle));
  const gateInput = { action, authority: gateInputs.authority, evidence: gateInputs.evidence, policy: gatePolicy };

  // evidence strength counts a kind as required only if the matching gate asks for it
  // (recovery only when the recovery gate applies to this action)
  const recoveryApplies = inStage('gate policy', () => evaluateRecoveryGate(gateInput).status !== 'NOT_APPLICABLE');
  const required = {
    buildTests: gatePolicy.buildTests.required,
    securityFindings: gatePolicy.supportingEvidence.required,
    recoveryVerification: recoveryApplies,
  };

  // 3-6. the four independent factor assessors, on normalized evidence
  const reversibilityAdapter = inStage('evidence adapters', () => toReversibilityInput(bundle, now));
  const reversibility = inStage('reversibility', () => assessReversibility(reversibilityAdapter.input));
  const blastRadius = inStage('blast radius', () => assessBlastRadius(toBlastRadiusInput(bundle)));
  const authority = inStage('authority', () => assessAuthority(toAuthorityInput(bundle, now)));
  const evidenceStrength = inStage('evidence strength', () => assessEvidenceStrength(toEvidenceStrengthInput(bundle, now, required)));

  // 7. the weighted calculus, from the four real results
  const calculus = inStage('safety calculus', () => calculateSafetyScore([reversibility, blastRadius, authority, evidenceStrength], calculusConfig));

  // 8. the Critical Safety Gates, independent of the score
  const gates = inStage('critical safety gates', () => evaluateGates(gateInput));

  // 9. score thresholds, then the gates (which can only make the decision stricter)
  const decision = inStage('decision engine', () => decideAction(calculus, gates, decisionPolicy));

  // 10. the interpretation policy, applied after the deterministic decision
  const constraint = inStage('interpretation policy', () => constrainDecisionByInterpretation(decision.decision, interpretation, interpretationPolicy));
  const finalDecision = constraint.decision;
  const incomplete = interpretationPolicy.mandatory && interpretation.status !== 'COMPLETED';

  const reasonCodes: AssessmentReasonCode[] = [...decision.reasonCodes];
  if (interpretation.status === 'COMPLETED') reasonCodes.push('INTERPRETATION_COMPLETED');
  else reasonCodes.push(`INTERPRETATION_${interpretation.status}_${interpretationPolicy.mandatory ? 'MANDATORY' : 'ADVISORY'}` as InterpretationReasonCode);
  if (constraint.changed) reasonCodes.push('INTERPRETATION_POLICY_RAISED_DECISION');
  reasonCodes.push(`FINAL_DECISION_${finalDecision}`);

  const factors = { reversibility, blastRadius, authority, evidenceStrength };
  const all = Object.entries(factors) as Array<[FactorId, FactorAssessment]>;
  const evidenceGaps = {
    missing: all.flatMap(([id, f]) => tag(id, f.missing)),
    uncertain: all.flatMap(([id, f]) => tag(id, f.uncertain)),
    conflicts: all.flatMap(([id, f]) => tag(id, f.conflicts)),
  };

  const assumptions = [...actionAssumptions, ...reversibilityAdapter.assumptions.filter((a) => !actionAssumptions.includes(a))];
  const stated = bundle.statedAction.blastRadius;
  if (stated && Object.keys(stated).length > 0) {
    assumptions.push('blast-radius dimensions (' + Object.keys(stated).join(', ') + ') come from the input file as stated estimates, not from observation');
  }

  const limitations = [...bundle.limitations, ...interpretation.limitations];
  if (incomplete) {
    limitations.push(
      `interpretation is mandatory by policy but ${interpretation.status}${interpretation.reason ? ` (${interpretation.reason})` : ''}: this assessment is INCOMPLETE and the reported decision is the policy's conservative outcome`,
    );
  } else if (interpretation.status !== 'COMPLETED') {
    limitations.push(`local-model interpretation was ${interpretation.status} and is advisory by policy: it did not affect the decision`);
  }

  const explanation =
    `${decision.explanation} ` +
    (interpretation.status === 'COMPLETED'
      ? `The local model supplied ${interpretation.observations.length} unverified observation(s); they are advisory and did not change any score, gate or decision.`
      : `Local-model interpretation was ${interpretation.status}${interpretation.reason ? ` (${interpretation.reason})` : ''}. ` +
        (interpretationPolicy.mandatory
          ? constraint.changed
            ? `Because interpretation is mandatory, ALLOW is not permitted: the decision was raised from ${decision.decision} to ${finalDecision}. This assessment is INCOMPLETE.`
            : `Interpretation is mandatory, so this assessment is INCOMPLETE, but the deterministic decision ${decision.decision} was already at least as strict.`
          : 'It is advisory by policy, so it did not affect the decision.')) +
    ` Final decision: ${finalDecision}. The proposed action was NOT executed.`;

  const provisional: string[] = [];
  if (calculusConfig.provisional) provisional.push(`weights "${calculusConfig.id}"`);
  if (decisionPolicy.provisional) provisional.push(`score thresholds "${decisionPolicy.id}"`);
  if (gatePolicySource === 'default_provisional') provisional.push('the default gate policy (none was stated in the input)');
  const provisionalNotice = provisional.length > 0
    ? `Provisional research values are in use: ${provisional.join(', ')}. They are illustrative and have not been calibrated by research evaluation.`
    : 'All weights, thresholds and policies in use were explicitly configured.';

  return {
    status: incomplete ? 'INCOMPLETE_INTERPRETATION' : 'COMPLETED',
    action,
    finalDecision,
    deterministicDecision: decision.decision,
    preliminaryDecision: decision.preliminaryDecision,
    safetyScore: calculus.safetyScore,
    factors,
    calculus,
    gates,
    decision,
    interpretation,
    interpretationConstraint: constraint,
    interpretationRaisedDecision: constraint.changed,
    policy: {
      calculusConfigId: calculusConfig.id,
      calculusProvisional: calculusConfig.provisional,
      decisionPolicyId: decisionPolicy.id,
      decisionPolicyProvisional: decisionPolicy.provisional,
      gatePolicySource,
      interpretationPolicy,
    },
    reasonCodes,
    evidenceGaps,
    assumptions,
    limitations,
    explanation,
    provisionalNotice,
    executed: false,
  };
}
