/**
 * Codexrev — core domain types.
 *
 * These types are the lingua franca of the agent loop. The four LLM
 * provider adapters all normalize their native request/response shapes
 * into the types defined here, so the rest of the system can stay
 * provider-agnostic.
 */

/** Roles in a conversation. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Supported LLM providers. */
export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'litellm'
  | 'ollama'
  | 'lmstudio'
  | 'deepseek';

/** Text content part. */
export interface TextPart {
  readonly kind: 'text';
  readonly text: string;
}

/** Inline binary content (e.g. an image for vision models). */
export interface BlobPart {
  readonly kind: 'blob';
  readonly mimeType: string;
  readonly data: string; // base64
}

/** A tool/function call requested by the model. */
export interface ToolCallPart {
  readonly kind: 'tool_call';
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown; // already JSON-parsed
}

/** The model's response to a tool call. */
export interface ToolResultPart {
  readonly kind: 'tool_result';
  readonly toolCallId: string;
  readonly name: string;
  readonly content: Array<TextPart | BlobPart>;
  readonly isError?: boolean;
  /** Optional structured metadata surfaced to the UI (e.g. sandbox exec stats). */
  readonly metadata?: Record<string, unknown>;
}

/** Discriminated union of all content parts. */
export type ContentPart = TextPart | BlobPart | ToolCallPart | ToolResultPart;

/** A single message in the conversation. */
export interface Message {
  readonly role: Role;
  readonly parts: ContentPart[];
}

/** A single tool the model may call. */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;
}

/** JSON-Schema-like parameter description for a tool. */
export interface ToolParameters {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/** Token-usage telemetry returned by a provider. */
export interface UsageStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens: number;
  readonly costUsd?: number;
}

/** A single streamed event from a provider. */
export type StreamEvent =
  | { readonly kind: 'message_start'; readonly messageId: string }
  | { readonly kind: 'text_delta'; readonly text: string }
  | { readonly kind: 'tool_call'; readonly toolCall: ToolCallPart }
  | {
      readonly kind: 'finish';
      readonly reason: 'stop' | 'max_tokens' | 'tool_use' | 'error' | 'aborted';
      readonly usage?: UsageStats;
    }
  | { readonly kind: 'error'; readonly error: ProviderError };

/** Why the agent stopped its current turn. */
export type TurnFinishReason =
  | 'completed'
  | 'max_tokens'
  | 'aborted'
  | 'error'
  | 'awaiting_approval';

/** A normalized error surfaced by any provider. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderId,
    public readonly httpStatus?: number,
    public readonly code?: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** The normalized request sent to any provider. */
export interface GenerateRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDeclaration[];
  readonly systemInstruction?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  /** Optional signal used to abort the request. */
  readonly signal?: AbortSignal;
}

/** The aggregated response from a provider (non-streaming path). */
export interface GenerateResponse {
  readonly message: Message;
  readonly usage: UsageStats;
  readonly finishReason: Exclude<TurnFinishReason, 'awaiting_approval'>;
}

/** The unified interface every LLM provider must implement. */
export interface ContentGenerator {
  readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilities;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
}

/**
 * Self-describing capabilities advertised by a `ContentGenerator`.
 * Embedders and the agent loop can use these to degrade gracefully
 * (e.g. don't promise token-usage accounting for adapters that
 * can't report it).
 */
export interface ProviderCapabilities {
  /** Whether the provider accepts `tools` declarations. */
  readonly supportsTools: boolean;
  /** Whether the provider populates `usage` on streaming `finish` events. */
  readonly supportsStreamingUsage: boolean;
}

/** Configuration for instantiating a ContentGenerator. */
export interface ContentGeneratorConfig {
  readonly provider: ProviderId;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  /**
   * Per-request client timeout (ms), overriding the OpenAI-compat SDK's
   * fixed 10-minute default. Local models (Ollama/LM Studio — an
   * explicit "local/offline" requirement) can genuinely take longer
   * than that on modest hardware, especially a large model under load
   * or thermal throttling; without this, a slow-but-working request is
   * indistinguishable from a hung one and gets killed either way.
   * Undefined leaves the SDK's own default untouched.
   */
  readonly timeoutMs?: number;
  /** Provider-specific extras (kept open for forward-compat). */
  readonly extras?: Readonly<Record<string, unknown>>;
}
