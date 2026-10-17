/**
 * Command dispatch for the Feature 4 strict-authorization setup tool. Parsing uses Node's built-in
 * `util.parseArgs` (no CLI framework) and every command is a thin wrapper over admin.ts
 * and keyStore.ts, which hold the logic and call the existing authorization verifiers.
 *
 * Exit codes: 0 success; 1 the command failed (a readable reason is printed); 2 usage error.
 *
 * Private keys are never printed. Only locations and key ids are shown.
 */

import path from 'node:path';
import { levelLabel, parseLevel } from '../authorization/levels.js';
import { parseArgs } from 'node:util';
import { SafetyInputError, SafetyUsageError } from '../cli/assessmentInput.js';
import type { GitRunner } from '../authorization/actionContextCollector.js';
import type { AssessmentPolicy } from '../pipeline/assessmentCoordinator.js';
import type { EvidenceBundle } from '../collectors/evidenceOrchestrator.js';
import type { ContextInterpretation } from '../interpretation/types.js';
import { initOrganization, issueGrant, revokeGrants } from './admin.js';
import { AUTHORITY_FILES, authorityPath, trustRootFingerprint } from './authority.js';
import { StrictCliError, readFileBytes } from './files.js';
import { defaultKeysDir, generateKeyProfile } from './keyStore.js';
import { prepareEvidenceOutput, verifyEvidencePackFile } from './evidenceOutput.js';
import { runStrictAssessment } from './strictAssess.js';
import { renderStrictAssessment } from './strictReport.js';

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** injectable clock (tests); defaults to the current time */
  readonly now?: () => Date;
  /** overrides the default keys directory (tests); `--keys-dir` overrides both */
  readonly keysDir?: string;
  readonly cwd?: string;
  /** test hooks for `assess`: replace the local-model interpretation, the Git runner, or the assessment policy */
  readonly hooks?: {
    readonly interpreter?: (bundle: EvidenceBundle) => Promise<ContextInterpretation>;
    readonly runner?: GitRunner;
    readonly policy?: Partial<AssessmentPolicy>;
    /** runs after the provisional assessment said ALLOW and before the Git recheck (lets a demonstration change the repository at that moment) */
    readonly beforeFinalization?: () => void | Promise<void>;
  };
}

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

export const USAGE = `CodeXRev strict authorization setup (Feature 4)

  keygen    --name <name> [--keys-dir <dir>]
              create a signing key pair; the private key stays in your keys directory
  admin init --org <id> --dir <authority-dir> --admin-key <name> [--store-key <name>] [--policy-days <n>]
              create the trust root, the signed demo policy and an empty revocation list
  admin grant --dir <authority-dir> --admin-key <name> --subject <id> --pubkey <file.pub.json>
              --level <L1|L2|L3|L4|L5> --days <1-90> [--type human|service] [--permission-scope <p>[,<p>]]
              issue a signed grant that assigns ONE standardized level (L1 to L5, fixed permissions) to a developer
  admin revoke --dir <authority-dir> --admin-key <name> --grant <grant-id> [--grant <id> ...]
              add grants to the signed revocation list (the version increases)
  admin refresh-revocation --dir <authority-dir> --admin-key <name>
              re-sign the revocation list with a new date and version
  admin fingerprint --dir <authority-dir> [--trust-root <file>]
              print the trust-root fingerprint: the administrator gives it to everyone who runs "assess"
  assess    --strict --dir <authority-dir> --trust-root-sha256 <fingerprint> --as <developer-key>
              --action <type> --environment <env> --target <name> [--repo <path>]
              [--input <file.json>] [--store-key <name>] [--store-dir <dir>] [--grant-file <file>] [--subject <id>]
              [--evidence-pack <file> --evidence-key <name> [--overwrite-evidence-pack]]
              STRICT DEMO MODE: verify the signed role-based grant and proof, then run the safety assessment.
              Exit codes: 0 ALLOW, 10 ESCALATE, 11 BLOCK, 1 invalid input, 2 usage, 3 incomplete.
  verify    --evidence-pack <file> --trusted-key <file.pub.json> [--trusted-key-id <key id>]
              check a signed Evidence Pack OFFLINE against a signing key you trust. Exit codes: 0 VALID, 1 INVALID, 2 usage.

  Private keys are stored in ${'`'}~/.codexrev/keys${'`'} (or --keys-dir), never in the authority directory or
  a Git repository. Add --help to see this text.`;

const NAME_OPTIONS = { 'keys-dir': { type: 'string' as const } };

function str(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== 'string' || v === '') throw new UsageError(`--${name} is required`);
  return v;
}
function optStr(values: Record<string, unknown>, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function intOf(values: Record<string, unknown>, name: string, fallback?: number): number {
  const v = values[name];
  if (v === undefined) {
    if (fallback === undefined) throw new UsageError(`--${name} is required`);
    return fallback;
  }
  const n = typeof v === 'string' && /^[0-9]+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new UsageError(`--${name} must be a whole number`);
  return n;
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter((x) => x !== '');

class UsageError extends Error {}

export async function runStrictCli(argv: readonly string[], io: CliIo): Promise<number> {
  const now = io.now ?? ((): Date => new Date());
  try {
    const [group, second] = argv;
    if (group === undefined || group === 'help' || group === '--help' || group === '-h') {
      io.out(USAGE);
      return group === undefined ? EXIT.usage : EXIT.ok;
    }
    const keysDirOf = (values: Record<string, unknown>): string => optStr(values, 'keys-dir') ?? io.keysDir ?? defaultKeysDir();

    if (group === 'keygen') {
      const { values } = parseArgs({ args: argv.slice(1), options: { name: { type: 'string' }, ...NAME_OPTIONS }, strict: true, allowPositionals: false });
      const key = await generateKeyProfile({ name: str(values, 'name'), keysDir: keysDirOf(values), now: now() });
      io.out(`Created key "${key.name}"`);
      io.out(`  key id:      ${key.keyId}`);
      io.out(`  public key:  ${key.publicPath}   (share this file with the administrator)`);
      io.out(`  private key: ${key.privatePath}   (keep it secret: it is never shown or sent anywhere)`);
      for (const w of key.warnings) io.err(`WARNING: ${w}`);
      return EXIT.ok;
    }

    if (group === 'admin') {
      if (second === 'init') {
        const { values } = parseArgs({ args: argv.slice(2), options: { org: { type: 'string' }, dir: { type: 'string' }, 'admin-key': { type: 'string' }, 'store-key': { type: 'string' }, 'policy-days': { type: 'string' }, ...NAME_OPTIONS }, strict: true, allowPositionals: false });
        const storeKey = optStr(values, 'store-key');
        const r = await initOrganization({ organization: str(values, 'org'), dir: str(values, 'dir'), adminKey: str(values, 'admin-key'), ...(storeKey ? { storeKey } : {}), keysDir: keysDirOf(values), now: now(), policyDays: intOf(values, 'policy-days', 365) });
        io.out(`Initialized organization "${r.organization}" in ${str(values, 'dir')}`);
        io.out(`  administrator key id: ${r.adminKeyId}`);
        if (r.storeKeyId) io.out(`  challenge-store key id: ${r.storeKeyId}`);
        io.out(`  policy valid until:   ${r.policyExpiresAt}`);
        for (const f of r.files) io.out(`  wrote ${f}`);
        io.out('The administrator private key was NOT written to the authority directory.');
        io.out(`  trust-root fingerprint (give this to everyone who runs "assess --strict"): ${trustRootFingerprint(await readFileBytes(authorityPath(str(values, 'dir'), AUTHORITY_FILES.trustRoot), 'the trust root'))}`);
        return EXIT.ok;
      }
      if (second === 'grant') {
        const { values } = parseArgs({ args: argv.slice(2), options: { dir: { type: 'string' }, 'admin-key': { type: 'string' }, subject: { type: 'string' }, pubkey: { type: 'string' }, role: { type: 'string', multiple: true }, level: { type: 'string' }, days: { type: 'string' }, type: { type: 'string' }, 'permission-scope': { type: 'string', multiple: true }, ...NAME_OPTIONS }, strict: true, allowPositionals: false });
        const scope = list(values['permission-scope']);
        // a developer is assigned exactly one CodeXRev level (L1 to L5); --role is accepted only as the level's id
        const levelText = optStr(values, 'level');
        const roleList = list(values.role);
        if (levelText !== undefined && roleList.length > 0) throw new UsageError('give --level or --role, not both');
        const level = levelText === undefined ? undefined : parseLevel(levelText);
        if (levelText !== undefined && level === undefined) throw new UsageError('--level must be one of L1, L2, L3, L4, L5');
        if (levelText === undefined && roleList.length === 0) throw new UsageError('--level <L1-L5> is required');
        const type = optStr(values, 'type');
        if (type !== undefined && type !== 'human' && type !== 'service') throw new UsageError('--type must be "human" or "service"');
        const r = await issueGrant({
          dir: str(values, 'dir'), adminKey: str(values, 'admin-key'), keysDir: keysDirOf(values), subject: str(values, 'subject'), pubkeyFile: str(values, 'pubkey'),
          roles: level ? [level] : roleList, days: intOf(values, 'days'), ...(type ? { type } : {}), ...(scope.length > 0 ? { permissionScope: scope } : {}), now: now(),
        });
        io.out(`Issued grant ${r.grantId}`);
        io.out(`  subject:         ${r.subject} (key id ${r.subjectKeyId})`);
        io.out(`  level:           ${r.roles.map((x) => parseLevel(x) ? levelLabel(parseLevel(x) as never) : x).join(', ')}`);
        io.out(`  policy revision: ${r.policyRevision}`);
        io.out(`  expires:         ${r.expiresAt}`);
        io.out(`  file:            ${r.file}`);
        return EXIT.ok;
      }
      if (second === 'fingerprint') {
        const { values } = parseArgs({ args: argv.slice(2), options: { dir: { type: 'string' }, 'trust-root': { type: 'string' } }, strict: true, allowPositionals: false });
        const file = optStr(values, 'trust-root') ?? authorityPath(str(values, 'dir'), AUTHORITY_FILES.trustRoot);
        io.out(trustRootFingerprint(await readFileBytes(path.resolve(file), 'the trust root')));
        return EXIT.ok;
      }
      if (second === 'revoke' || second === 'refresh-revocation') {
        const { values } = parseArgs({ args: argv.slice(2), options: { dir: { type: 'string' }, 'admin-key': { type: 'string' }, grant: { type: 'string', multiple: true }, ...NAME_OPTIONS }, strict: true, allowPositionals: false });
        const grantIds = list(values.grant);
        if (second === 'revoke' && grantIds.length === 0) throw new UsageError('--grant <grant-id> is required');
        if (second === 'refresh-revocation' && grantIds.length > 0) throw new UsageError('refresh-revocation takes no --grant (use "admin revoke")');
        const r = await revokeGrants({ dir: str(values, 'dir'), adminKey: str(values, 'admin-key'), keysDir: keysDirOf(values), grantIds, now: now() });
        if (!r.changed) io.out(`Nothing changed: ${r.alreadyRevoked.join(', ')} ${r.alreadyRevoked.length === 1 ? 'is' : 'are'} already revoked (list version ${r.listVersion}).`);
        else io.out(`Revocation list is now version ${r.listVersion} with ${r.revokedGrantIds.length} revoked grant(s); next update ${r.nextUpdate}.`);
        for (const id of r.alreadyRevoked) if (r.changed) io.out(`  ${id} was already revoked`);
        return EXIT.ok;
      }
      io.err(`unknown admin command: ${second ?? '(none)'}`);
      io.err(USAGE);
      return EXIT.usage;
    }

    if (group === 'assess') {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          strict: { type: 'boolean' }, dir: { type: 'string' }, 'trust-root-sha256': { type: 'string' }, 'trust-root': { type: 'string' }, as: { type: 'string' }, subject: { type: 'string' },
          action: { type: 'string' }, environment: { type: 'string' }, target: { type: 'string' }, repo: { type: 'string' },
          'grant-file': { type: 'string' }, input: { type: 'string' }, 'store-key': { type: 'string' }, 'store-dir': { type: 'string' }, ...NAME_OPTIONS,
          'evidence-pack': { type: 'string' }, 'evidence-key': { type: 'string' }, 'overwrite-evidence-pack': { type: 'boolean' },
        },
        strict: true,
        allowPositionals: false,
      });
      // there is no silent mode switch: this tool only runs the signed-authorization assessment
      if (values.strict !== true) throw new UsageError('this tool only runs STRICT assessments: add --strict (the advisory assessment is "codexrev safety assess")');
      const keysDir = keysDirOf(values);
      const pin = str(values, 'trust-root-sha256');
      const subject = optStr(values, 'subject');
      const trustRootFile = optStr(values, 'trust-root');
      const grantFile = optStr(values, 'grant-file');
      const inputFile = optStr(values, 'input');
      const packFile = optStr(values, 'evidence-pack');
      const packKey = optStr(values, 'evidence-key');
      if ((packFile === undefined) !== (packKey === undefined)) throw new UsageError('--evidence-pack and --evidence-key must be given together');
      if (values['overwrite-evidence-pack'] === true && packFile === undefined) throw new UsageError('--overwrite-evidence-pack needs --evidence-pack');
      const repoDir = optStr(values, 'repo') ?? io.cwd ?? process.cwd();
      const storeKeyName = optStr(values, 'store-key') ?? 'store';
      // the signing key and the output file are checked BEFORE anything runs, so a problem here can never appear after a challenge was consumed
      const writer = packFile && packKey
        ? await prepareEvidenceOutput({ file: path.resolve(repoDir, packFile), signingKeyName: packKey, keysDir, overwrite: values['overwrite-evidence-pack'] === true, developerKeyName: str(values, 'as'), storeKeyName, authorityDir: str(values, 'dir'), trustRootSha256: pin, ...(trustRootFile ? { trustRootFile } : {}) })
        : undefined;
      const result = await runStrictAssessment({
        dir: str(values, 'dir'), trustRootSha256: pin, ...(trustRootFile ? { trustRootFile } : {}), asKey: str(values, 'as'), ...(subject ? { subject } : {}), keysDir,
        storeKey: storeKeyName, storeDir: optStr(values, 'store-dir') ?? path.join(path.dirname(keysDir), 'store', pin.slice(0, 16)),
        action: str(values, 'action'), environment: str(values, 'environment'), target: str(values, 'target'), repo: repoDir,
        ...(grantFile ? { grantFile } : {}), ...(inputFile ? { inputFile } : {}), now,
        ...(io.hooks?.interpreter ? { interpreter: io.hooks.interpreter } : {}), ...(io.hooks?.runner ? { runner: io.hooks.runner } : {}), ...(io.hooks?.policy ? { policy: io.hooks.policy } : {}),
        ...(io.hooks?.beforeFinalization ? { testHooks: { beforeFinalization: io.hooks.beforeFinalization } } : {}),
      });
      for (const line of renderStrictAssessment(result)) io.out(line);
      if (!writer) return result.exitCode;
      try {
        const written = await writer.write(result);
        io.out(`Evidence Pack: signed and written to ${written.file}`);
        io.out(`  assessment id ${written.assessmentId}; signing key id ${written.keyId.slice(0, 16)}…; verify it with: verify --evidence-pack <file> --trusted-key <the signing key's .pub.json>`);
        return result.exitCode;
      } catch (e) {
        // the decision above stands, but the pack was NOT produced: never report a signed pack that does not exist
        io.err(`Evidence Pack NOT produced: ${e instanceof StrictCliError ? e.message : 'unexpected error'}`);
        return result.exitCode === 0 ? EXIT.failed : result.exitCode;
      }
    }

    if (group === 'verify') {
      const { values } = parseArgs({ args: argv.slice(1), options: { 'evidence-pack': { type: 'string' }, 'trusted-key': { type: 'string' }, 'trusted-key-id': { type: 'string' } }, strict: true, allowPositionals: false });
      const pinnedId = optStr(values, 'trusted-key-id');
      if (pinnedId !== undefined && !/^[0-9a-f]{64}$/.test(pinnedId)) throw new UsageError('--trusted-key-id must be 64 lowercase hexadecimal characters');
      const { verification, lines } = await verifyEvidencePackFile({ file: str(values, 'evidence-pack'), trustedKeyFile: str(values, 'trusted-key'), ...(pinnedId ? { trustedKeyId: pinnedId } : {}) });
      for (const line of lines) io.out(line);
      return verification.result === 'VALID' ? EXIT.ok : EXIT.failed;
    }

    io.err(`unknown command: ${group}`);
    io.err(USAGE);
    return EXIT.usage;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`usage error: ${e.message}`);
      return EXIT.usage;
    }
    if (e instanceof SafetyUsageError) {
      io.err(`usage error: ${e.message}`);
      return EXIT.usage;
    }
    if (e instanceof SafetyInputError) {
      io.err(`error: ${e.message}`);
      return EXIT.failed;
    }
    if (e instanceof StrictCliError) {
      io.err(`error: ${e.message}`);
      return EXIT.failed;
    }
    const code = (e as { code?: unknown })?.code;
    if ((e as Error)?.name === 'TypeError' && code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(`usage error: ${(e as Error).message.split('\n')[0]}`);
      return EXIT.usage;
    }
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      io.err(`usage error: ${(e as Error).message.split('\n')[0]}`);
      return EXIT.usage;
    }
    // an unexpected problem: a fixed message, never the exception text (which could contain paths or key material)
    io.err('error: the command failed unexpectedly');
    return EXIT.failed;
  }
}
