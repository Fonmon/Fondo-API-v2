# Session state — resume here

**Updated:** 2026-09-03, after the D4 reversal, with Phase 4 at the manual-tester stage.
**Purpose:** everything needed to pick this up cold. `MIGRATION_PLAN.md` is the plan of record
(now rev **v3.2**); this file carries what the plan does not — in-flight work, environment
gotchas, and the next actions.

## 0. Right now, in one paragraph

**Phase 4 (Loans) is implemented and with `manual-tester`.** Branch `feat/phase-4-loans` at
**`5aa8b1a`**, tree clean, nothing pushed. Gate verified by me, not taken from a report: lint
clean, `tsc --noEmit` clean, **1830 unit / 58 suites**, **818 e2e + 1 skipped / 16 suites**,
`fondodev` at baseline with **1 distinct `xmin`** on both loan tables. When the tester reports,
it goes to `nestjs-reviewer` — that is the standing three-stage pipeline from Phase 2 onward.

**Pipeline state:** developer ✅ → manual-tester 🔨 **running** → reviewer ⬜.

### If you are resuming cold, the next action is

1. Wait for / read `docs/parity-phase-4.md` from `manual-tester`.
2. Verify its load-bearing claims yourself before propagating them — every agent report so far
   has contained at least one claim that did not survive checking.
3. Then dispatch `nestjs-reviewer` with the parity report and the phase.

### Still open, tracked to Phase 4's gate (not its start)

**C31, C33, C34, C35, C37, C39** — small doc, register and test conditions from the Phase 3
review, held back so they do not race the Phase 4 branch on the same files. Also open:
**M5/C32** (the D15 + P3-D2 unresettable-account path), **B1–B4** from Phase 3 round 1, and
`PowerService.parseDateField` rejecting `2026-1-5` where Django accepts it (Phase 3 behaviour,
found during Phase 4, recorded not changed).

### The D4 lesson, because it will recur

Phase 4's developer implemented v1's silent `timelimit > 36` clamp because **§3 describes it,
v1's `test_post_loan_5` asserts it, and my dispatch brief paraphrased §3** — three sources that
all describe v1, agreeing with each other against operator **Q9**, which decided a 400. **§5
decides; §3 only describes.** A precedence note now sits at the head of §5. Expect §3 and §5 to
disagree again in Phases 5–8 **by construction** — that is what a deviation register *is*.

---

---

## 1. Where the work stands

| Phase | State |
|---|---|
| **0 Foundations & Prisma baseline** | ✅ **CLOSED — APPROVED** (`b3effab` + conditions C1–C4). |
| **1 Auth + roles** | ✅ **CLOSED — APPROVED** (`151314f` + C1–C8). |
| **2 Mail + notifications** | ✅ **CLOSED — APPROVED** (`fe261fc`), parity PASS round 3. |
| **3 Users + finance** | ✅ **CLOSED — APPROVED w/ conditions C28–C39.** Parity PASS round 4. |
| **4 Loans** | 🔨 **Developer done** (`5aa8b1a`). **With `manual-tester` now.** Reviewer after. |
| 5–9 | ⬜ Not started. |

**Branch:** `feat/phase-4-loans` at `5aa8b1a`. Tree clean. **Nothing pushed** — `main` is
still at `f1660d3`. Older branches `feat/phase-1-auth` (`cf23eae`) and `feat/phase-0-foundations`
are ancestors; keep or delete.

**Gate for Phase 2, verified independently:** lint clean, `tsc --noEmit` clean, **1029 unit /
28 suites**, **381 e2e** (+1 skipped by design — the read-only `fondodev` scan). `fondodev` still
at 94 subscription rows, no migrations run. **v1 untouched.**

---

## 2. ⚠️ In flight

**`manual-tester` is producing the Phase 2 parity report** → `docs/parity-phase-2.md`. That file
**did not exist** when this was written. Do not assume PASS or FAIL.

On resume:
- If `docs/parity-phase-2.md` exists — read it, fold the verdict into `MIGRATION_PLAN.md` §7 and
  the phase board, then hand to `nestjs-reviewer` (the report gates the reviewer).
- If not — relaunch. Its brief: exercise `POST /api/notification/{subscribe,unsubscribe}` across
  all four roles against the shared `fondodev`, and compare SES payloads and SQS message bodies
  byte-for-byte. `docs/phase-2-deviations.md` **§4 is written for the tester** — §4.4 lists
  expected non-failure diffs, §4.5 names three high-value cross-app checks.

**Pipeline is standing from Phase 2 to the end** (plan §7): `nestjs-developer` → `manual-tester`
(PASS required) → `nestjs-reviewer` (verdict closes the phase). A failure at any stage returns to
the developer and restarts the sequence. `business-analyst` is gate 4 and on-demand.

---

## 3. Environment gotchas

- **`npm` is NOT on the default PATH:**
  `export PATH="/home/miguel/.config/nvm/versions/node/v24.20.0/bin:$PATH"`
  (A mise-managed Node **26.7.0** is on PATH; the project wants **24**, per `.nvmrc`.)
- **Prisma pinned to `7.10.0`** — `npm i prisma@latest` installs an RC (`8.0.0-rc.12`).
- **NestJS 12 is ESM-only:** Jest needs `NODE_OPTIONS=--experimental-vm-modules` (already in the
  npm scripts). `npx jest` directly fails confusingly.
- **DB:** `PGPASSWORD=fondo psql -h localhost -U fondouser -d fondodev -tAc "<sql>"`.
  It has gone offline once (host restart) — check before concluding anything about live data.
- **NEVER run `prisma migrate dev` against `fondodev`.** Django owns the schema until cutover;
  the baseline `0_init` is recorded with `applied_steps_count = 0`.
- **v1 holds port 8443 — run v2 on `PORT=8444`.**
- ⚠️ **`NOTIFICATIONS_QUEUE_URL` is load-bearing.** Without it the publisher short-circuits, so
  publish assertions pass while nothing is sent — a suite that proves nothing while looking green.
- ⚠️ **`fondodev`'s 94 `fondo_api_notificationsubscriptions` rows are the fixture** for the hstore
  codec — production-shaped data that cannot be regenerated. Snapshot before any write test:
  `pg_dump -t fondo_api_notificationsubscriptions`.
- ⚠️ **Do not use an md5 of `pg_dump` output as the fixture guard — it is nondeterministic.**
  Postgres runs with `synchronize_seqscans = on`, so a seqscan may start at a block other than
  0 and `COPY` emits the same 94 rows in a *rotated* order. Six consecutive dumps of provably
  unmodified data gave six different md5s (2026-08-31). A changed checksum is therefore not
  evidence of a write, and a matching one is luck. Use order-independent checks instead:

  ```sh
  psql -tAc "SELECT count(*), max(id) FROM fondo_api_notificationsubscriptions"   # 94 | 1468
  psql -tAc "SELECT md5(string_agg(t, E'\n' ORDER BY t)) FROM (SELECT id||'|'||user_id||'|'
             ||subscription::text AS t FROM fondo_api_notificationsubscriptions) s"
  # -> 7a6afbccd2f133c147bd096062655750
  psql -tAc "SELECT DISTINCT xmin FROM fondo_api_notificationsubscriptions"       # -> 905
  ```

  The `xmin` check is the strongest of the three: all 94 rows are still the single tuple
  version written by txn **905**, so no row has been updated since the load, whatever the dump
  order says.

---

## 4. Open items

### Blocking the next step
1. **Phase 2 parity report** (§2).
2. **C9 — detail-route trailing slashes.** Due at the Phase 3 gate. The reviewer **re-ruled it:
   fix, do not accept.** v1 has no trailing-slash *rule*, only an inconsistent table —
   `^api/activity/(?P<id>[0-9]+)/?$` carries `/?` while loan, user, file and activity-year detail
   routes do not, and the password-reset paths make the slash mandatory. A blanket rule would 404
   routes v1 serves. Needs strict routing plus **explicitly transcribed path arrays**. The
   widening is not cosmetic: `DELETE /api/user/5/` is an inert 404 in v1 and a **real soft
   delete** in v2. **P2-D5 is the same gap** (v1's `[a-zA-Z]+` operation constraint lives in the
   URL regex, so an unauthenticated `POST /api/notification/sub1` is 404 in v1, 401 in v2) — fold
   both into one pre-guard URL layer.

### Needs the operator (user) — both block Phase 3, neither blocks Phase 2
3. **Q26 / D16** — should `identification` be ADMIN-only on a `personal` update? It is the join
   key of the treasurer's monthly TSV and a miss is only logged, so a member editing their own
   cédula silently freezes their own contributions and quota. Recommendation: **yes**. The code is
   already parameterised and tested both ways; only the flag is unset.
4. **Q27 / D17** — when two members share an email, who gets the password-reset link?

### Live v1 defects — recorded, unfixable while v1 is frozen
5. **D1 privilege escalation is live in production.** Any member can `PATCH /api/user/<own id>`
   with `{"type":"personal", …, "role":0}` to become ADMIN, or set their own `total_quota` — the
   only value `create_loan` checks (`services/user.py:232`). Closed in v2 at **Phase 3**, exposed
   until cutover. This is the strongest argument for not letting Phase 3 drift.
6. **D17 — four of fifteen members cannot reset their password** (ids 7, 10, 13, 14) and are
   shown the success page anyway. `get_user_by_email` (`services/user.py:84`) swallows
   `MultipleObjectsReturned`. Worth telling the treasurer now, not at cutover.
7. **D20 — live.** Editing a soft-deleted user 500s and rolls the edit back
   (`user_ids.remove` on an active-only list). `fondodev` has **2 inactive users**.
8. **D19 — latent.** A member born 29 February 500s on every personal update in a non-leap year.
   **0 of 15 members** currently have that birthdate; it fires the day one is enrolled.
9. **Do not edit users 13 or 14** (`sebastian.montanez`, `ainhoa.montanez`) in v1 — shared parent
   emails plus a UNIQUE `username` index means any personal edit **409s**. Reconcile before
   cutover.

---

## 5. Working notes

- **Agent briefs must always carry:** v1-is-frozen, the Prisma 7.10.0 pin, "never `migrate dev`",
  the node PATH, and — most important — **derive expected values from v1's source or a real
  Python run; never invent them.** That one instruction is what caught the Babel grouping, the
  CPython `json.loads` strings, and the `json.dumps` separators.
- **Agents do not survive the session.** A stopped agent cannot be resumed; relaunch fresh. Two
  have been lost to rate limits and one to a cancel — routine, not a signal about the work.
- **My own editing hazard:** a Python edit script that `sys.exit()`s on a missed anchor **before
  writing** silently drops every earlier edit, producing a commit whose message overstates its
  content. This happened once (`3d629cc`/`489de50`, repaired in `cf23eae`). Write the file
  unconditionally and report misses at the end.

---

## 6. The findings that justify the process

Each was a plausible assumption that survived until someone read the source or the live data, and
**none would have been caught by tests** — the tests encoded the same assumption.

1. **`username != email` for 2 of 15 users**, and Django authenticates on `auth_user.username`
   (`AUTH_USER_MODEL` commented out, `api/settings/base.py:101`). Resolving `email` would have
   locked two members out.
2. **Babel 2.9.1 groups four-digit numbers for locale `es`; Node `Intl` does not.** No v1 test
   renders a four-digit amount — it would have surfaced as a wrong loan email above $1.000.
3. **17 Prisma `BigInt` columns and `JSON.stringify(1n)` throws.** The reflex fix renders
   `"1000"` where DRF renders `1000`.
4. **Django's `Settings.__init__` sets `os.environ['TZ']` from `TIME_ZONE`**, so `date.today()` is
   Bogotá — reversing a conclusion I had written into the plan.
5. **CPython `json.dumps` ≠ `JSON.stringify`** (separators + `ensure_ascii`). Every v1
   notification body is accented Spanish, so it diverges on message #1.
6. **Adding `ORDER BY id` would have *broken* parity** — Django emits none, so v1 serialises heap
   order, and on `fondodev` heap order is not id order.

---

## 7. Document map

| File | What it is |
|---|---|
| `MIGRATION_PLAN.md` | **Plan of record**, rev v1.2. §4 cross-cutting rules (incl. 5b/5c/5d), §5 deviations D1–D20 + P2-D1…D7, §7 pipeline + conditions + phase board, §9 operator Q&A, §10 toolchain notes. |
| `docs/review-phase-0-1.md` | Reviewer rounds 1 and 2, findings S1–S7 / R1–R9, final verdicts. |
| `docs/parity-phase-2.md` | **Does not exist yet** — the in-flight parity report. |
| `docs/phase-2-deviations.md` | Phase 2 judgment calls, P2-D1…D7. **§4 is the tester's setup guide.** |
| `docs/phase-0-deviations.md`, `docs/phase-1-deviations.md` | Earlier judgment calls. |
| `docs/phase-1-drf-auth-bodies.md` | The derived DRF 401/403/405 bodies. Cite; do not re-derive. |
| `docs/ba-review-v0.2.md`, `docs/ba-phase-3-decisions.md` | business-analyst notes. |
| `~/Projects/Fondo-API/CONTEXT.md` | v1 description. **Treat as secondary** — the source has now contradicted it three times. |
