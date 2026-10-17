/**
 * Research evaluation of Feature 4. It builds disposable materials, runs the real commands, and RECORDS what
 * happened: outcomes, counts and durations. Nothing in the result is typed in by hand; every number comes from a
 * run. It reuses the Phase 9 scenario runner for the functional results and adds an attack suite, an Evidence Pack
 * tamper suite, a small timing experiment and an explainability check.
 *
 * Honest scope: this is a demonstration-sized evaluation (a few dozen cases, a handful of timing runs). It shows that
 * the implemented behavior matches its design on these cases; it does not establish statistical significance and it
 * says nothing about an attacker who can modify the executable or the operating system.
 */

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { collectActionContext } from '../authorization/actionContextCollector.js';
import { loadAssessmentRequest } from '../cli/assessmentInput.js';
import { collectEvidence } from '../collectors/evidenceOrchestrator.js';
import { signEnvelope } from '../authorization/envelope.js';
import { NOW, commitChange, copyDir, later, noInterpretation, setupOrganization, writeEvidence, type Fixture } from '../testing/strictFixture.js';
import { issueGrant, revokeGrants } from './admin.js';
import { trustRootFingerprint } from './authority.js';
import { runDemo, type ScenarioResult } from './demoScenarios.js';
import { buildEvidencePack, createEvidencePackFile, verifyEvidencePack, type EvidencePackDocument, type TrustedSigner } from './evidencePack.js';
import { generateKeyProfile, loadPrivateKey } from './keyStore.js';
import { runStrictCli } from './run.js';
import { runStrictAssessment, type StrictAssessOptions, type StrictAssessResult } from './strictAssess.js';

// ---------------------------------------------------------------- result types

export interface Stats {
  readonly n: number;
  readonly meanMs: number;
  readonly stdDevMs: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly maxMs: number;
  readonly samplesMs: readonly number[];
}

export interface AttackCase {
  readonly id: string;
  readonly category: 'authorization' | 'trust anchor' | 'tampering' | 'two-phase' | 'safety bypass';
  readonly description: string;
  readonly decision: string;
  readonly exitCode: number;
  readonly allowed: boolean;
  readonly firstReason: string;
  /** every reason the report gave (at most 8) */
  readonly reasons: readonly string[];
  /** whether the reasons name the SPECIFIC cause (a bracketed code other than the generic 'not attempted') */
  readonly specificCauseNamed: boolean;
  readonly evidencePackAuthorizationStatus: string;
}

export interface TamperCase {
  readonly id: string;
  readonly detected: boolean;
  readonly signature: string;
  readonly signer: string;
  readonly payloadIntegrity: string;
  readonly reason: string;
}

export interface EvaluationResult {
  readonly generatedAt: string;
  readonly environment: { readonly node: string; readonly platform: string; readonly cpu: string; readonly cores: number; readonly memoryGb: number };
  readonly methodology: { readonly demoRepetitions: number; readonly timingRuns: number; readonly warmUpRunsDiscarded: number; readonly clock: string; readonly interpretation: string };
  readonly functional: {
    readonly repetitions: number;
    readonly scenarioCount: number;
    readonly correctPerRepetition: readonly number[];
    readonly decisionCoverage: Readonly<Record<string, number>>;
    readonly consistentAcrossRepetitions: boolean;
    readonly scenarios: readonly { readonly id: number; readonly title: string; readonly expected: string; readonly observed: string; readonly ok: boolean; readonly safetyScore: number | null }[];
  };
  readonly authorization: {
    readonly attackCount: number;
    readonly attacksAllowed: number;
    readonly controlsAllowed: number;
    readonly controlCount: number;
    readonly attacks: readonly AttackCase[];
  };
  readonly evidenceIntegrity: {
    readonly genuineVerifies: boolean;
    readonly tamperCount: number;
    readonly tamperDetected: number;
    readonly untrustedSignerRejected: boolean;
    readonly cases: readonly TamperCase[];
  };
  readonly performance: {
    readonly unit: 'milliseconds';
    readonly developmentAssessment: Stats;
    readonly productionAssessment: Stats;
    readonly productionAssessmentWithEvidencePack: Stats;
    readonly evidencePackVerification: Stats;
    /** parts of an assessment, measured on their own, to show where the time goes */
    readonly partGitContextCollection: Stats;
    readonly partEvidenceCollection: Stats;
  };
  readonly explainability: {
    readonly nonAllowCount: number;
    readonly withMeaningfulReason: number;
    readonly authorizationFailures: number;
    readonly safetyFailures: number;
    readonly classifiedCorrectly: number;
    readonly evidencePackStatusCounts: Readonly<Record<string, number>>;
    /** among the attack attempts: how many reports name the specific cause, not just a generic one */
    readonly attackReportsNamingSpecificCause: number;
    readonly attackReportCount: number;
    readonly cases: readonly { readonly id: number; readonly decision: string; readonly kind: 'authorization failure' | 'safety failure'; readonly authorizationState: string; readonly hasReason: boolean; readonly firstReason: string }[];
  };
  readonly limitations: readonly string[];
}

// ---------------------------------------------------------------- helpers

export function stats(samples: readonly number[]): Stats {
  const n = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const r = (x: number): number => Math.round(x * 10) / 10;
  return { n, meanMs: r(mean), stdDevMs: r(Math.sqrt(variance)), minMs: r(sorted[0] as number), medianMs: r(median), maxMs: r(sorted[n - 1] as number), samplesMs: samples.map(r) };
}

const scoreOf = (output: string): number | null => {
  const m = /Safety Score: ([0-9.]+)/.exec(output);
  return m ? Number(m[1]) : null;
};

const TAMPER_NOTE = 'edited after signing, without the signing key';

// ---------------------------------------------------------------- the evaluation

export async function runEvaluation(options: { readonly demoRepetitions?: number; readonly timingRuns?: number; readonly log?: (line: string) => void } = {}): Promise<EvaluationResult> {
  const reps = options.demoRepetitions ?? 3;
  const timingRuns = options.timingRuns ?? 10;
  const log = options.log ?? ((): void => undefined);

  // ================================================================ A. functional correctness (the Phase 9 scenarios, repeated)
  log(`functional: running the 15 demonstration scenarios ${reps} time(s)…`);
  const demos: ScenarioResult[][] = [];
  for (let i = 0; i < reps; i++) {
    const demo = await runDemo();
    demos.push([...demo.scenarios]);
    demo.cleanup();
  }
  const first = demos[0] as ScenarioResult[];
  const consistent = first.every((s) => demos.every((run) => run.find((x) => x.id === s.id)?.observed === s.observed && scoreOf(run.find((x) => x.id === s.id)?.output ?? '') === scoreOf(s.output)));
  const coverage: Record<string, number> = {};
  for (const s of first) coverage[/^(\w+)/.exec(s.observed)?.[1] ?? '?'] = (coverage[/^(\w+)/.exec(s.observed)?.[1] ?? '?'] ?? 0) + 1;

  // ================================================================ the shared world for attacks, tampering and timing
  log('building a disposable organization for the attack, tampering and timing experiments…');
  const f: Fixture = await setupOrganization();
  try {
    await generateKeyProfile({ name: 'runner', keysDir: f.keysDir, now: NOW });
    for (const name of ['carol', 'frank']) await generateKeyProfile({ name, keysDir: f.keysDir, now: NOW });
    await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'carol', pubkeyFile: join(f.keysDir, 'carol.pub.json'), roles: ['l4'], days: 1, now: NOW });
    // frank holds L4, but the administrator narrowed his grant to code.modify (permissionScope)
    await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'frank', pubkeyFile: join(f.keysDir, 'frank.pub.json'), roles: ['l4'], days: 30, permissionScope: ['code.modify'], now: NOW });
    const input = writeEvidence(f.repo, NOW);
    const pin = trustRootFingerprint(readFileSync(join(f.authorityDir, 'trust-root.json')));
    let n = 0;
    const base = (over: Partial<StrictAssessOptions> = {}): StrictAssessOptions => ({
      dir: f.authorityDir, trustRootSha256: pin, asKey: 'alice', keysDir: f.keysDir, storeKey: 'store', storeDir: join(f.root, `eval-store-${++n}`), action: 'deployment', environment: 'production', target: 'my-app',
      repo: f.repo, inputFile: input, now: () => NOW, interpreter: noInterpretation, ...over,
    });
    const run = (over: Partial<StrictAssessOptions> = {}): Promise<StrictAssessResult> => runStrictAssessment(base(over));
    const runner = await loadPrivateKey({ name: 'runner', keysDir: f.keysDir, platform: 'win32' });
    const trusted: TrustedSigner = { publicKey: runner.publicKey, keyId: runner.keyId };
    const packStatusOf = (r: StrictAssessResult): string => buildEvidencePack(r).authorization.status;
    const firstReasonOf = (r: StrictAssessResult): string => r.summary.reasons[0] ?? '(no reason recorded)';

    // ================================================================ B. authorization enforcement: attacks + controls
    log('authorization: running the attack suite…');
    const malloryK = await loadPrivateKey({ name: 'mallory', keysDir: f.keysDir, platform: 'win32' });
    const storeK = await loadPrivateKey({ name: 'store', keysDir: f.keysDir, platform: 'win32' });
    const dir = (name: string): string => join(f.root, name);
    const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64url');
    const edit = (file: string, to: string, change: (d: Record<string, unknown>) => void): string => {
      const env = JSON.parse(readFileSync(file, 'utf-8'));
      const d = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
      change(d);
      env.payload = b64(JSON.stringify(d));
      writeFileSync(to, JSON.stringify(env));
      return to;
    };
    const attackResults: Array<{ id: string; category: AttackCase['category']; description: string; result: StrictAssessResult }> = [];
    const attack = async (id: string, category: AttackCase['category'], description: string, over: Partial<StrictAssessOptions>): Promise<void> => {
      attackResults.push({ id, category, description, result: await run(over) });
    };

    await attack('A01', 'authorization', 'developer without the production permission', { asKey: 'bob' });
    await attack('A02', 'authorization', 'L4 grant narrowed (permissionScope) to code.modify, attempting a production deployment', { asKey: 'frank' });
    await attack('A03', 'tampering', 'developer grant edited by the developer (level raised, longer expiry)', { asKey: 'bob', grantFile: edit(f.grants.bob.file, dir('a03.json'), (d) => { d.roles = ['l5']; d.expiresAt = '2035-01-01T00:00:00Z'; }) });
    await attack('A04', 'tampering', 'grant for alice re-signed by a key that is not an administrator key (forged administrator signature)', { grantFile: (() => { const e = JSON.parse(readFileSync(f.grants.alice.file, 'utf-8')); const p = dir('a04.json'); writeFileSync(p, JSON.stringify(signEnvelope({ domain: 'grant', payload: Buffer.from(e.payload, 'base64url'), privateKey: malloryK.privateKey }))); return p; })() });
    await attack('A05', 'tampering', 'grant for alice signed by the challenge-store key (a trusted key, but not for grants)', { grantFile: (() => { const e = JSON.parse(readFileSync(f.grants.alice.file, 'utf-8')); const p = dir('a05.json'); writeFileSync(p, JSON.stringify(signEnvelope({ domain: 'grant', payload: Buffer.from(e.payload, 'base64url'), privateKey: storeK.privateKey }))); return p; })() });
    {
      const copy = dir('authority-revoked');
      copyDir(f.authorityDir, copy);
      await revokeGrants({ dir: copy, adminKey: 'admin', keysDir: f.keysDir, grantIds: [f.grants.alice.grantId], now: NOW });
      await attack('A06', 'authorization', 'developer whose grant was revoked', { dir: copy });
    }
    await attack('A07', 'authorization', 'developer whose grant has expired (clock two days after a 1-day grant)', { asKey: 'carol', action: 'code_change', environment: 'development', now: () => later(2) });
    {
      const claims = writeEvidence(f.repo, NOW, { claims: true });
      await attack('A08', 'authorization', 'JSON file claiming roles, authorization and disabled gates', { asKey: 'bob', inputFile: claims });
      writeEvidence(f.repo, NOW);
    }
    await attack('A09', 'authorization', "a different person's private key presented for alice's grant", { asKey: 'bob', subject: 'alice', grantFile: f.grants.alice.file });
    await attack('A10', 'trust anchor', 'wrong pinned trust-root fingerprint', { trustRootSha256: 'a'.repeat(64) });
    {
      const evilKeys = dir('evil-keys');
      await generateKeyProfile({ name: 'evil-admin', keysDir: evilKeys, now: NOW });
      await generateKeyProfile({ name: 'store', keysDir: evilKeys, now: NOW });
      const { initOrganization } = await import('./admin.js');
      await initOrganization({ organization: 'acme', dir: dir('evil-authority'), adminKey: 'evil-admin', storeKey: 'store', keysDir: evilKeys, now: NOW });
      await attack('A11', 'trust anchor', "the whole authority directory replaced by an attacker's own organization", { dir: dir('evil-authority') });
    }
    {
      const copy = dir('authority-policy-edited');
      copyDir(f.authorityDir, copy);
      edit(join(copy, 'policy.signed.json'), join(copy, 'policy.signed.json'), (d) => { d.rules = (d.rules as Array<Record<string, unknown>>).map((r) => ({ ...r, allowedRoles: ['l1', 'l2', 'l3', 'l4', 'l5'] })); });
      await attack('A12', 'tampering', 'signed policy edited to let every role deploy to production', { dir: copy, asKey: 'bob' });
    }
    {
      const moved = dir('repo-changed-late');
      copyDir(f.repo, moved);
      await attack('A13', 'two-phase', 'Git commit changes between authorization and finalization', { repo: moved, testHooks: { beforeFinalization: () => commitChange(moved) } });
    }
    {
      const storeDir = join(f.root, `eval-store-fail-${++n}`);
      await attack('A14', 'two-phase', 'the challenge store loses the challenge before consumption', { storeDir, testHooks: { beforeFinalization: () => { for (const x of readdirSync(join(storeDir, 'issuance'))) rmSync(join(storeDir, 'issuance', x)); } } });
    }
    await attack('A15', 'authorization', 'a key with no administrator-signed grant at all', { asKey: 'mallory' });
    // a role is not a bypass: an authorized release engineer is still stopped by the mandatory gates and the score
    await attack('A16', 'safety bypass', 'authorized release engineer with no build/test report (mandatory gate fails)', { inputFile: writeEvidence(f.repo, NOW, { buildTests: false }) });
    await attack('A17', 'safety bypass', 'authorized release engineer with a very large stated blast radius (intermediate Safety Score)', { inputFile: writeEvidence(f.repo, NOW, { extra: { action: { impact: 'high', irreversible: false, blastRadius: { criticality: 'critical', scope: 'database_wide', sharedModulesModified: 8, dependencyReach: 40, affectedServiceCount: 12 } } } }) });
    writeEvidence(f.repo, NOW);

    // positive controls: the same machinery does ALLOW legitimate actions
    const controls = [await run({ asKey: 'bob', action: 'code_change', environment: 'development' }), await run()];
    const specific = (reasons: readonly string[]): boolean => reasons.some((x) => /\[(?!not_attempted\])[A-Za-z_]+\]/.test(x) && !x.startsWith('Safety'));
    const attacks: AttackCase[] = attackResults.map((a) => ({
      id: a.id, category: a.category, description: a.description, decision: a.result.decision, exitCode: a.result.exitCode, allowed: a.result.decision === 'ALLOW', firstReason: firstReasonOf(a.result),
      reasons: a.result.summary.reasons.slice(0, 8), specificCauseNamed: specific(a.result.summary.reasons), evidencePackAuthorizationStatus: packStatusOf(a.result),
    }));

    // ================================================================ C. Evidence Pack integrity
    log('evidence integrity: tampering with a genuine pack…');
    const genuine = createEvidencePackFile(buildEvidencePack(controls[1] as StrictAssessResult), runner.privateKey);
    const genuineVerifies = verifyEvidencePack(JSON.stringify(genuine), trusted).result === 'VALID';
    const asRecord = (file: typeof genuine) => JSON.parse(Buffer.from(file.envelope.payload, 'base64url').toString('utf-8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cases: TamperCase[] = [];
    const record = (id: string, v: ReturnType<typeof verifyEvidencePack>): void => {
      cases.push({ id, detected: v.result === 'INVALID', signature: v.signature, signer: v.signer, payloadIntegrity: v.payloadIntegrity, reason: v.reason ?? '' });
    };
    const mutations: Array<[string, (d: Record<string, any>) => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ['decision', (d) => { d.safety.decision = 'BLOCK'; }],
      ['safety score', (d) => { d.safety.score = 0.99; }],
      ['a gate result', (d) => { d.safety.gates[0].status = 'FAIL'; }],
      ['Git commit', (d) => { d.action.commit = 'f'.repeat(40); }],
      ['content digest', (d) => { d.action.contentDigest = `sha256:${'e'.repeat(64)}`; }],
      ['developer identity', (d) => { d.developer.subjectId = 'lead1'; }],
      ['grant id', (d) => { d.developer.grantId = 'grant-other'; }],
      ['gate list', (d) => { d.safety.gates.pop(); }],
      ['timestamp', (d) => { d.assessedAt = '2030-01-01T00:00:00.000Z'; }],
      ['assessment id', (d) => { d.assessmentId = 'AAAAAAAAAAAAAAAAAAAAAA'; }],
    ];
    for (const [label, change] of mutations) {
      const doc = asRecord(genuine);
      change(doc);
      record(`signed ${label} ${TAMPER_NOTE}`, verifyEvidencePack(JSON.stringify({ ...genuine, envelope: { ...genuine.envelope, payload: b64(JSON.stringify(doc)) } }), trusted));
      const copy = JSON.parse(JSON.stringify(genuine.readable));
      change(copy);
      record(`readable copy of ${label} edited`, verifyEvidencePack(JSON.stringify({ ...genuine, readable: copy }), trusted));
    }
    record('signature bit flipped', verifyEvidencePack(JSON.stringify({ ...genuine, envelope: { ...genuine.envelope, signature: genuine.envelope.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } }), trusted));
    record('signature removed', verifyEvidencePack(JSON.stringify({ ...genuine, envelope: { ...genuine.envelope, signature: '' } }), trusted));
    record('version 1 pack (five gates and approvals) is not reinterpreted', verifyEvidencePack(JSON.stringify({ ...genuine, version: 1 }), trusted));
    record('unknown future version', verifyEvidencePack(JSON.stringify({ ...genuine, version: 3 }), trusted));
    record('not JSON', verifyEvidencePack('this is not an evidence pack', trusted));
    const byStranger = createEvidencePackFile(buildEvidencePack(controls[1] as StrictAssessResult), malloryK.privateKey);
    const strangerResult = verifyEvidencePack(JSON.stringify(byStranger), trusted);
    record('signed by an untrusted key', strangerResult);
    record('signed with a different grant-domain signature', verifyEvidencePack(JSON.stringify({ ...genuine, envelope: signEnvelope({ domain: 'grant', payload: Buffer.from(genuine.envelope.payload, 'base64url'), privateKey: runner.privateKey }) }), trusted));
    // a record that still names the removed Human Approval gate, signed by the trusted key itself, is refused by the schema
    {
      const old = JSON.parse(JSON.stringify(asRecord(genuine)));
      old.safety.gates = [...old.safety.gates, { gate: 'HUMAN_APPROVAL', status: 'PASS', consequence: 'BLOCK' }];
      record('trusted key signs a record that still lists the Human Approval gate', verifyEvidencePack(JSON.stringify({ format: genuine.format, version: 2, envelope: signEnvelope({ domain: 'evidence_pack', payload: Buffer.from(JSON.stringify(old)), privateKey: runner.privateKey }), readable: old }), trusted));
    }
    // a consistent-looking but false claim signed by the trusted key itself is refused by the consistency rules
    const lie = asRecord(genuine) as unknown as EvidencePackDocument;
    const lieDoc = JSON.parse(JSON.stringify(lie));
    lieDoc.authorization.status = 'VERIFIED_NOT_FINALIZED';
    record('trusted key signs an ALLOW without finalized authorization', verifyEvidencePack(JSON.stringify({ format: genuine.format, version: 2, envelope: signEnvelope({ domain: 'evidence_pack', payload: Buffer.from(JSON.stringify(lieDoc)), privateKey: runner.privateKey }), readable: lieDoc }), trusted));

    // ================================================================ D. performance
    log(`performance: ${timingRuns} timed run(s) per operation (plus one discarded warm-up each)…`);
    const timeCli = async (argvFor: (i: number) => string[], count: number): Promise<number[]> => {
      const samples: number[] = [];
      for (let i = -1; i < count; i++) {
        const out: string[] = [];
        const t0 = performance.now();
        const code = await runStrictCli(argvFor(i), { out: (l) => out.push(l), err: () => undefined, now: () => NOW, hooks: { interpreter: noInterpretation } });
        const dt = performance.now() - t0;
        if (code !== 0) throw new Error(`timed command exited ${code}`);
        if (i >= 0) samples.push(dt); // the first run (i = -1) is a warm-up and is discarded
      }
      return samples;
    };
    const assessArgv = (action: string, environment: string, extra: string[] = []) => (i: number): string[] => [
      'assess', '--strict', '--dir', f.authorityDir, '--trust-root-sha256', pin, '--keys-dir', f.keysDir, '--store-dir', join(f.root, `timing-store-${action}-${environment}-${extra.length}-${i}`), '--repo', f.repo, '--input', input,
      '--as', 'alice', '--action', action, '--environment', environment, '--target', 'my-app', ...extra,
    ];
    const devSamples = await timeCli(assessArgv('code_change', 'development'), timingRuns);
    const prodSamples = await timeCli(assessArgv('deployment', 'production'), timingRuns);
    const packPath = dir('timing-pack.json');
    const packSamples = await timeCli(assessArgv('deployment', 'production', ['--evidence-pack', packPath, '--evidence-key', 'runner', '--overwrite-evidence-pack']), timingRuns);
    const gitSamples: number[] = [];
    const evidenceSamples: number[] = [];
    for (let i = -1; i < timingRuns; i++) {
      const g0 = performance.now();
      await collectActionContext({ repositoryPath: f.repo, metadata: { actionId: 'pending', actionType: 'deployment', environment: 'production', target: 'my-app' } });
      const g1 = performance.now();
      const request = await loadAssessmentRequest({ action: 'deployment', target: 'production', input }, f.repo);
      await collectEvidence({ cwd: f.repo, request, now: NOW.toISOString() });
      const g2 = performance.now();
      if (i >= 0) { gitSamples.push(g1 - g0); evidenceSamples.push(g2 - g1); }
    }
    const verifySamples = await timeCli(() => ['verify', '--evidence-pack', packPath, '--trusted-key', join(f.keysDir, 'runner.pub.json')], Math.max(timingRuns * 3, 10));

    // ================================================================ E. explainability
    log('explainability: examining every BLOCK and ESCALATE report…');
    const assessScenarios = first.filter((s) => s.id < 13);
    const nonAllow = assessScenarios.filter((s) => !s.observed.startsWith('ALLOW'));
    const expectedKind = (id: number): 'authorization failure' | 'safety failure' => (id === 11 || id === 12 ? 'safety failure' : 'authorization failure');
    const explainCases = nonAllow.map((s) => {
      const lines = s.output.split('\n');
      const i = lines.findIndex((l) => l.startsWith('Reasons:'));
      const bullets: string[] = [];
      if (i >= 0) for (const l of lines.slice(i + 1)) { if (l.trim() === '') break; if (l.trim().startsWith('- ')) bullets.push(l.trim().slice(2)); }
      const state = /Authorization state:\s+(\S+(?: \S+)?)/.exec(s.output)?.[1] ?? '?';
      const kind: 'authorization failure' | 'safety failure' = state.startsWith('BLOCKED') ? 'authorization failure' : 'safety failure';
      const band = /score-only band: (\w+)/.test(s.output);
      const hasReason = bullets.length > 0 || (kind === 'safety failure' && band);
      return { id: s.id, decision: /^(\w+)/.exec(s.observed)?.[1] ?? '?', kind, authorizationState: state, hasReason, firstReason: bullets[0] ?? s.reason };
    });
    // a failed gate and a low score, as Evidence Packs: the pack must say "verified, not finalized", never "finalized"
    const gateFail = await run({ action: 'code_change', environment: 'development', inputFile: writeEvidence(f.repo, NOW, { buildTests: false }) });
    const lowScore = await run({ action: 'code_change', environment: 'development', inputFile: writeEvidence(f.repo, NOW, { extra: { action: { impact: 'high', irreversible: false, blastRadius: { criticality: 'critical', scope: 'database_wide', sharedModulesModified: 8, dependencyReach: 40, affectedServiceCount: 12 } } } }) });
    writeEvidence(f.repo, NOW);
    const packStatuses: Record<string, number> = {};
    for (const r of [...attackResults.map((a) => a.result), gateFail, lowScore]) {
      const status = packStatusOf(r);
      packStatuses[status] = (packStatuses[status] ?? 0) + 1;
    }

    const cpus = os.cpus();
    return {
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: cpus[0]?.model ?? 'unknown', cores: cpus.length, memoryGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10 },
      methodology: {
        demoRepetitions: reps,
        timingRuns,
        warmUpRunsDiscarded: 1,
        clock: 'fixed for decisions (reproducible); wall-clock performance.now() for durations',
        interpretation: 'local-model interpretation disabled (advisory, not part of authorization); no network or model is used',
      },
      functional: {
        repetitions: reps,
        scenarioCount: first.length,
        correctPerRepetition: demos.map((d) => d.filter((s) => s.ok).length),
        decisionCoverage: coverage,
        consistentAcrossRepetitions: consistent,
        scenarios: first.map((s) => ({ id: s.id, title: s.title, expected: s.expected, observed: s.observed, ok: s.ok, safetyScore: scoreOf(s.output) })),
      },
      authorization: {
        attackCount: attacks.length,
        attacksAllowed: attacks.filter((a) => a.allowed).length,
        controlCount: controls.length,
        controlsAllowed: controls.filter((c) => c.decision === 'ALLOW').length,
        attacks,
      },
      evidenceIntegrity: {
        genuineVerifies,
        tamperCount: cases.length,
        tamperDetected: cases.filter((c) => c.detected).length,
        untrustedSignerRejected: strangerResult.result === 'INVALID' && strangerResult.signer === 'UNTRUSTED',
        cases,
      },
      performance: { unit: 'milliseconds', developmentAssessment: stats(devSamples), productionAssessment: stats(prodSamples), productionAssessmentWithEvidencePack: stats(packSamples), evidencePackVerification: stats(verifySamples), partGitContextCollection: stats(gitSamples), partEvidenceCollection: stats(evidenceSamples) },
      explainability: {
        nonAllowCount: explainCases.length,
        withMeaningfulReason: explainCases.filter((c) => c.hasReason).length,
        authorizationFailures: explainCases.filter((c) => c.kind === 'authorization failure').length,
        safetyFailures: explainCases.filter((c) => c.kind === 'safety failure').length,
        classifiedCorrectly: explainCases.filter((c) => c.kind === expectedKind(c.id)).length,
        evidencePackStatusCounts: packStatuses,
        attackReportsNamingSpecificCause: attacks.filter((a) => a.specificCauseNamed).length,
        attackReportCount: attacks.length,
        cases: explainCases,
      },
      limitations: [
        'small, hand-designed scenario set: it shows the implementation matches its design on these cases, not that no other case exists',
        'timings come from one machine, a fixed clock and a local disk; they include process-internal work only, not a separately started program',
        'the sample is small: no claim of statistical significance is made',
        'the attacker model is a developer who can edit files and run the tool; an attacker who can modify the executable, the pin or the operating system is out of scope',
        'the challenge store is in-process, so replay protection is local',
        'safety weights and thresholds are provisional research values',
        'authorization decisions are not compared with a human gold standard; "correct" means "as designed"',
      ],
    };
  } finally {
    f.cleanup();
  }
}

// ---------------------------------------------------------------- a short human-readable summary

export function summarize(r: EvaluationResult): string[] {
  const p = r.performance;
  const line = (label: string, s: Stats): string => `  ${label.padEnd(42)} n=${s.n}  mean ${s.meanMs} ms  sd ${s.stdDevMs}  min ${s.minMs}  median ${s.medianMs}  max ${s.maxMs}`;
  return [
    'CODEXREV FEATURE 4 — EVALUATION SUMMARY',
    `  generated ${r.generatedAt} on ${r.environment.platform}, Node ${r.environment.node}, ${r.environment.cores} cores`,
    '',
    `A. Functional: ${r.functional.correctPerRepetition.join('/')} of ${r.functional.scenarioCount} scenarios correct per repetition (${r.functional.repetitions} repetitions); coverage ${JSON.stringify(r.functional.decisionCoverage)}; identical across repetitions: ${r.functional.consistentAcrossRepetitions}`,
    `B. Authorization: ${r.authorization.attacksAllowed} of ${r.authorization.attackCount} attack attempts reached ALLOW; ${r.authorization.controlsAllowed} of ${r.authorization.controlCount} legitimate controls were ALLOWed`,
    `C. Evidence integrity: genuine pack verifies: ${r.evidenceIntegrity.genuineVerifies}; ${r.evidenceIntegrity.tamperDetected} of ${r.evidenceIntegrity.tamperCount} tampered/invalid packs detected; untrusted signer rejected: ${r.evidenceIntegrity.untrustedSignerRejected}`,
    'D. Performance (milliseconds, one warm-up run discarded):',
    line('strict development assessment', p.developmentAssessment),
    line('strict production assessment', p.productionAssessment),
    line('production assessment + signed Evidence Pack', p.productionAssessmentWithEvidencePack),
    line('offline Evidence Pack verification', p.evidencePackVerification),
    line('  part: Git action-context collection (1 of 2)', p.partGitContextCollection),
    line('  part: evidence collection', p.partEvidenceCollection),
    `E. Explainability: ${r.explainability.withMeaningfulReason} of ${r.explainability.nonAllowCount} BLOCK/ESCALATE reports carry a reason; ${r.explainability.attackReportsNamingSpecificCause} of ${r.explainability.attackReportCount} attack reports name the specific cause; ${r.explainability.classifiedCorrectly} of ${r.explainability.nonAllowCount} correctly separate authorization failures (${r.explainability.authorizationFailures}) from safety failures (${r.explainability.safetyFailures}); pack authorization statuses ${JSON.stringify(r.explainability.evidencePackStatusCounts)}`,
  ];
}

