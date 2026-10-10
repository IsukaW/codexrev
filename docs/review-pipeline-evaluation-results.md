# Review Pipeline Evaluation Results

Run 2026-09-03T05:42:02.598Z · provider `ollama` · model `gemma4:12b-mlx`

Small-scale, real (not fabricated) measurement — NOT the full Juliet Test Suite / NIST SARD corpus, and NOT a local-vs-cloud comparison (see this file's footer for what remains undone and why).

**5 of 5 runs errored** (see "Errored runs" below) and are excluded from every metric — a crashed run is never counted as a pass. This is the third live attempt against the local model available in the environment this was run in; the first two surfaced and fixed two real bugs (a harness bug that silently misreported a crash as a clean pass, and a too-short 10-minute default request timeout) — see the Decision Log. This third run hit a third, different failure: the Ollama backend itself became unreachable (`ollama ps` showed nothing loaded, `ollama serve`'s own process still running but not serving) after the very first role of the very first fixture, most plausibly the local model runner being killed under sustained resource pressure on modest hardware rather than anything this codebase controls. The harness performed exactly as intended here — every one of the 5 runs failed fast and was excluded, with zero fabricated numbers. Re-running this script (`npx tsx scripts/evaluateReviewPipeline.ts`) once the local model/machine has more headroom (or against a cloud provider via `--provider openai`, etc.) should produce real numbers; nothing about the harness itself needs further changes based on this run.

| Metric | Value |
|---|---|
| Detection accuracy | 0/0 (n/a) |
| False-positive rate | 0/0 (n/a) |
| Avg. latency per full six-role scan | n/a (target: ≤5 min) |
| Breaker-Builder convergence rate | n/a (not measured — run errored) |

## Per-fixture detail

| Fixture | Expected role | Flagged? | Flagged by | Latency |
|---|---|---|---|---|

Convergence fixture: errored — Pipeline did not complete for the convergence fixture (outcome: errored, 0/6 roles ran): Connection error. — could not reach ollama at http://localhost:11434/v1. Start the Ollama daemon with `ollama serve` (or the desktop app).

## Errored runs (excluded above, not treated as a pass)

- **SQL injection**: Pipeline did not complete for fixture "SQL injection" (outcome: errored, 1/6 roles ran): Connection error. — could not reach ollama at http://localhost:11434/v1. Start the Ollama daemon with `ollama serve` (or the desktop app).
- **Buffer overflow (unchecked write length)**: Pipeline did not complete for fixture "Buffer overflow (unchecked write length)" (outcome: errored, 0/6 roles ran): Connection error. — could not reach ollama at http://localhost:11434/v1. Start the Ollama daemon with `ollama serve` (or the desktop app).
- **Off-by-one (inclusive bound past array end)**: Pipeline did not complete for fixture "Off-by-one (inclusive bound past array end)" (outcome: errored, 0/6 roles ran): Connection error. — could not reach ollama at http://localhost:11434/v1. Start the Ollama daemon with `ollama serve` (or the desktop app).
- **Clean baseline (no injected issue)**: Pipeline did not complete for fixture "Clean baseline (no injected issue)" (outcome: errored, 0/6 roles ran): Connection error. — could not reach ollama at http://localhost:11434/v1. Start the Ollama daemon with `ollama serve` (or the desktop app).

## Not covered by this run

- **Full Juliet Test Suite / NIST SARD benchmark** — not bundled with this repo; this script's 4 hand-written fixtures are a small illustrative sample, not that corpus.
- **Local-vs-cloud comparison** — re-run this script with `--provider openai` (or another configured cloud provider) and diff the two results tables.
