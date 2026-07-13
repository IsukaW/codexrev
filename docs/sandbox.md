# Sandboxing

The shell tool runs every command through a sandbox. The default `auto` mode picks the safest backend available for your OS:

| OS | Default backend |
| --- | --- |
| macOS | Seatbelt (`sandbox-exec`) |
| Linux (with Docker) | `docker run --rm alpine:3.20` |
| Linux (with Podman) | `podman run --rm alpine:3.20` |
| Windows | Docker if installed, otherwise passthrough |

You can override per-invocation or globally:

```bash
codexrev --sandbox docker
```

```jsonc
// ~/.codexrev/settings.json
{ "sandbox": "seatbelt" }
```

## Backends

### Seatbelt (macOS)

A small SBPL profile is generated per invocation, deny-by-default, allowing only file reads and writes inside the agent's `cwd` plus `/tmp`. Network is permitted.

### Docker / Podman

Each command runs in a fresh `alpine:3.20` container with the working directory bind-mounted read-write at `/work`. The container is deleted on exit (`--rm`).

### Off (passthrough)

Commands execute in the host shell with no isolation. Use this only in dev when you trust the model completely.

## When sandboxing isn't enough

Codexrev deliberately avoids executing:

- `rm -rf /` or `--no-preserve-root`
- `git push --force` to `main`/`master`
- `mkfs`, `dd if=…of=/dev/…`
- `curl <remote> | sh`

These will be flagged by the TUI's approval prompt even with `sandbox=off`.
