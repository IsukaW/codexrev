import { describe, expect, it } from 'vitest';
import { collectAuthority } from '../../../../src/features/action-safety/collectors/authorityCollector.js';
import { collectRecovery } from '../../../../src/features/action-safety/collectors/recoveryCollector.js';
import type { EvidenceItem } from '../../../../src/features/action-safety/model/types.js';
import { FRESH, NOW, STALE } from '../../../../src/features/action-safety/testing/fixtures.js';

const ACTOR = { id: 'alice', kind: 'human' as const, roles: ['release-manager'] };
const attested = (observedAt = FRESH, refs: string[] = ['ref:1']): EvidenceItem => ({ status: 'PASS', source: 'human_attested', observedAt, refs });

describe('collectAuthority', () => {
  it('infers nothing when nothing is supplied', () => {
    const c = collectAuthority({});
    expect(c.actor).toBeUndefined();
    expect(c.authorization).toBeUndefined();
    expect(c).not.toHaveProperty('humanApproval');
    expect(c).not.toHaveProperty('approvals');
    expect(c.limitations.join(' ')).toMatch(/never inferred from the git user or repository ownership/);
    expect(c.limitations.join(' ')).toMatch(/no authorization record was supplied/);
  });

  it('keeps what was supplied and flags that roles are self-reported without identity verification', () => {
    const c = collectAuthority({ actor: ACTOR, authority: { authorization: attested() } });
    expect(c.actor).toEqual(ACTOR);
    expect(c.authorization?.item.status).toBe('PASS');
    expect(c.limitations.join(' ')).toMatch(/identity and roles are self-reported/);
  });

  it('separates verified-looking claims from self-declared ones', () => {
    const c = collectAuthority({
      actor: ACTOR,
      authority: { authorization: { status: 'PASS' }, identityVerification: { status: 'PASS', source: 'self_declared' } },
    });
    expect(c.authorization?.trusted).toBe(false);
    expect(c.authorization?.item.source).toBe('self_declared');
    expect(c.authorization?.trusted).toBe(false);
    expect(c.identityVerification?.trusted).toBe(false);
  });

  it('caps a claimed verified_system source, because an input file cannot prove it', () => {
    const c = collectAuthority({ actor: ACTOR, authority: { authorization: { status: 'PASS', source: 'verified_system', observedAt: FRESH } } });
    expect(c.authorization?.item.source).toBe('human_attested');
    expect(c.limitations.join(' ')).toMatch(/declared source "verified_system" cannot be verified from an input file/);
  });

  it('keeps granted permissions without proof as a claim and says so', () => {
    const c = collectAuthority({ actor: ACTOR, authority: { grantedPermissions: { permissions: ['deploy:prod'] } } });
    expect(c.grantedPermissions?.permissions).toEqual(['deploy:prod']);
    expect(c.grantedPermissions?.evidence).toBeUndefined();
    expect(c.limitations.join(' ')).toMatch(/listed without a record proving the grant/);
  });

  it('does not mutate its input', () => {
    const input = { actor: ACTOR, authority: { authorization: { status: 'PASS', source: 'verified_system' } as EvidenceItem } };
    const snapshot = JSON.stringify(input);
    collectAuthority(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('collectRecovery', () => {
  const run = (recovery: Parameters<typeof collectRecovery>[0]['recovery'], legacyClaim?: EvidenceItem) =>
    collectRecovery({ ...(recovery ? { recovery } : {}), ...(legacyClaim ? { legacyClaim } : {}), now: NOW });

  it('has no gate evidence when nothing was supplied', () => {
    const c = run(undefined);
    expect(c.gateEvidence).toBeUndefined();
    expect(c.documentedOnly).toBe(false);
    expect(c.limitations.join(' ')).toMatch(/no rollback plan, rollback test or backup record was supplied/);
  });

  it('treats a documented plan alone as UNKNOWN, never verified', () => {
    const c = run({ rollbackPlan: attested() });
    expect(c.documentedOnly).toBe(true);
    expect(c.gateEvidence?.status).toBe('UNKNOWN');
    expect(c.limitations.join(' ')).toMatch(/documented but no verified rollback test or backup/);
  });

  it('is verified by a fresh, trusted rollback test', () => {
    const c = run({ rollbackPlan: attested(), rollbackTest: attested() });
    expect(c.gateEvidence?.status).toBe('PASS');
    expect(c.documentedOnly).toBe(false);
    expect(c.gateEvidence?.refs).toEqual(['ref:1']);
    expect(c.gateEvidence?.observedAt).toBe(FRESH);
  });

  it('is verified by a fresh, trusted backup', () => {
    expect(run({ backup: attested() }).gateEvidence?.status).toBe('PASS');
  });

  it('does not accept a stale rollback test or backup as verification', () => {
    const c = run({ rollbackPlan: attested(), rollbackTest: attested(STALE), backup: attested(STALE) });
    expect(c.gateEvidence?.status).toBe('UNKNOWN');
  });

  it('does not accept an undated or self-declared pass', () => {
    expect(run({ rollbackTest: { status: 'PASS', source: 'human_attested' } }).gateEvidence?.status).toBe('UNKNOWN'); // no timestamp
    expect(run({ rollbackTest: { status: 'PASS', observedAt: FRESH } }).gateEvidence?.status).toBe('UNKNOWN'); // no source = self-declared
  });

  it('a failed rollback test is FAIL even when a backup exists', () => {
    const c = run({ rollbackTest: { status: 'FAIL', source: 'human_attested', observedAt: FRESH }, backup: attested() });
    expect(c.gateEvidence?.status).toBe('FAIL');
  });

  it('a failed backup with nothing else verified is FAIL', () => {
    expect(run({ backup: { status: 'FAIL', source: 'human_attested', observedAt: FRESH } }).gateEvidence?.status).toBe('FAIL');
  });

  it('keeps the older single recovery claim only when no recovery section is given, with the same strictness', () => {
    const legacy = run(undefined, attested());
    expect(legacy.gateEvidence?.status).toBe('PASS');
    expect(legacy.legacyClaim?.item.status).toBe('PASS');
    expect(run(undefined, { status: 'PASS' }).gateEvidence?.status).toBe('UNKNOWN');
    expect(run({ rollbackPlan: attested() }, attested()).legacyClaim).toBeUndefined();
  });

  it('caps a claimed verified_system source', () => {
    const c = run({ rollbackTest: { status: 'PASS', source: 'verified_system', observedAt: FRESH } });
    expect(c.rollbackTest?.item.source).toBe('human_attested');
    expect(c.limitations.join(' ')).toMatch(/capped to "human_attested"/);
  });
});
