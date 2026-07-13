# Quota & pricing

Codexrev is the orchestrator only — usage costs are billed by the LLM provider. Prices change; always check the provider's official page.

## Provider shortcuts (links)

- OpenAI pricing: <https://openai.com/pricing>
- Anthropic pricing: <https://www.anthropic.com/pricing>
- Google Gemini pricing: <https://ai.google.dev/pricing>
- OpenRouter (LiteLLM-compatible proxy): <https://openrouter.ai/docs#pricing>

## Token accounting

The agent emits a `usage` event on every turn with `inputTokens` / `outputTokens` / `totalTokens`. In `--output-format json` mode the final `AgentResult` summarises the entire run.

For tighter control, set `maxTokens` per turn via settings (provider-specific):

```jsonc
{
  "maxTokens": 4096
}
```

## Rate limits

Provider-side rate limits are not enforced by Codexrev. If you hit one, the provider surfaces a 429 in `ProviderError`. Back off and retry, or upgrade your tier at the provider.
