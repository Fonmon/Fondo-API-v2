# Phase 1 — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5 and `docs/phase-0-deviations.md`.
Audience: `nestjs-reviewer` (deviations), `manual-tester` (anything it must expect as a
non-failure), and whoever maintains `MIGRATION_PLAN.md` (findings).

The DRF response bodies this phase had to pin are in
[`phase-1-drf-auth-bodies.md`](phase-1-drf-auth-bodies.md), with their derivation.

---

## 1. Registered deviations from v1

| # | v1 behavior | v2 behavior | Rationale |
|---|---|---|---|
| **P1-D1** | `GET /health` does not exist. | Marked `@Public()`. | Phase 1 makes the guards global and default-deny; without this the Phase 0 liveness probe would 401. The route already had no v1 counterpart (P0-D2). |
| ~~**P1-D2**~~ | `OPTIONS /api-token-auth` returns DRF's browsable-API metadata document: `200 {"name":"Obtain Auth Token","description":"","renders":[…],"parses":[…]}`. | **Implemented, 2026-09-02 — deviation withdrawn.** v2 answers the same 200 and the same 164 bytes; `OPTIONS /api/user/activate/<id>` answers `UserActivateView`'s 172-byte document likewise. | ⚠️ **Withdrawn** (parity finding **F4**). It was registered as "v2 ships no browsable API and no `OPTIONS` metadata layer", but the metadata document is not the browsable API — it is `SimpleMetadata.determine_metadata`, four static keys read off the view's own class attributes, and both documents are constants. Reproducing them cost less than carrying the deviation, and carrying it would have meant extending it to every public view a later phase adds. `src/common/http/drf-metadata.ts` holds both, captured from the live v1 rather than derived. The **residual** is the browsable API proper, now registered as **P3-D8**. Earlier correction (2026-08-31, parity finding F1) stands: before that, `app.enableCors()` answered every `OPTIONS` with a 204 before the router, bypassing authentication on that verb for every route (condition C14). |
| **P1-D3** | Django's `PBKDF2PasswordHasher` transparently **upgrades** a hash on login when `must_update` is true (different algorithm or iteration count). | v2 verifies and never rehashes. | Every `auth_user` row in `fondodev` is already `pbkdf2_sha256$150000`, so `must_update` is false for all of them and the two behaviors are observationally identical today. Rehash-on-login is on the post-cutover backlog (plan §9) and would be a *write* to a table v1 also owns. |
| **P1-D4** | `check_password` supports `pbkdf2_sha1`, `argon2` and `bcrypt_sha256` as well (Django's default `PASSWORD_HASHERS` list). | Only `pbkdf2_sha256` verifies; anything else returns `false`, i.e. a normal failed login. | No such row exists (verified across all 15 `auth_user` rows), v1 never writes one, and three unexercised code paths in a credential check are a liability. A future foreign hash degrades to "wrong password", not to a crash. |

Nothing else in Phase 1 departs from v1.

**Not a deviation, but `manual-tester` must not read it as one:** Phase 1 introduces the
`/__matrix/<ViewName>` routes **in the e2e test module only** (`test/support/matrix-controllers.ts`).
They are never registered in `AppModule` and do not exist in a running v2.

---

## 2. Judgment calls where v1 was ambiguous or silent

### 2.1 Login resolves `auth_user.username`, **not** `email` — and the two are not always equal

`fondo_api/models.py` declares `UserProfile.USERNAME_FIELD = 'email'`, and the plan states
"v1 sets `username = email` everywhere". Both are true *and neither decides the lookup*.
`api/settings/base.py` leaves `AUTH_USER_MODEL` commented out, so `get_user_model()` is
`django.contrib.auth.models.User`, whose `USERNAME_FIELD` is `username`. DRF's
`AuthTokenSerializer` calls `django.contrib.auth.authenticate(username=…)`, which reaches
`ModelBackend.get_by_natural_key` → `User.objects.get(username=…)`. `UserProfile`'s
`USERNAME_FIELD` never participates in authentication.

This is not academic. **Two of the fifteen users in `fondodev` have `username != email`:**

```
 id | username           | email
 14 | ainhoa.montanez    | criss9413@hotmail.com
 13 | sebastian.montanez | mhjc123@hotmail.com
```

They log in with `ainhoa.montanez`, and would be locked out by a v2 that looked up `email`.
v2 therefore queries `username`. Two consequences for later phases:

* **Phase 3**: `__update_user_personal` does `user.username = obj['email']`
  (`services/user.py:230`). If either of those two users is ever edited through
  `PATCH /api/user/<id>`, v1 **silently changes their login name** to their email address.
  Port it faithfully — but the operator should know it is there.
* Any future "log in with your email" convenience must be an *addition*, not a replacement.

### 2.2 A malformed token 401s even on a public route

`permission_classes = []` clears `IsAuthenticated` and `APIRolePermission`. It does not clear
`authentication_classes`, and `APIView.initial()` authenticates before it checks permissions.
So `POST /api-token-auth` with `Authorization: Token <garbage>` is `401 {"detail":"Invalid
token."}` — the login never runs. Confirmed by running the pinned stack. `TokenAuthGuard`
therefore executes for every route including `@Public()` ones, and only `RolesGuard` honours
`@Public()`. Getting this backwards would make the login endpoint accept requests v1 rejects.

### 2.3 Nest answers 404 where DRF answers 405

Django resolves the URL first, then DRF's `dispatch` raises `MethodNotAllowed` for a method
the view class does not implement. Express has no route for the method at all, so Nest 404s.
`AuthController.methodNotAllowed` adds an explicit `@All()` fallback for `/api-token-auth`
(405 + `Allow: POST, OPTIONS`), and `DrfException.methodNotAllowed()` is the reusable piece.

⚠️ **This is cross-cutting, not local.** Every controller in Phases 3–8 needs the same
fallback or it will 404 where v1 405s — for example `PUT /api/loan` (v1: 405 with
`Allow: GET, POST, PATCH, HEAD, OPTIONS`). It is a small, mechanical addition per controller;
it just has to be remembered. Note the `Allow` header lists the *implemented* handlers, which
is a different set from the *permitted* ones — v1 returns `Allow: GET, POST, PUT, PATCH,
DELETE, HEAD, OPTIONS` on a view that implements all five, regardless of `list_permissions`.

### 2.4 The `role` field: "present in the body" vs "actually changed"

§5 D1 says `role` is writable by ADMIN alone. v1's client sends the **whole** `personal`
object on every `PATCH`, `role` included, because `__update_user_personal` reads
`obj['role']` unconditionally. So a literal "the `role` key is present and you are not ADMIN
→ 403" would reject a member editing their own phone number.

✅ **Decided** (plan v0.11 §5 D1 clarification 1, ratified by the C8 resolution in §7): the
**`changedFields` reading**. A 403 fires only when the submitted value differs from the stored
one, so echoing an unchanged `role` is fine and a real escalation attempt is a rare,
high-signal event worth logging. `assertUserPatchAllowed` now composes the two levels
explicitly, so which mechanism is authoritative is no longer a matter of reading order:

1. **`body.type` gates the section** (`resolveSection` → `assertSectionWritable`). A declared
   `finance` write by a MEMBER is a 403 whether the finance object is empty, unchanged or
   absent, and this decision never looks at a field.
2. **A section the caller did not declare is ignored.** With `type: 'personal'`, a `finance`
   key in the body is dropped by v1 and by v2 — never a 403. This is what keeps every
   member's ordinary save working, since v1's client posts both sections every time.
3. **`changedFields` gates privileged fields *inside* the dispatched section** — `role` today,
   `identification` once Q26 is answered (D16).

`changedFields` normalises across the JSON/Prisma boundary (`bigint` vs `number`, `Date` vs
`'YYYY-MM-DD'`, numeric strings), because an unnormalised comparison reports every such field
as changed and would turn rule 3 into a 403 on ordinary saves.

### 2.5 `PATCH /api/user/-1` does not mean "me" in v1

`UserDetailView.get` substitutes `request.user.id` for `-1`; `.patch` and `.delete` do not,
so `PATCH /api/user/-1` looks up user `-1` and 404s. `resolveUserId(id, actor, allowSentinel)`
takes the substitution as an explicit argument so Phase 3 cannot adopt either behavior by
accident. Flagged for the operator: the asymmetry looks like an oversight rather than a rule.

### 2.6 Deny-by-default is enforced structurally, not by convention

The guards are registered as `APP_GUARD`s inside `AuthModule`, so they cover every route in
the application. A controller with no `@V1View(...)` has no rule, and `isRoleAllowed` returns
`false` for `undefined` — the route becomes **unreachable**, which is a loud failure, rather
than **open**, which is a silent one. `@V1View('Typo')` throws at import time, before the app
can boot, for the same reason. `role-matrix.e2e-spec.ts` proves an unregistered controller
403s for all four roles over real HTTP.

### 2.7 `DrfException` is a second parity envelope alongside `ApiException`

Phase 0's filter renders v1's `{'message': …}` convention. DRF's own errors are
`{'detail': …}` (or a serializer's `{field: [msg]}` dict) plus a `WWW-Authenticate` header.
Rather than bend `ApiException`, Phase 1 adds `DrfException` with four static factories — one
per shape DRF actually produces here — and a dedicated branch in `ApiExceptionFilter`. The
constructor is public **only** so tests can write `toThrow(DrfException)`; the factories are
the API.

---

## 3. Findings for `MIGRATION_PLAN.md`

1. **✅ The Phase 1 open item is closed.** The 401/403 bodies were derived from the pinned DRF
   source *and* confirmed by running the pinned stack. `manual-tester` no longer needs to
   capture them; `docs/phase-1-drf-auth-bodies.md` is the reference. The plan's Phase 1
   parity criteria can be updated to cite it.

2. **The plan's "`username = email` everywhere" is not true of the live data.** Two of fifteen
   `fondodev` users differ (§2.1). The statement should be corrected to "v1 *writes*
   `username = email`, but rows predating that path exist and authentication resolves
   `username`".

3. **401 vs 403 is unambiguous for this project.** The plan flags it as a risk;
   `TokenAuthentication.authenticate_header()` returns a truthy `'Token'`, so DRF's
   coerce-to-403 branch is dead code here. **Every** authentication failure is 401 with
   `WWW-Authenticate: Token`.

4. **`{"detail": …}` is DRF's shape, and it is *not* only for 401/403.** `405` uses it too.
   Cross-cutting rule §4.1 ("Errors are `{ message: … }`") needs the qualifier: v1's *views*
   return `{'message': …}`; DRF's *framework-level* errors return `{'detail': …}`.

5. **Nest 404s where DRF 405s (§2.3).** Not mentioned in the plan; affects every controller
   from Phase 3 onward. Worth a line in §4 as a cross-cutting rule.

6. **Django's password hasher is fully reproducible in Node** — `pbkdf2_sha256`, 150000
   iterations, 12-char `[a-zA-Z0-9]` salt, 32-byte key, base64. Five golden vectors from
   `Django==2.2.27` are pinned in `django-password.service.spec.ts`, including a non-ASCII
   password (`force_bytes` is UTF-8) and the empty password. No `must_update` path is needed
   before cutover.

7. **`authtoken_token.created` has no DB default**, like every other `auto_now_add` column.
   Already covered by rule §4.5; noted because the login path is the first place Phase 1
   writes a row and it would have been an easy NOT NULL violation.

8. **v1 returns Django's HTML 404 page for an unknown URL**, not JSON:
   `<h1>Not Found</h1><p>The requested resource was not found on this server.</p>`.
   v2 returns `{"message": …}` (Phase 0's filter). Pre-existing and probably not worth
   fixing, but `manual-tester` will see it, so it should be registered somewhere.

9. **`OPTIONS` on a guarded v1 view is authenticated and permission-checked**, and would
   return DRF's metadata document if it were ever allowed. It never is: `list_permissions`
   has no `OPTIONS` key for **any** view, so `APIRolePermission`'s bare `except` denies it for
   every role, ADMIN included — measured. v2 matches. The document is reachable only on the
   two views that clear `permission_classes`, and since 2026-09-02 v2 serves it there too
   (P1-D2 withdrawn, parity finding F4).

10. **The plan says "14 view classes × each method in `list_permissions`".** The captured
    ground truth deliberately goes wider — 14 × **5 methods** × 4 roles = 280 — because the
    methods *absent* from `list_permissions` are exactly where the default-deny fallthrough
    lives, and testing only the declared methods would never exercise it.
