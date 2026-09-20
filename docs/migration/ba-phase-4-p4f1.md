# BA note — Phase 4, finding P4-F1 (`value` as a JSON string on `POST /api/loan`)

**Verdict: Concerns.** One accepted deviation, one new fix row, two unmeasured cells, one
operator fact I cannot source.

| | |
|---|---|
| Date | 2026-09-04 |
| Source finding | `docs/parity-phase-4.md` §5, **P4-F1** |
| Register rows produced | **D29** (accept the coercion) and **D30** (add the missing lower bound) — **two rows, not one** |
| Blocking? | **No.** Both are one-cell changes. D30 carries one operator question that improves it but does not gate it. |

---

## 1. Decision

### D29 — `value` as an integer-shaped string: **v2 diverges, and we keep the divergence.** Accepted improvement.

v1's refusal is **a crash, not a rule.** `create_loan` compares the raw request value against a
`BigIntegerField`:

```python
if obj['value'] > user_finance.available_quota and not refinance:   # services/loan.py:27
```

`'1000' > 1000` is a `TypeError` in Python 3, raised before `Loan.objects.create`, so v1 answers
500 and writes nothing. Nobody chose that. Three things prove it is incidental rather than
intended:

1. **The same string is fine everywhere else on the same request.** `BigIntegerField.get_prep_value`
   is `int()`, so `"1000"` would have stored as `1000` had it reached the column — and `fee`,
   `payment` and `disbursement_value` do reach it, unguarded (`services/loan.py:37-46`).
2. **`timelimit` is explicitly coerced** on the very next line (`int(obj['timelimit'])`), so the
   author's intent on this endpoint was clearly to accept what `int()` accepts.
3. **The quota check is the only raw comparison in v1's entire service layer.** I grepped every
   `obj[...]` used in an ordering comparison across `fondo_api/services/`: `loan.py:27` is the
   only one. It is a one-off, not a house style.

Porting it means writing a deliberate `TypeError` into v2 so that a request whose intent is
unambiguous crashes. Against that, v2's current behaviour gives the member **the fund's real
answer**: `"30000001"` against a 30 000 000 quota is a **406 `User does not have available
quota`** on v2 and a **500** on v1. The 406 is correct and the 500 is not.

**Money is unaffected.** The quota is still enforced, on the coerced number — this is not a
bypass. The row v2 writes for `"1000"` is identical to the row a well-formed client produces for
`1000`. No rate, rounding, day count, permission or email recipient moves.

**Why not make `value` strict instead** (the "deliberate 400 in D4's style" option): `value`
would become the only integer column in v2 with a non-Django contract, while `fee`, `payment`,
`disbursement_value`, `identification`, `total_quota` and `utilized_quota` all coerce. And once
**D30** lands, the strict rule buys nothing the fund cares about — D30 already refuses the one
coerced input that could produce a bad row (`"-1000"`), and it refuses it whether it arrives as a
string or as a number, which the P4-F1 framing would have missed. Strictness would be a rule
about JSON types; D30 is a rule about money.

### D30 — `value` has **no lower bound on either stack**: **fix.** Separate row, separate decision.

This is not a parity divergence. `create_loan`'s only test on `value` is `> available_quota`, so

```
value: 0      -> 201, row written, on BOTH stacks
value: -1000  -> 201, row written, on BOTH stacks
```

as plain JSON numbers. `"-1000"` reaching v2 is a *symptom* of D29, not the disease — the disease
is that nothing anywhere says a loan is for a positive amount. It needs its own row precisely
because v1 and v2 currently **agree**: without a registered row, `manual-tester` will read the new
refusal as a Phase 4 regression.

What an approved negative loan does: a `LoanDetail` with a negative `capital_balance`, an approval
email carrying a negative amortisation table to the member with roles 0 and 2 in Bcc (D5), and an
APPROVED loan that must then appear in every monthly TSV or be auto-closed. There is **no loan
delete route** (`DELETE /api/loan` is 403 for ADMIN too), so the only remedy is a manual DENY.

Severity is genuinely low: creation is self-service but approval is not, so a treasurer stands
between a junk row and any consequence. Recommended as cheap defensive validation, not as a fix
for an observed loss. **See §4 for the operator question that would make this row worth more.**

---

## 2. Was v1 500-ing on real loan requests? **No.** Settled from the database.

This was the part of P4-F1 that would have made it a live defect, and it resolves negatively.

```
fondo_api_loan: 425 rows, 277 of them direct creates (prev_loan_id IS NULL),
by 13 distinct members, continuously 2018 → 2026, most recent 2026-08-10.
```

A string `value` is a 500 with **no row** in v1. 277 direct creates by 13 different members across
nine years, up to four weeks ago, is only possible if the client sends `value` as a JSON number.
The loan-request path is working and has always worked. **P4-F1 is a parity curiosity, not a live
defect**, and neither option changes what any real request does today.

The second known caller agrees: v1's Alexa `RequestLoanIntent` builds its payload with
`value_slot = int(slots[slot]['value'])` for every non-date slot
(`fondo_api/services/alexa/intents/request_loan_intent.py`), so the voice path also sent an int.

**What would still be needed to make this airtight** (none of it is blocking, since the fix is
inert either way):

- **Definitive:** v1's production logs grepped for
  `TypeError: '>' not supported between instances of 'str' and 'int'` at `services/loan.py:27`.
  A non-zero count would mean some client path *is* sending a string and members on that path have
  been unable to request loans. A zero count closes it completely. I have no access to those logs.
- **Nearly as good:** one browser Network capture of a real loan request from the React client, or
  the client's `POST /api/loan` payload construction (the client is in neither repo).
- **Weakest but cheap:** ask the operator whether any member has ever reported a loan request
  failing with a server error. 277 successful creates already argue no.

---

## 3. The coercion asymmetry elsewhere — audited

**On the loan create path there is nothing else.** `fee`, `payment` and `disbursement_value` are
passed **raw** to `Loan.objects.create` in v1 and coerced by Django's `get_prep_value` (`int()`);
v2 uses `toDjangoSmallInt` / `toDjangoNullableInt`, which is the same `int()`. Same accepts, same
rejects, same stored value, including `int(1.9) == 1` and `int(True) == 1`. **No divergence.**
`value` is the only field on this endpoint that is *read* before it is stored.

Refinance is immune by construction: `refinance_loan` overwrites `new_loan['value']` with the
projected `capital_balance` before calling `create_loan`, and passes `refinance=True`, which skips
the quota check entirely (`services/loan.py:125-140`).

**Two things worth naming for the developer and the reviewer:**

1. ⚠️ **Unmeasured cell, same root cause, and it is on the quota boundary.** v1 compares the
   **raw** value then coerces for the write; v2 coerces **then** compares. For a fractional
   `value` in `(available_quota, available_quota + 1]` the two disagree:

   ```
   value: 30000000.5, available_quota 30000000
     v1: 30000000.5 > 30000000 -> True  -> 406
     v2: BigInt(trunc(30000000.5)) = 30000000, not > 30000000 -> 201, row value 30000000
   ```

   Sub-one-unit, so immaterial to the fund, and I recommend accepting it under D29 rather than
   restructuring the check — but the tester's P4-F1 table only covered strings and **this cell was
   never run**. It should be, so the accept is on measured ground.

2. ✅ **Phase 3 already got this ordering right, which is the better precedent.**
   `updateUserFinance` (`src/users/user.service.ts:777-781`) compares the **raw** submitted values
   with `pythonNotEqual` and only calls `toDjangoInt` afterwards, for the write — deliberately, so
   that v1's `user_finance.total_quota != obj['total_quota']` semantics survive (in Python
   `'1000' != 1000` is `True`, so a string-typed but numerically unchanged finance PATCH **does**
   write and **does** bump `last_modified`, an `auto_now` `DateField`). `createLoan` is the one
   place in v2 that coerces before comparing. If the reviewer would rather have v2 internally
   consistent, the shape already exists — a `pythonGreaterThan` sibling would give exact v1
   parity including the fractional cell, at the price of porting the 500. I do **not** recommend
   it, for the reasons in §1, but the option is real and cheap, and the operator should know it
   exists before choosing D29.

---

## 4. Needs the operator — one fact I cannot source

**Is there a minimum loan amount in the fund's rules?**

I can source everything else from the code and the database; this is fund policy and I will not
guess at it. It matters because it sets D30's floor:

- A floor of **1** is the weakest defensible bound — `Loan.value` is a `BigIntegerField`, money is
  whole units, and a loan for zero or a negative amount is not a loan. It catches only zero and
  negatives, **neither of which has ever occurred**: `0 of 425` rows have `value <= 0`.
- The fund **does** receive accidental amounts through the real client and handles them by hand:
  the three smallest loans on record are **id 132 (`value` 1)**, **id 198 (`value` 1)** and
  **id 109 (`value` 500)** — all direct creates by member 11, all ending in **state 2 (DENIED)**.
  A floor of 1 would not have stopped any of them.

So: if the answer is "no minimum, the treasurer just denies silly requests", D30 stands at `>= 1`
as cheap insurance and nothing more. If there **is** a stated minimum, that number replaces 1 and
D30 stops three manual denials a decade instead of zero.

**Two smaller confirmations, neither blocking:**

- **D29 is a product-contract preference, not a fund rule.** Whether v2 should be lenient at the
  API edge is the operator's call; both answers are one cell. My recommendation is above.
- **D30's status is 400, matching D4** (`Timelimit must be between 1 and 36`), its sibling bounds
  check on the same endpoint. `create_loan`'s own house style is 406 — `docs/phase-4-deviations.md`
  §2.2 already flags this inconsistency for D4. If the operator harmonises, both rows move together.

**Alexa (standing check):** `RequestLoanIntent` calls `create_loan` directly, so removing the skill
removes the fund's **voice loan-request path** outright. Already confirmed acceptable — operator
**Q13**, twice: *"Alexa users: none — safe to remove"*. **Not reopened here.** Incidentally, that
path may already be dead: `process_slots` never sets `disbursement_value`, and `create_loan` reads
`obj['disbursement_value']` unconditionally, so unless the published skill declares a slot with
that exact name the intent has been a `KeyError` 500. I cannot verify without the skill's
interaction model, which is in neither repo. It does not change the removal decision.

---

## 5. Paste-ready `MIGRATION_PLAN.md` §5 rows

Two rows. They are separately decidable — the operator can take D29 and refuse D30, or the
reverse — and they have different provenance: **D29 is a v1↔v2 divergence the tester measured**,
**D30 is a defect both stacks share**, which `manual-tester` must have registered or it will read
the new 400 as a Phase 4 regression.

```markdown
| **D29** | `create_loan` compares the **raw** request value — `if obj['value'] > user_finance.available_quota` (`services/loan.py:27`) — against a `BigIntegerField`, so an integer-shaped **string** (`"1000"`, `" 1000 "`, `"+1000"`, `"-1000"`) raises `TypeError: '>' not supported between instances of 'str' and 'int'` **before** `Loan.objects.create`: an uncaught **500**, **no row**. The refusal is a crash, not a rule — the same string stores fine (`get_prep_value` is `int()`), `timelimit` **is** coerced on the next line, and `loan.py:27` is the **only** raw ordering comparison in v1's whole service layer. Parity finding **P4-F1**. | **Keep v2's coercion — accept the divergence.** `toDjangoInt(pyGet(obj,'value'),'value')` runs first, so `"1000"` books the loan the member asked for (**201**, row identical to a well-formed request) and `"30000001"` gets the fund's real answer, **406 `User does not have available quota`**, where v1 gives a 500. **Not a quota bypass** — the quota is enforced on the coerced number, and no rate, rounding, day count, permission or email recipient moves. Non-integer strings (`"1e3"`, `"1000.7"`, `""`, `"0x10"`) stay a **500 on both**. Refinance is immune (`value` is overwritten and the quota check skipped). **No live traffic is affected: 277 direct creates by 13 members, 2018→2026-08-10, prove the client sends a JSON number.** ⚠️ **Residual, unmeasured — must be a cell:** v2 coerces *then* compares where v1 compares *then* coerces, so a fractional `value` in `(available_quota, available_quota+1]` (e.g. `30000000.5` vs a 30 000 000 quota) is **406 on v1, 201 on v2** (stored 30 000 000). Sub-one-unit; accepted. Exact parity is available via a `pythonGreaterThan` sibling to Phase 3's `pythonNotEqual` — **not** recommended, as it ports the 500. | P4 | ⏳ **Proposed — accept (improvement).** Needs the operator's yes; one cell either way. |
| **D30** | **`value` has no lower bound on either stack.** `create_loan`'s only test is `> available_quota`, so `value: 0` and `value: -1000` **as JSON numbers** are accepted and written by **v1 and v2 alike** — a shared defect, **not** a parity divergence, which is why it needs its own row: without one the new refusal reads as a Phase 4 regression. An approved negative loan writes a `LoanDetail` with a negative `capital_balance`, mails the member a negative amortisation table (roles 0 and 2 in Bcc, D5), and becomes an APPROVED loan that must appear in every monthly TSV or auto-close. **There is no loan-delete route** — the only remedy is a manual DENY. Live: **0 of 425** rows have `value <= 0`; the three smallest (ids 132, 198 at `value` 1 and id 109 at 500, all member 11) are all **DENIED by hand**, so accidental amounts do reach the fund and are absorbed by the treasurer today. | **Reject `value < 1` with `400 {"message": "Loan value must be greater than 0"}`**, in **D4**'s style, placed after the `int()` coercion and before the quota check — so it also catches `0.5` (→ 0) and, via **D29**, `"-1000"`. Approval already stands between a junk row and any consequence, so this is defensive validation, not a fix for an observed loss. | P4 | ⏳ **Proposed — fix.** ⚠️ **Improves on one operator fact I cannot source: is there a minimum loan amount?** A floor of 1 catches only zero and negatives, which have never occurred; a stated fund minimum replaces the 1 and makes the row worth more. Status **400** matches D4; `create_loan`'s house style is 406 (`docs/phase-4-deviations.md` §2.2) — harmonise both rows together or neither. |
```

---

## 6. Routing

- **`nestjs-developer`** — **D30** is the only code change: one bounds check in
  `LoanService.createLoan`, after `toDjangoInt`, before the quota comparison, plus its e2e cells
  (`0`, `-1`, `1`, `"-1000"`, `0.5`). **D29 is a no-op** — v2 already behaves as decided; it needs
  a register row and a comment at `src/loans/loan.service.ts:195` recording that the coercion is
  deliberate, so nobody "fixes" it back.
- **`manual-tester`** — two cells that were never run and should be, both on the quota boundary:
  `value: 30000000.5` and `value: 30000000.5` under refinance; plus D30's five.
- **`nestjs-reviewer`** — the compare-then-coerce vs coerce-then-compare ordering
  (`createLoan` against `updateUserFinance`'s `pythonNotEqual`) is a v2-internal consistency
  question, not a parity one. §3.2 above.
- **Documentation defect, unrelated to this decision:** `docs/phase-4-deviations.md` §2.1 and §5.2
  both state that *"a precedence note now sits at the head of `MIGRATION_PLAN.md` §5"*. It does
  not — §5 opens with "Why this section exists" and "Each row needs a user decision", neither of
  which says §5 overrides §3. The trap those sections describe is real and the note should be
  written, since §3 and §5 disagree by construction in every remaining phase.
