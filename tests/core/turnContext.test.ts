import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/core/turn.js';
import type { ContentGenerator, Message, StreamEvent } from '../../src/core/types.js';
import type { McpRegistry } from '../../src/mcp/registry.js';
import { DEFAULT_SETTINGS } from '../../src/config/schema.js';

function fakeProvider(capture: (messages: Message[]) => void): ContentGenerator {
  return {
    provider: 'openai',
    async *stream(req): AsyncIterable<StreamEvent> {
      capture(req.messages.map((m) => ({ ...m })));
      yield { kind: 'text_delta', text: 'ok' };
      yield { kind: 'finish', reason: 'stop' };
    },
  } as unknown as ContentGenerator;
}

const noMcp = {
  listToolDeclarations: async () => [],
  callTool: async () => ({ output: '' }),
  close: async () => {},
} as unknown as McpRegistry;

describe('runAgent — session memory', () => {
  it('prepends contextMessages before the current prompt', async () => {
    let seen: Message[] = [];
    const provider = fakeProvider((m) => { seen = m; });

    const contextMessages: Message[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'what is the day?' }] },
      { role: 'assistant', parts: [{ kind: 'text', text: 'Today is Sunday.' }] },
    ];

    const result = await runAgent({
      prompt: 'day is wrong',
      provider,
      tools: new Map(),
      mcp: noMcp,
      settings: DEFAULT_SETTINGS,
      stream: false,
      contextMessages,
    });

    expect(seen.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((seen[2].parts[0] as { text: string }).text).toBe('day is wrong');
    // Non-streaming API now returns the full transcript, not an empty array.
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
  });
});
