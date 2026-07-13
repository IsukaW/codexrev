/**
 * Codexrev — high-level agent factory for programmatic use.
 *
 * Consumers get a long-lived `Agent` object that pre-wires provider +
 * tools + MCP and exposes a `send(prompt)` method returning an
 * `AgentResult` or `AsyncIterable<AgentEvent>`.
 */

import { buildProvider } from '../providers/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createMcpRegistry } from '../mcp/registry.js';
import { runAgent, type AgentEvent, type AgentResult } from './turn.js';
import type { ContentGenerator, ProviderId } from './types.js';
import type { Settings } from '../config/schema.js';
import { loadSettings } from '../config/loader.js';

export interface AgentOptions {
  /** Pre-resolved settings. If omitted, `loadSettings()` is called. */
  settings?: Settings;
  /** Override the provider name (e.g. 'anthropic'). */
  provider?: ProviderId;
  /** Override the model name. */
  model?: string;
  /** Optional pre-built ContentGenerator. */
  contentGenerator?: ContentGenerator;
}

export interface Agent {
  readonly settings: Settings;
  readonly provider: ContentGenerator;
  send(prompt: string): Promise<AgentResult>;
  stream(prompt: string): AsyncIterable<AgentEvent>;
  close(): Promise<void>;
}

export async function createAgent(opts: AgentOptions = {}): Promise<Agent> {
  const settings = opts.settings ?? (await loadSettings());
  if (opts.provider) settings.provider = opts.provider;
  if (opts.model) settings.model = opts.model;
  const provider = opts.contentGenerator ?? buildProvider(settings);
  const tools = await createToolRegistry(settings);
  const mcp = await createMcpRegistry(settings);

  return {
    settings,
    provider,
    send: (prompt) =>
      runAgent({ prompt, provider, tools, mcp, settings, stream: false }) as Promise<AgentResult>,
    stream: (prompt) =>
      runAgent({ prompt, provider, tools, mcp, settings, stream: true }) as AsyncIterable<AgentEvent>,
    async close() {
      await mcp.close();
    },
  };
}
