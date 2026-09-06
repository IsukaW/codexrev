import { describe, expect, it } from 'vitest';
import { runBaRole } from '../../../../src/features/review-pipeline/roles/ba.js';
import { runDevRole } from '../../../../src/features/review-pipeline/roles/dev.js';
import { runSecRole } from '../../../../src/features/review-pipeline/roles/sec.js';
import { runQaRole } from '../../../../src/features/review-pipeline/roles/qa.js';
import { runPmRole } from '../../../../src/features/review-pipeline/roles/pm.js';
import { ContextAggregator } from '../../../../src/features/review-pipeline/pipeline/contextAggregator.js';
import type { RoleRunContext } from '../../../../src/features/review-pipeline/pipeline/roleRunContext.js';
import type { ILLMProvider } from '../../../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { GenerateRequest, GenerateResponse } from '../../../../src/core/types.js';
import type { ParsedDiff } from '../../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { RoleId } from '../../../../src/features/review-pipeline/roles/roleContract.js';

const EMPTY_DIFF: ParsedDiff = { ref: 'staged', raw: '', files: [] };

/** Captures the request sent to the model and replies with a role-matching pass verdict. */
function capturingProvider(role: RoleId, captured: { req?: GenerateRequest }): ILLMProvider {
  return {
    id: 'openai',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      captured.req = req;
      return {
        message: {
          role: 'assistant',
          parts: [
            {
              kind: 'text',
              text: JSON.stringify({ role, verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 }),
            },
          ],
        },
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
    diff: EMPTY_DIFF,
    urs: undefined,
    aggregator: new ContextAggregator(EMPTY_DIFF),
    cwd: '/tmp/does-not-matter',
  };
}

describe('role lenses stay distinct and each role tags its own JSON contract', () => {
  it('ba: behavioral drift / spec-gap lens', async () => {
    const captured: { req?: GenerateRequest } = {};
    const out = await runBaRole(makeCtx(capturingProvider('ba', captured)));
    expect(out.role).toBe('ba');
    expect(captured.req?.systemInstruction).toMatch(/Business Analyst/);
    expect(captured.req?.systemInstruction).toMatch(/behavioral drift/i);
    expect(captured.req?.systemInstruction).toContain('"role": "ba"');
  });

  it('dev: correctness / SOLID / maintainability lens', async () => {
    const captured: { req?: GenerateRequest } = {};
    const out = await runDevRole(makeCtx(capturingProvider('dev', captured)));
    expect(out.role).toBe('dev');
    expect(captured.req?.systemInstruction).toMatch(/SOLID/);
    expect(captured.req?.systemInstruction).toMatch(/correctness/i);
  });

  it('sec: OWASP/CWE lens', async () => {
    const captured: { req?: GenerateRequest } = {};
    const out = await runSecRole(makeCtx(capturingProvider('sec', captured)));
    expect(out.role).toBe('sec');
    expect(captured.req?.systemInstruction).toMatch(/OWASP/);
    expect(captured.req?.systemInstruction).toMatch(/CWE/);
  });

  it('qa: adversarial / mutation-testing lens', async () => {
    const captured: { req?: GenerateRequest } = {};
    const out = await runQaRole(makeCtx(capturingProvider('qa', captured)));
    expect(out.role).toBe('qa');
    expect(captured.req?.systemInstruction).toMatch(/[Mm]utation-testing/);
    expect(captured.req?.systemInstruction).toMatch(/regression/i);
  });

  it('pm: synthesis lens, and does not compute the final Resolver decision', async () => {
    const captured: { req?: GenerateRequest } = {};
    const out = await runPmRole(makeCtx(capturingProvider('pm', captured)));
    expect(out.role).toBe('pm');
    expect(captured.req?.systemInstruction).toMatch(/synthes/i);
    expect(captured.req?.systemInstruction).toMatch(/not.*compute.*final decision/i);
  });
});
