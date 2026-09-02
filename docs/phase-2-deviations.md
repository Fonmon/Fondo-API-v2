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

**Revision 2 (2026-08-31), after the `manual-tester` FAIL** (`docs/parity-phase-2.md`): the
substance of the phase was unchanged — every SES payload, SQS body, hstore row and the whole
role matrix were already byte-identical — and all five findings were at the HTTP edge. Fixed
here: **F1/C14** (`app.enableCors()` bypassed auth on `OPTIONS`), **F2 + P2-D5 + S7/C9** (one
pre-guard URL layer), **F3** (`QueryDict` last-value semantics) and most of **F4** (response
headers). **P2-D4 was factually wrong** and is corrected below (F5). New registrations:
**P2-D8**. Withdrawn: **P2-D5** (now fixed rather than deviated).

**Revision 3 (2026-08-31), after the round-2 `manual-tester` FAIL** (`docs/parity-phase-2.md`
§R2.3-R2.5): F1–F5 held and nothing in the substance regressed; the two new diffs were both
inside the URL/CORS layer this repo added in revision 2. Fixed here: **N1/C15** (the URL layer
is now **two** middlewares, one either side of `DjangoCorsMiddleware`, because v1's
`APPEND_SLASH` 301 and its resolution 404 sit at different depths — §2.13), **N2/C16**
(`escape_uri_path`/`iri_to_uri` ported; the 301 `Location` is the decoded path — §2.14) and
**N3/C17** (Nest's router is re-targeted at `PATH_INFO`, closing it in Phase 2 rather than at
the Phase 3 gate — §2.15). Registered: **O1** and one further server-level diff, as P2-D8
residuals (4) and (5).

---

## 1. Registered deviations from v1

| # | v1 behavior | v2 behavior | Rationale |
|---|---|---|---|
| **P2-D1** | `send_mail` **mutates the caller's `bcc` list** in place (`bcc.remove(recipient)`), and its `bcc=[]` default argument is Python's shared-mutable-default. | v2 copies the array and never mutates the caller's. | Unobservable. `.remove` only ever *shortens* the shared default, so it stays empty; and all three call sites pass a freshly built list from `get_users_attr('email', [0,2])` (`services/loan.py:98,101`) or a literal. The **removal semantics** are ported exactly — `list.remove` deletes only the first occurrence, which matters because two pairs of live members share an email address. |
| **P2-D2** | `save_subscription` does `UserProfile.objects.get(id=user_id)` before inserting, purely to obtain the FK; a missing profile raises `DoesNotExist` → 500. | v2 skips the lookup and lets the foreign key enforce it → 500. | Same status, one query fewer. Unreachable in practice: `RolesGuard` already 403s a user with no `fondo_api_userprofile` row (Phase 1). Body differs only in the way already registered as **D13** (Django's HTML error page vs v2's JSON/empty). |
| **P2-D3** | `subscription['endpoint']` with a `None` value would be stored as SQL NULL and queried with `IS NULL`. | v2 returns **500** for `{"endpoint": null}`. | Reproducing it needs a *different SQL statement* for a payload no browser can produce (`PushSubscription.endpoint` is non-nullable in the Push API). A non-`null` non-string endpoint **is** reproduced — coerced with `pythonStr`, matching `HStoreField.get_prep_value`. |
| ~~**P2-D4**~~ | ~~`NotificationService.remove_all_subscriptions` exists.~~ | ~~Ported, but **no caller** — as in v1, where it is also dead.~~ | ⚠️ **WITHDRAWN — the premise was false** (parity finding **F5**). v1 calls it at `fondo_api/services/user.py:218`, from `__update_user_preferences`: `if remove_notifications and not user_preference.notifications: self.__notification_service.remove_all_subscriptions(id)`. So a member turning notifications **off** deletes every push subscription they own, on every device. My grep missed the call because it goes through the private `self.__notification_service` attribute. Nothing about the Phase 2 code changes — it still ships with no caller, because `PATCH /api/user/<id>` is Phase 3 — but this is **not a deviation at all**, and the corrected instruction is: **Phase 3 must wire the call** in the `preferences` branch, or it silently drops the behaviour. The method is now covered by two DB-backed e2e cells (`test/notification.e2e-spec.ts` → *remove_all_subscriptions …*) so Phase 3 only has to connect it. Also escalated to `business-analyst` by the tester — the deletion is irreversible server-side. |
| ~~**P2-D5**~~ | ~~v1's URL regex is `^api/notification/(?P<operation>[a-zA-Z]+)/?$`, so an operation containing a digit 404s **before authentication**.~~ | ~~v2 matched any segment and rejected it in the handler → 404 for an authenticated caller, **401** for an unauthenticated one.~~ | ✅ **WITHDRAWN — fixed, not deviated.** The pre-guard URL layer (C9, below) enforces `[a-zA-Z]+` where v1 enforces it, in the URL conf, so an unauthenticated `POST /api/notification/sub1` is now a **404 in both**. The in-handler check is deleted rather than kept as belt-and-braces: two places to state one rule is how the two got out of step in the first place. |
| **P2-D6** | `NotificationSubscriptions.objects.filter(user_id__in=…)` emits no `ORDER BY`; the row order in the SQS body is PostgreSQL's heap order. | v2 emits the same `IN (…)` with no `ORDER BY`. | Recorded as a deviation *from the obvious implementation*, not from v1 — see §2.3. Adding `ORDER BY id` would have **broken** parity. |
| **P2-D7** | v1's SQS publish happens in a Celery worker with **no retry**; a failure is logged and the message lost. | v2 publishes inline with **3 attempts and exponential backoff** (200 ms, 400 ms). | Plan Phase 2, condition 1 — authorised in advance. Strictly an improvement; the swallow semantics at the boundary are unchanged (condition 2). |
| **P2-D8** | Response headers v1 emits that v2 does not, and vice versa (parity finding **F4**). | **Most are now matched**, not deviated: `X-Frame-Options: SAMEORIGIN`, `Vary: Origin`, `Vary: Accept`, `Allow: <view methods>`, `Content-Type: application/json` **without** `; charset=utf-8`, and **no** `Content-Type` at all on a zero-byte DRF body — plus `X-Powered-By` and `ETag` removed. **Three residuals are accepted**: (1) v1's error *bodies* are Django's HTML pages where v2 sends JSON or nothing — already **D13**, and the `Content-Type: text/html` that goes with them follows the body; (2) transport headers differ because the servers differ — v1 sends `Server: gunicorn/19.9.0` and `Connection: close`, v2 sends no `Server` and keeps the connection alive; (3) v1 answers a bare `OPTIONS /api-token-auth` with DRF's metadata document, v2 with a 405 — that is **P1-D2**, unchanged; (4) **`HEAD` returns a body in v1** (parity finding **O1**): status and every header agree, `Content-Length: 63` included, but gunicorn 19.9.0 writes the 63 payload bytes and Node writes none — v2 is the RFC-9110-conformant side and no client can observe it through a conforming HTTP library; (5) **a raw non-ASCII byte in the request target**: Node's HTTP parser answers **400** before any middleware runs, where gunicorn passes it through and v1 answers 404 (`POST /password_resetñ`) or even 301 (`POST /password_reset?a=ñ` → `Location: /password_reset/?a=%C3%83%C2%B1`, double-encoded because Django reads `QUERY_STRING` as latin-1). Unreachable from any HTTP client that encodes its URLs; both are properties of the server, not of the API. | Everything cheap and observable was matched, because "the response differs and nobody wrote it down" is exactly what the parity gate exists to catch. The residuals are properties of the *server*, not of the API: no client can depend on `Server`, and D13/P1-D2 are separately registered and already accepted. |
| **P2-D9** | `HttpRequest._get_raw_host()` falls back to `SERVER_NAME` (+ port) when the request carries no `Host` header, and consults `X-Forwarded-Host` when `USE_X_FORWARDED_HOST` is set. | v2's `ALLOWED_HOSTS` port (condition **C19**) treats a missing `Host` as the empty string — an automatic **400** — and ignores `X-Forwarded-Host` unconditionally. | Both are fail-closed and neither is observable on any deployed configuration. v1's gunicorn binds `0.0.0.0`, so `SERVER_NAME` is `0.0.0.0`, which is in no `ALLOWED_HOSTS`: a `Host`-less HTTP/1.0 request is a **400** in v1 too, measured over a raw socket. `USE_X_FORWARDED_HOST` is `False` in every v1 settings module and there is no v2 setting to turn it on, so trusting a proxy header stays a **deliberate** future decision instead of an inherited default. The 400's *body* is D13 (JSON where v1 renders `<h1>Bad Request (400)</h1>`) and it carries a `Content-Length` where v1 sends none, because v1's is built by the exception wrapper *around* slot 3 and so skips `CommonMiddleware.process_response` — P2-D8 residual (2). |

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

⚠️ **Corrected in revision 2 (parity finding F1).** The paragraph above was true of the
*controller* and false of the *process*: `main.ts` called `app.enableCors()`, and the `cors`
package answers **every** `OPTIONS` with a 204 from middleware — before the router, the
guards and this fallback. So the 403 claimed here for `OPTIONS` was a **204 for anyone**, on
a route where v1 authenticates. Two lessons, both acted on:

* **A response-shaping decision that lives in `main.ts` is untested.** Every e2e suite builds
  the app from `AppModule`, so nothing in `main.ts` is exercised — the `OPTIONS` cell in
  `notification.e2e-spec.ts` passed the whole time. The CORS, clickjacking, URL-resolution and
  parsing middlewares are now all registered in `AppModule.configure`, and `main.ts` does
  nothing but validate the environment, listen, and log.
* **`OPTIONS` is not a formality on a guarded API.** v1's asymmetry — `corsheaders`
  short-circuits a *genuine* preflight (`Access-Control-Request-Method` present) with a 200
  and lets a bare `OPTIONS` fall through to authentication — is now ported in
  `DjangoCorsMiddleware` and pinned by `test/http-edge.e2e-spec.ts`.

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

### 2.11 C9's scope: the whole URL layer now, not the detail routes in Phase 3

The brief left the choice open — build the layer now, or say why it belongs with Phase 3's
detail routes. **Now**, for four reasons:

1. **Two of C9's three instances are already live.** F2 (`POST /API/notification/subscribe`
   wrote a row) and P2-D5 are Phase 2 routes, failing today. Fixing those two without the
   table means two ad-hoc patches that the Phase 3 layer would then delete.
2. **The table is not incremental work.** v1's URL conf is 22 lines in two files. Transcribing
   the four that exist today costs the same as transcribing all 22, and the other 18 are the
   spec Phases 3–8 have to hit anyway. Splitting it means reading `urls.py` twice.
3. **Fail-closed only works if it is total.** The value of the layer is that a path v1 does not
   serve cannot reach a v2 controller. A partial table would have to fail *open* for everything
   not yet transcribed, which is the current behaviour and therefore no protection at all —
   and the phase that adds a route is exactly the phase least likely to notice that its
   trailing-slash variant now resolves.
4. **The damage is worst in Phase 3.** `DELETE /api/user/5/` is an inert 404 in v1 and a real
   soft delete in v2, and `key_activation` is null for all 15 live users, so a soft delete is
   not reversible through the API (plan D14). Landing the layer *with* Phase 3 means the
   window exists during Phase 3's own parity run; landing it now means it never exists.

The cost is a table with 18 entries for routes v2 does not serve yet. Those entries are inert
— they let the request through to the Nest router, which 404s it exactly as it does today —
and each one carries the v1 line it was transcribed from, so the phase that implements the
route can check it in place rather than inventing it.

**What Phases 3–8 must do:** nothing, except notice. Every v1 route is already in the table.
Adding a *new* v2-only route (as `/health` is) means adding an entry, and forgetting produces
an immediate 404 in that phase's own tests.

### 2.12 The repeated-form-field fix reproduces `QueryDict`, not "the last value wins"

F3 looked cosmetic (`endpoint=a&endpoint=b` stored `"['a', 'b']"` instead of `b`) but the
mechanism matters for Phases 3 and 4, whose bulk uploads are multipart: DRF's `request.data`
is a `QueryDict`, so **every** consumer — `data['x']`, `data.items()`, and therefore
`HStoreField.get_prep_value` — sees the last value, while `express.urlencoded` and multer's
`appendField` both produce an array. The collapse happens once, in the parsing middleware,
for form and multipart bodies only (JSON needs nothing: CPython and JS agree that a duplicated
object key keeps the last).

⚠️ The other half of `MultiValueDict`, `getlist`, is deliberately **not** reproduced: no v1
view calls it (grepped across `fondo_api/`, tests excluded), so nothing depends on the values
being discarded. If a Phase 3–8 handler ever needs them, `collapseMultiValueFields` is the
single place that has to change.

### 2.13 The URL layer is two middlewares because v1's is two *layers* (N1)

The obvious reading of finding N1 is "swap two entries in `AppModule.configure`". That would
have traded one diff for another. v1's `MIDDLEWARE` and Django's handler put the two halves of
v2's URL middleware at different depths:

| v1 | Where | Reaches CORS? |
|---|---|---|
| `CommonMiddleware`'s `APPEND_SLASH` 301 | `MIDDLEWARE[2]`, **above** `corsheaders` (`MIDDLEWARE[7]`) | no — returned from `process_request`, before the preflight short-circuit |
| the resolution 404 | `BaseHandler._get_response`, **below** all eight | yes — the preflight is answered first |

Measured on the live v1, with `Origin` and `Access-Control-Request-Method`:

```
OPTIONS /password_reset  -> 301   (CommonMiddleware wins)
OPTIONS /nope/nope       -> 200   (corsheaders wins)
```

A single middleware on either side of `DjangoCorsMiddleware` matches one row and breaks the
other. So `DjangoAppendSlashMiddleware` occupies v1's slot 3 and `DjangoUrlResolverMiddleware`
sits below slot 8, and `AppModule.configure` now carries **all eight** rows of v1's
`MIDDLEWARE` as a table with what each one means for v2 — the ordering is a contract, not an
implementation detail, and slots 2 (`SessionMiddleware`) and 4 (`CsrfViewMiddleware`) become
live in Phase 3.

### 2.14 `Location` on the 301 is `escape_uri_path(PATH_INFO)`, not the request target (N2)

`django-uri-encoding.ts` ports `escape_uri_path`, `iri_to_uri` and `escape_leading_slashes`.
No JavaScript built-in has CPython `quote`'s safe set: `encodeURI` keeps `#`, `?`, `;`, `=`
and `%`, all of which Django escapes in a path, and `encodeURIComponent` escapes `/`, `:`,
`@`, `&`, `+`, `$` and `,`, all of which Django keeps. Every expectation in the spec was
produced by calling the real functions inside the v1 container over the same corpus.

⚠️ One asymmetry is deliberately **not** ported: Django reads `QUERY_STRING` as latin-1, so a
raw non-ASCII byte in a query double-encodes (`?a=ñ` → `?a=%C3%83%C2%B1`). Node answers 400 to
that request target before any middleware runs, so the branch is unreachable — registered as
P2-D8 residual (5) rather than emulated.

### 2.15 N3 was closed in Phase 2, and it needed a mount-path change

Django dispatches on the decoded `PATH_INFO`; Express's router matches **literal** segments
against the raw target and only decodes captured params. So `POST /api%2Dtoken%2Dauth` was
resolved by the table and then dropped by the router — v1 400, v2 404, on an *implemented*
route. `DjangoUrlResolverMiddleware` now sets `req.url = escape_uri_path(PATH_INFO)` once the
table has matched (re-encoded, not raw, because Express will `decodeURIComponent` the params
it captures; for every target v1's table admits the two forms are identical anyway).

The non-obvious part: this only works because `AppModule` mounts its middleware at **`/`**
rather than at `'{*path}'`. Under a non-`/` mount Express trims the matched prefix from
`req.url` for the duration of the middleware and restores it by *prepending* the removed
prefix on `next()`, so the rewrite would be spliced onto the raw path
(`/api%2Dtoken%2Dauth` + `/api-token-auth`). Nest maps `forRoutes('/')` to `app.use('/', …)`,
which matches every request and trims nothing.

Fail-closed direction re-checked: decoding cannot widen the surface, because the table is
consulted **after** decoding and before the rewrite — `POST /%41PI/notification/subscribe`
decodes to `/API/...` and still 404s, with no row written.

---

## 3. Review conditions closed

| # | What it required | How it was closed |
|---|---|---|
| **C10** | The `@All()` 405 fallback and handlers that never read `request.data` must bypass the parser interceptor. | New `@DrfNoRequestData()` marker + `DRF_NO_REQUEST_DATA_KEY`, honoured first thing in `DrfParserInterceptor.intercept`. Applied to `AuthController.methodNotAllowed` and `NotificationController.methodNotAllowed`. Both R1 regressions fixed and pinned by e2e cells: `PUT /api-token-auth` + `text/plain` → **405** (was 415), `PATCH /api-token-auth` + `{` → **405** (was 400); a positive control proves `POST` still 415s, so the marker is what changed. The negotiation itself is extracted as the exported `assertRequestDataParsable(request, parsers)` — the piece **`UserAppsView.post` needs in Phase 3**, where the `birthdates` branch must not negotiate and the `power` branch must. R2's three v1 handlers are named in the decorator's doc comment. |
| **C11** | `express.json({strict:false})` + a DRF-shaped non-dict body error; correct the mislabelled parse-error branch; register the >2.5 MB JSON tightening. | `strict: false` set. Six e2e cells pin the DRF bodies for `5`, `1.5`, `"abc"`, `true`, `null`, `[1,2]` → `{"non_field_errors":["Invalid data. Expected a dictionary, but got <int\|float\|str\|bool\|NoneType\|list>."]}`, which is what v1 returns (the DTO layer already produced the message; strict mode was preventing it from ever being reached). `describe()` now branches on **which parser ran**: JSON `SyntaxError` → CPython's message, multipart → `Multipart form parse error - …`, anything else (i.e. `PayloadTooLargeError`) → DRF's own `ParseError.default_detail`, `'Malformed request.'`. The >2.5 MB tightening is registered in the middleware doc comment. ⚠️ **One residual, deliberately not closed:** CPython's `json.loads` accepts `NaN`/`Infinity`/`-Infinity` and `JSON.parse` does not, so those three bodies remain a 400 parse error in v2 vs a `got float` serializer error in v1. Closing it needs a hand-written JSON *parser*, not a flag. |
| **C12** | Add `express` and `multer` to `dependencies`. | Added at the exact versions `@nestjs/platform-express@12.0.1` resolves — `express@5.2.1`, `multer@2.2.0` — so npm cannot dedupe them apart and hand the adapter and the middleware two Express instances (which would silently unset C2's `json replacer` and render `"1000"` where DRF renders `1000`). |
| **C13** | One e2e cell proving 403 precedes 415/400 on a guarded route. | `test/notification.e2e-spec.ts` → *C13 — the guard runs before the parser*. Three cells against a **real** guarded route with a **real** body-reading handler (`POST /api/notification/subscribe`, no `@DrfNoRequestData()`): a denied caller sending `text/plain` gets 403, a denied caller sending `{` gets 403, and a **positive control** proves the same two requests are 415 and 400 for an allowed caller — so the 403 is genuinely winning a race rather than the parser being inert. The denied caller is an `auth_user` row with no `fondo_api_userprofile` sibling, which is v1's own 403-for-everyone case. |

| **C14** | `app.enableCors()` terminates every `OPTIONS` with a 204 before the router, the guards and the `@All()` fallback — auth bypassed on that verb. | ✅ **Closed.** `app.enableCors()` removed; `DjangoCorsMiddleware` (`src/common/http/django-cors.middleware.ts`) is a port of `corsheaders 2.4.0` under v1's settings, registered in `AppModule`. A **genuine preflight** (`Access-Control-Request-Method` present — v1 does **not** require `Origin`, and does **not** require the URL to resolve) is short-circuited with an empty **200**, `Content-Type: text/html; charset=utf-8`, `Vary: Origin` and, when an `Origin` is present, `Access-Control-Allow-Origin: *` + the allow-headers/methods list + `Max-Age: 86400`. Every other `OPTIONS` reaches the guards: **401** unauthenticated, **403** for every role. 12 unit cells + 7 e2e cells; the whole matrix re-diffed against the running v1 byte for byte. |
| **C9** | S7 (per-route trailing slashes), P2-D5 (the `[a-zA-Z]+` operation constraint) and F2 (case-insensitive routing) — one pre-guard URL layer. | ✅ **Closed, in full, now rather than in Phase 3** — see §2.11 for the reasoning. `src/common/http/django-url-conf.ts` transcribes **all 22** of v1's `url()` patterns (`api/urls.py` + `fondo_api/urls.py`), each with the v1 line it came from, and `DjangoUrlResolverMiddleware` resolves against it before any guard runs, including `CommonMiddleware`'s `APPEND_SLASH` 301. Fail-closed: a path not in the table cannot reach a controller. 53 unit cells + 15 e2e cells. |

### 3.1 What `nestjs-reviewer` should look at first

The URL table is a **transcription**, and transcriptions are where this migration has been
wrong before (the `username != email` lockout, the Babel grouping, P2-D4 below). It is worth
reading `django-url-conf.ts` next to `~/Projects/Fondo-API/fondo_api/urls.py` line by line.
Each `allow` string in it was read off a live v1 response rather than derived from the view
class, and every trailing-slash cell in `django-url-conf.spec.ts` was verified with a request
to the running v1.

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

* ~~**P2-D5**~~ — **no longer a diff**: unauthenticated `POST /api/notification/sub1` is now
  a **404 in both**, raised by the URL layer before the guards. Only the 404 *body* differs
  (D13).
* **D13** (Phase 0) — every error body that v1 renders as an HTML Django page (unknown URL,
  uncaught 500) is JSON or empty in v2.
* **500 bodies.** `POST /api/notification/subscribe` with a body that has no `endpoint` is a
  500 in both, but v1 returns Django's HTML page and v2 returns a zero-byte body.
* **`/api/alexa`** — v1 resolves it (`AlexaView`); v2's URL table deliberately omits it, so
  every method there is a **404**. Alexa is not migrated (plan §1) and v2 has no route behind
  the path, so letting it resolve would only produce a different 404. The only observable
  difference is the 404 body — D13 again.
* **C11's residual** — `POST /api-token-auth` with body `NaN`: v1 400 `non_field_errors …
  got float`, v2 400 `{"detail":"JSON parse error - …"}`.

### 4.4b What changed since the FAIL, and what to re-drive

| Finding | Now | Cheapest way to see it |
|---|---|---|
| **F1** | bare `OPTIONS /api/notification/subscribe`: **401** unauthenticated, **403** for every role incl. ADMIN. A genuine preflight (`Access-Control-Request-Method`) is still a **200** with `Content-Length: 0` — *even without an `Origin`, and even on a URL that does not resolve*, both of which are v1's behaviour. | `curl -i -X OPTIONS …` with and without the header, against both ports |
| **F2** | `POST /API/notification/subscribe` → **404**, **no row**. So is every other mis-cased path. | the same request that wrote row 1550 |
| **P2-D5** | `POST /api/notification/sub1` → **404 in both**, authenticated or not | unauthenticated `curl` |
| **S7 / C9** | v1's whole URL table is enforced pre-guard, including `/api/loan/5/` → 404, `/api/user/5/` → 404, `/api/activity/5/` → **200-path** (the one detail route with `/?`), and `POST /password_reset` → **301** to `/password_reset/` | worth sweeping every row of `fondo_api/urls.py` with `--path-as-is`, both slashed and bare |
| **F3** | a repeated `endpoint` field stores the **last** value, form and multipart alike | the duplicate-field body from §7 of the report |
| **F4** | `Vary`, `Allow`, `X-Frame-Options`, `Content-Type` (no charset; **absent** on zero-byte bodies) all match; `X-Powered-By` and `ETag` are gone. Residuals registered as **P2-D8** | diff the header block of any response, ignoring `Server`/`Date`/`Connection` |
| **F5** | doc corrected; `remove_all_subscriptions` now has two DB-backed e2e cells and a Phase 3 instruction | read P2-D4 above |

| **N1** | a genuine preflight on the four `APPEND_SLASH` paths is a **301** (v1's `CommonMiddleware` is above `corsheaders`), and a preflight on a path nothing resolves is still a **200** (v1's resolver is below `corsheaders`) | `curl -i -X OPTIONS -H 'Access-Control-Request-Method: POST'` on `/password_reset` **and** `/nope/nope` |
| **N2** | `Location` is `escape_uri_path(PATH_INFO) + '/'`, so `/password%5Freset` → `/password_reset/` and `/password_reset%2Fdone` → `/password_reset/done/` | the five encoded targets from §R2.4 of the report |
| **N3** | percent-encoded **literal** segments reach the controller: `POST /api%2Dtoken%2Dauth` → 400, `POST /api/%6Eotification/subscribe` → 200 + row | the two requests from §R2.5, plus `/%41PI/...` to confirm the table did not widen |

⚠️ **Three things worth adversarial attention**, because they are new code rather than fixes:

1. **The URL table is fail-closed.** If it is wrong in the *restrictive* direction, v2 404s a
   URL v1 serves — the opposite failure from F2 and just as bad. Sweeping every pattern in
   `fondo_api/urls.py` against both apps (a 401 from v1 means "resolved") is the direct check.
2. ~~**`Location` on the `APPEND_SLASH` 301** is built from the raw request target~~ — **fixed
   (N2)**: it is built from the decoded path and re-encoded with the ported `escape_uri_path`.
   The remaining question is the *query* half: `iri_to_uri` keeps `%` safe, so an
   already-encoded query must survive untouched (`?a=%C3%B1&b=1`) and an invalid escape must
   **not** be repaired (`?x=%zz`).
3. **The middleware order is now load-bearing in both directions** (N1, §2.13). Two probes fix
   it: a preflight on `/password_reset` must be **301** and a preflight on `/nope/nope` must be
   **200**. Anything that makes both agree is wrong.

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
6. **A pre-guard URL layer is a cross-cutting rule, not a Phase 2 detail** (§2.11). Suggested
   as §4 rule 14: *v1's URL conf is transcribed in `django-url-conf.ts` and enforced before
   the guards; a path absent from it cannot reach a controller. Adding a route means adding
   its v1 pattern.* This subsumes S7/C9 and removes the need for a trailing-slash "rule",
   which v1 does not have.
7. **Rule 12 needs a third clause.** It covers Nest-404-vs-DRF-405 and (via §2.8) the 403
   case. The `OPTIONS` case is a *third*: Express frameworks answer `OPTIONS` in middleware by
   default, and on a DRF API `OPTIONS` is an authenticated, permission-checked method. Any
   `cors`-style middleware must therefore be scoped to genuine preflights.
8. **Anything that shapes a response belongs in `AppModule`, never in `main.ts`** — the e2e
   suites build the app from `AppModule` and cannot see `main.ts`. That gap is the entire
   mechanism of F1: a green suite asserting `OPTIONS → 403` while production answered 204.
   Worth a sentence in §4 next to rule 12.
9. **P2-D4's correction changes Phase 3's scope** (F5): `PATCH /api/user/<id>` with
   `type=preferences` must call `removeAllSubscriptions(id)` when `notifications` goes
   `true → false`, and only then (v1 compares the stored value with the submitted one first).

10. ⚠️ **`DrfViewHeaders` must widen for the Phase 3 auth pages: they vary on `Cookie`.**
   Raised by the tester as a forward-looking nit about `/api/authorize` (a skipped Alexa
   route) and checked against the live v1 for every **kept** route: `GET /password_reset/`
   answers `Vary: Cookie, Origin` and `Set-Cookie: csrftoken=…` (`CsrfViewMiddleware`
   patching `Cookie` in as it sets the token), while `/password_reset/done/`, `/reset/done/`
   and `/reset/<uidb64>/<token>/` answer `Vary: Origin` only — `PasswordResetConfirmView`
   will add `Cookie` too once a *valid* token puts the reset into the session. So the
   `Cookie` field is a **`PasswordResetView`** concern, not only an Alexa one:
   `DjangoUrlResolverMiddleware`'s `drf: null` entries model none of it today, and Phase 3
   owns both the CSRF cookie and the `Vary` field when it lands those four views.

11. **Phase 3's `create_user` rollback now has a verified counterpart.** `MailService.sendMail`
   returns `false` for *any* failure including a template miss, and never throws. Three unit
   tests pin it (SES rejects, SES throws synchronously, template unknown).
