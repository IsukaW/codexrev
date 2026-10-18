# Living Specification Engine

> **Status: full pipeline (Feature 1 + Feature 2).** `codexrev spec analyze` and
> `codexrev spec watch` run diff extraction → requirement implications → drift
> comparison → scoped URS proposals → **test-case deltas**, **drift alerts** and a
> **change-impact summary**, persisted as report JSON. Nothing becomes
> authoritative without an explicit `spec accept` (NFR4).

The Living Specification Engine watches/analyzes source-code changes and incrementally
maintains a **living URS** (User Requirements Specification) for the target project:
requirement implications are proposed from diffs, drift between the code and the URS is
surfaced as alerts, and test-case deltas are suggested alongside each requirement change.

## Commands

Everything lives under one top-level command group, `codexrev spec`. The table below is the
summary; see [`codexrev spec`](cli/commands.md#codexrev-spec) for the full hand-rolled help
screen and every flag in one place.

| Subcommand | Purpose |
| --- | --- |
| `spec bootstrap` | Generate **URS Version 0** from the implemented code (approval required) → JSON + MD + PDF |
| `spec analyze` | One-shot analysis of a diff → report JSON (proposals + test deltas + drift alerts + impact summary) |
| `spec watch` | Foreground watch session over the same pipeline (command-triggered only — never a background daemon) |
| `spec eval` | Controlled evaluation: replay the labelled scenario corpus → metrics report ([evidence pack](living-spec-evaluation.md)) |
| `spec init-urs` | Seed a starter living URS skeleton (`urs.md` + `urs.json`) if none exists |
| `spec status` | Current URS version, pending proposals, latest drift alerts (bounded list) |
| `spec history` | URS versions with their trigger change ids |
| `spec accept <id>` | Apply a pending proposal to the living URS, bump the version, mark it accepted |
| `spec reject <id>` | Mark a proposal rejected — the URS is untouched |
| `spec defer <id>` | Mark a proposal deferred — it stays listed in `spec status` for later |
| `spec eval` | Run the labelled scenario corpus and emit the evaluation report (metrics + Markdown summary) |

### Core subcommand flags

| Subcommand | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `analyze` | `--diff <ref>` | staged changes | Git ref (or ref range) to diff against |
| `analyze` | `--output text\|json` | `text` | Human-readable summary vs the full `SpecAnalysisResult` |
| `analyze` | `--dry-run` | off | Deterministic half only — no model calls, nothing written |
| `analyze` | `--provider <id>` | local (`ollama`/`lmstudio`) | Override the inference provider |
| `analyze` | `--model <id>` | project default | Override the model |
| `analyze` | `--offline` | off | Assert no network provider is used (proves NFR2/FR14) |
| `analyze` | `--timeout <ms>` | provider default | Abort a slow model call (NFR5 keeps prior URS intact) |
| `watch` | `--debounce <ms>` | `800` | Coalesce rapid saves of the same file |
| `watch` | `--paths <globs>` | `includePaths` in `config.json` | Restrict the watched set |
| `watch` | `--dry-run` | off | Run the pipeline without writing proposals/reports |
| `eval` | `--corpus <path>` | bundled scenarios | Path to the labelled scenario corpus |
| `eval` | `--mode A\|B\|C\|live` | `live` | `A` manual/batch · `B` single-pass (no prior-URS) · `C` full pipeline, explicit invocation · `live` local model |
| `eval` | `--provider <id>` | local | Provider used for `--mode live` |
| `eval` | `--output <path>` | `.codexrev/living-spec/reports/eval-<timestamp>.json` | Where to write the report |

### Global flags (all subcommands)

| Flag | Meaning |
| --- | --- |
| `--project <path>` | Target project root (defaults to the current working directory) |
| `--output text\|json` | Human-readable vs machine-readable output |
| `--quiet` | Suppress progress output (keeps results/errors) |
| `--help` | Hand-rolled help screen, consistent with the rest of the CLI |

### Typical session flow

```bash
# One-time setup in a target project
codexrev spec init-urs

# Analyze the currently staged changes once
codexrev spec analyze

# Watch mode while coding — runs until Ctrl+C, never a daemon
codexrev spec watch --debounce 1000 --paths "src/**/*.ts"

# Review what the engine proposed, then decide
codexrev spec status
codexrev spec accept prop-abc123
codexrev spec history

# Later, when running the evaluation
codexrev spec eval --mode live --provider ollama
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Runtime error (model unavailable, invalid state, …) |
| `2` | Bad usage / missing required argument |

There is deliberately **no** `spec daemon`, no background service and no installed git hook:
analysis only ever runs while an `analyze`/`watch`/`eval` invocation is in progress.

## Bootstrap — URS Version 0 from existing code

For a project **without** a living URS, `codexrev spec bootstrap` derives the initial
document from what is already implemented:

1. **Scan** — walks the configured `includePaths`, prioritising business-logic homes
   (controllers, services, repositories, handlers, routes, use cases) and bounding the
   read (30 files / 24 KB per file / 200 KB total; `node_modules`, `dist`, `.git` and
   `.codexrev` are never scanned; binaries are skipped).
2. **Generate** — one hardened model call (UNTRUSTED-DATA markers) returns requirement
   sections, each with `sourceRefs` into the scanned files; the payload is STRICT-schema
   validated (NFR5) and every reference is sanitised — refs that do not resolve into the
   scan are dropped, sections left without any reference are dropped.
3. **Approval gate (NFR4)** — the draft preview (sections + source references) is shown
   first; nothing is written until the user answers `Accept this as URS Version 0? [y/N]`
   on a TTY, or passes `--yes` for scripts/CI (required off-TTY — exit 2 otherwise).
   `--dry-run` previews without ever asking to save; an existing URS is never overwritten.

On approval the URS lands in **both formats**, and every later approved version does too:

```text
urs/urs.json        machine-readable document (codebase reference)
urs/urs.md          markdown rendering
urs/urs.pdf         viewer-friendly PDF (hand-rolled renderer, no deps)
versions/v0.json    Version 0 snapshot (action: bootstrap) + versions/v0.pdf
versions/vN.json    each accepted update keeps the same json + pdf pair
```

The status counter starts at **Version 0** for a bootstrapped URS, so the first
`spec accept` bumps it to v1 exactly like the `init-urs` seed path.

## Pipeline

Analysis is triggered **only** by an explicit command — the one-shot `analyze` or the
foreground `watch` session. There is no auto file-save daemon, service or git hook.

```text
                    ┌──────────────────────────────────────────────────────────┐
   git diff         │  living-spec pipeline (src/features/living-spec)         │
  (ref/staged)      │                                                          │
        │           │  ┌───────────────┐   ┌──────────────┐   ┌─────────────┐  │
        ├──────────►│  │ diffExtractor │──►│ changeBuffer │──►│  changeId   │  │
        │           │  │ (exact lines, │   │ (debounce /  │   │ (stable id) │  │
        │           │  │  minimal view)│   │  dedupe)     │   └─────────────┘  │
        │           │  └───────────────┘   └──────────────┘          │         │
        │           │          deterministic front half              ▼         │
        │           │  ┌────────────────────────────────────────────────────┐  │
        │           │  │ analysisRunner → SpecAnalysisResult (base)         │  │
        │           │  └────────────────────────────────────────────────────┘  │
        │           │                      │                                   │
        │           │        ┌─────────────┴──────────────┐                    │
        │           │        ▼  semantic back half        │  (optional LLM,    │
        │           │  ┌──────────────────┐               │   via llmPort)     │
        │           │  │ inferenceEngine  │ implications  │                    │
        │           │  │ (prompt → LLM →  ├──────────────►│                    │
        │           │  │  schema-validated│               │                    │
        │           │  │  JSON)           │               │                    │
        │           │  └──────────────────┘               │                    │
        │           │        │                            │                    │
        │           │        ▼                            │                    │
        │           │  ┌──────────────────┐  ┌──────────────────────────────┐  │
        │           │  │ driftComparator  │─►│ ursPatcher → proposals       │  │
        │           │  │ (new / modified/ │  │ (scoped patches, human gate) │  │
        │           │  │  conflicting /   │  └──────────────────────────────┘  │
        │           │  │  aligned)        │                                    │
        │           │  └──────┬───────────┘                                    │
        │           │         │          output side (Function 2)              │
        │           │         ├─────────► testDeltaSynthesizer → testDeltas    │
        │           │         │            (category rules + optional LLM      │
        │           │         │             refinement, deterministic fallback)│
        │           │         ├─────────► driftAlert → driftAlerts             │
        │           │         │            (conflicting/modified detections)   │
        │           │         └─────────► impactSummary → impactSummary        │
        │           │                      (requirements, files/lines,        │
        │           │                       next action, confidence)          │
        │           └──────────────────────────────────────────────────────────┘
        │                                  │
        ▼                                  ▼
  .codexrev/living-spec/reports/<changeId>.json      (report JSON — the contract)
  .codexrev/living-spec/reports/alerts.jsonl         (append-only alert log)
  .codexrev/living-spec/proposals/<id>.json          (pending proposals)
```

Failure policy (NFR4/NFR5): the semantic half may fail — the deterministic result
stands, the failure is surfaced as `inferenceError`, and the **rule-based** test
deltas, drift alerts and impact summary are still produced. Model output is applied
only after STRICT schema validation; malformed or invalid output is discarded, never
persisted as authoritative.

### Deterministic front half

`analyze` extracts the diff from a git ref (default: staged changes) with `simple-git`
and `parsePatch()`, runs every changed file through the debounce/dedupe buffer, derives a
stable `changeId` (hash of ref + file list + diff content) and writes TWO report artifacts
per analysis: the machine contract `reports/<changeId>.json` plus an interactive, fully
self-contained HTML twin for humans —
`reports/analyze-<YYYYMMDD-HHMMSS>-<file>-<id8>.html` (e.g.
`analyze-20261018-060851-greet-5e9beb9e.html`): sortable by timestamp, readable at a
glance, opens from disk with no network (inline CSS/JS, dark-mode aware) and carries every
report detail — files, implications, drift + URS patch/proposals, test deltas, impact
summary, drift alerts, quality + any inference failure. `--dry-run` is
**deterministic-only** — no model calls, nothing written; `--output json` prints the full
`SpecAnalysisResult` (and nothing else on stdout); `--quiet` suppresses the progress
output. Watch batches write the same JSON + HTML pair per analysed change.

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
at most once (NFR3, reported as `deduped` in the live view), each debounced change runs
the **full pipeline back half**, and Ctrl+C ends the session cleanly with a shutdown
summary. The filesystem watcher (chokidar) sits behind a small `WatcherPort` interface so
the provider is swappable.

## Command UX

All screens come from pure renderer functions (`cli/reportRenderer.ts`,
`cli/specSessionState.ts`), so text output is deterministic and unit-tested.

**`spec watch` — events → reducer → render.** Every session step is a typed event
(`cli/specSessionEvents.ts`): saves (`change_detected` / `change_deduped`), batch
lifecycle (`batch_start`, `stage`, `batch_complete`, `batch_skipped`, `batch_error`) and
`stopped`. One pure reducer turns them into view state — running counts (analyzed /
deduped / proposals / alerts), the latest drift status, and a bounded event log:

- **TTY** — a persistent Ink view (`cli/SpecSessionView.tsx`) renders the state: watched
  paths + debounce (with paths currently debouncing), the pipeline stage trail
  (`diff → infer → compare → proposal → outputs`), the event log, the latest drift, a
  **banner whenever drift alerts fire** (red for critical conflicts) and running counts.
- **pipes / CI** — the same events print as plain lines (e.g.
  `deduped src/greet.js (identical to the last analysed state)`), so watch works in
  scripts; `--output json` prints the raw report JSON per batch instead.
- **shutdown** — after Ctrl+C (or the stop signal) the session prints a plain summary:
  batches analyzed, saves deduped, proposals, alerts, reports written, plus a pointer to
  `spec status` when critical alerts exist.

**Text screens** (`--output text`, the default) use aligned tables for implications and
test deltas, a change-impact block, one line per drift alert and clear proposal ids;
`--output json` prints a single machine-readable document per command (`status` includes
open proposals + the alert tail, `history` the snapshot list, decisions the outcome).

**Per-command help**: `codexrev spec help [sub]` (or `--help` on any spec subcommand)
prints the hand-rolled help screen with flags, exit codes and examples.

**Exit codes**: `0` success · `1` error (bad config, unknown proposal, failed analysis) ·
`2` bad usage (unknown subcommand or missing id) — same convention as the rest of the CLI.

**Failure paths** are actionable: an unreachable model server prints
`start ollama / lm studio, or run with --dry-run`; malformed or schema-invalid model
output explains that nothing was applied or persisted (NFR5) and that the deterministic
analysis stands; a truncated diff says exactly what was omitted and that raising
`maxBytes` in the config widens the view.

## Evaluation

`codexrev spec eval` replays the labelled scenario corpus
(`tests/features/living-spec/fixtures/scenarios/`) through three comparison modes and
reports implication precision/recall/F1, drift accuracy, false-alert rate on refactors,
scoped-update correctness, test-delta relevance, latency (median/P95) and peak RSS to
`reports/eval-<timestamp>.json` + `.md`. It runs fully offline by default (scripted
provider, no network). See [living-spec-evaluation.md](living-spec-evaluation.md) for the
reproduction steps, results, test inventory and the FR/NFR/SO evidence mapping.

## Integration contract

`src/features/living-spec/pipeline/types.ts` defines the **stable integration contract**
(`SpecAnalysisResult`): one JSON document per analysed change. Other features (review
pipeline, checkpointing, CI hooks) may consume this JSON — every field is JSON-serializable
and the type is additive-only.

```jsonc
{
  "changeId": "8f14e45f…",              // stable id of the analysed change
  "timestamp": "2026-10-17T09:20:16.797Z",
  "files": [                            // touched files (diff facts)
    { "path": "src/greet.js", "lines": 3 }
  ],
  "implications": [                     // requirement-level implications (LLM)
    {
      "id": "imp-1",
      "kind": "functional",             // "functional" | "nfr"
      "text": "The greeting must include the caller name.",
      "confidence": 0.88,               // [0, 1]
      "sourceRefs": ["src/greet.js:2"], // "path:line" pointers into the change
      "rationale": "The greeting literal now interpolates the name.",
      "category": "behaviour"           // security|performance|api|validation|behaviour|other
    }
  ],
  "driftStatus": "modified",            // aligned|modified|new|conflicting|no-semantic-change
  "ursPatch": {                         // minimal edit set for the living URS
    "summary": "1 scoped URS update proposal(s).",
    "entries": [{ "op": "modify", "sectionId": "sec-greeting", "markdown": "…" }]
  },
  "testDeltas": [                       // incremental test-case deltas (FR10/SO5)
    {
      "id": "test-imp-1",
      "title": "Cover: [behaviour] The greeting must include the caller",
      "type": "new",                    // "new" | "update" | "obsolete"
      "linkedImplicationId": "imp-1",
      "linkedRequirementId": "sec-greeting",
      "preconditions": ["The system is in a state where the changed behaviour can be observed."],
      "steps": ["Perform the changed behaviour with representative inputs.", "…"],
      "expected": "The observed behaviour matches the requirement: …",
      "priority": "medium",             // "low" | "medium" | "high"
      "rationale": "behaviour rule for the new implication imp-1 (confidence 0.88)."
    }
  ],
  "quality": {                          // analysis provenance
    "model": "qwen2.5-coder",           // "heuristic" for rule-only runs
    "latencyMs": 812,
    "schemaValid": true,
    "usage": { "inputTokens": 12, "outputTokens": 8, "totalTokens": 20 }
  },
  "impactSummary": {                    // change-impact summary (FR11)
    "affectedRequirementIds": ["sec-greeting"],
    "affectedFiles": [{ "path": "src/greet.js", "lines": [2, 3] }],
    "recommendedNextAction": "Review the pending URS proposals for the modified requirement(s) and accept/reject/defer.",
    "confidence": 0.88
  },
  "driftAlerts": [                      // one per conflicting/modified detection (FR9/NFR6)
    {
      "changeId": "8f14e45f…",
      "file": "src/greet.js",
      "reason": "Requirement \"Greeting\" (sec-greeting) is modified by this change: …",
      "affectedRequirement": "sec-greeting",
      "proposedNextAction": "Confirm the requirement update for sec-greeting, then decide proposal …",
      "severity": "warning",            // "info" | "warning" | "critical"
      "timestamp": "2026-10-17T09:20:16.797Z"
    }
  ],
  "behaviourChangeSummary": "…",        // null when the semantic half did not run
  "requiresUrsUpdate": true,            // null when the semantic half did not run
  "inferenceError": null,               // { code, message, retryable } on failure
  "proposalIds": ["8f14e45f…-1"]
}
```

Contract rules:

- **Every field is populated or explicitly `null`** on every run — consumers never have
  to distinguish "missing" from "empty".
- `testDeltas` are **incremental** deltas, never a full test plan: one delta per
  implication classified `new`/`modified`/`conflicting`, always linked to its implication
  and requirement ids. Deltas are built from deterministic category rules
  (api/validation/security/performance/behaviour); an optional LLM refinement may reword
  them but can never change ids, types or links, and any model failure leaves the rule
  output intact.
- `impactSummary.affectedFiles` merges the diff's exact changed line numbers with the
  implication `sourceRefs`, so every file/line reference is traceable to the change.
- `driftAlerts` fire only on `conflicting` (severity `critical`) and `modified`
  (severity `warning`) detections.

## Proposal lifecycle

```text
                analyze / watch
                      │
                      ▼
             proposal generated        (status: pending — patch computed,
              (one per new/modified/     URS NOT touched, NFR4)
               conflicting implication)
                      │
        ┌─────────────┼──────────────────┐
        ▼             ▼                  ▼
  spec accept   spec reject        spec defer
        │             │                  │
        ▼             ▼                  ▼
  status:       status:            status: deferred
  accepted      rejected           (stays listed in `spec status`
        │             │              until resolved)
        ▼             │                  │
  patch applied       │                  │
  (scoped sections    └──────────────────┘
   only, SO4)              URS untouched
        │
        ▼
  URS version bumped (v1, v2, …) and an append-only snapshot
  recorded under versions/ with the triggering changeId (NFR7)
```

- **pending** — raised by `analyze`/`watch`; shown by `spec status` with its drift
  classification and the sections it touches.
- **accepted** — `spec accept <id>` validates the scoped patch (malformed patches are
  rejected outright), applies it to `urs/urs.json` + `urs/urs.md`, bumps the URS version
  and records a version snapshot. This is the **only** path that modifies the URS.
- **rejected** — `spec reject <id>` records the decision; the URS is untouched.
- **deferred** — `spec defer <id>` keeps the proposal open and visible in `spec status`;
  it can still be decided later. Re-deciding a resolved proposal fails cleanly.

## State layout

All state lives inside the *target* project (`.codexrev/living-spec/`, created on demand):

```text
<target-project>/.codexrev/living-spec/
  config.json             feature config (see below)
  urs/                    living URS: urs.json + urs.md + urs.pdf, state.json
  versions/               versioned snapshots: vN.json + vN.pdf per approved version
  proposals/              accept/reject/defer proposals (one json per proposal)
  reports/                analysis outputs: <changeId>.json (contract) +
                          analyze-<date>-<time>-<file>-<id8>.html (interactive artifact),
                          <changeId>.implications.json, eval-<ts>.json/.md
  reports/alerts.jsonl    append-only drift-alert log (one JSON object per line)
```

`config.json` is validated against a JSON schema (ajv + ajv-formats) on every read and
write; a corrupt config fails fast instead of silently watching the wrong paths.

## Configuration reference

`.codexrev/living-spec/config.json`:

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | `1` | Config schema version |
| `watchedPaths` | `string[]` | `["**/*"]` | Glob patterns watched by `spec watch` |
| `debounceMs` | integer (0–60000) | `800` | Quiet period after a change batch before analysing it |
| `includePaths` | `string[]` | source globs (ts/tsx/js/jsx/py/java/go/rs) | Glob filter for analysed diff files |
| `contextLines` | integer (0–100) | `3` | Context lines kept around each change in the minimal diff view |
| `maxBytes` | integer | `204800` | Diff truncation guard in bytes (flagged, never silent) |
| `modelOverride` | string (`<provider>/<model>`) | unset | Model for implication inference + test-delta refinement; falls back to the local default |
| `createdAt` / `updatedAt` | ISO-8601 | now | Bookkeeping stamps |

CLI flags override the config per run: `--provider`, `--model`, `--timeout` (inference),
`--offline` (assert a local provider — NFR2/FR14), `--diff <ref>`, `--paths <globs>`,
`--debounce <ms>`, `--output json|text`, `--dry-run` (deterministic-only, nothing
written), `--quiet` (suppress progress output), `--project <path>`.

## Code layout

Mirrors the review-pipeline feature:

- `src/features/living-spec/cli/` — yargs command registration + handlers, the shared
  `analysisPass` (pipeline back half), the pure `reportRenderer` + `specOutput` wrappers,
  the hand-rolled `specHelp` screen, and the watch session UI
  (`specSessionEvents` bus → `specSessionState` reducer → `SpecSessionView` Ink tree or
  the plain-line fallback)
- `src/features/living-spec/pipeline/` — pure domain logic, no CLI concerns:
  `diffExtractor`, `changeBuffer`, `analysisRunner`, `inferenceEngine`, `llmPort`,
  `promptBuilder`, `driftComparator`, `ursPatcher`, `ursModel`, `versionStore`,
  `testDeltaSynthesizer`, `impactSummary`, `driftAlert`
- `src/features/living-spec/watch/` — `WatcherPort` seam + the chokidar provider
- `src/features/living-spec/tools/` — JSON schemas (`implicationSchema`,
  `testDeltaSchema`) + fs persistence (state store, alerts.jsonl), path-glob matching
- `src/features/living-spec/testing/` — fixtures for tests
