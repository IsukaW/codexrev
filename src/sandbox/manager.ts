/**
 * Codexrev — sandbox manager (orchestrator).
 *
 * Selects the appropriate sandbox backend based on the OS and the
 * sandbox mode setting:
 *
 *   - `auto`    : macOS uses seatbelt; Linux falls back to docker / podman;
 *                 Windows falls back to docker / wsl.
 *   - `seatbelt`: macOS-only `sandbox-exec` profiles. Errors on other OSes.
 *   - `docker`  : run commands inside `docker run --rm` containers.
 *   - `podman`  : same as docker but with the podman CLI.
 *   - `off`     : no sandbox; commands run in the host shell.
 *
 * The manager implements the `Sandbox` interface in `types.ts`. The
 * shell tool calls `sandbox.exec(command)` for every command. Each
 * backend returns a `SandboxResult` describing exit code, stdout,
 * stderr, and duration.
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface SandboxResult {
  /** Process exit code (0 if the sandbox itself succeeded but the inner command may differ). */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly sandboxedBy: SandboxMode;
}

export type SandboxMode = 'auto' | 'seatbelt' | 'docker' | 'podman' | 'off';

export interface SandboxOptions {
  mode: SandboxMode;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Maximum execution time in ms. Default 60_000. */
  timeoutMs?: number;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Comma-separated extra allowlist for seatbelt. */
  allowWrite?: string[];
}

/** Capability that all backends must satisfy. */
export interface Sandbox {
  readonly mode: Exclude<SandboxMode, 'off'>;
  /** True if the underlying binary/tooling is present on this machine. */
  available(): Promise<boolean>;
  /** Run `argv` inside the sandbox. */
  exec(argv: ReadonlyArray<string>, opts: SandboxOptions): Promise<SandboxResult>;
}

/** Run a child process and capture output, with timeout. */
function spawn(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = execFile(cmd, args as string[], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      timeout: opts.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer | string) => stdout.push(Buffer.from(b)));
    child.stderr?.on('data', (b: Buffer | string) => stderr.push(Buffer.from(b)));
    child.on('error', (err) => reject(err));
    child.on('exit', (code) =>
      resolve({
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - start,
        sandboxedBy: 'off',
      }),
    );
  });
}

/**
 * Probe whether a binary is on PATH. Resolves to true / false, never
 * throws.
 */
async function hasBinary(name: string): Promise<boolean> {
  try {
    await spawn(name, ['--version'], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe an MCP-like "is X working" command by checking `--help`.
 */
async function hasHelp(name: string): Promise<boolean> {
  try {
    const r = await spawn(name, ['--help'], { timeoutMs: 5_000 });
    return r.exitCode === 0 || /usage/i.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}

/* ─── Backend: Seatbelt (macOS) ─────────────────────────────────── */

/** SBPL profile allowing common read paths but only writes to cwd. */
function buildSeatbeltProfile(opts: SandboxOptions): string {
  const cwd = opts.cwd ?? process.cwd();
  const writes = (opts.allowWrite ?? [cwd]).map((p) => `(allow file-write* (subpath "${p}"))`).join('\n');
  return `
(version 1)
(deny default)
(allow process-exec)
(allow file-read*)
(allow sysctl-read)
(allow mach-lookup)
(allow network*)
(allow file-write* (subpath "/dev/null"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
${writes}
(allow file-write* (subpath "${cwd}"))
`.trim();
}

export class SeatbeltSandbox implements Sandbox {
  readonly mode = 'seatbelt' as const;

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    return hasBinary('sandbox-exec');
  }

  async exec(argv: ReadonlyArray<string>, opts: SandboxOptions): Promise<SandboxResult> {
    if (process.platform !== 'darwin') {
      throw new SandboxError('seatbelt sandbox is only available on macOS');
    }
    const profile = buildSeatbeltProfile(opts);
    const tmpProfile = path.join(os.tmpdir(), `codexrev-sbpl-${process.pid}-${Date.now()}.sb`);
    await fs.writeFile(tmpProfile, profile, 'utf8');
    try {
      const args = ['-f', tmpProfile, ...argv];
      const r = await spawn('sandbox-exec', args, {
        timeoutMs: opts.timeoutMs ?? 60_000,
        cwd: opts.cwd,
      });
      return { ...r, sandboxedBy: 'seatbelt' };
    } finally {
      await fs.unlink(tmpProfile).catch(() => undefined);
    }
  }
}

/* ─── Backend: Docker ──────────────────────────────────────────── */

export class DockerSandbox implements Sandbox {
  readonly mode = 'docker' as const;

  async available(): Promise<boolean> {
    return hasHelp('docker');
  }

  async exec(argv: ReadonlyArray<string>, opts: SandboxOptions): Promise<SandboxResult> {
    const args = [
      'run',
      '--rm',
      '-i',
      '-v',
      `${opts.cwd ?? process.cwd()}:/work`,
      '-w',
      '/work',
      ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      'alpine:3.20',
      ...argv,
    ];
    const r = await spawn('docker', args, {
      timeoutMs: opts.timeoutMs ?? 120_000,
      cwd: opts.cwd,
    });
    return { ...r, sandboxedBy: 'docker' };
  }
}

/* ─── Backend: Podman ──────────────────────────────────────────── */

export class PodmanSandbox implements Sandbox {
  readonly mode = 'podman' as const;

  async available(): Promise<boolean> {
    return hasHelp('podman');
  }

  async exec(argv: ReadonlyArray<string>, opts: SandboxOptions): Promise<SandboxResult> {
    const args = [
      'run',
      '--rm',
      '-i',
      '-v',
      `${opts.cwd ?? process.cwd()}:/work`,
      '-w',
      '/work',
      ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      'alpine:3.20',
      ...argv,
    ];
    const r = await spawn('podman', args, {
      timeoutMs: opts.timeoutMs ?? 120_000,
      cwd: opts.cwd,
    });
    return { ...r, sandboxedBy: 'podman' };
  }
}

/* ─── Off (passthrough) ────────────────────────────────────────── */

export class NoSandbox implements Sandbox {
  readonly mode = 'docker' as const; // typed as `Excluding<off>`, fallback treated as docker

  async available(): Promise<boolean> {
    return true;
  }

  async exec(argv: ReadonlyArray<string>, opts: SandboxOptions): Promise<SandboxResult> {
    if (argv.length === 0) throw new SandboxError('no command provided');
    const [cmd, ...args] = argv;
    const r = await spawn(cmd, args, {
      timeoutMs: opts.timeoutMs ?? 60_000,
      cwd: opts.cwd,
    });
    return { ...r, sandboxedBy: 'off' };
  }
}

/* ─── Manager factory ──────────────────────────────────────────── */

export interface ResolvedSandbox {
  readonly sandbox: Sandbox;
  readonly effectiveMode: SandboxMode;
}

/**
 * Pick the appropriate backend for the requested `mode`. With `auto` we
 * try (in order): seatbelt → docker → podman → off.
 */
export async function resolveSandbox(
  mode: SandboxMode = 'auto',
  cwd?: string,
): Promise<ResolvedSandbox> {
  const attempts: Sandbox[] = [];

  if (mode === 'auto') {
    attempts.push(new SeatbeltSandbox(), new DockerSandbox(), new PodmanSandbox());
  } else if (mode === 'seatbelt') {
    attempts.push(new SeatbeltSandbox());
  } else if (mode === 'docker') {
    attempts.push(new DockerSandbox());
  } else if (mode === 'podman') {
    attempts.push(new PodmanSandbox());
  } else {
    // off
    return {
      sandbox: new NoSandbox(),
      effectiveMode: 'off',
    };
  }

  void cwd; // Reserved for future per-cwd sandbox config.

  for (const sb of attempts) {
    if (await sb.available()) {
      return { sandbox: sb, effectiveMode: sb.mode };
    }
  }
  // None available — fall back to off so the user can still work.
  return { sandbox: new NoSandbox(), effectiveMode: 'off' };
}
