#!/usr/bin/env node
/**
 * Feature 4 strict-authorization setup tool: a standalone entry point that does not touch the shared
 * CodeXRev CLI routing.
 *
 *   development:  npx tsx src/features/action-safety/strict/cli.ts <command> ...
 *   built:        npx esbuild src/features/action-safety/strict/cli.ts --bundle --platform=node --format=esm --packages=external \
 *                   --outfile=dist/features/action-safety/strict/cli.js
 *                 node dist/features/action-safety/strict/cli.js <command> ...
 *
 * (The standard `npm run build` bundles only the main CLI; the esbuild command above builds this tool
 * into dist/ without changing any build configuration.)
 */

import { runStrictCli } from './run.js';

const code = await runStrictCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + '\n'),
  err: (line) => console.error(line),
  cwd: process.cwd(),
});
process.exitCode = code;
