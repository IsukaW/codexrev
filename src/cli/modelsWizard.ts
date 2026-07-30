/**
 * Codexrev — bridge for the interactive `models add` wizard.
 *
 * Loads existing providers, renders the Ink wizard, and saves the result
 * (new provider + model, or model added to existing provider).
 */

import { render } from 'ink';
import React from 'react';
import { ModelsWizard } from '../ui/ModelsWizard.js';
import type { ModelWizardResult } from '../ui/ModelsWizard.js';
import { listProviders, addProvider, setProviderApiKey, addModel } from '../config/models.js';
import type { ProviderConfigEntry } from '../config/models.js';
import { getDek, setDek } from '../security/keychain.js';
import { generateDek, encrypt } from '../security/secrets.js';
import { ConfigError } from '../utils/errors.js';

export async function runModelsWizard(cwd: string): Promise<void> {
  // Load existing providers for the wizard to display.
  let existingProviders: ProviderConfigEntry[] = [];
  try {
    existingProviders = await listProviders(cwd);
  } catch {
    // No config yet — that's fine, wizard will handle it.
  }

  // Ensure we have a DEK for encryption.
  let dek = await getDek(cwd);
  if (!dek) {
    dek = generateDek();
    await setDek(cwd, dek);
  }

  // Run the interactive wizard.
  const result = await runInteractiveModelsWizard(existingProviders);

  // ── Save provider (if new) ──
  if (result.newProvider) {
    const { name, vendor, baseUrl, apiKey } = result.newProvider;
    try {
      await addProvider(cwd, { name, vendor, baseUrl });
      console.log(`✓ Added provider '${name}' (${vendor})${baseUrl ? ' → ' + baseUrl : ''}`);

      if (apiKey && dek) {
        await setProviderApiKey(cwd, name, apiKey, dek);
        console.log('  API key encrypted and saved.');
      }
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  }

  // ── Save model ──
  const providerName = result.newProvider
    ? result.newProvider.name
    : result.existingProvider!;

  try {
    const saved = await addModel(cwd, providerName, {
      id: result.model.id,
      name: result.model.name,
      url: result.model.url,
      toolCalling: result.model.toolCalling,
      vision: result.model.vision,
      maxInputTokens: result.model.maxInputTokens,
      maxOutputTokens: result.model.maxOutputTokens,
    });

    const caps: string[] = [];
    if (saved.toolCalling) caps.push('tools');
    if (saved.vision) caps.push('vision');
    const capStr = caps.length ? `  [${caps.join(', ')}]` : '';
    const tokens = saved.maxInputTokens
      ? `  ${saved.maxInputTokens}in/${saved.maxOutputTokens ?? '?'}out`
      : '';

    console.log(`✓ Added model '${saved.id}' to provider '${providerName}'${saved.default ? ' (active)' : ''}`);
    if (capStr || tokens) console.log(`  ${capStr}${tokens}`);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

// ── Ink bridge ──────────────────────────────────────────────────────

async function runInteractiveModelsWizard(
  existingProviders: ProviderConfigEntry[],
): Promise<ModelWizardResult> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const app = render(
      React.createElement(ModelsWizard, {
        existingProviders,
        onSubmit: (result) => {
          resolved = true;
          app.unmount();
          resolve(result);
        },
        onCancel: () => {
          resolved = true;
          app.unmount();
          console.log('[codexrev] models add cancelled');
          process.exit(130);
        },
      }),
    );
    app.waitUntilExit().then(() => {
      if (!resolved) reject(new Error('wizard exited without submitting'));
    });
  });
}
