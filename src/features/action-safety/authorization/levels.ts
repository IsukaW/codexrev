/**
 * The standardized CodeXRev developer authorization levels L1 to L5 and the central, versioned permission registry.
 *
 * WHY THIS EXISTS. Job titles differ between companies and say nothing about what CodeXRev may let a person
 * request. The administrator assigns one of five fixed levels in an administrator-signed grant; each level has a
 * fixed permission set that is defined HERE, in code, not in a file a developer can edit. A level is carried in a
 * grant as its (single) role, so the existing signed-grant machinery (signature, trust root, expiry, revocation,
 * proof of possession) is reused unchanged. The signed policy (format version 3) must contain exactly these roles,
 * permissions and rules: a policy that redefines a level (for example giving l1 `deployment.production`) is rejected,
 * and so is a grant that names anything other than exactly one level.
 *
 * ENFORCEABILITY. Every permission maps to exactly one real CodeXRev (action type, environment) pair. Reading code,
 * local builds and local unit tests are NOT CodeXRev actions (there is no action type for them, and nothing is
 * assessed), so no permission is invented for them: they are not gated by this tool. Where the action taxonomy cannot
 * tell two things apart (for example infrastructure from application configuration in production), the permission is
 * mapped to the narrowest existing pair and is held only by L5; everything not listed is DENIED by the policy
 * (deny by default).
 *
 * A level only lets a person REQUEST an assessment. It never guarantees ALLOW: the Safety Score and the mandatory
 * safety gates decide independently.
 */

import type { ActionType, TargetEnvironment } from '../model/types.js';

/** Version of this registry. It is bound to policy format version 3: a different registry needs a new policy version. */
export const LEVEL_REGISTRY_VERSION = 1 as const;

/** The policy format version that carries the level registry. */
export const LEVEL_POLICY_VERSION = 3 as const;

export const LEVEL_IDS = ['l1', 'l2', 'l3', 'l4', 'l5'] as const;
export type LevelId = (typeof LEVEL_IDS)[number];

export interface PermissionDefinition {
  readonly id: string;
  readonly description: string;
  /** the one CodeXRev action type and environment this permission enforces */
  readonly action: ActionType;
  readonly environment: TargetEnvironment;
  /** the lowest level that holds it; every higher level includes it */
  readonly minLevel: LevelId;
}

/** The permission registry. Order is stable; ids are the machine-readable identifiers used in signed policies and grants. */
export const PERMISSION_REGISTRY: readonly PermissionDefinition[] = Object.freeze(
  [
    { id: 'code.modify', description: 'modify application source code in development', action: 'code_change', environment: 'development', minLevel: 'l1' },
    { id: 'dependency.update', description: 'update project dependencies in development', action: 'dependency_upgrade', environment: 'development', minLevel: 'l2' },
    { id: 'config.development', description: 'modify development configuration', action: 'configuration_change', environment: 'development', minLevel: 'l2' },
    { id: 'deployment.staging', description: 'deploy applications to staging', action: 'deployment', environment: 'staging', minLevel: 'l3' },
    { id: 'config.staging', description: 'modify staging configuration', action: 'configuration_change', environment: 'staging', minLevel: 'l3' },
    { id: 'migration.staging', description: 'run permitted database migrations in staging (the recovery gate still applies)', action: 'database_migration', environment: 'staging', minLevel: 'l3' },
    { id: 'deployment.production', description: 'deploy applications to production', action: 'deployment', environment: 'production', minLevel: 'l4' },
    { id: 'rollback.production', description: 'roll back a production deployment', action: 'rollback', environment: 'production', minLevel: 'l4' },
    { id: 'infrastructure.maintenance', description: 'explicitly authorized infrastructure maintenance (configuration change in production)', action: 'configuration_change', environment: 'production', minLevel: 'l5' },
    { id: 'database.maintenance', description: 'explicitly authorized database maintenance (database migration in production)', action: 'database_migration', environment: 'production', minLevel: 'l5' },
  ].map((p) => Object.freeze(p) as PermissionDefinition),
);

const levelIndex = (level: LevelId): number => LEVEL_IDS.indexOf(level);

export const isLevelId = (x: unknown): x is LevelId => typeof x === 'string' && (LEVEL_IDS as readonly string[]).includes(x);

/** "L3", "l3" and " L3 " all mean l3; anything else is undefined (never guessed). */
export function parseLevel(text: unknown): LevelId | undefined {
  if (typeof text !== 'string') return undefined;
  const id = text.trim().toLowerCase();
  return isLevelId(id) ? id : undefined;
}

/** "L3" for display. */
export const levelLabel = (level: LevelId): string => level.toUpperCase();

/** The fixed permission ids of a level (cumulative: a level includes every lower level), sorted. */
export function permissionsOfLevel(level: LevelId): readonly string[] {
  return PERMISSION_REGISTRY.filter((p) => levelIndex(p.minLevel) <= levelIndex(level)).map((p) => p.id).sort();
}

/** The levels that hold a permission, lowest first. */
export function levelsHolding(permissionId: string): readonly LevelId[] {
  const def = PERMISSION_REGISTRY.find((p) => p.id === permissionId);
  return def ? LEVEL_IDS.filter((l) => levelIndex(l) >= levelIndex(def.minLevel)) : [];
}

export const LEVEL_DESCRIPTIONS: Readonly<Record<LevelId, string>> = Object.freeze({
  l1: 'Developer Level 1: development code changes',
  l2: 'Developer Level 2: L1 plus development dependencies and development configuration',
  l3: 'Developer Level 3: L2 plus staging deployments, staging configuration and staging migrations',
  l4: 'Developer Level 4: L3 plus production deployments and production rollbacks',
  l5: 'Developer Level 5: L4 plus explicitly allowlisted production infrastructure and database maintenance',
});

/** The exact policy body (permissions, roles, rules) that a version 3 policy must contain. */
export function levelPolicyBody(): {
  readonly permissions: readonly string[];
  readonly roles: ReadonlyArray<{ name: LevelId; permissions: readonly string[] }>;
  readonly rules: ReadonlyArray<{ action: ActionType; environment: TargetEnvironment; allowedRoles: readonly LevelId[]; requiredPermissions: readonly string[] }>;
} {
  return {
    permissions: PERMISSION_REGISTRY.map((p) => p.id),
    roles: LEVEL_IDS.map((name) => ({ name, permissions: permissionsOfLevel(name) })),
    rules: PERMISSION_REGISTRY.map((p) => ({ action: p.action, environment: p.environment, allowedRoles: levelsHolding(p.id), requiredPermissions: [p.id] })),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * Checks that the parsed policy body is EXACTLY the registry: the same permissions, the same five roles with the
 * same permission sets, and the same rules. Returns a short description of the first difference, or undefined.
 * Nothing is repaired or defaulted: a policy that differs is refused.
 */
export function levelPolicyMismatch(body: {
  readonly permissions: readonly string[];
  readonly roles: ReadonlyArray<{ readonly name: string; readonly permissions: readonly string[] }>;
  readonly rules: ReadonlyArray<{ readonly action: string; readonly environment: string; readonly allowedRoles: readonly string[]; readonly requiredPermissions: readonly string[] }>;
}): string | undefined {
  const want = levelPolicyBody();
  if (!sameSet(body.permissions, want.permissions)) return 'the permission list is not the CodeXRev permission registry';
  if (body.roles.length !== want.roles.length) return 'the roles must be exactly the five CodeXRev levels l1 to l5';
  for (const level of want.roles) {
    const role = body.roles.find((r) => r.name === level.name);
    if (!role) return `the level ${level.name} is missing`;
    if (!sameSet(role.permissions, level.permissions)) return `the level ${level.name} does not have its predefined permissions`;
  }
  if (body.rules.length !== want.rules.length) return 'the rules are not the CodeXRev level rules';
  for (const rule of want.rules) {
    const found = body.rules.find((r) => r.action === rule.action && r.environment === rule.environment);
    if (!found || !sameSet(found.allowedRoles, rule.allowedRoles) || !sameSet(found.requiredPermissions, rule.requiredPermissions)) return `the rule for ${rule.action} in ${rule.environment} is not the predefined level rule`;
  }
  return undefined;
}
