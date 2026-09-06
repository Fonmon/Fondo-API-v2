# Phase 5 — delta parity round (`662ed48` → `d7b95f8`)

**Round:** Phase 5, round 2 (delta). Not a repeat of round 1; scoped to what changed plus a
containment sweep over the Phase 3/4 routes the fixes touch.
**v1:** container `fondo-v1-p4`, repo `/home/miguel/Projects/Fondo-API` @ `5bef585`
(bind-mounted read-only), gunicorn 19.9.0 / Django 2.2.27 / CPython 3.9 on `127.0.0.1:8451`,
`DJANGO_SETTINGS_MODULE=api.settings.production`, celery worker + redis up.
**v2:** `/home/miguel/Projects/Fondo-API-v2` branch `feat/phase-5-activities` @ **`d7b95f8`**,
tree clean, rebuilt from source (`prisma generate` + `nest build`) before the run, started
**only** via `~/.fondo-parity-harness/p5/start-v2.sh` on `127.0.0.1:8450`.
**Database:** shared `fondodev` on `127.0.0.1:5432` (PostgreSQL 18.6).
**SES/SQS:** local capture stubs `:4599` (v1) / `:4598` (v2); `assert_capture_up()` in force on
every one of the **109** write cells.
**Pre-write dump:** `~/.fondo-parity-dumps/p5r-20260906-091658-delta-pre/` (btrfs; `dump.sh`
refuses tmpfs), pointer `~/.fondo-parity-dumps/LATEST-P5R`. 24 tables, custom format + per-table
SQL.

---

## 0. Verdict

| item under test | verdict |
|---|---|
| **P5-F1** — storage coercion (`python-str.ts`) | ✅ **FIXED** — 10/10 stored values and 10/10 response bodies byte-identical |
| **P5-F1** — the three documented limits | ✅ **AS DOCUMENTED** — 8/8 differ exactly as the module says, 15/15 claimed-closed inputs identical, **0 surprises** |
| **D35** — `first_name`/`last_name` null on create → 409 | ✅ **CONFIRMED** (status, body, bytes, headers identical) |
| **D35** — falsy `email` on create → 500 | ✅ **CONFIRMED** for `null`, `""`, `0`, `false`, `[]`, `{}`, `0.0`; `"0"` and `"false"` correctly remain 201 |
| **D35** — truthy **non-string** `email` on create | ❌ **FAIL — DELTA-F1.** v1 **500 / nothing written**; v2 **201 / account created + mail sent**. 7 of 7 inputs. |
| **D35** — `first_name`/`last_name`/`email` null on update → 409 | ✅ **CONFIRMED**, including `email`'s 500-on-create / 409-on-update split |
| **D35** — `primary_color`/`secondary_color` null on preferences → 404 | ✅ **CONFIRMED** (bare `except`), plus `notifications: null` |
| **D35** — birthday notification renders `None` | ✅ **CONFIRMED** (6/6 identical); the `None` branch itself is **unreachable** — see §3.4 |
| **D35** — refinance comment renders `None` | ✅ **CONFIRMED** (7/7 identical, `None` not `null`) |
| **D38** — null activation key | ✅ **EXPECTED DIVERGENCE, not a failure.** v1 takes over 3/3 accounts incl. the ADMIN and resurrects a soft-deleted one; v2 refuses 404 and changes nothing. Fixture fully restored. |
| **P5-F2** — sequence burned after a 500 | ⚠️ **STILL OPEN**, and now measured on **Phase 3 routes too** — see §4.2 |
| **N1** — `CONNECT` / unknown method tokens | ⚠️ **STILL OPEN**, unchanged |
| Phase 5 regression (6 endpoints) | ✅ **CONTAINED** — every diff is D13 or P3-D6 except the known P5-F2 id skew |
| Phase 3/4 regression (loans) | ✅ **PASS** — 11/11 cells fully identical |

**Phase verdict: FAIL — one new failure (DELTA-F1), narrow and precisely located.**
Everything the delta set out to fix is fixed and verified. DELTA-F1 is the *other half* of the
same `_create_user` guard D35 ported: the falsy branch was ported from the raw body value, the
truthy-non-string branch was not, and v2 creates an account v1 refuses. That is the exact
failure mode D35 exists to prevent, so it belongs with D35's fix rather than as a new register
row.

---

## 1. System health

Both stacks were restarted after the 38-hour outage and verified before any cell ran.

| check | result |
|---|---|
| `fondo_db` healthy | ✅ PostgreSQL 18.6, `pg_isready` accepting connections |
| `fondo-v1-p4` healthy | ✅ **but it came back degraded and was rebuilt.** The container was up and served `GET /api/loan → 401`, yet **redis was down, the celery worker was dead (a container restart kills a `docker exec -d` process) and both capture stubs were down.** Trusting the cell at that point would have measured v1 with no async notification path and no SES/SQS capture on either side — false-green instance #9's exact shape. Rebuilt with `start-v1.sh`: gunicorn ×3, `celery@… ready`, `Connected to redis://127.0.0.1:6379//`, stubs `:4599`/`:4598` listening. |
| fixture untouched by the outage | ✅ `snap.sh` output **byte-identical** to round 1's `BASELINE.snap`, including every sequence — nothing wrote to `fondodev` while the stack was down |
| baseline as briefed | ✅ `activityyear 9 / activity 25 / activityuser 338 / loan 425 / loandetail 374 / schedulertask 626 / notificationsubscriptions 94 max(id) 1468 / auth_user 15 / power 20` |
| the two enabled years preserved | ✅ `3:2020:true` and `10:2026:true` present before and after |
| v2 boots | ✅ `/health` → `{"status":"ok","database":"up"}`; 14 `RoutesResolver` + 16 `InstanceLoader` lines, one `NestApplication` |
| v2 tree clean at the tested commit | ✅ `git status --porcelain` empty, `HEAD = d7b95f85e79f97f1a0d1cf9f0d498f0439887084` |
| **schema untouched** | ✅ `schema.sh` md5 **`e347fcec1b54fd43d74a24e2d9c0d4cf`** before and after — *and identical to round 1's*, so the D35/D38 commits added no migration and no column |
| no migrations ran | ✅ `django_migrations` = 38 throughout; `_prisma_migrations` = 1 row, checksum `a5d98fdb…c38eb` unchanged |
| **fixture restored** | ✅ `diff BASELINE.snap FINAL-delta.snap` empty — rows *and* every sequence |
| **full-table verification** | ✅ the pre-write dump restored into throwaway `p5dverify` and compared per table: **24/24 identical** in row count and in an order-independent row-set md5 |
| `count(distinct xmin::text)` | ✅ **1** on all nine touched tables (`activity`, `activityyear`, `activityuser`, `loan`, `loandetail`, `auth_user`, `userprofile`, `userpreference`, `schedulertask`) |
| no stray writes | ✅ every write cell diffed 13 tables + all 19 sequences; nothing outside the tables each cell targets was ever touched by either stack |
| scheduler / worker | ✅ `schedulertask` back to 626 with an identical row-set hash; v2's `ScheduleModule` logged no cron firing; the v1 celery worker wrote nothing outside the cells that call it |
| v2 error log | ✅ 532 lines: 49 `[ApiExceptionFilter]` (the 500 paths), 30 `[fondo_api.services.activity]` (the deliberate bare-`except` log), 31 boot lines. **0** matches for `drift|migrat|P1001|ECONNREFUSED` |
| SES/SQS capture | ✅ enforced on all 109 write cells; counts recorded per cell and compared (they are evidence in §3.1 and §4.1) |

---

## 2. Scope, and what each cell suite covers

| suite | subject | cells |
|---|---|---|
| `f1-name-repr.py` (re-run) | P5-F1 create + patch, P5-F2 sequence burn | 3 |
| `d1-limits.py` | `python-str.ts`'s three documented limits + every repr path it claims to close | 23 inputs |
| `d2-create-null.py` | D35 on `POST /api/user` — null names, falsy emails, precedence | 19 |
| `d3-email-truthy.py` | the truthy-non-string email family | 11 |
| `d4-update-null.py` | D35 on `PATCH /api/user/<id>` — personal **and** preferences | 17 |
| `d5-interp.py` | the two interpolation sites (refinance comment, birthday message) | 13 |
| `d6-activate-d38.py` | D38, with a full password/`is_active` restore proof | 8 |
| `d7-activate-happy.py` | create→activate, the positive control D38's matrix needs | 1 |
| `d8-loan-sweep.py` | Phase 4 regression: approve/deny/payout/refinance/quota/projection/roles | 11 |
| `d8b-payout.py` | the fixed payout control | 1 |
| `w0`–`w5` (re-run) | the Phase 5 write surface | 24 |
| `m1-read.py`, `m2-sweep.py` (re-run) | the Phase 5 read surface | 367 |
| `f2-methods.py` (re-run) | N1 | 21 |

---

## 3. What the delta fixed — verified

### 3.1 P5-F1 — storage coercion is now faithful

`f1-name-repr.py` cells F1a/F1b, re-run unchanged from round 1.

**Create** (`POST /api/activity/year/10`), stored `fondo_api_activity.name`:

| body `name` | v1 stores | v2 stores | round 1 v2 |
|---|---|---|---|
| `{"a":1}` | `{'a': 1}` | `{'a': 1}` ✅ | ~~`object`~~ |
| `["a"]` | `['a']` | `['a']` ✅ | ~~`list`~~ |
| `[1,2]` | `[1, 2]` | `[1, 2]` ✅ | ~~`list`~~ |
| `[]` | `[]` | `[]` ✅ | ~~`list`~~ |
| `{}` | `{}` | `{}` ✅ | ~~`object`~~ |
| `{"a":[1,{"b":2}]}` | `{'a': [1, {'b': 2}]}` | same ✅ | ~~`object`~~ |
| `5` / `5.5` / `true` / `"x"` | `5` / `5.5` / `True` / `x` | identical ✅ | identical (the control) |

The space after the colon in `{'a': 1}` and after the comma in `[1, 2]` is present on both.
The four scalars are the cell's positive control and still agree — the matrix *can* agree, so
the six that now agree are a real fix and not a broken probe.

**Patch** (`PATCH /api/activity/1?patch=activity`), where round 1's defect reached the wire:
**HTTP step diffs: 0** across all ten inputs, byte counts identical
(3389/3390/3386/3392/3386/3404/3385/3387/3388/3385 on both). Round 1's
`{"name":"object"}` is gone:

```
v1 200 {"id":1,"name":"{'a': 1}","date":"2026-03-01","value":1,"users":[…]}   3392 B
v2 200 {"id":1,"name":"{'a': 1}","date":"2026-03-01","value":1,"users":[…]}   3392 B
```

### 3.2 The three documented limits — probed, not assumed

`d1-limits.py`, 23 raw-body inputs (`json.dumps` would have destroyed the distinctions L1/L2
turn on, so every body is a literal string).

**Documented to differ — all 8 do, and only these:**

| limit | input | v1 | v2 |
|---|---|---|---|
| L1 integral float | `5.0` | `5.0` | `5` |
| L1 | `-0.0` | `-0.0` | **`0`** — the sign is lost too, which the docblock does not mention |
| L1 | `1e2` | `100.0` | `100` |
| L1 inside a container | `[5.0]` | `[5.0]` | `[5]` |
| L2 large int | `1000000000000000000000` | `1000000000000000000000` | `1e+21` |
| L2 | `9007199254740993` (2⁵³+1) | `9007199254740993` | **`9007199254740992`** — the *value* is corrupted by `JSON.parse`, not merely re-rendered; the docblock frames L2 as a rendering difference |
| L3 dict key order | `{"b":1,"1":2}` | `{'b': 1, '1': 2}` | `{'1': 2, 'b': 1}` |
| L3 | `{"z":1,"0":2}` | `{'z': 1, '0': 2}` | `{'0': 2, 'z': 1}` |

**Claimed closed — all 15 byte-identical.** This is the round's strongest positive control:
`9007199254740991` (2⁵³−1), `5.5`, `1e-7` → `1e-07` (CPython's two-digit exponent padding),
`[null]` → `[None]`, `[true,false]` → `[True, False]`, `{"a":[1,{"b":[null,true]}]}`, the quote
rule in all three of its states (`["a'b"]` → `["a'b"]`, `['a"b']` → `['a"b']`,
`["a'b\"c"]` → `['a\'b"c']`), backslash, `\n`/`\t`/`\r`, U+200B → `​`, U+0085 → `\x85`
(the escape *width* rule), U+1F600 emitted literally (printable), and string-key insertion
order preserved.

```
identical: 15   differing: 8   SURPRISES: 0
```

### 3.3 D35 — create, update and preferences

`d2-create-null.py` (19) + `d3-email-truthy.py` (11) + `d4-update-null.py` (17).

| behaviour | measured on v1 | v2 | verdict |
|---|---|---|---|
| `POST /api/user` `first_name: null` | **409** `{"message":"Identification/email already exists"}`, 49 B | identical status, body, byte count and header set | ✅ |
| `POST` `last_name: null`, both null | 409, same body | identical | ✅ |
| `POST` falsy `email` — `null`, `""`, `0`, `false`, `[]`, `{}`, `0.0` | **500**, nothing written, no sequence moved | 500, nothing written | ✅ (body diff = P3-D6) |
| `POST` `email: "0"` / `"false"` | **201** | 201 | ✅ — truthiness is on the raw value, not the coerced text |
| precedence: falsy email **+** null name | **500** (the `ValueError` precedes the INSERT) | 500 | ✅ |
| `PATCH … personal` `first_name`/`last_name`/**`email`** null | **409**, nothing written | 409 | ✅ |
| `PATCH … preferences` `primary_color`/`secondary_color`/both null | **404** (bare `except`) | 404 | ✅ |
| `PATCH … preferences` `notifications: null` | **404** | 404 | ✅ (bonus) |
| ordering: `PATCH /api/user/9999` with `first_name: null` | **404**, not 409 | 404 | ✅ — v2 did not hoist its new 409 above the `DoesNotExist` |

**`email` is 500 on create and 409 on update — confirmed on both stacks.** Create routes it
through `_create_user`'s Python validation; update assigns it straight to the column.

Status distributions (never a pass count): `d2` v1 `{201:5, 409:3, 500:11}` = v2
`{201:7, 409:3, 500:9}` — the 2-cell gap is DELTA-F1. `d4` v1 `{200:6, 404:6, 409:5}` =
v2 `{200:6, 404:6, 409:5}`, identical.

Every remaining `d2` diff was classified by its exact differing-field set rather than assumed:

| cells | differing fields | cause |
|---|---|---|
| A0, B8, B9, D1, D2 | *(none)* | identical |
| A1, A2, A3 | `seq_auth_user` **only** | P5-F2 (§4.2) |
| B1–B7, C1, C2 | `body`, `bytes`, `headers` **only** | P3-D6, registered |
| D3, D4 | status + every row + 3 sequences + mail | **DELTA-F1** |

### 3.4 The two interpolations

`d5-interp.py`. Both are `str()` contexts, so `None` → the four characters `None` is *correct*
and is the opposite of what the column does.

**Refinance comment** — `POST /api/loan/397/refinance`, 7/7 stored `comments` identical:

| body `comments` | stored (both stacks) |
|---|---|
| `null` | `…no incluye intereses. None` ← **`None`, not `null`** |
| `"hola"` (control) | `…no incluye intereses. hola` |
| `""` | `…no incluye intereses. ` |
| `["a"]` / `5` / `true` / `{"a":1}` | `['a']` / `5` / `True` / `{'a': 1}` |

Both-direction linking confirmed in the same rows: new loan `458` carries `prev_loan_id: 397`
and source loan `397` carries `refinanced_loan: 458`, identical on both stacks.

**Birthday message** — `PATCH /api/user/4` type `personal` with a `birthdate`, message read out
of the `fondo_api_schedulertask` hstore payload. 6/6 identical:
`Hoy está cumpliendo años ['a'] Montañez Gómez`, `… 5 …`, `… True …`,
`… Andrés Felipe {'a': 1}`.

⚠️ **The `None` branch of this message is unreachable, on both stacks.** `auth_user.first_name`
and `last_name` are `NOT NULL`, and v1 calls `__create_birthdate_notification(user)` *inside*
`transaction.atomic()` **before** `user.save()` — so a null name renders `Hoy está cumpliendo
años None None`, then `save()` raises `IntegrityError` and the whole block, scheduler rows
included, rolls back. Measured: cell H5 is a 409 on both stacks with `schedulertask` unchanged
at 626 and no `None None` message anywhere. v2's `?? 'None'` is therefore correct *and* dead
code. Worth a docblock note rather than a change.

### 3.5 D38 — expected divergence, not a failure

`d6-activate-d38.py`. Premise verified first: **all 15 profiles have `key_activation IS NULL`**
(`select count(*) filter (where key_activation is null), count(*) from fondo_api_userprofile`
→ `15|15`), and 2 accounts are soft-deleted.

| case | v1 | v2 |
|---|---|---|
| `key: ""` (control) | 404 | 404 |
| `key` absent (control) | 404 | 404 |
| `key: "wrong"` (control) | 404 | 404 |
| `key: null`, **wrong** identification (control) | 404 | 404 |
| **`key: null`, active MEMBER 4** | **200**, password hash `ee19e21c…` → `4fdc115d…` | **404**, hash unchanged |
| **`key: null`, SOFT-DELETED user 3** | **200**, `is_active` **false → true**, hash `96381c28…` → `8fc4faa8…` | **404**, `is_active` still false, hash unchanged |
| **`key: null`, the ADMIN (user 1)** | **200**, hash `935f2fcd…` → `0cc31c49…` | **404**, hash unchanged |
| `key: null`, **no `password` key** | **500** (`obj['password']` → `KeyError`, after the lookup, nothing written) | **404** |

All eight expected outcomes and all four controls passed.

⚠️ **v2 answers 404 to all eight**, so this matrix alone cannot distinguish "refuses" from
"the route is broken". `d7-activate-happy.py` supplies the missing control: create a member
(minting a real 50-char key), activate with a deliberately corrupted key → **404 on both**,
then activate with the correct key → **200 on both**, with `is_active` false→true,
`key_activation` → NULL and a usable `pbkdf2_sha256` password on both.
**HTTP step diffs: 0, row deltas identical, VERDICT PASS.** v2's 404 is a refusal.

**Data safety.** Every leg was bracketed by `pg_restore` (before v1, before v2, after). The
script ends by re-querying `id, is_active, md5(password), identification, key_activation` for
all 15 accounts and diffing against the baseline captured before the first D38 cell:

```
DATA SAFETY: auth_user password hashes + is_active + key_activation for ALL 15 accounts
             are byte-identical to the pre-D38 baseline. Nothing left behind.
```

---

## 4. Failures and open items

### 4.1 ❌ **DELTA-F1 — a truthy non-string `email` creates an account in v2 that v1 refuses**

**Where:** `POST /api/user` (Phase 3). **Registered?** No.
**Cells:** `d2-create-null.py` D3/D4, isolated in `d3-email-truthy.py` (7 inputs).

**Reproduction.**

```
POST /api/user   Authorization: Token <ADMIN>   Content-Type: application/json
{"identification":999000009,"role":3,"first_name":"A","last_name":"B","email":["a"]}
```

```
v1 → HTTP/1.1 500 Internal Server Error   Content-Type: text/html   27 B
     container log: AttributeError: 'list' object has no attribute 'strip'
     rows written: none.  auth_user_id_seq: 29 → 29.  mails sent: 0.

v2 → HTTP/1.1 201 Created   Content-Length: 0
     auth_user id 30 written: username = '[''a'']', email = '[''a'']', is_active = f
     + fondo_api_userprofile, fondo_api_userfinance, fondo_api_userpreference rows
     auth_user_id_seq 29 → 30, userfinance 17 → 18, userpreference 17 → 18
     mails sent: 1 (an activation email to the address "['a']")
```

**All seven inputs behave the same way** — `["a"]`, `[1,2]`, `true`, `5`, `5.5`, `{"a":1}`,
`{"a":["b"]}`: v1 500 / nothing, v2 201 / row + mail.

**Mechanism.** `create_user` passes `obj['email']` **raw** to
`UserProfile.objects.create_user(username=…, email=…)`. `_create_user` calls
`BaseUserManager.normalize_email(email)`, which is `email = email or ''` then `email.strip()`.
Measured in the pinned container:

```
['a']  -> RAISES AttributeError 'list' object has no attribute 'strip'
True   -> RAISES AttributeError 'bool' object has no attribute 'strip'
0      -> ''          ''  -> ''     None -> ''     []   -> ''     {} -> ''
'0'    -> '0'         'a@b.com' -> 'a@b.com'
```

So there are **three** branches, not two: falsy → `ValueError` (500); truthy non-`str` →
`AttributeError` (500); truthy `str` → proceed.

**Root cause in v2** (`src/users/user.service.ts:160`):

```ts
const rawEmail = toDjangoText(pyGet(obj, 'email'));   // <- already coerced to text
…
if (isPythonFalsy(pyGet(obj, 'email'))) { throw new PythonValueError(…); }   // raw: correct
…
username: normalizeUsername(rawEmail as string),
email:    normalizeEmail(rawEmail as string),
```

The falsy guard reads the **raw** value and is right. `rawEmail` — despite the name — holds
`toDjangoText(...)`, i.e. `pythonStr(...)`, so `["a"]` has already become the *string* `"['a']"`
before `normalizeEmail` sees it, and the `as string` cast silences the type system that would
otherwise have caught it. The commit message's own reasoning ("Python truthiness on the **raw**
email") was applied to one branch of the guard and not the other.

**Severity: moderate.** It is the precise failure D35 was raised to prevent — *v2 must not
create records v1 refuses* — it is a **write** on an ADMIN-reachable route, it burns three
sequences, and it **sends an activation email** to a nonsense address, so it escapes the
database. A malformed client field silently produces a member account.

**Route:** `nestjs-developer`, with D35's fix.

### 4.2 ⚠️ **P5-F2 is still open, and it now reaches Phase 3**

Unchanged on `POST /api/activity/year/<id_year>` (`f1-name-repr.py` cell F2): v1's
`fondo_api_activity_id_seq` reaches 31 where v2 reaches 29, and the final rows are
`28=a, 31=z` (v1) vs `28=a, 29=z` (v2). Every status matches.

**New this round — the same shape on two Phase 3 cells**, where the input is far more plausible
than a non-scalar activity name:

| cell | request | v1 | v2 | delta |
|---|---|---|---|---|
| `d2` A1/A2/A3 | `POST /api/user` with `first_name: null` | 409 | 409 | `auth_user_id_seq` **29 → 30** on v1, **29 → 29** on v2 |
| `d4` E5 | `PATCH /api/user/4` personal, `birthdate` + `first_name: null` | 409 | 409 | `fondo_api_schedulertask_id_seq` **2528 → 2529** on v1, unmoved on v2 |

In both, status, body, byte count, header set **and every table row** are identical; only the
sequence differs. Mechanism is P5-F2's: Django issues the INSERT and PostgreSQL refuses it
(`nextval` already consumed, and sequences are non-transactional so the rollback does not
return it); v2's new explicit `NOT NULL` reproduction throws before Prisma is called. E5 also
shows v1's `__create_birthdate_notification` INSERT committing its `nextval` before
`user.save()` raises.

This is a **consequence of the D35 fix's design**, which the fix documents honestly (Prisma
validates required fields client-side, so the database never sees the null). It is not a
regression. But `user_id` values are client-visible, so the reviewer's register-or-fix decision
on P5-F2 now covers Phase 3's user ids as well as Phase 5's activity ids, and the "identical row
sets after any 500" criterion is violated on a route real clients use.

**Route:** `nestjs-reviewer` (it already holds P5-F2).

### 4.3 ⚠️ **N1 unchanged**

`f2-methods.py`, 21 method tokens on `/api/activity/year` as ADMIN, raw socket:

| token | v1 | v2 |
|---|---|---|
| `CONNECT` | 403 Forbidden | **empty — the connection is closed with no reply at all** |
| `FROB`, `BREW` | 403 Forbidden | 400 Bad Request |
| the other 18 (incl. `PROPFIND`, `MKCOL`, `LOCK`, `PURGE`, `SEARCH`, `REPORT`, `QUERY`, `TRACE`, lowercase `get`) | — | identical |

3 of 21 differ, exactly as in round 1. Fail-closed, cross-cutting (llhttp rejects before
Express, so every route), still unregistered. **Route:** `nestjs-reviewer`.

---

## 5. Regression sweep — the delta is contained

### 5.1 Phase 5's six endpoints

| suite | cells | result |
|---|---|---|
| `w1-year-post` (role matrix, P5-D1's 304-still-commits, **the disable target across the gap**, the 201 path, body-never-read) | 5 | **5 PASS** |
| `w2-create-activity` | 7 | 2 PASS, 5 differ |
| `w3-patch` (role matrix, `?patch=` dispatch, **the bare-`except` failure shapes**, P5-D2 value coercion, `?patch=user`) | 6 | **5 PASS**, 1 differ |
| `w4-delete` (**the 13-child cascade**, role matrix, **DELETE on a never-existing id**, routing, **`get_years` 204 on empty**) | 5 | **4 PASS**, 1 differ |
| `w5-ties` | 1 | **PASS** |
| `m1-read` role × method × path | 294 | v1 `{200:48, 401:90, 403:60, 404:96}` **=** v2; 84 differ, all D13; **9/9 controls ok** |
| `m2-sweep` every row | 73 | **0 diffs across 179 047 bytes**, both sides; 5/5 controls ok |

Every differing write cell was classified by its exact differing-field set:

| cell | fields | cause |
|---|---|---|
| `w2` C, E, G · `w3` F · `w4` D | `body`, `bytes`, `headers` only | P3-D6 / D13, registered |
| `w2` D | `body`, `bytes`, `headers`; **sequences identical on both legs** | D13 |
| `w2` F | `act` **plus** body/bytes/headers | **the names now match** (`['a']`, `5`, `True`, `Ñandú 🥸`, `""` on both); only the **ids** differ (v1 28,30,31,33,34,35,36 / v2 28,29,30,31,32,33,34) — pure P5-F2. Round 1's row-*content* diff is gone. |

The TREASURER(2) 403s (writes here are ADMIN+PRESIDENT only), the cascade, the year rollover,
the 204, the 200-on-missing-DELETE and the bare-`except` 404s all still hold.

### 5.2 Phase 3/4 — `d8-loan-sweep.py`, 11 cells, **0 differing**

| cell | v1 → v2 | side effect on v1 |
|---|---|---|
| approve as ADMIN(0) / TREASURER(2) | 200 → 200 | `loandetail` 374 → 375, mail sent on both |
| approve as **PRESIDENT(1)** / MEMBER(3) | **403 → 403** | nothing written — `[0,2]` is a *set*, not a ceiling |
| approve then payout(3) | 200,200 → 200,200 | loan 456 state 0→1→3 |
| refinance only | 200 → 200 | `397=1/458/315` **and** `458=0/-/397` — both directions |
| refinance then APPROVE | 200,200 → 200,200 | previous loan `397` → **state 3** |
| refinance then DENY(2) | 200,200 → 200,200 | previous loan's `refinanced_loan` → **NULL** |
| create within quota / **over quota** | 201 → 201 / **406 → 406** | over-quota wrote no loan (425 unchanged) |
| paymentProjection: ok / bad date / missing key / no detail | **200,400,400,404 → 200,400,400,404** | — |

`d8b-payout.py`: paying out loan **279** removes its **84** `payment_reminder` scheduler rows —
`626 → 542` on **both** stacks, state 1 → 3, row deltas identical, VERDICT PASS.

---

## 6. Anti-false-green

Twenty recorded instances. What this round did, and the two it caught in its own harness.

1. **Every matrix declares positive controls and they are printed per cell.** `d1` 1 (15
   claimed-closed inputs must be identical), `d2` 4, `d3` 4, `d4` 5, `d5` 6, `d6` 8, `d7` 6,
   `d8` 10, `d8b` 5, `m1` 9, `m2` 5 — **63 controls, all passing** except the one described in
   point 4, which was a defect in the control.
2. **Status *distributions*, never a pass count** — `d2` `{201:5, 409:3, 500:11}`, `d4`
   `{200:6, 404:6, 409:5}`, `d6` v1 `{200:3, 404:4, 500:1}`, `m1`
   `{200:48, 401:90, 403:60, 404:96}`. None uniform; instance #4's shape could not hide.
3. **A uniform v2 leg was caught and fixed with a new cell.** `d6` returns **404 on 8 of 8**
   cells, which is compatible with "v2's activate route is simply broken". `d7-activate-happy.py`
   was written for exactly that gap: create → wrong key (404/404) → correct key (**200/200**)
   with the full state transition. Without it, "v2 refuses" would have been unsupported.
4. **A control of mine could only fail, and the fix landed in the probe.** `d8`'s J4 asserted
   "the payout removed `payment_reminder` rows" while paying out loan **456**, which has **zero**
   such rows (`select payload->'owner_id', count(*) … group by 1` → 456 absent; 279 has 84).
   The assertion could never be true — false-green #13's shape in the false-**red** direction,
   just as uninformative as one that always passes. Both stacks agreed, so nothing was hidden,
   but the control measured nothing. Replaced by `d8b-payout.py` against loan 279, where the
   84 rows demonstrably go on both stacks.
5. **A second probe defect, also fixed in the probe.** `wcell.snapshot()` compared raw rows
   including `created_at`, `date_joined`, `password` and `key_activation` — a wall clock and
   three CSPRNG draws. Every cell that *inserts* a row therefore reported `*** DIFFERS ***`,
   **including its own positive control**: `d5`'s refinance cells were 7/7 "differing" when the
   only difference was `created_at`. A real row difference would have been invisible inside that
   noise. `wcell.py` now devolatilises those five columns, **replacing rather than dropping**
   them and distinguishing `<volatile:null>` from `<volatile:present>`, and keeps the raw
   snapshot in `_raw`. `d5` and `d2` were re-run end to end; `diff` of the measured
   status/stored-value columns before and after the fix is **empty** — only the verdict column
   changed.
6. **Every "identical" claim is classified, not asserted.** The `d2` and `w*` diffs were reduced
   to their exact differing-field sets by a script (§3.3, §5.1) so that "P3-D6 only" is a
   measurement, not a judgement.
7. **A documentation claim was checked rather than believed** — the three `python-str.ts` limits.
   All three hold, and probing them surfaced two details the docblock does not state: `-0.0`
   loses its sign, and 2⁵³+1 is *value*-corrupted rather than re-rendered (§3.2).
8. **The stack was distrusted after the outage** and turned out to be degraded — celery, redis
   and both capture stubs were down behind a container that answered HTTP (§1).
9. **`assert_capture_up()` enforced on all 109 write cells** (218 legs); capture counts are
   evidence, not decoration — DELTA-F1's `0/1` mail count is part of the finding.
10. **Restores are always `pg_restore` from the custom-format dump**, before each leg and after;
    the fixture guard compares rows *and* all 19 sequences; the final verification restores into
    a **separate database** and compares per-table row-set hashes.
11. **All 30 harness scripts are mode 755.** `probe/sitecustomize.py` is 644 and correctly so —
    it is imported via `PYTHONPATH`, never executed.

**Claims of identity in this report are backed by these exact commands:**

* *"24/24 tables identical"* — `pg_restore` of
  `p5r-20260906-091658-delta-pre/fondodev-full.dump` into `p5dverify`, then for every table in
  `pg_tables where schemaname='public'`:
  `select coalesce(md5(string_agg(x::text, E'\n' order by x::text)),'EMPTY')||'/'||count(*) from public.<t> x`,
  compared against the same query on `fondodev`.
* *"schema untouched"* — `p5/schema.sh` (`information_schema.columns` + `pg_constraint` with
  `condeferrable`/`condeferred` + `pg_indexes` + `pg_sequences` + `pg_tables` +
  `count(*) from django_migrations`), md5 `e347fcec1b54fd43d74a24e2d9c0d4cf` before, after, and
  in round 1.
* *"fixture restored"* — `diff BASELINE.snap FINAL-delta.snap` on `p5/snap.sh`, which includes
  every sequence's `last_value`, the enabled-year list and `count(distinct xmin::text)`.
* *"0 diffs across 179 047 bytes"* — `p5/m2-sweep.py`, comparing status, full body,
  `size_download` and the header set for all 73 cells.
* *"D38 left nothing behind"* — `select u.id, u.is_active, md5(u.password), p.identification,
  coalesce(p.key_activation,'<NULL>') from auth_user u join fondo_api_userprofile p on
  p.user_ptr_id = u.id order by u.id`, captured before the first D38 cell and re-run after the
  last; string-equal.
* *"v1 raises AttributeError"* — `docker exec … python -c "BaseUserManager.normalize_email(v)"`
  over nine values inside the pinned container, plus the container's own traceback line.

---

## 7. For `nestjs-reviewer`

1. **DELTA-F1** (§4.1) — the third branch of `_create_user`'s guard. Note that `rawEmail` is
   named "raw" while holding a coerced value, and that `as string` is what let it through the
   type checker. Worth checking every other `toDjangoText(...) as string` cast in the delta for
   the same shape: `updateUserPreferences` has two, and `activateUser` has one on the password.
2. **P5-F2 now has a Phase 3 face** (§4.2). Your register-or-fix decision now covers
   `auth_user_id_seq` on `POST /api/user` with a null name and
   `fondo_api_schedulertask_id_seq` on the birthdate patch — routes real clients use, unlike a
   non-scalar activity name. Everything else about those cells is byte-identical.
3. **N1 unchanged** (§4.3). `CONNECT` still gets **no response at all** from v2 on every route.
4. **D38's register entry is missing a sub-case**: `{"key": null, "identification": <valid>}`
   with **no `password` key** is a **v1 500** (`obj['password']` → `KeyError`, after a
   successful lookup, nothing written) and a **v2 404**. Within the accepted divergence, but the
   status pair is 500/404 rather than 200/404 and the entry does not say so.
5. **`python-str.ts`'s limits docblock is accurate but incomplete** (§3.2): L1 also loses the
   sign of `-0.0`, and L2 is a *value* corruption (2⁵³+1 → 2⁵³) rather than only a rendering
   difference. Two sentences, no code change.
6. **v2's `?? 'None'` in `createBirthdateNotification` is unreachable** (§3.4) — the columns are
   `NOT NULL` and v1 rolls the notification back with the failed `save()`. Correct as written;
   the docblock should say it is defensive rather than reachable.
7. **`docs/phase-5-deviations.md` §4.3 still under-declares the cross-cutting rows.** Round 1
   reported this; it is unchanged, and D13 + P3-D6 again account for every non-finding diff in
   this round.

## 8. Not covered

* The C28 Bogotá year boundary at HTTP level (no `faketime`; unchanged from round 1).
* Pagination — none of these routes paginates except `GET /api/user`/`GET /api/loan`, which were
  not re-swept: the delta does not touch their query handling.
* Concurrency / interleaving.
* `GET/POST /api/authorize` and `POST /api/alexa` — excluded by standing instruction.
* The TSV bulk uploads and powers of attorney — Phase 3/4 surfaces the delta does not touch;
  `git diff 662ed48..d7b95f8 -- src/` shows no change under `src/files/`, `src/powers/` or the
  bulk-update paths.

## 9. Artefacts

| path | contents |
|---|---|
| `~/.fondo-parity-harness/p5/` | the whole harness; all 30 `.py` mode 755 |
| `…/d1-limits.py` … `…/d8b-payout.py` | the eight new delta suites |
| `…/wcell.py` | write-cell driver, **with this round's volatile-column fix**; `wcell.py.bak-pre-volatile` is the pre-fix copy |
| `…/out-d*.txt`, `…/out-delta-*.txt` | every captured response and row delta |
| `…/BASELINE.snap`, `…/FINAL-delta.snap`, `…/schema-pre.txt`, `…/schema-delta-post.txt` | fixture and schema evidence |
| `~/.fondo-parity-dumps/p5r-20260906-091658-delta-pre/` | the pre-write dump (btrfs), 24 tables |
