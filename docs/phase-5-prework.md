# Phase 5 — pre-work findings (verified before implementation)

Written by the coordinator from v1 source and the live `fondodev` fixture, so the developer does
not have to rediscover it. Every claim here was measured, not inferred.

## 1. The two-enabled-years anomaly — explained, and it is inert

`fondo_api_activityyear` has 9 rows and **two are `enable = true`: 2026 and 2020.**

Insertion order (by id) matches year order — `1→2018, 2→2019, 3→2020, 4→2021, 5→2022, 6→2023,
8→2024, 9→2025, 10→2026`, with **id 7 missing** (a row created and deleted).

`create_year` disables `filter(~Q(year=year)).order_by('-year')[0]` — the highest year that is not
the one being created. Walking the chain, every link holds **except one**: creating 2021 should
have disabled 2020, and did not. 2019→disabled by 2020's creation ✅, 2022's creation disabled
2021 ✅, and so on to 2026 ✅.

**`create_year` cannot produce this state on its own.** Confirmed there is no `ATOMIC_REQUESTS` in
`api/settings/base.py` (so it defaults to `False`), and `create_year` carries no
`@transaction.atomic` — the `last_year.save()` autocommits on its own statement. A failure after
it would leave the previous year disabled, which is the *opposite* pattern. So either 2021's row
was inserted outside the API, or 2020 was re-enabled by hand afterwards.

**Why it does not matter for the port — and this is the part that does matter.** Every reference
to `enable` in the entire v1 codebase:

| Site | Role |
|---|---|
| `models.py:76` | `BooleanField(default=True)` |
| `migrations/0005_activityyear_enable.py` | adds the column |
| `migrations/0006_auto_20190203_1143.py` | one-off backfill: disable every year != the year the migration ran |
| `serializers.py:116` | `ActivityYearSerializer` echoes it to the client |
| `services/activity.py:20` | `create_year` writes it |

**Nothing reads it.** No query filters on it, no branch depends on it. It is a display flag the
client interprets, written by one path and echoed by another.

**Consequences for v2, all binding:**

1. **Do not enforce "exactly one enabled year".** Production data already violates it. Any
   implementation, test fixture or assertion built on that invariant will diverge on real data
   while passing against an idealised fixture — a false green of the most expensive kind, because
   the fixture would be the thing that is wrong.
2. **Serialise `enable` verbatim.** Do not recompute it from `year == currentYear`.
3. **Port `create_year`'s disable exactly as written** — highest non-current year, one row, no
   transaction. It is not "disable the previous year"; on a gap it disables whatever the highest
   other year happens to be.
4. Migration 0006 is **historical**. It is not re-run and has no v2 counterpart.

## 2. `create_year` really has no transaction

Verified: no `@transaction.atomic` on the method, and no `ATOMIC_REQUESTS` in any settings module,
so Django is in autocommit. The disable and the create are **two independent commits**.

If `ActivityYear.objects.create` then raises `IntegrityError` (the `year` column is
`BigIntegerField(unique=True)`), the disable has already committed and the handler answers
**304**. So a second `POST /api/activity/year` in the same calendar year is *not* a no-op: it
re-disables the highest other year — harmless when already false, but it is a write on a request
that reports "not modified".

Port the absence faithfully. Do **not** add a transaction; that is a silent behaviour change.
Register it as a discovered deviation candidate instead.

Contrast `create_activity` immediately below it, which **is** `@transaction.atomic`.

## 3. Fixture baseline for this phase

`activityyear 9 / activity 25 / activityuser 338`, alongside the standing
`loan 425 / loandetail 374 / schedulertask 626 / notificationsubscriptions 94, max(id) 1468 /
auth_user 15 / power 20`.

⚠️ `__add_users` writes **one `ActivityUser` per active user** — **13** rows per activity on `fondodev`, not 15.
(`auth_user` has 15 rows; users **3** and **15** are `is_active = false`. Measured on both stacks by
the Phase 5 parity round — three documents said 15, and a probe asserting 15 would have failed
against v1 as well and read as a v2 defect.)
`DELETE` cascades those children **in Python**, not in the database: every FK here is
`NO ACTION`/`DEFERRABLE`, so Prisma will not cascade for you.
