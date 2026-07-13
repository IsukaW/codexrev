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
