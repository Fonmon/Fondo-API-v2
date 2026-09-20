# BA note: Phase 8b, birthday notifications (D48, D39, D49; C71)

Branch `feat/phase-8b-birthdays`, commit `5e3457a`. Checked against `MIGRATION_PLAN.md` §5 D39/D48/D49,
§9 Q47–Q49, runbook 3a/3a-bis, `docs/phase-8b-deviations.md`, v1 source, and read-only `fondodev`
(2026-09-14, `BEGIN READ ONLY`). No tests were run.

## Verdict: Concerns

The code matches all three operator decisions. I found no mismatch between the code and Q47–Q49.
The concern is in the **runbook, not the code**. Steps 3a (drain 1497 by id) and 3a-bis (mark 2142
processed) were written under Q35 to *end* the chains. Q48 now says a returning member resumes. As
written, the runbook would permanently end the two chains that Q48 exists to keep. That needs the
operator (Q-8b-4 below). Task 2142's v1 deadline is still **14 November 2026**.

## 1. The registered choices, checked

| # | Choice | Matches decision / fund behaviour? |
|---|---|---|
| 1 | D48 "still to run" = strictly before 14:00:00.000 Bogotá; D19 clamp on the chosen year (`src/users/birthday-run-date.ts:73-82`) | **Yes.** This is Q47's wording: "today, once the 14:00 pass has run, goes to next year". The date and the hour come from one Bogotá read. The Ainhoa case (Q36) gives 2027-08-05. |
| 2 | Owner row missing: nothing sent, processed, cloned, `ok: false` (WARN); inactive: `ok: true` (`notification.executer.ts:78-89`) | **Yes.** Q48 says skip and keep rolling. The WARN for a missing owner is a reasonable extra. Measured: 0 missing, 2 inactive (1497 owner 3, 2142 owner 15). |
| 3 | Stored `user_ids` still parsed but no longer picks the audience (`:70-72`, `:92`) | **Yes.** Q49 is about who receives, and this keeps v1's failure behaviour for broken rows. |
| 4 | `user_ids` still written, same bytes as v1 | **Yes.** The plan left this to the implementer. It is the safe choice for a rollback: v1 would greet with its old, frozen list, which is v1's behaviour anyway. |
| 5 | `owner_id` parsing: absent/NULL/non-digits throw; too big for int4 counts as missing (`:126-133`) | **Yes.** 0 of 86 rows reach these branches. See Q-8b-2. |
| 6 | Birthday only when `type === 'birthdate'` exactly | **Yes.** Measured: 626 tasks, types are only `birthdate` and `payment_reminder`, with 0 NULLs and 0 case or space variants. |

Payment reminders are unchanged: stored list, no activity filter, no owner check. They still go to
the borrower alone. That is correct for the fund.

## 2. Who "active members" means (D49)

- **v1** `get_users_attr("id")` is `UserProfile.objects.filter(is_active=True)`, with **no role
  filter** (`Fondo-API/fondo_api/services/user.py:147-155`, called at `:271`).
- **v2** `findActiveMemberIds(client)` without `roles` gives `userProfile` where
  `auth_user.is_active = true` (`src/users/active-members.query.ts:33-45`). The birthday caller
  passes no roles (`member-directory.ts:54`). **No role filter was added or dropped.** The query is
  the same one used to write the stored list, so the two cannot drift apart.
- **fondodev:** 15 users. ADMIN (1), PRESIDENT (9), TREASURER (2), 10 MEMBERs, 13 active, and every
  active user has a profile. Recipients are everyone in all four roles except the birthday person.
  **Nobody who should be greeted falls outside the query.** User 1 (ADMIN) is a real member with a
  birthdate and a chain, and still receives greetings, as in v1.
- **Business-visible gains (Q49 working as intended):** Ainhoa (user 14) now receives every
  greeting. Fernando (user 3, departed, 2 push subscriptions) and Angi Paola (user 15, departed,
  1 subscription) stop receiving them.
- **Nuance for the operator's awareness, not a blocker:** `is_active = false` also means "invited,
  not yet activated" (v1 `services/user.py:36`, v2 `user.service.ts:229-230`). Such a person gets no
  greetings (they have no subscriptions anyway). If their own birthday falls before they activate,
  D39 treats them as departed: that year is skipped and the next one resumes. Measured: 0 such
  users today (every `key_activation` is empty). I recommend accepting this.

## 3. Answers to the developer's questions

**Q-8b-1: a save that commits after the 14:00 pass has read the table. Recommendation: accept it,
no margin. No operator decision needed; tell the operator when folding it into D48's residuals.**
It needs a birthday-day profile save that is in flight at the exact second of 14:00:00. The result
is one greeting a day late, and the chain lands on the right date after that. A margin would be
worse. Every save between, say, 13:55 and 14:00 would move to next year even though the 14:00 pass
had not run, so the member **misses** this year's greeting. That swaps a millisecond window for a
five-minute one with a worse outcome. Record it next to the outage residual.

**Q-8b-2: a malformed or missing `owner_id` throws. Recommendation: keep the loud failure. No
operator decision needed.** One correction to the framing: the throw does not *end* the chain. The
row stays unprocessed and is retried and logged at every pass (runner releases the claim,
`scheduler.runner.ts:220-245`). The chain is stalled and visible twice a day. Skip-and-clone would
keep a greeting alive for a person nobody can identify, and nobody would notice. 0 of 86 rows reach
this branch. **Runbook note:** whoever repairs such a row must also set `run_date` to the next
anniversary (D48's rule). Otherwise D7's `<=` sends a wrong-day "hoy" on the next pass.

**Q-8b-3: owner with no `auth_user` row, WARN every year. Recommendation: the WARN is the right
amount of noise, and 3a-bis should also sweep for such chains. No operator decision needed
(0 rows).** v2 has no hard delete, so such a chain can only come from a hand edit. There is no
member to resume for, so these rows can be deleted at cutover. The current sweep in 3a-bis uses an
inner `JOIN auth_user`, so it **cannot see** these rows. Add a `LEFT JOIN … WHERE u.id IS NULL`
variant. Also note that the sweep's `(payload->'owner_id')::int` would abort on the malformed rows
from Q-8b-2 (0 today). Filter with `~ '^[0-9]+$'` first.

**Q-8b-4: tasks 1497 and 2142 under D39. Recommendation: keep both chains and move them to their
next future birthday instead of ending them. Needs the operator**, because it reverses the written
Q35 steps (3a "drain 1497 by id", 3a-bis "marking it processed … ends the chain … that is the
decision").

- **Why the runbook as written now conflicts with Q48:** marking either row processed writes no
  clone, so Fernando and Angi Paola could never resume. Q48 says they should.
- **2142 (Angi Paola, 2026-11-14): proposed replacement for 3a-bis.** Run it **on v1's production
  database before 14 November 2026, whatever the cutover date:**
  `UPDATE fondo_api_schedulertask SET run_date = '2027-11-14 05:00:00+00' WHERE id = 2142 AND processed = false;`
  v1 selects the exact day only (`scheduler/tasks.py:16-18`), so it will not fire on 2026-11-14. v2
  skips it at send time while she is inactive, and greets her again if she is reactivated. If
  cutover slips past 14 November 2027, repeat this.
- **1497 (Fernando, 2024-03-02): proposed replacement for 3a's "drain by id".**
  `UPDATE … SET run_date = '2027-03-02 05:00:00+00' WHERE id = 1497 AND processed = false;`
  This is my Phase 7b §2.3 roll-forward. Leaving 1497 past-dated is harmless **only while he stays
  inactive**: v2 would skip-and-clone three times in a row (2024, 2025 and 2026 are all due), which
  is only log noise. If he were reactivated before cutover, the catch-up would become **three
  fund-wide wrong-day "hoy" pushes**. Rolling it forward removes that risk and keeps his chain.
- **3a's post-drain check:** `chains_left_alive` should still be 0, because both rows become
  future-dated and fall outside the drain predicate. Re-run the owner sweep (3a-bis) on production,
  not `fondodev`, and apply the same roll-forward to any other inactive owner whose chain is
  past-dated.
- **Also confirm with the operator:** v2 has no API path to reactivate anyone. `activate_user`
  needs a `key_activation`, which is NULL for both (`user.service.ts:548-551`). So "resumes
  automatically" means "after a direct database flip of `is_active`". If the fund would instead
  re-invite a returning member as a new user (new id), the old chain keeps skipping forever with
  one log line a year and the new id gets its own chain. Nobody is greeted twice, but in that case
  keeping the old chains buys nothing, and deleting them is equally valid.

## 4. Scenarios the tests don't cover that matter to members

1. **Double greeting on a birthday-day profile save between the two passes. Same as v1, not a
   regression.** The 10:00 pass greets and clones next year. A PATCH carrying `birthdate` at, say,
   11:00 deletes **all** of the owner's birthday rows, processed ones included
   (`scheduler-task.repository.ts:292-296`), and D48 writes today again because the 14:00 pass is
   still to run. **The whole fund receives "Hoy está cumpliendo años X" twice.** v1 does the same
   (`replace(year=today_year)` + exact-day selection). Low likelihood. Recommend recording it as a
   residual next to D48, not fixing it in this phase. The operator may want to know.
2. **D49 changes who receives birthday pushes on the first pass after cutover.** On `fondodev`, 11
   of 14 chains differ. Business-visible and intended (Q49). The manual-tester should confirm it on
   one chain.

## 5. Business-visible changes, called out explicitly

| Change | Who notices |
|---|---|
| D48: a birthdate saved after this year's birthday, or on the day at or after 14:00 Bogotá, schedules next year (v1: a date that never fires) | the member being edited; the fund now greets them next year |
| D39: an inactive member's birthday is not announced (v1: announced, e.g. task 1770) | whole fund |
| D49: greeting recipients are the active members at send time (v1: list frozen at creation) | new members start receiving, departed members stop |
| Recipient role filter | **none added or removed**: all four roles, as in v1 |
| Rounding, rates, day count, permissions, email recipients | untouched by this phase |

Alexa: not involved.

## 6. Blocking questions for the operator

- **B-8b-1 (Q-8b-4):** replace runbook 3a's "drain 1497 by id" and 3a-bis's "mark 2142 processed"
  with the two roll-forward `UPDATE`s above, so that both chains survive under Q48? The 2142 update
  must run on v1 production **before 14 November 2026**.
- **B-8b-2:** does a returning member come back by reactivating their old account (a database
  flip), or as a new invitation? This decides whether keeping the old chains has any value.

Informational, no decision needed: Q-8b-1 (accept, no margin), Q-8b-2 (loud failure), Q-8b-3 (WARN
plus sweep), the invited-not-activated nuance (§2), and the double greeting between passes (§4.1).
