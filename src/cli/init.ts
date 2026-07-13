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
import type { ProviderId } from '../core/types.js';
import { DEFAULT_SETTINGS } from '../config/schema.js';

export interface InitOptions {
  cwd: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  reset?: boolean;
  nonInteractive?: boolean;
}

function isProviderId(s: string | undefined): s is ProviderId {
  return s === 'openai' || s === 'anthropic' || s === 'google' || s === 'litellm';
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

  if (opts.nonInteractive) {
    provider = isProviderId(opts.provider) ? opts.provider : undefined;
    model = opts.model;
    apiKey = opts.apiKey;
    baseUrl = opts.baseUrl;
    if (!provider || !model || !apiKey) {
      process.stderr.write(
        `[codexrev] --non-interactive requires --provider, --model, and --api-key\n`,
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
  }

  // Generate DEK and seal the API key.
  const dek = generateDek();
  await setDek(opts.cwd, dek);

  const cfg = {
    schemaVersion: 1 as const,
    provider: provider!,
    model: model!,
    ...(baseUrl ? { baseUrl } : {}),
    apiKey: encrypt(apiKey!, dek),
    createdAt: nowIso(),
    updatedAt: nowIso(),
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

interface WizardAnswers {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

async function runInteractiveWizard(seed: {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<WizardAnswers> {
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