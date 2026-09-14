/**
 * Codexrev — live-detection integration test (review-pipeline).
 *
 * Phase 10's "New" bullet 2: "Integration tests: run the full pipeline
 * against small synthetic diffs with known injected issues (SQL
 * injection, buffer overflow, off-by-one), confirming the Architect/QA roles
 * catch them." That is a genuinely different kind of test from
 * everything else in this suite — every other test here uses a fake
 * `ILLMProvider` that scripts its own response, which proves the
 * pipeline's *plumbing* works but can never prove a role actually
 * *detects* anything (a fake provider that always says "found it"
 * would pass trivially and prove nothing).
 *
 * So this file is opt-in, gated behind `CODEXREV_LIVE_LLM_TESTS=1`, and
 * skipped (not failed) otherwise — `npm test` stays fast, deterministic,
 * and requires no live model, matching every other file here. Run it
 * for real with a local Ollama daemon (default) or another configured
 * provider:
 *
 *   CODEXREV_LIVE_LLM_TESTS=1 npx vitest run tests/features/review-pipeline/liveDetection.test.ts
 *   CODEXREV_LIVE_LLM_TESTS=1 CODEXREV_LIVE_PROVIDER=openai CODEXREV_LIVE_MODEL=gpt-4o-mini npx vitest run tests/features/review-pipeline/liveDetection.test.ts
 *
 * Fixtures are shared with `scripts/evaluateReviewPipeline.ts` (see
 * `detectionFixtures.ts`) — that script is the tool for the actual
 * accuracy/false-positive/latency/convergence-rate results table this
 * phase's Definition of Done asks for; this file is the codified,
 * repeatable "does detection still work" check.
 */

import { describe, expect, it } from 'vitest';
import { DETECTION_FIXTURES, runDetectionFixture } from '../../../src/features/review-pipeline/testing/detectionFixtures.js';
import type { ProviderId } from '../../../src/core/types.js';

const LIVE = process.env.CODEXREV_LIVE_LLM_TESTS === '1';
const providerId = (process.env.CODEXREV_LIVE_PROVIDER ?? 'ollama') as ProviderId;
const modelName = process.env.CODEXREV_LIVE_MODEL ?? (providerId === 'ollama' ? 'gemma4:12b-mlx' : 'gpt-4o-mini');

describe.skipIf(!LIVE)('live detection against a real provider (opt-in — set CODEXREV_LIVE_LLM_TESTS=1)', () => {
  for (const fixture of DETECTION_FIXTURES) {
    const expectation =
      fixture.expectRole === null
        ? 'flags nothing (clean baseline — false-positive check)'
        : `is caught by ${fixture.expectRole}`;

    // Generous timeout — a real model, especially a local one, can take
    // several minutes for a single six-role scan (see this phase's own
    // measured results in docs/review-pipeline-evaluation-results.md).
    it(
      `${fixture.name} — ${expectation}`,
      async () => {
        const result = await runDetectionFixture(fixture, providerId, modelName);
        if (fixture.expectRole === null) {
          expect(result.flagged, `expected no role to flag a clean diff, but got: ${result.flaggedBy.join(', ')}`).toBe(false);
        } else {
          expect(result.flagged, `expected ${fixture.expectRole} (or another role) to flag this, but every role passed`).toBe(true);
        }
      },
      10 * 60_000,
    );
  }
});

// No separate "proves it's skipped" test here — asserting on
// `CODEXREV_LIVE_LLM_TESTS` would itself fail the moment someone sets
// it to intentionally run the suite above. `describe.skipIf` reporting
// this whole block as skipped in a normal `npm test` run (no env var
// set) is the proof; see the CI/default run's own test output.
