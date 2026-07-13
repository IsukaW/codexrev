# Contributing to Codexrev

Thanks for your interest in Codexrev! 🎉

## Ground Rules

- **Original work only.** Codexrev contains no code from Google Gemini CLI, easy-llm-cli, or any other proprietary source. All contributions must be original.
- **No vendor branding.** Never use the words "Gemini" or "easy-llm-cli" in source code, prompts, error messages, comments, docs, or tests. The only accepted name is **Codexrev** (or `codexrev` in identifiers).
- **Apache-2.0 license.** All contributions are licensed under Apache-2.0.

## Development Setup

```bash
git clone https://github.com/codexrev/codexrev
cd codexrev
npm install
npm run dev
```

## Code Style

- TypeScript strict mode is enforced.
- ESLint + Prettier configs ship in the repo. Run `npm run lint` and `npm run format` before committing.
- Use the `manage_todo_list` tool internally for tasks touching ≥3 files.

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add checkpointing to agent loop
fix: handle Anthropic 529 gracefully
docs: update README quick-start
test: add unit tests for OpenAI adapter
```

## Pull Request Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] No vendor branding introduced
- [ ] Docs updated (if user-facing)

## Reporting Issues

Open an issue on GitHub with reproduction steps. For security issues, please email the maintainers directly (see `package.json` `author` field).
