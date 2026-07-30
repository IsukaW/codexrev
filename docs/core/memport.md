# Memory port

Codexrev writes a small scratchpad at `CODEXREV.md` in the user's working directory. The agent reads it at the start of every session and rewrites it when it learns something durable (project conventions, repeat-fix recipes, project name, etc.).

The file is plain Markdown. The first paragraph is the most important — that's where the agent stores project notes that survive across sessions.

Example:

```markdown
# project: codexrev

A multi-provider agentic CLI for code, research, and shell automation. Uses Ink for the TUI and esbuild to bundle.

- Always bump `package.json` version after a merge to `main`.
- Never modify generated files in `dist/` directly; rebuild with `npm run build`.
```

Future versions will support per-project and per-user memory files (e.g. `~/.codexrev/memory.md`) for cross-project facts.
