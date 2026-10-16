/**
 * Chooses the model for interpretation using ONLY the leader's shared
 * architecture: loadSettings() decides provider and model, providerMeta() and
 * resolveBaseUrlForProvider() describe it, probeLocalProvider() checks it is
 * reachable, and buildProvider() creates the ContentGenerator. Nothing here
 * hardcodes a runtime, an endpoint or a model name, and there is no separate
 * Feature 4 model registry.
 *
 * Privacy is local-first and fails closed:
 *   - the configured provider must be a LOCAL model server: one that needs no
 *     API key AND whose base URL points at this machine (loopback). Cloud
 *     providers, and "local-type" servers configured at a remote address, are
 *     refused, so repository content is never sent off the machine silently.
 *   - sending to a non-local provider needs explicit authorization
 *     (`allowNonLocalProvider`), which nothing enables by default.
 *   - there is never a fallback: if the configured provider is unusable the
 *     result is UNAVAILABLE. No other provider is tried, ever.
 */

import { loadSettings } from '../../../config/loader.js';
import type { ContentGenerator, ProviderId } from '../../../core/types.js';
import { buildProvider } from '../../../providers/index.js';
import { probeLocalProvider, resolveBaseUrlForProvider } from '../../../providers/health.js';
import { providerMeta } from '../../../providers/registry.js';
import { clip } from '../collectors/types.js';
import { maskSecrets } from './contextBuilder.js';
import type { InterpretationFailureKind } from './types.js';

/** The shared functions this module calls, injectable so tests never touch a real model or config. */
export interface ProviderSelectionDeps {
  readonly loadSettings: typeof loadSettings;
  readonly buildProvider: typeof buildProvider;
  readonly probeLocalProvider: typeof probeLocalProvider;
}

export const DEFAULT_PROVIDER_DEPS: ProviderSelectionDeps = { loadSettings, buildProvider, probeLocalProvider };

export type ProviderSelection =
  | {
      readonly ok: true;
      readonly generator: ContentGenerator;
      readonly providerId: ProviderId;
      readonly model: string;
      /** a local model server on this machine */
      readonly local: boolean;
      /** true only when a non-local provider was used because the caller explicitly allowed it */
      readonly authorizedNonLocal: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 'UNAVAILABLE' | 'ERROR';
      readonly failureKind: InterpretationFailureKind;
      readonly reason: string;
    };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/** True if the URL points at this machine. A malformed URL is treated as NOT local. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

// host only: never echo a URL that might carry credentials or a path
function hostOf(url: string | null): string {
  if (!url) return 'a cloud service';
  try {
    return new URL(url).host;
  } catch {
    return 'an unrecognised address';
  }
}

const safeMessage = (err: unknown): string => maskSecrets(clip(String((err as Error)?.message ?? err).split('\n')[0], 300)).text;

export async function selectInterpretationProvider(opts: {
  readonly cwd: string;
  /** explicit authorization to use a provider that is not a local model server; default false */
  readonly allowNonLocalProvider?: boolean;
  readonly deps?: Partial<ProviderSelectionDeps>;
}): Promise<ProviderSelection> {
  const deps: ProviderSelectionDeps = { ...DEFAULT_PROVIDER_DEPS, ...opts.deps };

  let settings;
  try {
    settings = await deps.loadSettings(opts.cwd);
  } catch (err) {
    return { ok: false, status: 'UNAVAILABLE', failureKind: 'config_error', reason: `the CodeXRev configuration could not be loaded: ${safeMessage(err)}` };
  }

  const providerId = settings.provider;
  const model = settings.providers[providerId]?.model || settings.model;
  if (!model) {
    return { ok: false, status: 'UNAVAILABLE', failureKind: 'no_model', reason: `no model is configured for provider "${providerId}"` };
  }

  let meta;
  try {
    meta = providerMeta(providerId);
  } catch {
    return { ok: false, status: 'UNAVAILABLE', failureKind: 'unsupported_provider', reason: `provider "${String(providerId)}" is not supported` };
  }

  const baseUrl = resolveBaseUrlForProvider(providerId, settings.providers[providerId]?.baseUrl);
  const local = !meta.requiresApiKey && baseUrl !== null && isLoopbackUrl(baseUrl);
  const authorizedNonLocal = !local && opts.allowNonLocalProvider === true;
  if (!local && !authorizedNonLocal) {
    return {
      ok: false,
      status: 'UNAVAILABLE',
      failureKind: 'not_local',
      reason:
        `the configured provider "${providerId}" is not a local model server (${hostOf(baseUrl)}). ` +
        'Nothing from the repository was sent to it. Interpretation needs a local provider (for example one running on this machine), ' +
        'or explicit authorization to use a non-local one. No other provider was tried.',
    };
  }

  // a model server that is not running is a fast, clear failure, not a hang
  if (baseUrl && !meta.requiresApiKey) {
    try {
      await deps.probeLocalProvider(providerId, baseUrl);
    } catch (err) {
      return { ok: false, status: 'UNAVAILABLE', failureKind: 'server_unreachable', reason: safeMessage(err) };
    }
  }

  try {
    const generator = deps.buildProvider(settings);
    return { ok: true, generator, providerId, model, local, authorizedNonLocal };
  } catch (err) {
    return { ok: false, status: 'UNAVAILABLE', failureKind: 'unsupported_provider', reason: `the provider could not be initialised: ${safeMessage(err)}` };
  }
}
