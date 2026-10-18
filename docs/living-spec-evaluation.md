# Living-spec Evaluation — Evidence Pack

> **Purpose.** This document is the evaluation + hardening evidence pack for the Living
> Specification Engine (design-science research methodology with a controlled, repeatable
> evaluation). It documents how to reproduce the evaluation, the metrics it computes, the
> test inventory behind the claims, known limitations, and the requirement-to-code-to-test
> mapping (FR1–FR14 / NFR1–NFR10 / SO1–SO5).

## 1. Reproducing the evaluation

The evaluation is fully offline in CI: the default provider is a deterministic
**label-echo provider** (no network, no model) that replays the corpus labels through the
real prompt → parse → STRICT-schema path. A live mode swaps in a local model.

```bash
# 0. prerequisites
npm install

# 1. quality gates (typecheck, lint, the full test suite — all green)
npm run typecheck && npm run lint && npm test

# 2. the controlled evaluation, all three comparison modes (offline, default)
npx tsx src/cli/index.ts spec eval

# 3. one mode only / machine-readable output
#    mode aliases: A = batch, B = single-pass, C = full; `--mode live` = the
#    whole corpus against a real local model (same as --live)
npx tsx src/cli/index.ts spec eval --mode full
npx tsx src/cli/index.ts spec eval --mode A --output json

# 4. live mode — a LOCAL model only (e.g. `ollama serve` running); no public network
npx tsx src/cli/index.ts spec eval --live --provider ollama --model llama3.1
```

Every run writes two artifacts under the target project:

```text
.codexrev/living-spec/reports/eval-<timestamp>.json   # machine-readable EvalReport
.codexrev/living-spec/reports/eval-<timestamp>.md     # rendered Markdown summary tables
```

The corpus lives at `tests/features/living-spec/fixtures/scenarios/*.json` (override with
`--corpus <dir>`); every scenario is plain, reviewable JSON.

## 2. Scenario corpus

14 labelled scenarios; each carries a synthetic before/after diff, the prior living-URS
excerpt, and the expected implications, drift status and test-delta topics.

| Scenario | Family | Expected drift | Refactor probe |
| --- | --- | --- | --- |
| `new-behaviour-greeting` | new behaviour | new | |
| `validation-email-plus-tags` | changed validation rule | modified | |
| `removed-logout-endpoint` | removed behaviour | conflicting | |
| `error-handling-propagate-timeout` | error-handling change | new | |
| `performance-page-size-limit` | performance change | modified | |
| `performance-rate-limiting-added` | performance (new NFR) | new | |
| `api-interface-rename-serialize` | API/interface change | modified | |
| `security-auth-check-added` | security change | new | |
| `security-token-validation-required` | security change (conflict) | conflicting | |
| `aligned-greeting-confirmation` | reaffirmed requirement | aligned | |
| `behaviour-default-currency-change` | default behaviour change | modified | |
| `refactor-only-extract-function` | refactor-only | no-semantic-change | ✔ |
| `refactor-only-rename-variable` | refactor-only | no-semantic-change | ✔ |
| `refactor-only-comment-formatting` | refactor-only | no-semantic-change | ✔ |

Corpus integrity (unique ids, strict field validation, family coverage) is asserted in
`tests/features/living-spec/evaluationHarness.test.ts`.

## 3. Comparison modes (baselines — harness-only, not shipped as user workflows)

All three consume **the same inputs** (same corpus, same synthetic diffs, same prior URS):

| Mode | Definition |
| --- | --- |
| **A · `batch`** | Manual/batch analysis: the deterministic front half only (diff extraction, no model, no URS semantics). The pre-feature floor. |
| **B · `single-pass`** | One code→requirement prompt **without** the prior-URS comparison; the model must also *guess* `driftStatus` from the diff alone. Comparing B with C isolates the drift mechanism (comparator + URS). |
| **C · `full`** | The shipped pipeline with explicit invocation: schema-validated implications → `driftComparator` → scoped proposals → test deltas → drift alerts. |

On the CLI these are `--mode A|B|C` (aliases `batch` / `single-pass` / `full`);
`--mode live` (or `--live`) runs them against a real local model.

## 4. Metrics

| Metric | Definition / computation |
| --- | --- |
| Implication precision / recall / F1 | Greedy expected↔predicted matching by token-overlap (Jaccard ≥ 0.4 `matchThreshold`); micro-averaged per mode. |
| Drift classification accuracy | Share of scenarios where the predicted overall `driftStatus` equals the label. |
| False-alert rate | Refactor-only scenarios that raise ≥ 1 drift alert (would have been a false alarm for a human). |
| Update correctness | Scoped-sections check per proposal: `validatePatch` passes, `modify` ops target existing sections and `add` ops target new ones, `sectionsTouched` equals the ops' sections, applying the patch leaves every **unlisted** section byte-identical (SO4), and proposals appear **iff** the overall drift is actionable. |
| Test-delta relevance | Rule-match: fraction of expected topics whose tokens all appear in the generated deltas (title/steps/expected/rationale/preconditions). Live mode may use an LLM judge (`{"score": 0..1}`) with automatic fallback to rule-match. |
| Latency (median, P95) | Wall-clock ms per scenario per mode; median and nearest-rank P95. |
| Peak RSS | Maximum `process.memoryUsage().rss` sampled after each scenario (process-wide upper bound during the run). |

## 5. Results (offline run, this repository)

Command: `npx tsx src/cli/index.ts spec eval` (label-echo provider, all modes, 14
scenarios × 3 modes = 42 runs). Numbers vary slightly per machine; the JSON report in
`reports/` carries the per-scenario rows.

| Mode | Implication P | R | F1 | Drift acc. | False-alert rate | Update correct. | Δ relevance | Latency med / P95 (ms) | Peak RSS (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| batch | 0.0% | 0.0% | 0.0% | 21.4% | 0.0% (3 refactor) | n/a | 0.21 | 0.0 / 0.0 | 188.7 |
| single-pass | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% (3 refactor) | n/a | 0.89 | 0.2 / 25.0 | 188.7 |
| full | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% (3 refactor) | 100.0% | 0.89 | 0.2 / 1.0 | 188.7 |

**Reading these numbers honestly:**

- The offline provider echoes the corpus **labels**, so this run validates the *measurement
  apparatus*, not model intelligence: the schema paths, the comparator (mode C classifies
  echoed implications against the real prior URS — including `conflicting`, `modified` and
  `aligned`), the scoped-patch checker, and the alert/refactor logic all behave as designed.
- Mode A is the floor by construction: no semantic half → 0% recall and drift accuracy only
  from chance (3/14 scenarios are legitimately `no-semantic-change` → 21.4%).
- B vs C differences only emerge with a **real model**: run `--live` (local Ollama) to
  collect model-quality numbers for the report; no public-network calls are involved.

## 6. Test inventory

`tests/features/living-spec/` — **29 files, 262 tests, all green** (`npm test`).

| Test file | Tests | Covers |
| --- | --- | --- |
| `changeBuffer.test.ts` | 12 | debounce, hash dedupe (NFR3), grouped emit, changeId |
| `diffExtractor.test.ts` | 16 | exact line numbers, minimal view, glob filtering, truncation guard |
| `driftComparator.test.ts` | 12 | new/aligned/modified/conflicting classification (FR7/SO3) |
| `implicationSchema.test.ts` | 11 | strict model-output schema (NFR5) |
| `inferenceEngine.test.ts` | 9 | prompt → LLM → parse → validate, timeout/failure policy |
| `promptBuilder.test.ts` | 7 | prompt injection hardening, deterministic assembly |
| `pathMatcher.test.ts` | 7 | glob matching, always-excluded paths |
| `stateStore.test.ts` | 16 | config schema, URS read/write, proposals, reports, atomic write |
| `ursPatcher.test.ts` | 15 | scoped patch generation/apply, validatePatch (SO4) |
| `versionStore.test.ts` | 3 | version snapshots + traceability (NFR7) |
| `pdfRenderer.test.ts` | 5 | hand-rolled PDF: xref byte accuracy, pagination, WinAnsi/escaping |
| `reportHtml.test.ts` | 9 | interactive HTML artifact: naming, all details, XSS escaping, offline self-containment, CLI e2e |
| `ursBootstrap.test.ts` | 11 | bootstrap scan/prompt/sanitisation, approval gate, dual-format v0 |
| `contract.test.ts` | 3 | stable `SpecAnalysisResult` JSON round-trip, every field |
| `registerSpecCommand.test.ts` | 11 | yargs flags incl. bootstrap/eval, help text |
| `specAnalyzeCli.test.ts` | 6 | analyze end-to-end (report JSON, dry-run, json mode) |
| `specAnalyzeInference.test.ts` | 6 | inference wiring, failure policy, offline guard (NFR2/FR14) |
| `ursGateCli.test.ts` | 5 | accept/reject/defer human gate (NFR4), status listing |
| `watchSession.test.ts` | 1 | foreground watch, report writing, clean shutdown |
| `testDeltaSynthesizer.test.ts` | 15 | rule deltas per category, LLM fallback, links (FR10/SO5) |
| `impactSummary.test.ts` | 5 | file/line refs match the diff (FR11) |
| `driftAlert.test.ts` | 4 | NFR6 alert fields, alerts.jsonl append, e2e alert |
| `analyzeOutputContract.test.ts` | 2 | every contract field populated or explicitly null |
| `reportRenderer.test.ts` | 21 | aligned tables, failure-path messages, status/history/decisions |
| `specSessionState.test.ts` | 15 | watch reducer, counts, dedupe signal, shutdown summary |
| `specHelp.test.ts` | 6 | hand-rolled help screen + dispatch + exit codes 0/2 |
| `evaluationHarness.test.ts` | 15 | corpus validation, metric math, mode comparison, report |
| `evalCli.test.ts` | 6 | `spec eval` offline run, json mode, bad usage, missing corpus |
| `hardening.test.ts` | 8 | failure-path sweep (below) |

**Failure-path hardening sweep** (`hardening.test.ts` + the suites it pairs with):

| Path | Covered by |
| --- | --- |
| Malformed model output | `specAnalyzeInference.test.ts` (malformed + schema-invalid), `evaluationHarness.test.ts` (eval malformed), `ursBootstrap.test.ts` (bootstrap malformed — nothing written) |
| Model timeout | `hardening.test.ts` → structured `timeout`, deterministic result stands; `evaluationHarness.test.ts` (eval timeout) |
| Model-server unavailable | `hardening.test.ts` → `provider_unavailable` + actionable hint; `ursBootstrap.test.ts` (bootstrap: "start ollama / lm studio", nothing written) |
| Unsupported file type | `hardening.test.ts` → clean zero-file analysis |
| Missing prior URS | `hardening.test.ts` → `new` classification + scoped `req-*` proposals |
| Oversized diff | `hardening.test.ts` → truncation flagged with `maxBytes` hint (parser: `diffExtractor.test.ts`) |
| Repeated save events (≥95% deduped) | `hardening.test.ts` → 101 events → 2 batches, ≥95% suppressed (semantics: `changeBuffer.test.ts`) |
| Crash mid-URS-write | `hardening.test.ts` → previous URS intact (atomic rename seam) |
| Offline (zero external HTTP) | `hardening.test.ts` → full analyze with injected provider never calls `fetch` (offline guard: `specAnalyzeInference.test.ts`) |

## 7. Known limitations

1. **Offline mode measures the apparatus, not the model.** The label-echo provider
   guarantees reproducible plumbing metrics; model-quality numbers require `--live`
   against a local model (Ollama/LM Studio — never a public endpoint in this study).
2. **Corpus size.** 14 synthetic scenarios are descriptive evidence, not a statistically
   powered study; conclusions are about mechanism correctness, not population quality.
3. **Text-match threshold.** Implication matching uses Jaccard ≥ 0.4; valid paraphrases
   below the threshold count as misses (threshold is recorded in every report).
4. **LLM-judge** for delta relevance runs only in live mode, with automatic fallback to
   rule-match when the judge output is not a valid score.
5. **Baseline A is a floor by construction** (no semantic half); it exists to quantify the
   feature's delta over the pre-feature status quo, not as a competitive system.
6. **Offline latency** measures harness overhead (no model round-trip); real latency
   budgets must be read from `--live` reports (median + P95 are reported either way).
7. **Peak RSS is process-wide** (includes Node/Vitest baseline) — useful as a bound, not
   as an allocation profile.
8. **Requirement ids without code citations.** The FR/NFR/SO texts are not stored in this
   repository; ids cited verbatim in code comments are marked *cited* below, the rest are
   *mapped* to the closest implemented capability — verify titles against the
   authoritative specification.
9. `npm run typecheck` covers `src/`, `scripts/` and non-`.test.ts` files; vitest test
   files are excluded from `tsc` (repo-wide tsconfig choice) and are validated by running
   them.

## 8. Requirement → implementation → test mapping

Evidence column: **cited** = the id appears in a code comment of the listed file;
**mapped** = the id is not cited in this repository (closest capability, see limitation 8).

### FR1–FR14

| Id | Evidence | Capability | Implementation files | Representative tests |
| --- | --- | --- | --- | --- |
| FR1 | mapped | Living URS as a maintained artifact (seed/parse/render/state) | `pipeline/ursModel.ts`, `tools/stateStore.ts` | `stateStore.test.ts`, `contract.test.ts` |
| FR2 | mapped | Diff extraction from git refs with exact line numbers | `pipeline/diffExtractor.ts`, `pipeline/analysisRunner.ts` | `diffExtractor.test.ts`, `specAnalyzeCli.test.ts` |
| FR3 | mapped | Stable change id (hash of ref + files + diff) | `pipeline/changeBuffer.ts` (`computeChangeId`) | `changeBuffer.test.ts`, `specAnalyzeCli.test.ts` |
| FR4 | mapped | Requirement implication inference (prompt → model → strict schema) | `pipeline/inferenceEngine.ts`, `pipeline/promptBuilder.ts`, `tools/implicationSchema.ts` | `inferenceEngine.test.ts`, `promptBuilder.test.ts`, `implicationSchema.test.ts` |
| FR5 | mapped | URS patch artifact in the report (`ursPatch`) | `pipeline/ursPatcher.ts`, `pipeline/analysisRunner.ts` | `contract.test.ts`, `ursPatcher.test.ts` |
| FR6 | mapped | Proposal decision workflow: status / history / accept / reject / defer | `cli/handleSpecCommand.ts`, `cli/reportRenderer.ts` | `ursGateCli.test.ts`, `reportRenderer.test.ts` |
| FR7 | cited (`driftComparator.ts`) | Drift classification semantics | `pipeline/driftComparator.ts` | `driftComparator.test.ts` |
| FR8 | cited (`ursPatcher.ts`) | Update proposals generated from drift | `pipeline/ursPatcher.ts` | `ursPatcher.test.ts` |
| FR9 | cited (`driftAlert.ts`, `types.ts`, `stateStore.ts`) | Drift alerts per conflicting/modified detection | `pipeline/driftAlert.ts`, `tools/stateStore.ts` | `driftAlert.test.ts` |
| FR10 | cited (`types.ts`, `testDeltaSynthesizer.ts`) | Incremental test-case deltas | `pipeline/testDeltaSynthesizer.ts`, `tools/testDeltaSchema.ts` | `testDeltaSynthesizer.test.ts` |
| FR11 | cited (`impactSummary.ts`, `types.ts`) | Change-impact summary | `pipeline/impactSummary.ts` | `impactSummary.test.ts` |
| FR12 | cited (`ursPatcher.ts`) | Scoped proposal metadata (drift, sections, rationale) | `pipeline/ursPatcher.ts` | `ursPatcher.test.ts`, `ursGateCli.test.ts` |
| FR13 | cited (`ursPatcher.ts`, `handleSpecCommand.ts`) | Human gate: proposals decided explicitly | `cli/handleSpecCommand.ts`, `pipeline/versionStore.ts` | `ursGateCli.test.ts` |
| FR14 | cited (`llmPort.ts`) | Offline operation (local providers only) | `pipeline/llmPort.ts` | `hardening.test.ts` (zero HTTP), `specAnalyzeInference.test.ts` (offline guard) |

### NFR1–NFR10

| Id | Evidence | Capability | Implementation files | Representative tests |
| --- | --- | --- | --- | --- |
| NFR1 | mapped | Bounded latency per analysis (measured, reported) | `testing/evaluationHarness.ts` (median/P95), `cli/analysisPass.ts` | `evaluationHarness.test.ts` |
| NFR2 | cited (`llmPort.ts`) | Local-only provider guarantee for offline runs | `pipeline/llmPort.ts` (`LOCAL_PROVIDER_IDS`) | `specAnalyzeInference.test.ts`, `hardening.test.ts` |
| NFR3 | cited (`changeBuffer.ts`) | Save events processed exactly once (dedupe) | `pipeline/changeBuffer.ts`, `cli/specSessionState.ts` | `changeBuffer.test.ts`, `hardening.test.ts` (≥95%), `specSessionState.test.ts` |
| NFR4 | cited (`inferenceEngine.ts`, `ursPatcher.ts`, `analysisPass.ts`) | Nothing authoritative without explicit accept | `cli/analysisPass.ts`, `cli/handleSpecCommand.ts` | `ursGateCli.test.ts`, `specAnalyzeInference.test.ts` |
| NFR5 | cited (`inferenceEngine.ts`, `reportRenderer.ts`) | Invalid model output is never applied | `pipeline/inferenceEngine.ts`, `tools/implicationSchema.ts` | `specAnalyzeInference.test.ts`, `implicationSchema.test.ts`, `hardening.test.ts` |
| NFR6 | cited (`driftAlert.ts`, `stateStore.ts`) | Alert shape + append-only alert log | `pipeline/driftAlert.ts`, `tools/stateStore.ts` | `driftAlert.test.ts`, `analyzeOutputContract.test.ts` |
| NFR7 | cited (`versionStore.ts`, `types.ts`) | Version history traceable to change ids | `pipeline/versionStore.ts` | `versionStore.test.ts`, `ursGateCli.test.ts` |
| NFR8 | mapped | Bounded output surfaces (logs, alert tails, status lists) | `cli/specSessionState.ts`, `cli/reportRenderer.ts`, `cli/handleSpecCommand.ts` | `specSessionState.test.ts`, `reportRenderer.test.ts` |
| NFR9 | mapped | Deterministic, reproducible rendering and prompts | `cli/reportRenderer.ts`, `pipeline/promptBuilder.ts` | `reportRenderer.test.ts`, `promptBuilder.test.ts` |
| NFR10 | cited (`llmPort.ts`) | Swappable provider/model per run | `pipeline/llmPort.ts` | `specAnalyzeInference.test.ts` (default model/label), `registerSpecCommand.test.ts` (flags) |

### SO1–SO5

| Id | Evidence | Capability | Implementation files | Representative tests |
| --- | --- | --- | --- | --- |
| SO1 | mapped | State confined to `<project>/.codexrev/living-spec/` | `tools/stateStore.ts` | `stateStore.test.ts`, `specAnalyzeCli.test.ts` (layout on demand) |
| SO2 | mapped | Analysis only via explicit commands (no daemon/hooks) | `cli/handleSpecCommand.ts`, `cli/runWatchSession.ts` | `watchSession.test.ts`, `registerSpecCommand.test.ts` |
| SO3 | cited (`driftComparator.ts`) | Comparison against the living URS | `pipeline/driftComparator.ts` | `driftComparator.test.ts` |
| SO4 | cited (`ursPatcher.ts`, `versionStore.ts`, `types.ts`) | Patches touch only their own sections | `pipeline/ursPatcher.ts`, `pipeline/versionStore.ts` | `ursPatcher.test.ts`, `evaluationHarness.test.ts` (`checkUpdateCorrectness`) |
| SO5 | cited (`types.ts`, `testDeltaSynthesizer.ts`) | Deltas are incremental, never a full test plan | `pipeline/testDeltaSynthesizer.ts` | `testDeltaSynthesizer.test.ts`, `contract.test.ts` |

---

*Generated for the university review alongside the code on `feature/f1-living-spec-engine`.
Regenerate the numbers any time with `npx tsx src/cli/index.ts spec eval` and re-run the
suite with `npm test`.*
