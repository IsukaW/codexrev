# Troubleshooting

## `codexrev: command not found`

`npm install -g .` finished but `codexrev` is not on your `PATH`. Either re-run with the right prefix or add the npm global bin directory (`npm bin -g`) to `PATH`.

## `ProviderError: missing API key`

Set the appropriate environment variable for the provider you're targeting:

- `openai` → `OPENAI_API_KEY`
- `anthropic` → `ANTHROPIC_API_KEY`
- `google` → `GOOGLE_API_KEY` (or `GEMINI_API_KEY`)
- `litellm` → `OPENAI_API_KEY` plus `OPENAI_BASE_URL`

## TUI looks broken

Make sure your terminal speaks ANSI escape sequences. On Windows, use Windows Terminal or set the legacy console off in `codexrev`:

```bash
NO_COLOR=1 codexrev
```

If text overlaps, try `--theme light`.

## Build fails with `top-level await` errors

Ensure your platform supports modern Node (≥ 20). Code that uses top-level await (Ink, React 19 server components, etc.) is left *external* in the bundle — it should always resolve at runtime.

## Sandbox: `operation not permitted`

The Seatbelt profile denies writes outside `cwd` (and `/tmp`). Use `--sandbox off` if you need to escape, or update the allowlist. See [sandbox.md](sandbox.md).

## `simple-git` errors

Checkpoints require `git` on `PATH`. On Windows, install Git for Windows and ensure `git --version` works in your current shell.

## MCP server connection drops

Codexrev times out after `settings.mcp.<name>.timeoutMs` (default 30 s). Increase it:

```jsonc
{ "mcp": { "remote": { "transport": "sse", "url": "…", "timeoutMs": 120000 } } }
```

## DeprecationWarning DEP0187

This warning comes from the `simple-git` package calling `fs.existsSync(undefined)`. It is harmless and will be fixed upstream. Silence it with `NODE_OPTIONS=--no-deprecation` if it bothers you.
