# Fondo-API — Django → NestJS Migration Plan

**Spec of record for v1 behavior:** `CONTEXT.md` in the v1 repo (`~/Projects/Fondo-API`).
When CONTEXT.md and the v1 source disagree, **the source wins** and CONTEXT.md gets fixed.

- **v1 (Django):** `~/Projects/Fondo-API`
- **v2 (NestJS):** `~/Projects/Fondo-API-v2` (this repo)

## Changelog

| Date | Rev | Change |
|---|---|---|
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
  `user_ptr_id`. `USERNAME_FIELD = 'email'`, but `username` is still populated (`username = email`).
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
- ⚠️ **Pin the auth-failure body before this phase closes.** DRF's 401/403 responses are
  `{"detail": …}`, **not** the `{"message": …}` shape used everywhere else — and v1 has **zero**
  tests asserting them, so the exact strings are unknown. `manual-tester` must capture the real
  401/403 bodies from v1 and add them to the criteria. The Phase 0 exception filter deliberately
  does not guess.
- **Full role matrix:** 14 view classes × each method in `list_permissions` × 4 roles →
  identical allow/deny. Plus an authenticated request to a rule-less route → 403 in both.

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

**What the source does establish** (§9.3): `create_account` sets only `end_date` + `user`, so a
CAP starts **empty and ACTIVE**; the `# TODO: schedule task for closing CAP` was never
implemented, so **closing is manual-only**; `value` on `PUT` is a **plain replacement**, not a
deposit; and `total_savingaccounts` (`serializers.py:32`) is **display-only — CAP balances do
not affect loan quota at all** (the only writers of the quota fields are in `services/user.py`).
That last point contradicts a natural reading and should be stated explicitly in the v2 code.

**Risks**
- ⚠️ **v1 has no tests for this module at all.** No `test_saving_account_views.py` exists.
- ⚠️ `update_account` has **no ownership check**, and the `[0,2]` rule uniquely **excludes the
  PRESIDENT** (role 1) — the only route in the system that does. Likely unintentional; §5 D3.
- ⚠️ Cannot be parity-tested until the dev DB is migrated past 0017 (see Phase 0).

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
   last returns an **empty list, same envelope, HTTP 200**. Errors are `{ message: "<string>" }`
   with v1's exact strings, in Spanish where v1 is Spanish.
2. **Status codes.** v1's specific choices (`406`, `409` where a modern API would use `400`
   or `422`) are **preserved**. Do not modernize.
3. **Default deny.** Any route without an explicit role rule is denied.
4. **Money is integer whole units.** No floats on a money path. Rounding uses the Phase 0
   half-even helper.
5. **Timestamps.** `auto_now` / `auto_now_add` are application-set in v1, not DB defaults —
   v2 must set them, in `America/Bogota` semantics.
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
| **D1** | `PATCH /api/user/<id>` is role ≤ 3 with **no ownership check**, and `__update_user_personal` writes `user.role` from the request body (`services/user.py:232`) — any member can make themselves ADMIN or set their own `total_quota`. | **Restrict** (Q15). ADMIN → any user, any section. TREASURER → `finance` section only, any user. MEMBER → **self only**, `personal` (excluding `role`) + `preferences`; never `finance`. `role` is writable by ADMIN alone. | P1 | ✅ **Decided — fix** |
| **D2** | Approving a power request has no check that the caller is the requestee. | **Restrict** to the requestee (Q17). | P3 | ✅ **Decided — fix** |
| **D3** | `SavingAccountView.PUT` is `[0,2]` with no ownership check; PRESIDENT uniquely excluded. | Add the ownership check. **PRESIDENT exclusion still open (Q23).** | P6 | ⏳ Partial |
| **D4** | `timelimit > 36` silently clamped to 36; `timelimit = 0` accepted, then `DivisionByZero` at approval. | **Reject with `400`** (Q9) — both bounds. Enforce `1 ≤ timelimit ≤ 36`; no silent clamp. | P4 | ✅ **Decided — fix** |
| **D5** | Power-approval email puts every member in `ToAddresses` with empty `Bcc`. | Move to `Bcc` — recommended. **Open (Q18).** | P3 | ⏳ Open |
| **D6** | `LoanDetail.loan` is a plain FK; re-approving a closed loan creates a second row and 500s that loan permanently. | Unique `loan_id`, upsert not insert. Now **belt-and-braces** behind D10, which blocks the transition at the source. | P4 | ✅ **Decided — fix** |
| **D7** | A payment reminder whose `run_date` has passed is **never sent** — the 5-day reminder is skipped entirely whenever the monthly file lands within 5 days of the deadline. | **Send immediately** on the next scheduler run instead of skipping (Q8). | P7 | ✅ **Decided — change** |
| **D8** | Bulk loan upload returns a bare `200` with no body. | **Return the list of auto-closed loans.** No cap on how many may be closed (Q3). ⚠️ Response-shape change — `manual-tester` must expect it. | P4 | ✅ **Decided — change** |
| **D9** | Re-approving an already-approved or closed loan is allowed and corrupts the record. | **Enforce legal state transitions** `0→1`, `0→2`, `1→3`, `1→2`; reject anything else (Q14). | P4 | ✅ **Decided — fix** |
| **D11** | `UserFinance.user` and `UserPreference.user` are plain FKs, not OneToOne — the same latent defect registered as D6 for `LoanDetail`. A duplicate row makes the user's finance endpoints 500 permanently. | Unique constraint on `user_id` for both; upsert not insert. | P3 | ⏳ **Needs decision** |
| **D10** | Loan read (`GET /api/loan/<id>`, `paymentProjection`) is open to any member by id. | **Restrict** to the loan owner plus roles `[0,1,2]` (Q16). | P4 | ✅ **Decided — fix** |

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
| 3 | `nestjs-reviewer` | Code review approved, **and** the parity report reviewed for missing business scenarios. Also enforces the §2 rule that hstore raw SQL stays inside the two repositories. |
| 4 | `business-analyst` | Phase alignment note = **Aligned**. |
| 5 | *user* | Every §5 deviation owned by this phase is **decided** (port or fix) and recorded. An undecided deviation blocks the gate; an unregistered behavioral diff is a parity **failure**. |

**Phase status board**

| Phase | Status | Dev | Tester | Reviewer | Analyst |
|---|---|---|---|---|---|
| — Prereq: dev DB at 0019 | ✅ **Cleared** | — | — | — | — |
| 0 Foundations & Prisma baseline | ✅ **Complete** (`b3effab`) | ✅ | n/a | ⬜ | n/a |
| 1 Auth + roles | 🟡 **Ready** — blocked only on Q25 | — | — | — | — |
| 2 Mail + notifications | ⬜ Blocked on P1 | — | — | — | — |
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

### Still open

| Q | Topic | Blocks |
|---|---|---|
| **Q25** ⭐ *new* | **Q15 settled ADMIN and TREASURER but not PRESIDENT (role 1).** This plan assumes PRESIDENT gets member-level rights on `PATCH /api/user/<id>` (self, personal + preferences, no finance, no role). Confirm or correct. | **P1 — D1 cannot be implemented without it** |
| Q10 | Should the power-of-attorney letter go to every member, or only requester + requestee? | P3 |
| Q18 | May those recipients move `To:` → `Bcc:`? (D5) | P3 |
| Q19–Q24 | **CAP rules** — what a CAP is economically, when it closes, whether `value` is a balance or a deposit, member visibility, the PRESIDENT exclusion (D3), quota interaction | **P6 — no spec to port** |
| Q11 | Next assembly date(s); the treasurer's usual upload day | P9 runbook |

### Cutover timing constraints (Phase 9 runbook)

Cut over immediately **after** a verified monthly bulk upload; **never** in the last or first two
weeks of a calendar year (`ActivityService.create_year` keys off `date.today().year` with no
re-enable path); check the assembly calendar before scheduling Phase 3.

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
