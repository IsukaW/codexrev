# Architecture

Codexrev is layered:

```
┌──────────────────────────────────────────┐
│  CLI / TUI / non-int                     │   ← packages/cli
├──────────────────────────────────────────┤
│  Public API                              │   ← codexrev (npm)
├──────────────────────────────────────────┤
│  Modes (Ask / Plan / Agent)              │   ← core/modes.ts
│  ┌────────────────────────────────────┐  │
│  │ Fix Loop  (Agent mode entry point) │  │   ← core/fixLoop.ts
│  │ ┌──────────────────────────────┐   │  │
│  │ │ Pipeline: Committee →        │   │  │   ← core/pipeline.ts
│  │ │   Breaker-Builder → Resolver │   │  │
│  │ └──────────────────────────────┘   │  │
│  │ Verification (tests / LLM / auto)  │  │   ← core/verification.ts
│  └────────────────────────────────────┘  │
│  InteractionChannel (Q&A / fix-confirm)  │   ← core/interaction.ts
├──────────────────────────────────────────┤
│  Agent loop                              │   ← core/turn.ts
├──────────────────────────────────────────┤
│  Tools ─┬─ builtins (+ ask_user)         │   ← tools/
│         └─ MCP                           │   ← mcp/
├──────────────────────────────────────────┤
│  Providers (4+ adapters)                 │   ← providers/
├──────────────────────────────────────────┤
│  Config / Settings                       │   ← config/
└──────────────────────────────────────────┘
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

### Interaction modes (`core/modes.ts`)

Three modes control how the agent processes user input:

- **Ask** — Read-only Q&A. Strips all write tools; only `read_file`, `glob`, `grep`, `web_fetch`, `web_search`, and `ask_user` are available.
- **Plan** — Analysis-only. Same read-only tool set, but the system prompt instructs the model to produce a numbered step-by-step plan without executing it.
- **Agent** — Full pipeline with fix-loop. All tools available.

Each mode injects a `systemPromptSuffix` that steers the model's behavior. Modes can be switched at runtime via Tab or `/mode`.

### Multi-agent pipeline (`core/pipeline.ts`)

In Agent mode, each user prompt flows through three sequential phases:

```
User prompt
    │
    ▼
┌─────────────┐   read-only tools
│  Committee   │ → structured analysis (problem, files, approach, risks)
└─────┬───────┘
      │
      ▼
┌─────────────┐   all tools
│ Breaker-    │ → implements changes following the Committee's plan
│ Builder     │
└─────┬───────┘
      │
      ▼
┌─────────────┐   read + shell tools
│  Resolver   │ → verifies changes, outputs GREEN: or RED:
└─────────────┘
```

Each phase is a separate `runAgent()` call with its own system prompt and tool subset. The Committee and Breaker-Builder receive any prior conversation context (e.g. plans from Plan mode) so they can act on earlier analysis.

### Fix loop (`core/fixLoop.ts`)

When the Resolver returns RED, the fix loop kicks in:

1. Show the failure status to the user.
2. Ask the user to **continue** or **stop** (via the InteractionChannel).
3. If continuing, re-run Breaker-Builder + Resolver with the error context.
4. Repeat up to `maxFixAttempts` times (default 5).
5. On GREEN → success. On max attempts reached or user stop → keep last-applied state.

Retry iterations skip the Committee phase since the analysis is already done.

### Verification (`core/verification.ts`)

The Resolver's verification is configurable via `verificationMode`:

- **`tests`** — Auto-detect the project's test runner (npm test, pytest, go test, cargo test, etc.) and run it.
- **`llm`** — Ask the LLM to evaluate the changes. Response must start with `GREEN:` or `RED:`.
- **`auto`** (default) — Try the test suite first. If no test runner is detected, fall back to LLM evaluation.

### InteractionChannel (`core/interaction.ts`)

An async producer-consumer channel that lets the pipeline pause mid-run to interact with the user:

- **Clarification** — When the model calls the `ask_user` tool, the pipeline pauses, the TUI shows the question with suggestions and a free-form text input, and the user's answer is returned to the model as a tool result.
- **Fix confirmation** — When the Resolver returns RED, the pipeline pauses to ask the user whether to continue fixing or stop.

The channel uses `EventEmitter` internally and returns Promises that block until the UI responds.

### Context passing between modes

When the user switches from one mode to another (e.g. Plan → Agent), the full conversation history (user and assistant messages) is passed as `contextMessages` to the agent. This means:

- A plan generated in Plan mode is visible to the Agent mode's Committee phase.
- The Committee can incorporate the plan into its analysis.
- The Breaker-Builder implements based on the plan.
- The Resolver verifies against the original request and the plan.

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
