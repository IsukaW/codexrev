/**
 * The weighted Action-Safety Calculus:
 *
 *   SafetyScore = alpha*R + beta*(1 - B) + gamma*A + delta*E
 *
 *   R = Reversibility     (higher = safer)
 *   B = Blast Radius      (higher = RISKIER, so it enters the sum as 1 - B)
 *   A = Authority         (higher = safer)
 *   E = Evidence Strength (higher = safer)
 *
 * This file only turns four already-computed FactorAssessments into one
 * number, with every step shown. It does NOT decide ALLOW / ESCALATE / BLOCK,
 * never looks at the Critical Safety Gates (they stay independent, and a high
 * score can never override a blocking gate), and never calls an LLM. Inputs
 * are validated and rejected if wrong, never silently clamped.
 */

import type { FactorAssessment, FactorId, NormalizedScore, SafetyFactors } from '../model/types.js';
import { FactorInputError } from './scoring.js';

/** alpha, beta, gamma, delta, keyed by the factor each one weighs. */
export type CalculusWeights = Readonly<Record<FactorId, number>>;

export interface CalculusConfig {
  /** names this configuration in results, so a score can be traced to the weights that made it */
  readonly id: string;
  /**
   * true while the weights are illustrative and not yet calibrated against
   * research evaluation data. Reported in every result.
   */
  readonly provisional: boolean;
  readonly weights: CalculusWeights;
}

/**
 * PROVISIONAL, ILLUSTRATIVE DEFAULT. Equal weights are a neutral starting
 * point, not a research finding. They must be calibrated during the research
 * evaluation before any result is reported as meaningful.
 */
export const DEFAULT_CALCULUS_CONFIG: CalculusConfig = {
  id: 'equal-weights-provisional-v1',
  provisional: true,
  weights: { reversibility: 0.25, blastRadius: 0.25, authority: 0.25, evidenceStrength: 0.25 },
};

/**
 * Weights must sum to 1 within this absolute tolerance. 1e-9 is far looser
 * than floating-point error for four numbers (about 1e-16) and far tighter
 * than any real mistake (a typo is off by 0.01 or more).
 */
export const WEIGHT_SUM_TOLERANCE = 1e-9;

export const FACTOR_IDS: readonly FactorId[] = ['reversibility', 'blastRadius', 'authority', 'evidenceStrength'];

const SYMBOLS: Readonly<Record<FactorId, 'R' | 'B' | 'A' | 'E'>> = {
  reversibility: 'R',
  blastRadius: 'B',
  authority: 'A',
  evidenceStrength: 'E',
};

/** One term of the sum, with the value that actually went into the formula. */
export interface CalculusTerm {
  readonly factor: FactorId;
  readonly symbol: 'R' | 'B' | 'A' | 'E';
  /** the factor's own score, exactly as assessed */
  readonly factorScore: NormalizedScore;
  /** the value used in the formula: the score itself, except Blast Radius which is 1 - B */
  readonly termValue: number;
  readonly weight: number;
  /** weight * termValue */
  readonly contribution: number;
}

export interface ActionSafetyResult {
  /** in [0, 1]; higher = safer. A score only, never a decision. */
  readonly safetyScore: NormalizedScore;
  /** the four original factor scores (blastRadius is B, not 1 - B) */
  readonly factors: SafetyFactors;
  readonly weights: CalculusWeights;
  /** weighted contribution of each factor to the score; blastRadius is weight * (1 - B) */
  readonly contributions: Readonly<Record<FactorId, number>>;
  /** 1 - B, the value Blast Radius takes in the formula */
  readonly adjustedBlastRadius: number;
  /** every term of the sum, in formula order */
  readonly terms: readonly CalculusTerm[];
  readonly formula: string;
  /** which scoring configuration produced this result */
  readonly config: { readonly id: string; readonly provisional: boolean };
  readonly explanation: string;
}

function validateWeights(config: CalculusConfig): void {
  const w = config.weights as Partial<Record<string, unknown>>;
  for (const key of Object.keys(w)) {
    if (!(FACTOR_IDS as readonly string[]).includes(key)) {
      throw new FactorInputError(`calculus weights contain an unknown factor: ${JSON.stringify(key)}`);
    }
  }
  let sum = 0;
  for (const id of FACTOR_IDS) {
    const v = w[id];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new FactorInputError(`calculus weight for ${id} must be a finite number (got ${String(v)})`);
    }
    if (v < 0) throw new FactorInputError(`calculus weight for ${id} must not be negative (got ${v})`);
    sum += v;
  }
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new FactorInputError(`calculus weights must sum to 1 (got ${sum}, tolerance ${WEIGHT_SUM_TOLERANCE})`);
  }
}

// exactly one assessment per factor, each with a valid score; nothing is clamped or defaulted
function extractFactors(assessments: readonly FactorAssessment[]): SafetyFactors {
  const found = new Map<FactorId, number>();
  for (const a of assessments) {
    const id: unknown = a?.factor;
    if (typeof id !== 'string' || !(FACTOR_IDS as readonly string[]).includes(id)) {
      throw new FactorInputError(`unknown factor identifier: ${JSON.stringify(id)}`);
    }
    const factor = id as FactorId;
    if (found.has(factor)) throw new FactorInputError(`duplicate assessment for factor ${factor}`);
    const score: unknown = a.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new FactorInputError(`score for ${factor} must be a finite number (got ${String(score)})`);
    }
    if (score < 0 || score > 1) throw new FactorInputError(`score for ${factor} must be between 0 and 1 (got ${score})`);
    found.set(factor, score);
  }
  const absent = FACTOR_IDS.filter((f) => !found.has(f));
  if (absent.length > 0) throw new FactorInputError(`missing assessment for factor(s): ${absent.join(', ')}`);
  return {
    reversibility: found.get('reversibility')!,
    blastRadius: found.get('blastRadius')!,
    authority: found.get('authority')!,
    evidenceStrength: found.get('evidenceStrength')!,
  };
}

// display only: the calculation itself never rounds
const show = (n: number): string => n.toFixed(3);

export function calculateSafetyScore(
  assessments: readonly FactorAssessment[],
  config: CalculusConfig = DEFAULT_CALCULUS_CONFIG,
): ActionSafetyResult {
  validateWeights(config);
  const factors = extractFactors(assessments);
  const { weights } = config;

  const terms: CalculusTerm[] = FACTOR_IDS.map((factor) => {
    const factorScore = factors[factor];
    const termValue = factor === 'blastRadius' ? 1 - factorScore : factorScore;
    return { factor, symbol: SYMBOLS[factor], factorScore, termValue, weight: weights[factor], contribution: weights[factor] * termValue };
  });

  const sum = terms.reduce((n, t) => n + t.contribution, 0);
  // inputs are already validated, so sum is in [0, 1] up to floating-point error;
  // this only removes that error (e.g. 1.0000000000000002), it never hides bad input
  const safetyScore = Math.min(1, Math.max(0, sum));

  const contributions = Object.fromEntries(terms.map((t) => [t.factor, t.contribution])) as Record<FactorId, number>;
  const adjustedBlastRadius = 1 - factors.blastRadius;

  const formula = 'SafetyScore = alpha*R + beta*(1 - B) + gamma*A + delta*E';
  const parts = terms
    .map((t) => `${show(t.weight)}*${t.symbol === 'B' ? '(1-B)' : t.symbol}(${show(t.termValue)})`)
    .join(' + ');
  const explanation =
    `Safety score ${show(safetyScore)} = ${parts} using configuration "${config.id}"` +
    (config.provisional ? ' (provisional weights, not yet calibrated)' : '') +
    '. This is a score only; the decision is made elsewhere and the Critical Safety Gates are evaluated separately.';

  return {
    safetyScore,
    factors,
    weights: { ...weights },
    contributions,
    adjustedBlastRadius,
    terms,
    formula,
    config: { id: config.id, provisional: config.provisional },
    explanation,
  };
}
