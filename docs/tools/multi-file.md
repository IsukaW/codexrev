# multi_file

A higher-level wrapper around `read_file` + `edit` that lets the model propose several file edits at once.

## Schema

```ts
multi_file({
  edits: Array<{
    path: string,
    oldText: string,
    newText: string,
  }>,
})
```

## Behavior

- Validates each `oldText` against the current file contents.
- Applies edits in declaration order.
- If any `oldText` is ambiguous (zero or multiple matches), the whole call fails and no edits are applied.

## Use cases

- "Rename the function everywhere."
- "Refactor this file to use async/await and add `// foo` comments where helpful."
