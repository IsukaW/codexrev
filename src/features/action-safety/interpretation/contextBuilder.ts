/**
 * Builds the data block that is sent to the model. This file decides exactly
 * what the model gets to see, so everything here is conservative:
 *
 *   - bounded: file counts, diff excerpts, evidence entries and total size all
 *     have hard caps, and a too-large prompt is refused rather than sent
 *   - no secrets: files that look sensitive (.env, keys...) are listed by name
 *     only and their contents are never read; secret-looking values in every
 *     string that is sent are masked first
 *   - read-only: diff excerpts come from `git diff` with the same hardened,
 *     read-only git handle the collectors use
 *   - untrusted: all of it is repository content, report content or user text,
 *     so it is scanned for text that tries to instruct the model; matches are
 *     reported, and the prompt wraps the data so the model is told to treat it
 *     as data (see prompt.ts)
 *
 * The result also carries the set of references a model observation may
 * legitimately cite (evidence ids and listed file paths); anything else the
 * model cites is fabricated and gets rejected.
 */

import type { EvidenceBundle } from '../collectors/evidenceOrchestrator.js';
import { createReadOnlyGit, isSensitivePath, type ChangedFile, type GitCollection } from '../collectors/gitCollector.js';
import { readProjectTextFile } from '../collectors/safeFiles.js';
import { clip } from '../collectors/types.js';
import type { PromptStats } from './types.js';

export interface InterpretationLimits {
  /** changed files listed by name */
  readonly maxFiles: number;
  /** files whose diff text is included */
  readonly maxDiffFiles: number;
  readonly maxDiffCharsPerFile: number;
  readonly maxDiffCharsTotal: number;
  readonly maxLineChars: number;
  readonly maxDependencyChanges: number;
  readonly maxEvidenceRecords: number;
  readonly maxFindings: number;
  readonly maxTextChars: number;
  /** the whole serialized data block; above this even after shrinking, nothing is sent */
  readonly maxPromptChars: number;
}

export const DEFAULT_INTERPRETATION_LIMITS: InterpretationLimits = {
  maxFiles: 200,
  maxDiffFiles: 12,
  maxDiffCharsPerFile: 3_000,
  maxDiffCharsTotal: 24_000,
  maxLineChars: 300,
  maxDependencyChanges: 50,
  maxEvidenceRecords: 60,
  maxFindings: 20,
  maxTextChars: 300,
  maxPromptChars: 60_000,
};

// ---------------------------------------------------------------- secrets

const REDACTED = '[REDACTED]';

// long mixed-case alphanumeric blobs look like keys or tokens
const BLOB = /\b(?=[A-Za-z0-9+/_=-]{32,}\b)(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)[A-Za-z0-9+/_=-]{32,}\b/g;

/** Masks secret-looking values in a string. Conservative and pattern-based: it cannot recognise every secret,
 * which is why sensitive FILES are never read at all and why this is only one layer of protection. */
export function maskSecrets(input: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = input;
  const apply = (pattern: RegExp, fn: (...m: string[]) => string): void => {
    out = out.replace(pattern, (...m: unknown[]) => {
      redactions++;
      return fn(...(m as string[]));
    });
  };
  apply(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => '[REDACTED PRIVATE KEY]');
  apply(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, () => '[REDACTED PRIVATE KEY]');
  for (const re of [
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  ]) {
    apply(re, () => REDACTED);
  }
  apply(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, () => `Bearer ${REDACTED}`);
  apply(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, (_m, scheme) => `${scheme}${REDACTED}@`);
  apply(
    /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi,
    (_m, key, sep) => `${key}${sep}${REDACTED}`,
  );
  apply(BLOB, () => REDACTED);
  return { text: out, redactions };
}

// ---------------------------------------------------------------- prompt-injection indicators

const INJECTION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ignore-previous-instructions', /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i],
  ['disregard-instructions', /disregard\s+(?:the\s+|all\s+)?(?:above|previous|prior|system|instructions?)/i],
  ['role-reassignment', /\byou\s+are\s+now\b|\bact\s+as\s+(?:an?\s+)?(?:unrestricted|different|new)\b/i],
  ['system-prompt-reference', /\bsystem\s+prompt\b|\bnew\s+instructions?\s*:|\bupdated\s+instructions?\s*:/i],
  ['approval-demand', /\b(?:approve|allow|authori[sz]e|greenlight)\s+(?:this|the)\s+(?:deployment|change|action|release|migration)\b/i],
  ['decision-override', /\boverride\s+(?:the\s+)?(?:safety|gates?|decision|policy)\b|\bmark\s+(?:this\s+)?as\s+safe\b/i],
  ['fake-delimiter-or-role-tag', /<\/?(?:system|assistant|instructions?)>|UNTRUSTED_DATA/i],
];

function scanForInjection(location: string, value: string, into: string[]): void {
  for (const [name, pattern] of INJECTION_PATTERNS) {
    if (pattern.test(value) && into.length < 20) into.push(`${location}: ${name}`);
  }
}

// ---------------------------------------------------------------- diff excerpts

interface DiffExcerpt {
  readonly path: string;
  readonly change: string;
  readonly excerpt: string;
  readonly truncated: boolean;
}

const LOW_VALUE_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.min\.(js|css)$|\.map$/i;

// files most relevant to deployment risk first, so a small excerpt budget is spent where it matters
function relevanceRank(p: string): number {
  if (/(^|\/)(migrations?|db|schema|sql)(\/|$)|\.sql$/i.test(p)) return 0;
  if (/dockerfile|\.ya?ml$|\.tf$|terraform|helm|k8s|kubernetes|deploy|infra/i.test(p)) return 1;
  if (/auth|secur|crypt|password|token|permission|rbac|acl/i.test(p)) return 1;
  if (/(^|\/)package\.json$/.test(p)) return 2;
  if (p.startsWith('src/')) return 3;
  return 4;
}

function clipLines(text: string, maxLine: number): string {
  return text
    .split('\n')
    .map((l) => (l.length > maxLine ? `${l.slice(0, maxLine)} …[line cut]` : l))
    .join('\n');
}

async function readDiffExcerpts(
  git: GitCollection,
  limits: InterpretationLimits,
  limitations: string[],
): Promise<{ excerpts: DiffExcerpt[]; omitted: number }> {
  if (git.state !== 'collected' || !git.repoRoot) return { excerpts: [], omitted: 0 };
  const withheld = new Set(git.excluded.map((e) => e.path));
  const candidates = git.files
    .filter((f) => !withheld.has(f.path) && !isSensitivePath(f.path) && !LOW_VALUE_FILE.test(f.path))
    .sort((a, b) => relevanceRank(a.path) - relevanceRank(b.path) || (a.path < b.path ? -1 : 1));

  const base = git.diffBase ?? git.head;
  const gitHandle = createReadOnlyGit(git.repoRoot);
  const excerpts: DiffExcerpt[] = [];
  let used = 0;
  let readFailed = false;

  for (const f of candidates) {
    if (excerpts.length >= limits.maxDiffFiles || used >= limits.maxDiffCharsTotal) break;
    let body: string | undefined;
    try {
      if (base && f.change !== 'untracked') {
        const out = await gitHandle.raw(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '-U2', base, '--', f.path]);
        const at = out.indexOf('@@');
        body = at >= 0 ? out.slice(at) : undefined; // drop the header; keep the hunks
      } else {
        const read = await readProjectTextFile(git.repoRoot, `${git.repoRoot}/${f.path}`, 100_000);
        if (read.ok) body = read.text.split('\n').map((l) => `+${l}`).join('\n');
      }
    } catch {
      readFailed = true;
    }
    if (!body || body.trim() === '') continue;

    let excerpt = clipLines(body, limits.maxLineChars);
    let truncated = false;
    const room = Math.min(limits.maxDiffCharsPerFile, limits.maxDiffCharsTotal - used);
    if (excerpt.length > room) {
      excerpt = excerpt.slice(0, room);
      truncated = true;
    }
    used += excerpt.length;
    excerpts.push({ path: f.path, change: f.change, excerpt, truncated });
  }
  if (readFailed) limitations.push('some diffs could not be read and are not part of the context');
  return { excerpts, omitted: Math.max(0, candidates.length - excerpts.length) };
}

// ---------------------------------------------------------------- context

export interface PromptContext {
  /** JSON-serializable, already masked and bounded */
  readonly data: Record<string, unknown>;
  /** the only references an observation may cite: evidence record ids and listed file paths */
  readonly allowedReferences: ReadonlySet<string>;
  readonly stats: Omit<PromptStats, 'promptChars'>;
  readonly injectionIndicators: readonly string[];
  readonly limitations: readonly string[];
  /** true when the data was still over the size cap after every shrinking step */
  readonly tooLarge: boolean;
}

export interface BuildContextOptions {
  readonly limits?: Partial<InterpretationLimits>;
  /** set false to skip reading diff text entirely (file names and summaries only) */
  readonly includeDiffs?: boolean;
}

function fileEntry(f: ChangedFile, withheldReason: string | undefined, maxText: number): Record<string, unknown> {
  return {
    path: clip(f.path, maxText),
    change: f.change,
    staged: f.staged,
    unstaged: f.unstaged,
    untracked: f.untracked,
    ...(f.insertions !== undefined ? { insertions: f.insertions, deletions: f.deletions } : {}),
    module: f.module,
    ...(withheldReason ? { contentWithheld: withheldReason } : {}),
  };
}

export async function buildPromptContext(bundle: EvidenceBundle, options: BuildContextOptions = {}): Promise<PromptContext> {
  const limits: InterpretationLimits = { ...DEFAULT_INTERPRETATION_LIMITS, ...options.limits };
  const limitations: string[] = [];
  const g = bundle.git;
  const withheld = new Map(g.excluded.map((e) => [e.path, e.reason]));
  const listedFiles = g.files.slice(0, limits.maxFiles);
  const diffs =
    options.includeDiffs === false ? { excerpts: [] as DiffExcerpt[], omitted: g.files.length } : await readDiffExcerpts(g, limits, limitations);

  const dep = bundle.dependencies;
  const records = bundle.records.slice(0, limits.maxEvidenceRecords);
  const findings = bundle.records
    .filter((r) => r.type === 'security_findings')
    .flatMap((r) => (Array.isArray(r.details?.findings) ? (r.details?.findings as Array<Record<string, unknown>>) : []))
    .slice(0, limits.maxFindings)
    .map((f) => ({ id: f.id, severity: f.severity, file: f.file, description: typeof f.description === 'string' ? clip(f.description, limits.maxTextChars) : undefined }));

  const stated = bundle.statedAction;
  const build = (diffExcerpts: DiffExcerpt[], files: ChangedFile[], recs: typeof records): Record<string, unknown> => ({
    proposedAction: {
      type: bundle.request.actionType,
      environment: bundle.request.environment,
      ...(stated.impact !== undefined ? { statedImpact: stated.impact } : {}),
      ...(stated.irreversible !== undefined ? { statedIrreversible: stated.irreversible } : {}),
      ...(stated.destructive !== undefined ? { statedDestructive: stated.destructive } : {}),
      ...(stated.description !== undefined ? { statedDescription: clip(stated.description, limits.maxTextChars) } : {}),
    },
    git: {
      state: g.state,
      ...(g.branch ? { branch: clip(g.branch, 100) } : {}),
      ...(g.diffRef ? { comparedWith: clip(g.diffRef, 100) } : {}),
      counts: g.counts,
      modules: g.modules.slice(0, 50).map((m) => clip(m, 100)),
      files: files.map((f) => fileEntry(f, withheld.get(f.path), limits.maxTextChars)),
      filesNotListed: Math.max(0, g.files.length - files.length),
    },
    diffExcerpts: diffExcerpts.map((d) => ({ path: clip(d.path, limits.maxTextChars), change: d.change, excerpt: d.excerpt, truncated: d.truncated })),
    dependencies: {
      state: dep.state,
      compatibility: dep.compatibility,
      manifestsChanged: dep.manifestsChanged,
      lockfilesChanged: dep.lockfilesChanged,
      unparsedManifests: dep.unparsedManifests,
      counts: dep.counts,
      changes: dep.changes.slice(0, limits.maxDependencyChanges).map((c) => ({
        manifest: c.manifest, section: c.section, name: clip(c.name, 100), change: c.change, from: c.from, to: c.to, majorChange: c.majorChange,
      })),
      changesNotListed: Math.max(0, dep.changes.length - limits.maxDependencyChanges),
    },
    evidence: recs.map((r) => ({
      id: r.id,
      type: r.type,
      role: r.role,
      origin: r.origin,
      trusted: r.trusted,
      ...(r.stale !== undefined ? { stale: r.stale } : {}),
      status: r.status,
      summary: clip(r.summary, limits.maxTextChars),
      references: r.refs.slice(0, 10).map((x) => clip(x, 200)),
      limitations: r.limitations.slice(0, 3).map((l) => clip(l, limits.maxTextChars)),
    })),
    securityFindings: findings,
    collectionLimitations: bundle.limitations.slice(0, 20).map((l) => clip(l, limits.maxTextChars)),
  });

  // shrink, in order of least value, until the data fits; if it never does, nothing is sent
  let diffExcerpts = diffs.excerpts;
  let files = listedFiles;
  let recs = records;
  let data = build(diffExcerpts, files, recs);
  let size = JSON.stringify(data).length;
  let truncated = false;
  if (size > limits.maxPromptChars) {
    truncated = true;
    diffExcerpts = [];
    data = build(diffExcerpts, files, recs);
    size = JSON.stringify(data).length;
  }
  if (size > limits.maxPromptChars) {
    files = listedFiles.slice(0, 80);
    data = build(diffExcerpts, files, recs);
    size = JSON.stringify(data).length;
  }
  if (size > limits.maxPromptChars) {
    recs = records.slice(0, 30);
    data = build(diffExcerpts, files, recs);
    size = JSON.stringify(data).length;
  }
  const tooLarge = size > limits.maxPromptChars;
  if (truncated) limitations.push('the context was too large: diff excerpts were left out');
  if (files.length < g.files.length) limitations.push(`only ${files.length} of ${g.files.length} changed files are listed to the model`);
  if (diffs.omitted > 0 && diffExcerpts.length > 0) limitations.push(`${diffs.omitted} changed file(s) have no diff excerpt in the context`);

  // mask secrets in every string, then look for text that tries to instruct the model
  let redactions = 0;
  const injectionIndicators: string[] = [];
  const walk = (value: unknown, location: string): unknown => {
    if (typeof value === 'string') {
      scanForInjection(location, value, injectionIndicators);
      const masked = maskSecrets(value);
      redactions += masked.redactions;
      return masked.text;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${location}[${i}]`));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, location ? `${location}.${k}` : k)]));
    }
    return value;
  };
  const safeData = walk(data, '') as Record<string, unknown>;
  if (redactions > 0) limitations.push(`${redactions} secret-looking value(s) were masked before anything was sent`);
  if (g.excluded.some((e) => e.reason === 'sensitive')) limitations.push('sensitive files were listed by name only; their contents were never read');
  if (injectionIndicators.length > 0) {
    limitations.push(`${injectionIndicators.length} place(s) in the repository or reports contain text that tries to instruct the model; it was treated as data`);
  }

  const allowedReferences = new Set<string>([...bundle.records.map((r) => r.id), ...files.map((f) => f.path)]);
  return {
    data: safeData,
    allowedReferences,
    stats: {
      filesListed: files.length,
      filesOmitted: Math.max(0, g.files.length - files.length),
      diffFilesIncluded: diffExcerpts.length,
      diffFilesOmitted: diffs.omitted,
      redactions,
      truncated,
    },
    injectionIndicators,
    limitations,
    tooLarge,
  };
}
