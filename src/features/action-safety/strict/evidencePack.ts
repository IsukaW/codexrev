/**
 * Signed Evidence Pack: a record of ONE strict assessment, signed so that it can be checked offline.
 *
 * FILE FORMAT (JSON): { format, version, envelope, readable }
 *   envelope   the existing signed envelope (authorization/envelope.ts) in the dedicated `evidence_pack`
 *              domain, with its own namespace, so a signature made for a grant, a proof or a
 *              receipt can never be replayed as an Evidence Pack and the other way round. Its payload is the
 *              exact JSON bytes of the record below; the signature covers those bytes, the domain and the length.
 *   readable   a copy of the record for human eyes. It is NOT trusted: the verifier requires it to be
 *              identical to the signed record, and reports values only from the signed record.
 * There is no public key in the file. Trust in the signing key comes only from a key the VERIFIER supplies.
 *
 * WHAT A VALID PACK PROVES, and what it does not:
 *   - the holder of the signing key signed exactly this record, and it has not been changed since;
 *   - nothing about whether the assessment was CORRECT, whether the runner that produced it was modified
 *     (the runner is trusted in this prototype), or whether the action was ever executed. It is not a
 *     proof of deployment. An authentic pack may record BLOCK or ESCALATE: authentic is not the same as safe.
 *
 * TRUTHFULNESS. The record is built only from a genuine `StrictAssessResult` (checked by brand), never from
 * input-file claims. Every status says what was actually established: a step that was not reached is
 * NOT_CHECKED, a Git context that
 * was not rechecked says so, a challenge that was not consumed says NOT_CONSUMED, and an authorization that
 * was not finalized is never called FINALIZED. `checkConsistency` re-checks these rules when building and
 * again when verifying, so a record that claims ALLOW without a finalized, receipt-backed authorization is refused.
 */

import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { signEnvelope, verifyEnvelope } from '../authorization/envelope.js';
import { SHA256_DIGEST_PATTERN, isRandomId } from '../authorization/challengeCommon.js';
import { hasExactFields, isPlainObject, parseUtcTimestamp } from '../authorization/trustRoot.js';
import type { SignedEnvelope } from '../authorization/types.js';
import type { Decision } from '../model/types.js';
import { isStrictAssessResult, type Line, type StrictAssessResult } from './strictAssess.js';

export const EVIDENCE_PACK_FORMAT = 'codexrev-evidence-pack' as const;
/**
 * Version 2: four gates, no approval section. Version 1 packs (five gates, with approvals) are REJECTED with an
 * explicit message, never reinterpreted as version 2 records.
 */
export const EVIDENCE_PACK_VERSION = 2 as const;
/** the gate ids a version 2 record may contain: Human Approval is not one of them */
export const EVIDENCE_PACK_GATES = ['AUTHORIZATION', 'VERIFIED_RECOVERY', 'BUILD_TEST_RESULTS', 'SUPPORTING_EVIDENCE'] as const;
export const MAX_EVIDENCE_PACK_BYTES = 1_048_576;

export type AuthorizationStatus = 'FINALIZED' | 'VERIFIED_NOT_FINALIZED' | 'DENIED' | 'INCOMPLETE' | 'NOT_ESTABLISHED';
export type StepStatus = 'VERIFIED' | 'FAILED' | 'NOT_CHECKED' | 'PENDING' | 'NOT_APPLICABLE';
export type GitStatus = 'COLLECTED_AND_RECHECKED' | 'COLLECTED_NOT_RECHECKED' | 'CHANGED' | 'RECHECK_FAILED' | 'NOT_COLLECTED';
export type ConsumptionStatus = 'CONSUMED_RECEIPT_VERIFIED' | 'NOT_CONSUMED' | 'FAILED';
export type AssessmentStatus = 'COMPLETED' | 'INCOMPLETE_INTERPRETATION' | 'FAILED';

const AUTH_STATUSES: readonly AuthorizationStatus[] = ['FINALIZED', 'VERIFIED_NOT_FINALIZED', 'DENIED', 'INCOMPLETE', 'NOT_ESTABLISHED'];
const STEP_STATUSES: readonly StepStatus[] = ['VERIFIED', 'FAILED', 'NOT_CHECKED', 'PENDING', 'NOT_APPLICABLE'];
const GIT_STATUSES: readonly GitStatus[] = ['COLLECTED_AND_RECHECKED', 'COLLECTED_NOT_RECHECKED', 'CHANGED', 'RECHECK_FAILED', 'NOT_COLLECTED'];
const CONSUMPTION_STATUSES: readonly ConsumptionStatus[] = ['CONSUMED_RECEIPT_VERIFIED', 'NOT_CONSUMED', 'FAILED'];
const ASSESSMENT_STATUSES: readonly AssessmentStatus[] = ['COMPLETED', 'INCOMPLETE_INTERPRETATION', 'FAILED'];
const DECISIONS: readonly Decision[] = ['ALLOW', 'ESCALATE', 'BLOCK'];

export interface EvidencePackDocument {
  readonly version: typeof EVIDENCE_PACK_VERSION;
  readonly assessmentId: string;
  /** when the assessment ran (the runner's clock) */
  readonly assessedAt: string;
  readonly mode: 'strict_demo';
  readonly action: {
    readonly type: string;
    readonly environment: string;
    readonly target: string;
    readonly actionId: string | null;
    /** observed from Git; null when the Git context was never collected */
    readonly commit: string | null;
    readonly contentDigest: string | null;
  };
  readonly developer: { readonly keyProfile: string; readonly subjectId: string | null; readonly grantId: string | null; readonly roles: readonly string[] };
  readonly trust: { readonly trustRootSha256: string };
  readonly authorization: {
    readonly status: AuthorizationStatus;
    readonly trustAnchor: StepStatus;
    readonly developerGrant: StepStatus;
    readonly revocation: StepStatus;
    readonly permission: { readonly status: StepStatus; readonly required: readonly string[] | null; readonly verified: readonly string[] };
    readonly developerProof: StepStatus;
    readonly gitContext: GitStatus;
    readonly challengeConsumption: { readonly status: ConsumptionStatus; readonly receiptId: string | null; readonly consumedAt: string | null };
  };
  readonly safety: {
    readonly assessmentStatus: AssessmentStatus;
    /** null when no score was calculated */
    readonly score: number | null;
    readonly gates: readonly { readonly gate: string; readonly status: string; readonly consequence: string }[];
    readonly decision: Decision;
    readonly reasons: readonly string[];
  };
  readonly notes: readonly string[];
}

export const EVIDENCE_PACK_NOTES: readonly string[] = [
  'This record does not prove that the action was executed or deployed.',
  'A valid signature proves that the holder of the signing key signed this record, not that the assessment was correct or that the runner was unmodified.',
  'An authentic record may legitimately record BLOCK or ESCALATE.',
];

// ---------------------------------------------------------------- building (from a genuine result only)

const step = (l: Line): StepStatus => (l.status === 'VERIFIED' ? 'VERIFIED' : l.status === 'FAILED' ? 'FAILED' : l.status === 'PENDING' ? 'PENDING' : 'NOT_CHECKED');

function authorizationStatusOf(r: StrictAssessResult): AuthorizationStatus {
  switch (r.summary.authorizationState) {
    case 'finalized':
      return 'FINALIZED';
    case 'provisional_not_finalized':
      return 'VERIFIED_NOT_FINALIZED';
    default:
      return r.provenance.authorizationBasis === 'AUTHORIZATION_DENIED' ? 'DENIED' : r.provenance.authorizationBasis === 'AUTHORIZATION_INCOMPLETE' ? 'INCOMPLETE' : 'NOT_ESTABLISHED';
  }
}

export class EvidencePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidencePackError';
  }
}

/** Builds the record from a completed strict assessment. Throws EvidencePackError if the result is not genuine or is inconsistent. */
export function buildEvidencePack(result: StrictAssessResult, options: { readonly assessmentId?: string } = {}): EvidencePackDocument {
  if (!isStrictAssessResult(result)) throw new EvidencePackError('an Evidence Pack can only be built from a completed strict assessment');
  const s = result.summary;
  const p = result.provenance;
  const a = result.session?.assessment;
  const git: GitStatus = !p.context
    ? 'NOT_COLLECTED'
    : p.gitRecheck === 'unchanged' ? 'COLLECTED_AND_RECHECKED' : p.gitRecheck === 'changed' ? 'CHANGED' : p.gitRecheck === 'incomplete' ? 'RECHECK_FAILED' : 'COLLECTED_NOT_RECHECKED';
  const permissionStep = step(s.permission);
  const consumption: ConsumptionStatus = s.receipt ? 'CONSUMED_RECEIPT_VERIFIED' : s.challengeConsumption.status === 'FAILED' ? 'FAILED' : 'NOT_CONSUMED';
  const doc: EvidencePackDocument = {
    version: EVIDENCE_PACK_VERSION,
    assessmentId: options.assessmentId ?? randomBytes(16).toString('base64url'),
    assessedAt: p.assessedAt,
    mode: 'strict_demo',
    action: {
      type: result.request.action,
      environment: result.request.environment,
      target: result.request.target,
      actionId: p.context?.actionId ?? null,
      commit: p.context?.commit ?? null,
      contentDigest: p.context?.contentDigest ?? null,
    },
    developer: { keyProfile: result.request.developer, subjectId: s.developer.subjectId ?? null, grantId: s.developer.grantId ?? null, roles: [...(s.developer.roles ?? [])] },
    trust: { trustRootSha256: p.trustRootSha256 },
    authorization: {
      status: authorizationStatusOf(result),
      trustAnchor: step(s.trustAnchor),
      developerGrant: step(s.developerGrant),
      revocation: step(s.revocation),
      permission: { status: permissionStep, required: p.requiredPermissions ? [...p.requiredPermissions] : null, verified: permissionStep === 'VERIFIED' && p.requiredPermissions ? [...p.requiredPermissions] : [] },
      developerProof: step(s.developerProof),
      gitContext: git,
      challengeConsumption: { status: consumption, receiptId: s.receipt?.receiptId ?? null, consumedAt: s.receipt?.consumedAt ?? null },
    },
    safety: {
      assessmentStatus: !a ? 'FAILED' : a.status,
      score: a && a.status !== 'FAILED' ? a.safetyScore : null,
      gates: a && a.status !== 'FAILED' ? a.gates.results.map((g) => ({ gate: g.gate, status: g.status, consequence: g.consequence })) : [],
      decision: result.decision,
      reasons: s.reasons.slice(0, 30).map((x) => x.slice(0, 500)),
    },
    notes: [...EVIDENCE_PACK_NOTES],
  };
  const problem = checkConsistency(doc);
  if (problem) throw new EvidencePackError(`the assessment result is internally inconsistent, so no Evidence Pack was built: ${problem}`);
  return doc;
}

// ---------------------------------------------------------------- consistency (build and verify)

/** Rules a truthful record must satisfy. Returns the first violation, or undefined. */
export function checkConsistency(d: EvidencePackDocument): string | undefined {
  const au = d.authorization;
  const consumed = au.challengeConsumption.status === 'CONSUMED_RECEIPT_VERIFIED';
  if (consumed !== (au.challengeConsumption.receiptId !== null) || consumed !== (au.challengeConsumption.consumedAt !== null)) return 'a receipt is recorded exactly when the challenge was consumed';
  if (consumed !== (au.status === 'FINALIZED')) return 'authorization is FINALIZED exactly when the challenge was consumed with a verified receipt';
  if (au.status === 'VERIFIED_NOT_FINALIZED' && au.challengeConsumption.status !== 'NOT_CONSUMED') return 'an unfinalized authorization cannot have a consumed challenge';
  if (au.gitContext === 'CHANGED' && d.safety.decision !== 'BLOCK') return 'a changed Git context must be recorded as BLOCK';
  if (consumed && au.gitContext !== 'COLLECTED_AND_RECHECKED') return 'a challenge is consumed only after the Git context was rechecked';
  if (d.safety.assessmentStatus === 'FAILED' && (d.safety.score !== null || d.safety.decision !== 'BLOCK')) return 'a failed assessment has no score and records BLOCK';
  if (d.safety.score !== null && !(d.safety.score >= 0 && d.safety.score <= 1)) return 'the score is outside 0..1';
  if (d.safety.decision === 'ALLOW') {
    if (au.status !== 'FINALIZED' || !consumed) return 'ALLOW requires a FINALIZED authorization with a verified consumption receipt';
    if (d.safety.assessmentStatus !== 'COMPLETED') return 'ALLOW requires a completed assessment';
    if (au.trustAnchor !== 'VERIFIED' || au.developerGrant !== 'VERIFIED' || au.revocation !== 'VERIFIED' || au.permission.status !== 'VERIFIED' || au.developerProof !== 'VERIFIED') return 'ALLOW requires every authorization step to be VERIFIED';
    if (d.action.commit === null || d.action.contentDigest === null) return 'ALLOW requires the Git commit and content digest';
    if (d.safety.gates.length !== EVIDENCE_PACK_GATES.length || !EVIDENCE_PACK_GATES.every((id) => d.safety.gates.some((g) => g.gate === id))) return 'ALLOW requires exactly the four gates: Authorization, Recovery, Build/Test and Supporting Evidence';
    if (d.safety.gates.some((g) => g.status !== 'PASS' && g.status !== 'NOT_APPLICABLE')) return 'ALLOW requires every gate to PASS or be not applicable';
  }
  return undefined;
}

// ---------------------------------------------------------------- the file

export interface EvidencePackFile {
  readonly format: typeof EVIDENCE_PACK_FORMAT;
  readonly version: typeof EVIDENCE_PACK_VERSION;
  readonly envelope: SignedEnvelope;
  readonly readable: EvidencePackDocument;
}

/** Signs the record (the exact JSON bytes) in the evidence_pack domain and wraps it in the file format. */
export function createEvidencePackFile(doc: EvidencePackDocument, signingKey: KeyObject): EvidencePackFile {
  const problem = checkConsistency(doc);
  if (problem) throw new EvidencePackError(`refusing to sign an inconsistent record: ${problem}`);
  const envelope = signEnvelope({ domain: 'evidence_pack', payload: Buffer.from(JSON.stringify(doc), 'utf-8'), privateKey: signingKey });
  return { format: EVIDENCE_PACK_FORMAT, version: EVIDENCE_PACK_VERSION, envelope, readable: doc };
}

export const serializeEvidencePack = (file: EvidencePackFile): string => `${JSON.stringify(file, null, 2)}\n`;

// ---------------------------------------------------------------- verifying (offline)

/** JSON text with object keys sorted, so two copies of the same record compare equal whatever their key order. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (typeof x === 'object' && x !== null) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(x) ?? 'null';
}

export interface TrustedSigner {
  /** the signing public key, supplied by the verifier: never taken from the pack */
  readonly publicKey: KeyObject;
  readonly keyId: string;
}

export type SignatureState = 'VALID' | 'INVALID' | 'MISSING' | 'NOT_CHECKED';
export type SignerState = 'TRUSTED' | 'UNTRUSTED' | 'NOT_ESTABLISHED';
export type IntegrityState = 'VERIFIED' | 'FAILED' | 'NOT_CHECKED';

export interface EvidencePackVerification {
  readonly result: 'VALID' | 'INVALID';
  readonly signature: SignatureState;
  readonly signer: SignerState;
  readonly payloadIntegrity: IntegrityState;
  /** the decision in the SIGNED record; present only when the pack is VALID */
  readonly recordedDecision?: Decision;
  /** the signed record; present only when the pack is VALID */
  readonly pack?: EvidencePackDocument;
  readonly reason?: string;
}

const invalid = (v: Omit<EvidencePackVerification, 'result' | 'pack' | 'recordedDecision'>): EvidencePackVerification => ({ result: 'INVALID', ...v });

const isOneOf = <T extends string>(list: readonly T[], x: unknown): x is T => typeof x === 'string' && (list as readonly string[]).includes(x);
const str = (x: unknown, max = 512): x is string => typeof x === 'string' && x.length <= max;
const strOrNull = (x: unknown, max = 512): boolean => x === null || str(x, max);
const strList = (x: unknown, maxItems: number, maxLen = 512): x is string[] => Array.isArray(x) && x.length <= maxItems && x.every((i) => str(i, maxLen));
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** Strict structural validation of the signed record. Returns the record, or the first problem. */
export function parseEvidencePackDocument(x: unknown): EvidencePackDocument | string {
  if (!isPlainObject(x) || !hasExactFields(x, ['version', 'assessmentId', 'assessedAt', 'mode', 'action', 'developer', 'trust', 'authorization', 'safety', 'notes'])) return 'the signed record has missing or unexpected fields';
  if (x.version !== EVIDENCE_PACK_VERSION) return x.version === 1 ? 'unsupported record version 1 (five gates and approvals are not reinterpreted)' : 'unsupported record version';
  if (!isRandomId(x.assessmentId)) return 'the assessment id is not valid';
  if (parseUtcTimestamp(typeof x.assessedAt === 'string' ? x.assessedAt.replace(/\.\d+Z$/, 'Z') : x.assessedAt) === null) return 'the assessment time is not valid';
  if (x.mode !== 'strict_demo') return 'unknown assessment mode';
  const { action: ac, developer: dv, trust: tr, authorization: au, safety: sf } = x;
  if (!isPlainObject(ac) || !hasExactFields(ac, ['type', 'environment', 'target', 'actionId', 'commit', 'contentDigest']) || !str(ac.type, 64) || !str(ac.environment, 64) || !str(ac.target, 256) || !strOrNull(ac.actionId, 128)) return 'the action section is malformed';
  if (!(ac.commit === null || (typeof ac.commit === 'string' && COMMIT.test(ac.commit))) || !(ac.contentDigest === null || (typeof ac.contentDigest === 'string' && SHA256_DIGEST_PATTERN.test(ac.contentDigest)))) return 'the Git commit or content digest is malformed';
  if (!isPlainObject(dv) || !hasExactFields(dv, ['keyProfile', 'subjectId', 'grantId', 'roles']) || !str(dv.keyProfile, 64) || !strOrNull(dv.subjectId, 128) || !strOrNull(dv.grantId, 64) || !strList(dv.roles, 20, 64)) return 'the developer section is malformed';
  if (!isPlainObject(tr) || !hasExactFields(tr, ['trustRootSha256']) || typeof tr.trustRootSha256 !== 'string' || !FINGERPRINT.test(tr.trustRootSha256)) return 'the trust section is malformed';
  if (!isPlainObject(au) || !hasExactFields(au, ['status', 'trustAnchor', 'developerGrant', 'revocation', 'permission', 'developerProof', 'gitContext', 'challengeConsumption'])) return 'the authorization section is malformed';
  if (!isOneOf(AUTH_STATUSES, au.status) || !isOneOf(STEP_STATUSES, au.trustAnchor) || !isOneOf(STEP_STATUSES, au.developerGrant) || !isOneOf(STEP_STATUSES, au.revocation) || !isOneOf(STEP_STATUSES, au.developerProof) || !isOneOf(GIT_STATUSES, au.gitContext)) return 'an authorization status is not recognized';
  const perm = au.permission;
  if (!isPlainObject(perm) || !hasExactFields(perm, ['status', 'required', 'verified']) || !isOneOf(STEP_STATUSES, perm.status) || !(perm.required === null || strList(perm.required, 50, 128)) || !strList(perm.verified, 50, 128)) return 'the permission section is malformed';
  const cc = au.challengeConsumption;
  if (!isPlainObject(cc) || !hasExactFields(cc, ['status', 'receiptId', 'consumedAt']) || !isOneOf(CONSUMPTION_STATUSES, cc.status) || !(cc.receiptId === null || isRandomId(cc.receiptId)) || !(cc.consumedAt === null || parseUtcTimestamp(cc.consumedAt) !== null)) return 'the challenge consumption section is malformed';
  if (!isPlainObject(sf) || !hasExactFields(sf, ['assessmentStatus', 'score', 'gates', 'decision', 'reasons']) || !isOneOf(ASSESSMENT_STATUSES, sf.assessmentStatus) || !isOneOf(DECISIONS, sf.decision)) return 'the safety section is malformed';
  if (!(sf.score === null || (typeof sf.score === 'number' && Number.isFinite(sf.score))) || !strList(sf.reasons, 30, 500)) return 'the safety score or reasons are malformed';
  if (!Array.isArray(sf.gates) || sf.gates.length > 10 || !sf.gates.every((g: unknown) => isPlainObject(g) && hasExactFields(g, ['gate', 'status', 'consequence']) && isOneOf(EVIDENCE_PACK_GATES, g.gate) && str(g.status, 64) && str(g.consequence, 64))) return 'a gate entry is malformed';
  if (!strList(x.notes, 10, 500)) return 'the notes are malformed';
  return x as unknown as EvidencePackDocument;
}

/**
 * Verifies an Evidence Pack offline, against a signing key the VERIFIER trusts. Never throws; contacts nothing.
 *
 * Checks, in order: size and JSON; file format and version; the envelope; that the pack names the trusted key;
 * the signature over the exact signed bytes (domain evidence_pack); that the human-readable copy equals the signed
 * record; the strict schema of the signed record; and its internal consistency. The recorded decision is returned
 * only for a pack that passes all of them. NOTHING here re-runs the assessment or looks at live Git state.
 */
export function verifyEvidencePack(input: string | unknown, trusted: TrustedSigner): EvidencePackVerification {
  try {
    let file: unknown = input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf-8') > MAX_EVIDENCE_PACK_BYTES) return invalid({ signature: 'NOT_CHECKED', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'NOT_CHECKED', reason: 'The Evidence Pack is too large' });
      try {
        file = JSON.parse(input);
      } catch {
        return invalid({ signature: 'NOT_CHECKED', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'NOT_CHECKED', reason: 'The Evidence Pack is not valid JSON' });
      }
    }
    if (!isPlainObject(file) || file.format !== EVIDENCE_PACK_FORMAT) return invalid({ signature: 'NOT_CHECKED', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'NOT_CHECKED', reason: 'This is not a CodeXRev Evidence Pack' });
    if (file.version === 1) return invalid({ signature: 'NOT_CHECKED', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'NOT_CHECKED', reason: 'Unsupported Evidence Pack version 1: it records five gates and per-action approvals, which the current four-gate design does not use. It is not reinterpreted; create a new pack by assessing the action again' });
    if (file.version !== EVIDENCE_PACK_VERSION) return invalid({ signature: 'NOT_CHECKED', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'NOT_CHECKED', reason: 'Unsupported Evidence Pack version' });
    if (!hasExactFields(file, ['format', 'version', 'envelope', 'readable'])) {
      return invalid({ signature: isPlainObject(file.envelope) ? 'NOT_CHECKED' : 'MISSING', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'NOT_CHECKED', reason: isPlainObject(file.envelope) ? 'The Evidence Pack has missing or unexpected fields' : 'The Evidence Pack has no signature' });
    }
    const envelope = file.envelope;
    if (!isPlainObject(envelope) || typeof envelope.signature !== 'string' || envelope.signature === '') return invalid({ signature: 'MISSING', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'NOT_CHECKED', reason: 'The Evidence Pack has no signature' });

    // who claims to have signed? only the key the verifier supplied can be trusted
    if (envelope.keyId !== trusted.keyId) return invalid({ signature: 'NOT_CHECKED', signer: 'UNTRUSTED', payloadIntegrity: 'NOT_CHECKED', reason: 'The pack was signed by a key that is not the trusted signing key' });

    const verified = verifyEnvelope(envelope, { expectedDomain: 'evidence_pack', trustedPublicKey: trusted.publicKey });
    if (!verified.ok) {
      const modified = verified.code === 'signature_invalid';
      return invalid({ signature: 'INVALID', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'FAILED', reason: modified ? 'Signed content has been modified, or the signature is not from the trusted key' : `The signed envelope is not valid (${verified.code})` });
    }
    let signed: unknown;
    try {
      signed = JSON.parse(verified.payload.toString('utf-8'));
    } catch {
      return invalid({ signature: 'VALID', signer: 'TRUSTED', payloadIntegrity: 'FAILED', reason: 'The signed content is not a readable record' });
    }
    const doc = parseEvidencePackDocument(signed);
    if (typeof doc === 'string') return invalid({ signature: 'VALID', signer: 'TRUSTED', payloadIntegrity: 'FAILED', reason: doc });
    if (canonical(file.readable) !== canonical(doc)) return invalid({ signature: 'VALID', signer: 'TRUSTED', payloadIntegrity: 'FAILED', reason: 'The human-readable copy differs from the signed record' });
    const problem = checkConsistency(doc);
    if (problem) return invalid({ signature: 'VALID', signer: 'TRUSTED', payloadIntegrity: 'FAILED', reason: `The signed record is internally inconsistent: ${problem}` });
    return { result: 'VALID', signature: 'VALID', signer: 'TRUSTED', payloadIntegrity: 'VERIFIED', recordedDecision: doc.safety.decision, pack: doc };
  } catch {
    return invalid({ signature: 'NOT_CHECKED', signer: 'NOT_ESTABLISHED', payloadIntegrity: 'NOT_CHECKED', reason: 'The Evidence Pack could not be verified' });
  }
}
