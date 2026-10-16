import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SafetyInputError,
  SafetyUsageError,
  loadAssessmentRequest,
  parseAssessmentInput,
  validateAssessmentFlags,
} from '../../../src/features/action-safety/cli/assessmentInput.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-safety-input-')));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const FULL_INPUT = {
  action: { id: 'act-1', description: 'drop legacy column', impact: 'high', irreversible: true, destructive: true },
  actor: { id: 'alice', kind: 'human', roles: ['release-manager'] },
  authority: {
    authorization: { status: 'PASS', refs: ['rbac:1'], observedAt: '2025-01-10T06:00:00.000Z', source: 'verified_system' },
    humanApproval: { status: 'UNKNOWN' },
  },
  evidence: {
    buildTests: { status: 'FAIL' },
    supporting: { status: 'NOT_APPLICABLE' },
    recovery: { status: 'PASS', refs: ['backup:1'] },
  },
  policy: {
    authorization: { required: true },
    humanApproval: { required: true, consequence: 'BLOCK' },
    recovery: { required: true, whenIrreversible: true, minImpact: 'high' },
    buildTests: { required: true },
    supportingEvidence: { required: false, consequence: 'ESCALATE' },
  },
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('validateAssessmentFlags', () => {
  it('accepts a valid action and target', () => {
    expect(validateAssessmentFlags({ action: 'deployment', target: 'production' })).toMatchObject({
      actionType: 'deployment',
      environment: 'production',
    });
  });

  it('normalizes case and hyphens', () => {
    const v = validateAssessmentFlags({ action: 'Database-Migration', target: 'STAGING' });
    expect(v.actionType).toBe('database_migration');
    expect(v.environment).toBe('staging');
  });

  it('requires --action and --target', () => {
    expect(() => validateAssessmentFlags({ target: 'production' })).toThrow(/--action is required/);
    expect(() => validateAssessmentFlags({ action: 'deployment' })).toThrow(/--target is required/);
    expect(() => validateAssessmentFlags({})).toThrow(SafetyUsageError);
  });

  it('rejects empty, non-string and unknown values and lists the valid ones', () => {
    expect(() => validateAssessmentFlags({ action: '', target: 'production' })).toThrow(SafetyUsageError);
    expect(() => validateAssessmentFlags({ action: 5, target: 'production' })).toThrow(SafetyUsageError);
    expect(() => validateAssessmentFlags({ action: true, target: 'production' })).toThrow(SafetyUsageError);
    expect(() => validateAssessmentFlags({ action: 'launch-missiles', target: 'production' })).toThrow(/Valid values: deployment, rollback/);
    expect(() => validateAssessmentFlags({ action: 'deployment', target: 'moon' })).toThrow(/Valid values: development, testing, staging, production/);
  });

  it('rejects optional flags that are present but empty or the wrong type', () => {
    const ok = { action: 'deployment', target: 'production' };
    expect(() => validateAssessmentFlags({ ...ok, diff: '' })).toThrow(/--diff needs a non-empty value/);
    expect(() => validateAssessmentFlags({ ...ok, input: 3 })).toThrow(/--input/);
    expect(() => validateAssessmentFlags({ ...ok, output: ['a', 'b'] })).toThrow(/--output/);
  });
});

describe('parseAssessmentInput', () => {
  it('accepts an empty object (every section is optional)', () => {
    expect(parseAssessmentInput({})).toEqual({});
  });

  it('accepts and preserves a complete valid input', () => {
    expect(parseAssessmentInput(clone(FULL_INPUT))).toEqual(FULL_INPUT);
  });

  it('does not mutate its input', () => {
    const raw = clone(FULL_INPUT);
    parseAssessmentInput(raw);
    expect(raw).toEqual(FULL_INPUT);
  });

  it('rejects non-object input', () => {
    for (const bad of [null, [], 'x', 5]) expect(() => parseAssessmentInput(bad)).toThrow(SafetyInputError);
  });

  it('rejects unknown fields so typos are caught', () => {
    expect(() => parseAssessmentInput({ evidance: {} })).toThrow(/\$\.evidance": unknown field/);
    expect(() => parseAssessmentInput({ evidence: { buildTest: { status: 'PASS' } } })).toThrow(/\$\.evidence\.buildTest/);
    expect(() => parseAssessmentInput({ action: { type: 'deployment' } })).toThrow(/\$\.action\.type/);
  });

  it('rejects invalid evidence items', () => {
    const at = (item: unknown) => () => parseAssessmentInput({ evidence: { buildTests: item } });
    expect(at({ status: 'MAYBE' })).toThrow(/status/);
    expect(at({})).toThrow(/status/);
    expect(at({ status: 'PASS', refs: 'ci:1' })).toThrow(/refs/);
    expect(at({ status: 'PASS', observedAt: 'yesterday' })).toThrow(/ISO-8601/);
    expect(at({ status: 'PASS', source: 'trust-me' })).toThrow(/source/);
    expect(at({ status: 'PASS', extra: 1 })).toThrow(/unknown field/);
  });

  it('rejects invalid action and actor fields', () => {
    expect(() => parseAssessmentInput({ action: { impact: 'enormous' } })).toThrow(/impact/);
    expect(() => parseAssessmentInput({ action: { irreversible: 'yes' } })).toThrow(/true or false/);
    expect(() => parseAssessmentInput({ actor: { id: 'a', kind: 'robot', roles: [] } })).toThrow(/kind/);
    expect(() => parseAssessmentInput({ actor: { id: 'a', kind: 'human', roles: 'admin' } })).toThrow(/roles/);
    expect(() => parseAssessmentInput({ actor: { id: '', kind: 'human', roles: [] } })).toThrow(/non-empty/);
  });

  it('requires every gate rule in a policy (there is no default policy)', () => {
    const policy = clone(FULL_INPUT.policy) as Record<string, unknown>;
    delete policy.recovery;
    expect(() => parseAssessmentInput({ policy })).toThrow(/\$\.policy\.recovery": required/);
  });

  it('rejects invalid policy values', () => {
    const withPolicy = (patch: Record<string, unknown>) => ({ policy: { ...clone(FULL_INPUT.policy), ...patch } });
    expect(() => parseAssessmentInput(withPolicy({ authorization: { required: 'yes' } }))).toThrow(/true or false/);
    expect(() => parseAssessmentInput(withPolicy({ humanApproval: { required: true, consequence: 'ALLOW' } }))).toThrow(/BLOCK, ESCALATE/);
    expect(() => parseAssessmentInput(withPolicy({ recovery: { required: true, whenIrreversible: true, minImpact: 'huge' } }))).toThrow(/minImpact/);
    expect(() => parseAssessmentInput(withPolicy({ recovery: { required: true } }))).toThrow(/whenIrreversible/);
  });
});

describe('loadAssessmentRequest', () => {
  const flags = { action: 'deployment', target: 'production' };

  it('builds a minimal request from flags alone, inventing nothing', async () => {
    const req = await loadAssessmentRequest(flags, tmpRoot);
    expect(req).toEqual({ actionType: 'deployment', environment: 'production' });
    expect(req).not.toHaveProperty('input');
  });

  it('reads and validates an --input file, resolving it against cwd', async () => {
    await fs.writeFile(path.join(tmpRoot, 'in.json'), JSON.stringify(FULL_INPUT), 'utf-8');
    const req = await loadAssessmentRequest({ ...flags, input: 'in.json', diff: 'main', output: 'out/pack.json' }, tmpRoot);
    expect(req.inputPath).toBe(path.join(tmpRoot, 'in.json'));
    expect(req.input).toEqual(FULL_INPUT);
    expect(req.diffRef).toBe('main');
    expect(req.outputPath).toBe(path.join(tmpRoot, 'out', 'pack.json'));
  });

  it('does not create the --output path', async () => {
    await loadAssessmentRequest({ ...flags, output: 'out/pack.json' }, tmpRoot);
    expect(await fs.readdir(tmpRoot)).toEqual([]);
  });

  it('reports a missing input file, invalid JSON and schema errors as SafetyInputError', async () => {
    await expect(loadAssessmentRequest({ ...flags, input: 'nope.json' }, tmpRoot)).rejects.toThrow(/input file not found/);
    await fs.writeFile(path.join(tmpRoot, 'bad.json'), '{ not json', 'utf-8');
    await expect(loadAssessmentRequest({ ...flags, input: 'bad.json' }, tmpRoot)).rejects.toThrow(/not valid JSON/);
    await fs.writeFile(path.join(tmpRoot, 'schema.json'), JSON.stringify({ evidence: { buildTests: { status: 'MAYBE' } } }), 'utf-8');
    await expect(loadAssessmentRequest({ ...flags, input: 'schema.json' }, tmpRoot)).rejects.toBeInstanceOf(SafetyInputError);
  });

  it('validates flags before touching the file system', async () => {
    await expect(loadAssessmentRequest({ target: 'production', input: 'nope.json' }, tmpRoot)).rejects.toBeInstanceOf(SafetyUsageError);
  });
});
