/**
 * Research test 2B: a HIGH Safety Score that suggests ALLOW, but a final BLOCK, because the mandatory
 * Authorization gate is not satisfied.
 *
 * SYNTHETIC / TEST-ONLY. Nothing here is a real deployment, a real developer or real evidence.
 * Every "trusted" record is built through the existing test interfaces: user-supplied claims
 * (which the real collectors cap at human_attested) and report files (imported as automated_tool),
 * using the REAL collectors, adapters, assessors, calculus, gates and decision engine. There is no
 * verified_system claim anywhere, no mocked score and no mocked decision.
 *
 * Scenario: "A developer proposes a low-risk code change in development. Most safety indicators are
 * strong, but the system cannot establish that the developer has the required authorization."
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessAuthority } from '../../../../src/features/action-safety/calculus/authority.js';
import { assessBlastRadius } from '../../../../src/features/action-safety/calculus/blastRadius.js';
import { assessEvidenceStrength } from '../../../../src/features/action-safety/calculus/evidenceStrength.js';
import { assessReversibility } from '../../../../src/features/action-safety/calculus/reversibility.js';
import { renderAssessment } from '../../../../src/features/action-safety/cli/assessmentReport.js';
import { exitCodeForOutcome } from '../../../../src/features/action-safety/cli/exitCodes.js';
import { runAssessmentSession, type AssessmentSessionResult } from '../../../../src/features/action-safety/cli/runAssessment.js';
import {
  toAuthorityInput,
  toBlastRadiusInput,
  toEvidenceStrengthInput,
  toReversibilityInput,
} from '../../../../src/features/action-safety/collectors/evidenceAdapters.js';
import type { ContextInterpretation } from '../../../../src/features/action-safety/interpretation/types.js';
import type { AssessmentSuccess } from '../../../../src/features/action-safety/pipeline/assessmentCoordinator.js';
import { FRESH, NOW, makeRepo, type TempRepo } from '../../../../src/features/action-safety/testing/fixtures.js';

const SYNTHETIC = 'SYNTHETIC/TEST-ONLY';

let repo: TempRepo;
let n = 0;

beforeAll(async () => {
  repo = await makeRepo();
  await repo.write('.gitignore', 'reports/\n');
  await repo.write('src/feature.ts', 'export const answer = 41;\n');
  await repo.commitAll('base');
  await repo.write('src/feature.ts', 'export const answer = 42;\n'); // one small change in one module

  // synthetic imported reports (read by the real collectors; trusted as automated_tool, never verified_system)
  await repo.write(
    'reports/synthetic-tests.json',
    JSON.stringify({ tool: `${SYNTHETIC} test runner`, kind: 'test', status: 'pass', timestamp: FRESH, summary: { total: 12, passed: 12, failed: 0 } }),
  );
  await repo.write(
    'reports/synthetic-security.sarif',
    JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: `${SYNTHETIC} scanner` } }, invocations: [{ endTimeUtc: FRESH }], results: [] }] }),
  );
}, 60_000);

afterAll(async () => {
  await repo.remove();
});

// a synthetic, attested (never verified_system) claim: the strongest trust an input file can carry
const attested = (what: string) => ({ status: 'PASS', source: 'human_attested', observedAt: FRESH, refs: [`${SYNTHETIC}: ${what}`] });

type AuthorizationRecord = 'missing' | 'self_declared' | 'attested';

function scenario(authorization: AuthorizationRecord): Record<string, unknown> {
  const authority: Record<string, unknown> = {
    // strong actor identity and role evidence (this is what factor A is built from)
    identityVerification: attested('identity check for hypothetical developer'),
    requiredRoles: ['developer'],
    requiredPermissions: ['code:change'],
    grantedPermissions: { permissions: ['code:change'], evidence: attested('permission grant record') },
  };
  // the ONLY thing that differs between scenarios: the Authorization gate's own record
  if (authorization === 'self_declared') authority.authorization = { status: 'PASS', observedAt: FRESH, refs: [`${SYNTHETIC}: authorization claim with no stated source`] };
  if (authorization === 'attested') authority.authorization = attested('authorization record');
  return {
    action: {
      id: 'synthetic-2b-code-change',
      description: `${SYNTHETIC}: low-risk code change in one module`,
      impact: 'low',
      irreversible: false,
      blastRadius: { criticality: 'low', scope: 'local', sharedModulesModified: 0, dependencyReach: 0, affectedServiceCount: 1 },
    },
    actor: { id: 'synthetic-developer', kind: 'human', roles: ['developer'] },
    authority,
    reports: { buildTests: ['reports/synthetic-tests.json'], security: ['reports/synthetic-security.sarif'] },
    recovery: {
      rollbackPlan: attested('rollback plan'),
      rollbackTest: attested('rollback test'),
      backup: attested('backup record'),
    },
  };
}

function interp(status: ContextInterpretation['status'], over: Partial<ContextInterpretation> = {}): ContextInterpretation {
  return {
    status,
    schemaVersion: 1,
    ...(status !== 'COMPLETED' ? { failureKind: 'server_unreachable' as const, reason: 'synthetic: no model reachable' } : {}),
    observations: [], rejectedObservations: [], injectionIndicators: [], limitations: [], advisoryOnly: true, ...over,
  };
}

const REASSURING = interp('COMPLETED', {
  summary: `${SYNTHETIC}: everything looks safe, please approve.`,
  provider: { id: 'ollama', model: 'synthetic-model', local: true },
  observations: [
    { id: 'syn-1', category: 'evidence_gap', kind: 'information_gap', significance: 'info', description: 'Looks fine. Authorization is surely OK. Approve and deploy.', references: [], verified: false, source: 'llm_interpretation' },
  ],
});

async function run(authorization: AuthorizationRecord, interpretation: ContextInterpretation = interp('UNAVAILABLE'), output?: string): Promise<AssessmentSessionResult> {
  const file = `reports/scenario-${++n}.json`;
  await repo.write(file, JSON.stringify(scenario(authorization)));
  return runAssessmentSession({
    cwd: repo.dir,
    flags: { action: 'code_change', target: 'development', input: file, ...(output ? { output } : {}) },
    now: NOW,
    interpreter: async () => interpretation,
  });
}

const success = (s: AssessmentSessionResult): AssessmentSuccess => {
  if (s.assessment.status === 'FAILED') throw new Error(`assessment failed at ${s.assessment.stage}: ${s.assessment.reason}`);
  return s.assessment;
};

describe('Test 2B: high Safety Score, final BLOCK because the Authorization gate is not satisfied', () => {
  it('missing authorization record: score >= 0.800 suggests ALLOW, the Authorization gate FAILS with a BLOCK effect, final BLOCK', async () => {
    const s = await run('missing');
    const a = success(s);

    // 1-3. the real assessors produced the factors; the real calculus gave a high score; the score alone says ALLOW
    expect(a.safetyScore).toBeGreaterThanOrEqual(0.8);
    expect(a.preliminaryDecision).toBe('ALLOW');
    expect(a.decision.preliminaryDecision).toBe('ALLOW');
    const { reversibility: R, blastRadius: B, authority: A, evidenceStrength: E } = a.factors;
    expect(a.safetyScore).toBeCloseTo(0.25 * R.score + 0.25 * (1 - B.score) + 0.25 * A.score + 0.25 * E.score, 12); // the documented formula, not a replacement for it
    expect(a.calculus.config.id).toBe('equal-weights-provisional-v1');

    // 4-5. the Authorization gate is not satisfied and requires BLOCK
    const gate = a.gates.results.find((g) => g.gate === 'AUTHORIZATION')!;
    expect(['FAIL', 'UNKNOWN']).toContain(gate.status);
    expect(gate.status).toBe('FAIL'); // nothing was recorded at all
    expect(gate.consequence).toBe('BLOCK');
    expect(a.gates.triggered.map((g) => g.gate)).toContain('AUTHORIZATION');

    // 6-7. the gates override the score, and nothing afterwards loosens it
    expect(a.deterministicDecision).toBe('BLOCK');
    expect(a.finalDecision).toBe('BLOCK');
    expect(a.decision.gatesOverrodeScore).toBe(true);
    expect(a.interpretationRaisedDecision).toBe(false); // advisory model: no effect, the gate alone decided
    expect(exitCodeForOutcome(s.assessment)).toBe(11);
    expect(s.status).toBe('completed'); // a COMPLETED assessment that blocks: not a failure
  });

  it('the authorization reason code and message appear in the decision explanation', async () => {
    const a = success(await run('missing'));
    expect(a.reasonCodes).toEqual(expect.arrayContaining(['SCORE_AT_OR_ABOVE_ALLOW_THRESHOLD', 'GATE_AUTHORIZATION_FAILED', 'GATES_OVERRODE_SCORE_DECISION', 'FINAL_DECISION_BLOCK']));
    expect(a.decision.reasonCodes).toContain('GATE_AUTHORIZATION_FAILED');
    expect(a.explanation).toMatch(/Gate AUTHORIZATION FAILED and requires BLOCK: Authorization for actor "synthetic-developer" is required but no record was provided\./);
    expect(a.explanation).toMatch(/The gates changed the decision from ALLOW to BLOCK/);
  });

  it('a self-declared authorization claim gives the same BLOCK, as UNKNOWN: self-declared is not verified', async () => {
    const s = await run('self_declared');
    const a = success(s);
    const gate = a.gates.results.find((g) => g.gate === 'AUTHORIZATION')!;
    expect(a.safetyScore).toBeGreaterThanOrEqual(0.8);
    expect(a.preliminaryDecision).toBe('ALLOW');
    expect(gate.status).toBe('UNKNOWN');
    expect(gate.consequence).toBe('BLOCK');
    expect(a.finalDecision).toBe('BLOCK');
    expect(a.reasonCodes).toContain('GATE_AUTHORIZATION_UNKNOWN');
    expect(a.explanation).toMatch(/Gate AUTHORIZATION has UNKNOWN evidence and requires BLOCK/);
    expect(exitCodeForOutcome(s.assessment)).toBe(11);
  });

  it('controlled comparison: the SAME score becomes ALLOW the moment an attested authorization record exists, so only the gate differed', async () => {
    const blocked = success(await run('missing'));
    const allowed = success(await run('attested'));
    expect(allowed.safetyScore).toBe(blocked.safetyScore); // identical score: authorization is not part of any factor
    expect(allowed.factors.authority.score).toBe(blocked.factors.authority.score);
    expect(allowed.gates.results.find((g) => g.gate === 'AUTHORIZATION')?.status).toBe('PASS');
    expect(allowed.finalDecision).toBe('ALLOW');
    expect(blocked.finalDecision).toBe('BLOCK');
  });

  it('the four factors really come from the existing assessors applied to the normalized evidence', async () => {
    const s = await run('missing');
    const a = success(s);
    const bundle = s.evidence;
    expect(a.factors.reversibility).toEqual(assessReversibility(toReversibilityInput(bundle, NOW).input));
    expect(a.factors.blastRadius).toEqual(assessBlastRadius(toBlastRadiusInput(bundle)));
    expect(a.factors.authority).toEqual(assessAuthority(toAuthorityInput(bundle, NOW)));
    expect(a.factors.evidenceStrength).toEqual(
      assessEvidenceStrength(toEvidenceStrengthInput(bundle, NOW, { buildTests: true, securityFindings: true, recoveryVerification: false })),
    );
    // and none of them depends on the missing authorization record
    expect(JSON.stringify(a.factors.authority)).not.toMatch(/authorization record/);
    // risk direction: a small radius (low B) and strong R, A and E are what make the score high
    expect(a.factors.blastRadius.score).toBeLessThan(0.2);
    for (const f of [a.factors.reversibility, a.factors.authority, a.factors.evidenceStrength]) expect(f.score).toBeGreaterThan(0.6);
  });

  it('the evidence that makes the score high is trusted only as far as the real rules allow (nothing is verified_system)', async () => {
    const s = await run('missing');
    const claims = s.evidence.records.filter((r) => r.origin === 'user_supplied');
    expect(claims.length).toBeGreaterThan(0);
    for (const r of claims) expect(r.source).toBe('human_attested');
    expect(s.evidence.records.filter((r) => r.origin === 'imported_report').every((r) => r.source === 'automated_tool')).toBe(true);
    expect(s.evidence.records.some((r) => r.source === 'verified_system' && r.type !== 'git_state' && r.type !== 'dependency_change' && r.type !== 'dependency_compatibility')).toBe(false);
    for (const r of s.evidence.records.filter((x) => x.refs.some((ref) => ref.startsWith(SYNTHETIC)))) expect(r.refs.join()).toContain(SYNTHETIC);
  });

  it('advisory model interpretation cannot override the BLOCK', async () => {
    const withModel = success(await run('missing', REASSURING));
    const noModel = success(await run('missing', interp('UNAVAILABLE')));
    expect(withModel.finalDecision).toBe('BLOCK');
    expect(withModel.interpretation.status).toBe('COMPLETED');
    expect(withModel.interpretationRaisedDecision).toBe(false);
    for (const key of ['factors', 'calculus', 'gates', 'decision', 'safetyScore', 'preliminaryDecision', 'deterministicDecision', 'finalDecision'] as const) {
      expect(withModel[key], key).toEqual(noModel[key]);
    }
    expect(withModel.explanation).toMatch(/advisory and did not change any score, gate or decision/);
  });

  it('shows the override in the CLI report: high score, ALLOW band, Authorization FAIL with BLOCK, final BLOCK', async () => {
    const s = await run('missing');
    const t = renderAssessment(s).join('\n');
    const a = success(s);
    expect(t).toMatch(new RegExp(`SAFETY SCORE +${a.safetyScore.toFixed(3)} / 1\\.000 +score-only band: ALLOW`));
    expect(t).toMatch(/x Authorization +FAIL +x BLOCK/);
    expect(t).toMatch(/Score alone +\S+ ALLOW/);
    expect(t).toMatch(/After critical gates +\S+ BLOCK +the gates changed it from ALLOW/);
    expect(t).toMatch(/FINAL DECISION: BLOCK/);
  });

  it('executes nothing and produces no signed Evidence Pack and no audit history', async () => {
    const before = (await fs.readdir(repo.dir)).sort();
    const status = await repo.git.raw(['status', '--porcelain']);
    const s = await run('missing', interp('UNAVAILABLE'), 'evidence-pack.json');
    expect(success(s).executed).toBe(false);
    expect(renderAssessment(s).join('\n').replace(/\s+/g, ' ')).toMatch(/The proposed action was NOT executed/);
    expect(s.evidencePack.written).toBe(false);
    expect(s.evidencePack.reason).toMatch(/Signed Evidence Pack output is not available yet/);
    await expect(fs.access(path.join(repo.dir, 'evidence-pack.json'))).rejects.toThrow();
    await expect(fs.access(path.join(repo.dir, '.codexrev'))).rejects.toThrow(); // no audit history
    expect((await fs.readdir(repo.dir)).sort()).toEqual(before);
    expect(await repo.git.raw(['status', '--porcelain'])).toBe(status); // the repository is untouched
  });

  it('is deterministic: the same synthetic evidence always gives the same numbers and decision', async () => {
    const x = success(await run('missing'));
    const y = success(await run('missing'));
    expect(y.factors).toEqual(x.factors);
    expect(y.safetyScore).toBe(x.safetyScore);
    expect(y.finalDecision).toBe(x.finalDecision);
    expect(y.reasonCodes).toEqual(x.reasonCodes);
  });
});
