# Telemetry

Codexrev emits OpenTelemetry traces when you opt in. Telemetry is **off** by default.

## Enabling

```bash
codexrev --telemetry
```

or persistently:

```jsonc
{ "telemetry": true }
```

By default spans are exported via OTLP/gRPC to `http://localhost:4317`. Set `CODEXREV_OTEL_ENDPOINT` to point at a collector or a Honeycomb/Tempo/SigNoz OTLP endpoint.

## What is traced

| Span | Description |
| --- | --- |
| `agent.run` | One agent invocation. |
| `agent.turn` | One turn within a run. |
| `llm.generate` / `llm.stream` | The provider call. |
| `tool.execute` | A single tool execution. |

Each span carries attributes like `provider`, `model`, `tool.name`, and `tool.duration_ms`.

## Programmatic

```ts
import { initTelemetry, withSpan, shutdownTelemetry } from 'codexrev';

initTelemetry({ endpoint: 'http://collector:4317' });

await withSpan('my.feature', async () => {
  // …
});

await shutdownTelemetry();
```

## What is **not** collected

- Prompt contents (the agent's text is never sent to a telemetry backend).
- Tool `output` bodies.
- Environment variables.

If you want logs of these too, write a custom exporter or check your collector's sampler.
