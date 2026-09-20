# Phase 4 (Loans) — **delta** parity round

**Verdict: PASS.** All four changed behaviours match their §5 register rows exactly; the
regression sweep shows the 613 lines moved **nothing else**. One documentation widening is
proposed (§6.1) and one previously-unmeasured consequence is recorded (§6.2). No new defect.

| | |
|---|---|
| **Tester** | `manual-tester` (black-box, `curl --path-as-is`) |
| **Date** | 2026-09-04 |
| **Scope** | delta against the round at `6b32687` (`docs/parity-phase-4.md`), i.e. `git diff 6b32687..a0f7e59 -- src/ test/` — 5 files, 613 insertions |
| **v1 (oracle, frozen)** | `~/Projects/Fondo-API` @ `5bef585`, bind-mounted **read-only** into container `fondo-v1-p4`, gunicorn 19.9.0 × 3 on `127.0.0.1:8451`, `api.settings.production` |
| **v2 (under test)** | `~/Projects/Fondo-API-v2`, branch `feat/phase-4-loans`, **`HEAD = 67ca73e`** — a **docs-only** commit on top of the briefed `a0f7e59` (`git diff --stat a0f7e59..HEAD` = `docs/SESSION-STATE.md` only, 1 file). **The `src/` and `test/` trees under test are byte-identical to `a0f7e59`.** Tree clean, `npm run build`, started from `p4/start-v2.sh` on `127.0.0.1:8450`, pid 62658, single process, **no restart for the whole round** |
| **ORM** | Prisma (Phase 0). Schema parity verified explicitly — see §5 |
| **Database** | the shared `fondodev`, Django migration `0019_auto_20220313_1225`, 38 `django_migrations` rows, `_prisma_migrations` `0_init` `applied_steps_count = 0` |
| **SES / SQS** | local capture stubs, `:4599` (v1, boto3 shim) and `:4598` (v2, `AWS_ENDPOINT_URL_*`). `assert_capture_up()` in force on **every** write cell. No traffic left the host |
| **Pre-write dump** | `~/.fondo-parity-dumps/p4r-20260904-121704-delta-pre/` (full `-Fc` + 24 per-table SQL + full data SQL), btrfs, **not** tmpfs |
| **Cells this round** | **≈875** across 12 matrices (4 new delta probes + 8 re-run regression matrices) |

---

## 0. Data safety — what was done, in order

1. **Before the first write**, `p4/dump.sh delta-pre` wrote the full `-Fc` dump plus one
   schema+data SQL file per table (24 tables) to a **new timestamped directory**,
   `~/.fondo-parity-dumps/p4r-20260904-121704-delta-pre/`. `dump.sh` refuses to run if the
   target `stat -f -c %T` is `tmpfs`; it reported `btrfs`.
2. **The new dump was proven to be the untouched fixture** before anything ran:

   ```bash
   diff <(grep -v '^\\restrict\|^\\unrestrict' .../p4r-20260904-121704-delta-pre/fondodev-data.sql) \
        <(grep -v '^\\restrict\|^\\unrestrict' .../p4r-20260904-061646-pre-tsv/fondodev-data.sql)
   # -> no output: nothing had touched fondodev between the two rounds
   ```

3. **The restore path was proven before it was needed, with a positive control**, not merely
   exercised: `UPDATE fondo_api_loan SET value = 12345 WHERE id = 457` → `restore.sh` →
   `SELECT value` returns `2008000`. And a clean restore's `pg_dump --data-only` came back
   byte-identical to the dump. Restores are
   `pg_restore --data-only --single-transaction` from the `-Fc` dump under
   `session_replication_role=replica`, after `TRUNCATE … RESTART IDENTITY CASCADE`.
   **No statement is ever reconstructed.**
4. Every write cell runs `restore → v1 → snapshot → restore → v2 → snapshot → restore`.
5. ⚠️ **The 28-loan auto-close hazard was live and was handled.** `zero-bytes.tsv` closed 28
   loans and deleted 235 `fondo_api_schedulertask` rows on each stack; the D33 scenario closed
   28 and deleted 237; a payout on loan 279 deleted 84. Every one restored from the dump.
6. **Closing state.** `p4/snap.sh` diffed against `BASELINE.snap`: **identical**.

```
fondo_api_loan  425   fondo_api_loandetail 374   fondo_api_schedulertask 626
fondo_api_notificationsubscriptions 94, max(id) 1468   auth_user 15   fondo_api_power 20
```

The authoritative checks, reproducible verbatim:

```sql
select count(*), count(distinct xmin::text) from fondo_api_loan;        -- 425 | 1
select count(*), count(distinct xmin::text) from fondo_api_loandetail;  -- 374 | 1
```

and, stronger:

```bash
pg_dump -h 127.0.0.1 -U fondouser -d fondodev --data-only | grep -v '^\\restrict\|^\\unrestrict' \
  | diff - <(grep -v '^\\restrict\|^\\unrestrict' ~/.fondo-parity-dumps/p4r-20260904-121704-delta-pre/fondodev-data.sql)
# -> no output.  Also byte-identical to ~/.fondo-parity-dumps/p4-20260903-160323/fondodev-data.sql
```

---

## 1. Δ1 — **D30**, `value` floored at 1 on create (`POST /api/loan`)

Probe `p4/d1-value.py`, group **A** (14 cells, `admin`, `available_quota = 30 000 000`).
Every refusal was checked for a written row, not only for a status.

| Case | Request (`value` =) | v1 | v2 | DB delta | Verdict |
|---|---|---|---|---|---|
| floor, inclusive | `1` | `201` `{"id":458}` | `201` `{"id":458}` | both write `value = 1` | **PASS** — identical |
| just above | `2` | `201` | `201` | both write `2` | **PASS** |
| ordinary | `1000` | `201` | `201` | rows content-identical | **PASS** (positive control) |
| **zero** | `0` | `201`, **row written `value = 0`** | **`400`** `{"message":"Loan value must be greater than 0"}` (47 B) | v1 +1 loan row; **v2 zero rows** | **DEVIATION — expected, §4.1 D30** |
| negative | `-1` | `201`, row `value = -1` | **`400`**, same body | v2 zero rows | **DEVIATION — expected, D30** |
| negative | `-1000` | `201`, row `value = -1000` | **`400`** | v2 zero rows | **DEVIATION — expected, D30** |
| truncates to 0 | `0.5` | `201`, row **`value = 0`** | **`400`** | v2 zero rows | **DEVIATION — expected, D30** (the bound runs on the coerced value) |
| truncates to 0 | `0.9999` | `201`, row `value = 0` | **`400`** | v2 zero rows | **DEVIATION — expected, D30** |
| truncates to 1 | `1.5` | `201`, row `value = 1` | `201`, row `value = 1` | identical | **PASS** — the floor does not over-reach |
| string, at floor | `"1"` | **`500`**, no row | `201`, row `value = 1` | — | **DEVIATION — expected, D29 (string) + D30 inclusive** |
| string, zero | `"0"` | **`500`**, no row | **`400`** | neither writes | **DEVIATION — expected, §4.1 D30-via-D29** |
| string, negative | `"-1000"` | **`500`**, no row | **`400`** | neither writes | **DEVIATION — expected, §4.1 D30-via-D29** |
| string, in range | `"1000"` | **`500`**, no row | `201`, row `1000` | — | **DEVIATION — expected, D29. Leniency INTACT** |
| over quota | `30000001` | `406` (48 B) | `406` (48 B, byte-identical) | neither writes | **PASS** — an over-quota request is still v1's 406 |

**The ordering claim was made observable, not assumed** (group **C**, `member` = user 4,
`available_quota` forced in `prep` so the mutation is part of the *starting* state):

| Case | v1 | v2 | Why it discriminates |
|---|---|---|---|
| quota `-5`, `value: 0` | `406` | **`406`** | `0 > -5` is true, so the **quota gate fires first**. A floor-first v2 would have answered `400`. It did not |
| quota `-5`, `value: -1000` | `201`, row `-1000` | **`400`** | quota gate passes (`-1000 > -5` false), then the floor binds |
| quota `0`, `value: 0` | `201`, row `0` | **`400`** | same, at the natural boundary |
| quota `0`, `value: 1` | `406` | `406` | `>` still, not `>=`-with-floor |

**Verdict: PASS.** The floor is inclusive at 1, runs on the coerced value, and runs **after**
the quota gate. Every refusal writes zero rows and pushes **zero** SQS messages (v1 pushes 1
on the cells it accepts — captured, so the comparison is not two empty stubs agreeing).

---

## 2. Δ2 — **D30** binds the refinance path

Probe `p4/d2-refinance.py`. Loan **457** (APPROVED, owner user 6 / `member6`, `LoanDetail`
id 381). `capital_balance` is forced in `prep`; `refinance_loan` sets
`new_loan['value'] = payment['capital_balance']` (`services/loan.py:134`), so this is the only
way to drive a zero-value refinance.

| Case (`capital_balance` =) | v1 | v2 | DB delta | Verdict |
|---|---|---|---|---|
| `2 008 000` (untouched), no interests | `200` `{"id":458}` | `200` `{"id":458}` | both write child `value = 2 008 000`, both set `loan 457.refinanced_loan = 458` | **PASS** (positive control) |
| `2 008 000`, **with** interests | `200` | `200` | both write `2 095 013`, both link | **PASS** |
| **`0`**, `includeInterests: false` | **`200`**, **books a zero-value loan** (`value = 0`) and links the parent | **`400`** `{"message":"Loan value must be greater than 0"}` | v1 +1 loan row + parent update; **v2 touches no table at all** | **DEVIATION — expected, §4.1 D30** |
| **`0`**, `includeInterests: true` | `200`, `value = 0` | **`400`** | same | **DEVIATION — expected, D30** |
| `1` | `200`, `value = 1` | `200`, `value = 1` | identical | **PASS** — floor inclusive on this path too |
| `2` | `200` | `200` | identical | **PASS** |
| `-500`, no interests | `200`, **books `value = -500`** | **`400`** | v2 touches no table | **DEVIATION — D30 (see §6.1)** |
| `-500`, with interests | `200`, **books `value = -522`** | **`400`** | v2 touches no table | **DEVIATION — D30 (see §6.1)** |

⚠️ **The message wording is confirmed as briefed and is NOT filed as a defect.** On a route
whose caller supplied a *loan id*, v2 answers `{"message":"Loan value must be greater than 0"}`
— byte-identical to the create path's body. Recorded as the known nit in §5 D30.

**Verdict: PASS** (expected diff). One consequence worth §4.1's attention: **v2 also leaves the
parent unlinked** — see §6.2.

---

## 3. Δ3 — **D29**, the quota boundary, **measured against the real v1**

Probe `p4/d1-value.py`, group **B**. `member` (user 4) `available_quota` forced to **500** in
`prep`. This is the cell the brief asked to close: the v1 side was previously inferred from
CPython semantics; it is now run end to end against the container.

| `value` | v1 (**measured**, not inferred) | v2 | Rows written | Verdict |
|---|---|---|---|---|
| `499` | `201` | `201` | both write `499` | **PASS** |
| `499.5` | `201` | `201` | **both write `499`** | **PASS** — truncation on the accepting side is identical |
| `500` | `201` | `201` | both write `500` | **PASS** — the check is `>`, not `>=` |
| `500.1` | **`406`** | **`406`** | **zero on both** | **PASS** |
| **`500.5`** ← *the cell* | **`406`** `{"message":"User does not have available quota"}` (48 B) | **`406`**, **byte-identical** (48 B) | **zero on both** | **PASS — the divergence is closed** |
| `500.9` | **`406`** | **`406`** | zero on both | **PASS** |
| `501` | `406` | `406` | zero on both | **PASS** |
| `"500"` | **`500`** | `201`, writes `500` | — | **DEVIATION — expected, D29 string leniency** |
| `"501"` | **`500`** | **`406`** | neither writes | **DEVIATION — expected, D29** |
| `"600"` | **`500`** | **`406`** | neither writes | **DEVIATION — expected, §4.1 D29** |

Additionally, `quota 0 / value 0.5` → **`406` on both**: the divergent window `Q < v < Q+1`
closed at the other end of the range too.

**What "identical" rests on, exactly.** Both `500.5` responses were captured with
`curl -w '%{http_code} %{size_download}'` and compared as raw strings **and** byte counts
(`48 == 48`), and the row delta is a full `json_agg` snapshot of `fondo_api_loan` before and
after each stack's request — **both empty**. The old behaviour would have shown v2 `201` with
a `fondo_api_loan` row carrying `value = 500`; that row does not exist.

**Verdict: PASS.** Exact parity on the boundary; the string divergence is intact and
deliberate.

---

## 4. Δ4 — **M3**, `updateLoanIn` as a compare-and-set

### 4.1 Single-threaded: the whole matrix re-run and diffed cell-for-cell

`p4/w3-transitions.py`, **70 cells**, each in its own restore. Diffed against the prior
round's stored `out-w3.json` on **every** field — `v1.status/bytes/body`, `v2.status/bytes/body`,
both read-back responses, the SES mail counts, and the complete row deltas of both stacks:

```
prior cells 70, delta cells 70, same cell set: True
CELLS DIFFERING FROM THE PRIOR ROUND: 0
```

The named transitions, with side effects:

| Transition | v1 | v2 | v2 tables touched | Scheduler +/− | v2 mail | Verdict |
|---|---|---|---|---|---|---|
| `0 → 1` (approve, loan 456) | `200`, 152 B | `200`, 152 B | `loan`, `loandetail` | 0 / 0 | 1 | **PASS** |
| `0 → 2` (deny) | `200`, 2 B `""` | `200`, 2 B `""` | `loan` | 0 / 0 | 1 | **PASS** |
| `1 → 3` (payout, loan 457) | `200`, 2 B | `200`, 2 B | `loan`, `schedulertask` | 0 / **2 deleted** | 0 | **PASS** |
| `1 → 2` (deny approved) | `200`, 2 B | `200`, 2 B | `loan` | 0 / 0 | 1 | **PASS** |
| **`3 → 1`** (loan 436) | `200`, 150 B, writes a `LoanDetail`, mails | **`409`** `{"message":"Invalid state transition"}` | **none** | 0 / 0 | **0** | **DEVIATION — expected, D9. PAID_OUT is terminal (D31 withdrawn)** |
| `1 → 1` (re-approve) | `200`, 152 B, second `LoanDetail`, second mail | **`409`** | **none** | 0 / 0 | **0** | **DEVIATION — expected, D9/D6** |
| `3 → 0` | `200`, 2 B | **`409`** | **none** | 0 / 0 | 0 | **DEVIATION — expected, D9** |
| `0 → -1`, `1 → -1`, `2 → -1`, `3 → -1` | `200`, state stored verbatim | **`409`** ×4 | **none** | 0 / 0 | 0 | **DEVIATION — expected, D9** |
| `0 → 3` | `200` | **`409`** | none | 0 / 0 | 0 | **DEVIATION — expected, D9** |
| `x → 4` (all four starts) | `400` (48 B) | `400` (48 B) | none | — | 0 | **PASS** |
| role matrix on 456 (7 roles × approve/deny) | — | — | — | — | — | **PASS** — 14/14 identical (`403` 63 B for PRESIDENT and MEMBER, `401` for none/bad token, `200` for ADMIN and TREASURER) |
| `approve twice` | `200` + `200`, **two `LoanDetail` rows**, **2 mails**, and `GET /api/loan/456` becomes a permanent `500` | `200` then **`409`**, **one** `LoanDetail`, **1** mail, read-back `200` | — | — | — | **DEVIATION — expected, D9/D6** |

"No mail" is measured from the capture stub, not from absence of logging: the same stub
recorded 1 mail on `0 → 1` in the same run, so an empty capture on the 409 cells is a
measurement, not a dead probe.

### 4.2 Bonus — a **deterministic** two-connection interleaving (`p4/d3-race.py`)

⚠️ **This is not a timing test and must not be read as proof that the race is impossible.**
The guarantee still rests on the query shape. What this constructs is a *specific*
interleaving, established by the database:

1. a third `psql` session takes `SELECT … FROM fondo_api_loan WHERE id = 456 FOR UPDATE` and
   holds it;
2. both `PATCH /api/loan/456 {"state":1}` requests are then started — under READ COMMITTED
   their read passes (a plain `SELECT` is not blocked by `FOR UPDATE`), both pass the
   in-process guard, and both block **on the write**;
3. the probe **refuses to proceed** until `pg_stat_activity` shows exactly two sessions with
   `wait_event_type = 'Lock'`. Only then is the lock released. If the precondition is not
   reached it reports **INCONCLUSIVE** and never a pass.

| Stack | precondition | responses | `LoanDetail` rows for 456 | SES mails | final state |
|---|---|---|---|---|---|
| **v1** | MET (2 blocked) | `200` + `200` | **2** | **2** | 1 |
| **v2** | MET (2 blocked) | `200` + **`409`** `{"message":"Invalid state transition"}` | **1** | **1** | 1 |

**Run three times; identical all three times** — no flakiness observed, and the pass does not
depend on a sleep. v1 is the positive control: it reproduces the exact lost update and the
duplicate `LoanDetail` that M3 designs out.

**Verdict: PASS.** Every single-threaded transition is byte-for-byte what the prior round
measured, and the compare-and-set answers D9's own 409 to the loser of a real interleaving.

---

## 5. Regression sweep — proving the delta is contained

| Matrix | Cells | Result | How "identical" was established |
|---|---|---|---|
| **M2** `GET /api/loan/<id>`, all 425 by id | 425 + 45 pages + 1 unpaginated | **425/425 byte-identical**, 0 differing; 28 carried `loan_detail`; unpaginated list 144 490 B on both | full body string compare + `%{size_download}`; controls: sweep saw a `loan_detail`, saw a 404, and the probe can distinguish two real loans |
| **M1** listing / pagination envelope | 86 | **0 cells differ from the prior round.** 6 v1↔v2 diffs, all **P3-D6** (`500` body: Django's 27 B HTML page vs 0 B) | per-cell diff of `status`/`bytes`/`body` against `prior/out-m1.json` |
| pagination envelope specifically | — | out-of-range `?page=44/45/100/999999` → `200 {"list":[],"num_pages":43,"count":425}`, **38 B on both**; `page=0`/`-1` → `400` 57 B on both; member `page=99` → `{"list":[],"num_pages":4,"count":36}` on both | byte counts + parsed-JSON compare |
| **W2** approvals + amortisation + email | 75 (38 approvals) | **HTTP differing 0**; `LoanDetail` rows 38 v1 / 38 v2, **0 differing on the same `loan_id`**, none written by one stack only; **emails 38/38 byte-identical**, envelope included | `sha256` of all 38 HTML bodies concatenated in loan-id order: **`994400c90ac20208d708ec9b8ceed69021a7754db77e53f6fa8091cd5654ee1e` on BOTH** — matches the stored hash exactly |
| **W5** TSV bulk upload | 23 files | **DB differing 0, auto-close-set differing 0**; **0 fields differ from the prior round** (`prior/out-w5.json` compared on responses, closed sets, scheduler +/−, detail counts and the whole row delta) | controls: zero-byte file closes **28** on both; `full.tsv` closes 0 and upserts 28 details; `jan01.tsv` writes exactly 2 scheduler rows; the close is **silent** (`SES 0/0, SQS 0/0`) |
| **W1** `POST /api/loan` | 65 | **Exactly 2 cells changed since the prior round, and both are D30**: `value=0` and `value=-5` moved v2 `201 → 400`. v1's 44 written rows are **content-identical** to the prior round; v2's written rows went 37 → 35, the two missing being **precisely** those two cells; **0** content differences among the 35 | rows keyed by their unique `comments` marker, `id`/`created_at` stripped; response bodies id-normalised |
| **W4** `POST /api/loan/<id>/refinance` | 28 | **0 fields differ from the prior round** | full per-cell JSON compare against `prior/out-w4.json` |
| **W1c** string-`value` characterisation | 12 | unchanged: `"1000"`/`" 1000 "`/`"+1000"` → v1 `500` / v2 `201`; `"30000001"` → v1 `500` / v2 `406`; `"-1000"` → v1 `500` / v2 **`400`** (D30); `"1e3"`, `"0x10"`, `"1_000"`, `"1000.7"`, `"1000abc"`, `""`, `"Infinity"` → **`500` on both** | status compare per shape |

### D33 — confirmed as observed behaviour (`p4/d4-d33.py`)

Loan 457 was closed **through the API** (`PATCH {"state":3}`, a legal `1 → 3` on both stacks)
and then left in the next TSV. Nothing was hand-mutated.

| Stage | v1 | v2 |
|---|---|---|
| reminders before | 2 (`2026-09-05`, `2026-09-09`) | 2, same |
| after the payout | **0** | **0** |
| after the TSV | **2 re-created** (`2026-12-05`, `2026-12-09`) | **2, identical** |
| `loan.state` throughout | `1 → 3 → 3` | `1 → 3 → 3` |
| `LoanDetail` after the TSV | `{total_payment 2500000, minimum_payment 250000, payday_limit 2026-12-10, interests 50000, capital_balance 1900000, from_date 2026-11-10}` | **identical** |
| auto-closed set | 28 | 28, **identical ids** |
| whole-scenario row delta | — | **identical between stacks** |

The mid-scenario query is what makes "re-created" non-vacuous: the payout demonstrably
deleted the reminders first (2 → 0) on both stacks. **PASS — both stacks behave identically;
D33 is real and ported faithfully.**

### System health

| Check | Result |
|---|---|
| v2 boots | ✅ `node dist/main.js`, pid **62658**, one `Nest application successfully started`, **no restart** across the 27 min round; all loan routes mapped (`{/api/loan, GET/POST/PATCH}`, `{/api/loan/:id, GET/PATCH}`, `{/api/loan/:id/:app, POST}`) |
| v2 environment | ✅ read from `/proc/62658/environ`: `AWS_ENDPOINT_URL_SES` / `AWS_ENDPOINT_URL_SQS` → `127.0.0.1:4598`, `NOTIFICATIONS_QUEUE_URL` → the **local** stub, `ALLOWED_HOST_DOMAIN=localhost`, `HOST_URL_APP`, `TZ=America/Bogota`, `NODE_ENV=production`. **No real-AWS endpoint anywhere** (instances #8, #9) |
| v1 boots | ✅ gunicorn 19.9.0 × 3 workers, `api.wsgi`, repo mounted `ro`; 192 tracebacks, all from deliberate 500 cells |
| v2 errors | ✅ 45 `ApiExceptionFilter` "Unhandled exception" lines, and they reconcile exactly with the deliberate 500 cells: 17 `POST /api/loan` (W1 + W1c), 7 `POST /api/loan/457/refinance` (P4-D5), 5 `PATCH /api/loan` (the five TSV 500s), 10 `PATCH /api/loan/<id>` (`state: null` / `"abc"` on four loans, plus missing-key and list). **No unexplained error** |
| migrations | ✅ `django_migrations` 38, latest `0019_auto_20220313_1225`; `_prisma_migrations` `0_init` still `applied_steps_count = 0`. **v2 ran no migration** |
| **schema byte-identical** | ✅ **all 24 tables** re-dumped `pg_dump -t public.<t>` (schema **and** data) and diffed against the pre-write per-table dumps: **0 differing**. Index/constraint list on `fondo_api_loan` / `fondo_api_loandetail` unchanged — still `btree (loan_id)` **non-unique**, i.e. D6's physical `UNIQUE (loan_id)` is correctly still deferred to Phase 9 |
| stray writes | ✅ none. D1 reports "no cell touched a table other than `fondo_api_loan`"; D2's refusals touch **no table at all**; W2 reports `other tables touched: ['fondo_api_loan','fondo_api_loandetail']` only |
| scheduler / worker | ✅ redis + `celery -A api worker` consumed v1's queued notifications and published to the stub; v2 publishes inline. Scheduler rows compared as data, not as behaviour (v2's scheduler is Phase 7b) |
| SES / SQS | ✅ 100 % captured locally, `assert_capture_up()` enforced on every write cell; `w0-smoke.py`'s four capture controls all `ok` **before** the first real write |
| fixture | ✅ restored, `snap.sh == BASELINE.snap`, whole-DB data byte-identical to the delta pre-write dump **and** to the developer's 2026-09-03 reference dump; `count(distinct xmin::text) = 1` on `fondo_api_loan` and `fondo_api_loandetail` |

---

## 6. Findings

### 6.1 §4.1's refinance row understates the rule — say `≤ 0`, not `= 0` 📄 documentation only

§4.1 reads *"`POST /api/loan/<id>/refinance` whose projected `capital_balance` is `0`"*.
Measured: a **negative** balance behaves the same way and produces a strictly worse v1 row —
v1 answers `200` and books `value = -500` (and `-522` with `includeInterests: true`, interest
on a negative balance), while v2 answers `400`. Suggested wording: *"whose projected
`capital_balance` (plus interests, if requested) is **less than 1**"*. Not a behavioural
defect; the code is right and the table is narrow. → `nestjs-reviewer`.

### 6.2 D30's refinance refusal also leaves the **parent unlinked** — worth stating in §4.1 📄

`refinance_loan` sets `loan.refinanced_loan = new_loan_id` **after** `create_loan` returns
(`services/loan.py:145-147`). When v2 refuses with D30's 400, that assignment never happens:

* v1 → `fondo_api_loan` gains a child row **and** loan 457's `refinanced_loan` becomes `458`;
* v2 → **no table is touched at all** (`tables touched: []`).

This is the correct and desirable outcome — a rejected refinance leaves no half-linked chain —
but the §4.1 row only mentions the child row, so a future round could read the missing parent
update as an unregistered difference. One clause added to that row closes it. → `nestjs-reviewer`.

### 6.3 Not filed, recorded so they are not re-raised

* **The D30 message wording on the refinance route** ("Loan value must be greater than 0" for
  a caller who sent a loan id) — confirmed present, confirmed status `400` and body
  byte-identical to the create path. Briefed as a known nit; **not** filed as a defect.
* **`value: "1"` → v1 `500` / v2 `201`** and **`value: -1` / `0.9999` → v1 `201` / v2 `400`** are
  the same §4.1 rows as `"100"` and `0` / `0.5`; listed here only so the boundary is on record
  from both sides.
* **The `500` body shape** (v1's 27 B `<h1>Server Error (500)</h1>` vs v2's 0 B) recurs in M1,
  W1, W1c, W3, W4 and W5. Registered as **P3-D6**; unchanged this round.
* **W1's "differing cells: 57"** is *not* 57 behavioural differences — the matrix runs all 65
  creates inside one restore, so each refusal shifts every later loan id. Keyed by the unique
  `comments` marker, the real change is **2 cells**. Recorded because the raw count is
  misleading.

---

## 7. Anti-false-green — what every "identical" claim rests on

This project has nineteen recorded false-green instances. Each claim above names its probe:

| Claim | The exact check |
|---|---|
| "the 500.5 cell is identical" | `curl -w '%{http_code}\n%{size_download}'` on both, raw body string equality **and** `48 == 48` bytes, plus a `json_agg` snapshot of `fondo_api_loan` before/after each stack — **both empty**. Positive control in the same matrix: `value=1000` is `201` on both with an identical row (probe can see a match) and `value=0` is `201`/`400` (probe can see a difference) |
| "the transition matrix did not move" | field-by-field JSON diff of all 70 cells against `prior/out-w3.json` (statuses, byte counts, bodies, both read-backs, mail counts, full row deltas) → **0** |
| "the email HTML is byte-identical" | `sha256` over the concatenation of all 38 captured HTML bodies in loan-id order, computed independently per stack, compared to the stored `994400c9…`. Controls: the email set is **non-empty** (a dead stub cannot "agree"), the HTML contains ≥ 36 `<tr>`, and two different loans' HTML **do** differ |
| "no mail on a 409" | measured from the same capture directory that recorded 1 mail on `0 → 1` in the same run |
| "the TSV round-trips identically" | 23 files, full row delta of `loan` / `loandetail` / `schedulertask` per stack, plus `prior/out-w5.json` diff → **0**; controls include a zero-byte file closing **28** and `jan01.tsv` writing exactly 2 scheduler rows (the scheduler leg is not inert) |
| "the race test is not timing" | the probe blocks until `pg_stat_activity` reports **2** sessions in `wait_event_type='Lock'` and reports INCONCLUSIVE otherwise; run 3× with identical results; v1 is the positive control that produces the corruption |
| "the fixture is untouched" | `snap.sh` vs `BASELINE.snap`, whole-DB `pg_dump --data-only` byte diff against the pre-write dump **and** the developer's reference dump, `count(distinct xmin::text) = 1`, and 24 per-table schema+data diffs |
| "capture was live" | `assert_capture_up()` raises before any write cell if either port is not listening; `w0-smoke.py` ran first and its four capture controls passed |

---

## 8. Reproduction

```
~/.fondo-parity-harness/p4/          # every script mode 755
  start-v1.sh  start-v2.sh  start-capture.sh   # NEVER start either stack by hand
  dump.sh  restore.sh  snap.sh  BASELINE.snap
  cmp.py  wcell.py  dcell.py  awsdec.py  capture/capture.py
  d1-value.py      # Δ1 + Δ3   -> out-d1.json   (29 cells)
  d2-refinance.py  # Δ2        -> out-d2.json   (8 cells)
  d3-race.py       # Δ4 bonus  -> out-d3.json   (deterministic interleaving)
  d4-d33.py        # D33       -> out-d4.json
  m1-listing.py m2-detail-sweep.py w1-create.py w1c-value-coercion.py
  w2-approve.py w3-transitions.py w4-refinance.py w5-tsv.py
  prior/           # the 6b32687 round's out-*.json, the regression baseline
  tsv/d33-457.tsv  # 457  2500000  250000  10/12/2026  50000  1900000  10/11/2026
~/.fondo-parity-dumps/p4r-20260904-121704-delta-pre/
```

---

## 9. Verdicts

| Behaviour / endpoint | Verdict |
|---|---|
| **Δ1 D30** — `value` floored at 1 on create | **PASS** — expected diff; inclusive at 1, on the coerced value, after the quota gate; zero rows on every refusal |
| **Δ2 D30** — the floor binds `POST /api/loan/<id>/refinance` | **PASS** — expected diff; `400` where v1 books a zero-value loan; wording nit confirmed, not filed |
| **Δ3 D29** — the quota boundary | **PASS** — `quota + 0.5` is **406 on both**, measured against the real v1, zero rows; string leniency intact |
| **Δ4 M3** — compare-and-set `updateLoanIn` | **PASS** — 70/70 single-threaded cells identical to the prior round; a deterministic interleaving gives the loser D9's 409 with one `LoanDetail` and one mail |
| **D33** — PAID_OUT loan left in a TSV | **PASS** — detail updated and reminders re-created while the loan stays PAID_OUT, identically on both stacks |
| `3 → 1` terminal (D31 withdrawn) | **PASS** — `409`, no write, no mail |
| `GET /api/loan/<id>` (425 by id) | **PASS** — 425/425 byte-identical |
| `GET /api/loan` pagination envelope | **PASS** — 86/86 unchanged from the prior round |
| `POST /api/loan` | **PASS** — exactly 2 cells changed, both D30 |
| `PATCH /api/loan/<id>` | **PASS** — 0 cells changed |
| `PATCH /api/loan` (TSV) | **PASS** — 23 files, 0 DB differences, 0 changed |
| `POST /api/loan/<id>/refinance` | **PASS** — 28 cells, 0 changed |
| approval email + `LoanDetail` | **PASS** — `sha256 994400c9…` on both |
| data safety / schema | **PASS** — 24/24 tables byte-identical, fixture restored |

**Overall delta verdict: PASS.** The four changed behaviours are exactly what §5 D29, D30 and
M3 describe; every other measured cell is byte-identical to the `6b32687` round. The delta is
contained. Two documentation widenings (§6.1, §6.2) go to `nestjs-reviewer`; nothing goes to
`nestjs-developer`.
