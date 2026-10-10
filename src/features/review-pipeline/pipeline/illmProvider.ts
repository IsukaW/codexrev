// Role files should never import a specific provider adapter directly, they
// go through ILLMProvider so any of the supported providers can be swapped in
// underneath. Thin wrapper over the existing provider factory — doesn't
// reimplement request/streaming, just narrows the shape and lets a caller
// target a different provider than the project's active one (eval code uses
// this to compare a local model against a cloud one on the same diff).

import type {
  GenerateRequest,
  GenerateResponse,
  ProviderId,
  StreamEvent,
} from '../../../core/types.js';
import type { Settings } from '../../../config/schema.js';
import { buildProvider } from '../../../providers/index.js';

export interface ILLMProvider {
  readonly id: ProviderId;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
}

// binds to settings.provider by default, or providerId if given, without mutating settings
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
