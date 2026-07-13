/**
 * Codexrev — environment helpers.
 *
 * Centralises every read of `process.env` so the rest of the codebase
 * can be unit-tested in isolation.
 */

export const ENV = {
  provider: () => (process.env.CODEXREV_PROVIDER ?? 'openai').toLowerCase(),
  model: () => process.env.CODEXREV_MODEL ?? defaultModelFor(ENV.provider()),
  openaiApiKey: () => process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: () => process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY ?? '',
  anthropicBaseUrl: () => process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
  googleApiKey: () => process.env.GOOGLE_API_KEY ?? '',
  googleUseVertex: () => process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true',
  litellmApiKey: () => process.env.LITELLM_API_KEY ?? '',
  litellmBaseUrl: () => process.env.LITELLM_BASE_URL ?? 'http://localhost:4000',
  home: () => process.env.CODEXREV_HOME ?? '~/.codexrev',
  sandbox: () => (process.env.CODEXREV_SANDBOX ?? 'auto').toLowerCase(),
  telemetry: () => process.env.CODEXREV_TELEMETRY === 'true',
  theme: () => process.env.CODEXREV_THEME ?? 'dark',
  logLevel: () => (process.env.CODEXREV_LOG_LEVEL ?? 'info').toLowerCase(),
  noUpdate: () => process.env.CODEXREV_NO_UPDATE === '1',
};

function defaultModelFor(p: string): string {
  switch (p) {
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022';
    case 'google':
      return 'gemini-1.5-pro';
    case 'litellm':
      return 'gpt-4o';
    default:
      return 'gpt-4o';
  }
}
