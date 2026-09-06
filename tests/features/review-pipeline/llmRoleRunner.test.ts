import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractJson,
  formatDiffForPrompt,
  formatPriorContextForPrompt,
  LlmRoleResponseError,
  roleContractInstructions,
  runLlmRole,
} from '../../../src/features/review-pipeline/pipeline/llmRoleRunner.js';
import { ContextAggregator } from '../../../src/features/review-pipeline/pipeline/contextAggregator.js';
import { RoleContractError } from '../../../src/features/review-pipeline/roles/roleContract.js';
import type { ParsedDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { RoleRunContext } from '../../../src/features/review-pipeline/pipeline/roleRunContext.js';
import type { ILLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { GenerateRequest, GenerateResponse } from '../../../src/core/types.js';

const SAMPLE_DIFF: ParsedDiff = {
  ref: 'staged',
  raw: 'diff --git a/x.ts b/x.ts\n',
  files: [
    {
      path: 'x.ts',
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { type: 'context', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
            { type: 'del', content: 'old', oldLineNumber: 2 },
            { type: 'add', content: 'new1', newLineNumber: 2 },
            { type: 'add', content: 'new2', newLineNumber: 3 },
          ],
        },
      ],
    },
  ],
};

function fakeProvider(reply: string): ILLMProvider {
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

function makeCtx(llm: ILLMProvider): RoleRunContext {
  return {
    llm,
    model: 'test-model',
    diff: SAMPLE_DIFF,
    urs: undefined,
    aggregator: new ContextAggregator(SAMPLE_DIFF),
    cwd: '/tmp/does-not-matter',
  };
}

describe('formatDiffForPrompt', () => {
  it('includes explicit line-number markers for add/del/context lines', () => {
    const out = formatDiffForPrompt(SAMPLE_DIFF);
    expect(out).toContain('File: x.ts (modified)');
    expect(out).toContain('[+2] + new1');
    expect(out).toContain('[+3] + new2');
    expect(out).toContain('[-2] - old');
    expect(out).toContain('[ 1]   a');
  });

  it('handles an empty diff', () => {
    expect(formatDiffForPrompt({ ref: 'staged', raw: '', files: [] })).toBe('(no changes)');
  });
});

describe('formatPriorContextForPrompt', () => {
  it('says nothing has run yet when the aggregator is empty', () => {
    const ctx = makeCtx(fakeProvider('{}'));
    expect(formatPriorContextForPrompt(ctx)).toMatch(/no prior role findings/);
  });

  it('renders completed roles in order with their findings', () => {
    const ctx = makeCtx(fakeProvider('{}'));
    ctx.aggregator.addRoleOutput({
      role: 'ba',
      verdict: 'flag',
      findings: [{ id: 'ba-1', severity: 'medium', file: 'x.ts', lineStart: 2, lineEnd: 2, description: 'drift' }],
      summary: 'BA summary',
      confidence: 0.8,
    });
    const out = formatPriorContextForPrompt(ctx);
    expect(out).toContain('Business Analyst');
    expect(out).toContain('BA summary');
    expect(out).toContain('[medium] x.ts:2-2');
  });
});

describe('roleContractInstructions', () => {
  it('embeds the role id in the JSON contract example', () => {
    expect(roleContractInstructions('sec')).toContain('"role": "sec"');
  });
});

describe('extractJson', () => {
  it('parses a strict JSON reply', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a markdown fence', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON inside an unlabeled fence', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts the outermost {...} span when there is stray prose', () => {
    expect(extractJson('Sure, here is the result: {"a":1} — hope that helps!')).toEqual({ a: 1 });
  });

  it('throws LlmRoleResponseError when nothing parses', () => {
    expect(() => extractJson('no json here at all')).toThrow(LlmRoleResponseError);
  });
});

describe('runLlmRole', () => {
  it('calls the model and returns a validated RoleOutput', async () => {
    const reply = JSON.stringify({
      role: 'ba',
      verdict: 'pass',
      findings: [],
      summary: 'Looks fine.',
      confidence: 0.9,
    });
    const ctx = makeCtx(fakeProvider(reply));
    const out = await runLlmRole('ba', 'You are BA.', ctx);
    expect(out.role).toBe('ba');
    expect(out.verdict).toBe('pass');
  });

  it('throws RoleContractError when the model returns malformed JSON', async () => {
    const ctx = makeCtx(fakeProvider('not json'));
    await expect(runLlmRole('ba', 'You are BA.', ctx)).rejects.toThrow(RoleContractError);
  });

  it('throws when the model returns output for the wrong role', async () => {
    const reply = JSON.stringify({ role: 'dev', verdict: 'pass', findings: [], summary: 'x', confidence: 0.5 });
    const ctx = makeCtx(fakeProvider(reply));
    await expect(runLlmRole('ba', 'You are BA.', ctx)).rejects.toThrow(/expected role "ba"/);
  });
});

describe('runLlmRole — tool loop (read-only repo access)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-rolerunner-'));
    tmpRoot = await fs.realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function ctxAt(cwd: string, llm: ILLMProvider): RoleRunContext {
    return { ...makeCtx(llm), cwd };
  }

  it('offers only read_file/glob/grep as tools — never shell/edit/write_file', async () => {
    let capturedTools: readonly { name: string }[] | undefined;
    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        capturedTools = req.tools;
        return {
          message: {
            role: 'assistant',
            parts: [{ kind: 'text', text: JSON.stringify({ role: 'ba', verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 }) }],
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };
    await runLlmRole('ba', 'You are BA.', ctxAt(tmpRoot, provider));
    const names = (capturedTools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['glob', 'grep', 'read_file']);
  });

  it('executes a read_file tool call, feeds the result back, and returns the final verdict', async () => {
    await fs.writeFile(path.join(tmpRoot, 'other.ts'), 'export function usedElsewhere() { return 1; }\n', 'utf-8');

    let call = 0;
    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        call++;
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              parts: [{ kind: 'tool_call', id: 'call-1', name: 'read_file', arguments: { file_path: 'other.ts' } }],
            },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: 'completed',
          };
        }
        // Second turn — confirm the tool result actually reached the model.
        const lastMessage = req.messages[req.messages.length - 1];
        const toolResultText = lastMessage.parts
          .filter((p): p is { kind: 'tool_result'; content: { kind: 'text'; text: string }[] } => p.kind === 'tool_result')
          .flatMap((p) => p.content)
          .map((c) => c.text)
          .join('');
        expect(toolResultText).toContain('usedElsewhere');
        return {
          message: {
            role: 'assistant',
            parts: [{ kind: 'text', text: JSON.stringify({ role: 'ba', verdict: 'pass', findings: [], summary: 'checked usage', confidence: 0.9 }) }],
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const out = await runLlmRole('ba', 'You are BA.', ctxAt(tmpRoot, provider));
    expect(out.summary).toBe('checked usage');
    expect(call).toBe(2);
  });

  it('surfaces a failed tool call as an error string, without crashing the loop', async () => {
    let call = 0;
    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        call++;
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              parts: [{ kind: 'tool_call', id: 'call-1', name: 'read_file', arguments: { file_path: 'does-not-exist.ts' } }],
            },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: 'completed',
          };
        }
        const lastMessage = req.messages[req.messages.length - 1];
        const toolResultText = lastMessage.parts
          .filter((p): p is { kind: 'tool_result'; content: { kind: 'text'; text: string }[] } => p.kind === 'tool_result')
          .flatMap((p) => p.content)
          .map((c) => c.text)
          .join('');
        expect(toolResultText).toMatch(/^Error:/);
        return {
          message: {
            role: 'assistant',
            parts: [{ kind: 'text', text: JSON.stringify({ role: 'ba', verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 }) }],
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const out = await runLlmRole('ba', 'You are BA.', ctxAt(tmpRoot, provider));
    expect(out.verdict).toBe('pass');
    expect(call).toBe(2);
  });

  it('stops calling tools after MAX_TOOL_TURNS and forces a final (tool-less) answer', async () => {
    let calls = 0;
    const provider: ILLMProvider = {
      id: 'openai',
      async generate(req: GenerateRequest): Promise<GenerateResponse> {
        calls++;
        if (req.tools && req.tools.length > 0) {
          // Always ask for another tool call — a runaway model.
          return {
            message: {
              role: 'assistant',
              parts: [{ kind: 'tool_call', id: `call-${calls}`, name: 'glob', arguments: { pattern: '**/*.ts' } }],
            },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: 'completed',
          };
        }
        // The forced final call has no `tools` — must answer now.
        return {
          message: {
            role: 'assistant',
            parts: [{ kind: 'text', text: JSON.stringify({ role: 'ba', verdict: 'pass', findings: [], summary: 'forced final', confidence: 0.5 }) }],
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const out = await runLlmRole('ba', 'You are BA.', ctxAt(tmpRoot, provider));
    expect(out.summary).toBe('forced final');
    // MAX_TOOL_TURNS (6) tool-bearing calls + 1 forced tool-less call.
    expect(calls).toBe(7);
  });
});

describe('runLlmRole — corrective retry when the "final" text is not valid JSON', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-rolerunner-corrective-'));
    tmpRoot = await fs.realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function ctxAt(cwd: string, llm: ILLMProvider): RoleRunContext {
    return { ...makeCtx(llm), cwd };
  }

  it(
    'recovers when a local model writes a fake tool call as plain text instead of a real tool_calls response ' +
      '(reproduces the exact reported bug: an Ollama-served Llama-style model)',
    async () => {
      let call = 0;
      const provider: ILLMProvider = {
        id: 'ollama',
        async generate(req: GenerateRequest): Promise<GenerateResponse> {
          call++;
          if (call === 1) {
            // The model "calls" grep, but as plain text content — no real
            // tool_calls in the response, exactly what was observed live.
            return {
              message: {
                role: 'assistant',
                parts: [
                  {
                    kind: 'text',
                    text: '<tool_call>\n<function=grep>\n<parameter=pattern>assert|test</parameter>\n<parameter=path>.</parameter>\n</function>\n</tool_call>',
                  },
                ],
              },
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: 'completed',
            };
          }
          // Corrective retry — no `tools` this time, and it should see our
          // instruction pointing out the previous response didn't parse.
          expect(req.tools).toBeUndefined();
          const lastText = req.messages[req.messages.length - 1].parts
            .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
            .map((p) => p.text)
            .join('');
          expect(lastText).toMatch(/could not be parsed/);
          expect(lastText).toMatch(/do not call any tools/i);
          return {
            message: {
              role: 'assistant',
              parts: [{ kind: 'text', text: JSON.stringify({ role: 'pm', verdict: 'flag', findings: [], summary: 'recovered', confidence: 0.7 }) }],
            },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: 'completed',
          };
        },
        async *stream() {
          yield { kind: 'finish', reason: 'stop' };
        },
      };

      const out = await runLlmRole('pm', 'You are PM.', ctxAt(tmpRoot, provider));
      expect(out.summary).toBe('recovered');
      expect(call).toBe(2); // exactly one corrective retry, not an open-ended loop
    },
  );

  it('still throws RoleContractError if the corrective retry ALSO fails to parse (bounded — no infinite retries)', async () => {
    const provider: ILLMProvider = {
      id: 'ollama',
      async generate(): Promise<GenerateResponse> {
        return {
          message: { role: 'assistant', parts: [{ kind: 'text', text: 'still not json, sorry' }] },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    await expect(runLlmRole('pm', 'You are PM.', ctxAt(tmpRoot, provider))).rejects.toThrow(RoleContractError);
  });

  it('does not trigger the corrective retry when the model answers with valid JSON on the first try', async () => {
    let calls = 0;
    const provider: ILLMProvider = {
      id: 'openai',
      async generate(): Promise<GenerateResponse> {
        calls++;
        return {
          message: {
            role: 'assistant',
            parts: [{ kind: 'text', text: JSON.stringify({ role: 'pm', verdict: 'pass', findings: [], summary: 'fine', confidence: 0.9 }) }],
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    await runLlmRole('pm', 'You are PM.', ctxAt(tmpRoot, provider));
    expect(calls).toBe(1);
  });
});
