// Hits GET <baseUrl>/models with a short timeout so we fail fast with a friendly
// LocalServerError instead of an opaque SDK stack trace when Ollama/LM Studio/LiteLLM
// isn't running. Cloud providers aren't probed here — the OpenAI client already gives
// a clear enough error and an extra round-trip on every launch isn't worth it.

import type { ProviderId } from '../core/types.js';
import { LocalServerError } from '../utils/errors.js';
import { providerMeta } from './registry.js';

const PROBE_TIMEOUT_MS = 5_000;

// settings baseUrl wins, then env var, then registry default. null for providers with
// no base-URL knob (Google Vertex etc).
export function resolveBaseUrlForProvider(
  id: ProviderId,
  settingsBaseUrl?: string,
): string | null {
  const meta = providerMeta(id);
  if (!meta.defaultBaseUrl) return null;
  if (settingsBaseUrl) return settingsBaseUrl;
  if (meta.envBaseUrlVar && process.env[meta.envBaseUrlVar]) {
    return process.env[meta.envBaseUrlVar]!;
  }
  return meta.defaultBaseUrl;
}

// resolves quietly on 2xx, throws LocalServerError on refused/DNS-fail/timeout/non-2xx.
// callers should gate on providerMeta(id).requiresApiKey === false (or
// !meta.defaultBaseUrl) before calling this for cloud providers.
export async function probeLocalProvider(
  id: ProviderId,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const onParentAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(t);
      ac.abort();
    } else {
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new LocalServerError(
        id,
        baseUrl,
        `Server returned HTTP ${res.status} ${res.statusText}`,
      );
    }
  } catch (err) {
    if (err instanceof LocalServerError) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new LocalServerError(
        id,
        baseUrl,
        `Probe timed out after ${PROBE_TIMEOUT_MS}ms`,
      );
    }
    throw new LocalServerError(
      id,
      baseUrl,
      (err as Error)?.message ?? 'connection failed',
    );
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}