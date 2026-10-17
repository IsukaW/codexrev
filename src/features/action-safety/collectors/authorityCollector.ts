/**
 * Authority Collector: normalizes the actor and authorization records the
 * user supplied in the input file. Nothing is inferred.
 *
 * It never derives authority from the git user name, repository ownership,
 * file permissions or any LLM output, and it never approves anything. A
 * record is only as strong as its (capped) source: the CLI has no identity
 * provider, so a claim in an input file counts at most as "human_attested" and
 * a claim with no source counts as self-declared, which the assessors give no
 * credit and the gate view treats as unknown.
 */

import type { ActorIdentity, EvidenceItem } from '../model/types.js';
import type { InputAuthority } from '../cli/assessmentInput.js';
import { normalizeUserClaim, type NormalizedClaim } from './types.js';

export interface AuthorityCollection {
  /** only what the input file stated; absent means nobody identified the actor */
  readonly actor?: ActorIdentity;
  readonly authorization?: NormalizedClaim;
  readonly identityVerification?: NormalizedClaim;
  readonly requiredRoles: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly grantedPermissions?: { readonly permissions: readonly string[]; readonly evidence?: NormalizedClaim };
  readonly limitations: readonly string[];
}

export function collectAuthority(input: { readonly actor?: ActorIdentity; readonly authority?: InputAuthority }): AuthorityCollection {
  const limitations: string[] = [];
  const a = input.authority;

  const claim = (label: string, item: EvidenceItem | undefined): NormalizedClaim | undefined => {
    if (!item) return undefined;
    const n = normalizeUserClaim(label, item);
    limitations.push(...n.limitations);
    return n;
  };

  const actor = input.actor;
  if (!actor) limitations.push('no actor was identified in the input; authority is never inferred from the git user or repository ownership');

  const authorization = claim('authorization record', a?.authorization);
  if (!authorization) limitations.push('no authorization record was supplied');
  const identityVerification = claim('identity verification', a?.identityVerification);
  if (actor && !identityVerification) limitations.push('the actor\'s identity and roles are self-reported: no identity verification was supplied');

  let grantedPermissions: AuthorityCollection['grantedPermissions'];
  if (a?.grantedPermissions) {
    const evidence = claim('permission grant record', a.grantedPermissions.evidence);
    if (!evidence) limitations.push('granted permissions were listed without a record proving the grant; they are a claim only');
    grantedPermissions = { permissions: [...a.grantedPermissions.permissions], ...(evidence ? { evidence } : {}) };
  }

  return {
    ...(actor ? { actor } : {}),
    ...(authorization ? { authorization } : {}),
    ...(identityVerification ? { identityVerification } : {}),
    requiredRoles: [...(a?.requiredRoles ?? [])],
    requiredPermissions: [...(a?.requiredPermissions ?? [])],
    ...(grantedPermissions ? { grantedPermissions } : {}),
    limitations,
  };
}
