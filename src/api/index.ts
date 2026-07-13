/**
 * Codexrev — programmatic API entry point.
 *
 * Embeds of Codexrev (other Node.js apps, tests, automation) import
 * from `codexrev` and call the functions exported here.
 */

// ─── Core types ───────────────────────────────────────────────────
export type {
  Message,
  ContentPart,
  TextPart,
  BlobPart,
  ToolCallPart,
  ToolResultPart,
  ToolDeclaration,
  ToolParameters,
  StreamEvent,
  UsageStats,
  GenerateRequest,
  GenerateResponse,
  ContentGenerator,
  ContentGeneratorConfig,
  Role,
  ProviderId,
  TurnFinishReason,
} from '../core/types.js';
export { ProviderError } from '../core/types.js';

// ─── Agent loop ───────────────────────────────────────────────────
export { runAgent, type AgentEvent, type AgentResult } from '../core/turn.js';
export { createAgent, type Agent, type AgentOptions } from '../core/agent.js';

// ─── Provider factories ───────────────────────────────────────────
export { buildProvider, type ProviderHandle } from '../providers/index.js';

// ─── Configuration ────────────────────────────────────────────────
export type {
  Settings,
  ProviderSettings,
  McpServerEntry,
  ThemeName,
} from '../config/schema.js';
// `SandboxMode` is exported below from `../sandbox/index.js` (canonical).
export { DEFAULT_SETTINGS } from '../config/schema.js';
export { loadSettings, saveSettings } from '../config/loader.js';

// ─── Tools ────────────────────────────────────────────────────────
export { ToolRegistry, type Tool, type ToolResult, type ToolContext } from '../tools/registry.js';
export { builtinTools, type BuiltinToolName } from '../tools/builtin.js';
export { createToolRegistry } from '../tools/registry.js';
export type {
  ShellTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
  WebSearchTool,
} from '../tools/specs.js';

// ─── MCP ──────────────────────────────────────────────────────────
export { createMcpRegistry, type McpRegistry } from '../mcp/registry.js';

// ─── Errors ───────────────────────────────────────────────────────
export {
  CodexrevError,
  ConfigError,
  AuthError,
  ToolError,
  SandboxError,
  McpError,
  CheckpointError as _LegacyCheckpointError,
} from '../utils/errors.js';
// Re-export the canonical CheckpointError from the new services module
// (preferred over the legacy shim above).
export { CheckpointError } from '../services/checkpoint.js';

// ─── Checkpointing ───────────────────────────────────────────────
export {
  CheckpointService,
  openCheckpoints,
  type CheckpointOptions,
  type CheckpointRecord,
} from '../services/checkpoint.js';

// ─── Sandboxing ──────────────────────────────────────────────────
export {
  SandboxManager,
  SandboxError as _LegacySandboxError,
  SeatbeltSandbox,
  DockerSandbox,
  PodmanSandbox,
  NoSandbox,
  resolveSandbox,
  type Sandbox,
  type SandboxMode,
  type SandboxOptions,
  type SandboxResult,
  type ResolvedSandbox,
} from '../sandbox/index.js';

// ─── Telemetry ───────────────────────────────────────────────────
export {
  initTelemetry,
  shutdownTelemetry,
  getTracer,
  withSpan,
  withSpanSync,
  recordEvent,
  isTelemetryEnabled,
  type TelemetryOptions,
} from '../telemetry/index.js';

// ─── Paths / logger ──────────────────────────────────────────────
export { getCodexrevPaths, ensureCodexrevHome, findProjectConfig } from '../utils/paths.js';
export { logger, type LogLevel } from '../utils/logger.js';
export { ENV } from '../utils/env.js';

// Extensions
export {
  loadExtensions,
  installExtension,
  uninstallExtension,
  getExtensionCommands,
  getExtensionTools,
  getExtensionThemes,
  getExtensionPrompts,
} from '../extensions/index.js';
export type {
  ExtensionManifest,
  ExtensionHook,
  ExtensionCommand,
  ExtensionToolRef,
  ExtensionTheme,
  ExtensionPrompt,
  LoadedExtension,
  ExtensionRegistry,
} from '../extensions/types.js';
