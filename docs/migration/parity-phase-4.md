# Phase 4 (Loans) — parity report

**Verdict: PASS** — with **one unregistered behavioural difference** (`P4-F1`, below) that is a
finding, not a blocker, plus two items routed to the reviewer.

| | |
|---|---|
| **Tester** | `manual-tester` (black-box, `curl --path-as-is`) |
| **Date** | 2026-09-04 |
| **v1 (oracle, frozen)** | `~/Projects/Fondo-API` @ `5bef585`, bind-mounted **read-only** into container `fondo-v1-p4` (image `fondo-v1:parity`), gunicorn 19.9.0 × 3 workers on `127.0.0.1:8451`, `api.settings.production`, `LANGUAGE_LOCALE='es'`, `TIME_ZONE='America/Bogota'` |
| **v2 (under test)** | `~/Projects/Fondo-API-v2`, branch `feat/phase-4-loans`, `HEAD = 6b32687` (a docs-only commit on top of the briefed `5aa8b1a` — `git show --stat 6b32687` touches `docs/SESSION-STATE.md` only), tree clean, `npm run build`, started **from `p4/start-v2.sh`** on `127.0.0.1:8450` |
| **Database** | the shared `fondodev`, Django migration `0019_auto_20220313_1225`, 38 `django_migrations` rows |
| **SES / SQS** | local capture stubs, `:4599` (v1, via a `PYTHONPATH=/probe` `boto3.client` shim — botocore 1.21.28 predates `AWS_ENDPOINT_URL_*`) and `:4598` (v2, via `AWS_ENDPOINT_URL_SES` / `AWS_ENDPOINT_URL_SQS`). **No traffic left the host.** redis 7 + `celery -A api worker` for v1's `send_notification.delay` |
| **Harness** | `~/.fondo-parity-harness/p4/` — persistent, every script **mode 755**, verified |
| **Pre-write dumps** | `~/.fondo-parity-dumps/p4r-20260904-054744-pre/` and `~/.fondo-parity-dumps/p4r-20260904-061646-pre-tsv/` (full `-Fc` dump + one plain-SQL file per table, on `/dev/mapper/root`, btrfs — **not** tmpfs) |
| **Live cells** | **≈1 580** across 15 matrices |

---

## 0. Data safety — what was done, in order

1. **Before the first write**, `p4/dump.sh pre` wrote a full custom-format dump plus one
   schema+data SQL file per table (24 tables) to `~/.fondo-parity-dumps/p4r-20260904-054744-pre/`.
   `dump.sh` **refuses to run** if the target `stat -f -c %T` is `tmpfs`.
   The dump's `fondodev-data.sql` is **byte-identical** (after stripping the random
   `\restrict` token) to the developer's reference dump `p4-20260903-160323/fondodev-data.sql`,
   which independently confirms nothing had touched `fondodev` between the two rounds.
2. **The restore path was proven before it was needed**, not after: `p4/restore.sh` ran once
   against an untouched fixture and the resulting `pg_dump --data-only` came back
   **byte-identical** to the pre-dump. Restores are `pg_restore --data-only --single-transaction`
   from the `-Fc` dump, under `session_replication_role=replica`, after
   `TRUNCATE … RESTART IDENTITY CASCADE`. **No statement is ever reconstructed.**
3. Every write cell runs `restore → v1 → snapshot → restore → v2 → snapshot → restore`.
   The `PATCH /api/loan` TSV cells got a **second, fresh dump** immediately beforehand (§4.4).
4. **Closing state** (`p4/snap.sh`, diffed against `BASELINE.snap`): identical.

```
fondo_api_loan  rows=425  distinct xmin=1
fondo_api_loandetail  rows=374  distinct xmin=1
fondo_api_schedulertask  rows=626  distinct xmin=1
fondo_api_notificationsubscriptions rows=94 max(id)=1468  distinct xmin=1
auth_user rows=15        fondo_api_power rows=20
```

The authoritative check, reproducible verbatim:

```sql
select count(*), count(distinct xmin::text) from fondo_api_loan;        -- 425 | 1
select count(*), count(distinct xmin::text) from fondo_api_loandetail;  -- 374 | 1
```

and, stronger, a whole-database comparison:

```bash
pg_dump -h 127.0.0.1 -U fondouser -d fondodev --data-only | grep -v '^\\restrict\|^\\unrestrict' \
  | diff - <(grep -v '^\\restrict\|^\\unrestrict' ~/.fondo-parity-dumps/p4r-20260904-061646-pre-tsv/fondodev-data.sql)
# -> no output: FINAL DATA BYTE-IDENTICAL TO THE PRE-WRITE DUMP
#    and also byte-identical to ~/.fondo-parity-dumps/p4-20260903-160323/fondodev-data.sql
```

⚠️ **The two hazards the brief named were both live and both were handled.**
The zero-byte TSV auto-closed **28 loans** and deleted **235 `fondo_api_schedulertask` rows**
on each stack; a payout on loan 279 deleted **84**. Every one was restored from the dump and
verified. **No probe ever touched user 1 or user 13's profile** — the D25/P4-D1 matrix is
read-only, and the only `PATCH` this round issues is `PATCH /api/loan/<id>`.

---

## 1. Scope and per-endpoint verdicts

| Endpoint | Cells | Verdict |
|---|---|---|
| `GET /api/loan` | 86 + 46 page sweep | **PASS** — envelope, `-created_at, -id` order (incl. the 16-way `created_at` tie on ids 1–16), `state=4`, out-of-range pages, `paginate`, `all_loans` all byte-identical |
| `GET /api/loan/<id>` | 425-loan sweep + 489 role cells | **PASS** — 425/425 byte-identical as ADMIN; the only diffs are **D10** (11) and **D13** (4) |
| `POST /api/loan` | 84 | **PASS with a finding** — 8 **D4** cells; every row written by both stacks is content-identical; **P4-F1** is the one unregistered diff |
| `PATCH /api/loan/<id>` | 70 | **PASS** — 28 **D9** cells, 10 **P3-D6**; every *legal* transition byte-identical incl. **P4-D3**'s two-byte `""` |
| `PATCH /api/loan` (TSV) | 44 | **PASS** — **0** DB differences over 23 files; identical upserts, identical auto-close sets, identical `SchedulerTask` rows; **D8** body as specified |
| `POST /api/loan/<id>/paymentProjection` | 420 money cells + 20 role/edge | **PASS** — 420/420 identical; diffs are **D10** only |
| `POST /api/loan/<id>/refinance` | 28 | **PASS** — linkage identical both directions; 3 **D4**, 7 **P3-D6** |
| `GET /api/user/<id>` (**D25**, **P4-D1**) | 93 | **PASS** — 21 **D25** + 9 **P4-D1**, nothing else |
| `POST /api/user/power` (**D26**, **D27**) | 23 | **PASS** — 3 **D26** + 6 **D27**; the letter's HTML is byte-identical, only **D5**'s To→Bcc differs |
| method / `OPTIONS` matrix | 120 | **PASS** — statuses identical on 120/120; 24 body-only diffs are **D21** |

---

## 2. The Phase 4 parity criteria (MIGRATION_PLAN.md §3), measured

| Criterion | Result |
|---|---|
| For ≥20 loans (varying timelimit, fee type, dates spanning month/year ends): `LoanDetail` rows identical **field for field** | ✅ **38 loans** approved on each stack. `fondo_api_loandetail` rows written: 38 v1 / 38 v2, **0 differing** on the same `loan_id`, **0** written by one stack only |
| Approval email HTML **byte-identical** | ✅ **38/38 byte-identical**, envelope included. `sha256` of all 38 HTML bodies concatenated in loan-id order: `994400c90ac20208d708ec9b8ceed69021a7754db77e53f6fa8091cd5654ee1e` on **both** (97 479 chars each) |
| Same TSV → identical upserts, identical auto-closed id set, identical `SchedulerTask` rows (dates, payloads, count) | ✅ **23 files, 0 DB differences**, 0 auto-close-set differences |
| Refinance chains link identically in both directions | ✅ identical, including Q5's concurrent-chain overwrite |
| Quota rejection and the `>36` clamp match exactly | ✅ quota `>` (not `>=`) confirmed; the clamp is **D4** and diverges by decision |
| Pagination envelope and ordering, incl. `state=4` and out-of-range pages | ✅ all 46 pages byte-identical; out-of-range returns `{list: [], num_pages, count}` on both |

### 2.1 The amortisation evidence

Reproduce with `~/.fondo-parity-harness/p4/w2-approve.py`. The 32 shapes cover timelimit
1–36 both fee types, disbursement on `2026-01-31`, `2026-02-28`, `2024-02-29`, `2020-02-29`,
`2026-03-31`, `2026-04-30`, `2026-05-30`, `2026-08-31`, `2025-12-31`, `2026-12-31`,
`2026-11-30`, `2026-10-31`, and values 1, 5, 7, 200, 3 333 333, 12 345 678, 25 871 634,
30 000 000. The 36-row table (loan id 469, 37 `<tr>`) ends:

```
<tr><td>36</td><td>$27.778</td><td>15 may. 2029</td><td>$694</td><td>$27.778</td><td>15 jun. 2029</td><td>$28.472</td><td>$-0</td></tr>
```

— v2 reproduces v1's `$-0` final balance byte for byte. Nothing was rounded differently over
36 compounding rows.

`paymentProjection` was additionally swept over **all 28 APPROVED loans × 15 `to_date`s**
(`2026-01-31`, `2026-02-28/29`, `2024-02-29`, `2026-03-01/31`, `2026-04-30`, `2026-06-30`,
`2026-08-31`, `2026-12-31`, `2027-01-01`, `2020-02-29`, `2000-01-01` and `2030-06-15`) —
**420/420 identical**, which exercises `days360`'s 30/31 rule, leap days, year rollovers and
the **negative** ranges v1 swaps.

### 2.2 The TSV evidence

The **T−5d / T−1d** `SchedulerTask` rows are identical including the awkward dates:

| file | payday_limit | run_dates written (identical on both) |
|---|---|---|
| `jan01.tsv` | 2027-01-01 | `2026-12-27T05:00:00+00`, `2026-12-31T05:00:00+00` (crosses the year) |
| `feb29.tsv` | 2024-02-29 | `2024-02-24T05:00:00+00`, `2024-02-28T05:00:00+00` (leap day) |
| `mar01.tsv` | 2026-03-01 | `2026-02-24T05:00:00+00`, `2026-02-28T05:00:00+00` (crosses into February) |
| `past-payday.tsv` | 2026-09-02 | `2026-08-28`, `2026-09-01` — **both written even though T−5d is in the past** (v1's D7 behaviour, unchanged in P4) |

Payload text (Spanish month abbreviations, `owner_id`, `user_ids`, `target`) is identical.
The auto-close is **silent on both**: `SES 0/0, SQS 0/0` on the 28-loan close.

---

## 3. §4.1 expected-diff table — every row verified

Every row of `docs/phase-4-deviations.md` §4.1 was exercised and behaves as claimed.

| §4.1 row | Cell | v1 | v2 | Verified |
|---|---|---|---|---|
| **D9** `{"state":3}` on WAITING_APPROVAL | `PATCH /api/loan/456 {"state":3}` | `200` `""` (2 B), loan → PAID_OUT | `409` `{"message":"Invalid state transition"}` (38 B), **no row change** | ✅ |
| **D9/D6** `{"state":1}` on APPROVED | `PATCH /api/loan/457 {"state":1}` | `200`, second `LoanDetail`, second email (SES 1) | `409`, **no mail (SES 0), no write** | ✅ |
| **D9** `{"state":-1}` | `PATCH /api/loan/436 {"state":-1}` | `200`, `state = -1` stored | `409` | ✅ |
| **D8** the TSV | `PATCH /api/loan` | `200`, **0 bytes** | `200` `{"closed_loans":[…]}` | ✅ 18 files |
| **D4** `timelimit: 0` | `POST /api/loan` | `201` | `400` `{"message":"Timelimit must be between 1 and 36"}` | ✅ |
| **D4** `timelimit: 37` | `POST /api/loan` | `201`, row stored with `timelimit 36`, `rate 0.025` | `400`, **no row** | ✅ |
| **D4** refinance `timelimit` 0 / >36 | `POST /api/loan/457/refinance` | **`200`** (not `201` — see §6.3), clamped/stored | `400`, no row | ✅ behaviourally; ⚠️ the doc's status is wrong |
| **D10** `GET /api/loan/<id>` non-owner MEMBER | 457 as user 4/5; 437 as user 4/6; 448 as user 4/5/6 | `200` | `403` `{"detail":"You do not have permission to perform this action."}` | ✅ 7 cells |
| **D10** `paymentProjection` non-owner MEMBER | 457, 437 | `200` | `403`, same body | ✅ 4 cells |
| **D25** `GET /api/user/<id>` other member | 3 members × 7 existing ids | `200` with `finance` | `403` | ✅ 21 cells |
| **P4-D1** `GET /api/user/<n>` non-existent, MEMBER | ids 0, 999, 99999 × 3 members | `404` (0 bytes) | `403` | ✅ 9 cells |
| **D26** self-directed power | `{"type":"post", requestee: self}` × 3 | `200`, row written, self-addressed push (SQS 1) | `406` `{"message":"Requester and requestee must be different users"}`, **no row, no push** | ✅ |
| **D27** re-approve an approved power | power 21, `{"type":"patch","state":1}` | `200` **and the fund-wide letter again (SES 1)** | `409`, **SES 0** | ✅ |
| **P4-D3** denial / legal payout body | `PATCH /api/loan/456 {"state":2}`, `PATCH /api/loan/279 {"state":3}` | `200`, body `""`, **`size_download = 2`** | `200`, body `""`, **`size_download = 2`** | ✅ **measured as a byte count, not as parsed JSON** |

### 3.1 §4.2 "explicitly unchanged" — all confirmed

| Item | Result |
|---|---|
| `timelimit: 37` → `201`, `timelimit == 36`, rate `0.025` (v1) | ✅ row `{"rate":0.025,"timelimit":36,…}` |
| Rate table `≤6→0.015 / 7–12→0.020 / 13–24→0.022 / 25–36→0.025`, frozen at request time | ✅ identical rate on every one of 37 common rows |
| Quota refusal `406 {"message":"User does not have available quota"}`; the check is `>` not `>=` | ✅ `value = 30 000 000` (== quota) → `201` on both; `30 000 001` → `406` on both |
| Quota check skipped for a refinance | ✅ refinancing the 25.8 M loan 279 with 4.1 M free → `200` on both |
| **TREASURER approving their own loan → `200`** (D28 withdrawn, Q31) | ✅ `PATCH /api/loan/456` as user 2 → `200`/`200`, identical 152-byte `LoanDetail` body |
| Order `-created_at, -id`; `state=4` = all; `all_loans` only for roles ≤ 2 and a silent no-op otherwise; `paginate`/`all_loans` compared as the exact string `'true'` | ✅ `all_loans=True` and `all_loans=1` are ignored identically; a MEMBER's `?all_loans=true` returns only their own loans, `200`, on both (**P4-D2**) |
| `?page=`, `?page=abc`, `?state=abc` → `500` (**P4-D4**) | ✅ `500` on both (body differs — P3-D6) |
| `paymentProjection` unknown loan → `404` **0 bytes**; `refinance` unknown → `400` **0 bytes** | ✅ identical, both stacks, both byte counts |
| A malformed refinance body → `500`, never 400 (**P4-D5**) | ✅ 7 cells, `500` on both |
| `PATCH /api/loan` with JSON / form / multipart-without-`file` → `500`; `text/plain` → `415` | ✅ `415` bodies byte-identical (62 B), `application/octet-stream` → `415` (76 B) identical |
| `/api/loan/<id>/` → `404`; `/api/loan/` → `200` | ✅ (404 body is D13) |
| `OPTIONS` on any loan route → `403` for every role, ADMIN included | ✅ 24/24 |
| `DELETE /api/loan` → `403` for ADMIN | ✅ |
| The auto-close is silent; its candidate set is *every* APPROVED loan absent from the file | ✅ zero-byte file closes **28/28** on both, `SES 0/0`, `SQS 0/0` |

### 3.2 §4.3 pre-declared rows — not re-filed

**D21** (HEAD bodies, 24 cells this round), **D22**, **D23** — observed and not filed.
**D13** (HTML vs JSON 404, 4 cells) and **P3-D6** (zero-byte 500 where Django renders its
27-byte HTML page, **36 cells** across M1/W1/W3/W4/W6) are pre-existing registered rows.

---

## 4. Matrices

### M1 — `GET /api/loan` (86 cells)

```
v1 status distribution: {'200': 63, '400': 8, '401': 6, '403': 3, '500': 6}
v2 status distribution: {'200': 63, '400': 8, '401': 6, '403': 3, '500': 6}
differing cells: 6      (all P3-D6: 27-byte Django HTML vs 0 bytes, status 500 on both)
```

Positive controls: both stacks answer 200 with a non-empty list; the probe detects a real
difference (`state=1` vs `state=2` bodies differ at equal status); ≥3 distinct v1 statuses.

Page sweep: **all 45 paginated pages + the unpaginated whole-fund list byte-identical**
(144 490 bytes each). Page 43 confirms rule 5c — loan 1's `created_at`
`2018-01-01T00:00:00+00` renders as **`31 dic. 2017`** on both.

### M2 — `GET /api/loan/<id>` swept over all 425 loans (471 cells)

```
v1 status distribution: {'200': 425}      v2: {'200': 425}
responses carrying loan_detail: 28        differing loan ids: 0
```

Positive controls: ≥20 `loan_detail` payloads seen; an unknown id is 404 on both; the probe
can tell two real loans apart; the unpaginated list is 144 KB (not an empty agreement).

### M3 — loan detail + `paymentProjection` roles and money (489 cells)

```
v1 status distribution: {'200': 424, '400': 31, '401': 5, '403': 14, '404': 15}
v2 status distribution: {'200': 413, '400': 31, '401': 5, '403': 25, '404': 15}
differing cells: 15   -> 11 x D10, 4 x D13
```

### M4 — `GET /api/user/<id>` (93 cells)

```
v1 status distribution: {'200': 62, '401': 13, '404': 18}
v2 status distribution: {'200': 41, '401': 13, '403': 30, '404': 9}
differing cells: 30   -> 21 x D25, 9 x P4-D1
```

`GET /api/user/-1` is unaffected on both (owner branch); a member's own record is
byte-identical; roles `[0,1,2]` keep v1's 404 on a non-existent id.

### M5 — method / `OPTIONS` matrix (120 cells)

```
v1 status distribution: {'401': 20, '403': 100}
v2 status distribution: {'401': 20, '403': 100}
differing cells: 24   -> all HEAD, body only (D21)
```

⚠️ **This matrix is uniform, which is false-green instance #4's exact shape.** It is
nevertheless the correct answer: `list_permissions` has no `OPTIONS`/`DELETE`/`PUT`/`HEAD`
entry for any loan view, so the bare `except` in `APIRolePermission.has_permission` returns
`False` — the documented deny-on-lookup-miss fallthrough. The control that distinguishes it
from a broken probe asserts that **the same routes answer 200 to `GET` as ADMIN in the same
run**, which they do.

### W1 — `POST /api/loan` (65 + 7 + 12 cells)

```
v1 status distribution: {'201': 44, '401': 2, '406': 1, '500': 18}
v2 status distribution: {'201': 37, '400': 8, '401': 2, '406': 1, '500': 17}
STATUS differences: 9   -> 8 x D4, 1 x P4-F1
rows written: v1 44, v2 37
rows written by BOTH with differing content: 0
other tables touched: none on either stack
```

Rows are keyed by a unique `comments` marker rather than by id — **D4 rejects 8 creates on
v2, which shifts every later id and would otherwise have made 37 identical rows look like 37
differences.** SQS: one push per successful create on both; on an id-aligned single create the
`MessageBody` JSON is **identical, 24 473 chars, 65 subscriptions, same `target`**.
No SES on the create path on either stack.

### W2 — approvals, amortisation, email (75 cells)

```
v1 status distribution: {'200': 38, '201': 37}    v2: identical
HTTP differing cells: 0
LoanDetail rows written: v1 38, v2 38 — 0 differing, 0 one-sided
Loan rows differing: 0        other tables touched: loan, loandetail only
approval emails: 38 / 38 — HTML differing 0, envelope differing 0
```

### W3 — `PATCH /api/loan/<id>` state transitions (70 cells)

```
v1 status distribution: {'200': 44, '400': 4, '401': 4, '403': 6, '404': 2, '500': 10}
v2 status distribution: {'200': 16, '400': 4, '401': 4, '403': 6, '404': 2, '409': 28, '500': 10}
HTTP differing: 38  ->  28 x D9,  10 x P3-D6
```

Every **legal** transition is byte-identical, DB-identical and mail-identical:
`0→1` (152 B), `0→2` (2 B `""`), `1→2` (2 B), `1→3` (2 B), including the payout on loan 279
that deletes **84** `fondo_api_schedulertask` rows on each stack. The full role matrix
(14 cells) is identical, `403`/`401` bodies included, and includes **D28**.

**D6 demonstrated end to end** — cell *approve 456 twice*:

```
v1: 200 + a SECOND fondo_api_loandetail row for loan 456 + a SECOND approval email (SES 2)
    -> GET /api/loan/456 is then a PERMANENT 500 (MultipleObjectsReturned)
v2: 409 {"message":"Invalid state transition"}, ONE detail row, SES 1
    -> GET /api/loan/456 is 200
```

### W4 — `POST /api/loan/<id>/refinance` (28 cells)

```
v1 status distribution: {'200': 12, '400': 8, '401': 1, '500': 7}
v2 status distribution: {'200': 9, '400': 11, '401': 1, '500': 7}
HTTP differing: 10  ->  3 x D4,  7 x P3-D6      DB differing: 3 (the same D4 cells)
```

Linkage, both directions, identical (v1 shown; v2 identical):

```
happy path      457.refinanced_loan = 458 ; 458.prev_loan_id = 457, payment = 2,
                disbursement_value = null, value = capital_balance (+interests when asked),
                comments = "Refinanciación del crédito #457, cuyo valor {no }incluye intereses. refi"
approve child   457.state 1 -> 3 ; 458.state -> 1
Q5 concurrent   458 and 459 both prev_loan_id = 457 ; 457.refinanced_loan ends at 459
```

Non-owner (`member`, `member5`, **ADMIN**, **TREASURER**) → `400` **0 bytes** on both.
A loan in state 0/2/3 → `400` on both. Unknown loan → `400` on both.

### W5 — `PATCH /api/loan`, the TSV (23 files)

```
v1 status distribution: {'200': 18, '500': 5}     v2: identical
DB differing: 0      auto-close-set differing: 0
```

| file | closed | LoanDetail upserts | SchedulerTask +/− | v1 | v2 |
|---|---|---|---|---|---|
| `full.tsv` (all 28) | 0 | 28 | +3 / −0 | `200` 0 B | `200` `{"closed_loans":[]}` |
| `partial3.tsv` | **25** | 3 | +1 / −103 | `200` 0 B | `200` 118 B |
| `one.tsv` | 27 | 1 | +0 / −151 | `200` 0 B | `200` 126 B |
| `zero-bytes.tsv` (0 bytes) | **28 — the whole fund** | 0 | +0 / **−235** | `200` 0 B | `200` 130 B |
| `empty.tsv` (one `\n`) | 0 | 0 | 0 | **`500`** | **`500`** |
| `crlf.tsv` / `no-trailing-nl.tsv` | 25 | 3 | +1 / −103 | `200` | `200` |
| `dup.tsv` (a loan named twice) | 26 | 2 | +1 / −105 | `200` | `200` |
| `unknown-id.tsv` (999999) | 27 | 1 | +0 / −151 | `200` | `200` |
| `unapproved-loan.tsv` (456) | 27 | 1 | +0 / −151 | `200` | `200` |
| `no-detail-loan.tsv` (441) | 27 | 1 | +0 / −151 | `200` | `200` |
| `short-line` / `bad-date` / `bad-number` / `blank-line` | — | — | — | `500` | `500` |
| `float-money`, `half-round`, `neg-money`, `spaces`, `past-payday`, `feb29`, `mar01`, `jan01` | 27 | 1 | +2 / −223 | `200` | `200` |

The **close order** in D8's body is v1's own `-created_at, -id` order:
`[457,455,454,453,452,449,447,446,445,444,443,442,440,439,438,437,435,434,433,432,431,422,418,410,407]`.
`float-money.tsv` (`1844500.6 / 294500.5 / 36167.4 / 1808333.5`) and `half-round.tsv`
(`100.5 / 101.5 / 2.5 / 3.5`) produce **identical** upserted integers on both stacks —
v1's `int(round(float(x), 0))` banker's rounding is reproduced exactly.

### W6 — `PATCH /api/loan` parsing / roles (21 cells)

```
v1 status distribution: {'200': 4, '401': 2, '403': 6, '415': 2, '500': 7}
v2 status distribution: identical
HTTP differing: 11  ->  4 x D8,  7 x P3-D6        DB differing: 0
```

### W7 — `POST /api/user/power` (20 + 3 cells)

```
v1 status distribution: {'200': 18, '500': 2}
v2 status distribution: {'200': 9, '406': 3, '409': 6, '500': 2}
HTTP differing: 9  ->  3 x D26,  6 x D27          DB differing: 7      MAIL differing: 2
```

⚠️ v1 answers only `200` or `500` here (the bare `except Exception` in `UserAppsView.post`) —
**status alone cannot discriminate on this route**, which is false-green instance #12. The
controls therefore assert on **rows written** and on **SES counts**, not on status variety.

- **§2.5 (Q30a) survives**: two requests for the same assembly to *different* requestees, and
  two to the *same* requestee, are `200` + a row on **both** stacks. No uniqueness rule exists.
- **§2.6 quirk reproduced exactly**: a **legal** `0 → 1` with `{"state": "1"}` writes `state = 1`
  and sends **no** email — `SES 0/0`, DB identical, on both stacks.
- **The power letter is byte-identical**: subject `[Fondo Montañez] Poder asamblea`, source,
  charsets and **605 chars of HTML** all equal. The only envelope difference is
  13 `ToAddresses` / 0 `Bcc` on v1 versus 0 / 13 on v2 — that is **D5** (Phase 3, registered);
  the union of recipients is the same set.

---

## 5. Findings

### P4-F1 — `POST /api/loan` accepts a numeric-string `value` that v1 refuses ⚠️ **UNREGISTERED**

**Not covered by §4.1, not in §5, not in `phase-4-deviations.md`.** Severity: low-moderate.
It is *not* a quota bypass — v2 still enforces the quota on the coerced value — but v2 creates
a loan on a request shape v1 rejects, on the fund's only quota-enforcement path.

Reproduction (`~/.fondo-parity-harness/p4/w1c-value-coercion.py`):

```bash
curl -s --path-as-is -X POST -H 'Host: localhost' \
  -H 'Authorization: Token 104cd284ce87d4e6d9ed8af19e117050561de9d1' \
  -H 'Content-Type: application/json' \
  --data-binary '{"value":"1000","timelimit":6,"disbursement_date":"2026-06-15","fee":1,"payment":1,"comments":"x","disbursement_value":1000}' \
  http://127.0.0.1:845{1,0}/api/loan
```

| `value` | v1 | v2 | v2 row written |
|---|---|---|---|
| `"1000"` | **500** `<h1>Server Error (500)</h1>`, **no row** | **201** `{"id":458}` | `value = 1000` |
| `" 1000 "` | 500, no row | **201** | `value = 1000` |
| `"+1000"` | 500, no row | **201** | `value = 1000` |
| `"-1000"` | 500, no row | **201** | `value = -1000` |
| `"30000001"` (over quota) | 500, no row | **406** `{"message":"User does not have available quota"}` | none |
| `"1e3"`, `"0x10"`, `"1_000"`, `"1000.7"`, `"1000abc"`, `""`, `"Infinity"` | 500 | 500 | none |

Cause, measured inside the v1 container:

```
>>> '1000' > UserFinance.objects.get(user_id=1).available_quota
TypeError: '>' not supported between instances of 'str' and 'int'
```

`services/loan.py:26` compares `obj['value']` against an `int` with no coercion, so v1 500s
before `Loan.objects.create` is reached. v2 coerces integer-shaped strings first.
Contrast: `timelimit` **is** coerced by v1 (`int(obj['timelimit'])`), so `"12"` is `201` on
both — the divergence is specific to `value`, and only to integer-shaped strings.

**Routing: `nestjs-developer`** (make `value` a strict number, or register the coercion),
after **`business-analyst`** decides whether accepting `"1000"` is desirable. This is one
cell's worth of change either way.

### P4-F2 — D10 and D25 authorise in **opposite** order ⚠️ for `nestjs-reviewer`, not a parity failure

`phase-4-deviations.md` §1.1 says D25 uses "**the same predicate and the same roles as D10**",
and **P4-D1** exists because "authorising after the lookup turns the endpoint into an
id-enumeration oracle, which is half of what D25 exists to close". Measured:

| request, as a MEMBER who is not the owner | v1 | v2 |
|---|---|---|
| `GET /api/user/999999` (does not exist) | 404 | **403** — authorised **before** the lookup (P4-D1) |
| `GET /api/loan/999999` (does not exist) | 404 | **404** — authorised **after** the lookup |
| `GET /api/loan/457` (exists, not theirs) | 200 | 403 |

So on `/api/loan/<id>` a MEMBER can still distinguish "this loan exists" (403) from "it does
not" (404) — the oracle D25/P4-D1 deliberately closed on `/api/user/<id>` is still open on
`/api/loan/<id>`, in the same phase, on the "same predicate". **This is not a parity failure**
(v1 and v2 both answer 404) and it is arguably the *safer* choice for parity. It is flagged
because the two rows are documented as symmetrical and are not, and because a reviewer should
decide deliberately which ordering the phase means.

### P4-F3 — §4.1's refinance row states the wrong v1 status 📄 documentation only

§4.1 says `POST /api/loan/<id>/refinance` with `timelimit: 0` or `> 36` is "**201** / clamped"
on v1. `LoanAppsView.post` returns `Response({'id': response}, status=status.HTTP_200_OK)`
(`fondo_api/views/loan.py`), and measurement confirms **200**, not 201, on every successful
refinance. The *behaviour* (clamped, row written) is as described; only the status in the doc
is wrong. `phase-4-deviations.md` §4.1 should be corrected.

### Non-findings, recorded so they are not re-raised

* **36 cells** of `500`/27-byte-Django-HTML vs `500`/0-bytes — **P3-D6**, registered.
* **4 cells** of HTML vs JSON 404 — **D13**, registered.
* **24 cells** of HEAD-with-a-body — **D21**, registered.
* The power letter's To→Bcc move — **D5**, registered (Phase 3).
* SQS wire protocol: v1 uses the AWS **query** protocol, v2 the **JSON** protocol
  (`@aws-sdk/client-sqs` 3.x). The **decoded `MessageBody` is byte-identical**; only the
  envelope encoding differs, which is an SDK-generation fact, not application behaviour.

---

## 6. Harness notes — anti-false-green

Every matrix printed its **status distribution**, not a pass count, and carried explicit
**positive controls**. All 25 probe scripts are **mode 755** (verified with
`stat -c '%a %n'`), which is instance #14's countermeasure.

**Three harness defects were found and fixed *in the probe*, not only in this report:**

| # | Defect | How it was caught | Fix, in the probe |
|---|---|---|---|
| 1 | The SES/SQS capture stubs were **never started** — `start-v1.sh` backgrounded them in a subshell that died with the script, and the smoke test compared **0 captured payloads on v1 against 0 on v2**. This is false-green **instance #9** exactly | `w0-smoke.py`'s controls *"v1 capture is non-empty"* / *"v2 capture is non-empty"* both printed `*** FAILED ***` | new `p4/start-capture.sh` that **hard-fails (exit 4)** if either port is not listening; `p4/start-v1.sh` delegates to it; `p4/wcell.py::assert_capture_up()` **refuses to run any write cell** without both stubs |
| 2 | The stub returned a **fixed `MD5OfMessageBody`**. `@aws-sdk/client-sqs` verifies that digest, so every v2 publish failed its checksum and the publisher's 3-attempt loop fired — **3 SQS records for v2 against 1 for v1**, which reads as a v2 retry defect and is a stub defect | the smoke test's per-record dump showed 3 identical v2 bodies | `capture.py` now computes `hashlib.md5(MessageBody)`; v1 and v2 both publish exactly **1** |
| 3 | `wcell.py::snapshot()` split rows on newlines, and `comments`/`payload` contain them — it reported **427** loan rows where there are 425 | the count disagreed with `snap.sh` | one JSON object per row via `json_agg`, sorted deterministically |

**Two of my own controls were wrong and were corrected in the probe, not explained away:**

* *"the empty file auto-closes the whole fund"* — `empty.tsv` was one **newline**, and
  `int('')` is a `ValueError` → `500` on **both** stacks. Replaced by two controls: a
  one-newline file is a 500 on both, **and** a genuinely **zero-byte** file closes 28 on both.
* *"the full file writes 56 scheduler rows (2 per loan)"* — `schedule_notification`
  de-duplicates on `(owner_id, type, run_date y/m/d, processed = false)`, so it writes **3**.
  Replaced by "both stacks write the **same** rows" plus a separate control on `jan01.tsv`,
  whose payday has no existing task and which therefore does write exactly **2** — proving the
  scheduler leg is not inert.

`p4/dump.sh` also refuses to write to `tmpfs`, which is the amended §7 rule made mechanical.

---

## 7. System health

| Check | Result |
|---|---|
| v1 boots | ✅ gunicorn 19.9.0 × 3, `api.settings.production`, `fondodev`; up 53 min, no crash. 228 tracebacks, all from deliberate 500 cells |
| v2 boots | ✅ `node dist/main.js`, all Phase 0–4 routes mapped (`LoanController`, `LoanDetailController`, `LoanAppsController`), Prisma connected, `production`, `ALLOWED_HOST_DOMAIN=localhost`; single process, no restart. 210 logged `ApiExceptionFilter` / `UserAppsView` errors, all from deliberate 500 cells |
| v2 environment | ✅ verified from `/proc/<pid>/environ`: `AWS_ENDPOINT_URL_SES` / `AWS_ENDPOINT_URL_SQS` → `127.0.0.1:4598`, `NOTIFICATIONS_QUEUE_URL` → the **local** stub, `HOST_URL_APP`, `TZ=America/Bogota`, `ALLOWED_HOST_DOMAIN=localhost`. **No real-AWS endpoint anywhere** (instances #8, #9) |
| migrations | ✅ `django_migrations` 38 rows, latest `0019_auto_20220313_1225`; `_prisma_migrations` `0_init` still `applied_steps_count = 0`. **v2 ran no migration** |
| schema untouched | ✅ all **24** tables re-dumped schema+data and compared against the pre-write per-table dumps: **0 differing**. No `UNIQUE (loan_id)` was added (D6's physical half is correctly deferred to Phase 9, §5.1) |
| stray writes | ✅ none. `W1`/`W2` report `other tables touched: []` beyond `fondo_api_loan` / `fondo_api_loandetail`; `W5`/`W6` report `DB differing: 0` |
| scheduler / worker | ✅ redis + `celery -A api worker` consumed every queued `send_notification` (419 log lines) and published to the capture stub. v2 publishes inline (Phase 2, condition 1). v2 has no scheduler running yet (Phase 7b) |
| SES / SQS | ✅ 100 % captured locally; no traffic left the host |
| v1 repo | ✅ untouched — bind-mounted `ro`; the boto3 shim lives at `/probe` in the throwaway container, and `/creds/gcp.json` is a placeholder `authorized_user` file never used by any Phase 4 route |
| fixture | ✅ restored and **byte-identical to the pre-write dump and to the developer's 2026-09-03 reference dump**; `count(distinct xmin::text) = 1` on `fondo_api_loan`, `fondo_api_loandetail`, `fondo_api_schedulertask`, `fondo_api_notificationsubscriptions` and `fondo_api_power` |

---

## 8. Routing

* **`nestjs-developer`** — **P4-F1** (numeric-string `value`), pending a BA call on which way.
* **`business-analyst`** — **P4-F1** (is `"1000"` an acceptable `value`?).
* **`nestjs-reviewer`** — this report, plus specifically:
  1. **P4-F2**: D10 authorises *after* the lookup, D25 *before*; the docs call them "the same
     predicate". Decide whether the loan-id oracle is intended.
  2. **P4-F3**: §4.1's refinance row says `201`; v1 answers `200`.
  3. **D8 is a response-shape change the brief did not list** (`phase-4-deviations.md` §5.3) —
     measured and correct, but the operator may not be expecting it. The bodies reach
     **130 bytes** on a whole-fund close and there is no cap (Q3).
  4. **D6's application half is confirmed working and its consequence is now measured**: on v1,
     re-approving a loan makes `GET /api/loan/<id>` a *permanent* 500. That is the recovery path
     for a wrongly auto-closed loan. The physical `UNIQUE (loan_id)` is deferred to Phase 9 —
     `fondodev` still has **0** loans with more than one detail row, so it will apply cleanly.
  5. **P4-D4's 500s are reachable from the client's own query string** (`?page=`), and v2 ports
     them faithfully. Worth a conscious "yes, still".

## 9. Reproduction

```
~/.fondo-parity-harness/p4/          # every script, mode 755
  start-v1.sh  start-v2.sh  start-capture.sh   # NEVER start either stack by hand
  dump.sh  restore.sh  snap.sh  BASELINE.snap
  cmp.py  wcell.py  awsdec.py  capture/capture.py
  m1-listing.py  m2-detail-sweep.py  m3-detail-roles.py  m4-user-detail.py  m5-options.py
  w0-smoke.py  w1-create.py  w1b-valuestring.py  w1c-value-coercion.py
  w2-approve.py  w3-transitions.py  w4-refinance.py  w5-tsv.py  w6-patch-edges.py
  w7-power.py  w7b-power-mail.py
  tsv/                                # the 23 upload fixtures
  out-*.json                          # every captured cell
~/.fondo-parity-dumps/p4r-20260904-054744-pre/
~/.fondo-parity-dumps/p4r-20260904-061646-pre-tsv/
```

**Overall phase verdict: PASS.** Every §4.1 expected diff behaves as its table claims; every
§4.2 unchanged behaviour is unchanged; the amortisation tables, `LoanDetail` rows, approval
emails, TSV upserts, auto-close sets and `SchedulerTask` rows are identical; and the fixture
is byte-identical to its pre-write dump. The single unregistered difference is **P4-F1**.
