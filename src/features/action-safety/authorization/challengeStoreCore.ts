/**
 * Challenge store CORE: the decision logic of a future protected challenge store.
 *
 * It issues signed challenge tokens and, on consumption, verifies a signed proof and produces a signed
 * receipt, using the exact token and receipt formats of challengeToken.ts and consumptionReceipt.ts and
 * the request/response contract of trustedChallengeStoreClient.ts. It has no network, socket, IPC,
 * service or CLI code: requests arrive as plain objects, and `createInProcessTransport` is only a
 * function-call adapter for tests and for a future privileged wrapper.
 *
 * *** THIS IS NOT A PROTECTED STORE BY ITSELF. ***
 * Run inside a process the developer controls, the developer controls the clock, the signing key, the
 * policy source and the storage directory, and can mint anything. The protection comes only from running
 * this core in a separate, privileged account (a future phase) whose key, clock and directory the
 * developer cannot reach. Nothing here proves that deployment exists.
 *
 * WHAT IS CONFIGURED BY THE OPERATOR (never read from assessment JSON, the environment or the repository):
 * organization, store id, store generation, the store's private signing key, a validated administrator
 * trust root, a source of the signed company policy and revocation list, a clock, and a persistence
 * backend. Production signing keys are never generated here. The signing key must be listed in the trust
 * root with the `challenge_store` purpose and be inside its validity window at every operation.
 *
 * INDEPENDENT VERIFICATION. The store trusts nothing the client says about itself:
 *  - issuance: the SIGNED grant is verified against the trust root and the signed policy, revocation is
 *    checked against a verified, fresh list, and the company rule for the action must permit it, with a
 *    matching role and every required permission. A "verified" label from the client is meaningless.
 *  - consumption: the grant kept at issuance is verified AGAIN against the current policy and revocation
 *    list, the SIGNED proof is verified with the grant subject's key (real proof of possession, not a
 *    digest comparison) for the recorded action and challenge, and only then is the challenge consumed.
 *    The client's proof digest is only a consistency check against the proof it sent.
 *
 * STORE-CONTROLLED TIME. Every decision uses the injected `clock`, read once per operation. An injected
 * clock is only as trustworthy as whoever controls it. This core refuses a clock that moves backwards
 * within one process (fail closed), but it cannot detect a clock set wrongly from the start, a restart
 * with an earlier clock, or a restored backup. Time sources for a real deployment are out of scope.
 *
 * ATOMIC SINGLE USE. The receipt is signed first and then committed with an exclusive create in the
 * persistence layer; the first committer wins and everyone else reads the winner's record. The receipt
 * is returned only after the commit (or when an earlier commit is read back), and the stored record
 * contains the exact signed receipt, so a retry with the same request id returns the same receipt.
 * A crash after the commit and before the response therefore cannot allow a second consumption.
 *
 * RECOVERY, ROLLBACK DETECTION AND GENERATIONS (Phase 6B.10). Records are signed by the store key, so they
 * cannot be forged or edited unnoticed, but a record can be DELETED. Every issuance and consumption is
 * therefore also written to a signed, hash-chained JOURNAL (challengeStoreJournal.ts) AFTER its record, and
 * the store compares the two:
 *  - DETECTED, and the store BLOCKS (nothing is issued or consumed, answers are `unavailable`): a journal
 *    entry whose record is missing or different (a deleted or swapped record), a deleted, reordered,
 *    altered or forged journal entry, a journal shorter than it was, a record that was never journaled and
 *    is not a plausible interrupted operation, and, with an external anchor, any state older than the anchor.
 *  - REFUSED FOR NOW (not a corruption): a clock earlier than the newest journal entry, and the quiet period.
 *  - RECOVERED WITHOUT RISK: a record whose journal entry is missing because the process stopped between
 *    the two writes. The entry is completed; nothing is ever treated as unused because it is missing.
 *  - NOT DETECTABLE LOCALLY: deleting the newest journal entries together with the newest records, or
 *    restoring an older complete copy of the whole directory, leaves a consistent past. Only an external
 *    anchor (`RollbackAnchor`), kept where the developer cannot reach it, can notice this. Without one this
 *    store does NOT protect against whole-directory rollback, and says so in `status().anchor`.
 * A blocked store stays blocked until a trusted OPERATOR acts: `operator.declareRecovery` for lost records
 * (it invalidates every challenge issued before it and can impose a quiet period), or a new generation
 * (`operator.sealGeneration`) when the chain itself is damaged. Neither is reachable through `issue`
 * or `consume`, and neither can be triggered by a request.
 *
 * RESPONSES. Success is `{ result: 'issued', token }` or `{ result: 'consumed', receipt }`. Every other
 * answer is a fixed code and is UNSIGNED: a client must treat it as unauthenticated. No answer contains
 * a challenge, a proof, a key, a path or an exception message.
 */

import { createPublicKey, KeyObject, timingSafeEqual } from 'node:crypto';
import { createChallengeToken } from './challengeToken.js';
import {
  ACKNOWLEDGEABLE_FINDINGS,
  createJournalEntry,
  emptyJournalState,
  entryHash,
  extendJournal,
  recordDigest,
  type AcknowledgeableFinding,
  type JournalEvent,
  type JournalFailureCode,
  type JournalFile,
  type JournalState,
} from './challengeStoreJournal.js';
import { createConsumptionReceipt } from './consumptionReceipt.js';
import {
  GENERATION_ID_PATTERN,
  KEY_ID_PATTERN,
  MAX_CHALLENGE_LIFETIME_MS,
  SHA256_DIGEST_PATTERN,
  STORE_ID_PATTERN,
  computeActionContextDigest,
  computeChallengeHash,
  computeProofDigest,
  isRandomId,
  isRequestId,
  wholeSecondsText,
} from './challengeCommon.js';
import { deriveKeyId, verifyEnvelope } from './envelope.js';
import { effectivePermissions, verifyGrant, type VerifiedGrant } from './grant.js';
import { requirementsFor, verifyPolicy, type VerifiedPolicy } from './policy.js';
import { parseActionContext, verifyProof, type ActionContext } from './proof.js';
import { checkRevocation, verifyRevocationList } from './revocation.js';
import { ChallengeStorePersistenceError, type ChallengeStorePersistence, type ConsumptionRecord, type IssuanceRecord, type PersistenceDurability, type ProtectionReport, type StoredEnvelope } from './challengeStorePersistence.js';
import { ORGANIZATION_ID, findTrustedKey, hasExactFields, isPlainObject, isValidatedTrustRoot, parseUtcTimestamp, type TrustRoot } from './trustRoot.js';
import type { ChallengeStoreTransport, StoreConsumeRequest, StoreIssueRequest } from './trustedChallengeStoreClient.js';
import type { SignedEnvelope } from './types.js';

export const DEFAULT_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const MAX_ISSUE_ATTEMPTS = 3;

// ---------------------------------------------------------------- configuration

/** The store's clock of record. Whoever controls this controls every expiry decision. */
export interface StoreClock {
  now(): Date;
}

/** The signed company documents, exactly as published. They are re-read and re-verified at EVERY operation. */
export interface AuthorityMaterial {
  readonly policy: unknown;
  /** the signed revocation list; undefined when none is available (then nothing can be issued or consumed) */
  readonly revocation: unknown;
}

export interface AuthoritySource {
  current(): AuthorityMaterial | Promise<AuthorityMaterial>;
}

export interface ChallengeStoreCoreConfig {
  readonly organization: string;
  readonly storeId: string;
  readonly storeGeneration: string;
  /** the store's Ed25519 private key, supplied by the operator. For isolated tests and a future privileged service only. */
  readonly signingKey: KeyObject;
  readonly trustRoot: TrustRoot;
  readonly authority: AuthoritySource;
  readonly clock: StoreClock;
  readonly persistence: ChallengeStorePersistence;
  /** challenge lifetime, 1 second to 10 minutes (default 5 minutes); never beyond the grant or the policy */
  readonly challengeLifetimeMs?: number;
  /**
   * An external rollback anchor: the ONLY way to notice a whole-directory rollback. It must live where the
   * developer cannot reach it and cannot be restored together with the store directory. Optional; without
   * it `status().anchor` is 'none' and whole-directory rollback is not detected.
   */
  readonly anchor?: RollbackAnchor;
  /** only for the first start of a new generation: the seal of the generation it continues (see operator.sealGeneration) */
  readonly continuesFrom?: GenerationSeal;
}

/** What an external anchor remembers: the newest journal position this store has reached. */
export interface AnchorState {
  readonly storeId: string;
  readonly generation: string;
  readonly sequence: number;
  readonly headHash: string;
  readonly at: string;
}

/**
 * The contract of a protected external anchor. `advance` MUST be durable and MUST reject a state whose
 * sequence is lower than the stored one, or equal with a different hash; `read` returns the newest state or
 * undefined for a brand-new anchor. This phase defines the contract and tests it with a test double; a real
 * anchor needs the future privileged service (or an equivalent separate trust domain).
 */
export interface RollbackAnchor {
  read(): Promise<AnchorState | undefined>;
  advance(next: AnchorState): Promise<void>;
}

/** Proof, from the operator, that one generation was closed and which generation follows it. */
export interface GenerationSeal {
  readonly storeId: string;
  readonly generation: string;
  readonly nextGeneration: string;
  readonly sequence: number;
  readonly headHash: string;
}

export type CoreConfigFailureCode = 'invalid_config' | 'invalid_signing_key' | 'signing_key_not_trusted' | 'organization_mismatch' | 'invalid_clock';
export type CoreCreationResult = { readonly ok: true; readonly core: ChallengeStoreCore; readonly operator: ChallengeStoreOperator } | { readonly ok: false; readonly code: CoreConfigFailureCode };

// ---------------------------------------------------------------- responses (match the Phase 6B.8 client)

export type IssueRefusal = 'invalid_request' | 'unknown_grant' | 'grant_revoked' | 'not_authorized' | 'rate_limited' | 'unavailable';
export type ConsumeRefusal = 'already_used' | 'expired' | 'unknown_challenge' | 'binding_mismatch' | 'invalid_request' | 'invalid_proof' | 'not_authorized' | 'unavailable';

export type StoreIssueResponse = { readonly result: 'issued'; readonly token: SignedEnvelope } | { readonly result: 'rejected'; readonly reason: IssueRefusal };
export type StoreConsumeResponse = { readonly result: 'consumed'; readonly receipt: SignedEnvelope } | { readonly result: ConsumeRefusal };

export type FindingCode = JournalFailureCode | AcknowledgeableFinding | 'journal_empty_with_records' | 'journal_rolled_back' | 'rollback_detected' | 'anchor_inconsistent';

export interface StoreStatus {
  readonly phase: 'not_started' | 'ready' | 'quiet' | 'blocked' | 'retired';
  /** why the store is blocked: codes only, never record content */
  readonly findings: readonly FindingCode[];
  /** true when an operator recovery event can clear the block (record-level losses only; never chain damage) */
  readonly recoverableInPlace: boolean;
  readonly headSequence: number;
  readonly quietUntil?: string;
  readonly protection: ProtectionReport;
  readonly durability: PersistenceDurability;
  /** 'none': whole-directory rollback is NOT detected */
  readonly anchor: 'none' | 'configured';
}

export type OperatorResult<T = Record<string, never>> = ({ readonly ok: true } & T) | { readonly ok: false; readonly code: 'invalid_request' | 'not_ready' | 'not_recoverable_in_place' | 'unacknowledged_findings' | 'storage_failure'; readonly missing?: readonly AcknowledgeableFinding[] };

/**
 * Actions that only the trusted operator of the store may take. They are NOT part of `ChallengeStoreCore`,
 * are never reached from `issue` or `consume`, and take no assessment data. In this phase "trusted operator"
 * means "code holding the store's signing key": a privileged service must still authenticate the operator.
 */
export interface ChallengeStoreOperator {
  /**
   * Records that the store was restored or lost records. Appends a signed recovery entry that (1) names the
   * findings the operator acknowledges, (2) permanently invalidates every challenge issued before it, and
   * (3) pauses the store until `quietPeriodMs` has passed (1 second to 24 hours). It refuses to clear a
   * block unless every current finding is acknowledged, and refuses chain damage entirely.
   */
  declareRecovery(options: { readonly acknowledge: readonly AcknowledgeableFinding[]; readonly quietPeriodMs: number }): Promise<OperatorResult<{ readonly status: StoreStatus }>>;
  /**
   * Retires this generation: appends a signed `seal` entry after which this directory refuses to run, and
   * returns the seal that the new generation's first start needs (`continuesFrom`).
   */
  sealGeneration(options: { readonly nextGeneration: string }): Promise<OperatorResult<{ readonly seal: GenerationSeal }>>;
}

export interface ChallengeStoreCore {
  readonly identity: { readonly organization: string; readonly storeId: string; readonly storeGeneration: string; readonly signingKeyId: string };
  /** What is known right now, without any I/O. */
  status(): StoreStatus;
  /** Runs (or waits for) recovery and returns the resulting status. Called automatically by the first operation. */
  recover(): Promise<StoreStatus>;
  /** Never throws. `request` is untrusted input of unknown shape. */
  issue(request: unknown): Promise<StoreIssueResponse>;
  /** Never throws. `request` is untrusted input of unknown shape. */
  consume(request: unknown): Promise<StoreConsumeResponse>;
}

/**
 * A function-call adapter so the Phase 6B.8 client can talk to a core in the same process (tests, or a
 * future privileged wrapper that owns the real channel). It adds NO protection: an in-process transport
 * is as trustworthy as the process it runs in.
 */
export function createInProcessTransport(core: ChallengeStoreCore): ChallengeStoreTransport {
  return Object.freeze({
    issue: async (request: StoreIssueRequest) => core.issue(request),
    consume: async (request: StoreConsumeRequest) => core.consume(request),
  });
}

// ---------------------------------------------------------------- request parsing

const ISSUE_FIELDS = ['organization', 'storeId', 'grantId', 'subjectId', 'subjectKeyId', 'context', 'contextDigest', 'grant'] as const;
const CONSUME_FIELDS = ['requestId', 'organization', 'storeId', 'challengeId', 'challenge', 'grantId', 'subjectId', 'subjectKeyId', 'contextDigest', 'proofDigest', 'proof'] as const;

interface ParsedIssue {
  readonly organization: string;
  readonly storeId: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: string;
  readonly context: ActionContext;
  readonly grant: Record<string, unknown>;
}

interface ParsedConsume {
  readonly requestId: string;
  readonly organization: string;
  readonly storeId: string;
  readonly challengeId: string;
  readonly challenge: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: string;
  readonly contextDigest: string;
  readonly proofDigest: string;
  readonly proof: unknown;
}

const text = (x: unknown, max = 256): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;

function parseIssueRequest(x: unknown): ParsedIssue | undefined {
  if (!isPlainObject(x) || !hasExactFields(x, ISSUE_FIELDS)) return undefined;
  if (!text(x.organization) || !text(x.storeId) || !text(x.grantId) || !text(x.subjectId) || !text(x.subjectKeyId) || !text(x.contextDigest)) return undefined;
  if (!KEY_ID_PATTERN.test(x.subjectKeyId) || !SHA256_DIGEST_PATTERN.test(x.contextDigest) || !isPlainObject(x.grant)) return undefined;
  const ctx = parseActionContext(x.context);
  if (!ctx.ok) return undefined;
  if (computeActionContextDigest(ctx.context) !== x.contextDigest) return undefined;
  return { organization: x.organization, storeId: x.storeId, grantId: x.grantId, subjectId: x.subjectId, subjectKeyId: x.subjectKeyId, context: ctx.context, grant: x.grant };
}

function parseConsumeRequest(x: unknown): ParsedConsume | undefined {
  if (!isPlainObject(x) || !hasExactFields(x, CONSUME_FIELDS)) return undefined;
  if (!isRequestId(x.requestId) || !isRandomId(x.challengeId)) return undefined;
  if (!text(x.organization) || !text(x.storeId) || !text(x.challenge) || !text(x.grantId) || !text(x.subjectId) || !text(x.subjectKeyId) || !text(x.contextDigest) || !text(x.proofDigest)) return undefined;
  if (!KEY_ID_PATTERN.test(x.subjectKeyId) || !SHA256_DIGEST_PATTERN.test(x.contextDigest) || !SHA256_DIGEST_PATTERN.test(x.proofDigest)) return undefined;
  if (x.proof === undefined || x.proof === null) return undefined;
  return {
    requestId: x.requestId,
    organization: x.organization,
    storeId: x.storeId,
    challengeId: x.challengeId,
    challenge: x.challenge,
    grantId: x.grantId,
    subjectId: x.subjectId,
    subjectKeyId: x.subjectKeyId,
    contextDigest: x.contextDigest,
    proofDigest: x.proofDigest,
    proof: x.proof,
  };
}


// ---------------------------------------------------------------- the core

type Authorized =
  | { readonly ok: true; readonly grant: VerifiedGrant; readonly policy: VerifiedPolicy }
  | { readonly ok: false; readonly reason: 'unknown_grant' | 'grant_revoked' | 'not_authorized' | 'unavailable' };

/** A hostile request object (for example a Proxy) must read as malformed, never as an internal failure. */
function safely<T>(parse: () => T | undefined): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

const sameDigest = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** An orphan record (no journal entry) is only believed to be an interrupted operation if it is this recent. */
const ADOPTION_WINDOW_MS = MAX_CHALLENGE_LIFETIME_MS + 60_000;
const MAX_QUIET_PERIOD_MS = 24 * 60 * 60 * 1000;
const MAX_APPEND_ATTEMPTS = 6;
const floorSecond = (ms: number): number => Math.floor(ms / 1000) * 1000;

interface Finding {
  readonly code: FindingCode;
}

export function createChallengeStoreCore(config: ChallengeStoreCoreConfig): CoreCreationResult {
  try {
    const refuse = (code: CoreConfigFailureCode): CoreCreationResult => ({ ok: false, code });
    if (!isPlainObject(config)) return refuse('invalid_config');
    const { organization, storeId, storeGeneration, signingKey, trustRoot, authority, clock, persistence, anchor, continuesFrom } = config;
    if (typeof organization !== 'string' || !ORGANIZATION_ID.test(organization)) return refuse('invalid_config');
    if (typeof storeId !== 'string' || !STORE_ID_PATTERN.test(storeId)) return refuse('invalid_config');
    if (typeof storeGeneration !== 'string' || !GENERATION_ID_PATTERN.test(storeGeneration)) return refuse('invalid_config');
    if (!isValidatedTrustRoot(trustRoot)) return refuse('invalid_config');
    if (trustRoot.organization !== organization) return refuse('organization_mismatch');
    const lifetime = config.challengeLifetimeMs ?? DEFAULT_CHALLENGE_LIFETIME_MS;
    if (typeof lifetime !== 'number' || !Number.isInteger(lifetime) || lifetime < 1000 || lifetime > MAX_CHALLENGE_LIFETIME_MS) return refuse('invalid_config');
    if (typeof authority?.current !== 'function' || typeof clock?.now !== 'function') return refuse('invalid_config');
    for (const method of ['createIssuance', 'getIssuance', 'commitConsumption', 'getConsumption', 'readJournal', 'readJournalTail', 'appendJournal', 'listIssuanceIds', 'listConsumptionIds'] as const) {
      if (typeof persistence?.[method] !== 'function') return refuse('invalid_config');
    }
    if (anchor !== undefined && (typeof anchor?.read !== 'function' || typeof anchor.advance !== 'function')) return refuse('invalid_config');
    if (continuesFrom !== undefined && !(isPlainObject(continuesFrom) && continuesFrom.storeId === storeId && continuesFrom.nextGeneration === storeGeneration && typeof continuesFrom.generation === 'string' && GENERATION_ID_PATTERN.test(continuesFrom.generation) && continuesFrom.generation !== storeGeneration && Number.isSafeInteger(continuesFrom.sequence) && continuesFrom.sequence >= 1 && typeof continuesFrom.headHash === 'string' && SHA256_DIGEST_PATTERN.test(continuesFrom.headHash))) return refuse('invalid_config');
    if (!(signingKey instanceof KeyObject) || signingKey.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519') return refuse('invalid_signing_key');

    const publicKey = createPublicKey(signingKey);
    const signingKeyId = deriveKeyId(publicKey);
    const journalContext = { publicKey, organization, storeId, storeGeneration };

    // ---- the store's clock: read once per operation, valid, and never moving backwards
    let highWater = Number.NEGATIVE_INFINITY;
    const readClock = (): Date | undefined => {
      let value: unknown;
      try {
        value = clock.now();
      } catch {
        return undefined;
      }
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
      const t = value.getTime();
      if (t < highWater) return undefined; // a clock that goes backwards is never trusted
      highWater = t;
      return new Date(t);
    };

    const first = readClock();
    if (!first) return refuse('invalid_clock');
    // the signing key must be a trusted challenge_store key now (and is re-checked at every operation)
    if (!findTrustedKey(trustRoot, signingKeyId, 'challenge_store', first).ok) return refuse('signing_key_not_trusted');

    const signingKeyUsable = (now: Date): boolean => findTrustedKey(trustRoot, signingKeyId, 'challenge_store', now).ok;

    // ---- independent authorization of the requester for one exact action
    async function authorize(grantEnvelope: unknown, context: ActionContext, now: Date): Promise<Authorized> {
      let material: AuthorityMaterial;
      try {
        material = await authority.current();
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (!isPlainObject(material)) return { ok: false, reason: 'unavailable' };
      const policy = verifyPolicy(material.policy, trustRoot, now);
      if (!policy.ok) return { ok: false, reason: 'unavailable' };
      const grant = verifyGrant(grantEnvelope, trustRoot, policy.policy, now);
      if (!grant.ok) return { ok: false, reason: 'unknown_grant' };
      if (grant.grant.organization !== organization) return { ok: false, reason: 'unknown_grant' };
      const list = verifyRevocationList(material.revocation, trustRoot, now);
      const status = checkRevocation(grant, list, now);
      if (status.status === 'revoked') return { ok: false, reason: 'grant_revoked' };
      if (status.status !== 'not_listed') return { ok: false, reason: 'unavailable' }; // a stale or missing list never counts as "not revoked"
      const need = requirementsFor(policy.policy, context.actionType, context.environment);
      if (!need.permitted) return { ok: false, reason: 'not_authorized' };
      const effective = effectivePermissions(grant, policy.policy);
      if (!effective.ok) return { ok: false, reason: 'not_authorized' };
      if (!effective.roles.some((r) => need.requiredRoles.includes(r))) return { ok: false, reason: 'not_authorized' };
      if (need.requiredPermissions.some((p) => !effective.permissions.includes(p))) return { ok: false, reason: 'not_authorized' };
      return { ok: true, grant, policy };
    }

    // ---- reading back what this store itself signed: tamper evidence for stored records
    interface Issued {
      readonly doc: { readonly organization: string; readonly storeId: string; readonly storeGeneration: string; readonly challengeId: string; readonly challenge: string; readonly grantId: string; readonly subjectId: string; readonly subjectKeyId: string; readonly contextDigest: string; readonly issuedAt: string; readonly expiresAt: string };
      readonly context: ActionContext;
      readonly grant: StoredEnvelope;
      readonly tokenDigest: string;
    }

    const ownPayload = (envelope: StoredEnvelope, domain: 'challenge' | 'receipt'): Record<string, unknown> | undefined => {
      const verified = verifyEnvelope(envelope, { expectedDomain: domain, trustedPublicKey: publicKey });
      if (!verified.ok) return undefined;
      try {
        const doc: unknown = JSON.parse(verified.payload.toString('utf-8'));
        return isPlainObject(doc) ? doc : undefined;
      } catch {
        return undefined;
      }
    };

    /** a stored issuance record that this store signed, for exactly this id; undefined if it is not */
    const parseIssued = (record: IssuanceRecord, challengeId: string): Issued | undefined => {
      const doc = ownPayload(record.token, 'challenge');
      const ctx = parseActionContext(record.context);
      if (!doc || !ctx.ok) return undefined;
      const wellFormed =
        doc.challengeId === challengeId &&
        doc.organization === organization &&
        doc.storeId === storeId &&
        doc.storeGeneration === storeGeneration &&
        text(doc.challenge) && text(doc.grantId) && text(doc.subjectId) && text(doc.subjectKeyId) && text(doc.contextDigest) && text(doc.issuedAt) && text(doc.expiresAt) &&
        doc.contextDigest === computeActionContextDigest(ctx.context);
      if (!wellFormed) return undefined;
      return { doc: doc as unknown as Issued['doc'], context: ctx.context, grant: record.grant, tokenDigest: recordDigest(record.token) };
    };

    /** undefined = no such record; 'corrupt' = present but not a record this store signed */
    const loadIssued = async (challengeId: string): Promise<Issued | undefined | 'corrupt'> => {
      const record: IssuanceRecord | undefined = await persistence.getIssuance(challengeId);
      if (!record) return undefined;
      return parseIssued(record, challengeId) ?? 'corrupt';
    };

    /** the existing consumption must be a receipt this store signed for exactly this challenge */
    const consumptionIntact = (existing: ConsumptionRecord, issued: Issued): boolean => {
      const doc = ownPayload(existing.receipt, 'receipt');
      return (
        doc !== undefined &&
        doc.challengeId === issued.doc.challengeId &&
        doc.challengeHash === computeChallengeHash(issued.doc.challenge) &&
        doc.requestId === existing.requestId &&
        doc.proofDigest === existing.proofDigest &&
        doc.grantId === issued.doc.grantId &&
        doc.subjectId === issued.doc.subjectId &&
        doc.subjectKeyId === issued.doc.subjectKeyId &&
        doc.contextDigest === issued.doc.contextDigest &&
        doc.storeId === storeId &&
        doc.storeGeneration === storeGeneration
      );
    };

    const replay = (existing: ConsumptionRecord, issued: Issued, req: ParsedConsume): StoreConsumeResponse => {
      if (!consumptionIntact(existing, issued)) return { result: 'unavailable' };
      if (existing.requestId !== req.requestId) return { result: 'already_used' };
      if (existing.proofDigest !== req.proofDigest) return { result: 'binding_mismatch' }; // same request id, different proof
      return { result: 'consumed', receipt: existing.receipt as SignedEnvelope };
    };

    // ================================================================ journal, recovery and rollback detection
    let state: JournalState = emptyJournalState;
    let phase: 'new' | 'ready' | 'blocked' | 'retired' = 'new';
    let findings: Finding[] = [];
    let chainIntact = true;
    let recovering: Promise<void> | undefined;

    /**
     * A storage failure is either transient (I/O trouble: refuse this operation, decide nothing) or an
     * INTEGRITY problem in what is stored (a corrupt or unexpected file, a replaced directory, unsafe
     * permissions): that blocks the store, and it is chain damage, which no in-place recovery clears.
     */
    const storageFailure = (e: unknown): void => {
      if (e instanceof ChallengeStorePersistenceError && e.code !== 'io_error' && e.code !== 'invalid_input') block([{ code: 'journal_corrupt' }], false);
    };

    const block = (found: readonly Finding[], intact: boolean): void => {
      phase = 'blocked';
      findings = [...found];
      chainIntact = intact;
    };

    /** merge journal files that have not been applied yet; any problem blocks the store (chain damage: not recoverable in place) */
    const applyFiles = (files: readonly { readonly sequence: number; readonly envelope: StoredEnvelope }[]): boolean => {
      const fresh: JournalFile[] = files.filter((f) => f.sequence > state.headSequence).map((f) => ({ sequence: f.sequence, envelope: f.envelope as SignedEnvelope }));
      if (fresh.length === 0) return true;
      const result = extendJournal(state, fresh, journalContext);
      if (!result.ok) {
        block([{ code: result.code }], false);
        return false;
      }
      state = result.state;
      if (state.sealed) phase = 'retired';
      return true;
    };

    const anchorStateOf = (sequence: number, headHash: string, at: Date): AnchorState => ({ storeId, generation: storeGeneration, sequence, headHash, at: wholeSecondsText(at.getTime()) });

    /** compares the external anchor with the journal: ahead = rolled back; lagging = a crash before the anchor update, repaired here */
    const syncAnchor = async (now: Date): Promise<boolean> => {
      if (!anchor) return true;
      const a = await anchor.read();
      if (a !== undefined) {
        if (!isPlainObject(a) || a.storeId !== storeId || a.generation !== storeGeneration || !Number.isSafeInteger(a.sequence) || typeof a.headHash !== 'string') {
          block([{ code: 'anchor_inconsistent' }], false);
          return false;
        }
        if (a.sequence > state.headSequence) {
          block([{ code: 'rollback_detected' }], false);
          return false;
        }
        if (a.sequence >= 1 && state.hashes.get(a.sequence) !== a.headHash) {
          block([{ code: 'anchor_inconsistent' }], false);
          return false;
        }
        if (a.sequence === state.headSequence) return true;
      }
      if (state.headSequence >= 1) await anchor.advance(anchorStateOf(state.headSequence, state.headHash, now));
      return true;
    };

    /** appends one signed entry at the next free sequence number; another writer taking it means: read theirs, try again */
    const append = async (event: JournalEvent, now: Date, stillNeeded: () => boolean = () => true): Promise<void> => {
      for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
        // another caller (or process) may have written the same fact meanwhile: never write it twice
        if (!stillNeeded()) return;
        if (floorSecond(now.getTime()) < state.lastAtMs) throw new Error('clock behind journal');
        const sequence = state.headSequence + 1;
        const envelope = createJournalEntry({ privateKey: signingKey, organization, storeId, storeGeneration, sequence, previousHash: state.headHash, at: now, event });
        const outcome = await persistence.appendJournal(sequence, envelope as unknown as StoredEnvelope);
        if (outcome === 'created') {
          if (!applyFiles([{ sequence, envelope: envelope as unknown as StoredEnvelope }])) throw new Error('journal damaged');
          if (anchor) await anchor.advance(anchorStateOf(sequence, entryHash(envelope), now));
          return;
        }
        if (!applyFiles(await persistence.readJournal(state.headSequence))) throw new Error('journal damaged');
      }
      throw new Error('journal contention');
    };

    const findingsFor = (code: AcknowledgeableFinding): Finding => ({ code });

    /** orphan records (written, but the process stopped before the journal entry) are completed only if they are recent enough to be that */
    const plausiblyInterrupted = (recordMs: number, now: Date): boolean => recordMs >= state.lastAtMs - ADOPTION_WINDOW_MS && recordMs <= now.getTime() + 1000;

    const adoptIssuance = async (issued: Issued, now: Date): Promise<boolean> => {
      if (state.issued.has(issued.doc.challengeId)) return true;
      const at = parseUtcTimestamp(issued.doc.issuedAt) as number;
      if (!plausiblyInterrupted(at, now)) return false;
      await append({ kind: 'issue', challengeId: issued.doc.challengeId, tokenDigest: issued.tokenDigest, expiresAt: issued.doc.expiresAt }, now, () => !state.issued.has(issued.doc.challengeId));
      return state.issued.has(issued.doc.challengeId);
    };

    const adoptConsumption = async (existing: ConsumptionRecord, issued: Issued, now: Date): Promise<boolean> => {
      if (state.consumed.has(existing.challengeId)) return true;
      if (!consumptionIntact(existing, issued)) return false;
      const doc = ownPayload(existing.receipt, 'receipt');
      const at = parseUtcTimestamp(doc?.consumedAt) as number | null;
      if (at === null || !plausiblyInterrupted(at, now)) return false;
      await append({ kind: 'consume', challengeId: existing.challengeId, requestId: existing.requestId, receiptDigest: recordDigest(existing.receipt) }, now, () => !state.consumed.has(existing.challengeId));
      return state.consumed.has(existing.challengeId);
    };

    const lastRecovery = () => state.recoveries[state.recoveries.length - 1];
    /** a finding about a record that predates an operator recovery event which acknowledged it is a known loss, not a new problem */
    const acknowledged = (code: AcknowledgeableFinding, sequence: number): boolean => {
      const r = lastRecovery();
      return r !== undefined && sequence < r.sequence && r.acknowledged.includes(code);
    };

    /** every journal entry against the record it names, and every record against the journal */
    const crossCheck = async (now: Date): Promise<Finding[]> => {
      const found: Finding[] = [];
      for (const [id, entry] of state.issued) {
        let record: IssuanceRecord | undefined;
        try {
          record = await persistence.getIssuance(id);
        } catch {
          if (!acknowledged('issuance_record_mismatch', entry.sequence)) found.push(findingsFor('issuance_record_mismatch'));
          continue;
        }
        if (!record) {
          if (!acknowledged('issuance_record_missing', entry.sequence)) found.push(findingsFor('issuance_record_missing'));
        } else if (recordDigest(record.token) !== entry.tokenDigest && !acknowledged('issuance_record_mismatch', entry.sequence)) found.push(findingsFor('issuance_record_mismatch'));
      }
      for (const [id, entry] of state.consumed) {
        let record: ConsumptionRecord | undefined;
        try {
          record = await persistence.getConsumption(id);
        } catch {
          if (!acknowledged('consumption_record_mismatch', entry.sequence)) found.push(findingsFor('consumption_record_mismatch'));
          continue;
        }
        if (!record) {
          if (!acknowledged('consumption_record_missing', entry.sequence)) found.push(findingsFor('consumption_record_missing'));
        } else if (recordDigest(record.receipt) !== entry.receiptDigest && !acknowledged('consumption_record_mismatch', entry.sequence)) found.push(findingsFor('consumption_record_mismatch'));
      }
      // records the journal does not know about: complete a plausible interrupted write, otherwise it is a finding
      for (const id of await persistence.listIssuanceIds()) {
        if (state.issued.has(id)) continue;
        const issued = await loadIssued(id);
        if (issued === undefined || issued === 'corrupt' || !(await adoptIssuance(issued, now))) found.push(findingsFor('unjournaled_record'));
      }
      for (const id of await persistence.listConsumptionIds()) {
        if (state.consumed.has(id)) continue;
        const issued = await loadIssued(id);
        const record = issued === undefined || issued === 'corrupt' ? undefined : await persistence.getConsumption(id);
        if (!issued || issued === 'corrupt' || !record || !state.issued.has(id) || !(await adoptConsumption(record, issued, now))) found.push(findingsFor('unjournaled_record'));
      }
      return found;
    };

    async function runRecovery(): Promise<void> {
      try {
        const now = readClock();
        if (!now) return; // transient: try again at the next operation
        state = emptyJournalState;
        let files = await persistence.readJournal(0);
        if (files.length === 0) {
          // a journal-less directory that holds records cannot be a store we ever wrote through the journal
          if ((await persistence.listIssuanceIds()).length + (await persistence.listConsumptionIds()).length > 0) {
            block([{ code: 'journal_empty_with_records' }], false);
            return;
          }
          const genesis: JournalEvent = continuesFrom
            ? { kind: 'genesis', previousGeneration: continuesFrom.generation, previousSequence: continuesFrom.sequence, previousHash: continuesFrom.headHash }
            : { kind: 'genesis', previousGeneration: null, previousSequence: null, previousHash: null };
          // several cores may start together: whoever creates the genesis wins, the others must not add a second one
          await append(genesis, now, () => state.headSequence === 0);
          files = await persistence.readJournal(0);
          state = emptyJournalState;
        }
        if (!applyFiles(files)) return;
        if (phase === 'retired') return;
        const g = state.genesis;
        if (continuesFrom && g && (g.previousHash !== continuesFrom.headHash || g.previousGeneration !== continuesFrom.generation || g.previousSequence !== continuesFrom.sequence)) {
          block([{ code: 'journal_bad_genesis' }], false);
          return;
        }
        if (!(await syncAnchor(now))) return;
        const found = await crossCheck(now);
        if (found.length > 0) {
          block(found, true);
          return;
        }
        if (!(await syncAnchor(now))) return;
        findings = [];
        chainIntact = true;
        phase = 'ready';
      } catch (e) {
        // an I/O failure during recovery is transient: the store stays "not started" and answers `unavailable`
        storageFailure(e);
        if (phase === 'new') state = emptyJournalState;
      }
    }

    const recoverOnce = async (): Promise<void> => {
      recovering ??= runRecovery().finally(() => {
        recovering = undefined;
      });
      await recovering;
    };

    /** bring the in-memory view up to date with the directory and the anchor; false = refuse this operation */
    const refresh = async (now: Date): Promise<boolean> => {
      try {
        const tail = await persistence.readJournalTail();
        if (!tail || tail.sequence < state.headSequence) {
          block([{ code: 'journal_rolled_back' }], false); // the journal has become shorter than it was
          return false;
        }
        if (tail.sequence > state.headSequence) {
          if (!applyFiles(await persistence.readJournal(state.headSequence))) return false;
        } else if (entryHash(tail.envelope) !== state.headHash) {
          block([{ code: 'journal_chain_broken' }], false);
          return false;
        }
        if (state.sealed) {
          phase = 'retired';
          return false;
        }
        return await syncAnchor(now);
      } catch (e) {
        storageFailure(e);
        return false; // refuse this operation, decide nothing
      }
    };

    type Gate = { readonly ok: true; readonly now: Date } | { readonly ok: false };
    /** every issuance and consumption passes here: recovered, current, not blocked, not retired, not in the quiet period, clock not behind the journal */
    const gate = async (): Promise<Gate> => {
      if (phase === 'new') await recoverOnce();
      if (phase !== 'ready') return { ok: false };
      const now = readClock();
      if (!now || !(await refresh(now)) || phase !== 'ready') return { ok: false };
      if (floorSecond(now.getTime()) < state.lastAtMs) return { ok: false }; // the clock is earlier than the newest journal entry
      const r = lastRecovery();
      if (r && now.getTime() < r.quietUntilMs) return { ok: false }; // quiet period after an operator recovery
      return { ok: true, now };
    };

    // ---------------------------------------------------------------- issuance
    async function issue(raw: unknown): Promise<StoreIssueResponse> {
      try {
        const req = safely(() => parseIssueRequest(raw));
        if (!req) return { result: 'rejected', reason: 'invalid_request' };
        if (req.organization !== organization || req.storeId !== storeId) return { result: 'rejected', reason: 'invalid_request' };
        const gated = await gate();
        if (!gated.ok) return { result: 'rejected', reason: 'unavailable' };
        const now = gated.now;
        if (!signingKeyUsable(now)) return { result: 'rejected', reason: 'unavailable' };

        const auth = await authorize(req.grant, req.context, now);
        if (!auth.ok) return { result: 'rejected', reason: auth.reason };
        // the ids the client sent are claims; they must be the ones in the grant the store verified itself
        const g = auth.grant.grant;
        if (g.grantId !== req.grantId || g.subject.id !== req.subjectId || g.subject.keyId !== req.subjectKeyId) return { result: 'rejected', reason: 'invalid_request' };

        // a challenge never outlives the grant or the policy it was issued under
        const start = floorSecond(now.getTime());
        const limit = Math.min(start + lifetime, parseUtcTimestamp(g.expiresAt) as number, parseUtcTimestamp(auth.policy.policy.expiresAt) as number);
        const lifetimeMs = Math.floor((limit - start) / 1000) * 1000;
        if (lifetimeMs < 1000) return { result: 'rejected', reason: 'not_authorized' };

        for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt++) {
          const token = createChallengeToken({ privateKey: signingKey, organization, storeId, storeGeneration, grantId: g.grantId, subjectId: g.subject.id, subjectKeyId: g.subject.keyId, context: req.context, issuedAt: now, lifetimeMs });
          const payload = JSON.parse(Buffer.from(token.payload, 'base64url').toString('utf-8')) as { challengeId: string; expiresAt: string };
          // the record is durable BEFORE the token leaves this function; a failure here returns no token
          const outcome = await persistence.createIssuance({ version: 1, challengeId: payload.challengeId, token, context: { ...req.context }, grant: req.grant as unknown as StoredEnvelope });
          if (outcome === 'exists') continue; // an id collision never overwrites; draw a new challenge
          // ...and so is its journal entry; if this fails the record is an orphan that recovery can complete, and no token is returned
          await append({ kind: 'issue', challengeId: payload.challengeId, tokenDigest: recordDigest(token), expiresAt: payload.expiresAt }, now, () => !state.issued.has(payload.challengeId));
          return { result: 'issued', token };
        }
        return { result: 'rejected', reason: 'unavailable' };
      } catch {
        return { result: 'rejected', reason: 'unavailable' };
      }
    }

    // ---------------------------------------------------------------- consumption
    async function consume(raw: unknown): Promise<StoreConsumeResponse> {
      try {
        const req = safely(() => parseConsumeRequest(raw));
        if (!req) return { result: 'invalid_request' };
        let digest: string;
        try {
          digest = computeProofDigest(req.proof);
        } catch {
          return { result: 'invalid_request' };
        }
        if (!sameDigest(digest, req.proofDigest)) return { result: 'binding_mismatch' };
        if (req.organization !== organization || req.storeId !== storeId) return { result: 'binding_mismatch' };

        const gated = await gate();
        if (!gated.ok) return { result: 'unavailable' };
        const now = gated.now;

        const issued = await loadIssued(req.challengeId);
        const journaledIssue = state.issued.get(req.challengeId);
        if (issued === 'corrupt') return { result: 'unavailable' };
        if (issued === undefined) {
          if (!journaledIssue) return { result: 'unknown_challenge' };
          // the journal says this challenge was issued but its record is gone
          if (acknowledged('issuance_record_missing', journaledIssue.sequence)) return { result: 'unknown_challenge' };
          block([{ code: 'issuance_record_missing' }], true);
          return { result: 'unavailable' };
        }
        if (!journaledIssue) {
          // a record without an entry: complete it only if it is a plausible interrupted write
          if (!(await adoptIssuance(issued, now))) {
            block([{ code: 'unjournaled_record' }], true);
            return { result: 'unavailable' };
          }
        } else if (journaledIssue.tokenDigest !== issued.tokenDigest) {
          block([{ code: 'issuance_record_mismatch' }], true);
          return { result: 'unavailable' };
        }
        const issuedEntry = state.issued.get(req.challengeId);
        if (!issuedEntry) return { result: 'unavailable' };

        if (!sameDigest(computeChallengeHash(req.challenge), computeChallengeHash(issued.doc.challenge))) return { result: 'unknown_challenge' };
        const d = issued.doc;
        if (d.grantId !== req.grantId || d.subjectId !== req.subjectId || d.subjectKeyId !== req.subjectKeyId || d.contextDigest !== req.contextDigest) return { result: 'binding_mismatch' };

        // ---- has it been consumed? The record and the journal must agree about it
        const existing = await persistence.getConsumption(req.challengeId);
        const journaledUse = state.consumed.get(req.challengeId);
        if (journaledUse && !existing) {
          // the journal says it was consumed and the record is gone: never treated as unused
          if (acknowledged('consumption_record_missing', journaledUse.sequence)) return { result: 'already_used' };
          block([{ code: 'consumption_record_missing' }], true);
          return { result: 'unavailable' };
        }
        if (existing) {
          if (journaledUse && recordDigest(existing.receipt) !== journaledUse.receiptDigest) {
            if (acknowledged('consumption_record_mismatch', journaledUse.sequence)) return { result: 'already_used' };
            block([{ code: 'consumption_record_mismatch' }], true);
            return { result: 'unavailable' };
          }
          if (!journaledUse && !(await adoptConsumption(existing, issued, now))) {
            block([{ code: 'unjournaled_record' }], true);
            return { result: 'unavailable' };
          }
          return replay(existing, issued, req); // an event that already happened is not undone
        }

        // ---- not consumed: may it be now?
        const recovery = lastRecovery();
        if (recovery && issuedEntry.sequence < recovery.sequence) return { result: 'unknown_challenge' }; // issued before an operator recovery: its status is unknown
        const issuedAt = parseUtcTimestamp(d.issuedAt) as number;
        const expiresAt = parseUtcTimestamp(d.expiresAt) as number;
        if (now.getTime() < issuedAt) return { result: 'unavailable' }; // the clock is earlier than the issuance it recorded: do not decide
        if (now.getTime() >= expiresAt) return { result: 'expired' };
        if (!signingKeyUsable(now)) return { result: 'unavailable' };

        // policy, grant and revocation are checked AGAIN at consumption time
        const auth = await authorize(issued.grant, issued.context, now);
        if (!auth.ok) return { result: auth.reason === 'unavailable' ? 'unavailable' : 'not_authorized' };
        if (auth.grant.grant.grantId !== d.grantId || auth.grant.grant.subject.id !== d.subjectId || auth.grant.grant.subject.keyId !== d.subjectKeyId) return { result: 'binding_mismatch' };

        // real proof of possession: the signed proof, the grant subject's key, the recorded action and challenge
        const proof = verifyProof(req.proof, auth.grant, issued.context, d.challenge, now);
        if (!proof.ok) return { result: 'invalid_proof' };

        const receipt = createConsumptionReceipt({
          privateKey: signingKey,
          organization,
          storeId,
          storeGeneration,
          challengeId: d.challengeId,
          challenge: d.challenge,
          grantId: d.grantId,
          subjectId: d.subjectId,
          subjectKeyId: d.subjectKeyId,
          context: issued.context,
          proof: req.proof,
          requestId: req.requestId,
          challengeIssuedAt: new Date(issuedAt),
          challengeExpiresAt: new Date(expiresAt),
          consumedAt: now,
        });

        // the single atomic point: only the first committer consumes; the receipt is returned only afterwards
        const committed = await persistence.commitConsumption({ version: 1, challengeId: d.challengeId, requestId: req.requestId, proofDigest: req.proofDigest, receipt });
        if (committed.outcome === 'already_consumed') {
          if (!(await adoptConsumption(committed.existing, issued, now))) return { result: 'unavailable' };
          return replay(committed.existing, issued, req);
        }
        // the journal entry follows the commit; if it cannot be written the caller gets no receipt, and the
        // retry (same request id) finds the record, completes the entry and returns the original receipt
        await append({ kind: 'consume', challengeId: d.challengeId, requestId: req.requestId, receiptDigest: recordDigest(receipt) }, now, () => !state.consumed.has(d.challengeId));
        return { result: 'consumed', receipt };
      } catch {
        return { result: 'unavailable' };
      }
    }

    // ---------------------------------------------------------------- status and operator actions
    const status = (): StoreStatus => {
      const r = lastRecovery();
      const peek = ((): number => {
        try {
          const v = clock.now();
          return v instanceof Date ? v.getTime() : Number.NaN;
        } catch {
          return Number.NaN;
        }
      })();
      const quiet = phase === 'ready' && r !== undefined && peek < r.quietUntilMs;
      return Object.freeze({
        phase: phase === 'new' ? ('not_started' as const) : quiet ? ('quiet' as const) : phase,
        findings: Object.freeze([...new Set(findings.map((f) => f.code))]),
        recoverableInPlace: phase === 'blocked' && chainIntact && findings.every((f) => (ACKNOWLEDGEABLE_FINDINGS as readonly string[]).includes(f.code)),
        headSequence: state.headSequence,
        ...(r ? { quietUntil: wholeSecondsText(r.quietUntilMs) } : {}),
        protection: persistence.protection,
        durability: persistence.durability,
        anchor: anchor ? ('configured' as const) : ('none' as const),
      });
    };

    const operator: ChallengeStoreOperator = Object.freeze({
      async declareRecovery(options: Parameters<ChallengeStoreOperator['declareRecovery']>[0]) {
        try {
          const parsed = safely(() => {
            if (!isPlainObject(options) || !Array.isArray(options.acknowledge) || options.acknowledge.length > ACKNOWLEDGEABLE_FINDINGS.length) return undefined;
            const list = [...(options.acknowledge as readonly unknown[])];
            if (list.some((a) => typeof a !== 'string' || !(ACKNOWLEDGEABLE_FINDINGS as readonly string[]).includes(a)) || new Set(list).size !== list.length) return undefined;
            const period = options.quietPeriodMs;
            if (typeof period !== 'number' || !Number.isInteger(period) || period < 1000 || period > MAX_QUIET_PERIOD_MS) return undefined;
            return { ack: list as AcknowledgeableFinding[], quiet: period };
          });
          if (!parsed) return { ok: false as const, code: 'invalid_request' as const };
          const { ack, quiet } = parsed;
          if (phase === 'new') await recoverOnce();
          if (phase === 'retired' || phase === 'new') return { ok: false as const, code: 'not_ready' as const };
          if (phase === 'blocked') {
            if (!chainIntact) return { ok: false as const, code: 'not_recoverable_in_place' as const };
            const missing = [...new Set(findings.map((f) => f.code))].filter((c): c is AcknowledgeableFinding => (ACKNOWLEDGEABLE_FINDINGS as readonly string[]).includes(c) && !(ack as readonly string[]).includes(c));
            if (findings.some((f) => !(ACKNOWLEDGEABLE_FINDINGS as readonly string[]).includes(f.code))) return { ok: false as const, code: 'not_recoverable_in_place' as const };
            if (missing.length > 0) return { ok: false as const, code: 'unacknowledged_findings' as const, missing };
          }
          const now = readClock();
          if (!now) return { ok: false as const, code: 'not_ready' as const };
          await append({ kind: 'recovery', quietUntil: wholeSecondsText(now.getTime() + quiet), acknowledged: ack }, now);
          // the new entry is the boundary: re-examine everything against it
          phase = 'new';
          await recoverOnce();
          return { ok: true as const, status: status() };
        } catch {
          return { ok: false as const, code: 'storage_failure' as const };
        }
      },

      async sealGeneration(options: Parameters<ChallengeStoreOperator['sealGeneration']>[0]) {
        try {
          const next = safely(() => (isPlainObject(options) && typeof options.nextGeneration === 'string' ? options.nextGeneration : undefined));
          if (next === undefined || !GENERATION_ID_PATTERN.test(next) || next === storeGeneration) return { ok: false as const, code: 'invalid_request' as const };
          if (phase === 'new') await recoverOnce();
          const now = readClock();
          if (phase !== 'ready' || !now || !(await refresh(now)) || phase !== 'ready') return { ok: false as const, code: 'not_ready' as const };
          await append({ kind: 'seal', nextGeneration: next }, now);
          if (!state.sealed) return { ok: false as const, code: 'storage_failure' as const };
          return { ok: true as const, seal: Object.freeze({ storeId, generation: storeGeneration, nextGeneration: next, sequence: state.headSequence, headHash: state.headHash }) };
        } catch {
          return { ok: false as const, code: 'storage_failure' as const };
        }
      },
    });

    const core: ChallengeStoreCore = Object.freeze({
      identity: Object.freeze({ organization, storeId, storeGeneration, signingKeyId }),
      status,
      async recover() {
        if (phase === 'new') await recoverOnce();
        return status();
      },
      issue,
      consume,
    });
    return { ok: true, core, operator };
  } catch {
    return { ok: false, code: 'invalid_config' };
  }
}
