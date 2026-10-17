/**
 * Drives one `codexrev safety assess` run. Split out from the handler so it
 * can be tested without yargs, like runReviewSession in the review feature.
 *
 *   validate request -> collect evidence (read-only) -> local-model interpretation (advisory)
 *   -> assessAction: four factor assessors -> safety calculus -> Critical Safety Gates
 *   -> Decision Engine -> interpretation policy -> final decision
 *
 * The coordinator does the thinking; this file only sequences I/O around it.
 * It never runs, deploys, rolls back or migrates anything, never runs tests or
 * builds, and writes no files. Signed Evidence Packs do not exist yet, so
 * `--output` is acknowledged and reported as unavailable, never silently
 * ignored and never satisfied with an unsigned artifact.
 */

import { collectEvidence, type EvidenceBundle } from '../collectors/evidenceOrchestrator.js';
import { runContextInterpretation } from '../interpretation/interpreter.js';
import type { ContextInterpretation } from '../interpretation/types.js';
import { assessAction, type AssessmentOutcome, type AssessmentPolicy } from '../pipeline/assessmentCoordinator.js';
import { SafetyInputError, loadAssessmentRequest, type AssessmentFlags, type AssessmentRequest } from './assessmentInput.js';

export type StageStatus = 'connected' | 'implemented_not_connected' | 'not_implemented';

export interface PipelineStage {
  readonly name: string;
  readonly status: StageStatus;
  readonly note: string;
}

/** Honest status of the full pipeline. Only the signed Evidence Pack is still missing. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  { name: 'Proposed action input', status: 'connected', note: 'flags and --input file are validated' },
  { name: 'Evidence collection', status: 'connected', note: 'read-only collectors; test, security, authority and recovery evidence must be supplied through --input' },
  { name: 'Local LLM contextual interpretation', status: 'connected', note: 'advisory only: unverified observations from the configured local model; it can be unavailable' },
  { name: 'Four factor assessments', status: 'connected', note: 'reversibility, blast radius, authority, evidence strength' },
  { name: 'Weighted safety score', status: 'connected', note: 'provisional equal weights' },
  { name: 'Critical safety gates', status: 'connected', note: 'four gates, independent of the score' },
  { name: 'Final decision', status: 'connected', note: 'score thresholds, then gates, then the interpretation policy' },
  { name: 'Signed Evidence Pack', status: 'not_implemented', note: 'Evidence Pack generation and Ed25519 signing' },
];

export interface AssessmentSessionOptions {
  readonly cwd: string;
  readonly flags: AssessmentFlags;
  /** ISO time for the run; defaults to the current time. Injectable so results are reproducible in tests. */
  readonly now?: string;
  /** replaces the real interpretation step (tests); by default the configured local model is used */
  readonly interpreter?: (bundle: EvidenceBundle) => Promise<ContextInterpretation>;
  /** overrides for weights, thresholds and policies (tests, research); defaults are the provisional ones */
  readonly policy?: Partial<AssessmentPolicy>;
}

export interface AssessmentSessionResult {
  /** completed = a decision was reached; incomplete = a mandatory interpretation was missing; failed = no decision */
  readonly status: 'completed' | 'incomplete' | 'failed';
  readonly request: AssessmentRequest;
  /** everything the collectors found; read-only observations and supplied records */
  readonly evidence: EvidenceBundle;
  /** advisory, unverified observations from the local model, or the reason there are none */
  readonly interpretation: ContextInterpretation;
  /** the full assessment, or a failure that carries no decision */
  readonly assessment: AssessmentOutcome;
  readonly stages: readonly PipelineStage[];
  /** `--output` is accepted but cannot be honoured until Evidence Packs are signed */
  readonly evidencePack: { readonly written: false; readonly requestedPath?: string; readonly reason: string };
}

const EVIDENCE_PACK_REASON =
  'Signed Evidence Pack output is not available yet: signing is not implemented, so nothing was written. No unsigned artifact is produced or labelled as signed.';

export async function runAssessmentSession(opts: AssessmentSessionOptions): Promise<AssessmentSessionResult> {
  const request = await loadAssessmentRequest(opts.flags, opts.cwd);
  // the clock is read here, at the CLI boundary, and nowhere inside the collectors or the coordinator
  const now = opts.now ?? new Date().toISOString();

  const evidence = await collectEvidence({ cwd: opts.cwd, request, now });
  // a --diff revision that cannot be used is the user's mistake, not "missing evidence"
  if (evidence.git.diffRefError) throw new SafetyInputError(evidence.git.diffRefError);

  // advisory only: it is passed to the coordinator, which lets it matter in exactly one way
  // (a policy that makes it mandatory), and then only to make the decision stricter
  let interpretation: ContextInterpretation;
  try {
    interpretation = opts.interpreter
      ? await opts.interpreter(evidence)
      : await runContextInterpretation({ cwd: opts.cwd, bundle: evidence });
  } catch (err) {
    interpretation = {
      status: 'ERROR',
      schemaVersion: 1,
      failureKind: 'unexpected',
      reason: `interpretation failed unexpectedly: ${String((err as Error)?.message ?? err).split('\n')[0].slice(0, 300)}`,
      observations: [],
      rejectedObservations: [],
      injectionIndicators: [],
      limitations: [],
      advisoryOnly: true,
    };
  }

  const inputPolicy = request.input?.interpretationPolicy;
  const assessment = assessAction({
    bundle: evidence,
    interpretation,
    now,
    policy: { ...(inputPolicy ? { interpretation: inputPolicy } : {}), ...opts.policy },
  });

  return {
    status: assessment.status === 'FAILED' ? 'failed' : assessment.status === 'COMPLETED' ? 'completed' : 'incomplete',
    request,
    evidence,
    interpretation,
    assessment,
    stages: PIPELINE_STAGES,
    evidencePack: { written: false, ...(request.outputPath ? { requestedPath: request.outputPath } : {}), reason: EVIDENCE_PACK_REASON },
  };
}
