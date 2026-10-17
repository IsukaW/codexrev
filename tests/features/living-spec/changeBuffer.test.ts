import { describe, expect, it } from 'vitest';
import {
  ChangeBuffer,
  computeChangeId,
  hashContent,
  type ChangeBatch,
  type Clock,
  type TimerHandle,
  type TimerPort,
} from '../../../src/features/living-spec/pipeline/changeBuffer.js';

/** Deterministic fake scheduler: tests advance time explicitly. */
class FakeTimers implements TimerPort {
  nowMs = 0;
  private seq = 0;
  private tasks: Array<{ id: number; at: number; fn: () => void }> = [];

  schedule(fn: () => void, ms: number): TimerHandle {
    const task = { id: ++this.seq, at: this.nowMs + ms, fn };
    this.tasks.push(task);
    return task.id;
  }

  cancel(handle: TimerHandle): void {
    this.tasks = this.tasks.filter((t) => t.id !== handle);
  }

  get pendingCount(): number {
    return this.tasks.length;
  }

  /** Runs every task due within `ms`, in (time, scheduling) order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.tasks
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((t) => t.id !== due.id);
      this.nowMs = due.at;
      due.fn();
    }
    this.nowMs = target;
  }
}

function setup(debounceMs = 800): {
  fake: FakeTimers;
  clock: Clock;
  batches: ChangeBatch[];
  buffer: ChangeBuffer;
} {
  const fake = new FakeTimers();
  const clock: Clock = { now: () => fake.nowMs };
  const batches: ChangeBatch[] = [];
  const buffer = new ChangeBuffer({
    debounceMs,
    clock,
    timers: fake,
    onBatch: (b) => batches.push(b),
  });
  return { fake, clock, batches, buffer };
}

describe('ChangeBuffer — debounce coalescing', () => {
  it('coalesces rapid saves of one path into a single change with the latest hash', () => {
    const { fake, batches, buffer } = setup(800);
    for (let i = 1; i <= 5; i++) {
      buffer.push({ path: 'src/a.ts', hash: hashContent(`v${i}`) });
      fake.advance(100); // saves land faster than the quiet period
    }
    expect(batches).toHaveLength(0); // still debouncing

    fake.advance(800);
    expect(batches).toHaveLength(1);
    expect(batches[0].paths).toEqual(['src/a.ts']);
    expect(batches[0].hashes['src/a.ts']).toBe(hashContent('v5'));
  });

  it('groups paths that settle in the same tick into one multi-file batch', () => {
    const { fake, batches, buffer } = setup(800);
    buffer.push({ path: 'old.ts', hash: hashContent('gone') });
    buffer.push({ path: 'new.ts', hash: hashContent('here') });

    fake.advance(800); // both debounce timers + the grouped emit
    expect(batches).toHaveLength(1);
    expect(batches[0].paths).toEqual(['new.ts', 'old.ts']);
  });

  it('emits separate batches when paths settle far apart', () => {
    const { fake, batches, buffer } = setup(800);
    buffer.push({ path: 'a.ts', hash: hashContent('a1') });
    fake.advance(810);
    buffer.push({ path: 'b.ts', hash: hashContent('b1') });
    fake.advance(810);
    expect(batches).toHaveLength(2);
    expect(batches[0].paths).toEqual(['a.ts']);
    expect(batches[1].paths).toEqual(['b.ts']);
  });

  it('flush() settles everything immediately and a second flush is empty', () => {
    const { fake, batches, buffer } = setup(800);
    buffer.push({ path: 'a.ts', hash: hashContent('a1') });
    expect(fake.pendingCount).toBeGreaterThan(0);

    const batch = buffer.flush();
    expect(batch).not.toBeNull();
    expect(batch?.paths).toEqual(['a.ts']);
    expect(batches).toHaveLength(1);
    expect(buffer.flush()).toBeNull();
  });
});

describe('ChangeBuffer — hash dedupe (NFR3)', () => {
  it('never emits the same effective change twice', () => {
    const { fake, batches, buffer } = setup(800);
    buffer.push({ path: 'src/a.ts', hash: hashContent('same') });
    fake.advance(810);
    expect(batches).toHaveLength(1);

    // save spam of identical content — must not be analysed again
    for (let i = 0; i < 10; i++) {
      buffer.push({ path: 'src/a.ts', hash: hashContent('same') });
      fake.advance(810);
    }
    expect(batches).toHaveLength(1);
  });

  it('drops a revert back to an already-analysed state', () => {
    const { fake, batches, buffer } = setup(800);
    buffer.push({ path: 'src/a.ts', hash: hashContent('v1') });
    fake.advance(810);
    expect(batches).toHaveLength(1);

    // edit then undo within the same quiet period — net change is zero
    buffer.push({ path: 'src/a.ts', hash: hashContent('v2') });
    buffer.push({ path: 'src/a.ts', hash: hashContent('v1') });
    expect(buffer.flush()).toBeNull();
    expect(batches).toHaveLength(1);
  });

  it('NFR3: >=95% of controlled save events are processed exactly once', () => {
    const { fake, batches, buffer } = setup(800);
    const uniqueChanges: string[] = [];

    // 30 controlled saves: 10 unique effective changes, each saved 3 times
    for (let change = 1; change <= 10; change++) {
      const hash = hashContent(`effective-change-${change}`);
      uniqueChanges.push(hash);
      for (let save = 0; save < 3; save++) {
        buffer.push({ path: `src/f${change % 3}.ts`, hash });
        fake.advance(50); // save noise inside the quiet period
      }
      fake.advance(900); // then the window closes
    }

    const analysisCountByHash = new Map<string, number>();
    for (const batch of batches) {
      for (const [p, hash] of Object.entries(batch.hashes)) {
        const key = `${p}:${hash}`;
        analysisCountByHash.set(key, (analysisCountByHash.get(key) ?? 0) + 1);
      }
    }

    const analysedExactlyOnce = uniqueChanges.filter((hash, i) => {
      const key = `src/f${(i + 1) % 3}.ts:${hash}`;
      return analysisCountByHash.get(key) === 1;
    }).length;
    const onceOnlyRate = analysedExactlyOnce / uniqueChanges.length;

    expect(onceOnlyRate).toBeGreaterThanOrEqual(0.95);
    expect(analysedExactlyOnce).toBe(uniqueChanges.length);
    expect(batches.length).toBe(uniqueChanges.length);
  });
});

describe('computeChangeId', () => {
  const base = { ref: 'staged', files: ['src/a.ts', 'src/b.ts'], diffContent: 'diff --git ...\n' };

  it('is stable across calls', () => {
    expect(computeChangeId(base)).toBe(computeChangeId(base));
    expect(computeChangeId(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on file-list order', () => {
    expect(computeChangeId({ ...base, files: ['src/b.ts', 'src/a.ts'] })).toBe(
      computeChangeId(base),
    );
  });

  it('changes when the ref, file list or diff content changes', () => {
    const id = computeChangeId(base);
    expect(computeChangeId({ ...base, ref: 'HEAD' })).not.toBe(id);
    expect(computeChangeId({ ...base, files: ['src/a.ts'] })).not.toBe(id);
    expect(computeChangeId({ ...base, diffContent: 'other' })).not.toBe(id);
  });

  it('produces the same id for the same change regardless of run', () => {
    // re-running the whole computation from scratch must be deterministic
    const first = computeChangeId(base);
    const second = computeChangeId({ ref: 'staged', files: [...base.files], diffContent: base.diffContent });
    expect(first).toBe(second);
  });
});

describe('ChangeBuffer — observability', () => {
  it('reports dropped duplicates in the next emitted batch', () => {
    const { fake, batches, buffer } = setup(800);
    buffer.push({ path: 'a.ts', hash: hashContent('a1') });
    fake.advance(810);

    buffer.push({ path: 'a.ts', hash: hashContent('a1') }); // duplicate — dropped
    buffer.push({ path: 'b.ts', hash: hashContent('b1') });
    fake.advance(810);

    expect(batches).toHaveLength(2);
    expect(batches[1].paths).toEqual(['b.ts']);
    expect(batches[1].droppedDuplicates).toEqual(['a.ts']);
    expect(buffer.pendingPaths()).toEqual([]);
  });
});
