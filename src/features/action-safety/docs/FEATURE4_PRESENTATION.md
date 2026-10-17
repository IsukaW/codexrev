# CodeXRev Feature 4 — Presentation Outline (about 4½ minutes)

**Title:** *Feature 4 — Action-Safety and Signed Provenance: deciding ALLOW, ESCALATE or BLOCK before a risky action runs.*

All numbers below come from `FEATURE4_EVALUATION.md` / `evaluation-results.json` (run on 2026-10-17). Say "in our
demonstration" rather than "proved": the sample is small and the system is a research prototype.

The story in one line: **Signed Role-Based Authorization → Automated Safety Assessment → ALLOW / ESCALATE / BLOCK → Signed
Evidence Pack.** There is no per-action team-lead approval: a signed grant is reused until it expires or is revoked, and the
safety assessment still has the final word.

## Time plan

| # | Slide | Time | Cumulative |
|---|---|---|---|
| 1 | The problem | 0:25 | 0:25 |
| 2 | What Feature 4 contributes | 0:20 | 0:45 |
| 3 | How signed role-based authorization works | 0:40 | 1:25 |
| 4 | Safety Score and four gates | 0:40 | 2:05 |
| 5 | ALLOW / ESCALATE / BLOCK | 0:20 | 2:25 |
| 6 | Signed Evidence Pack | 0:25 | 2:50 |
| 7 | **Live demonstration** | 1:10 | 4:00 |
| 8 | Results | 0:20 | 4:20 |
| 9 | Limitations | 0:20 | 4:40 |
| 10 | Close | 0:10 | 4:50 |

(If you have a hard 4-minute limit, shorten slide 7 to three commands: BLOCK for a developer → ALLOW for a release engineer → tamper.)

---

## 1. The problem  (0:25)

* Automated and AI-assisted tools can propose actions: deploy to production, change code, run a migration.
* Today "is this allowed?" is often a line in a file: `"approved": true`, `"level": "L5"`. **Anyone can type that.**
* Even a genuinely allowed action may be too risky to run. Two questions get mixed up: **who may act**, and **how risky is it**.

> *Say:* "A tool that believes a settings file is not checking anything. And permission alone does not make an action safe."

## 2. What Feature 4 contributes  (0:20)

1. **Real authorization:** roles and permissions are *digitally signed* by an administrator and verified; claims in JSON are ignored.
2. **Safety assessment:** a Safety Score from four factors plus four independent safety gates.
3. **A clear decision:** ALLOW, ESCALATE or BLOCK, with reasons.
4. **Signed provenance:** a signed Evidence Pack anyone can verify offline.

*(Show the architecture diagram, `FEATURE4_ARCHITECTURE.md` §2, and point out the two boxes: "who may act" vs "how risky".)*

## 3. How signed role-based authorization works  (0:40)

* The **administrator** signs the company policy (which roles may do which action) and each person's *grant*: roles, an
  optional narrower permission scope, an expiry. The **developer's** key signs a one-time proof of identity for this action.
* A grant is **reused** for every authorized action until it expires (at most 90 days) or is revoked — nobody signs
  per action. A developer at level L4 or L5 can request a production deployment on their own authority.
* CodeXRev checks every signature against a **trust root that the operator pins by fingerprint**. Replace the whole
  directory with your own organization and the fingerprint no longer matches. A key is only believed for the purpose the trust root lists it for.
* It checks expiry, revocation, role, permission and scope, and that the proof matches this exact action and Git commit.
* The one-time challenge is **consumed only at the very end**, after the safety check says ALLOW and the Git commit is
  re-checked — so a refused action wastes nothing and a changed commit is caught.

> *Say:* "Digital signatures: a private key signs, a public key checks, and one changed character breaks the check."

## 4. Safety Score and four gates  (0:40)

* **Score** `= 0.25·R + 0.25·(1−B) + 0.25·A + 0.25·E` — Reversibility, Blast radius, Authority, Evidence strength.
  Bands: **≥ 0.80 ALLOW, 0.50–0.79 ESCALATE, < 0.50 BLOCK** (provisional research values).
* **Four gates**, independent of the score: Authorization · Verified recovery · Build/test · Supporting evidence.
  A failed gate can only make the decision *stricter*.
* In strict mode the **Authority** factor and the **Authorization** gate are fed by the verified signatures — nothing else changed.
  **A role is never a bypass:** a developer at any level must still pass the score, the gates, the evidence and the Git binding.

## 5. ALLOW / ESCALATE / BLOCK  (0:20)

* **ALLOW** — verified and low risk. **ESCALATE** — the score is in the middle band or supporting evidence is missing; it is
  reported to the caller and does **not** start a signature workflow. **BLOCK** — not allowed, or a mandatory gate failed.
* **Valid authorization is necessary, not sufficient:** an authorized developer can still be ESCALATEd (score 0.73) or
  BLOCKed (no test results).
* A *provisional* ALLOW is never reported as ALLOW.

## 6. Signed Evidence Pack  (0:25)

* After a decision, CodeXRev writes a record — action, environment, Git commit, developer, verified permissions, score,
  the four gates, decision with reasons, time — **signed** by the runner's key.
* `verify` checks it **offline** with only the runner's public key: no network, no database, no model.
* Change one signed byte and verification fails. An authentic pack may record a BLOCK; **authentic ≠ safe**, and it does
  **not** prove anything was deployed. An old five-gate (version 1) pack is rejected, never reinterpreted.

## 7. Live demonstration  (1:10)

See the sequence below.

## 8. Results  (0:20)

From the evaluation (small, hand-designed, one machine — no statistical claim):

* **15 / 15** demonstration scenarios correct, in each of 3 repetitions, with identical scores. ALLOW, ESCALATE and BLOCK all shown.
* **0 / 17** attack attempts reached ALLOW (forged administrator signature, narrowed permission scope, revoked or expired
  grant, JSON claims, replaced trust root, changed Git commit, a role used to bypass a failed gate …); both legitimate controls were ALLOWed.
* **29 / 29** modified or wrongly signed Evidence Packs rejected.
* About **1–2 s** per strict assessment (mostly Git calls; run-to-run variation is large) and a few **milliseconds** to verify a pack offline.
* **10 / 10** BLOCK and ESCALATE reports gave a reason and separated "authorization failed" from "safety check failed".

## 9. Limitations  (0:20) — say these out loud

* The **runner is trusted**: someone who can modify CodeXRev itself, the pinned fingerprint or the operating system defeats it.
* **Key provisioning and revocation freshness are assumptions:** the tool cannot tell whether keys were handed out
  honestly, and a revoked grant is only refused if a recent signed revocation list is available.
* **No second person per action:** the controls are the role, scope, grant lifetime, score, gates, Git binding and the signed record.
* The challenge store runs **in the same process**; the clock is the local clock; Git binding covers the **commit**, not the
  deployed artifact. Nothing is deployed by this tool.
* Score weights and thresholds are **provisional**; the test set was designed by us. The standalone tool is **not yet wired
  into the main `codexrev` command line**.

## 10. Close  (0:10)

> "Feature 4 separates *who may act* — proven by signed roles — from *how risky the action is* — scored and gated — and
> leaves a record anyone can check. It is a research prototype with stated limits."

---

## Live-demo sequence (≈ 1 min 10 s)

**Prepare before the talk** (not part of the 70 seconds): follow `FEATURE4_DEMO_GUIDE.md` §7.1–7.3 so that the keys,
the organization `acme`, the grants (alice = L4, bob = L1, carol = L4 narrowed to
`code.modify`), the disposable repository and the evidence files exist. Keep `$Pin`, `$Authority`, `$Keys`, `$App`,
`$Store`, `$Out` and the `cx` helper defined in the PowerShell window; enlarge the font. Do one dry run (it takes ~1–2 s per assessment).

| Step | Command (from the guide) | What to point at | ≈ time |
|---|---|---|---|
| 1 | Section 7.7: `Assess bob deployment production @()` | a developer asks for production: `Role`/`Permission` failed, **`Final Decision: BLOCK`** | 12 s |
| 2 | Section 7.7: `Assess carol deployment production @()` | a release engineer whose grant was **narrowed**: `permission_missing`, **BLOCK** | 10 s |
| 3 | Section 7.5: `cx assess --strict … --as alice --action deployment --environment production … --evidence-pack … --evidence-key runner` | `Developer grant: VERIFIED`, `Challenge consumption: VERIFIED`, `Authorization state: FINALIZED`, four gates, **`Final Decision: ALLOW`** — and no approval line | 18 s |
| 4 | Section 7.6: `cx verify …` | `Signature: VALID`, `Signer: TRUSTED`, `Verification Result: VALID` — and the line "does not mean the action is safe" | 8 s |
| 5 | Section 7.6: edit the decision, `cx verify …` on the tampered file | `Signature: INVALID`, **`Verification Result: INVALID`** | 12 s |
| 6 | Section 7.7: the JSON self-attestation case (bob) | `Ignored claims in the input file…`, **BLOCK** | 10 s |

If something goes wrong on stage, fall back to the one-command version: `npx tsx src/features/action-safety/strict/demo.ts`
(about 20 seconds) prints all 15 scenarios with expected vs observed results.

*(Optional extra, if time allows: the ESCALATE case from Section 7.7 — "authorized, but the score is 0.73".)*

## Likely questions — honest answers

* **"Where did the team-lead approval go? Isn't one person deploying to production dangerous?"** It was removed on purpose:
  authority now comes from administrator-signed role grants. The checks that remain are the verified role and permission,
  the Safety Score, the mandatory gates, the evidence, the Git binding and the signed record. If an organization wants a
  human to look at a particular action, that needs a process outside this tool; an ESCALATE tells the caller that the risk is
  in the middle band but does not collect a signature.
* **"Can a developer just skip `--strict`?"** Yes. This prototype's strict tool is a separate command; a real deployment would
  make it mandatory in CI or an installed wrapper. The original advisory command still believes its input file — that is the
  weakness strict mode removes.
* **"Who is the pinned fingerprint trusted by?"** By whoever supplies it on the command line. The administrator would install
  it where developers cannot change it; the prototype does not enforce that.
* **"What if a grant is stolen or an employee leaves?"** The administrator revokes it; the verifier refuses it as soon as it
  has the new signed revocation list. Until then the grant still works, which is why revocation freshness is a stated limitation.
* **"Can the Evidence Pack be forged?"** Not without the runner's private key. But a modified runner holding the key can sign
  a false record, and the pack never proves that an action ran.
* **"Why is the safety score still shown when the developer is blocked?"** The score and the gates are independent; the report
  shows both so you can see that a high-risk and an unauthorized action fail for different reasons.
* **"Are 15 scenarios enough?"** No statistical claim is made. They show the implementation matches its design on cases we
  chose, including 17 attack attempts; they do not show that no other attack exists.
* **"What about the language model?"** Optional and advisory only; it was off in every demonstration and evaluation and can
  never change a decision to something less strict.

## Slide-to-material map

| Slide | Source |
|---|---|
| 2, 3 | `FEATURE4_ARCHITECTURE.md` §2–§4 |
| 4, 5 | `FEATURE4_DEMO_GUIDE.md` §4 |
| 6 | `FEATURE4_DEMO_GUIDE.md` §5 |
| 7 | `FEATURE4_DEMO_GUIDE.md` §7 (screenshots list in §12) |
| 8, 9 | `FEATURE4_EVALUATION.md` §4–§9 |
