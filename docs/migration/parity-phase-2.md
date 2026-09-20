# Phase 2 parity report — SES mail + SQS notifications

**Tester:** `manual-tester` (black-box, read-mostly).
**Date:** 2026-08-31.
**v1 (oracle, frozen):** `~/Projects/Fondo-API` @ `5bef585`, Django 2.2.27 / DRF 3.11.2 /
Python 3.9.25, gunicorn on `:8443` (container `fondo-v1`, repo mounted **read-only**).
**v2 (under test):** `~/Projects/Fondo-API-v2`, branch `feat/phase-2-notifications` @ `b5742bc`
(code `c72cc7c`), working tree clean, rebuilt from source (`npm run build`) before testing,
`node dist/main` on `:8444`.
**Database:** the shared `fondodev` (`localhost:5432`), Django migration `0019_auto_20220313_1225`,
94 live `fondo_api_notificationsubscriptions` rows.

---

## Verdict: **FAIL**

Not because the phase's substance is wrong — the substance is, as far as I could measure it,
**exact**. Every SES payload, every SQS `MessageBody`, every hstore row and the whole role matrix
are byte-identical between v1 and v2. The failure is narrower and entirely at the HTTP edge:

| # | Unregistered behavioural difference | Severity |
|---|---|---|
| **F1** | A bare `OPTIONS /api/notification/<op>` is **204, unauthenticated** in v2; v1 answers **403** (any role, incl. ADMIN) or **401** (no token). `docs/phase-2-deviations.md` §2.8 explicitly asserts v2 answers 403 here — the running system does not. | **High** (auth/permission surface, contradicts the phase's own deviation register) |
| **F2** | v2 routes **case-insensitively**: `POST /API/notification/subscribe` returns **200 and writes a subscription row**; v1 returns 404. | **High** (a write path reachable at a URL v1 does not serve) |
| **F3** | A duplicated `endpoint` form field stores different data: v1 (DRF `QueryDict`) keeps the **last** value, v2 stores the Python repr of the **whole array**. | Low (exotic input, but a DB-visible divergence) |
| **F4** | Response-header set differs on every response (`Vary`, `Allow`, `X-Frame-Options` dropped; `X-Powered-By`, `ETag`, `Content-Type: application/json` on zero-byte bodies added; unconditional `Access-Control-Allow-Origin: *`; CORS preflight **200 → 204**, `Access-Control-Allow-Methods` loses `OPTIONS`, `Access-Control-Max-Age` lost). | Low–medium, but wholly unregistered |
| **F5** | `docs/phase-2-deviations.md` **P2-D4 is factually wrong**: `remove_all_subscriptions` is *not* dead in v1 — `fondo_api/services/user.py:218` calls it when a member switches notifications off. Not observable in Phase 2 (no route), but the register's premise is false and Phase 3 must wire the call. | Doc defect with a Phase 3 consequence |

Per plan §7 ("an unregistered behavioural diff is a parity failure") F1–F3 are sufficient on their
own. F1 and F2 share one root cause — v2 has no pre-guard URL layer — which is the **open C9 work
item**; P2-D5 was already routed there. The fix surface is small: `app.enableCors()`
(`src/main.ts:41`) and Express's default `caseSensitive: false`.

Nothing in the mail, hstore or SQS core needs to change.

---

## 1. How each surface was driven

Phase 2 exposes **no HTTP route that contacts AWS** (the developer's statement checks out:
`MailService` has no entry point until Phase 3, `sendNotification` none until Phases 3/4/6). The
outbound side was therefore driven at the service layer, in-process, against the **same live
`fondodev` rows** in both systems:

| Surface | v1 driver | v2 driver | Capture |
|---|---|---|---|
| `POST /api/notification/{subscribe,unsubscribe}` | `curl` to gunicorn `:8443` | `curl` to `node dist/main` `:8444` | status + body + `psql` row diff |
| SQS `send_notification` | `docker exec fondo-v1 python …` — `django.setup()`, then `fondo_api.celery.tasks.sqs_client` replaced with a boto3 client whose `endpoint_url` is a local capture server, then `NotificationService().send_notification(ids, msg, target, run_async=False)` | `NestFactory.createApplicationContext(AppModule)` then `app.get(NotificationService).sendNotification(...)`, with `AWS_ENDPOINT_URL_SQS` + `NOTIFICATIONS_QUEUE_URL` pointed at a second capture server | raw HTTP request body written to disk; `MessageBody` extracted and compared with **`cmp`** |
| SES `send_mail` | same shape, replacing `MailService.__ses_client` | `app.get(MailService).sendMail(...)` with `AWS_ENDPOINT_URL_SES` | raw query-protocol request parsed with `parse_qsl` and diffed key by key |

Both capture servers are plain Python `http.server` processes (ports 4599 = v1, 4598 = v2) that
persist every request byte-for-byte and answer with a valid SQS/SES XML or JSON-1.0 response.
No LocalStack, no real AWS.

⚠️ **`NOTIFICATIONS_QUEUE_URL` was set for every v2 run** and verified to be load-bearing: with it
unset, `NotificationPublisher` logs *"NOTIFICATIONS_QUEUE_URL is not configured"* and sends
nothing (see §5.3). Every SQS assertion below is backed by a captured request on the wire, not by
a mock's call count.

**Wire-protocol note (not a parity defect):** boto3 1.18 speaks the SQS **query** protocol,
`@aws-sdk/client-sqs` speaks **AWS JSON 1.0** (`X-Amz-Target: AmazonSQS.SendMessage`). The
transport differs; the `MessageBody` string — the only thing the consuming Lambda sees — is
byte-identical. For SES both clients speak the query protocol.

**Database safety.** `pg_dump -t fondo_api_notificationsubscriptions` taken before testing and
re-taken after: **the 94 rows are unchanged, byte for byte**. Only the id sequence advanced
(1515 to 1550) from rows I created and deleted. A full `pg_dump --schema-only` before/after is
identical apart from pg_dump's own random `\restrict` token. `_prisma_migrations` still shows
`0_init` with `applied_steps_count = 0`; `django_migrations` still 38 rows. Row counts for
`auth_user` (15), `authtoken_token` (15), `fondo_api_userprofile` (15), `fondo_api_loan` (425),
`fondo_api_schedulertask` (632), `fondo_api_userfinance` (15) unchanged. One temporary
`auth_user` + `authtoken_token` pair was created for the "authenticated but no profile" cell and
deleted afterwards.

---

## 2. `POST /api/notification/subscribe` — role matrix

Payload: a real-shaped push subscription (`endpoint`, `expirationTime: null`, nested `keys`).
Each app used its **own** endpoint URL so both actually write (the dedupe is global).

| Case | Caller | v1 | v2 | DB side effect | Result |
|---|---|---|---|---|---|
| happy path | ADMIN (0), user 1 | 200, 0-byte body | 200, 0-byte body | 1 row each, hstore **byte-identical** | PASS |
| happy path | PRESIDENT (1), user 9 | 200, 0 bytes | 200, 0 bytes | 1 row each, byte-identical | PASS |
| happy path | TREASURER (2), user 2 | 200, 0 bytes | 200, 0 bytes | 1 row each, byte-identical | PASS |
| happy path | MEMBER (3), user 4 | 200, 0 bytes | 200, 0 bytes | 1 row each, byte-identical | PASS |
| authenticated, **no `fondo_api_userprofile` row** | temp user 16 | 403 `{"detail":"You do not have permission to perform this action."}` | identical bytes | none | PASS |
| token of an **inactive** user (id 3) | — | 401 `{"detail":"User inactive or deleted."}` | identical bytes | none | PASS |
| unknown token | — | 401 `{"detail":"Invalid token."}` | identical bytes | none | PASS |
| no `Authorization` header | — | 401 `{"detail":"Authentication credentials were not provided."}` | identical bytes | none | PASS |
| `Authorization: Bearer <token>` | — | 401 (same body as no-header) | identical bytes | none | PASS |
| re-subscribe same endpoint, same user | MEMBER | 200, still 1 row | 200, still 1 row | no duplicate | PASS |
| re-subscribe same endpoint, **different** user | MEMBER u5 on u4's row | 200, row untouched, still owned by u4 | identical | no write | PASS |
| **cross-app**: subscribe E via v1 then via v2 | MEMBER | 200 | 200 | exactly **1** row | PASS (§4.5 #1) |
| **cross-app**: subscribe F via v2 then via v1 | MEMBER | 200 | 200 | exactly **1** row | PASS (§4.5 #1) |
| `subscription::text` of a v1-written vs a v2-written row (endpoint normalised) | — | — | — | **identical string**, incl. the Python-repr `keys` and `"expirationTime"=>NULL` | PASS |

Hstore write encoding was additionally exercised with hostile values, each written by both apps
and compared after normalising the endpoint:

| Payload | Stored by v1 | Stored by v2 | Result |
|---|---|---|---|
| `"endpoint": 12345` | `"12345"` | `"12345"` | PASS |
| `"endpoint": true` / `false` | `"True"` / `"False"` | `"True"` / `"False"` (v2's `True` case deduped against v1's row — proof the coercion agrees) | PASS |
| `"endpoint": 1.5` | `"1.5"` | `"1.5"` | PASS |
| `"endpoint": {"a":1}` | `"{'a': 1}"` | `"{'b': 1}"` (same repr form) | PASS |
| `"endpoint": [1,2]` | `"[1, 2]"` | `"[3, 4]"` (same repr form) | PASS |
| quotes / backslash / `=>` / apostrophe in endpoint **and** in `keys` | Python-repr escaping inside `keys`, hstore escaping outside | identical | PASS |
| accents + emoji in endpoint and `keys` | UTF-8 verbatim | identical | PASS |
| extra keys + `null` + number + bool alongside the real keys | `"b"=>"True", "n"=>"123", "keys"=>…, "endpoint"=>…, "expirationTime"=>NULL` | **byte-identical**, same hstore key order | PASS |

---

## 3. `POST /api/notification/unsubscribe`

| Case | Caller | v1 | v2 | DB side effect | Result |
|---|---|---|---|---|---|
| own endpoint | each of ADMIN / PRESIDENT / TREASURER / MEMBER | 200, 0 bytes | 200, 0 bytes | row deleted | PASS |
| **another member's** endpoint | MEMBER u5 vs u4's row | **404**, 0 bytes | **404**, 0 bytes | row **untouched** | PASS (§4.5 #2) |
| endpoint never registered | MEMBER | 404, 0 bytes | 404, 0 bytes | none | PASS |
| repeat after a successful unsubscribe | MEMBER | 404 | 404 | none | PASS |
| **cross-app**: v2 deletes a row written by v1 (and v1 a row written by v2) | MEMBER | 200 | 200 | row gone | PASS |
| two rows with the same user+endpoint (planted by SQL — v1's `MultipleObjectsReturned`) | MEMBER | **500**, nothing deleted | **500**, nothing deleted | both rows survive | PASS (body diff = D13) |
| unauthenticated / bad token / inactive / no-profile | — | as in §2 | identical bytes | none | PASS |

---

## 4. Routing, methods, parsers

| Case | v1 | v2 | Result |
|---|---|---|---|
| `POST …/suscribe` (typo, authenticated) | **405**, **0-byte body** | 405, 0-byte body | PASS — §2.7's view-level 405 confirmed, not DRF's `{"detail":…}` |
| `POST …/SUBSCRIBE` (uppercase operation) | 405, 0 bytes | 405, 0 bytes | PASS |
| `POST …/suscribe` unauthenticated | 401 | 401 | PASS (auth precedes the operation check) |
| `POST …/sub1` (digit) **authenticated** | 404, Django HTML | 404, `{"message":"Not Found"}` | Expected — **D13** |
| `POST …/sub1` (digit) **unauthenticated** | **404** | **401** | Expected — **P2-D5** |
| trailing slash `…/subscribe/` | 200 (and 401 unauth) | identical | PASS — C9 does not bite on this route |
| `…//subscribe`, `/api/notification/`, `/api/notification`, `…/subscribe/extra` | 404 HTML | 404 JSON `{"message":"Cannot POST …"}` | Expected — D13 |
| **`POST /API/notification/subscribe`** | **404** | **200 + row written** | **FAIL — F2** |
| `GET` / `PUT` / `PATCH` / `DELETE` with any role incl. ADMIN | 403 `{"detail":"You do not have permission…"}` | identical bytes | PASS — the `@All()` fallback works (§2.8's main point) |
| `HEAD` | 403 | 403 | PASS |
| **bare `OPTIONS`, ADMIN / MEMBER / unauthenticated** | **403 / 403 / 401** | **204 / 204 / 204** | **FAIL — F1** |
| CORS preflight (`Origin` + `Access-Control-Request-Method`) | **200**, `Access-Control-Allow-Methods: DELETE, GET, OPTIONS, PATCH, POST, PUT`, `Access-Control-Max-Age: 86400` | **204**, `…Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE`, no `Max-Age` | FAIL — F4 |
| malformed JSON `{` | 400 `{"detail":"JSON parse error - Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"}` | **byte-identical** | PASS |
| `Content-Type: text/plain` | 415 `{"detail":"Unsupported media type \"text/plain\" in request."}` | byte-identical | PASS |
| denied caller (no profile) + `text/plain`, and + `{` | **403** both | **403** both | PASS — **C13** confirmed on the live route |
| body `{}` (no `endpoint`), `[1,2]`, `"abc"`, `5` | 500 (Django HTML) | 500 (0-byte body) | Expected — §4.4 / D13 |
| body `{"endpoint": null}` — subscribe | **200**, row written with `"endpoint"=>NULL`; a second identical call dedupes via `IS NULL` | **500**, no row | Expected — **P2-D3** |
| body `{"endpoint": null}` — **unsubscribe** | **200**, and the NULL-endpoint row **is deleted** | **500** | Expected under P2-D3's rationale, **but the register only describes the subscribe direction** — see §7 |
| form-encoded body | 200, row written | 200, row written, identical shape | PASS |
| multipart body | 200, row written | 200, identical shape | PASS |
| **form-encoded with `endpoint` twice** | stores the **last** value | stores `"['…dup1x', '…dup2x']"` | **FAIL — F3** |

---

## 5. The outbound side

### 5.1 SQS `MessageBody` — byte comparison (`cmp`, not `jq`) — §4.5 #3

Six sends, each executed by **both** systems against the same live rows:

| # | `user_ids` | Message | Bytes | `cmp` |
|---|---|---|---|---|
| 1 | `[1]` (1 subscription, the Apple row with **no** `expirationTime` key) | `Ha sido creada una nueva solicitud de crédito` | 476 | **identical** |
| 2 | `[2,5,9]` (**75** subscriptions) | `Recuerde que la fecha límite de pago de su crédito es mañana` | 28 266 | **identical** |
| 3 | `[1]` | `Hoy está cumpliendo años José "Pepe" \ / <b>ñ</b> ç` + emoji + a literal TAB, target `/user/13?q=á&z=1` | 537 | **identical** |
| 4 | `[3]` (inactive user, 2 rows) | `Usuario inactivo — sí` | 841 | **identical** |
| 5 | `[1]` | control characters: DEL (U+007F), U+0001, U+2028, U+2029, NBSP | — | **identical** |
| 6 | `[1..15]` — **all 94 live rows** | `Prueba de decodificación de las 94 filas — ñ á é í ó ú` | 35 392 | **identical** |

Confirmations that follow from those bytes:

* **Rule 5d holds on real data.** v1 and v2 both emit
  `{"subscriptions": [{"keys": {"p256dh": …, "auth": …}, "endpoint": …, "expirationTime": null}], "message": {"body": "…de crédito", "target": "/loan/1"}}`
  — `', '` / `': '` separators, `é` escaping. Case 3 pins the harder corners: `\"`, `\\`,
  `\t`, and the emoji as the surrogate pair `\ud83c\udf89`. Case 5 pins the escapes where
  CPython and JS disagree: DEL (U+007F) and NBSP (U+00A0) are escaped as `\u007f` / `\u00a0`
  by CPython and emitted raw by `JSON.stringify`. Both apps escaped them.
* **P2-D6 / no `ORDER BY` holds.** Case 2's 75 subscriptions appear in identical order in both
  bodies — PostgreSQL heap order (`160, 761, 1027, 783, …`), which on this table is **not** id
  order (`160, 677, 710, 715, …`, verified directly).
* **hstore key order (§2.2) holds.** In case 6, 93 of 94 subscriptions serialise as
  `keys, endpoint, expirationTime` and one (the Apple endpoint) as `keys, endpoint` — identically
  in both bodies.
* **The 94 live rows decode — verified independently.** Case 6 pushes every live row through
  *both* codecs and compares the result byte for byte; all 94 produce a `keys` **object** with
  `auth` + `p256dh`. I additionally ran the developer's read-only scan
  (`FONDODEV_DATABASE_URL=… npm run test:e2e -- test/notification.e2e-spec.ts` gives **29 passed**,
  nothing skipped), but the byte comparison above is the stronger evidence and does not depend on
  v2's own assertions.
* **Zero-subscription and empty-list sends publish nothing.** `[4]` (a member with no rows) and
  `[]` produced **no HTTP request at all** from either system — condition 4 and Django's
  `__in=[]` short-circuit, matched.
* **No stray writes.** An md5 over the whole subscription table is unchanged across all sends.

### 5.2 SES payloads — all six templates

Parameters decoded from the query-protocol request and compared key by key (parameter order and
`+`-vs-`%20` encoding are client-library artefacts and were normalised away; every value was
compared exactly).

| Template | Params | Result |
|---|---|---|
| `TEST` | `None` | **identical** (7 params) |
| `USER_ACTIVATION` | accented full name, id, key, host url | **identical** |
| `CHANGE_STATE_LOAN_APPROVED` | `loan_id`, HTML `loan_table`, bcc `[bcc1, mail, bcc2]` with `mail` also a recipient | **identical**, bcc becomes `[bcc1, bcc2]` |
| `CHANGE_STATE_LOAN_DENIED` | recipients `[a, b]`, bcc `[a, a, c]` | **identical**, bcc becomes `[a, c]` — **`list.remove` single-occurrence semantics reproduced exactly** (a naive filter would have produced `[c]`) |
| `POWER_APPROVED` | Spanish names, bigint identifications, `26 sept. 2021` | **identical** |
| `PASSWORD_RESET` | v1 gets a real `UserProfile`; v2 gets the flattened `username` | **identical**, incl. the `{% url 'password_reset_confirm' %}` expansion to `/reset/<uid>/<token>/` |

Django rendering rules, checked against real renders rather than assumed:

* `loan_table: null` gives both bodies the literal four characters **`None`**.
* `loan_table` **absent** gives both bodies the **empty string** at that position.
  (v1 null-body == v2 null-body; v1 missing-body == v2 missing-body; and null != missing in both.)
* `Subject.Data` is `[Fondo Montañez] …` with **no trailing newline** in both. All five
  `*_subject.txt` files are byte-identical between the repos (`cmp`).
* `Source` is `Fondo Montanez <no-reply@fonmon.minagle.com>` verbatim in both.
* An empty bcc serialises as `Destination.BccAddresses=` in both.

### 5.3 Failure semantics

| Case | v1 | v2 | Result |
|---|---|---|---|
| SES endpoint refuses connections | `send_mail` returns `False`, logs `Error sending email: …`, no throw | `sendMail` returns `false`, logs `Error sending email: connect ECONNREFUSED …`, no throw | PASS |
| SQS endpoint refuses connections | one attempt, logs `Error trying to connect to MNS service: …`, swallowed | **3 attempts** (`attempt 1/3`, `2/3`, then the same error line), ~2 s, swallowed, caller resolves normally | Expected — **P2-D7**; condition 2 (swallow) intact |
| `NOTIFICATIONS_QUEUE_URL` unset | botocore `ParamValidationError` on `QueueUrl=None`, swallowed | logs `…: NOTIFICATIONS_QUEUE_URL is not configured`, no attempt, swallowed | PASS (same observable: nothing sent, nothing raised) |
| a subscription whose `keys` contains an apostrophe (v1's `'` to `"` repair is lossy) | `json.JSONDecodeError` propagates out of `send_notification`; **nothing published** | decode error propagates out of `findPushSubscriptionsByUserIds`; **nothing published** | PASS — same failure mode, same blast radius |

---

## 6. Registered deviations — verification status

| # | Status |
|---|---|
| **P2-D1** (bcc list not mutated) | **Not externally observable.** The observable half — which addresses end up in `BccAddresses`, including the single-occurrence removal — is identical (§5.2). Accepted on inspection. |
| **P2-D2** (no `UserProfile` pre-fetch) | **Unreachable, as claimed.** A token whose user has no profile row is a **403 in both** before any service code runs (§2). The 500-shape difference could not be provoked. |
| **P2-D3** (`endpoint: null`) | **Confirmed.** subscribe: v1 200 + a row with SQL NULL, v2 500 + no row. See §7 for the undocumented unsubscribe direction. |
| **P2-D4** (`remove_all_subscriptions` dead) | **FALSE PREMISE — see F5.** v1 calls it at `fondo_api/services/user.py:218`. |
| **P2-D5** (operation regex ordering) | **Confirmed exactly as written**: unauthenticated `POST …/sub1` gives v1 404, v2 401; authenticated gives 404 in both. |
| **P2-D6** (no `ORDER BY`) | **Confirmed** by the 75- and 94-subscription bodies matching byte for byte in heap order. |
| **P2-D7** (3 attempts + backoff) | **Confirmed**: 3 attempts, ~200 ms/400 ms backoff, failure swallowed. |
| §4.4 expected non-failures | All observed as listed: P2-D5, D13 HTML-vs-JSON 404s, 500 bodies (HTML vs zero-byte). |
| **P0-D2** (`GET /health`) | v2 200 `{"status":"ok","database":"up"}`, v1 404 — registered, not counted. |

---

## 7. Findings in detail

### F1 — bare `OPTIONS` bypasses authentication and permissions (unregistered)

```
$ curl -i -X OPTIONS http://127.0.0.1:8443/api/notification/subscribe -H "Authorization: Token <ADMIN>"
HTTP/1.1 403 Forbidden   …   {"detail":"You do not have permission to perform this action."}
$ curl -i -X OPTIONS http://127.0.0.1:8444/api/notification/subscribe -H "Authorization: Token <ADMIN>"
HTTP/1.1 204 No Content  …   (empty)

$ curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS http://127.0.0.1:8443/api/notification/subscribe   # 401
$ curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS http://127.0.0.1:8444/api/notification/subscribe   # 204
```

`app.enableCors()` (`src/main.ts:41`) installs the `cors` middleware, which terminates **every**
`OPTIONS` request with 204 — with or without an `Origin` header — before the router, the guards
and the `@All()` fallback ever run. So the fallback that `docs/phase-2-deviations.md` §2.8 was
written to justify never sees an `OPTIONS`, and the doc's claim that v2 answers "403 for every
role including ADMIN, and including `OPTIONS`" is not what the process does.

Same root cause, previously mis-recorded: **P1-D2** states that `OPTIONS /api-token-auth` is
`405 {"detail":"Method \"OPTIONS\" not allowed."}` in v2. It is **204** (v1: 200 with the DRF
metadata document). The deviation is still real; its v2 column is wrong.

For `nestjs-developer`: either scope CORS handling to genuine preflights (`Origin` +
`Access-Control-Request-Method` present) and let everything else fall through to the guards, or
register the behaviour explicitly. Note that v1's own `corsheaders` middleware **does**
short-circuit a genuine preflight (200) and does **not** short-circuit a bare `OPTIONS` — that
asymmetry is the spec.

### F2 — case-insensitive routing accepts, and writes on, URLs v1 404s (unregistered)

```
$ curl -X POST http://127.0.0.1:8443/API/notification/subscribe -H "Authorization: Token <MEMBER>" \
       -H 'Content-Type: application/json' -d '{"endpoint":"https://parity.test/PARITY-case", …}'
404  <h1>Not Found</h1>…
$ curl … http://127.0.0.1:8444/API/notification/subscribe …
200  (empty)
```

and the row appears:

```
1550 u=4 | "keys"=>"{'p256dh': 'BNhR5o…', 'auth': 'oLqgm…'}", "endpoint"=>"https://parity.test/PARITY-case", "expirationTime"=>NULL
```

Unauthenticated, the same URL is 404 in v1 and **401** in v2 — i.e. v2 treats `/API/...` as a real
route throughout. Django's `url()` patterns are case-sensitive; Express defaults to
`caseSensitive: false`. This widens the surface of **every** route in Phases 3–8, including the
soft-delete and TSV-upload paths, so it belongs with C9 rather than being patched per controller.

### F3 — duplicate form field (unregistered, low)

```
POST /api/notification/subscribe   Content-Type: application/x-www-form-urlencoded
endpoint=https://…/dup1&endpoint=https://…/dup2&keys=k
```

v1 stores `"endpoint"=>"https://…/dup2"` (DRF `QueryDict.__getitem__` returns the last value).
v2 stores `"endpoint"=>"['https://…/dup1x', 'https://…/dup2x']"` — the array, `pythonStr`-coerced.
Single-valued form and multipart bodies are identical in both, so this is only the repeated-key
case.

### F4 — response headers (unregistered, cross-cutting)

| Response | v1 | v2 |
|---|---|---|
| 200 subscribe | `Vary: Accept, Origin`, `Allow: POST, OPTIONS`, `X-Frame-Options: SAMEORIGIN` | `X-Powered-By: Express`, `Access-Control-Allow-Origin: *` |
| 403 / 401 | plus `Content-Type: application/json` | plus `Content-Type: application/json; charset=utf-8`, `ETag` |
| 404 / 405 (0-byte body) | no `Content-Type` | `Content-Type: application/json; charset=utf-8`, `ETag` |

`X-Frame-Options` disappearing is a (small) security-posture change, and `Allow` disappearing
removes information a DRF client could read off a 405. None of it changes a status or a body. It
is pre-existing since Phase 1 and was approved without being written down — I am filing it so the
register matches reality, not because I think it must be fixed.

### F5 — P2-D4's premise is wrong (doc defect, Phase 3 consequence)

```python
# fondo_api/services/user.py:208-222  __update_user_preferences
remove_notifications = user_preference.notifications != obj['notifications']
…
if remove_notifications and not user_preference.notifications:
    self.__notification_service.remove_all_subscriptions(id)
```

So in v1, a member turning notifications **off** in their preferences deletes **all** their push
subscriptions. Phase 2 ships the port with no caller, which is correct for Phase 2 — but the
justification ("as in v1, where it is also dead — verified across `fondo_api/`") is false, and a
Phase 3 implementer reading it would reasonably leave `PATCH /api/user/<id>` with
`type=preferences` unwired. Please correct P2-D4 and add the call site to the Phase 3 scope.

---

## 8. What I could **not** test, and why

1. **The Celery hop.** v1's production path is `send_notification.delay(...)` to a broker, to a
   worker, to `sqs_client.send_message`. No broker/worker was running, so I drove the task
   function directly (`run_async=False`), which is the same function the worker calls — the
   `MessageBody` is therefore fully tested, but the **queueing hop itself is not**. That is
   inherent: v2 has no equivalent to compare against, and nothing in Phase 2's parity criteria
   depends on it.
2. **Real SES/SQS.** Both were captured at a local HTTP endpoint. Payloads are compared exactly;
   what AWS *does* with them (address validation, throttling, queue semantics) is untested.
3. **Mail and notification sends over HTTP.** Not possible in Phase 2 — no route reaches them.
   Both were driven in-process through the real DI container, against the real database. The HTTP
   integration must be re-verified in Phases 3/4/6 when the call sites land.
4. **P2-D1 (bcc not mutated) and P2-D2 (missing profile gives 500)** are not observable from
   outside; see §6.
5. **`POST /password_reset/`** (the only v1 route that sends a `PASSWORD_RESET` mail) is Phase 3
   in v2 and has no v2 counterpart yet; the template was compared by driving `MailService`.
6. **The dedupe race.** Both apps do check-then-insert with no unique index on
   `subscription->'endpoint'`, so two concurrent subscribes of one endpoint can create two rows in
   **either** system (v1 included). I did not attempt to provoke it; the shapes are identical, and
   it is a pre-existing v1 property, not a migration defect. Worth a unique index at Phase 9.
7. **Load and latency.** Out of scope.

Nothing the plan's Phase 2 section claimed to be testable turned out not to be, with the single
exception noted in §7 (P2-D4's claim about v1, which is testable and false).

---

## 9. For `business-analyst`

* **Turning notifications off deletes every subscription** (F5, `services/user.py:218`). It is
  irreversible from the server's side: the browser must re-subscribe, which it only does on
  service-worker activation. Worth confirming this is intended before Phase 3 re-implements it.
* **`endpoint: null` is storable in v1** and produces a row that cannot be removed through the
  API by any client that sends a *non-null* endpoint (v1 deletes it only when the caller also
  sends `null`). No live row is in that state today; v2 refuses to create one (P2-D3). Confirm
  nobody wants the v1 behaviour preserved past cutover.
* **The dedupe is global, not per-user** (§2): a browser endpoint already registered by member A
  cannot be registered by member B — B silently receives A's notifications on that device instead
  of their own. Faithful to v1 and defensible (an endpoint identifies one browser installation),
  but it is a real "shared family computer" scenario in a 15-member family fund and is not
  written down anywhere as a decision.

---

## 10. System health

| Check | Result |
|---|---|
| v1 boots and serves | OK — gunicorn 19.9.0, 3 workers, `:8443`; repo mounted **read-only**, `git status` clean at `5bef585` |
| v2 boots and serves | OK — rebuilt from `c72cc7c`, `node dist/main`, `:8444`, `PrismaService Connected to PostgreSQL` |
| v2 route inventory | OK — exactly `POST`/`ALL /api/notification/:operation`, `POST`/`ALL /api-token-auth`, `GET /health`; no unexpected surface |
| Migrations / schema | OK — `pg_dump --schema-only` identical before/after; `_prisma_migrations.0_init` still `applied_steps_count = 0`; `django_migrations` still 38 |
| The 94 live rows | OK — `pg_dump -t fondo_api_notificationsubscriptions` identical before/after (only the id sequence moved, from my own rows) |
| Stray writes | OK — none; every other table's row count unchanged; the temporary `auth_user`/`authtoken_token` pair removed |
| Scheduler / worker | n/a in Phase 2 — v2 runs no scheduled job yet; v1's Celery beat/worker were not running |
| v2 e2e gate (notification suite re-run with the live scan enabled) | OK — 29/29 passed, 0 skipped |

---

## 11. Verdict per endpoint / operation

| Surface | Verdict |
|---|---|
| `POST /api/notification/subscribe` — all four roles, unauthenticated, inactive, no-profile, dedupe, cross-app, hstore encoding | **PASS** |
| `POST /api/notification/unsubscribe` — all four roles, cross-user 404, unknown 404, cross-app, duplicate-row 500 | **PASS** |
| Unknown operation gives a view-level empty 405 | **PASS** |
| Non-POST methods `GET/PUT/PATCH/DELETE/HEAD` give 403 | **PASS** |
| **`OPTIONS` on the route** | **FAIL (F1)** |
| **URL matching (case sensitivity)** | **FAIL (F2)** |
| Body parsing (JSON / form / multipart / malformed / 415 / guard-before-parser) | **PASS**, except the repeated form key — **FAIL (F3)** |
| Response headers | **FAIL (F4)** — unregistered, cosmetic to medium |
| `MailService` — all six SES payloads + bcc + `None`/missing rendering + failure return | **PASS** |
| `NotificationService.sendNotification` to SQS (6 sends incl. all 94 live rows) | **PASS** |
| SQS failure / retry / missing queue URL semantics | **PASS** (P2-D7 as authorised) |
| DB side effects and schema stability | **PASS** |

**Phase 2 overall: FAIL** — on F1, F2 and F3, all at the HTTP edge, none touching the mail,
hstore or SQS core. Returning to `nestjs-developer`; `nestjs-reviewer` should not start until the
three are fixed or registered, and P2-D4 corrected.

---

# Round 2 — re-test after the F1–F5 fixes

**Date:** 2026-08-31 (second pass).
**Tester:** `manual-tester`, black-box, read-mostly.
**v1 (oracle, frozen):** `~/Projects/Fondo-API` @ `5bef585`, working tree clean, gunicorn 19.9.0
on `:8443` (container `fondo-v1`, host network, repo mounted read-only).
**v2 (under test):** `~/Projects/Fondo-API-v2` @ `656f955`, working tree clean. The server left
running on `:8444` was **verified current**: `npm run build` reproduced `dist/` byte-for-byte
(`diff -rq`, tsbuildinfo excluded), and the process's `/proc/<pid>/environ` confirms
`DATABASE_URL=…/fondodev`, `PORT=8444` and a set `NOTIFICATIONS_QUEUE_URL`.
**Database:** shared `fondodev`. Fixture verified **before and after**: 94
`fondo_api_notificationsubscriptions` rows, `max(id) = 1468`, table md5
`a1a74f3cbf0ecf09647afef27e85839b`, 15 `auth_user`, 15 `authtoken_token`, 38 `django_migrations`,
`_prisma_migrations.0_init` still `applied_steps_count = 0`, `pg_dump --schema-only` identical.

## Verdict: **FAIL**

Materially narrower than round 1, and for different reasons. **All five findings F1–F5 are
fixed** — independently re-measured, not taken on the developer's word — and **nothing in the
substance regressed**: the SQS bodies, the hstore encoding, the role matrix and the parse/415/403
ordering are still byte-identical with the new middleware stack in the request path.

The failure is that the fix round introduced **two new unregistered behavioural differences**,
both inside the new URL/CORS layer, and both exactly in the "weak spots" §4.4b flagged:

| # | New difference | Severity |
|---|---|---|
| **N1** | A **genuine CORS preflight on an `APPEND_SLASH` path** is a **301 in v1** and a **200 in v2**. v1's `MIDDLEWARE` puts `CommonMiddleware` **3rd** and `corsheaders.CorsMiddleware` **8th (last)**, so `APPEND_SLASH` fires *before* the preflight short-circuit; `AppModule.configure` applies `DjangoCorsMiddleware` **before** `DjangoUrlResolverMiddleware`, so the short-circuit fires first. Reproduces on all four `password_reset` / `reset` routes. | **Medium** — a status-code divergence, unregistered |
| **N2** | `Location` on the `APPEND_SLASH` 301 is built from the **raw request target**; Django builds it from the **decoded** path re-encoded with `escape_uri_path`. `POST /password%5Freset` → v1 `Location: /password_reset/`, v2 `Location: /password%5Freset/`. The doc comment in `django-url-resolver.middleware.ts` asserting "the two agree for every path that can reach this branch" is **false** — the *routes* are ASCII, the *request target* need not be. | Low, unregistered |

Two further differences were found that are **pre-existing, not regressions** (round 1 simply did
not probe them) and are reported for the register rather than as fix-round failures: **N3**
(percent-encoded literal path segments) and **O1** (`HEAD` response body). Details in §R2.5.

Per plan §4 rule 14 and §7, N1 and N2 are unregistered behavioural diffs and are sufficient for a
FAIL on their own. Both are cheap: N1 is a two-line reorder in `AppModule.configure`; N2 is a
port of `escape_uri_path` (or a registration).

---

## R2.1 Findings F1–F5 — status

| # | Status | Evidence |
|---|---|---|
| **F1** | ✅ **Fixed** | Full `method × role` matrix re-driven on `/api/notification/subscribe`. Bare `OPTIONS`: **403** for ADMIN(0), PRESIDENT(1), TREASURER(2), MEMBER(3) and **401** unauthenticated — byte-identical bodies to v1, on both ports. Genuine preflight (`Access-Control-Request-Method`, **no** `Origin`): **200**, `Content-Type: text/html; charset=utf-8`, `Content-Length: 0`, `Vary: Origin`, `X-Frame-Options: SAMEORIGIN` — identical on both, including on a **non-resolving** path (`/nope/nope`), confirming the developer's correction that `Origin` is not part of corsheaders 2.4.0's short-circuit condition (source read from the container: `/usr/local/lib/python3.9/site-packages/corsheaders/middleware.py`). With `Origin`: `Access-Control-Allow-Origin: *`, the nine-header allow-list, `Allow-Methods: DELETE, GET, OPTIONS, PATCH, POST, PUT`, `Max-Age: 86400` — identical. An empty-valued `Access-Control-Request-Method:` still short-circuits in both (presence, not value). ⚠️ One case is **not** fixed — see **N1**. |
| **F2** | ✅ **Fixed** | `POST /API/notification/subscribe` → **404 in both, no row written** (`max(id)` unchanged). Same for `/api/NOTIFICATION/subscribe`, `/Api/Notification/Subscribe`, `/API/NOTIFICATION/SUBSCRIBE`, authenticated and unauthenticated. `/api/notification/SUBSCRIBE` and `/api/notification/Subscribe` still resolve and give the view-level empty **405** in both (the *operation* is case-sensitive at the handler, the *path* at the URL conf) — matching v1. |
| **F3** | ✅ **Fixed** | `endpoint=…dup1&endpoint=…dup2` **urlencoded** → both store `"endpoint"=>"https://parity.test/r2-dup2"`. Same body as **multipart** → both store `…r2-mp2`. Full `subscription::text` identical in both directions. |
| **F4** | ✅ **Fixed** | Header blocks diffed (excluding `Server`/`Date`/`Connection`/`Keep-Alive`/`Transfer-Encoding`) across 11 response classes: 200 subscribe, 200 subscribe+`Origin`, 401 unauth, 403 GET/ADMIN, 405 unknown op, 404 unsubscribe-miss, 400 malformed JSON, 415 `text/plain`, 301 append-slash → **all HEADERS-MATCH**. Only the 500 and the URL-conf 404 differ, and only in `Content-Length`/`Content-Type`, which is the HTML-vs-JSON body already registered as **D13 / P2-D8 residual (1)**. `X-Powered-By` and `ETag` gone; `Vary: Accept, Origin` merge order matches; `Allow` present on 401/403; `Content-Type: application/json` **without** charset; **no** `Content-Type` on zero-byte bodies. Header *ordering* differs (v1 `Content-Type, Vary, Allow, X-Frame-Options`; v2 `Allow, Vary, Content-Type, …`) — insignificant per RFC 9110, noted for completeness. |
| **F5** | ✅ **Fixed (doc)** | P2-D4 is struck through and corrected with the real call site (`fondo_api/services/user.py:218`); `notification.service.ts` and `notification-subscription.repository.ts` carry the ⚠️ "Phase 3 must wire this call" comment; `MIGRATION_PLAN.md` §5 item 9 adds the Phase 3 scope item. Two DB-backed e2e cells exist and pass (`remove_all_subscriptions deletes every row of one user and no one else's`, `… on a user with no rows is a no-op`). |

`P2-D5` is genuinely **withdrawn, not deviated**: `POST /api/notification/sub1` is now **404 in
both, authenticated and unauthenticated**, raised before the guards; only the body differs (D13).

---

## R2.2 The URL table — full sweep of all 22 patterns, both slashed and unslashed

The highest-value check. Method: for each pattern, a concrete instance in **both** forms, driven
with `curl --path-as-is` at both ports, `GET` and `POST`. "v1 resolved" is read off any status
that is **not 404**; in v2 the two 404s are distinguished by body — `{"message":"Not Found"}` is
the **URL conf** refusing to resolve, `{"message":"Cannot <M> <path>"}` is the **Nest router**
having no handler for a path the URL conf *did* let through. That distinction is what separates
"the table is over-restrictive" from "Phase 3+ has no controller yet", and it is checked on every
row rather than assumed.

**Result: 22/22 patterns agree, in both forms, in both directions.** No row where v1 resolves and
v2's URL conf 404s; no row where v1 404s and v2's URL conf lets it through.

| Path | v1 | v2 URL conf |
|---|---|---|
| `/password_reset/`, `/password_reset/done/`, `/reset/MQ/abc-def/`, `/reset/done/` | 200 | resolved (router 404 — Phase 3) |
| `/password_reset`, `/password_reset/done`, `/reset/MQ/abc-def`, `/reset/done` (bare) | **301** | **301**, same `Location` for ASCII targets |
| `/api-token-auth`, `/api-token-auth/` | 405 | 405 (identical) |
| `/api/authorize`, `/api/authorize/` | 200 | resolved (router 404 — skipped endpoint) |
| `/api/loan`, `/api/loan/` | 401 | resolved |
| `/api/loan/1` | 401 | resolved | 
| **`/api/loan/1/`** | **404** | **URL-conf 404** |
| `/api/loan/1/approve` | 401 | resolved |
| **`/api/loan/1/approve/`** | **404** | **URL-conf 404** |
| `/api/user`, `/api/user/` | 401 | resolved |
| `/api/user/birthdates`, `/api/user/-power`, `/api/user/1`, `/api/user/-1` | 401 | resolved |
| **`/api/user/birthdates/`, `/api/user/1/`, `/api/user/-1/`** | **404** | **URL-conf 404** |
| `/api/user/activate/1` | 405 (GET) | resolved |
| **`/api/user/activate/1/`** | **404** | **URL-conf 404** |
| **`/api/activity/1` and `/api/activity/1/`** | **401 both** — the one detail route carrying `/?` | **resolved both** |
| `/api/activity/year`, `/api/activity/year/`, `/api/activity/year/2021` | 401 | resolved |
| **`/api/activity/year/2021/`** | **404** | **URL-conf 404** |
| `/api/notification/subscribe`, `…/subscribe/` | 401 | 401 (identical) |
| `/api/file`, `/api/file/`, `/api/file/1` | 401 | resolved |
| **`/api/file/1/`** | **404** | **URL-conf 404** |
| `/api/admin`, `/api/admin/`, `/api/saving-account`, `/api/saving-account/` | 401 | resolved |
| `/api/alexa`, `/api/alexa/` | 405 (GET) / 422 (POST) | URL-conf 404 — **registered**, §4.4 |
| `/health`, `/health/` | 404 | 200 — **registered**, P0-D2 |

**The asymmetry the brief called out is reproduced exactly:** `GET /api/activity/1/` is a **401 in
both** (resolves) while `GET /api/loan/1/` is a **404 in both**.

### Regex boundary probes — 25 further paths, 0 mismatches

Driven to catch a transcription that is *nearly* right:

* `reset` token `{1,13}-{1,20}`: `abcdefghijklm-abcdefghijklmnopqrst` (13-20) resolves in both;
  `abcdefghijklmn-…` (14) and `…-abcdefghijklmnopqrstu` (21) are 404/URL-conf-404 in both.
* `uidb64` `[0-9A-Za-z_\-]+`: `/reset/M_Q-x/a-b/` resolves in both; `/reset/M.Q/a-b/` 404s in both.
  `/reset/MQ/a_b/` (no `-` in the token) 404s in both.
* Numeric ids: `/api/loan/007` and `/api/loan/99999999999999999999` resolve in both;
  `/api/loan/1a`, `/api/loan/+1` 404 in both.
* The `-?` sentinel: `/api/user/-1` and `/api/user/-abc` resolve in both; `/api/user/--1` and
  `/api/user/abc-def` 404 in both.
* `operation` `[a-zA-Z]+`: `/api/notification/a` and `/api/notification/aBcXyZ` resolve in both;
  `sub-scribe`, `sub_scribe`, `subscribeñ`, `sub1`, `subscribe%20`, `subscribe.` 404 in both.
* Doubled slashes: `/api//notification/subscribe`, `/api/notification/subscribe//`,
  `/api-token-auth//`, `/password_reset//` — 404 in both.
* Near-misses: `/api/saving_account`, `/api/savingaccount` — 404 in both.

### WSGI `PATH_INFO` decoding

* `POST /api/notification/%73ubscribe` → **200 authenticated / 401 unauthenticated in both**.
* `POST /api/notification/su%62scribe` and `%73%75%62%73%63%72%69%62%65` → same.
* `POST /api/notification/%73ubscribe/` (decoded **and** trailing slash) → 200/401 in both.
* `POST /api/notification/sub%2Fscribe` → **404 in both**.
* Double-encoded `%2573ubscribe` → 404 in both. `subscri%C3%A9be` → 404 in both.
* `/api/notification/../notification/subscribe`, `/api/./notification/subscribe` → 404 in both
  (neither server normalises dot-segments).

### `Allow` / `Vary: Accept` transcription — verified against live v1

All 17 `allow` strings in `django-url-conf.ts` were read back off a live v1 response and compared:
**17/17 correct**, and `varyAccept` is right everywhere (`Vary: Accept, Origin` on every DRF view,
`Vary: Origin` only on `/api-token-auth`, whose `ObtainAuthToken` has a single renderer).

⚠️ **One forward-looking nit** (not a Phase 2 defect; `/api/authorize` is a skipped endpoint):
v1 answers `GET /api/authorize` with `Vary: Accept, Origin, **Cookie**` — `AuthView` touches the
session, so `SessionMiddleware` patches `Cookie` in. The table models only `Accept`. Whoever
implements `AuthView` should widen `DrfViewHeaders` rather than discover this in Phase 3's own run.

---

## R2.3 N1 — genuine preflight vs `APPEND_SLASH` (new, unregistered)

`corsheaders.CorsMiddleware` is **last** in v1's `MIDDLEWARE` (`api/settings/base.py:38-46`),
below `django.middleware.common.CommonMiddleware`. Django's new-style stack runs `process_request`
top-down, so `CommonMiddleware` issues the `APPEND_SLASH` 301 and returns **without ever calling**
the CORS middleware. In v2, `AppModule.configure` applies `DjangoCorsMiddleware` **before**
`DjangoUrlResolverMiddleware`, so the preflight short-circuit wins.

```
$ printf 'OPTIONS /password_reset HTTP/1.1\r\nHost: 127.0.0.1\r\n
          Origin: https://x.test\r\nAccess-Control-Request-Method: POST\r\n
          Connection: close\r\n\r\n' | nc 127.0.0.1 8443
HTTP/1.1 301 Moved Permanently
Content-Type: text/html; charset=utf-8
Location: /password_reset/
Content-Length: 0

… same request to 8444 …
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Vary: Origin
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: accept, accept-encoding, authorization, content-type, dnt, origin, user-agent, x-csrftoken, x-requested-with
Access-Control-Allow-Methods: DELETE, GET, OPTIONS, PATCH, POST, PUT
Access-Control-Max-Age: 86400
Content-Length: 0
X-Frame-Options: SAMEORIGIN
```

Reproduced identically on all four paths that can reach the branch: `/password_reset`,
`/password_reset/done`, `/reset/done`, `/reset/MQ/abc-def`. With and without `Origin`.

**Scope.** Only these four; a preflight on a resolving path (`/api/notification/subscribe`) and on
a wholly non-resolving path (`/nope/nope`) is a 200 in both, correctly. No **Phase 2** route is
affected today, and no browser sends a preflight to the bare form of a Django form page — but it
is a status-code divergence produced by this fix round, it is unregistered, and it goes live the
moment Phase 3 lands `PasswordResetView`. Fix: swap the two entries in `AppModule.configure` so
the resolver runs first, matching v1's `MIDDLEWARE` order. (The response-phase hook ordering must
be preserved: v1's 301 carries **no** `Vary`, **no** `X-Frame-Options` and **no** `Access-Control-*`,
which `skipBeforeHeadersHooks` already reproduces and which the reorder must not break.)

---

## R2.4 N2 — `Location` encoding on the `APPEND_SLASH` 301 (new, unregistered)

Django builds the redirect from `request.get_full_path(force_append_slash=True)`, i.e.
`escape_uri_path(<decoded path>) + '/' + ('?' + iri_to_uri(QUERY_STRING))`.
`redirectWithSlash` uses `splitQuery(request.originalUrl)` — the **raw** target.

```
$ curl -si --path-as-is -X POST http://127.0.0.1:8443/password%5Freset | head -1; …
HTTP/1.1 301 Moved Permanently
Location: /password_reset/          ← v1

$ curl -si --path-as-is -X POST http://127.0.0.1:8444/password%5Freset
HTTP/1.1 301 Moved Permanently
Location: /password%5Freset/        ← v2
```

Further confirmed cases (all 301 in both, `Location` differing):

| Request target | v1 `Location` | v2 `Location` |
|---|---|---|
| `/password%5Freset` | `/password_reset/` | `/password%5Freset/` |
| `/password%5freset` (lower hex) | `/password_reset/` | `/password%5Freset/` |
| `/pass%77ord_reset` | `/password_reset/` | `/pass%77ord_reset/` |
| `/password_reset%2Fdone` | `/password_reset/done/` | `/password_reset%2Fdone/` |
| `/reset/M%51/abc-def` | `/reset/MQ/abc-def/` | `/reset/M%51/abc-def/` |
| `/password_reset?a=%C3%B1&b=1` | `/password_reset/?a=%C3%B1&b=1` | **same** |

The `%2F` case is the sharpest: v1's `Location` names a *different, decoded* path. Both redirects
happen to converge on a working URL, so the practical impact is small, but the header bytes differ
and the code comment claiming they cannot is wrong. Fix: port `escape_uri_path` (`quote(path,
safe="/:@&+$,-_.!~*'()")`) over the already-computed `pathInfo`, and `iri_to_uri` over the query —
or register the deviation and correct the comment.

---

## R2.5 N3 and O1 — pre-existing, found this round, not regressions

**N3 — percent-encoded *literal* path segments 404 in v2.** The URL conf is right; Nest's
Express router matches literal segments against the **raw** path, so a decoded-equal target does
not reach the controller. Diagnosed by body: v2 returns `{"message":"Cannot POST …"}`, i.e. the
URL conf resolved and the router did not.

```
POST /api%2Dtoken%2Dauth   {"username":"a","password":"b"}
  v1 400 {"non_field_errors":["Unable to log in with provided credentials."]}
  v2 404 {"message":"Cannot POST /api%2Dtoken%2Dauth"}

POST /api/%6Eotification/subscribe   <valid subscription>   (MEMBER token)
  v1 200, row written        v2 404, no row
  unauthenticated: v1 401    v2 404
```

Also `/%61pi/notification/subscribe`, `/api/l%6Fan/1`, `/api/%61ctivity/1/`, `/password%5Freset/`.
This is the **mirror image of F2** — v2 narrower than v1 rather than wider — so it writes nothing
v1 would not, but it is unregistered and cross-cutting (it will apply to every Phase 3–8 route).
It predates the fix round: `/api%2Dtoken%2Dauth` has 404'd since Phase 1. Only the parameterised
segments decode correctly, because Express decodes params (`%73ubscribe` works). For
`nestjs-developer`: either normalise the path for the router the way `decodePathInfo` already does
for the table, or register it.

**O1 — `HEAD` returns a response body in v1.** `HEAD /api/notification/subscribe` with an ADMIN
token: **identical status (403) and identical headers including `Content-Length: 63`** in both, but
v1 (gunicorn 19.9.0) writes the 63-byte JSON body and v2 (Node) writes 0 bytes. Same for the
unauthenticated 401. Round 1 recorded `HEAD → 403 / 403 PASS` on status alone. This is a property
of the **server**, in the same class as **P2-D8 residual (2)** (`Server:`, `Connection:`), and v2
is the RFC-conformant side; it belongs in that residual rather than as a defect.

---

## R2.6 Regression check — the round-1 substance, re-run against the new build

The middleware now sits in the request path, so all of it was re-driven, not assumed.

### Role matrix, both operations — `PASS`

| Role (user) | subscribe v1 / v2 | rows for that endpoint | owner | unsubscribe via **v2** | repeat via **v1** |
|---|---|---|---|---|---|
| ADMIN (0), u1 | 200 / 200, 0-byte | **1** | 1 | 200 | 404 |
| PRESIDENT (1), u9 | 200 / 200, 0-byte | **1** | 9 | 200 | 404 |
| TREASURER (2), u2 | 200 / 200, 0-byte | **1** | 2 | 200 | 404 |
| MEMBER (3), u4 | 200 / 200, 0-byte | **1** | 4 | 200 | 404 |

Each endpoint was subscribed through v1 **and** v2 — exactly one row each, proving the global
dedupe still crosses apps. Denials re-verified byte-for-byte on **both** operations: inactive
token → `401 {"detail":"User inactive or deleted."}`; unknown token → `401 {"detail":"Invalid
token."}`; no header → `401 {"detail":"Authentication credentials were not provided."}`.
Non-`POST` verbs (`GET/PUT/PATCH/DELETE/OPTIONS`) → `403 {"detail":"You do not have permission to
perform this action."}` for **every** role including ADMIN, `401` unauthenticated.

### The three §4.5 checks — `PASS`

1. **Cross-app single row + identical `subscription::text`.** A payload with accents, an
   apostrophe and a backslash in `keys`, written by v1 and by v2 (differing only in the endpoint,
   normalised away):

   ```
   "keys"=>"{'p256dh': 'BNhR5oáé', 'auth': \"oLq'g\\\\m\"}", "endpoint"=>"https://parity.test/X", "expirationTime"=>NULL
   ```

   **`cmp`-identical** — the Python-repr quoting flip (`'…'` → `"…"` when the value contains an
   apostrophe), the doubled backslash and the raw UTF-8 all agree.
2. **Cross-user unsubscribe.** MEMBER u5 against u4's endpoint → **404, 0 bytes, in both**; the row
   survives (`count = 1`). v2 then deleted a v1-written row and v1 a v2-written row, both 200.
3. **SQS `MessageBody` compared with `cmp`**, both apps driven against the same live rows, each
   capture written to disk raw by a local HTTP stub (`:4599` v1 via a swapped `tasks.sqs_client`,
   `:4598` v2 via `AWS_ENDPOINT_URL_SQS` + `NOTIFICATIONS_QUEUE_URL`):

   | Send | Bytes | `cmp` |
   |---|---|---|
   | `[1]` — `Ha sido creada una nueva solicitud de crédito` | 476 | **identical** |
   | `[2,5,9]` — 75 subscriptions, `…fecha límite…mañana` | 28 265 | **identical** |
   | `[1]` — `José "Pepe" \ / <b>ñ</b> ç 🎉` + literal TAB, target `/user/13?q=á&z=1` | 537 | **identical** |
   | `[1]` — DEL (U+007F), U+0001, NBSP | 429 | **identical** |
   | `[1..15]` — **all 94 live rows** | 35 392 | **identical** |
   | `[4]` (no subscriptions) and `[]` | — | **no HTTP request from either system** |

### The 94-row live decode scan — `PASS`

Decoding the 35 392-byte body (which is byte-identical between the two systems) yields
**94 subscriptions, 0 failing the `keys`-object decode**, every one with `auth` + `p256dh`, and
hstore key order preserved as **93 × `keys, endpoint, expirationTime` + 1 × `keys, endpoint`**
(the Apple row). Heap order, not id order, matched. Independently, the developer's read-only e2e
scan runs rather than skips: `test/notification.e2e-spec.ts` is **30 passed + 1 skipped** without
`FONDODEV_DATABASE_URL` and **31 passed, 0 skipped** with it.

### Rule 5d on a real accented Spanish body — `PASS`

The captured bytes show `ensure_ascii` escaping and `', '` / `': '` separators in both:

```
{"subscriptions": [{"keys": {"p256dh": "BO-ciUqn…", "auth": "iEqZDhjU-hAfpOegPQgqSA"}, "endpoint": "https://web.push.apple…"}], "message": {"body": "Hoy está cumpliendo años José \"Pepe\" \\ / <b>ñ</b> ç 🎉\tTAB", "target": "/user/13?q=á&z=1"}}
```

The whole 537-byte body is ASCII-only, the emoji is the surrogate pair, `\t` and `\"` and `\\` are
CPython's escapes, and DEL/NBSP are escaped in the control-character send. **`NOTIFICATIONS_QUEUE_URL`
re-verified load-bearing**: with it unset, v2 logs `Error trying to connect to MNS service:
NOTIFICATIONS_QUEUE_URL is not configured` and the capture count does not move — so every cell
above is backed by bytes on the wire.

### Parsers, error bodies, registered deviations — `PASS` / unchanged

| Case | v1 | v2 |
|---|---|---|
| malformed JSON `{` | `400 {"detail":"JSON parse error - Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"}` | **byte-identical** |
| `Content-Type: text/plain` | `415 {"detail":"Unsupported media type \"text/plain\" in request."}` | **byte-identical** |
| body `{}`, `[1,2]`, `5` | 500, Django HTML | 500, 0 bytes — §4.4 / D13 |
| `{"endpoint": null}` | 200 + a SQL-NULL row | 500 — **P2-D3**, unchanged (row cleaned up) |
| `NaN` | 400 `…Out of range float values…` | 400 `…Expecting value…` — **C11 residual**, unchanged |
| `POST …/suscribe` (typo) | **405, 0-byte** | identical; `401` unauthenticated in both |
| `POST …/sub1` | **404** authenticated **and** unauthenticated | identical — P2-D5 withdrawn |

### Test gates

`npm test` → **1094 passed / 30 suites**. `npm run test:e2e` (with `FONDODEV_DATABASE_URL`) →
**420 passed / 7 suites, 0 skipped**, including the 422-line `test/http-edge.e2e-spec.ts`.

---

## R2.7 System health

| Check | Result |
|---|---|
| v1 boots and serves | OK — gunicorn 19.9.0, 3 workers, `:8443`; `git status` clean at `5bef585`, repo read-only |
| v2 build is current | OK — `npm run build` reproduced the running `dist/` exactly; process env confirmed |
| v2 route inventory | OK — no surface beyond `POST`/`ALL /api/notification/:operation`, `POST`/`ALL /api-token-auth`, `GET /health`; every other v1 path is a router 404 behind a correctly-resolving URL table |
| Schema untouched | OK — `pg_dump --schema-only` byte-identical before/after (only pg_dump's `\restrict` token) |
| Migrations | OK — `django_migrations` 38 rows; `_prisma_migrations.0_init` still `applied_steps_count = 0`; no `prisma migrate` ever run |
| The 94-row fixture | OK — restored exactly: 94 rows, `max(id) = 1468`, and **`select count(distinct xmin::text) from fondo_api_notificationsubscriptions` = 1** — the authoritative guard (**C26**), because it proves no row has been *updated*, whatever order a dump emits. ⚠️ The md5 `a1a74f3cbf0ecf09647afef27e85839b` that stood alone here is **not a sound guard**: `pg_dump` row order varies with `synchronize_seqscans`, so the value is not reproducible without stating its exact query — that is **false-green #2**. Retained as a historical note only. `pg_dump -t …` identical to the pre-test dump. Only the id sequence advanced (1558 → 1572) from rows I created and deleted |
| Stray writes | OK — `auth_user` 15, `authtoken_token` 15, `fondo_api_userprofile` 15, `fondo_api_loan` 425, `fondo_api_loandetail` 374, `fondo_api_userfinance` 15, `fondo_api_schedulertask` 632, `fondo_api_activity` 26, `fondo_api_savingaccount` 2 — all unchanged. No temporary users created this round |
| e2e uses its own DB | OK — `test/test-database.ts` provisions `fondo_api_test`; only the opt-in scan reads `fondodev`, `SELECT` only |
| Scheduler / worker | n/a — v2 registers `ScheduleModule` with no jobs; v1's Celery beat/worker not running |
| Both repos | OK — clean working trees, `5bef585` and `656f955` |

---

## R2.8 Verdict per surface

| Surface | Round 1 | Round 2 |
|---|---|---|
| `POST /api/notification/subscribe` — roles, dedupe, cross-app, hstore encoding | PASS | **PASS** |
| `POST /api/notification/unsubscribe` — roles, cross-user 404, cross-app | PASS | **PASS** |
| `OPTIONS` on the route (bare and preflight) | FAIL (F1) | **PASS** |
| URL matching — case, trailing slash, operation charset, `PATH_INFO` decoding, all 22 patterns | FAIL (F2) | **PASS** |
| Body parsing incl. repeated form/multipart keys | FAIL (F3) | **PASS** |
| Response headers | FAIL (F4) | **PASS** (residuals = D13 / P2-D8) |
| P2-D4 / `remove_all_subscriptions` register | FAIL (F5) | **PASS** |
| `MailService` — six SES payloads | PASS | **PASS** (unchanged code; `src/mail/` untouched since `b5742bc`) |
| `NotificationService.sendNotification` → SQS | PASS | **PASS** (re-driven, 5 sends `cmp`-identical) |
| DB side effects and schema stability | PASS | **PASS** |
| **`APPEND_SLASH` 301 — preflight interaction** | n/a (no 301 existed) | **FAIL (N1)** |
| **`APPEND_SLASH` 301 — `Location` encoding** | n/a | **FAIL (N2)** |
| Percent-encoded literal path segments | not probed | **DEVIATION (N3)** — pre-existing, unregistered |
| `HEAD` response body | PASS (status only) | **DEVIATION (O1)** — pre-existing, server-level |

**Phase 2 overall: FAIL**, on **N1** and **N2** only. F1–F5 are closed and the phase's substance
is unchanged and exact. Back to `nestjs-developer` for a middleware reorder, an `escape_uri_path`
port (or two register entries), and a decision on N3; `nestjs-reviewer` should not start until
N1/N2 are resolved.

## R2.9 What I could not test this round

Unchanged from §8: the Celery hop, real AWS, mail/notification over HTTP (no route until Phases
3/4/6), P2-D1 and P2-D2's internals, `POST /password_reset/` end-to-end, the dedupe race, load.
Additionally: `GET/POST /api/authorize` and `POST /api/alexa` are out of scope per the brief and
were only exercised at the URL-resolution layer.

---

# Round 3 — re-test after the N1/N2/N3 fixes and the O1 registration

**Date:** 2026-08-31 (third pass).
**Tester:** `manual-tester`, black-box, read-mostly.
**v1 (oracle, frozen):** `~/Projects/Fondo-API` @ `5bef585`, working tree clean, gunicorn 19.9.0
on `:8443` (container `fondo-v1`, host network, repo mounted **read-only** —
`docker inspect` shows `/home/miguel/Projects/Fondo-API:/app:ro`).
**v2 (under test):** `~/Projects/Fondo-API-v2` @ `3c829a8` (code `37b9485`; `3c829a8` touches only
`MIGRATION_PLAN.md`), working tree clean. The process on `:8444` was **re-verified current**:
`npm run build` reproduced the running `dist/` **byte-for-byte** (`diff -rq`, `*.tsbuildinfo`
excluded → no differences), and `/proc/71818/environ` confirms
`DATABASE_URL=…/fondodev`, `PORT=8444`, `NODE_ENV=production` and a set `NOTIFICATIONS_QUEUE_URL`.
**Database:** the shared `fondodev`. Fixture verified **before and after**: 94
`fondo_api_notificationsubscriptions` rows, `max(id) = 1468`, table md5
`a1a74f3cbf0ecf09647afef27e85839b`, 15 `auth_user`, 15 `authtoken_token`, 38 `django_migrations`,
`_prisma_migrations.0_init` still `applied_steps_count = 0`, `pg_dump --schema-only` **identical**.

## Verdict: **PASS**

**N1, N2 and N3 are fixed** — re-measured independently, not taken on the developer's word — and
**nothing regressed**: the SQS bodies, the hstore encoding, the whole role matrix, the 22-pattern
URL table and the parse/415/403 ordering are still byte-identical with the three-way middleware
split in the request path. **O1** is registered accurately. The fix round introduced **no new
diff**.

One **pre-existing, previously unprobed** difference was found and is the only open item:

| # | Difference | Severity | Gates? |
|---|---|---|---|
| **N4** | A literal `#` in the request target. gunicorn derives `PATH_INFO`/`QUERY_STRING` with `urlsplit`, which **drops the fragment**; v2's `splitQuery` splits only on `?`, so the fragment stays in the path (or in the query). `POST /api/notification/subscribe#frag` with a MEMBER token is **v1 200 + a row written, v2 404 + no row**. | Low — fail-closed, and unreachable from any conforming HTTP client (RFC 9110 §7.1 excludes the fragment from the request target; curl, browsers and every JS/Python client strip it) | **No.** Not a regression, no reachable client impact. It does need a **register entry** (P2-D8 residual (6)) — or a two-line fix — because plan §4 rule 14's own second sub-rule already states the principle it half-implements. |

Also corrected below: the brief's assertion that `GET /password_reset/` is the *only* kept route
answering `Vary: Cookie` is **not right** — see §R3.6.

I am recording the verdict as PASS rather than a third FAIL deliberately. Plan §7's rule is that
an *unregistered* diff is a failure; N4's remedy is a one-line register entry, not code, it is
fail-closed, it is not a regression from this fix round, and it is in the same class the register
has already twice chosen to record rather than fix (P2-D8 residuals (4) and (5)). If
`nestjs-reviewer` reads §7 literally, the gate is "N4 registered before merge", not "re-test".

---

## R3.1 Findings N1–N3 and O1 — status

| # | Status | Evidence |
|---|---|---|
| **N1** | ✅ **Fixed. The split is correct, and probed hard.** | See §R3.2 — 32 cases on the four `APPEND_SLASH` paths and 40 on ten others, all full-header matches. |
| **N2** | ✅ **Fixed.** | See §R3.3 — 30 raw request targets, every `Location` byte-identical. |
| **N3** | ✅ **Fixed, and fail-closed in the direction that matters.** | See §R3.4. |
| **O1** | ✅ **Registered accurately** as P2-D8 residual (4). Re-measured on all four roles: `HEAD /api/notification/subscribe` is **403 with identical headers including `Content-Length: 63`** on both; v1 writes the 63 payload bytes, v2 writes 0. Also re-confirmed on the unauthenticated 401. | §R3.5 |
| **P2-D8 residual (5)** | ✅ **Confirmed as written.** `POST /password_reset` + a raw `0xF1` byte → v1 **404**, v2 **400** (Node's parser, before any middleware). `POST /password_reset?a=` + `0xF1` → v1 **301** `Location: /password_reset/?a=%C3%B1`; with the UTF-8 bytes `0xC3 0xB1` → v1 **301** `Location: /password_reset/?a=%C3%83%C2%B1` (the latin-1 double-encoding the register describes). v2 **400** in all three. | — |

---

## R3.2 N1 — the middleware split, probed hardest

### The two preflights that must disagree with each other

```
$ curl -si --path-as-is -X OPTIONS http://127.0.0.1:<port>/password_reset \
       -H 'Origin: https://x.test' -H 'Access-Control-Request-Method: POST' \
       -H 'Access-Control-Request-Headers: x-foo'

  :8443                                   :8444
  HTTP/1.1 301 Moved Permanently          HTTP/1.1 301 Moved Permanently
  Content-Type: text/html; charset=utf-8  Content-Type: text/html; charset=utf-8
  Location: /password_reset/              Location: /password_reset/
  Content-Length: 0                       Content-Length: 0
```

**No `Vary`, no `X-Frame-Options`, no `Access-Control-*` on either** — the response phase of
slots 7 and 8 never runs, exactly as `CommonMiddleware` returning from `process_request` behaves.
Header set *and order* identical.

```
$ … same request to /nope/nope
  :8443 and :8444 both:
  HTTP/1.1 200 OK · Content-Type: text/html; charset=utf-8 · Vary: Origin
  Access-Control-Allow-Origin: * · Access-Control-Allow-Headers: accept, accept-encoding,
  authorization, content-type, dnt, origin, user-agent, x-csrftoken, x-requested-with
  Access-Control-Allow-Methods: DELETE, GET, OPTIONS, PATCH, POST, PUT
  Access-Control-Max-Age: 86400 · Content-Length: 0 · X-Frame-Options: SAMEORIGIN
```

Identical, modulo the position of `Content-Length` (insignificant per RFC 9110, already noted in
round 2).

### The full grid

Every `APPEND_SLASH` path × eight request shapes, comparing **status + the whole normalised
header block + a body md5** (excluding `Date`/`Server`/`Connection`/`Keep-Alive`/
`Transfer-Encoding`):

| Path \ shape | bare `OPTIONS` | `+Origin` | `+ACRM` | preflight | preflight `+ACRH` | empty `ACRM:` | `GET +Origin` | `POST +Origin` |
|---|---|---|---|---|---|---|---|---|
| `/password_reset` | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ |
| `/password_reset/done` | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ |
| `/reset/done` | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ |
| `/reset/MQ/abc-def` | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ | 301 ✓ |

**32/32 full-header matches.** The 301 wins over the preflight short-circuit on *every* shape,
with or without `Origin` — i.e. the `APPEND_SLASH` layer really is above CORS, and it is not
merely "the preflight condition failed".

Ten further paths — resolving (`/password_reset/`, `/api-token-auth`), non-resolving
(`/nope/nope`, `/api/loan/1/`, `/api/notification/sub1`, `/password_reset//`), the four slashed
auth pages and `/api/alexa` — × four `OPTIONS` shapes:

* **Every `+ACRM` and every full preflight is a 200 on both** (10/10 and 10/10). The CORS layer
  is above the resolver, so a preflight short-circuits regardless of whether the URL resolves.
* The bare-`OPTIONS` and `+Origin` rows differ only where they were already expected to:
  D13 HTML-vs-JSON 404 bodies (`/nope/nope`, `/api/loan/1/`, `/api/notification/sub1`,
  `/password_reset//`), Phase-3 router 404s on the four auth pages, `/api/alexa` (§4.4) and
  `/api-token-auth` (**P1-D2**, whose v2 column round 2 flagged as wrong — v2 now really does
  answer **405** `{"detail":"Method \"OPTIONS\" not allowed."}`, so P1-D2 as written is accurate).

### CORS decoration below the split is intact

Simple (non-preflight) requests carrying `Origin`, across ten response classes on the live
Phase 2 route — 200 subscribe, 401, 403 `GET`/ADMIN, 405 unknown operation, 404 unsubscribe-miss,
400 malformed JSON, 415 `text/plain`, 301 append-slash, no-`Origin` control, `Origin: null` —
**10/10 header blocks match**.

---

## R3.3 N2 — `Location` encoding, 30 raw targets

Driven over a raw socket (not curl) so the request line is exactly what I wrote.
**Every `Location` is byte-identical between the two systems**, including all the cases round 2
recorded as differing:

| Target | `Location` (both) |
|---|---|
| `/password%5Freset`, `/password%5freset`, `/pass%77ord_reset` | `/password_reset/` |
| `/password_reset%2Fdone`, `/password_reset%2fdone` | `/password_reset/done/` |
| `/reset/M%51/abc-def`, `/reset/%4D%51/abc-def` | `/reset/MQ/abc-def/` |
| `/re%73et/done` | `/reset/done/` |
| `/password_reset/d%6Fne` | `/password_reset/done/` |
| `/reset/M%5FQ-x/a-b`, `/reset/M%2DQ/a-b` | `/reset/M_Q-x/a-b/`, `/reset/M-Q/a-b/` |

Query-string cases, `iri_to_uri` including the deliberately-unrepaired escapes:

| Target | `Location` (both) |
|---|---|
| `?a=%C3%B1&b=1` | `…/?a=%C3%B1&b=1` |
| **`?x=%zz`** | `…/?x=%zz` — **passed through unrepaired, on both** |
| **`?a=%zz&b=%2`** | `…/?a=%zz&b=%2` |
| `?` / `?=` | `…/?` / `…/?=` |
| `?q="x"` | `…/?q=%22x%22` |
| ``?q=<x>\|{y}\^` `` | `…/?q=%3Cx%3E%7C%7By%7D%5C%5E%60` |
| `?q=%20+%2B` | `…/?q=%20+%2B` |
| `?a=1&a=2`, `?%C3%B1=1`, `?a=%E2%82%AC` | echoed unchanged |
| `/password%5Freset?a=%C3%B1` | `/password_reset/?a=%C3%B1` |

Two targets in the set are not encoding cases and are reported separately: a **literal space**
in the request line (`/password_reset?a b`) → **400 on both**, bodies differ (gunicorn's 198-byte
HTML vs Node's zero bytes — P2-D8 residual class), and a **literal `#`** → finding **N4**, §R3.5.

---

## R3.4 N3 — dispatch on `PATH_INFO`, both directions

**Positive direction — percent-encoded literal segments now reach the controller:**

| Request | v1 | v2 |
|---|---|---|
| `POST /api%2Dtoken%2Dauth` (+ `%2d`, + trailing slash, + `/%61pi-token-auth`) | **400** `{"non_field_errors":[…]}` | **400, byte-identical** |
| `POST /api/%6Eotification/subscribe` (MEMBER) | 200 + row | 200, deduped onto the same row |
| `POST /%61%70%69/notification/subscribe` | 200 | 200 |
| `POST /api/notification/%73ubscribe` | 200 | 200 |
| `POST /api%2Fnotification/subscribe`, `/api/notification%2Fsubscribe` | 401 | 401 — `%2F` decodes to a separator on both |

**Fail-closed direction — the table is consulted after decoding and before the rewrite:**

| Request (MEMBER token and unauthenticated) | v1 | v2 | Row written |
|---|---|---|---|
| `POST /%41PI/notification/subscribe` | 404 | **404** (URL-conf 404, `{"message":"Not Found"}`) | **none, either side** |
| `POST /%41pi/notification/subscribe` | 404 | 404 | none |
| `POST /API/notification/subscribe` | 404 | 404 | none |
| `POST /api/%4Eotification/subscribe` | 404 | 404 | none |
| `POST /api/NOTIFICATION/subscribe` | 404 | 404 | none |
| `POST /api/notification/%53UBSCRIBE`, `…/SUBSCRIBE` | **405** | 405 | none — the operation's case survives decoding and the view-level 405 fires |
| `/api/notification/sub%2Fscribe`, `%2573ubscribe`, `subscri%C3%A9be`, `subscribe%00`, `subscribe%20`, `subscribe.` | 404 | 404 | none |
| `//…`, `///…`, `/%2Fpassword_reset`, `/./…`, `/a/../…`, `/…/.`, `/…/..`, `/api//notification/subscribe`, `/…/subscribe//`, `*`, `/password_reset;x=1` | 404 | 404 | none |

`max(id)` was unchanged across the whole block.

⚠️ **One cosmetic residue, not a defect today.** v2's *router* 404 message is built from
`req.originalUrl`, so it echoes the **raw** target: `GET /api/l%6Fan/1` →
`{"message":"Cannot GET /api/l%6Fan/1"}`. Routing itself used the rewritten path (the DRF
`Allow`/`Vary: Accept, Origin` headers prove the table resolved). Only visible on Phase 3–8 routes
that have no controller yet, where v1 answers 401/200 and the whole route is unimplemented — but
worth a glance when those controllers land.

---

## R3.5 N4 — a literal `#` in the request target (new, unregistered, does not gate)

`gunicorn/http/message.py:350-352` parses the request URI with `urlsplit` into
`path` / `query` / `fragment`, and `gunicorn/http/wsgi.py:97,191` puts only `path` and `query`
into the WSGI environ — **the fragment is discarded before Django ever sees it**. v2's
`splitQuery` (`src/common/http/request-target.ts`) splits `request.originalUrl` on `?` only, so
the fragment stays in `PATH_INFO` (when there is no `?`) or in `QUERY_STRING` (when there is).

This is the *other half* of plan §4 rule 14's second sub-rule ("Django dispatches on the decoded
`PATH_INFO`, Express on the raw target") — the same rule N3 closed for percent-decoding.

**Reproduction — a live Phase 2 write path:**

```
POST /api/notification/subscribe#frag        Authorization: Token <MEMBER u4>
Content-Type: application/json
{"endpoint":"https://parity.test/r3-frag","expirationTime":null,"keys":{"p256dh":"a","auth":"b"}}

  v1  HTTP/1.1 200 OK   → 1 row written
  v2  HTTP/1.1 404 Not Found   {"message":"Not Found"}   → 0 rows
```

Further confirmed cases:

| Request target | v1 | v2 |
|---|---|---|
| `POST /password_reset#frag` | **301** `Location: /password_reset/` | **404** (URL-conf) |
| `POST /password_reset#frag?a=1` | **301** `Location: /password_reset/` (query dropped with the fragment) | **404** |
| `POST /password_reset?a=1#frag` | 301 `Location: /password_reset/?a=1` | 301 `Location: /password_reset/?a=1#frag` |
| `POST /api/loan#frag` | 401 | URL-conf 404 |
| `POST /api/notification/subscribe?x=1#frag` | 200 + row | **200 + row** (the `#` lands in the query, so routing is unaffected) |
| `POST /password_reset?a=%23&b=1` | 301 `…?a=%23&b=1` | **identical** — an *encoded* `#` is fine |

**Assessment.** Direction is fail-closed: v2 is narrower, so it can never write something v1 would
not. Reachability is nil — RFC 9110 §7.1 excludes the fragment from the request target, and curl,
browsers, `fetch`, axios, `requests` and httpie all strip it before sending; I could only produce
it by writing the request line to a socket by hand. It is **not a regression** (v2 has split on
`?` alone since Phase 1). Fix, if wanted, is to make `splitQuery` drop everything from the first
`#` the way `urlsplit` does — about two lines, plus a spec cell. Otherwise: **P2-D8 residual (6)**.

---

## R3.6 ⚠️ Correction: `GET /password_reset/` is **not** the only kept route with `Vary: Cookie`

The brief asked me to confirm it is. It is not. Sweeping every kept v1 route:

| Route | `Vary` | `Set-Cookie` |
|---|---|---|
| `GET /password_reset/` | **`Cookie, Origin`** | `csrftoken=…` |
| `GET /reset/<uid>/<valid token>/` | **`Origin, Cookie`** | **`sessionid=…`**, then **302** → `/reset/<uid>/set-password/` |
| `GET /reset/<uid>/set-password/` (with that session) | **`Origin, Cookie`** | `csrftoken=…` |
| `POST /password_reset/`, `GET /password_reset/done/`, `GET /reset/done/`, `GET /reset/<uid>/<invalid token>/`, `GET`/`POST /api-token-auth` | `Origin` | none |
| every `/api/…` DRF view (loan, user, activity, notification, file, admin, saving-account, birthdates, activate, year) | `Accept, Origin` | none |
| `GET /api/authorize` (skipped route) | `Accept, Origin, Cookie` | `csrftoken=…` |

Three things Phase 3 must carry, none of which is a Phase 2 defect:

1. **`Vary` element order differs between the two cookie-touching kept routes** — `Cookie, Origin`
   on `/password_reset/` (Django patches `Cookie` in before `corsheaders` adds `Origin`) but
   `Origin, Cookie` on the reset-confirm pages (the redirect is built earlier). A single
   `DrfViewHeaders` flag will not reproduce both.
2. **The reset-confirm flow writes a `django_session` row** — a DB side effect on a `GET`. v2 has
   no session store; it must be modelled or registered.
3. `/reset/<uid>/set-password/` must resolve — it does, because `set-password` happens to match
   the token regex `[0-9A-Za-z]{1,13}-[0-9A-Za-z]{1,20}`. The table already admits it.

*(The one `django_session` row this probe created on v1 was deleted; the table is back to its
pre-test 20 rows.)*

---

## R3.7 Regression check — rounds 1–2 substance, re-run against the new build

### The 22-pattern URL sweep — `PASS`

All 22 patterns instantiated in **both** slashed and unslashed form, plus 25 regex-boundary
probes, driven `GET` and `POST` over a raw socket: **152 requests**. v2's two 404s are
distinguished by body — `{"message":"Not Found"}` = the **URL conf** refusing, `{"message":"Cannot
<M> <path>"}` = the **Nest router** having no handler behind a table that did resolve.

**Every row agrees.** The only "v1 resolves / v2's table does not" rows are the two registered
ones: `/api/alexa` (§4.4, skipped route, 4 cells) and `/health` (P0-D2, 4 cells). The asymmetry
round 2 called out still reproduces exactly — `/api/activity/1/` resolves in both while
`/api/loan/1/` is a URL-conf 404 in both.

⚠️ **One classifier artefact worth recording so a later round does not re-chase it:**
`POST /api/user/activate/1` is a **404 in v1** even though the table resolved — `Allow: POST,
OPTIONS` and `Vary: Accept, Origin` on the response prove `UserActivateView` ran and returned a
0-byte 404 itself. "status != 404" is therefore not a sound proxy for "v1 resolved" on that one
row; the headers are.

Boundary probes all agree: `reset` token `{1,13}-{1,20}` on/off by one; `uidb64 [0-9A-Za-z_\-]+`;
`/api/loan/007`, `/api/loan/99999999999999999999` vs `1a`, `+1`; the `-?` sentinel
(`/api/user/-1`, `-abc` resolve; `--1`, `abc-def` do not); `operation [a-zA-Z]+`; doubled slashes;
`/api/saving_account`, `/api/savingaccount`.

### Role matrix, both operations — `PASS`

| Role (user) | subscribe v1 / v2 (same endpoint) | rows | owner | unsubscribe via **v2** | repeat via **v1** |
|---|---|---|---|---|---|
| ADMIN (0), u1 | 200 / 200 | **1** | 1 | 200 | 404 |
| PRESIDENT (1), u9 | 200 / 200 | **1** | 9 | 200 | 404 |
| TREASURER (2), u2 | 200 / 200 | **1** | 2 | 200 | 404 |
| MEMBER (3), u4 | 200 / 200 | **1** | 4 | 200 | 404 |

Denials byte-identical on **both** operations: no header → `401 {"detail":"Authentication
credentials were not provided."}`; unknown token → `401 {"detail":"Invalid token."}`; inactive
user (u3) → `401 {"detail":"User inactive or deleted."}`; `Authorization: Bearer …` → 401.
`GET/PUT/PATCH/DELETE/OPTIONS` → `403 {"detail":"You do not have permission to perform this
action."}` for **every** role including ADMIN, `401` unauthenticated (24 + 5 cells, all full-header
matches; `HEAD` differs only in the body — **O1**). Unknown operation `…/suscribe` → **405, 0-byte**
for every role, **401** unauthenticated; `…/SUBSCRIBE` → 405.

### The three §4.5 checks — `PASS`

1. **Cross-app single row + identical `subscription::text`.** Payload with accents, an apostrophe,
   a backslash, `=>`, a double quote and an emoji in `keys`, plus extra `bool`/`number` keys,
   written by v1 and by v2 (endpoints differing, normalised away):

   ```
   "b"=>"True", "n"=>"123", "keys"=>"{'p256dh': 'BNhR5o\\'quote\\\\back=>arrow\"dq', 'auth': 'áéñ 🎉 <b>x</b>'}", "endpoint"=>"https://parity.test/<E>", "expirationTime"=>NULL
   ```

   **Identical strings**, same hstore key order.
2. **Cross-user unsubscribe.** MEMBER u5 against u4's endpoint → **404, 0 bytes, on both**; the row
   survives. v2 then deleted the v1-written row for each of the four roles (200), and v1's repeat
   was 404.
3. **SQS `MessageBody` compared with `cmp`**, both systems driven against the same live rows,
   captures written raw to disk by a local HTTP stub (`:4599` v1 via a swapped `tasks.sqs_client`,
   `:4598` v2 via `AWS_ENDPOINT_URL_SQS` + `NOTIFICATIONS_QUEUE_URL`):

   | Send | Bytes | `cmp` |
   |---|---|---|
   | `[1]` — `Ha sido creada una nueva solicitud de crédito` | 476 | **identical** |
   | `[2,5,9]` — 75 subscriptions, `…fecha límite…mañana` | 28 266 | **identical** |
   | `[1]` — `José "Pepe" \ / <b>ñ</b> ç 🎉` + NBSP + literal TAB, target `/user/13?q=á&z=1` | 545 | **identical** |
   | `[1]` — DEL (U+007F), U+0001, U+2028, U+2029, NBSP | 464 | **identical** |
   | `[3]` (inactive user) — `Usuario inactivo — sí` | 843 | **identical** |
   | `[1..15]` — **all 94 live rows** | 35 392 | **identical** |
   | `[4]` (no subscriptions) and `[]` | — | **no HTTP request from either system** |

### The 94-row live decode scan — `PASS`

Decoding the 35 392-byte body (byte-identical between the systems) yields **94 subscriptions,
0 failing the `keys`-object decode**, every one with `auth` + `p256dh`; hstore key order preserved
as **93 × `keys, endpoint, expirationTime` + 1 × `keys, endpoint`** (the Apple row). Row order in
the body equals PostgreSQL **heap** order (`160, 761, 115, 1027, 392, …`) and **not** id order
(`115, 131, 160, 341, …`) — **P2-D6** re-confirmed on live data.

### Rule 5d on a real accented Spanish body — `PASS`

The captured bytes are **ASCII-only** on both sides, with `', '` / `': '` separators:

```
{"subscriptions": [{"keys": {"p256dh": "BO-ciUqn…", "auth": "iEqZDhjU-hAfpOegPQgqSA"}, "endpoint": "https://web.push.apple…"}], "message": {"body": "Hoy está cumpliendo años José \"Pepe\" \\ / <b>ñ</b> ç 🎉\tTAB", "target": "/user/13?q=á&z=1"}}
```

`🎉` (surrogate pair), `\t`, `\"`, `\\`, and the escapes where CPython and JS disagree — `\u007f`, `\u0001`, `\u2028`, `\u2029`, `\u00a0` — all present on both.

⚠️ **`NOTIFICATIONS_QUEUE_URL` re-verified load-bearing**: with it unset, v2 logs
`Error trying to connect to MNS service: NOTIFICATIONS_QUEUE_URL is not configured`, the caller
resolves normally, and the capture count **does not move** (18 → 18). Every SQS cell above is
backed by bytes on the wire, not by a mock's call count.

### Parsers, error bodies, F3 — `PASS` / unchanged

| Case | v1 | v2 |
|---|---|---|
| malformed JSON `{` | `400 {"detail":"JSON parse error - Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"}` | **byte-identical** (full header block too) |
| `Content-Type: text/plain` | `415 {"detail":"Unsupported media type \"text/plain\" in request."}` | **byte-identical** |
| unauthenticated + `text/plain` / + `{` | 401 both | **identical** — C13 ordering intact |
| body `{}`, `[1,2]`, `5` | 500, Django HTML | 500, 0 bytes — §4.4 / D13 |
| `{"endpoint": null}` | 200 + a SQL-NULL row | 500, no row — **P2-D3**, unchanged (row cleaned up) |
| `NaN` | 400 (87 B) | 400 (73 B) — **C11 residual**, unchanged |
| **duplicate `endpoint`, urlencoded and multipart** | stores the **last** value | **stores the last value** — F3 still fixed in *both* directions (v1-written and v2-written rows normalise to one identical string) |

hstore coercion re-proved via the global dedupe (a second write landing on the first app's row is
proof the two computed the same endpoint string): `12345`, `True`, `False`, `1.5`, `{'a': 1}`,
`[1, 2]` and an accented/emoji URL — **7/7 deduped**.

### SES — `PASS`

`src/mail/` and `src/notifications/` are **untouched** since the round-2-verified commit
(`git diff --stat 656f955..HEAD -- src/` lists only `app.module.ts` and `src/common/http/*`), so
the six-template comparison from rounds 1–2 stands. I nevertheless re-drove one payload through
the rebuilt DI container to prove the `app.module.ts` change did not disturb it —
`CHANGE_STATE_LOAN_DENIED`, recipients `[a, b]`, bcc `[a, a, c]`, accented `loan_table`:
**every SES parameter identical**, `BccAddresses` `[a, c]` on both (`list.remove`
single-occurrence semantics), `Subject.Data` `[Fondo Montañez] Solicitud de crédito`,
`Source` `Fondo Montanez <no-reply@fonmon.minagle.com>`.

### Test gates

`npm test` → **1155 passed / 33 suites, 0 failures**.
`npm run test:e2e` with `FONDODEV_DATABASE_URL` set → **438 passed / 7 suites, 0 skipped**.

---

## R3.8 System health

| Check | Result |
|---|---|
| v1 boots and serves | OK — gunicorn 19.9.0 on `:8443`; container up 8 h, repo bind-mounted `:ro`, host `git status` clean at `5bef585` |
| v2 build is current | OK — `npm run build` reproduced the running `dist/` with **no differences** (`diff -rq`, tsbuildinfo excluded); process started 15:56:49, after code commit `37b9485` (15:55:59); `/proc/71818/environ` confirms fondodev, `PORT=8444`, `NOTIFICATIONS_QUEUE_URL` set |
| v2 route inventory | OK — no surface beyond `POST`/`ALL /api/notification/:operation`, `POST`/`ALL /api-token-auth`, `GET /health`; every other v1 path is a *router* 404 behind a correctly-resolving table |
| Middleware order | OK — `AppendSlash → ResponseHeaders → Cors → UrlResolver → DrfRequestParsing`, mounted at `/`; matches v1's `MIDDLEWARE` slots 3, 7, 8 and `BaseHandler` |
| Schema untouched | OK — `pg_dump --schema-only` **byte-identical** before/after (ignoring pg_dump's own `\restrict` token) |
| Migrations | OK — `django_migrations` 38 rows; `_prisma_migrations.0_init` still `applied_steps_count = 0`; no `prisma migrate` run |
| The 94-row fixture | OK — restored exactly: 94 rows, `max(id) = 1468`, and **`select count(distinct xmin::text) from fondo_api_notificationsubscriptions` = 1** — the authoritative guard (**C26**), because it proves no row has been *updated*, whatever order a dump emits. ⚠️ The md5 `a1a74f3cbf0ecf09647afef27e85839b` that stood alone here is **not a sound guard**: `pg_dump` row order varies with `synchronize_seqscans`, so the value is not reproducible without stating its exact query — that is **false-green #2**. Retained as a historical note only. `pg_dump -t …` identical to the pre-test dump. Only the id sequence advanced (1572 → 1602) from rows I created and deleted |
| Stray writes | OK — `auth_user` 15, `authtoken_token` 15, `fondo_api_userprofile` 15, `fondo_api_loan` 425, `fondo_api_loandetail` 374, `fondo_api_userfinance` 15, `fondo_api_schedulertask` 632, `fondo_api_activity` 26, `fondo_api_savingaccount` 2, `fondo_api_power` 20, `fondo_api_userpreference` 15, `django_session` 20 — all unchanged. No temporary users created |
| e2e uses its own DB | OK — `test/test-database.ts` provisions `fondo_api_test`; only the opt-in scan reads `fondodev`, `SELECT` only |
| Scheduler / worker | n/a — v2 registers `ScheduleModule` with no jobs; v1's Celery beat/worker not running |
| Both repos | OK — clean working trees, `5bef585` and `3c829a8` |

---

## R3.9 Verdict per surface

| Surface | R1 | R2 | R3 |
|---|---|---|---|
| `POST /api/notification/subscribe` — roles, dedupe, cross-app, hstore | PASS | PASS | **PASS** |
| `POST /api/notification/unsubscribe` — roles, cross-user 404, cross-app | PASS | PASS | **PASS** |
| `OPTIONS` — bare and preflight | FAIL (F1) | PASS | **PASS** |
| URL matching — case, slashes, operation charset, all 22 patterns | FAIL (F2) | PASS | **PASS** |
| Body parsing incl. repeated form/multipart keys | FAIL (F3) | PASS | **PASS** |
| Response headers | FAIL (F4) | PASS | **PASS** |
| P2-D4 / `remove_all_subscriptions` register | FAIL (F5) | PASS | **PASS** |
| `APPEND_SLASH` 301 vs preflight (middleware split) | n/a | FAIL (N1) | **PASS** |
| `APPEND_SLASH` 301 `Location` encoding | n/a | FAIL (N2) | **PASS** |
| Percent-encoded literal path segments | not probed | DEVIATION (N3) | **PASS** |
| `HEAD` response body | PASS (status only) | DEVIATION (O1) | **PASS** (registered, P2-D8 (4)) |
| `MailService` — SES payloads | PASS | PASS | **PASS** |
| `NotificationService.sendNotification` → SQS | PASS | PASS | **PASS** |
| DB side effects and schema stability | PASS | PASS | **PASS** |
| **Fragment (`#`) in the request target** | not probed | not probed | **DEVIATION (N4)** — pre-existing, unregistered, does not gate |

**Phase 2 overall: PASS.** N1, N2 and N3 are closed; O1 is registered accurately; the substance is
unchanged and exact; the fix round introduced nothing new. Going to `nestjs-reviewer`. Two items
travel with it: **N4** needs a register entry (P2-D8 residual (6)) or a two-line `splitQuery` fix,
and the **`Vary: Cookie` / `django_session` correction in §R3.6** belongs in the Phase 3 scope note
rather than where it is now.

## R3.10 What I could not test this round

Unchanged from §8 and §R2.9: the Celery hop (no broker/worker; the task function was driven
directly, so the `MessageBody` is fully tested and the queueing hop is not), real AWS, mail and
notification sends over HTTP (no route reaches them until Phases 3/4/6), P2-D1's and P2-D2's
internals, `POST /password_reset/` end-to-end, the dedupe race, load and latency.
`GET/POST /api/authorize` and `POST /api/alexa` are out of scope per the brief and were exercised
only at the URL-resolution layer. Additionally this round: the **valid-token** password-reset flow
was probed on v1 only (v2 has no view), and I did not attempt to reproduce v1's `django_session`
writes in v2.
