/**
 * Codexrev — Feature 4 employee onboarding inside `codexrev init`.
 *
 * After the provider setup the tech lead types the employee id and name and picks a level (L1 to L5). CodeXRev then signs a
 * certificate with the issuer signing credentials that are already provisioned on this machine and saves it in the project's
 * `.codexrev` folder. Nothing technical is asked. Levels, signing, the certificate format (the signed grant), the trust root
 * and verification are the existing Feature 4 code (`provisionDeveloperAuthorization`); the permissions of a level cannot be edited.
 *
 * If the signing credentials are not provisioned, nothing is issued and one message says so: this never creates a trusted
 * issuer on the fly. An existing certificate is shown and never replaced by init (also not by --reset).
 * Opt-in: with no employee flag and no terminal, `codexrev init` behaves exactly as before.
 */

import path from 'node:path';
import readline from 'node:readline/promises';
import { getCodexrevPaths } from '../utils/paths.js';
import { LEVEL_DESCRIPTIONS, LEVEL_IDS, levelLabel, parseLevel, type LevelId } from '../features/action-safety/authorization/levels.js';
import { StrictCliError } from '../features/action-safety/strict/files.js';
import {
  projectAuthorizationStatus,
  provisionDeveloperAuthorization,
  refreshProjectAuthority,
  type ProvisionResult,
} from '../features/action-safety/strict/projectAuthorization.js';

export interface AuthorizationFlags {
  /** run the employee authorization step even with no other flag */
  authorize?: boolean;
  level?: string;
  employeeId?: string;
  employeeName?: string;
  /** certificate validity in days (default 30); programmatic only */
  grantDays?: number;
}

export interface AuthPrompter {
  /** asks one question; returns the answer, or `fallback` when the answer is empty */
  ask(question: string, fallback?: string): Promise<string>;
}

export interface AuthorizationContext {
  cwd: string;
  flags: AuthorizationFlags;
  now: Date;
  /** present in an interactive session; absent in non-interactive mode */
  prompter?: AuthPrompter;
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export const authorizationRequested = (f: AuthorizationFlags): boolean => f.authorize === true || f.level !== undefined || f.employeeId !== undefined;

/** Checks the shape of non-interactive flags before anything is written. Returns a message, or undefined when fine. */
export function validateAuthorizationFlags(f: AuthorizationFlags): string | undefined {
  if (f.level === undefined) return '--level <L1|L2|L3|L4|L5> is required for employee authorization';
  if (!parseLevel(f.level)) return '--level must be one of L1, L2, L3, L4, L5';
  if (f.employeeId === undefined || f.employeeId.trim() === '') return '--employee-id is required for employee authorization';
  return undefined;
}

export function createReadlinePrompter(): AuthPrompter & { close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question, fallback) {
      const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
      return answer === '' && fallback !== undefined ? fallback : answer;
    },
    close: () => rl.close(),
  };
}

/** Where the provisioned signing credentials are: CODEXREV_ADMIN_DIR, else ~/.codexrev/admin (public `authority/` and private `keys/`). */
export function resolveIssuerPaths(env: NodeJS.ProcessEnv = process.env): { dir: string; authorityDir: string; keysDir: string; keyName: string } {
  const dir = path.resolve(env.CODEXREV_ADMIN_DIR ?? path.join(getCodexrevPaths().root, 'admin'));
  return { dir, authorityDir: path.join(dir, 'authority'), keysDir: path.join(dir, 'keys'), keyName: 'admin' };
}

export const SIGNING_CREDENTIALS_MISSING = [
  'The signing credentials are not provisioned on this machine, so no certificate was issued.',
  'They are created once with the Feature 4 setup tool (see FEATURE4_DEMO_GUIDE.md, section 7.0): keygen for "admin" and "store" into <admin dir>\\keys, then admin init into <admin dir>\\authority (default admin dir: ~/.codexrev/admin, or CODEXREV_ADMIN_DIR).',
];

async function chooseLevel(prompter: AuthPrompter, out: (line: string) => void): Promise<LevelId> {
  out('');
  out('Select authorization level:');
  out('');
  LEVEL_IDS.forEach((level, i) => out(`${i + 1}. ${levelLabel(level)} - ${LEVEL_DESCRIPTIONS[level].split(':')[0]}`));
  out('');
  for (;;) {
    const answer = await prompter.ask('Select level');
    const level = parseLevel(/^[1-5]$/.test(answer) ? `L${answer}` : answer);
    if (level) return level;
    out('Please enter 1 to 5 (or L1 to L5).');
  }
}

/** Interactive question before onboarding: only when the project has no certificate yet. */
export async function askWhetherToAuthorize(ctx: AuthorizationContext): Promise<boolean> {
  if (!ctx.prompter) return false;
  return /^y(es)?$/i.test(await ctx.prompter.ask('Set up employee authorization? (Y/n)', 'y'));
}

/** Shows the existing certificate and its status. Never changes it. Returns false when a different level was requested (and refused). */
export async function showExistingAuthorization(ctx: AuthorizationContext): Promise<boolean> {
  const out = ctx.out ?? ((l: string) => console.log(l));
  const env = ctx.env ?? process.env;
  // bring the public revocation list up to date from the issuer folder if it is there (no secrets involved; best effort)
  await refreshProjectAuthority(ctx.cwd, resolveIssuerPaths(env).authorityDir, ctx.now).catch(() => undefined);
  const status = await projectAuthorizationStatus(ctx.cwd, ctx.now, env.CODEXREV_TRUST_ROOT_SHA256);
  if (!status) return true;
  out('');
  out('Employee authorization is already configured.');
  out('');
  out(`Employee: ${status.record.developer.displayName ?? status.record.developer.subject}`);
  out(`Employee ID: ${status.record.developer.subject}`);
  out(`Authorization Level: ${levelLabel(status.record.level)}`);
  out(`Certificate Status: ${status.status}`);
  out('');
  out('Authorization changes require administrator credentials.');
  const wanted = ctx.flags.level === undefined ? undefined : parseLevel(ctx.flags.level);
  if (ctx.flags.level !== undefined && wanted !== status.record.level) {
    process.stderr.write('[codexrev] the requested level was NOT applied: init never replaces an existing certificate.\n');
    return false;
  }
  return true;
}

/**
 * Creates the certificate for a project that has none. Returns true on success; on failure prints one clear message and
 * returns false. The provider configuration is never touched, so a failure cannot damage it.
 */
export async function runAuthorizationSetup(ctx: AuthorizationContext): Promise<boolean> {
  const out = ctx.out ?? ((l: string) => console.log(l));
  const f = ctx.flags;
  try {
    const issuer = resolveIssuerPaths(ctx.env ?? process.env);
    let employeeId = f.employeeId;
    let employeeName = f.employeeName;
    let level: string | undefined = f.level;
    if (ctx.prompter) {
      out('');
      while (employeeId === undefined || employeeId.trim() === '') employeeId = await ctx.prompter.ask('Employee ID');
      if (employeeName === undefined) employeeName = await ctx.prompter.ask('Employee Name');
      if (level === undefined) level = await chooseLevel(ctx.prompter, out);
    }
    if (employeeId === undefined || employeeId.trim() === '') throw new StrictCliError('--employee-id is required for employee authorization');
    if (level === undefined) throw new StrictCliError('--level <L1|L2|L3|L4|L5> is required for employee authorization');
    out('');
    out('Generating signed authorization certificate...');
    const result = await provisionDeveloperAuthorization({
      projectRoot: ctx.cwd,
      now: ctx.now,
      level,
      subject: employeeId.trim(),
      ...(employeeName && employeeName.trim() !== '' ? { displayName: employeeName.trim() } : {}),
      issuer: { authorityDir: issuer.authorityDir, keysDir: issuer.keysDir, keyName: issuer.keyName },
      ...(f.grantDays !== undefined ? { days: f.grantDays } : {}),
    });
    reportSuccess(result, employeeName, out);
    return true;
  } catch (err) {
    if (err instanceof StrictCliError) {
      process.stderr.write(`[codexrev] employee authorization failed: ${err.message}\n`);
      if (/not provisioned/.test(err.message)) for (const line of SIGNING_CREDENTIALS_MISSING.slice(1)) process.stderr.write(`[codexrev] ${line}\n`);
      process.stderr.write('[codexrev] your provider configuration was not changed by this step.\n');
      return false;
    }
    throw err;
  }
}

export function reportSuccess(r: ProvisionResult, name: string | undefined, out: (line: string) => void): void {
  out('');
  out('Employee authorization configured successfully!');
  out('');
  out(`Employee: ${name && name.trim() !== '' ? name.trim() : r.subject}`);
  out(`Employee ID: ${r.subject}`);
  out(`Authorization Level: ${levelLabel(r.level)}`);
  out('Certificate Status: Active');
  out('');
  out('CodeXRev initialization completed.');
}
