# Phase 5 — delta parity round 3 (`d7b95f8` → `0a49e44`)

**Round:** Phase 5, round 3 (delta). Scoped to the delta plus a containment sweep; N1 touched
the HTTP edge, so the sweep covers every implemented route.
**v1:** container `fondo-v1-p4`, repo `/home/miguel/Projects/Fondo-API` @ `5bef585`
(bind-mounted read-only), gunicorn 19.9.0 / Django 2.2.27 / CPython 3.9 on `127.0.0.1:8451`,
`DJANGO_SETTINGS_MODULE=api.settings.production`, celery worker + redis up.
**v2:** `/home/miguel/Projects/Fondo-API-v2` branch `feat/phase-5-activities` @ **`0a49e44`**,
tree clean, rebuilt from source (`prisma generate` + `nest build`, both exit 0) before the run,
started **only** via `~/.fondo-parity-harness/p5/start-v2.sh` on `127.0.0.1:8450`.
**Database:** shared `fondodev` on `127.0.0.1:5432` (PostgreSQL 18.6).
**SES/SQS:** local capture stubs `:4599` (v1) / `:4598` (v2); `assert_capture_up()` in force on
every one of the **192** write cells (384 legs).
**Pre-write dump:** `~/.fondo-parity-dumps/p5r-20260906-164138-delta3r-pre/` (btrfs), pointer
`~/.fondo-parity-dumps/LATEST-P5R`. 24 tables, custom format + per-table SQL.

---

## 0. Verdict

| item under test | verdict |
|---|---|
| **DELTA-F1** — truthy non-string `email` on `POST /api/user` | ✅ **FIXED** — 7/7 refused with **no row, no sequence, no mail** on both; **5/5 truthy *strings* still create** (the discriminator) |
| **N1** — request-line validation and `CONNECT` | ✅ **FIXED** — 73-cell raw-socket boundary probe, status distributions identical, **69/73 fully identical** |
| **N1's second defect** — Nest `@All()` per-verb layers | ✅ **FIXED** — `FROB` is byte-identical to `PUT` on **27/27** route×role cells, same `Allow`, same `Vary` |
| **D37** — burned sequence value | ✅ **AS REGISTERED** — row sets identical, only ids differ, **no collision** on 4 independent checks |
| **D36** — activity roster exposure | ✅ **BYTE-IDENTICAL** — 64/64 cells |
| **D38** — null activation key, incl. the 500/404 sub-case | ✅ **CONFIRMED**, all four v1 outcomes; fixture fully restored |
| Phase 5 regression (6 endpoints) | ✅ **CONTAINED** — every diff is D13 / P3-D6 / D37 |
| Phase 3/4 + whole-edge regression | ✅ **CONTAINED** — 492 in-scope cells, **0 status diffs**, 0 unclassified |
| `POST /api/user` email normalisation | ❌ **FAIL — DELTA3-F1.** v2's `normalizeEmail` omits Django's `.strip()`. **Pre-existing**, not caused by this delta. |

**Phase verdict: FAIL — one failure, pre-existing, narrow, outside the delta.**

Everything this delta set out to fix is fixed and independently verified, each with a
**negative control run against the pre-delta build** (§6). The one failure is a Phase 3 defect
that no previous round probed: it is *adjacent* to DELTA-F1 (the same `normalize_email` call
that round 2's analysis quoted in full) but it is not a regression — the identical 4 cells fail
on `d7b95f8` too, measured.

⚠️ **If `nestjs-reviewer` judges DELTA3-F1 to be a Phase 3 item rather than a Phase 5 gate,
everything in this round's Phase 5 scope is a PASS.** That is the reviewer's call, not mine;
§4.1 gives the evidence for both readings.

---

## 1. System health

⚠️ **v1 was degraded when handed over, exactly as briefed.** The containers were up and v1
answered `GET /api/user → 401`, and the fixture row counts matched — but:

| check | as handed over | after `start-v1.sh` |
|---|---|---|
| gunicorn | ✅ master + 3 workers | ✅ |
| **celery worker** | ❌ **absent** (`/proc` scan: 0 matches) — a container restart kills a `docker exec -d` process | ✅ `celery@… ready`, `Connected to redis://127.0.0.1:6379//` |
| redis | ✅ `PONG` | ✅ |
| **capture stub :4599 (v1)** | ❌ **not listening** | ✅ |
| **capture stub :4598 (v2)** | ❌ **not listening** | ✅ |
| v2 | ❌ not running | ✅ |

⚠️ **The database was also not at baseline, despite every briefed row count matching.**
`snap.sh` against `BASELINE.snap` differed on two lines:

```
seq.fondo_api_activityyear_id_seq   12 (baseline)  ->  16 (as handed over)
xmin.fondo_api_activityyear          1             ->  2
```

Row 9 (`2025`) carried a different `xmin`, i.e. it had been rewritten after the last restore —
residue from the rate-limited attempt's `w1-year-post` cells. Content was identical and the two
enabled years were intact, but a 4-value sequence offset would have silently changed **every id
D37 compares**. Restored from `p5r-20260906-091658-delta-pre` (round 2's verified-baseline dump)
before any cell ran; `diff BASELINE.snap` then empty. **Row counts are not a baseline check.**

| check | result |
|---|---|
| baseline as briefed | ✅ `activityyear 9 / activity 25 / activityuser 338 / loan 425 / loandetail 374 / schedulertask 626 / notificationsubscriptions 94 max(id) 1468 / auth_user 15 / power 20`, `key_activation` NULL **15/15** |
| the two enabled years preserved | ✅ `3:2020` and `10:2026`, before and after |
| **schema untouched** | ✅ `schema.sh` md5 **`e347fcec1b54fd43d74a24e2d9c0d4cf`** before and after — **identical to rounds 1 and 2**, so the N1/DELTA-F1 commits added no migration and no column |
| no migrations ran | ✅ `django_migrations` = 38 throughout; `_prisma_migrations` = 1 row, checksum digest `def0aac52147` unchanged |
| **fixture restored** | ✅ `diff BASELINE.snap FINAL-delta3.snap` **empty** — rows *and* all 19 sequences |
| **full-table verification** | ✅ the pre-write dump restored into throwaway `p5d3verify`: **24/24 tables identical** in count and order-independent row-set md5, `mismatching: 0` |
| `count(distinct xmin::text)` | ✅ **1** on all nine touched tables |
| scheduler / worker | ✅ `schedulertask` back to 626 with an identical row-set hash; v2's `ScheduleModule` logged no cron firing |
| v2 error log | ✅ `drift\|migrat\|P1001\|ECONNREFUSED\|UnhandledPromiseRejection` → **0**. Positive control: the log *does* carry **7 `PythonAttributeError` + 2 `PythonValueError`** — the exact branch split of the 9 refused `d3` cells, so the filter is firing and the right branch is taken per input. ⚠️ `start-v2.sh` truncates `logs/v2.log`, and v2 was deliberately restarted mid-round for §6's negative control, so this is measured on the post-restart log plus a replayed suite, not on the whole run. |
| v2 tree clean at the tested commit | ✅ `git status --porcelain` empty, `HEAD = 0a49e44520409044a2abb2aa8382e8a1a7d1f24b`, worktree list clean after §6 |

---

## 2. Scope

| suite | subject | cells |
|---|---|---|
| `e1-email-branches.py` | DELTA-F1: all three `normalize_email` branches + the discriminator | 21 |
| `e1b-stored.py` | what the created rows actually store (`username` ‖ `email`) | 9 |
| `e1c-strip.py` | `normalize_email`'s `.strip()` against a CPython oracle | 9 |
| `e1d` + ad-hoc | does the address escape to SES? | 4 |
| `e2-rawline.py` | N1, raw socket, **written from the claim and probing its boundaries** | 73 |
| `e4-targets.py` | request-target forms on a known and a recovered method | 16 |
| `e5-allfallback.py` | the `@All()` collapse, as an equivalence **within** each stack | 27 |
| `e6-d37.py` | D37: row sets vs ids vs collisions | 1 |
| `e7-d36.py` | D36: identity, not absence | 64 |
| `e15-edge-scoped.py` | whole-edge regression over implemented routes | 492 |
| `d6` / `d7` | D38 and its positive control | 9 |
| `d1`–`d5`, `d8`, `d8b` | Phase 3/4 containment | 95 |
| `w1`–`w5`, `m1`, `m2`, `f1`, `f2` | the Phase 5 surface | 391 |
| ad-hoc | version echo, non-ASCII methods, pagination, `username` on update | 35 |

---

## 3. What the delta fixed — verified

### 3.1 DELTA-F1 — all three branches, and the discriminator

`e1-email-branches.py`, 21 cells. Status distributions **`{201: 5, 500: 16}` on both stacks.**

| branch | inputs | v1 | v2 | rows | sequences | mail |
|---|---|---|---|---|---|---|
| truthy **non-string** | `["a"]`, `[1,2]`, `true`, `5`, `5.5`, `{"a":1}`, `{"a":["b"]}` | **500** | **500** | none on either | **unmoved on either** | **0/0** |
| falsy | `null`, `""`, `0`, `false`, `[]`, `{}`, `0.0` | 500 | 500 | none | unmoved | 0/0 |
| **truthy string (the discriminator)** | `"0"`, `"false"`, `"[a]"`, `" x@y.com "`, `a@b.com` | **201** | **201** | 3 tables on both | moved on both | **1/1** |
| precedence | non-string email **+** null name; falsy email **+** null name | 500 | 500 | none | unmoved | 0/0 |

The brief's two explicit asks are answered directly: on the seven refused inputs **no sequence
moved on either stack** (`d3` prints `29/29` for every refused cell and `30/30` for every created
one) and **no activation mail was sent** (`0/0` captured on both). `d2`'s status distribution is
now **`{201:5, 409:3, 500:11}` on both** — round 2's two-cell gap is closed.

A refuse-everything fix cannot pass this suite: the five truthy-string cells must create, and
`e1b` shows what they store, character for character.

### 3.2 N1 — re-measured independently, at the boundaries

`e2-rawline.py`, **73 request lines** on a raw socket, written from the developer's claim rather
than from its harness. Status distributions **identical**: `{200:1, 400:18, 401:1, 403:51, 404:2}`.

**The claim holds at every boundary I could construct:**

| boundary | v1 | v2 |
|---|---|---|
| 1-char `X`, 2-char `AB` | 400 | 400 ✅ |
| **3-char `ABC`** | **403** | 403 ✅ — the `{3,20}` lower bound bites between 2 and 3 |
| 20, **21**, 24, 40, **200** characters | **403** | 403 ✅ — `re.match` is a **prefix** match, no upper bound, confirmed |
| `get`, `Get`, `gET` | 400 | 400 ✅ |
| **`GETx`, `POSTx`, `FROBnicate`** | **403** | 403 ✅ — the prefix matches and the token is upper-cased |
| `$ - _ .` and the other 16 characters of the U+0024–U+005F **range** (`% & * + , / : ; < = > ? @ [ ] ^`) | 403 | 403 ✅ |
| `# ! " ` { | ~` (outside the range) | 400 | 400 ✅ |
| **non-ASCII digit in the method** — U+0661 (UTF-8 and latin-1), U+00B2, U+FF10, U+00E9, NUL | 400 | 400 ✅ **body-identical** |
| non-ASCII digit in the **version** — `HTTP/١.١`, `HTTP/²`, NBSP | 400 | 400 ✅ |
| **`CONNECT`** (origin-form) | 403 | **403, byte-identical** ✅ |
| three-bit split: tabs, runs of spaces, leading space, four bits, two bits | 403/403/403/403/400 | identical ✅ |

⚠️ **The registered Unicode-`\d` residual is unreachable from a socket.** gunicorn decodes the
request line latin-1, and no latin-1 codepoint outside ASCII is category `Nd`; probed as raw
bytes in both the method and the version, **8 cells, all identical**. It can stay in the
residuals list as a note, but it is not a behaviour a client can reach.

**The `@All()` collapse** — `e5-allfallback.py`, 9 routes × 3 roles, compared as an equivalence
*within* each stack so that "both 403" cannot hide a lost `Allow`:

```
cells: 27   FROB!=PUT on v1: 0   FROB!=PUT on v2: 0   cross-stack diffs: 3
v1 FROB status distribution: {'401': 8, '403': 16, '404': 3}  ==  v2
```

The three cross-stack diffs are all `/api/user/preferences/4`, all **D13**. `PUT`, `FROB`,
`CONNECT` and a 24-character token all carry `Allow: GET, POST, HEAD, OPTIONS` and
`Vary: Accept, Origin` on both stacks.

**On the developer's "30 of 31 identical, the one difference is D13":** directionally right,
but **under-counted**, because its 31 lines contained no `HTTP/1.0` request and no
authority-form target. My 73 lines find **4** differing — 1 is D13, and the other 3 are §4.2's
pre-existing edge items, all reproduced unchanged on `d7b95f8`.

### 3.3 D37 — accepted, and its two promises checked

`e6-d37.py`: three doomed creates then two that must succeed, on `POST /api/activity/year/10`.

| promise | result |
|---|---|
| row set identical once ids are removed (`activity`) | ✅ `ok-A\|11\|2026-03-01 ; ok-B\|22\|2026-03-02` on both |
| row set identical (`activityuser`, md5 over name/state/user_id) | ✅ `7928b0522eed7e1b8c3ab1f2668d885b` on both, **26 children on both** |
| the ids **do** differ (D37 must stay visible) | ✅ v1 `30, 31` / v2 `28, 29` |
| **no collision:** both successful creates are 201 | ✅ |
| **no collision:** no pre-existing row overwritten | ✅ 0 on both |
| **no collision:** every sequence still ≥ its table's `max(id)` | ✅ on both, all 19 |

Sequences: `fondo_api_activity_id_seq` 27→**31** (v1) vs 27→**29** (v2);
`fondo_api_activityuser_id_seq` 352→378 on **both**. HTTP: statuses identical (500,500,500,
201,201); the only body/header differences are **P3-D6**. Not re-filed.

### 3.4 D36 — identity, not absence

`e7-d36.py`, 7 activities + 1 unknown × 8 roles = **64 cells, 0 differing** — status, body,
byte count and header set. Status distributions `{200:30, 401:24, 404:10}` on both.

The exposure itself, measured on `GET /api/activity/20` as a MEMBER: **15 attached users**, each
with `birthdate, email, first_name, full_name, id, identification, last_name, role,
role_display`, **including the soft-deleted ids 3 and 15** — residual (a) of D36's entry,
present and byte-identical on both stacks. The fund's decision (Q32), not a defect.

### 3.5 D38 — four v1 outcomes, including the corrected sub-case

`d6-activate-d38.py`, unauthenticated. v1 `{200:3, 404:4, 500:1}`; v2 `{404:8}`.

| sub-case | v1 | v2 |
|---|---|---|
| `key: null`, active MEMBER 4 | **200**, hash `ee19e21c…` → `3efd6b8b…` | 404, unchanged |
| `key: null`, soft-deleted user 3 | **200**, `is_active` **false → true** | 404, still false |
| `key: null`, the ADMIN | **200**, hash rewritten | 404, unchanged |
| **`key: null`, no `password` key** | **500** (`KeyError` after the lookup), **nothing written** | **404**, nothing written |
| 4 controls (`""`, absent, `"wrong"`, wrong identification) | 404 | 404 |

Row diffs on the 500 sub-case: `{}` on **both** stacks. `d7-activate-happy.py` supplies the
control the uniform-404 leg needs — create → wrong key (404/404) → correct key (**200/200**),
`is_active` false→true, `key_activation` → NULL, usable `pbkdf2_sha256` on both,
**0 HTTP step diffs, identical row deltas**. v2's 404 is a refusal, not a broken route.

**Data safety.** Baseline captured independently before the first D38 cell and re-checked after
the whole round: `id, is_active, md5(password), identification, key_activation` for **all 15
accounts, byte-identical**.

---

## 4. Failures and things the reviewer should look at

### 4.1 ❌ **DELTA3-F1 — `normalizeEmail` omits Django's `.strip()`**

**Where:** `POST /api/user` (Phase 3), `src/users/user.service.ts:1207`.
**Registered?** No. **Caused by this delta?** **No** — reproduced identically on `d7b95f8` (§6).

Django's `BaseUserManager.normalize_email`:

```python
email = email or ''
try:
    email_name, domain_part = email.strip().rsplit('@', 1)   # <- strips, when there is an '@'
except ValueError:
    pass                                                     # <- no '@': the ORIGINAL is kept
else:
    email = '@'.join([email_name, domain_part.lower()])
return email
```

v2:

```ts
export function normalizeEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) { return email; }
  return `${email.slice(0, at)}@${email.slice(at + 1).toLowerCase()}`;
}
```

`.lower()` is ported; `.strip()` is not.

**Reproduction.**

```
POST /api/user   Authorization: Token <ADMIN>   Content-Type: application/json
{"identification":999000002,"role":3,"first_name":"P","last_name":"T","email":"  a@b.com  "}
```

```
v1 → 201.  auth_user.email    = 'a@b.com'
           auth_user.username = '  a@b.com  '     (v1 does NOT normalise the username)
           SES Destination.ToAddresses.member.1 = ['a@b.com']

v2 → 201.  auth_user.email    = '  a@b.com  '     <-- differs
           auth_user.username = '  a@b.com  '     (same as v1)
           SES Destination.ToAddresses.member.1 = ['  a@b.com  ']   <-- escapes the database
```

`e1c-strip.py`, 9 cells, **4 differ** — every input that has an `@` *and* surrounding
whitespace:

| sent | v1 stores | v2 stores |
|---|---|---|
| `' x@Y.COM '` | `'x@y.com'` | `' x@y.com '` |
| `'  a@b.com'` | `'a@b.com'` | `'  a@b.com'` |
| `'a@b.com  '` | `'a@b.com'` | `'a@b.com  '` |
| `'\ta@b.com\t'` | `'a@b.com'` | `'\ta@b.com\t'` |

**Controls, so the fix cannot be "always strip":**

* v1 matches the CPython oracle on **all 9** inputs (so the model, not just the stack, is right);
* the two **no-`@`** cells (`' no-at-sign '`, `'  '`) are stored **unstripped on both** — v1's
  strip is conditional on the `rsplit` succeeding;
* `username` is **never** stripped on either stack (`' x@Y.COM '` on both), so a fix must touch
  `normalizeEmail` only;
* the **update** path is unaffected — `__update_user_personal` assigns the raw value, and both
  stacks store `' a@b.com '` there. Create-only.

**Severity: moderate.** Leading/trailing whitespace in an email field is ordinary
copy-paste input, not an edge case. It changes a stored column, and it **escapes the database**:
v2 hands the padded address to SES, where a real endpoint answers
`InvalidParameterValue` — and v1's `create_user` rolls the whole account back when
`send_mail` returns falsy, so the divergence compounds beyond the column.

**Route:** `nestjs-developer`.

### 4.2 ⚠️ Edge behaviours measured for the first time — all **pre-existing**, none caused by the delta

Each was re-run against a `d7b95f8` build (§6) and behaves **identically there**, so none is a
regression. None is registered.

| # | request | v1 | v2 | note |
|---|---|---|---|---|
| **O1** | `CONNECT example.com:443` / `FROB example.com:443` (**authority-form**) | 404, Django's HTML page, `Vary`, `X-Frame-Options` | 404, **Express's `finalhandler` page** — `X-Powered-By: Express`, `Content-Security-Policy`, **no `Vary`, no `X-Frame-Options`** | ⚠️ **new shape, and an improvement over round 2's zero bytes.** Status matches; the body is neither v1's nor v2's own `{"message":"Not Found"}`. §4.1a's residual list should name it. |
| **O2** | any request with `HTTP/1.0` or `HTTP/2.0` | echoes the version: `HTTP/1.0 200 OK` | always `HTTP/1.1 200 OK` | **every route, every method, both builds.** Same family as **N2**. |
| **O3** | `GET … HTTP/11.22` | **200** (gunicorn accepts any `\d+.\d+`) | **400** (llhttp caps the version) | a **status** difference, on a known method |
| **O4** | `GET http://localhost/api/activity/year HTTP/1.1` (**absolute-form**, RFC 7230 §5.3.2) | **200**, the real payload | **404** | a **status** difference; a conforming proxy may send this |
| **O5** | `GET api/loan HTTP/1.1` (target without a leading `/`) | 404 | **400**, empty body | llhttp rejects the target |
| **O6** | `FROB api/loan HTTP/1.1` | 404, Django HTML | 404, `{"message":"Cannot FROB api/loan"}` | a **third** 404 body shape beside D13's `{"message":"Not Found"}` |

O2–O5 are properties of Node's parser versus gunicorn's and apply to **every phase**; they are
worth one register row between them rather than six.

### 4.3 ⚠️ A miss in **my own round-2 report**

`d4-update-null.py` cell **E8** (`PATCH /api/user/4`, `email: ["a"]`) was a differing cell in
round 2's `out-d4.txt` and my round-2 report classified `d4` as "identical" on the strength of
its status distribution alone. It is **not a defect** — the behaviour is registered **D15**
(`username` is no longer written on a personal update) and **P3-D2** (the duplicate-email PATCH
is therefore **200**, not 409). I re-measured both halves this round before writing anything:

| case | v1 | v2 |
|---|---|---|
| `PATCH /api/user/4` personal, `email: 'new@example.com'` | 200; `username` **and** `email` → `new@example.com` | 200; `email` → `new@example.com`, `username` **unchanged** — **D15** |
| …with **user 5's** address (a `username` collision) | **409**, nothing written | **200**, written; two rows now share an email — **P3-D2**, verbatim |

The register anticipated both, including that `manual-tester` would see the status change
directly. Recorded here so the omission is on the record, not so the behaviour is re-litigated.

---

## 5. Regression sweep — the delta is contained

### 5.1 The whole HTTP edge (`e15-edge-scoped.py`)

18 implemented routes × 7 methods × 4 roles = **492 cells**.

```
classification: {'identical': 429, 'P3-D6': 33, 'D13': 28, 'D10/D25 (registered)': 2}
v1 {'200':35,'304':1,'400':3,'401':109,'403':246,'404':45,'405':20,'500':33}
v2 {'200':34,'304':1,'400':3,'401':109,'403':248,'404':44,'405':20,'500':33}
STATUS DIFF: 0     OTHER (unclassified): 0
```

`restoreCatchAllRoutes` mutates Express's router at boot, so the two things it could plausibly
have broken were checked by name: **`OPTIONS` status is identical to v1 on every one of the 72
cells** (403 wherever v1 says 403; the four 200s are `/api/user/activate/<id>`, whose view has
`permission_classes = []`, byte-identical on both), and **`HEAD` is identical to v1 on every
cell** — v1 answers **403** to `HEAD` everywhere, because `APIRolePermission` has no `HEAD` key
and its bare `except` returns `False`.

⚠️ `e14`, the unscoped predecessor, reported **114 STATUS DIFFs**. 112 are the four routes v2
has not migrated (`/api/file`, `/api/file/1`, `/api/admin`, `/api/saving-account` — absent from
v2's `RoutesResolver` output, Phases 6–8) and 2 are **D10** (`GET /api/loan/<id>` restricted to
the owner + roles 0/1/2) and **D25** (`GET /api/user/<id>`, same predicate), both reproduced by
hand with curl and checked against the register before being written off. Neither is a
regression; `e15` is the honest scope.

### 5.2 Phase 5's six endpoints

| suite | cells | result |
|---|---|---|
| `w1-year-post` (roles, P5-D1's 304-still-commits, the disable-across-a-gap target, 201, body-never-read) | 5 | **5 PASS** |
| `w2-create-activity` | 7 | 2 PASS, 5 differ |
| `w3-patch` (roles, `?patch=` dispatch, the bare-`except` shapes, P5-D2, `?patch=user`) | 6 | **5 PASS**, 1 differ |
| `w4-delete` (13-child cascade, roles, DELETE on a never-existing id, `get_years` 204) | 5 | **4 PASS**, 1 differ |
| `w5-ties` | 1 | **PASS** |
| `m1-read` role × method × path | 294 | distributions `{200:48, 401:90, 403:60, 404:96}` **identical**; 84 differ, **0 with a status difference** (42 body+headers+bytes, 42 headers-only — all D13); 9/9 controls ok |
| `m2-sweep` every activity and year | 73 | **0 diffs across 179 047 bytes** on both sides; 5/5 controls ok |
| `f2-methods` (round 2's own N1 cell, for continuity) | 21 | **0 of 21 differ** (was 3 of 21) |

Every differing write cell classified by its exact differing-field set:

| cells | fields | cause |
|---|---|---|
| `w2` C, D, E, G · `w3` F · `w4` D | `body`, `bytes`, `headers` **only**, rows identical | P3-D6 / D13 |
| `w2` F | `act` **plus** body/bytes/headers | **D37 only** — names/values/dates identical (`d`, `d`, `""`, `5`, `True`, `['a']`, `Ñandú 🥸`); ids v1 `28,30,31,33,34,35,36` vs v2 `28,29,30,31,32,33,34` |
| `f1` F2 | `seq`, `rows` | D37, the cell that measures it |

`f1` cells F1a/F1b — P5-F1's storage coercion — remain **0 HTTP step diffs**.

### 5.3 Phase 3/4

| suite | cells | result |
|---|---|---|
| `d8-loan-sweep` — approve/deny/payout, refinance both directions, refinance-then-approve/deny, quota rejection, `paymentProjection` ×4, role matrix | 11 | **11 PASS**, 0 differing |
| `d8b-payout` — paying out loan 279 removes its **84** `payment_reminder` rows, 626→542 on both | 1 | **PASS** |
| `d1-limits` — `python-str.ts`'s three documented limits | 23 | `identical: 15  differing: 8  SURPRISES: 0` |
| `d2-create-null` | 19 | 5 identical, 3 D37-only, **11 P3-D6-only** |
| `d4-update-null` | 17 | 15 PASS, 1 D37, 1 **D15/P3-D2** (§4.3) |
| `d5-interp` — refinance comment and birthday message | 13 | 12 PASS, 1 D37 |
| pagination edges (`/api/user`, `/api/loan`) | 14 | 12 byte-identical; page-out-of-range → **200 + `{list,num_pages,count}`** on both; `page=0`/`page=-1` → **400**, identical 48/57-byte bodies; the 2 diffs are `page=abc` → 500, P3-D6 |

---

## 6. Anti-false-green

Twenty-one recorded instances, three of the last four being *reading absence as proof*. What
this round did.

1. **Every claim of a fix has a negative control against the pre-delta build.** `d7b95f8` was
   checked out into a `git worktree`, built (`prisma generate` and `nest build`, **both asserted
   exit 0** — the first attempt failed with `PrismaConfigEnvError` and would have been read as
   success by a `2>&1 | tail -1` idiom), served on the same port, and probed with the **same
   scripts**:

   | probe | at `0a49e44` | at `d7b95f8` |
   |---|---|---|
   | `e2-rawline` (N1) | 4 of 73 differing | **62 of 73**, incl. `'RESPONSE': 2` — *zero bytes* for both `CONNECT` cells |
   | `e5-allfallback` (`@All`) | `FROB!=PUT on v2: 0` | **27 of 27**, all bare 400 |
   | `d3-email-truthy` (DELTA-F1) | 0 of 11 differing | **7 of 11** — 201 + a row + **1 activation mail** each |
   | `e1c-strip` (DELTA3-F1) | 4 of 9 differing | **4 of 9, identical failure** → the finding is pre-existing |
   | `vercheck` (O2–O5) | same 6 diffs | **same** → pre-existing |

   The worktree was removed and the repo re-verified clean at `0a49e44` afterwards.
2. **Positive controls declared and printed per suite**, 70 in all. The strongest are the ones
   that would break under a lazy fix: `e1`'s five truthy-**string** cells (a refuse-everything
   fix fails), `e1c`'s CPython oracle and its two no-`@` cells (an always-strip fix fails),
   `d7`'s create→activate→200 (a broken-route "fix" fails), `e5`'s within-stack `FROB == PUT`
   (a fix that dropped `Allow` on both would pass a cross-stack check).
3. **Status *distributions*, never a pass count** — `e2` `{200:1,400:18,401:1,403:51,404:2}`,
   `e15` eight-way, `d6` `{200:3,404:4,500:1}`, `m1` `{200:48,401:90,403:60,404:96}`. None
   uniform.
4. **The handover was distrusted and was wrong twice** — v1 came back without celery or either
   capture stub behind a 401 that looked healthy, and the **database was 4 sequence values off
   baseline with every row count correct** (§1). Either would have produced a quiet false
   result: the second changes every id D37 compares.
5. **Exit codes asserted, silence never read as success.** Every script's `$?` is captured; the
   two builds above are the case where it mattered.
6. **Six probe defects found, five of them mine, all recorded rather than quietly fixed:**
   * `e6-d37`'s first check ("every HTTP status/body/header identical") counts **P3-D6** as a
     failure and printed `VERDICT: *** FAIL ***` while all ten substantive D37 checks passed —
     a **false red**;
   * `d2`/`d4`/`d5`'s negative controls print `*** FAILED — v1 wrote: ['_sequences'] ***`, which
     is now **D37** and expected — three more false reds;
   * `d8`'s J4 control (loan 456 has no `payment_reminder` rows) is still in the script from
     round 2 and still can only fail; `d8b` is the real measurement;
   * `e14`'s route list and classifier produced **114 false STATUS DIFFs** (§5.1) — re-scoped as
     `e15`;
   * my `OPTIONS`-always-403 and `HEAD`-mirrors-`GET` controls had **wrong premises** and fail
     on **v1** too; replaced with v1-relative equivalents;
   * my v2-log error grep matched `drift|migrat|...|Unhandled`, and `[ApiExceptionFilter]
     Unhandled exception on POST /api/user` **is the filter's own expected message** — 9
     matches, all self-inflicted. Re-run with `UnhandledPromiseRejection` → 0, plus a positive
     control that the log *does* show 7 `PythonAttributeError` + 2 `PythonValueError`.
7. **Every "registered, not a defect" call was checked against the register before being made** —
   D10, D25, D15 and P3-D2 were each read in `MIGRATION_PLAN.md` §5 after the cell failed, not
   assumed from a route name. §4.3 is what that discipline caught.
8. **`assert_capture_up()` on all 192 write cells** (384 legs); capture counts are evidence, not
   decoration — DELTA-F1's `0/0` and DELTA3-F1's SES recipient are both part of a finding.
9. **Restores are always `pg_restore` from the custom-format dump**, before each leg and after;
   the final verification restores into a **separate database** and compares per-table
   row-set hashes (24/24).

**Claims of identity in this report are backed by these exact commands:**

* *"24/24 tables identical"* — `pg_restore` of
  `p5r-20260906-164138-delta3r-pre/fondodev-full.dump` into `p5d3verify`, then per table
  `select coalesce(md5(string_agg(x::text, E'\n' order by x::text)),'EMPTY')||'/'||count(*) …`,
  compared against `fondodev`. Output: `tables compared: 24  mismatching: 0`.
* *"schema untouched"* — `p5/schema.sh`, md5 `e347fcec1b54fd43d74a24e2d9c0d4cf` before, after,
  and in rounds 1 and 2.
* *"fixture restored"* — `diff BASELINE.snap FINAL-delta3.snap`, empty.
* *"D38 left nothing behind"* — the 15-row `id, is_active, md5(password), identification,
  key_activation` query, captured independently before the first D38 cell and re-run last.
* *"v1 matches the CPython oracle"* — `e1c-strip.py` carries Django's expected output per input
  and asserts it against v1's stored column on all 9.

---

## 7. For `nestjs-reviewer`

1. **DELTA3-F1** (§4.1) — the missing `.strip()`. **Pre-existing, so the Phase 5 gate decision
   is yours.** Round 2's own write-up quoted `normalize_email` as "`email or ''` then
   `email.strip()`" while auditing the truthiness branch; the strip itself was never probed
   until now. Worth asking whether any other Django helper was ported by its *purpose* rather
   than line by line — `normalizeUsername` (NFKC) is correct, checked.
2. **§4.1a's residual list is missing O1** (§4.2): a `CONNECT`/unknown-method request with an
   **authority-form** target now reaches Express's `finalhandler` instead of Nest's filter, so
   it answers with `X-Powered-By: Express` and **without** `Vary` or `X-Frame-Options`. Status
   is right and it is a large improvement on round 2's zero bytes; two sentences, not a change.
3. **O2–O5 deserve one register row between them** (§4.2). The version echo and `HTTP/11.22` are
   cross-cutting gunicorn-vs-Node facts in **N2**'s family; absolute-form and no-slash targets
   are llhttp's URL rules. All four are pre-existing and proven so on `d7b95f8`.
4. **The Unicode-`\d` residual is unreachable** (§3.2) — 8 raw-byte cells, method and version,
   identical on both stacks, because gunicorn decodes latin-1. Downgrade it from a residual to a
   footnote.
5. **§4.3 records a miss in my round-2 report**, not a defect: `d4`'s E8 was a differing cell I
   classified by status distribution alone. The behaviour is D15 + P3-D2 and the register had
   already predicted that `manual-tester` would see the 409→200 directly.
6. **`d8`'s J4 control and `e6`'s first check are still false-red generators** in the harness
   (§6.6). They cost nothing but they make a green run look amber; worth a note if this harness
   is inherited.
7. **The handover check that matters** (§1): row counts matched while the sequence was 4 ahead
   and `activityyear` carried two `xmin` values. Any future round should diff `snap.sh` against
   `BASELINE.snap`, not eyeball the counts.

## 8. Not covered

* The C28 Bogotá year boundary at HTTP level (no `faketime`; unchanged from rounds 1–2).
* Concurrency / interleaving.
* `GET/POST /api/authorize` and `POST /api/alexa` — excluded by standing instruction.
* `/api/file`, `/api/admin`, `/api/saving-account`, powers of attorney and the TSV bulk uploads
  — later phases; `git diff d7b95f8..0a49e44 -- src/` touches none of them.
* gunicorn's `limit_request_line` (4094) and `limit_request_field_size` (8190), which the
  developer declares unported.

## 9. Artefacts

| path | contents |
|---|---|
| `~/.fondo-parity-harness/p5/` | the harness; `e1*`, `e2`, `e4`–`e7`, `e14`, `e15` are this round's suites |
| `…/out-r3-*.txt` | every captured response and row delta from this round |
| `…/out-r3-NEGCTL-*.txt` | the four negative-control runs against the `d7b95f8` build |
| `…/BASELINE.snap`, `…/FINAL-delta3.snap` | fixture evidence |
| `~/.fondo-parity-dumps/p5r-20260906-164138-delta3r-pre/` | this round's pre-write dump, 24 tables |
