/**
 * Codexrev — sandbox module entry point.
 *
 * Public surface:
 *   - `SandboxManager`  (alias for the resolve+exec convenience)
 *   - `resolveSandbox()` factory
 *   - All four backend classes
 *   - Types
 */

import {
  SandboxError,
  SeatbeltSandbox,
  DockerSandbox,
  PodmanSandbox,
  NoSandbox,
  resolveSandbox,
  type Sandbox,
  type SandboxMode,
  type SandboxOptions,
  type SandboxResult,
  type ResolvedSandbox,
} from './manager.js';

export {
  SandboxError,
  SeatbeltSandbox,
  DockerSandbox,
  PodmanSandbox,
  NoSandbox,
  resolveSandbox,
  type Sandbox,
  type SandboxMode,
  type SandboxOptions,
  type SandboxResult,
  type ResolvedSandbox,
};

/** Convenience façade used by the shell tool. */
export class SandboxManager {
  private mode: import('./manager.js').SandboxMode;
  constructor(initial: import('./manager.js').SandboxMode = 'auto') {
    this.mode = initial;
  }

  setMode(mode: import('./manager.js').SandboxMode): void {
    this.mode = mode;
  }

  async exec(
    argv: ReadonlyArray<string>,
    opts: Omit<import('./manager.js').SandboxOptions, 'mode'> = {},
  ): Promise<import('./manager.js').SandboxResult> {
    const resolved = await resolveSandbox(this.mode, opts.cwd);
    return resolved.sandbox.exec(argv, { ...opts, mode: this.mode });
  }
}