// Sandbox module entry point — exports SandboxManager, resolveSandbox(), the four
// backend classes, and their types.

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

export type SandboxProbe = Record<'seatbelt' | 'docker' | 'podman', boolean>;

// shared by the shell tool and the TUI control panel — one instance per session so a
// sandbox-mode change from the panel applies to the next command without a restart
export class SandboxManager {
  private mode: SandboxMode;
  private resolvedPromise?: Promise<ResolvedSandbox>;

  constructor(initial: SandboxMode = 'auto') {
    this.mode = initial;
  }

  setMode(mode: SandboxMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.resolvedPromise = undefined; // force a re-resolve next time
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

  // what 'auto' actually resolved to, e.g. seatbelt
  async effectiveMode(): Promise<SandboxMode> {
    return (await this.resolve()).effectiveMode;
  }

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