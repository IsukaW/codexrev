/**
 * The ONLY way verified authority reaches the safety assessment.
 *
 * `buildStrictAuthorityInput` takes a genuine strict-authorization view (the output of
 * `adaptAuthorization`) and the fixed rules for the other three gates, and returns a branded
 * `StrictAuthorityInput`. The assessment coordinator accepts authority from nowhere else in strict mode:
 * it ignores everything the assessment JSON says about actors, authorization and gate
 * policy, and uses exactly this object for the Authority factor, the Authorization gate
 * and the gate rules. There is no fifth gate and the score formula is untouched.
 *
 * The brand is a WeakSet, so a hand-written object `{ ..., state: 'finalized' }`, a JSON clone or a
 * spread copy is not accepted. As elsewhere in this subsystem that stops accidents and plain-object
 * forgery, not code running in the same process that calls the builder on its own.
 *
 * Which evidence the gates see depends on the state of the view:
 *   provisional  `provisionalGateInputs`: every signed prerequisite passed but the challenge is NOT
 *                consumed. Good enough to compute a provisional result, never a completed ALLOW.
 *   finalized    `gateInputs` of a result whose challenge was consumed by a verified receipt.
 *   blocked      the blocked view's inputs: Authorization is FAIL or UNKNOWN, which BLOCKs.
 */

import type { AuthorityAssessmentInput } from '../calculus/authority.js';
import type { GatePolicy } from '../calculus/gates.js';
import type { AuthorityContext } from '../model/types.js';
import { completeStrictGatePolicy, isStrictAuthorizationView, type OtherGateRules, type StrictAuthorizationView } from './strictAuthorityAdapter.js';

export interface StrictAuthorityInput {
  readonly kind: 'strict_authority_input';
  readonly state: StrictAuthorizationView['state'];
  /** the Authority-factor input, built only from verified facts */
  readonly authorityInput: AuthorityAssessmentInput;
  /** what the Authorization gate sees */
  readonly authority: AuthorityContext;
  /** the complete gate rules: the strict authorization rule plus the fixed rules supplied by the trusted caller */
  readonly gatePolicy: GatePolicy;
  readonly view: StrictAuthorizationView;
}

export type StrictAuthorityInputResult = { readonly ok: true; readonly input: StrictAuthorityInput } | { readonly ok: false; readonly code: 'not_a_strict_view' | 'incomplete_gate_rules' | 'authorization_rules_not_accepted' };

const genuine = new WeakSet<object>();

/** True only for an object produced by buildStrictAuthorityInput. */
export const isStrictAuthorityInput = (x: unknown): x is StrictAuthorityInput => typeof x === 'object' && x !== null && genuine.has(x);

export function buildStrictAuthorityInput(view: StrictAuthorizationView, others: OtherGateRules): StrictAuthorityInputResult {
  try {
    if (!isStrictAuthorizationView(view)) return { ok: false, code: 'not_a_strict_view' };
    const policy = completeStrictGatePolicy(view, others);
    if (!policy.ok) return { ok: false, code: policy.code };
    const authority = view.state === 'provisional' ? view.provisionalGateInputs : view.gateInputs;
    const input: StrictAuthorityInput = Object.freeze({ kind: 'strict_authority_input' as const, state: view.state, authorityInput: view.authorityInput, authority, gatePolicy: policy.policy, view });
    genuine.add(input);
    return { ok: true, input };
  } catch {
    return { ok: false, code: 'incomplete_gate_rules' };
  }
}
