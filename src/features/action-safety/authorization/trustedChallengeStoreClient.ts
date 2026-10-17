/**
 * Client contract for a future PROTECTED challenge store.
 *
 * This file defines how a client talks to such a store and, above all, what it will and will not
 * believe. It contains no store, no persistence, no networking and no IPC: the transport is an
 * injected interface, and it is UNTRUSTED. A response is believed only after its signature has been
 * verified against the administrator trust root, with the store identity and signing key PINNED by the
 * caller. Where a response arrives from is never a reason to trust it.
 *
 *   requestChallengeToken   asks the store to issue a challenge for one requester and one action, then
 *                           verifies the signed token (challenge domain, `challenge_store` purpose,
 *                           pinned store and key, organization, grant, subject, exact action context,
 *                           validity window) with verifyChallengeToken.
 *   prepareConsumptionAttempt  freezes everything one consumption is bound to, INCLUDING a random
 *                           request id. The id is created once per verified token and can never be
 *                           replaced: asking again for the same token returns the same attempt, and a
 *                           conflicting second attempt is refused.
 *   submitConsumption       sends the consumption request and accepts ONLY a signed receipt that
 *                           verifyConsumptionReceipt accepts for that exact token, context, proof,
 *                           request id and pinned key. A bare "consumed", a `{ result: 'consumed' }`
 *                           with no receipt, an unsigned or forged receipt, or a genuine receipt for
 *                           anything else is never success.
 *
 * REQUEST ID FORMAT: 16 cryptographically random bytes (Node's secure random source) as strict
 * Base64url, 22 characters, accepted by isRequestId. Every retry of one logical attempt reuses it.
 * The future store must answer a repeated request id with the ORIGINAL receipt after a successful
 * consumption; this client relies on that and cannot enforce it.
 *
 * TIMEOUTS AND AMBIGUITY. Every transport call is bounded. A call that times out, throws or rejects
 * is AMBIGUOUS: the store may or may not have acted. For issuance that just means "no token". For
 * consumption it is `indeterminate`: never success, never an automatic new challenge, and the attempt
 * (with its request id) is returned so the SAME attempt can be retried. The AbortSignal handed to the
 * transport is a request to stop waiting; a client-side timeout cannot cancel an operation the store
 * already committed. A definitive store answer is different: `already_used`, `expired`,
 * `unknown_challenge`, `binding_mismatch` and `store_rejected` are reported as `unverified_refusal`.
 * Those answers are UNSIGNED, so a malicious transport can fake them. They are never authenticated
 * decisions of the store (`authenticated: false` on every failure), they do not prove the challenge is
 * unconsumed or consumed, and the only thing a fake can do is block. Success has exactly one source: a
 * verified signed receipt.
 *
 * TIME. Verification uses the `now` the caller supplies (`timeSource: 'caller_supplied'`). It is NOT
 * store time and gives no protection against a manipulated clock; trusted time is a later phase.
 *
 * WHAT A SUCCESS MEANS. A verified token proves the pinned store key signed the challenge; it does not
 * prove a durable issuance record exists unless the real store provides one. A verified receipt proves
 * the pinned store key attests to consumption; it does not establish durable storage or execution-level
 * single use. A developer-controlled client can skip any check here. A protected executor must verify
 * the receipt itself and enforce single use at execution.
 *
 * This module is separate from the legacy `ChallengeStore` contract and offers no adapter to it.
 */

import { randomBytes } from 'node:crypto';
import { isVerifiedGrant, type VerifiedGrant } from './grant.js';
import { parseActionContext, type ActionContext } from './proof.js';
import { findTrustedKey, isPlainObject, isValidatedTrustRoot, hasExactFields, type TrustRoot } from './trustRoot.js';
import { verifyChallengeToken, isVerifiedChallengeToken, type ChallengeTokenFailureCode, type VerifiedChallengeToken } from './challengeToken.js';
import { verifyConsumptionReceipt, type ReceiptFailureCode, type VerifiedConsumptionReceipt } from './consumptionReceipt.js';
import { KEY_ID_PATTERN, STORE_ID_PATTERN, GENERATION_ID_PATTERN, computeActionContextDigest, computeProofDigest, isRequestId } from './challengeCommon.js';

export const DEFAULT_STORE_TIMEOUT_MS = 10_000;
export const MAX_STORE_TIMEOUT_MS = 120_000;
export const MAX_SUBMIT_ATTEMPTS = 5;

// ---------------------------------------------------------------- the transport (untrusted)

/** What the client asks a store to issue. The store computes the context digest itself and compares. */
export interface StoreIssueRequest {
  readonly organization: string;
  readonly storeId: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: string;
  readonly context: ActionContext;
  readonly contextDigest: string;
  /**
   * The requester's SIGNED grant, exactly as the company issued it. A store must verify it itself against
   * its own trust root and policy: the ids above are claims, and a client-side "verified" label means
   * nothing to a store. (Added in Phase 6B.9; a store cannot check a grant it was never given.)
   */
  readonly grant: unknown;
}

/** What the client asks a store to consume. The signed proof travels in full; its digest is a consistency check. */
export interface StoreConsumeRequest {
  /** the idempotency key of this logical attempt; reused by every retry */
  readonly requestId: string;
  readonly organization: string;
  readonly storeId: string;
  readonly challengeId: string;
  /** the secret-like value being consumed: necessarily sent to the store, never placed in a result */
  readonly challenge: string;
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectKeyId: string;
  readonly contextDigest: string;
  readonly proofDigest: string;
  /**
   * The requester's SIGNED proof. A digest alone does not prove possession of the subject's key, so the
   * store verifies this proof itself. (Added in Phase 6B.9.)
   */
  readonly proof: unknown;
}

export interface StoreCallOptions {
  /** aborted when the client stops waiting. It asks the transport to stop; it cannot undo a committed operation. */
  readonly signal: AbortSignal;
}

/**
 * A channel to a store: a Windows named pipe, a Unix socket, a protected remote service. It is
 * UNTRUSTED. Responses are `unknown` on purpose: they are parsed strictly and their signatures verified.
 */
export interface ChallengeStoreTransport {
  issue(request: StoreIssueRequest, options: StoreCallOptions): Promise<unknown>;
  consume(request: StoreConsumeRequest, options: StoreCallOptions): Promise<unknown>;
}

export const ISSUE_REJECTION_REASONS = ['invalid_request', 'unknown_grant', 'grant_revoked', 'not_authorized', 'rate_limited', 'unavailable'] as const;
export const CONSUME_REJECTION_REASONS = ['already_used', 'expired', 'unknown_challenge', 'binding_mismatch', 'invalid_request', 'invalid_proof', 'not_authorized', 'unavailable'] as const;
type IssueRejection = (typeof ISSUE_REJECTION_REASONS)[number];
type ConsumeRejection = (typeof CONSUME_REJECTION_REASONS)[number];

// ---------------------------------------------------------------- results

export type ClientFailureCode =
  | 'invalid_request'
  | 'timeout'
  | 'transport_unavailable'
  | 'malformed_response'
  | 'store_rejected'
  | 'invalid_signature'
  | 'wrong_issuer'
  | 'wrong_store'
  | 'binding_mismatch'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid_token'
  | 'already_used'
  | 'unknown_challenge';

const MESSAGES: Readonly<Record<ClientFailureCode, string>> = {
  invalid_request: 'the request cannot be made: an input is missing, invalid or inconsistent',
  timeout: 'the store did not answer in time',
  transport_unavailable: 'the store could not be reached',
  malformed_response: 'the store response is not in the expected form',
  store_rejected: 'the store rejected the request',
  invalid_signature: 'the signature on the store response could not be verified',
  wrong_issuer: 'the store response was not signed by the pinned store key',
  wrong_store: 'the store response comes from a different store than the pinned one',
  binding_mismatch: 'the store response is for a different grant, subject, action, challenge, proof or request than expected',
  expired: 'the challenge has expired',
  not_yet_valid: 'the challenge is not valid yet',
  invalid_token: 'the challenge token is not acceptable',
  already_used: 'the store reports that the challenge was already used',
  unknown_challenge: 'the store does not know this challenge',
};

/** Where a failure was decided: the caller's input, the transport, the store's UNSIGNED answer, or local signature verification. */
export type FailureSource = 'caller_input' | 'transport' | 'store_reported' | 'local_verification';

export interface ClientFailure {
  readonly ok: false;
  readonly code: ClientFailureCode;
  readonly source: FailureSource;
  /** fixed text: never a challenge, a proof, a signature or a key */
  readonly message: string;
  /** a code from another module or the store's reason, drawn only from closed vocabularies */
  readonly detail?: string;
  readonly timeSource: 'caller_supplied';
  /** always false: a failure is never a signed statement of the store, whatever its `source` says */
  readonly authenticated: false;
}

const failure = (code: ClientFailureCode, source: FailureSource, detail?: string): ClientFailure => ({
  ok: false,
  code,
  source,
  message: MESSAGES[code],
  ...(detail ? { detail } : {}),
  timeSource: 'caller_supplied',
  authenticated: false,
});

export interface IssuedChallenge {
  readonly ok: true;
  /** verified against the trust root and the pinned store and key */
  readonly token: VerifiedChallengeToken;
  readonly timeSource: 'caller_supplied';
}
export type IssueResult = IssuedChallenge | ClientFailure;

/**
 * A consumption that did not succeed.
 *  - `not_attempted`: the client refused before sending anything (invalid input); the store was not asked.
 *  - `unverified_refusal`: the store (or whoever sits on the transport) answered with an UNSIGNED refusal.
 *    It is not an authenticated decision and proves nothing about what the store holds.
 *  - `indeterminate`: the store may have acted (timeout, unreachable, unverifiable answer): assume nothing.
 */
export interface ConsumptionFailure extends ClientFailure {
  readonly state: 'not_attempted' | 'unverified_refusal' | 'indeterminate';
  /** present when the SAME attempt may be retried (it carries the same request id) */
  readonly retryWith?: ConsumptionAttempt;
}

export interface ConsumedChallenge {
  readonly ok: true;
  readonly state: 'consumed';
  /** a genuine receipt, verified by verifyConsumptionReceipt */
  readonly receipt: VerifiedConsumptionReceipt;
  readonly requestId: string;
  readonly timeSource: 'caller_supplied';
}
export type ConsumeResult = ConsumedChallenge | ConsumptionFailure;

// ---------------------------------------------------------------- bounded calls

const validTimeout = (ms: unknown): ms is number => typeof ms === 'number' && Number.isInteger(ms) && ms >= 1 && ms <= MAX_STORE_TIMEOUT_MS;

type Outcome<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'timeout' } | { readonly kind: 'error' };

/**
 * Runs one transport call with a hard time limit. A transport that never settles cannot hang the
 * caller. On timeout the signal is aborted; the late result of the transport is ignored (and its
 * rejection swallowed), never reported as a success.
 */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<Outcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  let settled: Promise<Outcome<T>>;
  try {
    settled = Promise.resolve(run(controller.signal)).then(
      (value): Outcome<T> => ({ kind: 'value', value }),
      (): Outcome<T> => ({ kind: 'error' }),
    );
  } catch {
    clearTimeout(timer);
    return { kind: 'error' };
  }
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  if (result.kind === 'timeout') controller.abort();
  return result;
}

const hasMethod = (x: unknown, name: string): boolean => {
  try {
    return typeof (x as Record<string, unknown> | null)?.[name] === 'function';
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- issuance

export interface RequestChallengeParams {
  /** a validated administrator trust root: the only source of trusted store keys */
  readonly trustRoot: TrustRoot;
  /** the PINNED store identity (for example from the protected configuration and registry) */
  readonly storeId: string;
  /** the PINNED store signing key id: a token signed by any other key is refused */
  readonly signingKeyId: string;
  /** optional: the store generation the caller expects */
  readonly storeGeneration?: string;
  /** the requester's VERIFIED grant */
  readonly requester: VerifiedGrant;
  /** the same grant as the signed envelope the company issued: the store verifies it independently */
  readonly grantEnvelope: unknown;
  /** the exact action, from an independent source (for example the Git collector) */
  readonly context: ActionContext;
  /** caller-supplied verification time: NOT store time */
  readonly now: Date;
  readonly transport: ChallengeStoreTransport;
  readonly timeoutMs?: number;
}

function tokenFailure(code: ChallengeTokenFailureCode): ClientFailure {
  switch (code) {
    case 'signature_verification_failed':
      return failure('invalid_signature', 'local_verification', code);
    case 'unknown_signing_key':
    case 'key_purpose_not_allowed':
    case 'signing_key_mismatch':
    case 'signing_key_expired':
    case 'signing_key_not_yet_valid':
      return failure('wrong_issuer', 'local_verification', code);
    case 'store_mismatch':
    case 'store_generation_mismatch':
      return failure('wrong_store', 'local_verification', code);
    case 'organization_mismatch':
    case 'grant_mismatch':
    case 'subject_mismatch':
    case 'context_mismatch':
      return failure('binding_mismatch', 'local_verification', code);
    case 'token_expired':
      return failure('expired', 'local_verification', code);
    case 'token_not_yet_valid':
      return failure('not_yet_valid', 'local_verification', code);
    case 'envelope_malformed':
    case 'payload_not_json':
    case 'wrong_domain':
      return failure('malformed_response', 'local_verification', code);
    case 'invalid_expected':
    case 'invalid_trust_root':
    case 'invalid_evaluation_time':
      return failure('invalid_request', 'caller_input', code);
    default:
      return failure('invalid_token', 'local_verification', code);
  }
}

/** Checks the pinned identity, the requester, the context and the time before anything is sent. */
function checkIssueInputs(p: RequestChallengeParams): ClientFailure | undefined {
  if (!isPlainObject(p)) return failure('invalid_request', 'caller_input');
  if (!isValidatedTrustRoot(p.trustRoot)) return failure('invalid_request', 'caller_input', 'trust_root');
  if (typeof p.storeId !== 'string' || !STORE_ID_PATTERN.test(p.storeId)) return failure('invalid_request', 'caller_input', 'store_id');
  if (typeof p.signingKeyId !== 'string' || !KEY_ID_PATTERN.test(p.signingKeyId)) return failure('invalid_request', 'caller_input', 'signing_key_id');
  if (p.storeGeneration !== undefined && (typeof p.storeGeneration !== 'string' || !GENERATION_ID_PATTERN.test(p.storeGeneration))) return failure('invalid_request', 'caller_input', 'store_generation');
  if (!isVerifiedGrant(p.requester)) return failure('invalid_request', 'caller_input', 'requester');
  if (!isPlainObject(p.grantEnvelope)) return failure('invalid_request', 'caller_input', 'grant_envelope');
  if (p.requester.grant.organization !== p.trustRoot.organization) return failure('invalid_request', 'caller_input', 'organization');
  if (!parseActionContext(p.context).ok) return failure('invalid_request', 'caller_input', 'context');
  if (!(p.now instanceof Date) || Number.isNaN(p.now.getTime())) return failure('invalid_request', 'caller_input', 'time');
  if (!hasMethod(p.transport, 'issue')) return failure('invalid_request', 'caller_input', 'transport');
  if (p.timeoutMs !== undefined && !validTimeout(p.timeoutMs)) return failure('invalid_request', 'caller_input', 'timeout');
  // the pinned key must really be a store key the trust root trusts NOW: otherwise nothing it signs could be accepted
  const pinned = findTrustedKey(p.trustRoot, p.signingKeyId, 'challenge_store', p.now);
  if (!pinned.ok) return failure('wrong_issuer', 'local_verification', `pinned_key_${pinned.code}`);
  return undefined;
}

/** A hostile response object (e.g. a Proxy) must read as malformed, never as a definitive answer. */
function safely<T>(parse: () => T | undefined): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

function parseIssueResponse(x: unknown): { kind: 'issued'; token: unknown } | { kind: 'rejected'; reason: IssueRejection } | undefined {
  if (!isPlainObject(x)) return undefined;
  if (x.result === 'issued' && hasExactFields(x, ['result', 'token'])) return { kind: 'issued', token: x.token };
  if (x.result === 'rejected' && hasExactFields(x, ['result', 'reason']) && (ISSUE_REJECTION_REASONS as readonly unknown[]).includes(x.reason)) {
    return { kind: 'rejected', reason: x.reason as IssueRejection };
  }
  return undefined;
}

/**
 * Asks the store for a challenge token and verifies it. Never throws. The request is made only after
 * the pinned identity, the requester, the action context and the time have been validated. The result
 * is a VERIFIED token or a structured failure; a response is never trusted because of the transport
 * it came from.
 */
export async function requestChallengeToken(params: RequestChallengeParams): Promise<IssueResult> {
  try {
    const invalid = checkIssueInputs(params);
    if (invalid) return invalid;
    const { trustRoot, storeId, signingKeyId, requester, context, now, transport } = params;
    const g = requester.grant;
    const request: StoreIssueRequest = Object.freeze({
      organization: trustRoot.organization,
      storeId,
      grantId: g.grantId,
      subjectId: g.subject.id,
      subjectKeyId: g.subject.keyId,
      context: Object.freeze({ ...context }),
      contextDigest: computeActionContextDigest(context),
      grant: cloneProof(params.grantEnvelope),
    });

    const outcome = await bounded((signal) => transport.issue(request, { signal }), params.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS);
    if (outcome.kind === 'timeout') return failure('timeout', 'transport');
    if (outcome.kind === 'error') return failure('transport_unavailable', 'transport');

    const response = safely(() => parseIssueResponse(outcome.value));
    if (!response) return failure('malformed_response', 'transport');
    if (response.kind === 'rejected') return failure('store_rejected', 'store_reported', response.reason);

    // the response never chooses the key: the pinned id is checked against the trust root
    const verified = verifyChallengeToken(
      response.token,
      trustRoot,
      { storeId, signingKeyId, ...(params.storeGeneration !== undefined ? { storeGeneration: params.storeGeneration } : {}), grantId: g.grantId, subjectId: g.subject.id, subjectKeyId: g.subject.keyId, context },
      now,
    );
    if (!verified.ok) return tokenFailure(verified.code);
    return Object.freeze({ ok: true as const, token: verified, timeSource: 'caller_supplied' as const });
  } catch {
    return failure('invalid_request', 'caller_input');
  }
}

// ---------------------------------------------------------------- consumption attempts

export interface PrepareConsumptionParams {
  readonly trustRoot: TrustRoot;
  /** pinned, and must equal the token's store and signing key */
  readonly storeId: string;
  readonly signingKeyId: string;
  /** the VERIFIED token returned by requestChallengeToken */
  readonly token: IssuedChallenge | VerifiedChallengeToken;
  readonly requester: VerifiedGrant;
  readonly context: ActionContext;
  /** the signed proof envelope that will be presented; only its digest is sent */
  readonly proof: unknown;
}

/**
 * Everything ONE logical consumption is bound to, including its request id. Frozen and branded.
 * It is the unit of retry: submitting it again repeats the same request id.
 */
export interface ConsumptionAttempt {
  readonly kind: 'consumption_attempt';
  /** 16 random bytes, Base64url, created once for this verified token */
  readonly requestId: string;
  readonly storeId: string;
  readonly signingKeyId: string;
  readonly challengeId: string;
  readonly request: StoreConsumeRequest;
}

interface AttemptInternals {
  readonly trustRoot: TrustRoot;
  readonly token: VerifiedChallengeToken;
  readonly context: ActionContext;
  readonly proof: unknown;
  readonly proofDigest: string;
  /** the first verified receipt for this attempt; later calls return it, and a different receipt is a conflict */
  receipt?: VerifiedConsumptionReceipt;
}

const attempts = new WeakSet<object>();
const internals = new WeakMap<object, AttemptInternals>();
/** one logical attempt per verified token: a challenge is single-use, so a second, different attempt is refused */
const attemptOfToken = new WeakMap<object, ConsumptionAttempt>();

export const isConsumptionAttempt = (x: unknown): x is ConsumptionAttempt => typeof x === 'object' && x !== null && attempts.has(x);

/** A fresh idempotency key: 16 cryptographically random bytes as strict Base64url (22 characters). */
export function generateRequestId(): string {
  return randomBytes(16).toString('base64url');
}

function cloneProof<T>(x: T): T {
  if (typeof x !== 'object' || x === null) return x;
  try {
    return JSON.parse(JSON.stringify(x)) as T;
  } catch {
    return x;
  }
}

/**
 * Builds the attempt for a verified token. Asking again for the SAME token with the SAME binding
 * returns the SAME attempt (same request id); asking with a different proof or context is refused,
 * because one single-use challenge has one logical consumption. A new request id is therefore never
 * substituted silently. Never throws.
 */
export function prepareConsumptionAttempt(params: PrepareConsumptionParams): { readonly ok: true; readonly attempt: ConsumptionAttempt } | ClientFailure {
  try {
    if (!isPlainObject(params)) return failure('invalid_request', 'caller_input');
    const token = isVerifiedChallengeToken(params.token) ? params.token : isPlainObject(params.token) && isVerifiedChallengeToken((params.token as { token?: unknown }).token) ? ((params.token as unknown as IssuedChallenge).token) : undefined;
    if (!token) return failure('invalid_request', 'caller_input', 'token');
    if (!isValidatedTrustRoot(params.trustRoot)) return failure('invalid_request', 'caller_input', 'trust_root');
    if (typeof params.storeId !== 'string' || !STORE_ID_PATTERN.test(params.storeId)) return failure('invalid_request', 'caller_input', 'store_id');
    if (typeof params.signingKeyId !== 'string' || !KEY_ID_PATTERN.test(params.signingKeyId)) return failure('invalid_request', 'caller_input', 'signing_key_id');
    if (!isVerifiedGrant(params.requester)) return failure('invalid_request', 'caller_input', 'requester');
    if (!parseActionContext(params.context).ok) return failure('invalid_request', 'caller_input', 'context');

    // the pinned identity must be the token's, and the requester and action must be the ones it was issued for
    const t = token.token;
    const g = params.requester.grant;
    if (t.storeId !== params.storeId || token.signingKeyId !== params.signingKeyId) return failure('wrong_store', 'caller_input', 'token_store_mismatch');
    if (t.organization !== params.trustRoot.organization || g.organization !== t.organization) return failure('binding_mismatch', 'caller_input', 'organization');
    if (t.grantId !== g.grantId || t.subjectId !== g.subject.id || t.subjectKeyId !== g.subject.keyId) return failure('binding_mismatch', 'caller_input', 'requester');
    const contextDigest = computeActionContextDigest(params.context);
    if (t.contextDigest !== contextDigest) return failure('binding_mismatch', 'caller_input', 'context');

    let proofDigest: string;
    try {
      proofDigest = computeProofDigest(params.proof);
    } catch {
      return failure('invalid_request', 'caller_input', 'proof');
    }

    const existing = attemptOfToken.get(token);
    if (existing) {
      const prior = internals.get(existing);
      if (prior && prior.proofDigest === proofDigest) return { ok: true, attempt: existing };
      return failure('invalid_request', 'caller_input', 'attempt_conflict');
    }

    const requestId = generateRequestId();
    if (!isRequestId(requestId)) return failure('invalid_request', 'caller_input', 'request_id');
    const request: StoreConsumeRequest = Object.freeze({
      requestId,
      organization: t.organization,
      storeId: t.storeId,
      challengeId: t.challengeId,
      challenge: t.challenge,
      grantId: t.grantId,
      subjectId: t.subjectId,
      subjectKeyId: t.subjectKeyId,
      contextDigest,
      proofDigest,
      proof: cloneProof(params.proof),
    });
    const attempt: ConsumptionAttempt = Object.freeze({ kind: 'consumption_attempt' as const, requestId, storeId: t.storeId, signingKeyId: token.signingKeyId, challengeId: t.challengeId, request });
    attempts.add(attempt);
    internals.set(attempt, { trustRoot: params.trustRoot, token, context: Object.freeze({ ...params.context }), proof: cloneProof(params.proof), proofDigest });
    attemptOfToken.set(token, attempt);
    return { ok: true, attempt };
  } catch {
    return failure('invalid_request', 'caller_input');
  }
}

// ---------------------------------------------------------------- consumption

export interface SubmitConsumptionOptions {
  /** caller-supplied verification time: NOT store time */
  readonly now: Date;
  readonly timeoutMs?: number;
  /** total sends, 1 to 5 (default 1). Retries happen only after a timeout or an unreachable transport, and always repeat the SAME request id. No delay is added. */
  readonly maxAttempts?: number;
  /** an assertion, not a setting: if given, it must equal the attempt's request id, otherwise the call is refused */
  readonly requestId?: string;
}

function receiptFailure(code: ReceiptFailureCode): ClientFailure {
  switch (code) {
    case 'signature_verification_failed':
      return failure('invalid_signature', 'local_verification', code);
    case 'unknown_signing_key':
    case 'key_purpose_not_allowed':
    case 'signing_key_mismatch':
    case 'signing_key_expired':
    case 'signing_key_not_yet_valid':
      return failure('wrong_issuer', 'local_verification', code);
    case 'store_mismatch':
    case 'store_generation_mismatch':
      return failure('wrong_store', 'local_verification', code);
    case 'organization_mismatch':
    case 'challenge_mismatch':
    case 'grant_mismatch':
    case 'subject_mismatch':
    case 'context_mismatch':
    case 'proof_mismatch':
    case 'request_mismatch':
    case 'time_mismatch':
    case 'consumed_in_future':
      return failure('binding_mismatch', 'local_verification', code);
    case 'envelope_malformed':
    case 'payload_not_json':
    case 'wrong_domain':
    case 'receipt_invalid':
    case 'unsupported_receipt_version':
      return failure('malformed_response', 'local_verification', code);
    default:
      return failure('invalid_request', 'caller_input', code);
  }
}

function parseConsumeResponse(x: unknown): { kind: 'consumed'; receipt: unknown } | { kind: 'rejected'; reason: ConsumeRejection } | undefined {
  if (!isPlainObject(x)) return undefined; // a bare "consumed" string is not a response
  if (x.result === 'consumed') return hasExactFields(x, ['result', 'receipt']) ? { kind: 'consumed', receipt: x.receipt } : undefined; // no receipt, no success
  if ((CONSUME_REJECTION_REASONS as readonly unknown[]).includes(x.result) && hasExactFields(x, ['result'])) return { kind: 'rejected', reason: x.result as ConsumeRejection };
  return undefined;
}

const succeeded = (attempt: ConsumptionAttempt, receipt: VerifiedConsumptionReceipt): ConsumedChallenge =>
  Object.freeze({ ok: true as const, state: 'consumed' as const, receipt, requestId: attempt.requestId, timeSource: 'caller_supplied' as const });

const toConsumption = (f: ClientFailure, state: ConsumptionFailure['state'], retryWith?: ConsumptionAttempt): ConsumptionFailure => ({ ...f, state, ...(retryWith ? { retryWith } : {}) });

/**
 * Sends the consumption request for an attempt and returns a verified receipt or a structured failure.
 * Never throws. Success requires a genuine signed receipt accepted by verifyConsumptionReceipt for
 * exactly this token, context, proof, request id and pinned key. A timeout or an unreachable store is
 * `indeterminate`: no success, no new challenge, and the SAME attempt comes back for a retry.
 */
export async function submitConsumption(attempt: ConsumptionAttempt, transport: ChallengeStoreTransport, options: SubmitConsumptionOptions): Promise<ConsumeResult> {
  let sentAny = false;
  try {
    const inner = isConsumptionAttempt(attempt) ? internals.get(attempt) : undefined;
    if (!inner) return toConsumption(failure('invalid_request', 'caller_input', 'attempt'), 'not_attempted');
    if (!isPlainObject(options) || !(options.now instanceof Date) || Number.isNaN(options.now.getTime())) return toConsumption(failure('invalid_request', 'caller_input', 'time'), 'not_attempted');
    if (options.timeoutMs !== undefined && !validTimeout(options.timeoutMs)) return toConsumption(failure('invalid_request', 'caller_input', 'timeout'), 'not_attempted');
    const maxAttempts = options.maxAttempts ?? 1;
    if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_SUBMIT_ATTEMPTS) return toConsumption(failure('invalid_request', 'caller_input', 'max_attempts'), 'not_attempted');
    if (!hasMethod(transport, 'consume')) return toConsumption(failure('invalid_request', 'caller_input', 'transport'), 'not_attempted');
    // a different request id is a different logical attempt, and is never substituted here
    if (options.requestId !== undefined && options.requestId !== attempt.requestId) return toConsumption(failure('invalid_request', 'caller_input', 'request_id_changed'), 'not_attempted');

    // the pinned key must still be a trusted store key at the caller-supplied time
    const pinned = findTrustedKey(inner.trustRoot, attempt.signingKeyId, 'challenge_store', options.now);
    if (!pinned.ok) return toConsumption(failure('wrong_issuer', 'local_verification', `pinned_key_${pinned.code}`), 'not_attempted');

    // one logical attempt has one outcome: once a receipt is verified it is the answer for every later call
    if (inner.receipt) return succeeded(attempt, inner.receipt);

    const timeoutMs = options.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
    let last: ClientFailure = failure('transport_unavailable', 'transport');
    for (let n = 1; n <= maxAttempts; n++) {
      sentAny = true;
      const outcome = await bounded((signal) => transport.consume(attempt.request, { signal }), timeoutMs);
      if (outcome.kind === 'timeout' || outcome.kind === 'error') {
        // ambiguous: the store may have consumed the challenge. Retrying repeats the SAME request id.
        last = outcome.kind === 'timeout' ? failure('timeout', 'transport') : failure('transport_unavailable', 'transport');
        continue;
      }

      const response = safely(() => parseConsumeResponse(outcome.value));
      if (!response) return toConsumption(failure('malformed_response', 'transport'), 'indeterminate');
      if (response.kind === 'rejected' && response.reason === 'unavailable') {
        // the store says it could not complete the operation: ambiguous, so the SAME attempt stays retryable
        last = failure('transport_unavailable', 'store_reported', 'unavailable');
        continue;
      }
      if (response.kind === 'rejected') {
        const code: ClientFailureCode = response.reason === 'already_used' ? 'already_used' : response.reason === 'expired' ? 'expired' : response.reason === 'unknown_challenge' ? 'unknown_challenge' : response.reason === 'binding_mismatch' ? 'binding_mismatch' : 'store_rejected';
        return toConsumption(failure(code, 'store_reported', response.reason), 'unverified_refusal');
      }

      const verified = verifyConsumptionReceipt(
        response.receipt,
        inner.trustRoot,
        { token: inner.token, context: inner.context, proof: inner.proof, requestId: attempt.requestId, signingKeyId: attempt.signingKeyId },
        options.now,
      );
      if (!verified.ok) return toConsumption(receiptFailure(verified.code), 'indeterminate'); // a bad answer says nothing about what the store did
      // concurrent sends of one attempt must not yield two different receipts
      const known = inner.receipt as VerifiedConsumptionReceipt | undefined; // may have been set by a concurrent send
      if (known && known.receipt.receiptId !== verified.receipt.receiptId) return toConsumption(failure('binding_mismatch', 'local_verification', 'receipt_conflict'), 'indeterminate');
      inner.receipt = known ?? verified;
      return succeeded(attempt, inner.receipt);
    }
    return toConsumption(last, 'indeterminate', attempt);
  } catch {
    // an unexpected error after a send says nothing about what the store did
    return sentAny ? toConsumption(failure('transport_unavailable', 'transport'), 'indeterminate', attempt) : toConsumption(failure('invalid_request', 'caller_input'), 'not_attempted');
  }
}
