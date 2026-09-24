// Opt-in OpenTelemetry tracing, exports OTLP/gRPC to whatever collector the operator
// runs (Jaeger, Tempo, SigNoz, any OTLP backend). Off by default — set telemetry: true
// in ~/.codexrev/settings.json or pass --telemetry to turn it on.

import { trace, type Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  /** defaults to http://localhost:4317 */
  endpoint?: string;
  /** service.version attribute, default '0.1.0' */
  version?: string;
  /** default 'codexrev' */
  serviceName?: string;
}

const TRACER_NAME = 'codexrev';

let _sdk: NodeSDK | null = null;
let initialised = false;

// calling this more than once is a no-op; returns whether telemetry actually got installed
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
    // best-effort flush on shutdown signals
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

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

// runs fn inside a span, records exceptions and re-throws
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

// same as withSpan but for sync work
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

export function recordEvent(
  name: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.addEvent(name, attributes);
}

export function isTelemetryEnabled(): boolean {
  return _sdk !== null;
}
