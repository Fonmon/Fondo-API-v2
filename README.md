# Fondo-API v2

NestJS + Prisma rewrite of the Fondo Montañez Django/DRF service.

- **v1 (Django, frozen):** `~/Projects/Fondo-API` — the parity oracle. Read only.
- **Plan of record:** [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md)
- **Spec of v1 behavior:** `CONTEXT.md` in the v1 repo. Where it disagrees with the v1
  source, the source wins.

Current state: **Phase 0 complete** — scaffold, Prisma baseline, config, cross-cutting
utilities. No business endpoints yet; `GET /health` is the only route.

## Requirements

- Node 24 (`.nvmrc`)
- PostgreSQL with the `hstore` extension

## Setup

```bash
npm ci                 # runs `prisma generate` on postinstall
cp .env.example .env   # then fill in DATABASE_URL et al.
npm run start:dev
```

Every environment variable is validated at boot. A missing or empty required variable aborts
startup and prints all the problems at once — v1 raised a bare `KeyError` at import time.

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | watch-mode server |
| `npm run build` | `nest build` into `dist/` |
| `npm run lint` | ESLint + Prettier |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Jest unit suite (`src/**/*.spec.ts`) |
| `npm run test:e2e` | Supertest + real database (`test/**/*.e2e-spec.ts`) |
| `npm run prisma:pull` | re-introspect the database |
| `npm run prisma:deploy` | apply pending migrations |

The e2e suite provisions its own database (`TEST_DATABASE_URL`, default `fondo_api_test`)
from the Prisma baseline and **never** touches the shared dev database.

> Jest needs `NODE_OPTIONS=--experimental-vm-modules` because NestJS 12 is ESM-only. The
> `test` scripts set it; running `npx jest` directly will not work.

## Database — read this before touching the data layer

Django owns the schema until cutover (plan §1). The Prisma schema is a **mapping** of the
schema Django created, not a redesign.

- ⚠️ **Never run `prisma migrate dev`** against a database v1 also uses. Introspect
  (`prisma db pull`) and baseline only.
- `prisma/migrations/0_init` is a **baseline**: marked applied with
  `prisma migrate resolve --applied 0_init` on every v1-created database, executed only
  against brand-new ones (CI). It carries three hand-edits Prisma cannot express — see the
  header comment in the file.
- `auto_now` / `auto_now_add` are **application-set** in Django. There are no DB defaults on
  `created_at`, `last_modified` or `date_joined`; always pass them.
- Django's `on_delete=CASCADE` is **Python-side**. Every physical FK is `NO ACTION`; delete
  children explicitly, inside a transaction.
- `UserProfile(User)` is Django multi-table inheritance: `auth_user` + `fondo_api_userprofile`
  joined on `user_ptr_id`. Reading a "user" means reading both.
- The two `hstore` columns (`notificationsubscriptions.subscription`,
  `schedulertask.payload`) are `Unsupported("hstore")` and invisible to Prisma Client. All
  access goes through raw SQL plus `src/common/utils/hstore.codec.ts`, confined to
  `NotificationSubscriptionRepository` (Phase 2) and `SchedulerTaskRepository` (Phase 7).
  They become `jsonb` in Phase 9.

Verify the mapping still matches the live schema at any time:

```bash
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
# expected output: "-- This is an empty migration."
```

## Cross-cutting utilities (Phase 0)

| Module | Replaces |
|---|---|
| `src/common/utils/date.util.ts` | `fondo_api/services/utils/date.py` — US-NASD/European `days360` |
| `src/common/utils/rounding.util.ts` | Python `round()` — banker's rounding, plus the `ROUND_HALF_DOWN` money path |
| `src/common/utils/decimal.ts` | Python's default decimal context (`prec=28`, half-even) |
| `src/common/utils/hstore.codec.ts` | psycopg2 hstore + Django `HStoreField` encoding, with v1's quirks preserved |
| `src/common/utils/timezone.util.ts` | Django `USE_TZ=True` + `TIME_ZONE='America/Bogota'` |
| `src/common/i18n/spanish-format.ts` | `babel.dates.format_date` / `babel.numbers.format_decimal`, locale `es` |
| `src/common/http/pagination.ts` | `django.core.paginator.Paginator` + the `{list, num_pages, count}` envelope |
| `src/common/http/api.exception.ts`, `src/common/filters/` | DRF's `Response({'message': msg}, status)` convention |

**Never use `Math.round` on a money path** — it rounds half up, Python rounds half to even.
Use `roundHalfEven` / `roundHalfEvenDecimal`.

## Deviations from v1

Registered in [`docs/phase-0-deviations.md`](./docs/phase-0-deviations.md) and
`MIGRATION_PLAN.md` §5. An unregistered behavioral difference is a parity failure.
