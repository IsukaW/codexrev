// Runs a project's own build/test command (tsc, mvn, gradle, npm test, go vet, ...).
//
// Why not the `shell` tool: its macOS seatbelt profile denies fork() and every write outside
// the project, which is right for commands a model makes up but kills real toolchains — `mvn`
// is a shell script that forks before it ever starts Java ("fork: Operation not permitted"),
// npx/gradle spawn children, and Maven/Gradle/npm must write their caches (~/.m2, ~/.gradle,
// ~/.npm) or they cannot resolve a single dependency. So on macOS these commands get their own
// profile: forking allowed, writes still limited to the project, the temp directories and the
// build tools' cache directories. Elsewhere they run directly: the docker/podman backends start
// a bare alpine image that has no JDK, Node or Go, so "sandboxed" there would mean "never works".
// The commands themselves come from the project (its build files or the user's config), not
// from a model.

import { execFile, execFileSync } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ToolchainRunOptions {
  readonly timeoutMs: number;
  /** run under the macOS toolchain profile when available (default true); false = run directly */
  readonly sandbox?: boolean;
  readonly signal?: AbortSignal;
}

export interface ToolchainRunResult {
  readonly code: number;
  /** stdout + stderr */
  readonly output: string;
  readonly timedOut: boolean;
  /** the shell could not find the program (exit 127 / "command not found") */
  readonly notFound: boolean;
  readonly sandboxed: boolean;
}

// where build tools keep downloaded dependencies and daemons' state
const CACHE_DIRS = [
  '.m2',
  '.gradle',
  '.npm',
  '.yarn',
  '.pnpm-store',
  '.cache',
  '.cargo',
  'go',
  '.nuget',
  '.dotnet',
  '.konan',
  '.sbt',
  '.ivy2',
  '.local/share',
  'Library/Caches',
  'Library/pnpm',
  'Library/Application Support/kotlin',
];

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const sbplString = (p: string): string => JSON.stringify(p); // SBPL strings use the same escaping as JSON

export function buildToolchainSeatbeltProfile(cwd: string): string {
  const home = os.homedir();
  const writable = new Set<string>([
    real(cwd),
    '/tmp',
    '/private/tmp',
    '/private/var/folders', // $TMPDIR on macOS; the JVM keeps hsperfdata there
    real(os.tmpdir()),
    ...CACHE_DIRS.map((d) => path.join(home, d)),
  ]);
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow file-read*)',
    '(allow file-ioctl)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow network*)',
    '(allow file-write* (subpath "/dev"))',
    ...[...writable].map((p) => `(allow file-write* (subpath ${sbplString(p)}))`),
  ].join('\n');
}

let seatbeltAvailable: boolean | undefined;
function hasSeatbelt(): boolean {
  if (process.platform !== 'darwin') return false;
  if (seatbeltAvailable === undefined) {
    try {
      execFileSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 5_000 });
      seatbeltAvailable = true;
    } catch {
      seatbeltAvailable = false;
    }
  }
  return seatbeltAvailable;
}

function shellArgv(command: string): [string, string[]] {
  return process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/sh', ['-c', command]];
}

export async function runToolchainCommand(command: string, cwd: string, opts: ToolchainRunOptions): Promise<ToolchainRunResult> {
  const sandboxed = opts.sandbox !== false && hasSeatbelt();
  const [shell, shellArgs] = shellArgv(command);
  let profilePath: string | undefined;
  let file = shell;
  let args = shellArgs;
  if (sandboxed) {
    profilePath = path.join(os.tmpdir(), `codexrev-toolchain-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sb`);
    await fs.writeFile(profilePath, buildToolchainSeatbeltProfile(cwd), 'utf-8');
    file = 'sandbox-exec';
    args = ['-f', profilePath, shell, ...shellArgs];
  }
  try {
    return await new Promise<ToolchainRunResult>((resolve) => {
      execFile(
        file,
        args,
        {
          cwd,
          timeout: opts.timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
          ...(opts.signal ? { signal: opts.signal } : {}),
          env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
        },
        (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.trim();
          if (!error) return resolve({ code: 0, output, timedOut: false, notFound: false, sandboxed });
          const e = error as unknown as { code?: number | string; killed?: boolean; signal?: string | null; message: string };
          const code: number = typeof e.code === 'number' ? e.code : 1;
          const notFound = code === 127 || /command not found|not recognized as an internal or external command/i.test(output);
          resolve({ code, output: output || e.message, timedOut: e.killed === true && e.signal === 'SIGTERM', notFound, sandboxed });
        },
      );
    });
  } finally {
    if (profilePath) await fs.unlink(profilePath).catch(() => undefined);
  }
}

// true when `name` is an executable somewhere on PATH (no process spawned)
export async function onPath(name: string): Promise<boolean> {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        await fs.access(path.join(dir, name + ext), fs.constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}
