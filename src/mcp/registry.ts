/**
 * Codexrev — MCP client registry.
 *
 * Loads MCP server definitions from settings, opens connections, and
 * exposes a unified interface for tool discovery and invocation.
 *
 * The actual transport plumbing (stdio / SSE / streamable-HTTP) is
 * implemented by `@modelcontextprotocol/sdk`; this file is the
 * policy + lifecycle layer.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../utils/logger.js';
import { McpError } from '../utils/errors.js';
import type { ToolDeclaration, ToolParameters } from '../core/types.js';
import type { McpServerEntry, Settings } from '../config/schema.js';

interface ConnectedServer {
  name: string;
  client: Client;
}

export class McpRegistry {
  private readonly servers: ConnectedServer[] = [];
  private closed = false;

  async start(servers: Record<string, McpServerEntry>): Promise<void> {
    for (const [name, entry] of Object.entries(servers)) {
      try {
        const client = new Client(
          { name: 'codexrev', version: '0.1.0' },
          { capabilities: {} },
        );
        const transport = buildTransport(name, entry);
        await client.connect(transport, { timeout: entry.timeoutMs ?? 30_000 });
        this.servers.push({ name, client });
        logger.info('MCP server connected', { name, transport: entry.transport });
      } catch (err) {
        logger.error('MCP server failed to connect', {
          name,
          error: (err as Error).message,
        });
        if (entry.trust) {
          throw new McpError(
            `MCP server "${name}" failed to start: ${(err as Error).message}`,
            true,
          );
        }
      }
    }
  }

  async listToolDeclarations(): Promise<ToolDeclaration[]> {
    const decls: ToolDeclaration[] = [];
    for (const { client, name } of this.servers) {
      try {
        const { tools } = await client.listTools();
        for (const t of tools) {
          decls.push({
            name: prefixName(name, t.name),
            description: t.description ?? '',
            parameters: (t.inputSchema as ToolParameters) ?? emptyParams(),
          });
        }
      } catch (err) {
        logger.warn('MCP listTools failed', { name, error: (err as Error).message });
      }
    }
    return decls;
  }

  async callTool(fullName: string, args: unknown): Promise<{ output: string; isError?: boolean }> {
    const { name: serverName, toolName } = unprefixName(fullName);
    const server = this.servers.find((s) => s.name === serverName);
    if (!server) {
      return { output: `unknown MCP server: ${serverName}`, isError: true };
    }
    try {
      const argsObj = (args ?? {}) as Record<string, unknown>;
      const result = await server.client.callTool({ name: toolName, arguments: argsObj });
      // MCP content parts → single string
      const parts: Array<{ type?: string; text?: unknown }> = Array.isArray(
        (result as { content?: unknown }).content,
      )
        ? ((result as { content: Array<{ type?: string; text?: unknown }> }).content)
        : [];
      const out = parts
        .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
        .join('\n');
      return { output: out, isError: Boolean(result.isError) };
    } catch (err) {
      return { output: (err as Error).message, isError: true };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const { name, client } of this.servers) {
      try {
        await client.close();
        logger.debug('MCP server closed', { name });
      } catch (err) {
        logger.warn('MCP server close failed', { name, error: (err as Error).message });
      }
    }
  }
}

function buildTransport(name: string, entry: McpServerEntry) {
  if (entry.transport === 'stdio') {
    return new StdioClientTransport({
      command: entry.command!,
      args: entry.args ?? [],
      env: { ...process.env, ...(entry.env ?? {}) } as Record<string, string>,
    });
  }
  if (entry.transport === 'sse') {
    return new SSEClientTransport(new URL(entry.url!), {
      // Headers are passed via requestInit only — EventSourceInit in some
      // MCP SDK versions does not accept `headers` directly.
      eventSourceInit: {},
      requestInit: { headers: entry.headers },
    });
  }
  if (entry.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(entry.url!), {
      requestInit: { headers: entry.headers },
    });
  }
  throw new McpError(`MCP server "${name}" has unsupported transport: ${entry.transport}`);
}

function prefixName(server: string, tool: string): string {
  return `${server}__${tool}`;
}

function unprefixName(full: string): { name: string; toolName: string } {
  const idx = full.indexOf('__');
  if (idx < 0) return { name: full, toolName: full };
  return { name: full.slice(0, idx), toolName: full.slice(idx + 2) };
}

function emptyParams(): ToolParameters {
  return { type: 'object', properties: {}, additionalProperties: false };
}

export async function createMcpRegistry(settings: Settings): Promise<McpRegistry> {
  const reg = new McpRegistry();
  await reg.start(settings.mcpServers);
  return reg;
}
