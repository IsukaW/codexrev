import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DERIVED_DIRS,
  LOCKFILE,
  TEST_FILE,
  buildToolchainSeatbeltProfile,
  describeProject,
  detectTestCommand,
  onPath,
  parseAnyCompilerOutput,
  parseDotnet,
  parseJavac,
  parseMaven,
  planBuildTargets,
  stripBuildToolNoise,
  runToolchainCommand,
} from '../../src/core/toolchains/index.js';
import { runBuildRole } from '../../src/features/review-pipeline/roles/build.js';
import { ContextAggregator } from '../../src/features/review-pipeline/pipeline/contextAggregator.js';
import type { ParsedDiff } from '../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { RoleRunContext } from '../../src/features/review-pipeline/pipeline/roleRunContext.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-toolchain-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = async (rel: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
};

const EMPTY_DIFF: ParsedDiff = { ref: 'staged', raw: '', files: [] };
const unusedLlm: ILLMProvider = {
  id: 'openai',
  generate: () => {
    throw new Error('Build role must not call the LLM');
  },
  stream: () => {
    throw new Error('Build role must not call the LLM');
  },
};
const ctx = (extra: Partial<RoleRunContext> = {}): RoleRunContext => ({
  llm: unusedLlm,
  model: 'unused',
  diff: EMPTY_DIFF,
  aggregator: new ContextAggregator(EMPTY_DIFF),
  cwd: root,
  ...extra,
});

describe('parsers — real compiler output', () => {
  it('parseMaven: relative paths, javac detail lines kept, Maven\'s duplicate summary dropped', () => {
    const out = [
      '[ERROR] COMPILATION ERROR : ',
      `[ERROR] ${root}/src/main/java/demo/App.java:[3,20] cannot find symbol`,
      '  symbol:   variable y',
      '  location: class demo.App',
      `[WARNING] ${root}/src/main/java/demo/Old.java:[7,5] [deprecation] foo() in Bar has been deprecated`,
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile (default-compile) on project demo: Compilation failure',
      `[ERROR] ${root}/src/main/java/demo/App.java:[3,20] cannot find symbol`,
      '[ERROR]   symbol:   variable y',
    ].join('\n');
    expect(parseMaven(out, root)).toEqual([
      { file: 'src/main/java/demo/App.java', line: 3, severity: 'error', message: 'cannot find symbol (symbol: variable y, location: class demo.App)' },
      { file: 'src/main/java/demo/Old.java', line: 7, severity: 'warning', message: '[deprecation] foo() in Bar has been deprecated' },
    ]);
  });

  it('parseJavac: javac/Gradle Java lines and Kotlin compiler lines', () => {
    const out = [
      'src/test/java/demo/AppTest.java:3: error: cannot find symbol',
      '  void t() { new App().nope(); }',
      '                      ^',
      '  symbol:   method nope()',
      '  location: class App',
      `e: file://${root}/src/main/kotlin/App.kt:12:5 Unresolved reference: y`,
      `w: ${root}/src/main/kotlin/App.kt:20:1 'old' is deprecated`,
      '> Task :compileJava FAILED',
    ].join('\n');
    expect(parseJavac(out, root)).toEqual([
      { file: 'src/test/java/demo/AppTest.java', line: 3, severity: 'error', message: 'cannot find symbol (symbol: method nope(), location: class App)' },
      { file: 'src/main/kotlin/App.kt', line: 12, severity: 'error', message: 'Unresolved reference: y' },
      { file: 'src/main/kotlin/App.kt', line: 20, severity: 'warning', message: "'old' is deprecated" },
    ]);
  });

  it('parseDotnet', () => {
    expect(parseDotnet(`src/App.cs(12,5): error CS0103: The name 'y' does not exist in the current context [${root}/App.csproj]`, root)).toEqual([
      { file: 'src/App.cs', line: 12, severity: 'error', code: 'CS0103', message: "The name 'y' does not exist in the current context" },
    ]);
  });

  it('parseAnyCompilerOutput: one diagnostic per location even when several shapes match', () => {
    const out = 'src/A.java:3: error: cannot find symbol\nsrc/a.c:9:2: error: expected \';\'\nsrc/x.ts(1,1): error TS2322: bad';
    expect(parseAnyCompilerOutput(out, root).map((d) => `${d.file}:${d.line}`).sort()).toEqual(['src/A.java:3', 'src/a.c:9', 'src/x.ts:1']);
  });
});

describe('stripBuildToolNoise', () => {
  it("keeps Maven's failing test and its expected/actual, drops the help footer that would otherwise fill the tail", () => {
    const out = [
      '[ERROR] Failures: ',
      '[ERROR]   PriceServiceTest.tenPercent:5 expected: <90> but was: <80>',
      '[INFO] ',
      '[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0',
      '[INFO] BUILD FAILURE',
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:2.22.2:test (default-test) on project boot: There are test failures.',
      '[ERROR] ',
      '[ERROR] Please refer to /x/target/surefire-reports for the individual test results.',
      '[ERROR] -> [Help 1]',
      '[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.',
      '[ERROR] Re-run Maven using the -X switch to enable full debug logging.',
      '[ERROR] For more information about the errors and possible solutions, please read the following articles:',
      '[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException',
    ].join('\n');
    expect(stripBuildToolNoise(out)).toBe(
      [
        '[ERROR] Failures: ',
        '[ERROR]   PriceServiceTest.tenPercent:5 expected: <90> but was: <80>',
        '[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0',
        '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:2.22.2:test (default-test) on project boot: There are test failures.',
      ].join('\n'),
    );
  });
});

describe('stripBuildToolNoise — stack frames', () => {
  it("keeps the frame in the project's own code, drops runtime and test-framework frames (.NET, JUnit, Node)", () => {
    const out = [
      '   Assert.Equal() Failure: Values differ',
      'Expected: 90',
      'Actual:   80',
      '     at Shop.Tests.UnitTest1.TenPercent() in tests/Shop.Tests/UnitTest1.cs:line 6',
      '   at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments)',
      '\tat demo.PriceServiceTest.tenPercent(PriceServiceTest.java:5)',
      '\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
      '\tat org.junit.platform.commons.util.ReflectionUtils.invokeMethod(ReflectionUtils.java:728)',
      '\t... 41 more',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    expect(stripBuildToolNoise(out).split('\n')).toEqual([
      'Assert.Equal() Failure: Values differ', // the whole output is trimmed
      'Expected: 90',
      'Actual:   80',
      '     at Shop.Tests.UnitTest1.TenPercent() in tests/Shop.Tests/UnitTest1.cs:line 6',
      '\tat demo.PriceServiceTest.tenPercent(PriceServiceTest.java:5)',
    ]);
  });
});

describe('planBuildTargets', () => {
  it('Maven: prefers the project\'s wrapper and compiles tests too', async () => {
    await write('pom.xml', '<project/>');
    await write('mvnw', '#!/bin/sh\n');
    const [t] = await planBuildTargets(root);
    expect(t).toMatchObject({ label: 'mvn', marker: 'pom.xml', commands: ['sh ./mvnw -B -q test-compile'] });
    expect(t!.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  it('Gradle: wrapper, Kotlin DSL marker, no daemon; Maven wins when both build files exist', async () => {
    await write('build.gradle.kts', 'plugins { java }');
    await write('gradlew', '#!/bin/sh\n');
    expect((await planBuildTargets(root))[0]).toMatchObject({ label: 'gradle', marker: 'build.gradle.kts', commands: ['sh ./gradlew --no-daemon --console=plain -q classes testClasses'] });
    await write('pom.xml', '<project/>');
    expect((await planBuildTargets(root)).map((t) => t.label)).toEqual(['mvn']);
  });

  it('reports a missing build tool as unavailable instead of running anything', async () => {
    await write('settings.gradle', '');
    const hasGradle = await onPath('gradle');
    const [t] = await planBuildTargets(root);
    if (hasGradle) expect(t!.unavailable).toBeUndefined();
    else expect(t!.unavailable).toMatch(/Gradle is not installed/);
  });

  it('a polyglot repo gets one target per toolchain', async () => {
    await write('pom.xml', '<project/>');
    await write('tsconfig.json', '{}');
    expect((await planBuildTargets(root)).map((t) => t.label).sort()).toEqual(['mvn', 'tsc']);
  });

  it('a configured build command replaces detection', async () => {
    await write('pom.xml', '<project/>');
    const targets = await planBuildTargets(root, { build: 'make check', buildTimeoutMs: 5000 });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ label: 'make', commands: ['make check'], timeoutMs: 5000 });
  });
});

describe('detectTestCommand', () => {
  it('Maven and Gradle, with long default timeouts', async () => {
    await write('pom.xml', '<project/>');
    await write('mvnw', '');
    expect(await detectTestCommand(root)).toMatchObject({ command: 'sh ./mvnw -B test', label: 'mvn test' });
    await fs.rm(path.join(root, 'pom.xml'));
    await write('build.gradle', '');
    await write('gradlew', '');
    const g = await detectTestCommand(root);
    expect(g).toMatchObject({ command: 'sh ./gradlew --no-daemon --console=plain test', label: 'gradle test' });
    expect(g!.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  it('npm script first, the placeholder script is ignored, Makefile and rspec are known', async () => {
    await write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(await detectTestCommand(root)).toBeNull();
    await write('Makefile', 'build:\n\ttrue\ntest:\n\ttrue\n');
    expect((await detectTestCommand(root))?.label).toBe('make test');
    await write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect((await detectTestCommand(root))?.label).toBe('npm test');
  });

  it('the configured test command wins, with its timeout', async () => {
    await write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(await detectTestCommand(root, { test: './run-tests.sh', testTimeoutMs: 9000 })).toEqual({ command: './run-tests.sh', label: './run-tests.sh', timeoutMs: 9000 });
  });
});

describe('describeProject', () => {
  it('Spring Boot on Maven', async () => {
    await write(
      'pom.xml',
      `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.5</version></parent>
       <properties><java.version>17</java.version></properties>
       <dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
       <dependency><artifactId>spring-boot-starter-test</artifactId></dependency></dependencies></project>`,
    );
    await write('mvnw', '');
    expect(await describeProject(root)).toBe('Java 17 · Spring Boot 3.2.5 (web, data-jpa) · Maven (wrapper)');
  });

  it('Spring Boot on Gradle Kotlin DSL, plus a TypeScript/React frontend in the same repo', async () => {
    await write('build.gradle.kts', 'plugins { id("org.springframework.boot") version "3.3.0" }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\ndependencies { implementation("org.springframework.boot:spring-boot-starter-security") }');
    await write('package.json', JSON.stringify({ dependencies: { react: '^18.2.0' }, devDependencies: { typescript: '5.4.0', vite: '5.2.0' } }));
    expect(await describeProject(root)).toBe('Java 21 · Spring Boot 3.3.0 (security) · Gradle (Kotlin DSL) + TypeScript · React 18 · Vite 5');
  });

  it('null for a folder with nothing recognisable', async () => {
    await write('main.c', 'int main(){}');
    expect(await describeProject(root)).toBeNull();
  });
});

describe('file conventions', () => {
  it('recognises JVM, .NET, Ruby and PHP test files as tests, and not their production classes', () => {
    for (const f of ['src/test/java/demo/AppTest.java', 'app/src/test/kotlin/FooTests.kt', 'svc/OrderServiceIT.java', 'Api.Tests/CalcTests.cs', 'lib/user_spec.rb', 'UserTest.php']) {
      expect(TEST_FILE.test(f), f).toBe(true);
    }
    for (const f of ['src/main/java/demo/App.java', 'src/main/java/demo/Contest.java', 'src/main/java/demo/Testimonial.java', 'Services/Calc.cs']) {
      expect(TEST_FILE.test(f), f).toBe(false);
    }
  });

  it('knows the lockfiles and build directories of the JVM ecosystems', () => {
    expect(LOCKFILE.test('gradle.lockfile')).toBe(true);
    expect(LOCKFILE.test('gradle/wrapper/gradle-wrapper.jar')).toBe(true);
    expect(LOCKFILE.test('pom.xml')).toBe(false);
    expect(DERIVED_DIRS.has('target')).toBe(true);
    expect(DERIVED_DIRS.has('.gradle')).toBe(true);
    expect(DERIVED_DIRS.has('.mvn')).toBe(false); // holds the Maven wrapper's config — must reach the temporary copy
  });
});

describe('runToolchainCommand', () => {
  it('runs a command that forks and reports output, exit code and "not found"', async () => {
    const ok = await runToolchainCommand('echo one && (echo two) && sh -c "echo three"', root, { timeoutMs: 15_000 });
    expect(ok.code).toBe(0);
    expect(ok.output).toBe('one\ntwo\nthree');
    const missing = await runToolchainCommand('definitely-not-a-real-tool-xyz --version', root, { timeoutMs: 15_000 });
    expect(missing.notFound).toBe(true);
  });

  it('may write to the project but not elsewhere in the home directory', async () => {
    const r = await runToolchainCommand('echo hi > written.txt', root, { timeoutMs: 15_000 });
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(root, 'written.txt'), 'utf-8')).toBe('hi\n');
    if (r.sandboxed) {
      const outside = path.join(os.homedir(), `.codexrev-sandbox-probe-${process.pid}`);
      const denied = await runToolchainCommand(`echo x > ${JSON.stringify(outside)}`, root, { timeoutMs: 15_000 });
      expect(denied.code).not.toBe(0);
      await expect(fs.access(outside)).rejects.toThrow();
    }
  });

  it('the macOS profile allows forking and the build tools\' caches, not the whole home directory', () => {
    const profile = buildToolchainSeatbeltProfile(root);
    expect(profile).toContain('(allow process-fork)');
    expect(profile).toContain(JSON.stringify(path.join(os.homedir(), '.m2')));
    expect(profile).toContain(JSON.stringify(path.join(os.homedir(), '.gradle')));
    expect(profile).not.toContain(`(subpath ${JSON.stringify(os.homedir())})`);
  });
});

// top level: describe callbacks cannot be async
const hasMaven = await onPath('mvn');

describe('Build role on top of the registry', () => {
  it('a configured build command runs, and its diagnostics become findings', async () => {
    await write('build.sh', "echo \"src/a.c:3:5: error: expected ';' before '}' token\"; exit 1\n");
    const out = await runBuildRole(ctx({ toolchain: { build: 'sh build.sh' } }));
    expect(out.verdict).toBe('block');
    expect(out.findings).toMatchObject([{ file: 'src/a.c', lineStart: 3, severity: 'high' }]);
    expect(out.summary).toContain('configured in settings');
  });

  it('a tool that fails without recognisable diagnostics is an environment gap (flag), not a code defect', async () => {
    const out = await runBuildRole(ctx({ toolchain: { build: 'echo "Could not resolve dependencies for project demo" && exit 1' } }));
    expect(out.verdict).toBe('flag');
    expect(out.findings[0]!.description).toMatch(/^Could not run "echo" in this environment: .*Could not resolve dependencies/);
  });

  // a real Maven build, end to end: needs a JDK, Maven and the compiler plugin in ~/.m2 (or network)
  it.skipIf(!hasMaven)('Maven: a Java compile error in main or test code blocks, with the right file and line', async () => {
    await write(
      'pom.xml',
      '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>demo</artifactId><version>1</version>' +
        '<properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties></project>',
    );
    await write('src/main/java/demo/App.java', 'package demo;\npublic class App {\n  int x() { return 1; }\n}\n');
    await write('src/test/java/demo/AppTest.java', 'package demo;\nclass AppTest {\n  void t() { new App().nope(); }\n}\n');
    const out = await runBuildRole(ctx());
    if (out.verdict === 'flag') {
      // no network and an empty ~/.m2: Maven could not even start compiling — reported as such, never as a pass
      expect(out.findings[0]!.description).toMatch(/^Could not run "mvn"/);
      return;
    }
    expect(out.verdict).toBe('block');
    expect(out.findings).toMatchObject([{ file: 'src/test/java/demo/AppTest.java', lineStart: 3, severity: 'high' }]);
    expect(out.findings[0]!.description).toMatch(/mvn: cannot find symbol \(symbol: +method nope\(\)/);
    expect(out.summary).toMatch(/mvn: 1 error/);
  }, 600_000);
});
