# Configuration

Codexrev reads settings from four places, in order of precedence (highest wins):

1. **CLI flags** (transient, this invocation only)
2. **Environment variables** (`CODEXREV_*`)
3. **Project config** (`.codexrev/settings.json` at or above cwd)
4. **User config** (`~/.codexrev/settings.json`)

The shipped defaults fill in any gaps.

## Settings file

`~/.codexrev/settings.json`:

```jsonc
{
  "provider": "openai",
  "model": "gpt-4o",
  "sandbox": "auto",
  "theme": "dark",
  "telemetry": false,
  "approvalMode": "on-request",
  "mcp": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

## Environment variables

| Variable | Maps to |
| --- | --- |
| `CODEXREV_PROVIDER` | `provider` |
| `CODEXREV_MODEL` | `model` |
| `CODEXREV_SANDBOX` | `sandbox` |
| `CODEXREV_THEME` | `theme` |
| `CODEXREV_TELEMETRY` | `telemetry` |
| `CODEXREV_APPROVAL_MODE` | `approvalMode` |
| `OPENAI_API_KEY` | provider: `openai` API key |
| `ANTHROPIC_API_KEY` | provider: `anthropic` API key |
| `GOOGLE_API_KEY` | provider: `google` API key |
| `OPENAI_BASE_URL` | provider: `litellm` base URL (default `http://localhost:4000`) |

Anything you put in `~/.codexrev/.env` is also loaded (thanks to `dotenv`).

## Project config

Codexrev looks for `.codexrev/settings.json` starting at cwd and walking up to the filesystem root. This lets a repo ship its own MCP servers and pinned model without polluting your global settings.

## Sandboxing

- `auto` (default): pick the best backend for your OS.
- `seatbelt`: macOS `sandbox-exec` with a deny-by-default profile.
- `docker`: run each shell command inside `alpine:3.20`.
- `podman`: same as `docker`, but using `podman`.
- `off`: no sandbox.

See [sandbox.md](../sandbox.md) for details and risk tradeoffs.

## Telemetry

When `telemetry: true` (or `--telemetry` is passed), Codexrev installs an OTLP/gRPC exporter that talks to `http://localhost:4317` by default. Set `CODEXREV_OTEL_ENDPOINT` to point elsewhere.

## Validation

Settings are validated against an `ajv` schema at load time. Invalid keys throw `ConfigError` with a pointer to the offending path.
