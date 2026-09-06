// Picks a sandbox backend based on OS + the sandbox mode setting.
// auto: seatbelt on macOS, falls back to docker/podman on Linux, docker/wsl on Windows.
// seatbelt: macOS-only sandbox-exec profiles, errors elsewhere.
// docker/podman: runs the command inside a `run --rm` container.
// off: no sandbox, runs straight in the host shell.
// Shell tool calls sandbox.exec(command) for every command; each backend hands back
// a SandboxResult with exit code, stdout, stderr, duration.

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
  /** this is the inner command's exit code, not whether the sandbox itself worked */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly sandboxedBy: SandboxMode;
}

export type SandboxMode = 'auto' | 'seatbelt' | 'docker' | 'podman' | 'off';

export interface SandboxOptions {
  mode: SandboxMode;
  cwd?: string;
  /** default 60_000 */
  timeoutMs?: number;
  env?: Record<string, string>;
  /** extra write paths for seatbelt */
  allowWrite?: string[];
}

export interface Sandbox {
  readonly mode: Exclude<SandboxMode, 'off'>;
  available(): Promise<boolean>;
  exec(argv: ReadonlyArray<string>, opts: SandboxOptions): Promise<SandboxResult>;
}

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

// checks if a binary is on PATH — never throws, just true/false
async function hasBinary(name: string): Promise<boolean> {
  try {
    await spawn(name, ['--version'], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// same idea but via --help, for CLIs where --version isn't reliable
async function hasHelp(name: string): Promise<boolean> {
  try {
    const r = await spawn(name, ['--help'], { timeoutMs: 5_000 });
    return r.exitCode === 0 || /usage/i.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}

// Seatbelt (macOS)

// SBPL profile: reads are wide open, writes are locked to cwd (plus /tmp for scratch)
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

// Docker

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

// Podman, same shape as docker

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

// Off (passthrough)

export class NoSandbox implements Sandbox {
  readonly mode = 'docker' as const; // Sandbox.mode excludes 'off', so this is just a placeholder

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

// Manager factory

export interface ResolvedSandbox {
  readonly sandbox: Sandbox;
  readonly effectiveMode: SandboxMode;
}

// auto tries seatbelt, then docker, then podman, then gives up and goes off
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

  void cwd; // not used yet, reserved for per-cwd sandbox config later

  for (const sb of attempts) {
    if (await sb.available()) {
      return { sandbox: sb, effectiveMode: sb.mode };
    }
  }
  // nothing available, fall back to off so the user isn't blocked
  return { sandbox: new NoSandbox(), effectiveMode: 'off' };
}
