/**
 * Codexrev — built-in tools entry point.
 *
 * Bundled as `codexrev/tools` so consumers who only need the tool
 * implementations don't have to pull the entire CLI/TUI.
 */

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

/**
 * Convenience helper: return the list of built-in `Tool` instances for
 * a given settings object. Useful for tests, scripting, or surfacing in
 * the UI.
 */
export function listTools(settings: Settings = {} as Settings): Tool[] {
  return builtinTools(settings);
}
