/* eslint-disable no-control-regex */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSafetyCommand } from '../../../../src/features/action-safety/cli/handleSafetyCommand.js';
import { renderAssessment } from '../../../../src/features/action-safety/cli/assessmentReport.js';
import { exitCodeForOutcome } from '../../../../src/features/action-safety/cli/exitCodes.js';
import { runAssessmentSession, type AssessmentSessionOptions, type AssessmentSessionResult } from '../../../../src/features/action-safety/cli/runAssessment.js';
import { PLAIN_OPTIONS, stripAnsi, visibleLength, type RenderOptions } from '../../../../src/features/action-safety/cli/terminalStyle.js';
import type { ContextInterpretation } from '../../../../src/features/action-safety/interpretation/types.js';
import type { AssessmentSuccess } from '../../../../src/features/action-safety/pipeline/assessmentCoordinator.js';
import { FRESH, NOW, STALE, isolateModelConfig, makeRepo, type TempRepo } from '../../../../src/features/action-safety/testing/fixtures.js';

const PLAIN = PLAIN_OPTIONS;
const COLOR: RenderOptions = { color: true, unicode: false, width: 80 };
const UNICODE: RenderOptions = { color: true, unicode: true, width: 80 };

let repo: TempRepo;

const attested = (observedAt = FRESH) => ({ status: 'PASS', source: 'human_attested', observedAt, refs: ['ref:x'] });

function strong(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: { impact: 'low', irreversible: false, blastRadius: { criticality: 'low', scope: 'local', sharedModulesModified: 0, dependencyReach: 0, affectedServiceCount: 1 } },
    actor: { id: 'alice', kind: 'human', roles: ['developer'] },
    authority: {
      identityVerification: attested(), authorization: attested(), requiredRoles: ['developer'], requiredPermissions: ['deploy'],
      grantedPermissions: { permissions: ['deploy'], evidence: attested() },
    },
    reports: { buildTests: ['reports/tests.json'], security: ['reports/sec.sarif'] },
    recovery: { rollbackPlan: attested(), rollbackTest: attested(), backup: attested() },
    ...over,
  };
}

function interp(status: ContextInterpretation['status'], over: Partial<ContextInterpretation> = {}): ContextInterpretation {
  return {
    status, schemaVersion: 1,
    ...(status !== 'COMPLETED' ? { failureKind: 'server_unreachable' as const, reason: 'could not reach ollama at http://localhost:11434/v1. Start the Ollama daemon with `ollama serve` (or the desktop app).' } : {}),
    observations: [], rejectedObservations: [], injectionIndicators: [], limitations: [], advisoryOnly: true, ...over,
  };
}

let n = 0;
async function session(input: Record<string, unknown> | undefined, opts: { env?: string; interpretation?: ContextInterpretation; policy?: AssessmentSessionOptions['policy'] } = {}): Promise<AssessmentSessionResult> {
  let inputFlag: string | undefined;
  if (input) {
    inputFlag = `reports/input-${++n}.json`;
    await repo.write(inputFlag, JSON.stringify(input));
  }
  const interpretation = opts.interpretation ?? interp('UNAVAILABLE');
  return runAssessmentSession({
    cwd: repo.dir,
    flags: { action: 'deployment', target: opts.env ?? 'development', ...(inputFlag ? { input: inputFlag } : {}) },
    now: NOW,
    interpreter: async () => interpretation,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
}

const text = (s: AssessmentSessionResult, o: RenderOptions = PLAIN): string => renderAssessment(s, o).join('\n');
const flat = (s: string): string => s.replace(/\s+/g, ' ');
const lineWith = (t: string, needle: RegExp): string => t.split('\n').find((l) => needle.test(stripAnsi(l))) ?? '';
const success = (s: AssessmentSessionResult): AssessmentSuccess => {
  if (s.assessment.status === 'FAILED') throw new Error('expected a completed assessment');
  return s.assessment;
};

let allow: AssessmentSessionResult;
let escalate: AssessmentSessionResult;
let block: AssessmentSessionResult;
let staleTests: AssessmentSessionResult;
let highRisk: AssessmentSessionResult;
let incomplete: AssessmentSessionResult;
let failed: AssessmentSessionResult;
let empty: AssessmentSessionResult;

beforeAll(async () => {
  repo = await makeRepo();
  await repo.write('.gitignore', 'reports/\n');
  await repo.write('src/a.ts', 'one\n');
  await repo.commitAll('base');
  await repo.write('src/a.ts', 'one\ntwo\n');
  const tests = (ts: string) => JSON.stringify({ tool: 'vitest', kind: 'test', status: 'pass', timestamp: ts, summary: { total: 9, passed: 9, failed: 0 } });
  await repo.write('reports/tests.json', tests(FRESH));
  await repo.write('reports/tests-stale.json', tests(STALE));
  await repo.write('reports/sec.sarif', JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: FRESH }], results: [] }] }));

  allow = await session(strong());
  escalate = await session(strong(), { env: 'production' });
  const noAuth = strong();
  delete (noAuth.authority as Record<string, unknown>).authorization;
  block = await session(noAuth);
  staleTests = await session(strong({ reports: { buildTests: ['reports/tests-stale.json'], security: ['reports/sec.sarif'] } }));
  highRisk = await session(
    strong({ action: { impact: 'high', irreversible: true, destructive: true, blastRadius: { criticality: 'critical', scope: 'infrastructure_wide', sharedModulesModified: 5, dependencyReach: 50, affectedServiceCount: 10 } } }),
    { env: 'production' },
  );
  incomplete = await session(strong(), { policy: { interpretation: { mandatory: true, onFailure: 'ESCALATE' } } });
  failed = await session(strong(), { policy: { decision: { id: 'bad', provisional: false, allowAtOrAbove: 0.4, escalateAtOrAbove: 0.6 } } });
  empty = await session(undefined);
}, 120_000);

afterAll(async () => {
  await repo.remove();
});

describe('header and decision display', () => {
  it('shows ALLOW, ESCALATE and BLOCK prominently, in the header and the decision section', () => {
    for (const [s, word] of [[allow, 'ALLOW'], [escalate, 'ESCALATE'], [block, 'BLOCK']] as const) {
      const t = text(s);
      expect(t, word).toMatch(new RegExp(`Decision +\\S+ ${word}`));
      expect(t, word).toMatch(new RegExp(`FINAL DECISION: ${word}`));
    }
    expect(text(allow)).toMatch(/CodeXRev \| Action-Safety Assessment/);
    expect(text(allow)).toMatch(/Action +deployment/);
    expect(text(escalate)).toMatch(/Target +production/);
  });

  it('shows INCOMPLETE (with the conservative outcome) when a mandatory interpretation is missing', () => {
    const t = flat(text(incomplete));
    expect(t).toMatch(/Decision \S+ INCOMPLETE conservative outcome: ESCALATE/);
    expect(t).toMatch(/ASSESSMENT INCOMPLETE: local-model interpretation is mandatory by policy but UNAVAILABLE/);
    expect(t).toMatch(/The decision below is the policy's conservative outcome, not a full assessment/);
    expect(t).toMatch(/FINAL DECISION: ESCALATE/);
    expect(t).toMatch(/After interpretation \S+ ESCALATE policy raised it from ALLOW/);
    expect(t).toMatch(/Score alone \S+ ALLOW/);
  });

  it('shows a failed assessment as FAILED with no decision and no scores, and says it is not a BLOCK', () => {
    const t = flat(text(failed));
    expect(t).toMatch(/Decision \S+ FAILED no decision was made/);
    expect(t).toMatch(/ASSESSMENT FAILED at stage "decision engine" \(invalid input\)/);
    expect(t).toMatch(/No decision was made\. This is a failure of the assessment, NOT a BLOCK decision, and it must not be read as one\./);
    expect(t).not.toMatch(/FINAL DECISION/);
    expect(t).not.toMatch(/SAFETY SCORE/);
    expect(t).not.toMatch(/-- Critical safety gates/); // the section; the pipeline list below still names the stage
    expect(t).toMatch(/Provisional|Assessment only/); // notices still shown
  });

  it('puts the decision in the right color, and always with its word and a symbol', () => {
    const tone = (s: AssessmentSessionResult) => lineWith(text(s, COLOR), /FINAL DECISION/);
    expect(tone(allow)).toContain('\x1b[1;32m');
    expect(tone(escalate)).toContain('\x1b[1;33m');
    expect(tone(block)).toContain('\x1b[1;31m');
    expect(stripAnsi(tone(allow))).toMatch(/^\s+\+ FINAL DECISION: ALLOW/);
    expect(stripAnsi(tone(escalate))).toMatch(/^\s+\^ FINAL DECISION: ESCALATE/);
    expect(stripAnsi(tone(block))).toMatch(/^\s+x FINAL DECISION: BLOCK/);
    const uni = (s: AssessmentSessionResult) => stripAnsi(lineWith(text(s, UNICODE), /FINAL DECISION/));
    expect(uni(allow)).toContain('✔ FINAL DECISION: ALLOW');
    expect(uni(escalate)).toContain('▲ FINAL DECISION: ESCALATE');
    expect(uni(block)).toContain('✖ FINAL DECISION: BLOCK');
  });

  it('always says the proposed action was not executed', () => {
    for (const s of [allow, escalate, block, incomplete, failed, empty]) expect(flat(text(s)), s.status).toMatch(/The proposed action was NOT executed/);
  });
});

describe('safety score and factors', () => {
  it('shows the score, a bar, the provisional thresholds and the weighted formula with the real values', () => {
    const a = success(allow);
    const t = text(allow);
    expect(t).toMatch(new RegExp(`SAFETY SCORE +${a.safetyScore.toFixed(3)} / 1\\.000`));
    expect(t).toMatch(/score-only band: ALLOW/);
    expect(t).toMatch(/\[#+-+\]/); // plain bar
    expect(flat(t)).toMatch(/BLOCK below 0\.500 \| ESCALATE from 0\.500 to below 0\.800 \| ALLOW from 0\.800 \(thresholds "score-thresholds-provisional-v1", PROVISIONAL\)/);
    expect(t).toMatch(/weights "equal-weights-provisional-v1" \[provisional\]/);
    const terms = a.calculus.terms.map((x) => `${x.weight.toFixed(3)}*${x.symbol === 'B' ? '(1-B)' : x.symbol}(${x.termValue.toFixed(3)})`).join(' + ');
    expect(flat(t)).toContain(`= ${terms}`);
  });

  it('marks the 0.50 and 0.80 thresholds under the bar', () => {
    const t = text(allow).split('\n');
    const barIdx = t.findIndex((l) => /\[#+-+\]/.test(l));
    expect(t[barIdx + 1]).toMatch(/\|.*\|/);
    expect(t[barIdx + 2]).toMatch(/0\.50.*0\.80/);
  });

  it('shows all four factor values exactly as assessed', () => {
    const a = success(allow);
    const t = text(allow);
    for (const [label, id] of [['Reversibility \\(R\\)', 'reversibility'], ['Blast radius \\(B\\)', 'blastRadius'], ['Authority \\(A\\)', 'authority'], ['Evidence strength \\(E\\)', 'evidenceStrength']] as const) {
      expect(t, id).toMatch(new RegExp(`${label} +${a.factors[id].score.toFixed(3)}`));
    }
  });

  it('states that a higher Blast Radius means higher risk, and shows the 1-B value used', () => {
    const a = success(allow);
    const t = flat(text(allow));
    expect(t).toMatch(new RegExp(`higher = RISKIER \\(counts as 1-B = ${a.calculus.adjustedBlastRadius.toFixed(3)}\\)`));
    expect(t).toMatch(/For blast radius a LONGER bar means MORE risk/);
    expect(t.match(/higher = safer/g)?.length).toBe(3);
  });

  it('colors blast radius by RISK: a small radius is green, a large one is red (never the other way)', () => {
    const lowRisk = lineWith(text(allow, COLOR), /Blast radius \(B\)/);
    const highRiskRow = lineWith(text(highRisk, COLOR), /Blast radius \(B\)/);
    expect(success(allow).factors.blastRadius.score).toBeLessThan(0.2);
    expect(success(highRisk).factors.blastRadius.score).toBeGreaterThan(0.8);
    expect(lowRisk).toContain('\x1b[32m');
    expect(lowRisk).not.toContain('\x1b[31m');
    expect(highRiskRow).toContain('\x1b[31m');
    expect(highRiskRow).not.toContain('\x1b[32m');
    // while for the "higher is safer" factors, a LOW value is red
    expect(lineWith(text(highRisk, COLOR), /Reversibility \(R\)/)).toContain('\x1b[31m');
    expect(lineWith(text(allow, COLOR), /Reversibility \(R\)/)).toContain('\x1b[32m');
  });

  it('colors the score by its band', () => {
    expect(lineWith(text(allow, COLOR), /SAFETY SCORE/)).toContain('\x1b[1;32m');
    expect(lineWith(text(escalate, COLOR), /SAFETY SCORE/)).toContain('\x1b[1;33m');
    expect(lineWith(text(highRisk, COLOR), /SAFETY SCORE/)).toContain('\x1b[1;31m');
  });
});

describe('critical safety gates', () => {
  it('shows all four gates with evidence status and effect, in an aligned table', () => {
    const t = text(block);
    const rows = ['Authorization', 'Verified recovery', 'Build/test results', 'Supporting evidence'].map((l) => lineWith(t, new RegExp(`^\\s+\\S ${l}`)));
    for (const r of rows) expect(r, r).not.toBe('');
    // aligned: every row's EVIDENCE column starts at the same offset
    const cols = rows.map((r) => r.search(/ (PASS|FAIL|UNKNOWN|NOT_APPLICABLE) /));
    expect(new Set(cols).size).toBe(1);
    expect(rows[0]).toMatch(/Authorization +FAIL +x BLOCK/);
    expect(t).not.toMatch(/Human approval/);
    expect(rows[1]).toMatch(/Verified recovery +NOT_APPLICABLE +not required/);
    expect(t).toMatch(/GATE +EVIDENCE +EFFECT/);
  });

  it('shows the effect of each failing gate: BLOCK vs ESCALATE', () => {
    const t = text(empty);
    expect(lineWith(t, /Authorization +FAIL/)).toMatch(/x BLOCK/);
    expect(lineWith(t, /Supporting evidence +(FAIL|UNKNOWN)/)).toMatch(/\^ ESCALATE/);
  });

  it('never presents UNKNOWN as PASS: stale evidence shows ? UNKNOWN with its BLOCK effect', () => {
    const row = lineWith(text(staleTests), /Build\/test results/);
    expect(row).toMatch(/\? Build\/test results +UNKNOWN +x BLOCK/);
    expect(row).not.toMatch(/PASS/);
    expect(row).not.toMatch(/^\s+\+/);
    expect(lineWith(text(staleTests, COLOR), /Build\/test results +/)).toContain('\x1b[1;33mUNKNOWN');
    expect(lineWith(text(staleTests, COLOR), /Build\/test results +/)).not.toContain('\x1b[1;32mPASS');
  });

  it('colors PASS green, FAIL red, UNKNOWN yellow and NOT_APPLICABLE gray, each also a word', () => {
    const t = text(block, COLOR);
    expect(lineWith(t, /Authorization +FAIL/)).toContain('\x1b[1;31mFAIL');
    expect(lineWith(t, /Build\/test results +PASS/)).toContain('\x1b[1;32mPASS');
    expect(lineWith(t, /Verified recovery/)).toContain('\x1b[90mNOT_APPLICABLE');
    expect(lineWith(text(staleTests, COLOR), /Build\/test results +/)).toContain('\x1b[1;33mUNKNOWN');
  });

  it('shows each gate explanation as a short line under it', () => {
    const t = flat(text(block));
    expect(t).toMatch(/Authorization for actor "alice" is required but no record was provided\./);
    expect(t).toMatch(/Build\/test results confirmed\./);
  });

  it('uses a stacked layout on a narrow terminal and still shows every status and effect', () => {
    const t = text(block, { ...PLAIN, width: 44 });
    expect(t).not.toMatch(/GATE +EVIDENCE +EFFECT/);
    expect(t).toMatch(/x Authorization\n\s+evidence FAIL\s+effect x BLOCK/);
    expect(t).toMatch(/- Verified recovery\n\s+evidence NOT_APPLICABLE\s+effect not required/);
  });
});

describe('evidence summary', () => {
  it('lists git, dependencies, build/test, security, authority and recovery', () => {
    const t = text(allow);
    for (const label of ['Git changes', 'Dependencies', 'Build/test', 'Security', 'Authority', 'Recovery']) expect(t, label).toContain(label);
    expect(t).toMatch(/Git changes +1 changed file\(s\) \(0 staged, 1 unstaged, 0 untracked\)/);
    expect(t).toMatch(/Dependencies +0 change\(s\)/);
    expect(t).toMatch(/Build\/test +PASS/);
  });

  it('shows nothing-supplied evidence as UNKNOWN, not PASS', () => {
    const t = text(empty);
    expect(t).toMatch(/Build\/test +UNKNOWN \(nothing supplied\)/);
    expect(t).toMatch(/Security +UNKNOWN \(nothing supplied\)/);
    expect(t).toMatch(/Authority +UNKNOWN \(nothing supplied\)/);
    expect(t).toMatch(/Recovery +UNKNOWN \(nothing supplied\)/);
  });
});

describe('local model interpretation', () => {
  it('shows an unavailable provider with a readable, wrapped reason and no invented observations', () => {
    const t = text(allow);
    expect(t).toMatch(/Local model interpretation \(advisory, UNVERIFIED\)/);
    expect(t).toMatch(/Status +UNAVAILABLE/);
    expect(t).toMatch(/Reason +could not reach ollama/);
    expect(flat(t)).toMatch(/No observations were produced, and none were invented\./);
    for (const l of t.split('\n')) expect(l.length, l).toBeLessThanOrEqual(80);
  });

  it('shows ERROR and INVALID_RESPONSE statuses with their reasons', async () => {
    const err = await session(strong(), { interpretation: interp('ERROR', { failureKind: 'timeout', reason: 'the model did not answer in time' }) });
    const inv = await session(strong(), { interpretation: interp('INVALID_RESPONSE', { failureKind: 'schema_violation', reason: '$.observations[0].category: must be one of: evidence_gap' }) });
    expect(text(err)).toMatch(/Status +ERROR/);
    expect(flat(text(err))).toContain('the model did not answer in time');
    expect(text(inv)).toMatch(/Status +INVALID_RESPONSE/);
    expect(flat(text(inv))).toContain('must be one of: evidence_gap');
    expect(lineWith(text(err, COLOR), /Status +ERROR/)).toContain('\x1b[1;31mERROR');
    expect(lineWith(text(allow, COLOR), /Status +UNAVAILABLE/)).toContain('\x1b[1;33mUNAVAILABLE');
  });

  it('labels observations advisory and unverified, and shows them concisely', async () => {
    const done = await session(strong(), {
      interpretation: interp('COMPLETED', {
        summary: 'One migration needs a human look.',
        provider: { id: 'ollama', model: 'qwen2.5', local: true },
        observations: [
          { id: 'o1', category: 'data_loss_or_migration', kind: 'concern', significance: 'high', description: 'A migration drops the audit_log table.', references: ['src/a.ts'], verified: false, source: 'llm_interpretation' },
          { id: 'o2', category: 'evidence_gap', kind: 'information_gap', significance: 'low', description: 'No rollback test was supplied.', references: [], verified: false, source: 'llm_interpretation' },
        ],
        rejectedObservations: [{ index: 2, reason: 'fabricated' }],
        injectionIndicators: ['diffExcerpts[0].excerpt: ignore-previous-instructions'],
      }),
    });
    const t = text(done);
    const f = flat(t);
    expect(t).toMatch(/Status +COMPLETED +model "qwen2\.5" via ollama \(local\)/);
    expect(f).toMatch(/One migration needs a human look\. \(unverified\)/);
    expect(f).toMatch(/2 observation\(s\), none of them verified/);
    expect(t).toMatch(/\[HIGH\] data_loss_or_migration . concern . unverified/);
    expect(t).toMatch(/\[LOW\] evidence_gap . information gap . unverified/);
    expect(f).toMatch(/A migration drops the audit_log table\./);
    expect(f).toMatch(/refs: src\/a\.ts/);
    expect(f).toMatch(/1 observation\(s\) dropped for citing evidence that does not exist/);
    expect(f).toMatch(/Possible prompt-injection text found in 1 place\(s\); it was treated as data/);
    expect(f).toMatch(/Advisory only: these observations are not evidence and cannot change a score, a gate or a decision\./);
    // an observation never changes the displayed decision
    expect(text(done)).toMatch(/FINAL DECISION: ALLOW/);
  });
});

describe('decision explanation and details: nothing material is dropped', () => {
  it('shows the three decision stages separately, with what changed each', () => {
    const t = text(block);
    expect(t).toMatch(/Score alone +\S+ ALLOW/);
    expect(t).toMatch(/After critical gates +\S+ BLOCK +the gates changed it from ALLOW/);
    expect(t).toMatch(/After interpretation +\S+ BLOCK +advisory: no effect/);
    expect(t).toMatch(/Interpretation policy: advisory \(the local model cannot change the decision\)/);
  });

  it('gives short "Why" bullets, including each triggered gate', () => {
    const t = flat(text(block));
    expect(t).toMatch(/Why \* Safety score 0\.\d{3} maps to ALLOW/);
    expect(t).toMatch(/\* Authorization gate FAILED and requires BLOCK: /);
  });

  it('preserves every reason code, grouped', () => {
    for (const s of [allow, escalate, block, incomplete, empty]) {
      const t = flat(text(s));
      for (const code of success(s).reasonCodes) expect(t, code).toContain(code);
    }
    const t = text(incomplete);
    expect(t).toMatch(/Score +SCORE_AT_OR_ABOVE_ALLOW_THRESHOLD/);
    expect(t).toMatch(/Gates +ALL_GATES_CLEAR/);
    expect(flat(t)).toMatch(/Interpretation INTERPRETATION_UNAVAILABLE_MANDATORY INTERPRETATION_POLICY_RAISED_DECISION/);
    expect(flat(t)).toMatch(/Final FINAL_ALLOW FINAL_DECISION_ESCALATE/);
  });

  it('keeps the full explanation, split into sentences, without repeating the same sentence', () => {
    for (const s of [allow, block, incomplete]) {
      const a = success(s);
      const f = flat(text(s));
      const sentences = a.explanation.split(/(?<=[.!?])\s+(?=[A-Z"(])/).map((x) => x.trim());
      expect(f, 'explanation start').toContain('Score: the Safety Score');
      expect(f).toContain('The proposed action was NOT executed.');
      expect(sentences.length).toBeGreaterThan(3);
    }
    const lines = text(allow).split('\n').filter((l) => /^\s+\* Final decision: ALLOW\.$/.test(l));
    expect(lines).toHaveLength(1); // the engine and coordinator both say it; the report says it once
  });

  it('groups missing, unknown and conflicting evidence by category, with every item', () => {
    const t = text(empty);
    const a = success(empty);
    expect(t).toMatch(/Missing, unknown or conflicting evidence \(\d+\):/);
    expect(t).toMatch(/Reversibility \(R\)\n\s+missing +/);
    expect(t).toMatch(/Authority \(A\)/);
    const f = flat(t);
    for (const item of [...a.evidenceGaps.missing, ...a.evidenceGaps.uncertain].slice(0, 4)) {
      expect(f, item).toContain(item.replace(/^\[[A-Za-z]+\]\s*/, ''));
    }
    expect(flat(text(allow))).toMatch(/No missing, unknown or conflicting evidence was reported by the assessors\./);
  });

  it('shows assumptions and limitations, capping long lists with an explicit count', () => {
    const t = text(empty);
    const a = success(empty);
    expect(t).toMatch(/Assumptions made because the input was silent:/);
    expect(flat(t)).toMatch(/assumed "high"/);
    expect(t).toMatch(new RegExp(`Limitations \\(${a.limitations.length}\\):`));
    for (const l of a.limitations.slice(0, 3)) expect(flat(t)).toContain(l.slice(0, 40));
  });

  it('shows the provisional policy notice, the assessment-only notice and the signing status', () => {
    for (const s of [allow, block, failed]) {
      const f = flat(text(s));
      expect(f).toMatch(/Assessment only: the proposed action was NOT executed\./);
      expect(f).toMatch(/Signed Evidence Pack: Signed Evidence Pack output is not available yet/);
      expect(f).toMatch(/Signature verification and audit history are not implemented either/);
    }
    expect(flat(text(allow))).toMatch(/Provisional policy notice: Provisional research values are in use: weights "equal-weights-provisional-v1", score thresholds "score-thresholds-provisional-v1", the default gate policy/);
    expect(text(allow)).toMatch(/\[not implemented\] +Signed Evidence Pack/);
    expect(text(allow)).toMatch(/\[connected\] +Final decision/);
  });
});

describe('color, plain text and wrapping', () => {
  it('plain output contains no escape codes and only printable ASCII', () => {
    for (const s of [allow, escalate, block, incomplete, failed, empty]) {
      const t = text(s); // default options
      expect(t).not.toMatch(/\x1b/);
      expect(/^[\x20-\x7e\n]*$/.test(t)).toBe(true);
    }
  });

  it('with color on, stripping the codes gives exactly the plain layout (styling cannot break alignment)', () => {
    for (const s of [allow, escalate, block, incomplete, failed, empty, staleTests, highRisk]) {
      const colored = text(s, COLOR);
      expect(colored).toMatch(/\x1b\[/);
      expect(stripAnsi(colored)).toBe(text(s, { ...COLOR, color: false }));
    }
  });

  it('uses Unicode symbols, blocks and rules only when asked', () => {
    const t = stripAnsi(text(allow, UNICODE));
    expect(t).toContain('█');
    expect(t).toContain('░');
    expect(t).toContain('─');
    expect(t).toContain('✔');
    expect(text(allow)).not.toMatch(/[█░─✔]/);
  });

  it('never exceeds the terminal width, at any width, with or without color', () => {
    for (const width of [40, 52, 60, 80, 100]) {
      for (const opts of [{ color: false, unicode: false }, { color: true, unicode: true }]) {
        for (const s of [allow, block, incomplete, failed, empty]) {
          for (const line of renderAssessment(s, { ...opts, width })) {
            expect(visibleLength(line), `width ${width}: "${stripAnsi(line)}"`).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it('wraps long explanations and reasons at narrow widths without losing words', () => {
    const wide = flat(text(block, { ...PLAIN, width: 100 }));
    const narrow = flat(text(block, { ...PLAIN, width: 40 }));
    expect(narrow).toContain('Authorization for actor "alice" is required but no record was provided.');
    expect(flat(text(allow, { ...PLAIN, width: 40 }))).toContain('could not reach ollama at http://localhost:11434/v1.');
    for (const word of ['Safety score', 'FINAL DECISION: BLOCK', 'Reason codes', 'Assumptions made', 'Signed Evidence Pack']) {
      expect(narrow, word).toContain(word.split(' ')[0]);
    }
    expect(wide.length).toBeGreaterThan(0);
  });

  it('keeps the factor table readable on a narrow terminal', () => {
    const t = text(allow, { ...PLAIN, width: 40 });
    expect(t).toMatch(/Reversibility \(R\) +0\.\d{3} +\[#+-*\]/);
    expect(t).toMatch(/Evidence strength \(E\) +0\.\d{3}/);
    for (const l of t.split('\n')) expect(l.length).toBeLessThanOrEqual(40);
  });
});

describe('formatting never changes the assessment', () => {
  it('does not modify the session, and the displayed numbers are the assessed numbers', () => {
    const before = JSON.stringify(allow);
    text(allow, COLOR);
    text(allow, UNICODE);
    text(allow, { ...PLAIN, width: 40 });
    expect(JSON.stringify(allow)).toBe(before);
  });

  it('is deterministic for the same session and options', () => {
    expect(text(block, COLOR)).toBe(text(block, COLOR));
    expect(text(block, PLAIN)).toBe(text(block, PLAIN));
  });

  it('shows the same facts in every rendering mode', () => {
    const facts = (t: string): string[] => ['0.760', 'FINAL DECISION: ALLOW', 'SCORE_AT_OR_ABOVE_ALLOW_THRESHOLD', 'NOT_APPLICABLE', 'PASS'].filter((x) => flat(stripAnsi(t)).includes(x));
    expect(facts(text(allow, PLAIN))).toEqual(facts(text(allow, COLOR)));
    expect(facts(text(allow, PLAIN))).toEqual(facts(text(allow, UNICODE)));
    expect(facts(text(allow, PLAIN)).length).toBe(5);
  });

  it('decisions and exit codes are the same as the assessment says, whatever the formatting', () => {
    expect(success(allow).finalDecision).toBe('ALLOW');
    expect(success(escalate).finalDecision).toBe('ESCALATE');
    expect(success(block).finalDecision).toBe('BLOCK');
    expect([allow, escalate, block, incomplete, failed].map((s) => exitCodeForOutcome(s.assessment))).toEqual([0, 10, 11, 3, 1]);
  });
});

describe('the command applies the terminal environment', () => {
  let restore: () => void;
  let out: string[];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    restore = isolateModelConfig();
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    for (const k of ['NO_COLOR', 'FORCE_COLOR']) saved[k] = process.env[k];
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restore();
    for (const k of ['NO_COLOR', 'FORCE_COLOR']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    process.exitCode = undefined;
  });

  // the command reads the REAL clock, so this scenario's evidence must be fresh relative to now, not to the fixed fixture date
  const live = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
  const run = async () => {
    const claim = { status: 'PASS', source: 'human_attested', observedAt: live(1), refs: ['ref:x'] };
    await repo.write('reports/tests-live.json', JSON.stringify({ tool: 'vitest', kind: 'test', status: 'pass', timestamp: live(1), summary: { total: 9, passed: 9, failed: 0 } }));
    await repo.write('reports/sec-live.sarif', JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, invocations: [{ endTimeUtc: live(1) }], results: [] }] }));
    const input = strong({
      authority: {
        identityVerification: claim, authorization: claim, requiredRoles: ['developer'], requiredPermissions: ['deploy'],
        grantedPermissions: { permissions: ['deploy'], evidence: claim },
      },
      reports: { buildTests: ['reports/tests-live.json'], security: ['reports/sec-live.sarif'] },
      recovery: { rollbackPlan: claim, rollbackTest: claim, backup: claim },
    });
    await repo.write('reports/cmd.json', JSON.stringify(input));
    await handleSafetyCommand(['assess'], { action: 'deployment', target: 'production', input: 'reports/cmd.json' }, repo.dir);
    return { text: out.join('\n'), code: process.exitCode };
  };

  it('prints plain text when output is not a terminal (the test runner is not one)', async () => {
    const r = await run();
    expect(r.text).not.toMatch(/\x1b/);
    expect(r.code).toBe(10);
  });

  it('FORCE_COLOR adds color, NO_COLOR removes it again, and the decision and exit code do not change', { timeout: 60_000 }, async () => {
    const plain = await run();
    out = [];
    process.env.FORCE_COLOR = '1';
    const forced = await run();
    expect(forced.text).toMatch(/\x1b\[/);
    expect(stripAnsi(forced.text)).toBe(plain.text.replace(/input-\d+/g, 'input-N').replace(/cmd\.json/g, 'cmd.json'));
    out = [];
    process.env.NO_COLOR = '1';
    const noColor = await run();
    expect(noColor.text).not.toMatch(/\x1b/);
    expect(noColor.code).toBe(forced.code);
    expect(forced.code).toBe(plain.code);
    expect(forced.code).toBe(10);
  });
});
