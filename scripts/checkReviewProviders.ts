#!/usr/bin/env -S npx tsx
/**
 * Codexrev — Phase 2 throwaway verification script (review-pipeline).
 *
 * Not part of `npm test` / CI — this is the manual check called for by
 * Phase 2's Definition of Done in the Feature 2 dev guide: send one
 * prompt through each of the 6 required providers via the same
 * `ILLMProvider` call shape, skipping cloud providers that have no
 * configured key, and report pass/fail per provider.
 *
 * Usage:
 *   npx tsx scripts/checkReviewProviders.ts
 *
 * For Ollama / LM Studio to actually respond (rather than report
 * "local server unreachable"), start the respective daemon first and
 * make sure the default model is pulled/loaded.
 */

import { loadSettings } from '../src/config/loader.js';
import { providerMeta, PROVIDER_IDS } from '../src/providers/registry.js';
import { createLLMProvider } from '../src/features/review-pipeline/pipeline/illmProvider.js';
import type { GenerateRequest } from '../src/core/types.js';

async function main(): Promise<void> {
  const settings = await loadSettings();

  console.log(`Checking ${PROVIDER_IDS.length} providers through ILLMProvider...\n`);

  for (const id of PROVIDER_IDS) {
    const meta = providerMeta(id);
    const configuredKey =
      settings.providers[id]?.apiKey || (meta.envKeyVar ? process.env[meta.envKeyVar] : undefined);

    if (meta.requiresApiKey && !configuredKey) {
      console.log(`⚪ ${id.padEnd(10)} skipped — no API key configured (${meta.envKeyVar})`);
      continue;
    }

    const llm = createLLMProvider(settings, id);
    const req: GenerateRequest = {
      model: meta.defaultModel,
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Reply with exactly: OK' }] }],
      maxOutputTokens: 16,
    };

    try {
      const res = await llm.generate(req);
      const text = res.message.parts
        .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
        .map((p) => p.text)
        .join('')
        .trim();
      console.log(`✅ ${id.padEnd(10)} responded via ILLMProvider (id=${llm.id}): "${text.slice(0, 60)}"`);
    } catch (err) {
      console.log(`❌ ${id.padEnd(10)} failed: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exitCode = 1;
});
