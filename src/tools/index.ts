// Built-in tools entry point, published as codexrev/tools so consumers who just want
// the tool implementations don't have to pull in the whole CLI/TUI.

import type { Settings } from '../config/schema.js';
import { builtinTools } from './builtin.js';
import type { Tool } from './registry.js';

export { builtinTools, type BuiltinToolName } from './builtin.js';
export { ToolRegistry, type Tool, type ToolContext, type ToolResult } from './registry.js';
export {
  type ShellTool,
  type FileReadTool,
  type FileWriteTool,
  type FileEditTool,
  type GlobTool,
  type GrepTool,
  type WebFetchTool,
  type WebSearchTool,
} from './specs.js';

// list of built-in Tool instances for a settings object — used by tests, scripting, UI
export function listTools(settings: Settings = {} as Settings): Tool[] {
  return builtinTools(settings);
}
