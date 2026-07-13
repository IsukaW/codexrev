// esbuild configuration for Codexrev — produces three bundles:
//   1. dist/cli.js   — CLI executable (ESM, executable shebang)
//   2. dist/api.js   — ESM programmatic API
//   3. dist/api.cjs  — CJS programmatic API

import { build, context } from 'esbuild';
import { chmod, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outdir = path.join(root, 'dist');

/**
 * Modules kept external — they ship as Node.js deps and should not be
 * inlined into the bundle. The Ink/React stack is excluded because it
 * uses top-level await which esbuild cannot emit inside a CJS bundle.
 */
const externals = [
  // SDKs (preserved for tree-shaking)
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@modelcontextprotocol/sdk',
  '@opentelemetry/api',
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/semantic-conventions',
  // Ink / React / Yoga — top-level await + WASM
  'ink',
  'react',
  'react-dom',
  'ink-big-text',
  'ink-gradient',
  'ink-select-input',
  'ink-spinner',
  'ink-text-input',
  'lowlight',
  'yoga-layout',
  'react-devtools-core',
  // Native / platform-specific
  'fsevents',
  '@parcel/watcher',
  'keytar',
  // Common utilities that should stay external
  'simple-git',
  'ajv',
  'ajv-formats',
  'diff',
  'dotenv',
  'glob',
  'html-to-text',
  'shell-quote',
  'strip-json-comments',
  'undici',
  'yargs',
];

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  external: externals,
  loader: {
    '.node': 'file',
  },
  resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
  define: {
    'process.env.CODEXREV_VERSION': JSON.stringify(
      process.env.npm_package_version || '0.1.0',
    ),
  },
};

const builds = [
  {
    name: 'cli',
    options: {
      ...commonOptions,
      entryPoints: [path.join(root, 'src/cli/index.ts')],
      outfile: path.join(outdir, 'cli.js'),
      format: 'esm',
      banner: {
        // Shebang is prepended in a post-processing step to avoid esbuild
        // auto-duplicating it. createRequire shim gives the bundle access to
        // CJS APIs (e.g. undici, simple-git) without rewriting call sites.
        js: [
          "import { createRequire as _codexrevCreateRequire } from 'node:module';",
          'const require = _codexrevCreateRequire(import.meta.url);',
        ].join('\n'),
      },
      minify: false,
    },
  },
  {
    name: 'api-esm',
    options: {
      ...commonOptions,
      entryPoints: [path.join(root, 'src/api/index.ts')],
      outfile: path.join(outdir, 'api.js'),
      format: 'esm',
    },
  },
  {
    name: 'api-cjs',
    options: {
      ...commonOptions,
      entryPoints: [path.join(root, 'src/api/index.ts')],
      outfile: path.join(outdir, 'api.cjs'),
      format: 'cjs',
    },
  },
  {
    name: 'tools-esm',
    options: {
      ...commonOptions,
      entryPoints: [path.join(root, 'src/tools/index.ts')],
      outfile: path.join(outdir, 'tools.js'),
      format: 'esm',
    },
  },
  {
    name: 'tools-cjs',
    options: {
      ...commonOptions,
      entryPoints: [path.join(root, 'src/tools/index.ts')],
      outfile: path.join(outdir, 'tools.cjs'),
      format: 'cjs',
    },
  },
];

async function copyAssets() {
  await mkdir(path.join(outdir, 'assets'), { recursive: true });
  if (existsSync(path.join(root, 'assets'))) {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.join(root, 'assets'), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        await copyFile(
          path.join(root, 'assets', entry.name),
          path.join(outdir, 'assets', entry.name),
        );
      }
    }
  }
}

async function setExecutable() {
  const cliPath = path.join(outdir, 'cli.js');
  if (!existsSync(cliPath)) return;
  // Prepend shebang (only if not already present).
  let content = await readFile(cliPath, 'utf-8');
  if (!content.startsWith('#!')) {
    content = '#!/usr/bin/env node\n' + content;
    await writeFile(cliPath, content);
  }
  try {
    await chmod(cliPath, 0o755);
  } catch {
    // Windows doesn't support chmod — leave the executable bit unset.
  }
}

async function writeVersionFile() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf-8'));
  await writeFile(
    path.join(outdir, 'version.json'),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, buildTime: new Date().toISOString() },
      null,
      2,
    ),
  );
}

export async function runBuild(watch = false) {
  if (!existsSync(outdir)) {
    await mkdir(outdir, { recursive: true });
  }

  if (watch) {
    const contexts = await Promise.all(builds.map((b) => context({ ...b.options })));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[codexrev] esbuild watching for changes...');
  } else {
    for (const b of builds) {
      console.log(`[codexrev] building ${b.name}...`);
      await build(b.options);
    }
  }

  await copyAssets();
  await writeVersionFile();
  await setExecutable();
  console.log('[codexrev] build complete →', outdir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const watch = process.argv.includes('--watch');
  runBuild(watch).catch((err) => {
    console.error('[codexrev] build failed:', err);
    process.exit(1);
  });
}
