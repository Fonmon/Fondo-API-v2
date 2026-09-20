# Phase 3 — business-analyst ruling on C29 (Q29), C30 (Q30) and C38/m6

**Author:** `business-analyst`. **Date:** 2026-09-03.
**Inputs:** `docs/review-phase-3.md` M2 / M3 / m4 / m6, `MIGRATION_PLAN.md` v3.x §5 (register)
and §9 (operator Q&A), v1 `fondo_api/{views,services,serializers,permissions}.py`,
`fondo_api/templates/power/power_email.html`, live `fondodev` (read-only).
**Standing constraint honoured:** v1 is frozen. Every ruling below is either *port as-is and
register the gap* or *diverge and register the fix*. Nothing is proposed for v1.

## Verdict: **Concerns** — three rulings, all *fix*, two of them carrying one operator fact each

| Ref | Ruling | New §5 row | Safe to implement before the operator answers? |
|---|---|---|---|
| **C29** — user finance read | **Fix** — mirror D10 exactly | **D25** | ⚠️ One rollout fact first (Q29a) |
| **C30(a)** — self-directed power | **Fix** — refuse `requester === requestee` | **D26** | ⚠️ One practice fact first (Q30a) |
| **C30(b) / m4** — re-approval re-sends the letter | **Fix** — mirror D9's transition guard | **D27** | ✅ Yes |
| **m6 / C38** — TREASURER self-finance write | **Fix** — block self-write of `finance` for TREASURER only | **D28** | ⚠️ Bundle with Q31 |

None of the three touches the retired Alexa `RequestLoan` path, so Q13 is unaffected.

---

## C29 / Q29 — `GET /api/user/<id>` finance block: **this is D10's twin, and the answer is the same**

### What the finance block actually contains

`UserFullInfoSerializer` (`fondo_api/serializers.py:20-36, 42-62`) returns three blocks for **any**
member id to **any** authenticated member (`list_permissions['UserDetailView']['GET'] = 3`):

| Block | Fields | Fund-open? |
|---|---|---|
| `user` | `full_name`, `first_name`, `last_name`, `id`, `email`, `role`, `role_display`, `birthdate`, `identification` | **Yes — already, by decided design.** `birthdate` is fanned out to every other member as a yearly birthday notification. `identification` (cédula) is printed for **both** parties in the power-of-attorney letter that Q10 confirmed goes to **all members**. Names, emails and roles are the membership roll. |
| `preferences` | `notifications`, `primary_color`, `secondary_color` | Yes — UI settings, no money, no access. |
| `finance` | `contributions`, `balance_contributions`, `total_quota`, `available_quota`, **`utilized_quota`**, `total_savingaccounts`, `last_modified` | **No — this is the disputed set.** |

So the answer to "name what the finance block contains and whether all of it is fund-open" is: the
profile half is *already* fund-open by two decisions the operator has made, and the argument stops
at the finance half. Within that half the fields are not equivalent:

* `contributions` / `balance_contributions` — what the member has paid in. This is the part a family
  fund plausibly does discuss openly; it is the assembly's own subject matter.
* `total_quota` — a deterministic function of `balance_contributions` in live data (≈3×), so it
  discloses nothing `balance_contributions` does not.
* **`utilized_quota` and `available_quota` — the member's outstanding debt to the fund.** This is
  the aggregate over *all* of that member's loans.
* **`total_savingaccounts`** — the member's CAP deposits, computed live over `state = 0`
  (`serializers.py:32-35`). Q19/Q24 established the CAP is a private fixed-term deposit that is
  *purely informative* to the fund's quota maths. It is a savings position, not a fund obligation.

### Why this is the same question D10 answered, not a different one

Two facts from v1's own code decide it:

1. **v1 already treats a member's debt as not-fund-open — everywhere except the by-id read.**
   `LoanView.get` (`views/loan.py:20-40`) scopes the loan list: roles `[0,1,2]` may pass
   `all_loans=true`; a MEMBER is hard-filtered to `user_id = self`. The list is the endpoint the
   client actually uses, and it is scoped by design. D10 (Q16) closed the by-id hole so the detail
   agrees with the list. That is the shape of the decision, and it was about **debt**.
2. **The user list carries no finance at all.** `get_users` serialises with
   `UserProfileSerializer` (`services/user.py:60-70`) — profile only. There is no "open by design"
   list counterpart for finance anywhere in v1. `GET /api/user/<id>` is the *single* route through
   which one member can read another's money position.

Restricting one loan's `value`/`payment` (D10) while leaving the **aggregate of every loan that
member holds** (`utilized_quota`) open to the same caller is incoherent: the aggregate is strictly
more revealing than the slice. Leaving C29 open does not "port v1" in any meaningful sense — it
ports the one route v1 forgot to scope, after we have already scoped its sibling.

### Ruling — **fix, mirroring D10 verbatim**

`GET /api/user/<id>` → **owner plus roles `[0,1,2]`**, using the existing
`assertOwnership(actor, id, [0,1,2])` (`src/auth/policies/ownership.ts:57-70`).
Same predicate, same roles, same 403 as D10, so the two reads cannot drift.

I am **not** proposing a redacted middle option (open profile + private finance). It doubles the
response contract for a route whose only member-to-member use case — picking a name — is already
served by the unrestricted `GET /api/user` list and by `POST /api/user/birthdates`. Redaction is
the fallback only if Q29a comes back "yes, and members use it".

`GET /api/user/-1` (the "me" route, D14) is unaffected: the owner branch covers it.

### ⚠️ The one operator fact — **Q29a**, ask before implementing

> **Does the React client have a screen where an ordinary MEMBER opens *another* member's detail
> page — and if so, does it show the finance block?**

I cannot source this: the client is not in either repo, and no doc records its routes.
It flips the ruling:

* **No such screen (expected)** → restrict. The change is invisible to every member and closes the
  hole. Proceed with **D25** as written.
* **The screen exists and is used** → then members *do* read each other's balances as a matter of
  fund practice, and the correct row is "accept, register as fund-open" — but then **D10 should be
  re-opened too**, because the fund cannot simultaneously hold that loan detail is private and that
  the aggregate of all loans is public. That is the outcome I want to avoid discovering in Phase 4.

Second-order and non-blocking: even under "restrict", `contributions` remains readable by the
member themselves and by `[0,1,2]`, which is every party who has a reason to see it.

### Proposed §5 row

| # | v1 behavior | Change in v2 | Phase | Status |
|---|---|---|---|---|
| **D25** | `GET /api/user/<id>` is role ≤ 3 with **no ownership check** (`permissions.py:13-17`, `views/user.py:43-50`), so any member reads any other member's full `finance` block — `contributions`, `balance_contributions`, `total_quota`, `available_quota`, **`utilized_quota`** (their aggregate outstanding debt to the fund) and `total_savingaccounts` (their CAP deposits) — alongside the profile. v1 scopes the *loan list* by role (`views/loan.py:20-40`) and returns **no** finance on the *user list* (`services/user.py:60-70`), so this by-id route is the only unscoped path to another member's money position. | **Restrict** to the record's owner plus roles `[0,1,2]` — the **same predicate and the same roles as D10**, so the loan read and the user read cannot drift. `assertOwnership(actor, id, [0,1,2])`. `GET /api/user/-1` is unaffected (owner branch). Profile-only member-to-member lookup keeps working through the unrestricted `GET /api/user` list and `POST /api/user/birthdates`. | P3 (decide) / P4 (land with D10) | ⏳ **Decided — fix; pending operator Q29a** (does any member-facing client screen read another member's detail?) |

---

## C30 / Q30 — self-directed powers of attorney, and re-emission of the letter

### What the power of attorney *is* at this fund

From the template (`fondo_api/templates/power/power_email.html`) and the live rows, not inference:

* **Addressee:** *"Señores: ASAMBLEA GENERAL FONDO FAMILIAR — Atn: Presidente"*. It is a formal
  submission **to the assembly, for the attention of the PRESIDENT** — i.e. it is the instrument the
  president uses to establish who holds whose vote.
* **Signatory:** the text is first person from the **requester** — *"Yo, {requester}, con número de
  identificación {…}, en mi calidad de afiliado al fondo … confiero poder amplio y suficiente a
  {requestee}"* — but the sign-off is **"Atentamente, Fondo Montañez"**. The fund's name is on the
  document; the member never signs anything. The API call *is* the signature.
* **What it authorises:** the requestee *"participará con **voz y voto** en todas y cada una de las
  deliberaciones y decisiones tomadas en la asamblea"* on the requester's behalf, for one named
  `meeting_date`. It is a **vote transfer**.
* **Distribution:** every active member (Q10), now blind-copied (D5).

One structural safeguard is already right and should be stated so it is not accidentally removed:
`requester` is **always the caller** (`services/user.py:167`, `requester = self.get_profile(user_id)`)
— it is never read from the body. A member can therefore only ever **give away their own vote**;
nobody can forge a request that hands *someone else's* vote to themselves. D2 then requires the
receiving member to approve. The two-party consent model is sound.

### (a) Self-directed: `requester === requestee`

**Semantically it is null** — "I confer ample and sufficient power upon myself to represent me" —
so it transfers no vote and cannot manufacture voting power. That much is harmless.

What is *not* harmless is that it collapses the two-party consent to one party: a single member,
acting alone, causes the fund to emit a **document on Fondo Montañez's letterhead, addressed to the
president of the assembly, naming a member and their cédula**, to all 15 members, blind-copied so
it looks like a fund broadcast rather than a peer's message. Every other power letter in the
system's history required two people to agree. And with m4 unfixed it is repeatable at will.

**Live evidence it is not a used feature:** all **20** `fondo_api_power` rows have
`requester_id ≠ requestee_id`. In five years and six assemblies (2021-09, 2022-02, 2023-02, 2024-02,
2025-02, 2026-01) no member has ever named themselves. Blocking it would have refused zero real
requests.

**Ruling: fix — refuse at `createPower` (`type: post`) when `requester === requestee`.** Refusing at
creation, not at approval, is deliberate: the letter is the harm, and refusing early also stops the
useless row and the "you have a power request" push a member would otherwise send themselves.
Status: **406**, matching v1's house style for a business-rule refusal on a create
(`create_loan` → 406, `views/loan.py:44-47`), with a message.

### ⚠️ The one operator fact — **Q30a**, ask before implementing

Live data shows a pattern I cannot interpret from the code: **member 14 has two approved powers for
the same meeting `2026-01-31`** — row 18 (14 → 7) and row 20 (14 → 5). Same for members 8 and 13 in
earlier years across different meetings, but 14's pair is a single assembly. There is no uniqueness
constraint on `(requester, meeting_date)` and no revocation path in the API — the requester cannot
withdraw a request; only the requestee can reject it (`state = 2`).

> **When a member changes their mind about who will carry their vote, what do they do today —
> issue a second request to the new proxy and let the president treat the later letter as the one
> that counts? And has anyone ever been told to "name yourself" to signal *"never mind, I will
> attend in person"*?**

* **Answer is "second request supersedes; self-naming is not a thing" (expected)** → implement
  **D26** as written. The duplicate-per-meeting behaviour stays untouched (it is the fund's
  supersede idiom and blocking it would break a real process) — I explicitly recommend **not**
  adding a `(requester, meeting_date)` uniqueness rule.
* **Answer is "self-naming is how you revoke"** → then D26 as written removes a workaround the fund
  relies on, and the right build is a real revocation (requester may set `state = 2` on their own
  pending request, no letter) rather than a bare refusal. Say so and I will rewrite the row.

### (b) / m4 — re-approving an already-approved power re-sends the letter

`handle_power_request` (`services/user.py:193-206`) writes `power.state = request['state']`
unconditionally and mails on `state == 1`. Approving an already-approved power **re-emits the
formal letter to all 15 members**, with no cap. v2 ports this faithfully
(`src/users/power.service.ts:249-273`).

This is the identical question **Q14 answered for loans**, and the answer should be identical.
There is no fund scenario in which the same proxy grant, for the same meeting, is validly notarised
twice; a president who receives the letter twice cannot tell whether it is a duplicate or a second,
different grant. Legal transitions are `0 → 1` (approve) and `0 → 2` (reject); anything else is
refused **409**, mirroring D9's shape. Notably a self-directed power is only *cheap* to weaponise
because of this gap — fixing (b) alone reduces (a) from "unbounded fund-wide broadcast" to "one
letter", which is why the reviewer was right to fold them together.

**This half needs no operator input** and is safe to implement now. One caveat to name: if a member
ever asks for the letter to be **re-sent** because they lost it, there is now no path — that is an
ops task (resend from SES / the treasurer forwards it), not a state write, and it should not be
re-enabled by making approval idempotent-with-email.

### Proposed §5 rows

| # | v1 behavior | Change in v2 | Phase | Status |
|---|---|---|---|---|
| **D26** | Nothing forbids `requester === requestee` on a power request (`services/user.py:165-192`). Since `requester` is always the caller, a member acting **alone** — with no second party's consent, which every other power requires under D2 — can create and then approve a power naming themselves, and cause the fund to emit the formal Spanish power-of-attorney letter on **Fondo Montañez's letterhead, addressed to the president of the assembly**, to all 15 members (blind-copied under D5). The document is semantically null (it transfers no vote), so this is document emission, not vote manufacture. **Live check 2026-09-03: 0 of 20 `fondo_api_power` rows are self-directed** across six assemblies. | **Refuse at creation** (`type: post`) with **406** when `requester === requestee`, matching v1's 406 house style for a business-rule refusal on a create. Refused at creation rather than approval so no row and no self-addressed push notification are produced either. **No `(requester, meeting_date)` uniqueness rule is added** — live data shows members issue a second request to a different proxy for the same meeting (rows 18 and 20, member 14, `2026-01-31`), which is the fund's supersede idiom. | P3/P4 | ⏳ **Decided — fix; pending operator Q30a** (is self-naming ever used to signal "I will attend in person"? there is no revocation path today) |
| **D27** | `handle_power_request` writes `power.state` unconditionally and mails on `state == 1` (`services/user.py:193-206`), so **re-approving an already-approved power re-sends the fund-wide letter**, unbounded. Same defect class as D9 for loans; no guard in v1 or in the P3 port (`power.service.ts:249-273`). | **Enforce legal state transitions** `0 → 1` (approve) and `0 → 2` (reject); reject any other transition with **409** and **send no mail**. Mirrors **D9** (Q14) exactly. Re-sending a lost letter becomes an ops task, not an API state write. | P3/P4 | ✅ **Decided — fix** (no operator input needed) |

---

## m6 / C38 — a TREASURER writing their own `finance`

### What is actually at stake, stated with the live numbers

The D1 table grants TREASURER `finance` on **any** user, self included, and the implementation
(`src/auth/policies/user-patch.policy.ts:370-372`) matches it. Q12 — reconfirmed twice — says quota
comes **exclusively** from the treasurer's monthly file, which makes the single-user `finance`
PATCH a *correction/override* tool rather than part of any routine process.

Live facts that turn this from textbook into concrete:

* The TREASURER is **user 2**, and is the fund's **largest borrower**: `utilized_quota` 20 343 105 of
  `total_quota` 30 000 000. They are an active user of the loan facility, not a bystander.
* The ADMIN is **user 1** and is a **different, active person** from the treasurer. So a self-write
  block has a working fallback.
* Under Q12 loans do **not** increment `utilized_quota`, so `available_quota` is authoritative only
  until the next monthly file. A self-raise therefore has a **one-month** life, leaves no trace
  beyond `last_modified`, and — critically — `create_loan` checks `value > available_quota`
  (`services/loan.py:26-28`) as the fund's **only** quota enforcement.

### Ruling — **fix, narrowly: block `finance` self-writes for TREASURER; leave ADMIN alone**

Reasons it should not be inherited by silence, as the reviewer asked:

1. **It costs the treasurer nothing.** Their own record is still updated every month by their own
   TSV (that path is untouched — `bulk_update_users` matches on `identification`, not on the
   caller), and a genuine mid-month correction to their own row can be made by the ADMIN, who is a
   different person and is active. There is no treasurer workflow that requires it.
2. **It is the one cell the D1 table itself flags as unstated.** The footnote says the TREASURER
   self-service cell is "the one cell in this table the operator did not state directly" — and Q15's
   words were *"treasurer only can modify finance information"*, which is a statement about
   **scope**, not about **self**. Reading "any user" to include "themselves" is the inference; the
   fund never said it.
3. **The self-service principle that produced Q25a does not reach here.** Q25a exists because a
   member must be able to change their own email. Nobody needs to be able to change their own
   balance — `finance` has no self-service justification of the kind that saved `personal` and
   `preferences`.

**ADMIN is deliberately left unblocked.** A blanket self-finance block would create a dead end:
`fondodev` has exactly **one** ADMIN (the same structural fact D14 relies on), so blocking their own
row means it can be repaired only by the monthly file, and if the file ever misses them — an
`identification` mismatch is only **logged** and skipped (`services/user.py:144`, the D16 rationale)
— nobody can fix it through the API. ADMIN stays the break-glass role. Every change remains visible
in `last_modified`, and both privileged roles see the monthly file.

### ⚠️ Bundle with **Q31** — the bigger twin, or this fix is cosmetic

The quota self-raise only matters because of what it unlocks, and the next link in that chain is
**not** registered anywhere:

> **`LoanDetailView.patch` is role `[0,2]` with no ownership check (`views/loan.py:61-68`) — a
> TREASURER can approve their own loan, and D10 (a *read* restriction) does not touch it.**
> **Q31: may a TREASURER approve their own loan request, or must a member's own loan be approved by
> someone else (i.e. by the ADMIN)?**

Today one person can, alone: raise their own `available_quota` → create a loan that passes the only
quota check → approve it → trigger the payout email. Blocking the first step while leaving the third
open closes the small door. I recommend asking Q31 in the same round and, if the answer is "someone
else must approve", opening a Phase 4 row for it. If the answer is "the treasurer approving their
own loan is normal here — it is a family fund and the assembly sees the loan book", then **m6 should
be accepted as-is instead of fixed**, because a self-write block would be security theatre next to
an unrestricted self-approval. **The two answers must match.** D28 as written assumes Q31 comes back
"someone else must approve"; if it comes back "self-approval is fine", withdraw D28 and register the
whole area as accepted.

### Proposed §5 row

| # | v1 behavior | Change in v2 | Phase | Status |
|---|---|---|---|---|
| **D28** | The `finance` section of `PATCH /api/user/<id>` is writable by TREASURER on **any** user, **self included** (v1: no ownership check at all; v2: the D1 table's "TREASURER · `finance` · ✅ any user" cell, `user-patch.policy.ts:370-372`). Because Q12 makes the monthly TSV the exclusive quota source and loans never increment `utilized_quota`, a treasurer can raise their own `available_quota` between uploads and pass `create_loan`'s check — the fund's **only** quota enforcement (`services/loan.py:26-28`) — with a one-month window and no trace beyond `last_modified`. Live: the TREASURER (user 2) is the fund's largest borrower, 20 343 105 of 30 000 000. | **Block `finance` self-writes for TREASURER** — a TREASURER `finance` PATCH where `target === actor` is **403**. **ADMIN is deliberately unaffected**: `fondodev` has exactly one ADMIN (the D14 fact) and a mismatched `identification` in the TSV is only logged and skipped (`services/user.py:144`), so ADMIN must remain the break-glass repair path for their own row. Costs the treasurer nothing — their own record is still updated by their own monthly TSV (`bulk_update_users` matches on `identification`, not on the caller) and the ADMIN, a different active person, can make mid-month corrections. Q15 stated a **scope** ("treasurer only can modify finance information"), never "including their own"; the D1 footnote already flags this cell as inferred. | P3 (P4 for the loan twin) | ⏳ **Decided — fix; conditional on operator Q31.** If Q31 answers that a TREASURER may approve their **own** loan (`LoanDetailView.patch` is `[0,2]` with no ownership check and D10 does not touch it), **withdraw D28** — blocking the self-write is cosmetic beside an unrestricted self-approval, and the fund's answer must be the same on both. |

---

## Operator round — three questions, in priority order

1. **Q29a (blocks D25, needed before Phase 4 lands D10).** Does the React client have a screen where
   an ordinary MEMBER opens another member's detail page, and does it show the finance block
   (contributions / quota / CAP total)? If yes, are members expected to see each other's
   **outstanding debt to the fund** (`utilized_quota`) and **CAP deposits**, or only contributions?
   *Why it cannot be answered from the code: the client is in neither repo.*
2. **Q31 (governs D28 and a new Phase 4 row).** May a TREASURER approve **their own** loan request,
   or must a member's own loan be approved by someone else? Today `[0,2]` may approve any loan with
   no ownership check, and the current treasurer is the fund's largest borrower.
   *Why it cannot be answered from the code: v1 permits it, but permitting is not deciding.*
3. **Q30a (blocks D26; D27 proceeds regardless).** When a member changes their mind about who
   carries their vote, do they simply issue a second request and let the later letter win — and has
   anyone ever been told to name **themselves** to signal "never mind, I will attend in person"?
   There is no revocation path in the API, and live data shows member 14 with two approved proxies
   for the `2026-01-31` assembly.
   *Why it cannot be answered from the code: it is assembly practice, not an API affordance.*

## What Phase 4 can start on now

* **D27** — the power state-transition guard. Fully decided, no dependency.
* **D25 and D10 must land together.** Do not implement D10 in isolation; the two reads share one
  predicate by design.
* **D26 and D28** — hold the four-line changes until Q30a and Q31 come back.
