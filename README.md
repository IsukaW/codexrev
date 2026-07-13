# Codexrev

> A multi-provider, agentic command-line AI assistant for code, research, and shell automation.

[![npm version](https://img.shields.io/npm/v/codexrev.svg)](https://www.npmjs.com/package/codexrev)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

---

## What is Codexrev?

**Codexrev** is an interactive, agentic CLI that brings the power of modern large language
models directly into your terminal. It can read, write, and edit files; run shell commands;
search the web; and orchestrate external tools through the **Model Context Protocol (MCP)**.

Unlike vendor-locked CLIs, Codexrev is **provider-agnostic** out of the box. You choose the
model — Codexrev speaks the same fluent interface to all of them.

## Supported LLM Providers

| Provider         | Adapter                       | Auth                                |
| ---------------- | ----------------------------- | ----------------------------------- |
| **OpenAI**       | `openai` SDK                  | `OPENAI_API_KEY`                    |
| **Anthropic**    | `@anthropic-ai/sdk`            | `ANTHROPIC_API_KEY`                 |
| **Google Gemini**| `@google/genai`               | `GOOGLE_API_KEY` / OAuth            |
| **LiteLLM**      | OpenAI-compatible endpoint    | `LITELLM_API_KEY` + base URL        |

Switch with a single env var: `CODEXREV_PROVIDER=anthropic`.

## Quick Start

```bash
# Install globally
npm install -g codexrev

# Or run directly with npx
npx codexrev

# Inside the CLI
> Write a fizzbuzz function in TypeScript and add tests for it.
```

## Configuration

Codexrev reads configuration from (in increasing priority):

1. Built-in defaults
2. `~/.codexrev/settings.json` (user)
3. `.codexrev/settings.json` (project)
4. Environment variables prefixed with `CODEXREV_`

```jsonc
// ~/.codexrev/settings.json
{
  "provider": "openai",
  "model": "gpt-4o",
  "maxTokens": 8192,
  "sandbox": "auto",
  "telemetry": false,
  "theme": "dark"
}
```

## Features

- 🤖 **Multi-provider** — OpenAI, Anthropic, Google Gemini, LiteLLM with a unified interface
- 🛠️ **Built-in tools** — read_file, write_file, edit, shell, glob, grep, web_fetch, web_search
- 🔌 **MCP support** — plug in any Model Context Protocol server (stdio, SSE, streamable-HTTP)
- 🖥️ **Rich TUI** — React + Ink terminal UI with syntax highlighting, themes, and slash commands
- 🔒 **Sandboxing** — macOS Seatbelt, Docker, or Podman isolation for shell execution
- ⏪ **Checkpointing** — git-backed snapshots of the workspace before risky operations
- 📊 **Telemetry** — OpenTelemetry OTLP/gRPC export with local or GCP targets
- 🧩 **Extensions** — load community plugins via `codexrev-extension.json`
- 📦 **Programmatic API** — embed Codexrev in your own Node.js apps (ESM + CJS)

## Slash Commands

```
/help                Show help
/clear               Clear conversation history
/compress            Compact conversation context
/auth                Switch provider / re-authenticate
/theme <name>        Switch color theme
/tools               List available tools
/mcp                 List connected MCP servers
/checkpoint          Save workspace snapshot
/restore <id>        Restore a checkpoint
/quit                Exit Codexrev
```

## Documentation

- [Architecture](docs/architecture.md)
- [CLI reference](docs/cli/commands.md)
- [Built-in tools](docs/tools/index.md)
- [Programmatic API](docs/api.md)
- [MCP integration](docs/mcp-server.md)
- [Sandboxing](docs/sandbox.md)
- [Checkpointing](docs/checkpointing.md)
- [Telemetry](docs/telemetry.md)

## Development

```bash
git clone https://github.com/codexrev/codexrev
cd codexrev
npm install
npm run dev    # runs the CLI from source via tsx
```

## License

Apache-2.0 — see [LICENSE](LICENSE).

## Branding

Codexrev is an independent, original implementation. It contains **no code** from
the Google Gemini CLI, the easy-llm-cli project, or any other proprietary source.
All trademarks belong to their respective owners.
