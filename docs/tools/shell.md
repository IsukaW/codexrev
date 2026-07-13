# shell

Run an arbitrary command in a sandboxed shell.

```ts
shell({ command: "ls -la" })
```

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | `string` | yes | The shell command to run. |
| `cwd` | `string` | no | Working directory. Defaults to the agent's `cwd`. |
| `timeoutMs` | `number` | no | Max time in ms. Default 60_000. |

## Result

```ts
{ stdout: string, stderr: string, exitCode: number, durationMs: number }
```

## Safety

- By default the command runs under the active `sandbox` policy (`auto`/`seatbelt`/`docker`/`podman`/`off`). See [Sandbox](../sandbox.md).
- `approvalMode === 'on-request'` will prompt the user before this tool runs.
- Destructive commands (`rm -rf`, `git push --force`, `mkfs`, etc.) are flagged by the TUI; the user must confirm.
