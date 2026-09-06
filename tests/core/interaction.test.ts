import { describe, expect, it } from 'vitest';
import { InteractionChannel, type InteractionEvent } from '../../src/core/interaction.js';

describe('InteractionChannel — requestStageGate (Feature 2, Phase 5)', () => {
  it('resolves with the decision sent back via respondStageGate', async () => {
    const channel = new InteractionChannel();
    const events: InteractionEvent[] = [];
    channel.onInteraction((e) => events.push(e));

    const pending = channel.requestStageGate('ba', 'Business Analyst', 'pass', 'All good.');

    expect(events).toHaveLength(1);
    const event = events[0];
    if (event.type !== 'stage_gate_request') throw new Error('expected stage_gate_request');
    expect(event.request.stage).toBe('ba');
    expect(event.request.stageLabel).toBe('Business Analyst');
    expect(event.request.status).toBe('pass');
    expect(event.request.summary).toBe('All good.');

    channel.respondStageGate(event.request.id, 'continue');
    await expect(pending).resolves.toBe('continue');
  });

  it('rejects a NEW request made after abort() — matching requestClarification/requestFixConfirmation', async () => {
    // abort() does not cancel an already-pending promise (same as the
    // existing requestClarification/requestFixConfirmation) — it only
    // makes subsequent request*() calls reject immediately.
    const channel = new InteractionChannel();
    channel.abort();
    await expect(channel.requestStageGate('sec', 'Security Auditor', 'block', 'Found a problem.')).rejects.toThrow(
      'interaction aborted',
    );
  });

  it('a new request after abort() works again once reset()', async () => {
    const channel = new InteractionChannel();
    channel.abort();
    await expect(channel.requestStageGate('qa', 'QA Engineer', 'flag', 's')).rejects.toThrow();

    channel.reset();
    channel.onInteraction((e) => {
      if (e.type === 'stage_gate_request') channel.respondStageGate(e.request.id, 'skip');
    });
    await expect(channel.requestStageGate('qa', 'QA Engineer', 'flag', 's')).resolves.toBe('skip');
  });
});
