#!/usr/bin/env node
// Build all Codexrev bundles via esbuild
import { runBuild } from '../esbuild.config.mjs';

const watch = process.argv.includes('--watch');

runBuild(watch).catch((err) => {
  console.error('[codexrev] build failed:', err);
  process.exit(1);
});
