# Codexrev Documentation

**Codexrev** is a multi-provider, agentic command-line AI assistant built from scratch in TypeScript on Node.js 20+. It is licensed Apache-2.0.

## Highlights

- **Multiple LLM providers**: OpenAI, Anthropic, Google Gemini, and any OpenAI-compatible endpoint (LiteLLM, vLLM, etc.).
- **Agent loop with tools**: A single user prompt may trigger dozens of model turns, tool calls, and re-prompts until the model emits `stop`.
- **Built-in tools**: `shell`, `read_file`, `write_file`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`.
- **MCP integration**: Talk to Model Context Protocol servers over stdio, SSE, or streamable-HTTP transports.
- **Plugin / extension system**: Drop a folder under `~/.codexrev/extensions/<name>/` containing a `codexrev-extension.json` manifest and Codexrev picks it up.
- **Sandboxed shell execution**: macOS Seatbelt, Docker containers, Podman containers, or passthrough.
- **Point-in-time checkpoints**: Snapshot files the agent has touched and rewind later.
- **Interactive TUI**: React + Ink terminal UI with streaming responses and slash commands.
- **Non-interactive mode**: `codexrev --print "fix the bug" --output-format stream-json` for scripting and CI.
- **Programmatic API**: `import { createAgent, runAgent, buildProvider, ... } from 'codexrev'`.

## Quick start

```bash
# Install (after running `npm run build` in this repo)
npm install -g .

# Set at least one provider's API key
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-ant-...
# or
export GOOGLE_API_KEY=...

# Interactive
codexrev

# Non-interactive
codexrev --print "summarize the README" --model gpt-4o-mini
```

## Documentation map

### CLI
- [Commands](cli/commands.md) — every subcommand and flag
- [Configuration](cli/configuration.md) — settings, env vars, layering
- [Authentication](cli/authentication.md) — provider keys and OAuth
- [Themes](cli/themes.md) — color schemes
- [Tutorials](cli/tutorials.md) — walkthroughs

### Core
- [Architecture](core/architecture.md) — providers, agent loop, tools, MCP
- [Tools API](core/tools-api.md) — implementing custom tools
- [Memory port](core/memport.md) — CODEXREV.md scratchpad

### Tools
- [Index](tools/index.md) — built-in tools reference
- [shell](tools/shell.md)
- [file_system](tools/file-system.md)
- [web_fetch](tools/web-fetch.md)
- [web_search](tools/web-search.md)

### Cross-cutting
- [Sandbox](sandbox.md)
- [Checkpointing](checkpointing.md)
- [Telemetry](telemetry.md)
- [Extensions](extensions.md)
- [MCP server](tools/mcp-server.md)
- [Programmatic API](programmatic-api.md)
- [Deployment](deployment.md)
- [npm](npm.md)
- [Quota & pricing](quota-and-pricing.md)
- [Troubleshooting](troubleshooting.md)
- [Uninstall](Uninstall.md)
