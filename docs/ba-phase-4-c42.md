# BA note — Phase 4, condition C42 (re-opening a wrongly auto-closed loan)

**Verdict: Concerns.** Three decisions, two of them new register rows. Nothing here blocks
Phase 4 from closing; the notification row (D32) is the one I would not ship the phase
without, and it is independent of the other two.

| | |
|---|---|
| Date | 2026-09-04 |
| Source | `docs/review-phase-4.md` **M2** and **m2**; `docs/phase-4-deviations.md` D6/D8/D9, §2.10 (forward-referenced, not yet written), §5.1 |
| Register rows produced | **D31** (re-open `3 → 1`, ADMIN only) and **D32** (tell the operators a mass close happened). **D30 is amended, not superseded.** |
| Operator input used | Q3, Q14, Q31, and the two new answers: *"an incomplete or malformed TSV has never happened"* and *"PAID_OUT is internal bookkeeping, not communicated to members"* |
| Blocking? | **No.** D31 is one table entry plus a re-schedule call. D32 is a new mail. |

---

## 0. What closing a loan actually means at this fund

The brief asked me to frame all three questions on this, and the answer changes two of them.

**A PAID_OUT loan is not a statement to the member.** Verified in both stacks: `update_loan`
mails the borrower on `state → 1` and `state → 2` (roles `[0,2]` BCC'd), and on `state → 3` it
does exactly one thing — `remove_sch_notitfications("payment_reminder", id)`. No mail, no push.
The operator confirms it independently: PAID_OUT is internal bookkeeping. So the fund has never
told a member "you have finished paying", and reversing the flag does not retract an announcement
the fund never made.

That removes the strongest argument *against* a re-open route — there is no member-facing
statement to embarrass. But it makes the argument for **D32** much stronger, and it is why the
two questions separate cleanly.

**What a close actually does to a member is operational, not symbolic.** Four consequences,
all verified:

1. **They cannot refinance.** `refinanceLoan` requires `loan.state === LOAN_APPROVED`
   (`src/loans/loan.service.ts:703`) and answers a **zero-byte 400** otherwise — no message.
   Refinancing is live practice, not a corner: **148 of 425 loans** carry a `prev_loan_id`.
2. **They lose sight of their own balance.** `getLoan` returns the `loan_detail` block only for
   state 1, so outstanding capital and `payday_limit` disappear from the member's own loan.
3. **The T−5d / T−1d reminders are deleted**, and re-opening does not bring them back —
   `createScheduledTask` is reached only from `updateLoanDetail`, the per-TSV-row path, never
   from `upsertLoanDetail` on approval. Both stacks. Already recorded in
   `LEGAL_LOAN_TRANSITIONS`' docblock.
4. **The self-heal is partial, and the partial state is worse than either end.**
   `updateLoanDetail` has **no state filter** — it looks the row up by `loan_id` alone. So if the
   treasurer includes the wrongly-closed loan in next month's file, its `LoanDetail` is updated
   and its two reminders are **re-created**, while the loan stays PAID_OUT. The member is then
   pushed "your payment is due in 5 days" for a loan the fund's own record says is paid, and
   `GET /api/loan/<id>` still shows them no balance. The developer's own comment notes the
   related half — a known-but-unapproved id in the file shields itself from the auto-close — so
   it is not re-closed either. It just sits there, incoherent, until someone changes the state.

Point 4 is the one I had not seen anywhere in the phase artifacts and it is the reason my answer
to question 1 is "yes" rather than "accept the DBA".

---

## 1. Decision — should a wrongly auto-closed loan be re-openable through the API?

### **Yes. Add `3 → 1`, and nothing else.** New row **D31**.

**Weighing "never happened" in both directions, as asked.**

*Against the route:* eight years, 425 loans, 148 refinances, and not one incomplete file. Adding
a permanent way to reverse a settled obligation to serve an event that has never occurred is
exactly the kind of surface a migration should refuse to invent.

*For the route, and why it wins:* the operator's other answer means **"never happened" is
unfalsifiable from the record.** I went looking for a forensic signature of a past wrong close and
there is none:

* `fondo_api_loan` has **no `closed_at`** and there is no state-change audit anywhere — I listed
  the columns. Nothing records which upload closed what.
* The residue of a *correct* auto-close is identical to a wrong one. The normal payoff path is
  "omit the loan from next month's file", so a closed loan keeps the **last balance the TSV
  reported**, which is positive. Measured: **336 of 345** PAID_OUT loans have a positive
  `capital_balance`, only 9 are zero. A closed loan that still shows money outstanding is the
  **norm**, not a red flag — so the one query that would find wrong closes returns essentially
  every closed loan in the fund.
* **0 loans have more than one `LoanDetail`** (consistent with §5.1). That does tell us v1's
  corrupting repair has never been walked on live data — but it is equally consistent with
  "happened and nobody noticed" as with "never happened".

So the frequency argument is weaker than it looks. What actually decides it is the comparison of
*repair mechanisms*, not the probability of needing one. Today the only route back is a
hand-written `UPDATE fondo_api_loan SET state = ...` against the production database — an
unguarded, untested, unlogged write by whoever has the credentials, performed under time pressure
on a day when 28 members' loans are wrong. The alternative is a single guarded transition that
D6's upsert has already made safe and that the 409 table constrains. **The API route is the lower-risk
operation**, and choosing the DBA is choosing the more dangerous of the two.

**Why `3 → 1` and not `3 → 0`.** M2 offers `3→0` (option c) so the normal approval re-runs. That
is the wrong repair and it must not be chosen by default:

`updateLoanIn(…, 1)` rebuilds the amortisation table from `disbursement_date`, **upserts the
`LoanDetail` with `capital_balance = loan.value` and `from_date = loan.disbursement_date`** — i.e.
it overwrites the member's real current balance with the **original loan amount**, discarding
every month of TSV-maintained state — and re-sends `CHANGE_STATE_LOAN_APPROVED` to the borrower
with roles `[0,2]` BCC'd. So `3→0→1` would tell 28 members their loan was approved (again) and
reset all 28 balances to face value. That is a far worse event than the close it repairs.

`3 → 1` writes the state and nothing else. The `LoanDetail` was never deleted by the close, so
D6's deterministic read returns the correct, current row untouched. No mail is sent, which is
right: the fund did not tell the member it closed, so it should not tell them it re-opened.

**⚠️ The transition alone is not the repair — it must re-schedule the reminders.** Consequence 3
above. `LEGAL_LOAN_TRANSITIONS`' docblock already says this and the developer verified it in both
stacks; D31 is where it becomes a requirement rather than a warning. On `3 → 1`, re-schedule
T−5d and T−1d from the surviving `LoanDetail.payday_limit`. **Interaction to check with Phase 7:**
if `payday_limit` has already passed, the reminder dates are in the past and **D7** governs
("send immediately on the next scheduler run" per Q8) — which is probably right here, but it is
a P7 cell, not a P4 one.

**What I am *not* proposing:** no `3→0`, no `1→0`, no `2→anything`. One entry.

---

## 2. Decision — who may do it?

### **ADMIN only (role 0), not the default `[0,2]`.** Part of **D31**.

The default inherits `LoanDetailView.PATCH = [0,2]`, which hands the repair to the **treasurer —
the same person whose upload caused the close.** Unilateral, unlogged self-correction is the
wrong default for the one operation that reverses the fund's record of a member's settled
obligation, and narrowing it costs nothing because **there is no working v1 practice to
preserve**: v1 permitted `3→1` to `[0,2]`, but doing it corrupted the loan into a permanent 500
(D6), so nobody has ever legitimately used it.

**This does not contradict Q31 / the withdrawal of D28, and the distinction is worth writing
down** because it will look like a contradiction to a future reader. Q31 says a TREASURER may
approve **their own loan** — a forward action, in the normal course, on a loan a member
requested and which the fund is deciding. Re-opening a closed loan is a **backward correction of
the fund's own record**, triggered by an operator error, on up to 28 loans at once, with no second
party involved anywhere. Different act, different default. Q31 is not evidence that the fund is
relaxed about *this*, because this has never existed.

**⚠️ One consequence the operator must accept explicitly: `fondodev` has exactly one ADMIN**
(measured: 1 ADMIN, 1 PRESIDENT, 1 TREASURER, 12 MEMBERs). ADMIN-only means a single point of
failure — if that person is unavailable, the fund is back to the DBA. I still recommend it,
because the DBA fallback is precisely what exists today and D31 strictly improves on it; but the
operator should say yes to it knowingly.

**Why not add PRESIDENT.** It would look like the natural second holder, but role 1 has **no
loan-write permission at all** today — `LoanDetailView.PATCH` is `[0,2]` and `LoanView.PATCH` is
`[0,2]`. Adding role 1 for this one transition means either a broader permission change than it
appears, or a per-transition role rule, which is new machinery the permission matrix does not
have. If the operator wants a second holder, say so and route the shape to `nestjs-reviewer`;
do not let it in as a side effect.

---

## 3. Decision — does a mass close warrant a notification?

### **Yes — to the operators, not to members.** New row **D32**. This is the part I would ship first.

**The reviewer's m2 is right and the operator's answers sharpen it.** D8 returns
`{"closed_loans": [...]}` — 130 bytes on a whole-fund close — and nothing persists it. The only
other trace is `logger.log`, one line per loan, at the same level as every other log the upload
emits. So whether anyone learns that 28 loans just closed depends on a client change nobody has
been asked for. **D8 is a capability, not a notice**, exactly as filed.

Combine that with the two operator answers and the gap is structural: the close is silent to
members *by design*, and per §1 there is no way to detect one afterwards from the data. If an
incomplete file were uploaded tomorrow, the sequence of events in which anyone finds out is: a
member eventually notices their loan vanished from their app, or tries to refinance and gets a
zero-byte 400 with no message, and complains. That is the fund's current detection mechanism, and
it is not one.

**A notice is separable from a re-open and carries none of its risk.** It adds no way to reverse
anything. Even if the operator rejects D31 entirely, D32 should land — it is what makes "a DBA
fixes it" a *procedure* rather than a hope, because a DBA cannot fix what nobody reports.

**Recommended shape:** when an upload closes one or more loans, send **one SES mail to roles
`[0,2]`** — the same recipient set the fund already uses as BCC on every loan state mail — with
the count and the ids. Rationale for each choice:

* **To `[0,2]`, not just the uploader.** It reaches the treasurer even if their client discards
  the response body, and it reaches the ADMIN, who under D31 is the only person who can repair
  it. The treasurer alone would be the same blind spot D8 already has.
* **Every close, no threshold.** A normal month closes a handful; the count speaks for itself and
  a 28-id mail is unmistakable next to a 2-id one. A threshold is a number nobody can calibrate
  and it would have to be re-tuned as the fund grows.
* **Mail, not web-push.** Push is fan-out via SQS to a Lambda and is best-effort (Q6); this is the
  one message that must not be best-effort.
* Also adopt m2's two no-decision-needed improvements — one `warn` summary line instead of 28 at
  `log`, and the D8 response-shape change into the Phase 9 client-change runbook.

### **No member-facing notification.** Deliberate, and the operator should confirm it.

This is the one place where I am choosing on the fund's behalf about member contact, so I will be
explicit about the reasoning: PAID_OUT is internal bookkeeping (the operator's own answer), and
members are told nothing on a **correct** close. A mass-close notice cannot be scoped to *wrong*
closes, because nothing distinguishes them — so mailing members would fire on every normal
month-end too, and its content would be "your loan is now recorded as paid off", sent to people
who have not finished paying. That is a **new member-facing process the fund has never had**, and
the first thing it would do is confuse the members it is meant to protect.

⚠️ **Flagged as a business-visible recipient decision per my brief.** If the operator wants
borrowers told when their loan closes — which would be a defensible thing to want, and would make
wrong closes self-detecting within a day — that is a **larger** change than C42: it is a new
member-facing email on the *normal* payoff path, not a mass-close alert, and it needs its own row
and its own template. Say so and I will write it up separately.

---

## 4. The D30 consequence on the refinance path — **confirm it, no carve-out**

The developer flagged that D30's floor binds `refinanceLoan`, because it overwrites `value` with
the projected `capital_balance` and calls the same `createLoan`. A refinance whose outstanding
capital is `0` is now a **400** where v1 books a zero-value loan.

**Would the fund ever legitimately refinance a fully-paid loan? No.** Refinancing exists to roll
outstanding capital into a new loan; zero outstanding means there is nothing to roll, and v1's
answer is a loan for $0 that then needs an approval and an amortisation table over zero — the
exact junk row D30 exists to stop. The floor is *narrower* here than it first appears, which makes
it safer: if `includeInterests` is true and capital is 0 but interest is not, `value = interests`
is positive and the refinance still books. Only the genuinely empty case is refused.

**Evidence it has never occurred and cannot occur today:** 148 refinances, smallest `value`
**187 584**; 0 of 425 loans have `value <= 0`; and **no APPROVED loan currently has
`capital_balance <= 0`** — I checked all 28.

**⚠️ One rough edge, not worth a carve-out but worth knowing.** The message is
`"Loan value must be greater than 0"`, and on this route the member never sent a `value` — they
sent a loan id. The 400 will read as nonsense to them. I recommend keeping the single shared
message rather than inventing a second one (a per-route message is new surface for a case that
has never happened), and noting it in the Phase 9 runbook so whoever fields the call knows it
means "that loan has nothing left to refinance". If the operator would rather have a specific
message, it is a one-line change and their call.

**No new id.** This is a consequence of an already-decided row; amend **D30**'s Status cell to
record it as chosen rather than incidental. Suggested addition, to append to D30's existing
Status text:

> ⚠️ **Confirmed to bind the refinance path** (C42): `refinance_loan` overwrites `value` with the
> projected `capital_balance` and calls the same `create_loan`, so a refinance with **zero**
> outstanding capital and no interests is a **400** where v1 books a zero-value loan. Accepted
> deliberately — there is nothing to roll into a new loan, and v1's row is the junk D30 exists to
> stop. `includeInterests` with non-zero interest still books. Never occurred: 148 refinances,
> smallest `value` 187 584; no APPROVED loan has `capital_balance <= 0`. The shared message reads
> oddly on this route (the member sent no `value`) — kept for a single contract, noted in the P9
> runbook.

---

## 5. Paste-ready `MIGRATION_PLAN.md` §5 rows

| # | v1 behavior | Change in v2 | Phase | Status |
|---|---|---|---|---|
| **D31** | A wrongly auto-closed loan **cannot be repaired**. v1 permits `3 → 1`, but the re-approval inserts a second `LoanDetail` (D6) and the loan 500s permanently — the recovery *is* the corruption, so the route has never been legitimately usable. Under **D9** (Q14) v2 refuses `3 → 1` and `3 → 0` with a 409, so after a mass close there is **no API-level recovery at all**: only a hand-written `UPDATE` against the production database. Meanwhile the member cannot refinance (`refinanceLoan` requires state 1 — a **zero-byte 400** with no explanation; 148 of 425 loans are refinances), loses the `loan_detail` block on their own loan, and loses their payment reminders. | **Add `3 → 1` to `LEGAL_LOAN_TRANSITIONS`, restricted to ADMIN (role 0)** — narrower than `LoanDetailView.PATCH`'s `[0,2]`, because the treasurer is the actor whose upload caused the close and this reverses the fund's record of a settled obligation. No mail (the close sent none, so the re-open sends none). ⚠️ **The transition alone is not the repair: it MUST re-schedule the T−5d/T−1d reminders** from the surviving `LoanDetail.payday_limit` — verified in both stacks, `createScheduledTask` is reached only from the per-TSV-row path, so a close deletes the reminders and an unaided re-open does not restore them. ⚠️ `3 → 0` was considered and **rejected**: it re-runs the approval, which resets `capital_balance` to the original `loan.value`, discards every month of TSV state and re-sends the borrower's approval mail. **Not** in tension with Q31 — that permits a forward, normal-course act on the treasurer's own loan; this is a backward correction of an operator error across up to 28 loans. | P4 (P7 cross-check: a past `payday_limit` re-schedules into D7's "send immediately") | ⏳ **Recommended — needs operator.** ⚠️ `fondodev` has exactly **one** ADMIN, so ADMIN-only is a single point of failure; the operator must accept that knowingly. PRESIDENT as a second holder is possible but role 1 has **no** loan-write permission today, so it is a broader change than it looks. |
| **D32** | A bulk upload that auto-closes loans is **silent**. `update_loan(id, 3)` sends no mail and no push (only `remove_sch_notitfications`), and v1 answers a bare `200`. **D8** (Q3) adds `{"closed_loans": [...]}`, but that is **a capability, not a notice** — 130 bytes that help only a client nobody has been asked to change; the sole other trace is one `logger.log` line per loan. A zero-byte file closing all 28 loans measured **SES 0/0, SQS 0/0**. | **On any upload that closes ≥ 1 loan, send one SES mail to roles `[0, 2]`** with the count and the ids — the recipient set the fund already BCCs on every loan-state mail. Reaches the treasurer even if the client discards the body, and reaches the ADMIN, who under **D31** is the only person who can repair it. **No threshold** (a normal month closes a handful; the count speaks). **Mail, not push** — push is best-effort per Q6 and this must not be. ⚠️ **No member-facing mail**: PAID_OUT is internal bookkeeping (operator), members are told nothing on a *correct* close, and nothing distinguishes a wrong close from a right one — so a member notice would fire every month-end and tell people who still owe money that their loan is recorded as paid. Telling borrowers is a defensible but **larger** change (a new email on the normal payoff path) and needs its own row. | P4 | ⏳ **Recommended — needs operator.** New email = business-visible recipient change. **Independent of D31 and should land even if D31 is refused** — "a DBA fixes it" is not a procedure if nobody is told there is anything to fix. Carries m2's two no-decision items: one `warn` summary line instead of 28 at `log`, and D8's response-shape change into the P9 runbook. |

---

## 6. What I could not source, and what I would need

Two things, both stated so nobody reads a decision here as better-founded than it is.

1. **The operator's "never happened" cannot be corroborated or refuted from the data.** There is
   no `closed_at`, no state-change audit, and the residue of a correct auto-close is
   indistinguishable from a wrong one (336 of 345 closed loans carry a stale positive
   `capital_balance`, because omission from the file *is* the normal payoff path). I am taking
   the answer at face value and it is almost certainly right; I am pointing out only that it is
   an unaudited recollection, and that this is itself the argument for **D32**. If the fund keeps
   the monthly TSVs, comparing each file's id set against the loans that closed that month would
   settle it retrospectively — I would need the archive to do that.
2. **Whether the fund wants borrowers told when a loan closes**, on the normal path. I have
   recommended no, from the operator's own "internal bookkeeping" answer, but that answer was
   given about the *record*, not about a *notification* that has never existed and so could not
   have been ruled out. §3 marks it as the operator's call.

I did **not** find any dependence on the Alexa `RequestLoan` intent anywhere on this path — the
auto-close, the state transitions and the refinance route are all treasurer- or member-app
driven. C42 is unaffected by the Alexa removal.

---

## 7. Routing

* **`nestjs-developer`** — D31 (one `LEGAL_LOAN_TRANSITIONS` entry, the ADMIN-only gate, and the
  reminder re-schedule) and D32 (the mail plus m2's `warn` line), **if and when the operator
  approves them**. The §2.10 that D6's row and the `LEGAL_LOAN_TRANSITIONS` docblock both
  forward-reference does not exist yet in `docs/phase-4-deviations.md`; it should be written to
  say what this note concludes, not left as a dangling pointer.
* **`nestjs-reviewer`** — the per-transition role check is a shape the permission matrix does not
  currently express (`LoanDetailView.PATCH` is a flat `[0,2]`). Where that gate lives, and how it
  is pinned so a later refactor cannot widen it back to `[0,2]`, is a design question, and it
  needs a mechanical guard of the kind `loan.service.spec.ts:91` already gives the role arrays.
* **Operator** — three yes/nos: D31 (and ADMIN-only, accepting the single-ADMIN risk), D32, and
  the confirmation that borrowers are *not* told on close.
