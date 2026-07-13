# Extensions

Codexrev extensions are folders under `~/.codexrev/extensions/<name>/` containing a `codexrev-extension.json` manifest. At startup Codexrev scans that directory and loads every well-formed manifest.

## Manifest schema

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Optional one-liner.",
  "author": "Your Name <you@example.com>",
  "hooks": ["commands", "tools", "themes", "prompts", "mcp", "pre-prompt", "post-response"],
  "commands": [
    { "name": "hello", "description": "Say hi to the agent" }
  ],
  "tools": [
    { "name": "my_tool", "description": "...", "parameters": { /* JSON Schema */ } }
  ],
  "themes": [
    { "name": "pastel", "colors": { "primary": "#cba6f7" } }
  ],
  "prompts": [
    { "name": "summarise", "template": "Summarise the following: {{input}}" }
  ],
  "mcp": {
    "serverName": {
      "transport": "stdio",
      "command": "node",
      "args": ["./server.js"]
    }
  }
}
```

## Hook types

| Hook | Effect |
| --- | --- |
| `commands` | Adds slash commands to the TUI. |
| `tools` | Registers additional tools. |
| `themes` | Adds color schemes. |
| `prompts` | Adds reusable prompt templates. |
| `mcp` | Configures MCP servers at startup. |
| `pre-prompt` | Injects text before the system prompt. |
| `post-response` | Runs after each model turn. |

## Installing

```bash
git clone https://example.com/my-plugin
codexrev extensions install ./my-plugin
```

Or just copy the directory:

```bash
mkdir -p ~/.codexrev/extensions
cp -r ./my-plugin ~/.codexrev/extensions/
```

## Removing

```bash
codexrev extensions uninstall my-plugin
```
