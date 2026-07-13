/**
 * Codexrev — `init` subcommand interactive wizard.
 *
 * Five screens, navigated with Enter / Esc:
 *   1. Provider   (select)
 *   2. Model      (text input, prefilled)
 *   3. API key    (masked text input with "show" toggle)
 *   4. Base URL   (optional, text input)
 *   5. Confirm    (review + submit)
 */

import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { ProviderId } from '../core/types.js';

export interface InitWizardProps {
  initialProvider?: ProviderId;
  initialModel?: string;
  initialApiKey?: string;
  initialBaseUrl?: string;
  defaultModelFor: (p: ProviderId) => string;
  onSubmit: (answers: {
    provider: ProviderId;
    model: string;
    apiKey: string;
    baseUrl?: string;
  }) => void;
  onCancel: () => void;
}

type Step = 'provider' | 'model' | 'apiKey' | 'baseUrl' | 'confirm';

const PROVIDER_CHOICES: Array<{ label: string; value: ProviderId }> = [
  { label: 'openai', value: 'openai' },
  { label: 'anthropic', value: 'anthropic' },
  { label: 'google', value: 'google' },
  { label: 'litellm', value: 'litellm' },
];

export const InitWizard: React.FC<InitWizardProps> = (props) => {
  const [step, setStep] = useState<Step>(props.initialProvider ? 'model' : 'provider');
  const [provider, setProvider] = useState<ProviderId | undefined>(props.initialProvider);
  const [model, setModel] = useState<string>(props.initialModel ?? '');
  const [apiKey, setApiKey] = useState<string>(props.initialApiKey ?? '');
  const [baseUrl, setBaseUrl] = useState<string>(props.initialBaseUrl ?? '');
  const [showKey, setShowKey] = useState(false);

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
  // unused-but-imported: keep `exit` reachable for future abort UX
  void exit;

  function submit() {
    if (!provider) return;
    props.onSubmit({
      provider,
      model: model.trim(),
      apiKey: apiKey.trim(),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
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

      {step === 'apiKey' && (
        <Box flexDirection="column">
          <Text>API key for {provider}:</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            {showKey ? (
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
          <Text dimColor>
            press Tab to {showKey ? 'hide' : 'show'} the key (you can also submit while masked)
          </Text>
        </Box>
      )}

      {step === 'baseUrl' && (
        <Box flexDirection="column">
          <Text>Base URL (optional — Enter to skip):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput value={baseUrl} onChange={setBaseUrl} onSubmit={() => setStep('confirm')} />
          </Box>
          <Text dimColor>e.g. http://localhost:4000 for litellm</Text>
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