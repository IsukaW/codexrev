/**
 * Terminal report for `codexrev safety assess`. Pure: takes a finished
 * session plus rendering options and returns lines. It only ARRANGES data the
 * assessment already produced; it computes no score, gate or decision, and
 * adds no fact. Every number, status, reason code, gap, assumption, limitation
 * and notice that the assessment carries is shown (long lists are capped with
 * an explicit "and N more").
 *
 * Layout:  header (action, target, decision)  ->  safety score  ->  four factors
 *          ->  critical gates  ->  evidence  ->  local-model interpretation
 *          ->  decision and why  ->  details (gaps, assumptions, limitations)
 *          ->  notices (provisional policy, assessment-only, signing status).
 *
 * Color only decorates: every decision and status is also a word and a symbol,
 * so the plain-text output (no color, ASCII) carries exactly the same information.
 */

import { describeEvidenceBundle } from '../collectors/evidenceOrchestrator.js';
import type { ContextInterpretation, ContextualObservation } from '../interpretation/types.js';
import type { AssessmentSuccess } from '../pipeline/assessmentCoordinator.js';
import type { Decision, FactorId, GateStatus } from '../model/types.js';
import type { AssessmentSessionResult } from './runAssessment.js';
import { PLAIN_OPTIONS, createStyle, padRight, visibleLength, wrapText, type RenderOptions, type Style, type Tone } from './terminalStyle.js';

const MARGIN = '  ';
const MAX_LIMITATIONS_SHOWN = 15;
const MAX_GAPS_PER_GROUP = 8;
const MAX_OBSERVATIONS_SHOWN = 10;
const f3 = (n: number): string => n.toFixed(3);

const FACTORS: ReadonlyArray<{ id: FactorId; label: string; meaning: (b: AssessmentSuccess) => string }> = [
  { id: 'reversibility', label: 'Reversibility (R)', meaning: () => 'higher = safer' },
  { id: 'blastRadius', label: 'Blast radius (B)', meaning: (a) => `higher = RISKIER (counts as 1-B = ${f3(a.calculus.adjustedBlastRadius)})` },
  { id: 'authority', label: 'Authority (A)', meaning: () => 'higher = safer' },
  { id: 'evidenceStrength', label: 'Evidence strength (E)', meaning: () => 'higher = safer' },
];

const GATE_LABELS: Readonly<Record<string, string>> = {
  AUTHORIZATION: 'Authorization',
  HUMAN_APPROVAL: 'Human approval',
  VERIFIED_RECOVERY: 'Verified recovery',
  BUILD_TEST_RESULTS: 'Build/test results',
  SUPPORTING_EVIDENCE: 'Supporting evidence',
};

const DECISION_TONE: Record<Decision, Tone> = { ALLOW: 'green', ESCALATE: 'yellow', BLOCK: 'red' };
const DECISION_MEANING: Record<Decision, string> = {
  ALLOW: 'no safety blocker was found',
  ESCALATE: 'a human must decide before this proceeds',
  BLOCK: 'do not proceed',
};
const STATUS_TONE: Record<string, Tone> = { PASS: 'green', FAIL: 'red', UNKNOWN: 'yellow', NOT_APPLICABLE: 'gray', COMPLETED: 'green', UNAVAILABLE: 'yellow', ERROR: 'red', INVALID_RESPONSE: 'red' };

interface Ctx {
  readonly st: Style;
  readonly width: number;
}

// ---------------------------------------------------------------- small pieces

const decisionSymbol = (st: Style, d: Decision): string => (d === 'ALLOW' ? st.sym.allow : d === 'ESCALATE' ? st.sym.escalate : st.sym.block);

/** The decision as symbol + word, in its color and bold. */
function decisionBadge(st: Style, d: Decision): string {
  return st.paint(`${decisionSymbol(st, d)} ${d}`, DECISION_TONE[d], { bold: true });
}

function gateSymbol(st: Style, status: GateStatus): string {
  switch (status) {
    case 'PASS':
      return st.paint(st.sym.pass, 'green', { bold: true });
    case 'FAIL':
      return st.paint(st.sym.fail, 'red', { bold: true });
    case 'UNKNOWN':
      return st.paint(st.sym.unknown, 'yellow', { bold: true });
    case 'NOT_APPLICABLE':
      return st.paint(st.sym.na, 'gray');
  }
}

/** Colors the status words PASS / FAIL / UNKNOWN / NOT_APPLICABLE etc. wherever they appear in a line. */
function tintStatuses(st: Style, text: string): string {
  return text.replace(/\b(NOT_APPLICABLE|INVALID_RESPONSE|UNAVAILABLE|COMPLETED|UNKNOWN|PASS|FAIL|ERROR)\b/g, (w) => st.paint(w, STATUS_TONE[w] ?? 'plain', { bold: true }));
}

/** Visual bands for a bar; NOT a policy threshold. `riskIsHigh` flips the meaning for blast radius. */
function barTone(value: number, riskIsHigh: boolean): Tone {
  const goodness = riskIsHigh ? 1 - value : value;
  return goodness >= 0.67 ? 'green' : goodness >= 0.34 ? 'yellow' : 'red';
}

/**
 * A section heading that always fits. A long title loses its trailing "(...)" qualifier to a wrapped
 * second line (so "(advisory, UNVERIFIED)" is never dropped), rather than overflowing a narrow terminal.
 */
function headingLines(c: Ctx, title: string): string[] {
  const max = c.width - 6;
  if (title.length <= max) return [c.st.heading(title)];
  const idx = title.indexOf(' (');
  if (idx > 0) return [c.st.heading(title.slice(0, idx)), ...wrapText(title.slice(idx + 1), c.width, MARGIN).map((l) => c.st.dim(l))];
  return [c.st.heading(`${title.slice(0, max - 1)}…`)];
}

/** A bold line inside a section, wrapped so it can never overflow. */
function subheading(c: Ctx, text: string): string[] {
  return wrapText(text, c.width, MARGIN + '  ', MARGIN).map((l) => c.st.bold(l));
}

function para(c: Ctx, text: string, indent = MARGIN, first = indent): string[] {
  return wrapText(text, c.width, indent, first);
}

function bullets(c: Ctx, items: readonly string[], opts: { max?: number; indent?: string; tint?: boolean } = {}): string[] {
  const indent = opts.indent ?? MARGIN;
  const out: string[] = [];
  for (const item of opts.max !== undefined ? items.slice(0, opts.max) : items) {
    for (const l of wrapText(item, c.width, `${indent}  `, `${indent}${c.st.sym.bullet} `)) out.push(opts.tint ? tintStatuses(c.st, l) : l);
  }
  if (opts.max !== undefined && items.length > opts.max) out.push(c.st.dim(`${indent}${c.st.sym.bullet} ... and ${items.length - opts.max} more`));
  return out;
}

/**
 * A row made of an already-styled left part and free text on the right. If it fits it stays on one
 * line; otherwise the text moves to wrapped continuation lines, so no row can overflow the terminal.
 */
function fit(c: Ctx, left: string, rightRaw: string, paintRight: (s: string) => string, hang: string): string[] {
  if (rightRaw.trim() === '') return [left];
  if (visibleLength(left) + visibleLength(rightRaw) <= c.width) return [left + paintRight(rightRaw)];
  return [left, ...wrapText(rightRaw.trim(), c.width, hang).map(paintRight)];
}

// where continuation text goes: under the second column on a wide terminal, just indented on a narrow one
const hangFor = (c: Ctx, column: number): string => (c.width < 60 ? MARGIN + '  ' : MARGIN + ' '.repeat(column));

function keyValue(c: Ctx, label: string, value: string, labelWidth = 10): string[] {
  const head = padRight(label, labelWidth);
  const lines = wrapText(value, c.width, MARGIN + ' '.repeat(labelWidth), MARGIN + ' '.repeat(labelWidth));
  lines[0] = MARGIN + c.st.dim(head) + lines[0].slice(MARGIN.length + labelWidth);
  return lines;
}

// ---------------------------------------------------------------- sections

function headline(r: AssessmentSessionResult): { label: string; tone: Tone; symbol: (st: Style) => string; note: string } {
  const a = r.assessment;
  if (a.status === 'FAILED') return { label: 'FAILED', tone: 'red', symbol: (st) => st.sym.block, note: 'no decision was made' };
  if (a.status === 'INCOMPLETE_INTERPRETATION') {
    return { label: 'INCOMPLETE', tone: 'yellow', symbol: (st) => st.sym.incomplete, note: `conservative outcome: ${a.finalDecision}; a mandatory interpretation is missing` };
  }
  return { label: a.finalDecision, tone: DECISION_TONE[a.finalDecision], symbol: (st) => decisionSymbol(st, a.finalDecision), note: DECISION_MEANING[a.finalDecision] };
}

function headerSection(c: Ctx, r: AssessmentSessionResult): string[] {
  const { st } = c;
  const h = headline(r);
  const lines: string[] = ['', MARGIN + st.paint('CodeXRev', 'cyan', { bold: true }) + st.dim(` ${st.sym.dot} `) + st.bold('Action-Safety Assessment')];
  lines.push(MARGIN + st.paint((st.options.unicode ? '─' : '-').repeat(Math.max(10, c.width - 4)), 'cyan'));
  lines.push(...keyValue(c, 'Action', r.request.actionType));
  lines.push(...keyValue(c, 'Target', r.request.environment));
  if (r.request.inputPath) lines.push(...keyValue(c, 'Input', `${r.request.inputPath} (validated)`));
  if (r.request.diffRef) {
    const applied = r.evidence.git.diffBase !== undefined;
    lines.push(...keyValue(c, 'Diff', `${r.request.diffRef} (${applied ? 'git changes compared with this revision' : 'not applied, see limitations'})`));
  }
  const badge = st.paint(`${h.symbol(st)} ${h.label}`, h.tone, { bold: true });
  lines.push(...fit(c, MARGIN + st.dim(padRight('Decision', 10)) + badge, `   ${h.note}`, (s) => st.dim(s), MARGIN + ' '.repeat(10)));
  lines.push(...para(c, 'The proposed action was NOT executed. This command only assesses it; it never deploys, migrates or rolls back anything.', MARGIN).map((l) => st.dim(l)));
  return lines;
}

function scoreSection(c: Ctx, a: AssessmentSuccess): string[] {
  const { st } = c;
  const th = a.decision.thresholds;
  const band = a.preliminaryDecision;
  const lines: string[] = ['', ...headingLines(c, 'Safety score')];
  const scoreText = `SAFETY SCORE  ${f3(a.safetyScore)} / 1.000`;
  const bandText = `score-only band: ${band}`;
  const scoreLine = MARGIN + st.dim('SAFETY SCORE  ') + st.paint(f3(a.safetyScore), DECISION_TONE[band], { bold: true }) + st.dim(' / 1.000');
  const bandPainted = st.dim('score-only band: ') + st.paint(band, DECISION_TONE[band], { bold: true });
  if (MARGIN.length + scoreText.length + 3 + bandText.length <= c.width) lines.push(scoreLine + '   ' + bandPainted);
  else lines.push(scoreLine, MARGIN + bandPainted); // a narrow terminal gets two lines instead of an overflow

  const barWidth = Math.min(50, c.width - MARGIN.length - 2);
  lines.push(MARGIN + st.bar(a.safetyScore, barWidth, DECISION_TONE[band]));

  // threshold ruler under the bar, aligned to the bar's inner cells
  const offset = st.options.unicode ? 0 : 1;
  const inner = Math.max(4, barWidth - (st.options.unicode ? 0 : 2));
  const ticks = Array<string>(inner).fill(' ');
  const labels = Array<string>(inner).fill(' ');
  for (const t of [th.escalateAtOrAbove, th.allowAtOrAbove]) {
    const pos = Math.min(inner - 1, Math.round(t * inner));
    ticks[pos] = '|';
    const text = t.toFixed(2);
    const start = Math.min(inner - text.length, Math.max(0, pos - Math.floor(text.length / 2)));
    if (labels.slice(Math.max(0, start - 1), start + text.length + 1).every((ch) => ch === ' ')) text.split('').forEach((ch, i) => (labels[start + i] = ch));
  }
  lines.push(MARGIN + ' '.repeat(offset) + st.dim(ticks.join('').trimEnd()));
  lines.push(MARGIN + ' '.repeat(offset) + st.dim(labels.join('').trimEnd()));
  lines.push(
    ...para(
      c,
      `BLOCK below ${f3(th.escalateAtOrAbove)} | ESCALATE from ${f3(th.escalateAtOrAbove)} to below ${f3(th.allowAtOrAbove)} | ALLOW from ${f3(th.allowAtOrAbove)}` +
        `  (thresholds "${th.id}"${th.provisional ? ', PROVISIONAL' : ''})`,
    ).map((l) => st.dim(l)),
  );

  const terms = a.calculus.terms.map((t) => `${f3(t.weight)}*${t.symbol === 'B' ? '(1-B)' : t.symbol}(${f3(t.termValue)})`).join(' + ');
  lines.push('', ...para(c, `= ${terms}`, MARGIN + '  ', MARGIN));
  lines.push(...para(c, `weights "${a.policy.calculusConfigId}"${a.policy.calculusProvisional ? ' [provisional]' : ''}`, MARGIN).map((l) => st.dim(l)));
  return lines;
}

function factorSection(c: Ctx, a: AssessmentSuccess): string[] {
  const { st } = c;
  const lines: string[] = ['', ...headingLines(c, 'Four safety factors')];
  const labelW = 22;
  const barW = Math.min(24, Math.max(8, c.width - MARGIN.length - labelW - 7 - 2));
  for (const f of FACTORS) {
    const score = a.factors[f.id].score;
    const risk = f.id === 'blastRadius';
    const label = padRight(f.label, labelW);
    const bar = st.bar(score, barW, barTone(score, risk));
    const meaning = f.meaning(a);
    const rowLen = MARGIN.length + labelW + 7 + barW + 2;
    lines.push(MARGIN + label + st.paint(f3(score), barTone(score, risk), { bold: true }) + '  ' + bar + (rowLen + meaning.length <= c.width ? '  ' + st.dim(meaning) : ''));
    if (rowLen + meaning.length > c.width) lines.push(...wrapText(meaning, c.width, MARGIN + '    ').map((l) => st.dim(l)));
  }
  lines.push(...para(c, 'Bar colors are visual only. For blast radius a LONGER bar means MORE risk.', MARGIN).map((l) => st.dim(l)));
  return lines;
}

function gateSection(c: Ctx, a: AssessmentSuccess): string[] {
  const { st } = c;
  const lines: string[] = ['', ...headingLines(c, 'Critical safety gates')];
  lines.push(MARGIN + st.dim(`policy: ${a.policy.gatePolicySource.replace(/_/g, ' ')}`));
  const stacked = c.width < 56;
  if (!stacked) lines.push(MARGIN + st.dim(padRight('', 2) + padRight('GATE', 21) + padRight('EVIDENCE', 16) + 'EFFECT'));
  for (const g of a.gates.results) {
    const label = GATE_LABELS[g.gate] ?? g.gate;
    const triggered = g.status === 'FAIL' || g.status === 'UNKNOWN';
    const effect = triggered ? g.consequence : g.status === 'NOT_APPLICABLE' ? 'not required' : 'none';
    const effectPainted = triggered ? st.paint(`${effect === 'BLOCK' ? st.sym.block : st.sym.escalate} ${effect}`, effect === 'BLOCK' ? 'red' : 'yellow', { bold: true }) : st.dim(effect);
    const status = st.paint(g.status, STATUS_TONE[g.status] ?? 'plain', { bold: triggered || g.status === 'PASS' });
    if (stacked) {
      lines.push(MARGIN + gateSymbol(st, g.status) + ' ' + st.bold(label));
      const evidencePart = st.dim('evidence ') + status;
      const effectPart = st.dim('effect ') + effectPainted;
      // together if they fit, otherwise one per line
      if (MARGIN.length + 2 + visibleLength(evidencePart) + 2 + visibleLength(effectPart) <= c.width) lines.push(MARGIN + '  ' + evidencePart + '  ' + effectPart);
      else lines.push(MARGIN + '  ' + evidencePart, MARGIN + '  ' + effectPart);
    } else {
      lines.push(MARGIN + gateSymbol(st, g.status) + ' ' + padRight(label, 21) + padRight(status, 16) + effectPainted);
    }
    for (const l of wrapText(g.explanation, c.width, MARGIN + '    ', MARGIN + '  ' + st.sym.sub + ' ')) lines.push(st.dim(l));
  }
  return lines;
}

function evidenceSection(c: Ctx, r: AssessmentSessionResult): string[] {
  const { st } = c;
  const lines: string[] = ['', ...headingLines(c, 'Evidence collected (read-only)')];
  const labels: Record<string, string> = { git: 'Git changes', dependencies: 'Dependencies', 'build/test': 'Build/test', 'security findings': 'Security', authority: 'Authority', recovery: 'Recovery' };
  for (const raw of describeEvidenceBundle(r.evidence)) {
    const idx = raw.indexOf(':');
    const key = raw.slice(0, idx);
    const value = raw.slice(idx + 1).trim();
    const head = padRight(labels[key] ?? key, 13);
    const body = wrapText(value, c.width, MARGIN + ' '.repeat(13), MARGIN + ' '.repeat(13));
    body[0] = MARGIN + st.dim(head) + tintStatuses(st, body[0].slice(MARGIN.length + 13));
    lines.push(body[0], ...body.slice(1).map((l) => tintStatuses(st, l)));
  }
  return lines;
}

function observationLines(c: Ctx, o: ContextualObservation): string[] {
  const { st } = c;
  const tone: Tone = o.significance === 'high' ? 'red' : o.significance === 'medium' ? 'yellow' : 'gray';
  const tag = `[${o.significance.toUpperCase()}]`;
  const head = `${tag} ${o.category} ${st.sym.dot} ${o.kind === 'concern' ? 'concern' : 'information gap'} ${st.sym.dot} unverified`;
  // wrap the plain text, then style: the severity tag (first line only) in its tone, the rest dim
  const lines = wrapText(head, c.width, MARGIN + '    ', MARGIN).map((l, idx) =>
    idx === 0 ? MARGIN + st.paint(tag, tone, { bold: o.significance === 'high' }) + st.dim(l.slice(MARGIN.length + tag.length)) : st.dim(l),
  );
  lines.push(...para(c, o.description, MARGIN + '    '));
  if (o.references.length > 0) lines.push(...para(c, `refs: ${o.references.join(', ')}`, MARGIN + '    ').map((l) => st.dim(l)));
  return lines;
}

function interpretationSection(c: Ctx, i: ContextInterpretation): string[] {
  const { st } = c;
  const lines: string[] = ['', ...headingLines(c, 'Local model interpretation (advisory, UNVERIFIED)')];
  const via = i.provider ? `model "${i.provider.model}" via ${i.provider.id}${i.provider.local ? ' (local)' : ' (NOT local)'}` : undefined;
  lines.push(...fit(c, MARGIN + st.dim(padRight('Status', 10)) + st.paint(i.status, STATUS_TONE[i.status] ?? 'plain', { bold: true }), via ? `   ${via}` : '', (s) => st.dim(s), MARGIN + ' '.repeat(10)));
  if (i.status !== 'COMPLETED') {
    if (i.reason) lines.push(...keyValue(c, 'Reason', i.reason));
    lines.push(...para(c, 'No observations were produced, and none were invented.', MARGIN).map((l) => st.dim(l)));
    return lines;
  }
  if (i.summary) lines.push(...keyValue(c, 'Summary', `${i.summary} (unverified)`));
  lines.push(MARGIN + st.dim(padRight('Findings', 10)) + `${i.observations.length} observation(s), none of them verified`);
  for (const o of i.observations.slice(0, MAX_OBSERVATIONS_SHOWN)) lines.push(...observationLines(c, o));
  if (i.observations.length > MAX_OBSERVATIONS_SHOWN) lines.push(st.dim(`${MARGIN}... and ${i.observations.length - MAX_OBSERVATIONS_SHOWN} more`));
  if (i.rejectedObservations.length > 0) lines.push(...para(c, `${i.rejectedObservations.length} observation(s) dropped for citing evidence that does not exist.`, MARGIN).map((l) => st.dim(l)));
  if (i.injectionIndicators.length > 0) lines.push(...para(c, `Possible prompt-injection text found in ${i.injectionIndicators.length} place(s); it was treated as data.`, MARGIN).map((l) => st.paint(l, 'yellow')));
  lines.push(...para(c, 'Advisory only: these observations are not evidence and cannot change a score, a gate or a decision.', MARGIN).map((l) => st.dim(l)));
  return lines;
}

function groupReasonCodes(codes: readonly string[]): Array<[string, string[]]> {
  const groups: Array<[string, (code: string) => boolean]> = [
    ['Score', (x) => x.startsWith('SCORE_')],
    ['Gates', (x) => x.startsWith('GATE') || x === 'ALL_GATES_CLEAR'],
    ['Interpretation', (x) => x.startsWith('INTERPRETATION_')],
    ['Final', (x) => x.startsWith('FINAL_')],
  ];
  const used = new Set<string>();
  const out: Array<[string, string[]]> = [];
  for (const [name, test] of groups) {
    const members = codes.filter((x) => test(x) && !used.has(x));
    members.forEach((m) => used.add(m));
    if (members.length > 0) out.push([name, members]);
  }
  const rest = codes.filter((x) => !used.has(x));
  if (rest.length > 0) out.push(['Other', rest]);
  return out;
}

// Splits prose into sentences, in order, without splitting inside parentheses (an error message
// quoted in brackets keeps its own full stops), and drops exact repeats: the engine and the
// coordinator both state the final decision.
function sentences(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[i + 1] ?? '') && /[A-Z"(]/.test(text.slice(i + 1).trimStart()[0] ?? '')) {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of parts.map((x) => x.trim()).filter((x) => x.length > 0)) {
    if (!seen.has(sentence)) {
      seen.add(sentence);
      out.push(sentence);
    }
  }
  return out;
}

function decisionSection(c: Ctx, a: AssessmentSuccess): string[] {
  const { st } = c;
  const lines: string[] = ['', ...headingLines(c, 'Decision')];

  if (a.status === 'INCOMPLETE_INTERPRETATION') {
    lines.push(...para(c, `ASSESSMENT INCOMPLETE: local-model interpretation is mandatory by policy but ${a.interpretation.status}.`, MARGIN).map((l) => st.paint(l, 'yellow', { bold: true })));
    lines.push(...para(c, "The decision below is the policy's conservative outcome, not a full assessment.", MARGIN).map((l) => st.paint(l, 'yellow')));
  }
  // the phrase "FINAL DECISION: <word>" is kept exactly, so scripts can still grep for it
  lines.push(
    ...fit(c, MARGIN + st.paint(`${decisionSymbol(st, a.finalDecision)} FINAL DECISION: ${a.finalDecision}`, DECISION_TONE[a.finalDecision], { bold: true }), `   ${DECISION_MEANING[a.finalDecision]}`, (s) => st.dim(s), MARGIN + '  '),
  );

  // the three stages kept apart, aligned
  const changedByGates = a.deterministicDecision !== a.preliminaryDecision;
  const ip = a.policy.interpretationPolicy;
  const rows: Array<[string, Decision, string]> = [
    ['Score alone', a.preliminaryDecision, ''],
    ['After critical gates', a.deterministicDecision, changedByGates ? `the gates changed it from ${a.preliminaryDecision}` : 'the gates did not change it'],
    ['After interpretation', a.finalDecision, a.interpretationRaisedDecision ? `policy raised it from ${a.deterministicDecision}` : ip.mandatory ? 'mandatory policy: no change needed' : 'advisory: no effect'],
  ];
  for (const [label, d, note] of rows) {
    lines.push(...fit(c, MARGIN + padRight(label, 22) + (note ? padRight(decisionBadge(st, d), 12) : decisionBadge(st, d)), note, (s) => st.dim(s), hangFor(c, 34)));
  }
  lines.push(...para(c, `Interpretation policy: ${ip.mandatory ? `MANDATORY (if unusable, at least ${ip.onFailure})` : 'advisory (the local model cannot change the decision)'}`, MARGIN).map((l) => st.dim(l)));

  // short reasons built from the structured result
  lines.push('', ...subheading(c, 'Why'));
  const th = a.decision.thresholds;
  const why: string[] = [
    `Safety score ${f3(a.safetyScore)} maps to ${a.preliminaryDecision} (ALLOW from ${f3(th.allowAtOrAbove)}, ESCALATE from ${f3(th.escalateAtOrAbove)}; provisional thresholds).`,
  ];
  for (const g of a.gates.triggered) {
    why.push(`${GATE_LABELS[g.gate] ?? g.gate} gate ${g.status === 'FAIL' ? 'FAILED' : 'has UNKNOWN evidence'} and requires ${g.consequence}: ${g.explanation}`);
  }
  if (a.gates.triggered.length === 0) why.push('No Critical Safety Gate was triggered.');
  if (a.interpretationRaisedDecision) why.push(`The interpretation policy raised ${a.deterministicDecision} to ${a.finalDecision} because the mandatory interpretation was ${a.interpretation.status}.`);
  lines.push(...bullets(c, why, { tint: true }));

  lines.push('', ...subheading(c, 'Reason codes'));
  for (const [name, members] of groupReasonCodes(a.reasonCodes)) {
    lines.push(...keyValue(c, name, members.join(' '), 16));
  }

  lines.push('', ...subheading(c, 'Full explanation'));
  lines.push(...bullets(c, sentences(a.explanation)).map((l) => st.dim(l)));
  return lines;
}

function gapSection(c: Ctx, a: AssessmentSuccess): string[] {
  const { st } = c;
  const label = (id: string): string => FACTORS.find((f) => f.id === id)?.label ?? id;
  const strip = (s: string): string => s.replace(/^\[[A-Za-z]+\]\s*/, '');
  const byFactor = new Map<string, Array<[string, string]>>();
  const add = (kind: string, items: readonly string[]): void => {
    for (const raw of items) {
      const m = raw.match(/^\[([A-Za-z]+)\]/);
      const key = m ? m[1] : 'other';
      byFactor.set(key, [...(byFactor.get(key) ?? []), [kind, strip(raw)]]);
    }
  };
  add('missing', a.evidenceGaps.missing);
  add('unknown', a.evidenceGaps.uncertain);
  add('conflict', a.evidenceGaps.conflicts);
  const total = a.evidenceGaps.missing.length + a.evidenceGaps.uncertain.length + a.evidenceGaps.conflicts.length;

  const lines: string[] = ['', ...headingLines(c, 'Details')];
  if (total === 0) lines.push(...para(c, 'No missing, unknown or conflicting evidence was reported by the assessors.', MARGIN));
  else {
    lines.push(...subheading(c, `Missing, unknown or conflicting evidence (${total}):`));
    for (const [factor, entries] of byFactor) {
      lines.push(MARGIN + st.paint(label(factor), 'cyan'));
      for (const [kind, text] of entries.slice(0, MAX_GAPS_PER_GROUP)) {
        const tone: Tone = kind === 'conflict' ? 'red' : 'yellow';
        const tag = padRight(kind, 9);
        const body = wrapText(text, c.width, MARGIN + '      ' + ' '.repeat(9), MARGIN + '    ' + tag);
        lines.push(MARGIN + '    ' + st.paint(tag, tone) + body[0].slice(MARGIN.length + 4 + 9), ...body.slice(1));
      }
      if (entries.length > MAX_GAPS_PER_GROUP) lines.push(st.dim(`${MARGIN}    ... and ${entries.length - MAX_GAPS_PER_GROUP} more`));
    }
  }
  if (a.assumptions.length > 0) {
    lines.push('', ...subheading(c, 'Assumptions made because the input was silent:'), ...bullets(c, a.assumptions));
  }
  if (a.limitations.length > 0) lines.push('', ...subheading(c, `Limitations (${a.limitations.length}):`), ...bullets(c, a.limitations, { max: MAX_LIMITATIONS_SHOWN }));
  return lines;
}

function failureSection(c: Ctx, r: AssessmentSessionResult): string[] {
  const { st } = c;
  const a = r.assessment;
  if (a.status !== 'FAILED') return [];
  const lines: string[] = ['', ...headingLines(c, 'Assessment failed')];
  lines.push(...para(c, `ASSESSMENT FAILED at stage "${a.stage}" (${a.failureKind === 'invalid_input' ? 'invalid input' : 'internal error'}): ${a.reason}`, MARGIN).map((l) => st.paint(l, 'red', { bold: true })));
  lines.push(...para(c, 'No decision was made. This is a failure of the assessment, NOT a BLOCK decision, and it must not be read as one.', MARGIN).map((l) => st.paint(l, 'red')));
  const limits = r.evidence.limitations;
  if (limits.length > 0) lines.push('', ...subheading(c, `Limitations (${limits.length}):`), ...bullets(c, limits, { max: MAX_LIMITATIONS_SHOWN }));
  return lines;
}

function noticeSection(c: Ctx, r: AssessmentSessionResult): string[] {
  const { st } = c;
  const lines: string[] = ['', ...headingLines(c, 'Pipeline and notices')];
  for (const s of r.stages) {
    const ok = s.status === 'connected';
    lines.push(...fit(c, MARGIN + st.paint(padRight(ok ? '[connected]' : '[not implemented]', 19), ok ? 'green' : 'yellow'), s.name, (x) => x, hangFor(c, 19)));
  }
  lines.push('');
  if (r.assessment.status !== 'FAILED') lines.push(...para(c, `Provisional policy notice: ${r.assessment.provisionalNotice}`, MARGIN + '  ', MARGIN).map((l) => st.paint(l, 'yellow')));
  lines.push(...para(c, 'Assessment only: the proposed action was NOT executed.', MARGIN + '  ', MARGIN));
  lines.push(
    ...para(c, `Signed Evidence Pack: ${r.evidencePack.requestedPath ? `--output ${r.evidencePack.requestedPath} was given. ` : ''}${r.evidencePack.reason}`, MARGIN + '  ', MARGIN).map((l) => st.paint(l, 'yellow')),
  );
  lines.push(...para(c, 'Signature verification and audit history are not implemented either; nothing here is signed or recorded.', MARGIN + '  ', MARGIN).map((l) => st.dim(l)));
  lines.push('');
  return lines;
}

/**
 * Builds the report. `options` decides color, Unicode and width; the default is
 * plain, escape-free ASCII at 80 columns so the function stays deterministic.
 * The command handler passes detectRenderOptions() so real terminals get styling.
 */
export function renderAssessment(r: AssessmentSessionResult, options: RenderOptions = PLAIN_OPTIONS): string[] {
  const c: Ctx = { st: createStyle(options), width: options.width };
  const a = r.assessment;
  const lines: string[] = [...headerSection(c, r)];
  if (a.status !== 'FAILED') lines.push(...scoreSection(c, a), ...factorSection(c, a), ...gateSection(c, a));
  lines.push(...evidenceSection(c, r), ...interpretationSection(c, r.interpretation));
  if (a.status === 'FAILED') lines.push(...failureSection(c, r));
  else lines.push(...decisionSection(c, a), ...gapSection(c, a));
  lines.push(...noticeSection(c, r));
  return lines;
}
