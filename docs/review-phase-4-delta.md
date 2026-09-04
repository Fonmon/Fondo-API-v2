# Phase 4 (Loans) — **delta** review

| | |
|---|---|
| **Reviewer** | `nestjs-reviewer` |
| **Date** | 2026-09-04 |
| **Scope** | `git diff 6fdbc3a..17114a0 -- src/ test/` — 5 files, 613 insertions. **Not** a re-review of Phase 4; `docs/review-phase-4.md`'s findings stand and its conditions C40–C49 remain tracked. |
| **Head** | `17114a0`, branch `feat/phase-4-loans` |
| **Read** | `docs/parity-phase-4-delta.md` (PASS), `docs/phase-4-deviations.md` §2.10 / §4.1 / §5.1, `MIGRATION_PLAN.md` §5 D29 D30 D33 and struck D28 D31 D32, `docs/review-phase-4.md`, v1 `fondo_api/services/loan.py` |
| **Gate** | lint clean, `tsc --noEmit` clean, 1863 unit / 58 suites, 827 e2e + 1 skipped / 16 suites, `fondodev` at baseline with `count(distinct xmin::text) = 1` on both loan tables — **verified by the operator, not taken from a report** |
| **Verdict** | **Approved with conditions (C50 – C58).** |

Nothing in the delta is wrong in the small. D29's helper is faithful to CPython, D30's placement
and registration are right, M3's query shape genuinely delivers the guarantee it claims, and the
tester's race cell is sound rather than a false green. Two things need to land before Phase 5
starts, both cheap: one genuinely new failure mode the delta introduced on the highest-consequence
endpoint in the phase, and one docblock claim that is false for exactly one race pair. The rest
is documentation and rolls to Phase 5's gate.

---

## 1. M3 — the compare-and-set

### 1.1 The query shape delivers. Judged, not accepted.

`src/loans/loan.service.ts:593`

```ts
const applied = await tx.loan.updateMany({ where: { id, state: loan.state }, data: { state } });
if (applied.count === 0) { throw ApiException.withMessage(HttpStatus.CONFLICT, 'Invalid state transition'); }
```

This compiles to `UPDATE fondo_api_loan SET state = $1 WHERE id = $2 AND state = $3`. Under
READ COMMITTED — which is what Prisma's interactive transaction runs at, as the docblock correctly
says — PostgreSQL applies EvalPlanQual: a second updater targeting the same row blocks on the
first's row lock, and **after the first commits it re-reads the new row version and re-evaluates
the `WHERE` clause**. A changed `state` fails the predicate, the row is not counted, `count` is 0.
The write is therefore the serialisation point, exactly as claimed. It works across processes
(an in-process mutex would not), needs no isolation-level change, and needs no schema change on a
database Django still owns. **This is the right primitive and the predicate is the right one.**

I agree with the developer's refusal to write a timing-dependent race test, and the guarantee does
rest on shape. Two limits on the shape are worth recording, because §5.1's current wording is
wider than what the code buys:

* **The CAS pins `state` and nothing else.** Everything downstream of the write — `loan.value`,
  `timelimit`, `fee`, `rate`, `disbursement_date`, `prev_loan_id`, `user.auth_user.email`, all fed
  into `generateAmortizationTable` and `upsertLoanDetail` — comes from the **pre-CAS** `findUnique`
  at `loan.service.ts:569`. That is safe today only because no route in v1 or v2 mutates those
  columns after create. Nobody has written that invariant down. A `SELECT … FOR UPDATE` would have
  pinned the whole row; the CAS does not. If a later phase adds a loan-edit route, the amortisation
  table gets generated from a stale row and no test will notice.
* **The parent loan is not protected.** The approval leg writes
  `tx.loan.update({ where: { id: loan.prev_loan_id }, data: { state: LOAN_PAID_OUT } })` and the
  denial leg `{ refinanced_loan: null }` — both unconditional. So §5.1's
  "**at most one transition per loan can proceed**" (`docs/phase-4-deviations.md:440`) is true for
  the loan named in the URL and not for the parent it touches. Low consequence and v1 is worse, but
  the sentence should say what it means.

Nothing downstream of the write assumes a state the CAS has not confirmed: the `LoanDetail` upsert,
the mail and the `removeSchNotifications` call all key off `state`, the parameter, and off `loan`'s
immutable columns. The `$transaction` interacts correctly — the CAS is inside it, the loser's throw
rolls the whole unit back, and no mail is sent on the losing side (the tester measured 1 mail, not
2, from a capture stub that recorded a mail on `0 → 1` in the same run).

### 1.2 The tester's race cell is sound. It is not a false green in a new costume.

The single plausible false-green vector for a cell like this is **in-process serialisation**: if
Node, Nest or the Prisma pool had serialised the two requests, the loser would have read `state = 1`
and been refused by `assertLegalLoanTransition` — the *guard*, not the CAS — and the cell would go
green while proving nothing about the write it was built to test.

The `pg_stat_activity` precondition is precisely the discriminator for that vector. Two sessions in
`wait_event_type = 'Lock'` can only exist if both requests had already completed their `findUnique`,
already passed the guard, and were both blocked on the `UPDATE`. A single-connection pool would show
1. A `findUnique` that blocked would show 1. A request that had not started would show 1. Requiring
**exactly** 2 rather than "at least 2" also fails closed on a stray blocker, and reporting
INCONCLUSIVE rather than passing when the precondition is unmet is the right default. v1 in the same
harness reproduces the corruption (2 `LoanDetail` rows, 2 mails), so the probe demonstrably can see
the bug it is asserting the absence of. Three runs, identical, no sleep anywhere in the path.

**I accept this cell.** Its limit — which the report states itself, correctly — is that it
constructs *one* interleaving of *one* pair (`0→1` against `0→1`). It is evidence for the shape
argument, not a substitute for it. See §1.4 for the pair it does not cover.

### 1.3 🔴 **Major — the CAS turns a concurrent state change during a TSV upload into a full-file 409 rollback, and the code's own test comment claims the opposite.**

`src/loans/loan.service.ts:843` — inside `bulkUpdateLoans`' `$transaction`:

```ts
await this.updateLoanIn(tx, loan.id, LOAN_PAID_OUT);
```

There is no `try`/`catch` around it.

**v1:** `bulk_update_loans` is `@transaction.atomic` and `update_loan` writes `loan.state`
unconditionally. A loan denied or paid out by another admin between the `get_loans(state=1)` read
and the auto-close write is silently overwritten — a lost update, but **the file lands and the
treasurer gets a 200**.

**v2 now:** `getLoans(null, null, true, LOAN_APPROVED, false, tx)` reads the approved set; for each
id absent from the file, `updateLoanIn` re-reads (`state = 1`) and CASes on `WHERE id AND state = 1`.
A concurrent `PATCH /api/loan/<id> {"state":2}` or `{"state":3}` that commits inside that window
makes `count === 0`, which throws `ApiException 409 {'message':'Invalid state transition'}` **out of
the transaction callback**. The entire monthly upload — up to 374 `LoanDetail` upserts, every
scheduler row, every other auto-close — rolls back, and the treasurer gets a 409 whose body names
neither the file nor the loan.

Why this matters more than its probability suggests: this is the endpoint §4.4 puts a data-safety
warning on, it runs in a 120 s transaction, and a denial or payout by another admin at month-end is
exactly the concurrent event this window is open for. The failure is silent about its cause, and per
§2.10 the fund's recovery posture for anything that goes wrong here is now a DBA.

The delta's own documentation asserts the opposite behaviour in two places:

* `src/loans/loan.service.spec.ts:873` — "A loan approved between the read and the write is
  therefore **skipped with a 409** rather than silently closed." It is not skipped. It aborts.
* `docs/phase-4-deviations.md:440` — the guarantee paragraph reads as if the bulk path degrades
  gracefully ("…the `bulkUpdateLoans` auto-close included").

No test covers it: `buildBulk`'s mock is `updateMany: jest.fn().mockResolvedValue({ count: 1 })`,
always 1.

**Fix.** Catch the 409 in the auto-close loop and `continue` — which is both the semantically right
answer (a loan someone just denied must *not* be force-closed) and a direct mirror of v1's
`except LoanDetail.DoesNotExist: logger.error(...); continue` in the same method. Log at `warn`
with the loan id, and leave the id out of `closed_loans`. One unit cell: two auto-close candidates,
`updateMany` returning `{count: 0}` for the first, assert a 200, `closed_loans` containing only the
second, and the `LoanDetail` upserts intact. Reading the approved set `FOR UPDATE` would also work
but is the wrong trade — it would block the denial rather than let it win. **C50.**

### 1.4 🟡 **Minor — the 409 conflates "you lost the race" with "this transition is illegal", and there is exactly one pair where sequential execution would have succeeded.**

`src/loans/loan.service.ts:588` claims the loser gets "the same status and body it would have
received had it arrived a millisecond later and lost the guard instead of the write". I enumerated
every race pair D9 permits:

| winner | loser | state after winner | loser's transition from that state | sequential | CAS |
|---|---|---|---|---|---|
| `0→1` | `0→1` | 1 | `1→1` illegal | 409 | 409 ✅ |
| `0→2` | `0→2` | 2 | no entry for 2 | 409 | 409 ✅ |
| `0→2` | `0→1` | 2 | no entry for 2 | 409 | 409 ✅ |
| `1→2` | `1→3` | 2 | no entry for 2 | 409 | 409 ✅ |
| `1→3` | `1→2` | 3 | no entry for 3 | 409 | 409 ✅ |
| **`0→1`** | **`0→2`** | **1** | **`1→2` is LEGAL** | **200** | **409 ❌** |

So the claim holds for five of six pairs and is false for the sixth: an approve and a deny racing on
a WAITING loan, approve wins. Sequentially the denier gets a 200 — the denial mail *and* the
`prev_loan.refinanced_loan = null` unlink. Under the CAS they get "Invalid state transition", which
reads as "not allowed, do not retry", so the denial silently does not happen. The deny is the
safety-side action, which is what makes this worth a line rather than a shrug.

The tester's cell does not cover this pair (§4.2 of the parity report races `0→1` against `0→1`
only), so the PASS is real but does not reach it.

**Fix — pick one.** (a) On `count === 0`, re-read the row once and re-run
`assertLegalLoanTransition`; if the transition is legal from the new state, retry the CAS once.
Bounded, and it reproduces sequential semantics exactly. (b) Leave the behaviour and correct the
docblock, registering the cell in §4.1 and under §5 D9 as "the loser of a concurrent approve/deny
gets a 409 where sequential execution gives a 200". (a) is correct; (b) is honest. What must not
stand is the claim as currently written. **C51.**

### 1.5 🔵 **Nit — the loser now blocks across an SES call.**

The winner's transaction holds the row lock through `getUserEmails`, `generateAmortizationTable`,
`upsertLoanDetail` and `this.mail.sendMail`. Before the delta the loser completed immediately (with
a lost update); it now waits for the winner's full remaining transaction, SES included. The 20 s
budget at `loan.service.ts:556` was sized for SES's own worst case (C22) — it now has to cover a
queued second caller *plus* SES, and if it does not, the loser gets Prisma's `P2028` (a 500) instead
of the 409. Worth one sentence on C22's note and one check that P2028 renders P3-D6-shaped. **C57.**

---

## 2. D29 — `pythonGreaterThan`, and compare-then-coerce

**The helper is faithful to CPython.** Checked cell by cell against the semantics, not against the
spec file:

* **Exactness beyond 2^53 is constructed correctly, and this is the part that could easily have been
  wrong.** An integral `number` converts to `BigInt` exactly; a non-integral one uses `Math.ceil`,
  and for integral `stored` and non-integral `s`, `s > stored ⟺ ceil(s) > stored` — verified in both
  signs, including `-0.5 > -1n → true`. Any non-integral double has |s| < 2^52, so
  `BigInt(Math.ceil(s))` is exact. **No double is ever asked to represent `stored`**, which is what
  keeps a 19-digit quota out of a 53-bit mantissa. Comparing through `Number(stored)` would have
  lied, and the spec pins it (`9007199254740992 > 9007199254740993n → false`).
* `bool` as an `int` subclass, `NaN → false` for every comparison, `±Infinity`, and the `TypeError`
  message shape for `str` / `NoneType` / `list` / `dict` — all match.

**The string leniency is taken at the call site, not buried in the helper.**
`src/loans/loan.service.ts:237`:

```ts
const compared = typeof rawValue === 'string' ? toDjangoInt(rawValue, 'value') : rawValue;
```

and `pythonGreaterThan` itself throws for a `str`, pinned by its own spec cell. That is the right
placement and it matters: this helper will be reused in Phases 5–8, and a deviation hidden inside it
would spread silently into call sites nobody re-decided. The ordering `and not refinance` is
preserved (comparison first, short-circuit second) and pinned by a cell that drives it through the
refinance path with `value: null`.

The divergent window `Q < value < Q + 1` is closed and the **v1 side was measured end-to-end this
time**, which is what the previous gate asked for: quota 500, `value 500.5` → 406/406, 48 B both,
zero rows on both, with `value=1000` as the positive control proving the probe can see agreement and
`value=0` proving it can see a difference. The `quota 0 / value 0.5 → 406 on both` cell closes the
other end of the range. **No finding.**

🔵 Nit: `python-obj.ts:320`'s `return 'float'` is an unreachable default for the `number` branch
(handled above it) and would be wrong for a `symbol` or a function. **C57.**

---

## 3. D30 — the floor at 1

**The divergence is registered clearly enough.** Five independent carriers, all using the "v1
accepts this, v2 refuses by decision" framing in as many words rather than by implication:
`MIGRATION_PLAN.md` §5 D30, `docs/phase-4-deviations.md` §1.1's D30 row, §4.1's four rows (which say
"file the 400 as **expected**" explicitly), `MIN_LOAN_VALUE`'s docblock at `loan.service.ts:89`, and
the unit and e2e cells' own doc comments. A future parity round that reads any one of them cannot
file the 400 as a regression. **C40's standard is met here.**

**The check sits after the quota gate**, and that is established by a real discriminator rather than
by restating the source order: the unit cell drives `available_quota: -10n` with `value: 0`, and the
tester's group C runs quota `-5` / `value 0` → **406 on both**, noting that a floor-first v2 would
have answered 400. Good.

### 3.1 The refinance binding — is the shape right?

**Yes, and it should be documented as the intended shape rather than as an observed difference.**

v1 `services/loan.py:145-147` sets `loan.refinanced_loan = new_loan_id` **after** `create_loan`
returns, and `refinance_loan` has no `transaction.atomic`. v2 mirrors that: the
`prisma.loan.update` at `loan.service.ts:735` never runs when `createLoan` throws, so the refusal
touches **no table at all** (the tester measured `tables touched: []`). v1 writes the child *and*
links the parent; v2 writes neither.

That is the right outcome — a refused refinance must not leave a parent pointing at a loan that does
not exist — and the reason to write it down is precisely so nobody "fixes" it later by moving the
link ahead of the create. Note that `refinanceLoan`'s docblock at `loan.service.ts:688` already
anticipated this exactly ("a `create_loan` failure between the two writes leaves the old loan
un-linked"); D30 turned that hypothetical into a reachable path, and the sentence should now say so.

The message wording on this route ("Loan value must be greater than 0" to a caller who sent a loan
id) is registered as a nit on §5's D30 row and I agree it is not a defect — but it should carry an
owner and a phase rather than "a later pass".

---

## 4. The two documentation items routed to me

### 4.1 §4.1's refinance row — **endorsed, with a correction to the wording.**

The tester is right that a negative `capital_balance` behaves the same and produces a strictly worse
v1 row (`value = -500`, `-522` with `includeInterests`, i.e. interest computed on a negative
balance). But "less than 1" should be applied to **the value that would be written**, not to
`capital_balance`: `refinanceLoan` adds the interests *before* `createLoan` sees the number, and the
floor is checked after `toDjangoInt`. Accurate wording:

> `POST /api/loan/<id>/refinance` whose projected **`value`** — the `capital_balance`, plus the
> interests if `includeInterests` is truthy — is **less than 1**

Keep the negative case explicit rather than folding it into "≤ 0"; the v1 row it replaces is the
worse of the two and is the one a reader should see. **C52.**

### 4.2 The parent staying unlinked — **endorsed, and state it as intended.**

Add one clause to the §4.1 row: *v1 writes the child row **and** sets the parent's
`refinanced_loan`; v2 touches no table at all, which is the intended shape — a refused refinance
must leave no half-linked chain.* And one sentence on the `refinanceLoan` docblock
(`loan.service.ts:688`) noting that D30 made its "no transaction" warning reachable. **C52.**

---

## 5. D33 — registered adequately? Mostly.

The §5 D33 row is complete and correctly linked to D31's withdrawal, and §2.10's third numbered fact
frames it exactly right for its reader: *"reminders may be present, absent, or duplicated depending
on how many uploads have passed. Check, do not assume."* The tester measured it on both stacks with
a non-vacuous mid-scenario query (2 → 0 → 2), so "re-created" is a measurement.

**The gap is §4.2.** D33 is a *non*-diff — both stacks behave identically — so §4.1 is the wrong
home and §4.2 ("explicitly unchanged — if these differ, that IS a failure") is the right one, and it
has no line there. Adding a state filter to `updateLoanDetail` is exactly the kind of obvious-looking
tidy-up a later phase would make, and today nothing would catch it: there is also **no automated cell
for D33 anywhere in `src/` or `test/`** — it is pinned only in the tester's harness. Since §2.10 now
instructs a DBA to *expect* the self-heal, the behaviour is load-bearing for the recovery procedure
and has to be pinned in the repo. One §4.2 bullet plus one unit cell on `updateLoanDetail`
(a PAID_OUT loan's detail is updated and `scheduleNotification` is called). **C53.**

---

## 6. C40's carrier, and §2.10

### 6.1 C40 — **the carrier carries.**

Ten `**§5 rows this phase owns:**` lines, one per §3 phase block. Two of them are the ones that
matter. Phase 4's (`MIGRATION_PLAN.md:465`) names D29 and D30, flags D28 withdrawn, and carries
"D10 and D25 must land together". Phase 5's (`:527`) says **none** *and shows the derivation* —
`grep -c '| P5 |'` → 0, plus the whole column distribution — which is the difference between an
index and a claim: the next reader can re-derive it instead of trusting it. Phase 2's does the same.
This is the mechanical control I asked for and it is better than what I specified.

C40's second half (broadening #18's rule) is not in #18's row, but instance **#19** carries it and
carries it better — "a commit message is a claim about a *tree*, so verify every item the brief
listed, not the ones that were easy to check", with the line-wrap countermeasure that was the actual
root cause. Accepted as met; a cross-reference from #18 to #19 would let the rule be found from
either row. **Nit, C57.**

### 6.2 §2.10 — **right content, wrong location for its audience.**

The section is honest about the hard part, which is what makes it worth having: it says plainly that
"it has never happened" did not settle the question, that there is no forensic signature to look for
(no `closed_at`, no state audit, and **336 of 345** PAID_OUT loans carry a positive
`capital_balance` because omission from the next file *is* the normal payoff path), and that it was
decided on risk appetite. Three numbered facts, each paired with the failure mode it prevents.
`3 → 0` explicitly closed and marked not-revisitable. Carrying D31 and D32 as **struck rows** rather
than deleting them is the right mechanism — the reasoning is findable instead of re-litigable.

But it is not reachable from `MIGRATION_PLAN.md`. §2.10 is referenced only from
`docs/phase-4-deviations.md`'s own D6 row, the `LEGAL_LOAN_TRANSITIONS` docblock, and
`ba-phase-4-c42.md`. §5's D31 row says the recovery "is a **direct database repair** — now a
*deliberate, recorded* procedure" without saying **where** it is recorded, and Phase 9's runbook
block (`MIGRATION_PLAN.md:683`ff) — the one artifact that outlives the phase documents and that an
operator will actually open during an incident — does not mention it at all.

This is C40's failure mode one level up: the *decision* has a carrier, the *procedure* is a
paragraph in a phase document whose own header addresses §1–§3 to the reviewer. One pointer in D31's
row and one line in the Phase 9 runbook closes it. **C54.**

### 6.3 §5.1 is now stale in the direction that loses evidence.

`docs/phase-4-deviations.md:451` says "**No test races two real transactions.**" That was true when
written and is no longer: `d3-race.py` builds a deterministic interleaving with v1 as a positive
control. Two things follow. The paragraph should cite it. And — more importantly — **that probe
lives in `~/.fondo-parity-harness/p4/`, outside version control.** It is the strongest artifact this
delta produced, it is the only thing that has ever demonstrated the defect M3 fixes, and Phase 9's
`UNIQUE (loan_id)` work will want to re-run it. It should land in the repo as an opt-in cell (env
guard or a tagged suite), not stay in a home directory. **C55, C56.**

---

## 7. C48's rollovers

At the last gate I warned that C31–C35, C37 and C39 were at their deadline and that a second silent
roll would make the tracking mechanism decorative. `docs/SESSION-STATE.md:47` now records that they
"have survived two gates" — so they are correctly *labelled*, and the label is not the close. The
delta did not touch them and could not have; it is five files, all Phase 4.

I am not holding Phase 4 for Phase 3's conditions — that is the wrong lever and would punish the
wrong work. But two survivals is the point at which "tracked" stops meaning anything, so the third
gate is a hard one: **C31–C35, C37 and C39 must be closed, or formally struck as §5-style withdrawn
rows with the reasoning, before Phase 5's gate.** If any of them would roll a third time, the correct
action is to withdraw it explicitly rather than carry it. **C58.**

---

## 8. Conditions (C50 – C58)

| # | Condition | Source | Due |
|---|---|---|---|
| **C50** | The bulk auto-close must **skip** a CAS miss, not abort the file. Catch the 409 at `loan.service.ts:843`, `warn` with the loan id, omit it from `closed_loans`, continue — mirroring v1's `except LoanDetail.DoesNotExist: continue` in the same loop. One unit cell with `updateMany` returning `{count: 0}` for one of two candidates. Correct `loan.service.spec.ts:873` ("skipped with a 409" — it is not) and §5.1's guarantee paragraph. | §1.3 | **Before Phase 5 starts** |
| **C51** | `loan.service.ts:588`'s claim is false for the approve-wins / deny-loses pair, where sequential execution gives a 200. Either add the single bounded re-read-and-retry, or correct the docblock and register the cell in §4.1 and under §5 D9. | §1.4 | **Before Phase 5 starts** |
| **C52** | §4.1's refinance row: widen to "the projected **`value`** — `capital_balance` plus interests if requested — is **less than 1**", keeping the negative case explicit; add the parent-unlinked clause **stated as the intended shape**; add the sentence to `refinanceLoan`'s docblock (`loan.service.ts:688`) that D30 made its "no transaction" warning reachable. Give D30's refinance message nit an owner and a phase. | §3.1, §4 | Phase 5 gate |
| **C53** | D33 gets a §4.2 bullet (it is a non-diff, so §4.1 is the wrong home) and one in-repo unit cell on `updateLoanDetail`: a PAID_OUT loan's detail is updated and `scheduleNotification` fires. §2.10 now depends on this behaviour being stable. | §5 | Phase 5 gate |
| **C54** | Make §2.10 reachable from the plan: a pointer on §5's D31 row saying where the procedure is written, and one line in Phase 9's runbook block (`MIGRATION_PLAN.md:683`ff). | §6.2 | Phase 5 gate |
| **C55** | §5.1's guarantee paragraph: narrow "at most one transition per loan" to the loan named in the URL (the `prev_loan` writes are unconditional); state the invariant the CAS relies on (only `state` is pinned — every other column feeding the amortisation table comes from the pre-CAS read, safe only because no route mutates it); replace "no test races two real transactions" with a citation of `d3-race.py`. | §1.1, §6.3 | Phase 5 gate |
| **C56** | Land `d3-race.py`'s construction in the repo as an opt-in cell. It is the only artifact that has ever demonstrated the defect M3 fixes, and Phase 9's `UNIQUE (loan_id)` work needs to re-run it. | §6.3 | Phase 9 (land the file sooner) |
| **C57** | Nits: C22's budget note now covers a queued loser plus SES — check P2028 renders P3-D6-shaped; `python-obj.ts:320`'s unreachable `return 'float'`; a cross-reference from false-green #18 to #19. | §1.5, §2, §6.1 | Phase 5 gate |
| **C58** | **C48's rollovers — hard deadline.** C31–C35, C37, C39 (and C38's non-BA half) close or are formally struck as withdrawn rows with reasoning, before Phase 5's gate. A third roll is not available. | §7 | Phase 5 gate |

**C50 and C51 gate Phase 5's start** — roughly fifteen lines of code, one unit cell and one docblock.
**C52–C58 are tracked to Phase 5's gate.** Nothing here re-opens the phase: no finding is a parity
failure against v1, and the one behavioural change required (C50) is strictly a narrowing of a new
failure mode the delta introduced.

**Escalated to `business-analyst`:** none new. C42 is answered and closed via D31/D32.

# **Approved with conditions (C50 – C58).**
