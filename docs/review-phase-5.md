# Phase 5 (Activities) — code + parity review

| | |
|---|---|
| **Branch / head** | `feat/phase-5-activities` @ **`d89f801`** (`git rev-parse` confirmed) |
| **Scope** | `git diff 07caff4..d89f801 -- src test` — 38 files, 6 162 insertions. Plus the three parity rounds, `docs/phase-5-deviations.md`, `docs/phase-5-prework.md`, `docs/ba-phase-5-activity-exposure.md`, `MIGRATION_PLAN.md` §3/§4/§5 (D35–D38)/§7. |
| **Gate, re-measured by me at `d89f801`, asserted by exit code** | `npm run lint` → **PASS** · `tsc --noEmit` → **PASS** · unit **2047 passed / 63 suites** · e2e **1031 passed + 1 skipped / 18 suites**. Identical to the coordinator's numbers at `28ad282`; the four commits since are documentation only. |
| **Verdict** | **Approved with conditions (C59 – C67)** |

The port itself is the strongest of the five phases so far. Three routes, six handlers, and every
v1 shape that looks like a bug — the bodiless `304` from a `POST`, the `204` on an empty year
list, the `200` from a `DELETE` that deleted nothing, `patch_activity`'s bare `except:` turning
six distinct failures into one 404, the unvalidated `state` — is carried deliberately with the
source quoted at the call site. The two hazards the plan flagged (the `ActivityUser` cascade that
v1's own `test_delete_activity` cannot see; the "highest **other** year" disable) are both
implemented correctly and both pinned by cells that discriminate. I found no parity defect in
Phase 5's own code.

Everything below is either cross-cutting code the phase touched, a residual list that is narrower
than the behaviour it describes, or process.

---

## 1. What I verified independently

Not read from the reports.

| claim | how I checked it | result |
|---|---|---|
| gate numbers | ran all four with `cmd && echo PASS \|\| echo FAIL` | ✅ exact match |
| `gunicorn.http.message.Request.parse_request_line` is what `gunicorn-request-line.ts` says | `docker exec fondo-v1-p4 python -c 'inspect.getsource(...)'` | ✅ — and it exposed an omission, §3.2 |
| `//api/…` (the abs_path workaround I suspected was unported) | raw socket, both stacks | **404/404 — no divergence.** `split_request_uri`'s dot-prefix trick *preserves* both slashes in 19.9.0. My hypothesis was wrong; recorded because a plausible finding that measures clean is worth as much as one that does not. |
| absolute-form target | raw socket, both stacks | v1 **401**, v2 **404** — O4, as reported |
| a target `urlsplit` rejects | raw socket, both stacks | v1 **400**, v2 **404 via Express's finalhandler** — **not in O1–O6**, §3.2 |
| `\` in the request target | raw socket, both stacks | v1 **404**, v2 **400** — **not in O1–O6**, §3.2 |
| the recovery survives a keep-alive connection that already served a request | raw socket: `GET` then `FROB` on one socket | ✅ 401 then 401, no `ERR_HTTP_SOCKET_ASSIGNED`, no crash |
| the recovery survives TCP segmentation | raw socket: `FROB` in three writes | ✅ 401, exactly one response |
| `toDjangoText` vs Django, on floats the fixture does not sample | `TextField().get_prep_value(json.loads(x))` in the container vs `toDjangoText(JSON.parse(x))` under ts-node | ❌ **four divergences**, §3.1 |
| CPython `int()` vs `str.strip()` vs JS `trim()` whitespace sets | 22 code points, all three | ❌ **two divergences**, §4.1 |
| the guard fails closed when the resolver is bypassed | read `roles.guard.ts:133-143` | ✅ no `djangoRoute` ⇒ deny, never fall back to the declaration |
| the `@All()` collapse cannot widen a concrete route | read Express 5's `Route#_handlesMethod` / `#dispatch`; `grep '@All('` — 15 routes, none `'*'` | ✅ |

---

## 2. Judged hardest, as briefed

### 2.1 N1 — the model is right, the recovery is sound, and one thing is still missing

**The model.** "gunicorn has no method table" is correct and I confirmed it from the running
container, not from the report. `parse_request_line` is `split(None, 2)` → `METH_RE.match` →
`VERSION_RE.match`, and `METH_RE` is applied with `re.match`, so `{3,20}` genuinely sets no upper
bound. `[A-Z0-9$-_.]`'s `$-_` really is the U+0024–U+005F range. The port at
`gunicorn-request-line.ts:55-134` is line-for-line, `splitOnWhitespace` included, and the tester's
73-cell boundary probe (delta-3 §3.2) exercises the lower bound at 2/3 characters, the absent upper
bound at 200, the 16 in-range punctuation characters, the four out-of-range ones, and the
case-sensitivity of both regexes. That is the right shape of evidence.

**The recovery.** `recoverInvalidMethod` (`gunicorn-http-edge.ts:148-208`) is correct in the two
ways that matter. It re-reads from the socket rather than trusting `err.rawPacket`, which is what
makes a segmented request work — I measured it, three writes, one 401. And `finish()` is a single
settle point guarding the timeout, the close and the terminator path against each other, so
neither the `headersTimeout` nor a mid-recovery `close` can double-reply.

**The `WeakSet` double-reply guard is correct.** `owned` is keyed on the `Socket`, added *before*
any asynchronous work, and checked at the top of both listeners. llhttp re-raises
`HPE_INVALID_METHOD` on every subsequent chunk of a socket it has already failed on, and the same
chunk also reaches the `data` listener — so without the set a segmented request answers twice.
Two properties I checked beyond the report: it does not leak across servers (it keys on socket
identity, and every e2e suite builds its own), and it does not break a socket that already served
a normal request (measured: `GET` then `FROB`, both 401, no `ERR_HTTP_SOCKET_ASSIGNED` from
`assignSocket`, because Node's own `resOnFinish` has already cleared `socket._httpMessage`).

**Keeping Node's 400/431 for the other codes holds, and the reasoning is the right one.**
Registering a `clientError` listener silences Node's default for *every* code, so anything not
reproduced becomes a dropped connection — the defect N1 exists to remove, relocated. The two
buffers at `:58-65` are byte-identical to Node's `badRequestResponse` /
`requestHeaderFieldsTooLargeResponse`, and `writeNodeDefaultClientError` reproduces the
`writable && bytesWritten === 0` branch and the `destroy(e)` fallback. It is not v1's answer —
gunicorn writes an HTML page for a bad header token too — but it is *a* answer, which is the
improvement, and the gap is declared in the docblock.

**`restoreCatchAllRoutes` is safe.** Two independent gates before it touches anything: ≥ 2 layers
all sharing one `handle` reference, and all seven core verbs present. A `@Get()`/`@Post()` pair on
one path cannot trip it — Nest calls `app.get`/`app.post` separately and Express's
`Router#route()` mints a **new** `Route` per call, so those are two one-layer routes, not one
two-layer route. The `Object.defineProperty(…, {enumerable: false})` on `_all` is the detail I
would have expected to be missed and is not: `Route#_methods()` is `Object.keys`, and an
enumerable `_all` would have injected a method called `ALL` into Express's automatic `OPTIONS`
`Allow`. Truncating the stack to one method-agnostic layer is exactly what `route.all(fn)`
produces, and since all 35 layers were proven to hold the same handler it cannot change what any
known verb does. Idempotent by construction (a collapsed route has one layer and fails the ≥ 2
gate). `grep '@All('` finds 15 routes and none is `'*'`, so nothing broad is widened.
Three residual notes at **C65**.

**What is still missing** is not in the request line — it is the two lines under it. See §3.2.

### 2.2 `python-str.ts` and `pythonStrip` — the fixture is right, the declared limits are not

`pythonStrip` (`python-str.ts:181-187`) is **correct**, and I checked the character set rather
than the docblock: I enumerated 22 code points against CPython's `str.strip()` and JS's `trim()`
in both runtimes. `PYTHON_SPACE` is exactly CPython's `isspace()` set, and the docblock's
two-direction table (U+001C–U+001F and U+0085 stripped by CPython and not by `trim()`; U+FEFF the
reverse) is accurate in both directions. Using a module-level `g`-flagged regex with `.replace`
is safe (`Symbol.replace` resets `lastIndex`); `NON_PRINTABLE` has no `g` flag, so its `.test()`
is safe too.

The fixture's *shape* is right — generated in the pinned container from
`TextField().get_prep_value(json.loads(body))`, 41 rows, `/* eslint-disable */ GENERATED` header,
and it is genuinely consumed (`python-obj.spec.ts:17`).

**The declared limits are not the complete residual set.** Measured differentially — container
vs `ts-node` — this review:

| body | v1 stores | v2 stores | covered by a declared limit? |
|---|---|---|---|
| `0.00001` | `1e-05` | `0.00001` | ❌ **no** |
| `1.5e-5` | `1.5e-05` | `0.000015` | ❌ **no** |
| `1e16` | `1e+16` | `10000000000000000` | limit 1's *cause*, but not its stated scope |
| `-0.0` | `-0.0` | `0` | same |
| `1e21` | `1e+21` | `1e+21` | ✅ agree — limit 2 is stated correctly |

Limit 1 (`python-str.ts:35-37`) closes with **"Only integral-valued floats are affected."** That
sentence is false: `0.00001` and `1.5e-5` are not integral and diverge. The cause is a threshold
mismatch neither limit names — CPython's `float_repr` switches to exponential when
`decpt <= -4 || decpt > 16`, JavaScript's `Number::toString` when the exponent is `< -6` or
`>= 21`. Two whole bands diverge, one at each end, and the fixture cannot see either: it samples
one non-integral float (`5.5`) and nothing near a threshold.

This matters more than the inputs suggest. D35's entire argument is that `toDjangoText` is now the
faithful storage renderer and `describeTypeForErrorMessage` is not; a residual list that
under-states its own gaps is the artefact a future maintainer will trust instead of re-measuring.
And it is **closable**, not merely declarable: `reprNumber` (`:109-120`) already special-cases the
exponent width, and the same function can carry CPython's threshold rule in about eight lines,
after which three of the four rows above match and only the genuine `int`/`float` ambiguity
(`5` vs `5.0`) remains. **C60.**

### 2.3 D35's per-call-site work — the right call, with one mechanism missing

**Reproducing the `NOT NULL` constraint in application code is correct here**, and I would have
argued for it independently. The alternative is hand-writing a raw-SQL `INSERT` on
`POST /api/user` *known to fail*, on a live path, so that PostgreSQL can refuse it — a deliberate
failing write for the sake of an error class. Prisma validating required fields client-side is a
property of the chosen ORM (the §2 Phase-0 decision), so the constraint has to be re-stated
somewhere, and the call site is the only place that can pick the right status.

The per-call-site discipline is the part that earns it. The four v1 sites give four different
answers and the port gets all four right, measured on both stacks (delta round 2 §3.3):
`create_user` **409**; `__update_user_personal` **409**; `__update_user_preferences`'s bare
`except` **404**; `create_activity` **500**. The `email` asymmetry the brief singles out —
**500 on create, 409 on update** — is real, is explained at both sites
(`user.service.ts:169-195` and `:678-686`), and is confirmed on v1: create routes the value
through `_create_user`'s `if not username` (a `ValueError`, which `except IntegrityError` does not
catch), update assigns it to the column. The **ordering** cell is what convinces me this was
implemented rather than pattern-matched: `PATCH /api/user/9999` with `first_name: null` is a
**404**, not the new 409, on both stacks — the guard was not hoisted above `DoesNotExist`.

**The note is not sufficient on its own.** `user.service.ts:204` says "⚠️ If
`auth_user.first_name`/`last_name` ever become nullable, this must go with them." A comment is
the weakest possible binding to a fact that lives in `schema.prisma`. Relax the column to
`String?` and this code still compiles — `string` is assignable to `string | null` — and still
answers 409 for a value the database would now accept: a silent divergence in the direction
nothing tests. A type-level assertion in the spec (`Prisma.AuthUserCreateInput['first_name']`
must not admit `null`) makes that day a **compile error** instead. Same for
`user-preference`'s two colour columns, which use `as string` and would silently start passing
the null through. **C64.**

### 2.4 What the three rounds did not reach

`docs/parity-phase-5-delta-3.md` is the best parity report this project has produced — negative
controls against a `d7b95f8` build for every claimed fix, positive controls chosen so a lazy fix
fails them, status distributions instead of pass counts, and six of its *own* probe defects
recorded rather than quietly repaired. Its two hand-offs to me (O1's shape, one register row for
O2–O5) are both right, and both are narrower than the behaviour. See §3.2.

Beyond that, the gap I would name is a **business** one, not an HTTP one: §5.

---

## 3. Findings — major

### 3.1 The `python-str.ts` residual list is incomplete, and two of the gaps are not integral floats

**Where:** `src/common/utils/python-str.ts:28-43` (the "Known limits" block) and `:109-120`
(`reprNumber`); `src/common/utils/python-str.fixture.ts` (41 rows, no float near a threshold).

**v1 behaviour it must match:** `TextField.get_prep_value(x)` is `str(x)`, and CPython's
`float.__repr__` uses exponential notation iff `decpt <= -4 || decpt > 16`.

**Why it matters:** measured above — four divergences, of which `0.00001` and `1.5e-5` are
outside every declared limit. The columns reached are `fondo_api_activity.name`,
`auth_user.first_name`/`last_name`, `fondo_api_userpreference.primary_color`/`secondary_color`
and the refinance `comments`. The stored bytes differ; nothing crashes. Low reachability, but the
*claim* ("three of them, all rooted in what `JSON.parse` throws away… None is reachable from the
fund's clients") is now known to be incomplete, and it is the claim D35 leans on.

**Fix:** port CPython's threshold into `reprNumber` — exponential iff the decimal exponent is
`<= -4` or `> 16`, keeping the existing two-digit exponent padding — and add the five rows above
to `gen-python-str-fixture.py` so the fixture can *detect* a regression rather than merely
illustrate the rule. Then re-state limit 1 as what actually remains: JSON cannot distinguish
`5` from `5.0`, so an integral float renders without its `.0`. **C60.**

### 3.2 The pre-existing edge family is wider than O2–O5, and O1's shape is not confined to authority-form targets

**Where:** `src/common/http/gunicorn-request-line.ts:127-133` (`uri: bits[1]`, "untouched");
`docs/parity-phase-5-delta-3.md` §4.2 rows O1 and O4.

**v1 behaviour:** `parse_request_line` does not stop at the three checks the port implements. Read
out of the running container, it also calls `split_request_uri(self.uri)` and turns its
`ValueError` into `InvalidRequestLine` — i.e. into the same 400 page. That call is where
absolute-form targets have their path extracted, which is O4's actual mechanism.

**Measured this review, raw socket, both stacks:**

| request line | v1 | v2 |
|---|---|---|
| `GET http://[/api/activity/year HTTP/1.1` | **400**, gunicorn's page, `Invalid Request Line 'Invalid HTTP request line: …'` | **404**, Express's `finalhandler`: `X-Powered-By: Express`, `Content-Security-Policy`, `Cannot GET resource`, **no `Vary`, no `X-Frame-Options`** |
| `FROB http://[/api/activity/year HTTP/1.1` | 400 | 404, same shape |
| `GET \api\activity\year HTTP/1.1` | 404 | **400**, empty body |
| `GET //api/activity/year HTTP/1.1` | 404 | 404 ✅ (my suspected divergence; measured clean) |

**Why it matters, in two parts.**

1. **O1's shape is not an authority-form/`CONNECT` curiosity.** The round-3 report frames it as
   such and asks for "two sentences". It fires on a plain **`GET`** with an absolute-form target
   that `urlsplit` rejects, and what it demonstrates is that a request can reach a response
   *without passing through `DjangoUrlResolverMiddleware` at all* — so plan §4 rule 14's "the
   resolver runs ahead of the guards and is fail-closed" has a bypass. I checked the security
   consequence and it is contained: `RolesGuard.v1ViewFor` (`roles.guard.ts:133-143`) denies when
   `request.djangoRoute` is absent, so a bypassed request cannot reach a guarded handler. But
   "fail-closed" and "never bypassed" are different properties and only the first is true.
2. **The register row must be written from the rule, not from the cells.** "O2–O5 deserve one row
   between them" is right in spirit; a row enumerating four probed cells will be falsified by the
   fifth. The rule is: *v2's request-target handling is llhttp's plus Express's, v1's is
   gunicorn's `split_request_uri` plus Django's; they differ on version echo, version range,
   absolute-form, targets without a leading `/`, targets `urlsplit` refuses, and `\`.* Write it
   that way and my two new cells are already inside it.

**Fix:** one §5 row covering the family, with the six measured shapes as evidence rather than as
the definition, and a sentence in `gunicorn-request-line.ts` recording that `split_request_uri`
is deliberately not ported and what that costs. **C61.**

### 3.3 Three in-source claims about the register and the fixture are stale — false-green #20's polarity, in the file read first

**Where:**

* `src/activities/activity.service.ts:59` — *"Phase 5 owns **no** rows in `MIGRATION_PLAN.md` §5 —
  the register's `Phase` column has no `P5` entry."* **D36** is `P5` and **D37** is `P3/P4/P5`.
  §3 of the plan already flags this sentence as stale *in the plan*; the copy in the source was
  not updated with it.
* `src/activities/activity-detail.controller.ts:57` — *"Phase 5 owns no §5 rows and the plan has
  none pre-declared for it. It is registered as a **finding** for `business-analyst` in
  `docs/phase-5-deviations.md` §3, not silently changed."* It is no longer a finding: it is
  **D36**, decided under operator **Q32**.
* `src/activities/activity.service.ts:247` — *"One row per active member: **15** on the current
  `fondodev` fixture."* Measured **13** (users 3 and 15 are `is_active = false`).
  `docs/phase-5-deviations.md` §4.2 row 9 was corrected after round 1 said so in as many words —
  *"a probe written to assert 15 would have failed on both stacks and looked like a v2 defect"* —
  and the source docblock was not corrected with it.

**Why it matters:** this is precisely false-green **#20** with the polarity that misleads —
documentation asserting a property of another artefact that the artefact no longer has. The
third one is worse than the other two because a maintainer writing the Phase 6 or Phase 8
equivalent of `addUsers` will copy the number, and 15 is the number that reads as obviously
right. **C62.**

---

## 4. Findings — minor

### 4.1 `pythonInt` and `toDjangoInt` use JS `trim()`, which is the mistake `pythonStrip` was written to fix

**Where:** `src/common/utils/python-obj.ts:454` (`pythonInt`) and `:157` (`toDjangoInt`).

**Measured, 22 code points, all three runtimes:**

| code point | CPython `int(ch + '5')` | JS `trim()` | consequence |
|---|---|---|---|
| **U+0085** (NEL) | **5** | keeps | v1 succeeds, **v2 raises** → `?page=%C2%855` is a valid page in v1 and a 500 in v2 |
| **U+FEFF** (BOM) | **ValueError** | strips | v1 500, **v2 succeeds** |
| U+001C–U+001F | ValueError | keeps | ✅ agree |
| everything else tested | ok | trims | ✅ agree |

Note `int()`'s set is not `strip()`'s either — U+001C–U+001F are stripped by `strip()` and
rejected by `int()` — so `pythonStrip` is *not* the right helper to reach for; this needs its own
two-line set.

**Why it matters:** less for the two exotic code points than for what it says. The tester's §7.1
asks *"was any other Django helper ported by its purpose rather than line by line?"* This is the
answer: yes, one was, in the same directory, and the phase that built the correct whitespace port
did not carry it across. Reachable from `?page=` on `GET /api/user` and `GET /api/loan` (both
unguarded `int()` calls) and from `value`/`identification`/`state` in a body. **C63.**

### 4.2 The D35 `NOT NULL` reproduction has no binding to the schema

Argued in §2.3. `user.service.ts:205` and `:685`, plus the two `as string` casts at `:948-949`.
**C64.**

### 4.3 Three residuals in the gunicorn edge that are true today because of the routing table, not because of the module

**Where:** `src/common/http/gunicorn-http-edge.ts`.

1. **Duplicate headers are joined with `, ` on the recovered path** (`:232-243`), where Node's
   normal path keeps the *first* value for singleton headers (`host`, `content-length`,
   `authorization`). gunicorn joins, so the recovered path is in fact the more faithful of the
   two — but v2 now has two code paths that disagree with each other about `Host`, and
   `DjangoAllowedHostsMiddleware` reads `req.headers.host`. Worth one sentence, not a change.
2. **The body is truncated at whatever arrived with the header block** (`:197-206`,
   `request.complete = true`). Unobservable *only* because every method outside `http.METHODS`
   lands on an `@All()` fallback carrying `@DrfNoRequestData()`. That is a property of the routing
   table, and the invariant should be named where it is relied on.
3. **`restoreCatchAllRoutes` recurses with no visited set** (`:311-321`). Unreachable in this
   tree; a mutually-mounted sub-router would hang at bootstrap.

**C65.**

---

## 5. The parity report — business scenarios, and the one that is missing

The matrix does exercise, with discriminating cells rather than agreement checks: every role rule
on all three routes including unauthenticated and the deny-on-miss `OPTIONS` 403; the year
rollover across a **gap** (the cell that falsifies three plausible mis-readings at once); the
same-year retry that answers 304 *after* writing; the `DELETE` cascade on an activity that
actually has children — the case v1's own suite cannot see; every `?patch=` dispatch shape
including the repeated-key `QueryDict` rule; the cross-activity `ActivityUser` write; the empty
year list's 204 with its absent `Content-Type`; the `value` coercion asymmetry on both halves;
out-of-range ids on all five handlers; and pagination out of range on the Phase 3/4 routes it
swept. The two-enabled-years anomaly is echoed and proven inert. D36 is verified by **identity**
(64 cells, byte-for-byte) rather than by absence, which is the right instinct for a row whose
decision is "change nothing".

**One business scenario is missing from the tests and from the code, and it is not a parity
failure.** `ActivityUser` rows are written by exactly one path — `__add_users`, inside
`create_activity` — and by nothing else. There is no route that attaches a member to an existing
activity. So **a member enrolled after an activity is created has no row on it, is absent from
its roster, and can never be marked as having paid it.** The only recovery through the API is
`DELETE` and re-create, which discards every payment state already recorded on that activity;
otherwise it is a direct database insert. v1 behaves identically, so no cell can fail — which is
exactly why no cell was written.

Live data makes this concrete rather than theoretical: `auth_user` has 15 rows and two are
`is_active = false`, so the active set has changed at least twice, and `fondo_api_activityuser`
holds 338 rows across 25 activities — not a constant 13 or 15 per activity. Whether that is the
fund's intent (activities are snapshots of the membership on the day) or an operational trap
(a member joining in March is invisible on the year's first bingo) is a **fund-policy** question
and I am not deciding it. **Escalated to `business-analyst`**, alongside the note that
`docs/ba-phase-5-activity-exposure.md` §2.2 already documents the *mirror* case — soft-deleted
members staying attached — and reached the opposite conclusion for it (accepted, D36 residual (a)).
No condition; no v2 code change is implied either way.

Two smaller gaps, both recorded rather than actioned: the C28 Bogotá year boundary is still
covered only at library level and by a clock-fixed unit cell, never over HTTP (no `faketime`;
unchanged across three rounds, honestly declared each time); and `PATCH ?patch=user` against a
**soft-deleted** member's row is untested, though it is inert (v1 has no `is_active` filter there
either).

**DELTA3-F1's gate question is moot** — it was fixed at `28ad282` and the fix is right: the strip
is conditional on `rsplit` succeeding, and `normalizeEmail` (`user.service.ts:1208-1231`) now
strips only when there is an `@`, with the no-`@` control cells that make an always-strip fix
fail. Had it still been open I would have taken it as a Phase 3 item and not a Phase 5 blocker.

---

## 6. Process — is the false-green class closing?

The brief asks the honest question, so: **the countermeasures are correct and they are not yet
sufficient, and the reason is structural rather than a lack of effort.**

**What is working.** Each of the three new countermeasures directly kills its instance, and I
confirmed the first one myself: I re-ran the whole gate with `cmd && echo PASS || echo FAIL` and
got the briefed numbers exactly, so #21's fix holds at this head and the ▶ Now block is true.
#22's deeper baseline definition — counts **and** sequences **and** `xmin` cardinality — is the
right definition, and it earned its keep within one round: the tester caught a 4-value sequence
offset behind fifteen matching row counts, on the exact table D37 compares ids on. The parity
harness's own discipline (negative controls against the pre-delta build for *every* claimed fix,
positive controls chosen so a lazy fix fails, status distributions instead of pass counts, six of
its own probe defects self-reported) is now genuinely good and is the reason three of my four
verification attempts above found nothing new.

**What is not.** All three countermeasures are per-instance patches, written after the instance.
The class is *reading absence as proof*, and the register does not yet contain a rule that
generalises it — it contains three specific rules that would each have caught one specific past
failure. The asymmetry is visible in where the instances now land: the tester's harness has the
general rule (never assert absence; always produce a discriminator that fails when the property
is false) and the coordinator's own verification does not. And the class is still producing
instances — §3.3's three stale source claims and §3.1's incomplete residual list are both "nobody
re-read the artefact after the fact it asserts changed", which is the same defect wearing
documentation instead of a grep.

So: **not accumulating faster than it closes, but the instances are getting cheaper rather than
rarer.** #19–#22 cost a re-do, a nearly-mis-closed condition, a false gate line and a
nearly-invalid round; §3.1 and §3.3 cost a docblock. That is progress, and it is not closure.

**What would close it** is one standing rule replacing the three specific ones: *a check that can
only report "nothing found" is not a check.* Every verification — grep, audit, lint run, fixture
comparison, gate line — must be able to produce a **positive discriminator** that fails when the
property is false, and must be run at least once in the failing direction. The parity harness
already does this and calls it a negative control; the coordinator's verification does not have a
name for it. Second, and cheaper: **stop putting the state of one artefact inside another.** All
three of §3.3's stale claims exist because a docblock restated the register instead of pointing at
it. **C67.**

---

## 7. Phase 4's open conditions — C44–C49 and C52–C57

Their stated deadline is *this* gate (`docs/review-phase-4-delta.md` §7, "Phase 5 gate" on
C52–C57; C44–C49 carried since `docs/review-phase-4.md`). I audited them against the tree — by
looking for the artefact each names, and reading the surrounding code where a string match would
have been the #20 mistake:

| condition | artefact it names | present at `d89f801`? |
|---|---|---|
| C44 | two ordering cells (`getLoan` missing id → 404 non-owner; `getUser` missing id → 403) | ❌ absent |
| C45 | `P4-D7` registered; `mailBcc` moved into its two branches; `getUserIds`/`getUserEmails` client threaded; `getLoans`' `userId === null` guard | ❌ `P4-D7` absent from `docs/phase-4-deviations.md`; `mailBcc` still hoisted at `loan.service.ts:616` |
| C46 | two measured cells | 🟡 **half done** — the fractional quota boundary landed with D29 (`test/loan.e2e-spec.ts:268`); the out-of-32-bit-range TSV `loan_id` cell is absent |
| C47, C49 | doc/config items | ❌ no artefact found |
| C52 | `refinanceLoan` docblock sentence + §4.1 widening | ❌ absent from `loan.service.ts:680-700` |
| C53 | unit cell: PAID_OUT loan's detail updated, `scheduleNotification` fires | ❌ absent |
| C54 | pointer from D31 + Phase 9 runbook line | ❌ absent |
| C55 | §5.1 wording | ❌ absent |
| C56 | `d3-race.py` landed in-repo | ❌ no `*race*` file in `test/` or `src/` |
| C57 | `python-obj.ts`'s unreachable `return 'float'`, P2028 shape, cross-reference | ❌ still at `python-obj.ts:411` |

So of eleven conditions, **one is half-closed and it closed as a side effect of D29's
implementation, not as condition work.** Nothing else was actioned during Phase 5.

C48's warning was about conditions surviving two gates. C44–C49 have now survived the Phase 4
delta gate and this one; C52–C57 have survived the gate they were written for. **C58 was the
precedent that this can be done** — fifteen conditions audited against the tree in one batch,
two of the audit's own verdicts caught and corrected. That batch is the template, including its
correction. I am not re-opening Phase 5 over Phase 4's ledger, but I will not let it roll a third
time silently either. **C59.**

---

## 8. Conditions

Numbered from **C59**, as briefed. "Gates Phase 6's start" means Phase 6's first controller does
not land until it is closed; "rolls to Phase 6's gate" means it is tracked and closed before that
gate, not before that phase begins.

| # | Condition | Deadline |
|---|---|---|
| **C59** | 🔴 **C44–C49 and C52–C57 close or are formally struck**, each with the same evidence standard C58 used: exercise the behaviour or read the whole function, never match a string, and record the audit's own errors if it makes any. Eleven conditions, one of them half-closed by accident. C48's two-gate warning has now been reached; a third roll is not available. | **Gates Phase 6's start** |
| **C60** | `python-str.ts`'s float rendering: port CPython's exponential threshold (`decpt <= -4 \|\| decpt > 16`) into `reprNumber`, keeping the two-digit exponent padding; add `0.00001`, `1.5e-5`, `1e16`, `-0.0`, `1e21` to `gen-python-str-fixture.py` and regenerate from the container; re-state limit 1 as the genuine residual (`5` vs `5.0`). If the fix is declined, the limits block must be corrected to describe **both** divergent bands, because "only integral-valued floats are affected" is false as written. | **Gates Phase 6's start** — Phase 6 writes text columns through the same helper |
| **C61** | One §5 register row for the request-target family, written **from the rule** (llhttp + Express vs gunicorn's `split_request_uri` + Django), with the six measured shapes as evidence: version echo, version range, absolute-form, no leading `/`, a target `urlsplit` refuses, and `\`. Include §3.2's two new cells. Add a sentence to `gunicorn-request-line.ts` recording that `split_request_uri` is deliberately unported and what that costs (the `ValueError → InvalidRequestLine` 400 and absolute-form path extraction). Correct `docs/parity-phase-5-delta-3.md` §4.2's O1 row: the shape is not confined to authority-form targets, and what it demonstrates is a request reaching a response without passing the resolver. | Rolls to Phase 6's gate |
| **C62** | Correct the three stale in-source claims: `activity.service.ts:59` (Phase 5 now owns D36 and shares D37), `activity-detail.controller.ts:57` (it is D36, decided under Q32, not an open finding), `activity.service.ts:247` (**13** active members, not 15). Prefer pointing at the register over restating it. | **Gates Phase 6's start** — Phase 6's module will be written from these files |
| **C63** | Give `pythonInt` and `toDjangoInt` CPython's `int()` whitespace set — which is neither `trim()`'s nor `pythonStrip`'s — with the two divergent code points (U+0085, U+FEFF) as cells in both directions. Answer the tester's §7.1 question in the phase record while doing it: this *is* the second helper ported by purpose. | Rolls to Phase 6's gate |
| **C64** | Bind D35's `NOT NULL` reproduction to the schema rather than to a comment: a type-level assertion that `auth_user.first_name`/`last_name` and `fondo_api_userpreference.primary_color`/`secondary_color` do not admit `null` in Prisma's generated input types, so relaxing a column is a **compile error** rather than a silent divergence. Replace the two `as string` casts at `user.service.ts:948-949` with the same narrowing the create path uses, or note why the cast is safe there. | Rolls to Phase 6's gate |
| **C65** | Three notes in `gunicorn-http-edge.ts`: duplicate headers are joined on the recovered path and dropped on the normal one (gunicorn joins, so the recovered path is the faithful one — say so); the body is complete-at-header-block and that is safe **only** because every recovered method reaches an `@All()` fallback carrying `@DrfNoRequestData()` — name the invariant where it is relied on; `restoreCatchAllRoutes` recurses without a visited set. | Rolls to Phase 6's gate |
| **C66** | Nits: `scripts/gen-python-str-fixture.py` is mode **644** (false-green #14's exact species — nine probe scripts, same failure); `user.service.ts:947`'s comment says the `NOT NULL` constraint decides the preferences 404 when Prisma's client-side validation does, and the status is right for a different reason than stated. | Rolls to Phase 6's gate |
| **C67** | Replace the three per-instance false-green countermeasures with one standing rule and record it in §7: **a check that can only report "nothing found" is not a check** — every verification must be able to produce a positive discriminator, and must be run once in the failing direction. The parity harness already does this and calls it a negative control; give it the same name in the coordinator's own method. Second clause: stop restating the state of one artefact inside another (all three of §3.3's stale claims exist for that reason). | **Gates Phase 6's start** |

**Escalated to `business-analyst`, not a condition:** `ActivityUser` rows are written only by
`create_activity`, so a member enrolled after an activity exists has no row on it and can never be
marked paid on it; the only API recovery is delete-and-recreate, which discards every payment
state already recorded. Faithful to v1, so no cell can fail and none was written. Is the snapshot
semantics the fund's intent — consistent with `ba-phase-5-activity-exposure.md` §2.2 accepting the
mirror case for departed members — or an operational trap for a mid-year joiner? No v2 code change
is implied either way.

---

## 9. Verdict

**Approved with conditions (C59 – C67). Phase 5 closes.**

Nothing found re-opens the phase. The activities port is faithful at every point I could check it,
the deliberate v1 shapes are carried with the source quoted, N1's model is correct and I verified
it against the running gunicorn rather than against the report, D35's per-call-site work is right
including the ordering case that would have caught a hoisted guard, and the third parity round is
the best evidence this project has produced.

**Gating Phase 6's start:** **C59** (Phase 4's eleven conditions, second gate), **C60**
(`python-str`'s float residuals — Phase 6 writes text through the same helper), **C62** (the three
stale source claims, because Phase 6's module will be written from these files), **C67** (the
false-green rule).

**Rolling to Phase 6's gate:** **C61**, **C63**, **C64**, **C65**, **C66**.

Two things I want on the record for whoever reads this at the next gate. First, three of my four
independent verification attempts measured **clean** — the `//`-target divergence I expected does
not exist, the keep-alive recovery does not crash, the segmented recovery is not double-answered —
and I have written them down as such, because a review that only reports what it found is the same
failure mode as a probe that only reports agreement. Second, **C59 is the one I would refuse to
approve past a third time.** Eleven conditions, one accidental half-closure, and a warning
(C48) that has now been reached. The C58 batch proved this is a day's work when someone does it.
