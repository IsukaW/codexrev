/**
 * Codexrev — extension type definitions.
 *
 * An "extension" is a user-installed plugin that lives in
 * `~/.codexrev/extensions/<name>/`. Each extension ships a
 * `codexrev-extension.json` manifest and optional assets (prompts,
 * themes, custom tools, slash commands).
 */

/** Capabilities an extension may declare in its manifest. */
export type ExtensionHook =
  | 'commands' // adds slash-commands to the TUI
  | 'tools' // adds tools the model can call
  | 'themes' // adds colour themes
  | 'prompts' // adds prompt snippets to system context
  | 'mcp' // adds MCP server entries to load on startup
  | 'pre-prompt' // runs before each user prompt (transforms input)
  | 'post-response'; // runs after the model finishes a turn

export interface ExtensionCommand {
  /** Slash-command identifier (e.g. "deploy"). */
  name: string;
  /** One-line description shown in /help. */
  description: string;
  /** Path (relative to extension root) to a JS/TS handler module. */
  handler: string;
  /** Optional argument-hint shown in /help. */
  hint?: string;
}

export interface ExtensionToolRef {
  /** Tool name to register globally. */
  name: string;
  /** Path (relative to extension root) to a module exporting a `Tool`. */
  module: string;
}

export interface ExtensionTheme {
  /** Theme name used by `settings.theme`. */
  name: string;
  /** Path (relative to extension root) to a JSON theme file. */
  file: string;
}

export interface ExtensionPrompt {
  /** Identifier for ordering. */
  id: string;
  /** Path (relative to extension root) to a text/markdown file. */
  file: string;
}

export interface ExtensionManifest {
  /** Extension display name. */
  name: string;
  /** Semantic version of the extension. */
  version: string;
  /** Short description. */
  description?: string;
  /** Author info. */
  author?: string;
  /** Minimum Codexrev version required (semver). */
  minCodexrevVersion?: string;
  /** Set of capabilities declared by this extension. */
  hooks: ExtensionHook[];
  /** Slash-command definitions. */
  commands?: ExtensionCommand[];
  /** Custom tool registrations. */
  tools?: ExtensionToolRef[];
  /** Theme contributions. */
  themes?: ExtensionTheme[];
  /** Prompt snippet contributions. */
  prompts?: ExtensionPrompt[];
}

/** Loaded extension — manifest + resolved absolute path. */
export interface LoadedExtension {
  /** Absolute path to the extension root directory. */
  path: string;
  manifest: ExtensionManifest;
}

/** Aggregate registry of all loaded extensions. */
export interface ExtensionRegistry {
  extensions: LoadedExtension[];
  commands: Array<ExtensionCommand & { extension: string }>;
  tools: Array<ExtensionToolRef & { extension: string; path: string }>;
  themes: Array<ExtensionTheme & { extension: string; path: string }>;
  prompts: Array<ExtensionPrompt & { extension: string; path: string }>;
}