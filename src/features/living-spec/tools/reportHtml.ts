/**
 * Interactive, self-contained HTML artifact for one analysis report.
 *
 * WHY: the JSON report is the machine contract — this is the human artefact.
 * One `<html>` document per analysis with everything the run produced
 * (files, implications, drift, proposals/URS patch, test deltas, impact
 * summary, drift alerts, quality + any behaviour summary / inference error),
 * styled with inline CSS and a few lines of vanilla JS:
 *   - anchor TOC + collapsible sections (<details>),
 *   - a live filter box narrowing the tables (data-search rows),
 *   - colour-coded drift / severity chips (light + dark via prefers-color-scheme).
 *
 * Deliberately DEPENDENCY-FREE and OFFLINE-SAFE: no CDN, no fonts, no
 * external URLs — an artifact opens from disk in any browser. Everything
 * model- or code-derived is HTML-escaped (the content includes arbitrary
 * source code, so an unescaped `<script>` in a diff would otherwise execute).
 */

import type {
  SpecAnalysisResult,
  SpecChangeDriftAlert,
  SpecImplication,
  SpecTestCaseDelta,
  SpecUrsPatchEntry,
} from '../pipeline/types.js';

// ── escaping + naming ─────────────────────────────────────────────────

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML-escapes any value (text nodes AND attribute contexts). */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function slugify(input: string, max = 24): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug;
}

/**
 * Human-readable, sortable, collision-safe file name for one analysis:
 * `analyze-<YYYYMMDD-HHMMSS>-<firstFileSlug>-<changeId8>.html`
 * e.g. `analyze-20261018-060851-greet-5e9beb9e.html`.
 */
export function reportHtmlFileName(result: SpecAnalysisResult): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(result.timestamp ?? '');
  const stamp = m ? `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}` : 'unknown-time';
  const firstPath = result.files[0]?.path ?? '';
  const base = firstPath.split('/').pop() ?? '';
  const fileSlug = slugify(base.replace(/\.[^.]+$/, ''), 20) || (firstPath ? 'file' : 'no-changes');
  const id8 = slugify(result.changeId.slice(0, 8), 8) || '00000000';
  return `analyze-${stamp}-${fileSlug}-${id8}.html`;
}

// ── small view helpers ────────────────────────────────────────────────

const DRIFT_CLASS: Record<string, string> = {
  conflicting: 'chip-red',
  modified: 'chip-amber',
  new: 'chip-blue',
  aligned: 'chip-green',
  'no-semantic-change': 'chip-gray',
};

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'chip-red',
  warning: 'chip-amber',
  info: 'chip-gray',
};

const OP_CLASS: Record<string, string> = { add: 'chip-green', modify: 'chip-amber', remove: 'chip-red' };

function chip(text: string, cls: string): string {
  return `<span class="chip ${cls}">${escapeHtml(text)}</span>`;
}

function confidenceCell(confidence: number): string {
  const pct = Math.round(confidence * 100);
  return (
    `<td><span class="bar"><span class="bar-fill" style="width:${pct}%"></span></span> ` +
    `${pct}%</td>`
  );
}

function details(id: string, summaryHtml: string, body: string, open = false): string {
  return (
    `<details class="card" id="${escapeHtml(id)}"${open ? ' open' : ''}>` +
    `<summary>${summaryHtml}</summary>${body}</details>`
  );
}

// ── section builders ──────────────────────────────────────────────────

function filesSection(result: SpecAnalysisResult): string {
  const rows = result.files
    .map(
      (f) =>
        `<tr data-search><td><code>${escapeHtml(f.path)}</code></td><td class="num">${f.lines}</td></tr>`,
    )
    .join('');
  const body =
    result.files.length === 0
      ? '<p class="muted">No files changed in this analysis.</p>'
      : `<table><thead><tr><th>File</th><th>Changed lines</th></tr></thead><tbody>${rows}</tbody></table>`;
  return details(
    'files',
    `Files changed <span class="count">${result.files.length}</span>`,
    body,
    true,
  );
}

function implicationsSection(result: SpecAnalysisResult): string {
  const rows = result.implications
    .map(
      (imp: SpecImplication) => `
      <tr data-search>
        <td>${chip(imp.kind, imp.kind === 'nfr' ? 'chip-blue' : 'chip-green')}</td>
        <td>${escapeHtml(imp.category ?? '—')}</td>
        <td><code>${escapeHtml(imp.id)}</code></td>
        <td>${confidenceCell(imp.confidence)}</td>
        <td class="wide">${escapeHtml(imp.text)}
          <div class="muted refs">sources: ${imp.sourceRefs.map((r) => `<code>${escapeHtml(r)}</code>`).join(', ') || '—'}</div>
          ${imp.rationale ? `<div class="muted">why: ${escapeHtml(imp.rationale)}</div>` : ''}
        </td>
      </tr>`,
    )
    .join('');
  const body =
    result.implications.length === 0
      ? '<p class="muted">No requirement implications (deterministic analysis only).</p>'
      : `<table><thead><tr><th>Kind</th><th>Category</th><th>Id</th><th>Confidence</th><th>Requirement</th></tr></thead><tbody>${rows}</tbody></table>`;
  return details(
    'implications',
    `Requirement implications <span class="count">${result.implications.length}</span>`,
    body,
    true,
  );
}

function patchEntry(e: SpecUrsPatchEntry): string {
  return `
    <tr data-search>
      <td>${chip(e.op, OP_CLASS[e.op] ?? 'chip-gray')}</td>
      <td><code>${escapeHtml(e.sectionId)}</code></td>
      <td class="wide"><details><summary class="muted">markdown</summary><pre><code>${escapeHtml(
        e.markdown || '(empty)',
      )}</code></pre></details></td>
    </tr>`;
}

function patchSection(result: SpecAnalysisResult): string {
  const entries = result.ursPatch.entries;
  const body = `
    <p>${escapeHtml(result.ursPatch.summary)}</p>
    ${
      entries.length === 0
        ? '<p class="muted">No URS updates proposed by this change.</p>'
        : `<table><thead><tr><th>Op</th><th>Section</th><th>Markdown</th></tr></thead><tbody>${entries
            .map(patchEntry)
            .join('')}</tbody></table>`
    }
    ${
      result.proposalIds && result.proposalIds.length > 0
        ? `<p class="muted">Pending proposals: ${result.proposalIds
            .map((id) => `<code>${escapeHtml(id)}</code>`)
            .join(', ')} — decide with <code>codexrev spec accept|reject|defer &lt;id&gt;</code></p>`
        : ''
    }`;
  return details(
    'patch',
    `URS patch &amp; proposals <span class="count">${entries.length}</span>`,
    body,
    entries.length > 0,
  );
}

function deltaRow(d: SpecTestCaseDelta): string {
  const typeCls = d.type === 'new' ? 'chip-green' : d.type === 'obsolete' ? 'chip-red' : 'chip-amber';
  return `
    <tr data-search>
      <td>${chip(d.type, typeCls)}</td>
      <td>${escapeHtml(d.priority)}</td>
      <td><code>${escapeHtml(d.id)}</code></td>
      <td><code>${escapeHtml(d.linkedRequirementId)}</code>
        <div class="muted">verifies <code>${escapeHtml(d.linkedImplicationId)}</code></div></td>
      <td class="wide">${escapeHtml(d.title)}
        <details><summary class="muted">steps &amp; expectations</summary>
          <p><strong>Preconditions</strong></p>
          <ol>${d.preconditions.map((p) => `<li>${escapeHtml(p)}</li>`).join('') || '<li class="muted">—</li>'}</ol>
          <p><strong>Steps</strong></p>
          <ol>${d.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
          <p><strong>Expected</strong> ${escapeHtml(d.expected)}</p>
          <p class="muted">${escapeHtml(d.rationale)}</p>
        </details>
      </td>
    </tr>`;
}

function deltasSection(result: SpecAnalysisResult): string {
  const rows = result.testDeltas.map(deltaRow).join('');
  const body =
    result.testDeltas.length === 0
      ? '<p class="muted">No incremental test-case deltas for this change.</p>'
      : `<table><thead><tr><th>Type</th><th>Priority</th><th>Delta id</th><th>Requirement</th><th>Title</th></tr></thead><tbody>${rows}</tbody></table>`;
  return details(
    'deltas',
    `Test-case deltas <span class="count">${result.testDeltas.length}</span>`,
    body,
    result.testDeltas.length > 0,
  );
}

function impactSection(result: SpecAnalysisResult): string {
  const i = result.impactSummary;
  const files = i.affectedFiles
    .map(
      (f) =>
        `<li><code>${escapeHtml(f.path)}${
          f.lines.length > 0 ? `:${f.lines.join(', ')}` : ''
        }</code></li>`,
    )
    .join('');
  const body = `
    <dl class="grid">
      <dt>Affected requirements</dt>
      <dd>${
        i.affectedRequirementIds.length > 0
          ? i.affectedRequirementIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')
          : '<span class="muted">(none)</span>'
      }</dd>
      <dt>Confidence</dt><dd>${(i.confidence * 100).toFixed(0)}%</dd>
      <dt>Recommended next action</dt><dd>${escapeHtml(i.recommendedNextAction)}</dd>
      <dt>Affected files &amp; lines</dt><dd>${
        files ? `<ul class="tight">${files}</ul>` : '<span class="muted">(none)</span>'
      }</dd>
    </dl>`;
  return details('impact', 'Change-impact summary', body, true);
}

function alertCard(a: SpecChangeDriftAlert): string {
  return `
    <div class="alert ${SEVERITY_CLASS[a.severity] ?? 'chip-gray'}" data-search>
      ${chip(a.severity.toUpperCase(), SEVERITY_CLASS[a.severity] ?? 'chip-gray')}
      <code>${escapeHtml(a.file)}</code>
      <p>${escapeHtml(a.reason)}</p>
      <p class="muted">→ ${escapeHtml(a.proposedNextAction)}</p>
      <p class="muted"><code>${escapeHtml(a.changeId.slice(0, 12))}</code> · ${escapeHtml(a.timestamp)}</p>
    </div>`;
}

function alertsSection(result: SpecAnalysisResult): string {
  const body =
    result.driftAlerts.length === 0
      ? '<p class="muted">No drift alerts — nothing to reconcile.</p>'
      : `<div class="grid-alerts">${result.driftAlerts.map(alertCard).join('')}</div>`;
  return details(
    'alerts',
    `Drift alerts <span class="count">${result.driftAlerts.length}</span>`,
    body,
    result.driftAlerts.length > 0,
  );
}

function qualitySection(result: SpecAnalysisResult, opts: RenderHtmlOptions): string {
  const q = result.quality;
  const usage = q.usage
    ? ` · tokens ${q.usage.inputTokens ?? '?'} in / ${q.usage.outputTokens ?? '?'} out / ${q.usage.totalTokens ?? '?'} total`
    : '';
  const error = result.inferenceError
    ? `<div class="banner banner-red"><strong>Model output was NOT applied (${escapeHtml(
        result.inferenceError.code,
      )}, retryable: ${result.inferenceError.retryable ? 'yes' : 'no'})</strong><br>${escapeHtml(
        result.inferenceError.message,
      )}<br><span class="muted">The deterministic analysis stands (NFR5) — nothing invalid was persisted.</span></div>`
    : '';
  const behaviour = result.behaviourChangeSummary
    ? `<dt>Behaviour change</dt><dd>${escapeHtml(result.behaviourChangeSummary)}</dd>`
    : '<dt>Behaviour change</dt><dd><span class="muted">not evaluated (deterministic run)</span></dd>';
  const ursUpdate =
    result.requiresUrsUpdate === null || result.requiresUrsUpdate === undefined
      ? '<dd><span class="muted">not evaluated</span></dd>'
      : `<dd>${result.requiresUrsUpdate ? chip('required', 'chip-amber') : chip('not required', 'chip-green')}</dd>`;
  const body = `
    ${error}
    <dl class="grid">
      <dt>Model</dt><dd><code>${escapeHtml(q.model)}</code>${escapeHtml(usage)}</dd>
      <dt>Latency</dt><dd>${q.latencyMs} ms</dd>
      <dt>Schema valid</dt><dd>${q.schemaValid ? chip('yes', 'chip-green') : chip('no', 'chip-red')}</dd>
      ${behaviour}
      <dt>URS update</dt>${ursUpdate}
      ${opts.ref ? `<dt>Diff ref</dt><dd><code>${escapeHtml(opts.ref)}</code></dd>` : ''}
      ${
        opts.jsonFile
          ? `<dt>Machine report</dt><dd><a href="./${escapeHtml(opts.jsonFile)}"><code>${escapeHtml(
              opts.jsonFile,
            )}</code></a></dd>`
          : ''
      }
    </dl>`;
  return details('quality', 'Quality &amp; metadata', body, false);
}

// ── the document ──────────────────────────────────────────────────────

export interface RenderHtmlOptions {
  /** Git ref analysed (staged, HEAD~1, …) when known. */
  readonly ref?: string;
  /** Sibling JSON file name for the cross-link (no directory). */
  readonly jsonFile?: string;
}

const STYLE = `
:root{--bg:#f7f8fa;--card:#fff;--fg:#1c2128;--muted:#5b6570;--line:#d8dde3;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--accent:#4493f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:8px 0 4px}
h2{font-size:18px;margin:28px 0 8px}
a{color:var(--accent)}
code{background:rgba(127,127,127,.14);padding:1px 5px;border-radius:4px;font:13px ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
pre{background:rgba(127,127,127,.12);padding:10px;border-radius:6px;overflow:auto}
.muted{color:var(--muted);font-size:13px}
.refs code{margin-right:4px}
.chip{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;margin-right:6px}
.chip-red{background:#ffdddd;color:#8b0000}.chip-amber{background:#fff1cc;color:#7a5200}
.chip-green{background:#dcffe4;color:#0a6b2d}.chip-blue{background:#ddf4ff;color:#0a5a9e}
.chip-gray{background:rgba(127,127,127,.2);color:var(--muted)}
@media (prefers-color-scheme:dark){.chip-red{background:#4c1518;color:#ff9d9d}.chip-amber{background:#4a3a10;color:#ffd47f}.chip-green{background:#12351f;color:#7ee2a8}.chip-blue{background:#12283f;color:#8ac6ff}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
details.card>summary,details>summary{cursor:pointer;font-weight:600}
.count{background:rgba(127,127,127,.18);border-radius:999px;padding:0 8px;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}
td.num{text-align:right;white-space:nowrap}
td.wide{min-width:280px}
.bar{display:inline-block;width:70px;height:8px;background:rgba(127,127,127,.25);border-radius:6px;overflow:hidden;vertical-align:middle}
.bar-fill{display:block;height:100%;background:var(--accent)}
.grid{display:grid;grid-template-columns:190px 1fr;gap:6px 14px;margin:4px 0}
.grid dt{color:var(--muted);font-size:13px}
.grid dd{margin:0}
.grid-alerts{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.alert{border:1px solid var(--line);border-left-width:5px;border-radius:8px;padding:8px 12px}
.alert p{margin:6px 0 2px}
ul.tight{margin:0;padding-left:18px}
.banner{border-radius:8px;padding:10px 12px;margin:8px 0}
.banner-red{background:#ffdddd;color:#8b0000;border:1px solid #e5a0a0}
@media (prefers-color-scheme:dark){.banner-red{background:#3d1416;color:#ffb3b3;border-color:#6e2024}}
nav.toc{position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:10px;font-size:13px}
#q{flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0 2px}
footer{color:var(--muted);font-size:12px;margin-top:36px;border-top:1px solid var(--line);padding-top:10px}
`;

const SCRIPT = `
document.getElementById('q').addEventListener('input', function () {
  var q = this.value.trim().toLowerCase();
  document.querySelectorAll('tr[data-search], .alert[data-search]').forEach(function (row) {
    row.style.display = !q || row.textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
  });
});
`;

/** Renders the complete interactive HTML artifact for one analysis. */
export function renderAnalysisHtml(
  result: SpecAnalysisResult,
  opts: RenderHtmlOptions = {},
): string {
  const fileName = reportHtmlFileName(result);
  const driftCls = DRIFT_CLASS[result.driftStatus] ?? 'chip-gray';
  const toc: Array<[string, string]> = [
    ['#overview', 'Overview'],
    ['#files', 'Files'],
    ['#implications', 'Implications'],
    ['#patch', 'Patch'],
    ['#deltas', 'Deltas'],
    ['#impact', 'Impact'],
    ['#alerts', 'Alerts'],
    ['#quality', 'Quality'],
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(result.changeId.slice(0, 12))} — Living Spec analysis</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header id="overview">
    <div class="muted">Living Specification Engine — analysis report</div>
    <h1>${chip(result.driftStatus, driftCls)} change <code>${escapeHtml(result.changeId.slice(0, 16))}</code></h1>
    <div class="meta">
      <span class="muted">at</span> <code>${escapeHtml(result.timestamp)}</code>
      ${opts.ref ? `<span class="muted">ref</span> <code>${escapeHtml(opts.ref)}</code>` : ''}
      ${result.files.length > 0 ? `<span class="muted">· ${result.files.length} file(s)</span>` : ''}
      ${result.proposalIds?.length ? `<span class="muted">· ${result.proposalIds.length} proposal(s)</span>` : ''}
    </div>
    ${
      result.behaviourChangeSummary
        ? `<p><strong>Behaviour:</strong> ${escapeHtml(result.behaviourChangeSummary)}</p>`
        : ''
    }
    <nav class="toc">
      <input id="q" type="search" placeholder="Filter rows (files, implications, deltas, alerts)…" aria-label="Filter">
      ${toc.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
    </nav>
  </header>

  ${filesSection(result)}
  ${implicationsSection(result)}
  ${patchSection(result)}
  ${deltasSection(result)}
  ${impactSection(result)}
  ${alertsSection(result)}
  ${qualitySection(result, opts)}

  <footer>
    Generated by <strong>codexrev</strong> · artefact <code>${escapeHtml(fileName)}</code>
    · full change id <code>${escapeHtml(result.changeId)}</code>
    · JSON contract: <code>src/features/living-spec/pipeline/types.ts</code>
  </footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
