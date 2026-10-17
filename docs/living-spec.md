# Living Specification Engine

> **Status: scaffold (Feature 1).** The command surface and state layout exist and are
> tested; the analyzer itself is **in development** — `codexrev spec analyze` and
> `codexrev spec watch` currently print a placeholder and exit `0`.

The Living Specification Engine watches/analyzes source-code changes and incrementally
maintains a **living URS** (User Requirements Specification) for the target project:
requirement implications are proposed from diffs, drift between the code and the URS is
surfaced as alerts, and test-case deltas are suggested alongside each requirement change.

## Commands

See [`codexrev spec`](cli/commands.md#codexrev-spec) for the full flag reference.

| Subcommand | Status | Purpose |
| --- | --- | --- |
| `spec analyze` | in development | One-shot analysis of a diff → proposed URS patch + test deltas |
| `spec watch` | in development | Foreground watch session (command-triggered only — never a background daemon) |
| `spec status` | available | Current URS version, pending proposals, last drift alerts |
| `spec history` | available | URS versions with their trigger change ids |
| `spec accept <id>` / `spec reject <id>` / `spec defer <id>` | available | Act on a pending URS proposal |

## State layout

All state lives inside the *target* project (`.codexrev/living-spec/`, created on demand):

```text
<target-project>/.codexrev/living-spec/
  config.json     feature config: watched paths, debounce (ms), model override
  urs/            living URS markdown + json state
  versions/       versioned URS snapshots (one json per version)
  proposals/      pending accept/reject/defer proposals
  reports/        analysis outputs
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
- `src/features/living-spec/tools/` — json schema + fs persistence (state store)
- `src/features/living-spec/testing/` — fixtures for tests
