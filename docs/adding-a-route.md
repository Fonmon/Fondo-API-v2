# Adding a route

**Audience:** whoever implements a controller in Phases 4–8 (loans, activities, notifications,
files, admin, saving accounts). **Purpose:** make it mechanical. Phase 3 discovered every item
below the hard way; none of them is optional, and six of the eight fail *closed*, which is the
right design but still costs a day each when the failure is "the route 403s and nobody knows
why".

Written to close review condition **C36** (`docs/review-phase-3.md`). Cross-referenced from
`MIGRATION_PLAN.md` §4 rule 14.

> The one-sentence version: **a v2 route is not a Nest decorator, it is a row in four tables**
> (URL conf, permission matrix, DRF view headers, parser policy) that must all agree with each
> other and with v1.

---

## 0. Before you write the controller

Read, in this order:

1. the v1 view — `fondo_api/views/<module>.py` — including which `except` clause sits around
   each `obj['key']`, because that is the whole error contract (404 vs 409 vs 500);
2. its row in `fondo_api/permissions.py:list_permissions`;
3. its pattern in `fondo_api/urls.py` (or `api/urls.py`);
4. `MIGRATION_PLAN.md` §4 (cross-cutting rules) and §5 (the deviation register — several rows
   are **pre-declared** for Phases 4–8, e.g. D22/D23; do not re-file them as new findings).

---

## 1. The URL-conf entry — `src/common/http/django-url-conf.ts`

**Why:** Django resolves an ordered list of anchored, **case-sensitive** regexes *before*
authentication; Express matches case-insensitively, non-strictly, and (since v5) without inline
parameter patterns. `DJANGO_URL_CONF` is v1's table transcribed, resolved ahead of the guards
by `DjangoUrlResolverMiddleware`, and it is **fail-closed**: a path absent from it cannot reach
a controller.

**In practice for Phases 4–8 the entry already exists** — v1's whole table was transcribed in
Phase 2 (condition C9): 23 patterns, plus a `view: null` row for the v2-only `/health`, minus
`^api/alexa/?$` which is deliberately absent (Alexa is not migrated, plan §1). Your job is to
*check* the entry rather than add one:

- [ ] The pattern matches the paths your controller mounts, and no others.
- [ ] `view:` names the v1 view class your controller will declare with `@V1View`. This is the
      authorisation key (condition **C20**), not documentation.
- [ ] `drf.allow` is the `Allow` string v1 sends — see §4.
- [ ] `drf.renderers` is the view's `renderer_classes` — see §7.

### The trailing `/?`

**There is no rule.** v1's table is inconsistent and the inconsistency is part of the contract,
so copy the regex, do not summarise it:

| v1 pattern | trailing slash |
|---|---|
| `^api/loan/?$`, `^api/user/?$`, `^api/file/?$`, `^api/admin/?$`, `^api/saving-account/?$`, `^api/activity/year/?$`, `^api/notification/(?P<operation>[a-zA-Z]+)/?$` | **optional** (`/?`) |
| `^api/loan/(?P<id>[0-9]+)$`, `^api/user/(?P<id>-?[0-9]+)$`, `^api/user/(?P<app>-?[a-zA-Z]+)$`, `^api/user/activate/(?P<id>[0-9]+)$`, `^api/loan/(?P<id>[0-9]+)/(?P<app>[a-zA-Z]+)$`, `^api/file/(?P<id>[0-9]+)$`, `^api/activity/year/(?P<id_year>[0-9]+)$` | **none** — `…/5/` is a 404 |
| `^api/activity/(?P<id>[0-9]+)/?$` | **optional — the lone detail-route exception** |
| `password_reset/`, `password_reset/done/`, `reset/…/…/`, `reset/done/` | **mandatory**; `APPEND_SLASH` 301s the bare form |

So: **`activity-by-id` takes `/?`; loan detail, user detail, file detail and
activity-year detail do not.** Getting this wrong is not cosmetic — `DELETE /api/user/5/` is an
inert 404 in v1 and was a real soft delete in v2 before C9 (finding S7).

**Example:** `django-url-conf.ts` — `^api/activity/[0-9]+/?$` (with the `⚠️ The one detail
route that accepts a trailing slash` comment) next to `^api/loan/[0-9]+$` immediately above.

### `dispatch` — only when Express cannot tell two v1 patterns apart

If two v1 patterns share a path *shape* but differ by character class (the `/api/user/<app>`
vs `/api/user/<id>` collision), add a `dispatch` that rewrites `req.url` to an internal prefix
only that pattern can produce, and mount the controller there.

- [ ] The rewritten prefix must be **unreachable from outside** (it must match no pattern in
      the table), or a client can address it directly.

**Example:** the `UserAppsView` / `UserDetailView` pair in `django-url-conf.ts`, mounted at
`api/user/apps` and `api/user/detail` by `user-apps.controller.ts` / `user-detail.controller.ts`.

---

## 2. `@V1View('<ViewName>')` on the controller class

**Why:** v1 authorises on `view.__class__.__name__`. `@V1View` binds the Nest controller to
that name so the permission matrix stays a literal transcription of v1's dict and renaming a v2
controller cannot silently change who may call it. The name is a literal union type, so a typo
is a **compile** error, and a name absent from the matrix throws at class-decoration time
(i.e. at import, before boot).

- [ ] One controller ⇒ exactly one v1 view. If your controller would need two names, it should
      be two controllers with a `dispatch` (§1).
- [ ] Views with `permission_classes = []` / `()` get `@Public()` instead — never `@V1View`.
      Plain `django.contrib.auth` views (the password-reset pages) get `@DjangoView()`.

**Example:** `src/users/user.controller.ts:51` (`@V1View('UserView')`);
`src/users/user-activate.controller.ts:34` (`@Public()`, because `UserActivateView` clears its
permission classes).

---

## 3. The permission-matrix row — `src/auth/permissions/permission-matrix.ts`

**Why:** `APIRolePermission.has_permission` reads `list_permissions[view][method]` inside a
**bare `except`**, so *any* missing entry — unknown view, unknown method, missing profile — is
`return False`. **Default-deny.** `RolesGuard` reproduces that deliberately: a route is
unreachable, never open, until it appears in the matrix.

- [ ] Transcribe the rule shape exactly. An `int` N is a **ceiling** (`role <= N`); a list is
      **exact membership** (`role in [...]`). Do not "tidy" `3` into `[0,1,2,3]` — they differ
      the moment a role is added.
- [ ] A method **absent** from a view's entry is denied for every role, ADMIN included. That is
      usually intentional (v1's `LoanView` has no `DELETE`, so `DELETE /api/loan` is a 403 for
      role 0, verified live). Do not add rows v1 does not have.
- [ ] `OPTIONS` is never a key in v1's dict ⇒ on a guarded view `OPTIONS` is **always a 403**
      (plan §4 rule 13). Do not add one.
- [ ] The matrix and the URL table must name the same view — they are linked at compile time
      through `V1ViewName`, and the guard looks up **the view the URL table resolved**, not the
      `@V1View` of whichever Nest route Express matched (condition **C20**).

**Example:** `permission-matrix.ts:49` — `LoanView: { GET: Role.MEMBER, POST: Role.MEMBER,
PATCH: [Role.ADMIN, Role.TREASURER] }`, against `fondo_api/permissions.py`.

---

## 4. The `@All()` fallback and its `Allow` string

**Why:** Nest 404s where DRF 405s. Django resolves the URL and *then* DRF raises
`MethodNotAllowed`; Express has no route for an unmapped method at all, so without a catch-all
the request never reaches the guarded pipeline (plan §4 rule 12).

- [ ] Add `@All()` (or `@All(':id')` on a parameterised mount) as the **last** handler.
- [ ] Throw `DrfException.methodNotAllowed(request.method, '<Allow>')`.
- [ ] The `Allow` string lists the methods the v1 view **implements**, in DRF's order — a
      different set from the ones it *permits*. Use the same string as the `drf.allow` in the
      URL table; both were read off live v1 responses.
- [ ] Mark it `@DrfNoRequestData()` (§5). Every `@All()` fallback needs it.
- [ ] ⚠️ On a **guarded** view this handler is normally unreachable: `APIView.initial()` checks
      permissions before `dispatch` resolves a handler, so an unimplemented method 403s, it
      does not 405. The route exists to give `RolesGuard` something to guard.
- [ ] ⚠️ On an **unguarded** view (`permission_classes = []`) the opposite holds: the request
      reaches DRF's own `OPTIONS` handler, which returns `SimpleMetadata`'s document. Return
      `drfOptionsMetadata(...)` instead of throwing (parity finding **F4**).

**Examples:** guarded — `src/users/user.controller.ts:137-141`; unguarded —
`src/users/user-activate.controller.ts:56-61` and `src/auth/auth.controller.ts:52-57`.

---

## 5. `@DrfNoRequestData()` when the handler never reads the body

**Why:** DRF negotiates a parser **lazily**, the first time the view touches `request.data`. A
handler that never touches it never 415s and never surfaces a JSON parse error, whatever
`Content-Type` arrived. Nest's interceptor runs for every handler, so without the marker v2
answers 415 or 400 where v1 answers 405, 200 or 201 (review condition **C10**).

- [ ] Every `@All()` 405/OPTIONS fallback.
- [ ] Every handler that ignores the body. In Phase 5 that includes `ActivityYearView.post`
      (`views/activity.py:38`), which calls `create_year()` and never reads `request.data`, so
      `POST /api/activity/year` with `text/plain` is a **201** in v1.
- [ ] For a handler where only *some* branches read the body, mark the handler and call
      `assertRequestDataParsable(request)` at the top of the branches that do.

**Example:** `src/users/user-apps.controller.ts:69` + `:83` — the handler is marked and the
`'power'` branch (which does read the body) calls `assertRequestDataParsable` itself, while the
`'birthdates'` branch does not.

---

## 6. File parts: `readUploadedFile`, and the two traps around it

**Why:** DRF's `request.data` is the `QueryDict` **merged with** `FILES`, and that merge is the
exact mechanism of deviation **D23** (a scalar sent as a part carrying a `filename` is
stringified to the filename and written to the database). v2 deliberately does **not**
implement the merge — files come from `request.files`, scalars from `request.body`, never
merged (plan §4 rule **12c**). So a handler must reach for the file explicitly.

- [ ] Read file parts with `readUploadedFile(request, 'file')` from
      `src/common/http/django-multipart.ts`. **Do not re-implement it**, and do not import it
      out of a feature module — that is how the second copy, and with it the merge, gets
      written (condition **C36**).
- [ ] A missing part is v1's `KeyError` → **500**, not a 400. Keep it.
- [ ] Parse the file with `src/common/http/django-tsv.ts` — `djangoFileLines`, `requireColumn`,
      `parseMoneyColumn`. `parseMoneyColumn` is `int(round(float(x), 0))` with CPython's
      **half-even** rounding; two copies of it is how the user file and the loan file silently
      diverge by a peso.
- [ ] ⚠️ **Do NOT narrow the parser list.** `@parser_classes((MultiPartParser,))` on an
      `APIView` **method** is a **no-op** in v1 (plan §4 rule **12b**): the decorator is written
      for function-based views and `APIView.dispatch` reads `self.parser_classes` from the
      *class*. `UserView.patch` (P3), **`LoanView.patch` (`views/loan.py:49`, P4)** and
      **`FileView.post` (`views/file.py:15`, P8)** therefore all accept the **default** parser
      list, JSON included, and then 500 inside the handler. Measured on live v1:
      `application/json` → **500**, `application/x-www-form-urlencoded` → **500**, multipart
      with no `file` part → **500**, `text/plain` → **415** (outside the default list too).
      An earlier Phase 3 controller carried `@DrfParsers(MULTIPART)` and answered 415 for JSON;
      that was wrong in the direction a client can observe. **This must not be "restored" as a
      narrowing in Phase 4 or Phase 8.**

**Example:** `src/users/user.controller.ts` `bulkUpdate` — three lines, no parser decorator, and
the docblock above it carries the measured table.

---

## 7. `DrfViewHeaders.renderers` in the URL table

**Why:** two different DRF behaviours read `renderer_classes`, and both run **before** your
handler:

- `APIView.default_response_headers` sets `Vary: Accept` when `len(renderer_classes) > 1`. It
  is attached to *every* response the view produces, including the 401 and 403 raised in
  `initial()`.
- `perform_content_negotiation` negotiates against it in `initial()` — **before**
  authentication. An unacceptable `Accept` is a **406 before the guards, the handler and any
  write** (finding F6: `DELETE /api/user/13` under `Accept: application/xml` was v1 refusing
  and v2 soft-deleting the row). A `?format=` naming no renderer is an `Http404`, also before
  authentication.

- [ ] Use `DRF('<allow>')` for a view on DRF's defaults (`JSONRenderer` +
      `BrowsableAPIRenderer`) — that is every view in Phases 4–8.
- [ ] Use `DRF_JSON_ONLY('<allow>')` only for a view that narrows `renderer_classes`. In all of
      v1 that is `ObtainAuthToken` alone — the one view with no `Vary: Accept`.
- [ ] `null` only for a plain Django view (the password-reset pages) or a v2-only route.

**Example:** `django-url-conf.ts` — `{ regex: /^api\/loan\/?$/, view: 'LoanView', drf: DRF('GET,
POST, PATCH, HEAD, OPTIONS') }` against `{ …, view: 'ObtainAuthToken', drf:
DRF_JSON_ONLY('POST, OPTIONS') }`.

---

## 8. Layering, so the next phase can reuse what you write

- **Controller** = HTTP glue only: parse params, call a service, map the result. No Prisma, no
  transactions, no query building.
- **Service** = all business logic and all DB access, all transactions (`prisma.$transaction`
  for the units v1 wraps in `transaction.atomic()`), dependencies injected via the constructor.
- **Shared semantics go in `src/common/`, never in a feature module.** The ones that already
  exist — reach for these before writing anything that resembles them:

| need | module |
|---|---|
| `QueryDict.get` (last value of a repeated key) | `common/http/django-query.ts` |
| CPython `int(str)`, `obj['key']`, Django field coercion, `!=` semantics | `common/utils/python-obj.ts` |
| `request.FILES[field]` | `common/http/django-multipart.ts` (`readUploadedFile`) |
| uploaded-file lines, TSV columns, money columns | `common/http/django-tsv.ts` |
| calendar dates, "today", `auto_now` values | `common/utils/timezone.util.ts` — ⚠️ **never** `new Date().getFullYear()`; the host zone is not Bogotá (condition **C28**). Phase 4's `from_date`, `payday_limit` and the T−5d/T−1d reminder dates all go through `todayInBogota()` / `todayForAutoNowDateColumn()` |
| half-even money rounding | `common/utils/rounding.util.ts` |
| Spanish date/number formatting for emails | `common/i18n/spanish-format.ts` |
| `json.dumps` byte-compatibility (SQS payloads) | `common/utils/python-json-dumps.ts` |
| pagination envelopes | `common/http/pagination.ts` |

---

## 9. Before you call the route done

- [ ] `npm run lint` and `npm run typecheck` clean.
- [ ] Unit tests for the service (ORM and SES/SQS/GCS mocked), e2e tests through Supertest
      against the test database.
- [ ] e2e cells for the **authorisation** matrix, not just the happy path: one call per role,
      plus the methods the view does not implement (403, not 405, on a guarded view).
- [ ] The `Allow` header and `Vary` asserted on at least one response per view.
- [ ] Anything anchored to a v1 quirk carries the v1 file:line in a comment, so a later reader
      cannot mistake it for a v2 bug.
- [ ] Anything you decided *not* to reproduce is a row in `MIGRATION_PLAN.md` §5, written
      before the reviewer asks.

---

## Appendix — the seven-line skeleton

```ts
@V1View('LoanView')                       // §2 — and it must match DJANGO_URL_CONF's `view`
@Controller('api/loan')                   // §1 — the pattern is already in the URL table
export class LoanController {
  constructor(private readonly loans: LoanService) {}   // §8 — no Prisma here

  @Get()
  list(@Query('page') page?: string | string[]) {
    const raw = lastQueryValue(page);      // §8 — common/http/django-query.ts
    ...pythonInt(raw)                      // §8 — common/utils/python-obj.ts
  }

  @Patch()
  bulk(@Req() request: Request) {          // §6 — no @DrfParsers, deliberately
    return this.loans.bulkUpdate(readUploadedFile(request, 'file'));
  }

  @DrfNoRequestData()                      // §5
  @All()                                   // §4
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, POST, PATCH, HEAD, OPTIONS');
  }
}
```
