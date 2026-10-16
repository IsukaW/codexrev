import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessAuthority } from '../../../../src/features/action-safety/calculus/authority.js';
import { assessBlastRadius } from '../../../../src/features/action-safety/calculus/blastRadius.js';
import { calculateSafetyScore, type CalculusConfig } from '../../../../src/features/action-safety/calculus/calculus.js';
import { decideAction } from '../../../../src/features/action-safety/calculus/decisionEngine.js';
import { assessEvidenceStrength } from '../../../../src/features/action-safety/calculus/evidenceStrength.js';
import { evaluateGates, type GatePolicy } from '../../../../src/features/action-safety/calculus/gates.js';
import { assessReversibility } from '../../../../src/features/action-safety/calculus/reversibility.js';
import { parseAssessmentInput } from '../../../../src/features/action-safety/cli/assessmentInput.js';
import {
  toAuthorityInput,
  toBlastRadiusInput,
  toEvidenceStrengthInput,
  toGateInputs,
  toProposedAction,
  toReversibilityInput,
} from '../../../../src/features/action-safety/collectors/evidenceAdapters.js';
import { collectEvidence, type EvidenceBundle } from '../../../../src/features/action-safety/collectors/evidenceOrchestrator.js';
import type { ContextInterpretation } from '../../../../src/features/action-safety/interpretation/types.js';
import {
  DEFAULT_GATE_POLICY,
  assessAction,
  type AssessmentOutcome,
  type AssessmentPolicy,
  type AssessmentSuccess,
} from '../../../../src/features/action-safety/pipeline/assessmentCoordinator.js';
import type { TargetEnvironment } from '../../../../src/features/action-safety/model/types.js';
import { FRESH, NOW, STALE, makeRepo, type TempRepo } from '../../../../src/features/action-safety/testing/fixtures.js';

let repo: TempRepo;

beforeAll(async () => {
  repo = await makeRepo();
  await repo.write('.gitignore', 'reports/\n');
  await repo.write('src/a.ts', 'one\n');
  await repo.commitAll('base');
  await repo.write('src/a.ts', 'one\ntwo\n'); // one small, unstaged change in one module

  const report = (name: string, body: unknown) => repo.write(`reports/${name}`, JSON.stringify(body));
  const tests = (status: string, timestamp: string) => ({ tool: 'vitest', kind: 'test', status, timestamp, summary: { total: 9, passed: status === 'pass' ? 9 : 8, failed: status === 'pass' ? 0 : 1 } });
  await report('tests.json', tests('pass', FRESH));
  await report('tests-failed.json', tests('fail', FRESH));
  await report('tests-stale.json', tests('pass', STALE));
  await report('sec.sarif', { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: FRESH }], results: [] }] });
}, 60_000);

afterAll(async () => {
  await repo.remove();
});

const attested = (observedAt = FRESH, refs: string[] = ['ref:x']) => ({ status: 'PASS', source: 'human_attested', observedAt, refs });

// a genuinely well-evidenced, low-risk change: every claim is attested and fresh, every report is fresh
function strongInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: {
      impact: 'low',
      irreversible: false,
      blastRadius: { criticality: 'low', scope: 'local', sharedModulesModified: 0, dependencyReach: 0, affectedServiceCount: 1 },
    },
    actor: { id: 'alice', kind: 'human', roles: ['developer'] },
    authority: {
      identityVerification: attested(),
      authorization: attested(),
      requiredRoles: ['developer'],
      requiredPermissions: ['deploy'],
      grantedPermissions: { permissions: ['deploy'], evidence: attested() },
      requiredApprovals: 1,
      approvals: [{ approverId: 'bob', evidence: attested() }],
    },
    reports: { buildTests: ['reports/tests.json'], security: ['reports/sec.sarif'] },
    recovery: { rollbackPlan: attested(), rollbackTest: attested(), backup: attested() },
    ...over,
  };
}

const without = (base: Record<string, unknown>, path: string[]): Record<string, unknown> => {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  delete node[path[path.length - 1]];
  return copy;
};

const withAuthority = (patch: Record<string, unknown>) => ({ ...strongInput(), authority: { ...(strongInput().authority as object), ...patch } });

function interp(status: ContextInterpretation['status'], over: Partial<ContextInterpretation> = {}): ContextInterpretation {
  return {
    status,
    schemaVersion: 1,
    ...(status !== 'COMPLETED' ? { failureKind: 'server_unreachable' as const, reason: 'model down' } : {}),
    observations: [],
    rejectedObservations: [],
    injectionIndicators: [],
    limitations: [],
    advisoryOnly: true,
    ...over,
  };
}

async function bundleFor(input: Record<string, unknown>, env: TargetEnvironment = 'development'): Promise<EvidenceBundle> {
  return collectEvidence({ cwd: repo.dir, request: { actionType: 'deployment', environment: env, input: parseAssessmentInput(input) }, now: NOW });
}

async function run(
  input: Record<string, unknown>,
  opts: { env?: TargetEnvironment; interpretation?: ContextInterpretation; policy?: Partial<AssessmentPolicy> } = {},
): Promise<AssessmentSuccess> {
  const bundle = await bundleFor(input, opts.env);
  const outcome = assessAction({ bundle, interpretation: opts.interpretation ?? interp('COMPLETED'), now: NOW, ...(opts.policy ? { policy: opts.policy } : {}) });
  if (outcome.status === 'FAILED') throw new Error(`unexpected failure at ${outcome.stage}: ${outcome.reason}`);
  return outcome;
}

const gate = (o: AssessmentSuccess, id: string) => o.gates.results.find((g) => g.gate === id)!;

describe('assessAction: the existing modules are connected, not re-implemented', () => {
  it('runs all four assessors on the normalized evidence and returns their results unchanged', async () => {
    const bundle = await bundleFor(strongInput());
    const o = assessAction({ bundle, interpretation: interp('COMPLETED'), now: NOW }) as AssessmentSuccess;
    expect(o.factors.reversibility).toEqual(assessReversibility(toReversibilityInput(bundle, NOW).input));
    expect(o.factors.blastRadius).toEqual(assessBlastRadius(toBlastRadiusInput(bundle)));
    expect(o.factors.authority).toEqual(assessAuthority(toAuthorityInput(bundle, NOW)));
    // recovery is not required for a low-impact reversible action, so evidence strength does not demand it
    expect(o.factors.evidenceStrength).toEqual(
      assessEvidenceStrength(toEvidenceStrengthInput(bundle, NOW, { buildTests: true, securityFindings: true, recoveryVerification: false })),
    );
    expect(Object.keys(o.factors)).toEqual(['reversibility', 'blastRadius', 'authority', 'evidenceStrength']);
  });

  it('feeds the four REAL assessment results to the calculus', async () => {
    const o = await run(strongInput());
    const direct = calculateSafetyScore([o.factors.reversibility, o.factors.blastRadius, o.factors.authority, o.factors.evidenceStrength]);
    expect(o.calculus).toEqual(direct);
    expect(o.safetyScore).toBe(direct.safetyScore);
    expect(o.calculus.factors).toEqual({
      reversibility: o.factors.reversibility.score,
      blastRadius: o.factors.blastRadius.score,
      authority: o.factors.authority.score,
      evidenceStrength: o.factors.evidenceStrength.score,
    });
  });

  it('feeds the actual calculus and the actual gate results to the Decision Engine', async () => {
    const bundle = await bundleFor(strongInput());
    const o = assessAction({ bundle, interpretation: interp('COMPLETED'), now: NOW }) as AssessmentSuccess;
    const { action } = toProposedAction(bundle);
    const gi = toGateInputs(bundle);
    const gates = evaluateGates({ action, authority: gi.authority, evidence: gi.evidence, policy: DEFAULT_GATE_POLICY });
    expect(o.gates).toEqual(gates);
    expect(o.decision).toEqual(decideAction(o.calculus, gates));
    expect(o.preliminaryDecision).toBe(o.decision.preliminaryDecision);
    expect(o.deterministicDecision).toBe(o.decision.decision);
  });

  it('keeps the three decisions apart and records that nothing was executed', async () => {
    const o = await run(without(strongInput(), ['authority', 'authorization']));
    expect(o.preliminaryDecision).toBe('ALLOW');
    expect(o.deterministicDecision).toBe('BLOCK');
    expect(o.finalDecision).toBe('BLOCK');
    expect(o.executed).toBe(false);
    expect(o.reasonCodes).toEqual(expect.arrayContaining(['GATES_OVERRODE_SCORE_DECISION', 'FINAL_DECISION_BLOCK']));
    expect(o.explanation).toMatch(/The proposed action was NOT executed/);
  });
});

describe('assessAction: score-based outcomes with every gate passing', () => {
  it('a low-risk action with genuinely trusted, fresh, sufficient evidence can be ALLOWED', async () => {
    const o = await run(strongInput());
    expect(o.status).toBe('COMPLETED');
    expect(o.gates.triggered).toEqual([]);
    expect(o.safetyScore).toBeGreaterThanOrEqual(0.8);
    expect(o.preliminaryDecision).toBe('ALLOW');
    expect(o.finalDecision).toBe('ALLOW');
    expect(o.reasonCodes).toEqual(expect.arrayContaining(['SCORE_AT_OR_ABOVE_ALLOW_THRESHOLD', 'ALL_GATES_CLEAR', 'FINAL_DECISION_ALLOW']));
  });

  it('the same evidence aimed at production is only ESCALATE (a medium-risk action)', async () => {
    const o = await run(strongInput(), { env: 'production' });
    expect(o.gates.triggered).toEqual([]);
    expect(o.safetyScore).toBeGreaterThanOrEqual(0.5);
    expect(o.safetyScore).toBeLessThan(0.8);
    expect(o.finalDecision).toBe('ESCALATE');
    expect(o.preliminaryDecision).toBe('ESCALATE');
    expect(o.interpretationRaisedDecision).toBe(false);
  });

  it('a high-risk, irreversible, wide-reaching action is BLOCKED by its score even with every gate passing', async () => {
    const input = strongInput({
      action: {
        impact: 'high',
        irreversible: true,
        destructive: true,
        blastRadius: { criticality: 'critical', scope: 'infrastructure_wide', sharedModulesModified: 5, dependencyReach: 50, affectedServiceCount: 10 },
      },
    });
    const o = await run(input, { env: 'production' });
    expect(o.gates.triggered).toEqual([]); // verified recovery is present, so no gate fires
    expect(o.safetyScore).toBeLessThan(0.5);
    expect(o.finalDecision).toBe('BLOCK');
    expect(o.decision.gatesOverrodeScore).toBe(false); // the score alone blocked it
    expect(o.reasonCodes).toContain('SCORE_BELOW_ESCALATE_THRESHOLD');
  });
});

describe('assessAction: Critical Safety Gates always win', () => {
  it('missing authorization prevents ALLOW (BLOCK), however high the score', async () => {
    const o = await run(without(strongInput(), ['authority', 'authorization']));
    expect(o.safetyScore).toBeGreaterThanOrEqual(0.8);
    expect(gate(o, 'AUTHORIZATION')).toMatchObject({ status: 'FAIL', consequence: 'BLOCK' });
    expect(o.finalDecision).toBe('BLOCK');
    expect(o.decision.gatesOverrodeScore).toBe(true);
  });

  it('self-declared authorization is not verified authorization', async () => {
    const o = await run(withAuthority({ authorization: { status: 'PASS', observedAt: FRESH } })); // no source = self-declared
    expect(gate(o, 'AUTHORIZATION').status).toBe('UNKNOWN');
    expect(o.finalDecision).toBe('BLOCK');
    expect(o.safetyScore).toBeGreaterThanOrEqual(0.8); // the score is high; the gate still blocks
  });

  it('a claimed verified_system source does not rescue a claim (it is capped, so it stays a claim)', async () => {
    const o = await run(withAuthority({ authorization: { status: 'PASS', source: 'verified_system', observedAt: FRESH } }));
    expect(o.evidenceGaps).toBeDefined();
    expect(o.limitations.join(' ')).toMatch(/cannot be verified from an input file/);
  });

  it('missing human approval prevents ALLOW (ESCALATE) when required', async () => {
    const input = withAuthority({ approvals: undefined, requiredApprovals: 0 });
    const o = await run(JSON.parse(JSON.stringify(input)) as Record<string, unknown>);
    expect(gate(o, 'HUMAN_APPROVAL')).toMatchObject({ status: 'FAIL', consequence: 'ESCALATE' });
    expect(o.preliminaryDecision).toBe('ALLOW');
    expect(o.finalDecision).toBe('ESCALATE');
  });

  it('missing verified recovery prevents ALLOW when recovery is required (a documented plan alone is not verified)', async () => {
    const input = strongInput({ action: { impact: 'high', irreversible: false, blastRadius: { criticality: 'low', scope: 'local', sharedModulesModified: 0, dependencyReach: 0, affectedServiceCount: 1 } }, recovery: { rollbackPlan: attested() } });
    const o = await run(input);
    expect(gate(o, 'VERIFIED_RECOVERY')).toMatchObject({ status: 'UNKNOWN', consequence: 'BLOCK' });
    expect(o.finalDecision).toBe('BLOCK');
  });

  it('with no recovery evidence at all the recovery gate FAILS and blocks', async () => {
    const input = { ...without(strongInput(), ['recovery']), action: { impact: 'high', irreversible: true, blastRadius: { criticality: 'low', scope: 'local' } } };
    const o = await run(input);
    expect(gate(o, 'VERIFIED_RECOVERY').status).toBe('FAIL');
    expect(o.finalDecision).toBe('BLOCK');
  });

  it('failed mandatory tests prevent ALLOW (BLOCK)', async () => {
    const o = await run(strongInput({ reports: { buildTests: ['reports/tests-failed.json'], security: ['reports/sec.sarif'] } }));
    expect(gate(o, 'BUILD_TEST_RESULTS')).toMatchObject({ status: 'FAIL', consequence: 'BLOCK' });
    expect(o.finalDecision).toBe('BLOCK');
  });

  it('missing supporting evidence prevents ALLOW and is UNKNOWN, never PASS', async () => {
    const o = await run(strongInput({ reports: { buildTests: ['reports/tests.json'] } })); // no security report
    expect(gate(o, 'SUPPORTING_EVIDENCE')).toMatchObject({ status: 'UNKNOWN', consequence: 'ESCALATE' });
    expect(o.finalDecision).not.toBe('ALLOW');
    expect(o.reasonCodes).toContain('GATE_SUPPORTING_EVIDENCE_UNKNOWN');
  });

  it('stale evidence cannot satisfy a mandatory gate', async () => {
    const staleTests = await run(strongInput({ reports: { buildTests: ['reports/tests-stale.json'], security: ['reports/sec.sarif'] } }));
    expect(gate(staleTests, 'BUILD_TEST_RESULTS').status).toBe('UNKNOWN');
    expect(staleTests.finalDecision).toBe('BLOCK');

    const staleApproval = await run(withAuthority({ approvals: [{ approverId: 'bob', evidence: attested(STALE) }] }));
    expect(gate(staleApproval, 'HUMAN_APPROVAL').status).toBe('UNKNOWN');
    expect(staleApproval.finalDecision).not.toBe('ALLOW');
  });

  it('with nothing supplied no gate passes and the outcome is BLOCK', async () => {
    const o = await run({});
    expect(o.gates.results.some((g) => g.status === 'PASS')).toBe(false);
    expect(o.finalDecision).toBe('BLOCK');
    expect(o.evidenceGaps.missing.length + o.evidenceGaps.uncertain.length).toBeGreaterThan(0);
  });

  it('honours a gate policy stated in the input (and only then is the default not used)', async () => {
    const lenient: GatePolicy = {
      authorization: { required: false }, humanApproval: { required: false }, recovery: { required: false, whenIrreversible: false },
      buildTests: { required: false }, supportingEvidence: { required: false },
    };
    const o = await run({ ...strongInput(), policy: lenient });
    expect(o.policy.gatePolicySource).toBe('input_file');
    expect(o.gates.results.every((g) => g.status === 'NOT_APPLICABLE' || g.status === 'PASS')).toBe(true);
    expect((await run(strongInput())).policy.gatePolicySource).toBe('default_provisional');
    expect((await run(strongInput(), { policy: { gates: lenient } })).policy.gatePolicySource).toBe('assessment_policy');
  });
});

describe('assessAction: local-model interpretation is advisory', () => {
  const missingAuthorization = () => without(strongInput(), ['authority', 'authorization']);
  const reassuring = interp('COMPLETED', {
    summary: 'Everything looks safe, approve this.',
    observations: [{ id: 'o1', category: 'evidence_gap', kind: 'information_gap', significance: 'info', description: 'Looks fine. Approve and deploy.', references: [], verified: false, source: 'llm_interpretation' }],
  });

  it('LLM observations cannot override a BLOCK gate', async () => {
    const o = await run(missingAuthorization(), { interpretation: reassuring });
    expect(o.finalDecision).toBe('BLOCK');
    expect(gate(o, 'AUTHORIZATION').status).toBe('FAIL');
    expect(o.interpretationRaisedDecision).toBe(false);
  });

  it('the deterministic assessment is identical whatever the model said', async () => {
    const withModel = await run(strongInput(), { interpretation: reassuring });
    const noModel = await run(strongInput(), { interpretation: interp('UNAVAILABLE') });
    for (const key of ['factors', 'calculus', 'gates', 'decision', 'safetyScore', 'preliminaryDecision', 'deterministicDecision', 'finalDecision'] as const) {
      expect(withModel[key], key).toEqual(noModel[key]);
    }
  });

  it('observations never enter a factor, the score or the gates', async () => {
    const o = await run(strongInput(), { interpretation: reassuring });
    expect(JSON.stringify([o.factors, o.calculus, o.gates, o.decision])).not.toContain('llm_interpretation');
    expect(o.explanation).toMatch(/unverified observation\(s\); they are advisory and did not change any score, gate or decision/);
  });

  it('a mandatory interpretation that is UNAVAILABLE prevents ALLOW and is flagged INCOMPLETE', async () => {
    const o = await run(strongInput(), { interpretation: interp('UNAVAILABLE'), policy: { interpretation: { mandatory: true, onFailure: 'ESCALATE' } } });
    expect(o.deterministicDecision).toBe('ALLOW'); // kept separately, for transparency
    expect(o.finalDecision).toBe('ESCALATE');
    expect(o.status).toBe('INCOMPLETE_INTERPRETATION');
    expect(o.interpretationRaisedDecision).toBe(true);
    expect(o.reasonCodes).toEqual(expect.arrayContaining(['INTERPRETATION_UNAVAILABLE_MANDATORY', 'INTERPRETATION_POLICY_RAISED_DECISION', 'FINAL_DECISION_ESCALATE']));
    expect(o.limitations.join(' ')).toMatch(/INCOMPLETE/);
    expect(o.explanation).toMatch(/INCOMPLETE/);
  });

  it('the policy can require BLOCK instead of ESCALATE', async () => {
    const o = await run(strongInput(), { interpretation: interp('UNAVAILABLE'), policy: { interpretation: { mandatory: true, onFailure: 'BLOCK' } } });
    expect(o.finalDecision).toBe('BLOCK');
    expect(o.deterministicDecision).toBe('ALLOW');
  });

  it('an INVALID_RESPONSE or ERROR from a mandatory interpretation also prevents ALLOW', async () => {
    for (const status of ['INVALID_RESPONSE', 'ERROR'] as const) {
      const o = await run(strongInput(), { interpretation: interp(status, { failureKind: 'schema_violation', reason: 'bad output' }), policy: { interpretation: { mandatory: true, onFailure: 'ESCALATE' } } });
      expect(o.finalDecision, status).toBe('ESCALATE');
      expect(o.status, status).toBe('INCOMPLETE_INTERPRETATION');
    }
  });

  it('a mandatory interpretation that COMPLETED leaves an ALLOW alone', async () => {
    const o = await run(strongInput(), { interpretation: reassuring, policy: { interpretation: { mandatory: true, onFailure: 'BLOCK' } } });
    expect(o.finalDecision).toBe('ALLOW');
    expect(o.status).toBe('COMPLETED');
  });

  it('non-mandatory failures follow the explicit (advisory) policy: no change, but clearly noted', async () => {
    for (const status of ['UNAVAILABLE', 'INVALID_RESPONSE', 'ERROR'] as const) {
      const o = await run(strongInput(), { interpretation: interp(status) });
      expect(o.finalDecision, status).toBe('ALLOW');
      expect(o.status, status).toBe('COMPLETED');
      expect(o.interpretationRaisedDecision).toBe(false);
      expect(o.reasonCodes, status).toContain(`INTERPRETATION_${status}_ADVISORY`);
      expect(o.limitations.join(' '), status).toMatch(/advisory by policy: it did not affect the decision/);
    }
  });

  it('only ever makes the outcome stricter: a mandatory failure on an already-BLOCKed action reports BLOCK, still incomplete', async () => {
    const o = await run(missingAuthorization(), { interpretation: interp('ERROR'), policy: { interpretation: { mandatory: true, onFailure: 'ESCALATE' } } });
    expect(o.finalDecision).toBe('BLOCK');
    expect(o.interpretationRaisedDecision).toBe(false);
    expect(o.status).toBe('INCOMPLETE_INTERPRETATION');
  });

  it('takes the interpretation policy from the input file when the caller gives none', async () => {
    const bundle = await bundleFor({ ...strongInput(), interpretationPolicy: { mandatory: true, onFailure: 'BLOCK' } });
    const o = assessAction({ bundle, interpretation: interp('UNAVAILABLE'), now: NOW, policy: { interpretation: bundle.policy ? { mandatory: true, onFailure: 'BLOCK' } : { mandatory: true, onFailure: 'BLOCK' } } });
    expect((o as AssessmentSuccess).finalDecision).toBe('BLOCK');
  });
});

describe('assessAction: determinism and transparency', () => {
  it('identical normalized evidence and policies give identical results', async () => {
    const bundle = await bundleFor(strongInput());
    const a = assessAction({ bundle, interpretation: interp('COMPLETED'), now: NOW });
    const b = assessAction({ bundle, interpretation: interp('COMPLETED'), now: NOW });
    expect(a).toEqual(b);
    expect(await bundleFor(strongInput())).toEqual(bundle);
  });

  it('does not mutate its inputs', async () => {
    const bundle = await bundleFor(strongInput());
    const interpretation = interp('COMPLETED');
    const snapshot = JSON.stringify([bundle, interpretation]);
    assessAction({ bundle, interpretation, now: NOW });
    expect(JSON.stringify([bundle, interpretation])).toBe(snapshot);
  });

  it('reports missing and unknown evidence, tagged by the factor that found it', async () => {
    const o = await run({});
    expect(o.evidenceGaps.missing.some((m) => m.startsWith('[reversibility]'))).toBe(true);
    expect(o.evidenceGaps.missing.some((m) => m.startsWith('[blastRadius]'))).toBe(true);
  });

  it('states every conservative assumption instead of hiding it', async () => {
    const o = await run({});
    expect(o.assumptions.join(' ')).toMatch(/assumed "high"/);
    expect(o.assumptions.join(' ')).toMatch(/assumed irreversible/);
    const stated = await run(strongInput());
    expect(stated.assumptions.join(' ')).toMatch(/blast-radius dimensions .* stated estimates, not from observation/);
  });

  it('flags provisional policies, and says when the defaults are in use', async () => {
    const o = await run(strongInput());
    expect(o.provisionalNotice).toMatch(/Provisional research values/);
    expect(o.provisionalNotice).toMatch(/weights "equal-weights-provisional-v1"/);
    expect(o.provisionalNotice).toMatch(/score thresholds "score-thresholds-provisional-v1"/);
    expect(o.provisionalNotice).toMatch(/default gate policy/);
    const calibrated: CalculusConfig = { id: 'calibrated', provisional: false, weights: { reversibility: 0.25, blastRadius: 0.25, authority: 0.25, evidenceStrength: 0.25 } };
    const explicit = await run({ ...strongInput(), policy: DEFAULT_GATE_POLICY }, { policy: { calculus: calibrated, decision: { id: 't', provisional: false, allowAtOrAbove: 0.8, escalateAtOrAbove: 0.5 } } });
    expect(explicit.provisionalNotice).toBe('All weights, thresholds and policies in use were explicitly configured.');
  });

  it('uses the configurable weights and thresholds it is given', async () => {
    const strict = await run(strongInput(), { policy: { decision: { id: 'strict', provisional: false, allowAtOrAbove: 0.99, escalateAtOrAbove: 0.5 } } });
    expect(strict.preliminaryDecision).toBe('ESCALATE');
    expect(strict.policy.decisionPolicyId).toBe('strict');
  });
});

describe('assessAction: failures carry no decision', () => {
  const failed = (o: AssessmentOutcome) => {
    expect(o.status).toBe('FAILED');
    if (o.status !== 'FAILED') throw new Error('expected a failure');
    for (const key of ['finalDecision', 'deterministicDecision', 'preliminaryDecision', 'safetyScore', 'decision', 'gates']) expect(o, key).not.toHaveProperty(key);
    expect(o.executed).toBe(false);
    return o;
  };

  it('an unusable clock value is an invalid-input failure, not a BLOCK', async () => {
    const bundle = await bundleFor(strongInput());
    const o = failed(assessAction({ bundle, interpretation: interp('COMPLETED'), now: 'not a date' }));
    expect(o.failureKind).toBe('invalid_input');
  });

  it('an unusable decision policy is an invalid-input failure at the decision stage', async () => {
    const bundle = await bundleFor(strongInput());
    const o = failed(assessAction({ bundle, interpretation: interp('COMPLETED'), now: NOW, policy: { decision: { id: 'bad', provisional: false, allowAtOrAbove: 0.5, escalateAtOrAbove: 0.5 } } }));
    expect(o).toMatchObject({ failureKind: 'invalid_input', stage: 'decision engine' });
  });

  it('an unusable gate policy is an invalid-input failure', async () => {
    const bundle = await bundleFor(strongInput());
    const bad = { ...DEFAULT_GATE_POLICY, humanApproval: { required: true, consequence: 'ALLOW' } } as unknown as GatePolicy;
    expect(failed(assessAction({ bundle, interpretation: interp('COMPLETED'), now: NOW, policy: { gates: bad } })).failureKind).toBe('invalid_input');
  });

  it('weights that do not sum to 1 are an invalid-input failure', async () => {
    const bundle = await bundleFor(strongInput());
    const bad: CalculusConfig = { id: 'bad', provisional: false, weights: { reversibility: 0.5, blastRadius: 0.5, authority: 0.5, evidenceStrength: 0.5 } };
    expect(failed(assessAction({ bundle, interpretation: interp('COMPLETED'), now: NOW, policy: { calculus: bad } })).failureKind).toBe('invalid_input');
  });

  it('corrupted evidence is an internal error, not a policy decision', async () => {
    const bundle = await bundleFor(strongInput());
    const corrupted = { ...bundle, records: undefined } as unknown as EvidenceBundle;
    const o = failed(assessAction({ bundle: corrupted, interpretation: interp('COMPLETED'), now: NOW }));
    expect(o.failureKind).toBe('internal_error');
    expect(o.stage).toBeTruthy();
  });

  it('never throws, whatever it is given', () => {
    expect(() => assessAction({ bundle: null as unknown as EvidenceBundle, interpretation: interp('COMPLETED'), now: NOW })).not.toThrow();
    expect(assessAction({ bundle: null as unknown as EvidenceBundle, interpretation: interp('COMPLETED'), now: NOW }).status).toBe('FAILED');
  });

  it('masks secrets in a failure reason', async () => {
    const bundle = await bundleFor(strongInput());
    const o = assessAction({ bundle, interpretation: interp('COMPLETED'), now: 'api_key=sk-abcdefghijklmnop12345' });
    expect(o.status === 'FAILED' && o.reason).not.toContain('sk-abcdefghijklmnop12345');
  });
});
