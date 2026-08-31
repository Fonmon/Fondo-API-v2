# Session state — resume here

**Written:** 2026-08-30, ~19:20 America/Bogota, when the session hit an API rate limit.
**Purpose:** everything needed to pick this back up cold. `MIGRATION_PLAN.md` is the plan of
record; this file captures what the plan does *not* — in-flight work, environment gotchas, and
the exact next actions.

---

## 1. Where the work stands

| Phase | State |
|---|---|
| **0 Foundations & Prisma baseline** | ✅ Complete (`b3effab`). Reviewed → Approved-with-conditions. Conditions C1–C4 **closed**. |
| **1 Auth + roles** | ✅ Complete (`151314f`). Reviewed → Approved-with-conditions. C5–C8 **closed**; **C9 open**. |
| **2 Mail + notifications** | 🔨 **Dev complete** (`feat/phase-2-notifications`). SES mail + 6 templates, hstore subscription repository, SQS publisher, `POST /api/notification/<subscribe\|unsubscribe>`. C10–C13 closed. **Next: `manual-tester`, then `nestjs-reviewer`.** See `docs/phase-2-deviations.md`. |
| 3–9 | ⬜ Not started. |

**Branch:** `feat/phase-2-notifications`, branched off `feat/phase-1-auth` at `cf23eae`.
Working tree clean. **Nothing pushed.**

**Gate (Phase 2):** lint clean, `tsc --noEmit` clean, `nest build` clean (and the email
templates are copied into `dist` — verified by rendering from `dist` at runtime),
**1029 unit / 28 suites**, **381 e2e / 6 suites** (+1 skipped: the read-only `fondodev` scan,
enabled with `FONDODEV_DATABASE_URL`).

⚠️ **New required e2e env var:** `NOTIFICATIONS_QUEUE_URL` (defaulted in `test/setup-env.ts`).
Without it `NotificationPublisher` short-circuits and every publish assertion silently passes
without sending anything.

**v1 (`~/Projects/Fondo-API`) is FROZEN and untouched.** Its only new commit this session,
`5bef585`, adds `.claude/agents/*.md` and was made by the user. No Django source changed —
re-verify with `git diff --stat 1f454ae..HEAD -- fondo_api/ api/ manage.py requirements.txt`
(must be empty).

---

## 2. ⚠️ In flight when the limit hit

**A round-2 `nestjs-reviewer` pass was running** to verify C1–C8 and rule on C9. Its result was
never received. **Do not assume it passed or failed.**

To resume: check whether `docs/review-phase-0-1.md` has gained a **Round 2** section.
- If yes — read it, fold the verdict into `MIGRATION_PLAN.md` §7 and the phase board, and report.
- If no — relaunch the re-review. The brief is reconstructable from §7's condition table plus
  §4 of this file.

Two earlier agents also died on a rate limit and were relaunched successfully; that is routine,
not a signal about the work.

---

## 3. Environment gotchas that cost time

- **`npm` is NOT on the default PATH.** Prefix every command:
  ```
  export PATH="/home/miguel/.config/nvm/versions/node/v24.20.0/bin:$PATH"
  ```
  There is also a mise-managed Node **26.7.0** on PATH; the project wants **24** (`.nvmrc`).
- **Prisma is pinned to `7.10.0`.** `npm i prisma@latest` installs `8.0.0-rc.12` — npm's `latest`
  tag points at an RC.
- **NestJS 12 is ESM-only:** Jest needs `NODE_OPTIONS=--experimental-vm-modules` (already wired
  into the npm scripts). `npx jest` directly fails confusingly.
- **Dev database:** `localhost:5432`, db `fondodev`, user `fondouser`, password `fondo`.
  Verified at Django migration `0019_auto_20220313_1225`. Query it with:
  ```
  PGPASSWORD=fondo psql -h localhost -U fondouser -d fondodev -tAc "<sql>"
  ```
- **NEVER run `prisma migrate dev` against `fondodev`.** Django owns the schema until cutover.
  The baseline `0_init` is recorded with `applied_steps_count = 0` — marked applied, never
  executed.

---

## 4. Open items, in priority order

### Blocking the next step
1. **Round-2 review verdict** (§2 above).
2. **C9 / review finding S7 — detail-route trailing slashes.** `GET /api/loan/5/` is a Django
   **404** (v1's detail regexes have no `/?`) but Express's non-strict routing serves it. Note
   v1's *collection* routes **do** carry `/?`, so only detail routes diverge. Needs a §4
   cross-cutting rule or an accepted deviation **before Phases 3–8 add detail routes**.

### Needs the operator (user), both block Phase 3, neither blocks Phase 2
3. **Q26 / D16** — should `identification` be ADMIN-only on a `personal` update? It is the join
   key of the treasurer's monthly TSV and a miss is only logged, so a member editing their own
   cédula silently freezes their own contributions and quota. Recommendation: **yes**. The code
   is already parameterised and tested both ways; only the flag is unset.
4. **Q27 / D17** — when two members share an email, who gets the password-reset link? Reset the
   account whose `username` equals the email, refuse ambiguous addresses, or something else?

### Known live v1 defects — recorded, not fixed (v1 is frozen)
5. **D1 privilege escalation is live in production.** Any member can `PATCH /api/user/<own id>`
   with `{"type":"personal", …, "role":0}` to become ADMIN, or set their own `total_quota` —
   the only value `create_loan` checks. Verified at `services/user.py:232`. Closed in v2 at
   Phase 3; exposed until cutover. This raises the value of shipping Phase 3 promptly.
6. **Four of fifteen members cannot reset their password** (ids 7, 10, 13, 14) and are shown the
   success page anyway. `get_user_by_email` (`services/user.py:84`) swallows
   `MultipleObjectsReturned` in a bare `except`. Worth telling the treasurer now.
7. **Do not edit the profiles of users 13 or 14** (`sebastian.montanez`, `ainhoa.montanez`) in
   v1 — shared parent emails plus a UNIQUE `username` index means any personal edit **409s**.
   Both rows need reconciling before cutover.

---

## 5. The working pipeline

Per `MIGRATION_PLAN.md` §7, each phase runs: `nestjs-developer` → `manual-tester` →
`nestjs-reviewer` → `business-analyst`, and **the review gate is standing** — no phase closes
without a reviewer verdict written to `docs/review-phase-<n>.md`.

Agents are spawned fresh each time (they do not persist across a session). Briefs should always
carry: the v1-is-frozen constraint, the Prisma-7.10.0 pin, the "never `migrate dev`" rule, the
node PATH, and an instruction to **derive expected values from v1's source or a real Python run
rather than inventing them** — that instruction is what caught the Babel four-digit grouping and
the CPython `json.loads` error strings.

---

## 6. The four findings that justified the process

Keep these in mind when tempted to shorten a review — each was a plausible assumption that
survived until someone read the source or the live data, and **none would have been caught by
tests**, because the tests encoded the same assumption.

1. **`username != email` for 2 of 15 users**, and Django authenticates on `auth_user.username`
   (`AUTH_USER_MODEL` is commented out at `api/settings/base.py:101`). A v2 resolving `email`
   would have locked those two members out.
2. **Babel 2.9.1 groups four-digit numbers for locale `es`; Node `Intl` does not** (CLDR
   `minimumGroupingDigits=2`). No v1 test renders a four-digit amount, so nothing inherited
   would have caught it — it would have surfaced as a wrong loan email above $1.000.
3. **17 Prisma `BigInt` columns and `JSON.stringify(1n)` throws.** The first money response
   would have 500'd; the reflex fix renders `"1000"` where DRF renders `1000`.
4. **Django's `Settings.__init__` sets `os.environ['TZ']` from `TIME_ZONE`**, so `date.today()`
   is Bogotá — reversing a conclusion I had written into the plan.

---

## 7. Document map

| File | What it is |
|---|---|
| `MIGRATION_PLAN.md` | **Plan of record**, rev v0.14. §4 cross-cutting rules, §5 deviations D1–D18, §7 gate + conditions + phase board, §9 operator Q&A, §10 toolchain notes. |
| `docs/review-phase-0-1.md` | Reviewer's Phase 0/1 findings S1–S7 and verdicts. Round 2 appends here. |
| `docs/ba-review-v0.2.md` | business-analyst's first note — the 24 operator questions. |
| `docs/ba-phase-3-decisions.md` | business-analyst on the three Phase 3 `PATCH /api/user` decisions. |
| `docs/phase-0-deviations.md` | Developer's Phase 0 judgment calls, incl. the Babel findings. |
| `docs/phase-1-deviations.md` | Developer's Phase 1 judgment calls. |
| `docs/phase-1-drf-auth-bodies.md` | The derived DRF 401/403/405 bodies. Cite instead of re-deriving. |
| `~/Projects/Fondo-API/CONTEXT.md` | v1 description. **Treat as secondary** — the source has contradicted it twice. |
