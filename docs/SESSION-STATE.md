# Session state — resume here

**Updated:** 2026-09-04, after the delta review's C50 and C51 were closed.
**Purpose:** everything needed to pick this up cold. `MIGRATION_PLAN.md` is the plan of record
(now rev **v3.6**); this file carries what the plan does not — in-flight work, environment
gotchas, and the next actions.

## 0. Right now, in one paragraph

**Phase 4 (Loans) has completed its delta round and both blockers on Phase 5 are closed.**
Branch `feat/phase-4-loans`. The delta that closed C40–C49 (D29 quota boundary, D30 the floor at
1, M3 the compare-and-set) was measured by `manual-tester` (**PASS**, `docs/parity-phase-4-delta.md`)
and reviewed at `17114a0` — **Approved with conditions C50–C58**, `docs/review-phase-4-delta.md`.
Nothing there is a parity failure against v1.

**C50 and C51, the two that gated Phase 5's start, are closed** in the commit below: the bulk
auto-close now **skips** a loan whose state changed under it instead of rolling the whole monthly
upload back (a v2-only failure mode M3's compare-and-set introduced — see the control run under
the gate), and the CAS's one dishonest race pair is documented and pinned rather than retried.
**C52–C58 remain, tracked to Phase 5's gate.**

**Pipeline:** developer ✅ → manual-tester (full) ✅ PASS → reviewer ✅ approved w/ conditions →
conditions closed ✅ → manual-tester (delta) ✅ PASS (`17114a0`) → reviewer (delta) ✅
**Approved with conditions C50–C58** (`docs/review-phase-4-delta.md`) → **C50 and C51 closed —
the two that gated Phase 5's start** → scope Phase 5.

### If you are resuming cold, the next action is

1. **C52–C58 are tracked to Phase 5's gate**, and **C58 is hard**: the Phase 3 rollovers
   C31–C35, C37, C39 close or are formally struck. A third roll is not available.
2. Scope Phase 5 (Activities). Phase 4's remaining conditions travel with it, they do not
   re-open it — no C50–C58 finding is a parity failure against v1.
3. Verify any agent report's load-bearing claims yourself — every report so far has contained
   at least one claim that did not survive checking, including two of mine.

### Gate after C50/C51, verified by me

lint clean, `tsc --noEmit` clean, **1866 unit / 58 suites** (1863 + the three new cells),
**827 e2e + 1 skipped / 16 suites**, `fondodev` at baseline
(`loan 425 / loandetail 374 / schedulertask 626 / auth_user 15 / power 20`) with
`count(distinct xmin::text) = 1` on both loan tables.

**C50 was a real regression, control-run before the fix:** the new cell fails against `17114a0`
with an `ApiException: Invalid state transition` thrown out of `bulkUpdateLoans`' `$transaction`
at `loan.service.ts:843` — i.e. the whole monthly upload rolled back because one auto-close
candidate's state changed under it. It now skips that loan and commits.

### Operator decisions taken this phase

Q9 → D4 rejects a term outside 1–36 (the clamp is gone). Q29a/Q30a/Q31 → D25, D26, D27 proceed,
**D28 withdrawn** (a treasurer approving their own loan is normal practice). No minimum loan
amount → **D30 floors at 1**. Exact parity chosen on the quota boundary → **D29**. Re-open
refused → **D31 withdrawn, PAID_OUT is terminal**, recovery is a documented database repair.
Notification refused → **D32 withdrawn**, mass close stays silent. **D33** registers the
resulting partial self-heal.

### Still open, tracked to Phase 5's gate

**C44–C47, C49**, **C52–C58** from the delta review, and **C48** — the Phase 3 rollovers
**C31–C35, C37, C39**, which have now survived two gates. The reviewer's warning stands: a
third silent roll makes the tracking decorative, so they go in the Phase 5 batch. **C58 makes
that a hard deadline: close them or formally strike them.**

### The two lessons this phase actually taught

1. **§5 decides; §3 only describes.** Three sources that all describe v1 will always agree, and
   that agreement carries no information about what v2 should do. Precedence note now at the
   head of §5; C40 gives every phase block a mechanical "§5 rows this phase owns" line.
2. **Every convention carried successfully had a carrier — a table, a type error, an assertion.
   Every one that slipped was a paragraph.** Three slipped in Phase 4 alone, all prose.

**False-green register is at nineteen**, five of them mine. #19's lesson: a verifying `grep` that
is line-wrapped fails in *both* directions — it gave two false alarms and one false clearance in
this phase. Match a fragment that cannot wrap, or normalise whitespace first.

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
