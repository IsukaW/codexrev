/**
 * Reversibility (R): how safely can the action be undone?
 * 0 = hard or impossible to undo, 1 = safely reversible. Higher is safer.
 *
 * Scoring, in plain steps:
 *   1. Three components, weighted (defaults 0.2 / 0.4 / 0.4):
 *        rollback plan exists    - existence only; a written plan proves nothing
 *        rollback tested         - needs fresh, trusted PASS evidence
 *        backup / recovery point - needs fresh, trusted PASS evidence
 *   2. No verified recovery (neither the test nor the backup is verified):
 *      cap the score at 0.25, so a plan plus stale or untrusted evidence can
 *      never look like real recovery.
 *   3. Irreversible actions are multiplied by 0.5, destructive ones by 0.8.
 *
 * Mandatory-recovery failures are the gates' job, not this score's.
 */

import type { EvidenceItem, FactorAssessment, ScoreAdjustment } from '../model/types.js';
import {
  DEFAULT_CREDIT_CONFIG,
  adjustScore,
  assertUnitInterval,
  creditFor,
  finalizeScore,
  hoursToMs,
  mergeConfig,
  parseNow,
  uniqueRefs,
  validateCreditConfig,
  validateWeights,
  weightedAverage,
  type Credit,
  type DeepPartial,
  type EvidenceCreditConfig,
  type RawComponent,
} from './scoring.js';

export interface ReversibilityConfig {
  readonly weights: { readonly rollbackPlan: number; readonly rollbackTest: number; readonly backup: number };
  readonly maxAgeHours: { readonly rollbackTest: number; readonly backup: number };
  readonly irreversiblePenalty: number;
  readonly destructivePenalty: number;
  readonly unverifiedRecoveryCap: number;
  readonly credit: EvidenceCreditConfig;
}

export const DEFAULT_REVERSIBILITY_CONFIG: ReversibilityConfig = {
  weights: { rollbackPlan: 0.2, rollbackTest: 0.4, backup: 0.4 },
  maxAgeHours: { rollbackTest: 168, backup: 168 },
  irreversiblePenalty: 0.5,
  destructivePenalty: 0.8,
  unverifiedRecoveryCap: 0.25,
  credit: DEFAULT_CREDIT_CONFIG,
};

export interface ReversibilityInput {
  /** ISO time used for freshness checks; passed in so results are reproducible */
  readonly now: string;
  /** the action cannot be undone by normal means */
  readonly irreversible: boolean;
  /** the action deletes or overwrites data/state */
  readonly destructive?: boolean;
  /** PASS = a rollback plan exists (written only, not proven) */
  readonly rollbackPlan?: EvidenceItem;
  /** PASS = the rollback was actually exercised successfully */
  readonly rollbackTest?: EvidenceItem;
  /** PASS = a verified backup or recovery point exists */
  readonly backup?: EvidenceItem;
  readonly config?: DeepPartial<ReversibilityConfig>;
}

export function assessReversibility(input: ReversibilityInput): FactorAssessment {
  const cfg = mergeConfig(DEFAULT_REVERSIBILITY_CONFIG, input.config);
  validateWeights('reversibility.weights', cfg.weights);
  validateCreditConfig(cfg.credit);
  assertUnitInterval('reversibility.irreversiblePenalty', cfg.irreversiblePenalty);
  assertUnitInterval('reversibility.destructivePenalty', cfg.destructivePenalty);
  assertUnitInterval('reversibility.unverifiedRecoveryCap', cfg.unverifiedRecoveryCap);
  const nowMs = parseNow(input.now);

  const missing: string[] = [];
  const uncertain: string[] = [];
  const conflicts: string[] = [];

  const planExists = input.rollbackPlan?.status === 'PASS';
  if (!input.rollbackPlan) missing.push('rollback plan');
  else if (input.rollbackPlan.status !== 'PASS' && input.rollbackPlan.status !== 'FAIL') {
    uncertain.push(`rollback plan: status ${input.rollbackPlan.status}`);
  }

  const test = creditFor('rollback test', input.rollbackTest, {
    nowMs,
    maxAgeMs: hoursToMs(cfg.maxAgeHours.rollbackTest),
    config: cfg.credit,
  });
  const backup = creditFor('backup', input.backup, {
    nowMs,
    maxAgeMs: hoursToMs(cfg.maxAgeHours.backup),
    config: cfg.credit,
  });
  for (const [label, c] of [['rollback test', test], ['backup', backup]] as const) {
    noteCredit(label, c, missing, uncertain);
  }

  if (input.rollbackTest?.status === 'PASS' && !planExists) {
    conflicts.push('rollback test reports PASS but no rollback plan is recorded');
  }

  const raw: RawComponent[] = [
    {
      name: 'rollback plan exists',
      weight: cfg.weights.rollbackPlan,
      value: planExists ? 1 : 0,
      note: planExists ? 'plan exists (existence only, not proof it works)' : 'no usable rollback plan',
      applied: true,
    },
    { name: 'rollback tested', weight: cfg.weights.rollbackTest, value: test.value, note: test.note, applied: true },
    { name: 'verified backup', weight: cfg.weights.backup, value: backup.value, note: backup.note, applied: true },
  ];
  const { score: base, breakdown } = weightedAverage(raw);

  const adjustments: ScoreAdjustment[] = [];
  let score = base;
  const verifiedRecovery = test.state === 'verified' || backup.state === 'verified';
  if (!verifiedRecovery) {
    score = adjustScore(
      adjustments,
      'unverified recovery cap',
      score,
      Math.min(score, cfg.unverifiedRecoveryCap),
      'neither a fresh trusted rollback test nor a fresh trusted backup exists, so recovery is not verified',
    );
  }
  if (input.irreversible) {
    score = adjustScore(adjustments, 'irreversible penalty', score, score * cfg.irreversiblePenalty, 'action is irreversible');
  }
  if (input.destructive) {
    score = adjustScore(adjustments, 'destructive penalty', score, score * cfg.destructivePenalty, 'action is destructive');
  }
  score = finalizeScore(score);

  const explanation =
    `Reversibility ${score.toFixed(2)}: ` +
    (verifiedRecovery ? 'verified recovery evidence exists' : 'no verified recovery (a written plan alone does not count)') +
    (input.irreversible ? '; action is irreversible' : '') +
    (input.destructive ? '; action is destructive' : '') +
    '.';

  return {
    factor: 'reversibility',
    score,
    explanation,
    evidenceRefs: uniqueRefs(input.rollbackPlan?.refs, input.rollbackTest?.refs, input.backup?.refs),
    missing,
    uncertain,
    conflicts,
    breakdown,
    adjustments,
  };
}

// sorts a credit result into the missing / uncertain lists
function noteCredit(label: string, c: Credit, missing: string[], uncertain: string[]): void {
  if (c.state === 'missing') missing.push(label);
  else if (c.state === 'unknown' || c.state === 'stale' || c.state === 'untrusted' || c.state === 'not_applicable') {
    uncertain.push(c.note);
  }
}
