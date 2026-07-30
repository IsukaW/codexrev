# Tutorials

A handful of short walks through common Codexrev tasks.

## T1 — Refactor a TypeScript file

```bash
codexrev --print "Refactor src/server.ts to use async/await and explain each change."
```

Codexrev loads the file via `read_file`, reasons about it, and uses `edit` to apply the rewrite. Use `--approval-mode never` to skip confirmations in CI.

## T2 — Bulk rename across the repo

```bash
codexrev --print "Rename the function `oldName` to `newName` everywhere in src/."
```

## T3 — Wire up an MCP server

```bash
mkdir -p .codexrev
cat > .codexrev/settings.json <<'JSON'
{
  "mcp": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
JSON
codexrev --print "List the files in the current directory using the filesystem MCP server."
```

## T4 — Capture a checkpoint, edit, rewind

```ts
import { openCheckpoints } from 'codexrev';

const cp = openCheckpoints({ sessionId: 'demo', rootDir: process.cwd() });

await cp.commit('before-edit', [process.cwd() + '/README.md']);
// … edit the file …
await cp.restore('cp-id');
```

## T5 — Stream JSON to jq

```bash
codexrev --print "Summarise the last 10 commits" \
  --output-format stream-json \
  | jq -c 'select(.kind=="text_delta") | .text'
```

## T6 — Add a new provider with the models wizard

```bash
codexrev models add
```

The interactive wizard walks you through adding a provider and its first model. For example, to add MiniMax:

1. Select **Add new provider (+ first model)**
2. Enter provider name: `minimax`
3. Select vendor: `customendpoint — Custom OpenAI-compatible`
4. Enter base URL: `https://api.minimax.io/v1`
5. Enter your API key (Tab to toggle visibility)
6. Enter model ID: `MiniMax-M3`
7. Press Enter for the default display name
8. Answer capability prompts (tool-calling, vision, token limits)
9. Review and press Enter to save

After saving, you can add more models to the same provider or exit.

## T7 — Add a model to an existing provider

```bash
codexrev models add
```

Select **Add model to existing provider**, pick the provider, and fill in the model details. This is useful when a provider releases a new model (e.g. adding `gpt-4o-mini` alongside `gpt-4o`).

## T8 — Switch between providers and models

```bash
# See what's available
codexrev models list

# Switch the active model
codexrev models use claude-sonnet-4-20250514 --provider anthropic-team

# Now codexrev uses that model by default
codexrev --print "Explain this codebase"
```
