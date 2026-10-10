import {
  listProviders, removeProvider, removeModel, setDefaultModel, setProviderApiKey, getActiveModel,
} from '../config/models.js';
import { loadProjectConfig } from '../config/projectConfig.js';
import { ConfigError } from '../utils/errors.js';

export async function handleModelsCommand(sub: string, rest: ReadonlyArray<string | number>, flags: Record<string, string | boolean | undefined>): Promise<void> {
  const cwd = process.cwd();
  switch (sub) {
    case 'list': return listCommand(cwd);
    case 'add': return addCommand(cwd);
    case 'remove': return removeCommand(cwd, rest, flags);
    case 'use': return useCommand(cwd, rest, flags);
    case 'key': return keyCommand(cwd, rest, flags);
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
    // Back-compat: a config written before per-provider keys may still
    // carry the key only at the top level for the named provider.
    const projectCfg = await loadProjectConfig(cwd).catch(() => null);
    const legacyKeyedProvider = projectCfg?.apiKey ? projectCfg.provider : undefined;
    const active = getActiveModel(providers);
    for (const p of providers) {
      const hasKey = p.apiKey || p.name === legacyKeyedProvider ? '🔑' : '  ';
      console.log(`\n  ${hasKey} ${p.name}  (${p.vendor})${p.baseUrl ? '  ' + p.baseUrl : ''}`);
      if (p.models.length === 0) {
        console.log('    (no models)');
        continue;
      }
      for (const m of p.models) {
        const marker = active && active.provider.name === p.name && active.model.id === m.id ? ' ★' : '  ';
        const caps: string[] = [];
        if (m.toolCalling) caps.push('tools');
        if (m.vision) caps.push('vision');
        const capStr = caps.length ? `  [${caps.join(', ')}]` : '';
        const tokens = m.maxInputTokens ? `  ${m.maxInputTokens}in/${m.maxOutputTokens ?? '?'}out` : '';
        const timeout = m.timeoutMs ? `  timeout:${Math.round(m.timeoutMs / 60_000)}min` : '';
        console.log(`  ${marker} ${m.id}  (${m.name})${capStr}${tokens}${timeout}`);
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
  try { await setDefaultModel(cwd, provider, modelId); console.log(`✓ Active model set to '${modelId}' (provider '${provider}').`); }
  catch (err) { if (err instanceof ConfigError) { console.error(`Error: ${err.message}`); process.exitCode = 1; } else throw err; }
}

async function keyCommand(cwd: string, rest: ReadonlyArray<string | number>, flags: Record<string, string | boolean | undefined>): Promise<void> {
  const provider = String(rest[0] ?? flags.provider ?? '');
  if (!provider) {
    console.error('usage: codexrev models key <provider> [--api-key <key>]');
    process.exitCode = 2;
    return;
  }
  let apiKey = flags['api-key'] ? String(flags['api-key']) : '';
  if (!apiKey) {
    if (!process.stdin.isTTY) {
      console.error('usage: codexrev models key <provider> --api-key <key>  (or run in a TTY to be prompted)');
      process.exitCode = 2;
      return;
    }
    apiKey = (await promptHidden(`API key for '${provider}': `)).trim();
  }
  if (!apiKey) { console.error('Error: empty API key.'); process.exitCode = 1; return; }

  try {
    const { getDek, setDek } = await import('../security/keychain.js');
    const { generateDek } = await import('../security/secrets.js');
    let dek = await getDek(cwd);
    if (!dek) { dek = generateDek(); await setDek(cwd, dek); }
    await setProviderApiKey(cwd, provider, apiKey, dek);
    console.log(`✓ API key for provider '${provider}' encrypted and saved.`);
  } catch (err) {
    if (err instanceof ConfigError) { console.error(`Error: ${err.message}`); process.exitCode = 1; } else throw err;
  }
}

/** Read a line from stdin without echoing it (best effort, raw mode). */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const finish = () => {
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(buf);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (code === 3) { process.stdout.write('\n'); process.exit(130); } // Ctrl-C
        if (code === 127 || code === 8) { buf = buf.slice(0, -1); continue; } // backspace / DEL
        if (code >= 32) buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function printModelsUsage(): void {
  console.log('usage: codexrev models <subcommand>');
  console.log('');
  console.log('Subcommands:');
  console.log('  list                           List all providers and their models');
  console.log('  add                            Add provider + model (interactive wizard)');
  console.log('  use <model-id> --provider <n>  Set the active (default) model — global, one at a time');
  console.log('  key <provider> [--api-key <k>] Set/replace a provider\'s encrypted API key');
  console.log('  remove provider <name>         Remove a provider');
  console.log('  remove model <id> --provider <n>  Remove a model from a provider');
  console.log('');
  console.log('Options:');
  console.log('  --provider <name>              Provider name (for use, key, remove model)');
  console.log('  --api-key <key>                API key (for key; non-interactive)');
  console.log('');
  console.log('Examples:');
  console.log('  codexrev models add              Launch interactive wizard');
  console.log('  codexrev models use deepseek-chat --provider deepseek');
  console.log('  codexrev models key openai --api-key $OPENAI_API_KEY');
  console.log('  codexrev models list');
}
