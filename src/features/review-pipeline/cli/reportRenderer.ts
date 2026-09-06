/**
 * Codexrev — Feature 2 (review-pipeline) report renderer.
 *
 * Takes the final aggregated context (all six roles' outputs + the
 * Resolver's decision, Phases 5/6) and renders JSON, Markdown, and HTML
 * versions, saved to `.codexrev/review-pipeline/reports/scan-<timestamp>.*`
 * per Section 4's folder convention. The HTML report is the "first
 * command" deliverable: a decision banner up top, per-role sections
 * with their findings, and a git change-coverage map — each changed
 * line linked to whichever role's finding(s) cover it (FR14).
 *
 * The HTML is a single self-contained file (inline CSS, no external
 * assets, no JS framework) so it opens directly via `file://` in any
 * browser — no local server needed. All LLM-produced text (summaries,
 * finding descriptions) is HTML-escaped before embedding; it's
 * untrusted content as far as this renderer is concerned.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROLE_LABELS, ROLE_ORDER, type Finding, type RoleId, type RoleOutput } from '../roles/roleContract.js';
import { RESOLVER_DECISION_LABELS, type ResolvedFinding, type ResolverResult } from '../pipeline/resolverEngine.js';
import { fixAttemptRoleLabel, type BreakerBuilderOutcome, type FixAttemptRecord } from '../pipeline/breakerBuilderLoop.js';
import type { ParsedDiff } from '../pipeline/diffReader.js';
import type { PipelineOutcome } from '../pipeline/orchestrator.js';

// ── Report data model ───────────────────────────────────────────────

export interface ReportData {
  readonly runId: string;
  readonly generatedAt: string;
  readonly diff: ParsedDiff;
  readonly roleOutputs: Readonly<Partial<Record<RoleId, RoleOutput>>>;
  readonly resolver: ResolverResult;
  readonly pipelineOutcome: PipelineOutcome;
  readonly ranRoles: readonly RoleId[];
  readonly skippedRoles: readonly RoleId[];
}

// ── Change coverage map (FR14) ──────────────────────────────────────

/** One added line in the diff, and whatever findings (from any role) cover it. */
export interface CoverageLine {
  readonly file: string;
  readonly line: number;
  readonly content: string;
  readonly findings: readonly ResolvedFinding[];
}

/**
 * Maps every added line in the diff to the findings that cover it —
 * "coverage" in the same spirit as test coverage: most lines will have
 * none (reviewed, nothing found), which is exactly the point of
 * showing them too, not just the flagged ones.
 */
export function buildChangeCoverageMap(diff: ParsedDiff, resolvedFindings: readonly ResolvedFinding[]): CoverageLine[] {
  const lines: CoverageLine[] = [];
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const dLine of hunk.lines) {
        if (dLine.type !== 'add' || dLine.newLineNumber === undefined) continue;
        const lineNo = dLine.newLineNumber;
        const findings = resolvedFindings.filter(
          (f) => f.file === file.path && lineNo >= f.lineStart && lineNo <= f.lineEnd,
        );
        lines.push({ file: file.path, line: lineNo, content: dLine.content, findings });
      }
    }
  }
  return lines;
}

// ── File paths ───────────────────────────────────────────────────────

export function defaultReportsDir(projectRoot: string): string {
  return path.join(projectRoot, '.codexrev', 'review-pipeline', 'reports');
}

export interface ReportPaths {
  readonly dir: string;
  readonly json: string;
  readonly md: string;
  readonly html: string;
}

/** Filesystem-safe timestamp (UTC, colon-free — safe on Windows too) for the report filename. */
export function formatTimestampForFilename(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

export function reportPaths(dir: string, timestamp: string): ReportPaths {
  const base = path.join(dir, `scan-${timestamp}`);
  return { dir, json: `${base}.json`, md: `${base}.md`, html: `${base}.html` };
}

/** Renders all three formats and writes them to `dir` (created if needed). Returns the absolute paths written. */
export async function saveReport(data: ReportData, dir: string): Promise<ReportPaths> {
  await fs.mkdir(dir, { recursive: true });
  const paths = reportPaths(dir, formatTimestampForFilename());
  await fs.writeFile(paths.json, renderReportJson(data), 'utf-8');
  await fs.writeFile(paths.md, renderReportMarkdown(data), 'utf-8');
  await fs.writeFile(paths.html, renderReportHtml(data), 'utf-8');
  return paths;
}

// ── JSON ─────────────────────────────────────────────────────────────

export function renderReportJson(data: ReportData): string {
  const coverage = buildChangeCoverageMap(data.diff, data.resolver.resolvedFindings);

  const payload = {
    generatedAt: data.generatedAt,
    runId: data.runId,
    decision: {
      value: data.resolver.decision,
      label: RESOLVER_DECISION_LABELS[data.resolver.decision],
      score: data.resolver.score,
      rationale: data.resolver.rationale,
      appliedRules: data.resolver.appliedRules,
    },
    pipeline: {
      outcome: data.pipelineOutcome,
      ranRoles: data.ranRoles,
      skippedRoles: data.skippedRoles,
    },
    diff: {
      ref: data.diff.ref,
      files: data.diff.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status })),
    },
    roles: ROLE_ORDER.map((role) => {
      const output = data.roleOutputs[role];
      return {
        role,
        label: ROLE_LABELS[role],
        ran: !!output,
        verdict: output?.verdict ?? null,
        confidence: output?.confidence ?? null,
        summary: output?.summary ?? null,
        findings: output?.findings ?? [],
      };
    }),
    changeCoverage: coverage,
  };
  return JSON.stringify(payload, null, 2);
}

// ── Markdown ─────────────────────────────────────────────────────────

export function renderReportMarkdown(data: ReportData): string {
  const lines: string[] = [];
  const d = data.resolver;

  lines.push(`# Codexrev Review — ${RESOLVER_DECISION_LABELS[d.decision]}`);
  lines.push('');
  lines.push(`**Decision:** ${RESOLVER_DECISION_LABELS[d.decision]} (risk score ${d.score.toFixed(2)})`);
  lines.push('');
  lines.push(d.rationale);
  lines.push('');
  lines.push(
    `_Generated ${data.generatedAt} · run \`${data.runId}\` · diff ref \`${data.diff.ref}\` · pipeline outcome: ${data.pipelineOutcome}_`,
  );
  lines.push('');
  lines.push('## Role Verdicts');

  for (const role of ROLE_ORDER) {
    const output = data.roleOutputs[role];
    lines.push('');
    if (!output) {
      lines.push(`### ${ROLE_LABELS[role]} — did not run`);
      continue;
    }
    lines.push(`### ${ROLE_LABELS[role]} — ${output.verdict.toUpperCase()} (${output.findings.length} finding${output.findings.length === 1 ? '' : 's'})`);
    lines.push('');
    lines.push(output.summary);
    if (output.findings.length > 0) {
      lines.push('');
      lines.push('| Severity | File | Lines | CWE | Description |');
      lines.push('|---|---|---|---|---|');
      for (const f of output.findings) {
        lines.push(`| ${f.severity} | ${f.file} | ${f.lineStart}-${f.lineEnd} | ${f.cwe ?? ''} | ${mdEscape(f.description)} |`);
      }
    }
  }

  lines.push('');
  lines.push('## Change Coverage Map');
  lines.push('');
  lines.push('Every added line in the diff, and which role(s) — if any — flagged it.');
  lines.push('');
  const coverage = buildChangeCoverageMap(data.diff, d.resolvedFindings);
  if (coverage.length === 0) {
    lines.push('_No added lines in this diff._');
  } else {
    lines.push('| File | Line | Findings |');
    lines.push('|---|---|---|');
    for (const c of coverage) {
      const covered = c.findings.length === 0 ? '' : c.findings.map((f) => `${ROLE_LABELS[f.role]}: ${mdEscape(f.description)}`).join('<br>');
      lines.push(`| ${c.file} | ${c.line} | ${covered} |`);
    }
  }

  return lines.join('\n') + '\n';
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ── HTML ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DECISION_COLOR: Record<ResolverResult['decision'], string> = {
  approve: '#1a7f37',
  request_changes: '#9a6700',
  block: '#cf222e',
};

const VERDICT_COLOR: Record<RoleOutput['verdict'], string> = {
  pass: '#1a7f37',
  flag: '#9a6700',
  block: '#cf222e',
};

const SEVERITY_COLOR: Record<string, string> = {
  info: '#57606a',
  low: '#57606a',
  medium: '#9a6700',
  high: '#cf222e',
  critical: '#82071e',
};

/** Exported so the Phase 9 fix report can reuse it verbatim for its "still unresolved" findings list. */
export function renderFindingsTable(findings: readonly ResolvedFinding[] | readonly RoleOutput['findings'][number][]): string {
  if (findings.length === 0) {
    return `<p class="muted">No findings from this role.</p>`;
  }
  const rows = findings
    .map(
      (f) => `
      <tr>
        <td><span class="badge" style="background:${SEVERITY_COLOR[f.severity] ?? '#57606a'}">${escapeHtml(f.severity)}</span></td>
        <td><code>${escapeHtml(f.file)}:${f.lineStart}-${f.lineEnd}</code></td>
        <td>${f.cwe ? escapeHtml(f.cwe) : ''}</td>
        <td>${escapeHtml(f.description)}${f.suggestedFix ? `<div class="fix">Suggested fix: ${escapeHtml(f.suggestedFix)}</div>` : ''}</td>
      </tr>`,
    )
    .join('');
  return `
    <table class="findings">
      <thead><tr><th>Severity</th><th>Location</th><th>CWE</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderRoleSection(role: RoleId, output: RoleOutput | undefined): string {
  if (!output) {
    return `
    <details class="role-section">
      <summary><span class="role-name">${ROLE_LABELS[role]}</span> <span class="badge" style="background:#57606a">did not run</span></summary>
      <p class="muted">This role did not run (the review stopped early — see the pipeline outcome above).</p>
    </details>`;
  }
  const open = output.verdict !== 'pass' ? ' open' : '';
  return `
    <details class="role-section"${open}>
      <summary>
        <span class="role-name">${ROLE_LABELS[role]}</span>
        <span class="badge" style="background:${VERDICT_COLOR[output.verdict]}">${output.verdict.toUpperCase()}</span>
        <span class="muted">${output.findings.length} finding${output.findings.length === 1 ? '' : 's'}</span>
      </summary>
      <p>${escapeHtml(output.summary)}</p>
      ${renderFindingsTable(output.findings)}
    </details>`;
}

function renderCoverageMap(diff: ParsedDiff, resolvedFindings: readonly ResolvedFinding[]): string {
  if (diff.files.length === 0) {
    return `<p class="muted">No changes in this diff.</p>`;
  }

  const fileBlocks = diff.files
    .map((file) => {
      const rows: string[] = [];
      for (const hunk of file.hunks) {
        for (const dLine of hunk.lines) {
          if (dLine.type === 'del') continue; // coverage map shows the resulting (new) code
          const lineNo = dLine.newLineNumber;
          const findings =
            dLine.type === 'add' && lineNo !== undefined
              ? resolvedFindings.filter((f) => f.file === file.path && lineNo >= f.lineStart && lineNo <= f.lineEnd)
              : [];
          const worst = findings.reduce<string | null>((acc, f) => {
            if (!acc) return f.severity;
            const order = ['info', 'low', 'medium', 'high', 'critical'];
            return order.indexOf(f.severity) > order.indexOf(acc) ? f.severity : acc;
          }, null);
          const rowClass = dLine.type === 'add' ? (worst ? `flagged sev-${worst}` : 'added') : 'context';
          rows.push(`
            <tr class="${rowClass}">
              <td class="lineno">${lineNo ?? ''}</td>
              <td class="code"><pre>${escapeHtml(dLine.content)}</pre></td>
            </tr>`);
          if (findings.length > 0) {
            const notes = findings
              .map((f) => `<div class="coverage-note"><strong>${ROLE_LABELS[f.role]}</strong> [${f.severity}]: ${escapeHtml(f.description)}</div>`)
              .join('');
            rows.push(`<tr class="note-row"><td></td><td>${notes}</td></tr>`);
          }
        }
      }
      return `
        <div class="file-block">
          <h3><code>${escapeHtml(file.path)}</code> <span class="muted">(${file.status})</span></h3>
          <table class="coverage"><tbody>${rows.join('')}</tbody></table>
        </div>`;
    })
    .join('');

  return fileBlocks;
}

/**
 * Shared CSS for both the scan report (this file's original job) and
 * the Phase 9 fix-summary report — one stylesheet, embedded once per
 * document (each report is still a single self-contained file; there's
 * just one shared string this module builds it from), so the two
 * reports read as one consistent visual system instead of drifting
 * independently. Deliberately has no per-report-instance color baked
 * in (e.g. `.banner`'s background) — those vary per document and are
 * set inline via `style="background:..."` on the element instead, same
 * technique the severity/verdict badges already used.
 */
const REPORT_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f6f8fa; color: #1f2328;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 32px 0 12px; border-bottom: 1px solid #d0d7de; padding-bottom: 6px; }
  h3 { font-size: 15px; margin: 20px 0 8px; }
  code { background: #eff1f3; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  .muted { color: #57606a; font-size: 13px; }
  .meta { color: #57606a; font-size: 13px; margin-top: 6px; }

  .banner {
    border-radius: 8px; padding: 20px 24px; color: #fff; margin: 20px 0;
  }
  .banner .decision { font-size: 24px; font-weight: 700; }
  .banner .score { opacity: .9; font-size: 14px; margin-top: 2px; }
  .banner .rationale { margin-top: 12px; font-size: 14px; opacity: .95; }

  .badge {
    display: inline-block; color: #fff; border-radius: 999px; padding: 2px 10px;
    font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .02em;
  }

  details.role-section {
    background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px;
  }
  details.role-section summary { cursor: pointer; display: flex; align-items: center; gap: 10px; list-style: none; }
  details.role-section summary::-webkit-details-marker { display: none; }
  .role-name { font-weight: 600; }

  table.findings { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  table.findings th, table.findings td { text-align: left; padding: 8px 10px; border-top: 1px solid #eaeef2; vertical-align: top; }
  table.findings th { color: #57606a; font-weight: 600; }
  .fix { margin-top: 4px; color: #57606a; font-size: 12px; }

  .file-block { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
  .file-block h3 { margin: 0; padding: 10px 14px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
  table.coverage { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.coverage .lineno { width: 48px; text-align: right; padding: 0 10px; color: #8c959f; user-select: none; border-right: 1px solid #eaeef2; }
  table.coverage .code pre { margin: 0; padding: 2px 12px; white-space: pre-wrap; word-break: break-word; }
  table.coverage tr.added .code { background: #dafbe1; }
  table.coverage tr.context .code { color: #57606a; }
  table.coverage tr.flagged.sev-low .code, table.coverage tr.flagged.sev-info .code { background: #fff8c5; }
  table.coverage tr.flagged.sev-medium .code { background: #fff1d6; }
  table.coverage tr.flagged.sev-high .code, table.coverage tr.flagged.sev-critical .code { background: #ffebe9; }
  tr.note-row td { padding: 4px 12px 10px 58px; }
  .coverage-note { font-size: 12.5px; color: #57606a; }

  .fix-attempt {
    background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px;
  }
  .fix-attempt .fix-attempt-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .fix-attempt .fix-desc { margin: 8px 0 10px; }
  .diff-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .diff-pair .diff-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; color: #57606a; margin-bottom: 4px; }
  .diff-pair pre { margin: 0; padding: 8px 10px; border-radius: 6px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
  .diff-before pre { background: #ffebe9; }
  .diff-after pre { background: #dafbe1; }
  @media (max-width: 640px) { .diff-pair { grid-template-columns: 1fr; } }

  footer { margin-top: 40px; color: #8c959f; font-size: 12px; text-align: center; }
`;

/** Wraps `bodyHtml` in the shared self-contained document shell (single `<style>`, no external assets). */
function htmlDocument(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
</div>
</body>
</html>
`;
}

export function renderReportHtml(data: ReportData): string {
  const d = data.resolver;
  const roleSections = ROLE_ORDER.map((role) => renderRoleSection(role, data.roleOutputs[role])).join('');

  const body = `
  <h1>Codexrev Review</h1>
  <div class="meta">
    Generated ${escapeHtml(data.generatedAt)} · run <code>${escapeHtml(data.runId)}</code> · diff ref <code>${escapeHtml(data.diff.ref)}</code> · pipeline outcome: ${escapeHtml(data.pipelineOutcome)}
  </div>

  <div class="banner" style="background:${DECISION_COLOR[d.decision]}">
    <div class="decision">${escapeHtml(RESOLVER_DECISION_LABELS[d.decision])}</div>
    <div class="score">Risk score ${d.score.toFixed(2)}</div>
    <div class="rationale">${escapeHtml(d.rationale)}</div>
  </div>

  <h2>Role Verdicts</h2>
  ${roleSections}

  <h2>Change Coverage Map</h2>
  <p class="muted">Every added line in the diff, colour-coded by the worst finding that covers it (if any).</p>
  ${renderCoverageMap(data.diff, d.resolvedFindings)}

  <footer>Generated by Codexrev's review pipeline — this report is a decision aid, not a substitute for human review.</footer>`;

  return htmlDocument(`Codexrev Review — ${RESOLVER_DECISION_LABELS[d.decision]}`, body);
}

// ── Phase 9: post-fix HTML report ───────────────────────────────────
//
// Renders what the Breaker-Builder loop actually did, once `--fix` has
// run: which findings got fixed (before/after code, which fixer stage
// resolved them), and which ones remain after hitting the iteration/
// retry limits — Phase 9's "New" bullet 2. Deliberately HTML-only, not
// JSON+MD like the scan report — that's the literal deliverable this
// phase asks for ("a second HTML report"), so no JSON/MD variant is
// added here without a corresponding request.

export interface FixReportData {
  readonly runId: string;
  readonly generatedAt: string;
  readonly outcome: BreakerBuilderOutcome;
  readonly iterations: number;
  readonly fixAttempts: readonly FixAttemptRecord[];
  /** Findings still attached to a blocking role's verdict when the loop stopped. */
  readonly unresolvedFindings: readonly Finding[];
}

const OUTCOME_COLOR: Record<BreakerBuilderOutcome, string> = {
  resolved: '#1a7f37',
  escalated: '#cf222e',
  skipped: '#9a6700',
  aborted: '#cf222e',
};

const OUTCOME_LABEL: Record<BreakerBuilderOutcome, string> = {
  resolved: 'Resolved',
  escalated: 'Escalated',
  skipped: 'Stopped (skip)',
  aborted: 'Aborted',
};

const FIXER_STAGE_COLOR: Record<FixAttemptRecord['fixerStage'], string> = {
  deterministic: '#6639ba',
  llm: '#0969da',
};

const FIXER_STAGE_LABEL: Record<FixAttemptRecord['fixerStage'], string> = {
  deterministic: 'DeterministicFixer',
  llm: 'LLM EditGenerator',
};

/** Same wording style as `verdictPrinter.ts`'s `printBreakerBuilderOutcome` — one voice across console and report. */
function fixOutcomeRationale(data: FixReportData): string {
  const n = data.fixAttempts.length;
  const fixLabel = `${n} fix${n === 1 ? '' : 'es'}`;
  if (data.outcome === 'resolved') {
    return `${fixLabel} applied over ${data.iterations} iteration(s) — no blocking findings remain.`;
  }
  if (data.outcome === 'escalated') {
    return `Hit its limits after ${data.iterations} iteration(s) with ${data.unresolvedFindings.length} blocking finding(s) still unresolved — manual attention needed.`;
  }
  if (data.outcome === 'skipped') {
    return `Stopped by a Skip decision after ${data.iterations} iteration(s). ${fixLabel} were applied before stopping.`;
  }
  return `Aborted after ${data.iterations} iteration(s). ${fixLabel} were applied before the abort.`;
}

function renderFixAttempt(record: FixAttemptRecord): string {
  return `
    <div class="fix-attempt">
      <div class="fix-attempt-head">
        <span class="badge" style="background:#57606a">Iteration ${record.iteration}</span>
        <span class="badge" style="background:#57606a">${escapeHtml(fixAttemptRoleLabel(record))}</span>
        <span class="badge" style="background:${FIXER_STAGE_COLOR[record.fixerStage]}">${FIXER_STAGE_LABEL[record.fixerStage]}</span>
        <code>${escapeHtml(record.file)}</code>
      </div>
      <p class="fix-desc">${escapeHtml(record.description)}</p>
      <div class="diff-pair">
        <div class="diff-before">
          <div class="diff-label">Before</div>
          <pre>${escapeHtml(record.oldString)}</pre>
        </div>
        <div class="diff-after">
          <div class="diff-label">After</div>
          <pre>${escapeHtml(record.newString)}</pre>
        </div>
      </div>
    </div>`;
}

export function renderFixReportHtml(data: FixReportData): string {
  const attemptsHtml =
    data.fixAttempts.length === 0
      ? `<p class="muted">No fixes were applied.</p>`
      : data.fixAttempts.map(renderFixAttempt).join('');

  const unresolvedHtml =
    data.unresolvedFindings.length > 0
      ? `
  <h2>Still Unresolved</h2>
  <p class="muted">Findings still attached to a blocking role's verdict when the fix loop stopped — the iteration/retry limits were hit, or neither fixer could produce a confident fix.</p>
  ${renderFindingsTable(data.unresolvedFindings)}`
      : '';

  const body = `
  <h1>Codexrev Fix Summary</h1>
  <div class="meta">
    Generated ${escapeHtml(data.generatedAt)} · run <code>${escapeHtml(data.runId)}</code>
  </div>

  <div class="banner" style="background:${OUTCOME_COLOR[data.outcome]}">
    <div class="decision">${escapeHtml(OUTCOME_LABEL[data.outcome])}</div>
    <div class="rationale">${escapeHtml(fixOutcomeRationale(data))}</div>
  </div>

  <h2>Fixes Applied (${data.fixAttempts.length})</h2>
  ${attemptsHtml}
  ${unresolvedHtml}

  <footer>Generated by Codexrev's Breaker-Builder loop — pairs with the scan report sharing run <code>${escapeHtml(data.runId)}</code>.</footer>`;

  return htmlDocument(`Codexrev Fix Summary — ${OUTCOME_LABEL[data.outcome]}`, body);
}

/** `.codexrev/review-pipeline/reports/fix-<timestamp>.html` — Phase 9's exact naming. */
export function fixReportPath(dir: string, timestamp: string): string {
  return path.join(dir, `fix-${timestamp}.html`);
}

/** Renders and writes the Phase 9 fix-summary HTML report. Returns the absolute path written. */
export async function saveFixReport(data: FixReportData, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = fixReportPath(dir, formatTimestampForFilename());
  await fs.writeFile(filePath, renderFixReportHtml(data), 'utf-8');
  return filePath;
}
