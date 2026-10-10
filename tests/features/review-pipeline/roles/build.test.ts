import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseCargoCheck,
  parseGoVet,
  parseMypy,
  parseNodeCheck,
  parseTsc,
  runBuildRole,
} from '../../../../src/features/review-pipeline/roles/build.js';
import { ContextAggregator } from '../../../../src/features/review-pipeline/pipeline/contextAggregator.js';
import type { RoleRunContext } from '../../../../src/features/review-pipeline/pipeline/roleRunContext.js';
import type { ParsedDiff } from '../../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../../../src/features/review-pipeline/pipeline/illmProvider.js';

const EMPTY_DIFF: ParsedDiff = { ref: 'staged', raw: '', files: [] };

// Build role never calls the LLM, but RoleRunContext requires one — a
// provider that throws if ever invoked proves that.
const unusedLlm: ILLMProvider = {
  id: 'openai',
  generate: () => {
    throw new Error('Build role must not call the LLM');
  },
  stream: () => {
    throw new Error('Build role must not call the LLM');
  },
};

function ctxFor(cwd: string): RoleRunContext {
  return {
    llm: unusedLlm,
    model: 'unused',
    diff: EMPTY_DIFF,
    urs: undefined,
    aggregator: new ContextAggregator(EMPTY_DIFF),
    cwd,
  };
}

function diffWithFiles(paths: Array<{ path: string; status?: 'added' | 'modified' | 'deleted' }>): ParsedDiff {
  return {
    ref: 'staged',
    raw: '',
    files: paths.map((p) => ({ path: p.path, status: p.status ?? 'modified', hunks: [] })),
  };
}

function ctxWithDiff(cwd: string, diff: ParsedDiff): RoleRunContext {
  return { ...ctxFor(cwd), diff, aggregator: new ContextAggregator(diff) };
}

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-build-role-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('runBuildRole — dispatch', () => {
  it('passes with no findings when no recognized build config exists', async () => {
    const out = await runBuildRole(ctxFor(tmpRoot));
    expect(out.role).toBe('build');
    expect(out.verdict).toBe('pass');
    expect(out.findings).toEqual([]);
  });

  it('flags (does not block) when the detected toolchain cannot actually run in this environment', async () => {
    // tsconfig.json present, but this tmpdir has no local `tsc` and
    // `npx --no-install` is used, so the command cannot succeed here —
    // exercising the "could not run" path deterministically, without
    // requiring a real TypeScript project.
    await fs.writeFile(path.join(tmpRoot, 'tsconfig.json'), '{}', 'utf-8');
    const out = await runBuildRole(ctxFor(tmpRoot));
    expect(out.role).toBe('build');
    expect(out.verdict).toBe('flag');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].description).toMatch(/Could not run "tsc"/);
  }, 30_000);

  it('dispatches every detected marker in a polyglot repo, not just the first', async () => {
    await fs.writeFile(path.join(tmpRoot, 'tsconfig.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(tmpRoot, 'pyproject.toml'), '[tool.mypy]\n', 'utf-8');
    const out = await runBuildRole(ctxFor(tmpRoot));
    expect(out.summary).toMatch(/Ran 2 build check/);
  }, 30_000);
});

describe('runBuildRole — buildless-project fallback (node --check)', () => {
  it('still passes with no findings when no markers exist AND no JS files are in the diff', async () => {
    const out = await runBuildRole(ctxFor(tmpRoot)); // EMPTY_DIFF has no files
    expect(out.verdict).toBe('pass');
    expect(out.findings).toEqual([]);
    expect(out.summary).toMatch(/no JS files in this diff/);
  });

  it('passes when the only JS file in the diff is syntactically valid', async () => {
    await fs.writeFile(path.join(tmpRoot, 'good.js'), 'const x = 1;\nmodule.exports = { x };\n', 'utf-8');
    const out = await runBuildRole(ctxWithDiff(tmpRoot, diffWithFiles([{ path: 'good.js' }])));
    expect(out.verdict).toBe('pass');
    expect(out.findings).toEqual([]);
    expect(out.summary).toMatch(/node --check \(fallback/);
  });

  it('blocks on a real JS syntax error caught by node --check', async () => {
    await fs.writeFile(path.join(tmpRoot, 'bad.js'), 'const x = ;\n', 'utf-8');
    const out = await runBuildRole(ctxWithDiff(tmpRoot, diffWithFiles([{ path: 'bad.js' }])));
    expect(out.verdict).toBe('block');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].severity).toBe('high');
    expect(out.findings[0].file).toBe('bad.js');
    expect(out.findings[0].description).toMatch(/SyntaxError/);
  });

  it('only checks .js/.mjs/.cjs files in the diff, skipping others (e.g. .md, .json)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'notes.md'), '# not js\n', 'utf-8');
    const out = await runBuildRole(ctxWithDiff(tmpRoot, diffWithFiles([{ path: 'notes.md' }])));
    expect(out.verdict).toBe('pass');
    expect(out.summary).toMatch(/no JS files in this diff/);
  });

  it('skips deleted files — nothing on disk left to check', async () => {
    const out = await runBuildRole(ctxWithDiff(tmpRoot, diffWithFiles([{ path: 'gone.js', status: 'deleted' }])));
    expect(out.verdict).toBe('pass');
    expect(out.summary).toMatch(/no JS files in this diff/);
  });

  it('does not run the fallback when a real build marker IS present', async () => {
    await fs.writeFile(path.join(tmpRoot, 'tsconfig.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(tmpRoot, 'bad.js'), 'const x = ;\n', 'utf-8');
    const out = await runBuildRole(ctxWithDiff(tmpRoot, diffWithFiles([{ path: 'bad.js' }])));
    // tsconfig.json present → dispatches tsc (which fails to run in this
    // sandbox, per the earlier "could not run" test), never touches the
    // node --check fallback path at all.
    expect(out.summary).toMatch(/Ran 1 build check/);
    expect(out.summary).not.toMatch(/node --check/);
  }, 30_000);
});

describe('build diagnostic parsers', () => {
  it('parseTsc extracts file/line/severity/code/message', () => {
    const out = parseTsc('src/foo.ts(10,5): error TS2322: Type mismatch.\nsrc/bar.ts(3,1): warning TS6133: unused.');
    expect(out).toEqual([
      { file: 'src/foo.ts', line: 10, severity: 'error', code: 'TS2322', message: 'Type mismatch.' },
      { file: 'src/bar.ts', line: 3, severity: 'warning', code: 'TS6133', message: 'unused.' },
    ]);
  });

  it('parseGoVet extracts file/line/message and skips package header lines', () => {
    const out = parseGoVet('# example.com/pkg\n./main.go:10:2: unreachable code');
    expect(out).toEqual([{ file: './main.go', line: 10, severity: 'error', message: 'unreachable code' }]);
  });

  it('parseCargoCheck extracts file/line/severity/code/message', () => {
    const out = parseCargoCheck('src/main.rs:3:5: error[E0384]: cannot assign twice to immutable variable');
    expect(out).toEqual([
      { file: 'src/main.rs', line: 3, severity: 'error', code: 'E0384', message: 'cannot assign twice to immutable variable' },
    ]);
  });

  it('parseMypy extracts file/line/severity/message/code, dropping notes', () => {
    const out = parseMypy(
      'app.py:10: error: Incompatible types in assignment [assignment]\napp.py:11: note: see docs',
    );
    expect(out).toEqual([{ file: 'app.py', line: 10, severity: 'error', message: 'Incompatible types in assignment', code: 'assignment' }]);
  });

  it('parseNodeCheck extracts line/message from real `node --check` output', () => {
    const realOutput = [
      '/private/tmp/nodecheck-probe/bad.js:1',
      'const x = ;',
      '          ^',
      '',
      "SyntaxError: Unexpected token ';'",
      '    at wrapSafe (node:internal/modules/cjs/loader:1662:18)',
    ].join('\n');
    const out = parseNodeCheck(realOutput, 'bad.js');
    expect(out).toEqual([{ file: 'bad.js', line: 1, severity: 'error', message: "SyntaxError: Unexpected token ';'" }]);
  });

  it('parseNodeCheck returns [] for empty (valid-syntax) output', () => {
    expect(parseNodeCheck('', 'good.js')).toEqual([]);
  });
});
