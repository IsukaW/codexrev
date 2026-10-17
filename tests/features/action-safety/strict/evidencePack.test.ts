// Signed Evidence Pack: built from real strict assessments, signed with a real Ed25519 key through the
// existing envelope code, and verified offline. No success flag is mocked anywhere.

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { trustRootFingerprint } from '../../../../src/features/action-safety/strict/authority.js';
import { buildEvidencePack, checkConsistency, createEvidencePackFile, parseEvidencePackDocument, serializeEvidencePack, verifyEvidencePack, EvidencePackError, type EvidencePackDocument, type TrustedSigner } from '../../../../src/features/action-safety/strict/evidencePack.js';
import { generateKeyProfile, loadPrivateKey } from '../../../../src/features/action-safety/strict/keyStore.js';
import { runStrictCli } from '../../../../src/features/action-safety/strict/run.js';
import { runStrictAssessment, type StrictAssessOptions, type StrictAssessResult } from '../../../../src/features/action-safety/strict/strictAssess.js';
import { NOW, commitChange, copyDir, noInterpretation, setupOrganization, writeEvidence, type Fixture } from '../../../../src/features/action-safety/testing/strictFixture.js';

const T = 180_000;
let f: Fixture;
let pin: string;
let input: string;
let runner: Awaited<ReturnType<typeof loadPrivateKey>>;
let trusted: TrustedSigner;
let stranger: Awaited<ReturnType<typeof loadPrivateKey>>;
let n = 0;

beforeAll(async () => {
  f = await setupOrganization();
  input = writeEvidence(f.repo, NOW);
  pin = trustRootFingerprint(readFileSync(join(f.authorityDir, 'trust-root.json')));
  await generateKeyProfile({ name: 'runner', keysDir: f.keysDir, now: NOW });
  runner = await loadPrivateKey({ name: 'runner', keysDir: f.keysDir, platform: 'win32' });
  trusted = { publicKey: runner.publicKey, keyId: runner.keyId };
  stranger = await loadPrivateKey({ name: 'mallory', keysDir: f.keysDir, platform: 'win32' });
}, T);
afterAll(() => f.cleanup());

const base = (over: Partial<StrictAssessOptions> = {}): StrictAssessOptions => ({
  dir: f.authorityDir, trustRootSha256: pin, asKey: 'alice', keysDir: f.keysDir, storeKey: 'store', storeDir: join(f.root, `pack-store-${++n}`), action: 'deployment', environment: 'production', target: 'my-app',
  repo: f.repo, inputFile: input, now: () => NOW, interpreter: noInterpretation, ...over,
});
const run = (over: Partial<StrictAssessOptions> = {}): Promise<StrictAssessResult> => runStrictAssessment(base(over));
const pack = (r: StrictAssessResult, key = runner) => createEvidencePackFile(buildEvidencePack(r), key.privateKey);

/** re-encode a pack's signed payload with a change, WITHOUT re-signing (what a tamperer can do) */
function tamper(file: ReturnType<typeof pack>, change: (doc: Record<string, any>) => void, alsoReadable = true) {
  const doc = JSON.parse(Buffer.from(file.envelope.payload, 'base64url').toString('utf-8'));
  change(doc);
  const readable = JSON.parse(JSON.stringify(file.readable));
  if (alsoReadable) change(readable);
  return { ...file, envelope: { ...file.envelope, payload: Buffer.from(JSON.stringify(doc)).toString('base64url') }, readable };
}
const verify = (x: unknown, signer: TrustedSigner = trusted) => verifyEvidencePack(typeof x === 'string' ? x : JSON.stringify(x), signer);

// ================================================================ building and signing

describe('an Evidence Pack for a completed ALLOW', () => {
  it('1. records what was actually verified, and verifies offline against the trusted key', { timeout: T }, async () => {
    const storeDir = join(f.root, 'allow-store');
    const r = await run({ storeDir });
    expect(r.decision).toBe('ALLOW');
    const file = pack(r);
    const doc = file.readable;
    expect(doc).toMatchObject({
      version: 2, mode: 'strict_demo', assessedAt: NOW.toISOString(),
      action: { type: 'deployment', environment: 'production', target: 'my-app', commit: r.provenance.context?.commit, contentDigest: r.provenance.context?.contentDigest },
      developer: { keyProfile: 'alice', subjectId: 'alice', grantId: r.summary.developer.grantId, roles: ['l4'] },
      trust: { trustRootSha256: pin },
      authorization: {
        status: 'FINALIZED', trustAnchor: 'VERIFIED', developerGrant: 'VERIFIED', revocation: 'VERIFIED', developerProof: 'VERIFIED', gitContext: 'COLLECTED_AND_RECHECKED',
        permission: { status: 'VERIFIED', required: ['deployment.production'], verified: ['deployment.production'] },
        challengeConsumption: { status: 'CONSUMED_RECEIPT_VERIFIED', receiptId: r.summary.receipt?.receiptId, consumedAt: r.summary.receipt?.consumedAt },
      },
      safety: { assessmentStatus: 'COMPLETED', decision: 'ALLOW' },
    });
    expect(doc.action.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.safety.score).toBeCloseTo(r.session?.assessment.status === 'FAILED' ? -1 : (r.session?.assessment as { safetyScore: number }).safetyScore, 10);
    expect(doc.safety.gates.map((g) => g.gate).sort()).toEqual(['AUTHORIZATION', 'BUILD_TEST_RESULTS', 'SUPPORTING_EVIDENCE', 'VERIFIED_RECOVERY']);
    expect(doc.authorization).not.toHaveProperty('approvals'); // the per-action approval section no longer exists
    expect(file.envelope.domain).toBe('evidence_pack'); // its own domain: a grant, proof or receipt signature cannot be one
    const v = verify(JSON.stringify(file));
    expect(v).toMatchObject({ result: 'VALID', signature: 'VALID', signer: 'TRUSTED', payloadIntegrity: 'VERIFIED', recordedDecision: 'ALLOW' });
    // no key, no raw challenge and no proof in the file
    const body = serializeEvidencePack(file);
    for (const secret of [String(runner.privateKey.export({ format: 'jwk' }).d), String((await loadPrivateKey({ name: 'alice', keysDir: f.keysDir, platform: 'win32' })).privateKey.export({ format: 'jwk' }).d), String((await loadPrivateKey({ name: 'store', keysDir: f.keysDir, platform: 'win32' })).privateKey.export({ format: 'jwk' }).d), 'PRIVATE KEY']) expect(body).not.toContain(secret);
    const issuance = join(storeDir, 'issuance');
    for (const name of readdirSync(issuance)) {
      const rec = JSON.parse(readFileSync(join(issuance, name), 'utf-8'));
      const challenge = JSON.parse(Buffer.from(rec.token.payload, 'base64url').toString('utf-8')).challenge;
      expect(body).not.toContain(challenge);
    }
    expect(file.envelope).not.toHaveProperty('publicKey'); // trust never comes from a key inside the pack
  });

  it('a developer change by a developer is also finalized, with no approval recorded anywhere', { timeout: T }, async () => {
    const r = await run({ asKey: 'bob', action: 'code_change', environment: 'development' });
    expect(r.decision).toBe('ALLOW');
    const a = pack(r).readable.authorization;
    expect(a).not.toHaveProperty('approvals');
    expect(a.status).toBe('FINALIZED');
    expect(JSON.stringify(pack(r).readable)).not.toMatch(/approv/i);
  });

  it('the signature covers the whole record: its domain, its length and every byte', { timeout: T }, async () => {
    const r = await run();
    const file = pack(r);
    const bytes = Buffer.from(file.envelope.payload, 'base64url');
    // the same bytes signed for another purpose do not verify as an Evidence Pack
    const asGrant = signEnvelope({ domain: 'grant', payload: bytes, privateKey: runner.privateKey });
    const v = verify({ ...file, envelope: asGrant });
    expect(v).toMatchObject({ result: 'INVALID' });
    expect(v.recordedDecision).toBeUndefined();
  });
});

describe('an Evidence Pack for a BLOCK or ESCALATE says exactly what was and was not established', () => {
  it('a developer without the permission: DENIED, with the failing step named', { timeout: T }, async () => {
    const doc = pack(await run({ asKey: 'bob' })).readable;
    expect(doc.safety.decision).toBe('BLOCK');
    expect(doc.authorization.status).toBe('DENIED');
    expect(doc.authorization.permission.status).toBe('FAILED');
    expect(doc.authorization.permission.verified).toEqual([]);
    expect(doc.authorization.challengeConsumption.status).toBe('NOT_CONSUMED');
  });

  it('authorization could not even be established (wrong trust anchor, no grant): NOT_ESTABLISHED, no commit claimed', { timeout: T }, async () => {
    const wrongPin = pack(await run({ trustRootSha256: 'a'.repeat(64) })).readable;
    expect(wrongPin.authorization).toMatchObject({ status: 'NOT_ESTABLISHED', trustAnchor: 'FAILED', developerGrant: 'NOT_CHECKED', gitContext: 'NOT_COLLECTED' });
    expect(wrongPin.action).toMatchObject({ commit: null, contentDigest: null, actionId: null });
    const noGrant = pack(await run({ asKey: 'mallory' })).readable;
    expect(noGrant.authorization.status).toBe('NOT_ESTABLISHED');
    expect(noGrant.authorization.developerGrant).toBe('NOT_CHECKED');
  });

  it('verified but not finalized (another gate stops it): never labelled FINALIZED, challenge not consumed', { timeout: T }, async () => {
    const r = await run({ inputFile: writeEvidence(f.repo, NOW, { buildTests: false }) });
    expect(r.decision).not.toBe('ALLOW');
    const doc = pack(r).readable;
    expect(doc.authorization.status).toBe('VERIFIED_NOT_FINALIZED');
    expect(doc.authorization.challengeConsumption).toMatchObject({ status: 'NOT_CONSUMED', receiptId: null });
    expect(doc.authorization.gitContext).toBe('COLLECTED_NOT_RECHECKED'); // collected, but no recheck was needed or made
    expect(doc.safety.gates.find((g) => g.gate === 'BUILD_TEST_RESULTS')?.status).not.toBe('PASS');
    writeEvidence(f.repo, NOW);
  });

  it('15/16. a provisional ALLOW is never signed as final; a failed consumption is never recorded as consumed', { timeout: T }, async () => {
    const storeDir = join(f.root, 'fail-store');
    const r = await run({ storeDir, testHooks: { beforeFinalization: () => { for (const x of readdirSync(join(storeDir, 'issuance'))) writeFileSync(join(storeDir, 'issuance', x), '{}'); } } });
    const doc = pack(r).readable;
    expect(doc.safety.decision).toBe('BLOCK');
    expect(doc.authorization.status).not.toBe('FINALIZED');
    expect(doc.authorization.challengeConsumption.status).not.toBe('CONSUMED_RECEIPT_VERIFIED');
    expect(doc.authorization.challengeConsumption.receiptId).toBeNull();
    // a changed Git context: recorded as CHANGED, BLOCK, nothing consumed
    const moved = join(f.root, 'pack-repo-moved');
    copyDir(f.repo, moved);
    const changed = await run({ repo: moved, testHooks: { beforeFinalization: () => commitChange(moved) } });
    const cdoc = pack(changed).readable;
    expect(cdoc).toMatchObject({ safety: { decision: 'BLOCK' }, authorization: { gitContext: 'CHANGED', challengeConsumption: { status: 'NOT_CONSUMED' } } });
    expect(cdoc.authorization.status).not.toBe('FINALIZED');
  });

  it('refuses to build a pack from anything but a genuine completed assessment', async () => {
    const real = await run();
    for (const fake of [{ ...real }, JSON.parse(JSON.stringify(real)), null, undefined, { decision: 'ALLOW' }, 'ALLOW']) {
      expect(() => buildEvidencePack(fake as never)).toThrow(EvidencePackError);
    }
  });
});

describe('the record cannot overstate itself', () => {
  const allow = async () => (await run()).decision === 'ALLOW' && pack(await run()).readable;

  it('rejects, when building AND when verifying, a signed record that claims more than was established', { timeout: T }, async () => {
    const good = (await allow()) as EvidencePackDocument;
    expect(checkConsistency(good)).toBeUndefined();
    const lies: Array<[string, (d: any) => void]> = [
      ['ALLOW without a finalized authorization', (d) => { d.authorization.status = 'VERIFIED_NOT_FINALIZED'; }],
      ['ALLOW while the challenge was not consumed', (d) => { d.authorization.challengeConsumption = { status: 'NOT_CONSUMED', receiptId: null, consumedAt: null }; }],
      ['consumption without a receipt', (d) => { d.authorization.challengeConsumption.receiptId = null; }],
      ['a receipt without consumption', (d) => { d.authorization.challengeConsumption = { status: 'NOT_CONSUMED', receiptId: good.authorization.challengeConsumption.receiptId, consumedAt: null }; }],
      ['FINALIZED without consumption', (d) => { d.authorization.challengeConsumption = { status: 'FAILED', receiptId: null, consumedAt: null }; }],
      ['ALLOW with a Git context that was not rechecked', (d) => { d.authorization.gitContext = 'COLLECTED_NOT_RECHECKED'; }],
      ['ALLOW with a failed gate', (d) => { d.safety.gates[0].status = 'FAIL'; }],
      ['ALLOW with a gate removed from the record', (d) => { d.safety.gates.pop(); }],
      ['ALLOW while the removed Human Approval gate is still listed', (d) => { d.safety.gates.push({ gate: 'HUMAN_APPROVAL', status: 'PASS', consequence: 'BLOCK' }); }],
      ['ALLOW with a step that was not verified', (d) => { d.authorization.developerProof = 'NOT_CHECKED'; }],
      ['ALLOW without a commit', (d) => { d.action.commit = null; }],
      ['a score outside 0..1', (d) => { d.safety.score = 1.5; }],
      ['a changed Git context recorded as ALLOW', (d) => { d.authorization.gitContext = 'CHANGED'; }],
    ];
    for (const [label, change] of lies) {
      const doc = JSON.parse(JSON.stringify(good));
      change(doc);
      expect(checkConsistency(doc), label).toBeTypeOf('string');
      expect(() => createEvidencePackFile(doc, runner.privateKey), label).toThrow(EvidencePackError);
      // even if the trusted runner key were used to sign such a record by hand, verification refuses it
      const forced = { format: 'codexrev-evidence-pack', version: 2, envelope: signEnvelope({ domain: 'evidence_pack', payload: Buffer.from(JSON.stringify(doc)), privateKey: runner.privateKey }), readable: doc };
      const v = verify(forced);
      expect(v, label).toMatchObject({ result: 'INVALID', signature: 'VALID', payloadIntegrity: 'FAILED' });
      expect(v.reason, label).toMatch(/inconsistent|malformed|unexpected/);
      expect(v.recordedDecision, label).toBeUndefined();
    }
  });
});

// ================================================================ offline verification

describe('offline verification', () => {
  let valid: ReturnType<typeof pack>;
  beforeAll(async () => {
    valid = pack(await run());
  }, T);

  it('3. a valid pack is VALID with the signer trusted and the payload verified', () => {
    expect(verify(JSON.stringify(valid))).toMatchObject({ result: 'VALID', signature: 'VALID', signer: 'TRUSTED', payloadIntegrity: 'VERIFIED', recordedDecision: 'ALLOW' });
    // the key order or white space of the file does not matter
    const reordered = { readable: valid.readable, envelope: valid.envelope, version: 2, format: 'codexrev-evidence-pack' };
    expect(verify(JSON.stringify(reordered, null, 4)).result).toBe('VALID');
  });

  it('4-8. changing the decision, score, a gate, the commit or the developer breaks verification', () => {
    const edits: Array<[string, (d: any) => void]> = [
      ['the recorded decision', (d) => { d.safety.decision = 'BLOCK'; }],
      ['the safety score', (d) => { d.safety.score = 0.99; }],
      ['a gate result', (d) => { d.safety.gates[0].status = 'FAIL'; }],
      ['the Git commit', (d) => { d.action.commit = 'f'.repeat(40); }],
      ['the content digest', (d) => { d.action.contentDigest = `sha256:${'e'.repeat(64)}`; }],
      ['the developer identity', (d) => { d.developer.subjectId = 'lead1'; }],
      ['the grant id', (d) => { d.developer.grantId = 'grant-other'; }],
      ['the timestamp', (d) => { d.assessedAt = '2030-01-01T00:00:00.000Z'; }],
      ['the assessment id', (d) => { d.assessmentId = 'AAAAAAAAAAAAAAAAAAAAAA'; }],
      ['the permission list', (d) => { d.authorization.permission.verified = []; }],
    ];
    for (const [label, change] of edits) {
      // (a) the signed bytes changed: the signature no longer matches
      const signedEdit = verify(tamper(valid, change));
      expect(signedEdit, label).toMatchObject({ result: 'INVALID', signature: 'INVALID' });
      expect(signedEdit.reason, label).toMatch(/Signed content has been modified/);
      expect(signedEdit.recordedDecision, label).toBeUndefined();
      // (b) only the human-readable copy changed: it no longer matches the signed record
      const readableEdit = verify({ ...valid, readable: tamper(valid, change).readable });
      expect(readableEdit, label).toMatchObject({ result: 'INVALID', signature: 'VALID', payloadIntegrity: 'FAILED' });
      expect(readableEdit.reason, label).toMatch(/differs from the signed record/);
      expect(readableEdit.recordedDecision, label).toBeUndefined();
    }
  });

  it('9. a missing signature is reported as missing', () => {
    const noSig = { ...valid, envelope: { ...valid.envelope, signature: undefined } };
    expect(verify(JSON.stringify(noSig))).toMatchObject({ result: 'INVALID', signature: 'MISSING' });
    const { envelope: _e, ...noEnvelope } = valid;
    void _e;
    expect(verify(noEnvelope)).toMatchObject({ result: 'INVALID', signature: 'MISSING' });
    expect(verify({ ...valid, envelope: { ...valid.envelope, signature: '' } })).toMatchObject({ result: 'INVALID', signature: 'MISSING' });
  });

  it('10. an invalid signature is INVALID', () => {
    const flipped = valid.envelope.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    expect(verify({ ...valid, envelope: { ...valid.envelope, signature: flipped } })).toMatchObject({ result: 'INVALID', signature: 'INVALID', payloadIntegrity: 'FAILED' });
    expect(verify({ ...valid, envelope: { ...valid.envelope, signature: 'not base64!' } }).result).toBe('INVALID');
    expect(verify({ ...valid, envelope: { ...valid.envelope, signature: 'QUJD' } }).result).toBe('INVALID');
  });

  it('11. a pack signed by an untrusted key is UNTRUSTED, however correct its signature is', async () => {
    const r = await run();
    const byStranger = pack(r, stranger);
    const v = verify(JSON.stringify(byStranger));
    expect(v).toMatchObject({ result: 'INVALID', signer: 'UNTRUSTED', signature: 'NOT_CHECKED' });
    expect(v.recordedDecision).toBeUndefined();
    // the attacker re-signs a tampered record with their own key and claims it is the runner's: the key id gives it away
    const forgedClaim = tamper(byStranger, (d) => { d.safety.decision = 'ALLOW'; });
    expect(verify({ ...forgedClaim, envelope: { ...forgedClaim.envelope, keyId: runner.keyId } })).toMatchObject({ result: 'INVALID', signature: 'INVALID' });
    // trusting the stranger's key instead would make it verify: trust is the verifier's choice, never the pack's
    expect(verify(JSON.stringify(byStranger), { publicKey: stranger.publicKey, keyId: stranger.keyId }).result).toBe('VALID');
  });

  it('13. an unsupported version is refused, and version 1 (five gates, approvals) is never reinterpreted', () => {
    expect(verify({ ...valid, version: 3 })).toMatchObject({ result: 'INVALID', reason: 'Unsupported Evidence Pack version' });
    const v1 = verify({ ...valid, version: 1 });
    expect(v1).toMatchObject({ result: 'INVALID', signature: 'NOT_CHECKED', signer: 'NOT_ESTABLISHED' });
    expect(v1.reason).toMatch(/version 1.*five gates.*approvals.*not reinterpreted/);
    expect(v1.recordedDecision).toBeUndefined();
    const doc = JSON.parse(Buffer.from(valid.envelope.payload, 'base64url').toString('utf-8'));
    for (const version of [1, 3]) {
      doc.version = version;
      const resigned = { ...valid, envelope: signEnvelope({ domain: 'evidence_pack', payload: Buffer.from(JSON.stringify(doc)), privateKey: runner.privateKey }), readable: doc };
      expect(verify(resigned), String(version)).toMatchObject({ result: 'INVALID', signature: 'VALID', payloadIntegrity: 'FAILED' });
    }
  });

  it('a hand-built old-style record (version 1 with an approvals section and a Human Approval gate), even signed by the trusted key, is refused', () => {
    const doc = JSON.parse(JSON.stringify(valid.readable));
    doc.version = 1;
    doc.authorization.approvals = { status: 'VERIFIED', required: 1, verified: 1, approvers: [{ subjectId: 'lead1', approvalId: 'apr-1' }] };
    doc.safety.gates.push({ gate: 'HUMAN_APPROVAL', status: 'PASS', consequence: 'ESCALATE' });
    const old = { format: 'codexrev-evidence-pack', version: 1, envelope: signEnvelope({ domain: 'evidence_pack', payload: Buffer.from(JSON.stringify(doc)), privateKey: runner.privateKey }), readable: doc };
    expect(verify(old).result).toBe('INVALID');
    const asV2 = { ...old, version: 2 };
    expect(verify(asV2)).toMatchObject({ result: 'INVALID', payloadIntegrity: 'FAILED' });
  });

  it('14. malformed packs are INVALID, never an exception', () => {
    const cases: unknown[] = ['', 'not json', '[]', 'null', '5', '{}', { format: 'something-else' }, { format: 'codexrev-evidence-pack' }, { format: 'codexrev-evidence-pack', version: 1 }, { ...valid, extra: 1 }, { ...valid, envelope: 'x' }, { ...valid, envelope: null }, { ...valid, readable: null }, 'x'.repeat(2_000_000)];
    for (const [i, c] of cases.entries()) {
      const v = verifyEvidencePack(typeof c === 'string' ? c : JSON.stringify(c), trusted);
      expect(v.result, `case ${i}`).toBe('INVALID');
      expect(v.recordedDecision, `case ${i}`).toBeUndefined();
    }
    expect(() => verifyEvidencePack(undefined as never, trusted)).not.toThrow();
    // a structurally wrong SIGNED record (signed by the trusted key): refused on its own merits
    for (const mutate of [(d: any) => { d.safety.decision = 'MAYBE'; }, (d: any) => { delete d.safety; }, (d: any) => { d.extra = 1; }, (d: any) => { d.action.commit = 'not-a-commit'; }, (d: any) => { d.authorization.status = 'FINE'; }, (d: any) => { d.assessmentId = 'short'; }]) {
      const doc = JSON.parse(JSON.stringify(valid.readable));
      mutate(doc);
      const forced = { format: 'codexrev-evidence-pack', version: 2, envelope: signEnvelope({ domain: 'evidence_pack', payload: Buffer.from(JSON.stringify(doc)), privateKey: runner.privateKey }), readable: doc };
      expect(verify(forced)).toMatchObject({ result: 'INVALID', payloadIntegrity: 'FAILED' });
    }
    expect(typeof parseEvidencePackDocument({})).toBe('string');
  });

  it('an old pack still verifies after the world changed: it checks the record, not live Git state or the authority directory', async () => {
    const copy = join(f.root, 'pack-repo-after');
    copyDir(f.repo, copy);
    commitChange(copy);
    expect(verify(JSON.stringify(valid)).result).toBe('VALID');
  });

  it('performs no network, database, environment or model access', () => {
    for (const file of ['evidencePack.ts', 'evidenceOutput.ts']) {
      const src = readFileSync(join(process.cwd(), 'src/features/action-safety/strict', file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/node:net|node:http|node:https|node:dgram|node:tls|child_process|fetch\(|process\.env|sqlite|interpretation\/|providers\//);
    }
  });
});

// ================================================================ the command line

describe('the command line', () => {
  const cli = async (args: string[], hooks: object = { interpreter: noInterpretation }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runStrictCli(args, { out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, hooks: hooks as never });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const assess = (extra: string[], who = 'alice'): string[] => ['assess', '--strict', '--dir', f.authorityDir, '--trust-root-sha256', pin, '--keys-dir', f.keysDir, '--store-dir', join(f.root, `cli-store-${++n}`), '--repo', f.repo, '--input', input, '--as', who, '--action', 'deployment', '--environment', 'production', '--target', 'my-app', ...extra];
  const dir = (): string => {
    const d = join(f.root, `packs-${++n}`);
    mkdirSync(d);
    return d;
  };

  it('assess writes a signed pack, and verify checks it offline with the expected output', { timeout: T }, async () => {
    const out = join(dir(), 'assessment-evidence.json');
    const a = await cli(assess(['--evidence-pack', out, '--evidence-key', 'runner']));
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/Final Decision: ALLOW/);
    expect(a.out).toMatch(/Evidence Pack: signed and written to/);
    const v = await cli(['verify', '--evidence-pack', out, '--trusted-key', join(f.keysDir, 'runner.pub.json')]);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/CODEXREV — EVIDENCE PACK VERIFICATION/);
    expect(v.out).toMatch(/Evidence Pack: assessment-evidence\.json/);
    expect(v.out).toMatch(/Signature: VALID/);
    expect(v.out).toMatch(/Signer: TRUSTED/);
    expect(v.out).toMatch(/Payload Integrity: VERIFIED/);
    expect(v.out).toMatch(/Recorded Decision: ALLOW/);
    expect(v.out).toMatch(/Verification Result: VALID/);
    expect(v.out).toMatch(/does not mean the action is safe/);
    expect(v.out).toMatch(/ran offline/);
    // the pin on the key id passes when right and fails when wrong
    const pinned = await cli(['verify', '--evidence-pack', out, '--trusted-key', join(f.keysDir, 'runner.pub.json'), '--trusted-key-id', runner.keyId]);
    expect(pinned.code).toBe(0);
    const wrongPin = await cli(['verify', '--evidence-pack', out, '--trusted-key', join(f.keysDir, 'runner.pub.json'), '--trusted-key-id', 'a'.repeat(64)]);
    expect(wrongPin.code).toBe(1);
    expect(wrongPin.out).toMatch(/Signer: UNTRUSTED/);
    expect(wrongPin.out).toMatch(/Verification Result: INVALID/);
    expect(wrongPin.out).not.toMatch(/Recorded Decision/);
    expect((await cli(['verify', '--evidence-pack', out, '--trusted-key', join(f.keysDir, 'runner.pub.json'), '--trusted-key-id', 'xyz'])).code).toBe(2);
  });

  it('H. a tampered pack prints INVALID with the reason, and the recorded decision is not shown', { timeout: T }, async () => {
    const out = join(dir(), 'tampered.json');
    await cli(assess(['--evidence-pack', out, '--evidence-key', 'runner']));
    const file = JSON.parse(readFileSync(out, 'utf-8'));
    const doc = JSON.parse(Buffer.from(file.envelope.payload, 'base64url').toString('utf-8'));
    doc.safety.decision = 'BLOCK';
    file.envelope.payload = Buffer.from(JSON.stringify(doc)).toString('base64url');
    writeFileSync(out, JSON.stringify(file));
    const v = await cli(['verify', '--evidence-pack', out, '--trusted-key', join(f.keysDir, 'runner.pub.json')]);
    expect(v.code).toBe(1);
    expect(v.out).toMatch(/Signature: INVALID/);
    expect(v.out).toMatch(/Verification Result: INVALID/);
    expect(v.out).toMatch(/Reason: Signed content has been modified/);
    expect(v.out).not.toMatch(/Recorded Decision/);
    const untrusted = await cli(['verify', '--evidence-pack', out, '--trusted-key', join(f.keysDir, 'mallory.pub.json')]);
    expect(untrusted.out).toMatch(/Signer: UNTRUSTED/);
    expect((await cli(['verify', '--evidence-pack', join(f.root, 'missing.json'), '--trusted-key', join(f.keysDir, 'runner.pub.json')])).code).toBe(1);
  });

  it('a BLOCK is recorded and verifies as an authentic BLOCK (authentic is not the same as safe)', { timeout: T }, async () => {
    const out = join(dir(), 'block.json');
    const a = await cli(assess(['--evidence-pack', out, '--evidence-key', 'runner'], 'bob'));
    expect(a.code).toBe(11);
    expect(a.out).toMatch(/Evidence Pack: signed and written to/);
    const v = await cli(['verify', '--evidence-pack', out, '--trusted-key', join(f.keysDir, 'runner.pub.json')]);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/Recorded Decision: BLOCK/);
  });

  it('never overwrites an existing pack without explicit confirmation, and checks before anything is consumed', { timeout: T }, async () => {
    const out = join(dir(), 'exists.json');
    writeFileSync(out, 'precious');
    const storeDir = join(f.root, `cli-store-keep-${++n}`);
    const args = assess(['--evidence-pack', out, '--evidence-key', 'runner']).map((a, i, all) => (all[i - 1] === '--store-dir' ? storeDir : a));
    const refused = await cli(args);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/never overwritten without --overwrite-evidence-pack/);
    expect(readFileSync(out, 'utf-8')).toBe('precious');
    expect(existsSync(storeDir)).toBe(false); // nothing ran, nothing was issued or consumed
    const replaced = await cli([...args, '--overwrite-evidence-pack']);
    expect(replaced.code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf-8')).format).toBe('codexrev-evidence-pack');
  });

  it('refuses a key that is not dedicated, a missing key, and a bad location, all before the run', { timeout: T }, async () => {
    const d = dir();
    for (const [key, pattern] of [['alice', /dedicated key.*developer/], ['store', /dedicated key.*challenge-store/], ['admin', /dedicated key.*trust root/], ['nobody', /keygen --name nobody/]] as const) {
      const storeDir = join(f.root, `cli-store-pre-${++n}`);
      const args = assess(['--evidence-pack', join(d, `${key}.json`), '--evidence-key', key]).map((a, i, all) => (all[i - 1] === '--store-dir' ? storeDir : a));
      const r = await cli(args);
      expect(r.code, key).toBe(1);
      expect(r.err, key).toMatch(pattern);
      expect(existsSync(storeDir), key).toBe(false);
      expect(existsSync(join(d, `${key}.json`)), key).toBe(false);
    }
    expect((await cli(assess(['--evidence-pack', join(f.root, 'no-such-folder', 'x.json'), '--evidence-key', 'runner']))).code).toBe(1);
    expect((await cli(assess(['--evidence-pack', join(d, 'x.json')]))).code).toBe(2); // --evidence-key missing
    expect((await cli(assess(['--evidence-key', 'runner']))).code).toBe(2);
    expect((await cli(assess(['--overwrite-evidence-pack']))).code).toBe(2);
    expect(readdirSync(d)).toEqual([]);
  });

  it('if the pack cannot be written after the run, it says so and does not claim success', { timeout: T }, async () => {
    const d = dir();
    const out = join(d, 'late.json');
    const r = await cli(assess(['--evidence-pack', out, '--evidence-key', 'runner']), {
      interpreter: noInterpretation,
      // the file appears while the assessment runs: it must not be overwritten
    });
    expect(r.code).toBe(0);
    const racing = join(d, 'race.json');
    const hooks = { interpreter: async () => { writeFileSync(racing, 'someone else'); return noInterpretation(); } };
    const failed = await cli(assess(['--evidence-pack', racing, '--evidence-key', 'runner']), hooks);
    expect(failed.err).toMatch(/Evidence Pack NOT produced/);
    expect(failed.out).not.toMatch(/signed and written/);
    expect(failed.code).not.toBe(0); // an ALLOW whose pack could not be produced is not reported as success
    expect(readFileSync(racing, 'utf-8')).toBe('someone else');
  });

  it('assess without a pack option is exactly the Phase 7.3 behavior', { timeout: T }, async () => {
    const r = await cli(assess([]));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/STRICT DEMO MODE/);
    expect(r.out).not.toMatch(/Evidence Pack: signed and written/);
    expect(r.out).toMatch(/Signed Evidence Packs can be verified offline/);
  });
});
