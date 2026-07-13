# file_system

Tools for reading and writing files on disk: `read_file`, `write_file`, `edit`, `glob`, `grep`.

## `read_file`

```ts
read_file({ path: "src/index.ts" })
```

Reads a UTF-8 file and returns `{ content }`. Paths may be absolute or relative to the agent's `cwd`. A missing file yields `{ output: 'ENOENT …', isError: true }`.

## `write_file`

```ts
write_file({ path: "src/foo.ts", content: "export const x = 1;\n" })
```

Creates or overwrites a file. Parent directories are created if needed. Refuses to write outside the agent's `cwd` when `sandbox !== 'off'`.

## `edit`

Apply a structured patch to a file.

```ts
edit({
  path: 'src/index.ts',
  oldText: 'export const x = 1;',
  newText: 'export const x = 2;',
})
```

The tool fails if `oldText` isn't present exactly once in the file.

## `glob`

```ts
glob({ pattern: 'src/**/*.ts' })
```

Returns relative paths matching the glob.

## `grep`

```ts
grep({ pattern: 'TODO', include: '*.ts' })
```

Regex search across `include` globs. Returns `{ path, line, content }` per match.
