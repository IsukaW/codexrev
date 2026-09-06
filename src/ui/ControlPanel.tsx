// Full-screen settings overlay (Ctrl+S or /config). Lets you flip sandbox
// mode, approval policy/YOLO, theme, and the agent knobs without restarting,
// and save them to ~/.codexrev/settings.json.
// keys: up/down move, left/right change, enter/space toggles, s saves, esc closes (discards unsaved edits)

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { Settings, SandboxMode, ThemeName } from '../config/schema.js';
import type { InteractionMode } from '../core/modes.js';
import type { VerificationMode } from '../core/verification.js';
import type { SandboxManager, SandboxProbe } from '../sandbox/index.js';

interface ControlPanelProps {
  settings: Settings;
  sandbox: SandboxManager;
  onChange: (next: Settings) => void; // applies live, before it's saved
  onSave: (settings: Settings) => Promise<void>;
  onClose: () => void;
}

type Row =
  | { kind: 'section'; label: string }
  | {
      kind: 'enum';
      key: string;
      label: string;
      options: readonly string[];
      get: (s: Settings) => string;
      set: (s: Settings, v: string) => Settings;
      danger?: (v: string) => boolean;
    }
  | {
      kind: 'toggle';
      key: string;
      label: string;
      get: (s: Settings) => boolean;
      set: (s: Settings, v: boolean) => Settings;
      danger?: boolean;
    }
  | {
      kind: 'number';
      key: string;
      label: string;
      step: number;
      min: number;
      max: number;
      get: (s: Settings) => number;
      set: (s: Settings, v: number) => Settings;
    };

const SANDBOX_MODES: readonly SandboxMode[] = ['auto', 'seatbelt', 'docker', 'podman', 'off'];
const APPROVAL_MODES = ['always', 'on-request', 'never'] as const;
const THEMES: readonly ThemeName[] = ['dark', 'light', 'solarized', 'monokai', 'nord'];
const MODES: readonly InteractionMode[] = ['ask', 'plan', 'agent'];
const VERIFICATION: readonly VerificationMode[] = ['auto', 'tests', 'llm'];

const ROWS: Row[] = [
  { kind: 'section', label: 'SANDBOX' },
  {
    kind: 'enum',
    key: 'sandbox',
    label: 'Mode',
    options: SANDBOX_MODES,
    get: (s) => s.sandbox,
    set: (s, v) => ({ ...s, sandbox: v as SandboxMode }),
    danger: (v) => v === 'off',
  },
  { kind: 'section', label: 'APPROVALS' },
  {
    kind: 'enum',
    key: 'approvalMode',
    label: 'Policy',
    options: APPROVAL_MODES,
    get: (s) => s.approvalMode,
    set: (s, v) => ({ ...s, approvalMode: v as Settings['approvalMode'] }),
    danger: (v) => v === 'never',
  },
  {
    kind: 'toggle',
    key: 'bypassApprovals',
    label: '⚠ Bypass ALL approvals (YOLO)',
    get: (s) => s.bypassApprovals,
    set: (s, v) => ({ ...s, bypassApprovals: v }),
    danger: true,
  },
  { kind: 'section', label: 'APPEARANCE' },
  {
    kind: 'enum',
    key: 'theme',
    label: 'Theme',
    options: THEMES,
    get: (s) => s.theme,
    set: (s, v) => ({ ...s, theme: v as ThemeName }),
  },
  { kind: 'section', label: 'AGENT' },
  {
    kind: 'enum',
    key: 'defaultMode',
    label: 'Default mode',
    options: MODES,
    get: (s) => s.defaultMode,
    set: (s, v) => ({ ...s, defaultMode: v as InteractionMode }),
  },
  {
    kind: 'number',
    key: 'maxTurns',
    label: 'Max turns',
    step: 5,
    min: 1,
    max: 200,
    get: (s) => s.maxTurns,
    set: (s, v) => ({ ...s, maxTurns: v }),
  },
  {
    kind: 'number',
    key: 'maxFixAttempts',
    label: 'Max fix attempts',
    step: 1,
    min: 1,
    max: 5,
    get: (s) => s.maxFixAttempts,
    set: (s, v) => ({ ...s, maxFixAttempts: v }),
  },
  {
    kind: 'enum',
    key: 'verificationMode',
    label: 'Verification',
    options: VERIFICATION,
    get: (s) => s.verificationMode,
    set: (s, v) => ({ ...s, verificationMode: v as VerificationMode }),
  },
];

const FOCUSABLE = ROWS.filter((r) => r.kind !== 'section');

function cycle(options: readonly string[], current: string, dir: 1 | -1): string {
  const i = options.indexOf(current);
  const n = options.length;
  return options[((i === -1 ? 0 : i) + dir + n) % n];
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  settings,
  sandbox,
  onChange,
  onSave,
  onClose,
}) => {
  const initial = useMemo(() => settings, []); // so Esc has something to revert to
  const [draft, setDraft] = useState<Settings>(settings);
  const [focus, setFocus] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [effective, setEffective] = useState<string>(sandbox.getMode());
  const [probe, setProbe] = useState<SandboxProbe | null>(null);
  // re-probe whenever the mode changes so "effective" stays accurate
  useEffect(() => {
    let alive = true;
    void Promise.all([sandbox.effectiveMode(), sandbox.probe()]).then(([eff, p]) => {
      if (!alive) return;
      setEffective(eff);
      setProbe(p);
    });
    return () => {
      alive = false;
    };
  }, [sandbox, draft.sandbox]);

  const apply = (next: Settings) => {
    setDraft(next);
    setDirty(true);
    setStatus(null);
    onChange(next);
  };

  const changeFocused = (dir: 1 | -1) => {
    const row = FOCUSABLE[focus];
    if (row.kind === 'enum') {
      apply(row.set(draft, cycle(row.options, row.get(draft), dir)));
    } else if (row.kind === 'number') {
      const v = Math.min(row.max, Math.max(row.min, row.get(draft) + dir * row.step));
      apply(row.set(draft, v));
    } else if (row.kind === 'toggle') {
      apply(row.set(draft, !row.get(draft)));
    }
  };

  useInput((input, key) => {
    if (saving) return;
    if (key.escape) {
      if (dirty) onChange(initial); // revert live session
      onClose();
      return;
    }
    if (key.upArrow) setFocus((f) => (f - 1 + FOCUSABLE.length) % FOCUSABLE.length);
    else if (key.downArrow) setFocus((f) => (f + 1) % FOCUSABLE.length);
    else if (key.leftArrow) changeFocused(-1);
    else if (key.rightArrow) changeFocused(1);
    else if (key.return || input === ' ') {
      if (FOCUSABLE[focus].kind === 'toggle') changeFocused(1);
      else changeFocused(1);
    } else if (input === 's' || input === 'S') {
      setSaving(true);
      setStatus('saving…');
      void onSave(draft)
        .then(() => {
          setDirty(false);
          setStatus('saved to ~/.codexrev/settings.json');
        })
        .catch((err: Error) => setStatus(`save failed: ${err.message}`))
        .finally(() => setSaving(false));
    }
  });

  let fIdx = -1;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          ⚙ Codexrev · Control Panel
        </Text>
        <Text dimColor>{dirty ? '● unsaved' : ''}</Text>
      </Box>

      {ROWS.map((row, i) => {
        if (row.kind === 'section') {
          return (
            <Box key={`s${i}`} marginTop={i === 0 ? 0 : 1}>
              <Text bold dimColor>
                {row.label}
              </Text>
            </Box>
          );
        }
        fIdx += 1;
        const focused = fIdx === focus;
        const pointer = focused ? '▸' : ' ';
        let value: React.ReactNode;
        let danger = false;
        if (row.kind === 'enum') {
          const v = row.get(draft);
          danger = row.danger?.(v) ?? false;
          value = <Text>‹ {v} ›</Text>;
        } else if (row.kind === 'toggle') {
          const v = row.get(draft);
          danger = (row.danger ?? false) && v;
          value = <Text color={v ? 'red' : undefined}>[ {v ? 'ON' : 'OFF'} ]</Text>;
        } else {
          value = <Text>‹ {row.get(draft)} ›</Text>;
        }
        return (
          <Box key={row.key}>
            <Text color={focused ? 'cyan' : undefined}>{pointer} </Text>
            <Box width={30}>
              <Text color={danger ? 'red' : focused ? 'white' : undefined}>{row.label}</Text>
            </Box>
            <Text color={danger ? 'red' : focused ? 'cyan' : undefined} dimColor={!focused && !danger}>
              {value}
            </Text>
            {row.key === 'sandbox' && (
              <Text dimColor> → effective: {effective}</Text>
            )}
          </Box>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          backends:{' '}
          {probe
            ? (['seatbelt', 'docker', 'podman'] as const)
                .map((b) => `${b} ${probe[b] ? '✓' : '✗'}`)
                .join('   ')
            : 'probing…'}
        </Text>
        {draft.bypassApprovals && (
          <Text color="red">⚠ YOLO is ON — the agent will run shell/edits with no prompt.</Text>
        )}
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        {saving ? (
          <Text>
            <Spinner type="dots" /> saving…
          </Text>
        ) : (
          <Text dimColor>↑↓ move · ←→ change · Enter toggle · S save · Esc close</Text>
        )}
      </Box>
      {status && !saving && (
        <Text color={status.startsWith('save failed') ? 'red' : 'green'}>{status}</Text>
      )}
    </Box>
  );
};
