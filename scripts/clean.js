#!/usr/bin/env node
// Remove dist/, coverage/, and other build artifacts
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const targets = [
  path.join(root, 'dist'),
  path.join(root, 'coverage'),
  path.join(root, '.turbo'),
];

for (const t of targets) {
  try {
    await rm(t, { recursive: true, force: true });
    console.log(`[codexrev] removed ${t}`);
  } catch (err) {
    console.warn(`[codexrev] could not remove ${t}:`, err.message);
  }
}

console.log('[codexrev] clean complete');
