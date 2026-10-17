/**
 * The Feature 4 demonstration, as code. It builds a disposable world (fictional company "acme", developer
 * alice, developer bob, application inventory-api) in a temporary folder and runs every scenario through the
 * SAME command-line code the real tool uses (`runStrictCli`): real Ed25519 keys, real signed role-based grants,
 * the real Git action collector, the real authorization evaluator, the real safety assessment and
 * the real Evidence Pack signer and verifier.
 *
 * What is NOT real, deliberately:
 *   - the clock is fixed (so results are reproducible) and moved forward for the "expired grant" scenario;
 *   - the optional local-language-model interpretation is switched off: it is advisory and not part of
 *     authorization, so the demonstration needs no model, API or network.
 * Private keys are created in the disposable folder (never inside a Git repository) and deleted with it.
 * Git commits happen only inside the disposable repository.
 *
 * Each scenario records what was EXPECTED (from the design) and what was OBSERVED (parsed from the real
 * command output and exit code); nothing is filled in by hand.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signEnvelope } from '../authorization/envelope.js';
import { NOW, commitChange, copyDir, later, makeRepo, noInterpretation, writeEvidence } from '../testing/strictFixture.js';
import { loadPrivateKey } from './keyStore.js';
import { runStrictCli } from './run.js';

export interface ScenarioResult {
  readonly id: number;
  readonly title: string;
  readonly setup: string;
  /** the command, with the disposable folder shortened to <demo> */
  readonly command: string;
  readonly expected: string;
  readonly observed: string;
  readonly reason: string;
  readonly ok: boolean;
  /** the complete output of the command, for inspection and tests (not printed by the demo) */
  readonly output: string;
}

export interface DemoRun {
  readonly workDir: string;
  readonly scenarios: readonly ScenarioResult[];
  /** the signed Evidence Pack from scenario 2 and the tampered copy from scenario 14 */
  readonly evidencePack: string;
  readonly tamperedPack: string;
  cleanup(): void;
}

interface Outcome {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

const b64urlToText = (s: string): string => Buffer.from(s, 'base64url').toString('utf-8');
const textToB64url = (s: string): string => Buffer.from(s, 'utf-8').toString('base64url');

/** Changes the signed content of an envelope file WITHOUT re-signing it: what a person editing the file can do. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function editSignedPayload(file: string, target: string, change: (doc: Record<string, any>) => void): void {
  const envelope = JSON.parse(readFileSync(file, 'utf-8'));
  const doc = JSON.parse(b64urlToText(envelope.payload));
  change(doc);
  envelope.payload = textToB64url(JSON.stringify(doc));
  writeFileSync(target, JSON.stringify(envelope));
}

export async function runDemo(options: { readonly workDir?: string } = {}): Promise<DemoRun> {
  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'codexrev-demo-'));
  const keys = join(workDir, 'keys');
  const authority = join(workDir, 'authority');
  const repo = join(workDir, 'inventory-api');
  const evidenceDir = join(workDir, 'evidence');
  const storeDir = join(workDir, 'challenge-store');
  const forgedDir = join(workDir, 'forged');
  for (const d of [evidenceDir, forgedDir]) mkdirSync(d, { recursive: true });
  const short = (s: string): string => s.split(workDir).join('<demo>');

  const cli = async (argv: string[], now: Date = NOW): Promise<Outcome> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runStrictCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), now: () => now, hooks: { interpreter: noInterpretation } });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const must = async (argv: string[]): Promise<Outcome> => {
    const r = await cli(argv);
    if (r.code !== 0) throw new Error(`demo setup failed: ${argv.slice(0, 2).join(' ')}: ${r.err}`);
    return r;
  };

  // ---------------------------------------------------------------- setup (all through the real commands)
  for (const name of ['admin', 'store', 'runner', 'alice', 'bob', 'carol', 'dave', 'erin', 'mallory']) await must(['keygen', '--name', name, '--keys-dir', keys]);
  await must(['admin', 'init', '--org', 'acme', '--dir', authority, '--admin-key', 'admin', '--store-key', 'store', '--keys-dir', keys]);
  const pin = (await must(['admin', 'fingerprint', '--dir', authority])).out.trim();
  const grant = async (subject: string, role: string, days: number): Promise<string> => {
    const r = await must(['admin', 'grant', '--dir', authority, '--admin-key', 'admin', '--keys-dir', keys, '--subject', subject, '--pubkey', join(keys, `${subject}.pub.json`), '--level', role, '--days', String(days)]);
    return /Issued grant (\S+)/.exec(r.out)?.[1] ?? '';
  };
  await grant('alice', 'L4', 30);
  await grant('bob', 'L1', 30);
  const daveGrant = await grant('dave', 'L1', 30);
  await grant('erin', 'L1', 1);
  await must(['admin', 'grant', '--dir', authority, '--admin-key', 'admin', '--keys-dir', keys, '--subject', 'carol', '--pubkey', join(keys, 'carol.pub.json'), '--level', 'L4', '--days', '30', '--permission-scope', 'code.modify']);
  makeRepo(repo); // a disposable repository: the only place Git writes happen
  writeEvidence(repo, NOW);

  const assessArgs = (o: { as: string; action: string; environment: string; repo?: string; grantFile?: string; pack?: string; extra?: string[] }): string[] => [
    'assess', '--strict', '--dir', authority, '--trust-root-sha256', pin, '--keys-dir', keys, '--store-dir', storeDir, '--repo', o.repo ?? repo, '--input', 'reports/input.json',
    '--as', o.as, '--action', o.action, '--environment', o.environment, '--target', 'inventory-api',
    ...(o.grantFile ? ['--grant-file', o.grantFile] : []),
    ...(o.pack ? ['--evidence-pack', o.pack, '--evidence-key', 'runner'] : []), ...(o.extra ?? []),
  ];

  const scenarios: ScenarioResult[] = [];
  const decisionOf = (r: Outcome): string => /Final Decision: (ALLOW|ESCALATE|BLOCK)/.exec(r.out)?.[1] ?? `no decision (exit ${r.code})`;
  /** why, in one line, from what the command itself printed */
  const firstReason = (r: Outcome): string => {
    const lines = r.out.split('\n');
    const i = lines.findIndex((l) => l.startsWith('Reasons:'));
    const block: string[] = [];
    if (i >= 0) for (const l of lines.slice(i + 1)) { if (l.trim() === '') break; block.push(l); }
    const bullets = block.filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2));
    const parts: string[] = [];
    // the first reasons about authorization itself, then which safety gates stopped it, then the score
    parts.push(...bullets.filter((b) => !b.startsWith('Safety gate') && !b.startsWith('Safety Score')).slice(0, 2));
    const failing = lines.filter((l) => /^\S.* Gate\s+(FAIL|UNKNOWN)(\s|$)/.test(l)).map((l) => l.replace(/\s+/g, ' ').trim());
    if (failing.length > 0) parts.push(`gates not passing: ${failing.join(', ')}`);
    const band = /score-only band: (\w+)/.exec(r.out)?.[1];
    const score = /Safety Score: ([0-9.]+)/.exec(r.out)?.[1];
    if (score) parts.push(`safety score ${score}${band ? ` (score-only band: ${band})` : ''}`);
    if (r.out.includes('Ignored claims in the input file')) parts.push('the claims typed into the input file were ignored');
    return parts.join(' | ');
  };
  const record = (id: number, title: string, setup: string, argv: string[], expected: string, r: Outcome, observed: string, reason: string): void => {
    scenarios.push({ id, title, setup, command: short(`codexrev-strict ${argv.join(' ')}`), expected, observed, reason: short(reason), ok: expected === observed, output: r.err ? `${r.out}\n${r.err}` : r.out });
  };
  const assessScenario = async (id: number, title: string, setup: string, argv: string[], expected: 'ALLOW' | 'ESCALATE' | 'BLOCK', now: Date = NOW, run: (argv: string[], now: Date) => Promise<Outcome> = cli): Promise<Outcome> => {
    const r = await run(argv, now);
    const exit = { ALLOW: 0, ESCALATE: 10, BLOCK: 11 }[expected];
    const decision = decisionOf(r);
    record(id, title, setup, argv, `${expected} (exit ${exit})`, r, `${decision} (exit ${r.code})`, firstReason(r));
    return r;
  };

  const grantFileOf = (subject: string): string => {
    const name = readdirSync(join(authority, 'grants')).find((n) => n.startsWith(`grant-${subject}-`));
    if (!name) throw new Error(`no grant file for ${subject}`);
    return join(authority, 'grants', name);
  };

  // ---------------------------------------------------------------- 1 and 2: authorized actions
  await assessScenario(1, 'Authorized developer, safe code change', 'bob holds a signed L1 grant (code.modify); code_change in development is within L1', assessArgs({ as: 'bob', action: 'code_change', environment: 'development' }), 'ALLOW');
  const pack = join(evidenceDir, 'assessment-evidence.json');
  await assessScenario(2, 'Authorized release engineer, production deployment without a separate approval', 'alice holds a signed L4 grant (deployment.production); nobody else signs anything, and the Safety Score and every gate must still pass', assessArgs({ as: 'alice', action: 'deployment', environment: 'production', pack }), 'ALLOW');

  // ---------------------------------------------------------------- 3 and 4: outside the permissions
  await assessScenario(3, 'Developer without the production permission', 'bob holds a signed L1 grant, which has no deployment.production permission', assessArgs({ as: 'bob', action: 'deployment', environment: 'production' }), 'BLOCK');
  await assessScenario(4, "Action outside the grant's permission scope", 'carol holds an L4 grant that the administrator narrowed to code.modify only (permissionScope), so deployment.production is outside it', assessArgs({ as: 'carol', action: 'deployment', environment: 'production' }), 'BLOCK');

  // ---------------------------------------------------------------- 5 to 8: invalid grants
  const tamperedGrant = join(forgedDir, 'bob.tampered.grant.json');
  editSignedPayload(grantFileOf('bob'), tamperedGrant, (d) => { d.expiresAt = '2035-01-01T00:00:00Z'; d.roles = ['l5']; });
  await assessScenario(5, 'Tampered developer grant', 'bob edited his own grant file (L1 raised to L5, longer expiry); the administrator signature no longer matches', assessArgs({ as: 'bob', action: 'deployment', environment: 'production', grantFile: tamperedGrant }), 'BLOCK');
  await assessScenario(6, 'Expired grant', "erin's grant was issued for 1 day; the assessment is run two days later (the demo moves its clock forward)", assessArgs({ as: 'erin', action: 'code_change', environment: 'development' }), 'BLOCK', later(2));
  await must(['admin', 'revoke', '--dir', authority, '--admin-key', 'admin', '--keys-dir', keys, '--grant', daveGrant]);
  await assessScenario(7, 'Revoked grant', "the administrator added dave's grant to the signed revocation list", assessArgs({ as: 'dave', action: 'code_change', environment: 'development' }), 'BLOCK');
  // a grant whose content is genuine but whose signature was made with a key the trust root does not list
  const forgedGrant = join(forgedDir, 'alice.forged-admin.grant.json');
  {
    const malloryKey = await loadPrivateKey({ name: 'mallory', keysDir: keys });
    const original = JSON.parse(readFileSync(grantFileOf('alice'), 'utf-8'));
    writeFileSync(forgedGrant, JSON.stringify(signEnvelope({ domain: 'grant', payload: Buffer.from(original.payload, 'base64url'), privateKey: malloryKey.privateKey })));
  }
  await assessScenario(8, 'Forged administrator signature', "a grant for alice was re-signed with mallory's key, which is not an administrator key in the trust root", assessArgs({ as: 'alice', action: 'deployment', environment: 'production', grantFile: forgedGrant }), 'BLOCK');

  // ---------------------------------------------------------------- 9: JSON self-attestation
  writeEvidence(repo, NOW, { claims: true });
  await assessScenario(9, 'Self-declared authority in JSON', "bob's input file claims he is level L5, \"authorized\", and switches the authorization gate off", assessArgs({ as: 'bob', action: 'deployment', environment: 'production' }), 'BLOCK');

  // ---------------------------------------------------------------- 10: Git binding
  const moved = join(workDir, 'inventory-api-moved');
  writeEvidence(repo, NOW);
  copyDir(repo, moved);
  const withGitChange = async (argv: string[], now: Date): Promise<Outcome> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runStrictCli(argv, {
      out: (l) => out.push(l), err: (l) => err.push(l), now: () => now,
      // the repository moves to a NEW commit after the assessment looked at it and before the challenge is consumed (Git write: disposable copy only)
      hooks: { interpreter: noInterpretation, beforeFinalization: () => commitChange(moved) },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  await assessScenario(10, 'Git commit changes before finalization', 'alice is fully authorized and the assessment says ALLOW, but the repository moves to a new commit before the authorization is finalized', assessArgs({ as: 'alice', action: 'deployment', environment: 'production', repo: moved }), 'BLOCK', NOW, withGitChange);

  // ---------------------------------------------------------------- 11 and 12: the safety assessment still decides
  writeEvidence(repo, NOW, { extra: { action: { impact: 'high', irreversible: false, blastRadius: { criticality: 'critical', scope: 'database_wide', sharedModulesModified: 8, dependencyReach: 40, affectedServiceCount: 12 } } } });
  await assessScenario(11, 'Authorized action with an intermediate Safety Score', 'alice is fully authorized and every gate passes, but the stated blast radius is large, so the Safety Score falls into the ESCALATE band', assessArgs({ as: 'alice', action: 'code_change', environment: 'development' }), 'ESCALATE');
  writeEvidence(repo, NOW, { buildTests: false });
  await assessScenario(12, 'Authorized action with a failed mandatory gate', 'alice is fully authorized, but no build/test report exists, so the Build/Test gate cannot pass', assessArgs({ as: 'alice', action: 'code_change', environment: 'development' }), 'BLOCK');
  writeEvidence(repo, NOW);

  // ---------------------------------------------------------------- 13 to 15: the Evidence Pack
  const verifyArgs = (file: string, key = 'runner'): string[] => ['verify', '--evidence-pack', file, '--trusted-key', join(keys, `${key}.pub.json`)];
  const v13 = await cli(verifyArgs(pack));
  record(13, 'A genuine signed Evidence Pack verifies offline', 'the pack written by scenario 2; the verifier trusts only the runner public key file', verifyArgs(pack), 'VALID (exit 0)', v13, `${/Verification Result: (\w+)/.exec(v13.out)?.[1]} (exit ${v13.code})`, `${/Signature: (.*)/.exec(v13.out)?.[0]}; ${/Recorded Decision: (.*)/.exec(v13.out)?.[0]}; ${/Payload Integrity: (.*)/.exec(v13.out)?.[0]}`);

  const tampered = join(evidenceDir, 'assessment-evidence.tampered.json');
  {
    const file = JSON.parse(readFileSync(pack, 'utf-8'));
    const doc = JSON.parse(b64urlToText(file.envelope.payload));
    doc.safety.decision = 'BLOCK'; // change the recorded decision
    file.envelope.payload = textToB64url(JSON.stringify(doc));
    writeFileSync(tampered, JSON.stringify(file));
  }
  const v14 = await cli(verifyArgs(tampered));
  record(14, 'Tampered Evidence Pack fails offline verification', 'one signed field (the recorded decision) was edited after signing', verifyArgs(tampered), 'INVALID (exit 1)', v14, `${/Verification Result: (\w+)/.exec(v14.out)?.[1]} (exit ${v14.code})`, `${/Signature: (.*)/.exec(v14.out)?.[0]}; ${/Reason: (.*)/.exec(v14.out)?.[0]}`);

  const v15 = await cli(verifyArgs(pack, 'mallory'));
  record(15, 'Evidence Pack checked against an untrusted key', "the genuine pack from scenario 2, verified by someone who trusts only mallory's key, not the runner key that signed it", verifyArgs(pack, 'mallory'), 'INVALID (exit 1)', v15, `${/Verification Result: (\w+)/.exec(v15.out)?.[1]} (exit ${v15.code})`, `${/Signature: (.*)/.exec(v15.out)?.[0]}; ${/Reason: (.*)/.exec(v15.out)?.[0]}`);

  scenarios.sort((a, b) => a.id - b.id);
  return { workDir, scenarios, evidencePack: pack, tamperedPack: tampered, cleanup: () => rmSync(workDir, { recursive: true, force: true }) };
}
