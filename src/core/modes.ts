// Interaction modes: Ask (read-only Q&A), Plan (step-by-step plan, no execution),
// Agent (full pipeline with fix loop).

import type { Tool } from '../tools/registry.js';

export type InteractionMode = 'ask' | 'plan' | 'agent';

export const MODE_ORDER: readonly InteractionMode[] = ['ask', 'plan', 'agent'] as const;

export interface ModeConfig {
  readonly label: string;
  /** Ink color for the badge */
  readonly color: string;
  readonly description: string;
  readonly systemPromptSuffix: string;
  /** strip write/mutating tools when true */
  readonly readOnly: boolean;
}

export const MODE_CONFIG: Record<InteractionMode, ModeConfig> = {
  ask: {
    label: 'Ask',
    color: 'blue',
    description: 'Read-only Q&A — no file edits, no shell commands.',
    readOnly: true,
    systemPromptSuffix: [
      'MODE: Ask (read-only Q&A)',
      'You MUST NOT modify any files, run shell commands, or call any tools that change state.',
      'Only use read-only tools (read_file, glob, grep, web_fetch, web_search) to gather context.',
      'Answer the user\'s question directly and concisely.',
    ].join('\n'),
  },
  plan: {
    label: 'Plan',
    color: 'yellow',
    description: 'Generates a step-by-step plan — no execution.',
    readOnly: true,
    systemPromptSuffix: [
      'MODE: Plan (analysis only)',
      'You MUST NOT modify any files, run shell commands, or call any tools that change state.',
      'Only use read-only tools (read_file, glob, grep, web_fetch, web_search) to gather context.',
      'Produce a clear, numbered step-by-step plan that describes what the pipeline would do.',
      'For each step, specify: the action, which files are affected, and the expected outcome.',
      'Do NOT execute the plan — only describe it.',
    ].join('\n'),
  },
  agent: {
    label: 'Agent',
    color: 'green',
    description: 'Full pipeline — analysis, implementation, verification with fix loop.',
    readOnly: false,
    systemPromptSuffix: [
      'MODE: Agent (full pipeline)',
      'You are operating in Agent mode with full pipeline capabilities.',
      'The pipeline runs: Committee (analysis) → Breaker-Builder (implementation) → Resolver (verification).',
      'You may use all available tools including write_file, edit, and shell.',
      'When you need clarification from the user, call the ask_user tool.',
    ].join('\n'),
  },
};

// cycles ask -> plan -> agent -> ask
export function nextMode(current: InteractionMode): InteractionMode {
  const idx = MODE_ORDER.indexOf(current);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
}

export function filterReadOnlyTools(tools: Map<string, Tool>): Map<string, Tool> {
  const READ_ONLY = new Set([
    'read_file',
    'glob',
    'grep',
    'web_fetch',
    'web_search',
    'ask_user',
  ]);
  const filtered = new Map<string, Tool>();
  for (const [name, tool] of tools) {
    if (READ_ONLY.has(name)) {
      filtered.set(name, tool);
    }
  }
  return filtered;
}
