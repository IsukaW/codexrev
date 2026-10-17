# Living Specification Engine

> **Status: deterministic front half (Feature 1).** `codexrev spec analyze` and
> `codexrev spec watch` run diff extraction + change buffering end-to-end and write
> the deterministic analysis as report JSON. The semantic analyzer (requirement
> implications, drift semantics, URS patches, test deltas) is **in development**.

The Living Specification Engine watches/analyzes source-code changes and incrementally
maintains a **living URS** (User Requirements Specification) for the target project:
requirement implications are proposed from diffs, drift between the code and the URS is
surfaced as alerts, and test-case deltas are suggested alongside each requirement change.

## Commands

See [`codexrev spec`](cli/commands.md#codexrev-spec) for the full flag reference.

| Subcommand | Status | Purpose |
| --- | --- | --- |
| `spec analyze` | deterministic analysis available | One-shot analysis of a diff → report JSON (semantic proposals in development) |
| `spec watch` | foreground session available | Foreground watch session (command-triggered only — never a background daemon) |
| `spec status` | available | Current URS version, pending proposals, last drift alerts |
| `spec history` | available | URS versions with their trigger change ids |
| `spec accept <id>` / `spec reject <id>` / `spec defer <id>` | available | Act on a pending URS proposal |

## Deterministic front half

Analysis is triggered **only** by an explicit command — the one-shot `analyze` or the
foreground `watch` session. There is no auto file-save daemon, service or git hook.

`analyze` extracts the diff from a git ref (default: staged changes) with `simple-git`
and `parsePatch()`, runs every changed file through the debounce/dedupe buffer, derives a
stable `changeId` (hash of ref + file list + diff content) and writes the result to
`.codexrev/living-spec/reports/<changeId>.json`. `--dry-run` prints without writing;
`--output json` prints the `SpecAnalysisResult` (implications/drift/test deltas are left
empty until the semantic analyzer lands).

Extraction guarantees:

- **exact line numbers** — every parsed line carries its exact old/new line number;
- **minimal diff view** — changed lines plus at most `contextLines` (default 3) context
  lines around each change cluster; never whole files;
- **glob filtering** — configurable via `includePaths` in `config.json` (default: source
  files only — ts/tsx/js/jsx/py/java/go/rs); `node_modules`, `dist`, `.git` and
  `.codexrev` are always excluded;
- **truncation guard** — diffs larger than `maxBytes` (default 200 KB) are truncated at
  file boundaries and flagged explicitly (`truncated` + `omittedPaths`), never silently.

`watch` is a foreground session over the same buffer + extraction path: saves are
debounced per path (`--debounce`, default 800 ms), identical content hashes are analysed
at most once (NFR3), each debounced change prints a per-event summary, and Ctrl+C ends
the session cleanly. The filesystem watcher (chokidar) sits behind a small `WatcherPort`
interface so the provider is swappable.

## State layout

All state lives inside the *target* project (`.codexrev/living-spec/`, created on demand):

```text
<target-project>/.codexrev/living-spec/
  config.json     feature config: watched paths, include globs, context lines,
                  max diff bytes, debounce (ms), model override
  urs/            living URS markdown + json state
  versions/       versioned URS snapshots (one json per version)
  proposals/      pending accept/reject/defer proposals
  reports/        analysis outputs (one json per changeId)
```

`config.json` is validated against a JSON schema (ajv + ajv-formats) on every read and
write; a corrupt config fails fast instead of silently watching the wrong paths.

## Integration contract

`src/features/living-spec/pipeline/types.ts` defines the **stable integration contract**
(`SpecAnalysisResult`): one JSON document per analysed change, carrying the touched files,
requirement implications, drift status, URS patch, test-case deltas and quality metadata.
Other features may consume this JSON later — the type is JSON-serializable and
additive-only.

## Code layout

Mirrors the review-pipeline feature:

- `src/features/living-spec/cli/` — yargs command registration + handlers (+ Ink views)
- `src/features/living-spec/pipeline/` — pure domain logic, no CLI concerns
  (`diffExtractor`, `changeBuffer`, `analysisRunner`)
- `src/features/living-spec/watch/` — `WatcherPort` seam + the chokidar provider
- `src/features/living-spec/tools/` — json schema + fs persistence (state store),
  path-glob matching
- `src/features/living-spec/testing/` — fixtures for tests
