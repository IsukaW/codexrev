/**
 * Codexrev — CLI entry point.
 *
 * Parses argv via yargs, loads settings, wires up the agent loop, and
 * either launches the interactive TUI or runs a single non-interactive
 * prompt depending on flags.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadSettings } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import { ensureCodexrevHome, getCodexrevPaths } from '../utils/paths.js';
import { runTui } from './tui.js';
import { runNonInteractive } from './nonInteractive.js';
import { runInit } from './init.js';
import { renderHelp, renderVersion } from './help.js';
import {
  installExtension,
  loadExtensions,
  uninstallExtension,
} from '../extensions/loader.js';
import { projectConfigPath } from '../config/projectConfig.js';
import { PROVIDER_IDS, providerMeta } from '../providers/registry.js';
import { probeLocalProvider, resolveBaseUrlForProvider } from '../providers/health.js';

interface CliArgs {
  provider?: string;
  model?: string;
  sandbox?: 'auto' | 'seatbelt' | 'docker' | 'podman' | 'off';
  theme?: 'dark' | 'light' | 'solarized' | 'monokai' | 'nord';
  telemetry?: boolean;
  'no-update'?: boolean;
  print?: string;
  'output-format'?: 'text' | 'json' | 'stream-json';
  'approval-mode'?: 'always' | 'on-request' | 'never';
  debug?: boolean;
  help?: boolean;
  version?: boolean;
  /** Subcommand routing — populated by `parse()`. */
  _: Array<string | number>;
  /** Free-form positional after the subcommand. */
  [key: string]: unknown;
}

async function handleExtensionsSubcommand(rest: ReadonlyArray<string | number>): Promise<void> {
  const sub = String(rest[0] ?? '');
  if (sub === 'list' || sub === '') {
    const reg = await loadExtensions({ verbose: true });
    if (reg.extensions.length === 0) {
      console.log('No extensions installed.');
      console.log(`Extensions root: ${getCodexrevPaths().extensionsDir}`);
      return;
    }
    for (const ext of reg.extensions) {
      console.log(`• ${ext.manifest.name} v${ext.manifest.version}`);
      if (ext.manifest.description) console.log(`    ${ext.manifest.description}`);
      console.log(`    hooks: ${ext.manifest.hooks.join(', ') || '(none)'}`);
    }
    return;
  }
  if (sub === 'install') {
    const dir = String(rest[1] ?? '');
    if (!dir) {
      console.error('usage: codexrev extensions install <dir>');
      process.exitCode = 2;
      return;
    }
    const dst = await installExtension(dir);
    console.log(`✓ installed extension at ${dst}`);
    return;
  }
  if (sub === 'uninstall') {
    const name = String(rest[1] ?? '');
    if (!name) {
      console.error('usage: codexrev extensions uninstall <name>');
      process.exitCode = 2;
      return;
    }
    await uninstallExtension(name);
    console.log(`✓ removed extension "${name}"`);
    return;
  }
  console.error(`unknown extensions subcommand: ${sub}`);
  console.error('commands: list, install <dir>, uninstall <name>');
  process.exitCode = 2;
}

async function main(): Promise<void> {
  await ensureCodexrevHome();

  const argv = (await yargs(hideBin(process.argv))
    .scriptName('codexrev')
    .usage('$0 [prompt]\n\nCodexrev — multi-provider, agentic command-line AI assistant.')
    .fail((msg, err) => {
      if (err) throw err;
      process.stderr.write(`\n[codexrev] ${msg}\n\nFor usage, run: codexrev --help\n\n`);
      process.exit(2);
    })
    .command(
      'init',
      'Initialize this project with an encrypted .codexrev/config.json',
      (y) =>
        y
          .option('provider', {
            type: 'string',
            choices: [...PROVIDER_IDS] as readonly string[],
            describe: 'LLM provider',
          })
          .option('model', { type: 'string', describe: 'Model name (provider-specific)' })
          .option('api-key', { type: 'string', describe: 'Provider API key (optional for local providers)' })
          .option('base-url', { type: 'string', describe: 'Provider base URL (optional)' })
          .option('reset', { type: 'boolean', default: false, describe: 'Replace existing config' })
          .option('non-interactive', {
            type: 'boolean',
            default: false,
            describe: 'Skip the TUI wizard (requires --provider and --model)',
          }),
    )
    .command('extensions', 'Manage installed extensions', (y) =>
      y
        .command('list', 'List installed extensions')
        .command('install <dir>', 'Install an extension from a local directory')
        .command('uninstall <name>', 'Remove an installed extension')
        .demandCommand(1),
    )
    .option('provider', {
      type: 'string',
      describe: `LLM provider: ${PROVIDER_IDS.join(' | ')}`,
    })
    .option('model', { type: 'string', describe: 'Model name (provider-specific)' })
    .option('sandbox', {
      type: 'string',
      choices: ['auto', 'seatbelt', 'docker', 'podman', 'off'] as const,
      describe: 'Shell sandbox mode',
    })
    .option('theme', {
      type: 'string',
      choices: ['dark', 'light', 'solarized', 'monokai', 'nord'] as const,
    })
    .option('telemetry', { type: 'boolean', describe: 'Enable OpenTelemetry export' })
    .option('no-update', { type: 'boolean', describe: 'Skip update check' })
    .option('print', {
      alias: 'p',
      type: 'string',
      describe: 'Run non-interactively with a prompt and print the result',
    })
    .option('output-format', {
      type: 'string',
      choices: ['text', 'json', 'stream-json'] as const,
      default: 'text',
      describe: 'Output format for non-interactive mode',
    })
    .option('approval-mode', {
      type: 'string',
      choices: ['always', 'on-request', 'never'] as const,
      describe: 'How to handle tool execution approval',
    })
    .option('debug', { type: 'boolean', describe: 'Enable debug logging' })
    .help(false)
    .version(false)
    .exitProcess(false)
    .parseAsync()) as unknown as CliArgs;

  if (argv.help || hideBin(process.argv).includes('-h')) {
    renderHelp();
    return;
  }
  if (argv.version || hideBin(process.argv).includes('-v')) {
    renderVersion();
    return;
  }

  if (argv.debug) {
    process.env.CODEXREV_LOG_LEVEL = 'debug';
  }

  // Route subcommands first.
  if (argv._.includes('init')) {
    const flags = argv as unknown as {
      provider?: string;
      model?: string;
      apiKey?: string;
      apiKeyRaw?: string;
      baseUrl?: string;
      reset?: boolean;
      nonInteractive?: boolean;
    };
    // yargs converts --api-key → apiKey, --base-url → baseUrl
    await runInit({
      cwd: process.cwd(),
      provider: flags.provider,
      model: flags.model,
      apiKey: flags.apiKey ?? (argv as Record<string, unknown>)['api-key'] as string | undefined,
      baseUrl: flags.baseUrl ?? (argv as Record<string, unknown>)['base-url'] as string | undefined,
      reset: !!flags.reset,
      nonInteractive: !!flags.nonInteractive || !process.stdout.isTTY,
    });
    return;
  }

  if (argv._.includes('extensions')) {
    const rest = argv._.slice(argv._.indexOf('extensions') + 1);
    await handleExtensionsSubcommand(rest);
    return;
  }

  const settings = await loadSettings();
  logger.debug('settings loaded', { provider: settings.provider, model: settings.model });

  // For local providers (Ollama, LM Studio, LiteLLM) the server must be
  // reachable BEFORE we start streaming — fail fast with a friendly hint
  // instead of letting the OpenAI SDK throw an opaque connection error.
  const activeMeta = providerMeta(settings.provider);
  if (!activeMeta.requiresApiKey) {
    const baseUrl = resolveBaseUrlForProvider(settings.provider, settings.providers[settings.provider]?.baseUrl);
    if (baseUrl) {
      try {
        await probeLocalProvider(settings.provider, baseUrl);
        logger.debug('local provider probe ok', { provider: settings.provider, baseUrl });
      } catch (err) {
        // Print the friendly error and exit non-zero so scripts / CI
        // can detect the missing daemon. TUI users see this on startup
        // rather than after they type a prompt.
        process.stderr.write(`\n[codexrev] ${(err as Error).message}\n\n`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // Friendly nudge: no project config and no API key resolved anywhere.
  // Local providers (requiresApiKey === false) are always considered
  // resolved once the probe above passes — skip the nudge for them.
  const hasResolvedKey =
    !activeMeta.requiresApiKey ||
    !!settings.providers[settings.provider]?.apiKey ||
    !!(activeMeta.envKeyVar && process.env[activeMeta.envKeyVar]);
  const hasProjectConfig = await (async () => {
    try {
      const { existsSync } = await import('node:fs');
      return existsSync(projectConfigPath(process.cwd()));
    } catch {
      return false;
    }
  })();
  if (!hasResolvedKey && !hasProjectConfig) {
    process.stderr.write(
      `\n[codexrev] No project config at .codexrev/config.json and no API key in env.\n` +
        `           Run \`codexrev init\` to set up this project.\n\n`,
    );
  }

  const extensions = await loadExtensions({ verbose: !!argv.debug });
  if (extensions.extensions.length > 0) {
    logger.debug(`loaded ${extensions.extensions.length} extension(s)`, {
      names: extensions.extensions.map((e) => e.manifest.name),
    });
  }

  if (argv.print) {
    await runNonInteractive({
      prompt: argv.print,
      settings,
      extensions,
      outputFormat: argv['output-format'] as 'text' | 'json' | 'stream-json',
    });
    return;
  }

  await runTui({ settings, extensions });
}

main().catch((err) => {
  logger.error('fatal error', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});