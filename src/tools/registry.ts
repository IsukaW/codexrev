// A Tool is a self-describing unit the model can invoke — a JSON-Schema-ish
// declaration plus an execute(args, ctx) function.

import type { ToolDeclaration, ToolParameters } from '../core/types.js';
import type { Settings } from '../config/schema.js';
import { builtinTools, type BuiltinToolDeps } from './builtin.js';
import { createAskUserTool } from './askUser.js';
import type { InteractionChannel } from '../core/interaction.js';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** approval callback — true to allow, false to deny */
  ask?: (toolName: string, args: unknown) => Promise<boolean>;
}

export interface ToolResult {
  output: string | unknown;
  isError?: boolean;
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

export async function createToolRegistry(
  settings: Settings,
  interactionChannel?: InteractionChannel,
  deps: BuiltinToolDeps = {},
): Promise<Map<string, Tool>> {
  const reg = new ToolRegistry();
  for (const t of builtinTools(settings, deps)) {
    reg.register(t);
  }
  if (interactionChannel) {
    reg.register(createAskUserTool(interactionChannel));
  }
  return reg.asMap();
}
