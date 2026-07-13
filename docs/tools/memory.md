# memory

The memory tool reads, writes, and erases the scratchpad at `CODEXREV.md` in the agent's working directory.

## Schema

```ts
memory({
  action: 'read' | 'write' | 'append' | 'clear',
  content?: string,         // required for write/append
})
```

## Behavior

- `read` returns the full file content. Missing file ⇒ `{ output: '', isError: false }`.
- `write` overwrites.
- `append` appends (with a leading newline).
- `clear` truncates to empty.

## Lifecycle

The agent is expected to call `memory action=read` at the start of a session and `append` whenever it learns something durable. See [memport.md](../core/memport.md).
