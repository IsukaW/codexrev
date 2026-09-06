// An "extension" is a user-installed plugin living in ~/.codexrev/extensions/<name>/,
// shipping a codexrev-extension.json manifest plus optional prompts/themes/tools/commands.

export type ExtensionHook =
  | 'commands' // slash-commands in the TUI
  | 'tools' // tools the model can call
  | 'themes'
  | 'prompts' // snippets added to system context
  | 'mcp' // MCP servers to load on startup
  | 'pre-prompt' // runs before each user prompt
  | 'post-response'; // runs after the model finishes a turn

export interface ExtensionCommand {
  name: string;
  description: string;
  /** path relative to extension root */
  handler: string;
  hint?: string;
}

export interface ExtensionToolRef {
  name: string;
  /** path relative to extension root, exports a Tool */
  module: string;
}

export interface ExtensionTheme {
  name: string;
  file: string;
}

export interface ExtensionPrompt {
  id: string;
  file: string;
}

export interface ExtensionManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** semver */
  minCodexrevVersion?: string;
  hooks: ExtensionHook[];
  commands?: ExtensionCommand[];
  tools?: ExtensionToolRef[];
  themes?: ExtensionTheme[];
  prompts?: ExtensionPrompt[];
}

export interface LoadedExtension {
  path: string;
  manifest: ExtensionManifest;
}

export interface ExtensionRegistry {
  extensions: LoadedExtension[];
  commands: Array<ExtensionCommand & { extension: string }>;
  tools: Array<ExtensionToolRef & { extension: string; path: string }>;
  themes: Array<ExtensionTheme & { extension: string; path: string }>;
  prompts: Array<ExtensionPrompt & { extension: string; path: string }>;
}