/**
 * Small deterministic helpers shared by the four factor assessors: weighted
 * averages with a visible breakdown, evidence "credit" (freshness + source
 * trust), and config merging. No LLM, no I/O, and no clock: "now" is always
 * passed in, so the same input always gives the same score.
 */

import { CodexrevError } from '../../../utils/errors.js';
import type { EvidenceItem, EvidenceSource, ScoreAdjustment, ScoreComponent } from '../model/types.js';

export class FactorInputError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_ACTION_SAFETY_FACTOR_INPUT_ERROR', false);
    this.name = 'FactorInputError';
  }
}

const MS_PER_HOUR = 3_600_000;

export function hoursToMs(hours: number): number {
  return hours * MS_PER_HOUR;
}

// 6 decimals: removes float noise (0.30000000000000004) without hiding real differences
export function finalizeScore(n: number): number {
  const clamped = Math.min(1, Math.max(0, n));
  return Math.round(clamped * 1e6) / 1e6;
}

export function parseNow(now: string): number {
  const ms = Date.parse(now);
  if (Number.isNaN(ms)) throw new FactorInputError(`"now" is not a valid ISO date: ${JSON.stringify(now)}`);
  return ms;
}

export function assertNonNegativeNumber(name: string, n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new FactorInputError(`${name} must be a finite number >= 0 (got ${String(n)})`);
  }
}

export function assertUnitInterval(name: string, n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new FactorInputError(`${name} must be a number between 0 and 1 (got ${String(n)})`);
  }
}

export function validateWeights(name: string, weights: Readonly<Record<string, number>>): void {
  let total = 0;
  for (const [k, w] of Object.entries(weights)) {
    assertNonNegativeNumber(`${name}.${k}`, w);
    total += w;
  }
  if (total <= 0) throw new FactorInputError(`${name} must contain at least one positive weight`);
}

/** count -> [0, 1], linear up to `saturation` and flat after it (50 files and 5000 files both count as "a lot"). */
export function saturate(name: string, count: number, saturation: number): number {
  assertNonNegativeNumber(name, count);
  if (!(saturation > 0)) throw new FactorInputError(`saturation for ${name} must be > 0`);
  return Math.min(1, count / saturation);
}

export function uniqueRefs(...lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  for (const list of lists) for (const r of list ?? []) seen.add(r);
  return [...seen];
}

// ---------------------------------------------------------------- config

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Overrides only the leaves the caller gives; everything else keeps its documented default. */
export function mergeConfig<T extends object>(defaults: T, override?: DeepPartial<T>): T {
  if (!override) return defaults;
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const base = out[k];
    out[k] = isPlainObject(base) && isPlainObject(v) ? mergeConfig(base, v) : v;
  }
  return out as T;
}

// ---------------------------------------------------------------- weighted average

export interface RawComponent {
  readonly name: string;
  readonly weight: number;
  readonly value: number;
  readonly note: string;
  /** false = leave out and rescale the remaining weights */
  readonly applied: boolean;
}

/**
 * Weighted average over the components that applied. Weights are rescaled to
 * sum to 1 among them, and every step is returned so the score can be audited.
 * If nothing applied the score is 0 (no information is never "safe").
 */
export function weightedAverage(raw: readonly RawComponent[]): { score: number; breakdown: ScoreComponent[] } {
  for (const c of raw) {
    assertNonNegativeNumber(`weight of ${c.name}`, c.weight);
    assertUnitInterval(`value of ${c.name}`, c.value);
  }
  const total = raw.filter((c) => c.applied).reduce((n, c) => n + c.weight, 0);
  const breakdown: ScoreComponent[] = raw.map((c) => {
    const effectiveWeight = c.applied && total > 0 ? c.weight / total : 0;
    return {
      name: c.name,
      value: c.value,
      weight: c.weight,
      effectiveWeight,
      contribution: c.value * effectiveWeight,
      applied: c.applied,
      note: c.note,
    };
  });
  const score = breakdown.reduce((n, c) => n + c.contribution, 0);
  return { score, breakdown };
}

/** Records an adjustment only when it actually changed the score. Returns the new score. */
export function adjustScore(
  adjustments: ScoreAdjustment[],
  name: string,
  before: number,
  after: number,
  reason: string,
): number {
  if (after !== before) adjustments.push({ name, before, after, reason });
  return after;
}

// ---------------------------------------------------------------- evidence credit

export interface EvidenceCreditConfig {
  /** how much a PASS from each source counts (1 = fully, 0 = not at all) */
  readonly reliability: Readonly<Record<EvidenceSource, number>>;
  /** sources below this reliability are "untrusted": a PASS from them earns 0 */
  readonly minTrustedReliability: number;
  /** a PASS older than its max age earns this fraction of what a fresh one would */
  readonly staleCredit: number;
  /** evidence whose status is UNKNOWN earns this (tiny) credit, never more than stale-but-passing */
  readonly unknownCredit: number;
}

export const DEFAULT_CREDIT_CONFIG: EvidenceCreditConfig = {
  reliability: { verified_system: 1, automated_tool: 0.9, human_attested: 0.7, self_declared: 0.3 },
  minTrustedReliability: 0.5,
  staleCredit: 0.5,
  unknownCredit: 0.1,
};

export function validateCreditConfig(cfg: EvidenceCreditConfig): void {
  for (const [k, v] of Object.entries(cfg.reliability)) assertUnitInterval(`credit.reliability.${k}`, v);
  assertUnitInterval('credit.minTrustedReliability', cfg.minTrustedReliability);
  assertUnitInterval('credit.staleCredit', cfg.staleCredit);
  assertUnitInterval('credit.unknownCredit', cfg.unknownCredit);
}

export type CreditState = 'verified' | 'stale' | 'failed' | 'unknown' | 'missing' | 'not_applicable' | 'untrusted';

export interface Credit {
  readonly state: CreditState;
  /** 0..1 */
  readonly value: number;
  readonly note: string;
  readonly refs: readonly string[];
}

export interface CreditContext {
  readonly nowMs: number;
  /** omit to skip the freshness check for this kind of evidence */
  readonly maxAgeMs?: number;
  readonly config: EvidenceCreditConfig;
}

/**
 * How much one evidence record is worth:
 *   missing                  -> 0
 *   NOT_APPLICABLE           -> 0 (the caller decides whether to leave it out)
 *   FAIL                     -> 0
 *   UNKNOWN                  -> unknownCredit
 *   PASS, untrusted source   -> 0   (self-declared claims are not verification)
 *   PASS, stale or no date   -> reliability * staleCredit
 *   PASS, fresh              -> reliability
 * "No date" counts as stale when a max age applies, because freshness cannot be shown.
 */
export function creditFor(label: string, item: EvidenceItem | undefined, ctx: CreditContext): Credit {
  const refs = item?.refs ?? [];
  if (!item) return { state: 'missing', value: 0, note: `${label}: no record provided`, refs };
  switch (item.status) {
    case 'NOT_APPLICABLE':
      return { state: 'not_applicable', value: 0, note: `${label}: marked not applicable`, refs };
    case 'FAIL':
      return { state: 'failed', value: 0, note: `${label}: failed`, refs };
    case 'UNKNOWN':
      return { state: 'unknown', value: ctx.config.unknownCredit, note: `${label}: result unknown`, refs };
    case 'PASS':
      break;
  }

  const source: EvidenceSource = item.source ?? 'self_declared';
  const reliability = ctx.config.reliability[source];
  if (reliability < ctx.config.minTrustedReliability) {
    return { state: 'untrusted', value: 0, note: `${label}: passed but source "${source}" is not trusted as verification`, refs };
  }

  if (ctx.maxAgeMs !== undefined) {
    const observed = item.observedAt === undefined ? Number.NaN : Date.parse(item.observedAt);
    const age = ctx.nowMs - observed;
    if (Number.isNaN(observed)) {
      return { state: 'stale', value: reliability * ctx.config.staleCredit, note: `${label}: no valid timestamp, freshness cannot be shown`, refs };
    }
    if (age < 0) {
      return { state: 'stale', value: reliability * ctx.config.staleCredit, note: `${label}: timestamp is in the future, not trusted as fresh`, refs };
    }
    if (age > ctx.maxAgeMs) {
      return { state: 'stale', value: reliability * ctx.config.staleCredit, note: `${label}: evidence is older than the allowed age`, refs };
    }
  }
  return { state: 'verified', value: reliability, note: `${label}: verified (${source})`, refs };
}
