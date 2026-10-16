/**
 * The contextual interpreter: asks the configured local model for unverified
 * observations about a proposed action and returns a structured result.
 *
 * What the model is and is not:
 *   - it gets a bounded, secret-masked description of the evidence bundle
 *   - it gets NO tools, so it cannot run, read or change anything
 *   - it returns observations only; the validator accepts nothing else, so it
 *     cannot return a decision, a score, a factor value or a "verified" flag
 *   - everything it says is marked unverified and advisory
 *
 * Every outcome is a ContextInterpretation with an explicit status. A model
 * that is missing, down, slow, rude or confused produces UNAVAILABLE, ERROR or
 * INVALID_RESPONSE with the reason, never an invented success, and there is no
 * fallback to another provider.
 */

import { ProviderError, type ContentGenerator, type GenerateResponse, type ProviderId } from '../../../core/types.js';
import { LocalServerError } from '../../../utils/errors.js';
import type { EvidenceBundle } from '../collectors/evidenceOrchestrator.js';
import { clip } from '../collectors/types.js';
import { buildPromptContext, maskSecrets, type InterpretationLimits } from './contextBuilder.js';
import { buildSystemInstruction, buildUserMessage, newNonce } from './prompt.js';
import { selectInterpretationProvider, type ProviderSelectionDeps } from './providerSelection.js';
import { validateInterpretationResponse } from './responseValidator.js';
import {
  INTERPRETATION_SCHEMA_VERSION,
  type ContextInterpretation,
  type InterpretationFailureKind,
  type InterpretationStatus,
  type PromptStats,
} from './types.js';

/** A bound for one model call. Deliberately much shorter than the 30-minute default for local providers. */
export const DEFAULT_INTERPRETATION_TIMEOUT_MS = 120_000;
export const DEFAULT_INTERPRETATION_MAX_OUTPUT_TOKENS = 2_000;

const ADVISORY_LIMITATION =
  'Observations are unverified model output. They are advisory only and are not evidence: they cannot change a score, a gate or a decision.';

class InterpretationTimeout extends Error {}

export interface InterpretContextOptions {
  /** any object implementing the shared ContentGenerator.generate */
  readonly generator: Pick<ContentGenerator, 'generate'>;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly local: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  /** boundary nonce; random by default, fixed in tests */
  readonly nonce?: string;
  readonly limits?: Partial<InterpretationLimits>;
  readonly includeDiffs?: boolean;
}

interface Parts {
  status: InterpretationStatus;
  failureKind?: InterpretationFailureKind;
  reason?: string;
  summary?: string;
  observations?: ContextInterpretation['observations'];
  rejectedObservations?: ContextInterpretation['rejectedObservations'];
  provider?: ContextInterpretation['provider'];
  promptStats?: PromptStats;
  injectionIndicators?: readonly string[];
  limitations?: readonly string[];
}

function result(p: Parts): ContextInterpretation {
  return {
    status: p.status,
    schemaVersion: INTERPRETATION_SCHEMA_VERSION,
    ...(p.failureKind ? { failureKind: p.failureKind } : {}),
    ...(p.reason ? { reason: p.reason } : {}),
    ...(p.summary ? { summary: p.summary } : {}),
    observations: p.observations ?? [],
    rejectedObservations: p.rejectedObservations ?? [],
    ...(p.provider ? { provider: p.provider } : {}),
    ...(p.promptStats ? { promptStats: p.promptStats } : {}),
    injectionIndicators: p.injectionIndicators ?? [],
    limitations: [ADVISORY_LIMITATION, ...(p.limitations ?? [])],
    advisoryOnly: true,
  };
}

const safeMessage = (err: unknown): string => maskSecrets(clip(String((err as Error)?.message ?? err).split('\n')[0], 300)).text;

async function callWithTimeout(
  generator: Pick<ContentGenerator, 'generate'>,
  request: Parameters<ContentGenerator['generate']>[0],
  timeoutMs: number,
): Promise<GenerateResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // the shared OpenAI-compatible adapter does not forward the abort signal, so the wait itself is
  // bounded here; an abandoned request is left to finish on its own and its outcome is ignored
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new InterpretationTimeout(`no response within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const call = generator.generate({ ...request, signal: controller.signal });
  call.catch(() => undefined);
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function interpretContext(bundle: EvidenceBundle, opts: InterpretContextOptions): Promise<ContextInterpretation> {
  const provider = { id: opts.providerId, model: opts.model, local: opts.local };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INTERPRETATION_TIMEOUT_MS;

  let context;
  try {
    context = await buildPromptContext(bundle, { ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.includeDiffs !== undefined ? { includeDiffs: opts.includeDiffs } : {}) });
  } catch (err) {
    return result({ status: 'ERROR', failureKind: 'unexpected', reason: `the context for the model could not be prepared: ${safeMessage(err)}` });
  }
  if (context.tooLarge) {
    return result({
      status: 'UNAVAILABLE',
      failureKind: 'input_too_large',
      reason: 'the collected context is too large to send to the model, even after shrinking it. Nothing was sent.',
      injectionIndicators: context.injectionIndicators,
      limitations: context.limitations,
    });
  }

  const systemInstruction = buildSystemInstruction();
  const userText = buildUserMessage(context.data, opts.nonce ?? newNonce());
  const promptStats: PromptStats = { ...context.stats, promptChars: systemInstruction.length + userText.length };
  const base = { provider, promptStats, injectionIndicators: context.injectionIndicators };

  let response: GenerateResponse;
  try {
    response = await callWithTimeout(
      opts.generator,
      {
        model: opts.model,
        systemInstruction,
        messages: [{ role: 'user', parts: [{ kind: 'text', text: userText }] }],
        temperature: 0,
        maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_INTERPRETATION_MAX_OUTPUT_TOKENS,
        // no `tools`: the model cannot call anything
      },
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof InterpretationTimeout) {
      return result({ ...base, status: 'ERROR', failureKind: 'timeout', reason: `the model did not answer in time (${err.message})`, limitations: context.limitations });
    }
    if (err instanceof LocalServerError) {
      return result({ ...base, status: 'UNAVAILABLE', failureKind: 'server_unreachable', reason: safeMessage(err), limitations: context.limitations });
    }
    if (err instanceof ProviderError) {
      return result({ ...base, status: 'ERROR', failureKind: 'provider_error', reason: `provider "${opts.providerId}" failed: ${safeMessage(err)}`, limitations: context.limitations });
    }
    return result({ ...base, status: 'ERROR', failureKind: 'unexpected', reason: `the model call failed: ${safeMessage(err)}`, limitations: context.limitations });
  }

  const parts = response.message?.parts ?? [];
  const text = parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('');
  const limitations = [...context.limitations];
  if (parts.some((p) => p.kind === 'tool_call')) limitations.push('the model tried to call a tool; none were offered and the request was ignored');

  const validated = validateInterpretationResponse(text, context.allowedReferences);
  if (!validated.ok) {
    return result({ ...base, status: 'INVALID_RESPONSE', failureKind: validated.kind, reason: validated.reason, limitations });
  }
  if (validated.rejected.length > 0) {
    limitations.push(`${validated.rejected.length} observation(s) were dropped because they cited evidence that does not exist: ${validated.rejected.map((r) => `#${r.index}`).join(', ')}`);
  }
  return result({
    ...base,
    status: 'COMPLETED',
    ...(validated.summary ? { summary: validated.summary } : {}),
    observations: validated.observations,
    rejectedObservations: validated.rejected,
    limitations,
  });
}

export interface RunInterpretationOptions {
  readonly cwd: string;
  readonly bundle: EvidenceBundle;
  /** explicit authorization to use a provider that is not a local model server; default false */
  readonly allowNonLocalProvider?: boolean;
  readonly deps?: Partial<ProviderSelectionDeps>;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly nonce?: string;
  readonly limits?: Partial<InterpretationLimits>;
  readonly includeDiffs?: boolean;
}

/** Selects the configured provider (local-first, no fallback) and interprets. Never throws. */
export async function runContextInterpretation(opts: RunInterpretationOptions): Promise<ContextInterpretation> {
  try {
    const selection = await selectInterpretationProvider({
      cwd: opts.cwd,
      ...(opts.allowNonLocalProvider !== undefined ? { allowNonLocalProvider: opts.allowNonLocalProvider } : {}),
      ...(opts.deps ? { deps: opts.deps } : {}),
    });
    if (!selection.ok) {
      return result({ status: selection.status, failureKind: selection.failureKind, reason: selection.reason });
    }
    const interpretation = await interpretContext(opts.bundle, {
      generator: selection.generator,
      providerId: selection.providerId,
      model: selection.model,
      local: selection.local,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(opts.includeDiffs !== undefined ? { includeDiffs: opts.includeDiffs } : {}),
    });
    if (selection.authorizedNonLocal) {
      return { ...interpretation, limitations: [...interpretation.limitations, 'a non-local provider was used because it was explicitly authorized: repository context left this machine'] };
    }
    return interpretation;
  } catch (err) {
    return result({ status: 'ERROR', failureKind: 'unexpected', reason: `interpretation failed unexpectedly: ${safeMessage(err)}` });
  }
}
