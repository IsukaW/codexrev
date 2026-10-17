/**
 * The company policy created by `admin init`: the CodeXRev level policy (policy format version 3).
 *
 * It contains exactly the five standardized developer authorization levels l1 to l5 with their predefined
 * permissions and rules from the central registry (authorization/levels.ts). Nothing here is configurable: the
 * policy verifier refuses a version 3 policy that differs from the registry, so a level can only change through a
 * new CodeXRev registry version, never by editing a file. It is DENY BY DEFAULT: any action or environment without a
 * rule is refused by `requirementsFor`.
 *
 * Authority comes from administrator-signed grants that assign ONE level to a developer. A grant is reused for every
 * authorized action until it expires or is revoked, and a level only lets a person request an assessment: the Safety
 * Score, the mandatory gates, the evidence and the Git binding still decide.
 */

import { LEVEL_POLICY_VERSION, levelPolicyBody } from '../authorization/levels.js';
import { isoSeconds } from './authority.js';

export function buildDefaultPolicy(options: { readonly organization: string; readonly now: Date; readonly days: number; readonly revision?: number }): Record<string, unknown> {
  const start = new Date(Math.floor(options.now.getTime() / 1000) * 1000);
  const body = levelPolicyBody();
  return {
    version: LEVEL_POLICY_VERSION,
    organization: options.organization,
    policyId: `${options.organization}-policy`,
    revision: options.revision ?? 1,
    issuedAt: isoSeconds(start),
    effectiveAt: isoSeconds(start),
    expiresAt: isoSeconds(new Date(start.getTime() + options.days * 24 * 3600 * 1000)),
    permissions: [...body.permissions],
    roles: body.roles.map((r) => ({ name: r.name, permissions: [...r.permissions] })),
    rules: body.rules.map((r) => ({ action: r.action, environment: r.environment, allowedRoles: [...r.allowedRoles], requiredPermissions: [...r.requiredPermissions] })),
  };
}
