import { describe, expect, it } from 'vitest';
import { ReviewSessionEventBus } from '../../../src/features/review-pipeline/cli/reviewSessionEvents.js';
import type { ReviewSessionEvent } from '../../../src/features/review-pipeline/cli/reviewSessionEvents.js';

describe('ReviewSessionEventBus', () => {
  it('delivers emitted events to subscribers', () => {
    const bus = new ReviewSessionEventBus();
    const received: ReviewSessionEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emit({ type: 'role_start', role: 'ba' });
    bus.emit({
      type: 'role_complete',
      output: { role: 'ba', verdict: 'pass', findings: [], summary: 'ok', confidence: 1 },
    });

    expect(received).toEqual([
      { type: 'role_start', role: 'ba' },
      { type: 'role_complete', output: { role: 'ba', verdict: 'pass', findings: [], summary: 'ok', confidence: 1 } },
    ]);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = new ReviewSessionEventBus();
    const received: ReviewSessionEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));
    unsubscribe();
    bus.emit({ type: 'role_start', role: 'dev' });
    expect(received).toEqual([]);
  });

  it('supports multiple independent subscribers', () => {
    const bus = new ReviewSessionEventBus();
    const a: ReviewSessionEvent[] = [];
    const b: ReviewSessionEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.emit({ type: 'role_start', role: 'qa' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
