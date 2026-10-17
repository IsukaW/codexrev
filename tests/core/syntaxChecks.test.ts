import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  onPath,
  parseBashCheck,
  parseClang,
  parseGofmt,
  parsePhpLint,
  parsePythonCompile,
  parseRubyCheck,
  runSyntaxChecks,
} from '../../src/core/toolchains/index.js';
import { runBuildRole } from '../../src/features/review-pipeline/roles/build.js';
import { ContextAggregator } from '../../src/features/review-pipeline/pipeline/contextAggregator.js';
import type { ParsedDiff } from '../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../src/features/review-pipeline/pipeline/illmProvider.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-syntax-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

const has = Object.fromEntries(
  await Promise.all(['python3', 'javac', 'ruby', 'php', 'bash', 'gofmt', 'cc'].map(async (t) => [t, await onPath(t)] as const)),
) as Record<string, boolean>;

// output captured from the real tools
describe('syntax checker parsers', () => {
  it('python: the frame naming the file, and the error line', () => {
    const out = 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n  File "bad.py", line 1\n    def f(:\n          ^\nSyntaxError: invalid syntax';
    expect(parsePythonCompile(out, 'bad.py')).toEqual([{ file: 'bad.py', line: 1, severity: 'error', message: 'SyntaxError: invalid syntax' }]);
  });
  it('ruby -c (2.x and 3.4 prism)', () => {
    expect(parseRubyCheck('bad.rb:3: syntax error, unexpected end-of-input, expecting end', 'bad.rb')).toEqual([
      { file: 'bad.rb', line: 3, severity: 'error', message: 'syntax error, unexpected end-of-input, expecting end' },
    ]);
    expect(parseRubyCheck('ruby: bad.rb:3: syntax errors found (SyntaxError)', 'bad.rb')[0]).toMatchObject({ line: 3 });
  });
  it('php -l', () => {
    expect(parsePhpLint('PHP Parse error:  syntax error, unexpected end of file in bad.php on line 3\nErrors parsing bad.php', 'bad.php')).toEqual([
      { file: 'bad.php', line: 3, severity: 'error', message: 'syntax error, unexpected end of file' },
    ]);
  });
  it('bash -n', () => {
    expect(parseBashCheck('bad.sh: line 3: syntax error: unexpected end of file', 'bad.sh')).toEqual([
      { file: 'bad.sh', line: 3, severity: 'error', message: 'syntax error: unexpected end of file' },
    ]);
  });
  it('gofmt -e: one per line, gofmt repeats itself', () => {
    const out = "bad.go:4:1: expected operand, found '}'\nbad.go:4:3: expected ';', found 'EOF'\nbad.go:4:3: expected ';', found 'EOF'";
    expect(parseGofmt(out, 'bad.go')).toEqual([{ file: 'bad.go', line: 4, severity: 'error', message: "expected operand, found '}'" }]);
  });
  it('cc -fsyntax-only, ignoring lines reported inside included headers', () => {
    const out = "bad.c:1:22: error: expected ';' after return statement\n/usr/include/x.h:9:1: warning: something\n1 error generated.";
    expect(parseClang(out, 'bad.c')).toEqual([{ file: 'bad.c', line: 1, severity: 'error', message: "expected ';' after return statement" }]);
  });
});

describe('runSyntaxChecks — real checkers', () => {
  it('returns null when the change has no source file (docs, config)', async () => {
    await write('README.md', '# hi\n');
    expect(await runSyntaxChecks(root, ['README.md', 'config.yml'])).toBeNull();
  });

  it.skipIf(!has.python3)('python: a syntax error blocks; nothing is written into the project (no __pycache__)', async () => {
    await write('app/ok.py', 'x = 1\n');
    await write('app/bad.py', 'def f(:\n    pass\n');
    const r = (await runSyntaxChecks(root, ['app/ok.py', 'app/bad.py']))!;
    expect(r.diagnostics).toEqual([expect.objectContaining({ file: 'app/bad.py', line: 1, severity: 'error', label: 'python compile' })]);
    expect(r.checks).toEqual([{ label: 'python compile', files: 2, errors: 1 }]);
    await expect(fs.access(path.join(root, 'app/__pycache__'))).rejects.toThrow();
  });

  it.skipIf(!has.javac)('plain Java: resolves classes from the same project, reports a syntax error with file and line', async () => {
    await write('src/demo/B.java', 'package demo;\nclass B { static int y() { return 2; } }\n');
    await write('src/demo/A.java', 'package demo;\npublic class A {\n  int x() { return B.y(); }\n  int z() { return 1 }\n}\n');
    const r = (await runSyntaxChecks(root, ['src/demo/A.java']))!;
    expect(r.couldNotRun).toEqual([]);
    expect(r.diagnostics).toEqual([expect.objectContaining({ file: 'src/demo/A.java', line: 4, severity: 'error', message: "';' expected" })]);
    // nothing compiled into the project
    expect((await fs.readdir(path.join(root, 'src/demo'))).sort()).toEqual(['A.java', 'B.java']);
  }, 60_000);

  it.skipIf(!has.javac)('plain Java: libraries missing here (Spring) are not reported as code defects, but a real error still is', async () => {
    await write(
      'src/demo/Svc.java',
      'package demo;\nimport org.springframework.stereotype.Service;\n@Service\npublic class Svc {\n  int a() { return Missing.call(); }\n  int b() { String s = 1; return 0; }\n}\n',
    );
    const r = (await runSyntaxChecks(root, ['src/demo/Svc.java']))!;
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/incompatible types/)]);
    expect(r.notes.join(' ')).toMatch(/libraries that are not available here/);
  }, 60_000);

  it.skipIf(!has.ruby || !has.bash)('ruby and shell, with a clean file passing', async () => {
    await write('bad.rb', 'x = 1\nif x\n  puts 1\n');
    await write('ok.sh', 'echo hi\n');
    await write('bad.sh', 'echo hi\nif [ 1 ]; then\n');
    const r = (await runSyntaxChecks(root, ['bad.rb', 'ok.sh', 'bad.sh']))!;
    expect(r.diagnostics.map((d) => [d.label, d.file, d.line])).toEqual([
      ['ruby -c', 'bad.rb', 3],
      ['bash -n', 'bad.sh', 3],
    ]);
  }, 30_000);

  it.skipIf(!has.cc)('C errors are advisory (warnings), and a missing include means "could not check", not a defect', async () => {
    await write('bad.c', 'int main() { return 0 }\n');
    await write('inc.c', '#include "nowhere/missing.h"\nint main(void) { return 0; }\n');
    const r = (await runSyntaxChecks(root, ['bad.c', 'inc.c']))!;
    expect(r.diagnostics).toEqual([expect.objectContaining({ file: 'bad.c', severity: 'warning' })]);
    expect(r.couldNotRun).toEqual([expect.objectContaining({ label: 'cc -fsyntax-only', files: ['inc.c'] })]);
  }, 30_000);

  it('lists files no built-in checker covers instead of passing them', async () => {
    await write('App.kt', 'fun main() {}\n');
    await write('index.ts', 'export const x = 1;\n');
    const r = (await runSyntaxChecks(root, ['App.kt', 'index.ts']))!;
    expect(r.unverified).toEqual(['App.kt', 'index.ts']);
    expect(r.diagnostics).toEqual([]);
  });
});

describe('Build role — projects with no build configuration', () => {
  const llm: ILLMProvider = {
    id: 'openai',
    generate: () => {
      throw new Error('unused');
    },
    stream: () => {
      throw new Error('unused');
    },
  };
  const build = (files: string[]) => {
    const diff: ParsedDiff = { ref: 'staged', raw: '', files: files.map((p) => ({ path: p, status: 'modified' as const, hunks: [] })) };
    return runBuildRole({ llm, model: 'm', diff, aggregator: new ContextAggregator(diff), cwd: root });
  };

  it.skipIf(!has.python3)('blocks on a Python syntax error, naming the checker', async () => {
    await write('main.py', 'print(\n');
    const out = await build(['main.py']);
    expect(out.verdict).toBe('block');
    expect(out.findings[0]).toMatchObject({ file: 'main.py', severity: 'high' });
    expect(out.summary).toMatch(/python compile: 1 error\(s\) in 1 file/);
  });

  it('flags (never passes) a change made only of files nothing can check', async () => {
    await write('App.kt', 'fun main() {}\n');
    const out = await build(['App.kt']);
    expect(out.verdict).toBe('flag');
    expect(out.findings[0]!.description).toMatch(/^Could not run a syntax check on App\.kt: .*toolchain\.build/);
    expect(out.summary).toMatch(/not verified: 1 file/);
  });
});
