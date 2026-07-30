# CLI Commands

This page documents every command and flag exposed by `codexrev`.

## Synopsis

```text
codexrev [prompt]

codexrev init                         # Initialize this project with an encrypted config
codexrev models list                  # List all providers and models
codexrev models add                   # Interactive wizard to add provider + model
codexrev extensions list              # List installed extensions
codexrev extensions install <dir>     # Install from a local directory
codexrev extensions uninstall <name>  # Remove an installed extension
```

If `prompt` is omitted and no subcommand is given, Codexrev launches the interactive TUI.

## Options

| Flag | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `--provider` |  | `string` | settings | One of `openai`, `anthropic`, `google`, `ollama`, `lmstudio`, `litellm`. |
| `--model` |  | `string` | settings | Provider-specific model name (e.g. `gpt-4o`, `claude-3-5-sonnet-20240620`, `gemini-1.5-pro`). |
| `--sandbox` |  | `auto`/`seatbelt`/`docker`/`podman`/`off` | `auto` | Shell execution isolation mode. |
| `--theme` |  | `dark`/`light`/`solarized`/`monokai`/`nord` | `dark` | Color scheme for the TUI. |
| `--mode` |  | `ask`/`plan`/`agent` | `ask` | Initial interaction mode. |
| `--telemetry` |  | `boolean` | `false` | Enable OpenTelemetry export (requires a collector). |
| `--no-update` |  | `boolean` | `false` | Skip the background update check. |
| `--print` | `-p` | `string` |  | Run non-interactively with this prompt and print the result. |
| `--output-format` |  | `text`/`json`/`stream-json` | `text` | Output format for non-interactive mode. |
| `--approval-mode` |  | `always`/`on-request`/`never` | `on-request` | How to handle tool execution approval. |
| `--debug` |  | `boolean` | `false` | Enable verbose debug logging. |
| `--help` | `-h` | `boolean` |  | Show this help text. |
| `--version` |  | `boolean` |  | Print the version and exit. |

## Subcommands

### `codexrev init`

Initialize the current project with an encrypted `.codexrev/config.json`. This is required once per project before `codexrev` can use a per-project API key.

```bash
codexrev init                          # interactive TUI wizard
codexrev init --reset                  # replace an existing config
codexrev init --non-interactive \
  --provider openai \
  --model gpt-4o-mini \
  --api-key "$OPENAI_API_KEY"          # CI / scripting
```

| Flag | Description |
| --- | --- |
| `--provider` | `openai` \| `anthropic` \| `google` \| `litellm` |
| `--model` | Model name (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`) |
| `--api-key` | Provider API key (passed only in non-interactive mode) |
| `--base-url` | Provider base URL (optional, e.g. for litellm) |
| `--reset` | Delete the existing config + DEK before writing the new one |
| `--non-interactive` | Skip the TUI wizard (requires `--provider`, `--model`, `--api-key`) |

The API key is encrypted with **AES-256-GCM**. The 256-bit DEK is stored in the OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret) under service `codexrev`. If the OS keychain is unavailable, `init` refuses to run rather than falling back to plaintext.

Recovery: if the DEK is lost (e.g. a different OS user or a fresh machine), run `codexrev init --reset` in the project directory.

### `codexrev extensions`

Manage user-installed extensions. Extensions are folders under `~/.codexrev/extensions/` containing a `codexrev-extension.json` manifest. See [Extensions](../extensions.md) for the manifest schema.

#### `extensions list`

List every installed extension with its name, version, description, and registered hooks.

```bash
codexrev extensions list
```

When no extensions are installed, prints `No extensions installed.` and the extensions root.

#### `extensions install <dir>`

Copy a directory into `~/.codexrev/extensions/`. The directory must contain a `codexrev-extension.json` manifest.

```bash
codexrev extensions install ./my-plugin
```

#### `extensions uninstall <name>`

Remove an installed extension by its manifest name.

```bash
codexrev extensions uninstall my-plugin
```

### `codexrev models`

Manage the multi-provider model registry. Codexrev supports registering multiple providers (OpenAI, Anthropic, Google, Ollama, LM Studio, LiteLLM, custom endpoints) each with multiple models, and switching the active model at any time.

#### `models add` (interactive wizard)

Launch the step-by-step interactive wizard. This is the recommended way to add providers and models.

```bash
codexrev models add
```

The wizard walks through:

1. **Mode** — add a new provider (+ first model) or add a model to an existing provider
2. **Provider name** — e.g. `minimax`, `deepseek-team`, `my-ollama`
3. **Vendor** — `openai`, `anthropic`, `google`, `ollama`, `lmstudio`, `litellm`, `customendpoint`
4. **Base URL** — required for `customendpoint`, optional for others
5. **API key** — masked input with Tab to show/hide (skipped for local providers)
6. **Model ID** — e.g. `gpt-4o`, `claude-sonnet-4-20250514`, `MiniMax-M3`
7. **Display name** — defaults to the model ID
8. **Tool calling** — y/N
9. **Vision** — y/N
10. **Max input/output tokens** — optional numeric limits
11. **Model URL** — optional per-model URL override
12. **Review & confirm** — shows a summary, Enter to save

After saving, the wizard offers to add another model to the same provider.

Requires a TTY. In non-interactive environments (CI), use the CRUD functions directly via the [Programmatic API](../programmatic-api.md).

#### `models list`

List all registered providers and their models.

```bash
codexrev models list
```

Output shows each provider with its vendor, base URL, API key status (🔑), and all registered models with capabilities (`[tools]`, `[vision]`), token limits, and the active model marked with ★.

#### `models use <id>`

Set a model as the active default for its provider.

```bash
codexrev models use gpt-4o --provider openai-prod
```

| Flag | Required | Description |
| --- | --- | --- |
| `--provider` | yes | Provider name the model belongs to |

#### `models remove provider <name>`

Remove an entire provider and all its models.

```bash
codexrev models remove provider openai-prod
```

#### `models remove model <id>`

Remove a single model from a provider. If the removed model was the active default, the first remaining model becomes active.

```bash
codexrev models remove model gpt-4o --provider openai-prod
```

| Flag | Required | Description |
| --- | --- | --- |
| `--provider` | yes | Provider name the model belongs to |

## TUI slash commands

When running in interactive mode, the following slash commands are available:

| Command | Description |
| --- | --- |
| `/help` | Show all commands and key bindings. |
| `/mode [name]` | Show current mode, or switch to `ask`, `plan`, or `agent`. |
| `/tools` | List all registered tools. |
| `/clear` | Clear the conversation. |
| `/theme <name>` | Show or set the color theme. |
| `/quit` | Exit the TUI. |

## TUI key bindings

| Key | Context | Action |
| --- | --- | --- |
| **Tab** | Normal | Cycle mode: Ask → Plan → Agent → Ask |
| **Ctrl+C** | Running | Abort current operation |
| **Ctrl+C** | Idle | Exit Codexrev |
| **Tab** | Clarification (with suggestions) | Toggle between suggestion list and free-form text input |

## Modes

Codexrev has three interaction modes that control how the agent processes your input. The current mode is shown as a color-coded badge next to the input prompt.

| Mode | Badge | Description |
| --- | --- | --- |
| **Ask** | 🔵 `[Ask]` | Read-only Q&A — no file edits, no shell commands. Uses only `read_file`, `glob`, `grep`, `web_fetch`, `web_search`. |
| **Plan** | 🟡 `[Plan]` | Generates a step-by-step plan — no execution. Read-only tools only. |
| **Agent** | 🟢 `[Agent]` | Full pipeline: Committee (analysis) → Breaker-Builder (implementation) → Resolver (verification). Supports all tools and automatic fix-loop retries. |

Switch modes by pressing **Tab**, or type `/mode agent` to switch explicitly.

When you switch from Plan to Agent mode, the Agent automatically receives the full conversation history (including any plans generated in Plan mode) as context.

## Output formats (non-interactive)

### `text` (default)

Plain text final response, suitable for shell scripting.

### `json`

A single JSON object representing the final `AgentResult`:

```json
{
  "finalText": "…",
  "messages": [ … ],
  "usage": { "inputTokens": 1234, "outputTokens": 56, "totalTokens": 1290 },
  "turns": 3,
  "finishReason": "stop"
}
```

### `stream-json`

A newline-delimited JSON stream of `AgentEvent`s, then a final `AgentResult` line. Useful for piping into downstream tools.

## Exit codes

- `0`: success
- `1`: unhandled agent or system error
- `2`: invalid CLI invocation (missing args, bad choice, etc.)
- `130`: aborted by the user (Ctrl+C)
