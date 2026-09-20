# Phase 8b parity — birthday notifications (D48, D39, D49)

**Code under test:** `5e3457a` on `feat/phase-8b-birthdays` (HEAD `16a2ff6` differs from it only in
`MIGRATION_PLAN.md`; `git diff --stat 5e3457a HEAD -- src test prisma package.json package-lock.json
tsconfig*.json nest-cli.json` printed nothing). v1: `~/Projects/Fondo-API` at `5bef585`, mounted
read-only. Date of the round: 2026-09-14, 16:41–16:58 Bogotá.

## Verdict: **PASS**

Every difference measured between v1 and v2 is one D48, D39 or D49 predicts, or a Phase 3 deviation
already registered (D19, D15). Payment reminders were byte-identical: the `MessageBody` bytes, the
recipients, `processed`, and the successor row. The row-safety checks hold: fixture diff 0,
control 1, and `fondodev`'s `fondo_api_schedulertask` unchanged by count, max id, xmin cardinality and content md5.

One difference appeared in a crashed first attempt and is **explained, not a v2 defect** (§5.1). It
is an instrument hazard in how clones are reset, and it matters to the next round.

---

## 1. Harness

All under `~/.fondo-parity-harness/p8b/`. No credentials are in the repo, and no DB password was printed.

| item | what |
|---|---|
| dump | `~/.fondo-parity-dumps/p8b-20260914-164402-pre/fondodev-full.dump` (`pg_dump -Fc` of `fondodev`, sha256 `e72f9f93…`), hard-linked into `v1/`, `v2/` and `p6/`, so each clone's hstore-OID sidecar pins its own OID |
| v1 clone | `fondodev_p7b` (hstore OID 2358547) |
| v2 clone | `fondodev_p8` (hstore OID 3417907) |
| spare clone | `fondodev_p6` (2866397), used only for the order experiment in §5.1 |
| resets | `scripts/parity/reset-clone.sh` in place. Every reset exited 0 and was followed by `fixture-check.sh` against the pre-round `fondodev` output (exit 0 each time). v1 was restarted after every reset |
| v2 build | `git archive 5e3457a` → `p8b/v2-5e3457a`, `prisma generate` exit 0 and `nest build` exit 0. The repo's own `dist/` was **not used**: it is dated 12:01, before the commit, and has no `users/birthday-run-date.js` |
| v1 server | `start-v1.sh`: container `fondo-v1-p8b` (`fondo-v1:parity`), gunicorn `-w 1` on :8451. SES/SQS go through `probe/sitecustomize.py` (sha256-identical to p8r's) to the capture stub on :4599. Proxies point at `127.0.0.1:9`, and the GCS creds are p5's throwaway `authorized_user`. No beat, no worker |
| v2 server | `start-v2.sh` + `run-v2.js`: AppModule from the export on :8450, `TZ=UTC`, `SCHEDULER_ENABLED` unset, and file storage an inert fake. `PARITY_NOW` pins the `Clock` provider, used for W6 only (port 8452) |
| one pass | v1 `exec-v1.sh` → `docker exec … python /probe/run-v1.py`, which calls `fondo_api.scheduler.tasks.scheduler()` once at the live clock (sha256-identical to p7b's driver). v2 `exec-v2.sh` → `run-pass-v2.js`, which calls `SchedulerRunner.run()` once. `handleCron` is never called |
| capture | `p7b/capture.py` on :4599 (v1) and :4598 (v2), writing to `p8b/cap/{v1,v2}` |
| caller | ADMIN user 1, with its token re-keyed **on the clones only** |

**Instrument notes (measured):**
1. The first export build exited 1: 112 TS errors, while it still emitted JS. `prisma.config` needs
   `DATABASE_URL` just to load, so `prisma generate` failed and the client was never generated. It was
   rebuilt with a dummy URL (generate does not connect), and the generated `schema.prisma` equals the commit's.
   A `dist/` from a failed `nest build` looks complete; check the exit code.
2. The first write-side run crashed in **my** script: `psql -c "SET …; SELECT …"` prints a `SET` tag
   line. W1's PATCH had already run on both clones. The clones were reset and the whole matrix re-run;
   the crashed attempt's rows are kept in `out/attempt1-crashed-W1.txt` (§5.1).
3. **Process checks.** Filtering `ps -eo pid,comm,args` through `awk` on the text alone matched my own `bash -c` row (seen
   once). The filter used for cleanup drops rows whose `comm` is `awk`, `bash`, `ps` or `grep`, and matches
   `MainThread`, `gunicorn`, `npm*`, or `capture.py|run-v2.js|run-pass-v2|jest` in the args. Positive
   control: before the stop it printed the two `capture.py` and two `gunicorn` rows. Earlier in the round, a v2 server
   showed as `121703 MainThread node …/run-v2.js`. After the stop it printed nothing. ⚠️ The `jest`/`npm run`
   branch was **not** exercised by a live jest process, because I ran no jest.

---

## 2. Write side — `PATCH /api/user/<id>` with a `birthdate` (D48)

The body echoes the member's stored `first_name`, `last_name`, `email`, `identification` and `role` from **that stack's own
clone**, with a new `birthdate`, sent as ADMIN. The full `fondo_api_schedulertask` rows for the owner's birthday chain were read before
and after: `id`, `type`, `run_date` (UTC text), `payload::text`, `repeat`, `processed`. Output: `out/write-side.jsonl`.

**Clock side:** all real-clock cells ran **after 14:00 Bogotá**. v1's W1 request started at
16:50:28.371 and v2's last at 16:50:31.488 (-05:00).

| case | birthdate (owner) | v1 | v2 | expected | rest of row | how |
|---|---|---|---|---|---|---|
| W1 past | 1974-03-02 (2) | 200; `run_date 2026-03-02 05:00+00` | 200; **`2027-03-02 05:00+00`** | D48: next year | `id` 2529, `type` 0, `repeat` 4, `processed` f, `payload::text` **byte-equal**. Both deleted the 7 old chain rows | measured |
| W2 today, after 14:00 | 1997-09-14 (4) | 200; `2026-09-14 05:00+00` | 200; **`2027-09-14 05:00+00`** | D48: last pass started → next year | byte-equal (`id` 2530) | measured, 16:50:29 Bogotá |
| W2′ today, before 14:00 | — | from code: `replace(year=today_year)` → `2026-09-14` | **not measured** here. Developer cells: `test/user.e2e-spec.ts › … birthday today, saved at 13:59:59.999 Bogota: the 14:00 pass is still to run, so today` → `2026-09-14T05:00:00.000Z`, and `… saved at 14:00:00.000 Bogota: the last pass has started, so next year` → `2027-09-14T05:00:00.000Z` | D48: today (= v1) | — | cited, not measured |
| W3 future | 1974-11-03 (6) | 200; `2026-11-03 05:00+00` | 200; `2026-11-03 05:00+00` | equal | whole row byte-equal (`id` 2531) | measured |
| W4 29 Feb, chosen year non-leap | 2000-02-29 (8) | **500** `ValueError: day is out of range for month` (`services/user.py:269`). Rolled back: the 7 chain rows and `birthdate 2001-12-30` are unchanged | 200; **`2027-02-28 05:00+00`**, the 7 old rows replaced by 1 | D19 (P3, registered) × D48 | v1 wrote no row to compare | measured |
| W5 Q36 (Ainhoa) | 2020-08-05 (14) | **409**, no row. Cause measured: user 14's `email` equals user 7's `username`, and v1 still writes `username = email` | 200; **`2027-08-05 05:00+00`** | D15 (P3, registered) × D48 / Q36 | v1 wrote no row | measured |
| W6 29 Feb, chosen year **leap** | 2000-02-29 (8) | from code: in 2027, `replace(year=2027)` → 500 (D19) | **`2028-02-29 05:00+00`**, with `Clock` pinned to `2027-06-01T15:00Z` (10:00 Bogotá). Control on the same server: 1974-11-03 → `2027-11-03 05:00+00` | D19 × D48: keeps 29 Feb in a leap year | — | v2 measured with a pinned clock (harness override of the `Clock` provider); v1 from code. The real 2026 clock cannot reach a leap chosen year: its candidates are 2026 and 2027 |

**Result:** every `run_date` that differs from v1 is exactly D48's. `type`, `repeat`, `processed`, `id`
and `payload::text` were byte-equal in every case where both stacks wrote a row (W1–W3). W4 and W5 have no v1 row, for
reasons already registered in Phase 3. ⚠️ After W4 the two clones legitimately diverge: v1 rolled back and v2 did not. So W5's
`user_ids` are not comparable, and I don't compare them.

---

## 3. Send side — one pass of each executer, each against its own clone

**Setup, identical on both clones** (`seed-roundA.sql`, `seed-roundB.sql`; seed outputs `diff`-equal):
1. `ANALYZE` of `auth_user`, `fondo_api_userprofile`, `fondo_api_notificationsubscriptions` and
   `fondo_api_schedulertask` after the reset (see §5.1).
2. **Backlog neutralised.** Otherwise D7 (v2 `<=`) against v1's `=` would flood the pass. Every unprocessed row due on or before
   2026-09-14 Bogotá is set `processed = true`: 115 rows, id-list md5 `248a4538…` on both.
3. Seeds, all `type 0`, `run_date 2026-09-14 05:00+00`, unprocessed.

Subscriptions are the clone's real ones (94 rows). Endpoints and keys are never printed; each message is
identified by its body, the sha256 of its endpoint list and the sha256 of `MessageBody`. Outputs:
`out/passA-*.log`, `out/collectA-*.json`, `out/verifyA.txt`, and the same for B.

### 3.1 Round A (v1 pass 16:54:33, v2 pass 16:54:37 Bogotá)

| id | seed | v1 published (measured) | v2 published (measured) | expected | `processed` v1 / v2 | successor v1 / v2 |
|---|---|---|---|---|---|---|
| 2529 | S1 **inactive owner**: task 2142's payload verbatim (owner 15, `is_active = f`), repeat 4 | 1 message, 93 subscriptions, users {1,2,3,5,6,7,9,10,11,12,13,14} (the stored list) | **nothing**; log `Birthday of inactive member 15 not announced (D39).` | D39 | t / t | 2534 `2027-09-14 05:00+00`, payload byte-equal to 2529, on both |
| 2530 | S2 **missing owner** (`owner_id 999`, no `auth_user` row), stored `[1, 5]` | 1 message, 7 subscriptions, users {1,5} | **nothing**; `WARNING … Task 2530 (type 0) was marked processed but its executer reported "owner-missing"`; `failedDelivery=1` | D39 / §2.2 | t / t | 2535 `2027-09-14`, byte-equal, on both |
| 2531 | S3 **active owner 13, stale list** `[1, 3, 15, 2]` (3 and 15 departed) | 1 message, 68 subscriptions, users {1,2,3,15} | 1 message, **90** subscriptions, users {1,2,5,6,7,9,10,11,12,14}. Independent SQL on the clone (active, has a profile, ≠ 13) gives the same set and 90 | D49: active members minus the owner. Users 4 and 8 have 0 subscriptions | t / t | 2536 `2027-09-14`; payload byte-equal **including the stale stored list** |
| 2532 | P1 **payment reminder**, real shape, repeat 0, `owner_id 336` (a loan id), stored `[3]` (a departed member) | 1 message, 2 subscriptions, users {3}; `MessageBody` sha `1e561bec…` | **identical**: 2 subscriptions, users {3}, `MessageBody` sha `1e561bec…` | equal; no activity filter, no owner check | t / t | none on either (repeat 0) |
| 2533 | P2 **payment reminder**, repeat 3, `owner_id "15"` (an *inactive* user id), stored `[15, 9]` | 1 message, 6 subscriptions, users {9,15}; sha `b8b6af12…` | **identical**: 6 subscriptions, users {9,15}; sha `b8b6af12…` | equal | t / t | 2537 `2026-10-14 05:00+00`, byte-equal |

- **Rows after the pass:** all 9 rows with `id > 2528` are equal on both clones, field for field
  (`id, type, run_date, repeat, processed, payload::text`; `verifyA.txt`: `True n 9 9`).
- **Table totals** are equal too: count 635, max id 2537, sequence 2537, 64 unprocessed.
- **Message shape:** all 8 messages are `{subscriptions, message: {body, target}}`.
- **Wire format:** v1 sends botocore's query form and v2 sends AWS JSON; `MessageBody` is compared, not the envelope.
- **Log counts:** v1 logged `5 tasks to process` and 5 × `Message sent`. v2's summary was
  `loaded=5 processed=5 failedDelivery=1 errored=0 cloned=4`.

### 3.2 Round B — the owner is the only active member (v1 16:55:16, v2 16:55:19)

Setup on both clones: `UPDATE auth_user SET is_active = false WHERE id <> 13` (active afterwards: `13`). One seed,
2529: task 2528's payload with the stored list `[1, 2, 5]`, repeat 4.

| id | v1 published | v2 published | expected | `processed` | successor |
|---|---|---|---|---|---|
| 2529 | 1 message, 71 subscriptions, users {1,2,5} | **nothing**; summary `processed=1 failedDelivery=0 cloned=1` (`no-subscriptions` counts as ok) | D49: an empty audience | t / t | 2530 `2027-09-14 05:00+00`, payload byte-equal, on both |

The rows are equal on both clones (`verifyB.txt`: `True 2`), and so are the totals (628 / 2530 / 2530 / 61). v2's capture stub
recorded 3 messages in Round A, so its empty Round B is not a blind stub.

**Send-side result:** v1 differs from v2 exactly as D39 and D49 say. Payment reminders are equal. `processed` and
successor rows are byte-equal in every case, including the stored `user_ids` D49 says is still written.

---

## 4. Row safety

| check | command | result |
|---|---|---|
| `fondodev` fixture before the first write | `fixture-check.sh \| diff - ~/.fondo-parity-harness/p8/out/BASELINE-fondodev-2026-09-12.txt` | **exit 0** |
| control before | `DB=fondo_api_test fixture-check.sh \| diff -q - <baseline>` | **exit 1** |
| `fondodev` fixture after cleanup | same | **exit 0** |
| control after | same | **exit 1** |
| `fondodev.fondo_api_schedulertask` before / after | `count, max(id), count(DISTINCT xmin), md5(all rows, id order)` in a read-only session | `626 \| 2528 \| 1 \| 5b7e43d6…` / `626 \| 2528 \| 1 \| 5b7e43d6…` — **unchanged** |
| `fondodev.fondo_api_savingaccount` | the fixture's count (in both diffs) + after: `count, max(id), xmin` = `2 \| 3 \| 1` | count unchanged. ⚠️ max id and xmin were read **after** only, but xmin cardinality 1 means no write since the restore |
| schema | `pg_dump --schema-only` md5 of `fondodev`, before and after, and of every clone after its final reset | all `2c0e610c…` |
| clones at the end | final in-place reset of `fondodev_p7b`, `fondodev_p8` and `fondodev_p6` + fixture diff against the pre-round `fondodev` output | exit 0 ×3; reset exit 0 ×3 |
| stray processes | the filter in §1 note 3, after the stop | nothing; 0 `p8b` containers; ports 4598, 4599, 8450, 8451 and 8452 free |
| real credentials | SES/SQS: `AWS_ACCESS_KEY_ID=test`, endpoints set to the capture stubs; no SNS client in either path (`celery/tasks.py` uses SQS only; v2 `NotificationPublisher`); proxies set to `127.0.0.1:9` | no real endpoint reachable through the configured path |
| e2e suites | not run by me in this round | `fondo_api_test` was only read, by the control's `SELECT`s |

---

## 5. Differences and anomalies

### 5.1 `user_ids` order in the crashed first attempt: explained, not a v2 defect

The crashed attempt (W1, freshly reset clones, no ANALYZE) stored the same 12 ids in different orders:
- v1 `[1, 12, 5, 11, 7, 14, 4, 8, 10, 6, 9, 13]`, which is `fondo_api_userprofile` heap order;
- v2 `[10, 6, 7, 12, 5, 14, 11, 8, 9, 13, 1, 4]`, which is `auth_user` heap order.

In the measured run (attempt 2) the payloads were byte-equal. Measurements:

1. **Phase 8b did not change the query.** `11b8c5a`'s `getUserIds` has the same
   `userProfile.findMany({ where: { auth_user: { is_active: true } } })` that `findActiveMemberIds` has now.
2. **v2's SQL, as Prisma logs it,** is `SELECT user_ptr_id FROM fondo_api_userprofile LEFT JOIN auth_user j0 ON … WHERE j0.is_active = $1 AND j0.id IS NOT NULL OFFSET $2`.
   Run standalone (read-only) on `fondodev`, `fondodev_p7b` and `fondodev_p8`, it returned v1's order on all three.
3. **The order is the plan's, and the plan follows the clone's statistics.** On `fondodev_p6` right after an in-place
   reset (`relpages 0`, `reltuples -1`), **v1's own Django SQL** and v2's SQL both returned `auth_user` order.
   After `ANALYZE`, both returned userprofile order. This is the same data under the same SQL.
4. **v2 writes before it reads, and v1 reads before it writes, but the stored list is unaffected.** v2's `updateUserPersonal` runs `UPDATE auth_user` and
   `UPDATE fondo_api_userprofile` before `createBirthdateNotification`. v1 reads before `user.save()`. In a rolled-back
   transaction on `fondodev_p6` after ANALYZE:
   - read-then-write gave `1,12,5,11,2,7,14,4,8,10,6,9,13`;
   - write-then-read gave `1,12,5,11,7,14,4,8,10,6,9,13,2`.

   Only the owner moves, and the owner is then removed from the list, so the stored `user_ids` is the same.

**So:** the attempt-1 difference came from the two clones sitting in different planner-statistics states after
`reset-clone.sh`. v1 is exactly as plan-dependent as v2. **Harness recommendation, not a code change:**
`reset-clone.sh` (TRUNCATE + data-only restore) leaves `relpages`/`reltuples` in whatever state autovacuum has reached.
Any byte-comparison of an unordered list across two clones should `ANALYZE` both after the reset. This round did so before
both send-side rounds. The write-side rerun happened to match without it.

### 5.2 Other differences, each already registered

| where | v1 | v2 | register |
|---|---|---|---|
| W4 | 500, rollback | 200, `2027-02-28` | D19 (P3) × D48 |
| W5 | 409 (`username` unique) | 200, `2027-08-05` | D15 (P3) × D48 / Q36 |
| W5 sequence | `fondo_api_schedulertask_id_seq` advanced by 1 with no row (the rolled-back insert) | advanced with its row | consequence of D15; no row difference beyond it |
| log text | `Message sent, id: …` from `fondo_api.celery.tasks` | the same text from `NotificationPublisher`; plus the D39 `LOG` and the §2.2 `WARN` | P7-D6 / phase-8b §2.2 |

**No unexplained difference remains.**

---

## 6. The developer's `fondodev` claims (read-only, `default_transaction_read_only = on`)

| claim (`phase-8b-deviations.md` §2.5) | query | measured |
|---|---|---|
| 86 `type = 'birthdate'` rows | `count(*) WHERE payload->'type'='birthdate'` | **86** |
| 0 lack an `owner_id` key | `count(*) FILTER (WHERE NOT payload ? 'owner_id')` | **0** |
| 0 hold a non-decimal `owner_id` | `FILTER (WHERE payload->'owner_id' !~ '^[0-9]+$')` (NULL checked separately: 0) | **0** |
| 14 pending | `FILTER (WHERE processed = false)` | **14** |
| 0 of 14 pending have a missing owner; 2 have an inactive one (1497, 2142) | `LEFT JOIN auth_user ON id = (payload->'owner_id')::int` over the pending rows | **0 missing; 2 inactive: 1497 (owner 3, run date 2024-03-02 Bogotá) and 2142 (owner 15, 2026-11-14)**; the other 12 active |
| 0 active users lack a profile | `auth_user WHERE is_active AND NOT EXISTS profile` | **0** |

**Positive control for the predicates** (real rows can't show them firing): the same three predicates were run over
literal hstores. `owner_id=>"13"` gave f/f/f. The absent key gave t for *absent*. NULL gave t for *null*. `""`, `"-5"` and
full-width `"５"` each gave t for *non-decimal*. Control on real data: the 540 `payment_reminder` rows also read 0/0
on the same predicates.

---

## 7. For other agents

- **nestjs-developer:** nothing to fix from this round.
- **business-analyst:** nothing new.
  - Q-8b-1…4 are unaffected by these measurements.
  - W5 shows that on today's data **v1 cannot save Ainhoa's profile at all** (409, D15). So Q36's "saving her profile starts the chain" holds for v2 only, as registered.
- **nestjs-reviewer:** this report.
- **Coordinator:** the repo's `dist/` predates `5e3457a`, so any harness that loads `~/Projects/Fondo-API-v2/dist`
  runs pre-8b code until it is rebuilt.
