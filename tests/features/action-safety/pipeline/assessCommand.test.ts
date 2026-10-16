import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAFETY_EXIT_CODES, handleSafetyCommand, type SafetyFlags } from '../../../../src/features/action-safety/cli/handleSafetyCommand.js';
import { renderAssessment } from '../../../../src/features/action-safety/cli/assessmentReport.js';
import { exitCodeForOutcome } from '../../../../src/features/action-safety/cli/exitCodes.js';
import { runAssessmentSession } from '../../../../src/features/action-safety/cli/runAssessment.js';
import type { AssessmentFailure, AssessmentSuccess } from '../../../../src/features/action-safety/pipeline/assessmentCoordinator.js';
import { isolateModelConfig, makeRepo, type TempRepo } from '../../../../src/features/action-safety/testing/fixtures.js';

// The CLI reads the real clock, so every timestamp here is relative to "now", not a fixed date.
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

let repo: TempRepo;
let restoreModelConfig: () => void;
let out: string[];
let err: string[];

const attested = (observedAt = hoursAgo(1), refs: string[] = ['ref:x']) => ({ status: 'PASS', source: 'human_attested', observedAt, refs });

function strongInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: { impact: 'low', irreversible: false, blastRadius: { criticality: 'low', scope: 'local', sharedModulesModified: 0, dependencyReach: 0, affectedServiceCount: 1 } },
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

beforeAll(async () => {
  repo = await makeRepo();
  await repo.write('.gitignore', 'reports/\n');
  await repo.write('src/a.ts', 'one\n');
  await repo.commitAll('base');
  await repo.write('src/a.ts', 'one\ntwo\n');
  await repo.write('reports/tests.json', JSON.stringify({ tool: 'vitest', kind: 'test', status: 'pass', timestamp: hoursAgo(1), summary: { total: 9, passed: 9, failed: 0 } }));
  await repo.write('reports/sec.sarif', JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: hoursAgo(1) }], results: [] }] }));
}, 60_000);

afterAll(async () => {
  await repo.remove();
});

beforeEach(() => {
  restoreModelConfig = isolateModelConfig(); // a cloud provider: the model is refused, nothing is ever sent
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreModelConfig();
  process.exitCode = undefined;
});

const stdout = () => out.join('\n');
// long sentences wrap to the terminal width, so phrase-level checks compare with whitespace collapsed
const flat = (s: string): string => s.replace(/\s+/g, ' ');
async function assess(input: Record<string, unknown> | undefined, target = 'development', extra: SafetyFlags = {}): Promise<void> {
  let inputFlag: string | undefined;
  if (input) {
    inputFlag = 'reports/input.json';
    await repo.write(inputFlag, JSON.stringify(input));
  }
  await handleSafetyCommand(['assess'], { action: 'deployment', target, ...(inputFlag ? { input: inputFlag } : {}), ...extra }, repo.dir);
}

describe('codexrev safety assess: the complete pipeline through the CLI', () => {
  it('shows every factor score, the weighted score, each decision stage and the final ALLOW, and exits 0', async () => {
    await assess(strongInput());
    const text = stdout();
    const f = flat(text);
    expect(text).toMatch(/Action-Safety Assessment/);
    expect(text).toMatch(/Action +deployment/);
    expect(text).toMatch(/Target +development/);
    expect(f).toMatch(/The proposed action was NOT executed/);
    expect(text).toMatch(/Evidence collected \(read-only\)/);
    expect(text).toMatch(/Local model interpretation \(advisory, UNVERIFIED\)/);
    expect(text).toMatch(/Status +UNAVAILABLE/);
    expect(text).toMatch(/Reversibility \(R\) +0\.\d{3} .*higher = safer/);
    expect(text).toMatch(/Blast radius \(B\) +0\.\d{3}/);
    expect(f).toMatch(/higher = RISKIER \(counts as 1-B = 0\.\d{3}\)/);
    expect(text).toMatch(/Authority \(A\) +0\.\d{3} .*higher = safer/);
    expect(text).toMatch(/Evidence strength \(E\) +0\.\d{3} .*higher = safer/);
    expect(text).toMatch(/SAFETY SCORE +0\.\d{3} \/ 1\.000/);
    expect(text).toMatch(/= 0\.250\*R\(0\.\d{3}\) \+ 0\.250\*\(1-B\)\(0\.\d{3}\) \+ 0\.250\*A\(0\.\d{3}\) \+ 0\.250\*E\(0\.\d{3}\)/);
    expect(text).toMatch(/Score alone +\S+ ALLOW/);
    expect(text).toMatch(/\+ Authorization +PASS +none/);
    expect(text).toMatch(/\+ Human approval +PASS +none/);
    expect(text).toMatch(/- Verified recovery +NOT_APPLICABLE +not required/);
    expect(text).toMatch(/After critical gates +\S+ ALLOW +the gates did not change it/);
    expect(text).toMatch(/Interpretation policy: advisory/);
    expect(text).toMatch(/FINAL DECISION: ALLOW/);
    expect(f).toMatch(/Reason codes .*FINAL_DECISION_ALLOW/);
    expect(text).toMatch(/^\s+Why$/m);
    expect(f).toMatch(/Provisional policy notice: Provisional research values/);
    expect(process.exitCode).toBe(0);
  });

  it('exits 10 for a completed ESCALATE', async () => {
    await assess(strongInput(), 'production');
    expect(stdout()).toMatch(/FINAL DECISION: ESCALATE/);
    expect(process.exitCode).toBe(SAFETY_EXIT_CODES.escalate);
    expect(process.exitCode).toBe(10);
  });

  it('exits 11 for a completed BLOCK, and shows the gate that blocked it', async () => {
    const input = strongInput();
    delete (input.authority as Record<string, unknown>).authorization;
    await assess(input);
    const text = stdout();
    expect(text).toMatch(/x Authorization +FAIL +x BLOCK/);
    expect(text).toMatch(/Score alone +\S+ ALLOW/);
    expect(text).toMatch(/After critical gates +\S+ BLOCK +the gates changed it from ALLOW/);
    expect(text).toMatch(/FINAL DECISION: BLOCK/);
    expect(process.exitCode).toBe(SAFETY_EXIT_CODES.block);
    expect(process.exitCode).toBe(11);
  });

  it('with nothing supplied: BLOCK, missing evidence listed by category, assumptions stated', async () => {
    await assess(undefined);
    const text = stdout();
    expect(text).toMatch(/FINAL DECISION: BLOCK/);
    expect(text).toMatch(/Missing, unknown or conflicting evidence \(\d+\):/);
    expect(text).toMatch(/Reversibility \(R\)\n\s+missing +/);
    expect(text).toMatch(/Blast radius \(B\)\n\s+missing +/);
    expect(text).toMatch(/Assumptions made because the input was silent:/);
    expect(flat(text)).toMatch(/default gate policy/);
    expect(process.exitCode).toBe(11);
  });

  it('a mandatory interpretation that is unavailable is reported as INCOMPLETE with exit 3, never 0', async () => {
    await assess({ ...strongInput(), interpretationPolicy: { mandatory: true, onFailure: 'ESCALATE' } });
    const text = stdout();
    const f = flat(text);
    expect(text).toMatch(/Decision +\S+ INCOMPLETE/);
    expect(f).toMatch(/conservative outcome: ESCALATE/);
    expect(f).toMatch(/Interpretation policy: MANDATORY \(if unusable, at least ESCALATE\)/);
    expect(f).toMatch(/interpretation policy raised ALLOW to ESCALATE/);
    expect(f).toMatch(/ASSESSMENT INCOMPLETE: local-model interpretation is mandatory by policy but UNAVAILABLE/);
    expect(f).toMatch(/not a full assessment/);
    expect(text).toMatch(/FINAL DECISION: ESCALATE/);
    expect(text).toMatch(/Score alone +\S+ ALLOW/);
    expect(text).toMatch(/After critical gates +\S+ ALLOW/);
    expect(f).toMatch(/After interpretation \S+ ESCALATE policy raised it from ALLOW/);
    expect(process.exitCode).toBe(SAFETY_EXIT_CODES.incomplete);
    expect(process.exitCode).not.toBe(0);
  });
});

describe('codexrev safety assess: invalid input is not a BLOCK', () => {
  it('a malformed input file exits 1 and prints no decision at all', async () => {
    await repo.write('reports/bad.json', JSON.stringify({ evidence: { buildTests: { status: 'MAYBE' } } }));
    await handleSafetyCommand(['assess'], { action: 'deployment', target: 'development', input: 'reports/bad.json' }, repo.dir);
    expect(process.exitCode).toBe(SAFETY_EXIT_CODES.invalidInput);
    expect(process.exitCode).not.toBe(SAFETY_EXIT_CODES.block);
    expect(err.join('\n')).toMatch(/\$\.evidence\.buildTests\.status/);
    expect(stdout()).not.toMatch(/FINAL DECISION/);
  });

  it('an unreadable input file and an unusable --diff exit 1, not 11', async () => {
    await handleSafetyCommand(['assess'], { action: 'deployment', target: 'development', input: 'reports/missing.json' }, repo.dir);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await handleSafetyCommand(['assess'], { action: 'deployment', target: 'development', diff: 'no-such-ref' }, repo.dir);
    expect(process.exitCode).toBe(1);
    expect(stdout()).not.toMatch(/FINAL DECISION/);
  });

  it('missing arguments are a usage error (2), also distinct from every decision code', async () => {
    await handleSafetyCommand(['assess'], { target: 'development' }, repo.dir);
    expect(process.exitCode).toBe(SAFETY_EXIT_CODES.usage);
    expect(stdout()).not.toMatch(/FINAL DECISION/);
  });

  it('a failed assessment is reported as a failure with no decision, and exits 1 or 4', async () => {
    const bad = await runAssessmentSession({
      cwd: repo.dir,
      flags: { action: 'deployment', target: 'development' },
      policy: { decision: { id: 'bad', provisional: false, allowAtOrAbove: 0.4, escalateAtOrAbove: 0.6 } },
    });
    expect(bad.status).toBe('failed');
    const text = flat(renderAssessment(bad).join('\n'));
    expect(text).toMatch(/Decision \S+ FAILED no decision was made/);
    expect(text).toMatch(/ASSESSMENT FAILED at stage "decision engine" \(invalid input\)/);
    expect(text).toMatch(/No decision was made\. This is a failure of the assessment, NOT a BLOCK decision/);
    expect(text).not.toMatch(/FINAL DECISION/);
    expect(exitCodeForOutcome(bad.assessment)).toBe(SAFETY_EXIT_CODES.invalidInput);
    const internal: AssessmentFailure = { status: 'FAILED', stage: 'x', failureKind: 'internal_error', reason: 'boom', executed: false };
    expect(exitCodeForOutcome(internal)).toBe(SAFETY_EXIT_CODES.internalError);
    expect(SAFETY_EXIT_CODES.internalError).toBe(4);
  });
});

describe('exit-code mapping', () => {
  it('uses distinct codes for decisions, input errors, usage, incompleteness and internal errors', () => {
    const { allow, escalate, block, invalidInput, usage, incomplete, internalError } = SAFETY_EXIT_CODES;
    expect(new Set([allow, escalate, block, invalidInput, usage, incomplete, internalError]).size).toBe(7);
    expect([allow, invalidInput, usage, incomplete, internalError, escalate, block]).toEqual([0, 1, 2, 3, 4, 10, 11]);
    expect(SAFETY_EXIT_CODES.notImplemented).toBe(incomplete); // verify / history: also never 0
  });

  it('only a completed ALLOW can return 0', async () => {
    const strong = (await runAssessmentSession({ cwd: repo.dir, flags: { action: 'deployment', target: 'development' } })).assessment as AssessmentSuccess;
    const make = (status: AssessmentSuccess['status'], finalDecision: AssessmentSuccess['finalDecision']): AssessmentSuccess => ({ ...strong, status, finalDecision });
    expect(exitCodeForOutcome(make('COMPLETED', 'ALLOW'))).toBe(0);
    expect(exitCodeForOutcome(make('COMPLETED', 'ESCALATE'))).toBe(10);
    expect(exitCodeForOutcome(make('COMPLETED', 'BLOCK'))).toBe(11);
    // even a (synthetic) incomplete outcome that says ALLOW can never be an approval code
    expect(exitCodeForOutcome(make('INCOMPLETE_INTERPRETATION', 'ALLOW'))).toBe(3);
    expect(exitCodeForOutcome(make('INCOMPLETE_INTERPRETATION', 'BLOCK'))).toBe(3);
    const zeroes = [make('COMPLETED', 'ESCALATE'), make('COMPLETED', 'BLOCK'), make('INCOMPLETE_INTERPRETATION', 'ALLOW')].filter((o) => exitCodeForOutcome(o) === 0);
    expect(zeroes).toEqual([]);
  });
});

describe('codexrev safety assess: --output, signing and side effects', () => {
  it('reports that signed Evidence Pack output is unavailable, writes nothing, and does not claim to sign', async () => {
    const before = (await fs.readdir(repo.dir)).sort();
    await assess(strongInput(), 'development', { output: 'pack.json' });
    const text = stdout();
    const f = flat(text);
    expect(f).toMatch(/Signed Evidence Pack: --output .*pack\.json was given\. Signed Evidence Pack output is not available yet/);
    expect(f).toMatch(/nothing was written/);
    expect(f).toMatch(/No unsigned artifact is produced or labelled as signed/);
    expect(f).toMatch(/Signature verification and audit history are not implemented either/);
    expect(text).toMatch(/\[not implemented\] +Signed Evidence Pack/);
    expect(text).not.toMatch(/signature (is )?valid|successfully signed|verified signature/i);
    await expect(fs.access(path.join(repo.dir, 'pack.json'))).rejects.toThrow();
    expect((await fs.readdir(repo.dir)).sort()).toEqual(before);
    await expect(fs.access(path.join(repo.dir, '.codexrev'))).rejects.toThrow(); // no audit history either
  });

  it('without --output it still says no signed pack exists', async () => {
    await assess(strongInput());
    expect(flat(stdout())).toMatch(/Signed Evidence Pack: Signed Evidence Pack output is not available yet/);
  });

  it('never executes the proposed action or anything described in the input', async () => {
    const marker = path.join(repo.dir, 'EXECUTED.txt');
    const evil = `touch "${marker}"`;
    const input = strongInput({ action: { id: evil, description: evil, impact: 'low', irreversible: false } });
    await assess(input);
    await expect(fs.access(marker)).rejects.toThrow();
    const session = await runAssessmentSession({ cwd: repo.dir, flags: { action: 'deployment', target: 'development' } });
    expect(session.assessment.executed).toBe(false);
    expect(flat(stdout())).toMatch(/The proposed action was NOT executed/);
  });

  it('does not change the repository or the working tree', async () => {
    const status = await repo.git.raw(['status', '--porcelain']);
    const before = await repo.snapshotGitDir();
    await assess(strongInput());
    expect(await repo.git.raw(['status', '--porcelain'])).toBe(status);
    expect(await repo.snapshotGitDir()).toEqual(before);
  });
});

describe('codexrev safety verify and history are unchanged', () => {
  it('verify still says verification is not implemented and exits 3', async () => {
    await repo.write('reports/pack.json', '{"signature":"abc"}');
    await handleSafetyCommand(['verify'], { file: 'reports/pack.json' }, repo.dir);
    expect(stdout()).toMatch(/Signature verification is not implemented yet/);
    expect(stdout()).toMatch(/NOT verified/);
    expect(process.exitCode).toBe(3);
  });

  it('history still says audit history is not connected and exits 3', async () => {
    await handleSafetyCommand(['history'], {}, repo.dir);
    expect(stdout()).toMatch(/Audit history is not connected yet/);
    expect(process.exitCode).toBe(3);
  });
});
