/**
 * Codexrev — filesystem path helpers.
 *
 * Resolves ~/.codexrev/ paths in a cross-platform way, without depending
 * on a third-party package.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export const HOME_DIR = os.homedir();

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return HOME_DIR;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(HOME_DIR, p.slice(2));
  }
  return p;
}

export interface CodexrevPaths {
  readonly root: string;
  readonly settingsFile: string;
  readonly historyFile: string;
  readonly memoryFile: string;
  readonly extensionsDir: string;
  readonly logsDir: string;
  readonly checkpointsDir: string;
  readonly mcpDir: string;
}

export function getCodexrevPaths(): CodexrevPaths {
  const root = expandHome(process.env.CODEXREV_HOME ?? '~/.codexrev');
  return {
    root,
    settingsFile: path.join(root, 'settings.json'),
    historyFile: path.join(root, 'history.json'),
    memoryFile: path.join(root, 'CODEXREV.md'),
    extensionsDir: path.join(root, 'extensions'),
    logsDir: path.join(root, 'logs'),
    checkpointsDir: path.join(root, 'checkpoints'),
    mcpDir: path.join(root, 'mcp'),
  };
}

export async function ensureCodexrevHome(): Promise<CodexrevPaths> {
  const paths = getCodexrevPaths();
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.extensionsDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.checkpointsDir, { recursive: true });
  await fs.mkdir(paths.mcpDir, { recursive: true });
  return paths;
}

export function projectConfigDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.codexrev');
}

export async function findProjectConfig(cwd: string = process.cwd()): Promise<string | null> {
  const candidate = path.join(projectConfigDir(cwd), 'settings.json');
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}
