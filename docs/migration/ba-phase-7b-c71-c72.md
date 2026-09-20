# BA note — Phase 7b conditions **C71** and **C72**

**Scope:** business decision only. No code, no plan edit. All figures below were measured
read-only against `fondodev` on **2026-09-07** (Bogota 14:30; `now()` UTC `2026-09-07 19:30`).
Nothing was written, no scheduler was run, no migration was run.

> **Verdict: Concerns.** Two blocking questions for you (**B1**, **B2**), one correction to how
> C71 and C72 are framed (they are the *same row*, and C72's fix makes C71 fire), one correction
> to the size of the C71 blast radius (**three** pushes, not one), and three findings neither
> condition covers.

---

## 0. The correction that changes both answers

**C71 and C72 are not two problems. They are one row.**

C72's fix — `AND repeat = 0` in step 3a, already in the runbook at `cfa57ea` — is what *causes*
C71 to fire at cutover. Verified:

```
processed = false AND run_date < now() - interval '2 days'          → 108 rows
                                              AND repeat = 0        → 107 rows
spared by the repeat clause                                         →   1 row  = task 1497
```

Task 1497 is the birthday task for **user 3, Fernando Herrera**, `run_date 2024-03-02`,
`repeat = 4`. Before `cfa57ea` it was drained (chain dead, silently). After `cfa57ea` it survives
the drain and is **due on v2's first pass** — which is precisely the out-of-season fund-wide push
C71 is about. So the runbook as it stands today has *chosen* C71's option (a) by accident.

**Second correction — it is three pushes, not one.** `create_repeat_instance` adds
**one year to the task's own `run_date`**, not "the next future anniversary" (v1
`fondo_api/scheduler/tasks.py:39-40`; v2 `nextRepeatRunDate`, `scheduler.runner.ts`
`createRepeatInstance`). So under `<=`:

| pass | fires | clone written | clone still past-due? |
|---|---|---|---|
| 1 (10:00 day 1) | `run_date 2024-03-02` | 2025-03-02 | yes |
| 2 (14:00 day 1) | 2025-03-02 | 2026-03-02 | yes |
| 3 (10:00 day 2) | 2026-03-02 | 2027-03-02 | **no — stops** |

**"Hoy está cumpliendo años Fernando Herrera" is pushed three times across two days** — the
payload names 14 recipients, of whom **12 hold push subscriptions (92 device rows)**, so ~276
device notifications, in September, for a March birthday, for a member who left the fund. The general rule is
`1 + (this_year − run_date_year)` pushes. The Phase 7b parity run never saw this because it
drained first and only ever ran one pass.

---

## 1. C71 — how often does this actually happen?

### 1.1 The trigger is wider than "a birthdate is set or corrected"

v1 `fondo_api/services/user.py:233-235`:

```python
if 'birthdate' in obj:
    user.birthdate = obj['birthdate']
    self.__create_birthdate_notification(user)
```

**There is no change detection.** Any personal-profile PATCH whose body *contains* a `birthdate`
key rebuilds the chain — a name fix, an email correction, a role change. And
`UserProfileSerializer` ships `birthdate` in its `fields` (`fondo_api/serializers.py:15`), so the
edit form is populated with it and a normal client resubmits it every time. v2 reproduces this
exactly (`src/users/user.service.ts:710` — `if (hasBirthdate)`), so the exposure is identical.

`__create_birthdate_notification` then does `remove_sch_notitfications("birthdate", user.id)` —
which deletes that member's **entire** birthday history, processed rows included — and writes one
new task at **this year's** anniversary. If that date has passed, the row is born dead in v1 and
born wrong-day in v2.

### 1.2 The measured base rate

86 birthday tasks exist. Stripping clones (a task is a clone if the same owner has one exactly
one year earlier) leaves **14 chain starts in six years** — i.e.
`__create_birthdate_notification` has had a surviving effect ~14 times, ~2.3/year:

| chain start | owner | run_date | created past-dated? |
|---|---|---|---|
| 65–73, 132 | 1, 9, 12, 6, 7, 8, 5, 10, 11, 4 | 2020 | no (the launch backfill, done early in 2020) |
| 77 | 2 | 2021-03-02 | no |
| 1064 | 15 | 2023-11-14 | no |
| **1497** | **3** | **2024-03-02** | **YES — never fired, still `processed = false`** |
| 2528 | 13 | 2026-10-07 | no (created 2026, one month before the date — the newest row in the table, `max(id) = 2528`) |

**Answer to your question 1: one occurrence in six years, and it is a one-off in the record —
but the record understates the forward risk, and I would not plan on 1-in-6-years.**

Reasons the historical rate is optimistic:
- Ten of the fourteen starts are a single 2020 backfill session done before mid-May, so they were
  future-dated by luck of the calendar, not by design.
- Task **2528** (user 13, Juan Sebastián) was created within the last few weeks with `run_date
  2026-10-07`. Today is 2026-09-07. It missed being past-dated **by one month**.
- For an *arbitrary* profile edit on an arbitrary day, the chance the member's birthday has
  already passed this year is ≈ the fraction of the year elapsed — call it a coin flip.

Circumstantial on 1497: user 3's birthdate (`1974-03-02`) is **identical to user 2's**, and task
1497 was inserted immediately after task 1496 (user 2's 2025 clone, written by the pass on
2024-03-02). That reads like someone editing user 3's profile the same afternoon user 2 was
greeted. Suggestive, not provable — there is no audit table.

### 1.3 What v2 should do — my recommendation

Three options, in the order I would rank them.

**(A) Fix it at the source — recommended.** In `createBirthdateNotification`, if this year's
anniversary is **strictly before today in Bogota**, schedule **next year's** instead. One
comparison. Effects:

- No wrong-day push, ever, from an edit. The member is greeted on their actual birthday, next
  year.
- The chain is created alive, not born dead — so it *fixes* a v1 bug the fund has been living
  with: today, editing a member's profile after their birthday silently ends their greeting
  forever (that is exactly what happened to Fernando).
- **Cost you need to accept:** this is a genuine deviation from v1 in a *row v2 writes*, in the
  Phase 3 user service. It needs its own P-D row and it makes v2's PATCH output differ from the
  frozen v1 fixture, so the Phase 3 parity assertion on that row has to be re-pinned. Route to
  `nestjs-developer` for the change and `nestjs-reviewer` for whether the re-pin is cheap.
- Keep `== today` on today (do **not** roll it forward). If the edit lands after 14:00 the
  greeting arrives at 10:00 tomorrow, one day late — and the clone lands on the correct
  anniversary, so it self-corrects. One day late beats never.

**(B) Fire it silently — do not recommend.** Marking processed and publishing nothing keeps the
chain but leaves the member ungreeted this year *and* is invisible; it is the v1 bug with extra
steps.

**(C) Push it anyway — do not recommend, and note this is the current default.** Three fund-wide
pushes asserting a birthday that is not today. The message is `"Hoy está cumpliendo años X"` —
it makes a claim about *today*, so it cannot be read as "late", only as wrong.

### 1.4 Question 3 — does a payment reminder need the same handling? **No. Keep them different.**

They are different in the data, and the difference is decisive:

| | birthday | payment reminder |
|---|---|---|
| `repeat` | 4 (YEARLY) — measured: all 86 | 0 — measured: all 540 |
| audience | the whole roster | `user_ids = [loan.user.id]` — the borrower alone (`services/loan.py:310`) |
| message | `"Hoy está cumpliendo años X"` — asserts **today** | `"Recuerde que la fecha límite de pago para el crédito 279, es el: 7 sept. 2026"` — **carries its own date** |
| late delivery | states something false | states something true, late |
| cascade under `<=` | 1 + (years past) pushes | exactly one, always |

A late reminder is self-dating: the member reads the deadline in the text and can tell it is
stale. **D7 stays exactly as specified for `repeat = 0` reminders — that is the bug D7 exists to
fix** (v1 drops the T−5d reminder whenever the monthly file lands inside five days of the
deadline). The birthday carve-out is at *creation time*, not in the runner, so **D7's selection
rule is not changed at all** — which is the cheapest possible answer and keeps P7-D3's reasoning
intact.

**Residual you should accept explicitly:** (A) does not cover a runner *outage* spanning a
member's birthday. If v2 is down for N days over 7 November, Miguel Ángel's greeting arrives N
days late saying "Hoy". For a deploy-length outage that is right; for a week it is not. My
recommendation is to accept it (it is strictly better than v1, which drops the greeting
entirely) rather than add type-aware logic to the runner.

---

## 2. C72 — the drain, task 1497, and soft-deletion

### 2.1 What soft-deletion actually is here — measured

Two members are `is_active = false`: **user 3 (Fernando Herrera)** and **user 15 (Angi Paola
Sanchez Quilindo)**. Both have `key_activation IS NULL`, so both are *activated members who were
later deactivated* — not stalled invitations. (`is_active = false` also means "invited, never
activated" — `services/user.py:36` — so the flag alone is ambiguous; `key_activation` disambiguates.)

**When they left, bounded from the activity rosters** (`create_activity` snapshots
`is_active = True`, `services/activity.py:69`):

| activity | date | user 3 present | user 15 present |
|---|---|---|---|
| Rifa cine Colombia con combo | 2024-08-03 | ✅ | ✅ |
| Rifa Edredón | 2025-05-25 | ❌ | ❌ |

**Both left between 2024-08-03 and 2025-05-25**, together, and neither has appeared in any
activity year since. Independently corroborated by the frozen `user_ids` in task **2528** (the
newest row in the table, written weeks ago), which excludes both.

**Soft-deletion is effectively irreversible through the API.** `inactive_user` sets
`is_active = False` and does not restore `key_activation` (`services/user.py:96`);
`activate_user` is the only writer that sets it back and it requires a **non-empty matching
`key_activation`** (`services/user.py:107-120`), which is `NULL` for both. So a departed member
cannot be brought back without a direct DB write. v2 already documents this at
`src/users/user.service.ts:551`. **I still need you to confirm the fund's intent** — the code
being one-way does not tell me whether people come back in practice.

### 2.2 Question 2 — does v1 announce a soft-deleted member's birthday? **Yes. It already has.**

There is **no `is_active` filter anywhere on the notification path**, in either version:

- Recipients are frozen into `payload.user_ids` at chain creation and copied verbatim by every
  clone — `get_users_attr("id")` filters `is_active=True` **once**, at creation
  (`services/user.py:149`), never again.
- Delivery is `NotificationSubscriptions.objects.filter(user_id__in=user_ids)` — no active check
  (`services/notification.py:32`). v2 is identical
  (`notification-subscription.repository.ts:findPushSubscriptionsByUserIds`).
- Nothing in `inactive_user` deletes the member's scheduler tasks.

Dated evidence:

- Task **1770**, "Hoy está cumpliendo años Angi Paola Sanchez Quilindo", `run_date 2025-11-14`,
  **`processed = true`**. She was already inactive by 2025-05-25. **v1 announced a departed
  member's birthday to the whole fund on 14 November 2025.**
- Task **2142**, same chain, `run_date 2026-11-14`, `processed = false`, `repeat = 4`. **It is
  68 days away and it is not touched by any drain predicate** — it is in the future. Under both
  v1 and v2 it will fire.

So the fund's *de facto* rule today is: **departed members are still announced.** That was almost
certainly never decided; it is what the code does.

### 2.3 Question 1 — what to do with task 1497

Facts specific to 1497, all verified:

- It is the **only** birthday task that has ever existed for user 3. He has **never been
  greeted** — not once. C72's phrasing "that member is never greeted again" is slightly off: the
  chain never delivered anything. Draining it ends a chain that has never worked.
- Its `user_ids` is `[1, 9, 12, 6, 5, 10, 11, 2, 13, 7, 14, 4, 8, 15]` — 14 members, everyone but
  himself, and it **includes user 15**, which is how I know he was still active in March 2024.
- He still holds **2 push subscription rows**, and he still appears as a *recipient* in **10 of
  the 14 pending birthday chains**. He will keep receiving the fund's birthday pushes until those
  chains are rebuilt.

**This decision is not really about 1497. It is about whether departed members participate in the
birthday feature at all**, because whatever you decide for 1497 has to match what happens to
Angi Paola on 14 November. Two coherent policies:

**Policy 1 — departed members are not announced.** Then: **delete** 1497 *and* 2142 at cutover
(delete, not mark processed — marking 2142 processed would clone it to 2027 and you would be back
here next year). Also decide whether `inactive_user` should start deleting the member's birthday
tasks going forward; that is a small Phase 3 change and a v1 deviation.

**Policy 2 — departed members keep being announced** (today's de facto behaviour). Then: **do not
drain 1497 and do not push it** — advance it to its next future anniversary, **2027-03-02**, at
Bogota local midnight. One row, one `UPDATE`, no wrong-day push, chain repaired, and Fernando
finally gets greeted. This is the reviewer's option (a) and it composes exactly with C71's
option (A) — same rule, applied once to the one legacy row.

**I recommend Policy 2 + the 2027-03-02 roll-forward**, on the grounds that it is what the fund
already does for Angi Paola and it changes nothing member-visible except removing a wrong-day
push. But this is fund policy and it is yours — **blocking question B1**.

Whichever you pick, the roll-forward step also has to name **Ainhoa** (see §4.1) so all three
loose birthday rows are handled in one place.

### 2.4 Suggested step 3b — wording for you to fold in

Placed between the current 3a and the current 3b (renumber the `SCHEDULER_ENABLED` step to 3c).
Under **Policy 2**:

```
3b. ⚠️ Repair the one past-due repeating chain that step 3a deliberately spared — conditions
    C71/C72. Step 3a's `AND repeat = 0` leaves task 1497 (birthdate, owner 3 Fernando Herrera,
    run_date 2024-03-02, repeat 4) unprocessed and past due. Left as-is, v2's first passes push
    "Hoy está cumpliendo años Fernando Herrera" to 14 members THREE times across two days
    (create_repeat_instance adds one year to the task's own run_date, so the clone is still past
    due until it reaches 2027). Do NOT drain it — that ends the chain. Advance it instead:

    UPDATE fondo_api_schedulertask
    SET run_date = (date_trunc('day', run_date AT TIME ZONE 'America/Bogota')
                    + interval '3 years') AT TIME ZONE 'America/Bogota'
    WHERE id = 1497 AND processed = false;      -- 2024-03-02 -> 2027-03-02, Bogota midnight

    Verify (must return zero rows):
    SELECT id, run_date FROM fondo_api_schedulertask
    WHERE processed = false AND repeat <> 0 AND run_date <= now();
```

Under **Policy 1**, substitute `DELETE FROM fondo_api_schedulertask WHERE id IN (1497, 2142);`
and say in the step that this is the deliberate end of both departed members' chains.

Exact SQL and the timezone cast are `nestjs-developer`'s to confirm; the *intent* is what I am
specifying.

---

## 3. F4 — wording for Q34

F4's quoted phrase (*"marks **every** past-due unprocessed task"*) **is no longer in the plan** —
Q34 at `MIGRATION_PLAN.md:1662` already reads "marks **108 of the 110**" and already carries
"the predicate is `run_date < now() - interval '2 days'`, **not** `run_date < now()`". F4 is
substantially discharged.

**One real gap remains: Q34's answer never mentions `AND repeat = 0`.** An operator who reads
Q34 and types the predicate from it writes a two-clause `UPDATE` and drains task 1497 — the exact
harm C72 was raised for. Proposed replacement for the answer cell:

> ✅ **Answered 2026-09-07 — drain them at cutover, with two guards.** A single `UPDATE` in the
> Phase 9 runbook (**step 3a**) marks **107 of the 110** `processed = true`. The predicate is
> `processed = false AND run_date < now() - interval '2 days' AND repeat = 0`, and **both extra
> clauses are load-bearing — copy it from step 3a, do not retype it.**
> **(i) `- interval '2 days'`, not `run_date < now()`:** it spares today's birthday task (id
> 2021, Nitza Marisol) and yesterday's reminder (id 2441), which are legitimate first-pass
> deliveries; `run_date < now()` would drain them and the member whose birthday it is would
> simply never be greeted.
> **(ii) `AND repeat = 0`:** a drain writes **no clone**, so draining a *repeating* task does not
> skip one delivery — it **ends that member's yearly chain permanently and silently**. Exactly
> one past-due row is repeating (id 1497), and it is handled by **step 3b**, not here.
> **D7 is unchanged**: a task that becomes past due *after* cutover is still sent rather than
> skipped — the drain is a one-off for six years of rows v1 was never going to deliver. The 43
> live-loan reminders are drained too, deliberately: their due dates are equally gone, so sending
> them would confuse rather than remind.
> **Follow-on (C71):** birthday tasks can be *created* past-dated by any profile edit, which the
> drain cannot fix. See `docs/ba-phase-7b-c71-c72.md` and the Phase 3 change it recommends.

Re-verified today, so the numbers are safe to state: 110 due, 108 hit by the two-day predicate,
**107** with `AND repeat = 0`, 1 spared (1497), 2 spared by the grace (2021, 2441).
⚠️ **These are point-in-time counts.** They will drift before cutover — every monthly upload adds
reminders. The runbook should tell the operator to re-run the counting query and record the
result, not to expect 107.

---

## 4. Things neither C71 nor C72 covers

### 4.1 A member with a birthdate and no chain at all — Ainhoa (user 14)

`fondo_api_userprofile.birthdate = 2020-08-05`, and **zero** birthday tasks have ever existed for
owner 14, in the whole 626-row table. She has been a member since 2022-02-16 and **has never been
greeted, and never will be**, in v1 or v2. No cutover step touches this.

⚠️ **And the obvious fix is a trap under D7.** Today is 2026-09-07; her birthday (5 August) has
passed. Re-saving her profile to create the chain writes a task dated **2026-08-05** — one month
past — and v2 then pushes *"Hoy está cumpliendo años Ainhoa Montañez Sanchez"* to the roster
**twice**. Under C71 recommendation (A) the same edit would correctly write 2027-08-05 and be
silent. **If you want Ainhoa's chain started, do it after (A) lands, or add her to step 3b as an
explicit `INSERT` — do not fix it by clicking Save.** Needs your decision — **blocking question
B2**.

### 4.2 Every birthday recipient list is frozen in 2020–2021 and is now wrong

`user_ids` is snapshotted at chain creation and copied verbatim by every clone. Measured across
the 14 pending chains:

- **12 of 14** still list **departed user 3** as a recipient; **11 of 14 omit Ainhoa (user 14)**,
  who joined in 2022 — after almost every chain was created.
- Restricting to the **12 chains owned by active members**, i.e. the greetings that actually
  matter: Ainhoa is a recipient of **1**; Fernando, who left the fund over a year ago, is a
  recipient of **11**. Ainhoa holds a push subscription, so this is real silence, not a missing
  device.

Not a v2 regression — v2 reproduces it faithfully — but it is a member-visible defect that has
been quietly worsening since 2022, and it is invisible to every parity check because both sides
agree. Fixing it means resolving `user_ids` at *delivery* time instead of creation time, which is
a real deviation from v1 and a design question. **Not urgent, not in scope for Phase 9. Flagging
it so it is written down somewhere.** Route to `nestjs-reviewer` if you want it costed.

### 4.3 65 of the drained reminders belong to already-PAID_OUT loans, which should not be possible

Verified: of the 108 past-due unprocessed reminders, **43** are for loans in state `1`
(`APPROVED`) and **65** for loans in state `3` (`PAID_OUT`). But `update_loan(id, 3)` calls
`remove_sch_notitfications("payment_reminder", id)` (`services/loan.py:107`), and
`bulk_update_loans` auto-closes via that same `update_loan(loan_id, 3)` (`services/loan.py:207`).
So a paid-out loan should have **no** pending reminders. It has 65.

I did not chase this to root cause — it does not affect C71 or C72, and the drain removes all 65
either way. But it means **either the auto-close path is not clearing reminders as designed, or
some loans reached PAID_OUT by a route that bypasses `update_loan`.** If the first, v2 inherits
it and members will keep getting reminders for loans they have already paid off. Worth one hour
from `nestjs-developer` before Phase 9, because the drain will hide the evidence.

### 4.4 Alexa — not implicated

The `RequestLoan` intent creates a `WAITING_APPROVAL` loan
(`services/alexa/intents/request_loan_intent.py`). Payment reminders are **not** created there,
and not at approval either — `__create_scheduled_task` has exactly one caller,
`__update_loan_detail` (`services/loan.py:296`), which runs only from the treasurer's **monthly
bulk payment upload**. (Worth stating plainly because it is the reason D7 exists: the T−5d
reminder is written *by* the upload, so whenever the file lands within five days of the deadline
v1's exact-day match drops it.) **Removing Alexa changes nothing about the scheduler, the
reminders, or the birthday chains.** Neither C71 nor C72 depends on it, and no confirmation is
needed from you on this file.

---

## 5. Business-visible changes I am calling out explicitly

| change | who sees it | status |
|---|---|---|
| Recommendation (A): a birthdate edit after the member's birthday schedules **next year**, not a dead/wrong-day row | every member — no more out-of-season fund-wide push; the edited member is greeted next year instead of never | needs your OK — new P-D row, Phase 3 |
| Step 3b: task 1497 advanced to 2027-03-02 (or deleted) | Fernando Herrera + 14 recipients | **B1** |
| Q34 wording gains `AND repeat = 0` | operator only | safe to fold in as written |
| **No** change to D7's `<=` selection rule, and none to payment reminders | nobody | confirmed correct as specified |

## Blocking questions

- **B1 — Policy 1 or Policy 2 (§2.3)?** Do departed (soft-deleted) members keep being announced?
  Whatever you answer applies to task 1497 *and* to Angi Paola's task 2142 on **14 November 2026**,
  68 days away. If Policy 1, step 3b becomes a `DELETE` of both and I need a second answer on
  whether `inactive_user` should delete birthday tasks going forward.
- **B2 — Ainhoa (§4.1).** Start her chain, or leave her out? If start it, it must go in step 3b as
  an explicit insert dated **2027-08-05**; it must not be done by editing her profile.

## Uncertain — I am not inventing policy

- Whether soft-deletion is meant to be permanent. The *code* is one-way (§2.1) and both departures
  are >1 year old with no return, but that is evidence, not a rule. Only you can state it.
- Whether the fund considers a one-day-late birthday greeting acceptable (§1.3, the `== today`
  case). I recommend yes; say if not.
- Root cause of §4.3. Measured, not diagnosed.
