// Gets the --fix loop's temporary copy and build/test baseline ready WHILE the review scan is
// still running (the scan takes many minutes on a slow model and these two steps are unrelated
// to it), so the fix can start the moment the scan ends instead of after it.
//
// The loop only adopts the prepared copy if the project is byte-for-byte what it was when the copy
// was taken (same fingerprint); if the user edited anything in the meantime it is thrown away and
// the loop prepares a fresh one, exactly as it would have without this.

import type { ParsedDiff } from './diffReader.js';
import { createSandbox, type Sandbox } from './fixSandbox.js';
import { runValidation, type ValidationOptions, type ValidationSnapshot } from './fixValidator.js';
import { fingerprintTree } from './reviewCache.js';

export interface PrewarmedFix {
  readonly sandbox: Sandbox;
  readonly baseline: ValidationSnapshot | undefined;
  /** state of the project when the copy was taken; null = could not be determined, never adopted */
  readonly fingerprint: string | null;
  readonly preparationMs: number;
}

export function prewarmFixEnvironment(
  cwd: string,
  diff: ParsedDiff,
  validate: boolean,
  validationOptions?: ValidationOptions,
): Promise<PrewarmedFix | undefined> {
  return (async () => {
    const startedAt = Date.now();
    const fingerprint = await fingerprintTree(cwd);
    const sandbox = await createSandbox(cwd);
    try {
      const baseline = validate ? await runValidation(sandbox.dir, diff, validationOptions) : undefined;
      return { sandbox, baseline, fingerprint, preparationMs: Date.now() - startedAt };
    } catch (err) {
      await sandbox.cleanup();
      throw err;
    }
  })().catch(() => undefined); // preparing early is an optimisation: if it fails the loop just prepares normally
}
