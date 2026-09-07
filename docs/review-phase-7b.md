# Review — Phase 7b (Scheduler runner)

**Verdict: APPROVED WITH CONDITIONS — C68–C76.** The port is correct on every observable this
migration is allowed to care about, the two open decisions were settled well, and the mid-phase
rewrite of P7-D3 is right. What is conditioned is **not** the port: it is (a) three places where
the phase's own anti-silence stance is not carried into production, (b) two business consequences
of **D7** and of Q34's drain that measurement turns up and no register row covers, and (c) one
paragraph that must be written before Phase 6 builds on this runner.

| | |
|---|---|
| Subject | `feat/phase-7b-scheduler` @ **`fb4b194`** (`git rev-parse HEAD` confirmed, tree clean) |
| Read | `docs/parity-phase-7b.md`, `docs/phase-7b-deviations.md` (§6 first), `MIGRATION_PLAN.md` §3/§5 D7/§7/§9 Q34, v1 `fondo_api/scheduler/tasks.py`, `fondo_api/celery/tasks.py`, `fondo_api/services/notification.py`, `fondo_api/services/user.py`, `fondo_api/services/loan.py` |
| Executed against `fondodev` | **nothing.** Two read-only `SELECT`s and `scripts/parity/fixture-check.sh`. No runner, no write, no rollback. |

---

## 0. What I re-measured myself, rather than reading

Rule **C67**: every one asserted by exit code or by a value, not by absence of output.

| check | result |
|---|---|
| `npm run lint` | exit **0** |
| `npm run typecheck` | exit **0** |
| `npm test` | exit **0** — **2173 passed / 67 suites** |
| `npm run test:e2e` | exit **0** — **1061 passed, 2 skipped / 20 suites** (19 passed, 1 skipped) |
| `fondodev` baseline | `schedulertask` **626**, `max(id)` **2528**, `xmin` cardinality **1**, `fondo_api_schedulertask_id_seq` **2528**, **20** sequences |
| P7-D6's supporting counts | **4** producers, **16** assertions, **8** spec files — *exact*, not approximate |
| `waitForCompletion` is a real option | yes — `@nestjs/schedule@12.0.1`, `cron.decorator.d.ts:28`; and the cell reads it off decorator metadata, not off a constant |
| a rejected cron handler crashes the process | **no** — `cron@4.4.0` `job.js:144` catches it (see **C68** for what it does instead) |

Everything the brief asserted is true at `fb4b194`.

---

## 1. The two open decisions — both settled correctly

### 1.1 `@nestjs/schedule` over BullMQ — **endorsed**

The reasoning is right, and its strongest leg is not the one stated first. "v1's guarantee is
topology" is true and sufficient on its own; the decisive argument is the second one — BullMQ
introduces **a second source of truth for what runs when** beside `fondo_api_schedulertask`, in
the one subsystem whose defining property is that it fails silently. A repeatable-job registry
that drifted from the table would be undetectable by exactly the same mechanism that made this
phase the highest-consequence one in the migration. Adding it to retire Redis would have been
self-defeating.

**The residual — two processes with the flag — is genuinely handled.** I checked the ordering
rather than the claim about it:

* `scheduler.runner.ts:168` resolves, `:170` claims, `:181` runs, `:199` clones.
  `scheduler-task.repository.ts:284-289` is `UPDATE … SET processed = true WHERE id = ? AND
  processed = false` and returns `updated === 1`. The loser skips at `:171-177`.
* Because the claim **precedes** the publish, a duplicate push is impossible, and because the
  clone is downstream of the claim, so is a duplicate clone. `test/scheduler-runner.e2e-spec.ts:517`
  forces the read/claim window open instead of racing for it and asserts
  `processed + processed === 1`, `cloned + cloned === 1`, `sqs.send` once — with a single-runner
  positive control at `:547`. This is the right shape of test for the claim.
* Resolve-before-claim is pinned by `scheduler.runner.spec.ts:205` and by parity cell **N2**, and
  control-run (deviations §5.7 mutation 2). Phase 6's D12 can lean on it.

**What the ordering costs, and it is correctly recorded:** claim-then-crash loses the
notification (row `processed`, nothing sent), where v1's mirror window re-sends. §1's "What is
*not* claimed" paragraph states this. But see **C69** — the window is wider than a hard kill —
and **C73**, because v2 has removed the one log line that would have evidenced it.

### 1.2 Outcome ported, silence dropped — **the right line**

Marking a failed publish `processed` and still cloning is correct and correctly argued: the
alternative retries a configuration error twice a day forever *and never clones the `repeat`
successor*, so a broken credential would break the whole birthday chain rather than one message.
Q6 decided it. Parity §5 confirms `ROWS: SAME`, `WIRE: SAME`.

**Does anything now depend on the return value that should not?** I checked every caller.
`NotificationService.sendNotification` is consumed by `NotificationExecuter.run`
(`notification.executer.ts:70-77`, the only branch on it) and by the HTTP paths, which ignore it.
The two moved assertions are genuinely subject-preserving — `toBe('failed')` fails on a rejection
exactly as `toBeUndefined()` did. **No, nothing improper depends on it.** The one caution is
forward-looking and is **C74**.

**But half the countermeasure does not reach production.** §3's table promises "a `WARN` naming
the task id and the outcome, **plus `failedDelivery` in the run summary**". The WARN is real
(`scheduler.runner.ts:193`). The summary is returned by `run()` and **discarded by `handleCron`**
(`:141`) — it exists only in the harness's stdout. See **C68**.

---

## 2. P7-D3, rewritten mid-phase — **the new text is right, and the guard is in the right place**

I checked the rewrite against v1's source rather than against the pass table.

`scheduler/tasks.py:31-48`: four `if`s, not `elif`s, no `else`. A `repeat` of 7 falls past all
four, `run_date` is unchanged, and `objects.create` writes a twin **on the same date**. v1's
selection is `run_date__year/month/day` — an exact calendar-day match — so the twin is selected by
that day's *second* pass and then never again. **Two extra rows, one extra push, then silence.**
The measured five-pass table matches what the source predicts. The original "forever" claim was
wrong and the correction is sound.

**And the second half is the part that matters.** Under **D7**'s `<=`, a past-due twin is due on
*every* later pass, so a runner that used `<=` *and* reproduced clone-onto-its-own-date would mint
a fresh permanently-due successor twice a day without end. That is not a v1 defect being narrowed;
it is a defect **our own selection rule would create**. Porting v1 faithfully here would have been
strictly worse than v1. The rewritten text says exactly that, and the sentence *"it is not
separable from D7 — relaxing one means revisiting the other"* is the correct standing instruction
for whoever finds the guard later.

**Placement.** The guard is the first statement of `createRepeatInstance`
(`scheduler.runner.ts:255-260`), i.e. *after* `claim`, *after* `run`, *after* the publish, and
inside the loop's `try`. That is the right place and not by accident:

* it throws into v1's own `except` branch, so the row stays `processed` and nothing is cloned —
  which is what v1's autocommit ordering produces for any clone-time failure;
* it does **not** release the claim (`:426` pins that, and v1 reaches `task.save()` before
  `create_repeat_instance`);
* the message is published first, so the wire is `SAME` (parity §8) — the refusal costs the clone,
  not the notification.

Putting it in `findDueUnprocessed` (refuse to load) or before the claim would have suppressed the
task's own legitimate push, which v1 does send. Correct as placed.

---

## 3. `relativedelta` — **the port is exercised on the runner's paths, not only in its own spec**

This was the specific question, and the answer is yes.

* `scheduler.runner.spec.ts:366-384` drives **five** month-end cases *through `runner.run()`* with
  the real `nextRepeatRunDate` (only the repository is mocked): 31 Jan→28 Feb, 28 Feb→28 Mar (the
  clamp as the next input), 31 May→30 Jun, 29 Feb 2024 + 1 yr→28 Feb 2025, 31 Jan 2024→29 Feb 2024.
  Plus all four `repeat` values at `:347` and time-of-day preservation at `:386`.
* `test/scheduler-runner.e2e-spec.ts:423` runs the **MONTHLY chain collapse against the real
  database over two passes** — 31 Jan → 28 Feb → 28 Mar — and `:375` pins the YEARLY birthday clone
  with a byte-identical payload.
* Deviations §5.7 mutation 6 (`relativedelta` → naive `Date.setUTCMonth`) fails **4** unit cells at
  **34 total**, so the pinning is load-bearing and the control compiles.

The UTC-space choice in `addRelativeDeltaToInstant` (`relativedelta.util.ts:105-118`) is also
correct rather than convenient: Django under `USE_TZ` hands `create_repeat_instance` a **UTC-aware**
datetime and `relativedelta.__radd__` calls `other.replace(...)`, leaving `tzinfo` alone — so v1
does the arithmetic on UTC fields too, and v2 must. One uncovered corner: **C76**.

---

## 4. The timezone anchor — **the cells would fail under a UTC anchor; I re-derived them**

I did not take the tester's word. Both halves are separately pinned, and each has a control.

| | |
|---|---|
| the **question** | `todayInBogota(now, config.timeZone)` — `scheduler.runner.ts:154`. Pinned by `scheduler.runner.spec.ts:145`: `2026-09-07T02:30Z` is the **7th** in UTC and the **6th** in Bogota, and the cell asserts the repository is asked for `day: 6`. A host-zone or UTC read asks for the 7th and the cell fails. Control-run (§5.7 #1, 34 total / 1 failed). |
| the **comparison** | `(run_date AT TIME ZONE $zone)::date <= make_date(...)` — `scheduler-task.repository.ts:252`. Pinned by `test/scheduler-runner.e2e-spec.ts:210`: `run_date` `2026-09-08T01:00Z` (= 20:00 Bogota on the 7th), asked for the 7th, must be due. Under `AT TIME ZONE 'UTC'` it reads as the 8th and the cell fails. Control-run (§5.7 #8, and this is the control that first reported `Tests: 0 total` and was rewritten until it compiled). |

The manual cells check out on the arithmetic:

* **TZ2** — 2026-09-09 20:00 Bogota is stored `2026-09-10T01:00Z`; evaluated at `2026-09-09T20:00Z`
  (15:00 Bogota) the Bogota extract gives 09-09 ≤ 09-09 → **due**. A UTC extract gives 09-10 ≤ 09-09
  → **0 due**. Discriminates. ✅
* **TZ4** — 2026-09-10 23:30 Bogota is `2026-09-11T04:30Z`; evaluated at `2026-09-10T15:00Z` the
  Bogota extract gives 09-10 ≤ 09-10 → **due**; UTC gives 09-11 → **0 due**. Discriminates. ✅
* **TZ1** genuinely does not discriminate, and the report says so rather than counting it as
  evidence. That is the correct handling and it is worth more than the two cells that do.

The shape is right and the claim survives derivation. One honest strengthening the report
under-claims: **TZ3** (eve-of-N, must *not* fire) would discriminate against a *both-halves* UTC
port — the naive one, where the helper is dropped entirely — even though it does not discriminate
against an extract-only mutation. The evidence is slightly better than stated.

---

## 5. P7-D6 — **register, do not match. Endorsed.**

The measurement is right: `'{}'.format(ex)` is `str(ex)`, and `str(KeyError('message'))` is
`"'message'"` — the quotes are the key's repr and there is **no `KeyError:` prefix**.

The decision to register rather than match is correct, and its supporting counts are **exactly**
what the document claims — I verified them rather than accepting them: four producers
(`hstore.codec.ts:362`, `python-obj.ts:35`, `notification.service.ts:241`,
`notification.executer.ts:80`) and **16** assertions across **8** spec files. Matching would either
fork the convention (two things said about one ported exception) or propagate a change across four
producers and sixteen cells to buy parity on a string that, everywhere else, v1 renders into a
body-less 500 no client reads.

The weakest leg of the argument is the one that applies *here*: the scheduler log is the one place
where v1's `KeyError` text is genuinely the observable, so "no parity to gain" is least true in
this phase. But the ledger still comes out the same way — rows, wire, `processed`, the retry and
the pinned line **format** are all identical, and stripping the prefix leaves `exception: 'message'`,
a bare quoted word naming nothing, which is adding silence in a phase whose thesis is that silence
is the defect. **Keep v2's text.** The reversal instructions in §4 are precise enough to act on if
a future reviewer disagrees, which is the right way to leave it.

---

## 6. F2 — **yes, it needs a row; and I would rather it were ported.** See **C73**

`fondo_api/celery/tasks.py:15` logs `Sending request to MNS...` on every publish. v2 has no
counterpart and no register row (`grep` across `docs/` and the plan returns only the tester's own
finding). Registers are load-bearing in this project, so an unregistered observable difference is a
defect in the register even when it is cosmetic in the code.

But it is not quite cosmetic, and the reason is this phase's own §1. That line is the **only line
v1 emits *before* the SQS call**. v2's publish logs `Message sent, id: …` on success and `Error
trying to connect to MNS service: …` on final failure — both *after* the outcome is known. So the
one window §1 declares unrecoverable and refuses to fix — *claimed, then hard-killed before the
publish* — leaves a trace in v1's log and **no trace at all** in v2's. The row would read
`processed = true` and nothing anywhere would say an attempt was made.

That converts a cosmetic omission into the removal of the only evidence for the failure mode the
phase explicitly accepts. Port it: one `this.logger.log('Sending request to MNS...')` as the first
statement of `NotificationPublisher.publish`, which also matches v1's ordering (v1 logs it before
the `queue_url` lookup and before `json.dumps`, so it precedes v2's `NOTIFICATIONS_QUEUE_URL is not
configured` branch too).

---

## 7. Findings

### C68 — **major** — the run summary never reaches a log, and the runbook check cannot tell a completed pass from a dead one

*Location:* `src/scheduler/scheduler.runner.ts:137-142`, `:212`; `docs/phase-7b-deviations.md` §3
and §5.4; `MIGRATION_PLAN.md` §3 Phase 7 *Risks*.

*What must hold:* §3's table sells the anti-silence decision as "a `WARN` naming the task id and the
outcome, **plus `failedDelivery` in the run summary**", and §5.4 sells `grep -c 'Running scheduler'`
= 2 as the operator check for the zero-instance failure. Neither second half is true of the shipped
process.

1. `handleCron` does `await this.run();` and **discards** the returned `SchedulerRunSummary`.
   `{loaded, processed, failedDelivery, skippedClaimed, errored, cloned}` appears in the tester's
   report only because `run-v2.js` prints the return value. In production it is unobservable.
2. A **whole-pass** failure — `findDueUnprocessed` throwing because the database is unreachable is
   the obvious one — produces `Running scheduler`, then a rejected promise. `cron@4.4.0`
   (`dist/job.js:144`) catches it and, because `@nestjs/schedule`'s orchestrator passes **no**
   `errorHandler` (`dist/scheduler.orchestrator.js:54`), prints `[Cron] error in callback` through
   `console.error` — outside Nest's `Logger`, without the `fondo_api.scheduler.tasks` context, and
   in none of the formats this phase spent its effort pinning.
3. Consequently `grep -c 'Running scheduler'` returns **2** whether the pass processed 110 rows or
   died one statement later. That is rule **C67** — *what would this check print if the thing it
   looks for were present?* — failing on the phase's own recommended check, in the subsystem the
   rule was written for.

*Why it matters:* this phase exists because v1 records failure as success. Two of the three
countermeasures it claims are, in production, a discarded return value and a check that cannot
discriminate.

*Fix:* log the summary at the end of `handleCron` (one line, e.g. `Scheduler pass complete:
loaded=… processed=… failedDelivery=… skippedClaimed=… errored=… cloned=…`), and wrap `this.run()`
in a `try/catch` that logs through the runner's `Logger` at `error`. Then change §5.4 and the plan's
*Risks* bullet to count the **completion** line, not `Running scheduler` — a completion line is a
positive check that a pass both started and finished.

### C69 — **major** — a failed `release()` swallows the executer's error and silently keeps the row `processed`

*Location:* `src/scheduler/scheduler.runner.ts:179-187`.

```ts
try {
  outcome = await executer.run(task.payload);
} catch (error) {
  await this.tasks.release(task.id);   // if THIS rejects, `throw error` is never reached
  throw error;
}
```

*What must hold:* v1 never reaches `task.save()` on this path, so the row stays unprocessed and the
log names **the executer's** exception. P7-D2 is explicit that `release` exists to restore exactly
that end state.

*Why it matters:* if `release` rejects — a transient connection loss, a pool timeout, anything that
also plausibly caused the executer to fail in the first place — the original error is destroyed, the
outer `catch` logs the *release* failure under the task's id, and the row is left `processed = true`
with nothing delivered. That is a lost notification reported as a database error, which is a
strictly worse silent failure than the one this phase was convened to remove, and it is reachable
without a hard kill. §1's "What is *not* claimed" paragraph covers only the hard-kill case.

*Fix:* `try { await this.tasks.release(task.id); } catch (releaseError) { this.logger.error(\`Failed
to release the claim on task ${task.id}; it stays processed and will not be retried\`, …); } throw
error;` — the original error always propagates, and the release failure gets its own line naming the
consequence.

### C70 — **major** — `SCHEDULER_ENABLED` fails closed on a typo, which is the failure mode this phase names as the most likely cutover mistake

*Location:* `src/config/env.schema.ts` (`SCHEDULER_ENABLED` transform); `src/config/env.validation.spec.ts`
(the `'maybe'`, `'enabled'` → `false` cells); `docs/phase-7b-deviations.md` §5.4, §7.2.

*What must hold:* §7.2 correctly identifies that the plan's *Risks* lists the multi-instance problem
but not the **zero**-instance one, *"and it is the more likely cutover mistake because it is the
default"*.

*Why it matters:* the schema accepts `true/1/yes/on` and maps **everything else** — including
`ture`, `TRUE!`, `enabled` — to `false`. So the single most likely operator error at cutover
(mistyping the one variable that turns the fund's only reminder path on) produces a process that
boots cleanly, logs nothing about the scheduler at any point, and never sends anything. The only
defence is a log-grep that will not run until 10:00 the next day — and per **C68** it cannot
discriminate anyway. Nothing is gained by leniency here: this is a deployment role, not user input,
and the fail-closed argument only protects against a *false positive*, which an accept-list also
prevents.

*Fix:* accept an explicit list in both directions (`true/1/yes/on` and `false/0/no/off/''`) and make
anything else a **boot failure** — a fail-fast the operator sees in the deploy log, which cannot
cause an accidental publish because the process does not start. And log the role once at bootstrap
(`Scheduler: ENABLED on this process` / `Scheduler: disabled on this process`), so the flag is
verifiable at deploy time instead of up to 24 hours later. Update the spec's `'maybe'` / `'enabled'`
cells to assert the throw.

### C71 — **major** — D7 has a forward-going birthday consequence that no register row covers, and the drain does not fix it → `business-analyst`

*Location:* `docs/phase-7b-deviations.md` §4 P7-D1; `MIGRATION_PLAN.md` §9 **Q34**; v1
`fondo_api/services/user.py:267-282`; v2 `src/users/user.service.ts:782`, `:1287`.

*What must hold:* P7-D1 is framed as a **backlog** problem, and Q34 answers it with a one-off drain.
Q34's answer states the standing rule as *"a task that becomes past due **after** cutover is still
sent rather than skipped"*.

*Why it matters:* birthday tasks are not "become past due" — a share of them are **created past
due**, permanently and recurrently. `__create_birthdate_notification` does
`birthdate.replace(year=today_year)`, so any member whose birthdate is set or edited *after* their
birthday in the current year gets a `SchedulerTask` dated in the past at the moment it is written
(v2 reproduces this faithfully, D19 clamp included). In v1 it never fires and never clones — that
member is simply never greeted. Under D7 it fires on the very next pass, pushing *"Hoy está
cumpliendo años <name>"* to the entire roster **on the wrong day**, and only then settles onto the
correct anniversary. Q34's drain is a one-off and does nothing about it; every future personal edit
can produce another.

P7-D1's "second, smaller face" paragraph covers the T−5d/T−1d loan pair but not this, and this one
is worse per occurrence, because the message asserts something about *today* while a payment
reminder merely arrives late.

*Fix:* register it as a **P7-D row of its own** and put the question to `business-analyst`: is an
out-of-season fund-wide birthday push acceptable as the price of D7, or should
`__create_birthdate_notification` schedule the **next future** anniversary when this year's has
passed? The second is a Phase 3 code change and a genuine deviation from v1, so it is not mine to
choose. This is fund policy; it does not block Phase 6.

### C72 — **major** — runbook step 3a terminates a live yearly birthday chain, which is the exact harm its two-day grace was written to prevent → `business-analyst`

*Location:* `MIGRATION_PLAN.md` §3 Phase 9 step **3a**; §9 **Q34**; `docs/parity-phase-7b.md` §9.

*What must hold:* Q34 justifies the `- interval '2 days'` grace precisely so that today's birthday
task is spared — *"draining those two would mean the member whose birthday it is is simply never
greeted"*. Right instinct.

*Measured on `fondodev` today, read-only, by me:*

```
due under D7 (<= today, Bogota):   110   =  108 payment_reminder  +  2 birthdate
drained by step 3a:                108
  of which birthdate:                1   →  id 1497, owner_id 3, run_date 2024-03-02, repeat 4
survivors:                           2   →  id 2021 (today's birthday), id 2441 (yesterday's reminder)
```

*Why it matters:* step 3a marks id **1497** `processed = true` **without writing a clone** — the
drain is a bare `UPDATE`, not a runner pass, so `create_repeat_instance` never fires. That member's
yearly chain ends permanently; they are never greeted again unless someone edits their birthdate.
The grace window catches the birthday that is due *today* and misses the one that has been stuck
since **2024-03-02**. It is not a regression against v1 (that chain is already dead there), but
cutover is the one moment it can be repaired for free, and the runbook instead makes it permanent
while the answer text says the opposite is intended.

*Fix, one of:* (a) exclude `payload -> 'type' = 'birthdate'` from step 3a and add a **step 3b** that
advances past-due unprocessed birthday tasks to their next future anniversary at local midnight —
one row today, and it self-heals the chain with no wrong-day push; or (b) exclude them from the
drain entirely and accept one out-of-season greeting, which also re-establishes the chain. (a) is
better and interacts with **C71**: answer them together.

### C73 — **minor** — F2: register or port `Sending request to MNS...`

*Location:* v1 `fondo_api/celery/tasks.py:15`; v2 `src/notifications/notification-publisher.ts`
(`publish`); `docs/phase-2-deviations.md` (where the row belongs).

Reasoning in §6 above. **Preference: port it** — one line at the top of `publish()`, matching v1's
position before the queue-URL lookup. It restores parity *and* gives the claim→publish window the
only log evidence it can have, which §1 currently has none of. If the decision is to register
instead, the row goes in `docs/phase-2-deviations.md` (Phase 2 is where the omission originates),
gets a pointer from `docs/phase-7b-deviations.md` §6.2, and §1's "What is *not* claimed" paragraph
must be amended to say that in v2 the lost-notification window leaves **no trace at all**.

### C74 — **minor in effort, gates Phase 6's start** — write down what D12 inherits, before D12 exists

*Location:* `src/scheduler/executers/scheduler-executer.ts` (`SchedulerExecuterOutcome` docblock);
`MIGRATION_PLAN.md` §7.4 / Phase 6 *Risks*.

§7.4 already records the two cheap-now/expensive-later items (register the new type in
`ExecuterFactory`; the resolve-before-claim ordering protects a rolling deploy). Both are right. Two
more are missing, and they are the ones a Phase 6 developer will get wrong by reading the interface
in good faith:

1. **`ok: false` is the wrong channel for a CAP auto-close failure.** The runner gives an executer
   exactly two ways to report trouble: **throw** (→ `release` → row unprocessed → retried on the
   next pass) or **return `ok: false`** (→ row `processed`, one WARN, never retried). The second was
   decided by **Q6** for a *lost push*, where losing one message beats breaking the `repeat` chain.
   For a CAP that failed to close, "task processed, CAP still open, one WARN in the log" is a
   financial-state divergence that no later pass will repair. `SchedulerExecuterOutcome`'s docblock
   currently presents `ok: false` as the ordinary way to report failure, which invites exactly the
   wrong choice. **D12's executer must throw.**
2. **The claim-then-crash window loses executer work silently** (§1). For a notification that is one
   missed push. For a CAP close it is a CAP that stays open with its task marked done. D12's design
   must therefore be idempotent and independently reconcilable — e.g. the close is also derivable
   from `end_date` on read, or a reconciliation query exists — rather than assuming the runner
   guarantees the side effect happened.

*Why this gates Phase 6's start rather than its gate:* it is a paragraph now and a rewrite of a
financial code path later, which is §7.4's own stated standard for what belongs there.

### C75 — **minor** — two unregistered log-stream differences

*Location:* `src/scheduler/scheduler.runner.ts:205-208`; `docs/phase-7b-deviations.md` §6.3.

§6.3 pins the error line as matching v1 in **format**, with P7-D6 as the one flagged exception. Two
more differences exist and are unregistered: v2 passes `error.stack` as `Logger.error`'s second
argument, so every caught error emits a **stack block** v1 never prints; and the two new WARN lines
(`skippedClaimed`, `failedDelivery`) have no v1 counterpart. The WARNs are covered by §1/§3 in
substance; the stack is covered nowhere. Both are additive, both are improvements, and neither
touches a row or a byte — but the value of the register is that it is complete. Add one row saying
"v2's error line carries a stack trace; v1's does not".

### C76 — **nit, rolls to Phase 6's gate** — no cell pins the UTC-space clone at a date where the Bogota day and the UTC day differ

*Location:* `src/scheduler/scheduler.runner.spec.ts:366-396`; `test/scheduler-runner.e2e-spec.ts:423`;
`src/common/utils/relativedelta.util.ts:105`.

Every clone cell — unit and e2e, and every ME cell in the parity round — uses a `run_date` of
`05:00Z`, where the Bogota date and the UTC date are the same. So nothing distinguishes v1's
**UTC-field** arithmetic from a Bogota-local implementation, and a future "fix" to local-space would
pass the whole suite.

Suggested cell: `run_date = 2026-01-31T01:00:00.000Z` (= **2026-01-30 20:00** Bogota), `repeat = 3`.
UTC-space, which is v1: `2026-02-28T01:00:00.000Z`. Bogota-local: Jan 30 + 1 month = Feb 28 20:00
local = `2026-03-01T01:00:00.000Z`. **One day apart** — the cell discriminates.

Nit rather than minor only because it is unreachable from either writer today: both
`__create_scheduled_task` (`services/loan.py:298-315`, `datetime(y, m, d)`) and
`__create_birthdate_notification` write local midnight, and reminders carry `repeat = 0` so they
never clone at all — the same unreachability argument P7-D4 rests on. But §5.3 makes precisely this
"immune to a future change" argument for the payload text, and the same standard applies here.

### Not filed

* **Two reminders for one loan firing in a single pass** (P7-D1's second face) has no dedicated
  cell; S1 exercises it only incidentally, and with dates shifted so v1 does it too. Registered
  behaviour, low stakes, no action.
* **A task targeting a soft-deleted member still publishes.** v1's
  `filter(user_id__in=user_ids)` has no `is_active` check and neither does
  `findPushSubscriptionsByUserIds` (`notification-subscription.repository.ts:173-177`). Parity by
  construction; no cell, no need.
* **`repeat` cloning freezes `user_ids` permanently** — a birthday task written in 2020 still
  notifies the 2020 roster, because the clone copies `payload::text` verbatim and the list is only
  refreshed when someone edits their birthdate. This is v1's behaviour exactly and §5.3's decision
  is right; noting it because it is the kind of business fact `CONTEXT.md` should carry, not because
  anything here should change.
* **`describe(error)` is duplicated** in `scheduler.runner.ts:276` and `notification-publisher.ts`.
  Cosmetic.

---

## 8. Quality, briefly

TS strict passes with `tsc --noEmit` at exit 0; DI is constructor-only throughout; configuration
comes from `AppConfigService`, never `process.env`; no ORM access outside repositories and no
controllers involved (this phase adds **no route**, correctly, so `docs/adding-a-route.md` does not
apply); Prisma is the ORM of record and the two raw-SQL hstore sites remain two, with the four new
methods added to 7a's repository rather than a third one (plan §2). No transaction is introduced,
matching v1, which has none here. `findDueUnprocessed` is one query and the per-task subscription
read mirrors v1's own per-task query, so there is no new N+1. `SchedulerRunnerModule` as a second
module is justified and correct — putting the runner on `SchedulerModule` would need a `forwardRef`,
and the split matches v1's own import direction.

Two things I want to record as *good*, because they are the reason this review is short on
substantive defects: `isSchedulerRepeat`'s `Number.isInteger` guard found a real hole (a numeric TS
enum's reverse mapping made `'MONTHLY'` a valid repeat) in code an hour old, and the sequence-drift
self-catch in §5.7 — a rolled-back probe leaving `..._id_seq` at 2529 while counts, `max(id)` and
`xmin` were all at baseline — is false-green #22 caught from the inside by the phase's own author.
`scripts/parity/fixture-check.sh` landing in the repo, with its positive control documented at the
top and the control chosen so it does not write, is the right response to a recurring class.

---

## 9. Phase 6

**Sequencing.** The 2026-09-07 correction is right and is now consistent across §3 (*"run this
directly after Phase 4, before Phases 5/6"*), D12's row (*"so Phase 6 depends on Phase 7"*) and the
board (Phase 6 = "⬜ After 7b"). Phase 5 having run first was harmless. Nothing further to correct.

**Gates Phase 6's start:** **C74** only. One paragraph on `SchedulerExecuterOutcome` and one in
§7.4 / Phase 6 *Risks*.

**Rolls to Phase 6's gate:** C68, C69, C70, C73, C75 (all shippable now, all log/config only —
see below), C76, and the `business-analyst` answers to **C71** and **C72** folded back into P7-D1,
Q34 and the Phase 9 runbook.

**No re-round is required.** Every conditioned change is a log line, an environment-schema
validation, an error-propagation order, a register row, a runbook statement or one extra test cell.
**None of them changes a database row, an SQS byte, a status code or a response body**, so the
parity round at `3659eef`/`fb4b194` stands and `manual-tester` does not need to be re-run. The
developer should re-assert the gate by exit code after the changes and confirm the two moved
assertion counts.

**Assumptions D12 would otherwise inherit unexamined:** the two in **C74** (`ok: false` means
"processed anyway", and the runner does not guarantee the side effect happened), plus the two §7.4
already names. Also worth stating in Phase 6's brief: `SCHEDULER_ENABLED` is a **role** flag, so
D12's auto-close inherits the zero-instance failure mode wholesale — if nobody has the flag, CAPs
silently stop closing exactly as reminders silently stop sending, and **C68**/**C70** are the
detection story for both.

---

## Verdict

### APPROVED WITH CONDITIONS — C68, C69, C70, C71, C72, C73, C74, C75, C76

The port is faithful, the two open decisions are settled correctly and for the right reasons, the
P7-D3 rewrite is a genuine correction that strengthens its own conclusion, the `relativedelta` port
is exercised where the runner actually goes, and the timezone anchor is pinned on both halves with
controls that discriminate. For a subsystem with **zero** inherited tests and 626 precious rows,
this is the standard the phase needed.

What is conditioned is the gap between what the phase says it built and what a production process
will actually emit — a discarded run summary, a runbook check that cannot fail, a release that eats
the error it was added to preserve, and a flag that fails closed on a typo — plus two business
consequences that measurement turns up and no register row covers.

**C74 before Phase 6 starts. The rest at Phase 6's gate. C71 and C72 to `business-analyst` now,
since their answers are cutover steps and cutover is Phase 9.**
