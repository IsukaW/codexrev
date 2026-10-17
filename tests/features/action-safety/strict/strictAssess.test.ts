// Integration tests: STRICT DEMO MODE. Real keys, real signed artifacts, the real verifiers, the real
// two-phase evaluator, the real signed challenge store (in this process, state in a temporary directory),
// real Git repositories, and the real safety assessment (score, five gates, decision engine).
// Only the local-model interpretation is replaced (it is advisory and not part of authorization).

import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStrictAuthorityInput, isStrictAuthorityInput } from '../../../../src/features/action-safety/authorization/strictAssessmentInput.js';
import { adaptAuthorization } from '../../../../src/features/action-safety/authorization/strictAuthorityAdapter.js';
import { assessAction } from '../../../../src/features/action-safety/pipeline/assessmentCoordinator.js';
import { runAssessmentSession } from '../../../../src/features/action-safety/cli/runAssessment.js';
import { collectEvidence } from '../../../../src/features/action-safety/collectors/evidenceOrchestrator.js';
import { loadAssessmentRequest } from '../../../../src/features/action-safety/cli/assessmentInput.js';
import { issueGrant, revokeGrants } from '../../../../src/features/action-safety/strict/admin.js';
import { trustRootFingerprint } from '../../../../src/features/action-safety/strict/authority.js';
import { generateKeyProfile, loadPrivateKey } from '../../../../src/features/action-safety/strict/keyStore.js';
import { runStrictCli } from '../../../../src/features/action-safety/strict/run.js';
import { OTHER_GATE_RULES, runStrictAssessment, type StrictAssessOptions, type StrictAssessResult } from '../../../../src/features/action-safety/strict/strictAssess.js';
import { renderStrictAssessment } from '../../../../src/features/action-safety/strict/strictReport.js';
import { initOrganization } from '../../../../src/features/action-safety/strict/admin.js';
import { NOW, commitChange, copyDir, later, noInterpretation, setupOrganization, writeEvidence, type Fixture } from '../../../../src/features/action-safety/testing/strictFixture.js';

const T = 180_000;
let f: Fixture;
let pin: string;
let input: string;
let storeCounter = 0;

const fingerprintOf = (authorityDir: string): string => trustRootFingerprint(readFileSync(join(authorityDir, 'trust-root.json')));

beforeAll(async () => {
  f = await setupOrganization();
  input = writeEvidence(f.repo, NOW);
  pin = fingerprintOf(f.authorityDir);
}, T);
afterAll(() => f.cleanup());

const storeDirs: string[] = [];
const newStoreDir = (): string => {
  const d = join(f.root, `store-${++storeCounter}`);
  storeDirs.push(d);
  return d;
};
const base = (over: Partial<StrictAssessOptions> = {}): StrictAssessOptions => ({
  dir: f.authorityDir, trustRootSha256: pin, asKey: 'alice', keysDir: f.keysDir, storeKey: 'store', storeDir: newStoreDir(), action: 'deployment', environment: 'production', target: 'my-app',
  repo: f.repo, inputFile: input, now: () => NOW, interpreter: noInterpretation, ...over,
});
const run = (over: Partial<StrictAssessOptions> = {}): Promise<StrictAssessResult> => runStrictAssessment(base(over));
const text = (r: StrictAssessResult): string => r.summary.reasons.join('\n');
const consumed = (dir: string): number => (existsSync(join(dir, 'consumption')) ? readdirSync(join(dir, 'consumption')).length : 0);
const gate = (r: StrictAssessResult, id: string) => (r.session?.assessment.status === 'FAILED' ? undefined : r.session?.assessment.status ? (r.session.assessment as unknown as { gates: { results: Array<{ gate: string; status: string }> } }).gates.results.find((g) => g.gate === id) : undefined);

/** an ALLOW is only ever reported with a verified receipt and finalized authority */
const expectCompletedAllow = (r: StrictAssessResult): void => {
  expect(r.decision).toBe('ALLOW');
  expect(r.exitCode).toBe(0);
  expect(r.summary.authorizationState).toBe('finalized');
  expect(r.summary.challengeConsumption.status).toBe('VERIFIED');
  expect(r.summary.receipt?.receiptId).toBeTruthy();
};
const expectBlocked = (r: StrictAssessResult, pattern: RegExp): void => {
  expect(r.decision).toBe('BLOCK');
  expect(r.exitCode).toBe(11);
  expect(r.summary.authorizationState).toBe('blocked');
  expect(r.summary.receipt).toBeUndefined();
  expect(text(r)).toMatch(pattern);
};

// ================================================================ valid authorization

describe('valid signed authorization', () => {
  it('1. a developer with a valid grant: code_change in development is ALLOWed after a verified, consumed challenge', { timeout: T }, async () => {
    const storeDir = newStoreDir();
    const r = await run({ action: 'code_change', environment: 'development', storeDir });
    expectCompletedAllow(r);
    expect(r.summary).not.toHaveProperty('approvals');
    expect(gate(r, 'AUTHORIZATION')?.status).toBe('PASS');
    expect(consumed(storeDir)).toBe(1); // consumed exactly once, after the assessment allowed it
    expect(r.session?.assessment.status === 'COMPLETED' && r.session.assessment.policy.gatePolicySource).toBe('strict_verified');
  });

  it('2. a production deployment by an authorized release engineer is ALLOWed without any separate approval', { timeout: T }, async () => {
    const storeDir = newStoreDir();
    const r = await run({ storeDir });
    expectCompletedAllow(r);
    expect(r.summary).toMatchObject({
      developerGrant: { status: 'VERIFIED' }, revocation: { status: 'VERIFIED' }, permission: { status: 'VERIFIED', required: ['deployment.production'] }, developerProof: { status: 'VERIFIED' },
      gitContext: { status: 'VERIFIED' }, trustAnchor: { status: 'VERIFIED' },
    });
    expect(gate(r, 'HUMAN_APPROVAL')).toBeUndefined(); // there is no such gate any more
    expect(r.session?.assessment.status === 'COMPLETED' && r.session.assessment.gates.results.map((g) => g.gate).sort()).toEqual(['AUTHORIZATION', 'BUILD_TEST_RESULTS', 'SUPPORTING_EVIDENCE', 'VERIFIED_RECOVERY']);
    const lines = renderStrictAssessment(r).join('\n');
    expect(lines).toContain('STRICT DEMO MODE');
    expect(lines).toContain('Final Decision: ALLOW');
    expect(lines).not.toMatch(/approval/i); // no misleading permanent "Human Approval: PASS" line
    expect(consumed(storeDir)).toBe(1);
  });

  it('3. the safety score keeps its formula: the Authority factor is the only input the verified evidence changes', { timeout: T }, async () => {
    const r = await run();
    const a = r.session?.assessment;
    if (!a || a.status === 'FAILED') throw new Error('expected an assessment');
    const f4 = a.factors;
    const score = 0.25 * f4.reversibility.score + 0.25 * a.calculus.adjustedBlastRadius /* already 1-B */ + 0.25 * f4.authority.score + 0.25 * f4.evidenceStrength.score;
    expect(a.safetyScore).toBeCloseTo(score, 3);
    expect(f4.authority.score).toBeGreaterThan(0.9); // verified identity, roles and permissions
  });
});

// ================================================================ the developer's identity

describe('the developer’s signed grant and key', () => {
  it('missing developer grant: BLOCK, and nothing is issued or consumed', { timeout: T }, async () => {
    const storeDir = newStoreDir();
    const r = await run({ asKey: 'mallory', storeDir });
    expectBlocked(r, /Developer grant missing.*DEVELOPER_GRANT_MISSING/);
    expect(consumed(storeDir)).toBe(0);
    expect(existsSync(join(storeDir, 'issuance')) ? readdirSync(join(storeDir, 'issuance')).length : 0).toBe(0);
    expect(gate(r, 'AUTHORIZATION')?.status).not.toBe('PASS');
  });

  it('tampered developer grant: BLOCK (an edited role cannot be used)', { timeout: T }, async () => {
    const copy = join(f.root, 'authority-tampered');
    copyDir(f.authorityDir, copy);
    const file = join(copy, 'grants', `${f.grants.bob.grantId}.grant.json`);
    const env = JSON.parse(readFileSync(file, 'utf-8'));
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    writeFileSync(file, JSON.stringify({ ...env, payload: Buffer.from(JSON.stringify({ ...doc, roles: ['l5'] })).toString('base64url') }));
    const r = await run({ dir: copy, asKey: 'bob' });
    expectBlocked(r, /Developer grant invalid.*signature_verification_failed/);
    expect(r.exitCode).toBe(11);
  });

  it('wrong developer private key: BLOCK', { timeout: T }, async () => {
    // bob holds a different key than the one in alice's signed grant
    const r = await run({ asKey: 'bob', subject: 'alice', grantFile: f.grants.alice.file });
    expectBlocked(r, /Wrong developer private key.*DEVELOPER_KEY_MISMATCH/);
    expect(r.summary.developerKey.status).toBe('FAILED');
    // and a missing key profile
    const none = await run({ asKey: 'nobody' });
    expectBlocked(none, /Developer key missing/);
  });

  it('expired developer grant: BLOCK', { timeout: T }, async () => {
    await generateKeyProfile({ name: 'carol', keysDir: f.keysDir, now: NOW });
    await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'carol', pubkeyFile: join(f.keysDir, 'carol.pub.json'), roles: ['l4'], days: 1, now: NOW });
    const ok = await run({ asKey: 'carol', action: 'code_change', environment: 'development' });
    expectCompletedAllow(ok); // valid today...
    const r = await run({ asKey: 'carol', action: 'code_change', environment: 'development', now: () => later(2) }); // ...refused two days later
    expectBlocked(r, /Developer grant invalid.*grant_expired/);
  });

  it('revoked developer grant: BLOCK', { timeout: T }, async () => {
    const copy = join(f.root, 'authority-revoked');
    copyDir(f.authorityDir, copy);
    await revokeGrants({ dir: copy, adminKey: 'admin', keysDir: f.keysDir, grantIds: [f.grants.alice.grantId], now: NOW });
    const storeDir = newStoreDir();
    const r = await run({ dir: copy, storeDir });
    expectBlocked(r, /Revocation: .*grant_revoked/);
    expect(r.summary.revocation.status).toBe('FAILED');
    expect(consumed(storeDir)).toBe(0);
  });

  it('a grant for the wrong permission cannot do the action: a developer cannot deploy to production', { timeout: T }, async () => {
    const r = await run({ asKey: 'bob' });
    expectBlocked(r, /(Role|Permission): .*(role_missing|permission_missing)/);
    expect(r.summary.permission.status).toBe('FAILED');
  });
});

// ================================================================ no per-action approval

describe('no per-action approval; the role never bypasses the safety checks', () => {
  it('the report and the summary have no approval line, count or gate', { timeout: T }, async () => {
    const r = await run();
    expectCompletedAllow(r);
    expect(Object.keys(r.summary)).not.toContain('approvals');
    expect(r.provenance).not.toHaveProperty('requiredApprovals');
    expect(r.provenance).not.toHaveProperty('verifiedApprovers');
    expect(renderStrictAssessment(r).join('\n')).not.toMatch(/approval/i);
  });

  it('an authorized release engineer is still stopped by a failed mandatory gate', { timeout: T }, async () => {
    const storeDir = newStoreDir();
    const r = await run({ storeDir, inputFile: writeEvidence(f.repo, NOW, { buildTests: false }) });
    expect(r.decision).toBe('BLOCK');
    expect(r.summary.developerGrant.status).toBe('VERIFIED'); // the grant itself was fine
    expect(r.summary.authorizationState).toBe('provisional_not_finalized');
    expect(gate(r, 'BUILD_TEST_RESULTS')?.status).not.toBe('PASS');
    expect(consumed(storeDir)).toBe(0);
    writeEvidence(f.repo, NOW);
  });

  it('an authorized release engineer with an intermediate Safety Score is ESCALATEd, never ALLOWed', { timeout: T }, async () => {
    const storeDir = newStoreDir();
    const risky = writeEvidence(f.repo, NOW, { extra: { action: { impact: 'high', irreversible: false, blastRadius: { criticality: 'critical', scope: 'database_wide', sharedModulesModified: 8, dependencyReach: 40, affectedServiceCount: 12 } } } });
    const r = await run({ storeDir, inputFile: risky, action: 'code_change', environment: 'development' });
    expect(r.decision).toBe('ESCALATE');
    expect(r.exitCode).toBe(10);
    expect(r.summary.authorizationState).toBe('provisional_not_finalized');
    expect(consumed(storeDir)).toBe(0); // ESCALATE neither starts an approval workflow nor consumes anything
    expect(renderStrictAssessment(r).join('\n')).not.toMatch(/approval/i);
    writeEvidence(f.repo, NOW);
  });

  it('a grant whose scope was narrowed cannot deploy to production, whatever its role says', { timeout: T }, async () => {
    await generateKeyProfile({ name: 'frank', keysDir: f.keysDir, now: NOW });
    await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'frank', pubkeyFile: join(f.keysDir, 'frank.pub.json'), roles: ['l4'], days: 30, permissionScope: ['code.modify'], now: NOW });
    const blocked = await run({ asKey: 'frank' });
    expectBlocked(blocked, /Permission: .*permission_missing/);
    expect(blocked.summary.permission.status).toBe('FAILED');
    expectCompletedAllow(await run({ asKey: 'frank', action: 'code_change', environment: 'development' })); // what the scope keeps still works
  });
});

// ================================================================ the JSON bypass

describe('assessment JSON cannot grant authority', () => {
  it('12. human_attested / verified_system claims and roles typed into the JSON are ignored: BLOCK', { timeout: T }, async () => {
    const claimsInput = writeEvidence(f.repo, NOW, { claims: true });
    const r = await run({ asKey: 'bob', inputFile: claimsInput });
    expectBlocked(r, /(Role|Permission)/);
    expect(r.summary.ignoredClaims).toEqual(expect.arrayContaining(['actor (identity and roles)', 'authority.authorization', 'authority.identityVerification', 'authority.grantedPermissions', 'policy (gate rules)']));
    expect(renderStrictAssessment(r).join('\n')).toMatch(/Ignored claims in the input file/);
    // the same claims in ADVISORY mode are believed (unchanged legacy behavior): that is exactly the bypass strict mode removes
    const advisory = await runAssessmentSession({ cwd: f.repo, flags: { action: 'deployment', target: 'production', input: claimsInput }, now: NOW.toISOString(), interpreter: noInterpretation });
    const a = advisory.assessment;
    if (a.status === 'FAILED') throw new Error('advisory run failed');
    // the JSON said authorization is not required, and advisory mode believes it: the gate does not stop the action
    expect(['PASS', 'NOT_APPLICABLE']).toContain(a.gates.results.find((g) => g.gate === 'AUTHORIZATION')?.status);
    expect(a.policy.gatePolicySource).toBe('input_file');
    writeEvidence(f.repo, NOW); // restore the clean input
  });

  it('13. a JSON gate policy cannot disable authorization or weaken the other gates', { timeout: T }, async () => {
    const claimsInput = writeEvidence(f.repo, NOW, { claims: true, buildTests: false, recovery: false });
    const r = await run({ asKey: 'mallory', inputFile: claimsInput });
    expectBlocked(r, /Developer grant missing/);
    expect(gate(r, 'AUTHORIZATION')?.status).not.toBe('PASS');
    const assessment = r.session?.assessment;
    expect(assessment && assessment.status !== 'FAILED' && assessment.policy.gatePolicySource).toBe('strict_verified');
    // a genuine developer: the JSON still cannot waive the build/test gate that the fixed rules require
    const genuine = await run({ inputFile: claimsInput });
    expect(genuine.decision).not.toBe('ALLOW');
    expect(gate(genuine, 'BUILD_TEST_RESULTS')?.status).not.toBe('PASS');
    expect(genuine.summary.authorizationState).toBe('provisional_not_finalized');
    writeEvidence(f.repo, NOW);
  });

  it('the coordinator accepts strict authority only from the subsystem: copies and hand-built objects fail the assessment', { timeout: T }, async () => {
    const request = await loadAssessmentRequest({ action: 'deployment', target: 'production', input }, f.repo);
    const bundle = await collectEvidence({ cwd: f.repo, request, now: NOW.toISOString() });
    const view = adaptAuthorization(undefined as never, NOW); // a blocked view
    const built = buildStrictAuthorityInput(view, OTHER_GATE_RULES);
    if (!built.ok) throw new Error('setup');
    expect(isStrictAuthorityInput(built.input)).toBe(true);
    const common = { bundle, interpretation: await noInterpretation(), now: NOW.toISOString() };
    expect(assessAction({ ...common, strictAuthority: built.input }).status).toBe('COMPLETED');
    const forged = { ...built.input, state: 'finalized' as const };
    expect(isStrictAuthorityInput(forged)).toBe(false);
    expect(assessAction({ ...common, strictAuthority: forged })).toMatchObject({ status: 'FAILED', stage: 'strict authority' });
    expect(assessAction({ ...common, strictAuthority: JSON.parse(JSON.stringify(built.input)) })).toMatchObject({ status: 'FAILED' });
    expect(buildStrictAuthorityInput({ state: 'finalized' } as never, OTHER_GATE_RULES)).toMatchObject({ ok: false, code: 'not_a_strict_view' });
    expect(buildStrictAuthorityInput(view, { ...OTHER_GATE_RULES, authorization: { required: false } } as never)).toMatchObject({ ok: false, code: 'authorization_rules_not_accepted' });
  });
});

// ================================================================ finalization

describe('two-phase authorization', () => {
  it('14. a Git change between authorization and finalization BLOCKs and consumes nothing', { timeout: T }, async () => {
    for (const mutate of ['commit', 'dirty'] as const) {
      const repoCopy = join(f.root, `repo-change-${mutate}`);
      copyDir(f.repo, repoCopy);
      const storeDir = newStoreDir();
      const r = await run({ repo: repoCopy, storeDir, testHooks: { beforeFinalization: () => (mutate === 'commit' ? commitChange(repoCopy) : writeFileSync(join(repoCopy, 'app.txt'), 'edited after authorization\n')) } });
      expect(r.decision, mutate).toBe('BLOCK');
      expect(r.summary.gitContext.status, mutate).toBe('CHANGED');
      expect(text(r), mutate).toMatch(/Git context changed since authorization/);
      expect(r.summary.receipt, mutate).toBeUndefined();
      expect(consumed(storeDir), mutate).toBe(0);
    }
  });

  it('15. a failed challenge consumption prevents ALLOW', { timeout: T }, async () => {
    const storeDir = newStoreDir();
    // the store loses the challenge's record between authorization and finalization
    const r = await run({
      storeDir,
      testHooks: { beforeFinalization: () => { for (const n of readdirSync(join(storeDir, 'issuance'))) rmSync(join(storeDir, 'issuance', n)); } },
    });
    expect(r.decision).toBe('BLOCK');
    expect(r.summary.challengeConsumption.status).toBe('FAILED');
    expect(text(r)).toMatch(/Challenge consumption/);
    expect(r.summary.receipt).toBeUndefined();
    expect(consumed(storeDir)).toBe(0);
    // a store that cannot be used at all
    const badKey = await run({ storeKey: 'mallory' });
    expectBlocked(badKey, /Challenge store unavailable/);
    const badDir = await run({ storeDir: join(f.root, 'keys', 'alice.key') }); // a file, not a directory
    expectBlocked(badDir, /Challenge store unavailable/);
  });

  it('16. a provisional ALLOW is never reported as a completed ALLOW', { timeout: T }, async () => {
    // (a) the assessment allows it provisionally, but finalization fails: the reported decision is BLOCK
    const storeDir = newStoreDir();
    const failing = await run({ storeDir, testHooks: { beforeFinalization: () => { for (const n of readdirSync(join(storeDir, 'issuance'))) rmSync(join(storeDir, 'issuance', n)); } } });
    expect(failing.decision).toBe('BLOCK');
    expect(failing.session?.assessment.status === 'COMPLETED' && failing.session.assessment.finalDecision).toBe('BLOCK');
    expect(renderStrictAssessment(failing).join('\n')).not.toMatch(/Final Decision: ALLOW|FINAL DECISION: ALLOW/);
    // (b) whenever ALLOW is reported there is a verified receipt and finalized authority
    const ok = await run();
    expectCompletedAllow(ok);
    expect(ok.summary.authorizationState).toBe('finalized');
    // (c) when the assessment does not ALLOW, the challenge is neither consumed nor shown as consumed
    const noEvidence = writeEvidence(f.repo, NOW, { buildTests: false });
    const dir = newStoreDir();
    const blocked = await run({ storeDir: dir, inputFile: noEvidence });
    expect(blocked.decision).not.toBe('ALLOW');
    expect(blocked.summary.authorizationState).toBe('provisional_not_finalized');
    expect(blocked.summary.challengeConsumption.status).toBe('NOT CONSUMED');
    expect(consumed(dir)).toBe(0);
    expect(renderStrictAssessment(blocked).join('\n')).toMatch(/NOT FINALIZED/);
    writeEvidence(f.repo, NOW);
  });

  it('17. the other three gates still decide: missing build/test evidence or recovery evidence stops an authorized developer', { timeout: T }, async () => {
    const noBuild = await run({ inputFile: writeEvidence(f.repo, NOW, { buildTests: false }) });
    expect(noBuild.decision).not.toBe('ALLOW');
    expect(gate(noBuild, 'BUILD_TEST_RESULTS')?.status).not.toBe('PASS');
    expect(noBuild.summary.developerGrant.status).toBe('VERIFIED'); // authorization itself was fine
    const irreversible = await run({ inputFile: writeEvidence(f.repo, NOW, { recovery: false, extra: { action: { impact: 'high', irreversible: true, blastRadius: { criticality: 'low', scope: 'local', sharedModulesModified: 0, dependencyReach: 0, affectedServiceCount: 1 } } } }) });
    expect(irreversible.decision).not.toBe('ALLOW');
    expect(gate(irreversible, 'VERIFIED_RECOVERY')?.status).not.toBe('PASS');
    writeEvidence(f.repo, NOW);
  });

  it('a stale or wrong challenge store state cannot be reused: each run issues and consumes its own challenge', { timeout: T }, async () => {
    const storeDir = newStoreDir();
    const first = await run({ storeDir });
    const second = await run({ storeDir });
    expectCompletedAllow(first);
    expectCompletedAllow(second);
    expect(first.summary.receipt?.receiptId).not.toBe(second.summary.receipt?.receiptId);
    expect(consumed(storeDir)).toBe(2);
  });
});

// ================================================================ trust anchor

describe('the trust anchor', () => {
  it('a wrong or malformed pin blocks everything, and nothing signed under the unpinned root is believed', { timeout: T }, async () => {
    const wrong = await run({ trustRootSha256: 'a'.repeat(64) });
    expectBlocked(wrong, /does not match the pinned fingerprint/);
    expect(wrong.summary.trustAnchor.status).toBe('FAILED');
    expectBlocked(await run({ trustRootSha256: 'not-a-fingerprint' }), /pinned trust-root fingerprint must be/);
    expectBlocked(await run({ trustRootSha256: pin.toUpperCase() }), /pinned trust-root fingerprint must be/);
  });

  it('replacing the whole authority directory with an attacker’s organization is refused', { timeout: T }, async () => {
    // the attacker makes their own organization, with a grant for alice's own key, all perfectly signed
    const evilKeys = join(f.root, 'evil-keys');
    await generateKeyProfile({ name: 'evil-admin', keysDir: evilKeys, now: NOW });
    await generateKeyProfile({ name: 'store', keysDir: evilKeys, now: NOW });
    const evilDir = join(f.root, 'evil-authority');
    await initOrganization({ organization: 'acme', dir: evilDir, adminKey: 'evil-admin', storeKey: 'store', keysDir: evilKeys, now: NOW });
    const r = await run({ dir: evilDir });
    expectBlocked(r, /does not match the pinned fingerprint/);
    // with the attacker's own fingerprint it would be accepted: the pin is the anchor, and it must come from the administrator
    expect(fingerprintOf(evilDir)).not.toBe(pin);
  });

  it('a separate administrator-installed trust-root file can be used, and must match the pin too', { timeout: T }, async () => {
    const ok = await run({ trustRootFile: join(f.authorityDir, 'trust-root.json'), action: 'code_change', environment: 'development' });
    expectCompletedAllow(ok);
    const evilFile = join(f.root, 'evil-authority', 'trust-root.json');
    expectBlocked(await run({ trustRootFile: evilFile }), /does not match the pinned fingerprint/);
  });

  it('a modified policy or revocation list is refused', { timeout: T }, async () => {
    const copy = join(f.root, 'authority-policy-edited');
    copyDir(f.authorityDir, copy);
    const file = join(copy, 'policy.signed.json');
    const env = JSON.parse(readFileSync(file, 'utf-8'));
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    doc.rules = doc.rules.map((r: object) => ({ ...r, allowedRoles: ['l1', 'l2', 'l3', 'l4', 'l5'] })); // "everyone may deploy"
    writeFileSync(file, JSON.stringify({ ...env, payload: Buffer.from(JSON.stringify(doc)).toString('base64url') }));
    expectBlocked(await run({ dir: copy }), /signed policy is not acceptable/);
    const copy2 = join(f.root, 'authority-revocation-edited');
    copyDir(f.authorityDir, copy2);
    const rfile = join(copy2, 'revocation.signed.json');
    const renv = JSON.parse(readFileSync(rfile, 'utf-8'));
    writeFileSync(rfile, JSON.stringify({ ...renv, signature: renv.signature.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A')) }));
    expectBlocked(await run({ dir: copy2 }), /revocation list is not acceptable/);
  });
});

// ================================================================ command line

describe('the command line', () => {
  const cli = async (args: string[], hooks: object = { interpreter: noInterpretation }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runStrictCli(args, { out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, hooks: hooks as never });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const common = (): string[] => ['--strict', '--dir', f.authorityDir, '--trust-root-sha256', pin, '--keys-dir', f.keysDir, '--store-dir', newStoreDir(), '--repo', f.repo, '--input', input];

  it('prints STRICT DEMO MODE, the real results and exits 0 for ALLOW, 11 for BLOCK', { timeout: T }, async () => {
    const ok = await cli(['assess', ...common(), '--as', 'alice', '--action', 'deployment', '--environment', 'production', '--target', 'my-app']);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/STRICT DEMO MODE/);
    expect(ok.out).toMatch(/Final Decision: ALLOW/);
    expect(ok.out).toMatch(/Challenge consumption:\s+VERIFIED/);
    const secrets = [String((await loadPrivateKey({ name: 'alice', keysDir: f.keysDir, platform: 'win32' })).privateKey.export({ format: 'jwk' }).d), String((await loadPrivateKey({ name: 'store', keysDir: f.keysDir, platform: 'win32' })).privateKey.export({ format: 'jwk' }).d), 'PRIVATE KEY'];
    for (const s of secrets) expect(ok.out + ok.err).not.toContain(s);
    const blocked = await cli(['assess', ...common(), '--as', 'bob', '--action', 'deployment', '--environment', 'production', '--target', 'my-app']);
    expect(blocked.code).toBe(11);
    expect(blocked.out).toMatch(/Final Decision: BLOCK/);
    expect(blocked.out).toMatch(/Reasons:/);
  });

  it('has no silent mode: --strict and the pin are required, and unknown options are usage errors', async () => {
    const noStrict = await cli(['assess', '--dir', f.authorityDir, '--trust-root-sha256', pin, '--as', 'alice', '--action', 'deployment', '--environment', 'production', '--target', 'my-app']);
    expect(noStrict.code).toBe(2);
    expect(noStrict.err).toMatch(/only runs STRICT assessments/);
    const noPin = await cli(['assess', '--strict', '--dir', f.authorityDir, '--as', 'alice', '--action', 'deployment', '--environment', 'production', '--target', 'my-app']);
    expect(noPin.code).toBe(2);
    expect(noPin.err).toMatch(/--trust-root-sha256 is required/);
    expect((await cli(['assess', ...common(), '--as', 'alice', '--action', 'deployment', '--environment', 'production', '--target', 'my-app', '--advisory'])).code).toBe(2);
  });

  it('an invalid action or environment is invalid input, never an ALLOW', { timeout: T }, async () => {
    const r = await cli(['assess', ...common(), '--as', 'alice', '--action', 'launch_missiles', '--environment', 'production', '--target', 'my-app']);
    expect([1, 2]).toContain(r.code);
    expect(r.out).not.toMatch(/Final Decision: ALLOW/);
  });

  it('the removed approval workflow is gone from the command line: --approval and approve are rejected as usage errors', async () => {
    const withFlag = await cli(['assess', ...common(), '--as', 'alice', '--action', 'deployment', '--environment', 'production', '--target', 'my-app', '--approval', 'some.approval.json']);
    expect(withFlag.code).toBe(2);
    expect(withFlag.out).not.toMatch(/Final Decision/);
    const approve = await cli(['approve', '--dir', f.authorityDir, '--as', 'lead1', '--action', 'deployment', '--environment', 'production', '--target', 'my-app', '--yes']);
    expect(approve.code).toBe(2);
    expect(approve.err).toMatch(/unknown command: approve/);
  });

  it('prints the trust-root fingerprint for the administrator to share', async () => {
    const r = await cli(['admin', 'fingerprint', '--dir', f.authorityDir]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(pin);
  });
});
