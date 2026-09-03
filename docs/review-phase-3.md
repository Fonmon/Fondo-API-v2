# Phase 3 review — users, finance, powers of attorney, password reset

**Reviewer:** `nestjs-reviewer` · **Date:** 2026-09-03 · **Branch:** `feat/phase-3-users` @ `e926e14`
**Range reviewed:** `1344b48^..HEAD` (Phase 3 + four parity rounds); `b11fedf..HEAD` for context.
**Inputs:** `MIGRATION_PLAN.md` v3.0, `docs/parity-phase-3.md` (r1–r4), `docs/phase-3-deviations.md`,
`docs/ba-phase-3-decisions.md`, `docs/ba-phase-3-f9-f12.md`, v1 @ `5bef585` (frozen, read-only).

**Gate inputs re-verified independently, not taken on report:**

| Check | Result |
|---|---|
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm test` | ✅ **1 602 passed / 53 suites** |
| §2 rule — raw SQL against `hstore` confined to two repositories | ✅ `$queryRaw`/`$executeRaw` appear in `notification-subscription.repository.ts`, `scheduler-task.repository.ts` and one place else: `src/prisma/prisma.service.ts:49` (`SELECT 1`, the `/health` probe, no hstore). Rule holds. |
| v1 untouched | ✅ `~/Projects/Fondo-API` at `5bef585`, working tree clean |
| Plan v3.0 changelog claims vs. the plan's own text | ⚠️ **one claim is untrue** — see M4 |

No live server was started for this review; every claim below is derived from source, from the
frozen v1, or from the two suites above. `~/.fondo-parity-dumps/` was not touched.

---

## Conditions numbering

Phase 2's review numbered its conditions independently of the plan and the two collided. To stop
that recurring, **this review continues the plan's own §7 sequence**: the last number the plan
uses is **C27**, so Phase 3's conditions are **C28 – C39**. Nothing here re-uses C1–C27.

---

## Headline

The substance of Phase 3 is the strongest work in the migration so far. **D1 is closed, and closed
properly** — not merely tested. The two-level gate is structurally correct, the section gate
genuinely precedes the row load, `changedSectionFields` is the right comparator for the right
reason, and the C20 view-identity binding means the route the guard authorises is the route the
handler runs. I could not construct a member-reachable path to `role`, to `identification`, or to
another member's `finance` through `PATCH /api/user/<id>`.

The four parity rounds are also the most valuable artefact this project has produced. Round 2's F6
— *v1 refuses with a 406 before authentication; v2 executed and soft-deleted the row* — is the
single most important finding of the migration to date, because it is the only one so far where
v2 **wrote data v1 would not have written**. It was found by a tester who did not accept a
"rendering difference" registration at face value.

What I am **not** signing off unconditionally is a small set of things that sit just outside what
the parity contract can see, because parity against v1 is silent about them by construction:

* one host-timezone dependency that will reproduce itself in Phase 4 if left (**M1**);
* an authorisation gap the §5 register never opened a row for, in the same endpoint family the
  phase exists to secure (**M2**);
* a two-step path that still lets any member trigger the fund-wide power-of-attorney letter,
  which is half of what D2 was decided to stop (**M3**);
* a registration the plan says it corrected and did not (**M4**);
* a *new* class of unresettable account created by D15 + P3-D2 together (**M5**).

None of these re-opens the phase. All of them are cheaper to settle now than after Phase 4 has
inherited the primitives.

---

## Answers to the six questions asked

### 1. D1 — is the closure airtight?

**Yes, with one non-reachable-today defect (m2) and one register gap (M2).**

The three properties I was asked to judge:

* **The section gate precedes the row load.** `src/users/user.service.ts:487-507`. `resolveSection`
  runs on `body.type` at :490, `assertSectionWritable(actor, id, section)` at :493, and the first
  database read is inside the branch handlers at :541 / :714 / :791. A MEMBER declaring
  `type: finance` against id 99999 is a 403 and never touches the database; the parity report's
  §3.2 cell confirms this on the wire (v1 404, v2 403 for all three sections, with an ADMIN control
  producing the 404). The endpoint cannot be used to enumerate ids. Correct.

* **`changedSectionFields` is right, and the reasoning for it is right.**
  `src/auth/policies/user-patch.policy.ts:307-320`. The developer's argument is sound and I checked
  it against v1 rather than accepting it: `UserProfileSerializer`
  (`fondo_api/serializers.py:8-18`) emits `full_name`, `role_display` and `id`, none of which
  `__update_user_personal` (`fondo_api/services/user.py:223-241`) writes. A raw
  `changedFields(submitted, stored)` reports all three as changed because the stored record has no
  such keys, and `FieldAllowlist.assert` then 403s **every member's save**. Intersecting with
  `SECTION_FIELDS` first is exactly what v1 does implicitly by only reading six keys. The C6
  property survives — the allowlist is still built from `services/user.py`'s field table
  intersected with the caller's rights (`:251-255`), never from the payload.

  Note what this *also* buys, which the docs do not say: it makes the allowlist's rejection of
  unknown keys (`is_active`, `key_activation`, `user_ptr_id`) unreachable rather than load-bearing,
  because unknown keys are filtered out before the assert. The mass-assignment protection is
  actually the explicit field enumeration at `user.service.ts:562-588`, not the allowlist. That is
  fine — it is the stronger of the two — but the doc comment at `user-patch.policy.ts:227-231`
  presents the allowlist as the control, and after `changedSectionFields` it is not. Worth one
  sentence so nobody later "simplifies" the explicit write list on the strength of it.

* **`role` and `identification` are ADMIN-only, gated on change, not presence.**
  `user-patch.policy.ts:138-141`, applied at `user.service.ts:550-560`. Correct, and the 72-cell
  matrix in `docs/parity-phase-3.md:189-217` exercises the echo case (unchanged `role` submitted →
  200, no row change) as well as the escalation case. That echo cell is the one that would have
  caught the wrong reading, and it is present.

* **Interaction with C20's view-identity binding.** `RolesGuard.v1ViewFor`
  (`src/auth/guards/roles.guard.ts:121-159`) authorises on `request.djangoRoute.view` and 500s on a
  disagreement with `@V1View`. Combined with `DjangoUrlPattern.dispatch` rewriting
  `/api/user/<x>` to `/api/user/detail/<x>` vs `/api/user/apps/<x>`
  (`docs/phase-3-deviations.md` §2.5), the controller that runs and the rules that were applied are
  the same v1 view **by construction**, not by declaration order. This is the part I was most
  prepared to find broken and it is right. `test/user.e2e-spec.ts:1709-1738` pins the four cases
  including `DELETE /api/user/power` → 403 for ADMIN.

**Residual defects, both below the blocking line:** m2 (the comparator collapses large integers
through `Number`, which is a D16 bypass for identifications above 2^53 — unreachable with real
cédulas) and **M2** (`GET /api/user/<id>` was never brought into the register at all).

### 2. Is the Django-emulation layer coherent, or accreting?

**Coherent. It is a stack, not a pile — but the contract for adding a route to it is undocumented,
and that is what will make Phases 4–8 non-mechanical.**

The evidence for coherence is `src/app.module.ts:83-108`: every one of the seven middlewares maps
to a numbered slot in v1's own `MIDDLEWARE` list or to `BaseHandler`, the response phase is ordered
by `DjangoStack` depth rather than by registration, and the two "why is the URL layer split in
two" and "why is negotiation between the resolver and the parser" questions each have a measured
answer rather than a plausible one. Phase 3 added four pieces (content negotiation, Django's
`MultiPartParser`, CSRF, `@DjangoView()`) and none of them needed to modify the existing four; that
is the test of a layered design and it passed.

**Rule 12c — the sharpest test — is satisfied semantically and misplaced structurally.** v2 does
not implement the `FILES`-into-`data` merge (`django-multipart.ts:479-484` keeps files on a
separate slot), and `readUploadedFile` is the standing pattern the plan names. But
`readUploadedFile` is **exported from `src/users/user.controller.ts:168-174`**. Phase 4's
`LoanView.patch` and Phase 8's `FileView.post` would have to `import { readUploadedFile } from
'../users/user.controller'` — a loan controller importing from the users module to read a file. The
likely outcome is that someone re-writes it locally, and the second copy is where the merge creeps
back in. Same for `pythonInt` and `lastQueryValue` (`:144-161`), which `LoanView.get` needs
verbatim for its own `page`. See **C36**.

Will Phases 4–8 be mechanical? Mostly, if a checklist exists. Today a new route silently needs:
a `DJANGO_URL_CONF` entry with `view`/`drf`/`dispatch`; `@V1View`; an entry in
`permission-matrix.ts`; an `@All()` fallback with the right `Allow` string; `@DrfNoRequestData()`
iff the handler never reads `request.data`; `readUploadedFile` for any file part; and a
`DrfViewHeaders.renderers` entry. Six of those seven fail *closed* if forgotten — which is the
right design — but "the route 403s and nobody knows why" is still a day lost per occurrence. **C36**
asks for that list to be written down once.

### 3. The password-reset design

**Sound. I would ship it. The security argument holds and is, if anything, understated.**

* **The hop is load-bearing and the developer's reason is the right one.** `password_reset_confirm`
  loads `stackpath.bootstrapcdn.com`; with the token still in the path, the browser hands it to a
  third party in `Referer` on the very page where it is being redeemed. Collapsing the hop would be
  a real regression that no test would show. Keeping it is correct.
* **Dropping the session store loses nothing.** Django's `PasswordResetConfirmView.dispatch`
  re-runs `token_generator.check_token(user, session_token)` on the second request; the session is
  a carrier, not a trust boundary. v2 carries the same token and runs the same check
  (`password-reset.controller.ts:296-300`).
* **Replay:** closed. The token is an HMAC over `id + password + last_login + timestamp`
  (`password-reset-token.service.ts:103-109`); `setPassword` rewrites `auth_user.password`
  (`password-reset.service.ts:135-138`), so the HMAC input changes and the link dies on use.
  `clearResetCookie` is belt-and-braces, not the control. Correct.
* **Lift:** the cookie is `HttpOnly`, `Path=/reset/`, `SameSite=Lax`, `Secure` in production —
  which matches v1's `SESSION_COOKIE_SECURE = True` (`api/settings/production.py:19`), so v2 is not
  weaker than what it replaces on any attribute, and is *tighter* on `Path`. `timingSafeEqual`
  with a prior length check (`:92-97`). `Number.parseInt(_, 36)` is regex-guarded (`:82`).
  Cross-account use is impossible because the HMAC binds the id. I could not construct a lift.
* **One thing that is neither v1's fault nor v2's, and should be written down rather than fixed
  here:** a completed password reset does **not** invalidate the member's DRF `authtoken_token`.
  `auth_user.password` changes; `authtoken_token.key` does not. So the reset flow — the fund's only
  self-service account-recovery path — does not evict an attacker who already holds a token. v1 is
  identical (`fondo_api/views/auth.py`, nothing touches `Token`), so it is a faithful port and not a
  parity failure. It belongs in the §9 post-migration backlog beside "DRF token → JWT". See **C38**.

The one design choice I would push back on is cosmetic: `PasswordResetTokenService.checkToken`
expires in **seconds** (`:99-100`) where Django expires in whole **days**
(`PasswordResetTokenGenerator.check_token` compares `self._num_days`). v2 is the stricter side by
up to 24 h, no client can observe the difference, and P3-D4 already licenses its own scheme — so
this is a note, not a finding.

### 4. Test quality — where else is an assertion satisfied by something other than the behaviour?

The false-green register is at fifteen and the countermeasures listed in §7 are the right ones.
Applying the same lens to the **committed suite** (not the tester's harness), I found four places
where a green cell would survive a real defect. All are cheap; none is a blocker.

1. **`test/user.e2e-spec.ts:815-822` — the D16 cell asserts only the status.** It sends a changed
   `identification` as a MEMBER and expects 403. It does **not** read the row back. The sibling
   `role` cell one block up (`:804-813`) does exactly that. A 403-that-also-writes would pass here.
2. **There is no positive control that an ADMIN *can* change `identification`.** `role` has one
   (`:916-926`); `identification` does not. If `IDENTIFICATION_FIELD` were moved from
   `PRIVILEGED_FIELDS` into a deny-always set, every cell in the suite would still be green while
   D16 became "nobody may ever change a cédula" — which silently breaks the treasurer's ability to
   correct the TSV join key.
3. **There is no cell for a TREASURER writing their *own* `finance`.** The D1 table allows it
   (`canWriteSection` returns true for `finance` on any target, `user-patch.policy.ts:370-373`), so
   the behaviour exists, is money-visible, and is untested. See also **m6**, which is the business
   question underneath it.
4. **There is no cell for a member changing their own `email`.** That is the field D15 stopped
   mirroring into `username` and the field D17 keys the reset account off — the two Phase 3
   deviations that interact. See **M5**.

Beyond the suite: the parity report's own §11 records that `activate_user` with `"password": null`
was never run on either stack. `user.service.ts:887-891` implements it (an unusable password,
silently), and the deviations doc §2.9 describes it. It is the one branch of an unauthenticated,
public, account-taking-over endpoint that nobody has measured. One cell. See **C37**.

### 5. Phase 4 readiness

Phase 3 leaves Phase 4 in good shape on the hard parts and sets one bad precedent.

**Good:** `UserSqlClient` / `UserProfileReader` (`user.service.ts:1025-1030`) force the transaction
client through every call — the discipline `bulk_update_loans`'s fund-wide auto-close will need,
and the comment records that it was learned the hard way. `assertOwnership` already exists with an
`alsoAllowRoles` parameter shaped for D10. `SchedulerTaskRepository` deliberately has **no
`processed` predicate** on `removeSchNotifications`, which R4.2 proved is v1's real behaviour
(owner 15's three historical rows were deleted too) — Phase 4's payout path calls the same method
and now inherits a verified port rather than a guess. D22/D23 are pre-declared so they cannot be
re-filed. `roundHalfEvenToBigInt` and `days360` are in place.

**Bad, and it is the same defect as M1 one level up:** `new Date().getFullYear()` at
`user.service.ts:652`. Phase 4 is full of `date.today()`-equivalents — `LoanDetail.from_date`,
`payday_limit`, the T−5d/T−1d reminder run dates, `days360`'s endpoints. If the reflex that
produced line 652 recurs there, the error is no longer "a birthday notification lands a year late"
but "an amortisation row is dated a day early for 21 % of every day", which is money-visible and
which CI will never show. Fixing line 652 now, with a lint-visible reason, is worth more than the
bug it fixes.

**Friction, not risk:** the four TSV primitives Phase 4 needs — `djangoFileLines`,
`requireColumn`, `parseMoneyColumn` (`user.service.ts:1122-1150`) and `readUploadedFile` — are all
private to or exported from the users module. `bulk_update_loans` parses an identically shaped
file. Two copies of `int(round(float(x), 0))` is how the two silently diverge. **C36**.

### 6. What the plan gets wrong

* **D21's row was not corrected**, though `MIGRATION_PLAN.md:14` (v3.0) and the commit message of
  `e926e14` both say two rows were. `git show e926e14 -- MIGRATION_PLAN.md` changes **only D22**.
  D21 at `:849` still reads "Status and `Content-Length` are byte-identical to v1 on **every
  route**", where `docs/parity-phase-3.md` R4.3 measured 10/11 and named the exception (the 404
  handler, 77 bytes of HTML vs 23 of JSON — D13). **M4.**
* **`_prisma_migrations` in the shared `fondodev`** is inert today (`0_init`,
  `applied_steps_count = 0`) but the plan has no row deciding what happens to it at Phase 9, when
  D11's `UNIQUE (user_id)` and the `hstore → jsonb` conversion become v2's first real migrations
  against a database that Django's `django_migrations` (38 rows) also describes. Two migration
  ledgers, one schema. **C39.**
* **§5's D11 row still says "Phase 3"** in its Phase column while its own status text moves the
  physical constraint to Phase 9. `docs/phase-3-deviations.md` §5.4 asked for this; the status cell
  was updated and the Phase cell was not. Minor bookkeeping, same species as M4.
* **Plan §3, Phase 3 parity criteria** still does not list the `GET /api/user/<id>` authorisation
  question at all — see **M2**. That is the substantive one.

---

# Findings

Severity: **blocker** re-opens the phase · **major** = a condition on the gate · **minor** /
**nit** = fix when convenient.

## Blockers

**None.**

---

## Major

### M1 — `datetime.now().year` is read in the host time zone, not Bogotá

**Where:** `src/users/user.service.ts:652`
```ts
const thisYear = new Date().getFullYear();
```
**v1:** `fondo_api/services/user.py:268` — `today_year = datetime.now().year`, evaluated in a
process whose `TZ` Django has pinned to `America/Bogota`
(`django/conf/__init__.py::Settings.__init__`, verified in the plan's rule 5 / condition C4).

**What is wrong:** `Date.prototype.getFullYear()` reads the *host* zone. Every other calendar
decision in v2 goes through `todayInBogota()` / `todayForAutoNowDateField()`
(`src/common/utils/timezone.util.ts:129, 164`), which exist precisely so the zone is never
inherited; this one line bypasses them. It is the only such site in `src/` (grep for
`getFullYear|getMonth\(\)|getDate\(\)` returns exactly this and one `toUTCString()` for an HTTP
`Expires` header, which is correct).

**Why it matters:** between 19:00 and 24:00 Bogotá on 31 December, a host running UTC computes
`thisYear + 1`. The birthday `SchedulerTask` is then written with `run_date` a full year out, and
because `repeat = 4` clones it forward, the member's birthday notification is skipped for a whole
year rather than by a day. It is also a genuine parity divergence that the tester could not
possibly have caught — no round ran in that window, and none ever will on purpose. More
importantly it is a **precedent**: Phase 4 makes the same call for `from_date`, `payday_limit` and
the two reminder dates, where a one-day error is money-visible.

**Fix:** `const thisYear = todayInBogota().year;` — the helper is already imported into this file's
neighbourhood (`timezone.util` is imported at `:24-28`). Add a unit test that fixes the clock to
`2026-01-01T02:00Z` (= 2025-12-31 21:00 Bogotá) and asserts the task is scheduled in **2025**;
that test fails against the current line. **Condition C28.**

---

### M2 — `GET /api/user/<id>` has no ownership check, and no §5 row ever opened the question

**Where:** `src/users/user-detail.controller.ts:65-72`; `src/users/user.service.ts:282-303`
**v1:** `fondo_api/views/user.py:43-50` with `list_permissions['UserDetailView']['GET'] = 3`
(`fondo_api/permissions.py:13-17`).

**What is wrong — nothing, against the parity contract.** v2 ports v1 exactly, which is the rule.
The finding is against the **register**, not the code: any authenticated MEMBER can `GET
/api/user/<any id>` and receive that member's full `UserFinanceSerializer` block —
`contributions`, `balance_contributions`, `total_quota`, `available_quota`, `utilized_quota` and
`total_savingaccounts` — plus their `identification`, email and preferences
(`fondo_api/serializers.py:20-36`). Fifteen members, each able to read every other member's
savings and debt position.

**Why it matters, and why it is not "just v1's behaviour":** the operator was asked this exact
question about the *loan* read and answered it. **D10** (Q16) restricts `GET /api/loan/<id>` to the
loan owner plus roles `[0,1,2]` because "loan read is open to any member by id". The user-finance
read is the same shape, is arguably more sensitive (it is the aggregate the loan is a slice of),
and no row exists for it. That looks like an omission in the register rather than a decision — and
Phase 3 is the phase whose stated purpose is closing exactly this class of hole. Shipping the phase
with D1 closed and this open leaves the register self-inconsistent, and a reader of §5 in six
months will reasonably conclude the openness was deliberate.

**Fix:** do **not** change the code on my say-so. Escalate to `business-analyst` as a new Q29:
*"D10 restricts loan-detail reads to the owner plus `[0,1,2]`. `GET /api/user/<id>` returns the
same member's full finance block to any member. Is that intended, or is it D10's missing twin?"*
If the answer is "restrict", the primitive already exists — `assertOwnership(actor, id, [0,1,2])`,
`src/auth/policies/ownership.ts:57-70` — and the change is three lines in
`user-detail.controller.ts:71`, plus a §5 row and a `manual-tester` expectation. If the answer is
"leave it", record that as a decided row so it stops looking like an oversight.
**Condition C29.** This decision should be made before **Phase 4** closes, because Phase 4
implements D10 and the two answers ought to be consistent.

---

### M3 — D2 closes half of what it was decided to close: any member can still trigger the fund-wide letter

**Where:** `src/users/power.service.ts:117-145` (`createPower`) and `:227-274` (`updatePower`)
**v1:** `fondo_api/services/user.py:165-192` (create) and `:193-206` (approve)
**Register:** §5 **D2** — *"Approving a power request has no check that the caller is the
requestee… any member can approve any power request **and trigger the fan-out**"* → restrict (Q17).

**What is wrong:** the restriction implemented is literally Q17's — `assertOwnership(actor,
power.requestee_id)` at `:247`. But neither v1 nor v2 checks that `requester ≠ requestee`. A member
can therefore:

1. `POST /api/user/power` with `{"type":"post","requestee": <their own id>, "meeting_date": …}` —
   allowed, role ≤ 3, no validation (`:121-138`);
2. `POST /api/user/power` with `{"type":"patch","id": <that id>,"state":1}` — they *are* the
   requestee, so `assertOwnership` passes;
3. the `POWER_APPROVED` letter goes to **every active member** (`:258-273`).

So the second clause of D2's own problem statement — "and trigger the fan-out" — is still open, at
two requests instead of one. v1 is worse (one request, any power id), so this is **not a parity
failure and not a regression**; it is a question about D2's intended scope that nobody has been
asked.

**Why it matters:** the fan-out is a formal Spanish power-of-attorney letter naming two members,
sent to the whole fund. Under D5 it now goes out blind-copied, which makes it *less* noticeable,
not more. There is no rate limit and no state-transition guard (see m4), so the loop is repeatable.

**Fix:** escalate to `business-analyst` as Q30: *"Should a member be able to name themselves as
requestee on a power request? Should approving a power request whose requester is the requestee be
refused?"* The natural answer is that a power of attorney is by definition delegation to somebody
else, so `requester_id === requestee_id` should be a refusal at `createPower`. That is a
four-line change and a §5 row. Do not implement it before the answer — it changes product
behaviour. **Condition C30.**

---

### M4 — the plan says it corrected D21 and it did not

**Where:** `MIGRATION_PLAN.md:14` (v3.0 changelog), `MIGRATION_PLAN.md:849` (the D21 row), and the
commit message of `e926e14`.
**Evidence:** `git show e926e14 -- MIGRATION_PLAN.md` touches exactly one register row — D22. D21's
v2 column still reads:

> **Status and `Content-Length` are byte-identical to v1 on every route**

`docs/parity-phase-3.md` R4.3 measured 10/11 and named the exception explicitly: the 404 handler,
where v1 sends 77 bytes of HTML and v2 sends 23 of JSON, i.e. D13.

**Why it matters:** the plan itself states the principle — *"a registration that misdescribes
behaviour silences a real future signal"* (v3.0 changelog). A cross-cutting row that claims
`Content-Length` parity "on every route" is precisely the row a Phase 5–8 tester will cite to
dismiss a `Content-Length` difference they should have filed. And a commit message that describes a
change the commit does not contain is worse than the stale text, because it defeats the obvious
audit (`git log --grep`).

**Fix:** amend D21's v2 column to *"Status and `Content-Length` are identical on 10 of the 11
routes measured; the 404 handler differs in `Content-Length` because its body differs — that is
**D13**, not D21."* One sentence. **Condition C31.**

---

### M5 — D15 + P3-D2 together create a new class of account that can never self-reset

**Where:** `src/users/user.service.ts:536-612` (D15: `username` is no longer written) and
`:389-426` (`getUserByEmail`, D17's tie-break)
**Register:** D15, D17, P3-D2.

**What is wrong:** D17's rule for a duplicated email is *"the account whose `username` **is** the
email"* (`:417`), with `null` — no mail sent — when no candidate matches (`:419-425`). In v1 that
rule is self-repairing, because `__update_user_personal` writes `user.username = obj['email']`
(`fondo_api/services/user.py:230`): whenever a member's email changes, their username follows it,
so the "username === email" candidate keeps existing. **D15 removes that write**, and **P3-D2**
turns the resulting duplicate-email PATCH from v1's 409 into a 200.

So in v2, and only in v2:

* member A (`username = a.member`, `email = a@x`) changes their email to `c@x`;
* member B already has `email = c@x`, `username = b.member`;
* now two rows share `c@x` and **neither** has it as its `username`;
* `getUserByEmail('c@x')` logs a warning and returns `null`;
* `POST /password_reset/` redirects to the success page and **sends nothing** — which is the exact
  live failure D17 was written to fix, re-created by a member's ordinary self-service edit.

Today's four affected members (7/10/13/14) are fixed by D17 because their usernames happen to match.
The new path has no such luck.

**Why it matters:** this is not v1 behaviour ported; it is an emergent property of two Phase 3
deviations that were each reviewed alone. Both are correct individually — D15 must stay (it stops
rotating a login credential silently and unblocks the two child accounts) and P3-D2 follows from
it. The interaction is what nobody looked at, and it is invisible to a parity round because v1
cannot reach the state.

**Fix (pick one, cheap either way):**
* give `getUserByEmail` a deterministic fallback when no `username` matches — lowest id, which is
  what `orderBy: { id: 'asc' }` at `:400` already computes and then discards — so a member is never
  silently unresettable; **or**
* refuse a `personal` update whose new `email` already belongs to another active `auth_user` row,
  which restores v1's 409 for the case that actually mattered without restoring the `username`
  write.

The first is one line and preserves the "no user enumeration" property; the second is a product
decision and would need `business-analyst`. Either way, add the e2e cell §4 item 4 asks for.
**Condition C32.**

---

## Minor

### m1 — `remove_all_subscriptions` moved outside v1's bare `except`; unregistered, and the comment contradicts itself

**Where:** `src/users/user.service.ts:820-828`
```ts
// Outside the try in v2 as well as in v1: the subscription wipe is *after* the save, and
// a failure in it is not a 404 (`remove_all_subscriptions` is inside v1's try, but it
// cannot raise anything the bare except would have hidden usefully …)
```
The first clause says v1 has it outside the `try`; the third says it is inside. v1 has it
**inside** (`fondo_api/services/user.py:217-218`, above the bare `except: return (False, 404)` at `:219`), so a
failing subscription delete is a **404** in v1 and an uncaught **500** in v2.

Unreachable without a database fault, and v2's answer is arguably the better one — but it is an
unregistered behavioural difference in a phase where the whole method is "an unregistered diff is a
parity failure". Either register it in `docs/phase-3-deviations.md` §1.2 as P3-D9 with the "an
operator needs to see a failed delete" reasoning, or move the call back inside. Fix the comment
either way. **C33.**

### m2 — `changedFields` compares large integers through `Number`, which is a D16 bypass above 2^53

**Where:** `src/auth/policies/user-patch.policy.ts:335-354` (`normalise`)
```ts
const asNumber = Number(value);
return value.trim() !== '' && Number.isFinite(asNumber) ? asNumber.toString() : value;
```
`identification` is a `BigIntegerField`. With `stored = 9007199254740992n` and the body carrying
the **string** `"9007199254740993"`, both sides normalise to `"9007199254740992"`, the field is
reported unchanged, the ADMIN-only gate never fires, and `toDjangoInt`
(`src/users/python-obj.ts:92-97`, which uses `BigInt` and is exact) writes the *different* value. A
non-ADMIN silently changes their own cédula — the write D16 exists to prevent.

Unreachable with real data (Colombian cédulas are ~10 digits; 2^53 ≈ 9·10^15) and nothing in
`fondodev` is close. But the comparator is a security primitive, it is the one Phase 4 will reuse
for D10's ownership comparisons, and the fix is small: in `normalise`, when the string matches
`/^[+-]?\d+$/`, return `BigInt(trimmed).toString()` and only fall back to `Number` for the genuinely
fractional case. Add the two cells. **C34.**

### m3 — `PowerService.updatePower`'s doc claims a security property the code does not have

**Where:** `src/users/power.service.ts:216-217`
> "The refusal is DRF's generic 403, identical to a role denial, so it cannot be used to discover
> which power ids exist."

The row is loaded at `:234-240` **before** `assertOwnership` at `:247`, so a non-existent id is a
**500** (`PythonTypeError`, `:243`) and an existing-but-not-mine id is a **403**. Those are
distinguishable, so the endpoint *is* an existence oracle. v1 leaks the same way (200 vs 500), so
this is not a parity issue and the leak is low-value (20 rows, sequential ids) — but the comment
asserts a property that a later reader will rely on. Either delete the claim, or answer 403 for
both by checking ownership against a `select: { requestee_id: true }` probe first. **C35.**

### m4 — no state-transition guard on `Power`, so re-approving re-fans the letter

**Where:** `src/users/power.service.ts:249-273`; v1 `fondo_api/services/user.py:193-206`.
Approving an already-approved power writes `state = 1` again and sends the fund-wide letter again.
There is no `0 → 1 / 0 → 2` restriction of the kind **D9** imposes on loans (Q14). Faithful to v1,
so not a parity failure, and not worth fixing unilaterally — but it is the same species of question
Q14 answered for loans, it compounds M3, and it is absent from the register. Fold it into the
**C30** escalation rather than filing it separately.

### m5 — the D16 e2e cell asserts a status and nothing else; the ADMIN positive control is missing

**Where:** `test/user.e2e-spec.ts:815-822`. Add `expect(row.identification).toBe(500001n)` after the
403 (the `role` cell at `:804-813` is the model), and add a cell in which an **ADMIN** changes
another member's `identification` and the row moves — without it, "identification is never
writable by anyone" is green. **C37.**

### m6 — a TREASURER may set their own `total_quota`, which the D1 table allows and Q12 forbids

**Where:** `src/auth/policies/user-patch.policy.ts:370-372` — `canWriteSection` returns true for
`finance` for `[ADMIN, TREASURER]` on **any** target, self included. That is exactly what the §5
D1 table says ("TREASURER · `finance` section · ✅ any user"), so the implementation is right.

The tension is with Q12, reconfirmed twice: *"Quota comes **exclusively** from the treasurer's
monthly file."* A treasurer who can PATCH their own `finance` can set their own `available_quota`
between uploads and borrow against it, and the next monthly file overwrites it — so the window is
one month and it leaves no trace beyond `last_modified`. That may be entirely acceptable (the
treasurer is trusted with everyone else's quota already), but the D1 table's own footnote flags the
TREASURER self-service cell as *"the one cell in this table the operator did not state directly"*,
and it flags it for `personal`, not for `finance`. Worth one confirmation in the same
`business-analyst` round as C29/C30, and one e2e cell either way (§4 item 3). **C38.**

### m7 — `activate_user` with `"password": null` is implemented, documented and never measured

**Where:** `src/users/user.service.ts:887-891`; `docs/phase-3-deviations.md` §2.9;
`docs/parity-phase-3.md` §11 records that the cell was not run "because I had no disposable user
left". It silently activates an account with an unusable password on a **public, unauthenticated**
endpoint. One e2e cell on a seeded user asserting `is_active = true`, `key_activation = null` and a
password beginning `!` closes it without needing v1. **C37.**

---

## Nits

* `src/users/user.service.ts:825` — `void actor;` inside `updateUserPreferences`. The parameter is
  unused because the section gate already ran. Drop the parameter rather than voiding it, or the
  next reader will wonder what authorisation was meant to happen here.
* `src/users/power.service.ts:121, 231` — `toDjangoSmallInt` is used for `requestee` and `id`, which
  are `AutoField` (int4) columns, not smallints. Both paths 500 either way today, so nothing is
  observable; rename to `toDjangoInt`-backed `toDjangoIntNumber` or widen, so a future 32768th power
  row does not produce a confusing failure.
* `src/users/python-obj.ts:167-176` — `pythonNotEqual` returns `true` (changed) for a submitted
  boolean against a stored integer. Python's `0 == False` and `1 == True`, so a finance body sending
  `contributions: false` against a stored `0` is a no-op in v1 and a write (moving `last_modified`)
  in v2. Two lines; nothing sends it.
* `src/users/user.service.ts:1143-1150` — `parseMoneyColumn` uses `Number(raw)` for CPython's
  `float(str)`. They disagree on `"0x10"` (16 vs `ValueError`) and `"1_000"` (`NaN` vs 1000.0).
  Both are 500-vs-write divergences on a treasurer TSV nobody will produce. Worth pinning when the
  function moves into the shared module C36 asks for, since Phase 4 reuses it on a fund-wide file.
* `MIGRATION_PLAN.md:861` — D11's **Phase** column says `P3`; its own status text and
  `docs/phase-3-deviations.md` §5.4 move the physical constraint to Phase 9. Same species as M4.

---

# Conditions (C28 – C39)

Graded by deadline, per the plan's convention.

**Before Phase 4's first controller:**

| # | Condition | From |
|---|---|---|
| **C28** | Pin `user.service.ts:652` to `todayInBogota().year`, with a clock-fixed unit test at 2026-01-01T02:00Z that fails against the current line. Phase 4 must not inherit the reflex. | M1 |
| **C36** | Move `readUploadedFile`, `pythonInt`, `lastQueryValue`, `djangoFileLines`, `requireColumn` and `parseMoneyColumn` out of `src/users/user.controller.ts` / `user.service.ts` into shared modules (`common/http/django-multipart.ts`, `common/http/django-query.ts`, `common/http/django-tsv.ts`). Then write the **"adding a route" checklist** — URL-conf entry, `@V1View`, permission-matrix row, `@All()` fallback + `Allow` string, `@DrfNoRequestData()` when the handler never reads the body, `readUploadedFile` for file parts, `DrfViewHeaders.renderers` — into `MIGRATION_PLAN.md` §4 rule 14 or a `docs/adding-a-route.md`. This is what makes Phases 4–8 mechanical. | Q2, Q5 |

**Before Phase 4 closes:**

| # | Condition | From |
|---|---|---|
| **C29** | Escalate to `business-analyst` (Q29): is `GET /api/user/<id>`'s open read D10's missing twin? Decide port-or-fix and add a §5 row either way. Must be answered before Phase 4 implements D10, so the two agree. | M2 |
| **C30** | Escalate to `business-analyst` (Q30): self-directed power requests, and whether re-approving an approved power should re-send the letter. Fold m4 in. | M3, m4 |
| **C32** | Close the D15 + P3-D2 unresettable-account path — deterministic lowest-id fallback in `getUserByEmail`, or refuse a duplicate-email personal update. Add the e2e cell. | M5 |
| **C34** | `normalise` must compare decimal-integer strings as `BigInt`, not through `Number`. Two cells. | m2 |
| **C37** | Test additions: assert the row on the D16 403; an ADMIN-changes-identification positive control; a TREASURER-writes-own-finance cell; a member-changes-own-email cell; and the `activate_user` `"password": null` cell. | §4, m5, m7 |
| **C38** | Record in `MIGRATION_PLAN.md` §9's post-migration backlog that a completed password reset does **not** invalidate `authtoken_token` (v1 and v2 alike), beside "DRF token → JWT". And put the TREASURER self-`finance` cell (m6) to `business-analyst` in the same round as C29/C30. | §3, m6 |

**Bookkeeping, before the next plan revision:**

| # | Condition | From |
|---|---|---|
| **C31** | Correct D21's v2 column to say 10 of 11 routes, naming the 404 handler as D13. | M4 |
| **C33** | Register or revert the `remove_all_subscriptions` 404→500 move, and fix the self-contradicting comment at `user.service.ts:820-823`. | m1 |
| **C35** | Delete or satisfy the "cannot be used to discover which power ids exist" claim at `power.service.ts:216`. | m3 |
| **C39** | Add a Phase 9 row deciding how `_prisma_migrations` (inert `0_init`, `applied_steps_count = 0`) and `django_migrations` (38 rows) coexist when v2 runs D11's `UNIQUE (user_id)` and the `hstore → jsonb` conversion — two ledgers describing one schema. Fix D11's Phase column to P9 while there. | §6 |

---

# Gate verdict

The Phase 3 code is correct where it matters most. **D1 — the live production privilege escalation
this phase exists to close — is closed, and I could not open it.** The section gate precedes the
row load, the comparator is the right one and its reasoning survives inspection, `role` and
`identification` are ADMIN-only on change, the 403 body is indistinguishable from a role denial,
and C20's view binding means the rules applied are the rules of the view that actually runs. The
Django-emulation layer is a coherent stack rather than an accretion. The password-reset design is
sound: the hop is load-bearing for a real reason, the cookie is strictly less state than the
session it replaces and no weaker on any attribute, and the token cannot be replayed or lifted. The
gate inputs I could re-derive — lint, typecheck, 1 602 unit tests, and the §2 hstore confinement
rule — are all green independently of the reports that claim them.

Nothing I found re-opens the phase. What I found is a set of things parity against v1 is
structurally blind to: a host-zone dependency that Phase 4 must not inherit, two authorisation
questions the register never opened rows for, one emergent interaction between two individually
correct deviations, and one registration the plan believes it corrected. Four of the twelve
conditions are escalations to `business-analyst` rather than code changes, and I have deliberately
not pre-judged them.

## **Approved with conditions.**

**Phase 4 may start now.** C28 and C36 must land before Phase 4's first controller — they are the
two that Phase 4 would otherwise copy. C29–C35 and C37–C39 are tracked to closure before Phase 4's
own gate, and C29 in particular must be answered before D10 is implemented, so that the loan read
and the user read are decided consistently rather than differently by accident.

**Escalated to `business-analyst`:** Q29 (M2 — the `GET /api/user/<id>` finance read vs D10),
Q30 (M3/m4 — self-directed and re-approved powers of attorney), and the TREASURER
self-`finance` cell (m6) against Q12.

**Recognition where it is due:** the tester's refusal to accept F6 as a re-worded P3-D8 is the
finding that justifies this pipeline's existence, and the developer's decision to *implement*
F6 and F8 rather than register them was the right call both times.
