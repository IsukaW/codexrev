// extension system entry point

export {
  loadExtensions,
  installExtension,
  uninstallExtension,
  getExtensionCommands,
  getExtensionTools,
  getExtensionThemes,
  getExtensionPrompts,
  type LoaderOptions,
} from './loader.js';
export type {
  ExtensionManifest,
  ExtensionHook,
  ExtensionCommand,
  ExtensionToolRef,
  ExtensionTheme,
  ExtensionPrompt,
  LoadedExtension,
  ExtensionRegistry,
} from './types.js';