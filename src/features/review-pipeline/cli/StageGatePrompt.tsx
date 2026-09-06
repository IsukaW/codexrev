/**
 * Codexrev — review-pipeline stage-gate prompt (Continue/Details/Skip/Abort).
 *
 * Mirrors `src/ui/ClarificationPrompt.tsx`'s `FixConfirmPrompt` — same
 * Ink primitives (`Box`/`Text`/`SelectInput`), same bordered-panel
 * style — rather than a new prompt component built from scratch (Phase
 * 5's explicit reuse instruction). Kept feature-local because the
 * "Skip/Abort a role" framing is specific to the review pipeline, while
 * the underlying `StageGateRequest` in `core/interaction.ts` stays
 * generic enough for any future multi-stage pipeline to reuse.
 *
 * Rendered inside `ReviewSessionView`'s persistent scrolling role log,
 * directly below that role's own verdict/summary line — so this box
 * only shows the decision itself, not a second copy of the verdict.
 */

import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { StageGateDecision, StageGateRequest } from '../../../core/interaction.js';

interface StageGatePromptProps {
  request: StageGateRequest;
  onDecision: (decision: StageGateDecision) => void;
}

/**
 * `stage` is `fix-batch:<iteration>` for the Breaker-Builder loop's
 * batch fix-confirm gate (`breakerBuilderLoop.ts`'s `gateForFixBatch` —
 * one gate per iteration, covering every LLM-generated edit that
 * iteration proposed) and the bare `RoleId` for a post-role gate
 * (`orchestrator.ts`). The two are semantically very different
 * decisions — "apply this batch of edits?" vs. "keep going through the
 * roles?" — so they need different wording even though they share this
 * component and the same `StageGateDecision` values underneath. Getting
 * this wrong (reusing the role wording verbatim on a fix gate) is
 * exactly what caused the reported "fixes never apply" bug: "Skip
 * remaining roles" read like "move past this box" but actually declined
 * the fix being shown (see the Decision Log).
 */
const ROLE_GATE_ITEMS: Array<{ label: string; value: StageGateDecision }> = [
  { label: '▶️  Continue to the next role', value: 'continue' },
  { label: '🔍 Show details for this role', value: 'details' },
  { label: '⏭️  Skip remaining roles (keep what ran so far)', value: 'skip' },
  { label: '🛑 Abort the review', value: 'abort' },
];

const FIX_GATE_ITEMS: Array<{ label: string; value: StageGateDecision }> = [
  { label: '✅ Apply all of these fixes', value: 'continue' },
  { label: '🔍 Show details for these fixes', value: 'details' },
  { label: '⏭️  Skip all (leave these findings unresolved)', value: 'skip' },
  { label: '🛑 Abort the review', value: 'abort' },
];

const STATUS_COLOR: Record<string, string> = {
  pass: 'green',
  flag: 'yellow',
  block: 'red',
};

export const StageGatePrompt: React.FC<StageGatePromptProps> = ({ request, onDecision }) => {
  const handleSelect = useCallback(
    (item: { label: string; value: StageGateDecision }) => onDecision(item.value),
    [onDecision],
  );

  const color = STATUS_COLOR[request.status] ?? 'white';
  const isFixGate = request.stage.startsWith('fix-batch:');
  const items = isFixGate ? FIX_GATE_ITEMS : ROLE_GATE_ITEMS;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginY={1}>
      <Text dimColor>What would you like to do?</Text>
      <SelectInput items={items} onSelect={handleSelect} />
    </Box>
  );
};
