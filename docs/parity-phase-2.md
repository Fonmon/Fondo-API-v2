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
