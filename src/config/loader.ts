/**
 * Codexrev — settings loader.
 *
 * Layered resolution (lowest → highest priority):
 *   1. DEFAULT_SETTINGS
 *   2. ~/.codexrev/settings.json  (user)
 *   3. .codexrev/settings.json    (project, walking up from cwd)
 *   4. encrypted project config (.codexrev/config.json)
 *   5. environment variables
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import stripJsonComments from 'strip-json-comments';
import { DEFAULT_SETTINGS, type Settings, type McpServerEntry } from './schema.js';
import { findProjectConfig, getCodexrevPaths } from '../utils/paths.js';
import { ENV } from '../utils/env.js';
import { ConfigError } from '../utils/errors.js';
import type { ProviderId } from '../core/types.js';
import { decrypt } from '../security/secrets.js';
import { getDek, isAvailable as keychainAvailable } from '../security/keychain.js';
import { loadProjectConfig, projectConfigPath } from './projectConfig.js';
import { PROVIDER_IDS } from '../providers/registry.js';

const VALID_PROVIDERS: ReadonlyArray<ProviderId> = PROVIDER_IDS;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    const baseVal = (base as Record<string, unknown>)[k];
    if (isPlainObject(baseVal) && isPlainObject(v)) {
      out[k] = deepMerge(baseVal, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

async function readJsonFile(p: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(stripJsonComments(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new ConfigError(`failed to read ${p}: ${(err as Error).message}`);
  }
}

function applyEnvOverrides(s: Settings): Settings {
  const next: Settings = { ...s };
  if (process.env.CODEXREV_PROVIDER) {
    const p = process.env.CODEXREV_PROVIDER.toLowerCase() as ProviderId;
    if (!VALID_PROVIDERS.includes(p)) {
      throw new ConfigError(
        `invalid CODEXREV_PROVIDER: ${process.env.CODEXREV_PROVIDER} (expected one of ${VALID_PROVIDERS.join(', ')})`,
      );
    }
    next.provider = p;
  }
  if (process.env.CODEXREV_MODEL) next.model = process.env.CODEXREV_MODEL;
  if (process.env.CODEXREV_MAX_TOKENS) {
    next.maxOutputTokens = parseInt(process.env.CODEXREV_MAX_TOKENS, 10);
  }
  if (process.env.CODEXREV_TEMPERATURE) {
    next.temperature = parseFloat(process.env.CODEXREV_TEMPERATURE);
  }
  if (process.env.CODEXREV_THEME) {
    next.theme = process.env.CODEXREV_THEME as Settings['theme'];
  }
  if (process.env.CODEXREV_SANDBOX) {
    next.sandbox = process.env.CODEXREV_SANDBOX as Settings['sandbox'];
  }
  if (process.env.CODEXREV_TELEMETRY) {
    next.telemetry = ENV.telemetry();
  }
  if (process.env.CODEXREV_CHECKPOINTING) {
    next.checkpointing = process.env.CODEXREV_CHECKPOINTING === 'true';
  }
  return next;
}

function ensureProviderKeys(s: Settings): Settings {
  const out: Settings = { ...s, providers: { ...s.providers } };
  for (const id of VALID_PROVIDERS) {
    if (!out.providers[id]) {
      out.providers[id] = { provider: id, model: s.model };
    }
  }
  return out;
}

function validateMcpServers(servers: Record<string, McpServerEntry>): void {
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry.transport) {
      throw new ConfigError(`mcp server "${name}" is missing "transport"`);
    }
    if (entry.transport === 'stdio' && !entry.command) {
      throw new ConfigError(`mcp server "${name}" (stdio) requires "command"`);
    }
    if ((entry.transport === 'sse' || entry.transport === 'http') && !entry.url) {
      throw new ConfigError(`mcp server "${name}" (${entry.transport}) requires "url"`);
    }
  }
}

export async function loadSettings(cwd: string = process.cwd()): Promise<Settings> {
  let merged: Settings = DEFAULT_SETTINGS;

  // 1) user-level settings
  const userPath = getCodexrevPaths().settingsFile;
  const userRaw = await readJsonFile(userPath);
  if (userRaw && isPlainObject(userRaw)) {
    merged = deepMerge(merged, userRaw as Partial<Settings>);
  }

  // 2) project-level settings (legacy .codexrev/settings.json)
  const projectPath = await findProjectConfig(cwd);
  if (projectPath) {
    const projRaw = await readJsonFile(projectPath);
    if (projRaw && isPlainObject(projRaw)) {
      merged = deepMerge(merged, projRaw as Partial<Settings>);
    }
  }

  // 2b) project-level encrypted config (.codexrev/config.json) — overrides 2a
  merged = await mergeProjectConfig(merged, cwd);

  // 3) env overrides
  merged = applyEnvOverrides(merged);
  merged = ensureProviderKeys(merged);

  // 4) sanity-check
  if (!VALID_PROVIDERS.includes(merged.provider)) {
    throw new ConfigError(
      `invalid provider "${merged.provider}" (expected one of ${VALID_PROVIDERS.join(', ')})`,
    );
  }
  validateMcpServers(merged.mcpServers);

  return merged;
}

/**
 * Merge in the project's encrypted `config.json`, if present. The API
 * key is decrypted using the project-scoped DEK from the OS keychain.
 */
async function mergeProjectConfig(merged: Settings, cwd: string): Promise<Settings> {
  const projectCfg = await loadProjectConfig(cwd);
  if (!projectCfg) return merged;

  if (!keychainAvailable()) {
    throw new ConfigError(
      `project config found at ${projectConfigPath(cwd)} but OS keychain is unavailable. ` +
        `Install libsecret-1-0 on Linux, then re-run \`codexrev init --reset\`.`,
    );
  }

  const dek = await getDek(cwd);
  if (!dek) {
    throw new ConfigError(
      `project config found at ${projectConfigPath(cwd)} but no matching DEK in OS keychain. ` +
        `Re-run \`codexrev init --reset\` for this project to re-seal the API key.`,
    );
  }

  let apiKey: string;
  try {
    apiKey = decrypt(projectCfg.apiKey, dek);
  } catch (err) {
    throw new ConfigError(
      `failed to decrypt API key in ${projectConfigPath(cwd)}: ${(err as Error).message}. ` +
        `Run \`codexrev init --reset\` to re-seal.`,
    );
  }

  const providers = { ...merged.providers };
  providers[projectCfg.provider] = {
    ...(providers[projectCfg.provider] ?? { provider: projectCfg.provider, model: projectCfg.model }),
    provider: projectCfg.provider,
    model: projectCfg.model,
    apiKey,
    ...(projectCfg.baseUrl !== undefined ? { baseUrl: projectCfg.baseUrl } : {}),
    ...(projectCfg.maxOutputTokens !== undefined ? { maxOutputTokens: projectCfg.maxOutputTokens } : {}),
    ...(projectCfg.temperature !== undefined ? { temperature: projectCfg.temperature } : {}),
    ...(projectCfg.topP !== undefined ? { topP: projectCfg.topP } : {}),
  };

  return {
    ...merged,
    provider: projectCfg.provider,
    model: projectCfg.model,
    providers,
  };
}

/** Save the user's settings file. Creates parent directories as needed. */
export async function saveSettings(s: Settings): Promise<void> {
  const file = getCodexrevPaths().settingsFile;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(s, null, 2), 'utf-8');
}
