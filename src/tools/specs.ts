// Tool specs: name, description, JSON-Schema-ish params. Implementations live in
// builtin.ts.

import type { ToolParameters } from '../core/types.js';

const filePathParams: ToolParameters = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Absolute or relative file path' },
    offset: { type: 'number', description: 'Line offset to start reading from (optional)' },
    limit: { type: 'number', description: 'Max number of lines to read (optional)' },
  },
  required: ['file_path'],
  additionalProperties: false,
};

const fileWriteParams: ToolParameters = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'File path to write to' },
    content: { type: 'string', description: 'New file contents' },
  },
  required: ['file_path', 'content'],
  additionalProperties: false,
};

const fileEditParams: ToolParameters = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    old_string: { type: 'string', description: 'Text to search for' },
    new_string: { type: 'string', description: 'Replacement text' },
    replace_all: {
      type: 'boolean',
      description: 'Replace every occurrence, not just the first',
      default: false,
    },
  },
  required: ['file_path', 'old_string', 'new_string'],
  additionalProperties: false,
};

const shellParams: ToolParameters = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
    timeout: { type: 'number', description: 'Optional timeout in ms' },
  },
  required: ['command'],
  additionalProperties: false,
};

const globParams: ToolParameters = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Glob pattern (e.g. **/*.ts)' },
    cwd: { type: 'string', description: 'Working directory (defaults to process.cwd())' },
  },
  required: ['pattern'],
  additionalProperties: false,
};

const grepParams: ToolParameters = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Regular expression or literal string' },
    path: { type: 'string', description: 'File or directory to search' },
    include: { type: 'string', description: 'Glob filter (e.g. *.ts)' },
    case_sensitive: { type: 'boolean', default: true },
  },
  required: ['pattern', 'path'],
  additionalProperties: false,
};

const webFetchParams: ToolParameters = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'HTTP/HTTPS URL to fetch' },
  },
  required: ['url'],
  additionalProperties: false,
};

const webSearchParams: ToolParameters = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    num_results: { type: 'number', description: 'Max number of results (default 8)' },
  },
  required: ['query'],
  additionalProperties: false,
};

export const ShellTool = {
  name: 'shell',
  description:
    'Execute a shell command in the working directory. Output is captured from stdout and stderr. Commands run in the configured sandbox when enabled.',
  parameters: shellParams,
} as const;

export const FileReadTool = {
  name: 'read_file',
  description:
    'Read the contents of a text file. Returns up to `limit` lines starting at `offset`.',
  parameters: filePathParams,
} as const;

export const FileWriteTool = {
  name: 'write_file',
  description: 'Create or overwrite a file with new content.',
  parameters: fileWriteParams,
} as const;

export const FileEditTool = {
  name: 'edit',
  description: 'Replace a string in a file. If `replace_all` is true, replaces every occurrence.',
  parameters: fileEditParams,
} as const;

export const GlobTool = {
  name: 'glob',
  description: 'Find files matching a glob pattern. Returns paths relative to `cwd`.',
  parameters: globParams,
} as const;

export const GrepTool = {
  name: 'grep',
  description: 'Search file contents with a regex or literal string. Returns matching lines.',
  parameters: grepParams,
} as const;

export const WebFetchTool = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its content as plain text.',
  parameters: webFetchParams,
} as const;

export const WebSearchTool = {
  name: 'web_search',
  description: 'Search the web with a query and return the top results.',
  parameters: webSearchParams,
} as const;
