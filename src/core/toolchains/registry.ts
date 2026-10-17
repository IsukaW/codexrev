// What a project is built and tested with, decided in one place. The review pipeline's Build
// role, its --fix validation and the agent's verification all ask this module instead of each
// keeping its own list of marker files (they used to, and disagreed: only one of them knew
// Makefiles, none knew Maven or Gradle).
//
// A user-configured command (settings `toolchain.build` / `toolchain.test`) always wins over
// detection — that is how a language or setup nobody wrote an adapter for still works.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  parseAnyCompilerOutput,
  parseCargoCheck,
  parseDotnet,
  parseGoVet,
  parseJavac,
  parseMaven,
  parseMypy,
  parseTsc,
  type DiagnosticParser,
} from './parsers.js';
import { onPath } from './run.js';

/** settings `toolchain`: explicit commands for projects detection gets wrong or does not know */
export interface ToolchainOverride {
  /** type-check/compile command; replaces every detected build check */
  readonly build?: string;
  /** test command; replaces the detected one */
  readonly test?: string;
  readonly buildTimeoutMs?: number;
  readonly testTimeoutMs?: number;
}

/** what callers thread through: the user's override plus whether the OS sandbox may be used */
export interface ToolchainOptions extends ToolchainOverride {
  /** false when settings.sandbox is 'off' */
  readonly sandbox?: boolean;
}

export interface BuildTarget {
  /** short tool name used in summaries and findings, e.g. "tsc", "mvn" */
  readonly label: string;
  /** the file that selected this target (findings about the tool itself point here) */
  readonly marker: string;
  /** usually one; a solution-style tsconfig needs one per referenced project */
  readonly commands: readonly string[];
  readonly timeoutMs: number;
  readonly parse: DiagnosticParser;
  /** appended to the summary, e.g. which tsconfig projects were checked */
  readonly note?: string;
  /** set when the tool is known to be missing here: reported as "could not run", nothing is executed */
  readonly unavailable?: string;
}

export interface TestCommand {
  readonly command: string;
  /** shown to the user, e.g. "npm test", "mvn test" */
  readonly label: string;
  /** a sensible default for this toolchain (a Spring context takes far longer than vitest) */
  readonly timeoutMs?: number;
}

const MINUTE = 60_000;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | null> {
  return fs.readFile(p, 'utf-8').catch(() => null);
}

async function firstExisting(root: string, names: readonly string[]): Promise<string | null> {
  for (const n of names) if (await exists(path.join(root, n))) return n;
  return null;
}

// ── TypeScript ──────────────────────────────────────────────────────────────

// tsconfig.json allows // and /* */ comments and trailing commas, which JSON.parse rejects
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// A "solution-style" tsconfig (Vite/React templates, monorepos) has `files: []` plus
// `references`: it lists projects but includes no source itself, so a plain
// `tsc --noEmit` against it checks ZERO files and "passes". Check each referenced
// project directly instead. Returns [] when tsconfig.json is a normal project.
export async function resolveTscReferencedProjects(cwd: string): Promise<string[]> {
  let cfg: { files?: unknown; references?: unknown };
  try {
    cfg = parseJsonc(await fs.readFile(path.join(cwd, 'tsconfig.json'), 'utf-8')) as typeof cfg;
  } catch {
    return [];
  }
  if (!Array.isArray(cfg.references) || cfg.references.length === 0) return [];
  if (!(Array.isArray(cfg.files) && cfg.files.length === 0)) return []; // has its own sources — plain check is meaningful
  const projects: string[] = [];
  for (const ref of cfg.references as Array<{ path?: unknown }>) {
    if (typeof ref?.path !== 'string') continue;
    const p = ref.path.endsWith('.json') ? ref.path : path.join(ref.path, 'tsconfig.json');
    if (await exists(path.join(cwd, p))) projects.push(p);
  }
  return projects;
}

// The project's own tsc, run with `node` directly (no npx: one process fewer, and it never
// downloads anything). Searches upward so a hoisted monorepo install is found too.
export async function findLocalTscBinary(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsc');
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function tscTarget(root: string): Promise<BuildTarget | null> {
  if (!(await exists(path.join(root, 'tsconfig.json')))) return null;
  const base = { label: 'tsc', marker: 'tsconfig.json', timeoutMs: 2 * MINUTE, parse: parseTsc };
  const tsc = await findLocalTscBinary(root);
  if (!tsc) {
    return {
      ...base,
      commands: [],
      unavailable: "TypeScript is not installed in this project (no node_modules/.bin/tsc) — run your package manager's install, then re-run the review.",
    };
  }
  // tsc's .bin entry is a symlink to a JS file — run it with node, which also works where .bin shims are .cmd files
  const command = `node ${JSON.stringify(tsc)} --noEmit --pretty false`;
  const projects = await resolveTscReferencedProjects(root);
  return projects.length > 0
    ? { ...base, commands: projects.map((p) => `${command} -p ${JSON.stringify(p)}`), note: ` (solution-style tsconfig: checked ${projects.join(', ')})` }
    : { ...base, commands: [command] };
}

// ── JVM: Maven / Gradle ─────────────────────────────────────────────────────

// the wrapper pins the version the project was written for, so it beats whatever is installed
async function mavenExecutable(root: string): Promise<string | null> {
  if (process.platform === 'win32' && (await exists(path.join(root, 'mvnw.cmd')))) return 'mvnw.cmd';
  if (await exists(path.join(root, 'mvnw'))) return 'sh ./mvnw'; // via sh: the exec bit is often lost (zip downloads, Windows checkouts)
  return (await onPath('mvn')) ? 'mvn' : null;
}

async function gradleExecutable(root: string): Promise<string | null> {
  if (process.platform === 'win32' && (await exists(path.join(root, 'gradlew.bat')))) return 'gradlew.bat';
  if (await exists(path.join(root, 'gradlew'))) return 'sh ./gradlew';
  return (await onPath('gradle')) ? 'gradle' : null;
}

const GRADLE_FILES = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'];
// no daemon: one started inside the sandbox would outlive it and serve later builds with the wrong permissions
const GRADLE_FLAGS = '--no-daemon --console=plain -q';

async function mavenTarget(root: string): Promise<BuildTarget | null> {
  if (!(await exists(path.join(root, 'pom.xml')))) return null;
  const mvn = await mavenExecutable(root);
  // test-compile: the main sources AND the tests, so a change that breaks a test's compilation is caught too
  return {
    label: 'mvn',
    marker: 'pom.xml',
    commands: mvn ? [`${mvn} -B -q test-compile`] : [],
    timeoutMs: 10 * MINUTE, // the first build of a Spring Boot project downloads hundreds of dependencies
    parse: parseMaven,
    ...(mvn ? {} : { unavailable: 'Maven is not installed (no ./mvnw wrapper in the project and no mvn on PATH) — install Maven or add the Maven wrapper, then re-run the review.' }),
  };
}

async function gradleTarget(root: string): Promise<BuildTarget | null> {
  const marker = await firstExisting(root, GRADLE_FILES);
  if (!marker) return null;
  const gradle = await gradleExecutable(root);
  // classes/testClasses exist for Java, Kotlin and Groovy builds alike (compileJava would miss Kotlin)
  return {
    label: 'gradle',
    marker,
    commands: gradle ? [`${gradle} ${GRADLE_FLAGS} classes testClasses`] : [],
    timeoutMs: 10 * MINUTE,
    parse: parseJavac,
    ...(gradle ? {} : { unavailable: 'Gradle is not installed (no ./gradlew wrapper in the project and no gradle on PATH) — install Gradle or add the Gradle wrapper, then re-run the review.' }),
  };
}

// ── .NET ────────────────────────────────────────────────────────────────────

// solution and project files are named after the project (Shop.sln, Api.csproj), so they are found by extension
export const DOTNET_SOLUTION = /\.(sln|slnx)$/i;
export const DOTNET_PROJECT = /\.(csproj|fsproj|vbproj)$/i;

async function listDir(root: string): Promise<string[]> {
  return fs.readdir(root).catch(() => [] as string[]);
}

/** what `dotnet build/test` should be given here: the solution, else each project; [] when this is not a .NET folder */
export async function dotnetEntryFiles(root: string): Promise<string[]> {
  const names = (await listDir(root)).sort();
  const solutions = names.filter((n) => DOTNET_SOLUTION.test(n));
  return solutions.length > 0 ? solutions.slice(0, 1) : names.filter((n) => DOTNET_PROJECT.test(n));
}

// no build servers: an MSBuild node or the Roslyn server started inside the sandbox would outlive it
const DOTNET_FLAGS = '--nologo -v q --disable-build-servers';

async function dotnetTarget(root: string): Promise<BuildTarget | null> {
  const entries = await dotnetEntryFiles(root);
  if (entries.length === 0) return null;
  const dotnet = await onPath('dotnet');
  return {
    label: 'dotnet build',
    marker: entries[0]!,
    // -clp:NoSummary: MSBuild otherwise prints every error a second time in its closing summary
    commands: dotnet ? entries.map((e) => `dotnet build ${JSON.stringify(e)} ${DOTNET_FLAGS} -clp:NoSummary`) : [],
    timeoutMs: 10 * MINUTE, // the first build restores NuGet packages
    parse: parseDotnet,
    ...(dotnet ? {} : { unavailable: 'the .NET SDK is not installed (no dotnet on PATH) — install it, then re-run the review.' }),
  };
}

// ── the rest ────────────────────────────────────────────────────────────────

async function simpleTarget(root: string, marker: string, label: string, command: string, timeoutMs: number, parse: DiagnosticParser): Promise<BuildTarget | null> {
  return (await exists(path.join(root, marker))) ? { label, marker, commands: [command], timeoutMs, parse } : null;
}

/**
 * Every build/type check that applies to the project at `root`. Polyglot repos get one per
 * toolchain (a Spring Boot backend with a TypeScript frontend gets mvn AND tsc). Empty when
 * nothing is recognised — the Build role then falls back to per-file syntax checks.
 */
export async function planBuildTargets(root: string, override?: ToolchainOverride): Promise<BuildTarget[]> {
  if (typeof override?.build === 'string' && override.build.trim()) {
    return [
      {
        label: override.build.trim().split(/\s+/)[0]!.replace(/^\.\//, ''),
        marker: '.codexrev/settings.json',
        commands: [override.build.trim()],
        timeoutMs: override.buildTimeoutMs ?? 10 * MINUTE,
        parse: parseAnyCompilerOutput,
        note: ' (configured in settings: toolchain.build)',
      },
    ];
  }
  const candidates = await Promise.all([
    tscTarget(root),
    simpleTarget(root, 'go.mod', 'go vet', 'go vet ./...', 2 * MINUTE, parseGoVet),
    simpleTarget(root, 'Cargo.toml', 'cargo check', 'cargo check --message-format=short', 3 * MINUTE, parseCargoCheck),
    simpleTarget(root, 'pyproject.toml', 'mypy', 'mypy .', 2 * MINUTE, parseMypy),
    mavenTarget(root),
    dotnetTarget(root),
    // a project with both build files is really built by one of them; Maven's pom is the more explicit signal
    (async () => ((await exists(path.join(root, 'pom.xml'))) ? null : gradleTarget(root)))(),
  ]);
  return candidates.filter((t): t is BuildTarget => t !== null).map((t) => (override?.buildTimeoutMs ? { ...t, timeoutMs: override.buildTimeoutMs } : t));
}

const NPM_PLACEHOLDER_TEST = /no test specified/i;

// composer's own `test` script first (Laravel and Symfony define one), else PHPUnit when it is configured and installed
async function phpTests(root: string): Promise<TestCommand | null> {
  const text = await readText(path.join(root, 'composer.json'));
  if (text === null || !(await onPath('php'))) return null;
  try {
    const composer = JSON.parse(text) as { scripts?: Record<string, unknown> };
    if (composer.scripts?.test !== undefined && (await onPath('composer'))) return { command: 'composer test', label: 'composer test' };
  } catch {
    // unreadable composer.json — fall through to PHPUnit
  }
  const configured = (await firstExisting(root, ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml'])) !== null;
  if (configured && (await exists(path.join(root, 'vendor', 'bin', 'phpunit')))) return { command: 'php vendor/bin/phpunit', label: 'phpunit' };
  return null;
}

async function pythonTests(root: string): Promise<boolean> {
  if (await exists(path.join(root, 'pytest.ini'))) return true;
  const configured = (await firstExisting(root, ['pyproject.toml', 'setup.cfg', 'tox.ini', 'setup.py', 'requirements.txt'])) !== null;
  return configured && (await exists(path.join(root, 'tests')) || (await exists(path.join(root, 'test'))));
}

/** the command that runs the project's test suite, or null when there is none to run */
export async function detectTestCommand(root: string, override?: ToolchainOverride): Promise<TestCommand | null> {
  const withTimeout = (t: TestCommand): TestCommand => (override?.testTimeoutMs ? { ...t, timeoutMs: override.testTimeoutMs } : t);
  if (typeof override?.test === 'string' && override.test.trim()) {
    return withTimeout({ command: override.test.trim(), label: override.test.trim() });
  }

  const pkgText = await readText(path.join(root, 'package.json'));
  if (pkgText !== null) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const script = pkg.scripts?.test;
      if (script && !NPM_PLACEHOLDER_TEST.test(script)) return withTimeout({ command: 'npm test --silent', label: 'npm test' });
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return withTimeout({ command: 'npx --no-install vitest run', label: 'vitest' });
      if (deps.jest) return withTimeout({ command: 'npx --no-install jest', label: 'jest' });
    } catch {
      // unreadable package.json — try the other ecosystems
    }
  }
  if (await exists(path.join(root, 'pom.xml'))) {
    const mvn = await mavenExecutable(root);
    if (mvn) return withTimeout({ command: `${mvn} -B test`, label: 'mvn test', timeoutMs: 15 * MINUTE });
  }
  if (await firstExisting(root, GRADLE_FILES)) {
    const gradle = await gradleExecutable(root);
    if (gradle) return withTimeout({ command: `${gradle} --no-daemon --console=plain test`, label: 'gradle test', timeoutMs: 15 * MINUTE });
  }
  const dotnetEntries = await dotnetEntryFiles(root);
  if (dotnetEntries.length > 0 && (await onPath('dotnet'))) {
    // a normal-verbosity console logger: at -v q a failing test is only "[FAIL]", without its expected/actual values
    const tests = dotnetEntries.map((e) => `dotnet test ${JSON.stringify(e)} ${DOTNET_FLAGS} --logger "console;verbosity=normal"`).join(' && ');
    return withTimeout({ command: tests, label: 'dotnet test', timeoutMs: 15 * MINUTE });
  }
  if (await exists(path.join(root, 'go.mod'))) return withTimeout({ command: 'go test ./...', label: 'go test' });
  if (await exists(path.join(root, 'Cargo.toml'))) return withTimeout({ command: 'cargo test --quiet', label: 'cargo test' });
  if (await pythonTests(root)) return withTimeout({ command: 'python3 -m pytest -q', label: 'pytest' });
  const makefile = await readText(path.join(root, 'Makefile'));
  if (makefile !== null && /^test\s*:/m.test(makefile)) return withTimeout({ command: 'make test', label: 'make test' });
  const php = await phpTests(root);
  if (php) return withTimeout(php);
  if (await exists(path.join(root, 'Gemfile'))) {
    if (await exists(path.join(root, 'spec'))) return withTimeout({ command: 'bundle exec rspec', label: 'rspec' });
    // Rails and plain-Ruby minitest suites run through rake
    if ((await exists(path.join(root, 'Rakefile'))) && (await exists(path.join(root, 'test')))) {
      return withTimeout({ command: (await exists(path.join(root, 'bin', 'rails'))) ? 'bin/rails test' : 'bundle exec rake test', label: 'rake test' });
    }
  }
  return null;
}

// ── what the reviewers are told about the project ───────────────────────────

const SPRING_STARTER = /spring-boot-starter-([a-z0-9-]+)/g;
const NOT_FEATURES = new Set(['parent', 'test', 'tomcat', 'logging', 'json']);

function springStarters(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SPRING_STARTER)) if (!NOT_FEATURES.has(m[1]!)) out.add(m[1]!);
  return [...out].slice(0, 6);
}

async function describeMaven(root: string): Promise<string | null> {
  const pom = await readText(path.join(root, 'pom.xml'));
  if (pom === null) return null;
  const parts: string[] = [];
  const java = /<(?:java\.version|maven\.compiler\.release|maven\.compiler\.source)>\s*([\d.]+)\s*</.exec(pom)?.[1];
  parts.push(/kotlin-maven-plugin/.test(pom) ? 'Kotlin' : `Java${java ? ` ${java}` : ''}`);
  const boot =
    /<artifactId>spring-boot-starter-parent<\/artifactId>\s*<version>\s*([^<\s]+)/.exec(pom)?.[1] ??
    /<spring-boot\.version>\s*([^<\s]+)/.exec(pom)?.[1] ??
    (/spring-boot/.test(pom) ? '' : undefined);
  if (boot !== undefined) {
    const starters = springStarters(pom);
    parts.push(`Spring Boot${boot ? ` ${boot}` : ''}${starters.length > 0 ? ` (${starters.join(', ')})` : ''}`);
  }
  parts.push((await exists(path.join(root, 'mvnw'))) ? 'Maven (wrapper)' : 'Maven');
  return parts.join(' · ');
}

async function describeGradle(root: string): Promise<string | null> {
  const marker = await firstExisting(root, ['build.gradle.kts', 'build.gradle']);
  if (!marker) return (await firstExisting(root, GRADLE_FILES)) ? 'Gradle' : null;
  const text = (await readText(path.join(root, marker))) ?? '';
  const parts: string[] = [];
  const java = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(text)?.[1] ?? /(?:source|target)Compatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([\d._]+)/.exec(text)?.[1]?.replace('_', '.');
  parts.push(/kotlin\(\s*"jvm"|org\.jetbrains\.kotlin/.test(text) ? 'Kotlin' : `Java${java ? ` ${java}` : ''}`);
  const boot = /org\.springframework\.boot['"]?\)?\s*version\s*['"]([^'"]+)/.exec(text)?.[1] ?? (/org\.springframework\.boot/.test(text) ? '' : undefined);
  if (boot !== undefined) {
    const starters = springStarters(text);
    parts.push(`Spring Boot${boot ? ` ${boot}` : ''}${starters.length > 0 ? ` (${starters.join(', ')})` : ''}`);
  }
  if (/com\.android\.(application|library)/.test(text)) parts.push('Android');
  parts.push(`Gradle${marker.endsWith('.kts') ? ' (Kotlin DSL)' : ''}`);
  return parts.join(' · ');
}

const NODE_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['@angular/core', 'Angular'],
  ['svelte', 'Svelte'],
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['vite', 'Vite'],
];

async function describeNode(root: string): Promise<string | null> {
  const text = await readText(path.join(root, 'package.json'));
  if (text === null) return null;
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return 'Node.js';
  }
  const major = (v: string | undefined): string => /(\d+)/.exec(v ?? '')?.[1] ?? '';
  const parts = [deps.typescript || (await exists(path.join(root, 'tsconfig.json'))) ? 'TypeScript' : 'JavaScript'];
  for (const [dep, name] of NODE_FRAMEWORKS) if (deps[dep]) parts.push(`${name}${major(deps[dep]) ? ` ${major(deps[dep])}` : ''}`);
  return parts.join(' · ');
}

async function describePython(root: string): Promise<string | null> {
  const marker = await firstExisting(root, ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile']);
  if (!marker) return null;
  const text = ((await readText(path.join(root, marker))) ?? '').toLowerCase();
  const fw = [['django', 'Django'], ['fastapi', 'FastAPI'], ['flask', 'Flask']].filter(([k]) => text.includes(k!)).map(([, v]) => v);
  return ['Python', ...fw].join(' · ');
}

async function describeGo(root: string): Promise<string | null> {
  const mod = await readText(path.join(root, 'go.mod'));
  if (mod === null) return null;
  const v = /^go\s+([\d.]+)/m.exec(mod)?.[1];
  return `Go${v ? ` ${v}` : ''}`;
}

async function describeDotnet(root: string): Promise<string | null> {
  const names = await listDir(root);
  let projects = names.filter((n) => DOTNET_PROJECT.test(n));
  if (projects.length === 0) {
    if (!names.some((n) => DOTNET_SOLUTION.test(n))) return null;
    // a solution at the root, projects below it: look one and two levels down (src/Api/Api.csproj)
    const below = await Promise.all(
      names.map(async (d) => {
        const one = (await listDir(path.join(root, d))).filter((n) => DOTNET_PROJECT.test(n)).map((n) => path.join(d, n));
        if (one.length > 0) return one;
        const two = await Promise.all((await listDir(path.join(root, d))).map(async (e) => (await listDir(path.join(root, d, e))).filter((n) => DOTNET_PROJECT.test(n)).map((n) => path.join(d, e, n))));
        return two.flat();
      }),
    );
    projects = below.flat().slice(0, 20);
  }
  const texts = await Promise.all(projects.map((p) => readText(path.join(root, p)).then((t) => t ?? '')));
  const all = texts.join('\n');
  const lang = projects.some((p) => p.endsWith('.fsproj')) ? 'F#' : projects.some((p) => p.endsWith('.vbproj')) ? 'VB.NET' : 'C#';
  const tfm = /<TargetFrameworks?>\s*net(\d+\.\d+)/.exec(all)?.[1];
  const parts = [lang, `.NET${tfm ? ` ${tfm}` : ''}`];
  if (/Sdk="Microsoft\.NET\.Sdk\.Web"/.test(all)) parts.push('ASP.NET Core');
  if (/Microsoft\.EntityFrameworkCore/.test(all)) parts.push('EF Core');
  if (/Sdk="Microsoft\.NET\.Sdk\.(BlazorWebAssembly|Razor)"/.test(all)) parts.push('Blazor');
  return parts.join(' · ');
}

async function describeRuby(root: string): Promise<string | null> {
  const gemfile = await readText(path.join(root, 'Gemfile'));
  if (gemfile === null) return null;
  const rails = /^\s*gem\s+['"]rails['"](?:\s*,\s*['"][~>=\s]*(\d+(?:\.\d+)?))?/m.exec(gemfile);
  if (rails) return `Ruby · Rails${rails[1] ? ` ${rails[1]}` : ''}`;
  return /^\s*gem\s+['"]sinatra['"]/m.test(gemfile) ? 'Ruby · Sinatra' : 'Ruby';
}

async function describePhp(root: string): Promise<string | null> {
  const text = await readText(path.join(root, 'composer.json'));
  if (text === null) return null;
  let require: Record<string, string> = {};
  try {
    require = (JSON.parse(text) as { require?: Record<string, string> }).require ?? {};
  } catch {
    return 'PHP · Composer';
  }
  const version = /(\d+(?:\.\d+)?)/.exec(require.php ?? '')?.[1];
  const parts = [`PHP${version ? ` ${version}` : ''}`];
  const major = (v: string | undefined): string => /(\d+)/.exec(v ?? '')?.[1] ?? '';
  if (require['laravel/framework']) parts.push(`Laravel${major(require['laravel/framework']) ? ` ${major(require['laravel/framework'])}` : ''}`);
  else if (require['symfony/framework-bundle']) parts.push(`Symfony${major(require['symfony/framework-bundle']) ? ` ${major(require['symfony/framework-bundle'])}` : ''}`);
  parts.push('Composer');
  return parts.join(' · ');
}

/**
 * One line naming the stack, e.g. "Java 17 · Spring Boot 3.2.1 (web, data-jpa) · Maven", so the
 * reviewers can apply that stack's rules (transaction boundaries, bean scopes, hooks...). Several
 * stacks in one repo are joined with " + ". Null when nothing is recognised.
 */
export async function describeProject(root: string): Promise<string | null> {
  const isGradle = (await exists(path.join(root, 'pom.xml'))) ? Promise.resolve(null) : describeGradle(root);
  const parts = await Promise.all([
    describeMaven(root),
    isGradle,
    describeNode(root),
    describePython(root),
    describeGo(root),
    (async () => ((await exists(path.join(root, 'Cargo.toml'))) ? 'Rust · Cargo' : null))(),
    describeDotnet(root),
    describeRuby(root),
    describePhp(root),
  ]);
  const found = parts.filter((p): p is string => p !== null);
  return found.length > 0 ? found.join(' + ') : null;
}

// ── file conventions shared by the fix loop and the reviewers ───────────────

// test files by the conventions of the ecosystems above: test directories (src/test/java, tests/,
// __tests__/, spec/), JS/TS *.test|spec.*, Go/Python *_test, Python test_*, JVM/.NET *Test|Tests|IT
// classes, Ruby *_spec, PHP *Test
// (class-name conventions are case-sensitive: OrderTest.java is a test, Contest.java is not)
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|(^|\/)tests?\.rs$|_spec\.rb$/i;
const TEST_CLASS = /(^|\/)[A-Z]\w*(Test|Tests|IT|Spec)\.(java|kt|kts|groovy|scala|cs|php)$/;
export const TEST_FILE: Pick<RegExp, 'test'> = { test: (file: string): boolean => TEST_PATH.test(file) || TEST_CLASS.test(file) };

// generated by package managers, never hand-edited (and useless to review line by line)
export const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|gradle\.lockfile|packages\.lock\.json|(maven|gradle)-wrapper\.jar)$/;

// build output and caches: never copied into the fix loop's temporary copy
export const DERIVED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.codexrev',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'target', // Maven, Cargo
  '.gradle',
  '.kotlin',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  '.idea',
]);
