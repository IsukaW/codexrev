// Pop-up prompts the pipeline can show mid-run: clarification questions
// (with optional quick-select suggestions), fix-confirm (continue/stop),
// and tool-approval gates.

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type {
  ClarificationRequest,
  FixConfirmRequest,
  ApprovalRequest,
  ApprovalDecision,
} from '../core/interaction.js';

interface ClarificationPromptProps {
  request: ClarificationRequest;
  onAnswer: (answer: string) => void;
}

export const ClarificationPrompt: React.FC<ClarificationPromptProps> = ({
  request,
  onAnswer,
}) => {
  const [useSuggestions, setUseSuggestions] = useState(request.suggestions.length > 0);
  const [customInput, setCustomInput] = useState('');

  const handleSelect = useCallback(
    (item: { label: string; value: string }) => {
      onAnswer(item.value);
    },
    [onAnswer],
  );

  const handleCustomSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed) onAnswer(trimmed);
    },
    [onAnswer],
  );

  useInput((_, key) => {
    // Tab flips between the suggestion list and typing a custom answer
    if (key.tab && request.suggestions.length > 0) {
      setUseSuggestions((prev) => !prev);
    }
  });

  const items = request.suggestions.map((s) => ({ label: s, value: s }));
  const hasSuggestions = items.length > 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        ❓ Clarification needed:
      </Text>
      <Text>{request.question}</Text>
      {request.context && (
        <Text dimColor>Context: {request.context}</Text>
      )}
      <Box marginTop={1} />

      {hasSuggestions && useSuggestions && (
        <>
          <Text dimColor>Suggestions (↑↓ to select, Enter to use, Tab to type your own):</Text>
          <SelectInput items={items} onSelect={handleSelect} />
        </>
      )}

      {(!hasSuggestions || !useSuggestions) && (
        <>
          <Text dimColor>
            {hasSuggestions ? 'Type your answer (Tab for suggestions): ' : 'Your answer: '}
          </Text>
          <Box>
            <Text color="yellow">{'>'} </Text>
            <TextInput
              value={customInput}
              onChange={setCustomInput}
              onSubmit={handleCustomSubmit}
              placeholder="Type your answer and press Enter…"
            />
          </Box>
        </>
      )}
    </Box>
  );
};

interface FixConfirmPromptProps {
  request: FixConfirmRequest;
  onDecision: (decision: 'continue' | 'stop') => void;
}

const fixConfirmItems = [
  { label: '🔄 Continue fixing', value: 'continue' as const },
  { label: '🛑 Stop here (keep last state)', value: 'stop' as const },
];

export const FixConfirmPrompt: React.FC<FixConfirmPromptProps> = ({
  request,
  onDecision,
}) => {
  const handleSelect = useCallback(
    (item: { label: string; value: 'continue' | 'stop' }) => {
      onDecision(item.value);
    },
    [onDecision],
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginY={1}>
      <Text bold color="red">
        ⚠️ Fix iteration {request.attempt}/{request.maxAttempts} — Verification {request.status === 'red' ? 'FAILED' : 'PASSED'}
      </Text>
      <Text>{request.summary}</Text>
      <Box marginTop={1} />
      <Text dimColor>What would you like to do?</Text>
      <SelectInput items={fixConfirmItems} onSelect={handleSelect} />
    </Box>
  );
};

interface ApprovalPromptProps {
  request: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
}

const approvalItems = [
  { label: '✔ Approve once', value: 'approve' as const },
  { label: '✔✔ Approve for the rest of this session', value: 'approve-session' as const },
  { label: '✗ Deny', value: 'deny' as const },
];

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({ request, onDecision }) => {
  const handleSelect = useCallback(
    (item: { value: ApprovalDecision }) => onDecision(item.value),
    [onDecision],
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginY={1}>
      <Text bold color="magenta">
        🔐 Approval required — {request.toolName}
      </Text>
      <Text>{request.summary}</Text>
      <Box marginTop={1} />
      <SelectInput items={approvalItems} onSelect={handleSelect} />
      <Text dimColor>Tip: toggle Bypass ALL approvals in the Control Panel (Ctrl+S) to skip these.</Text>
    </Box>
  );
};
