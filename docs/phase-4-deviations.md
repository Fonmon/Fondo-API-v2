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
| §5 register implemented | **D4, D6, D8, D9, D10, D25, D26, D27** |
| §5 register **withdrawn**, ported as-is | **D28** (and **m6** with it) — operator **Q31** |

**Gate numbers**

| | before | after |
|---|---|---|
| unit | 1628 / 55 suites | **1830 / 58 suites** |
| e2e | 699 + 1 skipped / 15 suites | **818 + 1 skipped / 16 suites** |

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
| **D6** | `LoanDetail.loan` is a plain `ForeignKey`, so re-approving a loan **inserts a second detail row**; `LoanDetail.objects.get(loan_id=...)` then raises `MultipleObjectsReturned` and `GET /api/loan/<id>` is a permanent **500**. This is the recovery path for a wrongly auto-closed loan, so the recovery *is* the corruption. | The approval write is an **upsert** keyed on `loan_id`, and **every** read of `LoanDetail` is `findFirst` + `orderBy: {id: 'asc'}` — deterministic, so a pre-existing duplicate degrades to "the second row is ignored" instead of a permanent outage. ⚠️ The physical `UNIQUE (loan_id)` is **not** applied — see §5.1. | `loan.service.ts::upsertLoanDetail`, `::readLoanDetail`, `::updateLoanDetail` |
| **D8** | `bulk_update_loans` answers a bare `200` with **no body**, so nothing tells the treasurer which loans the upload just closed. | `200 {"closed_loans": [<ids>]}`, in close order, with no cap on length (operator Q3). | `loan.service.ts::bulkUpdateLoans` |
| **D9** | `update_loan` writes `loan.state` unconditionally. Re-approving regenerates the amortisation table, writes a second `LoanDetail` (D6) and re-sends the borrower's email; `3 → 1` re-opens a closed loan; a **negative** state passes `LoanDetailView.patch`'s `new_state <= 3` check and is stored verbatim. | Legal transitions only — `0→1`, `0→2`, `1→3`, `1→2` (operator Q14). Anything else is **409** `{"message": "Invalid state transition"}` with **no mail, no scheduler write and no state change**. The loan is looked up first, so a missing id is still v1's 404. | `loan.service.ts::assertLegalLoanTransition` |
| **D10** | `GET /api/loan/<id>` and `POST /api/loan/<id>/paymentProjection` are role ≤ 3 with **no ownership check**, so any member reads any loan by id — value, rate, comments, outstanding capital. | The loan's **owner plus roles `[0,1,2]`** (operator Q16). DRF's generic 403, byte-identical to a role denial. `refinance` is unchanged: v1 already restricts it to the owner. | `loan.service.ts::getLoan`, `::paymentProjection` |
| **D25** | `GET /api/user/<id>` is role ≤ 3 with no ownership check, so any member reads any other member's `finance` block — `utilized_quota` and `total_savingaccounts`. v1 is inconsistent with itself: it hard-filters the *loan list* by role and returns no finance on the *user list*. | **The same predicate and the same roles as D10** — owner plus `[0,1,2]`. Operator **Q29a**: no client screen reads another member's detail. `GET /api/user/-1` is unaffected (the `-1` substitution runs first, so it always takes the owner branch). | `user.service.ts::getUser` |
| **D26** | Nothing forbids `requester === requestee` on a power request. A member acting **alone** — with no second party's consent, which D2 requires everywhere else — could create then approve a power naming themselves and make the fund emit the formal power-of-attorney letter, on letterhead and addressed to the president of the assembly, to all 15 members. Live: **0 of 20 rows are self-directed**. | **406** at *creation*, so no row and no self-addressed push notification are produced. 406 is v1's house style for a business-rule refusal on a create (`create_loan`). ⚠️ **No `(requester, meeting_date)` uniqueness rule** — operator **Q30a**, see §2.5. | `power.service.ts::createPower` |
| **D27** | `handle_power_request` writes `power.state` unconditionally and mails on approval, so **re-approving an already-approved power re-sends the fund-wide letter, unbounded**. Same defect class as D9; guarded in neither v1 nor the P3 port. | `0 → 1` and `0 → 2` only; anything else is **409** `{"message": "Invalid state transition"}` with **no mail**. | `power.service.ts::assertLegalPowerTransition` |

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
| **P4-D1** | `GET /api/user/<id>` for a **non-existent** id answers **404** for every caller. | Under **D25** the ownership check runs **before** the lookup, so a MEMBER asking for any id that is not theirs gets **403** whether or not the row exists. Roles `[0,1,2]` still get v1's 404. | The same ordering `updateUser`'s section gate already uses (§7 "C8 resolved", step 3), and for the same reason: authorising after the lookup turns the endpoint into an id-enumeration oracle, which is half of what D25 exists to close. `manual-tester` will see 403-where-v1-404s on `GET /api/user/<n>` as a MEMBER; that is this row. |
| **P4-D2** | `LoanView.get`'s `all_loans` is honoured only for `user.role <= 2`; for a MEMBER the argument is **not passed** and the flag is a silent no-op. | Identical — recorded, not changed. | Not a deviation. Written down because it *looks* like one: a MEMBER sending `?all_loans=true` gets a 200 listing only their own loans, with no indication the parameter was ignored. Pinned by an e2e cell so nobody "fixes" it into a 403. |
| **P4-D3** | `LoanDetailView.patch` returns `Response(msg, 200)` with `msg = ''` for a denial and a payout. DRF's `JSONRenderer` renders that as the **two bytes `""`** (only `None` renders as zero bytes). | Identical — but v2 **was** answering zero bytes until this phase, because Nest's `ExpressAdapter.reply` sends `String(body)` for any non-object. Fixed, not deviated: `sendDrfBody` (`common/http/drf-response.ts`). | Recorded because it is a **bug this phase found and closed**, on the two most common loan writes, and because the same shape returns in Phase 8 (`FileDetailView.get` returns a bare URL string). Measured in the v1 container: `JSONRenderer().render('')` is `b'""'`, `render(None)` is `b''`. |
| **P4-D4** | `LoanView.get` calls `int()` on `state` and `page` **unguarded** (unlike `UserView.get`, which guards on presence), so `?page=`, `?page=abc` and `?state=abc` are **500**s. | Identical. | Ported deliberately. Registered so a 500 on a malformed query string is not filed as a v2 crash. |
| **P4-D5** | `refinance_loan` catches **only** `Loan.DoesNotExist`. A missing `disbursement_date` / `includeInterests` / `comments` key is an uncaught `KeyError` → **500**, and a loan with no `LoanDetail` makes `payment['capital_balance']` a `TypeError` → 500. | Identical. | The 400 on this route means "wrong loan" and never "wrong body". Registered because a 500 on a malformed refinance body looks like a defect and is the contract. |
| **P4-D6** | `update_loan`'s `transaction.atomic()` wraps the approval **including the SES call**, with no timeout — a hanging SES call hangs the request. | Same unit is wrapped, with Prisma's interactive-transaction budget set to **20 s** (`maxWait` 10 s), as `createUser` already does for the same reason (condition **C22**). | Prisma requires an explicit budget; the default 5 s is shorter than the mail leg's own worst case. The observable difference is confined to an SES outage: v1 hangs, v2 rolls the approval back after 20 s. No status or body changes on any healthy path. |

---

## 2. Judgment calls

### 2.1 D4 keeps the `> 36` clamp, and only adds the lower bound

`MIGRATION_PLAN.md` §5's D4 row says "Enforce `1 ≤ timelimit ≤ 36`; **no silent clamp**", and
§3's Phase 4 scope says "`timelimit > 36` **clamped to 36** silently … ⚠️ `timelimit` has no
lower bound … Add validation (§5 D4)". **The plan contradicts itself.**

Resolved in favour of §3 and of the phase brief, which is explicit on both halves ("port …
the silent `timelimit > 36` clamp before the rate lookup" / "`timelimit` has no lower bound in
v1; `0` is accepted at create then crashes with DivisionByZero at approval. Add validation").

The deciding evidence is v1's own suite: **`test_post_loan_5` posts `timelimit: 37` and
asserts a `201` with `timelimit == 36`.** Removing the clamp would move a ported test and
break a working client path for no defect. Removing the *lower* bound leaves a real crash.

⚠️ **For the plan maintainer:** §5's D4 row should be corrected to "reject below 1; keep the
silent clamp above 36".

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
| `PATCH /api/loan` (the TSV) | `200`, **no body** | `200 {"closed_loans":[…]}` | **D8** |
| `POST /api/loan` with `timelimit: 0` | **201** (then a 500 at approval) | **400** `{"message":"Timelimit must be between 1 and 36"}` | **D4** |
| `POST /api/loan` with `timelimit: 37` | **201**, silently booked as `36` at rate `0.025` | **400** `{"message":"Timelimit must be between 1 and 36"}`, no row written | **D4** |
| `POST /api/loan/<id>/refinance` with `timelimit: 0` or `> 36` | **201** / clamped | **400**, same message | **D4** |
| `GET /api/loan/<id>` as a MEMBER who does not own it | 200 | **403** `{"detail":"You do not have permission to perform this action."}` | **D10** |
| `POST /api/loan/<id>/paymentProjection` as a MEMBER who does not own it | 200 | **403**, same body | **D10** |
| `GET /api/user/<id>` as a MEMBER, another member's id | 200 with their `finance` | **403**, same body | **D25** |
| `GET /api/user/<n>` as a MEMBER, an id that does **not exist** | 404 | **403** | **P4-D1** |
| `POST /api/user/power` `{"type":"post", requestee: <self>}` | 200, row written, self-addressed push | **406** `{"message":"Requester and requestee must be different users"}`, no row, no push | **D26** |
| `POST /api/user/power` `{"type":"patch", state:1}` on an already-approved power | 200 **and the fund-wide letter again** | **409** `{"message":"Invalid state transition"}`, no mail | **D27** |
| `PATCH /api/loan/<id>` `{"state":2}` or a legal `{"state":3}` | `200` body `""` | `200` body `""` | **P4-D3** — v2 was zero bytes before this phase; now identical. Worth one confirming cell. |

### 4.2 Explicitly **unchanged** — if these differ, that IS a failure

* `timelimit: 37` → **201** with `timelimit == 36` and rate `0.025`. The clamp is silent.
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
**application** half shipped here (upsert + deterministic reads), and nothing in v2 can create
a second row. Checked on `fondodev`: **0 loans currently have more than one `LoanDetail`**, so
the constraint will apply cleanly when Phase 9 adds it.

### 5.2 §5's D4 row contradicts §3's Phase 4 scope

See §2.1. §5 says "no silent clamp"; §3 and the phase brief say to keep it, and
`test_post_loan_5` requires it. Implemented per §3; §5's row should be corrected.

### 5.3 D8 was not in the brief's "deviations that land in this phase" list

The brief names D4, D6, D9, D10, D25, D26, D27. **D8** is marked "P4 / ✅ Decided — change" in
§5 and would otherwise have blocked the gate as an undecided-but-unimplemented row, so it is
implemented. ⚠️ It is a **response-shape change** and the brief's omission means the operator
may not be expecting it — flagged rather than assumed.

### 5.4 The test-porting table's Phase 4 row

`test_loan_views.py` is **33** methods; all 33 are ported to `test/loan.e2e-spec.ts` (91 cells
in total), with the one moved expectation documented at §2.4.
