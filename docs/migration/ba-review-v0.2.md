# Business-alignment review — MIGRATION_PLAN.md rev v0.2

**Reviewer:** business-analyst · **Date:** 2026-08-30
**Scope:** §8 open questions, phase ordering, implicit business rules, Alexa fallout.
**Sources:** `~/Projects/Fondo-API/fondo_api/` (source of truth), `~/Projects/Fondo-API/CONTEXT.md`,
`~/Projects/Fondo-API-v2/MIGRATION_PLAN.md`.

## Verdict summary

| # | §8 question | Verdict |
|---|---|---|
| 1 | Async notification hop | **Confirmed — premise is wrong; there is no retry layer to lose.** Conditions attached. |
| 2 | Loan auto-close | **Needs user input.** Undocumented, untested, silent, and not cleanly recoverable. |
| 3 | Saving accounts / CAPs | **Needs user input.** The source does not answer three of the four questions. |
| 4 | Loan rate table | **Confirmed in force.** The silent clamp needs user input; a missing lower bound is a bug. |
| 5 | Powers of attorney | **Partly intended, partly bug.** The recipient *list* is arguable; `To:` instead of `Bcc:` and the missing authorization check are not. |

Overall on the plan: **Concerns.** The plan is sound on mechanics. The gap is that its
parity contract ("v1 behavior is the spec") will silently port at least two authorization
holes and one data-corrupting state transition into a fresh codebase, and it has no phase
where "port faithfully vs. fix" is decided. See §"Blocking" at the end.

---

## §8.1 — Async notification hop (Phase 2) — **Confirmed**

**The retry layer does not exist in v1.** `fondo_api/celery/tasks.py:send_notification`
wraps the SQS call in `try/except Exception` and only logs:

```python
    except Exception as ex:
        logger.error("Error trying to connect to MNS service: {}".format(ex))
```

The task declares no `autoretry_for`, no `retry_backoff`, and because the exception never
escapes the task body, Celery has nothing to retry. A failed publish is already lost today.
Additionally, the scheduler path already bypasses Celery entirely —
`fondo_api/scheduler/executers/` calls `send_notification(..., run_async=False)`, which
invokes the task inline. So **payment reminders and birthday notifications have no Celery
hop today either.** Collapsing the indirection changes nothing for those.

**What is actually lost:** latency decoupling on three write paths that currently publish
via `.delay()` — `services/loan.py:create_loan`, `services/saving_account.py:create_account`,
`services/user.py:handle_power_request` (the `post` branch). In v2 those become an inline
SQS call on the request thread.

**Member-visible consequence of a dropped notification, by channel:**

- *Loan created* (push to roles `[0,2]`): recoverable. The loan is still visible at
  `GET /api/loan?state=0`. Low impact.
- *Loan approved / denied*: **no impact.** These are email, not push
  (`services/loan.py:update_loan`), and SES failure already returns `False` without
  affecting the state change.
- *Payment reminder* (T−5d / T−1d): **unrecoverable and silent.** Push is the only channel.
  Worse, `scheduler/tasks.py:scheduler` sets `task.processed = True` after `executer.run()`
  returns, and `send_notification` swallows errors, so the task returns normally and is
  marked processed even when the publish failed. The member is never told, and nothing
  retries. Note the pre-existing gap too: `NotificationService.send_notification` returns
  early when the member has zero rows in `notificationsubscriptions` — a member who never
  granted browser push **already receives no payment reminder at all**.

**Conditions on accepting this (route to nestjs-developer):**

1. Add a bounded retry with backoff around `SendMessage` in v2 (3 attempts). No new infra;
   it strictly improves on v1.
2. Keep v1's swallow semantics at the boundary: a publish failure must **never** fail the
   HTTP write or roll back a loan/CAP/power row.
3. **Do not put the SQS publish inside a Prisma interactive transaction.** In v1 all three
   `.delay()` sites are outside `transaction.atomic()`. If v2 puts the publish inside the
   transaction, an SQS outage starts rolling back loan creations. This is a business-visible
   regression risk that the inline change makes easy to introduce.
4. The scheduler must not mark a task `processed` when the publish failed — or must accept
   that it does, deliberately. Ask the treasurer (question Q6 below).

---

## §8.2 — Loan auto-close (Phase 4) — **Needs user input**

The behavior is real and unambiguous in `services/loan.py:bulk_update_loans`:

```python
        loans = self.get_loans(None, None, True, 1, False)['list']
        for loan in loans:
            loan_id = loan['id']
            if loan_id not in loan_ids:
                self.__logger.info('Auto closing loan with id {}'.format(loan_id))
                self.update_loan(loan_id, 3)
```

Whether it is *intended* cannot be determined from the source, and four facts argue for
treating it as high-risk rather than settled:

- **It is untested.** `tests/test_loan_views.py:test_bulk_update_loans` creates loans 1–4
  and uploads a file for ids 1, 2, 3 and 5. Loan 4 is absent and is therefore auto-closed —
  and the test **never asserts loan 4's state**. Nothing in v1 documents the intent.
- **It is silent.** `update_loan(id, 3)` sends no email and fires no notification; it only
  calls `remove_sch_notitfications("payment_reminder", id)`. The member's loan disappears
  from the active list and their pending reminders are deleted, with no message.
- **The blast radius is the whole fund, not one member.** The candidate set is
  `get_loans(None, None, True, 1, False)` — *every* APPROVED loan in the system.
- **Recovery is broken.** Setting the state back to `1` re-runs the approval path, which
  calls `__create_loan_detail` unconditionally. `LoanDetail.loan` is a plain
  `ForeignKey`, not `OneToOne` (`models.py`), so a second `LoanDetail` row is created;
  from then on `LoanDetail.objects.get(loan_id=id)` raises `MultipleObjectsReturned` and
  `GET /api/loan/<id>` and `payment_projection` return 500 for that loan **permanently**.
  A mistaken auto-close therefore cannot be undone through the API without manual SQL.

**Partial vs. malformed file — different outcomes, both bad:**

- *Malformed* (a line where `int(data[0])` or `float(data[1])` throws): the exception
  escapes `@transaction.atomic`, the whole PATCH rolls back, and the view returns 500. No
  damage — but also no useful error for the treasurer, and the loans already parsed are
  lost. This is the safe failure.
- *Well-formed but incomplete* (treasurer exports only part of the ledger, or filters a
  sheet before saving): every omitted loan is closed and the transaction **commits**. This
  is the dangerous case and there is no guard against it.
- *Timing case, most likely to bite in practice:* a loan approved **after** the treasurer
  generated the month's file is, by construction, absent from it, and is closed the moment
  the file is uploaded.

**Recommendation regardless of the answer:** the upload should report what it is about to
close before it does it. Minimum viable guard for v2 — return the list of auto-closed ids
in the PATCH response (v1 returns a bare 200 with no body), and refuse the upload if it
would close more than N loans or if the file is empty. Both are behavior changes and need
the user's sign-off.

---

## §8.3 — Saving accounts / CAPs (Phase 6) — **Needs user input**

**Stating plainly: three of the four questions have no answer in the source.** There are no
tests, no comments, no email or notification copy that implies semantics, and the local dev
DB has no CAP data to infer from (see the Phase 0 finding below — the `savingaccount` table
does not even exist there). What follows is what the code *does*, not what it means.

**What is determinable:**

- **A CAP is created empty and ACTIVE.** `services/saving_account.py:create_account` passes
  only `end_date` and `user` to `SavingAccount.objects.create(...)`. `state` and `value` fall
  to the model defaults `0 (ACTIVE)` and `0` (`models.py:SavingAccount`). A member sets only
  the end date; they cannot set an opening amount.
- **There is no automatic close.** `create_account` carries the literal comment
  `# TODO: schedule task for closing CAP`. Nothing reads `end_date` at runtime — it is
  display-only (`serializers.py:SavingAccountSerializer.get_end_date`). ACTIVE→CLOSED
  happens **only** through `PUT /api/saving-account`. `end_date` is not validated and may be
  in the past.
- **`value` on `PUT` is a replacement, not a deposit and not an accrual.**
  `update_account` does `account.value = obj['value']` outright. Nothing anywhere in the
  codebase adds to, accrues interest on, or derives a CAP value. Whoever calls the endpoint
  is asserting the current balance.
- **Who may close someone else's account:** the rule is `'SavingAccountView': {'PUT': [0,2]}`
  (`permissions.py`), i.e. **ADMIN or TREASURER only — PRESIDENT (role 1) is excluded**, and
  `update_account` performs **no ownership check at all**, so an admin or treasurer may set
  the state and value of any member's CAP. A member cannot touch their own. Note this is the
  only privileged write in the system that excludes the president; every other one either
  uses `role <= N` (which includes 1) or is `[0,2]` for treasurer-specific ledger work.
  Whether excluding the president was deliberate is not determinable.
- **`update_account` does not validate `state`.** `{"id":1,"state":7,"value":0}` is written
  as-is. The list endpoint only accepts `state` 0 or 1, so such a row becomes invisible.
- **`total_savingaccounts` has no relationship to quota.**
  `serializers.py:UserFinanceSerializer.get_total_savingaccounts` sums `value` over
  `SavingAccount.filter(user_id=..., state=0)` and returns it as a display field. Grepping
  `total_quota|utilized_quota|available_quota` across the app shows the *only* writers are
  `services/user.py:__update_user_finance` and `services/user.py:create_user`. **CAP balances
  do not increase a member's borrowing quota, and are not counted as contributions.** They
  are informational.
- Listing has no "all states" option — `get_accounts` always filters on exactly one state
  (default `0`), unlike loans' `state=4`. Closed CAPs need `?state=1`.
- CAP creation notifies roles `[0,2]` ("Ha sido creada una nueva CAP", target `/manage/caps`).
  Closing or revaluing a CAP notifies **no one**, including the owner.
- `SavingAccount.user` is `on_delete=CASCADE`; a hard user delete destroys CAP history. (v1's
  `DELETE /api/user/<id>` is a soft delete, so this is only reachable via SQL.)

**Not determinable from the source — must come from the fund:** what a CAP economically *is*
(fixed-term deposit? goal-based savings pot?), whether the value should accrue, what should
happen on `end_date`, whether the member should be able to see/close their own, and whether
CAP balances should count toward quota or contributions.

**Recommendation:** do not build Phase 6 as "faithful parity" until these are answered. As
written, faithful parity means shipping a module where a member creates an empty record and
an admin later types a number into it. That is portable, but it should be a conscious choice.

---

## §8.4 — Loan rate table (Phase 4) — **Confirmed in force**

`a45c343` (2026-02-02, ~7 months in production) replaced the old inline table
(`0.020 / 0.025 / 0.030`, max term 24) with `services/loan.py:__get_rate`:
`≤6 → 0.015`, `7–12 → 0.020`, `13–24 → 0.022`, `25–36 → 0.025` monthly, max term 36.
Rates went *down* across every tier and the top term was extended — that is a deliberate
policy change, not a refactor. Stable enough to port. Verified as the current state of
`master`.

**Three things to flag anyway:**

1. **The rate is snapshotted onto the loan row at creation** (`Loan.rate`, Decimal(5,3), set
   in `create_loan`). Past loans keep the rate in force on the day they were *requested* —
   including a loan sitting in `WAITING_APPROVAL` across a future rate change, which is
   approved at the old rate. Worth one line of confirmation from the user; it is the fair
   reading but it is nowhere written down.
2. **The silent clamp.** `create_loan` mutates `obj['timelimit'] = 36` *before* the rate
   lookup and before `Loan.objects.create`, so the loan is **stored** as 36 months. The
   member gets a `201` with no indication their 48-month request was shortened. The clamp is
   not new — the previous code clamped to 24 the same way, and `a45c343` deliberately
   rewrote it rather than dropping it, which is decent evidence it is intentional. But
   "intentional" and "the member should not be told" are different questions. Needs user
   input (Q9).
3. **There is no lower bound, and that is a bug.** `timelimit = 0` is accepted at creation
   and returns rate `0.015` (the `return 0.015` fallthrough covers 0 and negatives). It then
   **crashes at approval**: `__generate_table` sets `fee = loan.timelimit` for MONTHLY loans
   and computes `constant_payment = Decimal(loan.value)/fee` → `DivisionByZero`, inside the
   approval transaction. The member's loan is stuck un-approvable. v2 should enforce
   `1 <= timelimit`; that is a business-visible validation change and needs sign-off (Q9).

---

## §8.5 — Powers of attorney (Phase 3) — **Partly intended, two bugs**

`services/user.py:handle_power_request`, `patch` branch:

```python
            power = Power.objects.get(id = request['id'])
            power.state = request['state']
            power.save()
            if power.state == 1:
                ...
                self.__mail_service.send_mail(EmailTemplate.POWER_APPROVED, self.get_users_attr('email'), mail_params)
```

Three separable issues:

- **(a) Recipient scope — plausibly intended.** For an assembly, announcing who holds a proxy
  for whom is a legitimate transparency/quorum practice, and the template is a formal letter
  addressed to the assembly, not to the requester. I would not call this a bug without asking.
  It is, however, a **notification-recipient rule** and therefore business-visible under the
  plan's own §4 rules — it must be confirmed, not inferred (Q10).
- **(b) `To:` instead of `Bcc:` — almost certainly a bug.** `get_users_attr('email')` is
  passed as `recipients`, and `services/mail.py:send_mail` puts `recipients` in
  `Destination.ToAddresses` with an empty `BccAddresses`. **Every member's email address is
  disclosed to every other member on every power approval.** Compare `update_loan`, which
  correctly puts the `[0,2]` copy in `bcc`. Fixing this changes the SES payload and will
  break byte-for-byte parity in Phase 3 — decide before writing the parity test, not after.
- **(c) No authorization check — definitely a bug.** `UserAppsView` is `POST: 3`, i.e. any
  member. `Power.objects.get(id=request['id'])` uses the id from the body with no check that
  the caller is the `requestee` (or anyone at all). **Any member can approve or reject any
  power request**, including one granting someone a proxy over a third member, and trigger
  the fund-wide letter. For an assembly-voting mechanism this is a governance defect, not a
  cosmetic one.

---

## Phase-order assessment

The dependency ordering is correct: P0/P1 before everything, P2 before P3/P4 because both
emit, P4 after P3 because loans read `UserFinance`, P7 after the phases that *write*
`SchedulerTask` rows (P3 birthdays, P4 payment reminders). No dependency errors found.

**Two resequencing recommendations:**

1. **Move P7 (scheduler) to immediately after P4, ahead of P5/P6/P8.** The plan's own status
   board already allows this ("P7 blocked on P4"), but the linear listing runs it last-but-two.
   Reasons, all business rather than technical: the scheduler is the **only** delivery path
   for payment reminders and birthday notifications; it is the weakest-covered subsystem in
   the migration (0 inherited tests) *and* raw-SQL hstore territory; and its failure mode is
   **completely silent** — no member files a ticket about a reminder they never knew was
   coming. Shipping it early buys weeks of soak time on the shared dev DB before cutover.
   P5/P6/P8 are all lower-consequence and can absorb the delay.

2. **Add an explicit "authorization gaps" decision item to P1, before the role matrix is
   written.** The plan's Phase 1 parity criterion is "14 view classes × each method × 4 roles
   → identical allow/deny." That criterion is entirely route-level, because `list_permissions`
   is entirely route-level — v1 has **no object-level ownership checks anywhere** (see the
   implicit-rules section). Writing that matrix as the spec bakes the gaps in and makes them
   expensive to revisit later. The fix/port decision has to be made in P1.

**Fund operating-cycle constraints the plan does not account for:**

- **The monthly loan-payment cycle is the dominant constraint.** The treasurer's TSV upload
  (`PATCH /api/loan` + `PATCH /api/user`) is the single event that updates every loan
  balance, every member's quota, and every payment reminder for the month — and it is also
  the event that auto-closes loans. **Cut over immediately after a monthly upload has
  completed and been verified, never in the days before one**, and do not schedule the
  first v2-run upload as the smoke test.
- **Year-end rollover is a hard calendar boundary.** `services/activity.py:create_year` uses
  `date.today().year` and offers no way to create a year for any other year; there is also no
  way to re-enable a disabled year. **Do not cut over in the last or first two weeks of a
  calendar year** — if the rollover is performed on v2 in January and behaves differently,
  there is no corrective path through the API.
- **Assembly dates gate Phase 3.** Powers of attorney are only exercised around assemblies.
  If an assembly falls near the P3 window, the power flow is in live use exactly when it is
  being reimplemented. Ask the user for the assembly calendar (Q11) before scheduling P3.
- **Pending `SchedulerTask` rows cross the cutover.** Reminders written by v1 are read by v2
  from the same table. They survive only if the hstore codec is exactly right, and Runbook
  step 6 (hstore→jsonb, with the "unwrap the doubly-stringified values" repair pass) rewrites
  precisely those rows. If the repair is wrong, **every pending payment reminder and every
  birthday notification stops firing, silently, with no error anywhere.** Recommend the
  runbook add an explicit post-step-6 verification: query the converted rows, assert
  `payload->'user_ids'` is a JSON array (not a string), and force-run the scheduler once
  against a seeded task before trusting it.

---

## Newly surfaced implicit rules the plan does not name

Ordered by business consequence.

**1. `PATCH /api/user/<id>` is open to every member, for every other member, including role
and finance.** `permissions.py` → `'UserDetailView': {'PATCH': 3}`; `views/user.py:UserDetailView.patch`
takes `id` straight from the URL; `services/user.py:update_user` performs no ownership or
privilege check. Concretely, any authenticated MEMBER can:

- `{"type":"personal", ..., "role":0}` on their own id → **promote themselves to ADMIN**
  (`__update_user_personal` assigns `user.role = obj['role']` unconditionally);
- `{"type":"finance","finance":{...,"total_quota":<large>,...}}` on their own id → **grant
  themselves unlimited borrowing quota**, which is the only thing `create_loan` checks;
- rewrite another member's email (which is the login identifier) or identification.

This is the single largest business risk I found. The plan currently guarantees it will be
faithfully reproduced. Decision required in P1.

**2. `GET /api/loan/<id>` and `POST /api/loan/<id>/paymentProjection` have no ownership
check.** `services/loan.py:get_loan(id)` and `payment_projection(loan_id, to_date)` take a
bare id; the route rule is `3`. Any member can read any other member's loan value, comments,
balance and amortization by guessing an id. Note the *list* endpoint
(`views/loan.py:LoanView.get`) does scope by user unless `role <= 2` — so the intent to
scope clearly exists and the detail route simply missed it. Same class of gap on
`handle_power_request` (§8.5c) and `update_account` (§8.3).

**3. Quota is never decremented by lending — it is a monthly treasurer figure.**
`create_loan` reads `user_finance.available_quota` but nothing in the loan flow ever writes
`utilized_quota`; the only writers are `services/user.py:__update_user_finance` (the
per-user PATCH and the bulk TSV). Consequence: **between two monthly uploads a member can
create several loans that each individually pass the quota check but together exceed it.**
The plan describes the quota check but not this, and a v2 developer could reasonably
"improve" it by decrementing on create — that would be a business-visible tightening of
lending rules and must not happen without the user's decision (Q12).

**4. A loan can be approved twice, and the second approval permanently corrupts it.**
`views/loan.py:LoanDetailView.patch` accepts any `state <= 3` with no transition guard, and
`update_loan` runs the full approval path every time `state == 1`. Because `LoanDetail.loan`
is a `ForeignKey` and not `OneToOne` (`models.py`), re-approving creates a **second**
`LoanDetail`; thereafter `LoanDetail.objects.get(loan_id=...)` raises
`MultipleObjectsReturned` and `GET /api/loan/<id>` / `payment_projection` 500 forever. It
also re-sends the approval email. This is the reason §8.2's auto-close is not safely
reversible. Recommend v2 enforce a state machine (0→1, 0→2, 1→3, 1→2) — a business-visible
change, needs sign-off.

**5. Refinancing eligibility has three unnamed gaps** (`services/loan.py:refinance_loan`):
- Only `state != 1 or user_id != loan.user.id` is checked. There is **no check that a
  refinance is already pending.** A member can refinance the same loan twice; the second call
  overwrites `loan.refinanced_loan`, orphaning the first new loan — whose `prev_loan` still
  points at the original, so approving *either* closes the original and both replacements can
  end up APPROVED.
- `new_loan['disbursement_date']` is used unvalidated as the projection `to_date`. If it
  precedes `loan_detail.from_date`, `utils/date.py:days360` **swaps the dates and returns a
  positive count**, so interest is *added* for a backwards range and the member is
  overcharged on the refinanced principal.
- Refinance bypasses the quota check entirely (`refinance=True`), *including* when
  `includeInterests` capitalises interest into the new principal — so a refinance can lawfully
  exceed `available_quota`. The plan names the bypass but not the capitalisation consequence.

**6. Setting a birthdate on a not-yet-activated member throws a 500 and rolls back the whole
personal update.** `services/user.py:__create_birthdate_notification` does
`user_ids = self.get_users_attr("id"); user_ids.remove(user.id)`. `get_users_attr` filters
`is_active=True`, but a newly created member is `is_active=False` until they use the
activation link. `list.remove` then raises `ValueError`, which the enclosing
`try/except UserProfile.DoesNotExist / IntegrityError` does not catch. Admin-visible, easy to
hit during onboarding.

**7. Scheduler tasks dated in the past are never executed and never cleaned up.**
`scheduler/tasks.py:scheduler` filters on `run_date` year/month/day == *today* only. If the
treasurer uploads the monthly file within 5 days of a `payday_limit` — which is common —
`__create_scheduled_task` writes a T−5 row dated in the past. It is never picked up, never
sent, and never deleted. Member-visible: the 5-day reminder simply does not arrive, and rows
accumulate. Worth naming so v2 does not "fix" it silently (or does, deliberately).

**8. `available_quota` is only recomputed when another finance field changes.**
`__update_user_finance` guards the whole write behind a change comparison over
`contributions / balance_contributions / total_quota / utilized_quota`. If `available_quota`
is ever inconsistent in the DB, resubmitting the same figures will not repair it.

**9. Activity membership is frozen at creation.** `services/activity.py:__add_users` attaches
`UserProfile.filter(is_active=True)` at the moment the activity is created. The plan names
the rule but not the two consequences: a member who joins the fund later is **never** attached
to that year's existing activities and will never be asked to pay them; a member deactivated
later keeps their `ActivityUser` rows and stays on the collection list.

**10. `DELETE /api/activity/<id>` destroys payment history with no guard.**
`remove_activity` is a bare `filter(id).delete()` cascading to `ActivityUser`, returns 200
even when the id does not exist, and does not check whether any member is already
`PAID_OUT (1)`. Role ≤ 1. Deleting a partly-collected activity erases who paid.

**11. `create_year` is not transactional.** `services/activity.py:create_year` disables the
previous year and saves it *before* attempting to create the current one; an `IntegrityError`
on the create leaves the previous year disabled and returns `False`/304. Once-a-year path,
low frequency, but there is no API route to re-enable a year.

**12. `GET /api/activity/year` returns 204 No Content when no years exist** — an unusual
status the plan's Phase 5 scope does not mention. Front-end-visible.

**13. `bulk_update_users` silently skips unknown identifications.**
`services/user.py:bulk_update_users` logs and `continue`s on a 404 from
`__update_user_finance`, and the view returns a bare 200. A treasurer who uploads a file with
a typo'd identification gets no indication that a member's finance row was not updated.

---

## Alexa removal — nothing else breaks

Verified, and I concur with the plan's scope list:

- `services/alexa/intents/request_loan_intent.py:RequestLoanIntent.handle` calls
  `LoanService.create_loan(self.user_id, loan_or_intent)` — **the same service method as
  `POST /api/loan`**, with `comments` hardcoded to `"Loan requested by Alexa Skill"`. The
  voice intent was a duplicate *channel* onto an existing capability, not a capability of its
  own. Removing it removes a way to ask for a loan, not the ability to get one. The web app
  covers it.
- `views/auth.py:AuthView` is Alexa-only: it returns `400` unless
  `client_id == os.environ.get('ALEXA_CLIENT_ID')` and its only success path is a redirect to
  the caller's `redirect_uri` with the token in the URL fragment. Nothing in the web app can
  use it. It does `Token.objects.get_or_create`, the same token store as
  `POST /api-token-auth`, so **removing it invalidates no existing session.**
- `LaunchHandler` returns a greeting only. No other business process touches
  `services/alexa/`.

Two small residues worth stating to the user rather than discovering later:
1. Historical loans in the production DB carry `comments = "Loan requested by Alexa Skill"`.
   That text stays visible in the UI and in loan emails after the skill is gone. Cosmetic.
2. Any member who currently has the skill account-linked will get a generic failure from
   Alexa at cutover, not a message. Worth a one-line heads-up to members if anyone still uses
   it (Q13).

---

## Questions only the fund's operators can answer

Ask in one round; several block phase starts.

**Loans (blocks Phase 4)**

- **Q1.** Is "a loan absent from the monthly TSV means it is fully paid" genuinely how the
  fund closes loans, or did that behavior accumulate? If it is intended, is it acceptable
  that the member gets **no email and no notification** when their loan is closed this way?
- **Q2.** Should the bulk upload refuse to close a loan that was approved *after* the file was
  generated (e.g. skip loans created after the file's newest `from_date`)? This is the most
  likely real-world way loans get wrongly closed.
- **Q3.** Should the upload return the list of loans it closed, and/or refuse an upload that
  would close more than N loans or that contains zero valid lines? (v1 returns a bare 200.)
- **Q4.** Is a loan's rate correctly frozen at the moment of **request**, so that a loan still
  awaiting approval when rates change is approved at the old rate?
- **Q5.** May a member hold more than one refinance request against the same loan at once?
  (v1 allows it and the linkage breaks — see implicit rule 5.)
- **Q9.** When a member asks for more than 36 months, should the request be **rejected** with
  a message, or silently shortened to 36 as today? And should terms below 1 month be
  rejected? (Today `timelimit = 0` is accepted and then crashes at approval.)
- **Q12.** Should creating or approving a loan increase `utilized_quota` immediately, or must
  quota keep coming exclusively from the treasurer's monthly file? (Today a member can open
  several loans between uploads that together exceed their quota.)
- **Q14.** Should we enforce legal loan state transitions (0→1, 0→2, 1→3, 1→2) and reject
  re-approving an already-approved or closed loan? Today it is allowed and permanently breaks
  the loan record.

**Access control (blocks Phase 1)**

- **Q15.** Today **any member can edit any other member's profile and finance, including their
  own role and their own `total_quota`.** Do we port that as-is, or does v2 restrict
  `PATCH /api/user/<id>` to "self, non-privileged fields only" plus admin/treasurer for
  everything else? (Strong recommendation: restrict.)
- **Q16.** Should `GET /api/loan/<id>` and `paymentProjection` be restricted to the loan owner
  plus roles `[0,1,2]`? Today any member can read any loan by id.
- **Q17.** Should approving/rejecting a power of attorney be restricted to the **requestee**?
  Today any member can approve any request by id.

**Powers of attorney (blocks Phase 3)**

- **Q10.** Is emailing the approved power-of-attorney letter to **every member** intended
  (assembly transparency), or should it go only to the requester and requestee?
- **Q18.** Regardless of Q10 — may we move those recipients from `To:` to `Bcc:`? Today every
  member's email address is exposed to every other member on each approval.

**Saving accounts / CAPs (blocks Phase 6 — none of these are answerable from the code)**

- **Q19.** What is a CAP, economically? A fixed-term deposit that earns a return, or a
  goal-based savings pot the fund merely tracks?
- **Q20.** When should a CAP move ACTIVE→CLOSED? Automatically on `end_date` (the code has a
  `# TODO` for exactly this and never implemented it), or only when the treasurer says so?
- **Q21.** On `PUT`, is `value` the **new total balance** (that is what the code does), or was
  it meant to be a deposit added to the running balance?
- **Q22.** Should the **member** be able to see and close their own CAP? Today only ADMIN and
  TREASURER can (`PUT` rule `[0,2]`), and the member is not notified when their CAP is closed
  or revalued.
- **Q23.** Should the PRESIDENT (role 1) be able to manage CAPs? They are excluded today,
  uniquely among privileged operations — deliberate or an oversight?
- **Q24.** Should the ACTIVE CAP total count toward a member's `total_quota` or
  `contributions`? Today it is purely informational and affects nothing.

**Notifications & scheduler (blocks Phase 2 / Phase 7)**

- **Q6.** Should a payment reminder that fails to publish be retried on the next scheduler
  run, or is best-effort acceptable? (Today it is marked processed regardless and is lost.)
- **Q7.** Members without a browser push subscription **receive no payment reminders at all
  today**. Should reminders also go out by email?
- **Q8.** The 5-day reminder is skipped entirely whenever the monthly file is uploaded within
  5 days of the payment deadline (past-dated tasks are never run). Should v2 send it
  immediately instead, or keep skipping?

**Operating calendar (blocks the Phase 9 runbook)**

- **Q11.** What are the next assembly date(s), and on what day of the month does the treasurer
  normally run the loan/finance upload? Both drive when Phase 3 ships and when cutover is safe.
- **Q13.** Does anyone still use the Alexa skill? If so, they should be told before cutover
  rather than hitting a generic failure.

---

## Blocking

- **Phase 1 cannot close as "Aligned"** until Q15/Q16/Q17 are answered. The plan's role-matrix
  parity criterion is route-level only, which is a faithful reflection of v1 — but v1 has no
  object-level authorization anywhere, and locking that in is a business decision, not a
  migration detail.
- **Phase 6 should not start** until Q19–Q24 are answered. There is no spec to port.
- **Phase 4 needs Q1–Q3** before the auto-close is implemented.

## One Phase 0 finding, outside my remit but it blocks parity testing

The local dev database (`fondodev`) is at Django migration **0015**. `0016_power`,
`0017_savingaccount`, `0018`, `0019` are unapplied — `fondo_api_power` and
`fondo_api_savingaccount` **do not exist there**. It holds 2 users, 53 loans, 3 scheduler
tasks and 0 push subscriptions, so it is scratch data, not a production snapshot. Phase 3
(powers) and Phase 6 (CAPs) cannot be parity-tested against it as it stands, and the Phase 0
"every table round-trips" gate will pass against a schema that is missing two tables. Route to
nestjs-developer: run `manage.py migrate` on the shared dev DB, and seed realistic CAP, power
and push-subscription rows, before Phase 0's gate is assessed.
