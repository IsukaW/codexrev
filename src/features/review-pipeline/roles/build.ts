/**
 * Build Analyst role. The only role that isn't an LLM call — it asks the
 * toolchain registry (src/core/toolchains) what the project is built with,
 * runs those checks, and normalizes the output into `Finding[]` so the rest
 * of the pipeline doesn't need to know this role is different.
 *
 * Detected (see planBuildTargets): tsconfig.json → tsc, pom.xml → mvn
 * test-compile, build.gradle(.kts) → gradle classes testClasses, go.mod →
 * go vet, Cargo.toml → cargo check, pyproject.toml → mypy. A build command
 * in settings (`toolchain.build`) replaces detection, which is how any
 * other language or setup is covered.
 *
 * Polyglot repos can trip more than one marker — we run all of them and
 * pool the findings. Resolver gives Build failures their own weight
 * (0.4), separate from BA/Architect/Dev/QA/PM.
 *
 * A tool that is missing or cannot run here is reported as a medium
 * "Could not run" finding (verdict flag), never as a silent pass and never
 * as a code defect.
 *
 * Fallback for projects with no build configuration: the changed files are
 * syntax-checked with each language's own checker (node --check, python
 * compile, javac, ruby -c, php -l, bash -n, gofmt, cc) — see
 * core/toolchains/syntax.ts. A file nothing can check is reported as not
 * verified (flag), never passed silently.
 */

import path from 'node:path';
import {
  planModules,
  runSyntaxChecks,
  runToolchainCommand,
  stripBuildToolNoise,
} from '../../../core/toolchains/index.js';
import type { Finding, RoleOutput } from './roleContract.js';
import type { RoleRunContext } from '../pipeline/roleRunContext.js';

export {
  parseCargoCheck,
  parseGoVet,
  parseJavac,
  parseMaven,
  parseMypy,
  parseNodeCheck,
  parseTsc,
  parseJsonc,
  resolveTscReferencedProjects,
  findLocalTscBinary,
} from '../../../core/toolchains/index.js';

// Changed files no build covers: syntax-check them with each language's own checker
// (core/toolchains/syntax.ts). Null when none of them is source code.
async function runSyntaxFallback(
  ctx: RoleRunContext,
  changed: readonly string[],
): Promise<{ findings: Finding[]; summary: string } | null> {
  const report = await runSyntaxChecks(ctx.cwd, changed, { sandbox: ctx.toolchain?.sandbox });
  if (!report) return null;

  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'id'>): void => {
    findings.push({ id: `build-${findings.length + 1}`, ...f });
  };
  for (const d of report.diagnostics) {
    add({
      severity: d.severity === 'error' ? 'high' : 'medium',
      file: d.file,
      lineStart: d.line,
      lineEnd: d.line,
      description: `${d.label}: ${d.message}`,
    });
  }
  for (const c of report.couldNotRun) {
    add({
      severity: 'medium',
      file: c.files[0]!,
      lineStart: 1,
      lineEnd: 1,
      description: `Could not run "${c.label}" on ${listFiles(c.files)}: ${c.reason}`,
    });
  }
  if (report.unverified.length > 0) {
    add({
      severity: 'medium',
      file: report.unverified[0]!,
      lineStart: 1,
      lineEnd: 1,
      description:
        `Could not run a syntax check on ${listFiles(report.unverified)}: there is no build configuration and no built-in checker for ` +
        `${[...new Set(report.unverified.map((f) => path.extname(f)))].join(', ')} files — set toolchain.build in .codexrev/settings.json to check them.`,
    });
  }

  const parts = report.checks.map((c) => `${c.label}: ${c.errors} error(s) in ${c.files} file(s)`);
  if (report.couldNotRun.length > 0)
    parts.push(`could not run: ${report.couldNotRun.map((c) => c.label).join(', ')}`);
  if (report.unverified.length > 0) parts.push(`not verified: ${report.unverified.length} file(s)`);
  const notes = report.notes.length > 0 ? ` ${report.notes.join(' ')}` : '';
  return {
    findings,
    summary: `Syntax check of the changed files (fallback — no build configuration found): ${parts.join('; ')}.${notes}`,
  };
}

function listFiles(files: readonly string[]): string {
  return files.length <= 3
    ? files.join(', ')
    : `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`;
}

const outputTail = (output: string): string =>
  (stripBuildToolNoise(output) || output.trim() || 'command failed with no output').slice(-600);

export async function runBuildRole(ctx: RoleRunContext): Promise<RoleOutput> {
  // each changed file is checked by the build of the module it belongs to (core/toolchains/modules.ts);
  // deleted files still pick their module (deleting a class can break the build) but are not syntax-checked
  const deleted = new Set(ctx.diff.files.filter((f) => f.status === 'deleted').map((f) => f.path));
  const plan = await planModules(
    ctx.cwd,
    ctx.diff.files.map((f) => f.path),
    ctx.toolchain,
  );
  const leftover = plan.uncovered.filter((f) => !deleted.has(f));
  const fallback = leftover.length > 0 ? await runSyntaxFallback(ctx, leftover) : null;
  const targetCount = plan.modules.reduce((n, m) => n + m.targets.length, 0);

  if (targetCount === 0) {
    if (fallback) {
      const verdict = fallback.findings.some((f) => f.severity === 'high')
        ? 'block'
        : fallback.findings.length > 0
          ? 'flag'
          : 'pass';
      return {
        role: 'build',
        verdict,
        findings: fallback.findings,
        summary: fallback.summary,
        confidence: 1,
      };
    }
    return {
      role: 'build',
      verdict: 'pass',
      findings: [],
      summary:
        'No recognized build configuration found (tsconfig.json, pom.xml, build.gradle, go.mod, Cargo.toml, pyproject.toml, or toolchain.build in settings), and no source files in this diff to syntax-check — nothing for the Build role to check.',
      confidence: 1,
    };
  }

  const findings: Finding[] = [];
  const toolSummaries: string[] = [];
  let sawExecFailure = false;
  const couldNotRun = (target: { label: string; marker: string }, why: string): void => {
    sawExecFailure = true;
    findings.push({
      id: `build-${findings.length + 1}`,
      severity: 'medium',
      file: target.marker,
      lineStart: 1,
      lineEnd: 1,
      description: `Could not run "${target.label}" in this environment: ${why}`,
    });
  };

  for (const module of plan.modules) {
    const moduleCwd = path.join(ctx.cwd, module.dir);
    // findings name repo-relative files, whichever module folder the tool ran in
    const inRepo = (file: string): string =>
      module.dir === '.' || path.isAbsolute(file) ? file : path.posix.join(module.dir, file);
    for (const moduleTarget of module.targets) {
      const target =
        module.dir === '.'
          ? moduleTarget
          : {
              ...moduleTarget,
              label: `${moduleTarget.label} (${module.dir})`,
              marker: inRepo(moduleTarget.marker),
            };
      if (target.unavailable) {
        couldNotRun(target, target.unavailable);
        toolSummaries.push(`${target.label}: could not run (not installed)`);
        continue;
      }

      let errorCount = 0;
      let warnCount = 0;
      let failedToRun = 0;
      for (const command of target.commands) {
        const result = await runToolchainCommand(command, moduleCwd, {
          timeoutMs: target.timeoutMs,
          sandbox: ctx.toolchain?.sandbox,
        });
        const diagnostics = target
          .parse(result.output, moduleCwd)
          .map((d) => ({ ...d, file: inRepo(d.file) }));

        if (result.timedOut) {
          failedToRun++;
          couldNotRun(
            target,
            `timed out after ${Math.round(target.timeoutMs / 1000)}s (set toolchain.buildTimeoutMs in settings to allow longer).`,
          );
          continue;
        }
        if (result.code !== 0 && diagnostics.length === 0) {
          // The tool exited non-zero but produced nothing we recognize as a
          // diagnostic — most likely it isn't installed / reachable here, or a
          // dependency could not be downloaded. That's an infra gap, not
          // evidence the code is broken.
          failedToRun++;
          couldNotRun(
            target,
            `${outputTail(result.output)}${/Operation not permitted/i.test(result.output) ? ' (the OS sandbox blocked the command)' : ''}.`,
          );
          continue;
        }

        for (const d of diagnostics) {
          findings.push({
            id: `build-${findings.length + 1}`,
            severity: d.severity === 'error' ? 'high' : 'medium',
            file: d.file,
            lineStart: d.line,
            lineEnd: d.line,
            description: d.code
              ? `${target.label} ${d.code}: ${d.message}`
              : `${target.label}: ${d.message}`,
          });
        }
        errorCount += diagnostics.filter((d) => d.severity === 'error').length;
        warnCount += diagnostics.filter((d) => d.severity === 'warning').length;
      }
      toolSummaries.push(
        failedToRun === target.commands.length
          ? `${target.label}: could not run`
          : `${target.label}: ${errorCount} error(s), ${warnCount} warning(s)${target.note ?? ''}`,
      );
    }
  }
  if (fallback) findings.push(...fallback.findings);
  const numbered = findings.map((f, i) => ({ ...f, id: `build-${i + 1}` }));
  const extra = [
    ...(fallback ? [` ${fallback.summary}`] : []),
    ...(plan.skipped.length > 0
      ? [
          ` ${plan.skipped.length} more module(s) not checked (limit reached): ${plan.skipped.join(', ')}.`,
        ]
      : []),
  ].join('');

  const hasErrors = numbered.some((f) => f.severity === 'high');
  const verdict: RoleOutput['verdict'] = hasErrors
    ? 'block'
    : sawExecFailure || numbered.length > 0
      ? 'flag'
      : 'pass';

  return {
    role: 'build',
    verdict,
    findings: numbered,
    summary: `Ran ${targetCount} build check(s): ${toolSummaries.join('; ')}.${extra}`,
    confidence: 1,
  };
}
