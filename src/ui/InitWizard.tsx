// `init` wizard — walks through provider, model, api key, base url, capabilities,
// token limits, then a confirm screen. Enter to advance, Esc to bail out.

import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { ProviderId } from '../core/types.js';
import { DEFAULT_LOCAL_TIMEOUT_MS, PROVIDER_REGISTRY } from '../providers/registry.js';

export interface InitWizardAnswers {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface InitWizardProps {
  initialProvider?: ProviderId;
  initialModel?: string;
  initialApiKey?: string;
  initialBaseUrl?: string;
  defaultModelFor: (p: ProviderId) => string;
  onSubmit: (answers: InitWizardAnswers) => void;
  onCancel: () => void;
}

type Step =
  | 'provider'
  | 'model'
  | 'apiKey'
  | 'baseUrl'
  | 'toolCalling'
  | 'vision'
  | 'maxInputTokens'
  | 'maxOutputTokens'
  | 'confirm';

const PROVIDER_CHOICES: Array<{ label: string; value: ProviderId }> = Object.values(
  PROVIDER_REGISTRY,
).map((meta) => ({ label: `${meta.id} — ${meta.label}`, value: meta.id }));

// parses a y/N reply, blank means keep the fallback
function parseYesNo(raw: string, fallback: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return fallback;
  return v === 'y' || v === 'yes';
}

export const InitWizard: React.FC<InitWizardProps> = (props) => {
  const [step, setStep] = useState<Step>(props.initialProvider ? 'model' : 'provider');
  const [provider, setProvider] = useState<ProviderId | undefined>(props.initialProvider);
  const [model, setModel] = useState<string>(props.initialModel ?? '');
  const [apiKey, setApiKey] = useState<string>(props.initialApiKey ?? '');
  const [baseUrl, setBaseUrl] = useState<string>(props.initialBaseUrl ?? '');
  const [showKey, setShowKey] = useState(false);

  // toolCalling starts at whatever the registry says this provider supports; vision just defaults off
  const [toolCalling, setToolCalling] = useState<boolean>(
    props.initialProvider ? PROVIDER_REGISTRY[props.initialProvider].supportsTools : true,
  );
  const [toolCallingInput, setToolCallingInput] = useState('');
  const [vision, setVision] = useState(false);
  const [visionInput, setVisionInput] = useState('');
  const [maxInputTokens, setMaxInputTokens] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [error, setError] = useState('');

  const { exit } = useApp();

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
    } else if (key.tab) {
      if (step === 'apiKey') setShowKey((v) => !v);
    } else if (key.ctrl && input === 'c') {
      props.onCancel();
    }
  });
  void exit; // keep the import used, might need it for a hard-abort path later

  const toolDefault = provider ? PROVIDER_REGISTRY[provider].supportsTools : true;

  function submit() {
    if (!provider) return;
    const meta = PROVIDER_REGISTRY[provider];
    // local providers don't need a real key, fall back to the provider id so we still have something to encrypt
    const resolvedKey =
      apiKey.trim() || (meta.requiresApiKey ? '' : meta.id);
    props.onSubmit({
      provider,
      model: model.trim(),
      apiKey: resolvedKey,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      toolCalling,
      vision,
      ...(maxInputTokens.trim() ? { maxInputTokens: parseInt(maxInputTokens.trim(), 10) } : {}),
      ...(maxOutputTokens.trim() ? { maxOutputTokens: parseInt(maxOutputTokens.trim(), 10) } : {}),
    });
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          codexrev init
        </Text>
        <Text dimColor> — create ./codexrev/config.json with an encrypted API key.</Text>
      </Box>

      {step === 'provider' && (
        <Box flexDirection="column">
          <Text>Select a provider:</Text>
          <SelectInput
            items={PROVIDER_CHOICES}
            onSelect={(item) => {
              setProvider(item.value);
              if (!model) setModel(props.defaultModelFor(item.value));
              setToolCalling(PROVIDER_REGISTRY[item.value].supportsTools);
              setStep('model');
            }}
          />
        </Box>
      )}

      {step === 'model' && provider && (
        <Box flexDirection="column">
          <Text>
            Provider: <Text color="cyan">{provider}</Text>
          </Text>
          <Text>Model name (press Enter to accept):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={model}
              onChange={setModel}
              onSubmit={(v) => {
                const next = v.trim() || props.defaultModelFor(provider);
                setModel(next);
                setStep('apiKey');
              }}
            />
          </Box>
          <Text dimColor>default: {props.defaultModelFor(provider)}</Text>
        </Box>
      )}

      {step === 'apiKey' && provider && (
        <Box flexDirection="column">
          <Text>
            API key for {provider}
            {PROVIDER_REGISTRY[provider].requiresApiKey ? ':' : ' (optional — Enter to skip):'}
          </Text>
          <Box>
            <Text color="green">{'> '}</Text>
            {showKey || !PROVIDER_REGISTRY[provider].requiresApiKey ? (
              <TextInput value={apiKey} onChange={setApiKey} onSubmit={() => setStep('baseUrl')} />
            ) : (
              <TextInput
                value={apiKey}
                onChange={setApiKey}
                onSubmit={() => setStep('baseUrl')}
                mask="*"
              />
            )}
          </Box>
          {PROVIDER_REGISTRY[provider].requiresApiKey ? (
            <Text dimColor>
              press Tab to {showKey ? 'hide' : 'show'} the key (you can also submit while masked)
            </Text>
          ) : (
            <Text dimColor>
              Local servers don&apos;t need an API key — any value will be accepted.
            </Text>
          )}
        </Box>
      )}

      {step === 'baseUrl' && provider && (
        <Box flexDirection="column">
          <Text>Base URL (optional — Enter to skip):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput value={baseUrl} onChange={setBaseUrl} onSubmit={() => setStep('toolCalling')} />
          </Box>
          <Text dimColor>
            e.g. http://localhost:11434/v1 for ollama, http://localhost:1234/v1 for lm studio, http://localhost:4000 for litellm
          </Text>
        </Box>
      )}

      {step === 'toolCalling' && provider && (
        <Box flexDirection="column">
          <Text>Does this model support tool/function calling? (Y/n):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={toolCallingInput}
              onChange={setToolCallingInput}
              onSubmit={(v) => {
                setToolCalling(parseYesNo(v, toolDefault));
                setToolCallingInput('');
                setStep('vision');
              }}
            />
          </Box>
          <Text dimColor>default: {toolDefault ? 'yes' : 'no'} (Enter to accept)</Text>
        </Box>
      )}

      {step === 'vision' && provider && (
        <Box flexDirection="column">
          <Text>Does this model support vision/image input? (y/N):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={visionInput}
              onChange={setVisionInput}
              onSubmit={(v) => {
                setVision(parseYesNo(v, false));
                setVisionInput('');
                setStep('maxInputTokens');
              }}
            />
          </Box>
          <Text dimColor>default: no (Enter to accept)</Text>
        </Box>
      )}

      {step === 'maxInputTokens' && provider && (
        <Box flexDirection="column">
          <Text>Max input tokens / context window (Enter to skip):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={maxInputTokens}
              onChange={(v) => { setMaxInputTokens(v); setError(''); }}
              onSubmit={(v) => {
                if (v.trim() && !Number.isFinite(parseInt(v.trim(), 10))) {
                  setError('Please enter a number.');
                  return;
                }
                setMaxInputTokens(v.trim());
                setStep('maxOutputTokens');
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
          <Text dimColor>e.g. 128000, 200000</Text>
        </Box>
      )}

      {step === 'maxOutputTokens' && provider && (
        <Box flexDirection="column">
          <Text>Max output tokens (Enter to skip):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={maxOutputTokens}
              onChange={(v) => { setMaxOutputTokens(v); setError(''); }}
              onSubmit={(v) => {
                if (v.trim() && !Number.isFinite(parseInt(v.trim(), 10))) {
                  setError('Please enter a number.');
                  return;
                }
                setMaxOutputTokens(v.trim());
                setStep('confirm');
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
          <Text dimColor>e.g. 4096, 8192</Text>
        </Box>
      )}

      {step === 'confirm' && provider && (
        <Box flexDirection="column">
          <Text>Review:</Text>
          <Box marginLeft={2} flexDirection="column">
            <Text>
              provider: <Text color="cyan">{provider}</Text>
            </Text>
            <Text>
              model: <Text color="cyan">{model}</Text>
            </Text>
            <Text>
              baseUrl: <Text color="cyan">{baseUrl.trim() || '(default)'}</Text>
            </Text>
            <Text>
              apiKey: <Text color="cyan">{showKey ? apiKey : '•'.repeat(Math.min(apiKey.length, 24))}</Text>
            </Text>
            <Text>
              tool calling: <Text color="cyan">{toolCalling ? 'yes' : 'no'}</Text>
            </Text>
            <Text>
              vision: <Text color="cyan">{vision ? 'yes' : 'no'}</Text>
            </Text>
            <Text>
              tokens: <Text color="cyan">
                {maxInputTokens.trim() || '(default)'} in / {maxOutputTokens.trim() || '(default)'} out
              </Text>
            </Text>
            {!PROVIDER_REGISTRY[provider].requiresApiKey && (
              <Text dimColor>
                (local provider — request timeout auto-set to {DEFAULT_LOCAL_TIMEOUT_MS / 60_000} min)
              </Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text>Press Enter to write the encrypted config, Esc to cancel.</Text>
            <Box marginTop={1}>
              <TextInput value="" onChange={() => {}} onSubmit={submit} />
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              (use --non-interactive --provider … --api-key … to skip this wizard)
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
