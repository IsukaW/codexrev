/**
 * Feature 3 / Function 1 — npm ecosystem detection (Phase P2).
 *
 * Detects whether the target project is an npm project by looking for
 * `package.json` in the project root, records the lockfile presence, and
 * reports missing manifests / unsupported ecosystems as structured issues.
 * Read-only: everything is read through `ReadOnlyFs`.
 */

import path from 'node:path';
import type { AnalysisIssue } from '../types.js';
import { analysisIssue, ecosystemUnsupported } from '../issues.js';
import { ReadOnlyFs } from '../readOnlyFs.js';

export const NPM_MANIFEST_FILE = 'package.json';
export const NPM_LOCKFILE_FILE = 'package-lock.json';

/** Markers of ecosystems that the proposal requires but this phase does not
 *  support yet (future scope: Java/Maven/Gradle, Python, Go, Rust). */
export const NON_NPM_MARKERS: readonly { file: string; ecosystem: string }[] = [
  { file: 'pom.xml', ecosystem: 'maven (Java)' },
  { file: 'build.gradle', ecosystem: 'gradle (Java)' },
  { file: 'build.gradle.kts', ecosystem: 'gradle (Java)' },
  { file: 'requirements.txt', ecosystem: 'pip (Python)' },
  { file: 'pyproject.toml', ecosystem: 'python' },
  { file: 'go.mod', ecosystem: 'go' },
  { file: 'Cargo.toml', ecosystem: 'cargo (Rust)' },
];

export interface EcosystemDetection {
  ecosystem: 'npm' | 'unsupported';
  /** Absolute path, null when missing/unsupported. */
  manifestPath: string | null;
  /** Absolute path, null when absent. */
  lockfilePath: string | null;
  issues: AnalysisIssue[];
}

export async function detectEcosystem(ro: ReadOnlyFs): Promise<EcosystemDetection> {
  const issues: AnalysisIssue[] = [];

  if (await ro.exists(NPM_MANIFEST_FILE)) {
    const lockfileExists = await ro.exists(NPM_LOCKFILE_FILE);
    if (!lockfileExists) {
      issues.push(
        analysisIssue(
          'LOCKFILE_MISSING',
          'warning',
          'package-lock.json not found in project root: resolved dependency versions are unavailable (declared ranges only)',
          NPM_LOCKFILE_FILE,
        ),
      );
    }
    return {
      ecosystem: 'npm',
      manifestPath: path.join(ro.root, NPM_MANIFEST_FILE),
      lockfilePath: lockfileExists ? path.join(ro.root, NPM_LOCKFILE_FILE) : null,
      issues,
    };
  }

  for (const marker of NON_NPM_MARKERS) {
    if (await ro.exists(marker.file)) {
      issues.push(
        ecosystemUnsupported(
          `project looks like a ${marker.ecosystem} project (${marker.file} present, no package.json): this implementation supports npm (JavaScript/TypeScript) only; other ecosystems are future scope`,
          marker.file,
        ),
      );
      return { ecosystem: 'unsupported', manifestPath: null, lockfilePath: null, issues };
    }
  }

  issues.push(
    analysisIssue(
      'MANIFEST_MISSING',
      'error',
      'package.json not found in project root: cannot analyze an npm project without a manifest',
      NPM_MANIFEST_FILE,
    ),
  );
  return { ecosystem: 'unsupported', manifestPath: null, lockfilePath: null, issues };
}
