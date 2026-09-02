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
