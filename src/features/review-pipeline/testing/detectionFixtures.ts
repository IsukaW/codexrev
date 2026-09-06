/**
 * Codexrev — review pipeline evaluation fixtures & harness.
 *
 * Shared between `scripts/evaluateReviewPipeline.ts` (the standalone script that
 * produces the results-table numbers for the write-up) and
 * `tests/features/review-pipeline/liveDetection.test.ts` (the opt-in,
 * real-model integration test called for by Phase 10's "New" bullet
 * 2 — "confirming the Sec/QA roles catch them"). Defined once here so
 * the two never drift apart on what "the synthetic diffs" actually are.
 *
 * Every fixture is small and single-issue on purpose — this is not (and
 * does not claim to be) the Juliet Test Suite / NIST SARD corpus (see
 * `docs/review-pipeline-evaluation-results.md` for that gap, tracked
 * explicitly rather than silently skipped).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { DEFAULT_SETTINGS } from '../../../config/schema.js';
import { readDiff } from '../pipeline/diffReader.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { createLLMProvider } from '../pipeline/illmProvider.js';
import type { RoleId } from '../roles/roleContract.js';
import type { ProviderId } from '../../../core/types.js';

export interface DetectionFixture {
  readonly name: string;
  readonly file: string;
  readonly content: string;
  /** Which role is expected to flag it (verdict !== 'pass'), or null for a clean baseline (expected to stay all-pass). */
  readonly expectRole: RoleId | null;
}

export const DETECTION_FIXTURES: readonly DetectionFixture[] = [
  {
    name: 'SQL injection',
    file: 'app.ts',
    content: `export function getUser(db: { query: (sql: string) => unknown }, id: string) {
  const q = "SELECT * FROM users WHERE id=" + id;
  return db.query(q);
}
`,
    expectRole: 'sec',
  },
  {
    name: 'Buffer overflow (unchecked write length)',
    file: 'packet.ts',
    content: `export function writeHeader(target: Buffer, header: string): void {
  // header can exceed target's length — no bounds check before writing.
  target.write(header, 0, 'utf-8');
}
`,
    expectRole: 'sec',
  },
  {
    name: 'Off-by-one (inclusive bound past array end)',
    file: 'list.ts',
    content: `export function sumFirstN(values: number[], n: number): number {
  let total = 0;
  for (let i = 0; i <= n; i++) {
    total += values[i];
  }
  return total;
}
`,
    expectRole: 'qa',
  },
  {
    name: 'Clean baseline (no injected issue)',
    file: 'math.ts',
    content: `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`,
    expectRole: null,
  },
];

/** A separate fixture for the Breaker-Builder convergence measurement — one deterministic-fixable finding (TS7006). */
export const CONVERGENCE_FIXTURE_FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2),
  'greet.ts': `export function greet(name) {\n  return "Hello, " + name;\n}\n`,
};

/** Writes `files` to a fresh tmp git repo and stages them. Returns the realpath'd repo root. */
export async function makeFixtureRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-phase10-'));
  const cwd = await fs.realpath(raw); // avoid a /tmp→/private/tmp symlink mismatch against git's resolved repo root
  const git = simpleGit({ baseDir: cwd });
  await git.init();
  await git.addConfig('user.email', 'phase10-eval@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Review Pipeline Eval');
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(cwd, file), content, 'utf-8');
    await git.add(file);
  }
  return cwd;
}

export interface DetectionResult {
  readonly fixture: DetectionFixture;
  readonly flagged: boolean;
  readonly flaggedBy: readonly RoleId[];
  readonly latencyMs: number;
}

/**
 * Generous per-request timeout for this harness's own calls — a local
 * model (the default target) can be genuinely slow, not hung, on
 * modest hardware. Reported live: the OpenAI-compat SDK's fixed 10-min
 * default killed legitimately-in-progress requests against a local 12B
 * model. `ContentGeneratorConfig.timeoutMs` (added specifically for
 * this) overrides it; 30 min is deliberately generous rather than
 * tightly tuned, since a timeout here should only ever fire for an
 * actually-hung request, not a slow-but-working one.
 */
const FIXTURE_TIMEOUT_MS = 30 * 60_000;

/** Builds an `ILLMProvider` targeting `providerId`/`model`, independent of any locally saved settings. */
export function fixtureLlmProvider(providerId: ProviderId, model: string) {
  return createLLMProvider({
    ...DEFAULT_SETTINGS,
    provider: providerId,
    providers: {
      ...DEFAULT_SETTINGS.providers,
      [providerId]: { provider: providerId, model, timeoutMs: FIXTURE_TIMEOUT_MS },
    },
  });
}

/** Runs the full six-role pipeline against one detection fixture with a REAL provider. Cleans up its tmp repo before returning. */
export async function runDetectionFixture(
  fixture: DetectionFixture,
  providerId: ProviderId,
  model: string,
): Promise<DetectionResult> {
  const cwd = await makeFixtureRepo({ [fixture.file]: fixture.content });
  try {
    const llm = fixtureLlmProvider(providerId, model);
    const diff = await readDiff(cwd);

    const start = Date.now();
    const result = await runPipeline({ diff, llm, model, cwd });
    const latencyMs = Date.now() - start;

    // A pipeline that didn't complete (a role errored, e.g. the model
    // was unloaded/unreachable mid-run) leaves the aggregator with
    // FEWER role outputs than six — sometimes zero. Reading "flagged"
    // off that partial set without checking `outcome` first would
    // silently report a crash as a clean pass (an empty output set has
    // no non-'pass' verdicts to find) — exactly the kind of fabricated
    // "it works" result this whole harness exists to avoid. Throw
    // instead, loudly, with the real cause attached.
    if (result.outcome !== 'completed') {
      const detail = result.outcome === 'errored' ? `: ${(result.error as Error | undefined)?.message ?? String(result.error)}` : '';
      throw new Error(
        `Pipeline did not complete for fixture "${fixture.name}" (outcome: ${result.outcome}, ${result.ranRoles.length}/6 roles ran)${detail}`,
      );
    }

    const outputs = result.aggregator.toJSON().roleOutputs;
    const flaggedBy = (Object.values(outputs) as Array<{ role: RoleId; verdict: string }>)
      .filter((o) => o.verdict !== 'pass')
      .map((o) => o.role);

    return { fixture, flagged: flaggedBy.length > 0, flaggedBy, latencyMs };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
