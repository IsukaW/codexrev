/**
 * Codexrev — extension loader.
 *
 * Reads every `codexrev-extension.json` manifest under the user's
 * extensions directory and assembles them into an `ExtensionRegistry`.
 * The registry is consumed by the CLI to inject commands, tools,
 * themes, and prompt snippets.
 *
 * Extensions are NOT auto-loaded — the user runs
 * `codexrev extensions install <dir>` (or copies the directory
 * manually) and the next launch picks them up.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getCodexrevPaths } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import type {
  ExtensionCommand,
  ExtensionManifest,
  ExtensionPrompt,
  ExtensionRegistry,
  ExtensionTheme,
  ExtensionToolRef,
  LoadedExtension,
} from './types.js';

const MANIFEST_FILE = 'codexrev-extension.json';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist']);

export interface LoaderOptions {
  /** Override the extensions root. Defaults to ~/.codexrev/extensions. */
  root?: string;
  /** When true, log warnings about malformed manifests. */
  verbose?: boolean;
}

/**
 * Scan the extensions directory and load every well-formed manifest.
 * Malformed manifests are logged and skipped — one bad extension must
 * not break the CLI.
 */
export async function loadExtensions(opts: LoaderOptions = {}): Promise<ExtensionRegistry> {
  const root = opts.root ?? getCodexrevPaths().extensionsDir;
  const registry: ExtensionRegistry = {
    extensions: [],
    commands: [],
    tools: [],
    themes: [],
    prompts: [],
  };

  if (!existsSync(root)) {
    if (opts.verbose) logger.debug(`extensions root missing: ${root}`);
    return registry;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    logger.warn(`could not read extensions root ${root}`, { err: String(err) });
    return registry;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const extRoot = path.join(root, entry.name);
    const manifestPath = path.join(extRoot, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      if (opts.verbose) {
        logger.debug(`skipping ${entry.name}: missing ${MANIFEST_FILE}`);
      }
      continue;
    }
    try {
      const loaded = await loadOne(extRoot, manifestPath);
      registry.extensions.push(loaded);
      addToRegistry(registry, loaded);
    } catch (err) {
      logger.warn(`failed to load extension ${entry.name}`, { err: String(err) });
    }
  }

  return registry;
}

async function loadOne(extRoot: string, manifestPath: string): Promise<LoadedExtension> {
  const raw = await readFile(manifestPath, 'utf-8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${manifestPath}: ${(err as Error).message}`);
  }
  const manifest = validateManifest(json, manifestPath);
  // Sanity-check that the extension root exists.
  const s = await stat(extRoot);
  if (!s.isDirectory()) {
    throw new Error(`extension root is not a directory: ${extRoot}`);
  }
  return { path: extRoot, manifest };
}

function validateManifest(json: unknown, source: string): ExtensionManifest {
  if (!json || typeof json !== 'object') {
    throw new Error(`manifest is not an object: ${source}`);
  }
  const m = json as Record<string, unknown>;
  if (typeof m.name !== 'string' || !m.name) {
    throw new Error(`manifest missing "name": ${source}`);
  }
  if (typeof m.version !== 'string' || !m.version) {
    throw new Error(`manifest missing "version": ${source}`);
  }
  if (!Array.isArray(m.hooks)) {
    throw new Error(`manifest "hooks" must be an array: ${source}`);
  }
  return json as ExtensionManifest;
}

function addToRegistry(reg: ExtensionRegistry, loaded: LoadedExtension): void {
  const name = loaded.manifest.name;
  for (const c of loaded.manifest.commands ?? []) {
    reg.commands.push({ ...c, extension: name });
  }
  for (const t of loaded.manifest.tools ?? []) {
    reg.tools.push({ ...t, extension: name, path: path.join(loaded.path, t.module) });
  }
  for (const th of loaded.manifest.themes ?? []) {
    reg.themes.push({ ...th, extension: name, path: path.join(loaded.path, th.file) });
  }
  for (const p of loaded.manifest.prompts ?? []) {
    reg.prompts.push({ ...p, extension: name, path: path.join(loaded.path, p.file) });
  }
}

/** Return slash-commands contributed by extensions. */
export function getExtensionCommands(reg: ExtensionRegistry): ExtensionCommand[] {
  return reg.commands;
}

/** Return custom tool refs contributed by extensions. */
export function getExtensionTools(reg: ExtensionRegistry): ExtensionToolRef[] {
  return reg.tools;
}

/** Return theme contributions. */
export function getExtensionThemes(reg: ExtensionRegistry): ExtensionTheme[] {
  return reg.themes;
}

/** Return prompt snippet contributions. */
export function getExtensionPrompts(reg: ExtensionRegistry): ExtensionPrompt[] {
  return reg.prompts;
}

/**
 * Install an extension by copying (or symlinking) `sourceDir` into the
 * user's extensions root. Returns the installed directory path.
 */
export async function installExtension(sourceDir: string): Promise<string> {
  const src = path.resolve(sourceDir);
  const stat = await import('node:fs/promises').then((m) => m.stat(src));
  if (!stat.isDirectory()) {
    throw new Error(`source is not a directory: ${src}`);
  }
  if (!existsSync(path.join(src, MANIFEST_FILE))) {
    throw new Error(`source is missing ${MANIFEST_FILE}: ${src}`);
  }
  const dst = path.join(getCodexrevPaths().extensionsDir, path.basename(src));
  if (existsSync(dst)) {
    throw new Error(`extension already installed at ${dst}`);
  }
  await import('node:fs/promises').then((m) => m.cp(src, dst, { recursive: true }));
  return dst;
}

/** Remove an installed extension by name. */
export async function uninstallExtension(name: string): Promise<void> {
  const target = path.join(getCodexrevPaths().extensionsDir, name);
  if (!existsSync(target)) {
    throw new Error(`extension not installed: ${name}`);
  }
  await import('node:fs/promises').then((m) => m.rm(target, { recursive: true, force: true }));
}