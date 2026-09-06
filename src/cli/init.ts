/**
 * Codexrev — `codexrev init` subcommand.
 *
 * Walks the user through creating an encrypted `.codexrev/config.json`
 * for the current project. Two modes:
 *   - Interactive (default): Ink TUI wizard when stdout is a TTY.
 *   - Non-interactive (`--non-interactive --provider … --api-key …`):
 *     CI / scripting. All flags must be supplied or it exits 2.
 */

import { render } from 'ink';
import React from 'react';
import { logger } from '../utils/logger.js';
import {
  deleteProjectConfig,
  loadProjectConfig,
  nowIso,
  projectConfigPath,
  saveProjectConfig,
} from '../config/projectConfig.js';
import { deleteDek, getDek, isAvailable as keychainAvailable, setDek, unavailableReason } from '../security/keychain.js';
import { encrypt, generateDek } from '../security/secrets.js';
import { InitWizard } from '../ui/InitWizard.js';
import type { InitWizardAnswers } from '../ui/InitWizard.js';
import type { ProviderId } from '../core/types.js';
import type { ProviderConfigEntry } from '../config/projectSchema.js';
import { DEFAULT_SETTINGS } from '../config/schema.js';
import { DEFAULT_LOCAL_TIMEOUT_MS, isProviderId, providerMeta } from '../providers/registry.js';

export interface InitOptions {
  cwd: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Per-request client timeout (ms). Defaults to 30 min for local providers, unset for cloud ones. */
  timeoutMs?: number;
  reset?: boolean;
  nonInteractive?: boolean;
}

function defaultModelFor(provider: ProviderId): string {
  return DEFAULT_SETTINGS.providers[provider].model;
}

export async function runInit(opts: InitOptions): Promise<void> {
  if (!keychainAvailable()) {
    process.stderr.write(
      `\n[codexrev] OS keychain is required to seal the API key but is unavailable:\n` +
        `           ${unavailableReason()}\n\n` +
        `           On Linux: sudo apt install libsecret-1-0\n` +
        `           On macOS / Windows: no extra step needed.\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (opts.reset) {
    await deleteProjectConfig(opts.cwd);
    await deleteDek(opts.cwd).catch(() => false);
    console.log(`[codexrev] reset: removed existing config and DEK for ${opts.cwd}`);
  }

  const existing = await loadProjectConfig(opts.cwd);
  if (existing && !opts.reset) {
    console.log(`[codexrev] config already exists at ${projectConfigPath(opts.cwd)}`);
    console.log(`[codexrev] re-run with --reset to replace it.`);
    return;
  }

  // Resolve inputs.
  let provider: ProviderId | undefined;
  let model: string | undefined;
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let toolCalling: boolean | undefined;
  let vision: boolean | undefined;
  let maxInputTokens: number | undefined;
  let maxOutputTokens: number | undefined;

  if (opts.nonInteractive) {
    provider = isProviderId(opts.provider) ? opts.provider : undefined;
    model = opts.model;
    apiKey = opts.apiKey;
    baseUrl = opts.baseUrl;
    // Capabilities default to the provider's advertised behaviour when a
    // flag is not supplied; token limits stay unset unless given.
    toolCalling = opts.toolCalling ?? (provider ? providerMeta(provider).supportsTools : undefined);
    vision = opts.vision ?? false;
    maxInputTokens = opts.maxInputTokens;
    maxOutputTokens = opts.maxOutputTokens;
    // Local providers (Ollama, LM Studio, LiteLLM) don't need an API key —
    // substitute the provider id as a sentinel so the OpenAI SDK client is
    // happy and the encrypted config still has something to store.
    if (provider && !providerMeta(provider).requiresApiKey && !apiKey) {
      apiKey = provider;
    }
    if (!provider || !model) {
      process.stderr.write(
        `[codexrev] --non-interactive requires --provider and --model\n`,
      );
      process.exitCode = 2;
      return;
    }
    // Cloud providers still require --api-key.
    if (provider && providerMeta(provider).requiresApiKey && !apiKey) {
      const envHint = providerMeta(provider).envKeyVar
        ? ` (or set ${providerMeta(provider).envKeyVar})`
        : '';
      process.stderr.write(
        `[codexrev] --non-interactive: provider "${provider}" requires --api-key${envHint}\n`,
      );
      process.exitCode = 2;
      return;
    }
  } else {
    const result = await runInteractiveWizard({
      provider: opts.provider,
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    });
    provider = result.provider;
    model = result.model;
    apiKey = result.apiKey;
    baseUrl = result.baseUrl;
    toolCalling = result.toolCalling;
    vision = result.vision;
    maxInputTokens = result.maxInputTokens;
    maxOutputTokens = result.maxOutputTokens;
  }

  // Local providers (Ollama, LM Studio, LiteLLM) get a generous request
  // timeout automatically — a larger local model on modest hardware can
  // genuinely take longer than the SDK's 10-minute default without being
  // stuck. `--timeout-ms` overrides this for any provider. No wizard step
  // needed: this just picks a sane default so `codexrev review scan` etc.
  // don't need hand-edited settings.json to work against a local model.
  const timeoutMs = opts.timeoutMs ?? (provider && !providerMeta(provider).requiresApiKey ? DEFAULT_LOCAL_TIMEOUT_MS : undefined);

  // Generate DEK and seal the API key.
  const dek = generateDek();
  await setDek(opts.cwd, dek);

  const sealedKey = encrypt(apiKey!, dek);

  // The `providers[]` registry is the single source of truth: each
  // provider entry owns its own sealed API key, base URL, and models
  // (with capabilities, token limits, and the active-model marker).
  // The top-level `provider` / `model` are just a pointer to the active
  // selection; the top-level `apiKey` is intentionally omitted so the
  // key is stored exactly once, tied to the provider it belongs to.
  //
  // Every ProviderId is also a valid registry vendor, so the cast is safe.
  const providerEntry: ProviderConfigEntry = {
    name: provider!,
    vendor: provider! as ProviderConfigEntry['vendor'],
    apiKey: sealedKey,
    ...(baseUrl ? { baseUrl } : {}),
    models: [
      {
        id: model!,
        name: model!,
        toolCalling: toolCalling ?? providerMeta(provider!).supportsTools,
        vision: vision ?? false,
        ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        default: true,
      },
    ],
  };

  const cfg = {
    schemaVersion: 1 as const,
    provider: provider!,
    model: model!,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    providers: [providerEntry],
  };

  await saveProjectConfig(opts.cwd, cfg);

  // Verify round-trip before declaring success.
  const fetched = await getDek(opts.cwd);
  if (!fetched) {
    process.stderr.write(`[codexrev] warning: DEK was written but cannot be read back.\n`);
    process.exitCode = 1;
    return;
  }

  // Never log secrets. Just confirm.
  console.log(`[codexrev] ✓ wrote encrypted config to ${projectConfigPath(opts.cwd)}`);
  console.log(`[codexrev] ✓ stored DEK in OS keychain under service "codexrev"`);
  logger.info('codexrev init complete', {
    provider: cfg.provider,
    model: cfg.model,
    projectRoot: opts.cwd,
  });
}

async function runInteractiveWizard(seed: {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<InitWizardAnswers> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const app = render(
      React.createElement(InitWizard, {
        initialProvider: isProviderId(seed.provider) ? seed.provider : undefined,
        initialModel: seed.model,
        initialApiKey: seed.apiKey,
        initialBaseUrl: seed.baseUrl,
        defaultModelFor,
        onSubmit: (answers) => {
          resolved = true;
          app.unmount();
          resolve(answers);
        },
        onCancel: () => {
          resolved = true;
          app.unmount();
          console.log('[codexrev] init cancelled');
          process.exit(130);
        },
      }),
    );
    app.waitUntilExit().then(() => {
      if (!resolved) reject(new Error('wizard exited without submitting'));
    });
  });
}