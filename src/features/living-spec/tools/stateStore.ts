/**
 * Living Specification Engine — `.codexrev/living-spec/` state store.
 *
 * Layout created/owned by this module inside the *target* project:
 *
 *   <target-project>/.codexrev/living-spec/
 *     config.json     feature config (watched paths, debounce, model override)
 *     urs/            living URS markdown + json state
 *     versions/       versioned URS snapshots (one json per version)
 *     proposals/      pending accept/reject/defer proposals
 *     reports/        analysis outputs
 *
 * `config.json` is validated against a JSON schema with ajv + ajv-formats
 * on every read and write — a corrupt config fails fast with a
 * `LivingSpecConfigError` instead of silently watching the wrong paths.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsDefault from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { DEFAULT_DEBOUNCE_MS } from '../pipeline/changeBuffer.js';
import type { ImplicationsLabelFile } from '../pipeline/inferenceEngine.js';
import {
  parseUrsDocument,
  renderUrsMarkdown,
  serializeUrsDocument,
} from '../pipeline/ursModel.js';
import type {
  SpecAnalysisResult,
  SpecChangeDriftAlert,
  SpecProposal,
  SpecUrsState,
  SpecUrsVersion,
  UrsDocument,
} from '../pipeline/types.js';
import {
  LivingSpecConfigError,
  LivingSpecProposalError,
  LivingSpecStateError,
} from './errors.js';

// ajv-formats ships CommonJS: depending on the interop path the default
// import is the plugin itself or a module object holding it as `.default`.
const addFormats: FormatsPlugin =
  addFormatsDefault.default ?? (addFormatsDefault as unknown as FormatsPlugin);

export const LIVING_SPEC_DIRNAME = 'living-spec';
export const LIVING_SPEC_SUBDIRS = ['urs', 'versions', 'proposals', 'reports'] as const;

/** Re-exported so config consumers keep one source of truth (pipeline module). */
export { DEFAULT_DEBOUNCE_MS };
export const DEFAULT_WATCHED_PATHS: readonly string[] = ['**/*'];

/** Feature config persisted at `.codexrev/living-spec/config.json`. */
export interface LivingSpecConfig {
  readonly schemaVersion: 1;
  /** Glob patterns watched by `codexrev spec watch`. */
  readonly watchedPaths: readonly string[];
  /** Quiet period after a change batch before analysing it (ms). */
  readonly debounceMs: number;
  /**
   * Glob filter for analysed diff files (default: source files only — see
   * `DEFAULT_SOURCE_GLOBS` in the diff extractor).
   */
  readonly includePaths?: readonly string[];
  /** Context lines kept around each change in the minimal diff view. */
  readonly contextLines?: number;
  /** Diff truncation guard in bytes (default: 200 KB). */
  readonly maxBytes?: number;
  /** Optional model override (`<provider>/<model>`); falls back to settings. */
  readonly modelOverride?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const LIVING_SPEC_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'watchedPaths', 'debounceMs', 'createdAt', 'updatedAt'],
  properties: {
    schemaVersion: { const: 1 },
    watchedPaths: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    debounceMs: { type: 'integer', minimum: 0, maximum: 60_000 },
    includePaths: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    contextLines: { type: 'integer', minimum: 0, maximum: 100 },
    maxBytes: { type: 'integer', minimum: 1024, maximum: 104_857_600 },
    modelOverride: { type: 'string', minLength: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

let configValidator: ValidateFunction<LivingSpecConfig> | undefined;

function getConfigValidator(): ValidateFunction<LivingSpecConfig> {
  if (configValidator) return configValidator;
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  configValidator = ajv.compile<LivingSpecConfig>(LIVING_SPEC_CONFIG_SCHEMA);
  return configValidator;
}

/** Throws `LivingSpecConfigError` unless `raw` matches the config schema. */
export function validateLivingSpecConfig(raw: unknown): LivingSpecConfig {
  const validate = getConfigValidator();
  if (!validate(raw)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
      .join('; ');
    throw new LivingSpecConfigError(`invalid living-spec config: ${detail}`);
  }
  return raw as LivingSpecConfig;
}

export function defaultLivingSpecConfig(now: string = new Date().toISOString()): LivingSpecConfig {
  return {
    schemaVersion: 1,
    watchedPaths: [...DEFAULT_WATCHED_PATHS],
    debounceMs: DEFAULT_DEBOUNCE_MS,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Paths ──────────────────────────────────────────────────────────────

export function livingSpecDir(projectRoot: string): string {
  return path.join(projectRoot, '.codexrev', LIVING_SPEC_DIRNAME);
}

export function configPath(projectRoot: string): string {
  return path.join(livingSpecDir(projectRoot), 'config.json');
}

export function ursDir(projectRoot: string): string {
  return path.join(livingSpecDir(projectRoot), 'urs');
}

export function versionsDir(projectRoot: string): string {
  return path.join(livingSpecDir(projectRoot), 'versions');
}

export function proposalsDir(projectRoot: string): string {
  return path.join(livingSpecDir(projectRoot), 'proposals');
}

export function reportsDir(projectRoot: string): string {
  return path.join(livingSpecDir(projectRoot), 'reports');
}

/**
 * Append-only drift-alert log: `reports/alerts.jsonl`, one JSON alert per line
 * (FR9/NFR6). Newest entries at the end; never rewritten in place.
 */
export function alertsLogPath(projectRoot: string): string {
  return path.join(reportsDir(projectRoot), 'alerts.jsonl');
}

export function ursStatePath(projectRoot: string): string {
  return path.join(ursDir(projectRoot), 'state.json');
}

/**
 * Viewer-friendly PDF of the CURRENT living URS, regenerated alongside
 * `urs.md` + `urs.json` on every approved version (v0 bootstrap included).
 */
export function ursPdfPath(projectRoot: string): string {
  return path.join(ursDir(projectRoot), 'urs.pdf');
}

/** PDF twin of one version snapshot: `versions/v<N>.pdf`. */
export function versionPdfPath(projectRoot: string, version: number): string {
  return path.join(versionsDir(projectRoot), `v${version}.pdf`);
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function requireSafeId(id: string, kind: 'proposal' | 'version' | 'report'): string {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new LivingSpecProposalError(`unsafe ${kind} id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function proposalPath(projectRoot: string, id: string): string {
  return path.join(proposalsDir(projectRoot), `${requireSafeId(id, 'proposal')}.json`);
}

export function versionPath(projectRoot: string, version: number): string {
  return path.join(versionsDir(projectRoot), `v${version}.json`);
}

// ── Layout + config.json ───────────────────────────────────────────────

/**
 * Creates `<projectRoot>/.codexrev/living-spec/` with its subdirectories
 * (and a default `config.json` when none exists yet). Idempotent.
 */
export async function ensureStateDir(projectRoot: string): Promise<string> {
  const dir = livingSpecDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  for (const sub of LIVING_SPEC_SUBDIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  try {
    await fs.access(configPath(projectRoot));
  } catch {
    await writeConfig(projectRoot, defaultLivingSpecConfig());
  }
  return dir;
}

/** Reads + validates `config.json`; falls back to defaults when absent. */
export async function readConfig(projectRoot: string): Promise<LivingSpecConfig> {
  const file = configPath(projectRoot);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return validateLivingSpecConfig(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultLivingSpecConfig();
    if (err instanceof LivingSpecConfigError) throw err;
    throw new LivingSpecConfigError(`failed to read ${file}: ${(err as Error).message}`);
  }
}

/** Validates, then atomically writes `config.json`. */
export async function writeConfig(projectRoot: string, cfg: LivingSpecConfig): Promise<void> {
  validateLivingSpecConfig(cfg);
  const dir = livingSpecDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.config.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  await fs.rename(tmp, configPath(projectRoot));
}

// ── URS state ──────────────────────────────────────────────────────────

export async function readUrsState(projectRoot: string): Promise<SpecUrsState | null> {
  try {
    const raw = await fs.readFile(ursStatePath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as SpecUrsState;
    if (parsed.schemaVersion !== 1 || typeof parsed.version !== 'number') {
      throw new LivingSpecStateError(
        `malformed URS state at ${ursStatePath(projectRoot)}: expected { schemaVersion: 1, version: number, ... }`,
      );
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof LivingSpecStateError) throw err;
    throw new LivingSpecStateError(`failed to read ${ursStatePath(projectRoot)}: ${(err as Error).message}`);
  }
}

export async function writeUrsState(projectRoot: string, state: SpecUrsState): Promise<void> {
  await fs.mkdir(ursDir(projectRoot), { recursive: true });
  await fs.writeFile(ursStatePath(projectRoot), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Reads a bounded excerpt of the living URS markdown under `urs/` for use as
 * prompt context. Returns `null` when no URS markdown exists yet. Each `.md`
 * file is included (sorted by name) and the concatenation is truncated to
 * `maxChars` so a huge URS can't blow up the prompt budget.
 */
export async function readUrsExcerpt(
  projectRoot: string,
  maxChars: number = 8_000,
): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(ursDir(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const mdFiles = names.filter((n) => n.toLowerCase().endsWith('.md')).sort();
  const parts: string[] = [];
  for (const name of mdFiles) {
    try {
      const content = await fs.readFile(path.join(ursDir(projectRoot), name), 'utf-8');
      parts.push(`# ${name}\n${content}`);
    } catch {
      // skip unreadable files rather than failing the analysis
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join('\n\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

// ── Living URS document (urs.md + urs.json) ───────────────────────────

export function ursMarkdownPath(projectRoot: string): string {
  return path.join(ursDir(projectRoot), 'urs.md');
}

export function ursJsonPath(projectRoot: string): string {
  return path.join(ursDir(projectRoot), 'urs.json');
}

/**
 * Crash-safe write: content goes to a temp file first, then `rename`s over the
 * target. A crash before the rename leaves the previous file fully intact
 * (never a half-written document). `beforeRename` is a test seam used to
 * simulate a crash between the temp write and the commit. Accepts strings
 * (utf-8) and Buffers (e.g. the rendered URS PDF).
 */
export async function writeFileAtomic(
  target: string,
  content: string | Buffer,
  opts?: { beforeRename?: () => void | Promise<void> },
): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, content);
  if (opts?.beforeRename) await opts.beforeRename();
  await fs.rename(tmp, target);
}

/** Reads + parses `urs/urs.json`; returns null when absent. */
export async function readUrsDocument(projectRoot: string): Promise<UrsDocument | null> {
  try {
    const raw = await fs.readFile(ursJsonPath(projectRoot), 'utf-8');
    return parseUrsDocument(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LivingSpecStateError(
      `failed to read ${ursJsonPath(projectRoot)}: ${(err as Error).message}`,
    );
  }
}

/**
 * Atomically writes the living URS pair (`urs/urs.json` + `urs/urs.md`). Each
 * file is committed via temp+rename so a crash never corrupts the live URS.
 * `beforeCommit` runs after the JSON temp write, before its commit — a throw
 * there simulates a mid-write crash and leaves the previous URS intact.
 */
export async function writeUrsDocument(
  projectRoot: string,
  doc: UrsDocument,
  markdown: string = renderUrsMarkdown(doc),
  opts?: { beforeCommit?: () => void | Promise<void> },
): Promise<void> {
  await writeFileAtomic(ursJsonPath(projectRoot), serializeUrsDocument(doc), {
    beforeRename: opts?.beforeCommit,
  });
  await writeFileAtomic(ursMarkdownPath(projectRoot), markdown);
}

// ── Proposals ──────────────────────────────────────────────────────────

export async function listProposalIds(projectRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(proposalsDir(projectRoot));
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function readProposal(projectRoot: string, id: string): Promise<SpecProposal | null> {
  const file = proposalPath(projectRoot, id);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as SpecProposal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof LivingSpecProposalError) throw err;
    throw new LivingSpecProposalError(`failed to read ${file}: ${(err as Error).message}`);
  }
}

export async function saveProposal(projectRoot: string, proposal: SpecProposal): Promise<void> {
  await fs.mkdir(proposalsDir(projectRoot), { recursive: true });
  await fs.writeFile(
    proposalPath(projectRoot, proposal.id),
    JSON.stringify(proposal, null, 2),
    'utf-8',
  );
}

// ── URS versions ───────────────────────────────────────────────────────

export async function listVersions(projectRoot: string): Promise<SpecUrsVersion[]> {
  let names: string[];
  try {
    names = await fs.readdir(versionsDir(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const versions: SpecUrsVersion[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const raw = await fs.readFile(path.join(versionsDir(projectRoot), name), 'utf-8');
    versions.push(JSON.parse(raw) as SpecUrsVersion);
  }
  return versions.sort((a, b) => a.version - b.version);
}

export async function saveVersion(projectRoot: string, version: SpecUrsVersion): Promise<void> {
  await fs.mkdir(versionsDir(projectRoot), { recursive: true });
  await fs.writeFile(
    versionPath(projectRoot, version.version),
    JSON.stringify(version, null, 2),
    'utf-8',
  );
}

// ── Reports ────────────────────────────────────────────────────────────

export function reportPath(projectRoot: string, changeId: string): string {
  return path.join(reportsDir(projectRoot), `${requireSafeId(changeId, 'report')}.json`);
}

/** Writes `reports/<changeId>.json`; returns the absolute report path. */
export async function saveReport(
  projectRoot: string,
  result: SpecAnalysisResult,
): Promise<string> {
  const file = reportPath(projectRoot, result.changeId);
  await fs.mkdir(reportsDir(projectRoot), { recursive: true });
  await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf-8');
  return file;
}

/**
 * Path for the evaluation-friendly labelled implication output that lives next
 * to the analysis report: `reports/<changeId>.implications.json`.
 */
export function implicationsReportPath(projectRoot: string, changeId: string): string {
  return path.join(reportsDir(projectRoot), `${requireSafeId(changeId, 'report')}.implications.json`);
}

/**
 * Writes `reports/<changeId>.implications.json` (the stable, metrics-friendly
 * labelled output). Returns the absolute path. The file is written whether the
 * inference succeeded or failed so evaluation can track both outcomes.
 */
export async function saveImplicationsReport(
  projectRoot: string,
  changeId: string,
  label: ImplicationsLabelFile,
): Promise<string> {
  const file = implicationsReportPath(projectRoot, changeId);
  await fs.mkdir(reportsDir(projectRoot), { recursive: true });
  await fs.writeFile(file, JSON.stringify(label, null, 2), 'utf-8');
  return file;
}

// ── Drift alerts (append-only JSONL) ──────────────────────────────────

/**
 * Appends drift alerts to `reports/alerts.jsonl`, one compact JSON object per
 * line (valid JSONL). The log is append-only: nothing is rewritten, so the
 * alert history stays intact (NFR6). Returns the log path.
 */
export async function appendDriftAlerts(
  projectRoot: string,
  alerts: readonly SpecChangeDriftAlert[],
): Promise<string> {
  const file = alertsLogPath(projectRoot);
  if (alerts.length === 0) return file;
  await fs.mkdir(reportsDir(projectRoot), { recursive: true });
  const lines = alerts.map((a) => JSON.stringify(a)).join('\n') + '\n';
  await fs.appendFile(file, lines, 'utf-8');
  return file;
}

function isDriftAlert(raw: unknown): raw is SpecChangeDriftAlert {
  if (typeof raw !== 'object' || raw === null) return false;
  const a = raw as Record<string, unknown>;
  return (
    typeof a.changeId === 'string' &&
    typeof a.file === 'string' &&
    typeof a.reason === 'string' &&
    typeof a.affectedRequirement === 'string' &&
    typeof a.proposedNextAction === 'string' &&
    typeof a.severity === 'string' &&
    typeof a.timestamp === 'string'
  );
}

/**
 * Reads the alert log (oldest first). Malformed lines are skipped rather than
 * failing the read — the log is human-auditable and may be hand-edited.
 * Returns `[]` when the log does not exist yet.
 */
export async function readDriftAlerts(projectRoot: string): Promise<readonly SpecChangeDriftAlert[]> {
  let raw: string;
  try {
    raw = await fs.readFile(alertsLogPath(projectRoot), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new LivingSpecStateError(
      `failed to read ${alertsLogPath(projectRoot)}: ${(err as Error).message}`,
    );
  }
  const alerts: SpecChangeDriftAlert[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isDriftAlert(parsed)) alerts.push(parsed);
    } catch {
      // skip malformed line — the rest of the log stays readable
    }
  }
  return alerts;
}
