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
// Sec role's LLM response. This is the Phase 3 Definition of Done: proving
// a realistic sample validates cleanly against roleContract.ts.
const SAMPLE_SEC_OUTPUT = {
  role: 'sec',
  verdict: 'block',
  findings: [
    {
      id: 'sec-1',
      severity: 'high',
      cwe: 'CWE-89',
      file: 'src/api/users.ts',
      lineStart: 42,
      lineEnd: 44,
      description: 'User-supplied `id` is concatenated directly into a SQL query, allowing SQL injection.',
      suggestedFix: 'Use a parameterized query instead of string concatenation.',
    },
    {
      id: 'sec-2',
      severity: 'medium',
      file: 'src/api/users.ts',
      lineStart: 51,
      lineEnd: 51,
      description: 'Error message leaks the internal stack trace to the client.',
    },
  ],
  summary: 'Found one SQL injection vector and one information-disclosure issue in the users endpoint.',
  confidence: 0.86,
};

describe('roleContract — validateRoleOutput', () => {
  it('accepts a realistic hand-written sample role output', () => {
    const parsed: RoleOutput = validateRoleOutput(SAMPLE_SEC_OUTPUT);
    expect(parsed.role).toBe('sec');
    expect(parsed.verdict).toBe('block');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].cwe).toBe('CWE-89');
    expect(parsed.findings[1].cwe).toBeUndefined();
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
    ['unknown role', { ...SAMPLE_SEC_OUTPUT, role: 'ceo' }],
    ['unknown verdict', { ...SAMPLE_SEC_OUTPUT, verdict: 'maybe' }],
    ['findings not an array', { ...SAMPLE_SEC_OUTPUT, findings: {} }],
    ['empty summary', { ...SAMPLE_SEC_OUTPUT, summary: '' }],
    ['confidence out of range', { ...SAMPLE_SEC_OUTPUT, confidence: 1.5 }],
    ['confidence not a number', { ...SAMPLE_SEC_OUTPUT, confidence: 'high' }],
  ])('rejects: %s', (_label, bad) => {
    expect(() => validateRoleOutput(bad)).toThrow(RoleContractError);
  });

  it('rejects a finding with an invalid severity, naming the exact path', () => {
    const bad = {
      ...SAMPLE_SEC_OUTPUT,
      findings: [{ ...SAMPLE_SEC_OUTPUT.findings[0], severity: 'catastrophic' }],
    };
    expect(() => validateRoleOutput(bad)).toThrow(/\$\.findings\[0\]\.severity/);
  });

  it('rejects a finding where lineEnd < lineStart', () => {
    const bad = { ...SAMPLE_SEC_OUTPUT, findings: [{ ...SAMPLE_SEC_OUTPUT.findings[0], lineEnd: 1 }] };
    expect(() => validateRoleOutput(bad)).toThrow(RoleContractError);
  });
});

describe('roleContract — validateFinding', () => {
  it('validates one finding in isolation', () => {
    const f = validateFinding(SAMPLE_SEC_OUTPUT.findings[0], '$');
    expect(f.id).toBe('sec-1');
    expect(f.severity).toBe('high');
  });
});

describe('roleContract — role identity & ordering', () => {
  it('ROLE_ORDER is BA → Dev → Build → Sec → QA → PM, per Section 2', () => {
    expect(ROLE_ORDER).toEqual(['ba', 'dev', 'build', 'sec', 'qa', 'pm']);
  });

  it('ROLE_LABELS has plain-English names for every role', () => {
    expect(ROLE_LABELS.ba).toBe('Business Analyst');
    expect(ROLE_LABELS.dev).toBe('Developer');
    expect(ROLE_LABELS.build).toBe('Build Analyst');
    expect(ROLE_LABELS.sec).toBe('Security Auditor');
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
