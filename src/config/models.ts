import { loadProjectConfig, saveProjectConfig, nowIso } from './projectConfig.js';
import type { ModelConfig, ProviderConfigEntry, ProjectConfig } from './projectSchema.js';
import { ConfigError } from '../utils/errors.js';

export type { ModelConfig, ProviderConfigEntry };

export async function listProviders(cwd: string): Promise<ProviderConfigEntry[]> {
  const cfg = await requireConfig(cwd);
  return cfg.providers ?? [];
}

export async function addProvider(
  cwd: string,
  entry: { name: string; vendor: ProviderConfigEntry['vendor']; baseUrl?: string; apiType?: ProviderConfigEntry['apiType'] },
): Promise<ProviderConfigEntry> {
  const cfg = await requireConfig(cwd);
  const providers = cfg.providers ? [...cfg.providers] : [];
  if (providers.some((p) => p.name === entry.name)) {
    throw new ConfigError(`Provider '${entry.name}' already exists.`);
  }
  const newEntry: ProviderConfigEntry = {
    name: entry.name,
    vendor: entry.vendor,
    baseUrl: entry.baseUrl,
    apiType: entry.apiType,
    models: [],
  };
  providers.push(newEntry);
  await saveProjectConfig(cwd, { ...cfg, providers, updatedAt: nowIso() });
  return newEntry;
}

export async function removeProvider(cwd: string, name: string): Promise<void> {
  const cfg = await requireConfig(cwd);
  const providers = cfg.providers ? [...cfg.providers] : [];
  const idx = providers.findIndex((p) => p.name === name);
  if (idx === -1) throw new ConfigError(`Provider '${name}' not found.`);
  providers.splice(idx, 1);
  await saveProjectConfig(cwd, { ...cfg, providers, updatedAt: nowIso() });
}

export async function setProviderApiKey(cwd: string, name: string, apiKey: string, dek: Buffer): Promise<void> {
  const cfg = await requireConfig(cwd);
  const providers = cfg.providers ? [...cfg.providers] : [];
  const provider = providers.find((p) => p.name === name);
  if (!provider) throw new ConfigError(`Provider '${name}' not found.`);
  const { encrypt } = await import('../security/secrets.js');
  provider.apiKey = encrypt(apiKey, dek);
  await saveProjectConfig(cwd, { ...cfg, providers, updatedAt: nowIso() });
}

export async function addModel(
  cwd: string,
  providerName: string,
  model: { id: string; name: string; url?: string; toolCalling?: boolean; vision?: boolean; maxInputTokens?: number; maxOutputTokens?: number },
): Promise<ModelConfig> {
  const cfg = await requireConfig(cwd);
  const providers = cfg.providers ? [...cfg.providers] : [];
  const provider = providers.find((p) => p.name === providerName);
  if (!provider) throw new ConfigError(`Provider '${providerName}' not found. Run 'codexrev models list'.`);
  if (provider.models.some((m) => m.id === model.id)) {
    throw new ConfigError(`Model '${model.id}' already exists in provider '${providerName}'.`);
  }
  const isFirst = provider.models.length === 0;
  const newModel: ModelConfig = { ...model, default: isFirst };
  provider.models.push(newModel);
  await saveProjectConfig(cwd, { ...cfg, providers, updatedAt: nowIso() });
  return newModel;
}

export async function removeModel(cwd: string, providerName: string, modelId: string): Promise<void> {
  const cfg = await requireConfig(cwd);
  const providers = cfg.providers ? [...cfg.providers] : [];
  const provider = providers.find((p) => p.name === providerName);
  if (!provider) throw new ConfigError(`Provider '${providerName}' not found.`);
  const idx = provider.models.findIndex((m) => m.id === modelId);
  if (idx === -1) throw new ConfigError(`Model '${modelId}' not found in provider '${providerName}'.`);
  const removed = provider.models.splice(idx, 1)[0];
  if (removed.default && provider.models.length > 0) provider.models[0].default = true;
  await saveProjectConfig(cwd, { ...cfg, providers, updatedAt: nowIso() });
}

export async function setDefaultModel(cwd: string, providerName: string, modelId: string): Promise<void> {
  const cfg = await requireConfig(cwd);
  const providers = cfg.providers ? [...cfg.providers] : [];
  const provider = providers.find((p) => p.name === providerName);
  if (!provider) throw new ConfigError(`Provider '${providerName}' not found.`);
  const target = provider.models.find((m) => m.id === modelId);
  if (!target) throw new ConfigError(`Model '${modelId}' not found in provider '${providerName}'.`);
  for (const m of provider.models) m.default = m.id === modelId;
  await saveProjectConfig(cwd, { ...cfg, providers, updatedAt: nowIso() });
}

export function getActiveModel(providers: ProviderConfigEntry[]): { provider: ProviderConfigEntry; model: ModelConfig } | undefined {
  for (const p of providers) {
    const active = p.models.find((m) => m.default);
    if (active) return { provider: p, model: active };
  }
  return undefined;
}

export function findModelById(providers: ProviderConfigEntry[], modelId: string): { provider: ProviderConfigEntry; model: ModelConfig } | undefined {
  for (const p of providers) {
    const m = p.models.find((m) => m.id === modelId);
    if (m) return { provider: p, model: m };
  }
  return undefined;
}

async function requireConfig(cwd: string): Promise<ProjectConfig> {
  const cfg = await loadProjectConfig(cwd);
  if (!cfg) throw new ConfigError('No project config found. Run `codexrev init` first.');
  return cfg;
}
