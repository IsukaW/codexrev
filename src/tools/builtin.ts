/**
 * Codexrev — built-in tool implementations.
 *
 * Exports `builtinTools(settings)` which returns a list of fully
 * implemented `Tool` objects. The model can call any of these.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { htmlToText } from 'html-to-text';
import { ToolError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { Tool, ToolContext } from './registry.js';
import type { Settings } from '../config/schema.js';
import { SandboxManager } from '../sandbox/index.js';
import {
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  ShellTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
  WebSearchTool,
} from './specs.js';
import type { ToolDeclaration } from '../core/types.js';

/** Ask for approval via `ctx.ask` if wired; `true` when there is no gate. */
async function approved(ctx: ToolContext, toolName: string, args: unknown): Promise<boolean> {
  if (!ctx.ask) return true;
  return ctx.ask(toolName, args);
}

export type BuiltinToolName =
  | 'shell'
  | 'read_file'
  | 'write_file'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'web_fetch'
  | 'web_search';

function makeDeclaration(name: string, description: string, parameters: Tool['parameters']): ToolDeclaration {
  return { name, description, parameters };
}

const readFileImpl: Tool = {
  name: FileReadTool.name,
  description: FileReadTool.description,
  parameters: FileReadTool.parameters,
  declaration: makeDeclaration(FileReadTool.name, FileReadTool.description, FileReadTool.parameters),
  async execute(args, ctx) {
    const { file_path, offset, limit } = (args ?? {}) as {
      file_path: string;
      offset?: number;
      limit?: number;
    };
    if (!file_path) throw new ToolError('read_file', 'file_path is required');
    const full = path.isAbsolute(file_path) ? file_path : path.join(ctx.cwd, file_path);
    const raw = await fs.readFile(full, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const start = Math.max(0, offset ?? 0);
    const end = limit ? start + limit : lines.length;
    return { output: lines.slice(start, end).join('\n') };
  },
};

const writeFileImpl: Tool = {
  name: FileWriteTool.name,
  description: FileWriteTool.description,
  parameters: FileWriteTool.parameters,
  declaration: makeDeclaration(FileWriteTool.name, FileWriteTool.description, FileWriteTool.parameters),
  async execute(args, ctx) {
    const { file_path, content } = (args ?? {}) as { file_path: string; content: string };
    if (!file_path) throw new ToolError('write_file', 'file_path is required');
    if (typeof content !== 'string') throw new ToolError('write_file', 'content must be a string');
    if (!(await approved(ctx, 'write_file', { file_path }))) {
      return { output: 'denied by user', isError: true };
    }
    const full = path.isAbsolute(file_path) ? file_path : path.join(ctx.cwd, file_path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
    return { output: `wrote ${content.length} bytes to ${full}` };
  },
};

const editImpl: Tool = {
  name: FileEditTool.name,
  description: FileEditTool.description,
  parameters: FileEditTool.parameters,
  declaration: makeDeclaration(FileEditTool.name, FileEditTool.description, FileEditTool.parameters),
  async execute(args, ctx) {
    const { file_path, old_string, new_string, replace_all } = (args ?? {}) as {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };
    if (!file_path) throw new ToolError('edit', 'file_path is required');
    if (typeof old_string !== 'string' || typeof new_string !== 'string') {
      throw new ToolError('edit', 'old_string and new_string are required');
    }
    if (!(await approved(ctx, 'edit', { file_path }))) {
      return { output: 'denied by user', isError: true };
    }
    const full = path.isAbsolute(file_path) ? file_path : path.join(ctx.cwd, file_path);
    const orig = await fs.readFile(full, 'utf-8');
    if (!orig.includes(old_string)) {
      throw new ToolError('edit', `old_string not found in ${full}`);
    }
    const updated = replace_all
      ? orig.split(old_string).join(new_string)
      : orig.replace(old_string, new_string);
    await fs.writeFile(full, updated, 'utf-8');
    return { output: `edited ${full}` };
  },
};

/**
 * Build the shell tool bound to a sandbox backend. Every command runs
 * through the configured sandbox (`SandboxManager`); the result metadata
 * (`sandbox`, `durationMs`, `exitCode`) is surfaced to the TUI so it can
 * render live execution cards.
 */
function makeShellTool(sandbox: SandboxManager): Tool {
  return {
    name: ShellTool.name,
    description: ShellTool.description,
    parameters: ShellTool.parameters,
    declaration: makeDeclaration(ShellTool.name, ShellTool.description, ShellTool.parameters),
    async execute(args, ctx) {
      const { command, timeout } = (args ?? {}) as { command: string; timeout?: number };
      if (!command) throw new ToolError('shell', 'command is required');
      if (!(await approved(ctx, 'shell', { command }))) {
        return { output: 'denied by user', isError: true };
      }
      logger.debug('executing shell command', { command, cwd: ctx.cwd });
      const isWin = process.platform === 'win32';
      const argv = isWin ? ['cmd.exe', '/c', command] : ['/bin/sh', '-c', command];
      try {
        const r = await sandbox.exec(argv, { cwd: ctx.cwd, timeoutMs: timeout ?? 30_000 });
        const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
        return {
          output: output || `(no output — exit ${r.exitCode})`,
          isError: r.exitCode !== 0,
          metadata: {
            sandbox: r.sandboxedBy,
            durationMs: r.durationMs,
            exitCode: r.exitCode,
            command,
          },
        };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const out = [e.stdout, e.stderr].filter(Boolean).join('\n');
        return {
          output: out || (e.message ?? 'shell command failed'),
          isError: true,
          metadata: { sandbox: sandbox.getMode(), command, error: e.message },
        };
      }
    },
  };
}

const globImpl: Tool = {
  name: GlobTool.name,
  description: GlobTool.description,
  parameters: GlobTool.parameters,
  declaration: makeDeclaration(GlobTool.name, GlobTool.description, GlobTool.parameters),
  async execute(args, ctx) {
    const { pattern, cwd } = (args ?? {}) as { pattern: string; cwd?: string };
    if (!pattern) throw new ToolError('glob', 'pattern is required');
    const root = cwd ? (path.isAbsolute(cwd) ? cwd : path.join(ctx.cwd, cwd)) : ctx.cwd;
    const matches = await glob(pattern, { cwd: root, absolute: true, nodir: true });
    return { output: matches.join('\n') };
  },
};

const grepImpl: Tool = {
  name: GrepTool.name,
  description: GrepTool.description,
  parameters: GrepTool.parameters,
  declaration: makeDeclaration(GrepTool.name, GrepTool.description, GrepTool.parameters),
  async execute(args, ctx) {
    const { pattern, path: searchPath, include, case_sensitive } = (args ?? {}) as {
      pattern: string;
      path: string;
      include?: string;
      case_sensitive?: boolean;
    };
    if (!pattern) throw new ToolError('grep', 'pattern is required');
    if (!searchPath) throw new ToolError('grep', 'path is required');
    const root = path.isAbsolute(searchPath) ? searchPath : path.join(ctx.cwd, searchPath);
    const files = await glob(include ?? '**/*', { cwd: root, absolute: true, nodir: true });
    const re = new RegExp(pattern, case_sensitive === false ? 'i' : '');
    const out: string[] = [];
    for (const f of files) {
      try {
        const text = await fs.readFile(f, 'utf-8');
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${f}:${i + 1}:${lines[i]}`);
          }
        }
      } catch {
        // skip files we can't read (binary, permission)
      }
    }
    return { output: out.slice(0, 500).join('\n') || '(no matches)' };
  },
};

const webFetchImpl: Tool = {
  name: WebFetchTool.name,
  description: WebFetchTool.description,
  parameters: WebFetchTool.parameters,
  declaration: makeDeclaration(WebFetchTool.name, WebFetchTool.description, WebFetchTool.parameters),
  async execute(args) {
    const { url } = (args ?? {}) as { url: string };
    if (!url) throw new ToolError('web_fetch', 'url is required');
    if (!/^https?:\/\//i.test(url)) throw new ToolError('web_fetch', 'url must be http(s)');
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      return { output: `HTTP ${res.status} ${res.statusText}`, isError: true };
    }
    const html = await res.text();
    const text = htmlToText(html, { wordwrap: 120, selectors: [{ selector: 'a', format: 'skip' }] });
    return { output: text.slice(0, 20_000) };
  },
};

const webSearchImpl: Tool = {
  name: WebSearchTool.name,
  description: WebSearchTool.description,
  parameters: WebSearchTool.parameters,
  declaration: makeDeclaration(WebSearchTool.name, WebSearchTool.description, WebSearchTool.parameters),
  async execute(args) {
    const { query } = (args ?? {}) as { query: string; num_results?: number };
    if (!query) throw new ToolError('web_search', 'query is required');
    // Use DuckDuckGo HTML endpoint as a free, no-key fallback.
    const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(u, { headers: { 'User-Agent': 'codexrev/0.1' } });
    if (!res.ok) return { output: `HTTP ${res.status}`, isError: true };
    const html = await res.text();
    const text = htmlToText(html, { wordwrap: 120 });
    return { output: text.slice(0, 8_000) };
  },
};

export interface BuiltinToolDeps {
  /** Shared sandbox manager so live Control-Panel mode changes take effect. */
  sandbox?: SandboxManager;
}

export function builtinTools(settings?: Settings, deps: BuiltinToolDeps = {}): Tool[] {
  const sandbox = deps.sandbox ?? new SandboxManager(settings?.sandbox ?? 'auto');
  return [
    makeShellTool(sandbox),
    readFileImpl,
    writeFileImpl,
    editImpl,
    globImpl,
    grepImpl,
    webFetchImpl,
    webSearchImpl,
  ];
}
