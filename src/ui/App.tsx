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
import {
  InteractionChannel,
  type InteractionEvent,
  type ApprovalRequest,
  type ApprovalDecision,
} from '../core/interaction.js';
import { runFixLoop } from '../core/fixLoop.js';
import { saveSettings } from '../config/loader.js';
import type { SandboxManager } from '../sandbox/index.js';
import { ModeBadge, ModeBadgeInline } from './ModeBadge.js';
import { ClarificationPrompt, FixConfirmPrompt, ApprovalPrompt } from './ClarificationPrompt.js';
import { ControlPanel } from './ControlPanel.js';

interface AppProps {
  settings: Settings;
  runAgent: (
    prompt: string,
    systemPromptSuffix?: string,
    overrideTools?: Map<string, Tool>,
    contextMessages?: import('../core/types.js').Message[],
  ) => AsyncIterable<AgentEvent>;
  extensions?: ExtensionRegistry;
  interactionChannel: InteractionChannel;
  provider: ContentGenerator;
  tools: Map<string, Tool>;
  mcp: McpRegistry;
  /** Shared sandbox manager — Control Panel edits take effect live. */
  sandbox: SandboxManager;
  /** Called whenever settings change in-session (so the driver can keep its copy current). */
  onSettingsChange?: (settings: Settings) => void;
}

interface ExecState {
  status: 'running' | 'ok' | 'error';
  command?: string;
  startedAt: number;
  sandbox?: string;
  durationMs?: number;
  exitCode?: number;
}

interface Message {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'pipeline';
  text: string;
  toolName?: string;
  phaseName?: string;
  toolCallId?: string;
  /** Present for shell tool calls — drives the live sandbox exec card. */
  exec?: ExecState;
}

let nextId = 1;

export const App: React.FC<AppProps> = ({
  settings: initialSettings,
  runAgent,
  interactionChannel,
  provider,
  tools,
  mcp,
  sandbox,
  onSettingsChange,
}) => {
  const { exit } = useApp();

  // ── State ────────────────────────────────────────────────────
  const [settings, setSettingsState] = useState<Settings>(initialSettings);
  const [messages, setMessages] = useState<Message[]>([
    { id: nextId++, role: 'system', text: `Codexrev ready — ${initialSettings.provider} / ${initialSettings.model}` },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<InteractionMode>(initialSettings.defaultMode ?? 'ask');
  const [modeFlash, setModeFlash] = useState<string | null>(null);
  const modeFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Control Panel + sandbox status ──────────────────────────
  const [panelOpen, setPanelOpen] = useState(false);
  const [sandboxLabel, setSandboxLabel] = useState<string>(initialSettings.sandbox);
  useEffect(() => {
    let alive = true;
    sandbox
      .effectiveMode()
      .then((eff) => {
        if (alive) setSandboxLabel(eff === settings.sandbox ? eff : `${eff} (${settings.sandbox})`);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sandbox, settings.sandbox]);

  const applySettings = useCallback(
    (next: Settings) => {
      setSettingsState(next);
      sandbox.setMode(next.sandbox);
      onSettingsChange?.(next);
    },
    [sandbox, onSettingsChange],
  );

  // ── Approval prompt state ───────────────────────────────────
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);

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
      } else if (event.type === 'approval_request') {
        setApprovalRequest(event.request);
      } else if (event.type === 'abort') {
        setClarificationRequest(null);
        setFixConfirmRequest(null);
        setApprovalRequest(null);
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
        // Ask / Plan mode: single runAgent call with mode-specific system prompt.
        // Pass the conversation history so the assistant has session memory
        // across prompts (follow-ups, corrections, references to earlier turns).
        const modeTools = modeConfig.readOnly ? filterReadOnlyTools(tools) : undefined;
        const contextMessages = buildContextMessages(messages);
        for await (const ev of runAgent(prompt, modeConfig.systemPromptSuffix, modeTools, contextMessages)) {
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
      const isShell = ev.toolCall.name === 'shell';
      const command = (ev.toolCall.arguments as { command?: string } | undefined)?.command;
      setMessages((m) => [
        ...m,
        {
          id: nextId++,
          role: 'tool',
          text: ev.toolCall.name,
          toolName: ev.toolCall.name,
          toolCallId: ev.toolCall.id,
          exec: isShell ? { status: 'running', startedAt: Date.now(), command } : undefined,
        },
      ]);
    } else if (ev.kind === 'tool_result') {
      const md = (ev.toolResult.metadata ?? {}) as {
        sandbox?: string;
        durationMs?: number;
        exitCode?: number;
      };
      setMessages((m) =>
        m.map((msg) =>
          msg.toolCallId === ev.toolResult.toolCallId && msg.exec
            ? {
                ...msg,
                exec: {
                  ...msg.exec,
                  status: ev.toolResult.isError ? 'error' : 'ok',
                  sandbox: md.sandbox ?? msg.exec.sandbox,
                  durationMs: md.durationMs,
                  exitCode: md.exitCode,
                },
              }
            : msg,
        ),
      );
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

  const handleApprovalDecision = useCallback(
    (decision: ApprovalDecision) => {
      if (approvalRequest) {
        interactionChannel.respondApproval(approvalRequest.id, decision);
        setApprovalRequest(null);
        const label =
          decision === 'deny'
            ? `🚫 Denied ${approvalRequest.toolName}`
            : decision === 'approve-session'
              ? `✔ Approved ${approvalRequest.toolName} for this session`
              : `✔ Approved ${approvalRequest.toolName}`;
        setMessages((m) => [...m, { id: nextId++, role: 'system', text: label }]);
      }
    },
    [approvalRequest, interactionChannel],
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
      case 'config':
      case 'settings':
        setPanelOpen(true);
        break;
      case 'sandbox': {
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'system', text: 'probing sandbox backends…' },
        ]);
        void Promise.all([sandbox.effectiveMode(), sandbox.probe()])
          .then(([eff, p]) => {
            const mark = (ok: boolean) => (ok ? '✓ available' : '✗ unavailable');
            const text = [
              `sandbox mode: ${settings.sandbox}  →  effective: ${eff}`,
              `  seatbelt: ${mark(p.seatbelt)}`,
              `  docker:   ${mark(p.docker)}`,
              `  podman:   ${mark(p.podman)}`,
              `approvals: ${settings.bypassApprovals ? 'BYPASSED (YOLO)' : settings.approvalMode}`,
            ].join('\n');
            setMessages((m) => [...m, { id: nextId++, role: 'system', text }]);
          })
          .catch((err: Error) => {
            setMessages((m) => [
              ...m,
              { id: nextId++, role: 'system', text: `sandbox probe failed: ${err.message}` },
            ]);
          });
        break;
      }
      case 'quit':
      case 'exit':
        exit();
        break;
      case 'theme':
        if (rest[0] && (['dark', 'light', 'solarized', 'monokai', 'nord'] as const).includes(rest[0] as Settings['theme'])) {
          applySettings({ ...settings, theme: rest[0] as Settings['theme'] });
          setMessages((m) => [...m, { id: nextId++, role: 'system', text: `theme: ${rest[0]}` }]);
        } else {
          setMessages((m) => [
            ...m,
            { id: nextId++, role: 'system', text: `theme: ${settings.theme} (use /theme <dark|light|solarized|monokai|nord> or Ctrl+S)` },
          ]);
        }
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
      return;
    }
    // Control Panel owns the keyboard while open.
    if (panelOpen) return;
    // Ctrl+S opens the Control Panel (settings dashboard).
    if (key.ctrl && inputChar === 's' && !clarificationRequest && !fixConfirmRequest && !approvalRequest) {
      setPanelOpen(true);
      return;
    }
    // Tab cycles mode — only when not busy and no prompt pending
    if (key.tab && !busy && !clarificationRequest && !fixConfirmRequest && !approvalRequest) {
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

  const isPaused =
    clarificationRequest !== null || fixConfirmRequest !== null || approvalRequest !== null;
  const approvalsLabel = settings.bypassApprovals
    ? '⚠ YOLO'
    : `approvals: ${settings.approvalMode}`;

  if (panelOpen) {
    return (
      <ControlPanel
        settings={settings}
        sandbox={sandbox}
        onChange={applySettings}
        onSave={async (next) => {
          await saveSettings(next);
          applySettings(next);
        }}
        onClose={() => setPanelOpen(false)}
      />
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">
            Codexrev
          </Text>
          <ModeBadge mode={mode} />
        </Box>
        <Box>
          <Text dimColor>
            {settings.provider} · {settings.model} ·{' '}
          </Text>
          <Text color={sandboxLabel.startsWith('off') ? 'yellow' : 'green'}>
            🛡 {sandboxLabel}
          </Text>
          <Text dimColor> · </Text>
          <Text color={settings.bypassApprovals ? 'red' : 'gray'}>{approvalsLabel}</Text>
          <Text dimColor>  (Ctrl+S settings)</Text>
        </Box>
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

      {/* Tool approval prompt */}
      {approvalRequest && (
        <ApprovalPrompt request={approvalRequest} onDecision={handleApprovalDecision} />
      )}

      {/* Mode switch flash notification */}
      {modeFlash && (
        <Box paddingX={1}>
          <Text color={MODE_CONFIG[mode].color} bold>
            {modeFlash}
          </Text>
        </Box>
      )}

      {/* Main input — hidden when a prompt is active */}
      {!clarificationRequest && !fixConfirmRequest && !approvalRequest && (
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
      if (msg.exec) return <ExecCard exec={msg.exec} />;
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

// ── Sandbox exec UI ───────────────────────────────────────────

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

/** Live elapsed-seconds counter, ticks 10×/s while a command runs. */
const ElapsedTimer: React.FC<{ startedAt: number }> = ({ startedAt }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <Text dimColor>{((now - startedAt) / 1000).toFixed(1)}s</Text>;
};

/** One shell command's sandbox execution — live while running, then collapsed. */
const ExecCard: React.FC<{ exec: ExecState }> = ({ exec }) => {
  if (exec.status === 'running') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="cyan"> shell </Text>
        <Text dimColor>{truncate(exec.command, 48)} </Text>
        <ElapsedTimer startedAt={exec.startedAt} />
      </Box>
    );
  }
  const ok = exec.status === 'ok';
  const secs =
    exec.durationMs != null ? `${(exec.durationMs / 1000).toFixed(1)}s` : '—';
  return (
    <Box>
      <Text color={ok ? 'green' : 'red'}>{ok ? '✔' : '✗'} shell </Text>
      <Text dimColor>{truncate(exec.command, 40)}  </Text>
      <Text color={exec.sandbox === 'off' ? 'yellow' : 'green'}>{exec.sandbox ?? '?'}</Text>
      <Text dimColor>
        {' '}
        · {secs} · exit {exec.exitCode ?? '?'}
      </Text>
    </Box>
  );
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
  /config             open the Control Panel (settings dashboard)
  /sandbox            show sandbox backend & approval status
  /clear              clear the conversation
  /tools              list available tools
  /theme <name>       switch theme (dark|light|solarized|monokai|nord)
  /mode [name]        show or set mode (ask|plan|agent)
  /quit               exit Codexrev
  /exit               alias for /quit

Key bindings:
  Tab                 cycle mode (Ask → Plan → Agent)
  Ctrl-S              open the Control Panel
  Ctrl-C              abort current run / exit`;
