# CLI Commands

This page documents every command and flag exposed by `codexrev`.

## Synopsis

```text
codexrev [prompt]

codexrev init                         # Initialize this project with an encrypted config
codexrev extensions list              # List installed extensions
codexrev extensions install <dir>     # Install from a local directory
codexrev extensions uninstall <name>  # Remove an installed extension
```

If `prompt` is omitted and no subcommand is given, Codexrev launches the interactive TUI.

## Options

| Flag | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `--provider` |  | `string` | settings | One of `openai`, `anthropic`, `google`, `litellm`. |
| `--model` |  | `string` | settings | Provider-specific model name (e.g. `gpt-4o`, `claude-3-5-sonnet-20240620`, `gemini-1.5-pro`). |
| `--sandbox` |  | `auto`/`seatbelt`/`docker`/`podman`/`off` | `auto` | Shell execution isolation mode. |
| `--theme` |  | `dark`/`light`/`solarized`/`monokai`/`nord` | `dark` | Color scheme for the TUI. |
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
