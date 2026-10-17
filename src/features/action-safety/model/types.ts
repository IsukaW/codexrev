/**
 * Domain types for Feature 4 (Action-Safety). Types only, no behaviour.
 *
 * A "proposed action" is something a person or agent WANTS to do (deploy,
 * roll back, migrate...). Feature 4 judges it before anything runs; it never
 * executes the action itself.
 */

export const ACTION_TYPES = [
  'deployment',
  'rollback',
  'database_migration',
  'configuration_change',
  'dependency_upgrade',
  'code_change',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const TARGET_ENVIRONMENTS = ['development', 'testing', 'staging', 'production'] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

/** low -> high. Used by policy to say "recovery is required from medium impact up". */
export const IMPACT_LEVELS = ['low', 'medium', 'high'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export interface ActionIdentity {
  readonly id: string;
  readonly type: ActionType;
  readonly description: string;
}

export interface ProposedAction {
  readonly identity: ActionIdentity;
  readonly environment: TargetEnvironment;
  readonly impact: ImpactLevel;
  /** true when the action cannot be undone by normal means (e.g. dropping a column) */
  readonly irreversible: boolean;
}

export const ACTOR_KINDS = ['human', 'service', 'agent'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface ActorIdentity {
  readonly id: string;
  readonly kind: ActorKind;
  readonly roles: readonly string[];
}

/** Status of one piece of supporting evidence. UNKNOWN means "we could not tell", never "fine". */
export const EVIDENCE_STATUSES = ['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/**
 * Where a piece of evidence came from, most to least trustworthy. Evidence
 * with no stated source is treated as self_declared (i.e. not verified).
 */
export const EVIDENCE_SOURCES = ['verified_system', 'automated_tool', 'human_attested', 'self_declared'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** One evidence record: its status plus pointers (file paths, ids, URLs) to where it came from. */
export interface EvidenceItem {
  readonly status: EvidenceStatus;
  readonly refs?: readonly string[];
  /** ISO-8601 time the evidence was produced. Used by the factor assessors for freshness; the gates ignore it. */
  readonly observedAt?: string;
  readonly source?: EvidenceSource;
}

export interface AuthorityContext {
  readonly actor: ActorIdentity;
  /** is the actor allowed to perform this action? absent = nobody recorded a check */
  readonly authorization?: EvidenceItem;
}

/** Evidence gathered about the action. Each field absent = that evidence was never collected. */
export interface EvidenceSnapshot {
  /** build and test results for the change */
  readonly buildTests?: EvidenceItem;
  /** general supporting evidence (security findings, reviews, dependency checks...) */
  readonly supporting?: EvidenceItem;
  /** a rollback/recovery plan that has been verified to work */
  readonly recovery?: EvidenceItem;
}

/** A normalized factor value, always in [0, 1]. See SafetyFactors for what 0 and 1 mean per factor. */
export type NormalizedScore = number;

/**
 * The four safety factors, each in [0, 1]. They do NOT all point the same way:
 *   - reversibility (R):     0 = hard or impossible to undo,  1 = safely reversible
 *   - blastRadius (B):       0 = very limited impact,         1 = widespread / critical impact
 *   - authority (A):         0 = insufficient authority,      1 = fully verified authority
 *   - evidenceStrength (E):  0 = insufficient evidence,       1 = strong, reliable evidence
 *
 * So blastRadius is HIGHER = RISKIER. The research formula therefore uses
 * (1 - B):  SafetyScore = alpha*R + beta*(1 - B) + gamma*A + delta*E.
 * Not used by the gates.
 */
export interface SafetyFactors {
  readonly reversibility: NormalizedScore; // R
  readonly blastRadius: NormalizedScore; // B (higher = riskier)
  readonly authority: NormalizedScore; // A
  readonly evidenceStrength: NormalizedScore; // E
}

export type FactorId = keyof SafetyFactors;

/** One line of a score's arithmetic: value (0..1) times its share of the total weight. */
export interface ScoreComponent {
  readonly name: string;
  /** the component's own 0..1 value */
  readonly value: number;
  /** weight from the configuration */
  readonly weight: number;
  /** weight after dropping components that did not apply and rescaling the rest to sum to 1 */
  readonly effectiveWeight: number;
  /** value * effectiveWeight, so the contributions add up to the pre-adjustment score */
  readonly contribution: number;
  /** false when this component was left out (e.g. nothing of this kind was required) */
  readonly applied: boolean;
  readonly note: string;
}

/** A rule applied after the weighted average (a cap, a penalty or a floor). */
export interface ScoreAdjustment {
  readonly name: string;
  readonly before: number;
  readonly after: number;
  readonly reason: string;
}

/** What every factor assessor returns. Explains the score instead of just giving a number. */
export interface FactorAssessment {
  readonly factor: FactorId;
  readonly score: NormalizedScore;
  readonly explanation: string;
  readonly evidenceRefs: readonly string[];
  /** evidence or inputs that were expected but not provided */
  readonly missing: readonly string[];
  /** evidence that was provided but is unknown, stale, untrusted or not applicable when it should be */
  readonly uncertain: readonly string[];
  /** evidence that contradicts other evidence */
  readonly conflicts: readonly string[];
  readonly breakdown: readonly ScoreComponent[];
  readonly adjustments: readonly ScoreAdjustment[];
}

export const DECISIONS = ['ALLOW', 'ESCALATE', 'BLOCK'] as const;
export type Decision = (typeof DECISIONS)[number];

export type GateId =
  | 'AUTHORIZATION'
  | 'VERIFIED_RECOVERY'
  | 'BUILD_TEST_RESULTS'
  | 'SUPPORTING_EVIDENCE';

/** NOT_APPLICABLE is only produced when policy says the gate is not required. */
export type GateStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE';

/** What a non-passing gate forces: at least ESCALATE, or BLOCK. */
export type GateConsequence = 'BLOCK' | 'ESCALATE';

export interface GateResult {
  readonly gate: GateId;
  readonly status: GateStatus;
  readonly explanation: string;
  readonly evidenceRefs: readonly string[];
  readonly consequence: GateConsequence;
}
