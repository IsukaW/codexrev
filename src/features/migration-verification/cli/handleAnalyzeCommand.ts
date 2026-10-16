/**
 * `migrate` command dispatch (Phase P6). Mirrors handleReviewCommand:
 * subcommand routing, user-facing errors on stderr, explicit exit codes.
 *
 * Exit codes: 0 = plan produced (issues, if any, live inside the plan);
 * 1 = validation or analysis failure; 2 = usage error.
 *
 * Read-only: the analyzed project is only ever read (P1 ReadOnlyFs);
 * the optional --out file must resolve OUTSIDE the project (enforced by
 * validateAnalyzeRequest).
 */

import { promises as fsp } from 'node:fs';
import { CodexrevError } from '../../../utils/errors.js';
import { RequestValidationError } from '../analysis/issues.js';
import { validateAnalyzeRequest } from '../analysis/validateRequest.js';
import { runAnalyzePipeline } from '../analysis/planBuilder.js';
import { renderPlanJson, renderPlanMarkdown } from '../analysis/renderPlan.js';

const USAGE =
  'usage: codexrev migrate analyze --dependency <name> --current-version <v> --target-version <v> ' +
  '[--from <api> --to <api> | --upgrade] [--project-path <dir>] [--format json|markdown] [--out <file>]';

export interface MigrateAnalyzeFlags {
  projectPath?: string;
  dependency?: string;
  currentVersion?: string;
  targetVersion?: string;
  from?: string;
  to?: string;
  upgrade?: boolean;
  format?: 'json' | 'markdown';
  out?: string;
  /** global --print/-p flag — migrate analyze is always non-interactive */
  print?: string;
}

export async function handleMigrateCommand(
  rest: ReadonlyArray<string | number>,
  flags: MigrateAnalyzeFlags,
): Promise<void> {
  const sub = String(rest[0] ?? '');
  switch (sub) {
    case 'analyze':
      return analyzeCommand(flags);
    default:
      console.error(`[codexrev migrate] unknown or missing subcommand: '${sub}'`);
      console.error(USAGE);
      process.exitCode = 2;
  }
}

async function analyzeCommand(flags: MigrateAnalyzeFlags): Promise<void> {
  try {
    const hasRename = flags.from !== undefined || flags.to !== undefined;
    if (hasRename && (flags.from === undefined || flags.to === undefined)) {
      console.error('[codexrev migrate] --from and --to must be provided together');
      process.exitCode = 2;
      return;
    }
    if (hasRename && flags.upgrade === true) {
      console.error('[codexrev migrate] use either --from/--to (api-rename) or --upgrade, not both');
      process.exitCode = 2;
      return;
    }

    const request = await validateAnalyzeRequest({
      projectPath: flags.projectPath ?? process.cwd(),
      technology: 'node',
      dependencyName: flags.dependency,
      currentVersion: flags.currentVersion,
      targetVersion: flags.targetVersion,
      migration: hasRename
        ? { kind: 'api-rename', from: flags.from, to: flags.to }
        : { kind: 'dependency-upgrade', package: flags.dependency },
      outputFormat: flags.format ?? 'json',
      outPath: flags.out,
    });

    const { plan } = await runAnalyzePipeline(request);
    const output = request.outputFormat === 'markdown' ? renderPlanMarkdown(plan) : renderPlanJson(plan);

    if (request.outPath !== undefined) {
      await fsp.writeFile(request.outPath, output, 'utf-8');
      console.error(
        `[codexrev migrate] plan written to ${request.outPath} (${plan.tasks.length} tasks, ${plan.issues.length} issues)`,
      );
    } else {
      process.stdout.write(output);
    }
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof RequestValidationError) {
      for (const issue of err.issues) {
        console.error(`[codexrev migrate] [${issue.severity}] ${issue.code}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }
    if (err instanceof CodexrevError) {
      // expected user-facing failures (unsupported project, unreadable path)
      console.error(`[codexrev migrate] ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
