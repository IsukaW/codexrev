/**
 * Connects the legacy `ChallengeStore` interface (which `finalizeAuthorization` expects) to the signed
 * challenge-store protocol, WITHOUT weakening it.
 *
 * COMPATIBILITY ANALYSIS. The legacy interface is `consume({ challenge, grantId, actionId, expiresAt })`
 * answering `'consumed' | 'already_used'`; the evaluator trusts that bare string. The signed protocol
 * needs a verified challenge TOKEN, the requester's grant, the exact action context and the signed PROOF,
 * and its only success is a signed receipt verified by `verifyConsumptionReceipt`. The legacy call does not
 * carry that information, so the adapter is constructed with it (all of it verified earlier in the run)
 * and the legacy call is used only as the trigger:
 *
 *   - the call must be for the very challenge, grant and action this adapter was built for, otherwise it
 *     throws (the evaluator reads a throw as "store unavailable", which blocks);
 *   - it then runs the SIGNED protocol (prepareConsumptionAttempt + submitConsumption) and returns
 *     'consumed' ONLY when the client returned a receipt it had verified against the trust root, the
 *     pinned store key, the token, the context, the proof digest and the request id;
 *   - a refusal that says "already used" is 'already_used'; everything else (timeout, malformed answer,
 *     unverifiable receipt, any failure) throws, so an uncertain consumption can never become success.
 *
 * The adapter is single-use: after one attempt it answers 'already_used'. It never exposes the challenge;
 * the verified receipt's id and time are kept only for display.
 *
 * PROTOTYPE LIMIT: the store it talks to runs in this process (see challengeStoreCore.ts), so this is
 * local replay protection, not enforcement by a separate trusted party.
 */

import type { ChallengeStoreCore } from '../authorization/challengeStoreCore.js';
import { createInProcessTransport } from '../authorization/challengeStoreCore.js';
import type { VerifiedChallengeToken } from '../authorization/challengeToken.js';
import type { VerifiedGrant } from '../authorization/grant.js';
import type { ActionContext, ChallengeStore } from '../authorization/proof.js';
import type { TrustRoot } from '../authorization/trustRoot.js';
import { prepareConsumptionAttempt, submitConsumption } from '../authorization/trustedChallengeStoreClient.js';

export interface VerifiedConsumption {
  readonly receiptId: string;
  readonly consumedAt: string;
  readonly requestId: string;
}

export interface VerifiedStoreAdapter extends ChallengeStore {
  /** present only after a consumption whose signed receipt was verified */
  consumption(): VerifiedConsumption | undefined;
  /** a fixed code describing why consumption did not succeed (never a challenge, proof or key) */
  failure(): string | undefined;
}

export interface StoreAdapterParams {
  readonly core: ChallengeStoreCore;
  readonly trustRoot: TrustRoot;
  readonly storeId: string;
  readonly storeKeyId: string;
  readonly token: VerifiedChallengeToken;
  readonly requester: VerifiedGrant;
  readonly context: ActionContext;
  /** the developer's signed proof envelope */
  readonly proof: unknown;
  readonly now: () => Date;
  readonly timeoutMs?: number;
}

export function createVerifiedStoreAdapter(p: StoreAdapterParams): VerifiedStoreAdapter {
  let used = false;
  let consumption: VerifiedConsumption | undefined;
  let failure: string | undefined;
  const transport = createInProcessTransport(p.core);

  return {
    async consume(entry) {
      if (used) return 'already_used';
      used = true;
      const t = p.token.token;
      if (entry.challenge !== t.challenge || entry.grantId !== t.grantId || entry.actionId !== p.context.actionId) {
        failure = 'consume_request_mismatch';
        throw new Error('consume request does not match the verified challenge');
      }
      const prepared = prepareConsumptionAttempt({ trustRoot: p.trustRoot, storeId: p.storeId, signingKeyId: p.storeKeyId, token: p.token, requester: p.requester, context: p.context, proof: p.proof });
      if (!prepared.ok) {
        failure = prepared.code;
        throw new Error('consumption could not be prepared');
      }
      const result = await submitConsumption(prepared.attempt, transport, { now: p.now(), timeoutMs: p.timeoutMs ?? 5000 });
      if (result.ok) {
        // `ok` means the client verified a signed receipt for exactly this token, context, proof and request
        const receipt = result.receipt.receipt;
        consumption = { receiptId: receipt.receiptId, consumedAt: receipt.consumedAt, requestId: result.requestId };
        return 'consumed';
      }
      failure = result.code;
      if (result.code === 'already_used') return 'already_used';
      throw new Error('consumption was not confirmed by a verified receipt');
    },
    consumption: () => consumption,
    failure: () => failure,
  };
}
