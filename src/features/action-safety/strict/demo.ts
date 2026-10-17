#!/usr/bin/env node
/**
 * Runs the whole Feature 4 demonstration in a disposable folder and prints the scenario matrix.
 *
 *   npx tsx src/features/action-safety/strict/demo.ts            run, print, delete the disposable folder
 *   npx tsx src/features/action-safety/strict/demo.ts --keep     keep the folder (keys, authority, pack) to inspect it
 *
 * See src/features/action-safety/docs/FEATURE4_DEMO_GUIDE.md.
 */

import { runDemo } from './demoScenarios.js';

const keep = process.argv.includes('--keep');
const run = await runDemo();
const write = (line: string): void => void process.stdout.write(`${line}\n`);
write('\nCODEXREV FEATURE 4 — DEMONSTRATION RESULTS (observed by running the real commands)\n');
for (const s of run.scenarios) {
  write(`#${s.id}  ${s.title}`);
  write(`    setup:    ${s.setup}`);
  write(`    command:  ${s.command}`);
  write(`    expected: ${s.expected}`);
  write(`    observed: ${s.observed}   ${s.ok ? 'OK' : 'MISMATCH'}`);
  write(`    reason:   ${s.reason}\n`);
}
const bad = run.scenarios.filter((s) => !s.ok);
write(bad.length === 0 ? `All ${run.scenarios.length} scenarios behaved as designed.` : `${bad.length} scenario(s) did NOT behave as designed.`);
if (keep) write(`Demo files kept in: ${run.workDir}`);
else run.cleanup();
process.exitCode = bad.length === 0 ? 0 : 1;
