# Configuration

Codexrev reads settings from five places, in order of precedence (highest wins):

1. **CLI flags** (transient, this invocation only)
2. **Environment variables** (`CODEXREV_*`)
3. **Project encrypted config** (`.codexrev/config.json` at cwd) — created by `codexrev init`
4. **Project settings** (`.codexrev/settings.json` at or above cwd, optional override)
5. **User config** (`~/.codexrev/settings.json`)

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
  "defaultMode": "ask",
  "maxFixAttempts": 5,
  "verificationMode": "auto",
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
| `CODEXREV_DEFAULT_MODE` | `defaultMode` (`ask` / `plan` / `agent`) |
| `CODEXREV_MAX_FIX_ATTEMPTS` | `maxFixAttempts` (number, default `5`) |
| `CODEXREV_VERIFICATION_MODE` | `verificationMode` (`tests` / `llm` / `auto`) |
| `OPENAI_API_KEY` | provider: `openai` API key |
| `ANTHROPIC_API_KEY` | provider: `anthropic` API key |
| `GOOGLE_API_KEY` | provider: `google` API key |
| `OPENAI_BASE_URL` | provider: `litellm` base URL (default `http://localhost:4000`) |

Anything you put in `~/.codexrev/.env` is also loaded (thanks to `dotenv`).

## Project config

### Encrypted config (`.codexrev/config.json`)

For per-project API keys, run `codexrev init` once in your project root. It writes `./.codexrev/config.json` containing:

```jsonc
{
  "schemaVersion": 1,
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": {
    "iv": "MkHv/p0bwoUTUoVj",        // base64, random per write
    "tag": "xNqXTAWdJfieVHSI4mpnqA==", // GCM auth tag
    "ciphertext": "1sI7Tfy30lNf+Mxw7w==" // AES-256-GCM ciphertext
  },
  "createdAt": "2026-07-13T05:24:51.579Z",
  "updatedAt": "2026-07-13T05:24:51.579Z"
}
```

#### Multi-provider registry

When you use `codexrev models add`, additional providers and models are stored in the `providers` array inside the same `config.json`:

```jsonc
{
  "schemaVersion": 1,
  "provider": "ollama",
  "model": "llama3.1",
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": { /* encrypted */ },
  "providers": [
    {
      "name": "minimax",
      "vendor": "openai",
      "baseUrl": "https://api.minimax.io/v1",
      "models": [
        {
          "id": "MiniMax-M3",
          "name": "MiniMax-M3",
          "toolCalling": true,
          "vision": false,
          "maxInputTokens": 128000,
          "default": true
        }
      ],
      "apiKey": { /* encrypted, per-provider */ }
    }
  ]
}
```

Each provider entry has:

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Unique provider name (e.g. `minimax`, `ollama-local`) |
| `vendor` | `string` | One of `openai`, `anthropic`, `google`, `ollama`, `lmstudio`, `litellm`, `customendpoint` |
| `baseUrl` | `string?` | Provider base URL (required for `customendpoint`) |
| `apiType` | `string?` | API type override: `chat-completions`, `messages`, `generateContent` |
| `models` | `ModelConfig[]` | Registered models |
| `apiKey` | `object?` | Per-provider encrypted API key |

Each model entry has:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Model identifier (e.g. `gpt-4o`, `MiniMax-M3`) |
| `name` | `string` | Display name |
| `url` | `string?` | Per-model URL override |
| `toolCalling` | `boolean` | Supports tool/function calling |
| `vision` | `boolean` | Supports image/vision input |
| `maxInputTokens` | `number?` | Maximum input token limit |
| `maxOutputTokens` | `number?` | Maximum output token limit |
| `default` | `boolean` | Whether this is the active model for this provider |

The corresponding 256-bit DEK is stored in the **OS keychain** under service `codexrev` and account `<username>:<sha256(cwd)[..32]>`. On disk the file is `0600`, the directory is `0700` (POSIX). The plaintext API key is never written to disk and never logged.

If the OS keychain is unavailable on Linux, install `libsecret-1-0` (`sudo apt install libsecret-1-0`). The CLI will refuse to start `init` if the keychain is unreachable — it never silently falls back to plaintext.

If you migrate to a new machine or your DEK is lost, run `codexrev init --reset` to re-seal.

### Legacy project settings (`.codexrev/settings.json`)

Codexrev also still reads `.codexrev/settings.json` starting at cwd and walking up to the filesystem root, for projects that ship MCP servers or a pinned model without committing secrets. This file cannot hold encrypted secrets — use `config.json` for those.

## Sandboxing

- `auto` (default): pick the best backend for your OS.
- `seatbelt`: macOS `sandbox-exec` with a deny-by-default profile.
- `docker`: run each shell command inside `alpine:3.20`.
- `podman`: same as `docker`, but using `podman`.
- `off`: no sandbox.

See [sandbox.md](../sandbox.md) for details and risk tradeoffs.

## Interaction modes

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultMode` | `ask` / `plan` / `agent` | `ask` | Mode selected when the TUI starts. Can be changed at runtime with Tab or `/mode`. |
| `maxFixAttempts` | `number` | `5` | Maximum fix-loop retries in Agent mode before giving up. |
| `verificationMode` | `tests` / `llm` / `auto` | `auto` | How the Resolver verifies changes. `tests` runs the project test suite; `llm` asks the model to evaluate; `auto` tries tests first, falls back to LLM if no test runner is detected. |

See [Architecture](../core/architecture.md) for how the multi-agent pipeline and fix loop work.

## Telemetry

When `telemetry: true` (or `--telemetry` is passed), Codexrev installs an OTLP/gRPC exporter that talks to `http://localhost:4317` by default. Set `CODEXREV_OTEL_ENDPOINT` to point elsewhere.

## Validation

Settings are validated against an `ajv` schema at load time. Invalid keys throw `ConfigError` with a pointer to the offending path.
