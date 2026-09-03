# Phase 3 parity report — users, finance, powers of attorney, password reset

**Tester:** `manual-tester` (black-box).
**Date:** 2026-09-02.
**v1 (oracle, frozen):** `~/Projects/Fondo-API` @ `5bef585`, Django 2.2.27 / DRF 3.11.2 /
CPython 3.9.25 / gunicorn 19.9.0, `DJANGO_SETTINGS_MODULE=api.settings.production`,
`127.0.0.1:8451` (container `fondo-v1-p3`, repo bind-mounted **read-only**).
**v2 (under test):** `~/Projects/Fondo-API-v2` @ `1a8c37f` (`feat/phase-3-users`), working tree
clean, rebuilt with `npm run build`, `node dist/main.js` on `127.0.0.1:8450`.
**Database:** the shared `fondodev` (`localhost:5432`), Django migration `0019_auto_20220313_1225`.

---

# Verdict: **FAIL**

Not on substance. **Every registered deviation behaves exactly as registered**, and everything
the phase was supposed to make identical *is* identical: the four password-reset pages and the
CSRF failure page byte for byte, all three `Vary` orders, the birthday `SchedulerTask` including
its unordered `user_ids`, the SES activation / power-approval / password-reset payloads, the SQS
`MessageBody`, the TSV bulk update including Python's banker's rounding and the `last_modified`
no-op, `create_user`'s four-table rollback, and the whole D1 authorisation matrix (72 cells).

The failure is **five unregistered behavioural differences**, all at the HTTP edge, two of them
security-adjacent. Per plan §7 ("an unregistered behavioural diff is a parity failure") any one
of them is sufficient.

| # | Unregistered difference | Severity |
|---|---|---|
| **F1** | `UserAppsView`'s caught-exception **500** loses `Allow: POST, OPTIONS` and `Vary: Accept` in v2. `docs/phase-3-deviations.md` §1 P3-D6 explicitly claims v2 "reproduces the other one **exactly**" — it reproduces the *body*, not the headers. | Low |
| **F2** | v2's **302** responses from the password-reset views omit `Content-Type: text/html; charset=utf-8`. v1 sends it (with `Content-Length: 0`). The `APPEND_SLASH` **301** carries it correctly in both, so this is not the general D13 shape. | Low |
| **F3** | **v2 authenticates the four password-reset routes.** A request carrying an invalid or inactive `Authorization: Token …` header gets **401** where v1 serves the page (200 / 403 / 405). These are plain Django views in v1 with no DRF authentication at all. A member with a stale token cannot reach the reset page — exactly when they need it. | **Medium** (availability of the account-recovery path) |
| **F4** | Bare `OPTIONS` on the two **anonymous-allowed** DRF views (`UserActivateView`, `ObtainAuthToken`) → v1 **200 + the browsable-API metadata document**, v2 **405** `{"detail":"Method \"OPTIONS\" not allowed."}`. Pre-existing since Phase 1 (`/api-token-auth`), newly found; `/api/user/activate/<id>` is a Phase 3 route. | Low–medium (contradicts P1-D2) |
| **F5** | **v2 accepts the CSRF token from the request body on `PUT` and `PATCH`**; Django reads `request.POST['csrfmiddlewaretoken']` only when `request.method == 'POST'`. Measured: `PUT /password_reset/` with a body token is **403 in v1** and **302 in v2** — i.e. v2 *ran the view*, which is the branch that sends a reset email. | **Medium** (CSRF token acceptance surface) |

Nothing in the users, finance, powers, scheduler-write or mail core needs to change.

⚠️ **One fixture incident, reported in full in §9. Six historical `fondo_api_schedulertask` rows
were destroyed by a probe of mine and are not recoverable.** Everything else in `fondodev` is
byte-identical to the pre-test baseline.

---

## 1. Method and harness

| Surface | v1 driver | v2 driver | Capture |
|---|---|---|---|
| all HTTP | `curl` → gunicorn `:8451` | `curl` → `node dist/main.js` `:8450` | status line + sorted header set + body, compared after normalising `Date`/`Server`/`Connection`/`Keep-Alive`/`X-Powered-By`/`Content-Length`, the `csrftoken` value, cookie `expires`, `sessionid`, `_password_reset_token` and the `csrfmiddlewaretoken` form value. `Content-Length` is compared separately as a computed byte count. |
| SES | boto3 1.18.28 redirected by a `PYTHONPATH=/probe` `sitecustomize.py` that wraps `boto3.client` and injects `endpoint_url` for `ses`/`sqs` (botocore 1.21.28 predates `AWS_ENDPOINT_URL_*`). **The v1 repo is not modified** — it is bind-mounted read-only; the shim lives in the throwaway container at `/probe`. | `AWS_ENDPOINT_URL_SES` | threading `http.server` on `:4599` (v1) / `:4598` (v2), persisting each request byte for byte, answering valid SES XML and SQS JSON-1.0/query responses, with a `cap-mode` file switch for the failure path |
| SQS | a real `celery -A api worker` against a redis 7 broker started for this run (v1 publishes via `send_notification.delay`) | inline publisher | same capture servers; `MessageBody` extracted and `cmp`-compared |
| DB | `psql` snapshots before/after every write cell | | |

**Settings parity, deliberately.** v2 was run with `ENVIRONMENT=production` / `NODE_ENV=production`,
`DJANGO_SECRET_KEY=parity-test-secret-key`, `ALLOWED_HOST_DOMAIN=localhost` — the same settings
module v1 is running. All three v1 gunicorns on the box (`:8444`, `:8445`, `:8449`) were checked
and are production too. **P3-D7 is therefore not observable in this round**: the `csrftoken`
cookie carries `Secure` on both sides, and every `Secure`/`https` difference below would be real.

**Fixture guard (recorded per C26 / §7).** Authoritative:
`select count(distinct xmin::text) from fondo_api_notificationsubscriptions` = **1** before and
after. Content hashes are recorded *with their queries* in
`scratchpad/p3/snap.sh`; each is `md5(string_agg(l, E'\n' order by l))` over an explicit
column list, so `synchronize_seqscans` cannot rotate them. Baseline / final:

| guard | baseline | final |
|---|---|---|
| `count(distinct xmin::text)` on `notificationsubscriptions` | 1 | **1** |
| `notificationsubscriptions` rows / `max(id)` / hash | 94 / 1468 / `7a6afbcc…` | **identical** |
| `auth_user` hash (id, username, email, password, is_active, last_login) | `eb2217b4…` | **identical** |
| `fondo_api_userprofile` hash | `279ef0f6…` | **identical** |
| `fondo_api_userfinance` hash | `8ec339bd…` | **identical** |
| `fondo_api_userpreference` hash | `94e8bc42…` | **identical** |
| `fondo_api_power` hash (20 rows) | `002cbae3…` | **identical** |
| `django_session` | 20 | **20** |
| `information_schema.columns` hash | `613a748c…` | **identical** |
| `pg_constraint` hash | `6dc19981…` | **identical** |
| `pg_indexes` hash | `fbacaf14…` | **identical** |
| `django_migrations` | 38 | **38** |
| `fondo_api_schedulertask` | 632 / `b0e339f7…` | **626 / `c3bf5409…` — see §9** |

---

## 2. `GET|POST|PATCH /api/user`

### 2.1 `GET /api/user` — verdict **PASS**

| Case | Request | v1 | v2 | DB delta | Result |
|---|---|---|---|---|---|
| ADMIN(0) | `GET /api/user` | 200, full `{list}` | byte-identical | none | PASS |
| PRESIDENT(1) | idem | 200 | identical | none | PASS |
| TREASURER(2) | idem | 200 | identical | none | PASS |
| MEMBER(3) | idem | 200 | identical | none | PASS |
| inactive user's token (id 3) | idem | 401 `{"detail":"User inactive or deleted."}` | identical | none | PASS |
| unauthenticated | idem | 401 `{"detail":"Authentication credentials were not provided."}` | identical | none | PASS |
| `?page=1` | | 200, 10 rows | identical | none | PASS |
| `?page=2` | | 200, 3 rows | identical | none | PASS |
| `?page=3` (past the end) | | **200** `{"list":[],"num_pages":2,"count":13}` | identical | none | PASS |
| `?page=99` | | 200, same empty envelope | identical | none | PASS |
| `?page=999999999999999999999` | | 200, same empty envelope (Python bigint) | identical | none | PASS |
| `?page=0` | | **400** `{"message":"Page number must be greater than 0"}` | identical | none | PASS |
| `?page=-1` | | 400, same body | identical | none | PASS |
| `?page=abc` | | **500** (`int()` raises) | 500 | none | PASS (P3-D6 body) |
| `?page=` (empty) | | 500 | 500 | none | PASS (P3-D6 body) |
| `?page=1.5` | | 500 | 500 | none | PASS (P3-D6 body) |
| `?page=1&page=2` (duplicate) | | 200, page **2** (`QueryDict` last value) | identical | none | PASS |
| `?page=+2` / `?page=%202` | | 200, page 2 | identical | none | PASS |

The three 500s differ only in the registered **P3-D6** shape: v1 renders
`<h1>Server Error (500)</h1>` with `Content-Type: text/html`, `Content-Length: 27`; v2 answers
zero bytes with no `Content-Type`. Headers otherwise identical (`Vary: Origin`,
`X-Frame-Options: SAMEORIGIN`, and **no** `Vary: Accept` on either — v2 correctly reproduces the
fact that Django's 500 handler bypasses DRF's content negotiation).

### 2.2 `POST /api/user` (create) — verdict **PASS**

| Case | v1 | v2 | DB delta | Result |
|---|---|---|---|---|
| PRESIDENT / TREASURER / MEMBER | 403 `{"detail":"You do not have permission to perform this action."}` | identical | none | PASS |
| unauthenticated | 401 | identical | none | PASS |
| ADMIN, valid body | **201**, empty body | identical | 1 row in each of `auth_user`, `fondo_api_userprofile`, `fondo_api_userfinance` (all zeros), `fondo_api_userpreference` (`false`/`#800000`/`#c83737`); `is_active=false`; `username = email`; `password` = Django's unusable form `!`+40 chars; `key_activation` 50 hex chars; **no `authtoken_token` row** | PASS |
| duplicate `identification` | 409 `{"message":"Identification/email already exists"}` | identical | **no rows** in any of the four tables | PASS |
| duplicate `email` (→ duplicate `username`) | 409, same body | identical | no rows | PASS |
| missing `first_name`/`last_name`/`email` | 500 | 500 | no rows | PASS (P3-D6 body) |
| **activation mail fails** (SES → HTTP 500) | **409** `{"message":"Invalid email"}` | identical | **0 rows in all four tables** — verified by count before/after on both stacks | **PASS** |

Row-level diff of the two created users (v1 → id 23, v2 → id 24) is empty except id,
`key_activation`, password salt and `date_joined`. `last_modified` on the finance row is the
Bogotá date on both (rule 5).

SES activation payload, compared parameter by parameter after normalising the id/key/email:
`Destination.ToAddresses.member.1`, `Destination.BccAddresses` (empty), `Message.Subject.Data`
(`[Fondo Montañez] Activación de cuenta`), `Message.Body.Html.Data`, both `Charset`s and
`Source` — **all identical**, including the accented Spanish and the
`http://localhost:3000/activate/<id>/<key>` anchor rendered twice.

⚠️ **Latency, not parity:** on the failure path v1 issued **5** SES attempts (boto3 legacy retry)
and v2 **1** (`maxAttempts: 1`, condition **C22**). Registered; recorded here because it is
visible on the wire.

**Cross-stack credential check (not required, worth knowing):** a user activated by v1
authenticates on v2 and vice versa — `pbkdf2_sha256$150000$…` on both, `POST /api-token-auth`
returns 200 in all four combinations.

### 2.3 `PATCH /api/user` — the TSV bulk finance update — verdict **PASS**

Content-type matrix (**rule 12b**, the developer's correction #1):

| Body | v1 | v2 | Result |
|---|---|---|---|
| `application/json` | **500** (parses to `{}`, `obj['file']` → `KeyError`) | 500 | PASS |
| `application/x-www-form-urlencoded` | **500** | 500 | PASS |
| `multipart/form-data` **without** a `file` part | **500** | 500 | PASS |
| `text/plain` | **415** `{"detail":"Unsupported media type \"text/plain\" in request."}` | identical bytes | PASS |

Role matrix: PRESIDENT 403, MEMBER 403, unauthenticated 401 — identical bodies. ADMIN and
TREASURER allowed.

Semantics, run against three disposable users with `last_modified` pre-set to `2020-01-01`:

| Input line | v1 result row | v2 result row | Result |
|---|---|---|---|
| `999000201\t1000.4\t5000.5\t2000.5\t1500.6` | `c=2000 bc=1000 tq=5000 aq=3499 uq=1501` | identical | PASS — Python **banker's** rounding: `5000.5→5000`, `2000.5→2000`, `1500.6→1501` |
| `999000202\t2500.49\t7500.51\t3000.0\t0` | `c=3000 bc=2500 tq=7501 aq=7501 uq=0` | identical | PASS |
| `999000203\t10\t20\t30\t40` | `c=30 bc=10 tq=20 aq=**-20** uq=40` | identical | PASS — negative `available_quota` is allowed in both |
| `999999999\t…` (unknown identification) | skipped and logged, response still **200** | identical | PASS |
| re-upload of the identical file | `last_modified` **stays `2020-01-01`** | identical | **PASS** |
| a non-numeric field on line 2 | **500**, and line 1 is **rolled back** (`@transaction.atomic`) | identical | PASS |
| a blank line in the middle | 500, whole batch rolled back | identical | PASS |
| CRLF line endings | 200, both lines applied | identical | PASS |
| no trailing newline | 200, single line applied | identical | PASS |
| empty file | 200, nothing written | identical | PASS |

---

## 3. `GET|PATCH|DELETE /api/user/<id>`

### 3.1 `GET` — verdict **PASS**

Byte-identical for ids 1, 3 (inactive), 4, 13, 14, 15, `-1` (→ the caller), and 404 with an empty
body for 999, 0 and `-2`. Key order of `{user, finance, preferences}` and the Spanish
`last_modified` (`12 ago. 2026`) match exactly.

### 3.2 `PATCH` — the **D1** authorisation matrix — verdict **PASS (expected divergence)**

72 cells: 4 actor roles × {self, another member} × 9 bodies. The `personal` bodies **echo the
whole `GET /api/user/<id>` `user` object** — `full_name`, `role_display` and `id` included —
which is the §2.3 trap. Every cell was run against a freshly restored target row on each stack.

| Actor | Target | Body | v1 | v2 | Row changed (v1 / v2) | Classification |
|---|---|---|---|---|---|---|
| ADMIN | self | personal, `first_name` changed | 200 | 200 | yes / yes | PASS |
| ADMIN | self | personal, **exact echo** | 200 | 200 | no / no | PASS — no false 403 |
| ADMIN | self | personal, `role` → 0 (unchanged value) | 200 | 200 | no / no | PASS |
| ADMIN | self | personal, unchanged `role` echoed + name change | 200 | 200 | yes / yes | PASS |
| ADMIN | self | personal, `identification` changed to a taken one | 409 | 409 | no / no | PASS |
| ADMIN | self / other | finance, `total_quota` changed | 200 | 200 | yes / yes | PASS |
| ADMIN | self / other | finance, unchanged echo | 200 | 200 | no / no | PASS — `last_modified` frozen |
| ADMIN | self / other | finance, `{}` | 500 | 500 | no / no | PASS |
| ADMIN | self / other | preferences | 200 | 200 | yes / yes | PASS |
| ADMIN | other | personal, `role` → 0 | 200 | 200 | yes / yes | PASS |
| ADMIN | other | personal, `identification` changed | 200 | 200 | yes / yes | PASS |
| PRESIDENT | self | personal (name) / preferences | 200 | 200 | yes / yes | PASS — self-service kept (Q25a) |
| PRESIDENT | self | personal, `role` changed | 200 | **403** | yes / **no** | **expected — D1** |
| PRESIDENT | self | personal, `identification` changed | 409 | **403** | no / no | **expected — D16** |
| PRESIDENT | self | finance (changed / unchanged / `{}`) | 200 / 200 / 500 | **403 / 403 / 403** | yes / no | **expected — D1** |
| PRESIDENT | other | **every** body incl. preferences | 200 (or 500) | **403** | yes / no | **expected — D1 / P3-D1** |
| TREASURER | self | personal (name) / preferences / finance | 200 | 200 | yes / yes | PASS |
| TREASURER | self | personal, `role` / `identification` changed | 200 / 409 | **403 / 403** | yes / no | **expected — D1 / D16** |
| TREASURER | other | finance (changed / unchanged / `{}`) | 200 / 200 / 500 | 200 / 200 / 500 | same | PASS — treasurer keeps cross-member finance |
| TREASURER | other | personal (any) | 200 | **403** | yes / no | **expected — D1** |
| TREASURER | other | preferences | 200 | **403** | yes / no | **expected — D1** |
| MEMBER | self | personal (name) / preferences | 200 | 200 | yes / yes | PASS |
| MEMBER | self | personal, `role` changed | 200 (**escalates to ADMIN**) | **403** | yes / no | **expected — D1, the escalation being closed** |
| MEMBER | self | personal, `identification` changed | 409 | **403** | no / no | **expected — D16** |
| MEMBER | self | finance, `total_quota` changed | 200 (**sets own quota**) | **403** | yes / no | **expected — D1** |
| MEMBER | other | **every** body | 200 | **403** | yes / no | **expected — D1 / P3-D1** |

Every v2 refusal is DRF's generic `{"detail":"You do not have permission to perform this
action."}` with `Allow: GET, PATCH, DELETE, HEAD, OPTIONS` and `Vary: Accept, Origin` — byte-identical
to a role denial, so it is not a probe.

The four extra properties the brief asked for:

| Property | Probe | v1 | v2 | Result |
|---|---|---|---|---|
| **an undeclared section is ignored, never a 403** | MEMBER on self, `{"type":"personal","personal":{…},"finance":{"total_quota":99999999,…}}` | 200, finance untouched | **200**, finance untouched (`0\|0`) | **PASS** |
| **a declared `finance` write by an unprivileged caller is 403 whether empty, unchanged or absent** | MEMBER, `{"type":"finance"}` (key absent) | 500 (`KeyError`) | **403** | PASS — gate precedes the body read |
| same, ADMIN control | ADMIN, `{"type":"finance"}` | 500 | 500 | PASS |
| **the section gate runs before the row loads** | MEMBER, `PATCH /api/user/99999`, `type` = finance / personal / preferences | **404** | **403** in all three | PASS — ids cannot be enumerated |
| ADMIN control on the same id | ADMIN, `PATCH /api/user/99999`, personal | 404 | **404** | PASS |

Dispatch and error branches:

| Case | v1 | v2 | Result |
|---|---|---|---|
| body with **no `type`** | 500 (`obj['type']` `KeyError`) | 500 | PASS (§5.3 correction confirmed) |
| unrecognised `type` (`"zzz"`) + a `preferences` object | 200, preferences written | identical | PASS — falls through |
| `type: preferences` with **no `preferences` key** | **500** | 500 | PASS (§2.8 asymmetry) |
| `preferences` missing `primary_color` | **404** (bare `except`) | 404 | PASS |
| `primary_color` longer than `varchar(15)` | **404** | 404 | PASS |
| `personal` echo with **`birthdate: null`** | **500**, whole edit rolled back | 500 | PASS — see §8 B1 |
| same body with the `birthdate` key removed | 200 | 200 | PASS |
| `PATCH /api/user/-1` (member, preferences) | **404** | **200**, applied to the caller | **expected — D14** |
| `DELETE /api/user/-1` (ADMIN) | 404 | **404** | PASS — D14's refusal to adopt the sentinel |

**D15 / P3-D2, the shared-email accounts:**

```
PATCH /api/user/13   {"type":"personal","personal":{… ,"first_name":"Juan SebastiánX", …}}
  v1 → 409, no row changed   (user.username = obj['email'] violates auth_user_username_key)
  v2 → 200, first_name changed, username still 'sebastian.montanez'
```

and on a disposable user whose email was changed to a fresh unique value:

```
  v1 → 200, username rotated to the new email  (auth_user.username := email)
  v2 → 200, username unchanged
```

Both expected — **D15** and **P3-D2**.

**D19 (29 Feb) and D20 (soft-deleted member):**

| Probe | v1 | v2 |
|---|---|---|
| set `birthdate = 2000-02-29` on an active member | **500**, `first_name` and `birthdate` both rolled back, no `SchedulerTask` | **200**, birthdate stored as `2000-02-29`, task `run_date = 2026-02-28 05:00:00+00` |
| set a birthdate on a **soft-deleted** member | **500**, birthdate still `NULL`, no task | **200**, birthdate written, task written, and the inactive owner is correctly absent from `user_ids` |

Both expected — **D19** (clamped to 28 Feb, §2.1) and **D20**.

**D11 (duplicate child rows, injected by hand — v2 cannot create one):**

| Probe | v1 | v2 |
|---|---|---|
| second `fondo_api_userfinance` row for the same user, `GET /api/user/<id>` | **404** | **200**, lowest-id row served |
| same, `PATCH` `type: finance` | **500** | **200**, lowest-id row written; the duplicate untouched |
| second `fondo_api_userpreference` row, `GET` / `PATCH` | **404 / 404** | **200 / 200** |

Expected — **D11**, application half.

### 3.3 `DELETE` — verdict **PASS**

| Case | v1 | v2 | DB delta | Result |
|---|---|---|---|---|
| PRESIDENT / TREASURER / MEMBER | 403 | identical | none | PASS |
| ADMIN, existing user | 200, `is_active=false` | identical | soft delete only | PASS |
| ADMIN, already-inactive user | 200 | 200 | idempotent | PASS |
| ADMIN, id 99999 / 0 | 404, empty body | identical | none | PASS |
| ADMIN, id `-1` | **404** | **404** | none | PASS (D14) |

---

## 4. `POST /api/user/<birthdates|power>` — verdict **PASS (expected divergences)**

### 4.1 `birthdates`

Identical for ADMIN / PRESIDENT / TREASURER / MEMBER (200, same JSON array in the same heap
order), 401 for the inactive token and for no token.

### 4.2 `power`, `type: get`

| Case | v1 | v2 | Result |
|---|---|---|---|
| `obj: requested`, page 1 / 2 / 99 | 200 with `{list,num_pages,count}`; page past the end → **empty list, same envelope, 200** | identical bytes | PASS |
| `obj: requestee`, same pages | identical | identical | PASS |
| `obj: "zzz"` | 200 `{"list":[],"num_pages":1,"count":0}` | identical | PASS |
| `page: 0` | **500** (Django `Paginator` `EmptyPage`) | 500 body identical, **headers differ** | **F1** |
| `page` key absent | 500 | 500, headers differ | **F1** |
| `type` key absent | 500 | 500, headers differ | **F1** |
| `type: "GET"` (upper case) | 200 | identical | PASS (`.lower()`) |
| `type: "bogus"` | **200 with a `null` body** | identical | PASS |
| `POST /api/user/other` (unknown app) | 404, empty body | identical | PASS |

### 4.3 `power`, `type: post`

`POST {"type":"post","meeting_date":"2026-11-15","requestee":2}` as ADMIN:

* v1 row `(requester 1, requestee 2, state 0, 2026-11-15)`; v2 row identical bar the id.
* SQS `MessageBody`: **byte-identical, 24 141 bytes**, all 64 of user 2's subscriptions,
  `cmp`-clean, including the CPython `json.dumps` separators and `ensure_ascii` escaping
  (rule 5d) and the Python-repr `keys` decoding.
* Error branches (`requestee` absent, `requestee` 99999, unparseable `meeting_date`): **500** in
  both, bodies identical, headers differ → **F1**.

⚠️ **Operational note, not a parity defect:** v1's `send_notification.delay(...)` needs a Celery
broker. With redis down, `POST /api/user/power` `type: post` is a **500** in v1 and a 200 in v2,
because v2 publishes inline (authorised in Phase 2). A redis 7 container and a real
`celery -A api worker` were started for this run so the comparison measures the code, not the
missing broker.

### 4.4 `power`, `type: patch` — **D2** and **D5**

| Case | v1 | v2 | Side effect |
|---|---|---|---|
| the **requestee** approves (`state: 1`) | 200 | 200 | one SES `SendEmail` on each side |
| the **requestee** rejects (`state: 2`) | 200, **no mail** | 200, no mail | PASS |
| ADMIN (not the requestee) approves | **200 + the fund-wide letter** | **403** `{"detail":"You do not have permission…"}`, row unchanged, **no mail** | **expected — D2** |
| PRESIDENT (not the requestee) approves | 200 + letter | 403, no mail | expected — D2 |
| MEMBER (not the requestee) approves | 200 + letter | 403, no mail | expected — D2 |
| `id` of a non-existent power | **500** | **500** (not 403 — so the refusal still cannot enumerate power ids) | PASS + F1 headers |
| `state` key absent | 500 | 500 | PASS + F1 headers |

**D5, on the wire.** The approval letter's SES payload:

| Parameter | v1 | v2 |
|---|---|---|
| `Destination.ToAddresses.member.1…13` | the 13 active members' addresses | *(absent)* |
| `Destination.BccAddresses` | *(empty)* | *(empty marker)* |
| `Destination.BccAddresses.member.1…13` | *(absent)* | **the same 13 addresses, in the same order, member for member** |
| `Message.Subject.Data` | `[Fondo Montañez] Poder asamblea` | identical |
| `Message.Body.Html.Data` | 613 bytes | **identical, byte for byte** |
| `Message.Body.Html.Charset` / `Message.Subject.Charset` / `Source` | | identical |

Recipient list unchanged (Q10), disclosure fixed — exactly **D5**. The `meeting_date` renders
through Babel's `es` locale identically inside the body.

---

## 5. `POST /api/user/activate/<id>` — verdict **PASS**

Unauthenticated (`permission_classes = []`) on both.

| Case | v1 | v2 |
|---|---|---|
| wrong `key` | 404 | 404 |
| `key` absent | 404 | 404 |
| `key: ""` | 404 | 404 |
| wrong `identification` | 404 | 404 |
| `identification` absent | 404 | 404 |
| correct triple | **200**; `is_active=true`, `key_activation` NULL, `password` = `pbkdf2_sha256$150000$…` | identical |
| the resulting credential | authenticates on **both** stacks | — |
| `OPTIONS` (bare) | **200 + DRF metadata document** | **405** | → **F4** |

§2.9 (no password validation at activation, `set_password(None)` yields an unusable password) was
not re-derived here beyond the successful path; the validators *are* pinned on the reset path
(§6.4).

---

## 6. Password reset

### 6.1 The five static surfaces — verdict **PASS, byte-identical**

`GET /password_reset/`, `GET /password_reset/done/`, `GET /reset/done/`,
`GET /reset/<uid>/<invalid token>/`, `GET /reset/<uid>/set-password/` — status line, header set
and body identical after normalising only the `csrftoken` value and the form's
`csrfmiddlewaretoken`. The CSRF failure page is identical too, **1386 bytes**,
`Content-Type: text/html` with **no charset**, and `never_cache` emits
`max-age=0, no-cache, no-store, must-revalidate` with **no `private`** on both (developer
correction #5 re-verified).

`Vary`, all five routes:

| route | v1 | v2 |
|---|---|---|
| `GET /password_reset/` | `Cookie, Origin` | `Cookie, Origin` |
| `GET /password_reset/done/` | `Origin` | `Origin` |
| `GET /reset/done/` | `Origin` | `Origin` |
| `GET /reset/<uid>/<invalid>/` | `Origin` | `Origin` |
| `GET /reset/<uid>/set-password/` | `Origin, Cookie` | `Origin, Cookie` |
| `GET /reset/<uid>/<valid>/` (302) | `Origin, Cookie` | `Origin, Cookie` |

### 6.2 CSRF ordering — verdict **PASS**, with **F5**

| Case | v1 | v2 | Result |
|---|---|---|---|
| `DELETE /password_reset/`, **no** cookie | **403** (CSRF page) | identical bytes | PASS (correction #3) |
| `POST /password_reset/`, no cookie | 403, same page | identical | PASS |
| `DELETE /password_reset/` with a valid token **in the `X-CSRFToken` header** | **405** | 405 | PASS |
| `PATCH /password_reset/` with header token | 405 | 405 | PASS |
| `PUT /password_reset/` with header token | **302** (`ProcessFormView.put = post`) | 302 | PASS |
| `POST|PUT|DELETE|PATCH /reset/<uid>/<invalid>/`, no token | 403 | 403 | PASS |
| the same four **with a header token** | **200**, invalid-link page | 200, identical | PASS (correction #4) |
| `DELETE /reset/<uid>/set-password/` with header token | 200, invalid-link page | 200 | PASS |
| **`PUT` with the token in the request body only** | **403** | **302** | **F5** |
| **`PATCH` with the token in the request body only** | **403** | **405** (i.e. it passed CSRF) | **F5** |
| `DELETE` with the token in the body only | 403 | 403 | PASS |
| `POST` with the token in the body only | 200 / 302 | identical | PASS |

### 6.3 `POST /password_reset/` — verdict **PASS**

| `email` | v1 | v2 | Mail |
|---|---|---|---|
| a real member's address | 302 → `/password_reset/done/` | identical | 1 SES send each, payload identical |
| unknown address | 302 | 302 | **0** on both |
| empty | 302 | 302 | 0 / 0 |
| `notanemail` | 302 | 302 | 0 / 0 |
| upper-cased address | 302 | 302 | **0 / 0** (case-sensitive lookup on both) |
| an **inactive** member (`is_active = false`) | 302 | 302 | **1 / 1** — both still send |
| **a JSON body** `{"email": …}` with a valid CSRF header | **302** | **302** | **0 / 0** — v1's `PasswordResetForm(request.POST)` never sees it (correction #2) |
| `Host: evil.test` | **400** (ALLOWED_HOSTS) | **400** | 0 / 0 — reset-link poisoning closed on both (C19) |

The emailed body is byte-identical after normalising host/uid/token, including the Spanish copy
and the `https://…` scheme (production settings on both).

**D17 — the shared addresses:**

| address | v1 | v2 |
|---|---|---|
| `criss9413@hotmail.com` (ids 7 and 14) | 302 and **no mail at all** | 302 + mail whose `uid` decodes to **7**, `To: criss9413@hotmail.com` |
| `mhjc123@hotmail.com` (ids 10 and 13) | 302 and **no mail at all** | 302 + mail whose `uid` decodes to **10** |

Exactly the registered decision (Q27 / D17): the parent account, not the child.

### 6.4 The confirm hop end to end — verdict **PASS (expected divergence P3-D3)**

| Step | v1 | v2 |
|---|---|---|
| `GET /reset/<uid>/<valid token>/` | **302** → `/reset/<uid>/set-password/` | **302** → same |
| `Vary` on that 302 | `Origin, Cookie` | `Origin, Cookie` |
| cookie set | `sessionid=…; HttpOnly; Max-Age=1209600; Path=/; SameSite=Lax; Secure` | `_password_reset_token=<token>; HttpOnly; Max-Age=259200; Path=/reset/; SameSite=Lax; Secure` |
| `django_session` rows | **20 → 21** | **21 → 21 (no write)** |
| `GET /reset/<uid>/set-password/` | 200, form, `csrftoken` set, `Vary: Origin, Cookie` | identical |
| `POST` the new password | 302 → `/reset/done/` | 302 → `/reset/done/`, plus `_password_reset_token=""; Max-Age=0` clearing the cookie |
| replaying the original link afterwards | **200**, invalid-link page | identical |
| the link **without** the cookie, straight to `/set-password/` | invalid-link page | invalid-link page |

All expected under **P3-D3**. The token is not replayable on either stack, and the cookie is
tighter in v2 (`Path=/reset/`, 3-day max-age vs 14). Links are **not** interchangeable between
the stacks (**P3-D4**) — each was issued and consumed within one stack.

⚠️ Every 302 in this table is where **F2** shows: v1 carries
`Content-Type: text/html; charset=utf-8`, v2 carries none.

Password validators on the confirm form (**§2.10**), same link, same order:

| new password | v1 | v2 |
|---|---|---|
| `12345678` | 200 + `<li>This password is entirely numeric.</li>` | identical |
| the account's own username | 200 + `<li>The password is too similar to the username.</li>` | identical |
| `tgttp` (an **anagram** of part of the username) | 200 + *too similar* — `quick_ratio`, not `ratio` | identical |
| `999000205` (the identification) | 200 + *entirely numeric* | identical |
| `zz` (2 characters) | **302 — accepted** | identical |
| mismatched `new_password1`/`new_password2` | 200, form redisplayed | identical |

---

## 7. Regression surface carried from Phase 2

| Check | Result |
|---|---|
| **In-scope URL sweep** — 33 path shapes (slashed/unslashed, `-1`, `-power`, `POWER`, `power2`, `/api/user/5/`, `/API/user`, `/api/USER`, `/api/user/%2Dpower`, `/api%2Duser`, `/nope/nope`, `/health`) × `GET POST PATCH DELETE OPTIONS PUT HEAD` | **matching**, apart from `/health` (a registered v2-only route) and the two **F4** `OPTIONS` cells |
| Later-phase routes (`/api/loan…`, `/api/activity…`, `/api/file…`, `/api/admin`, `/api/saving-account`, `/api/alexa`, `/api/authorize`) | 404 in v2, served in v1 — **expected, not yet implemented**; fail-closed direction confirmed (v2 never serves a path v1 does not) |
| `ALLOWED_HOSTS`: `Host: evil.test` on `/api/user`, `/password_reset/`, `/nope/nope`, `/health`, `/api-token-auth` | **400 on both**, every path (C19) |
| Reset-link poisoning via `Host` | 400 on both, no mail on either |
| Bare `OPTIONS` vs genuine preflight on `/api/notification/subscribe`, `/api/user`, `/api/user/power`, `/password_reset/`, `/nope/nope` | bare 401/401, 401/401, 401/401, 200/200, 404/404; preflight 200/200 on all five — **identical** (C14) |
| `OPTIONS` on a guarded view for an allowed caller | 403 on both (`list_permissions` has no `OPTIONS` key — v1's deny-on-lookup-miss, reproduced) |
| `POST /password_reset` (no slash) → `APPEND_SLASH` 301 | identical, `Location: /password_reset/`, `Content-Type: text/html; charset=utf-8`, `Content-Length: 0` on both |
| **Notification role matrix** — subscribe/unsubscribe × ADMIN/PRESIDENT/TREASURER/MEMBER (live and freshly created), plus inactive token / no token / bad token | **0 mismatches**, 94-row fixture unchanged (`xmin` distinct = 1) |
| `HEAD` on `/api/user`, `/api/user/<id>`, `/password_reset/` | identical |

---

## 8. Findings in full

### F1 — `UserAppsView`'s handled 500 loses `Allow` and `Vary: Accept` — **unregistered**

`views/user.py:88` catches every exception and returns a **DRF** `Response(status=500)`, which
goes through `finalize_response` and therefore carries the view's `Allow` header and DRF's
content-negotiation `Vary`. v2 answers a bare 500.

```
POST /api/user/power   Authorization: Token <ADMIN>   Content-Type: application/json
{"type":"get","obj":"requested","page":0}

v1                                     v2
HTTP/1.1 500 Internal Server Error     HTTP/1.1 500 Internal Server Error
Vary: Accept, Origin                   Vary: Origin
Allow: POST, OPTIONS                   (absent)
X-Frame-Options: SAMEORIGIN            X-Frame-Options: SAMEORIGIN
Content-Length: 0                      Content-Length: 0
```

Reproduced by every input that reaches that `except`: `page: 0`, a missing `page`, a missing
`type`, a missing/unknown `requestee`, an unparseable `meeting_date`, a non-existent power `id`,
a missing `state`. `docs/phase-3-deviations.md` §1 P3-D6 asserts the opposite ("v2 reproduces
the other one exactly"), so this is a documented claim that the running system does not meet.
No DB delta on either side.

### F2 — v2's password-reset **302**s omit `Content-Type` — **unregistered**

```
POST /password_reset/  (form body, valid CSRF, email=nobody@nowhere.test)

v1                                        v2
HTTP/1.1 302 Found                        HTTP/1.1 302 Found
Content-Type: text/html; charset=utf-8    (absent)
Location: /password_reset/done/           Location: /password_reset/done/
Vary: Origin                              Vary: Origin
X-Frame-Options: SAMEORIGIN               X-Frame-Options: SAMEORIGIN
Content-Length: 0                         Content-Length: 0
```

Same on `GET /reset/<uid>/<valid token>/` and on the successful `POST …/set-password/`. The
`APPEND_SLASH` **301** does carry it in v2, so this is not the general HTML-vs-JSON shape D13
covers — it is specific to these three redirects.

### F3 — v2 authenticates the password-reset routes — **unregistered**, medium

```
GET /password_reset/    Authorization: Token deadbeef

v1                                                     v2
HTTP/1.1 200 OK                                        HTTP/1.1 401 Unauthorized
Content-Type: text/html; charset=utf-8                 Content-Type: application/json
Set-Cookie: csrftoken=…                                WWW-Authenticate: Token
Vary: Cookie, Origin                                   Vary: Origin
<the reset password form>                          {"detail":"Invalid token."}
```

24 cells diverge: `{GET, OPTIONS, PUT}` × `{/password_reset/, /password_reset/done/,
/reset/done/, /reset/<uid>/<token>/}` × `{invalid token, inactive user's token}`. With **no**
`Authorization` header, or with a **valid** token, the two agree. In v1 these are plain Django
views with no DRF authentication in the stack at all.

Why it matters beyond the status code: the member most likely to send a stale
`Authorization` header is the member whose session broke — and the page they are locked out of
is the password-reset page.

### F4 — `OPTIONS` on the anonymous-allowed DRF views — **unregistered**, pre-existing

```
OPTIONS /api/user/activate/29      (and OPTIONS /api-token-auth)

v1  200, Content-Length 172
    {"name":"User Activate","description":"","renders":["application/json","text/html"],
     "parses":["application/json","application/x-www-form-urlencoded","multipart/form-data"]}
v2  405, Content-Length 44
    {"detail":"Method \"OPTIONS\" not allowed."}
```

`Allow: POST, OPTIONS` and `Vary: Accept, Origin` are present on both, so only the status and the
body differ. This is the positive half of **P1-D2**, which v2 has never implemented: on a
*guarded* view v1 refuses `OPTIONS` (no `OPTIONS` key in `list_permissions`) and v2 matches, but
on the two views that permit anonymous access DRF actually serves the metadata document.
`/api-token-auth` is a Phase 1 route, so this predates Phase 3; `/api/user/activate/<id>` is new
this phase.

### F5 — v2 accepts a CSRF token from the body on `PUT`/`PATCH` — **unregistered**, medium

Django 2.2 `CsrfViewMiddleware.process_view` reads `request.POST['csrfmiddlewaretoken']` only
`if request.method == "POST"`, and `HttpRequest._load_post_and_files` populates `request.POST`
only for `POST`. So on any other unsafe method the token must arrive in `X-CSRFToken`.

```
PUT /password_reset/
Cookie: csrftoken=<T>
Content-Type: application/x-www-form-urlencoded
csrfmiddlewaretoken=<T>

v1 → 403 (CSRF failure page)
v2 → 302 Found, Location: /password_reset/done/       ← the view ran
```

`PATCH /password_reset/` behaves the same (403 in v1, 405 in v2 — a 405 means CSRF *passed*), as
does `PUT|PATCH /reset/<uid>/<token>/` (403 vs 200). `DELETE` agrees (403 both), which locates
the cause in v2's body parsing rather than in a deliberate rule.

Practical exploitability is limited — the token must still match the cookie, and a cross-origin
HTML form cannot issue `PUT`/`PATCH` — but the accepted-credential surface is wider than v1's,
on the one route family that sends account-recovery mail.

---

## 9. ⚠️ Fixture incident — six `fondo_api_schedulertask` rows lost

**What happened.** The **D15 / P3-D2** probe (`PATCH /api/user/13`, §3.2) is a *personal* update
carrying a `birthdate`, so it runs `__create_birthdate_notification`, whose first step is
`remove_sch_notitfications("birthdate", 13)` — an unconditional
`SchedulerTask.objects.filter(payload__owner_id=13, payload__type='birthdate').delete()`. In v1
the surrounding transaction rolls back on the 409, so nothing was lost there. **In v2 the PATCH
succeeds (that is the point of D15), so the delete committed**: user 13's seven historical
birthday tasks (2020–2026, mostly `processed = true`) were replaced by one new row.

I did not anticipate that a *read-shaped* authorisation probe on a live row would be destructive.
The right procedure was to run every write probe against rows I created; I did that everywhere
else, and made an exception for users 13/14 because §4.4 of the deviations doc asks for exactly
that probe.

**Recovery attempted.** `pageinspect` found only 8 dead tuples on the last heap page and all 8
were rows I had created; user 13's were among the 66 already-pruned line pointers
(`n_dead_tup = 74`, `t_data IS NULL`). No dump, no second copy of the database, no accessible WAL.
**The six rows are not recoverable.**

**What was restored.** The one surviving row carried the probe's mutated `first_name`
("Juan SebastiánX") and a `user_ids` list containing my since-deleted test users. I regenerated it
by re-issuing the same PATCH with user 13's **correct** stored values, so the row now reads
exactly what either stack would write today:

```
2528 | 0 | 2026-10-07 05:00:00+00 | 4 | f |
  "type"=>"birthdate", "target"=>"/",
  "message"=>"Hoy está cumpliendo años Juan Sebastián Montañez Carrasquilla",
  "owner_id"=>"13", "user_ids"=>"[1, 12, 5, 11, 2, 7, 14, 4, 8, 10, 6, 9]"
```

I deliberately did **not** fabricate the six lost rows. Their `processed` flags and per-year
`user_ids` heap orders are not derivable, and inventing them would corrupt the fixture more
subtly than a known, documented gap.

**Net state of the fixture.**

| | baseline | now |
|---|---|---|
| `fondo_api_schedulertask` | 632 | **626** |
| `payload->'type' = 'birthdate'` | 92 | **86** |
| owner 13's birthdate rows | 7 | **1** (regenerated, correct) |
| every other owner (1,2,4,5,6,7,8,9,10,11,12,15) | 7 / 7 / 7 / 8 / 7 / 8 / 7 / 7 / 8 / 7 / 7 / 4 | **unchanged** |
| `payload->'type' = 'payment_reminder'` | 540 | **540, unchanged** |
| **every other table** (`auth_user`, `userprofile`, `userfinance`, `userpreference`, `power`, `notificationsubscriptions`, `authtoken_token`, `django_session`, `django_migrations`, schema/constraints/indexes) | — | **byte-identical, all guards match** |

New authoritative guard for the scheduler table, query recorded in `snap.sh`:
`md5(string_agg(id||'|'||type||'|'||run_date||'|'||repeat||'|'||processed||'|'||payload::text, E'\n' order by …))`
= **`c3bf5409c51409386c3fa887bfd3bb72`** (was `b0e339f74d3faf0496f59e1b06a79b94`).

Sequences advanced and were not reset (they never are): `auth_user_id_seq` 16 → 29,
`fondo_api_schedulertask_id_seq` 2459 → 2528.

**Method note for whoever tests Phase 4 and later.** `remove_sch_notitfications` is called by
`__create_birthdate_notification` *before* anything is validated, and Phase 4's loan flows call
the same notification service. **Treat any successful write against a live row as capable of
deleting unrelated scheduler history.** Take `pg_dump -t fondo_api_schedulertask` before the
first write cell; it is cheap and it would have made this a non-event.

---

## 10. Business-rule observations (for `business-analyst`, not migration defects)

**B1 — a brand-new member cannot save their profile.** `create_user` leaves `birthdate` NULL.
`GET /api/user/<id>` therefore returns `"birthdate": null`, and v1's client echoes the whole
object back on the next save. `__update_user_personal` does `if 'birthdate' in obj:` — a *presence*
test that a JSON `null` satisfies — then `datetime.strptime(None, '%Y-%m-%d')`, which raises
`TypeError`. **500 in v1 and 500 in v2**, with the whole edit rolled back, on the very first save
of every member ever created through the API. Removing the `birthdate` key succeeds. This is a v1
defect faithfully ported (correctly, per the parity contract) but it is the kind of thing that
looks like a v2 regression the first time an operator sees it after cutover. Worth a decision:
port-and-fix, or leave and document.

**B2 — soft-deleted members still receive password-reset mail.** `get_user_by_email` does not
filter on `is_active`, so ids 3 and 15 get a working reset link on both stacks — and then cannot
log in, because token auth rejects inactive users with `User inactive or deleted.` Same behaviour
both sides, so it is not a parity issue; it is a dead-end recovery path for two live accounts.

**B3 — D5's empty `To:`, confirmed on the wire.** The developer's §2.6 asks for one operator
confirmation before the first real approval after cutover. The captured payload has
`Destination.ToAddresses` empty and 13 addresses in `BccAddresses`. Confirming: a message with no
`To:` header is what SES will be asked to send.

**B4 — `POST /api/user/power` `type: post` is coupled to the Celery broker in v1.** With redis
down the endpoint is a 500 (the `.delay()` raises and `UserAppsView`'s `except` catches it), so
today a broker outage silently blocks power requests. v2 publishes inline and returns 200 with
the notification lost on failure. Both were already-accepted design points (Q6, Phase 2 §3
condition 1); recording it because it is the one place where the collapsed queue hop changes an
availability property.

---

## 11. What I could not test, and why

| Area | Why |
|---|---|
| `SchedulerTask` **execution** (does the 2026-02-28 leap-day row actually fire, does the yearly clone land on 28 Feb) | Phase **7b**. Phase 7a only writes rows; this report validates them by comparison against `fondodev` row 2458's shape and against v1's own output, as C24 specifies. |
| Loans, activities, saving accounts, files, admin, Alexa, `/api/authorize` | later phases (and two are explicitly out of scope). All 404 in v2 today; the sweep confirms the fail-closed direction. |
| Real SES / SQS / a real browser | captured locally; the SES query protocol and the SQS `MessageBody` are compared exactly, but neither AWS's own validation nor a real service worker was exercised. |
| A *naturally occurring* duplicate `UserFinance` / `UserPreference` (D11) | v2 cannot create one — `create_user` is the only writer and it is transactional — so the duplicate was injected with SQL on a disposable user and removed afterwards. The physical `UNIQUE (user_id)` is deferred to Phase 9 (§5.4) and was **not** applied; verified absent in the `pg_constraint` hash, which is unchanged. |
| Concurrency (two simultaneous `create_user`s, a PATCH racing a TSV upload) | single-threaded harness; v1 and v2 also have different worker models (gunicorn `-w 2` vs one Node process), so a race comparison would measure the harness. |
| `activate_user` with `"password": null` (§2.9) | not run — it produces an account nobody can log into, and I had no disposable user left at that point in the run. Both implementations were read; neither validates. Low risk, but it is a gap. |
| The 29 Feb case against a **member the fund actually has** | none exists (0 of 15, as D19 records); exercised on a user I created, as the brief asked. |

---

## 12. Verdict by endpoint

| Endpoint | Verdict |
|---|---|
| `GET /api/user` | **PASS** — bodies, pagination envelope, both 400s and all three 500s identical. |
| `POST /api/user` | **PASS** — identical rows across all four tables, identical 409s, and the mail-failure rollback leaves **zero** rows on both. |
| `PATCH /api/user` (TSV) | **PASS** — identical finance rows, banker's rounding, `last_modified` no-op, atomic rollback, and the 500/500/500/415 content-type matrix (rule 12b). |
| `GET /api/user/<id>` | **PASS** — byte-identical including `-1`, inactive users and the shared-email accounts. |
| `PATCH /api/user/<id>` | **PASS with the expected D1/D14/D15/D16/D19/D20/P3-D1/P3-D2 divergences** — 72-cell matrix matches the D1 table exactly; no false 403 on a whole-object echo; undeclared sections ignored; the gate precedes the row load. |
| `DELETE /api/user/<id>` | **PASS** — role matrix, soft delete, idempotence and D14's `-1` refusal all identical. |
| `POST /api/user/birthdates` | **PASS** — byte-identical for every role. |
| `POST /api/user/power` | **FAIL (F1 only)** — every body, row and payload identical, D2 and D5 exactly as registered, SQS `MessageBody` `cmp`-clean; the caught-exception 500 loses two headers. |
| `POST /api/user/activate/<id>` | **FAIL (F4 only)** — all seven functional branches identical; bare `OPTIONS` is 200+metadata in v1 and 405 in v2. |
| `GET|POST /password_reset/` | **FAIL (F2, F3, F5)** — pages, mail, D17 and the JSON-body no-op all correct; the 302 loses `Content-Type`, an invalid `Authorization` header 401s, and a body-borne CSRF token is accepted on `PUT`/`PATCH`. |
| `GET /password_reset/done/`, `GET /reset/done/` | **FAIL (F3 only)** — byte-identical without an `Authorization` header. |
| `GET|POST /reset/<uid>/<token>/` and `…/set-password/` | **FAIL (F2, F3, F5)** — the hop, the invalid-link page, the validators and the non-replayability are all identical; P3-D3 (no `django_session`, no `sessionid`) confirmed. |
| Phase 7a `SchedulerTask` write | **PASS** — `type`, `run_date` (`05:00Z`), `repeat`, `processed` and `payload::text` **byte-identical**, `user_ids` in the same unsorted heap order, `remove`-then-`create` and the same-day dedupe both matching. |

**Phase verdict: FAIL.** Return F1–F5 to `nestjs-developer`; B1–B4 to `business-analyst`. Nothing
in the service, repository, mail or scheduler layers is implicated — all five findings are in the
HTTP edge (response-header construction, the guard's reach over unguarded routes, the `OPTIONS`
metadata path, and the CSRF token source).

---

## 13. System health

| Check | Result |
|---|---|
| v1 boots | ✅ gunicorn 19.9.0, 2 workers, `api.settings.production`, `fondodev`; no errors in `/tmp/err8451.log` beyond the deliberate 500s |
| v2 boots | ✅ `node dist/main.js`, all Phase 0–3 routes mapped, Prisma connected, `production` |
| migrations | ✅ `django_migrations` 38 rows, `_prisma_migrations` `0_init` still `applied_steps_count = 0`; **v2 ran no migration** |
| schema untouched | ✅ `information_schema.columns`, `pg_constraint` and `pg_indexes` hashes identical before and after |
| stray writes | ✅ none. Every row v2 wrote was one a request asked for; the only unexpected delete is §9, and it was v1's own `remove_sch_notitfications` logic doing exactly what `services/user.py:281` says |
| worker / scheduler | ✅ the Celery worker consumed every queued `send_notification` and published to the capture server; v2 has no scheduler running yet (Phase 7b) |
| SES / SQS | ✅ 100 % of sends captured locally; **no traffic left the host** (`endpoint_url` shim on v1, `AWS_ENDPOINT_URL_*` on v2) |
| v1 repo | ✅ untouched — bind-mounted read-only; the boto3 shim lives at `/probe/sitecustomize.py` inside the throwaway container |
| test rows | ✅ 7 users (ids 23–29), their profiles/finance/preferences/tokens, 2 power rows and 16 subscriptions created and **all deleted**; `django_session` restored to 20 |

---
---

# Round 2 — re-test of the F1–F5 fixes

**Tester:** `manual-tester` (black-box). **Date:** 2026-09-02 (round 2, same day).
**v1 (oracle, frozen):** `~/Projects/Fondo-API` @ `5bef585`, container `fondo-v1-p3`
(gunicorn `0.0.0.0:8444`, reached on the loopback proxy `127.0.0.1:8451`),
`api.settings.production`, database `fondodev`.
**v2 (under test):** `~/Projects/Fondo-API-v2` @ `1344b48` (`feat/phase-3-users`), working tree
**clean**, `dist/` **reproduced** (`npm run build` re-emitted byte-identical output —
`md5(md5sum of every dist *.js/*.html/*.json) = b7d2f372…` before and after), restarted as
`node dist/main.js` on `127.0.0.1:8450` with `ENVIRONMENT=production` / `NODE_ENV=production`.
**Database:** the shared `fondodev`.

## Verdict: **FAIL** — but every one of F1–F5 is **fixed** and nothing regressed.
The failure is two *pre-existing, unregistered* differences found this round: **F6** (v1's
`406` content negotiation, which P3-D8 does not cover) and **F8** (malformed `multipart/form-data`
on the other side of the 400/500 line). Both are candidates for **registration** rather than code
changes. Full reasoning in R2.14.

### R2 harness note — the ports moved, the oracle did not

The host restarted overnight and took `/tmp` (and therefore the round-1 harness, the capture
servers and the loopback proxies) with it. Rebuilt from scratch:

* **v1** is the same container `fondo-v1-p3`, same image, same read-only bind-mount of
  `~/Projects/Fondo-API` @ `5bef585`, `api.settings.production`, `fondodev`. Its own entrypoint
  gunicorn listens on `:8444` **without** the boto3 capture shim; the oracle used for every cell
  below is a second gunicorn `docker exec`-ed into the same container with
  `PYTHONPATH=/probe PARITY_AWS_ENDPOINT=http://127.0.0.1:4599`, bound to `127.0.0.1:8451` —
  which is what `:8451` was in round 1. Confirmed serving `fondodev` (the fixture admin token
  authenticates; `fondo_api_test` has 0 rows in `auth_user`).
* `/creds/gcp.json` had to be regenerated (it lived in the wiped scratchpad). `fondo_api/views/file.py`
  builds a `storage.Client()` at **import** time, so Django will not boot without a loadable
  credentials file. It is an `authorized_user`-shaped throwaway with placeholder values, never used:
  no Phase 3 route touches GCS. **The v1 repo is still untouched** — the mount is `ro`.
* **v2** `1344b48`, tree clean apart from this report. `npm run build` re-emitted `dist/`
  **byte-identical** (`b7d2f3721960c404f6ac221e4de1ab4c` before and after), so the running binary
  is the reviewed source.
* SES/SQS capture servers back on `:4599` (v1) / `:4598` (v2); redis 7 + `celery -A api worker`
  back for v1's `send_notification.delay`.

**⚠️ Data-safety note.** The round-2 `pg_dump` taken under §7 *was itself in `/tmp` and was lost
in the restart.* Retaken before the first write cell of this round, to a location that survives a
reboot: `~/.fondo-parity-dumps/r2/` (per-table `--column-inserts` + a full dump). Both are
byte-for-byte the same size as the pre-restart pair, and every `snap.sh` guard hash below equals
round 1's closing value, so nothing changed while the box was down. **§7 should say the dump must
not live on a tmpfs** — that is a second way to lose the fixture, and it nearly cost this round
its baseline.

Baseline = round 1's closing state, re-verified: `schedulertask` **626** / `c3bf5409…`,
`notificationsubscriptions` **94 / 1468 / xmin-distinct 1** / `7a6afbcc…`, `auth_user` **15** /
`eb2217b4…`, `power` **20** / `002cbae3…`, `loan` **425**, `django_session` **20**,
schema/constraint/index hashes `613a748c…` / `6dc19981…` / `fbacaf14…`.

---

## R2.1 — F1: the caught 500 keeps `Allow` and `Vary: Accept` — **FIXED**

The fix moved the strip from "is it a 500" to "did Django throw this response away", which is the
right axis. Probed **both** directions, 22 cells, comparing the full
`HTTP/`+`Allow`+`Vary`+`Content-Type`+`Content-Length`+`X-Frame-Options` set.

| Direction | Cases | v1 | v2 | Verdict |
|---|---|---|---|---|
| **Caught** — `UserAppsView.post`'s `except: return Response(status=500)` | 9 bodies: `page:0`, missing `page`, missing `type`, `patch` of a nonexistent id, `obj:"nonsense"`, `type:"nonsense"`, `{}`, `page:-1`, `page:"x"` | `500` + `Allow: POST, OPTIONS` + `Vary: Accept, Origin` (7 of them; 2 are 200s) | **identical, all 9** | **PASS** |
| **Uncaught** — `convert_exception_to_response` builds a fresh `HttpResponse` | `GET /api/user?page=abc`, `?page=`, `?page=1.5`, `POST /api/notification/subscribe` (no body), `PATCH /api/user` (no CT / JSON CT), `POST /api/user` bad body | `500`, **no** `Allow`, `Vary: Origin` only, `X-Frame-Options: SAMEORIGIN` | **same status and same header set**, all 7 | **PASS** |
| Controls that must keep both headers | 401 (no creds), 401 (bad token), 403, 400, 200, 400 on `/api/notification/subscribe` | — | identical, 6/6 | **PASS** |

Residual on the uncaught rows is the **body only** — v1 sends Django's 27-byte
`<h1>Server Error (500)</h1>` with `Content-Type: text/html`, v2 sends zero bytes and no
`Content-Type`. That is **D13**, registered, unchanged from round 1, and it is now the *sole*
difference on that path.

**P3-D6's narrowed scope is accurate**: `Allow`/`Vary: Accept` survive on the DRF-returned 500 and
are absent on the uncaught one, on both sides, on every input I could find.

---

## R2.2 — F5: the CSRF token comes from the body on `POST` only — **FIXED**

44 cells. Every one matches, **including the four that discriminate between a correct fix and a
fix that merely reorders the two sources**. This is the part round 1 got wrong, so it is worth
being explicit about which cell rules out which wrong implementation.

| Cell | Request | v1 | v2 | Rules out |
|---|---|---|---|---|
| `POST-badbody-goodhdr` | `POST`, `csrfmiddlewaretoken=zzz…` (32×`z`) in the form body **and** a valid `X-CSRFToken` | **403**, 1019-byte page | **403**, byte-identical page | *"read the header first, fall back to the body"* — that implementation returns **302** here. `django/middleware/csrf.py:299` only falls back when the body token is the **empty string**, not when it is wrong. |
| `POST-emptybody-goodhdr` | `POST`, `csrfmiddlewaretoken=` (empty) + valid `X-CSRFToken` | **302** | **302** | *"body wins unconditionally on POST"* — that returns 403. The `if request_csrf_token == "":` fallback must fire. |
| `PUT-badbody-goodhdr` | `PUT`, bad body token + valid `X-CSRFToken` | **302** (the view runs) | **302** | *"the body is read on every unsafe method"* — round 1's actual defect. A bad body token must be **invisible** on `PUT`. |
| `POST-goodbody-badhdr` | `POST`, valid body token + garbage `X-CSRFToken` | **302** | **302** | confirms the body genuinely wins on `POST`. |

⚠️ Note `PUT-badbody-goodhdr` and `POST-badbody-goodhdr` are the same bytes on the wire except for
the method, and they disagree — **302 vs 403**. That pair is the whole of F5 in two requests, and
either one alone proves nothing. Round 1's e2e cell had only the always-agreeing half.

Everything else in the matrix, all matching:

| Group | Cells | Result |
|---|---|---|
| method × body-token-only | `POST` 302; `PUT`/`PATCH`/`DELETE` **403** | identical, 4/4 |
| method × `X-CSRFToken`-only | `POST` 302, `PUT` 302, `PATCH` 405, `DELETE` 405 | identical, 4/4 |
| token in a container `request.POST` does not populate — JSON body, query string, `text/plain` body | **403** each | identical, 3/3 |
| `multipart/form-data` body token | **302** — `request.POST` parses multipart too | identical |
| `_sanitize_token` shapes — no cookie (+hdr / +body), cookie but no token, empty cookie, non-alphanumeric token, 3-char token, a *different* valid 64-char token | 403 each, and the **two distinct failure pages** are served in the right cases | identical, 9/9 |
| cookie value used as the form token; cookie value used as the header | **302** both (`_compare_salted_tokens` unsalts) | identical, 2/2 |
| safe methods (`GET`, `OPTIONS`, `TRACE`) exempt | 200 / 200 / 405 | identical (`GET` body identical after masking the random `csrfmiddlewaretoken`) |
| the whole matrix repeated on `/reset/<uid>/<token>/` | 9 cells | identical, 9/9 |

**Both CSRF failure pages are byte-identical to v1**, and v2 picks the right one:
`REASON_BAD_TOKEN` → **1019 bytes**, `REASON_NO_CSRF_COOKIE` → **1386 bytes** (the longer page
carries the extra "this site requires a CSRF cookie when submitting forms" paragraph). v2 is not
serving one page for both reasons.

## R2.3 — F2: the 302s carry `Content-Type` and `Content-Length: 0` — **FIXED**

Six different routes into a 302 (`POST` with a body token, with a header token, `PUT` with a header
token, multipart, cookie-as-token, good-body-bad-header). All six, both sides:

```
HTTP/1.1 302 Found
Content-Length: 0
Content-Type: text/html; charset=utf-8
Location: /password_reset/done/
Vary: Origin
X-Frame-Options: SAMEORIGIN
```

Byte-identical header sets. The `APPEND_SLASH` **301** still carries it too (re-checked in R2.7).

---

## R2.4 — F3: the password-reset routes are plain Django views — **FIXED**, and the exemption is fail-closed

`@DjangoView()` replaces the wrong analogue (`@Public()` = `permission_classes = []`, which leaves
DRF's authenticators running). 409 cells across four groups.

### A. The exemption works — 280/280

5 URLs (`/password_reset/`, `/password_reset/done/`, `/reset/done/`,
`/reset/<uid>/<token>/`, `/reset/<uid>/set-password/`) × 7 methods
(`GET OPTIONS PUT POST DELETE PATCH TRACE`) × 8 `Authorization` shapes (absent, `Token deadbeef`,
a *valid* admin token, an *inactive* user's token, bare `Token`, `Token a b`, `Bearer <valid>`,
lower-case `authorization: token <valid>`).

**Every URL/method pair returns one single result across all 8 header shapes, on both sides.**
The header is now completely invisible on these routes, which is the point:

| Method | `/password_reset/` | `/password_reset/done/` | `/reset/done/` | `/reset/<uid>/<token>/` | `/reset/<uid>/set-password/` |
|---|---|---|---|---|---|
| `GET` | 200 / 1324 | 200 / 966 | 200 / 779 | 200 / 1001 | 200 / 1001 |
| `OPTIONS` | 200 / 0 | 200 / 0 | 200 / 0 | 200 / 1001 | 200 / 1001 |
| `POST`/`PUT`/`PATCH`/`DELETE` | 403 / 1386 | 403 / 1386 | 403 / 1386 | 403 / 1386 | 403 / 1386 |
| `TRACE` | 405 / 0 | 405 / 0 | 405 / 0 | 200 / 1001 | 200 / 1001 |

(The 403/1386 is `REASON_NO_CSRF_COOKIE` — these cells send no cookie. The confirm view's odd
`OPTIONS`/`TRACE` 200s are v1's, reproduced.) Round 1's F3 was **401** in the `deadbeef` and
inactive-token columns; all of those are gone.

### B. FAIL-CLOSED 1 — the exemption does not leak to DRF routes — 84/84

7 DRF routes (`/api/user`, `/api/user/1`, `/api/user/power`, `/api/user/birthdates`,
`/api/user/activate/13`, `/api-token-auth`, `/api/notification/subscribe`) × `GET POST OPTIONS` ×
4 bad-credential shapes. **Every cell is 401 on both sides**, with the four DRF bodies matching
byte-count exactly — 27 (`Invalid token.`), 38 (`User inactive or deleted.`), 59
(`…No credentials provided.`), 74 (`…should not contain spaces.`).

This covers the two `@Public()` DRF views specifically: `POST /api/user/activate/<id>` and
`POST /api-token-auth` still **401 on a malformed token**, which is the behaviour `@Public()` is
supposed to keep and `@DjangoView()` is supposed to drop. The two decorators are observably
distinct.

### C. FAIL-CLOSED 2 — no look-alike target reaches the exempted controller — 28/28

18 path shapes that resemble a reset route but are not the URL-table entry: case variants
(`/PASSWORD_RESET/`, `/Password_Reset/`, `/RESET/MTM/set-password/`), doubled and empty segments
(`//password_reset/`, `/password_reset//`, `/reset//<token>/`), extra segments
(`/password_reset/x/`, `/reset/done/x/`, `/reset/MTM/`), missing slashes, dot segments and
encodings (`/api/../password_reset/`, `/./password_reset/`, `/password_reset/./`,
`/password_reset/%2e/`, `/password_reset/%2E%2E/done/`), `%00`, and a `;`-param.

**Status agrees on every one**, with and without `Authorization: Token deadbeef`: 404 where v1
404s, 301 where v1 `APPEND_SLASH`-redirects (`/password_reset`, `/password_reset/done`,
`/reset/done`, `/reset/MTM/aaaaa-bbbbbbbb`), 200 where v1 genuinely matches
(`/reset/MTM/SET-PASSWORD/` — `SET-PASSWORD` satisfies the token regex, so it is the invalid-link
page; `/password_reset/?x=1`). A bad token never turns any of them into a 401. Body-size deltas on
the 404s are **D13**.

⚠️ **My round-1-style probe was wrong here and I fixed it mid-round.** The dot-segment cells were
first run without `--path-as-is`, so **curl** collapsed `/api/../password_reset/` to
`/password_reset/` before it left the client and both sides returned the 200 reset page — a cell
that agrees because of the HTTP client, not the server. With `--path-as-is` the raw target reaches
both servers and both 404. Same class of defect as the two the developer found; see R2.11.

### D. FAIL-CLOSED 3 — `view: null` still authenticates — confirmed

`/health` is the v2-only route (**P0-D2**) whose URL-table entry has `view: null`. It carries
`@Public()`, so if `isPlainDjangoView` were satisfied by the decorator alone the guard would step
aside. It does not:

| Request | v2 |
|---|---|
| `GET /health` | **200** / 31 |
| `GET /health` + `Authorization: Token deadbeef` | **401** / 27 |
| `GET /health` + an inactive user's token | **401** / 38 |
| `POST` / `OPTIONS /health` | 404 / 405-shaped |

The 401s prove `TokenAuthGuard` still ran. (v1 404s `/health` — the whole route is the registered
deviation, not these codes.)

### What I could **not** probe black-box

The remaining fail-closed direction — **`@DjangoView()` applied to a controller whose URL entry is
a DRF view** — is not reachable from outside: it needs a source change to put the decorator
somewhere it does not belong, and I do not modify code. What I can say is that the observable
consequence is absent (group B: no DRF route behaves as exempt) and that the guard's condition is
`route !== undefined && route.view !== null && route.drf === null`, i.e. it reads the same URL
table `RolesGuard` already trusts for C20. The unit coverage for the unreachable branch is
`src/auth/decorators/…` / `token-auth.guard.spec.ts`; verifying it is `nestjs-reviewer`'s call,
not mine.

---

## R2.5 — F4: DRF's `OPTIONS` metadata document — **FIXED**

| Route | v1 | v2 |
|---|---|---|
| `OPTIONS /api/user/activate/13` | `200`, `Allow: POST, OPTIONS`, `Vary: Accept, Origin`, `Content-Type: application/json`, **172 bytes** | **byte-identical** |
| `OPTIONS /api-token-auth` | `200`, `Allow: POST, OPTIONS`, **`Vary: Origin`** (single renderer — no `Accept`), **164 bytes** | **byte-identical** |

Both documents `cmp`-clean:

```
{"name":"User Activate","description":"","renders":["application/json","text/html"],"parses":["application/json","application/x-www-form-urlencoded","multipart/form-data"]}
{"name":"Obtain Auth Token","description":"","renders":["application/json"],"parses":["application/x-www-form-urlencoded","multipart/form-data","application/json"]}
```

Note the two `Vary` strings differ *correctly* — `Accept, Origin` on the view that has the
browsable renderer, `Origin` alone on the JSON-only one. That asymmetry is easy to get wrong and
v2 has it right.

Controls, all matching: `OPTIONS` on a guarded view is `403` for an allowed caller and `401`
anonymous (v1's deny-on-lookup-miss, unchanged); `OPTIONS` on the two metadata views with a *bad*
token is `401` (the `@Public()` authenticator still runs); with a *valid* admin token it is still
`200` + the document. **P1-D2's withdrawal is justified** — the document is served, not deviated.

---

## R2.6 — 🔴 **NEW: F6** — P3-D8 understates its own width: v1's content negotiation is a **406 before the handler**, not a body difference

The brief asked me to probe how wide P3-D8 really is. It is wider than the registration, and in a
different *kind* of way. P3-D8 says v1 renders HTML where v2 renders JSON — "**D13's species**",
a body difference. Measured across 8 `Accept` values × 9 request shapes (72 cells):

| `Accept` | v1 | v2 | Covered by P3-D8 as written? |
|---|---|---|---|
| `*/*`, `application/json` | JSON | JSON | n/a — **identical, 18/18** |
| `application/json;q=0.1,text/html;q=0.9` | **JSON** (DRF sorts by q, JSON wins on the ordering DRF uses) | JSON | n/a — **identical, 9/9** |
| a real browser's `text/html,…,*/*;q=0.8` | HTML on browsable views; **JSON** on `/api-token-auth` via `*/*;q=0.8` | JSON | yes, body only |
| `text/html` | HTML: `GET /api/user` 14 173 B, `GET /api/user/1` 9 002, `POST /api/user/birthdates` 7 262, the **401** 5 028 / 4 997, the **404** 5 781 | JSON | yes, body only |
| `text/html` on `/api-token-auth` (JSON-only renderer) | **`406 Not Acceptable`** | `400` / `200` | **no — status code** |
| `application/xml`, `text/plain`, `nonsense/nonsense` | **`406` on every DRF route, every time** | the normal 200/400/401/404 | **no — status code** |

And the 406 is not a rendering decision, it is a **control-flow** one.
`APIView.initial()` calls `perform_content_negotiation()` **before** `perform_authentication()` and
long before the handler. Two zero-write probes prove it on the live v1:

```
POST /api/user/power  {"type":"get","obj":"requested","page":0}   # the input that makes the view throw
  Accept: */*              v1 500   v2 500      <- handler ran on both
  Accept: application/xml  v1 406   v2 500      <- v1 never reached the handler; v2 did

GET /api/user  Authorization: Token deadbeef
  Accept: */*              v1 401   v2 401
  Accept: application/xml  v1 406   v2 401      <- v1 never reached authentication; v2 did
```

**Why this matters beyond cosmetics.** On a *write* endpoint the same ordering means v1 refuses the
request before any side effect and v2 performs it. A client (or a proxy, or a misconfigured
`Accept`) that would have been safely rejected by v1 will mutate data against v2. That is a
different risk class from "the error page is HTML instead of JSON", and P3-D8's rationale — "no v1
client sends `Accept: text/html`; the React app sends `application/json`" — argues only about the
HTML branch. It does not argue about `Accept: application/xml`, and the `*/*` fallback that saves
real browsers does not save a client that sends a single unacceptable type.

**Not a regression** — v2 has never negotiated content, and this is invisible under the `Accept`
values any real client sends. But it is **not covered by the deviation as registered**, so per §7 I
have to file it. Severity **low–medium**. `business-analyst` should decide whether v2 owes a 406,
or whether P3-D8 is re-worded to say plainly: *"v2 ignores `Accept` entirely; v1 returns 406 for
any `Accept` matching no renderer, before authentication and before the handler, so v2 will accept
and execute requests v1 rejects."*

**Not affected:** the four plain-Django reset routes ignore `Accept` on both sides — 12/12 cells
identical across `*/*`, `text/html`, `application/xml`, `nonsense/nonsense`.

---

## R2.7 — Round-1 coverage, re-proved

### The 72-cell D1 matrix — **PASS**, unchanged from round 1

Re-run in full (4 actors × {self, other} × 9 bodies), restoring every touched row from a pristine
copy of the database around **each** leg so v1 and v2 both act on identical input. Classification
of all 72:

| Class | Cells |
|---|---|
| byte-identical (status, body, all four tables) | **23** |
| same status, same rows, body differs only because v1's uncaught-500 page is 27 bytes of HTML and v2's is empty (**D13**) | **16** |
| v2 **403** where v1 acted — the **D1 / D16 / P3-D1** family | **33** |
| anything else | **0** |

The escalation cells that motivate D1 still behave as registered:

| Cell | v1 | v2 |
|---|---|---|
| `MEMBER` → self, `personal` with `role` changed | **200, writes `fondo_api_userprofile`** (self-escalation to ADMIN) | **403**, no write |
| `MEMBER` → self, `finance` changed | **200, writes `fondo_api_userfinance`** (member sets own quota) | **403**, no write |
| `MEMBER`/`PRESIDENT` → another member, every body | 200 (or 409/500), writes | **403**, no write |
| `TREASURER` → another member, `finance` | 200, writes | **200, writes** — cross-member finance kept |
| `PRESIDENT` → self, `personal` name only / `preferences` | 200 | **200** — self-service kept (Q25a) |
| `ADMIN`, every cell | as v1 | as v1 |

### 🔴 A gap in round 1's D1 harness that I inherited, and closed

The matrix compares `auth_user`, `fondo_api_userprofile`, `fondo_api_userfinance` and
`fondo_api_userpreference`. It does **not** look at `fondo_api_notificationsubscriptions` or
`fondo_api_schedulertask` — and `PATCH /api/user/<id>` writes both. Running the matrix destroyed
**76 subscription rows and 31 scheduler rows** while reporting no mismatch, because neither table
was in the comparison.

Two v1 behaviours are responsible, both in `services/user.py`:

* `__update_user_preferences` (line 217): when `notifications` goes **true → false** it calls
  `remove_all_subscriptions(id)`, which **deletes every push subscription the user has**.
  User 2 alone holds 64 of the fixture's 94 rows.
* `__update_user_personal` → `__create_birthdate_notification` → `remove_sch_notitfications`
  (`services/notification.py:70`): `SchedulerTask.objects.filter(payload__owner_id=…,
  payload__type='birthdate').delete()` deletes **all** of that owner's birthday tasks, *including
  processed historical ones*, before creating the replacement. This is round 1 §9's incident,
  confirmed as v1's own documented behaviour rather than a probe accident.

So I tested them deliberately, one user at a time, restore-from-pristine around each leg:

| Probe (target = user 5, actor = ADMIN) | v1 | v2 | Verdict |
|---|---|---|---|
| `preferences`, `notifications` **true → false** | 200; the user's **6** subscriptions deleted (94 → 88) | 200; **the same 6 deleted** (94 → 88) | **PASS** |
| `preferences`, `notifications` stays **true** (control) | 200; **nothing deleted** | 200; nothing deleted | **PASS** |
| `personal` echo **with** `birthdate` | 200; the owner's **8** birthday tasks deleted and **1** created (626 → 619) | 200; **same 8 deleted, 1 created** | **PASS** |
| `personal` echo with the `birthdate` key **removed** (control) | 200; scheduler untouched | 200; untouched | **PASS** |

v2 reproduces both destructive side effects exactly, including the "only when the flag actually
flips" and "only when the key is present" guards.

### The birthday `SchedulerTask`, field by field — **PASS**

Reference row `fondodev` **2458** (the historical row for the same owner):

```
2458 | 0 | 2027-08-25 05:00:00+00 | 4 | f | "type"=>"birthdate", "target"=>"/",
       "message"=>"Hoy está cumpliendo años N@CHO Montañez Herrera", "owner_id"=>"5",
       "user_ids"=>"[2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8]"
```

The row each stack creates today, `cmp`-compared across `type`, `run_date`, `repeat`, `processed`
and `payload::text`:

```
0
2026-08-25 05:00:00+00
4
false
"type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años N@CHO Montañez Herrera",
"owner_id"=>"5", "user_ids"=>"[1, 12, 11, 2, 7, 14, 4, 8, 10, 6, 9, 13]"
```

**Byte-identical.** Note `user_ids` is `[1, 12, 11, 2, 7, 14, …]` — neither sorted nor row 2458's
order: it is Postgres's *current* heap order for `get_users_attr("id")`, and v2 reproduces it
exactly rather than emitting a sorted list. `05:00:00+00` (America/Bogota midnight), `repeat = 4`,
`type = 0`, the owner excluded from `user_ids`, and the two inactive members (3, 15) absent — all
matching.

### `create_user` — four-table write and the rollback at zero rows — **PASS**

| Leg | v1 | v2 |
|---|---|---|
| SES `ok`, `POST /api/user` | **201**; `auth_user` 15→16, `userprofile` 15→16, `userfinance` 15→16, `userpreference` 15→16, `authtoken_token` **15→15** (no token until activation), `auth_user_id_seq` 29→30 | **identical on every count and the sequence** |
| the created rows | `987654321\|3\|Parity\|Probe\|parity.probe@nowhere.test\|parity.probe@nowhere.test\|false\|true` (username := email, inactive, `key_activation` set); finance `0\|0\|0\|0\|0`; preference `false\|#800000\|#c83737` | **`cmp`-identical** |
| SES `fail` (capture server answers 500) | **409** `{"message":"Invalid email"}`; **0 rows left in all four tables**; sequence still advanced (nextval is not transactional) | **identical, including the advanced sequence** |

### SES payloads — **PASS on two of three**, one new difference

| Mail | Result |
|---|---|
| **user activation** | `Source`, `Destination.ToAddresses.member.1`, `BccAddresses` (empty), `Subject.Data` (`[Fondo Montañez] Activación de cuenta`), `Charset`, and the HTML body **identical** — the only textual difference is the random `key_activation` inside the activation URL, which is volatile by construction |
| **password reset** | identical on every field; only the random reset token inside `https://localhost/reset/NA/<token>/` differs. Note both build the link on `https://localhost` — P3-D7's `Secure`/https behaviour agrees |
| **power approved** | `Source`, `Subject.Data`, `Charset` and the **whole HTML body** identical, same 13 recipient addresses — but **in a different SES field**. **D5**, as registered — see R2.8. |

### SQS — **PASS**

`POST /api/user/power` `{"type":"post","requestee":5,…}` (requestee 5 has 6 push subscriptions;
the first attempt used requestee 4, who has none, and **correctly produced no publish on either
side** — `send_notification` returns early when the subscription set is empty).
`MessageBody` **2 391 bytes, byte-identical**, subscriptions, keys, endpoints and `expirationTime`
included. v1 publishes through `celery -A api worker` + redis, v2 inline; the bytes on the wire are
the same.

---

## R2.8 — F7 **raised and withdrawn**: the power-approval `To`/`Bcc` inversion is **D5**

I filed this as a new finding and then found it registered. Recording both halves, because the
*measurement* stands and one sentence of round 1 does not.

```
POST /api/user/power  {"type":"post","requestee":4,"meeting_date":"2026-12-01"}   (ADMIN)
POST /api/user/power  {"type":"patch","id":<id>,"state":1}                        (member 4)
```

| SES field | v1 | v2 |
|---|---|---|
| `Destination.ToAddresses.member.1…13` | **13 member addresses** | *(absent)* |
| `Destination.BccAddresses.member.1…13` | *(absent)* | **the same 13 addresses** |
| `Source`, `Message.Subject.Data`, `Message.Body.Html.Data`, both `Charset`s | identical | identical |

**This is `docs/phase-3-deviations.md` D5**, decided in `MIGRATION_PLAN.md` (Q18/Q10): *"Power-approval
email puts every member in `ToAddresses` with empty `Bcc` → move to `Bcc`; recipient list stays
every member — only the disclosure is fixed."* The deviation even flags the empty `To:` as worth an
operator confirmation, which is exactly the deliverability concern I was going to raise.
`test/user.e2e-spec.ts:1651` asserts `recipients == []` and an 11-address `bcc` with a D5 citation.
**Verdict: behaving as registered. F7 withdrawn — not a finding.**

⚠️ **But round 1's summary is wrong about it.** Round 1 says the "SES activation / power-approval /
password-reset payloads" were identical. The power-approval payload is *deliberately not* identical,
and round 1 could not have seen that: it compared `ses-v1.html` / `ses-v2.html`, i.e. the rendered
`Message.Body.Html.Data` **only**, which does match. Round 1 recorded a pass on the envelope without
ever comparing the envelope. That is a fourth instance of the green-for-the-wrong-reason class, in
my own prior report rather than in the suite — see R2.11.

---

## R2.9 — `PATCH /api/user`, the multipart TSV bulk finance update — **PASS on the data**, one new edge (**F8**)

### Banker's rounding and the payload shapes — **PASS**

`int(round(float(x), 0))` is Python 3's round-half-**to-even**. Seven payloads, whole
`fondo_api_userfinance` table `cmp`-compared after each:

| Payload | v1 | v2 |
|---|---|---|
| `.5` on every column (`100.5 200.5 300.5 400.5`, `2.5 3.5 4.5 5.5`, `1.4999 1.5001 -0.5 2.5`) + one unknown identification | 200, rows written | **identical rows** |
| all zeroes | 200 | identical |
| empty file | 200 | identical |
| no trailing newline | 200 | identical |
| CRLF line ending | 200 | identical |
| non-numeric identification | **500**, whole transaction rolled back | identical |
| a single blank line | **500** | identical |

The rounding that actually landed, identical on both sides:

```
100.5 -> 100    200.5 -> 200    300.5 -> 300    400.5 -> 400     (half to even)
  2.5 ->   2      3.5 ->   4      4.5 ->   4      5.5 ->   6
1.4999 ->   1   1.5001 ->   2     -0.5 ->   0      2.5 ->   2
available_quota = total - utilized, so user 1 lands on -200 on both stacks
```

**`last_modified` no-op**: re-sending a user's current four values leaves the date at `2026-08-12`
on both — `__update_user_finance` only saves when one of the four differs, and v2 reproduces the
comparison rather than always writing. **Unknown identification** is skipped and logged, the rest
of the file still applies, on both.

**Role matrix**: ADMIN 200, TREASURER 200, PRESIDENT 403, MEMBER 403 — identical.

### 🔴 **NEW: F8** — malformed `multipart/form-data` lands on the other side of the 400/500 line

Eight `Content-Type` values on `PATCH /api/user`. Five agree exactly (`multipart/mixed` 415,
`text/plain` 415, `application/json` 400 with an identical `JSON parse error` detail,
`application/x-www-form-urlencoded` 500, no `Content-Type` 500). **Three disagree, in opposite
directions**, stable across repeats:

| `Content-Type` | v1 | v2 |
|---|---|---|
| `multipart/form-data` (no `boundary` at all) | **500** `<h1>Server Error (500)</h1>` | **400** `{"detail":"Multipart form parse error - Multipart: Boundary not found"}` |
| `multipart/form-data; boundary=` (empty boundary) | **400** `{"detail":"Multipart form parse error - Invalid boundary in multipart: "}` | **500**, empty body |
| `multipart/form-data; boundary=zzz` (declared boundary, body is not multipart) | **500** | **400** `{"detail":"Multipart form parse error - Unexpected end of form"}` |

The two stacks have swapped which malformed multipart inputs their parser catches as a client error
and which escape as an unhandled 500. Two of the three are v2 being *better* (400 where v1 500s),
but the middle row is v2 turning a request v1 answers with a **400 and a diagnostic** into a bare
**500**. Round 1 probed four content types and none of these three.

Severity **low** — malformed-request handling, no data at risk, no v1 client sends these. But it is
an unregistered status-code difference on an implemented Phase 3 endpoint. For `nestjs-developer`
(match v1's three outcomes) or `business-analyst` (register the parser-boundary difference once,
since it will recur on every multipart endpoint in later phases — `POST /api/file`, the loan
detail upload).

---

## R2.10 — the rest of round 1's surface, and Phase 2's edges

| Check | Cells | Result |
|---|---|---|
| **All six `Vary` strings** (in fact 13 distinct response shapes) | 13 | **identical** — `Accept, Origin` (DRF multi-renderer, its 401/403/400 and the caught 500), `Origin` (single-renderer `OPTIONS`, the uncaught 500, the 302, the 404, the preflight), `Cookie, Origin` (the reset form), **`Origin, Cookie`** (the set-password page — *the other order*, preserved), and **no `Vary` at all** on the `APPEND_SLASH` 301 |
| **The four reset pages + the set-password page**, byte for byte after masking the per-render `csrfmiddlewaretoken` | 5 | **identical**: 1 265 / 966 / 779 / 1 001 / 1 001 bytes |
| **Both CSRF failure pages**, byte for byte | 2 | **identical**: 1 019 (`REASON_BAD_TOKEN`) and 1 386 (`REASON_NO_CSRF_COOKIE`) |
| **URL sweep**, 33 path shapes × 6 methods, `--path-as-is`, restoring the fixture around every unsafe method | 198 | **30 mismatches, all expected**: 29 are later-phase routes v1 serves and v2 404s (`/api/loan`, `/api/activity/5/`, `/api/file`, `/api/admin`, `/api/saving-account`) and 1 is `/health` (P0-D2). **Every Phase 1–3 path matches on every method.** The fail-closed direction holds: v2 serves no path v1 does not |
| **`ALLOWED_HOSTS`** — 6 paths × {`evil.test`, `localhost:9999`, `localhost.`, absent} | 24 | **identical except the three `/health` rows** (the registered v2-only route). `Host: evil.test` is **400 on every path on both**, including `/nope/nope` and `/api-token-auth` — C19 holds |
| **Bare `OPTIONS` vs genuine preflight** — 7 paths | 14 | **identical**, bare `401/401/401/200/404/200/200` and preflight `200` everywhere |
| **Pagination envelope** — `page=1`, `2`, `99`, `0`, `-1`, absent, `?page=1&page=2` | 7 | **identical**, including `page=99` → `{"list":[],"num_pages":2,"count":13}` **200** (not 404) and QueryDict last-value semantics on the repeated parameter |
| **`DELETE /api/user/<id>`** role matrix, unknown id, re-delete of an already-inactive user | 6 | **identical**, rows identical |
| **D14 `-1` sentinel** | 3 | `GET` 200 both, `DELETE` 404 both, `PATCH` **v1 404 / v2 200** — **D14 as registered** |
| **D15 / P3-D2 shared-email account 13** | 1 | `PATCH` name → **v1 409 / v2 200** — as registered |

---

## R2.11 — the sweep for tests that pass for the wrong reason

The brief asked where else an assertion might be satisfied by the transport or the middleware
rather than by the behaviour under test. I found **five** instances. Two are in my own harness,
one is in round 1's report, one is a coverage gap in the suite, and one is a shape the suite
already defends against well.

### 1. 🔴 In my own D1 matrix — a 72-cell matrix that agreed on nothing

The first round-2 run of the D1 matrix printed `cells=72 mismatches=0`. **Every single cell was a
401.** My restore helper read `is_active::text`, which Postgres renders as `true`/`false`, and
compared it to psql's *display* format `t` — so it wrote `is_active = false` for all five actors,
and every subsequent request authenticated as a deactivated user. v1 and v2 agreed perfectly,
because they agree perfectly on rejecting a dead token.

A parity matrix that asks only *"did the two sides agree"* is satisfied by **any uniform failure**.
The rewritten driver now asserts **positive controls** — that no cell returned 401, that the run
produced at least one 200, one 409 and one 500, and that **both** sides actually wrote rows
somewhere — and prints the status distribution (`v1 {200: 41, 409: 7, 500: 24}`,
`v2 {200: 22, 403: 33, 409: 1, 500: 16}`) so the shape of the run is visible, not just its verdict.
**Every comparison harness in this project should carry that assertion**, including
`role-matrix.e2e-spec.ts`'s 280-cell replay.

### 2. 🔴 In my own URL sweep — the probe destroyed its own credentials

The 198-cell sweep runs `DELETE /api/user/1` with the **ADMIN's own token**. v1 answered 200 and
soft-deleted the admin; every one of the ~150 later cells then ran with a dead token and both
stacks returned 401, so they "agreed". The sweep reported 32 mismatches when the honest number is
30, and roughly three quarters of it was measuring nothing. Fixed by restoring the fixture around
every `POST`/`PATCH`/`DELETE` cell.

### 3. 🔴 In my own F3 probe — curl normalised the request target

`/api/../password_reset/`, `/./password_reset/` and `/password_reset/./` all returned **200 on both
sides** until I added `--path-as-is`: curl was collapsing the dot segments before the request left
the client, so the cells asserted that both servers serve `/password_reset/`. With the raw target
on the wire both 404. **This is the same defect as the supertest-normalisation instance already
known** — it recurs whenever the client is allowed to rewrite what is being tested.

### 4. 🔴 In round 1's report — the SES check never looked at the envelope

Round 1 recorded the "SES activation / power-approval / password-reset payloads" as identical. It
compared `ses-v1.html` / `ses-v2.html`, i.e. `Message.Body.Html.Data` alone. The power-approval
envelope is **deliberately different** (D5: `ToAddresses` → `BccAddresses`), and round 1 could not
have seen it. The assertion was green because it was pointed at the part that matches. Round 2
compares **every SES form field** (`Source`, `Destination.ToAddresses.*`, `Destination.BccAddresses.*`,
`Subject.Data`, both `Charset`s, `Body.Html.Data`) and reports per-field.

### 5. 🟠 A coverage gap in the F5 e2e block — the sharpest cell is missing

`test/password-reset.e2e-spec.ts` now covers `PUT`/`PATCH`/`DELETE` with a body token (403),
`POST` with a body token (302), `PUT` with a header token (302), `PUT` with **both** where the body
token is garbage (302), and `POST` with an **empty** body token plus a header (302). It does **not**
cover:

> **`POST` with a non-empty *wrong* body token **and** a valid `X-CSRFToken`.**

Django's fallback is `if request_csrf_token == "": request_csrf_token = META[CSRF_HEADER]` — it fires
only on the *empty* string. So that request must be **403**. An implementation that read the header
first, or that fell back to the header whenever the body token failed to validate, would satisfy
**every cell in the current suite** and still be wrong in exactly F5's direction.

**v2 is correct here** — I measured `POST` + `csrfmiddlewaretoken=zzzz…` + valid header as **403 on
both stacks**, with byte-identical 1 019-byte failure pages. This is a missing test, not a defect.
It is worth adding precisely because it is the one cell that distinguishes the fix from the two
plausible near-misses.

### 6. 🟢 Shapes the suite defends well

For balance — I went looking for these and did not find problems:

* **Request-target tests use a raw socket.** `http-edge.e2e-spec.ts`'s `rawRequest` helper is used
  for every fragment/`#`/`Host`-forgery case, which is the correct response to instance 3.
* **Negative mock assertions have positive controls beside them.**
  `notification.e2e-spec.ts:430` (`sqs.send` not called for a member with no subscriptions) sits
  directly after two cells that prove the same mock *does* fire — so it cannot pass because the
  wiring is dead. I hit exactly that trap myself: my first SQS probe used requestee 4, who has **0**
  subscriptions, and captured nothing on either side. The right reading was not "SQS matches" but
  "this probe cannot see SQS"; re-run against requestee 5 (6 subscriptions) it captured a
  **byte-identical 2 391-byte `MessageBody`**.
* **The role matrix replays a captured oracle.** `v1-role-matrix.fixture.ts` is 280 real v1
  responses, not hand-written expectations, so the cells cannot drift to whatever v2 does. Its one
  structural limit is that it replays through **synthetic** controllers (`MATRIX_CONTROLLERS`), so
  it pins the guard wiring rather than the real Phase 3 controllers — which is why the live 72-cell
  D1 matrix and the 84-cell DRF-authentication matrix in R2.4 matter as the complement.
* **The N3 percent-encoding cells are v1-accurate.** I re-measured all five against the oracle:
  `POST /api%2Dtoken%2Dauth` → 400 + `{"non_field_errors":["Unable to log in with provided
  credentials."]}`, the two `%6E`/`%61` paths → 401, `%41PI` and `sub%2Fscribe` → 404, on both
  stacks. Those assertions test what they claim to.

---

## R2.12 — what I could not test

| Not tested | Why | Who can close it |
|---|---|---|
| **`@DjangoView()` on a controller whose URL entry is a DRF view** | Needs a source change to put the decorator where it does not belong; I do not modify code. The three *reachable* fail-closed directions are proved (R2.4 B, C, D) and the guard's condition is `route !== undefined && route.view !== null && route.drf === null`, but the fourth arm is only covered by unit tests | `nestjs-reviewer` — read `token-auth.guard.spec.ts` / `roles.guard.spec.ts` and confirm the DRF-route arm is asserted |
| **v1's browsable-API HTML rendered by v2** | P3-D8: v2 ships no browsable API by design. I measured the *sizes* and the 406 control flow (F6) but cannot diff HTML that one side does not produce | n/a — registered |
| **v2's scheduler / worker** | Phase 7b; v2 has no scheduler process yet. I verified the `SchedulerTask` **row** v2 writes, not its later execution | Phase 7b's tester |
| **Real SES / SQS** | Both stacks were pointed at a local capture server; no traffic left the host. Credential handling, throttling and SES bounce behaviour are out of reach | integration environment |
| **v1's Celery retry/loss semantics under a broker failure** | P2-D7 is a Phase 2 registration; I confirmed the happy-path `MessageBody` only | Phase 2's owner |
| **D19 (29 Feb), D20 (soft-deleted member), D11 (duplicate child rows)** | Round 1 proved these with hand-injected rows and a leap-year birthdate. I did **not** re-run them this round — they need row injection into `fondodev`, and after two fixture incidents I judged the risk not worth re-proving a result no fix touched (nothing in F1–F5 goes near `UserFinance`/`UserPreference` lookup or the birthdate clamp). **Round 1's evidence stands unrefreshed** | a later round, or accept round 1 |
| **Later-phase routes** (`/api/loan`, `/api/activity`, `/api/file`, `/api/admin`, `/api/saving-account`) | Not implemented in v2; the sweep confirms they 404 and that v2 serves nothing v1 does not | Phases 4–8 |
| **`POST /api/alexa`, `GET/POST /api/authorize`** | Out of scope by instruction | — |

---

## R2.13 — system health

| Check | Result |
|---|---|
| v1 boots | ✅ `fondo-v1-p3` restarted after the host reboot; gunicorn 19.9.0, `api.settings.production`, `fondodev`. A second shimmed gunicorn on `127.0.0.1:8451` is the oracle for every cell |
| v1 repo untouched | ✅ still bind-mounted `ro`; `git status` clean at `5bef585`. The boto3 shim lives at `/probe` inside the throwaway container |
| v2 boots | ✅ `node dist/main.js`, 21 routes mapped, Prisma connected, `production` |
| v2 build current | ✅ `npm run build` re-emitted `dist/` byte-identical (`b7d2f372…`) — the running binary is `1344b48`'s source |
| lint / typecheck | ✅ `eslint` clean, `tsc --noEmit` clean |
| unit | ✅ **1 503 passed / 49 suites** |
| e2e | ✅ **647 passed, 1 skipped / 13 suites** |
| e2e isolation | ✅ the suite ran against the disposable test database; `fondodev`'s `snap.sh` output is **byte-identical before and after the whole e2e run**. `shared-database-guard.ts` is a well-built positive-evidence guard (Django ledger rows + `0_init` step count + a name denylist) |
| migrations / schema untouched | ✅ `django_migrations` **38**, `_prisma_migrations.0_init.applied_steps_count` **0** (marked, never executed); `information_schema.columns`, `pg_constraint`, `pg_indexes` hashes all equal to baseline |
| fixture integrity, final | ✅ `snap.sh` **identical to the round-2 baseline on every line**: `auth_user` 15 / `eb2217b4…`, `userprofile` `279ef0f6…`, `userfinance` `8ec339bd…`, `userpreference` `94e8bc42…`, `power` 20 / `002cbae3…`, `authtoken_token` 15 / `36770022…`, `notificationsubscriptions` **94 / 1468 / xmin-distinct 1 / `7a6afbcc…`**, `schedulertask` **626 / `c3bf5409…`**, `django_session` 20, both sequences at 29 / 2528 |
| scheduler / worker | ✅ redis 7 + `celery -A api worker` restarted for v1 and consumed every `send_notification`; v2 publishes inline. v2 has no scheduler process (Phase 7b) |
| SES / SQS | ✅ 100 % captured locally on `:4599` (v1) / `:4598` (v2); no traffic left the host |
| stray writes | ✅ none. Every write was one a probe asked for, and every one was restored |

### ⚠️ Two fixture incidents this round, both fully recovered

Unlike round 1's, **both were reversed with zero residue** — the §7 dump did its job.

1. **`auth_user` and `fondo_api_userpreference` corrupted** by the `is_active::text` bug in §R2.11.1
   (five users deactivated, five preference rows flipped). Repaired from the pristine copy; both
   guard hashes back to baseline.
2. **76 `fondo_api_notificationsubscriptions` rows and 31 `fondo_api_schedulertask` rows deleted**
   by the D1 matrix, through v1's own `remove_all_subscriptions` and `remove_sch_notitfications`
   (R2.7). Both tables restored wholesale from the pristine copy, sequences reset; counts, max ids,
   `xmin`-distinct and content hashes all back to baseline.

**A §7 amendment I would ask for.** The round-2 dump taken before the first write cell was written
into the agent scratchpad under `/tmp` — and the host rebooted and took it with it. The rule should
say the dump must live on **persistent storage, not a tmpfs**. Round 2's replacement is in
`~/.fondo-parity-dumps/r2/` (a per-table `--column-inserts` dump and a full dump), and it is what
made both recoveries above one command each. A second clause worth adding: **restore from the dump,
never from statements reconstructed by the probe** — incident 1 was caused by hand-built `UPDATE`s,
and incident 2 was cleaned by `pg_dump`/`psql` in seconds.

---

## R2.14 — verdict

### F1–F5: all five **fixed**

| # | Round-1 finding | Status | Evidence |
|---|---|---|---|
| **F1** | the caught 500 lost `Allow` and `Vary: Accept` | ✅ **fixed** | 9 caught-500 inputs keep both headers; 7 uncaught 500s correctly drop both; 6 controls unaffected. The strip now keys on *who built the response*, and the narrowed **P3-D6** is accurate |
| **F2** | the password-reset 302s omitted `Content-Type` | ✅ **fixed** | 6 different routes into a 302, byte-identical header sets with `text/html; charset=utf-8` and `Content-Length: 0`; the `APPEND_SLASH` 301 did not regress |
| **F3** | v2 authenticated the four plain-Django views | ✅ **fixed, and fail-closed** | 280/280 cells identical across 5 routes × 7 methods × 8 `Authorization` shapes; 84/84 DRF routes still 401; 28/28 look-alike targets never reach the exemption; `/health` (`view: null`) still 401s a bad token. One arm unreachable black-box (R2.12) |
| **F4** | bare `OPTIONS` on the anonymous-allowed views 405'd | ✅ **fixed** | both metadata documents byte-identical (172 B / 164 B) with the correct asymmetric `Vary`; 11 controls match. **P1-D2's withdrawal is justified** |
| **F5** | the CSRF token was read from the body on every unsafe method | ✅ **fixed** | 44 cells identical, including all four that discriminate a correct fix from a source-reordering one. See the coverage gap in R2.11.5 — the fix is right, the suite does not fully pin it |

**No regression** from the five fixes: the 72-cell D1 matrix, `create_user`'s four-table write and
zero-row rollback, the birthday `SchedulerTask` byte for byte, the SES and SQS payloads, the TSV
bulk update with banker's rounding, all 13 `Vary` shapes, the five reset pages and both CSRF failure
pages, the 198-cell URL sweep, `ALLOWED_HOSTS`, and bare-`OPTIONS`-vs-preflight all behave as round 1
recorded them.

### New this round

| # | Finding | Severity | For |
|---|---|---|---|
| **F6** | **P3-D8 understates its own width.** v1's content negotiation returns **`406 Not Acceptable`** for any `Accept` matching no renderer — `application/xml`, `text/plain`, anything — and for `text/html` on the JSON-only `ObtainAuthToken`. It fires in `APIView.initial()` **before authentication and before the handler**, proved by `Accept: application/xml` turning a 500 into a 406 and a 401 into a 406. v2 ignores `Accept` entirely and runs the request. P3-D8 registers only "HTML body vs JSON body" | low–medium (a write endpoint v1 refuses, v2 executes) | `business-analyst` — re-word P3-D8, or `nestjs-developer` if v2 owes a 406 |
| **F8** | **Malformed `multipart/form-data` lands on the other side of the 400/500 line**, in both directions: no `boundary` → v1 500 / v2 400; `boundary=` empty → **v1 400 / v2 500**; `boundary=zzz` with a non-multipart body → v1 500 / v2 400. `phase-1-drf-auth-bodies.md` registers the multipart *message text* on the premise that "both are 400" — these three show that premise is not always true | low | `nestjs-developer` or `business-analyst` — will recur on every multipart endpoint in Phases 4–8 |
| ~~F7~~ | ~~power-approval mail uses `Bcc` where v1 uses `To`~~ | — | **withdrawn** — this is **D5**, decided and registered (R2.8) |

Plus, not a defect in v2: **one coverage gap** (R2.11.5, the missing `POST` + wrong-body-token +
valid-header cell) and **one correction to round 1's own report** (R2.11.4, the SES check never
compared the envelope).

### Verdict by endpoint

| Endpoint | Round 2 |
|---|---|
| `GET /api/user` | **PASS** — pagination envelope, both 400s, the uncaught 500's header set, `Vary`, all identical |
| `POST /api/user` | **PASS** — four-table write identical, mail-failure rollback to zero rows on both, sequence behaviour identical, SES payload identical |
| `PATCH /api/user` (TSV) | **FAIL (F8 only)** — rounding, `last_modified` no-op, unknown-identification skip, rollback and role matrix all identical; three malformed-multipart content types differ |
| `GET /api/user/<id>` | **PASS** |
| `PATCH /api/user/<id>` | **PASS with the registered D1/D14/D15/D16/D19/D20/P3-D1/P3-D2 divergences** — 72 cells fall into exactly three classes, none unexplained; both destructive side effects (subscription wipe, scheduler-task wipe) reproduced exactly |
| `DELETE /api/user/<id>` | **PASS** |
| `POST /api/user/birthdates` | **PASS** |
| `POST /api/user/power` | **PASS** — F1 closed; SQS `MessageBody` byte-identical; the approval mail is **D5** |
| `POST /api/user/activate/<id>` | **PASS** — F4 closed |
| `GET\|POST /password_reset/` | **PASS** — F2, F3, F5 all closed |
| `GET /password_reset/done/`, `GET /reset/done/` | **PASS** — byte-identical with any `Authorization` header |
| `GET\|POST /reset/<uid>/<token>/`, `…/set-password/` | **PASS** — F2, F3, F5 closed; the hop, the validators and single-use all identical |
| Phase 7a `SchedulerTask` write | **PASS** — byte-identical including `user_ids` heap order |
| **cross-cutting: content negotiation** | **FAIL (F6)** — affects every DRF route in every phase |

## Phase verdict: **FAIL**

**But a different failure from round 1's.** All five filed defects are genuinely fixed, the two
security-adjacent ones (F3, F5) are fixed in the fail-closed direction and I could not find a way
around either, and nothing regressed. The phase fails only on §7 — *"an unregistered behavioural
diff is a parity failure"* — for **F6** and **F8**, both of which are **pre-existing**, neither of
which the F1–F5 work introduced, and both of which may well be closed by **registering** them
rather than by changing code. That is `business-analyst`'s and `nestjs-reviewer`'s call, not mine.

If F6 and F8 are registered as deviations, this phase is a **PASS** on everything else measured:
**1 100+ live cells** this round with no unexplained difference.

**Routing:** F6 and F8 → `business-analyst` first (both are more likely re-wordings than code
changes), then `nestjs-developer` if a fix is chosen. The R2.11.5 coverage gap → `nestjs-developer`
(one e2e cell). The §7 amendment (dump must not live on a tmpfs; restore from the dump, never from
reconstructed statements) → `nestjs-reviewer` for the plan. This report → `nestjs-reviewer`.

---
---

# Round 3 — re-test of F6, F8 and the R2.11.5 coverage gap

**Tester:** `manual-tester` (black-box). **Date:** 2026-09-03 (round 3).
**v1 (oracle, frozen):** `~/Projects/Fondo-API` @ `5bef585`, container `fondo-v1-p3`, gunicorn
19.9.0, `api.settings.production`, `fondodev`, reached on `127.0.0.1:8451` (the shimmed second
gunicorn with `PARITY_AWS_ENDPOINT=http://127.0.0.1:4599`). Untouched.
**v2 (under test):** `~/Projects/Fondo-API-v2` @ `cc320a4` (`feat/phase-3-users`), tree **clean**.
`cc320a4` and `96edd64` are both `MIGRATION_PLAN.md`-only commits, so the running binary is the
source of **`b456cbe`** — the R2.11.5 commit, on top of `622c78e` (F8) and `0d0a7db` (F6).
`npm run build` re-emitted `dist/` **byte-identical** (`2014eb8f8133d19592730f8fdbcdd61b` before
and after), so the running binary is the reviewed source.
**Database:** the shared `fondodev`.

## Verdict: **FAIL** — F6, F8 and R2.11.5 are all fixed, nothing regressed, one new low-severity diff

Everything filed in rounds 1 and 2 (**F1–F8**) is closed and re-verified. The phase fails on §7
alone, for a **ninth** unregistered difference found this round: **F9** — v1's gunicorn returns an
entity body on a `HEAD` request and v2's Node server suppresses it. It is a *server-runtime*
difference, not application code, v1 is the RFC-non-conformant side, and it is almost certainly a
registration rather than a fix. No other unexplained difference in **2 400+ live cells**.

### Harness note — one thing I had to change before the first cell

The `:8450` instance handed to me had `ALLOWED_HOST_DOMAIN=localhost` as promised, but its
`NOTIFICATIONS_QUEUE_URL` was `https://sqs.us-east-2.amazonaws.com/000000000000/parity` and it had
**no** `AWS_ENDPOINT_URL_SES` / `AWS_ENDPOINT_URL_SQS`, `HOST_URL_APP`, `LANGUAGE_LOCALE` or
`TZ_NAME`. Every SES and SQS probe would have gone to **real AWS**, `create_user`'s rollback would
have fired on the resulting failure rather than on the capture server's, and the birthday
`SchedulerTask`'s `run_date` depends on `TZ_NAME=America/Bogota`. Restarted from
`p3/start-v2.sh`, which sets the full round-2 env including `ALLOWED_HOST_DOMAIN=localhost`, both
AWS endpoints pointed at the capture server on `:4598`, and the local queue URL. Recorded because
a partially-configured server is exactly the shape that produces a uniform result — see §R3.10.

**Baseline verified before the first write cell.** `snap.sh` output is **byte-identical to round
2's closing snapshot on every line**: `schedulertask` 626 / `c3bf5409…`,
`notificationsubscriptions` **94 / max-id 1468 / xmin-distinct 1** / `7a6afbcc…`, `auth_user` 15 /
`eb2217b4…`, `power` 20 / `002cbae3…`, `loan` 425, `django_session` 20, `django_migrations` 38,
schema/constraint/index hashes `613a748c…` / `6dc19981…` / `fbacaf14…`, sequences 29 / 2528.
`pg_dump` (full + `--data-only`) taken to **`~/.fondo-parity-dumps/r3/`** — persistent storage, per
the §7 amendment — before any write cell.

---

## R3.1 — F6, probe 1: the `?format=` override across **every** Phase 1–3 route and method — **PASS**

The developer swept `/api/user`, `/api/user/<id>` and `/api-token-auth` only. I swept **38
request shapes** (every Phase 1–3 path × every method that reaches it, plus `/health` and a
`/nope/nope` control) × **10 `?format=` values** (absent, `json`, `api`, `xml`, empty, `JSON`,
`html`, `multipart`, and both duplicate orders) × **3 credential shapes** (valid ADMIN, `Token
deadbeef`, none) = **1 140 cells**, all zero-write, all `--path-as-is`.

| Actor | Cells | Status mismatches | v1 status distribution | v2 status distribution |
|---|---|---|---|---|
| ADMIN | 380 | **10** — all `/health` | `{200:84, 400:4, 403:70, 404:188, 405:9, 500:25}` | `{200:94, 400:4, 403:70, 404:178, 405:9, 500:25}` |
| `Token deadbeef` | 380 | **10** — all `/health` | `{200:50, 401:147, 403:10, 404:173}` | `{200:50, 401:157, 403:10, 404:163}` |
| anonymous | 380 | **10** — all `/health` | `{200:59, 400:4, 401:120, 403:10, 404:178, 405:9}` | `{200:69, 400:4, 401:120, 403:10, 404:168, 405:9}` |

**Every status mismatch in all 1 140 cells is `GET /health`** — the v2-only route, **P0-D2**, and
its three actor-dependent answers (anonymous 200 / bad token 401 / ADMIN 200) are themselves the
F3 fail-closed evidence from R2.4-D, reproduced. `/health` is exactly 10 cells per actor, which is
the whole of the delta in each distribution.

The status distributions are not uniform and are not equal to each other — 6 distinct codes,
including 25 500s and 70 403s under ADMIN — so this matrix is not a false green (§R3.10).

What the sweep proves about F6 specifically:

| `?format=` | v1 | v2 | Cells |
|---|---|---|---|
| absent | the route's normal answer | identical | 114 |
| `json` | identical to absent | identical | 114 |
| `xml`, `html`, `multipart`, `JSON` (case-sensitive), empty string | **404 `{"detail":"Not found."}` on every DRF route, before authentication** — including with `Token deadbeef` and anonymous | identical | 570 |
| `api` | **200/403/404/500 as normal, but rendered by `BrowsableAPIRenderer`** | same status, JSON body — **P3-D8** | 114 |
| `format=json&format=xml` | **404** (QueryDict last-value-wins) | identical | 114 |
| `format=xml&format=json` | **the route's normal answer** | identical | 114 |

The two duplicate orders disagreeing with each other, in the same direction on both stacks, is the
cell that proves v2 reads the **last** value the way Django's `QueryDict` does rather than the
first or a merged list.

The **empty** `?format=` is worth calling out: `format=` is `''`, which matches no renderer, so it
is a **404** — not "ignored as absent". v2 agrees on all 114.

### The two non-status differences, both registered

Every remaining mismatch falls in exactly two families, on all three actors:

* **57 / 37 / 37 `HDR`** — 28 per actor are `?format=api`, where v1 answers
  `Content-Type: text/html; charset=utf-8` + `Vary: Accept, Origin, Cookie` and v2 answers
  `application/json` + `Vary: Accept, Origin`. **P3-D8.** The remaining 9 per actor are
  `GET /nope/nope`, where v1's 404 is `Content-Type: text/html` and v2's is `application/json` —
  **D13**; and (ADMIN only) 20 uncaught-500 cells where v1 carries `Content-Type: text/html` for
  its 27-byte page and v2 carries none — **P3-D6**.
* **9 `BODY`** per actor — all `HEAD /api/user`. This is **F9**, below; it is not about `?format=`.

⚠️ One wording gap, not a defect: P3-D8 names `?format=api` and the HTML body, but does not
mention that the browsable renderer also adds **`Cookie` to `Vary`**. Same species, same
registration; worth one clause so a cache-behaviour reviewer is not surprised.

---

## R3.2 — F6, the `Accept` half: 414 cells, **0 status mismatches** — **FIXED**

23 `Accept` values (including the ones that break naive parsers) × 18 request shapes covering
DRF views, the two `@Public()` views, the four plain-Django reset views and a 404 control.

| | v1 | v2 |
|---|---|---|
| status distribution | `{200:192, 400:15, 401:34, 404:40, 405:17, 406:82, 500:34}` | **identical, cell by cell** |

Not a uniform matrix: seven distinct codes, **82 of them 406s**, so the run is visibly doing work.
The decisions that are easy to get wrong, all matching on `GET /api/user` as ADMIN:

| `Accept` | v1 | v2 | Note |
|---|---|---|---|
| absent, `''` (empty header) | 200 JSON 3 005 B | identical | an empty `Accept` is *not* an unacceptable one |
| `*/*`, `*/*;q=0.8`, `application/*` | 200 JSON | identical | |
| `application/xml`, `text/plain`, `nonsense/nonsense` | **406** | **406** | |
| **`*`** (bare star, not `*/*`) | **406** | **406** | `_MediaType` needs a `/`; a lenient parser answers 200 here |
| **`application/`** (empty subtype) | **406** | **406** | |
| **`,,,`** | **406** | **406** | empty items are media types that parse to nothing |
| `application/json;q=abc` | **200** | **200** | an unparsable `q` does **not** 406 |
| `APPLICATION/JSON` | 200 | 200 | case-insensitive |
| `application/json ; charset=utf-8` (space before `;`) | 200 | 200 | |
| `application/json, application/xml` / the reverse order | 200 | 200 | one acceptable type is enough, order irrelevant |
| `application/json;q=0.1,text/html;q=0.9` | **200 JSON** | 200 JSON | DRF's `order_by_precedence` still lands on JSON |
| `text/html`, `text/*`, a real browser's string | 200 **HTML** 15 760 B | 200 JSON 3 005 B | **P3-D8** (body only) |
| `application/json;indent=8` | 200 JSON **6 509 B** | 200 JSON 3 005 B | **P3-D8**, the `indent` clause (body only) |

**The 406 response itself is byte-identical**: `Content-Type: application/json`,
`Vary: Accept, Origin`, `Allow: …`, `X-Frame-Options: SAMEORIGIN`, `Content-Length: 57`,
`{"detail":"Could not satisfy the request Accept header."}`. Only the header *order* on the wire
differs, which is not significant.

`OPTIONS /api-token-auth` (single renderer) **406**s on `text/html` on both, and its `Vary` stays
`Origin` — the asymmetry F4 established did not regress.

### The write cells — negotiation runs before any side effect, with a live positive control

Round 2's F6 was upgraded from "re-word the deviation" to "fix the code" because
`DELETE /api/user/13` + `Accept: application/xml` was a 406-with-no-write in v1 and a
200-with-a-soft-delete in v2. Re-measured on user 8, restoring from the dump around every leg:

| Cell | v1 status | v1 row | v2 status | v2 row |
|---|---|---|---|---|
| `DELETE /api/user/8`, `Accept: application/xml` | **406** | `is_active` unchanged | **406** | **unchanged** |
| `DELETE /api/user/8`, `Accept: text/plain` | **406** | unchanged | **406** | unchanged |
| `DELETE /api/user/8`, `?format=xml` | **404** | unchanged | **404** | unchanged |
| **control** `DELETE /api/user/8`, `Accept: */*` | **200** | `is_active true→false` | **200** | `true→false` |

The control is the point: without it, "the row did not change" is satisfied by a probe that cannot
write at all.

The same shape on the *destructive* `PATCH`, which is a stronger cell because its side effect is a
cascading delete rather than one column — `PATCH /api/user/5` `{"type":"preferences", notifications:
false}` wipes user 5's push subscriptions through `remove_all_subscriptions`:

| Cell | v1 | v2 |
|---|---|---|
| `Accept: application/xml` | **406**, subs **6 → 6**, `notifications` `t → t` | **406**, subs **6 → 6**, `t → t` |
| `Accept: text/plain` | **406**, subs 6 → 6 | **406**, subs 6 → 6 |
| **control** `Accept: */*` | **200**, subs **6 → 0**, `t → f` | **200**, subs **6 → 0**, `t → f` |

⚠️ **My first run of this cell was a false green and I caught it.** I ran both ports without
restoring between them, so v1's `*/*` leg deleted the 6 rows and v2's `*/*` leg then ran against a
user with **0** subscriptions and "agreed" on `0 → 0`. A control that cannot fire is not a control.
Re-run with a restore before **every** leg; the numbers above are from that run. See §R3.10.

### Harness correction — the round-2 restore script was silently dead

`p3/restore-all.sh` is mode **644**. Round 2's scripts invoke it as `bash restore-all.sh`, which
works; my **direct** invocation returned `Permission denied` into a redirected stderr and left the
fixture at 88 subscription rows, and the `snap.sh` diff was the only thing that caught it. Round 3 restores instead from `~/.fondo-parity-dumps/r3/` via a pristine reference database
`fondodev_r3ref` (`r3/restore.sh`), with staging in a `parity_ref` schema so the public-schema
guard hash is untouched. After every write block below, `snap.sh` is **byte-identical to
`snap-r3base.txt`** before the next block starts.

---

## R3.3 — F8: Django's multipart parser, ported — **FIXED**, and two new differences beside it

**832 cells**: 16 `Content-Type` shapes × 13 malformed/edge bodies × 4 endpoints
(`POST /api-token-auth`, `PATCH /api/user`, `POST /api/user/power`, `POST /api/user/birthdates`),
plus 208 more on `POST /api/user/activate/9999` and a set of targeted write cells.

### Round 2's three rows — all three now agree, on **both** endpoints

| `Content-Type` (body = 29 bytes of non-multipart garbage) | `PATCH /api/user` v1 / v2 | `POST /api-token-auth` v1 / v2 |
|---|---|---|
| `multipart/form-data` (no `boundary`) | **500 / 500** | **400 / 400**, identical `{"username":["This field is required."],…}` |
| `multipart/form-data; boundary=` | **400 / 400**, identical `{"detail":"Multipart form parse error - Invalid boundary in multipart: "}` | **400 / 400**, identical |
| `multipart/form-data; boundary=zzz` (non-multipart body) | **500 / 500** | **400 / 400**, identical |

The developer is right that `PATCH /api/user` cannot discriminate: every malformed body is a 500
there whatever the parser did, and the residual on those rows is only **P3-D6** (v1's 27-byte
`<h1>Server Error (500)</h1>` vs v2's empty body). On `/api-token-auth` the serializer names the
fields it received, and the missing-`boundary` row confirms the developer's model exactly: v1 does
**not** error, it hands the view an **empty** `QueryDict`, and v2 does the same.

### The boundary-validity decision — `cgi.valid_boundary` agrees on all 16 shapes

| `boundary` | valid? | v1 | v2 |
|---|---|---|---|
| `zzz`, `"zzz"` (quoted), `BOUNDARY=` (upper-case param), `; charset=utf-8;` before it, `MULTIPART/FORM-DATA` (upper-case type) | yes | parses | parses |
| `" zzz"` — **leading** space | **yes** (`^[ -~]{0,200}[!-~]$` permits it) | parses | parses |
| 200 × `a` | yes | parses | parses |
| **201 × `a`** | **yes** — the limit really is 201, not 200 | parses | parses |
| **202 × `a`** | no | rejects | rejects |
| `"zzz "` — **trailing** space | no (last byte must be `!-~`) | rejects | rejects |
| `"a<TAB>b"` | no | rejects | rejects |
| empty | no | rejects | rejects |
| absent | *not an error* | empty `QueryDict` | empty `QueryDict` |
| `boundary=zzz; boundary=www` (duplicated) | first wins | parses with `zzz` | identical |
| `multipart/mixed; boundary=zzz` | n/a | **415** | **415** |

The 201/202 pair is the cell that pins the off-by-one, and both stacks fall the same way.

### The two widenings — closed, and the thresholds are exact

| Body | v1 | v2 |
|---|---|---|
| **1 000** fields | 400, the normal serializer body | **identical** |
| **1 001** fields (`TooManyFieldsSent`) | **400** `<h1>Bad Request (400)</h1>` | **400** `{"message":"Bad Request"}` — **D13** |
| a single field of **2 621 440** bytes (`RequestDataTooBig`) | **400** `<h1>Bad Request (400)</h1>` | **400** `{"message":"Bad Request"}` — **D13** |
| a single field of 2 621 441 bytes | 400 | 400 |

Both stacks flip between 1 000 and 1 001 and both refuse at exactly `DATA_UPLOAD_MAX_MEMORY_SIZE`.
Status matches; the body is D13's species.

### Probe 2 (the developer's) — multipart on the two `@DrfNoRequestData` routes

| Route | Cells | Result |
|---|---|---|
| `POST /api/user/birthdates` | 208 | **208/208 byte-identical 200s.** The handler never touches `request.data`, so every malformed multipart — no boundary, 202-byte boundary, tab, non-ASCII, truncated parts, LF-only line endings — is completely invisible on both stacks. The marker and the new parser do not interact. |
| `POST /api/user/activate/9999` | 208 | 196/208 identical (124 × 404, 60 × 400, 12 × 415). The 12 that differ are the non-ASCII boundary — **F10**, below, not the marker. |
| `POST /api/user/power` | 208 | status identical on all 208 (all 500 — `UserAppsView`'s bare `except Exception`), **72 body/header differences** — **F12**, below. ⚠️ A 208-cell matrix that is uniformly 500 on both sides is the same bad probe as `PATCH /api/user`; the finding here came from the *headers*, which the status comparison would have missed. |

### 🔴 **NEW: F10** — a **non-ASCII** `boundary` is the fourth place Django raises something that is not a `MultiPartParserError`

| Request | v1 | v2 |
|---|---|---|
| any body, `Content-Type: multipart/form-data; boundary="a\x80b"` | **500**, gunicorn's 141-byte `<html>…Internal Server Error…</html>` page, **no `Allow`, no `Vary`** | **400** `{"detail":"Multipart form parse error - Invalid boundary in multipart: a\x80b"}` |

**13 cells on `/api-token-auth`, 12 on `PATCH /api/user`, 12 on `POST /api/user/activate/<id>`, 12
on `POST /api/user/power` — 49 in total, every body shape, stable across repeats.** v1's traceback,
from the live oracle:

```
File ".../django/http/multipartparser.py", line 69, in __init__
  ctypes, opts = parse_header(content_type.encode('ascii'))
UnicodeEncodeError: 'ascii' codec can't encode characters in position 32-33: ordinal not in range(128)
```

`MultiPartParser.__init__` calls `content_type.encode('ascii')` on **line 69**, *before* it reaches
`valid_boundary` on line 72. A `UnicodeEncodeError` is not a `MultiPartParserError`, so DRF does not
convert it to a 400 — it escapes as an uncaught 500. The port implements `valid_boundary` faithfully
(the 201/202 rows above prove it) but not the `encode('ascii')` guard that precedes it.

Same species as F8, same severity (**low** — malformed request, no data at risk, no v1 client sends
a non-ASCII boundary), and the same routing: `nestjs-developer` to match v1's 500, or
`business-analyst` to register the residual once for every multipart endpoint in Phases 4–8.

### 🔴 **NEW: F11** — file parts are not merged into `request.data`, and it **changes a write**

Django's `MultiPartParser` puts a part carrying a **non-empty** `filename` into `request.FILES`;
DRF's `Request.data` is the merge of `QueryDict` **and** `FILES`, so a view reading
`request.data['x']` sees an `UploadedFile`. v2's ported parser keeps files out of `data`.

| Request | v1 | v2 |
|---|---|---|
| `POST /api-token-auth`, `username` sent as a part with `filename="a.txt"` | 400 `{"username":["Not a valid string."],"password":["This field is required."]}` | 400 `{"username":["This field is required."],…}` |
| both fields sent as file parts | 400 `{"username":["Not a valid string."],"password":["Not a valid string."]}` | 400 both `["This field is required."]` |
| `filename=""` (**empty** filename) — Django treats it as an ordinary field | 400 `{"non_field_errors":["Unable to log in with provided credentials."]}` | **identical** — the empty-filename rule is ported correctly |
| `PATCH /api/user`, the TSV as a part **with** `filename` | **200**, finance rows written | **200**, identical rows |
| `PATCH /api/user`, the same bytes as a part **without** `filename` | **500** (`str` has no `.decode`) | **500** | 

**And the write cell.** `create_user` reads `obj['first_name']` out of `request.data` with no
serializer, so an `UploadedFile` lands in a `CharField`:

```
POST /api/user   Content-Type: multipart/form-data; boundary=zzz
  identification=555000111  role=3  last_name=FileProbe  email=fileprobe@nowhere.test
  first_name: a part with filename="a.txt" and body "Bob"
```

| | v1 | v2 |
|---|---|---|
| status | **201 Created** | **500** |
| `auth_user` | **15 → 16** | **15 → 15** |
| the row | `30 \| a.txt \| FileProbe \| fileprobe@nowhere.test` — `first_name` is the **filename**, not the content | *(no row)* |
| SES | activation mail sent | none |

v1 creates a member whose first name is `a.txt` and emails them; v2 refuses. v2 is the safer side,
but this is a **status change (201 → 500) and a row that exists on one stack and not the other**,
which is the risk class F6 was escalated for. Severity **low–medium**: no real client sends a
`filename` for a scalar field, but it is unregistered and it is on a write path. For
`business-analyst` (is DRF's `FILES`-into-`data` merge in scope?) then `nestjs-developer`.
Restored; `snap.sh` back to baseline.

### 🔴 **NEW: F12** — on `UserAppsView`, v1's *error logger* double-faults and loses `Allow` / `Vary`

`UserAppsView.post` wraps everything in `except Exception: return Response(status=500)`, so a
`MultiPartParserError` is caught and answered as a **DRF** 500 — which, per **F1**, must keep
`Allow` and `Vary: Accept`. It does not, because Django's `log_response` then renders the traceback,
`get_post_parameters` re-reads `request.POST`, and the parser raises **again**, this time outside
Django's exception handling:

```
POST /api/user/power   (ADMIN)   body = 29 bytes of garbage
  Content-Type: multipart/form-data; boundary=zzz     v1  500  Allow: POST, OPTIONS  Vary: Accept, Origin  len 0
                                                      v2  500  Allow: POST, OPTIONS  Vary: Accept, Origin  len 0   OK
  Content-Type: application/json                      v1  500  Allow + Vary  len 0
                                                      v2  500  Allow + Vary  len 0                                 OK
  Content-Type: multipart/form-data       (no bdry)   v1  500  Content-Type: text/html  len 141  NO Allow, NO Vary
                                                      v2  500  Allow: POST, OPTIONS  Vary: Accept, Origin  len 0    ***
  Content-Type: multipart/form-data; boundary=        v1  500  Content-Type: text/html  len 141  NO Allow, NO Vary
                                                      v2  500  Allow: POST, OPTIONS  Vary: Accept, Origin  len 0    ***
```

The 141-byte page is **gunicorn's**, not Django's 27-byte one — the request never produced a Django
response at all. It fires for the six boundary shapes v1's parser rejects (absent, empty, 202-byte,
trailing space, tab, non-ASCII) × 12 of the 13 bodies = **72 cells**, and only on `UserAppsView`,
because it is the only Phase 3 view with a bare `except Exception` around a `request.data` read.

This is **F1's axis** — who built the response, therefore which headers survive — reopened by a path
F1 could not have reached, because F1 was probed with JSON bodies. It is **not a regression**: v2's
answer is the *correct* DRF-caught-500 shape and has not changed. It is v1 that is anomalous, and
v1 is the oracle. Severity **low**. For `business-analyst`: the honest registration is *"where
Django's own 500 logger re-enters the failing parser, v1 answers with the WSGI server's page and no
DRF headers; v2 answers with the DRF caught-500 shape"*.

---

## R3.4 — R2.11.5, the coverage gap — **CLOSED**, and correct at both token lengths

`b456cbe` adds the missing cell to `test/password-reset.e2e-spec.ts` with **two positive controls
in the same test** (the correct body token and the empty one, both asserted 302), so the 403 cannot
pass because the fixture is broken. Re-measured live against the oracle, at the 32-character token
round 2 used **and** at the 64-character one the test uses (64 alphanumeric characters is a
different `_sanitize_token` branch — it is accepted as a masked token and unsalted, so it must reach
the *comparison* and fail there, not be rejected for its shape):

| `POST /password_reset/`, valid `X-CSRFToken`, valid cookie | v1 | v2 |
|---|---|---|
| `csrfmiddlewaretoken=` **32 × `z`** | **403**, 1 019-byte `REASON_BAD_TOKEN` page | **403**, 1 019 bytes |
| `csrfmiddlewaretoken=` **64 × `z`** (the test's value) | **403**, 1 019 bytes | **403**, 1 019 bytes |
| `csrfmiddlewaretoken=` **empty** (control) | **302** | **302** |
| `csrfmiddlewaretoken=` the correct token (control) | **302** | **302** |

Both lengths land on the same page, so the added cell is testing the comparison and not the
sanitiser. The gap is closed.

---

## R3.5 — rounds 1–2 coverage, re-proved after the middleware and parser changes

A new middleware now sits in front of both guards and the body parser was replaced, so everything
round 2 measured was re-run rather than carried forward.

| Check | Cells | Round 3 result |
|---|---|---|
| **F1** — the caught 500 keeps `Allow` + `Vary: Accept` | 22 | **unchanged.** 9 `UserAppsView` inputs → `500` + `Allow: POST, OPTIONS` + `Vary: Accept, Origin` on both (one of the 9 is a 200 and one a 35-byte 200 — the matrix is not uniform); 7 uncaught 500s correctly drop both on both sides, residual = **P3-D6** (`Content-Length: 27` + `Content-Type: text/html` vs `0` and none); 6 controls (401 ×2, 403, 400, 200, 400) byte-identical |
| **F2** — the 302 header set | 6 | **unchanged.** All six routes into a 302: `Content-Length: 0`, `Content-Type: text/html; charset=utf-8`, `Location`, `Vary: Origin`, `X-Frame-Options: SAMEORIGIN` — identical. The `APPEND_SLASH` 301 still carries no `Vary` on either |
| **F3** — the `@DjangoView()` exemption | 409 | **380 OK / 29 DIFF, and all 29 are body-size only**: 26 are the 404 page (**D13**, 77 B vs 23 B) and 3 are `/health` (**P0-D2**). Every one of the 280 A-group cells (5 URLs × 7 methods × 8 `Authorization` shapes) is status- and size-identical; the 84 DRF-route cells are all 401 on both |
| **F3 fail-closed 3, redone with `--path-as-is`** | 36 | **36/36 status-identical.** ⚠️ `p3/r2-f3.sh` does **not** pass `--path-as-is`, so its dot-segment rows are round 2's R2.11.3 false green *still in the script* — `/api/../password_reset/` and `/./password_reset/` read 200/200 there. Re-run with the raw target on the wire, every dot-segment, doubled-slash, `%2e`, `%00` and `;`-param shape is **404 on both**, and a bad token never turns any of them into a 401 |
| **F4** — the two `OPTIONS` metadata documents | 4 | **byte-identical**, both, including the asymmetric `Vary` (`Accept, Origin` vs `Origin`); both still 401 on a bad token |
| **F5 / F2** — the CSRF matrix | 44 | **44/44 identical**, including all four discriminating cells (`POST-badbody-goodhdr` 403, `POST-emptybody-goodhdr` 302, `PUT-badbody-goodhdr` 302, `POST-goodbody-badhdr` 302) and **`POST-multipart` 302** — the new parser still populates `request.POST` for the CSRF read, which was the single riskiest interaction between F5 and F8. The one "DIFF" the script prints, `safe-GET`, is byte-identical after masking the per-render `csrfmiddlewaretoken` (1 324 B both) |
| **The 72-cell D1 matrix**, restore-from-dump around every leg | 72 | **identical to round 2, cell for cell.** 23 byte-identical / 16 same-status-and-rows with only **P3-D6** in the body (the sole distinct body pair in the whole matrix is `('<h1>Server Error (500)</h1>', '')`) / 33 `v2 403 where v1 acted` (**D1 / D16 / P3-D1**) / **0 unexplained**. Positive controls: `v1 {200:41, 409:7, 500:24}`, `v2 {200:22, 403:33, 409:1, 500:16}`, **zero 401s**, v1 wrote rows in 32 cells and v2 in 16 |
| **The two destructive side effects** | 8 | `notifications` true→false wipes user 5's **6** subscriptions (94 → 88) on both; the control (stays true) writes nothing on both; a `personal` echo **with** `birthdate` deletes the owner's **8** scheduler rows and creates 1 (626 → 619) on both; the control (key removed) leaves 626 on both |
| **The birthday `SchedulerTask`, field by field** | 1 | **byte-identical** across `type`, `run_date`, `repeat`, `processed` and `payload::text`: `0 / 2026-08-25 05:00:00+00 / 4 / false / "type"=>"birthdate", "target"=>"/", "message"=>"Hoy está cumpliendo años N@CHO Montañez Herrera", "owner_id"=>"5", "user_ids"=>"[10, 6, 7, 12, 14, 9, 1, 13, 11, 8, 2, 4]"`. The `user_ids` order differs from round 2's — it is Postgres's *current* heap order, which the restore rewrote — and **both stacks still produce the same one**, which is the actual assertion |
| **`create_user`, four tables + rollback** | 2 | `201`; `auth_user`/`profile`/`finance`/`preference` 15→16 each, `authtoken_token` **15→15**, sequence 29→30; the four rows `cmp`-identical. SES `fail`: **409** `{"message":"Invalid email"}`, **0 rows** in all four, sequence still advanced. Identical on both |
| **SES, envelope *and* body, field by field** | 3 mails | **activation** 8/8 form fields equal, only the random `key_activation` in the URL differs; **password reset** 8/8 equal, only the random token differs; **power approval** 7 fields equal (`Source`, both `Charset`s, `Subject.Data`, `Body.Html.Data`, `Action`, `Version`) and **26 differ — the same 13 addresses in the same order, moved from `Destination.ToAddresses.member.N` to `Destination.BccAddresses.member.N`. That is D5 exactly, and nothing else** |
| **SQS `MessageBody`** | 1 | `POST /api/user/power` for requestee **5** (6 subscriptions — requestee 4 has none and is the probe that cannot see SQS): **2 391 bytes, byte-identical**, 1 capture on each side |
| **The TSV bulk update** | 18 | 7 payloads → rows `cmp`-identical (banker's rounding `100.5→100 … 5.5→6`, `available_quota` −200 on user 1, unknown identification skipped, non-numeric → 500 and full rollback, blank line → 500); `last_modified` no-op holds on both (`2026-08-12` unmoved); content-type matrix 4/4; role matrix ADMIN 200 / TREASURER 200 / PRESIDENT 403 / MEMBER 403 |
| **All 13 distinct `Vary` shapes** | 13 | **identical**, including `Cookie, Origin` on the reset form and **`Origin, Cookie`** — the other order — on the set-password page, and **no `Vary` at all** on the `APPEND_SLASH` 301 |
| **The five reset pages, byte for byte** | 5 | **identical**: 1 265 / 966 / 779 / 1 001 / 1 001 |
| **Both CSRF failure pages** | 2 | **identical**: 1 019 (`REASON_BAD_TOKEN`) / 1 386 (`REASON_NO_CSRF_COOKIE`) |
| **URL sweep**, 33 paths × 6 methods, `--path-as-is`, **restore around every unsafe cell** | 198 | **29 mismatches, all expected**: 28 are later-phase routes v1 serves and v2 404s, 1 is `/health`. **Every Phase 1–3 path matches on every method**, and v2 serves no path v1 does not. Distributions `v1 {200:17, 301:12, 400:4, 403:68, 404:73, 405:12, 500:12}` / `v2 {200:14, 301:12, 400:2, 403:50, 404:100, 405:12, 500:8}` — 7 codes, not uniform |
| **`ALLOWED_HOSTS`** | 24 | identical except the three `/health` rows. `Host: evil.test` is **400 on every path on both** — C19 holds |
| **Bare `OPTIONS` vs preflight** | 14 | identical, 7/7 both ways |
| **Pagination envelope** | 8 | identical, including `page=99` → **200** `{"list":[],"num_pages":2,"count":13}`, `page=0`/`-1` → 400 `{"message":"Page number must be greater than 0"}`, and `?page=1&page=2` taking the **last** value. `?page=abc` is 500 on both, body = **P3-D6** |
| **`DELETE /api/user/<id>`** role matrix, unknown id, re-delete | 6 | identical: ADMIN 200 + `is_active false`, PRESIDENT/TREASURER/MEMBER 403 + row untouched, unknown id 404, re-delete of an already-inactive user 200 |
| **D14 `-1` sentinel** | 3 | `GET` 200/200, `DELETE` 404/404, `PATCH` **v1 404 / v2 200** — **D14 as registered** |
| **D15 / P3-D2**, shared-email account 13 | 1 | `PATCH` name → **v1 409 / v2 200** — as registered |

**Nothing regressed.** The two changes most likely to have broken something did not: the content-
negotiation middleware runs before both guards without disturbing any of the 409 F3 cells or the 44
CSRF cells, and replacing multer with the ported parser left the CSRF body read, the TSV upload and
`create_user`'s multipart path behaving exactly as round 2 recorded.

---

## R3.6 — 🔴 **NEW: F9** — v1 returns an entity body on `HEAD`; v2 does not

Rounds 1 and 2 never sent a `HEAD` request. `HEAD` is in `/api/user`'s `Allow` list on both stacks,
so it is a reachable method.

Measured on a **raw socket**, not curl (`curl -X HEAD` is itself a probe hazard: it expects a body
and will report one whether or not the server sent it):

```
HEAD /api/user HTTP/1.1
Host: localhost
Authorization: Token <ADMIN>
Connection: close
```

| Route | v1 (gunicorn 19.9.0) | v2 (Node http) |
|---|---|---|
| `/api/user` | `403`, `Content-Length: 63`, **63 bytes of body** | `403`, `Content-Length: 63`, **0 bytes** |
| `/api/user/-1`, `/api/user/9999`, `/api/user/power`, `/api/notification/subscribe` | `403`, `CL: 63`, **63 bytes** | `403`, `CL: 63`, **0** |
| `/api-token-auth` | `405`, `CL: 41`, **41 bytes** | `405`, `CL: 41`, **0** |
| `/password_reset/` | `200`, `CL: 1324`, **1 324 bytes** | `200`, `CL: 1324`, **0** |
| `/password_reset/done/`, `/reset/done/`, `/reset/<uid>/set-password/` | `200`, full page body | `200`, **0** |
| `/nope/nope` | `404`, `CL: 77`, **77 bytes** | `404`, `CL: 23`, **0** |

**11 of 11 routes.** Status and `Content-Length` agree everywhere — the *only* difference is that
v1 writes the entity body after the headers and v2 does not.

RFC 9110 §9.3.2 says a `HEAD` response "MUST NOT" have content; **v1 is the non-conformant side**,
and this is a property of gunicorn 19.9.0's WSGI writer rather than of any application code (it
holds identically on the DRF routes, the plain-Django reset routes and the 404 handler). Every
conformant client and every intermediary discards it, and a proxy in front of v1 would strip it
before a real client saw it.

Severity **very low**, and almost certainly a **registration** rather than a fix — but it is an
observable byte-level difference on an implemented Phase 3 route that no deviation covers, so §7
requires it to be filed. For `business-analyst`; if it is registered, one line noting that the
`Content-Length` still matches is worth having, because that is what a client actually reads.

---

## R3.7 — where the new middleware sits: ordering probes

The F6 middleware is new and sits between the URL resolver and body parsing, in front of both
guards. Six ordering questions, all zero-write, all matching:

| Question | Request | v1 | v2 |
|---|---|---|---|
| Does `ALLOWED_HOSTS` beat negotiation? | `Host: evil.test` + `Accept: application/xml` on `/api/user` | **400** | **400** |
| … and the `?format=` override? | `Host: evil.test` + `?format=xml` | **400** | **400** |
| Does negotiation beat the trailing-slash resolution? | `/api-token-auth/` + `Accept: application/xml` | **406** | **406** |
| … and `?format=`? | `/api-token-auth/?format=xml` | **404** | **404** |
| Does an unresolved path negotiate at all? | `/nope/nope` and `/api/user/power2` + `Accept: application/xml` | **404** (not 406) | **404** |
| Do the plain-Django views ignore both? | 4 `Accept` values × `GET`/`POST` on `/password_reset/`, and 4 `?format=` values | 200 / **403** (CSRF), unaffected by either | **identical, 12/12** |

The `/api-token-auth/` pair is the sharpest: the same URL answers **406** under `Accept` and **404**
under `?format=`, and v2 reproduces both. `ALLOWED_HOSTS` first, then resolution, then negotiation,
then authentication, then permissions, then the handler — v1's order, reproduced.

---

## R3.8 — what I could not test

| Not tested | Why | Who can close it |
|---|---|---|
| **`@DjangoView()` on a controller whose URL entry is a DRF view** | Unchanged from R2.12 — needs a source change; the three reachable fail-closed directions are re-proved above | `nestjs-reviewer` (unit tests) |
| **v1's browsable-API HTML rendered by v2** | P3-D8, by design. I measured the *decision* (status, `Vary`, `Content-Type`) on all 114 `?format=api` cells; the HTML itself is not produced by v2 | n/a — registered |
| **v2's scheduler / worker** | Phase 7b; v2 has no scheduler process. I verified the `SchedulerTask` **row**, not its execution | Phase 7b |
| **Real SES / SQS** | Both stacks pointed at the local capture server (`:4599` / `:4598`); `0` `ECONNREFUSED` in v2's log confirms every call was captured and none escaped. Credentials, throttling, bounces out of reach | integration environment |
| **v1's Celery loss semantics under broker failure** | P2-D7. Happy path only: the worker consumed every `send_notification` and logged `Message sent, id: 1111…` | Phase 2's owner |
| **D19 (29 Feb), D20 (soft-deleted member), D11 (duplicate child rows)** | Still need row injection. **Round 1's evidence stands unrefreshed for a second round.** Nothing in F6/F8/R2.11.5 goes near the birthdate clamp or the `UserFinance`/`UserPreference` lookup, but this is now two rounds old and should be re-run before the phase is signed off | a later round, or an explicit acceptance by `nestjs-reviewer` |
| **The `POST /api/file` and loan-detail multipart paths** | Not implemented in v2 (404). F10 and F11 will both recur there, which is why they are worth registering once now rather than per endpoint | Phases 4–8 |
| **`POST /api/alexa`, `GET/POST /api/authorize`** | Out of scope by instruction | — |

---

## R3.9 — system health

| Check | Result |
|---|---|
| v1 boots | ✅ `fondo-v1-p3`, gunicorn 19.9.0, `api.settings.production`, `fondodev`; the shimmed oracle on `127.0.0.1:8451` answered every cell |
| v1 repo untouched | ✅ `git status` clean at `5bef585`; the mount is `ro` |
| v2 boots | ✅ `node dist/main.js`, 21 routes mapped, Prisma connected, `production`, `ALLOWED_HOST_DOMAIN=localhost` |
| v2 build current | ✅ `npm run build` re-emitted `dist/` byte-identical (`2014eb8f8133d19592730f8fdbcdd61b`); tree clean at `cc320a4`, whose code content is `b456cbe` |
| lint | ✅ `npm run lint` clean. ⚠️ My first probe was `npx eslint .`, which fails on `prisma.config.ts` (outside the tsconfig project) — a **false red of my own**, not a defect; the project's own script is the correct probe |
| typecheck | ✅ `tsc --noEmit` clean |
| unit | ✅ **1 602 passed / 53 suites** (round 2: 1 503 / 49) |
| e2e | ✅ **699 passed, 1 skipped / 15 suites** (round 2: 647 / 13) |
| e2e isolation | ✅ `snap.sh` on `fondodev` is **byte-identical before and after the whole e2e run**, every line |
| migrations / schema untouched | ✅ `django_migrations` **38**; `_prisma_migrations.0_init` `applied_steps_count = 0` (marked, never executed); the `information_schema.columns` fingerprint is **`226e4aef963f79b0e1a4704e12ec3b77`** at the open and the close of the round, and `snap.sh`'s schema / constraint / index hashes (`613a748c…` / `6dc19981…` / `fbacaf14…`) are equal to baseline. **24 tables in `public` on both the live database and the pristine dump; no stray schema.** Prisma has not touched the schema Django owns |
| **whole-database integrity, final** | ✅ not just the Phase 3 tables — a content `md5` of **every one of the 24 tables** is byte-identical to the pre-round `pg_dump`. This matters because the URL sweep sends `POST`/`DELETE` at later-phase v1 routes (`DELETE /api/activity/5/` answered **200** on v1) and my restore covers only Phase 3 tables; the whole-DB hash proves none of those cells actually wrote |
| fixture integrity, final | ✅ `snap.sh` identical to `snap-r3base.txt` on every line: `auth_user` 15 / `eb2217b4…`, `userprofile` `279ef0f6…`, `userfinance` `8ec339bd…`, `userpreference` `94e8bc42…`, `power` 20 / `002cbae3…`, `authtoken_token` 15 / `36770022…`, `notificationsubscriptions` **94 / max-id 1468 / xmin-distinct 1** / `7a6afbcc…`, `schedulertask` **626 / `c3bf5409…`**, `django_session` 20, sequences 29 / 2528 |
| scheduler / worker | ✅ redis 7 + `celery -A api worker` consumed every `send_notification` (`Message sent, id: 1111…`); v2 publishes inline. v2 has no scheduler process (Phase 7b) |
| SES / SQS | ✅ 100 % captured locally; **`0` `ECONNREFUSED` in v2's log**, so no call escaped to real AWS |
| stray writes | ✅ none. Every `ERROR` in v2's log is a deliberate 500-producing probe (`PythonTypeError: EmptyPage` on `page:0`, the `{}` bodies), mirroring v1's 500 on the same input |
| fixture incidents | **one, caught and reversed** — see R3.2: a missing restore between the two legs of the destructive-`PATCH` cell killed that cell's positive control. No residue; caught by the `snap.sh` diff, not by the cell's own result |
| test artifacts left behind | the pristine reference database **`fondodev_r3ref`** was dropped at the end of the round; it is one command to rebuild from `~/.fondo-parity-dumps/r3/r3-pre-FULL-20260903111849.sql` |

---

## R3.10 — the continued false-green sweep: **four** more instances, three of them mine

The register in `MIGRATION_PLAN.md` §7 stands at eight. This round adds four.

### 9. 🔴 The `:8450` instance I was handed was half-configured — and it would have produced a **false pass**, not a false fail

Instance #8 (the developer's) was a missing `ALLOWED_HOST_DOMAIN` producing a uniform 400. Mine is
the same class with the opposite sign and it is harder to see: the running v2 had
`ALLOWED_HOST_DOMAIN` set — so every status matched — but `NOTIFICATIONS_QUEUE_URL` pointed at
**real AWS SQS** and there were no `AWS_ENDPOINT_URL_SES` / `AWS_ENDPOINT_URL_SQS`, `HOST_URL_APP`
or `TZ_NAME`. Under that configuration:

* every SES probe would have failed against real AWS, so `create_user`'s **rollback would have
  fired for the wrong reason** and the "rolls back to zero rows" cell would have passed while
  testing nothing;
* the SQS `MessageBody` comparison would have found **no capture on v2** and reported "identical"
  the way round 2's requestee-4 probe did;
* the birthday `SchedulerTask`'s `05:00:00+00` depends on `TZ_NAME=America/Bogota`.

**Countermeasure:** the harness should assert its own wiring before the first cell — that the
capture server received *something* from each stack, and that v2's `AWS_ENDPOINT_URL_*` resolve to
the capture port. `0 ECONNREFUSED` in v2's log is the cheap version of that assertion and is now in
R3.9.

### 10. 🔴 My destructive-`PATCH` cell ran both legs without restoring between them

`PATCH /api/user/5 {"type":"preferences", notifications:false}` deletes the user's 6 push
subscriptions. I ran v1 then v2 without a restore, so v1's `Accept: */*` leg deleted all 6 and v2's
`Accept: */*` **control** then ran against a user with **0** subscriptions and reported `0 → 0`.
Both the 406 rows and the control "agreed". A control that cannot fire is not a control; the
correct reading was "this probe can no longer see the side effect". Fixed by restoring before
**every** leg — the corrected run is in R3.2 and shows `6 → 0` on both.

### 11. 🔴 `p3/restore-all.sh` fails silently when invoked directly, and `p3/r2-f3.sh` still has round 2's `--path-as-is` bug

Two latent harness defects carried over from round 2:

* `restore-all.sh` is mode **644**. The round-2 scripts invoke it as `bash restore-all.sh`, which
  works; my direct `$S/restore-all.sh` returned `Permission denied` into a redirected stderr and
  the fixture was left at 88 subscription rows. Only the `snap.sh` diff caught it. **A restore
  helper must fail loudly** — `set -e` plus an unredirected exit status, and a post-condition check.
* `r2-f3.sh` does **not** pass `--path-as-is`, so its dot-segment cells (`/api/../password_reset/`,
  `/./password_reset/`, `/password_reset/./`) still read **200 / 200** — curl is collapsing them
  before the request leaves the client. Round 2 identified this and fixed it *in an ad-hoc run*,
  not in the committed script, so it re-fired this round. Re-run with `--path-as-is`, all 36 cells
  404 on both (R3.5). **A fix to a probe has to land in the probe.**

### 12. 🟠 A uniform matrix is still a bad probe, even when it is uniformly *not* an error

`POST /api/user/power` answers **500 to all 208 malformed-multipart bodies on both stacks**, and
`POST /api/user/birthdates` answers **200 to all 208**. Neither can distinguish two parser stacks
on status alone — the same defect the developer correctly identified in `PATCH /api/user`. The
birthdates matrix is still worth running (it is the *evidence* that `@DrfNoRequestData` makes the
parser invisible), but its 208 green cells prove that and nothing else. **F12 was only found
because the comparison included the header set**, not just the status. Comparison harnesses in this
project should compare status **and** the header set **and** the body, and say which of the three
differed — a status-only matrix on an endpoint that swallows everything is decoration.

### 13. 🟢 Harness controls that did fire

Run before trusting any of the above: v1-vs-v1 on the identical request → **identical** (the
harness is not noisy); v1-vs-v1 on a deliberately different request → **flagged** (it is not
blind); a seeded header-set-only difference → **flagged**; a seeded status-only difference →
**flagged**. Every matrix in this round also prints its status distribution, and none of them is
uniform: the format sweep shows 6 codes, the `Accept` matrix 7 (including 82 `406`s), the D1 matrix
4 with zero `401`s, the URL sweep 7.

Also: my `npx eslint .` "failure" in R3.9 was a **false red of my own** — the wrong probe, not a
defect. Recorded because a false red costs the same time as a false green and this round produced
one of each.

---

## R3.11 — verdict

### F1–F8 and the coverage gap: **all closed**

| # | Filed | Status this round | Evidence |
|---|---|---|---|
| **F1** | the caught 500 lost `Allow` / `Vary: Accept` | ✅ **fixed, not regressed** | 9 caught-500 inputs keep both; 7 uncaught correctly drop both; 6 controls identical. ⚠️ but see **F12** — a path F1 never probed |
| **F2** | the 302s omitted `Content-Type` | ✅ **fixed, not regressed** | 6 routes into a 302, byte-identical header sets |
| **F3** | v2 authenticated the plain-Django views | ✅ **fixed, fail-closed** | 409 cells; 380 identical, 29 body-size-only (**D13** / **P0-D2**); 36/36 look-alike targets re-run with `--path-as-is` |
| **F4** | bare `OPTIONS` 405'd | ✅ **fixed, not regressed** | both metadata documents byte-identical with the correct asymmetric `Vary`; both still 401 a bad token |
| **F5** | the CSRF token was read from the body on every unsafe method | ✅ **fixed, not regressed** | 44/44, including the four discriminating cells and `POST-multipart` under the **new** parser |
| **F6** | v1 negotiates content **before** authentication — `406` for an unacceptable `Accept`, `404` for an undeclared `?format=` | ✅ **FIXED** | 414 `Accept` cells with **0** status mismatches and 82 `406`s; **1 140** `?format=` cells across every Phase 1–3 route × method × 3 credential shapes with **0** status mismatches outside `/health`; the write cells refuse before the side effect on both, with live positive controls (`DELETE` `true→false`, `PATCH` subs `6→0`) |
| **F8** | malformed multipart crossed the 400/500 line both ways | ✅ **FIXED** | all three round-2 rows agree, on both a discriminating and a non-discriminating endpoint; the boundary-validity decision agrees on all 16 shapes including the 201/202 off-by-one; both widenings closed with exact thresholds (1 000/1 001 fields, 2 621 440 bytes) |
| **R2.11.5** | the missing F5 e2e cell | ✅ **CLOSED** | added with two positive controls; correct live at both 32- and 64-character wrong tokens, 1 019-byte page on both |
| ~~F7~~ | power mail `To` vs `Bcc` | — | withdrawn in round 2; re-confirmed as **D5** field by field this round |

### New this round

| # | Finding | Severity | For |
|---|---|---|---|
| **F9** | **v1 returns an entity body on `HEAD`; v2 does not.** 11/11 routes, raw socket. Status and `Content-Length` always agree. v1 is the RFC-non-conformant side and the cause is gunicorn's WSGI writer, not application code | very low | `business-analyst` — register |
| **F10** | **A non-ASCII `boundary` is a fourth place Django raises something that is not a `MultiPartParserError`.** `MultiPartParser.__init__` line 69 does `content_type.encode('ascii')` *before* `valid_boundary` on line 72, so a `UnicodeEncodeError` escapes as an uncaught **500** (gunicorn's 141-byte page) where v2 answers **400** with a parse-error detail. 49 cells across four endpoints | low | `business-analyst` to register, or `nestjs-developer` to match — it will recur on every multipart endpoint in Phases 4–8 |
| **F11** | **File parts are not merged into `request.data`, and it changes a write.** DRF merges `QueryDict` + `FILES`; v2 keeps files out of `data`. On `POST /api/user` with a scalar field sent as a part carrying `filename="a.txt"`, **v1 answers 201 and creates a member whose `first_name` is `a.txt`** (plus the activation mail); **v2 answers 500 and creates nothing**. The empty-`filename` rule is ported correctly and the real TSV path is unaffected | low–medium (a row that exists on one stack and not the other) | `business-analyst` first (is the `FILES`-into-`data` merge in scope?), then `nestjs-developer` |
| **F12** | **On `UserAppsView`, v1's own 500 logger re-enters the failing parser and the response loses `Allow` / `Vary`.** For the six boundary shapes v1 rejects, `POST /api/user/power` answers 500 with **gunicorn's** page and neither header; v2 answers the correct DRF caught-500 shape with both. F1's axis, reached by a path F1 could not have probed. **v2 is the well-behaved side and has not changed** | low | `business-analyst` — register the residual |

### Verdict by endpoint

| Endpoint | Round 3 |
|---|---|
| `GET /api/user` | **PASS** — pagination envelope, both 400s, `?page=abc` 500 header set, all 13 `Vary` shapes identical |
| `POST /api/user` | **DEVIATION (F11)** — four-table write, rollback-to-zero and the SES envelope all identical; a scalar field sent as a *file* part is 201-and-a-row on v1, 500-and-nothing on v2 |
| `PATCH /api/user` (TSV) | **PASS** — F8 closed. Rounding, `last_modified` no-op, unknown-identification skip, rollback and role matrix identical; the residual on malformed bodies is **P3-D6** only, except F10's non-ASCII boundary |
| `GET /api/user/<id>` | **PASS** |
| `PATCH /api/user/<id>` | **PASS with the registered D1/D14/D15/D16/D19/D20/P3-D1/P3-D2 divergences** — 72 cells in exactly three classes, none unexplained; both destructive side effects reproduced |
| `DELETE /api/user/<id>` | **PASS** — including the F6 write cell (406 before the soft delete, with a control that proves the delete works) |
| `POST /api/user/birthdates` | **PASS** — 208/208 under every malformed multipart |
| `POST /api/user/power` | **DEVIATION (F12)** — status identical on all 208 malformed-multipart cells and on the whole F1 matrix; the header set differs on the six boundary shapes v1 rejects, because v1's logger double-faults. SQS `MessageBody` byte-identical; the approval mail is **D5** |
| `POST /api/user/activate/<id>` | **PASS** — F4 and F6 closed; 196/208 multipart cells identical, the 12 are F10 |
| `POST /api-token-auth` | **DEVIATION (F10, F11)** — 192/208 multipart cells identical; the two families are the non-ASCII boundary and the file-part merge |
| `GET\|POST /password_reset/` | **PASS** — F2/F3/F5 closed, R2.11.5 closed, and negotiation correctly ignored |
| `GET /password_reset/done/`, `GET /reset/done/` | **PASS** |
| `GET\|POST /reset/<uid>/<token>/`, `…/set-password/` | **PASS** |
| Phase 7a `SchedulerTask` write | **PASS** — byte-identical including the heap-ordered `user_ids` |
| **cross-cutting: content negotiation** | **PASS (F6 closed)** — 1 554 cells, 0 status mismatches outside the registered `/health` |
| **cross-cutting: multipart parsing** | **DEVIATION (F10, F11)** — the contract is ported; two residuals |
| **cross-cutting: `HEAD`** | **DEVIATION (F9)** — every route |

## Phase verdict: **FAIL**

The failure is narrow and its character has changed again. **Everything filed in rounds 1 and 2 is
closed**: F1–F5 stayed fixed under a new middleware and a replaced body parser, F6 and F8 are
genuinely fixed rather than registered — F6 with the write-refusal proved on two different
destructive endpoints with live positive controls, F8 with the boundary contract matching on all 16
shapes including the 201/202 off-by-one — and the R2.11.5 cell is in the suite with its own
controls. Nothing regressed: **2 400+ live cells** this round, and the whole database is
byte-identical to the pre-round `pg_dump` at the close, all 24 tables.

The phase fails only on §7 — *"an unregistered behavioural diff is a parity failure"* — for **F9,
F10, F11 and F12**. All four are **pre-existing**; none was introduced by the F6/F8 work; three of
the four are v2 behaving *better* than v1 (a 400 instead of a 500, a refusal instead of a bogus row,
the DRF headers instead of the WSGI server's page) and the fourth is v2 being RFC-conformant where
v1 is not. **All four are more likely to be closed by registration than by code**, exactly as F6 and
F8 were filed and — correctly — were not.

**One caveat that is not a finding but should be read as risk:** D19, D20 and D11 have now gone two
full rounds on round 1's evidence. Nothing in F6/F8 goes near them, but "unrefreshed for two
rounds" is how a regression hides.

If F9–F12 are registered, this phase is a **PASS** on everything else measured.

**Routing:** F9 → `business-analyst` (register). F10 and F12 → `business-analyst` first, then
`nestjs-developer` if a fix is chosen; both will recur on every multipart endpoint in Phases 4–8, so
one registration now is worth four later. F11 → `business-analyst` (scope question: does v2 owe
DRF's `FILES`-into-`data` merge?), then `nestjs-developer`. The four new §7 false-green instances
(#9–#12) and the two harness defects still live in `p3/restore-all.sh` and `p3/r2-f3.sh` →
`nestjs-reviewer` for the plan. This report → `nestjs-reviewer`.
