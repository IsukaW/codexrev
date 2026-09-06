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

/** Which sandbox backends can actually run on this machine. */
export type SandboxProbe = Record<'seatbelt' | 'docker' | 'podman', boolean>;

/**
 * Convenience façade shared by the shell tool and the TUI Control Panel.
 * A single instance is created per session so a live sandbox-mode change
 * from the panel takes effect on the next command without a restart.
 */
export class SandboxManager {
  private mode: SandboxMode;
  private resolvedPromise?: Promise<ResolvedSandbox>;

  constructor(initial: SandboxMode = 'auto') {
    this.mode = initial;
  }

  setMode(mode: SandboxMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.resolvedPromise = undefined; // re-resolve on next use
  }

  getMode(): SandboxMode {
    return this.mode;
  }

  private resolve(cwd?: string): Promise<ResolvedSandbox> {
    if (!this.resolvedPromise) {
      this.resolvedPromise = resolveSandbox(this.mode, cwd);
    }
    return this.resolvedPromise;
  }

  /** Effective backend after probing — e.g. `auto` resolves to `seatbelt`. */
  async effectiveMode(): Promise<SandboxMode> {
    return (await this.resolve()).effectiveMode;
  }

  /** Probe which sandbox backends are usable on this machine. */
  async probe(): Promise<SandboxProbe> {
    const [seatbelt, docker, podman] = await Promise.all([
      new SeatbeltSandbox().available(),
      new DockerSandbox().available(),
      new PodmanSandbox().available(),
    ]);
    return { seatbelt, docker, podman };
  }

  async exec(
    argv: ReadonlyArray<string>,
    opts: Omit<SandboxOptions, 'mode'> = {},
  ): Promise<SandboxResult> {
    const resolved = await this.resolve(opts.cwd);
    return resolved.sandbox.exec(argv, { ...opts, mode: this.mode });
  }
}