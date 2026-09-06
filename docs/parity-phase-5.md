# Phase 5 (Activities) — parity report

**Round:** Phase 5, round 1.
**v1:** container `fondo-v1-p4`, repo `/home/miguel/Projects/Fondo-API` @ `5bef585` (bind-mounted
read-only), gunicorn 19.9.0 / Django 2.2.27 / CPython 3.9 on `127.0.0.1:8451`,
`DJANGO_SETTINGS_MODULE=api.settings.production`.
**v2:** `/home/miguel/Projects/Fondo-API-v2` branch `feat/phase-5-activities` @ **`662ed48`**,
working tree clean, rebuilt from source before the run (`nest build`, 16:55), started **only**
via `~/.fondo-parity-harness/p5/start-v2.sh` on `127.0.0.1:8450`.
**Database:** shared `fondodev` on `127.0.0.1:5432`. **SES/SQS:** local capture stubs
`:4599` (v1) / `:4598` (v2); `assert_capture_up()` in force on every write cell.
**Harness:** `~/.fondo-parity-harness/p5/` (all scripts mode 755).
**Pre-write dump:** `~/.fondo-parity-dumps/p5r-20260904-165546-pre/` (btrfs, not tmpfs; guard in
`dump.sh` refuses tmpfs), pointer `~/.fondo-parity-dumps/LATEST-P5R`.

---

## 0. Verdict

| endpoint | verdict |
|---|---|
| `GET /api/activity/year` | **PASS** |
| `POST /api/activity/year` | **PASS** |
| `GET /api/activity/year/<id_year>` | **PASS** |
| `POST /api/activity/year/<id_year>` | ❌ **FAIL** — P5-F1 (a non-scalar `name` is stored wrong) and P5-F2 (id-sequence divergence) |
| `GET /api/activity/<id>` | **PASS** |
| `PATCH /api/activity/<id>` | ❌ **FAIL** — P5-F1, and here it is visible in the **200 response body** |
| `DELETE /api/activity/<id>` | **PASS** — the cascade is correct, including the 13 children v1's own test cannot see |

**Phase verdict: FAIL.** Two unregistered behavioural differences, both on the write paths of
`POST /api/activity/year/<id_year>` and `PATCH /api/activity/<id>?patch=activity`, both
reproducible, one of them wire-visible. Everything else in the phase — 515 read/negotiation
cells, 168 write-cell HTTP steps, 20 raw-socket targets, every role rule, the cascade, the
year rollover, P5-D1, P5-D2, the 204, the 400/404 error contract — is byte-identical or
accounted for by a **registered** deviation.

Neither failure is in `docs/phase-5-deviations.md` §4's expected-diff table, which states
"**§4.1 Expected diffs against v1 — none**". By that document's own rule, both are parity
failures.

---

## 1. Scope and the permission matrix under test

From `CONTEXT.md` / `fondo_api/urls.py:25-27` and `fondo_api/permissions.py:23-35`:

| v1 view | URL pattern (verbatim) | rules |
|---|---|---|
| `ActivityYearView` | `^api/activity/year/?$` | `GET: 3`, `POST: 1` |
| `ActivityYearDetailView` | `^api/activity/year/(?P<id_year>[0-9]+)$` — **no** `/?` | `GET: 3`, `POST: 1` |
| `ActivityDetailView` | `^api/activity/(?P<id>[0-9]+)/?$` — **has** `/?` | `GET: 3`, `PATCH: 1`, `DELETE: 1` |

An `int` rule is a **ceiling** (`role <= N`), so every write on this phase is **ADMIN(0) +
PRESIDENT(1) only and the TREASURER(2) must be refused** — the inverse of Phases 3, 4 and 6.
Measured on all three write verbs, both stacks: see §3.1.

---

## 2. Read surface

### 2.1 M1 — role × method × path matrix (`m1-read.py`, 294 cells)

`GET` and `HEAD` × 21 paths × 7 principals (ADMIN, PRESIDENT, TREASURER, MEMBER,
unauthenticated, unknown token, token of an `is_active = false` user).

```
v1 status distribution: {200: 48, 401: 90, 403: 60, 404: 96}
v2 status distribution: {200: 48, 401: 90, 403: 60, 404: 96}
differing cells: 84   (all D13 — see §5.1)
```

Status agreed on **294/294**. Body, byte count and the compared header set (`allow`, `vary`,
`content-type`, `www-authenticate`, `x-frame-options`) agreed on **210/294**; the 84 that
differ are Django's HTML 404 page vs v2's JSON — **D13**, registered and accepted.

| path | ADMIN | PRESIDENT | TREASURER | MEMBER | unauth | bad token | inactive |
|---|---|---|---|---|---|---|---|
| `GET /api/activity/year` | 200 | 200 | 200 | 200 | 401 | 401 | 401 |
| `GET /api/activity/year/` | 200 | 200 | 200 | 200 | 401 | 401 | 401 |
| `GET /api/activity/year/10` | 200 | 200 | 200 | 200 | 401 | 401 | 401 |
| `GET /api/activity/year/10/` | **404** | 404 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/activity/year/999` | 200 `[]` | 200 | 200 | 200 | 401 | 401 | 401 |
| `GET /api/activity/year/abc` | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/activity/1` | 200 | 200 | 200 | 200 | 401 | 401 | 401 |
| `GET /api/activity/1/` | **200** | 200 | 200 | 200 | 401 | 401 | 401 |
| `GET /api/activity/007` | 200 | 200 | 200 | 200 | 401 | 401 | 401 |
| `GET /api/activity/999` | 404 | 404 | 404 | 404 | 401 | 401 | 401 |
| `GET /api/activity/-1` | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/activity/99999999999999999999` | 404 | 404 | 404 | 404 | 401 | 401 | 401 |
| `HEAD` on any resolving guarded path | **403** | 403 | 403 | 403 | 401 | 401 | 401 |

Every cell above is `v1/v2` identical. Three things this pins:

* the `/?` asymmetry is exact — `/api/activity/year/10/` **404s** and `/api/activity/1/` **200s**
  (§4.2 row 22);
* an unknown `id_year` is **200 `[]`**, never 404 (row 6);
* `HEAD` is not a key in `list_permissions`, so it is a **403 for every role including ADMIN** —
  the same shape rule 13 gives `OPTIONS`. Authentication still runs first (401 for the three
  unauthenticated principals).

**Controls (all ok):** a 200 with the full 9-row year list; unauthenticated 401; a 404 present;
two different activity ids produce different bodies; a bad token is 401 not 200; v2 produced at
least one 200; ≥4 distinct v1 statuses (the matrix is not uniform — false-green #4/#12).

### 2.2 M2 — full read sweep of every row (`m2-sweep.py`, 73 cells)

`GET /api/activity/<id>` for ids 1–30 × {ADMIN, MEMBER}, plus `GET /api/activity/year/<y>` for
year ids 1–12, plus the year list.

```
cells: 73   differing: 0
v1 bytes swept: 179 047   v2 bytes swept: 179 047
```

**0 diffs across 179 047 bytes**, byte for byte. Controls: 25 ids answer 200 and 5 answer 404
(the fixture's gaps at 5, 16, 28, 29, 30 are visible); every 200 body is distinct; year id **7**
— the deleted `ActivityYear` — answers 200 `[]`.

`GET /api/activity/1` as ADMIN, v1 and v2 identical at 3 407 bytes:

```json
{"id":1,"name":"Actividad deportiva","date":"2018-03-28","value":15000,"users":[{"id":1,"state":1,"user":{"full_name":"Miguel Ángel Montañez Gómez","identification":1030659688,"email":"angelitogomeza@hotmail.com","role_display":"ADMIN","id":1,"first_name":"Miguel Ángel","last_name":"Montañez Gómez","role":0,"birthdate":"1995-11-07"}}, …]}
```

| §4.2 row | claim | measured |
|---|---|---|
| 10 | `date` renders ISO `YYYY-MM-DD`, not Spanish | ✅ `"2018-03-28"` on both. **Rule 5c does not apply here** and no Spanish date appears anywhere in the phase. |
| 11 | `year`, `value`, nested `identification` are bare JSON **numbers** | ✅ `2026`, `15000`, `1030659688` — no quotes. Rule 5b holds. |
| 12 | key order `id, name, date, value, users` / `id, state, user` | ✅ both, verbatim |
| 13 | nested `users` ordered by `user_id` | ✅ `[1,2,3,4,5,6,7,8,9,10,11,12,13]` on both |

### 2.3 The `enable` anomaly is echoed, not recomputed

`GET /api/activity/year` returns **both** enabled years on both stacks:

```
[{"id":10,"year":2026,"enable":true}, …, {"id":3,"year":2020,"enable":true}, …]
```

`enable` is serialised verbatim (§3.1 of the deviations doc). No "exactly one enabled year"
invariant exists in either stack. The anomaly survived the whole round — re-verified at the end:
`select id,year,enable from fondo_api_activityyear where enable` → `3|2020|t`, `10|2026|t`.

### 2.4 M4 — raw-socket URL targets (`m4-raw.py`, 20 targets, plan rule 14 / C27)

curl rewrites request targets, so these went on the wire byte for byte through a socket.

```
status/allow diffs: 0 of 20
body-length diffs : 10   (7 x D13, 3 x D21)
```

| target | v1 | v2 |
|---|---|---|
| `GET /api/activity/year/` | 200 | 200 |
| `GET /api/activity/year//` | 404 | 404 |
| `GET /api/activity/year/10/` | 404 | 404 |
| `GET /api/activity/1/` | 200 | 200 |
| `GET /api/activity/1//` | 404 | 404 |
| `GET /api/activity/1%2F` (decodes to `…/1/`) | 200 | 200 |
| `GET /api/act%69vity/1` | 200 | 200 |
| `GET /api/activity/%31` | 200 | 200 |
| `GET /api/activity/../activity/1` | 404 | 404 |
| `GET /api/activity/1%0A` | 404 | 404 |
| `GET /api/activity/1 HTTP/1.0` | 200 | 200 |

**D21 measured directly** (`curl --head` cannot see it): on `HEAD /api/activity/year` v1 writes
**63 body bytes after the headers** and v2 writes 0, with `Content-Length: 63` on both. Same on
`HEAD /api/activity/1` (63/0) and on the 404 handler (77/0). Registered, and it is v1 that is
non-conformant.

### 2.5 M5 — content negotiation (`m5-accept.py`, 33 cells)

```
v1: {200: 24, 404: 3, 406: 6}    v2: {200: 24, 404: 3, 406: 6}
differing cells: 12 — all P3-D8
```

Statuses identical on 33/33. The 12 differing cells are `Accept: text/html`, `Accept: text/*`,
`Accept: application/json;indent=4` and `?format=api` on each of the three routes — v1's
browsable API (7 637 / 7 150 / 17 359 bytes) and the `indent` parameter (685 / 195 / 6 498)
against v2's compact JSON. **P3-D8**, registered. `application/xml` and `application/yaml` are
**406** on both with the identical 57-byte body; `?format=xml` is 404 with the identical 23-byte
body on both.

---

## 3. Write surface

Every write cell runs `restore (pg_restore) → v1 leg → restore → v2 leg → restore`, and the row
snapshot covers 13 tables **plus every sequence**. `assert_capture_up()` refuses to run if either
capture stub is down.

### 3.0 W0 — the restore itself was controlled before any write cell (`w0-restore-check.py`)

False-green #15 was three rounds of "byte-identical" while two sequences drifted, so the restore
was proved rather than assumed: snapshot → deliberately damage the fixture (flip `enable` on year
id 3, delete the highest `ActivityUser`, `setval` the activity sequence to 999) → prove the damage
is visible → restore → prove the snapshot is byte-identical again.

```
CONTROL A the probe can see row damage        ok
CONTROL B the probe can see sequence drift    ok
CONTROL C restore returns byte-identical rows ok
```

### 3.1 The permission matrix on the three write verbs — TREASURER refused

| verb / route | ADMIN | PRESIDENT | **TREASURER** | MEMBER | unauth | bad token | inactive |
|---|---|---|---|---|---|---|---|
| `POST /api/activity/year` | 304 | 304 | **403** | 403 | 401 | 401 | 401 |
| `POST /api/activity/year/10` | 201 | 201 | **403** | 403 | 401 | 401 | 401 |
| `PATCH /api/activity/1` | 200 | 200 | **403** | 403 | 401 | 401 | 401 |
| `DELETE /api/activity/26` | 200 | 200 | **403** | 403 | 401 | 401 | 401 |
| `POST /api/activity/1` (no matrix entry) | **403** | 403 | 403 | 403 | 401 | 401 | 401 |
| `PUT` on all three | 403 | 403 | 403 | 403 | 401 | 401 | 401 |
| `OPTIONS` on all three | **403** | 403 | 403 | 403 | 401 | 401 | 401 |
| `DELETE` on the two year views | 403 | 403 | 403 | 403 | 401 | 401 | 401 |

Identical on both stacks, body and headers included. Row snapshots taken **after the denials and
before the allows** show zero rows written by any refused caller, on both stacks. The three
distinct 401 bodies are byte-identical too:
`{"detail":"Authentication credentials were not provided."}` (58 B),
`{"detail":"Invalid token."}` (27 B), `{"detail":"User inactive or deleted."}` (38 B).

`Allow` is present **on the 403** and correct per view — `GET, POST, HEAD, OPTIONS` on both year
views, `GET, PATCH, DELETE, HEAD, OPTIONS` on the detail view (§4.2 row 23) — on both stacks.

### 3.2 `POST /api/activity/year` (`w1-year-post.py`, 5 cells, **all PASS**)

| cell | subject | v1 | v2 | rows | verdict |
|---|---|---|---|---|---|
| A | role matrix, 7 principals | see §3.1 | identical | identical (only `activityyear_id_seq` 12→14) | **PASS** |
| B | **P5-D1** — the same-year retry | **304**, and `2025` flipped `true → false` | identical | identical | **PASS** |
| C | the disable target across a gap | 304, **exactly one** row flipped: `2024` | identical | identical | **PASS** |
| D | the 201 path (2026 row removed first) | **201**, new row id 13, `2025` disabled; retry **304** | identical | identical | **PASS** |
| E | the body is never read | 304 for `text/plain`, `{`, a JSON list, `application/xml`, and on `/api/activity/year/` | identical | identical | **PASS** |

**P5-D1 confirmed on both stacks.** Cell B seeds `id 9 / 2025 / enable = true`, POSTs, and gets a
bodiless **304** — after which the row reads `enable = false`. A response that says "not modified"
modified a row, on both stacks, identically. Both also burn one `activityyear_id_seq` value on the
colliding insert (12 → 13), so even the sequence side effect matches.

**The disable target is the highest *other* year, one row (§4.2 row 4).** Cell C is the
discriminating case the brief asked for. Seed: delete the whole 2025 year (id 9) with its three
activities and their children, then enable **both** 2023 (id 6) and 2024 (id 8):

```
seed  : 1:2018:f 2:2019:f 3:2020:t 4:2021:f 5:2022:f 6:2023:t 8:2024:t 10:2026:t
POST  : 304
after : 1:2018:f 2:2019:f 3:2020:t 4:2021:f 5:2022:f 6:2023:t 8:2024:f 10:2026:t
```

Only **2024** flipped. This simultaneously falsifies three plausible mis-readings — "disable the
previous year" (2025 does not exist), "disable all the others" (2023 and 2020 stay enabled), and
"disable by id order" — and v2 matches v1 exactly. It also confirms the plan §3 wording correction
in `docs/phase-5-deviations.md` §5.1.

**Bogotá (condition C28).** Both stacks created **2026** at 22:18 UTC = 17:18 Bogotá, where the two
agree, so the live probe cannot discriminate. The boundary was cross-checked at library level in
both runtimes instead: at epoch `1767232800` (`2026-01-01T02:00Z`) Django's `date.today()` inside
the container with `TZ=America/Bogota` gives `2025-12-31`, and v2's `todayInBogota()` gives
`{"year":2025,"month":12,"day":31}`. ⚠️ **This is a library-level cross-check, not an HTTP-level
one** — `faketime` is not installed on this host or in the container, and I did not move the host
clock on a shared machine. The HTTP-level boundary remains covered only by v2's clock-fixed unit
cell. Recorded as a gap rather than claimed as measured.

### 3.3 `POST /api/activity/year/<id_year>` (`w2-create-activity.py`, 7 cells)

| cell | subject | HTTP steps | row deltas | verdict |
|---|---|---|---|---|
| A | role matrix + 2 real creates | 0 diffs | identical | **PASS** |
| B | happy path — exactly what is written | 0 diffs | identical | **PASS** |
| C | missing `name`/`value`/`date`, non-dict bodies, bad media types | 7 diffs, **all P3-D6** | identical (nothing written) | **PASS (registered)** |
| D | unknown `id_year` (999, 7, 0) | 3 diffs, **all P3-D6** | identical | **PASS (registered)** |
| E | `value` coercion table (P5-D2 create half), 15 inputs | 6 diffs, **all P3-D6** | identical | **PASS (registered)** |
| F | `date` and `name` edge inputs, 16 inputs | 9 diffs P3-D6 **+ a row-content diff** | ❌ **differ** | **FAIL — P5-F1 / P5-F2** |
| G | routing | 3 diffs, **all D13** | identical | **PASS (registered)** |

**Cell B — the happy path.** `{"name":"Parity probe ñ","value":30000,"date":"2026-09-04"}` on
`/api/activity/year/10` as ADMIN:

```
201, 0 bytes, Allow: GET, POST, HEAD, OPTIONS
activity  28 | Parity probe ñ | 30000 | 2026-09-04 | year 10
children  353..365 -> user_ids 1,2,4,5,6,7,8,9,10,11,12,13,14 ; state 0 on all
n children = 13
```

Byte-identical on both stacks, including the 3 437-byte `GET /api/activity/28` afterwards and the
year list. ⚠️ **13 children, not 15.** `docs/phase-5-deviations.md` §4.2 row 9, §3 of
`phase-5-prework.md` and the brief all say *"15 rows on `fondodev`"*. Measured:
`select count(*) from auth_user where is_active` → **13** (users 3 and 15 are `is_active = false`).
Both stacks write 13, so this is a **documentation error, not a parity failure** — but a probe
written to assert 15 would have failed on both stacks and looked like a v2 defect.

**Cell E — the `value` coercion table, both stacks, byte for byte:**

| input | v1 | v2 | stored |
|---|---|---|---|
| `"30000"` | 201 | 201 | 30000 |
| `30000.7` | 201 | 201 | 30000 |
| `30000.0` | 201 | 201 | 30000 |
| `true` | 201 | 201 | 1 |
| `false` | 201 | 201 | 0 |
| `"  30  "` | 201 | 201 | 30 |
| `-5` | 201 | 201 | −5 |
| `0` | 201 | 201 | 0 |
| `4611686018427387904` (2^62) | 201 | 201 | 4611686018427387904 |
| `"30.5"` | **500** | **500** | — |
| `"abc"` | **500** | **500** | — |
| **`null`** | **500** | **500** | — |
| `[1]` | **500** | **500** | — |
| `{"a":1}` | **500** | **500** | — |
| `1180591620717411303424` (2^70) | **500** | **500** | — |

**P5-D2's create half confirmed:** `value: null` is a **500** here. Its patch half is a **404** —
see §3.4. Both halves measured on both stacks, and the coercion is invisible in the body exactly as
the deviation says (create answers a bodiless 201; patch answers a fresh `get_activity`).

**Cell F — the two failures.** See §4.

### 3.4 `PATCH /api/activity/<id>` (`w3-patch.py`, 6 cells)

| cell | subject | HTTP steps | verdict |
|---|---|---|---|
| A | role matrix | 0 diffs | **PASS** |
| B | `?patch=` dispatch, 11 shapes | 0 diffs | **PASS** |
| C | `?patch=activity` happy + 14 failure shapes | 0 diffs | **PASS** |
| D | `?patch=activity` value coercion (P5-D2 patch half), 11 inputs | 0 diffs | **PASS** |
| E | `?patch=user`, 19 shapes | 0 diffs | **PASS** |
| F | routing, 5 targets | 1 diff, **D13** | **PASS (registered)** |

68 HTTP steps, **1 differing, and that one is D13**. Row deltas identical on all six cells.
(P5-F1 is reachable through this route too — it is isolated in §4.1 rather than being folded into
this table, because the inputs that trigger it are not part of these cells.)

**Cell B — `?patch=` dispatch (`QueryDict.get('patch','activity')`):**

| query | v1 | v2 | bytes |
|---|---|---|---|
| *(no query)* | 200 | 200 | 3393/3393 |
| `?patch=activity` | 200 | 200 | 3393/3393 |
| `?patch=user` | 404 | 404 | 0/0 |
| `?patch=` | **400** | **400** | 0/0 |
| `?patch=ACTIVITY` | **400** | **400** | 0/0 |
| `?patch=activityx` | **400** | **400** | 0/0 |
| `?patch=x` | **400** | **400** | 0/0 |
| `?patch=activity%20` | **400** | **400** | 0/0 |
| `?patch=activity&patch=user` | 404 | 404 | 0/0 |
| `?patch=user&patch=activity` | 200 | 200 | 3393/3393 |
| `?PATCH=user` | 200 | 200 | 3393/3393 |

The **last** value wins on a repeated key — `QueryDict.get` semantics — on both stacks, and the
400 is zero-byte and precedes the body read (§4.2 row 14).

**Cell C — every other failure is a 404 (§4.2 row 15).** Missing `name`, missing `value`, missing
`date`, `{}`, a JSON list body, a JSON `null` body, `name: null`, `date: null`, `date: "2026-13-01"`,
`date: 20260506`, an unknown activity id → **404, 0 bytes, on both**. Never 400, never 500. A body
with an extra unknown key is a normal **200**. `text/plain` is a **415** (62 B, identical) and a
malformed JSON body is a **400** with CPython's exact message (107 B, identical):
`{"detail":"JSON parse error - Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"}`.

**Cell D — P5-D2's patch half.** `"5000"`, `5000.7`, `true`, `"  50  "`, `-7` all **200**;
`"30.5"`, `"abc"`, **`null`**, `[1]`, `{"a":1}`, 2^70 all **404**. So the same `null` that is a
**500** on create is a **404** on patch, on both stacks — P5-D2 confirmed end to end.

**Cell E — `?patch=user`:**

| body | v1 | v2 | stored `state` |
|---|---|---|---|
| `{"id":1,"state":1}` / `2` / `0` | 200 | 200 | 1 / 2 / 0 |
| `{"id":2,"state":7}` | **200** | **200** | **7** — out of `STATE_TYPES`, written without complaint (row 16) |
| `{"id":2,"state":-1}` | **200** | **200** | **−1** |
| `{"id":3,"state":"1"}` | 200 | 200 | 1 |
| `{"id":3,"state":1.9}` | 200 | 200 | 1 |
| `{"id":3,"state":true}` | 200 | 200 | 1 |
| `{"id":3,"state":"abc"}` | 404 | 404 | unchanged |
| `{"id":3,"state":null}` | 404 | 404 | unchanged |
| `{"id":3,"state":1099511627776}` | 404 | 404 | unchanged |
| `{"id":3}` / `{"state":1}` / `{}` | 404 | 404 | unchanged |
| **`{"id":20,"state":2}`** (an `ActivityUser` of a *different* activity) | **404** | **404** | **activity 2's rows unchanged on both** |
| `{"id":99999,"state":2}` | 404 | 404 | unchanged |
| `{"id":"4","state":2}` | 200 | 200 | 2 |
| `{"id":null,"state":2}` | 404 | 404 | unchanged |

The cross-activity cell is the one §3.6 of the deviations doc says `updateMany` with both keys in
the `where` protects: measured, and neither stack wrote across activities.

### 3.5 `DELETE /api/activity/<id>` (`w4-delete.py`, 5 cells)

| cell | subject | verdict |
|---|---|---|
| A | **the cascade** — delete activity 27, which has 13 children | **PASS** |
| B | role matrix; the denials delete nothing | **PASS** |
| C | `DELETE` on ids that never existed (999, 0, 5, 16) | **PASS** |
| D | routing + repeat delete + a body on `DELETE` | **PASS** (1 diff, D13) |
| E | `get_years` on an **empty** table | **PASS** |

**Cell A — the cascade (P5-D4, plan §4 rule 10).** Deliberately an activity that **has** its
children, which is precisely what v1's own `test_delete_activity` cannot exercise:

```
before : activity 27 ; children 340..352 (13) ; n_act 25 ; n_au 338
DELETE /api/activity/27   -> 200, 0 bytes, Allow: GET, PATCH, DELETE, HEAD, OPTIONS
after  : activity - ; children - ; n_act 24 ; n_au 325
GET /api/activity/27      -> 404, 0 bytes
GET /api/activity/year/10 -> 200 [{"id":26,…},{"id":25,…}]   (79 bytes, identical)
orphan ActivityUser rows  : 0
```

Identical on both stacks: same 14 rows removed, same counts, same orphan check, 0 HTTP step diffs.
v2's explicit child delete reproduces Django's Python-side collector exactly.

**Cell C — `remove_activity` has no existence check.** `DELETE /api/activity/999`, `/0`, `/5`,
`/16` → **200, 0 bytes** on both, and the negative control confirms **nothing was written** by
either stack. `DELETE /api/activity/24` twice → 200 then 200.

**Cell E — the 204 (§4.2 row 1).** Unreachable on the fixture as shipped, so the cell empties the
three activity tables from psql first and presents the *same* empty table to both stacks. This is
not a fake: the answer measured is the real answer for an empty table, and the restore puts the
fixture back.

```
GET /api/activity/year  (ADMIN)  -> 204, 0 bytes, NO Content-Type header
GET /api/activity/year  (MEMBER) -> 204, 0 bytes
GET /api/activity/year/10        -> 200 "[]"   (the detail view still 200s)
POST /api/activity/year          -> 201  (nothing to disable) ; row 13:2026:true
GET /api/activity/year           -> 200 [{"id":13,"year":2026,"enable":true}]
```

Identical on both stacks, including the absent `Content-Type` on the 204 and the fact that the
detail view answers `200 []` where the list view answers 204.

### 3.6 W5 — `order_by('-date')` with ties

The fixture has **no** date ties (`group by year_id, date having count(*) > 1` → empty), so the
M2 agreement on ordering could have been luck. Three activities were created on one shared date
and a fourth moved onto it by `PATCH`:

```
list        : 27, 26, 28(tie-A), 29(tie-B), 30(tie-C), 25      (179 bytes, identical)
after patch : 27, 25(moved), 26, 28, 29, 30                    (160 bytes, identical)
physical    : ctid order 26,27,28,29,30,25 on both
```

Neither stack promises an order within a day and the report does not claim one; measured, they
agree, and they agree for the same reason (identical physical row order after an identical write
sequence).

---

## 4. Failures

### 4.1 ❌ **P5-F1 — a non-scalar `name` is stored as the *type name* in v2 and as Python's `str()` in v1**

**Where:** `POST /api/activity/year/<id_year>` (table only) and
`PATCH /api/activity/<id>?patch=activity` (**visible in the 200 response body**).
**Cell:** `w2-create-activity.py` cell F step 14; isolated in `f1-name-repr.py` cells F1a and F1b.
**Registered?** No. `docs/phase-5-deviations.md` §4.1 says this phase has no expected diffs.

**Reproduction — create.**

```
POST /api/activity/year/10   Authorization: Token <ADMIN>   Content-Type: application/json
{"name": ["a"], "value": 1, "date": "2026-01-04"}
```

v1 → `201`, v2 → `201`. Both bodiless, so the HTTP layer agrees. The **row** does not:

| body `name` | v1 stores | v2 stores |
|---|---|---|
| `["a"]` | `['a']` | **`list`** |
| `[1,2]` | `[1, 2]` | **`list`** |
| `[]` | `[]` | **`list`** |
| `{"a":1}` | `{'a': 1}` | **`object`** |
| `{}` | `{}` | **`object`** |
| `{"a":[1,{"b":2}]}` | `{'a': [1, {'b': 2}]}` | **`object`** |
| `5` | `5` | `5` ✅ |
| `5.5` | `5.5` | `5.5` ✅ |
| `true` | `True` | `True` ✅ |
| `"x"` | `x` | `x` ✅ |

(The four scalar rows are the cell's positive control: the matrix *can* agree, so the six that
disagree are a real signal and not a broken probe.)

**Reproduction — patch, where it reaches the wire.**

```
PATCH /api/activity/1?patch=activity   Authorization: Token <ADMIN>
{"name": {"a": 1}, "value": 1, "date": "2026-03-01"}
```

v1 → `200 {"id":1,"name":"{'a': 1}","date":"2026-03-01","value":1,"users":[…]}`
v2 → `200 {"id":1,"name":"object","date":"2026-03-01","value":1,"users":[…]}`

Six of the ten patch inputs differ in the response body. `patch_activity` answers with a fresh
`get_activity(id)`, so the wrong stored value is served straight back.

**Root cause** (reported, not fixed): `toDjangoTextOrNull` → `toDjangoText`
(`src/common/utils/python-obj.ts:169`) falls through to `describeValue`, which for any object
returns `describeType(value)` — the *type name*:

```ts
/** A safe `str()`-ish rendering for an error message; never `[object Object]`. */
function describeValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return describeType(value);   // 'list' | 'object'
  }
  return String(value);
}
```

Its own docblock says it is *for an error message*; it is being used on the **storage** path.
Django's `TextField.get_prep_value` is `str(value)`, measured in the running v1 container on the
pinned stack (`Django==2.2.27` / CPython 3.9):

```
>>> TextField().get_prep_value(['a'])            -> "['a']"
>>> TextField().get_prep_value({'a': 1})         -> "{'a': 1}"
>>> TextField().get_prep_value({'a':[1,{'b':2}]})-> "{'a': [1, {'b': 2}]}"
```

**Severity:** low-to-moderate. No v1 client sends a non-scalar `name`, so this is unlikely in
production traffic — but it is a **silent data-content divergence on a write path**, it is
wire-visible on `PATCH`, and `describeValue` is shared, so any future `toDjangoText`/
`toDjangoTextOrNull` call site inherits it. It is also the *same family* as **D35**
(`toDjangoText`'s `None` → `'None'` fold, registered during this phase): both are places where
the helper approximates `str()` instead of porting it. D35's fix should cover this at the same
time. Note that `describeType` also returns `'object'` where CPython's `type(x).__name__` for a
JSON object is `'dict'`, so even the type-name reading is not Python's.

**Route:** `nestjs-developer`.

### 4.2 ❌ **P5-F2 — `fondo_api_activity_id_seq` advances in v1 and not in v2 on the two DB-rejected inserts, so later activity ids diverge**

**Where:** `POST /api/activity/year/<id_year>`.
**Cell:** `f1-name-repr.py` cell F2 (first seen as the id skew in `w2-create-activity.py` cell F).
**Registered?** No.

**Reproduction.** From the restored fixture (`max(id) = 27`, `last_value = 27`), as ADMIN, on
`/api/activity/year/10`:

| # | request body | v1 status | v2 status | `activity_id_seq` after — v1 | v2 |
|---|---|---|---|---|---|
| 1 | `{"name":"a","value":1,"date":"2026-03-01"}` | 201 | 201 | 28 | 28 |
| 2 | `{"name":null,"value":1,"date":"2026-03-01"}` | 500 | 500 | **29** | **28** |
| 3 | `{"name":"a","value":1,"date":null}` | 500 | 500 | **30** | **28** |
| 4 | `{"name":"a","value":null,"date":"2026-03-01"}` | 500 | 500 | 30 | 28 |
| 5 | `{"name":"a","value":1,"date":"abc"}` | 500 | 500 | 30 | 28 |
| 6 | `{"name":"z","value":1,"date":"2026-03-02"}` | 201 | 201 | 31 | 29 |

Final rows: v1 `28=a, 31=z`; v2 `28=a, 29=z`. Every status matches; the **id of the row the next
successful create produces does not**.

**Mechanism.** For `name: null` and `date: null`, Django *issues the INSERT* and PostgreSQL
rejects it — measured in the container: `TextField().get_prep_value(None) -> None` and
`DateField().get_prep_value(None) -> None`, so both reach the column as SQL `NULL` and the
`NOT NULL` constraint fires. `nextval` has already been consumed. v2 raises
`DjangoNotNullViolation` / `PythonTypeError` **before** touching the database, so the sequence
never moves. Rows 4 and 5 burn nothing on either stack because both raise before the INSERT
(`int(None)` and the date parse).

**Severity:** low, and cosmetic in isolation — but activity ids are **client-visible** (they are
the `/api/activity/<id>` path and the `id` in every list) and the plan's Phase 5 parity criterion
is *"identical `activityyear` / `activity` / `activityuser` row sets"*, which this violates after
any 500. It is also a genuine correctness signal about where the two implementations put the
`NOT NULL` check. ⚠️ Note the same reasoning would apply to `date: null`, whose v2 message
(`TypeError: expected string or bytes-like object`) does not match v1's mechanism either
(v1 does not raise a `TypeError` for `None`; `DateField.to_python` returns it) — same status, but
the two stacks are 500ing for different reasons.

**Route:** `nestjs-developer`, with `business-analyst` cc'd only if the fund cares about id
continuity; my reading is that it does not, and the fix belongs with P5-F1's.

---

## 5. Diffs accounted for by registered deviations

Every remaining difference in the round maps to a row already in `MIGRATION_PLAN.md` §5 or
`docs/phase-3-deviations.md`. Counts are exact.

| id | shape | cells | where |
|---|---|---|---|
| **D13** | Django's HTML 404 page (`<h1>Not Found</h1>…`, 77 B, `Content-Type: text/html`) vs v2's `{"message":"Not Found"}` (23 B, `application/json`) | **89** | M1 ×84, W2-G ×3, W3-F ×1, W4-D ×1 (+7 raw-socket targets in M4, same shape) |
| **P3-D6** | an **uncaught** 500 renders Django's 27-byte `<h1>Server Error (500)</h1>` with `Content-Type: text/html`; v2 sends a zero-byte 500 with no `Content-Type` | **25** | W2-C ×7, W2-D ×3, W2-E ×6, W2-F ×9 |
| **P3-D8** | v1's browsable API under `Accept: text/html` / `text/*` / `?format=api`, and `JSONRenderer`'s `indent` media-type parameter | **12** | M5 |
| **D21** | gunicorn writes the full entity body on a `HEAD` response; Node suppresses it. `Content-Length` identical, status identical | **3** | M4 (63/0, 63/0, 77/0) |

⚠️ **`docs/phase-5-deviations.md` §4.3 is incomplete.** It pre-declares only **D21–D24** as the
cross-cutting rows that apply here. **D13**, **P3-D6** and **P3-D8** also apply and between them
account for **126 of the 131** differing cells in this round. §4.1's "any observable difference is
a parity failure" is therefore too strong as written and would have produced 126 false failure
reports from a tester who took it literally. Recommend §4.3 be extended to name D13, P3-D6 and
P3-D8 explicitly. **D22/D23/D24 were not exercised** — none of Phase 5's handlers reads
`request.FILES` or wraps a `request.data` read in a bare `except`.

---

## 6. Findings outside Phase 5's scope

### 6.1 N1 — an HTTP method token Node's parser does not recognise is a bare 400 in v2 where v1 answers 401/403

**Cross-cutting, pre-existing, fail-closed, unregistered.** Found by M3's `FROB` cells; isolated
on a raw socket in `f2-methods.py` against `/api/activity/year` as ADMIN.

| token | v1 | v2 |
|---|---|---|
| `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `TRACE` | as per the matrix | identical |
| `PROPFIND`, `MKCOL`, `LOCK`, `PURGE`, `SEARCH`, `REPORT`, `QUERY` | 403 | 403 ✅ |
| `X`, `get`, `Get` (lowercase) | 400 | 400 ✅ |
| **`FROB`** | **403** | **400 Bad Request**, zero body, **no headers at all** |
| **`BREW`** | **403** | **400** |
| **`CONNECT`** | **403** | **empty response — the connection is closed with no reply** |

Node's `llhttp` accepts a fixed method table and rejects anything outside it before the request
reaches Express, so this affects **every route in v2**, not only Phase 5's — reproduced on
`/api/loan` and `/api/user` as well. Both stacks refuse, so it is fail-closed and low severity,
but it is an unregistered observable difference and the `CONNECT` case is a dropped connection
rather than a response. Suggest a §5 row (accept-and-register, most likely). **Route:**
`nestjs-reviewer` to decide whether to register or fix.

### 6.2 N2 — `Connection: close` (v1) vs `Connection: keep-alive` (v2)

Every v1 response carries `Connection: close` (gunicorn 19.9.0 sync worker); every v2 response
carries `Connection: keep-alive` + `Keep-Alive: timeout=5`. Pre-existing, transport-level, present
on every route in every previous phase, and excluded from the compared header set for that reason.
Noted so the exclusion is explicit rather than silent. It is also what made `curl -X HEAD` stall
against v2 and not against v1 — see §8.

### 6.3 `GET /api/activity/<id>` exposes every attached member's full profile to any member

Confirmed live, both stacks: `GET /api/activity/1` as MEMBER(3) returns a body **byte-identical**
to the ADMIN one, containing `identification`, `email`, `birthdate` and `role` for all 13 attached
members. This is `docs/phase-5-deviations.md` §3.2's open finding, not a parity failure — v1 does
the same. Re-flagged for **`business-analyst`**: it is the same exposure D10 and D25 were
introduced to close on the loan and user routes, and if the fund wants the same
owner-plus-`[0,1,2]` predicate here it is a new §5 row, not a Phase 5 implementation detail.

### 6.4 Documentation corrections

| doc | claim | measured |
|---|---|---|
| `phase-5-deviations.md` §4.2 row 9, §4.4; `phase-5-prework.md` §3; the phase brief | `__add_users` writes **15** rows on `fondodev` | **13** (`auth_user` has 15 rows, 2 with `is_active = false`). Both stacks write 13. |
| `phase-5-deviations.md` §4.3 | the pre-declared cross-cutting rows are D21–D24 | D13, P3-D6 and P3-D8 also apply and dominate the diff count — see §5 |

---

## 7. System health

| check | result |
|---|---|
| v1 boots and serves | ✅ `fondo-v1-p4` up 11 h, 3 gunicorn workers, `GET /api/loan` → 401 |
| v2 boots and serves | ✅ started from `p5/start-v2.sh` at the rebuilt `662ed48`; `/health` → `{"status":"ok","database":"up"}` |
| v2 tree clean at the tested commit | ✅ `git status --porcelain` empty, `HEAD = 662ed481762fec4258e43f016415c6087d7f6b08` |
| controller registration order | ✅ `ActivityYearController` → `ActivityYearDetailController` → `ActivityDetailController` (from v2's own route log), which is §3.4's requirement |
| **schema untouched** | ✅ 397-line fingerprint (columns + 169 constraints with `deferrable`/`deferred` + indexes + sequences + tables + `django_migrations` count) — md5 `e347fcec1b54fd43d74a24e2d9c0d4cf` **before and after**, identical |
| no v2 migrations ran | ✅ `django_migrations` = 38 throughout; `_prisma_migrations` = 1 row, unchanged hash |
| **fixture restored** | ✅ `snap.sh` output byte-identical to `BASELINE.snap`, including **every sequence** |
| **full-table verification** | ✅ the dump was restored into a throwaway database `p5verify` and compared per table: **all 24 tables identical** in row count *and* in an order-independent md5 of the row set. `activityyear 9 / activity 25 / activityuser 338 / loan 425 / loandetail 374 / schedulertask 626 / notificationsubscriptions 94 (max id 1468) / auth_user 15 / power 20`. |
| the two-enabled-years anomaly | ✅ intact: `3 / 2020 / t` and `10 / 2026 / t` |
| `count(distinct xmin::text)` | ✅ **1** on `activityyear`, `activity`, `activityuser` (and on `loan`, `schedulertask`) after the final restore |
| no stray writes | ✅ every write-cell row delta was compared across 13 tables + all sequences; nothing outside `activityyear` / `activity` / `activityuser` was ever touched by either stack |
| SES / SQS | ✅ **0 records** captured on both stubs across every write cell. Correct: `ActivityService` publishes nothing. `assert_capture_up()` was enforced on all **27** write cells (W1 ×5, W2 ×7, W3 ×6, W4 ×5, W5 ×1, F1 ×3), i.e. 54 legs. |
| scheduler | ✅ `fondo_api_schedulertask` unchanged at 626 rows, identical hash; v2's `ScheduleModule` logged no cron firing during the run; the v1 celery worker wrote nothing |
| v2 error log | ✅ 59 entries, all expected: 30 `[fondo_api.services.activity]` (the deliberate log of `patch_activity`'s bare `except:`) and 29 `[ApiExceptionFilter]` (the 500 paths). No unexplained errors, no Prisma drift warnings. |

---

## 8. Anti-false-green

`MIGRATION_PLAN.md` §7 records twenty instances. What this round did about them:

1. **Positive controls on every matrix.** M1 nine, M2 five, M3 six, M4 four, M5 three, W0 three,
   and every write cell prints either a positive control ("v1 wrote something") or a negative one
   ("v1 wrote nothing, as the cell asserts"). All passed. Named explicitly in each script.
2. **Status *distributions*, never a pass count.** M1 `{200:48, 401:90, 403:60, 404:96}`; M3
   `{401:23, 403:92}` vs `{400:5, 401:22, 403:88}`; M5 `{200:24, 404:3, 406:6}`. None is uniform —
   instance #4 (72/72 all-401) and #12 (208 cells all-500) could not hide here. M1 additionally
   asserts ≥4 distinct v1 statuses as a control.
3. **Whole payloads compared**, plus byte count, plus the response header set. Instance #6 was a
   round that compared one field.
4. **`curl --path-as-is`** everywhere (condition C27), and a **raw socket** for every cell whose
   subject is the request target or the request line (M4, `f2-methods.py`) — plan §4 rule 14.
5. **Two probe defects were found and fixed *in the probe***, not only described (instance #11):
   * `cmp.py` used `-X HEAD`, which makes curl wait for a body a compliant server never sends.
     Against v2 (`keep-alive`) every HEAD cell stalled for the full `--max-time`; against v1
     (`Connection: close`) it did not. A 294-cell matrix exceeded its timeout and would otherwise
     have been "fixed" by raising the timeout, hiding a transport difference inside a timing one.
     `cmp.py` now uses `--head`, and the underlying `Connection` difference is reported as §6.2.
   * `wcell.report(expect_rows=True)` was applied to cells whose subject is that **nothing** is
     written, so their control could only ever fail — instance #13's shape exactly ("a control
     that always fails silences like one that always passes"). `wcell.py` now takes a tri-state
     and prints a **negative** control for those cells; `w2` cell C and `w4` cell C were
     re-pointed and both suites re-run end to end with identical results.
6. **The restore was controlled before the first write** (W0), covering rows *and* sequences —
   instance #15 was three rounds of undetected sequence drift.
7. **The fixture guard compares sequences**, and the final verification restores the dump into a
   **separate database** and compares per-table row-set hashes rather than an md5 of `pg_dump`
   output (instance #2: `synchronize_seqscans` rotates rows).
8. **The two suites the probe fix touched (`w2`, `w4`) were run twice end to end**, before and
   after the fix, and produced identical statuses, bodies and row deltas both times — so the fix
   changed only the control's wording, not any measurement.
9. **All 24 harness scripts are mode 755** (instance #14). `probe/sitecustomize.py` is 644 and
   correctly so — it is imported via `PYTHONPATH`, never executed.
10. **A documentation claim was checked rather than assumed** and turned out to be wrong: the
    "15 `ActivityUser` rows per activity" in three separate documents is **13** on this fixture.
    A cell asserting 15 would have failed on *both* stacks and read as a v2 defect.

**Claims of identity in this report are backed by these exact commands:**

* "0 diffs across 179 047 bytes" — `p5/m2-sweep.py`, which compares `status`, the full response
  body, `size_download` and the header set for all 73 cells and prints the byte totals.
* "all 24 tables identical" —
  `pg_restore` of `p5r-20260904-165546-pre/fondodev-full.dump` into `p5verify`, then for each
  table `select md5(string_agg(x::text, E'\n' order by x::text)) from <t> x`, diffed against the
  same query on `fondodev`.
* "schema untouched" — `p5/schema.sh`, a 397-line dump of `information_schema.columns` +
  `pg_constraint` (with `condeferrable`/`condeferred`) + `pg_indexes` + `pg_sequences` +
  `pg_tables` + `count(*) from django_migrations`; md5 `e347fcec1b54fd43d74a24e2d9c0d4cf` on
  both sides.
* "fixture restored" — `diff BASELINE.snap FINAL.snap` on `p5/snap.sh` output, which includes
  every sequence's `last_value` and the enabled-year list.

---

## 9. Not covered

Stated rather than implied.

* **The C28 Bogotá year boundary at HTTP level.** No `faketime` on the host or in the container,
  and I did not move the shared host clock. Cross-checked at library level in both runtimes
  (§3.2); the HTTP-level boundary rests on v2's clock-fixed unit cell.
* **Pagination.** None of Phase 5's three routes paginates; there is no `{list, num_pages, count}`
  envelope and no `?page=` handling anywhere in `ActivityService`. The generic pagination-edge and
  out-of-range-query-param cells in my standing method do not apply, and no cell was invented for
  them.
* **`D22` / `D23` / `D24`.** Not reachable: no Phase 5 handler reads `request.FILES`, and none
  wraps a `request.data` read in a bare `except Exception` at the *view* layer.
* **Concurrency.** No interleaving test was run. `create_year`'s missing transaction (P5-D1) is a
  concurrency hazard on paper, but it is a once-a-year path with a unique constraint behind it and
  both stacks reproduce the single-threaded behaviour identically.
* **`GET/POST /api/authorize` and `POST /api/alexa`** — excluded by standing instruction.

---

## 10. For `nestjs-reviewer`

Specific things worth a second pair of eyes:

1. **`describeValue` / `describeType` are used on a storage path** (`python-obj.ts:367-382`).
   They were written for error messages, they return `'list'`/`'object'` where CPython's `str()`
   returns a repr and where even `type(x).__name__` would say `'dict'`, and they are shared by
   `toDjangoText` and `toDjangoTextOrNull`. **P5-F1 is one symptom; D35 is another.** Please
   decide whether the two are fixed together, and check every other `toDjangoText*` call site for
   the same shape before Phase 6.
2. **Where the `NOT NULL` check lives** (P5-F2). v2 raises before the INSERT; Django lets the
   database raise. The status agrees, the sequence does not, and the *reason* for the 500 differs
   on `date: null` (v2 reports a `TypeError` about a string, v1's `DateField.to_python` returns
   `None` happily and the column rejects it). Worth deciding whether v2 should reach the database
   for these, or whether the divergence is acceptable and should be registered.
3. **`docs/phase-5-deviations.md` §4.3 under-declares the cross-cutting rows** — D13, P3-D6 and
   P3-D8 account for 126 of the 131 differing cells here, and §4.1's absolute wording contradicts
   them. This is a documentation defect with a real cost to the next tester.
4. **The "15 `ActivityUser` rows" claim is wrong in three documents** (§6.4). The implementation
   is right; the docs are not.
5. **N1 — non-standard HTTP method tokens** (§6.1). Cross-cutting and unregistered; `CONNECT`
   gets no response at all from v2. Your call whether that is a §5 row or a fix.
6. **§3.2's member-profile exposure through `GET /api/activity/<id>`** is confirmed live on both
   stacks. It is v1's behaviour and correctly not "fixed" in this phase, but it wants an operator
   decision rather than an indefinite hold.

---

## 11. Artefacts

| file | contents |
|---|---|
| `~/.fondo-parity-harness/p5/` | the whole harness, all scripts mode 755 |
| `…/cmp.py`, `…/wcell.py` | the differential probe and the write-cell driver (restore → v1 → restore → v2 → restore) |
| `…/m1-read.py` … `…/m5-accept.py` | the five read matrices |
| `…/w0-restore-check.py` … `…/w5-ties.py` | the write cells, including the restore control |
| `…/f1-name-repr.py`, `…/f2-methods.py` | the two failure isolations and the method-token probe |
| `…/out-m*.json`, `…/out-w*.json`, `…/out-*.txt` | every captured response |
| `…/BASELINE.snap`, `…/FINAL.snap`, `…/schema-pre.txt`, `…/schema-post.txt`, `…/dump-tables.txt`, `…/live-final.txt` | the fixture and schema evidence |
| `~/.fondo-parity-dumps/p5r-20260904-165546-pre/` | the pre-write dump (custom format + per-table SQL), on btrfs |
