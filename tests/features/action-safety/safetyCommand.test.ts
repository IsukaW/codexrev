import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safetyCommandBuilder } from '../../../src/features/action-safety/cli/registerSafetyCommand.js';
import { SAFETY_EXIT_CODES, handleSafetyCommand, type SafetyFlags } from '../../../src/features/action-safety/cli/handleSafetyCommand.js';
import { PIPELINE_STAGES, runAssessmentSession } from '../../../src/features/action-safety/cli/runAssessment.js';
import { isolateModelConfig } from '../../../src/features/action-safety/testing/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let tmpRoot: string;
let out: string[];
let err: string[];
let restoreModelConfig: () => void;

beforeEach(async () => {
  restoreModelConfig = isolateModelConfig(); // the real assess path must never reach a model on this machine
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-safety-cli-')));
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  restoreModelConfig();
  process.exitCode = undefined;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const run = (rest: string[], flags: SafetyFlags = {}) => handleSafetyCommand(rest, flags, tmpRoot);
const stdout = () => out.join('\n');
const stderr = () => err.join('\n');
const listing = () => fs.readdir(tmpRoot);

async function parseWithYargs(args: string[]) {
  return (await yargs(args)
    .option('output-format', { type: 'string', default: 'text' })
    .command('safety', 'Evaluate proposed DevOps actions before execution', safetyCommandBuilder)
    .help(false)
    .version(false)
    .exitProcess(false)
    .parseAsync()) as Record<string, unknown>;
}

describe('safety command registration (yargs)', () => {
  it('parses `safety assess` with all its flags', async () => {
    const argv = await parseWithYargs([
      'safety', 'assess', '--action', 'deployment', '--target', 'production', '--input', 'in.json', '--diff', 'main', '--output', 'pack.json',
    ]);
    expect(argv._).toEqual(['safety', 'assess']);
    expect(argv).toMatchObject({ action: 'deployment', target: 'production', input: 'in.json', diff: 'main', output: 'pack.json' });
  });

  it('parses `safety verify --file`', async () => {
    const argv = await parseWithYargs(['safety', 'verify', '--file', 'pack.json']);
    expect(argv._).toEqual(['safety', 'verify']);
    expect(argv.file).toBe('pack.json');
  });

  it('parses `safety history`', async () => {
    expect((await parseWithYargs(['safety', 'history']))._).toEqual(['safety', 'history']);
  });

  it('does not make yargs reject missing options or unknown subcommands (the handler reports them)', async () => {
    expect((await parseWithYargs(['safety', 'assess']))._).toEqual(['safety', 'assess']);
    expect((await parseWithYargs(['safety']))._).toEqual(['safety']);
    expect((await parseWithYargs(['safety', 'bogus']))._).toEqual(['safety', 'bogus']);
  });

  it('keeps --output and the shared --output-format flag separate', async () => {
    const argv = await parseWithYargs(['safety', 'assess', '--output', 'pack.json', '--output-format', 'json']);
    expect(argv.output).toBe('pack.json');
    expect(argv['output-format']).toBe('json');
  });
});

describe('handleSafetyCommand: routing and usage', () => {
  it('prints usage with exit code 2 when no subcommand is given', async () => {
    await run([]);
    expect(stderr()).toMatch(/usage: codexrev safety assess/);
    expect(stderr()).toMatch(/codexrev safety verify --file/);
    expect(stderr()).toMatch(/codexrev safety history/);
    expect(process.exitCode).toBe(2);
  });

  it('rejects an unknown subcommand with exit code 2', async () => {
    await run(['bogus']);
    expect(stderr()).toMatch(/Unknown safety subcommand: bogus/);
    expect(stderr()).toMatch(/usage:/);
    expect(process.exitCode).toBe(2);
  });

  it('does not treat other command names as safety subcommands', async () => {
    for (const name of ['review', 'init', 'scan', 'models']) {
      process.exitCode = undefined;
      await run([name]);
      expect(process.exitCode).toBe(2);
    }
  });

  it('routes assess, verify and history to their own handlers', async () => {
    await run(['assess'], { action: 'deployment', target: 'production' });
    expect(stdout()).toMatch(/Action-Safety Assessment/);
    expect(stdout()).toMatch(/Target +production/);
    out.length = 0;
    await run(['history']);
    expect(stdout()).toMatch(/Audit history is not connected/);
    out.length = 0;
    await fs.writeFile(path.join(tmpRoot, 'p.json'), '{}', 'utf-8');
    await run(['verify'], { file: 'p.json' });
    expect(stdout()).toMatch(/Signature verification is not implemented/);
  });
});

describe('handleSafetyCommand: assess', () => {
  const valid: SafetyFlags = { action: 'deployment', target: 'production' };

  it('runs the whole pipeline and reports a final decision with the matching exit code (nothing supplied, so the gates BLOCK)', async () => {
    await run(['assess'], valid);
    expect(stdout()).toMatch(/Action +deployment/);
    expect(stdout()).toMatch(/Target +production/);
    expect(stdout()).toMatch(/FINAL DECISION: BLOCK/);
    expect(stdout()).toMatch(/The proposed action was NOT executed/);
    expect(stdout()).toMatch(/\[connected\] +Evidence collection/);
    expect(stdout()).toMatch(/Evidence collected \(read-only\)/);
    expect(stdout()).toMatch(/\[connected\] +Local LLM contextual interpretation/);
    expect(stdout()).toMatch(/Local model interpretation \(advisory, UNVERIFIED\)/);
    expect(stdout()).toMatch(/Status +UNAVAILABLE/);
    expect(stdout().replace(/\s+/g, ' ')).toMatch(/not a local model server/);
    expect(stdout()).toMatch(/\[not implemented\] +Signed Evidence Pack/);
    expect(stdout()).toMatch(/\[connected\] +Proposed action input/);
    expect(process.exitCode).toBe(SAFETY_EXIT_CODES.block);
    expect(process.exitCode).not.toBe(0);
  });

  it('exits 2 with usage when --action or --target is missing or invalid', async () => {
    for (const flags of [{ target: 'production' }, { action: 'deployment' }, {}, { action: 'nope', target: 'production' }, { action: 'deployment', target: 'moon' }]) {
      err.length = 0;
      process.exitCode = undefined;
      await run(['assess'], flags);
      expect(process.exitCode).toBe(2);
      expect(stderr()).toMatch(/\[codexrev safety\]/);
      expect(stderr()).toMatch(/usage:/);
    }
    expect(stdout()).toBe('');
  });

  it('exits 1 for an unreadable or invalid --input file, without usage noise', async () => {
    await run(['assess'], { ...valid, input: 'missing.json' });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/input file not found/);
    expect(stderr()).not.toMatch(/usage:/);

    err.length = 0;
    await fs.writeFile(path.join(tmpRoot, 'bad.json'), JSON.stringify({ evidence: { buildTests: { status: 'MAYBE' } } }), 'utf-8');
    await run(['assess'], { ...valid, input: 'bad.json' });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/\$\.evidence\.buildTests\.status/);
  });

  it('accepts a valid --input file and says it was validated', async () => {
    await fs.writeFile(path.join(tmpRoot, 'in.json'), JSON.stringify({ action: { impact: 'high', irreversible: true } }), 'utf-8');
    await run(['assess'], { ...valid, input: 'in.json', diff: 'main', output: 'pack.json' });
    const flat = stdout().replace(/\s+/g, ' '); // long lines wrap to the terminal width
    expect(flat).toMatch(/in\.json \(validated\)/);
    // this temp directory is not a git repository, so --diff cannot be applied, and the output must say so
    expect(flat).toMatch(/Diff main \(not applied, see limitations\)/);
    expect(flat).toMatch(/--output .*pack\.json was given\. Signed Evidence Pack output is not available yet/);
    expect(process.exitCode).toBe(SAFETY_EXIT_CODES.block);
  });

  it('writes nothing: no Evidence Pack, no .codexrev directory', async () => {
    await run(['assess'], { ...valid, output: 'pack.json' });
    expect(await listing()).toEqual([]);
  });
});

describe('handleSafetyCommand: verify', () => {
  it('requires --file', async () => {
    await run(['verify'], {});
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/--file <evidence-pack-path> is required/);
    await run(['verify'], { file: '' });
    expect(process.exitCode).toBe(2);
  });

  it('reports a missing file or a directory as exit code 1', async () => {
    await run(['verify'], { file: 'nope.json' });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/evidence pack not found/);
    err.length = 0;
    await fs.mkdir(path.join(tmpRoot, 'dir'));
    await run(['verify'], { file: 'dir' });
    expect(process.exitCode).toBe(1);
  });

  it('says verification is not implemented and does not claim the file is valid', async () => {
    const file = path.join(tmpRoot, 'pack.json');
    await fs.writeFile(file, '{"signature":"abc"}', 'utf-8');
    await run(['verify'], { file: 'pack.json' });
    expect(stdout()).toMatch(/not implemented yet/);
    expect(stdout()).toMatch(/NOT verified/);
    expect(stdout()).not.toMatch(/valid signature|verified successfully|signature is valid|authentic\b(?!\.)/i);
    expect(process.exitCode).toBe(3);
    expect(await fs.readFile(file, 'utf-8')).toBe('{"signature":"abc"}');
  });
});

describe('handleSafetyCommand: history', () => {
  it('says history is not connected, shows no entries and creates no files', async () => {
    await run(['history']);
    expect(stdout()).toMatch(/not connected yet/);
    expect(stdout()).toMatch(/none were invented/);
    expect(process.exitCode).toBe(3);
    expect(await listing()).toEqual([]);
  });
});

describe('safety CLI never executes proposed actions', () => {
  it('does not run commands described inside an input file', async () => {
    const marker = path.join(tmpRoot, 'EXECUTED.txt');
    const evil = `touch "${marker}" && echo pwned > "${marker}"`;
    await fs.writeFile(
      path.join(tmpRoot, 'in.json'),
      JSON.stringify({ action: { id: evil, description: evil }, actor: { id: evil, kind: 'agent', roles: [evil] } }),
      'utf-8',
    );
    await run(['assess'], { action: 'deployment', target: 'production', input: 'in.json', diff: `main; ${evil}` });
    await expect(fs.access(marker)).rejects.toThrow();
    expect(await listing()).toEqual(['in.json']);
  });

  it('returns a completed assessment that records the action was not executed', async () => {
    const result = await runAssessmentSession({ cwd: tmpRoot, flags: { action: 'rollback', target: 'staging' } });
    expect(result.status).toBe('completed');
    expect(result.assessment.executed).toBe(false);
    expect(result.stages).toBe(PIPELINE_STAGES);
    expect(result.stages.filter((s) => s.status !== 'connected').map((s) => s.name)).toEqual(['Signed Evidence Pack']);
    expect(result.interpretation.status).toBe('UNAVAILABLE');
    expect(result.evidence.git.state).toBe('not_a_repository');
  });

  it('keeps the CLI sources free of process execution, sandbox, shell tool and git imports', async () => {
    const dir = path.join(HERE, '..', '..', '..', 'src', 'features', 'action-safety', 'cli');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const text = await fs.readFile(path.join(dir, f), 'utf-8');
      expect(text, f).not.toMatch(/node:child_process|from 'child_process'|sandbox|tools\/builtin|simple-git|\bexecFile\b|\bspawn\b|\bexec\(/);
    }
  });

  it('does not import other members\' feature modules', async () => {
    const root = path.join(HERE, '..', '..', '..', 'src', 'features', 'action-safety');
    const stack = [root];
    while (stack.length > 0) {
      const d = stack.pop()!;
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith('.ts')) {
          expect(await fs.readFile(p, 'utf-8'), p).not.toMatch(/features\/(?!action-safety)[a-z-]+\//);
        }
      }
    }
  });
});
