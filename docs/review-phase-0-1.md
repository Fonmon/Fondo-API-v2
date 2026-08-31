# Code review — Phase 0 (foundations) and Phase 1 (auth + roles)

**Reviewer:** `nestjs-reviewer` · **Date:** 2026-08-30 · **Gate criterion #3** for both phases.

**Under review:** `~/Projects/Fondo-API-v2`, branch `feat/phase-1-auth`, commits `b3effab`
(Phase 0) and `151314f` (Phase 1), diffed against `f1660d3`. Plan revision at time of review:
**v0.11** (`e8142a7`); commits `f4accf9` and `e8142a7` landed during the review and touched
`MIGRATION_PLAN.md` / `docs/` only — **no source changed** (`git diff --stat 151314f..HEAD --
src test prisma` is empty), so the findings below apply to HEAD unchanged.

**Parity oracle:** `~/Projects/Fondo-API` (frozen). Not modified; `git status` there is clean.

---

## 0. What I verified independently (rather than took on trust)

Claims are cheap; these were re-derived from the v1 source, the live `fondodev` database, or
from CPython. Everything in this section **passed**.

| Claim | How it was checked | Result |
|---|---|---|
| `permission-matrix.ts` is a faithful port of `fondo_api/permissions.py:list_permissions` | Parsed the TS literal and `exec`'d v1's dict in CPython; compared structurally | ✅ **Identical**, 14 views, key for key, list-vs-int form preserved |
| `v1-role-matrix.fixture.ts` (280 cells) matches v1's `has_permission` | Re-implemented v1's `try/except` in CPython and replayed all 280 rows from the fixture | ✅ **0 mismatches, 0 missing cells** |
| Django password vectors are real `Django==2.2.27` output | `hashlib.pbkdf2_hmac('sha256', pw, salt, 150000)` in CPython, all 5 vectors incl. UTF-8 and empty-password | ✅ **All 5 reproduce byte for byte** |
| `username != email` for 2 of 15 live users | `select id,username,email from auth_user where username <> email` on `fondodev` | ✅ **ids 13, 14** — exactly as documented |
| P1-D4: every live hash is `pbkdf2_sha256$150000` | `group by split_part(password,'$',1..2)` | ✅ **15/15** |
| Every `auth_user` has a `fondo_api_userprofile` sibling | left join count | ✅ **0 orphans** (so the 403-not-500 path is defensive, correctly) |
| hstore key order is `(key length, key bytes)` and is what v1 `json.dumps`es | `select subscription::text`, `select payload::text` on live rows | ✅ `keys, endpoint, expirationTime` and `type, target, message, owner_id, user_ids` — exactly what `parseHstore` preserves |
| hstore `keys` really is a Python `repr`, not JSON | live row inspection | ✅ `"{'p256dh': '…', 'auth': '…'}"` |
| 21 FKs `DEFERRABLE INITIALLY DEFERRED`; 5 `%_like` pattern-ops indexes; hstore extension; DB at `0019` | `pg_constraint`, `pg_indexes`, `django_migrations` on `fondodev` | ✅ **21/21 deferred**, 5/5 indexes, `0019_auto_20220313_1225` |
| `days360` golden values are v1's, not invented | diffed `date.util.spec.ts` against `fondo_api/tests/test_date_utils.py` | ✅ **All 24 assertions copied verbatim**, both NASD and European |
| The Babel double-rounding and four-digit-grouping claims | Re-derived Babel 2.9.1's `NumberPattern.apply` → `_quantize_value` → `_format_int` by hand; `_format_int` groups from `gsize=3` with no `minimumGroupingDigits` guard | ✅ Confirmed: Babel 2.9.1 renders `1000` as `1.000`; the composition really does round twice |
| Only 3 v1 views clear `permission_classes` | `grep permission_classes fondo_api/views/*.py` | ✅ `AlexaView`, `AuthView` (both out of scope), `UserActivateView` — plus DRF's own `ObtainAuthToken` |

**I could not execute the test suites.** Node is not installed in this review environment
(`mise` has no node runtime), so the reported *755 unit / 333 e2e green* is taken on trust.
Everything above was verified by other means.

**Overall judgement before the findings:** this is unusually careful work. The doc comments
cite v1 file:line, the golden values are provably captured rather than invented, the
default-deny is structural rather than conventional, and the two `username`/Babel corrections
show the process is actually catching things. The findings below are real, but none of them
undermine that.

---

## 1. Blocking

**None.** Neither phase has a defect that must be fixed before the gate closes.

---

## 2. Should fix

### S1 — `formatDateEs()` silently reads a `DateTime` in UTC, which will corrupt Phase 2/4 email HTML

**Location:** `src/common/i18n/spanish-format.ts:61-68`, via `src/common/utils/date.util.ts:34-43`.

`formatDateEs(value: DateLike)` accepts a JS `Date` and resolves it through `toPlainDate()`,
which reads **UTC** parts. That is correct for a Prisma `@db.Date` column (Prisma pins those to
UTC midnight) and correct for v1's `format_date(obj.last_modified)` — but it is **wrong for a
`timestamptz`**, and the type system does not distinguish them.

v1 is not uniform here, which is exactly the trap:

```python
# fondo_api/serializers.py:88-90  — LoanSerializer.get_created_at
created_at = timezone.localtime(obj.created_at)      # -> America/Bogota
return format_date(created_at, locale=settings.LANGUAGE_LOCALE)

# fondo_api/serializers.py:29-30  — UserFinanceSerializer.get_last_modified
return format_date(obj.last_modified, ...)           # DateField: no conversion at all
```

A Phase 4 developer writing `formatDateEs(loan.created_at)` gets the **UTC** calendar date. For
any loan created between 19:00 and 23:59 Bogota — roughly 21% of the day — that is the *next*
day, and the resulting email HTML fails Phase 2's and Phase 4's byte-identical criteria. It will
pass in CI (fixtures at midday) and fail in production.

**Why it matters:** this is the single highest-leverage foundation footgun I found. It cannot be
caught by the current tests because every fixture uses `Date.UTC(y, m, d)`.

**Fix:** narrow the signature so the ambiguity cannot be expressed.

1. Change `formatDateEs(value: PlainDate)` — accept only a plain calendar date.
2. Add `formatDateEs(fromDateColumn(prismaDate))` where `fromDateColumn(d: Date): PlainDate`
   reads UTC parts (the current `toPlainDate` body), and require Phase 2/4 to call
   `formatDateEs(toBogotaDate(instant))` for a `timestamptz`.
3. Add a test with an instant at `2018-03-28T23:30:00-05:00` asserting `'28 mar. 2018'` via the
   Bogota path and `'29 mar. 2018'` via the raw-UTC path, so the difference is visible in the
   suite rather than in a member's inbox.

### S2 — No BigInt JSON strategy, and every money column is `BigInt`

**Location:** `src/main.ts:30-45` (no interceptor or serializer registered);
`prisma/schema.prisma:217-229` (`UserFinance.*` are all `BigInt`), `:239-261` (`Loan.value`,
`disbursement_value`), `:269-281` (`LoanDetail.*`), `:179` (`UserProfile.identification`).

`JSON.stringify(1n)` throws `TypeError: Do not know how to serialize a BigInt`. Phase 0/1 never
serialize one — `AuthTokenResponse` is `{ token: string }` and `/health` returns strings — so
nothing is broken today. But **the very first Phase 3 response** (`GET /api/user/<id>`, whose
`finance` block is six BigInt columns) will 500, and the first fix a developer reaches for under
time pressure is `BigInt.prototype.toJSON = function(){ return this.toString() }`, which renders
`"1000"` where DRF renders `1000` and silently breaks every client and every parity assertion.

v1 renders `BigIntegerField` through DRF's `IntegerField` as a **JSON number**.

**Fix (Phase 0 owns this, not Phase 3):**
- Add `src/common/http/json-bigint.ts` exporting a documented decision: BigInt serialises as a
  JSON **number**, matching DRF, with an explicit guard that throws on
  `Number.isSafeInteger === false` rather than losing precision silently.
- Register it as a global interceptor (or a custom `app.useGlobalInterceptors` transform), and
  unit-test: a plain bigint, a bigint nested in a `{list, num_pages, count}` envelope, and a
  bigint above `2^53` throwing.
- Record the "number, not string" choice in `docs/phase-0-deviations.md` §2 so it cannot be
  re-litigated in Phase 3.

### S3 — Real Phase 1 parity divergence: request media-type handling on `POST /api-token-auth`

**Location:** `src/auth/auth.controller.ts:26` (`@Body() body: unknown`),
`src/auth/dto/auth-token.serializer.ts:32-36`; v1 side is DRF
`rest_framework/request.py:Request._parse` + `negotiate_parser`.

`ObtainAuthToken` inherits `DEFAULT_PARSER_CLASSES` = JSON + Form + MultiPart. Three cases where
v2 answers differently:

| Request | v1 (DRF 3.11.2) | v2 (Nest 12 / Express) |
|---|---|---|
| `Content-Type: text/plain` with a body | **415** `{"detail":"Unsupported media type \"text/plain\" in request."}` (`negotiate_parser` → `UnsupportedMediaType`) | Express's `bodyParser.json()` does not parse it, `req.body` is `{}` → **400** `{"username":["This field is required."],"password":["This field is required."]}` |
| `Content-Type: multipart/form-data` with valid credentials | **200** + token (`MultiPartParser`) | No multipart middleware is registered → `req.body` is `{}` → **400** |
| Malformed JSON body | **400** `{"detail":"JSON parse error - Expecting value: line 1 column 1 (char 0)"}` (`JSONParser` → `ParseError`) | body-parser raises before Nest's handler; the rendered body is **unverified** and almost certainly not DRF's |

Plan §7 criterion 5 is explicit: *"an unregistered behavioral diff is a parity failure."* These
three are unregistered, and `docs/phase-1-drf-auth-bodies.md` — which is otherwise exhaustive —
does not cover media types at all.

**Why it matters:** low real-world risk on the login route (the Angular front end sends JSON),
but the same gap is structural. Phase 3's `PATCH /api/user` and Phase 4's `PATCH /api/loan` are
**multipart TSV endpoints** with `@parser_classes((MultiPartParser,))`, so the multipart row
becomes load-bearing two phases from now, and the 415 row applies to every write endpoint in
Phases 3–8.

**Fix:**
- Add the three rows to `docs/phase-1-drf-auth-bodies.md` (derived, as the rest of that document
  was).
- Either register them as deviations `P1-D5/D6/D7`, or implement a small `DrfContentNegotiation`
  guard/middleware that mirrors `negotiate_parser`: reject an unsupported media type with
  `DrfException` 415, and map a body-parser `SyntaxError` to DRF's `JSON parse error - …` 400.
  The second is preferable — it is ~30 lines and it retires the problem for all of Phases 3–8
  rather than deferring it eight times.
- Add e2e cases to `test/auth.e2e-spec.ts` alongside the existing `.type('form')` case at :92.

### S4 — `FieldAllowlist` is documented as positive but `userPatchAllowlist` builds it from the caller's own input

**Location:** `src/auth/policies/user-patch.policy.ts:97-120`, esp. `:109` and `:118-119`;
contract stated at `src/auth/policies/field-allowlist.ts:8-15`.

`field-allowlist.ts:11-14` promises *"The allowlist is deliberately **positive**: a field nobody
thought about is rejected."* But `userPatchAllowlist` returns
`FieldAllowlist.from(attempt.fields)` — the set of fields the caller is submitting. The allowlist
is therefore a tautology for every permitted case: the only things it can actually reject are
`role` (`:118`) and whole sections (`:110`, `:115`). A field nobody thought about is **accepted**.

Concretely, under D1 as decided, a MEMBER patching their own `personal` section passes the policy
with `fields = ['is_active']`, `['key_activation']`, `['user_ptr_id']` or anything else. Nothing
in `src/auth/policies/` stops it; the only defence is a Phase 3 DTO that does not exist yet.

The v1 field sets are closed and knowable **today**:

```python
# services/user.py:223-241  __update_user_personal
first_name, last_name, email, identification, role, (birthdate optional)
# services/user.py:208-221  __update_user_preferences
notifications, primary_color, secondary_color
# services/user.py:243-261  __update_user_finance
contributions, balance_contributions, total_quota, utilized_quota
```

**Fix:** export three frozen sets from `user-patch.policy.ts` (`PERSONAL_FIELDS`,
`PREFERENCES_FIELDS`, `FINANCE_FIELDS`, transcribed from `services/user.py:208-261` above) and intersect the
section's set with the role's rights, so `FieldAllowlist` is genuinely positive. Note `username`
is deliberately absent from `PERSONAL_FIELDS` — that is D15.

### S5 — `assertUserPatchAllowed` lets an empty field set through, contradicting D1's "403, not a silent no-op"

**Location:** `src/auth/policies/user-patch.policy.ts:82-85`, with
`src/auth/policies/field-allowlist.ts:53-57`.

`FieldAllowlist.none().assert([])` does not throw: `rejected([])` is `[]`. So a MEMBER submitting
a `finance` section that happens to contain **no changed fields** passes the policy.

This is not hypothetical. Plan v0.11 §5 now decides that the field set is computed by
`changedFields(submitted, stored)`, and v1's client posts `personal` **and** `finance` in every
body (`docs/ba-phase-3-decisions.md`, plan §5 clarification 2). A member re-saving their profile
without touching finance yields `fields = []` for the finance section — so under the decided
reading the empty set is the **common** case, not the edge case.

Plan §5, D1 bullet: *"A `finance` write by a non-privileged caller is **403**, not a silent
no-op."* The primitive as shipped delivers the silent no-op.

**Fix:** make `assertUserPatchAllowed` compose the two levels explicitly —
`assertSectionWritable(actor, targetUserId, section)` first (which is empty-set-independent,
`:157-165`), then `allowlist.assert(fields)`. Add a test:
`assertUserPatchAllowed({ role: MEMBER, section: 'finance', fields: [] })` throws 403.

> Note for Phase 3: this interacts with the D1 clarification. If a member's ordinary save posts an
> unchanged `finance` section, the *correct* v2 behaviour is probably to authorise off
> `body.type` alone (plan §5 clarification 2) and never reach the finance policy at all. Say
> which of the two mechanisms is authoritative in the Phase 3 deviation note — do not let both
> run and hope they agree.

### S6 — Plan §4.5 says `auto_now` is "America/Bogota semantics"; for `DateField` that is not what Django does

**Location:** `MIGRATION_PLAN.md:598` and `:173-175`; also asserted in
`src/prisma/prisma.service.ts:14-16` and `prisma/schema.prisma:15-17`.

Django 2.2 `django/db/models/fields/__init__.py`:

```python
class DateTimeField(DateField):
    def pre_save(self, model_instance, add):
        if self.auto_now or (self.auto_now_add and add):
            value = timezone.now()        # tz-aware UTC  -> settings.TIME_ZONE respected

class DateField(DateTimeCheckMixin, Field):
    def pre_save(self, model_instance, add):
        if self.auto_now or (self.auto_now_add and add):
            value = datetime.date.today()  # PROCESS-LOCAL date, ignores settings.TIME_ZONE
```

The affected v1 columns are `UserFinance.last_modified` (`models.py:32`,
`DateField(auto_now=True)`) and `LoanDetail.from_date` (`models.py:71`,
`DateField(default=date.today)`). Both take the **container's** local date, not Bogota's. v1's
repo contains no Dockerfile and `scripts/run-server.sh` sets no `TZ`, so the deployed value is
whatever the base image uses — almost certainly **UTC**.

If that is right, then between 19:00 and 23:59 Bogota v1 stamps *tomorrow's* date on
`last_modified`, and a v2 that faithfully implements plan §4.5 will disagree with v1 on those
rows. `UserFinance.last_modified` is rendered into the user response
(`serializers.py:29-30`), so this is user-visible in Phase 3.

**Fix:**
1. Confirm the deployed container's `TZ` (ECS task definition / base image) — this is a
   five-minute check with a large blast radius.
2. Correct plan §4.5 to distinguish the two cases: `DateTimeField` → instant, timezone-agnostic;
   `DateField` → **process-local calendar date**, which must be pinned explicitly in v2 rather
   than inherited from the host.
3. Give `src/common/utils/timezone.util.ts` a named helper for each — e.g.
   `nowInstant()` and `todayForAutoNowDateField()` — with the chosen zone in one place and a
   comment naming the Django line above. Today the file (`:1-19`) documents only the
   `timezone.localtime` half.

### S7 — Detail-route trailing slashes: Express is permissive where v1's regexes are not

**Location:** `src/auth/auth.controller.ts:11-13` (the claim), and the v1 ground truth at
`fondo_api/urls.py:18-38`.

The controller comment says *"The trailing slash is optional in v1's regex; Express's default
non-strict routing gives `/api-token-auth/` the same treatment."* True for that route — and for
every **collection** route, which v1 writes as `/?$`. It is **not** true of the detail routes,
which v1 writes with no optional slash at all:

```python
url( r'^api/loan/(?P<id>[0-9]+)$',              LoanDetailView.as_view() )     # no /?
url( r'^api/user/(?P<id>-?[0-9]+)$',            UserDetailView.as_view() )     # no /?
url( r'^api/file/(?P<id>[0-9]+)$',              FileDetailView.as_view() )     # no /?
url( r'^api/activity/year/(?P<id_year>[0-9]+)$', ActivityYearDetailView.as_view() )
url( r'^api/loan/(?P<id>[0-9]+)/(?P<app>[a-zA-Z]+)$', LoanAppsView.as_view() )
```

So `GET /api/loan/5/` is a Django **404** (an HTML one — D13), while Express's default
non-strict routing will match it and serve the loan.

**Why it matters:** it is a silent widening of the URL surface across Phases 3–8, and it is
exactly the class of thing `manual-tester` will file as a diff five phases from now. Right now it
is one decision in one place.

**Fix:** either enable strict routing selectively and add the `/?` forms where v1 has them, or —
simpler and better documented — register it as a cross-cutting accepted deviation in
`MIGRATION_PLAN.md` §4 with the list above, so it is expected rather than discovered. Also
correct the `auth.controller.ts:11-13` comment, which currently generalises from one route.

---

## 3. Consider

### C1 — Body-parser limits are unset; Django's are 2.5 MB
`src/main.ts:34` uses `NestFactory.create(AppModule)` with default body parsing. Express's
`bodyParser.json`/`urlencoded` default to **100 kb**; Django's `DATA_UPLOAD_MAX_MEMORY_SIZE`
defaults to **2.5 MB** and `FILE_UPLOAD_MAX_MEMORY_SIZE` to 2.5 MB with spill-to-disk. Phase 4's
monthly TSV is the endpoint that will find this. Pin both limits explicitly in Phase 0's bootstrap
with a comment naming the Django settings they mirror, rather than discovering it during a bulk
upload rehearsal.

### C2 — Enable `noUncheckedIndexedAccess` now, not at Phase 8
`tsconfig.json` has `strict: true` and eight extra flags, but not `noUncheckedIndexedAccess`.
Several places already hand-defend against it (`spanish-format.ts:64`,
`permission-matrix.ts:130-138`, `hstore.codec.ts:96-99`), i.e. the discipline is there and the
compiler is not enforcing it. Turning it on across ~2.6 k lines of source is a contained change
today; across eight domain modules it will not happen. Same reasoning for
`exactOptionalPropertyTypes` (currently `false`), which matters for the many optional-field DTOs
Phase 3 is about to introduce.

### C3 — `src/auth/index.ts` re-exports `auth.module`, inviting circular imports
`src/auth/index.ts:1` exports `./auth.module` alongside pure helpers and types. When Phase 3's
`UsersModule` imports `{ CurrentUser, assertOwnership }` from `../auth`, it transitively pulls in
`AuthModule`; the first time `AuthModule` needs anything from a domain module, Nest's
`forwardRef` dance starts. Restrict the barrel to types, decorators, policies and the permission
matrix; import `AuthModule` by its own path.

### C4 — The §2 hstore rule has a test-side exemption that is not written down
Plan §2 says raw SQL touching hstore appears **only** inside the two repositories, and §7
criterion 3 makes me the enforcer. **Production source is clean** — the only `$queryRaw` in
`src/` is `prisma.service.ts:49` (`SELECT 1`). But `test/schema-round-trip.e2e-spec.ts:364-427`
issues six raw hstore statements. That is legitimate and, in Phase 0, necessary. It should be
stated as an explicit exemption in plan §2 ("test fixtures that provision hstore rows are exempt;
no `src/` file outside the two repositories may"), otherwise a future reviewer either flags a
correct test or lets a real leak through by analogy.

### C5 — `parseHstore` preserves insertion order, but JS objects reorder integer-like keys
`src/common/utils/hstore.codec.ts:71-153`. Key order is declared load-bearing for the SQS wire
format (`:36-38`), and the implementation is right for every key that exists today (`keys`,
`endpoint`, `expirationTime`, `type`, `target`, `message`, `owner_id`, `user_ids`). But V8 hoists
integer-index keys to the front of a plain object regardless of insertion order, so a future
hstore key like `"0"` would silently reorder and break Phase 2's byte-identical criterion in a way
that is very hard to diagnose. Either return a `Map` and serialise from it, or add a test that
asserts an integer-like key round-trips in position — the second is cheaper and documents the
hazard.

### C6 — `numPages`/`pageOffset` validate `count` and `perPage` but not `page`
`src/common/http/pagination.ts:43-61`. `pageOffset(0, 10)` returns `-10`, which becomes a
negative SQL `OFFSET`. v1 is safe only because every view guards first —
`views/loan.py:29-30`, `views/user.py:29-32` and `views/saving_account.py:28-29` all return a
400 for `page <= 0` — but with **two different strings**: loans and saving accounts say
`'Page number must be greater or equal than 0'` (`loan.py:30`, `saving_account.py:29`) while
users says `'Page number must be greater than 0'` (`user.py:31`). Since the helper is the shared
piece and the guard is not, give `pageOffset` the same `RangeError` treatment `numPages` already
has, and have Phases 3/4/6 emit their own — different — v1 string rather than a shared one. (Also worth recording for those phases: `int(query_params['page'])`
on a non-numeric value is an **uncaught `ValueError` → 500** in v1.)

### C7 — `getOrCreateToken`'s race path is unreachable in the tests
`src/auth/auth.service.ts:134-146` catches `P2002` and re-gets, mirroring Django's
`get_or_create`. Nothing exercises it — `auth.service.spec.ts` has no case for it. It is the only
branch in Phase 1 that only runs under concurrency, which makes it exactly the branch worth a unit
test with a mocked `create` that rejects with a `PrismaClientKnownRequestError`. Also note the
fall-through at `:145`: if `create` fails `P2002` on the **`key`** primary key (a 20-byte
collision) rather than on `user_id`, the re-get returns `null` and the original error is rethrown.
That is defensible, but it is worth one line of comment saying so, because the code reads as if
`P2002` always means the `user_id` race.

### C8 — e2e suites register `ApiExceptionFilter` twice, so they do not prove the production wiring
`test/auth.e2e-spec.ts:43` and `test/role-matrix.e2e-spec.ts:56` both call
`app.useGlobalFilters(new ApiExceptionFilter())`, while `AppModule` already provides it via
`APP_FILTER` (`src/app.module.ts:32-35`). Harmless, but it means a regression that removed the
`APP_FILTER` registration would still pass e2e. Drop the explicit call from `auth.e2e-spec.ts`
(which imports the real `AppModule`); keep it in `role-matrix.e2e-spec.ts`, which builds a partial
module without `AppModule`.

### C9 — `.env` carries `TZ_NAME`, but the schema reads `TIME_ZONE`
`.env:10` sets `TZ_NAME=America/Bogota`; `src/config/env.schema.ts:66` declares `TIME_ZONE`. The
value is picked up only because the schema defaults to the same string. Rename the `.env` key so
a reader is not misled into thinking it is wired, and add a `.env.example` — Phase 0's deviation
P0-D1 makes a missing variable a hard boot failure, so the list of required variables should be
discoverable without reading Zod.

### C10 — Two small `check_password` divergences, for the record
`src/auth/password/django-password.service.ts:71-83`.
(a) Django compares the **whole encoded string** (`constant_time_compare(encoded, encoded_2)`
after `encoded.split('$', 3)`), so a stored `pbkdf2_sha256$0150000$…` fails in Django but
**succeeds** in v2, since `Number('0150000') === 150000` and only the digest is compared.
(b) `check_password(pw, None)` raises `TypeError` in Django (via `identify_hasher(None)`) where v2
returns `false`. Neither can occur — `auth_user.password` is `NOT NULL` and all 15 rows are
canonically formatted — so this is a note, not a request. If you want the belt: compare the
re-encoded prefix, not just the digest.

### C11 — `pythonRepr` gaps that will not matter until they do
`src/common/utils/hstore.codec.ts:192-222`. Two small departures from CPython:
non-printable **non-ASCII** characters (CPython emits `\xNN` / `\uNNNN` for anything failing
`str.isprintable()`; v2 escapes only `< 0x20` and `0x7f`), and float `repr` (JS `String(1e-7)` is
`'1e-7'`, CPython is `'1e-07'`). No live row contains either — push-subscription keys are
base64url and v1 never stores a float in hstore — so this is a documentation matter: add a line to
the module doc saying the emulation is scoped to ASCII-printable strings, ints, bools, `None`,
lists and dicts, and will need extending if Phase 2 or 7 ever writes anything else.

### C12 — `Reflector.getAllAndOverride<string>` is typed as non-optional but returns `undefined`
`src/auth/guards/roles.guard.ts:49-52` and `:65-68`. Both call sites are handled correctly
(`isPublic === true`, and `isRoleAllowed(viewName: string | undefined, …)`), so this is cosmetic —
but declaring `getAllAndOverride<string | undefined>` makes the default-deny contract visible in
the types rather than only in the prose at `:30-37`. Worth doing precisely *because* this is the
one guard whose failure mode is silent over-permission.

---

## 4. Answers to the specific questions asked

### 4.1 Are the D1 primitives shaped so Phase 3 can express the §5 table without redesigning the guard?

**Yes, with the two corrections in S4 and S5.** The decomposition is right:

- `RolesGuard` stays a pure port of `list_permissions` — D1 is enforced *inside* the route, so the
  280-cell parity criterion still holds unchanged. That is the correct seam, and
  `user-patch.policy.ts:50-55` says so explicitly.
- Ownership (`isSelf`, `assertOwnership`), the `-1` sentinel (`resolveUserId`, with the
  substitution as a required argument so neither reading is inherited by accident — now decided
  as D14), and the field/section split are three independent axes, which is how the §5 table
  actually decomposes.
- `assertOwnership(actor, targetUserId, alsoAllowRoles)` at `ownership.ts:57-70` generalises
  cleanly to D10 (loan owner + `[0,1,2]`) and D2 (power requestee) without change.
- The denial body is DRF's generic 403 everywhere (`field-allowlist.ts:55`,
  `ownership.ts:69`, `user-patch.policy.ts:163`), so an ownership failure is indistinguishable
  from a role failure. Correct — the alternative is a user-id oracle.

Two shape notes for Phase 3, neither a redesign:

- **`canWriteSection` and `userPatchAllowlist` duplicate the role logic** (`:106-119` vs
  `:150-153`). They agree today. Make one call the other, or they will drift the first time
  someone edits one.
- **`changedFields` uses `Object.is` on raw values** (`:129-134`). A `personal` payload sends
  `birthdate` as `'1990-05-03'` while the stored row is a `Date`, and `identification` as a number
  while the stored value is a `bigint`. Under the now-decided `changedFields` reading, `Object.is`
  will report *every* such field as changed. Phase 3 must normalise before comparing —
  and for `role` specifically (number vs number) it happens to work, which is exactly why the bug
  would go unnoticed. Add a test with a `bigint`/`number` pair and a `Date`/ISO-string pair.

### 4.2 NestJS / TypeScript quality — will this still be coherent at Phase 8?

Largely yes.

**Good, and worth keeping:** global guards registered as `APP_GUARD` inside `AuthModule` so
default-deny is structural rather than per-controller (`auth.module.ts:36-37`); `@V1View` typed as
a literal union so a typo is a compile error and, failing that, an import-time throw
(`v1-view.decorator.ts:20-27`); the single `prisma-client.ts` re-export so exactly one file knows
where `prisma generate` writes (`prisma/prisma-client.ts:1-9`); a config service with
non-optional typed accessors rather than raw `ConfigService`; no ORM access in the controller
(`auth.controller.ts` touches only `AuthService`); constructor DI throughout; zero `any`.

**Will need attention as domain modules land:** C3 (barrel/circularity), C1 (body limits), S2
(BigInt), and one structural item — **`ApiException` vs `DrfException` is the right split but is
currently only enforced by prose.** `phase-1-deviations.md` §2.7 explains it well; by Phase 4
there will be three developers choosing between them. Add a short table to
`src/common/http/README` or the `api.exception.ts` header: *view-level error → `ApiException`;
framework-level (auth, permission, method, parser, serializer) → `DrfException`*, with the v1
call-site pattern for each.

Also: `DrfException.methodNotAllowed` needs the `@All()` fallback repeated per controller
(plan §4.12). Six controllers × a hand-written `Allow` string is six chances to list the wrong
handlers. Consider a `@DrfMethodFallback('GET, POST, PATCH, HEAD, OPTIONS')` class decorator that
generates it, so the header is declared once next to the route table.

### 4.3 Test coverage — which *business scenarios* are untested?

Coverage of what Phases 0 and 1 actually ship is genuinely strong: the 280-cell matrix is
replayed over real HTTP with real tokens (`role-matrix.e2e-spec.ts:90-108`), the deny-on-miss
fallthrough is proven with a controller that has no `@V1View` (`:111-137`), unauthenticated and
profile-less users are covered (`:139-174`), and every table round-trips including both hstore
columns and the 21 deferred FKs (`schema-round-trip.e2e-spec.ts`).

Missing scenarios, in the order I would add them:

1. **Media types (S3).** `text/plain`, `multipart/form-data`, malformed JSON. This is the only
   *behavioural* gap in Phase 1's own route.
2. **`Authorization` with an empty value.** `docs/phase-1-drf-auth-bodies.md` lists it (401
   `Authentication credentials were not provided.`) and `extractTokenKey` handles it
   (`token-auth.guard.ts:84-87`), but no test sends `Authorization: ` over the wire.
3. **A numeric `username` that matches a real login.** The bodies doc says this is a **200**
   (`CharField` coerces with `str()`); the serializer unit test covers the coercion
   (`auth-token.serializer.spec.ts:50-55`) but nothing asserts the 200 end to end. It is the one
   row in that table where the *status* is surprising.
4. **The `Date`/`DateTime` distinction in `formatDateEs` (S1).** Every fixture is
   `Date.UTC(y, m, d)`; nothing pins what happens to a real instant.
5. **BigInt in a response envelope (S2).**
6. **`getOrCreateToken`'s P2002 branch (C7).**
7. **`assertUserPatchAllowed` with an empty field set (S5)** and **with an unknown field
   name (S4)**.
8. **`changedFields` across type boundaries (§4.1)** — `bigint` vs `number`, `Date` vs ISO string.

**Cross-checked against `CONTEXT.md`'s business-logic section and `docs/ba-review-v0.2.md`, for
the phases with zero inherited v1 tests.** Three foundation primitives that Phases 6/7 and the
admin endpoint depend on are shipped but not exercised by anything resembling their real use:

- **`bogotaWallClockToInstant` (`timezone.util.ts:99-110`) is Phase 7's cron and
  `schedule_notification` primitive**, and its one-correction-pass approach is only sound because
  Bogota has had a fixed −05:00 offset since 1993 (the comment says so). `timezone.util.spec.ts`
  is 81 lines. Before Phase 7 relies on it for 10:00/14:00 cron anchoring and for
  `make_aware`-equivalent `run_date` construction, add cases at a DST-ish boundary in a *different*
  zone to prove the algorithm rather than the constant.
- **`decodeSchedulerPayload` (`hstore.codec.ts:351-364`) is Phase 7's only read path**, and it is
  tested against synthetic and one real payload shape. The live table has **632 rows**. Add a
  fixture file sampled from those rows (the plan already warns at
  `docs/phase-0-deviations.md` §3.11 that a DB reload could drop them) and assert the whole set
  decodes — that is the cheapest possible insurance for the subsystem the plan itself calls
  *"the highest ratio of consequence to coverage in the migration."*
- **`relativedelta` repeat-clone arithmetic has no Phase 0 primitive at all.** Plan Phase 7 says
  *"month-end arithmetic differs between libraries, pin it with tests"*, and the `repeat` clone
  (NONE/DAILY/WEEKLY/MONTHLY/YEARLY) plus the birthday **yearly** task from Phase 3 both need it.
  Phase 0 shipped `days360` and calendar helpers but nothing for `+1 month from Jan 31`. This is a
  Phase-0-shaped utility (pure, testable, no I/O) that is currently scheduled to be invented
  inside Phase 7, which is the phase least able to absorb it. **Recommend adding it to Phase 0's
  scope retroactively, or explicitly to Phase 3's** (the birthday task needs it first).

### 4.4 Things the plan itself gets wrong

- **P1 — §9 "Still open" now contradicts itself.** `MIGRATION_PLAN.md:856-864`: the table lists
  **Q26 and Q27** as open, and the sentence immediately below still reads *"All 25 operator
  questions are answered. The only open inference is the TREASURER self-service cell."* Delete or
  update the sentence; the gate criterion 5 depends on that section being readable.
- **P2 — §4.5 is wrong for `DateField(auto_now=True)`.** See **S6**. `MIGRATION_PLAN.md:598`.
- **P3 — §4 is missing the trailing-slash rule.** See **S7**. It belongs next to §4.12
  (404-vs-405), which is the same class of Express-vs-Django routing difference.
- **P4 — §4 is missing a request-parsing rule.** See **S3**. §4.1 covers response envelopes;
  nothing covers **request** media-type negotiation, and Phases 3 and 4 both ship multipart
  endpoints.
- **P5 — Phase 7's scope should acquire the `relativedelta` port explicitly, or Phase 0/3
  should.** See §4.3. Today it is a one-line risk bullet in Phase 7 (`:499-500`) rather than a
  deliverable, and it is needed in Phase 3 first (the birthday `repeat=4` task,
  `services/user.py:__create_birthdate_notification`).
- **P6 — §2's hstore rule needs its test exemption written down.** See **C4**.
- **P7 — Phase 0's scope should name the BigInt serialisation decision.** See **S2**. §4.4 says
  *"Money is integer whole units. No floats on a money path"* — correct, and it is exactly why
  every money column is Prisma `BigInt`, which is exactly why the serialisation choice is a
  cross-cutting parity rule and not a Phase 3 detail.

Two places where the plan is **right and the implementation confirms it**, worth recording so
they are not re-litigated: the Prisma decision looks better after Phase 0 than it did on paper
(the driver-adapter requirement in Prisma 7 hands the two hstore repositories a first-class `pg`
path), and the 280-cell criterion was the correct widening — 168 of the 280 cells exercise the
method-miss default-deny fallthrough, and testing only the declared methods would have exercised none of it.

---

## 5. Gate verdicts

### Phase 0 — Foundations, Prisma baseline, cross-cutting utilities

> **APPROVED WITH CONDITIONS**

The gate criterion is *"every table round-trips; utility unit tests green and matching v1's
values."* Both hold: 23 tables plus every hstore column round-trip
(`test/schema-round-trip.e2e-spec.ts:442-471`), the `days360` values are v1's verbatim, the
password and Babel golden values are provably captured rather than invented, and the baseline's
three hand-patches match the live database exactly (21/21 deferred FKs, 5/5 pattern-ops indexes,
hstore extension). No production `$queryRaw` touches hstore.

**Conditions, to be closed before Phase 2's gate:**

1. **S1** — narrow `formatDateEs` so a `timestamptz` cannot be formatted as a UTC calendar date.
   *Phase 2 asserts email HTML byte-for-byte; this must land first.*
2. **S2** — ship and test the BigInt→JSON decision as a Phase 0 primitive.
3. **S6** — resolve the `DateField(auto_now=True)` timezone question and correct plan §4.5.
4. **C4** — write the hstore test exemption into plan §2.

C1, C2, C5, C6, C9 and C11 are recommendations, not conditions.

### Phase 1 — Authentication and role permissions

> **APPROVED WITH CONDITIONS**

Every parity criterion is met and independently re-verified: the 280-cell matrix is exact against
v1's `permissions.py`; default-deny is structural (an unregistered controller is *unreachable*,
not open, and a bad `@V1View` name throws at import); token get-or-create never rotates;
`last_login` is untouched; login resolves `auth_user.username` — the correction that would
otherwise have locked out two live members, verified again here against `fondodev`; the
`pbkdf2_sha256` implementation reproduces `Django==2.2.27` byte for byte on all five vectors
including UTF-8 and the empty password; and the DRF error envelopes match
`docs/phase-1-drf-auth-bodies.md`, which is itself derived rather than remembered. The
authentication-before-permission ordering — including a bad token 401ing on a `@Public()` route —
is reproduced and tested.

**Conditions, to be closed before Phase 3's gate:**

1. **S3** — resolve the request media-type divergence (415 / multipart / malformed JSON): either
   implement DRF's negotiation or register all three as deviations, and add e2e cases.
   *Phases 3 and 4 both ship multipart endpoints, so the multipart row becomes load-bearing.*
2. **S4** — make `userPatchAllowlist` a genuinely positive allowlist with explicit per-section
   field sets transcribed from `services/user.py:208-261`.
3. **S5** — make `assertUserPatchAllowed` reject a non-privileged `finance` write with an **empty**
   field set, and state in the Phase 3 deviation note whether `body.type` or the field-level
   policy is authoritative.
4. **S7** — decide and register the trailing-slash behaviour for detail routes.

C3, C7, C8, C10 and C12, and the test additions in §4.3, are recommendations.

---

### Escalations to `business-analyst`

1. **`UserFinance.last_modified` / `LoanDetail.from_date` (S6).** If v1's container runs UTC, the
   fund's records already carry next-day dates for anything saved after 19:00 Bogota. Does v2
   reproduce that, or correct it? Correcting it is a (small, registrable) behaviour change to a
   user-visible field.
2. **Empty-`finance`-section saves (S5).** Under the decided `changedFields` reading, an ordinary
   member profile save posts an unchanged `finance` section. Is that a 403 (the literal reading of
   D1's last bullet) or a no-op (authorise off `body.type` alone)? These give different answers to
   the same request and the choice needs to be recorded, not inferred.

---
---

# Round 2 — re-review of the condition fixes

**Reviewer:** `nestjs-reviewer` · **Date:** 2026-08-31 · **Gate criterion #3, final pass.**

**Under review:** `~/Projects/Fondo-API-v2`, branch `feat/phase-1-auth`, `151314f..5ff018c`
(nine implementation commits `114d8cf`…`3a4e547`, plus `c75e9d5` and `5ff018c`, plan/docs only).
Plan revision **v0.14**. Round 1 above is unchanged and remains the baseline.

**Parity oracle:** `~/Projects/Fondo-API`, verified clean (`git status --porcelain` empty).

Lint / typecheck / suite results were re-verified by the operator (938 unit, 343 e2e) and are
taken as given. This pass spent its effort on substance, as round 1 did.

## 6. What I re-derived independently this round

| Claim under test | How | Result |
|---|---|---|
| **C4's reversal** — Django makes the process zone equal `TIME_ZONE` | Read `django/conf/__init__.py:183-193` in an installed `Django==2.2.27` tree: `os.environ['TZ'] = self.TIME_ZONE; time.tzset()`, guarded by `hasattr(time,'tzset')` | ✅ **Confirmed.** The developer is right and my S6 inference was wrong |
| The C4 residual (no tzdata ⇒ silent UTC) | Ran `os.environ['TZ']='Bogus/Zone'; time.tzset(); date.today()` in CPython on a UTC host | ✅ **Confirmed silent** — no exception, offset 0. Django's own validation is skipped when `/usr/share/zoneinfo` is absent (`conf/__init__.py:186-189`) |
| `python-json.ts` reproduces CPython | Ran the emulator over all 412 committed fixture rows via `tsx` | ✅ **412/412**, 0 mismatches |
| The fixture is a genuine 3.9 capture, not a transcription | Replayed the same 412 inputs through local CPython **3.14**: 4 rows differ — the two `Illegal trailing comma` messages (added after 3.9) and the two `\uXXXX`-at-end rows | ✅ The fixture is **3.9-authentic**; it could not have been generated on a modern interpreter |
| The `\uXXXX`-at-end-of-input quirk, which 3.14 disagrees with | Read CPython **3.9** `Modules/_json.c::scanstring_unicode`: `next++; end = next + 4; if (end >= len) raise_errmsg("Invalid \\uXXXX escape", pystr, next - 1);` — `>=`, and the position is the index of `u` | ✅ **Exactly what `python-json.ts:96-105` implements.** "Captured, not guessed" is accurate |
| `Invalid \escape` / `Invalid control character at` offsets | Same file: `raise_errmsg("Invalid \\escape", pystr, end - 2)` (the backslash) and `raise_errmsg("Invalid control character at", pystr, next)` (the character) | ✅ Both match `python-json.ts:130,140` |
| `media_type_matches` port | Compared `drf-media-type.ts:41-67` with DRF's `_MediaType.match` + Django's `parse_header` (which **lowercases** the full type — an easy miss) | ✅ Faithful, including the lhs-parameters loop being vacuous for parser media types |
| `_parse` / `_load_stream` semantics | Read `rest_framework/request.py` in an installed `djangorestframework==3.11.2` | ✅ The empty-body short-circuit, `content_type == ''`, and the 415 path are all reproduced correctly |
| **C3 against the real library** | Installed `python-dateutil==2.7.5`; generated **5 096** `(date, delta)` cases from the TS port across 2016-2021 × month-ends × 13 deltas and compared | ✅ **0 mismatches.** The 14-step MONTHLY clone chain from `2018-01-31T14:30:15.250Z` and the 5-step YEARLY chain from `2020-02-29` are identical to dateutil, microseconds included |
| C6's field sets | Diffed `PERSONAL/PREFERENCES/FINANCE_FIELDS` against `services/user.py:208-261` | ✅ Exact; `username` correctly absent (D15), `available_quota` correctly absent (derived) |
| The C5 pipeline's real behaviour | Booted a minimal Nest app with the production middleware + interceptor + filter and drove 11 probe requests | ⚠️ Mostly correct — **three divergences found, see R1/R2/R4** |
| v1's URL table for C9 | Read `fondo_api/urls.py` and `api/urls.py` in full | ⚠️ The C9 premise is **not quite right** — see §9 |

---

## 7. Condition-by-condition rulings

### C1 (S1) — `formatDateEs()` takes only a `PlainDate` — ✅ **Closed**

`spanish-format.ts:82-97` accepts `PlainDate` only, with a runtime `TypeError` naming both
conversions for JS callers and `as` casts. `date.util.ts:45-51` (`fromDateColumn`) and
`timezone.util.ts:123-126` (`toBogotaDate`) are the two named halves, each carrying the v1
`serializers.py` line it corresponds to, and `date.util.ts:37-40` is a per-column table Phase 2/4
can follow without re-deriving anything. The test I asked for exists verbatim
(`spanish-format.spec.ts`: one instant, `'28 mar. 2018'` through Bogotá and `'29 mar. 2018'`
through the date-column path). Recorded in `docs/phase-0-deviations.md` §2.11 and plan rule 5c.
Nothing left open.

### C2 (S2) — BigInt → JSON number — ✅ **Closed**

`json-bigint.ts:80-82` renders a bare number; `:67-72` throws `BigIntPrecisionError` outside
±(2^53−1) rather than losing a cent. The replacer-not-interceptor argument at `:32-39` is right
and worth keeping: `res.json()` applies `app.get('json replacer')` for both the handler path and
`ApiExceptionFilter` (`api-exception.filter.ts:54,78`), so error bodies and DTO instances are
covered without cloning. Installed by an `AppModule` provider (`app.module.ts:41`), so the e2e
suites exercise the production wiring — and `test/json-bigint.e2e-spec.ts` asserts the **raw
response text**, which is the only assertion that can tell `1000` from `"1000"`. Decision
recorded in `docs/phase-0-deviations.md` §2.10 and plan rule 5b.

### C3 (plan gap) — `relativedelta` month-end primitive — ✅ **Closed**

Independently differentially verified against `python-dateutil==2.7.5` above: 5 096 cases,
0 mismatches. `relativedelta.util.ts:76-78` folds months into total-month arithmetic instead of
reproducing dateutil's sign-dependent `divmod`, which is equivalent for every reachable input
and easier to read; `:81` is the clamp; `:88-93` applies `days`/`weeks` afterwards as a real
`timedelta`, which is the property that makes `2018-01-31 + 1 month − 5 days` come out right.
`addRelativeDeltaToInstant` operating on **UTC** wall-clock parts is correct here and for the
right reason (`:99-103`): Django hands `create_repeat_instance` a UTC-aware datetime and
`__radd__` calls `other.replace(...)`, leaving `tzinfo` untouched.

**On the two v1 behaviours it reproduces rather than fixes — reproducing them is correct, and
neither needs a business-analyst question.** I checked reachability in v1 rather than assuming
it:

* **MONTHLY collapse to the 28th is unreachable in v1.** `schedule_notification(run_date,
  payload, repeat=0)` has exactly three call sites — `services/loan.py:314`, `:315` (both
  `repeat=0`) and `services/user.py:282` (`repeat=4`). Nothing in v1 ever creates a `repeat=3`
  row, so `tasks.py:37` is dead code. Porting it faithfully costs nothing and is the right call;
  it is not a business question because there is no live behaviour to ask about.
* **The leap-day YEARLY drift is reachable only through a v1 path that already crashes.**
  `__create_birthdate_notification` (`services/user.py:267-282`) does
  `datetime.strptime(user.birthdate,'%Y-%m-%d').date().replace(year=today_year)`, and
  `date(2000,2,29).replace(year=2026)` raises `ValueError: day 29 must be in range 1..28`. See
  **V1** in §8 — that is a live v1 defect, and it is the thing worth escalating, not the drift.

### C4 (S6) — `auto_now` dates are Bogotá — ✅ **Closed.** My round-1 inference is withdrawn.

The reversal is correct and I confirm it at source level: `Settings.__init__` ends with
`os.environ['TZ'] = self.TIME_ZONE; time.tzset()` (Django 2.2.27, `django/conf/__init__.py:192-193`),
so `DateField.pre_save`'s process-local `datetime.date.today()` **is** Bogotá in any Django
process. My S6 was right about `pre_save` and wrong about the conclusion; the developer read one
level further, and the demonstration on the pinned stack (`2026-08-31` before `django.setup()`,
`2026-08-30` after, at 19:09 Bogotá on a UTC host) is the right kind of evidence. Plan rule 5
(`MIGRATION_PLAN.md:594-618`) and `timezone.util.ts:19-67` now record the whole chain, and the
two halves are named separately (`nowInstant()` / `todayForAutoNowDateField()`), which was the
part of S6 that still stands. The escalation is correctly withdrawn.

**The reversal has a second consequence nobody has written down yet, and it is good news:**
`scheduler/tasks.py:15-18` selects the day's tasks with `datetime.now()` (process-local) against
`run_date__year/month/day` lookups, which Django evaluates in `settings.TIME_ZONE`. Those two
only agree *because* of `tzset()`. Phase 7 must therefore anchor "today" in Bogotá, not UTC —
worth adding to Phase 7's scope note while rule 5 is being read.

**On the recorded residual (no in-repo Dockerfile; `tzset()` fails silently without tzdata):**
verified real — I reproduced the silent UTC fallback — and correctly characterised as the *only*
scenario producing UTC dates. I rate it **low and non-blocking**, for three reasons: v2 pins the
zone explicitly either way (`timezone.util.ts:164-169`), so no v2 behaviour depends on it; the
only exposure is whether *historic* rows written by the prod container agree with the rows v2
will write, and `last_modified` is rewritten on every save; and `LoanDetail.from_date` — the one
place a one-day error would move money through `days360` — is historic data v2 consumes as
stored, unchanged, either way.
**Follow-up, not a condition:** one command on the running production container settles it
permanently (`python -c "import time; print(time.tzname)"`, or `date`). Add it to the Phase 9
cutover runbook next to the other environment checks; it costs a minute and closes the last
unknown. I could not do it here — the dev database was down this session (`fondodev` refuses
connections, no postgres process, no containers), so no live-data cross-check was possible.

### C5 (S3, D18) — DRF request parsing — ⚠️ **Closed with follow-up**

**The condition itself is met, and the complexity is warranted.** All three original rows are
fixed rather than deviated: multipart parses, an unsupported media type is DRF's 415 with the
header echoed as sent, and a malformed JSON body returns CPython's own message and offset. I
verified the emulator independently (412/412; the 3.9-vs-3.14 divergence proves the fixture is a
real capture; the two C-scanner quirks match `Modules/_json.c` in the 3.9 branch). The
media-type port is a faithful reading of `_MediaType.match`, including the two things a
reimplementation usually gets wrong — Django's `parse_header` lowercases, and an absent
`Content-Type` is `''` rather than `None` and therefore 415s.

**Is the surface justified?** Yes. The alternative was three registered deviations, one of which
(multipart) makes Phases 3, 4 and 8 impossible — `UserView.patch`, `LoanView.patch` and
`FileView.post` all declare `@parser_classes((MultiPartParser,))`. `python-json.ts` is the only
part that is arguably optional, and it is 334 lines with a differential harness behind it; given
`JSONParser.parse` puts `str(exc)` verbatim into a client-visible body, emulating it is cheaper
than explaining a per-endpoint diff eight times.

**Is the seam in the right place?** Yes, and this is the strongest design decision in the batch.
Deferring the raise until after the guards reproduces `dispatch → initial() → handler` exactly,
so a bad token on a broken body still 401s. Doing it any other way (Nest's parser, or a
middleware that throws) inverts DRF's order on every write endpoint in Phases 3–8. Sharing
`NEST_APPLICATION_OPTIONS` via `src/bootstrap.ts` so no test app can silently diverge is the
right instinct — with one exception, R8 below.

**Three follow-ups, all found by driving the real pipeline. None re-opens Phase 1; all are due
at the Phase 3 gate.** See R1, R2 and R4 in §8. R1 and R2 are the ones that matter for the
Phases 3–8 side effects you asked about.

### C6 (S4) — a genuinely positive allowlist — ✅ **Closed**

`user-patch.policy.ts:85-111` transcribes the three field sets; I diffed them line by line
against `services/user.py:208-261` and they are exact, including `username`'s deliberate absence
(D15) and `available_quota`'s (derived at `:259`). `userPatchAllowlist:238-242` now builds from
`SECTION_FIELDS ∩ rights` and never reads `attempt.fields`, so `is_active`, `key_activation`,
`user_ptr_id` and `available_quota` are rejected. The round-1 §4.1 duplication note is also
addressed: `:234` calls `canWriteSection`, so section logic exists once. Parameterising
`privileged` (`:226`) so D16/Q26 can be switched on without editing the function, and testing
both readings now, is better than what I asked for.

### C7 (S5) — `FieldAllowlist` fails closed — ✅ **Closed**

`field-allowlist.ts:74-78`: an empty allowlist denies any write including the empty one; a
non-empty allowlist still accepts an empty change set, which is the correct asymmetry. The
docstring at `:58-72` states why it is defence in depth rather than the primary control, which
is exactly the ordering C8 settled.

### C8 — `body.type` gates the section, `changedFields` gates the field — ✅ **Closed**

`assertUserPatchAllowed:203-208` applies the two levels in that order, and level 1
(`assertSectionWritable`) never looks at a field, so a declared `finance` write by a MEMBER is a
403 whether the object is empty, unchanged or absent. `resolveSection:35-45` reproduces v1's
fall-through (any unrecognised `type` → `preferences`) and, more importantly, makes "authorise on
the body's shape" unrepresentable — the policy is only ever handed the dispatched section. My
round-1 §4.1 `Object.is` finding is fixed at `:273-304` with normalisation across the
JSON/Prisma boundary. One nit on that normalisation: R9.

### C9 (S7) — detail-route trailing slashes — 🔴 **Not closed** (correctly: never in the brief)

Unchanged in code; promoted to a tracked row in `MIGRATION_PLAN.md:833`. `nestjs-developer` was
right not to act outside its brief. My ruling is in §9 — and the premise in that row needs
correcting before anyone implements it.

---

## 8. New findings from this round

None blocking. Ranked; all are for the **Phase 3 gate**, not for Phase 2's start.

### R1 — major — the parser interceptor fires *before* the `@All()` 405 fallback

**Where:** `src/common/http/drf-parser.interceptor.ts:59-85` interacting with
`src/auth/auth.controller.ts:43-47`. **Reproduced**, not inferred, by driving the real
middleware + interceptor + filter:

| Request | v1 | v2 today |
|---|---|---|
| `PUT /api-token-auth`, `Content-Type: text/plain`, body | **405** `{"detail":"Method \"PUT\" not allowed."}` | **415** `{"detail":"Unsupported media type \"text/plain\" in request."}` |
| `PATCH /api-token-auth`, `application/json`, body `{` | **405** | **400** `{"detail":"JSON parse error - Expecting property name…"}` |
| `PUT /api-token-auth`, valid JSON | 405 | 405 ✅ |

**v1 behaviour it must match:** `APIView.dispatch` resolves `handler =
self.http_method_not_allowed` and raises `MethodNotAllowed` from the handler; `request.data` is
never touched, so no parser ever runs. **Why it matters:** it is live on a Phase 1 route today,
and it will be live on all six Phase 3–8 controllers, each of which needs the same `@All()`
fallback (plan rule 12). **Fix:** give the fallback a marker the interceptor honours — e.g.
`@DrfParsers()` with an empty list, or a `DRF_NO_BODY` metadata key — and skip the parse decision
when it is present. The same mechanism fixes R2, so it is one change, not two.

### R2 — major — v1 handlers that never read `request.data` will 415 in v2

**Where:** the same interceptor; the doc at `drf-request-parsing.middleware.ts:41-44` claims
POST/PUT/PATCH is a safe proxy for "reads `request.data`", "verified across all of
`fondo_api/views/`". The verification is method-level, but the property is handler-level, and two
handlers falsify it:

* `ActivityYearView.post` (`fondo_api/views/activity.py:38-43`) — calls `create_year()` and
  ignores the body entirely. `POST /api/activity/year` with `text/plain` is a **201** in v1;
  reproduced as **415** in v2. Phase 5.
* `UserAppsView.post` with `app == "birthdates"` (`fondo_api/views/user.py:79-83`) — returns
  birthdates without touching `request.data`. Same divergence. Phase 3. (The `"power"` branch
  *does* read it, so the two branches of one handler differ — which is exactly why the marker
  has to be per-handler and consciously applied.)
* `PasswordResetView.post` (`fondo_api/views/auth.py:31`) is a **Django** view reading
  `request.POST`, not a DRF view: it never negotiates a parser and never 415s. Phase 3 must not
  let the DRF pipeline touch it.

**Fix:** the R1 marker, plus one line in `docs/phase-1-drf-auth-bodies.md` naming these three so
Phase 3/5 apply it deliberately rather than discovering a 415 in a parity report.

### R3 — major — the C9 premise is wrong in both directions; see §9.

### R4 — minor — `express.json({strict: true})` fabricates a CPython message for top-level scalars

**Where:** `drf-request-parsing.middleware.ts:60-66` and `python-json.ts:328-334`. body-parser
defaults to `strict: true`, so a body of `5`, `null`, `true` or `NaN` under
`Content-Type: application/json` throws a `SyntaxError` **that CPython would not have thrown**.
`drfJsonParseErrorDetail` then falls through to its hardcoded
`'Expecting value: line 1 column 1 (char 0)'` — reproduced:

```
POST body `5`     v2: 400 {"detail":"JSON parse error - Expecting value: line 1 column 1 (char 0)"}
                  v1: 400 {"non_field_errors":["Invalid data. Expected a dictionary, but got int."]}
POST body `NaN`   v1 parses it (CPython accepts NaN/Infinity — python-json.ts:280-288 knows this)
POST body `[1,2]` v2 200-path, v1 400 non_field_errors   (arrays pass strict mode)
```

The `/* istanbul ignore next -- only called after JSON.parse already failed */` at
`python-json.ts:331` asserts this branch is unreachable. It is reachable, and it emits a message
CPython never produces. **Fix:** set `strict: false` (CPython's `json.loads` is non-strict, so
this *is* the parity setting) and let Phase 3's DTO layer produce DRF's
`Invalid data. Expected a dictionary, but got <type>.` for a non-dict body; then the fallback
becomes genuinely unreachable and the ignore comment becomes true.

### R5 — minor — one error branch mislabels, and v1 does not enforce the body limit it mirrors

**Where:** `drf-request-parsing.middleware.ts:144-150`. Every non-`SyntaxError` is rendered as
`Multipart form parse error - …`, including a JSON body over the limit. Reproduced: a 3 MB JSON
body returns `400 {"detail":"Multipart form parse error - request entity too large"}`.
Separately, the limit itself is a tightening rather than a match — DRF's
`Request._load_stream` sets `self._stream = self._request` and streams the WSGI input directly,
**bypassing** `HttpRequest.body`'s `DATA_UPLOAD_MAX_MEMORY_SIZE` check, so v1 accepts an
arbitrarily large JSON body on any DRF route. (For multipart, v2 is fine: multer imposes no
default limit, matching Django's spill-to-disk.) The round-1 C1 concern is nonetheless **closed
as reported** — a 200 kB body no longer 500s, and 100 kB → 2.5 MB was the right move. **Fix:**
branch the message on which parser ran, and register the >2.5 MB JSON tightening as a one-line
residual in `docs/phase-1-drf-auth-bodies.md` rather than leaving it as an unexplained 400.

### R6 — minor — `hasRequestBody`'s `Transfer-Encoding` branch has no counterpart in DRF

**Where:** `drf-request-parsing.middleware.ts:190-200`, whose comment cites `_load_stream`.
`_load_stream` reads `CONTENT_LENGTH`/`HTTP_CONTENT_LENGTH` only and nulls the stream at zero;
it has no chunked branch, so a chunked request yields empty data, no negotiation and no 415.
v2 parses it. (The `Number.isFinite` guard, by contrast, matches DRF's `except (ValueError,
TypeError): content_length = 0` exactly — that detail is right.) I could not reproduce the
end-to-end effect because Node rejects `Transfer-Encoding` + `Content-Length` at the HTTP layer,
which is why this is minor rather than major. **Fix:** drop the branch, or say in the comment
that it is a deliberate widening and why.

### R7 — minor — `express` and `multer` are phantom dependencies

**Where:** `drf-request-parsing.middleware.ts:2-3` imports both; `package.json` `dependencies`
lists neither. They resolve only because `@nestjs/platform-express@12.0.1` depends on
`express@5.2.1` and `multer@2.2.0` (`package-lock.json:2045-2056`) and npm hoists them. A
transitive bump or a different resolution breaks the build, and a root install at a different
major would give the adapter and the middleware **two different Express instances** — which
would silently unset the `json replacer` (C2). Adding `@types/multer` to `devDependencies` was
half the change. **Fix:** add `express` and `multer` to `dependencies`, pinned to the versions
platform-express resolves, so npm cannot dedupe them apart.

### R8 — minor — nothing proves DRF's permission-before-parse order on a *guarded* route

**Where:** `test/role-matrix.e2e-spec.ts:55` builds the app without `NEST_APPLICATION_OPTIONS`
and without `AppModule`, so it keeps Nest's default parser and registers neither the DRF
middleware nor the interceptor. That divergence is **acceptable and correctly reported** — the
suite's job is guard wiring and it sends no bodies — but it leaves a real hole: `/api-token-auth`
is `@Public()`, so the 401-beats-parse ordering is tested and the **403**-beats-parse ordering is
not tested anywhere. That is the ordering Phases 3–8 depend on (a MEMBER PATCHing `/api/loan`
with a malformed body must get 403, not 400). **Fix:** have the test module `configure()` the
middleware and pass `NEST_APPLICATION_OPTIONS`, then add one cell: a role-denied caller sending
`Content-Type: text/plain` must still get 403.

### R9 — nit — `normalise()` collapses numeric strings for free-text fields too

`user-patch.policy.ts:293-299`: `"007"` and `"7"` normalise identically, so `first_name` changing
from `"7"` to `"007"` reads as unchanged. Harmless for the gate — the privileged fields (`role`,
`identification`) are genuinely numeric and the collapse is right for them — but if Phase 3
reuses `changedFields` to compute a persistence diff, that edit is silently dropped. Either scope
the numeric collapse to a known field list, or add a comment saying the function is for
authorisation only.

### V1 / V2 — two live v1 defects found while checking C3's reachability

Not v2's problem to fix at this gate; recording them because Phase 3 will hit both.

* **V1 — a member born on 29 February cannot have their profile updated in a non-leap year.**
  `services/user.py:269` does `.replace(year=today_year)` on the birthdate, which raises
  `ValueError` (verified). `__update_user_personal` catches only `UserProfile.DoesNotExist` and
  `IntegrityError`, and `UserDetailView.patch` (`views/user.py:52-58`) has no try/except — so the
  request 500s and the surrounding `transaction.atomic()` rolls back the name/email change too.
* **V2 — updating an inactive user's `personal` section with a `birthdate` 500s the same way.**
  `services/user.py:272` does `user_ids.remove(user.id)` on a list built from
  `UserProfile.objects.filter(is_active=True)` (`:147-155`); for an inactive target the id is
  absent and `list.remove` raises `ValueError`.

---

## 9. Ruling on C9 — trailing slashes

**First, correct the premise.** The C9 row (and my own S7) says v1's collection routes carry
`/?` and its detail routes do not. Reading `fondo_api/urls.py` and `api/urls.py` in full, that is
wrong in **both** directions:

```python
url( r'^api/activity/(?P<id>[0-9]+)/?$',            ActivityDetailView )   # detail WITH /?
url( r'^api/notification/(?P<operation>[a-zA-Z]+)/?$', NotificationView )  # parameterised WITH /?
url( r'^api/user/(?P<app>-?[a-zA-Z]+)$',            UserAppsView )         # no /?
url( r'^api/user/(?P<id>-?[0-9]+)$',                UserDetailView )       # no /?
url( r'^api/user/activate/(?P<id>[0-9]+)$',         UserActivateView )     # no /?
url( r'^api/loan/(?P<id>[0-9]+)$',                  LoanDetailView )       # no /?
url( r'^api/loan/(?P<id>[0-9]+)/(?P<app>[a-zA-Z]+)$', LoanAppsView )       # no /?
url( r'^api/activity/year/(?P<id_year>[0-9]+)$',    ActivityYearDetailView)# no /?
url( r'^api/file/(?P<id>[0-9]+)$',                  FileDetailView )       # no /?
# api/urls.py — trailing slash is MANDATORY, and APPEND_SLASH 301s the bare form:
url( r'^password_reset/$' ) · url( r'^password_reset/done/$' )
url( r'^reset/(?P<uidb64>…)/(?P<token>…)/$' ) · url( r'^reset/done/$' )
```

There is no rule here, only a table. A blanket "detail routes are strict" rule would make v2
**404 `/api/activity/5/` and `/api/notification/subscribe/`, which v1 serves** — a regression in
the opposite direction, and a worse one than the current widening. And `CommonMiddleware` is
enabled (`api/settings/base.py:41`) with `APPEND_SLASH` defaulted on, so the four password-reset
paths **301** from their bare form in v1 — a case neither S7 nor C9 mentions and which Phase 3
owns.

**Ruling: fix it, do not accept it — but transcribe the table, do not infer a category rule.**

1. Enable Express strict routing once, at bootstrap, alongside `bodyParser: false` in
   `src/bootstrap.ts` so no test app can diverge.
2. Give every controller its paths as an explicit array, transcribed from the two `urls.py`
   files: `@Get(['api/activity/:id', 'api/activity/:id/'])` where v1 has `/?`, a single path
   where it does not. Twenty-odd literals, each traceable to one v1 line.
3. Phase 3 additionally decides the password-reset routes: mandatory slash, plus 301 or 404 for
   the bare form.
4. One e2e case per shape: `/api/loan/5/` → 404, `/api/activity/5/` → 200, `/api/loan/` → 200.

Why fix rather than accept: the widening is not cosmetic. It applies to `PATCH` and `DELETE
/api/user/<id>/` — a client that appends a slash gets an inert 404 in v1 and a **real soft
delete** in v2. And the governance cost is asymmetric: exactness needs no operator decision,
whereas plan §7 criterion 5 makes an accepted deviation a decision the user must own — for a
behaviour with no upside. The 404 body itself is already covered by **D13** (HTML → JSON), so
this needs no new deviation at all.

If the user prefers speed over exactness, the fallback is acceptable but must be explicit: a §4
rule containing the table above verbatim, an operator sign-off under criterion 5, and a note to
`manual-tester` that trailing-slash 200s are expected diffs for eight phases. I do not recommend
it.

**Deadline:** unchanged from round 1 — the **Phase 3 gate**, before the first detail route ships.
It does not block Phase 2, which adds no routes.

---

## 10. Final gate verdicts

### Phase 0 — Foundations, Prisma baseline, cross-cutting utilities

> # ✅ APPROVED

All four Phase 0 conditions are closed: **C1** ✅, **C2** ✅, **C3** ✅, **C4** ✅. Each was
re-verified against something outside this repository — Django's own source for C4,
`python-dateutil==2.7.5` for C3 (5 096 cases, 0 mismatches), the raw HTTP response text for C2.
The C4 residual is documented, non-blocking, and reduced to a one-command runbook check. No
conditions carry forward from Phase 0.

### Phase 1 — Authentication and role permissions

> # ✅ APPROVED

**C5** ✅ closed (with the three follow-ups in §8), **C6** ✅, **C7** ✅, **C8** ✅. **C9**
remains open, with my ruling in §9; per round 1 its deadline was always the **Phase 3** gate, and
Phase 2 adds no routes, so it does not gate what happens next.

Approving with R1/R2 known and unregistered is a deliberate call, not a hedge. Both are
consequences of a change that removed three strictly larger divergences; neither is reachable by
any client of this API (`PUT`ting `text/plain` at the login endpoint; a `text/plain` body on a
year-creation POST that does not exist yet); and both are now tracked, which is the difference
between a known residual and a latent one. What would *not* be acceptable is carrying them into
Phase 3 unfixed, which is why they are conditions on that gate.

**Phase 2 is authorised to start.**

### Conditions carried to the Phase 3 gate

| # | Condition | From |
|---|---|---|
| C9 | Trailing slashes: strict routing + the transcribed path table (§9), including the password-reset routes. | R2 · S7 |
| C10 | The `@All()` 405 fallback and handlers that never read `request.data` must bypass the parser interceptor (R1, R2) — one marker, three call sites, one doc line. | R2 |
| C11 | `express.json({strict:false})` + a DRF-shaped non-dict body error (R4); correct the mislabelled parse-error branch and register the >2.5 MB JSON tightening (R5). | R2 |
| C12 | Add `express` and `multer` to `dependencies` (R7). | R2 |
| C13 | One e2e cell proving 403 precedes 415/400 on a guarded route (R8). | R2 |

R6 and R9 are recommendations, not conditions. Round 1's C1–C12 "consider" items that were not
promoted remain recommendations.

### Escalations to `business-analyst`

1. **v1 defect V1** — a member with a 29 February birthdate 500s on every personal update in a
   non-leap year, rolling back the whole edit. v2 must choose a behaviour (clamp to 28 Feb, or
   schedule on 1 March) before Phase 3 implements `__create_birthdate_notification`. This
   supersedes any question about C3's leap-day drift, which is unreachable until this is decided.
2. **v1 defect V2** — the same endpoint 500s when a `birthdate` is set on an **inactive** user,
   because the notification's recipient list excludes inactive members and `list.remove` raises.
   Phase 3 needs a rule: skip the notification, or include the target.
3. The round-1 escalation on `UserFinance.last_modified` is **withdrawn** — C4 settled it.
