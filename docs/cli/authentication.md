# Authentication

Each provider requires its own credential. Codexrev supports two storage methods:

1. **Environment variables** — read at runtime, never persisted by Codexrev
2. **Per-provider encrypted storage** — set via `codexrev models add`, stored in `.codexrev/config.json`

## Provider keys (environment variables)

| Provider | Variable(s) |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| `litellm` | `OPENAI_API_KEY` (LiteLLM uses Bearer auth when configured), and `OPENAI_BASE_URL` for the upstream URL |
| `ollama` | *(none — runs locally)* |
| `lmstudio` | *(none — runs locally)* |
| `customendpoint` | varies by endpoint |

If the required variable is missing, the providers throw `AuthError` on the first request. The error message points at the missing variable.

## Per-provider encrypted keys

When you add a provider via `codexrev models add`, the wizard prompts for an API key. The key is encrypted with **AES-256-GCM** and stored per-provider in `.codexrev/config.json`. Each provider in the `providers` array has its own `apiKey` field with a unique IV and auth tag.

The 256-bit DEK is stored in the OS keychain under service `codexrev`. This means different providers in the same project can have different API keys, all encrypted with the same DEK.

Local providers (Ollama, LM Studio) skip the API key step entirely.

## OAuth (future)

OAuth flows are not implemented yet. Today, all providers use long-lived API keys. A future Codexrev release may add device-code or PKCE for providers that support it.

## Storing keys

For local development we recommend:

- Use `codexrev models add` to store keys per-provider in the encrypted config (recommended).
- A `.env.local` at `~/.codexrev/.env` for personally-used keys.
- A per-project `.codexrev/.env` for repo-shared MCP keys (not in version control).

For shared systems, prefer a real secret manager (1Password CLI, HashiCorp Vault, macOS Keychain via `security`).

## Yanking a key

If you suspect a key has leaked, rotate it at the provider immediately:

- OpenAI: <https://platform.openai.com/api-keys>
- Anthropic: <https://console.anthropic.com/settings/keys>
- Google: <https://aistudio.google.com/app/apikey>

Then re-run `codexrev models add` to update the stored key, or set the new key via the environment variable.
