import { describe, expect, it } from 'vitest';
import {
  ROLE_LABELS,
  ROLE_ORDER,
  RoleContractError,
  SEVERITY_ORDER,
  bumpSeverity,
  validateFinding,
  validateRoleOutput,
  type RoleOutput,
} from '../../../src/features/review-pipeline/roles/roleContract.js';

// A hand-written sample role output — as if freshly JSON.parse'd from the
// Architect role's LLM response. This is the Phase 3 Definition of Done:
// proving a realistic sample validates cleanly against roleContract.ts.
const SAMPLE_ARCHITECT_OUTPUT = {
  role: 'architect',
  verdict: 'block',
  findings: [
    {
      id: 'arch-1',
      severity: 'high',
      file: 'src/api/users.ts',
      lineStart: 42,
      lineEnd: 44,
      description: 'A frontend module imports the database client directly, crossing the service boundary.',
      suggestedFix: 'Move the query behind the existing API layer instead of importing the DB client in the frontend.',
    },
    {
      id: 'arch-2',
      severity: 'medium',
      file: 'src/api/users.ts',
      lineStart: 51,
      lineEnd: 51,
      description: 'Database connection acquired in the request handler is never released on the error path.',
    },
  ],
  summary: 'Found one service-boundary violation and one resource-lifecycle issue in the users endpoint.',
  confidence: 0.86,
};

describe('roleContract — validateRoleOutput', () => {
  it('accepts a realistic hand-written sample role output', () => {
    const parsed: RoleOutput = validateRoleOutput(SAMPLE_ARCHITECT_OUTPUT);
    expect(parsed.role).toBe('architect');
    expect(parsed.verdict).toBe('block');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].suggestedFix).toBe(
      'Move the query behind the existing API layer instead of importing the DB client in the frontend.',
    );
    expect(parsed.findings[1].suggestedFix).toBeUndefined();
    expect(parsed.summary.length).toBeGreaterThan(0);
    expect(parsed.confidence).toBeCloseTo(0.86);
  });

  it('accepts a role output with zero findings (a clean pass)', () => {
    const clean = { role: 'ba', verdict: 'pass', findings: [], summary: 'No behavioral drift found.', confidence: 0.95 };
    expect(() => validateRoleOutput(clean)).not.toThrow();
  });

  it.each([
    ['not an object', 'nope'],
    ['missing role', { verdict: 'pass', findings: [], summary: 's', confidence: 0.5 }],
    ['unknown role', { ...SAMPLE_ARCHITECT_OUTPUT, role: 'ceo' }],
    ['unknown verdict', { ...SAMPLE_ARCHITECT_OUTPUT, verdict: 'maybe' }],
    ['findings not an array', { ...SAMPLE_ARCHITECT_OUTPUT, findings: {} }],
    ['empty summary', { ...SAMPLE_ARCHITECT_OUTPUT, summary: '' }],
    ['confidence out of range', { ...SAMPLE_ARCHITECT_OUTPUT, confidence: 1.5 }],
    ['confidence not a number', { ...SAMPLE_ARCHITECT_OUTPUT, confidence: 'high' }],
  ])('rejects: %s', (_label, bad) => {
    expect(() => validateRoleOutput(bad)).toThrow(RoleContractError);
  });

  it('rejects a finding with an invalid severity, naming the exact path', () => {
    const bad = {
      ...SAMPLE_ARCHITECT_OUTPUT,
      findings: [{ ...SAMPLE_ARCHITECT_OUTPUT.findings[0], severity: 'catastrophic' }],
    };
    expect(() => validateRoleOutput(bad)).toThrow(/\$\.findings\[0\]\.severity/);
  });

  it('rejects a finding where lineEnd < lineStart', () => {
    const bad = { ...SAMPLE_ARCHITECT_OUTPUT, findings: [{ ...SAMPLE_ARCHITECT_OUTPUT.findings[0], lineEnd: 1 }] };
    expect(() => validateRoleOutput(bad)).toThrow(RoleContractError);
  });
});

describe('roleContract — validateFinding', () => {
  it('validates one finding in isolation', () => {
    const f = validateFinding(SAMPLE_ARCHITECT_OUTPUT.findings[0], '$');
    expect(f.id).toBe('arch-1');
    expect(f.severity).toBe('high');
  });
});

describe('roleContract — role identity & ordering', () => {
  it('ROLE_ORDER is BA → Architect → Dev → Build → QA → PM', () => {
    expect(ROLE_ORDER).toEqual(['ba', 'architect', 'dev', 'build', 'qa', 'pm']);
  });

  it('ROLE_LABELS has plain-English names for every role', () => {
    expect(ROLE_LABELS.ba).toBe('Business Analyst');
    expect(ROLE_LABELS.architect).toBe('Architect');
    expect(ROLE_LABELS.dev).toBe('Developer');
    expect(ROLE_LABELS.build).toBe('Build Analyst');
    expect(ROLE_LABELS.qa).toBe('QA Engineer');
    expect(ROLE_LABELS.pm).toBe('Director of Engineering');
  });
});

describe('roleContract — severity ordering', () => {
  it('SEVERITY_ORDER runs low to high', () => {
    expect(SEVERITY_ORDER).toEqual(['info', 'low', 'medium', 'high', 'critical']);
  });

  it('bumpSeverity moves one level up', () => {
    expect(bumpSeverity('info')).toBe('low');
    expect(bumpSeverity('high')).toBe('critical');
  });

  it('bumpSeverity caps at critical (Resolver conflict rule: BA+QA same issue → severity+1)', () => {
    expect(bumpSeverity('critical')).toBe('critical');
  });
});
