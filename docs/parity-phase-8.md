# Phase 8 parity report — files and admin

`manual-tester`, 2026-09-14. v2 `feat/phase-8-files` at **`de1aa25`**. `git diff --stat 5f58b11 de1aa25` changes only
`MIGRATION_PLAN.md`, so the code under test is `5f58b11`. `dist/` was rebuilt at HEAD (`npm run build` exit 0),
and `git status --short` printed 0 lines before and after the round. v1 is `~/Projects/Fondo-API` at `5bef585`,
mounted read-only, with 0 lines of `git status --short` at the end.

Routes: `GET|POST /api/file`, `GET /api/file/<id>`, `GET /api/admin`. Out of scope: C71, D39.

## Verdict

| route | verdict |
|---|---|
| `GET /api/file` | **PASS**. 23 of 23 `GET` cases (plus 5 other-method and 4 role-denied `POST` cases) match on status, `Allow`, `Vary`, storage calls and sends. The byte diffs are P8-D4 (4 cases) and D21 (1). D45 and P8-D1 appear as expected. |
| `POST /api/file` | **PASS with expected deviations**. 83 cases were run in isolated passes. 36 match on every field. All 47 diffs are classified, and **none is unexpected**. D46 and D47 conform to the spec. One wording discrepancy is flagged (§2.4). |
| `GET /api/file/<id>` | **PASS**. 16 of 16 cases match on status, `Allow`, `Vary`, storage calls and sends. The diffs are D13 (3) and D21 (1). The signed-URL structure conforms (§6). |
| `GET /api/admin` | **PASS**. 20 of 20 cases match on status, `Allow`, `Vary` and normalised sends. The diffs are D21 (2). |
| C81 (`PATCH /api/user`, `PATCH /api/loan`) | **PASS**. Both stacks process the **same content**, and all 10 row snapshots are equal (§4). |
| **Phase 8** | **PASS.** No unexpected diff. There are two documentation corrections for the reviewer (§2.4, §3.3). |

---

## 0. Harness, and how to re-run it

Everything is under `~/.fondo-parity-harness/p8r/`. The developer's `p8/` harness was read and **not reused as is**. Its
`probe/sitecustomize.py` records nothing, and `RecordingFileStorage` exists only inside Jest. I built HTTP-level
twins of both, using the same tuple format.

| file | what |
|---|---|
| `probe/sitecustomize.py` | v1: `storage.Client.get_bucket` is replaced by a fake that appends every call to `rec/v1-calls.jsonl`. `boto3.client('ses'/'sqs')` is pointed at capture `:4599`. `celery Task.delay` becomes `apply`, so no Redis is needed; only the delivery hop changes, and the SQS request is v1's own. |
| `start-v1.sh` | `fondo-v1:parity`, gunicorn `-w 1`, `POSTGRES_DATABASE=fondodev_p8`. It refuses `fondodev`. Throwaway `authorized_user` creds (`p5/creds`, client id `parity-throwaway…`). Proxies point at `127.0.0.1:9`. |
| `run-v2.js` / `start-v2.sh` | v2 is built from `dist/app.module` the way `main.ts` builds it, with **one** override: `FILE_STORAGE` becomes a recording fake (`rec/v2-calls.jsonl`). SES and SQS use the real SDK clients against capture `:4598`. `SCHEDULER_ENABLED` is unset. There is no `GOOGLE_APPLICATION_CREDENTIALS`. |
| `start-capture.sh` | `p7b/capture.py` (unchanged). It hard-fails unless both stubs answer a POST. |
| `setup.sh` | stubs up, then both stacks stopped, then `scripts/parity/reset-clone.sh fondodev_p8 <fresh dump>` (**in place**), then parity tokens for users 1 (ADMIN), 2 (TREASURER), 9 (PRESIDENT) and 5 (MEMBER), then v1 and v2 restarted, then 3 control requests. |
| `cell.py` | Raw-socket requests. For each case and stack it records status, `Allow`, `Vary`, `Content-Type`, body bytes, `fondo_api_file` (count, max id, `count(DISTINCT xmin)`), rows added, storage calls since the previous case, and SES/SQS requests since the previous case. Sends are normalised and addresses are never printed: the recipient check is the boolean `to == [caller's auth_user.email]`. |
| `cmp.py` | Pairs the cases and prints every field that differs. The only normalisation is `300.0` vs `300` in call tuples. |
| `race.py`, `sign-structure.js` | Q45 and H. |

**Fresh dump:** `~/.fondo-parity-dumps/p8r-20260914-073118-pre/fondodev-full.dump` (sha256 `d2710c76…f278`,
btrfs, `pg_dump -Fc`, read-only on `fondodev`).

**Pass structure.** Every write group ran against **one stack per pass**, each pass after its own in-place reset and
restart: W-v1, W-v2, C81-v1, C81-v2. Read-only groups ran v1 then v2 on the same state.

**Resets.** `reset-clone.sh` ran 7 times. Each run exited 0: `setup.sh` is `set -euo pipefail`, and the reset
script exits 6 if the hstore OID moves. The printed OID was `3417907`, the same as the P8 sidecar.

Raw outputs are in `out/`: `ro.jsonl`, `ro2.jsonl`, `w-v1.jsonl`, `w-v2.jsonl`, `cmp-w.txt`, `c81-v1.jsonl`, `c81-v2.jsonl`, `e2.jsonl`,
`race-v2.jsonl`, `control-*.jsonl`, `fixture-end.txt`, `lower-drift-set.json`, and `../out-sign-structure.jsonl`.

---

## 1. Parity matrix

### 1.1 Read-only group (`out/ro.jsonl`, both stacks, same state)

`python3 cmp.py out/ro.jsonl` gives **68 cases: 57 identical on every recorded field, 11 differing**. By route (status, `Allow`, `Vary`, calls and sends all equal): `/api/file` 32 of 32, `/api/file/<id>` 16 of 16, `/api/admin` 20 of 20.

| cases | v1 | v2 | DB / storage / sends | class |
|---|---|---|---|---|
| `G-all`, `G-all-slash`, `G-type0`, `G-type1`, `G-type-1`, `G-type-01`, `G-type5`, `G-type-arabic0`, `G-type-underscore`, `G-type-space`, `G-type-repeat`, `G-type-huge`, `G-type-int4max+1`, `G-type-int4min-1` | 200, identical bytes (e.g. `G-all` 2652 B) | same | no calls, `[37,43,1]` unchanged | PASS |
| `G-role-president/treasurer/member` | 200 | 200 | — | PASS |
| `G-unauth`, `G-badtoken` | 401 | 401 | — | PASS |
| `POST-role-president/treasurer/member` | 403 | 403 | 0 calls, count unchanged | PASS |
| `POST-unauth` | 401 | 401 | 0 calls | PASS |
| `F-options`, `F-put`, `F-delete`, `F-patch` | 403, 63 B | 403, 63 B | — | PASS |
| `G-type-empty`, `G-type-bare`, `G-type-abc`, `G-type-1.0` | 500, 27 B `text/html`, no `Allow`/`Vary` | 500, 0 B, no `Content-Type`, no `Allow`/`Vary` | none | **expected: §6.1 row 2 (P8-D4)** |
| `F-head-list`, `D-head`, `A-head-email`, `A-head-notifications` | 403, `Content-Length: 63`, 63 body bytes sent | 403, `Content-Length: 63`, 0 body bytes | **0 sends on both** | **expected: D21** (`Content-Length` measured equal with `curl -I` on all 3 URLs, both stacks) |
| `D-hit`, `D-hit-37`, `D-leading-zero`, `D-member`, `D-president`, `D-treasurer` | 200 `{"url":"signed://…"}`; calls `get_bucket, blob, sign(v4, 300, GET)` | identical | — | PASS |
| `D-miss0`, `D-miss-16` (a real id gap), `D-miss-huge` | 404, 0 B, 0 calls | same | — | PASS |
| `D-unauth` | 401 | 401 | — | PASS |
| `D-post`, `D-options` | 403 | 403 | — | PASS |
| `D-abc`, `D-neg`, `D-slash` | 404, 77 B Django HTML | 404, 23 B `{"message":"Not Found"}` | — | **expected: D13** |
| `A-missing`, `A-slash-missing` | 400, 0 B | same | 0 sends | PASS |
| `A-email`, `A-repeat-last-email` (`?type=x&type=email`) | 200 | 200 | 1 SES each, identical (§5) | PASS |
| `A-notifications` | 200 | 200 | 1 SQS, identical (§5) | PASS |
| `A-empty`, `A-bare`, `A-EMAIL`, `A-other`, `A-repeat-last-other` | 200 | 200 | **0 sends** | PASS |
| `A-post`, `A-put`, `A-options`, `A-role-president-email`, `A-role-treasurer-notifications`, `A-role-member-email`, `A-member-notifications` | 403 | 403 | 0 sends | PASS |
| `A-unauth-email` | 401 | 401 | 0 sends | PASS |

### 1.2 D45 and P8-D1 (`out/ro2.jsonl`)

Before these cases ran, rows were inserted **on the clone** by SQL (see `setup` in the file).

| case | v1 | v2 | class |
|---|---|---|---|
| `F-D45-u2028` (`?type=7`, name `line<U+2028>sep<U+2029>paraú`) | 200, **73 B**, body carries the literal six-character escapes `\u2028` and `\u2029` | 200, **67 B**, raw U+2028/U+2029 | **expected: §6.1 row 4 / D45.** `json.loads(v1) == json.loads(v2)` → **True**. Byte delta 6 = 2 × (6 escape bytes − 3 UTF-8 bytes). `Content-Type`, `Allow`, `Vary` equal. |
| `P8-D1-tie` (`?type=8`) | `tie-b, tie-a` | `tie-a, tie-b` | **expected: §6.1 row 1 / P8-D1.** Parsed JSON equal as sets → True. |
| `P8-D1-tie-all` | last ids `42, 43, 46, 45, 44` | `42, 43, 45, 46, 44` | same class. The byte diff is also D45: the list contains the row above. |

**The tie is real, and its control:** rows 45 (`tie-a`) and 46 (`tie-b`) were both given `created_at = 2026-09-14 12:00:00+00`. I then
ran `UPDATE … SET display_name = display_name WHERE display_name='tie-a'`, which moved `tie-a` to ctid `(0,41)` after `tie-b` `(0,40)`. Raw
`SELECT … WHERE type=8 ORDER BY created_at` returned **`tie-b, tie-a`**, and `ORDER BY created_at, id` returned `tie-a, tie-b`. v1
matched the first order and v2 the second.

### 1.3 `POST /api/file` write group (`out/w-v1.jsonl`, `out/w-v2.jsonl`, isolated passes)

`python3 cmp.py out/w-v1.jsonl out/w-v2.jsonl > out/cmp-w.txt`: **83 cases, 36 identical on every field, 47 differ.**
A second pass re-compared the rows added by `(type, display_name)` only, together with the per-case deltas of count and `xmin`
cardinality, the calls and the stored objects. **69 of 83** are identical on all of those. The **14** that are not are all D46 or D47 cases, below.

**Identical on every field (36):** `P-json-missing-file`, `P-json-all-keys` (500 after `get_bucket, blob, exists`),
`P-json-list-keys`, `P-json-list-partial`, `P-json-string-keys`, `P-json-string-partial`, `P-json-number`, `P-json-null`,
`P-json-empty-obj`, `P-json-name-number`, **`Z-json-type-1.5`** and **`Z-json-type-true`** (500 after `exists`, unchanged
per §6.2), `P-json-malformed`, `P-text-plain` (500, rule 12b), `P-form`, `P-form-missing`, `P-empty-body`,
`P-mp-no-boundary`, `E-mp-trailing-space-boundary` (see §3.3), `P-mp-missing-file`, `P-mp-missing-name`,
`P-mp-missing-type`, **`P-presence-first-missing-name-type-abc`** and **`P-presence-first-missing-file-type-5`** (bodiless 400
on both, 0 calls, §6.1 row 9), **`M2-scalar-file`** (500 on both after `get_bucket, blob, exists`), `M2-empty-filename`,
`M2-scalar-then-file` / `M2-file-then-scalar` (the **part** is uploaded on both), **`M2-two-file-parts`** (`SECOND` is stored
on both), `M2-name-as-file`, `M2-name-scalar-and-file` (500 after `get_bucket`), `M2-repeated-name` (last value),
**`M1-new`**, **`M1-again-overwrite`**, **`P8-F2-case-variant-same-type`** (§3.2), **`Q41-existing-row-no-blob`** (500 after
upload on both; object stored; no row).

**The 47 diffs, all classified:**

| # | cases | v1 | v2 | class |
|---|---|---|---|---|
| a | `P-json-type-list`, `Z-json-type-null`, `M2-type-as-file`, `M2-type-scalar-and-file`, `D47-ref-fullwidth-plus1`, `D47-ref-x1c1`, `D47-ref-abc`, `D47-ref-1.0`, `D47-ref-empty`, `D47+D46-abc` (10) | 500 bodiless, 0 calls | **400** `{"message":"Type must be 0 or 1"}` (33 B, `Allow` + `Vary: Accept, Origin`), 0 calls | **§6.1 row 8 (D47)**; `D47+D46-abc` is **row 9** |
| b | `Z-json-type-2` | 500 after `get_bucket, blob(2/zj two), exists` | 400 D47, **0 calls** | **row 8** |
| c | `D47-ref-1_0`, `D47-ref-neg1`, `D47-ref-arabic3`, `D47-ref-2`, `D47-ref-int4max` (5) | **201**, object stored at `10/…`, `-1/…`, `3/…`, `2/…`, `2147483647/…`, row added with that type | 400 D47, 0 calls, no row | **row 8** |
| d | `D47-ref-int4max+1`, `D47-ref-int4min-1`, `D47+D46-5` (3) | 500 **after upload**; object stored, no row | 400 D47, 0 calls | **row 8**; `D47+D46-5` is **row 9** |
| e | `D46-M3-cross-type` | 500 after upload of `presentations/new file` (orphan) | **409** `{"message":"A file with this name already exists with a different type"}` (72 B, `Allow` + `Vary: Accept, Origin`), **0 calls** | **row 7 (D46)** |
| f | `D46-M3-cross-type-retry` | **201**, overwrites the orphan, no row | 409, 0 calls | **row 7** |
| g | `D46-live-cross` (`Resultados 2012` as type 0, live data) | 500 after upload, orphan `proceeding/resultados 2012` | 409, 0 calls | **row 7** |
| h | `Q44-dupx-t1-refused` | **201**, overwrites `presentations/dup x` (DUP X's object), no row | 409, 0 calls | **row 7** (Q44) |
| i | `Z-json-cross-type-name` | 500 after `get_bucket, blob, exists` | 409, 0 calls | **row 7** ("a JSON body naming such a file") |
| j | `E-mp-nonascii-boundary` | 500, gunicorn 141 B `text/html`, no `Allow`, no `Vary` | **400** `{"detail":"Multipart form parse error - Invalid boundary in multipart: zzé"}` (77 B), `Allow` + `Vary: Accept, Origin` | **row 3 (D22, C79)** |
| k | `E-mp-empty-boundary` | 500, 141 B `text/html`, no `Allow`, **no `Vary`** | 500, 0 B, no `Allow`, **`Vary: Origin`** | **row 2 (P8-D4)**; see §2.4 for the header wording |
| l | `D46-case-variant-other-type`, `D46-trailing-space-other-type`, `Q44-dupx-t0`, `Q44-DUPX-t1`, the 6 `D47-acc-*`, `M7-sigma-dotted-I`, `M7-drift-1C89`, `M7-empty-name`, `CT-absent`, `CT-params` (15) | 201; identical calls, stored objects and `(type,name)` row | same | **ids only**: v1's max id runs 2 ahead from `D46-case-variant-other-type` (53 vs 51), and later more, because v1's doomed INSERTs in e, g, d consumed sequence values that v2 never requests. Expected, as the consequence of rows 7/8 under **D37** (sequence-only diff). |
| m | `N-nul-name`, `D-after-new-file` (2) | identical status, body, calls and stored objects | same | `file_before/after` differ only through (l); expected |
| n | `G-after`, `G-after-type-neg1` | 4328 B | 4037 B | v1 lists 5 extra rows — `d47 arabic3` (3), `d47 int4max` (2147483647), `d47 neg1` (−1), `d47 two` (2), `d47 us10` (10). v2 lists no row v1 lacks. With those 5 removed, v1's order equals v2's. **Row 8 consequence.** |
| o | `G-after-type3`, `G-after-type10` | 200, one row each | 200 `[]` | **row 8 consequence** |

**Unexpected diffs: 0.**

### 1.4 Boundary follow-up (`out/e2.jsonl`)

This ran v1 then v2 on the same state; see §3.3.

| case | v1 | v2 | class |
|---|---|---|---|
| `E-mp-quoted-trailing-space-boundary` (`boundary="zzz "`) | 500, 141 B HTML, no `Allow`, no `Vary`, 0 calls | 500, 0 B, no `Allow`, `Vary: Origin`, 0 calls | expected, P8-D4 (same shape as 1.3 k) |
| `E-mp-empty-boundary-again` | same as 1.3 k | same | expected, P8-D4 |
| `E-mp-unquoted-trailing-space-boundary-control` | 201, row `utsb` | 500 after upload | **instrument artefact, not a diff**. v2 ran second, on a DB where v1 had already inserted `utsb`, so it took the Q41 path (row exists, object missing in v2's fake). In isolation (1.3, `E-mp-trailing-space-boundary`) the same request is **201/201, identical**. |

---

## 2. D46 and D47 against the spec (and against v1)

### 2.1 D46

| spec point | measured | result |
|---|---|---|
| exact `display_name` under the other type → **409** with the §5 message and **zero storage calls** | `D46-M3-cross-type`, `D46-M3-cross-type-retry`, `D46-live-cross`, `Q44-dupx-t1-refused`, `Z-json-cross-type-name`: 409, body `{"message":"A file with this name already exists with a different type"}` byte-exact, `calls: []`, `stored: []`, count and `xmin` cardinality unchanged | **conforms** |
| same name, same type still overwrites with 201 (Q41) | `M1-again-overwrite`: 201, `upload proceeding/new file` (`PDFBYTES-2`), no row, on both | **conforms** |
| case-differing name under the other type is **not** refused | `D46-case-variant-other-type` (`ACTA NÚMERO 2`, type 1, `Acta número 2` exists as type 0): 201, new row, upload on both. `D46-trailing-space-other-type` (`Acta número 2 `): same | **conforms** |
| `Dup X` edge refused (Q44) | `Dup X` t0 201, then `DUP X` t1 201, then `Dup X` t1: v1 201 overwriting `presentations/dup x`; **v2 409, 0 calls** | **conforms** |
| same-type row with missing object not refused (Q41, §6.2) | `Q41-existing-row-no-blob`: 500 after upload on both, object stored | **conforms** |
| U+0000 name not queried (§4) | `N-nul-name`: 500 after upload on both, identical calls | **conforms** |
| reachable only by ADMIN | `POST-role-*`: 403 / 401 on both, 0 calls, count unchanged | **conforms** |

### 2.2 D47

| list in D47's row | measured on v2 | v1 |
|---|---|---|
| **accepted**: `' 1 '`, `'１'`, NBSP+`1`, `'+0'`, `'-0'`, `'0_1'` | 6 of 6 answered **201**, rows `(1,…)`/`(0,…)` as `int()` gives | 201, identical `(type,name)` and calls |
| **refused**: `'1_0'`, `'＋1'`, U+001C+`1`, `'abc'`, `'1.0'`, `''`, `'-1'`, `' ٣ '`, `'2'`, `'2147483647'`, `'2147483648'`, `'-2147483649'` | 12 of 12 answered **400** `{"message":"Type must be 0 or 1"}`, 0 calls, no row | 201 stored (5), 500 before storage (5), 500 after upload (2) |
| `type` file part → 400 (Q46) | `M2-type-as-file`, `M2-type-scalar-and-file`: 400, 0 calls | 500, 0 calls |
| JSON `null`, `[0]`, `2` → 400 | `Z-json-type-null`, `P-json-type-list`, `Z-json-type-2`: 400, 0 calls | 500 |
| JSON `1.5`, `true` pass D47 and fail at v1's 500 | 500 after `get_bucket, blob, exists` | identical |
| bodiless 400 for a missing key is unchanged, whatever `type` says | `P-presence-first-missing-name-type-abc`, `…-missing-file-type-5`: 400, 0 B | identical |
| both apply → **400 wins** (§6.1 row 9) | `D47+D46-abc`, `D47+D46-5` (`Acta número 1`, type-0 row exists): **400**, not 409 | 500 / 500 after upload |

Counts, measured on `out/w-v2.jsonl` with a Python pass over its records: **19** responses carry the D47 body and **5** the D46 body,
and the list of D46/D47 refusals with a non-empty call list is **`[]`**. `grep -c '"body": "{\\"message\\":\\"Type must be 0 or 1\\"}"' out/w-v2.jsonl` → **19**.
Over all 83 write cases, the status is equal on **58**.

### 2.3 Q45 — the known residual, reproduced (`out/race-v2.jsonl`)

Two POSTs of `racehold q45 1789389982` as type 0 and type 1 ran concurrently against v2. The fake holds uploads for 3 s. The requests overlapped by **3.01 s**.

- Both passed D46: the calls ran `get_bucket, blob, exists, upload` for **both** `proceeding/…` and `presentations/…`.
- Type 0 → **201**, and the row was written (id 46).
- Type 1 → **500 after its upload**. `presentations/racehold q45 1789389982` stayed in the store as an **orphan**. The failed insert consumed id 45: `file_after` went from `[38,44,2]` to `[39,46,3]`.
- Positive control: a sequential third upload as type 1 → **409, 0 calls**.

This matches §4 "D46 — the concurrent window" and Q45. **It is a known residual, not a failure.**

The first attempt of `race.py` crashed in its reporting line (my script bug: `KeyError`) after the requests had run. It left clone row 44
(`racehold q45 1789389957`), and its record was lost, so it is not evidence here.

### 2.4 A wording discrepancy, for `nestjs-reviewer` (not a failure)

§6.1 row 2 says of P8-D4 that "status and headers match". On the **init-time multipart failures**, the header sets do not match:
the empty boundary (1.3 k), the quoted trailing-space boundary and the empty boundary again (1.4). v1 serves gunicorn's page with **no `Vary`
header at all**; v2 sends **`Vary: Origin`**. P8-D4's own row words it as "same absence of `Allow` and of `Accept` in `Vary`", and that wording
is true as measured. §6.1 row 2 is the overstatement. Precedent: D24 registered a header-set difference on the same double-fault shape in P3.

---

## 3. Other measured traps

### 3.1 A scalar `file` field → 500 on both

`M2-scalar-file`: v1 500 and v2 500. The calls are identical (`get_bucket, blob(proceeding/m2 scalar), exists`), with no upload and no row. **PASS.**

### 3.2 P8-F2 — a same-type name differing in case overwrites silently

`M1-new` (`New file` t0) → 201, row. `P8-F2-case-variant-same-type` (`NEW FILE` t0) → **201 on both**, `upload proceeding/new file` with
`PDFBYTES-3`, **no row**, count unchanged. **PASS** (Q41, ported).

### 3.3 D22 on `POST /api/file` (C79)

| boundary | expected | measured |
|---|---|---|
| non-ASCII `zzé` | v1 500 / v2 400 | **v1 500** (141 B, no `Allow`/`Vary`) / **v2 400** DRF parse-error body | as expected |
| empty `boundary=` | 500 / 500 | **500 / 500**, 0 calls, twice | as expected (P8-D4 bytes, §2.4 header note) |
| trailing space | 500 / 500 | **unquoted `boundary=zzz ` → 201 / 201, identical.** The space never reaches the multipart parser on either stack, because both gunicorn and Node strip trailing whitespace from header values. **Quoted `boundary="zzz "` → 500 / 500**, 0 calls | the developer's measurement came from Django's in-process test client, which keeps the space. Over HTTP it is only reachable quoted. **Correction for §3 / §6.1 wording, not a parity failure.** |

### 3.4 P8-D1 — a real `created_at` tie

See §1.2.

### 3.5 The `lower()` object path

**How the code point was confirmed to be in the drift set.**
1. Inside the running `fondo-v1-p8r` container (CPython **3.9.25**, UCD **13.0.0**), `chr(cp).lower()` was captured for every non-surrogate code point: 1,393 mapped. Output is `rec/cpython-lower.json`, and no new container was started.
2. On the host, Node **v24.20.0** (Unicode 17.0) compared `String.fromCodePoint(cp).toLowerCase()` with it over the same range. It differs on **95 code points** (`out/lower-drift-set.json`), which reproduces the brief's figure.
3. U+1C89, U+2C2F and U+A7C0 are **all in that set**.
4. Control, showing that the probe can see the difference: `toLowerCase('XᲉ Ⱟ Ꟁ')` gives `x ᲊ ⱟ ꟁ` (`78 1c8a 20 2c5f 20 a7c1`), while CPython gives `78 1c89 20 2c2f 20 a7c0`.
5. v2's `dist/common/utils/python-lower.js` `pythonLower` gives `78 1c89 20 2c2f 20 a7c0`. Over all non-surrogate code points it has **0 mismatches** with CPython.

**Over HTTP**, `M7-drift-1C89` stored `proceeding/xᲉ Ⱟ Ꟁ` on **both** stacks (identical call tuples), which equals CPython's path. `M7-sigma-dotted-I`
stored `proceeding/acta οδος i̇ ǆ ß` on both (final sigma, U+0130 expansion). **PASS.**

---

## 4. Condition C81 — `readUploadedFile` takes the last part, on the approved Phase 3/4 routes

Setup: `PATCH` as ADMIN (`UserView`/`LoanView` `PATCH [0,2]`), multipart, run on v1 (after reset) and on v2 (after reset), cases in the order below.
Each part carries a distinct marker.

- **User TSV:** users 4 and 5, columns `balance_contributions, total_quota, contributions, utilized_quota` = `M1..M4`. Identifications were read from the clone by the script and never printed.
- **Loan TSV:** all 28 APPROVED loans, so auto-close cannot fire; `total_payment = M1`.

Snapshots were taken after every case (`post_sql` in `out/c81-v*.jsonl`):
- `fondo_api_userfinance` rows for users 4 and 5, including `available_quota` and `last_modified`
- the distinct `total_payment` over APPROVED loans
- loan counts by state
- `md5` of all `loandetail`
- `schedulertask` count, max id, `xmin` cardinality, and `md5` of its content

| case | processed on **v1** | processed on **v2** | rows | status / body |
|---|---|---|---|---|
| user, two `file` parts (FIRST 111x, SECOND 222x) | **SECOND**: users 4,5 = `2221/2222/2223/2224`, `available_quota −2`, `last_modified 2026-09-14` | **SECOND**, identical | **equal** | 200 / 200, 0 B, identical headers |
| user, scalar `file` (999x) **then** part (333x) | **the part** (`3331…`) | **the part** | equal | 200 / 200 |
| user, part (444x) **then** scalar `file` (888x) | **the part** (`4441…`) | **the part** | equal | 200 / 200 |
| user, scalar `file` only (777x) | nothing (rows unchanged from `4441…`) | nothing | equal | 500 / 500; v1 27 B HTML, v2 0 B; both `Vary: Origin`, no `Allow`. **P3-D6** |
| loan, two `file` parts | **SECOND**: `total_payment` = `2221` for all APPROVED; states `0:1,1:28,2:51,3:345` (no auto-close); `loandetail md5 4598d866…`; schedulertask `626/2528/1 → 682/2584/2`, `md5 3d4c7b6d…` | **SECOND**, **identical md5s and counts** | **equal** | 200 / 200; v1 0 B, v2 `{"closed_loans":[]}`. **D8** |
| loan, scalar then part | **the part** (`3331`, `e9e66171…`) | same | equal | 200 / 200, D8 |
| loan, part then scalar | **the part** (`4441`, `fbce15fe…`) | same | equal | 200 / 200, D8 |
| loan, scalar only | nothing (unchanged) | nothing | equal | 500 / 500, P3-D6 |

`python3 cmp.py out/c81-v1.jsonl out/c81-v2.jsonl` gives **5 same / 5 diff**. The 5 diffs are body/`Content-Type` only (3 × D8, 2 × P3-D6), and
**`post_sql` is equal in 10 of 10**. **C81: PASS.** v2 now processes the same part v1 does on both approved routes, for both request shapes.
A Phase 3/4 baseline recorded before `71cd7de` will differ for the two-parts shape (§6.1 row 5).

---

## 5. Admin conformance (captured stubs only)

| spec | v1 | v2 |
|---|---|---|
| missing `type` → 400 | 400, 0 B, 0 sends (also `/api/admin/`) | same |
| any other value → 200, **nothing sent**: `''`, bare `?type`, `EMAIL`, `push`, `?type=email&type=x` | 200, **0 sends** ×5 | same |
| `email` → one TEST mail to the caller only, `Bcc` empty | **1** SES `SendEmail`: `to_count 1`, `to_is_exactly_caller true`, `bcc_count 0`, subject `[Fondo Montañez] Test email` (UTF-8), html 101 chars `sha 53d821bc…`, source `Fondo Montanez <no-reply@…>` | **identical normalised record**, same `to_sha` |
| `notifications` → one SQS message with the caller's subscriptions only | **1** SQS: queue `/000000000000/fonmon-notifications`, `message {"body":"Test Notification","target":"/"}`, `sub_count 1`, `subs_are_exactly_callers true` (caller user 1 has 1 subscription on the clone), body `sha 24a4c169…` | **identical** |
| `HEAD` → 403 and nothing sent | 403, 0 sends (email and notifications) | same (D21 for the body bytes) |
| other roles / unauthenticated | 403 / 401, 0 sends | same |

A delivery note: v1's SQS publish ran through `Task.apply` in-process (§0), not through a Celery worker.
Capture directories after the round: `cap/v1` 42 files, `cap/v2` 42 files, including the stub probe pings. All of them are local; nothing reached AWS.

---

## 6. Signed URL (H) — structure only

**Why the key and run are safe.** The key is a throwaway 2048-bit RSA key generated with `openssl` in the session scratchpad and bound to no account. The script ran `env -i … unshare -rn node sign-structure.js`, in a namespace with no network. `Bucket.getMetadata` was stubbed so that `getBucket()` sends nothing. The signer is v2's own `GcsFileStorage` from `dist/`.

**What it produced** (`out-sign-structure.jsonl`, 2 object paths, pinned clock `2027-01-02T03:04:05.999Z`):
- host `storage.googleapis.com`
- path `/fonmon/<percent-encoded object path>`, which decodes to `proceeding/acta número 1` and `presentations/resultados 2012`
- params exactly `X-Goog-Algorithm, X-Goog-Credential, X-Goog-Date, X-Goog-Expires, X-Goog-Signature, X-Goog-SignedHeaders`
- `GOOG4-RSA-SHA256` (**v4**), scope `20270102/auto/storage/goog4_request`, `X-Goog-Date 20270102T030405Z` (one clock read, floored), **`X-Goog-Expires=300`** (5 minutes), `SignedHeaders=host`

**How `GET` was confirmed.** The V4 canonical request was rebuilt and the RSA signature verified against the public key. It **verifies as `GET` → true**. Controls: as `PUT` → false; with a tampered bucket path → false.

**Over HTTP.** Both stacks record the sign tuple `['sign', <object path>, 'v4', 300, 'GET']` (v1 records `300.0`). A missing id → **404, 0 B, 0 storage calls** on both (`D-miss0`, `D-miss-16`, `D-miss-huge`).

v1's library was **not** re-run for byte equality; the developer's 8/8 (`p8/sign-*.jsonl`) stands unre-measured.

---

## 7. Gate — re-measured at `de1aa25`, each step's own exit code

Output is in `~/.fondo-parity-harness/p8r/gate/`. `rev.txt` records `de1aa25…` both before and after, and `status-after.txt` is empty.

| step | exit | counts |
|---|---|---|
| `npm run lint` | **0** | — |
| `npx tsc --noEmit` | **0** | — |
| `npm test` | **0** | **2517 passed / 2517; 77 suites passed / 77** |
| `npm run test:e2e -- --json` | **0** | from `e2e.json`: `numPassedTests 1331`, `numPendingTests 2`, `numFailedTests 0`, `numTotalTestSuites 23`, `numPassedTestSuites 22`, `numPendingTestSuites 1` |

All four match the claim at `5f58b11`.

**An instrument error of mine, not a gate result:** an extra `npx jest --json` step ran **without**
`NODE_OPTIONS=--experimental-vm-modules` and exited **1** (1505 tests). The gate step is `npm test`, above.

---

## 8. System health and data safety

| check | command | result |
|---|---|---|
| `fondodev` baseline, **start** (07:28) | `bash scripts/parity/fixture-check.sh \| diff - ~/.fondo-parity-harness/p8/out/BASELINE-fondodev-2026-09-12.txt` | **exit 0** |
| control, start | `DB=fondo_api_test bash scripts/parity/fixture-check.sh \| diff -q - <same>` | **exit 1** |
| `fondodev` baseline, **end** (07:46, after every process stopped) | same | **exit 0** |
| control, end | same | **exit 1** |
| clone equals the baseline after the first reset | `DB=fondodev_p8 … \| diff - <baseline>` | exit 0 |
| schema untouched | `pg_dump --schema-only --no-owner` of `fondodev` vs `fondodev_p8` (after all v2 writes), `\restrict` lines removed | **diff exit 0**; control `fondodev` vs `fondo_api_test` **exit 1** |
| both servers boot | `start-v1.sh` / `start-v2.sh` | 7 v1 and 6 v2 boots, `GET /api/file → 401` each. The first v2 boot failed on my launcher's `reflect-metadata` path; fixed before any measurement |
| known-good control after **every** restart | `cmp.py out/control-*.jsonl` | 5 of 5 runs: **3 same / 0 diff**. `CTL-list` 200 2652 B; `CTL-admin-notifications` 1 SQS on each stack (exercises the hstore cast, false-green #23); `CTL-detail-sign` 3 calls |
| no scheduler, no worker | `SCHEDULER_ENABLED` unset; no `celery` process was started | — |
| nothing left running | `ps -C node`, `ps -C python3`, `ps -C gunicorn` → empty; `docker ps` → `fondo_db` only | — |
| GCS | no credentials on host or in v2's env. v1 had throwaway `authorized_user` creds and proxies on a closed port. Both stacks' `FILE_STORAGE` / `get_bucket` were fakes; evidence is `signed://` bodies and recorded calls on every storage case | **v1's proxy fence itself was not exercised by a control** (stated, not claimed) |
| SES / SQS | capture stubs only; `start-*.sh` refuse to start without them | — |

---

## 9. Controls — each check that could only say "nothing found", shown able to find something

| check | control | showed |
|---|---|---|
| fixture baseline diff | `DB=fondo_api_test` | exit 1, start and end |
| schema diff | `fondodev` vs `fondo_api_test` | exit 1 |
| "0 storage calls" (D46, D47, roles) | `CTL-detail-sign`, and v1 on the D46 cases | 3 and 4 calls recorded |
| "0 sends" (admin non-matches, `HEAD`, roles) | `A-email`, `A-notifications`, `CTL-admin-notifications` | 1 send each, both stacks |
| "count / `xmin` unchanged" | `M1-new` | `[42,48,6] → [43,49,7]` |
| `cmp.py` "SAME" | one `userfinance` value in `c81-v2` changed to FIRST's marker | `DIFF … post_sql`, totals 5/5 → 4/6 |
| no-network namespace (signing) | `unshare -rn curl https://example.com` | exit 7 |
| signature "verifies as GET" | as `PUT`; tampered path | false, false |
| M7 case distinguishes the CPython path | `toLowerCase` on the same name | `1c8a 2c5f a7c1`, not `1c89 2c2f a7c0` |
| tie list order | raw `ORDER BY created_at` | `tie-b, tie-a` (heap order), proving a real tie |
| Q45 window | sequential third upload | 409, 0 calls |
| hstore OID | `reset-clone.sh` exits 6 if the OID moves; `setup.sh` is `set -e` | 7 resets exited 0 |

---

## 10. For other agents

- **`nestjs-developer`:** no failures to fix.
- **`nestjs-reviewer`:** this report. There are two wording corrections (neither changes code):
  - **§2.4:** §6.1 row 2 says the headers match on init-time multipart 500s. They do not: v1 has no `Vary`, v2 sends `Vary: Origin`. P8-D4's own wording is accurate.
  - **§3.3:** the trailing-space boundary 500/500 holds only when the boundary is quoted. Unquoted, both HTTP servers strip the space and the request succeeds 201/201.
  - Rulings still open for you: **C79** (D22 on this route; measured v1 500 / v2 400) and **C80** (D45; measured parsed-equal).
- **`business-analyst`:** no new undocumented rule. **Q45's** window reproduces as described.
