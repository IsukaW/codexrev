/**
 * `safety` command dispatch: assess | verify | history. Mirrors
 * handleReviewCommand: switch on the subcommand, print usage on bad input,
 * turn expected failures into one line.
 *
 * Exit codes (documented in exitCodes.ts): 0 only for a completed ALLOW;
 * 10 ESCALATE, 11 BLOCK, 1 invalid input, 2 usage, 3 incomplete or not
 * implemented, 4 internal error. Nothing here executes the proposed action.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CodexrevError } from '../../../utils/errors.js';
import { SafetyUsageError } from './assessmentInput.js';
import { renderAssessment } from './assessmentReport.js';
import { SAFETY_EXIT_CODES, exitCodeForOutcome } from './exitCodes.js';
import { detectRenderOptions } from './terminalStyle.js';
import { runAssessmentSession } from './runAssessment.js';

// re-exported so existing imports keep working
export { SAFETY_EXIT_CODES } from './exitCodes.js';
export { describeInterpretation } from '../interpretation/describe.js';

export interface SafetyFlags {
  action?: unknown;
  target?: unknown;
  input?: unknown;
  diff?: unknown;
  output?: unknown;
  file?: unknown;
}

export async function handleSafetyCommand(
  rest: ReadonlyArray<string | number>,
  flags: SafetyFlags,
  cwd: string = process.cwd(),
): Promise<void> {
  const sub = String(rest[0] ?? '');
  try {
    switch (sub) {
      case 'assess':
        return await assessCommand(flags, cwd);
      case 'verify':
        return await verifyCommand(flags, cwd);
      case 'history':
        return historyCommand();
      case '':
        printSafetyUsage();
        process.exitCode = SAFETY_EXIT_CODES.usage;
        return;
      default:
        console.error(`Unknown safety subcommand: ${sub}`);
        printSafetyUsage();
        process.exitCode = SAFETY_EXIT_CODES.usage;
    }
  } catch (err) {
    if (err instanceof SafetyUsageError) {
      console.error(`[codexrev safety] ${err.message}`);
      printSafetyUsage();
      process.exitCode = SAFETY_EXIT_CODES.usage;
      return;
    }
    // expected user-facing failures (bad input file), not bugs
    if (err instanceof CodexrevError) {
      console.error(`[codexrev safety] ${err.message}`);
      process.exitCode = SAFETY_EXIT_CODES.invalidInput;
      return;
    }
    throw err;
  }
}

async function assessCommand(flags: SafetyFlags, cwd: string): Promise<void> {
  const result = await runAssessmentSession({ cwd, flags });
  // color, Unicode and width come from the terminal and environment (NO_COLOR, FORCE_COLOR, TTY)
  for (const line of renderAssessment(result, detectRenderOptions())) console.log(line);
  process.exitCode = exitCodeForOutcome(result.assessment);
}

async function verifyCommand(flags: SafetyFlags, cwd: string): Promise<void> {
  if (typeof flags.file !== 'string' || flags.file.trim() === '') {
    throw new SafetyUsageError('--file <evidence-pack-path> is required.');
  }
  const target = path.resolve(cwd, flags.file.trim());
  let isFile = false;
  try {
    isFile = (await fs.stat(target)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    console.error(`[codexrev safety] evidence pack not found: ${target}`);
    process.exitCode = SAFETY_EXIT_CODES.invalidInput;
    return;
  }
  console.log(`Evidence Pack: ${target}`);
  console.log('Signature verification is not implemented yet. This file was NOT verified: no signature check ran, so do not treat it as authentic.');
  process.exitCode = SAFETY_EXIT_CODES.notImplemented;
}

function historyCommand(): void {
  console.log('Audit history is not connected yet. No assessments are recorded or shown, and none were invented.');
  process.exitCode = SAFETY_EXIT_CODES.notImplemented;
}

export function printSafetyUsage(): void {
  console.error('usage: codexrev safety assess --action <type> --target <environment> [--input <path>] [--diff <ref>] [--output <path>]');
  console.error('       codexrev safety verify --file <evidence-pack-path>');
  console.error('       codexrev safety history');
}
