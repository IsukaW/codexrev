/**
 * Project authorization: onboarding a developer during `codexrev init`, and finding the result again later.
 *
 * WHAT IS STORED (all public, no secrets), under `<project>/.codexrev/`:
 *   authority/                      the organization's public, administrator-published artifacts, in the existing
 *                                   authority-directory layout: trust-root.json, policy.signed.json,
 *                                   revocation.signed.json, grants/<id>.grant.json (the administrator-signed grant)
 *   authorization.json              a small pointer record: organization, the pinned trust-root fingerprint, the
 *                                   developer's subject id and key profile NAME, and which grant file is theirs.
 * Private keys are NOT stored here: the developer key lives in the developer keys directory, the administrator key
 * stays in a separate administrator keys directory.
 *
 * THE RECORD IS NOT AUTHORITY. Everything in it except the pin is re-verified on every assessment with the existing
 * verifiers: the grant must carry the administrator's signature, the level (informational in the record) comes from the
 * signed grant, never from the record. Editing the record cannot raise a level; it can at worst point at a grant file,
 * and a grant that is not signed by the trusted administrator, not for this developer's key, expired or revoked is refused.
 *
 * TRUSTED ADMINISTRATOR SIGNING. A grant is only issued when the caller supplies an administrator key profile that
 * (1) exists in an administrator keys directory that is separate from the developer keys directory and outside Git, and
 * (2) is listed in the PINNED trust root for the `grant` purpose. Nothing here ever creates an administrator key or a
 * trust root: the organization must already exist (created by the administrator with `admin init`), and its trust
 * root must match the fingerprint the administrator supplied. Without those credentials no grant is issued.
 *
 * THE TRUSTED FINGERPRINT IS NOT TAKEN FROM THE PROJECT. The fingerprint in `authorization.json` is only a copy for display
 * and consistency. Strict assessment trusts the fingerprint from an INDEPENDENT source: the environment variable
 * CODEXREV_TRUST_ROOT_SHA256, or the user-level trust store `<CODEXREV_HOME or ~/.codexrev>/trusted-roots.json`, which the
 * administrator-led `init` writes (one entry per project path, never changed by a later `init` that states a different
 * fingerprint). Replacing `.codexrev/authorization.json` and `.codexrev/authority/` with someone else's organization therefore
 * fails: the replacement trust root does not have the independently trusted fingerprint. If neither source exists, the
 * assessment stops with a message. This does NOT protect against someone who can edit the user-level trust store, the
 * environment, or the CodeXRev executable itself: those are local trust settings.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getCodexrevPaths } from '../../../utils/paths.js';
import { parseLevel, type LevelId } from '../authorization/levels.js';
import { SUBJECT_ID_PATTERN, MAX_GRANT_LIFETIME_DAYS, verifyGrant } from '../authorization/grant.js';
import { checkRevocation } from '../authorization/revocation.js';
import { findTrustedKey, hasExactFields, isPlainObject } from '../authorization/trustRoot.js';
import { AUTHORITY_FILES, FINGERPRINT_PATTERN, GRANT_FILE_SUFFIX, authorityPath, loadAuthority, loadTrustRoot, trustRootFingerprint, type LoadedAuthority } from './authority.js';
import { issueGrant } from './admin.js';
import { StrictCliError, isInsideGitWorktree, isWithin, pathExists, readFileBytes, readJsonFile, replaceFile, writeNewFile } from './files.js';
import { defaultKeysDir, generateKeyProfile, importKeyProfile, loadPrivateKey, validateKeyName } from './keyStore.js';
import type { StrictAssessOptions } from './strictAssess.js';

export const PROJECT_AUTHORIZATION_VERSION = 1 as const;
export const PROJECT_AUTHORIZATION_FILE = 'authorization.json';
export const PROJECT_AUTHORITY_DIRNAME = 'authority';
export const DEFAULT_GRANT_DAYS = 30;
export const DEFAULT_STORE_KEY = 'store';

export interface ProjectAuthorizationRecord {
  readonly version: typeof PROJECT_AUTHORIZATION_VERSION;
  readonly organization: string;
  /** the administrator-supplied fingerprint of the trust root */
  readonly trustRootSha256: string;
  readonly developer: { readonly subject: string; readonly displayName?: string; readonly keyName: string };
  readonly grantId: string;
  /** relative to `.codexrev/`: always `authority/grants/<id>.grant.json` */
  readonly grantFile: string;
  /** informational only: the assessment reads the level from the signed grant */
  readonly level: LevelId;
  /** only when the developer keys are not in the default keys directory */
  readonly keysDir?: string;
  readonly createdAt: string;
}

export const projectAuthorizationPaths = (projectRoot: string): { readonly configDir: string; readonly authorityDir: string; readonly recordFile: string } => {
  const configDir = path.join(path.resolve(projectRoot), '.codexrev');
  return { configDir, authorityDir: path.join(configDir, PROJECT_AUTHORITY_DIRNAME), recordFile: path.join(configDir, PROJECT_AUTHORIZATION_FILE) };
};

const GRANT_FILE_PATTERN = /^authority\/grants\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.grant\.json$/;
const ORG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseRecord(value: unknown): ProjectAuthorizationRecord {
  const bad = (why: string): never => {
    throw new StrictCliError(`the project authorization record is not valid (${why}); it is not used. Re-run "codexrev init" with the administrator's credentials`);
  };
  if (!isPlainObject(value)) return bad('not an object');
  const optional = ['keysDir'].filter((k) => k in value);
  const fields = ['version', 'organization', 'trustRootSha256', 'developer', 'grantId', 'grantFile', 'level', 'createdAt', ...optional];
  if (!hasExactFields(value, fields)) return bad('missing or unexpected fields');
  if (value.version !== PROJECT_AUTHORIZATION_VERSION) return bad('unsupported version');
  if (typeof value.organization !== 'string' || !ORG_PATTERN.test(value.organization)) return bad('organization');
  if (typeof value.trustRootSha256 !== 'string' || !FINGERPRINT_PATTERN.test(value.trustRootSha256)) return bad('trust-root fingerprint');
  const dev = value.developer;
  if (!isPlainObject(dev) || !hasExactFields(dev, 'displayName' in dev ? ['subject', 'displayName', 'keyName'] : ['subject', 'keyName'])) return bad('developer');
  if (typeof dev.subject !== 'string' || !SUBJECT_ID_PATTERN.test(dev.subject)) return bad('developer subject');
  if (typeof dev.keyName !== 'string') return bad('developer key name');
  validateKeyName(dev.keyName);
  if ('displayName' in dev && (typeof dev.displayName !== 'string' || dev.displayName.length === 0 || dev.displayName.length > 80)) return bad('display name');
  if (typeof value.grantId !== 'string' || typeof value.grantFile !== 'string' || !GRANT_FILE_PATTERN.test(value.grantFile) || value.grantFile !== `authority/grants/${value.grantId}${GRANT_FILE_SUFFIX}`) return bad('grant file');
  if (parseLevel(value.level) !== value.level) return bad('level');
  if ('keysDir' in value && (typeof value.keysDir !== 'string' || !path.isAbsolute(value.keysDir))) return bad('keys directory');
  if (typeof value.createdAt !== 'string') return bad('createdAt');
  return value as unknown as ProjectAuthorizationRecord;
}

/** Reads the record. Missing -> undefined. Present but malformed -> an error (never silently ignored). */
export async function readProjectAuthorization(projectRoot: string): Promise<ProjectAuthorizationRecord | undefined> {
  const { recordFile } = projectAuthorizationPaths(projectRoot);
  if (!(await pathExists(recordFile))) return undefined;
  return parseRecord(await readJsonFile(recordFile, 'the project authorization record'));
}

/**
 * A strict assessment needs a CLEAN Git tree, and `.codexrev/` is created by init, so it must not count as a change.
 * The entry goes into `.git/info/exclude` (local to this clone: no tracked file is modified). Best effort and never fatal.
 */
async function excludeFromGit(projectRoot: string, notes: string[]): Promise<void> {
  try {
    const gitDir = path.join(path.resolve(projectRoot), '.git');
    const st = await fs.stat(gitDir).catch(() => undefined);
    if (!st?.isDirectory()) return;
    const file = path.join(gitDir, 'info', 'exclude');
    const current = await fs.readFile(file, 'utf-8').catch(() => '');
    if (current.split(/\r?\n/).some((l) => l.trim() === '.codexrev/' || l.trim() === '.codexrev')) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}.codexrev/\n`, 'utf-8');
    notes.push('added .codexrev/ to .git/info/exclude (local to this clone) so it does not count as an uncommitted change');
  } catch {
    notes.push('could not update .git/info/exclude: if the Git tree is reported dirty, ignore .codexrev/ yourself');
  }
}

// ---------------------------------------------------------------- independently trusted fingerprint

export const TRUSTED_ROOTS_FILE = 'trusted-roots.json';

/** The user-level (not project) location of the trust store. */
export const trustedRootsPath = (): string => path.join(getCodexrevPaths().root, TRUSTED_ROOTS_FILE);

const projectKey = (projectRoot: string): string => (process.platform === 'win32' ? path.resolve(projectRoot).toLowerCase() : path.resolve(projectRoot));

type TrustedRoots = { version: 1; projects: Record<string, { organization: string; trustRootSha256: string }> };

async function readTrustedRoots(): Promise<TrustedRoots> {
  const file = trustedRootsPath();
  if (!(await pathExists(file))) return { version: 1, projects: {} };
  const doc = await readJsonFile(file, 'the trusted-roots file');
  if (!isPlainObject(doc) || doc.version !== 1 || !isPlainObject(doc.projects)) throw new StrictCliError('the trusted-roots file is not valid: it is not used (fix or remove it deliberately)');
  for (const v of Object.values(doc.projects)) if (!isPlainObject(v) || typeof v.organization !== 'string' || typeof v.trustRootSha256 !== 'string' || !FINGERPRINT_PATTERN.test(v.trustRootSha256)) throw new StrictCliError('the trusted-roots file is not valid: it is not used (fix or remove it deliberately)');
  return doc as unknown as TrustedRoots;
}

/** The fingerprint that the administrator-led init provisioned for this project, outside the project. */
export async function readTrustedFingerprint(projectRoot: string): Promise<string | undefined> {
  return (await readTrustedRoots()).projects[projectKey(projectRoot)]?.trustRootSha256;
}

/** Records the fingerprint for this project. An existing entry is never changed here: a different one is an error. */
async function recordTrustedFingerprint(projectRoot: string, organization: string, pin: string, notes: string[]): Promise<void> {
  const all = await readTrustedRoots();
  const key = projectKey(projectRoot);
  const current = all.projects[key];
  if (current) {
    if (current.trustRootSha256 !== pin) throw new StrictCliError('a different trust-root fingerprint is already provisioned for this project outside the project files: it is never replaced by init. Remove that entry from the trusted-roots file deliberately if the organization really changed');
    return;
  }
  all.projects[key] = { organization, trustRootSha256: pin };
  await fs.mkdir(path.dirname(trustedRootsPath()), { recursive: true });
  await replaceFile(trustedRootsPath(), `${JSON.stringify(all, null, 2)}\n`);
  notes.push(`recorded the trusted fingerprint for this project in ${trustedRootsPath()} (outside the project)`);
}

// ---------------------------------------------------------------- onboarding

export interface ProvisionOptions {
  readonly projectRoot: string;
  readonly now: Date;
  /** the level the tech lead selects (L1 to L5) */
  readonly level: string;
  /** employee id */
  readonly subject: string;
  /** employee name (signed into the certificate) */
  readonly displayName?: string;
  /** employee keys directory (default ~/.codexrev/keys) */
  readonly keysDir?: string;
  /** the provisioned issuer: the organization's public files and the signing key profile */
  readonly issuer: { readonly authorityDir: string; readonly keysDir: string; readonly keyName: string };
  readonly days?: number;
}

export interface ProvisionResult {
  readonly level: LevelId;
  readonly subject: string;
  readonly grantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly recordFile: string;
  /** the signed certificate (the signed grant) */
  readonly certificateFile: string;
}

type GrantState = 'none' | 'valid' | 'expired' | 'revoked' | 'invalid';

const AUTHORITY_ARTIFACTS = [AUTHORITY_FILES.trustRoot, AUTHORITY_FILES.policy, AUTHORITY_FILES.revocation] as const;

async function copyArtifact(sourceDir: string, targetDir: string, file: string, replace: boolean): Promise<void> {
  const text = (await readFileBytes(authorityPath(sourceDir, file), `the organization file ${file}`)).toString('utf-8');
  if (replace) await replaceFile(authorityPath(targetDir, file), text);
  else if (!(await writeNewFile(authorityPath(targetDir, file), text))) throw new StrictCliError(`${file} already exists in the project authority directory`);
}

/**
 * Brings the project's copy of the organization up to date from the administrator's directory, after verifying the source
 * against the pin. Policy and revocation list are only replaced by ones that are not OLDER (a stale or rolled-back source
 * is ignored); the trust root is never replaced.
 */
async function refreshFromSource(source: string, projectAuthority: string, pin: string, now: Date, notes: string[]): Promise<void> {
  const fresh = await loadAuthority(source, now, { trustRoot: { expectedSha256: pin } });
  let local: LoadedAuthority | undefined;
  try {
    local = await loadAuthority(projectAuthority, now, { forRenewal: true, trustRoot: { expectedSha256: pin } });
  } catch {
    local = undefined;
  }
  if (local && fresh.policy.policyId === local.policy.policyId && fresh.policy.revision < local.policy.revision) {
    notes.push('the administrator directory has an older policy than the project copy: kept the project copy');
  } else if (!local || JSON.stringify(fresh.policyEnvelope) !== JSON.stringify(local.policyEnvelope)) {
    await copyArtifact(source, projectAuthority, AUTHORITY_FILES.policy, true);
    notes.push('updated the policy from the administrator directory');
  }
  if (local && fresh.revocation.list.listVersion < local.revocation.list.listVersion) {
    notes.push('the administrator directory has an older revocation list than the project copy: kept the project copy');
  } else if (!local || JSON.stringify(fresh.revocationEnvelope) !== JSON.stringify(local.revocationEnvelope)) {
    await copyArtifact(source, projectAuthority, AUTHORITY_FILES.revocation, true);
    notes.push('updated the revocation list from the administrator directory');
  }
}

async function grantStateOf(record: ProjectAuthorizationRecord | undefined, configDir: string, authority: LoadedAuthority, now: Date): Promise<{ state: GrantState; level?: LevelId }> {
  if (!record) return { state: 'none' };
  const file = path.join(configDir, record.grantFile);
  if (!isWithin(path.join(configDir, PROJECT_AUTHORITY_DIRNAME), file) || !(await pathExists(file))) return { state: 'invalid' };
  const g = verifyGrant(await readJsonFile(file, 'the grant file'), authority.trustRoot, authority.policy, now);
  if (!g.ok) return { state: g.code === 'grant_expired' ? 'expired' : 'invalid' };
  const level = parseLevel(g.grant.roles[0]);
  const rev = checkRevocation(g, authority.revocation, now);
  if (rev.status === 'revoked') return { state: 'revoked', ...(level ? { level } : {}) };
  if (rev.status !== 'not_listed') return { state: 'invalid' };
  return { state: 'valid', ...(level ? { level } : {}) };
}

/**
 * Creates the employee certificate for a project that has none: the existing signed-grant code signs it with the provisioned
 * issuer key. Fails (and issues nothing) if the issuer credentials are missing or the issuer key is not trusted for grants in
 * the organization's trust root. The trusted fingerprint of that trust root is recorded outside the project. The pointer record
 * is written last, so an interrupted run leaves no certificate that is in use. An existing certificate is never replaced here.
 */
export async function provisionDeveloperAuthorization(o: ProvisionOptions): Promise<ProvisionResult> {
  const level = parseLevel(o.level);
  if (!level) throw new StrictCliError('the level must be one of L1, L2, L3, L4, L5');
  if (typeof o.subject !== 'string' || !SUBJECT_ID_PATTERN.test(o.subject)) throw new StrictCliError('the employee id may contain letters, digits, ".", "_", "@" and "-" (up to 128 characters)');
  if (o.displayName !== undefined && (o.displayName.trim() === '' || o.displayName.length > 80)) throw new StrictCliError('the employee name must be 1 to 80 characters');
  const days = o.days ?? DEFAULT_GRANT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_LIFETIME_DAYS) throw new StrictCliError(`the validity must be a whole number of days from 1 to ${MAX_GRANT_LIFETIME_DAYS}`);

  const { authorityDir, recordFile } = projectAuthorizationPaths(o.projectRoot);
  const projectRoot = path.resolve(o.projectRoot);
  const devKeysDir = path.resolve(o.keysDir ?? defaultKeysDir());
  const issuerKeysDir = path.resolve(o.issuer.keysDir);
  if (await isInsideGitWorktree(devKeysDir)) throw new StrictCliError('the employee keys directory is inside a Git working tree: a private key must never be placed where it could be committed');
  if (isWithin(projectRoot, devKeysDir) || isWithin(projectRoot, issuerKeysDir)) throw new StrictCliError('private keys must be outside the project');
  if (isWithin(issuerKeysDir, devKeysDir) || isWithin(devKeysDir, issuerKeysDir)) throw new StrictCliError('the issuer signing key must be kept apart from the employee keys');
  if (await readProjectAuthorization(o.projectRoot)) throw new StrictCliError('an employee certificate already exists for this project: it is not replaced here');

  // 1. the issuer's trust root IS the trust anchor: its fingerprint is what will be trusted (and recorded outside the project)
  const source = path.resolve(o.issuer.authorityDir);
  const sourceRoot = authorityPath(source, AUTHORITY_FILES.trustRoot);
  if (!(await pathExists(sourceRoot)) || !(await pathExists(path.join(issuerKeysDir, `${o.issuer.keyName}.key`)))) throw new StrictCliError('the signing credentials are not provisioned on this machine, so no certificate was issued');
  const pin = trustRootFingerprint(await readFileBytes(sourceRoot, 'the issuer trust root'));
  const provisioned = await readTrustedFingerprint(projectRoot);
  if (provisioned !== undefined && provisioned !== pin) throw new StrictCliError('a different trust-root fingerprint is already provisioned for this project outside the project files: it is never replaced by init. Nothing was changed');
  const notes: string[] = [];

  // 2. the organization's public files, verified against that fingerprint, copied into the project
  if (!(await pathExists(authorityPath(authorityDir, AUTHORITY_FILES.trustRoot)))) {
    await loadAuthority(source, o.now, { trustRoot: { expectedSha256: pin } }); // verifies the pin, the level policy and the revocation list
    await fs.mkdir(authorityDir, { recursive: true });
    for (const file of AUTHORITY_ARTIFACTS) if (!(await pathExists(authorityPath(authorityDir, file)))) await copyArtifact(source, authorityDir, file, false);
  } else {
    await loadTrustRoot(authorityDir, { expectedSha256: pin }); // an existing copy must still be the same trust root
    await refreshFromSource(source, authorityDir, pin, o.now, notes);
  }
  const authority = await loadAuthority(authorityDir, o.now, { trustRoot: { expectedSha256: pin } });

  // 3. only a key that the trust root lists for grants may sign; the store key must be a store-only key (never a signing key)
  const issuerKey = await loadPrivateKey({ name: o.issuer.keyName, keysDir: issuerKeysDir });
  if (!findTrustedKey(authority.trustRoot, issuerKey.keyId, 'grant', o.now).ok) throw new StrictCliError(`the signing key "${o.issuer.keyName}" is not trusted for signing certificates in this organization: no certificate was issued`);
  const sourceStore = await loadPrivateKey({ name: DEFAULT_STORE_KEY, keysDir: issuerKeysDir });
  const storeEntry = authority.trustRoot.keys.find((k) => k.keyId === sourceStore.keyId);
  if (sourceStore.keyId === issuerKey.keyId || !storeEntry || storeEntry.purposes.some((p) => p !== 'challenge_store')) throw new StrictCliError('the challenge-store key is trusted for more than the challenge store (or not trusted at all): it is not copied to this machine. Nothing was issued');

  // 4. the employee's own signing key (outside the project) and the local challenge-store key
  const keyName = validateKeyName(`emp-${o.subject.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 26) || 'user'}`);
  if (!(await pathExists(path.join(devKeysDir, `${keyName}.key`)))) await generateKeyProfile({ name: keyName, keysDir: devKeysDir, now: o.now });
  const employeeKey = await loadPrivateKey({ name: keyName, keysDir: devKeysDir });
  if (findTrustedKey(authority.trustRoot, employeeKey.keyId, 'grant', o.now).ok) throw new StrictCliError('the employee key is a company signing key: an employee must use their own key');
  await importKeyProfile({ name: DEFAULT_STORE_KEY, fromDir: issuerKeysDir, toDir: devKeysDir });

  // 5. sign the certificate (the existing grant), then write the pointer record last
  const issued = await issueGrant({ dir: authorityDir, adminKey: o.issuer.keyName, keysDir: issuerKeysDir, subject: o.subject, pubkeyFile: path.join(devKeysDir, `${keyName}.pub.json`), roles: [level], days, ...(o.displayName ? { displayName: o.displayName.trim() } : {}), now: o.now });
  try {
    const record: ProjectAuthorizationRecord = {
      version: PROJECT_AUTHORIZATION_VERSION,
      organization: authority.organization,
      trustRootSha256: pin,
      developer: { subject: o.subject, ...(o.displayName ? { displayName: o.displayName.trim() } : {}), keyName },
      grantId: issued.grantId,
      grantFile: `authority/grants/${issued.grantId}${GRANT_FILE_SUFFIX}`,
      level,
      ...(o.keysDir !== undefined ? { keysDir: devKeysDir } : {}),
      createdAt: o.now.toISOString(),
    };
    await recordTrustedFingerprint(projectRoot, authority.organization, pin, notes); // before the record: a pin without a record is harmless
    await replaceFile(recordFile, `${JSON.stringify(record, null, 2)}\n`);
    await excludeFromGit(projectRoot, notes);
    await fs.chmod(issued.file, 0o444).catch(() => undefined); // read-only where supported: an extra safeguard, the signature is the real protection
  } catch (e) {
    await fs.unlink(issued.file).catch(() => undefined); // not referenced by any record: leave the previous state
    throw e;
  }
  const issuedGrant = JSON.parse(Buffer.from((JSON.parse(await fs.readFile(issued.file, 'utf-8')) as { payload: string }).payload, 'base64url').toString('utf-8')) as { issuedAt: string };
  return { level, subject: o.subject, grantId: issued.grantId, issuedAt: issuedGrant.issuedAt, expiresAt: issued.expiresAt, recordFile, certificateFile: issued.file };
}

/**
 * Brings the project copy of the organization (policy, revocation list) up to date from the administrator directory, after
 * verifying it against the independently trusted fingerprint. Used after an administrator revokes a certificate.
 */
export async function refreshProjectAuthority(projectRoot: string, source: string, now: Date): Promise<readonly string[]> {
  const record = await readProjectAuthorization(projectRoot);
  if (!record) throw new StrictCliError('no employee authorization is set up for this project');
  const pin = await readTrustedFingerprint(projectRoot);
  if (pin === undefined || pin !== record.trustRootSha256) throw new StrictCliError('no independently trusted fingerprint matches this project: nothing was refreshed');
  const notes: string[] = [];
  await refreshFromSource(path.resolve(source), projectAuthorizationPaths(projectRoot).authorityDir, pin, now, notes);
  return notes;
}

export interface ProjectAuthorizationStatus {
  readonly record: ProjectAuthorizationRecord;
  /** Active, Expired, Revoked, Invalid (signature or content refused) or Not verified (no independently trusted fingerprint, or the organization copy cannot be loaded) */
  readonly status: 'Active' | 'Expired' | 'Revoked' | 'Invalid' | 'Not verified';
  readonly expiresAt?: string;
}

/** Describes the saved certificate for display. It verifies with the existing verifiers and the independent fingerprint; it never changes anything. */
export async function projectAuthorizationStatus(projectRoot: string, now: Date, pinOverride?: string): Promise<ProjectAuthorizationStatus | undefined> {
  const record = await readProjectAuthorization(projectRoot);
  if (!record) return undefined;
  const independent = pinOverride ?? (await readTrustedFingerprint(projectRoot));
  if (independent === undefined || independent !== record.trustRootSha256) return { record, status: 'Not verified' };
  const { configDir, authorityDir } = projectAuthorizationPaths(projectRoot);
  try {
    const authority = await loadAuthority(authorityDir, now, { forRenewal: true, trustRoot: { expectedSha256: independent } });
    const state = await grantStateOf(record, configDir, authority, now);
    const env = state.state === 'invalid' ? undefined : await readJsonFile(path.join(configDir, record.grantFile), 'the grant file');
    const g = env ? verifyGrant(env, authority.trustRoot, authority.policy, now) : undefined;
    const label = { valid: 'Active', expired: 'Expired', revoked: 'Revoked', invalid: 'Invalid', none: 'Invalid' }[state.state] as ProjectAuthorizationStatus['status'];
    return { record, status: label, ...(g?.ok ? { expiresAt: g.grant.expiresAt } : {}) };
  } catch {
    return { record, status: 'Not verified' };
  }
}

// ---------------------------------------------------------------- finding the grant again

export interface ProjectAssessCall {
  readonly action: string;
  readonly environment: string;
  readonly target: string;
  readonly inputFile?: string;
  readonly now?: () => Date;
}

/**
 * Builds the options for the EXISTING strict assessment from the project's saved record: no grant path, pin or key name has
 * to be typed. `pinOverride` (for example CODEXREV_TRUST_ROOT_SHA256) replaces the recorded pin; if it differs from the
 * trust root's fingerprint the assessment is refused. Throws a StrictCliError when there is no usable record: there is
 * never a fall-back to self-declared authorization.
 */
export async function strictOptionsFromProject(projectRoot: string, call: ProjectAssessCall, pinOverride?: string): Promise<StrictAssessOptions> {
  const record = await readProjectAuthorization(projectRoot);
  if (!record) throw new StrictCliError('no signed authorization is set up for this project. Run "codexrev init" (with the administrator\'s credentials) to obtain an administrator-signed grant. Self-declared authorization is never accepted');
  if (pinOverride !== undefined && !FINGERPRINT_PATTERN.test(pinOverride)) throw new StrictCliError('CODEXREV_TRUST_ROOT_SHA256 must be 64 lowercase hexadecimal characters');
  // the fingerprint is trusted only from outside the project: the environment or the user-level trust store, never the project record
  const independent = pinOverride ?? (await readTrustedFingerprint(projectRoot));
  if (independent === undefined) throw new StrictCliError('no independently trusted trust-root fingerprint is available for this project, so the saved authorization cannot be trusted (the project files could have been replaced). Run "codexrev init" with the administrator credentials, or set CODEXREV_TRUST_ROOT_SHA256 to the fingerprint the administrator gave you');
  if (independent !== record.trustRootSha256) throw new StrictCliError('the project authorization record names a different trust root than the independently trusted fingerprint: the project files may have been replaced. Nothing is trusted');
  const { configDir, authorityDir } = projectAuthorizationPaths(projectRoot);
  const keysDir = record.keysDir ?? defaultKeysDir();
  const pin = independent;
  const storeDir = path.join(path.dirname(keysDir), 'store', pin.slice(0, 16));
  await fs.mkdir(storeDir, { recursive: true, mode: 0o700 }); // the local challenge store keeps its state here, outside the project and the authority folder
  return {
    dir: authorityDir,
    trustRootSha256: pin,
    asKey: record.developer.keyName,
    subject: record.developer.subject,
    keysDir,
    storeKey: DEFAULT_STORE_KEY,
    storeDir,
    action: call.action,
    environment: call.environment,
    target: call.target,
    repo: path.resolve(projectRoot),
    grantFile: path.join(configDir, record.grantFile),
    ...(call.inputFile !== undefined ? { inputFile: call.inputFile } : {}),
    now: call.now ?? (() => new Date()),
  };
}
