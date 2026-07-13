#!/usr/bin/env node
// Post-install message — keep it short, do nothing on failure.
try {
  console.log('');
  console.log('  \u2713 codexrev installed. Run `codexrev init` in your project to get started.');
  console.log('');
} catch {
  // never fail the install because of a friendly message
}