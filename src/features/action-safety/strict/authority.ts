/**
 * The authority directory: the PUBLIC, administrator-published artifacts of one organization.
 *
 *   trust-root.json          who may sign what (public keys only)
 *   policy.signed.json       the signed company policy
 *   revocation.signed.json   the signed revocation list
 *   grants/<id>.grant.json   signed role-based grants (developers, release engineers, team leads)
 *
 * Nothing secret is stored here and private keys must never be placed here (the setup commands refuse
 * it). ASSUMPTION for this university prototype: the directory is controlled by the administrator
 * (for example a protected share or a read-only checkout for developers). Every artifact is verified
 * with the existing verifiers against the trust root, so editing a grant or policy breaks its
 * signature; but whoever can REPLACE the whole directory (trust root included) can create a different
 * organization. The trust root is the anchor: it must reach the verifier through a channel the
 * developer cannot write (not addressed in this phase).
 *
 * The revocation list is accepted for up to 30 days (the existing verifier's maximum), which suits a
 * demo; a production deployment would refresh it far more often.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { wholeSecondsText } from '../authorization/challengeCommon.js';
import { LEVEL_POLICY_VERSION } from '../authorization/levels.js';
import { verifyPolicy, type PolicyDocument } from '../authorization/policy.js';
import { verifyRevocationList, type VerifiedRevocationList } from '../authorization/revocation.js';
import { verifyTrustedEnvelope } from '../authorization/signedArtifact.js';
import { parseTrustRootBytes, type TrustRoot } from '../authorization/trustRoot.js';
import { StrictCliError, readFileBytes, readJsonFile } from './files.js';

export const AUTHORITY_FILES = Object.freeze({
  trustRoot: 'trust-root.json',
  policy: 'policy.signed.json',
  revocation: 'revocation.signed.json',
  grantsDir: 'grants',
});

export const REVOCATION_MAX_AGE_HOURS = 720;
export const REVOCATION_VALIDITY_DAYS = 30;
export const GRANT_FILE_SUFFIX = '.grant.json';

export const authorityPath = (dir: string, file: string): string => path.join(path.resolve(dir), file);

export interface LoadedAuthority {
  readonly dir: string;
  readonly organization: string;
  readonly trustRoot: TrustRoot;
  readonly policyEnvelope: unknown;
  readonly policy: PolicyDocument;
  readonly revocationEnvelope: unknown;
  readonly revocation: VerifiedRevocationList;
  /** true when the list was read for renewal although it is no longer fresh */
  readonly revocationStale: boolean;
}

/** The fingerprint of a trust root: lowercase hex SHA-256 of the exact bytes of the trust-root file. */
export const trustRootFingerprint = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export interface TrustRootSource {
  /** read the trust root from here instead of the authority directory (an administrator-installed file) */
  readonly file?: string;
  /**
   * PIN: the fingerprint the trust root must have. The pin is the trust anchor of strict mode. It is supplied
   * by whoever runs the tool (the administrator, a protected wrapper or CI configuration), never read from an
   * assessment JSON file or from the authority directory.
   */
  readonly expectedSha256?: string;
}

/** Reads the trust root and, if a pin is given, refuses it unless it matches the pin exactly. */
export async function loadTrustRoot(dir: string, source: TrustRootSource = {}): Promise<TrustRoot> {
  const file = source.file !== undefined ? path.resolve(source.file) : authorityPath(dir, AUTHORITY_FILES.trustRoot);
  const bytes = await readFileBytes(file, 'the trust root (is this an initialized authority directory?)');
  if (source.expectedSha256 !== undefined) {
    if (!FINGERPRINT_PATTERN.test(source.expectedSha256)) throw new StrictCliError('the pinned trust-root fingerprint must be 64 lowercase hexadecimal characters');
    if (trustRootFingerprint(bytes) !== source.expectedSha256) throw new StrictCliError('the trust root does not match the pinned fingerprint: it is NOT the administrator-established trust root, so nothing signed under it is accepted');
  }
  const parsed = parseTrustRootBytes(bytes);
  if (!parsed.ok) throw new StrictCliError(`the trust root is not valid: ${parsed.message}`);
  return parsed.trustRoot;
}

/**
 * Loads and VERIFIES the trust root, policy and revocation list at `now`. With `forRenewal` an expired
 * or stale revocation list is still read (its signature, organization and contents are verified at the
 * time it was issued) so an administrator can renew it; nothing else is relaxed.
 */
export async function loadAuthority(dir: string, now: Date, options: { readonly forRenewal?: boolean; readonly trustRoot?: TrustRootSource } = {}): Promise<LoadedAuthority> {
  const trustRoot = await loadTrustRoot(dir, options.trustRoot);
  const policyEnvelope = await readJsonFile(authorityPath(dir, AUTHORITY_FILES.policy), 'the signed policy');
  const policy = verifyPolicy(policyEnvelope, trustRoot, now);
  if (!policy.ok) throw new StrictCliError(`the signed policy is not acceptable: ${policy.message}`);
  // the strict tooling works only with the CodeXRev level policy: an older or custom-role policy is refused, never downgraded to
  if (policy.policy.version !== LEVEL_POLICY_VERSION) throw new StrictCliError(`the signed policy uses format version ${policy.policy.version}, but the CodeXRev authorization levels need version ${LEVEL_POLICY_VERSION}: the administrator must issue a new level policy`);

  const revocationEnvelope = await readJsonFile(authorityPath(dir, AUTHORITY_FILES.revocation), 'the signed revocation list');
  let list = verifyRevocationList(revocationEnvelope, trustRoot, now, { maxAgeHours: REVOCATION_MAX_AGE_HOURS });
  let stale = false;
  if (!list.ok && options.forRenewal && (list.code === 'list_expired' || list.code === 'list_stale')) {
    // read it as of the moment it was issued: the signature and contents are still fully checked
    const peek = verifyTrustedEnvelope(revocationEnvelope, 'revocation', 'revocation', trustRoot, now);
    const issuedAt = peek.ok && typeof (peek.value as { issuedAt?: unknown })?.issuedAt === 'string' ? Date.parse((peek.value as { issuedAt: string }).issuedAt) : Number.NaN;
    if (!Number.isNaN(issuedAt)) {
      list = verifyRevocationList(revocationEnvelope, trustRoot, new Date(issuedAt + 1000), { maxAgeHours: REVOCATION_MAX_AGE_HOURS });
      stale = list.ok;
    }
  }
  if (!list.ok) throw new StrictCliError(`the signed revocation list is not acceptable: ${list.message}${list.code === 'list_expired' || list.code === 'list_stale' ? ' (the administrator must renew it: admin refresh-revocation)' : ''}`);
  return { dir: path.resolve(dir), organization: trustRoot.organization, trustRoot, policyEnvelope, policy: policy.policy, revocationEnvelope, revocation: list, revocationStale: stale };
}

export const isoSeconds = (d: Date): string => wholeSecondsText(d.getTime());
