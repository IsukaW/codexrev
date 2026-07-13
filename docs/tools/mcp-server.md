# MCP servers

Model Context Protocol servers expose tools to Codexrev. They are configured under `settings.mcp` and may use any of three transports: `stdio`, `sse`, or `http` (streamable HTTP).

## Configuration

```jsonc
// ~/.codexrev/settings.json
{
  "mcp": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": {
      "transport": "sse",
      "url": "https://example.com/mcp/sse",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

## Tool naming

MCP tools are exposed under `<serverName>__<toolName>` (double underscore separator). For example `filesystem__read_file`.

## Discovery

`createMcpRegistry(settings)` connects to every configured server on startup, calls `listTools`, and prefixes each result. The connection times out after `timeoutMs` per server (default 30 s).

## Through extensions

Extensions may also declare MCP servers in their manifest:

```jsonc
{
  "name": "github-issue-creator",
  "version": "1.0.0",
  "hooks": ["mcp"],
  "mcp": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

See [extensions.md](../extensions.md).
