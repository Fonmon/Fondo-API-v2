# Phase 5 — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5, and to `docs/phase-0-deviations.md` …
`docs/phase-4-deviations.md`.

Audience: `nestjs-reviewer` (§1–§3), `manual-tester` (§4 — everything it must read as an
**expected** diff), and whoever maintains `MIGRATION_PLAN.md` (§5 — corrections to fold back).

**Scope shipped**

| Area | Routes / units |
|---|---|
| Activity years | `GET\|POST /api/activity/year` |
| Activities of a year | `GET\|POST /api/activity/year/<id_year>` |
| Activity detail | `GET\|PATCH\|DELETE /api/activity/<id>` |
| §5 register implemented | **none at implementation time**; **D36** and **D37** were registered afterwards and neither changed a line of Phase 5 code — see §1 |

**Gate numbers**

| | before (`c4ebaa2`) | after |
|---|---|---|
| unit | 1871 / 58 suites | **1935 / 60 suites** |
| e2e | 854 + 1 skipped / 17 suites | **957 + 1 skipped / 18 suites** |

⚠️ **Those are the numbers at the Phase 5 *implementation* commit and are deliberately not
updated.** Three parity-fix commits have landed on the branch since (P5-F1, D35+D38, DELTA-F1)
and a fourth for **N1**; the branch reads **2029 unit / 62 suites** and **1031 e2e + 1 skipped
/ 18 suites** today. The row above is the delta this phase's own work produced.

`+64` unit (`activity.service.spec.ts` 53, `dto/activity.serializers.spec.ts` 11) and `+103`
e2e (`activity.e2e-spec.ts` 102, plus one new cell in `health.e2e-spec.ts`). No cell was
removed or weakened; one existing cell — `health.e2e-spec.ts`'s "ships no Phase 5-8 business
endpoints yet" — **moved** from the 404 list to a new guarded-routes cell, because
`/api/activity/year` now exists. That move is the point of the two-list design and is not a
weakening: the new cell asserts **401**, and it asserts both trailing-slash answers.

`fondodev` verified unchanged before and after the run: `activityyear 9 / activity 25 /
activityuser 338`, `loan 425 / loandetail 374 / schedulertask 626 /
notificationsubscriptions 94, max(id) 1468 / auth_user 15 / power 20`, and
`count(distinct xmin::text) = 1` on all three activity tables. **v2 wrote nothing to the
shared fixture in this phase** — the e2e suite runs against `fondo_api_test`, and
`assertDisposableDatabase` (condition C25) refuses anything else. Pre-write `pg_dump` of every
table is at `~/.fondo-parity-dumps/p5-20260904-162042-pre/` (full custom-format dump plus one
plain-SQL file per table, on **btrfs** — persistent, not tmpfs), pointer in
`~/.fondo-parity-dumps/LATEST-P5`.

---

## 1. Registered deviations from v1: **none at implementation time; two added since**

At implementation this was determined mechanically, not assumed: `MIGRATION_PLAN.md` §5's
`Phase` column contained no `P5` entry, and §3's Phase 5 section said so explicitly. Nothing
was invented, which is the point.

⚠️ **Two rows have been registered since, by other roles, and neither changed a line of Phase
5 code.** They are here so a tester reads them as *expected* rather than as findings:

| row | what it decides | code change |
|---|---|---|
| **D36** | `GET /api/activity/<id>` returning every attached member's full profile to any member is **ported and accepted** (`business-analyst`, operator **Q32**: the members' activity screen is meant to show the whole paid/unpaid list). Supersedes §3.2's open finding. | **none** — its pin is the four e2e role cells that were already green |
| **D37** | a sequence value burned by a doomed INSERT in v1 and not in v2 is **accepted, not matched**. Supersedes parity finding **P5-F2**. | **none** — v2's behaviour is unchanged; the row records the decision |

The four cross-cutting rows **D21–D24** apply here as they do everywhere, and so do **D13**,
**P3-D6** and **P3-D8** — see §4.3, which two parity rounds have now had to correct.

So **every** observable behaviour below is v1's, including the ones that look like defects:

| v1 shape | v2 |
|---|---|
| a bodiless **304** from a `POST` | ported |
| **204** on an empty year list where a modern API would send `200 []` | ported |
| **200** from `DELETE` on an id that never existed | ported |
| **404** for every conceivable `PATCH` failure — missing key, bad `state`, unknown row | ported |
| **500** for a missing `name`/`value`/`date` on create, and for an unknown `id_year` | ported |
| `state` written without checking `STATE_TYPES` | ported |
| any authenticated member reading every other member's profile through `GET /api/activity/<id>` | ported — see §3.2 |

Two v2-only *controls* were considered and **not** added, deliberately: an ownership check on
`GET /api/activity/<id>` (the analogue of D10/D25) and a "exactly one enabled year" invariant.
Both are recorded as findings in §3 rather than implemented, because neither is a parity repair.
✅ The first has since been **decided**: `D36` says port it, and the operator confirmed the
exposure is the intent of the screen. The second remains an unexamined anomaly (§3.1).

---

## 2. Discoveries — `P5-D1` … `P5-D4`

These are **v1 behaviours discovered while porting**, registered as the brief requires. None
of them changes v2; each is a candidate the operator may later decide to fix. They are
numbered so a later §5 row can cite them.

### P5-D1 — `create_year` has no transaction, and the retry is not inert

**Status: ported as written. Do not add a transaction.**

`create_year` (`services/activity.py:14-26`) disables the highest other year and then inserts
the current one, with **no** `@transaction.atomic`. Verified there is no `ATOMIC_REQUESTS` in
any settings module either, so Django is in autocommit and the two statements are two
independent commits. `create_activity`, six lines below it, **is** `@transaction.atomic` — so
the absence is a property of this method, not of the module.

Consequence: a second `POST /api/activity/year` in the same calendar year **re-disables the
highest other year** and then answers **304 Not Modified**. A request that reports "not
modified" has modified a row. Harmless when the flag is already `false`, which it normally is;
observable when it is not, which is the state production is in today
(`docs/phase-5-prework.md` §1).

Pinned by `activity.service.spec.ts` → *"still commits the disable when the insert then
collides (no transaction)"* (which also asserts `$transaction` was **not** called) and by
`activity.e2e-spec.ts` → *"a same-year retry re-disables the highest other year and still
answers 304"*, which re-enables the row by hand between the two calls so the second write is
visible.

**Why not fix it:** wrapping it would be a silent behaviour change on a once-a-year path, and
the observable difference (304 with no write vs 304 with a write) is exactly what a parity
round would flag as a v2 defect if v2 were the one that changed.

### P5-D2 — `create_activity` and `__update_activity` coerce `value` differently, and it matters on exactly one input

**Status: ported. Measured, not inferred.**

`create_activity` does `activity.value = int(data['value'])`; `__update_activity` assigns
`data['value']` raw and lets `BigIntegerField.get_prep_value` coerce it on save. Given D29's
history on exactly this shape, both were measured on the pinned stack
(`Django==2.2.27` / CPython 3.9, in the running v1 container):

| input | `int(x)` (create) | `BigIntegerField().get_prep_value(x)` (update) |
|---|---|---|
| `'30000'` | `30000` | `30000` |
| `30000.7` | `30000` | `30000` |
| `30000.0` | `30000` | `30000` |
| `True` | `1` | `1` |
| `'  30  '` | `30` | `30` |
| `'30.5'` | `ValueError` | `ValueError` |
| `'abc'` | `ValueError` | `ValueError` |
| **`None`** | **`TypeError`** | **`None`** |

`get_prep_value` *is* `int()` for every value that converts, so **the stored number is
identical on both paths** — and since `patch_activity` answers with a fresh `get_activity(id)`
rather than the mutated object, the coercion is invisible in the response body either way.

The asymmetry is entirely in the **error path**, and it has two halves:

1. **`null`.** `int(None)` raises `TypeError` on the create path → uncaught → **500**.
   `get_prep_value(None)` returns `None` on the update path, the column's `NOT NULL` raises
   `IntegrityError`, and `patch_activity`'s bare `except:` swallows it → **404**.
2. **Everything else that fails.** A `ValueError` is a **500** on create and a **404** on
   patch, for the same reason.

Pinned by parameterised cells in both suites, including the e2e cell *"a null value is a 500
on create and a 404 on patch"* which asserts the two statuses in one test.

### P5-D3 — `TextField.get_prep_value(None)` returns `None`, and `common/utils/python-obj.ts:toDjangoText` folds it to `'None'`

**Status: a Phase 3/4 defect, found here, NOT fixed here. Escalated.**

Measured in the v1 container:

```
>>> TextField().get_prep_value(None)  -> None
>>> CharField().get_prep_value(None)  -> None
>>> TextField().get_prep_value(5)     -> '5'
>>> TextField().get_prep_value(True)  -> 'True'
```

Both fields share `to_python: if isinstance(value, str) or value is None: return value`. So in
v1 a JSON `null` reaches the column as SQL `NULL`, and a `NOT NULL` column raises
`IntegrityError` — it never stores the four characters `None`.

`toDjangoText` (`src/common/utils/python-obj.ts`) returns `'None'` for `null`, and its
docblock asserted that this "is what v1 would store in a `varchar` column". That claim is
false. The docblock is corrected in this phase; **the behaviour is not**, because every call
site is Phase 3 or Phase 4 code and changing it is a cross-phase change with its own control
runs and review.

**The suspected live consequence, for whoever picks this up** (traced from source, *not*
measured against live v1 — probing it writes to `auth_user`): `create_user` passes
`obj['first_name']` straight into `UserProfile.objects.create_user`, so
`POST /api/user` with `{"first_name": null, …}` should be a **409
`Identification/email already exists`** in v1 (`IntegrityError`, caught at
`services/user.py:54`) and a **201** with `first_name = 'None'` in v2. `last_name`, `email`,
`primary_color` and `secondary_color` are the same shape. Worth one probe in the next parity
round.

Phase 5 does not use `toDjangoText`. It uses **`toDjangoTextOrNull`**, added alongside it,
which is Django's actual behaviour; `Activity.name` is `NOT NULL`, so a `null` name raises,
which is a **500** on create and a **404** on patch — both pinned.

### P5-D4 — `ActivityUser` children are deleted explicitly, because the database will not

**Status: not a deviation — this is what plan §4 rule 10 requires. Recorded because the code
looks like an addition and is not.**

`ActivityUser.activity` is `on_delete=models.CASCADE` (`models.py:87`), which is a **Django**
cascade run by `Collector.delete()` in Python. Measured on both databases:

```
fondo_api_activity     | ..._year_id_aed3b367_fk_...     | confdeltype=a | deferrable=t | deferred=t
fondo_api_activityuser | ..._activity_id_d8912768_fk_... | confdeltype=a | deferrable=t | deferred=t
fondo_api_activityuser | ..._user_id_b53bb1a7_fk_...     | confdeltype=a | deferrable=t | deferred=t
```

`confdeltype = 'a'` is `NO ACTION`, and Prisma does not cascade at all. `removeActivity`
therefore deletes the children first, in one `$transaction` (which is also what
`Collector.delete()` does — `transaction.atomic(savepoint=False)`).

⚠️ **v1's own test would not have caught this, and neither would a naive port of it.**
`test_delete_activity` seeds the activity with `Activity.objects.create(...)` and attaches no
members, so the child table is empty and the cascade is never exercised. The control run
below removes the child delete and *only* the new e2e cell fails — `test_delete_activity`
still passes.

---

## 3. Judgment calls and findings

### 3.1 The two-enabled-years anomaly is inert, and no invariant was added

`fondo_api_activityyear` holds **two** `enable = true` rows (2026 and 2020). The chain of
`create_year` calls explains every link except one — creating 2021 should have disabled 2020
and did not — so the row was either inserted outside the API or re-enabled by hand.
`docs/phase-5-prework.md` §1 has the full walk.

What matters for the port: **nothing in v1 reads `enable`.** The five references are the field
definition, the migration that adds it, a one-off 2019 backfill, `ActivityYearSerializer`
echoing it, and `create_year` writing it. No query filters on it and no branch depends on it.

So `serializeActivityYear` **echoes** the column and does not recompute it, and no "exactly
one enabled year" check exists anywhere in v2. An implementation or a fixture built on that
invariant would pass against a tidy fixture and diverge on real data — the expensive kind of
false green, because the fixture would be the thing that was wrong. Pinned by
`activity.e2e-spec.ts` → *"serves two enabled years without complaint"* and by a unit cell.

### 3.2 `GET /api/activity/<id>` exposes every attached member's full profile, and it was left alone

`ActivityDetailSerializer.get_users` nests the whole `UserProfileSerializer` — `identification`,
`email`, `birthdate`, `role` — for every member attached to the activity, and the rule is
`GET 3`, so **any authenticated member reads it**. That is the same exposure D10 (loans) and
D25 (`GET /api/user/<id>`) were introduced to close on their routes.

It is **not** closed here. Phase 5 owns no §5 rows, the plan pre-declares none for it, and
adding an unregistered ownership control would be exactly the kind of quiet divergence §5
exists to prevent. Flagged for `business-analyst`: the fund may want the same
owner-plus-`[0,1,2]` predicate here, in which case it is a new §5 row with a new operator
question, not a Phase 5 implementation detail. The e2e suite pins the **current** behaviour
(all four roles get 200), so a later decision has a cell to change.

### 3.3 `create_year` reads Bogotá — the first real use of the C28 helper

Phase 4 had no calendar read at all (`docs/phase-4-deviations.md` §2.9): its dates came from
the request body or from `todayForAutoNowDateColumn`. `create_year`'s `date.today().year` is
the first, and it is Bogotá, because `django.conf.Settings.__init__` ends with
`os.environ['TZ'] = self.TIME_ZONE; time.tzset()`.

The clock-fixed cell is at **`2026-01-01T02:00Z`** — `2025-12-31 21:00 -05:00` — where the
host (pinned to UTC in `jest.config.ts`, before the workers fork) says 2026 and Bogotá says
2025. A second cell at `2026-01-01T05:00Z` pins the other side of the boundary. The C28 cell
also asserts `new Date().getUTCFullYear() === 2026` inside the test, so a future change to the
harness zone breaks the cell rather than silently disarming it — that was false-green #17's
mechanism.

Control run: replacing `todayInBogota().year` with `new Date().getFullYear()` produces
**exactly one** failure, `expected 2025n, received 2026n`.

### 3.4 The controller order in `ActivityModule` is load-bearing, and C20 is the backstop

Django's resolver cannot confuse `/api/activity/year` with
`^api/activity/(?P<id>[0-9]+)/?$` — `year` is not `[0-9]+`. Express can: `api/activity/:id`
matches it happily. So `ActivityYearController` and `ActivityYearDetailController` are
registered **before** `ActivityDetailController`, which is the reverse of v1's `urls.py` order
and deliberate.

No `dispatch` rewrite was added (contrast the `UserAppsView` / `UserDetailView` pair): the
three patterns differ by a **literal segment**, not only by character class, so declaration
order alone separates them, and condition **C20** turns a mistake into a logged **500** rather
than a plausible 403. Control run: moving `ActivityDetailController` to the front of the array
fails **24** cells — the entire `/api/activity/year` surface — with the C20 500.

### 3.5 What was reused rather than re-implemented (condition C36)

| need | reused |
|---|---|
| `QueryDict.get` for `?patch=` | `common/http/django-query.ts` → `lastQueryValue` |
| `obj['key']`, `int()`, Django field coercion | `common/utils/python-obj.ts` → `pyGet`, `toDjangoInt`, `toDjangoSmallInt`, `toDjangoDate` |
| "today" in Bogotá | `common/utils/timezone.util.ts` → `todayInBogota`, `plainDateToUtcDate` |
| bodiless DRF responses | `common/http/drf-response.ts` → `sendDrfBody`; `ApiException.empty` |
| the 405 fallback and its `Allow` | `common/http/drf.exception.ts` → `DrfException.methodNotAllowed` |
| the parser policy | `common/http/drf-parser.interceptor.ts` → `DrfNoRequestData`, `assertRequestDataParsable` |
| the out-of-range path id | modelled on `loans/loan-path-id.ts`, with its own file and its own table |

Three things were **moved into `common/` rather than copied**, because a second copy is how
`parseMoneyColumn` was warned against splitting (`docs/adding-a-route.md` §8):

* **`formatDrfDateField`** — DRF's `DateField.to_representation`. It was a private
  `serializeDateField` in `src/users/dto/user.serializers.ts`; `ActivityDetailSerializer.date`
  renders through the same field. Now `common/utils/date.util.ts`, with the three former call
  sites re-pointed. Behaviour unchanged (the whole unit suite is green across the move).
* **`isUniqueViolation`** — `P2002`. It was a private function in `src/users/user.service.ts`;
  `create_year`'s `except IntegrityError` needs the same predicate. Now
  `common/utils/prisma-error.ts`, with the docblock naming both v1 call sites and *why* it is
  deliberately narrow (a `NOT NULL` or FK violation is `IntegrityError` in Django too, and
  widening it would turn a 500 into a 304 or a 409).
* **`toDjangoTextOrNull`** — added next to `toDjangoText` in `common/utils/python-obj.ts`, see
  P5-D3.

### 3.6 `updateMany` rather than `update` on the `ActivityUser` path

`ActivityUser.objects.get(activity_id = id, id = activity_user_id)` matches on a **pair**, and
only `id` is a Prisma unique field, so `update({ where: { id, activity_id } })` will not
compile. `updateMany` with both in the `where` is the faithful shape; `count === 0` is
`DoesNotExist` and is thrown so the caller's bare `except:` can answer 404. Control run:
dropping `activity_id` from the `where` fails the cell that patches an `ActivityUser`
belonging to a **different** activity — which would otherwise be a silent cross-activity
write.

### 3.7 `createMany` rather than v1's per-row `save()` loop

`__add_users` loops and saves one `ActivityUser` at a time. `addUsers` issues one
`createMany`. The rows are independent, the ids come from the same sequence in the same order,
and the whole thing is inside the transaction v1 wraps it in, so nothing observable
distinguishes them. Recorded because it is a *shape* difference a reviewer will see.

### 3.8 Every deviation and every hazard was control-run

Each control was applied to the working tree, the suite was run, the tree was restored, and
the restore was verified. Every one produced failures **in the cells written for it** and
nowhere else. Controls 1–11 were run before the commit; control 12 after it,
against the committed tree, with `git checkout --` as the restore and `git status` as the
proof.

| # | control | result |
|---|---|---|
| 1 | drop the explicit `ActivityUser` child delete | **1 failed** — the cascade cell. ⚠️ `test_delete_activity` still passed: v1's own test cannot see this. |
| 2 | `204` → `200 []` on the empty year list | **5 failed** — `test_get_years_empty` + four role cells |
| 3 | `304` → `200` on the duplicate year | **2 failed** — `test_create_year` and the P5-D1 retry cell |
| 4 | `ActivityDetailController` registered first | **24 failed** — the whole `/api/activity/year` surface, via C20's 500 |
| 5 | ISO `date` → `formatDateEs` | **4 failed** — three ported cells and the wire-format cell |
| 6 | drop `@DrfNoRequestData()` from `ActivityYearView.post` | **1 failed** — the C10 cell (415 where v1 sends 201) |
| 7 | drop the `is_active` filter in `__add_users` | **1 failed** — the active-users cell |
| 8 | drop `activity_id` from the `ActivityUser` lookup | **1 failed** — the cross-activity cell |
| 9 | order nested users by `id` instead of `user_id` | **1 failed** — the ordering cell |
| 10 | drop the `/?` from `^api/activity/[0-9]+/?$` in the URL conf | **1 failed** — the trailing-slash cell |
| 11 | `todayInBogota().year` → `new Date().getFullYear()` | **1 failed** (unit) — `expected 2025n, received 2026n` |
| 12 | remove the `@All()` fallback from `ActivityYearController` | **3 failed** — `OPTIONS`, `PUT` and `DELETE` 404 where v1 403s (rule 12) |

---

## 4. For `manual-tester`

### 4.1 Expected diffs against v1

⚠️ **This section said "none" for two rounds and that wording was wrong** — not because the
phase diverged, but because it read as *absolute* while **D13**, **P3-D6** and **P3-D8**
accounted for **126 of the 131** differing cells in round 1. A tester who took it literally
would have filed 126 false failures. Corrected here, and §4.3 now names them.

**On the three activity routes, this phase still introduces no intentional divergence of its
own.** What follows is the complete list of differences that are nevertheless **expected**:

| # | shape | why |
|---|---|---|
| 1 | Django's HTML 404 page vs v2's `{"message":"Not Found"}` | **D13** |
| 2 | Django's 27-byte `<h1>Server Error (500)</h1>` vs v2's zero-byte 500 | **P3-D6** |
| 3 | v1's browsable API under `Accept: text/html`/`text/*`/`?format=api`, and `JSONRenderer`'s `indent` media-type parameter | **P3-D8** |
| 4 | gunicorn writing an entity body on a `HEAD` response where Node suppresses it (`Content-Length` and status identical) | **D21** |
| 5 | `Connection: close` (v1) vs `Connection: keep-alive` + `Keep-Alive: timeout=5` (v2) on every response | **N2**, transport-level, excluded from the compared header set |
| 6 | **a sequence value that advanced on v1 and not on v2** after a refusal that wrote nothing — `fondo_api_activity_id_seq`, `auth_user_id_seq`, `fondo_api_schedulertask_id_seq` | **D37**. Status, body, bytes, headers and **every row** are identical; only `last_value` differs. **Do not re-file this** — it was P5-F2 in rounds 1 and 2 and is now a decided, accepted row. |
| 7 | `POST /api/user/activate/<id>` with `{"key": null}`: v1 **200** (and takes over the account, including a soft-deleted one and the ADMIN) or **500** when the body carries no `password` key; v2 **404** in all four sub-cases | **D38**. The 500/404 sub-case is inside the row — the register entry now says so explicitly. |

**Anything else on these routes is a parity failure.**

⚠️ **`D36` is not in that table on purpose.** It changes nothing on the wire: both stacks
return the full member roster from `GET /api/activity/<id>` to any role. It is registered so
the exposure is a decision rather than an oversight, and a **difference** there would still be
a failure.

### 4.1a ⚠️ New since round 2 — the HTTP edge changed (**N1**)

`src/common/http/gunicorn-http-edge.ts` and `gunicorn-request-line.ts` port **gunicorn 19.9's
request-line validation**, which v2 previously had no equivalent of. This is a **fix, not a
deviation**, and it is cross-cutting — it applies to every route in every phase, so a
re-measurement of N1 belongs in the next round's sweep.

| request | v1 | v2 before | v2 now |
|---|---|---|---|
| `FROB`, `BREW`, `ABC`, `A-C`, `A_C`, `A.C`, `A$C`, a 24-character token | 401 / 403 / 404 per the matrix | **400**, `Connection: close`, no body | **identical to v1** |
| **`CONNECT`** | 401 / 403 / 404 per the matrix | ⚠️ **no response at all — the socket was closed** | **identical to v1** |
| `X`, `AB`, `get`, `Get`, `FR OB` | gunicorn's own **400** HTML page, 182–184 body bytes, no `Server`, no `Date` | a bare `400 Bad Request` with one header | **byte-identical to v1** |
| a two-bit request line, `HTTP/9`, `http/1.1` | 400 `Invalid Request Line` / `Invalid HTTP Version` | bare 400 | **byte-identical to v1** |
| a parser error that is **not** an unknown method (`Ho st:`, a header block over `maxHeaderSize`) | — | Node's 400 / 431 | **unchanged**, deliberately |

Measured against the running v1 on a raw socket, 31 request lines, headers compared as a set:
**30 identical, 1 differing — and that one is D13** (`FROB /nope`, Django's HTML 404). Status
distributions equal on both stacks: `{401: 22, 404: 1, 400: 8}`.

⚠️ **Known residuals, stated rather than hidden.** (a) gunicorn's `limit_request_line` (4094)
and `limit_request_field_size` (8190) are **not** ported — pre-existing, method-independent,
and unchanged by this work. (b) An unknown-method request whose header block exceeds Node's
`maxHeaderSize` gets Node's **431** where v1 would answer its own 400. (c) Python's `\d`
matches Unicode digits and JavaScript's does not, so `HTTP/١.١` is a 400 here and a parsed
version in v1.

### 4.2 Explicitly **unchanged** — if these differ, that IS a failure

| # | behaviour |
|---|---|
| 1 | `GET /api/activity/year` on an empty table → **204**, zero-byte body, **no `Content-Type` header** |
| 2 | `POST /api/activity/year` twice in one calendar year → **201** then **304**, both zero-byte |
| 3 | …and the second call **still disables** the highest other year (P5-D1) |
| 4 | `POST /api/activity/year` disables the highest year that is **not** the current one, **exactly one row**, across a gap |
| 5 | `POST /api/activity/year` with `Content-Type: text/plain` → **201** (the handler never reads the body) |
| 6 | `GET /api/activity/year/<unknown id>` → **200 `[]`**, never 404 |
| 7 | `POST /api/activity/year/<unknown id>` → **500** (deferred FK violation at COMMIT), nothing written |
| 8 | `POST /api/activity/year/<id>` missing `name`/`value`/`date` → **500**, nothing written |
| 9 | `POST /api/activity/year/<id>` attaches one `ActivityUser` per **active** member at `state = 0` — **13 rows** on `fondodev` (15 members, 2 of them `is_active = false`; this row said 15 until the parity round measured it on both stacks) |
| 10 | `GET /api/activity/<id>` renders `date` as **ISO `YYYY-MM-DD`**, not the Spanish `7 nov. 2020` |
| 11 | `year`, `value` and the nested `identification` render as **bare JSON numbers**, not strings |
| 12 | `ActivityDetailSerializer` key order is `id, name, date, value, users`; `ActivityUserSerializer` is `id, state, user` |
| 13 | nested `users` are ordered by **`user_id`** |
| 14 | `PATCH /api/activity/<id>?patch=<anything else>` → **400**, zero-byte, **before** the body is parsed |
| 15 | every other `PATCH` failure → **404**, zero-byte. Missing key, bad `state`, unknown activity, unknown or foreign `ActivityUser`, null name, null value, invalid date. |
| 16 | `PATCH ?patch=user` writes an out-of-`choices` `state` (7, −1) without complaint |
| 17 | `DELETE /api/activity/<id>` → **200** with a zero-byte body, whether or not the id existed |
| 18 | `DELETE` removes the `ActivityUser` rows (P5-D4) |
| 19 | writes are **ADMIN + PRESIDENT only** — a TREASURER gets 403 on `POST`, `PATCH` and `DELETE` |
| 20 | `OPTIONS` on all three views → **403** for every role including ADMIN (rule 13) |
| 21 | an unimplemented method (`PUT` on any, `POST` on `/api/activity/<id>`, `DELETE` on the year views) → **403**, not 405 |
| 22 | `/api/activity/<id>/` **resolves**; `/api/activity/year/<id>/` **404s**; `/api/activity/year/` resolves |
| 23 | `Allow` is `GET, POST, HEAD, OPTIONS` on both year views and `GET, PATCH, DELETE, HEAD, OPTIONS` on the detail view — **on the 403 too** |

### 4.3 Pre-declared rows — do not re-file them here

**D21–D24** are cross-cutting and apply to this phase as to every other. In particular **D24**
(v1's swallowed errors) is the family `patch_activity`'s bare `except:` belongs to; it is not
a new finding.

⚠️ **So are D13, P3-D6 and P3-D8**, and between them they dominate the diff count on these
routes — 126 of round 1's 131 differing cells, and every non-finding diff in round 2. This
section listed only D21–D24 for two rounds; the omission is what made §4.1's absolute wording
dangerous. **D22/D23/D24 are not reachable here** (no Phase 5 handler reads `request.FILES`,
and none wraps a `request.data` read in a bare `except` at the *view* layer) — `patch_activity`
wraps it in the *service*, which is D24's family but not its literal call site.

### 4.4 ⚠️ Data safety when probing this phase

Phase 5 writes `fondo_api_activityyear`, `fondo_api_activity`, `fondo_api_activityuser`.

* Dump **every** table to a **new** timestamped directory under `~/.fondo-parity-dumps/`
  before the first write cell, and restore only via `pg_restore` from that dump.
  `~/.fondo-parity-harness/p4/dump.sh` and `restore.sh` are the working pair; change the
  `p4r-` label.
* ⚠️ **`POST /api/activity/year/<id>` writes 13 rows, not one**, and `DELETE` removes them
  again. A probe loop over the create path grows `activityuser` fast.
* ⚠️ **`POST /api/activity/year` mutates `enable` on a real row even when it answers 304**
  (P5-D1). The fixture's two enabled years — 2026 and 2020 — are *evidence*
  (`docs/phase-5-prework.md` §1); a probe that flattens them destroys the only record of the
  anomaly. Restore from the dump, and re-check both flags afterwards.
* ⚠️ **The current calendar year is already in the table** (2026), so the *first* `POST` a
  probe makes is the **304** path, not the 201 path. Testing the 201 path against `fondodev`
  means deleting the 2026 row first — do it from the dump-and-restore side, never by
  reconstructing it.
* Baseline to return to: `activityyear 9 / activity 25 / activityuser 338`, alongside
  `loan 425 / loandetail 374 / schedulertask 626 / notificationsubscriptions 94, max(id) 1468
  / auth_user 15 / power 20`, and `count(distinct xmin::text) = 1` on all three activity
  tables.

---

## 5. To fold back into `MIGRATION_PLAN.md`

### 5.1 §3's Phase 5 "Scope" bullet says "disable the previous one" — it is not the previous one

> `POST /api/activity/year` (role ≤ 1): create the **current-year** `ActivityYear` and
> **disable the previous one**.

`filter(~Q(year = year)).order_by('-year')[0]` is the highest year that is **not** the one
being created. On a contiguous table those coincide; across a gap they do not, and the live
fixture has a gap in its id sequence and an anomaly in its flags. Suggested wording: *"disable
the highest **other** year — one row"*. The implementation and both suites already follow the
source, not the summary.

### 5.2 §3's Phase 5 "Risks: low" understates one thing

The risk that actually bit is **the cascade**, not the year rollover: `DELETE` is a 500 on
every real activity without the explicit child delete, and **v1's own test cannot see it**
because `test_delete_activity` attaches no members. Rule 10 names this exact case, which is
why it was caught — worth a cross-reference from §3's Phase 5 risk line to §4 rule 10.

### 5.3 The false-green register gains no new instance, but instance #17's countermeasure earned its keep

The C28 cell here follows #17's fix (zone pinned in `jest.config.ts` / `test/global-setup.ts`,
before the workers fork) **and** asserts the host zone from inside the test, so a change to the
harness cannot silently disarm it. Worth adding as a one-line pattern to the register's
countermeasures list: *a clock-fixed cell should assert what the unfixed clock would say.*

### 5.4 P5-D3 belongs in §5 or in the Phase 3/4 runbook

`toDjangoText`'s `None` → `'None'` fold is a live Phase 3/4 divergence with a suspected 409-vs-201
consequence on `POST /api/user`. It is out of Phase 5's scope to change, but it should not
live only in this document.
