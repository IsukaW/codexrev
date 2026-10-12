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
import { resolve, type ResolverDecision } from '../pipeline/resolverEngine.js';
import { createLLMProvider } from '../pipeline/illmProvider.js';
import type { RoleId, RoleOutput } from '../roles/roleContract.js';
import type { ProviderId } from '../../../core/types.js';

export interface DetectionFixture {
  readonly name: string;
  readonly file: string;
  readonly content: string;
  readonly expectRole: RoleId | null; // which role should flag it, or null for a clean baseline
  readonly urs?: string; // handed to the BA role, for fixtures that are only wrong relative to a requirement
}

// A made-up, non-working key shaped like a live payment-provider key so the model sees a realistic
// hard-coded secret. Split in two so this source file never contains the full pattern — secret
// scanners (e.g. GitHub push protection) match on it and block pushes even for fakes. The two
// halves are joined only inside the fixture file written to the temp repo.
const FAKE_KEY_PREFIX = 'sk_' + 'live_';
const FAKE_KEY_BODY = '51H8xKq2eZvKYlo2C0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

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
  {
    name: 'Swallowed error (empty catch hides a failed write)',
    file: 'saveSettings.ts',
    content: `import { promises as fs } from 'node:fs';

export async function saveSettings(path: string, settings: object): Promise<boolean> {
  try {
    await fs.writeFile(path, JSON.stringify(settings));
  } catch {
    // ignore
  }
  return true; // reports success even when the write failed
}
`,
    expectRole: 'dev',
  },
  {
    name: 'Hard-coded secret in source',
    file: 'mailer.ts',
    content: `export async function sendMail(to: string, body: string) {
  const apiKey = '${FAKE_KEY_PREFIX}${FAKE_KEY_BODY}';
  return fetch('https://api.mailprovider.example/v1/send', {
    method: 'POST',
    headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body }),
  });
}
`,
    expectRole: 'dev',
  },
  {
    name: 'Layering violation (core utility importing from the UI layer)',
    file: 'src/core/formatPrice.ts',
    content: `import { currentTheme } from '../ui/theme';

// core/ is meant to be framework-free; it must not depend on the UI layer
export function formatPrice(cents: number): string {
  const symbol = currentTheme.locale === 'de' ? '€' : '$';
  return \`\${symbol}\${(cents / 100).toFixed(2)}\`;
}
`,
    expectRole: 'architect',
  },
  {
    name: 'Spec mismatch (URS says 30-day trial, code gives 14; plus unrequested behavior)',
    file: 'trial.ts',
    content: `export const TRIAL_DAYS = 14;

export function trialEndsAt(start: Date): Date {
  const end = new Date(start);
  end.setDate(end.getDate() + TRIAL_DAYS);
  return end;
}

// not in the requirements: also e-mails the marketing list on every signup
export function onSignup(email: string, start: Date) {
  console.log('subscribing', email, 'to marketing list');
  return trialEndsAt(start);
}
`,
    urs: `REQ-1: New accounts get a free trial of exactly 30 days from signup.
REQ-2: The system must not send any marketing communication without explicit opt-in.`,
    expectRole: 'ba',
  },
  {
    name: 'Untested risky change (new refund logic, test asserts nothing)',
    file: 'refund.test.ts',
    content: `import { refund } from './refund';

test('refund works', () => {
  refund(100, 0);
  refund(-5, 3);
});
`,
    expectRole: 'qa',
  },
  {
    name: 'Clean baseline #2 (resource released on every path, errors propagated)',
    file: 'readConfig.ts',
    content: `import { promises as fs } from 'node:fs';

export async function readConfig(path: string): Promise<Record<string, unknown>> {
  const handle = await fs.open(path, 'r');
  try {
    const text = await handle.readFile('utf-8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(\`config at \${path} must be a JSON object\`);
    }
    return parsed as Record<string, unknown>;
  } finally {
    await handle.close();
  }
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
    await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await fs.writeFile(path.join(cwd, file), content, 'utf-8');
    await git.add(file);
  }
  return cwd;
}

export interface DetectionResult {
  readonly fixture: DetectionFixture;
  readonly flagged: boolean;
  readonly flaggedBy: readonly RoleId[];
  readonly decision: ResolverDecision; // what the Resolver would actually decide — the real pipeline outcome, unlike `flagged` (any non-pass verdict)
  readonly score: number;
  readonly details: readonly string[]; // one line per non-pass role: verdict, confidence and every finding, so a false positive can be diagnosed
  readonly caughtByExpected: boolean; // the role the fixture targets actually flagged it (stricter than `flagged`)
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
    const result = await runPipeline({ diff, llm, model, cwd, ...(fixture.urs ? { urs: fixture.urs } : {}) });
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

    const details = (Object.values(outputs) as RoleOutput[])
      .filter((o) => o.verdict !== 'pass')
      .map(
        (o) =>
          `${o.role}: ${o.verdict} (conf ${o.confidence}) — ${o.summary}\n` +
          o.findings.map((f) => `      [${f.severity}] ${f.file}:${f.lineStart}-${f.lineEnd} ${f.description}`).join('\n'),
      );

    const resolved = resolve(outputs, DEFAULT_SETTINGS.reviewPipeline.resolverWeights);

    const caughtByExpected = fixture.expectRole !== null && flaggedBy.includes(fixture.expectRole);
    return { fixture, flagged: flaggedBy.length > 0, flaggedBy, decision: resolved.decision, score: resolved.score, details, caughtByExpected, latencyMs };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
