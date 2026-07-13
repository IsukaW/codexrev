# Tools API

Codexrev ships eight built-in tools and accepts third-party tools through extensions and MCP. This page covers the runtime contract for a tool.

## The `Tool` interface

```ts
import type { Tool, ToolContext, ToolResult } from 'codexrev';

const myTool: Tool = {
  name: 'my_tool',
  description: 'A short summary for the model. < 200 chars is best.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'what to do' },
    },
    required: ['message'],
  },
  execute: async (
    args: { message: string },
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    // …do work…
    return { output: '…', isError: false };
  },
};
```

## Registering

```ts
import { createToolRegistry } from 'codexrev';

const reg = createToolRegistry({
  provider: 'openai',
  model: 'gpt-4o-mini',
} /* plus your settings */);
reg.register(myTool);
```

## Loading built-ins

`builtinTools(settings)` returns the eight built-ins. `listTools(settings)` is a thin convenience wrapper.

## Through MCP

MCP servers expose tools automatically. Codexrev prefixes them with `serverName__` to avoid collisions.

## Approval

`ToolContext` carries `{ cwd, signal, env, ask }`. `await ctx.ask('ok?')` invokes the user confirmation flow when `settings.approvalMode === 'on-request'`.

## Cancellation

A `ToolContext.signal` is an `AbortSignal`. Long-running tools should respect it:

```ts
await new Promise((r, j) => {
  ctx.signal.addEventListener('abort', j);
  doWork().then(r);
});
```
