# Architecture

Codexrev is layered:

```
┌────────────────────────┐
│  CLI / TUI / non-int   │   ← packages/cli
├────────────────────────┤
│  Public API            │   ← codexrev (npm)
├────────────────────────┤
│  Agent loop            │   ← core/turn.ts
├────────────────────────┤
│  Tools ─┬─ builtins    │   ← tools/
│         └─ MCP         │   ← mcp/
├────────────────────────┤
│  Providers (4 adapters)│   ← providers/
├────────────────────────┤
│  Config / Settings     │   ← config/
└────────────────────────┘
```

## Key abstractions

### `ContentGenerator`

The unified interface every provider implements:

```ts
interface ContentGenerator {
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
  readonly config: ContentGeneratorConfig;
}
```

`providers/openai.ts`, `providers/anthropic.ts`, `providers/google.ts`, and `providers/litellm.ts` each adapt their vendor SDK onto this interface. `providers/index.ts#buildProvider(settings)` is the factory.

### Agent loop (`core/turn.ts`)

`runAgent(opts)` runs the turn loop:

1. Build a system prompt.
2. Call the provider's `stream()` (or `generate()` if `stream:false`).
3. Accumulate the response. If the model emits `tool_call`s, dispatch them through `executeToolCall` (builtin map then MCP), append `tool_result` messages, and loop.
4. Stop when the model emits a final `text` part with finish reason `stop` or `max_tokens`.

### Tool registry

`ToolRegistry` (in `tools/registry.ts`) maps tool name → `Tool`. `createToolRegistry(settings)` returns a registry seeded with the eight built-ins (plus any MCP tools discovered in `settings.mcp`).

### MCP

`McpRegistry` (in `mcp/registry.ts`) maintains one client per configured MCP server. Each MCP tool is exposed under `<server>__<tool>` to disambiguate.

## Settings layering

`config/loader.ts#loadSettings()` merges defaults → user → project → env into a single immutable `Settings` object validated against an `ajv` schema (`config/schema.ts`).

## CLI dispatch (`cli/index.ts`)

1. yargs parses argv.
2. If the user invoked `extensions <subcommand>`, route to the subcommand handler and exit.
3. Otherwise, load settings + extensions, then either:
   - `runNonInteractive({...})` if `--print` is set,
   - `runTui({...})` otherwise.

## Extensions

`extensions/loader.ts` scans `~/.codexrev/extensions/*/` for `codexrev-extension.json` manifests and aggregates them into a single `ExtensionRegistry` passed to the TUI and the agent.

## Sandboxing

`SandboxManager.exec(argv, opts)` resolves a backend (`seatbelt`/`docker`/`podman`/`off`) and runs the command. The shell tool calls into this for every command.

## Checkpoints

`CheckpointService` keeps a shadow git repo at `~/.codexrev/checkpoints/<session>/`. Files copied into the shadow repo at `commit()` time form the snapshot; `restore()` writes them back; `diff()` returns a unified diff.

## Telemetry

`initTelemetry({...})` installs an OTLP/gRPC exporter. `withSpan(name, fn)` wraps async work. The agent loop and tool executions each open a span when telemetry is on.
