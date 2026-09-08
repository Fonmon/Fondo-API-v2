# Phase 6 — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5, and to `docs/phase-0-deviations.md` …
`docs/phase-7b-deviations.md`.

Audience: `nestjs-reviewer` (§1–§5), `manual-tester` (§6 — everything it must read as an
**expected** diff), and whoever maintains `MIGRATION_PLAN.md` (§7 — corrections to fold back).

**Scope shipped**

| Area | Units |
|---|---|
| Routes | `GET|POST|PUT /api/saving-account` — `SavingAccountController`, one v1 view |
| Service | `SavingAccountService` — `create_account`, `get_accounts`, `update_account`, plus **D12**'s `closeAccount` / `findUnclosedPastDue` |
| Serializer | `serializeSavingAccount` — `SavingAccountSerializer`, six fields, **two different date types** |
| **New functionality** | **D12** — the CAP auto-close: `SchedulerTask.type = 1`, `SavingAccountCloseExecuter`, the per-CAP close task, the reconciliation query |
| Inherited conditions closed | **C68**, **C69**, **C70**, **C73**, **C75** (registered), **C76**, and C77/C78's *code* obligations |
| §5 register implemented | **D12**. **D3** is withdrawn (Q22/Q23) and nothing was built for it. |

⚠️ **This phase is two different kinds of work and the reviewer should read them
separately.** `GET|POST|PUT /api/saving-account` is a **port** and every byte of it is
parity-checkable against v1. **D12 is not**: v1 never built it —
`fondo_api/services/saving_account.py` still carries a literal
`# TODO: schedule task for closing CAP` — so it has no v1 behaviour to check against and is
specified entirely by operator answers **Q20**, **Q22**, **Q24**, **Q38**, **Q39** plus
conditions **C74**, **C77**, **C78**.

⚠️ **v1 ships no test for this module at all.** There is no `test_saving_account_views.py`,
no service test, no serializer test — the only module in the migration with zero inherited
coverage on all three. Every one of the 169 cells below is new. The operator's rules are the
specification, not v1's behaviour alone.

**Gate numbers** — asserted by **exit code**, never by reading output for silence (**C67**).

| | baseline (`f7b7a46`) | after |
|---|---|---|
| `npm run lint` | exit 0 | **exit 0** |
| `npm run typecheck` | exit 0 | **exit 0** |
| unit | 2173 / 67 suites | **2274 / 70 suites** |
| e2e | 1061 + 2 skipped / 20 suites | **1160 + 2 skipped / 21 suites** |

`+101` unit and `+99` e2e, every one measured per suite against a `git worktree` at
`f7b7a46` rather than derived by arithmetic:

| suite | baseline | after | Δ | why |
|---|---|---|---|---|
| `saving-account.serializers.spec.ts` | — | **14** | +14 | new — the six fields and the two date conversions |
| `saving-account.service.spec.ts` | — | **44** | +44 | new — create/list/update, D12's close and reconciliation |
| `saving-account-close.executer.spec.ts` | — | **13** | +13 | new — D12's executer, incl. the `ok: false` prohibition |
| `scheduler.runner.spec.ts` | 34 | **50** | +16 | **C68** (4), **C69** (4), **C76** (4), **C77 (iii)** (4) |
| `env.validation.spec.ts` | 25 | **34** | +9 | **C70** — the closed `SCHEDULER_ENABLED` grammar |
| `executer.factory.spec.ts` | 5 | **7** | +2 | D12's `type = 1` branch, plus a distinctness cell |
| `notification-publisher.spec.ts` | 9 | **12** | +3 | **C73** — the ported `Sending request to MNS...` line |
| **unit total** | **2173** | **2274** | **+101** | |
| `saving-account.e2e-spec.ts` | — | **98** | +98 | new suite |
| `health.e2e-spec.ts` | 8 | **9** | +1 | `/api/saving-account` moved from the 404 list to a guarded-route cell |
| **e2e total** | **1061** | **1160** | **+99** | |

**No cell was removed or weakened.** Two blocks changed subject:

* `env.validation.spec.ts` — the block that asserted `'maybe'`, `'enabled'` and `''` are read
  as *disabled* now asserts they are **refused at boot**. ⚠️ That is C70's whole point: the
  old spec **certified the defect**. The `false`/`0`/`no`/`off` cells are unchanged and were
  widened with case and whitespace variants.
* `health.e2e-spec.ts` — `/api/saving-account` moved from *"ships no Phase 6-8 business
  endpoints yet"* to a new *"exposes the Phase 6 saving-account route, guarded"* cell that
  asserts **401** on both slash forms and **404** beyond the pattern. The 404-vs-401 split is
  what makes that assertion mean anything; it was preserved, not collapsed.

## ⚠️ `fondodev` was never written to

Every e2e cell runs against `fondo_api_test`, and `assertDisposableDatabase` (**C25**) refuses
anything else. `fondodev` was touched with **`SELECT` only**, to re-measure Q38's ground truth.

Verified at baseline on **counts AND sequences AND `xmin` cardinality**
(`scripts/parity/fixture-check.sh`, saved to `~/.fondo-parity-dumps/phase6-after.txt`):

```
savingaccount 2 · schedulertask 626 (max id 2528) · loan 425 · loandetail 374
activityyear 9 · activity 25 · activityuser 338 · notificationsubscriptions 94 (max id 1468)
auth_user 15 · power 20 · userprofile 15
```

**Controlled** (**C67** — a check that can only say "nothing found" is not a check): the same
script run against `fondo_api_test` produces a *different* output, so the probe is not blind.
And `fondo_api_savingaccount`'s two rows were diffed line-by-line against the pre-Phase-7b
`pg_dump` at `~/.fondo-parity-dumps/p7b-20260907-062800-mt-pre/` — **byte-identical**.

⚠️ No `prisma migrate dev` was run against anything. No scheduler was started against
`fondodev`. No real SES/SQS credentials were used.

---

## 1. Q38 re-measured — do not carry the figure forward, measure it

Measured on `fondodev` **2026-09-08** (`SELECT` only):

```
 id |            created_at            |  end_date  | state | value  | user_id
----+----------------------------------+------------+-------+--------+---------
  2 | 2023-03-14 12:25:35.3381+00      | 2023-12-01 |     1 | 450000 |      14
  3 | 2023-03-14 13:47:00.182264+00    | 2024-02-28 |     0 | 900000 |      15
today (America/Bogota) = 2026-09-08
open and past due            = 1   (id 3)
open with a future end_date  = 0
```

Identical to the 2026-09-07 measurement the plan records. **The backfill is one row.**

⚠️ **One thing the plan does not say, and it is worth saying**: the single open past-due CAP
belongs to **user 15**, who is `is_active = false` — the same departed member as **D39**/Q35's
task 1770. It changes nothing here (a close notifies nobody, **Q22**), but a reviewer reading
"close the outstanding CAP" should know the money is a departed member's, and that closing it
is a bookkeeping act rather than a member-facing one.

---

## 2. ⚠️ The decision this phase had to make: a task per CAP, **not** the reconciliation query

**Q39** left one edge for this phase to decide rather than inherit, and the decision turns on
a question the plan phrases as "does D12 write a `SchedulerTask` per CAP, or work off the
reconciliation query alone?"

### Decided: **one `SchedulerTask` per CAP**, written at creation, `repeat = 0`.

Four reasons, in the order they actually decided it:

1. **A check that drives the work is not a check.** **C74** asked for a verification path that
   does *not* depend on the runner having succeeded, and **C78** made the reconciliation query
   that path. If the same query also *performed* the closes, then a broken close would return
   an empty result and read as "nothing to do" — the failure would be invisible in exactly the
   way C74 exists to prevent. A check has that property only by being a **different path from
   the work**. So the two share no code: the close is
   `SavingAccountService.closeAccount` (compare-and-set on one id), the check is
   `SavingAccountService.findUnclosedPastDue` (a `SELECT`), and neither calls the other.
2. **C77's gate obligations presuppose a task-creation site.** (i) is *"`repeat = 0` written
   literally at the task-creation site"* and (ii) is *"a unit cell asserting the inserted
   row's `repeat` is `0`"*. Under a query-only design there is no inserted row and both
   obligations are vacuous — which would be a way of passing the gate by removing the thing it
   measures.
3. **A sweep task would have to repeat, and a repeating task must not `throw`.** A
   query-driven design still needs *something* to run daily, which means a `SchedulerTask`
   with `repeat = 1`. **C77** is explicit that `throw` is only safe at `repeat = 0`: a
   deterministically-failing repeating task throws on every pass and therefore never clones
   its successor, ending the chain — Q6's exact failure. So a sweep would have to report
   `ok: false`, which **C74** forbids for money. The two conditions together leave one design
   standing.
4. **It is what v1 intended.** The `# TODO` reads *"schedule task for closing CAP"* —
   singular, at the create site.

### ⚠️ The consequence, stated rather than inherited

**A CAP created between the two passes with an `end_date` of today is closed at 14:00, not
10:00.** Under this design that edge is **reachable**: the task is written with
`run_date` = today, `processed = false`, and the 14:00 pass's date-granularity predicate
(`(run_date AT TIME ZONE zone)::date <= today`) selects it.

That is accepted, and no code was added to prevent it:

* it is only reachable for a **zero-duration CAP** — one created on its own `end_date` — which
  is a data-entry situation, not a business one;
* the CAP still closes **on its `end_date`**, which is what **Q20** specifies; only the hour
  differs, and the CAP earns nothing (**Q19**) so no value turns on the hour;
* it cannot double-close: the runner's claim is atomic and `closeAccount` is a
  compare-and-set, so a second attempt is a no-op;
* ⚠️ **the alternative is worse.** Suppressing it would mean per-type pass scheduling, which
  **Q39 explicitly forbids** ("this needs no code, and Phase 6 must not add any") — building a
  mechanism to produce behaviour the design already produces.

Under a query-only design the edge would be unreachable, and that is the *only* thing the
query-only design would have bought. It is not worth reasons 1–3.

**Pinned by `test/saving-account.e2e-spec.ts`** → *"is a no-op on the 14:00 pass, because the
10:00 pass claimed the row (Q39)"*, which asserts the mechanism Q39's answer rests on rather
than the answer itself.

---

## 3. `MIGRATION_PLAN.md` §5 rows implemented

### D12 — the CAP auto-close

| | |
|---|---|
| **Task type** | `SCHEDULER_TASK_CLOSE_SAVING_ACCOUNT = 1` — the second `SchedulerTask.type`, and the first with no v1 counterpart (`TASK_TYPES` declares only `(0, 'NOTIFICATIONS')`) |
| **Payload** | `"type"=>"saving_account_close", "saving_account_id"=>"<id>"` — no `owner_id`, no `user_ids`, no `message`, no `target` |
| **`run_date`** | local midnight on `end_date`, i.e. `05:00Z` — the same shape Django wrote for every birthday row |
| **`repeat`** | **`0`, structurally** — see below |
| **Close** | `UPDATE fondo_api_savingaccount SET state = 1 WHERE id = ? AND state = 0` |
| **Reconciliation** | `SELECT id FROM fondo_api_savingaccount WHERE state = 0 AND end_date < <today, America/Bogota>` |
| **Notification** | **none** (Q22) |

#### ⚠️ `repeat = 0` is enforced by the *absence of a parameter*, not by a literal

**C77 (i)** asks for `repeat = 0` written literally at the task-creation site.
`SchedulerTaskRepository.createCloseSavingAccountTask` goes further: it has **no `repeat`
parameter at all** and writes the literal `0` in its own SQL, so a caller cannot supply a
non-zero one and the mistake is unrepresentable rather than merely un-made. The docblock
carries the three-step chain (throw → no clone → safe only at `repeat = 0`) at the place a
future maintainer would try to add the parameter.

Pinned twice: a unit cell asserting the *call* carries no repeat argument, and an **e2e cell
that reads the inserted row's `repeat` column back out of the database** (C77 (ii)).

#### ⚠️ `ok: false` is a **compile error**, not a review catch

`SavingAccountCloseExecuter.run` declares
`Promise<{ ok: true; detail: string }>` — narrower than the `SchedulerExecuterOutcome` the
interface promises, which TypeScript permits. **Controlled**: mutating the single `return` to
`ok: false` produces
`error TS2322: Type 'false' is not assignable to type 'true'`, and reverting restores
`tsc --noEmit` exit 0.

#### The three "0 rows updated" meanings, which are not one thing

`closeAccount`'s compare-and-set can update zero rows for two different reasons, and
collapsing them would be the defect:

| situation | result | why |
|---|---|---|
| row exists, `state = 1` | `'already-closed'`, **success** | the designed idempotent rerun — the claim-then-crash window (**P7-D2**) makes it a real path |
| row exists, `state = 7` | `'already-closed'`, **success** | not `0`, so not "open"; see the `PUT` finding in §4 |
| **no such row** | **throws** | a task naming a CAP that no longer exists. Near-unreachable — there is no `DELETE` on this route and user deletion is soft (`is_active = false`) — and left **loud** rather than reported as a success that closed nothing |

---

## 4. Findings — `P6-F1` … `P6-F6`

### P6-F1 — ⚠️ `page <= 0` is refused with a message that says the opposite

`views/saving_account.py:29-30`:

```python
if page <= 0:
    return Response({'message': 'Page number must be greater or equal than 0'}, 400)
```

The check rejects page **0**; the message says page 0 is acceptable. **Ported verbatim** — a
client may be matching on the text, and plan §4 rule 2 forbids modernising a v1 response.

⚠️ **The identical wrong message is in `LoanView.get`** (`views/loan.py:26`) and was ported in
Phase 4 for the same reason. Registered here because it had not been registered anywhere:
`grep -rn "greater or equal than 0" docs/*.md` returned nothing before this file.

Pinned by three e2e cells (`page=0`, `-1`, `-99`) asserting the exact body.

### P6-F2 — ⚠️ `PUT` writes a `state` outside `0/1`, and the row then disappears from everything

`Model.save()` does not call `full_clean()`, so Django validates `choices` **only** in forms
and the admin. `PUT { id, state: 7, value: 0 }` therefore writes a `7`, and that row is then:

* **not listed** — `get_accounts` filters `state = 0` or `state = 1`, and the view refuses any
  other value with a 400, so no request can ask for it;
* **not counted** in `total_savingaccounts` — the Phase 3 aggregate is `state = 0`;
* **not closed** by D12 — the compare-and-set carries `AND state = 0`.

A CAP can be made invisible in three places at once by one well-formed request. **Ported, not
narrowed** (v1 does exactly this), and pinned by a unit cell and an e2e cell that also asserts
the row's absence from the `state=1` listing.

### P6-F3 — `update_account` writes two columns where v1's `save()` writes six

v1 loads the row and calls `account.save()`, which issues a full-row `UPDATE`. v2 issues
`UPDATE … SET state = ?, value = ?`.

**Not observable**: the other four columns are re-sent with the values just read,
`created_at` is `auto_now_add` (untouched on an update), and no column has a database
trigger. Registered because it is a *visible* difference in a query log, and because the
narrowing also removes a lost-update window v1 has.

### P6-F4 — the `GET` role gate is `<= 2`, which **includes** PRESIDENT, while `PUT` excludes them

`if user.role <= 2` widens the list for ADMIN, PRESIDENT **and** TREASURER, but the `PUT` rule
is the list `[0, 2]`, which excludes PRESIDENT (**Q23**, deliberate). So a PRESIDENT can *see*
every member's CAP and cannot change any of them — **including their own**.

Not a defect and not a deviation: both halves are v1 as written, and D3's withdrawal confirms
the `PUT` half. Registered because the asymmetry reads like an oversight and someone will
otherwise "align" the two.

Pinned by two e2e cells: PRESIDENT gets the widened list (200, count 2), and PRESIDENT is
refused `PUT` on their *own* CAP (403).

### P6-F5 — a `value` above 2^53 is a **500** in v2 and a correct JSON number in v1

⚠️ **CORRECTED 2026-09-08 — this row said one thing and there are three, and it mis-cited its
own authority.** `nestjs-reviewer` split it. Rule **5b** / condition **C2** /
`docs/phase-0-deviations.md` §2.10 govern the **render** direction only — `json-bigint.ts`'s
replacer. **v2 ingests request bodies through plain `JSON.parse`** (`bootstrap.ts` disables
Nest's parser and nothing bigint-aware sits on the way in), so the *parse* direction is covered
by none of them, and "pre-declared, do not re-litigate" was wrong for two of the three rows:

| input `value` | v1 | v2 | covered by 5b/C2? |
|---|---|---|---|
| 2^53 − 1 | 201, row + GET fine | identical | — |
| **2^53 + 1** | stores `…993` | **stores `…992`, 201, silently corrupted** | **no — parse side** |
| **2^63 − 1** | 201, row written | **500, refuses a write v1 performs** | **no — parse side** |
| stored > 2^53 | renders a number | 500 on render | **yes** |

⚠️ **And the render refusal reaches a route that already passed its gate:** it 500s the ported
Phase 3 `GET /api/user/<id>` through `total_savingaccounts`, so one bad CAP takes down a Phase 3
response, written through a different route entirely.

⚠️ **The parse-side divergence was observed once before and registered neither time** —
`docs/parity-phase-5-delta.md` row **L2**, Phase 5, with the same observation that the docblock
frames it as a rendering difference. It is now **§5's D41**, owned jointly by Phases 3–6. That
is the actual finding here: a divergence seen in two phases, written in two documents, and
absent from the register that governs.

**The render half only** is pre-declared and not a Phase 6 finding: plan §4 rule **5b**,
condition **C2**, `docs/phase-0-deviations.md` §2.10, which says explicitly *"do not re-litigate
per DTO"*.
`bigIntToJsonNumber` throws `BigIntPrecisionError` rather than losing a peso; Python's
unbounded `int` has no such bound.

Unreachable with real balances (2^53 ≈ 9 × 10^15 pesos). Recorded here only because a
`BigIntegerField` reaches the wire on this route too, and the e2e suite pins **both** sides —
the exact boundary value rendering as a bare number, and the refusal above it — so that a
reader cannot take "money renders fine" for the whole story.

### P6-F6 — `int()`'s two defaults are spelled differently in the two views, and it does not matter

`SavingAccountView.get` reads `int(request.query_params.get('state', 0))` — a Python **`int`**
default — where `LoanView.get` writes `get('page', '1')`, a **string**. `int(0)` and `int('0')`
agree, so there is no observable difference. Registered so that the difference is not
"corrected" in one direction or the other by someone who assumes it is meaningful.

---

## 5. Inherited conditions — what landed

### C68 (major) — the pass summary now reaches a log

`handleCron` discarded `run()`'s return value, so the `failedDelivery` count
`SchedulerExecuterOutcome` promises was computed and thrown away, and a whole-pass failure
went to `@nestjs/schedule`'s default `console.error` with **no `Logger` line at all**. The
runbook's `grep -c 'Running scheduler'` returned **2** whether the pass processed 110 rows or
died on the next statement.

Now every pass ends with exactly one line, and the two are distinguishable:

```
Scheduler pass finished: loaded=110 processed=108 failedDelivery=2 skippedClaimed=0 errored=2 cloned=86
Scheduler pass failed: <message>
```

⚠️ **The runbook check must change** — see §7.1. `grep -c 'Scheduler pass finished'` is the
check that answers the question the old one only appeared to.

The pass-level error is **logged and swallowed** rather than rethrown: `run()` already
contains every per-task failure, so reaching the outer catch means the pass is over, and
letting it escape would re-emit the same information through a channel with no `Logger`
context. The next pass retries every row, because a row is only `processed` if it was claimed
**and** its executer returned. Registered as a deviation from nothing — v1's Celery task would
have printed a traceback; v2 prints a line.

**4 cells**, including the discriminating one: a pass that dies in
`findDueUnprocessed` logs `Scheduler pass failed:` and **no** `finished` line, while
`Running scheduler` is present in *both* cases — which is exactly why the old grep could not
tell them apart.

### C69 (major) — a failed `release()` no longer destroys the executer's error

The error path was `await this.tasks.release(id); throw error;`. If `release()` rejected, the
`throw` was unreachable: the executer's error was **destroyed** and replaced by a database
error, while the row stayed `processed` with nothing done.

The release is now inside its own `try`. Two facts survive, on two lines, because they are two
different facts:

* v1's own `Error processing task with id: {id}, exception: {ex}` — what the executer failed
  at, emitted by the outer catch as before;
* a new line naming the stuck row **and the repair statement**
  (`UPDATE fondo_api_schedulertask SET processed = false WHERE id = N`), which has no v1
  counterpart because the stuck-claim state is a consequence of **P7-D2**'s reordering.

**4 cells**, including a positive control: with a working `release`, only v1's line is
emitted.

### C70 (major) — `SCHEDULER_ENABLED` fails the **boot** on an unrecognised value

`SCHEDULER_ENABLED=ture` was silently `false`, **and the spec pinned that leniency**. The
grammar is now closed:

| value | result |
|---|---|
| **absent** | `false` — every replica that legitimately is not the runner |
| `true` / `1` / `yes` / `on` (any case, trimmed) | `true` |
| `false` / `0` / `no` / `off` (same) | `false` |
| **anything else, including `''` and `'   '`** | **boot fails**, naming the variable, the accepted words and the received value |

⚠️ **Present-but-empty fails.** `SCHEDULER_ENABLED=` in a unit file, or
`SCHEDULER_ENABLED=${FLAG}` with `FLAG` unset, is the *same* accident as the typo. Absent stays
`false`, because absent is what a non-runner replica is. That distinction mirrors the one
`lastQueryValue` already draws between an absent and an empty query parameter.

The word table is a single `Map`, so "is this recognised" (`.has`) and "what does it mean"
(`.get`) cannot drift apart — the same failure this condition is about, one level down.

**9 cells.** ⚠️ Three of them **invert** an existing assertion: the old spec certified
`'maybe'`, `'enabled'` and `''` as *disabled*. That is the mechanism worth naming — the defect
had a passing test.

### C73 (minor) — `Sending request to MNS...` ported

`fondo_api/celery/tasks.py:15` logs it as the **first statement** of `send_notification`,
before the queue URL is read. v2 emitted `Message sent, id: …` and the error line but not
this one, so a publish that died before either terminal line left no trace at all.

One line at the top of `NotificationPublisher.publish()`, before the `queueUrl` check, so the
unconfigured branch still leaves an attempt line. **3 cells**, including "logs exactly one
attempt line for a publish that is retried three times" — v1 has no retry loop, so *once per
publish* is the only reading that ports.

### C75 (minor) — registered, as asked

Two additive log-stream differences from v1, neither touching a row or a byte:

1. ⚠️ **v2 passes `error.stack` as `Logger.error`'s second argument**, so every caught error
   emits a **stack block v1 never prints**. v1's `logger.error("...".format(ex))` renders
   `str(ex)` and nothing else. Deliberate: the stack is how a v2 operator finds the failing
   line, and `docs/phase-7b-deviations.md` §4 **P7-D6** already records that the *message*
   text differs. **Now three lines carry a stack**: the two from Phase 7b, plus C69's new
   stuck-claim line.
2. ⚠️ **The WARN lines have no v1 counterpart** — `skippedClaimed` ("was already claimed by
   another runner") and `failedDelivery` ("was marked processed but its executer reported…").
   Both report states v1 cannot detect: the first is a consequence of the atomic claim
   (**P7-D2**), the second of `SchedulerExecuterOutcome` existing at all.

**Now four additive lines**, because this phase adds two more with no v1 counterpart: C68's
`Scheduler pass finished:` / `Scheduler pass failed:`, and C69's stuck-claim line.

Registration only; no code change. `manual-tester` must read all of these as **expected**.

### C76 (nit) — the discriminating clone cells. ⚠️ **The suggested cell was not sufficient, and this was measured**

C76 suggested `run_date = 2026-01-31T01:00:00.000Z`, `repeat = 3` → UTC-space
`2026-02-28T01:00:00.000Z` vs Bogota-local `2026-03-01T01:00:00.000Z`. That cell was written
first, on its own, and then **mutation-controlled — and a mutant passed it.**

There are **two** wrong implementations, and they are separable:

| mutant | what changes | differs from v1 when |
|---|---|---|
| **read-local** — `toBogotaDate(instant)` for the date, UTC time reattached | the day the delta starts from | the source UTC day ≠ the source Bogota day *and* no clamp collapses them — DAILY / WEEKLY / YEARLY, and MONTHLY into a **31-day** month |
| **round-trip-local** — convert to Bogota, add, convert back | the wall time the result is pinned to | a clamp binds, so the local day and the UTC day land in different months |

A month-end MONTHLY hop **into February** — the suggested cell — is precisely the case where
`min(28, 31)` and `min(28, 30)` are **both 28**. The read-local mutant survives it.

So the suite carries **four** cells, two per mutant, and both mutants were run:

| cell | repeat | source | expected | catches |
|---|---|---|---|---|
| *adds a DAILY delta from the UTC day* | 1 | `2026-01-31T01:00Z` | `2026-02-01T01:00Z` (not `2026-01-31`) | read-local |
| *advances a YEARLY task from the UTC day* | 4 | `2026-01-31T01:00Z` | `2027-01-31T01:00Z` (not `2027-01-30`) | read-local |
| *clamps into UTC space* (C76's own) | 3 | `2026-01-31T01:00Z` | `2026-02-28T01:00Z` (not `2026-03-01`) | round-trip-local |
| *loses the leap day in UTC space* | 4 | `2024-02-29T01:00Z` | `2025-02-28T01:00Z` (not `2025-03-01`) | round-trip-local |

**Measured, both directions:** each mutant fails **exactly 2** of the 50 runner cells, and the
restored file passes all 50. The YEARLY read-local cell is the one that matters most in
practice — the live birthday chains are `repeat = 4`, and a read-local implementation would
greet a member one day early, every year, for ever.

### C77 / C78 — the code obligations

C77's three gate obligations, and where each is discharged:

| | obligation | where |
|---|---|---|
| (i) | `repeat = 0` literal at the task-creation site | `SchedulerTaskRepository.createCloseSavingAccountTask` — literal `0` in the SQL, **and no `repeat` parameter to override it** |
| (ii) | a unit cell asserting the inserted row's `repeat` is `0` | unit cell on the *call*; **e2e cell reading the `repeat` column back out of PostgreSQL** |
| (iii) | a cell asserting a **throwing** close executer leaves the row unprocessed **and writes no clone** | `scheduler.runner.spec.ts` → *"a throwing D12 close executer (C77 iii)"*, 4 cells |

⚠️ **A control finding on (iii), stated because the reviewer should not take the e2e cell for
more than it is.** Both halves were mutation-controlled against a runner "fixed" to clone
*before* running:

* the **unprocessed / retried** half is discriminated at both levels — a runner that skips
  `release()` fails 3 e2e cells;
* the **no clone** half is **vacuous in e2e**, because D12's task carries `repeat = 0` and
  `createRepeatInstance` returns early on `NONE` under *either* ordering. The clone-before-run
  mutant **passes the entire 98-cell e2e suite** and fails **2 unit cells** — the `repeat = 4`
  variant, *"would end a chain if the close task ever carried a non-zero repeat"*.

That variant is therefore the only thing standing between this codebase and someone
reordering the runner. It is called out in a comment in the e2e file so a later reader does
not delete the unit cell as redundant.

**C78** is discharged by construction: `state` is materialised, nothing derives closed-ness
from `end_date` at read time (`grep -n "end_date" src/**/*.ts` reaches only the serializer, the
create, the reconciliation query and the task's `run_date`), and the reconciliation query and
the close share no code.

---

## 6. For `manual-tester`

### 6.1 Expected diffs against v1 — read these as **expected**, not as findings

| # | what to expect |
|---|---|
| 1 | **`GET /api/saving-account` renders `end_date` and `created_at` in Spanish** (`28 feb. 2024`), because both are `SerializerMethodField`s. This is *not* the ISO spelling `ActivityDetailSerializer.date` uses. |
| 2 | **`POST` answers 200**, not 201. `PUT` answers **201**, with a zero-byte body. Both are v1. |
| 3 | **`?page=` and `?state=abc` are 500s**, not 400s. v1's `int()` is unguarded. |
| 4 | **`page=0` is refused with a message saying page 0 is fine.** P6-F1. |
| 5 | **`?all_accounts=true` as a MEMBER is a 200 with a narrower list**, never a 403. |
| 6 | **A PRESIDENT sees every CAP and can change none, including their own.** P6-F4. |
| 7 | **`PATCH` / `DELETE` / `OPTIONS` on this route are 403 for every role**, ADMIN included — never 405. |
| 8 | **New in v2: a CAP closes by itself on its `end_date`.** D12. v1 never did this. It fires on the 10:00 Bogota pass and writes **no notification**. |
| 9 | **New in v2: creating a CAP writes a `fondo_api_schedulertask` row** with `type = 1`. A v1 process that saw it would log `Executer type 1 does not exist.` and leave it unprocessed — which is fail-closed, and is what makes a rolling deploy safe. |
| 10 | **New log lines** — see §5's C68, C69, C73, C75. Four lines have no v1 counterpart and one (`Sending request to MNS...`) was restored. |
| 11 | **A boot that used to succeed may now fail**: `SCHEDULER_ENABLED` set to anything outside the eight accepted words, **including empty**, aborts the boot. C70. |

### 6.2 Explicitly **unchanged** — if these differ, that IS a failure

* `total_savingaccounts` in the Phase 3 user response — same value, same field, for the same
  rows. It sums **`state = 0` only** and affects **no other finance field** (**Q24**).
* The create notification: *"Ha sido creada una nueva CAP"* → `/manage/caps`, to active
  ADMINs and TREASURERs, **not** to the member. Q22 is about close and revalue.
* Every Phase 1–5 and 7b response byte.

### 6.3 ⚠️ Data safety

This phase's e2e suite **executes scheduler passes**. They run against `fondo_api_test` and
`assertDisposableDatabase` refuses anything else, but the rule from Phase 7b stands: **never
start a runner against `fondodev`**, and never with real SES/SQS credentials.

### 6.4 Pre-declared rows — do not re-file these

**D12**, **D7**, **P7-D1**–**P7-D6**, **C2** / rule 5b (P6-F5 above), and **D3** (withdrawn —
there is nothing to test).

---

## 7. To fold back into `MIGRATION_PLAN.md`

### 7.1 ⚠️ The Phase 9 runbook's scheduler health check is now wrong, and must change

The runbook (and `docs/phase-7b-deviations.md` §5.4) tells the operator to run
`grep -c 'Running scheduler'` and expect **2**. **C68 is the finding that that check cannot
fail**: it returns 2 whether the pass processed 110 rows or died on the next statement.

Replace it with:

```bash
# expect 2 — a pass that started AND finished, twice
grep -c 'Scheduler pass finished' <log>
# expect 0
grep -c 'Scheduler pass failed'  <log>
```

⚠️ **And the paired negative check matters as much as the positive one.** `Running scheduler`
appears in both the healthy and the dead case, so it is the wrong string to count; the new
lines are emitted only at the *end* of a pass, which is the property being tested.

This is the detection story **D12 inherits**: a CAP that silently stops closing is caught the
same way a reminder that silently stops sending is, and neither needs a mechanism of its own.

### 7.2 §5's **D12** row should record the per-CAP-task decision and its consequence

The row currently says *"Needs a `SchedulerTask` type"*. It should say **one task per CAP,
written at creation, `repeat = 0`** — and carry §2's consequence: *a CAP created between the
two passes with an `end_date` of today closes at 14:00, accepted, no code.* Q39's "one edge
Phase 6 must decide rather than inherit" is then closed rather than open.

### 7.3 §3's Phase 6 *Risks* should carry the C76 finding forward as a general rule

C76's suggested discriminating cell was **insufficient**, and only a mutation control found
that. The general form is worth recording where the next phase reads it: *a cell that pins a
timezone-sensitive computation must be mutation-controlled against **each** wrong
implementation separately — "the two dates disagree" is not one property but two, and a clamp
can collapse them.*

### 7.4 The `page <= 0` message contradiction has no register row anywhere

It is in **two** ported views (`LoanView.get`, `SavingAccountView.get`) and
`grep -rn "greater or equal than 0" docs/*.md` found nothing before this file. It belongs in
§5 as a shared, deliberately-unfixed v1 wart, not as a Phase 6 footnote — Phase 4 ported it
first.

### 7.5 §3's Phase 6 *Scope* line about `total_savingaccounts` is satisfied, and how

*"Re-verify the Phase 3 parity report after this lands"* — done in-suite rather than in a
document, which is the more durable form. `test/saving-account.e2e-spec.ts` carries four cells
that read the **Phase 3** `GET /api/user/<id>` response before and after each kind of CAP
write, including D12's auto-close, and assert that `total_savingaccounts` moves and **every
other finance field is byte-identical**. The auto-close one is the important one: D12 drops a
CAP out of a *ported* Phase 3 response, silently, and nothing else in the suite would have
noticed.

### 7.6 The board's Phase 6 row

C74 was already closed; **C68, C69, C70, C73, C75, C76** are closed by this phase, and C77's
and C78's *code* obligations are discharged. **C71** and **D39** were left alone deliberately
— both are birthday-notification work, not CAP work, and D39's open question (*which layer*)
is properly decided by whoever implements the birthday filter. If the reviewer disagrees with
that split, D39's executer-vs-chain-creation choice is a one-file change either way and does
not depend on anything this phase built.
