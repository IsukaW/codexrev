/**
 * Feature 3 / Function 1 — analysis request validation (Phase P1).
 *
 * Validates and normalizes the raw request BEFORE any analysis runs:
 * required fields, npm-style version syntax, migration configuration and
 * the read-only guarantee (outPath must not resolve inside projectPath).
 *
 * Missing/invalid required fields are never replaced with defaults — the
 * request is rejected with a structured issue list. Defaults are applied
 * only to optional fields (include/exclude/outputFormat).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AnalyzeRequest, AnalysisIssue, MigrationConfig, Technology } from './types.js';
import {
  RequestValidationError,
  ecosystemUnsupported,
  requestInvalid,
  versionInvalid,
} from './issues.js';

/** Syntax check only — version *comparison* is not implemented in Function 1. */
const VERSION_SYNTAX = /^(\^|~|>=|<=|>|<|=)?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const DEFAULT_INCLUDE: readonly string[] = ['**/*.{js,jsx,ts,tsx,mjs,cjs}'];
export const DEFAULT_EXCLUDE: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/build/**',
];
export const DEFAULT_OUTPUT_FORMAT = 'json' as const;

function nonEmptyString(
  raw: Record<string, unknown>,
  field: string,
  issues: AnalysisIssue[],
): string | null {
  const v = raw[field];
  if (typeof v !== 'string' || v.trim() === '') {
    issues.push(requestInvalid(`${field} is required and must be a non-empty string`, field));
    return null;
  }
  return v.trim();
}

function checkVersion(
  raw: Record<string, unknown>,
  field: string,
  issues: AnalysisIssue[],
): string | null {
  const v = raw[field];
  if (typeof v !== 'string' || v.trim() === '') {
    issues.push(requestInvalid(`${field} is required and must be a non-empty string`, field));
    return null;
  }
  const trimmed = v.trim();
  if (!VERSION_SYNTAX.test(trimmed)) {
    issues.push(
      versionInvalid(`${field} '${v}' is not a valid npm-style version (e.g. 1.4.2 or ^2.0.0)`, field),
    );
    return null;
  }
  return trimmed;
}

function validateMigration(value: unknown, issues: AnalysisIssue[]): MigrationConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(requestInvalid('migration is required and must be an object', 'migration'));
    return null;
  }
  const m = value as Record<string, unknown>;
  if (m.kind === 'api-rename') {
    let ok = true;
    for (const name of ['from', 'to'] as const) {
      const v = m[name];
      if (typeof v !== 'string' || !IDENTIFIER.test(v)) {
        issues.push(
          requestInvalid(`migration.${name} must be a valid JavaScript identifier`, `migration.${name}`),
        );
        ok = false;
      }
    }
    if (ok && m.from === m.to) {
      issues.push(requestInvalid('migration.from and migration.to must differ', 'migration'));
      ok = false;
    }
    return ok
      ? { kind: 'api-rename', from: m.from as string, to: m.to as string }
      : null;
  }
  if (m.kind === 'dependency-upgrade') {
    const pkg = m.package;
    if (typeof pkg !== 'string' || pkg.trim() === '') {
      issues.push(
        requestInvalid(
          'migration.package is required and must be a non-empty string for kind dependency-upgrade',
          'migration.package',
        ),
      );
      return null;
    }
    return { kind: 'dependency-upgrade', package: pkg.trim() };
  }
  issues.push(
    requestInvalid(
      `migration.kind must be 'api-rename' or 'dependency-upgrade'`,
      typeof m.kind === 'string' ? m.kind : undefined,
    ),
  );
  return null;
}

async function checkOptionalFile(
  raw: Record<string, unknown>,
  field: string,
  issues: AnalysisIssue[],
): Promise<string | null> {
  const v = raw[field];
  if (v === undefined) return null;
  if (typeof v !== 'string' || v.trim() === '') {
    issues.push(requestInvalid(`${field} must be a non-empty file path when provided`, field));
    return null;
  }
  const resolved = path.resolve(v.trim());
  try {
    const st = await fsp.stat(resolved);
    if (!st.isFile()) {
      issues.push(requestInvalid(`${field} must point to a file`, resolved));
      return null;
    }
  } catch {
    issues.push(requestInvalid(`${field} does not exist`, resolved));
    return null;
  }
  return resolved;
}

function optionalStringArray(
  raw: Record<string, unknown>,
  field: string,
  issues: AnalysisIssue[],
): string[] | null {
  const v = raw[field];
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
    issues.push(requestInvalid(`${field} must be an array of non-empty strings when provided`, field));
    return null;
  }
  return (v as string[]).map((x) => x.trim());
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Validate an untrusted request object. Throws `RequestValidationError`
 * carrying one `AnalysisIssue` per problem; returns the normalized request
 * (absolute paths, defaults filled for optional fields) on success.
 */
export async function validateAnalyzeRequest(input: unknown): Promise<AnalyzeRequest> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RequestValidationError([requestInvalid('request must be an object')]);
  }
  const raw = input as Record<string, unknown>;
  const issues: AnalysisIssue[] = [];

  // --- required fields ---
  const projectPathRaw = nonEmptyString(raw, 'projectPath', issues);
  let projectPath: string | null = null;
  if (projectPathRaw !== null) {
    projectPath = path.resolve(projectPathRaw);
    try {
      const st = await fsp.stat(projectPath);
      if (!st.isDirectory()) {
        issues.push(requestInvalid('projectPath must be a directory', projectPath));
        projectPath = null;
      }
    } catch {
      issues.push(requestInvalid('projectPath does not exist', projectPathRaw));
      projectPath = null;
    }
  }

  let technology: Technology | null = null;
  const techRaw = raw.technology;
  if (typeof techRaw !== 'string' || techRaw.trim() === '') {
    issues.push(requestInvalid("technology is required and must be the string 'node'", 'technology'));
  } else if (techRaw.trim() !== 'node') {
    issues.push(
      ecosystemUnsupported(
        `technology '${techRaw}' is not supported: this implementation accepts 'node' (JavaScript/TypeScript, npm) only; Java/Maven/Gradle are future scope`,
        techRaw.trim(),
      ),
    );
  } else {
    technology = 'node';
  }

  const dependencyName = nonEmptyString(raw, 'dependencyName', issues);
  const currentVersion = checkVersion(raw, 'currentVersion', issues);
  const targetVersion = checkVersion(raw, 'targetVersion', issues);
  if (currentVersion !== null && targetVersion !== null && currentVersion === targetVersion) {
    issues.push(
      versionInvalid('currentVersion and targetVersion must differ', 'currentVersion'),
    );
  }
  const migration = validateMigration(raw.migration, issues);

  // --- optional fields (defaults applied only here) ---
  const compatDataPath = await checkOptionalFile(raw, 'compatDataPath', issues);
  const upstreamFindingsPath = await checkOptionalFile(raw, 'upstreamFindingsPath', issues);

  let rulesPaths: string[] | null = null;
  const rulesRaw = optionalStringArray(raw, 'rulesPaths', issues);
  if (rulesRaw !== null) {
    rulesPaths = [];
    for (const p of rulesRaw) {
      const resolved = path.resolve(p);
      try {
        const st = await fsp.stat(resolved);
        if (!st.isFile()) {
          issues.push(requestInvalid(`rulesPaths entry must point to a file`, resolved));
          continue;
        }
      } catch {
        issues.push(requestInvalid('rulesPaths entry does not exist', resolved));
        continue;
      }
      rulesPaths.push(resolved);
    }
  }

  const include = optionalStringArray(raw, 'include', issues);
  const exclude = optionalStringArray(raw, 'exclude', issues);

  let outputFormat: 'json' | 'markdown' | null = null;
  const fmtRaw = raw.outputFormat;
  if (fmtRaw !== undefined) {
    if (fmtRaw === 'json' || fmtRaw === 'markdown') {
      outputFormat = fmtRaw;
    } else {
      issues.push(requestInvalid("outputFormat must be 'json' or 'markdown'", 'outputFormat'));
    }
  }

  let outPath: string | null = null;
  const outRaw = raw.outPath;
  if (outRaw !== undefined) {
    if (typeof outRaw !== 'string' || outRaw.trim() === '') {
      issues.push(requestInvalid('outPath must be a non-empty path when provided', 'outPath'));
    } else {
      const resolved = path.resolve(outRaw.trim());
      if (projectPath !== null && isInside(projectPath, resolved)) {
        // read-only guarantee: analysis artifacts must never land inside the target project
        issues.push(
          requestInvalid(
            'outPath must be outside projectPath — analysis must not write into the target project',
            resolved,
          ),
        );
      } else {
        outPath = resolved;
      }
    }
  }

  if (issues.length > 0) {
    throw new RequestValidationError(issues);
  }

  // --- normalized request (invariant: all required values are set) ---
  const result: AnalyzeRequest = {
    projectPath: projectPath as string,
    technology: technology as Technology,
    dependencyName: dependencyName as string,
    currentVersion: currentVersion as string,
    targetVersion: targetVersion as string,
    migration: migration as MigrationConfig,
    include: include ?? [...DEFAULT_INCLUDE],
    exclude: exclude ?? [...DEFAULT_EXCLUDE],
    outputFormat: outputFormat ?? DEFAULT_OUTPUT_FORMAT,
  };
  if (compatDataPath !== null) result.compatDataPath = compatDataPath;
  if (upstreamFindingsPath !== null) result.upstreamFindingsPath = upstreamFindingsPath;
  if (rulesPaths !== null) result.rulesPaths = rulesPaths;
  if (outPath !== null) result.outPath = outPath;
  return result;
}
