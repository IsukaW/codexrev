# Authentication

Each provider requires its own credential. Codexrev reads them from environment variables and looks up the appropriate key based on the active `provider`.

## Provider keys

| Provider | Variable(s) |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| `litellm` | `OPENAI_API_KEY` (LiteLLM uses Bearer auth when configured), and `OPENAI_BASE_URL` for the upstream URL |

If the required variable is missing, the providers throw `AuthError` on the first request. The error message points at the missing variable.

## OAuth (future)

OAuth flows are not implemented yet. Today, all providers use long-lived API keys. A future Codexrev release may add device-code or PKCE for providers that support it.

## Storing keys

For local development we recommend:

- A `.env.local` at `~/.codexrev/.env` for personally-used keys.
- A per-project `.codexrev/.env` for repo-shared MCP keys (not in version control).

For shared systems, prefer a real secret manager (1Password CLI, HashiCorp Vault, macOS Keychain via `security`).

## Yanking a key

If you suspect a key has leaked, rotate it at the provider immediately:

- OpenAI: <https://platform.openai.com/api-keys>
- Anthropic: <https://console.anthropic.com/settings/keys>
- Google: <https://aistudio.google.com/app/apikey>

Codexrev does not store keys long-term; once you rotate, just unset the old variable.
