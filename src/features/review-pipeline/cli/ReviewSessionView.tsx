/**
 * Codexrev — persistent Ink app for one interactive `codexrev review scan`.
 *
 * Fixes a real bug found running Phase 5 against a live repo: mounting
 * a fresh Ink tree per gate (`render()`/`unmount()` in a loop) raced
 * with Ink's raw-mode stdin handling between mounts, so arrow-key
 * presses briefly leaked to the terminal as literal escape sequences
 * (`^[[B^[[A`) instead of being captured by `SelectInput`. Mounting
 * ONE persistent tree for the whole session — same pattern as
 * `src/ui/App.tsx` — avoids the repeated raw-mode toggling entirely.
 *
 * Also addresses the "no feedback while the LLM is thinking" gap: each
 * role shows a `<Spinner/>` (same `ink-spinner` used by `App.tsx`) from
 * the moment it starts until its verdict lands.
 *
 * Phase 8 extends this with a Fix Loop section: iteration headers, one
 * line per fix attempt (deterministic vs LLM, file, description), and
 * updated verdicts as roles are re-run — plus the Continue/Details/
 * Skip/Abort gate before an LLM-generated edit is applied. Gate stages
 * are namespaced (`<role>` for a role gate, `fix:<findingId>` for a fix
 * gate) so one `gate` state and one `detailsFor` state serve both.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { diffLines } from 'diff';
import { StageGatePrompt } from './StageGatePrompt.js';
import type { InteractionChannel, StageGateDecision, StageGateRequest } from '../../../core/interaction.js';
import type { ReviewSessionEvent, ReviewSessionEventBus } from './reviewSessionEvents.js';
import { ROLE_LABELS, type Finding, type RoleId, type RoleOutput } from '../roles/roleContract.js';
import type { FixAttemptRecord, FixCandidate } from '../pipeline/breakerBuilderLoop.js';

interface RoleLogEntry {
  readonly role: RoleId;
  readonly status: 'running' | RoleOutput['verdict'];
  readonly summary?: string;
  readonly findings?: readonly Finding[];
}

interface FixLogEntry {
  readonly key: string;
  readonly kind: 'iteration' | 'candidate' | 'attempt' | 'rerun';
  readonly iteration?: number;
  readonly blockingCount?: number;
  readonly candidate?: FixCandidate;
  readonly record?: FixAttemptRecord;
  readonly output?: RoleOutput;
}

interface ReviewSessionViewProps {
  events: ReviewSessionEventBus;
  interactionChannel: InteractionChannel;
}

const STATUS_COLOR: Record<string, string> = { running: 'cyan', pass: 'green', flag: 'yellow', block: 'red' };
const STATUS_ICON: Record<string, string> = { pass: '✔', flag: '⚑', block: '✖' };

const RoleLine: React.FC<{ entry: RoleLogEntry }> = ({ entry }) => {
  const color = STATUS_COLOR[entry.status];
  return (
    <Box flexDirection="column">
      <Box>
        {entry.status === 'running' ? (
          <>
            <Text color={color}>
              <Spinner type="dots" />
            </Text>
            <Text color={color}> {ROLE_LABELS[entry.role]} — running…</Text>
          </>
        ) : (
          <Text color={color}>
            {STATUS_ICON[entry.status]} {ROLE_LABELS[entry.role]} — {entry.status.toUpperCase()}
          </Text>
        )}
      </Box>
      {entry.summary && <Text>  {entry.summary}</Text>}
    </Box>
  );
};

const FindingsBlock: React.FC<{ findings: readonly Finding[] }> = ({ findings }) => (
  <Box flexDirection="column" marginLeft={2} marginBottom={1}>
    {findings.length === 0 && <Text dimColor>No findings from this role.</Text>}
    {findings.map((f) => (
      <Box key={f.id} flexDirection="column">
        <Text bold>
          [{f.severity}] {f.file}:{f.lineStart}-{f.lineEnd}
          {f.cwe ? ` (${f.cwe})` : ''}
        </Text>
        <Text>  {f.description}</Text>
        {f.suggestedFix && <Text dimColor>  Suggested fix: {f.suggestedFix}</Text>}
      </Box>
    ))}
  </Box>
);

interface DiffRow {
  readonly key: string;
  readonly oldNo?: number;
  readonly newNo?: number;
  readonly marker: ' ' | '+' | '-';
  readonly content: string;
}

/**
 * Turns the fix's flat before/after strings into real line-level diff
 * rows (added/removed/unchanged), each carrying its own old/new line
 * number — the same shape `git diff` / GitHub's diff view use, and what
 * the reported request asked for instead of the old two-line "- whole
 * old string / + whole new string" dump, which gave no line numbers and
 * no per-line distinction inside a multi-line edit.
 *
 * `startLine` seeds both counters from `finding.lineStart` — the finding
 * that produced this fix already pins the edit to that location, so
 * numbering from there (rather than from 1) keeps the panel's numbers
 * meaningful against the actual file, even though the snippet itself
 * carries no surrounding file context to confirm it against.
 */
function buildDiffRows(oldString: string, newString: string, startLine: number): DiffRow[] {
  const parts = diffLines(oldString, newString);
  let oldNo = startLine;
  let newNo = startLine;
  const rows: DiffRow[] = [];

  for (const part of parts) {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); // trailing '' from a final \n
    for (const line of lines) {
      if (part.added) {
        rows.push({ key: `${rows.length}`, newNo: newNo++, marker: '+', content: line });
      } else if (part.removed) {
        rows.push({ key: `${rows.length}`, oldNo: oldNo++, marker: '-', content: line });
      } else {
        rows.push({ key: `${rows.length}`, oldNo: oldNo++, newNo: newNo++, marker: ' ', content: line });
      }
    }
  }
  return rows;
}

const GUTTER_STYLE: Record<DiffRow['marker'], { bg?: string; fg: string }> = {
  ' ': { fg: 'gray' },
  '+': { bg: 'green', fg: 'black' },
  '-': { bg: 'red', fg: 'black' },
};

const DiffRowLine: React.FC<{ row: DiffRow; gutterWidth: number }> = ({ row, gutterWidth }) => {
  const oldCol = (row.oldNo ?? '').toString().padStart(gutterWidth, ' ');
  const newCol = (row.newNo ?? '').toString().padStart(gutterWidth, ' ');
  const style = GUTTER_STYLE[row.marker];
  return (
    <Text>
      <Text dimColor>
        {oldCol} {newCol}{' '}
      </Text>
      <Text backgroundColor={style.bg} color={style.fg}>
        {row.marker} {row.content}
      </Text>
    </Text>
  );
};

/**
 * The fix-confirm gate's "Show details" panel — a small, clearly
 * bounded diff view (its own bordered box, separate from the role log
 * and from the plain-text fix-attempt line above it) so a multi-line
 * edit reads the way `git diff` or a PR review does: per-line +/-,
 * old/new line numbers, unchanged lines kept for orientation.
 */
const FixDiffBlock: React.FC<{ candidate: FixCandidate }> = ({ candidate }) => {
  const rows = buildDiffRows(candidate.oldString, candidate.newString, candidate.finding.lineStart);
  const maxLineNo = Math.max(candidate.finding.lineStart, ...rows.map((r) => r.oldNo ?? r.newNo ?? 0));
  const gutterWidth = String(maxLineNo).length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginLeft={2} marginBottom={1}>
      <Text dimColor>
        {candidate.finding.file} — {candidate.description}
      </Text>
      {rows.map((row) => (
        <DiffRowLine key={row.key} row={row} gutterWidth={gutterWidth} />
      ))}
    </Box>
  );
};

const FixLogLine: React.FC<{ entry: FixLogEntry }> = ({ entry }) => {
  if (entry.kind === 'iteration') {
    return (
      <Text bold dimColor>
        — Fix iteration {entry.iteration} ({entry.blockingCount} blocking finding{entry.blockingCount === 1 ? '' : 's'}) —
      </Text>
    );
  }
  if (entry.kind === 'candidate' && entry.candidate) {
    return (
      <Text color="yellow" dimColor>
        💡 [LLM] {entry.candidate.finding.file} — {entry.candidate.description} (proposed)
      </Text>
    );
  }
  if (entry.kind === 'attempt' && entry.record) {
    const stageLabel = entry.record.fixerStage === 'deterministic' ? 'deterministic' : 'LLM';
    return (
      <Text color="cyan">
        🔧 [{stageLabel}] {entry.record.file} — {entry.record.description} (applied)
      </Text>
    );
  }
  if (entry.kind === 'rerun' && entry.output) {
    return <RoleLine entry={{ role: entry.output.role, status: entry.output.verdict, summary: entry.output.summary }} />;
  }
  return null;
};

export const ReviewSessionView: React.FC<ReviewSessionViewProps> = ({ events, interactionChannel }) => {
  const [log, setLog] = useState<RoleLogEntry[]>([]);
  const [fixLog, setFixLog] = useState<FixLogEntry[]>([]);
  // Every LLM-generated candidate for the iteration currently awaiting
  // the batch gate — replaced wholesale by 'fix_batch_ready', not
  // accumulated, so it always reflects exactly what's pending right now.
  const [pendingBatch, setPendingBatch] = useState<readonly FixCandidate[]>([]);
  const [gate, setGate] = useState<StageGateRequest | null>(null);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);

  useEffect(() => {
    return events.subscribe((event: ReviewSessionEvent) => {
      if (event.type === 'role_start') {
        setLog((prev) => [...prev, { role: event.role, status: 'running' }]);
      } else if (event.type === 'role_complete') {
        setLog((prev) =>
          prev.map((entry) =>
            entry.role === event.output.role
              ? { role: entry.role, status: event.output.verdict, summary: event.output.summary, findings: event.output.findings }
              : entry,
          ),
        );
      } else if (event.type === 'fix_iteration_start') {
        setFixLog((prev) => [
          ...prev,
          { key: `iter-${event.iteration}`, kind: 'iteration', iteration: event.iteration, blockingCount: event.blockingFindingsCount },
        ]);
      } else if (event.type === 'fix_candidate') {
        // Deterministic fixes apply immediately (their 'attempt' line
        // below is the only line they need). LLM candidates get a
        // "proposed" line the moment they're generated, ahead of the
        // batch gate — so the user still watches each one arrive live,
        // just without an approval interruption per fix.
        if (event.candidate.fixerStage === 'llm') {
          setFixLog((prev) => [
            ...prev,
            { key: `candidate-${event.candidate.finding.id}`, kind: 'candidate', candidate: event.candidate },
          ]);
        }
      } else if (event.type === 'fix_batch_ready') {
        setPendingBatch(event.candidates);
      } else if (event.type === 'fix_attempt') {
        setFixLog((prev) => [...prev, { key: `attempt-${event.record.findingId}-${event.record.iteration}`, kind: 'attempt', record: event.record }]);
      } else if (event.type === 'fix_role_rerun') {
        setFixLog((prev) => [...prev, { key: `rerun-${event.output.role}-${prev.length}`, kind: 'rerun', output: event.output }]);
      }
    });
  }, [events]);

  useEffect(() => {
    return interactionChannel.onInteraction((event) => {
      if (event.type !== 'stage_gate_request') return;
      setGate(event.request);
      // Keep "details" visible across the re-prompt for the same stage;
      // clear it only when the gate has moved on to a different one.
      setDetailsFor((prev) => (prev === event.request.stage ? prev : null));
    });
  }, [interactionChannel]);

  const handleDecision = useCallback(
    (decision: StageGateDecision) => {
      if (!gate) return;
      if (decision === 'details') {
        // The gate re-prompts for the SAME request after 'details'
        // (`gateForFix`/`gateForFixBatch`/`orchestrator.ts`'s gate loop
        // all loop on it) — keep the box mounted so it can show the
        // next decision, instead of clearing it out from under itself.
        setDetailsFor(gate.stage);
      } else {
        // A real decision (continue/skip/abort) resolves this gate for
        // good — clear it so the prompt box disappears immediately
        // rather than lingering on screen, unanswered-looking, until
        // (if ever) the next gate request arrives. Reported live: a
        // crash right after "Apply all of these fixes" left the box
        // frozen mid-selection with no sign the decision had landed.
        setGate(null);
      }
      interactionChannel.respondStageGate(gate.id, decision);
    },
    [gate, interactionChannel],
  );

  const isFixBatchGate = gate?.stage.startsWith('fix-batch:') ?? false;

  return (
    <Box flexDirection="column" paddingY={1}>
      {log.map((entry) => (
        <Box key={entry.role} flexDirection="column" marginBottom={1}>
          <RoleLine entry={entry} />
          {detailsFor === entry.role && entry.findings && <FindingsBlock findings={entry.findings} />}
          {gate && gate.stage === entry.role && <StageGatePrompt request={gate} onDecision={handleDecision} />}
        </Box>
      ))}

      {fixLog.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Breaker-Builder loop</Text>
          {fixLog.map((entry) => (
            <Box key={entry.key} flexDirection="column">
              <FixLogLine entry={entry} />
            </Box>
          ))}
          {gate && isFixBatchGate && (
            <Box flexDirection="column">
              {detailsFor === gate.stage &&
                pendingBatch.map((candidate) => <FixDiffBlock key={candidate.finding.id} candidate={candidate} />)}
              <StageGatePrompt request={gate} onDecision={handleDecision} />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
