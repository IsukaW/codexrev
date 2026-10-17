/**
 * Pure text renderers for every `codexrev spec` screen: analyze, watch
 * batches, status, history and the accept/reject/defer decisions.
 *
 * Every function RETURNS strings (no console here) so the UX is unit
 * testable; the thin print wrappers in `specOutput.ts` / the command
 * handlers own the actual output. Colors follow the repo convention
 * (hand-rolled palette from src/cli/help.ts — no chalk; auto-off when
 * stdout is not a TTY), so piped/CI output stays clean and tests see
 * plain strings.
 */

import { formatDriftAlert } from '../pipeline/driftAlert.js';
import type { DiffFile, ExtractedDiff } from '../pipeline/diffExtractor.js';
import type {
  SpecAnalysisResult,
  SpecChangeDriftAlert,
  SpecImplication,
  SpecProposal,
  SpecTestCaseDelta,
  UrsDocument,
  UrsVersionSnapshot,
} from '../pipeline/types.js';

// ── palette / alignment (help.ts conventions) ─────────────────────────

const PALETTE = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
} as const;

const NO_COLOR_PALETTE = {
  reset: '',
  bold: '',
  dim: '',
  cyan: '',
  green: '',
  yellow: '',
  red: '',
  gray: '',
} as const;

export type SpecPalette = Record<keyof typeof PALETTE, string>;

export function palette(): SpecPalette {
  return process.stdout.isTTY === true ? PALETTE : NO_COLOR_PALETTE;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Pads to the visible width (ANSI codes count as zero width). */
export function padAnsi(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const pad = Math.max(0, width - visibleLength(s));
  return align === 'left' ? s + ' '.repeat(pad) : ' '.repeat(pad) + s;
}

/** One changed-file line (`+2 -1  modified  path`) for the file tables. */
export function renderFileLine(file: DiffFile): string {
  const c = palette();
  const name =
    file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return `  ${c.green}${formatDelta(file.linesAdded, file.linesRemoved).padEnd(8)}${c.reset} ${file.status.padEnd(8)} ${name}`;
}

function truncate(s: string, max: number): string {
  const oneLine = s.trim().replace(/\s+/g, ' ');
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

const SEVERITY_COLOR: Record<string, keyof typeof PALETTE> = {
  critical: 'red',
  warning: 'yellow',
  info: 'gray',
};

const DELTA_TYPE_LABEL: Record<SpecTestCaseDelta['type'], string> = {
  new: 'NEW',
  update: 'UPDATE',
  obsolete: 'OBSOLETE',
};

// ── analyze ───────────────────────────────────────────────────────────

function formatDelta(added: number, removed: number): string {
  return `+${added} -${removed}`;
}

/** Header + changed-file table + report location for one analyze run. */
export function renderAnalyzeHeader(params: {
  readonly extraction: ExtractedDiff;
  readonly result: SpecAnalysisResult;
  readonly root: string;
  readonly reportFile: string | null;
}): readonly string[] {
  const c = palette();
  const { extraction, result } = params;
  const totalAdded = extraction.files.reduce((n, f) => n + f.linesAdded, 0);
  const totalRemoved = extraction.files.reduce((n, f) => n + f.linesRemoved, 0);
  const MAX_FILES = 25;
  const lines: string[] = [
    `Living Specification Engine — analysis of ${extraction.ref} in ${params.root}`,
    `  ${c.bold}change id:${c.reset}  ${result.changeId}`,
    `  ${extraction.files.length} file(s) changed: ${formatDelta(totalAdded, totalRemoved)}`,
  ];
  for (const file of extraction.files.slice(0, MAX_FILES)) lines.push(renderFileLine(file));
  if (extraction.files.length > MAX_FILES) {
    lines.push(`  … and ${extraction.files.length - MAX_FILES} more file(s)`);
  }
  lines.push(
    params.reportFile
      ? `  ${c.bold}report written:${c.reset} ${params.reportFile}`
      : '  (dry-run) report not written',
  );
  return lines;
}

/** Aligned requirement-implications table (empty when the semantic half did not run). */
export function renderImplicationsSection(
  implications: readonly SpecImplication[],
): readonly string[] {
  const c = palette();
  if (implications.length === 0) {
    return [`  ${c.bold}implications:${c.reset} (none — deterministic analysis only)`];
  }
  const lines = [`  ${c.bold}requirement implications (${implications.length})${c.reset}`];
  lines.push(`    ${'KIND'.padEnd(10)} ${'CONF'.padEnd(5)} ${'CATEGORY'.padEnd(11)} ${'ID'.padEnd(10)} TEXT`);
  for (const imp of implications) {
    lines.push(
      `    ${imp.kind.padEnd(10)} ${imp.confidence.toFixed(2).padEnd(5)} ${(imp.category ?? '-').padEnd(11)} ${imp.id.padEnd(10)} ${truncate(imp.text, 72)}`,
    );
  }
  return lines;
}

/** The output side: test-delta table, impact summary and drift alerts. */
export function renderOutputSideSection(view: {
  readonly testDeltas: readonly SpecTestCaseDelta[];
  readonly driftAlerts: readonly SpecChangeDriftAlert[];
  readonly impactSummary: SpecAnalysisResult['impactSummary'];
  readonly synthesis: {
    readonly refined: boolean;
    readonly refinementError?: { readonly code: string; readonly message: string };
  };
}): readonly string[] {
  const c = palette();
  const lines: string[] = [];

  const counts = { new: 0, update: 0, obsolete: 0 };
  for (const d of view.testDeltas) counts[d.type]++;
  const provenance = view.synthesis.refined ? 'llm-refined' : 'rules';
  lines.push(
    `  ${c.bold}test deltas:${c.reset}     ${view.testDeltas.length}` +
      (view.testDeltas.length > 0
        ? ` (${counts.new} new, ${counts.update} update, ${counts.obsolete} obsolete — ${provenance})`
        : ''),
  );
  if (view.testDeltas.length > 0) {
    lines.push(
      `    ${'TYPE'.padEnd(8)} ${'PRIORITY'.padEnd(9)} ${'ID'.padEnd(16)} ${'REQUIREMENT'.padEnd(18)} TITLE`,
    );
    for (const d of view.testDeltas) {
      lines.push(
        `    ${DELTA_TYPE_LABEL[d.type].padEnd(8)} ${d.priority.padEnd(9)} ${d.id.padEnd(16)} ${d.linkedRequirementId.padEnd(18)} ${truncate(d.title, 60)}`,
      );
    }
  }

  const impact = view.impactSummary;
  lines.push(
    `  ${c.bold}impact:${c.reset}          requirements: ${
      impact.affectedRequirementIds.length > 0 ? impact.affectedRequirementIds.join(', ') : '(none)'
    }`,
  );
  const files = impact.affectedFiles
    .map((f) => `${f.path}:${f.lines.length > 0 ? f.lines.join(',') : '?'}`)
    .join(', ');
  lines.push(`                   files: ${files.length > 0 ? files : '(none)'}`);
  lines.push(`                   next: ${impact.recommendedNextAction}`);
  lines.push(`                   confidence: ${impact.confidence.toFixed(2)}`);

  lines.push(
    `  ${c.bold}drift alerts:${c.reset}    ${view.driftAlerts.length > 0 ? String(view.driftAlerts.length) : '(none)'}`,
  );
  for (const alert of view.driftAlerts) {
    const color = c[SEVERITY_COLOR[alert.severity] ?? 'gray'];
    lines.push(`${color}${formatDriftAlert(alert)}${c.reset}`);
  }
  return lines;
}

/** One-line drift + proposal summary between the header and the tables. */
export function renderDriftLine(result: SpecAnalysisResult): string {
  const c = palette();
  const parts = [`  ${c.bold}drift:${c.reset}           ${result.driftStatus}`];
  if (result.proposalIds && result.proposalIds.length > 0) {
    parts.push(`  ${c.bold}proposals:${c.reset}       ${result.proposalIds.join(', ')} (pending — accept/reject/defer)`);
  }
  return parts.join('\n');
}

// ── failure-path UX (NFR4/NFR5) ───────────────────────────────────────

/** Actionable hint lines for a failed model inference (printed as a warning). */
export function renderInferenceFailure(code: string, message: string): readonly string[] {
  const c = palette();
  const lines = [`${c.yellow}⚠ model inference failed (${code}): ${message}${c.reset}`];
  if (code === 'provider_unavailable' || code === 'timeout') {
    lines.push(
      `  ${c.cyan}→ start ollama / lm studio (e.g. \`ollama serve\`), or run with --dry-run${c.reset} ` +
        `${c.dim}(deterministic analysis, no model needed)${c.reset}`,
    );
  } else if (code === 'malformed_output' || code === 'schema_invalid') {
    lines.push(
      `  ${c.cyan}→ nothing was applied or persisted from the model output (NFR5)${c.reset} — ` +
        `${c.dim}the deterministic analysis stands; retry or try a different model${c.reset}`,
    );
  } else {
    lines.push(`  ${c.dim}→ the deterministic analysis stands; retry when the provider is healthy${c.reset}`);
  }
  return lines;
}

/** Explicit truncation notice: what was cut and how to get the full view. */
export function renderTruncationNotice(extraction: ExtractedDiff): string {
  const c = palette();
  const shown = extraction.omittedPaths.slice(0, 5).join(', ');
  const more =
    extraction.omittedPaths.length > 5
      ? ` (+${extraction.omittedPaths.length - 5} more)`
      : '';
  const omitted =
    extraction.omittedPaths.length > 0
      ? `: ${extraction.omittedPaths.length} file(s) omitted${shown ? ` — ${shown}${more}` : ''}`
      : ': partial file cut at the limit';
  return (
    `${c.yellow}⚠ diff truncated at ${extraction.maxBytes} of ${extraction.totalBytes} bytes${omitted}${c.reset}\n` +
    `  ${c.dim}→ results are partial; raise "maxBytes" in .codexrev/living-spec/config.json to analyze the full diff${c.reset}`
  );
}

// ── status / history / decisions ──────────────────────────────────────

export interface StatusReportInput {
  readonly root: string;
  readonly stateDir: string;
  readonly watchedPaths: readonly string[];
  readonly debounceMs: number;
  readonly modelOverride: string | null;
  /** Human "v3 (updated …)" line or 'none yet'. */
  readonly ursVersion: string;
  readonly openProposals: readonly SpecProposal[];
  readonly alerts: readonly SpecChangeDriftAlert[];
  readonly alertsTotal: number;
  readonly alertLimit: number;
}

export function renderStatusReport(input: StatusReportInput): readonly string[] {
  const c = palette();
  const lines = [
    `Living Specification Engine — status (${input.root})`,
    `  state dir:         ${input.stateDir}`,
    `  watched paths:     ${input.watchedPaths.join(', ')}`,
    `  debounce:          ${input.debounceMs} ms`,
    `  model override:    ${input.modelOverride ?? '(settings default)'}`,
    `  URS version:       ${input.ursVersion}`,
    `  open proposals:    ${input.openProposals.length > 0 ? '' : '(none)'}`,
  ];
  for (const p of input.openProposals) {
    const drift = p.driftStatus ? ` [${p.driftStatus}]` : '';
    const sections = p.sectionsTouched?.length ? ` → ${p.sectionsTouched.join(', ')}` : '';
    lines.push(`    ${p.id}  ${c.bold}${p.status}${c.reset}${drift}  ${p.title}${sections}`);
  }
  lines.push(
    `  drift alerts:      ${
      input.alertsTotal > 0
        ? `${input.alertsTotal} recorded (latest ${Math.min(input.alerts.length, input.alertLimit)})`
        : '(none)'
    }`,
  );
  for (const alert of input.alerts.slice(-input.alertLimit)) {
    const color = c[SEVERITY_COLOR[alert.severity] ?? 'gray'];
    lines.push(
      `    ${color}${alert.severity.padEnd(8)}${c.reset} ${alert.file} — ${truncate(alert.reason, 72)}`,
    );
  }
  return lines;
}

export function renderHistoryReport(
  snapshots: readonly UrsVersionSnapshot[],
): readonly string[] {
  if (snapshots.length === 0) return ['No URS versions recorded yet.'];
  const lines = ['URS versions:'];
  for (const v of snapshots) {
    lines.push(
      `  v${String(v.version).padEnd(4)} ${v.action.padEnd(6)}  change ${v.changeId}  ${v.timestamp}`,
    );
  }
  return lines;
}

export function renderDecisionResult(params: {
  readonly decision: 'accept' | 'reject' | 'defer';
  readonly proposal: SpecProposal;
  /** URS version after an accept with a patch. */
  readonly version?: number;
}): readonly string[] {
  const c = palette();
  const { decision, proposal, version } = params;
  if (decision === 'accept') {
    return version !== undefined
      ? [`${c.green}✓${c.reset} proposal ${proposal.id} accepted — URS updated to v${version}`]
      : [`${c.green}✓${c.reset} proposal ${proposal.id} accepted (no patch to apply)`];
  }
  return [`${c.green}✓${c.reset} proposal ${proposal.id} ${decision === 'reject' ? 'rejected' : 'deferred'}`];
}

/** Short usage block for stderr on bad usage (exit code 2). */
export function renderSpecUsage(): string {
  return [
    'usage: codexrev spec <subcommand> [flags]',
    '  bootstrap [--yes] [--dry-run] [--project <path>] [--output json|text]',
    '  analyze [--diff <ref>] [--project <path>] [--output json|text] [--dry-run] [--quiet]',
    '  watch   [--debounce <ms>] [--paths <globs>] [--output json|text] [--dry-run] [--quiet]',
    '  eval    [--corpus <dir>] [--mode A|B|C|batch|single-pass|full|live|all] [--live]',
    '  status  [--project <path>] [--output json|text]',
    '  history [--project <path>] [--output json|text]',
    '  accept <id> | reject <id> | defer <id>   [--project <path>] [--output json|text]',
    '  help [analyze|watch|eval|status|history|accept|reject|defer]',
    'Run `codexrev spec help` for the full flag reference.',
  ].join('\n');
}

// ── URS bootstrap (Version 0 from existing code) ──────────────────────

export interface BootstrapPreviewInput {
  readonly root: string;
  readonly scanSummary: string;
  /** Model overview of the system. */
  readonly summary: string;
  readonly doc: UrsDocument;
  readonly droppedSections: readonly string[];
  readonly droppedRefs: number;
}

/** Draft preview shown BEFORE the user approves the URS as Version 0. */
export function renderBootstrapPreview(input: BootstrapPreviewInput): readonly string[] {
  const c = palette();
  const { doc } = input;
  const lines = [
    `${c.bold}Living Specification Engine — URS bootstrap${c.reset} ${c.dim}(draft Version 0 — not yet saved)${c.reset}`,
    `  project:    ${input.root}`,
    `  scan:       ${input.scanSummary}`,
    `  summary:    ${truncate(input.summary, 160)}`,
    `  sections:   ${doc.sections.length}`,
    `    ${'TYPE'.padEnd(11)} ${'ID'.padEnd(22)} ${'REFS'.padEnd(5)} TITLE`,
  ];
  let refCount = 0;
  for (const s of doc.sections) {
    refCount += s.sourceRefs.length;
    lines.push(
      `    ${s.type.padEnd(11)} ${s.id.padEnd(22)} ${String(s.sourceRefs.length).padEnd(5)} ${truncate(s.title, 60)}`,
    );
  }
  lines.push(`  referenced: ${refCount} source reference(s) into the scanned code`);
  if (input.droppedRefs > 0 || input.droppedSections.length > 0) {
    lines.push(
      `  ${c.yellow}sanitised:${c.reset} ${input.droppedRefs} unresolvable reference(s) dropped` +
        (input.droppedSections.length > 0
          ? `, ${input.droppedSections.length} section(s) dropped for having none (${input.droppedSections.join(', ')})`
          : ''),
    );
  }
  return lines;
}

export interface BootstrapApprovedInput {
  readonly root: string;
  readonly version: number;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly pdfPath: string;
  readonly versionJsonPath: string;
  readonly versionPdfPath: string;
}

/** Success screen after the user approves the draft (dual-format write). */
export function renderBootstrapApproved(input: BootstrapApprovedInput): readonly string[] {
  const c = palette();
  return [
    `${c.green}✓${c.reset} URS Version ${input.version} approved and written ${c.dim}(bootstrap)${c.reset}`,
    `  urs.json:  ${input.jsonPath}`,
    `  urs.md:    ${input.markdownPath}`,
    `  urs.pdf:   ${input.pdfPath}`,
    `  snapshot:  ${input.versionJsonPath}`,
    `             ${input.versionPdfPath}`,
    `  next:      run \`codexrev spec analyze\` to keep the URS in sync with changes`,
  ];
}
