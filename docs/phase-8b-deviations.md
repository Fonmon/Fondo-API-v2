# Phase 8b — birthday notifications: decisions, re-pins and mutation controls

Companion to `MIGRATION_PLAN.md` §3 *Phase 8b* and §5 **D39**, **D48**, **D49**, and condition
**C71**. Branch `feat/phase-8b-birthdays`, from `feat/phase-8-files` at `11b8c5a`.

Audience: `business-analyst` (§2, §6), `nestjs-reviewer` (§2–§5), `manual-tester` (§4 —
expected diffs against v1). `MIGRATION_PLAN.md` is not edited by this phase; §7 lists what to fold
back.

**Scope shipped**

| Area | Units |
|---|---|
| D48 / C71 | `nextBirthdayRunDate` and `birthdayInYear` (`src/users/birthday-run-date.ts`, a module with no Nest or Prisma import, re-exported from `user.service.ts`), called from `createBirthdateNotification`; `Clock` / `SystemClock` / `ClockModule` (`src/common/clock/clock.ts`); `SCHEDULER_PASS_HOURS` / `LAST_SCHEDULER_PASS_HOUR` (`src/scheduler/scheduler-passes.ts`) |
| D39, D49 | `NotificationExecuter.run` (`src/scheduler/executers/notification.executer.ts`); `MemberDirectory` (`src/scheduler/member-directory.ts`) |
| Shared query | `findActiveMemberIds` (`src/users/active-members.query.ts`), used by `UserService.getUserIds` and `MemberDirectory.activeMemberIdsExcept` |
| Runner | **unchanged** (`src/scheduler/scheduler.runner.ts` has no diff). D39's skip is an executer *return*, which the runner already marks processed and clones |

**Gate numbers**: by each step's own exit code. The baseline was re-measured at `11b8c5a` in a
detached worktree in this session, not copied.

| step | pass condition | baseline (`11b8c5a`, worktree) | this commit |
|---|---|---|---|
| `npm run lint` | exit 0 | exit 0 | **exit 0** |
| `npx tsc --noEmit` | exit 0 | exit 0 | **exit 0** |
| `npm test` | exit 0 | exit 0: 2513 tests / 77 suites (2513 passed, 0 failed) | **exit 0: 2573 tests / 79 suites (2573 passed, 0 failed)** |
| `npm run test:e2e` | exit 0 | exit 0: 1331 passed + 2 skipped (0 failed); 22 suites passed + 1 skipped of 23 | **exit 0: 1345 passed + 2 skipped (0 failed); 22 suites passed + 1 skipped of 23** |
| `fixture-check.sh \| diff - ~/.fondo-parity-harness/p8/out/BASELINE-fondodev-2026-09-12.txt` | exit 0 | exit 0 | **exit 0** |
| control: `DB=fondo_api_test fixture-check.sh \| diff -q - …` | exit 1 | exit 1 | **exit 1** |

Per-suite test counts come from each run's own `--json` output. Only suites whose count changed are listed, and the sums over every suite reproduce both totals (checked by `fill-doc.js`, which refuses to render otherwise). Which cells account for each Δ is listed under the tables.

| unit suite | baseline | after | Δ |
|---|---|---|---|
| `src/scheduler/executers/notification.executer.spec.ts` | 12 | **36** | +24 |
| `src/scheduler/member-directory.spec.ts` | — | **7** | +7 |
| `src/scheduler/scheduler.runner.spec.ts` | 50 | **51** | +1 |
| `src/users/birthday-run-date.host-zone.spec.ts` | — | **3** | +3 |
| `src/users/user.service.spec.ts` | 35 | **60** | +25 |
| **unit total (sum of every suite, including unchanged ones)** | **2513** | **2573** | **+60** |

| e2e suite | baseline | after | Δ |
|---|---|---|---|
| `test/scheduler-runner.e2e-spec.ts` | 29 | **37** | +8 |
| `test/user.e2e-spec.ts` | 158 | **164** | +6 |
| **e2e total (sum of every suite, including unchanged ones)** | **1333** | **1347** | **+14** |

**Unit: +60 tests and +2 suites, attributed to named cells.** Measured by diffing each suite's
`fullName` list between `gate-baseline/unit.json` and `gate-final/unit.json`. Suite paths are
normalised from `src/` onward, because the baseline ran in a worktree. Every other suite's cell
list is identical, name for name.

* **`src/scheduler/executers/notification.executer.spec.ts` +24** (24 new names, 0 removed)
  * D39, 7 cells: `sends nothing for an inactive owner, and returns rather than throws`;
    `sends nothing for an owner with no auth_user row, and reports it as ok = false (§2.2)`;
    `announces an active owner, reporting the delivery as before`;
    `does not apply to a payment reminder, whose owner_id is a loan id`; and
    `treats type … as not a birthday` × 3 (`null`, `"Birthdate"`, `"birthdate "`).
  * D49, 7 cells: `ignores the stored user_ids for the audience`;
    `asks for the active members except the owner named in the payload`;
    `sends to an empty list when the owner is the only active member`;
    `leaves a payment reminder’s recipients to the stored list`;
    `still json.loads the stored user_ids of a birthday, before any member read`;
    `still raises KeyError for a birthday with no user_ids, before any member read`; and
    `reads message and target before owner_id`.
  * `owner_id` parsing, 10 cells: `raises KeyError when it is absent …`;
    `raises TypeError when it is NULL`; `raises ValueError for …` × 6 (`""`, `"abc"`, `"-5"`,
    `"5.0"`, `" 5"`, `"５"`); `reads leading zeros as decimal`; and
    `maps an id beyond integer …`.
    ⚠️ **Label nit:** the `describe` said `(§2.4)`, but the section in this document is **§2.5**.
    Left as is in `5e3457a` to keep run 3's hashes; **renamed in the review fix round** (n1, §3).
  * One existing cell was **re-subjected, not added**: `json.loads-es user_ids …` (§3).
* **`src/scheduler/member-directory.spec.ts` +7, a new suite:** `ownerStatus maps …` × 3, and
  `activeMemberIdsExcept` × 4 (the owner removed in query order; `is_active` with no role filter
  and no `ORDER BY`; the list unchanged for an inactive owner; `goes through findActiveMemberIds`).
* **`src/scheduler/scheduler.runner.spec.ts` +1:** `the cron declaration agrees with
  SCHEDULER_PASS_HOURS, which D48 reads`.
* **`src/users/birthday-run-date.host-zone.spec.ts` +3, a new suite:** the Tokyo and Kiritimati
  31 December cells, and the Tokyo 1 January cell (M3, §5.3).
* **`src/users/user.service.spec.ts` +25** (26 new names, 1 removed):
  * `nextBirthdayRunDate — deviation D48`, 24 cells:
    * birthday today × 8: before 10:00, at 10:00, between passes, 13:59:59.999, 14:00:00.000,
      after 14:00, 23:59:59.999, 00:00;
    * yesterday × 2, tomorrow × 2;
    * 31 Dec → 1 Jan × 4;
    * 29 February × 6;
    * Q36 Ainhoa × 1;
    * explicit time zone × 1.
  * `getUserIds — … goes through findActiveMemberIds …`, 1 cell.
  * **One rename, counted as +1 and −1:** `schedules in 2025 at 2026-01-01T02:00Z — still 31
    December in Bogota` became `schedules 2026-11-07 at 2026-01-01T02:00Z — … (D48 re-pin)`
    (§3). It is the same cell, re-pinned, not a removal.


**E2E: +14 tests, 0 suites added.** Measured the same way from `gate-baseline/e2e.json` and
`gate-final/e2e.json`. The 2 skipped tests and the 1 skipped suite are unchanged, and every other
suite's cell list is identical, name for name.

* **`test/scheduler-runner.e2e-spec.ts` +8** (8 new names, 0 removed), all under
  `Phase 8b — a birthday task at send time (D39, D49)`:
  * `D39 — inactive owner: nothing sent, row processed, successor cloned with the same payload`
  * `D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action`
  * `D39 — active owner: announced, processed and cloned as before`
  * `D49 — a member who joined after the chain was written receives the greeting`
  * `D49 — a member who has left does not, although the stored list names them`
  * `D49 — the owner is excluded, even from a hand-written list that names them`
  * `D39/D49 do not touch a payment reminder: stored list, no activity filter, no owner check`
  * `§2.2 — owner with no auth_user row: nothing sent, processed, cloned, counted as failed`
  * One existing cell was **re-subjected, not added**:
    `a full pass › resolves user_ids to every subscribed device of every listed member` (§3).
* **`test/user.e2e-spec.ts` +6** (6 new names, 0 removed):
  * `D19 × D48: a 29 February birthdate keeps 29 February when the chosen year is a leap year`
  * `D48 — … birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today`
  * `D48 — … birthday today, saved at 14:00:00.000 Bogota: the last pass has started, so next year`
  * `D48 — … birthday yesterday: next year, never a past date`
  * `D48 — … Q36: saving a birthdate whose anniversary already passed writes next year’s run_date, with no manual insert`
  * `D48 — … Phase 8b end to end: the task PATCH writes is run on the birthday, to the members active then`
    (the runner e2e on `fondo_api_test`)
  * Two existing cells were **re-pinned, not added**, with the same names:
    `replaces the task when the birthdate changes, rather than accumulating`, and
    `D19: a 29 February birthdate saves, and schedules 28 February in a non-leap year` (§3).

### Gate for the review fix round (C87–C89)

Measured by each step's own exit code. The baseline was re-measured on `5e3457a` in a detached worktree in this session (HEAD `d48fdf3` differs from it only in `MIGRATION_PLAN.md` and two `docs/` files), not copied.

| step | pass condition | `5e3457a` | fix round |
|---|---|---|---|
| `npm run lint` | exit 0 | exit 0 | **exit 0** |
| `npx tsc --noEmit` | exit 0 | exit 0 | **exit 0** |
| `npm test` | exit 0 | exit 0: 2573 tests / 79 suites (2573 passed, 0 failed) | **exit 0: 2590 tests / 80 suites (2590 passed, 0 failed)** |
| `npm run test:e2e` | exit 0 | exit 0: 1345 passed + 2 skipped (0 failed); 22 suites passed + 1 skipped of 23 | **exit 0: 1348 passed + 2 skipped (0 failed); 22 suites passed + 1 skipped of 23** |
| `fixture-check.sh \| diff - …/BASELINE-fondodev-2026-09-12.txt` | exit 0 | exit 0 | **exit 0** |
| control: `DB=fondo_api_test fixture-check.sh \| diff -q - …` | exit 1 | exit 1 | **exit 1** |

| unit suite | `5e3457a` | fix round | Δ |
|---|---|---|---|
| `src/scheduler/executers/notification.executer.spec.ts` | 36 | **39** | +3 |
| `src/scheduler/zone-single-source.spec.ts` | — | **12** | +12 |
| `src/users/birthday-run-date.host-zone.spec.ts` | 3 | **5** | +2 |
| **unit total (sum of every suite)** | **2573** | **2590** | **+17** |

| e2e suite | `5e3457a` | fix round | Δ |
|---|---|---|---|
| `test/scheduler-runner.e2e-spec.ts` | 37 | **40** | +3 |
| **e2e total (sum of every suite)** | **1347** | **1350** | **+3** |

**Unit: +17 tests and +1 suite (2573 / 79 → 2590 / 80), attributed to named cells.** Measured by
diffing each suite's `fullName` list between `gate-5e3457a/unit.json` and `gate-fr/unit.json`, with
suite paths normalised from `src/` onward. Every suite not listed has an identical cell list, name
for name.

* **`src/scheduler/executers/notification.executer.spec.ts` +3** (13 names added, 10 removed):
  * **9 renames, counted as +9/−9 but the same cells:** the `describe` label `(§2.4)` → `(§2.5)`
    (review n1) renames `raises KeyError when it is absent …`, `raises TypeError when it is NULL`,
    `raises ValueError for …` × 6 and `reads leading zeros as decimal`.
  * **1 removed:** `maps an id beyond integer to one no row can have, rather than an out-of-range
    bind`. It certified the C88 defect (§3).
  * **4 added (C88):** `queries an owner_id of exactly 2147483647, the largest integer`, and
    `answers owner_id … as a missing owner with no query and no send (C88)` × 3 (`2147483648`,
    `99999999999`, 40 ones).
  * Net: 9 − 9 + 4 − 1 = **+3**.
* **`src/scheduler/scheduler.runner.spec.ts` 0** (1 added, 1 removed): **1 rename (C89)**,
  `honours a configured time zone other than the default` → `reads its zone from configuration,
  not from a constant of its own (C89)`, same body (§3).
* **`src/scheduler/zone-single-source.spec.ts` +12, a new suite (C89):**
  * `the environment cannot name another zone` × 8: `defaults TIME_ZONE to the constant …`,
    `accepts America/Bogota given explicitly`, and `refuses TIME_ZONE=… at boot` × 6 (`UTC`,
    `America/Lima`, `america/bogota`, `' America/Bogota'`, `Etc/GMT+5`, `''`).
  * `the three decisions use that one zone` × 4: `the cron fires in the configured zone`, and
    `at … D48 and the runner agree on which day is today` × 3 (09:00, 13:30, 21:30 Bogotá).
* **`src/users/birthday-run-date.host-zone.spec.ts` +2 (review n2):** `disagrees exactly for offsets
  above UTC+05:00, over every birthday, quarter-hour grid`, and `the model reproduces the Tokyo
  disagreement the child process measures`.

**E2E: +3 tests, 0 suites (1345 + 2 skipped → 1348 + 2 skipped; 22 + 1 of 23 suites both).** Measured
the same way. The 2 skipped tests and the 1 skipped suite are unchanged.

* **`test/scheduler-runner.e2e-spec.ts` +3 (C88)**, 3 added and 0 removed:
  `C88 — owner_id 99999999999: nothing sent, processed, cloned, counted as failed, not errored`,
  `C88 boundary — owner_id 2147483647 is a missing owner; queried: true`, and
  `C88 boundary — owner_id 2147483648 is a missing owner; queried: false`.

---

## 1. What v1 does, from source

* `services/user.py:267-282` `__create_birthdate_notification`: `replace(year=today_year)`,
  `user_ids = get_users_attr("id")` minus the owner, `remove_sch_notitfications("birthdate", id)`,
  `schedule_notification(<date>, payload, 4)`. Every personal PATCH carrying `birthdate` rebuilds
  it.
* `scheduler/executers/notification_executer.py`: `json.loads(payload["user_ids"])`, then
  `send_notification(user_ids, payload["message"], payload["target"], False)`. No read of
  `owner_id` and no read of `is_active`.
* `scheduler/tasks.py`: exact-day selection, `processed = True`, `create_repeat_instance`, which
  copies `payload` verbatim into next year's row.

---

## 2. Decisions registered in this phase

### 2.1 D48 — "a pass is still to run" means strictly before 14:00:00.000 Bogotá

| instant (Bogotá) | birthday today → `run_date` |
|---|---|
| 00:00:00.000 … 13:59:59.999 | today |
| **14:00:00.000** … 23:59:59.999 | next year's anniversary |

**Choice: `hour < 14`, i.e. strictly before 14:00:00.000.** At 14:00:00.000 the last pass has
been triggered (`0 10,14 * * *`, `America/Bogota`). Whether its read of `fondo_api_schedulertask`
has already happened can't be known from the saving request. So from that instant on, v2
doesn't promise a pass that is "still to run". Choosing `<=` (up to 14:59:59.999) would schedule
today for a whole hour in which the day's last read has almost certainly already happened. That
task would go out at 10:00 the next day saying *"hoy"*, which is the C71 failure the operator
decided against.

**The hour comes from the same `partsInZone(now, 'America/Bogota')` call as today's date.**
`partsInZone` has one-second resolution. The boundary instants are pinned in milliseconds, in both
unit and e2e:

* `2026-09-14T18:59:59.999Z` (13:59:59.999) → 2026-09-14
* `2026-09-14T19:00:00.000Z` (14:00:00.000) → 2027-09-14

**Where the pass hours come from.** They're read from `SCHEDULER_PASS_HOURS`, not from the cron
text. `scheduler.runner.spec.ts › agrees with SCHEDULER_PASS_HOURS, which D48 reads` fails if the
two diverge.

⚠️ **Residual 1, not decided by any rule on this side (for `business-analyst`, §6 Q-8b-1).** A
save that reads the clock before 14:00:00.000 but **commits** after the 14:00 pass has read its
rows isn't seen by that pass. D7's `<=` then sends it at 10:00 the next day, one day late,
saying *"hoy"*. The window is one PATCH transaction long; its duration was not measured. Closing
it would need a margin before 14:00 or a lock against the runner, and the operator's rule names
neither.

⚠️ **Residual 2, already in the plan's D48 row:** a scheduler outage spanning a birthday still
delivers the greeting late, saying *"hoy"*. It's unchanged by this phase.

**D19** applies to whichever year is chosen. Both candidates go through `birthdayInYear`, and the
comparison with today uses the clamped date. That's why a 29 Feb member on 28 Feb of a non-leap
year counts as *today*. It's pinned both ways, before and after 14:00. **D20** is unchanged
(`createBirthdateNotification`'s `indexOf`/`splice` guard has no diff).

**The clock is injected.** `UserService` takes a `Clock` (a `ClockModule` provider,
`SystemClock` → `nowInstant()`). Unit cells pass `{ now: () => <instant> }`, and
`test/user.e2e-spec.ts` overrides the provider with a mutable instant that `beforeEach` resets.
No host-zone read was added, and repo lint exits 0.

### 2.2 D39 — the owner row doesn't exist at all → skip, processed, cloned, **counted as a failed delivery**

| owner (`auth_user` by `owner_id`) | sent | outcome | row | successor |
|---|---|---|---|---|
| `is_active = true` | yes (D49 audience) | the delivery's, as before | processed | cloned |
| `is_active = false` | **no** | `{ ok: true, detail: 'owner-inactive' }` + one `LOG` line `Birthday of inactive member <id> not announced (D39).` | processed | cloned |
| **no row** | **no** | `{ ok: false, detail: 'owner-missing' }`, which gives the runner's existing `WARN` naming the task, counted in `failedDelivery` | processed | cloned |

**Choice for the missing owner: the same as inactive in effect (nothing sent, chain rolls), but
visible as an anomaly.** Considered:

* **throw** → the claim is released, the row stays unprocessed, it's retried twice a day forever,
  and **no successor is ever cloned** (`scheduler-executer.ts`, C77: `throw` is for `repeat = 0`).
  A birthday task is `repeat = 4`. Rejected.
* **send anyway** (v1's behaviour) → it announces a person who has no row. That's the harm D39
  exists to stop. Rejected.
* **skip silently (`ok: true`)** → equivalent in data, but v2's code has no path that hard-deletes
  a member. **Measured at the fix round, not asserted:** a grep of `src/` (specs excluded) for
  `authUser.delete(`, `authUser.deleteMany(`, `userProfile.delete(`, `userProfile.deleteMany(`,
  `DELETE FROM auth_user` and `DELETE FROM fondo_api_userprofile` finds **0** lines. The same
  pattern shape on `activity` / `activityUser` finds the **2** known hard deletes
  (`activity.service.ts:304-305`), so the grep can see a delete when there is one. The member
  writes it does find are the two `is_active: false` writes (`user.service.ts`, creation and soft
  delete). A row naming a missing owner therefore comes from a hand edit or a repair, which is
  exactly what an operator should see in the log. So it uses `ok: false`.
* An `owner_id` beyond `integer` (C88) takes this same row, `ok: false`, with no query (§2.5).

It's cloned rather than stopped because stopping would need a runner change for a row class no
code writes. The cost is one no-op row a year, and each year's pass logs a `WARN` about it.

**Why `auth_user` and not `fondo_api_userprofile`:** `is_active` lives on `auth_user` (Django
MTI), and v2's soft delete writes that column.

### 2.3 D49 — the stored `user_ids`: **still parsed and validated**, but no longer the audience

**Choice: yes, it's still parsed.** `decodeSchedulerPayload` still runs first for every type,
birthdays included. So v1's evaluation order and failures survive where they still apply:

| payload | v1 | v2 (birthday) |
|---|---|---|
| no `user_ids` key | `KeyError`, row unprocessed | same (C23), and no member read happens |
| `user_ids` NULL | `TypeError` | same |
| `user_ids` not JSON | `JSONDecodeError` | `SyntaxError`, row unprocessed, no member read |
| no `message` / no `target` | `KeyError` | same, and before `owner_id` is read |

**Reason:** a row v1 can't run should also be a row v2 won't run. That keeps a v1 rollback and
v2 in agreement about which rows are broken. Nothing new fails on a well-formed row.

The audience is `MemberDirectory.activeMemberIdsExcept(owner_id)`: every `auth_user.is_active`
member with a profile, in heap order, minus the owner. It's the same `findActiveMemberIds` query
that writes the stored list at creation, and two cells check that both callers use it
(`member-directory.spec.ts`, `user.service.spec.ts › getUserIds`).

### 2.4 D49 — the stored `user_ids`: **still written at creation**, unchanged

**Choice: yes (the operator's recommendation).** `createBirthdateNotification`'s payload has no
diff. The row v2 writes is byte-identical to v1's except for `run_date` (D48). If v2 is rolled
back to v1, every chain v2 wrote still runs under v1's executer, with v1's (stale) audience. No
migration, no hstore change, and no new rows to reconcile.

### 2.5 `owner_id` on a birthday task — how it is read (new; v1's executer never reads it)

| `owner_id` | v2 | why |
|---|---|---|
| absent | throw `KeyError: 'owner_id'` → row unprocessed, logged, retried | same channel as every other missing key (C23). Both writers always set it (`services/user.py:271`) |
| NULL | throw `TypeError` | P7-D4's rule for `message`/`target` |
| not ASCII decimal digits (`''`, `abc`, `-5`, `5.0`, `' 5'`, full-width `５`) | throw `ValueError: invalid owner_id …` | the column is text; guessing an id from it would pick someone's audience |
| digits beyond `integer` (above `2147483647`) | **no query**; answered as a missing owner (§2.2): `ok: false`, processed, cloned | no row can match. ⚠️ **Corrected in the review fix round (C88):** `5e3457a` passed `2147483648` to `findUnique`, and Prisma refuses that bind with P2020 (measured by `nestjs-reviewer` on `fondo_api_test`: `2147483647` → `null`, `2147483648` → P2020). The row threw instead of skipping. Pinned by `notification.executer.spec.ts › queries an owner_id of exactly 2147483647 …` / `answers owner_id … as a missing owner with no query and no send (C88)` and `scheduler-runner.e2e-spec.ts › C88 …` |

⚠️ **A throw stalls the chain; it does not end it (C87, corrected in the review fix round).** The
first version of this paragraph said a throw ends the chain. It does not. The runner releases the
claim (`scheduler.runner.ts`, the `release` in `run`), so the row stays unprocessed, clones nothing
on that pass, and D7's `<=` selects it again at **every** later pass. It is retried and logged
twice a day, and the yearly successor is cloned as soon as a pass gets through. That is the
intended loud failure for a row only a hand edit can produce, and it stays visible until someone
repairs it.

⚠️ **Repair note (`business-analyst`, Q-8b-2):** whoever repairs such a row must also move its
`run_date` to the member's **next** birthday (D48's rule). Otherwise D7's `<=` sends the repaired,
past-dated row on the very next pass, saying *"hoy"* on the wrong day.

**Measured on `fondodev`, read-only (`default_transaction_read_only = on`), 2026-09-14:** of 86
`type = 'birthdate'` rows, **0** lack an `owner_id` key and **0** hold a non-decimal one. Of the
**14** pending, **0** name an owner with no `auth_user` row, and **2** name an inactive owner:
task **1497** (owner 3, `run_date` 2024-03-02 Bogotá) and task **2142** (owner 15, 2026-11-14).
Those are the two rows plan runbook steps 3a / 3a-bis already clear. Under this phase's code, both
would send nothing, be marked processed, and clone forward. **0** active `auth_user` rows lack a
`fondo_api_userprofile` row.

### 2.6 Which tasks are "birthday tasks"

`payload.type === 'birthdate'`, exact and case-sensitive, with no trimming. `NULL`, `Birthdate`
and `'birthdate '` take v1's path with the stored list. Pinned in
`notification.executer.spec.ts › treats type … as not a birthday`.

### 2.7 The owner read and the audience read are deliberately not atomic (review m3)

`MemberDirectory.ownerStatus` and `MemberDirectory.activeMemberIdsExcept` are two statements, not
one transaction (`notification.executer.ts`, `run`). It is harmless:

* **The owner is excluded from the audience either way.** `activeMemberIdsExcept(owner_id)` drops
  the owner whatever their status at the second read, so a member deactivated between the two
  reads is not greeted about their own birthday.
* **A member who changes status between the reads** joins or leaves this one audience, exactly as
  if the change had landed a second earlier or later.

⚠️ **Do not wrap them in a transaction.** It buys nothing, and it invites moving the SQS publish
inside it. `NotificationPublisher` forbids that, because a publish cannot be rolled back. The same
note is in the executer's doc comment.

### 2.8 One zone for write, selection and cron: `TIME_ZONE` is pinned (C89, review m2)

**The drift the review found.** v2 decided "which calendar day" from two sources:

| decision | zone came from |
|---|---|
| D48's birthday `run_date` (`nextBirthdayRunDate` default) | constant `BOGOTA_TIME_ZONE` |
| `scheduleNotification`'s wall clock → instant | constant |
| the scheduler cron (`@Cron` `timeZone`, fixed at class definition) | constant |
| the runner's "today" (`todayInBogota(now, config.timeZone)`) | env `TIME_ZONE`, a free string |
| `SchedulerTaskRepository`'s same-day dedupe and due-task selection | env `TIME_ZONE` |

The last two rows were found by grep at the fix round (`config.timeZone`: `scheduler.runner.ts`,
`scheduler-task.repository.ts` ×2); the review named the first one.

**Choices considered:**

* **Pass `config.timeZone` everywhere.** The cron zone is a decorator argument, evaluated before
  configuration exists, so it would need a dynamic `SchedulerRegistry` job or a boot check. Every
  other constant default (`todayInBogota()`, `bogotaWallClockToInstant`) would also need plumbing.
  That is more code, and each new call site could reintroduce the drift.
* **Pin `TIME_ZONE` to `America/Bogota` in the schema. Chosen.** It makes the constant the one
  source, closes all five rows at once, and matches v1, which hardcodes the setting. It follows the
  existing `LANGUAGE_LOCALE: z.literal('es')` precedent in the same schema.
  **Measured before choosing:** the only file outside `docs/` and `src/` that sets `TIME_ZONE` is
  `.env.example`, to `America/Bogota`. `.env`, `buildspec.yml` and the scripts don't set it.

**Cost, registered:** a deployment can no longer set `TIME_ZONE` to anything else, including
`' America/Bogota'` with surrounding spaces, which the old `.trim()` accepted. It fails at boot
with `EnvValidationError` naming `TIME_ZONE`.

**Checks** (`src/scheduler/zone-single-source.spec.ts`):

* the schema's default is `BOGOTA_TIME_ZONE`, and every other value is refused, including
  `America/Lima` (same offset today, different name);
* the cron's registered `timeZone` equals the configured zone;
* at 09:00, 13:30 and 21:30 Bogotá (instants where another zone decides differently), D48 with its
  default zone and D48 with the configured zone agree on the day the **runner** selects, read from
  the runner itself.

`scheduler.runner.spec.ts`'s zone cell is kept and renamed (§3): it still pins that the runner
reads its zone from configuration.

---

## 3. Phase 3 (and 7b) cells re-pinned — none edited silently

| cell | phase | before (`11b8c5a`) | after | reason |
|---|---|---|---|---|
| `src/users/user.service.spec.ts › … › schedules in 2025 at 2026-01-01T02:00Z — still 31 December in Bogota` → renamed `schedules 2026-11-07 at 2026-01-01T02:00Z — … (D48 re-pin)` | 3 | `{2025, 11, 7}` | `{2026, 11, 7}` | **D48 re-pin.** 7 Nov 2025 had passed on 31 Dec 2025. ⚠️ Under the harness's `TZ=UTC` this cell no longer discriminates a host-zone year. That's not equivalence: the discriminating instant needs a host more than ten hours ahead of Bogotá, which is now the child-process cell `birthday-run-date.host-zone.spec.ts` (mutant M3, §5.3) |
| `test/user.e2e-spec.ts › the birthdate SchedulerTask … › replaces the task when the birthdate changes, rather than accumulating` | 3 | real clock; `slice(5, 10) === '01-02'` | clock `2026-09-14T17:00Z`; `=== '2027-01-02T05:00:00.000Z'` | **D48 re-pin.** Under the real clock the row was `<this year>-01-02`, past on every day after 2 Jan |
| `test/user.e2e-spec.ts › … › D19: a 29 February birthdate saves, and schedules 28 February in a non-leap year` | 3 | real clock; expectation from **`new Date().getFullYear()`** (host zone); month-day only | clock `2026-09-14T17:00Z`; `=== '2027-02-28T05:00:00.000Z'` | **D48 re-pin.** The chosen year isn't the current year. The old expectation would be wrong in September 2027 (row `2028-02-29`) |
| `src/users/user.service.spec.ts › updateUser — … schedules in 2026 at 2026-01-01T05:00Z …` and `… is unaffected by the host zone …` | 3 | fake timers | injected clock | same pins. The mechanism changed (`jest.useFakeTimers` → `Clock`) so the cell fails if the service stops asking its clock (mutant M11) |
| `src/scheduler/executers/notification.executer.spec.ts › json.loads-es user_ids out of hstore’s string storage and forwards message and target` | 7b | sent to stored `[2, 4, 3, 13, …]` | sent to `MemberDirectory`'s list; `activeMemberIdsExcept(5)` | **D49 re-subject.** The stored-list pass-through stays pinned by `passes the payment_reminder shape through unchanged` |
| `test/scheduler-runner.e2e-spec.ts › a full pass › resolves user_ids to every subscribed device of every listed member` | 7b | a *birthday* payload with `owner_id` 5 (never seeded) | a *payment reminder* payload, same ids and assertion | **D39/D49 re-subject.** Owner 5 is `missing` → nothing sent. The property (stored ids → every device) is v1's path, which reminders keep |

The other six `new UserService(...)` construction sites in `user.service.spec.ts` gained a
`new SystemClock()` argument and nothing else.

**Review fix round (C87–C89), changed cells, none silently:**

| cell | before (`5e3457a`) | after | reason |
|---|---|---|---|
| `scheduler.runner.spec.ts › the date it asks for › honours a configured time zone other than the default` | that name | **renamed** `reads its zone from configuration, not from a constant of its own (C89)`, same body | **C89.** The schema pins `TIME_ZONE`, so "a configured zone other than the default" no longer exists. What the cell pins, that the runner reads config, is still true |
| `notification.executer.spec.ts › owner_id on a birthday task (§2.4) › …` (10 cells) | `describe` label `(§2.4)` | `(§2.5)` | **review n1.** Label only; the 10 bodies are unchanged except the next row |
| `notification.executer.spec.ts › … › maps an id beyond integer to one no row can have, rather than an out-of-range bind` | asserted `ownerStatus(2147483648)` was **called** | **removed**, replaced by `queries an owner_id of exactly 2147483647, the largest integer` and `answers owner_id %s as a missing owner with no query and no send (C88)` × 3 (`2147483648`, `99999999999`, 40 ones) | **C88.** The old cell certified the defect: it mocked the lookup that throws P2020 against a real database |

---

## 4. For `manual-tester` — expected diffs against v1

1. **PATCH with a birthdate whose anniversary is past, or today at or after 14:00 Bogotá:** v2's
   `fondo_api_schedulertask.run_date` is next year's, where v1's is this year's. `payload` is
   byte-identical.
2. **A birthday task whose owner is `is_active = false`:** v1 publishes, v2 publishes nothing.
   The row is processed and the clone written on both.
3. **A birthday task whose owner has no `auth_user` row:** v1 publishes, v2 publishes nothing.
   Processed and cloned on both. v2 logs the runner's `WARN` for the task.
4. **Any birthday task that is published:** the SQS `subscriptions` list comes from the members
   active at send time, minus the owner. On `fondodev`, 11 of 14 pending chains differ this way
   (plan Q49, measured 2026-09-14; not re-measured here).
5. **Unchanged, and a failure if it differs:** payment reminders (stored list, no activity
   filter, no owner check); the message body bytes; the cloned row's payload text.

---

## 5. Mutation controls

**Method.** The wrong implementations were listed first, in `mutants.sh`, before any of them ran.
Each one is a single `perl -0` substitution in one target file, planted by `mutate.sh`, which:

1. records the target's sha256 before and after planting, and marks the mutant **NOT_APPLIED**
   if they match;
2. runs `tsc --noEmit`, and marks a mutant that does not compile **INVALID**, because it proves
   nothing;
3. runs, each with `--json`:
   - the unit suites `src/users/birthday-run-date.host-zone.spec.ts`,
     `src/users/user.service.spec.ts` and `src/scheduler/`;
   - the e2e suites `test/user.e2e-spec.ts` and `test/scheduler-runner.e2e-spec.ts`;
4. restores the file and checks the restored sha256 against the original.

A mutant is **killed** only when a named test assertion fails. The §5.2 table is rendered from
each mutant's `meta` file by `render-mutants.js`, not typed. A mutant with no `restore=` line is
rendered **INCOMPLETE**, never "survived".

**Blind controls: B1–B3.** These are changes with no behaviour difference, which a suite that
pins behaviour must let survive.

- **B1 (comment only).**
- **B2 (`< 14` rewritten as `<= 13`):** equivalent over integer hours.
- **B3 (a wider `select` in `ownerStatus`):** a change of query shape only.

⚠️ **B4 (trimming `type`) is not a blind control.** `mutants.sh` files it under the blind-control
heading, and this section's first draft called it one; both were wrong. Trimming turns a
`"birthdate "` task into a birthday, when §2.6 sends that task down v1's path with its stored
list. That makes B4 a **behaviour mutant**. Its kill is counted with the other behaviour kills in
§5.2's tally, and says nothing about over-specification.

**Invalid mutants re-planted** (`mutants-replant.sh`). Four plants failed to compile in the first
run. Each re-plant keeps the wrong behaviour in a form that compiles, and each substitution was
dry-run on a scratch copy and changed exactly one line.

| first plant | `tsc.log` cause | re-plant | still wrong because |
|---|---|---|---|
| M4 | TS6133, `timeZone` unread | **M4b** `partsInZone(now, timeZone && 'UTC')` | always UTC |
| M7 | TS2367 + TS6133, `order` narrowed to literal `1`, `comparePlainDates` unread | **M7b** `comparePlainDates(…) * 0 + 1` | always this year: v1's `replace(year=today_year)` |
| M11 | TS6138, `clock` unread | **M11b** `this.clock.now() && new Date()` | always the host clock |
| E6 | TS6133, `ownerId` unread | **E6b** `id !== ownerId \|\| id === ownerId` | keeps the owner |

### 5.3 What the first run found, and what changed before the run in §5.1/§5.2

The first run went from 12:34:29 to 12:47:48 (-05:00), 2026-09-14. Every restore was `OK`, and
`sha256sum -c` exited 0 before and after. It is **superseded**, because two of its results changed
the tests, so its hashes no longer describe the tree.

- **M3 (host-zone year, `now.getFullYear()`) survived, with 0 unit and 0 e2e failures.** My first
  explanation was that M3 is equivalent under D48. **That holds only for host zones up to
  UTC+05**:
  - A UTC host reads 1 January only from 19:00 Bogotá on 31 December. By then every anniversary in
    the Bogotá year is past the 14:00 cutoff, so both implementations choose year + 1.
  - A host **more than ten hours ahead** (UTC+05:01 to UTC+14) reads 1 January while Bogotá is
    still before 14:00 on 31 December. A 31 December birthday is due today (2026-12-31), and M3
    answers 2027-12-31.
  - For zones behind Bogotá the case argument was that the host is still on 31 December only while
    Bogotá is before 07:00 on 1 January, where both choose the same date. ⚠️ **Review n2:** that
    sentence claimed "every real offset" from a case argument. It is now a check:
    `birthday-run-date.host-zone.spec.ts › which host offsets make a host-zone year read disagree
    with D48` models M3's exact diff and sweeps every birthday of a leap year × every quarter-hour
    instant from 30 December 12:00 to 1 January 12:00 Bogotá × every quarter-hour offset from
    UTC−12:00 to UTC+14:00 (105 offsets × 193 instants × 366 birthdays, asserted; a first draft of
    the cell said 109 offsets, and its own size check failed on that arithmetic). It asserts the disagreeing
    offsets are exactly UTC+05:15 through UTC+14:00. Offsets between quarter hours are not swept.

  So M3 survived because **no cell ran under a zone ahead of UTC+05**, not because it was
  equivalent. jest pins `TZ=UTC` in its parent process, and assigning `process.env.TZ` in a spec
  is a measured no-op. The new cell, `src/users/birthday-run-date.host-zone.spec.ts`, runs the
  function in a child Node process under `Asia/Tokyo` and `Pacific/Kiritimati`. To make that
  possible:
  - The function and `birthdayInYear` moved into `src/users/birthday-run-date.ts`, which has no
    Nest or Prisma import. `user.service.ts` re-exports both.
  - Each child reports its resolved zone and `getFullYear()` as a positive control. Probed from
    the shell first, the instant `2026-12-31T15:00Z` reads zone `Asia/Tokyo`, host year **2027**,
    run date **2026-12-31** under `TZ=Asia/Tokyo`, and host year **2026** under `TZ=UTC`.
- **B3 (blind) was killed**, by 3 unit cells:
  `MemberDirectory ownerStatus — D39 maps the auth_user row … to active|inactive|missing`.
  They pinned the exact call object, including `select: { is_active: true }`, which is
  over-specified: a harmless wider `select` failed them. They now pin the looked-up id and that
  `is_active` is selected (`expect.objectContaining`).
- **B4 was killed** by the §2.6 cell
  `NotificationExecuter … treats type "birthdate " as not a birthday: the v1 path, with the stored list`.
  B4 is a behaviour mutant, not a blind control (see *Blind controls* above), so this is an
  ordinary kill by the intended pin.
- **B1 and B2 survived.**

**Instrument defects, each measured:**

1. **`ps -C node,python3` is blind to these runs.** jest's `comm` is `MainThread`, and npm's is
   `npm run test:e2`.
   - The coordinator measured it printing nothing while E4 was planted.
   - My own use of it at 12:37:59, with M6 planted, printed nothing too. I didn't act on it: I was
     tracking progress from the `meta` files, and `scratchpad/gate.sh` runs no `ps` check.
2. **`ps -eo … args | grep -E '[j]est|[n]pm run|[m]utate|[m]utants'` matches its own shell** when
   embedded in a longer command, because that shell's `args` contain the same words. On an idle
   tree it printed two rows, both the calling `bash -c`.
   - The form used since filters on `comm` and drops `bash`, `grep`, `awk` and `ps` rows.
   - **Positive control:** at 12:53:46, one second into the §5.2 batch, it printed
     `78768 MainThread node …/node_modules/.bin/jest src/users/birthday-run-date …`.
3. **ts-node stops on TS5011**, which asks for an explicit `rootDir`, even in transpile-only mode.
   - All 3 host-zone cells failed that way on the unmutated tree until
     `TS_NODE_COMPILER_OPTIONS={"rootDir": <repo>}` was added.
   - That was an instrument failure, not a D48 result.

### 5.1 Target file hashes (taken before the first mutant; `sha256sum -c` re-run after the last)

Hashed at 2026-09-14T13:10:54-05:00. `sha256sum -c`, run from the repo root: **hashcheck_before=0** before the first mutant, **hashcheck_after=0** after the last.

| file | sha256 |
|---|---|
| `src/users/birthday-run-date.ts` | `c1a3dcd8893eaaff38ddab1681b3a87ecd2d804ad3348d067358c1045b55e25a` |
| `src/users/user.service.ts` | `6a09f93199dc63cbe9f45d0e251f8c5e2f77c1f4c6d2949ce1f1021b9a37498b` |
| `src/scheduler/executers/notification.executer.ts` | `2d9d5b2afa5a695f7088ac180be5c07d73fd13c97d4e54fa0d1cc9b0b3e77232` |
| `src/scheduler/member-directory.ts` | `7f8e426587fe28f1627389e5db9087844d889a39efc30100b156a3495bc598bb` |
| `src/users/active-members.query.ts` | `773fd62b95ecf398fa82515686b36664e68a265aa3dea3fd3af2aa797274ce28` |
| `src/scheduler/scheduler-passes.ts` | `ca75e1509ee3f63aae318d8a77de201b848166bce2406aeac7b37a968d575ce3` |
| `src/common/clock/clock.ts` | `3939441fcef0f6194fcddf410b1fa849f49ef41d7db188ba685dac8232107e6b` |
| `src/users/birthday-run-date.host-zone.spec.ts` | `fe352e3d68b799f7f82f7e5448f96facd388ec76473a47252f31a0a71f525139` |
| `src/users/user.service.spec.ts` | `5838f0346c6b064e99d8e77940dac3e5e7a01524a9091c57622da861172d393b` |
| `src/scheduler/executers/notification.executer.spec.ts` | `b2eab134706f043a1faf686486b524b32d9578f473ae07e12b57efda668b5f43` |
| `src/scheduler/member-directory.spec.ts` | `ebd9ada48b05fef72987e50e818358b195d48d97f7c9def5de76aa7df6bbe2d5` |
| `src/scheduler/scheduler.runner.spec.ts` | `ee3a878c298ed0771dd3e2e24274a7f61520df2fa230f3f0d0d11392f850a164` |
| `test/user.e2e-spec.ts` | `65add93f43ceacd05360c70b1c4393baf0e323f9bb7bab93ac4bf168c28bc0bb` |
| `test/scheduler-runner.e2e-spec.ts` | `234c09161187e0342cf62db41bb714ea6ce8bff827a75f9acc035a4326bc22f2` |

### 5.2 Results

Run from 2026-09-14T13:10:54-05:00 to 2026-09-14T13:27:27-05:00; batch_exit=0, render_exit=0; "Permission denied" lines in the batch logs: r3-mutants.log:0, r3-replant.log:0.

Guard positive control (first live row seen during the batch, then the guard after exit):

```
2026-09-14T13:10:55-05:00
  92809       00:00 MainThread      node /home/miguel/Projects/Fondo-API-v2/node_modules/.bin/jest src/users/birthday-run-date src/users/user.service.spec.ts sr
  92821       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
  92822       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
  92828       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
  92829       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
  92835       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
  92844       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
guard_rows_after_exit=[]
```

| id | target | target sha256 (first 12) | mutant sha256 (first 12) | tsc exit | outcome | failing cells |
|---|---|---|---|---|---|---|
| B1-comment-only | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `cac059d426b3` | 0 | **survived** | — |
| B2-equivalent-hour | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `a3aa53a0e2aa` | 0 | **survived** | — |
| B3-directory-select-shape | `src/scheduler/member-directory.ts` | `7f8e426587fe` | `367f549d2d68` | 0 | **survived** | — |
| B4-type-trim | `src/scheduler/executers/notification.executer.ts` | `2d9d5b2afa5a` | `e8d743d63bf5` | 0 | **killed** | unit 1 / e2e 0: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) treats type "birthdate " as not a birthday: the v1 path, with the stored list` |
| E1-skip-no-clone | `src/scheduler/executers/notification.executer.ts` | `2d9d5b2afa5a` | `f61964ed6b65` | 0 | **killed** | unit 1 / e2e 2: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) sends nothing for an inactive owner, and returns rather than throws`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 — inactive owner: nothing sent, row processed, successor cloned with the same payload`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action` |
| E2-d39-on-reminders | `src/scheduler/executers/notification.executer.ts` | `2d9d5b2afa5a` | `1d3a6adc90cc` | 0 | **killed** | unit 4 / e2e 4: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) does not apply to a payment reminder, whose owner_id is a loan id`<br>`NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) treats type null as not a birthday: the v1 path, with the stored list`<br>`NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) treats type "Birthdate" as not a birthday: the v1 path, with the stored list`<br>`NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) treats type "birthdate " as not a birthday: the v1 path, with the stored list`<br>`Phase 7b — scheduler runner a full pass publishes the notification, marks the row processed and writes no clone`<br>`Phase 7b — scheduler runner a full pass publishes the exact bytes v1 publishes`<br>`Phase 7b — scheduler runner a full pass resolves user_ids to every subscribed device of every listed member`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39/D49 do not touch a payment reminder: stored list, no activity filter, no owner check` |
| E3-missing-sends | `src/scheduler/executers/notification.executer.ts` | `2d9d5b2afa5a` | `ae639e555789` | 0 | **killed** | unit 2 / e2e 1: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) sends nothing for an owner with no auth_user row, and reports it as ok = false (§2.2)`<br>`NotificationExecuter owner_id on a birthday task (§2.4) maps an id beyond integer to one no row can have, rather than an out-of-range bind`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) §2.2 — owner with no auth_user row: nothing sent, processed, cloned, counted as failed` |
| E4-inactive-sends | `src/scheduler/executers/notification.executer.ts` | `2d9d5b2afa5a` | `0056e065a0eb` | 0 | **killed** | unit 1 / e2e 2: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) sends nothing for an inactive owner, and returns rather than throws`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 — inactive owner: nothing sent, row processed, successor cloned with the same payload`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action` |
| E5-recipients-from-payload | `src/scheduler/executers/notification.executer.ts` | `2d9d5b2afa5a` | `46aa0f4a4429` | 0 | **killed** | unit 4 / e2e 5: `NotificationExecuter json.loads-es user_ids out of hstore’s string storage and forwards message and target`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) ignores the stored user_ids for the audience`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) asks for the active members except the owner named in the payload`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) sends to an empty list when the owner is the only active member`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — a member who joined after the chain was written receives the greeting`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — a member who has left does not, although the stored list names them`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — the owner is excluded, even from a hand-written list that names them`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) Phase 8b end to end: the task PATCH writes is run on the birthday, to the members active then` |
| E6-owner-not-excluded | `src/scheduler/member-directory.ts` | `7f8e426587fe` | `68e84887cd5f` | 2 | **INVALID** (did not compile) | — |
| E6b-owner-not-excluded | `src/scheduler/member-directory.ts` | `7f8e426587fe` | `44d990de0c56` | 0 | **killed** | unit 1 / e2e 4: `MemberDirectory activeMemberIdsExcept — D49 is the active-member query minus the owner, in the order the query returned`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) Phase 8b end to end: the task PATCH writes is run on the birthday, to the members active then`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — a member who has left does not, although the stored list names them`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — the owner is excluded, even from a hand-written list that names them` |
| E7-inactive-members-included | `src/users/active-members.query.ts` | `773fd62b95ec` | `0341dd95af5b` | 0 | **killed** | unit 1 / e2e 2: `MemberDirectory activeMemberIdsExcept — D49 filters on auth_user.is_active, with no role filter and no ORDER BY`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) Phase 8b end to end: the task PATCH writes is run on the birthday, to the members active then`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — a member who has left does not, although the stored list names them` |
| E8-stop-parsing-user_ids | `src/scheduler/executers/notification.executer.ts` | `2d9d5b2afa5a` | `60ce6684e28c` | 0 | **killed** | unit 5 / e2e 0: `NotificationExecuter v1’s KeyError paths (condition C23 — fail closed, never open) raises KeyError for a payload with no user_ids`<br>`NotificationExecuter v1’s KeyError paths (condition C23 — fail closed, never open) checks user_ids before message, matching v1’s statement order`<br>`NotificationExecuter v1’s KeyError paths (condition C23 — fail closed, never open) raises TypeError for a NULL user_ids, as json.loads(None) does`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) still json.loads the stored user_ids of a birthday, before any member read`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) still raises KeyError for a birthday with no user_ids, before any member read (C23)` |
| M1-lte-at-14 | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `93776166fb88` | 0 | **killed** | unit 1 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 14:00 pass (2026-09-14T19:00:00.000Z = 14:00:00.000 Bogota) → 2027-09-14`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 14:00:00.000 Bogota: the last pass has started, so next year` |
| M2-first-pass | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `a0ade65e1292` | 0 | **killed** | unit 8 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 10:00 pass (2026-09-14T15:00:00.000Z = 10:00:00.000 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 between the two passes (2026-09-14T17:30:00.000Z = 12:30 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 one millisecond before 14:00 (2026-09-14T18:59:59.999Z = 13:59:59.999 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, at 13:59:59.999 on the 31st → 2026-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year before 14:00 it is the birthday today → 2027-02-28`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` |
| M3-host-year | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `6df7dd70054d` | 0 | **killed** | unit 2 / e2e 0: `nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today` |
| M4-utc-today | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `b61ee6aeddd8` | 2 | **INVALID** (did not compile) | — |
| M4b-utc-today | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `dbaf39c4b021` | 0 | **killed** | unit 8 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 10:00 pass (2026-09-14T15:00:00.000Z = 10:00:00.000 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 between the two passes (2026-09-14T17:30:00.000Z = 12:30 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 one millisecond before 14:00 (2026-09-14T18:59:59.999Z = 13:59:59.999 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, at 13:59:59.999 on the 31st → 2026-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year before 14:00 it is the birthday today → 2027-02-28`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` |
| M5-utc-hour | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `4e86d5ccc392` | 0 | **killed** | unit 10 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 10:00 pass (2026-09-14T15:00:00.000Z = 10:00:00.000 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 between the two passes (2026-09-14T17:30:00.000Z = 12:30 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 one millisecond before 14:00 (2026-09-14T18:59:59.999Z = 13:59:59.999 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at 23:59:59.999, when UTC is already the 15th (2026-09-15T04:59:59.999Z = 23:59:59.999 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, after the 14:00 pass → 2027-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, at 13:59:59.999 on the 31st → 2026-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year before 14:00 it is the birthday today → 2027-02-28`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` |
| M6-utc-date | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `f7f07057b400` | 0 | **killed** | unit 3 / e2e 0: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday tomorrow, read at 23:30 Bogota when it is already tomorrow in UTC → this year`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, after the 14:00 pass → 2027-12-31`<br>`UserService (unit) createBirthdateNotification — the year is Bogota’s, not the host’s (C28) schedules 2026-11-07 at 2026-01-01T02:00Z — 31 December 2025 in Bogota, 7 November already passed (D48 re-pin)` |
| M7-v1-this-year | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `f1e7442dbc0f` | 2 | **INVALID** (did not compile) | — |
| M7b-v1-this-year | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `597791e6fed4` | 0 | **killed** | unit 14 / e2e 6: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 14:00 pass (2026-09-14T19:00:00.000Z = 14:00:00.000 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 after 14:00 (2026-09-14T22:00:00.000Z = 17:00 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at 23:59:59.999, when UTC is already the 15th (2026-09-15T04:59:59.999Z = 23:59:59.999 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday yesterday → next year`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday yesterday, read at 00:30 Bogota, before either pass → next year`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, after the 14:00 pass → 2027-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 1 January birthday → 2027-01-01: tomorrow in Bogota, not "today after 14:00" in UTC`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) chosen year is a leap year: 2027-06-01 → 2028-02-29 (the next-year branch)`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) chosen year is not a leap year: 2026-06-01 → 2027-02-28 (the next-year branch)`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year after 14:00 it has been missed → 2028-02-29`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 Q36 — Ainhoa, 2020-08-05, saved on 2026-09-14 → 2027-08-05`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`UserService (unit) createBirthdateNotification — the year is Bogota’s, not the host’s (C28) schedules 2026-11-07 at 2026-01-01T02:00Z — 31 December 2025 in Bogota, 7 November already passed (D48 re-pin)`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 1 January birthday saved at the same instant is tomorrow in Bogotá`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) replaces the task when the birthdate changes, rather than accumulating`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D19: a 29 February birthdate saves, and schedules 28 February in a non-leap year`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D19 × D48: a 29 February birthdate keeps 29 February when the chosen year is a leap year`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 14:00:00.000 Bogota: the last pass has started, so next year`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday yesterday: next year, never a past date`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) Q36: saving a birthdate whose anniversary already passed writes next year’s run_date, with no manual insert` |
| M8-ignore-hour | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `b5133c1411d2` | 0 | **killed** | unit 6 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 14:00 pass (2026-09-14T19:00:00.000Z = 14:00:00.000 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 after 14:00 (2026-09-14T22:00:00.000Z = 17:00 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at 23:59:59.999, when UTC is already the 15th (2026-09-15T04:59:59.999Z = 23:59:59.999 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, after the 14:00 pass → 2027-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year after 14:00 it has been missed → 2028-02-29`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 14:00:00.000 Bogota: the last pass has started, so next year` |
| M9-no-clamp-next | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `4b46e4a3f2ac` | 0 | **killed** | unit 1 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) chosen year is not a leap year: 2026-06-01 → 2027-02-28 (the next-year branch)`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D19: a 29 February birthdate saves, and schedules 28 February in a non-leap year` |
| M10-compare-unclamped | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `0cf675fb0616` | 0 | **killed** | unit 1 / e2e 0: `UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year after 14:00 it has been missed → 2028-02-29` |
| M11-host-clock | `src/users/user.service.ts` | `6a09f93199dc` | `cd65dc2f9d46` | 2 | **INVALID** (did not compile) | — |
| M11b-host-clock | `src/users/user.service.ts` | `6a09f93199dc` | `6bc7c8d533c4` | 0 | **killed** | unit 0 / e2e 2: `Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D19 × D48: a 29 February birthdate keeps 29 February when the chosen year is a leap year`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 14:00:00.000 Bogota: the last pass has started, so next year` |

**Tally, counted from the rendered table above, not typed:** 27 rows.

| kind | killed | survived | invalid (did not compile) | incomplete / not applied |
|---|---|---|---|---|
| behaviour mutants (M1–M11, E1–E8, **B4**, re-plants M4b, M7b, M11b, E6b) | **20** | **0** | 4 (M4, M7, M11, E6) | 0 |
| blind controls (B1–B3) | 0 | **3** | 0 | 0 |

* **Every compiling behaviour mutant was killed: 20 of 20.** That includes M3 (the host-zone year),
  which run 1 did not kill (§5.3). The four invalid plants prove nothing on their own, and each is
  superseded by a re-plant with the same wrong behaviour that compiles and was killed: M4 → M4b,
  M7 → M7b, M11 → M11b, E6 → E6b.
* **All 3 blind controls survived.** B3 survived only after the over-specified `ownerStatus`
  cells were relaxed. In run 1 it was killed (§5.3).
* ⚠️ **B4 is counted as a behaviour mutant.** `mutants.sh` filed it under the blind-control
  heading, and the first draft of §5 called it blind. It is a behaviour change (§5, *Blind
  controls*), and its kill by the §2.6 cell is an ordinary kill.

⚠️ **§5.1–§5.2 describe `5e3457a`.** The review fix round changed targets and killing suites; its
run is §5.4, on its own hashes.

### 5.4 Review fix round (C87–C89): mutants on the fix-round hashes

Same method as §5 (`mutate.sh`), with `src/config` added to the unit suites. The mutant list is
`mutants.sh` + `mutants-replant.sh` + **`mutants-fr.sh`**, the last written before any fix-round
run. **Every existing mutant was re-run, not justified from a diff:** the fix round changed
targets (`notification.executer.ts`) and every killing suite (`notification.executer.spec.ts`,
`scheduler.runner.spec.ts`, `birthday-run-date.host-zone.spec.ts`, `scheduler-runner.e2e-spec.ts`).

**New wrong implementations (fix round), listed before the run:**

| id | target | wrong implementation |
|---|---|---|
| N1-int4-guard-dropped | `notification.executer.ts` | `parseOwnerId` never returns `null` (`id > MAX_INT4 && false`) |
| N2-gte-at-max-int4 | `notification.executer.ts` | `>=` instead of `>`: `2147483647` is not queried |
| N3-guard-says-inactive | `notification.executer.ts` | the no-query guard answers `owner-inactive`, `ok: true` |
| Z1-schema-free-zone | `env.schema.ts` | `TIME_ZONE` back to a free string |
| Z2-cron-zone-utc | `scheduler.runner.ts` | the cron fires in UTC |
| Z3-d48-default-zone-utc | `birthday-run-date.ts` | D48's default zone differs from the configured zone |
| Z4-runner-selection-constant | `scheduler.runner.ts` | the runner selects with the constant instead of config (made possible by m2's pin; production-equivalent under it, so only the plumbing cell can see it) |
| **B5** (blind) | `notification.executer.ts` | `> MAX_INT4` rewritten as `>= MAX_INT4 + 1`, equivalent over integers |

**Changed definition:** E2 now plants `ownerStatus(parseOwnerId(payload) ?? 0)`. Its `5e3457a` form passed
`number | null` to `ownerStatus(number)` and no longer compiles; the wrong behaviour is unchanged.

**Dry run before the batch:** every substitution was applied to a scratch copy of its current
target; 0 were NOT_APPLIED. Multi-line plants, all as in run 3 and intentional: M3 (2 lines), E2 (inserts
3), E7 (drops a line), B1 (inserts a comment).

**Target hashes.** Hashed at 2026-09-14T17:15:47-05:00; `sha256sum -c` from the repo root: **hashcheck_before=0** before the first mutant, **hashcheck_after=0** after the last.

| file | sha256 |
|---|---|
| `src/users/birthday-run-date.ts` | `c1a3dcd8893eaaff38ddab1681b3a87ecd2d804ad3348d067358c1045b55e25a` |
| `src/users/user.service.ts` | `6a09f93199dc63cbe9f45d0e251f8c5e2f77c1f4c6d2949ce1f1021b9a37498b` |
| `src/scheduler/executers/notification.executer.ts` | `1e7d77e2288388fede41f057e74bf56945815a8b298072fb522e37a06ebb56f0` |
| `src/scheduler/member-directory.ts` | `7f8e426587fe28f1627389e5db9087844d889a39efc30100b156a3495bc598bb` |
| `src/users/active-members.query.ts` | `773fd62b95ecf398fa82515686b36664e68a265aa3dea3fd3af2aa797274ce28` |
| `src/scheduler/scheduler-passes.ts` | `ca75e1509ee3f63aae318d8a77de201b848166bce2406aeac7b37a968d575ce3` |
| `src/common/clock/clock.ts` | `3939441fcef0f6194fcddf410b1fa849f49ef41d7db188ba685dac8232107e6b` |
| `src/users/birthday-run-date.host-zone.spec.ts` | `04f8d19ac3fcb4632b88c16f9550d4ed0ccc0edd6336b753599289231e683d49` |
| `src/users/user.service.spec.ts` | `5838f0346c6b064e99d8e77940dac3e5e7a01524a9091c57622da861172d393b` |
| `src/scheduler/executers/notification.executer.spec.ts` | `7ac8592c4b00093255931215bb97dfb6a7f8216e70000055426c1e2f56905bee` |
| `src/scheduler/member-directory.spec.ts` | `ebd9ada48b05fef72987e50e818358b195d48d97f7c9def5de76aa7df6bbe2d5` |
| `src/scheduler/scheduler.runner.spec.ts` | `aab4d154665c8785ef1652785f4c7f0835250568d09c1df9e5d845e16ad49cf2` |
| `test/user.e2e-spec.ts` | `65add93f43ceacd05360c70b1c4393baf0e323f9bb7bab93ac4bf168c28bc0bb` |
| `test/scheduler-runner.e2e-spec.ts` | `b4764e6c96fe0b722f56c8540eb4156792a80c1a02aed8061fe10bddf16acd43` |
| `src/config/env.schema.ts` | `dfdeae46686ecf9609654fab5f39d4f78d3847db3e26608ea291e7af6185b388` |
| `src/scheduler/scheduler.runner.ts` | `1ec58c24bc31103c225c57f536f538e264b854d3bf0dfdf1202849bcdc63ec70` |
| `src/scheduler/zone-single-source.spec.ts` | `934b63a90c6a7ec6ae9614d5a527eb72f8bb8d4e04b64ea2bcf89525527bcc74` |

**Run:** 2026-09-14T17:15:47-05:00 to 2026-09-14T17:37:55-05:00; batch_exit=0, render_exit=0; "Permission denied" lines: fr-mutants.log:0, fr-replant.log:0, fr-fr.log:0.

Guard positive control (first live row during the batch; then the guard after exit):

```
2026-09-14T17:15:48-05:00
 126656       00:00 MainThread      node /home/miguel/Projects/Fondo-API-v2/node_modules/.bin/jest src/config src/users/birthday-run-date src/users/user.service
 126668       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
 126669       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
 126675       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
 126679       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
 126685       00:00 MainThread      /home/miguel/.config/nvm/versions/node/v24.20.0/bin/node /home/miguel/Projects/Fondo-API-v2/node_modules/jest-worker/build/p
guard_rows_after_exit=[]
```

| id | target | target sha256 (first 12) | mutant sha256 (first 12) | tsc exit | outcome | failing cells |
|---|---|---|---|---|---|---|
| B1-comment-only | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `cac059d426b3` | 0 | **survived** | — |
| B2-equivalent-hour | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `a3aa53a0e2aa` | 0 | **survived** | — |
| B3-directory-select-shape | `src/scheduler/member-directory.ts` | `7f8e426587fe` | `367f549d2d68` | 0 | **survived** | — |
| B4-type-trim | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `85d5de91e184` | 0 | **killed** | unit 1 / e2e 0: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) treats type "birthdate " as not a birthday: the v1 path, with the stored list` |
| B5-equivalent-int4-bound | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `5c2e8e1b3d6c` | 0 | **survived** | — |
| E1-skip-no-clone | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `a64b717bee33` | 0 | **killed** | unit 1 / e2e 2: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) sends nothing for an inactive owner, and returns rather than throws`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 — inactive owner: nothing sent, row processed, successor cloned with the same payload`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action` |
| E2-d39-on-reminders | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `d2f5254c8183` | 0 | **killed** | unit 4 / e2e 4: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) does not apply to a payment reminder, whose owner_id is a loan id`<br>`NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) treats type null as not a birthday: the v1 path, with the stored list`<br>`NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) treats type "Birthdate" as not a birthday: the v1 path, with the stored list`<br>`NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) treats type "birthdate " as not a birthday: the v1 path, with the stored list`<br>`Phase 7b — scheduler runner a full pass publishes the notification, marks the row processed and writes no clone`<br>`Phase 7b — scheduler runner a full pass publishes the exact bytes v1 publishes`<br>`Phase 7b — scheduler runner a full pass resolves user_ids to every subscribed device of every listed member`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39/D49 do not touch a payment reminder: stored list, no activity filter, no owner check` |
| E3-missing-sends | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `be0cdcb3d2bc` | 0 | **killed** | unit 2 / e2e 2: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) sends nothing for an owner with no auth_user row, and reports it as ok = false (§2.2)`<br>`NotificationExecuter owner_id on a birthday task (§2.5) queries an owner_id of exactly 2147483647, the largest integer`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) §2.2 — owner with no auth_user row: nothing sent, processed, cloned, counted as failed`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) C88 boundary — owner_id 2147483647 is a missing owner; queried: true` |
| E4-inactive-sends | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `881ec28ce614` | 0 | **killed** | unit 1 / e2e 2: `NotificationExecuter D39 — a departed owner is not announced (Q35, Q48) sends nothing for an inactive owner, and returns rather than throws`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 — inactive owner: nothing sent, row processed, successor cloned with the same payload`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action` |
| E5-recipients-from-payload | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `a242c79e8026` | 0 | **killed** | unit 4 / e2e 5: `NotificationExecuter json.loads-es user_ids out of hstore’s string storage and forwards message and target`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) ignores the stored user_ids for the audience`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) asks for the active members except the owner named in the payload`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) sends to an empty list when the owner is the only active member`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — a member who joined after the chain was written receives the greeting`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — a member who has left does not, although the stored list names them`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — the owner is excluded, even from a hand-written list that names them`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) Phase 8b end to end: the task PATCH writes is run on the birthday, to the members active then` |
| E6-owner-not-excluded | `src/scheduler/member-directory.ts` | `7f8e426587fe` | `68e84887cd5f` | 2 | **INVALID** (did not compile) | — |
| E6b-owner-not-excluded | `src/scheduler/member-directory.ts` | `7f8e426587fe` | `44d990de0c56` | 0 | **killed** | unit 1 / e2e 4: `MemberDirectory activeMemberIdsExcept — D49 is the active-member query minus the owner, in the order the query returned`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) Phase 8b end to end: the task PATCH writes is run on the birthday, to the members active then`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D39 / Q48 — reactivated owner: next year’s greeting goes out with no other action`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — a member who has left does not, although the stored list names them`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — the owner is excluded, even from a hand-written list that names them` |
| E7-inactive-members-included | `src/users/active-members.query.ts` | `773fd62b95ec` | `0341dd95af5b` | 0 | **killed** | unit 1 / e2e 2: `MemberDirectory activeMemberIdsExcept — D49 filters on auth_user.is_active, with no role filter and no ORDER BY`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) Phase 8b end to end: the task PATCH writes is run on the birthday, to the members active then`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) D49 — a member who has left does not, although the stored list names them` |
| E8-stop-parsing-user_ids | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `b7cc01d8a188` | 0 | **killed** | unit 5 / e2e 0: `NotificationExecuter v1’s KeyError paths (condition C23 — fail closed, never open) raises KeyError for a payload with no user_ids`<br>`NotificationExecuter v1’s KeyError paths (condition C23 — fail closed, never open) checks user_ids before message, matching v1’s statement order`<br>`NotificationExecuter v1’s KeyError paths (condition C23 — fail closed, never open) raises TypeError for a NULL user_ids, as json.loads(None) does`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) still json.loads the stored user_ids of a birthday, before any member read`<br>`NotificationExecuter D49 — birthday recipients are resolved when the greeting is sent (Q49) still raises KeyError for a birthday with no user_ids, before any member read (C23)` |
| M1-lte-at-14 | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `93776166fb88` | 0 | **killed** | unit 2 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 14:00 pass (2026-09-14T19:00:00.000Z = 14:00:00.000 Bogota) → 2027-09-14`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 14:00:00.000 Bogota: the last pass has started, so next year` |
| M2-first-pass | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `a0ade65e1292` | 0 | **killed** | unit 10 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 10:00 pass (2026-09-14T15:00:00.000Z = 10:00:00.000 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 between the two passes (2026-09-14T17:30:00.000Z = 12:30 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 one millisecond before 14:00 (2026-09-14T18:59:59.999Z = 13:59:59.999 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, at 13:59:59.999 on the 31st → 2026-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year before 14:00 it is the birthday today → 2027-02-28`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) the model reproduces the Tokyo disagreement the child process measures`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` |
| M3-host-year | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `6df7dd70054d` | 0 | **killed** | unit 2 / e2e 0: `nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today` |
| M4-utc-today | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `b61ee6aeddd8` | 2 | **INVALID** (did not compile) | — |
| M4b-utc-today | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `dbaf39c4b021` | 0 | **killed** | unit 10 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 10:00 pass (2026-09-14T15:00:00.000Z = 10:00:00.000 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 between the two passes (2026-09-14T17:30:00.000Z = 12:30 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 one millisecond before 14:00 (2026-09-14T18:59:59.999Z = 13:59:59.999 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, at 13:59:59.999 on the 31st → 2026-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year before 14:00 it is the birthday today → 2027-02-28`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) the model reproduces the Tokyo disagreement the child process measures`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` |
| M5-utc-hour | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `4e86d5ccc392` | 0 | **killed** | unit 12 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 10:00 pass (2026-09-14T15:00:00.000Z = 10:00:00.000 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 between the two passes (2026-09-14T17:30:00.000Z = 12:30 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 one millisecond before 14:00 (2026-09-14T18:59:59.999Z = 13:59:59.999 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at 23:59:59.999, when UTC is already the 15th (2026-09-15T04:59:59.999Z = 23:59:59.999 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, after the 14:00 pass → 2027-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, at 13:59:59.999 on the 31st → 2026-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year before 14:00 it is the birthday today → 2027-02-28`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) the model reproduces the Tokyo disagreement the child process measures`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` |
| M6-utc-date | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `f7f07057b400` | 0 | **killed** | unit 4 / e2e 0: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday tomorrow, read at 23:30 Bogota when it is already tomorrow in UTC → this year`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, after the 14:00 pass → 2027-12-31`<br>`UserService (unit) createBirthdateNotification — the year is Bogota’s, not the host’s (C28) schedules 2026-11-07 at 2026-01-01T02:00Z — 31 December 2025 in Bogota, 7 November already passed (D48 re-pin)`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid` |
| M7-v1-this-year | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `f1e7442dbc0f` | 2 | **INVALID** (did not compile) | — |
| M7b-v1-this-year | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `597791e6fed4` | 0 | **killed** | unit 15 / e2e 6: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 14:00 pass (2026-09-14T19:00:00.000Z = 14:00:00.000 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 after 14:00 (2026-09-14T22:00:00.000Z = 17:00 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at 23:59:59.999, when UTC is already the 15th (2026-09-15T04:59:59.999Z = 23:59:59.999 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday yesterday → next year`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday yesterday, read at 00:30 Bogota, before either pass → next year`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, after the 14:00 pass → 2027-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 1 January birthday → 2027-01-01: tomorrow in Bogota, not "today after 14:00" in UTC`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) chosen year is a leap year: 2027-06-01 → 2028-02-29 (the next-year branch)`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) chosen year is not a leap year: 2026-06-01 → 2027-02-28 (the next-year branch)`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year after 14:00 it has been missed → 2028-02-29`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 Q36 — Ainhoa, 2020-08-05, saved on 2026-09-14 → 2027-08-05`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`UserService (unit) createBirthdateNotification — the year is Bogota’s, not the host’s (C28) schedules 2026-11-07 at 2026-01-01T02:00Z — 31 December 2025 in Bogota, 7 November already passed (D48 re-pin)`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 1 January birthday saved at the same instant is tomorrow in Bogotá`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) replaces the task when the birthdate changes, rather than accumulating`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D19: a 29 February birthdate saves, and schedules 28 February in a non-leap year`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D19 × D48: a 29 February birthdate keeps 29 February when the chosen year is a leap year`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 14:00:00.000 Bogota: the last pass has started, so next year`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday yesterday: next year, never a past date`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) Q36: saving a birthdate whose anniversary already passed writes next year’s run_date, with no manual insert` |
| M8-ignore-hour | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `b5133c1411d2` | 0 | **killed** | unit 7 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 14:00 pass (2026-09-14T19:00:00.000Z = 14:00:00.000 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 after 14:00 (2026-09-14T22:00:00.000Z = 17:00 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at 23:59:59.999, when UTC is already the 15th (2026-09-15T04:59:59.999Z = 23:59:59.999 Bogota) → 2027-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, after the 14:00 pass → 2027-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year after 14:00 it has been missed → 2028-02-29`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 14:00:00.000 Bogota: the last pass has started, so next year` |
| M9-no-clamp-next | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `4b46e4a3f2ac` | 0 | **killed** | unit 2 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) chosen year is not a leap year: 2026-06-01 → 2027-02-28 (the next-year branch)`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D19: a 29 February birthdate saves, and schedules 28 February in a non-leap year` |
| M10-compare-unclamped | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `0cf675fb0616` | 0 | **killed** | unit 1 / e2e 0: `UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year after 14:00 it has been missed → 2028-02-29` |
| M11-host-clock | `src/users/user.service.ts` | `6a09f93199dc` | `cd65dc2f9d46` | 2 | **INVALID** (did not compile) | — |
| M11b-host-clock | `src/users/user.service.ts` | `6a09f93199dc` | `6bc7c8d533c4` | 0 | **killed** | unit 0 / e2e 2: `Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D19 × D48: a 29 February birthdate keeps 29 February when the chosen year is a leap year`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` |
| N1-int4-guard-dropped | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `79a2465fc9d8` | 0 | **killed** | unit 3 / e2e 2: `NotificationExecuter owner_id on a birthday task (§2.5) answers owner_id 2147483648 as a missing owner with no query and no send (C88)`<br>`NotificationExecuter owner_id on a birthday task (§2.5) answers owner_id 99999999999 as a missing owner with no query and no send (C88)`<br>`NotificationExecuter owner_id on a birthday task (§2.5) answers owner_id 1111111111111111111111111111111111111111 as a missing owner with no query and no send (C88)`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) C88 — owner_id 99999999999: nothing sent, processed, cloned, counted as failed, not errored`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) C88 boundary — owner_id 2147483648 is a missing owner; queried: false` |
| N2-gte-at-max-int4 | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `bcb8b684953e` | 0 | **killed** | unit 1 / e2e 1: `NotificationExecuter owner_id on a birthday task (§2.5) queries an owner_id of exactly 2147483647, the largest integer`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) C88 boundary — owner_id 2147483647 is a missing owner; queried: true` |
| N3-guard-says-inactive | `src/scheduler/executers/notification.executer.ts` | `1e7d77e22883` | `c3d2917092e3` | 0 | **killed** | unit 3 / e2e 2: `NotificationExecuter owner_id on a birthday task (§2.5) answers owner_id 2147483648 as a missing owner with no query and no send (C88)`<br>`NotificationExecuter owner_id on a birthday task (§2.5) answers owner_id 99999999999 as a missing owner with no query and no send (C88)`<br>`NotificationExecuter owner_id on a birthday task (§2.5) answers owner_id 1111111111111111111111111111111111111111 as a missing owner with no query and no send (C88)`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) C88 — owner_id 99999999999: nothing sent, processed, cloned, counted as failed, not errored`<br>`Phase 7b — scheduler runner Phase 8b — a birthday task at send time (D39, D49) C88 boundary — owner_id 2147483648 is a missing owner; queried: false` |
| Z1-schema-free-zone | `src/config/env.schema.ts` | `dfdeae46686e` | `1423a75eda77` | 0 | **killed** | unit 5 / e2e 0: `one zone for write, selection and cron (C89) the environment cannot name another zone refuses TIME_ZONE="UTC" at boot`<br>`one zone for write, selection and cron (C89) the environment cannot name another zone refuses TIME_ZONE="America/Lima" at boot`<br>`one zone for write, selection and cron (C89) the environment cannot name another zone refuses TIME_ZONE="america/bogota" at boot`<br>`one zone for write, selection and cron (C89) the environment cannot name another zone refuses TIME_ZONE=" America/Bogota" at boot`<br>`one zone for write, selection and cron (C89) the environment cannot name another zone refuses TIME_ZONE="Etc/GMT+5" at boot` |
| Z2-cron-zone-utc | `src/scheduler/scheduler.runner.ts` | `1ec58c24bc31` | `be13b1e5e7b5` | 0 | **killed** | unit 2 / e2e 0: `SchedulerRunner the cron declaration is 0 10,14 * * * in America/Bogota, matching celery beat`<br>`one zone for write, selection and cron (C89) the three decisions use that one zone the cron fires in the configured zone` |
| Z3-d48-default-zone-utc | `src/users/birthday-run-date.ts` | `c1a3dcd8893e` | `63b014ced4c9` | 0 | **killed** | unit 12 / e2e 1: `UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 at the 10:00 pass (2026-09-14T15:00:00.000Z = 10:00:00.000 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 between the two passes (2026-09-14T17:30:00.000Z = 12:30 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 birthday today, 2026-09-14 one millisecond before 14:00 (2026-09-14T18:59:59.999Z = 13:59:59.999 Bogota) → 2026-09-14`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 31 December → 1 January in Bogota, while UTC is already the next day a 31 December birthday, at 13:59:59.999 on the 31st → 2026-12-31`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 29 February (D19 applies to the chosen year) on 28 February of a non-leap year before 14:00 it is the birthday today → 2027-02-28`<br>`UserService (unit) nextBirthdayRunDate — deviation D48 honours an explicit time zone instead of reading any other`<br>`one zone for write, selection and cron (C89) the three decisions use that one zone at 09:00 Bogotá, before either pass, D48 and the runner agree on which day is today (2026-09-14T14:00:00.000Z)`<br>`one zone for write, selection and cron (C89) the three decisions use that one zone at 13:30 Bogotá, when UTC is past 14:00, D48 and the runner agree on which day is today (2026-09-14T18:30:00.000Z)`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Asia/Tokyo, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`nextBirthdayRunDate under a real host zone ahead of Bogotá (D48, mutant M3) under TZ=Pacific/Kiritimati, a 31 December birthday saved at 10:00 on 31 December Bogotá is due today`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) disagrees exactly for offsets above UTC+05:00, over every birthday, quarter-hour grid`<br>`which host offsets make a host-zone year read disagree with D48 (M3, review n2) the model reproduces the Tokyo disagreement the child process measures`<br>`Phase 3 — /api/user (port of test_user_views.py) the birthdate SchedulerTask (D19, D20, Phase 7a) D48 — the next birthday not yet missed (Q47, C71) birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` |
| Z4-runner-selection-constant | `src/scheduler/scheduler.runner.ts` | `1ec58c24bc31` | `b5f4508509c4` | 0 | **killed** | unit 1 / e2e 0: `SchedulerRunner the date it asks for reads its zone from configuration, not from a constant of its own (C89)` |

**Tally, counted from the table above by `fill-doc-fr.js`, not typed:** 35 rows.

| kind | killed | survived | invalid | incomplete / not applied |
|---|---|---|---|---|
| behaviour mutants | **27** | **0** | 4 | 0 |
| blind controls (B1, B2, B3, B5) | 0 | **4** | 0 | 0 |

* behaviour, survived: —
* behaviour, invalid: E6-owner-not-excluded, M4-utc-today, M7-v1-this-year, M11-host-clock
* blind, killed: —
* B4 is counted as a behaviour mutant (§5, *Blind controls*).

**What each new mutant's kill shows**, from the failing cell names in each `meta`:

* **N1 (int4 guard dropped)** was killed by the three no-query unit cells
  (`answers owner_id 2147483648 | 99999999999 | 1…1 as a missing owner with no query and no send (C88)`),
  plus the e2e cells `C88 — owner_id 99999999999 …` and `C88 boundary — owner_id 2147483648 … queried: false`.
  Against the real column, the dropped guard turns the skip back into the P2020 throw that the review measured.
* **N2 (`>=` at `MAX_INT4`)** was killed by exactly the two cells written for the boundary:
  `queries an owner_id of exactly 2147483647, the largest integer` (unit) and
  `C88 boundary — owner_id 2147483647 is a missing owner; queried: true` (e2e). No other cell can
  see it, because both ids end as a missing owner.
* **N3 (the guard answers `owner-inactive`)** was killed by the same five cells as N1. The e2e cell
  sees it as `failedDelivery` 0 where §2.2 requires 1.
* **Z1 (`TIME_ZONE` free again)** was killed by the five refusal cells in `zone-single-source.spec.ts`
  (`UTC`, `America/Lima`, `america/bogota`, `' America/Bogota'`, `Etc/GMT+5`). The `''` refusal
  cell still passed under the mutant, because the mutant's `.min(1)` refuses the empty string too
  (checked: it is not in Z1's failing-cell list). 0 e2e cells fail, which is
  expected: the e2e harness never sets `TIME_ZONE`.
* **Z2 (cron zone UTC)** was killed by the existing `the cron declaration is 0 10,14 * * * in
  America/Bogota …` and the new `the cron fires in the configured zone`.
* **Z3 (D48's default zone UTC)** was killed by 13 cells: 12 unit, among them the new agreement cells
  at 09:00 and 13:30 Bogotá, and 1 e2e (`birthday today, saved at 13:59:59.999 Bogota …`). ⚠️ The 21:30 agreement cell did **not** fail under Z3 (checked: it is not in Z3's failing-cell list). At that instant the
  runner's "today" is the 14th in Bogotá, while UTC reads the 15th at 02:30. D48 in UTC then treats
  the 14th as already past, so it chooses next year, which is also what Bogotá chooses after 14:00.
  The two agree there by construction, so that row discriminates nothing on its own. The 09:00 and
  13:30 rows are the ones that do.
* **Z4 (the runner selects with the constant)** was killed by one cell only: the renamed
  `reads its zone from configuration, not from a constant of its own (C89)`. Under the pin this
  mutant is **production-equivalent**, because configuration can only hold the constant. The cell
  pins the plumbing, not a behaviour a deployment could observe.
* **E2 (changed definition)** was killed by the same 8 cells as in run 3.
* **B5 (blind, `>= MAX_INT4 + 1`)** survived with 0 unit and 0 e2e failures. The boundary cells
  pin behaviour, not the spelling of the comparison.

---

## 6. Questions for `business-analyst`, answered

The analyst's answers are in `docs/ba-phase-8b-birthdays.md` §3; the operator's in
`MIGRATION_PLAN.md` §9 Q51 and Q52. Recorded here as answered.

* **Q-8b-1: a save that commits after the 14:00 pass has read the table (§2.1, residual 1).**
  **Answered: accept, no margin.** It needs a birthday-day save in flight at 14:00:00; the result is
  one greeting a day late, and the chain lands on the right date afterwards. A margin would be
  worse: every save inside it would move to next year although the 14:00 pass had not run, so the
  member would *miss* this year's greeting. No operator decision needed.
* **Q-8b-2: a malformed or missing `owner_id` throws (§2.5).** **Answered: keep the loud failure.**
  ⚠️ With the analyst's correction, now applied at all three sites (**C87**): the throw **stalls**
  the chain, it does not end it. The row is released, retried and logged at every pass, and clones
  once a pass gets through. **Repair note:** whoever repairs such a row must also move `run_date`
  to the next birthday, or D7's `<=` sends a wrong-day *"hoy"*. An `owner_id` beyond `integer` is
  not in this group: it skips as a missing owner (**C88**, §2.5).
* **Q-8b-3: an owner with no `auth_user` row warns every year (§2.2).** **Answered: the yearly WARN
  is the right amount of noise**, and runbook 3a-bis should also sweep such chains. The plan records
  the sweep rewritten with a left join and a digits filter, measured read-only on `fondodev`
  (`MIGRATION_PLAN.md` v4.26). No operator decision needed (0 rows).
* **Q-8b-4: tasks 1497 and 2142 under D39.** The analyst recommended rolling both forward to the next
  birthday. **Operator decision Q51: delete both tasks** in runbook 3a and 3a-bis; 2142 must go
  before 14 November 2026 on v1 if cutover is later. A returning member is greeted again once
  their birthdate is saved (D48). **Q52: how a departed member comes back** (a direct reactivation,
  or re-invited as a new user) **is not established**; with Q51's delete, either path is greeted
  once a birthdate is saved.
* **Residual from the analyst, recorded, not fixed (§4.1 of the analyst's note): a double greeting.**
  A profile save carrying `birthdate` between the 10:00 and 14:00 passes on the member's birthday
  deletes the already-sent row (the delete takes processed rows too), and D48 writes today again
  because the 14:00 pass is still to run, so the fund is greeted twice. v1 does the same. Low
  likelihood.
* **Unchanged, recorded:** the audience is read through `fondo_api_userprofile`, like
  `get_users_attr`, so an `auth_user` without a profile receives nothing. Measured: 0 active
  users lack a profile on `fondodev`.

---

## 7. To fold back into `MIGRATION_PLAN.md` (not edited here)

* §5 **D39**: "Open: which layer" → **executer, at send time**. Missing owner → §2.2 of this
  document.
* §5 **D48**: the boundary is **strictly before 14:00:00.000 Bogotá**, with residual 1 (§2.1).
* §5 **D49**: stored `user_ids` **still parsed** (§2.3) and **still written** (§2.4).
* §7 **C71**: implemented. The Q36 cell is `test/user.e2e-spec.ts › … › Q36: saving a birthdate
  whose anniversary already passed writes next year’s run_date, with no manual insert`.
* §4 rule 5 / C28: under D48, a host-zone *year* read agrees with Bogotá on any host from UTC−12 to
  UTC+05, which includes the harness's pinned UTC. So no cell running inside jest can catch it.
  It is caught only by a child process under a zone more than ten hours ahead of Bogotá
  (`birthday-run-date.host-zone.spec.ts`, M3, §5.3). A future C28-style check on another path
  should ask the same question: which host zone makes the wrong read *disagree*?
* §7 **C87**: closed at all three sites (`notification.executer.ts` class and `parseOwnerId` docs,
  §2.5, §6 Q-8b-2), with the analyst's repair note.
* §7 **C88**: closed by fix (a). An `owner_id` above `2147483647` is answered as a missing owner with
  no query (§2.5); e2e `C88 — owner_id 99999999999 …` and the boundary pair.
* §7 **C89**: closed by pinning `TIME_ZONE` to `America/Bogota` in the schema (§2.8). §4 rule 5
  could say that the configured zone is not a deployment choice.
