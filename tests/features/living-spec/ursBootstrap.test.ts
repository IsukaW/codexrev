import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import {
  bootstrapOutputToDocument,
  buildBootstrapPrompt,
  collectBootstrapFiles,
  summarizeScan,
} from '../../../src/features/living-spec/pipeline/ursBootstrapper.js';
import {
  validateUrsBootstrapOutput,
  type UrsBootstrapOutput,
} from '../../../src/features/living-spec/tools/ursBootstrapSchema.js';
import {
  readUrsDocument,
  readUrsState,
  ursPdfPath,
  versionPdfPath,
} from '../../../src/features/living-spec/tools/stateStore.js';
import { recordVersion } from '../../../src/features/living-spec/pipeline/versionStore.js';
import { LivingSpecBootstrapError } from '../../../src/features/living-spec/tools/errors.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import type { GenerateResponse } from '../../../src/core/types.js';

let tmpRoot: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-bootstrap-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function response(text: string): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'completed',
  };
}

function fakePort(text: string | Error): LLMPort {
  return {
    provider: 'ollama',
    model: 'm',
    generate: async () => {
      if (text instanceof Error) throw text;
      return response(text);
    },
  };
}

/** Project fixture: a controller (business logic) + a util + a test + junk dirs. */
async function makeCodeFixture(): Promise<void> {
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  };
  await write(
    'src/controllers/authController.js',
    'export function login(req, res) {\n  const ok = verifyPassword(req.body);\n  if (!ok) return res.status(401).end();\n  return res.status(200).json({ token: issue(req.user) });\n}\n',
  );
  await write(
    'src/services/billingService.js',
    'export function charge(amountCents) {\n  if (amountCents <= 0) throw new Error("bad amount");\n  return ledger.post(amountCents);\n}\n',
  );
  await write('src/util.js', 'export const noop = () => {};\n');
  await write('tests/auth.test.js', 'test("login", () => {});\n');
  await write('node_modules/pkg/index.js', 'module.exports = "ignored";\n');
  await write('.codexrev/living-spec/reports/old.json', '{"stale": true}\n');
}

/** Payload citing the fixture paths (line 1 is always inside each file). */
function payload(): UrsBootstrapOutput {
  return {
    summary: 'A small auth-and-billing service.',
    sections: [
      {
        id: 'req-login',
        title: 'Login rejects bad passwords',
        text: 'The system must reject login attempts whose password fails verification.',
        type: 'functional',
        sourceRefs: [{ path: 'src/controllers/authController.js', line: 2 }],
      },
      {
        id: 'req-charge-validation',
        title: 'Charges must be positive',
        text: 'The billing service must reject non-positive charge amounts.',
        type: 'nfr',
        sourceRefs: [{ path: 'src/services/billingService.js', line: 2 }],
      },
    ],
  };
}

function payloadPort(): LLMPort {
  return fakePort(JSON.stringify(payload()));
}

const urS_DIR = (root: string) => path.join(root, '.codexrev', 'living-spec', 'urs');
const VERSIONS_DIR = (root: string) => path.join(root, '.codexrev', 'living-spec', 'versions');

describe('bootstrap scan + prompt', () => {
  it('prioritises business-logic files, honours budgets and excludes junk', async () => {
    await makeCodeFixture();
    const files = await collectBootstrapFiles(tmpRoot);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/controllers/authController.js');
    expect(paths).toContain('src/services/billingService.js');
    expect(paths).toContain('src/util.js');
    // controllers/services rank before plain utils; tests last; junk excluded
    expect(paths.indexOf('src/controllers/authController.js')).toBeLessThan(
      paths.indexOf('src/util.js'),
    );
    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('.codexrev/living-spec/reports/old.json');
    expect(files.find((f) => f.path === 'src/controllers/authController.js')?.prioritized).toBe(true);

    // byte budget: a huge file is truncated, not dropped
    await fs.writeFile(path.join(tmpRoot, 'src/big.js'), 'x'.repeat(40_000), 'utf-8');
    const capped = await collectBootstrapFiles(tmpRoot, { maxBytesPerFile: 1024 });
    const big = capped.find((f) => f.path === 'src/big.js');
    expect(big?.truncated).toBe(true);
    expect(big?.content.length).toBeLessThanOrEqual(1024);

    // file-count budget cuts from the (test-heavy) tail
    const few = await collectBootstrapFiles(tmpRoot, { maxFiles: 2 });
    expect(few.length).toBe(2);
    expect(summarizeScan(few)).toContain('2 file(s) scanned');
  });

  it('builds a hardened prompt containing every file as untrusted data', async () => {
    await makeCodeFixture();
    const files = await collectBootstrapFiles(tmpRoot);
    const prompt = buildBootstrapPrompt(files);
    expect(prompt.system).toContain('"sections"');
    expect(prompt.system).toContain('sourceRefs');
    expect(prompt.system).toContain('UNTRUSTED CONTENT');
    expect(prompt.user).toContain('<<<UNTRUSTED-DATA-BEGIN>>>');
    expect(prompt.user).toContain('=== FILE src/controllers/authController.js');
    expect(prompt.user).toContain('verifyPassword');
    expect(prompt.user).toContain('=== FILE src/util.js');
    expect(prompt.user).not.toContain('node_modules');
  });
});

describe('payload validation + document sanitisation', () => {
  it('accepts a well-formed payload and rejects malformed ones', () => {
    expect(validateUrsBootstrapOutput(payload()).ok).toBe(true);
    expect(
      validateUrsBootstrapOutput({ sections: [], summary: 'x' }).ok,
    ).toBe(false); // at least one section required
    expect(
      validateUrsBootstrapOutput({ ...payload(), sections: [{ ...payload().sections[0], id: 'Bad Id' }] }).ok,
    ).toBe(false); // kebab-case id
    const dup = payload();
    expect(validateUrsBootstrapOutput({ ...dup, sections: [dup.sections[0], dup.sections[0]] }).ok).toBe(
      false,
    ); // duplicate ids
    expect(
      validateUrsBootstrapOutput({
        ...payload(),
        sections: [{ ...payload().sections[0], sourceRefs: [] }],
      }).ok,
    ).toBe(false); // refs required
  });

  it('keeps only refs that resolve into the scan and drops unreferenced sections', async () => {
    await makeCodeFixture();
    const files = await collectBootstrapFiles(tmpRoot);
    const built = bootstrapOutputToDocument(
      {
        summary: 's',
        sections: [
          {
            id: 'req-good',
            title: 'Good',
            text: 'text',
            type: 'functional',
            sourceRefs: [
              { path: 'src/controllers/authController.js', line: 3 },
              { path: 'src/controllers/authController.js', line: 99_999 }, // past EOF
              { path: 'src/not-scanned.js', line: 1 }, // outside the scan
            ],
          },
          {
            id: 'req-bogus',
            title: 'Bogus',
            text: 'text',
            type: 'functional',
            sourceRefs: [{ path: 'src/missing.js', line: 1 }],
          },
        ],
      },
      { files, changeId: 'bootstrap' },
    );

    expect(built.doc.sections).toHaveLength(1);
    expect(built.doc.sections[0].sourceRefs).toEqual(['src/controllers/authController.js:3']);
    expect(built.doc.sections[0]).toMatchObject({ version: 0, lastChangeId: 'bootstrap' });
    expect(built.droppedSections).toEqual(['req-bogus']);
    expect(built.droppedRefs).toBe(3); // past-EOF + not-scanned + nowhere.js

    // nothing traceable → refuse instead of writing an untraceable URS
    expect(() =>
      bootstrapOutputToDocument(
        {
          summary: 's',
          sections: [
            {
              id: 'req-x',
              title: 'X',
              text: 't',
              type: 'functional',
              sourceRefs: [{ path: 'nowhere.js', line: 1 }],
            },
          ],
        },
        { files, changeId: 'bootstrap' },
      ),
    ).toThrow(LivingSpecBootstrapError);
  });
});

describe('codexrev spec bootstrap — approval gate + dual-format write', () => {
  it('--yes approves Version 0 and writes json, md and both PDFs', async () => {
    await makeCodeFixture();
    await handleSpecCommand(
      ['bootstrap'],
      { project: tmpRoot, yes: true },
      { llm: payloadPort() },
    );

    // live URS in both formats (+ md)
    const doc = await readUrsDocument(tmpRoot);
    expect(doc?.sections.map((s) => s.id)).toEqual(['req-login', 'req-charge-validation']);
    expect(doc?.sections[0].sourceRefs).toEqual(['src/controllers/authController.js:2']);
    const json = await fs.readFile(path.join(urS_DIR(tmpRoot), 'urs.json'), 'utf-8');
    expect(JSON.parse(json).schemaVersion).toBe(1);
    const md = await fs.readFile(path.join(urS_DIR(tmpRoot), 'urs.md'), 'utf-8');
    expect(md).toContain('Login rejects bad passwords');
    const pdf = await fs.readFile(ursPdfPath(tmpRoot));
    expect(pdf.subarray(0, 6).toString('latin1')).toBe('%PDF-1');
    expect(pdf.toString('latin1')).toContain('Login rejects bad passwords');

    // Version 0 snapshot in both formats + state counter at 0
    expect(await fs.readFile(path.join(VERSIONS_DIR(tmpRoot), 'v0.json'), 'utf-8')).toContain(
      '"action": "bootstrap"',
    );
    const vPdf = await fs.readFile(versionPdfPath(tmpRoot, 0));
    expect(vPdf.subarray(0, 6).toString('latin1')).toBe('%PDF-1');
    expect((await readUrsState(tmpRoot))?.version).toBe(0);

    // preview + approval result were rendered, and history lists v0 bootstrap
    const printed = logs.join('\n');
    expect(printed).toContain('URS bootstrap');
    expect(printed).toContain('approved and written');
    logs.length = 0;
    await handleSpecCommand(['history'], { project: tmpRoot });
    expect(logs.join('\n')).toContain('v0');
    expect(logs.join('\n')).toContain('bootstrap');
    expect(process.exitCode ?? 0).toBe(0);
  }, 20_000);

  it('requires approval off-TTY: exit 2 and nothing written without --yes', async () => {
    await makeCodeFixture();
    await handleSpecCommand(['bootstrap'], { project: tmpRoot }, { llm: payloadPort() });
    expect(process.exitCode).toBe(2);
    expect(errors.join('\n')).toContain('approval required');
    expect(errors.join('\n')).toContain('--yes');
    expect(await readUrsDocument(tmpRoot)).toBeNull();
    expect(await fs.readdir(VERSIONS_DIR(tmpRoot))).toEqual([]);
    // the draft was still shown so the user sees what they would approve
    expect(logs.join('\n')).toContain('draft Version 0');
    expect(logs.join('\n')).toContain('req-login');
  }, 20_000);

  it('--dry-run previews the full draft and writes nothing', async () => {
    await makeCodeFixture();
    await handleSpecCommand(
      ['bootstrap'],
      { project: tmpRoot, dryRun: true },
      { llm: payloadPort() },
    );
    const printed = logs.join('\n');
    expect(printed).toContain('draft Version 0');
    expect(printed).toContain('# User Requirements Specification');
    expect(printed).toContain('(dry-run) nothing written');
    expect(await readUrsDocument(tmpRoot)).toBeNull();
    expect(process.exitCode ?? 0).toBe(0);
  }, 20_000);

  it('refuses to overwrite an existing URS (exit 1)', async () => {
    await makeCodeFixture();
    await handleSpecCommand(['bootstrap'], { project: tmpRoot, yes: true }, { llm: payloadPort() });
    logs.length = 0;
    errors.length = 0;
    await handleSpecCommand(['bootstrap'], { project: tmpRoot, yes: true }, { llm: payloadPort() });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('already exists');
    // original document untouched (sections unchanged)
    expect((await readUrsDocument(tmpRoot))?.sections).toHaveLength(2);
  }, 20_000);

  it('explains an invalid model payload (NFR5) and writes nothing', async () => {
    await makeCodeFixture();
    await handleSpecCommand(
      ['bootstrap'],
      { project: tmpRoot, yes: true },
      { llm: fakePort('not json at all') },
    );
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('NFR5');
    expect(errors.join('\n')).toContain('nothing was written');
    expect(await readUrsDocument(tmpRoot)).toBeNull();
  }, 20_000);

  it('gives the actionable model-server hint when the model is unreachable', async () => {
    await makeCodeFixture();
    await handleSpecCommand(
      ['bootstrap'],
      { project: tmpRoot, yes: true },
      { llm: fakePort(new Error('connect ECONNREFUSED 127.0.0.1:11434')) },
    );
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('start ollama / lm studio');
    expect(errors.join('\n')).toContain('nothing was written');
    expect(await readUrsDocument(tmpRoot)).toBeNull();
  }, 20_000);
});

describe('incremental versions keep the dual format', () => {
  it('every recorded version lands as vN.json + vN.pdf and refreshes urs.pdf', async () => {
    await makeCodeFixture();
    await handleSpecCommand(['bootstrap'], { project: tmpRoot, yes: true }, { llm: payloadPort() });

    // a later approved update (proposal accept path uses the same recordVersion)
    const current = (await readUrsDocument(tmpRoot))!;
    await recordVersion(tmpRoot, {
      changeId: 'chg-1',
      action: 'accept',
      timestamp: '2026-10-17T12:00:00.000Z',
      doc: {
        ...current,
        sections: current.sections.map((s) =>
          s.id === 'req-login' ? { ...s, text: 'Updated requirement text.', version: 1 } : s,
        ),
      },
    });

    const v1Json = await fs.readFile(path.join(VERSIONS_DIR(tmpRoot), 'v1.json'), 'utf-8');
    expect(JSON.parse(v1Json).action).toBe('accept');
    const v1Pdf = await fs.readFile(versionPdfPath(tmpRoot, 1));
    expect(v1Pdf.subarray(0, 6).toString('latin1')).toBe('%PDF-1');
    expect(v1Pdf.toString('latin1')).toContain('Updated requirement text.');
    // the live PDF now reflects v1, not the bootstrap draft
    const live = await fs.readFile(ursPdfPath(tmpRoot), 'utf-8');
    expect(live).toContain('Updated requirement text.');
    expect(live).toContain('Version 1');
    expect((await readUrsState(tmpRoot))?.version).toBe(1);
  }, 20_000);
});
