/**
 * Parsing and validation for `codexrev safety assess`: the --action/--target
 * flags plus the optional --input JSON file.
 *
 * Nothing is invented. Anything the user does not supply stays undefined
 * (for example the action's impact or whether it is irreversible), because the
 * later stages must treat missing information as missing, not as safe.
 *
 * Two error kinds, matching how the CLI reports them:
 *   SafetyUsageError - wrong or missing command-line arguments (exit code 2, usage shown)
 *   SafetyInputError - the input file is unreadable or invalid (exit code 1)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CodexrevError } from '../../../utils/errors.js';
import {
  ACTION_TYPES,
  ACTOR_KINDS,
  EVIDENCE_SOURCES,
  EVIDENCE_STATUSES,
  IMPACT_LEVELS,
  TARGET_ENVIRONMENTS,
  type ActionType,
  type ActorIdentity,
  type EvidenceItem,
  type EvidenceSnapshot,
  type ImpactLevel,
  type TargetEnvironment,
} from '../model/types.js';
import type { GatePolicy } from '../calculus/gates.js';
import { DEFAULT_BLAST_RADIUS_CONFIG, type ComponentCriticality, type ImpactScope } from '../calculus/blastRadius.js';
import type { InterpretationPolicy } from '../interpretation/policy.js';

export class SafetyUsageError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_ACTION_SAFETY_USAGE_ERROR', false);
    this.name = 'SafetyUsageError';
  }
}

export class SafetyInputError extends CodexrevError {
  constructor(message: string) {
    super(message, 'CODEXREV_ACTION_SAFETY_INPUT_ERROR', false);
    this.name = 'SafetyInputError';
  }
}

/** Raw flags as yargs hands them over: any of these may be absent or the wrong type. */
export interface AssessmentFlags {
  action?: unknown;
  target?: unknown;
  input?: unknown;
  diff?: unknown;
  output?: unknown;
}

/** Evidence claims typed into the input file. Claims, not proof: the collectors cap their trust. */
export interface InputEvidence extends EvidenceSnapshot {
  readonly dependencyCompatibility?: EvidenceItem;
  readonly securityFindings?: EvidenceItem;
}

export interface InputApproval {
  readonly approverId: string;
  /** PASS = approved, FAIL = explicitly rejected */
  readonly evidence: EvidenceItem;
}

export interface InputAuthority {
  readonly authorization?: EvidenceItem;
  readonly humanApproval?: EvidenceItem;
  /** proof of who the actor is */
  readonly identityVerification?: EvidenceItem;
  readonly requiredRoles?: readonly string[];
  readonly requiredPermissions?: readonly string[];
  readonly grantedPermissions?: { readonly permissions: readonly string[]; readonly evidence?: EvidenceItem };
  readonly requiredApprovals?: number;
  readonly approvals?: readonly InputApproval[];
}

/** Paths (inside the project) of report files that already exist. Nothing is run to produce them. */
export interface InputReports {
  readonly buildTests?: readonly string[];
  readonly security?: readonly string[];
}

export interface InputRecovery {
  /** PASS = a rollback procedure is documented (not proof it works) */
  readonly rollbackPlan?: EvidenceItem;
  /** PASS = the rollback was actually exercised successfully */
  readonly rollbackTest?: EvidenceItem;
  /** PASS = a backup / recovery point exists */
  readonly backup?: EvidenceItem;
}

/**
 * Impact dimensions git cannot observe, STATED by whoever wrote the input file.
 * They are estimates, not evidence; anything left out stays unknown and is
 * scored as risky.
 */
export interface StatedBlastRadius {
  readonly criticality?: ComponentCriticality;
  readonly scope?: ImpactScope;
  readonly sharedModulesModified?: number;
  readonly dependencyReach?: number;
  readonly affectedServiceCount?: number;
}

/** Shape of the optional --input file. Every section is optional; unknown fields are rejected so typos are caught. */
export interface AssessmentInputFile {
  readonly action?: {
    readonly id?: string;
    readonly description?: string;
    readonly impact?: ImpactLevel;
    readonly irreversible?: boolean;
    readonly destructive?: boolean;
    readonly blastRadius?: StatedBlastRadius;
  };
  readonly actor?: ActorIdentity;
  readonly authority?: InputAuthority;
  readonly evidence?: InputEvidence;
  readonly reports?: InputReports;
  readonly recovery?: InputRecovery;
  readonly policy?: GatePolicy;
  /** whether a missing or unusable local-model interpretation prevents ALLOW. Advisory when omitted. */
  readonly interpretationPolicy?: InterpretationPolicy;
}

/** A validated request. Only actionType and environment are guaranteed; the rest is what the user actually gave. */
export interface AssessmentRequest {
  readonly actionType: ActionType;
  readonly environment: TargetEnvironment;
  /** git ref to compare against; recorded only, nothing reads git yet */
  readonly diffRef?: string;
  /** absolute path of the --input file, if given */
  readonly inputPath?: string;
  readonly input?: AssessmentInputFile;
  /** where the Evidence Pack should eventually be written; nothing is written yet */
  readonly outputPath?: string;
}

// ---------------------------------------------------------------- flags

function requiredFlag(name: string, value: unknown, valid?: readonly string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SafetyUsageError(`--${name} is required${valid ? ` (one of: ${valid.join(', ')})` : ''}.`);
  }
  return value.trim();
}

function optionalFlag(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SafetyUsageError(`--${name} needs a non-empty value.`);
  }
  return value.trim();
}

// accepts "database-migration" as well as "database_migration", any case
function pick<T extends string>(name: string, raw: string, valid: readonly T[]): T {
  const normalized = raw.toLowerCase().replace(/-/g, '_');
  const hit = valid.find((v) => v === normalized);
  if (!hit) throw new SafetyUsageError(`unknown --${name} "${raw}". Valid values: ${valid.join(', ')}.`);
  return hit;
}

/** Validates only the command-line flags (no file access). */
export function validateAssessmentFlags(flags: AssessmentFlags): {
  actionType: ActionType;
  environment: TargetEnvironment;
  inputFlag?: string;
  diffRef?: string;
  outputFlag?: string;
} {
  const actionType = pick('action', requiredFlag('action', flags.action, ACTION_TYPES), ACTION_TYPES);
  const environment = pick('target', requiredFlag('target', flags.target, TARGET_ENVIRONMENTS), TARGET_ENVIRONMENTS);
  return {
    actionType,
    environment,
    inputFlag: optionalFlag('input', flags.input),
    diffRef: optionalFlag('diff', flags.diff),
    outputFlag: optionalFlag('output', flags.output),
  };
}

// ---------------------------------------------------------------- input file

type Rec = Record<string, unknown>;

function isRecord(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function fail(at: string, detail: string): never {
  throw new SafetyInputError(`invalid input at "${at}": ${detail}`);
}

function record(at: string, x: unknown, allowed: readonly string[]): Rec {
  if (!isRecord(x)) fail(at, 'expected an object');
  for (const k of Object.keys(x as Rec)) {
    if (!allowed.includes(k)) fail(`${at}.${k}`, `unknown field (allowed: ${allowed.join(', ')})`);
  }
  return x as Rec;
}

function nonEmptyString(at: string, x: unknown): string {
  if (typeof x !== 'string' || x.trim() === '') fail(at, 'expected a non-empty string');
  return x as string;
}

function bool(at: string, x: unknown): boolean {
  if (typeof x !== 'boolean') fail(at, 'expected true or false');
  return x as boolean;
}

function oneOf<T extends string>(at: string, x: unknown, valid: readonly T[]): T {
  if (typeof x !== 'string' || !(valid as readonly string[]).includes(x)) fail(at, `expected one of ${valid.join(', ')}`);
  return x as T;
}

function stringArray(at: string, x: unknown): string[] {
  if (!Array.isArray(x) || x.some((v) => typeof v !== 'string')) fail(at, 'expected an array of strings');
  return x as string[];
}

const MAX_LIST = 100;

function limitedStrings(at: string, x: unknown): string[] {
  const list = stringArray(at, x);
  if (list.length > MAX_LIST) fail(at, `at most ${MAX_LIST} entries are allowed`);
  if (list.some((v) => v.trim() === '')) fail(at, 'entries must be non-empty strings');
  return list;
}

function nonNegativeInteger(at: string, x: unknown): number {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) fail(at, 'expected a whole number >= 0');
  return x as number;
}

function evidenceItem(at: string, x: unknown): EvidenceItem {
  const r = record(at, x, ['status', 'refs', 'observedAt', 'source']);
  const status = oneOf(`${at}.status`, r.status, EVIDENCE_STATUSES);
  let observedAt: string | undefined;
  if (r.observedAt !== undefined) {
    observedAt = nonEmptyString(`${at}.observedAt`, r.observedAt);
    if (Number.isNaN(Date.parse(observedAt))) fail(`${at}.observedAt`, 'expected an ISO-8601 date');
  }
  return {
    status,
    ...(r.refs !== undefined ? { refs: stringArray(`${at}.refs`, r.refs) } : {}),
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(r.source !== undefined ? { source: oneOf(`${at}.source`, r.source, EVIDENCE_SOURCES) } : {}),
  };
}

function actor(at: string, x: unknown): ActorIdentity {
  const r = record(at, x, ['id', 'kind', 'roles']);
  return { id: nonEmptyString(`${at}.id`, r.id), kind: oneOf(`${at}.kind`, r.kind, ACTOR_KINDS), roles: stringArray(`${at}.roles`, r.roles) };
}

function consequence(at: string, x: unknown): 'BLOCK' | 'ESCALATE' {
  return oneOf(at, x, ['BLOCK', 'ESCALATE'] as const);
}

// every gate rule must be stated: there is deliberately no default policy
function gatePolicy(at: string, x: unknown): GatePolicy {
  const r = record(at, x, ['authorization', 'humanApproval', 'recovery', 'buildTests', 'supportingEvidence']);
  const rule = (key: string, extra: readonly string[]): Rec => {
    if (r[key] === undefined) fail(`${at}.${key}`, 'required: every gate rule must be stated explicitly');
    const rr = record(`${at}.${key}`, r[key], ['required', ...extra]);
    bool(`${at}.${key}.required`, rr.required);
    return rr;
  };
  const auth = rule('authorization', []);
  const approval = rule('humanApproval', ['consequence']);
  const recovery = rule('recovery', ['whenIrreversible', 'minImpact']);
  const tests = rule('buildTests', []);
  const supporting = rule('supportingEvidence', ['consequence']);
  return {
    authorization: { required: auth.required as boolean },
    humanApproval: {
      required: approval.required as boolean,
      ...(approval.consequence !== undefined ? { consequence: consequence(`${at}.humanApproval.consequence`, approval.consequence) } : {}),
    },
    recovery: {
      required: recovery.required as boolean,
      whenIrreversible: bool(`${at}.recovery.whenIrreversible`, recovery.whenIrreversible),
      ...(recovery.minImpact !== undefined ? { minImpact: oneOf(`${at}.recovery.minImpact`, recovery.minImpact, IMPACT_LEVELS) } : {}),
    },
    buildTests: { required: tests.required as boolean },
    supportingEvidence: {
      required: supporting.required as boolean,
      ...(supporting.consequence !== undefined
        ? { consequence: consequence(`${at}.supportingEvidence.consequence`, supporting.consequence) }
        : {}),
    },
  };
}

function parseAuthority(at: string, x: unknown): InputAuthority {
  const a = record(at, x, [
    'authorization', 'humanApproval', 'identityVerification', 'requiredRoles', 'requiredPermissions',
    'grantedPermissions', 'requiredApprovals', 'approvals',
  ]);
  const item = (k: string): EvidenceItem | undefined => (a[k] !== undefined ? evidenceItem(`${at}.${k}`, a[k]) : undefined);

  let grantedPermissions: InputAuthority['grantedPermissions'];
  if (a.grantedPermissions !== undefined) {
    const g = record(`${at}.grantedPermissions`, a.grantedPermissions, ['permissions', 'evidence']);
    grantedPermissions = {
      permissions: limitedStrings(`${at}.grantedPermissions.permissions`, g.permissions),
      ...(g.evidence !== undefined ? { evidence: evidenceItem(`${at}.grantedPermissions.evidence`, g.evidence) } : {}),
    };
  }

  let approvals: InputApproval[] | undefined;
  if (a.approvals !== undefined) {
    if (!Array.isArray(a.approvals)) fail(`${at}.approvals`, 'expected an array');
    if ((a.approvals as unknown[]).length > MAX_LIST) fail(`${at}.approvals`, `at most ${MAX_LIST} approval records are allowed`);
    approvals = (a.approvals as unknown[]).map((raw, i) => {
      const r = record(`${at}.approvals[${i}]`, raw, ['approverId', 'evidence']);
      if (r.evidence === undefined) fail(`${at}.approvals[${i}].evidence`, 'required: an approval record must carry evidence');
      return {
        approverId: nonEmptyString(`${at}.approvals[${i}].approverId`, r.approverId),
        evidence: evidenceItem(`${at}.approvals[${i}].evidence`, r.evidence),
      };
    });
  }

  const authorization = item('authorization');
  const humanApproval = item('humanApproval');
  const identityVerification = item('identityVerification');
  return {
    ...(authorization ? { authorization } : {}),
    ...(humanApproval ? { humanApproval } : {}),
    ...(identityVerification ? { identityVerification } : {}),
    ...(a.requiredRoles !== undefined ? { requiredRoles: limitedStrings(`${at}.requiredRoles`, a.requiredRoles) } : {}),
    ...(a.requiredPermissions !== undefined ? { requiredPermissions: limitedStrings(`${at}.requiredPermissions`, a.requiredPermissions) } : {}),
    ...(grantedPermissions ? { grantedPermissions } : {}),
    ...(a.requiredApprovals !== undefined ? { requiredApprovals: nonNegativeInteger(`${at}.requiredApprovals`, a.requiredApprovals) } : {}),
    ...(approvals ? { approvals } : {}),
  };
}

/** Validates already-parsed JSON against the --input file schema. */
export function parseAssessmentInput(raw: unknown): AssessmentInputFile {
  const top = record('$', raw, ['action', 'actor', 'authority', 'evidence', 'reports', 'recovery', 'policy', 'interpretationPolicy']);
  const out: { -readonly [K in keyof AssessmentInputFile]: AssessmentInputFile[K] } = {};

  if (top.action !== undefined) {
    const a = record('$.action', top.action, ['id', 'description', 'impact', 'irreversible', 'destructive', 'blastRadius']);
    let blastRadius: StatedBlastRadius | undefined;
    if (a.blastRadius !== undefined) {
      const b = record('$.action.blastRadius', a.blastRadius, ['criticality', 'scope', 'sharedModulesModified', 'dependencyReach', 'affectedServiceCount']);
      const criticalities = Object.keys(DEFAULT_BLAST_RADIUS_CONFIG.criticalityRisk) as ComponentCriticality[];
      const scopes = Object.keys(DEFAULT_BLAST_RADIUS_CONFIG.scopeRisk) as ImpactScope[];
      blastRadius = {
        ...(b.criticality !== undefined ? { criticality: oneOf('$.action.blastRadius.criticality', b.criticality, criticalities) } : {}),
        ...(b.scope !== undefined ? { scope: oneOf('$.action.blastRadius.scope', b.scope, scopes) } : {}),
        ...(b.sharedModulesModified !== undefined ? { sharedModulesModified: nonNegativeInteger('$.action.blastRadius.sharedModulesModified', b.sharedModulesModified) } : {}),
        ...(b.dependencyReach !== undefined ? { dependencyReach: nonNegativeInteger('$.action.blastRadius.dependencyReach', b.dependencyReach) } : {}),
        ...(b.affectedServiceCount !== undefined ? { affectedServiceCount: nonNegativeInteger('$.action.blastRadius.affectedServiceCount', b.affectedServiceCount) } : {}),
      };
    }
    out.action = {
      ...(blastRadius ? { blastRadius } : {}),
      ...(a.id !== undefined ? { id: nonEmptyString('$.action.id', a.id) } : {}),
      ...(a.description !== undefined ? { description: nonEmptyString('$.action.description', a.description) } : {}),
      ...(a.impact !== undefined ? { impact: oneOf('$.action.impact', a.impact, IMPACT_LEVELS) } : {}),
      ...(a.irreversible !== undefined ? { irreversible: bool('$.action.irreversible', a.irreversible) } : {}),
      ...(a.destructive !== undefined ? { destructive: bool('$.action.destructive', a.destructive) } : {}),
    };
  }
  if (top.actor !== undefined) out.actor = actor('$.actor', top.actor);
  if (top.authority !== undefined) out.authority = parseAuthority('$.authority', top.authority);
  if (top.evidence !== undefined) {
    const e = record('$.evidence', top.evidence, ['buildTests', 'supporting', 'recovery', 'dependencyCompatibility', 'securityFindings']);
    const item = (k: string): EvidenceItem | undefined => (e[k] !== undefined ? evidenceItem(`$.evidence.${k}`, e[k]) : undefined);
    const buildTests = item('buildTests');
    const supporting = item('supporting');
    const recovery = item('recovery');
    const dependencyCompatibility = item('dependencyCompatibility');
    const securityFindings = item('securityFindings');
    out.evidence = {
      ...(buildTests ? { buildTests } : {}),
      ...(supporting ? { supporting } : {}),
      ...(recovery ? { recovery } : {}),
      ...(dependencyCompatibility ? { dependencyCompatibility } : {}),
      ...(securityFindings ? { securityFindings } : {}),
    };
  }
  if (top.reports !== undefined) {
    const r = record('$.reports', top.reports, ['buildTests', 'security']);
    out.reports = {
      ...(r.buildTests !== undefined ? { buildTests: limitedStrings('$.reports.buildTests', r.buildTests) } : {}),
      ...(r.security !== undefined ? { security: limitedStrings('$.reports.security', r.security) } : {}),
    };
  }
  if (top.recovery !== undefined) {
    const r = record('$.recovery', top.recovery, ['rollbackPlan', 'rollbackTest', 'backup']);
    const item = (k: string): EvidenceItem | undefined => (r[k] !== undefined ? evidenceItem(`$.recovery.${k}`, r[k]) : undefined);
    const rollbackPlan = item('rollbackPlan');
    const rollbackTest = item('rollbackTest');
    const backup = item('backup');
    out.recovery = {
      ...(rollbackPlan ? { rollbackPlan } : {}),
      ...(rollbackTest ? { rollbackTest } : {}),
      ...(backup ? { backup } : {}),
    };
  }
  if (top.policy !== undefined) out.policy = gatePolicy('$.policy', top.policy);
  if (top.interpretationPolicy !== undefined) {
    const p = record('$.interpretationPolicy', top.interpretationPolicy, ['mandatory', 'onFailure']);
    out.interpretationPolicy = {
      mandatory: bool('$.interpretationPolicy.mandatory', p.mandatory),
      onFailure: oneOf('$.interpretationPolicy.onFailure', p.onFailure, ['ESCALATE', 'BLOCK'] as const),
    };
  }
  return out;
}

/**
 * Validates the flags, then reads and validates the --input file if one was
 * given. Only reads files; never runs anything described inside them.
 */
export async function loadAssessmentRequest(flags: AssessmentFlags, cwd: string): Promise<AssessmentRequest> {
  const v = validateAssessmentFlags(flags);
  const inputPath = v.inputFlag ? path.resolve(cwd, v.inputFlag) : undefined;
  let input: AssessmentInputFile | undefined;

  if (inputPath) {
    let text: string;
    try {
      text = await fs.readFile(inputPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new SafetyInputError(
        code === 'ENOENT' ? `input file not found: ${inputPath}` : `could not read input file ${inputPath}: ${(err as Error).message}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new SafetyInputError(`input file ${inputPath} is not valid JSON: ${(err as Error).message}`);
    }
    input = parseAssessmentInput(json);
  }

  return {
    actionType: v.actionType,
    environment: v.environment,
    ...(v.diffRef !== undefined ? { diffRef: v.diffRef } : {}),
    ...(inputPath !== undefined ? { inputPath } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(v.outputFlag !== undefined ? { outputPath: path.resolve(cwd, v.outputFlag) } : {}),
  };
}
