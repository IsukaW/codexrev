/**
 * Codexrev — error classes.
 *
 * All expected error conditions should be modelled as a class extending
 * `CodexrevError` so the CLI can produce user-friendly messages and the
 * runtime can decide whether to retry, surface to the user, or crash.
 */

export class CodexrevError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'CODEXREV_ERROR',
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'CodexrevError';
  }
}

export class ConfigError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_CONFIG_ERROR', false);
    this.name = 'ConfigError';
  }
}

export class AuthError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_AUTH_ERROR', false);
    this.name = 'AuthError';
  }
}

export class ToolError extends CodexrevError {
  constructor(
    public readonly toolName: string,
    message: string,
    retryable: boolean = false,
  ) {
    super(message, 'CODEXREV_TOOL_ERROR', retryable);
    this.name = 'ToolError';
  }
}

export class SandboxError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_SANDBOX_ERROR', false);
    this.name = 'SandboxError';
  }
}

export class McpError extends CodexrevError {
  constructor(message: string, retryable: boolean = false) {
    super(message, 'CODEXREV_MCP_ERROR', retryable);
    this.name = 'McpError';
  }
}

export class CheckpointError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_CHECKPOINT_ERROR', false);
    this.name = 'CheckpointError';
  }
}
