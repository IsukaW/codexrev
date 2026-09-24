import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEdit } from '../../../src/features/review-pipeline/pipeline/editGenerator.js';
import type { ILLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { Finding } from '../../../src/features/review-pipeline/roles/roleContract.js';
import type { GenerateRequest, GenerateResponse } from '../../../src/core/types.js';

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-editgen-'));
  tmpRoot = await fs.realpath(raw);
  await fs.writeFile(
    path.join(tmpRoot, 'app.ts'),
    "export function getUser(id) {\n  const q = `SELECT * FROM users WHERE id=${id}`;\n  return db.query(q);\n}\n",
    'utf-8',
  );
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const FINDING: Finding = {
  id: 'arch-1',
  severity: 'critical',
  cwe: 'CWE-89',
  file: 'app.ts',
  lineStart: 2,
  lineEnd: 2,
  description: 'SQL injection via string interpolation.',
};

function providerReturning(reply: string): ILLMProvider {
  return {
    id: 'openai',
    async generate(_req: GenerateRequest): Promise<GenerateResponse> {
      return {
        message: { role: 'assistant', parts: [{ kind: 'text', text: reply }] },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'completed',
      };
    },
    async *stream() {
      yield { kind: 'finish', reason: 'stop' };
    },
  };
}

describe('generateEdit', () => {
  it('returns a valid edit when the model responds with a unique, present oldString', async () => {
    const reply = JSON.stringify({
      oldString: '  const q = `SELECT * FROM users WHERE id=${id}`;',
      newString: '  const q = "SELECT * FROM users WHERE id=?";\n  const params = [id];',
      description: 'Switched to a parameterized query.',
    });
    const result = await generateEdit(FINDING, { llm: providerReturning(reply), model: 'test-model', cwd: tmpRoot });
    expect(result).not.toBeNull();
    expect(result?.file).toBe('app.ts');
    expect(result?.description).toBe('Switched to a parameterized query.');
  });

  it('returns null when the model declines (oldString: null)', async () => {
    const reply = JSON.stringify({ oldString: null, newString: null, description: 'Not enough context to fix safely.' });
    const result = await generateEdit(FINDING, { llm: providerReturning(reply), model: 'test-model', cwd: tmpRoot });
    expect(result).toBeNull();
  });

  it('returns null when the model returns unparseable text', async () => {
    const result = await generateEdit(FINDING, { llm: providerReturning('not json at all'), model: 'test-model', cwd: tmpRoot });
    expect(result).toBeNull();
  });

  it('returns null when the proposed oldString does not actually appear in the file (safety check)', async () => {
    const reply = JSON.stringify({ oldString: 'this text is not in the file', newString: 'x', description: 'y' });
    const result = await generateEdit(FINDING, { llm: providerReturning(reply), model: 'test-model', cwd: tmpRoot });
    expect(result).toBeNull();
  });

  it('returns null when the proposed oldString appears more than once (ambiguous — unsafe to apply)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'app.ts'), 'const x = 1;\nconst x = 1;\n', 'utf-8');
    const reply = JSON.stringify({ oldString: 'const x = 1;', newString: 'const x = 2;', description: 'y' });
    const result = await generateEdit(
      { ...FINDING, file: 'app.ts', lineStart: 1, lineEnd: 1 },
      { llm: providerReturning(reply), model: 'test-model', cwd: tmpRoot },
    );
    expect(result).toBeNull();
  });

  it('returns null when the target file does not exist', async () => {
    const result = await generateEdit(
      { ...FINDING, file: 'missing.ts' },
      { llm: providerReturning('{}'), model: 'test-model', cwd: tmpRoot },
    );
    expect(result).toBeNull();
  });

  it('sends a ±30-line context window and the finding details in the prompt', async () => {
    let capturedPrompt = '';
    const capturingProvider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        capturedPrompt = req.messages.map((m) => m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')).join('\n');
        return {
          message: { role: 'assistant', parts: [{ kind: 'text', text: '{"oldString":null,"newString":null,"description":"n/a"}' }] },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };
    await generateEdit(FINDING, { llm: capturingProvider, model: 'test-model', cwd: tmpRoot });
    expect(capturedPrompt).toContain('CWE-89');
    expect(capturedPrompt).toContain('SQL injection via string interpolation.');
    expect(capturedPrompt).toMatch(/lines 1-5 of app\.ts/);
  });
});
