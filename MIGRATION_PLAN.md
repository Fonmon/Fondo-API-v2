# Fondo-API — Django → NestJS Migration Plan

**Spec of record for v1 behavior:** `CONTEXT.md` in the v1 repo (`~/Projects/Fondo-API`).
When CONTEXT.md and the v1 source disagree, **the source wins** and CONTEXT.md gets fixed.

- **v1 (Django):** `~/Projects/Fondo-API`
- **v2 (NestJS):** `~/Projects/Fondo-API-v2` (this repo)

## Changelog

| Date | Rev | Change |
|---|---|---|
| 2026-09-14 | v4.31 | Board row 9 corrected: it still read "Blocked on P8 and P8b" after v4.30 closed both. Phase 9 starting. |
| 2026-09-14 | v4.30 | ✅ **Phase 8b CLOSED — approved** on re-check of `796ba2b`. C71, C87, C88, C89 closed; D39, D48, D49 implemented. `TIME_ZONE` is now pinned, so **runbook step 3** gains a pre-boot check of production's value (review N3 — not verifiable from the repo). **C90** opened for two non-gating test nits (Phase 9 cleanup). Phase 9 next. |
| 2026-09-14 | v4.29 | 🟡 **Phase 8b fix round landed** at `796ba2b` (C88 int4 guard, C89 zone pinned to `America/Bogota`, C87 wording). Gate re-measured independently (lint 0, `tsc` 0, 2590 / 80 unit, 1348 + 2 e2e, fixture diff 0 / control 1; per-suite deltas attributed); register hashes match the commit (17 of 17). Re-check with `nestjs-reviewer` dispatched. |
| 2026-09-14 | v4.28 | 🟡 **Phase 8b review: APPROVED WITH CONDITIONS.** One measured code defect — **C88**: an `owner_id` above int4 reaches Prisma and throws P2020, where the code, the register and a test name all claimed it skips as missing (the unit cell mocked the lookup; the e2e cell used 999999). **C89**: D48's zone and the runner's selection zone have different sources. **C87** widened to three sites. The rest verified with checks named in the review. Fix round dispatched to `nestjs-developer`. |
| 2026-09-14 | v4.27 | ✅ **Phase 8b parity PASS** (`docs/parity-phase-8b.md`): every v1/v2 difference is D48, D39, D49, D19 or D15; payment reminders byte-identical; resulting rows byte-identical across stacks; `fondodev` untouched (content md5). Noted: v1 cannot save Ainhoa's profile at all (409, D15), so Q36 is a v2-only outcome; clone planner statistics differ after `reset-clone.sh`, so `ANALYZE` before byte-comparing unordered lists. |
| 2026-09-14 | v4.26 | ✅ **`business-analyst` Phase 8b: code aligned; runbook concern resolved by the operator.** Runbook 3a/3a-bis (written under Q35) marked tasks 1497 and 2142 processed, ending both chains, against Q48. **Q51 — delete both** (the analyst had recommended moving them to the next birthday); **Q52 — how a member returns is not established.** The departed-owner sweep used an inner join that could not see a missing owner and a cast that aborts on a non-numeric `owner_id`; rewritten and measured read-only on `fondodev` (returns 1497 and 2142 of 14 pending chains; a `VALUES` control sweeps an unknown id, `abc`, `99999999999` and not active owner 9). Q-8b-1/2/3 answered by the analyst without the operator; **C87** opened for a wrong sentence in the developer's §6. Residual recorded: a birthdate save between the two passes on the birthday greets the fund twice (v1 too). |
| 2026-09-14 | v4.25 | 🟡 **Phase 8b implemented** at `5e3457a` (D48, D39, D49; C71, Q36). Gate re-measured independently: lint 0, `tsc` 0, 2573 / 79 unit, 1345 + 2 e2e, fixture diff 0 / control 1; per-suite deltas match the developer's attribution. Mutation: 20/20 behaviour mutants killed, 3/3 blind controls survived; M3 (host-zone year) first survived because every cell ran under UTC and is now killed under `Asia/Tokyo` / `Pacific/Kiritimati`. ⚠️ **Instrument correction:** `ps -C node,python3`, used as a guard in this plan's briefs and in my gate runs since Phase 7b, cannot see jest (comm `MainThread`) or npm (`npm run …`); replaced by a process-name filter checked against a live run. |
| 2026-09-14 | v4.24 | ✅ **Phase 8 CLOSED — approved** on re-check of `8948f79`. Gate re-measured independently (lint 0, `tsc` 0, 2513 / 77 unit — −4 attributed to `drf-request-data.spec.ts`, 1331 + 2 e2e, fixture diff 0 / control 1). Mutation: 17 of 17 killed with both blind controls surviving on re-hashed targets; inverted R7 killed; the nine R/C mutants planting into M1's files re-run, 9 of 9 killed; the reviewer confirmed the exemption for the rest. **C79 closed** (re-measured 500/500), **C85 closed**. **C86** — v2's `X-Frame-Options` on the gunicorn-page 500s, register only, pinned at `a963e5f`; D22 and D24 wording widened. ⚠️ **Corrected:** D22's C79 note claimed "every other invalid boundary" is 500/500 — an unquoted trailing space is 201/201 and a too-long boundary is unmeasured. The parity report and deviations doc also wrongly said the `G-type-*` 500s have no `Vary`; both stacks send `Vary: Origin` (measured). |
| 2026-09-14 | v4.23 | ✅ **Q50 — development storage stays as in v1.** The reviewer's m3: outside tests, v2 uses the machine's Google credentials and defaults to the production bucket, as v1 does. The operator kept that behaviour; the test environment's refusal (P8-D2) is unchanged. This host has no Google credentials (measured). |
| 2026-09-14 | v4.22 | 🔴 **Phase 8 review: CHANGES REQUESTED, narrow.** The gate reproduced on every step and no code changed after `5f58b11`. **Rulings:** C79 — D22 does not apply to `POST /api/file`, so v2 answers 500 like v1 there; C80 — D45 registered permanently, with a harness rule to compare parsed JSON when a body contains U+2028/U+2029; C85 — belongs to P8-D4, no fix, but must be pinned; C83 — non-gating. **Required:** remove the D22 branch (M1), pin `Vary: Origin` and correct a test title that claimed none (m1), rewrite one universal comment as the measured list (m2), then re-run the gate and the mutation set on the new hashes. D45's "so a change cannot land silently" corrected to what the single cell actually covers. **m3** — v2 can reach the production bucket from a development environment that has Google credentials, as v1 can — is with the operator. |
| 2026-09-14 | v4.21 | ✅ **Operator decisions for Phase 8b (Q47–Q49).** **Q47 / D48** — a birthdate saved after this year's birthday schedules next year's, including a birthday today once the 14:00 Bogotá pass has run; this goes one step past `business-analyst`'s recommendation, which accepted a greeting one day late. **Q48 / D39** — a departed member's greeting is skipped at send time while the yearly chain keeps rolling, so a returning member resumes automatically. **Q49 / D49** — birthday greetings go to the current active members at send time; measured 2026-09-14, 11 of 14 pending chains missed a current member and 13 of 14 still listed someone who had left. C71 decided; Ainhoa's chain starts correctly once D48 lands. Residual recorded, not decided: an outage spanning a birthday still delivers a late "hoy". |
| 2026-09-14 | v4.20 | ✅ **Phase 8 parity round PASS** on `5f58b11` (`docs/parity-phase-8.md`): no unexpected difference between v1 and v2 across 68 read-only and 83 upload cases; D46 and D47 conform to the spec with zero storage calls on every refusal; **C81 closed by measurement** on both approved bulk-upload routes. Two claims in the developer's doc were wrong and are corrected: the headers on init-time multipart 500s do not match (v1 no `Vary`, v2 `Vary: Origin`, now **C85**), and a trailing-space boundary is 500/500 only when quoted. ⚠️ One gap recorded, not passed: the proxy meant to fence v1 away from GCS was never controlled; with no real credentials on the host, nothing authenticated could have reached `fonmon`. ⚠️ **And one false green of mine, caught before any commit:** my credential scan of the tester's report failed to compile, and an `if grep -q … else` read the error as "no match". The scan was redone with every pattern compiling, exit codes read explicitly, and a planted-secret control. |
| 2026-09-14 | v4.19 | 🟡 **D46 and D47 implemented** at `5f58b11`, per operator Q40–Q42; gate re-measured independently (lint 0 · `tsc` 0 · **2517 unit / 77** · **1331 e2e passed + 2 skipped; 22 suites passed + 1 skipped of 23** · fixture diff 0 / control 1). The developer's mutation table was first measured on source files it then edited, so it was re-run on the final files: 17 of 17 killed and both blind controls surviving, recorded against hashes that the committed files match. ⚠️ **v4.18's gloss on D46 was not exact:** its predicate also refuses one non-orphan case (`Dup X` over an existing `DUP X` of the other type) and does not cover two concurrent cross-type uploads. The operator kept the refusal (**Q44**), left the concurrent window as a known residual (**Q45**), and kept 400 for a `type` sent as a file part (**Q46**). **C82 closed.** **C84 added** — before cutover, someone with bucket access compares `fonmon` against the live file rows, because six missing ids suggest v1 may already have left orphaned objects. |
| 2026-09-12 | v4.18 | ✅ **Operator decisions on Phase 8 (Q40–Q43).** **Q40** refuse a document name reused under the other type before any storage call — **D46**, 409; the predicate is exact (same `display_name`, different type), which is precisely the case that orphans an upload ⚠️ *(→ not exact in either direction, measured — see v4.19, Q44, Q45)*. **Q41** keep v1's silent same-type replacement, case variants included, with no log line. **Q42** refuse any `type` other than the integer 0 or 1 — **D47**, 400, before any storage call. The status codes and message bodies of D46/D47 are the implementer's choice, following v1's existing conflict and validation responses. **Q43** C71 and D39 get their own **Phase 8b** before Phase 9. The Phase 8 parity round was interrupted by a session limit before producing anything; it re-runs once, after D46/D47 land. |
| 2026-09-12 | v4.17 | 🟡 **PHASE 8 IMPLEMENTED** at `71cd7de`; gate re-measured independently and matching the developer on every step (2482 / 77 unit; 1297 + 2 e2e, 22 + 1 of 23 suites). ⚠️ **My brief's fixture gate could not see this phase's table** — `fixture-check.sh` had no row for `fondo_api_file` beyond its sequence. Measured directly (37 / 43 / `xmin` 1 / seq 43), then covered at `4ab180a` with a re-saved baseline. Three more errors in my brief, all found by the developer: the 25/15 counts come from v1 data migrations, not a test fixture; `docs/adding-a-route.md` §6 stated `UserView.patch`'s measured parser table as holding for `FileView.post`, where a missing file part is **400** and `text/plain` is **500** (corrected here); and the brief's upload helper carried the first-part defect. **Folded back:** §3 Phase 8 scope (the upload is unconditional), rule 12c (presence precedence and last-part-wins), P8-F5 notes on Phases 3 and 4, a D22 note, **§5 D45** (U+2028/U+2029), conditions **C79–C83**. |
| 2026-09-12 | v4.16 | 🟡 **PHASE 8 STARTED** on `feat/phase-8-files` from `560df45`. The brief was written from v1's source and `fondodev`, measured rather than paraphrased from §3 — §3 says `save_file` checks `blob.exists()`; it also **uploads unconditionally**, which §3 does not say. Eight pre-brief measurements are recorded in ▶ Now, including two parity traps (a scalar `file` field is v1 500 but would be v2 400 under rule 12c; a cross-type duplicate name stores the object and then 500s), a nondeterministic list order on real data (one `created_at` tie), and a 95-code-point `lower()` difference between the pinned CPython and Node that affects 0 of the 37 live file names. No GCS credentials are reachable from this host. **Still open:** C71 and D39 have no owning phase; task 2142 before 14 November 2026. |
| 2026-09-12 | v4.15 | ✅ **PHASE 6 CLOSED — APPROVED** on `nestjs-reviewer`'s re-check #7 at `5194a29`, on reproduced measurements: lint 0 · `tsc` 0 · 2331 unit / 71 · 1177 e2e passed + 2 skipped (20 suites passed + 1 skipped of 21) · fixture diff 0 with control diff 1 · the `Date` lint probe 17 of 17 caught with 6 of 6 legitimate forms clean. **Seven review rounds; the code Phase 6 wrote was not the blocker in any of them.** The blockers were Phase 0/3 shared-helper defects its routes surfaced (B1–B3, D44) and claims in my fix rounds that measurements did not support — the pattern now recorded as §4 rule 15. **Post-approval, the reviewer's three non-blocking sentences are fixed here:** round 7 changed two files, not one; the `Date` grep's other hits were comments only within the rule's scope (`date.util.ts` holds a real `Date.UTC` and is excluded by design); and an unmeasured count of review passes is removed from the lint config. **Open:** C71 and D39 have no owning phase — a decision for the operator; task 2142 must be neutralised before 14 November 2026. **Next: Phase 8 (Files + admin).** |
| 2026-09-12 | v4.14 | 🔴 **Re-check #6: CHANGES REQUESTED on one measurement — rule 15 failing in the commit that introduced rule 15.** Every exit code in the round-6 handoff reproduced. The one claim that did not: the lint config's comment said the negation selector banned *every lexical `Date` except a short allowlist*, and `new Proxy(Date, {})`, `new Box(Date)` and `Date.bind(null)` were lint-clean — the proxied constructor returns **1950**. **Cause:** the allowlist matched `Date` by **parent node**, not by **role** — `:not(NewExpression > Identifier)` exempted constructor *arguments* along with the callee, and `:not(MemberExpression > Identifier)` exempted `bind` / `call` / `apply` / `prototype` along with `now`. **Fix:** match by role (`Identifier.callee`, `Identifier.object`, `Identifier.right`) plus a member allow-list of **`Date.now` only** — the one `Date` member production code uses, measured by repo lint over the AST (the grep's other hits in files the rule covers were all comments; `date.util.ts`, which holds the one real `Date.UTC` call, is excluded from the rule by design). **Probe widened to 17 plants** (the reviewer's three plus `call`, `apply`, `prototype`, `Reflect.construct`): **11 caught / 6 missed before the fix, 17 / 0 after**, the named survivor clean, **6 of 6** legitimate forms clean, repo lint 0, `tsc` 0. The config comment now states that measurement and expects a sixth pass to find more. The e2e figure is restated as measured: 20 suites passed + 1 skipped of 21. Round 7 changes nothing under `src/` or `test/` (`git diff --stat`: `MIGRATION_PLAN.md`, `eslint.config.mjs`), so unit **2331 / 71**, e2e and the fixture diff carry from `3b20428`. |
| 2026-09-12 | v4.13 | 🔴 **Re-check #5: CHANGES REQUESTED — and a ruling on process that this round follows.** The reviewer named the single category behind rounds 2–6: **universal claims drawn from existential evidence**. Its prescription, now §4 **rule 15**: a universal claim names the check that enforces it, or is rewritten as a measurement — and this round moves claims into checks instead of defending them in more prose. **Major 9** — the digit table's ordering was prose in four places and asserted nowhere, while one of its two consumers depends on it: a mis-ordered table widens the class alone. My round-5 write-up called that mutant *unreachable*; it was reachable to the class and green because nothing checked. Closed by `python-str.fixture.spec.ts` (shape of both pinned tables, plus a class-vs-fold sweep over all 1,114,112 code points), controlled by the out-of-order append — 2 of 3 cells fail, named. **Major 10** — a negation selector over every lexical `Date` ⚠️ *(→ refuted by re-check #6: it matched by parent node, not role — see v4.14)*; 10 of 10 plants caught, survivor clean, 6 of 6 legitimate forms clean, repo lint 0; the boundary sentence corrected after its own example turned out to be caught. **Minor 14** — the refuted claim sat at five sites, not four. **Nit 5** closed. Two stale changelog claims (v4.11 *8 of 8*, v4.12 *widening alone → unreachable*) annotated inline. ⚠️ **And I had been claiming the fixture "at baseline" from `fixture-check.sh`'s exit code all phase** — the script only prints; baseline means diffing against a saved run. Done properly: identical to the tester's end-of-Phase-6 capture. ⚠️ **First gate run: e2e and fixture failed on a stopped database** inside a wrapper reporting success; caught from the per-step exit codes. Gate: lint 0 · `tsc` 0 · **2331 / 71** · **1177 passed + 2 skipped; 20 suites passed + 1 skipped of 21** · fixture ✅ **diff-clean against `FINAL2-fondodev.txt`** (the tester's end-of-Phase-6 capture, 2026-09-08), **controlled**: the same probe against `fondo_api_test` differs (`diff` exit 1). |
| 2026-09-08 | v4.12 | 🔴 **Re-check #4: CHANGES REQUESTED — Major 8, and it is the mirror image of every earlier one.** Not a claim recorded without a control: **a working control recorded as inert.** Last round I added the UCD-drift row, measured that it did not discriminate, and demoted it. The mutant I used swaps the digit class for a Unicode-property test — which desynchronises the class from the fold, **a state the code makes impossible**, both deriving from the same `PYTHON_DECIMAL_DIGIT_RANGES` array (0 mismatches over all 1,114,112 code points). The reachable mutations, re-measured by me: **narrowing the class → 5 failures** (the Major 5 accept rows), **the pinned table going stale → 3 failures including that row**, widening alone → unreachable ⚠️ *(→ false: a mis-ordered table widens the class alone — Major 9, v4.13)*. ⚠️ **I had already run the narrowing mutant earlier the same day and recorded its 5 failures**, then drew the opposite conclusion from a different mutant without reconciling them. The comment I shipped told a maintainer the class choice was unobservable — an invitation to delete a working control, or to *simplify* it to the property test **D42** forbids in bold. Three source sites corrected. ⚠️ **And my first attempt to verify the reviewer's claim proved nothing**: the table-drift mutant passed **2328/2328** because I inserted the new range out of ascending order, breaking the invariant the binary search needs. A mutant that cannot be reached is a check that cannot fail, one level up. Re-sorted, it fails 3. **Minor 11** — third pass on the lint rule: **nine more bypass forms, nine clean.** Eight selectors close 8 of 9. ⚠️ **The framing mattered more than the selectors** — *"8 of 8 caught"* reads as class closure and is closure over a plant set. The config now records the real boundary: **AST selectors cannot close value-flow aliasing**, `(Date as any)['U'+'TC']` survives, and the rule raises the cost of the accident rather than making the remap unreachable. **Minor 12** — **D44**, the only live write-path defect of the previous round, had **no route-level cell** while its sibling D43 had two; added, including `POST` with `2020-02-30` → **500, table unchanged**. **Minor 13** — the docblock claimed *the row AND the notification*, the cell asserted only the row — **prose over-claiming inside the commit that fixed prose over-claiming**. **Nit 4** closed. Gate by exit code: lint ✅ · `tsc` ✅ · **2328 unit / 70** · **1177 e2e + 2 skipped / 21** · fixture ✅. |
| 2026-09-08 | v4.11 | 🔴 **Re-check #3: CHANGES REQUESTED — and this one found a live parity defect on a write path, not just a weak control.** **Major 6 / D44** — `power.service.ts` was a **third** hand-rolled port of Django’s date coercion and the only date site in `src/` not routed through `toDjangoDate`. Six measured divergences; **the last three wrote a Power row v1 refuses and sent the notification that follows it** (`2020-02-30` → 2020-03-01, `2020-13-01` → 2021-01-01, `0000-01-01` → year 0), because the old body had **no calendar check at all**. ⚠️ **B1, B2 and Major 5 each walked past it** — never spelled `strptime`, never spelled `Date.UTC`, and my Major 5 write-up asserted *the two hand-rolled ports of one builtin are gone* when there were three. ⚠️ **The only negative cell on that path used a slash-separated date, which both stacks reject — it discriminated against nothing.** Control: old body fails exactly the 6 new cells. **Major 7** — the 11-row matrix named `%d`’s Unicode axis without pinning its **boundary**: the awareness is `[1-2]\d`’s alone, and a counter-mutant taking the natural over-reading passed **all 2319** tests while making a `0`-prefixed Unicode day a 200-with-a-row. Worse, a spec docblock **argued for that wrong side** while four other sites said the opposite — prose the cells could not arbitrate. ⚠️ **And one control I added does not control what I claimed.** Minor 8 asked for a drift guard on the `strptime` path; I added the cell and then tested it — under a Unicode-property class, **and with the `NaN` guard removed too**, it still passes, because the fold leaves an unknown code point alone and both the guard and the caller’s round-trip refuse `NaN`. I concluded the class choice was not observable there. ⚠️ **That conclusion was WRONG and `nestjs-reviewer` disproved it in re-check #4 — see v4.12.** The row **is** a control. **Minor 9** — `setYear`/`getYear` is a **fifth** member of the `MakeFullYear` class and not a spelling of `Date.UTC` at all; with `globalThis.Date` and assignment aliasing, **8 of 8** bypass forms are caught ⚠️ *(→ in that plant set only: re-checks #4 and #5 planted 18 more forms and 17 escaped — see v4.12, v4.13; rule 15)*. **Minor 10**, **Nits 1–3** closed. Gate by exit code: lint ✅ · `tsc` ✅ · **2328 unit / 70** · **1175 e2e + 2 skipped / 21** · fixture ✅. |
| 2026-09-08 | v4.10 | 🔴 **Re-check #2: CHANGES REQUESTED — two new majors, both mine, both the same failure the round before was about: a countermeasure that closes the instance rather than the class.** **Major 5 — I pinned the wrong rule with four cells and a register row, which is worse than the defect it replaced.** I measured one string and generalised. `nestjs-reviewer` dumped `_strptime.TimeRE().pattern('%Y-%m-%d')`: **`strptime` is a per-directive pattern and the directives disagree about Unicode.** `%Y` is `\d\d\d\d`, Unicode-aware, folded by `int()`; `%m` is ASCII in every branch; `%d` is ASCII in its first character but Unicode-aware in `[1-2]\d`'s second, and has a **space-padded ` [1-9]`** branch reachable from any `%e`-style client formatter. The fully-Arabic string fails **because of the month**. **Seven** inputs were v1-accepts / v2-refuses, two on write paths (`PATCH /api/user` writes the profile *and* the birthday chain; loan refinance creates a loan). Closed by `parseStrptimeIsoDate`; **11-row matrix, two disjoint mutants (5 and 2 failures, summing to the 7 accepting cells)**. The generalisation worth keeping: *"does `strptime` accept Unicode digits?" is not a well-formed question.* **Major 4 — my `Date.UTC` lint rule banned one spelling of four.** Five bypass forms planted, **one caught**: `Date['UTC']`, destructuring, aliasing, and **`new Date(y, m, d)`** — the same `MakeFullYear` remap, the *more* idiomatic spelling, plus a local-timezone bug. ⚠️ **My recorded control — "a fresh raw `Date.UTC` reports exactly one error" — proved the rule fires, not that the class is closed.** That is **C67 one level up**: a control that exercises only the case you already thought of. The plant-and-observe method was right; the plant set had one element. Four selectors now, controlled against all five, zero false positives on the single-argument forms. ⚠️ **And my arithmetic was wrong a second time**: I attributed the `\p{Nd}` delta 3 → 4 to Minor 5 *and* a new cell. Minor 5 contributed **0** — under the mutant the first assertion already fails and a cell fails once. **A count needs its mutant named and its delta attributed**, and this is the second row where I recorded a number produced by a mechanism other than the one I named. **Minor 6** generalised correctly: *a cell must be shown to fail against the mutation it claims to catch* — "assert the row" is the tactic, not the property; the one status-only cell now reads the row. **Minor 7** corrected. **Nit 3**: the OID guard pins to a sidecar beside the dump, spanning the clone's life rather than one restore. **D42** and four prose sites corrected to state the per-directive rule. Gate by exit code: lint ✅ · `tsc` ✅ · **2319 unit / 70** · **1175 e2e + 2 skipped / 21** · fixture ✅. |
| 2026-09-08 | v4.9 | 🔴 **Re-check #1: CHANGES REQUESTED again — and the blocker was mine, and it was the lesson I had written down that morning.** **B2 was fixed at four `Date.UTC` sites and live at four more.** Two **reachable**: `parseBirthdate` and `strptimeIsoDate`, each building a `Date.UTC` probe and comparing `getUTCFullYear()` back against the parsed year — which the remap makes fail — so `birthdate: "0050-06-15"` and the loan routes were **v1 200 / v2 500**. Two latent in `relativedelta.util.ts`. ⚠️ **`date.util.ts` asserted *“every `Date.UTC` call in this codebase must go through here”* while four calls sat outside it.** That is **M2 recurring in code**: *"I fixed the sites I found" is not "I fixed the sites that exist."* I corrected that failure in the documentation at 09:00 and reproduced it in the source by 11:00. **The fix is a lint rule, not a sentence** — `no-restricted-syntax` bans `Date.UTC` in `src/` outside `date.util.ts`, controlled by planting one and watching it fail. A prose invariant is a claim nothing checks. ✅ **I corrected the reviewer on Major 2.** It reported all three date parsers as one finding. Measured on the pinned CPython 3.9.25: Django's `date_re` is Unicode-aware and `int()` folds, so `toDjangoDate` **must** accept `٢٠١٨-٠١-٠١`; `strptime` **refuses** the same string, so `parseBirthdate` and `strptimeIsoDate` **must** reject it. Folding all three would have created a divergence rather than closed one. Both directions now pinned. ⚠️ **Two of my own claims were wrong.** My **`\p{Nd}` control count of 9** was unreproducible — my mutant returned `0` for *every* `Nd` including ASCII digits, conflating the fold axis with the digit-set axis, so it controlled neither; the faithful mutant gives **4**, and the row now names it. And **`reset-clone.sh`'s guard could not fire**: `grep -q` emits nothing, so the piped `grep -v` always exited 1 — **a check that cannot fail, shipped as the countermeasure for false-green #23, which is about checks that cannot fail.** Now an `hstore` OID comparison across the restore, which cannot pass by accident. ⚠️ **One more caught by assertion choice:** my first route cells put `birthdate` at the top level where v1 reads `obj['personal']`; the route answered **200 and wrote nothing**. Asserting the **row** rather than the status is the only reason it did not pass for the wrong reason. Also: **D43** re-attributed (`toDjangoDate` is Phase 4 `0a8cf62`, not Phase 0 — traced by `nestjs-reviewer`), **D42** gains a fourth axis, v4.7's clause annotated **inline** rather than rewritten (a changelog records what was believed, and the correction belongs beside the claim), the lint-run count reconciled, the fixture generator's one-directional assert softened, and `daysInMonth(0, 2)` documented as **still 28** so routing is not misread as correctness. Gate by exit code: lint ✅ · `tsc` ✅ · **2309 unit / 70** · **1174 e2e + 2 skipped / 21** · fixture ✅. |
| 2026-09-08 | v4.8 | 🔴 **`nestjs-reviewer`: CHANGES REQUESTED on Phase 6 — and not for anything Phase 6 wrote** (*"the port is faithful and D12 is the strongest new-functionality design this migration has produced"*). Three defects in **Phase 0 shared helpers**, reproducing on this phase's routes, one writing a wrong row silently. **All three fixed, with mutation controls.** ⚠️ **`nestjs-developer` hit the session limit mid-round for the second time**; B1 was substantially written, B2/B3 untouched. I reviewed its work, finished the round myself, and re-measured. **B1** — `pythonInt`/`toDjangoInt` refused Unicode `Nd` digits and PEP 515 underscores (`int('１')` is 1, `int('1_0')` is 10). ⚠️ **My brief said to use `\p{Nd}` and that would have been wrong**: CPython 3.9.25 is on **UCD 13.0.0** (650 code points), Node 24 on **UCD 17.0** (770) — a property test would have **accepted 120 code points v1 refuses**, turning a v1 500 into a v2 success. The developer caught it and captured the table from the pinned interpreter instead. Controlled three ways (no-fold **6** failures, no-underscores **6**, `\p{Nd}` **4** — ⚠️ **I first recorded 9 and it was not reproducible.** `nestjs-reviewer` re-ran it and got 3; the honest number today is **4**, and ⚠️ **my account of how it moved was also wrong.** I said the write-side assertion (Minor 5) and a new `toDjangoDate` drift cell each contributed. Under the mutant `pythonInt` already throws, so the **first** assertion in each drift cell fails and the cell fails once — **Minor 5 contributed 0**; it strengthened cells the mutant already broke. **3 + 1 = 4, and the 1 is the `toDjangoDate` drift cell alone.** Same species as the original error: a count attributed to a mechanism that did not produce it, which is why a count needs its **mutant named and its delta attributed**. **The mutant must be named or the count means nothing**: it is `pythonDecimalDigitValue` falling back to Node's `\p{Nd}` with run-start value derivation on a table miss. My original mutant returned `0` for *every* `Nd` including ASCII digits, which conflates the fold axis with the digit-set axis and is not a control on either, restored clean). ⚠️ Reviewer widened it past the tester's scope: `toDjangoInt` shares the regex, so `PUT {"value": "1_0"}` was a **v1 write of 10** against a v2 500 — every integer *body* field in Phases 3–6, not two query params. **B2** — `Date.UTC` remaps years 0–99 to `1900 + year`, at **four** sites. ⚠️ **The reviewer found a divergence neither the tester nor I did:** `toDjangoDate` never validated the year, so `end_date: "0000-01-01"` was **v1 500 with no row / v2 200 storing 1900-01-01** — a **status** divergence creating a row v1 would never create, on every date-taking write in Phases 3–6. **B3** — ⚠️ **the tester's stated root cause was wrong and the reviewer traced the real one.** Not PostgreSQL's range: `zonedTimeToUtcMillis` remapped the *Bogotá-local* year 99 to 1999, making the offset correction −1900 years and yielding year **−1800**. My controls confirm the trap — mutating either other site fails **1** cell and **never** the `0100-01-01` cell; mutating this one fails **2**, including it. **Fixing the obvious sites alone would have looked green.** ⚠️ **My error, corrected: C68's "both runbook sites corrected" was false — there were three**, and `docs/phase-6-deviations.md` §7.1 had **named the third explicitly**. It is the site an operator has open during a cutover. *"I corrected the sites I found" is not the claim "I corrected the sites that exist."* **D41 registered** — parse-side integer precision (v2 ingests via plain `JSON.parse`; at 2^53+1 it **silently truncates**, at 2^63−1 it **refuses a write v1 performs**). Rule 5b/C2 govern the *render* direction only, which P6-F5 mis-cited for all three. **Observed in Phase 5 as row L2, again as P6-F5, and registered neither time.** **False-green #23** — the tester's `DROP DATABASE` clone reset changed the `hstore` OID, which Django `@lru_cache`s per process, manufacturing a convincing **false FAILURE** ("v1 crashes on CAP create"); the first inverted-polarity instance in the register, and the corrected `scripts/parity/reset-clone.sh` is now **in the repo** rather than only in a report. **C77(iii)**'s falsified sentence moved off the vacuous cell onto the discriminating one, with a do-not-delete note. Gate by exit code: lint ✅ · `tsc` ✅ · **2304 unit / 70** · **1170 e2e + 2 skipped / 21**. ⚠️ **Lint failed on two separate runs and I caught both by exit code** — false-green #21's countermeasure earning its keep. |
| 2026-09-08 | v4.7 | ✅ **PHASE 6 IMPLEMENTED** (`cda69e0`) — the CAP port **and** D12's auto-close, the one piece of genuinely new functionality in the migration. Gate **re-measured by me, not accepted from the report**, each by exit code: lint ✅ · `tsc` ✅ · **2274 unit / 70** · **1160 e2e + 2 skipped / 21**; every figure matched. `fondodev` `SELECT`-only, fixture at baseline, both CAP rows byte-identical to the pre-dump. ⚠️ **Two of my own briefs were falsified by mutation testing, and both would have shipped a cell that proved nothing.** **C77(iii)** — I wrote that the no-clone cell *"is the only one that catches someone later 'fixing' the runner to clone before running"*. It catches **nothing** on a `repeat = 0` task, because `createRepeatInstance` returns early on `SchedulerRepeat.NONE`; measured, a runner mutated to clone before running **passes all 98 e2e cells** and fails 2 unit cells. Only a `repeat = 4` variant discriminates. **C76** — the suggested discriminating cell was passed by a `fromDateColumn → toBogotaDate` mutant, because a MONTHLY hop into February is where `min(28,31)` and `min(28,30)` are both 28. *"The two dates disagree"* is **two** properties, not one, and the **YEARLY read-local** case is the live one: every birthday chain is `repeat = 4`, so read-local would greet members **a day early, every year**. Four cells now, each mutant failing exactly 2 of 50. **New standing rule, in Phase 6's Risks:** a cell pinning a timezone-sensitive computation must be mutation-controlled against *each* wrong implementation separately. **D12's shape decided: one `SchedulerTask` per CAP, at creation, `repeat = 0`** — the daily-sweep alternative rejected on a generalisation of C67 worth keeping: ***a check that drives the work is not a check***, since a broken close returns an empty result and reads as "nothing to do". Accepted consequence, written down rather than left to fall out: a CAP created between the two passes with an `end_date` of today closes at **14:00**, and suppressing that would need the per-type pass scheduling **Q39** forbids. **C68, C69, C70, C73, C75, C76 closed; C77/C78 code obligations discharged.** ⚠️ **The Phase 9 runbook's health check was wrong and is corrected at both sites** ⚠️ *(→ corrected in v4.8: there were **three** sites, not two. Left inline rather than rewritten — a changelog is a record of what was believed at the time, and the correction belongs next to the claim rather than in place of it.)* — `grep -c 'Running scheduler'` is emitted *before* any work, so it returned 2 whether the pass did everything or died immediately; replaced by `Scheduler pass finished` (expect 2) **paired** with `Scheduler pass failed` (expect 0). **D40 registered** — v1's `page <= 0` guard refuses 0 with a message saying 0 is allowed, in **two** ported views since Phase 4, and it had **no register row anywhere** until Phase 6 looked. **P6-F2 is the finding worth reading**: `PUT { state: 7 }` writes a 7 (Django's `save()` never validates `choices`), and that row is then invisible to the list, uncounted in `total_savingaccounts` **and** unclosable by D12 — three ways at once, from one unvalidated write. Ported, not fixed. ⚠️ **The single open CAP (id 3, 900,000, `end_date 2024-02-28`) belongs to user 15 — the same departed member as task 2142.** |
| 2026-09-07 | v4.6 | ✅ **C77, C78 and F-a landed; both open operator questions on D12 answered before Phase 6 starts (Q38, Q39).** ⚠️ **`nestjs-developer` hit the session rate limit after writing every edit but before verifying or committing.** I reviewed the diff myself, confirmed **comment-only** (0 changed non-comment lines in the `.ts`; **control: 716** on `20ac132`), re-ran the gate by exit code — lint ✅ · `tsc` ✅ · **2173 unit / 67 suites** · e2e below — and committed. ⚠️ One near-miss worth recording: the filtered diff (`grep '^+'`) showed *"is a financial-state"* followed by *"not."* and looked like a truncated sentence; **reading the file instead of the filtered view** showed the intervening context lines were unchanged and the prose was whole. Reading a filtered view as if it were the document is the same family as false-greens #19–#21. **C77** is now stated on the `repeat` axis in all four places, with the synthesis the developer found and I did not brief: *money is why D12's one occurrence must not be dropped; `repeat = 0` is why throwing costs nothing else.* **C78** removed derive-on-read from every location and fixed the shape — close is a compare-and-set `UPDATE … SET state = 1 WHERE id = ? AND state = 0`, reconciliation is `state = 0 AND end_date < today`. **The ruling landed in D12's §5 Change column**, not only §3 *Risks*: by the precedence rule a decision that lives only in a Risks bullet is describing, not deciding. **F-a** — the class docblock had claimed `ok: false` is *warned and counted* when C68 means it is *warned only*; corrected, since overstating that channel's safety is the exact direction C74 pushed against. **Q38 — close a CAP already past `end_date` on ship day.** Measured: `fondodev` holds **2 CAPs total**, one already closed and exactly **one** open at `end_date 2024-02-28` (900,000, 2.5 years past); **zero** open CAPs have a future `end_date`. v1 never closed it because **auto-close was never built** — `services/saving_account.py` still carries `# TODO: schedule task for closing CAP`, so D12 is a new build, not a port. C78's reconciliation query doubles as the backfill, so the answer needs no new mechanism. **Q39 — the 10:00 pass only, and it needs no code.** Selection is date-granularity (`(run_date AT TIME ZONE zone)::date <= today`) and the 10:00 pass claims the row, so the 14:00 pass's `processed = false` filter already excludes it; the 14:00 pass re-attempts only after a **throw**, which is the retry path C77 depends on. ⚠️ Recorded as an explicit warning to Phase 6 **not** to build per-type pass scheduling to satisfy an answer the design already satisfies — plus one edge it must decide rather than inherit (a CAP created between passes with an `end_date` of today lands at 14:00, reachable only if D12 writes a task per CAP). |
| 2026-09-07 | v4.5 | ✅ **C74 validated by all three — `manual-tester` PASS on four of four, `nestjs-reviewer` APPROVE, `business-analyst` concerns resolved by operator answers Q35–Q37.** ⚠️ **The tester falsified my own check design.** I told it to verify the comment-only claim by diffing emitted JavaScript. **That check would have been blind**: `scheduler-executer.ts` is interface-only, so its entire `.js` emit is two lines that are identical for *any* edit, real or not. It built a whole-project emit diff over `.js` **and `.d.ts`** instead — the `.d.ts` is the load-bearing artifact — got 0 differing files of 470, and controlled it three ways (an `ok?:` mutant, 26 differing files across `d88e3af`→`20ac132`, and a grep for semantically-meaningful comment directives). It also corrected **two of its own faulty controls** rather than accepting the green. Gate confirmed at `0faccb3`: lint 0, `tsc` 0, **2173 / 67**, **1061 + 2 skipped / 20**, `fondodev` byte-identical to the pre-dump. ⚠️ **I told the operator task 1497's live harm was "nil" because its owner is soft-deleted. That was wrong twice, and the second half was my own C72 fix.** v1 has **no `is_active` filter on the notification path** (controlled grep), and it has **already announced a departed member's birthday** — task 1770, Angi Paola, `processed = true`, owner `is_active = f`. And sparing 1497 does not park it: `create_repeat_instance` anchors the clone to the task's **own** `run_date`, so it catches up one year per pass — **three fund-wide out-of-season pushes**. The parity round missed it because it drained first, then ran one pass. **Operator answers:** **Q35** departed members are no longer announced → **D39** registered, runbook **3a** drains 1497 by id, new **3a-bis** neutralises **task 2142 before 14 Nov 2026** and sweeps `owner_id` for others. **Q36** Ainhoa's missing chain is folded into **C71** rather than fixed by a one-off insert, which would have been a trap — her birthday has passed, so re-saving her profile today fires on the wrong day. **Q37** the 65 `PAID_OUT` reminders are drained without investigation, **recorded as accepted rather than resolved**: if the defect is real it is already ported into v2, and the rows survive in the step-1 dump. **Two new conditions, both raised by `nestjs-developer` and sustained by `nestjs-reviewer`:** **C77** — the throw rule must be stated as a function of `repeat`, not money; Q6's trade only has a numerator when there *is* a chain, and D12's close task must be `repeat = 0`, with three named test cells. **C78** — C74's remedies are not interchangeable; derive-on-read is **off the table** because v2 already ships the `state: 0` aggregate in a **gated Phase 3 path**, it creates two sources of truth in a one-column state model, and it defeats C74's own purpose by making the runner's failure invisible instead of detectable. Closed-ness is materialised in `state`; the reconciliation query doubles as the answer to D12's first open operator question. |
| 2026-09-07 | v4.4 | ✅ **PHASE 7b CLOSED — approved with conditions C68–C76** (`docs/review-phase-7b.md`, now committed; it had been sitting **untracked**, so the source document for nine conditions was not under version control). **C74 was the only condition gating Phase 6's start, and it is closed** (`a191f74`): D12's executer **must `throw`, never return `ok: false`**, and D12 must be **idempotent and independently reconcilable**. The `ok: false` channel was decided by **Q6** for a *lost push* — one missed message beats breaking the `repeat` chain — and that trade does not transfer to money: "task processed, CAP still open, one WARN" is a financial-state divergence no later pass repairs. ⚠️ **Two design points came back from `nestjs-developer` that C74 did not contain, and I verified both.** (a) **"Must throw" is safe only because D12's task is `repeat = 0`** — `scheduler.runner.ts` releases and rethrows *before* `createRepeatInstance`, so a throw skips the clone; a non-zero `repeat` on the close task would silently reintroduce the chain-breaking failure Q6 avoided. (b) **C74's two remedies are not interchangeable, though the review presents them as such** — "derive closed-ness from `end_date` on read" ripples into a **ported Phase 3 response**: `UserFinanceSerializer.get_total_savingaccounts` (`serializers.py:32-35`) sums `SavingAccount` rows at `state=0`, and `state` is `0=ACTIVE / 1=CLOSED` (`models.py:137-140`), so a CAP closed only by derivation keeps counting. The reconciliation query has no such ripple. Both are with `nestjs-reviewer`. **C72's code half closed** (`cfa57ea`) — step 3a carries `AND repeat = 0` plus a post-drain check that confirms *intent* (`chains_left_alive`) rather than statement; **C71 and C72's policy half are with `business-analyst`**. **Board corrections:** Phase 5's row still read "C59, C60, C62, C67 🔴 gate P6's start" after all four had been closed (`19c5d4d`, `b8f73ce`) — a stale row in the block the operator reads, the same family as false-green #21. **C60 was re-verified behaviourally, not by string match** (false-green #20's lesson): `pythonIntStrip` exists and both `python-obj.ts` call sites use it instead of `trim()`. Gate at `a191f74` by **exit code**: lint ✅ · `tsc` ✅ · **2173 unit / 67 suites** · **1061 e2e + 2 skipped / 20 suites** — all at baseline, as a comment-only change must be. That claim was proved with a `ts.createScanner` tokeniser (string and template contents still count as code) and **controlled twice**: 20 code-token differences across `20ac132`, and a targeted `readonly ok?:` mutant on the edited file reported `MUTANT DETECTED`. No database was touched; no runner was run. |
| 2026-09-07 | v4.3 | **Phase 7b parity findings F1, F3 and F5 closed — all three were documentation of fact, no behaviour changed** (`docs/parity-phase-7b.md`, verdict PASS). ⚠️ **F3 is the one worth reading: P7-D3's citation described v1 wrong, in the direction that flattered us.** The register said v1 clones an out-of-range `repeat` onto its own `run_date` *"forever"*. **Re-measured this round** (five v1 passes, `repeat = 7`, isolated `pg_restore` clone): the clone keeps the **same** `run_date`, so the same day's second pass runs it and clones once more — and then v1's **exact calendar-day** filter never selects it again (`0 tasks to process` on D+1 and D+2). **v1 is bounded: two extra rows, one extra push (2 captured messages, one of them the task's own), done.** The unboundedness would be **introduced by D7**: the twin v1 leaves behind is past due, and v2's `<=` returns it on every later pass — measured on the rows v1 had just written (v1's `=` rule: 0 due from D+1; D7's `<=`: 1 due, still 1 a year out) and confirmed by a **real v2 pass** on D+1 loading it. So porting v1's clone into a `<=` runner would be **strictly worse than v1**, which makes P7-D3's refusal *more* necessary than the register argued, not less — and means **the guard cannot be relaxed independently of D7**. Corrected in `docs/phase-7b-deviations.md` §4/§6.2, `scheduler.runner.ts`, `relativedelta.util.ts`, both specs, the e2e spec and the v4.2 row below. **F1** — P7-D4 claimed an absent payload key logs `KeyError: '<key>'` *"exactly as v1 does"*; it does not (`str(KeyError('message'))` is `'message'`, no prefix — verified in-container). **Decision: keep v2's text and register it as `P7-D6`**, because v2's exception is a plain `Error` with nothing else on the line saying what failed, and the helper is shared with a path where v1's `KeyError` is a body-less 500. Rows, wire and retry are identical; the two-line change that would match is written down in P7-D6. **F5** — `scheduler-task.repository.ts` said 109 past-due rows; the predicate returns **110** (109 strictly past + 1 dated today). **Swept every hard-coded count in the phase against the database, not against another document:** 626 / 540 `repeat=0` / 86 `repeat=4` / 86 `birthdate` / 540 `payment_reminder` / 110 due / 108 with a live subscription / 13 distinct `user_ids` lists / 13 target members / 65 `PAID_OUT` / row 2458's payload — **all confirmed**; two stale *present-tense* survivors fixed (§3 Phase 7a and **C24** still said 632 rows / 92 birthdate, pre-dating the Phase 3 fixture incident). Test-count claims re-measured too: 116 / 25 / 25 / 34 / 12 / 5 unit and 29 e2e cells, and C3's "104 cells" is exactly the non-`isSchedulerRepeat` remainder. Gate, by **exit code** (C67): lint ✅ · `tsc --noEmit` ✅ · **2173 unit / 67 suites** · **1061 e2e + 2 skipped / 20 suites** — both at baseline, as expected for a comment-only change. All execution ran on `fondodev_p7b`; `fondodev` was read-only and is at baseline on counts, sequences and `xmin`. |
| 2026-09-07 | v4.2 | ✅ **PHASE 7b IMPLEMENTED** (`feat/phase-7b-scheduler`, off `d88e3af`) — the cron runner, the executer factory and the `repeat` cloning; **no route**. **D7 implemented**; five discoveries **P7-D1**–**P7-D5** registered in `docs/phase-7b-deviations.md` (**P7-D6** added later by the parity round — see v4.3). **The multi-instance question is decided: `@nestjs/schedule` + a `SCHEDULER_ENABLED` role flag + an atomic `claim()`**, not BullMQ — v1's guarantee was *topology* (beat is a separate container), BullMQ would keep the Redis this phase retires and add a second source of truth beside `fondo_api_schedulertask`, and the residual is handled in the data. **The silent-failure question is decided deliberately, both ways:** the *outcome* is ported (a swallowed publish still marks the row processed and still clones — Q6, and the alternative retries a config error twice a day forever while breaking the `repeat` chain) and the *silence* is dropped (a WARN naming the task, `NotificationService.sendNotification` returning `'published' \| 'no-subscriptions' \| 'failed'` instead of `void`). ⚠️ **One finding gates the phase: P7-D1.** D7's `<=` cannot distinguish "has passed" from "was never picked up because v1 could not", and `fondodev` holds **110** rows due on the first enabled run, oldest **2020-09-27**, **65** of them for loans already `PAID_OUT` — ~108 stale pushes. A **drain step in Phase 9's runbook** is recommended; escalated to `business-analyst`. ⚠️ **P7-D3:** `create_repeat_instance`'s four `if`s are not `elif`s and have no `else`, so an out-of-range `repeat` clones the task **onto its own date** — v2 refuses. *(Corrected 2026-09-07, parity F3: v1's version is **bounded** — the twin runs on the same day's second pass and is then past v1's exact-day filter for good. It is **D7's `<=`** that would make such a twin due on every pass forever, so porting v1 here would have been strictly worse than v1. See `docs/phase-7b-deviations.md` §4 P7-D3.)* **Zero inherited tests** (v1 has none for `fondo_api/scheduler/`); 80 new cells in three new specs plus 29 in three existing ones, **nine deviations control-run**, one control caught reporting `Tests: 0 total` and rewritten. Gate: lint ✅ · tsc ✅ · **2173 unit / 67 suites** · **1061 e2e + 2 skipped / 20 suites** · `fondodev` at baseline on counts, sequences **and** `xmin`, before and after; pre-write `pg_dump` of every table at `~/.fondo-parity-dumps/20260907T055041-phase-7b-start/`. |
| 2026-09-03 | v2.6 | **Round 2's F6 and F8 fixed; both were bigger than filed, and both were implemented rather than registered.** **F6** — `APIView.initial()` negotiates a renderer *before* `perform_authentication`, so an unacceptable `Accept` is a **406 before the guards, the handler and any write**: `DELETE /api/user/<id>` under `Accept: application/xml` was **v1 refusing and v2 soft-deleting the row** (measured, restored). `DefaultContentNegotiation.select_renderer` ported into a middleware between the URL resolver and the body parser. A second failure mode the round-2 report did not reach: `?format=` naming no renderer's `format` is `Http404` — `GET /api/user?format=xml` is a **404 before authentication** in v1 and was a 200 in v2. **P3-D8 rewritten** to claim only the rendering (browsable HTML, `?format=api`, `text/*`, and a newly measured `Accept: application/json;indent=8` → 152 bytes vs 79). **F8** — the three rows had one cause: v2 parsed multipart with **busboy**, a strict parser, and v1 uses **Django's**, which raises in three places and salvages the rest. `MultiPartParser`/`BoundaryIter`/`parse_boundary_stream`/`cgi.valid_boundary`/`parse_header` ported; multer out of the request path. 16/16 cells identical, four of them the report never reached. The report's model of the missing-`boundary` case was wrong: `None.decode()` is an **AttributeError**, which `Request.data`'s property/`__getattr__` re-entry **swallows**, so the view sees an empty `QueryDict` — hence a serializer 400 on `/api-token-auth` and a `KeyError` 500 on `PATCH /api/user`. Also closed in the fail-closed direction: `RequestDataTooBig` / `TooManyFieldsSent`, which v2 was accepting. **R2.11.5** cell added with positive controls. Gate: lint + typecheck clean, **1602 unit / 53 suites**, **699 e2e + 1 skipped / 15 suites**. Live re-verification: 125 negotiation cells + 16 multipart cells + a 23-cell regression sweep, **status distributions identical on both stacks**; the only diffs are the registered Django HTML 404/500 pages. `pg_dump` of **every table** taken before the first write and diffed after: all 20 tables **byte-identical** — `schedulertask` 626, `notificationsubscriptions` 94/1468, `auth_user` 15 (1 active ADMIN, 2 inactive), `power` 20, `loan` 425. |
| 2026-09-06 | v4.1 | ✅ **PHASE 5 CLOSED — Approved with conditions C59–C67.** The reviewer re-measured the gate to the same numbers and ran **four independent verifications instead of reading the reports** — three measured clean and were recorded as such (the `//`-target divergence does not exist; gunicorn 19.9.0's dot-prefix workaround preserves both slashes, read out of the running container). The fourth found that **`parse_request_line` does not stop at the port**: `GET http://[/api/activity/year` is v1 **400** / v2 **404 via Express's `finalhandler`**, so O1's shape fires on a plain `GET`, not only authority-form targets — a request reaching a response without passing the URL resolver at all. **N1's model confirmed sound**, `WeakSet` guard and `restoreCatchAllRoutes` included. ⚠️ **`python-str.ts`'s declared limits are incomplete** — verified independently: `0.00001` → v1 `1e-05` / v2 `0.00001`; `1e16` → v1 `1e+16` / v2 `10000000000000000`. Neither is an integral float, so limit 1 is false as written; it is a CPython/JS exponentiation-threshold mismatch the 41-row fixture cannot sample. **`pythonInt`/`toDjangoInt` still use JS `trim()`** — the exact class `pythonStrip` was built to close, in the same directory. **Phase 4's ledger audited: of eleven conditions, one is half-closed and that as a side effect of D29** — C48's two-gate warning reached, now **C59**. |
| 2026-09-06 | v4.0 | **Phase 5 delta round 3: everything briefed verified FIXED** — DELTA-F1 (21/21, discriminator holds), **N1 confirmed at the boundaries** the developer derived (73 raw request lines; 2-char → 400, 3-char → 403, **21/24/40/200-char methods all pass** the prefix match, `GETx` → 403 while `get` → 400; `FROB` byte-identical to `PUT` on 27/27), D36 64/64, D37 as registered with **no id collision**, D38's four v1 outcomes including the corrected `KeyError` sub-case. The tester **under-counted the developer's claim in v2's favour**: its 73 lines found 4 diffs where the developer's 31 found 1, the extra 3 being pre-existing edge items. ⚠️ **One failure, `DELTA3-F1`, pre-existing and proven so against a `d7b95f8` build**: `normalizeEmail` omitted Django's `.strip()`, so v2 **stored and mailed `"  a@b.com  "`** — it escaped the database. Fixed conditionally, because Django strips only when an `@` is present and `str.strip()` is **not** `trim()` (CPython takes U+001C–U+001F and U+0085; JS takes U+FEFF). Spec generated from 16 container-measured inputs; controls: no-strip fails 8/18, naive `trim()` fails 5/18. ⚠️ **False-green #22, mine** — I certified the fixture at baseline on row counts alone; sequences and `xmin` were off from the rate-limited attempt. Gate: **2047 unit / 63**, **1031 e2e + 1 skipped / 18**. |
| 2026-09-06 | v3.9 | **N1 fixed at the HTTP edge; P5-F2 decided as D37; D36 registered; two tester corrections taken.** **N1** — `llhttp` accepts a fixed method table and rejects everything else before Express, so `FROB` was a bare 400 and **`CONNECT` got no response at all, on every route**. gunicorn has no such table: it validates the request *line* and Django's permission map decides, which is why v1 answers 401/403/404. `gunicorn-request-line.ts` ports `METH_RE`, the three-bit split, `VERSION_RE` and `util.write_error`; `gunicorn-http-edge.ts` recovers the request from `err.rawPacket` (across TCP segments) and from the `connect` event and feeds it to the same Express instance. ⚠️ It also had to undo an Express quirk: `app.all` registers one layer **per known verb** rather than setting `Router#all`'s `_all`, so `@All()` — the fallback that makes `PUT`/`OPTIONS` a 403 — stopped at the edge of `http.METHODS`. Measured against the running v1 on a raw socket, 31 request lines: **30 identical, 1 differing and that one is D13**; status distributions equal at `{401: 22, 404: 1, 400: 8}`. Controls: **28 of 112** cells fail with the provider removed, **14 of 112** with only the route fix removed — two distinct sets, both compiling and linting clean. **D37** registers P5-F2 as *accepted, not matched*: matching means issuing raw-SQL INSERTs known to fail purely to burn `nextval`, and the cutover is a hard switch. **D36** registers the activity roster exposure as ported-and-accepted (operator Q32); **Q33**'s consequence — `EXEMPTED` unused in 8 years, so an excused member reads as owing money — goes to the Phase 9 backlog, not into a parity phase. **D38's entry gained its missing sub-case** (no `password` key is a v1 **500**, not a 200) and `createBirthdateNotification`'s `?? 'None'` is now documented as unreachable. Three documents corrected from 15 `ActivityUser` rows to **13**. Gate: **2029 unit / 62**, **1031 e2e + 1 skipped / 18**, `fondodev` at baseline. ⚠️ **`npm run lint` was NOT clean at the briefed head `a7c76a7`** — one prettier error in `test/user.e2e-spec.ts:2342`, from the DELTA-F1 commit, while the status board said lint ✅. Fixed here; the board's gate line was measured, not re-run. |
| 2026-09-06 | v3.8 | **Phase 5 delta round 2: P5-F1 fixed, D35 and D38 confirmed, one new failure — `DELTA-F1`, mine.** `normalize_email` is `email or ''` then `.strip()` — **three** branches, and my D35 fix collapsed two of them by coercing before inspecting. `POST /api/user` with `email: ["a"]` was **201 + an account named `"['a']"` + an activation email** where v1 is a 500 that writes nothing. Fixed by reading the raw value first; **7-cell control** against the unfixed code, plus three *string* cells that must still create, so the fix cannot be "refuse everything". Two casts audited away in the same pass. **D38 confirmed live**: v1 takes over the ADMIN **and resurrects a soft-deleted account**; v2 refuses; all 15 hashes restored byte-identical. **P5-F1's three documented limits probed and behave as documented**, with two the docblock understates — `-0.0` loses its sign and 2⁵³+1 is **value-corrupted**, not merely re-rendered. The tester also found **two defects in its own harness**, one of which reported 7/7 false-red on `created_at` alone. Gate: **1977 unit / 60**, **1000 e2e + 1 skipped / 18**. |
| 2026-09-06 | v3.7 | 🔴 **D38 — an unauthenticated account takeover found in live v1**, and fixed in v2 (`1c90753`). `activate_user`'s guard tests `obj['key'] == ''`, and `None == ''` is `False` in CPython, so a JSON `null` reaches a lookup that compiles to `key_activation IS NULL` — **15 of 15 members match**, including the ADMIN and the 2 soft-deleted accounts the same request would resurrect. `UserActivateView` is `permission_classes = []`, so **no authentication is needed**, and `identification` is fund-open. ⚠️ **The operator has accepted the v1 exposure until cutover** — a data-only mitigation needing no code change was offered and declined; the risk record above the false-green register states what would re-open the decision. **D35 fixed** in the same commit: `toDjangoText` was rendering error-message type names on the storage path and folding `null` to the four characters `'None'`. It split into three behaviours that had to be worked per call site — Python truthiness on the **raw** email (`0`/`false`/`[]` are the 500 path), an explicit `NOT NULL` reproduction because **Prisma validates required fields client-side** so the database never sees the null, and one field (`email`) answering **500 on create but 409 on update** depending on which Django API it passes through. Gate: **1977 unit / 60**, **990 e2e + 1 skipped / 18**. |
| 2026-09-04 | v3.6 | ✅ **PHASE 4 CLOSED — Approved with conditions, both rounds.** Sign-off was **stale** — `manual-tester` PASSed at `6b32687` and the reviewer approved at `6fdbc3a`, then **613 lines landed to satisfy those very conditions**. The operator was told and chose to close the gap before closing the phase, so a **targeted delta round** ran over the four changed behaviours: **delta parity PASS** (`17114a0`), **delta review approved** (C50–C58). It was the right call — the delta review found **C50, a regression the delta itself introduced**: M3's compare-and-set made a `count === 0` throw out of the 120 s transaction and **roll back the entire monthly upload**, a failure mode v1 cannot have, while a spec comment and §5.1 both claimed the loan was merely "skipped". Fixed at `806ca6e` by narrowing the catch to D9's 409 — and the developer found my brief was **too narrow**: the concurrent change is visible at **two** points, `assertLegalLoanTransition` as well as the CAS, and the earlier one is the *more likely* interleaving. **D29's v1 side is now measured end-to-end** (quota 500 / `value 500.5` → 406/406, byte-identical), closing the one inference left in the phase. Final gate: **1866 unit / 58**, **827 e2e + 1 skipped / 16**, fixture byte-identical to the reference dump on 24/24 tables. **C50/C51 closed; C52–C58 roll to Phase 5's gate, and C58 is a hard stop** — C31–C35, C37, C39 close or are formally struck before that gate. A third roll is not available. |
| 2026-09-04 | v3.5 | ✅ **Delta review's C50 and C51 closed — the two conditions gating Phase 5's start** (`docs/review-phase-4-delta.md`, Approved with conditions C50–C58). **C50 was a real regression M3 introduced and the code asserted the opposite of:** `bulkUpdateLoans`' auto-close called `updateLoanIn` with no `try`/`catch` inside the 120 s `$transaction`, so a concurrent `PATCH /api/loan/<id>` committing between `getLoans(state=1)` and the auto-close write made the compare-and-set miss and threw D9's 409 **out of the transaction callback, rolling back the entire monthly upload** — 374 `LoanDetail` upserts and every other auto-close — with a 409 naming neither the file nor the loan. v1 cannot fail here at all (`update_loan(id, 3)` writes unconditionally), so it was **v2-only**. Now caught **narrowly** (only D9's 409; a 404 or anything else still aborts), logged at `warn`, the loan **skipped** and omitted from `closed_loans` — mirroring v1's `except LoanDetail.DoesNotExist: continue` in the same method's first loop. Control-run: the new cell **fails against `17114a0`** with the 409 escaping at `loan.service.ts:843`. **C51**: the CAS's 409 is the sequential answer for five of the six race pairs D9 permits and **not** for winner `0→1` / loser `0→2` (from state `1`, `1→2` is legal, so sequentially the denier gets a 200 plus the denial mail and the `refinanced_loan` unlink). Docblock corrected, registered on D9's row and in §4.1/§5.1 of `docs/phase-4-deviations.md`, and **pinned by a unit cell** rather than fixed — the bounded re-read-and-retry changes behaviour on the money path and needs its own review cycle. ⚠️ Two false claims removed: `loan.service.spec.ts`'s "skipped with a 409" (it aborted) and §5.1's graceful-degradation reading. **C52–C58 remain, tracked to Phase 5's gate.** |
| 2026-09-04 | v3.4 | ✅ **Phase 4 conditions closed: C40, C41, C43, M3, and operator decisions D29/D30.** D29 takes **exact parity** on the quota boundary (`pythonGreaterThan`; the divergent window was `available_quota < value < available_quota + 1`, where `toDjangoInt` **truncates** — v2 was writing a *different value*, measured at quota 500 / `value 500.5` → v2 `201` writing `500` before the fix, `406` and zero rows after). D30 floors `value` at **1** (operator: the fund has no minimum). **M3's lost-update race** closed with a compare-and-set answering D9's own 409 — **designed out, not reproduced**, and §5.1 says so plainly so nobody reads the green suite as proof. **C40** gives every §3 phase block a mechanical "§5 rows this phase owns" line — the reviewer's point that *every convention this project carried had a carrier, every one that slipped was a paragraph*. ⚠️ **False-green #19, mine**: `161d780`'s message claimed a round its tree did not contain, because my verifying grep was line-wrapped and I read absence as proof. ⚠️ **D30 binds the refinance path** — a zero-capital projection is now a 400 where v1 books a zero-value loan; a consequence nobody decided, flagged to the reviewer. |
| 2026-09-04 | v3.3 | ✅ **PHASE 4 PARITY: PASS** (~1 580 cells, 15 matrices). 38 loans matched field-for-field; **approval email HTML byte-identical 38/38** (`sha256 994400c9…` both stacks); 23 TSV files with 0 DB and 0 auto-close-set differences; 420/420 projection cells; 425/425 loan reads. Fixture restored **byte-identical to the pre-write dump**, all 24 tables. **P4-F1 registered as D29** (a JSON-string `value` is a v1 500 and a v2 201 — keep v2's coercion; v1's refusal is a crash, not a rule) and **D30 opened** (neither stack bounds `value` below; floor pending an operator answer on a minimum loan amount). ⚠️ **False-green #18, mine, found by the BA**: the §3/§5 precedence note was verified and committed **on the wrong branch** and was absent from `feat/phase-4-loans` while two docs claimed it was present — now cherry-picked as `38bc9ba`. Also corrected three stale D4 claims I left behind in `docs/phase-4-deviations.md`, one of which told the tester to file **correct** D4 behaviour as a parity failure; I missed them by truncating my own sweep with `head -6`. The tester found its **SES/SQS stubs were never running** — instance #9 recurring, caught only by its positive control. |
| 2026-09-03 | v3.2 | ✅ **C28, C29, C30, C36 and C38's BA half CLOSED. Phase 4 is unblocked and starts now.** C28/C36 landed in `cec6c61`, gate verified independently: **1628 unit / 55 suites**, **699 e2e + 1 skipped / 15**, fixture at baseline. **The C28 control was re-run by me against the reverted line and is discriminating** (expected 2025, got 2026). ⚠️ **False-green #17, found by the developer and worth more than the condition it came from: `process.env.TZ` set *inside* a jest test is a silent no-op** — V8's cached zone does not see it — so on this `-05:00` host the C28 test passed against the buggy line. The pin now lives in `jest.config.ts` + `test/global-setup.ts`, before the workers fork. **Operator answered Q29a / Q30a / Q31**: **D25** and **D26** proceed as decided, **D27** was never conditional, **D28 is WITHDRAWN** — a TREASURER approving their own loan is accepted fund practice, so blocking the smaller self-write would be incoherent. **m6 accepted as-is.** ⚠️ **My brief to the developer carried stale baselines** (1476/48, 617/13, from v2.2); it checked disk and used v2.6's real 1602/53 instead of matching my number. |
| 2026-09-03 | v3.1 | ✅ **PHASE 3 CLOSED — Approved with conditions. Phase 4 may start.** D1 verified closed *properly*: no member-reachable path to `role`, `identification`, or another member's `finance`. **12 conditions C28–C39**; **C28** (timezone) and **C36** (hoist the shared helpers) gate Phase 4's first controller. **M5 is the finding of the phase** — D15 and P3-D2 are each correct and together create a new class of **unresettable account**, invisible to parity because v1 cannot reach the state. **M4 was my error**: v3.0 claimed two registration rows corrected; only D22 landed. D21 now fixed **and verified on disk**. |
| 2026-09-03 | v3.0 | ✅ **PHASE 3 PARITY: PASS (round 4).** D19/D20 confirmed on the two live inactive members; D21–D24 registered. **Two registration rows corrected** — a registration that misdescribes behaviour silences a real future signal. False-green register → **fifteen**: instance #11 was wider than filed (**9 of 17 probe scripts were mode 644**, and `d1.py`'s positive control was **unsatisfiable**, printing FAILED on every correct run — a control that always fails silences exactly like one that always passes), and **three rounds reported "byte-identical" while two sequences drifted 27 → 36 → 45**. To `nestjs-reviewer`. |
| 2026-09-03 | v2.9 | **business-analyst: Aligned — register F9–F12 as D21–D24, fix none. Phase 3 does not gate on them.** New **rule 12c**: files come from `request.files`, scalars from `request.body`, **never merged** — v1's `LoanView.patch` (P4) and `FileView.post` (P8) read `obj['file']` and only work *because* of DRF's merge, which is also the exact mechanism of D23. D22/D23 are **pre-declared for Phases 4–8** so they cannot be re-filed there. D19/D20 fold into a round-4 confirmation pass (4 cells); **D11 verification moves to Phase 9**. |
| 2026-09-03 | v2.8 | **Phase 3 round 3: F1–F8 and R2.11.5 all closed and re-verified**, nothing regressed under the new middleware or the replaced parser — 2,400+ live cells, all 24 tables byte-identical at close. Four new findings **F9–F12, all pre-existing and low severity**, routed to `business-analyst` as likely registrations; **F10 and F12 will recur on every multipart endpoint in Phases 4–8**. False-green register now **twelve**; **#9 was mine** — the v2 I handed the tester pointed SQS at real AWS with no `HOST_URL_APP`, a false-*pass* generator. |
| 2026-09-03 | v2.7 | **F6 and F8 implemented, not registered.** F6's write risk confirmed as a **literal mutation** (`DELETE /api/user/13` + `Accept: application/xml` → v1 406 unchanged, v2 200 **and the row soft-deleted**), then restored. F6 had a **second failure mode nobody had reported**: `?format=` naming an undeclared format is a **404 before authentication**. F8's three rows had **one** cause — busboy vs Django's parser are not two implementations of one contract — and the honest count was **nine**. Two false-green instances added (#7, #8); **#8 was mine**. |
| 2026-09-03 | v2.5 | **Phase 3 parity round 2: F1–F5 all fixed, nothing regressed** — 280/280 F3 cells, both metadata documents byte-identical, F5's four discriminating cells correct. Still **FAIL** on two *pre-existing* findings: **F6** (v1 returns **406 before authentication and before the handler** for an unacceptable `Accept`; v2 ignores `Accept` and executes — on a write endpoint that is v1 refusing and v2 **mutating**) and **F8** (malformed multipart crosses the 400/500 line both ways). The green-test sweep found **five** false-green instances, three in the tester's own harness. §7 dump rule amended: **persistent storage, and restore from the dump**. |
| 2026-09-02 | v2.4 | **Phase 3 parity failures F1–F5 fixed; back to `manual-tester`.** All five were at the HTTP edge, as filed; nothing in the users, finance, powers, scheduler-write or mail core was touched. **F3** (medium, security) — the four password-reset routes are `django.contrib.auth` views with **no DRF layer**, so nothing authenticates them; `@Public()` was the wrong analogue (it models `permission_classes = []`, which leaves DRF's authenticators running). New `@DjangoView()`, honoured by both guards **only when the resolved URL-table entry agrees** (`view !== null && drf === null`), so every disagreement leaves authentication running. **F5** (medium, security) — Django reads `csrfmiddlewaretoken` from the body for `POST` alone; v2 read it on every unsafe method, which let a body-borne token run `PasswordResetView.post` on a `PUT`. ⚠️ **An existing green e2e cell was asserting that bug**, not v1. **F1** — the 500-header strip now asks *who built the response* (`convert_exception_to_response` vs `finalize_response`) rather than what the status is; `UserAppsView`'s caught 500 keeps `Allow` and `Vary: Accept`. **P3-D6**'s claim corrected and its scope narrowed to the uncaught 500. **F2** — `HttpResponseRedirect` carries Django's default `Content-Type`; not D13's shape. **F4** — DRF's `OPTIONS` metadata document **implemented**, not registered (two constants, 164 and 172 bytes, captured from live v1): **P1-D2 withdrawn**, and its real residual — v1 renders *every* DRF response as browsable-API HTML under `Accept: text/html` — registered as **P3-D8**. Rule 12 clause 3 rewritten. Gate: lint + typecheck clean, **1503 unit / 49 suites**, **647 e2e + 1 skipped / 13 suites**; every fix re-verified against the live v1 (`:8451`, production settings). `fondo_api_schedulertask` **626, unchanged**; `pg_dump` of it and of the seven other in-scope tables taken before the first probe, per the new §7 rule. |
| 2026-09-02 | v2.3 | **Phase 3 parity: FAIL** — five unregistered diffs, all at the HTTP edge; the substance is exact (72-cell D1 matrix, byte-identical reset pages, `SchedulerTask` payload, SES/SQS payloads, four-table rollback). **F3 and F5 are security-relevant.** ⚠️ **Fixture incident: six historical `fondo_api_schedulertask` rows for owner 13 were deleted by a probe and are unrecoverable** — the table is 626, not 632. New §7 rule: **snapshot every table a phase writes, before the first write cell.** |
| 2026-09-02 | v2.2 | ✅ **PHASE 3 IMPLEMENTED** (`feat/phase-3-users`) — users, finance, powers of attorney, password reset, plus **Phase 7a** (the `SchedulerTask` write half, pulled forward because Phase 3 and Phase 4 both write rows). **C22–C25 closed.** Ten §5 deviations implemented (**D1, D2, D5, D11, D14–D17, D19, D20**); seven new ones registered (**P3-D1–P3-D7**) in `docs/phase-3-deviations.md`. **The session question is decided: keep the redirect hop, drop the store** — the token rides an `HttpOnly` cookie and is re-validated by `check_token`, exactly as Django re-validates its session copy (P3-D3). ⚠️ **Five behaviours corrected against the live v1, one a real defect: `@parser_classes` on an `APIView` *method* is a no-op**, so `PATCH /api/user` with JSON is a 500 and not a 415 — and the same decorator is misused in `LoanView.patch` and `FileView.post`, so Phases 4 and 8 inherit the correction. Gate: lint + typecheck clean, **1476 unit / 48 suites**, **617 e2e + 1 skipped / 13 suites**. `fondodev` unchanged (94 / 1468 / 1). |
| 2026-09-02 | v2.1 | ✅ **C19, C20 and C21 closed** (`03758dc`, `7415876`, `a39049c`) — the three prerequisites for Phase 3's first controller. `ALLOWED_HOSTS` ported from the installed Django 2.2.27 and re-measured against four live-v1 configurations; `RolesGuard` bound to the view the URL table resolved, with a hard failure on disagreement; the response phase ordered by v1 `MIDDLEWARE` depth, with `skipBeforeHeadersHooks` scoped to "below me". Both `Vary` orders (`Cookie, Origin` on `/password_reset/`, `Origin, Cookie` on `/reset/<uid>/set-password/`) re-measured on live v1 and now fall out of depth alone. Consider **C5** taken with C20. Gate: 1298 unit / 38 suites, 480 e2e + 1 skipped, lint and typecheck clean. **Phase 3 is now gated on Q26/Q27 alone.** |
| 2026-09-02 | v2.1 | **C19–C21 closed** (`03758dc`, `7415876`, `9846130`) — `ALLOWED_HOSTS` ported, the guard now authorises on the resolved **v1 view** rather than Express order, and the response phase runs by **middleware depth**. **Q26 and Q27 answered → D16 and D17 decided.** **Phase 3 unblocked and started.** Two corrections of mine: the fixture content-hash was unreproducible without its query (now recorded), and C19–C21 are numbered differently in the review doc than in this plan. |
| 2026-09-02 | v2.0 | ✅ **PHASE 2 CLOSED — Approved with conditions.** Reviewer re-derived claims inside the v1 image rather than re-running suites. Nine should-fix findings → **C19–C27**, graded by deadline. Three change Phase 3's shape: **S3 is a real vulnerability** (`ALLOWED_HOSTS` dropped; Phase 3's `PasswordResetView` builds the emailed link from the request host → reset-link poisoning), **S2** (the table resolves paths not views, so `/api/user/<x>` overlaps could evaluate under the wrong view's rules), **S1** (response hooks run FIFO — the reverse of Django — and the model has no notion of depth). |
| 2026-08-31 | v1.8 | **C18/N4 closed**; Phase 2 to `nestjs-reviewer`. Two method corrections that outlive this phase: **supertest silently strips fragments**, so a supertest regression cell passes against the broken code — raw-socket helper now in `test/http-edge.e2e-spec.ts`; and **`pg_dump` md5 is not a valid fixture guard** (`synchronize_seqscans = on` rotates rows — three dumps of unmodified data gave three md5s, verified). Use the sorted content hash + `count(distinct xmin::text)` instead. |
| 2026-08-31 | v1.7 | ✅ **Phase 2 parity: PASS (round 3).** N1–N3 fixed and verified; nothing regressed across 152 sweep requests, 6 `cmp`-identical SQS bodies, the 94-row decode scan and the full role matrix. One new non-gating diff **N4** (gunicorn drops a literal `#` fragment; v2 keeps it) → C18. Two corrections folded in: **`Vary: Cookie` affects three kept routes, not one**, and `GET /reset/<uid>/<token>/` **writes a `django_session` row** — a DB side effect on a GET that v2 has no model for. Both are Phase 3 scope. |
| 2026-08-31 | v1.6 | **Phase 2 parity round-2 diffs fixed; back to `manual-tester` for round 3.** **C15/N1 closed by a split, not a swap** — v1's `APPEND_SLASH` 301 is *above* `corsheaders` and its URL-resolution 404 is *below* it, so `DjangoAppendSlashMiddleware` + `DjangoUrlResolverMiddleware` now sit either side of `DjangoCorsMiddleware`; `AppModule.configure` carries v1's whole eight-row `MIDDLEWARE` list. **C16/N2 closed** — `escape_uri_path`/`iri_to_uri`/`escape_leading_slashes` ported (`django-uri-encoding.ts`), so the 301 `Location` is the decoded-then-re-encoded path. **C17/N3 closed now rather than at the P3 gate** — the resolver re-targets Nest's router at `PATH_INFO`, which needed the middleware mount moved from `{*path}` to `/`. Rule 14 gains both sub-rules. **O1 registered** (P2-D8 residual 4) plus a new residual 5 (a non-ASCII raw request target: Node answers 400 before any middleware, gunicorn/Django serves it). ⚠️ **Phase 3 note:** `GET /password_reset/` answers `Vary: Cookie, Origin` and sets a `csrftoken` cookie — a **kept** route, so `DrfViewHeaders` must widen when the auth pages land. |
| 2026-08-31 | v1.5 | **Phase 2 parity round 2: FAIL, narrower.** F1–F5 all fixed and **nothing in the substance regressed** — 22/22 URL patterns agree both slashed and unslashed, 5 SQS bodies `cmp`-identical incl. the 35 KB / 94-row one, fixture restored byte-for-byte. But the fix round introduced **N1** (middleware order: v1 runs `CommonMiddleware` before `CorsMiddleware`, so a preflight on an `APPEND_SLASH` path is a **301** in v1 and **200** in v2) and **N2** (`Location` must be `escape_uri_path(decoded)`, not the raw target). **N3** and **O1** are pre-existing, newly found. Back to `nestjs-developer`. |
| 2026-08-31 | v1.4 | **Phase 2 parity failures fixed; back to `manual-tester`.** All five findings addressed at the HTTP edge, nothing in the mail/hstore/SQS core touched. **C14 closed** — `app.enableCors()` removed and `corsheaders 2.4.0` ported, so a bare `OPTIONS` is authenticated again (it was a 204 for anyone). **C9 closed in full, now rather than in Phase 3** — v1's 22 `url()` patterns are transcribed in `django-url-conf.ts` and resolved **before the guards**, which closes S7, P2-D5 and F2 together and is **fail-closed**: a path v1 does not serve cannot reach a v2 controller. F3 (`QueryDict` last-value) fixed; most of F4 matched, the rest registered as **P2-D8**. **P2-D4 withdrawn — its premise was false**: `remove_all_subscriptions` is live in v1 and **Phase 3 must wire it**. **P2-D5 withdrawn** (fixed, not deviated). P1-D2's v2 column corrected. Two new cross-cutting rules: **14** (the URL conf) and a third clause on rule 12 (`OPTIONS` is a real, guarded method). |
| 2026-08-31 | v1.3 | **Phase 2 parity: FAIL** (`docs/parity-phase-2.md`). The *substance* is exact — every SES payload, SQS body, hstore row and the full role matrix are byte-identical, including a 35 KB body carrying all 94 live rows. All five failures are at the **HTTP edge**, three unregistered. Returned to `nestjs-developer` per the standing pipeline. **F2 folds into C9**; **F1** is new and severe. P1-D2's v2 column corrected. **P2-D4's premise is false** — `remove_all_subscriptions` is live, which changes Phase 3. |
| 2026-08-31 | v1.2 | **Phase 2 implemented** (`feat/phase-2-notifications`): SES mail + the six Spanish templates, the hstore `NotificationSubscriptionRepository`, SQS publishing with bounded retry, and `POST /api/notification/<subscribe|unsubscribe>`. **C10–C13 closed** (C11 with one registered residual); C9 still open. Deviations P2-D1–P2-D7 registered in `docs/phase-2-deviations.md`. ⚠️ Three findings for this plan: `json.dumps` ≠ `JSON.stringify` (separators + `ensure_ascii`) is a byte-parity rule that belongs in §4 alongside 5b/5c; adding `ORDER BY id` to the subscription read would **break** parity (heap order is the wire order, verified live); and `{% host %}` has **zero** call sites in v1's templates. |
| 2026-08-31 | v1.2 | **Phase 2 implemented** (`c72cc7c`); C10–C13 closed alongside. New cross-cutting **rule 5d**: CPython `json.dumps` ≠ `JSON.stringify` (separators + `ensure_ascii`) — this diverges on *every* notification, since all v1 bodies are accented Spanish, and Phase 7 publishes through the same path. Subscription queries must emit **no `ORDER BY`** (verified: heap order ≠ id order on `fondodev`). Handed to `manual-tester`. |
| 2026-08-31 | v1.1 | **Full pipeline standing from Phase 2 to the end**: `nestjs-developer` → `manual-tester` (sign-off) → `nestjs-reviewer` (sign-off), sequential. **Phase 2 started.** |
| 2026-08-31 | v1.0 | ✅ **Phase 0 APPROVED. Phase 1 APPROVED.** Round-2 review closed C1–C8. **C9 re-ruled: fix, do not accept** — v1 has no trailing-slash *rule*, only an inconsistent table, so a blanket rule would 404 routes v1 serves. C10–C13 added (Phase 3 gate). D19/D20 register two live v1 defects; one Phase 7 timezone consequence recorded. |
| 2026-08-30 | v0.14 | **All eight review conditions C1–C8 closed** (§7). Rule 5 **re-corrected and settled**: Django sets `os.environ['TZ']` from `TIME_ZONE`, so v1's `DateField` dates are **Bogotá**, verified against the pinned stack — the BA escalation on `last_modified` is withdrawn. Rule 5b (BigInt→JSON number) and 5c (`formatDateEs` takes a `PlainDate`) implemented as Phase 0 primitives. **D18 fixed rather than deviated** — v2 owns request parsing and reproduces DRF's multipart/415/JSON-parse behaviour, including CPython's error strings. `relativedelta` ported (reviewer P5). D1's primitives now express the C8 rule ordering. ⚠️ One review condition is **untracked**: S7 (detail-route trailing slashes) appears in the review's Phase 1 gate but in no §7 row — see the note under the table. |
| 2026-08-30 | v0.12 | **Phases 0 and 1 reviewed — both Approved-with-conditions, no blocking findings.** 8 conditions tracked in §7. Cross-cutting rule 5 **corrected** (Django `DateField(auto_now)` is process-local, not tz-aware). Two new rules: BigInt→JSON (17 columns; first Phase 3 response would 500) and the date-formatting/localtime asymmetry. D18 registered for content-type divergences. Fixed a self-contradiction in §9. |
| 2026-08-30 | v0.11 | business-analyst Phase 3 note folded in (verdict: **Concerns**). D1 clarified on two points that would each have broken every ordinary member save. **D14–D17 registered**; D16/D17 need operator input. Two live v1 defects verified and recorded: personal edits to the two shared-email accounts **409 today**, and **4 of 15 members cannot reset their password**. |
| 2026-08-30 | v0.10 | **Standing review gate made explicit** (§7): `nestjs-reviewer` runs at the end of every phase and writes `docs/review-phase-<n>.md`; no phase closes without a verdict. Phases 0 and 1 under review now, retroactively. |
| 2026-08-30 | v0.9 | **Phase 1 complete and verified** (`feat/phase-1-auth`, `151314f`). ⚠️ **Corrected a false premise: `username != email` for 2 of 15 live users, and Django authenticates on `username`** — the plan's mapping would have locked them out. DRF auth bodies derived and pinned (Phase 1's open item closed). Two new cross-cutting rules (405-vs-404, DRF framework error shape). D13 registered. Role-matrix criterion corrected to 280 cells. |
| 2026-08-30 | v0.8 | **Q25a resolved — D1 fully specified.** Privileges are additive on top of universal self-service. **Phase 1 unblocked and started.** |
| 2026-08-30 | v0.7 | Q10, Q13, Q18–Q25 answered. **Phase 6 unblocked** — CAP rules now specified. D3 **withdrawn** (v1 was right); D5 decided; **D12 added** (CAP auto-close, new functionality — makes P6 depend on P7). Cutover calendar constraint **corrected and narrowed** after re-reading `create_year` — only the bulk-upload cycle genuinely constrains timing. |
| 2026-08-30 | v0.6 | **Phase 0 complete and verified** (`feat/phase-0-foundations`, `b3effab`). Eleven corrections from implementation folded back: DB-level FK facts (deferrable, no cascade), hstore write-side + key-order rules, DRF error-body gap in Phase 1, D11 registered, Prisma 7 / NestJS 12 tooling notes added as §10. |
| 2026-08-30 | v0.5 | **v1 is frozen** — no changes to the Django codebase for any reason (new constraint, §1). Q6 and Q12 reconfirmed as deliberate accepts. Phase 0 started. |
| 2026-08-30 | v0.4 | Operator answers folded in (Q1–Q9, Q12, Q14–Q17). **Phases 1 and 4 unblocked.** Dev DB reloaded to `0019` — Phase 0 prerequisite cleared. D1 refined to a concrete field-level rule; D4 changed from *validate* to *reject 400*; four new deviations (D7–D10) registered for behavior the operator asked to change. Phase 6 still blocked (Q19–Q24); Q10/Q11/Q18 still open. |
| 2026-08-30 | v0.3 | business-analyst review folded in (verdict: **Concerns**). Added §5 **Deliberate deviations register** — v1 has authorization holes the parity contract would otherwise replicate. P7 resequenced to after P4. Phase 0 gains a dev-DB prerequisite (it is at migration 0015; `power` and `savingaccount` tables are missing). Phase 2 gains four notification conditions; P3/P4/P6 gain newly surfaced rules. §9 now tracks 24 operator questions. |
| 2026-08-30 | v0.2 | Q1–Q7 answered. **ORM decision: Prisma (binding).** Cutover is a hard switch performed by the user; v2 owns the schema post-cutover. Alexa confirmed retired. CI/CD reuses CodeBuild. Password-reset token cross-compat requirement **dropped**. hstore→jsonb scheduled as v2's first owned migration. Plan moved to the v2 repo. |
| 2026-08-30 | v0.1 | Initial draft. Phase 0–9 scoped, ORM comparison drafted, cross-cutting parity rules and gate template defined. |

---

## 1. Fixed constraints (not up for re-litigation)

- **Target stack:** NestJS (latest stable), **Node 24** (`.nvmrc` = 24), TypeScript **strict** mode.
- **ORM: Prisma.** Decided in §2. **Binding** for `nestjs-developer` and `nestjs-reviewer`.
- **Database:** the existing PostgreSQL schema Django created. No schema rebuild, no data
  migration, no renames **until cutover**. v1 and v2 share one database during development
  and parity testing; in production the switch is atomic.
- **Cutover: hard switch, performed by the user.** v1 and v2 never serve production traffic
  simultaneously. This plan produces a runbook; it does not perform the cutover.
- **Schema ownership:** Django owns the schema through Phase 8. **v2 takes ownership at
  cutover** via a Prisma baseline, and owns all migrations thereafter.
- **Out of scope — delete entirely, do not port** (Alexa is confirmed retired):
  - `AlexaView` / `POST /api/alexa`
  - `AuthView` / `GET|POST /api/authorize` — Alexa account-linking only
  - everything under `fondo_api/services/alexa/`
  - `ALEXA_CLIENT_ID`, `AWS_SKILL_ID`, `templates/auth/authorize.html`
  - all of `fondo_api/tests/alexa/` (20 tests)
  - ⚠️ `PasswordResetView` lives in the same file as `AuthView` and **is in scope** — do not
    delete `views/auth.py` wholesale.
- **In scope, must reach behavioral parity:** token auth, role permissions, loans +
  amortization + refinancing + bulk TSV upload, users + finance/quota + activation + powers
  of attorney, activities per year, saving accounts (CAPs), web-push notifications via SQS,
  SES email (Spanish templates), GCS file storage, password reset, and the Celery-beat
  scheduler.
- **CI/CD:** reuse the existing AWS CodeBuild + `buildspec.yml` + SSM deploy-trigger shape.
- **v1 is frozen.** No changes to the Django codebase — not features, not refactors, not
  security patches. Every fix lands in v2 only. Two consequences to hold in view:
  1. The **D1 privilege escalation stays live in production until cutover.** It is a real,
     currently-exploitable path to ADMIN and to self-set loan quota. Accepted by the operator;
     recorded here so the decision is visible rather than forgotten. It raises the value of
     shipping Phase 1 promptly.
  2. v1 stays the parity oracle for the whole migration — it cannot drift under us, which makes
     `manual-tester`'s diffs trustworthy. This is the upside of the freeze.

---

## 2. ORM decision: **Prisma** (binding)

Scored against this project's specifics. The user delegated the call ("the one that best fits
the project's needs and design"), so this is a decision, not a recommendation.

| Criterion | Prisma | TypeORM | Weight |
|---|---|---|---|
| **Migrations, v2-owned schema** | ✅ Prisma Migrate; `migrate diff` + baselining an existing DB is a first-class, documented workflow. Declarative schema is the source of truth. | ⚠️ `migration:generate` is drift-based, noisier, and routinely needs hand-editing. | **High** |
| **`hstore` columns** (2 of them) | ❌ Not supported — [prisma#19000](https://github.com/prisma/prisma/issues/19000) open. Introspects as `Unsupported("hstore")`, which the client **cannot select**. Needs raw SQL with `::text` casts. | ✅ Native `{ type: 'hstore' }` → `Record<string,string>`. | **High**, but **time-boxed** — see below |
| **TS type safety of results** | ✅ Generated types, end to end. | ⚠️ Hand-maintained entities that drift from the DB. | **High** |
| **Externally-owned schema** (Phases 0–8) | Good `db pull`; Migrate held back until cutover via baseline. | `synchronize: false` and it simply doesn't care. | Medium |
| **Django MTI** `UserProfile(User)` → `auth_user` + `fondo_api_userprofile` | 1:1 on `user_ptr_id`; every user read needs an explicit `include`. | `@OneToOne` + `@JoinColumn`. Comparable. | Medium |
| **Decimal / BigInteger money**, `rate` Decimal(5,3) | ✅ `Decimal.js`-backed, no float drift. `BigInt` for bigints. | ⚠️ `decimal` returns **string** by default; needs a transformer. | Medium |
| **Transactions** vs `transaction.atomic()` / `set_rollback` | Interactive `$transaction(async tx => …)`. | `dataSource.transaction()` / `QueryRunner`. Both fine. | Medium |
| **Raw SQL escape hatch** (bulk TSV upserts) | `$queryRaw` / `$executeRaw`, tagged and typed. | `query()` / QueryBuilder. Both fine. | Low |

### Rationale

Two facts decide it. **v2 owns the schema after cutover and the ORM must carry migrations**
— that promotes the migration story from a footnote to a top-weight criterion, and Prisma
Migrate is clearly stronger there. And **the hstore problem is bounded and temporary**: it
touches roughly 6–8 query sites across exactly two subsystems, it is quarantined behind two
repository classes, and it **dies at cutover** when the columns become `jsonb` (§3, Phase 9).
Prisma's type safety and migration ergonomics, by contrast, are paid forward for the life of
the project. This repo's `.gitignore` already carries `/generated/prisma`.

### The trade-off, stated plainly

The raw-SQL burden lands on **notifications and the scheduler** — precisely the two
subsystems with the thinnest inherited test coverage (4 tests and 0 respectively). This is
the single largest risk the decision creates, and Phases 2 and 7 carry extra integration-test
requirements to offset it.

### hstore handling until cutover

- Model both columns as `Unsupported("hstore")` in `schema.prisma`. Prisma Migrate preserves
  them; the client cannot read them.
- **All** access goes through `NotificationSubscriptionRepository` and `SchedulerTaskRepository`.
  No `$queryRaw` touching hstore anywhere else in the codebase — reviewer enforces this.
- Reads cast to text (`subscription::text`) and parse via the Phase 0 hstore codec.
- ⚠️ **Writes need the Python encoding too** — not just reads. Django `str()`s every value before
  storing, so a nested dict becomes a Python `repr` (single quotes). If v2 wrote JSON into the
  same column, v1 and v2 rows would be encoded differently and the read-side repair would break
  on v2's own rows. The Phase 0 codec implements both directions; use it on every write.
- ⚠️ **Subscription queries must emit no `ORDER BY`.** Django emits none, so v1 serialises
  **heap order**, and on `fondodev` heap order is not id order (verified: `160, 761, 1027, 783…`
  vs `160, 677, 710, 715…`). Adding the "obvious" `ORDER BY id` would *break* parity. Note this
  sits beside — and reads like the opposite of — the key-order rule below; both are about
  reproducing an order v1 never chose deliberately.
- ⚠️ **hstore key order is part of the SQS wire format.** Postgres returns hstore keys ordered by
  key length then bytes, and v1 `json.dumps`es that dict straight through to SQS. Phase 2's
  byte-identical criterion depends on reproducing that ordering — it is not an implementation
  detail.
- The codec must reproduce v1's quirks exactly — string-only values, `json.loads` on
  `payload['user_ids']`, and the `'` → `"` repair on the push-subscription `keys` sub-object
  (a Python `repr`, not valid JSON). **Do not "fix" these** — live rows depend on them.

---

## 3. Phase sequence

```
P0 Foundations & Prisma baseline ──┐
P1 Auth + roles                  ──┤ (no domain endpoints; everything depends on these)
P2 Mail + notifications          ──┤ (users & loans both emit)
P3 Users, finance, powers, password reset
P4 Loans (the risk centre)
P7 Scheduler ── resequenced: sole delivery path for payment reminders, zero inherited tests
P5 Activities
P6 Saving accounts
P8 Files + admin
P9 Cutover (user-performed) + hstore→jsonb + decommission
```

---

> **Why this line exists (C40).** Every convention this project carried successfully had a
> *carrier* — a table, a type error, a unit assertion. Every one that slipped was a
> paragraph: the §3/§5 precedence (D4's clamp), "compare raw then coerce" (D29), "the same
> predicate" (P4-F2) — three failures in Phase 4 alone, all in the prose column. This index
> is the carrier for "which decisions does this phase owe?", so a dispatch brief can be
> checked against the register mechanically instead of by reading §3's description of v1.

### Phase 0 — Foundations, Prisma baseline, cross-cutting utilities

**§5 rows this phase owns:** **D13**. *(Plus every cross-cutting row — D21, D22, D23, D24 — which start here and apply to all later phases.)*

**Goal:** a NestJS app that boots against the real schema, with the primitives every later
phase depends on. **No business endpoints.**

✅ **Prerequisite cleared (2026-08-30):** `fondodev` reloaded from a recent snapshot and
verified at `0019_auto_20220313_1225`, with `fondo_api_power` and `fondo_api_savingaccount`
present. Phases 3 and 6 are parity-testable. Re-verify after any future DB reload — a snapshot
older than `0017` silently breaks those two phases.

**Scope**
- Nest scaffold: Node 24, TS strict, ESLint + Prettier, Jest (unit) + Supertest (e2e).
- **Prisma setup:**
  - `prisma db pull` against the Django-created schema; hand-correct the generated models.
  - Verify against `fondo_api/models.py` and migrations `0001..0019`.
  - Both hstore columns as `Unsupported("hstore")`.
  - **Baseline:** generate an initial migration via `migrate diff` and mark it applied
    (`migrate resolve --applied`) so v2's history starts from the current live schema.
    **Do not run `migrate dev` against any DB v1 still uses.**
- Config module: typed and **validated at boot**, replacing v1's scattered `os.environ`
  reads. v1 `KeyError`s at import on a missing `DEFAULT_FROM_EMAIL`; v2 must fail fast with
  a clear message.
- Cross-cutting utilities, each unit-tested against v1's expected values:
  - `days360()` US-NASD 30/360 — port from `services/utils/date.py`; tests from `test_date_utils.py`.
  - **Money helper.** v1 rounds with `int(round(float(x), 0))` — Python **banker's rounding**.
    JS `Math.round` rounds half **up**. They differ on every `.5`. Ship `roundHalfEven()` and
    use it wherever v1 uses `round`.
  - **hstore codec** (§2).
  - **Spanish locale formatting.** v1 uses `babel.dates.format_date` / `babel.numbers` with
    `ROUND_HALF_DOWN`. Node `Intl` is not byte-identical. Pin with golden-string tests taken
    from v1's email assertions.
  - Timezone: `America/Bogota`, Django `USE_TZ=True` semantics.
- Global exception filter reproducing v1's `(success, payload_or_msg)` → `{message}` + status
  convention.
- `{ list, num_pages, count }` pagination helper, including v1's behavior that a page beyond
  the last returns an **empty list, same envelope, HTTP 200** — not 404.
- CI skeleton on the existing CodeBuild shape (§7).

**Risks**
- Introspected models disagreeing with Django semantics — especially `auto_now` /
  `auto_now_add`, which Django sets **in Python**, not as DB defaults. v2 must set
  `created_at` / `last_modified` explicitly or hit NOT NULL violations.
- During parity testing both apps insert into the same tables and must share the same
  Postgres sequences. Free as long as v2 never redefines a PK column — verify explicitly.

**Gate:** every table round-trips; utility unit tests green and matching v1's values.

---

### Phase 1 — Authentication and role permissions

**§5 rows this phase owns:** **D1** (decide only — implemented in P3), **D18**.

**Goal:** a request authenticated by v1 is authenticated identically by v2, and every role
rule matches.

**Routes:** `POST /api-token-auth`.

**Scope**
- **DRF token auth.** Reuse `authtoken_token` as-is (key PK, `user_id`, `created`). Token is
  40 hex chars. Header scheme is `Token`, **not** `Bearer`. Login uses **get-or-create** —
  v1 reuses an existing token and does not rotate.
- **Django password verification.** Hashes are `pbkdf2_sha256$<iterations>$<salt>$<b64hash>`
  (Django 2.2 default 150 000 iterations). v2 must verify this format — real member passwords
  live in `auth_user`. While v1 still runs in dev/parity, v2 also **writes** that format on
  activation and reset. Rehash-on-login to argon2 is a post-cutover cleanup item, not now.
- **`UserProfile(User)` identity mapping** — `auth_user` + `fondo_api_userprofile` on
  `user_ptr_id`.
- ⚠️ **CORRECTED (v0.9) — do not trust CONTEXT.md here.** The plan previously said
  `USERNAME_FIELD = 'email'` and `username = email` everywhere. **Both halves are misleading.**
  `AUTH_USER_MODEL` is commented out (`api/settings/base.py:101`), so Django's `ModelBackend`
  uses `User.USERNAME_FIELD == 'username'`; `UserProfile.USERNAME_FIELD = 'email'` **never
  participates in authentication**. And while v1 *writes* `username = email` on create,
  **2 of the 15 users in `fondodev` have `username != email`** (verified). Login resolves
  **`auth_user.username`**. A v2 that looked up `email` would lock those members out of their
  own fund.
- **Roles guard** reproducing `APIRolePermission` (`fondo_api/permissions.py`) exactly:
  - int rule N → allow if `role <= N` (0=ADMIN, 1=PRESIDENT, 2=TREASURER, 3=MEMBER)
  - list rule → allow if `role in list`
  - **any lookup miss or exception → deny.** v1's bare `except: return False` means a route
    absent from `list_permissions` is denied, not open. v2's guard must **default-deny**, and
    a route with no explicit rule must fail closed.
- Public routes (guards cleared): `POST /api-token-auth`, `POST /api/user/activate/<id>`,
  `POST /password_reset/`. Nothing else.

**⚠️ Additional deliverable — resolve the authorization gaps before writing the role matrix.**
v1's role matrix is not a safe spec on its own; see §5. D1–D3 must be decided (port or fix)
**in this phase**, because the Phase 1 parity criteria hard-code the matrix as the contract.
A decision deferred here gets silently baked in.

**Risks**
- ⚠️ **Highest-severity phase.** A wrong guard silently widens access to member financial data.
- Deny-by-default is easy to lose when translating a dict lookup into decorators.
- ⚠️ The role matrix is **necessary but not sufficient** — v1's holes are inside the service
  layer (no ownership checks), not in the guard. A perfect guard port still leaves D1 open.

**Parity criteria**
- The same token string authenticates against both APIs.
- Valid/invalid login returns identical status and body.
- ✅ **Resolved.** All auth-failure bodies are derived and pinned in
  [`docs/phase-1-drf-auth-bodies.md`](docs/phase-1-drf-auth-bodies.md) — from the
  `djangorestframework==3.11.2` sdist *and* an independent container running v1's real settings
  and unmodified `permissions.py`. `manual-tester` cites that document rather than re-capturing.
- ✅ **The 401-vs-403 ambiguity is not real for this project.**
  `TokenAuthentication.authenticate_header()` returns a truthy `'Token'`, so DRF's coerce-to-403
  branch is dead code here. **Every authentication failure is 401** with `WWW-Authenticate: Token`;
  only `APIRolePermission` denials are 403. Stated here so nobody re-derives it.
- ⚠️ Two ordering facts that are easy to get backwards: a missing or wrong-scheme header is **not**
  an authentication error (DRF returns `None`, and `IsAuthenticated` produces a *different* body
  later); and `APIView.initial()` authenticates **before** checking permissions, so a bad token
  401s **even on a public route** — `POST /api-token-auth` with a garbage token never reaches login.
- **Full role matrix: 14 view classes × 5 methods × 4 roles = 280 cells.** Test *all five*
  methods, not only those declared in `list_permissions` — the **undeclared** ones are exactly
  where the default-deny fallthrough lives, and testing only declared methods never exercises
  it. (`DELETE /api/loan` is 403 even for ADMIN.)

---

### Phase 2 — Outbound integrations: SES mail + SQS notifications

**§5 rows this phase owns:** none. *(Verified against the register's Phase column, not assumed — the phase closed on conditions C19–C27 instead.)*

**Goal:** v2 emits byte-identical emails and SQS messages. Before users/loans because both
emit on write paths.

**Routes:** `POST /api/notification/<subscribe|unsubscribe>` (role ≤ 3).

**Scope**
- `MailService` on **`@aws-sdk/client-ses`**. Port `send_mail(template, recipients, params, bcc)`
  including: an address in **both** `recipients` and `bcc` is dropped from `bcc`; and **any
  exception returns `false`** rather than throwing — `create_user` depends on the falsy return
  to roll back.
- Port the six Spanish templates via the `EmailTemplate` enum: `USER_ACTIVATION`,
  `CHANGE_STATE_LOAN_APPROVED`, `CHANGE_STATE_LOAN_DENIED`, `POWER_APPROVED`, `TEST`,
  `PASSWORD_RESET`. Django templates → a Node engine (Handlebars/Eta). The `{% host %}`
  custom tag → a `host` template variable from config. *(Phase 2 note: `{% host %}` has **zero
  call sites** in v1 — no template uses it. The activation email receives the same value as an
  ordinary `host_url` context variable at `services/user.py:51`. Wired but unused.)*
- `NotificationSubscriptionRepository` (raw SQL, hstore — §2): storage deduped on
  `subscription__endpoint`.
- `send_notification(user_ids, message, target)` builds `{ subscriptions, message: { body, target } }`
  and publishes to **SQS** (`NOTIFICATIONS_QUEUE_URL`). The external Lambda still does the
  actual Web Push, unchanged.
- v1's Celery indirection collapses: v1 does `send_notification.delay(...)` → task → SQS; v2
  publishes directly, so `run_async` True/False converge. ✅ **Resolved (§9.1): there is no
  retry layer to lose** — `celery/tasks.py:send_notification` swallows exceptions and declares
  no `autoretry_for`, and the scheduler path already publishes inline. Four binding conditions:
  1. Add a **bounded retry with backoff** (3 attempts) around `SendMessage`. Strictly improves
     on v1; no new infrastructure.
  2. Keep v1's swallow semantics at the boundary — a publish failure must **never** fail the
     HTTP write or roll back a loan/CAP/power row.
  3. ⚠️ **Never put the SQS publish inside a Prisma interactive transaction.** All three v1
     `.delay()` sites sit *outside* `transaction.atomic()`. Moving the publish inside would
     make an SQS outage roll back loan creations — a business-visible regression the inline
     change makes easy to introduce accidentally.
  4. Pre-existing gap to carry forward knowingly: a member with zero rows in
     `notificationsubscriptions` receives **no payment reminder at all** (`send_notification`
     returns early). Not a migration defect — but do not "fix" it silently either.

**Risks**
- ⚠️ Email HTML is asserted **byte-for-byte** in v1 tests (`test_mail_service.py`, and full
  SES payloads inside the loan tests). Whitespace, Spanish dates, and currency formatting must
  match — this is where the Phase 0 formatter earns its keep.
- ⚠️ **hstore + thin coverage.** Only 4 v1 notification tests exist and this is raw-SQL
  territory. **Extra integration tests required** covering the round-trip of a real
  push-subscription payload, including the nested `keys` repair.

**Parity criteria**
- Per template: identical SES payloads (`Source`, `Destination`, `BccAddresses`, `Subject`, `Body.Html`).
- Subscribe/unsubscribe produce identical `notificationsubscriptions` rows; re-subscribing the
  same endpoint does not duplicate.
- SQS message bodies byte-identical for the same input.

---

### Phase 3 — Users, finance, powers of attorney, password reset

> ⚠️ **Phase 8 changed this phase's bulk upload (P8-F5):** `readUploadedFile` now takes the **last** of two same-named `file` parts, as v1's `MultiValueDict` does — measured on `POST /api/file`; measurement on this phase's own route is condition **C81**. A baseline recorded before `71cd7de` will differ for that request shape.

**§5 rows this phase owns:** **D1** (implement), **D2**, **D5**, **D11**, **D14**, **D15**, **D16**, **D17**, **D19**, **D20**. Cross-cutting **D22**, **D23**, **D24** land here first.

**Routes:** `POST|GET|PATCH /api/user`, `GET|PATCH|DELETE /api/user/<id>`,
`POST /api/user/<birthdates|power>`, `POST /api/user/activate/<id>`, `POST /password_reset/`.

**Scope**
- `create_user`: atomic — `UserProfile` (**both tables**) + `UserFinance` (zeros) +
  `UserPreference`; `key_activation` = 25 random bytes hex; activation email. **If the mail
  send returns falsy, roll the whole transaction back** and return `'Invalid email'`. Unique
  violation → `'Identification/email already exists'`.
- **⚠️ Two decisions Phase 1 surfaced and deliberately did not make:**
  1. **D1's `role` check — "field present" or "field changed"?** v1's client posts the whole
     `personal` object on every PATCH, `role` included. A literal "`role` key present and caller
     is not ADMIN → 403" would break a member editing their own name. Phase 1 shipped both
     readings as tested primitives (`field-allowlist.ts` and `changedFields()`) and chose
     neither. **Recommendation: the `changedFields` reading** — compare against the stored value
     and only 403 on an actual change. Put this to business-analyst before implementing.
  2. **`PATCH /api/user/-1` does not mean "me" in v1.** Only `UserDetailView.get` substitutes
     `request.user.id`; `.patch` and `.delete` pass `-1` straight through and 404. Looks like an
     oversight rather than a rule. `resolveUserId()` makes the choice explicit so it cannot be
     inherited by accident — decide deliberately.
- ⚠️ **The two shared-email accounts — verified live, and the hazard is not what it looked like.**
  `fondodev` has **two pairs of users sharing an email address**: ids 7 & 14
  (`criss9413@hotmail.com`) and ids 10 & 13 (`mhjc123@hotmail.com`). Ids 13 and 14 have
  birthdates in **2011 and 2020** — children enrolled under a parent's address. Because
  `auth_user.username` carries a UNIQUE index (`auth_user_username_key`),
  `user.username = obj['email']` does not silently rename them: it raises `IntegrityError`, so
  **any personal edit to Sebastián or Ainhoa returns a bare 409 today**. The silent login-name
  rotation only occurs if one of them is later given a fresh, unique email. D15 fixes the write;
  the two rows still need reconciling — see the runbook item in §9.
- `update_user` dispatch on `obj['type']` → `personal` / `finance` / `preferences`, returning
  200/404/409. Finance writes **only changed fields** and recomputes
  `available_quota = total_quota - utilized_quota`.
- ⚠️ **The `preferences` branch deletes push subscriptions** — added v1.4 after parity finding
  **F5**, which falsified P2-D4's claim that `remove_all_subscriptions` was dead code.
  `services/user.py:208-218` compares the stored `notifications` flag with the submitted one
  and, when it goes **`true → false`**, calls
  `self.__notification_service.remove_all_subscriptions(id)` — every subscription that member
  owns, on every device. Phase 2 ported the method (`NotificationService.removeAllSubscriptions`,
  two DB-backed e2e cells) but could not wire it, because this route did not exist. **Wire it
  here, on the transition only**, not on every preferences save. It is irreversible from the
  server's side (the browser only re-subscribes on service-worker activation), which the tester
  escalated to `business-analyst`.
- `activate_user`: match `(id, key_activation, identification)`, set password (Django format),
  `is_active = true`, null the key.
- `DELETE` = **soft delete** (`is_active = false`), role ≤ 0.
- `id == -1` means "me" — the URL regex deliberately allows a negative id.
- `PATCH /api/user` — multipart **TSV bulk finance update** keyed by identification.
- `handle_power_request` multiplexed on `request['type']` (`post`/`get`/`patch`); on approval,
  emails the formal Spanish power-of-attorney letter **to all users**. Two defects ride along
  (§5 D2, D5): recipients go in `ToAddresses` with an empty `Bcc`, **exposing every member's
  email address to every other member**; and `Power.objects.get(id=request['id'])` never checks
  that the caller is the requestee, so **any member can approve any power request** and trigger
  the fan-out. Decide port-or-fix before implementing.
- `birthdates` app; setting `birthdate` on a personal update schedules a **yearly** (`repeat=4`)
  `SchedulerTask` for all other users. Rows written here, consumed in Phase 7.
- `get_users_attr(attr, roles)` helper.
- **Password reset.** ✅ *Simplified by the hard-switch decision.* v2 uses its **own** token
  scheme — no need to reimplement Django's `default_token_generator` or share
  `DJANGO_SECRET_KEY`. Port the behavior, not the token format: the http/https switch on
  environment, and the **unconditional** redirect to `/password_reset/done/` (no user
  enumeration). *Runbook note: reset links issued by v1 stop working at cutover; Django's
  default timeout is 3 days, so worst case a few members re-request.*
- ⚠️ **`Vary: Cookie` is on three *kept* routes, not one** (corrected in the round-3 sweep;
  v1.6 recorded only `GET /password_reset/`). `DrfViewHeaders` in
  `src/common/http/django-url-conf.ts` must widen when these views land:

  | route | `Vary` | also |
  |---|---|---|
  | `GET /password_reset/` | `Cookie, Origin` | `Set-Cookie: csrftoken` |
  | `GET /reset/<uid>/<valid token>/` | `Origin, Cookie` | **302** → `/reset/<uid>/set-password/` |
  | `GET /reset/<uid>/set-password/` | `Origin, Cookie` | `Set-Cookie: csrftoken` |

  **The element order differs between them** — `Cookie, Origin` on the first, `Origin, Cookie`
  on the other two. Django's `patch_vary_headers` appends rather than sorts, so the order
  records which middleware ran first. Transcribe the string per route; do **not** build it by
  joining a set. (`GET /api/authorize` is also `Vary: Accept, Origin, Cookie`, but Alexa is not
  migrated — out of scope, not a fourth row.)
- ⚠️ **`GET /reset/<uid>/<token>/` writes a `django_session` row — a DB side effect on a GET,
  and a Phase 3 *design* question rather than a one-liner.** With a valid token,
  `PasswordResetConfirmView.dispatch` (Django 2.2.27, `contrib/auth/views.py:272-278`) stores
  the token in the session (`self.request.session['_password_reset_token'] = token`) and
  redirects to the same path with the token replaced by `set-password`, so `SessionMiddleware`
  persists the session and **inserts a `django_session` row before the 302**. That write is
  also where the `Cookie` in `Vary` and the `sessionid` cookie on those two routes come from.
  **v2 has no session model at all** — nothing maps `django_session`, there is no session store
  and no `sessionid`. Since v2 already uses its own token scheme (above), the open question is
  whether the token-in-session hop is reproduced with real server-side sessions or replaced by
  a signed token carrying the same state. **Decide it here; do not build it as part of the
  header work**, and put the choice to `business-analyst` if it changes the reset URL shape.

**Risks**
- MTI writes touch two tables; a partial insert corrupts login.
- The email-failure rollback is a real transactional requirement, not a nicety.
- TSV parsing: `line.decode('utf-8').strip().split("\t")`, dates `d/m/Y` → `Y-m-d`.

**Parity criteria**
- User creation produces identical rows across `auth_user`, `fondo_api_userprofile`,
  `fondo_api_userfinance`, `fondo_api_userpreference` (modulo id/timestamps).
- Mail-send failure leaves **zero** rows in all four tables.
- Same TSV → identical finance rows and `last_modified` semantics — including
  `last_modified` **not** moving when no value changed.
- Power approve/reject → identical rows and identical email recipient list.
- ⚠️ **A birthdate edit produces a byte-identical `SchedulerTask`** — `type`, `run_date`
  (local midnight, i.e. `05:00Z`), `repeat = 4`, `processed = false` and `payload::text`,
  including the **unordered** `user_ids` list, which is PostgreSQL's heap order and must not be
  sorted. Added v2.2; the scope list above did not mention this write at all (finding S9).

---

### Phase 4 — Loans

> ⚠️ **Phase 8 changed this phase's bulk upload (P8-F5):** `readUploadedFile` now takes the **last** of two same-named `file` parts, as v1's `MultiValueDict` does — measured on `POST /api/file`; measurement on this phase's own route is condition **C81**. A baseline recorded before `71cd7de` will differ for that request shape.

**§5 rows this phase owns:** **D4**, **D6**, **D8**, **D9**, **D10**, **D25**, **D26**, **D27**, **D29**, **D30**. **D28 is WITHDRAWN** — ported from v1 unchanged by operator Q31. ⚠️ **D10 and D25 must land together.**

**The risk centre.** Most code, most money, most tests (33 in v1).

**Routes:** `GET|POST|PATCH /api/loan`, `GET|PATCH /api/loan/<id>`,
`POST /api/loan/<id>/<paymentProjection|refinance>`.

**Scope** (from `services/loan.py`)
- **Rate table:** `≤6 → 0.015`, `7–12 → 0.020`, `13–24 → 0.022`, `25–36 → 0.025` monthly.
  `timelimit > 36` **clamped to 36** silently, before the rate lookup. Commit `a45c343`
  changed this recently — port the *current* table. ⚠️ **The clamp is v1's behaviour and is
  SUPERSEDED by D4** — operator **Q9** decided `timelimit` outside `1–36` is a **400**, so v2
  rejects `37` where v1 returns `201` with `timelimit == 36` (v1's `test_post_loan_5` asserts
  the clamp; that test is a *moved expectation*, not a spec).
- **Quota check** on create: reject if `value > available_quota`, **unless** `refinance=True`.
- On create: always web-push to roles `[0, 2]`, target `/loan/<id>`.
- **Approval (`state → 1`)**, atomic: build the HTML amortization table, create `LoanDetail`,
  set `prev_loan.state = 3` if refinancing, send `CHANGE_STATE_LOAN_APPROVED` to the borrower
  with roles `[0,2]` **BCC'd**, return the serialized `LoanDetail`.
- **Denial (`state → 2`)**: `CHANGE_STATE_LOAN_DENIED`; clear `prev_loan.refinanced_loan`.
- **Payout (`state → 3`)**: remove scheduled `payment_reminder` tasks (v1's method name
  `remove_sch_notitfications` carries a typo; v2 may rename).
- **Interest math:** `((balance * rate) / 30) * days360(from, to)`.
- `payment_projection(loan_id, to_date)`.
- `refinance_loan`: **own APPROVED loan only**; new value = `capital_balance` (+ interests if
  `includeInterests`), `payment = 2` (REFINANCED), links both directions.
- **`bulk_update_loans`** (PATCH, multipart TSV), atomic: upsert each `LoanDetail`, schedule
  **two** `payment_reminder` notifications per loan (T−5d, T−1d), then **auto-close any
  still-APPROVED loan whose id was absent from the file**. Highest-consequence implicit rule
  in the codebase — a malformed upload closes real loans.
- Listing: `page`, `state` (0–4, **4 = all**), `all_loans` (roles ≤ 2 only), `paginate`.
  Order `-created_at, -id`.
- ⚠️ **`timelimit` has no lower bound.** `timelimit = 0` is accepted at create and then crashes
  at approval with a `DivisionByZero` in `__generate_table`. Add validation (§5 D4).

**Risks**
- ⚠️ Rounding — compounds Phase 0's half-even decision over up to 36 rows.
- ⚠️ `days360` edges: last-day-of-month, the 30/31 rule, negative ranges (v1 swaps and returns
  a positive count).
- ⚠️ **Auto-close blast radius, and it is not cleanly reversible.** The candidate set is
  *every* APPROVED loan in the fund. Recovery is broken in v1: `LoanDetail.loan` is a plain
  `ForeignKey`, not `OneToOne`, so setting a wrongly-closed loan back to state 1 creates a
  **second** `LoanDetail` row, after which `LoanDetail.objects.get(loan_id=id)` raises
  `MultipleObjectsReturned` and `GET /api/loan/<id>` returns 500 **permanently**. Two sub-cases:
  a *well-formed but incomplete* file commits and closes the omitted loans; and a loan approved
  **after** the treasurer generated the file is absent by construction and gets closed.
  v2 should make `loan_id` unique on `LoanDetail` (upsert, not insert) so recovery works — §5 D6.
- Decimal `rate` (5,3) must never become a float.

**Parity criteria**
- For ≥20 loans (varying timelimit, fee type, dates spanning month/year ends): `LoanDetail`
  rows identical **field for field**, approval email HTML byte-identical.
- Same TSV → identical upserts, identical set of auto-closed ids, identical `SchedulerTask`
  rows (dates, payloads, count).
- Refinance chains: identical `prev_loan` / `refinanced_loan` linkage both directions.
- Quota rejection and the `>36` clamp match exactly.
- Pagination envelope and ordering identical, including `state=4` and out-of-range pages.

---

### Phase 5 — Activities

**§5 rows this phase owns:** **D36** — registered by the `business-analyst` **after** implementation and changing **no Phase 5 code** (`GET /api/activity/<id>`'s member roster, ported and accepted under operator **Q32**); its pin is the four e2e role cells that were already green. It owned **none at implementation time**, and that is what the mechanical check below measured. The phase also *discovered* **D35** (a live Phase 3/4 `null`-folding defect), **D38** (a live v1 account takeover) and **D37** (the burned sequence value), and registered **P5-D1–P5-D4** locally. The original mechanical check — the register's `Phase` column held **no `P5` entry** — was correct when it was run and is the reason nothing was invented during implementation; it did not mean nothing would be found. ⚠️ It is now **stale as a check**: `grep -c '| P5 |'` returns 1, and re-running it will not tell a later reader whether the phase's *implementation* owned rows. What that check actually protected against is a phase brief citing a row that does not exist, so cite the register, not this sentence.

**Routes:** `GET|POST /api/activity/year`, `GET|POST /api/activity/year/<id_year>`,
`GET|PATCH|DELETE /api/activity/<id>`.

**Scope**
- `POST /api/activity/year` (role ≤ 1): create the **current-year** `ActivityYear` and
  disable the highest **other** year — ⚠️ **one row, and not necessarily "the previous
  one"**. `filter(~Q(year = year)).order_by('-year')[0]` is the highest year that is not the
  one being created, so across a gap it disables whatever the highest other year happens to
  be. Corrected 2026-09-04 by `nestjs-developer` from the source; the earlier wording said
  "the previous one" and the live table has both a gap in its ids and an anomaly in its
  flags (`docs/phase-5-prework.md` §1).
- `POST /api/activity/year/<id_year>` (role ≤ 1): create an activity and attach **all active
  users** via `ActivityUser` (state `0 NOT_PAID`).
- `PATCH /api/activity/<id>?patch=activity|user` — two distinct update paths.
- `DELETE` (role ≤ 1).

**Risks:** low, **except one**. The active-user set must match v1's definition
(`is_active = true`) exactly, and the year-rollover disable is a once-a-year path that's easy
to break and hard to notice. ⚠️ **The risk that actually bit is the `DELETE` cascade** (§4 rule
10): `ActivityUser.activity` is `on_delete=CASCADE` in Django and `NO ACTION` in the database
(measured), so without an explicit child delete `DELETE /api/activity/<id>` is a **500** on
every activity that has members — i.e. all of them. **v1's own `test_delete_activity` cannot
see it**, because it attaches no members; a faithful port of v1's suite therefore passes
against the broken implementation. Verified by control run.

**Parity criteria:** identical `activityyear` / `activity` / `activityuser` row sets;
identical previous-year `enable` flip; both `patch=` modes identical.

---

### Phase 6 — Saving accounts (CAPs)

**§5 rows this phase owns:** **D12**. **D3 is WITHDRAWN** (operator Q22/Q23).

**Routes:** `GET|POST|PUT /api/saving-account` (GET/POST role ≤ 3, PUT `[0,2]`).

**Scope**
- Create, list (`state` 0–1, `all_accounts` for privileged, `paginate`), `PUT { id, state, value }`.
- `UserFinanceSerializer.total_savingaccounts` sums **active** accounts — a Phase 3 response
  field this phase's writes feed. Re-verify the Phase 3 parity report after this lands.

**Business rules — now specified by the operator (Q19–Q24), no longer inferred:**

- A CAP is a **fixed-term deposit that earns no interest and no return** (Q19). The fund only
  tracks it. Nothing accrues; there is no rate anywhere in this module.
- `value` on `PUT` is the **new total balance**, a plain replacement — not a deposit to add
  (Q21). This matches v1.
- **Only ADMIN and TREASURER may act on CAPs** (Q22); PRESIDENT is deliberately excluded
  (Q23). v1's `[0,2]` rule is correct as written — see the withdrawn D3.
- **No member notification** on close or revalue (Q22).
- **CAP balances are purely informational** (Q24): `total_savingaccounts`
  (`serializers.py:32`) is display-only and affects **neither `total_quota` nor
  `contributions`**. State this explicitly in the v2 code — it contradicts the natural reading
  and is the kind of thing a future maintainer will "fix" by accident.
- **CAPs close automatically on `end_date`** (Q20) — see **D12**. This is the one piece of new
  functionality in the phase; v1 has the `# TODO` and never built it. It requires a scheduler
  task type, which is why this phase runs **after** Phase 7.

**Risks**
- ⚠️ **v1 has no tests for this module at all.** No `test_saving_account_views.py` exists.
- ⚠️ **D12 is new functionality, so it has no v1 behavior to be parity-checked against.**
  Everything else in this phase is a port; the auto-close must be specified and tested on its
  own terms. Confirm the intended edge cases with the operator when it is built: what happens to
  a CAP whose `end_date` is already in the past when the feature ships, and whether closing is
  driven at the 10:00 or 14:00 scheduler run (or both).
- ⚠️ Still the module with **zero inherited tests** — the rules above are the spec now, so write
  the suite from them rather than from v1's behavior alone.
- ⚠️ **D12's executer must `throw` on a failed close — not return `ok: false` — and that is
  safe only because a CAP closes once, so its task must carry `repeat = 0`** (conditions
  **C74**, **C77**; `docs/phase-7b-deviations.md` §7.4 item 3). Phase 7b's runner offers two
  failure channels and they are not interchangeable: a throw releases the claim, the next
  10:00/14:00 pass retries the row, and **no `repeat` successor is cloned on that pass**
  (`scheduler.runner.ts` releases and rethrows *before* `createRepeatInstance`); `ok: false`
  marks the row `processed`, logs one `WARN` and **never retries**. The second was decided by
  **Q6** for a *lost push*, where losing one message beats breaking the `repeat` chain. It does
  not transfer: a lost push is recoverable next month, an unclosed CAP is not — "task processed,
  CAP still open, one `WARN`" is a financial-state divergence no later pass repairs. **State the
  rule on the `repeat` axis, not the money axis**: `throw` is right for a `repeat = 0` task,
  where the worst case is a row that keeps being retried and keeps being visible; for a
  repeating task it trades one occurrence for the whole chain, which is Q6's case. **So do not
  give the close task a non-zero `repeat`** — a deterministically-failing repeating task throws
  on every pass and never clones its successor, which is exactly the chain break Q6 avoided.
  C77's gate obligations are code, not words: `repeat = 0` literal at the task-creation site, a
  cell asserting the inserted row's `repeat` is `0`, and a cell asserting a **throwing** close
  executer leaves the row unprocessed **and writes no clone**. *Suggestion for this phase (not a
  condition):* declare the close executer's return type as `Promise<{ ok: true; detail: string }>`
  so `ok: false` is a compile error rather than a review catch.
- ⚠️ **D12 must be idempotent and independently reconcilable, and closed-ness must be
  materialised in `state`** (conditions **C74**, **C78**; `docs/phase-7b-deviations.md` §4
  **P7-D2**, §7.4 item 4). Phase 7b claims the row *before* running it, so a process that dies
  between the claim and the side effect leaves the row `processed` with the close never done —
  silently. The close is
  `UPDATE fondo_api_savingaccount SET state = 1 WHERE id = ? AND state = 0` (a no-op on rerun,
  race-safe, no read-modify-write); the independent check is
  `SELECT id FROM fondo_api_savingaccount WHERE state = 0 AND end_date < <today, America/Bogota>`,
  which is also the ship-day backfill for CAPs already past `end_date` — see the first open
  operator question below. ⚠️ **Do not derive closed-ness from `end_date` at read time.** C74
  offered it as an equal alternative and it is not one: v2 already ships the `state: 0` aggregate
  in a **Phase 3 path that has passed its gate** (`src/users/user.service.ts`,
  `total_savingaccounts`), it puts two sources of truth in a one-column state model that
  **Q21**'s `PUT { id, state, value }` writes directly (a `PUT state = 0` on a row past
  `end_date` would be a re-open and a no-op at once), and a derivation is not an independent
  check but a redefinition — it makes the runner's failure invisible instead of detectable.
- ⚠️ **A cell pinning a timezone-sensitive computation must be mutation-controlled against *each* wrong implementation separately** — the general rule C76 taught, recorded here because the next phase reads it. C76's own suggested discriminating cell was **insufficient**: a `fromDateColumn → toBogotaDate` mutant passed it, because a MONTHLY hop into February is exactly where `min(28,31)` and `min(28,30)` are both 28, so the clamp collapses the difference. *"The two dates disagree"* is **not one property but two** — *read-local* (wrong start day) and *round-trip-local* (wrong pinned wall time) — and a single cell can catch one while missing the other. Only a mutation control found this; reading the cell did not.
- ⚠️ **`SCHEDULER_ENABLED` is a *role* flag, so D12's auto-close inherits the zero-instance
  failure mode wholesale.** If nobody carries the flag, nothing errors and CAPs simply stop
  closing — exactly as reminders simply stop sending (`docs/phase-7b-deviations.md` §5.4,
  §7.2). Conditions **C68** (the run summary must reach a log, so the operator check can tell a
  completed pass from a dead one) and **C70** (an unrecognised `SCHEDULER_ENABLED` value must
  fail the boot rather than silently disable) are the detection story for **both**; D12 needs no
  separate one, but it does need those two to have landed.

**Parity criteria:** identical rows on create/update; identical list envelope and filtering;
`total_savingaccounts` identical in the user finance response after each mutation.

---

> ⚠️ **Consequence of the C4 timezone finding, recorded here because it lands in this phase:**
> `scheduler/tasks.py:15-18` compares `datetime.now()` against `run_date__year/month/day`
> lookups. Those agree **only because** Django's `tzset()` makes the process zone Bogotá. v2 must
> anchor "today" in `America/Bogota` explicitly — inheriting the host zone would make the
> scheduler silently skip or double-run tasks around midnight.

### Phase 7 — Scheduler (replacing Celery beat)

**§5 rows this phase owns:** **D7**.

> ⚠️ **Split into 7a and 7b (v2.2), because Phases 3 and 4 *write* the rows Phase 7 runs.**
> Review finding **S9**, condition **C24**. v1's call sites are
> `services/user.py:281-282` (`PATCH /api/user/<id>` — Phase 3) and `services/loan.py:107,314`
> (loan payout and bulk update — Phase 4), both of which precede this phase in the sequence.
>
> * **7a — ✅ DONE, landed with Phase 3** (`af596b0`): `SchedulerTaskRepository` (the second and
>   last raw-SQL hstore repository), `NotificationService.scheduleNotification` /
>   `removeSchNotifications`, the hstore encoding, and the same-day dedupe rule. Its parity
>   criterion is a **data** comparison against the live rows — **626** today, not the 632 this
>   bullet was written against (six were destroyed in the Phase 3 round, §7) — not an execution
>   one; see C24 in §7.
> * **7b — this phase**: the cron runner, the executer factory, `repeat` cloning, and the
>   multi-instance claim. Everything under *Scope* below **except** the last two bullets, which
>   7a already covers.

> **Resequenced (v0.3): run this directly after Phase 4, before Phases 5/6.** It is the sole
> delivery path for loan payment reminders, has **zero** inherited tests, is raw-SQL hstore
> territory, and fails **silently** — `scheduler/tasks.py:scheduler` marks a task `processed`
> after `executer.run()` returns while `send_notification` swallows errors, so a failed publish
> is recorded as success. Highest ratio of consequence to coverage in the migration.

**Goal:** retire the Celery worker + beat containers. ✅ **Done in 7b** — and because the
replacement is `@nestjs/schedule` rather than BullMQ, **Redis goes with them**: `BROKER_URL`
(`api/settings/base.py:165`) has no consumer left in v2. Add it to Phase 9's decommission list.

**Scope**
- Replace `celery -A api beat` with `@nestjs/schedule` (or BullMQ on the existing Redis if
  multi-instance safety is wanted — decide in this phase).
  ✅ **Decided (7b): `@nestjs/schedule`**, plus a deployment role flag (`SCHEDULER_ENABLED`,
  default **false**) and an atomic database claim. Reasoning in `docs/phase-7b-deviations.md`
  §1, in short: v1's guarantee is *topology* — beat is a separate container and the web image
  never runs it — so the flag reproduces v1's actual property, while BullMQ would keep the
  Redis this phase exists to retire **and** add a second source of truth for "what runs when"
  next to `fondo_api_schedulertask`. The multi-instance residual is handled in the data by
  `claim()`. ⚠️ **Phase 9's decommission step can therefore drop Redis** — `BROKER_URL`
  (`api/settings/base.py:165`) has no remaining consumer in v2.
- Cron: **10:00 and 14:00 `America/Bogota`**, matching `crontab(minute=0, hour='10,14')`.
- Loop: load today's unprocessed `SchedulerTask`s → resolve executer by `type` → run → mark
  `processed = true` → `create_repeat_instance` clones the row forward by `repeat`
  (NONE/DAILY/WEEKLY/MONTHLY/YEARLY, `relativedelta` semantics — month-end arithmetic differs
  between libraries, pin it with tests).
- `NotificationExecuter` (type 0) → `send_notification(...)`. `payload['user_ids']` is
  `json.loads`-ed out of hstore's string storage (§2).
- ✅ *(7a, done)* `schedule_notification(run_date, payload, repeat)` dedupe: **skip if an
  unprocessed task with the same `owner_id` + `type` already exists that calendar day.**
  ⚠️ `run_date__year|month|day` extracts `AT TIME ZONE 'America/Bogota'` under `USE_TZ`, not
  UTC — a UTC extract defeats the dedupe for every task scheduled after 19:00 local.
- ✅ *(7a, done)* `SchedulerTaskRepository` — raw SQL for the hstore `payload` column.
  ⚠️ Its write methods take an **optional transaction client**: `__update_user_personal` calls
  both of them inside `transaction.atomic()`, so a failed profile edit must take the scheduler
  rows with it.

**Risks**
- ⚠️ **hstore + zero inherited coverage.** No v1 scheduler tests exist *and* this is raw-SQL
  territory. **Extra integration tests required** — this is the weakest-covered subsystem in
  the migration.
- Multi-instance v2 needs a lock or an atomic claim
  (`UPDATE … WHERE processed = false RETURNING`), or tasks run N times.
  ✅ **Done in 7b** — `SchedulerTaskRepository.claim()`, with the executer resolved *before*
  the claim so an unknown type is never consumed (Phase 6's D12 adds one).
- ⚠️ **And the mirror case, which is the more likely cutover mistake because it is the
  default: `SCHEDULER_ENABLED` set on *nobody*.** Nothing errors, nothing logs an error, and
  the fund simply stops getting reminders. The check is a **positive** one — but ⚠️ **`grep -c
  'Running scheduler'` was the wrong string and is retired (C68, closed in Phase 6).** That line
  is emitted at the *start* of a pass, so it returned **2** whether the pass processed 110 rows
  or died on the next statement — a check that could not fail, written into the runbook by the
  phase that also wrote C67. The replacement counts lines emitted only at the **end** of a pass,
  and pairs the positive count with a negative one:
  `grep -c 'Scheduler pass finished'` must be **2**, and `grep -c 'Scheduler pass failed'` must
  be **0**. ⚠️ **This is also D12's detection story** — a CAP that silently stops closing is
  caught the same way a reminder that silently stops sending is, and neither needs a mechanism
  of its own.
- `relativedelta` month/year arithmetic on the 29th–31st.
- ✅ *Double-execution across v1 and v2 is no longer a concern* — the hard switch means beat
  and the v2 scheduler never run against the same DB in production. **Keep them from
  overlapping in the shared dev DB** during parity testing: run one at a time.

**Parity criteria**
- Given seeded `SchedulerTask` rows, v2 produces the same SQS messages and the same set of
  repeat-clone rows (dates especially) as v1.
- Dedupe rule verified: a same-day, same-owner, same-type schedule is skipped.

---

### Phase 8 — Files and admin

**§5 rows this phase owns:** none of its own; inherits cross-cutting **D22**/**D23** on the file upload, and **rule 12b** (do not narrow `FileView.post`'s parsers).

**Routes:** `GET|POST /api/file` (POST role ≤ 0), `GET /api/file/<id>`, `GET /api/admin` (role ≤ 0).

**Scope**
- GCS via `@google-cloud/storage`, bucket `fonmon`, object path `<type_display>/<name lower>`.
- `save_file`: **checks `blob.exists()`, uploads unconditionally (overwriting any existing
  object), then writes the `File` row only if the object did not already exist.** The row is
  written *after* the upload, which is what makes P8-F1–F3 partial writes (measured, Phase 8;
  this line used to describe only the row check).
- `get_signed_url`: **v4** signed GET, **5-minute** expiry.
- v1's `ENVIRONMENT == 'test'` anonymous-client branch → an injected storage client.
- `GET /api/admin?type=email|notifications` — self-test send. **No v1 tests exist.**

**Risks:** low. Signed-URL version and expiry must match; `display_name` is unique.

**Parity criteria:** same upload → same object path and `file` row (and **no** duplicate row
when the blob already exists, **and the object is overwritten** — measured v1 behaviour; whether
the fund endorses it is with `business-analyst`, P8-F1–F3); signed URLs valid, v4, 5-minute
expiry. Object path lowercasing is CPython's `lower()`, not JS `toLowerCase()` (95 code points
differ between the pinned runtimes, measured).

---

### Phase 8b — Birthday notifications (C71, D39)

**Added 2026-09-12 by the operator (Q43).** Two birthday-notification defects left out of Phase 6,
given their own phase so v2 does not ship with them. Sequenced after Phase 8 and before Phase 9.

**§5 rows this phase owns:** **D39**, **D48**, **D49**. **Conditions:** **C71**.

**Decided by the operator 2026-09-14 (Q47–Q49):** schedule the next birthday not yet missed (**D48**); skip a departed member's greeting at send time while the chain keeps rolling, so a returning member resumes (**D39**, Q48); send each greeting to the current active members at send time (**D49**).

**Scope**
- **C71** — a birthdate set or corrected after this year's birthday has passed writes an
  already-past-due `SchedulerTask`; under D7's `<=` selection v2 would fire *"Hoy está cumpliendo
  años X"* on the wrong day. Q36 folded Ainhoa's never-created birthday chain into this condition.
- **D39** — v2 must not announce a departed member's birthday (Q35). Decided (Q48): the check
  runs at send time; the row is still marked processed and its successor cloned, so a returning
  member resumes automatically.
- **D49** — birthday recipients resolved at send time (Q49), birthday tasks only.
- **Ainhoa (Q36)** — after D48 lands, saving her profile starts her chain on 2027-08-05; no manual
  insert.

**Risks**
- Live birthday chains are `repeat = 4`; C76's YEARLY read-local lesson applies to every date this
  phase computes.
- **Task 2142** (a departed member, `run_date` 2026-11-14) is neutralised by runbook step 3a-bis at
  cutover; it fires under v1 if cutover has not happened by then. This phase's code does not reach
  v1.

---

### Phase 9 — Cutover, hstore→jsonb, decommission

**§5 rows this phase owns:** **D34** (the two migration ledgers, below). Inherited work that lands
here: **D6's physical `UNIQUE (loan_id)`** and **D11's `UNIQUE (user_id)`**, both deferred because
Django owns the schema until step 6.

**The user performs the cutover.** This phase delivers the runbook and the post-switch
migrations.

**Runbook (for the user)**
1. Freeze writes to v1.
2. Stop v1 containers: `api`, `worker`, `scheduler`, `sch_work` (`scripts/run-server.sh`).
3. Deploy v2 with **`SCHEDULER_ENABLED` unset everywhere**; point DNS/proxy at it. 🔴 **This step closes D38's accepted v1 exposure** (the unauthenticated account takeover) — it ends here, not at step 6, and needs nothing extra done.
   ⚠️ **Before first boot, check `TIME_ZONE` in the production environment (C89, review N3):** leave it **unset** or set it to **exactly** `America/Bogota`. The env schema pins it (`z.literal`), so any other value — including surrounding spaces — makes v2 refuse to start with `EnvValidationError`. That fails loudly by design; no production runtime configuration is tracked in the repo, so this cannot be checked from here.
3a. ⚠️ **Drain the scheduler backlog before enabling the runner — P7-D1.** v2's D7 rule is
   `run_date <= today`, and *"has passed"* and *"was never picked up because v1 could not"* are
   the same database state. Measured on `fondodev` 2026-09-07: **110** unprocessed rows are due
   on the first pass, the oldest from **2020-09-27**, **65** of them payment reminders for loans
   already `PAID_OUT`. After the step-1 dump and **before** step 3b:
   ```sql
   UPDATE fondo_api_schedulertask SET processed = true
   WHERE processed = false AND run_date < now() - interval '2 days'
     AND repeat = 0;
   ```

   ⚠️ **`AND repeat = 0` is load-bearing — condition C72.** Draining a *repeating* task writes
   no clone, so it does not skip one delivery, it **ends the chain permanently**. Measured
   2026-09-07: of the 108 rows the two-day predicate hits, **107 are `repeat = 0`** and exactly
   **one is not** — task **1497**, a `YEARLY` birthdate task for owner **3** (Fernando,
   `birthdate 1974-03-02`), unprocessed since 2024-03-02. Without this clause that member is
   never greeted again, and nothing anywhere would say so.

   ⚠️ **Correction 2026-09-07 — this paragraph previously said the live harm of task 1497 was
   "nil" because owner 3 is `is_active = false`. That was wrong twice, and the second half was
   caused by the `AND repeat = 0` clause immediately above.** First: **v1 has no `is_active`
   filter anywhere on the notification path** (`services/notification.py`, `scheduler/`,
   `celery/` — grep controlled: the same grep finds `def ` in all of them, and `is_active`
   exists elsewhere in v1, so the absence is real). Recipients are frozen into the payload when
   the chain is created. v1 has **already announced a departed member's birthday to the whole
   fund**: task **1770**, *"Hoy está cumpliendo años Angi Paola Sanchez Quilindo"*,
   `run_date 2025-11-14`, **`processed = true`** — and user 15 is `is_active = f`. Second:
   sparing 1497 from the drain does not park it, it **fires** it. `create_repeat_instance`
   anchors the clone to **the task's own** `run_date` (`scheduler/tasks.py:39-40`,
   `run_date + relativedelta(years=1)`), not to the next future anniversary, so a past-dated
   yearly task catches up one year per pass: 2024-03-02 → 2025-03-02 → 2026-03-02 are all
   `<= current_date` and 2027-03-02 is not — **three fund-wide out-of-season pushes across two
   days**. The parity round never saw this because it drained first and then ran one pass.

   ✅ **Decided by the operator 2026-09-07 (Q35): departed members are no longer announced.**
   So **delete task 1497 by id** — the `AND repeat = 0` clause spares it, and this step removes
   it deliberately, for a stated reason rather than as a side effect of a predicate.
   ✅ **Changed 2026-09-14 (Q51): delete, not mark processed.** Under v2 (D39, Q48) the row would
   only skip and roll forward; the operator chose to remove it. A returning member is greeted
   again once their birthdate is saved, which schedules the next birthday (D48); how a member
   returns is not established (Q52).
   ```sql
   DELETE FROM fondo_api_schedulertask WHERE id = 1497;  -- owner 3, is_active = f (Q51)
   ```
   Today's birthday task (id **2021**, owner **9**, Nitza Marisol, also `YEARLY`) is protected
   by the two-day grace and **must fire** — she is active and it is her birthday.

3a-bis. ⚠️ **Delete task 2142 before 14 November 2026 — no drain predicate reaches it** (Q51).
   Task **2142** is Angi Paola's next clone: `run_date 2026-11-14`, `repeat = 4`,
   `processed = false`, owner **15**, `is_active = f`. It is **future-dated**, so step 3a's
   backlog predicate does not touch it and neither does any two-day grace. Under Q35 it must not
   fire, and it fires **under v1 too** if cutover has not happened by then — this is not a
   migration artifact. As of 2026-09-07 that is **68 days away**, which makes it the only
   dated deadline in this runbook.
   ```sql
   DELETE FROM fondo_api_schedulertask WHERE id = 2142;  -- owner 15, is_active = f (Q51)
   ```
   ✅ **Decided 2026-09-14 (Q51): delete it.** Run this **on v1's production database before
   14 November 2026 if cutover has not happened by then** — v1 sends on the exact date. Deleting
   ends the chain, and that is the decision, not an accident. Re-run the sweep below at cutover
   rather than trusting these two ids: other departed members may have pending chains. ⚠️ **Applying
   Q51's delete to rows the sweep finds beyond 1497 and 2142 is an extension, not a decision** —
   confirm with the operator at cutover. The sweep was **corrected 2026-09-14** (`business-analyst`,
   Q-8b-3): the earlier inner join could not see a chain whose owner has no `auth_user` row, and
   its `::int` cast would abort on a non-numeric `owner_id`. Measured read-only on `fondodev`: it
   returns exactly **1497** and **2142** of **14** pending birthday chains; a `VALUES` control
   sweeps an unknown id, `abc` and `99999999999`, and does not sweep active owner 9.
   ```sql
   SELECT t.id, t.run_date::date, t.repeat, t.payload->'owner_id' AS owner, u.is_active
   FROM fondo_api_schedulertask t
   LEFT JOIN auth_user u
     ON u.id = CASE WHEN t.payload->'owner_id' ~ '^[0-9]{1,9}$' THEN (t.payload->'owner_id')::int END
   WHERE t.processed = false AND t.payload->'type' = 'birthdate'
     AND (u.id IS NULL OR u.is_active = false);
   ```
   ⚠️ **Going forward this needs code, not a runbook step** — registered as **D39**. The payload
   carries `owner_id` (verified: 1497 → 3, 2142 → 15), so v2 can check the subject's
   `is_active` at execution time. That is a **deliberate deviation from v1**, which announces
   departed members and always has.

   After the drain, confirm the intent rather than the statement:
   ```sql
   SELECT count(*) FILTER (WHERE repeat <> 0) AS chains_left_alive,
          count(*) AS still_unprocessed_and_due
   FROM fondo_api_schedulertask
   WHERE processed = false AND run_date <= now();
   ```
   ✅ **Decided by the operator 2026-09-07 (Q34): drain.** The two alternatives — bounding the
   catch-up in code, which changes D7; or accepting the flood — are in
   `docs/phase-7b-deviations.md` §4, P7-D1, and were declined.

   ⚠️ **Use this predicate, not `run_date < now()`.** The two-day window drains **108** of the
   110 and deliberately **spares today's birthday task and yesterday's reminder**, which are
   legitimate deliveries the first pass should make. `run_date < now()` would drain those too,
   and the member whose birthday it is would simply never be greeted. **D7 is unchanged**: a
   task that becomes past due *after* cutover is still sent rather than skipped.
3b. Set **`SCHEDULER_ENABLED=true` on exactly one process** — the v2 equivalent of v1's separate
   `celery beat` container, and the only replacement for it. **Then verify it is running:**
   ⚠️ **Corrected by C68 (Phase 6) — the old `grep -c 'Running scheduler'` could not fail**,
   because that line is emitted before any work happens. Count the lines emitted at the **end**
   of a pass instead, and run both halves:
   ```bash
   grep -c 'Scheduler pass finished' <log>   # expect 2 — started AND finished, twice
   grep -c 'Scheduler pass failed'  <log>   # expect 0
   ```
   A `0` on the first means nobody has the flag and reminders **and CAP auto-closes** have
   silently stopped; that is the default state, so check it rather than assume it.
4. Smoke-test the Phase 1 role matrix and one loan approval end to end.
5. Rollback = re-point at v1, **valid only until step 6 runs.** ⚠️ Rolling back also means
   unsetting `SCHEDULER_ENABLED` and restarting v1's `scheduler`/`sch_work` containers — the two
   runners must never be up against the same database (§4 rule 6).

**After the switch — v2 owns the schema**
6. **hstore → jsonb migration** (v2's first owned schema change; Q7). Two columns:
   `notificationsubscriptions.subscription`, `schedulertask.payload`.
   - `ALTER COLUMN … TYPE jsonb USING hstore_to_jsonb(…)`, **plus a data-repair pass** — the
     doubly-stringified values (`user_ids`, the push-subscription `keys` object) come out as
     JSON strings containing JSON and must be unwrapped. Not a one-liner.
   - Then delete the hstore codec, drop the two raw-SQL repositories to normal Prisma models,
     and simplify Phases 2 and 7. **This is the payoff for choosing Prisma — do not skip it.**
     In the 7b runner the whole change is one cast: `create_repeat_instance` writes
     `${task.payloadText}::hstore` and nothing else in it touches the encoding.
   - ⚠️ **One-way door:** Django's `HStoreField` breaks the instant this runs. Rollback to v1
     is dead after step 6. Take a backup first.

**D34 — two migration ledgers, one schema (condition C39)**

`fondodev` carries **both** today: `django_migrations` with **38 applied rows**, and
`_prisma_migrations` holding a single **inert** `0_init` at `applied_steps_count = 0` — a baseline
recording the schema Prisma introspected, not a migration Prisma ran. They do not conflict while
v2 only reads and writes rows, which is why nothing has forced the question through Phases 0–8.

**Step 6 forces it**, because it is the first schema change v2 owns, and the `UNIQUE` constraints
above are two more. The decision:

* **`django_migrations` is frozen, not dropped.** It is the provenance of every table v2 inherits,
  and dropping it destroys the only record of how the schema reached 0019. It stops being written
  the moment v1 is decommissioned; keep the table, add no rows.
* **`_prisma_migrations` becomes authoritative from step 6 forward.** `0_init` stays at
  `applied_steps_count = 0` — **do not** "repair" it to 1. It is a baseline marker; marking it
  applied would claim Prisma created tables it only introspected, and the next `migrate deploy` on
  a fresh database would then skip them.
* **Every post-cutover change is a Prisma migration**, including the `hstore → jsonb` conversion
  and its data-repair pass, and including the two `UNIQUE` constraints. None is applied by hand.
* ⚠️ **Never run `prisma migrate dev` against a database v1 can still reach.** It drops and
  recreates on drift, and Prisma reads Django's 38 tables as drift from `0_init`. `migrate deploy`
  only. This has been the standing rule since Phase 0; step 6 is where it stops being theoretical.

**Rollback consequence:** after step 6 the two ledgers describe *different* schemas — Django's
last-known state and Prisma's current one. That is the same one-way door the `hstore` note names,
recorded here in ledger terms so nobody reads a clean `django_migrations` as "v1 can still run".

**Incident procedures that outlive the cutover** (condition **C54**)
- 🔴 **A wrongly auto-closed loan (state `3`) cannot be re-opened through the API** — D31 was
  withdrawn, operator declined. The repair is a **direct database edit**, and it is a
  *deliberate, recorded* procedure, not improvisation: it is written in
  **`docs/phase-4-deviations.md` §2.10** — what to check first, why there is no forensic
  signature (no `closed_at`, no state audit, and 336 of 345 PAID_OUT loans carry a positive
  `capital_balance` because omission from the next file *is* the normal payoff path), why
  `3 → 0` is closed and not revisitable, and what **D33**'s self-heal will and will not do to
  the reminders afterwards. Read it before touching a row. Also in §9's runbook item 6.

**v1 defects deliberately carried into v2 — re-decide once at cutover, or never** (**C49**)

Each of these is a v1 behaviour v2 reproduces *on purpose*, under §4 rule 2 ("do not modernise
v1's status choices"). None is a bug in v2, and none has been re-decided since the phase that
ported it. Cutover is the single moment they get one deliberate re-decision, rather than
surviving forever by silence:

1. 🔴 **P4-D4 — `?page=`, `?page=abc` and `?state=abc` are 500s on `GET /api/loan`**, reachable
   from any client's query string. `LoanView.get` calls `int()` unguarded where `UserView.get`
   guards on presence; the asymmetry is v1's. No side effect, no write, no information leak —
   one confusing log line and a 500 where a 400 belongs. **First on this list because it is the
   only one a client can trigger by accident.** Changing it is a new deviation needing an
   operator.
2. **P4-D2** — a MEMBER sending `?all_loans=true` gets a silent no-op, with a 200 and no
   indication the parameter was ignored.
3. **P4-D5** — on `POST /api/loan/<id>/refinance` a malformed *body* is a 500, never a 400: the
   400 on that route means "wrong loan" and nothing else.
4. **P4-D3 / P3-D6** — v1's error rendering: the two bytes `""` for a denial or payout, and
   Django's HTML `<h1>Server Error (500)</h1>` page for anything uncaught.
5. **D8's blast radius (M2)** — an incomplete monthly file auto-closes every APPROVED loan not
   listed in it, and **D31 is withdrawn**, so the repair is a database edit (item 6 of §9's
   runbook and §2.10 of `docs/phase-4-deviations.md`).
6. **D28's withdrawal (Q31)** — a TREASURER may raise their own `available_quota` and approve
   their own loan. Accepted exposure, written at the quota gate itself.
7. **D36 (Q32)** — `GET /api/activity/<id>` returns every attached member's `identification`,
   `email` and `birthdate` to any authenticated member.
8. **`ActivityUser.EXEMPTED` is never written**, so an excused member is displayed as owing the
   fund — see the cleanup backlog below.

**Post-migration cleanup backlog** (not during the migration)
- ⚠️ **`ActivityUser.EXEMPTED` has never been used** — defined in `STATE_TYPES` since 2018 and **0 rows of 338**
  carry it, while operator **Q33** confirms `NOT_PAID` means *owes the fund*. So a member who is genuinely
  excused is displayed as owing money to **every** member, on a route **D36** keeps fund-open. This is v1's
  behaviour and **not a migration defect** — it must not be "fixed" inside a parity phase, because the fix is a
  data/product decision (start using state 2, or split "excused" from "unpaid" in the UI), not a port. Raised by
  `business-analyst` in `docs/ba-phase-5-activity-exposure.md` §6.
- `refinanced_loan` from a bare BigInteger to a real FK.
- DRF token → JWT.
- `CORS_ORIGIN_ALLOW_ALL = True` → an allowlist.
- Django pbkdf2 hashes → argon2, rehash-on-login.

**Archive v1:** keep CONTEXT.md, the Django migrations, and the test suite as the historical spec.

---

## 4. Cross-cutting parity rules

Verified in every phase's parity report, not just the phase that introduces them.

1. **Response shape.** Pagination is always `{ list, num_pages, count }`; a page beyond the
   last returns an **empty list, same envelope, HTTP 200**. **v1's *view*-level errors** are
   `{ message: "<string>" }` with v1's exact strings, in Spanish where v1 is Spanish — but
   **DRF's *framework*-level errors are `{"detail": …}`**, and that includes **405**, not just
   401/403. Two different envelopes; see `docs/phase-1-drf-auth-bodies.md`.
2. **Status codes.** v1's specific choices (`406`, `409` where a modern API would use `400`
   or `422`) are **preserved**. Do not modernize.
3. **Default deny.** Any route without an explicit role rule is denied.
4. **Money is integer whole units.** No floats on a money path. Rounding uses the Phase 0
   half-even helper.
5. **Timestamps.** `auto_now` / `auto_now_add` are application-set in v1, not DB defaults — v2
   must set them. ✅ **RESOLVED (v0.14) — the answer is Bogotá, and it was worth checking.**
   Django 2.2's `DateTimeField.pre_save` uses `timezone.now()` (a tz-aware instant), while
   **`DateField.pre_save` uses `datetime.date.today()`** — process-local, ignoring
   `settings.TIME_ZONE`. v0.12 inferred from that "so v1 probably writes UTC dates". It does
   not: `django/conf/__init__.py::Settings.__init__` ends with
   `os.environ['TZ'] = self.TIME_ZONE; time.tzset()`, so Django *makes* the process zone equal
   the setting. Verified on `Django==2.2.27` / CPython 3.9 with the container `TZ` unset (host
   zone UTC) at `2026-08-31T00:09Z` = `2026-08-30 19:09` Bogotá: `date.today()` returns
   `2026-08-31` before `django.setup()` and **`2026-08-30` after it**.
   **So `UserFinance.last_modified` and `LoanDetail.from_date` hold Bogotá dates, there are no
   next-day rows to reconcile, and the escalation to `business-analyst` is withdrawn.** v2 pins
   the zone explicitly in `todayForAutoNowDateField()` (`timezone.util.ts`) rather than
   inheriting it from the host, and uses `nowInstant()` for the `DateTimeField` half.
   ⚠️ Residual, recorded rather than guessed: v1's repo has no Dockerfile (the image is built
   by an out-of-repo `entrypoint_deploy` on the EC2 host), so the base image cannot be read
   from source. The result above holds for any image shipping tzdata — `python:3.9-slim` and
   `python:3.9-alpine` both do, both verified. Strip `/usr/share/zoneinfo` and `tzset()` cannot
   resolve the zone, Django does not raise, and `date.today()` silently falls back to UTC (also
   verified). That is the only scenario in which v1's stored dates are UTC.
5b. **Money is `BigInt` in Prisma — 17 columns — and `JSON.stringify(1n)` throws.** ✅ **Settled
   (v0.14):** a BigInt serialises as a **bare JSON number**, matching DRF's
   `IntegerField.to_representation`, via Express's `json replacer`
   (`src/common/http/json-bigint.ts`, installed by an `AppModule` provider). The reflex fix
   (`BigInt.prototype.toJSON = toString`) renders `"1000"` and is **wrong**. A value outside
   ±(2^53 − 1) throws rather than rounding. Do not re-litigate per DTO in Phase 3.
5d. ⚠️ **CPython `json.dumps` is not `JSON.stringify`.** Two differences, both live on the very
   first message: CPython uses `', '` / `': '` separators, and `ensure_ascii=True` escapes
   non-ASCII. Verified: Python emits `{"body": "…de cr\u00e9dito", "target": "/loan/1"}` where
   Node emits `{"body":"…de crédito","target":"/loan/1"}`. **Every** v1 notification body is
   accented Spanish, so this is not an edge case. Use `python-json-dumps.ts` (Phase 2) anywhere a
   payload must match v1 byte-for-byte — **Phase 7 publishes through the same path.** Same species
   as rules 5b and 5c: a plausible-looking standard-library equivalence that is not one.
5c. **Date formatting is not uniform in v1 — do not assume it is.** `LoanSerializer.get_created_at`
   calls `timezone.localtime` first (`serializers.py:88`); `UserFinanceSerializer.get_last_modified`
   does not (`:29`). A `formatDateEs()` that silently reads a `DateTime` as UTC is correct for
   `@db.Date` and wrong for `timestamptz`, and the type system does not distinguish them — so it
   yields the **next day's date for ~21% of every day**, passing in CI and failing in production
   against the byte-identical email criteria. ✅ **Done (v0.14):** `formatDateEs` accepts only a
   `PlainDate`, and the call site must choose `fromDateColumn(v)` (`@db.Date`) or
   `toBogotaDate(v)` (`timestamptz`). A `Date` is a compile error.
6. **Shared DB is a dev/parity concern only** (production is a hard switch). During parity
   testing v2 runs **no** schema migrations, and only one scheduler runs at a time.
7. **hstore values are strings.** Never write a native JSON object into an hstore column —
   until Phase 9 converts them.
8. **Side effects count as parity.** A phase passes only when DB rows, SES payloads, SQS
   messages, and `SchedulerTask` rows all match — not just the HTTP response.
9. **Idempotent under retry** where v1 was: subscription dedupe, blob-exists check, scheduler
   same-day dedupe.
10. ⚠️ **Django's `on_delete=CASCADE` is Python-side, not a DB cascade.** Verified: all 21 FKs in
    `fondodev` are `NO ACTION`. Reading `models.py` strongly suggests the opposite. **Phases 3–8
    must delete children explicitly inside the transaction** or hard deletes raise FK violations.
    The live case is `DELETE /api/activity/<id>` (Phase 5), which must remove `ActivityUser` rows
    first. Most other v1 deletes are soft (`is_active = false`), which masks this.
12c. ⚠️ **Files come from `request.files`, scalars from `request.body` — never merged.** DRF's
   `request.data` is a `QueryDict` **merged with** `FILES`, and that merge is the exact mechanism
   of **D23** (a scalar sent as a part with a `filename` is stringified to the filename). Do not
   implement the merge to "match v1". ⚠️ **But v1's `LoanView.patch` (Phase 4) and
   `FileView.post` (Phase 8) read `obj['file']` and only work *because* of it** — those handlers
   must read from `request.files` explicitly. Getting this wrong in Phase 4 breaks the bulk loan
   upload; getting it wrong the other way re-implements D23.
   ⚠️ **Phase 8 addition:** a handler whose v1 code tests `key in request.data` observes the
   merge's *precedence* (a file part beats a body key of the same name). `common/http/drf-request-data.ts`
   reproduces that precedence without merging values — one caller at Phase 8's commit, `FileView.post`.
   And two parts with the same name resolve to the **last** (`MultiValueDict.__getitem__`); see P8-F5.
12b. ⚠️ **`@parser_classes(...)` on an `APIView` *method* is a no-op** — found in Phase 3 by
    probing the live v1, and it affects three handlers across three phases.
    `rest_framework.decorators.parser_classes` is written for **function**-based views: it sets
    the attribute on the decorated callable, and `APIView.dispatch` reads `self.parser_classes`
    from the **class**. So `UserView.patch` (`views/user.py:36`, Phase 3), `LoanView.patch`
    (`views/loan.py:49`, Phase 4) and `FileView.post` (`views/file.py:15`, Phase 8) all accept
    the **default** parser list, JSON included. Measured: `PATCH /api/user` with
    `application/json` is a **500** in v1 (the body parses to `{}` and `obj['file']` raises
    `KeyError`), not the 415 the decorator implies; `text/plain` is a 415 because it is outside
    the *default* list too. **Do not "restore" the narrowing in Phase 4 or 8.**

12. ⚠️ **Nest 404s where DRF 405s.** Django resolves the URL and *then* DRF raises
    `MethodNotAllowed`; Express has no route for an unmapped method at all. **Every controller in
    Phases 3–8 needs an `@All()` fallback** (`DrfException.methodNotAllowed()` is the reusable
    piece) or it will 404 where v1 405s. Note the `Allow` header lists *implemented* handlers — a
    different set from *permitted* ones.
    ⚠️ **Third clause, added v1.4 after finding F1:** `OPTIONS` is one of those methods, and on a
    DRF API it is **authenticated and permission-checked** like any other (rule 13). Express-side
    CORS helpers answer it in middleware — `app.enableCors()` answered *every* `OPTIONS` with a
    204 before the router, the guards and the `@All()` fallback, i.e. it silently disabled
    authentication on that verb. Only a **genuine preflight** (`Access-Control-Request-Method`
    present) may short-circuit. See `DjangoCorsMiddleware`.
    ⚠️ **And a corollary:** anything that shapes a response must be registered in `AppModule`,
    **never in `main.ts`** — every e2e suite builds the app from `AppModule`, so `main.ts` is
    unexercised. F1 lived behind a green test asserting the very behaviour it broke.
13. **`OPTIONS` is a real, authenticated, permission-checked method.** On a **guarded** view it
    is always a **403**: `list_permissions` has no `OPTIONS` key for any of the 14 views, so
    `APIRolePermission`'s bare `except` denies it for every role, ADMIN included. On the two
    views that clear `permission_classes` (`ObtainAuthToken`, `UserActivateView`) it reaches
    `APIView.options()` and returns `SimpleMetadata`'s four-key document — 164 and 172 bytes,
    reproduced verbatim in `src/common/http/drf-metadata.ts` (parity finding **F4**;
    deviation P1-D2 withdrawn). Authentication still runs first, so a broken token 401s there
    too. What v2 does **not** ship is the browsable API's HTML rendering under
    `Accept: text/html` — registered as **P3-D8**.
14. ⚠️ **v1's URL conf is part of the contract, and Express cannot express it.** Django resolves
    an ordered list of **anchored, case-sensitive** regexes *before* authentication; Express
    matches case-insensitively, non-strictly, and (since v5) without inline parameter patterns.
    v1's table is transcribed in `src/common/http/django-url-conf.ts` and enforced by
    `DjangoUrlResolverMiddleware` ahead of the guards. It is **fail-closed**: a path absent
    from the table cannot reach a controller.

    ⚠️ **Testing this layer requires a raw-socket transport (C27 / review S8).** supertest
    re-serialises the request target before it writes the request line, and its rewrites are
    exactly the transformations these cells assert: it strips fragments, collapses `.` and
    `..` segments, turns `\` into `/`, percent-encodes spaces, and cannot forge a `Host:` at
    all. **Every cell whose subject is the request target — URL conf, `APPEND_SLASH`,
    `PATH_INFO` decoding, `Location`, `ALLOWED_HOSTS` — must use `rawRequest` /
    `rawRequestFor` from `test/support/raw-request.ts`**, whose own fidelity is pinned by
    `test/raw-request.harness.e2e-spec.ts`. A URL cell written in supertest asserts against a
    rewritten target and passes for the wrong reason; that was false-green #1 (N4).

    ⚠️ **Two sub-rules the round-2 parity run added, both cheap to reintroduce by accident:**

    * **The URL layer is two middlewares, at two depths.** `CommonMiddleware`'s `APPEND_SLASH`
      301 is 3rd in v1's `MIDDLEWARE`, *above* `corsheaders`; URL **resolution** happens in
      `BaseHandler`, *below* all eight. So a genuine preflight is a **301** on `/password_reset`
      and a **200** on `/nope/nope`. `DjangoAppendSlashMiddleware` (above
      `DjangoCorsMiddleware`) and `DjangoUrlResolverMiddleware` (below it) are that split;
      `AppModule.configure` carries v1's whole `MIDDLEWARE` list as a table and must keep it
      (finding N1).
    * **Django dispatches on the decoded `PATH_INFO`, Express on the raw target.** The resolver
      rewrites `req.url` to `escape_uri_path(PATH_INFO)` once the table has matched, so
      `POST /api%2Dtoken%2Dauth` reaches its controller as it does in v1 (finding N3). This
      requires the middleware to be mounted at `/`: under a wildcard mount Express trims and
      re-prepends the matched prefix, splicing the rewrite onto the raw path. Redirect
      `Location`s follow the same rule — `escape_uri_path(decoded)` + `iri_to_uri(query)`,
      never the request target (finding N2, `django-uri-encoding.ts`). **Adding a route in any phase means adding its v1 pattern**; a v2-only route
    (`/health`) is an explicit entry. This replaces the trailing-slash "rule" S7 asked for —
    v1 has no rule, only an inconsistent table (`^api/loan/?$` but `^api/loan/(?P<id>[0-9]+)$`,
    with `^api/activity/(?P<id>[0-9]+)/?$` the lone exception), so it is transcribed, not
    summarised.

    📋 **The full "adding a route" checklist is `docs/adding-a-route.md`** (review condition
    **C36**) — the URL-conf entry and its trailing `/?`, `@V1View`, the permission-matrix row
    and its default-deny, the `@All()` fallback and its `Allow` string, `@DrfNoRequestData()`,
    `readUploadedFile` plus rule 12c's no-merge and rule 12b's "do not narrow the parsers",
    and `DrfViewHeaders.renderers`. Each item carries a one-line why and a pointer to a
    working example. **Phases 4–8 start there.**

11. ⚠️ **All 21 FKs are `DEFERRABLE INITIALLY DEFERRED`** and Prisma cannot express it; the
    baseline SQL is hand-patched. Keep the patch on any future baseline regeneration — without it
    CI databases enforce FKs at statement time while production enforces at commit, so multi-table
    writes that pass locally fail in CI (or vice versa).

15. ⚠️ **A universal claim must name the check that enforces it, or be written as a measurement.**
    Any sentence in `src/`, a spec, `docs/` or this plan that says *every / all / cannot / never /
    impossible / unreachable / closed / gone* about the code either cites something that runs in
    CI and fails — a test, a lint rule, a script with an exit code — or is rewritten as an
    existential: *"measured N forms at rev X"*. This is a mechanical rewrite, not a judgement call.
    Six of the seven claims `nestjs-reviewer` listed in Phase 6's re-check #5 were this one error
    with different nouns: *"a fresh raw `Date.UTC` reports exactly one error"* (fires ≠ closed),
    *"the two hand-rolled ports are gone"* (there were three), *"both runbook sites corrected"*
    (three), *"8 of 8 caught"* (a plant set), *"not behaviourally observable"* (one mutant),
    *"cannot disagree"* (one revision). Each cost a review round to re-learn.

    **15b. When you pin a table, assert its shape in the same commit.** The invariant only one
    consumer of a data structure depends on is the one that breaks: `PYTHON_DECIMAL_DIGIT_RANGES`
    feeds an order-blind character class *and* an order-dependent binary search, its ordering was
    prose in four places, and a range appended out of order widened the class alone with the
    whole suite green. `python-str.fixture.spec.ts` now checks the shape of both pinned tables and
    sweeps class-vs-fold agreement over all 1,114,112 code points (Major 9).

---

## 5. Deliberate deviations from v1 (the port-or-fix register)

> ⚠️ **§3 describes v1. §5 decides what v2 does. Where they disagree, §5 wins — by construction,
> because a registered deviation *is* a decision to diverge from the behaviour §3 documents.**
> A v1 unit test asserting the §3 behaviour is therefore not evidence for keeping it: under a
> deviation it becomes a **moved expectation**. This bit us on **D4** in Phase 4 — §3's "silently
> clamped to 36", v1's `test_post_loan_5`, and a paraphrase in my own dispatch brief all agreed
> with each other *against* operator **Q9**'s decided `400`. Two descriptions of v1 and a v1 test
> will always agree; that agreement carries no information about what v2 should do. **Check §5 and
> §9 before implementing anything §3 describes.**

**Why this section exists.** The parity contract in §4 says v1's behavior is the spec. Taken
literally that is wrong: the business-analyst review found authorization holes in v1 that a
faithful port would carry into a fresh codebase and re-bless as "correct". Every knowing
departure from v1 is registered here so that `manual-tester` reads a diff as **expected**, not
as a parity failure — an unregistered diff is still a failure.

**Each row needs a user decision before its phase can close.** My recommendation is in the last
column; none of these are mine to decide unilaterally, because each changes product behavior.

| # | v1 behavior | Change in v2 | Phase | Status |
|---|---|---|---|---|
| **D1** | `PATCH /api/user/<id>` is role ≤ 3 with **no ownership check**, and `__update_user_personal` writes `user.role` from the request body (`services/user.py:232`) — any member can make themselves ADMIN or set their own `total_quota`. | **Restrict** (Q15, Q25, Q25a). Rule below. | P1 decide / P3 implement | ✅ **Decided — fix** |
| **D2** | Approving a power request has no check that the caller is the requestee. | **Restrict** to the requestee (Q17). | P3 | ✅ **Decided — fix** |
| ~~**D3**~~ | ~~`SavingAccountView.PUT` is `[0,2]` with no ownership check; PRESIDENT uniquely excluded.~~ | **Withdrawn — v1 is correct.** Only ADMIN and TREASURER may act on CAPs and they legitimately manage any member's (Q22), so no ownership check is wanted; the PRESIDENT exclusion is **deliberate** (Q23). Port v1 unchanged. | P6 | ✅ **Withdrawn** |
| **D4** | `timelimit > 36` silently clamped to 36; `timelimit = 0` accepted, then `DivisionByZero` at approval. | **Reject with `400`** (Q9) — both bounds. Enforce `1 ≤ timelimit ≤ 36`; no silent clamp. | P4 | ✅ **Decided — fix** |
| **D5** | Power-approval email puts every member in `ToAddresses` with empty `Bcc`. | **Move to `Bcc`** (Q18). Recipient list stays every member (Q10) — only the disclosure is fixed. | P3 | ✅ **Decided — fix** |
| **D6** | `LoanDetail.loan` is a plain FK; re-approving a closed loan creates a second row and 500s that loan permanently. | Unique `loan_id`, upsert not insert. Now **belt-and-braces** behind D10, which blocks the transition at the source. | P4 | ✅ **Decided — fix** |
| **D7** | A payment reminder whose `run_date` has passed is **never sent** — the 5-day reminder is skipped entirely whenever the monthly file lands within 5 days of the deadline. | **Send immediately** on the next scheduler run instead of skipping (Q8). ✅ **Implemented in 7b** as `(run_date AT TIME ZONE 'America/Bogota')::date <= today`. ⚠️ **Blast radius, measured, not estimated — see P7-D1 in `docs/phase-7b-deviations.md` §4:** "has passed" and "was never picked up because v1 could not" are the same database state, and `fondodev` holds **110** rows due under `<=`, the oldest from **2020-09-27**, **65** of them payment reminders for loans already `PAID_OUT`. The first enabled run would publish ~108 stale pushes. **A drain step belongs in Phase 9's cutover runbook, between "deploy v2" and "enable the scheduler"** — escalated to `business-analyst` as an operator question. | P7 | ✅ **Decided — change**; ⚠️ **backlog question open** |
| **D8** | Bulk loan upload returns a bare `200` with no body. | **Return the list of auto-closed loans.** No cap on how many may be closed (Q3). ⚠️ Response-shape change — `manual-tester` must expect it. | P4 | ✅ **Decided — change** |
| **D9** | Re-approving an already-approved or closed loan is allowed and corrupts the record. | **Enforce legal state transitions** `0→1`, `0→2`, `1→3`, `1→2`; reject anything else (Q14). ⚠️ **Known asymmetry under concurrency (C51):** the transition write is a compare-and-set, so the loser of a race gets D9's 409 — which is the sequential answer for five of the six race pairs and **not** for `0→1` winning against a `0→2` loser, where sequential execution gives a **200** (from state `1`, `1→2` is legal). Registered and pinned by a unit cell, not fixed: the bounded re-read-and-retry that would close it changes behaviour on the money path. §5.1 of `docs/phase-4-deviations.md`. | P4 | ✅ **Decided — fix** |
| **D19** | `__create_birthdate_notification` (`services/user.py:269`) calls `.replace(year=today_year)` on the stored birthdate. `date(2000,2,29).replace(year=2026)` raises `ValueError`; `UserDetailView.patch` has no handler, so it **500s and `transaction.atomic()` rolls the whole edit back**. Checked 2026-08-31: **0 of 15 members have a 29 Feb birthdate**, so this is **latent** — it fires the day one is enrolled. | Clamp to 28 Feb or 1 Mar — decide which, then handle it deliberately. | P3 | ✅ **Fixed (P3)** — clamped to **28 Feb**, because `relativedelta(years=+1)` (and therefore Phase 7's own yearly clone of this task) puts it there; 1 Mar would leave the first notification a day after every repeat of itself. |
| **D21** | gunicorn 19.9.0's WSGI writer emits the **full entity body on a `HEAD` request** — verified on a raw socket on 11/11 routes, DRF and plain-Django alike, including the 404 handler. RFC 9110 §9.3.2 says a `HEAD` response MUST NOT have content, so **v1 is the non-conformant side**, and the cause is the WSGI server, not any application code. | Node's HTTP server suppresses the body. **Status is identical on 11/11 routes; `Content-Length` on 10 of 11** — the exception is the 404 handler (77 vs 23 bytes), which is **D13** — the only difference is the bytes after the headers, which every conforming client and every intermediary discards. | cross-cutting (all phases) | ✅ **Accepted — register, do not reproduce.** No fund client issues `HEAD`; reproducing it means making Node emit bytes it deliberately suppresses, to re-create a server-level RFC violation with no beneficiary. Parity finding **F9**. |
| **D22** | A **non-ASCII `boundary`** is an **uncaught 500** (**on the three POST endpoints**: gunicorn's 141-byte page, no `Allow`, no `Vary`, no `X-Frame-Options` (C86) — that page is a *double fault* via `log_response` → `get_post_parameters`. **`PATCH /api/user` differs**: Django's **27-byte** page **with `Vary: Origin`**, because Django populates `POST` only for `POST` — which is also why D24's bare-`except` scoping is correct): `MultiPartParser.__init__` does `content_type.encode('ascii')` at `multipartparser.py:69` *before* validating the boundary at `:72`, so a `UnicodeEncodeError` — not a `MultiPartParserError` — escapes DRF's exception handler. 49 cells across `/api-token-auth`, `PATCH /api/user`, `POST /api/user/activate/<id>`, `POST /api/user/power`. | **400** with DRF's parse-error detail, the same answer v2 gives for every other invalid boundary. Every **valid** boundary shape is unchanged and byte-identical (16/16, including the 201/202 length off-by-one). | cross-cutting — P3, and **P4 bulk loan upload / P8 file upload** | ✅ **Accepted — register, do not reproduce.** The request is malformed and refused on both stacks with **zero rows written on either**; only the shape of the refusal differs. No client can emit a non-ASCII boundary (the HTTP stack generates it, not the fund's code), so no member- or treasurer-facing process is affected. Reproducing it means writing a deliberately uncaught exception into v2 and alerting on it forever. **This row covers every multipart endpoint in Phases 4–8 — `manual-tester` must not re-file it there.** Parity finding **F10**. ⚠️ **Phase 8 note (C79):** on `POST /api/file` v1 answers **every** invalid boundary with **500** (the view's `except Exception`, then gunicorn's double-fault page), so this row's rationale — *the same answer v2 gives for every other invalid boundary* — does not hold there. Applied as written, it yields **v1 500 / v2 400** for a non-ASCII boundary while empty and quoted trailing-space boundaries stay 500/500. ⚠️ **Ruled by `nestjs-reviewer` 2026-09-14 (C79): D22 does not apply to `POST /api/file`.** Both of its reasons fail there — the invalid boundaries measured on that route (empty, quoted trailing space) are already 500 on both stacks, and reproducing v1's 500 costs nothing because the empty-boundary path already does it — so v2 answers **500 like v1** for a non-ASCII boundary too. ✅ **Implemented at `8948f79`; re-measured 500/500 by `manual-tester` (`1750256`).** Measured on that route: empty, quoted trailing space and non-ASCII boundaries 500/500; an **unquoted** trailing space is a valid boundary, **201/201**; a too-long boundary is **not measured**. ⚠️ *(v4.24: an earlier wording here said "every other invalid boundary" and "trailing-space boundaries stay 500/500" — neither was measured as stated.)* On `PATCH /api/user` (27-byte Django page), `X-Frame-Options` is unmeasured and very likely equal on both stacks. |
| **D23** | DRF's `request.data` is `QueryDict` **merged with** `FILES`, so a **scalar field sent as a part carrying a non-empty `filename`** is read as an `UploadedFile`. `create_user` reads `obj['first_name']` with no serializer (`services/user.py:31`) and Django's `CharField` stringifies the file to its **filename** — so `POST /api/user` with `first_name` as a part named `a.txt` is **201**, creates a member whose first name is `a.txt`, and **sends them the activation email**. Verified live: `auth_user` 15 → 16. | **No merge.** Files are read from `request.files`, scalar fields from `request.body`. A scalar sent as a file part is therefore *absent*, and `create_user` 500s with **no row** — which is v1's own behaviour for an absent required field (no serializer, no `KeyError` handler). The **empty-`filename`** rule (Django treats it as an ordinary field) **is** ported, and the treasurer's real TSV upload is byte-identical on both stacks. | cross-cutting — P3, and **P4 bulk loan upload / P8 file upload** | ✅ **Accepted — register, do not reproduce.** `first_name` is not an inert column: it is the activation-email greeting, the name in the fund-wide power-of-attorney letter, the birthday-notification body, and the member list. v1's row emails the fund and is repairable only by another ADMIN `PATCH`. `POST /api/user` is ADMIN-only and **no live row was ever created this way** (all 15 names are real). Implementing DRF's merge would implement the defect on purpose. **`readUploadedFile` reading `request.files` is the standing pattern for P4 and P8** — see §4 rule 12c. Parity finding **F11**. |
| **D24** | On the one Phase 3 view with a bare `except Exception` around a `request.data` read (`UserAppsView`), a `MultiPartParserError` is caught and answered as a DRF 500 — but Django's `log_response` then calls `get_post_parameters`, which re-reads `request.POST` and **re-triggers the same parser failure outside Django's exception handling**. The request never produces a Django response: gunicorn's 141-byte page is served with **none of Django's response-middleware headers — no `Allow`, no `Vary`, no `X-Frame-Options`** (the last widened 2026-09-14, C86: measured on that page at `POST /api/file`, inferred from code here), where the same view's other 500s carry them. Fires for the six boundary shapes v1 rejects × 12 bodies = 72 cells on `POST /api/user/power`. | The DRF caught-500 shape with `Allow: POST, OPTIONS` and `Vary: Accept, Origin` — i.e. the behaviour **F1 was fixed to produce**. Status is identical to v1 on all 208 malformed-multipart cells; only the header set on these six shapes differs. | cross-cutting — P3, and any later view with a bare `except` around a body read | ✅ **Accepted — register, do not reproduce.** `Allow`/`Vary` on an unparseable-request 500 are read by no client, and the trigger is unreachable from the fund's client. Reproducing it means porting Django's *error logger re-entering the failing parser* — a double fault that also hides the original traceback — and would partially un-fix **F1**. Residual of the **F1 / P3-D6** axis. Parity finding **F12**. |
| **D25** | `GET /api/user/<id>` is role ≤ 3 with **no ownership check** (`permissions.py:13-17`, `views/user.py:43-50`), so any member reads any other member's full `finance` block — including **`utilized_quota`** (their aggregate outstanding debt) and `total_savingaccounts` (their CAP deposits, computed in `serializers.py:32-35`). v1 hard-filters the *loan list* by role (`views/loan.py:33-41`) and returns **no** finance on the *user list* (`services/user.py:60-70`), so this by-id route is the only unscoped path to another member's money position — v1 is inconsistent with itself. | **Restrict** to the record's owner plus roles `[0,1,2]` — the **same predicate and roles as D10**. `GET /api/user/-1` is unaffected (owner branch). Profile-only lookup keeps working through the unrestricted list and `POST /api/user/birthdates`. | **P4 — must land in the same phase as D10** | ✅ **Decided — fix.** Operator **Q29a**: no client screen lets a member read another member's detail, so nothing breaks and **D10 is not reopened**. |
| **D26** | Nothing forbids `requester === requestee` on a power request (`services/user.py:165-192`). `requester` is always the caller, so no member can give away another's vote — but a member acting **alone**, with no second party's consent (which every other power requires under D2), can create then approve a power naming themselves and make the fund emit the formal power-of-attorney letter on **Fondo Montañez letterhead, addressed to the president of the assembly**, to all 15 members (blind-copied under D5). The document transfers no vote, so this is document emission, not vote manufacture. **Live 2026-09-03: 0 of 20 rows are self-directed** across six assemblies — verified. | **Refuse at creation** with **406**, matching v1's house style for a business-rule refusal on a create (`create_loan`). Refused at creation, not approval, so no row and no self-addressed push notification are produced. ⚠️ **No `(requester, meeting_date)` uniqueness rule is added.** | P4 | ✅ **Decided — fix.** Operator **Q30a**: a second request **superseding** the first is the fund's real idiom (live: member 14, rows 18 and 20, assembly 2026-01-31), so self-naming is *not* a revocation workaround and blocking it removes nothing in use. A uniqueness rule **would** break the idiom. |
| **D27** | `handle_power_request` writes `power.state` unconditionally and mails on `state == 1` (`services/user.py:193-206`), so **re-approving an already-approved power re-sends the fund-wide letter**, unbounded. Same defect class as D9 for loans; guarded in neither v1 nor the P3 port. | **Enforce legal transitions** `0 → 1` and `0 → 2`; any other transition is **409** with **no mail**. Mirrors **D9** (Q14) exactly. Re-sending a lost letter becomes an ops task, not an API state write. | P4 | ✅ **Decided — fix.** Needed no operator input. |
| **D29** | `create_loan` compares **before** coercing: `if obj['value'] > user_finance.available_quota` (`services/loan.py:27`) with `available_quota` a `BigIntegerField`. A JSON **string** `value` therefore raises `TypeError: '>' not supported between instances of 'str' and 'int'` — a **500 before any write**. Verified on both stacks: `"1000"`, `" 1000 "`, `"+1000"`, `"-1000"` are v1 500 / v2 201+row; `"30000001"` is v1 500 / v2 **406**. ⚠️ Same root cause on the **quota boundary**: v1 compares raw then coerces, so `value: 30000000.5` against a 30 000 000 quota is **406 on v1, 201 on v2**. | **Keep v2's coercion** — accepted improvement. v1's refusal is a crash, not a rule: the same string *stores* fine (`BigIntegerField.get_prep_value` is `int()`), `timelimit` is explicitly coerced on the very next line, and this is the **only** raw ordering comparison in v1's entire service layer (BA grepped every `obj[...]` comparison in `fondo_api/services/`). Porting it means writing a deliberate `TypeError` into v2. v2 gives the member the fund's real answer instead of a crash. A strict 400 was considered and rejected: `value` would become the only integer column in v2 with a non-Django contract while `fee`, `payment`, `disbursement_value`, `identification` and `total_quota` all coerce. ⚠️ **The *ordering* is a separate half and the operator decided it the other way: exact parity.** v2 now compares the **raw** value and coerces only for the write, via a new `pythonGreaterThan` beside Phase 3's `pythonNotEqual` — the sequencing `updateUserFinance` (`src/users/user.service.ts:777-781`) already used. So the fractional window is closed: `quota + 0.5` is **406 on both**. | P4 | ✅ **Decided — implemented, in two halves.** (a) **String leniency accepted** (v1's `TypeError` is a crash, not a rule): `"100"` is a 201, `"600"` the fund's real 406. Not a live defect — **277 direct creates by 13 distinct members, 2018 → 2026-08-10**, impossible if the client sent strings. (b) **Boundary ordering: exact parity**, at the operator's choice over accepting the sub-peso gap. ⚠️ The cell was **measured, not assumed**, as this row demanded: against the unfixed code, quota 500 + `value: 500.5` gave **201 with `value` stored as `500`** — v2 was not merely accepting where v1 refuses, it was writing a *different number*. Now 406, pinned in both suites. |
| **D30** | Nothing in v1 **or** v2 requires a loan `value` to be positive. As plain JSON *numbers*, `0` and `-1000` are accepted and written by **both** stacks. | **Add a lower bound at create.** Needs its own row precisely *because* v1 and v2 currently agree — without it the new 400 reads as a Phase 4 regression rather than a decision. Honestly scoped: **0 of 425** live rows have `value <= 0`, and the three smallest (ids 132, 198 at `1`; id 109 at `500`, all member 11) were **DENIED by hand**, so a floor of 1 would have caught none of them. | P4 | ✅ **Decided — implemented.** Operator: the fund has **no minimum loan amount**, so the floor is `value >= 1` as cheap insurance and nothing more. **400** `{"message": "Loan value must be greater than 0"}`, checked on the coerced value (so `0.5` → `0` is caught) after the quota gate (so an over-quota request is still v1's 406), and binding on the refinance path too. ⚠️ **This is v2 *diverging* from v1 by decision, not repairing a divergence** — both stacks accept `0` and `-1000` as plain JSON numbers today, so the cells and `docs/phase-4-deviations.md` §4.1 say "v1 accepts this, v2 refuses it by decision" in as many words, to stop a future parity round filing it as a regression. A stated fund minimum would replace `MIN_LOAN_VALUE`. ✅ **BA confirms the refinance binding needs no carve-out**: the fund would never refinance a fully-paid loan, and live data shows **148 refinances, smallest `value` 187 584**, with no APPROVED loan at `capital_balance <= 0`. 🔸 **Nit — owner `business-analyst`, phase P9** (**C52**): the message `"Loan value must be greater than 0"` reads as nonsense on the refinance route, where the caller sent a **loan id** and never a value. Changing it is a client-visible string change on a money path, so it belongs with the Phase 9 client-change runbook and needs the operator, not a tidy-up in a parity phase. "A later pass" was not an owner. |
| **D42** | **CPython's `int()` is not a decimal-digit parser — it accepts any code point its Unicode database calls a decimal digit, and PEP 515 underscores.** `PyLong_FromUnicodeObject` runs `_PyUnicode_TransformDecimalAndSpaceToASCII` first, folding every code point with a non-negative `Py_UNICODE_TODECIMAL` onto the matching ASCII digit; then the literal grammar allows a single `_` **between** digits. Measured: `int('１')` (U+FF11) `== 1`, `int('١') == 1`, `int('۱') == 1`, `int('1_0') == 10`. ⚠️ **Digits and spaces only** — `int('＋1')` (fullwidth plus) is still a `ValueError`, so the sign must be ASCII. | **Reproduced**, by `parsePythonIntLiteral`, shared by `pythonInt` (query strings) and `toDjangoInt`/`toDjangoSmallInt` (bodies). ⚠️ **Not with `/\p{Nd}/u`, and that is the load-bearing part**: CPython 3.9.25 is on **UCD 13.0.0** (650 code points), Node 24 on **UCD 17.0** (770), so a property test would accept **120 code points v1 refuses** — every digit block assigned since 2020 — turning a v1 `ValueError` (a 500) into a v2 success. The set is **captured from the pinned interpreter** (`PYTHON_DECIMAL_DIGIT_RANGES`, `scripts/gen-python-str-fixture.py`), like `PYTHON_NONPRINTABLE_RANGES` before it and for the same reason. Do not "simplify" it to a property test. ⚠️ **Fourth axis, added on re-check:** Django's `dateparse.date_re` is compiled from a `str` pattern with **no `re.ASCII`**, so its `\d` matches any `Nd` code point and `parse_date`'s `int()` then folds it — `date_re.match('٢٠١٨-٠١-٠١')` → `date(2018, 1, 1)` on the pinned interpreter. `toDjangoDate` therefore folds too. ⚠️ **It does NOT stop there, and recording that it did was worse than the original defect.** I measured *one* string — `strptime('٢٠١٨-٠١-٠١')` raises — and generalised it into "the `strptime` ports keep ASCII-only `\d`", which cells and this row then asserted as settled. `nestjs-reviewer` dumped the generated pattern: **`_strptime` is not one parser, it is a per-directive pattern**, `(?P<Y>\d\d\d\d)-(?P<m>1[0-2]|0[1-9]|[1-9])-(?P<d>3[0-1]|[1-2]\d|0[1-9]|[1-9]| [1-9])`. **`%Y` is Unicode-aware and folded; `%m` is ASCII in every branch; `%d` is ASCII in its first character and Unicode-aware in `[1-2]\d`'s second, plus a space-padded ` [1-9]` branch.** The fully-Arabic string fails **because of the month**. **Seven** measured inputs were v1-accepts / v2-refuses, two on write paths (`PATCH /api/user`, loan refinance). Closed by `parseStrptimeIsoDate`, which mirrors the generated pattern instead of approximating it; an 11-row measured matrix pins both directions. **A divergence a test defends is worse than one nobody noticed.** | **P3** (first ported the helper) / surfaced by **P6** | ✅ **Closed 2026-09-08** (`6a859d0`). ⚠️ **It was live through a review, a phase and a parity round** because `pythonInt`'s docblock claimed it *"reproduces CPython's `int()`"* when **C63 had closed the whitespace axis only** — the docblock now **enumerates the axes it was validated on** (§4's new rule). Blast radius was wider than the query strings it was found on: `toDjangoInt` shares the grammar, so `PUT {"value": "1_0"}` was a v1 **write of 10** against a v2 500, on every integer body field in Phases 3–6. Mutation-controlled three ways (no-fold **6** failures, no-PEP-515 **6**, `\p{Nd}` **4** — ⚠️ **I first recorded 9 and it was not reproducible.** `nestjs-reviewer` re-ran it and got 3; the honest number today is **4**, and ⚠️ **my account of how it moved was also wrong.** I said the write-side assertion (Minor 5) and a new `toDjangoDate` drift cell each contributed. Under the mutant `pythonInt` already throws, so the **first** assertion in each drift cell fails and the cell fails once — **Minor 5 contributed 0**; it strengthened cells the mutant already broke. **3 + 1 = 4, and the 1 is the `toDjangoDate` drift cell alone.** Same species as the original error: a count attributed to a mechanism that did not produce it, which is why a count needs its **mutant named and its delta attributed**. **The mutant must be named or the count means nothing**: it is `pythonDecimalDigitValue` falling back to Node's `\p{Nd}` with run-start value derivation on a table miss. My original mutant returned `0` for *every* `Nd` including ASCII digits, which conflates the fold axis with the digit-set axis and is not a control on either), plus cells on Phase 4's already-gated `/api/loan`. |
| **D43** | **`datetime.date` accepts years 1–9999 verbatim and refuses everything else** — `datetime.date(0,1,1)` raises `ValueError: year must be in 1..9999, not 0`, which Django's `DateField.to_python` turns into `ValidationError('invalid_date')`. Django's `parse_date` regex takes four digits, so `'0000-01-01'` and `'0050-06-15'` both reach `datetime.date`. | **Reproduced**, in two halves. (a) `toDjangoDate` now enforces `1 <= year <= 9999`. (b) ⚠️ **ECMAScript's `Date.UTC` maps a `year` argument in `[0, 99]` to `1900 + year`** (`MakeFullYear`) and `datetime.date` does not — so every `Date.UTC` call that can see a caller-supplied year goes through `utcMillisFromParts`, which constructs and then calls `setUTCFullYear`. **Four sites.** An era guard was added to `partsInZone` at the same time, since it read `Number(part.value)` and would have accepted a BC year. ⚠️ **The first fix round said “four sites” and there were eight.** `nestjs-reviewer` found four more still live: **`parseBirthdate`** and **`strptimeIsoDate`** — both *reachable*, both **v1 200 / v2 500** for a two-digit year, because each builds a `Date.UTC` probe and compares `getUTCFullYear()` back against the parsed year, which the remap makes fail — plus two latent ones in `relativedelta.util.ts`. ⚠️ **The prose invariant was false the day it was written** (`date.util.ts` said *“every `Date.UTC` call in this codebase must go through here”*), which is the **M2 lesson recurring in code rather than in a runbook**. It is now an **ESLint `no-restricted-syntax` rule** banning `Date.UTC` anywhere in `src/` outside `date.util.ts` (spec files excepted, where literal four-digit fixtures are clearer) — the same claim in the only form that cannot go stale, and controlled: a fresh raw `Date.UTC` in `src/` reports exactly one error. | **P0** (the `Date.UTC` sites — `b3effab`) / **P4** (`toDjangoDate`'s missing year range — `0a8cf62`, ⚠️ *not* Phase 0; I attributed the whole row to P0 and `nestjs-reviewer` traced it) / surfaced by **P6** | ✅ **Closed 2026-09-08** (`6a859d0`). Two divergences, and **the second was worse than the one that found it**: `end_date: "0050-06-15"` was **200 on both stacks**, storing `0050-06-15` in v1 and **`1950-06-15`** in v2 with nothing logged — the row was the only witness; and `end_date: "0000-01-01"` was **v1 500 with no row against v2 200 writing one**, a *status* divergence creating a row v1 would never have created. Reached `loan.disbursement_date`, `activity.date`, `userprofile.birthdate`, `power.meeting_date`. ⚠️ **The third site is the one that would have been missed**: `zonedTimeToUtcMillis` remapped the *Bogotá-local* year 99 to 1999, making the offset correction **−1900 years** and yielding year **−1800** — which the driver rejects **after** the CAP row is committed, leaving a CAP that never auto-closes. Controls prove the trap: mutating either other site fails **1** cell and never the `0100-01-01` cell; mutating this one fails **2**, including it. `daysInMonth` is a fourth site and is **provably safe** once the range check lands (for `y` in `[1,99]`, `y % 100 != 0` and `(y+1900) % 4 == y % 4`); routed through the helper anyway. |
| **D44** | **Django coerces a `DateField` from the raw body string on assignment** — `Power.objects.create(meeting_date = request[‘meeting_date’])` (`services/user.py:165-169`) runs `get_prep_value` → `to_python` → `parse_date` (`date_re` = `(\d{4})-(\d{1,2})-(\d{1,2})$`, **Unicode-aware**, and Python’s `$` also matches before one trailing newline) → `datetime.date(...)`, which raises for an impossible calendar date or a year outside 1..9999. | **Reproduced** by routing `power.service.ts` through the shared `toDjangoDate`, which already carried every part of it. It had been a **third hand-rolled port** — a four-digit-only regex plus `split(‘-’).map(Number)` and **no calendar check at all**. | **P3** (`power.service.ts`) / surfaced by **P6**’s re-check #3 | ✅ **Closed 2026-09-08.** **Six measured divergences**, and the last three wrote a row v1 refuses **and sent the notification that follows it**: `2020-1-1`, the fully Arabic-Indic date and a trailing-newline date were v1-writes / **v2 500**; `2020-02-30` → **v2 wrote 2020-03-01**, `2020-13-01` → **2021-01-01**, `0000-01-01` → **year 0**, all v1 500-with-no-row. ⚠️ **B1, B2 and Major 5 each walked past it** because it was never spelled `strptime` and never spelled `Date.UTC` — Major 5’s own write-up claimed *the two hand-rolled ports of one builtin are gone* when there were three. ⚠️ **The one negative cell that existed could not see any of it** (a slash-separated date, rejected by both stacks). Found by `nestjs-reviewer`. Control: restoring the old body fails **exactly the 6** new cells. |
| **D45** | **DRF 3.11.2's `JSONRenderer` escapes U+2028 and U+2029** as the six-character sequences `\u2028` / `\u2029` (`renderers.py:106-109`, read in the pinned image). Measured on `GET /api/file` with a name containing them. | **v2 does not escape them** (grep of `src/` at `71cd7de`). A response containing either character differs byte-wise from v1; the parsed JSON is equal. Pinned by one e2e cell in `test/file.e2e-spec.ts`: a change to the shared `res.json` rendering fails it; changes on other rendering paths would not (corrected from an earlier "so a change cannot land silently"). | **Shared rendering** (Phase 0) / surfaced by **P8** (P8-F4) | ✅ **Registered permanently** (C80, ruled by `nestjs-reviewer` 2026-09-14). RFC 8259 allows the raw characters, and since ES2019 JSON is a subset of JavaScript, the reason for escaping them is gone; the parsed JSON is equal, and a fix would change bytes in every approved phase for no client-visible gain. **Harness rule:** when a response body contains U+2028 or U+2029, parity compares parsed JSON, not bytes. |
| **D46** | **A document name reused under the other type leaves an orphaned object** (P8-F1). `save_file` uploads before writing the row; when a row with the same exact `display_name` already exists under a different type, the row insert fails after the object is stored — 500, and a retry answers 201 with no row. | **Refused before any storage call** when a `File` row with **exactly** this `display_name` exists and its `type` differs from the request's: **409** `{"message": "A file with this name already exists with a different type"}`. Not refused: the same name under the same type (v1's overwrite is kept, Q41), and a name differing only in case under the other type (v1 creates a new row there; no orphan). The status and body are the implementer's choice, following v1's existing conflict responses; the refusal itself is the operator's decision (Q40). | **P8** | ✅ **Implemented** (`5f58b11`). ⚠️ **The predicate is not exactly the orphan case, in either direction (measured):** it also refuses `Dup X` as resultados when `Dup X` (acta) and `DUP X` (resultados) exist — v1 overwrote `DUP X`'s object with 201 and no orphan; the refusal is confirmed by the operator (**Q44**). And it does not cover two concurrent cross-type uploads, the cases Q41 keeps (a same-type row whose object is missing), or a name containing U+0000 — the concurrent case is left open by the operator (**Q45**). Reachable only by ADMIN, after the role check, so the 409 discloses nothing a member cannot already list. Mutation table (17 of 17 killed, both blind controls surviving) recorded against the committed files' hashes in `docs/phase-8-deviations.md` §5.1. |
| **D47** | **`type` is not validated** (P8-F3). v1 stores any integer, and a non-integer is a 500 from `int()`. | **Refused before any storage call** unless `type` parses as a Python integer (`pythonInt`) equal to **0** or **1**: **400** `{"message": "Type must be 0 or 1"}`. Covers non-integers, integers outside {0, 1}, and values past int4, which previously stored an object and then 500ed. Checked after v1's presence check (which keeps its bodiless 400) and before D46. The status and body are the implementer's choice, modelled on `State must be between 0 and 1`; the refusal is the operator's decision (Q42). | **P8** | ✅ **Implemented** (`5f58b11`). Measured against CPython 3.9.25 and v1 — accepted: `' 1 '`, fullwidth `１`, NBSP+`1`, `+0`, `-0`, `0_1`; refused: `1_0` (that is 10), fullwidth `＋1`, U+001C+`1`, `abc`, `-1`, `' ٣ '`, values past int4. A `type` sent as a file part is 400 where v1 answered 500 before storage (confirmed, **Q46**). Non-string values arrive only in JSON bodies, which can never upload (P8-F7); for those the implementation follows v1's own `int()`, so `1.5` and `true` pass D47 and then fail at v1's 500 — an implementer choice. |
| **D48** | **A birthdate saved after this year's birthday writes a date that has already passed** (C71). `__create_birthdate_notification` uses `replace(year=today_year)` (`services/user.py:267-282`), and any personal-profile PATCH carrying a `birthdate` key rebuilds the chain — there is no change detection. v1's exact-day selection never sends a past date, so the chain is dead until the next edit; under D7's `<=`, v2 would send it on the next pass, on the wrong day. | **Schedule the next anniversary that has not been missed** (Q47): this year's if it is after today in Bogotá, or today with a scheduler pass (10:00 or 14:00 Bogotá) still to run; otherwise next year's. D19's 29 February clamp and D20's inactive-owner guard are unchanged. The row v2 writes differs from v1's for these edits, so any Phase 3 parity pin on that row has to be re-pinned. ⚠️ **Residual, not decided by the operator:** a scheduler outage that spans a member's birthday still delivers the greeting late, saying *"hoy"* (`business-analyst` recommended accepting it). | **P8b** (the chain is written by Phase 3's user service) | ✅ **Implemented** (`5e3457a`; Phase 8b closed): next birthday not yet missed; today only strictly before 14:00:00.000 Bogotá; D19 on the chosen year; zone pinned (C89). |
| **D49** | **Birthday recipients are frozen when the chain is created.** `user_ids` is `get_users_attr("id")` minus the owner at creation, copied verbatim into every yearly clone — so members who leave keep receiving, and members who join never do (measured 2026-09-14: 11 of 14 pending chains miss a current member; 13 of 14 list someone who has left). | **Resolve recipients at send time** for birthday tasks only (Q49): every active member except the owner, computed when the greeting is sent. Payment reminders are unchanged — they go to the borrower alone and carry their own date (`docs/ba-phase-7b-c71-c72.md` §1.4). How the stored `user_ids` is treated (still written for a v1 rollback, or not) is an implementer choice to register. | **P8b** | ✅ **Implemented** (`5e3457a`; Phase 8b closed): recipients are the active members except the owner, resolved at send time; the stored `user_ids` is still written byte-identically and still parsed (C23). |
| **D41** | **Integer precision on the way IN, which no rule covers.** v2 parses request bodies with plain `JSON.parse` (`bootstrap.ts` disables Nest's parser and nothing bigint-aware is installed on the ingest path), so a JSON integer above 2^53 is already a lossy `number` before any v2 code sees it. Three distinct behaviours, measured on `PUT /api/saving-account`: at **2^53+1** v1 stores `…993` and **v2 stores `…992` — 201 on both, silently corrupted**; at **2^63−1** v1 stores it and **v2 answers 500, refusing a write v1 performs**; and a stored value above 2^53 is a v1 number and a **v2 500 on render**. | **Accepted, and now registered.** No fix: closing it needs a bigint-aware JSON parser on the ingest path, which is a cross-cutting change to every route for a case unreachable with real pesos (the fund's largest balance is ~2.6 × 10^7). ⚠️ **The render third is covered by C2 / rule 5b / `phase-0-deviations.md` §2.10 — the other two are covered by nothing**, and P6-F5 mis-cited those as authority for all three. ⚠️ **The render refusal also 500s the *ported Phase 3* `GET /api/user/<id>`** through `total_savingaccounts`: one bad CAP takes down a route that passed its own gate, written through a different route entirely. | **P3–P6** (jointly — the ingest path is shared) | ⚠️ **Registered 2026-09-08, having been observed twice and registered neither time.** `docs/parity-phase-5-delta.md` row **L2** recorded the write-side truncation during Phase 5, with the same note that the docblock frames it as a *rendering* difference; it never reached §5. Phase 6's P6-F5 then re-derived it and mis-cited the render rules again. Found by `nestjs-reviewer`. **That is the finding**: a divergence seen in two phases, written in two documents, and absent from the register that governs — which is C75's argument for why a register's value is that it is complete. |
| **D40** | **v1's pagination guard refuses `page = 0` with a message that says it should be allowed.** `if page <= 0: return 400 {'message': 'Page number must be greater or equal than 0'}` — the check excludes 0, the sentence includes it. Present in **two** ported views: `LoanView.get` and `SavingAccountView.get`. | **Ported verbatim, message and boundary both.** Not fixed: the string is client-visible and a correction would be a v2-only behaviour change in a phase whose job is parity. | **P4** (first ported) / **P6** (second) | ✅ **Registered 2026-09-08.** ⚠️ **It had no register row anywhere for two phases** — `grep -rn "greater or equal than 0" docs/*.md` returned nothing until Phase 6 looked. Found by `nestjs-developer`, which also pointed out it belongs here as a shared wart rather than as a Phase 6 footnote. |
| **D39** | ⚠️ **v1 announces a soft-deleted member's birthday to the whole fund.** There is **no `is_active` filter anywhere on the notification path** — `services/notification.py`, `scheduler/`, `celery/` (grep controlled: the same grep finds `def ` in all three, and `is_active` exists elsewhere in v1, so the absence is real). Recipient lists are frozen into the hstore payload when the chain is created, and the subject is carried as `owner_id`. **This is not hypothetical:** task **1770** — *"Hoy está cumpliendo años Angi Paola Sanchez Quilindo"*, `run_date 2025-11-14`, **`processed = true`** — went out while user 15 was already `is_active = f`. Task **2142** repeats it on **2026-11-14**, and would fire under v1 as readily as under v2. | **v2 does not announce a birthday whose `owner_id` is `is_active = false`.** ✅ **Decided by the operator 2026-09-07 (Q35).** A deliberate deviation: v1's behaviour is to announce, and v2 changes it. The payload already carries `owner_id` (verified: 1497 → 3, 2142 → 15), so the check is available at execution time and needs no schema change. ⚠️ **The runbook half is not the fix** — steps **3a**/**3a-bis** clear the two known rows and sweep for others, but only code stops the next one. ⚠️ **Open: which layer.** Filtering in the executer suppresses the push but still marks the row processed and clones the successor, so a member who returns resumes automatically; filtering at chain creation does not. Decide in the phase that implements it, and record the choice here. | **Phase 6/7b** — carried with **C71**, which is the same row's forward-going face | ✅ **Implemented** (`5e3457a`, `796ba2b`; Phase 8b closed): a birthday whose owner is inactive, has no user row, or has an `owner_id` above int4 sends nothing, is marked processed and its successor cloned. Runbook **3a**/**3a-bis** delete tasks 1497 and 2142 (**Q51**). |
| **D38** | 🔴 **An unauthenticated account takeover, live in v1 today.** `activate_user` (`services/user.py:110-121`) guards with `if 'key' not in obj or obj['key'] == ''`. **In CPython `None == ''` is `False`**, so a JSON `null` passes it; the lookup then runs `key_activation = None`, which Django compiles to **`key_activation IS NULL`**. Measured against `fondodev`: that matches **15 of 15** members, the single ADMIN included — and **2 of them are soft-deleted**, so the same request also flips `is_active` back to true and **resurrects a deleted account**. `UserActivateView` sets `permission_classes = []`, so **no authentication is required**. The only other input is `identification`, which `GET /api/user` returns to any member and which the power-of-attorney letter prints for all 15 (**D5**). One request — `POST /api/user/activate/<id>` with `{"key": null, "identification": <cédula>, "password": "…"}` — calls `set_password` and hands over the login. | **Fixed in v2, not ported.** `obj.key === null` joins the guard. There is no legitimate caller: a real activation link always carries a non-empty key, and a member whose key is NULL is already activated. Pinned by an e2e cell that also asserts the password is unchanged. ⚠️ **The refusal covers four v1 outcomes, not one**, measured live: with a valid `identification` and `key: null`, v1 answers **200** and hands over an active member's account, **200** and *resurrects* a soft-deleted one, **200** on the ADMIN — and, when the body carries **no `password` key at all**, a **500** (`obj['password']` raises `KeyError` *after* the lookup succeeds, so nothing is written). v2 answers **404** to all four. The status pair for that fourth sub-case is therefore **500/404**, not 200/404; it is inside this deviation, and `manual-tester` must not read it as a separate finding. | P3 code, landed with P5 (`1c90753`) | ✅ **Fixed in v2.** ⚠️ **v1 exposure accepted until cutover — see the risk record below.** |
| **D35** | ⚠️ **A live Phase 3/4 defect, found during Phase 5.** `common/utils/python-obj.ts:166` `toDjangoText` folds a JSON `null`/`undefined` to the **four characters `'None'`**, and its docblock claimed that is what v1 stores. It is not. Measured in the v1 container: `TextField().get_prep_value(None)` and `CharField().get_prep_value(None)` both return **`None`** — they share `to_python`'s `if isinstance(value, str) or value is None: return value`. So the column takes NULL, the `NOT NULL` constraint fires, `create_user`'s `except IntegrityError` catches it (`services/user.py`) and v1 answers **409 `Identification/email already exists`** — a misleading message, but a refusal. **v2 answers 201 and writes a member named `None`.** Same shape for `last_name`, `email`, `primary_color`, `secondary_color`. **14 non-spec call sites**, all Phase 3/4. | **Fix — v2 must not create records v1 refuses.** `toDjangoTextOrNull` already exists (added in Phase 5, which uses it); the Phase 3/4 sites need converting **with their own control runs and parity cells**, because each site's `NOT NULL`/nullable status differs and a blanket change could turn a v1 409 into a v2 500 or vice versa. ⚠️ **Not** folded into Phase 5: it is Phase 3/4 code, and an unreviewed cross-phase edit inside another phase's branch is how a regression hides. | P3/P4 code, scheduled as its own task | ⏳ **Registered — fix, scheduled after Phase 5's parity round** |
| **D36** | `GET /api/activity/<id>` is `GET 3` and `ActivityDetailSerializer.get_users` nests the full `UserProfileSerializer` — `identification`, `email`, `birthdate`, `role`, `role_display`, names, `id` — for **every** member attached, and `create_activity` attaches every **active** member. So one GET on any activity returns the whole roster with those fields, plus each member's payment `state`. Raised in Phase 5 as the analogue of **D10**/**D25**. | **Port unchanged — accepted, not a defect.** ⚠️ **The fields are already fund-open by an unrestricted route**: `UserView.GET` is also `3` and `get_users` serialises the **same** `UserProfileSerializer` for every active member (`services/user.py:60-70`), unpaginated when `?page` is absent — v2 reuses one `serializeUserProfile` on both paths. An ownership check here would close nothing. **D25 is not reopened and had no gap**: its subject was the `finance` block (`utilized_quota`, `total_savingaccounts`) and D10's was loan data; `ActivityDetailSerializer` carries **no** finance and **no** loan data, and `Activity`/`ActivityUser` are referenced nowhere in v1 outside their own module. The D10/D25 predicate also does not transfer — an activity has 13 owners, so the only available "fix" is filtering the nested `users` array, a **response-body** change that would empty the screen. ✅ **Operator Q32: the members' activity screen is meant to show the whole paid/unpaid list.** Two residuals recorded rather than fixed: (a) **soft-deleted** members stay attached to activities that predate their departure, so `GET /api/activity/20` still returns the email/`identification`/`birthdate` of users **3** and **15**, whom `GET /api/user` no longer lists; (b) payment `state` is fund-visible — live: **294 PAID_OUT / 44 NOT_PAID / 0 EXEMPTED**, of which 39 NOT_PAID are unmarked 2026 defaults and 5 are historical. ⚠️ **If `GET /api/user` is ever restricted this row must be revisited in the same change** — the whole "already open" argument rests on it. | P5 | ✅ **Registered — port; accepted (Q32).** Owns **no code change**: the four Phase 5 e2e role cells that already return 200 with the full roster are its pin. Analysis: `docs/ba-phase-5-activity-exposure.md`. |
| **D37** | ⚠️ **A fourth site, added 2026-09-08 (Phase 6):** `POST /api/saving-account {"end_date": null}` — both stacks 500, neither writes a row, v1's `fondo_api_savingaccount_id_seq` advances 3→4 and v2's does not. ⚠️ **A doomed INSERT burns a sequence value in v1 and not in v2, so the *next* client-visible id drifts after any refusal that writes nothing.** Django issues the INSERT and lets PostgreSQL refuse it; `nextval` is already consumed and sequences are non-transactional, so the rollback does not give it back. Measured on three routes, both stacks, raw socket: `POST /api/activity/year/<id>` with `name: null` or `date: null` (**500** on both) — `fondo_api_activity_id_seq` reaches **31** on v1 and **29** on v2, so the next successful create is id 31 there and 29 here; `POST /api/user` with `first_name: null` (**409** on both) — `auth_user_id_seq` **29 → 30** on v1, unmoved on v2; `PATCH /api/user/<id>` personal with a `birthdate` **and** `first_name: null` (**409** on both) — `fondo_api_schedulertask_id_seq` **2528 → 2529** on v1, unmoved on v2. In every cell the status, body, byte count, header set **and every table row** are identical; only the sequence differs. | **Port the status, not the sequence — accepted, not fixed.** v2 raises before Prisma is called because **Prisma validates a required field client-side**, so the null never becomes a statement — see D35, which documents this at both call sites (`user.service.ts:196`, `activity.service.ts:217`). Matching v1 would mean hand-writing raw-SQL INSERTs *known to fail*, on `POST /api/user` and two other live paths, for the sole purpose of consuming a sequence value: a deliberate failing write on a production path, to reproduce a side effect no client can observe. It cannot be observed because the cutover is a **hard switch** — §3 Phase 9 step 3 stops v1 and points DNS at v2, the two never serve concurrently, and v2 owns the sequences from that moment. Neither stack promises contiguous ids (`fondo_api_activity` already has gaps at 5, 16, 28-30), and no row's id is ever *wrong* — only the next unused one differs. **The Phase 5 parity criterion is unaffected**: it asks for identical `activityyear`/`activity`/`activityuser` **row sets**, and those are identical in every measured cell. ⚠️ **What this row does not license:** an id **collision**, an explicit id written by a future path, or sequences reset from a dump taken while v1 was still serving. Those are different failures. | P3/P4/P5 | ✅ **Registered — port; accepted.** Supersedes parity finding **P5-F2**: a sequence-only diff is an **expected** diff and must not be re-filed. |
| ~~**D31**~~ | ~~Allow `3 → 1` so a wrongly auto-closed loan can be re-opened through the API.~~ | ❌ **WITHDRAWN 2026-09-04 — operator declined.** D9's 409 stands: **PAID_OUT is terminal through the API**, and the fund's recovery procedure for a wrongly auto-closed loan is a **direct database repair** — now a *deliberate, recorded* procedure rather than an accident of D6 and D9 interacting. Weighed: the operator confirms an incomplete TSV has **never happened**, and the BA could find no forensic signature of a past one — `fondo_api_loan` has no `closed_at` and no state audit, and **336 of 345** PAID_OUT loans carry a positive `capital_balance` (verified), because omission from the next file *is* the normal payoff path. A closed loan still showing a balance is the norm, not a red flag. The BA recommended allowing it ADMIN-only; the operator chose the narrower option. 📍 **The procedure itself is written in `docs/phase-4-deviations.md` §2.10** — the three numbered facts a DBA needs before touching a row, and what **D33**'s state-filter-less self-heal does to the reminders afterwards. It is also carried into Phase 9's runbook block and §9 runbook item 6, because a phase document addressed to a reviewer is not what an operator opens during an incident (**C54**). ⚠️ The BA's rejection of `3 → 0` stands regardless and must not be revisited: re-running approval upserts `LoanDetail` at `capital_balance = loan.value`, discarding every month of TSV state and re-mailing 28 borrowers. | P4 | ❌ **Withdrawn — keep v1's terminal close** |
| ~~**D32**~~ | ~~Mail roles `[0,2]` when a TSV upload closes ≥ 1 loan.~~ | ❌ **WITHDRAWN 2026-09-04 — operator declined.** A mass close stays **silent**, exactly as v1 behaves: `update_loan` mails on state 1 and 2, and state 3 only calls `remove_sch_notitfications` (verified). The treasurer sees the closed ids in **D8's response body at the moment of upload** and nowhere else; nothing persists them. Recorded because the reviewer's m2 is right that **D8 is a capability, not a notice** — it helps only someone who reads that body — and because the operator has now chosen that knowingly. No member-facing mail either: nothing distinguishes a wrong close from a right one, so a member notice would fire on every month-end payoff. | P4 | ❌ **Withdrawn — close stays silent** |
| **D33** | ⚠️ **The partial self-heal — and with D31 withdrawn it is now the *only* thing that happens.** `__update_loan_detail` resolves by `loan_id` **alone, with no state filter** (`services/loan.py:286`), then unconditionally calls `__create_scheduled_task`. So a wrongly closed loan left in next month's TSV has its detail updated and its **T−5d / T−1d reminders re-created while it stays PAID_OUT** — the member is pushed payment reminders for a loan the fund records as paid, and still sees no balance. Separately, `refinance_loan` requires state 1 and answers a **zero-byte 400**, locking that member out of refinancing — **148 of 425 loans** are refinances (verified), a live fund process, with no explanation given. | **Ported unchanged.** v2 mirrors v1 exactly (`updateLoanDetail` resolves by `loan_id`; `scheduleNotification` fires from the TSV path only). Registered, not fixed, **because D31 was withdrawn**: with no re-open route this *is* the residual behaviour of a wrong close, and it must be findable by whoever performs the direct database repair. ⚠️ **That repair must also reconcile `SchedulerTask` rows** — `updateLoanDetail` may already have re-created reminders the close deleted. | P4 | ✅ **Registered — port; consequence of D31's withdrawal** |
| ~~**D28**~~ | ~~Block `finance` self-writes for TREASURER.~~ | ❌ **WITHDRAWN 2026-09-03 per operator Q31.** A TREASURER approving **their own loan** is accepted fund practice — `LoanDetailView.patch` is `[0,2]` and `update_loan(id, state)` never receives the actor's id (`services/loan.py:79`), so there is no ownership check to fail. Blocking the smaller self-write while the larger self-approval stays open is incoherent, and **m6 is accepted with it** (consistent with Q12). **Both port from v1 unchanged.** The accepted exposure, recorded so Phase 4 carries the cell *deliberately*: the treasurer can raise their own `available_quota`, pass `create_loan`'s check (`services/loan.py:26-28` — the fund's **only** quota enforcement), and approve the result. Live: the TREASURER is user 2 at **20 343 105 of 30 000 000** — *second*-largest borrower, not largest (user 6 holds 25 871 634; the BA note said otherwise and was wrong). See `docs/operator-q29a-q30a-q31.md`. | P4 | ❌ **Withdrawn — port v1** |
| **D20** | The same handler calls `user_ids.remove(user.id)` on a list from `get_users_attr("id")`, which filters `is_active=True`. Editing a **soft-deleted** user raises `ValueError` → 500 → full rollback. ⚠️ Checked 2026-08-31: **`fondodev` has 2 inactive users, so this is triggerable today.** | Guard the removal. | P3 | ✅ **Fixed (P3)** — the removal is guarded; an admin can now edit a soft-deleted member's profile. |
| **D18** | Request-parsing divergences found in Phase 1 review: `text/plain` → v1 **415**, v2 400. `multipart/form-data` → v1 **200**, v2 400. Malformed JSON → v1 `{"detail":"JSON parse error - …"}`, v2 Node's message. | ✅ **Fixed, all three — no deviation taken.** v2 owns request parsing (`DrfRequestParsingMiddleware` + `DrfParserInterceptor`, `bodyParser: false`): multipart parses, an unsupported media type is DRF's **415**, and a malformed JSON body returns CPython's own message and character offset (`python-json.ts`, differentially validated against CPython 3.9 over 412 structured + 3 000 fuzz cases, 0 mismatches). Parsing is deferred until **after** the guards, so DRF's authenticate-then-parse ordering is preserved. Three residuals registered in `docs/phase-1-drf-auth-bodies.md`, none client-visible. | P1 | ✅ **Fixed** |
| **D14** | `PATCH /api/user/-1` and `DELETE /api/user/-1` pass `-1` through and 404; only `GET` substitutes `request.user.id`. | **Split by verb** (BA). GET keeps "me". PATCH **adopts** "me" — v1 404s unconditionally, so no working client can depend on it; the change is inert but stops telling a member they don't exist. DELETE **rejects the sentinel**: `fondodev` has exactly **one** ADMIN, and self-soft-delete is unrecoverable through the API (`key_activation` is null for all 15 users, so `activate_user` can never restore them). | P3 | ✅ **Decided — fix** |
| **D15** | `__update_user_personal` does `user.username = obj['email']`, rotating the name the member logs in with. | **Stop writing `username` on personal updates.** Login names become stable. See the runbook item below — the live behavior is *worse and narrower* than "silent rename". | P3 | ✅ **Decided — fix** |
| **D16** | `identification` is writable by any caller on a `personal` update. | ✅ **Decided (Q26): ADMIN-only.** It is the join key of the treasurer's monthly TSV and a miss is only logged (`services/user.py:144`), so a member editing their own cédula **silently freezes their own contributions and quota** until someone notices. ⏳ **Needs operator confirmation.** | P3 | ✅ **Fixed (P3)** — ADMIN-only, gated on an actual change. |
| **D17** | `get_user_by_email` (`services/user.py:84`) uses `.get()` inside a bare `except`, so a duplicated email raises `MultipleObjectsReturned` → returns `None` → **no reset email is sent**, while `PasswordResetView` still redirects to the success page. | **Verified live: users 7, 10, 13 and 14 — 4 of 15 members — cannot reset their password and are told it worked.** v2 must handle multiplicity deliberately. ✅ **Decided (Q27): the link goes to the account whose `username` equals the email** — so `criss9413@hotmail.com` resets id 7 (the parent), not id 14 (Ainhoa); `mhjc123@hotmail.com` resets id 10, not id 13. The two child accounts are admin-assisted reset only. Fixes the current silent failure for all four members. **C32 completes the rule:** when several rows share the address and **none** has it as its `username` — a state D15 + P3-D2 let a member's own personal edit create, and v1 cannot reach — the answer is the **lowest id**, not `null`, so the silent non-delivery cannot come back through v2's own deviations. | P3 | ✅ **Decided — fix** |
| **D13** | An unknown URL returns Django's **HTML** 404 page (`<h1>Not Found</h1>…`), not JSON. | v2 returns JSON `{message: …}`. Pre-existing since Phase 0 but was unregistered — `manual-tester` would otherwise file it. Accepted: no client depends on an HTML 404. | P0 | ✅ **Accepted** |
| **D12** | CAP auto-close was never implemented — `services/saving_account.py` carries a `# TODO: schedule task for closing CAP`. Closing is manual-only today. | **Implement it** (Q20): a CAP closes automatically on `end_date`. New functionality, not a port. **One `SchedulerTask` per CAP, written at creation time, `repeat = 0`** (decided in Phase 6; the alternative — a daily sweep driven by the reconciliation query — was rejected because *a check that drives the work is not a check*: a broken close would return an empty result and read as "nothing to do", which is the failure C74 exists to prevent, and because a sweep must itself repeat, and C77 forbids `throw` on a repeating task while C74 forbids `ok: false` for money). ⚠️ **Accepted consequence:** a CAP created *between* the two passes with an `end_date` of today closes at **14:00, not 10:00** — it needs a zero-duration CAP, it still closes on its `end_date` (Q20), a CAP earns nothing (Q19) so the hour carries no value, and double-close is impossible (atomic claim + compare-and-set). Suppressing it would require the per-type pass scheduling **Q39** forbids. Needs a `SchedulerTask` type — **so Phase 6 depends on Phase 7** (already sequenced that way). No member notification (Q22). **The close writes `state = 1`; closed-ness is never derived at read time.** A reconciliation query over `state = 0 AND end_date < today` (America/Bogota) is the independent check — and the ship-day backfill (**C74/C78**). **The close task carries `repeat = 0`, which is what makes its executer's `throw`-on-failure safe** (**C77**). | P6 | ✅ **Decided — build** |
| **D11** | `UserFinance.user` and `UserPreference.user` are plain FKs, not OneToOne — the same latent defect registered as D6 for `LoanDetail`. A duplicate row makes the user's finance endpoints 500 permanently. | Unique constraint on `user_id` for both; upsert not insert. | P3 | ✅ **Decided — fix, in two halves.** The application half shipped in P3 (deterministic lowest-id reads, so a duplicate row degrades to "ignored" instead of a permanent 500). ⚠️ The **physical `UNIQUE (user_id)` moves to Phase 9**: §4 rule 6 forbids v2 running migrations against a database v1 shares. Nothing in v2 can create a second row. |
| **D10** | Loan read (`GET /api/loan/<id>`, `paymentProjection`) is open to any member by id. | **Restrict** to the loan owner plus roles `[0,1,2]` (Q16). | P4 | ✅ **Decided — fix** |

**Phase-local deviations** — the ones that only exist because of how a phase was
implemented — live in that phase's `docs/phase-<n>-deviations.md`, not here. Phase 3 registered
seven (**P3-D1**–**P3-D7**), of which three change an observable response: **P3-D2** (a
duplicate email on a personal update is now a 200, not a 409 — the 409 came from the `username`
write D15 removed), **P3-D3** (no `django_session` row and no `sessionid` on the reset hop) and
**P3-D6** (a zero-byte 500 where Django renders its HTML error page — D13's species,
extended). Phase 5 registered four (**P5-D1**–**P5-D4**), **none of which changes an
observable response** — they are v1 behaviours discovered while porting, carried as found:
`create_year`'s missing transaction, the `int()` asymmetry between `create_activity` and
`__update_activity`, `toDjangoText`'s `None` fold (a **Phase 3/4** defect found in Phase 5 and
deliberately not fixed there), and the explicit `ActivityUser` cascade §4 rule 10 requires.

### D1 — the authorization rule for `PATCH /api/user/<id>`

**Principle: universal self-service, with privileges added on top.** Every role may edit its own
`personal` (excluding `role`) and `preferences`. Elevated rights are additive:

| Role | Own profile | Other users | `role` field | `finance` section |
|---|---|---|---|---|
| **0 ADMIN** | ✅ | ✅ any user, any section | ✅ **only ADMIN** | ✅ any user |
| **1 PRESIDENT** | ✅ personal + preferences | ❌ | ❌ | ❌ |
| **2 TREASURER** | ✅ personal + preferences | `finance` only | ❌ | ✅ any user |
| **3 MEMBER** | ✅ personal + preferences | ❌ | ❌ | ❌ |

- PRESIDENT gets **no elevated rights** here (Q25) but keeps self-service (Q25a) — the literal
  reading would have made role 1 less capable than role 3.
- ⚠️ **Inference, flagged:** Q15 said "treasurer only can modify finance information." Applying
  the same principle that resolved Q25a, TREASURER **also keeps self-service** on their own
  personal + preferences. Without that they could not change their own email address. Say so if
  that is wrong — it is the one cell in this table the operator did not state directly.
- `role` is writable by ADMIN alone, on any user. This is the escalation path being closed.
- A `finance` write by a non-privileged caller is **403**, not a silent no-op.

**Two clarifications that each would otherwise break every ordinary member save** (BA, `docs/ba-phase-3-decisions.md`):

1. ✅ **The `role` check compares values, it does not check presence.** v1's client echoes the
   whole `personal` object back from `GET /api/user/<id>` — which includes `role` — so a
   "`role` key present and caller is not ADMIN → 403" reading would 403 **every save by all 14
   non-admin members**: 100% false positives, a signal nobody would keep. Compare the submitted
   value against the stored one and 403 only on an actual **change**. A 403 then means a real
   escalation attempt and is worth logging. Accepted side effect: a stale client submitting an
   out-of-date `role` gets a 403 — correct, since the alternative is silently demoting a freshly
   elected treasurer.
2. ✅ **Authorization keys off `body.type`, not off which sections are present.** `update_user`
   dispatches on `obj['type']` (`services/user.py:100`) and ignores the rest. Every v1 test
   fixture posts `personal` **and** `finance` in the same body, so a presence-based finance check
   would 403 every member profile save. Gate on the declared `type`.

**Explicitly confirmed as intended — port faithfully, do not "fix":**

- **Loan auto-close is a real business rule** (Q1) — absent from the monthly TSV means paid off.
  It stays **silent**: no email, no push. And no guard against closing a loan approved after the
  file was generated (Q2) — the operator accepted that risk.
- **Rate frozen at request time** (Q4), so a loan awaiting approval across a rate change is
  approved at the old rate.
- **Quota comes exclusively from the treasurer's monthly file** (Q12, reconfirmed). Loans do **not** increment
  `utilized_quota` on create or approval. ⚠️ Known and accepted consequence: a member can open
  several loans between uploads that together exceed their quota.
- **Multiple concurrent refinance requests against one loan stay allowed** (Q5), including the
  broken linkage that follows.
- **Payment reminders are best-effort** (Q6, reconfirmed) — a failed publish is marked processed and lost, with
  no retry on the next scheduler run. *Note: the in-call bounded retry (Phase 2, condition 1) is a
  different mechanism and is still planned — say so if you want that dropped too.*
- **Push only; no email fallback for reminders** (Q7). Members without a browser subscription
  receive no payment reminders — accepted.
- Also unchanged: the deny-on-lookup-miss permission fallthrough; the `406`/`409` status choices;
  the pagination envelope; the rate table itself; "attach all active users"; and CAP-balance /
  quota independence.

---

## 6. Test porting

v1 has **104 test methods** across 8 files (the 20 Alexa tests are dropped):

| v1 file | Tests | v2 destination |
|---|---|---|
| `test_date_utils.py` | 2 | Phase 0 |
| `test_models.py` | 8 | Phase 0 (model round-trip) |
| `test_mail_service.py` | 6 | Phase 2 |
| `test_notification_views.py` | 4 | Phase 2 ⚠️ thin |
| `test_user_views.py` | 31 | ✅ Phase 3 — all 31 ported (`test/user.e2e-spec.ts`, 84 cells; four expectations moved by D15/D2 and each says so) |
| `test_loan_views.py` | 33 | Phase 4 |
| `test_activity_views.py` | 12 | Phase 5 |
| `test_file_views.py` | 8 | Phase 8 |
| — | **0** | **Phase 6 (saving accounts), Phase 7 (scheduler), admin endpoint** |

- `AbstractTest` helpers (`create_user`, `create_basic_users`, `get_token`, `get_auth_header`)
  become a shared e2e fixture module.
- **3 methods are prefixed `pending_test_`** (2 in `test_models.py`, 1 in
  `test_notification_views.py`) and never run in v1. Read them for intent, then decide per
  case whether to revive or drop — do not silently port them as passing tests.
- v1 mocks external I/O at the boundary (`@patch('boto3.client')`) and asserts full SES
  payloads. Keep that shape: mock the AWS/GCS SDK clients, assert the whole payload.
- ⚠️ **Coverage debt concentrates in Phases 6 and 7** — and Phase 7 is also raw-SQL hstore
  territory. Budget extra time for both.

---

## 7. Phase gate checklist

A phase closes only when all four are green. Any ✗ re-opens the phase and revises this plan.

| # | Owner | Criterion |
|---|---|---|
| 1 | `nestjs-developer` | Endpoints, services, DTOs implemented; unit + integration tests ported and green; lint and typecheck clean. |
| 2 | `manual-tester` | Parity report **PASS** against v1 on the shared dev DB — responses, status codes, DB side effects, SES/SQS payloads, scheduler rows. |
| 3 | `nestjs-reviewer` | Code review approved, **and** the parity report reviewed for missing business scenarios. Also enforces the §2 rule that hstore raw SQL stays inside the two repositories. **Standing requirement — see below.** |
| 4 | `business-analyst` | Phase alignment note = **Aligned**. |
| 5 | *user* | Every §5 deviation owned by this phase is **decided** (port or fix) and recorded. An undecided deviation blocks the gate; an unregistered behavioral diff is a parity **failure**. |

### The full pipeline is standing, from Phase 2 to the end

Every phase from Phase 2 onward runs all three roles **in sequence**, each gating the next. A
phase does not advance on the previous role's optimism.

```
nestjs-developer  ──►  manual-tester  ──►  nestjs-reviewer  ──►  phase closed
  implements +          parity report        code + parity
  ports tests           vs v1 on the         review, explicit
                        shared fondodev      verdict
       │                     │                     │
       └── sign-off ─────────┴── sign-off ─────────┘
```

- **`manual-tester` runs before the reviewer, not after.** It exercises both APIs against the
  shared `fondodev` and reports observable differences: response bodies, status codes, DB side
  effects, SES payloads, SQS messages, scheduler rows. A **PASS** is required to proceed.
- **`nestjs-reviewer` reviews the parity report as well as the code**, hunting business scenarios
  missing from *both*. Its verdict closes the phase.
- **`business-analyst`** remains gate 4, and is also invoked on demand whenever a business rule
  is ambiguous — it has already changed this plan four times.
- A failure at any stage returns the phase to `nestjs-developer`; the sequence restarts there.

Phases 0 and 1 closed without a `manual-tester` pass (`n/a` on the board) because they ship no
business endpoints — there was nothing to compare. **Phase 2 is the first with observable
behaviour, and the first to run the full sequence.**

### The review gate is standing, not optional

**Every phase ends with a `nestjs-reviewer` pass.** No phase closes without one, including phases
that look mechanical. The reviewer:

- writes `docs/review-phase-<n>.md`, findings ordered blocking / should-fix / consider, each with
  `file:line`, what is wrong, why it matters, and what to do;
- ends with an explicit verdict: **Approved**, **Approved-with-conditions**, or
  **Changes-required**;
- reviews the `manual-tester` parity report as well as the code, looking for business scenarios
  missing from both;
- enforces §2's rule that raw SQL touching `hstore` appears **only** inside
  `NotificationSubscriptionRepository` and `SchedulerTaskRepository`.

A **Changes-required** verdict re-opens the phase. Conditions attached to an
**Approved-with-conditions** verdict are tracked to closure before the next phase's gate, not
silently carried forward.

Rationale: the two corrections that mattered most so far — the `username != email` lockout and
the Babel four-digit grouping — were both cases where a plausible-looking assumption survived
until someone read the source or the live data. That is exactly what a review pass is for, and it
is cheapest at the end of the phase that introduced it.

### Phase 2 review conditions (C19–C27)

From [`docs/review-phase-2.md`](docs/review-phase-2.md). Graded by deadline, not severity.

**Before Phase 3's first controller:**

| # | Condition |
|---|---|
| **C19** | ⚠️ **S3 — `ALLOWED_HOSTS` is dropped.** The `CommonMiddleware` port omits the one part that is not a no-op. Measured live: `Host: evil.test` → v1 **400** on every route, v2 serves. Confirmed: production sets `ALLOWED_HOSTS = [ALLOWED_HOST_DOMAIN, '127.0.0.1']` (`api/settings/production.py:13`), and Phase 3's `PasswordResetView` builds the emailed link's domain from `get_current_site(request)` (`views/auth.py:37-42`). **In Phase 3 this becomes reset-link poisoning: an attacker sets the `Host` header and the victim's reset token is delivered to a domain they control.** Fix before any Phase 3 route ships. ✅ **Closed.** `DjangoAllowedHostsMiddleware` + `django-allowed-hosts.ts` port `get_host` / `split_domain_port` / `validate_host` / `is_same_domain` from the installed Django 2.2.27 — the leading-dot wildcard, `*`, the port and trailing-dot stripping, the bracketed-IPv6 branch, the `if domain and …` guard and the `DEBUG`-with-empty-`ALLOWED_HOSTS` fallback, each pinned against a measured live-v1 status. Registered at slot 3 **above** the `APPEND_SLASH` port, where `CommonMiddleware.process_request:47` calls it, so the 400 precedes the CORS preflight, the 301 and the resolver. `ALLOWED_HOST_DOMAIN` added to `env.schema.ts` (optional and untrimmed, reproducing v1's `[None, '127.0.0.1']`). Body is `{"message":"Bad Request"}` per D13; `X-Forwarded-Host` and the `SERVER_NAME` fallback registered as **P2-D9**. 22 unit + 17 e2e regression cells. |
| **C20** | **S2 — the URL table resolves paths, never views**, and `roles.guard.ts:66` trusts Express declaration order. v1's four `/api/user/…` routes have different rules — `UserAppsView` declares only `POST` (so `DELETE` is deny-all via the bare `except`) while `UserDetailView.DELETE` is ADMIN-allowed. A mis-resolution turns a routing detail into an **authorization** decision. Bind the resolved v1 view identity, not the path. ✅ **Closed.** `DjangoUrlResolverMiddleware` now publishes the matched pattern as `request.djangoRoute`, and `RolesGuard` authorises on **that** view. `DjangoUrlPattern.view` is narrowed from `string` to `V1ViewName | UnguardedV1View | null`, so the table and `list_permissions` are linked at compile time. Three fail-closed outcomes: no `@V1View` → 403 (v1's `KeyError` path, unchanged); no resolved route → 403; **resolved ≠ declared → 500 with a loud log**, never a plausible 403 that hides a mis-ordered route. `test/v1-view-binding.e2e-spec.ts` mounts the mis-ordering deliberately and pins `DELETE /api/user/power` as a refusal for ADMIN. The 280-cell role matrix now runs through the resolver too, so it proves table+router+matrix agreement rather than the matrix alone. |
| **C21** | **S1 — response hooks run FIFO, the reverse of Django's response phase**, and the doc at `before-headers.ts:31-33` asserts the opposite. Unobservable today; Phase 3 makes it observable. The model also has no notion of **depth**, so it cannot express `/password_reset/`'s `Vary: Cookie, Origin` (view-level `csrf_protect`, below all eight slots), and `skipBeforeHeadersHooks` means "all" where Django means "below me". ✅ **Closed, as a Phase 2 defect rather than a Phase 3 design item** — the mechanism already existed, already ran backwards and already carried three hooks at three different depths while pretending they were peers. `DjangoStack` (`django-middleware-depth.ts`) gives v1's eight slots numbers, plus `VIEW = 9` for everything below them and `TRANSPORT = 0` for the un-Django Express fixups. `onBeforeHeaders(response, depth, hook)` sorts descending (explicit sequence tiebreak, no reliance on sort stability); `skipBeforeHeadersHooks(response, belowDepth)` suppresses only what is deeper, and applies to hooks registered after the call as well. `DjangoResponseHeadersMiddleware` split into its three real depths. Both measured `Vary` orders now fall out of depth alone — pinned by a unit spec and by `test/response-phase.e2e-spec.ts`, whose slot-2 probe reproduces the reviewer's requested cell; both fail against the FIFO implementation (mutation-checked). The wrong doc comments at `before-headers.ts:31-33` and `app.module.ts:97` are corrected. **What is genuinely a Phase 3 design question is the session store**, not the ordering: `GET /reset/<uid>/<token>/` writes a `django_session` row, and v2 has no session model — already recorded at `django-url-conf.ts` and unchanged by this. |

**Within Phase 3 — all closed** (`5f4120f`, `af596b0`):

| # | Condition | Outcome |
|---|---|---|
| **C22** | S4 — the SQS retry budget is **9**, not the 3 P2-D7 records, with no request timeout, now on the HTTP request thread. | ✅ **Closed.** `sqsClientConfig` / `sesClientConfig` pin `maxAttempts: 1` plus explicit connect/socket timeouts, so the publisher's own 3-attempt loop is the only retry and a publish is bounded at **~9.6 s** worst case. SES gets the same treatment (Consider #6): boto3's legacy default there is **5** attempts and `MailService` has no retry loop at all, so every one of them was invisible latency inside `create_user`'s transaction. P2-D7 corrected to state the wall-clock bound. |
| **C23** | S5 — the hstore codec fails **open** on an absent `keys`/`user_ids` where v1 raises `KeyError`. | ✅ **Closed.** Both decoders check the key's presence before iterating, with the `KeyError: '<key>'` shape `readEndpoint` already uses, and the two NULL branches now carry the exception CPython actually raises (`AttributeError` / `TypeError`, not a generic one). Four spec cells; Phase 7 inherits the `user_ids` half. |
| **C24** | S9 — plan defect: Phases 3 and 4 both write `SchedulerTask` rows that Phase 7 owns and runs *after*. | ✅ **Closed by splitting Phase 7** — see the Phase 7a/7b note in §3. **How the rows are validated before the runner exists** (C24's actual question): by *comparison*, not execution. `fondodev` held 632 real rows, 92 of them `birthdate`, when this was closed — **626 and 86 today**, after the six rows destroyed in the Phase 3 round (§7); re-measured 2026-09-07 — so the e2e cells transcribe row 2458 field by field — `type`, `run_date` (05:00Z = local midnight), `repeat`, `processed` and `payload::text` — and prove a v2 row is byte-identical now. Phase 7 adds the behavioural half later, on top of `nextRepeatRunDate`, which C3 already pinned against `python-dateutil==2.7.5`. |
| **C25** | S6 — `resetDatabase` is one `TEST_DATABASE_URL` away from truncating the parity fixture. | ✅ **Closed.** `assertDisposableDatabase` gates **both** `provisionTestDatabase` and `resetDatabase` on positive evidence that Django does *not* own the schema — `django_migrations` empty (fondodev has 38) and no `0_init` baseline marked applied with `applied_steps_count = 0` (fondodev has exactly that) — plus a name denylist as a weaker second line. Six e2e cells, all negative. |

**Before the next parity round:** C26 (S7 — the parity report's `pg_dump` md5 guard is not evidence), C27 (S8 — supertest also silently rewrites dot-segments, backslashes and spaces; existing cells survive but the trap is open for Phases 3–8). Both belong to `manual-tester`'s method rather than to the source tree; C25's guard is the code half of the same concern and is closed.

**Consider C5** (not a condition): the 22-pattern table is correct *only* because Django 2.2.25+ uses `re.fullmatch` for `$`-terminated patterns (the CVE-2021-44420 fix) — Python's `$` otherwise matches before a trailing newline, and `POST /…/subscribe%0A` is reachable. Correct but version-dependent and undocumented; pin it with two cells. ✅ **Done** (with C20): six cells in `django-url-conf.spec.ts` and four in `test/http-edge.e2e-spec.ts`, naming the Django version and the CVE, plus the `decodePathInfo('%0A')` step that makes the input reachable.

### ⚠️ Fixture incident — 2026-09-02, Phase 3 parity

A `PATCH /api/user/13` probe (D15/P3-D2, suggested by `docs/phase-3-deviations.md` §4.4) succeeded
against v2, and `__create_birthdate_notification` calls `remove_sch_notitfications`
**unconditionally**. **Six historical `fondo_api_schedulertask` rows for owner 13 were deleted and
are not recoverable** — no dump, no accessible WAL, the tuples already pruned.
`fondo_api_schedulertask` is now **626, was 632**; one row for owner 13 survives, regenerated with
the correct values. The six were deliberately **not** fabricated.

**Everything else is byte-identical to baseline:** `notificationsubscriptions` 94 / max id 1468 /
`count(distinct xmin::text) = 1`, `auth_user` 15, `power` 20, `django_session` 20, `loan` 425, and
all schema/constraint/index hashes.

**Impact.** `fondodev` is a snapshot of production, so nothing member-facing is lost and production
is untouched — but this table is no longer a faithful snapshot, and **`SchedulerTask` is exactly
what Phase 7 exists to test**. Recommend **re-snapshotting `fondodev` from production before Phase
7**, and re-verifying the guards afterwards.

**Rule added — this is the process failure, not the probe:** every parity round must
`pg_dump` **each table the phase writes** before its first write cell.
⚠️ **Amended after round 2:** the dump must live on **persistent storage** — round 2's went to
`/tmp`, which is **tmpfs** (verified), and the host reboot destroyed it. Use
`~/.fondo-parity-dumps/`. ⚠️ **Amended again after Phase 6 (false-green #23): restore *in
place* — never drop and re-create a database a long-lived v1 process is connected to.**
`DROP DATABASE`/`CREATE DATABASE` changes the `hstore` type OID, Django 2.2 caches it per
process, and the running v1 then silently stops casting `HStoreField` — which reads as a v1
crash and is not one. `scripts/parity/reset-clone.sh` is the supported way to do it. And
**restore from the dump, never from statements the probe reconstructs** — round 1's six rows were lost precisely because reconstruction was the only
option. Round 2 had two incidents, including a probe that **soft-deleted the only ADMIN** (after
which ~150 later cells "agreed" at 401/401); both were recovered in one command **because the
dump existed**. Phase 3 guarded
`notificationsubscriptions` (the Phase 2 fixture) and not `schedulertask`, because the brief named
the tables of the *previous* phase. Phase 4 writes `loan`, `loandetail` and `schedulertask`; Phase
5 writes `activity*`; Phase 6 writes `savingaccount`.

### Accepted risk — D38's v1 exposure, until cutover

**Decided by the operator 2026-09-06.** The unauthenticated account-takeover path in v1 (**D38**)
stays open until v2 replaces v1. Recorded here so it is a decision with a date, not an oversight.

**What was offered and declined.** A mitigation existed that required **no v1 code change** and so
did not break the freeze: `UPDATE fondo_api_userprofile SET key_activation = <random> WHERE
key_activation IS NULL`. `key_activation` has exactly four uses in v1 — written at creation, read
into the activation email, matched in `activate_user`'s lookup, cleared on success — and nothing
depends on it being NULL, so filling it makes the `IS NULL` match find nobody. It would have
needed re-applying after each genuine activation, because v1 clears the key on success.

**Why accepting is defensible.** Exploiting it requires knowing a member's `identification` and
being willing to attack a fifteen-person family fund. The membership is closed and known to each
other; there is no public registration. No evidence of exploitation was looked for — and could
not be, since v1 keeps no access log this project can read.

**What would change the calculus, and should be re-raised if any of it happens:**

* **Cutover slips materially.** This was accepted against a migration in progress, not indefinitely.
* **A member's `identification` reaches anyone outside the membership** — note it is printed in
  every power-of-attorney letter, which goes to all 15 (**D5**), so the blast radius grows with
  each letter sent.
* **A member leaves on bad terms.** The attack needs no credentials, so revoking their access
  does not close it.
* **Anyone reports a password that stopped working**, which is what a takeover looks like from
  the member's side.

**The exposure ends at Phase 9 step 3** (deploy v2, point DNS at it) — not at step 6. The fix is
already in v2 and needs nothing further at cutover.

### False-green findings — a standing hazard, not a one-off

**Twenty-two** instances so far. A test that passes for the wrong reason is worse than a missing
one, because it is counted as coverage — and #17 is the sharpest illustration: a test written to
catch a timezone bug, defeated by a timezone bug.

#### The rule (condition C67)

> ### A check that can only report "nothing found" is not a check.
>
> Before trusting any check, ask: **what result would this produce if the thing it looks for were
> present?** If the answer is "the same one", it is not evidence — it is silence wearing the
> costume of a pass.

**Why this rule and not five more patches.** Eight of the twenty-two are mine, and by the Phase 5
review the pattern was unmistakable: each instance got a correct, specific countermeasure, and the
*class* kept producing instances. They were getting cheaper, not rarer. These four are one defect:

| # | The check | Why it could only say "nothing found" |
|---|---|---|
| 19 | `grep -F "…"` for a sentence | the sentence wrapped, so it matched nothing whether or not it was there |
| 20 | audit fifteen conditions by matching strings | a token can be present while the behaviour is absent — `orderBy` was computed and then discarded |
| 21 | `npm run lint \| tail -1` | a clean run and a broken pipe print the same nothing |
| 22 | "fixture at baseline" from row counts | counts matched while sequences were off by four and `xmin` cardinality had doubled |

**What the rule requires, concretely.** Each of these is the general rule instantiated, and each
is cheap:

* **Assert exit codes, never absence of output.** `cmd >/dev/null 2>&1 && echo PASS || echo FAIL`.
* **Search on a fragment that cannot wrap, or normalise whitespace first.** A multi-line anchor
  is not searchable with a single-line matcher.
* **An audit that clears something must exercise it or read the whole function.** Presence of a
  token is not presence of a behaviour.
* **A baseline is counts *and* sequences *and* `xmin` cardinality.** And an agent that reports
  doing nothing may still have written — #22's residue came from a run that died mid-round.
  ⚠️ **Nor is a rolled-back probe a no-op.** PostgreSQL sequences are **not** transactional: a
  `BEGIN; INSERT …; ROLLBACK;` leaves the row count, `max(id)` and `xmin` cardinality all
  exactly at baseline and the sequence one higher. Phase 7b did this to itself while building a
  positive control for its own fixture check, and the sequence line is what caught it (repaired
  with `setval`, re-verified). **The control for a fixture check must not write** — run the same
  probe against a different database instead: `DB=fondo_api_test scripts/parity/fixture-check.sh`.
  The check and its control are now in the repo at **`scripts/parity/fixture-check.sh`** rather
  than being re-typed each round.
* **Every matrix needs a positive control** — a cell known to differ, proving the probe can see a
  difference at all. #4 was 72/72 agreement where every cell was a 401; #12 was 208 cells
  uniformly 500 on both sides.
* **A control that does not compile is not a control.** Check the **test count**, not the pass
  line: two attempts in Phase 5 reported `Tests: 0 total` and one ran 349 of 1001.
* **Verify from the tree the claim is about.** `git branch --contains` — #18 was a doc fix
  verified correctly on a branch the work had already left.
* **A verifier that fails *after* the write, in a chain that keeps going, is barely a verifier.**
  v4.1 shipped a board row saying IN PROGRESS on a closed phase for exactly that reason.

**The honest limit of this rule.** It does not make the class extinct; it makes each instance
detectable at the moment it is created rather than two gates later. The register stays open, and
the count going up is a sign the discipline is working, not failing — every instance in it was
found by someone, and the ones found by `nestjs-developer`, `manual-tester` and `nestjs-reviewer`
checking *my* claims rather than believing them are the reason the number is honest.

| # | Instance | Why it passed |
|---|---|---|
| 1 | supertest strips fragments | the transport normalised the thing under test |
| 2 | `pg_dump` md5 as a fixture guard | `synchronize_seqscans` rotates rows; the value was never reproducible |
| 3 | e2e cell "PUT behaves exactly like POST" | sent the CSRF token in the **body** — asserting the very defect F5 describes |
| 4 | D1 matrix printing "72/72, 0 mismatches" | **every cell was a 401** (`is_active::text` is `true`, not `t`). A matrix asking only "did both sides agree" is satisfied by any *uniform failure*. |
| 5 | URL sweep after `DELETE /api/user/1` | the probe soft-deleted the ADMIN, so ~150 later cells agreed at 401/401 |
| 6 | round-1 SES check | compared only `Message.Body.Html.Data`, never the envelope — so it passed on a payload that is deliberately different (D5) |

| 7 | The developer's first F8 probe used `PATCH /api/user` | *every* malformed body is a 500 there whatever the parser does — the probe "agreed" on rows it was blind to. Caught before it produced a result. |
| 8 | **Mine.** I launched v2 without `ALLOWED_HOST_DOMAIN` and read a uniform **400** on every cell as a fix regression | C19's own `ALLOWED_HOSTS` port was rejecting `Host: localhost` — correct behaviour, misconfigured harness. A *uniform* result on a matrix is the signature of a broken probe, in either direction. Positive controls catch it; I had none. |

| 9 | **Mine.** The `:8450` I started and handed to the tester pointed `NOTIFICATIONS_QUEUE_URL` at **real AWS**, with no SES/SQS endpoint overrides, no `HOST_URL_APP`, no `TZ_NAME` | a false-**pass** generator: `create_user`'s rollback fires for the wrong reason, and an empty SQS capture compares "identical" to another empty one. Confirmed by inspecting both processes' environments. **Start v2 from `p3/start-v2.sh`, never by hand.** |
| 10 | A destructive `PATCH` cell ran both legs without restoring | v2's `*/*` control then ran against 0 subscriptions and "agreed" on `0 → 0`. |
| 11 | **Two harness defects still live in the repo scratchpad** — `p3/restore-all.sh` is mode 644 (fails silently when invoked directly) and `p3/r2-f3.sh` **still lacks `--path-as-is`** | round 2's dot-segment false green **re-fired in round 3**. A fix to a probe has to land *in the probe*, not only in the report that described it. |
| 12 | `POST /api/user/power` is uniformly 500 across 208 multipart cells; birthdates uniformly 200 | neither discriminates on status alone — the same blindness as instance #7, on a different endpoint. |

| 13 | `d1.py`'s positive control demanded a **403 from v1 on a route v1 has no authorisation branch for** — that absence *is* D1 | it printed `FAILED` on every correct run. **A control that always fails silences exactly like one that always passes**, because both stop carrying information. |
| 14 | **9 of 17 probe scripts were mode 644**, not the 2 named in instance #11 | they fail silently when invoked directly. The class was wider than the two instances that happened to be noticed. |
| 15 | Three consecutive rounds reported the fixture "byte-identical" while `fondo_api_userfinance_id_seq` and `fondo_api_userpreference_id_seq` **drifted 27 → 36 → 45** | `restore-all.sh` reset two sequences but not these, and `snap.sh` did not compare them. Not parity-visible — but it made a claim I repeated in three reports untrue. Sequences are now in both. |

| 16 | **Mine, third of this class.** v3.0's changelog and commit message both claimed two registration rows were corrected; `git show` touched only D22. My `.replace()` targeted the **BA document's** phrasing, not the **plan's**, so it matched nothing and reported nothing | an edit script that silently no-ops is the same failure as a test that silently passes. Earlier instances: a `sys.exit()` that aborted before the write, and an unreproducible content hash. **Every scripted edit must assert its anchor exists *and* re-read the file to confirm the change landed.** |
| 17 | **The developer's own catch, and the best of the seventeen.** Its first C28 test pinned the host zone with `process.env.TZ = 'UTC'` *inside* the spec | jest's vm context does not propagate that to V8's cached zone, so the pin did nothing. On this `-05:00` host the C28 cell **passed against the buggy line** — a test written specifically to catch a timezone bug, defeated by a timezone bug. Found by measuring it with a throwaway probe rather than trusting the green. Pin moved to `jest.config.ts` + `test/global-setup.ts`, before the workers fork; control run against the old line then produced **exactly one** failure. |
| 18 | **Mine, fourth of this class — and the first that was not a no-op.** I wrote the §3/§5 precedence note, verified it on disk, and committed it as `56e43b3` — **on `chore/c28-c36-phase-3-conditions`.** `feat/phase-4-loans` had already branched from `d164358`, which predates it, so the note was **absent from the branch all the work continues on**, while `docs/phase-4-deviations.md` §2.1 and §5.2 both told the reader it was there. Found by `business-analyst`, which went to read it and could not. | Verifying an edit on the branch you happen to be standing on says nothing about the branch the work will continue on. **`git branch --contains` before claiming a fix is in place**, and cherry-pick forward when a doc fix is written off the line of work. Earlier instances of the family: a `sys.exit()` before the write, an unreproducible hash, a `.replace()` that matched the wrong document. |
| 19 | **Mine, fifth of this family — and my *checking method* was the defect, not the edit.** `161d780`'s message claimed the C40/C41/M3/D29/D30 round complete; three required pieces were **not in its tree** — §5.1 still carried the "nothing in v2 can create a second row" claim M3 had just falsified, and §4.1 lacked the D29/D30 rows the manual tester works from. I had verified the *code* and the *gate numbers* and never opened the docs the brief required. Found by `nestjs-developer`, which checked the tree instead of believing my commit message. | ⚠️ **The grep that cleared it was line-wrapped.** The stale sentence spanned a newline, so a single-line fixed-string search counted **0** and I read absence as proof. The same blindness produced two false *alarms* earlier in this phase — pattern `*` unescaped, then an anchor split across lines. A verifier that fails in both directions is not a verifier: **match on a short distinctive fragment that cannot wrap, or normalise whitespace before searching.** And a commit message is a claim about a *tree*, so verify every item the brief listed, not the ones that were easy to check. |
| 20 | **Mine, sixth — I audited fifteen conditions by `grep` and got two wrong in the *closed* direction.** For **C32** I saw `orderBy: { id: 'asc' }` in `getUserByEmail` and reported the fallback "implemented"; the code computed that order and then **discarded** it, returning `null` — and a unit cell was pinning the `null`, asserting the opposite of the condition. For **C37** I reported two cells present because loose patterns matched *other files*; at `ed363db` both were absent (0 occurrences). Found by `nestjs-developer`, which read the behaviour instead of trusting my audit. | Presence of a token is not presence of a behaviour — this is **#19's defect with the polarity reversed**, and it is the more dangerous direction: #19 made me re-do finished work, #20 would have marked open conditions closed. **An audit that clears a condition must exercise it or read the whole function, never match a string.** The ten I marked closed were re-checked this way before the batch shipped. |
| 21 | **Mine, seventh — and it sat in the status block the operator reads.** I recorded `lint ✅` in the ▶ Now block at `a7c76a7`. Lint had **3 errors** there, left by my own DELTA-F1 commit. Found by `nestjs-developer`, which ran the gate at the head I briefed instead of believing the block. | I ran `npm run lint 2>&1 \| tail -1`, saw no output, and read the silence as success — **absence of output is not a passing exit code**. Identical in shape to **#19** (a line-wrapped grep returning 0) and **#20** (an audit matching strings instead of reading behaviour): three instances of *reading absence as proof*, now the dominant family. Gate checks must assert the exit code — `cmd >/dev/null 2>&1 && echo PASS \|\| echo FAIL` — and a claim in ▶ Now is a claim about a **tree**, so it gets re-measured rather than carried forward. |
| 22 | **Mine, eighth.** I started the containers, checked the fixture's **row counts**, told the tester "fixture at baseline" — and it was not. `activityyear_id_seq` was **12 → 16** and `xmin` cardinality **1 → 2**, residue from the rate-limited round-3 attempt, which had in fact run 14 cells before dying. Found by `manual-tester`, which checked sequences and `xmin` before trusting my handover. | Every briefed row count matched, which is exactly why counts alone are not a baseline. A 4-value sequence offset would have shifted every id **D37** compares, and D37 is the row that says ids may differ but must not *collide* — so the round could have produced a confident, wrong verdict on the one deviation whose subject is ids. **Baseline means counts *and* sequences *and* `xmin` cardinality**, and a rate-limited agent that "did nothing" may still have written. |
| 23 | ⚠️ **The first instance in this register that manufactured a false *FAILURE*, not a false pass.** `manual-tester`'s first Phase 6 clone script did `DROP DATABASE` / `CREATE DATABASE` before `pg_restore`. Every `POST /api/saving-account` then returned **v1 500 / v2 200**, with v1's traceback pointing at `services/notification.py` — *"v1 crashes on CAP create"*, convincingly, and **entirely an artefact**. Found and diagnosed by the tester itself, which then re-ran the whole round. | **DROP/CREATE re-creates the `hstore` extension with a new type OID; Django 2.2 `@lru_cache`s it per process** (`get_hstore_oids`), so a long-lived gunicorn holds a stale OID and **silently stops casting `HStoreField`**, handing the service a raw string. Nothing in v1's logs says so. ⚠️ **A false alarm costs more than a hidden defect**: the output is an escalation to `business-analyst` and possibly a "bug" ported into v2 that never existed in v1 — the register's whole purpose, running backwards. **Countermeasures:** restore **in place** (`TRUNCATE` + `pg_restore --data-only`), now committed as `scripts/parity/reset-clone.sh` mode 755 with the explanation in its header and a self-check that it never issues `DROP DATABASE` — *in the probe, not only in the report* (instances **#11** and **#14**); **restart any long-lived v1 process after a harness reset**; and take a **known-good control request before the matrix runs** — one `POST` that succeeded before the reset and 500s after it, with no v2 change in between, is the signature, and it would have caught this in one request instead of a round. |

**Countermeasures now required of every parity harness:** assert **positive controls** (prove the
matrix can produce a 200, not only agreement), print the **status distribution** rather than a
pass count, use `curl --path-as-is` (curl normalises dot-segments like supertest), and compare
**whole payloads**, not one field.

Applied to the F6/F8 work (2026-09-03): every e2e cell asserts the *same request* under an
acceptable `Accept` beside the 406, the write cell deletes the row under `Accept: */*` to prove
the route is not inert, the multipart cells assert the whole response body rather than the
status, the `SuspiciousOperation` cells pin the accepted boundary (exactly 1000 fields, exactly
2 MiB) as well as the rejected one, and the live matrices print their status distribution
(`200x22 400x24 401x19 404x23 405x8 406x28 301x1`, identical on both stacks) rather than a
mismatch count. A seventh instance was avoided rather than found: the first F8 probe used
`PATCH /api/user`, where **every** malformed body is a 500 whatever the parser does, so it could
not have distinguished the two stacks; re-pointing it at `POST /api-token-auth`, whose serializer
*names the fields it received*, made the parse result visible and exposed four differences the
first probe was blind to.

### Open review conditions

Tracked to closure, not carried forward silently. Source:
[`docs/review-phase-0-1.md`](docs/review-phase-0-1.md).

| # | Condition | From | Status |
|---|---|---|---|
| C1 | `formatDateEs()` must distinguish `@db.Date` from `timestamptz` at the type level (rule 5c). | P0 · S1 | ✅ **Closed** (`114d8cf`). Signature narrowed to `PlainDate`; `fromDateColumn` / `toBogotaDate` are the two named conversions; a `Date` is a compile error *and* a runtime `TypeError`. Test pins `28 mar.` vs `29 mar.` for the same instant. |
| C2 | Global BigInt→JSON strategy rendering bare numbers, not strings (rule 5b). | P0 · S2 | ✅ **Closed** (`43759e8`). Express `json replacer` installed by an `AppModule` provider; bigint → **number**, `BigIntPrecisionError` above 2^53 rather than silent loss. Unit + e2e on the raw response text. Recorded in `docs/phase-0-deviations.md` §2.10. |
| C3 | Add a `relativedelta` month-end primitive. **Phase 3's birthday task needs it, long before Phase 7 runs.** | P0 · plan gap | ✅ **Closed** (`a98c732`). `relativedelta.util.ts` + `nextRepeatRunDate`; 104 tests, every value captured from `python-dateutil==2.7.5` on CPython 3.9. Pins two v1 behaviours: a MONTHLY chain from the 31st collapses to the 28th forever, and a leap-day YEARLY task loses 29 February. |
| C4 | Verify the deployed container's `TZ` and record whether v1's `DateField` dates are UTC or Bogotá (rule 5). | P0 · S6 | ✅ **Closed** (`42eed47`). **Bogotá.** `Settings.__init__` does `os.environ['TZ'] = TIME_ZONE; time.tzset()`, verified live at 19:09 Bogotá with the host zone UTC. `todayForAutoNowDateField()` / `nowInstant()` pin each half. Escalation withdrawn; one residual recorded (v1 has no Dockerfile in-repo; conclusion holds for any image shipping tzdata, slim and alpine both verified). |
| C5 | Fix multipart and malformed-JSON request parsing to match v1 (**D18**). | P1 · S3 | ✅ **Closed** (`59700ff`). All three rows fixed, none deviated: multipart parses, unsupported media types 415 with DRF's wording, malformed JSON returns **CPython's** message and offset (`python-json.ts`, 412 structured + 3 000 fuzz cases differentially validated, 0 mismatches). Parsing deferred until after the guards, preserving DRF's authenticate-then-parse order. |
| C6 | `userPatchAllowlist` builds its allowlist from `attempt.fields`, making the "positive allowlist" a tautology. | P1 · S4 | ✅ **Closed** (`9638d2e`). Three frozen field sets transcribed from `services/user.py:208-261`; the allowlist no longer reads the payload. `identification` (D16) is parameterised and tested both ways, awaiting Q26. |
| C7 | `FieldAllowlist.none().assert([])` does not throw. | P1 · S5 | ✅ **Closed** (`5988ac0`). An empty allowlist denies any write including the empty one; a non-empty allowlist still accepts an empty change-set. |
| C8 | The `body.type` gate vs the `changedFields` gate. | P1 · escalated | ✅ **Closed** (`e4c9985`). `resolveSection` + `assertSectionWritable` + the field allowlist, applied in that order; `changedFields` normalises `bigint`/`number`, `Date`/`'YYYY-MM-DD'` and numeric strings so rule 3 cannot fire on an echo. Resolution text below unchanged. |

| C10 | The `@All()` 405 fallback and handlers that never read `request.data` must bypass the parser interceptor. Two regressions found by booting the real pipeline: `PUT /api-token-auth` with `text/plain` → **415 where v1 405s** (the interceptor fires before the fallback), and `ActivityYearView.post` / `UserAppsView.post`'s `birthdates` branch → **415 where v1 succeeds**, because those handlers never read `request.data`. One marker fixes both. | P1 · R1/R2 | ✅ **Closed in P2** (`@DrfNoRequestData()` + the exported `assertRequestDataParsable`, applied to both `@All()` fallbacks; both regressions pinned by e2e cells with a positive control). Awaiting reviewer verification. |
| C11 | `express.json({strict:false})` plus a DRF-shaped non-dict body error; correct the mislabelled parse-error branch and register the >2.5 MB JSON tightening. | P1 · R4/R5 | ✅ **Closed in P2**, with one registered residual: `strict:false` set and six e2e cells pin DRF's `Invalid data. Expected a dictionary, but got <type>.`; the parse-error message now branches on which parser ran; the >2.5 MB JSON tightening is registered. **Residual:** CPython accepts `NaN`/`Infinity` and `JSON.parse` does not — closing that needs a hand-written JSON parser, not a flag. |
| C12 | **Add `express` and `multer` to `dependencies`.** Both are phantom (transitive) today, so a hoisting change could hand the adapter and the middleware **two different Express instances** — silently unsetting C2's `json replacer`, so every money field would render `"1000"` instead of `1000`. | P1 · R7 | ✅ **Closed in P2** — `express@5.2.1` and `multer@2.2.0` added to `dependencies` at the versions platform-express resolves. |
| C13 | One e2e cell proving **403 precedes 415/400** on a guarded route. `test/role-matrix.e2e-spec.ts` builds a partial module without `AppModule`, so it keeps Nest's default parser and never exercises the DRF pipeline — acceptable, but it leaves the ordering unproven. | P1 · R8 | ✅ **Closed in P2** — `test/notification.e2e-spec.ts` → *C13*: a permission-denied caller sending `text/plain` (and separately a malformed JSON body) to `POST /api/notification/subscribe` gets **403**, plus a positive control proving the same requests are 415/400 for an allowed caller. Real guarded route, real body-reading handler. |
| C15 | **N1 — middleware order.** v1 lists `CommonMiddleware` 3rd (`base.py:41`) and `corsheaders.CorsMiddleware` 8th/last (`:46`), so `APPEND_SLASH` fires **before** CORS. `AppModule.configure` applies `DjangoCorsMiddleware` before `DjangoUrlResolverMiddleware`, so a genuine preflight on `/password_reset` is **301 in v1, 200 in v2** (verified). Fix is swapping two entries — preserving `skipBeforeHeadersHooks`, since v1's 301 carries no `Vary`/`X-Frame-Options`/`Access-Control-*`. | P2 · N1 | ✅ **Closed** — and *not* by swapping two entries: the resolver 404 and the `APPEND_SLASH` 301 sit on **opposite sides** of `corsheaders` in v1 (`BaseHandler` is below all eight middlewares), so a swap would have turned the `/nope/nope` preflight from 200 into 404. Split into `DjangoAppendSlashMiddleware` (v1's slot 3) and `DjangoUrlResolverMiddleware` (below slot 8), with `AppModule.configure` documenting all eight rows. Verified live on all four paths, with and without `Origin`: **301/301**, and the resolving and non-resolving preflights still **200/200**. `skipBeforeHeadersHooks` preserved and unit-pinned. |
| C16 | **N2 — `Location` encoding on the `APPEND_SLASH` 301.** Django emits `escape_uri_path(<decoded path>)`; v2 echoes the raw request target. Verified: `POST /password%5Freset` → v1 `Location: /password_reset/`, v2 `/password%5Freset/`. The doc comment in `django-url-resolver.middleware.ts` claiming the two agree is **false** — the routes are ASCII, the request target need not be. | P2 · N2 | ✅ **Closed** — `django-uri-encoding.ts` ports `escape_uri_path`, `iri_to_uri` and `escape_leading_slashes`; every expectation in its spec came out of the real functions in the v1 container. `Location` is now built from `PATH_INFO`. Verified live: all five encoded targets and the query cases agree byte-for-byte. The false doc comment is gone. |
| ~~C18~~ | ✅ **Closed** (`1c3f3d9`). Root cause is one layer below Django: gunicorn's `create()` (`http/wsgi.py:191-194`) copies only `req.query` and `req.path` into the environ — the fragment survives solely in `RAW_URI`, which Django never reads. Fixed in `splitQuery`, which fixes the path and the `Location` together. Two shapes beyond the original report also diverged and now match: `#frag?a=1` (the `?` is inside the fragment, so there is **no query**) and a bare trailing `#`. Verified: all five shapes identical live, `%23` control still 404/404. | P2 · N4 | ✅ |
| ~~C18-orig~~ | **N4 — a literal `#` in the request target.** gunicorn parses with `urlsplit` and drops the fragment; v2's `splitQuery` (`src/common/http/request-target.ts`) splits on `?` only. Verified: `POST /password_reset#frag` → **v1 301 `Location: /password_reset/`, v2 404**; `POST /password_reset?a=1#frag` → v1 `Location: /password_reset/?a=1`, v2 `…?a=1#frag`. Pre-existing, fail-closed, unreachable from a conforming client (RFC 9110 §7.1) — but it is the other half of rule 14's own second sub-rule. ~2-line fix. | P2 · N4 | ⬜ non-gating |
| C17 | **N3 — percent-encoded literal path segments** (pre-existing, not a regression). The URL conf decodes them correctly; **Nest's Express router does not.** `POST /api%2Dtoken%2Dauth` → v1 **400**, v2 **404** (verified) — an *implemented* Phase 1 route. Mirror image of F2 and cross-cutting for Phases 3–8. | P2 · N3 | ✅ **Closed in P2** (not carried to the P3 gate) — the resolver hands Nest's router `escape_uri_path(PATH_INFO)` once the table has matched, and `AppModule` mounts its middleware at `/` so Express cannot undo the rewrite. `POST /api%2Dtoken%2Dauth` → **400 in both**, `POST /api/%6Eotification/subscribe` → **200 + row / 401** in both. Fail-closed direction re-checked: `/%41PI/notification/subscribe` still 404s (decoding cannot smuggle a path v1 refuses). |
| C14 | ⚠️ **`app.enableCors()` terminated every `OPTIONS` with 204 before the router, guards and `@All()` fallback** — with or without an `Origin` header, so a bare `OPTIONS /api/notification/subscribe` was 401/403 in v1 and 204 in v2: **auth bypassed on that verb**. | P2 · F1 | ✅ **Closed** — `enableCors` removed; `DjangoCorsMiddleware` ports `corsheaders 2.4.0` under v1's settings and short-circuits **only** a genuine preflight (which v1 does without requiring `Origin`, and on any path). Bare `OPTIONS` now 401/403; preflight 200 with `Content-Length: 0`, `Vary: Origin`, `Max-Age: 86400`. Registered in `AppModule`, so the e2e suites exercise it. P1-D2's v2 column corrected in `docs/phase-1-deviations.md`. |
| C9 | **S7 — detail-route trailing slashes**, plus P2-D5 (the `[a-zA-Z]+` operation constraint) and F2 (case-insensitive routing): three instances of one gap, all needing a pre-guard URL layer. | P1 · S7 | ✅ **Closed in P2, in full** (see `docs/phase-2-deviations.md` §2.11 for why not in P3). All 22 v1 `url()` patterns transcribed in `django-url-conf.ts` with the line each came from; `DjangoUrlResolverMiddleware` resolves before the guards and also does `APPEND_SLASH`. **Fail-closed.** `POST /API/notification/subscribe` no longer writes a row, `/api/loan/5/` and `/api/user/5/` 404 as in v1, `POST /password_reset` 301s. 53 unit + 15 e2e cells; the whole `urls.py` swept against the live v1. |
| C68 | **The run summary never reaches a log, and the runbook check cannot tell a completed pass from a dead one.** `handleCron` discards `run()`'s return value, so the promised `failedDelivery` count is computed and thrown away; a whole-pass failure goes to `@nestjs/schedule`'s default `console.error`, so `grep -c 'Running scheduler'` returns **2** whether the pass processed 110 rows or died on the next statement. **The phase wrote that grep as its own verification step** — C67's rule failing on the phase that introduced it. | P7b · major | ✅ **Closed by Phase 6** (`cda69e0`). The summary now reaches a log and the runbook string changed: `Running scheduler` is emitted *before* any work, so it could not fail — retired in favour of `Scheduler pass finished` (expect **2**) paired with `Scheduler pass failed` (expect **0**), both emitted only at the *end* of a pass. ⚠️ **This is also D12's detection story** — a CAP that silently stops closing is caught exactly as a reminder that silently stops sending. ⚠️ **THREE sites, not two — my clause here said "both" and was wrong for a day.** `MIGRATION_PLAN.md`'s two were corrected 2026-09-07; the third, `docs/phase-7b-deviations.md` §5.4, was not — **and `docs/phase-6-deviations.md` §7.1 had named it explicitly in its own fold-back.** I was handed the answer and applied the sites I had already found. It is also the site that mattered most: that document is the one an operator has open during a cutover. Corrected 2026-09-08; found by `nestjs-reviewer`. *"I corrected the sites I found" is not the claim "I corrected the sites that exist"* — only the second is worth writing down. |
| C69 | **A failed `release()` swallows the executer's error and silently keeps the row `processed`.** If `release()` rejects, the `throw error` after it is unreachable: the executer's error is destroyed and the row stays claimed with nothing sent — a lost notification, filed as a database error. | P7b · major | ✅ **Closed by Phase 6** (`cda69e0`). A rejecting `release()` no longer destroys the executer's error. |
| C70 | **`SCHEDULER_ENABLED` fails closed on a typo.** `SCHEDULER_ENABLED=ture` is silently `false`, and the spec *pins* that leniency. Zero instances — nobody holding the flag, nothing erroring, reminders simply stopping — is the failure mode §7.2 names as the most likely cutover mistake, because it is the default. | P7b · major | ✅ **Closed by Phase 6** (`cda69e0`). An unrecognised `SCHEDULER_ENABLED` value now fails the boot instead of silently reading as `false`; +9 cells in `env.validation.spec.ts`. |
| C71 | **D7 has a forward-going birthday consequence no register row covers, and the drain does not fix it.** A birthdate set or corrected *after* the member's birthday writes an already-past-due task. Under v1's `=` it never fires; under D7's `<=` it fires on the next pass and pushes *"Hoy está cumpliendo años X"* to the whole roster **on the wrong day**. Backlog drainage does not touch it — every future correction recreates it. | P7b · major | ✅ **Closed** — implemented as **D48** (Phase 8b); Ainhoa's chain starts at 2027-08-05 when her profile is saved in v2 (v1 cannot save it: D15, 409). |
| C72 | **Runbook step 3a terminated a live yearly birthday chain** — the exact harm its two-day grace exists to prevent. Draining a *repeating* task writes no clone, so it does not skip one delivery: it ends the chain permanently and silently. | P7b · major | ✅ **Code half closed** (`cfa57ea`) — step 3a now carries `AND repeat = 0`, plus a post-drain check that confirms **intent** (`chains_left_alive`) rather than statement. Measured: of the 108 rows the predicate hits, **107 are `repeat = 0`**; the one exception is task **1497** (`repeat = 4`, 2024-03-02, owner 3 `is_active = false`). 🟡 **Policy half → `business-analyst`**: task 1497's disposition, and F4's Q34 wording. |
| C73 | **F2 — `Sending request to MNS...` is neither ported nor registered.** `fondo_api/celery/tasks.py:15` logs it on every publish; v2 emits `Message sent, id: …` and the error line but not this one. `grep "Sending request to MNS" docs/*.md` returns nothing. Phase 2 origin, surfaced here because this phase is the line's main caller. | P7b · minor | ✅ **Closed by Phase 6** (`cda69e0`) — **ported**, per `nestjs-reviewer`'s stated preference: one line at the top of `publish()`, +3 cells. |
| C74 | **Write down what D12 inherits, before D12 exists.** Two assumptions a Phase 6 developer would get wrong by reading `SchedulerExecuterOutcome` in good faith: (1) **`ok: false` is the wrong channel for a CAP auto-close failure** — it was decided by **Q6** for a *lost push*, and for a CAP it means "task processed, CAP still open, one WARN", a financial-state divergence no later pass repairs; **D12's executer must throw**. (2) **The claim-then-crash window loses executer work silently** — one missed push for a notification, a CAP left open with its task marked done for D12; so D12 must be **idempotent and independently reconcilable**, not assume the runner guarantees the side effect. | P7b · **minor in effort, 🔴 gates P6's start** — the effort estimate was load-bearing for *why* it gated the start rather than the gate | ✅ **Closed** (`a191f74`) — written into `SchedulerExecuterOutcome`'s docblock (what a Phase 6 developer actually reads), `docs/phase-7b-deviations.md` §7.4 items 3–4, and §3 Phase 6 *Risks*. Comment-only: **0 code-token differences**, proved by a `ts.createScanner` tokeniser and **controlled twice** (20 differences across `20ac132`; a targeted `readonly ok?:` mutant on the edited file → `MUTANT DETECTED`). Gate at baseline by exit code. ⚠️ **Two design points raised by `nestjs-developer`, verified by me, since sustained by `nestjs-reviewer` and carried as C77 and C78 — whose wording supersedes this row's:** (a) **"must throw" is safe only because D12's task is `repeat = 0`** — confirmed in `scheduler.runner.ts`, the `catch` does `release` then `throw`, and `createRepeatInstance` sits *after* that block, so a throw skips the clone; give the close task a non-zero `repeat` and "must throw" silently reintroduces the exact chain-breaking failure **Q6** chose `ok: false` to avoid. (b) **C74's two remedies are not interchangeable** — "derive closed-ness from `end_date` on read" ripples into a *ported* Phase 3 response: v1's `UserFinanceSerializer.get_total_savingaccounts` (`fondo_api/serializers.py:32-35`) sums `SavingAccount` rows with `state=0`, and `state` is `0=ACTIVE / 1=CLOSED` (`fondo_api/models.py:137-140`), so a CAP closed only by derivation keeps counting in `total_savingaccounts`. The reconciliation-query alternative has no such ripple. **C78 has since ruled derivation out entirely** — the four sites C74 wrote now carry the reconciliation query alone. ⚠️ C74's *Location* line misfiles §7.4 in `MIGRATION_PLAN.md`; §7.4 is in `docs/phase-7b-deviations.md`. |
| C75 | **Two unregistered log-stream differences.** v2 passes `error.stack` as `Logger.error`'s second argument, so every caught error emits a **stack block v1 never prints**; and the two new WARN lines (`skippedClaimed`, `failedDelivery`) have no v1 counterpart. Both additive, both improvements, neither touches a row or a byte — but the register's value is that it is complete. | P7b · minor | ✅ **Closed by Phase 6** (`cda69e0`) — registered, and the register grew in the counting: **four** additive lines (C68's two, C69's stuck-claim line, and Phase 7b's two WARNs) plus three lines carrying a stack trace v1 never prints. |
| C76 | **No cell pins the UTC-space clone where the Bogotá day and the UTC day differ.** Every clone cell — unit, e2e and every parity ME cell — uses `05:00Z`, where the two dates agree, so nothing distinguishes v1's **UTC-field** arithmetic from a Bogotá-local implementation and a future "fix" to local-space would pass the whole suite. Suggested discriminating cell: `run_date = 2026-01-31T01:00:00.000Z`, `repeat = 3` → UTC-space `2026-02-28T01:00:00.000Z` vs Bogotá-local `2026-03-01T01:00:00.000Z`. **One day apart.** | P7b · nit | ✅ **Closed by Phase 6** (`cda69e0`) — with **four** cells, not the one suggested. ⚠️ **The suggested discriminating cell did not discriminate**, and only a mutation control found that: a `fromDateColumn → toBogotaDate` mutant *passed* it, because a MONTHLY hop into February is where `min(28,31)` and `min(28,30)` are both 28 and the clamp collapses the difference. *"The two dates disagree"* is **two** properties — *read-local* (wrong start day) and *round-trip-local* (wrong pinned wall time). Each mutant now fails exactly 2 of 50 cells; restored, all 50 pass. The **YEARLY read-local** cell is the one that matters live: every birthday chain is `repeat = 4`, and read-local would greet a member **a day early, every year**. |
| C77 | **The throw rule must be stated as a function of `repeat`, and D12's close task must be `repeat = 0`.** C74 restated **Q6** on the money/not-money axis; that is true for D12 and **incomplete as a rule**. Q6's decision was really about `repeat`: `ok: false` buys chain survival at the cost of one occurrence, a trade that only has a numerator when there *is* a chain. Verified mechanism: `scheduler.runner.ts` releases and rethrows **before** `createRepeatInstance`, so a throw skips the clone — give the close task a non-zero `repeat` and "must throw" reintroduces exactly the chain-breaking failure Q6 avoided. | P7b → P6 · raised by `nestjs-developer`, sustained by `nestjs-reviewer` | ✅ **Code obligations discharged by Phase 6** (`cda69e0`): `repeat = 0` literal at the task-creation site, a cell asserting the inserted row's `repeat`, and the throwing-executer cell. ⚠️ **But obligation (iii) was VACUOUS as I worded it, and `nestjs-developer` proved it by mutation.** I wrote that the no-clone cell *"is the only one that catches someone later 'fixing' the runner to clone before running"*. It catches nothing on a `repeat = 0` task: `createRepeatInstance` returns early on `SchedulerRepeat.NONE`, so "writes no clone" is true under **either** ordering. Measured: a runner mutated to clone before running **passes the entire 98-cell e2e suite** and fails only **2 unit cells**. Only a `repeat = 4` variant discriminates, and one now exists — recorded in both the e2e file and the deviations doc so nobody deletes it as redundant. |
| C78 | **C74's two remedies are not interchangeable; narrow it to the reconciliation query.** "Derive closed-ness from `end_date` on read" is not a design option with a cost — v2 **already ships** the port (`src/users/user.service.ts:389` aggregates `savingAccount` at `state: 0`), so it would mean editing a **Phase 3 path that has already passed its gate**, plus Phase 6's own `state` filter. Two further reasons from `nestjs-reviewer`: it creates **two sources of truth in a one-column state model** (what does a treasurer's `PUT state = 0` mean on a row whose `end_date` is past?), and it **defeats C74's purpose** — a derivation is not an independent check, it makes the runner's failure invisible rather than detectable, which is the zero-instance failure mode again. | P7b → P6 · raised by `nestjs-developer`, sustained and strengthened by `nestjs-reviewer` | ✅ **Code obligations discharged by Phase 6** (`cda69e0`). Close is the compare-and-set `UPDATE … SET state = 1 WHERE id = ? AND state = 0`; `findUnclosedPastDue` is the reconciliation query. ⚠️ **The cross-phase risk was verified in-suite rather than in a document** — four e2e cells read the **Phase 3** `GET /api/user/<id>` response before and after each kind of CAP write, D12's auto-close included, asserting `total_savingaccounts` moves and every other finance field is byte-identical. The auto-close cell is the load-bearing one: D12 drops a CAP out of a *ported* Phase 3 response silently, and nothing else in the suite would have noticed. |
| C79 | **Does D22 stand on `POST /api/file`?** There v1 answers every invalid boundary with 500, so D22's rationale does not hold, and applying it yields v1 500 / v2 400 for a non-ASCII boundary only. | P8 · raised by `nestjs-developer` | ✅ **Closed** — implemented at `8948f79` (D22 branch removed, `zzé` in the uncaught-500 table, inverted mutant killed); re-measured 500/500 by `manual-tester` at `8948f79` (`docs/parity-phase-8.md` §1.5, `1750256`). |
| C80 | **D45: escape U+2028/U+2029 in JSON like DRF, or register the difference permanently?** Affects any response carrying user text with those characters, in every phase. | P8 · P8-F4 | ✅ **Closed** — D45 registered permanently, no fix (ruled 2026-09-14); harness rule to compare parsed JSON when a body contains U+2028/U+2029. |
| C81 | **Measure P8-F5 on the approved routes.** `readUploadedFile` now takes the last same-named part; that was measured on `POST /api/file` only. Measure `PATCH /api/user` (Phase 3) and `PATCH /api/loan` (Phase 4) with two `file` parts against v1. | P8 · P8-F5 | ✅ **Closed by measurement** (2026-09-14, `docs/parity-phase-8.md`): on both `PATCH /api/user` and `PATCH /api/loan`, v1 and v2 process the **second** of two `file` parts; with a body scalar `file` plus a file part, both process the file part in either order; a scalar `file` alone is 500 on both. All 10 row snapshots are equal. |
| C82 | **P8-F1–F3 — keep v1's partial writes or change them?** Cross-type duplicate name leaves an orphaned object; a name differing only in case silently replaces another row's object; `type` is unvalidated. | P8 · findings | ✅ **Closed** — decided Q40–Q42, implemented at `5f58b11` (D46, D47); follow-ups Q44–Q46 answered. Known residual: D46's concurrent window (Q45). |
| C83 | Three copies of the out-of-range path-id rule (`loans/loan-path-id.ts`, `activities/activity-path-id.ts`, `common/http/django-int-path-id.ts`, counted at `71cd7de`); hoist the first two onto the common one. | P8 · fold-back 7.7 | ⬜ **Agreed non-gating** (ruled 2026-09-14): the three helpers have byte-identical bodies; hoist them in Phase 9's cleanup, or whenever one is next touched. |
| C84 | **`fonmon` may already hold orphaned objects from v1.** v1 has no way to delete a file row, and six ids are missing (16, 21, 34, 35, 40, 41), near upload dates — consistent with failed uploads that stored an object first (P8-F1), but not proof. No one on this machine has bucket access. Before cutover, someone who does compares `fonmon`'s object paths against the paths of the live `File` rows. | P8 · `business-analyst` | ⬜ **Operator action, before cutover** (Phase 9) |
| C85 | **`Vary: Origin` on init-time multipart 500s.** On `POST /api/file` with an unparseable multipart body (an empty boundary, or a quoted trailing-space boundary), v1 serves gunicorn's page with **no `Vary` header** and v2 sends **`Vary: Origin`**. Status matches; `docs/phase-8-deviations.md` had claimed the headers matched too. Measured by `manual-tester`. | P8 · parity round | ✅ **Closed** — belongs to P8-D4, no fix; `Vary: Origin` pinned in `expectUncaught500` at `8948f79`. On the four `GET /api/file?type=…` 500s the same pin is **measured parity** (`p8r/out/ro.jsonl`). |
| C86 | **`X-Frame-Options: SAMEORIGIN` on init-time multipart 500s.** Found in the C79 re-measure: v2 sends it (one hook for every route, `django-response-headers.middleware.ts:62`), v1's gunicorn page does not — the same cause as C85's missing `Vary`. | P8 · C79 re-measure | ✅ **Closed** — ruled by `nestjs-reviewer` 2026-09-14: register only, no fix, non-gating; D22/D24 wording widened (v4.24). Pinned in `expectUncaught500` at `a963e5f`, with a control that removes the header and fails the suite (7 cells). On the `G-type-*` 500s the header is parity inferred from code, not measured. |
| C87 | **`docs/phase-8b-deviations.md` §6 Q-8b-2 says a malformed `owner_id` ends the yearly chain.** It does not: the executer throws, the runner releases the row unprocessed and it is retried and logged at every pass. Whoever repairs such a row must also move `run_date` to the next birthday, or it sends a wrong-day *"hoy"*. | P8b · `business-analyst` | ✅ **Closed** — corrected at all three sites at `796ba2b` ("stalls, not ends"), with the repair note; re-checked by `nestjs-reviewer`. |
| C88 | **An `owner_id` above int4 throws instead of skipping as a missing owner.** `notification.executer.ts` claims `MAX_INT4 + 1` answers `missing` with no out-of-range bind, but `MemberDirectory.ownerStatus` passes it to `findUnique`; measured by `nestjs-reviewer` with the repo's Prisma client on `fondo_api_test`: `2147483647` → `null`, `2147483648` → **P2020** out of range. The row would stay unprocessed and log every pass instead of the registered skip-and-clone (§2.2). 0 of 86 `fondodev` birthday rows reach it. | P8b · review M1 | ✅ **Closed** — fix (a) at `796ba2b`: above int4 skips as missing with no query; e2e `99999999999` on the real column and a `findUnique` spy on the 2147483647 / 2147483648 pair; mutants N1–N3 killed, B5 survives. Re-checked by `nestjs-reviewer`. |
| C89 | **D48's zone and the runner's selection zone come from different sources.** `nextBirthdayRunDate` and the cron use the constant `America/Bogota`; the runner's "today" uses the free `TIME_ZONE` env string. A deploy with another `TIME_ZONE` would greet a day early or late at the year edge. Pass hours cannot drift unnoticed (two metadata cells); the zone can. | P8b · review m2 | ✅ **Closed** — `TIME_ZONE` pinned to `America/Bogota` at `796ba2b`; the runner, the repository's dedupe and due-task selection, D48 and the cron now share one zone (`nestjs-reviewer` confirmed the three config readers and every in-repo deploy path). **Runbook step 3** now checks production's `TIME_ZONE` before first boot (N3). |
| C90 | **Two test nits from the Phase 8b re-check.** (N1) `src/scheduler/zone-single-source.spec.ts:98-101` compares `nextBirthdayRunDate` with and without `env.TIME_ZONE`, which is the same call under the pin — the later today/next-year check is what ties D48 to the runner; drop the line or reword its comment. (N2) `:26` copies the dev database credential literal into one more spec (already in six files; `validateEnv` never connects) — use a placeholder password and a non-`fondodev` name. | P8b · re-check N1, N2 | ⬜ **Non-gating** — Phase 9 cleanup, with C83. |

*(C9 was raised in the first review's Phase 1 gate and lost when I transcribed the conditions
into this table. `nestjs-developer` correctly flagged it rather than acting outside its brief.)*

### C8 resolved — the two rules operate at different levels

They are not in conflict once ordered. `update_user` (`services/user.py:100`) dispatches on
`obj['type']` and **ignores every other section in the body**. So:

1. **`body.type` gates the section.** If `type == 'finance'` and the caller is neither ADMIN nor
   TREASURER → **403**, whether the `finance` object is empty, unchanged, or absent. The declared
   intent is what is refused, not the diff.
2. **A section the caller did not declare is irrelevant.** With `type == 'personal'`, a `finance`
   key in the body is ignored by v1 and must be ignored by v2 — never a 403. This is what makes
   every member's ordinary save work, since v1's client posts both sections every time.
3. **`changedFields` gates privileged *fields within* the dispatched section** — `role` (D1) and
   `identification` (D16, pending Q26). 403 only on an actual change, so echoing an unchanged
   value is fine.

Level 1 answers "may you touch this section at all", level 3 answers "may you change this field".
The reviewer's empty-`finance` case is therefore a **403** — it is a declared finance write by an
unprivileged caller — and C7's silent no-op cannot arise, because the refusal happens at the type
gate before any field comparison. `FieldAllowlist.assert()` must still fail closed on an empty
set, as defence in depth rather than as the primary control.

**Phase status board**

Updated **2026-09-06**, plan rev **v3.7**. Ordered by execution sequence, not by number — 7a was
pulled forward into Phase 3 (condition C24) and 7b waited on Phase 4.

> **Read this first for status.** The **Now** block below is the single place that says what is
> happening at this moment. The table under it is the whole migration; the Conditions column is
> the honest ledger of what each closed phase still owes.

### ▶ Now — Phase 8b closed; Phase 9 next.

| | |
|---|---|
| **Phase 8b — Birthday notifications** | ✅ **CLOSED — approved.** `nestjs-reviewer` approved the fix round at `796ba2b` (C88 int4 `owner_id` guard, C89 one zone, C87 wording). Gate on `796ba2b` re-measured by me: lint 0, `tsc` 0, 2590 / 80 unit, 1348 + 2 e2e, fixture diff 0 / control 1; register hashes match the commit (17 of 17). `manual-tester` PASS; `business-analyst` aligned, runbook concern resolved by Q51/Q52. |
| **Phase 9 — Cutover, hstore→jsonb, decommission** | 🟡 **Next.** The operator performs the cutover; this phase delivers the runbook and the post-switch migrations (step 6 hstore→jsonb, D6's and D11's unique constraints, D34's ledgers). Non-gating cleanup rides along: **C83** path-id hoist, **C90** two test nits. |
| **Operator actions before cutover** | **C84** — someone with bucket access compares `fonmon` against the live `File` rows. **Runbook step 3** — confirm production's `TIME_ZONE` is unset or exactly `America/Bogota` (C89). |
| ⏰ **Dated deadline** | **Task 2142 fires 14 November 2026 under v1** — Angi Paola, `is_active = f`. **Q51: delete it** — on v1's production database before that date if cutover has not happened. Runbook **step 3a-bis**. |

⚠️ **Sequencing corrected 2026-09-07 — the board had Phase 6 next and that was wrong.** §3's
Phase 7 block says *"Resequenced (v0.3): run this directly after Phase 4, before Phases 5/6"*, and
**Phase 6 depends on Phase 7**: D12's automatic CAP close needs a `SchedulerTask` **type**, which
only 7b's runner can execute. D12's own row says "so Phase 6 depends on Phase 7 — already
sequenced that way", and the board had quietly stopped being sequenced that way. Phase 5 running
first was harmless — `activity.service.ts` writes no scheduler rows, verified — but Phase 6 before
7b would have meant building an auto-close nothing could run.

**Why 7b is the right next phase on its own merits**, from §3: it is the **sole delivery path for
loan payment reminders**, has **zero inherited tests**, is raw-SQL hstore territory, and **fails
silently** — `scheduler/tasks.py` marks a task `processed` after `executer.run()` returns while
`send_notification` swallows its errors, so a failed publish is recorded as a success. The plan
calls it *the highest ratio of consequence to coverage in the migration*, and it is the last
thing standing between the fund and losing payment reminders at cutover.

✅ **Both operator questions on Phase 6's D12 are answered (2026-09-07, Q38 / Q39), before the
phase started.** A CAP already past `end_date` on ship day is **closed** — C78's reconciliation
query doubles as the backfill, and there is exactly **one** such row on `fondodev`. The close runs
on the **10:00 Bogotá pass only**, which **needs no code**: selection is date-granularity and the
10:00 pass claims the row, so the 14:00 pass already skips it.

| Phase | Status | Dev | Tester | Reviewer | Analyst | Conditions |
|---|---|---|---|---|---|---|
| — Prereq: dev DB at 0019 | ✅ **Cleared** | — | — | — | — | — |
| 0 Foundations & Prisma baseline | ✅ **CLOSED** (`b3effab`) | ✅ | n/a | ✅ **Approved** | n/a | C1–C8 ✅ closed (v0.14 / v1.0) |
| 1 Auth + roles | ✅ **CLOSED** (`151314f`) | ✅ | ⬜ never run | ✅ **Approved** | ⬜ | C1–C8 ✅; **C9–C13 ✅ closed** — audited against the tree 2026-09-04 |
| 2 Mail + notifications | ✅ **CLOSED — approved w/ conditions** (`fe261fc`) | ✅ | ✅ PASS r3 | ✅ **Approved w/ conditions** | ⬜ | **all ✅ closed** — C22–C25 (`5f4120f`, `af596b0`); C19–C21 audited against the tree; C26, C27 closed in the C58 audit |
| 3 Users + finance | ✅ **CLOSED — approved w/ conditions** (`e926e14`) | ✅ | ✅ PASS r4 | ✅ **Approved** (C28–C39) | ✅ Aligned | **all ✅ closed** — C31–C35, C37, C39 closed in the C58 audit (`035a23a`) |
| 7a Scheduler *write half* | ✅ **Landed with P3** (`af596b0`) | ✅ | ⬜ | ⬜ | ⬜ | pulled forward by **C24** |
| 4 Loans | ✅ **CLOSED — approved w/ conditions, both rounds** (`806ca6e`) | ✅ | ✅ PASS + ✅ **delta PASS** (`17114a0`) | ✅ **Approved** (C40–C49) + ✅ **delta approved** (C50–C58) | ✅ C29/C30/C42 | C40–C43, C50, C51 ✅; **C44–C49, C52–C58 🟡 open → P5 gate** |
| 5 Activities | ✅ **CLOSED — approved w/ conditions** (`d89f801`) | ✅ | ✅ **PASS r3** (three rounds) | ✅ **Approved** (C59–C67) | ✅ Q32/Q33 | **C59, C60, C62 ✅ closed** (`19c5d4d`), **C67 ✅ closed** (`b8f73ce`) — the row read "🔴 gate P6's start" until 2026-09-07; C60 re-verified **behaviourally**, not by string match: `pythonIntStrip` exists and both `python-obj.ts` call sites use it instead of `trim()`. C61, C63–C66 🟡 → P6 gate |
| 6 Saving accounts (CAPs) | ✅ **CLOSED — approved** (re-check #7, `5194a29`) | ✅ | ✅ PASS w/ 3 failures — all in Phase 0/3 helpers, all fixed | ✅ **APPROVED** after 6 changes-requested cycles | ✅ Q19–Q24, Q35–Q39 | C68–C70, C73, C75–C78 ✅; B1–B3 ✅; Majors 1–10 ✅; D40–D44 registered; §4 rules 15/15b; ⚠️ **C71, D39 open with no owning phase** |
| 7b Scheduler *runner* | ✅ **CLOSED — approved w/ conditions** (`a191f74`) | ✅ | ✅ **PASS** (`3659eef`; no re-round — nothing conditioned changes a row, a byte, a status or a body) | ✅ **Approved w/ conditions** (C68–C76) | 🟡 **C71, C72 dispatched** | **C74 ✅ closed** (`a191f74`, gated P6's start); **C72 code half ✅** (`cfa57ea`); C68–C70, C73, C75, C76 🟡 → P6 gate; **C71 + C72 policy half → `business-analyst`** |
| 8 Files + admin | ✅ **CLOSED — approved** (re-check of `8948f79`; docs `935f3fb`, `1750256`; C86 pin `a963e5f`) | ✅ | ✅ **PASS** + ✅ C79 re-measure (500/500) | ✅ **Approved** after one narrow changes-requested round | ✅ `ba-phase-8-files.md` | C79–C82, C85, C86 ✅; D45–D47 registered/implemented; C83 non-gating (P9 cleanup); **C84 operator action before cutover** |
| 8b Birthday notifications | ✅ **CLOSED — approved** (re-check of `796ba2b`) | ✅ | ✅ **PASS** (`parity-phase-8b.md`) | ✅ **Approved** after one conditions round | ✅ `ba-phase-8b-birthdays.md` — concerns resolved by **Q51**/**Q52** | C71, C87–C89 ✅; D39, D48, D49 implemented; **C90** non-gating (P9 cleanup); runbook 3a/3a-bis delete 1497/2142; ⏰ task 2142 deadline 14 November 2026 |
| 9 Cutover, hstore→jsonb | 🟡 **STARTING** — P8 and P8b closed; `nestjs-developer` (step-6 migrations, D34, D6/D11 constraints, runbook) and `business-analyst` (C49 re-decisions for the operator) dispatched | ⬜ | ⬜ | ⬜ | ⬜ | **C39** lands here; **C49** re-decisions; C83, C90 cleanup; C84 operator action |

**Legend.** ✅ done · 🟡 next / open-but-tracked · 🔴 overdue · ⬜ not started · ⚠️ unverified.
"Ready" means no unmet dependency, not scheduled next.

> ✅ **C58 is discharged (2026-09-04, `035a23a`).** All fifteen tracked conditions were audited
> **against the tree, not against their status lines**: C9–C13, C19–C21, C31, C33 were already
> satisfied and are now recorded as such; C26, C27, C32, C34, C35, C37, C39 were genuinely open
> and were closed. **C34 was a real precision bug** — `normalise` compared BigInt money columns
> through `Number()`, so a change past 2^53 read as a no-op. **C35's docblock asserted a security
> property the code did not have.** Nothing rolled a third time.

> ⚠️ **Two of my own audit verdicts were wrong, both in the "closed" direction** — see false-green
> **#20**. I matched strings instead of reading behaviour: C32's `orderBy` was computed and then
> discarded, and two C37 cells I called present did not exist. The ten I cleared were re-checked
> by reading the behaviour before the batch shipped. **An audit that clears a condition must
> exercise it or read the whole function.**

> ⚠️ **A second, header-less copy of this table used to sit here** and has been removed. It was stale in three rows at once — Phase 5 "🟡 Next — no §5 rows of its own", Phase 6 "🔴 Blocked on Q19–Q24", Phase 7b "Blocked on P4" — all of which the board above contradicts, and it rendered as broken markdown because its header row was missing. **The board above is the only one.**

---

## 8. CI/CD (reuse the existing shape)

Adapt `buildspec.yml` rather than replacing it:

| Phase | v1 | v2 |
|---|---|---|
| `install` | Python 3.9, `pip install -r requirements.txt` | **Node 24**, `npm ci` |
| `pre_build` | `CREATE EXTENSION hstore`, `manage.py migrate` | `CREATE EXTENSION hstore` (until Phase 9), `prisma migrate deploy` |
| `build` | `coverage run manage.py test` — the suite is the gate | `npm run lint && npm run typecheck && npm test && npm run test:e2e` |
| `post_build` | `scripts/trigger-deploy.sh` → SSM → EC2 | unchanged |

- Keep the SSM deploy trigger and its `master`-branch-and-PUSH-only guard.
- Keep the `run-server.sh` container-role pattern. ✅ **Settled in 7b:** v1's four roles
  (`api`, `worker`, `scheduler`, `sch_work`) collapse to **one image with a flag**. Every
  process runs `node dist/main`; **exactly one** of them sets `SCHEDULER_ENABLED=true` and is
  the beat replacement. Nothing else distinguishes them, and no `worker` process remains — the
  SQS publish is inline (Phase 2). ⚠️ The flag defaults to **false**, so a deployment that
  forgets it runs no scheduler at all and says nothing about it; §3 Phase 7's *Risks* gives
  the positive check.
- v1 has **no lint step**. v2 adds lint + typecheck to the gate.

---

## 9. business-analyst review outcome & operator decisions

Full note: [`docs/ba-review-v0.2.md`](docs/ba-review-v0.2.md). BA verdict: **Concerns** — resolved
by the §5 register. Operator answered 13 of 24 questions on 2026-08-30.

### Answered — folded in

| Q | Topic | Answer | Effect |
|---|---|---|---|
| Q1 | Loan auto-close intent | Intended; no notification needed | Port as-is, silent |
| Q2 | Guard against post-file approvals | No, keep v1 | No guard |
| Q3 | Return closed-loan list / cap the count | Return the list; **no cap** | **D8** |
| Q4 | Rate frozen at request | Yes | Confirms v1 |
| Q5 | Concurrent refinance requests | Keep v1 | Port broken linkage |
| Q6 | Retry failed reminders next run | Keep v1 (best-effort) | No cross-run retry |
| Q7 | Email fallback for reminders | No — push only | Gap accepted |
| Q8 | Past-dated reminder | **Send immediately** | **D7** |
| Q9 | Term outside 1–36 | **Reject `400`** | **D4** |
| Q12 | Quota source | Treasurer's file only | Confirms v1; over-quota gap accepted |
| Q14 | Legal state transitions | **Enforce** | **D9** |
| Q15 | `PATCH /api/user/<id>` | **Restrict** — admin: all; treasurer: finance only | **D1** |
| Q16 | Loan read by id | **Restrict** to owner + `[0,1,2]` | **D10** |
| Q17 | Power approval | **Restrict** to requestee | **D2** |
| Q13 | Alexa users | Moot — skill retired | Closed |

### Answered 2026-08-30 (second round)

| Q | Topic | Answer | Effect |
|---|---|---|---|
| Q10 | Power letter recipients | **All members** | Confirms v1 |
| Q13 | Alexa users | None — safe to remove | Closed |
| Q18 | `To:` → `Bcc:` | **Yes** | **D5** decided |
| Q19 | What a CAP is | Fixed-term deposit, **no interest or earnings** | P6 spec |
| Q20 | When a CAP closes | **Automatically on `end_date`** | **D12** — new build |
| Q21 | `value` on `PUT` | New total balance | Confirms v1 |
| Q22 | Who may act on CAPs | **ADMIN + TREASURER only**, no notifications | Confirms v1; **D3 withdrawn** |
| Q23 | PRESIDENT and CAPs | **Not allowed** — deliberate | **D3 withdrawn** |
| Q24 | CAP ↔ quota | Purely informative | Confirms v1 |
| Q25 | PRESIDENT and `PATCH /api/user` | Not allowed — ⚠️ *scope being confirmed* | **D1** |

### Answered 2026-09-02 (third round)

| Q | Topic | Answer | Effect |
|---|---|---|---|
| Q26 | `identification` ADMIN-only? | **Yes** | **D16** decided — implemented in P3 |
| Q27 | Who gets the reset link on a shared email? | **The account whose `username` is the email** | **D17** decided — implemented in P3 |
| Q29a | Does any client screen let a MEMBER read another member's detail/finance? | **No — members only see themselves** | **D25** proceeds; **D10 not reopened** |
| Q30a | How does a member change who holds their proxy? | **A second request supersedes the first** | **D26** proceeds; ⚠️ **no uniqueness rule** |
| Q31 | May a TREASURER approve their own loan? | **Yes — normal fund practice** | **D28 withdrawn**; **m6** accepted as-is |

Q1–Q27 are answered. The only open *inference* is the TREASURER self-service cell in the D1
table (§5), flagged there.

### Open — raised by the Phase 3 implementation

| Q | Topic | Blocks |
|---|---|---|
| **Q28** | **D5's empty `To`.** The power-of-attorney letter now goes out with `ToAddresses: []` and every member in `Bcc` — the literal reading of "move them to `Bcc`". SES accepts it, but a message with no `To:` header is scored more harshly by some spam filters and this is a formal document. The alternative is `To: <DEFAULT_FROM_EMAIL>`. Confirm before the first real approval after cutover; one-line change either way. | Nothing — recorded, not blocking |

### Open — raised by the Phase 7b implementation

| Q | Topic | Blocks |
|---|---|---|
| **Q34** | ⚠️ **D7's backlog — P7-D1.** D7 says a past-due reminder is *sent* rather than skipped. But *"has passed"* and *"was never picked up, because v1 skips it"* are the **same row**, and v1 has been accumulating the second kind since 2020. Verified on `fondodev` 2026-09-07: **110 unprocessed tasks are past due** (oldest `2020-09-27`), **108 of them payment reminders** — and joining each to its loan, **65 are for loans already `PAID_OUT`** and 43 for loans still `APPROVED` (oldest April 2024). A sample message: *"Recuerde que la fecha límite de pago para el crédito 112, es el: 2 oct. 2020"*. The first run with `SCHEDULER_ENABLED=true` would push all of them to 13 members. | ✅ **Answered 2026-09-07 — drain them at cutover.** A single `UPDATE` in the Phase 9 runbook (**step 3a**) marks **108 of the 110** `processed = true` — the predicate is `run_date < now() - interval '2 days'`, **not** `run_date < now()`, so today's birthday task and yesterday's reminder still go out. Draining those two would mean the member whose birthday it is is simply never greeted. **D7 is unchanged**: a task that becomes past due *after* cutover is still sent rather than skipped — the drain is a one-off for six years of rows v1 was never going to deliver. The 43 live-loan reminders are drained too, deliberately: their due dates are equally gone, so sending them would confuse rather than remind. | **D7** unchanged; **P7-D1** resolved; runbook **step 3a** |

| **Q35** | ⚠️ **v1 announces soft-deleted members' birthdays to the whole fund, and always has.** No `is_active` filter exists anywhere on the notification path (grep controlled). Evidence, not inference: task **1770**, *"Hoy está cumpliendo años Angi Paola Sanchez Quilindo"*, `2025-11-14`, **`processed = true`**, owner 15 `is_active = f`. Task **2142** repeats it on **2026-11-14**. Task **1497** (owner 3, Fernando, `is_active = f`) is spared by C72's `AND repeat = 0` and would fire **three times** out of season. | ✅ **Answered 2026-09-07 — no, stop announcing departed members.** Runbook **step 3a** drains 1497 by id; new **step 3a-bis** neutralises 2142 and sweeps for any other departed owner with a pending chain. Going forward this needs code: **D39**. | **D39** new; runbook **3a**, **3a-bis** |
| **Q36** | **Ainhoa (user 14) has a birthdate (`2020-08-05`) and has never had a single birthday task created** — she has never been greeted, in v1 or v2. Verified: zero rows in `fondo_api_schedulertask` name her. Eleven of the fourteen pending chains also omit her from `user_ids`, because every recipient list was frozen in 2020–21. | ✅ **Answered 2026-09-07 — start her chain, but fix the root cause first**, as part of **C71** rather than a one-off insert. ⚠️ The one-off would have been a trap: her birthday (5 Aug) has passed, so re-saving her profile today writes a **past-dated** task that fires immediately on the wrong day — C71's exact failure. | **C71** absorbs it |
| **Q37** | **65 of the 108 tasks step 3a drains are payment reminders for loans already `PAID_OUT`**, which v1's own code says should be impossible — `update_loan(id, 3)` calls `remove_sch_notitfications` (`services/loan.py:107`) and auto-close routes through it (`:207`). Either auto-close is not clearing reminders or some loans close off-path. | ✅ **Answered 2026-09-07 — drain them without investigating.** The reminders are for settled loans and are noise either way. ⚠️ **Recorded as accepted, not resolved:** the drain destroys the evidence, and if the defect is real it is already ported into v2. Re-openable from the step-1 `pg_dump`, which preserves the rows. | accepted risk |

| **Q38** | **What happens to a CAP whose `end_date` is already past on the day D12 ships?** Measured on `fondodev` 2026-09-07: **2 CAPs exist in total** — one already `state = 1`, and exactly **one** `state = 0` with `end_date 2024-02-28` (**900,000**, 2.5 years past). **Zero** open CAPs have a future `end_date`. v1 never closed it because auto-close **was never built** — `services/saving_account.py` still carries `# TODO: schedule task for closing CAP`, so D12 is a new build, not a port. | ✅ **Answered 2026-09-07 — close it; run the backfill.** No new mechanism: **C78**'s reconciliation query (`state = 0 AND end_date < today`) *is* the backfill, run once at cutover and forever after as the independent check. | **D12**, **C78**; Phase 6 |
| **Q39** | **Does the close run at the 10:00 or the 14:00 Bogotá pass, or both?** | ✅ **Answered 2026-09-07 — the 10:00 pass only.** ⚠️ **This needs no code, and Phase 6 must not add any.** Selection is date-granularity with no time component (`(run_date AT TIME ZONE zone)::date <= today`), and the 10:00 pass **claims** the row and marks it `processed`, so the 14:00 pass's `processed = false` filter already excludes it. The 14:00 pass re-attempts **only** when the 10:00 close threw and released the claim — which is exactly the retry path **C77**'s `throw` rule depends on. ⚠️ **One edge Phase 6 must decide rather than inherit:** a CAP created *between* the passes with an `end_date` of today would be picked up at 14:00. Whether that is reachable depends on whether D12 writes a task per CAP or works off the reconciliation query alone. | **D12**, **C77**; Phase 6 |
| **Q40** | **P8-F1 — a document re-uploaded under the other type.** v1 stores the object under the new path, then the row fails `display_name`'s uniqueness, the request is 500, a retry answers 201 with no row, and the copy is never listed. | ✅ **Answered 2026-09-12 — refuse before uploading.** See **D46**. | **D46**, C82; Phase 8 |
| **Q41** | **P8-F2 — replacing a document by re-uploading its name.** v1 silently overwrites the object when the lowercased path already exists, including a name differing only in case, writes no row, answers 201, and records nothing. | ✅ **Answered 2026-09-12 — keep v1's behaviour.** No refusal and no log line; ported as is. | C82; Phase 8 |
| **Q42** | **P8-F3 — `type` is not validated.** v1 stores any integer as the document type (`3/<name>` lists as `"3"`); a value past int4 stores the object and then 500s. Live data has only 0 (actas) and 1 (resultados) (measured by `business-analyst`, 37 rows). | ✅ **Answered 2026-09-12 — refuse unknown types.** Anything other than the integer 0 or 1 is refused before anything is stored. See **D47**. | **D47**, C82; Phase 8 |
| **Q43** | **Where do C71 and D39 go?** Both are birthday-notification defects left out of Phase 6, and neither is files or admin. | ✅ **Answered 2026-09-12 — their own small phase before cutover.** Added as **Phase 8b**, sequenced after Phase 8 and before Phase 9. | **Phase 8b**; C71, D39 |
| **Q44** | **D46 refuses one case that leaves no orphan.** With `Dup X` stored as an acta and `DUP X` as resultados, uploading `Dup X` as resultados overwrote `DUP X`'s object in v1 and answered 201. D46 refuses it (409), because `Dup X` exists under the other type. `business-analyst` measured 0 such name pairs in the 37 live files. | ✅ **Answered 2026-09-14 — keep the refusal.** In v1 that upload silently replaces a different document's content. | **D46** |
| **Q45** | **Two concurrent uploads of the same new name under different types both pass D46**; one gets 201, the other stores its object and then 500s, leaving an orphan. The table stays correct; the bucket does not. Closing it needs a transaction-scoped advisory lock held from the check, through the upload, to the insert. | ✅ **Answered 2026-09-14 — leave it.** Recorded as a known residual on D46. | **D46** |
| **Q46** | **A `type` sent as a file part**: v1 500 before any storage call; v2 now 400 under D47. Neither stores anything. | ✅ **Answered 2026-09-14 — keep the 400.** | **D47** |
| **Q47** | **C71 — a birthdate saved after this year's birthday has passed.** v1 writes this year's date (`replace(year=today_year)`), which is already gone: v1's exact-day selection never sends it, and the member is not greeted again until the next edit (what happened to Fernando). Under v2's D7 `<=`, the same row would push *"Hoy está cumpliendo años X"* on the wrong day. | ✅ **Answered 2026-09-14 — schedule next year's birthday.** Also next year when the birthday is today but the day's last scheduler pass (14:00 Bogotá) has already run. See **D48**. ⚠️ This goes one step further than `business-analyst`'s recommendation (`docs/ba-phase-7b-c71-c72.md` §1.3), which kept today's date after 14:00 and accepted a greeting one day late. | **D48**, C71; Phase 8b |
| **Q48** | **D39 — a departed member who rejoins.** D39 stops announcing a departed member's birthday; the open question was whether their greeting comes back on its own. | ✅ **Answered 2026-09-14 — resume automatically.** The check runs at send time: the push is skipped, but the row is marked processed and its yearly successor is still cloned, so the greeting goes out again the year they are reactivated. | **D39**; Phase 8b |
| **Q49** | **Birthday recipient lists are frozen at chain creation.** Measured read-only on `fondodev` 2026-09-14: **11 of 14** pending birthday chains leave out at least one current active member, and **13 of 14** still list a member who has left (`business-analyst` raised it in Phase 7b, §4.2). | ✅ **Answered 2026-09-14 — send to current members at send time:** every active member except the birthday person, resolved when the greeting goes out. A deliberate change from v1. See **D49**. | **D49**; Phase 8b |
| **Q50** | **Development storage (review m3).** In any environment except tests, v2's file storage uses the machine's Google Application Default Credentials and `GCS_BUCKET` defaults to the production bucket `fonmon`, so running v2 on a development machine that has Google credentials would upload to production. v1 behaves the same. Measured 2026-09-14: this host has no gcloud configuration, no Google environment variables and no Google keys in `.env`; tests force `ENVIRONMENT=test`, which refuses every storage call (P8-D2). | ✅ **Answered 2026-09-14 — keep v1's behaviour.** No development-only refusal is added; the test environment's refusal (P8-D2) is unchanged. | P8-D2; Phase 8 |
| **Q51** | **Tasks 1497 (Fernando) and 2142 (Angi Paola), two departed members' pending birthday chains.** Runbook 3a/3a-bis marked both processed, written under Q35; that ends each chain for good, which contradicts Q48 (a returning member resumes). `business-analyst` recommended moving each to the next birthday instead (`docs/ba-phase-8b-birthdays.md`). | ✅ **Answered 2026-09-14 — delete both tasks.** Runbook 3a and 3a-bis now `DELETE` by id; 2142 must go before 14 November 2026 on v1 if cutover is later. A returning member is greeted again once their birthdate is saved (D48). | Runbook 3a, 3a-bis; D39 |
| **Q52** | **How does a departed member come back** — old account reactivated (a direct DB change; no API path) or invited as a new user? It decides whether keeping old chains has any value. | ✅ **Answered 2026-09-14 — not established / unsure.** No practice to design for; with Q51's delete, either path is greeted once a birthdate is saved. | Q51; D39 |

⚠️ **`DJANGO_SECRET_KEY` is now required in production.** v2 signs its own password-reset tokens
with it (**P3-D4**). It reuses the variable v1's `production.py` already reads, so no
deployment change is needed — but the boot now *fails* without it, where v1 failed later and
less clearly.

### Runbook items carried from Phase 3 findings

1. **Do not edit the profiles of user 13 (`sebastian.montanez`) or 14 (`ainhoa.montanez`) in
   frozen v1.** Any personal edit 409s (shared email + UNIQUE username). Reconcile or formally
   record those two rows before cutover — deciding whether a child member gets their own email
   address, or whether the fund keeps a parent's address with a distinct username. Telling the
   members is not sufficient: Ainhoa is five.
2. **Four members cannot reset their password** (D17: ids 7, 10, 13, 14) and are shown the
   success page. Until D17 ships in v2, those resets have to be done manually. Worth telling the
   treasurer now rather than at cutover. ✅ **Fixed at cutover for ids 7 and 10**; ids 13 and 14
   (the custodial accounts) become **admin-assisted reset only**, deliberately — they have no
   email address of their own.
3. **Reset links do not survive the switch** (P3-D4): v2 signs its own tokens, so any link v1
   issued stops working at cutover. Django's timeout is 3 days, so at worst a few members
   re-request. Nothing to do beyond knowing it.
4. **Two more `@parser_classes` misuses to leave alone.** `LoanView.patch` and `FileView.post`
   carry `@parser_classes((MultiPartParser,))` on a *method*, where it is a no-op (§ Phase 3
   findings). Phases 4 and 8 must reproduce the no-op, not the decorator's apparent intent.

### Runbook items carried from Phase 4 findings

5. 🔵 **Client change — `PATCH /api/loan` now returns a body** (**D8**, operator Q3, condition
   **C47**). v1 answers a bare `200` with nothing in it; v2 answers
   `200 {"closed_loans": [<ids>]}`, in close order, uncapped. Nothing breaks if the client
   ignores it — but the whole point of D8 is that the treasurer finds out which loans the
   upload just closed, and that only happens if somebody changes the client. **Tell the
   operator the shape moved**; the server side also emits one `warn` line per upload with the
   count and the id list, which is the operability half that needs no client at all.
   ⚠️ Per **M2**, a treasurer who *does* notice still cannot undo a wrong auto-close through
   the API — see item 6.
6. 🔴 **A wrongly auto-closed loan is repaired in the database, not through the API**
   (**D31 withdrawn**, operator declined re-opening `3 → 1`; conditions **C54**, C42). The
   procedure — what to check first, why there is no forensic signature to look for, and why
   `3 → 0` is explicitly closed — is written in **`docs/phase-4-deviations.md` §2.10** and
   nowhere else. Read it *before* touching a row, not during the incident. Note that
   `updateLoanDetail` has no state filter, so the next monthly file **re-writes** a PAID_OUT
   loan's detail and re-creates its reminders (**D33**): reminders may be present, absent or
   duplicated depending on how many uploads have passed. Check, do not assume.

### Cutover timing — corrected (Q11)

The operator pushed back on the calendar constraint, and re-reading the code they are **mostly
right**. Correcting the earlier guidance:

- ❌ **Withdrawn: "never cut over near a year boundary."** `ActivityService.create_year` is not
  automatic — it fires only on an explicit `POST /api/activity/year` (role ≤ 1). It reads
  `date.today().year`, disables the most recent other year, and is guarded by a unique
  constraint. The real caveat is much smaller: **there is no re-enable path through the API**, so
  if someone presses the year-rollover button mid-cutover and it goes wrong, fixing it needs
  manual SQL. That is "don't press that button during the switch", not a blackout window.
- ✅ **Kept, and it is the one that matters: cut over shortly after a verified monthly bulk
  upload.** Not for data-safety reasons — for **runway**. The bulk TSV upload is the riskiest
  operation in the system (fund-wide auto-close, D8/D9). Cutting over just after a good upload
  puts roughly a month between the switch and the first time v2 runs that path for real, which
  is time to rehearse it against a copy. Cutting over the day before an upload means v2's most
  dangerous code path runs in production before anyone has watched it work.
- ℹ️ **Minor:** password-reset links issued by v1 stop working at the switch (D-note, Phase 3).
  Django's default timeout is 3 days, so at worst a few members re-request.
- ℹ️ Scheduled `SchedulerTask` rows are **data in the shared DB**, not in-flight process state, so
  v2 picks up pending payment reminders across the switch with no special handling.

**Net: you can cut over on any date.** Prefer the week after a monthly upload; avoid running the
year rollover during the switch itself.

---

## 10. Phase 0 outcome — toolchain notes

Phase 0 complete on `feat/phase-0-foundations` (`b3effab`), not pushed. Gate verified
independently: lint clean, typecheck clean, **262 unit tests / 8 suites**, 19 e2e / 2 suites,
every table round-trips, and `migrate diff` is empty **in both directions**. v1 confirmed
untouched.

**Prisma baseline:** `prisma/migrations/0_init` recorded with `applied_steps_count = 0` —
marked applied, never executed. Verified against `fondodev`.

Pin these; they cost real time to rediscover:

| Item | Fact |
|---|---|
| **Prisma version** | **Pinned to `7.10.0`.** `npm i prisma@latest` installs `8.0.0-rc.12` — npm's `latest` tag points at an RC. |
| **Prisma 7 API changes** | `datasource.url` is banned in `schema.prisma` (moved to `prisma.config.ts`; `.env` no longer auto-loaded). `migrate diff` renamed `--from-schema-datamodel`→`--from-schema` and `--from-url`→`--from-config-datasource`. `PrismaClient` requires a driver adapter. |
| **NestJS 12 is ESM-only** | Jest needs `NODE_OPTIONS=--experimental-vm-modules` (wired into the npm scripts). Running `npx jest` directly fails with a confusing error. |
| **Index operator classes** | `prisma db pull` does not read them back; declaring them in the schema creates permanent phantom drift. Patched in SQL instead. |
| **`Loan.rate`** | Reads back as `0.02`, not `0.020` — Prisma Decimal normalises. `toFixed(3)` restores it. Matters wherever the rate is rendered. |

**Money formatting — three findings that will not resurface until they break an email:**

1. **The Babel expression rounds twice, not once.** `format_number(format_decimal(round(v,2), format='#'))` inside a `ROUND_HALF_DOWN` context makes `20.5001` render as `20`, not `21`. Confirmed against Babel 2.9.1 and pinned in tests.
2. **Four-digit grouping.** v1's locale is `LANGUAGE_LOCALE = 'es'` (not `es-CO`). Babel 2.9.1 renders `1000` as `1.000`; Node `Intl` for `es` renders `1000` — CLDR sets `minimumGroupingDigits=2` for `es`, which Babel 2.9.1 predates. **v2 follows Babel.** Independently verified. v1's tests never render a four-digit amount, so nothing in the inherited suite would have caught this — it would have surfaced as a wrong loan email the first time an amount crossed $1.000.
3. **Decimal precision.** Python's default context is `prec=28`; `decimal.js` defaults to `20`. Matters for `Decimal(loan.value)/fee`. Set explicitly.

Golden values were derived by installing Babel 2.9.1 in a scratch venv and running v1's exact
expressions — not invented. Full detail in [`docs/phase-0-deviations.md`](docs/phase-0-deviations.md).
