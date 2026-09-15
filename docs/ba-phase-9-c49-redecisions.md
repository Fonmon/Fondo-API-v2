# BA — Phase 9, C49: the eight carried v1 defects, re-decided once

**Verdict: Concerns.** One item (5) must be decided before cutover. It is the only one where the
first production run of v2 can move money state and members' reminders with nobody told. The other
seven can go to the post-migration backlog. That is safe **only if** the operator approves the
keep-as-v1 recommendations below, because after the hard switch nobody will reopen them.

Source: `MIGRATION_PLAN.md` §3 "Phase 9" → *"v1 defects deliberately carried into v2"* (C49,
lines 1012–1039), plus the cleanup backlog (lines 1041–1047).

**How the numbers were measured.** All of them come from `fondodev` on 2026-09-14, read-only.
Each `psql` session set `SET default_transaction_read_only = on` and checked
`SHOW transaction_read_only` → `on`. The password was never printed.

**What this note does not do.** It proposes no code and no plan edits. The React client is **in
neither repo** (`docs/ba-phase-4-p4f1.md:106-107`), so every "client impact" statement below says
what can and cannot be known from here.

---

## Measured baseline (used across items)

| Fact | Value | Query |
|---|---|---|
| Loans by state | 0: **1** · 1 (APPROVED): **28** · 2: **51** · 3 (PAID_OUT): **345** · total **425** | `GROUP BY state` on `fondo_api_loan` |
| APPROVED loans | **28**, held by **9** borrowers, **28/28** with a `LoanDetail`, outstanding `capital_balance` **115 991 401** (largest 23 863 634) | APPROVED ⟕ first `LoanDetail` per loan |
| APPROVED by borrower role | PRESIDENT **6** (17 300 000) · TREASURER **7** (20 343 105) · MEMBERS **15** (78 348 296) | join on `userprofile.role` |
| Pending payment reminders for APPROVED loans | **90** unprocessed `payment_reminder` rows, covering all **28** loans | `schedulertask` where `payload->'owner_id'` is an APPROVED loan |
| PAID_OUT rows with a positive `capital_balance` | **336 of 345** (re-measured; matches §2.10) | PAID_OUT ⟕ `LoanDetail` |
| Close rate | **3.3** PAID_OUT per month, **4.1** loans per month, 2018-01-01 → 2026-08-10 | count ÷ months since the first loan (a derived average; it includes refinance closes) |
| Refinances | **148 of 425** in total; **29 of the last 64** loans (12 months) | `prev_loan_id IS NOT NULL` |
| Members | ADMIN 1 · PRESIDENT 1 · TREASURER 1 · MEMBER 10 active + 2 inactive | role × `is_active` |
| Who can approve a loan | **2 people**: user 1 (ADMIN) and user 2 (TREASURER) | `LoanDetailView.PATCH: [0,2]` (v1 `fondo_api/permissions.py:9-12`); roles 0/2 on `fondodev` |

---

## 1. P4-D4 — `?page=`, `?page=abc`, `?state=abc` are 500s on `GET /api/loan`

**Refs:** v1 `fondo_api/views/loan.py:24-25` (unguarded `int()`), `:29-32` (the 400 guards that
run too late); `docs/phase-4-deviations.md` §1.3 P4-D4; adjacent **D40** (`page=0` message),
plan line 1290.

**(a) Who is affected, and how often.** Anyone who opens the loan list. Paging is normal use: **11
of the 13** borrowers have more than one page (10 per page; one member has **94** loans), and
`all_loans` is **43** pages. A 500 needs a malformed query string. The React client builds that
string, and we cannot see it. There are no v1 logs here, so how often it happens **cannot be
measured**. There is no write and no money effect.

**(b) Client impact of changing it.** 500 → 400 only changes a failure the client cannot be
relying on to succeed. What we cannot know: whether the client ever sends `?page=` with no value,
or `page=undefined`, and treats the error as "no data". If it does, the screen fails the same way
with a 400.

**(c) Options.**
- **Keep as v1.** Cost: zero now; one confusing log line per occurrence.
- **Return 400** with a v1-style `{"message": …}`, guarding the way `UserView.get` does. Cost: a
  new deviation, an e2e re-pin and a parity cell on the most-read loan route, and it reopens a
  closed phase.

**(d) Recommendation.** Keep at cutover. Put "400 on a non-integer `page`/`state`" in the backlog,
together with D40.

**(e) Timing.** **Defer.** Nothing is harmed by waiting.

---

## 2. P4-D2 — MEMBER `?all_loans=true` is a silent no-op

**Refs:** v1 `fondo_api/views/loan.py:23, 33-41`; `services/loan.py:57-67`; pinned at
`test/loan.e2e-spec.ts:460-462`; `docs/phase-4-deviations.md` §1.3 P4-D2.

**(a) Who is affected.** The **10 active MEMBERs**. Nothing leaks: they get only their own loans
with a 200. It is a correctness-of-intent issue, not a data issue, and it is not measurable (no
logs).

**(b) Client impact.** **This is the risky one to change.** If the React client sends
`all_loans=true` for every role and lets the server filter, a 403 would **break every member's
loan screen**. The repo cannot show whether it does.

**(c) Options.**
- **Keep as v1.** Cost: none.
- **403 for a MEMBER.** Cost: possibly breaks the member loan list; needs a client check first.
- **Ignore it but add a response hint.** Cost: an envelope change to `{list, num_pages, count}`,
  which breaks §4 rule 1.

**(d) Recommendation.** **Keep as v1, permanently.** No member is harmed, and any change risks the
screen members use most.

**(e) Timing.** **Defer** (in practice, "never").

---

## 3. P4-D5 — malformed body on `POST /api/loan/<id>/refinance` is 500, never 400

**Refs:** v1 `fondo_api/services/loan.py:127-150` (catches only `Loan.DoesNotExist`);
`views/loan.py:85-89` (the 400 means "wrong loan"); `docs/phase-4-deviations.md` §1.3 P4-D5.

**(a) Who is affected, and how often.** A member refinancing their own APPROVED loan. Refinance is
a live process: **29 of the last 64** loans. A 500 needs a body missing `disbursement_date`,
`includeInterests` or `comments`, which only a broken client sends; frequency is not measurable.

- **Money safety (read, not tested):** every one of those keys is read at lines 132, 136 and 141,
  **before** `create_loan` at line 145. A malformed body therefore writes no loan row.
- **The second 500 path is unreachable on today's data:** "APPROVED loan with no `LoanDetail`"
  is **0 of 28**.

**(b) Client impact.** The same unknown as item 1. The member sees a failed refinance either way.
A 400 would only help if the client showed the message.

**(c) Options.**
- **Keep as v1.** Cost: none.
- **400 `{"message": …}` on a missing key.** Cost: a new deviation, and it blurs "400 = wrong
  loan" unless the message is distinct; plus re-pins and a parity cell.

**(d) Recommendation.** Keep at cutover; backlog, low priority.

**(e) Timing.** **Defer.**

---

## 4. P4-D3 / P3-D6 — v1's error rendering (`""` bodies; Django's HTML 500 page)

**Refs:** v1 `fondo_api/views/loan.py:67` + `services/loan.py:108` (`Response('')` → the two bytes
`""`); `docs/phase-4-deviations.md` §1.3 P4-D3; `docs/phase-3-deviations.md:49` P3-D6;
`src/common/filters/api-exception.filter.ts:27-28`.

**(a) Who is affected.**
- **`""` body:** the 2 approvers (ADMIN, TREASURER), on every **deny** and **payout**. There are
  51 DENIED and 345 PAID_OUT historically; PAID_OUT includes bulk closes that go through a
  different route.
- **HTML 500:** anyone who hits an uncaught crash, including items 1 and 3.

**(b) Client impact.** ⚠️ **Half of this has already changed and the operator should know it.**
P3-D6 is registered: v2's uncaught 500 is **zero bytes with no `Content-Type`**, not v1's 27-byte
HTML page.
- A client that shows the HTML page, or tests for it, already sees a difference at cutover.
- A client that calls `response.json()` on a 500 throws in both stacks.
- The `""` on deny/payout is byte-identical in v2 (fixed in Phase 4). Changing it to `{}` or a
  message could break a client that checks for an empty string. We cannot see the client.

**(c) Options.**
- **Keep**: `""` for deny/payout, zero-byte 500 as already registered. Cost: none.
- **JSON 500 body** (`{"message": "Server Error"}`). Cost: small and client-safe for JSON parsers;
  a new deviation on every route's crash path.
- **Replace `""` with an object.** Cost: a client-visible body change on the two most common
  approver writes. Not worth it.

**(d) Recommendation.** Keep both. The operator should **acknowledge P3-D6** (HTML → zero-byte)
as part of the cutover sign-off, because it is a visible change that has already shipped.

**(e) Timing.** Acknowledgement: **before cutover**, one line. Any JSON-500 change: **defer**.

---

## 5. D8's blast radius (M2) — an incomplete monthly file auto-closes every APPROVED loan not listed

**Refs:** v1 `fondo_api/services/loan.py:201-207` (auto-close), `:106-107` (a close deletes the
reminders), `:284-296` (**D33**: no state filter on the update); plan §5 **D8** (line 1269),
~~**D31**~~ / ~~**D32**~~ (1296-1297), **D33** (1298); §9 runbook items 5–6 (1953-1972);
`docs/phase-4-deviations.md` §2.10.

**(a) Who is affected, and how often.** **Every monthly upload, by the TREASURER.** An empty,
truncated or wrong file would, in one call:
- close **all 28** APPROVED loans for **9** borrowers, including the PRESIDENT's 6 and the
  TREASURER's 7;
- carrying **115 991 401** of outstanding capital;
- delete **90** pending payment reminders.

Nobody is notified (D32 withdrawn). Members stop getting reminders and cannot refinance: that
needs state 1, and refinance is **45%** of recent loans. A partly wrong file closes a subset.
Baseline for "normal": about **3.3** closes per month across the fund's history. A file that
closes, say, 10 of 28 is not a normal month, but no server check sees that. The operator reports
no incomplete file ever. The data cannot prove it: 336/345 closed loans show a balance by design.

**(b) Client impact.** v2 already returns `200 {"closed_loans": [...]}` (D8). **The client does
not read it today.** v1 returned an empty body, so no screen exists; this is inferred from v1, the
client is not visible. Unless someone changes the client (runbook item 5), the treasurer sees
nothing. Any server-side guard that refuses a file needs the client to show the refusal message.
A new 4xx on this route would show up as a generic failure.

**(c) Options.**

| # | Option | Cost |
|---|---|---|
| A | **Keep as v1** (as decided). Repair is the §2.10 DB edit. | Zero code. Each incident means a DBA edits by hand and reconciles reminders (D33). The procedure has never been rehearsed. |
| B | **Procedural pre-check, no code.** Before uploading, the treasurer compares the file's loan ids with the APPROVED list (`GET /api/loan?all_loans=true&state=1&paginate=false`). The difference must equal that month's genuine payoffs. After uploading, someone reads `closed_loans` (browser devtools, or the server `warn` line). | Minutes a month; relies on discipline. |
| C | **Client shows `closed_loans`** (runbook item 5). | A client change outside this repo. Detects after the fact; does not prevent. |
| D | **Server guard: refuse a file that would close more than N APPROVED loans (or matches none) unless a `force` flag is sent.** | New functionality: a deviation, tests, a parity cell, and a client change to send `force`. Prevents the worst case. |
| E | **Reinstate D31** (ADMIN-only `3 → 1`). | Re-opens a withdrawn decision. Must still reconcile D33 reminders. Recovery, not prevention. |

**(d) Recommendation.** **A + B + C now; D in the backlog; E stays withdrawn** unless an incident
happens.
- **B** costs no code and would catch exactly the failure M2 describes.
- **C** is what makes D8 worth having at all.
- Also: **rehearse §2.10 once against a `fondodev` copy** before the first v2 upload. The plan
  already says to cut over just after a verified upload (§9 "Cutover timing", item "Kept"); that
  month of runway is the time to do it.

**(e) Timing.** 🔴 **Before cutover.** Three things need the operator's sign-off before the
switch:
1. who does check B each month;
2. whether the client change C is scheduled;
3. that the rehearsal is done.

The first v2 upload is the first time v2 runs this path in production.

---

## 6. D28's withdrawal (Q31) — a TREASURER can raise their own `available_quota` and approve their own loan

**Refs:** v1 `fondo_api/services/user.py:243-261` (finance write, recomputes `available_quota`);
`services/loan.py:26-28` (the only quota gate), `:79` (`update_loan` never receives the approver's
id); `permissions.py:9-12, 18-22`; `docs/operator-q29a-q30a-q31.md` §Q31;
`docs/phase-4-deviations.md` §1.2; plan §5 ~~D28~~ (line 1299).

**(a) Who is affected, and how often.**

| Measure | Value |
|---|---|
| Treasurers | **1** (user 2), one of only **2** people who can approve |
| Treasurer's APPROVED loans | **7**, **20 343 105** outstanding |
| Treasurer's loans in the last 12 months | **18**: 7 approved, 9 paid out, 1 denied, 1 pending |
| Treasurer's finance row | quota 30 000 000, utilized 20 343 105, available 9 656 895, `last_modified` 2026-08-20 |
| Pending loan requests in the whole fund | **1**: loan **456**, 3 627 000, created 2026-08-05, **the TREASURER's own** |
| Finance rows where `available ≠ total − utilized` | **0 of 15** (no hand edits visible) |

So the exposure is not hypothetical: the one request waiting today is the treasurer's own.

What the data **cannot** show: who approved any loan. There is no approver column and no audit
table, so the number of self-approvals is not measurable.

- **An existing passive control:** the approval email BCCs every active role-0/2 user except the
  recipient (`services/loan.py:97-98`, `services/mail.py:17-28`). The **ADMIN receives the
  approval email for the treasurer's own loan.**
- **A finance self-edit sends nothing.**

**(b) Client impact.** Keeping it: none. A four-eyes rule would give a 403 or 409 on a PATCH the
treasurer uses today, for their own loans. That screen exists; the operator called self-approval
"normal".

**(c) Options.**
- **Keep as v1** (as decided). Cost: none; the risk stays accepted.
- **Audit trail**: record who approved/denied, and who changed a finance row and when. No client
  change, no behaviour change. Cost: a schema migration and a write per approval/finance edit.
  Makes the exposure measurable after the fact.
- **Four-eyes**: the ADMIN must approve loans whose borrower is the approver. Cost: overturns Q31
  and puts the ADMIN in the loop for about 1 in 4 of recent loans.
- **Notify ADMIN + PRESIDENT on a finance self-edit.** Cost: a new email; a recipient change the
  operator must approve.

**(d) Recommendation.** **Keep as v1** (Q31 stands). Put the **audit trail** in the backlog as
the cheapest control that changes nothing for the treasurer.

**(e) Timing.** **Defer.** The operator decided this on 2026-09-03 with the facts. Nothing in
cutover depends on it.

---

## 7. D36 (Q32) — `GET /api/activity/<id>` returns every attached member's `identification`, `email`, `birthdate`

**Refs:** v1 `fondo_api/serializers.py:8-16` (`UserProfileSerializer` fields), `:124-139`
(nested per `ActivityUser`); `services/activity.py:47-53, 68-74` (attaches all active members at
creation); `permissions.py:18-22, 31-35` (`UserView.GET` and `ActivityDetailView.GET` both open
to role 3); `docs/ba-phase-5-activity-exposure.md` §§1–4; plan §5 **D36** (line 1294).

**(a) Who is affected.**
- **Readers:** any of the **13** active members, on any of **25** activities (338 rows).
- **People whose data is exposed:** **15** (all with identification, email and birthdate).
  - **13** of them are already fund-open through `GET /api/user`, the same serializer; the
    activity route adds nothing for them.
  - **2 are ex-members** (users 3 and 15, inactive), still shown on **19 of 25** activities
    (user 3 on 19, user 15 on 5). Only this route shows them.

**(b) Client impact.**
- Operator Q32: the activity screen **shows the whole paid/unpaid list**
  (`docs/phase-5-deviations.md:60`), so scoping to the member's own row would break it.
- Removing `identification`/`birthdate`/`email` from the nested `user` would only break the client
  if it reads them there. Unknown from here, though the screen's purpose (who paid) needs only a
  name.

**(c) Options.**
- **Keep as v1.** Cost: none. Ex-members' ID number and birthdate stay visible.
- **Slim the nested user** to `id`, `full_name`, `first_name`, `last_name`. Cost: a body change
  and a client check. ⚠️ It must go **together with** `GET /api/user`, or it closes nothing for
  active members (`ba-phase-5-activity-exposure.md` §7).
- **Hide inactive members' profile fields** (keep the row and state). Cost: a small body change,
  and it removes the one real extra exposure.
- **Own-row only.** Rejected by Q32.

**(d) Recommendation.** **Keep at cutover.** Add to the backlog: "minimise member PII on list
routes (`/api/user` + activity detail), and stop exposing ex-members' ID/birthdate". Ask the
operator whether retaining and displaying ex-members' personal data meets the fund's own
data-handling expectations. Colombia's personal-data regime applies to cédula numbers and
birthdates. That is a question for the operator, not a legal finding.

**(e) Timing.** **Defer.** v1 and v2 are identical today, so the cutover changes nothing.

---

## 8. `ActivityUser.EXEMPTED` is never written — a product/data decision, not a port

**Refs:** v1 `fondo_api/models.py:86-93` (`STATE_TYPES` 0/1/2, default 0);
`services/activity.py:86-90` (writes `data['state']` with no choice check); v2
`src/activities/activity.service.ts:408-421` (the same: `toDjangoSmallInt`, no `STATE_TYPES`
check); `docs/ba-phase-5-activity-exposure.md` §6; plan cleanup backlog line 1042 (Q33:
`NOT_PAID` = *owes the fund*).

**(a) Who is affected, and how often.** `EXEMPTED` appears in **0 of 338** rows. By year:

| Year | Activities | NOT_PAID | PAID | EXEMPTED |
|---|---|---|---|---|
| 2018–2021, 2023, 2025 | 16 | 0 | 227 | 0 |
| 2022 | 3 | **3** (user 9, PRESIDENT) | 39 | 0 |
| 2024 | 2 | **2** (user 3, now inactive) | 28 | 0 |
| **2026** | 3 | **39** | **0** | 0 |

⚠️ **New, and sharper than the Phase 5 note.** Only **13** of 2026's 39 NOT_PAID rows are for the
future raffle (2026-11-21). The other **26** are on two events that **have already happened**:
Carrera de observación (2026-04-03, 15 000) and Polla mundial (2026-06-11, 100 000).
- Read with Q33, **all 13 active members currently show as owing the fund 115 000**, visible to
  each other (D36).
- Either the PRESIDENT marks payments late in the year, or 2026 has not been recorded.
- Five months after an event, unmarked, paid and excused all look the same.

**(b) Client impact.**
- **The server already accepts `state: 2`** (v1 and v2, no validation), so the fund could start
  using EXEMPTED with **no server change**.
- What we cannot know: whether the React client offers 2 in its controls, or renders it.
  `ActivityUserSerializer` sends the raw integer with no display label (`serializers.py:124-127`),
  so the client maps it itself.

**(c) Options, as product/data choices.**
- **Keep as is.** Cost: an excused member stays shown as a debtor; the 2026 rows remain
  ambiguous.
- **Start using EXEMPTED.** Cost: confirm the client shows 2 (maybe a client change), and tell
  the PRESIDENT when to use it. No API change.
- **One-off data review of the 5 historical NOT_PAID rows** (2022 PRESIDENT, 2024 ex-member):
  should they be PAID or EXEMPTED? Cost: the PRESIDENT's judgement plus a recorded edit through
  the API (PATCH as ADMIN/PRESIDENT), not SQL.
- **Separate "not participating" from "owes" in the UI.** Cost: a product change on the client;
  may need a new state.

**(d) Recommendation.**
- After cutover, ask the PRESIDENT two questions: (1) is "excused" a real case at the fund, and
  (2) are the April and June 2026 activities just not marked yet?
- If (1) is yes: confirm the client renders state 2, then start using it, and review the 5
  historical rows.
- No v2 code change.

**(e) Timing.** **Defer.** Nothing about it changes at cutover. The 2026 marking question is
worth raising with the PRESIDENT now, as a process matter, independent of the migration.

---

## Summary for the operator

| # | Item | Recommendation | Before cutover? |
|---|---|---|---|
| 1 | P4-D4 malformed `page`/`state` → 500 | Keep; backlog a 400, with D40 | Defer |
| 2 | P4-D2 MEMBER `all_loans` no-op | Keep, permanently (a 403 could break members' loan list) | Defer / never |
| 3 | P4-D5 malformed refinance body → 500 | Keep; no partial write; backlog, low priority | Defer |
| 4 | P4-D3 `""` / P3-D6 HTML 500 | Keep `""`; **acknowledge** that v2's crash body is already zero-byte, not HTML | **Acknowledge before**; change deferred |
| 5 | D8 blast radius (M2) | Keep D31/D32 withdrawn; add a monthly pre-upload id check, schedule the client showing `closed_loans`, rehearse §2.10 once; backlog a server "too many closes" guard | 🔴 **Before** |
| 6 | D28 withdrawn (Q31) | Keep; backlog an approver/finance audit trail | Defer |
| 7 | D36 activity PII | Keep; backlog PII minimisation across `/api/user` + activity detail, and ex-members' data | Defer |
| 8 | EXEMPTED never used | A product decision with the PRESIDENT; the API already accepts state 2; no code | Defer (raise the 2026 marking now) |

**Alexa.** None of the eight depends on Alexa. Its `RequestLoanIntent` calls
`LoanService.create_loan` directly (`fondo_api/services/alexa/intents/request_loan_intent.py:17,24`),
not the HTTP routes in items 1–3. Its removal does not change these decisions. The separate
confirmation that losing voice loan requests is acceptable is not re-asked here.
