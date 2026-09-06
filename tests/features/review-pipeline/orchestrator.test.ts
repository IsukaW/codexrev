import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPipeline } from '../../../src/features/review-pipeline/pipeline/orchestrator.js';
import { InteractionChannel, type StageGateRequest } from '../../../src/core/interaction.js';
import { ROLE_ORDER } from '../../../src/features/review-pipeline/roles/roleContract.js';
import type { ParsedDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';
import type { ILLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';
import type { GenerateRequest, GenerateResponse } from '../../../src/core/types.js';

const EMPTY_DIFF: ParsedDiff = { ref: 'staged', raw: '', files: [] };

/**
 * A real (unmocked) `ILLMProvider` — reads which role is being asked
 * (every role's system prompt embeds `"role": "<id>"` via
 * `roleContractInstructions()`) and replies with a valid pass verdict
 * for that exact role. This lets the orchestrator test exercise the
 * real `ba.ts`/`dev.ts`/`sec.ts`/`qa.ts`/`pm.ts` role files end to end,
 * matching this repo's existing "no module mocking" test convention.
 */
function echoRoleProvider(): ILLMProvider {
  return {
    id: 'openai',
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const match = (req.systemInstruction ?? '').match(/"role":\s*"(\w+)"/);
      const role = match ? match[1] : 'ba';
      return {
        message: {
          role: 'assistant',
          parts: [
            {
              kind: 'text',
              text: JSON.stringify({ role, verdict: 'pass', findings: [], summary: `${role} ok`, confidence: 0.9 }),
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

let tmpRoot: string; // no build markers here — Build role passes trivially, no subprocess spawned

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-orchestrator-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('runPipeline — non-interactive', () => {
  it('runs all six roles in ROLE_ORDER end to end and completes', async () => {
    const completed: string[] = [];
    const result = await runPipeline({
      diff: EMPTY_DIFF,
      llm: echoRoleProvider(),
      model: 'test-model',
      cwd: tmpRoot,
      onRoleComplete: (output) => completed.push(output.role),
    });

    expect(result.outcome).toBe('completed');
    expect(result.ranRoles).toEqual(ROLE_ORDER);
    expect(result.skippedRoles).toEqual([]);
    expect(completed).toEqual(ROLE_ORDER);
    expect(result.aggregator.completedRoles).toEqual(ROLE_ORDER);
    for (const role of ROLE_ORDER) {
      expect(result.aggregator.getRoleOutput(role)?.role).toBe(role);
    }
  });

  it('calls onRoleStart for each role, before that role\'s onRoleComplete (drives the "running…" spinner)', async () => {
    const events: string[] = [];
    await runPipeline({
      diff: EMPTY_DIFF,
      llm: echoRoleProvider(),
      model: 'test-model',
      cwd: tmpRoot,
      onRoleStart: (role) => events.push(`start:${role}`),
      onRoleComplete: (output) => events.push(`complete:${output.role}`),
    });

    expect(events).toEqual(ROLE_ORDER.flatMap((role) => [`start:${role}`, `complete:${role}`]));
  });
});

describe('runPipeline — a role throwing', () => {
  it('does not propagate — returns outcome "errored" with the error attached (Phase 6: audit trail must still be writable)', async () => {
    const failingLlm: ILLMProvider = {
      id: 'openai',
      generate: async () => {
        throw new Error('simulated provider failure');
      },
      stream: () => {
        throw new Error('simulated provider failure');
      },
    };

    const result = await runPipeline({
      diff: EMPTY_DIFF,
      llm: failingLlm,
      model: 'test-model',
      cwd: tmpRoot,
    });

    expect(result.outcome).toBe('errored');
    expect(result.ranRoles).toEqual([]);
    expect(result.skippedRoles).toEqual(ROLE_ORDER);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('simulated provider failure');
  });

  it('keeps roles that completed before the failure', async () => {
    // Build never calls the LLM (it's deterministic), so with an empty
    // diff / no build markers the call order is: ba (1st LLM call), dev
    // (2nd), build (no LLM call), sec (3rd LLM call) — throwing on the
    // 3rd call fails Sec, leaving ba/dev/build as already completed.
    let calls = 0;
    const flakyLlm: ILLMProvider = {
      id: 'openai',
      generate: async (req: GenerateRequest) => {
        calls++;
        if (calls > 2) throw new Error('boom on the third LLM call (Sec)');
        const match = (req.systemInstruction ?? '').match(/"role":\s*"(\w+)"/);
        const role = match ? match[1] : 'ba';
        return {
          message: {
            role: 'assistant',
            parts: [{ kind: 'text', text: JSON.stringify({ role, verdict: 'pass', findings: [], summary: 'ok', confidence: 0.9 }) }],
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'completed',
        };
      },
      async *stream() {
        yield { kind: 'finish', reason: 'stop' };
      },
    };

    const result = await runPipeline({ diff: EMPTY_DIFF, llm: flakyLlm, model: 'test-model', cwd: tmpRoot });

    expect(result.outcome).toBe('errored');
    expect(result.ranRoles).toEqual(['ba', 'dev', 'build']);
    expect(result.skippedRoles).toEqual(['sec', 'qa', 'pm']);
    expect(result.aggregator.completedRoles).toEqual(['ba', 'dev', 'build']);
  });
});

describe('runPipeline — interactive gates', () => {
  it('advances through every role when the gate always answers continue', async () => {
    const channel = new InteractionChannel();
    const seenStages: string[] = [];
    channel.onInteraction((event) => {
      if (event.type !== 'stage_gate_request') return;
      seenStages.push(event.request.stage);
      channel.respondStageGate(event.request.id, 'continue');
    });

    const result = await runPipeline({
      diff: EMPTY_DIFF,
      llm: echoRoleProvider(),
      model: 'test-model',
      cwd: tmpRoot,
      interaction: channel,
    });

    expect(result.outcome).toBe('completed');
    expect(seenStages).toEqual(ROLE_ORDER);
  });

  it('stops after "skip" and reports the remaining roles as skipped', async () => {
    const channel = new InteractionChannel();
    channel.onInteraction((event) => {
      if (event.type !== 'stage_gate_request') return;
      const decision = event.request.stage === 'dev' ? 'skip' : 'continue';
      channel.respondStageGate(event.request.id, decision);
    });

    const result = await runPipeline({
      diff: EMPTY_DIFF,
      llm: echoRoleProvider(),
      model: 'test-model',
      cwd: tmpRoot,
      interaction: channel,
    });

    expect(result.outcome).toBe('skipped');
    expect(result.ranRoles).toEqual(['ba', 'dev']);
    expect(result.skippedRoles).toEqual(['build', 'sec', 'qa', 'pm']);
  });

  it('stops immediately after "abort"', async () => {
    const channel = new InteractionChannel();
    channel.onInteraction((event) => {
      if (event.type !== 'stage_gate_request') return;
      channel.respondStageGate(event.request.id, 'abort');
    });

    const result = await runPipeline({
      diff: EMPTY_DIFF,
      llm: echoRoleProvider(),
      model: 'test-model',
      cwd: tmpRoot,
      interaction: channel,
    });

    expect(result.outcome).toBe('aborted');
    expect(result.ranRoles).toEqual(['ba']);
    expect(result.skippedRoles).toEqual(['dev', 'build', 'sec', 'qa', 'pm']);
  });

  it('"details" re-prompts the same gate instead of advancing', async () => {
    const channel = new InteractionChannel();
    const requestsForBa: StageGateRequest[] = [];
    let baGateCount = 0;
    channel.onInteraction((event) => {
      if (event.type !== 'stage_gate_request') return;
      if (event.request.stage === 'ba') {
        requestsForBa.push(event.request);
        baGateCount++;
        // First time: ask for details (should re-prompt). Second time: continue.
        channel.respondStageGate(event.request.id, baGateCount === 1 ? 'details' : 'continue');
        return;
      }
      channel.respondStageGate(event.request.id, 'continue');
    });

    const result = await runPipeline({
      diff: EMPTY_DIFF,
      llm: echoRoleProvider(),
      model: 'test-model',
      cwd: tmpRoot,
      interaction: channel,
    });

    expect(baGateCount).toBe(2);
    expect(requestsForBa[0].id).not.toBe(requestsForBa[1].id);
    expect(result.outcome).toBe('completed');
    expect(result.ranRoles).toEqual(ROLE_ORDER);
  });
});
