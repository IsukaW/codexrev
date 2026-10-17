/**
 * `codexrev safety assess --strict`: the main-CLI connection to the EXISTING strict assessment.
 *
 * It finds the administrator-signed grant that `codexrev init` saved for this project
 * (`.codexrev/authorization.json`), builds the options for the existing strict assessment from it, runs that assessment
 * and prints its report. There is no second authorization implementation here, and no fall-back: if the project has no
 * usable signed authorization the command stops with a message and a non-zero exit code, it never uses the input file's
 * claims. This only ASSESSES; it does not intercept or run anything.
 *
 * Exit codes follow the safety command: 0 ALLOW, 10 ESCALATE, 11 BLOCK, 1 invalid input, 2 usage, 3 authorization not established.
 */

import path from 'node:path';
import { runStrictAssessment } from '../strict/strictAssess.js';
import { StrictCliError } from '../strict/files.js';
import { strictOptionsFromProject } from '../strict/projectAuthorization.js';
import { renderStrictAssessment } from '../strict/strictReport.js';
import { SAFETY_EXIT_CODES } from './exitCodes.js';
import { SafetyUsageError } from './assessmentInput.js';
import type { SafetyFlags } from './handleSafetyCommand.js';

const text = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() !== '' ? x.trim() : undefined);

export interface StrictAssessDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** test hooks passed through to the strict assessment (interpretation off, Git runner) */
  hooks?: Partial<Pick<Parameters<typeof runStrictAssessment>[0], 'interpreter' | 'runner' | 'policy'>>;
}

export async function strictAssessCommand(flags: SafetyFlags, cwd: string, deps: StrictAssessDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const action = text(flags.action);
  const environment = text(flags.target);
  if (!action || !environment) throw new SafetyUsageError('--strict needs --action <type> and --target <environment>.');
  if (text(flags.diff) !== undefined || text(flags.output) !== undefined) throw new SafetyUsageError('--diff and --output are not supported with --strict.');
  try {
    const options = await strictOptionsFromProject(
      cwd,
      { action, environment, target: text(flags.app) ?? (path.basename(path.resolve(cwd)) || 'project'), ...(text(flags.input) ? { inputFile: path.resolve(cwd, text(flags.input) as string) } : {}), ...(deps.now ? { now: deps.now } : {}) },
      text((deps.env ?? process.env).CODEXREV_TRUST_ROOT_SHA256),
    );
    const result = await runStrictAssessment({ ...options, ...(deps.hooks ?? {}) });
    for (const line of renderStrictAssessment(result)) out(line);
    return result.exitCode;
  } catch (e) {
    if (e instanceof StrictCliError) {
      err(`[codexrev safety] ${e.message}`);
      return SAFETY_EXIT_CODES.incomplete;
    }
    throw e;
  }
}
