/**
 * Codexrev — interactive TUI driver.
 *
 * Mounts the React + Ink app and waits for it to unmount.
 */

import { render } from 'ink';
import React from 'react';
import { logger } from '../utils/logger.js';
import { runAgent } from '../core/turn.js';
import { buildProvider } from '../providers/index.js';
import { createToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/registry.js';
import { createMcpRegistry } from '../mcp/registry.js';
import { InteractionChannel } from '../core/interaction.js';
import { App } from '../ui/App.js';
import type { Settings } from '../config/schema.js';
import type { ExtensionRegistry } from '../extensions/types.js';

export interface TuiOptions {
  settings: Settings;
  extensions?: ExtensionRegistry;
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const { settings, extensions } = opts;
  const provider = buildProvider(settings);
  const interactionChannel = new InteractionChannel();
  const tools = await createToolRegistry(settings, interactionChannel);
  const mcp = await createMcpRegistry(settings);

  const app = render(
    React.createElement(App, {
      settings,
      extensions,
      interactionChannel,
      provider,
      tools,
      mcp,
      runAgent: (prompt: string, systemPromptSuffix?: string, overrideTools?: Map<string, Tool>) =>
        runAgent({ prompt, provider, tools: overrideTools ?? tools, mcp, settings, stream: true, systemPromptSuffix }),
    }),
  );
  await app.waitUntilExit();
  logger.info('TUI exited');
}