import {
  listProviders, removeProvider, removeModel, setDefaultModel,
} from '../config/models.js';
import { ConfigError } from '../utils/errors.js';

export async function handleModelsCommand(sub: string, rest: ReadonlyArray<string | number>, flags: Record<string, string | boolean | undefined>): Promise<void> {
  const cwd = process.cwd();
  switch (sub) {
    case 'list': return listCommand(cwd);
    case 'add': return addCommand(cwd);
    case 'remove': return removeCommand(cwd, rest, flags);
    case 'use': return useCommand(cwd, rest, flags);
    case '': printModelsUsage(); break;
    default: console.error(`Unknown models subcommand: ${sub}`); printModelsUsage(); process.exitCode = 2;
  }
}

async function listCommand(cwd: string): Promise<void> {
  try {
    const providers = await listProviders(cwd);
    if (providers.length === 0) {
      console.log('No providers configured.');
      console.log("  Run 'codexrev models add' to add a provider and model.");
      return;
    }
    for (const p of providers) {
      const hasKey = p.apiKey ? '🔑' : '  ';
      console.log(`\n  ${hasKey} ${p.name}  (${p.vendor})${p.baseUrl ? '  ' + p.baseUrl : ''}`);
      if (p.models.length === 0) {
        console.log('    (no models)');
        continue;
      }
      for (const m of p.models) {
        const marker = m.default ? ' ★' : '  ';
        const caps: string[] = [];
        if (m.toolCalling) caps.push('tools');
        if (m.vision) caps.push('vision');
        const capStr = caps.length ? `  [${caps.join(', ')}]` : '';
        const tokens = m.maxInputTokens ? `  ${m.maxInputTokens}in/${m.maxOutputTokens ?? '?'}out` : '';
        console.log(`  ${marker} ${m.id}  (${m.name})${capStr}${tokens}`);
      }
    }
    console.log();
  } catch (err) {
    if (err instanceof ConfigError) { console.error(`Error: ${err.message}`); process.exitCode = 1; } else throw err;
  }
}

async function addCommand(cwd: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('usage: codexrev models add  (interactive wizard, requires TTY)');
    process.exitCode = 2;
    return;
  }
  const { runModelsWizard } = await import('./modelsWizard.js');
  return runModelsWizard(cwd);
}

async function removeCommand(cwd: string, rest: ReadonlyArray<string | number>, flags: Record<string, string | boolean | undefined>): Promise<void> {
  const sub = String(rest[0] ?? '');
  if (sub === 'provider') {
    const name = String(rest[1] ?? '');
    if (!name) { console.error('usage: codexrev models remove provider <name>'); process.exitCode = 2; return; }
    try { await removeProvider(cwd, name); console.log(`✓ Removed provider '${name}'.`); }
    catch (err) { if (err instanceof ConfigError) { console.error(`Error: ${err.message}`); process.exitCode = 1; } else throw err; }
    return;
  }
  if (sub === 'model') {
    const id = String(rest[1] ?? '');
    const provider = flags.provider ? String(flags.provider) : '';
    if (!id || !provider) { console.error('usage: codexrev models remove model <id> --provider <name>'); process.exitCode = 2; return; }
    try { await removeModel(cwd, provider, id); console.log(`✓ Removed model '${id}' from provider '${provider}'.`); }
    catch (err) { if (err instanceof ConfigError) { console.error(`Error: ${err.message}`); process.exitCode = 1; } else throw err; }
    return;
  }
  console.error('usage: codexrev models remove provider <name>');
  console.error('       codexrev models remove model <id> --provider <name>');
  process.exitCode = 2;
}

async function useCommand(cwd: string, rest: ReadonlyArray<string | number>, flags: Record<string, string | boolean | undefined>): Promise<void> {
  const modelId = String(rest[0] ?? '');
  const provider = flags.provider ? String(flags.provider) : '';
  if (!modelId || !provider) {
    console.error('usage: codexrev models use <model-id> --provider <name>');
    console.error("  Run 'codexrev models list' to see available models.");
    process.exitCode = 2;
    return;
  }
  try { await setDefaultModel(cwd, provider, modelId); console.log(`✓ Active model set to '${modelId}' in provider '${provider}'.`); }
  catch (err) { if (err instanceof ConfigError) { console.error(`Error: ${err.message}`); process.exitCode = 1; } else throw err; }
}

function printModelsUsage(): void {
  console.log('usage: codexrev models <subcommand>');
  console.log('');
  console.log('Subcommands:');
  console.log('  list                           List all providers and their models');
  console.log('  add                            Add provider + model (interactive wizard)');
  console.log('  remove provider <name>         Remove a provider');
  console.log('  remove model <id>              Remove a model from a provider');
  console.log('  use <model-id>                 Set a model as the active default');
  console.log('');
  console.log('Options:');
  console.log('  --provider <name>              Provider name (for remove model, use)');
  console.log('');
  console.log('Examples:');
  console.log('  codexrev models add              Launch interactive wizard');
  console.log('  codexrev models use deepseek-v4-pro --provider deepseek');
  console.log('  codexrev models list');
}
