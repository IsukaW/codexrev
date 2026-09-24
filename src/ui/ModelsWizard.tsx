// `models add` wizard — adds a provider+model or a model on an existing provider.
// Skips the provider/vendor/base-url/key steps entirely when reusing an existing one.

import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { ProviderConfigEntry } from '../config/projectSchema.js';

export type VendorType = ProviderConfigEntry['vendor'];

export interface ModelWizardResult {
  // unset means "add to existing provider"
  newProvider?: {
    name: string;
    vendor: VendorType;
    baseUrl?: string;
    apiKey?: string;
  };
  // set when adding a model to an existing provider instead
  existingProvider?: string;
  model: {
    id: string;
    name: string;
    url?: string;
    toolCalling: boolean;
    vision: boolean;
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
}

export interface ModelsWizardProps {
  existingProviders: ProviderConfigEntry[];
  onSubmit: (result: ModelWizardResult) => void;
  onCancel: () => void;
}

const VENDOR_CHOICES: Array<{ label: string; value: VendorType }> = [
  { label: 'openai — OpenAI', value: 'openai' },
  { label: 'anthropic — Anthropic', value: 'anthropic' },
  { label: 'google — Google Gemini', value: 'google' },
  { label: 'ollama — Ollama (local)', value: 'ollama' },
  { label: 'lmstudio — LM Studio (local)', value: 'lmstudio' },
  { label: 'litellm — LiteLLM', value: 'litellm' },
  { label: 'deepseek — DeepSeek', value: 'deepseek' },
  { label: 'customendpoint — Custom OpenAI-compatible', value: 'customendpoint' },
];

const LOCAL_VENDORS: VendorType[] = ['ollama', 'lmstudio', 'litellm'];
const VENDOR_LABELS: Record<VendorType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  litellm: 'LiteLLM',
  deepseek: 'DeepSeek',
  customendpoint: 'Custom Endpoint',
};

type Step =
  | 'mode'
  | 'existingPicker'
  | 'providerName'
  | 'vendor'
  | 'baseUrl'
  | 'apiKey'
  | 'modelId'
  | 'modelName'
  | 'toolCalling'
  | 'vision'
  | 'maxInputTokens'
  | 'maxOutputTokens'
  | 'modelUrl'
  | 'confirm'
  | 'continue';

export const ModelsWizard: React.FC<ModelsWizardProps> = (props) => {
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<'new' | 'existing'>('new');

  // fields below only matter when mode === 'new'
  const [providerName, setProviderName] = useState('');
  const [vendor, setVendor] = useState<VendorType>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [existingName, setExistingName] = useState('');

  const [modelId, setModelId] = useState('');
  const [modelName, setModelName] = useState('');
  const [toolCalling, setToolCalling] = useState(false);
  const [toolCallingInput, setToolCallingInput] = useState('');
  const [vision, setVision] = useState(false);
  const [visionInput, setVisionInput] = useState('');
  const [maxInputTokens, setMaxInputTokens] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [modelUrl, setModelUrl] = useState('');
  const [continueInput, setContinueInput] = useState('');

  const [error, setError] = useState('');

  const { exit } = useApp();
  void exit;

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
    } else if (key.tab && step === 'apiKey') {
      setShowKey((v) => !v);
    } else if (key.ctrl && input === 'c') {
      props.onCancel();
    }
  });

  const existingChoices = props.existingProviders.map((p) => ({
    label: `${p.name}  (${VENDOR_LABELS[p.vendor]})  ${p.models.length} model(s)`,
    value: p.name,
  }));

  function submit() {
    const result: ModelWizardResult = {
      model: {
        id: modelId.trim(),
        name: modelName.trim() || modelId.trim(),
        url: modelUrl.trim() || undefined,
        toolCalling,
        vision,
        maxInputTokens: maxInputTokens.trim() ? parseInt(maxInputTokens.trim(), 10) : undefined,
        maxOutputTokens: maxOutputTokens.trim() ? parseInt(maxOutputTokens.trim(), 10) : undefined,
      },
    };
    if (mode === 'new') {
      result.newProvider = {
        name: providerName.trim(),
        vendor,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      };
    } else {
      result.existingProvider = existingName;
    }
    props.onSubmit(result);
  }

  const dim = (s: string) => <Text dimColor>{s}</Text>;
  const label = (s: string) => <Text bold color="cyan">{s}</Text>;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">codexrev models add</Text>
        <Text dimColor> — add a provider and/or model interactively.</Text>
      </Box>

      {step === 'mode' && (
        <Box flexDirection="column">
          <Text>What do you want to do?</Text>
          <SelectInput
            items={[
              { label: 'Add new provider (+ first model)', value: 'new' },
              { label: 'Add model to existing provider', value: 'existing' },
            ]}
            onSelect={(item) => {
              setMode(item.value as 'new' | 'existing');
              if (item.value === 'existing') {
                if (props.existingProviders.length === 0) {
                  setError('No providers configured. Add a new provider first.');
                  return;
                }
                setStep('existingPicker');
              } else {
                setStep('providerName');
              }
            }}
          />
          {error && <Text color="red">{error}</Text>}
        </Box>
      )}

      {step === 'existingPicker' && (
        <Box flexDirection="column">
          <Text>Select provider:</Text>
          <SelectInput
            items={existingChoices}
            onSelect={(item) => {
              setExistingName(item.value);
              setStep('modelId');
            }}
          />
        </Box>
      )}

      {step === 'providerName' && (
        <Box flexDirection="column">
          <Text>Provider name:</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={providerName}
              onChange={(v) => { setProviderName(v); setError(''); }}
              onSubmit={(v) => {
                const name = v.trim();
                if (!name) { setError('Provider name cannot be empty.'); return; }
                if (props.existingProviders.some((p) => p.name === name)) {
                  setError(`Provider '${name}' already exists. Use "Add model to existing" instead.`);
                  return;
                }
                setProviderName(name);
                setStep('vendor');
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
          {dim('e.g. minimax, deepseek-team, my-ollama')}
        </Box>
      )}

      {step === 'vendor' && (
        <Box flexDirection="column">
          <Text>
            Select vendor for <Text color="cyan">{providerName}</Text>:
          </Text>
          <SelectInput
            items={VENDOR_CHOICES}
            onSelect={(item) => {
              setVendor(item.value);
              if (LOCAL_VENDORS.includes(item.value)) {
                setStep('modelId'); // skip URL + API key for local
              } else {
                setStep('baseUrl');
              }
            }}
          />
        </Box>
      )}

      {step === 'baseUrl' && (
        <Box flexDirection="column">
          <Text>
            Base URL{vendor === 'customendpoint' ? ' (required)' : ' (optional — Enter to skip)'}:
          </Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={baseUrl}
              onChange={(v) => { setBaseUrl(v); setError(''); }}
              onSubmit={(v) => {
                if (vendor === 'customendpoint' && !v.trim()) {
                  setError('Custom endpoint requires a base URL.');
                  return;
                }
                setBaseUrl(v.trim());
                setStep('apiKey');
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
          {dim('e.g. https://api.minimax.chat/v1, https://api.deepseek.com/v1')}
        </Box>
      )}

      {step === 'apiKey' && (
        <Box flexDirection="column">
          <Text>API key (optional — Enter to skip):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            {showKey ? (
              <TextInput value={apiKey} onChange={setApiKey} onSubmit={() => setStep('modelId')} />
            ) : (
              <TextInput value={apiKey} onChange={setApiKey} onSubmit={() => setStep('modelId')} mask="*" />
            )}
          </Box>
          <Text dimColor>press Tab to {showKey ? 'hide' : 'show'} the key</Text>
        </Box>
      )}

      {step === 'modelId' && (
        <Box flexDirection="column">
          <Text>
            {mode === 'new'
              ? <>Add first model to <Text color="cyan">{providerName}</Text></>
              : <>Add model to <Text color="cyan">{existingName}</Text></>}
          </Text>
          <Text>Model ID:</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={modelId}
              onChange={(v) => { setModelId(v); setError(''); }}
              onSubmit={(v) => {
                if (!v.trim()) { setError('Model ID cannot be empty.'); return; }
                setModelId(v.trim());
                setModelName(v.trim());
                setStep('modelName');
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
          {dim('e.g. gpt-4o, claude-sonnet-4-20250514, MiniMax-M3, llama3.1')}
        </Box>
      )}

      {step === 'modelName' && (
        <Box flexDirection="column">
          <Text>Display name (Enter to use &quot;{modelId}&quot;):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={modelName}
              onChange={setModelName}
              onSubmit={(v) => {
                setModelName(v.trim() || modelId);
                setStep('toolCalling');
              }}
            />
          </Box>
        </Box>
      )}

      {step === 'toolCalling' && (
        <Box flexDirection="column">
          <Text>Supports tool/function calling? (y/N):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={toolCallingInput}
              onChange={setToolCallingInput}
              onSubmit={(v) => {
                setToolCalling(v.trim().toLowerCase() === 'y' || v.trim().toLowerCase() === 'yes');
                setStep('vision');
              }}
            />
          </Box>
          {dim('y = yes, Enter = no')}
        </Box>
      )}

      {step === 'vision' && (
        <Box flexDirection="column">
          <Text>Supports vision/image input? (y/N):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={visionInput}
              onChange={setVisionInput}
              onSubmit={(v) => {
                setVision(v.trim().toLowerCase() === 'y' || v.trim().toLowerCase() === 'yes');
                setStep('maxInputTokens');
              }}
            />
          </Box>
          {dim('y = yes, Enter = no')}
        </Box>
      )}

      {step === 'maxInputTokens' && (
        <Box flexDirection="column">
          <Text>Max input tokens (Enter to skip):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={maxInputTokens}
              onChange={setMaxInputTokens}
              onSubmit={(v) => {
                if (v.trim() && isNaN(parseInt(v.trim(), 10))) {
                  setError('Please enter a number.');
                  return;
                }
                setMaxInputTokens(v.trim());
                setStep('maxOutputTokens');
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
          {dim('e.g. 128000, 200000')}
        </Box>
      )}

      {step === 'maxOutputTokens' && (
        <Box flexDirection="column">
          <Text>Max output tokens (Enter to skip):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={maxOutputTokens}
              onChange={setMaxOutputTokens}
              onSubmit={(v) => {
                if (v.trim() && isNaN(parseInt(v.trim(), 10))) {
                  setError('Please enter a number.');
                  return;
                }
                setMaxOutputTokens(v.trim());
                setStep('modelUrl');
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
        </Box>
      )}

      {step === 'modelUrl' && (
        <Box flexDirection="column">
          <Text>Model-specific URL (Enter to skip):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={modelUrl}
              onChange={setModelUrl}
              onSubmit={() => setStep('confirm')}
            />
          </Box>
          {dim('Override the provider base URL for this model only.')}
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column">
          <Text bold>Review:</Text>
          <Box marginLeft={2} flexDirection="column" marginTop={1}>
            {mode === 'new' ? (
              <>
                <Text>
                  Provider: <Text color="cyan">{providerName}</Text>
                  {' '}({VENDOR_LABELS[vendor]})
                  {baseUrl ? <> → <Text color="yellow">{baseUrl}</Text></> : ''}
                </Text>
                {apiKey && (
                  <Text>
                    API key: <Text color="cyan">{showKey ? apiKey : '•'.repeat(Math.min(apiKey.length, 20))}</Text>
                  </Text>
                )}
              </>
            ) : (
              <Text>
                Provider: <Text color="cyan">{existingName}</Text>
                {' '}(existing — API key unchanged)
              </Text>
            )}
            <Box marginTop={1}>
              <Text>
                Model: <Text color="cyan">{modelName || modelId}</Text>
                {' '}({modelId})
              </Text>
            </Box>
            <Text>
              {toolCalling ? '  [tools]' : ''}{vision ? ' [vision]' : ''}
              {maxInputTokens ? `  ${maxInputTokens}in/` : ''}{maxOutputTokens ? `${maxOutputTokens}out` : ''}
              {!toolCalling && !vision && !maxInputTokens ? '  (no capabilities set)' : ''}
            </Text>
            {modelUrl && <Text>URL: <Text color="yellow">{modelUrl}</Text></Text>}
          </Box>
          <Box marginTop={1}>
            <Text>Press Enter to save, Esc to cancel.</Text>
            <Box marginTop={1}>
              <TextInput value="" onChange={() => {}} onSubmit={submit} />
            </Box>
          </Box>
        </Box>
      )}

      {step === 'continue' && (
        <Box flexDirection="column">
          <Text color="green">✓ Saved!</Text>
          <Text>Add another model to this provider? (y/N):</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={continueInput}
              onChange={setContinueInput}
              onSubmit={(v) => {
                if (v.trim().toLowerCase() === 'y' || v.trim().toLowerCase() === 'yes') {
                  setModelId('');
                  setModelName('');
                  setToolCalling(false);
                  setToolCallingInput('');
                  setVision(false);
                  setVisionInput('');
                  setMaxInputTokens('');
                  setMaxOutputTokens('');
                  setModelUrl('');
                  setContinueInput('');
                  setError('');
                  setStep('modelId');
                } else {
                  // submit already fired, nothing to do here unless the component stays mounted
                }
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
};
