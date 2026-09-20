# Phase 4 (Loans) — code + parity review

| | |
|---|---|
| **Reviewer** | `nestjs-reviewer` |
| **Date** | 2026-09-04 |
| **Branch** | `feat/phase-4-loans` |
| **Reviewed at** | `6fdbc3a` for source; re-read at **`cf2832f`** after `38bc9ba` (the precedence note) and `cf2832f` (D29/D30, v3.3) landed mid-review. `git diff 6fdbc3a..cf2832f -- src/ test/` is **empty** — no source changed under me. |
| **Phase commits** | `0a8cf62` (implementation), `5aa8b1a` (D4 reversal), `6fdbc3a` (parity + three D4 corrections) |
| **Inputs** | `docs/parity-phase-4.md`, `docs/phase-4-deviations.md`, `MIGRATION_PLAN.md` §3 P4 / §4 / §5 / §7 / §9, `docs/operator-q29a-q30a-q31.md`, `docs/adding-a-route.md`, v1 at `~/Projects/Fondo-API` |
| **Verdict** | **Approved with conditions (C40 – C49)** |

Conditions are numbered from **C40**; C1–C39 are Phase 0–3's.

---

## 0. What I verified myself rather than reading

Every load-bearing claim below was reproduced, not taken from a report.

| Claim | How | Result |
|---|---|---|
| Gate numbers | `npm test`, `npm run test:e2e`, `npm run lint`, `npm run typecheck` | **1830 unit / 58 suites**; **818 passed + 1 skipped / 16 suites**; lint clean; `tsc --noEmit` clean. Matches the brief exactly. The one skipped cell is `test/notification.e2e-spec.ts:353`, gated on `FONDODEV_DATABASE_URL` — deliberate, and correctly skipped rather than silently passing. |
| **`amortization.fixture.ts` is v1-derived, not v2-derived** | Re-implemented `services/loan.py:230-273` (`__generate_table`), `services/utils/date.py:4-27` (`days360`), and the `format_number(format_decimal(round(x,2), format='#'))` money rendering under `ROUND_HALF_DOWN` as a **standalone CPython script that never touches v2**, and ran all 16 fixture inputs through it | **16/16 tables and 16/16 summaries byte-identical**, including `big-30000000-36`'s 36 rows (its `$-0` closing balance included), `big-25871634-36`, `tiny-5-2`'s exact-half instalments, `leap-1000-13`, `feb29-999-24`, `monthend-400-4` and `unique-0tl-200`. **The fixture is genuinely captured from v1.** This is not false-green #19. |
| The two `v1-suite` entries | diffed against `fondo_api/tests/test_loan_views.py:418` and `:472` | character-for-character identical |
| The comparison is field-for-field | `amortization.spec.ts` — `expect(table).toBe(fixture.table)` (whole string) and `expect({...}).toEqual(fixture.summary)` (whole object), plus a positive control that a one-band rate change breaks it | ✅ whole-payload, with a control. Meets §7's post-#6 countermeasure. |
| `precision: 28` is load-bearing **and asserted** | `amortization.spec.ts:105, :117, :146` assert the exact 28-digit tails `0.7999999999999999999999999998`, `3.999999999999999999999999999`, `57.20000000000000000000000001` | decimal.js's default `precision: 20` cannot produce those strings, so three cells fail if the pin is removed. Answer to the brief's question: **yes, load-bearing; yes, asserted — behaviourally, which is stronger than a config assertion.** See nit n3. |
| D4 pinned from both sides, both suites | unit `loan.service.spec.ts:193` (37→400), `:204` (36→201 @ `0.025`), `:256` (0→400), `:269` (−3→400), `:278` (1→accepted); e2e `test/loan.e2e-spec.ts:209, :220, :238, :248` | ✅ both bounds, both directions, both suites |
| The `getRate` fall-through above 36 is unreachable **by the validation, not the vanished clamp** | `amortization.ts:219-230` and `amortization.spec.ts:44-53` both say so explicitly, and pin `getRate(37) === '0.015'` as a documented trap | ✅ correct, and correctly attributed after `5aa8b1a` |
| Rate table | `amortization.ts:239-250` vs `services/loan.py:320-326` | identical, fall-through shape included |
| Permission matrix | `permission-matrix.ts` `LoanView` / `LoanDetailView` / `LoanAppsView` vs `fondo_api/permissions.py:3-18, 35-37` | identical. `isRoleAllowed` reproduces int = `role <= N`, list = membership, and **miss = deny** for unknown view, unknown method and absent/`null` role. |
| No ORM in controllers | all three loan controllers | ✅ service-only; DI by constructor throughout |
| Rule 5c | `serializeLoan` — `created_at` via `toBogotaDate`, `disbursement_date` via `fromDateColumn` | ✅ correct, and pinned by the live loan-1 `31 dic. 2017` cell |
| No N+1 on the list path | `getLoans` single `findMany` with `include: WITH_OWNER` | ✅ |
| Transaction boundaries | approval = one `$transaction` including the SES call (v1's `transaction.atomic`); bulk upload = one unit including every auto-close; refinance deliberately **un**-transacted, as v1 is | ✅ match |

The parity round itself is the strongest of the four so far: status distributions rather than
pass counts, positive controls on every matrix, three harness defects fixed **in the probe**,
two of the tester's own controls found wrong and replaced, and the fixture proven byte-identical
to its pre-write dump. §4 M5's uniform-403 matrix is explicitly flagged as instance #4's shape
and given a discriminating control. I have no methodological criticism of it.

---

## 1. Findings

### Major

#### M1 — the §5 precedence note was committed to a branch the work had already left

**Location:** `MIGRATION_PLAN.md` §5 at `6fdbc3a` (absent) vs `56e43b3` on
`chore/c28-c36-phase-3-conditions`; now present at `MIGRATION_PLAN.md:839-847` via `38bc9ba`.

At the commit I was asked to gate, `docs/phase-4-deviations.md:112` and `:376` and
`docs/SESSION-STATE.md:38` each asserted *"A precedence note now sits at the head of
`MIGRATION_PLAN.md` §5."* `grep -c precedence MIGRATION_PLAN.md` returned **0**, and §3's Phase 4
rate-table line still read *"clamped to 36 silently … port the current table"* with no
supersession marker — i.e. the exact text that caused the D4 failure was still live, and the
exact control against it was still absent, while three documents said otherwise.

This has been logged as **false-green #18** and the note has been cherry-picked. I am recording
it in the review anyway, for two reasons. First, the artefact that failed to land was precisely
the control against the failure recurring in Phases 5–8 — of the four instances in this family it
is the one whose absence had the largest forward cost. Second, the new rule (`git branch
--contains` before claiming a fix is in place) is right but narrow: the failure mode is *"an
artefact was verified in one tree and claimed for another"*, which also covers a file verified in
the worktree and never committed, and a fix verified in `dist/` and not in `src/`. Word the rule
as **"verify the claim from the tree the claim is about"**.

**Now judging the note on its merits, since it exists:** it is well written and correctly placed,
and §3's Phase 4 line now carries the supersession. But it does **not** address the actual root
cause of the D4 failure, which was that *the dispatch brief paraphrased §3*. A reader who never
opens §5 is not helped by a paragraph at the head of §5. What makes it mechanical is a per-phase
index — see **C40**. The residual exposure in Phases 5–8 is genuinely small (I checked: Phase 5
owns **no** §5 rows; Phase 6's block already names D3-withdrawn and D12 at `MIGRATION_PLAN.md:543,
:549`; Phase 7's names D7), so this is cheap insurance rather than an emergency.

#### M2 — D9 refuses `3 → 1`, so the recovery path D6 exists to enable is unreachable through the API

**Location:** `src/loans/loan.service.ts:947-950` (`LEGAL_LOAN_TRANSITIONS` has entries for
states `0` and `1` only) vs `src/loans/loan.service.ts:466-471` and
`docs/phase-4-deviations.md:42`.

Both the service docblock and the deviations register describe D6 as *"the recovery path for a
loan wrongly closed by `bulkUpdateLoans`, whose repair is 'set state back to 1 and re-approve'"*.
That repair **cannot be performed through v2's API at all**: `3→1` is a 409
(`loan.service.spec.ts:399` asserts it), `3→0` is a 409, and from state `1` you cannot re-approve
either (`1→1` is a 409). The only route back is a hand-written `UPDATE fondo_api_loan SET
state = 0` followed by a normal approval — at which point D6's upsert *is* what saves you, so the
deviation is still load-bearing, but only in combination with a DBA.

This lands directly on the blast radius the brief asked me to weigh. The tester measured a
zero-byte TSV closing **28 loans and deleting 235 `schedulertask` rows**
(`docs/parity-phase-4.md:172, :325`), and `MIGRATION_PLAN.md:482-489` calls the auto-close *"not
cleanly reversible"* in v1. It is now **not reversible at all** in v2 without database access.
That is arguably the *right* trade — v1's "recovery" left the loan permanently 500ing
(`parity-phase-4.md:283-290` demonstrates it end to end) — but it is a change in operational
posture that nobody has stated, and the code currently claims the opposite.

Two halves, and only one of them is mine:

* **Documentation — fix now (C41).** Stop claiming a repair the code refuses.
* **Policy — not mine (C42).** Whether a wrongly-closed loan should be re-openable through the
  API, and by whom, is fund practice. **Escalated to `business-analyst`, then the operator.**
  Options to carry: (a) accept DB-level repair and write it into the Phase 9 runbook; (b) allow
  `3→1` for ADMIN only, which D6's upsert already makes safe; (c) a distinct un-close path that
  restores `state = 0` so the normal approval runs. I have deliberately not pre-judged it.

#### M3 — §5.1's "nothing in v2 can create a second row" is not true under concurrency

**Location:** `src/loans/loan.service.ts:493-501` and `:903-912`; claim at
`docs/phase-4-deviations.md:363`.

`updateLoanIn` reads `loan.state` (`findUnique`), checks the transition, then writes
(`tx.loan.update({ where: { id } })`) with no row lock and no conditional predicate.
`upsertLoanDetail` is likewise find-then-update-or-create. Prisma's interactive transaction runs
at the database default, **READ COMMITTED**. Two concurrent `PATCH /api/loan/<id> {"state":1}` on
a WAITING loan therefore both read state `0`, both pass `assertLegalLoanTransition`, both find no
detail row and **both insert** — two `LoanDetail` rows and two borrower emails.

This is not a regression: v1 is worse and wholly unguarded. It matters because it is the single
claim §5.1 uses to justify deferring the physical `UNIQUE (loan_id)` to Phase 9, and because it is
also what is supposed to guarantee the constraint *"will apply cleanly"* when Phase 9 adds it. The
window is a double-clicked approve button, which is exactly the shape of event that produced
v1's duplicates in the first place.

**Answering the brief's question directly:** the application-level guarantee is sufficient for the
interim **only if it is made race-safe**, and it can be, without a migration and without touching
the schema Django owns:

```ts
const updated = await tx.loan.updateMany({ where: { id, state: loan.state }, data: { state } });
if (updated.count === 0) { throw ApiException.withMessage(HttpStatus.CONFLICT, 'Invalid state transition'); }
```

That serialises the transition on the row and makes the loser a 409 — the same status it would
have received had it arrived a millisecond later. One unit cell pins it. With that in place I am
comfortable with the deferral; without it, §5.1's claim should be softened to "nothing in v2
creates a second row on any serial path". **C43.**

---

### Minor

#### m1 — P4-F2: the ordering asymmetry is correct; the *documentation* is what is wrong

**Location:** `loan.service.ts:345-350` (authorise **after** the lookup) vs
`user.service.ts:322-323` (authorise **before**); claim of symmetry at
`docs/phase-4-deviations.md:46` and `:80`; tester's finding at `docs/parity-phase-4.md:415-432`.

**I am accepting the code and rejecting the wording.** The two predicates are not symmetric and
cannot be. On `/api/user/<id>` the ownership term is `actor.id === <path id>` — computable from
the path with no row read, so authorising first is free and P4-D1 closes the oracle at no cost.
On `/api/loan/<id>` the ownership term is `actor.id === loan.user_id`, which is knowable *only*
by reading the row. There is no ordering that both preserves v1's 404 on a missing loan and hides
existence from a non-owner; you must pick one. v2 picked v1's 404 — the parity-preserving choice,
and the one that avoids opening a further deviation. The docs' claim of "the same predicate and
the same roles" is true of the **rule** and false of the **evaluation order**, and that is the
defect.

What actually leaks is the existence of a loan id and nothing else — no value, rate, owner or
comments, all of which v1 handed to any member. Loan ids are a dense autoincrement that a member
can already infer from their own. I do not think this turns on fund policy and I am not sending it
to BA. If the operator later wants it closed, the faithful way is to answer 403 for a non-owner
MEMBER on *both* existing and missing ids — a new registered deviation, one line, and it should be
their call, not a silent tidy-up.

Two things are required. First, correct §1.1's D25 row and P4-D1 to say the rule is shared and the
order is not, with the reason above. Second — and this is the part that matters — the role arrays
have a mechanical guard (`loan.service.spec.ts:91`) and the **orderings do not**, so a later
"consistency" refactor could flip either without a test noticing. Add one cell per side. **C44.**

#### m2 — D8's body is a capability, not a notice

`docs/parity-phase-4.md:325` measures 130 bytes on a whole-fund close. Nothing else changes:
`loan.service.ts:747` logs at `LOG` level, one line per loan, exactly as v1's `logger.info` does.
Whether a treasurer *notices* therefore depends entirely on a client change that nobody has been
asked for, and — per **M2** — even a treasurer who notices cannot undo it through the API.

Operator Q3 decided the body's shape and cap. It did not decide that the body is the whole
alerting story, and `MIGRATION_PLAN.md:922-924` (Q1/Q2) accepted silence for the *rule*, not for a
28-loan close. Two improvements need no new decision: emit **one** summary line at `warn` with the
count and the id list rather than 28 at `log`, and put "`PATCH /api/loan` now returns
`{closed_loans: [...]}`" into the Phase 9 client-change runbook so the operator is told the shape
moved. Whether a mass close should also notify is a genuine question — **to BA with C42**, since
it is the same conversation. **C47.**

The brief also flags that D8 was omitted from the dispatch brief (`docs/phase-4-deviations.md`
§5.3). The developer was right to implement it rather than leave a decided §5 row unimplemented,
and right to flag the omission loudly. No further action beyond the runbook entry.

#### m3 — the bulk upload's timeout is not v1's

`loan.service.ts:755` wraps the whole upload in `$transaction(..., { timeout: 120_000, maxWait:
20_000 })`. v1's `@transaction.atomic` has no timeout at all. A monthly run slow enough to exceed
two minutes commits in v1 and rolls back with a 500 in v2. The all-or-nothing property is
preserved either way and the measured run is far inside the budget, so this is safe — but it is an
unregistered behavioural difference of exactly the species that **was** registered as P4-D6 for
the 20 s approval budget. Register it as **P4-D7** rather than leave one of the pair implicit.
**C45.**

#### m4 — a TSV `loan_id` outside 32-bit range is probably a 500 in v2 where v1 is a 200

`loan.service.ts:721` narrows `toDjangoInt(...)` (a `bigint`, arbitrary precision, matching
CPython's `int()`) through `Number(...)` and hands the result to
`tx.loanDetail.findFirst({ where: { loan_id } })`, where `LoanDetail.loan_id` is a Prisma `Int`.
In v1 the query simply misses, `DoesNotExist` is logged and skipped, and the id still shields
nothing from the auto-close. In v2 Prisma will reject the out-of-range value and take the **whole
upload** down with it.

Neither suite covers it: the tester's `unknown-id.tsv` uses `999999`
(`docs/parity-phase-4.md:329`), which is in range. `src/loans/loan-path-id.ts:11-14` handles
precisely this hazard for the URL segment and documents why — the same reasoning was not applied
to the file column. Measure it against v1, then either reproduce the miss or register the
divergence. **C46.**

#### m5 — `mailBcc` is computed for every transition, including every auto-close

`loan.service.ts:503` hoists `getUserEmails([0, 2])` above the state branches. v1 calls
`get_users_attr('email', [0,2])` **inside** the `state == 1` and `state == 2` branches only.
Output-identical, but it adds one query per auto-closed loan inside the 120 s transaction — 28 on
a whole-fund close — that v1 never issues. Move it into the two branches that use it. **C45.**

#### m6 — two queries on the transactional path do not take the transaction client

`loan.service.ts:56-61` states the rule as absolute — *"Every query on a transactional path
therefore takes the client as an argument"* — and `getUserIds` / `getUserEmails` are the two
exceptions, both unmarked. Harmless today (read-only, unrelated table, no uncommitted state they
could miss), but an absolute rule with silent exceptions is how the next one gets added. Thread
the client or document the carve-out at the call site. **C45.**

#### m7 — `getLoans` lists the whole fund when `userId` is null and `allLoans` is false

`loan.service.ts:280`: `{ user_id: userId ?? undefined }`. Prisma drops an `undefined` filter;
Django's `filter(user_id=None)` compiles to `user_id IS NULL` and returns nothing. Unreachable
from the controller today — the only `null` caller passes `allLoans = true` — but note that the
sibling impossible-argument case three lines later (`page === null`) **is** guarded with a thrown
`TypeError` and a comment explaining why. The pattern was established and this one was missed.
Guard it identically. **C45.**

---

### Nits

* **n1** — `loan-apps.controller.ts:92` is the only one of the three `@All()` fallbacks without
  `@DrfNoRequestData()`. Inert (the matrix denies every non-`POST` method at the guard, before the
  interceptor), but it is item 5 of `docs/adding-a-route.md`'s checklist and this is the file
  Phase 8 will copy. **C49.**
* **n2** — `amortization.spec.ts:62`: *"MAX_TIMELIMIT is 36, matching the clamp in create_loan"*.
  There is no clamp any more; the title survived `5aa8b1a`. Rename to "matching D4's upper bound".
  **C49.**
* **n3** — no spec asserts `Decimal.precision === 28` directly. As recorded in §0 the pin is
  asserted *behaviourally* and that is the stronger test — but the **reason** is discoverable only
  from three interest assertions three directories away from `common/utils/decimal.ts`. One line
  in a `decimal.spec.ts` naming CPython's default context would put it where the next person
  changing that config will look. **C49.**
* **n4** — the exposure D28's withdrawal accepts (raise own `available_quota` → pass
  `create_loan`'s check → self-approve) is written in `docs/phase-4-deviations.md` §1.2 and in
  `docs/operator-q29a-q30a-q31.md`, but **not** at `loan.service.ts:196`, which is the quota check
  itself — the fund's only quota gate. One line there closes the loop for a reader who arrives via
  the code. **C49.**
* **n5** — P4-F3 is **already fixed** in `6fdbc3a`: `docs/phase-4-deviations.md:304` now reads
  `200`, and I confirmed against `fondo_api/views/loan.py` that `LoanAppsView.post` returns
  `HTTP_200_OK`. No action.

---

## 2. The two items the brief asked for a conscious answer on

### P4-D4 — `?page=`, `?page=abc`, `?state=abc` are 500s reachable from the client's query string

**Yes, still. Port stands, and this is a decision rather than an inheritance.**

The reasoning, so it is re-decided once rather than never: `LoanView.get` calls `int()` unguarded
where `UserView.get` guards on presence, and that asymmetry is v1's, recorded at
`src/common/utils/python-obj.ts:266-273` and registered as P4-D4. §4 rule 2 forbids modernising
v1's status choices; changing it is a new deviation needing an operator. The 500 carries no side
effect, no write and no information leak, and the fund's client sends a hard-coded `page`. The
cost of carrying it is one confusing log line; the cost of changing it unilaterally is an
unregistered diff on a route the tester has already swept 86 ways.

One condition attaches: it belongs in the Phase 9 "v1 defects deliberately carried" list, so that
cutover is the moment it gets its single re-decision, rather than it surviving by silence forever.
**C49.**

### D28's withdrawal — documented as a decision, not an oversight

**Adequate, and better than I expected.** It is carried in five places, three of them in code:
`loan-detail.controller.ts:36-44` (the class docblock, naming Q31), `loan.service.ts:88-93` (under
an explicit *"what is deliberately not changed"* heading), `test/loan.e2e-spec.ts:1557` (a
**passing** assertion that a TREASURER may approve their own loan, whose docblock says a failure
here is a policy change needing an operator), plus `docs/phase-4-deviations.md` §1.2 and
`docs/operator-q29a-q30a-q31.md`. `loan.service.spec.ts` additionally pins
`updateLoan.length === 2`, so the absent actor argument cannot be added by accident without a
failing test.

The accepted exposure is a closed loop and is written down as one. The parity round confirmed the
cell live (`docs/parity-phase-4.md:163`). My only addition is n4 above. **A future reader finds a
decision here, which is exactly what was asked for.**

### P4-F1 / D29 — what it interacts with

Not mine to decide, and now decided as **D29** (`MIGRATION_PLAN.md:878`). Two interactions for
whoever implements around it:

1. **The coercion is not `value`-specific — it is `toDjangoInt`'s string branch.** The same helper
   serves `disbursement_value` (`loan.service.ts:1043`) and the TSV `loan_id` (`:721`), and
   `toDjangoSmallInt` serves `timelimit`, `fee`, `payment` and `LoanDetailView.patch`'s `state`.
   v1 **does** coerce `timelimit` (`int(obj['timelimit'])`, `services/loan.py:33`), so any
   strictness must be applied per call site, never in the helper.
2. **D4's bounds check runs on the coerced `timelimit`.** Making that field strict would move
   D4's 400 to a 500 and silently break the boundary this phase just pinned from both sides.

**D30 is a decided §5 row owned by Phase 4 that is not implemented**, its floor pending an operator
answer. §7 criterion 5 blocks on *undecided*, not *unimplemented*, so it does not block this gate
— but D8 nearly slipped the same way and was caught only because the developer read §5 rather than
the brief. It is carried explicitly at **C48** so the same near-miss is not repeated. When it
lands it should bound the **coerced** value, beside D4's check and in the same style, so it catches
both the numeric and (post-D29) the string shapes; that is roughly four lines once the operator
answers.

### The fractional quota cell (BA's item 1) — agreed, and it is sharper than stated

`value: 30000000.5` against a 30 000 000 quota is **406 on v1, 201 on v2**, and I agree it must be
run rather than assumed. One detail the framing omits and the tester will need: `toDjangoInt`
**truncates** (`python-obj.ts:93`, `BigInt(Math.trunc(value))`), so v2 does not merely accept the
request — it writes a loan whose `value` is `30000000`, i.e. **a different number from the one the
member submitted**. The truncation itself is faithful (`BigIntegerField.get_prep_value` is `int()`,
so v1 would store the same had it got there); only the ordering is not.

The divergence is also narrower than it looks, which makes the cell cheap and precise. Below the
boundary the two agree: `value: 999.5` under quota is `999.5 > quota` → `False` in v1 (Python
compares `float` to `int` happily — the `TypeError` is `str`-vs-`int` only), so both stacks accept
and both store `999`. **The only divergent window is `available_quota < value < available_quota +
1`.** Reproduction: set the member's quota to `Q`, submit `Q + 0.5`, expect v1 `406` and v2 `201`
with `value = Q`. **Folded into C46.**

---

## 3. Business scenarios missing from the tests (and, in two cases, from the code)

Cross-checked against `CONTEXT.md`'s business-logic section and §5.

**Present and genuinely exercised** — auto-close of APPROVED loans absent from the bulk file
(e2e `:1128`, parity §W5, 28/28 on both); the T−5d/T−1d reminders including the year-crossing,
leap-day and already-past cases (e2e `:1060`, parity §2.2); SES BCC dedup (e2e `:613`, `:732`);
`prev_loan.state = 3` on refinance approval and `refinanced_loan` cleared on denial (e2e `:1425`,
`:1446`); pagination out-of-range (e2e `:259`, parity all 46 pages); both TSV endpoints; the whole
role matrix including unauthenticated and deny-on-miss; every loan state transition;
`available_quota = total − utilized` (Phase 3, `user.service.ts:797`, still correct); `id == -1`
meaning "me" (parity §M4, unaffected by D25); soft delete (Phase 3, D20).

**Missing, in rough order of how much I care:**

1. **No recovery-from-auto-close scenario at all**, in either suite or the parity round. The
   closest cell is `loan.service.spec.ts:399`, which asserts the 409 without noticing that it
   forecloses the repair the same file documents. This is **M2**, and it is missing from the code
   as much as from the tests.
2. **The fractional quota boundary** (above). Not in the round; the same root cause as P4-F1 and
   the same one-cell cost.
3. **An out-of-32-bit-range `loan_id` in the TSV** — **m4**. Untested in both suites.
4. **Two concurrent approvals of the same loan** — **M3**. No cell in either suite issues two
   overlapping writes to one loan; the whole phase is serial. Given that duplicate `LoanDetail`
   rows are *the* defect D6 exists for, one concurrency cell earns its keep.
5. **The D10/D25 evaluation orders** — **m1**. Pinned in prose, unpinned by any test.
6. **Birthday yearly `SchedulerTask` for all other users** and **activity-year rollover** are
   Phase 3 and Phase 5 respectively and are correctly out of scope here. Noting them only so the
   brief's checklist is visibly closed rather than silently dropped. §2.9 of the deviations doc
   correctly establishes that **no calendar-"today" read exists on the loan path at all**, which I
   verified — the only clock read in the service is `created_at`'s `nowInstant()`.

---

## 4. The pattern behind three of this phase's findings

The coordinator asked whether P4-F2 and the D29 comparison-ordering divergence are one pattern or
two coincidences. **They are not the same defect, but they share a root cause, and there is a third
instance in the same phase.**

They differ in an important way. P4-F2 is a convention that *cannot* apply to both sites — the
ownership term is path-derived in one and row-derived in the other — so the code is right and only
the claim of symmetry is wrong. The D29 case is different: Phase 3 established "compare the raw
body value with `pythonNotEqual`, coerce only on the write" at `user.service.ts:777-782`, the
helper is exported from the shared module, and `createLoan` (`loan.service.ts:195-196`) is the one
place in v2 that coerces first and compares second. That is a convention genuinely dropped, at the
only site where it also applied.

What they share is one level up. **C36 made the shared *code* mechanical and left the shared
*conventions* in prose.** §2.8 of the deviations doc confirms twelve helpers were imported rather
than re-implemented — that half worked. But `pythonNotEqual` encodes a rule about *sequencing*, and
hoisting a function does not carry its sequencing rule with it: the developer imported
`toDjangoInt`, the coercion, and never saw that Phase 3 had decided the coercion happens *after*
the comparison.

The evidence for this being the real pattern is that it sorts this project's whole history cleanly:

| Convention | Carrier | Held? |
|---|---|---|
| Route authorisation | a table (`PERMISSION_MATRIX`), compile-time-linked to the URL conf | ✅ |
| `@db.Date` vs `timestamptz` (rule 5c) | a **type error** | ✅ |
| v1's URL table | a table, fail-closed | ✅ |
| D10/D25 role **sets** | a unit assertion (`loan.service.spec.ts:91`) | ✅ |
| BigInt → bare JSON number (5b) | an `AppModule` provider | ✅ |
| §3-vs-§5 precedence | **a paragraph** | ❌ — the D4 failure |
| "compare raw, then coerce" | **a paragraph** (and a helper whose name does not say it) | ❌ — D29's cell |
| D10/D25 evaluation **order** | **a paragraph** | ❌ — P4-F2 |

Three failures in one phase, all in the prose column; zero in the mechanical column. That is a
stronger signal than any individual finding here, and it predicts where Phases 5–8 will slip:
Phase 5's "attach **all active** users" (`is_active = true` — a filter, easy to write as a
paragraph); Phase 6's "CAP balances affect **neither** `total_quota` **nor** `contributions`",
which `MIGRATION_PLAN.md:545-548` itself warns *"a future maintainer will 'fix' by accident"*; and
Phase 7's Bogotá `run_date` extract, which `:610-611` says a UTC extract silently defeats.

**The rule I would adopt for Phases 5–8:** for every convention carried across a phase boundary,
name its carrier — a type, a table, a shared function whose *name* states the rule, or a named
test. If the honest answer is "a paragraph in the plan", that convention is unprotected and the
phase should either give it a carrier or accept, in writing, that it will be re-litigated. Two
carriers are due immediately and are cheap: the D10/D25 ordering cells (**C44**), and either a
`pythonGreaterThan` sibling or — since the BA does not recommend changing the behaviour — a
comment at `loan.service.ts:196` naming D29 and pointing at `updateUserFinance`, so the *next*
reader of a quota comparison finds the decision instead of re-deriving it (**C45**).

I agree with the BA that `pythonGreaterThan` should not be built merely for tidiness. D29 accepted
v2's behaviour; a helper that restores v1's would be implementing a decision nobody made.

---

## 5. Conditions (C40 – C49)

**Gating Phase 5's start** — these are cheap, and two of them are the guards against repeating
this phase's own failures:

| # | Condition | From |
|---|---|---|
| **C40** | Keep `38bc9ba` on the branch, and make the precedence control **mechanical**: add to each §3 phase block a one-line ***"§5 rows this phase owns"*** index (P5: **none**; P6: D3 *withdrawn*, D12; P7: D7; P8: none — D22/D23 are cross-cutting) and generate the dispatch brief from that line rather than paraphrasing §3. Root cause of D4 was the brief's paraphrase; a paragraph inside §5 does not reach a reader who never opens §5. Also broaden #18's new rule from `git branch --contains` to **"verify the claim from the tree the claim is about"**. | M1 |
| **C41** | Correct `loan.service.ts:466-471` and `docs/phase-4-deviations.md:42`: the "set state back to 1 and re-approve" repair is a **409**. State plainly that after an erroneous auto-close v2 has **no API-level recovery**. Documentation only; no behaviour change. | M2 |

**Tracked to Phase 5's gate** (not silently carried — §7's standing rule):

| # | Condition | From |
|---|---|---|
| **C42** | **To `business-analyst`, then the operator:** should a wrongly auto-closed loan be re-openable through the API, and by whom? Carry the three options in M2. Bundle the D8 question from C47 into the same round. | M2, m2 |
| **C43** | Make the transition race-safe: conditional `updateMany({ where: { id, state: current } })` + 409 on `count === 0`; one unit cell. Then soften or restore §5.1's "nothing in v2 can create a second row". | M3 |
| **C44** | Correct the "same predicate" wording in D25 and P4-D1 to distinguish the shared **rule** from the differing **order**, with the path-derived-vs-row-derived reason. Add two cells pinning the orders (`getLoan` on a missing id → 404 for a non-owner MEMBER; `getUser` on a missing id → 403). | m1 |
| **C45** | Four small code items: register the bulk-upload transaction budget as **P4-D7**; move `mailBcc` into the two branches that use it; thread or document the `getUserIds`/`getUserEmails` client; guard `getLoans`' `userId === null` path as its `page === null` sibling already is. Plus the D29 pointer comment at `loan.service.ts:196`. | m3, m5, m6, m7, §4 |
| **C46** | Measure two cells against v1 and then reproduce or register: an out-of-32-bit-range TSV `loan_id`, and the fractional quota boundary (`value = available_quota + 0.5` → v1 406 / v2 201 **with a truncated stored value**). | m4, §2 |
| **C47** | D8 operability: one `warn`-level summary line per upload with the count and the id list, replacing 28 `log` lines; and a Phase 9 client-change runbook entry that `PATCH /api/loan` now returns a body. | m2 |
| **C48** | Close, or explicitly re-date, the Phase 3 conditions that `docs/review-phase-3.md:610` tracked **to this gate** and `docs/SESSION-STATE.md:27-31` still lists open: **C31, C32, C33, C34, C35, C37, C39** and C38's non-BA half. Not Phase 4 defects and not a reason to hold Phase 5's start — but this was their deadline, and a second silent roll makes the tracking mechanism decorative. Add **D30** to the same list with an owner and a date. | §7, §2 |
| **C49** | Nits n1–n4, plus one Phase 9 line listing the v1 defects deliberately carried, **P4-D4 first**. | n1–n4 |

---

## 6. Verdict

# **Approved with conditions (C40 – C49).**

This is the strongest phase in the migration so far and the one with the most at stake. The
amortisation fixture is genuinely differential — I reproduced all sixteen tables from v1's source
in an independent implementation and they agree byte for byte, which is the answer to the question
the brief actually asked. The money path is integer throughout, the three roundings are kept
distinct and correctly attributed, `precision: 28` is pinned by assertions that would fail without
it, the rate table and the permission matrix are verbatim, D4 is pinned from both sides in both
suites with the fall-through's new dependency documented, and D28's withdrawal is carried in three
places in code as a decision rather than an oversight.

**C40 and C41 gate Phase 5's start**; both are documentation and together are perhaps twenty
minutes. **C42–C49 are tracked to Phase 5's gate.** Nothing here re-opens the phase: no finding is
a parity failure, no finding changes a response byte on a healthy path, and the two that change
behaviour (C43's conditional update, C46's two cells) are additive.

The finding I would most want carried forward is not in the conditions list at all. It is §4: this
project protects its cross-phase conventions well when it gives them a type, a table or a test, and
loses them reliably when it writes them down. Three of this phase's findings are that one fact.

**Escalated to `business-analyst`** (operator second, per the standing instruction): C42 — whether
a wrongly auto-closed loan should be re-openable through the API and by whom, bundled with whether
a mass close warrants a notification. I have deliberately not pre-judged either.
