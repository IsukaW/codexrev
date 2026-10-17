import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeChange, onPath, planModules, planTestCommands } from '../../src/core/toolchains/index.js';
import { runBuildRole } from '../../src/features/review-pipeline/roles/build.js';
import { runValidation } from '../../src/features/review-pipeline/pipeline/fixValidator.js';
import { ContextAggregator } from '../../src/features/review-pipeline/pipeline/contextAggregator.js';
import type { ParsedDiff } from '../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../src/features/review-pipeline/pipeline/illmProvider.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-modules-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(file: string, content = ''): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

const pom = (artifact: string, extra = ''): string =>
  `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>${artifact}</artifactId><version>1</version>${extra}</project>`;
const diffOf = (files: string[]): ParsedDiff => ({ ref: 'staged', raw: '', files: files.map((p) => ({ path: p, status: 'modified' as const, hunks: [] })) });

describe('planModules — which build checks each changed file', () => {
  it('a Maven submodule is built from the top of its reactor, not on its own', async () => {
    await write('backend/pom.xml', pom('parent'));
    await write('backend/api/pom.xml', pom('api'));
    const plan = await planModules(root, ['backend/api/src/main/java/demo/A.java', 'backend/pom.xml']);
    expect(plan.modules.map((m) => [m.dir, m.targets.map((t) => t.label), m.files.length])).toEqual([['backend', ['mvn'], 2]]);
    expect(plan.uncovered).toEqual([]);
  });

  it('a Gradle subproject is built from the folder holding settings.gradle', async () => {
    await write('android/settings.gradle.kts');
    await write('android/app/build.gradle.kts');
    const plan = await planModules(root, ['android/app/src/main/kotlin/App.kt']);
    expect(plan.modules.map((m) => [m.dir, m.targets[0]!.label])).toEqual([['android', 'gradle']]);
  });

  it('backend and frontend of one repo each get their own build; a loose script is left for the syntax check', async () => {
    await write('backend/pom.xml', pom('api'));
    await write('web/tsconfig.json', '{}');
    const plan = await planModules(root, ['web/src/App.tsx', 'backend/src/main/java/A.java', 'scripts/deploy.py']);
    expect(plan.modules.map((m) => [m.dir, m.targets[0]!.label, m.files])).toEqual([
      ['backend', 'mvn', ['backend/src/main/java/A.java']],
      ['web', 'tsc', ['web/src/App.tsx']],
    ]);
    expect(plan.uncovered).toEqual(['scripts/deploy.py']);
  });

  it('a workspace package with no build of its own is covered by the root tsconfig', async () => {
    await write('tsconfig.json', '{}');
    await write('packages/ui/package.json', '{}');
    const plan = await planModules(root, ['packages/ui/src/Button.ts']);
    expect(plan.modules.map((m) => m.dir)).toEqual(['.']);
  });

  it('a configured build command covers everything, from the root', async () => {
    await write('backend/pom.xml', pom('api'));
    const plan = await planModules(root, ['backend/A.java', 'x.py'], { build: 'make check' });
    expect(plan.modules).toHaveLength(1);
    expect(plan.modules[0]).toMatchObject({ dir: '.', files: ['backend/A.java', 'x.py'] });
    expect(plan.modules[0]!.targets[0]!.commands).toEqual(['make check']);
  });
});

describe('planTestCommands / describeChange', () => {
  it('one suite per module the change touches, a Maven submodule tested from its reactor', async () => {
    await write('backend/pom.xml', pom('parent'));
    await write('backend/mvnw', '#!/bin/sh\n');
    await write('backend/api/pom.xml', pom('api'));
    await write('web/package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    const suites = await planTestCommands(root, ['web/src/a.ts', 'backend/api/src/main/java/A.java', 'README.md']);
    expect(suites.map((s) => [s.dir, s.label])).toEqual([
      ['backend', 'mvn test'],
      ['web', 'npm test'],
    ]);
  });

  it('names each module\'s stack for the reviewers', async () => {
    await write('backend/pom.xml', pom('api', '<properties><java.version>21</java.version></properties><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>'));
    await write('web/package.json', JSON.stringify({ dependencies: { react: '^18.3.1' }, devDependencies: { typescript: '^5.6.0', vite: '^5.4.0' } }));
    await write('web/tsconfig.json', '{}');
    expect(await describeChange(root, ['backend/src/A.java', 'web/src/App.tsx'])).toBe(
      'backend: Java 21 · Spring Boot (web) · Maven + web: TypeScript · React 18 · Vite 5',
    );
  });
});

// real tools, end to end
const hasMaven = await onPath('mvn');
const llm: ILLMProvider = {
  id: 'openai',
  generate: () => {
    throw new Error('unused');
  },
  stream: () => {
    throw new Error('unused');
  },
};

describe('a monorepo, for real', () => {
  async function multiModule(apiBody: string): Promise<void> {
    await write('backend/pom.xml', pom('parent', '<packaging>pom</packaging><modules><module>core</module><module>api</module></modules><properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>'));
    await write('backend/core/pom.xml', `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>core</artifactId></project>`);
    await write('backend/core/src/main/java/demo/core/Money.java', 'package demo.core;\npublic class Money { public static int cents(int d) { return d * 100; } }\n');
    await write(
      'backend/api/pom.xml',
      `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>api</artifactId><dependencies><dependency><groupId>demo</groupId><artifactId>core</artifactId><version>1</version></dependency></dependencies></project>`,
    );
    await write('backend/api/src/main/java/demo/api/Price.java', `package demo.api;\nimport demo.core.Money;\npublic class Price {\n  ${apiBody}\n}\n`);
  }

  it.skipIf(!hasMaven)('Build: a compile error in a submodule that uses a sibling module blocks, with the repo-relative file', async () => {
    await multiModule('int total() { return Money.cents("3"); }');
    const file = 'backend/api/src/main/java/demo/api/Price.java';
    const diff = diffOf([file]);
    const out = await runBuildRole({ llm, model: 'm', diff, aggregator: new ContextAggregator(diff), cwd: root });
    expect(out.verdict).toBe('block');
    expect(out.findings[0]).toMatchObject({ file, lineStart: 4, severity: 'high' });
    expect(out.summary).toMatch(/mvn \(backend\): 1 error/);
  }, 300_000);

  it.skipIf(!hasMaven)('Build: the same code compiled correctly passes (the sibling resolves through the reactor)', async () => {
    await multiModule('int total() { return Money.cents(3); }');
    const diff = diffOf(['backend/api/src/main/java/demo/api/Price.java']);
    const out = await runBuildRole({ llm, model: 'm', diff, aggregator: new ContextAggregator(diff), cwd: root });
    expect(out.verdict).toBe('pass');
  }, 300_000);

  it('fix validation runs every touched module\'s tests and reports the failing one', async () => {
    await write('svc/package.json', JSON.stringify({ scripts: { test: 'node t.js' } }));
    await write('svc/t.js', 'process.exit(0);\n');
    await write('web/package.json', JSON.stringify({ scripts: { test: 'node t.js' } }));
    await write('web/t.js', "console.log('web: expected 2 but got 3'); process.exit(1);\n");
    const snap = await runValidation(root, diffOf(['svc/a.js', 'web/b.js']), { toolchain: { sandbox: false } });
    expect(snap.tests.status).toBe('fail');
    expect(snap.tests.command).toBe('npm test (svc), npm test (web)');
    expect(snap.tests.output).toContain('web: expected 2 but got 3');
  }, 120_000);
});
