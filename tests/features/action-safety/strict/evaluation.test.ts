// The research evaluation: a small live run of the evaluation code (so it is known to work), checks on the
// committed result file (so the documentation's numbers cannot drift from a broken file), and a check that the
// documentation only uses command-line flags that the implementation really has.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEvaluation, stats, summarize, type EvaluationResult } from '../../../../src/features/action-safety/strict/evaluation.js';

const DOCS = join(process.cwd(), 'src/features/action-safety/docs');

/** invariants that every evaluation result must satisfy, live or committed */
function expectSound(r: EvaluationResult): void {
  // functional
  expect(r.functional.scenarioCount).toBe(15);
  expect(r.functional.correctPerRepetition.every((c) => c === 15)).toBe(true);
  expect(r.functional.consistentAcrossRepetitions).toBe(true);
  expect(Object.keys(r.functional.decisionCoverage).sort()).toEqual(['ALLOW', 'BLOCK', 'ESCALATE', 'INVALID', 'VALID']);
  expect(r.functional.scenarios.every((s) => s.ok && s.observed === s.expected)).toBe(true);
  // authorization enforcement
  expect(r.authorization.attackCount).toBe(17);
  expect(r.authorization.attacksAllowed).toBe(0);
  expect(r.authorization.attacks.every((a) => !a.allowed && a.decision !== 'ALLOW' && a.exitCode !== 0)).toBe(true);
  expect(r.authorization.controlsAllowed).toBe(r.authorization.controlCount);
  expect(r.authorization.attacks.every((a) => a.evidencePackAuthorizationStatus !== 'FINALIZED')).toBe(true); // an attack is never recorded as finalized
  // evidence integrity
  expect(r.evidenceIntegrity.genuineVerifies).toBe(true);
  expect(r.evidenceIntegrity.tamperDetected).toBe(r.evidenceIntegrity.tamperCount);
  expect(r.evidenceIntegrity.tamperCount).toBe(29);
  expect(r.evidenceIntegrity.untrustedSignerRejected).toBe(true);
  // explainability
  expect(r.explainability.withMeaningfulReason).toBe(r.explainability.nonAllowCount);
  expect(r.explainability.classifiedCorrectly).toBe(r.explainability.nonAllowCount);
  expect(r.explainability.authorizationFailures + r.explainability.safetyFailures).toBe(r.explainability.nonAllowCount);
  expect(r.explainability.evidencePackStatusCounts).not.toHaveProperty('FINALIZED');
  // performance: real, positive, internally consistent measurements
  for (const s of Object.values(r.performance)) {
    if (typeof s === 'string') continue;
    expect(s.n).toBe(s.samplesMs.length);
    expect(s.minMs).toBeLessThanOrEqual(s.medianMs);
    expect(s.medianMs).toBeLessThanOrEqual(s.maxMs);
    expect(s.minMs).toBeLessThanOrEqual(s.meanMs);
    expect(s.meanMs).toBeLessThanOrEqual(s.maxMs);
    expect(s.minMs).toBeGreaterThan(0);
  }
  expect(r.limitations.length).toBeGreaterThan(3);
}

describe('statistics helper', () => {
  it('computes mean, sample standard deviation, median, min and max', () => {
    const s = stats([10, 20, 30, 40]);
    expect(s).toMatchObject({ n: 4, meanMs: 25, minMs: 10, medianMs: 25, maxMs: 40 });
    expect(s.stdDevMs).toBeCloseTo(12.9, 1);
    expect(stats([5])).toMatchObject({ n: 1, meanMs: 5, stdDevMs: 0, medianMs: 5 });
    expect(stats([3, 1, 2]).medianMs).toBe(2);
  });
});

describe('the evaluation runs and its results are sound (live, small)', () => {
  it('produces measured, internally consistent results', { timeout: 600_000 }, async () => {
    const r = await runEvaluation({ demoRepetitions: 1, timingRuns: 2 });
    expectSound(r);
    expect(r.methodology).toMatchObject({ demoRepetitions: 1, timingRuns: 2, warmUpRunsDiscarded: 1 });
    expect(r.performance.developmentAssessment.n).toBe(2);
    expect(r.performance.evidencePackVerification.n).toBe(10);
    const text = summarize(r).join('\n');
    expect(text).toMatch(/0 of 17 attack attempts reached ALLOW/);
    expect(text).toMatch(/29 of 29 tampered/);
  });
});

describe('the committed result file', () => {
  const committed = JSON.parse(readFileSync(join(DOCS, 'evaluation-results.json'), 'utf-8')) as EvaluationResult;

  it('is a complete, sound evaluation (3 repetitions, 10 timed runs)', () => {
    expectSound(committed);
    expect(committed.methodology).toMatchObject({ demoRepetitions: 3, timingRuns: 10 });
    expect(committed.performance.developmentAssessment.n).toBe(10);
    expect(committed.performance.evidencePackVerification.n).toBe(30);
    expect(new Date(committed.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('is the file the evaluation document reports (the numbers quoted there are in it)', () => {
    const doc = readFileSync(join(DOCS, 'FEATURE4_EVALUATION.md'), 'utf-8');
    const p = committed.performance;
    for (const s of [p.developmentAssessment, p.productionAssessment, p.productionAssessmentWithEvidencePack, p.evidencePackVerification]) {
      expect(doc, `mean ${s.meanMs}`).toContain(String(s.meanMs));
      expect(doc, `sd ${s.stdDevMs}`).toContain(String(s.stdDevMs));
    }
    expect(doc).toContain(`${committed.authorization.attackCount}`);
    expect(doc).toContain(`${committed.evidenceIntegrity.tamperCount}`);
    expect(doc).toContain(committed.generatedAt.slice(0, 10));
  });
});

describe('the documentation matches the implementation', () => {
  const run = readFileSync(join(process.cwd(), 'src/features/action-safety/strict/run.ts'), 'utf-8');
  const real = new Set<string>();
  for (const m of run.matchAll(/'?([a-z][a-z0-9-]+)'?: \{ type: '(?:string|boolean)'/g)) real.add(m[1] as string);
  const script = new Set(['keep', 'runs', 'timing', 'out', 'help', 'strict', 'short', 'bundle', 'platform', 'format', 'packages', 'outfile',
    // flags of the MAIN CLI (`codexrev init`, `codexrev safety assess`), which the standalone tool's parser does not define
    'non-interactive', 'provider', 'model', 'api-key', 'employee-id', 'employee-name', 'app', 'action', 'target', 'input']);

  it('knows the real flags (sanity check of this test)', () => {
    for (const f of ['strict', 'dir', 'trust-root-sha256', 'evidence-pack', 'evidence-key', 'overwrite-evidence-pack', 'trusted-key', 'trusted-key-id', 'admin-key', 'keys-dir']) expect(real.has(f), f).toBe(true);
    // the per-action approval flags were removed with the approval workflow
    for (const f of ['approval', 'yes', 'minutes', 'action-id']) expect(real.has(f), f).toBe(false);
  });

  for (const file of ['FEATURE4_DEMO_GUIDE.md', 'FEATURE4_EVALUATION.md', 'FEATURE4_ARCHITECTURE.md', 'FEATURE4_PRESENTATION.md']) {
    it(`${file} uses only flags that exist`, () => {
      const text = readFileSync(join(DOCS, file), 'utf-8');
      const blocks = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] as string).join('\n');
      const used = new Set([...blocks.matchAll(/(?<![\w-])--([a-z][a-z0-9-]+)/g)].map((m) => m[1] as string));
      const unknown = [...used].filter((f) => !real.has(f) && !script.has(f));
      expect(unknown).toEqual([]);
    });
    it(`${file} does not describe the removed per-action approval workflow as part of the design`, () => {
      const text = readFileSync(join(DOCS, file), 'utf-8');
      expect(text).not.toMatch(/cx approve|--approval|approve --dir/);
      expect(text).not.toMatch(/Human approval: PASS|Human Approval Gate/);
    });
  }

  it('the documented commands are the implemented subcommands', () => {
    const guide = readFileSync(join(DOCS, 'FEATURE4_DEMO_GUIDE.md'), 'utf-8');
    for (const cmd of ['cx keygen', 'cx admin init', 'cx admin fingerprint', 'cx admin grant', 'cx admin revoke', 'cx assess --strict', 'cx verify']) expect(guide, cmd).toContain(cmd);
    for (const sub of ["group === 'keygen'", "second === 'init'", "second === 'grant'", "second === 'fingerprint'", "group === 'assess'", "group === 'verify'"]) expect(run, sub).toContain(sub);
  });
});
