// The five standardized developer authorization levels L1 to L5: the registry, the signed level policy (format
// version 3), grants that bind a developer to exactly one level, and the end-to-end behavior: a level only lets a
// person REQUEST an assessment; the safety score and gates still decide.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signEnvelope } from '../../../../src/features/action-safety/authorization/envelope.js';
import { effectivePermissions, levelOf, verifyGrant } from '../../../../src/features/action-safety/authorization/grant.js';
import {
  LEVEL_IDS,
  LEVEL_POLICY_VERSION,
  PERMISSION_REGISTRY,
  levelPolicyBody,
  levelPolicyMismatch,
  levelsHolding,
  parseLevel,
  permissionsOfLevel,
  type LevelId,
} from '../../../../src/features/action-safety/authorization/levels.js';
import { SUPPORTED_POLICY_VERSIONS, parsePolicyDocument, requirementsFor, verifyPolicy } from '../../../../src/features/action-safety/authorization/policy.js';
import { ACTION_TYPES, TARGET_ENVIRONMENTS, type ActionType, type TargetEnvironment } from '../../../../src/features/action-safety/model/types.js';
import { buildDefaultPolicy } from '../../../../src/features/action-safety/strict/defaultPolicy.js';
import { issueGrant } from '../../../../src/features/action-safety/strict/admin.js';
import { loadAuthority, trustRootFingerprint } from '../../../../src/features/action-safety/strict/authority.js';
import { generateKeyProfile, loadPrivateKey } from '../../../../src/features/action-safety/strict/keyStore.js';
import { runStrictAssessment, type StrictAssessOptions, type StrictAssessResult } from '../../../../src/features/action-safety/strict/strictAssess.js';
import { NOW, later, noInterpretation, setupOrganization, verifiedGrantOf, writeEvidence, type Fixture } from '../../../../src/features/action-safety/testing/strictFixture.js';

const T = 240_000;

/** The specification, written independently of the registry code: what each level may REQUEST, as "action/environment". */
const EXPECTED: Readonly<Record<LevelId, readonly string[]>> = {
  l1: ['code_change/development'],
  l2: ['code_change/development', 'dependency_upgrade/development', 'configuration_change/development'],
  l3: ['code_change/development', 'dependency_upgrade/development', 'configuration_change/development', 'deployment/staging', 'configuration_change/staging', 'database_migration/staging'],
  l4: ['code_change/development', 'dependency_upgrade/development', 'configuration_change/development', 'deployment/staging', 'configuration_change/staging', 'database_migration/staging', 'deployment/production', 'rollback/production'],
  l5: ['code_change/development', 'dependency_upgrade/development', 'configuration_change/development', 'deployment/staging', 'configuration_change/staging', 'database_migration/staging', 'deployment/production', 'rollback/production', 'configuration_change/production', 'database_migration/production'],
};

let f: Fixture;
beforeAll(async () => {
  f = await setupOrganization({ withRepo: false });
}, T);
afterAll(() => f.cleanup());

const signPolicy = (doc: unknown) => signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(doc)), privateKey: adminPrivate });
let adminPrivate: Awaited<ReturnType<typeof loadPrivateKey>>['privateKey'];
beforeAll(async () => {
  adminPrivate = (await loadPrivateKey({ name: 'admin', keysDir: f.keysDir, platform: 'win32' })).privateKey;
}, T);

const policyDoc = (): Record<string, any> => JSON.parse(JSON.stringify(buildDefaultPolicy({ organization: 'acme', now: NOW, days: 365 })));
const verifyDoc = (doc: unknown) => verifyPolicy(signPolicy(doc), f.authority.trustRoot, NOW);

/** what the default policy lets a level REQUEST, computed through the real requirementsFor on every action/environment pair */
function permittedPairs(level: LevelId): string[] {
  const out: string[] = [];
  for (const action of ACTION_TYPES) {
    for (const env of TARGET_ENVIRONMENTS) {
      const r = requirementsFor(f.authority.policy, action, env);
      if (!r.permitted || !r.requiredRoles.includes(level)) continue;
      if (r.requiredPermissions.every((p) => permissionsOfLevel(level).includes(p))) out.push(`${action}/${env}`);
    }
  }
  return out;
}

describe('the permission registry', () => {
  it('has stable, unique, machine-readable identifiers that each map to exactly one real action and environment', () => {
    const ids = PERMISSION_REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['code.modify', 'dependency.update', 'config.development', 'deployment.staging', 'config.staging', 'migration.staging', 'deployment.production', 'rollback.production', 'infrastructure.maintenance', 'database.maintenance']);
    const pairs = PERMISSION_REGISTRY.map((p) => `${p.action}/${p.environment}`);
    expect(new Set(pairs).size).toBe(pairs.length); // one permission per pair: no ambiguity about what a permission enforces
    for (const p of PERMISSION_REGISTRY) {
      expect(ACTION_TYPES as readonly string[], p.id).toContain(p.action);
      expect(TARGET_ENVIRONMENTS as readonly string[], p.id).toContain(p.environment);
    }
  });

  it('gives each level exactly its predefined permissions, cumulatively', () => {
    expect(permissionsOfLevel('l1')).toEqual(['code.modify']);
    expect(permissionsOfLevel('l2')).toEqual([...permissionsOfLevel('l1'), 'config.development', 'dependency.update'].sort());
    expect(permissionsOfLevel('l3')).toEqual([...permissionsOfLevel('l2'), 'config.staging', 'deployment.staging', 'migration.staging'].sort());
    expect(permissionsOfLevel('l4')).toEqual([...permissionsOfLevel('l3'), 'deployment.production', 'rollback.production'].sort());
    expect(permissionsOfLevel('l5')).toEqual([...permissionsOfLevel('l4'), 'database.maintenance', 'infrastructure.maintenance'].sort());
    for (let i = 1; i < LEVEL_IDS.length; i++) {
      const lower = permissionsOfLevel(LEVEL_IDS[i - 1] as LevelId);
      const higher = permissionsOfLevel(LEVEL_IDS[i] as LevelId);
      expect(lower.every((p) => higher.includes(p))).toBe(true);
      expect(higher.length).toBeGreaterThan(lower.length);
    }
  });

  it('answers which levels hold a permission, and nothing for an unknown one', () => {
    expect(levelsHolding('deployment.production')).toEqual(['l4', 'l5']);
    expect(levelsHolding('code.modify')).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    expect(levelsHolding('arbitrary.command')).toEqual([]);
  });

  it('accepts only the five level ids (case and space tolerant), never a guess', () => {
    expect(parseLevel('L3')).toBe('l3');
    expect(parseLevel(' l5 ')).toBe('l5');
    for (const bad of ['L0', 'L6', 'L10', 'release_engineer', 'developer', '', null, undefined, 3]) expect(parseLevel(bad), String(bad)).toBeUndefined();
  });
});

describe('the level matrix, enforced by the signed policy', () => {
  for (const level of LEVEL_IDS) {
    it(`${level.toUpperCase()} may request exactly the specified actions and nothing else`, () => {
      expect(permittedPairs(level).sort()).toEqual([...EXPECTED[level]].sort());
    });
  }

  it('L1 cannot perform any L2 to L5 action', () => {
    const l1 = permittedPairs('l1');
    for (const pair of [...EXPECTED.l5].filter((x) => x !== 'code_change/development')) expect(l1).not.toContain(pair);
  });

  it('L2 cannot deploy to staging or production', () => {
    const l2 = permittedPairs('l2');
    for (const pair of ['deployment/staging', 'deployment/production', 'rollback/production', 'database_migration/production']) expect(l2).not.toContain(pair);
  });

  it('L3 cannot deploy to production or do production maintenance', () => {
    const l3 = permittedPairs('l3');
    for (const pair of ['deployment/production', 'rollback/production', 'configuration_change/production', 'database_migration/production']) expect(l3).not.toContain(pair);
  });

  it('L4 may request production deployments and rollbacks but not production infrastructure or database maintenance', () => {
    const l4 = permittedPairs('l4');
    expect(l4).toContain('deployment/production');
    expect(l4).toContain('rollback/production');
    expect(l4).not.toContain('configuration_change/production');
    expect(l4).not.toContain('database_migration/production');
  });

  it('L5 holds only the explicitly defined high-impact permissions: no blanket access', () => {
    const l5 = permittedPairs('l5');
    expect(l5).toHaveLength(EXPECTED.l5.length);
    // not a wildcard: production code changes, production dependency upgrades, and testing-environment actions stay denied
    for (const [action, env] of [['code_change', 'production'], ['dependency_upgrade', 'production'], ['code_change', 'staging'], ['dependency_upgrade', 'staging'], ['rollback', 'staging'], ['deployment', 'testing'], ['code_change', 'testing']] as const) {
      expect(l5, `${action}/${env}`).not.toContain(`${action}/${env}`);
      expect(requirementsFor(f.authority.policy, action, env), `${action}/${env}`).toMatchObject({ permitted: false });
    }
  });

  it('fails closed for unsupported actions and environments, for every level', () => {
    expect(requirementsFor(f.authority.policy, 'run_arbitrary_command', 'production')).toMatchObject({ permitted: false, reason: 'unknown_action' });
    expect(requirementsFor(f.authority.policy, 'deployment', 'moon')).toMatchObject({ permitted: false, reason: 'unknown_environment' });
    expect(requirementsFor(f.authority.policy, 'code_change', 'production')).toMatchObject({ permitted: false, reason: 'no_matching_rule' });
  });

  it('every action/environment pair is either one predefined rule or denied', () => {
    let permitted = 0;
    for (const action of ACTION_TYPES) for (const env of TARGET_ENVIRONMENTS) if (requirementsFor(f.authority.policy, action as ActionType, env as TargetEnvironment).permitted) permitted += 1;
    expect(permitted).toBe(PERMISSION_REGISTRY.length);
  });
});

describe('the signed level policy (format version 3) cannot be redefined', () => {
  it('the default policy is exactly the registry, and verifies', () => {
    const doc = policyDoc();
    expect(doc.version).toBe(LEVEL_POLICY_VERSION);
    expect(verifyDoc(doc).ok).toBe(true);
    expect(levelPolicyMismatch({ permissions: doc.permissions, roles: doc.roles, rules: doc.rules })).toBeUndefined();
    expect({ permissions: doc.permissions, roles: doc.roles.map((r: { name: string }) => r.name) }).toMatchObject({ roles: ['l1', 'l2', 'l3', 'l4', 'l5'] });
    expect(levelPolicyBody().rules).toHaveLength(PERMISSION_REGISTRY.length);
  });

  it('a signed policy that gives L1 the production permission is rejected, even though the administrator signed it', () => {
    const doc = policyDoc();
    doc.roles[0].permissions = [...doc.roles[0].permissions, 'deployment.production'];
    const r = verifyDoc(doc);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('policy_invalid');
    expect(!r.ok && r.message).toMatch(/not the CodeXRev level policy/);
    // allowing L1 through a rule instead of a role permission is refused too (the role would lack the permission)
    const viaRule = policyDoc();
    viaRule.rules.find((x: { action: string; environment: string }) => x.action === 'deployment' && x.environment === 'production').allowedRoles = ['l1', 'l4', 'l5'];
    expect(verifyDoc(viaRule).ok).toBe(false);
  });

  it('rejects any other deviation: a missing or extra level, a changed rule, an extra permission, fewer rules', () => {
    const cases: Array<[string, (d: Record<string, any>) => void]> = [
      ['a missing level', (d) => { d.roles.pop(); }],
      ['an extra custom role', (d) => { d.roles.push({ name: 'release_engineer', permissions: ['code.modify'] }); }],
      ['a removed permission from a level', (d) => { d.roles[4].permissions = d.roles[4].permissions.slice(1); }],
      ['an extra permission in the catalogue', (d) => { d.permissions.push('shell.exec'); }],
      ['a removed rule', (d) => { d.rules.pop(); }],
      ['a loosened rule', (d) => { d.rules[0].allowedRoles = ['l1']; d.rules[1].requiredPermissions = []; }],
      ['a new rule (production code changes)', (d) => { d.rules.push({ action: 'code_change', environment: 'production', allowedRoles: ['l5'], requiredPermissions: ['code.modify'] }); }],
      ['a rule moved to another environment', (d) => { d.rules[3].environment = 'production'; }],
    ];
    for (const [label, change] of cases) {
      const doc = policyDoc();
      change(doc);
      const r = verifyDoc(doc);
      expect(r.ok, label).toBe(false);
      expect(!r.ok && r.code, label).toBe('policy_invalid');
    }
  });

  it('editing a signed policy file breaks its signature', () => {
    const env = signPolicy(policyDoc()) as unknown as { payload: string; [k: string]: unknown };
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    doc.roles[0].permissions.push('deployment.production');
    const r = verifyPolicy({ ...env, payload: Buffer.from(JSON.stringify(doc)).toString('base64url') }, f.authority.trustRoot, NOW);
    expect(!r.ok && r.code).toBe('signature_verification_failed');
  });

  it('handles policy versions explicitly: 1 and unknown versions are unsupported; 2 is a generic custom-role policy and 3 is the level policy', () => {
    expect([...SUPPORTED_POLICY_VERSIONS]).toEqual([2, 3]);
    for (const version of [0, 1, 4, 5, '3', null, undefined]) {
      const doc = policyDoc();
      doc.version = version;
      expect(parsePolicyDocument(doc), String(version)).toMatchObject({ ok: false, code: 'unsupported_policy_version' });
    }
    // version 2 keeps working as a generic policy at the library level, but is not a level policy...
    const v2 = policyDoc();
    v2.version = 2;
    expect(parsePolicyDocument(v2).ok).toBe(true);
    // ...and version 3 does NOT accept custom roles: nothing is silently reinterpreted either way
    const v3custom = { ...policyDoc(), roles: [{ name: 'developer', permissions: ['code.modify'] }], rules: [] };
    expect(parsePolicyDocument(v3custom).ok).toBe(false);
  });

  it('the strict tooling refuses a version 2 (custom-role) policy instead of downgrading to it', async () => {
    const keysDir = join(f.root, 'keys-v2');
    await generateKeyProfile({ name: 'admin', keysDir, now: NOW });
    const { initOrganization } = await import('../../../../src/features/action-safety/strict/admin.js');
    const dir = join(f.root, 'authority-v2');
    await initOrganization({ organization: 'acme', dir, adminKey: 'admin', keysDir, now: NOW });
    const key = await loadPrivateKey({ name: 'admin', keysDir, platform: 'win32' });
    const v2 = policyDoc();
    v2.version = 2;
    writeFileSync(join(dir, 'policy.signed.json'), JSON.stringify(signEnvelope({ domain: 'policy', payload: Buffer.from(JSON.stringify(v2)), privateKey: key.privateKey })));
    await expect(loadAuthority(dir, NOW)).rejects.toThrow(/format version 2.*need version 3/);
  });
});

describe('grants bind a developer to exactly one level', () => {
  it('a level grant carries the level in its signed roles, and the effective permissions come from the registry', async () => {
    for (const level of LEVEL_IDS) {
      const g = await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'alice', pubkeyFile: join(f.keysDir, 'alice.pub.json'), roles: [level], days: 30, now: NOW });
      const verified = await verifiedGrantOf(f, g);
      expect(levelOf(verified)).toBe(level);
      expect(verified.grant.roles).toEqual([level]);
      expect(effectivePermissions(verified, f.authority.policy)).toMatchObject({ ok: true, permissions: permissionsOfLevel(level) });
    }
  });

  it('a developer cannot raise L2 to L5 by editing the saved grant: the administrator signature fails', async () => {
    const g = await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'bob', pubkeyFile: join(f.keysDir, 'bob.pub.json'), roles: ['l2'], days: 30, now: NOW });
    const env = JSON.parse(readFileSync(g.file, 'utf-8'));
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    const forged = { ...env, payload: Buffer.from(JSON.stringify({ ...doc, roles: ['l5'] })).toString('base64url') };
    const r = verifyGrant(forged, f.authority.trustRoot, f.authority.policy, NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('signature_verification_failed');
  });

  it('a developer key cannot sign a grant for a higher level: only a trusted administrator key is accepted', async () => {
    const dev = await loadPrivateKey({ name: 'bob', keysDir: f.keysDir, platform: 'win32' });
    const real = JSON.parse(readFileSync(f.grants.bob.file, 'utf-8'));
    const doc = JSON.parse(Buffer.from(real.payload, 'base64url').toString('utf-8'));
    const selfSigned = signEnvelope({ domain: 'grant', payload: Buffer.from(JSON.stringify({ ...doc, roles: ['l5'] })), privateKey: dev.privateKey });
    const r = verifyGrant(selfSigned, f.authority.trustRoot, f.authority.policy, NOW);
    expect(!r.ok && r.code).toBe('unknown_signing_key');
    // the challenge-store key is trusted for another purpose and cannot sign a grant either
    const store = await loadPrivateKey({ name: 'store', keysDir: f.keysDir, platform: 'win32' });
    const byStore = signEnvelope({ domain: 'grant', payload: Buffer.from(JSON.stringify({ ...doc, roles: ['l5'] })), privateKey: store.privateKey });
    expect(!verifyGrant(byStore, f.authority.trustRoot, f.authority.policy, NOW).ok).toBe(true);
  });

  it('a validly signed grant that is not exactly one level is rejected under the level policy', async () => {
    const admin = await loadPrivateKey({ name: 'admin', keysDir: f.keysDir, platform: 'win32' });
    const real = JSON.parse(readFileSync(f.grants.bob.file, 'utf-8'));
    const doc = JSON.parse(Buffer.from(real.payload, 'base64url').toString('utf-8'));
    for (const roles of [['l1', 'l5'], [], ['l1', 'l1'], ['developer']]) {
      const signed = signEnvelope({ domain: 'grant', payload: Buffer.from(JSON.stringify({ ...doc, roles })), privateKey: admin.privateKey });
      const r = verifyGrant(signed, f.authority.trustRoot, f.authority.policy, NOW);
      expect(r.ok, JSON.stringify(roles)).toBe(false);
    }
  });

  it('a permission scope may narrow a level but never widen it', async () => {
    const narrow = await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'alice', pubkeyFile: join(f.keysDir, 'alice.pub.json'), roles: ['l4'], days: 30, permissionScope: ['code.modify', 'deployment.staging'], now: NOW });
    expect(effectivePermissions(await verifiedGrantOf(f, narrow), f.authority.policy)).toMatchObject({ ok: true, permissions: ['code.modify', 'deployment.staging'] });
    const admin = await loadPrivateKey({ name: 'admin', keysDir: f.keysDir, platform: 'win32' });
    const doc = JSON.parse(Buffer.from(JSON.parse(readFileSync(f.grants.bob.file, 'utf-8')).payload, 'base64url').toString('utf-8'));
    const widened = signEnvelope({ domain: 'grant', payload: Buffer.from(JSON.stringify({ ...doc, roles: ['l2'], permissionScope: ['deployment.production'] })), privateKey: admin.privateKey });
    expect(verifyGrant(widened, f.authority.trustRoot, f.authority.policy, NOW)).toMatchObject({ ok: false, code: 'permission_escalation' });
  });

  it('expired grants are rejected, and a revoked level grant is rejected', async () => {
    const short = await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject: 'alice', pubkeyFile: join(f.keysDir, 'alice.pub.json'), roles: ['l5'], days: 1, now: NOW });
    const env = JSON.parse(readFileSync(short.file, 'utf-8'));
    expect(verifyGrant(env, f.authority.trustRoot, f.authority.policy, NOW).ok).toBe(true);
    expect(verifyGrant(env, f.authority.trustRoot, f.authority.policy, later(2))).toMatchObject({ ok: false, code: 'grant_expired' });
  });
});

describe('a level only lets a person request an assessment; the safety checks still decide', () => {
  let pin: string;
  let input: string;
  let n = 0;
  const holders: Record<string, string> = {};
  beforeAll(async () => {
    f.cleanup();
    f = await setupOrganization();
    input = writeEvidence(f.repo, NOW);
    pin = trustRootFingerprint(readFileSync(join(f.authorityDir, 'trust-root.json')));
    for (const level of LEVEL_IDS) {
      const subject = `dev-${level}`;
      await generateKeyProfile({ name: subject, keysDir: f.keysDir, now: NOW });
      await issueGrant({ dir: f.authorityDir, adminKey: 'admin', keysDir: f.keysDir, subject, pubkeyFile: join(f.keysDir, `${subject}.pub.json`), roles: [level], days: 30, now: NOW });
      holders[level] = subject;
    }
  }, T);

  const run = (level: LevelId, action: string, environment: string, over: Partial<StrictAssessOptions> = {}): Promise<StrictAssessResult> =>
    runStrictAssessment({
      dir: f.authorityDir, trustRootSha256: pin, asKey: holders[level] as string, keysDir: f.keysDir, storeKey: 'store', storeDir: join(f.root, `lv-store-${++n}`), action, environment, target: 'my-app',
      repo: f.repo, inputFile: input, now: () => NOW, interpreter: noInterpretation, ...over,
    });

  it('L1 may change code in development, and nothing in staging or production', { timeout: T }, async () => {
    expect((await run('l1', 'code_change', 'development')).decision).toBe('ALLOW');
    for (const [action, env] of [['code_change', 'staging'], ['code_change', 'production'], ['deployment', 'staging'], ['deployment', 'production']] as const) {
      const r = await run('l1', action, env);
      expect(r.decision, `${action}/${env}`).toBe('BLOCK');
      expect(r.summary.authorizationState).toBe('blocked');
    }
  });

  it('L2 cannot deploy to staging or production', { timeout: T }, async () => {
    for (const env of ['staging', 'production']) {
      const r = await run('l2', 'deployment', env);
      expect(r.decision, env).toBe('BLOCK');
      expect(r.summary.authorizationState, env).toBe('blocked');
    }
  });

  it('L3 may request a staging deployment but not a production deployment', { timeout: T }, async () => {
    expect((await run('l3', 'deployment', 'staging')).decision).toBe('ALLOW');
    const r = await run('l3', 'deployment', 'production');
    expect(r.decision).toBe('BLOCK');
    expect(r.summary.authorizationState).toBe('blocked');
    expect(r.summary.permission.status).toBe('FAILED');
  });

  it('L4 may request a production deployment, and a valid L4 grant does not guarantee ALLOW', { timeout: T }, async () => {
    const ok = await run('l4', 'deployment', 'production');
    expect(ok.decision).toBe('ALLOW');
    expect(ok.summary.developer.roles).toEqual(['l4']);
    // authorization is fine, but a failed mandatory gate still stops it: the level cannot override the safety checks
    const noTests = await run('l4', 'deployment', 'production', { inputFile: writeEvidence(f.repo, NOW, { buildTests: false }) });
    expect(noTests.decision).toBe('BLOCK');
    expect(noTests.summary.developerGrant.status).toBe('VERIFIED');
    expect(noTests.summary.authorizationState).toBe('provisional_not_finalized');
    writeEvidence(f.repo, NOW);
  });

  it('L5 is limited to its defined permissions: an unlisted production action fails closed', { timeout: T }, async () => {
    // production code changes are in no level's permission set, not even L5's
    const unlisted = await run('l5', 'code_change', 'production');
    expect(unlisted.decision).toBe('BLOCK');
    expect(unlisted.summary.authorizationState).toBe('blocked');
    expect(text(unlisted)).toMatch(/action_not_permitted|no_matching_rule/);
    // and L4 cannot do what only L5 may (checked through the policy: the Git binding below would block it anyway)
    expect(requirementsFor(f.authority.policy, 'database_migration', 'production')).toMatchObject({ permitted: true, requiredRoles: ['l5'] });
    expect(requirementsFor(f.authority.policy, 'configuration_change', 'production')).toMatchObject({ permitted: true, requiredRoles: ['l5'] });
  });

  it('known gap, failing closed: actions that a Git snapshot cannot bind are never completed, whatever the level', { timeout: T }, async () => {
    // L5 is authorized for production database maintenance, but a Git snapshot cannot stand for a migration, so the
    // existing Git/action binding refuses it: authorization is not the only requirement and nothing is weakened
    const r = await run('l5', 'database_migration', 'production');
    expect(r.decision).toBe('BLOCK');
    expect(r.summary.receipt).toBeUndefined();
    expect(text(r)).toMatch(/non_git_artifact_binding_unavailable/);
  });

  it('a forged higher level (L2 edited to L5 in the saved grant) is rejected end to end', { timeout: T }, async () => {
    const grantFile = join(f.authorityDir, 'grants', readdirGrant(holders.l2 as string));
    const env = JSON.parse(readFileSync(grantFile, 'utf-8'));
    const doc = JSON.parse(Buffer.from(env.payload, 'base64url').toString('utf-8'));
    const forged = join(f.root, 'forged-l5.grant.json');
    writeFileSync(forged, JSON.stringify({ ...env, payload: Buffer.from(JSON.stringify({ ...doc, roles: ['l5'] })).toString('base64url') }));
    const r = await run('l2', 'deployment', 'production', { grantFile: forged });
    expect(r.decision).toBe('BLOCK');
    expect(text(r)).toMatch(/signature_verification_failed/);
  });

  const text = (r: StrictAssessResult): string => r.summary.reasons.join('\n');
  function readdirGrant(subject: string): string {
    const names = readdirSync(join(f.authorityDir, 'grants'));
    const name = names.find((x) => x.startsWith(`grant-${subject}-`));
    if (!name) throw new Error(`no grant for ${subject}`);
    return name;
  }
});
