// Monorepos and multi-module projects: which build checks and which test suites a change needs.
//
// Each changed file belongs to the nearest folder above it that has its own build (or tests):
// `backend/src/main/java/...` → `backend` (pom.xml), `web/src/App.tsx` → `web` (tsconfig.json),
// a script with nothing above it but the repo root → the root. Those folders are built and tested
// where they are, so a Spring Boot API next to a React app gets `mvn` in one and `tsc` in the other.
//
// JVM and .NET builds are the exception to "nearest": a Maven or Gradle submodule usually cannot
// build on its own (it depends on its siblings), so a file in `api/` of a multi-module project is
// checked from the top of that build — the outermost pom.xml in an unbroken chain of them, or the
// folder holding settings.gradle(.kts) — which builds every module the change can affect. A .NET
// project goes to the folder of its solution (.sln), so the test projects beside it run as well.
//
// A folder whose build file gives nothing to run (a package.json without a tsconfig) does not
// claim its files: they go to the next folder up that does, so a workspace package is still
// type-checked by the repo's root tsconfig. Files no build covers are left for the syntax check.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DOTNET_PROJECT, DOTNET_SOLUTION, describeProject, detectTestCommand, planBuildTargets, type BuildTarget, type TestCommand, type ToolchainOverride } from './registry.js';

/** a folder the change is built in: its checks, and the changed files it covers (repo-relative, posix) */
export interface BuildModule {
  /** repo-relative, posix; '.' for the repo root */
  readonly dir: string;
  readonly targets: readonly BuildTarget[];
  readonly files: readonly string[];
}

export interface ModulePlan {
  readonly modules: readonly BuildModule[];
  /** changed files no build covers (checked file by file instead) */
  readonly uncovered: readonly string[];
  /** modules beyond MAX_MODULES, not checked */
  readonly skipped: readonly string[];
}

export interface ModuleTestCommand extends TestCommand {
  /** where to run it: repo-relative, posix, '.' for the root */
  readonly dir: string;
}

const MAX_MODULES = 8;

// files whose presence makes a folder worth asking planBuildTargets/detectTestCommand about
const BUILD_MARKERS = ['tsconfig.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'go.mod', 'Cargo.toml', 'pyproject.toml'];
const TEST_MARKERS = [...BUILD_MARKERS, 'package.json', 'pytest.ini', 'setup.py', 'setup.cfg', 'tox.ini', 'requirements.txt', 'Makefile', 'Gemfile', 'Rakefile', 'composer.json'];

// fixed names above, plus .NET's solution/project files, which are named after the project
async function hasMarker(abs: string, names: readonly string[]): Promise<boolean> {
  const entries = await fs.readdir(abs).catch(() => [] as string[]);
  return entries.some((e) => names.includes(e) || DOTNET_SOLUTION.test(e) || DOTNET_PROJECT.test(e));
}
const GRADLE_SETTINGS = ['settings.gradle.kts', 'settings.gradle'];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const posix = (p: string): string => p.split(path.sep).join('/');
const parentOf = (dir: string): string | null => (dir === '.' ? null : path.posix.dirname(dir));

/** a file's folder and every folder above it, up to and including the repo root ('.') */
function ancestors(file: string): string[] {
  const out: string[] = [];
  for (let dir: string | null = path.posix.dirname(posix(file)); dir !== null; dir = parentOf(dir)) out.push(dir);
  return out;
}

// the top of the Maven/Gradle build — or the .NET solution — `dir` belongs to (see header); `dir` itself otherwise
async function enclosingBuildRoot(root: string, dir: string): Promise<string> {
  const at = (d: string, f: string): Promise<boolean> => exists(path.join(root, d, f));
  // a .NET project is built and tested through its solution, so the test projects next to it run too
  const listing = async (d: string): Promise<string[]> => fs.readdir(path.join(root, d)).catch(() => [] as string[]);
  if ((await listing(dir)).some((e) => DOTNET_PROJECT.test(e) || DOTNET_SOLUTION.test(e))) {
    for (let up: string | null = dir; up !== null; up = parentOf(up)) {
      if ((await listing(up)).some((e) => DOTNET_SOLUTION.test(e))) return up;
    }
    return dir;
  }
  if (await at(dir, 'pom.xml')) {
    let top = dir;
    for (let up = parentOf(top); up !== null && (await at(up, 'pom.xml')); up = parentOf(top)) top = up;
    return top;
  }
  if ((await at(dir, 'build.gradle')) || (await at(dir, 'build.gradle.kts')) || (await at(dir, GRADLE_SETTINGS[0]!)) || (await at(dir, GRADLE_SETTINGS[1]!))) {
    for (let up: string | null = dir; up !== null; up = parentOf(up)) {
      for (const s of GRADLE_SETTINGS) if (await at(up, s)) return up;
    }
  }
  return dir;
}

function cached<T>(fn: (dir: string) => Promise<T>): (dir: string) => Promise<T> {
  const memo = new Map<string, Promise<T>>();
  return (dir) => {
    let p = memo.get(dir);
    if (!p) memo.set(dir, (p = fn(dir)));
    return p;
  };
}

/** where each changed file is built (see header). With no files, the repo root alone — what a plain scan of the project checks. */
export async function planModules(root: string, changedFiles: readonly string[], override?: ToolchainOverride): Promise<ModulePlan> {
  // a configured build command is the whole project's build: it covers every file, from the root
  if ((typeof override?.build === 'string' && override.build.trim()) || changedFiles.length === 0) {
    const targets = await planBuildTargets(root, override);
    return targets.length > 0 || changedFiles.length === 0
      ? { modules: [{ dir: '.', targets, files: changedFiles.map(posix) }], uncovered: [], skipped: [] }
      : { modules: [], uncovered: changedFiles.map(posix), skipped: [] };
  }

  const noBuild: ToolchainOverride | undefined = override ? { ...override, build: undefined } : undefined;
  const targetsAt = cached(async (dir): Promise<readonly BuildTarget[]> => {
    const abs = path.join(root, dir);
    return (await hasMarker(abs, BUILD_MARKERS)) ? planBuildTargets(abs, noBuild) : [];
  });
  const buildRootOf = cached(async (dir): Promise<string | null> => {
    for (const d of ancestors(`${dir}/x`)) {
      if ((await targetsAt(d)).length > 0) return enclosingBuildRoot(root, d);
    }
    return null;
  });

  const byModule = new Map<string, string[]>();
  const uncovered: string[] = [];
  for (const file of changedFiles.map(posix)) {
    const dir = await buildRootOf(path.posix.dirname(file));
    if (dir === null) uncovered.push(file);
    else byModule.set(dir, [...(byModule.get(dir) ?? []), file]);
  }
  const dirs = [...byModule.keys()].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
  const modules: BuildModule[] = [];
  for (const dir of dirs.slice(0, MAX_MODULES)) modules.push({ dir, targets: await targetsAt(dir), files: byModule.get(dir)! });
  return { modules, uncovered, skipped: dirs.slice(MAX_MODULES) };
}

/** the test suites a change needs: one per folder its files are tested in (nearest folder with a test command). */
export async function planTestCommands(root: string, changedFiles: readonly string[], override?: ToolchainOverride): Promise<ModuleTestCommand[]> {
  const atRoot = async (): Promise<ModuleTestCommand[]> => {
    const t = await detectTestCommand(root, override);
    return t ? [{ ...t, dir: '.' }] : [];
  };
  if ((typeof override?.test === 'string' && override.test.trim()) || changedFiles.length === 0) return atRoot();

  const testAt = cached(async (dir): Promise<TestCommand | null> => {
    const abs = path.join(root, dir);
    return (await hasMarker(abs, TEST_MARKERS)) ? detectTestCommand(abs, override) : null;
  });
  const found = new Map<string, TestCommand>();
  for (const file of changedFiles.map(posix)) {
    for (const d of ancestors(file)) {
      const own = await testAt(d);
      if (!own) continue;
      // a Maven/Gradle submodule's tests run from the top of its build (they need the siblings built)
      const top = await enclosingBuildRoot(root, d);
      const topCommand = top !== d ? await testAt(top) : null;
      if (topCommand) found.set(top, topCommand);
      else found.set(d, own);
      break;
    }
  }
  if (found.size === 0) return atRoot();
  return [...found.entries()]
    .sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)))
    .slice(0, MAX_MODULES)
    .map(([dir, t]) => ({ ...t, dir }));
}

/**
 * The stack line for the reviewers, per module when the change spans several:
 * "backend: Java 17 · Spring Boot 3.2.5 (web) · Maven + web: TypeScript · React 18 · Vite 5".
 */
export async function describeChange(root: string, changedFiles: readonly string[]): Promise<string | null> {
  const plan = await planModules(root, changedFiles);
  const dirs = plan.modules.map((m) => m.dir).filter((d) => d !== '.');
  const rootLine = await describeProject(root);
  if (dirs.length === 0) return rootLine;
  const parts = (await Promise.all(dirs.map(async (d) => [d, await describeProject(path.join(root, d))] as const)))
    .filter(([, line]) => line !== null)
    .map(([d, line]) => `${d}: ${line}`);
  if (rootLine && plan.modules.some((m) => m.dir === '.')) parts.unshift(rootLine);
  return parts.length > 0 ? parts.join(' + ') : rootLine;
}
