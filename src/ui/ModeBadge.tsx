// Color-coded badge for the current mode — full version for the header,
// inline version next to the prompt.

import React from 'react';
import { Box, Text } from 'ink';
import type { InteractionMode } from '../core/modes.js';
import { MODE_CONFIG } from '../core/modes.js';

interface ModeBadgeProps {
  mode: InteractionMode;
}

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

export const ModeBadgeInline: React.FC<ModeBadgeProps> = ({ mode }) => {
  const config = MODE_CONFIG[mode];
  return (
    <Text bold color={config.color}>
      {config.label}{' '}
    </Text>
  );
};
