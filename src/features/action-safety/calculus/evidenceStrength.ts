/**
 * Evidence Strength (E): how good is the evidence that this action is safe?
 * 0 = insufficient evidence, 1 = strong, reliable evidence. Higher is safer.
 *
 * Scoring, in plain steps:
 *   1. Four evidence kinds (build/tests, security findings, dependency
 *      compatibility, recovery verification) plus a completeness component,
 *      combined by weighted average (defaults 0.3 / 0.2 / 0.1 / 0.2 / 0.2).
 *   2. A kind's value is its WEAKEST record ("weakest link"). Each record is
 *      worth what scoring.ts creditFor() says: fresh trusted PASS is worth the
 *      source's reliability, stale is worth half of that, untrusted or failed
 *      or missing is worth nothing, unknown is worth almost nothing.
 *   3. A kind with both PASS and FAIL records is a conflict and is worth 0.
 *   4. A kind that is not required and has no records is left out (weights
 *      rescale). A required kind with no records scores 0 and is reported missing.
 *   5. If any applied kind failed or conflicts, the score is capped at 0.3.
 *   6. Nothing applied at all (no requirements and no evidence) scores 0:
 *      we never invent evidence.
 *
 * The Critical Safety Gates still decide on mandatory evidence, whatever this
 * score says.
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
  type DeepPartial,
  type EvidenceCreditConfig,
  type RawComponent,
} from './scoring.js';

export type EvidenceKind = 'buildTests' | 'securityFindings' | 'dependencyCompatibility' | 'recoveryVerification';

const EVIDENCE_KINDS: readonly EvidenceKind[] = ['buildTests', 'securityFindings', 'dependencyCompatibility', 'recoveryVerification'];

const KIND_LABELS: Readonly<Record<EvidenceKind, string>> = {
  buildTests: 'build/test results',
  securityFindings: 'security findings',
  dependencyCompatibility: 'dependency compatibility',
  recoveryVerification: 'recovery verification',
};

export interface EvidenceStrengthConfig {
  readonly weights: Readonly<Record<EvidenceKind, number>> & { readonly completeness: number };
  readonly maxAgeHours: Readonly<Record<EvidenceKind, number>>;
  readonly failedEvidenceCap: number;
  readonly credit: EvidenceCreditConfig;
}

export const DEFAULT_EVIDENCE_STRENGTH_CONFIG: EvidenceStrengthConfig = {
  weights: { buildTests: 0.3, securityFindings: 0.2, dependencyCompatibility: 0.1, recoveryVerification: 0.2, completeness: 0.2 },
  maxAgeHours: { buildTests: 24, securityFindings: 168, dependencyCompatibility: 168, recoveryVerification: 168 },
  failedEvidenceCap: 0.3,
  credit: DEFAULT_CREDIT_CONFIG,
};

export interface EvidenceKindInput {
  /** does policy require this kind of evidence for this action? */
  readonly required: boolean;
  /** every record of this kind (e.g. several test suites). Absent or empty = none collected. */
  readonly records?: readonly EvidenceItem[];
}

export interface EvidenceStrengthInput {
  readonly now: string;
  readonly buildTests?: EvidenceKindInput;
  readonly securityFindings?: EvidenceKindInput;
  readonly dependencyCompatibility?: EvidenceKindInput;
  readonly recoveryVerification?: EvidenceKindInput;
  readonly config?: DeepPartial<EvidenceStrengthConfig>;
}

export function assessEvidenceStrength(input: EvidenceStrengthInput): FactorAssessment {
  const cfg = mergeConfig(DEFAULT_EVIDENCE_STRENGTH_CONFIG, input.config);
  validateWeights('evidenceStrength.weights', cfg.weights);
  validateCreditConfig(cfg.credit);
  assertUnitInterval('evidenceStrength.failedEvidenceCap', cfg.failedEvidenceCap);
  const nowMs = parseNow(input.now);

  const missing: string[] = [];
  const uncertain: string[] = [];
  const conflicts: string[] = [];
  const refLists: Array<readonly string[] | undefined> = [];
  const raw: RawComponent[] = [];
  let anyFailedOrConflicting = false;
  let requiredCount = 0;
  let requiredPresent = 0;

  for (const kind of EVIDENCE_KINDS) {
    const label = KIND_LABELS[kind];
    const spec = input[kind];
    const weight = cfg.weights[kind];
    const required = spec?.required ?? false;
    const records = spec?.records ?? [];
    const relevant = records.filter((r) => r.status !== 'NOT_APPLICABLE');
    if (required) requiredCount++;

    if (relevant.length === 0) {
      if (required) {
        // required but nothing usable: worth 0, and say why
        if (records.length === 0) missing.push(label);
        else uncertain.push(`${label}: every record is marked NOT_APPLICABLE although the evidence is required`);
        raw.push({ name: label, weight, value: 0, note: 'required but no usable evidence', applied: true });
      } else {
        raw.push({ name: label, weight, value: 0, note: 'not required and not usable, left out', applied: false });
      }
      continue;
    }

    if (required) requiredPresent++;
    for (const r of relevant) refLists.push(r.refs);

    const hasPass = relevant.some((r) => r.status === 'PASS');
    const hasFail = relevant.some((r) => r.status === 'FAIL');
    if (hasPass && hasFail) {
      conflicts.push(`${label}: records both pass and fail`);
      anyFailedOrConflicting = true;
      raw.push({ name: label, weight, value: 0, note: 'conflicting records (pass and fail), treated as failed', applied: true });
      continue;
    }

    const credits = relevant.map((r, i) =>
      creditFor(`${label} #${i + 1}`, r, { nowMs, maxAgeMs: hoursToMs(cfg.maxAgeHours[kind]), config: cfg.credit }),
    );
    for (const c of credits) {
      if (c.state === 'unknown' || c.state === 'stale' || c.state === 'untrusted') uncertain.push(c.note);
    }
    if (hasFail) anyFailedOrConflicting = true;
    const weakest = credits.reduce((a, b) => (b.value < a.value ? b : a));
    raw.push({ name: label, weight, value: weakest.value, note: `weakest of ${credits.length} record(s): ${weakest.note}`, applied: true });
  }

  raw.push({
    name: 'completeness',
    weight: cfg.weights.completeness,
    value: requiredCount === 0 ? 0 : requiredPresent / requiredCount,
    note: `${requiredPresent}/${requiredCount} required evidence kinds have usable records`,
    applied: requiredCount > 0,
  });

  const { score: base, breakdown } = weightedAverage(raw);

  const adjustments: ScoreAdjustment[] = [];
  let score = base;
  if (anyFailedOrConflicting) {
    score = adjustScore(
      adjustments,
      'failed or conflicting evidence cap',
      score,
      Math.min(score, cfg.failedEvidenceCap),
      'at least one evidence kind failed or contradicts itself, so overall evidence cannot be strong',
    );
  }
  const nothingApplied = !raw.some((c) => c.applied);
  if (nothingApplied) missing.push('any evidence at all');
  score = finalizeScore(score);

  const explanation =
    `Evidence strength ${score.toFixed(2)}: ` +
    (nothingApplied ? 'no evidence was provided or required' : `${requiredPresent}/${requiredCount} required evidence kinds present`) +
    (anyFailedOrConflicting ? '; failed or conflicting evidence caps the score' : '') +
    (uncertain.length > 0 ? `; ${uncertain.length} item(s) unknown, stale or untrusted` : '') +
    '.';

  return {
    factor: 'evidenceStrength',
    score,
    explanation,
    evidenceRefs: uniqueRefs(...refLists),
    missing,
    uncertain,
    conflicts,
    breakdown,
    adjustments,
  };
}
