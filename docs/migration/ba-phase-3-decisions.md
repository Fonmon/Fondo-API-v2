# Phase 3 — business decisions on `PATCH /api/user/<id>`

Companion to `MIGRATION_PLAN.md` §5 (D1) and `docs/phase-1-deviations.md` §2.4–2.5.
Scope: the three questions Phase 1 raised and deliberately did not answer. Does **not**
reopen the D1 rule table — that is settled and treated here as given.

**Verdict: Concerns** — all three questions are answerable, but verifying them against the
live `fondodev` data turned up three *new* items that must be decided before Phase 3 closes
(§4). One of them (§4.1) would break every member profile save if implemented the obvious way.

---

## 0. Two facts that change the framing — read before the answers

**0.1 The client posts `personal` *and* `finance` in the same body; `type` selects which one
is applied.** Every fixture in `fondo_api/tests/test_user_views.py` (lines 49–113) is shaped
`{"type": "personal", "personal": {…}, "finance": {…}}`, and `update_user`
(`~/Projects/Fondo-API/fondo_api/services/user.py:100`) dispatches on `obj['type']` alone,
ignoring the other sections. So D1's "a `finance` write by a non-privileged caller is 403"
must be evaluated against **`body.type`**, never against "the body contains a `finance` key".
Get this backwards and *every member editing their own name gets a 403*, because their client
always ships the `finance` block too. This is the same present-vs-changed trap as question 1,
one level up, and nobody has registered it yet.

**0.2 The two mismatched-username users share their email with another member.**

```
 id | username           | email                  | birthdate
  7 | criss9413@hotmail.com   | criss9413@hotmail.com   | 1994-05-13
 14 | ainhoa.montanez         | criss9413@hotmail.com   | 2020-08-05
 10 | mhjc123@hotmail.com     | mhjc123@hotmail.com     | 1976-07-25
 13 | sebastian.montanez      | mhjc123@hotmail.com     | 2011-10-07
```

Users 13 and 14 are **children** (born 2011 and 2020) enrolled under a parent's email
address. They are not accounts with a stale username — they are custodial accounts that never
had an email of their own. That is a fund fact, not a data defect, and it reframes question 3
entirely (see §3).

---

## 1. The `role` check — "field present" or "field changed"?

### **Recommended (decidable) — use the `changedFields` reading.**

403 only when the submitted value differs from the stored value, for `role` and for every
other privileged field in `personal`. Comparison must be **type-normalised** (`"2"` vs `2`),
or JSON-string roles will produce phantom 403s.

**Why, in fund terms.** No, there is no scenario where merely *submitting* an unchanged `role`
should be refused. The `role` key in the body is not a member's intent — it is an echo. The
web app reads `GET /api/user/<id>`, whose `UserFullInfoSerializer` returns `user.role`
(`serializers.py:8–18`), and posts it straight back. The human clicked "save my phone number".
Refusing that is refusing a save the fund wants to happen.

**On audit and traceability — the "changed" reading is the *better* audit signal, not the
weaker one.** Under the "present" reading a 403 would fire on every ordinary profile save by
all 14 non-admin members: 100% false positives, so the signal is worthless and would be
switched off within a week. Under the "changed" reading a 403 means someone actually tried to
alter a role — a rare, high-signal event worth logging with actor, target and attempted value.
If the fund wants the escalation attempt on record, that record only exists under the reading
we are recommending.

**It also stays consistent with a rule the operator already set.** D1 says a `finance` write by
a non-privileged caller is 403, *not* a silent no-op. "Compare, then 403 on a real change" is
the same principle applied field-wise; "silently drop `role` for non-admins" is the no-op
option D1 already rejected.

**Known side effect, and it is the right one.** Stale-client case: a member opens their
profile, the ADMIN promotes them to TREASURER in an assembly, the member then saves their name
with `role: 3` still in the payload. That *is* a change, so they get a 403 and must reload.
Mildly confusing, and it happens roughly as often as the fund changes roles (once a year at
most). The alternative is worse: a silent lost update that quietly demotes a freshly elected
treasurer back to MEMBER. Keep the 403; give it a message that says the profile is out of date.

**Risk of the alternative ("present" reading).** Every member is locked out of self-service
profile editing on day one of cutover — the exact regression D1 was written to avoid — and the
fund's first experience of v2 is "the new system won't let me change my email".

---

## 2. `PATCH /api/user/-1` — should `-1` mean "me"?

### **Recommended (decidable), split by verb.**

| Verb | Decision |
|---|---|
| `GET` | Keep `-1` = me. Unchanged from v1. |
| `PATCH` | **Adopt** `-1` = me. Register as a deviation (v1 404 → v2 200). |
| `DELETE` | **Reject the sentinel.** `-1` must never resolve to the caller. |

**PATCH — why adopting it is safe.** `PATCH /api/user/-1` 404s in v1 *unconditionally*, for
every caller, always. Therefore no working client path uses it: if the profile screen saved
with `-1`, profile editing would be broken for all 15 members and the fund would have noticed
years ago. The screen must already save with the real id it read from the GET. So the change
is inert against today's client, and it removes a genuinely misleading answer — v1 tells a
logged-in member "not found" about themselves. D1 makes self-service the *dominant* case for
this endpoint, so GET and PATCH disagreeing on how to say "me" is a trap for whoever writes
the next front end. Verification, non-blocking: confirm no client code sends `-1` on PATCH.

**DELETE — why the sentinel must be refused.** `DELETE` is a soft delete (`is_active = false`)
restricted to ADMIN, and `fondodev` has **exactly one ADMIN** (user 1). "Me" semantics there
means a single mis-clicked request deactivates the only administrator. There is no recovery
path through the API: nothing sets `is_active` back to true except `activate_user`, which
requires a `key_activation` that is already null for every live user. The fund would need
direct database access to get its admin back. That is not a risk worth taking for a
convenience nobody asked for. `PATCH` is reversible; `DELETE` here is not.

**Risk of the alternative.** Preserving v1's asymmetry costs nothing today but leaves a 404
that means the opposite of what it says. Extending "me" to `DELETE` risks an unrecoverable
lockout of the fund's only administrator.

---

## 3. Editing a member's email rewrites their login name

### **Recommended (decidable) — option (b): v2 stops writing `username` on personal updates.**
`create_user` keeps setting `username = email` at creation. Updates leave `username` alone.
Plus a **runbook item** and **one operator confirmation** (§5, Q-C).

**First, the live behaviour is worse than "silently changes their login name" — and also
narrower.** Because `auth_user.username` carries a UNIQUE constraint
(`auth_user_username_key`) and Ainhoa's email is already Cristina's username, `user.username =
obj['email']` raises an `IntegrityError`, which `__update_user_personal` catches and turns into
a **409 Conflict** (`services/user.py:239–240`). So today:

- **Any personal edit to Sebastián (13) or Ainhoa (14) fails with a bare 409** as long as their
  email stays as it is. Nobody can fix a surname, set a birthdate, correct an identification or
  change their role through the API. The admin sees an unexplained "conflict" and has no way to
  tell it apart from a real duplicate-identification clash. **This is a live operational
  hazard: two of fifteen members have profiles the fund cannot maintain.**
- **The silent login-name rotation happens on the other branch:** give either child a fresh,
  unique email and the write succeeds, and their login name changes from `sebastian.montanez`
  to that email with no notification of any kind. v1 has no "your login name changed" email.
- Under D1's new universal self-service the same trap becomes reachable by *any* member: change
  your email to one already used as another member's username and you get an opaque 409.

**Why (b) and not (a).** `username` is not a member-facing concept in this fund. It is not
returned by any GET (`UserProfileSerializer` exposes `full_name, identification, email,
role_display, id, first_name, last_name, role, birthdate` — no `username`), so no client can
read it, show it or send it. v1 *derives a credential from a contact field* and does so
silently. For 13 of 15 members that derivation is a no-op; for the 2 custodial accounts it is
either a hard block or a silent credential rotation. There is no fund process that requires the
two to stay in lockstep after creation: password reset resolves by `email`, login resolves by
`username`, and the only other consumer of `username`, the Alexa account-linking view
(`views/auth.py:71`), is being deleted (§6).

**Cost of (b), stated plainly.** A member who changes their email will still log in with the
old one. In a fund where email changes are rare and members mostly reach the app from a saved
session, that is a smaller surprise than a login name changing under them — but it is a
surprise, and it is the one thing here that depends on what your login form says. See §5 Q-C.

**Runbook, before cutover (not instead of the code decision).** v1 is frozen, so it keeps
attempting `username = email` until the switch. Two things to do:

1. **Do not edit Sebastián's or Ainhoa's profile in v1 between now and cutover.** Any personal
   PATCH on them 409s; any personal PATCH that also changes their email silently rotates their
   login name.
2. **Reconcile or confirm the two rows before cutover.** Either give each child their own email
   address (which makes them ordinary rows and closes the issue permanently), or decide the
   custodial arrangement stands and record `sebastian.montanez` / `ainhoa.montanez` as
   deliberate, permanent login names in the migration notes. Telling the two members is not
   sufficient on its own — Ainhoa is five years old; whoever actually operates those accounts
   is the person to tell.

**Risk of the alternative (a, preserve v1 exactly).** v2 ships a known defect that blocks
profile maintenance for two members, can rotate a credential with no notification, and — new in
v2 — is now reachable by any member editing their own email, not just by the ADMIN.

---

## 4. Three new items that need a decision before Phase 3 closes

### 4.1 Authorisation must key off `body.type`, not on which sections are present — **Recommended (decidable)**
See §0.1. Evaluate D1 against the single section named by `type`; ignore any other section in
the body entirely, exactly as `update_user` does. Register it as an explicit rule so the
implementation cannot drift into presence-checking. Without this, every member profile save
403s at cutover.

### 4.2 `identification` is a privileged field too — **Needs operator input**
D1 restricts `role`, but `__update_user_personal` also writes `identification`, and under D1 a
MEMBER may now write their own `personal`. `identification` is the **join key of the
treasurer's monthly TSV** — `__update_user_finance` looks up `user__identification`, and a miss
is only *logged* and skipped (`services/user.py:142–145`). A member who edits their own cédula
therefore silently freezes their contributions, quota and available quota at the last upload,
with no error visible to the treasurer and no notification to anyone. This is money-visible.

**My recommendation: `identification` is ADMIN-only, using the same "changed" test as `role`.**
It needs your confirmation because it adds a restriction beyond what Q15/Q25a stated. If you
want the TREASURER to be able to fix a cédula typo, say so and the cell becomes `[0, 2]`.

### 4.3 Password reset is silently dead for four members — **Needs operator input on the remedy**
`get_user_by_email` does `User.objects.get(email=data)` (`services/user.py:86`) inside a bare
`except: return None`. With two duplicated emails that raises `MultipleObjectsReturned`, so
**users 7, 10, 13 and 14 receive no reset email**, and `PasswordResetView` redirects
unconditionally to `/password_reset/done/` — they are told it worked. Four of fifteen members
cannot recover a forgotten password today, and none of them can find out why.

Phase 3 owns password reset, so v2 must decide rather than inherit this. My recommendation:
send a reset link for **each** active user matching the email (which is what Django's own
`PasswordResetForm.save()` does — v1 bypassed it), with the account named in the Spanish
template so the parent knows which child's account the link is for. That template wording is
yours. If §3's runbook gives the children their own emails, this defect disappears for the
current data but the code path still needs a decision.

---

## 5. Questions only you can answer

- **Q-A (§4.2):** May a member change their own `identification` (cédula), or is that
  ADMIN-only? *Recommended: ADMIN-only.*
- **Q-B (§4.3):** When two members share an email, should a password reset send one link per
  account, and how should the Spanish template name which account it is for?
- **Q-C (§3):** After a member changes their email in v2, what should they type at the login
  screen — the new email or the name they have always used? If the answer is "the new email",
  option (b) is wrong for you and we need a third option (keep the sync, but block it when
  `username != email`, and return a legible 409 instead of a bare one). Everything else in §3
  stands either way.
- **Q-D (optional, new functionality):** v1 sends **no** notification when a profile changes.
  An ADMIN can change any member's email, which today also changes how they log in. Do you want
  an email to the *old* address when an email is changed? Recommend deferring past cutover —
  it is new behaviour, not a port.

---

## 6. Alexa

`fondo_api/services/alexa/intents/request_loan_intent.py` calls `LoanService.create_loan`, so
the `RequestLoan` intent is a genuine member-facing route to **create a loan request by voice**.
Removing Alexa removes it: after cutover a member can only request a loan through the web app.
The account-linking endpoint `/api/authorize` (`views/auth.py:AuthView`) goes with it, which is
why `username` loses its second consumer in §3. Please confirm explicitly that losing the voice
loan-request path is acceptable — this note assumes it is.
