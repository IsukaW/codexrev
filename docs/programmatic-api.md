# Programmatic API

Codexrev ships as an npm package so you can embed it in your own scripts and tools. The recommended import path is `codexrev`, which re-exports a curated surface from `./dist/api.js`.

## Install

```bash
npm install codexrev
```

## Hello world

```ts
import { createAgent } from 'codexrev';

const agent = await createAgent({
  provider: 'openai',
  model: 'gpt-4o-mini',
});

const result = await agent.send('What is the capital of France?');
console.log(result.finalText);

await agent.close();
```

## Streaming

```ts
for await (const ev of agent.stream('Tell me a joke')) {
  if (ev.kind === 'text_delta') process.stdout.write(ev.text);
}
```

## Lower-level: `runAgent`

```ts
import { runAgent } from 'codexrev';

const result = await runAgent({
  prompt: '…',
  provider,                 // pre-built ContentGenerator
  tools,                    // ToolRegistry
  mcp,                      // McpRegistry
  settings,                 // Settings
  stream: false,
});
```

`runAgent` is overloaded: with `stream: true` it returns an `AsyncIterable<AgentEvent>`.

## Surface summary

See `src/api/index.ts` for the canonical surface. Key exports:

- `createAgent`, `runAgent`, `buildProvider`
- `loadSettings`, `saveSettings`, `DEFAULT_SETTINGS`, `ENV`
- `builtinTools`, `createToolRegistry`, `listTools`
- `createMcpRegistry`, `CheckpointService`, `SandboxManager`
- `initTelemetry`, `withSpan`, `shutdownTelemetry`
- All four provider classes and corresponding error types

## TypeScript

Everything is fully typed. `Package.json` declares `"type": "module"`, so use ESM `import`s. CommonJS is supported via the `codexrev/dist/api.cjs` entry.
