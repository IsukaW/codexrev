/**
 * Codexrev — non-interactive CLI driver.
 *
 * Runs a single prompt through the agent loop and streams the result
 * to stdout. Used by `codexrev --print "..."`, CI scripts, and the
 * programmatic API.
 */

import { logger } from '../utils/logger.js';
import { runAgent } from '../core/turn.js';
import { buildProvider } from '../providers/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createMcpRegistry } from '../mcp/registry.js';
import type { Settings } from '../config/schema.js';
import type { ExtensionRegistry } from '../extensions/types.js';

export interface NonInteractiveOptions {
  prompt: string;
  settings: Settings;
  outputFormat: 'text' | 'json' | 'stream-json';
  extensions?: ExtensionRegistry;
}

export async function runNonInteractive(opts: NonInteractiveOptions): Promise<void> {
  const { prompt, settings, outputFormat } = opts;
  const provider = buildProvider(settings);
  const tools = await createToolRegistry(settings);
  const mcp = await createMcpRegistry(settings);

  if (outputFormat === 'json') {
    const result = await runAgent({
      prompt,
      provider,
      tools,
      mcp,
      settings,
      stream: false,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (outputFormat === 'stream-json') {
    let buffer = '';
    for await (const event of runAgent({
      prompt,
      provider,
      tools,
      mcp,
      settings,
      stream: true,
    })) {
      buffer += JSON.stringify(event) + '\n';
    }
    process.stdout.write(buffer);
    return;
  }

  // text (default)
  for await (const event of runAgent({
    prompt,
    provider,
    tools,
    mcp,
    settings,
    stream: true,
  })) {
    if (event.kind === 'text_delta') {
      process.stdout.write(event.text);
    } else if (event.kind === 'tool_call') {
      logger.info('tool call', { name: event.toolCall.name });
    } else if (event.kind === 'turn_complete') {
      process.stdout.write('\n');
    }
  }
}
