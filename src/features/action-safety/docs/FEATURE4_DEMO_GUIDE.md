# CodeXRev Feature 4 — Demonstration Guide

**Feature 4: Action-Safety and Signed Provenance.** Before a risky action (a deployment, a code change, a migration)
is allowed to go ahead, CodeXRev checks *who* is asking, *whether their signed role allows exactly this action*, and *how
risky the action is*. It then answers **ALLOW**, **ESCALATE** or **BLOCK** and can write a **signed record** of that answer
that anyone can check later, offline.

The flow in one line: **Signed Role-Based Authorization → Automated Safety Assessment → ALLOW / ESCALATE / BLOCK →
Signed Evidence Pack.** Authority comes from administrator-signed *grants* that are reused for every authorized action
until they expire or are revoked. **A separate per-action team-lead approval is not part of the current design.**

This guide is written for a university presentation. It is a **research prototype**, not a production security
product. Section 11 says plainly what it does *not* do. The design is general-purpose: it is not limited to AI agents,
to code generation, to deployment approval or to release management.

---

## 1. The idea in one minute

Imagine the usual way of saying "I am allowed to deploy": a line in a settings file such as
`"approved": true` or `"level": "L5"`. **Anyone can type that.** A tool that believes it is not
checking anything.

CodeXRev's *strict mode* does not believe such claims. It only believes **digitally signed** documents whose
signatures it can check against a **trusted starting point** chosen by the administrator. If the signature is
wrong, missing, expired, revoked, outside the grant's permissions, or made for a different version of the code, the
answer is **BLOCK**.

```
 Administrator ──signs──▶ Company policy  (the five fixed levels and what each may request)
 Administrator ──signs──▶ Grant for alice (ONE level, L1 to L5, optional narrower scope, until a date)
 Administrator ──signs──▶ Revocation list (grants that no longer count)
 alice's key   ──signs──▶ Proof           (a fresh one-time "it really is me", for THIS action on THIS Git commit)
 CodeXRev checks every signature ─▶ safety score + 4 safety gates ─▶ ALLOW / ESCALATE / BLOCK
 CodeXRev's runner key ──signs──▶ Evidence Pack (a record anyone can verify offline)
```

A developer holding **L4 or L5** may therefore request a production deployment **without** anyone else signing it — but the verified
grant is only the *first* requirement. The Safety Score, the mandatory gates, the evidence and the Git binding must all
still pass. **A role never bypasses a safety check.**

## 2. The people (roles)

| Role | Example | What they hold | What they do |
|---|---|---|---|
| **Administrator** | the security officer of `acme` | the administrator signing key | creates the organization, signs the policy and every grant, revokes grants |
| **Developer** (any level L1–L5) | `bob` (L1), `alice` (L4) | their own signing key | ask for an action; the key proves it is really them |
| **Assessment runner** | the CodeXRev tool | a *dedicated* Evidence Pack signing key (`runner`) | verifies everything, decides, and signs the Evidence Pack |
| **Verifier** | any other person | only the runner's *public* key | checks an Evidence Pack offline |

Keys do not mix: only an administrator-signed grant lets a key act, and the Evidence Pack key must be a *dedicated* key —
the tool refuses a developer, challenge-store or company key for it.

## 2a. The five authorization levels (L1 to L5)

CodeXRev has five **standardized authorization levels**. They are independent of company job titles: an intern, a senior
engineer and a release engineer have no level until the **administrator assigns one** in a signed grant, based on that
person's responsibilities. Each level has a **fixed, predefined permission set** defined in CodeXRev's permission registry
(`authorization/levels.ts`, registry version 1); a developer cannot customize or widen it, and a signed policy that
redefines a level is rejected. Each higher level includes every lower level.

| Level | Permissions (machine-readable ids) | May request (action in environment) |
|---|---|---|
| **L1** | `code.modify` | code change in development |
| **L2** | L1 + `dependency.update`, `config.development` | + dependency upgrade and configuration change in development |
| **L3** | L2 + `deployment.staging`, `config.staging`, `migration.staging` | + deployment, configuration change and database migration in staging |
| **L4** | L3 + `deployment.production`, `rollback.production` | + deployment and rollback in production |
| **L5** | L4 + `infrastructure.maintenance`, `database.maintenance` | + configuration change and database migration in production |

Everything not listed is **denied** (for example a production code change is allowed at no level, not even L5; L5 is an
allowlist, not "run anything"). Reading code, local builds and local unit tests are not CodeXRev actions, so they have no
permission and are not gated by this tool. A level only lets a person **request** an assessment: the Safety Score, the four
gates, the evidence and the Git binding still decide. Two limits to know: the action taxonomy cannot tell infrastructure from
application configuration, so `infrastructure.maintenance` is mapped to *configuration change in production* and held only by
L5; and the Git binding can currently represent only `code_change` and `deployment`, so a staging or production
**migration**, **rollback** or a **configuration change** is authorized by its level but the assessment **fails closed** at the
Git binding (`non_git_artifact_binding_unavailable`) until a non-Git artifact binding exists.

In a signed grant the level is the grant's single role (`l1` to `l5`); changing it needs a new grant signed by the administrator,
and the signature stops a developer editing `l2` into `l5`. The administrator assigns it with `admin grant --level L3`.

## 3. Digital signatures in plain English

A signing key is a pair: a **private key** (secret, stays with its owner) and a **public key** (shared freely).
Signing a document with the private key produces a *signature*. Anyone holding the public key can check that
(a) the signature was made by the owner of the matching private key and (b) the document has not changed by a
single character since. We use **Ed25519**, a standard, fast signature scheme built into Node.js.

CodeXRev never needs a private key to be sent anywhere, and it never prints one. Private keys live in
`~/.codexrev/keys` (or the folder you choose with `--keys-dir`), **never inside a Git repository**.

## 4. The safety assessment

### The Safety Score

Four factors, each between 0 and 1, are combined with equal weights:

```
Safety Score = 0.25·R  +  0.25·(1 − B)  +  0.25·A  +  0.25·E
```

* **R — Reversibility:** can the action be undone? (higher is safer)
* **B — Blast radius:** how much could break? (the formula uses 1 − B, so a *small* blast radius scores well)
* **A — Authority:** how much *verified* authority backs the action? In strict mode this comes from the signed
  grant and the signed policy, never from the input file.
* **E — Evidence strength:** is there fresh, trustworthy evidence (tests passed, security scan clean, a rollback plan)?

Score bands (provisional research values): **≥ 0.80 → ALLOW**, **0.50 – 0.79 → ESCALATE**, **< 0.50 → BLOCK**.
An **ESCALATE** is reported to the caller; it does not start any signature workflow, and nobody can turn it into an
ALLOW by acknowledging it.

### The four safety gates

Gates are yes/no checks that run **independently of the score**. A failed gate can only make the result *stricter*:

1. **Authorization gate** — is this developer really allowed to do this action? (strict mode: administrator-signed grant, role and permission checked against the signed policy, proof of possession, revocation checked)
2. **Verified recovery gate** — for risky or irreversible actions, is there verified recovery (rollback plan, backup)?
3. **Build/test gate** — do fresh build and test results show success?
4. **Supporting evidence gate** — is there other evidence (for example a security scan)?

There is no "human approval" gate and no permanent "Human Approval: PASS" line in any report.

### The final decision

1. The score gives a first answer (ALLOW / ESCALATE / BLOCK).
2. The gates may make it stricter (BLOCK is stricter than ESCALATE, which is stricter than ALLOW). **They can never make it more lenient.**
3. In strict mode there is a last step: only if the answer is ALLOW does CodeXRev re-check that the Git code has not changed and **then** "uses up" the one-time challenge (finalizes). A *provisional* ALLOW that is not finalized is **never reported as ALLOW**.

So: **valid authorization is necessary, not sufficient.** An authorized developer can still be ESCALATEd (risky score) or BLOCKed (failed gate).

## 5. Signed Evidence Packs and offline verification

After an assessment, `--evidence-pack` saves a JSON file that records: the action, the target environment, the exact Git
commit and content digest, who asked (the verified identity, roles and grant), which permissions were verified, the score,
each of the four gates, the decision with its reasons and the time. The record is signed with the runner's key.

**Offline verification** (`verify`) needs only the file and the runner's *public key file*. It contacts nothing — no
network, no database, no language model — and checks: file format and version, that the pack names the key you trust,
the signature, that the human-readable copy equals the signed record, and that the record is consistent (for example a
pack can never claim ALLOW without a finalized authorization and a verified receipt).

**Format version.** Evidence Packs are **version 2** (four gates, no approval section). A pack written by the earlier
five-gate design (version 1) is **rejected with an explicit message**; it is never silently read as a four-gate record.
Assess the action again to obtain a new pack.

**What a valid pack means — and does not:** it proves *the holder of the trusted key signed exactly this record and it
has not changed*. It does **not** prove the action is safe (a genuine pack may record a BLOCK), that the assessment was
correct, or that anything was deployed. The tool says so every time.

---

## 6. Run the whole demonstration with one command (automatic)

From the project folder (`E:\Research Project\codexrev`), in PowerShell:

```powershell
npx tsx src/features/action-safety/strict/demo.ts
```

This creates a **disposable** folder (in your temp directory, outside any Git repository), runs all 15 scenarios of
Section 9 through the real commands with real keys and signatures, prints expected vs observed results, and deletes the
folder. Add `--keep` to keep the files and look inside. No language model, API or internet connection is needed. The same
code is checked by the automated test `tests/features/action-safety/strict/demoScenarios.test.ts`.

## 7. Follow the demonstration by hand (Windows PowerShell)

Everything below uses the real command line. Open PowerShell in any folder.

> **A note on red text.** Windows PowerShell shows a command's *warning* lines in red. After `keygen` you will see
> "Windows file permissions are not checked or enforced by CodeXRev…". That is an intentional, honest warning, not an
> error. Do **not** set `$ErrorActionPreference = 'Stop'`, and do not add `2>&1`.

## 7.0 Onboarding an employee with `codexrev init`

Alice is a developer. Her tech lead takes her laptop and runs `codexrev init`. After the usual provider/API-key setup:

```text
Set up employee authorization? (Y/n): y

Employee ID: EMP001
Employee Name: Alice

Select authorization level:

1. L1 - Developer Level 1
2. L2 - Developer Level 2
3. L3 - Developer Level 3
4. L4 - Developer Level 4
5. L5 - Developer Level 5

Select level: 2

Generating signed authorization certificate...

Employee authorization configured successfully!

Employee: Alice
Employee ID: EMP001
Authorization Level: L2
Certificate Status: Active

CodeXRev initialization completed.
```

That is all that is asked. For scripts: `codexrev init --non-interactive --provider ... --model ... --employee-id EMP001 --employee-name Alice --level L2`.
The installation (`npm install -g codexrev`) is unchanged, and `init` without any of this behaves as before.

**The signing credentials must already be provisioned on that machine.** `init` never creates a trusted signing authority: it uses the issuer
credentials in `CODEXREV_ADMIN_DIR` (default `~/.codexrev/admin`: a public `authority/` folder and a private `keys/` folder). They are created once with the
Feature 4 setup tool of Section 7.1 (`keygen` for `admin` and `store` into `<admin dir>/keys`, then `admin init` into `<admin dir>/authority`). If they are
missing, `init` issues nothing and says so; the provider configuration is left intact.

**The certificate** is the existing signed grant, saved in the project at `.codexrev/authority/grants/<grant-id>.grant.json` and marked **read-only**
where supported (an extra safeguard; the signature is the protection). It carries: the employee id and name, the level (L1 to L5, whose fixed permissions come from
the signed policy), the grant id, the issue and expiry times (30 days by default), the employee's public key, the organization, and the issuer's Ed25519 signature
(made with the issuer key, whose key id the trust root lists). It is verified with the existing grant verifier. A pointer `.codexrev/authorization.json` names the
certificate, and the trusted fingerprint of the issuer's trust root is recorded in the user-level `trusted-roots.json`, outside the project. The employee's own signing key
and the local challenge-store key go to `~/.codexrev/keys` (never into the project or Git); the issuer key is never copied.

**Using it.** From the project:

```powershell
codexrev safety assess --strict --action code_change --target development --input reports/input.json
```

It finds the certificate, verifies the issuer's signature against the independently trusted fingerprint, the employee's key and proof of possession, expiry and
revocation, resolves the level's permissions, checks the requested action, then runs the same Safety Score and four gates. A certificate that was edited (for
example L2 changed to L5), forged, signed with the employee's own key, expired or revoked is rejected (BLOCK). With no usable certificate it stops (exit 3); it
never falls back to claims in an input file.

**Running `init` again** only shows the certificate and its status (also with `--reset`, which replaces the provider configuration only); choosing a different
level is refused. Replacing a certificate is an administrator action outside `init` (with the signing credentials: remove `.codexrev/authorization.json` and run
`init` again, or use the setup tool's `admin grant` / `admin revoke`). Re-running `init` also refreshes the project's copy of the revocation list from the issuer folder.

This is not an interceptor: nothing runs, blocks or intercepts an action by itself; call `safety assess --strict` before acting.

### 7.1 Setup

```powershell
# Where things live. $Demo is disposable and is NOT inside a Git repository.
$Repo      = "E:\Research Project\codexrev"
$Demo      = Join-Path $env:TEMP "codexrev-feature4-demo"
$Keys      = "$Demo\keys"            # private keys: never put these in a Git repository
$Authority = "$Demo\authority"       # public, administrator-signed files
$App       = "$Demo\inventory-api"   # the fictional application's (disposable) Git repository
$Store     = "$Demo\challenge-store" # the local one-time-challenge store
$Out       = "$Demo\evidence"
New-Item -ItemType Directory -Force $Demo, $Out | Out-Null

# A short helper that runs the Feature 4 tool.
function cx { Push-Location $Repo; try { & npx tsx src/features/action-safety/strict/cli.ts @args } finally { Pop-Location } }
```

**Generate the keys** (administrator, challenge store, Evidence Pack runner, `alice` who will hold L4, `bob` who will hold L1,
`carol` who will hold L4 with a narrowed grant, and an outsider `mallory`):

```powershell
foreach ($n in 'admin','store','runner','alice','bob','carol','mallory') { cx keygen --name $n --keys-dir $Keys }
```

Each key gets `<name>.key` (private, secret) and `<name>.pub.json` (public, shareable) in `$Keys`.

**Initialize the organization `acme`:**

```powershell
cx admin init --org acme --dir $Authority --admin-key admin --store-key store --keys-dir $Keys
$Pin = (cx admin fingerprint --dir $Authority | Select-Object -Last 1).Trim()
$Pin
```

`$Pin` is the **trust-root fingerprint**: the administrator's out-of-band statement "this is the real trust root". Everyone
who runs `assess --strict` supplies it, and the tool refuses any trust root that does not match it.

The company policy created by `admin init` is the **level policy** (policy format version 3): exactly the five levels and
ten rules of Section 2a, with no approval fields. The strict tools refuse an older or custom-role policy rather than downgrade
to it. For this demonstration the relevant rules are:

| Action | Environment | Levels that may request it | Permission needed |
|---|---|---|---|
| `code_change` | `development` | L1 to L5 | `code.modify` |
| `deployment` | `production` | L4, L5 | `deployment.production` |
| anything else not in the table of Section 2a | any | nobody (denied by default) | – |

### 7.2 The administrator issues signed grants

```powershell
cx admin grant --dir $Authority --admin-key admin --keys-dir $Keys --subject alice --pubkey "$Keys\alice.pub.json" --level L4 --days 30
cx admin grant --dir $Authority --admin-key admin --keys-dir $Keys --subject bob   --pubkey "$Keys\bob.pub.json"   --level L1 --days 30
cx admin grant --dir $Authority --admin-key admin --keys-dir $Keys --subject carol --pubkey "$Keys\carol.pub.json" --level L4 --days 30 --permission-scope code.modify
```

Alice (L4) may deploy to production and change code; bob (L1) may only change code in development; carol holds L4, but the
administrator **narrowed her grant** (`--permission-scope`) to `code.modify`, so she cannot deploy. A grant is reused for every authorized action until it expires or is revoked; nobody signs anything per action.

### 7.3 A disposable Git repository and some evidence

The assessment needs a Git repository for the application and fresh build/test evidence. (This repository is
disposable; Git commits happen only here.)

```powershell
New-Item -ItemType Directory -Force $App | Out-Null
git -C $App init -q
git -C $App config user.email "demo@example.com"
git -C $App config user.name  "Demo"
git -C $App config core.autocrlf false
Set-Content "$App\.gitignore" "reports/"
Set-Content "$App\app.txt" "version 1"
git -C $App add .
git -C $App commit -q -m "first version"

New-Item -ItemType Directory -Force "$App\reports" | Out-Null
$Now = (Get-Date).ToUniversalTime()
function Ago([int]$h) { $Now.AddHours(-$h).ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }
Set-Content "$App\reports\tests.json" "{`"tool`":`"vitest`",`"kind`":`"test`",`"status`":`"pass`",`"timestamp`":`"$(Ago 1)`",`"summary`":{`"total`":3,`"passed`":3,`"failed`":0}}"
Set-Content "$App\reports\sec.sarif" "{`"version`":`"2.1.0`",`"runs`":[{`"tool`":{`"driver`":{`"name`":`"CodeQL`"}},`"invocations`":[{`"endTimeUtc`":`"$(Ago 1)`"}],`"results`":[]}]}"
$attest = "{`"status`":`"PASS`",`"source`":`"human_attested`",`"observedAt`":`"$(Ago 1)`",`"refs`":[`"ref:demo`"]}"
Set-Content "$App\reports\input.json" "{`"action`":{`"impact`":`"low`",`"irreversible`":false,`"blastRadius`":{`"criticality`":`"low`",`"scope`":`"local`",`"sharedModulesModified`":0,`"dependencyReach`":0,`"affectedServiceCount`":1}},`"reports`":{`"buildTests`":[`"reports/tests.json`"],`"security`":[`"reports/sec.sarif`"]},`"recovery`":{`"rollbackPlan`":$attest,`"rollbackTest`":$attest,`"backup`":$attest}}"
git -C $App status --short     # prints nothing: the tree is clean (reports/ is ignored)
```

`input.json` holds only *evidence* (test results, a rollback plan, the stated blast radius). It is **not** where
permissions come from. The "evidence" timestamps must be recent, which is why they are built from the current time.

### 7.4 A strict development assessment (ALLOW)

```powershell
cx assess --strict --dir $Authority --trust-root-sha256 $Pin --keys-dir $Keys --store-dir $Store `
  --repo $App --input reports/input.json --as bob --action code_change --environment development --target inventory-api
$LASTEXITCODE     # 0 = ALLOW
```

You should see `STRICT DEMO MODE`, every authorization line `VERIFIED`, `Safety Score: 0.89`, the four gates `PASS`
(or `NOT_APPLICABLE`), and `Final Decision: ALLOW`.

### 7.5 A production deployment by a release engineer — ALLOW, with no separate approval and a signed Evidence Pack

```powershell
cx assess --strict --dir $Authority --trust-root-sha256 $Pin --keys-dir $Keys --store-dir $Store `
  --repo $App --input reports/input.json --as alice --action deployment --environment production --target inventory-api `
  --evidence-pack "$Out\assessment-evidence.json" --evidence-key runner
$LASTEXITCODE     # 0 = ALLOW
```

Expected: `Developer grant: VERIFIED`, `Permission: VERIFIED  [deployment.production]`, `Git context: VERIFIED (rechecked …)`,
`Challenge consumption: VERIFIED (signed receipt verified)`, `Authorization state: FINALIZED`, `Safety Score: 0.83`, four
gates, `Final Decision: ALLOW`, and finally `Evidence Pack: signed and written to …\assessment-evidence.json`. Nobody else
signed anything; the decision depends on the verified grant **and** on the score and gates passing. (If the file exists,
add `--overwrite-evidence-pack`.)

### 7.6 Verify the Evidence Pack offline, then tamper with it

```powershell
cx verify --evidence-pack "$Out\assessment-evidence.json" --trusted-key "$Keys\runner.pub.json"
$LASTEXITCODE     # 0 = VALID
```

Output: `Signature: VALID`, `Signer: TRUSTED`, `Payload Integrity: VERIFIED`, `Recorded Decision: ALLOW`, `Verification Result: VALID`.

Now change the recorded decision inside the signed record and verify again:

```powershell
function FromB64Url([string]$s) { $s = $s.Replace('-','+').Replace('_','/'); switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
function ToB64Url([string]$t)   { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)).TrimEnd('=').Replace('+','-').Replace('/','_') }

$pack = Get-Content "$Out\assessment-evidence.json" -Raw | ConvertFrom-Json
$doc  = (FromB64Url $pack.envelope.payload) | ConvertFrom-Json
$doc.safety.decision = 'BLOCK'                                    # the edit
$pack.envelope.payload = ToB64Url ($doc | ConvertTo-Json -Depth 20 -Compress)
$pack | ConvertTo-Json -Depth 20 | Set-Content "$Out\assessment-evidence.tampered.json"

cx verify --evidence-pack "$Out\assessment-evidence.tampered.json" --trusted-key "$Keys\runner.pub.json"
$LASTEXITCODE     # 1 = INVALID
```

Output: `Signature: INVALID`, `Verification Result: INVALID`, `Reason: Signed content has been modified, or the signature is not from the trusted key`.
The recorded decision is **not** shown for an invalid pack.

**A pack checked against a key you do not trust** is rejected too (here the verifier trusts only mallory's key, not the
runner's):

```powershell
cx verify --evidence-pack "$Out\assessment-evidence.json" --trusted-key "$Keys\mallory.pub.json"
$LASTEXITCODE     # 1 = INVALID  (Signer: UNTRUSTED)
```

### 7.7 More scenarios by hand

Run these after 7.5. They use the helper functions from 7.6 and this small helper that prints just the outcome:

```powershell
function Assess($who, $action, $env, $extra) {
  $r = & { cx assess --strict --dir $Authority --trust-root-sha256 $Pin --keys-dir $Keys --store-dir $Store --repo $App --input reports/input.json --as $who --action $action --environment $env --target inventory-api @extra }
  $code = $LASTEXITCODE; $txt = $r -join "`n"
  "decision=" + [regex]::Match($txt,'Final Decision: (\w+)').Groups[1].Value + "  exit=$code  first reason: " + ([regex]::Matches($txt,'(?m)^  - (.*)$') | Select-Object -First 1).Groups[1].Value
}
New-Item -ItemType Directory -Force "$Demo\forged" | Out-Null
```

**Developer without the production permission (BLOCK):**
```powershell
Assess bob deployment production @()
```

**Action outside the grant's permission scope (BLOCK)** — carol's role allows deployments, but her narrowed grant does not:
```powershell
Assess carol deployment production @()
```

**Tampered developer grant (BLOCK)** — bob raises his L1 grant to L5 and lengthens its expiry:
```powershell
$gf = (Get-ChildItem "$Authority\grants" -Filter 'grant-bob-*').FullName
$g  = Get-Content $gf -Raw | ConvertFrom-Json
$gd = (FromB64Url $g.payload) | ConvertFrom-Json; $gd.roles = @('l5'); $gd.expiresAt = '2035-01-01T00:00:00Z'
$g.payload = ToB64Url ($gd | ConvertTo-Json -Depth 20 -Compress)
$g | ConvertTo-Json | Set-Content "$Demo\forged\bob.tampered.grant.json"
Assess bob deployment production @('--grant-file', "$Demo\forged\bob.tampered.grant.json")
```

**Forged administrator signature (BLOCK)** — an attacker creates a second "acme" organization with their own
administrator key, issues alice a perfectly signed grant there, and tries to use it against the real organization:
```powershell
cx keygen --name evil-admin --keys-dir $Keys | Out-Null
cx admin init --org acme --dir "$Demo\evil-authority" --admin-key evil-admin --store-key store --keys-dir $Keys | Out-Null
cx admin grant --dir "$Demo\evil-authority" --admin-key evil-admin --keys-dir $Keys --subject alice --pubkey "$Keys\alice.pub.json" --level L4 --days 30 | Out-Null
$evil = (Get-ChildItem "$Demo\evil-authority\grants" -Filter 'grant-alice-*').FullName
Assess alice deployment production @('--grant-file', $evil)   # the signing key is not in the real trust root
```

**Revoked grant (BLOCK):**
```powershell
cx keygen --name dave --keys-dir $Keys | Out-Null
$o = cx admin grant --dir $Authority --admin-key admin --keys-dir $Keys --subject dave --pubkey "$Keys\dave.pub.json" --level L1 --days 30
$daveGrant = [regex]::Match(($o -join "`n"),'Issued grant (\S+)').Groups[1].Value
cx admin revoke --dir $Authority --admin-key admin --keys-dir $Keys --grant $daveGrant
Assess dave code_change development @()
```

**JSON self-attestation (BLOCK)** — bob writes into his input file that he is level L5, authorized, and that no gates are required:
```powershell
$claim = "{`"status`":`"PASS`",`"source`":`"verified_system`",`"observedAt`":`"$((Get-Date).ToUniversalTime().ToString('o'))`",`"refs`":[`"ref:x`"]}"
Set-Content "$App\reports\claims.json" "{`"actor`":{`"id`":`"bob`",`"kind`":`"human`",`"roles`":[`"l5`"]},`"authority`":{`"authorization`":$claim,`"identityVerification`":$claim},`"policy`":{`"authorization`":{`"required`":false},`"recovery`":{`"required`":false,`"whenIrreversible`":false},`"buildTests`":{`"required`":false},`"supportingEvidence`":{`"required`":false}},`"action`":{`"impact`":`"low`",`"irreversible`":false}}"
cx assess --strict --dir $Authority --trust-root-sha256 $Pin --keys-dir $Keys --store-dir $Store --repo $App --input reports/claims.json --as bob --action deployment --environment production --target inventory-api
```
The report ends its authorization section with `Ignored claims in the input file (strict mode never trusts these): actor (identity and roles), authority.authorization, …, policy (gate rules)` and the decision is BLOCK.

**An authorized release engineer cannot bypass a failed gate (BLOCK)** — alice is authorized, but there is no build/test report:
```powershell
Set-Content "$App\reports\no-tests.json" "{`"action`":{`"impact`":`"low`",`"irreversible`":false,`"blastRadius`":{`"criticality`":`"low`",`"scope`":`"local`",`"sharedModulesModified`":0,`"dependencyReach`":0,`"affectedServiceCount`":1}}}"
cx assess --strict --dir $Authority --trust-root-sha256 $Pin --keys-dir $Keys --store-dir $Store --repo $App --input reports/no-tests.json --as alice --action code_change --environment development --target inventory-api
```
`Developer grant: VERIFIED`, `Build/Test Gate UNKNOWN`, `Authorization state: NOT FINALIZED`, `Final Decision: BLOCK`.

**A lower score escalates even though the developer is authorized (ESCALATE):**
```powershell
$ok = $attest
Set-Content "$App\reports\risky.json" "{`"action`":{`"impact`":`"high`",`"irreversible`":false,`"blastRadius`":{`"criticality`":`"critical`",`"scope`":`"database_wide`",`"sharedModulesModified`":8,`"dependencyReach`":40,`"affectedServiceCount`":12}},`"reports`":{`"buildTests`":[`"reports/tests.json`"],`"security`":[`"reports/sec.sarif`"]},`"recovery`":{`"rollbackPlan`":$ok,`"rollbackTest`":$ok,`"backup`":$ok}}"
cx assess --strict --dir $Authority --trust-root-sha256 $Pin --keys-dir $Keys --store-dir $Store --repo $App --input reports/risky.json --as alice --action code_change --environment development --target inventory-api
$LASTEXITCODE     # 10 = ESCALATE (Safety Score 0.73)
```

**Expired grant** and a **Git commit that changes between the assessment and the finalization** cannot be shown live
conveniently (the shortest grant is 1 day; the commit change must happen *inside* the run). The automatic demo
(Section 6) shows both: it moves its clock forward two days, and it commits a change to a disposable repository at exactly
the right moment.

### 7.8 Clean up

```powershell
Remove-Item -Recurse -Force $Demo
```

## 8. Exit codes (useful for scripts)

| Command | Code | Meaning |
|---|---|---|
| `assess` | 0 / 10 / 11 | ALLOW / ESCALATE / BLOCK |
| `assess` | 1 / 2 / 3 | invalid input / usage error / incomplete |
| `verify` | 0 / 1 / 2 | VALID / INVALID / usage error |

## 9. Scenario matrix

These are the **observed** results of `npx tsx src/features/action-safety/strict/demo.ts` (and of the automated test
that checks them). "Expected" is what the design says should happen; "observed" is what the real commands returned.
The safety scores are deterministic here because the demo uses a fixed clock.

| # | Scenario | Setup | Expected | Observed | Reason (from the real output) |
|---|---|---|---|---|---|
| 1 | Authorized developer, safe code change | bob holds a signed L1 grant; `code_change` in development is within L1 | ALLOW (exit 0) | ALLOW (exit 0) | authorization FINALIZED, safety score 0.89 |
| 2 | Authorized release engineer, production deployment without a separate approval | alice holds a signed L4 grant (`deployment.production`); nobody else signs anything | ALLOW (exit 0) | ALLOW (exit 0) | authorization FINALIZED, safety score 0.83, all four gates pass |
| 3 | Developer without the production permission | bob's L1 grant has no `deployment.production` | BLOCK (exit 11) | BLOCK (exit 11) | `role_missing`, `permission_missing`; Authorization gate FAIL |
| 4 | Action outside the grant's permission scope | carol holds L4, but her grant is narrowed to `code.modify` | BLOCK (exit 11) | BLOCK (exit 11) | `permission_missing`; Authorization gate FAIL |
| 5 | Tampered developer grant | bob edited his grant (L1 raised to L5, longer expiry) | BLOCK (exit 11) | BLOCK (exit 11) | `DEVELOPER_GRANT_INVALID … signature_verification_failed` |
| 6 | Expired grant | erin's 1-day grant, assessed two days later (clock moved forward) | BLOCK (exit 11) | BLOCK (exit 11) | `DEVELOPER_GRANT_INVALID … grant_expired` |
| 7 | Revoked grant | dave's grant is on the signed revocation list | BLOCK (exit 11) | BLOCK (exit 11) | `grant_revoked` |
| 8 | Forged administrator signature | a grant for alice re-signed with mallory's key, which is not an administrator key | BLOCK (exit 11) | BLOCK (exit 11) | `DEVELOPER_GRANT_INVALID … unknown_signing_key` |
| 9 | Self-declared authority in JSON | bob's input file claims level L5, "authorized", no gates | BLOCK (exit 11) | BLOCK (exit 11) | claims listed as ignored; `role_missing`, `permission_missing` |
| 10 | Git commit changes before finalization | alice is authorized and the assessment says ALLOW, but the repository moves to a new commit before finalization | BLOCK (exit 11) | BLOCK (exit 11) | "Git context changed since authorization"; challenge not consumed |
| 11 | Authorized action with an intermediate Safety Score | alice authorized, every gate passes, large stated blast radius | ESCALATE (exit 10) | ESCALATE (exit 10) | safety score 0.73 (below 0.80); authorization NOT FINALIZED |
| 12 | Authorized action with a failed mandatory gate | alice authorized, no build/test report | BLOCK (exit 11) | BLOCK (exit 11) | Build/Test gate UNKNOWN; authorization NOT FINALIZED; challenge not consumed |
| 13 | Genuine Evidence Pack verifies offline | the pack from #2 | VALID (exit 0) | VALID (exit 0) | `Recorded Decision: ALLOW`, `Payload Integrity: VERIFIED` |
| 14 | Tampered Evidence Pack | recorded decision edited | INVALID (exit 1) | INVALID (exit 1) | `Signature: INVALID`, "Signed content has been modified" |
| 15 | Evidence Pack checked against an untrusted key | the pack from #2, verified with mallory's key | INVALID (exit 1) | INVALID (exit 1) | "signed by a key that is not the trusted signing key" |

**ALLOW, ESCALATE and BLOCK are all demonstrated** (ALLOW: #1, #2; ESCALATE: #11; BLOCK: #3–#10, #12). In scenarios 3–10
the *score alone* would only say ESCALATE (0.58–0.64); it is the failed authorization gate that turns it into BLOCK —
the gates are independent of the score.

## 10. How the self-attestation bypass is prevented

* In strict mode the input file's `actor`, `authority` and `policy` sections are **removed before anything is collected**
  and are reported as ignored. A claim of `human_attested` or `verified_system` counts for nothing.
* Authority reaches the assessment only through a **branded object** that the signed-authorization code alone can build
  (`buildStrictAuthorityInput`); copies and hand-written objects are refused, and a test checks it.
* The rules for the four gates in strict mode are fixed in code; the input file cannot switch a gate off.
* The trust anchor is the **pinned fingerprint**; replacing the whole authority folder with an attacker's own organization
  is refused because its fingerprint does not match, and a grant signed by a key the trust root does not list for grants
  is refused.
* There is no silent fallback: any error in strict mode ends in BLOCK. The tool only runs strict assessments, and
  `--strict` and the pin are required.

## 11. Research limitations (read these before presenting)

* **The runner is trusted.** Someone who can modify the CodeXRev program itself, or the machine's operating system,
  defeats everything. There is no privileged service or tamper-proof hardware.
* **The pin is only as trustworthy as whoever supplies it.** Anyone who controls the command line controls the pin.
  In a real organization an administrator would install it where developers cannot change it.
* **Key provisioning is out of scope.** How keys are generated, how public keys reach the administrator and how the pin
  reaches users is not handled by the tool; the checks are only as strong as that process.
* **Revocation needs fresh information.** A revoked grant is refused only if a recent, validly signed revocation list is
  available (the prototype accepts one for up to 30 days; a missing or stale list is *incomplete*, never "not revoked").
  A real deployment would refresh it far more often.
* **Grants are reused; there is no per-action second person.** The compensating controls are the role, the permission
  scope, the grant lifetime (at most 90 days), the Safety Score, the mandatory gates, the Git binding and the signed
  Evidence Pack. If an organization wants a human to look at a particular action, that needs a process outside this tool.
* **The challenge store runs inside the same process**, with its key on the same machine. It gives real signature
  checks and local replay protection, not enforcement by a separate trusted party.
* **Time is the local clock.**
* **Git binding covers the clean HEAD snapshot of the repository, not the artifact that is actually deployed.**
  Nothing is deployed by this tool; it only assesses.
* **A valid Evidence Pack does not prove the action ran, was safe, or that the assessment was right.**
* **Safety weights and thresholds are provisional research values**, not calibrated.
* **Windows file permissions are not checked**; the tool warns instead of pretending.
* The optional local-language-model interpretation is advisory and was not used in these demonstrations.
* The advisory (non-strict) mode of the main `codexrev safety assess` command is unchanged; it still *believes* the
  claims in its input file — that is exactly the weakness strict mode removes.
* **The main CLI connection is minimal.** `codexrev init` can onboard a developer and `codexrev safety assess --strict` runs the
  strict assessment from the saved record. The setup commands (`keygen`, `admin ...`, `verify`, Evidence Pack output) are still the standalone tool
  `strict/cli.ts`; nothing intercepts external actions automatically, and `safety verify` in the main CLI is still not connected.
* **The trusted fingerprint lives in user-level settings.** Replacing project files cannot bypass it, but someone who can edit
  `~/.codexrev/trusted-roots.json`, the environment, or the CodeXRev program itself controls all local trust settings and defeats the check.
  A project created before this fix has no such entry until the administrator re-runs `init` with the administrator credentials (or sets
  `CODEXREV_TRUST_ROOT_SHA256`); until then strict assessment refuses to run.
* **The issuer signing key is read on the machine where `init` runs.** It is not password-protected and is kept apart from the employee's keys, so whoever can read
  `CODEXREV_ADMIN_DIR` can issue certificates (or create their own authority with the setup tool). Keep that folder where the employee cannot reach it (the tech lead's own
  account or removable storage). Nothing protects against someone who controls the machine's local trust settings or the CodeXRev program.
* **Replaced certificates are not revoked automatically.** They simply expire (30 days by default); revoke one explicitly with the setup tool if needed. Only the challenge-store key is copied to the developer machine, and only if the trust root lists it for the challenge store
  **alone** (never an administrator or other signing key); it cannot sign grants, policies or revocation lists (the verifiers reject it by key purpose).
* **A level change revokes the old grant only where the organization directory is used.** A copy of the old grant file kept elsewhere is
  refused wherever the updated revocation list is used.

## 12. Screenshots to capture for the presentation

1. `cx keygen` output showing a key id and the warning about Windows permissions (and the key folder **outside** the repo).
2. `cx admin init` output, including the trust-root fingerprint line.
3. The `admin grant` outputs (alice, bob, and carol's narrowed grant with its permission scope).
4. The strict **ALLOW** report for the development change (Section 7.4): the Authorization block, safety score and four gates.
5. The strict **ALLOW** production deployment by the release engineer (Section 7.5) showing `Challenge consumption: VERIFIED`, `Authorization state: FINALIZED` and no approval line.
6. The `Evidence Pack: signed and written…` line and the beginning of the pack file.
7. `cx verify` on the genuine pack: `Signature: VALID … Verification Result: VALID` and the "does not mean the action is safe" note.
8. `cx verify` on the tampered pack: `Signature: INVALID … Verification Result: INVALID`.
9. The BLOCK for the narrowed grant (Section 7.7) and for the forged administrator signature.
10. The JSON self-attestation BLOCK with the `Ignored claims…` line.
11. The ESCALATE case (Section 7.7) with `Safety Score: 0.73`.
12. The automatic demo's final table: `All 15 scenarios behaved as designed.`
13. The passing test run: `npx vitest run tests/features/action-safety` (all tests green).

## 13. Troubleshooting

* **"The trust root does not match the pinned fingerprint"** — `$Pin` is stale. Run `cx admin fingerprint --dir $Authority` again.
* **"The revocation list is not acceptable … expired"** — the list is valid for 30 days; the administrator renews it with
  `cx admin refresh-revocation --dir $Authority --admin-key admin --keys-dir $Keys`.
* **Everything BLOCKs with `UNKNOWN` build/test gates** — the evidence timestamps in `input.json` are older than the freshness
  limit. Re-run the evidence step in Section 7.3 to regenerate them.
* **"Git context unavailable … working tree is not clean"** — commit or discard changes in the repository (files under
  `reports/` are ignored and do not count).
* **"The Evidence Pack file already exists"** — choose a new file name or add `--overwrite-evidence-pack`.
* **"Unsupported Evidence Pack version 1"** — the pack was written by the earlier five-gate design; assess the action again.
* **`npx tsx` is slow on first start** — that is normal; each command takes a second or two.

## 14. Related documents

* `FEATURE4_ARCHITECTURE.md` — diagrams (Mermaid) of the flow, the two-phase run and who signs what.
* `FEATURE4_EVALUATION.md` — the research evaluation (method, results, limitations) and `evaluation-results.json`.
* `FEATURE4_PRESENTATION.md` — a 4½-minute talk outline and a live-demo sequence.
* Re-run the evaluation: `npx tsx src/features/action-safety/strict/evaluate.ts` (about 2 minutes).
