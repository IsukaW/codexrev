/**
 * Codexrev — local-provider connectivity probe.
 *
 * Hits `GET <baseUrl>/models` with a short timeout so the CLI can fail
 * fast with a friendly `LocalServerError` instead of an opaque SDK
 * stack trace when Ollama / LM Studio / LiteLLM is not running.
 *
 * Cloud providers (OpenAI / Anthropic / Google) are not probed — the
 * OpenAI client already surfaces a clearer error for those cases and
 * adding an extra network round-trip on every launch is wasteful.
 */

import type { ProviderId } from '../core/types.js';
import { LocalServerError } from '../utils/errors.js';
import { providerMeta } from './registry.js';

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Returns the resolved base URL for a provider — settings-provided baseUrl
 * wins, then env-var, then the registry default. Returns `null` for
 * providers without a base-URL knob (e.g. Google Vertex).
 */
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

/**
 * Probe the local server. Resolves silently on a 2xx response and throws
 * `LocalServerError` on connection refused, DNS failure, timeout, or a
 * non-2xx response. Does nothing for cloud providers — callers should
 * gate with `providerMeta(id).requiresApiKey === false` (or
 * `!meta.defaultBaseUrl`) before invoking.
 */
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