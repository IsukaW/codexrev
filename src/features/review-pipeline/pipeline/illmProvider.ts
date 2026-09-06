/**
 * Codexrev — Feature 2 provider-agnostic LLM wrapper.
 *
 * Role code (`roles/ba.ts`, `roles/dev.ts`, etc.) must never import a
 * specific adapter (`../providers/openai.js` and friends) directly — it
 * calls through `ILLMProvider` instead, so the six required providers
 * (OpenAI, Anthropic, Google, LiteLLM, Ollama, LM Studio, DeepSeek —
 * behind the shared `ContentGenerator` interface) stay fully
 * interchangeable per the proposal's Task 2.
 *
 * This is a thin wrapper over the existing provider factory
 * (`../../../providers/index.js`) — it does not reimplement request/
 * streaming logic, it just narrows `ContentGenerator` to the shape roles
 * need and lets the caller target a provider other than the project's
 * currently-active one (used by Phase 10 evaluation to compare a local
 * model against a cloud one on the same diff).
 */

import type {
  GenerateRequest,
  GenerateResponse,
  ProviderId,
  StreamEvent,
} from '../../../core/types.js';
import type { Settings } from '../../../config/schema.js';
import { buildProvider } from '../../../providers/index.js';

/** The interface every review-pipeline role calls against. */
export interface ILLMProvider {
  readonly id: ProviderId;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
}

/**
 * Build an `ILLMProvider` bound to `settings.provider`, or to
 * `providerId` when given (e.g. to run one role against a different
 * provider than the project default, without mutating `settings`).
 */
export function createLLMProvider(settings: Settings, providerId?: ProviderId): ILLMProvider {
  const target = providerId ?? settings.provider;
  const effectiveSettings: Settings =
    target === settings.provider ? settings : { ...settings, provider: target };
  const generator = buildProvider(effectiveSettings);
  return {
    id: generator.provider,
    generate: (req) => generator.generate(req),
    stream: (req) => generator.stream(req),
  };
}
