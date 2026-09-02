# Phase 2 review — SES mail, hstore subscriptions, SQS notifications, and the Django HTTP layer

Reviewer: `nestjs-reviewer`. Subject: `~/Projects/Fondo-API-v2`, branch
`feat/phase-2-notifications`, HEAD **`fe261fc`**; diffs `656f955..HEAD` (Phase 2 + three fix
rounds) and `151314f..HEAD` (everything since Phase 1). v1 read-only at
`~/Projects/Fondo-API` @ `5bef585` (Django 2.2.27, gunicorn 19.9.0, django-cors-headers 2.4.0).

Inputs: `docs/parity-phase-2.md` (all three rounds), `docs/phase-2-deviations.md`,
`MIGRATION_PLAN.md` v1.8, `docs/review-phase-0-1.md`.

## Method

I did not re-run the suites (the gate numbers were re-verified for me at this HEAD: lint and
typecheck clean, 1179 unit / 34 suites, 442 e2e + 1 skipped). Following what worked in round 1,
I spent the budget re-deriving claims against the real stacks instead:

* **v1 was brought back up** in a throwaway container (`fondo-v1-probe`, same image, repo bind
  mounted read-only, throwaway GCP credentials outside both repos) and probed directly. The
  original `fondo-v1` container is stopped; nothing in `~/Projects/Fondo-API` was touched.
* **The `fondodev` fixture is intact after my probes**: `count(*) = 94`, `max(id) = 1468`,
  `count(distinct xmin::text) = 1`. I used only unauthenticated reads and header probes.
* Regex, `PATH_INFO` and URL-resolution claims were re-derived **inside the v1 image** against
  the installed `django==2.2.27` / `gunicorn==19.9.0`, not from documentation.
* Transport-normalisation claims were re-derived by running supertest against a bare
  `http.createServer` that echoes the request line it actually received.

### Claims I re-derived and confirmed correct

Recorded because two of them look wrong until you check, and a later round should not re-chase
them:

1. **The 22-pattern transcription's `$` semantics are exact — for a reason nobody wrote down.**
   Python's `$` matches before a trailing newline and JavaScript's does not, so
   `POST /api/notification/subscribe%0A` (a real, reachable request target: gunicorn's
   `unquote_to_wsgi_str` turns `%0A` into a literal `\n` in `PATH_INFO`, and Django's
   `get_path_info` passes it through — both verified in the image) should have resolved in v1
   and 404ed in v2. It does not, because **Django 2.2.25+ `RegexPattern.match` uses
   `re.fullmatch` when the pattern ends in `$`** (`django/urls/resolvers.py`, verified by
   `inspect.getsource` in the running image), which is the CVE-2021-44420 fix. Live v1 confirms:
   `%0A` on `/api/notification/subscribe`, `/api-token-auth`, `/password_reset/` and `/api/loan`
   is a **404**, matching v2. The equivalence is therefore correct **and version-dependent**;
   see *Consider #5*.
2. **The N1 middleware split is right, live.** With `Origin` + `Access-Control-Request-Method`:
   `OPTIONS /password_reset` → **301**, `OPTIONS /nope/nope` → **200**. Re-measured today.
3. **Header transcriptions are right.** `Vary: Accept, Origin` + `Allow: GET, POST, PATCH, HEAD,
   OPTIONS` on a 401 from `/api/loan`; `Vary: Origin` + `Allow: POST, OPTIONS` on the 405 from
   `GET /api-token-auth`; the `APPEND_SLASH` 301 carries **no** `Vary`, **no** `X-Frame-Options`
   and **no** `Access-Control-*`; the 404 carries `Vary: Origin` + `X-Frame-Options`. All match
   what `django-url-conf.ts`, `django-cors.middleware.ts`, `django-response-headers.middleware.ts`
   and `django-append-slash.middleware.ts` produce.
4. **`Vary: Cookie, Origin` on `GET /password_reset/`** — confirmed, and the *mechanism* behind
   the round-3 element-order correction is now clear (see Should-fix #1): the `Cookie` on
   `/password_reset/` comes from `PasswordResetView`'s **view-level** `csrf_protect`, which sits
   below all eight middlewares, while on the reset-confirm pages it comes from `SessionMiddleware`
   at slot 2, which sits above all of them. Two different depths, hence two different orders.

The substance of the phase — the codec, the repository, the SES payloads, the SQS bodies — I
found no defect in beyond the two decoder cases in Should-fix #5. The parity report's round-3
evidence for it is the strongest in this migration so far.

---

# Findings

## Blocking

**None.** Nothing found requires re-work before Phase 2 is called done.

---

## Should-fix

### S1 — `onBeforeHeaders` runs hooks in the wrong direction, and the model has no notion of depth. This is what makes the layer *not yet* ready for slots 2 and 4.

`src/common/http/before-headers.ts:52` (`for (const each of state.hooks)`), doc claim at
`:31-33`; `src/app.module.ts:97-99` and `:111-121`.

Django's response phases run **bottom-up**, i.e. in reverse `MIDDLEWARE` order.
`AppModule.configure` registers middlewares in **forward** `MIDDLEWARE` order (3, 7, 8) and
`onBeforeHeaders` runs hooks **FIFO**, so v2's response phase runs *forward* — the exact
reverse of Django. The comment at `before-headers.ts:31-33` asserts the opposite ("the
middlewares are registered in `AppModule` in the order their response phases run
(`CorsMiddleware` is last in v1's `MIDDLEWARE`, so its response phase runs first)"); Cors is
registered **third of five**, not first. `app.module.ts:97` ("responses run back up it, which is
what `onBeforeHeaders`/`skipBeforeHeadersHooks` reproduce") is wrong for the same reason.

Today this is unobservable: only two hooks exist and they touch disjoint headers. It stops being
unobservable the moment Phase 3 models slots 2 and 4, which the developer has already flagged:

* `CsrfViewMiddleware` (slot 4) and `SessionMiddleware` (slot 2) both call
  `patch_vary_headers(response, ('Cookie',))`. In Django they run **after** `corsheaders`, giving
  `Vary: Origin, Cookie`. Under v2's FIFO they would run **before** it, giving `Cookie, Origin` —
  which is the wrong one of the two orders the round-3 sweep found
  (`docs/parity-phase-2.md` §R3.6).
* The other order, `Cookie, Origin` on `GET /password_reset/`, does **not** come from a
  middleware at all: it comes from `PasswordResetView`'s view-level `csrf_protect`, i.e. from a
  **fourth position below all eight**. `onBeforeHeaders` has no way to express "below the
  middleware stack" — every hook is a flat peer.
* `skipBeforeHeadersHooks` (`before-headers.ts:69-78`) suppresses **every** hook. Django's
  `CommonMiddleware` 301 only skips the phases *below* slot 3; slots 2 and 1 still run on it. That
  is the same thing today only because nothing above slot 3 registers a hook. Add
  `SessionMiddleware` at slot 2 and "all" stops meaning "below me".

**Why it matters.** This is the answer to "is the layer ready for Phase 3". The abstraction is
right in shape — a real response phase, wrapped at `writeHead` rather than `finish`, is exactly
the right call and I want it kept — but it is missing the one property Django's stack has:
**ordering by depth**. Adding routes will be mechanical; adding *middlewares* will not be, and
Phase 3 adds two plus a view-level one.

**Fix.** Give hooks an explicit depth and run them in descending depth order:
`onBeforeHeaders(response, hook, depth)` where `depth` is v1's `MIDDLEWARE` slot (1–8) and a
sentinel (say `9`/`VIEW`) is below all of them; run `hooks.sort((a,b) => b.depth - a.depth)` at
flush time (stable, so same-depth hooks keep registration order). Change
`skipBeforeHeadersHooks(response, belowDepth)` to suppress only hooks with depth **greater than**
the caller's. That turns `app.module.ts`'s middleware table from a comment into something the
runtime enforces, costs about fifteen lines, and makes the two `Vary` orders in §R3.6 fall out
rather than needing to be special-cased per route.

**Test that would have caught it:** an e2e cell that registers a probe middleware at slot 2 and
asserts its hook runs **after** the CORS hook. There is no such cell because there is no such
middleware yet — which is precisely why this needs closing before Phase 3 rather than during it.

---

### S2 — The URL layer resolves *whether* a path is served but never *which view* serves it, and the guard trusts Nest's router for that. Phase 3 has three views on one path prefix.

`src/common/http/django-url-resolver.middleware.ts:55` (`matched` is used only for headers and
then discarded); `src/auth/guards/roles.guard.ts:66-74`;
`src/common/http/django-url-conf.ts:93-94` (`readonly view: string` — documentation only).

Django picks the view by **first pattern that matches**. v2's table reproduces that ordering and
then throws the answer away: `RolesGuard` reads the view name from
`@V1View(...)` on whatever **Nest** route matched, and Express matches by *declaration order with
unconstrained `:params`*. In Phase 2 there is one view per path, so the two can't disagree.

In Phase 3 they can, on `/api/user/<x>`, where v1 has three patterns in a specific order:

```
^api/user/(?P<app>-?[a-zA-Z]+)$      UserAppsView      POST: 3
^api/user/(?P<id>-?[0-9]+)$          UserDetailView    GET: 3, PATCH: 3, DELETE: 0
^api/user/activate/(?P<id>[0-9]+)$   UserActivateView  POST: 3
```

If the Phase 3 controller declares `@Delete(':id')` before `@Post(':app')` — or simply declares
`:id` first — then `DELETE /api/user/power` resolves in the table (it matches
`-?[a-zA-Z]+`), reaches Nest, and is matched by `:id`. The guard then evaluates
**`UserDetailView.DELETE` (role ≤ 0, ADMIN allowed)** for a request Django would have sent to
`UserAppsView`, which has no `DELETE` entry at all and is therefore a **403 for every role**.
That is a permission rule applied to the wrong view — the same class of defect as F2, one layer
deeper, and it will not show up as a 404.

**Why it matters.** The developer's §2.11 conclusion — "What Phases 3–8 must do: nothing, except
notice" — is true for the *table* and false for the *dispatch*. The layer currently guarantees
"no path v1 refuses reaches a controller"; it does not guarantee "the path reaches the controller
v1 would have chosen", and the permission matrix is keyed on exactly that.

**Fix (small, and it makes the guarantee total).**
1. Narrow `DjangoUrlPattern.view` from `string` to `V1ViewName | null` (`null` for the four auth
   pages and `/health`) so the table and the permission matrix are type-linked.
2. Have `DjangoUrlResolverMiddleware` attach the matched pattern to the request
   (`req.djangoRoute = matched`).
3. In `RolesGuard` (or a tiny `V1ViewMatchGuard` running before it), when both the resolved view
   and the declared `@V1View` are present and **differ**, fail closed — a 500 with a loud log, or
   a 403, but never silently proceed. Every phase's own tests then catch a mis-ordered route on
   the first request instead of in a parity sweep.

---

### S3 — `CommonMiddleware`'s port drops `ALLOWED_HOSTS`, which is the one part of it that is not a no-op under v1's settings. Live, unregistered divergence.

`src/common/http/django-append-slash.middleware.ts:61-71`;
`~/Projects/Fondo-API/api/settings/production.py:13` (`ALLOWED_HOSTS = [ALLOWED_HOST_DOMAIN, "127.0.0.1"]`).

`CommonMiddleware.process_request` calls `request.get_host()` **before** the `APPEND_SLASH`
check. `get_host()` enforces `ALLOWED_HOSTS` and raises `DisallowedHost` → **400**, ahead of the
CORS preflight, the resolver and everything else. Measured on live v1 today:

```
Host: evil.test   OPTIONS /password_reset  -> 400      (Host: localhost -> 301)
Host: evil.test   OPTIONS /nope/nope       -> 400      (Host: localhost -> 200)
Host: evil.test   GET     /api/loan        -> 400      (Host: localhost -> 401)
```

v2 has no host check anywhere; it serves all three normally. The port covers the `APPEND_SLASH`
branch and correctly treats `PREPEND_WWW` and `DISALLOWED_USER_AGENTS` as no-ops (both are
default/empty), but silently drops the branch that *does* fire.

**Why it matters.** Two reasons, and the second is the sharp one.

* It is an unregistered live diff in the direction that failed round 1 (v2 serves what v1
  refuses), on the layer this phase exists to build.
* **Phase 3 turns it into a real vulnerability.** `PasswordResetView`
  (`fondo_api/views/auth.py:37-46`) builds the reset link from
  `get_current_site(request).domain`, i.e. from `request.get_host()`. Without `ALLOWED_HOSTS`,
  a forged `Host:` header on `POST /password_reset/` makes v2 email a member a password-reset
  link pointing at the attacker's domain. `ALLOWED_HOSTS` is precisely the control that stops
  that in v1, and it must exist **before** that route lands.

**Fix.** A small `DjangoAllowedHostsMiddleware` at slot 1/3 (before `DjangoAppendSlashMiddleware`)
that reads a `ALLOWED_HOST_DOMAIN`-derived allowlist from config and answers 400 on a miss,
with the same `Host`-parsing rules Django uses (port stripped, `X-Forwarded-Host` ignored unless
`USE_X_FORWARDED_HOST`, which v1 does not set). Add the env var to `env.schema.ts` as required.
Register the response *body* difference under D13 as usual. Alternatively register the whole
thing as a deviation — but only with the Phase 3 consequence written down next to it, because
"we dropped the host allowlist" is not a defensible unexamined default.

---

### S4 — The inline SQS publish has an unbounded time budget and up to **9** attempts, not 3. P2-D7 records the wrong bound.

`src/notifications/sqs.client.ts:19-23` (client constructed with `region` only);
`src/notifications/notification-publisher.ts:114-137` and the doc claim at `:56-60`;
`docs/phase-2-deviations.md` P2-D7.

`NotificationPublisher` wraps `SQSClient.send` in its own 3-attempt loop with 200 ms/400 ms
backoff. But `@aws-sdk/client-sqs` defaults to `maxAttempts: 3` in *standard* retry mode with its
own exponential backoff and jitter, and to **no request timeout**. So:

* the real bound is **3 × 3 = 9** `SendMessage` HTTP attempts, not 3;
* the real backoff is the publisher's 200/400 ms **plus** the SDK's internal jitter;
* a hung (as opposed to refused) SQS endpoint blocks with **no timeout at all**.

That is invisible today because Phase 2 exposes no route that publishes, and the parity report's
`5.3` case used a *refused* connection, which fails fast. It becomes live in Phase 3/4/6, where
`sendNotification` runs **on the HTTP request thread after the transaction commits** — v1's
equivalent ran in a Celery worker, so a slow queue cost a member nothing. Collapsing the queue hop
was authorised; collapsing it *and* inheriting an unbounded, silently-multiplied retry budget was
not.

**Fix.** Set `maxAttempts: 1` on the `SQSClient` (and on the `SESClient`, where boto3's legacy
default is 5 attempts and the SDK's is 3 — see Consider #6) so the publisher's loop is the only
retry, and give both clients an explicit `requestHandler` connection/socket timeout. Then correct
P2-D7 to state the *total* wall-clock bound, which is the number Phases 3/4/6 need in order to
reason about request latency.

---

### S5 — Two decoder paths fail **open** where v1 raises. Unreachable on today's 94 rows, and the whole SQS body depends on them.

`src/common/utils/hstore.codec.ts:321-334` (`decodePushSubscription`) and `:351-364`
(`decodeSchedulerPayload`).

v1 does `subscription['keys'] = subscription['keys'].replace(...)` and
`json.loads(payload["user_ids"])`. A row **missing** that key raises `KeyError`, which is uncaught
— `send_notification` blows up and **nothing is published**.

v2 iterates `Object.entries(map)` and only handles the key if it is present. A row with no `keys`
entry therefore decodes to a subscription object **with no `keys` field**, and
`NotificationPublisher` cheerfully publishes it to the Lambda. Same for a `SchedulerTask` payload
with no `user_ids` in Phase 7. The `null`-valued case throws; the *absent* case does not.

All 94 live rows have `keys` (the read-only scan asserts it), so this is unreachable today — which
is exactly why no black-box round could see it, and why the class comment's claim of a verbatim
port is currently untrue.

**Fix.** Throw when the key is absent, not only when it is `null`, with the `KeyError`-shaped
message the rest of the codebase uses (`readEndpoint` in `notification.service.ts:143` already
sets the pattern). Add one spec cell each for the absent-key case. Cheap, and Phase 7 inherits the
`user_ids` half.

---

### S6 — `resetDatabase` is one environment variable away from truncating the parity fixture, and nothing stops it.

`test/test-database.ts:11-13`, `:23-44`; `test/support/abstract-test.ts:46-52`.

`resetDatabase` runs `TRUNCATE TABLE … RESTART IDENTITY CASCADE` against
`process.env.TEST_DATABASE_URL ?? 'postgresql://…/fondo_api_test'`, and `global-setup.ts` runs
`prisma migrate deploy` against the same URL. `setup-env.ts` correctly pins `DATABASE_URL` to the
test database, so the *documented* footgun is closed — but `TEST_DATABASE_URL=…/fondodev`,
typed by anyone who has just been reading §4.1/§4.3 of the deviations doc (which has testers
exporting two other fondodev URLs in the same shell), destroys the 94-row fixture, the 15 users
and the 632 scheduler rows irreversibly. Against `fondodev` the `migrate deploy` would be a no-op
(baseline marked applied) and the `TRUNCATE` would proceed.

**Fix.** Refuse in `provisionTestDatabase` when the target looks like the shared database. The
soundest discriminator is already documented in the plan: on `fondodev` the baseline is *marked*
applied but never executed (`_prisma_migrations.0_init.applied_steps_count = 0`) and
`django_migrations` has 38 rows. Assert one of those and throw a named error; a database-name
denylist is a weaker second line. This is cheap insurance on the one artefact in this project
that cannot be regenerated.

---

### S7 — The report's fixture guard is not evidence, and it is the evidence the "no stray writes" verdict rests on.

`docs/parity-phase-2.md:1219` ("md5 `a1a74f3…`, `pg_dump -t …` identical to the pre-test dump");
same method in §10 and §R2.7.

`synchronize_seqscans = on` rotates the row order of a sequential scan, so three `pg_dump`s of
unmodified data produce three different md5s. A method that cannot distinguish "unchanged" from
"changed" cannot support "identical". The row-count table on the same line **is** sound and does
most of the work; the md5/pg_dump half should be replaced rather than kept alongside it, because
a later round will copy it.

**Fix (report, not code).** State the fixture guard as `count(*)`, `max(id)` and
`count(distinct xmin::text)` — which I ran today and which still reads `94 / 1468 / 1` — or as an
md5 over a deterministic projection (`SELECT id, subscription::text … ORDER BY id`). Add a line to
`MIGRATION_PLAN.md` §7 so every later phase's system-health table uses the sound form.

---

### S8 — supertest silently rewrites more of the request target than the fragment, and the URL-layer cells still use it.

`test/http-edge.e2e-spec.ts` — `rawRequest` at `:72` is used only by the five N4 cells at
`:613-651`; every F2/P2-D5/C9/N3 cell (`:268-495`) goes through supertest.

I ran the targets those cells use against a bare `http.createServer` that echoes the request line
it received. The good news: **all of them survive verbatim** — `%2D`, `%6E`, `%41`, `%2F`,
`%C3%B1`, `%0A`, `%23`, `//`, and mixed case are all passed through untouched, so the existing
cells are valid. The bad news is what else superagent rewrites, silently:

| written in the test | actually sent |
|---|---|
| `/api/notification/subscribe#frag` | `/api/notification/subscribe` (known, N4) |
| `/api/./notification/subscribe` | `/api/notification/subscribe` |
| `/api/../api/notification/subscribe` | `/api/notification/subscribe` |
| `/api\notification\subscribe` | `/api/notification/subscribe` |
| `/api/notification/sub scribe` | `/api/notification/sub%20scribe` |

The first three matter directly: the round-2 sweep established that **neither server normalises
dot-segments** (`/api/./notification/subscribe` → 404 in both), and a regression cell for that
written in supertest would assert 200 against a rewritten target and pass for the wrong reason —
the identical failure mode as N4, in a different disguise. The backslash row is worse in the other
direction: a cell asserting `/api\loan` 404s would pass while the app never saw a backslash.

**Fix.** Promote `rawRequest` into `test/support/` and make it the required transport for
**every** cell whose subject is the request target (URL conf, `APPEND_SLASH`, `PATH_INFO`
decoding, `Location`). Add one *harness* cell that asserts the raw request line the app received
equals the string the test wrote — a self-check that fails loudly the first time someone adds a
target superagent rewrites. Note it in the plan next to rule 14, because Phases 3–8 will write
dozens of these.

---

### S9 — Plan defect: Phases 3 and 4 both **write** `SchedulerTask` rows, and the repository that writes them is scheduled for Phase 7, which runs after both.

`MIGRATION_PLAN.md` §3 sequence (`P3 → P4 → P7`), §Phase 3 scope (`:322-340`), §Phase 7 scope
(`:552-594`); `src/notifications/notification.service.ts:12-16` ("the scheduling half …
lands in **Phase 7**").

v1's call sites:

```
fondo_api/services/user.py:281-282   remove_sch_notitfications("birthdate", user.id)
                                     schedule_notification(birthdate_time, payload, 4)   <- PATCH /api/user/<id>  = Phase 3
fondo_api/services/loan.py:107       remove_sch_notitfications("payment_reminder", id)   <- loan payout           = Phase 4
fondo_api/services/loan.py:314-315   schedule_notification(five_days_date, payload) x2   <- bulk update           = Phase 4
```

Phase 4's own parity criteria already say "identical `SchedulerTask` rows", so the plan half-knows
this. Phase 3's scope section does not mention the birthdate task at all, even though §5 registers
two defects in the very function that creates it (D19, D20). And `NotificationService` ships with
`schedule_notification`/`remove_sch_notitfications` deliberately absent, deferred to a phase that
runs later than the two phases that call them.

**Fix.** Split Phase 7 in the plan: **7a — `SchedulerTaskRepository` + `schedule_notification` +
`remove_sch_notitfications` (the write half, plus its hstore encoding and the same-day dedupe
rule), landing with Phase 3**; **7b — the cron runner, executers and `repeat` cloning**, staying
where it is. Add the birthdate `SchedulerTask` write to Phase 3's scope bullet list and to its
parity criteria. This is a sequencing correction, not new work: the rows have to be written in P3
and P4 either way.

---

## Consider

### C1 — Register the raw-SQL-in-tests exception in the plan; the exception itself is sound.

`MIGRATION_PLAN.md:113` ("No `$queryRaw` touching hstore anywhere else in the codebase — reviewer
enforces this").

Enforced: in `src/`, the only raw SQL touching `subscription` is
`NotificationSubscriptionRepository` (verified by grep across `src/`). `hstore.codec.ts` is pure
string handling and touches no database.

The test-side exception is not just acceptable, it is **better than the alternative**.
`test/notification.e2e-spec.ts:566-579` (`insertRawSubscription`) seeds rows with literal hstore
text captured from v1 — `test/support/push-subscription.fixture.ts` — precisely so the read path
is proved against **v1's** encoding rather than against v2's own encoder. Seeding with
`toHstoreLiteral` would make the round-trip test self-confirming and worthless. Same for
`test/schema-round-trip.e2e-spec.ts`.

Reword the rule to "no raw SQL touching hstore in `src/` outside the two repositories; test
fixtures may write literal hstore text captured from v1, and **must not** use the v2 codec to
build a fixture the v2 codec is being tested against".

### C2 — `decodePathInfo`'s doc claims the wrong CPython function.

`src/common/http/django-url-conf.ts:241-261`. The comment says Django's `PATH_INFO` is
"`urllib.parse.unquote(..., errors='replace')`". It is not: `get_path_info` runs
`repercent_broken_unicode`, which **re-percent-encodes** invalid UTF-8 rather than substituting
U+FFFD. Verified in the image:

```
'/api/notification/subscribe%FF'  -> Django path_info '/api/notification/subscribe%FF'
                                  -> v2 decodePathInfo '/api/notification/subscribe�'
```

Unobservable today — every pattern in the table is ASCII-only, so `%` and U+FFFD both fail to
match — but the comment is a transcription claim and transcription claims are what this migration
gets wrong. Either port `repercent_broken_unicode` (about ten lines) or correct the comment to say
the two differ and why it cannot matter while the table stays ASCII.

### C3 — `Location` omits Django's outer `iri_to_uri`; it happens to be idempotent.

`src/common/http/django-append-slash.middleware.ts:95-96`. Django applies `iri_to_uri` twice: once
to `QUERY_STRING` inside `_get_full_path`, and once to the **whole** `Location` in
`HttpResponseRedirectBase.__init__`. v2 applies only the first. It is safe — every character in
`escape_uri_path`'s safe set is also in `iri_to_uri`'s (or in `_ALWAYS_SAFE`), and `%` is safe in
both, so the second pass is a no-op on the first's output — but that is a proof, not an obvious
fact. Add the outer call (one wrapping) or state the proof in the comment.

### C4 — `resolveDjangoUrl` accepts a `PATH_INFO` with no leading slash; Django's root pattern is `^/`.

`src/common/http/django-url-conf.ts:231-239`. `pathInfo.startsWith('/') ? slice(1) : pathInfo`
means a path not starting with `/` is still matched against the table, where Django's root
`URLResolver(RegexPattern(r'^/'), …)` would 404 it. Unreachable (`PATH_INFO` always starts with
`/`) and fail-open in principle. One character to make it total: return `null` unless the path
starts with `/`.

### C5 — Pin the `fullmatch` fact with a test, because it is version-dependent.

`src/common/http/django-url-conf.spec.ts`. The JS `^…$` transcription is only equivalent to
Django's because 2.2.25+ uses `re.fullmatch` for `$`-terminated endpoint patterns. On Django
< 2.2.25 the same regexes resolve `…/subscribe\n`. Add two cells — `/api/notification/subscribe%0A`
and `/password_reset/%0A` must both be a **URL-conf 404** — with a comment naming the Django
version and CVE-2021-44420. That is the cheapest possible guard against someone "simplifying" the
table back toward `search`-like semantics, and it documents a fact I had to open the container to
establish.

### C6 — `SESClient` inherits a different retry budget from boto3's.

`src/mail/ses.client.ts:24-27`. boto3's legacy retry mode gives `send_email` 5 attempts; the JS
SDK gives 3. Not observable in any payload, but `create_user`'s rollback branch keys off
`sendMail` returning `false`, so the window in which a transient SES blip rolls back a new
member's four rows is different in the two systems. Set `maxAttempts` explicitly (either value —
just pick one deliberately) and say so in the Phase 3 note at `docs/phase-2-deviations.md:468-470`.

### C7 — `DjangoUrlPattern.view` should carry `V1ViewName`, and `/api/alexa`'s absence deserves a table row.

`src/common/http/django-url-conf.ts:90-97`, `:106-109`. Typing `view` (see S2) also makes the
`/api/alexa` omission visible as a typed `null`-view entry rather than a comment, so a future
reader diffing the table against `fondo_api/urls.py` sees 23 rows and one explicitly-not-served
pattern rather than 22 rows and a missing one.

---

## Nit

* `src/common/utils/hstore.codec.ts:215-222` — `pythonReprNumber` renders an integral JS number as
  a Python `int`, so `{"endpoint": 1.0}` stores `1` in v2 and `1.0` in v1. Documented in the
  function's own comment and unreachable from any browser; noted only so it is not rediscovered.
* `docs/phase-2-deviations.md:41` — P2-D4's withdrawal is exemplary (it names the grep that missed
  the call and why). Worth copying that shape into future registers.
* `src/notifications/notification.controller.ts:100-103` — the `@All()` fallback throws
  `DrfException.methodNotAllowed`, which is unreachable: the guard 403s every non-`POST` first.
  Correct, and the class comment says so; a one-line `/* istanbul ignore */`-style note on the
  throw itself would stop the next reader from "fixing" it into an `ApiException.empty(405)`.

---

# Answers to the six questions asked

**1. Correctness and parity, especially the surfaces with no HTTP entry point.**
`MailService`, `EmailTemplateRenderer` and `NotificationPublisher` are the best-documented code in
the repo and I found two real defects in that region: **S5** (decoder fails open on an absent
`keys`/`user_ids`) and **S4** (the retry budget is 9, not 3, with no timeout). Both are invisible
to any black-box round by construction. Everything else I checked in that region — `list.remove`
single-occurrence bcc semantics, the six templates byte-for-byte including the missing trailing
newline on the subjects, `str()` coercion of `None`, `string_if_invalid`, the `json.dumps`
separators and `ensure_ascii` — is right, and the unit suites for it are meaningful rather than
decorative.

**2. Is the new HTTP layer the right abstraction, and is it ready for Phases 3–8?**
The *shape* is right and I would keep it: a transcribed URL table consulted before the guards, a
real response phase hooked at `writeHead`, `escape_uri_path`/`iri_to_uri` ported rather than
approximated, and v1's whole `MIDDLEWARE` list written down as a contract. The N1 split is
correct and I re-measured it. **Adding routes will be mechanical** — the table is already complete
and each entry carries its v1 source line.

But it is **not yet ready for slots 2 and 4**, for two structural reasons, and both are on the
critical path for Phase 3: the response phase has no notion of **depth** (S1), so it cannot
express "below the middleware stack" (which is where `/password_reset/`'s `Cookie` comes from) or
"skip only what is below me" (which is what `CommonMiddleware`'s 301 does); and the layer resolves
paths but not **views** (S2), which is fine with one view per path and unsafe with three. Close S1
and S2 first and Phase 3 is mechanical. Skip them and Phase 3 will discover both in its own parity
round, at which point the fixes are entangled with twenty new routes.

**3. The hstore repository and codec against the 94 live rows.**
Correct, including the parts that look wrong: the deliberate absence of `ORDER BY`, the write-side
Python `repr`, `expirationTime` as SQL `NULL`, the key order that reaches the SQS wire, and
`replaceAll` rather than `replace`. The §2 confinement rule is honoured in `src/`; the test-side
exception is not a violation but the correct design (C1). The only defect is S5.

**4. Test quality.**
High. The C13 cells with a positive control, the `remove_all_subscriptions` cells that exist only
so Phase 3 can wire a call, the fixture provenance note explaining which bytes were substituted
and why, and the raw-socket helper are all above the bar. Two method problems remain: the supertest
transport normalises **dot segments and backslashes** as well as fragments (S8), and the report's
`pg_dump` md5 fixture guard is not evidence (S7). I looked for a third and did not find one — the
`decodes every live subscription row` scan is honestly labelled as skipped-by-default, and the
report is explicit that the byte comparison, not v2's own assertions, is the strong evidence.

**5. Phase 3 readiness of the two carried findings.**
Yes — both are genuine design questions and both must be answered **before** Phase 3 starts, not
during it. The `Vary: Cookie` element order is not a header to transcribe: the two orders come
from two different *depths* (view-level `csrf_protect` vs slot-2 `SessionMiddleware`), which is
S1 and which no per-route flag can express. The `django_session` write on a `GET` is a genuine
product question about how far the reset flow is ported — the developer's instruction to decide it
rather than build it is right. I would add **S3** to that list: `ALLOWED_HOSTS` must exist before
`PasswordResetView` does, because that view builds the emailed reset link from the `Host` header.

**6. What the plan gets wrong.**
**S9** (Phases 3 and 4 write `SchedulerTask` rows that Phase 7 owns) is the substantive one.
Then: the §2 hstore rule should carve out test fixtures explicitly (C1); §7's gate checklist should
name a sound fixture-integrity method (S7); rule 14 should say that URL-layer assertions require a
raw-socket transport (S8); and Phase 3's scope bullets should gain the birthdate `SchedulerTask`
and the `removeAllSubscriptions` wiring that P2-D4's correction already implies.

---

# Gate verdict

## **Approved with conditions.** Phase 2 is closed. Phase 3 may start.

The substance of this phase — the SES payloads, the hstore encoding in both directions, the SQS
message bytes, the permission matrix and the URL table — is correct, and three rounds of parity
plus my own re-derivations against the live v1 found nothing wrong with it. The HTTP layer grew
well beyond its nominal scope and that was the right call; F2 and P2-D5 were real, the layer closes
them, and the fail-closed direction is the right default.

Nothing blocks. The conditions below are tracked as **C19–C27** and are graded by when they must
close.

### Must close **before Phase 3 writes its first controller** (they change the shape of Phase 3 code)

| # | Finding | Why it cannot wait |
|---|---|---|
| **C19** | S1 — depth-ordered response hooks; `skipBeforeHeadersHooks` scoped to "below me" | Phase 3 makes slots 2 and 4 live plus a view-level `csrf_protect`; the flat FIFO model produces the wrong `Vary` order for two of the three cookie-touching routes and cannot express the third at all |
| **C20** | S2 — attach the resolved view to the request and fail closed when it disagrees with `@V1View` | `/api/user/<x>` has three views with different permission rules; Express disambiguates by declaration order and would apply the wrong one silently |
| **C21** | S9 — split Phase 7 into 7a (SchedulerTask write half, with Phase 3) and 7b (cron runner) | Phase 3's `PATCH /api/user/<id>` writes a birthdate `SchedulerTask` on its first day |

### Must close **within Phase 3**

| # | Finding | Deadline |
|---|---|---|
| **C22** | S3 — port `ALLOWED_HOSTS`, or register it with the Phase 3 consequence written down | **before `POST /password_reset/` lands** — that view emails a link built from the `Host` header |
| **C23** | S4 — pin `maxAttempts` and request timeouts on both AWS clients; correct P2-D7's stated bound | before the first route that publishes (`POST /api/user/<power>`) |
| **C24** | S5 — decoders throw on an absent `keys` / `user_ids`, not only on a `null` one | with C21, since Phase 7a inherits the `user_ids` half |

### Must close **before the next parity round is filed**

| # | Finding |
|---|---|
| **C25** | S6 — `provisionTestDatabase` refuses a database that is not the disposable one |
| **C26** | S7 — restate the fixture guard soundly in `docs/parity-phase-2.md` and in `MIGRATION_PLAN.md` §7 |
| **C27** | S8 — `rawRequest` promoted to `test/support/`, required for URL-layer cells, plus one harness self-check |

The **Consider** items (C1–C7) and the nits are recommendations, not conditions; I would take C1,
C2 and C5 while the context is fresh, since each is a few lines and each closes a documentation
claim that is currently false or unproven.

---

*Environment note: I started a second v1 container (`fondo-v1-probe`, since removed) from the same image with a
throwaway GCP credential file at `/home/miguel/.cache/fondo-parity-creds/` (the original mount had
been wiped by the host restart). `~/Projects/Fondo-API` was mounted read-only and is unmodified.
The `fondodev` fixture reads `94 / 1468 / 1` after all probes; the probe container has been
removed and the original `fondo-v1` container is left stopped, as I found it.*
