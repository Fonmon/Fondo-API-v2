# Phase 7b — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5, and to `docs/phase-0-deviations.md` …
`docs/phase-5-deviations.md`.

Audience: `nestjs-reviewer` (§1–§4), `manual-tester` (§5 — everything it must read as an
**expected** diff, plus the data-safety rules for a phase that *executes* tasks), and whoever
maintains `MIGRATION_PLAN.md` (§6 — corrections to fold back).

**Scope shipped**

| Area | Units |
|---|---|
| Cron runner | `SchedulerRunner` — `0 10,14 * * *` `America/Bogota`, replacing `celery -A api beat` **and** its worker |
| Executers | `SchedulerExecuter`, `NotificationExecuter` (type 0), `ExecuterFactory` |
| Repeat cloning | `create_repeat_instance` on `nextRepeatRunDate` (Phase 0, condition **C3**) |
| Data layer | `SchedulerTaskRepository.findDueUnprocessed` / `.claim` / `.release` / `.createRepeatInstance` — **added to the existing 7a repository, not a second one** (plan §2) |
| Config | `SCHEDULER_ENABLED` |
| §5 register implemented | **D7** |
| **Routes** | **none.** `docs/adding-a-route.md` does not apply — nothing was added to `django-url-conf.ts` or to the permission matrix. |

**Gate numbers** — asserted by **exit code**, never by reading output for silence.

| | baseline (`d88e3af`) | after |
|---|---|---|
| `npm run lint` | exit 0 | **exit 0** |
| `npm run typecheck` | exit 0 | **exit 0** |
| unit | 2093 / 64 suites | **2173 / 67 suites** |
| e2e | 1032 + 2 skipped / 19 suites | **1061 + 2 skipped / 20 suites** |

`+80` unit — `scheduler.runner.spec.ts` **34**, `notification.executer.spec.ts` **12**,
`executer.factory.spec.ts` **5**, **+14** in `env.validation.spec.ts` (11 → 25, the
`SCHEDULER_ENABLED` parsing table plus the fails-closed default), **+12** in
`relativedelta.util.spec.ts` (104 → 116, `isSchedulerRepeat`) and **+3** in
`notification.service.spec.ts` (22 → 25) — and `+29` e2e, all in
`scheduler-runner.e2e-spec.ts`. **No cell was removed or weakened.**

⚠️ **One of those twelve found a real hole in code written an hour earlier**, which is the
argument for writing them: `isSchedulerRepeat` was
`hasOwnProperty(SchedulerRepeat, String(value))`, and a numeric TS enum carries a **reverse
mapping** — so it answered `true` for the string `'MONTHLY'`. The parameter is typed `number`,
but the values it narrows come out of a database column. Fixed with a leading
`Number.isInteger`. Two existing assertions changed subject-preservingly
because `NotificationService.sendNotification` widened its return from `void` to a
`NotificationDelivery` tag — see §3; both still assert "does not throw", and now also assert
*which* outcome occurred.

`fondodev` verified unchanged before and after, on **counts, sequences and `xmin`
cardinality** (false-green #22 was counts alone):

```
activityyear 9 · activity 25 · activityuser 338 · loan 425 · loandetail 374
schedulertask 626 · notificationsubscriptions 94 (max id 1468) · auth_user 15 · power 20
userprofile 15, 15/15 key_activation NULL
count(distinct xmin::text) = 1 on all nine tables checked
20 sequences, every last_value identical to baseline
```

Pre-write `pg_dump` of **every** table: `~/.fondo-parity-dumps/20260907T055041-phase-7b-start/`
— one custom-format dump per table plus a whole-database one, on persistent storage, taken
**before the first line of this phase was written**. Restore only with `pg_restore`.

⚠️ **v2 wrote nothing to `fondodev` in this phase.** The e2e suite runs against
`fondo_api_test`, and `assertDisposableDatabase` (condition **C25**) refuses anything else.

⚠️ **One drift, self-inflicted, caught and repaired — worth reading, because it is
false-green #22's exact mechanism seen from the other side.** To give the fixture check a
positive control I inserted one `fondo_api_schedulertask` row inside a transaction and rolled
it back. **PostgreSQL sequences are not transactional**: the rollback removed the row and left
`fondo_api_schedulertask_id_seq` at **2529**. Row counts, `max(id)` and `xmin` cardinality were
all still exactly at baseline — a counts-only check would have reported PASS, which is #22
verbatim. The sequence line caught it; repaired with
`SELECT setval('fondo_api_schedulertask_id_seq', 2528, true)` and re-verified against the
pre-phase run. **Two things follow for `manual-tester`:** a rolled-back probe is *not* a
no-op, and the control for a fixture check must not itself write — use a different database
(`DB=fondo_api_test scripts/parity/fixture-check.sh`), which is what
`scripts/parity/fixture-check.sh` now documents.

The check itself is in the repo: **`scripts/parity/fixture-check.sh`** — counts, `max(id)`,
`key_activation` nulls, `xmin` cardinality on nine tables, and all twenty sequences, in one
diffable output, with its own positive control documented at the top.

---

## 1. `@nestjs/schedule`, not BullMQ — and the multi-instance claim

The plan left this open (§3 Phase 7 *Scope*: *"or BullMQ on the existing Redis if
multi-instance safety is wanted — decide in this phase"*) and asked for the multi-instance
question to be settled here. **Decision: `@nestjs/schedule`, plus a deployment role flag,
plus an atomic database claim.** Reasoning, in the order it actually decided the matter:

1. **The multi-instance problem is a *topology* problem, and v1 already solved it that way.**
   v1's runner is `celery -A api beat` — a **separate container**. The gunicorn API image
   never runs it, however many replicas exist. So v1's guarantee is not a lock; it is "only
   one process is the runner". `SCHEDULER_ENABLED` reproduces exactly that, and reproducing
   it costs one boolean.
2. **BullMQ's price is the thing this phase exists to retire.** The goal in §3 is *"retire the
   Celery worker + beat containers"*. `BROKER_URL = redis://…` (`api/settings/base.py:165`)
   goes with them. Adding BullMQ keeps Redis alive as a production dependency, adds an
   operational component to monitor, and — the part that matters more — introduces a **second
   source of truth for what runs when**. `fondo_api_schedulertask` already *is* that source,
   rows and dates and all; a repeatable-job registry that drifted from it would be the next
   silent-failure story in a subsystem whose defining property is silent failure.
3. **The residual risk is handled where it shows up: in the data.** If the flag is ever set on
   two processes, `SchedulerTaskRepository.claim()` is an atomic
   `UPDATE … SET processed = true WHERE id = ? AND processed = false`, and the loser skips the
   row. That is the plan's own suggested remedy (§3 *Risks*), it needs no new infrastructure,
   and unlike a Redis lock it survives a Redis outage — because it **is** the row.
4. **`@nestjs/schedule` was already a dependency and already registered.** Phase 0 left
   `ScheduleModule.forRoot()` in `AppModule` with the comment *"so Phase 7 only has to add the
   cron provider"*. No new package entered `dependencies`, so condition **C12**'s phantom-
   dependency hazard is not reopened: nothing imports `cron` directly.

**What is claimed, precisely.** With one flagged process: exactly-once, same as v1. With two:
each task is executed **at most once** and cloned **exactly once**; a duplicate push is
impossible, because the claim precedes the publish. With zero: nothing runs, loudly — the
process is up and the log says nothing about the scheduler, which is the failure mode to watch
for at cutover (§5.4).

**What is *not* claimed.** A process that is hard-killed between claiming a row and publishing
it loses that notification: the row reads `processed = true` and no message was sent. v1 has
the mirror-image window (it publishes, then crashes before `task.save()`, and re-sends next
pass). Both are unrecoverable without a third state on a column this migration is not allowed
to reshape. Recorded, not fixed.

---

## 2. `MIGRATION_PLAN.md` §5 rows implemented

### D7 — a past-due reminder is sent, not skipped

| | |
|---|---|
| **v1** | `SchedulerTask.objects.filter(run_date__year = …, run_date__month = …, run_date__day = …)` — an **exact calendar-day match**. A reminder whose `run_date` has passed is never picked up again, so the T−5d loan reminder is skipped outright whenever the monthly payment file lands within five days of the deadline. |
| **v2** | `(run_date AT TIME ZONE 'America/Bogota')::date <= <today in Bogota>`. |
| **Decided** | operator **Q8** — *"send immediately on the next scheduler run instead of skipping"*. |
| **Where** | `SchedulerTaskRepository.findDueUnprocessed`. |
| **Pinned by** | `test/scheduler-runner.e2e-spec.ts` → *D7 — includes a past-due task, which v1 would have skipped forever*, control-run against the `=` form (3 cells fail, 29 compile). |

⚠️ **D7 has a consequence the register does not mention, and it is the single most important
thing in this document — see §4.1.** On `fondodev` today, `<=` makes **110** rows due on the
first run, the oldest from **2020-09-27**.

---

## 3. The silent-failure decision — reproduce the outcome, drop the silence

This is the behaviour the plan singles out twice, so the decision is stated explicitly rather
than left to be inferred from the code.

**What v1 does.** `celery/tasks.py:send_notification` wraps `sqs_client.send_message` in a bare
`try/except`, logs, and returns `None`. `NotificationExecuter.run` returns `None`.
`scheduler/tasks.py:24` then runs `task.processed = True; task.save()` **unconditionally**, and
`create_repeat_instance` clones the row. So a failed publish is recorded as a success, in the
one subsystem that is the sole delivery path for loan payment reminders. Three different
outcomes — published, no devices, publish failed — are indistinguishable at every layer.

**What v2 does, and why the split.**

| | v1 | v2 | why |
|---|---|---|---|
| Publish failed → row marked `processed` | yes | **yes — ported** | The alternative (leave it unprocessed) retries a *configuration* error twice a day forever **and never clones the `repeat` successor**, so a broken SES/SQS credential would silently break the whole birthday chain rather than one message. Operator **Q6** already decided this. |
| Publish failed → row cloned by `repeat` | yes | **yes — ported** | Same reason; breaking the chain is worse than losing one message. |
| Publish failed → anything says so | **no** | **yes — deviation** | A `WARN` naming the task id and the outcome, plus `failedDelivery` in the run summary. Costs nothing, changes no row, and is the difference between "we lost September's reminders" being discovered by a member and being discovered by a log. |
| The three outcomes are distinguishable | no | **yes — deviation** | `NotificationService.sendNotification` returns `'published' \| 'no-subscriptions' \| 'failed'` instead of `void`. |

**Registered as P7-D5.** The observable database and SQS state is **identical to v1**; only the
log gains lines. `manual-tester` should expect no row-level difference from this.

⚠️ **Two existing assertions moved as a result**, both subject-preserving:
`src/notifications/notification.service.spec.ts` and `test/notification.e2e-spec.ts` asserted
`resolves.toBeUndefined()` on a failed publish. Their subject was *"does not throw"*, which is
still asserted — `toBe('failed')` fails just as loudly on a rejection — and they now also pin
which outcome the caller is told about. Three new unit cells cover the other two tags.

---

## 4. Discoveries — `P7-D1` … `P7-D6`

### P7-D1 — ⚠️ D7 replays a five-year backlog on the first enabled run. **This needs an operator decision before cutover.**

**Measured on `fondodev`, 2026-09-07:**

```
unprocessed tasks due under D7 (run_date_local <= today)   110
  oldest run_date                                          2020-09-27
  of those, targeting a member with a live subscription     108
  distinct user_ids lists                                    13
  distinct members actually reachable (they hold a subscription)   13
payment_reminder rows among them whose loan is PAID_OUT       65
```

The first pass with `SCHEDULER_ENABLED=true` would publish **~108 SQS messages in one loop**,
of which **65 are payment reminders for loans that are already paid off**, some six years old.
Every one renders as a browser push saying *"Recuerde que la fecha límite de pago para el
crédito N, es el: …"* with a date in the past.

This is not a defect in D7 — D7 is right about the case it was raised for (a reminder created
*today* for a date three days ago must still fire). It is that **"has passed" and "was never
picked up because v1 could not" are the same database state**, and D7 cannot tell them apart.
v1 has been accumulating the second kind since 2020 precisely *because* it skips them.

**Not guessed at, and not silently bounded.** Three options, none of them mine to pick:

1. **Drain before enabling** (recommended). One statement at cutover:
   `UPDATE fondo_api_schedulertask SET processed = true WHERE processed = false AND run_date < now() - interval '2 days';` — run **after** the `pg_dump`, **before** `SCHEDULER_ENABLED` is
   set. Keeps D7 exactly as decided and makes the backlog a data question, which is what it is.
2. **Bound the catch-up in code** — only send tasks due within the last N days. This is a
   *change to D7* and would have to be registered as one; it also silently swallows a genuinely
   old task forever, which is the thing D7 exists to stop.
3. **Accept the flood.** Defensible only if the operator considers 108 stale pushes to 13
   members an acceptable one-off.

**Escalated to `business-analyst`** as an operator question; it belongs with the two D12
questions Phase 6 already has open. **Phase 7b does not close until this is answered**, because
the answer is a cutover step, not a code change (option 1) or a code change (option 2).

A second, smaller face of the same thing: `services/loan.py:314-315` schedules **two** reminders
with the same `(owner_id, type)` on two different days (T−5d and T−1d). If both dates have
passed, v1 sends neither and v2 sends **both, in the same pass**, as two identical-bodied
messages. Same-day dedupe does not apply — it is keyed on the calendar day.

### P7-D2 — the claim moved *before* the run, and is released again on error

v1's order is `resolve → run → mark → clone`; v2's is `resolve → **claim** → run → clone`, with
`release` on the error path. Three notes:

* **Resolve stays first, deliberately.** `ExecuterFactory.get` is a pure lookup with no I/O, so
  it costs nothing to run before the claim — and it must, or an **unknown task type would be
  consumed**. That is not hypothetical: Phase 6's **D12** introduces a second task type, and
  during a rolling deploy an old replica would otherwise mark every new-type row processed and
  drop it. Pinned by *resolves the executer BEFORE claiming, so an unknown type is never
  consumed*.
* **`release` restores v1's end state.** After an exception v1 never reaches `task.save()`, so
  the row stays unprocessed and the next pass retries it. Without the release, moving the claim
  earlier would have turned "retried and logged twice a day" into "silently swallowed" — the
  opposite of this phase's whole point.
* **The clone is not covered by the release.** v1 reaches `task.save()` before
  `create_repeat_instance`, and Django autocommits each statement, so a clone failure leaves the
  source row processed with no successor. Ported: `mark` and `clone` are two statements, not one
  transaction. Pinned by *does not release the claim when only the clone failed*.

### P7-D3 — an out-of-range `repeat` is refused instead of cloned onto its own date

`create_repeat_instance`'s four `if`s are **not** `elif`s and carry no `else`. A `repeat` of, say,
7 falls past all four, leaves `run_date` unchanged, and `objects.create` writes a **duplicate row
on the same date**, unprocessed. The column is `choices`-constrained in **Python only**; there is
no check constraint, verified. No such row exists in `fondodev` (626 rows: 540 `repeat = 0`, 86
`repeat = 4`), so this is unreachable today and reachable tomorrow.

⚠️ **What v1 then does was measured, not reasoned about, and the first version of this row got it
wrong** (parity round F3; this text replaces it). The clone keeps the **same `run_date`**, so it
is picked up by the *same day's second pass* — but only that one. v1's filter is an exact
calendar-day match, so once the day ends the twin is never selected again. Five v1 passes on the
isolated clone, one `repeat = 7` row dated 2026-09-10:

| pass (Bogota) | v1 log | rows after |
|---|---|---|
| D 10:00 | `1 tasks to process` | `2529` processed, clone **`2530` on the same date** |
| D 14:00 | `1 tasks to process` | `2530` processed, clone **`2531`, same date again** |
| D+1 10:00 | `0 tasks to process` | unchanged |
| D+1 14:00 | `0 tasks to process` | unchanged |
| D+2 10:00 | `0 tasks to process` | unchanged |

**v1 is bounded**: **two extra rows** on the original date and **one extra push** — the capture
stub recorded 2 messages in total, one of which is the task's own legitimate one and the second
the twin's, on that day's 14:00 pass; clone `2531` is never selected and never publishes. Then
silence. Not "forever".

⚠️ **The unbounded version would be *ours*, and that is the actual argument for the refusal.**
The twin v1 leaves behind is past due, and **D7's `<=` makes a past-due row due on every later
pass** — measured on the rows v1 had just written: v1's `=` rule returns **0** of them from D+1
onward, D7's `<=` returns **1**, still 1 a year later, and a real v2 pass on D+1 loaded it
(`1 tasks to process`). So a runner that used `<=` *and* reproduced clone-onto-its-own-date would
mint a fresh permanently-due row on **every** pass, twice a day, without end. Porting v1 here
would have been **strictly worse than v1**, because our own D7 is what turns a two-row quirk into
a runaway.

v2 throws, which routes into v1's own `except` branch: the error is logged with the task id, the
row stays processed, and nothing is cloned. Narrower than v1 and deliberately so.

⚠️ **For whoever later wonders whether the guard can be relaxed:** it cannot be relaxed
*independently of D7*. The refusal costs a hand-edited row its clone; removing it while `<=` is
the selection rule costs the fund an unbounded table and an unbounded push volume. If D7 ever
reverts to `=`, the trade changes — and only then.

### P7-D4 — a SQL `NULL` in `payload->'message'` or `->'target'` is refused

v1 would pass Python `None` into the notification body and `json.dumps` would render `null` on
the wire. Unreachable from either writer — Django's `HStoreField.get_prep_value` calls `str()`,
so a Python `None` is stored as the **string** `'None'`, never SQL NULL — so v2 refuses loudly
rather than widening `NotificationContent`'s types for a state only a hand-edit can produce.
Same species, and same fail-closed direction, as condition **C23**'s decision for `user_ids`.
An **absent** key still raises, is still caught by the loop, and still leaves the row
unprocessed for the next pass — the *row and wire* behaviour is v1's. ⚠️ The **log text** is
not; see **P7-D6**.

### P7-D5 — `sendNotification` returns a delivery tag

See §3. No row-level or wire-level difference.

### P7-D6 — an absent payload key logs `KeyError: 'x'`, where v1 logs `'x'`

⚠️ **This row exists because the first version of P7-D4 claimed a match that measurement does
not support** (parity round F1). The claim was *"an absent key still raises `KeyError: '<key>'`,
exactly as v1 does"*. It does not:

```
v1: ERROR Error processing task with id: 2529, exception: 'message'
v2: ERROR Error processing task with id: 2529, exception: KeyError: 'message'
```

`scheduler/tasks.py` formats the exception with `'{}'.format(ex)`, which is `str(ex)`, and
`str(KeyError('message'))` is `"'message'"` — the quotes are the repr of the key and there is
**no `KeyError:` prefix**. Verified in-container on this round:
`'…exception: {}'.format(ex)` → `… exception: 'message'`. Same for `user_ids`, whose text comes
from `requireHstoreKey` in `hstore.codec.ts`.

**Decision: keep v2's text, register the difference — do not match.** Three reasons, in the
order that decided it:

1. **Matching makes v2's log worse.** v2's exception is a plain `Error`; nothing else on the
   line says what kind of failure it was. `exception: 'message'` is a bare quoted word. v1's
   version is legible only because Python's type name is implied by convention, and that
   convention does not exist here. Dropping the prefix is adding silence, which is the exact
   thing §3 decided against for the sibling case.
2. **`KeyError: 'x'` is a house convention five phases old, not a Phase 7b invention.** Four
   producers write it — `hstore.codec.ts:requireHstoreKey`, `python-obj.ts:PythonKeyError`,
   `notification.service.ts:241` and `notification.executer.ts:requireText` — and **16
   assertions in 8 spec files** pin it (multipart uploads, powers, users, subscriptions, the
   scheduler). On every one of those other paths v1's `KeyError` is a **body-less 500**, so the
   text reaches no client and there is no parity to gain; changing it there would cost
   diagnosability for nothing, and changing it *only* here would leave the codebase saying two
   different things about the same ported exception.
3. **Nothing observable moves.** Rows, wire bytes, the `processed` flag, the retry on the next
   pass and the pinned line *format* (`Error processing task with id: {id}, exception: {ex}`,
   §6.3) are all identical; only the substituted `{ex}` differs. Measured in parity cells D5
   and D7k: `ROWS: SAME`, `WIRE: SAME (0/0)`.

**If a reviewer overturns this, the minimal change is two lines** — `requireText`
(`notification.executer.ts`) and `requireHstoreKey` (`hstore.codec.ts`), both
`` `KeyError: '${key}'` `` → `` `'${key}'` `` — plus the 7 spec touch points those two feed
(`notification.executer.spec.ts` 2, `hstore.codec.spec.ts` 3, `scheduler.runner.spec.ts` 2: one
mock input at `:253`, one log-line assertion at `:275`).
⚠️ **Do not "fix" it codebase-wide**: the other two producers only ever surface on HTTP paths
where v1 answers a body-less 500, so changing them buys no parity and loses the type name.

---

## 5. Judgment calls and findings

### 5.1 `todayInBogota` is the third phase where this helper is the difference

`scheduler/tasks.py:15-18` compares `datetime.now()` against `run_date__year/month/day` lookups.
Those agree **only because** `django.conf.Settings.__init__` sets `os.environ['TZ']` from
`TIME_ZONE` and calls `time.tzset()` (condition **C4**). v2 has no such global, so both halves
are pinned explicitly:

* the **question** — `todayInBogota(now, config.timeZone)`, never `new Date().getDate()`;
* the **comparison** — `(run_date AT TIME ZONE $zone)::date`, matching the `AT TIME ZONE` Django
  emits for `__year`/`__month`/`__day` under `USE_TZ`, never a UTC extract.

Getting either wrong is invisible in CI and wrong in production for the five hours a day the two
zones disagree — a task scheduled at 20:00 local would be skipped on its day and run on the next.
Both are control-run: a host-zone read fails the unit cell (34 cells compile, 1 fails); a
`'UTC'` extract fails the e2e cell (29 compile, 1 fails).

### 5.2 The runner reads with **no `ORDER BY`**, on purpose

v1's queryset is unordered, so PostgreSQL heap order is what both versions iterate — and Phase 2
measured that adding `ORDER BY id` to the sibling subscription read *breaks* wire parity. The
only thing the order affects here is the sequence of SQS messages. Left unordered, documented at
the call site.

### 5.3 The clone copies `payload::text`, not a re-encode

v1 passes `payload = task.payload` — the dict it read back out of hstore, every value already a
string — and `get_prep_value` `str()`s them a second time, which is a no-op. Cloning the stored
text is therefore exact **and** immune to an encoder change; a re-encode through
`toHstoreLiteral` would be correct today and a silent divergence the day anything about the
codec moves. Pinned by an e2e cell asserting `clone.payload === source.payload` byte for byte.

### 5.4 The cron is registered unconditionally; only the *work* is gated

`@Cron` metadata is evaluated at class-definition time, before configuration exists, so the
decorator's `disabled` option cannot read `SCHEDULER_ENABLED`. The guard is the first line of
`handleCron` instead. Consequences, both accepted:

* every process wakes twice a day and returns immediately — no query, no publish;
* the job is visible in `SchedulerRegistry` everywhere, which is *useful*: its `cronTime` and
  `timeZone` are assertable, and a cell does assert them off the metadata rather than off a copy
  of the constant.

⚠️ **The failure mode to watch at cutover is the flag being set on *nobody*.** Nothing errors;
the fund simply stops getting reminders. `SchedulerRunner` logs `Running scheduler` on every
pass it actually performs, so *absence* of that line twice a day is the check —
`grep -c 'Running scheduler'` on a day's log should be **2**, and a `0` is the alarm. (Rule
**C67**: the check has to be able to report something other than "nothing found", which is why
it counts a line rather than looking for an error.)

### 5.5 Two modules, not one, and why

`NotificationModule` already imports `SchedulerModule` (7a's write half). The runner needs the
dependency the other way — `NotificationExecuter` calls `NotificationService` — so putting it on
`SchedulerModule` would need a `forwardRef`. `SchedulerRunnerModule` keeps the graph acyclic and
matches v1's own layout, where `fondo_api/scheduler/` imports `fondo_api/services/notification.py`
and nothing imports back. The plan's Phase 7 text says "adds … to this module"; this is the one
place it is not followed, for a reason the reviewer can check in ten seconds.

### 5.6 What was reused rather than re-implemented (condition **C36**'s discipline)

| Needed | Reused | Not written |
|---|---|---|
| hstore reads/writes | `SchedulerTaskRepository` (7a) | a second raw-SQL repository — plan §2 forbids it |
| hstore text → map | `parseHstore` | a parser |
| `json.loads(payload['user_ids'])` | `decodeSchedulerPayload` (Phase 3, C23) | a decoder |
| `relativedelta` | `nextRepeatRunDate` (Phase 0, C3) | anything from a date library |
| "today" | `todayInBogota` (C28) | `new Date().getDate()` |
| SQS bytes | `NotificationPublisher` + `pythonJsonDumps` (Phase 2) | a publisher |
| bounded retry | `NOTIFICATION_PUBLISH_RETRY` (C22) | a retry loop |

The only genuinely new primitive is `isSchedulerRepeat`, which sits beside the enum it narrows.

### 5.7 Every deviation was control-run, and the control was checked for **test count**

*"A control that does not compile is not a control"* — two Phase 5 attempts reported
`Tests: 0 total`. **One of the six controls below did exactly that on the first attempt** (the
UTC-extract mutation left `${zone}` unbound, a TS error) and was rewritten until it compiled.

| # | mutation | suite | result |
|---|---|---|---|
| 1 | `todayInBogota` → host-zone `getDate()` | unit | **34 total**, 1 failed ✅ |
| 2 | resolve executer *after* claim | unit | **34 total**, 1 failed ✅ |
| 3 | claim ignores its row count | unit | **34 total**, 1 failed ✅ |
| 4 | drop `release` on the error path | unit | **34 total**, 1 failed ✅ |
| 5 | `SCHEDULER_ENABLED` guard removed | unit | **34 total**, 1 failed ✅ |
| 6 | `relativedelta` → naive `Date.setUTCMonth` | unit | **34 total**, 4 failed ✅ |
| 7 | D7 `<=` → `=` | e2e | **29 total**, 3 failed ✅ |
| 8 | `AT TIME ZONE $zone` → `'UTC'` | e2e | first attempt **0 total** ❌ → rewritten, **29 total**, 1 failed ✅ |
| 9 | claim drops `AND processed = false` | e2e | **29 total**, 3 failed ✅ |

Every mutation was restored and the restore verified with `diff -q` against a pre-mutation copy,
not by re-reading the file.

---

## 6. For `manual-tester`

### 6.1 ⚠️ Data safety — this phase *executes*, so read this before the first cell

This is the first phase whose subject **sends mail and publishes to SQS as a side effect of
being tested**, and whose table is the one the project has already damaged once.

1. **`pg_dump` every table to a NEW timestamped directory under `~/.fondo-parity-dumps/`
   before the first write cell.** Mine is
   `~/.fondo-parity-dumps/20260907T055041-phase-7b-start/`; take your own, do not reuse it.
   Never `/tmp` (tmpfs, destroyed on reboot). Restore only via `pg_restore`.
2. ⚠️ **`fondo_api_schedulertask` holds 626 rows and is no longer a faithful production
   snapshot** — six rows were destroyed in the Phase 3 round and could not be recovered
   (§7 of the plan). Treat it as precious.
3. ⚠️ **Never point a runner at `fondodev` with real SES/SQS credentials.** Start v2 only from
   `~/.fondo-parity-harness/p7b/start-v2.sh`, which pins `AWS_ENDPOINT_URL_SQS` at the capture
   stub, and **assert the stub is up before every cell** (`assert_capture_up()`). A stub that is
   down turns "no message captured" into a green cell for the wrong reason.
4. ⚠️ **`SCHEDULER_ENABLED` is unset in that start script on purpose.** Drive the runner
   *explicitly* per cell rather than waiting for 10:00 or 14:00 — the cron would otherwise fire
   mid-round against whatever the fixture happened to be. If you do enable it, restore from the
   dump afterwards regardless of what you think happened.
5. **v1's beat and the v2 runner must never be up at the same time** against `fondodev`
   (plan §4 rule 6). One at a time.

### 6.2 Expected diffs against v1 — read these as **expected**, not as findings

| # | probe | v1 | v2 | why |
|---|---|---|---|---|
| 1 | a task whose `run_date` is in the past, `processed = false` | never runs | **runs on the next pass** | **D7** (Q8) |
| 2 | the first run against the real fixture | 1 message | **~108 messages** | **P7-D1** — do not run this against `fondodev` without draining first |
| 3 | task with `repeat = 7` | clones onto the same date — **twice, on that date's two passes, then never again** (measured; the `=` day rule stops it) | logs and clones nothing | **P7-D3**. ⚠️ Under **D7**'s `<=` the same clone would be due on every later pass, so the loop v2 refuses is one *v2* would create, not one v1 has |
| 4 | `payload->'message'` is SQL NULL | publishes `"body": null` | logs `TypeError`, row unprocessed | **P7-D4** |
| 5 | SQS refuses the message | row processed, log line | row processed, log line **+ a WARN naming the task** | **P7-D5**, §3 |
| 6 | two runners, one task | two pushes, two clones | one push, one clone | §1 |
| 6a | a payload key is **absent** | `exception: 'message'` | `exception: KeyError: 'message'` | **P7-D6** — log text only; the row, the wire and the retry are identical |
| 7 | the process log | one info line per pass | same two info lines, verbatim | — |

### 6.3 Explicitly **unchanged** — if these differ, that IS a failure

* the SQS `MessageBody`, **byte for byte**, including CPython's `', '` / `': '` separators and
  `\uXXXX` escapes for every accented character (plan §4 rule 5d);
* the clone's `payload::text`, `type`, `repeat` and `processed = false`;
* the clone's `run_date`, including the month-end clamp and the lost leap day;
* `run_date` stored as `05:00Z` for a local-midnight task;
* the two info log lines: `Running scheduler` and `{n} tasks to process`;
* the error line: `Error processing task with id: {id}, exception: {ex}` — the **format**;
  ⚠️ the substituted `{ex}` differs for an absent payload key (`KeyError: 'x'` vs `'x'`),
  which is **P7-D6** and expected;
* `Executer type {n} does not exist.` for an unknown type;
* a member with **no** subscription rows receives nothing and the task is still marked
  processed (Phase 2 condition 4 / **Q7**).

### 6.4 Pre-declared rows — do not re-file these

**P7-D1**–**P7-D6** above, and **D7** in the plan's §5.

---

## 7. To fold back into `MIGRATION_PLAN.md`

### 7.1 §3's Phase 7 *Scope* says "`@nestjs/schedule` (or BullMQ …) — decide in this phase"

Decided: `@nestjs/schedule` + `SCHEDULER_ENABLED` + the atomic claim. §1 has the reasoning; the
plan's bullet should record the outcome so Phase 9's decommission step knows Redis has no
remaining consumer.

### 7.2 §3's Phase 7 *Risks* lists the multi-instance problem but not the **zero**-instance one

"Multi-instance v2 needs a lock or an atomic claim, or tasks run N times" is there. The mirror
case — **nobody** has the flag, nothing errors, and reminders stop — is not, and it is the more
likely cutover mistake because it is the default. §5.4 gives the check.

### 7.3 §5's **D7** row understates its blast radius

The row reads *"Send immediately on the next scheduler run instead of skipping"*. On the real
fixture that is 110 rows and 108 messages on the first run, 65 of them for loans already paid
off. **P7-D1** is the finding; D7's row should carry a pointer to it, and the drain statement
belongs in Phase 9's cutover runbook between "deploy v2" and "enable the scheduler".

### 7.4 Phase 6's D12 inherits a constraint from §4's P7-D2

D12's CAP auto-close introduces a **second** `SchedulerTask.type`. Two things follow, and both
are cheap now and expensive later: the new type must be added to `ExecuterFactory`, and any
rolling deploy must not let an old replica see the new type — which the resolve-before-claim
ordering already handles, but only because it is ordered that way on purpose.

### 7.5 A note for Phase 9

`create_repeat_instance` writes `payload::hstore` from the source row's text. When Phase 9
converts the column to `jsonb`, that one cast is the only line in the runner that changes.
