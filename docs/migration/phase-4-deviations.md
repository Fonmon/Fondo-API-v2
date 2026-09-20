# Phase 4 — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5, and to `docs/phase-0-deviations.md` …
`docs/phase-3-deviations.md`.

Audience: `nestjs-reviewer` (§1–§3), `manual-tester` (§4 — everything it must read as an
**expected** diff), and whoever maintains `MIGRATION_PLAN.md` (§5 — corrections to fold back).

**Scope shipped**

| Area | Routes / units |
|---|---|
| Loans | `GET\|POST\|PATCH /api/loan`, `GET\|PATCH /api/loan/<id>`, `POST /api/loan/<id>/<paymentProjection\|refinance>` |
| Powers (§5 rows decided with this phase) | `POST /api/user/power` — D26, D27 |
| Members | `GET /api/user/<id>` — D25, D10's twin |
| Loan `value` (§5 rows decided after the first parity round) | `POST /api/loan` — D29, D30 |
| §5 register implemented | **D4, D6, D8, D9, D10, D25, D26, D27, D29, D30** |
| §5 register **withdrawn**, ported as-is | **D28** (and **m6** with it) — operator **Q31** |

**Gate numbers**

| | before | after (implementation) | after (review conditions) |
|---|---|---|---|
| unit | 1628 / 55 suites | 1830 / 58 suites | **1863 / 58 suites** |
| e2e | 699 + 1 skipped / 15 suites | 818 + 1 skipped / 16 suites | **827 + 1 skipped / 16 suites** |

The third column is the C40/C41/M3 + D29/D30 round: **+33 unit** (the `pythonGreaterThan`
block, D29's ordering and string cells, D30's bounds, and three compare-and-set cells) and
**+9 e2e** (D29's boundary and string cells, D30's bounds). No cell was removed or weakened;
one existing cell — the auto-close's write assertion — was *strengthened* to read the
compare-and-set predicate instead of an unconditional update.

`fondodev` verified unchanged after the run: `schedulertask 626`,
`notificationsubscriptions 94 / max(id) 1468 / 1 distinct xmin`, `auth_user 15`, `power 20`,
`loan 425`, `loandetail 374`, and **1 distinct `xmin` on both loan tables** — v2 wrote nothing
to the shared fixture. Pre-write `pg_dump` of every table is at
`~/.fondo-parity-dumps/p4-20260903-160323/` (full custom-format dump plus one plain-SQL file
per table, on `/dev/mapper/root` — persistent, not tmpfs).

---

## 1. Registered deviations from v1

### 1.1 The §5 register items this phase implements

| # | v1 | v2 | Where |
|---|---|---|---|
| **D4** | v1 has **neither bound**. Below 1: `timelimit = 0` is accepted, the row is written, and approval dies with `decimal.DivisionByZero` inside `__generate_table` (`Decimal(loan.value) / 0`) — the member holds a request that can never be approved and nothing connected the failure to the create call. Above 36: `create_loan` **silently clamps** (`services/loan.py:31-32`), so a member asking for 48 months is booked at 36 and told `201`. | **400** `{"message": "Timelimit must be between 1 and 36"}` at create, **both bounds** (operator **Q9**). The clamp is **gone**. Placed exactly where v1 first reads the value — **after** the quota check, so an over-quota request is still v1's 406. ⚠️ `test_post_loan_5` is therefore a **moved expectation** (201 → 400), the only one on the create path. | `loan.service.ts::createLoan` |
| **D6** | `LoanDetail.loan` is a plain `ForeignKey`, so re-approving a loan **inserts a second detail row**; `LoanDetail.objects.get(loan_id=...)` then raises `MultipleObjectsReturned` and `GET /api/loan/<id>` is a permanent **500**. In v1 that is what the repair of a wrongly auto-closed loan does, so the recovery *is* the corruption. | The approval write is an **upsert** keyed on `loan_id`, and **every** read of `LoanDetail` is `findFirst` + `orderBy: {id: 'asc'}` — deterministic, so a pre-existing duplicate degrades to "the second row is ignored" instead of a permanent outage. ⚠️ The physical `UNIQUE (loan_id)` is **not** applied — see §5.1. ⚠️ **D6 makes that repair safe when it happens; it does not make it reachable — see §2.10.** | `loan.service.ts::upsertLoanDetail`, `::readLoanDetail`, `::updateLoanDetail` |
| **D8** | `bulk_update_loans` answers a bare `200` with **no body**, so nothing tells the treasurer which loans the upload just closed. | `200 {"closed_loans": [<ids>]}`, in close order, with no cap on length (operator Q3). | `loan.service.ts::bulkUpdateLoans` |
| **D9** | `update_loan` writes `loan.state` unconditionally. Re-approving regenerates the amortisation table, writes a second `LoanDetail` (D6) and re-sends the borrower's email; `3 → 1` re-opens a closed loan; a **negative** state passes `LoanDetailView.patch`'s `new_state <= 3` check and is stored verbatim. | Legal transitions only — `0→1`, `0→2`, `1→3`, `1→2` (operator Q14). Anything else is **409** `{"message": "Invalid state transition"}` with **no mail, no scheduler write and no state change**. The loan is looked up first, so a missing id is still v1's 404. | `loan.service.ts::assertLegalLoanTransition` |
| **D10** | `GET /api/loan/<id>` and `POST /api/loan/<id>/paymentProjection` are role ≤ 3 with **no ownership check**, so any member reads any loan by id — value, rate, comments, outstanding capital. | The loan's **owner plus roles `[0,1,2]`** (operator Q16). DRF's generic 403, byte-identical to a role denial. `refinance` is unchanged: v1 already restricts it to the owner. | `loan.service.ts::getLoan`, `::paymentProjection` |
| **D25** | `GET /api/user/<id>` is role ≤ 3 with no ownership check, so any member reads any other member's `finance` block — `utilized_quota` and `total_savingaccounts`. v1 is inconsistent with itself: it hard-filters the *loan list* by role and returns no finance on the *user list*. | **The same *rule* and the same roles as D10** — owner plus `[0,1,2]` — but **not the same evaluation order**, and it cannot be (**C44**). On `/api/user/<id>` the ownership term is `actor.id === <path id>`, computable from the path with **no row read**, so the check runs **first** and closes the enumeration oracle at no cost. On `/api/loan/<id>` it is `actor.id === loan.user_id`, knowable **only** from the row, so D10 reads first and keeps v1's 404 on a missing loan; no ordering gives both. What that leaks is the existence of a dense autoincrement id and nothing else. Operator **Q29a**: no client screen reads another member's detail. `GET /api/user/-1` is unaffected (the `-1` substitution runs first, so it always takes the owner branch). | `user.service.ts::getUser` |
| **D26** | Nothing forbids `requester === requestee` on a power request. A member acting **alone** — with no second party's consent, which D2 requires everywhere else — could create then approve a power naming themselves and make the fund emit the formal power-of-attorney letter, on letterhead and addressed to the president of the assembly, to all 15 members. Live: **0 of 20 rows are self-directed**. | **406** at *creation*, so no row and no self-addressed push notification are produced. 406 is v1's house style for a business-rule refusal on a create (`create_loan`). ⚠️ **No `(requester, meeting_date)` uniqueness rule** — operator **Q30a**, see §2.5. | `power.service.ts::createPower` |
| **D27** | `handle_power_request` writes `power.state` unconditionally and mails on approval, so **re-approving an already-approved power re-sends the fund-wide letter, unbounded**. Same defect class as D9; guarded in neither v1 nor the P3 port. | `0 → 1` and `0 → 2` only; anything else is **409** `{"message": "Invalid state transition"}` with **no mail**. | `power.service.ts::assertLegalPowerTransition` |
| **D29** | `create_loan` compares the **raw** body value against the column — `if obj['value'] > user_finance.available_quota` (`services/loan.py:27`) — and coerces only on the write. An integer-shaped **string** is therefore `TypeError: '>' not supported between instances of 'str' and 'int'`: an uncaught **500** before any row is written. ⚠️ And because the comparison is raw, a **fractional** `value` in `(available_quota, available_quota + 1)` is a **406**. | Two halves, decided separately. **(a) The ordering is v1's**: v2 compares raw and coerces for the write, the same sequencing Phase 3 established at `user.service.ts::updateUserFinance` (`pythonNotEqual`, then `toDjangoInt`). New shared helper `pythonGreaterThan`. **(b) A JSON string is still coerced** — v1's `TypeError` is a crash, not a rule, so `"100"` books the loan and `"600"` gets the fund's real **406** where v1 gives a 500. The deviation is taken at the call site, not inside the helper. | `loan.service.ts::createLoan`, `common/utils/python-obj.ts::pythonGreaterThan` |
| **D30** | **`value` has no lower bound.** `create_loan`'s only test is `> available_quota`, so `value: 0` and `value: -1000` as plain JSON numbers are **201 with a row written** — on **v1 and v2 alike**. ⚠️ Not a parity divergence: the two stacks *agree* today. | **400** `{"message": "Loan value must be greater than 0"}`, in **D4**'s style and with D4's status, checked on the **coerced** value (so `0.5` → `0` is caught) after the quota gate (so an over-quota request is still v1's 406). Operator: the fund has **no minimum loan amount**, so the floor is `1` as cheap insurance. ⚠️ **This is v2 *diverging* from v1 by decision** — see §4.1. | `loan.service.ts::MIN_LOAN_VALUE`, `::createLoan` |

### 1.2 D28 — WITHDRAWN, and carried deliberately

Operator **Q31** (2026-09-03, `docs/operator-q29a-q30a-q31.md`): a TREASURER approving **their
own loan** is accepted fund practice. `LoanDetailView.patch` is `[0, 2]` and
`update_loan(id, state)` never receives the actor's id (`services/loan.py:79`), so there is no
ownership check to fail. **Ported unchanged.** `m6` (a TREASURER writing their own `finance`)
is accepted with it.

The exposure, recorded so a future reader finds a *decision*:

1. the `finance` PATCH lets the TREASURER raise their own `available_quota`;
2. `create_loan` checks `value > available_quota` — the fund's **only** quota enforcement;
3. `LoanDetailView.patch` has no ownership check, so they can approve the result.

Three places carry it explicitly rather than silently:

* `permission-matrix.ts` is unchanged (`LoanDetailView.PATCH = [ADMIN, TREASURER]`) and the
  `LoanDetailController` class docblock names D28 and Q31;
* `LoanService`'s class docblock repeats it under "what is deliberately not changed";
* `test/loan.e2e-spec.ts` has a **passing assertion** that a TREASURER may approve their own
  loan. ⚠️ If that cell ever starts failing it is a **policy** change and needs an operator,
  not a fix.

`loan.service.spec.ts` additionally asserts `updateLoan.length === 2` — the signature has no
actor to check against, deliberately.

### 1.3 New deviations registered by this phase

| # | v1 behavior | v2 behavior | Rationale |
|---|---|---|---|
| **P4-D1** | `GET /api/user/<id>` for a **non-existent** id answers **404** for every caller. | Under **D25** the ownership check runs **before** the lookup, so a MEMBER asking for any id that is not theirs gets **403** whether or not the row exists. Roles `[0,1,2]` still get v1's 404. | The same ordering `updateUser`'s section gate already uses (§7 "C8 resolved", step 3), and for the same reason: authorising after the lookup turns the endpoint into an id-enumeration oracle, which is half of what D25 exists to close. ⚠️ **D10 orders itself the other way and that is deliberate, not drift** (**C44**): the loan predicate needs `loan.user_id`, so it must read first, and v2 keeps v1's 404 there. The two orderings are pinned mechanically — `loan.service.spec.ts` ("getLoan reads first", plus the older "a missing loan is 404 for everyone") and `user.service.spec.ts` ("getUser authorises before it reads"), each with an e2e twin. `manual-tester` will see 403-where-v1-404s on `GET /api/user/<n>` as a MEMBER; that is this row. |
| **P4-D2** | `LoanView.get`'s `all_loans` is honoured only for `user.role <= 2`; for a MEMBER the argument is **not passed** and the flag is a silent no-op. | Identical — recorded, not changed. | Not a deviation. Written down because it *looks* like one: a MEMBER sending `?all_loans=true` gets a 200 listing only their own loans, with no indication the parameter was ignored. Pinned by an e2e cell so nobody "fixes" it into a 403. |
| **P4-D3** | `LoanDetailView.patch` returns `Response(msg, 200)` with `msg = ''` for a denial and a payout. DRF's `JSONRenderer` renders that as the **two bytes `""`** (only `None` renders as zero bytes). | Identical — but v2 **was** answering zero bytes until this phase, because Nest's `ExpressAdapter.reply` sends `String(body)` for any non-object. Fixed, not deviated: `sendDrfBody` (`common/http/drf-response.ts`). | Recorded because it is a **bug this phase found and closed**, on the two most common loan writes, and because the same shape returns in Phase 8 (`FileDetailView.get` returns a bare URL string). Measured in the v1 container: `JSONRenderer().render('')` is `b'""'`, `render(None)` is `b''`. |
| **P4-D4** | `LoanView.get` calls `int()` on `state` and `page` **unguarded** (unlike `UserView.get`, which guards on presence), so `?page=`, `?page=abc` and `?state=abc` are **500**s. | Identical. | Ported deliberately. Registered so a 500 on a malformed query string is not filed as a v2 crash. |
| **P4-D5** | `refinance_loan` catches **only** `Loan.DoesNotExist`. A missing `disbursement_date` / `includeInterests` / `comments` key is an uncaught `KeyError` → **500**, and a loan with no `LoanDetail` makes `payment['capital_balance']` a `TypeError` → 500. | Identical. | The 400 on this route means "wrong loan" and never "wrong body". Registered because a 500 on a malformed refinance body looks like a defect and is the contract. |
| **P4-D6** | `update_loan`'s `transaction.atomic()` wraps the approval **including the SES call**, with no timeout — a hanging SES call hangs the request. | Same unit is wrapped, with Prisma's interactive-transaction budget set to **20 s** (`maxWait` 10 s), as `createUser` already does for the same reason (condition **C22**). | Prisma requires an explicit budget; the default 5 s is shorter than the mail leg's own worst case. The observable difference is confined to an SES outage: v1 hangs, v2 rolls the approval back after 20 s. No status or body changes on any healthy path. |
| **P4-D7** | `bulk_update_loans`'s `@transaction.atomic` has **no timeout** — a monthly run that takes an hour still commits. | The same unit is wrapped with Prisma's interactive-transaction budget set to **120 s** (`maxWait` 20 s). | Prisma requires an explicit budget and its default is 5 s, which a 28-loan file with a mail leg per approval can exceed. The all-or-nothing property is identical either way; the only observable difference is a run slower than two minutes, which commits in v1 and rolls back with a 500 here. The measured monthly run is far inside the budget. Registered at **C45/m3** so the pair is explicit: P4-D6 is the same decision for the 20 s approval budget, and leaving one of the two implicit is how the next one gets added unnoticed. |

---

## 2. Judgment calls

### 2.1 D4 removes the `> 36` clamp — **both** bounds are a 400

⚠️ **This section originally said the opposite, and was wrong.** Kept rather than deleted,
because the reasoning error is the reusable part.

`MIGRATION_PLAN.md` §5's D4 row says "Enforce `1 ≤ timelimit ≤ 36`; **no silent clamp**", while
§3's Phase 4 scope describes the clamp. That is not the plan contradicting itself — **§3
describes v1 and §5 decides what v2 does**, so a deviation *must* read as a disagreement
between them. Operator **Q9** ("Term outside 1–36" → "Reject 400"), recorded in §9, is the
decision; D4 implements it. **The clamp is gone.**

The original resolution cited v1's `test_post_loan_5`, which posts `timelimit: 37` and asserts
`201` with `timelimit == 36`. That test proves what v1 does — which is precisely what Q9
decided to change. Under a registered deviation a v1 test becomes a **moved expectation**, not
a requirement; it now asserts `400` in both suites, with a boundary control at `36 → 201` so
the edge is pinned from both sides.

**Why it went wrong, since it will recur:** §3's description, v1's test, and the dispatch
brief's paraphrase of §3 all agreed with each other against the register. Three sources that
all describe v1 will always agree, and that agreement carries no information about what v2
should do. **Check §5 and §9 before implementing anything §3 describes.** A precedence note now
sits at the head of `MIGRATION_PLAN.md` §5.

Corrected in `5aa8b1a`. §4.2 was not corrected at the same time and misled the first parity
round — see §4.2 and §5.2.

### 2.2 D4's status is 400, not 406

`create_loan`'s only other refusal is the quota 406, and 406 is the house style for a
business-rule refusal on a create. D4 is nevertheless a **400**, because that is what the
decided register row says (operator Q9). Flagged rather than silently harmonised: if the
operator prefers 406 for consistency, it is a one-line change and one e2e expectation.

### 2.3 D6 changes the approval write, not the bulk-upload write

`bulk_update_loans` calls `__update_loan_detail`, which is already an update and **raises
`LoanDetail.DoesNotExist` when the loan has no detail row** — v1 logs and skips it. That is
kept as a skip. Turning it into an upsert would either violate the FK (the file can name an id
with no loan at all — v1's own `create_test_file` does) or fabricate a payment schedule for a
loan still awaiting approval.

D6's "upsert not insert" therefore targets `__create_loan_detail` (approval) only, which is
where the second row comes from.

### 2.4 D9 makes one ported v1 test change its expectation

`test_update_loan_state` posts `{"state": 3}` to a loan still in **WAITING_APPROVAL** and
asserts 200 + `PAID_OUT`. In v1 that skips the approval entirely: no amortisation table, no
`LoanDetail`, no email, and the loan is closed without ever having been approved. `0 → 3` is
not a legal transition, so v2 answers **409** and leaves the row alone.

The ported cell keeps the v1 name and states the change inline. A second cell asserts the
*legal* `1 → 3` payout still answers 200, so the coverage the original test provided is not
lost.

### 2.5 D26 adds **no** uniqueness rule — this is load-bearing

Operator **Q30a**: a member changes who holds their proxy by **submitting a second request,
which supersedes the first**. That is live in the data — member 14 holds rows 18 and 20 for
the 2026-01-31 assembly. A `(requester, meeting_date)` uniqueness rule would break it.

Two e2e cells exist specifically to stop one being added later: two requests for the same
assembly to *different* requestees, and two to the *same* requestee, both must succeed.

### 2.6 D27 guards on the coerced state; the mail branch keeps v1's quirk

`power.state == 1` in v1 compares the **submitted** value against `1`, and Django does not
refresh the instance after `save()`. So `{"state": "1"}` writes `1` to the column (the field
coerces) and then compares `'1' == 1`, which is `False` in Python: **the row is approved and
no email is sent.**

D27's transition guard uses the **coerced** value — it must, because that is what gets
written. The mail branch still compares the raw body value, so the quirk survives untouched.
Pinned by an e2e cell.

### 2.7 The three deviations on `POST /api/user/power` had to survive a bare `except`

`UserAppsView.post` wraps its whole body in `except Exception: return Response(status=500)`,
and v2 reproduces that. D26's 406 and D27's 409 would have been laundered into 500s —
invisible to the caller and, worse, indistinguishable from a crash in a parity report.

`ApiException.deviation(...)` sets an `isDeviation` flag and `UserAppsController` re-raises
anything carrying it. D2's 403 is deliberately **not** flagged: it stays a plain
`DrfException.permissionDenied()` so its body is byte-identical to a role denial. **D9's 409
needs no flag** — `LoanDetailView.patch` has no bare `except`.

### 2.8 What was reused rather than re-implemented (condition C36)

`readUploadedFile`, `djangoFileLines`, `requireColumn`, `parseMoneyColumn`, `pythonInt`,
`lastQueryValue`, `days360`, `addRelativeDelta`, `formatDateEs`, `formatMoneyEs`,
`roundHalfEvenToBigInt`, `roundHalfDownDecimal`, the pagination envelope helpers and
`assertOwnership` are all imported, none copied. `parseMoneyColumn` in particular has exactly
one definition.

**One new shared helper was added**, because two call sites in two phases need it:

* `toDjangoDate(value, field)` in `common/utils/python-obj.ts` — Django's
  `DateField.to_python` → `dateparse.parse_date`. ⚠️ Its regex is `\d{1,2}` for month and day,
  and **v1's own loan fixtures depend on that** (`'2017-12-9'`, `'2018-1-1'`). Differentially
  verified against the real `DateField` in the v1 container over 20 inputs, including the
  trailing-newline case and both distinct error messages. See §3.2.
* `sendDrfBody(response, status, data)` in `common/http/drf-response.ts` — see **P4-D3**.

⚠️ **`parseMoneyColumn`'s documented `Number(raw)` vs CPython `float(str)` divergence was
re-checked for this phase and left unpinned.** The loan TSV's four money columns are produced
by the treasurer's spreadsheet export; `'0x10'` and `'1_000'` are not shapes a spreadsheet
emits, and pinning it means changing a helper Phase 3 already ships. **Raising it rather than
silently changing the helper**, exactly as the brief asks.

### 2.9 No calendar-"today" read exists on the loan path

The brief warns to route `from_date`, `payday_limit` and the T−5d/T−1d reminder dates through
`todayInBogota()`. Measured: **none of them is a "today" read.**

* `payday_limit` and `from_date` come out of the uploaded TSV;
* the two reminder dates are `payday_limit ± n days`;
* `__create_loan_detail`'s `from_date` is `loan.disbursement_date`, from the request body —
  the model's `default=date.today` never fires on that path.

The only clock read in the whole service is `Loan.created_at`, which is a `timestamptz`
(`auto_now_add`) and therefore `nowInstant()`, not a calendar date. `todayForAutoNowDateColumn()`
*is* used, in the e2e `seedLoanDetail` helper, for the `default=date.today` a fixture relies
on. **C28 is satisfied by there being nothing to satisfy it on**, which is worth stating
because "we used `todayInBogota` everywhere" would have been false.

---

### 2.10 PAID_OUT is terminal, and the recovery is a database repair — deliberately

Two places forward-reference this section; here is what it says.

**D6 and D9 are each correct and they interact.** D6 makes re-approval *safe* (upsert, not a
second `LoanDetail`). D9 makes it *unreachable*: `LEGAL_LOAN_TRANSITIONS` has no entry for
`LOAN_PAID_OUT`, so `3 → 1` is a **409**. So D6 makes the repair safe **when it happens**; it
does not make it happen through the API. After a mass auto-close there is no API-level recovery.

**That is now the operator's decision, not an oversight (2026-09-04).** `business-analyst`
recommended allowing `3 → 1`, ADMIN-only. The operator declined, and also declined a
notification on mass close. Both are registered as **withdrawn** rows — `MIGRATION_PLAN.md` §5
**D31** and **D32** — so the reasoning is findable rather than re-litigated.

**The fund's recovery procedure for a wrongly auto-closed loan is a direct database repair.**
Written down as a procedure. Whoever performs it needs three facts:

1. **D6's upsert means `LoanDetail` survives the close** — `capital_balance`, `payday_limit` and
   `from_date` are intact. A repair sets `fondo_api_loan.state` back to `1`. It must **not**
   re-run the approval: that upserts `capital_balance = loan.value` and `from_date =
   disbursement_date`, discarding every month of TSV state and re-mailing the borrower.
2. **The close deleted the payment reminders and nothing restores them.** `scheduleNotification`
   is reached only from the per-TSV-row path, never from approval, so the T−5d / T−1d rows for
   the current cycle are gone until the next upload. The repair must reconcile
   `fondo_api_schedulertask` itself.
3. **The loan may have partially self-healed, and that is worse than either end state** — see
   **D33**. `updateLoanDetail` resolves by `loan_id` with **no state filter**, so a wrongly
   closed loan left in next month's file gets its detail updated and its reminders **re-created
   while it stays PAID_OUT**: the member is pushed reminders for a loan the fund records as
   paid. So reminders may be present, absent, or duplicated depending on how many uploads have
   passed. Check, do not assume.

**`3 → 0` is rejected and must not be revisited** — it is `3 → 1` plus all of failure mode 1.

**Why "it has never happened" did not settle it.** The operator confirms no TSV has ever been
incomplete. The BA went looking for a forensic signature of a past wrong close and there is
none to find: `fondo_api_loan` has no `closed_at` and no state audit, and **336 of 345**
PAID_OUT loans carry a positive `capital_balance`, because omission from the next file *is* the
normal payoff path. A closed loan still showing money outstanding is the norm, not a red flag.
The question is unfalsifiable from the data; it was decided on risk appetite, and the operator
chose the smaller API surface.

## 3. How the money maths was validated

### 3.1 The amortisation table is checked **differentially against v1**, not against itself

`src/loans/amortization.fixture.ts` holds **16 loans** whose tables and summaries were produced
by re-executing `fondo_api/services/loan.py::__generate_table` **verbatim inside the running
v1 container** (`Django==2.2.27` / CPython 3.9 / `Babel==2.9.1` / `python-dateutil==2.7.5`,
`LANGUAGE_LOCALE='es'`) and dumping the result as JSON. Every table is compared **whole**.

Two of the 16 are additionally asserted character for character by v1's own suite
(`test_loan_views.py:420`, `:469`), which is the independent check that the generator is
faithful.

Coverage is aimed at the risks §3 names: month-end and leap-day disbursement (`2018-01-31`,
`2020-02-29`, `2024-02-29`), the year rollover, `days360`'s 30/31 rule, `UNIQUE` vs `MONTHLY`,
**two 36-row schedules**, real fund-scale money (25 871 634 and 30 000 000 — the two largest
live balances), a 1-row loan, a 5-peso loan whose instalments land on exact halves, and
`timelimit = 0` on a `UNIQUE` loan (the one shape D4's `DivisionByZero` does *not* reach).

**Two of my own expectations were wrong and the measurement corrected them**, which is the
reason the fixture exists rather than a hand-written table:

```
>>> ((Decimal(200) * Decimal('0.020')) / 30) * 30
Decimal('3.999999999999999999999999999')      # not Decimal('4')
>>> ((Decimal(200) * Decimal('0.020')) / 30) * 6
Decimal('0.7999999999999999999999999998')     # not Decimal('0.8')
```

Both round correctly (4 and 1) — but only because `common/utils/decimal.ts` pins
`precision: 28`. decimal.js defaults to 20.

### 3.2 `toDjangoDate` is checked against the real `DateField`

20 inputs run through `django.db.models.DateField().to_python` in the v1 container. All 20
agree, including `'2017-12-9'` (accepted), `'2018-01-01\n'` (accepted — Python's `$` matches
before one trailing newline), `'2018-01-01\n\n'` (rejected), `'2018-1-005'` (rejected) and the
**two distinct** error messages Django uses for "invalid format" versus "correct format,
invalid date".

### 3.3 `LoanSerializer` is checked against 11 live `fondodev` rows

`src/loans/dto/loan.serializers.fixture.ts` holds `serializer.data` captured from the real
serializers over 11 live loans and 4 live details, spanning all four states, both linkage
directions, a null `comments` and a null `disbursement_value`.

⚠️ **Loan 1 is the rule-5c cell and it is not hypothetical.** Its `created_at` is
`2018-01-01T00:00:00+00:00` and v1 renders it as **`31 dic. 2017`** — `timezone.localtime`
first. Its `disbursement_date`, a `DateField`, gets no conversion. A `fromDateColumn` on
`created_at` would print `1 ene. 2018` and be wrong for ~21% of every day.

Also confirmed from live output, rather than inferred: `rate` is a **JSON string**
(`"0.025"`, three places — `COERCE_DECIMAL_TO_STRING` defaults to `True` and v1 does not
override it), `user_id` is a plain integer, and `Meta.fields` key order is exactly as ported.

### 3.4 Every deviation was control-run

The brief's standing requirement (false-green register, 17 instances). Each control neuters
the deviation in a way that still **compiles** — a control that fails to build reports
"Tests: 0 total" and carries no information, which happened on the first attempt and was
redone:

| control | failures |
|---|---|
| D25 neutered (`assertOwnership(actor, actor.id, …)`) | **2** |
| D26 + D27 neutered | **11** |
| D4 + D6 + D9 + D10 neutered | **10** e2e, **12** unit |
| D4's clamp restored alone (upper bound removed, `Math.min` back) | **2** unit, **1** e2e — the moved `test_post_loan_5` cells |
| amortisation date anchoring broken (accumulate instead of anchor) | **13** |

All restored, and the full suites re-run green afterwards.

---

## 4. For `manual-tester`

### 4.1 Expected diffs against v1 — do **not** file these as parity failures

| Request | v1 | v2 | Row |
|---|---|---|---|
| `PATCH /api/loan/<id>` `{"state":3}` on a **WAITING_APPROVAL** loan | 200, loan → PAID_OUT | **409** `{"message":"Invalid state transition"}`, loan unchanged | **D9** |
| `PATCH /api/loan/<id>` `{"state":1}` on an **APPROVED** loan | 200, second `LoanDetail`, second email | **409**, no mail, no write | **D9** / **D6** |
| `PATCH /api/loan/<id>` `{"state":-1}` | 200, `state = -1` stored | **409** | **D9** |
| Two **concurrent** `PATCH /api/loan/<id>` on the same WAITING loan, one `{"state":1}` and one `{"state":2}`, approve committing first | both 200 (v1 has no serialisation at all: the second overwrites the first, and on `1→1` writes a second `LoanDetail` and re-mails) | winner 200; **loser 409** `{"message":"Invalid state transition"}`, no denial mail, no `refinanced_loan` unlink | **D9** / **M3** ⚠️ **C51 — a known asymmetry, not a bug to file.** Sequentially the denial would be a **200** (`1→2` is legal). The compare-and-set answers 409 instead. Every other race pair gets the same status either way. Needs two simultaneous requests to observe; if you see it, it is expected. |
| `PATCH /api/loan` (the TSV) | `200`, **no body** | `200 {"closed_loans":[…]}` | **D8** |
| `POST /api/loan` with `timelimit: 0` | **201** (then a 500 at approval) | **400** `{"message":"Timelimit must be between 1 and 36"}` | **D4** |
| `POST /api/loan` with `timelimit: 37` | **201**, silently booked as `36` at rate `0.025` | **400** `{"message":"Timelimit must be between 1 and 36"}`, no row written | **D4** |
| `POST /api/loan/<id>/refinance` with `timelimit: 0` or `> 36` | **200** / clamped, row written (`LoanAppsView.post` returns `HTTP_200_OK`, not 201 — measured; parity finding **P4-F3**) | **400**, same message | **D4** |
| `GET /api/loan/<id>` as a MEMBER who does not own it | 200 | **403** `{"detail":"You do not have permission to perform this action."}` | **D10** |
| `POST /api/loan/<id>/paymentProjection` as a MEMBER who does not own it | 200 | **403**, same body | **D10** |
| `GET /api/user/<id>` as a MEMBER, another member's id | 200 with their `finance` | **403**, same body | **D25** |
| `GET /api/user/<n>` as a MEMBER, an id that does **not exist** | 404 | **403** | **P4-D1** |
| `POST /api/user/power` `{"type":"post", requestee: <self>}` | 200, row written, self-addressed push | **406** `{"message":"Requester and requestee must be different users"}`, no row, no push | **D26** |
| `POST /api/user/power` `{"type":"patch", state:1}` on an already-approved power | 200 **and the fund-wide letter again** | **409** `{"message":"Invalid state transition"}`, no mail | **D27** |
| `PATCH /api/loan/<id>` `{"state":2}` or a legal `{"state":3}` | `200` body `""` | `200` body `""` | **P4-D3** — v2 was zero bytes before this phase; now identical. Worth one confirming cell. |
| `POST /api/loan` with `value: 0` or `value: -1000` (plain JSON **numbers**) | **201**, row written | **400** `{"message":"Loan value must be greater than 0"}`, no row | **D30** ⚠️ **v1 accepts this and so did v2 — the refusal is a decision, not a repair.** The two stacks *agreed* before this row landed, which is exactly why it is listed: file the 400 as **expected**. |
| `POST /api/loan` with `value: 0.5` | **201**, row written with `value = 0` | **400**, same message, no row | **D30** — the bound runs on the coerced value, and `int(0.5)` is `0`. |
| `POST /api/loan` with `value: "-1000"` | **500** (`TypeError`, no row) | **400**, same message, no row | **D30** via **D29** — the string is coerced first, then refused by the same money bound. |
| `POST /api/loan` with `value: 1` | 201 | 201 | **D30** — the floor is *inclusive*; the fund has three live loans at `value = 1`. Not a diff; listed so the boundary is probed from both sides. |
| `POST /api/loan/<id>/refinance` whose projected **`value`** — the `capital_balance`, plus the interests if `includeInterests` is truthy — is **less than 1** | 200, a loan is written with that value | **400** `{"message":"Loan value must be greater than 0"}` | **D30** — `refinance_loan` overwrites `value` and calls the same `create_loan`, so the floor binds there too although the *quota* check is skipped. ⚠️ The bound is on the **projected value**, not on `capital_balance`: the interests are added *before* `create_loan` sees the number, and the floor is checked after `toDjangoInt`. ⚠️ A **negative** `capital_balance` behaves the same and produces a strictly worse v1 row — `value = -500`, or `-522` with `includeInterests`, i.e. interest computed on a negative balance. Kept explicit rather than folded into "≤ 0", because that is the v1 row a reader should see. ⚠️ **v1 writes the child row *and* sets the parent's `refinanced_loan`; v2 touches no table at all** (measured: `tables touched: []`), and that is the **intended shape** — a refused refinance must leave no half-linked chain. Do not "fix" it by moving the link ahead of the create (**C52**). |
| `POST /api/loan` with `value` = `available_quota + 0.5` (e.g. `500.5` against a 500 quota) | **406** `{"message":"User does not have available quota"}` | **406**, identical | **D29** ⚠️ **This one was a diff and is now fixed — measured, not assumed.** Before the fix v2 answered **201 and stored `500`**, a different number from the one submitted, because it truncated before comparing. The divergent window was exactly `quota < value < quota + 1`. If it ever answers 201 again, that IS a failure. |
| `POST /api/loan` with an integer-shaped **string** `value` (`"100"`, `" 100 "`, `"+100"`) | **500** (`TypeError: '>' not supported between instances of 'str' and 'int'`), no row | **201**, row identical to a well-formed request | **D29** — v1's refusal is a crash, not a rule. Unchanged by the ordering fix. |
| `POST /api/loan` with an over-quota string `value` (`"600"` against a 500 quota) | **500**, no row | **406** `{"message":"User does not have available quota"}` | **D29** — the member gets the fund's real answer. |
| `POST /api/loan` with a non-integer string `value` (`"1e3"`, `"1000.7"`, `""`, `"0x10"`) | **500** | **500** | **D29** — unchanged on both. Not a diff; listed because the neighbouring cells are. |

### 4.2 Explicitly **unchanged** — if these differ, that IS a failure

* ⚠️ **`timelimit: 37` is NOT in this list — it MOVED.** v1 answers `201` with
  `timelimit == 36`; **v2 answers `400`** and writes no row (D4, operator Q9). It sat here
  by mistake until 2026-09-04, telling the tester to file the *correct* D4 behaviour as a
  failure. See §4.1 and §5.2.
* The rate table: `≤6 → 0.015`, `7–12 → 0.020`, `13–24 → 0.022`, `25–36 → 0.025`, frozen at
  request time.
* Quota refusal → **406** `{"message":"User does not have available quota"}`; the check is
  `>`, not `>=`; skipped for a refinance.
* A **TREASURER approving their own loan** → **200**. D28 is withdrawn (Q31).
* Listing order `-created_at, -id`; `state=4` means all; `all_loans` honoured only for roles
  ≤ 2 and a silent no-op otherwise; `paginate` and `all_loans` compared as the exact string
  `'true'`.
* `?page=`, `?page=abc`, `?state=abc` → **500** (P4-D4).
* `paymentProjection` on an unknown loan → **404** zero bytes; `refinance` on an unknown loan
  → **400** zero bytes. Different codes, deliberately.
* A malformed refinance body → **500**, never 400 (P4-D5).
* `PATCH /api/loan` with JSON, form, or multipart-without-`file` → **500**; `text/plain` →
  **415**. Rule 12b: the `@parser_classes` narrowing is a no-op in v1 and must not be
  "restored".
* `/api/loan/<id>/` (trailing slash) → **404**; `/api/loan/` → **200**.
* `OPTIONS` on any loan route → **403** for every role, ADMIN included.
* `DELETE /api/loan` → **403** for ADMIN.
* The auto-close is **silent** — no mail, no push — and its candidate set is *every* APPROVED
  loan absent from the file.
* ⚠️ **D33 — the partial self-heal on a PAID_OUT loan.** `__update_loan_detail` resolves by
  `loan_id` **alone, with no state filter**, so re-listing an already-closed (state `3`) loan
  in a later monthly file **updates its `LoanDetail` and re-creates both payment reminders**,
  on **both** stacks. It is a non-diff, which is why it belongs here and not in §4.1: if the
  two stacks ever differ on it, that IS a failure. Measured 2 → 0 → 2 across two uploads, both
  stacks. It is also **load-bearing** — §2.10 instructs a DBA to *expect* the self-heal after
  a repair — so it is pinned in-repo by a unit cell (`loan.service.spec.ts`, "D33"), not only
  in the parity harness. Adding a state filter to `updateLoanDetail` is exactly the
  obvious-looking tidy-up that would break it silently (**C53**).

### 4.3 Pre-declared rows — do not re-file them here

**D22** (a non-ASCII multipart `boundary`) and **D23** (a scalar part carrying a `filename`)
are §5 rows whose text explicitly covers "**P4 bulk loan upload / P8 file upload**". They are
accepted and not reproduced. **D21** (`HEAD` bodies) is cross-cutting.

### 4.4 ⚠️ Data safety when probing this phase

`bulk_update_loans` **auto-closes every APPROVED loan absent from the file** — 28 of them in
`fondodev` today, i.e. the whole fund. Exercise it against a restorable fixture only, and
restore **from the dump**, never from reconstructed statements. The pre-write dump for this
phase is `~/.fondo-parity-dumps/p4-20260903-160323/`; take a fresh one before the parity round.

---

## 5. To fold back into `MIGRATION_PLAN.md`

### 5.1 D6's physical `UNIQUE (loan_id)` moves to Phase 9

Exactly as **D11** did, and for the same reason: §4 rule 6 forbids v2 running schema
migrations against a database v1 shares, and Django owns the schema until cutover. The
**application** half shipped here (upsert + deterministic reads). Checked on `fondodev`:
**0 loans currently have more than one `LoanDetail`**, so the constraint will apply cleanly
when Phase 9 adds it.

⚠️ **This section used to claim "nothing in v2 can create a second row". That was false, and
the review (M3) was right to reject it.** `updateLoanIn` read the loan, checked the transition
and then wrote with `where: { id }`; Prisma's interactive transaction runs at the database
default, **READ COMMITTED**, so two concurrent `PATCH /api/loan/<id> {"state":1}` on the same
WAITING loan both read state `0`, both passed the guard, both found no detail row and **both
inserted one**. The window is a double-clicked approve button — the same shape of event that
produced v1's duplicates.

**The guarantee actually provided now**, stated so it can be checked rather than believed:

> The state write is a **compare-and-set** — `updateMany({ where: { id, state: <the state
> that was read> }, data: { state } })` — and a `count` of `0` is **D9's own 409**
> (`{'message': 'Invalid state transition'}`), the same answer the caller would have received
> had it lost the guard instead of the write. Because the predicate includes the state, the
> second transaction blocks on the first's row lock and re-evaluates after it commits, so
> **at most one transition can proceed on the loan named in the URL**, and therefore at most
> one `upsertLoanDetail` runs. That is what makes "no second row" true, and it is true only for
> transitions that go through `updateLoanIn` — which, in v2, is all of them, the
> `bulkUpdateLoans` auto-close included.

⚠️ **Two narrowings on that sentence, both of them the review's (condition C55).**

**It is "the loan in the URL", not "per loan".** The same method also writes the loan's
*neighbour* — `prev_loan.state = PAID_OUT` when a refinance is approved, and
`prev_loan.refinanced_loan = null` when one is denied — and **those two writes are
unconditional `update`s, not compare-and-sets**. They carry no guard, so a refinance chain's
parent has no protection from this mechanism at all; what protects it is that the only route
that writes it is this one, reached through a CAS on the child. Read literally, "at most one
transition per loan" would claim something about `prev_loan` that is not true.

**What the CAS pins is `state` and nothing else.** Every other column the approval consumes —
`value`, `timelimit`, `fee`, `rate`, `disbursement_date`, i.e. the entire input to the
amortisation table and to the borrower's email — comes from the **pre-CAS `findUnique`**. If
any of them changed between that read and the write, the CAS would still match (it only
compares `state`) and the table would be generated from stale numbers. That is safe **today
for one reason only: no route mutates those columns after creation.** There is no
`PATCH /api/loan/<id>` that edits a value, and a refinance creates a *new* row rather than
editing the old one. The invariant is therefore a property of the current routing table, not
of this method — so the day a "correct a mistyped loan value" endpoint is added, this
paragraph is the one that has to change with it, and the fix is to widen the CAS predicate to
the columns the table consumes.

⚠️ **What the auto-close does with a CAS miss — corrected 2026-09-04 (review condition C50).**
The paragraph above used to read as if the bulk path degraded gracefully. It did not: the
auto-close called `updateLoanIn` with **no `try`/`catch`** inside the 120 s `$transaction`, so
a concurrent `PATCH /api/loan/<id> {"state":2}` committing between `getLoans(state=1)` and the
auto-close write threw D9's 409 **out of the transaction callback and rolled back the entire
monthly upload** — all 374 `LoanDetail` upserts and every other auto-close — answered with a
409 that named neither the file nor the loan. v1 cannot fail here at all (`update_loan(id, 3)`
writes unconditionally and silently wins the lost update), so it was a **v2-only failure mode
the compare-and-set created**. It is now caught: the loan is logged at `warn`, **skipped**,
left out of `closed_loans`, and the upload commits — mirroring v1's
`except LoanDetail.DoesNotExist: continue` in the same method's first loop, and semantically
right, since a loan someone *just denied* must not be force-closed by a file generated before
the denial. The catch is **narrow** — only D9's 409; a 404 or any other error still aborts the
upload. Pinned by two unit cells (`loan.service.spec.ts`, `C50: …`).

⚠️ **A known asymmetry in the 409 — review condition C51.** The loser of a race gets the same
answer sequential execution would have given for **five of the six** race pairs D9 permits
(`0→1` vs `0→1`, `0→2` vs `0→2`, `0→2` vs `0→1`, `1→2` vs `1→3`, `1→3` vs `1→2` — in each the
loser faces a state with no legal move). The sixth is **winner `0→1`, loser `0→2`**: an approve
and a deny racing on a WAITING loan, approve first. From state `1`, `1→2` is legal, so
sequentially the denier gets a **200**, the denial mail and the `prev_loan.refinanced_loan =
null` unlink; under the CAS they get `"Invalid state transition"`, which reads as "do not
retry" — and the deny is the safety-side action. **Registered rather than fixed:** the
resolution (on `count === 0`, re-read the row and re-run the guard once, retrying if the
transition is legal from the new state) reproduces sequential semantics exactly but changes
behaviour on the money path and needs its own review cycle; the window is milliseconds and no
caller has reported it. Pinned by `C51: a deny that loses to a concurrent approve gets a 409
where sequential execution gives a 200` so it stays measured rather than becoming folklore —
if the retry ever lands, that cell must flip to a 200.

Two honest limits on that guarantee:

* It is an **application-level** guarantee on `fondo_api_loan.state`, not a constraint on
  `fondo_api_loandetail`. A writer that is not v2 — a DBA, or v1 itself while both stacks are
  live — can still insert a duplicate. Only Phase 9's physical `UNIQUE (loan_id)` closes that,
  which is why it must not slip again.
* **The race IS reproduced — deterministically, and in two places** (condition **C55**; the
  sentence this replaces, *"no test races two real transactions"*, was true when written and
  stopped being true with `d3-race.py`).
  * `scripts/parity/d3-race.py` runs it against **both** stacks and carries the positive
    control that gives the result its meaning: **v1 answers 200/200, writes two `LoanDetail`
    rows and sends two borrower emails** — the exact corruption D6 exists to survive — while v2
    answers 200/409 and writes one of each. Measured, recorded in `out-d3.json`.
  * `test/loan-race.e2e-spec.ts` is the v2 half as an **opt-in** Jest cell
    (`FONDO_RACE_CELL=1 npm run test:e2e -- loan-race`), so the construction survives without
    the harness. Verified to discriminate: replace the CAS predicate with `where: { id }` and
    it goes red with 200/200.

  Neither depends on timing, which is the objection the old sentence was right about. A third
  connection holds an explicit `SELECT … FOR UPDATE` on the loan; both requests read state `0`
  and pass the guard (a plain `SELECT` is not blocked by it); both then block on the write; and
  **nothing is asserted until `pg_stat_activity` shows two sessions waiting on a lock**. The
  interleaving is established by the database. The three query-shape unit cells
  (`{ where: { id, state }, data: { state } }`, the auto-close's predicate, and the 409 on
  `count === 0`) remain, and are what runs in the default gate.
  ⚠️ **Phase 9 must re-run both** — once before its `UNIQUE (loan_id)` lands and once after.

### 5.2 §5's D4 row and §3's Phase 4 scope — **resolved, §5 was right**

Originally filed the other way round, and that was wrong. §3 *describes v1*; §5 *decides what
v2 does*. Operator **Q9** ("Term outside 1–36" → "Reject 400") is recorded in `MIGRATION_PLAN.md`
§9 and D4 is its implementation, so **the clamp is gone** and `test_post_loan_5` is a **moved
expectation**, not a requirement.

The trap is worth naming, because §3 and §5 will disagree again in every remaining phase **by
construction** — that is what a deviation register *is*. Here, §3's description, v1's own test,
and the dispatch brief's paraphrase of §3 all agreed with each other **against** the register.
Three sources that all describe v1 will always agree; that agreement carries no information
about what v2 should do. A precedence note now sits at the head of `MIGRATION_PLAN.md` §5.

Corrected in `5aa8b1a`. This section's §4.2 entry was **not** corrected with it and misled the
first parity round — see §4.2.

### 5.3 D8 was not in the brief's "deviations that land in this phase" list

The brief names D4, D6, D9, D10, D25, D26, D27. **D8** is marked "P4 / ✅ Decided — change" in
§5 and would otherwise have blocked the gate as an undecided-but-unimplemented row, so it is
implemented. ⚠️ It is a **response-shape change** and the brief's omission means the operator
may not be expecting it — flagged rather than assumed.

### 5.4 The test-porting table's Phase 4 row

`test_loan_views.py` is **33** methods; all 33 are ported to `test/loan.e2e-spec.ts` (91 cells
in total), with the one moved expectation documented at §2.4.

---

## 6. Phase 4's review conditions — the C59 ledger

**Condition C59** (`docs/review-phase-5.md` §7/§8) required that C44–C49 and C52–C57 **close or
be formally struck**, each with C58's evidence standard: exercise the behaviour or read the whole
function, never match a string, and record the audit's own errors. They had survived two gates;
C48's warning that a third roll makes the tracking decorative had been reached.

Worked at `chore/phase-6-gate` off `e6571bb`. One row per condition, with the artefact and the
control that proves it discriminates.

| # | Outcome | Evidence |
|---|---|---|
| **C44** | ✅ **Closed** — wording corrected; cells were **already present** (see the audit correction below) | §1.1's D25 row and §1.3's P4-D1 row now distinguish the shared **rule** from the differing **evaluation order**, with the path-derived-vs-row-derived reason. Cells: `test/loan.e2e-spec.ts` *"a non-existent loan is still 404 for everyone"* and `test/user.e2e-spec.ts` *"for a MEMBER a non-existent id is also 403, not 404"* — both landed in `0a8cf62`, the original Phase 4 commit. Added a mechanical pin per side next to the role-array guard (`loan.service.spec.ts` *"getLoan reads first"*, `user.service.spec.ts` *"getUser authorises before it reads"*, the latter asserting **no row is read at all**). **Control:** both orderings flipped in the source → 3 cells red, restored → 145 green. |
| **C45** | ✅ **Closed** (five items) | **m3** `P4-D7` registered in §1.3 and at the call site. **m5** `mailBcc` moved into the `APPROVED` and `DENIED` arms — an auto-close now issues no `getUserEmails` query at all, where it issued one per closed loan inside the 120 s transaction. **m6** the `getUserIds`/`getUserEmails` carve-out from the "every query on a transactional path takes the client" rule is documented at the call site, with the reason it is safe (read-only, on tables neither transaction writes). **m7** `getLoans` now throws for `userId === null && !allLoans`, as its `page === null` sibling already did — Prisma drops an `undefined` filter and would have listed the whole fund where Django returns nothing. **§4/n4** the D28 exposure is written at the quota gate itself. |
| **C46** | ✅ **Closed — measured on both stacks, then reproduced** | v1, read-only in the pinned container: `LoanDetail.objects.get(loan_id=X)` raises `DoesNotExist` for `999999`, `2**31`, `3e9` **and** `2**63` — logged and skipped, upload continues. v2 before the fix, against the throwaway test database: Prisma refuses at `2147483648` with `Value out of range for the type … integer`, which is not D9's 409, so the narrow catch rethrows it and the whole monthly file rolls back. Fixed by mapping out-of-`Int32` to `-1`, the same sentinel and the same reasoning as `parseLoanPathId`. Cell: `test/loan.e2e-spec.ts` *"C46: an out-of-32-bit-range id is skipped, and the rest of the file still applies"*. **Control:** fix reverted → exactly that cell red, 104 tests still collected. The fractional-quota half had already landed with D29. |
| **C47** | ✅ **Closed** | The 28 per-loan `log` lines are replaced by **one `warn`** carrying the count and the id list in close order. `MIGRATION_PLAN.md` §9 gains "Runbook items carried from Phase 4 findings" item 5: `PATCH /api/loan` now returns `{closed_loans: […]}` and the client must be changed for D8 to be a notice rather than a capability — with M2's caveat that a treasurer who notices still cannot undo it. |
| **C48** | ⚪ **Already closed, superseded** | C48 asked that the Phase 3 conditions be closed or re-dated. `docs/review-phase-4-delta.md` §7 escalated it to **C58**, and `docs/review-phase-5.md` §7 records C58 as done ("fifteen conditions audited against the tree in one batch, two of the audit's own verdicts caught and corrected"). Not re-opened; listed so the eleven-vs-twelve arithmetic is explicit. |
| **C49** | ✅ **Closed** (n1–n4 + the Phase 9 list) | **n1** `@DrfNoRequestData()` added to `loan-apps.controller.ts`'s `@All()` fallback — the only one of three missing it, item 5 of `docs/adding-a-route.md`. **n2** `amortization.spec.ts`'s title now reads "matching D4's upper bound"; there is no clamp. **n3** new `src/common/utils/decimal.spec.ts` names CPython's default context and pins `prec=28` with a discriminator (`1/7` to 28 digits, which precision 20 cannot produce) and `ROUND_HALF_EVEN` against `Math.round`. **n4** at the quota gate, above. Plus `MIGRATION_PLAN.md` §3 Phase 9: **"v1 defects deliberately carried into v2 — re-decide once at cutover, or never"**, eight entries, **P4-D4 first**. |
| **C52** | ✅ **Closed** | §4.1's refinance row now reads "the projected **`value`** — the `capital_balance`, plus the interests if `includeInterests` is truthy — is **less than 1**", keeps the negative case explicit (with the `-500` / `-522` v1 rows), and carries the parent-unlinked clause **as the intended shape**. `refinanceLoan`'s docblock records that D30 made its "no transaction" warning reachable and that touching no table is the intended outcome. D30's message nit now has an owner (`business-analyst`) and a phase (**P9**), replacing "a later pass". |
| **C53** | ✅ **Closed** | §4.2 gains the D33 bullet (it is a non-diff, so §4.1 was the wrong home) stating that it is load-bearing for §2.10. Unit cell `loan.service.spec.ts` *"D33: a PAID_OUT loan listed in the file still has its detail updated and its reminders re-created"* — asserts the update, both `scheduleNotification` calls, **and the shape of the query** (`Object.keys(where) === ['loan_id']`). **Control:** added the obvious `loan: { state: 1 }` filter → that cell alone red. |
| **C54** | ✅ **Closed** | Three carriers, none of them a phase document addressed to a reviewer: a 📍 pointer on §5's D31 row naming `docs/phase-4-deviations.md` §2.10; a new "Incident procedures that outlive the cutover" block inside **Phase 9's runbook**; and §9 runbook item 6, which also carries D33's consequence for the reminders. |
| **C55** | ✅ **Closed** (all three) | "at most one transition **per loan**" → "on the loan named in the URL", with the reason: the `prev_loan` `state` and `refinanced_loan` writes are **unconditional `update`s** — verified by reading all four `loan.update` call sites, not from the review. The CAS invariant is now stated: only `state` is pinned, every column feeding the amortisation table comes from the pre-CAS read, and that is safe **only because no route mutates them** — verified by the same sweep. "No test races two real transactions" is replaced by a citation of both artefacts and the reason neither depends on timing. |
| **C56** | ✅ **Closed** | `scripts/parity/d3-race.py` — verbatim, out of the home directory, with a header saying what it needs and why it is kept unmodified. Plus `test/loan-race.e2e-spec.ts`, the v2 half as an **opt-in** cell (`FONDO_RACE_CELL=1`) that needs no harness: a third connection holds `SELECT … FOR UPDATE`, and nothing is asserted until `pg_stat_activity` shows two sessions blocked. **Control:** CAS predicate reduced to `where: { id }` → 200/200 and the cell fails. |
| **C57** | ✅ **Closed** (all three nits) | C22's budget note now says what the 20 s covers **since M3** (a queued caller *plus* SES) and what a P2028 looks like to the caller — pinned by `api-exception.filter.spec.ts` *"a Prisma P2028 renders P3-D6's uncaught shape"* with a 409 as the discriminator, rather than asserted in prose. `pythonTypeName`'s unreachable `return 'float'` is split and explained: `number` is now handled, and the remaining fall-through covers `symbol`/`function`, for which the noun really is wrong and unreachable. False-green **#18** now cross-references **#19** in both directions. |

### 6.1 An error this audit made, recorded rather than quietly repaired

`docs/review-phase-5.md` §7's audit table says C44's two ordering cells are **absent**. They are
not, and were not: both landed in **`0a8cf62`**, the original Phase 4 commit, *before* the Phase 4
review that raised C44 — and `loan.service.spec.ts` additionally carried
*"a missing loan is 404 for everyone, before D10 can produce a 403"* the whole time. So the loan
side was pinned twice and the user side once when the condition was written asking for them.

Two things follow, and the second is the useful one. The condition's remaining substance was the
**wording**, which was genuinely still open and is what §1.1 and §1.3 now carry. And the audit
that "found" the cells missing was itself a string search for an artefact rather than a read of
the file that would hold it — the exact failure C59 required this batch to avoid. Recorded here
because an audit that reports only what it found is the same failure mode as a probe that reports
only agreement.
