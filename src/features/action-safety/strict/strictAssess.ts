/**
 * STRICT DEMO MODE assessment: the existing safety assessment, fed with VERIFIED authority.
 *
 * What this does, in order (every verification is done by the existing authorization modules):
 *   1. read the assessment request and the optional --input file, and DISCARD every authority claim in it
 *      (actor, authority, gate policy): they are reported as ignored and never used;
 *   2. load the trust root, PINNED by a fingerprint the operator supplies, then the signed policy and the
 *      signed revocation list under it;
 *   3. find the developer's administrator-signed grant for the developer's own key;
 *   4. collect the Git action context (clean tree required);
 *   5. pre-check grant, revocation, role and permission; a signed challenge is requested from the
 *      local challenge store only if those pass;
 *   6. sign the developer's proof (bound to challenge and action context) with the developer's private key;
 *   7. prepareAuthorization (the challenge is NOT consumed), adapt it to strict evidence, run the existing
 *      assessment (coordinator, four gates, Safety Score, Decision Engine);
 *   8. only if that assessment says ALLOW: re-collect the Git context; if it changed, BLOCK; otherwise
 *      finalizeAuthorization consumes the challenge through the signed store protocol (a verified signed
 *      receipt is the only success), and the assessment is run AGAIN on the finalized evidence.
 * A provisional ALLOW is never returned: the decision that is reported always comes from an assessment whose
 * authority evidence is finalized (ALLOW) or from one whose decision is not ALLOW. Any failure at any step
 * yields BLOCK with the reason; nothing falls back to advisory behavior.
 *
 * PROTOTYPE LIMITS (also printed): the CLI itself is trusted; the challenge store runs in this process, so
 * replay protection is local; the clock is the local clock; the trust-root pin is only as trustworthy as the
 * party that supplies it; the Git binding does not prove what artifact is actually deployed.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { recheckActionContext, collectActionContext, type CollectedActionContext, type GitRunner } from '../authorization/actionContextCollector.js';
import { createChallengeStoreCore } from '../authorization/challengeStoreCore.js';
import { openFilesystemPersistence } from '../authorization/challengeStorePersistence.js';
import type { AuthorizationChecks, AuthorizationRequirements, Check } from '../authorization/evaluateAuthorization.js';
import { GRANT_ID_PATTERN, verifyGrant, type VerifiedGrant } from '../authorization/grant.js';
import { createProof, generateChallenge, parseActionContext, type ActionContext } from '../authorization/proof.js';
import { buildStrictAuthorityInput, type StrictAuthorityInput } from '../authorization/strictAssessmentInput.js';
import { adaptAuthorization, type StrictAuthorizationView } from '../authorization/strictAuthorityAdapter.js';
import { attestSafetyDecision, finalizeAuthorization, prepareAuthorization, type FinalizedAuthorization, type PreparedAuthorization } from '../authorization/twoPhaseAuthorization.js';
import { requestChallengeToken } from '../authorization/trustedChallengeStoreClient.js';
import { DEFAULT_GATE_POLICY, assessAction, type AssessmentOutcome, type AssessmentPolicy } from '../pipeline/assessmentCoordinator.js';
import { loadAssessmentRequest, type AssessmentRequest } from '../cli/assessmentInput.js';
import { PIPELINE_STAGES, type AssessmentSessionResult } from '../cli/runAssessment.js';
import { collectEvidence, type EvidenceBundle } from '../collectors/evidenceOrchestrator.js';
import { runContextInterpretation } from '../interpretation/interpreter.js';
import type { ContextInterpretation } from '../interpretation/types.js';
import { AUTHORITY_FILES, GRANT_FILE_SUFFIX, loadAuthority, type LoadedAuthority } from './authority.js';
import { deriveActionId } from './actionId.js';
import { readJsonFile } from './files.js';
import { loadPrivateKey } from './keyStore.js';
import { createVerifiedStoreAdapter, type VerifiedConsumption } from './storeAdapter.js';

/** The fixed, trusted rules for the three gates that signed authorization does not decide. Never read from the input. */
export const OTHER_GATE_RULES = Object.freeze({
  recovery: DEFAULT_GATE_POLICY.recovery,
  buildTests: DEFAULT_GATE_POLICY.buildTests,
  supportingEvidence: DEFAULT_GATE_POLICY.supportingEvidence,
});

export const STORE_ID = 'local-demo';
export const STORE_GENERATION = 'gen-1';

export interface StrictAssessOptions {
  /** the authority directory (public artifacts) */
  readonly dir: string;
  /** the pinned trust-root fingerprint: the trust anchor, supplied by the operator */
  readonly trustRootSha256: string;
  /** optional separate, administrator-installed trust-root file */
  readonly trustRootFile?: string;
  /** the developer's key profile */
  readonly asKey: string;
  /** the developer's subject id in the grant, if it differs from the key profile name */
  readonly subject?: string;
  readonly keysDir: string;
  /** key profile of the local challenge-store signing key (listed in the trust root as challenge_store) */
  readonly storeKey: string;
  /** where the local challenge store keeps its state (outside the authority directory) */
  readonly storeDir: string;
  readonly action: string;
  readonly environment: string;
  /** the application or service name (the action's target) */
  readonly target: string;
  readonly repo: string;
  readonly grantFile?: string;
  readonly inputFile?: string;
  readonly now: () => Date;
  /** replaces the local-model interpretation (tests) */
  readonly interpreter?: (bundle: EvidenceBundle) => Promise<ContextInterpretation>;
  /** replaces the Git runner (tests) */
  readonly runner?: GitRunner;
  readonly policy?: Partial<AssessmentPolicy>;
  /** TEST HOOKS: let a test change the world at one exact moment. Never set by the command line. */
  readonly testHooks?: {
    /** runs after the provisional assessment said ALLOW and before the Git recheck and the finalization */
    readonly beforeFinalization?: () => void | Promise<void>;
  };
}

export type LineStatus = 'VERIFIED' | 'FAILED' | 'NOT CHECKED' | 'PENDING' | 'NOT CONSUMED' | 'CHANGED';
export interface Line {
  readonly status: LineStatus;
  readonly detail?: string;
}

export interface StrictSummary {
  /** blocked = authorization failed; provisional_not_finalized = verified, but the assessment did not ALLOW so nothing was consumed; finalized = challenge consumed with a verified receipt */
  readonly authorizationState: 'blocked' | 'provisional_not_finalized' | 'finalized';
  readonly developer: { readonly name: string; readonly subjectId?: string; readonly grantId?: string; readonly roles?: readonly string[] };
  readonly trustAnchor: Line;
  readonly developerKey: Line;
  readonly developerGrant: Line;
  readonly revocation: Line;
  readonly permission: Line & { readonly required: readonly string[] };
  readonly developerProof: Line;
  readonly gitContext: Line;
  readonly challengeConsumption: Line;
  readonly receipt?: VerifiedConsumption;
  /** why the result is not ALLOW, from the real results */
  readonly reasons: readonly string[];
  /** input-file claims that strict mode discarded */
  readonly ignoredClaims: readonly string[];
}

/**
 * The facts an Evidence Pack needs that the report does not show. They are recorded by the run itself, from the
 * real verification results; nothing here comes from the input file.
 */
export interface Provenance {
  readonly assessedAt: string;
  readonly trustRootSha256: string;
  /** the exact action context that was authorized: commit and content digest are OBSERVED from Git. Absent if it was never collected. */
  readonly context?: { readonly actionId: string; readonly commit: string; readonly contentDigest: string };
  /** what the Git recheck before finalization found: 'not_performed' when authorization was blocked or the assessment did not ALLOW */
  readonly gitRecheck: 'not_performed' | 'unchanged' | 'changed' | 'incomplete';
  /** why the authorization view is what it is: the adapter's reason code */
  readonly authorizationBasis: string;
  /** null when the policy requirements were never established */
  readonly requiredPermissions: readonly string[] | null;
}

export interface StrictAssessResult {
  readonly mode: 'strict_demo';
  readonly request: { readonly action: string; readonly environment: string; readonly target: string; readonly developer: string };
  readonly summary: StrictSummary;
  /** the full existing assessment session (score, factors, gates, decision), or undefined when nothing could be assessed */
  readonly session?: AssessmentSessionResult;
  /** the decision actually reported */
  readonly decision: 'ALLOW' | 'ESCALATE' | 'BLOCK';
  readonly exitCode: number;
  readonly provenance: Provenance;
}

const completedRuns = new WeakSet<object>();
/** True only for a result produced by runStrictAssessment: an Evidence Pack is built from nothing else. */
export const isStrictAssessResult = (x: unknown): x is StrictAssessResult => typeof x === 'object' && x !== null && completedRuns.has(x);

const NOT_CHECKED: Line = { status: 'NOT CHECKED' };
const label: Readonly<Record<keyof AuthorizationChecks | 'finalization', string>> = {
  policy: 'Policy',
  requesterGrant: 'Developer grant',
  requesterRevocation: 'Revocation',
  roles: 'Role',
  permissions: 'Permission',
  proofOfPossession: 'Developer proof',
  challengeConsumption: 'Challenge consumption',
  finalization: 'Finalization',
};

const lineOf = (c: Check | undefined): Line => {
  if (!c) return NOT_CHECKED;
  switch (c.status) {
    case 'passed':
    case 'not_required':
      return { status: 'VERIFIED' };
    case 'failed':
      return { status: 'FAILED', detail: c.code };
    case 'incomplete':
      return { status: 'FAILED', detail: c.code };
    case 'pending':
      return { status: 'PENDING', detail: c.code };
    default:
      return NOT_CHECKED;
  }
};

// ---------------------------------------------------------------- loading the signed inputs

function sanitize(request: AssessmentRequest): { request: AssessmentRequest; ignored: string[] } {
  const ignored: string[] = [];
  if (!request.input) return { request, ignored };
  const { actor, authority, policy, ...rest } = request.input;
  if (actor !== undefined) ignored.push('actor (identity and roles)');
  if (authority !== undefined) for (const k of Object.keys(authority)) ignored.push(`authority.${k}`);
  if (policy !== undefined) ignored.push('policy (gate rules)');
  return { request: { ...request, input: rest }, ignored };
}

type GrantLookup =
  | { readonly ok: true; readonly grant: VerifiedGrant; readonly envelope: unknown }
  | { readonly ok: false; readonly code: 'DEVELOPER_GRANT_MISSING' | 'DEVELOPER_GRANT_INVALID' | 'DEVELOPER_KEY_MISMATCH'; readonly detail: string };

async function findDeveloperGrant(o: StrictAssessOptions, authority: LoadedAuthority, keyId: string, now: Date): Promise<GrantLookup> {
  const files: string[] = [];
  if (o.grantFile !== undefined) files.push(path.resolve(o.grantFile));
  else {
    const dir = path.join(path.resolve(o.dir), AUTHORITY_FILES.grantsDir);
    try {
      for (const n of (await fs.readdir(dir)).sort()) if (n.endsWith(GRANT_FILE_SUFFIX) && GRANT_ID_PATTERN.test(n.slice(0, -GRANT_FILE_SUFFIX.length))) files.push(path.join(dir, n));
    } catch {
      /* no grants directory */
    }
  }
  const subject = o.subject ?? o.asKey;
  const refused = new Set<string>();
  let sameSubjectOtherKey = false;
  for (const file of files) {
    let envelope: unknown;
    try {
      envelope = await readJsonFile(file, 'a grant file');
    } catch {
      refused.add('unreadable');
      continue;
    }
    const g = verifyGrant(envelope, authority.trustRoot, authority.policy, now);
    if (!g.ok) {
      refused.add(g.code);
      continue;
    }
    if (g.grant.subject.keyId === keyId) return { ok: true, grant: g, envelope };
    if (g.grant.subject.id === subject) sameSubjectOtherKey = true;
  }
  if (sameSubjectOtherKey) return { ok: false, code: 'DEVELOPER_KEY_MISMATCH', detail: `the developer key "${o.asKey}" is not the key in the signed grant for "${subject}"` };
  if (refused.size > 0) return { ok: false, code: 'DEVELOPER_GRANT_INVALID', detail: `no valid grant for this key (${files.length} grant file(s) checked; refused: ${[...refused].join(', ')})` };
  return { ok: false, code: 'DEVELOPER_GRANT_MISSING', detail: `no administrator-signed grant exists for the key "${o.asKey}"` };
}

// ---------------------------------------------------------------- the run

export async function runStrictAssessment(o: StrictAssessOptions): Promise<StrictAssessResult> {
  const repoDir = path.resolve(o.repo);
  const reasons: string[] = [];
  const t0 = o.now();

  // 1. the request; authority claims in the input file are discarded
  const loaded = await loadAssessmentRequest({ action: o.action, target: o.environment, ...(o.inputFile !== undefined ? { input: o.inputFile } : {}) }, repoDir);
  const { request, ignored } = sanitize(loaded);
  const raw = await collectEvidence({ cwd: repoDir, request, now: t0.toISOString() });
  // the collectors' remarks about missing authority claims are about the discarded JSON, not about signed authority
  const bundle: EvidenceBundle = { ...raw, limitations: raw.limitations.filter((l) => !l.startsWith('[authority]')) };
  const interpretation: ContextInterpretation = await (async () => {
    try {
      return o.interpreter ? await o.interpreter(bundle) : await runContextInterpretation({ cwd: repoDir, bundle });
    } catch {
      return { status: 'ERROR', schemaVersion: 1, failureKind: 'unexpected', reason: 'interpretation failed unexpectedly', observations: [], rejectedObservations: [], injectionIndicators: [], limitations: [], advisoryOnly: true } as ContextInterpretation;
    }
  })();

  const runAssessment = (input: StrictAuthorityInput, at: Date): AssessmentOutcome =>
    assessAction({ bundle, interpretation, now: at.toISOString(), ...(o.policy ? { policy: o.policy } : {}), strictAuthority: input });
  const strictInput = (auth: PreparedAuthorization | FinalizedAuthorization | undefined, at: Date): { input: StrictAuthorityInput; view: StrictAuthorizationView } => {
    const view = adaptAuthorization(auth as PreparedAuthorization, at); // anything that is not a genuine result becomes a BLOCKED view
    const built = buildStrictAuthorityInput(view, OTHER_GATE_RULES);
    if (!built.ok) throw new Error('strict authority input could not be built');
    return { input: built.input, view };
  };
  const sessionOf = (assessment: AssessmentOutcome): AssessmentSessionResult => ({
    status: assessment.status === 'FAILED' ? 'failed' : assessment.status === 'COMPLETED' ? 'completed' : 'incomplete',
    request,
    evidence: bundle,
    interpretation,
    assessment,
    stages: PIPELINE_STAGES.map((st) => (st.name === 'Signed Evidence Pack' ? { ...st, status: 'connected' as const, note: 'strict mode: signed and written with --evidence-pack, verified offline with the verify command' } : st)),
    evidencePack: { written: false, reason: 'In strict mode a signed pack is written only when --evidence-pack is given (see the line printed after this report); this report itself is not signed.' },
  });

  const progress: {
    trustAnchor: Line; developerKey: Line; gitContext: Line; developerProof: Line; challengeConsumption: Line;
    developer: StrictSummary['developer']; receipt?: VerifiedConsumption;
    gitRecheck: Provenance['gitRecheck']; context?: ActionContext;
  } = { gitRecheck: 'not_performed', trustAnchor: NOT_CHECKED, developerKey: NOT_CHECKED, gitContext: NOT_CHECKED, developerProof: NOT_CHECKED, challengeConsumption: { status: 'NOT CONSUMED' }, developer: { name: o.asKey } };

  /** the single exit: runs the assessment on the given authorization result and builds everything that is reported */
  const conclude = (auth: PreparedAuthorization | FinalizedAuthorization | undefined, at: Date): StrictAssessResult => {
    const { input, view } = strictInput(auth, at);
    let assessment = runAssessment(input, at);
    // invariant: ALLOW is only ever reported on FINALIZED authority evidence
    if (assessment.status === 'COMPLETED' && assessment.finalDecision === 'ALLOW' && view.state !== 'finalized') {
      assessment = { status: 'FAILED', stage: 'strict authorization', failureKind: 'internal_error', reason: 'refused to report ALLOW on authority evidence that is not finalized', executed: false };
    }
    const checks = auth?.checks as (AuthorizationChecks & { finalization?: Check }) | undefined;
    const requirements: AuthorizationRequirements | undefined = auth?.requirements;
    const state: StrictSummary['authorizationState'] = view.state === 'finalized' ? 'finalized' : view.state === 'provisional' ? 'provisional_not_finalized' : 'blocked';

    const why = [...reasons];
    if (checks) {
      for (const name of Object.keys(label) as Array<keyof typeof label>) {
        const c = (checks as unknown as Record<string, Check | undefined>)[name];
        if (name === 'proofOfPossession' && progress.developerProof.status === 'NOT CHECKED') continue; // the proof was never attempted
        if (c && (c.status === 'failed' || c.status === 'incomplete')) why.push(`${label[name]}: ${c.message} [${c.code}]`);
      }
      const finalization = checks.finalization;
      if (finalization && finalization.status !== 'passed') why.push(`Finalization: ${finalization.message} [${finalization.code}]`);
    }
    if (view.state === 'blocked') {
      for (const u of view.unmetChecks) {
        if (u.code === 'not_attempted' || (u.check === 'proofOfPossession' && progress.developerProof.status === 'NOT CHECKED')) continue; // steps that were never reached
        if (!why.some((w) => w.includes(`[${u.code}]`))) why.push(`${label[u.check as keyof typeof label] ?? u.check}: ${u.code}`);
      }
      if (progress.gitContext.status === 'PENDING') progress.gitContext = { status: 'PENDING', detail: 'collected; not rechecked because authorization was already blocked' };
    }

    const summary: StrictSummary = {
      authorizationState: state,
      developer: progress.developer,
      trustAnchor: progress.trustAnchor,
      developerKey: progress.developerKey,
      developerGrant: lineOf(checks?.requesterGrant),
      revocation: lineOf(checks?.requesterRevocation),
      permission: { ...lineCombine(lineOf(checks?.roles), lineOf(checks?.permissions)), required: requirements?.requiredPermissions ?? [] },
      developerProof: progress.developerProof,
      gitContext: progress.gitContext,
      challengeConsumption: progress.challengeConsumption,
      ...(progress.receipt ? { receipt: progress.receipt } : {}),
      reasons: why,
      ignoredClaims: ignored,
    };
    const decision = assessment.status === 'FAILED' ? 'BLOCK' : assessment.finalDecision;
    const provenance: Provenance = {
      assessedAt: t0.toISOString(),
      trustRootSha256: o.trustRootSha256,
      ...(progress.context && progress.context.commit !== null && progress.context.contentDigest !== null ? { context: { actionId: progress.context.actionId, commit: progress.context.commit, contentDigest: progress.context.contentDigest } } : {}),
      gitRecheck: progress.gitRecheck,
      authorizationBasis: view.reasonCodes[0] ?? 'AUTHORIZATION_RESULT_UNRECOGNIZED',
      requiredPermissions: requirements ? [...requirements.requiredPermissions] : null,
    };
    const result: StrictAssessResult = Object.freeze({
      mode: 'strict_demo' as const,
      request: { action: o.action, environment: o.environment, target: o.target, developer: o.asKey },
      summary,
      session: sessionOf(assessment),
      decision,
      exitCode: assessment.status === 'FAILED' ? (assessment.failureKind === 'invalid_input' ? 1 : 11) : assessment.status === 'INCOMPLETE_INTERPRETATION' ? 3 : decision === 'ALLOW' ? 0 : decision === 'ESCALATE' ? 10 : 11,
      provenance,
    });
    completedRuns.add(result);
    return result;
  };

  // 2. the pinned trust root, the signed policy and revocation list
  let authority: LoadedAuthority;
  try {
    authority = await loadAuthority(o.dir, t0, { trustRoot: { expectedSha256: o.trustRootSha256, ...(o.trustRootFile !== undefined ? { file: o.trustRootFile } : {}) } });
    progress.trustAnchor = { status: 'VERIFIED', detail: `pinned fingerprint ${o.trustRootSha256.slice(0, 16)}…` };
  } catch (e) {
    progress.trustAnchor = { status: 'FAILED' };
    reasons.push(`Trust anchor / signed organization data: ${(e as Error).message}`);
    return conclude(undefined, t0);
  }

  // 3. the developer's key and signed grant
  let developer;
  try {
    developer = await loadPrivateKey({ name: o.asKey, keysDir: o.keysDir });
    progress.developerKey = { status: 'VERIFIED', detail: `key id ${developer.keyId.slice(0, 16)}…` };
  } catch (e) {
    progress.developerKey = { status: 'FAILED' };
    reasons.push(`Developer key missing or unusable: ${(e as Error).message}`);
    return conclude(undefined, t0);
  }
  const found = await findDeveloperGrant(o, authority, developer.keyId, t0);
  if (!found.ok) {
    progress.developerKey = found.code === 'DEVELOPER_KEY_MISMATCH' ? { status: 'FAILED', detail: 'does not match the signed grant' } : progress.developerKey;
    reasons.push(`${found.code === 'DEVELOPER_GRANT_MISSING' ? 'Developer grant missing' : found.code === 'DEVELOPER_KEY_MISMATCH' ? 'Wrong developer private key' : 'Developer grant invalid'}: ${found.detail} [${found.code}]`);
    return conclude(undefined, t0);
  }
  const grant = found.grant;
  progress.developer = { name: o.asKey, subjectId: grant.grant.subject.id, grantId: grant.grant.grantId, roles: grant.grant.roles };

  // 4. the Git action context
  const meta = { actionId: 'pending', actionType: o.action as ActionContext['actionType'], environment: o.environment as ActionContext['environment'], target: o.target };
  const collected = await collectActionContext({ repositoryPath: repoDir, metadata: meta, ...(o.runner ? { runner: o.runner } : {}) });
  if (collected.outcome !== 'collected' || collected.context.commit === null) {
    progress.gitContext = { status: 'FAILED', detail: collected.outcome === 'incomplete' ? collected.code : 'no commit' };
    reasons.push(`Git context unavailable: ${collected.outcome === 'incomplete' ? `${collected.message} [${collected.code}]` : 'no commit to bind to'}`);
    return conclude(undefined, t0);
  }
  const parsed = parseActionContext({ ...collected.context, actionId: deriveActionId(o.action, o.environment, collected.context.commit) });
  if (!parsed.ok) {
    progress.gitContext = { status: 'FAILED', detail: 'invalid action' };
    reasons.push(`The action is not valid: ${parsed.message}`);
    return conclude(undefined, t0);
  }
  const context = parsed.context;
  progress.context = context;
  progress.gitContext = { status: 'PENDING', detail: 'collected; will be rechecked before the challenge is consumed' };

  // 5. the pre-check (everything except the proof)
  const common = { trustRoot: authority.trustRoot, policy: authority.policy, requester: grant, revocation: authority.revocation, context };
  const pre = prepareAuthorization({ ...common, challenge: generateChallenge(), proof: undefined, now: t0 });
  const preBlockers = (Object.entries(pre.checks) as Array<[string, Check]>).filter(([name, c]) => name !== 'proofOfPossession' && name !== 'challengeConsumption' && c.status !== 'passed' && c.status !== 'not_required');
  if (preBlockers.length > 0) return conclude(pre, t0);

  // 6. a signed challenge from the local store, and the developer's proof
  let storeKey;
  try {
    storeKey = await loadPrivateKey({ name: o.storeKey, keysDir: o.keysDir });
  } catch (e) {
    reasons.push(`Challenge store unavailable: the store key is missing or unusable (${(e as Error).message})`);
    progress.challengeConsumption = { status: 'FAILED', detail: 'store key' };
    return conclude(pre, t0);
  }
  let persistence;
  try {
    persistence = await openFilesystemPersistence({ root: path.resolve(o.storeDir), storeId: STORE_ID, storeGeneration: STORE_GENERATION });
  } catch (e) {
    reasons.push(`Challenge store unavailable: its storage could not be opened (${(e as { code?: string }).code ?? 'error'})`);
    progress.challengeConsumption = { status: 'FAILED', detail: 'store storage' };
    return conclude(pre, t0);
  }
  const material = { policy: authority.policyEnvelope, revocation: authority.revocationEnvelope };
  const coreResult = createChallengeStoreCore({
    organization: authority.organization, storeId: STORE_ID, storeGeneration: STORE_GENERATION, signingKey: storeKey.privateKey, trustRoot: authority.trustRoot,
    authority: { current: () => material }, clock: { now: o.now }, persistence,
  });
  if (!coreResult.ok) {
    reasons.push(`Challenge store unavailable: ${coreResult.code} (is the store key listed in the trust root for the challenge_store purpose?)`);
    progress.challengeConsumption = { status: 'FAILED', detail: coreResult.code };
    return conclude(pre, t0);
  }
  const core = coreResult.core;
  const grantEnvelope = found.envelope;
  const issued = await requestChallengeToken({
    trustRoot: authority.trustRoot, storeId: STORE_ID, signingKeyId: storeKey.keyId, requester: grant, grantEnvelope, context, now: o.now(),
    transport: { issue: (r) => core.issue(r), consume: (r) => core.consume(r) }, timeoutMs: 5000,
  });
  if (!issued.ok) {
    reasons.push(`Challenge could not be issued: ${issued.message} [${issued.code}${issued.detail ? `/${issued.detail}` : ''}]`);
    progress.challengeConsumption = { status: 'FAILED', detail: issued.code };
    return conclude(pre, t0);
  }
  let proof;
  try {
    proof = createProof({ privateKey: developer.privateKey, grant, context, challenge: issued.token.token.challenge, issuedAt: o.now() });
  } catch {
    progress.developerProof = { status: 'FAILED', detail: 'could not sign' };
    reasons.push('Developer proof could not be created with this key');
    return conclude(pre, t0);
  }

  // 7. prepare (the challenge is NOT consumed), adapt, and run the existing assessment
  const adapter = createVerifiedStoreAdapter({ core, trustRoot: authority.trustRoot, storeId: STORE_ID, storeKeyId: storeKey.keyId, token: issued.token, requester: grant, context, proof, now: o.now });
  const t1 = o.now();
  const prepared = prepareAuthorization({ ...common, challenge: issued.token.token.challenge, proof, challengeStore: adapter, now: t1 });
  const first = strictInput(prepared, t1);
  const firstAssessment = runAssessment(first.input, t1);
  progress.developerProof = lineOf(prepared.checks.proofOfPossession);
  if (first.view.state !== 'provisional' || firstAssessment.status !== 'COMPLETED' || firstAssessment.finalDecision !== 'ALLOW') {
    // not ALLOW (or not verified): the challenge stays unconsumed and the result is not an ALLOW
    if (first.view.state === 'provisional') {
      progress.gitContext = { status: 'PENDING', detail: 'collected; no recheck was needed because the assessment did not ALLOW' };
      reasons.push('Authorization is verified but NOT finalized: the safety assessment did not ALLOW the action, so the challenge was not consumed.');
    }
    return conclude(prepared, t1);
  }

  // 8. the assessment says ALLOW: recheck Git, then finalize through the signed store, then assess again on finalized evidence
  await o.testHooks?.beforeFinalization?.();
  const recheck = await recheckActionContext(collected as CollectedActionContext, { ...(o.runner ? { runner: o.runner } : {}) });
  let finalContext = context;
  let decisionForFinalization: 'ALLOW' | 'BLOCK' = 'ALLOW';
  if (recheck.outcome === 'unchanged') {
    progress.gitContext = { status: 'VERIFIED', detail: 'rechecked immediately before the challenge was consumed' };
    progress.gitRecheck = 'unchanged';
  } else if (recheck.outcome === 'changed') {
    progress.gitContext = { status: 'CHANGED', detail: recheck.changed.join(', ') };
    progress.gitRecheck = 'changed';
    reasons.push(`Git context changed since authorization (${recheck.changed.join(', ')}): the action that was authorized is not the action that would run`);
    if (recheck.current) finalContext = { ...recheck.current.context, actionId: context.actionId };
    decisionForFinalization = 'BLOCK';
  } else {
    progress.gitContext = { status: 'FAILED', detail: recheck.code };
    progress.gitRecheck = 'incomplete';
    reasons.push(`Git context could not be rechecked: ${recheck.message} [${recheck.code}]`);
    decisionForFinalization = 'BLOCK';
  }
  const t2 = o.now();
  const finalized = await finalizeAuthorization({
    prepared, safetyDecision: attestSafetyDecision(prepared, decisionForFinalization, context), context: finalContext, challenge: issued.token.token.challenge, challengeStore: adapter, now: t2,
  });
  const consumption = adapter.consumption();
  if (finalized.outcome === 'authorized' && consumption) {
    progress.challengeConsumption = { status: 'VERIFIED', detail: 'signed receipt verified' };
    progress.receipt = consumption;
  } else {
    progress.challengeConsumption = { status: finalized.checks.challengeConsumption.status === 'not_evaluated' ? 'NOT CONSUMED' : 'FAILED', ...(adapter.failure() ? { detail: adapter.failure() as string } : {}) };
    if (decisionForFinalization === 'ALLOW') reasons.push(`Challenge consumption failed: no verified signed receipt${adapter.failure() ? ` [${adapter.failure()}]` : ''}`);
  }
  return conclude(finalized, t2);
}

function lineCombine(a: Line, b: Line): Line {
  if (a.status === 'VERIFIED' && b.status === 'VERIFIED') return { status: 'VERIFIED' };
  const bad = [a, b].find((l) => l.status === 'FAILED') ?? [a, b].find((l) => l.status !== 'VERIFIED');
  return bad ?? NOT_CHECKED;
}
