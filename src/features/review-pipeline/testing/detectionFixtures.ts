// Shared fixtures/harness for evaluateReviewPipeline.ts (the results-table script)
// and liveDetection.test.ts (opt-in real-model integration test) so both agree
// on what "the synthetic diffs" actually are.
//
// Fixtures are deliberately small, single-issue — this is not the Juliet Test
// Suite / NIST SARD corpus, that gap is tracked in docs/review-pipeline-evaluation-results.md.

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
  readonly expectRole: RoleId | null; // which role should flag it, or null for a clean baseline
}

export const DETECTION_FIXTURES: readonly DetectionFixture[] = [
  {
    name: 'Cross-boundary DB access (frontend calling database directly)',
    file: 'src/frontend/UserProfile.tsx',
    content: `import { Pool } from 'pg';

const pool = new Pool();

export async function loadUserProfile(id: string) {
  // frontend component querying the database directly, bypassing the backend service boundary
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}
`,
    expectRole: 'architect',
  },
  {
    name: 'Unreleased resource (DB connection never closed)',
    file: 'reportExporter.ts',
    content: `import { Pool } from 'pg';

export async function exportReport(pool: Pool, id: string) {
  const client = await pool.connect();
  const result = await client.query('SELECT * FROM reports WHERE id = $1', [id]);
  // client is never released back to the pool on any path, including this early return.
  return result.rows;
}
`,
    expectRole: 'architect',
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

// separate fixture for the breaker-builder convergence measurement — one
// deterministic-fixable finding (TS7006)
export const CONVERGENCE_FIXTURE_FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2),
  'greet.ts': `export function greet(name) {\n  return "Hello, " + name;\n}\n`,
};

// writes files to a fresh tmp git repo and stages them, returns the realpath'd root
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

// 30 min timeout — a local model on modest hardware can be genuinely slow, not
// hung. The OpenAI-compat SDK's fixed 10-min default was killing legit
// in-progress requests against a local 12B model, so this should only ever
// fire for something actually stuck.
const FIXTURE_TIMEOUT_MS = 30 * 60_000;

// builds an ILLMProvider for providerId/model, independent of any saved settings
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

// runs the full pipeline against one fixture with a real provider, cleans up the tmp repo after
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

    // if a role errored mid-run the aggregator has fewer than six outputs,
    // sometimes zero — reading "flagged" off that without checking outcome
    // would quietly report a crash as a clean pass, which defeats the point
    // of this harness. throw loudly instead.
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
