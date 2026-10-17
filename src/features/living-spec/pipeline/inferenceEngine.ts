/**
 * Implication-inference engine — the semantic back half of the living-spec
 * pipeline.
 *
 * Flow: minimal diff → hardened prompt → `llmPort.generate()` → parse →
 * STRICT ajv validation. Every step is fail-safe (NFR4/NFR5):
 *
 *   - Malformed JSON or schema-invalid output is NEVER applied or persisted as
 *     authoritative — it becomes a structured error result instead.
 *   - On model timeout or unavailability the caller's prior state is left
 *     untouched; the engine retries once on timeout (configurable) and then
 *     returns a structured error.
 *   - The engine is otherwise pure: it returns a discriminated `InferenceResult`
 *     and performs no persistence itself, so "leave prior state untouched" is a
 *     structural guarantee, not a convention.
 *
 * Quality metadata (model id, latency, schema validity, token usage when the
 * provider reports it) is recorded on both success and failure.
 */

import type {
  ContentPart,
  GenerateRequest,
  GenerateResponse,
  TextPart,
  UsageStats,
} from '../../../core/types.js';
import type {
  InferredImplication,
  ImplicationOutput,
} from '../tools/implicationSchema.js';
import { validateImplicationOutput } from '../tools/implicationSchema.js';
import { buildImplicationPrompt, type PromptInput } from './promptBuilder.js';
import type { LLMPort } from './llmPort.js';
import type {
  SpecAnalysisResult,
  SpecAnalysisQuality,
  SpecImplication,
} from './types.js';

// ── Error taxonomy ─────────────────────────────────────────────────────

export type InferenceErrorCode =
  | 'timeout'
  | 'provider_unavailable'
  | 'provider_error'
  | 'malformed_output'
  | 'schema_invalid';

export interface InferenceError {
  readonly code: InferenceErrorCode;
  readonly message: string;
  /** Whether a caller could reasonably retry the same request later. */
  readonly retryable: boolean;
}

class InferenceTimeoutError extends Error {
  constructor(ms: number) {
    super(`inference timed out after ${ms}ms`);
    this.name = 'InferenceTimeoutError';
  }
}

class MalformedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedOutputError';
  }
}

// ── Quality / result shapes ────────────────────────────────────────────

export interface InferenceUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface InferenceQuality {
  readonly model: string;
  readonly provider: string;
  readonly latencyMs: number;
  readonly schemaValid: boolean;
  readonly usage?: InferenceUsage;
}

export interface InferenceSuccess {
  readonly ok: true;
  readonly output: ImplicationOutput;
  readonly quality: InferenceQuality;
}

export interface InferenceFailure {
  readonly ok: false;
  readonly error: InferenceError;
  readonly quality: InferenceQuality;
}

export type InferenceResult = InferenceSuccess | InferenceFailure;

export interface InferenceOptions {
  readonly model: string;
  readonly provider: string;
  /** Per-request timeout in ms. */
  readonly timeoutMs: number;
  /** Retries allowed on top of the first attempt when it times out (default 1). */
  readonly maxTimeoutRetries?: number;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Injectable monotonic-ish clock for latency measurement (ms). */
  readonly now?: () => number;
}

// ── Parsing helpers (self-contained; never borrowed from other features) ──

function extractText(parts: readonly ContentPart[]): string {
  return parts
    .filter((p): p is TextPart => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

/** Pulls a single JSON object out of the model text (raw, fenced, or embedded). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  throw new MalformedOutputError(
    `could not extract a JSON object from the model response: ${trimmed.slice(0, 200)}`,
  );
}

function toUsage(usage: UsageStats | undefined): InferenceUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

// ── Timeout + classification ───────────────────────────────────────────

/**
 * Runs one generate call with a hard timeout. Aborts the underlying request on
 * timeout, but settles the race on the timer itself so an abort-induced
 * rejection can never be misread as a non-timeout failure.
 */
async function generateWithTimeout(
  llm: LLMPort,
  req: GenerateRequest,
  timeoutMs: number,
): Promise<GenerateResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gen = llm.generate({ ...req, signal: controller.signal });
  // If the race loses to the timer, a late rejection from `gen` must not become
  // an unhandled promise rejection.
  void gen.catch(() => undefined);

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InferenceTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([gen, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

const UNAVAILABLE_RE =
  /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed|socket hang up|network|UND_ERR|unavailable|connect/i;

function classifyError(err: unknown): InferenceError {
  if (err instanceof InferenceTimeoutError) {
    return { code: 'timeout', message: err.message, retryable: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  // We only ever abort on timeout, so an abort-shaped error is a timeout.
  if (/abort/i.test(message)) return { code: 'timeout', message, retryable: true };
  if (UNAVAILABLE_RE.test(message)) {
    return { code: 'provider_unavailable', message, retryable: true };
  }
  return { code: 'provider_error', message, retryable: false };
}

// ── Engine ─────────────────────────────────────────────────────────────

export async function runImplicationInference(
  input: PromptInput,
  llm: LLMPort,
  options: InferenceOptions,
): Promise<InferenceResult> {
  const now = options.now ?? (() => Date.now());
  const prompt = buildImplicationPrompt(input);
  const maxTimeoutRetries = options.maxTimeoutRetries ?? 1;

  const baseRequest: GenerateRequest = {
    model: options.model,
    systemInstruction: prompt.system,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: prompt.user }] }],
    temperature: options.temperature ?? 0.2,
    ...(options.maxOutputTokens !== undefined
      ? { maxOutputTokens: options.maxOutputTokens }
      : {}),
  };

  const started = now();
  const latency = (): number => Math.max(0, now() - started);
  const failure = (error: InferenceError, usage?: InferenceUsage): InferenceFailure => ({
    ok: false,
    error,
    quality: {
      model: options.model,
      provider: options.provider,
      latencyMs: latency(),
      schemaValid: false,
      ...(usage ? { usage } : {}),
    },
  });

  for (let attempt = 0; attempt <= maxTimeoutRetries; attempt++) {
    let response: GenerateResponse;
    try {
      response = await generateWithTimeout(llm, baseRequest, options.timeoutMs);
    } catch (err) {
      const classified = classifyError(err);
      // Retry only on timeout, and only while retries remain.
      if (classified.code === 'timeout' && attempt < maxTimeoutRetries) continue;
      return failure(classified);
    }

    const usage = toUsage(response.usage);
    let parsed: unknown;
    try {
      parsed = extractJson(extractText(response.message.parts));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure({ code: 'malformed_output', message, retryable: false }, usage);
    }

    const validated = validateImplicationOutput(parsed);
    if (!validated.ok) {
      return failure(
        {
          code: 'schema_invalid',
          message: validated.errors.join('; '),
          retryable: false,
        },
        usage,
      );
    }

    return {
      ok: true,
      output: validated.value,
      quality: {
        model: options.model,
        provider: options.provider,
        latencyMs: latency(),
        schemaValid: true,
        ...(usage ? { usage } : {}),
      },
    };
  }

  // Unreachable: the loop returns on its final iteration. Defensive fallback.
  return failure({ code: 'provider_error', message: 'inference failed', retryable: false });
}

// ── Domain mapping (model output → stable contract) ────────────────────

/** Maps one model implication to the stable `SpecImplication` contract shape. */
export function toSpecImplication(imp: InferredImplication): SpecImplication {
  return {
    id: imp.id,
    kind: imp.kind,
    text: imp.text,
    confidence: imp.confidence,
    sourceRefs: imp.sourceRefs.map((r) => `${r.path}:${r.line}`),
    rationale: imp.rationale,
    ...(imp.category !== undefined ? { category: imp.category } : {}),
  };
}

export function toSpecQuality(quality: InferenceQuality): SpecAnalysisQuality {
  return {
    model: quality.model,
    latencyMs: quality.latencyMs,
    schemaValid: quality.schemaValid,
    ...(quality.usage ? { usage: quality.usage } : {}),
  };
}

/**
 * Applies a validated inference result onto the deterministic analysis result,
 * returning a NEW `SpecAnalysisResult`. On success the implications,
 * behaviour-change summary, URS-update flag and quality are filled in; the
 * prior deterministic fields are otherwise preserved.
 */
export function applyInferenceToResult(
  base: SpecAnalysisResult,
  success: InferenceSuccess,
): SpecAnalysisResult {
  return {
    ...base,
    implications: success.output.implications.map(toSpecImplication),
    behaviourChangeSummary: success.output.behaviourChangeSummary,
    requiresUrsUpdate: success.output.requiresUrsUpdate,
    quality: toSpecQuality(success.quality),
    inferenceError: undefined,
  };
}

// ── Evaluation-friendly labelled output ────────────────────────────────

/**
 * Stable, metrics-friendly record written to
 * `reports/<changeId>.implications.json` alongside the analysis report. The
 * `implications` array keeps the MODEL's own shape (sourceRefs as `{path,line}`)
 * so later evaluation can score it directly against the schema; `ok` + `error`
 * let a metrics pass distinguish real outputs from failures.
 */
export interface ImplicationsLabelFile {
  readonly schemaVersion: 1;
  readonly changeId: string;
  readonly timestamp: string;
  readonly provider: string;
  readonly model: string;
  readonly ok: boolean;
  readonly implications: readonly InferredImplication[];
  readonly behaviourChangeSummary: string;
  readonly requiresUrsUpdate: boolean;
  readonly quality: InferenceQuality;
  readonly error?: InferenceError;
}

export function buildImplicationsLabel(params: {
  changeId: string;
  timestamp: string;
  provider: string;
  model: string;
  result: InferenceResult;
}): ImplicationsLabelFile {
  const { result } = params;
  return {
    schemaVersion: 1,
    changeId: params.changeId,
    timestamp: params.timestamp,
    provider: params.provider,
    model: params.model,
    ok: result.ok,
    implications: result.ok ? [...result.output.implications] : [],
    behaviourChangeSummary: result.ok ? result.output.behaviourChangeSummary : '',
    requiresUrsUpdate: result.ok ? result.output.requiresUrsUpdate : false,
    quality: result.quality,
    ...(result.ok ? {} : { error: result.error }),
  };
}
