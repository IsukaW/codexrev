/**
 * Codexrev — interactive TUI driver.
 *
 * Mounts the React + Ink app and waits for it to unmount.
 */

import { render } from 'ink';
import React from 'react';
import { logger } from '../utils/logger.js';
import { runAgent } from '../core/turn.js';
import type { Message } from '../core/types.js';
import { buildProvider } from '../providers/index.js';
import { createToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/registry.js';
import { createMcpRegistry } from '../mcp/registry.js';
import { InteractionChannel } from '../core/interaction.js';
import { SandboxManager } from '../sandbox/index.js';
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
  const sandbox = new SandboxManager(settings.sandbox);
  const tools = await createToolRegistry(settings, interactionChannel, { sandbox });
  const mcp = await createMcpRegistry(settings);

  // Live settings ref — the Control Panel edits settings in-session; the
  // agent loop must see the current values (approval policy, bypass, …).
  let live: Settings = settings;

  const app = render(
    React.createElement(App, {
      settings,
      extensions,
      interactionChannel,
      provider,
      tools,
      mcp,
      sandbox,
      onSettingsChange: (next: Settings) => {
        live = next;
      },
      runAgent: (
        prompt: string,
        systemPromptSuffix?: string,
        overrideTools?: Map<string, Tool>,
        contextMessages?: Message[],
      ) =>
        runAgent({
          prompt,
          provider,
          tools: overrideTools ?? tools,
          mcp,
          settings: live,
          stream: true,
          systemPromptSuffix,
          contextMessages,
          interactionChannel,
        }),
    }),
  );
  await app.waitUntilExit();
  logger.info('TUI exited');
}