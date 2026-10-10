/**
 * Plain-ANSI console output for `codexrev review scan`, same hand-rolled
 * palette style as src/cli/help.ts (no chalk, colors off when not a TTY).
 * Non-interactive mode only — interactive mode renders the same info inside
 * the persistent ReviewSessionView Ink tree instead.
 */

import { ROLE_LABELS, type RoleOutput } from '../roles/roleContract.js';
import type { PipelineRunResult } from '../pipeline/orchestrator.js';
import { RESOLVER_DECISION_LABELS, type ResolverResult } from '../pipeline/resolverEngine.js';
import type { BreakerBuilderResult, FixAttemptRecord } from '../pipeline/breakerBuilderLoop.js';
import type { ReportPaths } from './reportRenderer.js';

const PALETTE = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
} as const;

const NO_COLOR = { reset: '', bold: '', dim: '', green: '', yellow: '', red: '' } as const;

function colors() {
  return process.stdout.isTTY ? PALETTE : NO_COLOR;
}

const VERDICT_COLOR: Record<RoleOutput['verdict'], keyof typeof PALETTE> = {
  pass: 'green',
  flag: 'yellow',
  block: 'red',
};

const VERDICT_ICON: Record<RoleOutput['verdict'], string> = {
  pass: '✔',
  flag: '⚑',
  block: '✖',
};

/** One colored line per role, printed as soon as that role finishes. */
export function printVerdictLine(output: RoleOutput): void {
  const c = colors();
  const color = c[VERDICT_COLOR[output.verdict]];
  const icon = VERDICT_ICON[output.verdict];
  const count = output.findings.length;
  const countLabel = count === 1 ? '1 finding' : `${count} findings`;
  console.log(
    `${color}${icon} ${c.bold}${ROLE_LABELS[output.role]}${c.reset}${color} — ${output.verdict.toUpperCase()}${c.reset} ${c.dim}(${countLabel})${c.reset}`,
  );
  console.log(`  ${output.summary}`);
}

/** Final summary line after the orchestrator returns. */
export function printPipelineOutcome(result: PipelineRunResult): void {
  const c = colors();
  const total = 6;
  if (result.outcome === 'completed') {
    console.log(`\n${c.bold}${c.green}✔ Pipeline completed${c.reset} — ${result.ranRoles.length}/${total} roles ran.`);
    return;
  }
  if (result.outcome === 'skipped') {
    console.log(
      `\n${c.bold}${c.yellow}⏭ Pipeline stopped early (skip)${c.reset} — ${result.ranRoles.length}/${total} roles ran, ` +
        `${result.skippedRoles.length} skipped: ${result.skippedRoles.map((r) => ROLE_LABELS[r]).join(', ')}.`,
    );
    return;
  }
  if (result.outcome === 'errored') {
    console.log(
      `\n${c.bold}${c.red}✖ Pipeline stopped early (error)${c.reset} — ${result.ranRoles.length}/${total} roles ran before the failure.`,
    );
    return;
  }
  console.log(
    `\n${c.bold}${c.red}🛑 Pipeline aborted${c.reset} — ${result.ranRoles.length}/${total} roles ran before the abort.`,
  );
}

/** Final decision banner — the Resolver's Approve/Request Changes/Block call, with its rationale. */
export function printResolverDecision(result: ResolverResult): void {
  const c = colors();
  const color = result.decision === 'approve' ? c.green : result.decision === 'block' ? c.red : c.yellow;
  console.log(`\n${color}${c.bold}Decision: ${RESOLVER_DECISION_LABELS[result.decision]}${c.reset} ${c.dim}(risk score ${result.score.toFixed(2)})${c.reset}`);
  console.log(`  ${result.rationale}`);
}

/** Prints the absolute path to the HTML report so it's easy to open right away. */
export function printReportPaths(paths: ReportPaths): void {
  const c = colors();
  console.log(`\n${c.dim}Report:${c.reset} ${c.bold}${paths.html}${c.reset}`);
  console.log(`${c.dim}         ${paths.json}${c.reset}`);
  console.log(`${c.dim}         ${paths.md}${c.reset}`);
}

/** Prints the absolute path to the fix-summary HTML report, alongside the scan report path. */
export function printFixReportPath(path: string): void {
  const c = colors();
  console.log(`${c.dim}Fix report:${c.reset} ${c.bold}${path}${c.reset}`);
}

/** "— Fix iteration N (n blocking findings) —" header, printed at the start of each Breaker-Builder iteration. */
export function printFixIterationStart(iteration: number, blockingFindingsCount: number): void {
  const c = colors();
  console.log(
    `\n${c.dim}— Fix iteration ${iteration} (${blockingFindingsCount} blocking finding${blockingFindingsCount === 1 ? '' : 's'}) —${c.reset}`,
  );
}

/** One line per applied fix. */
export function printFixAttempt(record: FixAttemptRecord): void {
  const c = colors();
  const stageLabel = record.fixerStage === 'deterministic' ? 'deterministic' : 'LLM';
  console.log(`${c.dim}🔧 [${stageLabel}]${c.reset} ${record.file} — ${record.description}`);
}

/** Final Breaker-Builder outcome — resolved, escalated, or stopped via a gate decision. */
export function printBreakerBuilderOutcome(result: BreakerBuilderResult): void {
  const c = colors();
  if (result.outcome === 'resolved') {
    console.log(
      `\n${c.bold}${c.green}✔ Breaker-Builder resolved${c.reset} — ${result.fixAttempts.length} fix(es) applied over ${result.iterations} iteration(s), no blocking findings remain.`,
    );
    return;
  }
  if (result.outcome === 'escalated') {
    console.log(
      `\n${c.bold}${c.red}⚠ Breaker-Builder escalated${c.reset} — hit its limits after ${result.iterations} iteration(s) with ` +
        `${result.unresolvedFindings.length} blocking finding(s) still unresolved. Manual attention needed.`,
    );
    for (const f of result.unresolvedFindings) {
      console.log(`  ${c.red}✖${c.reset} [${f.severity}] ${f.file}:${f.lineStart}-${f.lineEnd} — ${f.description}`);
    }
    return;
  }
  if (result.outcome === 'skipped') {
    console.log(`\n${c.bold}${c.yellow}⏭ Breaker-Builder stopped (skip)${c.reset} after ${result.iterations} iteration(s).`);
    return;
  }
  console.log(`\n${c.bold}${c.red}🛑 Breaker-Builder aborted${c.reset} after ${result.iterations} iteration(s).`);
}
