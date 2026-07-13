/**
 * Codexrev — telemetry module.
 *
 * Opt-in OpenTelemetry tracing. The exporter talks OTLP/gRPC to whatever
 * collector the operator runs (Jaeger / Tempo / SigNoz / an OTLP
 * compatible backend).
 *
 * Public surface:
 *   - `initTelemetry(opts)`   — install the global tracer provider
 *   - `withSpan(name, fn)`    — wrap async work in a span
 *   - `shutdownTelemetry()`   — flush + close on exit
 *   - `getTracer()`           — fetch the named tracer
 *
 * Telemetry is OFF by default; it is enabled when the user sets
 * `telemetry: true` in their `~/.codexrev/settings.json` or runs the CLI
 * with `--telemetry` (which sets `settings.telemetry = true`).
 */

import { trace, type Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  /** OTLP/gRPC endpoint. Defaults to `http://localhost:4317`. */
  endpoint?: string;
  /** Set the service.version attribute. Default `'0.1.0'`. */
  version?: string;
  /** Override service name. Default `'codexrev'`. */
  serviceName?: string;
}

const TRACER_NAME = 'codexrev';

let _sdk: NodeSDK | null = null;
let initialised = false;

/**
 * Initialise the global OpenTelemetry SDK. Calling this more than once
 * is a no-op. Returns whether telemetry was installed.
 */
export function initTelemetry(opts: TelemetryOptions = {}): boolean {
  if (initialised) return _sdk !== null;
  initialised = true;

  const endpoint = opts.endpoint ?? 'http://localhost:4317';
  try {
    const exporter = new OTLPTraceExporter({ url: endpoint });
    const sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: opts.serviceName ?? 'codexrev',
        [ATTR_SERVICE_VERSION]: opts.version ?? '0.1.0',
      }),
      spanProcessors: [],
      traceExporter: exporter,
    });
    sdk.start();
    _sdk = sdk;
    // Best-effort flushing on signals.
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => {
        shutdownTelemetry().catch(() => undefined);
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Shut down telemetry, flushing remaining spans.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!_sdk) return;
  try {
    await _sdk.shutdown();
  } catch {
    // ignore
  } finally {
    _sdk = null;
  }
}

/** Get the Codexrev tracer. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Convenience: run `fn` inside a span named `name`. Records exceptions
 * and re-throws.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: ReturnType<Tracer['startSpan']>) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = getTracer();
  return await tracer.startActiveSpan(name, async (span) => {
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) span.setAttribute(k, v);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: 2, message: (err as Error).message }); // ERROR
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Convenience: same as `withSpan` but synchronous-friendly (no async).
 */
export function withSpanSync<T>(
  name: string,
  fn: (span: ReturnType<Tracer['startSpan']>) => T,
  attributes?: Record<string, string | number | boolean>,
): T {
  const tracer = getTracer();
  const span = tracer.startSpan(name);
  if (attributes) {
    for (const [k, v] of Object.entries(attributes)) span.setAttribute(k, v);
  }
  try {
    const result = fn(span);
    span.setStatus({ code: 1 });
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: 2, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}

/** Convenience: add an event to the current span (if any). */
export function recordEvent(
  name: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.addEvent(name, attributes);
}

/** True if telemetry is currently installed. */
export function isTelemetryEnabled(): boolean {
  return _sdk !== null;
}
