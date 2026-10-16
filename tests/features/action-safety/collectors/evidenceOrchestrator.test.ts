import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessAuthority } from '../../../../src/features/action-safety/calculus/authority.js';
import { assessBlastRadius } from '../../../../src/features/action-safety/calculus/blastRadius.js';
import { calculateSafetyScore } from '../../../../src/features/action-safety/calculus/calculus.js';
import { decideAction } from '../../../../src/features/action-safety/calculus/decisionEngine.js';
import { assessEvidenceStrength } from '../../../../src/features/action-safety/calculus/evidenceStrength.js';
import { evaluateGates, type GatePolicy } from '../../../../src/features/action-safety/calculus/gates.js';
import { assessReversibility } from '../../../../src/features/action-safety/calculus/reversibility.js';
import { parseAssessmentInput, SafetyInputError, type AssessmentRequest } from '../../../../src/features/action-safety/cli/assessmentInput.js';
import { handleSafetyCommand } from '../../../../src/features/action-safety/cli/handleSafetyCommand.js';
import { runAssessmentSession } from '../../../../src/features/action-safety/cli/runAssessment.js';
import {
  aggregateStatus,
  gateStatusOf,
  toAuthorityInput,
  toBlastRadiusInput,
  toEvidenceStrengthInput,
  toGateInputs,
  toProposedAction,
  toReversibilityInput,
  UNIDENTIFIED_ACTOR,
} from '../../../../src/features/action-safety/collectors/evidenceAdapters.js';
import {
  collectEvidence,
  describeEvidenceBundle,
  type EvidenceBundle,
} from '../../../../src/features/action-safety/collectors/evidenceOrchestrator.js';
import type { EvidenceRecord } from '../../../../src/features/action-safety/collectors/types.js';
import { FRESH, NOW, STALE, isolateModelConfig, makeRepo, makeTempDir, pkg, type TempRepo } from '../../../../src/features/action-safety/testing/fixtures.js';

let repo: TempRepo;

beforeEach(async () => {
  repo = await makeRepo();
  await repo.write('.gitignore', 'reports/\n');
  await repo.write('src/a.ts', 'one\n');
  await repo.write('package.json', pkg({ a: '^1.0.0' }));
  await repo.commitAll('base');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await repo.remove();
});

const attested = (observedAt = FRESH, refs: string[] = ['ref:x']) => ({ status: 'PASS', source: 'human_attested', observedAt, refs });

const ALL_REQUIRED: GatePolicy = {
  authorization: { required: true },
  humanApproval: { required: true },
  recovery: { required: true, whenIrreversible: true, minImpact: 'high' },
  buildTests: { required: true },
  supportingEvidence: { required: true },
};

async function makeChanges(): Promise<void> {
  await repo.write('src/a.ts', 'one\ntwo\n');
  await repo.git.add('src/a.ts'); // staged
  await repo.write('package.json', pkg({ a: '^2.0.0' })); // unstaged major bump
  await repo.write('src/new.ts', 'x\n'); // untracked
}

async function writeReports(opts: { testsAt?: string; testsStatus?: string } = {}): Promise<void> {
  await repo.write(
    'reports/tests.json',
    JSON.stringify({ tool: 'vitest', kind: 'test', status: opts.testsStatus ?? 'pass', timestamp: opts.testsAt ?? FRESH, summary: { total: 8, passed: 8, failed: 0 } }),
  );
  await repo.write(
    'reports/sec.sarif',
    JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: FRESH }], results: [] }] }),
  );
}

const FULL_INPUT = {
  action: { impact: 'high', irreversible: true },
  actor: { id: 'alice', kind: 'human', roles: ['release-manager'] },
  // the scenario bumps a dependency major version, so compatibility must be evidenced explicitly
  evidence: { dependencyCompatibility: attested() },
  authority: {
    identityVerification: attested(),
    authorization: attested(),
    requiredRoles: ['release-manager'],
    requiredPermissions: ['deploy:prod'],
    grantedPermissions: { permissions: ['deploy:prod'], evidence: attested() },
    requiredApprovals: 1,
    approvals: [{ approverId: 'bob', evidence: attested() }],
  },
  reports: { buildTests: ['reports/tests.json'], security: ['reports/sec.sarif'] },
  recovery: { rollbackPlan: attested(), rollbackTest: attested(), backup: attested() },
  policy: ALL_REQUIRED,
};

const requestFor = (input?: unknown, diffRef?: string): AssessmentRequest => ({
  actionType: 'deployment',
  environment: 'production',
  ...(diffRef ? { diffRef } : {}),
  ...(input !== undefined ? { input: parseAssessmentInput(input) } : {}),
});

const collect = (input?: unknown, diffRef?: string) => collectEvidence({ cwd: repo.dir, request: requestFor(input, diffRef), now: NOW });
const ofType = (b: EvidenceBundle, type: EvidenceRecord['type']) => b.records.filter((r) => r.type === type);

function gateResultsFor(b: EvidenceBundle, policy: GatePolicy = ALL_REQUIRED) {
  const { action } = toProposedAction(b);
  const { authority, evidence } = toGateInputs(b);
  return evaluateGates({ action, authority, evidence, policy });
}

describe('collectEvidence: a fully supplied scenario', () => {
  it('collects git facts, imported reports and user-supplied claims, each labelled by origin', async () => {
    await makeChanges();
    await writeReports();
    const b = await collect(FULL_INPUT);

    const git = ofType(b, 'git_state')[0];
    expect(git).toMatchObject({ role: 'fact', origin: 'observed_git', source: 'verified_system', trusted: true, status: 'PASS' });
    expect(b.git.counts).toEqual({ total: 3, staged: 1, unstaged: 1, untracked: 1, conflicted: 0 });

    expect(ofType(b, 'dependency_change')[0]).toMatchObject({ role: 'fact', origin: 'observed_git' });
    expect(b.dependencies.counts.majorUpgrades).toBe(1);

    expect(ofType(b, 'build_test')[0]).toMatchObject({ role: 'assertion', origin: 'imported_report', source: 'automated_tool', status: 'PASS', refs: ['reports/tests.json'], observedAt: FRESH, stale: false });
    expect(ofType(b, 'security_findings')[0]).toMatchObject({ origin: 'imported_report', status: 'PASS', refs: ['reports/sec.sarif'] });

    const authority = ofType(b, 'authority');
    expect(authority.length).toBeGreaterThanOrEqual(4);
    expect(authority.every((r) => r.origin === 'user_supplied')).toBe(true);
    const recovery = ofType(b, 'recovery');
    expect(recovery.map((r) => r.details?.recoveryKind)).toEqual(['rollback_plan', 'rollback_test', 'backup']);
  });

  it('gives every record a deterministic id, a type, a source, a status and limitations', async () => {
    await makeChanges();
    await writeReports();
    const b = await collect(FULL_INPUT);
    const ids = b.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('git_state-1');
    expect(ids).toContain('build_test-1');
    expect(ids).toContain('recovery-3');
    for (const r of b.records) {
      expect(r.type).toBeTruthy();
      expect(['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE']).toContain(r.status);
      expect(['verified_system', 'automated_tool', 'human_attested', 'self_declared']).toContain(r.source);
      expect(Array.isArray(r.limitations)).toBe(true);
    }
  });

  it('lets every gate pass when all mandatory conditions are evidenced by trusted, fresh records', async () => {
    await makeChanges();
    await writeReports();
    const g = gateResultsFor(await collect(FULL_INPUT));
    expect(g.results.map((r) => [r.gate, r.status])).toEqual([
      ['AUTHORIZATION', 'PASS'],
      ['HUMAN_APPROVAL', 'PASS'],
      ['VERIFIED_RECOVERY', 'PASS'],
      ['BUILD_TEST_RESULTS', 'PASS'],
      ['SUPPORTING_EVIDENCE', 'PASS'],
    ]);
    expect(g.consequence).toBeNull();
  });

  it('is deterministic: the same inputs and time give an identical bundle', async () => {
    await makeChanges();
    await writeReports();
    expect(await collect(FULL_INPUT)).toEqual(await collect(FULL_INPUT));
  });
});

describe('collectEvidence: missing evidence is explicit UNKNOWN, never PASS', () => {
  it('produces a "nothing supplied" record for each assertion kind and blocks every mandatory gate', async () => {
    const b = await collect(undefined);
    for (const type of ['build_test', 'security_findings', 'authority', 'recovery'] as const) {
      const rs = ofType(b, type);
      expect(rs, type).toHaveLength(1);
      expect(rs[0], type).toMatchObject({ origin: 'not_collected', status: 'UNKNOWN', trusted: false });
    }
    expect(ofType(b, 'dependency_compatibility')[0].status).toBe('NOT_APPLICABLE');

    const { authority, evidence } = toGateInputs(b);
    expect(authority.authorization).toBeUndefined();
    expect(authority.humanApproval).toBeUndefined();
    expect(authority.actor).toEqual(UNIDENTIFIED_ACTOR);
    expect(evidence.buildTests?.status).toBe('UNKNOWN');
    expect(evidence.supporting?.status).toBe('UNKNOWN');
    expect(evidence.recovery).toBeUndefined();

    const g = gateResultsFor(b);
    expect(g.results.some((r) => r.status === 'PASS')).toBe(false);
    expect(g.consequence).toBe('BLOCK');
  });

  it('never invents an actor: the placeholder claims no roles', () => {
    expect(UNIDENTIFIED_ACTOR.roles).toEqual([]);
  });

  it('keeps UNKNOWN as UNKNOWN in every gate view', async () => {
    const b = await collect(undefined);
    for (const r of b.records.filter((x) => x.status === 'UNKNOWN')) expect(gateStatusOf(r)).not.toBe('PASS');
  });

  it('aggregateStatus never upgrades: FAIL beats UNKNOWN beats PASS, and empty means nothing collected', () => {
    expect(aggregateStatus(['PASS', 'UNKNOWN', 'PASS'])).toBe('UNKNOWN');
    expect(aggregateStatus(['PASS', 'FAIL', 'UNKNOWN'])).toBe('FAIL');
    expect(aggregateStatus(['NOT_APPLICABLE'])).toBe('NOT_APPLICABLE');
    expect(aggregateStatus(['NOT_APPLICABLE', 'PASS'])).toBe('PASS');
    expect(aggregateStatus([])).toBeUndefined();
  });
});

describe('collectEvidence: failed, stale and untrusted evidence', () => {
  it('a failing test report fails the build/test gate', async () => {
    await writeReports({ testsStatus: 'fail' });
    const b = await collect(FULL_INPUT);
    expect(ofType(b, 'build_test')[0].status).toBe('FAIL');
    const g = gateResultsFor(b);
    expect(g.results.find((r) => r.gate === 'BUILD_TEST_RESULTS')?.status).toBe('FAIL');
    expect(g.consequence).toBe('BLOCK');
  });

  it('a stale passing report is marked stale, preserved as PASS, but the gate sees UNKNOWN', async () => {
    await writeReports({ testsAt: STALE });
    const b = await collect(FULL_INPUT);
    const r = ofType(b, 'build_test')[0];
    expect(r.status).toBe('PASS');
    expect(r.stale).toBe(true);
    expect(gateStatusOf(r)).toBe('UNKNOWN');
    expect(gateResultsFor(b).results.find((x) => x.gate === 'BUILD_TEST_RESULTS')?.status).toBe('UNKNOWN');
  });

  it('a self-declared authorization claim does not open the authorization gate; an attested fresh one does', async () => {
    await writeReports();
    const selfDeclared = { ...FULL_INPUT, authority: { ...FULL_INPUT.authority, authorization: { status: 'PASS', observedAt: FRESH } } };
    const weak = await collect(selfDeclared);
    expect(ofType(weak, 'authority').find((r) => r.details?.authorityKind === 'authorization')).toMatchObject({ trusted: false, source: 'self_declared' });
    expect(gateResultsFor(weak).results.find((r) => r.gate === 'AUTHORIZATION')?.status).toBe('UNKNOWN');

    const strong = await collect(FULL_INPUT);
    expect(gateResultsFor(strong).results.find((r) => r.gate === 'AUTHORIZATION')?.status).toBe('PASS');
  });

  it('a claimed verified_system source on a user claim is capped and the cap is recorded', async () => {
    const claimed = { ...FULL_INPUT, authority: { ...FULL_INPUT.authority, authorization: { status: 'PASS', source: 'verified_system', observedAt: FRESH } } };
    const b = await collect(claimed);
    const rec = ofType(b, 'authority').find((r) => r.details?.authorityKind === 'authorization');
    expect(rec?.source).toBe('human_attested');
    expect(b.limitations.join(' ')).toMatch(/cannot be verified from an input file/);
  });

  it('a documented rollback plan alone does not satisfy the recovery gate', async () => {
    await writeReports();
    const planOnly = { ...FULL_INPUT, recovery: { rollbackPlan: attested() } };
    const g = gateResultsFor(await collect(planOnly));
    expect(g.results.find((r) => r.gate === 'VERIFIED_RECOVERY')?.status).toBe('UNKNOWN');
    expect(g.consequence).toBe('BLOCK');
  });

  it('too few approvals, or only a self-approval, never pass the human-approval gate', async () => {
    await writeReports();
    const two = { ...FULL_INPUT, authority: { ...FULL_INPUT.authority, requiredApprovals: 2 } };
    expect(gateResultsFor(await collect(two)).results.find((r) => r.gate === 'HUMAN_APPROVAL')?.status).toBe('UNKNOWN');

    const selfOnly = { ...FULL_INPUT, authority: { ...FULL_INPUT.authority, approvals: [{ approverId: 'alice', evidence: attested() }] } };
    expect(gateResultsFor(await collect(selfOnly)).results.find((r) => r.gate === 'HUMAN_APPROVAL')?.status).toBe('FAIL');

    const rejected = {
      ...FULL_INPUT,
      authority: { ...FULL_INPUT.authority, approvals: [{ approverId: 'bob', evidence: attested() }, { approverId: 'carol', evidence: { status: 'FAIL', source: 'human_attested', observedAt: FRESH } }] },
    };
    expect(gateResultsFor(await collect(rejected)).results.find((r) => r.gate === 'HUMAN_APPROVAL')?.status).toBe('FAIL');
  });

  it('imported security findings at high severity fail supporting evidence; no report leaves it UNKNOWN', async () => {
    await writeReports();
    await repo.write(
      'reports/sec.sarif',
      JSON.stringify({ runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: FRESH }], results: [{ ruleId: 'r', level: 'error', message: { text: 'bad' } }] }] }),
    );
    const failing = await collect(FULL_INPUT);
    expect(ofType(failing, 'security_findings')[0].status).toBe('FAIL');
    expect(gateResultsFor(failing).results.find((r) => r.gate === 'SUPPORTING_EVIDENCE')?.status).toBe('FAIL');

    const noReport = { ...FULL_INPUT, reports: { buildTests: ['reports/tests.json'] } };
    expect(gateResultsFor(await collect(noReport)).results.find((r) => r.gate === 'SUPPORTING_EVIDENCE')?.status).toBe('UNKNOWN');
  });
});

describe('collectEvidence: malformed inputs and inaccessible paths', () => {
  it('survives reports that are missing, outside the project, malformed or directories, recording UNKNOWN for each', async () => {
    await repo.write('reports/broken.json', '{ "tool": ');
    await fs.mkdir(path.join(repo.dir, 'reports', 'dir'));
    const outside = await makeTempDir('codexrev-safety-outside-');
    await fs.writeFile(path.join(outside, 'real.json'), JSON.stringify({ tool: 'x', status: 'pass', timestamp: FRESH }));
    const escape = path.relative(repo.dir, path.join(outside, 'real.json')); // a real file, outside the project
    const input = { reports: { buildTests: ['reports/missing.json', escape, 'reports/broken.json', 'reports/dir'], security: ['reports/also-missing.sarif'] } };
    const b = await collect(input);
    const bt = ofType(b, 'build_test');
    expect(bt.every((r) => r.status === 'UNKNOWN')).toBe(true);
    expect(bt.length).toBeGreaterThanOrEqual(4);
    expect(bt.some((r) => r.limitations.join(' ').includes('outside the project directory'))).toBe(true);
    expect(toGateInputs(b).evidence.buildTests?.status).toBe('UNKNOWN');
    expect(ofType(b, 'security_findings')[0].status).toBe('UNKNOWN');
  });

  it('does not throw for a working directory that does not exist, and everything is UNKNOWN', async () => {
    const missingDir = path.join(await makeTempDir(), 'does-not-exist');
    const b = await collectEvidence({ cwd: missingDir, request: requestFor(undefined), now: NOW });
    expect(b.git.state).toBe('error');
    expect(ofType(b, 'git_state')[0].status).toBe('UNKNOWN');
    expect(b.limitations.length).toBeGreaterThan(0);
  });

  it('reports an invalid --diff in the git collection', async () => {
    const b = await collect(undefined, 'no-such-ref');
    expect(b.git.diffRefError).toMatch(/does not resolve to a commit/);
  });
});

describe('collectEvidence: read-only', () => {
  it('changes nothing in .git or the working tree, and creates no files', async () => {
    await makeChanges();
    await writeReports();
    const listTree = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      const walk = async (d: string): Promise<void> => {
        for (const e of await fs.readdir(d, { withFileTypes: true })) {
          if (e.name === '.git') continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p);
          else out[path.relative(repo.dir, p)] = createHash('sha1').update(await fs.readFile(p)).digest('hex');
        }
      };
      await walk(repo.dir);
      return out;
    };
    // `git status` itself may refresh the index, so run it BEFORE taking the snapshots we compare against
    const beforeStatus = await repo.git.raw(['status', '--porcelain']);
    const beforeGit = await repo.snapshotGitDir();
    const beforeTree = await listTree();

    await collect(FULL_INPUT);
    await collect(FULL_INPUT, 'HEAD');

    expect(await repo.snapshotGitDir()).toEqual(beforeGit);
    expect(await listTree()).toEqual(beforeTree);
    expect(await repo.git.raw(['status', '--porcelain'])).toBe(beforeStatus);
    await expect(fs.access(path.join(repo.dir, 'node_modules'))).rejects.toThrow();
  });
});

describe('evidence adapters: compatible with the existing assessors, gates and decision engine', () => {
  it('feeds a complete bundle through all four assessors, the calculus and the decision engine', async () => {
    await makeChanges();
    await writeReports();
    const b = await collect(FULL_INPUT);

    const reversibility = assessReversibility(toReversibilityInput(b, NOW).input);
    const blast = assessBlastRadius(toBlastRadiusInput(b));
    const authority = assessAuthority(toAuthorityInput(b, NOW));
    const evidence = assessEvidenceStrength(toEvidenceStrengthInput(b, NOW));
    for (const a of [reversibility, blast, authority, evidence]) {
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(1);
    }
    // git-observed impact feeds Blast Radius; what git cannot observe stays "missing"
    expect(blast.breakdown.find((c) => c.name === 'affected files')?.note).toMatch(/^3 /);
    expect(blast.missing).toEqual(expect.arrayContaining(['criticality', 'scope']));
    // verified fresh recovery evidence is recognised by the Reversibility assessor
    expect(reversibility.adjustments.map((a) => a.name)).not.toContain('unverified recovery cap');

    const calculus = calculateSafetyScore([reversibility, blast, authority, evidence]);
    const decision = decideAction(calculus, gateResultsFor(b));
    expect(['ALLOW', 'ESCALATE', 'BLOCK']).toContain(decision.decision);
    expect(decision.triggeredGates).toEqual([]);
  });

  it('with nothing supplied, the same chain can never ALLOW', async () => {
    const b = await collect(undefined);
    const calculus = calculateSafetyScore([
      assessReversibility(toReversibilityInput(b, NOW).input),
      assessBlastRadius(toBlastRadiusInput(b)),
      assessAuthority(toAuthorityInput(b, NOW)),
      assessEvidenceStrength(toEvidenceStrengthInput(b, NOW)),
    ]);
    const decision = decideAction(calculus, gateResultsFor(b));
    expect(decision.decision).toBe('BLOCK');
    expect(decision.triggeredGates.length).toBeGreaterThan(0);
  });

  it('states every assumption it has to make instead of hiding it', async () => {
    const b = await collect(undefined);
    expect(toReversibilityInput(b, NOW).assumptions.join(' ')).toMatch(/assumed irreversible/);
    expect(toProposedAction(b).assumptions.join(' ')).toMatch(/assumed "high"/);
    const stated = await collect({ action: { impact: 'low', irreversible: false } });
    expect(toProposedAction(stated).assumptions).toEqual([]);
    expect(toProposedAction(stated).action).toMatchObject({ impact: 'low', irreversible: false });
  });
});

describe('describeEvidenceBundle', () => {
  it('summarises what was and was not collected', async () => {
    await makeChanges();
    const lines = describeEvidenceBundle(await collect(undefined)).join('\n');
    expect(lines).toMatch(/git: 3 changed file\(s\) \(1 staged, 1 unstaged, 1 untracked\)/);
    expect(lines).toMatch(/dependencies: 1 change\(s\)/);
    expect(lines).toMatch(/build\/test: UNKNOWN \(nothing supplied\)/);
    expect(lines).toMatch(/security findings: UNKNOWN \(nothing supplied\)/);
  });
});

describe('assess command with real evidence collection', () => {
  let out: string[];
  let err: string[];
  let restoreModelConfig: () => void;
  beforeEach(() => {
    restoreModelConfig = isolateModelConfig();
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
    process.exitCode = undefined;
  });
  afterEach(() => {
    restoreModelConfig();
    process.exitCode = undefined;
  });

  it('collects evidence and then assesses it', async () => {
    await makeChanges();
    await fs.writeFile(path.join(repo.dir, 'reports-input.json'), JSON.stringify({ action: { impact: 'high' } }));
    const result = await runAssessmentSession({ cwd: repo.dir, flags: { action: 'deployment', target: 'production', input: 'reports-input.json' }, now: NOW });
    expect(result.status).toBe('completed');
    expect(result.assessment.executed).toBe(false);
    expect(result.evidence.git.counts.total).toBe(4); // includes the input file itself, which is untracked
    expect(result.stages.filter((s) => s.status !== 'connected').map((s) => s.name)).toEqual(['Signed Evidence Pack']);
    expect(result.interpretation.status).toBe('UNAVAILABLE'); // isolated config: a cloud provider, so nothing is sent
  });

  it('turns an unusable --diff into an input error', async () => {
    await expect(runAssessmentSession({ cwd: repo.dir, flags: { action: 'deployment', target: 'production', diff: 'no-such-ref' }, now: NOW })).rejects.toBeInstanceOf(SafetyInputError);
    await expect(runAssessmentSession({ cwd: repo.dir, flags: { action: 'deployment', target: 'production', diff: '--output=x' }, now: NOW })).rejects.toBeInstanceOf(SafetyInputError);
  });

  it('prints the collected evidence and limitations, then a final decision with the matching exit code', async () => {
    await makeChanges();
    await handleSafetyCommand(['assess'], { action: 'deployment', target: 'production' }, repo.dir);
    const text = out.join('\n');
    expect(text).toMatch(/Evidence collected \(read-only\)/);
    expect(text).toMatch(/Git changes +3 changed file\(s\)/);
    expect(text).toMatch(/Build\/test +UNKNOWN \(nothing supplied\)/);
    expect(text).toMatch(/Limitations \(\d+\):/);
    expect(text).toMatch(/\[connected\] +Evidence collection/);
    expect(text).toMatch(/FINAL DECISION: BLOCK/);
    expect(process.exitCode).toBe(11);
  });

  it('reports an invalid --diff as exit code 1', async () => {
    await handleSafetyCommand(['assess'], { action: 'deployment', target: 'production', diff: 'no-such-ref' }, repo.dir);
    expect(process.exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/does not resolve to a commit/);
  });
});
