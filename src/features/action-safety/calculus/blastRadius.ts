/**
 * Blast Radius (B): how much could go wrong if this action misbehaves?
 * 0 = very limited impact, 1 = widespread / critical impact.
 * HIGHER = RISKIER (the safety formula uses 1 - B).
 *
 * Scoring, in plain steps:
 *   1. Eight components, each a risk value 0..1, combined by weighted average:
 *        environment  lookup (development lowest, production highest)
 *        criticality  lookup, highest criticality among affected components
 *        scope        lookup (local ... infrastructure_wide)
 *        files, modules, shared modules, dependency reach, services
 *                     count / saturation, capped at 1 (so "50+ files" is just "a lot")
 *   2. Anything the caller did not provide is NOT assumed small: it gets
 *      `unknownRisk` (0.7) and is reported as missing.
 *   3. Floors: a database-wide, infrastructure-wide or critical-in-production
 *      change cannot score below its floor, however small the other numbers.
 *
 * Every table, weight, saturation point and floor is in the config below.
 */

import type { FactorAssessment, ScoreAdjustment, TargetEnvironment } from '../model/types.js';
import {
  adjustScore,
  assertUnitInterval,
  finalizeScore,
  mergeConfig,
  saturate,
  uniqueRefs,
  validateWeights,
  weightedAverage,
  type DeepPartial,
  type RawComponent,
} from './scoring.js';

export type ComponentCriticality = 'low' | 'medium' | 'high' | 'critical';
export type ImpactScope = 'local' | 'service' | 'database_wide' | 'infrastructure_wide';

export interface BlastRadiusConfig {
  readonly weights: {
    readonly environment: number;
    readonly criticality: number;
    readonly scope: number;
    readonly files: number;
    readonly modules: number;
    readonly sharedModules: number;
    readonly dependencyReach: number;
    readonly services: number;
  };
  readonly environmentRisk: Readonly<Record<TargetEnvironment, number>>;
  readonly criticalityRisk: Readonly<Record<ComponentCriticality, number>>;
  readonly scopeRisk: Readonly<Record<ImpactScope, number>>;
  /** counts at or above these map to risk 1 */
  readonly saturation: {
    readonly files: number;
    readonly modules: number;
    readonly sharedModules: number;
    readonly dependencyReach: number;
    readonly services: number;
  };
  /** risk assigned to any dimension the caller did not provide */
  readonly unknownRisk: number;
  readonly floors: {
    readonly infrastructureWide: number;
    readonly databaseWide: number;
    readonly criticalInProduction: number;
  };
}

export const DEFAULT_BLAST_RADIUS_CONFIG: BlastRadiusConfig = {
  weights: {
    environment: 0.25,
    criticality: 0.2,
    scope: 0.2,
    files: 0.05,
    modules: 0.05,
    sharedModules: 0.1,
    dependencyReach: 0.05,
    services: 0.1,
  },
  environmentRisk: { development: 0.05, testing: 0.2, staging: 0.4, production: 1 },
  criticalityRisk: { low: 0.1, medium: 0.4, high: 0.7, critical: 1 },
  scopeRisk: { local: 0.05, service: 0.4, database_wide: 0.85, infrastructure_wide: 1 },
  saturation: { files: 50, modules: 10, sharedModules: 5, dependencyReach: 20, services: 5 },
  unknownRisk: 0.7,
  floors: { infrastructureWide: 0.8, databaseWide: 0.7, criticalInProduction: 0.8 },
};

export interface BlastRadiusInput {
  readonly environment: TargetEnvironment;
  readonly affectedFileCount?: number;
  readonly affectedModuleCount?: number;
  /** highest criticality among the affected components */
  readonly criticality?: ComponentCriticality;
  /** how many shared/common modules the change touches */
  readonly sharedModulesModified?: number;
  /** how many things depend on what changes (downstream dependents) */
  readonly dependencyReach?: number;
  readonly affectedServiceCount?: number;
  readonly scope?: ImpactScope;
  /** where the impact numbers came from (analysis reports, dependency graphs...) */
  readonly evidenceRefs?: readonly string[];
  readonly config?: DeepPartial<BlastRadiusConfig>;
}

export function assessBlastRadius(input: BlastRadiusInput): FactorAssessment {
  const cfg = mergeConfig(DEFAULT_BLAST_RADIUS_CONFIG, input.config);
  validateWeights('blastRadius.weights', cfg.weights);
  assertUnitInterval('blastRadius.unknownRisk', cfg.unknownRisk);
  for (const table of [cfg.environmentRisk, cfg.criticalityRisk, cfg.scopeRisk, cfg.floors]) {
    for (const [k, v] of Object.entries(table)) assertUnitInterval(`blastRadius.${k}`, v);
  }

  const missing: string[] = [];
  const uncertain: string[] = [];
  const conflicts: string[] = [];

  // a dimension the caller did not give counts as `unknownRisk`, never as "small"
  const dimension = (
    name: string,
    weight: number,
    provided: boolean,
    compute: () => { value: number; note: string },
  ): RawComponent => {
    if (!provided) {
      missing.push(name);
      return { name, weight, value: cfg.unknownRisk, note: `not provided, assumed risk ${cfg.unknownRisk}`, applied: true };
    }
    const { value, note } = compute();
    return { name, weight, value, note, applied: true };
  };

  const count = (name: string, n: number | undefined, sat: number, weight: number): RawComponent =>
    dimension(name, weight, n !== undefined, () => ({
      value: saturate(name, n as number, sat),
      note: `${n} (saturates at ${sat})`,
    }));

  const raw: RawComponent[] = [
    {
      name: 'environment',
      weight: cfg.weights.environment,
      value: cfg.environmentRisk[input.environment],
      note: input.environment,
      applied: true,
    },
    dimension('criticality', cfg.weights.criticality, input.criticality !== undefined, () => ({
      value: cfg.criticalityRisk[input.criticality as ComponentCriticality],
      note: String(input.criticality),
    })),
    dimension('scope', cfg.weights.scope, input.scope !== undefined, () => ({
      value: cfg.scopeRisk[input.scope as ImpactScope],
      note: String(input.scope),
    })),
    count('affected files', input.affectedFileCount, cfg.saturation.files, cfg.weights.files),
    count('affected modules', input.affectedModuleCount, cfg.saturation.modules, cfg.weights.modules),
    count('shared modules modified', input.sharedModulesModified, cfg.saturation.sharedModules, cfg.weights.sharedModules),
    count('dependency reach', input.dependencyReach, cfg.saturation.dependencyReach, cfg.weights.dependencyReach),
    count('affected services', input.affectedServiceCount, cfg.saturation.services, cfg.weights.services),
  ];

  if (input.scope === 'local' && (input.affectedServiceCount ?? 0) > 1) {
    conflicts.push(`scope is "local" but ${input.affectedServiceCount} services are affected`);
  }

  const { score: base, breakdown } = weightedAverage(raw);

  const adjustments: ScoreAdjustment[] = [];
  let score = base;
  if (input.scope === 'infrastructure_wide') {
    score = adjustScore(adjustments, 'infrastructure-wide floor', score, Math.max(score, cfg.floors.infrastructureWide), 'infrastructure-wide changes cannot be low impact');
  }
  if (input.scope === 'database_wide') {
    score = adjustScore(adjustments, 'database-wide floor', score, Math.max(score, cfg.floors.databaseWide), 'database-wide changes cannot be low impact');
  }
  if (input.environment === 'production' && input.criticality === 'critical') {
    score = adjustScore(adjustments, 'critical-in-production floor', score, Math.max(score, cfg.floors.criticalInProduction), 'critical components in production cannot be low impact');
  }
  score = finalizeScore(score);

  const explanation =
    `Blast radius ${score.toFixed(2)} (higher = riskier): target ${input.environment}` +
    (input.scope ? `, scope ${input.scope}` : '') +
    (input.criticality ? `, criticality ${input.criticality}` : '') +
    (missing.length > 0 ? `; ${missing.length} dimension(s) not provided and assumed risky` : '') +
    '.';

  return {
    factor: 'blastRadius',
    score,
    explanation,
    evidenceRefs: uniqueRefs(input.evidenceRefs),
    missing,
    uncertain,
    conflicts,
    breakdown,
    adjustments,
  };
}
