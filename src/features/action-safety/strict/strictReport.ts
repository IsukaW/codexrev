/**
 * Terminal report for a STRICT DEMO MODE assessment. It only ARRANGES what the run produced: every status
 * comes from the real verification results (nothing is hard-coded as "VERIFIED"), the safety score and
 * gates come from the existing assessment, and the standard assessment report follows unchanged.
 * Private keys, raw challenges, proofs and signatures are never part of a result, so they cannot appear.
 */

import { renderAssessment } from '../cli/assessmentReport.js';
import type { RenderOptions } from '../cli/terminalStyle.js';
import { PLAIN_OPTIONS } from '../cli/terminalStyle.js';
import type { Line, StrictAssessResult } from './strictAssess.js';

const f2 = (n: number): string => n.toFixed(2);
const GATE_NAMES: Readonly<Record<string, string>> = { AUTHORIZATION: 'Authorization Gate', VERIFIED_RECOVERY: 'Recovery Gate', BUILD_TEST_RESULTS: 'Build/Test Gate', SUPPORTING_EVIDENCE: 'Supporting Evidence Gate' };
const show = (l: Line): string => (l.detail ? `${l.status} (${l.detail})` : l.status);
const pad = (label: string): string => `  ${label}:`.padEnd(26);

export const STRICT_LIMITATIONS: readonly string[] = [
  'Prototype: the assessment command itself is trusted; this demo does not defend against a modified executable.',
  'The challenge store runs inside this process: replay protection is local, not enforced by a separate trusted party.',
  'The trust anchor is the fingerprint supplied on the command line; it is only as trustworthy as whoever supplies it.',
  'Time is the local clock. Git binding covers the clean HEAD snapshot, not the artifact that is actually deployed.',
  'Nothing was executed: this command assesses an action, it never performs it.',
];

/** The standard report ends with a notice that nothing is signed. In strict mode a signed pack can be written, so that sentence is replaced. */
function dropUnsignedNotice(lines: string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (/Signature verification and audit history/.test(l)) {
      skipping = true;
      out.push('  Signed Evidence Packs can be verified offline with the "verify" command. Audit history is not implemented.');
      continue;
    }
    if (skipping && l.trim() !== '') continue;
    skipping = false;
    out.push(l);
  }
  return out;
}

export function renderStrictAssessment(r: StrictAssessResult, options: RenderOptions = PLAIN_OPTIONS): string[] {
  const s = r.summary;
  const lines: string[] = ['', 'CODEXREV — STRICT DEMO MODE', '  Signed authorization is ACTIVE. Authority claims in input files are ignored. This is not operating-system enforcement.', ''];
  lines.push(`${pad('Action')}${r.request.action}`);
  lines.push(`${pad('Environment')}${r.request.environment}`);
  lines.push(`${pad('Target')}${r.request.target}`);
  lines.push(`${pad('Developer')}${s.developer.subjectId ?? r.request.developer}${s.developer.grantId ? ` (grant ${s.developer.grantId}${s.developer.roles ? `, roles: ${s.developer.roles.join(', ')}` : ''})` : ''}`);
  lines.push('', 'Authorization:');
  lines.push(`${pad('Trust anchor')}${show(s.trustAnchor)}`);
  lines.push(`${pad('Developer key')}${show(s.developerKey)}`);
  lines.push(`${pad('Developer grant')}${show(s.developerGrant)}`);
  lines.push(`${pad('Revocation check')}${show(s.revocation)}`);
  lines.push(`${pad('Permission')}${show(s.permission)}${s.permission.required.length > 0 ? `  [${s.permission.required.join(', ')}]` : ''}`);
  lines.push(`${pad('Developer proof')}${show(s.developerProof)}`);
  lines.push(`${pad('Git context')}${show(s.gitContext)}`);
  lines.push(`${pad('Challenge consumption')}${show(s.challengeConsumption)}${s.receipt ? `  receipt ${s.receipt.receiptId} at ${s.receipt.consumedAt}` : ''}`);
  const stateText = s.authorizationState === 'finalized' ? 'FINALIZED (challenge consumed, signed receipt verified)' : s.authorizationState === 'provisional_not_finalized' ? 'NOT FINALIZED (verified, but the assessment did not ALLOW: nothing was consumed)' : 'BLOCKED (authorization not established)';
  lines.push(`${pad('Authorization state')}${stateText}`);

  const a = r.session?.assessment;
  if (a && a.status !== 'FAILED') {
    lines.push('', `Safety Score: ${f2(a.safetyScore)}`);
    for (const g of a.gates.results) lines.push(`${(GATE_NAMES[g.gate] ?? `${g.gate} Gate`).padEnd(28)}${g.status}`);
  }
  lines.push('', `Final Decision: ${r.decision}`);
  const safetyReasons: string[] = [];
  if (a && a.status !== 'FAILED' && r.decision !== 'ALLOW') {
    // what the existing assessment itself decided, in its own words
    for (const g of a.gates.triggered) safetyReasons.push(`Safety gate ${GATE_NAMES[g.gate] ?? g.gate}: ${g.status}, ${g.consequence} (${g.explanation})`);
    if (a.preliminaryDecision !== 'ALLOW') safetyReasons.push(`Safety Score ${f2(a.safetyScore)} is in the ${a.preliminaryDecision} band: it is below the ALLOW threshold (${a.decision.thresholds.allowAtOrAbove.toFixed(2)})`);
  }
  if (r.decision !== 'ALLOW' || s.reasons.length > 0 || safetyReasons.length > 0) {
    lines.push('', 'Reasons:');
    if (s.reasons.length === 0 && safetyReasons.length === 0) lines.push('  - the safety assessment did not allow the action (see the details below)');
    for (const reason of [...s.reasons, ...safetyReasons]) lines.push(`  - ${reason}`);
  }
  if (s.ignoredClaims.length > 0) lines.push('', `Ignored claims in the input file (strict mode never trusts these): ${s.ignoredClaims.join(', ')}`);
  lines.push('', 'Prototype limitations:');
  for (const l of STRICT_LIMITATIONS) lines.push(`  - ${l}`);
  if (r.session) {
    lines.push('', '------------------------------------------------------------', 'Standard assessment report (unchanged):');
    // in strict mode authority does not come from the input file, so the generic "nothing supplied" line would mislead
    lines.push(...dropUnsignedNotice(renderAssessment(r.session, options)).map((l) => (/^\s+Authority\s+UNKNOWN \(nothing supplied\)/.test(l) ? l.replace(/UNKNOWN \(nothing supplied\)/, 'see the signed Authorization section above') : l)));
  }
  return lines;
}
