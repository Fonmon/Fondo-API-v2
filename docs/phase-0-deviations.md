# Phase 0 — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5. Phase 0 ships **no business endpoints**, so it has no
parity criteria; everything below is either a v2-only decision or a finding that Phases 1–9
need to act on.

Audience: `nestjs-reviewer` (deviations) and whoever maintains `MIGRATION_PLAN.md`
(findings).

---

## 1. Registered deviations from v1

| # | v1 behavior | v2 behavior | Rationale |
|---|---|---|---|
| **P0-D1** | `HOST_URL_APP` is read with `os.environ.get()` (`fondo_api/templatetags/env_var.py`). When unset, Django's `{% host %}` tag renders the literal string `None` into activation and password-reset emails, producing dead links. | **Required.** Boot aborts with a message naming the variable. | Plan Phase 0 asks for fail-fast on missing required vars. The only v1 behavior lost is silently mailing broken links. |
| **P0-D2** | No health endpoint exists. | `GET /health` → `200 {"status":"ok","database":"up"}`. | The only route Phase 0 ships. It has no v1 counterpart, so `manual-tester` must not treat it as a parity diff. Shape is v2's own. |
| **P0-D3** | v1's `.env`-equivalent is a scattered set of `os.environ` reads across 6 files, half `[]` (KeyError) and half `.get()` (silent `None`). | One validated schema (`src/config/env.schema.ts`), all problems reported at once, before the DI graph is built. | Plan Phase 0 scope. |
| **P0-D4** | `DJANGO_SECRET_KEY`, `REDIS_HOST`, `ALEXA_CLIENT_ID`, `AWS_SKILL_ID`, `ALLOWED_HOST_DOMAIN` are read from the environment. | Not in the v2 config schema. | Celery/Redis is replaced by `@nestjs/schedule` (Phase 7); Alexa is retired (plan §1); password reset uses v2's own token scheme (plan Phase 3), so `DJANGO_SECRET_KEY` is not needed. `ALLOWED_HOST_DOMAIN` was only used by the Alexa handler banner and Django's `ALLOWED_HOSTS`. Re-add if Phase 8 or deployment turns out to need it. |
| **P0-D5** | The baseline is a straight `prisma migrate diff` dump. | The baseline SQL is **hand-edited** in three places: `CREATE EXTENSION hstore`, `DEFERRABLE INITIALLY DEFERRED` on all 21 FKs, and `varchar_pattern_ops` / `text_pattern_ops` on the five Django `%_like` indexes. | Prisma's datamodel cannot express any of the three. Without them a CI-provisioned database differs from production in FK timing. Documented in the migration file header; re-apply if it is ever regenerated. |

Nothing else in Phase 0 departs from v1.

---

## 2. Judgment calls where v1 was ambiguous or silent

### 2.1 `roundHalfEven` operates on floats; `roundHalfEvenDecimal` on decimals

v1 has **two** rounding sites that look identical but are not:

```python
int(round(float(data[1]), 0))   # TSV bulk upload  -> binary float, half-even
int(round(payment_value, 0))    # amortisation row -> Decimal, half-even
```

Both are half-even, but the float path can be pushed off by a representation error the
Decimal path never sees. Rather than pick one, `src/common/utils/rounding.util.ts` ships
both and documents which v1 call site each replaces. Phase 4 must use the matching one per
site; using the Decimal helper for the TSV path would be *more* correct and therefore
*wrong* for parity.

### 2.2 Python's default decimal context is `prec=28`, and it matters

Not mentioned in the plan. `__generate_table` computes `Decimal(loan.value) / fee`, and
Python's default context keeps **28** significant digits. `decimal.js` defaults to 20.
`src/common/utils/decimal.ts` clones the constructor with `precision: 28`,
`rounding: ROUND_HALF_EVEN`, and exponent thresholds pushed out so `toString()` never
switches to scientific notation. A 20-digit quotient would drift from v1 on long-term loans.

### 2.3 The Babel money expression rounds **twice**, not once

```python
with decimal.localcontext(decimal.Context(rounding=decimal.ROUND_HALF_DOWN)):
    format_number(format_decimal(round(value, 2), format='#'), locale='es')
```

Step 1 rounds half-down to two decimals; Babel then quantises to zero decimals under the
same ambient context. The composition is observable: `20.5001` renders as **`20`**, not
`21`, because step 1 pulls it to `20.50` and step 2 rounds that tie toward zero. Verified
against `Babel==2.9.1`. `formatMoneyEs` reproduces both steps and a test pins the case.
Anyone "simplifying" it to one rounding will silently break email HTML.

### 2.4 Babel 2.9.1 groups four-digit numbers; Node `Intl` does not

CLDR marks Spanish `minimumGroupingDigits = 2`, so `Intl.NumberFormat('es').format(1000)`
returns `"1000"`. Babel 2.9.1 does not implement that rule and returns `"1.000"`. v1's own
tests never render a four-digit amount, so this was resolved by running Babel 2.9.1
directly. **v2 follows Babel**, and a test asserts the divergence from `Intl` explicitly.
This is the single riskiest formatting call in Phase 0 — it is invisible until a loan
crosses $1.000, which every real loan does.

### 2.5 Spanish month abbreviations are inlined, not taken from `Intl`

`d MMM y` with `['ene.', 'feb.', ..., 'sept.', ..., 'dic.']`, including the trailing period
and the four-letter `sept.`. ICU/CLDR data drifts between Node releases; v1's expected
strings (`'26 sept. 2021'`, `'9 dic. 2017'`) do not. Eleven of the twelve months are pinned
by strings copied out of v1's tests; October is pinned from Babel 2.9.1 output.

### 2.6 hstore **writes** also need the Python encoding, not just reads

The plan describes the read-side quirks (`json.loads` on `user_ids`, `'` → `"` on `keys`)
but not the write side. Django's `HStoreField.get_prep_value` runs `str()` over every value,
so a dict is stored as a Python **repr** (`{'auth': 'x'}`), a list as `'[5]'` and an int as
`'53'`. If v2 wrote JSON there instead, rows written by v2 and rows written by v1 would be
encoded differently in the same column and the read-side repair would corrupt v2's own rows.
`encodeHstore` / `pythonStr` / `pythonRepr` reproduce the encoding; live-row fixtures pin it.

### 2.7 hstore key **order** is part of the SQS wire format

PostgreSQL emits hstore entries ordered by (key length, key bytes); psycopg2 builds a dict in
that order; v1 `json.dumps` it straight into the SQS message body. `parseHstore` therefore
preserves read order, and `decodePushSubscription` keeps it, so `JSON.stringify` reproduces
v1's bytes. Tested. Phase 2's "SQS message bodies byte-identical" criterion depends on it.

### 2.8 `Response(status=...)` renders a **zero-byte** body

Many v1 views return a bare status with no data; DRF renders that as an empty body, not
`null` and not `{}`. `ApiException.empty()` plus the filter reproduce it. Getting this wrong
is the kind of diff that passes a status-code check and fails a byte comparison.

### 2.9 `num_pages` is never 0

Django computes `ceil(max(1, count - orphans) / per_page)` with `orphans = 0`, so an empty
result set reports `num_pages: 1, count: 0`. Easy to "fix" into 0. Pinned by a test.

---

## 3. Findings for `MIGRATION_PLAN.md`

Ordered by how much they change later phases.

1. **NestJS 12 is ESM-only.** `@nestjs/common` ships `"type": "module"` with no CJS build.
   The project compiles to CommonJS and relies on Node's `require(esm)` (fine on Node ≥ 22.12),
   but Jest needs `NODE_OPTIONS=--experimental-vm-modules`, which is wired into the `test`
   and `test:e2e` scripts. Anyone running `npx jest` directly will get a confusing
   "Must use import to load ES Module" error. Worth a line in the plan.

2. **Prisma 7 changed two things the plan's commands assume.**
   - `datasource.url` is no longer allowed in `schema.prisma`; the connection string lives in
     `prisma.config.ts`, and `.env` is no longer auto-loaded (we load it with `dotenv`).
   - `migrate diff` renamed its flags: `--from-schema-datamodel` → `--from-schema`,
     `--from-url` → `--from-config-datasource`. The plan's Phase 0 recipe uses the old names.
   - `PrismaClient` now requires a driver adapter (`@prisma/adapter-pg`). That is a bonus: the
     two raw-SQL hstore repositories get a first-class `pg` path.
   - ⚠️ `npm i prisma@latest` currently installs **8.0.0-rc.12** — npm's `latest` tag points at a
     release candidate. The CLI is pinned to `7.10.0` to match `@prisma/client`. Do not
     "update" it without checking.

3. **Django's FKs are `DEFERRABLE INITIALLY DEFERRED`; Prisma cannot express that.** All 21 of
   them. The baseline SQL is hand-patched (P0-D5) so CI databases behave like production. If
   anyone regenerates the baseline without the patch, integration tests that insert children
   before parents will start failing in CI only.

4. **Django's `on_delete=CASCADE` is Python-side, not a database cascade.** Every physical FK
   is `NO ACTION`. Phases 3–8 must delete children explicitly inside a transaction — the
   database will not do it. This is not called out in the plan and it is easy to assume the
   opposite from reading `models.py`.

5. **`auto_now` / `auto_now_add` have no DB defaults.** The plan flags this as a Phase 0 risk;
   confirmed by `pg_dump` — `created_at`, `last_modified` and `date_joined` are plain
   `NOT NULL` with no `DEFAULT`. Every insert in every later phase must supply them.

6. **`UserFinance.user` and `UserPreference.user` are plain ForeignKeys, not OneToOne.** No
   unique constraint on `user_id`, yet `services/user.py` calls
   `UserFinance.objects.get(user_id=...)`. A second row makes that call raise
   `MultipleObjectsReturned` — the same class of latent 500 the plan already registered for
   `LoanDetail` (D6). Worth adding to the post-cutover cleanup backlog.

7. **DRF's 401/403 bodies are `{"detail": "..."}`, not `{"message": "..."}` — and v1 has no
   test asserting them.** Plan Phase 1's parity criteria say "identical allow/deny" but never
   pin the response body. `manual-tester` should capture the exact strings from running v1
   before Phase 1 closes; the Phase 0 filter deliberately does not guess.

8. **`prisma db pull` does not read index operator classes back.** Declaring
   `ops: raw("varchar_pattern_ops")` in `schema.prisma` produces permanent phantom drift
   (`migrate diff` wants to drop and recreate the index on every run). Hence the SQL-level
   patch instead. Verified in both directions: with the schema as committed, `migrate diff`
   reports an empty migration both live→schema and schema→live.

9. **Two cosmetic, accepted differences between a Prisma-built and a Django-built database**
   (verified with `pg_dump`, documented in the migration header):
   `timestamp(6) with time zone` vs `timestamp with time zone` (identical — 6 is the default
   precision), and `CREATE UNIQUE INDEX` vs `ADD CONSTRAINT ... UNIQUE` (identical
   enforcement and identical index names; only `ON CONFLICT ON CONSTRAINT` would tell them
   apart, and nothing uses that form).

10. **`Loan.rate` reads back as `0.02`, not `0.020`.** Prisma's `Decimal` normalises trailing
    zeros in `toString()`. `toFixed(3)` restores the stored form. Only matters if a Phase 4
    response or email ever renders the rate directly.

11. **The dev database still holds 94 subscription rows and 632 scheduler rows.** They are
    real fixtures for Phases 2 and 7 — the codec was validated against their actual encoding.
    Do not let a future DB reload drop them without capturing samples first.

12. **`.nvmrc` says 24; the workstation is on Node 26.7.** Everything passes on 26.7 and CI
    pins 24 per plan §8. If 24-only behavior is ever needed, note that `require(esm)` support
    (Node ≥ 22.12) and Jest's `--experimental-vm-modules` path both exist on 24.
