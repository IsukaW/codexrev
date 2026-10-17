// End-to-end test of the complete Feature 4 demonstration: it runs the same scenario runner that the demo
// script and the documentation use, through the real command-line code, with real keys, signed artifacts,
// Git, the authorization evaluator, the safety assessment and the Evidence Pack signer/verifier.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDemo, type DemoRun, type ScenarioResult } from '../../../../src/features/action-safety/strict/demoScenarios.js';
import { isInsideGitWorktree } from '../../../../src/features/action-safety/strict/files.js';
import { loadPrivateKey } from '../../../../src/features/action-safety/strict/keyStore.js';

const T = 300_000;
const gitState = (): string => `${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim()}\n${execFileSync('git', ['status', '--porcelain'], { cwd: process.cwd() }).toString()}`;

/** the scenarios that run `verify` on an Evidence Pack instead of assessing an action */
const VERIFY_IDS = [13, 14, 15];

let demo: DemoRun;
let before: string;
const row = (id: number): ScenarioResult => {
  const s = demo.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`scenario ${id} missing`);
  return s;
};

beforeAll(async () => {
  before = gitState();
  demo = await runDemo();
}, T);
afterAll(() => demo?.cleanup());

describe('the complete demonstration', () => {
  it('runs all 15 scenarios and every one behaves as designed', () => {
    expect(demo.scenarios.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    for (const s of demo.scenarios) expect(s.observed, `#${s.id} ${s.title}`).toBe(s.expected);
    expect(demo.scenarios.every((s) => s.ok)).toBe(true);
  });

  it('demonstrates all three decisions: ALLOW, ESCALATE and BLOCK', () => {
    const decisions = new Set(demo.scenarios.filter((s) => !VERIFY_IDS.includes(s.id)).map((s) => /^(\w+)/.exec(s.observed)?.[1]));
    expect(decisions).toEqual(new Set(['ALLOW', 'ESCALATE', 'BLOCK']));
  });

  it('successful cases: a developer change and a production deployment by a release engineer, each finalized with a verified receipt', () => {
    for (const id of [1, 2]) {
      expect(row(id).output, `#${id}`).toMatch(/Authorization state:\s+FINALIZED/);
      expect(row(id).output, `#${id}`).toMatch(/Challenge consumption:\s+VERIFIED \(signed receipt verified\)/);
      expect(row(id).output, `#${id}`).toMatch(/Final Decision: ALLOW/);
    }
    expect(row(1).command).toMatch(/--as bob .*--action code_change --environment development/);
    // scenario 2: nobody else signed anything, yet the safety assessment still ran in full
    expect(row(2).command).toMatch(/--as alice .*--action deployment --environment production/);
    expect(row(2).output).toMatch(/Evidence Pack: signed and written to/);
    expect(row(2).output).not.toMatch(/approval/i);
    expect(row(2).output).toMatch(/SAFETY SCORE\s+0\.\d{3}/);
  });

  it('blocked cases are blocked for the right reasons, and consume nothing', () => {
    expect(row(3).reason).toMatch(/role_missing|permission_missing/);
    expect(row(4).reason).toMatch(/permission_missing/);
    expect(row(5).reason).toMatch(/DEVELOPER_GRANT_INVALID.*signature_verification_failed|signature_verification_failed.*DEVELOPER_GRANT_INVALID/);
    expect(row(6).reason).toMatch(/grant_expired/);
    expect(row(7).reason).toMatch(/grant_revoked/);
    expect(row(8).reason).toMatch(/unknown_signing_key.*DEVELOPER_GRANT_INVALID/);
    for (const id of [3, 4, 5, 6, 7, 8, 9]) {
      expect(row(id).output, `#${id}`).not.toMatch(/Challenge consumption:\s+VERIFIED/);
      expect(row(id).output, `#${id}`).toMatch(/Final Decision: BLOCK/);
      expect(row(id).output, `#${id}`).toMatch(/Authorization state:\s+BLOCKED/);
    }
  });

  it('a narrowed grant cannot do what its role alone would allow', () => {
    expect(row(4).setup).toMatch(/permissionScope/);
    expect(row(4).output).toMatch(/Developer grant:\s+VERIFIED/); // the grant itself is genuine
    expect(row(4).output).toMatch(/Permission:\s+FAILED/);
  });

  it('JSON self-attestation: the claims are listed as ignored, authority comes only from the signed grant', () => {
    const out = row(9).output;
    expect(out).toMatch(/Ignored claims in the input file/);
    expect(out).toMatch(/actor \(identity and roles\)/);
    expect(out).toMatch(/authority\.authorization/);
    expect(out).toMatch(/policy \(gate rules\)/);
    expect(out).toMatch(/Final Decision: BLOCK/);
    expect(out).toMatch(/\[role_missing\]/);
    expect(out).toMatch(/Authorization Gate\s+(FAIL|UNKNOWN)/); // the gate the JSON tried to switch off still ran
  });

  it('a Git commit that changes before finalization is rejected securely and consumes nothing', () => {
    const out = row(10).output;
    expect(out).toMatch(/Git context changed since authorization/);
    expect(out).toMatch(/Git context:\s+CHANGED/);
    expect(out).toMatch(/Final Decision: BLOCK/);
    expect(out).not.toMatch(/Challenge consumption:\s+VERIFIED/);
    expect(out).not.toMatch(/Final Decision: ALLOW|FINAL DECISION: ALLOW/);
  });

  it('exactly four gates and an unchanged score formula', () => {
    const out = row(2).output;
    for (const gate of ['Authorization Gate', 'Recovery Gate', 'Build/Test Gate', 'Supporting Evidence Gate']) expect(out).toContain(gate);
    expect(out).not.toContain('Human Approval Gate');
    expect(out.match(/\bGate\s+(PASS|FAIL|UNKNOWN|NOT_APPLICABLE)/g)?.length).toBe(4);
    expect(out).toMatch(/SAFETY SCORE\s+0\.\d{3}/);
    expect(out).toMatch(/0\.250\*R\(.*\) \+ 0\.250\*\(1-B\)\(.*\) \+ 0\.250\*A\(.*\) \+ 0\.250\*E\(.*\)/); // the unchanged formula, printed by the standard report
    expect(out).toMatch(/ALLOW from 0\.800/);
  });

  it('safety behavior: authorization does not override a failed gate or an intermediate score, and nothing is consumed', () => {
    const score = row(11).output;
    expect(score).toMatch(/Developer grant:\s+VERIFIED/);
    expect(score).toMatch(/Final Decision: ESCALATE/);
    expect(score).not.toMatch(/Gate\s+(FAIL|UNKNOWN)/); // every gate passed: it was the score
    expect(score).toMatch(/score-only band: ESCALATE/);
    expect(score).toMatch(/Challenge consumption:\s+NOT CONSUMED/);
    const gate = row(12).output;
    expect(gate).toMatch(/Developer grant:\s+VERIFIED/);
    expect(gate).toMatch(/Build\/Test Gate\s+(FAIL|UNKNOWN)/);
    expect(gate).toMatch(/Final Decision: BLOCK/);
    expect(gate).toMatch(/Authorization state:\s+NOT FINALIZED/);
    expect(gate).toMatch(/Challenge consumption:\s+NOT CONSUMED/);
    for (const id of [11, 12]) expect(row(id).output, `#${id}`).not.toMatch(/Final Decision: ALLOW|FINAL DECISION: ALLOW/);
  });

  it('a genuine Evidence Pack verifies offline; a tampered one and one checked against an untrusted key do not', () => {
    expect(row(13).output).toMatch(/Signature: VALID/);
    expect(row(13).output).toMatch(/Signer: TRUSTED/);
    expect(row(13).output).toMatch(/Payload Integrity: VERIFIED/);
    expect(row(13).output).toMatch(/Recorded Decision: ALLOW/);
    expect(row(13).output).toMatch(/Verification Result: VALID/);
    // the verification says what a valid signature does not mean
    expect(row(13).output).toMatch(/does not mean the action is safe, that the assessment was correct, or that anything was deployed/);

    expect(row(14).output).toMatch(/Signature: INVALID/);
    expect(row(14).output).toMatch(/Verification Result: INVALID/);
    expect(row(14).output).toMatch(/Reason: Signed content has been modified/);
    expect(row(14).output).not.toMatch(/Recorded Decision/);

    expect(row(15).output).toMatch(/Signer: UNTRUSTED/);
    expect(row(15).output).toMatch(/Verification Result: INVALID/);
    expect(row(15).output).not.toMatch(/Recorded Decision/);
  });

  it('keeps every secret out of the output and out of Git, and the real project repository is untouched', async () => {
    const keysDir = join(demo.workDir, 'keys');
    for (const name of readdirSync(keysDir).filter((n) => n.endsWith('.key')).map((n) => n.slice(0, -4))) {
      const secret = String((await loadPrivateKey({ name, keysDir, platform: 'win32' })).privateKey.export({ format: 'jwk' }).d);
      for (const s of demo.scenarios) expect(s.output + s.command + s.reason, `${name} in #${s.id}`).not.toContain(secret);
      expect(readFileSync(demo.evidencePack, 'utf-8')).not.toContain(secret);
    }
    expect(await isInsideGitWorktree(keysDir)).toBe(false); // private keys are not inside any Git working tree
    expect(await isInsideGitWorktree(join(demo.workDir, 'authority'))).toBe(false);
    expect(existsSync(join(demo.workDir, 'inventory-api', '.git'))).toBe(true); // Git writes happened only in the disposable repository
    expect(gitState()).toBe(before); // HEAD and the working-tree status of the real project did not change
  });

  it('needs no language model and no network: the interpretation was off and nothing else is contacted', () => {
    for (const s of demo.scenarios.filter((x) => !VERIFY_IDS.includes(x.id))) expect(s.output, `#${s.id}`).toMatch(/UNAVAILABLE|no model in tests/);
  });
});
