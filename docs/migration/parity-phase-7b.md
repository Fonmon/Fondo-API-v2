# Parity report — Phase 7b (Scheduler runner)

**Verdict: PASS**, with five findings, none of them a row- or wire-level divergence. Every
observable difference measured in this round is either a **pre-declared** deviation
(`D7`, `P7-D1`…`P7-D5`, `docs/phase-7b-deviations.md` §6.2) or **log text only**.

| | |
|---|---|
| v1 | container `fondo-v1-p4` (`fondo-v1:parity`, Python 3.9.25, botocore 1.21.28), driven via `scheduler/tasks.py:scheduler()` |
| v2 | `~/Projects/Fondo-API-v2`, branch `feat/phase-7b-scheduler`, head **`3659eef`** (`git branch --contains 3659eef` → `feat/phase-7b-scheduler`, tree clean) |
| ORM | Prisma. **Schema fingerprint unchanged** — see System health. |
| Round date | 2026-09-07 |
| Report | this file |

> ⚠️ **This phase answers no HTTP request.** There is no route, no status code and no response
> body anywhere in this report. The subject is *task execution*: which rows flip, which clones
> appear, and which bytes reach SQS. Every cell below is a row diff plus a wire diff.

---

## 0. Data safety — what was actually done

`docs/phase-7b-deviations.md` §6.1 and the round brief both forbid pointing a runner at
`fondodev`. **They were followed literally, and then some.**

1. **Fresh `pg_dump` before the first write cell**, to persistent storage, one custom-format
   dump plus one plain SQL file per table plus a whole-database dump:
   **`~/.fondo-parity-dumps/p7b-20260907-062800-mt-pre/`** (`LATEST-P7B` points at it).
   The dump script refuses a `tmpfs` target. Nothing was written to `/tmp`.
2. ⚠️ **No execution cell ran against `fondodev` at all.** Every pass in this round ran against
   **`fondodev_p7b`**, a `pg_restore` clone of that dump, re-created before each cell.
   `reset-clone.sh`, `exec-v1.sh` and `exec-v2.sh` each carry an explicit
   `[ "$DB" = "fondodev" ] && exit 5` refusal.
   The clone was proved byte-faithful before use, not assumed: identical on counts, `max(id)`
   and all twenty sequences, and **row-for-row identical on the precious table** —
   `md5(string_agg(id|type|run_date|payload::text|processed|repeat))` =
   `08d209bf9cc94ad0215ffbe5ad5ec6ff` on both databases.
3. `fondodev` was used **read-only**, for three things only: the baseline, the P7-D1 backlog
   measurement, and the schema fingerprint.
4. **Both capture stubs asserted before every cell**, by a real HTTP round-trip, not a socket
   check — `exec-v1.sh` and `exec-v2.sh` each call `assert-capture-up.sh` and abort on a
   non-200. The asserter was itself controlled against a dead port (exit **4**, as designed).
   `SCHEDULER_ENABLED` was never set on a process pointed at `fondodev`.
5. v1's `celery beat` was never started. v1 was driven one pass at a time through
   `manage.py`-equivalent in-process calls, so the two runners were never up together.

**Closing state of `fondodev`: identical to the opening baseline** on counts, `max(id)`,
`key_activation` nulls, `xmin` cardinality **and** all twenty sequences
(`scripts/parity/fixture-check.sh`, `diff` clean), and the schedulertask row md5 is unchanged.

---

## 1. Harness, and the controls on it

Everything lives in `~/.fondo-parity-harness/p7b/`, **all seventeen scripts mode 755**
(false-green #14 was nine probes at 644).

| script | what it does |
|---|---|
| `dump.sh` | pre-write `pg_dump` of every table, refuses tmpfs |
| `start-capture.sh` / `assert-capture-up.sh` | SES/SQS capture stubs :4599 (v1) :4598 (v2); the asserter runs before **every** cell |
| `start-failstubs.sh` / `fail-capture.py` | stubs that refuse with 500, for the P7-D5 cell |
| `reset-clone.sh` | `pg_restore` the clone; `drain` / `drainall` isolation modes |
| `exec-v1.sh` / `exec-v2.sh` | one pass per side, against the clone only |
| `run-v1.py` / `run-v2.js` | in-process drivers; **application code is not modified** — `run-v1.py` monkeypatches `datetime` in the *driver*, `run-v2.js` uses the injectable clock `SchedulerRunner.run(now)` already exposes |
| `cell.py` | one parity cell: same fixture, v1 then v2, row diff + wire diff |
| `multipass.py` | N consecutive passes per side (chain collapse, P7-D3) |
| `claim-race.sh` | the deterministic claim construction (§7) |
| `guard-probe.js` | `SCHEDULER_ENABLED` guard + registered cron metadata |
| `schema.sh` | schema fingerprint (columns, constraints, indexes, sequences, tables, migration count) |

### 1.1 Positive controls — rule **C67**

| control | result |
|---|---|
| **Matrix can see a difference** — cell **A2** (D7 past-due) | `ROWS DIFFERENT`, `WIRE DIFFERENT (v1=0, v2=1)` ✅ |
| **Fixture check discriminates** — `DB=fondo_api_test scripts/parity/fixture-check.sh` | output differs from the `fondodev` baseline ✅ (and **writes nothing**, per false-green #22's reverse face) |
| **Schema probe discriminates** — same probe against `fondo_api_test` | differs ✅ |
| **Capture asserter discriminates** — same asserter pointed at a dead port | exit **4** ✅ |
| **Fail-stub really refuses** — `start-failstubs.sh` asserts HTTP 500 on both ports before the cell | ✅ |
| **Full-table diff is not blind** — PRE vs POST of the 110-row pass | 112 rows differ ✅ |
| **TZ cells are load-bearing** — same fixture evaluated under a UTC anchor | TZ2 and TZ4 flip to *not due* ✅ (TZ1 does **not** discriminate — recorded as such, not claimed as evidence) |
| **"0 tasks" cells are controlled** — TZ3 (both skip) paired with TZ5 (same row, next day, both run) | ✅ |
| **Guard cell is controlled** — `SCHEDULER_ENABLED=true` leg | logs `Running scheduler` ✅ |

### 1.2 Four harness defects found and fixed **in the probe**

Recorded because false-green #11 is "a fix to a probe has to land in the probe".

1. **Schema comparison was apples-to-oranges.** I diffed a `pg_dump --schema-only` against
   Phase 5's *catalog listing* and got a 2022-line "DIFFERS". Rebuilt the probe from
   `p5/schema.sh`; the fingerprint is in fact **identical** to the Phase 5 baseline.
2. ⚠️ **The wire extractor read only v2's protocol.** v1 (botocore 1.21.28) speaks the SQS
   **query** protocol (`Action=SendMessage&…MessageBody=…`); v2 speaks **AWS JSON 1.0**. A
   JSON-only extractor reported `MessageBody=null` for every v1 message — cell A1 first came
   back `WIRE DIFFERENT` on a payload that is byte-identical. This is a false-green generator
   in the other direction too: two `null`s compare equal. `cell.py:message_body()` now parses
   both, and the harness's own liveness ping is excluded from the message count.
3. **Isolation was lost on future-dated cells.** With `NOW` in 2027, D7's `<=` correctly pulls
   in every fixture row dated after the drain point — the month-end cells first published
   ~50 unrelated messages. Added `reset-clone.sh drainall`.
4. **The fail-stub answered XML to a JSON client**, so v2 failed on *deserialization* rather
   than on the server error. The row outcome happened to be the same, which is exactly why it
   mattered: the cell would have been evidence for the wrong thing. The stub now answers in
   the client's protocol, and the cell was re-run.

Two further probe faults **refused rather than passed**, which is the behaviour asked for:
`claim-race.sh` initially handed v1 a UTC instant it cannot parse and the runner died — caught
by the `pg_stat_activity` assertion (`RUNNER NEVER BLOCKED — REFUSING`), fixed in `exec-v1.sh`
so no caller can forget; and `reset-clone.sh` counted `psql`'s trailing `UPDATE <n>` tag as a
row and reported 111 drained instead of 110.

---

## 2. The loop — `scheduler/tasks.py`

Load today's unprocessed tasks → resolve executer by `type` → run → mark `processed` → clone
forward by `repeat`.

| # | case | request (fixture) | v1 result | v2 result | DB / side-effect delta | verdict |
|---|---|---|---|---|---|---|
| A1 | happy path | 1 row, `run_date` today 00:00 Bogota, `repeat=0`, `user_ids=[10]` | `1 tasks to process`; row → `processed=t`; 1 SQS msg | identical | rows identical; **MessageBody byte-identical**, `í`/`é` escapes and CPython `', '`/`': '` separators included | **PASS** |
| A2 | past-due row (**D7**) | 1 row, `run_date` 6 days ago | `0 tasks to process`; row untouched; **0 msg** | `1 tasks to process`; row → `processed=t`; **1 msg** | v2 flips 1 row v1 does not | **DEVIATION — pre-declared D7 / §6.2 #1.** Also this matrix's positive control |
| L1 | per-task error isolation | 3 rows, middle one `type=9` | rows 1,3 processed + cloned; row 2 untouched; error logged **between** the two sends | identical, same clone ids `2532/2533`, same log ordering | full row set identical | **PASS** |
| S1 | **scale** — 110 rows, one pass | whole `fondodev` backlog shifted onto today so both stacks see the *same* workload | `110 tasks to process`; **108** SQS msgs; 2 clones | `110 tasks to process`; **108** SQS msgs; 2 clones | **all 628 rows identical**, full-table `diff` clean; 108 message bodies identical **and in the same order** | **PASS** |

⚠️ **S1 is the cell that matters most.** Without shifting the dates, v1 processes 1 row and v2
processes 110, and "no mismatch" would be the trivial agreement of two different workloads —
the shape of false-greens #4 and #12. Shifting makes it one workload, and it also exercises
§5.2's *no `ORDER BY`* decision: 108 messages arrived in the same heap order on both stacks.

Log lines pinned by §6.3, verbatim on both stacks in every cell:
`Running scheduler` · `{n} tasks to process` · `Error processing task with id: {id}, exception: {ex}`
· `Executer type {n} does not exist.`

---

## 3. `repeat` arithmetic — `relativedelta`

Constructed explicitly, not hoped for in the fixture (the live table holds only `repeat` 0 and 4).

| # | case | source `run_date` (Bogota) | v1 clone | v2 clone | verdict |
|---|---|---|---|---|---|
| B1a | NONE (0) | 2026-09-07 | *no clone* | *no clone* | **PASS** |
| B1b | DAILY (1) | 2026-09-07 | 2026-09-08 | 2026-09-08 | **PASS** |
| B1c | WEEKLY (2) | 2026-09-07 | 2026-09-14 | 2026-09-14 | **PASS** |
| B1d | MONTHLY (3) | 2026-09-07 | 2026-10-07 | 2026-10-07 | **PASS** |
| B1e | YEARLY (4) | 2026-09-07 | 2027-09-07 | 2027-09-07 | **PASS** |
| ME1 | **31 Jan + 1 month** | 2027-01-31 | **2027-02-28** | **2027-02-28** | **PASS** |
| ME2 | **29 Feb + 1 year** | 2028-02-29 | **2029-02-28** (leap day lost) | **2029-02-28** | **PASS** |
| ME3 | **31 Mar + 1 month** | 2027-03-31 | **2027-04-30** | **2027-04-30** | **PASS** |
| ME4 | 31 Dec + 1 month (year cross, no clamp) | 2026-12-31 | 2027-01-31 | 2027-01-31 | **PASS** |
| ME5 | 31 Aug + 1 month | 2027-08-31 | 2027-09-30 | 2027-09-30 | **PASS** |
| ME6 | 29 Feb + 1 month | 2028-02-29 | 2028-03-29 | 2028-03-29 | **PASS** |
| ME7 | 28 Feb + 1 year **into** a leap year | 2027-02-28 | **2028-02-28** (does *not* become the 29th) | 2028-02-28 | **PASS** |
| ME8 | **MONTHLY chain collapse**, 4 consecutive passes | 2027-01-31 | 01-31 → **02-28 → 03-28 → 04-28 → 05-28** | identical, id for id | **PASS** |

All clone rows matched on `id`, `type`, `run_date` (both as UTC and as Bogota local),
`processed=false`, `repeat` **and** `payload::text`. ME8 is the one that needs more than one
pass: the clamped 28th becomes the *input* to the next step, so the 31st is lost permanently —
in both versions.

`CLONE-payload-bytes`: a payload containing `Ñandú "quoted" 60% ¿año? => x, ünïcode ✓`
(embedded quotes and an hstore `=>` inside a value) cloned byte-identically on both stacks —
`source.payload::text = clone.payload::text` is `true` — and rendered identically on the wire.
This is §5.3's "copy the text, do not re-encode" decision, measured.

**The brief's "31 Mar − 1 month" has no code path**: `create_repeat_instance` only ever *adds*.
ME3 covers the same clamping family in the direction v1 can actually reach.

---

## 4. The timezone anchor

v1 agrees with itself only because Django's `tzset()` makes the process zone Bogota
(`time.tzname == ('-05','-05')`, confirmed in-container). v2 has no such global.

| # | case | `run_date` (Bogota) | evaluated at | v1 | v2 | verdict |
|---|---|---|---|---|---|---|
| TZ1 | 00:30 on day N, **UTC already rolled to N+1** | 2026-09-10 00:30 | 2026-09-11 02:00Z = 2026-09-10 21:00 Bogota | runs, 1 msg | runs, 1 msg | **PASS** (⚠️ *not* discriminating — a UTC anchor agrees here) |
| TZ2 | 20:00 on day N (stored 01:00Z on N+1) | 2026-09-09 20:00 | 2026-09-09 20:00Z | **runs** | **runs** | **PASS** — a UTC anchor would have **skipped** |
| TZ3 | 00:30 on day N, evaluated on the **eve** of N | 2026-09-10 00:30 | 2026-09-10 04:00Z = 2026-09-09 23:00 Bogota | `0 tasks`, untouched | `0 tasks`, untouched | **PASS** — no early fire |
| TZ4 | 23:30 on day N (stored 04:30Z on N+1) | 2026-09-10 23:30 | 2026-09-10 15:00Z | **runs** | **runs** | **PASS** — a UTC anchor would have **skipped** |
| TZ5 | control for TZ3: same row, one day later | 2026-09-10 00:30 | 2026-09-10 15:00Z | runs, 1 msg | runs, 1 msg | **PASS** |

The load-bearing evidence is the TZ2/TZ4 control: evaluating the identical fixture with a UTC
extract instead of `AT TIME ZONE 'America/Bogota'` returns **0 due** where both stacks returned
**1 due**. So these cells would have caught a UTC anchor, and no silent skip or double-run
exists in the five-hour window where the zones disagree. Local-midnight rows are stored and
cloned as `05:00Z` throughout.

---

## 5. The silent-failure decision (**P7-D2** / **P7-D5**)

Publish forced to fail: both stacks pointed at a stub returning HTTP **500** with a
protocol-correct error body.

| | v1 | v2 |
|---|---|---|
| row `2529` | `processed = true` | `processed = true` |
| clone `2530` (`repeat=4`) | written, `2027-09-07`, `processed=false` | **identical** |
| SQS messages delivered | 0 | 0 |
| attempted request bodies | 1 distinct | **byte-identical to v1's** |
| log | `Error trying to connect to MNS service: …` | same line **+** `WARNING Task 2529 (type 0) was marked processed but its executer reported "failed" — nothing was delivered.` |
| run summary | — | `{loaded:1, processed:1, failedDelivery:1, errored:0, cloned:1}` |

**`ROWS(post): SAME`, `WIRE: SAME`.** The divergence is log output only — exactly what §3
registers. **PASS.**

Retry budgets against the refusing stub: **v1 = 5 attempts, v2 = 3**. Pre-registered as
**C22 / P2-D7** (Phase 2), not filed here.

**The `release` half of P7-D2 is proved by cells D4/D6** (below): v2 claims the row, the
executer throws, and the row comes back `processed = false` — v1's end state. **The clone not
being covered by the release** is proved by D3b: the publish succeeded, the claim held, the
clone threw, and the row stayed `processed = true` with no successor, in both stacks' shape.

---

## 6. Payload edge cases

| # | case | v1 | v2 | rows | wire | verdict |
|---|---|---|---|---|---|---|
| D4 | `payload->'message'` is **SQL NULL** | publishes `{"body": null, "target": "/d4"}`; row `processed=t` | `ERROR … exception: scheduler payload key 'message' is NULL`; row `processed=f` | differ | v1=1, v2=0 | **DEVIATION — pre-declared P7-D4 / §6.2 #4** |
| D6 | `payload->'target'` is **SQL NULL** | publishes `{"body": "d6", "target": null}` | `ERROR … key 'target' is NULL`; row `processed=f` | differ | v1=1, v2=0 | **DEVIATION — pre-declared P7-D4** |
| D5 | `message` key **absent** | `ERROR … exception: 'message'`; row untouched | `ERROR … exception: KeyError: 'message'`; row untouched | **SAME** | **SAME** (0/0) | **PASS on rows and wire; log text differs — finding F1** |
| D7k | `user_ids` key **absent** | `ERROR … exception: 'user_ids'` | `ERROR … exception: KeyError: 'user_ids'` | **SAME** | **SAME** (0/0) | **PASS; finding F1** |
| N1 | member with **no** subscription rows (`user_ids=[4, 8]`) | row `processed=t` **and cloned**; 0 msg | identical | **SAME** | **SAME** (0/0) | **PASS** — Phase 2 condition 4 / Q7 |
| N2 | unknown executer `type=1` | `ERROR … exception: Executer type 1 does not exist.`; row `processed=f`, no clone | **identical text**, row `processed=f` | **SAME** | **SAME** | **PASS** — and this is the **resolve-before-claim** proof: v2 left the row unclaimed |

---

## 7. The claim, and executer-before-claim ordering

**Constructed deterministically, not raced.** A concurrent session plays the winning runner:
`BEGIN; UPDATE … SET processed = true WHERE id = T AND processed = false;` and holds the lock.
Under READ COMMITTED the runner's `SELECT` still sees `processed = false` and loads the row;
its own `UPDATE` then blocks. **The block is asserted in `pg_stat_activity`
(`wait_event_type='Lock'`) before the commit is released** — that assertion is what makes this
a construction and not a timing bet, and the probe *refuses the cell* if the block never
appears. Then the commit lands and PostgreSQL re-evaluates the runner's predicate against the
new row version.

| | v1 | v2 |
|---|---|---|
| blocked on the row lock (asserted) | yes | yes |
| second runner publishes | **1 duplicate SQS message** | **0** |
| second runner clones | **duplicate clone `2530` written** | **none** |
| rows after | `2529 processed=t`, `2530 unprocessed` | `2529 processed=t` only |
| log | `Message sent, id: …` | `WARNING Task 2529 was already claimed by another runner; skipping. Two processes have SCHEDULER_ENABLED=true.` |
| summary | — | `{loaded:1, processed:0, skippedClaimed:1, cloned:0}` |

**DEVIATION — pre-declared §6.2 #6 and §1.** v2's `claim()` is a genuine compare-and-set and
the at-most-once claim holds. **Not flaky, and not dropped** — the outcome is decided by the
lock, not by a sleep.

**Ordering (P7-D2, and Phase 6's D12 depends on it):** cell **N2** shows an unknown `type`
leaving the row `processed = false` in v2. The executer is resolved before the claim, so an
old replica in a rolling deploy cannot consume a task type it does not know.

---

## 8. P7-D3 — out-of-range `repeat`, bounded

`repeat = 7`, three passes, on the isolated clone. **No DB check constraint exists on the
column** (verified: only `NOT NULL` and the PK), so this is reachable by hand-edit.

| pass | v1 | v2 |
|---|---|---|
| 1 (10:00) | row `2529` processed; **clone `2530` written onto the *same* `run_date`**, unprocessed | row `2529` processed; **no clone**; `ERROR Error processing task with id: 2529, exception: Repeat type 7 does not exist; refusing to clone task 2529 onto its own run_date (P7-D3).` |
| 2 (14:00, same day) | `2530` processed; **clone `2531` written, same date again** | no change |
| 3 (next day) | **no further growth** | no change |

Wire: **`SAME` (1 msg each)** — the message is published before the clone is attempted.
**DEVIATION — pre-declared P7-D3 / §6.2 #3.** v2's refusal is confirmed as the registered
behaviour, and v1's clone-onto-its-own-date is confirmed real.

⚠️ **But v1's behaviour is not what the register describes — see finding F3.**

---

## 9. Q34 / P7-D1 — the backlog, and the drain (delivery **not** in scope)

Measured on `fondodev`, read-only:

```
unprocessed rows, total                                   175
due on v2's first run (D7, `<=` today in Bogota)          110
due on v1's rule (`=` today)                                1
oldest unprocessed run_date                        2020-09-27
repeat distribution                     0 × 540, 4 × 86   (no out-of-range value)
type distribution                                    0 × 626
```

**Undrained first pass, on the restorable copy** — the blast radius, not estimated:

| | v1 | v2 |
|---|---|---|
| loaded | 1 | **110** |
| SQS messages | 1 | **108** |
| clones | 0 | 2 |

Confirms P7-D1's figures exactly. **These 108 were not delivered anywhere real** (capture stub,
clone database) and their non-delivery is **not** filed as a failure — the operator's answer to
Q34 is to drain them at cutover.

**Runbook step 3a verified against the restorable copy.** The statement in `MIGRATION_PLAN.md`
§3 Phase 9:

```sql
UPDATE fondo_api_schedulertask SET processed = true
WHERE processed = false AND run_date < now() - interval '2 days';
```

| measure | rows |
|---|---|
| A — due on v2's first run under D7 | 110 |
| B — drained by step 3a | **108** |
| B − A (drained though not due) | **0** ✅ |
| A − B (still delivered after the drain) | **2** |

The two survivors are **id 2021**, *today's* birthday task, and **id 2441**, yesterday's payment
reminder. Running v2's first pass immediately after the drain gave
`{loaded:2, processed:2, cloned:1}` and **2** SQS messages, and left **0** past-due unprocessed
rows. **The statement does what step 3a claims**, and its two-day grace window is the right
shape: it clears six years of rows v1 was never going to deliver while preserving D7 for
genuinely recent ones. See finding **F4** on the wording.

---

## 10. System health

| check | result |
|---|---|
| v2 boots (`start-v2.sh`, refuses without the capture stub) | ✅ `v2 up (GET /api/loan -> 401), SCHEDULER_ENABLED unset` |
| v1 boots (`fondo-v1-p4`, gunicorn :8451) | ✅ |
| v1 vs v2 HTTP spot-check (`/api/loan`, `/api/user`, `/api/activity`) | **401 / 401 / 404 on both** — this phase adds no route and breaks none |
| **Schema untouched** | ✅ 397-line fingerprint (columns, constraints, indexes, sequences, tables, migration count) **identical to the Phase 5 baseline** and identical before/after this round. Prisma has not reshaped anything. |
| Migrations | `_prisma_migrations` holds exactly one row, `0_init`; `django_migrations` count unchanged |
| **No stray writes** | after the 110-row pass on the clone, `xmin` cardinality is **1** on `auth_user`, `userprofile`, `loan`, `loandetail`, `notificationsubscriptions`, `activity`, `activityuser`, `power` — only `schedulertask` moved (113). Counts on all eight unchanged. |
| Cron registered | `SchedulerRegistry` → `fondo:scheduler`, `cronTime = 0 10,14 * * *`, `timeZone = America/Bogota` — read **off the registered job**, not off the constant. v1's beat: `<crontab: 0 10,14 * * *>`, `CELERY_TIMEZONE = America/Bogota`. **Match.** |
| `SCHEDULER_ENABLED` guard | unset → no log, no query, no publish. `false` → same. `true` → `Running scheduler` + `0 tasks to process`. **The §5.4 alarm is real**: a disabled process emits nothing, so `grep -c 'Running scheduler'` = **0** is the signal to watch. |
| `fondodev` after the round | **at baseline** — counts, `max(id)`, `key_activation` nulls, `xmin` cardinality, twenty sequences, and the schedulertask row md5 |

---

## 11. Findings

None of these is a row- or wire-level divergence. **None blocks the phase.**

### F1 — `KeyError` log text differs, and the deviations doc says it does not — `nestjs-developer`

`docs/phase-7b-deviations.md` §4 P7-D4 states: *"An **absent** key still raises
`KeyError: '<key>'`, exactly as v1 does."* It does not. Python renders `str(KeyError('message'))`
as `'message'` — the quotes are the repr, there is no `KeyError:` prefix:

```
v1: ERROR Error processing task with id: 2529, exception: 'message'
v2: ERROR Error processing task with id: 2529, exception: KeyError: 'message'
```

Confirmed directly in-container:
`'Error processing task with id: 1, exception: {}'.format(ex)` → `"… exception: 'message'"`.
Same for `user_ids`. **Rows and wire are identical**; §6.3 pins the error *line format*, which
is preserved. Either the message in `notification.executer.ts:requireText` becomes
`` `'${key}'` `` or the doc's claim is corrected. Repro: cells D5, D7k.

### F2 — v1's `Sending request to MNS...` info line has no v2 counterpart — `nestjs-reviewer`

`fondo_api/celery/tasks.py:15` logs it on every publish; v2 emits `Message sent, id: …` and
`Error trying to connect to MNS service: …` but not this one. **Not registered anywhere** —
`grep "Sending request to MNS" docs/*.md` returns nothing. Phase 2 origin, surfaced here
because this phase is the line's main caller. Log-only; either port it or register it.

### F3 — P7-D3's description of **v1** is wrong; its conclusion is right, and better justified than stated — `business-analyst` / `nestjs-reviewer`

§4 P7-D3 and the `scheduler.runner.ts` docstring both say an out-of-range `repeat` gives v1
*"an unprocessed twin that fires again on the next pass, forever"*. Measured, it does **not**:
the clone carries the **same `run_date`**, and v1's rule is an exact calendar-day match, so
growth stops when the day ends. Cell D3 pass 3 (next day) added nothing. v1 self-limits to
**two clones per day, on the original date only**.

The unboundedness would be **introduced by D7**: v2's `<=` makes such a twin due *every day
thereafter*, forever. So porting v1's clone-onto-its-own-date into a `<=` runner would have
been strictly worse than v1 — which makes P7-D3's refusal *more* necessary than the register
argues, not less. **The decision stands; the citation should be corrected.**

### F4 — Q34's answer and runbook step 3a's statement describe different sets — `business-analyst`

Q34 reads *"marks **every** past-due unprocessed task `processed = true`"* (110 rows). Step 3a's
SQL drains rows older than **two days** (108). The two rows the statement spares are today's
birthday task and yesterday's reminder — which is the **better** behaviour and consistent with
D7. Nothing is broken; the answer text should say "every task past due **by more than two
days**", or the runbook and the answer should be reconciled, so an operator reading Q34 does not
substitute `run_date < now()` and drain today's birthday.

### F5 — figure drift: 109 vs 110 — `nestjs-developer` (trivial)

`src/scheduler/scheduler-task.repository.ts:225` says *"`fondodev` holds 109 past-due
unprocessed rows"*. Measured today: **110**, matching `docs/phase-7b-deviations.md`, the plan's
§5 D7 row and Q34. One-character docstring drift.

### Pre-declared, **not** filed

**D7**, **P7-D1**–**P7-D5** (§6.4), and the Phase 2 retry-budget difference (**C22 / P2-D7**,
v1 = 5 attempts vs v2 = 3 on a failed publish). All were observed and all matched their
registrations.

---

## 12. Verdict per subject

| subject | verdict |
|---|---|
| The loop (load → resolve → run → mark → clone) | **PASS** — 110-row full-table diff clean, 108 messages identical and in order |
| `repeat` arithmetic, all five values | **PASS** |
| Month-end / leap-day arithmetic (7 constructed cases + 4-pass chain collapse) | **PASS** |
| Timezone anchor, midnight boundary | **PASS** — and controlled against a UTC anchor |
| Silent-failure decision (P7-D5) | **PASS** — no row, no wire byte differs; log only |
| `claim()` and executer-before-claim ordering | **PASS** — deterministic construction, at-most-once holds |
| P7-D3 out-of-range `repeat` | **PASS (deviation confirmed)** — see F3 on the citation |
| P7-D4 SQL NULL payload | **PASS (deviation confirmed)** |
| Absent payload key | **PASS on rows and wire**; log text differs — **F1** |
| No-subscription member | **PASS** |
| Unknown executer type | **PASS** |
| Q34 backlog + runbook step 3a | **PASS** — statement verified; wording finding **F4** |
| `SCHEDULER_ENABLED` guard and cron registration | **PASS** |
| System health / schema / stray writes | **PASS** |

## Phase verdict — **PASS**

Phase 7b reproduces v1's scheduler on every observable this migration is allowed to care about:
the same rows flip, the same clones appear with the same dates and byte-identical payloads, and
the same SQS bodies go out in the same order. Every difference measured is either registered in
advance or confined to log text. `fondodev` ended the round byte-identical to how it started,
and the schema was never touched.

**For `nestjs-reviewer`:** F1 and F5 are one-line corrections; F2 is a decision (port the line
or register its absence); F3 is a doc correction whose conclusion is unaffected; F4 is
`business-analyst`'s. **F3 is the one worth reading properly** — it is the only place where a
registered deviation is justified by a description of v1 that measurement does not support, and
the correction strengthens the case rather than weakening it.
