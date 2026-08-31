# Fondo-API — Django → NestJS Migration Plan

**Spec of record for v1 behavior:** `CONTEXT.md` in the v1 repo (`~/Projects/Fondo-API`).
When CONTEXT.md and the v1 source disagree, **the source wins** and CONTEXT.md gets fixed.

- **v1 (Django):** `~/Projects/Fondo-API`
- **v2 (NestJS):** `~/Projects/Fondo-API-v2` (this repo)

## Changelog

| Date | Rev | Change |
|---|---|---|
| 2026-08-30 | v0.14 | **All eight review conditions C1–C8 closed** (§7). Rule 5 **re-corrected and settled**: Django sets `os.environ['TZ']` from `TIME_ZONE`, so v1's `DateField` dates are **Bogotá**, verified against the pinned stack — the BA escalation on `last_modified` is withdrawn. Rule 5b (BigInt→JSON number) and 5c (`formatDateEs` takes a `PlainDate`) implemented as Phase 0 primitives. **D18 fixed rather than deviated** — v2 owns request parsing and reproduces DRF's multipart/415/JSON-parse behaviour, including CPython's error strings. `relativedelta` ported (reviewer P5). D1's primitives now express the C8 rule ordering. ⚠️ One review condition is **untracked**: S7 (detail-route trailing slashes) appears in the review's Phase 1 gate but in no §7 row — see the note under the table. |
| 2026-08-30 | v0.12 | **Phases 0 and 1 reviewed — both Approved-with-conditions, no blocking findings.** 8 conditions tracked in §7. Cross-cutting rule 5 **corrected** (Django `DateField(auto_now)` is process-local, not tz-aware). Two new rules: BigInt→JSON (17 columns; first Phase 3 response would 500) and the date-formatting/localtime asymmetry. D18 registered for content-type divergences. Fixed a self-contradiction in §9. |
| 2026-08-30 | v0.11 | business-analyst Phase 3 note folded in (verdict: **Concerns**). D1 clarified on two points that would each have broken every ordinary member save. **D14–D17 registered**; D16/D17 need operator input. Two live v1 defects verified and recorded: personal edits to the two shared-email accounts **409 today**, and **4 of 15 members cannot reset their password**. |
| 2026-08-30 | v0.10 | **Standing review gate made explicit** (§7): `nestjs-reviewer` runs at the end of every phase and writes `docs/review-phase-<n>.md`; no phase closes without a verdict. Phases 0 and 1 under review now, retroactively. |
| 2026-08-30 | v0.9 | **Phase 1 complete and verified** (`feat/phase-1-auth`, `151314f`). ⚠️ **Corrected a false premise: `username != email` for 2 of 15 live users, and Django authenticates on `username`** — the plan's mapping would have locked them out. DRF auth bodies derived and pinned (Phase 1's open item closed). Two new cross-cutting rules (405-vs-404, DRF framework error shape). D13 registered. Role-matrix criterion corrected to 280 cells. |
| 2026-08-30 | v0.8 | **Q25a resolved — D1 fully specified.** Privileges are additive on top of universal self-service. **Phase 1 unblocked and started.** |
| 2026-08-30 | v0.7 | Q10, Q13, Q18–Q25 answered. **Phase 6 unblocked** — CAP rules now specified. D3 **withdrawn** (v1 was right); D5 decided; **D12 added** (CAP auto-close, new functionality — makes P6 depend on P7). Cutover calendar constraint **corrected and narrowed** after re-reading `create_year` — only the bulk-upload cycle genuinely constrains timing. |
| 2026-08-30 | v0.6 | **Phase 0 complete and verified** (`feat/phase-0-foundations`, `b3effab`). Eleven corrections from implementation folded back: DB-level FK facts (deferrable, no cascade), hstore write-side + key-order rules, DRF error-body gap in Phase 1, D11 registered, Prisma 7 / NestJS 12 tooling notes added as §10. |
| 2026-08-30 | v0.5 | **v1 is frozen** — no changes to the Django codebase for any reason (new constraint, §1). Q6 and Q12 reconfirmed as deliberate accepts. Phase 0 started. |
| 2026-08-30 | v0.4 | Operator answers folded in (Q1–Q9, Q12, Q14–Q17). **Phases 1 and 4 unblocked.** Dev DB reloaded to `0019` — Phase 0 prerequisite cleared. D1 refined to a concrete field-level rule; D4 changed from *validate* to *reject 400*; four new deviations (D7–D10) registered for behavior the operator asked to change. Phase 6 still blocked (Q19–Q24); Q10/Q11/Q18 still open. |
| 2026-08-30 | v0.3 | business-analyst review folded in (verdict: **Concerns**). Added §5 **Deliberate deviations register** — v1 has authorization holes the parity contract would otherwise replicate. P7 resequenced to after P4. Phase 0 gains a dev-DB prerequisite (it is at migration 0015; `power` and `savingaccount` tables are missing). Phase 2 gains four notification conditions; P3/P4/P6 gain newly surfaced rules. §9 now tracks 24 operator questions. |
| 2026-08-30 | v0.2 | Q1–Q7 answered. **ORM decision: Prisma (binding).** Cutover is a hard switch performed by the user; v2 owns the schema post-cutover. Alexa confirmed retired. CI/CD reuses CodeBuild. Password-reset token cross-compat requirement **dropped**. hstore→jsonb scheduled as v2's first owned migration. Plan moved to the v2 repo. |
| 2026-08-30 | v0.1 | Initial draft. Phase 0–9 scoped, ORM comparison drafted, cross-cutting parity rules and gate template defined. |

---

## 1. Fixed constraints (not up for re-litigation)

- **Target stack:** NestJS (latest stable), **Node 24** (`.nvmrc` = 24), TypeScript **strict** mode.
- **ORM: Prisma.** Decided in §2. **Binding** for `nestjs-developer` and `nestjs-reviewer`.
- **Database:** the existing PostgreSQL schema Django created. No schema rebuild, no data
  migration, no renames **until cutover**. v1 and v2 share one database during development
  and parity testing; in production the switch is atomic.
- **Cutover: hard switch, performed by the user.** v1 and v2 never serve production traffic
  simultaneously. This plan produces a runbook; it does not perform the cutover.
- **Schema ownership:** Django owns the schema through Phase 8. **v2 takes ownership at
  cutover** via a Prisma baseline, and owns all migrations thereafter.
- **Out of scope — delete entirely, do not port** (Alexa is confirmed retired):
  - `AlexaView` / `POST /api/alexa`
  - `AuthView` / `GET|POST /api/authorize` — Alexa account-linking only
  - everything under `fondo_api/services/alexa/`
  - `ALEXA_CLIENT_ID`, `AWS_SKILL_ID`, `templates/auth/authorize.html`
  - all of `fondo_api/tests/alexa/` (20 tests)
  - ⚠️ `PasswordResetView` lives in the same file as `AuthView` and **is in scope** — do not
    delete `views/auth.py` wholesale.
- **In scope, must reach behavioral parity:** token auth, role permissions, loans +
  amortization + refinancing + bulk TSV upload, users + finance/quota + activation + powers
  of attorney, activities per year, saving accounts (CAPs), web-push notifications via SQS,
  SES email (Spanish templates), GCS file storage, password reset, and the Celery-beat
  scheduler.
- **CI/CD:** reuse the existing AWS CodeBuild + `buildspec.yml` + SSM deploy-trigger shape.
- **v1 is frozen.** No changes to the Django codebase — not features, not refactors, not
  security patches. Every fix lands in v2 only. Two consequences to hold in view:
  1. The **D1 privilege escalation stays live in production until cutover.** It is a real,
     currently-exploitable path to ADMIN and to self-set loan quota. Accepted by the operator;
     recorded here so the decision is visible rather than forgotten. It raises the value of
     shipping Phase 1 promptly.
  2. v1 stays the parity oracle for the whole migration — it cannot drift under us, which makes
     `manual-tester`'s diffs trustworthy. This is the upside of the freeze.

---

## 2. ORM decision: **Prisma** (binding)

Scored against this project's specifics. The user delegated the call ("the one that best fits
the project's needs and design"), so this is a decision, not a recommendation.

| Criterion | Prisma | TypeORM | Weight |
|---|---|---|---|
| **Migrations, v2-owned schema** | ✅ Prisma Migrate; `migrate diff` + baselining an existing DB is a first-class, documented workflow. Declarative schema is the source of truth. | ⚠️ `migration:generate` is drift-based, noisier, and routinely needs hand-editing. | **High** |
| **`hstore` columns** (2 of them) | ❌ Not supported — [prisma#19000](https://github.com/prisma/prisma/issues/19000) open. Introspects as `Unsupported("hstore")`, which the client **cannot select**. Needs raw SQL with `::text` casts. | ✅ Native `{ type: 'hstore' }` → `Record<string,string>`. | **High**, but **time-boxed** — see below |
| **TS type safety of results** | ✅ Generated types, end to end. | ⚠️ Hand-maintained entities that drift from the DB. | **High** |
| **Externally-owned schema** (Phases 0–8) | Good `db pull`; Migrate held back until cutover via baseline. | `synchronize: false` and it simply doesn't care. | Medium |
| **Django MTI** `UserProfile(User)` → `auth_user` + `fondo_api_userprofile` | 1:1 on `user_ptr_id`; every user read needs an explicit `include`. | `@OneToOne` + `@JoinColumn`. Comparable. | Medium |
| **Decimal / BigInteger money**, `rate` Decimal(5,3) | ✅ `Decimal.js`-backed, no float drift. `BigInt` for bigints. | ⚠️ `decimal` returns **string** by default; needs a transformer. | Medium |
| **Transactions** vs `transaction.atomic()` / `set_rollback` | Interactive `$transaction(async tx => …)`. | `dataSource.transaction()` / `QueryRunner`. Both fine. | Medium |
| **Raw SQL escape hatch** (bulk TSV upserts) | `$queryRaw` / `$executeRaw`, tagged and typed. | `query()` / QueryBuilder. Both fine. | Low |

### Rationale

Two facts decide it. **v2 owns the schema after cutover and the ORM must carry migrations**
— that promotes the migration story from a footnote to a top-weight criterion, and Prisma
Migrate is clearly stronger there. And **the hstore problem is bounded and temporary**: it
touches roughly 6–8 query sites across exactly two subsystems, it is quarantined behind two
repository classes, and it **dies at cutover** when the columns become `jsonb` (§3, Phase 9).
Prisma's type safety and migration ergonomics, by contrast, are paid forward for the life of
the project. This repo's `.gitignore` already carries `/generated/prisma`.

### The trade-off, stated plainly

The raw-SQL burden lands on **notifications and the scheduler** — precisely the two
subsystems with the thinnest inherited test coverage (4 tests and 0 respectively). This is
the single largest risk the decision creates, and Phases 2 and 7 carry extra integration-test
requirements to offset it.

### hstore handling until cutover

- Model both columns as `Unsupported("hstore")` in `schema.prisma`. Prisma Migrate preserves
  them; the client cannot read them.
- **All** access goes through `NotificationSubscriptionRepository` and `SchedulerTaskRepository`.
  No `$queryRaw` touching hstore anywhere else in the codebase — reviewer enforces this.
- Reads cast to text (`subscription::text`) and parse via the Phase 0 hstore codec.
- ⚠️ **Writes need the Python encoding too** — not just reads. Django `str()`s every value before
  storing, so a nested dict becomes a Python `repr` (single quotes). If v2 wrote JSON into the
  same column, v1 and v2 rows would be encoded differently and the read-side repair would break
  on v2's own rows. The Phase 0 codec implements both directions; use it on every write.
- ⚠️ **hstore key order is part of the SQS wire format.** Postgres returns hstore keys ordered by
  key length then bytes, and v1 `json.dumps`es that dict straight through to SQS. Phase 2's
  byte-identical criterion depends on reproducing that ordering — it is not an implementation
  detail.
- The codec must reproduce v1's quirks exactly — string-only values, `json.loads` on
  `payload['user_ids']`, and the `'` → `"` repair on the push-subscription `keys` sub-object
  (a Python `repr`, not valid JSON). **Do not "fix" these** — live rows depend on them.

---

## 3. Phase sequence

```
P0 Foundations & Prisma baseline ──┐
P1 Auth + roles                  ──┤ (no domain endpoints; everything depends on these)
P2 Mail + notifications          ──┤ (users & loans both emit)
P3 Users, finance, powers, password reset
P4 Loans (the risk centre)
P7 Scheduler ── resequenced: sole delivery path for payment reminders, zero inherited tests
P5 Activities
P6 Saving accounts
P8 Files + admin
P9 Cutover (user-performed) + hstore→jsonb + decommission
```

---

### Phase 0 — Foundations, Prisma baseline, cross-cutting utilities

**Goal:** a NestJS app that boots against the real schema, with the primitives every later
phase depends on. **No business endpoints.**

✅ **Prerequisite cleared (2026-08-30):** `fondodev` reloaded from a recent snapshot and
verified at `0019_auto_20220313_1225`, with `fondo_api_power` and `fondo_api_savingaccount`
present. Phases 3 and 6 are parity-testable. Re-verify after any future DB reload — a snapshot
older than `0017` silently breaks those two phases.

**Scope**
- Nest scaffold: Node 24, TS strict, ESLint + Prettier, Jest (unit) + Supertest (e2e).
- **Prisma setup:**
  - `prisma db pull` against the Django-created schema; hand-correct the generated models.
  - Verify against `fondo_api/models.py` and migrations `0001..0019`.
  - Both hstore columns as `Unsupported("hstore")`.
  - **Baseline:** generate an initial migration via `migrate diff` and mark it applied
    (`migrate resolve --applied`) so v2's history starts from the current live schema.
    **Do not run `migrate dev` against any DB v1 still uses.**
- Config module: typed and **validated at boot**, replacing v1's scattered `os.environ`
  reads. v1 `KeyError`s at import on a missing `DEFAULT_FROM_EMAIL`; v2 must fail fast with
  a clear message.
- Cross-cutting utilities, each unit-tested against v1's expected values:
  - `days360()` US-NASD 30/360 — port from `services/utils/date.py`; tests from `test_date_utils.py`.
  - **Money helper.** v1 rounds with `int(round(float(x), 0))` — Python **banker's rounding**.
    JS `Math.round` rounds half **up**. They differ on every `.5`. Ship `roundHalfEven()` and
    use it wherever v1 uses `round`.
  - **hstore codec** (§2).
  - **Spanish locale formatting.** v1 uses `babel.dates.format_date` / `babel.numbers` with
    `ROUND_HALF_DOWN`. Node `Intl` is not byte-identical. Pin with golden-string tests taken
    from v1's email assertions.
  - Timezone: `America/Bogota`, Django `USE_TZ=True` semantics.
- Global exception filter reproducing v1's `(success, payload_or_msg)` → `{message}` + status
  convention.
- `{ list, num_pages, count }` pagination helper, including v1's behavior that a page beyond
  the last returns an **empty list, same envelope, HTTP 200** — not 404.
- CI skeleton on the existing CodeBuild shape (§7).

**Risks**
- Introspected models disagreeing with Django semantics — especially `auto_now` /
  `auto_now_add`, which Django sets **in Python**, not as DB defaults. v2 must set
  `created_at` / `last_modified` explicitly or hit NOT NULL violations.
- During parity testing both apps insert into the same tables and must share the same
  Postgres sequences. Free as long as v2 never redefines a PK column — verify explicitly.

**Gate:** every table round-trips; utility unit tests green and matching v1's values.

---

### Phase 1 — Authentication and role permissions

**Goal:** a request authenticated by v1 is authenticated identically by v2, and every role
rule matches.

**Routes:** `POST /api-token-auth`.

**Scope**
- **DRF token auth.** Reuse `authtoken_token` as-is (key PK, `user_id`, `created`). Token is
  40 hex chars. Header scheme is `Token`, **not** `Bearer`. Login uses **get-or-create** —
  v1 reuses an existing token and does not rotate.
- **Django password verification.** Hashes are `pbkdf2_sha256$<iterations>$<salt>$<b64hash>`
  (Django 2.2 default 150 000 iterations). v2 must verify this format — real member passwords
  live in `auth_user`. While v1 still runs in dev/parity, v2 also **writes** that format on
  activation and reset. Rehash-on-login to argon2 is a post-cutover cleanup item, not now.
- **`UserProfile(User)` identity mapping** — `auth_user` + `fondo_api_userprofile` on
  `user_ptr_id`.
- ⚠️ **CORRECTED (v0.9) — do not trust CONTEXT.md here.** The plan previously said
  `USERNAME_FIELD = 'email'` and `username = email` everywhere. **Both halves are misleading.**
  `AUTH_USER_MODEL` is commented out (`api/settings/base.py:101`), so Django's `ModelBackend`
  uses `User.USERNAME_FIELD == 'username'`; `UserProfile.USERNAME_FIELD = 'email'` **never
  participates in authentication**. And while v1 *writes* `username = email` on create,
  **2 of the 15 users in `fondodev` have `username != email`** (verified). Login resolves
  **`auth_user.username`**. A v2 that looked up `email` would lock those members out of their
  own fund.
- **Roles guard** reproducing `APIRolePermission` (`fondo_api/permissions.py`) exactly:
  - int rule N → allow if `role <= N` (0=ADMIN, 1=PRESIDENT, 2=TREASURER, 3=MEMBER)
  - list rule → allow if `role in list`
  - **any lookup miss or exception → deny.** v1's bare `except: return False` means a route
    absent from `list_permissions` is denied, not open. v2's guard must **default-deny**, and
    a route with no explicit rule must fail closed.
- Public routes (guards cleared): `POST /api-token-auth`, `POST /api/user/activate/<id>`,
  `POST /password_reset/`. Nothing else.

**⚠️ Additional deliverable — resolve the authorization gaps before writing the role matrix.**
v1's role matrix is not a safe spec on its own; see §5. D1–D3 must be decided (port or fix)
**in this phase**, because the Phase 1 parity criteria hard-code the matrix as the contract.
A decision deferred here gets silently baked in.

**Risks**
- ⚠️ **Highest-severity phase.** A wrong guard silently widens access to member financial data.
- Deny-by-default is easy to lose when translating a dict lookup into decorators.
- ⚠️ The role matrix is **necessary but not sufficient** — v1's holes are inside the service
  layer (no ownership checks), not in the guard. A perfect guard port still leaves D1 open.

**Parity criteria**
- The same token string authenticates against both APIs.
- Valid/invalid login returns identical status and body.
- ✅ **Resolved.** All auth-failure bodies are derived and pinned in
  [`docs/phase-1-drf-auth-bodies.md`](docs/phase-1-drf-auth-bodies.md) — from the
  `djangorestframework==3.11.2` sdist *and* an independent container running v1's real settings
  and unmodified `permissions.py`. `manual-tester` cites that document rather than re-capturing.
- ✅ **The 401-vs-403 ambiguity is not real for this project.**
  `TokenAuthentication.authenticate_header()` returns a truthy `'Token'`, so DRF's coerce-to-403
  branch is dead code here. **Every authentication failure is 401** with `WWW-Authenticate: Token`;
  only `APIRolePermission` denials are 403. Stated here so nobody re-derives it.
- ⚠️ Two ordering facts that are easy to get backwards: a missing or wrong-scheme header is **not**
  an authentication error (DRF returns `None`, and `IsAuthenticated` produces a *different* body
  later); and `APIView.initial()` authenticates **before** checking permissions, so a bad token
  401s **even on a public route** — `POST /api-token-auth` with a garbage token never reaches login.
- **Full role matrix: 14 view classes × 5 methods × 4 roles = 280 cells.** Test *all five*
  methods, not only those declared in `list_permissions` — the **undeclared** ones are exactly
  where the default-deny fallthrough lives, and testing only declared methods never exercises
  it. (`DELETE /api/loan` is 403 even for ADMIN.)

---

### Phase 2 — Outbound integrations: SES mail + SQS notifications

**Goal:** v2 emits byte-identical emails and SQS messages. Before users/loans because both
emit on write paths.

**Routes:** `POST /api/notification/<subscribe|unsubscribe>` (role ≤ 3).

**Scope**
- `MailService` on **`@aws-sdk/client-ses`**. Port `send_mail(template, recipients, params, bcc)`
  including: an address in **both** `recipients` and `bcc` is dropped from `bcc`; and **any
  exception returns `false`** rather than throwing — `create_user` depends on the falsy return
  to roll back.
- Port the six Spanish templates via the `EmailTemplate` enum: `USER_ACTIVATION`,
  `CHANGE_STATE_LOAN_APPROVED`, `CHANGE_STATE_LOAN_DENIED`, `POWER_APPROVED`, `TEST`,
  `PASSWORD_RESET`. Django templates → a Node engine (Handlebars/Eta). The `{% host %}`
  custom tag → a `host` template variable from config.
- `NotificationSubscriptionRepository` (raw SQL, hstore — §2): storage deduped on
  `subscription__endpoint`.
- `send_notification(user_ids, message, target)` builds `{ subscriptions, message: { body, target } }`
  and publishes to **SQS** (`NOTIFICATIONS_QUEUE_URL`). The external Lambda still does the
  actual Web Push, unchanged.
- v1's Celery indirection collapses: v1 does `send_notification.delay(...)` → task → SQS; v2
  publishes directly, so `run_async` True/False converge. ✅ **Resolved (§9.1): there is no
  retry layer to lose** — `celery/tasks.py:send_notification` swallows exceptions and declares
  no `autoretry_for`, and the scheduler path already publishes inline. Four binding conditions:
  1. Add a **bounded retry with backoff** (3 attempts) around `SendMessage`. Strictly improves
     on v1; no new infrastructure.
  2. Keep v1's swallow semantics at the boundary — a publish failure must **never** fail the
     HTTP write or roll back a loan/CAP/power row.
  3. ⚠️ **Never put the SQS publish inside a Prisma interactive transaction.** All three v1
     `.delay()` sites sit *outside* `transaction.atomic()`. Moving the publish inside would
     make an SQS outage roll back loan creations — a business-visible regression the inline
     change makes easy to introduce accidentally.
  4. Pre-existing gap to carry forward knowingly: a member with zero rows in
     `notificationsubscriptions` receives **no payment reminder at all** (`send_notification`
     returns early). Not a migration defect — but do not "fix" it silently either.

**Risks**
- ⚠️ Email HTML is asserted **byte-for-byte** in v1 tests (`test_mail_service.py`, and full
  SES payloads inside the loan tests). Whitespace, Spanish dates, and currency formatting must
  match — this is where the Phase 0 formatter earns its keep.
- ⚠️ **hstore + thin coverage.** Only 4 v1 notification tests exist and this is raw-SQL
  territory. **Extra integration tests required** covering the round-trip of a real
  push-subscription payload, including the nested `keys` repair.

**Parity criteria**
- Per template: identical SES payloads (`Source`, `Destination`, `BccAddresses`, `Subject`, `Body.Html`).
- Subscribe/unsubscribe produce identical `notificationsubscriptions` rows; re-subscribing the
  same endpoint does not duplicate.
- SQS message bodies byte-identical for the same input.

---

### Phase 3 — Users, finance, powers of attorney, password reset

**Routes:** `POST|GET|PATCH /api/user`, `GET|PATCH|DELETE /api/user/<id>`,
`POST /api/user/<birthdates|power>`, `POST /api/user/activate/<id>`, `POST /password_reset/`.

**Scope**
- `create_user`: atomic — `UserProfile` (**both tables**) + `UserFinance` (zeros) +
  `UserPreference`; `key_activation` = 25 random bytes hex; activation email. **If the mail
  send returns falsy, roll the whole transaction back** and return `'Invalid email'`. Unique
  violation → `'Identification/email already exists'`.
- **⚠️ Two decisions Phase 1 surfaced and deliberately did not make:**
  1. **D1's `role` check — "field present" or "field changed"?** v1's client posts the whole
     `personal` object on every PATCH, `role` included. A literal "`role` key present and caller
     is not ADMIN → 403" would break a member editing their own name. Phase 1 shipped both
     readings as tested primitives (`field-allowlist.ts` and `changedFields()`) and chose
     neither. **Recommendation: the `changedFields` reading** — compare against the stored value
     and only 403 on an actual change. Put this to business-analyst before implementing.
  2. **`PATCH /api/user/-1` does not mean "me" in v1.** Only `UserDetailView.get` substitutes
     `request.user.id`; `.patch` and `.delete` pass `-1` straight through and 404. Looks like an
     oversight rather than a rule. `resolveUserId()` makes the choice explicit so it cannot be
     inherited by accident — decide deliberately.
- ⚠️ **The two shared-email accounts — verified live, and the hazard is not what it looked like.**
  `fondodev` has **two pairs of users sharing an email address**: ids 7 & 14
  (`criss9413@hotmail.com`) and ids 10 & 13 (`mhjc123@hotmail.com`). Ids 13 and 14 have
  birthdates in **2011 and 2020** — children enrolled under a parent's address. Because
  `auth_user.username` carries a UNIQUE index (`auth_user_username_key`),
  `user.username = obj['email']` does not silently rename them: it raises `IntegrityError`, so
  **any personal edit to Sebastián or Ainhoa returns a bare 409 today**. The silent login-name
  rotation only occurs if one of them is later given a fresh, unique email. D15 fixes the write;
  the two rows still need reconciling — see the runbook item in §9.
- `update_user` dispatch on `obj['type']` → `personal` / `finance` / `preferences`, returning
  200/404/409. Finance writes **only changed fields** and recomputes
  `available_quota = total_quota - utilized_quota`.
- `activate_user`: match `(id, key_activation, identification)`, set password (Django format),
  `is_active = true`, null the key.
- `DELETE` = **soft delete** (`is_active = false`), role ≤ 0.
- `id == -1` means "me" — the URL regex deliberately allows a negative id.
- `PATCH /api/user` — multipart **TSV bulk finance update** keyed by identification.
- `handle_power_request` multiplexed on `request['type']` (`post`/`get`/`patch`); on approval,
  emails the formal Spanish power-of-attorney letter **to all users**. Two defects ride along
  (§5 D2, D5): recipients go in `ToAddresses` with an empty `Bcc`, **exposing every member's
  email address to every other member**; and `Power.objects.get(id=request['id'])` never checks
  that the caller is the requestee, so **any member can approve any power request** and trigger
  the fan-out. Decide port-or-fix before implementing.
- `birthdates` app; setting `birthdate` on a personal update schedules a **yearly** (`repeat=4`)
  `SchedulerTask` for all other users. Rows written here, consumed in Phase 7.
- `get_users_attr(attr, roles)` helper.
- **Password reset.** ✅ *Simplified by the hard-switch decision.* v2 uses its **own** token
  scheme — no need to reimplement Django's `default_token_generator` or share
  `DJANGO_SECRET_KEY`. Port the behavior, not the token format: the http/https switch on
  environment, and the **unconditional** redirect to `/password_reset/done/` (no user
  enumeration). *Runbook note: reset links issued by v1 stop working at cutover; Django's
  default timeout is 3 days, so worst case a few members re-request.*

**Risks**
- MTI writes touch two tables; a partial insert corrupts login.
- The email-failure rollback is a real transactional requirement, not a nicety.
- TSV parsing: `line.decode('utf-8').strip().split("\t")`, dates `d/m/Y` → `Y-m-d`.

**Parity criteria**
- User creation produces identical rows across `auth_user`, `fondo_api_userprofile`,
  `fondo_api_userfinance`, `fondo_api_userpreference` (modulo id/timestamps).
- Mail-send failure leaves **zero** rows in all four tables.
- Same TSV → identical finance rows and `last_modified` semantics.
- Power approve/reject → identical rows and identical email recipient list.

---

### Phase 4 — Loans

**The risk centre.** Most code, most money, most tests (33 in v1).

**Routes:** `GET|POST|PATCH /api/loan`, `GET|PATCH /api/loan/<id>`,
`POST /api/loan/<id>/<paymentProjection|refinance>`.

**Scope** (from `services/loan.py`)
- **Rate table:** `≤6 → 0.015`, `7–12 → 0.020`, `13–24 → 0.022`, `25–36 → 0.025` monthly.
  `timelimit > 36` **clamped to 36** silently, before the rate lookup. Commit `a45c343`
  changed this recently — port the *current* table.
- **Quota check** on create: reject if `value > available_quota`, **unless** `refinance=True`.
- On create: always web-push to roles `[0, 2]`, target `/loan/<id>`.
- **Approval (`state → 1`)**, atomic: build the HTML amortization table, create `LoanDetail`,
  set `prev_loan.state = 3` if refinancing, send `CHANGE_STATE_LOAN_APPROVED` to the borrower
  with roles `[0,2]` **BCC'd**, return the serialized `LoanDetail`.
- **Denial (`state → 2`)**: `CHANGE_STATE_LOAN_DENIED`; clear `prev_loan.refinanced_loan`.
- **Payout (`state → 3`)**: remove scheduled `payment_reminder` tasks (v1's method name
  `remove_sch_notitfications` carries a typo; v2 may rename).
- **Interest math:** `((balance * rate) / 30) * days360(from, to)`.
- `payment_projection(loan_id, to_date)`.
- `refinance_loan`: **own APPROVED loan only**; new value = `capital_balance` (+ interests if
  `includeInterests`), `payment = 2` (REFINANCED), links both directions.
- **`bulk_update_loans`** (PATCH, multipart TSV), atomic: upsert each `LoanDetail`, schedule
  **two** `payment_reminder` notifications per loan (T−5d, T−1d), then **auto-close any
  still-APPROVED loan whose id was absent from the file**. Highest-consequence implicit rule
  in the codebase — a malformed upload closes real loans.
- Listing: `page`, `state` (0–4, **4 = all**), `all_loans` (roles ≤ 2 only), `paginate`.
  Order `-created_at, -id`.
- ⚠️ **`timelimit` has no lower bound.** `timelimit = 0` is accepted at create and then crashes
  at approval with a `DivisionByZero` in `__generate_table`. Add validation (§5 D4).

**Risks**
- ⚠️ Rounding — compounds Phase 0's half-even decision over up to 36 rows.
- ⚠️ `days360` edges: last-day-of-month, the 30/31 rule, negative ranges (v1 swaps and returns
  a positive count).
- ⚠️ **Auto-close blast radius, and it is not cleanly reversible.** The candidate set is
  *every* APPROVED loan in the fund. Recovery is broken in v1: `LoanDetail.loan` is a plain
  `ForeignKey`, not `OneToOne`, so setting a wrongly-closed loan back to state 1 creates a
  **second** `LoanDetail` row, after which `LoanDetail.objects.get(loan_id=id)` raises
  `MultipleObjectsReturned` and `GET /api/loan/<id>` returns 500 **permanently**. Two sub-cases:
  a *well-formed but incomplete* file commits and closes the omitted loans; and a loan approved
  **after** the treasurer generated the file is absent by construction and gets closed.
  v2 should make `loan_id` unique on `LoanDetail` (upsert, not insert) so recovery works — §5 D6.
- Decimal `rate` (5,3) must never become a float.

**Parity criteria**
- For ≥20 loans (varying timelimit, fee type, dates spanning month/year ends): `LoanDetail`
  rows identical **field for field**, approval email HTML byte-identical.
- Same TSV → identical upserts, identical set of auto-closed ids, identical `SchedulerTask`
  rows (dates, payloads, count).
- Refinance chains: identical `prev_loan` / `refinanced_loan` linkage both directions.
- Quota rejection and the `>36` clamp match exactly.
- Pagination envelope and ordering identical, including `state=4` and out-of-range pages.

---

### Phase 5 — Activities

**Routes:** `GET|POST /api/activity/year`, `GET|POST /api/activity/year/<id_year>`,
`GET|PATCH|DELETE /api/activity/<id>`.

**Scope**
- `POST /api/activity/year` (role ≤ 1): create the **current-year** `ActivityYear` and
  **disable the previous one**.
- `POST /api/activity/year/<id_year>` (role ≤ 1): create an activity and attach **all active
  users** via `ActivityUser` (state `0 NOT_PAID`).
- `PATCH /api/activity/<id>?patch=activity|user` — two distinct update paths.
- `DELETE` (role ≤ 1).

**Risks:** low. The active-user set must match v1's definition (`is_active = true`) exactly,
and the year-rollover disable is a once-a-year path that's easy to break and hard to notice.

**Parity criteria:** identical `activityyear` / `activity` / `activityuser` row sets;
identical previous-year `enable` flip; both `patch=` modes identical.

---

### Phase 6 — Saving accounts (CAPs)

**Routes:** `GET|POST|PUT /api/saving-account` (GET/POST role ≤ 3, PUT `[0,2]`).

**Scope**
- Create, list (`state` 0–1, `all_accounts` for privileged, `paginate`), `PUT { id, state, value }`.
- `UserFinanceSerializer.total_savingaccounts` sums **active** accounts — a Phase 3 response
  field this phase's writes feed. Re-verify the Phase 3 parity report after this lands.

**Business rules — now specified by the operator (Q19–Q24), no longer inferred:**

- A CAP is a **fixed-term deposit that earns no interest and no return** (Q19). The fund only
  tracks it. Nothing accrues; there is no rate anywhere in this module.
- `value` on `PUT` is the **new total balance**, a plain replacement — not a deposit to add
  (Q21). This matches v1.
- **Only ADMIN and TREASURER may act on CAPs** (Q22); PRESIDENT is deliberately excluded
  (Q23). v1's `[0,2]` rule is correct as written — see the withdrawn D3.
- **No member notification** on close or revalue (Q22).
- **CAP balances are purely informational** (Q24): `total_savingaccounts`
  (`serializers.py:32`) is display-only and affects **neither `total_quota` nor
  `contributions`**. State this explicitly in the v2 code — it contradicts the natural reading
  and is the kind of thing a future maintainer will "fix" by accident.
- **CAPs close automatically on `end_date`** (Q20) — see **D12**. This is the one piece of new
  functionality in the phase; v1 has the `# TODO` and never built it. It requires a scheduler
  task type, which is why this phase runs **after** Phase 7.

**Risks**
- ⚠️ **v1 has no tests for this module at all.** No `test_saving_account_views.py` exists.
- ⚠️ **D12 is new functionality, so it has no v1 behavior to be parity-checked against.**
  Everything else in this phase is a port; the auto-close must be specified and tested on its
  own terms. Confirm the intended edge cases with the operator when it is built: what happens to
  a CAP whose `end_date` is already in the past when the feature ships, and whether closing is
  driven at the 10:00 or 14:00 scheduler run (or both).
- ⚠️ Still the module with **zero inherited tests** — the rules above are the spec now, so write
  the suite from them rather than from v1's behavior alone.

**Parity criteria:** identical rows on create/update; identical list envelope and filtering;
`total_savingaccounts` identical in the user finance response after each mutation.

---

### Phase 7 — Scheduler (replacing Celery beat)

> **Resequenced (v0.3): run this directly after Phase 4, before Phases 5/6.** It is the sole
> delivery path for loan payment reminders, has **zero** inherited tests, is raw-SQL hstore
> territory, and fails **silently** — `scheduler/tasks.py:scheduler` marks a task `processed`
> after `executer.run()` returns while `send_notification` swallows errors, so a failed publish
> is recorded as success. Highest ratio of consequence to coverage in the migration.

**Goal:** retire the Celery worker + beat containers.

**Scope**
- Replace `celery -A api beat` with `@nestjs/schedule` (or BullMQ on the existing Redis if
  multi-instance safety is wanted — decide in this phase).
- Cron: **10:00 and 14:00 `America/Bogota`**, matching `crontab(minute=0, hour='10,14')`.
- Loop: load today's unprocessed `SchedulerTask`s → resolve executer by `type` → run → mark
  `processed = true` → `create_repeat_instance` clones the row forward by `repeat`
  (NONE/DAILY/WEEKLY/MONTHLY/YEARLY, `relativedelta` semantics — month-end arithmetic differs
  between libraries, pin it with tests).
- `NotificationExecuter` (type 0) → `send_notification(...)`. `payload['user_ids']` is
  `json.loads`-ed out of hstore's string storage (§2).
- `schedule_notification(run_date, payload, repeat)` dedupe: **skip if an unprocessed task
  with the same `owner_id` + `type` already exists that calendar day.**
- `SchedulerTaskRepository` — raw SQL for the hstore `payload` column.

**Risks**
- ⚠️ **hstore + zero inherited coverage.** No v1 scheduler tests exist *and* this is raw-SQL
  territory. **Extra integration tests required** — this is the weakest-covered subsystem in
  the migration.
- Multi-instance v2 needs a lock or an atomic claim
  (`UPDATE … WHERE processed = false RETURNING`), or tasks run N times.
- `relativedelta` month/year arithmetic on the 29th–31st.
- ✅ *Double-execution across v1 and v2 is no longer a concern* — the hard switch means beat
  and the v2 scheduler never run against the same DB in production. **Keep them from
  overlapping in the shared dev DB** during parity testing: run one at a time.

**Parity criteria**
- Given seeded `SchedulerTask` rows, v2 produces the same SQS messages and the same set of
  repeat-clone rows (dates especially) as v1.
- Dedupe rule verified: a same-day, same-owner, same-type schedule is skipped.

---

### Phase 8 — Files and admin

**Routes:** `GET|POST /api/file` (POST role ≤ 0), `GET /api/file/<id>`, `GET /api/admin` (role ≤ 0).

**Scope**
- GCS via `@google-cloud/storage`, bucket `fonmon`, object path `<type_display>/<name lower>`.
- `save_file`: **check `blob.exists()` first — only persist the `File` row if the blob did not
  already exist.**
- `get_signed_url`: **v4** signed GET, **5-minute** expiry.
- v1's `ENVIRONMENT == 'test'` anonymous-client branch → an injected storage client.
- `GET /api/admin?type=email|notifications` — self-test send. **No v1 tests exist.**

**Risks:** low. Signed-URL version and expiry must match; `display_name` is unique.

**Parity criteria:** same upload → same object path and `file` row (and **no** duplicate row
when the blob already exists); signed URLs valid, v4, 5-minute expiry.

---

### Phase 9 — Cutover, hstore→jsonb, decommission

**The user performs the cutover.** This phase delivers the runbook and the post-switch
migrations.

**Runbook (for the user)**
1. Freeze writes to v1.
2. Stop v1 containers: `api`, `worker`, `scheduler`, `sch_work` (`scripts/run-server.sh`).
3. Deploy v2; point DNS/proxy at it.
4. Smoke-test the Phase 1 role matrix and one loan approval end to end.
5. Rollback = re-point at v1, **valid only until step 6 runs.**

**After the switch — v2 owns the schema**
6. **hstore → jsonb migration** (v2's first owned schema change; Q7). Two columns:
   `notificationsubscriptions.subscription`, `schedulertask.payload`.
   - `ALTER COLUMN … TYPE jsonb USING hstore_to_jsonb(…)`, **plus a data-repair pass** — the
     doubly-stringified values (`user_ids`, the push-subscription `keys` object) come out as
     JSON strings containing JSON and must be unwrapped. Not a one-liner.
   - Then delete the hstore codec, drop the two raw-SQL repositories to normal Prisma models,
     and simplify Phases 2 and 7. **This is the payoff for choosing Prisma — do not skip it.**
   - ⚠️ **One-way door:** Django's `HStoreField` breaks the instant this runs. Rollback to v1
     is dead after step 6. Take a backup first.

**Post-migration cleanup backlog** (not during the migration)
- `refinanced_loan` from a bare BigInteger to a real FK.
- DRF token → JWT.
- `CORS_ORIGIN_ALLOW_ALL = True` → an allowlist.
- Django pbkdf2 hashes → argon2, rehash-on-login.

**Archive v1:** keep CONTEXT.md, the Django migrations, and the test suite as the historical spec.

---

## 4. Cross-cutting parity rules

Verified in every phase's parity report, not just the phase that introduces them.

1. **Response shape.** Pagination is always `{ list, num_pages, count }`; a page beyond the
   last returns an **empty list, same envelope, HTTP 200**. **v1's *view*-level errors** are
   `{ message: "<string>" }` with v1's exact strings, in Spanish where v1 is Spanish — but
   **DRF's *framework*-level errors are `{"detail": …}`**, and that includes **405**, not just
   401/403. Two different envelopes; see `docs/phase-1-drf-auth-bodies.md`.
2. **Status codes.** v1's specific choices (`406`, `409` where a modern API would use `400`
   or `422`) are **preserved**. Do not modernize.
3. **Default deny.** Any route without an explicit role rule is denied.
4. **Money is integer whole units.** No floats on a money path. Rounding uses the Phase 0
   half-even helper.
5. **Timestamps.** `auto_now` / `auto_now_add` are application-set in v1, not DB defaults — v2
   must set them. ✅ **RESOLVED (v0.14) — the answer is Bogotá, and it was worth checking.**
   Django 2.2's `DateTimeField.pre_save` uses `timezone.now()` (a tz-aware instant), while
   **`DateField.pre_save` uses `datetime.date.today()`** — process-local, ignoring
   `settings.TIME_ZONE`. v0.12 inferred from that "so v1 probably writes UTC dates". It does
   not: `django/conf/__init__.py::Settings.__init__` ends with
   `os.environ['TZ'] = self.TIME_ZONE; time.tzset()`, so Django *makes* the process zone equal
   the setting. Verified on `Django==2.2.27` / CPython 3.9 with the container `TZ` unset (host
   zone UTC) at `2026-08-31T00:09Z` = `2026-08-30 19:09` Bogotá: `date.today()` returns
   `2026-08-31` before `django.setup()` and **`2026-08-30` after it**.
   **So `UserFinance.last_modified` and `LoanDetail.from_date` hold Bogotá dates, there are no
   next-day rows to reconcile, and the escalation to `business-analyst` is withdrawn.** v2 pins
   the zone explicitly in `todayForAutoNowDateField()` (`timezone.util.ts`) rather than
   inheriting it from the host, and uses `nowInstant()` for the `DateTimeField` half.
   ⚠️ Residual, recorded rather than guessed: v1's repo has no Dockerfile (the image is built
   by an out-of-repo `entrypoint_deploy` on the EC2 host), so the base image cannot be read
   from source. The result above holds for any image shipping tzdata — `python:3.9-slim` and
   `python:3.9-alpine` both do, both verified. Strip `/usr/share/zoneinfo` and `tzset()` cannot
   resolve the zone, Django does not raise, and `date.today()` silently falls back to UTC (also
   verified). That is the only scenario in which v1's stored dates are UTC.
5b. **Money is `BigInt` in Prisma — 17 columns — and `JSON.stringify(1n)` throws.** ✅ **Settled
   (v0.14):** a BigInt serialises as a **bare JSON number**, matching DRF's
   `IntegerField.to_representation`, via Express's `json replacer`
   (`src/common/http/json-bigint.ts`, installed by an `AppModule` provider). The reflex fix
   (`BigInt.prototype.toJSON = toString`) renders `"1000"` and is **wrong**. A value outside
   ±(2^53 − 1) throws rather than rounding. Do not re-litigate per DTO in Phase 3.
5c. **Date formatting is not uniform in v1 — do not assume it is.** `LoanSerializer.get_created_at`
   calls `timezone.localtime` first (`serializers.py:88`); `UserFinanceSerializer.get_last_modified`
   does not (`:29`). A `formatDateEs()` that silently reads a `DateTime` as UTC is correct for
   `@db.Date` and wrong for `timestamptz`, and the type system does not distinguish them — so it
   yields the **next day's date for ~21% of every day**, passing in CI and failing in production
   against the byte-identical email criteria. ✅ **Done (v0.14):** `formatDateEs` accepts only a
   `PlainDate`, and the call site must choose `fromDateColumn(v)` (`@db.Date`) or
   `toBogotaDate(v)` (`timestamptz`). A `Date` is a compile error.
6. **Shared DB is a dev/parity concern only** (production is a hard switch). During parity
   testing v2 runs **no** schema migrations, and only one scheduler runs at a time.
7. **hstore values are strings.** Never write a native JSON object into an hstore column —
   until Phase 9 converts them.
8. **Side effects count as parity.** A phase passes only when DB rows, SES payloads, SQS
   messages, and `SchedulerTask` rows all match — not just the HTTP response.
9. **Idempotent under retry** where v1 was: subscription dedupe, blob-exists check, scheduler
   same-day dedupe.
10. ⚠️ **Django's `on_delete=CASCADE` is Python-side, not a DB cascade.** Verified: all 21 FKs in
    `fondodev` are `NO ACTION`. Reading `models.py` strongly suggests the opposite. **Phases 3–8
    must delete children explicitly inside the transaction** or hard deletes raise FK violations.
    The live case is `DELETE /api/activity/<id>` (Phase 5), which must remove `ActivityUser` rows
    first. Most other v1 deletes are soft (`is_active = false`), which masks this.
12. ⚠️ **Nest 404s where DRF 405s.** Django resolves the URL and *then* DRF raises
    `MethodNotAllowed`; Express has no route for an unmapped method at all. **Every controller in
    Phases 3–8 needs an `@All()` fallback** (`DrfException.methodNotAllowed()` is the reusable
    piece) or it will 404 where v1 405s. Note the `Allow` header lists *implemented* handlers — a
    different set from *permitted* ones.
13. **`OPTIONS` on a guarded v1 view is authenticated and permission-checked**, and returns DRF's
    browsable-API metadata document when allowed. Registered as deviation P1-D2.
11. ⚠️ **All 21 FKs are `DEFERRABLE INITIALLY DEFERRED`** and Prisma cannot express it; the
    baseline SQL is hand-patched. Keep the patch on any future baseline regeneration — without it
    CI databases enforce FKs at statement time while production enforces at commit, so multi-table
    writes that pass locally fail in CI (or vice versa).

---

## 5. Deliberate deviations from v1 (the port-or-fix register)

**Why this section exists.** The parity contract in §4 says v1's behavior is the spec. Taken
literally that is wrong: the business-analyst review found authorization holes in v1 that a
faithful port would carry into a fresh codebase and re-bless as "correct". Every knowing
departure from v1 is registered here so that `manual-tester` reads a diff as **expected**, not
as a parity failure — an unregistered diff is still a failure.

**Each row needs a user decision before its phase can close.** My recommendation is in the last
column; none of these are mine to decide unilaterally, because each changes product behavior.

| # | v1 behavior | Change in v2 | Phase | Status |
|---|---|---|---|---|
| **D1** | `PATCH /api/user/<id>` is role ≤ 3 with **no ownership check**, and `__update_user_personal` writes `user.role` from the request body (`services/user.py:232`) — any member can make themselves ADMIN or set their own `total_quota`. | **Restrict** (Q15, Q25, Q25a). Rule below. | P1 decide / P3 implement | ✅ **Decided — fix** |
| **D2** | Approving a power request has no check that the caller is the requestee. | **Restrict** to the requestee (Q17). | P3 | ✅ **Decided — fix** |
| ~~**D3**~~ | ~~`SavingAccountView.PUT` is `[0,2]` with no ownership check; PRESIDENT uniquely excluded.~~ | **Withdrawn — v1 is correct.** Only ADMIN and TREASURER may act on CAPs and they legitimately manage any member's (Q22), so no ownership check is wanted; the PRESIDENT exclusion is **deliberate** (Q23). Port v1 unchanged. | P6 | ✅ **Withdrawn** |
| **D4** | `timelimit > 36` silently clamped to 36; `timelimit = 0` accepted, then `DivisionByZero` at approval. | **Reject with `400`** (Q9) — both bounds. Enforce `1 ≤ timelimit ≤ 36`; no silent clamp. | P4 | ✅ **Decided — fix** |
| **D5** | Power-approval email puts every member in `ToAddresses` with empty `Bcc`. | **Move to `Bcc`** (Q18). Recipient list stays every member (Q10) — only the disclosure is fixed. | P3 | ✅ **Decided — fix** |
| **D6** | `LoanDetail.loan` is a plain FK; re-approving a closed loan creates a second row and 500s that loan permanently. | Unique `loan_id`, upsert not insert. Now **belt-and-braces** behind D10, which blocks the transition at the source. | P4 | ✅ **Decided — fix** |
| **D7** | A payment reminder whose `run_date` has passed is **never sent** — the 5-day reminder is skipped entirely whenever the monthly file lands within 5 days of the deadline. | **Send immediately** on the next scheduler run instead of skipping (Q8). | P7 | ✅ **Decided — change** |
| **D8** | Bulk loan upload returns a bare `200` with no body. | **Return the list of auto-closed loans.** No cap on how many may be closed (Q3). ⚠️ Response-shape change — `manual-tester` must expect it. | P4 | ✅ **Decided — change** |
| **D9** | Re-approving an already-approved or closed loan is allowed and corrupts the record. | **Enforce legal state transitions** `0→1`, `0→2`, `1→3`, `1→2`; reject anything else (Q14). | P4 | ✅ **Decided — fix** |
| **D18** | Request-parsing divergences found in Phase 1 review: `text/plain` → v1 **415**, v2 400. `multipart/form-data` → v1 **200**, v2 400. Malformed JSON → v1 `{"detail":"JSON parse error - …"}`, v2 Node's message. | ✅ **Fixed, all three — no deviation taken.** v2 owns request parsing (`DrfRequestParsingMiddleware` + `DrfParserInterceptor`, `bodyParser: false`): multipart parses, an unsupported media type is DRF's **415**, and a malformed JSON body returns CPython's own message and character offset (`python-json.ts`, differentially validated against CPython 3.9 over 412 structured + 3 000 fuzz cases, 0 mismatches). Parsing is deferred until **after** the guards, so DRF's authenticate-then-parse ordering is preserved. Three residuals registered in `docs/phase-1-drf-auth-bodies.md`, none client-visible. | P1 | ✅ **Fixed** |
| **D14** | `PATCH /api/user/-1` and `DELETE /api/user/-1` pass `-1` through and 404; only `GET` substitutes `request.user.id`. | **Split by verb** (BA). GET keeps "me". PATCH **adopts** "me" — v1 404s unconditionally, so no working client can depend on it; the change is inert but stops telling a member they don't exist. DELETE **rejects the sentinel**: `fondodev` has exactly **one** ADMIN, and self-soft-delete is unrecoverable through the API (`key_activation` is null for all 15 users, so `activate_user` can never restore them). | P3 | ✅ **Decided — fix** |
| **D15** | `__update_user_personal` does `user.username = obj['email']`, rotating the name the member logs in with. | **Stop writing `username` on personal updates.** Login names become stable. See the runbook item below — the live behavior is *worse and narrower* than "silent rename". | P3 | ✅ **Decided — fix** |
| **D16** | `identification` is writable by any caller on a `personal` update. | **Make it ADMIN-only.** It is the join key of the treasurer's monthly TSV and a miss is only logged (`services/user.py:144`), so a member editing their own cédula **silently freezes their own contributions and quota** until someone notices. ⏳ **Needs operator confirmation.** | P3 | ⏳ **Open** |
| **D17** | `get_user_by_email` (`services/user.py:84`) uses `.get()` inside a bare `except`, so a duplicated email raises `MultipleObjectsReturned` → returns `None` → **no reset email is sent**, while `PasswordResetView` still redirects to the success page. | **Verified live: users 7, 10, 13 and 14 — 4 of 15 members — cannot reset their password and are told it worked.** v2 must handle multiplicity deliberately. ⏳ **Needs operator input** on the rule: reset the account whose `username` equals the email, refuse ambiguous addresses, or something else. | P3 | ⏳ **Open** |
| **D13** | An unknown URL returns Django's **HTML** 404 page (`<h1>Not Found</h1>…`), not JSON. | v2 returns JSON `{message: …}`. Pre-existing since Phase 0 but was unregistered — `manual-tester` would otherwise file it. Accepted: no client depends on an HTML 404. | P0 | ✅ **Accepted** |
| **D12** | CAP auto-close was never implemented — `services/saving_account.py` carries a `# TODO: schedule task for closing CAP`. Closing is manual-only today. | **Implement it** (Q20): a CAP closes automatically on `end_date`. New functionality, not a port. Needs a `SchedulerTask` type — **so Phase 6 depends on Phase 7** (already sequenced that way). No member notification (Q22). | P6 | ✅ **Decided — build** |
| **D11** | `UserFinance.user` and `UserPreference.user` are plain FKs, not OneToOne — the same latent defect registered as D6 for `LoanDetail`. A duplicate row makes the user's finance endpoints 500 permanently. | Unique constraint on `user_id` for both; upsert not insert. | P3 | ⏳ **Needs decision** |
| **D10** | Loan read (`GET /api/loan/<id>`, `paymentProjection`) is open to any member by id. | **Restrict** to the loan owner plus roles `[0,1,2]` (Q16). | P4 | ✅ **Decided — fix** |

### D1 — the authorization rule for `PATCH /api/user/<id>`

**Principle: universal self-service, with privileges added on top.** Every role may edit its own
`personal` (excluding `role`) and `preferences`. Elevated rights are additive:

| Role | Own profile | Other users | `role` field | `finance` section |
|---|---|---|---|---|
| **0 ADMIN** | ✅ | ✅ any user, any section | ✅ **only ADMIN** | ✅ any user |
| **1 PRESIDENT** | ✅ personal + preferences | ❌ | ❌ | ❌ |
| **2 TREASURER** | ✅ personal + preferences | `finance` only | ❌ | ✅ any user |
| **3 MEMBER** | ✅ personal + preferences | ❌ | ❌ | ❌ |

- PRESIDENT gets **no elevated rights** here (Q25) but keeps self-service (Q25a) — the literal
  reading would have made role 1 less capable than role 3.
- ⚠️ **Inference, flagged:** Q15 said "treasurer only can modify finance information." Applying
  the same principle that resolved Q25a, TREASURER **also keeps self-service** on their own
  personal + preferences. Without that they could not change their own email address. Say so if
  that is wrong — it is the one cell in this table the operator did not state directly.
- `role` is writable by ADMIN alone, on any user. This is the escalation path being closed.
- A `finance` write by a non-privileged caller is **403**, not a silent no-op.

**Two clarifications that each would otherwise break every ordinary member save** (BA, `docs/ba-phase-3-decisions.md`):

1. ✅ **The `role` check compares values, it does not check presence.** v1's client echoes the
   whole `personal` object back from `GET /api/user/<id>` — which includes `role` — so a
   "`role` key present and caller is not ADMIN → 403" reading would 403 **every save by all 14
   non-admin members**: 100% false positives, a signal nobody would keep. Compare the submitted
   value against the stored one and 403 only on an actual **change**. A 403 then means a real
   escalation attempt and is worth logging. Accepted side effect: a stale client submitting an
   out-of-date `role` gets a 403 — correct, since the alternative is silently demoting a freshly
   elected treasurer.
2. ✅ **Authorization keys off `body.type`, not off which sections are present.** `update_user`
   dispatches on `obj['type']` (`services/user.py:100`) and ignores the rest. Every v1 test
   fixture posts `personal` **and** `finance` in the same body, so a presence-based finance check
   would 403 every member profile save. Gate on the declared `type`.

**Explicitly confirmed as intended — port faithfully, do not "fix":**

- **Loan auto-close is a real business rule** (Q1) — absent from the monthly TSV means paid off.
  It stays **silent**: no email, no push. And no guard against closing a loan approved after the
  file was generated (Q2) — the operator accepted that risk.
- **Rate frozen at request time** (Q4), so a loan awaiting approval across a rate change is
  approved at the old rate.
- **Quota comes exclusively from the treasurer's monthly file** (Q12, reconfirmed). Loans do **not** increment
  `utilized_quota` on create or approval. ⚠️ Known and accepted consequence: a member can open
  several loans between uploads that together exceed their quota.
- **Multiple concurrent refinance requests against one loan stay allowed** (Q5), including the
  broken linkage that follows.
- **Payment reminders are best-effort** (Q6, reconfirmed) — a failed publish is marked processed and lost, with
  no retry on the next scheduler run. *Note: the in-call bounded retry (Phase 2, condition 1) is a
  different mechanism and is still planned — say so if you want that dropped too.*
- **Push only; no email fallback for reminders** (Q7). Members without a browser subscription
  receive no payment reminders — accepted.
- Also unchanged: the deny-on-lookup-miss permission fallthrough; the `406`/`409` status choices;
  the pagination envelope; the rate table itself; "attach all active users"; and CAP-balance /
  quota independence.

---

## 6. Test porting

v1 has **104 test methods** across 8 files (the 20 Alexa tests are dropped):

| v1 file | Tests | v2 destination |
|---|---|---|
| `test_date_utils.py` | 2 | Phase 0 |
| `test_models.py` | 8 | Phase 0 (model round-trip) |
| `test_mail_service.py` | 6 | Phase 2 |
| `test_notification_views.py` | 4 | Phase 2 ⚠️ thin |
| `test_user_views.py` | 31 | Phase 3 |
| `test_loan_views.py` | 33 | Phase 4 |
| `test_activity_views.py` | 12 | Phase 5 |
| `test_file_views.py` | 8 | Phase 8 |
| — | **0** | **Phase 6 (saving accounts), Phase 7 (scheduler), admin endpoint** |

- `AbstractTest` helpers (`create_user`, `create_basic_users`, `get_token`, `get_auth_header`)
  become a shared e2e fixture module.
- **3 methods are prefixed `pending_test_`** (2 in `test_models.py`, 1 in
  `test_notification_views.py`) and never run in v1. Read them for intent, then decide per
  case whether to revive or drop — do not silently port them as passing tests.
- v1 mocks external I/O at the boundary (`@patch('boto3.client')`) and asserts full SES
  payloads. Keep that shape: mock the AWS/GCS SDK clients, assert the whole payload.
- ⚠️ **Coverage debt concentrates in Phases 6 and 7** — and Phase 7 is also raw-SQL hstore
  territory. Budget extra time for both.

---

## 7. Phase gate checklist

A phase closes only when all four are green. Any ✗ re-opens the phase and revises this plan.

| # | Owner | Criterion |
|---|---|---|
| 1 | `nestjs-developer` | Endpoints, services, DTOs implemented; unit + integration tests ported and green; lint and typecheck clean. |
| 2 | `manual-tester` | Parity report **PASS** against v1 on the shared dev DB — responses, status codes, DB side effects, SES/SQS payloads, scheduler rows. |
| 3 | `nestjs-reviewer` | Code review approved, **and** the parity report reviewed for missing business scenarios. Also enforces the §2 rule that hstore raw SQL stays inside the two repositories. **Standing requirement — see below.** |
| 4 | `business-analyst` | Phase alignment note = **Aligned**. |
| 5 | *user* | Every §5 deviation owned by this phase is **decided** (port or fix) and recorded. An undecided deviation blocks the gate; an unregistered behavioral diff is a parity **failure**. |

### The review gate is standing, not optional

**Every phase ends with a `nestjs-reviewer` pass.** No phase closes without one, including phases
that look mechanical. The reviewer:

- writes `docs/review-phase-<n>.md`, findings ordered blocking / should-fix / consider, each with
  `file:line`, what is wrong, why it matters, and what to do;
- ends with an explicit verdict: **Approved**, **Approved-with-conditions**, or
  **Changes-required**;
- reviews the `manual-tester` parity report as well as the code, looking for business scenarios
  missing from both;
- enforces §2's rule that raw SQL touching `hstore` appears **only** inside
  `NotificationSubscriptionRepository` and `SchedulerTaskRepository`.

A **Changes-required** verdict re-opens the phase. Conditions attached to an
**Approved-with-conditions** verdict are tracked to closure before the next phase's gate, not
silently carried forward.

Rationale: the two corrections that mattered most so far — the `username != email` lockout and
the Babel four-digit grouping — were both cases where a plausible-looking assumption survived
until someone read the source or the live data. That is exactly what a review pass is for, and it
is cheapest at the end of the phase that introduced it.

### Open review conditions

Tracked to closure, not carried forward silently. Source:
[`docs/review-phase-0-1.md`](docs/review-phase-0-1.md).

| # | Condition | From | Status |
|---|---|---|---|
| C1 | `formatDateEs()` must distinguish `@db.Date` from `timestamptz` at the type level (rule 5c). | P0 · S1 | ✅ **Closed** (`114d8cf`). Signature narrowed to `PlainDate`; `fromDateColumn` / `toBogotaDate` are the two named conversions; a `Date` is a compile error *and* a runtime `TypeError`. Test pins `28 mar.` vs `29 mar.` for the same instant. |
| C2 | Global BigInt→JSON strategy rendering bare numbers, not strings (rule 5b). | P0 · S2 | ✅ **Closed** (`43759e8`). Express `json replacer` installed by an `AppModule` provider; bigint → **number**, `BigIntPrecisionError` above 2^53 rather than silent loss. Unit + e2e on the raw response text. Recorded in `docs/phase-0-deviations.md` §2.10. |
| C3 | Add a `relativedelta` month-end primitive. **Phase 3's birthday task needs it, long before Phase 7 runs.** | P0 · plan gap | ✅ **Closed** (`a98c732`). `relativedelta.util.ts` + `nextRepeatRunDate`; 104 tests, every value captured from `python-dateutil==2.7.5` on CPython 3.9. Pins two v1 behaviours: a MONTHLY chain from the 31st collapses to the 28th forever, and a leap-day YEARLY task loses 29 February. |
| C4 | Verify the deployed container's `TZ` and record whether v1's `DateField` dates are UTC or Bogotá (rule 5). | P0 · S6 | ✅ **Closed** (`42eed47`). **Bogotá.** `Settings.__init__` does `os.environ['TZ'] = TIME_ZONE; time.tzset()`, verified live at 19:09 Bogotá with the host zone UTC. `todayForAutoNowDateField()` / `nowInstant()` pin each half. Escalation withdrawn; one residual recorded (v1 has no Dockerfile in-repo; conclusion holds for any image shipping tzdata, slim and alpine both verified). |
| C5 | Fix multipart and malformed-JSON request parsing to match v1 (**D18**). | P1 · S3 | ✅ **Closed** (`59700ff`). All three rows fixed, none deviated: multipart parses, unsupported media types 415 with DRF's wording, malformed JSON returns **CPython's** message and offset (`python-json.ts`, 412 structured + 3 000 fuzz cases differentially validated, 0 mismatches). Parsing deferred until after the guards, preserving DRF's authenticate-then-parse order. |
| C6 | `userPatchAllowlist` builds its allowlist from `attempt.fields`, making the "positive allowlist" a tautology. | P1 · S4 | ✅ **Closed** (`9638d2e`). Three frozen field sets transcribed from `services/user.py:208-261`; the allowlist no longer reads the payload. `identification` (D16) is parameterised and tested both ways, awaiting Q26. |
| C7 | `FieldAllowlist.none().assert([])` does not throw. | P1 · S5 | ✅ **Closed** (`5988ac0`). An empty allowlist denies any write including the empty one; a non-empty allowlist still accepts an empty change-set. |
| C8 | The `body.type` gate vs the `changedFields` gate. | P1 · escalated | ✅ **Closed** (`e4c9985`). `resolveSection` + `assertSectionWritable` + the field allowlist, applied in that order; `changedFields` normalises `bigint`/`number`, `Date`/`'YYYY-MM-DD'` and numeric strings so rule 3 cannot fire on an echo. Resolution text below unchanged. |

| C9 | **S7 — detail-route trailing slashes.** `GET /api/loan/5/` is a Django **404** (v1's detail regexes have no `/?`), but Express's non-strict routing serves it. Note the asymmetry: v1's *collection* routes **do** carry `/?` (`^api/loan/?$`), so only detail routes diverge. | P1 · S7 | ⬜ **Open** — my transcription miss, not the developer's. Needs a §4 rule or an accepted deviation **before Phases 3–8 add detail routes**. |

*(C9 was raised in the first review's Phase 1 gate and lost when I transcribed the conditions
into this table. `nestjs-developer` correctly flagged it rather than acting outside its brief.)*

### C8 resolved — the two rules operate at different levels

They are not in conflict once ordered. `update_user` (`services/user.py:100`) dispatches on
`obj['type']` and **ignores every other section in the body**. So:

1. **`body.type` gates the section.** If `type == 'finance'` and the caller is neither ADMIN nor
   TREASURER → **403**, whether the `finance` object is empty, unchanged, or absent. The declared
   intent is what is refused, not the diff.
2. **A section the caller did not declare is irrelevant.** With `type == 'personal'`, a `finance`
   key in the body is ignored by v1 and must be ignored by v2 — never a 403. This is what makes
   every member's ordinary save work, since v1's client posts both sections every time.
3. **`changedFields` gates privileged *fields within* the dispatched section** — `role` (D1) and
   `identification` (D16, pending Q26). 403 only on an actual change, so echoing an unchanged
   value is fine.

Level 1 answers "may you touch this section at all", level 3 answers "may you change this field".
The reviewer's empty-`finance` case is therefore a **403** — it is a declared finance write by an
unprivileged caller — and C7's silent no-op cannot arise, because the refusal happens at the type
gate before any field comparison. `FieldAllowlist.assert()` must still fail closed on an empty
set, as defence in depth rather than as the primary control.

**Phase status board**

| Phase | Status | Dev | Tester | Reviewer | Analyst |
|---|---|---|---|---|---|
| — Prereq: dev DB at 0019 | ✅ **Cleared** | — | — | — | — |
| 0 Foundations & Prisma baseline | ✅ **CLOSED** (`b3effab` + C1–C4) | ✅ | n/a | ✅ **APPROVED** | n/a |
| 1 Auth + roles | ✅ **CLOSED** (`151314f` + C1–C8) | ✅ | ⬜ | ✅ **APPROVED** | ⬜ |
| 2 Mail + notifications | 🔨 **In progress** | 🔨 | ⬜ | ⬜ | ⬜ |
| 3 Users + finance | ⬜ Blocked on P2 | — | — | — | — |
| 4 Loans | ⬜ Blocked on P3 | — | — | — | — |
| 7 Scheduler *(resequenced)* | ⬜ Blocked on P4 | — | — | — | — |
| 5 Activities | ⬜ Blocked on P3 | — | — | — | — |
| 6 Saving accounts | 🔴 **Blocked on Q19–Q24** — no spec to port | — | — | — | — |
| 8 Files + admin | ⬜ Blocked on P2 | — | — | — | — |
| 9 Cutover | ⬜ Blocked on P8 | — | — | — | — |

---

## 8. CI/CD (reuse the existing shape)

Adapt `buildspec.yml` rather than replacing it:

| Phase | v1 | v2 |
|---|---|---|
| `install` | Python 3.9, `pip install -r requirements.txt` | **Node 24**, `npm ci` |
| `pre_build` | `CREATE EXTENSION hstore`, `manage.py migrate` | `CREATE EXTENSION hstore` (until Phase 9), `prisma migrate deploy` |
| `build` | `coverage run manage.py test` — the suite is the gate | `npm run lint && npm run typecheck && npm test && npm run test:e2e` |
| `post_build` | `scripts/trigger-deploy.sh` → SSM → EC2 | unchanged |

- Keep the SSM deploy trigger and its `master`-branch-and-PUSH-only guard.
- Keep the `run-server.sh` container-role pattern; `worker` and `scheduler` roles collapse
  into the v2 app (or a single scheduler process) at Phase 7.
- v1 has **no lint step**. v2 adds lint + typecheck to the gate.

---

## 9. business-analyst review outcome & operator decisions

Full note: [`docs/ba-review-v0.2.md`](docs/ba-review-v0.2.md). BA verdict: **Concerns** — resolved
by the §5 register. Operator answered 13 of 24 questions on 2026-08-30.

### Answered — folded in

| Q | Topic | Answer | Effect |
|---|---|---|---|
| Q1 | Loan auto-close intent | Intended; no notification needed | Port as-is, silent |
| Q2 | Guard against post-file approvals | No, keep v1 | No guard |
| Q3 | Return closed-loan list / cap the count | Return the list; **no cap** | **D8** |
| Q4 | Rate frozen at request | Yes | Confirms v1 |
| Q5 | Concurrent refinance requests | Keep v1 | Port broken linkage |
| Q6 | Retry failed reminders next run | Keep v1 (best-effort) | No cross-run retry |
| Q7 | Email fallback for reminders | No — push only | Gap accepted |
| Q8 | Past-dated reminder | **Send immediately** | **D7** |
| Q9 | Term outside 1–36 | **Reject `400`** | **D4** |
| Q12 | Quota source | Treasurer's file only | Confirms v1; over-quota gap accepted |
| Q14 | Legal state transitions | **Enforce** | **D9** |
| Q15 | `PATCH /api/user/<id>` | **Restrict** — admin: all; treasurer: finance only | **D1** |
| Q16 | Loan read by id | **Restrict** to owner + `[0,1,2]` | **D10** |
| Q17 | Power approval | **Restrict** to requestee | **D2** |
| Q13 | Alexa users | Moot — skill retired | Closed |

### Answered 2026-08-30 (second round)

| Q | Topic | Answer | Effect |
|---|---|---|---|
| Q10 | Power letter recipients | **All members** | Confirms v1 |
| Q13 | Alexa users | None — safe to remove | Closed |
| Q18 | `To:` → `Bcc:` | **Yes** | **D5** decided |
| Q19 | What a CAP is | Fixed-term deposit, **no interest or earnings** | P6 spec |
| Q20 | When a CAP closes | **Automatically on `end_date`** | **D12** — new build |
| Q21 | `value` on `PUT` | New total balance | Confirms v1 |
| Q22 | Who may act on CAPs | **ADMIN + TREASURER only**, no notifications | Confirms v1; **D3 withdrawn** |
| Q23 | PRESIDENT and CAPs | **Not allowed** — deliberate | **D3 withdrawn** |
| Q24 | CAP ↔ quota | Purely informative | Confirms v1 |
| Q25 | PRESIDENT and `PATCH /api/user` | Not allowed — ⚠️ *scope being confirmed* | **D1** |

### Still open

| Q | Topic | Blocks |
|---|---|---|
| **Q26** | **D16** — should `identification` be ADMIN-only? It is the join key of the treasurer's monthly TSV; a member editing their own cédula silently freezes their contributions and quota. Recommend yes. | P3 |
| **Q27** | **D17** — when two members share an email, who gets the password-reset link? Reset the account whose `username` equals the email, refuse ambiguous addresses, or something else? | P3 |

Q1–Q25 are answered; **Q26 and Q27 are open** and block Phase 3. The only open *inference* is the
TREASURER self-service cell in the D1 table (§5), flagged there.

### Runbook items carried from Phase 3 findings

1. **Do not edit the profiles of user 13 (`sebastian.montanez`) or 14 (`ainhoa.montanez`) in
   frozen v1.** Any personal edit 409s (shared email + UNIQUE username). Reconcile or formally
   record those two rows before cutover — deciding whether a child member gets their own email
   address, or whether the fund keeps a parent's address with a distinct username. Telling the
   members is not sufficient: Ainhoa is five.
2. **Four members cannot reset their password** (D17: ids 7, 10, 13, 14) and are shown the
   success page. Until D17 ships in v2, those resets have to be done manually. Worth telling the
   treasurer now rather than at cutover.

### Cutover timing — corrected (Q11)

The operator pushed back on the calendar constraint, and re-reading the code they are **mostly
right**. Correcting the earlier guidance:

- ❌ **Withdrawn: "never cut over near a year boundary."** `ActivityService.create_year` is not
  automatic — it fires only on an explicit `POST /api/activity/year` (role ≤ 1). It reads
  `date.today().year`, disables the most recent other year, and is guarded by a unique
  constraint. The real caveat is much smaller: **there is no re-enable path through the API**, so
  if someone presses the year-rollover button mid-cutover and it goes wrong, fixing it needs
  manual SQL. That is "don't press that button during the switch", not a blackout window.
- ✅ **Kept, and it is the one that matters: cut over shortly after a verified monthly bulk
  upload.** Not for data-safety reasons — for **runway**. The bulk TSV upload is the riskiest
  operation in the system (fund-wide auto-close, D8/D9). Cutting over just after a good upload
  puts roughly a month between the switch and the first time v2 runs that path for real, which
  is time to rehearse it against a copy. Cutting over the day before an upload means v2's most
  dangerous code path runs in production before anyone has watched it work.
- ℹ️ **Minor:** password-reset links issued by v1 stop working at the switch (D-note, Phase 3).
  Django's default timeout is 3 days, so at worst a few members re-request.
- ℹ️ Scheduled `SchedulerTask` rows are **data in the shared DB**, not in-flight process state, so
  v2 picks up pending payment reminders across the switch with no special handling.

**Net: you can cut over on any date.** Prefer the week after a monthly upload; avoid running the
year rollover during the switch itself.

---

## 10. Phase 0 outcome — toolchain notes

Phase 0 complete on `feat/phase-0-foundations` (`b3effab`), not pushed. Gate verified
independently: lint clean, typecheck clean, **262 unit tests / 8 suites**, 19 e2e / 2 suites,
every table round-trips, and `migrate diff` is empty **in both directions**. v1 confirmed
untouched.

**Prisma baseline:** `prisma/migrations/0_init` recorded with `applied_steps_count = 0` —
marked applied, never executed. Verified against `fondodev`.

Pin these; they cost real time to rediscover:

| Item | Fact |
|---|---|
| **Prisma version** | **Pinned to `7.10.0`.** `npm i prisma@latest` installs `8.0.0-rc.12` — npm's `latest` tag points at an RC. |
| **Prisma 7 API changes** | `datasource.url` is banned in `schema.prisma` (moved to `prisma.config.ts`; `.env` no longer auto-loaded). `migrate diff` renamed `--from-schema-datamodel`→`--from-schema` and `--from-url`→`--from-config-datasource`. `PrismaClient` requires a driver adapter. |
| **NestJS 12 is ESM-only** | Jest needs `NODE_OPTIONS=--experimental-vm-modules` (wired into the npm scripts). Running `npx jest` directly fails with a confusing error. |
| **Index operator classes** | `prisma db pull` does not read them back; declaring them in the schema creates permanent phantom drift. Patched in SQL instead. |
| **`Loan.rate`** | Reads back as `0.02`, not `0.020` — Prisma Decimal normalises. `toFixed(3)` restores it. Matters wherever the rate is rendered. |

**Money formatting — three findings that will not resurface until they break an email:**

1. **The Babel expression rounds twice, not once.** `format_number(format_decimal(round(v,2), format='#'))` inside a `ROUND_HALF_DOWN` context makes `20.5001` render as `20`, not `21`. Confirmed against Babel 2.9.1 and pinned in tests.
2. **Four-digit grouping.** v1's locale is `LANGUAGE_LOCALE = 'es'` (not `es-CO`). Babel 2.9.1 renders `1000` as `1.000`; Node `Intl` for `es` renders `1000` — CLDR sets `minimumGroupingDigits=2` for `es`, which Babel 2.9.1 predates. **v2 follows Babel.** Independently verified. v1's tests never render a four-digit amount, so nothing in the inherited suite would have caught this — it would have surfaced as a wrong loan email the first time an amount crossed $1.000.
3. **Decimal precision.** Python's default context is `prec=28`; `decimal.js` defaults to `20`. Matters for `Decimal(loan.value)/fee`. Set explicitly.

Golden values were derived by installing Babel 2.9.1 in a scratch venv and running v1's exact
expressions — not invented. Full detail in [`docs/phase-0-deviations.md`](docs/phase-0-deviations.md).
