/**
 * Narrow LLM adapter for the living-spec inference engine.
 *
 * Role/pipeline code never imports a concrete provider adapter directly — it
 * goes through `LLMPort` so any supported provider can be swapped in
 * underneath (a local Ollama/LM Studio model offline, or a hosted one for
 * evaluation). This mirrors the narrow-adapter idea used elsewhere in the
 * codebase but is fully self-contained: it only reaches for the shared
 * provider factory (`src/providers`) and the shared `core/types` request /
 * response shapes, never another feature's code.
 *
 * Only the single-shot `generate` path is exposed — implication inference is a
 * one-request/one-response job, so streaming and tool-calling are out of scope
 * on purpose (that keeps the port genuinely narrow).
 */

import type {
  ContentGenerator,
  GenerateRequest,
  GenerateResponse,
  ProviderId,
} from '../../../core/types.js';
import { DEFAULT_SETTINGS, type ProviderSettings, type Settings } from '../../../config/schema.js';
import { buildProvider } from '../../../providers/index.js';
import { isProviderId, providerMeta } from '../../../providers/registry.js';
import { LivingSpecConfigError } from '../tools/errors.js';

export interface LLMPort {
  readonly provider: ProviderId;
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

/**
 * Providers that run on loopback / local infrastructure and never touch the
 * public network. `--offline` asserts the resolved provider is one of these so
 * core inference provably works with networking disabled (NFR2/FR14).
 */
const LOCAL_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  'ollama',
  'lmstudio',
  'litellm',
]);

/** True when the provider runs locally (no public-network round trip). */
export function isLocalProvider(id: ProviderId): boolean {
  return LOCAL_PROVIDER_IDS.has(id);
}

/** True when the provider would reach the public network (cloud APIs). */
export function isNetworkProvider(id: ProviderId): boolean {
  return !isLocalProvider(id);
}

/**
 * Default inference provider: a local model server so the semantic half works
 * with networking disabled. Swappable via config / `--provider`.
 */
export const DEFAULT_INFERENCE_PROVIDER: ProviderId = 'lmstudio';

/** Default model for a provider: the registry default (Qwen-family for LM Studio). */
export function defaultInferenceModel(provider: ProviderId): string {
  return providerMeta(provider).defaultModel;
}

/** Default per-request timeout for implication inference (2 min). */
export const DEFAULT_INFERENCE_TIMEOUT_MS = 120_000;

export { isProviderId };

/** Resolved provider + model for one inference run. */
export interface InferenceTarget {
  readonly provider: ProviderId;
  readonly model: string;
}

/**
 * Resolves the provider/model to use for inference from the CLI overrides and
 * the feature's `modelOverride` (`<provider>/<model>`). Precedence:
 * `--model` > `--provider` > `config.modelOverride` > local defaults. Throws
 * `LivingSpecConfigError` for an unknown `--provider`.
 */
export function resolveInferenceTarget(opts: {
  readonly provider?: string;
  readonly model?: string;
  readonly modelOverride?: string;
}): InferenceTarget {
  let provider: ProviderId = DEFAULT_INFERENCE_PROVIDER;
  let model = defaultInferenceModel(provider);

  const override = opts.modelOverride;
  if (override) {
    const slash = override.indexOf('/');
    if (slash > 0 && isProviderId(override.slice(0, slash))) {
      provider = override.slice(0, slash) as ProviderId;
      model = override.slice(slash + 1);
    } else {
      model = override;
    }
  }

  if (opts.provider !== undefined) {
    if (!isProviderId(opts.provider)) {
      throw new LivingSpecConfigError(`unknown provider "${opts.provider}"`);
    }
    provider = opts.provider;
    if (opts.model === undefined) model = defaultInferenceModel(provider);
  }
  if (opts.model !== undefined) model = opts.model;

  return { provider, model };
}

export interface LLMPortOptions {
  readonly provider: ProviderId;
  readonly model: string;
  /** Per-request timeout passed down to the provider adapter (ms). */
  readonly timeoutMs?: number;
  /** Optional base-URL override (e.g. a remote Ollama host). */
  readonly baseUrl?: string;
  /** Optional API-key override for providers that need one. */
  readonly apiKey?: string;
}

/**
 * Builds a real `LLMPort` bound to the requested provider/model without
 * mutating global settings. The provider entry's model + timeout win over the
 * settings defaults so `--model` / `--timeout` swap cleanly (NFR10).
 */
export function createLLMPort(opts: LLMPortOptions): LLMPort {
  const entry: ProviderSettings = {
    ...DEFAULT_SETTINGS.providers[opts.provider],
    provider: opts.provider,
    model: opts.model,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  };

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    provider: opts.provider,
    model: opts.model,
    providers: { ...DEFAULT_SETTINGS.providers, [opts.provider]: entry },
  };

  const generator: ContentGenerator = buildProvider(settings);
  return {
    provider: generator.provider,
    model: opts.model,
    generate: (req) => generator.generate(req),
  };
}
