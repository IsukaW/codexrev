# CodeXRev Feature 4 — Research Evaluation

*Feature 4: Action-Safety and Signed Provenance.* Results generated on **2026-10-17** by
`npx tsx src/features/action-safety/strict/evaluate.ts`; the raw, machine-readable numbers are in
[`evaluation-results.json`](evaluation-results.json) (the numbers in this document are copied from that file, and an
automated test checks that they match). Where this document **interprets** a result, the paragraph is labelled
*Interpretation*; everything labelled *Observed* is a measurement or a count taken from a run.

This evaluation describes the **current design**: *Signed Role-Based Authorization → Automated Safety Assessment →
ALLOW / ESCALATE / BLOCK → Signed Evidence Pack*. An earlier version of Feature 4 also required an independent,
signed approval from a team lead for every action; that per-action approval workflow was removed (the evaluation
numbers from that version are not comparable and are not reused).

---

## 1. Research objective

Feature 4 is a prototype that decides whether a proposed action — a code change, a deployment, a migration — should be
**ALLOWed, ESCALATEd or BLOCKed**, using (a) cryptographically signed, role-based authorization and (b) a Safety Score
with four independent safety gates, and that can record the decision in a **signed Evidence Pack** that is verifiable
offline. It is a general-purpose action-safety design; it is not limited to AI agents, to "vibe coding", to deployment
approval or to release management. This evaluation asks:

1. Does it produce **consistent and explainable** decisions?
2. In strict mode, does it **prevent unauthorized actions from being classified ALLOW**?
3. Does an **authorized role still have to pass** the Safety Score, the mandatory gates, the evidence and the Git binding
   (a role must never be a bypass)?
4. Does it **detect tampering** with signed authorization and with Evidence Packs?
5. Is the **command-line workflow practical** for a university demonstration?

It does **not** ask, and the prototype does not claim, whether an attacker who can modify the CodeXRev executable, the
pinned trust-root fingerprint or the operating system can be stopped. They cannot (Section 9).

## 2. Architecture overview

See [`FEATURE4_ARCHITECTURE.md`](FEATURE4_ARCHITECTURE.md). In one paragraph: the administrator signs a policy (the fixed level policy) and
grants that each assign ONE standardized level L1 to L5 (a grant is **reused for every authorized action until it expires or is revoked**); the developer's key
signs a one-time proof of possession; CodeXRev verifies all of it against a **pinned trust root** (this is *authorization
verification*) and hands the verified result to the safety assessment, whose four factors, four gates and decision engine
produce the ALLOW / ESCALATE / BLOCK decision (this is *safety scoring*). Only after an ALLOW does a Git re-check and the
consumption of the one-time challenge finalize the authorization. The runner then signs an Evidence Pack, which anyone
can verify with the runner's public key. There is **no per-action team-lead approval**; an ESCALATE is reported to the
caller and never starts a signature workflow.

## 3. Environment and methodology

| Item | Value |
|---|---|
| Machine | Intel(R) Core(TM) Ultra 7 155H, 22 logical cores, 31.5 GB memory |
| Operating system | Windows (win32 10.0.26200) |
| Runtime | Node v22.14.0 |
| Materials | disposable folders under the temp directory; keys, grants, repository and store are created fresh; deleted afterwards |
| Git | a disposable repository (`inventory-api`); no Git write in the real project |
| Clock | **fixed** for decisions (so results are reproducible); real wall-clock (`performance.now()`) for durations |
| Language model | disabled (advisory only, not part of authorization); no network is used |
| Repetitions | the 15 demonstration scenarios run **3 times**; timing: **10 runs** per operation after **1 discarded warm-up run** (verification: 30 runs) |

What is measured, and how:

* **A. Functional correctness** — the 15 scenarios of the demonstration guide, with the expected result written from the
  design before running; "correct" means *observed = expected*. Repeated 3 times to check consistency (same decision and
  same Safety Score every time).
* **B. Authorization enforcement** — an **attack suite of 17 attempts** (each a different way to try to obtain or forge
  authority, or to use a valid role to bypass a safety check) plus **2 legitimate controls** (so that "everything is
  blocked" cannot pass as a result).
* **C. Evidence integrity** — a genuine pack is modified in **29** ways (or signed wrongly) and verified offline.
* **D. Performance** — durations of whole in-process commands (evidence collection, Git, signature checks, challenge
  store, two safety assessments, report), not including starting a new `node` process.
* **E. Explainability** — every BLOCK and ESCALATE report is inspected for a stated reason and for whether it separates
  an *authorization* failure from a *safety* failure; the Evidence Pack's own authorization status is tabulated.

Everything runs through the same command code (`runStrictCli` / `runStrictAssessment`) that the real tool uses, with real
Ed25519 keys and signatures, the real Git collector, the real authorization evaluator, the real safety assessment and the
real Evidence Pack signer and verifier. The score formula (`0.25·R + 0.25·(1−B) + 0.25·A + 0.25·E`) and the thresholds
(ALLOW ≥ 0.80, ESCALATE 0.50 to below 0.80, BLOCK below 0.50) were not adjusted to make any scenario pass.

## 4. Scenario results (A. functional correctness)

**Observed.** 15 of 15 scenarios behaved as designed in **each** of the 3 repetitions. The decision *and* the Safety Score
were identical in all 3 repetitions. Coverage: **ALLOW ×2, ESCALATE ×1, BLOCK ×9** (the assessments), plus VALID ×1 and
INVALID ×2 (the three Evidence Pack verifications).

| # | Scenario | Expected | Observed | Safety Score |
|---|---|---|---|---|
| 1 | Authorized developer, safe code change | ALLOW (exit 0) | ALLOW (exit 0) | 0.89 |
| 2 | Authorized release engineer, production deployment without a separate approval | ALLOW (exit 0) | ALLOW (exit 0) | 0.83 |
| 3 | Developer without the production permission | BLOCK (exit 11) | BLOCK (exit 11) | 0.58 |
| 4 | Action outside the grant's permission scope | BLOCK (exit 11) | BLOCK (exit 11) | 0.58 |
| 5 | Tampered developer grant | BLOCK (exit 11) | BLOCK (exit 11) | 0.58 |
| 6 | Expired grant | BLOCK (exit 11) | BLOCK (exit 11) | 0.61 |
| 7 | Revoked grant | BLOCK (exit 11) | BLOCK (exit 11) | 0.64 |
| 8 | Forged administrator signature | BLOCK (exit 11) | BLOCK (exit 11) | 0.58 |
| 9 | Self-declared authority in JSON | BLOCK (exit 11) | BLOCK (exit 11) | 0.58 |
| 10 | Git commit changes before finalization | BLOCK (exit 11) | BLOCK (exit 11) | 0.58 |
| 11 | Authorized action with an intermediate Safety Score | ESCALATE (exit 10) | ESCALATE (exit 10) | 0.73 |
| 12 | Authorized action with a failed mandatory gate | BLOCK (exit 11) | BLOCK (exit 11) | 0.71 |
| 13 | Genuine Evidence Pack verifies offline | VALID (exit 0) | VALID (exit 0) | – |
| 14 | Tampered Evidence Pack | INVALID (exit 1) | INVALID (exit 1) | – |
| 15 | Evidence Pack checked against an untrusted key | INVALID (exit 1) | INVALID (exit 1) | – |

*Interpretation.* The implementation matches its design on these 15 cases and is deterministic for fixed inputs. Three
details are worth showing in a presentation. First, scenario 2 shows that a release engineer **can** have a production
deployment ALLOWed without any second person signing anything — but only because every other requirement held (verified
grant and proof, Safety Score 0.83 ≥ 0.80, all four gates passing, an unchanged Git commit, a verified receipt). Second,
in scenarios 3–10 the **score alone** would only say ESCALATE (0.58–0.64); it is the failed authorization gate that makes
the decision BLOCK, which is the point of keeping gates independent of the score. Third, in scenarios 11 and 12 the developer
is fully authorized, yet the result is ESCALATE (0.73 is below the 0.80 ALLOW threshold) or BLOCK (a failed Build/Test
gate): **valid authorization is necessary, not sufficient**. The Safety Score is still *computed* for blocked authorizations;
it uses the blocked authority evidence, so it is low-ish rather than meaningless.

## 5. Authorization enforcement results (B)

**Observed.** **0 of 17** attack attempts reached ALLOW; 16 returned BLOCK (exit 11) and one (A17) returned ESCALATE
(exit 10). **2 of 2** legitimate controls (a development change by a developer and a production deployment by a release
engineer) were ALLOWed. The "pack authorization status" column is what the signed Evidence Pack records for that attempt;
**none** was recorded as `FINALIZED`.

| ID | Category | Attempt | Decision | Pack authorization status | First stated reason |
|---|---|---|---|---|---|
| A01 | authorization | developer without the production permission | BLOCK | DENIED | `role_missing` |
| A02 | authorization | L4 grant narrowed (`permissionScope`) to `code.modify`, attempting a production deployment | BLOCK | DENIED | `permission_missing` |
| A03 | tampering | grant edited by the developer (level raised to L5, longer expiry) | BLOCK | NOT_ESTABLISHED | `signature_verification_failed` |
| A04 | tampering | grant for alice re-signed by a key that is not an administrator key (forged administrator signature) | BLOCK | NOT_ESTABLISHED | `unknown_signing_key` |
| A05 | tampering | grant signed by the challenge-store key (a trusted key, but not for grants) | BLOCK | NOT_ESTABLISHED | `key_purpose_not_allowed` |
| A06 | authorization | revoked grant | BLOCK | DENIED | `grant_revoked` |
| A07 | authorization | expired grant (clock two days after a 1-day grant) | BLOCK | NOT_ESTABLISHED | `grant_expired` |
| A08 | authorization | JSON claiming roles, authorization and disabled gates | BLOCK | DENIED | `role_missing` |
| A09 | authorization | a different person's private key for alice's grant | BLOCK | NOT_ESTABLISHED | `DEVELOPER_KEY_MISMATCH` |
| A10 | trust anchor | wrong pinned trust-root fingerprint | BLOCK | NOT_ESTABLISHED | trust root "does not match the pinned fingerprint" |
| A11 | trust anchor | whole authority directory replaced by an attacker's organization | BLOCK | NOT_ESTABLISHED | trust root "does not match the pinned fingerprint" |
| A12 | tampering | signed policy edited to let every role deploy to production | BLOCK | NOT_ESTABLISHED | "the signed policy is not acceptable" |
| A13 | two-phase | Git commit changes between authorization and finalization | BLOCK | DENIED | "Git context changed since authorization (commit, tree, contentDigest)" |
| A14 | two-phase | the challenge store loses the challenge before consumption | BLOCK | INCOMPLETE | `transport_unavailable` (no verified receipt) |
| A15 | authorization | a key with no administrator-signed grant at all | BLOCK | NOT_ESTABLISHED | `DEVELOPER_GRANT_MISSING` |
| A16 | safety bypass | authorized release engineer with no build/test report (mandatory gate fails) | BLOCK | VERIFIED_NOT_FINALIZED | authorization verified but not finalized; Build/Test gate not passing |
| A17 | safety bypass | authorized release engineer with a very large stated blast radius (intermediate Safety Score) | ESCALATE | VERIFIED_NOT_FINALIZED | authorization verified but not finalized; score in the ESCALATE band |

*Interpretation.* On this attack set, strict mode never produced an ALLOW without a valid signed chain (administrator
signature, trusted key purpose, unexpired and unrevoked grant, proof of possession), an unchanged Git context and a
verified consumption receipt. A02 shows that a grant narrowed by the administrator cannot do what its role alone would
allow; A04 and A05 show that a signature is only believed if it comes from a key the trust root lists **for that purpose**;
A16 and A17 show that a valid role is **not a bypass**: an authorized release engineer is still stopped (or escalated) by the
mandatory gates and the score. The pack records A16 and A17 as `VERIFIED_NOT_FINALIZED` (the *authorization* was fine; the
*safety assessment* did not allow the action, so the challenge was not consumed). This is a **hand-designed** suite: it shows
these 17 routes are closed, not that no other route exists.

## 6. Evidence integrity results (C)

**Observed.** The genuine pack verified as **VALID** (signature VALID, signer TRUSTED, payload VERIFIED). **29 of 29**
modified or wrongly signed packs were rejected (**INVALID**), including an untrusted signer. In no rejected case was a
recorded decision shown.

| Group | Cases | Detected | How it was rejected |
|---|---|---|---|
| A signed field edited without the key (decision, score, a gate result, Git commit, content digest, developer identity, grant id, the gate list, timestamp, assessment id) | 10 | 10 | `Signature: INVALID` — "Signed content has been modified" |
| Only the human-readable copy edited (the same 10 fields) | 10 | 10 | signature valid but `Payload Integrity: FAILED` — "the human-readable copy differs from the signed record" |
| Signature bit flipped | 1 | 1 | `Signature: INVALID` |
| Signature removed | 1 | 1 | `Signature: MISSING` |
| Version 1 pack (five gates and approvals) | 1 | 1 | "Unsupported Evidence Pack version 1 … not reinterpreted" |
| Unknown future version / not JSON | 2 | 2 | "Unsupported Evidence Pack version" / "not valid JSON" |
| Signed by a key the verifier does not trust | 1 | 1 | `Signer: UNTRUSTED` |
| Signed with a *grant*-domain signature over the same bytes | 1 | 1 | envelope domain mismatch |
| Trusted key signs a record that still lists the removed Human Approval gate | 1 | 1 | `Signature: VALID` but the record fails the schema |
| Trusted key signs an ALLOW without a finalized authorization | 1 | 1 | `Signature: VALID` but "signed record is internally inconsistent" |

*Interpretation.* Editing any signed byte breaks the signature, the unsigned display copy cannot be used to mislead a
reader, and the domain separation stops a signature made for one purpose being used for another. The version rows show the
compatibility rule: the Evidence Pack format is now **version 2** (four gates, no approval section) and an old version 1 pack
is **rejected with an explicit message**, never silently read as a four-gate record. The last two rows show a second layer:
even the **holder of the trusted key** cannot produce a record that claims ALLOW without a finalized authorization and a
verified receipt, or one that still carries the removed gate, because the verifier re-checks the record. It does *not*
protect against a trusted key being used to sign a record that is consistent but false (for example, a runner that was
modified).

## 7. Performance results (D)

**Observed.** Milliseconds, 10 runs after 1 discarded warm-up (verification: 30 runs). *sd* = sample standard deviation.

| Operation | n | Mean | sd | Min | Median | Max |
|---|---|---|---|---|---|---|
| Strict development assessment | 10 | 1937.7 | 45.1 | 1829.5 | 1948.6 | 1981.1 |
| Strict production assessment | 10 | 1956.5 | 96.1 | 1844.9 | 1927.7 | 2169.5 |
| Production assessment + signed Evidence Pack | 10 | 2059.3 | 66.1 | 1973.4 | 2034.5 | 2150.4 |
| Offline Evidence Pack verification | 30 | 5.2 | 0.9 | 2.9 | 5.2 | 6.8 |
| *part:* Git action-context collection (once) | 10 | 590.6 | 87.2 | 505.3 | 567.9 | 794.1 |
| *part:* evidence collection | 10 | 764.8 | 107.6 | 702 | 738.1 | 1065.4 |

Observations:

* A strict assessment takes **about 1.8–2.2 seconds** in this run; offline verification takes **about 5 milliseconds**.
* One assessment performs the Git action-context collection **twice** (collect, then re-check before finalization) and one
  evidence collection; together these measure about 591 + 591 + 765 ≈ 1.9 s of a ≈ 1.95 s run.
* Earlier runs of the same script on the same machine, on the same day and before, gave **about 1.0 s** per assessment and
  about 2 ms for verification (a run during the level work with two evaluations accidentally overlapping gave about 2.0 s),
  and about 1.6–1.9 s for the previous design. Run-to-run differences of **a factor of two** are therefore larger than any
  difference between the rows, so the figures say "about one to two seconds" and nothing more precise; they are not a
  benchmark and they are not evidence that any change made the tool faster or slower.

*Interpretation.* The time appears to be dominated by starting and talking to Git processes (each action-context collection
runs 11 Git commands, there are two of them, and the evidence collector runs more), not by cryptography: a whole offline
verification, including reading the file, takes a few milliseconds. This is inferred from the breakdown above, not from a profiler. The
rows should **not** be ranked against each other: the differences between the three assessment rows are within the run-to-run
variation. About one to two seconds per assessment is acceptable for a pre-deployment check and for a live demonstration. These numbers
come from one machine with no control over caching or background load, and are not a benchmark.

## 8. Decision explainability results (E)

**Observed.** All **10 of 10** BLOCK/ESCALATE assessment reports carry at least one stated reason. All **10 of 10** separate
an *authorization* failure from a *safety* failure: the 8 authorization failures (scenarios 3–10) print
`Authorization state: BLOCKED` (authorization not established), and the 2 safety failures (scenarios 11 and 12) print
`Authorization state: NOT FINALIZED` (authorization verified, but the safety assessment did not ALLOW, so nothing was
consumed). Reports also list which safety gates were triggered and which score band applies.

Among the **17 attack reports**, **12** name a specific machine-readable cause in brackets (for example `grant_revoked`,
`unknown_signing_key`, `permission_missing`). The other **5** (A10, A11, A12, A16, A17) state the cause in plain language
without a code: A10 and A11 say the trust root does not match the pinned fingerprint; A12 says the signed policy is not
acceptable; A16 and A17 say authorization is verified but the safety assessment did not ALLOW (the failed gate or the score
band is listed in the next lines).

The signed Evidence Pack records the authorization outcome with five distinct statuses. Across the 17 attacks plus 2
safety-failure runs (a failed gate, a low score) it recorded: **DENIED ×5, INCOMPLETE ×1, NOT_ESTABLISHED ×9,
VERIFIED_NOT_FINALIZED ×4, FINALIZED ×0**.

*Interpretation.* The reports explain *why*, and the structure ("authorization BLOCKED" versus "NOT FINALIZED") lets a
reader tell "you are not allowed" from "you are allowed, but this action is too risky". Weaknesses worth stating: an expired
or tampered grant is reported as `NOT_ESTABLISHED` in the pack, not as a distinct "expired" status (the cause is in the reason
text); and explainability was judged by simple rules (a reason is present; the state label matches the kind of failure), not
by asking people whether they found the explanations clear.

## 9. Limitations and threats to validity

**Security scope (read first).**
* The assessment runner and its Evidence Pack signing key are **trusted**. Anyone who can modify the CodeXRev program, the
  pinned trust-root fingerprint supplied on the command line, or the operating system can defeat every check here. This
  prototype does not claim otherwise.
* **Key provisioning is outside the prototype.** Who generates the administrator, developer and runner keys, how a
  developer's public key reaches the administrator, and how the trust-root fingerprint reaches the people who run `assess`
  are all out of band. The checks are only as strong as that provisioning.
* **Revocation needs fresh information.** A revoked grant is refused only if the verifier has a recent, validly signed
  revocation list (the prototype accepts one for up to 30 days, and treats a missing or stale list as *incomplete*, never as
  "not revoked"). A real deployment would have to distribute and refresh that list far more often.
* **Grants are reused.** Because a grant is valid for every authorized action until it expires or is revoked, an action is no
  longer checked by a second person. The compensating controls are the grant's role, permission scope and lifetime (at most
  90 days), the Safety Score, the mandatory gates, the Git binding and the signed Evidence Pack — not human review. Any
  organization that needs a second person to look at a particular action needs a process for that **outside** this tool.
* The challenge store runs **in the same process** with its key on the same machine: replay protection is local.
* Time is the **local clock**. Git binding covers the clean HEAD snapshot, **not** the artifact that is actually deployed.
  Nothing is deployed by this tool, and an Evidence Pack is **not** proof that an action ran.

**Internal validity.**
* The expected results were written from the design, by the same author who built the system; "correct" means "as
  designed", not "agrees with an independent human judgement".
* The attack suite was designed by the implementer. It checks known routes; it cannot show that unknown routes do not exist.
* Reasons were judged by rules, not by user testing.

**External validity.**
* Small sample: 15 scenarios, 17 attacks, 29 tamper cases, 10 timing runs. **No statistical significance is claimed.**
* One fictional organization, one policy (two rules), one machine, one operating system, a disposable repository with a
  handful of files. Real repositories are larger and Git collection time will grow.
* The Safety Score weights and thresholds are **provisional research values**, not calibrated; the scores in Section 4
  illustrate behavior and are not validated risk measures.

**Construct validity.**
* Timings are for in-process commands with a fixed clock and the language model disabled; real use would add process start-up,
  and the optional local model (not evaluated here) would add its own latency.
* "Explainable" is operationalized narrowly (a stated reason; correct separation of failure kinds).

## 10. Conclusion

**Observed:** on the cases evaluated, strict mode produced the designed decision every time (15/15, three times, with
identical scores), let none of 17 attack attempts reach ALLOW while allowing both legitimate controls, rejected all 29
tampered or wrongly signed Evidence Packs, gave a reason for every BLOCK and ESCALATE, and kept an assessment to about two
seconds and an offline verification to a few milliseconds.

**Interpretation:** these results support the claims that Feature 4 (1) separates *who may act* (verified signatures and
role-based grants) from *how risky the action is* (score and gates), (2) cannot be talked into ALLOW through claims typed
into an input file, (3) does not let a valid role bypass the Safety Score, the mandatory gates, the evidence or the Git
binding, (4) makes tampering with signed records detectable offline, and (5) is practical to demonstrate from a command
line. They do **not** support claims of resistance to a compromised runner, host or pin, of statistical generality, or of
calibrated risk scores; and removing the per-action second-person approval is a **design trade-off**, not a result of this
evaluation. Those are the honest boundaries of this research prototype.

---

## Appendix — reproduce

```powershell
# the evaluation (about 2 minutes; writes evaluation-results.json next to this file)
npx tsx src/features/action-safety/strict/evaluate.ts
# options: --runs <repetitions of the 15 scenarios>  --timing <timed runs>  --out <file>

# the 15 demonstration scenarios on their own
npx tsx src/features/action-safety/strict/demo.ts

# the automated checks
npx vitest run tests/features/action-safety
```
