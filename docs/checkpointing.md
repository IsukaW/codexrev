# Checkpointing

Codexrev can snapshot point-in-time state of files in your working directory and rewind later. Internally it maintains a *shadow* git repository at `~/.codexrev/checkpoints/<session-id>/`.

## Programmatic API

```ts
import { openCheckpoints, CheckpointError } from 'codexrev';

const cp = openCheckpoints({
  sessionId: 'feature-foo',
  rootDir: process.cwd(),
});

// 1) snapshot three files
const record = await cp.commit('before big refactor', [
  'src/server.ts',
  'src/db.ts',
  'README.md',
]);

// 2) ten minutes later, list what we have
const all = await cp.list();

// 3) see the diff for a checkpoint
console.log(await cp.diff(record.id));

// 4) rewind
const restored = await cp.restore(record.id);
console.log(`restored ${restored.length} files`);

// 5) forget a snapshot
await cp.remove(record.id);
```

## TUI slash commands

The TUI exposes two slash commands:

- `/checkpoint <label>` — capture the current file set
- `/rewind <id>` — restore by id

(`/checkpoints` lists all checkpoints in the current session.)

## Lifetime

A shadow repo persists until the user deletes `~/.codexrev/checkpoints/`. Each commit is a real git commit so snapshots can be inspected with `git -C ~/.codexrev/checkpoints/<session>/ log`.

If `simple-git` cannot find `git`, the service throws `CheckpointError` on first use.
