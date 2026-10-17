/**
 * Persistent Ink app for one interactive `codexrev spec watch`.
 *
 * Renders the SAME typed events the plain-line fallback consumes, through
 * the pure reducer in `specSessionState.ts` — the view itself holds no
 * pipeline logic: events → reducer → render (same separation as
 * review-pipeline's ReviewSessionView, but self-contained).
 *
 * Shows: watched paths + debounce, per-batch pipeline progress
 * (diff → infer → compare → proposal → outputs), the running event log,
 * the latest drift status, a banner whenever drift alerts fire (red for
 * critical conflicts), and running counts (analyzed / deduped / proposals).
 *
 * Deliberately passive: no `useInput`, so stdin stays in cooked mode and
 * Ctrl+C reaches runWatchSession's SIGINT handler, which emits `stopped`
 * and unmounts the tree.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { SpecSessionEventBus } from './specSessionEvents.js';
import {
  initialSpecSessionState,
  reduceSpecSession,
  type SpecSessionState,
} from './specSessionState.js';
import type { SpecWatchStage } from './specSessionEvents.js';

interface SpecSessionViewProps {
  readonly events: SpecSessionEventBus;
}

const STAGES: ReadonlyArray<{ id: SpecWatchStage; label: string }> = [
  { id: 'diff', label: 'diff' },
  { id: 'infer', label: 'infer' },
  { id: 'compare', label: 'compare' },
  { id: 'proposal', label: 'proposal' },
  { id: 'outputs', label: 'outputs' },
];

const DRIFT_COLOR: Record<string, string> = {
  conflicting: 'red',
  modified: 'yellow',
  new: 'cyan',
  aligned: 'green',
  'no-semantic-change': 'gray',
};

const StageTrail: React.FC<{ stage: SpecSessionState['stage'] }> = ({ stage }) => {
  const currentIndex = stage === null ? -1 : STAGES.findIndex((s) => s.id === stage);
  return (
    <Box>
      {STAGES.map((s, i) => {
        const persisting = stage === 'persist';
        const done = persisting || currentIndex > i;
        const current = i === currentIndex && !persisting;
        return (
          <Box key={s.id}>
            {current ? (
              <Text color="cyan">
                <Spinner type="dots" /> <Text bold>{s.label}</Text>
              </Text>
            ) : done ? (
              <Text color="green">✔ {s.label}</Text>
            ) : (
              <Text dimColor>· {s.label}</Text>
            )}
            {i < STAGES.length - 1 && <Text dimColor>{'  →  '}</Text>}
          </Box>
        );
      })}
    </Box>
  );
};

const AlertBanner: React.FC<{ state: SpecSessionState }> = ({ state }) => {
  if (state.alerts.length === 0) return null;
  const critical = state.alerts.filter((a) => a.severity === 'critical').length;
  const color = critical > 0 ? 'red' : 'yellow';
  const latest = state.alerts[state.alerts.length - 1];
  return (
    <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {critical > 0 ? '✖' : '⚑'} {state.alerts.length} drift alert
        {state.alerts.length === 1 ? '' : 's'}
        {critical > 0 ? ` (${critical} critical — URS conflict)` : ''}
      </Text>
      <Text color={color}>
        {latest.file} — {latest.reason}
      </Text>
      <Text dimColor>{latest.proposedNextAction}</Text>
    </Box>
  );
};

export const SpecSessionView: React.FC<SpecSessionViewProps> = ({ events }) => {
  const [state, setState] = useState<SpecSessionState>(initialSpecSessionState());

  useEffect(() => {
    return events.subscribe((event) => {
      setState((prev) => reduceSpecSession(prev, event));
    });
  }, [events]);

  const drift = state.latestDrift;

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Living Specification Engine
        </Text>
        <Text dimColor>{`  watching ${state.root || '.'}`}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          <Text dimColor>paths </Text>
          {state.watchedPaths.join(', ')}
          <Text dimColor>{`   debounce ${state.debounceMs} ms`}</Text>
          {state.pendingPaths.length > 0 && (
            <Text color="yellow">{`   debouncing ${state.pendingPaths.join(', ')}`}</Text>
          )}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <StageTrail stage={state.stage} />
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {state.log.slice(-8).map((entry) => (
          <Text key={entry.key} dimColor={entry.kind === 'change_detected' || entry.kind === 'stage'}>
            {entry.text}
          </Text>
        ))}
        {state.log.length === 0 && <Text dimColor>waiting for changes…</Text>}
      </Box>

      {drift && (
        <Box marginBottom={1}>
          <Text>
            <Text dimColor>latest drift </Text>
            <Text color={DRIFT_COLOR[drift] ?? 'white'} bold>
              {drift}
            </Text>
            {state.lastChangeId && <Text dimColor>{`   change ${state.lastChangeId.slice(0, 12)}`}</Text>}
          </Text>
        </Box>
      )}

      <AlertBanner state={state} />

      <Box>
        <Text dimColor>
          analyzed {state.counts.analyzed} · deduped {state.counts.deduped} · proposals{' '}
          {state.counts.proposals} · alerts {state.counts.alerts}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Ctrl+C to stop</Text>
      </Box>
    </Box>
  );
};
