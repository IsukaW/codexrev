/**
 * Administrator operations: initialize an organization, issue signed grants, revoke grants.
 *
 * Every artifact is built from the existing schemas, signed with the existing envelope code, and then
 * checked with the EXISTING VERIFIERS (parseTrustRoot, verifyPolicy, verifyGrant, verifyRevocationList)
 * before it is written, so nothing is saved that the verifiers would later refuse. The administrator
 * key is always chosen explicitly by name; it lives in the administrator's keys directory and is never
 * written to the authority directory (this is checked).
 *
 * Time is injected (`now`), so everything is reproducible in tests.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { signEnvelope } from '../authorization/envelope.js';
import { MAX_GRANT_LIFETIME_DAYS, SUBJECT_ID_PATTERN, SUBJECT_TYPES, verifyGrant, type GrantDocument, type SubjectType } from '../authorization/grant.js';
import { MAX_REVOCATION_ENTRIES, verifyRevocationList } from '../authorization/revocation.js';
import { verifyPolicy } from '../authorization/policy.js';
import { ORGANIZATION_ID, findTrustedKey, parseTrustRoot, type KeyPurpose } from '../authorization/trustRoot.js';
import { GRANT_ID_PATTERN } from '../authorization/grant.js';
import { AUTHORITY_FILES, GRANT_FILE_SUFFIX, REVOCATION_VALIDITY_DAYS, authorityPath, isoSeconds, loadAuthority, loadTrustRoot } from './authority.js';
import { buildDefaultPolicy } from './defaultPolicy.js';
import { StrictCliError, isWithin, pathExists, replaceFile, writeNewFile } from './files.js';
import { loadPrivateKey, readPublicKeyFile } from './keyStore.js';

const DAY_MS = 24 * 3600 * 1000;
const floorSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);
const json = (x: unknown): string => `${JSON.stringify(x, null, 2)}\n`;

async function refuseKeysInsideAuthority(authorityDir: string, keysDir: string): Promise<void> {
  if (isWithin(authorityDir, keysDir) || isWithin(keysDir, authorityDir)) {
    throw new StrictCliError('the authority directory and the keys directory must be separate: private keys must never be placed in the authority directory');
  }
}

// ---------------------------------------------------------------- init

export interface InitOptions {
  readonly organization: string;
  readonly dir: string;
  /** profile name of the administrator signing key (policy, grant and revocation purposes) */
  readonly adminKey: string;
  /** optional profile name of a challenge-store key to list in the trust root (used by a later phase) */
  readonly storeKey?: string;
  readonly keysDir: string;
  readonly now: Date;
  /** policy validity in days (default 365) */
  readonly policyDays?: number;
}

export interface InitResult {
  readonly organization: string;
  readonly adminKeyId: string;
  readonly storeKeyId?: string;
  readonly files: readonly string[];
  readonly policyExpiresAt: string;
}

export async function initOrganization(o: InitOptions): Promise<InitResult> {
  if (!ORGANIZATION_ID.test(o.organization)) throw new StrictCliError('the organization id must be lowercase letters, digits, ".", "_" or "-" (1-64 characters, starting with a letter or digit)');
  const policyDays = o.policyDays ?? 365;
  if (!Number.isInteger(policyDays) || policyDays < 1 || policyDays > 3650) throw new StrictCliError('--policy-days must be a whole number from 1 to 3650');
  const dir = path.resolve(o.dir);
  await refuseKeysInsideAuthority(dir, path.resolve(o.keysDir));

  const files = [AUTHORITY_FILES.trustRoot, AUTHORITY_FILES.policy, AUTHORITY_FILES.revocation];
  for (const f of files) if (await pathExists(authorityPath(dir, f))) throw new StrictCliError('this authority directory is already initialized: an existing organization is never overwritten');

  const admin = await loadPrivateKey({ name: o.adminKey, keysDir: o.keysDir });
  const store = o.storeKey !== undefined ? await loadPrivateKey({ name: o.storeKey, keysDir: o.keysDir }) : undefined;
  if (store && store.keyId === admin.keyId) throw new StrictCliError('the challenge-store key must be a different key from the administrator key');

  const now = floorSecond(o.now);
  const window = { notBefore: isoSeconds(now), notAfter: isoSeconds(new Date(now.getTime() + 730 * DAY_MS)) };
  const keys: Array<Record<string, unknown>> = [{ keyId: admin.keyId, publicKey: admin.publicKeyRaw, purposes: ['policy', 'grant', 'revocation'] satisfies KeyPurpose[], ...window }];
  if (store) keys.push({ keyId: store.keyId, publicKey: store.publicKeyRaw, purposes: ['challenge_store'] satisfies KeyPurpose[], ...window });
  const trustRootDoc = { version: 1, organization: o.organization, createdAt: isoSeconds(now), keys };
  const root = parseTrustRoot(trustRootDoc);
  if (!root.ok) throw new StrictCliError(`the trust root could not be built: ${root.message}`);

  const policyEnvelope = signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(buildDefaultPolicy({ organization: o.organization, now, days: policyDays })), 'utf-8'), privateKey: admin.privateKey });
  const policy = verifyPolicy(policyEnvelope, root.trustRoot, now);
  if (!policy.ok) throw new StrictCliError(`the policy could not be built: ${policy.message}`);

  const revocationEnvelope = signEnvelope({
    domain: 'revocation',
    payload: Buffer.from(JSON.stringify({ version: 1, organization: o.organization, listVersion: 1, issuedAt: isoSeconds(now), nextUpdate: isoSeconds(new Date(now.getTime() + REVOCATION_VALIDITY_DAYS * DAY_MS)), revokedGrantIds: [], revokedSubjectKeyIds: [], revokedIssuerKeyIds: [] }), 'utf-8'),
    privateKey: admin.privateKey,
  });
  const list = verifyRevocationList(revocationEnvelope, root.trustRoot, now);
  if (!list.ok) throw new StrictCliError(`the revocation list could not be built: ${list.message}`);

  await fs.mkdir(path.join(dir, AUTHORITY_FILES.grantsDir), { recursive: true });
  // the trust root is written LAST: a directory without it is not an organization, so a failed init leaves nothing usable
  const written: string[] = [];
  try {
    for (const [file, doc] of [[AUTHORITY_FILES.policy, policyEnvelope], [AUTHORITY_FILES.revocation, revocationEnvelope], [AUTHORITY_FILES.trustRoot, trustRootDoc]] as const) {
      if (!(await writeNewFile(authorityPath(dir, file), json(doc)))) throw new StrictCliError('this authority directory is already initialized: an existing organization is never overwritten');
      written.push(file);
    }
  } catch (e) {
    for (const f of written) await fs.unlink(authorityPath(dir, f)).catch(() => undefined);
    throw e;
  }
  return { organization: o.organization, adminKeyId: admin.keyId, ...(store ? { storeKeyId: store.keyId } : {}), files, policyExpiresAt: (policy.policy as { expiresAt: string }).expiresAt };
}

// ---------------------------------------------------------------- grants

export interface GrantOptions {
  readonly dir: string;
  readonly adminKey: string;
  readonly keysDir: string;
  readonly subject: string;
  /** the subject's shareable public-key file (.pub.json) */
  readonly pubkeyFile: string;
  readonly roles: readonly string[];
  readonly days: number;
  readonly type?: SubjectType;
  /** optional narrowing of the permissions the roles give */
  readonly permissionScope?: readonly string[];
  /** the employee name, signed into the grant */
  readonly displayName?: string;
  readonly now: Date;
}

export interface GrantResult {
  readonly grantId: string;
  readonly subject: string;
  readonly subjectKeyId: string;
  readonly roles: readonly string[];
  readonly expiresAt: string;
  readonly policyRevision: number;
  readonly file: string;
}

/** Issues a signed grant. The roles and permissions must exist in the signed policy: the verifier enforces it. */
export async function issueGrant(o: GrantOptions): Promise<GrantResult> {
  if (typeof o.subject !== 'string' || !SUBJECT_ID_PATTERN.test(o.subject)) throw new StrictCliError('--subject is not a valid subject id (letters, digits, ".", "_", "@", "-"; up to 128 characters)');
  const type: SubjectType = o.type ?? 'human';
  if (!(SUBJECT_TYPES as readonly string[]).includes(type)) throw new StrictCliError('--type must be "human" or "service"');
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > MAX_GRANT_LIFETIME_DAYS) throw new StrictCliError(`--days must be a whole number from 1 to ${MAX_GRANT_LIFETIME_DAYS}`);
  if (o.roles.length === 0) throw new StrictCliError('at least one --role is required');

  await refuseKeysInsideAuthority(path.resolve(o.dir), path.resolve(o.keysDir));
  const authority = await loadAuthority(o.dir, o.now);
  const admin = await loadPrivateKey({ name: o.adminKey, keysDir: o.keysDir });
  const issuer = findTrustedKey(authority.trustRoot, admin.keyId, 'grant', o.now);
  if (!issuer.ok) throw new StrictCliError(`the key "${o.adminKey}" is not an authorized grant issuer for this organization (${issuer.code})`);

  const subjectKey = await readPublicKeyFile(o.pubkeyFile);
  if (authority.trustRoot.keys.some((k) => k.keyId === subjectKey.keyId)) throw new StrictCliError('a company signing key cannot be the subject of a grant');
  const known = new Set(authority.policy.roles.map((r) => r.name));
  for (const r of o.roles) if (!known.has(r)) throw new StrictCliError(`unsupported role "${r}": the signed policy defines ${[...known].join(', ')}`);

  const now = floorSecond(o.now);
  const grantId = `grant-${o.subject.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40) || 'subject'}-${randomBytes(4).toString('hex')}`;
  if (!GRANT_ID_PATTERN.test(grantId)) throw new StrictCliError('could not form a grant id');
  const doc: GrantDocument = {
    version: 1,
    grantId,
    organization: authority.organization,
    subject: { id: o.subject, type, publicKey: subjectKey.publicKeyRaw, keyId: subjectKey.keyId, ...(o.displayName !== undefined ? { displayName: o.displayName } : {}) },
    roles: [...o.roles],
    permissionScope: o.permissionScope === undefined ? null : [...o.permissionScope],
    issuedAt: isoSeconds(now),
    notBefore: isoSeconds(now),
    expiresAt: isoSeconds(new Date(now.getTime() + o.days * DAY_MS)),
    minPolicyRevision: authority.policy.revision,
  };
  const envelope = signEnvelope({ domain: 'grant', payload: Buffer.from(JSON.stringify(doc), 'utf-8'), privateKey: admin.privateKey });
  const verified = verifyGrant(envelope, authority.trustRoot, authority.policy, now);
  if (!verified.ok) throw new StrictCliError(`the grant is not acceptable under the signed policy: ${verified.message}`);

  await fs.mkdir(path.join(path.resolve(o.dir), AUTHORITY_FILES.grantsDir), { recursive: true });
  const file = path.join(path.resolve(o.dir), AUTHORITY_FILES.grantsDir, `${grantId}${GRANT_FILE_SUFFIX}`);
  if (!(await writeNewFile(file, json(envelope)))) throw new StrictCliError('a grant with this id already exists: try again');
  return { grantId, subject: o.subject, subjectKeyId: subjectKey.keyId, roles: [...o.roles], expiresAt: doc.expiresAt, policyRevision: authority.policy.revision, file };
}

// ---------------------------------------------------------------- revocation

export interface RevokeOptions {
  readonly dir: string;
  readonly adminKey: string;
  readonly keysDir: string;
  /** grant ids to add; empty means "only renew the list" */
  readonly grantIds: readonly string[];
  readonly now: Date;
}

export interface RevokeResult {
  readonly changed: boolean;
  readonly listVersion: number;
  readonly revokedGrantIds: readonly string[];
  readonly alreadyRevoked: readonly string[];
  readonly nextUpdate: string;
}

/**
 * Re-signs the revocation list with the given grant ids added and the version increased. A grant that
 * is already on the list is reported and not added again (when nothing new is added and no renewal was
 * asked for, nothing is written and the version does not change). The file is replaced atomically.
 */
export async function revokeGrants(o: RevokeOptions): Promise<RevokeResult> {
  for (const id of o.grantIds) if (typeof id !== 'string' || !GRANT_ID_PATTERN.test(id)) throw new StrictCliError(`"${String(id).slice(0, 40)}" is not a valid grant id`);
  await refuseKeysInsideAuthority(path.resolve(o.dir), path.resolve(o.keysDir));
  const authority = await loadAuthority(o.dir, o.now, { forRenewal: true });
  const admin = await loadPrivateKey({ name: o.adminKey, keysDir: o.keysDir });
  const issuer = findTrustedKey(authority.trustRoot, admin.keyId, 'revocation', o.now);
  if (!issuer.ok) throw new StrictCliError(`the key "${o.adminKey}" is not an authorized revocation issuer for this organization (${issuer.code})`);

  const current = authority.revocation.list;
  const existing = new Set(current.revokedGrantIds);
  const added = [...new Set(o.grantIds)].filter((id) => !existing.has(id));
  const already = [...new Set(o.grantIds)].filter((id) => existing.has(id));
  const renewal = o.grantIds.length === 0;
  if (added.length === 0 && !renewal) {
    return { changed: false, listVersion: current.listVersion, revokedGrantIds: [...current.revokedGrantIds], alreadyRevoked: already, nextUpdate: current.nextUpdate };
  }
  const merged = [...current.revokedGrantIds, ...added];
  if (merged.length > MAX_REVOCATION_ENTRIES) throw new StrictCliError('the revocation list is full');

  const now = floorSecond(o.now);
  const doc = {
    version: 1,
    organization: authority.organization,
    listVersion: current.listVersion + 1,
    issuedAt: isoSeconds(now),
    nextUpdate: isoSeconds(new Date(now.getTime() + REVOCATION_VALIDITY_DAYS * DAY_MS)),
    revokedGrantIds: merged,
    revokedSubjectKeyIds: [...current.revokedSubjectKeyIds],
    revokedIssuerKeyIds: [...current.revokedIssuerKeyIds],
  };
  const envelope = signEnvelope({ domain: 'revocation', payload: Buffer.from(JSON.stringify(doc), 'utf-8'), privateKey: admin.privateKey });
  const verified = verifyRevocationList(envelope, authority.trustRoot, now, { maxAgeHours: 720 });
  if (!verified.ok) throw new StrictCliError(`the new revocation list is not acceptable: ${verified.message}`);
  await replaceFile(authorityPath(o.dir, AUTHORITY_FILES.revocation), json(envelope));
  return { changed: true, listVersion: doc.listVersion, revokedGrantIds: merged, alreadyRevoked: already, nextUpdate: doc.nextUpdate };
}

export { loadTrustRoot };
