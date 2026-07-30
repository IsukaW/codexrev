/**
 * Codexrev — mode badge component.
 *
 * Renders a color-coded badge showing the current interaction mode.
 * Two variants:
 *   - `ModeBadge`        — full badge for the header (with hint text)
 *   - `ModeBadgeCompact` — small inline badge next to the input prompt
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { InteractionMode } from '../core/modes.js';
import { MODE_CONFIG } from '../core/modes.js';

interface ModeBadgeProps {
  mode: InteractionMode;
}

/** Full badge shown in the TUI header. */
export const ModeBadge: React.FC<ModeBadgeProps> = ({ mode }) => {
  const config = MODE_CONFIG[mode];

  return (
    <Box>
      <Text> · </Text>
      <Text bold color={config.color}>
        [{config.label}]
      </Text>
      <Text dimColor> Tab to switch</Text>
    </Box>
  );
};

/** Compact inline badge rendered next to the `>` input prompt. */
export const ModeBadgeInline: React.FC<ModeBadgeProps> = ({ mode }) => {
  const config = MODE_CONFIG[mode];
  return (
    <Text bold color={config.color}>
      {config.label}{' '}
    </Text>
  );
};
