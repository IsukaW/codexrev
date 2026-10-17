#!/usr/bin/env node
/**
 * Runs the Feature 4 research evaluation and writes a machine-readable result file.
 *
 *   npx tsx src/features/action-safety/strict/evaluate.ts [--runs 3] [--timing 10] [--out <file.json>]
 *
 * Defaults: 3 repetitions of the 14 demonstration scenarios, 10 timed runs per operation, and the result written to
 * src/features/action-safety/docs/evaluation-results.json. Everything is built in disposable folders; nothing in the
 * project's Git history is touched. See docs/FEATURE4_EVALUATION.md.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runEvaluation, summarize } from './evaluation.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
};
const positive = (name: string, fallback: string): number => {
  const n = Number(arg(name, fallback));
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`--${name} must be a whole number from 1 to 100`);
  return n;
};

const out = arg('out', fileURLToPath(new URL('../docs/evaluation-results.json', import.meta.url)));
const result = await runEvaluation({ demoRepetitions: positive('runs', '3'), timingRuns: positive('timing', '10'), log: (l) => void process.stderr.write(`${l}\n`) });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
for (const line of summarize(result)) process.stdout.write(`${line}\n`);
process.stdout.write(`\nMachine-readable results written to ${out}\n`);
const ok = result.functional.correctPerRepetition.every((c) => c === result.functional.scenarioCount) && result.authorization.attacksAllowed === 0 && result.evidenceIntegrity.tamperDetected === result.evidenceIntegrity.tamperCount;
process.exitCode = ok ? 0 : 1;
