/**
 * Recovery Collector: normalizes the rollback plan, rollback test and backup
 * records the user supplied. It never runs a rollback, a backup or a
 * migration, and it never treats a script's existence as proof recovery works.
 *
 * Three different things are kept apart:
 *   rollbackPlan - a rollback procedure is DOCUMENTED (proves nothing by itself)
 *   rollbackTest - the rollback was actually EXERCISED and succeeded
 *   backup       - a backup / recovery point exists
 *
 * "Verified recovery" (what the Critical Safety Gate asks for) needs a fresh,
 * trusted PASS on the rollback test or the backup. A plan alone is UNKNOWN.
 */

import type { EvidenceItem, EvidenceSource, EvidenceStatus } from '../model/types.js';
import { EVIDENCE_SOURCES } from '../model/types.js';
import { DEFAULT_REVERSIBILITY_CONFIG } from '../calculus/reversibility.js';
import { hoursToMs, parseNow } from '../calculus/scoring.js';
import type { InputRecovery } from '../cli/assessmentInput.js';
import { isStale, newestTimestamp, normalizeUserClaim, uniq, type NormalizedClaim } from './types.js';

export interface RecoveryCollection {
  readonly rollbackPlan?: NormalizedClaim;
  readonly rollbackTest?: NormalizedClaim;
  readonly backup?: NormalizedClaim;
  /** the older single `evidence.recovery` claim, kept as supplied (source capped) when no `recovery` section was given */
  readonly legacyClaim?: NormalizedClaim;
  /** a plan is documented but nothing verifies it */
  readonly documentedOnly: boolean;
  /**
   * The verified-recovery view for the Critical Safety Gate. Undefined only when
   * nothing recovery-related was supplied at all (the gate then fails on "missing").
   */
  readonly gateEvidence?: EvidenceItem;
  readonly limitations: readonly string[];
}

export function collectRecovery(opts: {
  readonly recovery?: InputRecovery;
  /** legacy single `evidence.recovery` claim, used only if no `recovery` section was given */
  readonly legacyClaim?: EvidenceItem;
  readonly now: string;
}): RecoveryCollection {
  const nowMs = parseNow(opts.now);
  const limitations: string[] = [];
  const claim = (label: string, item: EvidenceItem | undefined): NormalizedClaim | undefined => {
    if (!item) return undefined;
    const n = normalizeUserClaim(label, item);
    limitations.push(...n.limitations);
    return n;
  };

  const rollbackPlan = claim('rollback plan', opts.recovery?.rollbackPlan);
  const rollbackTest = claim('rollback test', opts.recovery?.rollbackTest);
  const backup = claim('backup record', opts.recovery?.backup);
  const legacy = opts.recovery === undefined ? claim('recovery claim', opts.legacyClaim) : undefined;

  const maxTest = hoursToMs(DEFAULT_REVERSIBILITY_CONFIG.maxAgeHours.rollbackTest);
  const maxBackup = hoursToMs(DEFAULT_REVERSIBILITY_CONFIG.maxAgeHours.backup);
  const verified = (c: NormalizedClaim | undefined, maxAge: number): boolean =>
    c !== undefined && c.item.status === 'PASS' && c.trusted && !isStale(c.item.observedAt, nowMs, maxAge);

  const testVerified = verified(rollbackTest, maxTest) || verified(legacy, maxTest);
  const backupVerified = verified(backup, maxBackup);

  let status: EvidenceStatus | undefined;
  if (rollbackTest?.item.status === 'FAIL' || legacy?.item.status === 'FAIL') status = 'FAIL'; // a rollback that failed its test is not verified recovery
  else if (testVerified || backupVerified) status = 'PASS';
  else if (backup?.item.status === 'FAIL') status = 'FAIL';
  else if (rollbackPlan || rollbackTest || backup || legacy) status = 'UNKNOWN';

  const documentedOnly = rollbackPlan?.item.status === 'PASS' && !testVerified && !backupVerified;
  if (documentedOnly) limitations.push('a rollback plan is documented but no verified rollback test or backup supports it');
  if (status === 'UNKNOWN' && !documentedOnly) limitations.push('recovery evidence was supplied but is stale, untrusted or inconclusive, so recovery is not verified');
  if (status === undefined) limitations.push('no rollback plan, rollback test or backup record was supplied');

  const used = [rollbackPlan, rollbackTest, backup, legacy].filter((c): c is NormalizedClaim => c !== undefined);
  let gateEvidence: EvidenceItem | undefined;
  if (status !== undefined) {
    const sources = used.map((c) => c.item.source).filter((s): s is EvidenceSource => s !== undefined);
    const best = sources.length > 0 ? sources.reduce((a, b) => (EVIDENCE_SOURCES.indexOf(a) <= EVIDENCE_SOURCES.indexOf(b) ? a : b)) : undefined;
    const observedAt = newestTimestamp(...used.map((c) => c.item.observedAt));
    gateEvidence = {
      status,
      refs: uniq(used.flatMap((c) => [...(c.item.refs ?? [])])),
      ...(observedAt ? { observedAt } : {}),
      ...(best ? { source: best } : {}),
    };
  }

  return {
    ...(rollbackPlan ? { rollbackPlan } : {}),
    ...(rollbackTest ? { rollbackTest } : {}),
    ...(backup ? { backup } : {}),
    ...(legacy ? { legacyClaim: legacy } : {}),
    documentedOnly,
    ...(gateEvidence ? { gateEvidence } : {}),
    limitations,
  };
}
