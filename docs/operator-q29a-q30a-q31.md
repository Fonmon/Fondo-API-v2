# Operator answers — Q29a, Q30a, Q31 (2026-09-03)

Escalated from `docs/ba-phase-3-c29-c30-m6.md`, which decided C29/C30/m6 and named three
facts about fund practice it could not source from either repo. All three came back from the
operator. Two confirm the BA's recommendation; **one overturns D28**, exactly as the BA
pre-committed it should.

| # | Question | Operator answer | Effect |
|---|----------|-----------------|--------|
| **Q29a** | Does any client screen let a MEMBER read another member's detail / finance? | **No — members only see themselves** | **D25 proceeds as written** |
| **Q30a** | How does a member change who holds their proxy? | **Submit a second request — it supersedes** | **D26 proceeds as written**; no uniqueness rule |
| **Q31** | May a TREASURER approve their own loan? | **Yes — that's normal at the fund** | **D28 WITHDRAWN**; m6 accepted as-is |

## Q29a → D25 stands

No client screen depends on the open read, so restricting `GET /api/user/<id>` to the record's
owner plus roles `[0,1,2]` breaks nothing. D10 is **not** reopened. D25 and D10 use the same
predicate and **must land in the same phase** so the loan read and the user read cannot drift.

## Q30a → D26 stands, and one rule is explicitly NOT added

A second request superseding the first is the fund's real idiom — so self-naming is **not** a
revocation workaround, and refusing `requester === requestee` at creation (406) removes nothing
members actually use. **Do not add a `(requester, meeting_date)` uniqueness rule**: it would break
the supersede idiom that is live in the data (member 14, rows 18 and 20, assembly 2026-01-31).

**D27** (power state transitions `0→1` / `0→2` only, 409 otherwise, no mail) needed no operator
input and proceeds regardless.

## Q31 → D28 withdrawn, and m6 accepted with it

The operator's answer is that a TREASURER approving their own loan is normal practice at the
fund. That is the **larger** exposure of the two, so blocking the treasurer from writing their own
`finance` row while leaving self-approval open would be incoherent — the BA's own test. m6 is
therefore **accepted as-is**, which is also what operator Q12 ("keep the same behaviour as v1")
already implied.

**Both are ported unchanged from v1 and registered as accepted deviations, not fixed.**

### Recorded, because it is accepted rather than absent

Concern was raised and the operator reaffirmed the behaviour, so v2 ports it. For the record, the
accepted exposure is a closed loop reachable by one person:

1. `bulk_update_users` / the `finance` PATCH lets the TREASURER raise their own `available_quota`.
2. `create_loan` checks `value > available_quota` (`services/loan.py:26-28`) — the fund's **only**
   quota enforcement.
3. `LoanDetailView.patch` is `[0,2]` and `update_loan(id, state)` never receives the actor's id
   (`services/loan.py:79`), so there is no ownership check to fail.

Live at time of writing: the TREASURER is user 2, holding **20 343 105 of a 30 000 000** quota.
(The BA's note called them the fund's largest borrower; that is wrong — **user 6 is, at
25 871 634**, and the treasurer is second. Corrected here so the figure is not propagated.)

This is accepted fund practice, not a defect to fix in v2. It is written down so that a future
reader finds a decision rather than an oversight, and so Phase 4's permission matrix carries the
`[0,2]`-with-no-ownership-check cell **deliberately**.

## Register state after these answers

| Row | Status |
|-----|--------|
| **D25** | ✅ Decided — **fix**. Land with D10 in Phase 4. |
| **D26** | ✅ Decided — **fix**. 406 at creation. No uniqueness rule. |
| **D27** | ✅ Decided — **fix**. Mirrors D9. |
| **D28** | ❌ **WITHDRAWN** per Q31. Port v1; register as accepted. |
| **m6** | ✅ Decided — **accept as-is** (ports v1; consistent with Q12 and Q31). |

Conditions closed by this round: **C29**, **C30**, and the BA half of **C38**.
