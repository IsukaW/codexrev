/**
 * Drift alerts (FR9/NFR6) — one alert per conflicting/modified detection.
 *
 * PURE and deterministic: the builder turns the drift comparison into the
 * stable NFR6 alert shape `{changeId, file, reason, affectedRequirement,
 * proposedNextAction, severity, timestamp}`; rendering and JSONL persistence
 * live in the CLI layer and the state store. `severity` is `critical` for a
 * conflicting detection and `warning` for a modified one.
 */

import { linkedRequirementIdFor, parseSourceRef } from './impactSummary.js';
import type { DriftComparison } from './driftComparator.js';
import type {
  SpecChangeDriftAlert,
  SpecDriftAlertSeverity,
  SpecImplication,
  SpecProposal,
  SpecTimestamp,
  UrsDocument,
} from './types.js';

const MAX_REASON_CHARS = 240;

function severityFor(status: DriftComparison['overall']): SpecDriftAlertSeverity {
  return status === 'conflicting' ? 'critical' : 'warning';
}

function clipped(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, ' ');
  return oneLine.length <= MAX_REASON_CHARS ? oneLine : `${oneLine.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function fileFor(imp: SpecImplication, changeId: string): string {
  const ref = imp.sourceRefs[0];
  if (ref === undefined) return changeId;
  return parseSourceRef(ref).path;
}

function reasonFor(
  imp: SpecImplication,
  status: 'modified' | 'conflicting',
  requirementId: string,
  doc: UrsDocument | undefined,
): string {
  const title = doc?.sections.find((s) => s.id === requirementId)?.title ?? requirementId;
  const verb = status === 'conflicting' ? 'conflicts with' : 'is modified by';
  return clipped(`Requirement "${title}" (${requirementId}) ${verb} this change: ${imp.text}`);
}

function nextActionFor(
  status: 'modified' | 'conflicting',
  requirementId: string,
  proposal: SpecProposal | undefined,
): string {
  const decision = proposal
    ? `decide proposal ${proposal.id} (codexrev spec accept|reject|defer ${proposal.id})`
    : `update the living URS requirement ${requirementId}`;
  return status === 'conflicting'
    ? `Reconcile the conflict with requirement ${requirementId}, then ${decision}.`
    : `Confirm the requirement update for ${requirementId}, then ${decision}.`;
}

export interface DriftAlertParams {
  readonly changeId: string;
  readonly timestamp: SpecTimestamp;
  readonly implications: readonly SpecImplication[];
  readonly drift: DriftComparison;
  /** Living URS (for requirement titles in the reason text). */
  readonly doc?: UrsDocument;
  /** Proposals generated for this change (for the next-action wording). */
  readonly proposals?: readonly SpecProposal[];
}

/**
 * Builds one alert per implication classified `conflicting` or `modified`.
 * `new` implications raise proposals, not alerts; `aligned` and inert
 * implications raise nothing.
 */
export function buildDriftAlerts(params: DriftAlertParams): readonly SpecChangeDriftAlert[] {
  const { changeId, timestamp, implications, drift } = params;
  const proposals = params.proposals ?? [];
  const alerts: SpecChangeDriftAlert[] = [];

  for (const imp of implications) {
    const d = drift.perImplication.find((x) => x.implicationId === imp.id);
    if (!d || (d.status !== 'conflicting' && d.status !== 'modified')) continue;

    const requirementId = linkedRequirementIdFor(imp, drift, proposals);
    const proposal = proposals.find((p) => p.implicationIds.includes(imp.id));
    alerts.push({
      changeId,
      file: fileFor(imp, changeId),
      reason: reasonFor(imp, d.status, requirementId, params.doc),
      affectedRequirement: requirementId,
      proposedNextAction: nextActionFor(d.status, requirementId, proposal),
      severity: severityFor(d.status),
      timestamp,
    });
  }

  return alerts;
}

/** One-line rendering for CLI output. */
export function formatDriftAlert(alert: SpecChangeDriftAlert): string {
  return `  ${alert.severity.toUpperCase().padEnd(8)} ${alert.file} — ${alert.reason} → ${alert.proposedNextAction}`;
}
