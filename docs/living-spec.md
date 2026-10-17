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

See [`codexrev spec`](cli/commands.md#codexrev-spec) for the full flag reference.

| Subcommand | Purpose |
| --- | --- |
| `spec analyze` | One-shot analysis of a diff → report JSON (proposals + test deltas + drift alerts + impact summary) |
| `spec watch` | Foreground watch session over the same pipeline (command-triggered only — never a background daemon) |
| `spec status` | Current URS version, pending proposals, latest drift alerts (bounded list) |
| `spec history` | URS versions with their trigger change ids |
| `spec accept <id>` / `spec reject <id>` / `spec defer <id>` | Act on a pending URS proposal |
| `spec init-urs` | Seed a starter living URS skeleton if none exists |

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
stable `changeId` (hash of ref + file list + diff content) and writes the result to
`.codexrev/living-spec/reports/<changeId>.json`. `--dry-run` prints without writing;
`--output json` prints the full `SpecAnalysisResult` (and nothing else on stdout).

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
at most once (NFR3), each debounced change runs the **full pipeline back half** and
prints a per-event summary (`--output json` prints the report JSON instead), and Ctrl+C
ends the session cleanly. The filesystem watcher (chokidar) sits behind a small
`WatcherPort` interface so the provider is swappable.

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
  urs/                    living URS markdown (urs.md) + machine state (urs.json, state.json)
  versions/               versioned URS snapshots (one json per version)
  proposals/              accept/reject/defer proposals (one json per proposal)
  reports/                analysis outputs (one json per changeId, <changeId>.implications.json)
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
`--debounce <ms>`, `--output json|text`, `--dry-run`, `--project <path>`.

## Code layout

Mirrors the review-pipeline feature:

- `src/features/living-spec/cli/` — yargs command registration + handlers, the shared
  `analysisPass` (pipeline back half) and the human-facing `specOutput` renderers
- `src/features/living-spec/pipeline/` — pure domain logic, no CLI concerns:
  `diffExtractor`, `changeBuffer`, `analysisRunner`, `inferenceEngine`, `llmPort`,
  `promptBuilder`, `driftComparator`, `ursPatcher`, `ursModel`, `versionStore`,
  `testDeltaSynthesizer`, `impactSummary`, `driftAlert`
- `src/features/living-spec/watch/` — `WatcherPort` seam + the chokidar provider
- `src/features/living-spec/tools/` — JSON schemas (`implicationSchema`,
  `testDeltaSchema`) + fs persistence (state store, alerts.jsonl), path-glob matching
- `src/features/living-spec/testing/` — fixtures for tests
