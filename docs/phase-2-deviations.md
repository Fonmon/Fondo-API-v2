# Phase 2 — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5, `docs/phase-0-deviations.md` and
`docs/phase-1-deviations.md`.
Audience: `nestjs-reviewer` (deviations and judgment calls), `manual-tester` (§4 — everything
it must expect as a non-failure, plus how to run the parity checks), and whoever maintains
`MIGRATION_PLAN.md` (§5 — corrections to fold back).

**Scope shipped:** `MailService` on `@aws-sdk/client-ses` + the six Spanish templates;
`NotificationSubscriptionRepository` (the hstore repository); `NotificationService`;
`NotificationPublisher` (SQS); `POST /api/notification/<subscribe|unsubscribe>`.
Also closed: review conditions **C10**, **C11**, **C12**, **C13**.

---

## 1. Registered deviations from v1

| # | v1 behavior | v2 behavior | Rationale |
|---|---|---|---|
| **P2-D1** | `send_mail` **mutates the caller's `bcc` list** in place (`bcc.remove(recipient)`), and its `bcc=[]` default argument is Python's shared-mutable-default. | v2 copies the array and never mutates the caller's. | Unobservable. `.remove` only ever *shortens* the shared default, so it stays empty; and all three call sites pass a freshly built list from `get_users_attr('email', [0,2])` (`services/loan.py:98,101`) or a literal. The **removal semantics** are ported exactly — `list.remove` deletes only the first occurrence, which matters because two pairs of live members share an email address. |
| **P2-D2** | `save_subscription` does `UserProfile.objects.get(id=user_id)` before inserting, purely to obtain the FK; a missing profile raises `DoesNotExist` → 500. | v2 skips the lookup and lets the foreign key enforce it → 500. | Same status, one query fewer. Unreachable in practice: `RolesGuard` already 403s a user with no `fondo_api_userprofile` row (Phase 1). Body differs only in the way already registered as **D13** (Django's HTML error page vs v2's JSON/empty). |
| **P2-D3** | `subscription['endpoint']` with a `None` value would be stored as SQL NULL and queried with `IS NULL`. | v2 returns **500** for `{"endpoint": null}`. | Reproducing it needs a *different SQL statement* for a payload no browser can produce (`PushSubscription.endpoint` is non-nullable in the Push API). A non-`null` non-string endpoint **is** reproduced — coerced with `pythonStr`, matching `HStoreField.get_prep_value`. |
| **P2-D4** | `NotificationService.remove_all_subscriptions` exists. | Ported, but **no caller** — as in v1, where it is also dead (verified across `fondo_api/`). | Kept so the service surface matches and Phase 3's soft delete has the obvious hook. Flagged so it is not read as code that crept in. |
| **P2-D5** | v1's URL regex is `^api/notification/(?P<operation>[a-zA-Z]+)/?$`. An operation containing a digit fails **URL resolution**, so Django 404s **before authentication runs**. | v2 matches any segment in the router and rejects a non-`[a-zA-Z]+` operation inside the handler → same 404 **status** for an authenticated caller, but an **unauthenticated** `POST /api/notification/sub1` is a **401** where v1 is a 404. | Express 5 / path-to-regexp v8 dropped inline parameter patterns, so the constraint cannot live in the route. Fixing the ordering needs a URL-pattern layer that runs before the guards — which is exactly the shape of the open **C9** work (trailing slashes), deliberately deferred to Phase 3 where v1's URL table gets transcribed properly. **Routed to C9, not left silent.** |
| **P2-D6** | `NotificationSubscriptions.objects.filter(user_id__in=…)` emits no `ORDER BY`; the row order in the SQS body is PostgreSQL's heap order. | v2 emits the same `IN (…)` with no `ORDER BY`. | Recorded as a deviation *from the obvious implementation*, not from v1 — see §2.3. Adding `ORDER BY id` would have **broken** parity. |
| **P2-D7** | v1's SQS publish happens in a Celery worker with **no retry**; a failure is logged and the message lost. | v2 publishes inline with **3 attempts and exponential backoff** (200 ms, 400 ms). | Plan Phase 2, condition 1 — authorised in advance. Strictly an improvement; the swallow semantics at the boundary are unchanged (condition 2). |

Nothing else in Phase 2 departs from v1.

---

## 2. Judgment calls where v1 was ambiguous or silent

### 2.1 ⚠️ `json.dumps` is not `JSON.stringify`, and the difference is live on every message

The plan's Phase 2 parity criterion is *"SQS message bodies byte-identical for the same
input"*. `fondo_api/celery/tasks.py:19` sends `json.dumps(message['content'])`. CPython's
defaults differ from `JSON.stringify` in two ways, **both of which fire on every notification
this fund sends**:

| | `json.dumps` | `JSON.stringify` |
|---|---|---|
| separators | `', '` and `': '` — with spaces | `','` and `':'` |
| non-ASCII | `ensure_ascii=True` → `é` | literal `é` |

Every message body is Spanish and accented — `"Ha sido creada una nueva solicitud de
crédito"` (`services/loan.py:52`), `"Hoy está cumpliendo años …"` (`services/user.py:279`),
`"Recuerde que la fecha límite de pago …"` (`services/loan.py:307`). So the naive
implementation would have produced a message the Lambda still parses but that is **not the
same bytes**, on the single criterion this phase is graded against.

`src/common/utils/python-json-dumps.ts` ports it. Every expected string in its spec was
captured from `python:3.9-slim`, including the cases where CPython and JS disagree beyond the
two above: DEL (`\x7f`) is escaped by CPython and not by JS, and `NaN`/`Infinity` are written
as bare tokens rather than becoming `null`.

**This affects Phase 7 too** (the scheduler publishes through the same path) and any future
SQS producer.

### 2.2 ⚠️ hstore key order is preserved because it reaches the wire — and it is *not* alphabetical

PostgreSQL returns hstore entries ordered by (key length, then bytes), so every live
subscription reads back as `keys`, `endpoint`, `expirationTime` (4 < 8 < 14). psycopg2 builds
a Python dict in that order, Python 3.7+ dicts are ordered, and `json.dumps` walks insertion
order. The order therefore lands in the SQS body verbatim. `parseHstore` preserves it,
`decodePushSubscription` replaces `keys` **in place** rather than re-adding it, and
`pythonJsonDumps` does not sort. An e2e test pins `['keys', 'endpoint', 'expirationTime']`.

### 2.3 ⚠️ Adding `ORDER BY id` would have broken parity — verified against the live table

`NotificationSubscriptions` has no `Meta.ordering`, so Django emits no `ORDER BY` and v1
serialises whatever heap order PostgreSQL returns. The instinct is to add `ORDER BY id` for
determinism. On `fondodev` that is **wrong**: the heap order for
`WHERE user_id IN (2,5,9)` starts `160, 761, 1027, 783, 710, …` while id order starts
`160, 677, 710, 715, …`. The table has been updated enough for the two to diverge.

So the repository emits `IN (…)` with no `ORDER BY`, exactly as Django does. Verified that
`IN (2,5,9)` and `= ANY(ARRAY[2,5,9])` normalise to the identical plan (`Seq Scan … Filter:
(user_id = ANY ('{2,5,9}'::integer[]))`), so the parameterised form is safe. Both apps run the
same query against the same table and therefore track each other.

### 2.4 The `{% host %}` template tag has **zero call sites**

`fondo_api/templatetags/env_var.py` registers `{% host %}` → `os.environ.get('HOST_URL_APP')`.
**No template in v1 uses it** (grepped across `fondo_api/templates/`). The activation email
takes the same value as an ordinary context variable instead — `services/user.py:51` passes
`'host_url': os.environ.get('HOST_URL_APP')`. The brief asked for the tag to become a `host`
template variable from config, so `EmailTemplateRenderer` injects `it.host` into every render;
it is currently unused, exactly as in v1. **Correction for the plan** (§Phase 2 describes the
tag as if templates used it).

### 2.5 Django's three template-rendering rules, reproduced rather than "fixed"

Captured from a real `Django==2.2.27` render, not assumed:

* `{% autoescape off %}` — **nothing is HTML-escaped**. `{{loan_table}}` is a whole `<table>`.
* Values are rendered with `str()`, so **`None` renders as the four characters `None`**.
* A **missing** variable renders as the **empty string** (`string_if_invalid` default), not
  `undefined`.

The typed `EmailTemplateParams` map makes the last two hard to hit, but both are implemented
and tested against captured Django output, so a `null` behaves identically in both systems.

### 2.6 Subjects are byte-identical file copies, and their missing trailing newline is load-bearing

`render_to_string('…/x_subject.txt')` on a template with no tags returns the file verbatim.
v1's five `.txt` subject files carry **no trailing newline**, so the SES `Subject.Data` is
`'[Fondo Montañez] Test email'` and not `'…email\n'`. The files in `src/mail/templates/` are
byte-for-byte copies; `email-template.renderer.spec.ts` asserts each subject exactly *and*
that it does not end in `\n`, so an editor that "helpfully" adds one fails the build.

### 2.7 A view-level 405 is not DRF's 405

`NotificationView.post`'s fallthrough is `Response(status=HTTP_405_METHOD_NOT_ALLOWED)` — an
**empty body**, not `{"detail": "Method \"POST\" not allowed."}`. `ApiException.empty(405)`
produces that; `DrfException.methodNotAllowed` produces the other. Both live in this
controller and they are not interchangeable. Cross-cutting rule 1's "two envelopes" point,
made concrete.

### 2.8 The `@All()` fallback on this controller exists for the **403**, not the 405

`list_permissions['NotificationView']` declares only `POST`. Every other method — `GET`,
`PUT`, `PATCH`, `DELETE`, **and `OPTIONS`** — misses the lookup, hits
`APIRolePermission`'s bare `except: return False`, and is a **403 for every role including
ADMIN**. That happens inside `APIView.initial()`, *before* `dispatch` could raise
`MethodNotAllowed`, so a 405 is **unreachable** on this route in v1.

In Nest the router 404s an unmapped method **before any guard runs**, so without the `@All()`
fallback v2 would answer 404 where v1 answers 403. **Every Phase 3–8 controller needs the
same fallback for the same reason** — plan rule 12 states the 405 motivation; this is the
stronger one.

### 2.9 `pending_test_send_notification` was not revived as written

v1's fifth notification test is prefixed `pending_` and never runs. It patches
`requests.post`, which is dead code from the pre-SQS web-push design — the current
`send_notification` path never calls `requests`. Reviving it verbatim would have asserted
nothing. The behaviour it gestured at (send with a real subscription in the table) is covered
properly in `test/notification.e2e-spec.ts` → *send_notification*, against the SQS boundary
v1 actually uses.

### 2.10 The publish is deliberately **outside** any transaction, and cannot accidentally move inside

Plan Phase 2, condition 3. `NotificationService.sendNotification` takes no transaction client
and `NotificationPublisher.publish` is not reachable from one; both carry a ⚠️ comment saying
so. Phases 3, 4 and 6 must call `sendNotification` **after** their `$transaction` has
committed — v1's three `.delay()` sites all sit outside `transaction.atomic()`, and moving the
publish inside would let an SQS outage roll back loan creations.

---

## 3. Review conditions closed

| # | What it required | How it was closed |
|---|---|---|
| **C10** | The `@All()` 405 fallback and handlers that never read `request.data` must bypass the parser interceptor. | New `@DrfNoRequestData()` marker + `DRF_NO_REQUEST_DATA_KEY`, honoured first thing in `DrfParserInterceptor.intercept`. Applied to `AuthController.methodNotAllowed` and `NotificationController.methodNotAllowed`. Both R1 regressions fixed and pinned by e2e cells: `PUT /api-token-auth` + `text/plain` → **405** (was 415), `PATCH /api-token-auth` + `{` → **405** (was 400); a positive control proves `POST` still 415s, so the marker is what changed. The negotiation itself is extracted as the exported `assertRequestDataParsable(request, parsers)` — the piece **`UserAppsView.post` needs in Phase 3**, where the `birthdates` branch must not negotiate and the `power` branch must. R2's three v1 handlers are named in the decorator's doc comment. |
| **C11** | `express.json({strict:false})` + a DRF-shaped non-dict body error; correct the mislabelled parse-error branch; register the >2.5 MB JSON tightening. | `strict: false` set. Six e2e cells pin the DRF bodies for `5`, `1.5`, `"abc"`, `true`, `null`, `[1,2]` → `{"non_field_errors":["Invalid data. Expected a dictionary, but got <int\|float\|str\|bool\|NoneType\|list>."]}`, which is what v1 returns (the DTO layer already produced the message; strict mode was preventing it from ever being reached). `describe()` now branches on **which parser ran**: JSON `SyntaxError` → CPython's message, multipart → `Multipart form parse error - …`, anything else (i.e. `PayloadTooLargeError`) → DRF's own `ParseError.default_detail`, `'Malformed request.'`. The >2.5 MB tightening is registered in the middleware doc comment. ⚠️ **One residual, deliberately not closed:** CPython's `json.loads` accepts `NaN`/`Infinity`/`-Infinity` and `JSON.parse` does not, so those three bodies remain a 400 parse error in v2 vs a `got float` serializer error in v1. Closing it needs a hand-written JSON *parser*, not a flag. |
| **C12** | Add `express` and `multer` to `dependencies`. | Added at the exact versions `@nestjs/platform-express@12.0.1` resolves — `express@5.2.1`, `multer@2.2.0` — so npm cannot dedupe them apart and hand the adapter and the middleware two Express instances (which would silently unset C2's `json replacer` and render `"1000"` where DRF renders `1000`). |
| **C13** | One e2e cell proving 403 precedes 415/400 on a guarded route. | `test/notification.e2e-spec.ts` → *C13 — the guard runs before the parser*. Three cells against a **real** guarded route with a **real** body-reading handler (`POST /api/notification/subscribe`, no `@DrfNoRequestData()`): a denied caller sending `text/plain` gets 403, a denied caller sending `{` gets 403, and a **positive control** proves the same two requests are 415 and 400 for an allowed caller — so the 403 is genuinely winning a race rather than the parser being inert. The denied caller is an `auth_user` row with no `fondo_api_userprofile` sibling, which is v1's own 403-for-everyone case. |

**C9 left open**, as briefed. P2-D5 above is a second instance of the same underlying gap
(v1's URL patterns are not expressible in Express 5 routes) and should be folded into the C9
work item in Phase 3.

---

## 4. What `manual-tester` needs

### 4.1 Pointing v2 at the shared `fondodev`

```
export PATH="/home/miguel/.config/nvm/versions/node/v24.20.0/bin:$PATH"
export DATABASE_URL='postgresql://fondouser:fondo@localhost:5432/fondodev?schema=public'
export AWS_REGION=us-east-2
export DEFAULT_FROM_EMAIL='Fondo Montanez <no-reply@fonmon.minagle.com>'
export HOST_URL_APP='http://localhost:3000'
export NOTIFICATIONS_QUEUE_URL='https://sqs.us-east-2.amazonaws.com/…/fonmon-notifications'
export PORT=8444          # v1's gunicorn holds 8443
npm run build && npm run start:prod
```

v2 runs **no** migrations against `fondodev` — the Prisma baseline is marked applied, never
executed (plan §4.6). ⚠️ Do not run `prisma migrate dev`.

### 4.2 Stubbing SES and SQS

Neither service is contacted unless a message is actually sent, and **Phase 2 exposes no route
that sends one** — `MailService` has no HTTP entry point until Phase 3, and `sendNotification`
has none until Phases 3/4/6 call it (`GET /api/admin?type=…` is Phase 8). So the parity
surface reachable over HTTP today is the two notification operations plus the permission
matrix, none of which touch AWS.

To exercise the outbound side anyway:

* **SES.** Point both apps at the same SES sandbox, or run
  [aws-ses-local](https://github.com/csi-lk/aws-ses-local) / LocalStack and set `AWS_ENDPOINT_URL`
  for boto3 and `AWS_ENDPOINT_URL_SES` for the v2 SDK. The v2 client is a Nest provider
  (`SES_CLIENT` in `src/mail/ses.client.ts`), so it can also be swapped in-process.
* **SQS.** Same shape: `SQS_CLIENT` in `src/notifications/sqs.client.ts`. LocalStack SQS is
  the easiest way to capture both apps' `MessageBody` and diff them byte for byte.
* The **six SES payloads** are already pinned byte-for-byte against a real Django render in
  `src/mail/email-template.renderer.spec.ts` and `src/mail/mail.service.spec.ts`; re-deriving
  them by hand is unnecessary.

### 4.3 Read the 94 real rows

The e2e suite carries a read-only check that decodes **every** live subscription row. Run it
with:

```
FONDODEV_DATABASE_URL='postgresql://fondouser:fondo@localhost:5432/fondodev?schema=public' \
  npm run test:e2e -- test/notification.e2e-spec.ts
```

It is skipped without that variable. It only `SELECT`s.

### 4.4 Expected diffs that are **not** failures

* **P2-D5** — unauthenticated `POST /api/notification/sub1`: v1 404 (Django HTML), v2 401.
* **D13** (Phase 0) — every error body that v1 renders as an HTML Django page (unknown URL,
  uncaught 500) is JSON or empty in v2.
* **500 bodies.** `POST /api/notification/subscribe` with a body that has no `endpoint` is a
  500 in both, but v1 returns Django's HTML page and v2 returns a zero-byte body.
* **C11's residual** — `POST /api-token-auth` with body `NaN`: v1 400 `non_field_errors …
  got float`, v2 400 `{"detail":"JSON parse error - …"}`.

### 4.5 Worth checking specifically

1. Subscribe the **same endpoint** through v1 and then through v2 (and vice versa): exactly
   one row, and `subscription::text` identical in both directions. The write-side Python
   encoding is what makes this hold.
2. `unsubscribe` an endpoint registered by **another** member → 404 in both, row untouched.
3. An SQS `MessageBody` from each app for the same notification, diffed with `cmp`, not `jq`.

---

## 5. Findings for `MIGRATION_PLAN.md`

1. **§Phase 2 scope, the `{% host %}` tag.** The plan (and the brief) treat it as used by the
   templates. It has **zero call sites**; the activation email receives the same value as an
   ordinary `host_url` context variable. Ported anyway as an ambient `it.host`, but the plan
   text should say "registered but unused".
2. **A `json.dumps` port belongs in the plan's cross-cutting rules, not just Phase 2.** §4 has
   nothing about Python/JS JSON serialisation asymmetry, and it is the mechanism by which the
   Phase 2 *and* Phase 7 byte-identical criteria are met. Suggested as a new rule 5d, next to
   5b (BigInt) and 5c (date formatting), which are the same species of finding.
3. **The "add an ORDER BY for determinism" instinct is a parity bug here** (§2.3). Worth a
   sentence in §2's hstore rules alongside the key-order warning, because the two look like the
   same rule and pull in opposite directions.
4. **Plan rule 12 understates why `@All()` fallbacks are needed** (§2.8). It says Nest 404s
   where DRF 405s. The sharper statement: for any view whose `list_permissions` entry omits a
   method, v1 answers **403**, and v2 cannot reach that answer without a route to guard. That
   is most methods on most views, so the fallback is not an edge case.
5. **§6 test-porting table.** `test_notification_views.py` is listed as 4 tests; it has 5
   methods, one of which (`pending_test_send_notification`) never runs — already noted in the
   plan's `pending_test_` bullet, but the row count and the bullet disagree. Resolution
   recorded in §2.9 above: not revived as written.
6. **Phase 3's `create_user` rollback now has a verified counterpart.** `MailService.sendMail`
   returns `false` for *any* failure including a template miss, and never throws. Three unit
   tests pin it (SES rejects, SES throws synchronously, template unknown).
