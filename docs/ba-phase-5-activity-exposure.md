# BA — Phase 5: `GET /api/activity/<id>` and the nested member roster

Answers the escalation in `docs/phase-5-deviations.md` §3.2. Companion to
`docs/ba-phase-3-c29-c30-m6.md` and `docs/operator-q29a-q30a-q31.md`.

> **Verdict: Aligned — port, register as accepted (`D36`).**
> The profile fields are **already fund-open** by `GET /api/user`, which is `GET 3` and
> serialises the *same* `UserProfileSerializer`. On the roster fields this is a **non-finding**:
> an ownership check on the activity route would close nothing, because the adjacent list
> reopens it in one call. The only genuinely new fact is **who is attached to an activity and
> whether they paid** — and everything in the code and the data says that is a shared social
> ledger, not fund accounting. One operator question (**Q32**) could flip it; it does **not**
> block Phase 5, because porting is the answer under either outcome for the fields, and the
> e2e suite already pins the current behaviour.

---

## 1. The roster fields are already open — this is a non-finding

Measured, not inferred.

| | route | rule | serializer | scope |
|---|---|---|---|---|
| the "new" exposure | `GET /api/activity/<id>` | `ActivityDetailView.GET: 3` | `UserProfileSerializer`, nested per attached member | members attached to that activity |
| the route nobody questioned | **`GET /api/user`** | **`UserView.GET: 3`** (`fondo_api/permissions.py`) | **`UserProfileSerializer`, `many=True`** (`services/user.py:60-70`) | **every active member, unpaginated when `?page` is absent** |

Same serializer class, therefore the identical field set — `full_name`, `identification`,
`email`, `role_display`, `id`, `first_name`, `last_name`, `role`, `birthdate`. (The escalation's
field list omits `role_display`; it is there on both.) v2 reuses the same function on both
paths: `src/activities/dto/activity.serializers.ts:115` calls `serializeUserProfile` from
`src/users/dto/user.serializers.ts`, which is what `UserController.list` returns.

So **any authenticated member can already fetch the entire membership roster with those fields
by one call to `GET /api/user`**, in v1 and in v2 as shipped. The activity route adds no field
and no member that call does not already return. v2's 280-cell role matrix
(`test/role-matrix.e2e-spec.ts`) pins `UserView GET` open to all four roles, so this is not an
accident of the port.

### This is not a gap in D25 — D25 said so on its face

D25's *Change* column already reads: *"Profile-only lookup keeps working through the
**unrestricted list** and `POST /api/user/birthdates`."* D25 restricted the detail route for a
reason that does not exist here: its subject was the **`finance` block** — `utilized_quota`
(a member's aggregate outstanding debt) and `total_savingaccounts` (their CAP deposits). D10's
subject was another member's **loan** — value, payment, state. Both are money positions.
`ActivityDetailSerializer` returns **no finance and no loan data**; `Activity` and `ActivityUser`
appear nowhere in v1 outside their own module (grepped: `urls.py`, `models.py`, `serializers.py`
only — no finance, no quota, no bulk upload, no notification, no scheduler).

**Nothing to reopen against D25.** Worth one sentence in the register so a future reader sees a
decision rather than an inconsistency, which is what `D36` below is for.

### And the D10/D25 predicate does not transfer anyway

"The record's owner plus `[0,1,2]`" needs a record with **one** owner. An activity has thirteen.
The only shape that check could take here is *filter the nested `users` array to the caller's own
row unless the caller is `[0,1,2]`* — which is not a permission change, it is a **response-body
change** that would empty out whatever screen renders the list. That is a bigger, more
client-visible move than D10 or D25 were, on weaker grounds.

---

## 2. What the activity route *does* add

Two things, both small, both real.

### 2.1 Attachment + payment `state` — the only new fact

`GET /api/activity/<id>` is the **only** route in either stack that says *who is on the hook for
an activity and whether they have paid*. Nothing else exposes `ActivityUser.state`.

### 2.2 Soft-deleted members' profiles survive on old activities

`get_users` and `get_users_birthdate` both filter `is_active=True`; `__add_users` filtered it
**at creation time**, so a member who leaves stays attached to the activities that predate their
departure. Live consequence, verified:

* `fondodev` has **15** members, **13** active. Users **3** (`Fernando Herrera`) and **15**
  (`Angi Paola Sanchez Quilindo`) are inactive.
* Both are attached to activities **20** and **21** (2024) — those two rows carry all 15 members;
  every 2025/2026 activity carries exactly the 13 active ones.
* So `GET /api/activity/20` returns the **email, `identification` and `birthdate` of two
  ex-members** that `GET /api/user` no longer lists. User 3 appears on 19 activity rows, user 15
  on 5.

This is a genuine residual — the roster list does *not* cover it. It is also unchanged from v1,
tiny (two people, both family), and would not be fixed by the D10/D25 predicate. Recorded in
`D36`; not worth its own control.

---

## 3. What an activity actually is at the fund — from the data

`fondo_api_activity`, all 25 rows, 2018 → 2026:

> Actividad deportiva · Almuerzo semana santa · **Polla** (2018) · Rifa a ciegas · Polla copa
> América · Almuerzo · **Bingo** · Rifa edredón ovejero · Bingo subachoque · Desafío anapoima ·
> Rifa olla multifuncional · Bingo Jueves Santo · Rifa Maleta · Polla mundialista · Rifa Edredón
> · Bingo · Elabora tu disfraz 🥸 · Polla copa América 2024 · Rifa cine Colombia con combo · Rifa
> Edredón · Elabora tu cometa · Bingo · Carrera de observación · Polla mundial · Rifa

Raffles, bingos, football pools, Easter lunch, a costume contest, a scavenger hunt. `value`
ranges **15 000 – 100 000** COP, flat and identical for every attached member. Three activities
per year, most years.

Four structural facts point the same way:

1. **Every active member is attached automatically** (`__add_users`, no selection step). There is
   no opt-in, so attachment discloses nothing about an individual — only the fund's own roster,
   which is already open.
2. **The TREASURER is excluded from every write.** `ActivityYearView`/`ActivityYearDetailView`
   `POST` and `ActivityDetailView` `PATCH`/`DELETE` are all `1`, i.e. ADMIN + PRESIDENT; a
   TREASURER gets **403**. Compare CAPs (`[0,2]`) and loan approval (`[0,2]`), which are the
   treasurer's. Whoever runs the party marks who paid; the fund's money officer is not involved.
3. **No activity money reaches `UserFinance`.** No contribution, no quota, no balance. The
   `value` is not summed anywhere. These are not fund accounts.
4. **`EXEMPTED` (state 2) has never been used** — 0 rows in 8 years and 338 records. So the state
   column in practice is a two-value "paid / not yet".

**Reading:** these are shared family events with a per-head contribution, organised by the
president, tracked on a list everyone is on. The roster and the tick-list are plausibly the
*point* of the screen.

### The payment facts a member can read today

`fondo_api_activityuser`: **294 PAID_OUT · 44 NOT_PAID · 0 EXEMPTED** (338 rows).

Of the 44 NOT_PAID, **39** are the three 2026 activities × 13 members — the `default=0` on rows
nobody has marked yet, including a raffle dated **2026-11-21** that has not happened. Only **5**
are historical:

| member | activities | year |
|---|---|---|
| user **9**, Nitza Marisol Montañez Herrera — **the PRESIDENT** | Bingo Jueves Santo, Rifa Maleta, Polla mundialista | 2022 |
| user **3**, Fernando Herrera — **now inactive** | Polla copa América 2024, Rifa cine Colombia con combo | 2024 |

Both patterns read as *did not participate / was on the way out*, not *owes the fund money* —
especially the president's, since she is the role that marks the states. That is an inference
from shape, not a sourced fact; see §6.

---

## 4. Decision: **port**, and register it

**Recommendation: port v1 unchanged, register as an accepted exposure.** Reasons, in order of
weight:

1. **The fields are already open by design.** Restricting the activity route while
   `GET /api/user` returns the same nine fields for the same people is a control that *looks*
   like protection and is not one. That is worse than no control: the next reader assumes the
   roster is protected.
2. **The activity route holds no money position.** D10 and D25 were about debt and savings. This
   is a party list.
3. **The natural "fix" is a body change, not a guard**, and it would break exactly the screen the
   route exists to render (§1, last block).
4. **The developer was right not to do it.** Phase 5 owns no §5 rows; an unregistered ownership
   control is the quiet divergence the register exists to catch. This note is the registration.

### Paste-ready §5 row — `D36` (recommended wording, *accepted*)

```markdown
| **D36** | `GET /api/activity/<id>` is `GET 3` and `ActivityDetailSerializer.get_users` nests the full `UserProfileSerializer` — `identification`, `email`, `birthdate`, `role`, `role_display`, names, `id` — for **every** member attached, and `create_activity` attaches every **active** member. So one GET on any activity returns the whole roster with those fields, plus each member's payment `state`. Raised in Phase 5 as the analogue of **D10**/**D25**. | **Port unchanged — accepted, not a defect.** ⚠️ **The fields are already fund-open by an unrestricted route**: `UserView.GET` is also `3` and `get_users` serialises the **same** `UserProfileSerializer` for every active member (`services/user.py:60-70`), unpaginated when `?page` is absent — v2 reuses one `serializeUserProfile` on both paths. An ownership check here would close nothing. **D25 is not reopened and had no gap**: its subject was the `finance` block (`utilized_quota`, `total_savingaccounts`) and D10's was loan data; its Change column already preserves the open profile list on purpose. `ActivityDetailSerializer` carries **no** finance and **no** loan data, and `Activity`/`ActivityUser` are referenced nowhere in v1 outside their own module. The D10/D25 predicate also does not transfer — an activity has 13 owners, so the only available "fix" is filtering the nested `users` array, a **response-body** change that would empty the screen. Two residuals recorded rather than fixed: (a) **soft-deleted** members stay attached to activities that predate their departure, so `GET /api/activity/20` still returns the email/`identification`/`birthdate` of users **3** and **15**, whom `GET /api/user` no longer lists; (b) payment `state` is visible fund-wide — live: **294 PAID_OUT / 44 NOT_PAID / 0 EXEMPTED**, of which 39 NOT_PAID are the unmarked 2026 defaults and only **5** are historical (user 9, the PRESIDENT, on three 2022 activities; user 3, now inactive, on two 2024 ones). Activities are shared social/fundraising events — bingos, rifas, pollas, an Easter lunch — at a flat **15 000–100 000** COP per head, every active member auto-attached, **writes are ADMIN + PRESIDENT only (the TREASURER gets 403)** and no `value` reaches `UserFinance`. | P5 | ✅ **Registered — port; accepted.** Confirm with operator **Q32** (does the members' activity screen show the whole paid/unpaid list, or only their own row?). A "own row only" answer would move this to a fix — see `docs/ba-phase-5-activity-exposure.md` §5. |
```

Phase 5's `docs/phase-5-deviations.md` §1 ("§5 rows this phase owns: none") and
`MIGRATION_PLAN.md:529` need a one-line amendment if `D36` lands: Phase 5 owned none **at the
time of implementation**, and `D36` was registered by the BA afterwards without changing a line
of Phase 5 code. Nothing in the e2e suite changes — the four role cells that return **200** stay
green and become the pinned expression of `D36`.

---

## 5. If the operator flips it — alternate `D36` (the *fix* wording)

Use this **only** if Q32 comes back "a member sees only their own row". Note it is a body change
and needs its own control run and its own parity cells.

```markdown
| **D36** | (v1 behaviour as above.) | **Fix — scope the nested `users` array.** Roles `[0,1,2]` receive every `ActivityUser`; a MEMBER receives **only their own row**. The route's rule stays `GET 3` and the activity's own fields (`id`, `name`, `date`, `value`) stay visible to everyone, so the screen still renders — only the other members' rows are withheld. ⚠️ **This is a response-body change, not a permission change**: `manual-tester` must read a shorter `users` array on a MEMBER token as an **expected** diff, and the four Phase 5 e2e role cells that assert 200-with-13-users need re-pinning per role. Also closes the soft-deleted-member residual (a) as a side effect for MEMBER callers only — roles `[0,1,2]` keep seeing ex-members' profiles, which is correct for the people who run the events. | P5 (re-opened) | ⏳ **Decided — fix, pending Q32** |
```

---

## 6. What I cannot source, and exactly what I need

Both are fund practice, invisible from the code, the database and the docs.

**Q32 — blocking only for the *state* half; not blocking Phase 5.**
> On the activities screen, does a MEMBER see the **full list** of members with who has paid and
> who has not, or **only their own row**? (Q29a answered the sibling question for member detail
> and finance: *no, members only see themselves.* Activities may well be the opposite, because
> they are shared events — but I will not assume it. Only the fund's own client can answer;
> this repo does not contain it.)
>
> * *"Full list"* → `D36` **accepted** as written in §4. Closing the route would break a live
>   screen — the reverse of Q29a's outcome.
> * *"Own row only"* → `D36` becomes the **fix** in §5.

**Q33 — not blocking, one line.**
> Does `NOT_PAID` on a past activity mean **"owes the fund"** or **"chose not to take part"**?
> The data cannot distinguish them: `state` defaults to `0` and nothing ever times out. The
> answer decides whether the five historical rows in §3 are a debt the whole fund can read, or
> an attendance record. It also decides whether the **`EXEMPTED`** state — defined in
> `ActivityUser.STATE_TYPES` since 2018 and used **zero times in 338 rows** — is dead code the
> fund never needed, or a facility nobody was told about. If the latter, a member who is
> genuinely excused is currently carried as `NOT_PAID` in front of everyone.

---

## 7. Notes for the phase record

* **No rounding, rate, day-count, permission or email-recipient change** is proposed or implied
  by this note. The recommendation changes **nothing** in v2's behaviour.
* **Not a member-facing regression either way at cutover**: v1 and v2 behave identically on this
  route today.
* **Alexa:** nothing in the activity surface touched the `RequestLoan` intent — `views/alexa.py`
  is loan-only. Its removal has no bearing on this decision.
* ⚠️ **If `GET /api/user` is ever restricted**, this row must be revisited in the same change:
  the whole "already open" argument rests on it, and closing the list alone would leave the
  activity route as the way around it. Any such move needs its own operator question, because
  the member directory is plausibly a screen the fund uses.
