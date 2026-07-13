/**
 * Codexrev — main TUI component (React + Ink).
 *
 * Top-level layout: header, scrollable conversation area, prompt
 * input, and status bar. Slash commands are handled here.
 */

import React, { useState, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { AgentEvent } from '../core/turn.js';
import type { Settings } from '../config/schema.js';
import type { ExtensionRegistry } from '../extensions/types.js';

interface AppProps {
  settings: Settings;
  runAgent: (prompt: string) => AsyncIterable<AgentEvent>;
  extensions?: ExtensionRegistry;
}

interface Message {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolName?: string;
}

let nextId = 1;

export const App: React.FC<AppProps> = ({ settings, runAgent }) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([
    { id: nextId++, role: 'system', text: `Codexrev ready — ${settings.provider} / ${settings.model}` },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function handleSubmit(value: string) {
    const prompt = value.trim();
    if (!prompt || busy) return;

    if (prompt.startsWith('/')) {
      handleSlash(prompt);
      setInput('');
      return;
    }

    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { id: nextId++, role: 'user', text: prompt }]);

    const ac = new AbortController();
    abortRef.current = ac;

    let assistantText = '';
    try {
      for await (const ev of runAgent(prompt)) {
        if (ac.signal.aborted) break;
        if (ev.kind === 'text_delta') {
          assistantText += ev.text;
          setMessages((m) => upsertAssistant(m, assistantText));
        } else if (ev.kind === 'tool_call') {
          setMessages((m) => [
            ...m,
            { id: nextId++, role: 'tool', text: ev.toolCall.name, toolName: ev.toolCall.name },
          ]);
        } else if (ev.kind === 'turn_complete') {
          // nothing to do
        } else if (ev.kind === 'error') {
          setMessages((m) => [
            ...m,
            { id: nextId++, role: 'system', text: `error: ${ev.error.message}` },
          ]);
        }
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        { id: nextId++, role: 'system', text: `error: ${(err as Error).message}` },
      ]);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function handleSlash(cmd: string) {
    const [name, ...rest] = cmd.slice(1).split(/\s+/);
    switch (name) {
      case 'help':
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'system', text: HELP_TEXT },
        ]);
        break;
      case 'clear':
        setMessages([{ id: nextId++, role: 'system', text: 'session cleared' }]);
        break;
      case 'tools':
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'system', text: 'tools: shell, read_file, write_file, edit, glob, grep, web_fetch, web_search' },
        ]);
        break;
      case 'quit':
      case 'exit':
        exit();
        break;
      case 'theme':
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'system', text: `theme: "${rest[0] ?? settings.theme}" (change requires restart)` },
        ]);
        break;
      default:
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'system', text: `unknown command: /${name} (try /help)` },
        ]);
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (busy && abortRef.current) abortRef.current.abort();
      else exit();
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          Codexrev
        </Text>
        <Text dimColor>
          {settings.provider} · {settings.model} · sandbox: {settings.sandbox}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} marginY={1}>
        {messages.map((m) => (
          <MessageLine key={m.id} msg={m} />
        ))}
        {busy && (
          <Box>
            <Spinner type="dots" />
            <Text> thinking…</Text>
          </Box>
        )}
      </Box>

      <Box borderStyle="single" paddingX={1}>
        <Text color="green">{'> '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={busy ? '(busy — Ctrl-C to abort)' : 'Send a message. /help for commands.'}
        />
      </Box>
    </Box>
  );
};

const MessageLine: React.FC<{ msg: Message }> = ({ msg }) => {
  switch (msg.role) {
    case 'user':
      return (
        <Box>
          <Text color="green">› </Text>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column" marginY={1}>
          <Text color="cyan">assistant:</Text>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'tool':
      return (
        <Box>
          <Text color="yellow">[tool:{msg.toolName}]</Text>
        </Box>
      );
    case 'system':
      return (
        <Box>
          <Text dimColor>{msg.text}</Text>
        </Box>
      );
  }
};

function upsertAssistant(messages: Message[], text: string): Message[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    const copy = messages.slice();
    copy[copy.length - 1] = { ...last, text };
    return copy;
  }
  return [...messages, { id: nextId++, role: 'assistant', text }];
}

const HELP_TEXT = `Commands:
  /help               show this help
  /clear              clear the conversation
  /tools              list built-in tools
  /theme <name>       switch theme (restart required)
  /quit               exit Codexrev
  /exit               alias for /quit`;
