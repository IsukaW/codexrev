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
import { createMcpRegistry } from '../mcp/registry.js';
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
  const tools = await createToolRegistry(settings);
  const mcp = await createMcpRegistry(settings);

  const app = render(
    React.createElement(App, {
      settings,
      extensions,
      runAgent: (prompt: string) =>
        runAgent({ prompt, provider, tools, mcp, settings, stream: true }),
    }),
  );
  await app.waitUntilExit();
  logger.info('TUI exited');
}