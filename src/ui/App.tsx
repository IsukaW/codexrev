/**
 * Codexrev — main TUI component (React + Ink).
 *
 * Top-level layout: header, scrollable conversation area, prompt
 * input, and status bar. Slash commands are handled here.
 *
 * Supports three interaction modes (Ask / Plan / Agent) with live
 * Tab cycling, a multi-agent pipeline in Agent mode, and a
 * clarification Q&A sub-flow via the InteractionChannel.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { AgentEvent } from '../core/turn.js';
import type { ContentGenerator } from '../core/types.js';
import type { Settings } from '../config/schema.js';
import type { ExtensionRegistry } from '../extensions/types.js';
import type { Tool } from '../tools/registry.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { InteractionMode } from '../core/modes.js';
import { MODE_CONFIG, MODE_ORDER, filterReadOnlyTools } from '../core/modes.js';
import { InteractionChannel, type InteractionEvent } from '../core/interaction.js';
import { runFixLoop } from '../core/fixLoop.js';
import { ModeBadge, ModeBadgeInline } from './ModeBadge.js';
import { ClarificationPrompt, FixConfirmPrompt } from './ClarificationPrompt.js';

interface AppProps {
  settings: Settings;
  runAgent: (prompt: string, systemPromptSuffix?: string, overrideTools?: Map<string, Tool>) => AsyncIterable<AgentEvent>;
  extensions?: ExtensionRegistry;
  interactionChannel: InteractionChannel;
  provider: ContentGenerator;
  tools: Map<string, Tool>;
  mcp: McpRegistry;
}

interface Message {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'pipeline';
  text: string;
  toolName?: string;
  phaseName?: string;
}

let nextId = 1;

export const App: React.FC<AppProps> = ({
  settings,
  runAgent,
  interactionChannel,
  provider,
  tools,
  mcp,
}) => {
  const { exit } = useApp();

  // ── State ────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([
    { id: nextId++, role: 'system', text: `Codexrev ready — ${settings.provider} / ${settings.model}` },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<InteractionMode>(settings.defaultMode ?? 'ask');
  const [modeFlash, setModeFlash] = useState<string | null>(null);
  const modeFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Clarification / fix-confirm state ────────────────────────
  const [clarificationRequest, setClarificationRequest] = useState<
    import('../core/interaction.js').ClarificationRequest | null
  >(null);
  const [fixConfirmRequest, setFixConfirmRequest] = useState<
    import('../core/interaction.js').FixConfirmRequest | null
  >(null);

  // Subscribe to InteractionChannel events
  useEffect(() => {
    const unsub = interactionChannel.onInteraction((event: InteractionEvent) => {
      if (event.type === 'clarification_request') {
        setClarificationRequest(event.request);
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'system', text: '⏸ Pipeline paused — clarification needed' },
        ]);
      } else if (event.type === 'fix_confirm_request') {
        setFixConfirmRequest(event.request);
      } else if (event.type === 'abort') {
        setClarificationRequest(null);
        setFixConfirmRequest(null);
      }
    });
    return () => {
      unsub();
      if (modeFlashTimer.current) clearTimeout(modeFlashTimer.current);
    };
  }, [interactionChannel]);

  // ── Build context from conversation history ──────────────────
  // When switching modes (e.g. Plan → Agent), the agent needs to
  // see what was discussed in the previous mode so it can act on it.

  const buildContextMessages = useCallback(
    (currentMessages: Message[]): import('../core/types.js').Message[] => {
      const context: import('../core/types.js').Message[] = [];

      for (const m of currentMessages) {
        if (m.role === 'user' && m.text) {
          context.push({ role: 'user', parts: [{ kind: 'text', text: m.text }] });
        } else if (m.role === 'assistant' && m.text) {
          context.push({ role: 'assistant', parts: [{ kind: 'text', text: m.text }] });
        }
        // Skip system, tool, pipeline messages — they're noise for context
      }

      return context;
    },
    [],
  );

  // ── Mode-aware agent execution ───────────────────────────────

  const runAgentForMode = useCallback(
    async (prompt: string, currentMode: InteractionMode) => {
      const modeConfig = MODE_CONFIG[currentMode];

      if (currentMode === 'agent') {
        // Agent mode: full pipeline with fix loop
        // Pass conversation history as context so the agent can see plans from Plan mode
        const contextMessages = buildContextMessages(messages);
        for await (const ev of runFixLoop({
          prompt,
          provider,
          tools,
          mcp,
          settings,
          interactionChannel,
          maxFixAttempts: settings.maxFixAttempts,
          verificationMode: settings.verificationMode,
          signal: abortRef.current?.signal,
          contextMessages,
        })) {
          yieldEvent(ev);
        }
      } else {
        // Ask / Plan mode: single runAgent call with mode-specific system prompt
        // Filter tools to read-only if the mode requires it
        const modeTools = modeConfig.readOnly ? filterReadOnlyTools(tools) : undefined;
        for await (const ev of runAgent(prompt, modeConfig.systemPromptSuffix, modeTools)) {
          yieldEvent(ev);
        }
      }
    },
    [provider, tools, mcp, settings, interactionChannel, runAgent, messages, buildContextMessages],
  );

  // Track the current assistant text for message accumulation
  const assistantTextRef = useRef('');

  function yieldEvent(ev: AgentEvent) {
    if (abortRef.current?.signal.aborted) return;

    if (ev.kind === 'text_delta') {
      assistantTextRef.current += ev.text;
      setMessages((m) => upsertAssistant(m, assistantTextRef.current));
    } else if (ev.kind === 'tool_call') {
      setMessages((m) => [
        ...m,
        { id: nextId++, role: 'tool', text: ev.toolCall.name, toolName: ev.toolCall.name },
      ]);
    } else if (ev.kind === 'pipeline_phase') {
      setMessages((m) => [
        ...m,
        { id: nextId++, role: 'pipeline', text: ev.description, phaseName: ev.phase },
      ]);
    } else if (ev.kind === 'fix_iteration') {
      const icon = ev.status === 'green' ? '✅' : ev.status === 'red' ? '❌' : '🔄';
      setMessages((m) => [
        ...m,
        {
          id: nextId++,
          role: 'system',
          text: `${icon} Fix attempt ${ev.attempt}/${ev.maxAttempts}: ${ev.summary}`,
        },
      ]);
    } else if (ev.kind === 'clarification_response') {
      setMessages((m) => [
        ...m,
        { id: nextId++, role: 'system', text: `Clarification answered: ${ev.answer}` },
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

  // ── Submit handler ───────────────────────────────────────────

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
    assistantTextRef.current = '';
    interactionChannel.reset();
    setMessages((m) => [...m, { id: nextId++, role: 'user', text: prompt }]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await runAgentForMode(prompt, mode);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { id: nextId++, role: 'system', text: `error: ${(err as Error).message}` },
      ]);
    } finally {
      setBusy(false);
      abortRef.current = null;
      setClarificationRequest(null);
      setFixConfirmRequest(null);
    }
  }

  // ── Clarification answer handler ─────────────────────────────

  const handleClarificationAnswer = useCallback(
    (answer: string) => {
      if (clarificationRequest) {
        interactionChannel.respondClarification(clarificationRequest.id, answer);
        setClarificationRequest(null);
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'user', text: `↳ Clarification: ${answer}` },
        ]);
      }
    },
    [clarificationRequest, interactionChannel],
  );

  const handleFixConfirmDecision = useCallback(
    (decision: 'continue' | 'stop') => {
      if (fixConfirmRequest) {
        interactionChannel.respondFixConfirmation(fixConfirmRequest.id, decision);
        setFixConfirmRequest(null);
        setMessages((m) => [
          ...m,
          {
            id: nextId++,
            role: 'system',
            text: decision === 'continue' ? '🔄 Continuing fix loop…' : '🛑 Stopping fix loop.',
          },
        ]);
      }
    },
    [fixConfirmRequest, interactionChannel],
  );

  // ── Slash commands ───────────────────────────────────────────

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
      case 'tools': {
        const toolNames = Array.from(tools.keys()).join(', ');
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'system', text: `tools: ${toolNames}` },
        ]);
        break;
      }
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
      case 'mode':
        if (rest[0] && MODE_ORDER.includes(rest[0] as InteractionMode)) {
          const newMode = rest[0] as InteractionMode;
          setMode(newMode);
          const cfg = MODE_CONFIG[newMode];
          setModeFlash(`⊞ Switched to ${cfg.label} mode`);
          if (modeFlashTimer.current) clearTimeout(modeFlashTimer.current);
          modeFlashTimer.current = setTimeout(() => setModeFlash(null), 2000);
          setMessages((m) => [
            ...m,
            { id: nextId++, role: 'system', text: `mode: ${cfg.label}` },
          ]);
        } else {
          setMessages((m) => [
            ...m,
            { id: nextId++, role: 'system', text: `mode: ${MODE_CONFIG[mode].label} (use /mode <ask|plan|agent> or Tab to switch)` },
          ]);
        }
        break;
      default:
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'system', text: `unknown command: /${name} (try /help)` },
        ]);
    }
  }

  // ── Key bindings ─────────────────────────────────────────────

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (busy && abortRef.current) {
        abortRef.current.abort();
        interactionChannel.abort();
      } else {
        exit();
      }
    }
    // Tab cycles mode — only when not busy and no clarification/fix-confirm pending
    if (key.tab && !busy && !clarificationRequest && !fixConfirmRequest) {
      setMode((prev) => {
        const idx = MODE_ORDER.indexOf(prev);
        const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
        // Show flash notification near input
        const cfg = MODE_CONFIG[next];
        setModeFlash(`⊞ Switched to ${cfg.label} mode`);
        if (modeFlashTimer.current) clearTimeout(modeFlashTimer.current);
        modeFlashTimer.current = setTimeout(() => setModeFlash(null), 2000);
        return next;
      });
    }
  });

  // ── Render ───────────────────────────────────────────────────

  const isPaused = clarificationRequest !== null || fixConfirmRequest !== null;

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">
            Codexrev
          </Text>
          <ModeBadge mode={mode} />
        </Box>
        <Text dimColor>
          {settings.provider} · {settings.model} · sandbox: {settings.sandbox}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} marginY={1}>
        {messages.map((m) => (
          <MessageLine key={m.id} msg={m} />
        ))}
        {busy && !isPaused && (
          <Box>
            <Spinner type="dots" />
            <Text> thinking…</Text>
          </Box>
        )}
        {isPaused && (
          <Box>
            <Text color="yellow">⏸ Waiting for your input…</Text>
          </Box>
        )}
      </Box>

      {/* Clarification prompt */}
      {clarificationRequest && (
        <ClarificationPrompt
          request={clarificationRequest}
          onAnswer={handleClarificationAnswer}
        />
      )}

      {/* Fix confirmation prompt */}
      {fixConfirmRequest && (
        <FixConfirmPrompt
          request={fixConfirmRequest}
          onDecision={handleFixConfirmDecision}
        />
      )}

      {/* Mode switch flash notification */}
      {modeFlash && (
        <Box paddingX={1}>
          <Text color={MODE_CONFIG[mode].color} bold>
            {modeFlash}
          </Text>
        </Box>
      )}

      {/* Main input — hidden when clarification/fix-confirm is active */}
      {!clarificationRequest && !fixConfirmRequest && (
        <Box borderStyle="single" paddingX={1}>
          <ModeBadgeInline mode={mode} />
          <Text color="green">{'> '}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder={busy ? '(busy — Ctrl-C to abort)' : `Send a message. /help for commands. (Tab → ${MODE_CONFIG[MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]].label})`}
          />
        </Box>
      )}
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
    case 'pipeline': {
      const phaseColors: Record<string, string> = {
        committee: 'magenta',
        'breaker-builder': 'blue',
        resolver: 'cyan',
      };
      return (
        <Box>
          <Text color={phaseColors[msg.phaseName ?? ''] ?? 'white'} bold>
            ⚙ [{msg.phaseName}]{' '}
          </Text>
          <Text dimColor>{msg.text}</Text>
        </Box>
      );
    }
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
  /tools              list available tools
  /theme <name>       switch theme (restart required)
  /mode [name]        show or set mode (ask|plan|agent)
  /quit               exit Codexrev
  /exit               alias for /quit

Key bindings:
  Tab                 cycle mode (Ask → Plan → Agent)
  Ctrl-C              abort current run / exit`;
