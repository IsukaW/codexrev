/**
 * Codexrev — per-project `.codexrev/config.json` I/O.
 *
 * Reads, writes, and removes the encrypted project configuration. The
 * file lives at `<projectRoot>/.codexrev/config.json` and is created
 * with mode 0700 (directory) and 0600 (file) on POSIX. On Windows, the
 * OS default ACLs apply — the keychain is the real protection layer.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';
import { PROJECT_CONFIG_SCHEMA_VERSION, type ProjectConfig } from './projectSchema.js';

export const PROJECT_CONFIG_DIRNAME = '.codexrev';
export const PROJECT_CONFIG_FILENAME = 'config.json';

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_CONFIG_DIRNAME, PROJECT_CONFIG_FILENAME);
}

export function projectConfigDir(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_CONFIG_DIRNAME);
}

export async function ensureProjectConfigDir(projectRoot: string): Promise<string> {
  const dir = projectConfigDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      // best-effort
    }
  }
  return dir;
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig | null> {
  const file = projectConfigPath(projectRoot);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as ProjectConfig;
    if (parsed.schemaVersion !== PROJECT_CONFIG_SCHEMA_VERSION) {
      throw new ConfigError(
        `unsupported project config schemaVersion: ${parsed.schemaVersion} (expected ${PROJECT_CONFIG_SCHEMA_VERSION}). Re-run \`codexrev init --reset\`.`,
      );
    }
    if (!parsed.provider || !parsed.model || !parsed.apiKey) {
      throw new ConfigError(`project config at ${file} is missing required fields.`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`failed to read ${file}: ${(err as Error).message}`);
  }
}

export async function saveProjectConfig(projectRoot: string, cfg: ProjectConfig): Promise<void> {
  await ensureProjectConfigDir(projectRoot);
  const file = projectConfigPath(projectRoot);
  const tmp = path.join(projectConfigDir(projectRoot), `.${PROJECT_CONFIG_FILENAME}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(tmp, 0o600);
    } catch {
      // best-effort
    }
  }
  await fs.rename(tmp, file);
}

export async function deleteProjectConfig(projectRoot: string): Promise<boolean> {
  const file = projectConfigPath(projectRoot);
  try {
    await fs.unlink(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}