/**
 * Codexrev — `ask_user` tool.
 *
 * Allows the LLM to pause execution and ask the user a clarification
 * question when it encounters ambiguity. The tool blocks until the
 * user responds, then returns the answer as the tool result.
 */

import type { Tool, ToolResult } from './registry.js';
import type { ToolDeclaration } from '../core/types.js';
import type { InteractionChannel } from '../core/interaction.js';

const NAME = 'ask_user';
const DESCRIPTION =
  'Ask the user a clarifying question when you need more information or face ambiguity. ' +
  'Provide suggested answers for quick selection, but the user may also type a free-form response. ' +
  'Execution pauses until the user answers.';

const PARAMETERS = {
  type: 'object' as const,
  properties: {
    question: {
      type: 'string',
      description: 'The clarification question to ask the user.',
    },
    suggestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Suggested quick-select answers (user can also type a custom answer).',
    },
    context: {
      type: 'string',
      description: 'Optional additional context to help the user understand why you are asking.',
    },
  },
  required: ['question'],
  additionalProperties: false,
};

const declaration: ToolDeclaration = {
  name: NAME,
  description: DESCRIPTION,
  parameters: PARAMETERS,
};

/**
 * Create an `ask_user` tool bound to the given interaction channel.
 */
export function createAskUserTool(channel: InteractionChannel): Tool {
  return {
    name: NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    declaration,
    async execute(args): Promise<ToolResult> {
      const { question, suggestions, context } = (args ?? {}) as {
        question: string;
        suggestions?: string[];
        context?: string;
      };
      if (!question) {
        return { output: 'Error: question is required', isError: true };
      }

      try {
        const answer = await channel.requestClarification(
          question,
          suggestions ?? [],
          context,
        );
        return { output: `User answered: ${answer}` };
      } catch {
        return { output: 'Interaction was aborted by the user.', isError: true };
      }
    },
  };
}
