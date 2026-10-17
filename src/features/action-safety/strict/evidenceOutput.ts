/**
 * The command-line side of the Evidence Pack: choosing where it is written and with which key BEFORE the
 * assessment runs (so a bad key or an existing file can never be discovered after a challenge was consumed),
 * writing it afterwards, and rendering the offline verification.
 *
 * The signing key is a dedicated key profile for the assessment runner. It must not be a key that already has
 * another role: not the developer's key, not the challenge-store key, not any key in the trust root.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadTrustRoot } from './authority.js';
import { buildEvidencePack, createEvidencePackFile, serializeEvidencePack, verifyEvidencePack, type EvidencePackVerification, type TrustedSigner } from './evidencePack.js';
import { StrictCliError, isWithin, readTextFile, replaceFile, writeNewFile } from './files.js';
import { loadPrivateKey, readPublicKeyFile } from './keyStore.js';
import type { StrictAssessResult } from './strictAssess.js';

export interface EvidenceOutputOptions {
  readonly file: string;
  /** the assessment runner's dedicated Evidence Pack signing key profile */
  readonly signingKeyName: string;
  readonly keysDir: string;
  /** explicit confirmation to replace an existing file */
  readonly overwrite: boolean;
  /** keys that already have another role, by profile name or id */
  readonly developerKeyName: string;
  readonly storeKeyName: string;
  /** used to refuse a key that is listed in the trust root, when the trust root can be read */
  readonly authorityDir: string;
  readonly trustRootSha256: string;
  readonly trustRootFile?: string;
}

export interface EvidenceWriter {
  readonly file: string;
  readonly keyId: string;
  /** builds the record from the finished result, signs it and writes it; throws StrictCliError if any step fails */
  write(result: StrictAssessResult): Promise<{ readonly assessmentId: string; readonly file: string; readonly keyId: string }>;
}

export async function prepareEvidenceOutput(o: EvidenceOutputOptions): Promise<EvidenceWriter> {
  const file = path.resolve(o.file);
  const parent = path.dirname(file);
  let parentStat;
  try {
    parentStat = await fs.lstat(parent);
  } catch {
    throw new StrictCliError('the folder for the Evidence Pack does not exist');
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new StrictCliError('the Evidence Pack must be written into a real folder');
  if (isWithin(path.resolve(o.keysDir), file)) throw new StrictCliError('refusing to write the Evidence Pack into the keys directory');
  let exists = false;
  try {
    const st = await fs.lstat(file);
    exists = true;
    if (st.isSymbolicLink() || !st.isFile()) throw new StrictCliError('the Evidence Pack path is not a regular file');
  } catch (e) {
    if (e instanceof StrictCliError) throw e;
  }
  if (exists && !o.overwrite) throw new StrictCliError('the Evidence Pack file already exists: it is never overwritten without --overwrite-evidence-pack');

  const key = await loadPrivateKey({ name: o.signingKeyName, keysDir: o.keysDir });
  for (const [name, role] of [[o.developerKeyName, 'developer'], [o.storeKeyName, 'challenge-store']] as const) {
    if (name === o.signingKeyName) throw new StrictCliError(`the Evidence Pack key must be a dedicated key: it cannot be the ${role} key`);
    try {
      if ((await loadPrivateKey({ name, keysDir: o.keysDir })).keyId === key.keyId) throw new StrictCliError(`the Evidence Pack key must be a dedicated key: it cannot be the ${role} key`);
    } catch (e) {
      if (e instanceof StrictCliError && /dedicated key/.test(e.message)) throw e;
      /* that other key is not available here: the assessment itself will report it */
    }
  }
  try {
    const root = await loadTrustRoot(o.authorityDir, { expectedSha256: o.trustRootSha256, ...(o.trustRootFile !== undefined ? { file: o.trustRootFile } : {}) });
    if (root.keys.some((k) => k.keyId === key.keyId)) throw new StrictCliError('the Evidence Pack key must be a dedicated key: it cannot be a company key listed in the trust root');
  } catch (e) {
    if (e instanceof StrictCliError && /dedicated key/.test(e.message)) throw e;
    /* the trust root cannot be read: the assessment will BLOCK and say why */
  }

  return {
    file,
    keyId: key.keyId,
    async write(result) {
      let signed;
      try {
        const doc = buildEvidencePack(result);
        signed = { doc, text: serializeEvidencePack(createEvidencePackFile(doc, key.privateKey)) };
      } catch (e) {
        throw new StrictCliError(`the Evidence Pack could not be built and signed: ${(e as Error).message}`);
      }
      try {
        if (exists) await replaceFile(file, signed.text);
        else if (!(await writeNewFile(file, signed.text))) throw new StrictCliError('the Evidence Pack file appeared while the assessment ran: it was not overwritten');
      } catch (e) {
        if (e instanceof StrictCliError) throw e;
        throw new StrictCliError('the Evidence Pack could not be written');
      }
      return { assessmentId: signed.doc.assessmentId, file, keyId: key.keyId };
    },
  };
}

// ---------------------------------------------------------------- verification output

export interface VerifyOptions {
  readonly file: string;
  /** the trusted signer's public key file (.pub.json), supplied by the verifier */
  readonly trustedKeyFile: string;
  /** optional pin: the key id the trusted key file must have */
  readonly trustedKeyId?: string;
}

export async function verifyEvidencePackFile(o: VerifyOptions): Promise<{ readonly verification: EvidencePackVerification; readonly lines: string[] }> {
  const text = await readTextFile(path.resolve(o.file), 'the Evidence Pack', 1_048_576);
  const key = await readPublicKeyFile(o.trustedKeyFile);
  const trusted: TrustedSigner = { publicKey: key.publicKey, keyId: key.keyId };
  let verification = verifyEvidencePack(text, trusted);
  let pinNote: string | undefined;
  if (o.trustedKeyId !== undefined && o.trustedKeyId !== key.keyId) {
    // the supplied key file is not the key the verifier pinned: nothing signed by it is trusted
    verification = { result: 'INVALID', signature: 'NOT_CHECKED', signer: 'UNTRUSTED', payloadIntegrity: 'NOT_CHECKED', reason: 'The trusted key file does not have the pinned key fingerprint' };
    pinNote = 'pinned';
  }
  return { verification, lines: renderVerification(path.basename(o.file), verification, key.keyId, pinNote !== undefined) };
}

export function renderVerification(fileName: string, v: EvidencePackVerification, trustedKeyId: string, pinMismatch = false): string[] {
  const lines = ['', 'CODEXREV — EVIDENCE PACK VERIFICATION', '', `Evidence Pack: ${fileName}`];
  lines.push(`Signature: ${v.signature === 'NOT_CHECKED' ? 'NOT CHECKED' : v.signature}`);
  lines.push(`Signer: ${v.signer === 'TRUSTED' ? `TRUSTED (key id ${trustedKeyId.slice(0, 16)}…)` : v.signer === 'UNTRUSTED' ? 'UNTRUSTED' : 'NOT ESTABLISHED'}`);
  lines.push(`Payload Integrity: ${v.payloadIntegrity === 'NOT_CHECKED' ? 'NOT CHECKED' : v.payloadIntegrity}`);
  if (v.recordedDecision && v.pack) {
    const p = v.pack;
    lines.push(`Recorded Decision: ${v.recordedDecision}`);
    lines.push('', 'Recorded in the signed record:');
    lines.push(`  Assessment:     ${p.assessmentId}  (${p.assessedAt})`);
    lines.push(`  Action:         ${p.action.type} in ${p.action.environment}, target ${p.action.target}`);
    lines.push(`  Git commit:     ${p.action.commit ?? '(not collected)'}`);
    lines.push(`  Developer:      ${p.developer.subjectId ?? p.developer.keyProfile}${p.developer.grantId ? ` (grant ${p.developer.grantId})` : ''}`);
    lines.push(`  Authorization:  ${p.authorization.status}; challenge ${p.authorization.challengeConsumption.status}`);
    lines.push(`  Safety score:   ${p.safety.score === null ? '(none)' : p.safety.score.toFixed(2)}`);
    for (const g of p.safety.gates) lines.push(`  Gate ${g.gate}: ${g.status}`);
  }
  lines.push('', `Verification Result: ${v.result}`);
  if (v.reason) lines.push(`Reason: ${v.reason}`);
  if (pinMismatch) lines.push('The key file you supplied is not the key you pinned with --trusted-key-id.');
  lines.push('', 'A valid signature means the trusted key holder signed this record and it has not been changed.', 'It does not mean the action is safe, that the assessment was correct, or that anything was deployed.', 'This check ran offline: it did not re-run the assessment or look at live Git state.');
  return lines;
}
