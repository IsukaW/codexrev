// Role files should never import a specific provider adapter directly, they
// go through ILLMProvider so any of the supported providers can be swapped in
// underneath. Thin wrapper over the existing provider factory — doesn't
// reimplement request/streaming, just narrows the shape and lets a caller
// target a different provider than the project's active one (eval code uses
// this to compare a local model against a cloud one on the same diff).
//
// It also retries calls that died on the network. A review makes hundreds of
// model calls over tens of minutes, and on a remote endpoint one of them
// eventually drops (ECONNRESET / ETIMEDOUT, often mid-response: "Invalid
// response body … read ECONNRESET"). The SDK's own retry only covers failures
// before the response starts, so one dropped connection used to end a 45-minute
// --fix run. A model call has no side effects, so asking again is always safe.

import type {
  GenerateRequest,
  GenerateResponse,
  ProviderId,
  StreamEvent,
} from '../../../core/types.js';
import type { Settings } from '../../../config/schema.js';
import { buildProvider } from '../../../providers/index.js';

export interface ILLMProvider {
  readonly id: ProviderId;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
}

export interface ProviderRetryOptions {
  /** wait before each retry; its length is the number of retries (default 3s, 10s, 30s) */
  readonly delaysMs?: readonly number[];
  /** told before each wait, so the user sees why nothing is happening */
  readonly onRetry?: (info: { attempt: number; of: number; delayMs: number; reason: string }) => void;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000];

// The connection failed, not the request: the same call can succeed a moment later. Includes the
// SDK's mid-body failure, undici's socket errors, and DNS hiccups on flaky networks. Not the SDK's own
// "Request timed out": that is the configured timeoutMs (up to 30 min for a local model) running out,
// and repeating a call that slow would turn one stall into hours.
const TRANSIENT_NETWORK =
  /ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|CLOSED)|socket hang up|other side closed|Invalid response body|terminated|network error|fetch failed|Connection error/i;

// local servers that are simply not running refuse at once; retrying that only delays the real message
const LOCAL_PROVIDERS = new Set<string>(['ollama', 'lmstudio']);

/** a short reason when `err` is worth retrying, null when it is not (bad request, auth, a server that is not running) */
export function transientReason(err: unknown, providerId: string): string | null {
  const e = err as { message?: string; code?: unknown; httpStatus?: unknown; status?: unknown; cause?: { code?: unknown; message?: string } } | null;
  if (!e || typeof e !== 'object') return null;
  const status = typeof e.httpStatus === 'number' ? e.httpStatus : typeof e.status === 'number' ? e.status : undefined;
  if (status === 429) return 'rate limited (429)';
  if (status !== undefined && status >= 500) return `server error (${status})`;
  if (status !== undefined) return null; // 4xx other than 429: the request itself is wrong, asking again will not help
  const text = `${String(e.code ?? '')} ${String(e.cause?.code ?? '')} ${e.message ?? ''} ${e.cause?.message ?? ''}`;
  if (/ECONNREFUSED|ENOTFOUND/.test(text)) return LOCAL_PROVIDERS.has(providerId) ? null : /ENOTFOUND/.test(text) ? 'DNS lookup failed' : 'connection refused';
  const m = TRANSIENT_NETWORK.exec(text);
  return m ? `connection dropped (${m[0]})` : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function withRetry(provider: ILLMProvider, opts: ProviderRetryOptions = {}): ILLMProvider {
  const delays = opts.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  return {
    id: provider.id,
    async generate(req) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await provider.generate(req);
        } catch (err) {
          const reason = transientReason(err, provider.id);
          if (reason === null || attempt >= delays.length) throw err;
          opts.onRetry?.({ attempt: attempt + 2, of: delays.length + 1, delayMs: delays[attempt]!, reason });
          await sleep(delays[attempt]!);
        }
      }
    },
    // a stream is retried only before its first event: after that the caller has already used part of the answer
    async *stream(req) {
      for (let attempt = 0; ; attempt++) {
        let started = false;
        try {
          for await (const ev of provider.stream(req)) {
            started = true;
            yield ev;
          }
          return;
        } catch (err) {
          const reason = transientReason(err, provider.id);
          if (started || reason === null || attempt >= delays.length) throw err;
          opts.onRetry?.({ attempt: attempt + 2, of: delays.length + 1, delayMs: delays[attempt]!, reason });
          await sleep(delays[attempt]!);
        }
      }
    },
  };
}

// binds to settings.provider by default, or providerId if given, without mutating settings
export function createLLMProvider(settings: Settings, providerId?: ProviderId, retry?: ProviderRetryOptions): ILLMProvider {
  const target = providerId ?? settings.provider;
  const effectiveSettings: Settings =
    target === settings.provider ? settings : { ...settings, provider: target };
  const generator = buildProvider(effectiveSettings);
  return withRetry(
    {
      id: generator.provider,
      generate: (req) => generator.generate(req),
      stream: (req) => generator.stream(req),
    },
    retry,
  );
}
