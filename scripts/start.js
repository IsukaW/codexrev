#!/usr/bin/env node
// Dev launcher — runs the CLI from source via tsx (no build required)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const useTsx = process.argv.includes('--dev') || !existsSync(path.join(root, 'dist', 'cli.js'));

let cmd, args;
if (useTsx) {
  cmd = 'npx';
  args = ['tsx', path.join(root, 'src', 'cli', 'index.ts'), ...process.argv.slice(2)];
} else {
  cmd = 'node';
  args = [path.join(root, 'dist', 'cli.js'), ...process.argv.slice(2)];
}

const child = spawn(cmd, args, { stdio: 'inherit', cwd: root });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[codexrev] failed to start:', err);
  process.exit(1);
});
