// Programmatic API entry point — embedders import `codexrev` and call what's exported here.

// core types
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
  ProviderCapabilities,
  Role,
  ProviderId,
  TurnFinishReason,
} from '../core/types.js';
export { ProviderError } from '../core/types.js';

// agent loop
export { runAgent, type AgentEvent, type AgentResult } from '../core/turn.js';
export { createAgent, type Agent, type AgentOptions } from '../core/agent.js';

// provider factories
export { buildProvider, type ProviderHandle } from '../providers/index.js';
export type { ProviderMeta } from '../providers/registry.js';
export {
  PROVIDER_REGISTRY,
  PROVIDER_IDS,
  isProviderId,
  providerMeta,
} from '../providers/registry.js';
export { probeLocalProvider, resolveBaseUrlForProvider } from '../providers/health.js';

// configuration
export type {
  Settings,
  ProviderSettings,
  McpServerEntry,
  ThemeName,
} from '../config/schema.js';
// SandboxMode is re-exported below from sandbox/index.js (that's the canonical one)
export { DEFAULT_SETTINGS } from '../config/schema.js';
export { loadSettings, saveSettings } from '../config/loader.js';

// tools
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

// mcp
export { createMcpRegistry, type McpRegistry } from '../mcp/registry.js';

// errors
export {
  CodexrevError,
  ConfigError,
  AuthError,
  ToolError,
  SandboxError,
  McpError,
  LocalServerError,
  CheckpointError as _LegacyCheckpointError,
} from '../utils/errors.js';
// prefer this one over the legacy shim above
export { CheckpointError } from '../services/checkpoint.js';

// checkpointing
export {
  CheckpointService,
  openCheckpoints,
  type CheckpointOptions,
  type CheckpointRecord,
} from '../services/checkpoint.js';

// sandboxing
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

// telemetry
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

// paths / logger
export { getCodexrevPaths, ensureCodexrevHome, findProjectConfig } from '../utils/paths.js';
export { logger, type LogLevel } from '../utils/logger.js';
export { ENV } from '../utils/env.js';

// extensions
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
