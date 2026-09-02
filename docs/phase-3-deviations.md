# Phase 3 — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5, and to `docs/phase-0-deviations.md`,
`docs/phase-1-deviations.md`, `docs/phase-2-deviations.md`.

Audience: `nestjs-reviewer` (§1–§3), `manual-tester` (§4 — everything it must read as an
**expected** diff, plus how to point v2 at `fondodev`), and whoever maintains
`MIGRATION_PLAN.md` (§5 — corrections to fold back).

**Scope shipped**

| Area | Routes / units |
|---|---|
| Members | `POST\|GET\|PATCH /api/user`, `GET\|PATCH\|DELETE /api/user/<id>`, `POST /api/user/activate/<id>` |
| Apps | `POST /api/user/<birthdates\|power>` |
| Password reset | `GET\|POST /password_reset/`, `GET /password_reset/done/`, `GET\|POST /reset/<uid>/<token>/`, `GET /reset/done/` |
| Phase **7a** | `SchedulerTaskRepository` + `NotificationService.scheduleNotification` / `removeSchNotifications` |
| Conditions closed | **C22**, **C23**, **C24**, **C25** |
| §5 register implemented | **D1, D2, D5, D11, D14, D15, D16, D17, D19, D20** |

---

## 1. Registered deviations from v1

### 1.1 The §5 register items this phase implements

| # | v1 | v2 | Where |
|---|---|---|---|
| **D1** | `PATCH /api/user/<id>` is role ≤ 3 with **no ownership check**, and `__update_user_personal` writes `user.role` from the body (`services/user.py:232`). Any member can make themselves ADMIN, or set the `total_quota` that is the only value `create_loan` checks. | Two-level authorisation. **Level 1** — the section gate — keys off `body.type` and the caller's role/ownership, and runs *before* the target row is loaded, so a refusal cannot be used to enumerate ids. **Level 2** — the field allowlist — is asserted against `changedSectionFields(...)`, so a 403 means a real change to a privileged field. | `user.service.ts::updateUser`, `auth/policies/user-patch.policy.ts` |
| **D2** | `Power.objects.get(id=request['id'])` with **no check that the caller is the requestee**: any member can approve any power request and trigger the fund-wide letter. | `assertOwnership(actor, power.requestee_id)`. DRF's generic 403, indistinguishable from a role denial. | `power.service.ts::updatePower` |
| **D5** | The approval letter puts **every member's address in `ToAddresses`** with an empty `Bcc`, disclosing all 15 addresses to all 15 members. | `ToAddresses: []`, every member in `BccAddresses`. Recipient list unchanged (Q10). ⚠️ See §2.6 — an empty `To` is worth one operator confirmation. | `power.service.ts::updatePower` |
| **D11** | `UserFinance.user` / `UserPreference.user` are plain FKs. A duplicate row makes `.get()` raise `MultipleObjectsReturned`, which `__update_user_finance` does **not** catch → that member's finance endpoint 500s permanently; `get_user`'s bare `except` turns the same corruption into a 404. | Deterministic lowest-id reads (`findFirst` + `orderBy: {id: 'asc'}`), so a duplicate degrades to "the second row is ignored" and both endpoints keep working. ⚠️ **The physical `UNIQUE (user_id)` is NOT applied** — Django owns the schema until Phase 9 and plan §4 rule 6 forbids v2 running migrations against a shared database. See §5.4. | `user.service.ts::readFinance`, `::readPreference` |
| **D14** | Only `UserDetailView.get` substitutes `-1`; `.patch` and `.delete` pass it through and 404. | Split by verb: **GET** keeps it, **PATCH adopts** it, **DELETE refuses** it (passing `-1` through, which 404s exactly as v1 does — a refusal to *add*, not a change). | `user.service.ts::resolveDetailUserId` |
| **D15** | `__update_user_personal` does `user.username = obj['email']`. `auth_user.username` is UNIQUE and two live members' emails are already another member's username, so **any personal edit to user 13 or 14 is a bare 409 today**; on the other branch it silently rotates a credential. | `username` is written once, at creation, and never again. | `user.service.ts::updateUserPersonal` |
| **D16** | `identification` is writable by any caller. | ADMIN-only, gated on an actual change. It is the join key of the treasurer's monthly TSV and a miss is only *logged* (`services/user.py:144`), so a member editing their own cédula silently freezes their contributions and quota. | `auth/policies/user-patch.policy.ts::PRIVILEGED_FIELDS` |
| **D17** | `get_user_by_email` does `.get()` inside a bare `except`, so a duplicated email raises `MultipleObjectsReturned` → `None` → **no email sent**, while the view still redirects to the success page. Live: ids 7, 10, 13, 14 — **4 of 15 members cannot reset their password and are told it worked**. | 0 matches → nothing (unchanged). 1 match → that account, **even if its `username` differs** (D15 makes that reachable). >1 → the account whose `username` *is* the email; none → nothing, **logged**. | `user.service.ts::getUserByEmail` |
| **D19** | `.replace(year=today_year)` on a 29 Feb birthdate raises `ValueError`; `UserDetailView.patch` has no handler, so it 500s and `transaction.atomic()` rolls the whole edit back. Latent — 0 of 15 today. | Clamped to **28 February**. See §2.1 for why 28 and not 1 March. | `user.service.ts::birthdayInYear` |
| **D20** | `user_ids.remove(user.id)` on a list `get_users_attr("id")` filtered to `is_active=True` → `ValueError` for a soft-deleted member → 500 + rollback. **Live: `fondodev` has 2 inactive users.** | The removal is guarded. | `user.service.ts::createBirthdateNotification` |

### 1.2 New deviations registered by this phase

| # | v1 behavior | v2 behavior | Rationale |
|---|---|---|---|
| **P3-D1** | `PATCH /api/user/<id>` with `type = personal` **succeeds** for any member on any target, so the only 403 on this route is the route-level `role <= 3`. | Under **D1**, unprivileged writes are refused with DRF's `403 {"detail": "You do not have permission to perform this action."}`. | The point of the phase. Registered so `manual-tester` reads every new 403 on `/api/user/<id>` as expected. The body is deliberately DRF's generic one — an ownership failure must not be distinguishable from a role failure, or it becomes a probe for which user ids exist. |
| **P3-D2** | A **duplicate email** on a personal update is a `409` — from the `username` write, not from anything about `email` (`auth_user.email` has no unique constraint). | **200.** The edit succeeds and two rows hold the same email, exactly as `fondodev` already does for ids 7/14 and 10/13. | A consequence of **D15**, called out separately because it is the one place a *status code* changes and `manual-tester` will see it directly (v1's own `test_patch_user_conflict` asserts the 409). |
| **P3-D3** | `GET /reset/<uid>/<valid token>/` stores the token in the session and **inserts a `django_session` row**, then 302s to `…/set-password/`. The `sessionid` cookie and the `Cookie` in `Vary` both come from that write. | The **hop is kept**; the **store is not**. The token travels in an `HttpOnly`, `Path=/reset/` cookie named `_password_reset_token` and is re-validated by `check_token` on arrival. No session model, no `django_session` row, no `sessionid`. | The full reasoning is §2.2. Observable differences: the cookie's name and attributes, and the absence of a `django_session` row. `Vary: Cookie` is unaffected and still correct. |
| **P3-D4** | Password-reset tokens are Django's `default_token_generator` — salted SHA-1 over `pk + password + last_login + timestamp` with `SECRET_KEY`, base36 timestamp. | v2's own scheme: HMAC-SHA-256 over the same four inputs, 20 hex characters, same `<b36 ts>-<hash>` **shape** (because `api/urls.py:24` constrains the URL segment). Signed with `DJANGO_SECRET_KEY`, which the deployment already sets. | Authorised in advance by the plan ("v2 uses its **own** token scheme"). Cutover is a hard switch, so no token ever crosses. Runbook: links v1 issued stop working at the switch; Django's timeout is 3 days, so at worst a few members re-request. |
| **P3-D5** | `CsrfViewMiddleware.process_view` performs a `Referer` check for unsafe methods **when `request.is_secure()`**. | Not ported. | **Dead code in v1's production.** `SECURE_PROXY_SSL_HEADER` is `None` in every settings module (verified: `settings.SECURE_PROXY_SSL_HEADER is None`), so behind the load balancer `is_secure()` is `False` and the branch never runs. Porting it would have been *new* behaviour, not a port. |
| **P3-D6** | An **uncaught** exception renders Django's HTML 500 page: `<h1>Server Error (500)</h1>`, `Content-Type: text/html`, `Content-Length: 27`. | A zero-byte 500 with no `Content-Type` (the DRF-empty-body shape). | The same species as **D13** (v2 answers JSON/empty where Django answers HTML), extended to the 500 page. ⚠️ Note v1 has **two** different 500 bodies and v2 reproduces the other one exactly: `UserAppsView`'s `except Exception: return Response(status=500)` is a *DRF* response and really is zero bytes in both. **Corrected 2026-09-02** (parity finding **F1**): that last sentence was true of the *body* and false of the *headers* — v2 stripped `Allow` and `Vary: Accept` off every 500, where v1 keeps them on the DRF-returned one. Fixed, not deviated; the caught 500 is now byte-identical to v1 on all seven inputs that reach that `except`. The **scope of this row is therefore the uncaught 500 only.** |
| **P3-D7** | The `csrftoken` cookie carries `Secure` in production (`CSRF_COOKIE_SECURE = True`) and not in development/test. | Same, keyed on `ENVIRONMENT`. | Not a deviation; recorded because the live comparison in §3 shows it as the one header difference between the two running servers, and it is a settings difference rather than a code one. |

Nothing else in Phase 3 departs from v1.

---

## 2. Judgment calls where v1 was ambiguous or silent

### 2.1 D19 — 28 February, not 1 March, and the reason is Phase 7

The plan left the choice open. Both are defensible as a civil substitute for 29 February; what
decides it is that **this task repeats**.

`__create_birthdate_notification` writes the task with `repeat = 4` (`YEARLY`), and Phase 7's
runner clones it forward with `relativedelta(years=+1)`. `relativedelta` maps 29 February to
**28 February** — pinned in `relativedelta.util.spec.ts` against `python-dateutil==2.7.5`,
where it is recorded as "a leap-day YEARLY task loses 29 February".

So clamping to 28 February makes the *first* notification agree with every clone the scheduler
will ever make of it. Clamping to 1 March would create a permanent one-day disagreement
between the row Phase 3 writes and the row Phase 7 writes from it — visible only in a leap
year, four years after anyone made the decision. 28 February is the choice that needs no
second rule.

### 2.2 The session question — keep the hop, drop the store

The plan called this "a genuine design fork" and asked for a decision with reasoning. Here it
is, in the order it was actually decided.

**First: does the hop have to stay?** Yes, and not for compatibility. Django redirects
`/reset/<uid>/<token>/` → `/reset/<uid>/set-password/` so that the token is out of the URL
before the form page renders. That page loads a **third-party stylesheet** —
`stackpath.bootstrapcdn.com`, in `registration/password_reset_confirm.html` — so with the token
still in the path the browser hands it to a CDN in the `Referer` header. Collapsing the two
steps would be a real regression, and it would be invisible in every test.

**Second: what state does the hop actually carry?** One opaque string, scoped to one browser,
alive for as long as it takes to type a password twice. And Django is not using the session as
a *trust* boundary: `PasswordResetConfirmView.dispatch` re-runs
`token_generator.check_token(self.user, session_token)` on the second request. The session is a
**carrier**, nothing more.

**Third: what would porting sessions cost?** A `django_session` mapping, a `session_data`
codec (Django's signed, base64-wrapped JSON keyed on `SECRET_KEY`), a `sessionid` cookie, an
expiry sweep — and rows written into a table v2 otherwise never touches, in a database shared
with v1 during parity testing. The round-3 sweep already had to delete one such row by hand.

**Decision: an `HttpOnly` cookie carrying the token, re-validated by `check_token`.** It is
*strictly less* state than a session row, not a shortcut: the cookie needs no signing of its
own, because its contents are verified by the same HMAC Django verifies. Forging it means
forging a token bound to the user's id, password hash and last login.

What that gives up, stated plainly:

* no `sessionid` cookie and no `django_session` row — the observable part of **P3-D3**;
* the cookie is `Path=/reset/` rather than `/`, which is tighter, not looser;
* a member who somehow reaches `/reset/<uid>/set-password/` in a *different* browser from the
  one that opened the link gets the invalid-link page. So does v1 — the session cookie is
  per-browser too.

`Vary: Cookie` remains correct and is still emitted, because the response genuinely varies by
cookie. It is registered at `DjangoStack.SESSION`, where v1's `SessionMiddleware` sits, which
is what reproduces the measured `Origin, Cookie` order rather than `Cookie, Origin`.

### 2.3 `changedSectionFields` — the trap one level above the `role` check

The plan and the BA note both fixed the `role` check as "changed, not present", because v1's
client echoes the whole `personal` object back and a presence check would 403 every member's
save.

Implementing it surfaced the same trap one level up. The object the client echoes is
`UserProfileSerializer`'s, and it contains **`full_name`, `role_display` and `id`** — none of
which is a column `__update_user_personal` writes. A raw `changedFields(submitted, stored)`
reports all three as changed (the stored record has no such keys) and the positive allowlist
then 403s the request. 100% false positives, exactly the failure D1 clarification 1 exists to
prevent.

So `changedSectionFields(section, submitted, stored)` intersects the submitted keys with the
section's writable set first — ignoring unknown keys exactly as v1 ignores them — and the
allowlist governs only the keys that *are* writable, which is where `role` and `identification`
live. C6's "positive allowlist" property is unaffected: the set still comes from
`services/user.py`'s field list intersected with the caller's rights, never from the payload.

This is only invisible in v1's own fixtures because those hand-write a minimal `personal`
object. Any real client hits it.

### 2.4 Two different comparators, deliberately

`changedFields` (authorisation) normalises across the JSON/Prisma boundary — `"3"` equals `3`,
`1098765432` equals `1098765432n` — because a phantom difference there becomes a phantom 403.

`pythonNotEqual` (`__update_user_finance`'s change check) does **not**, because Python's
`2000 != "2000"` is `True`: a finance section submitting stringified numbers *writes* in v1 and
bumps `last_modified`, and the monthly TSV depends on `last_modified` moving only when
something changed. Two questions, two answers, and v1 answers them differently too.

### 2.5 The `/api/user/<x>` routing collision — a table-driven `dispatch`

v1 has three patterns on one path shape and Express cannot tell them apart: path-to-regexp v8
dropped inline parameter patterns, so `:app` and `:id` are the same unconstrained segment and
whichever controller is declared first wins **both**. That is not a routing nuisance — it is an
authorisation decision. `DELETE /api/user/power` is deny-all `UserAppsView` in v1 (verified
live: 403 for ADMIN) and would be ADMIN-allowed `UserDetailView` under a naive Nest route.

C20's guard catches the disagreement, but only by answering **500** where v1 answers 403 — 
fail-safe, not correct. So `DjangoUrlPattern` grew an optional `dispatch`: the two colliding
patterns rewrite `req.url` to `/api/user/apps/<x>` and `/api/user/detail/<x>`, prefixes no
client can address (three segments, matching no v1 pattern, so the resolver 404s them), and
each controller binds to exactly one v1 view **by construction**. The C20 guard stays as the
check that table and router agree; `test/v1-view-binding.e2e-spec.ts` keeps testing the
unprotected shape by stripping `dispatch` from its own copy of the table.

Same rationale as finding N3, which already rewrites `req.url` for a different reason: Nest's
router has to be told what Django's resolver already decided.

### 2.6 D5 — an empty `ToAddresses`, and the one thing to confirm

Q18 said "move them to `Bcc`" and D5 says the recipient list is unchanged. The literal
implementation is `ToAddresses: []` with all 15 members in `BccAddresses`, and that is what
shipped: no recipient was invented.

⚠️ **Worth one operator confirmation before the first real approval after cutover.** SES
accepts a `Destination` with only `BccAddresses`, but a message with no `To:` header is scored
more harshly by some spam filters, and this is a formal document. The conventional alternative
is `To: <the fund's own DEFAULT_FROM_EMAIL>`, which needs parsing the display-name form
`Fondo Montanez <no-reply@fonmon.minagle.com>`. It is a one-line change if wanted; it was not
made unilaterally because it invents a recipient the operator did not ask for.

### 2.7 `remove_all_subscriptions` — wired, on the transition only

Parity finding **F5** was right and P2-D4 was wrong: the method is live. It is now wired in the
`preferences` branch, firing **only** on the `true → false` transition
(`services/user.py:217-218`), not on every preferences save. Three e2e cells pin the three
cases (`false→true`: no wipe; `true→false`: one wipe; `false→false`: no wipe).

### 2.8 The bare `except` in `__update_user_preferences` is ported literally

Every failure in that branch is a **404** in v1 — a missing `primary_color`, a colour longer
than `varchar(15)`, an unparseable boolean, even a database error. That is reproduced, with a
`logger.warn` so the cause is not lost. It looks wrong and it is wrong, but a client that
currently sees 404 must keep seeing 404.

⚠️ Note the asymmetry one line up: `obj['preferences']` is subscripted in `update_user`,
*outside* that `except`, so a body with `type: preferences` and no `preferences` key is a
**500**. Verified live.

### 2.9 `activate_user` does not validate the password; the reset flow does

`activate_user` calls `set_password` directly (`services/user.py:118`), so a member can
activate with `12345678` and then be refused the same password on a later reset, where
`SetPasswordForm` runs `AUTH_PASSWORD_VALIDATORS`. Ported as-is.

Also ported: `set_password(None)` stores an *unusable* password, so
`{"password": null, "key": …}` activates an account nobody can ever log into, silently.

### 2.10 v1 keeps only two password validators

`api/settings/base.py:106-113` lists `UserAttributeSimilarityValidator` and
`NumericPasswordValidator` — Django's minimum-length and common-password validators were
removed. So `ab` is an accepted reset password and `12345678` is not. Both pinned.

`quickRatio` is `difflib.SequenceMatcher.quick_ratio`, **not** `ratio` — it ignores order, so
`'olleh'` scores 1.0 against `'hello'`. Using `ratio` would accept passwords v1 rejects. Both
it and the `\W+` split were differentially validated against CPython 3.9 in the v1 image.

---

## 3. Five behaviours corrected against the live v1

v1 was brought up (gunicorn on `127.0.0.1:8449`, `api.settings.production`, `fondodev`,
read-only probes) and both stacks were driven. Five things came back different from what the
source suggested. **One was a real defect in v2**; the rest were assumptions that had not been
checked.

| # | What I had | What v1 does | Consequence |
|---|---|---|---|
| **1** ⚠️ | `PATCH /api/user` with JSON → **415**, from `@DrfParsers(MULTIPART)` mirroring `@parser_classes((MultiPartParser,))`. | **500.** `rest_framework.decorators.parser_classes` is for *function*-based views: on an `APIView` **method** it sets the attribute on the unbound function and `dispatch` never reads it. The default parsers apply, the JSON parses to `{}`, and `obj['file']` raises `KeyError`. `text/plain` really is a 415 — outside the *default* list. | **The real defect.** v2 refused a request v1 accepts-then-500s on: a client could tell them apart. ⚠️ **The same decorator is misused twice more** — `LoanView.patch` (`views/loan.py:49`) and `FileView.post` (`views/file.py:15`) — so Phases 4 and 8 must not "restore" the narrowing either. |
| **2** | `PasswordResetView.post` read `request.body`. | `PasswordResetForm(request.POST)`, and Django populates `request.POST` for `x-www-form-urlencoded` and `multipart/form-data` **only**. A JSON body is invisible: v1 answers 302 and sends **nothing**. | v2 would have emailed a member where v1 does not. Now reads `djangoPostData(request)`. |
| **3** | CSRF checked inside each handler, `@All()` fallbacks answering 405. | `CsrfViewMiddleware.process_view` runs **before** the view's `dispatch` resolves a handler, so `DELETE /password_reset/` with no cookie is a **403**, and only becomes a 405 once a valid token is present. | All four reset routes are now single `@All` handlers, so Nest's router cannot get in front of the check. Both statuses were inverted before. |
| **4** | `DELETE /reset/<uid>/set-password/` → 405. | **200**, rendering the invalid-link page. `PasswordResetConfirmView.dispatch` returns before `super().dispatch()`, which is where Django checks the method at all. The 405 exists only once the link validates. | The confirm route now answers the invalid page for any method. |
| **5** | `Cache-Control: …, must-revalidate, private`; CSRF failure page `Content-Type: text/html; charset=utf-8`. | **No `private`** — Django 2.2's `add_never_cache_headers` does not pass it (3.0 added it). And `csrf_failure` builds `HttpResponseForbidden(..., content_type='text/html')` with **no charset**, unlike every other page here. | Both matched. |

**Verified afterwards, live, byte for byte:** `/password_reset/` (CSRF token normalised),
`/password_reset/done/`, `/reset/done/`, `/reset/<uid>/<invalid token>/`,
`/reset/<uid>/set-password/`, the CSRF 403 page (1386 bytes) and `OPTIONS
/password_reset/done/` are **identical between v1 and v2**, bodies and headers, with one
difference: the `Secure` flag on the `csrftoken` cookie, because v1 was running production
settings and v2 development (**P3-D7**).

`fondodev` after the session: `94 / 1468 / 1` on `fondo_api_notificationsubscriptions`,
`auth_user` 15, `fondo_api_power` 20, `fondo_api_schedulertask` 632, `django_session` 20,
`authtoken_token` 15. **Unchanged.**

---

## 4. What `manual-tester` must expect

### 4.1 Expected diffs (not failures)

Everything in §1. The ones that will show up first:

1. **New 403s on `PATCH /api/user/<id>`** (D1, D16, P3-D1) — a member changing their own
   `role` or `identification`, a member touching anyone else's `personal`, anyone but
   ADMIN/TREASURER declaring `type: finance`. Body is DRF's generic
   `{"detail": "You do not have permission to perform this action."}`.
2. **`username` no longer moves** (D15) and the duplicate-email PATCH is **200, not 409**
   (P3-D2).
3. **`PATCH /api/user/-1` is a 200, not a 404** (D14). `DELETE /api/user/-1` is still a 404.
4. **`POST /api/user/power` with `type: patch` is 403 unless the caller is the requestee**
   (D2), and the approval email has an **empty `To`** with everyone in `Bcc` (D5).
5. **Password reset now works for the four members it silently failed for** (D17) — and the
   two custodial accounts (13, 14) now deliberately receive nothing.
6. **No `django_session` row and no `sessionid` cookie** on `GET /reset/<uid>/<token>/`
   (P3-D3); the redirect and its `Vary: Origin, Cookie` are unchanged.
7. **Reset links are not interchangeable between the two systems** (P3-D4). Issue and consume a
   link within one stack.
8. **Django's HTML 500 page vs a zero-byte 500** (P3-D6), and D13's HTML-vs-JSON generally.

### 4.2 Things that are *not* deviations and must match exactly

* every response body and key order on `GET /api/user`, `GET /api/user/<id>`,
  `POST /api/user/birthdates`, `POST /api/user/power` with `type: get`;
* the four `SchedulerTask` columns and `payload::text` for a birthdate edit — including the
  **unordered** `user_ids` list, which is PostgreSQL's heap order and must not be sorted;
* `UserFinance` after a TSV upload, including `last_modified` **not** moving when nothing
  changed;
* the four password-reset pages and the CSRF failure page, byte for byte;
* the three `Vary` strings and their element order.

### 4.3 Pointing v2 at `fondodev`

```bash
export PATH="/home/miguel/.config/nvm/versions/node/v24.20.0/bin:$PATH"
cd ~/Projects/Fondo-API-v2

# .env already points DATABASE_URL at fondodev. The only new variable this phase adds:
export DJANGO_SECRET_KEY=parity-test-secret-key   # same value the v1 probe container uses
export PORT=8450
npx ts-node -r tsconfig-paths/register src/main.ts
```

and v1, in the throwaway container that is already built:

```bash
docker exec -d -w /app fondo-v1-p3 sh -c \
  'PYTHONPATH=/app gunicorn --bind 127.0.0.1:8449 api.wsgi -w 2 --log-level=info'
```

⚠️ **`DJANGO_SECRET_KEY` is new and is required in production** (`envSchema`'s refinement).
Outside production it falls back to a documented development literal, mirroring v1, where only
`production.py` reads the environment. Reusing v1's variable name rather than inventing one
means the deployment already sets it.

⚠️ **Never set `TEST_DATABASE_URL` to `fondodev`.** Condition **C25** now makes that an
immediate, named failure instead of a `TRUNCATE`, but the fixture is still the one artefact in
this project that cannot be regenerated.

### 4.4 Suggested probes beyond the ported tests

* A member editing their own profile **while echoing the whole `GET /api/user/<id>` `user`
  object** as `personal` — that is the shape §2.3 is about, and the one a naive implementation
  403s.
* `PATCH /api/user/<id>` on **users 13 and 14** in v2 (v1 409s them — do not run it there;
  runbook item 1).
* A password reset for `criss9413@hotmail.com` and `mhjc123@hotmail.com` — v1 sends nothing,
  v2 sends to ids 7 and 10.
* A birthdate edit on an **inactive** user (D20) — v1 500s, v2 200s.
* `PATCH /api/user` with JSON, form, multipart-without-`file`, and `text/plain` — 500/500/500/415
  in both (§3.1).

---

## 5. Corrections to fold back into `MIGRATION_PLAN.md`

### 5.1 Phase 3's scope note said `@parser_classes` narrows the parser list. It does not.

The plan's Phase 3 risks section says *"TSV parsing: `line.decode('utf-8')…`"* and the Phase 1
work registered `@parser_classes((MultiPartParser,))` as a real narrowing on three handlers.
It is a **no-op on all three** — see §3.1. Phases 4 and 8 inherit the correction.

### 5.2 The plan's Phase 3 bullet list omitted the birthdate `SchedulerTask`

Already noted by review finding **S9**; fixed by landing Phase **7a** here. The plan's Phase 3
parity criteria should gain a row: *"a birthdate edit produces a byte-identical
`SchedulerTask`, `payload::text` and unordered `user_ids` included"*.

### 5.3 `resolveSection`'s doc claimed a missing `type` falls through to `preferences`

It does not: `obj['type']` raises `KeyError` in `update_user` and the request is a **500**.
Corrected in `user-patch.policy.ts`; only an *unrecognised* `type` falls through.

### 5.4 D11's physical `UNIQUE (user_id)` belongs to Phase 9, not Phase 3

The register says "unique constraint on `user_id` for both; upsert not insert". The
application-level half shipped; the **schema** half cannot, because §4 rule 6 forbids v2
running migrations against a database v1 shares and §4 rule 11 warns that the baseline is
hand-patched. It should be listed with the Phase 9 `hstore → jsonb` conversion. Nothing in v2
can create a second row — `create_user` is the only writer and it runs inside a transaction —
so the deferral is safe.

### 5.5 `DrfViewHeaders` did not need widening for `Vary: Cookie`

The plan (and the `django-url-conf.ts` doc) said Phase 3 must widen the per-view header table.
It did not: `Vary: Cookie` is a property of *which layer touched a cookie*, and C21's depth
model already expresses that. Registering each hook at its v1 layer's depth reproduces all
three measured orders with no per-route string. Recorded in `django-url-conf.ts`.
