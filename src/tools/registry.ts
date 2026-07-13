/**
 * Codexrev — tool registry.
 *
 * A `Tool` is a self-describing unit the model can invoke. Each tool
 * has a JSON-Schema-ish `declaration` (passed to the model) and an
 * `execute(args, ctx)` function.
 */

import type { ToolDeclaration, ToolParameters } from '../core/types.js';
import type { Settings } from '../config/schema.js';
import { builtinTools } from './builtin.js';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Optional approval callback. Return `true` to allow, `false` to deny. */
  ask?: (toolName: string, args: unknown) => Promise<boolean>;
}

export interface ToolResult {
  /** String output for text-only LLMs, or structured JSON for richer models. */
  output: string | unknown;
  isError?: boolean;
  /** Optional metadata to surface in the UI. */
  metadata?: Record<string, unknown>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;
  readonly declaration: ToolDeclaration;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  unregister(name: string): this {
    this.tools.delete(name);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  asMap(): Map<string, Tool> {
    return new Map(this.tools);
  }
}

/** Build a registry pre-populated with the built-in tools. */
export async function createToolRegistry(settings: Settings): Promise<Map<string, Tool>> {
  const reg = new ToolRegistry();
  for (const t of builtinTools(settings)) {
    reg.register(t);
  }
  return reg.asMap();
}
