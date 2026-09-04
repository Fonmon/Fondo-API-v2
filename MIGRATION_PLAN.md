# Fondo-API — Django → NestJS Migration Plan

**Spec of record for v1 behavior:** `CONTEXT.md` in the v1 repo (`~/Projects/Fondo-API`).
When CONTEXT.md and the v1 source disagree, **the source wins** and CONTEXT.md gets fixed.

- **v1 (Django):** `~/Projects/Fondo-API`
- **v2 (NestJS):** `~/Projects/Fondo-API-v2` (this repo)

## Changelog

| Date | Rev | Change |
|---|---|---|
| 2026-09-03 | v2.6 | **Round 2's F6 and F8 fixed; both were bigger than filed, and both were implemented rather than registered.** **F6** — `APIView.initial()` negotiates a renderer *before* `perform_authentication`, so an unacceptable `Accept` is a **406 before the guards, the handler and any write**: `DELETE /api/user/<id>` under `Accept: application/xml` was **v1 refusing and v2 soft-deleting the row** (measured, restored). `DefaultContentNegotiation.select_renderer` ported into a middleware between the URL resolver and the body parser. A second failure mode the round-2 report did not reach: `?format=` naming no renderer's `format` is `Http404` — `GET /api/user?format=xml` is a **404 before authentication** in v1 and was a 200 in v2. **P3-D8 rewritten** to claim only the rendering (browsable HTML, `?format=api`, `text/*`, and a newly measured `Accept: application/json;indent=8` → 152 bytes vs 79). **F8** — the three rows had one cause: v2 parsed multipart with **busboy**, a strict parser, and v1 uses **Django's**, which raises in three places and salvages the rest. `MultiPartParser`/`BoundaryIter`/`parse_boundary_stream`/`cgi.valid_boundary`/`parse_header` ported; multer out of the request path. 16/16 cells identical, four of them the report never reached. The report's model of the missing-`boundary` case was wrong: `None.decode()` is an **AttributeError**, which `Request.data`'s property/`__getattr__` re-entry **swallows**, so the view sees an empty `QueryDict` — hence a serializer 400 on `/api-token-auth` and a `KeyError` 500 on `PATCH /api/user`. Also closed in the fail-closed direction: `RequestDataTooBig` / `TooManyFieldsSent`, which v2 was accepting. **R2.11.5** cell added with positive controls. Gate: lint + typecheck clean, **1602 unit / 53 suites**, **699 e2e + 1 skipped / 15 suites**. Live re-verification: 125 negotiation cells + 16 multipart cells + a 23-cell regression sweep, **status distributions identical on both stacks**; the only diffs are the registered Django HTML 404/500 pages. `pg_dump` of **every table** taken before the first write and diffed after: all 20 tables **byte-identical** — `schedulertask` 626, `notificationsubscriptions` 94/1468, `auth_user` 15 (1 active ADMIN, 2 inactive), `power` 20, `loan` 425. |
| 2026-09-04 | v3.5 | ✅ **Delta review's C50 and C51 closed — the two conditions gating Phase 5's start** (`docs/review-phase-4-delta.md`, Approved with conditions C50–C58). **C50 was a real regression M3 introduced and the code asserted the opposite of:** `bulkUpdateLoans`' auto-close called `updateLoanIn` with no `try`/`catch` inside the 120 s `$transaction`, so a concurrent `PATCH /api/loan/<id>` committing between `getLoans(state=1)` and the auto-close write made the compare-and-set miss and threw D9's 409 **out of the transaction callback, rolling back the entire monthly upload** — 374 `LoanDetail` upserts and every other auto-close — with a 409 naming neither the file nor the loan. v1 cannot fail here at all (`update_loan(id, 3)` writes unconditionally), so it was **v2-only**. Now caught **narrowly** (only D9's 409; a 404 or anything else still aborts), logged at `warn`, the loan **skipped** and omitted from `closed_loans` — mirroring v1's `except LoanDetail.DoesNotExist: continue` in the same method's first loop. Control-run: the new cell **fails against `17114a0`** with the 409 escaping at `loan.service.ts:843`. **C51**: the CAS's 409 is the sequential answer for five of the six race pairs D9 permits and **not** for winner `0→1` / loser `0→2` (from state `1`, `1→2` is legal, so sequentially the denier gets a 200 plus the denial mail and the `refinanced_loan` unlink). Docblock corrected, registered on D9's row and in §4.1/§5.1 of `docs/phase-4-deviations.md`, and **pinned by a unit cell** rather than fixed — the bounded re-read-and-retry changes behaviour on the money path and needs its own review cycle. ⚠️ Two false claims removed: `loan.service.spec.ts`'s "skipped with a 409" (it aborted) and §5.1's graceful-degradation reading. **C52–C58 remain, tracked to Phase 5's gate.** |
| 2026-09-04 | v3.4 | ✅ **Phase 4 conditions closed: C40, C41, C43, M3, and operator decisions D29/D30.** D29 takes **exact parity** on the quota boundary (`pythonGreaterThan`; the divergent window was `available_quota < value < available_quota + 1`, where `toDjangoInt` **truncates** — v2 was writing a *different value*, measured at quota 500 / `value 500.5` → v2 `201` writing `500` before the fix, `406` and zero rows after). D30 floors `value` at **1** (operator: the fund has no minimum). **M3's lost-update race** closed with a compare-and-set answering D9's own 409 — **designed out, not reproduced**, and §5.1 says so plainly so nobody reads the green suite as proof. **C40** gives every §3 phase block a mechanical "§5 rows this phase owns" line — the reviewer's point that *every convention this project carried had a carrier, every one that slipped was a paragraph*. ⚠️ **False-green #19, mine**: `161d780`'s message claimed a round its tree did not contain, because my verifying grep was line-wrapped and I read absence as proof. ⚠️ **D30 binds the refinance path** — a zero-capital projection is now a 400 where v1 books a zero-value loan; a consequence nobody decided, flagged to the reviewer. |
| 2026-09-04 | v3.3 | ✅ **PHASE 4 PARITY: PASS** (~1 580 cells, 15 matrices). 38 loans matched field-for-field; **approval email HTML byte-identical 38/38** (`sha256 994400c9…` both stacks); 23 TSV files with 0 DB and 0 auto-close-set differences; 420/420 projection cells; 425/425 loan reads. Fixture restored **byte-identical to the pre-write dump**, all 24 tables. **P4-F1 registered as D29** (a JSON-string `value` is a v1 500 and a v2 201 — keep v2's coercion; v1's refusal is a crash, not a rule) and **D30 opened** (neither stack bounds `value` below; floor pending an operator answer on a minimum loan amount). ⚠️ **False-green #18, mine, found by the BA**: the §3/§5 precedence note was verified and committed **on the wrong branch** and was absent from `feat/phase-4-loans` while two docs claimed it was present — now cherry-picked as `38bc9ba`. Also corrected three stale D4 claims I left behind in `docs/phase-4-deviations.md`, one of which told the tester to file **correct** D4 behaviour as a parity failure; I missed them by truncating my own sweep with `head -6`. The tester found its **SES/SQS stubs were never running** — instance #9 recurring, caught only by its positive control. |
| 2026-09-03 | v3.2 | ✅ **C28, C29, C30, C36 and C38's BA half CLOSED. Phase 4 is unblocked and starts now.** C28/C36 landed in `cec6c61`, gate verified independently: **1628 unit / 55 suites**, **699 e2e + 1 skipped / 15**, fixture at baseline. **The C28 control was re-run by me against the reverted line and is discriminating** (expected 2025, got 2026). ⚠️ **False-green #17, found by the developer and worth more than the condition it came from: `process.env.TZ` set *inside* a jest test is a silent no-op** — V8's cached zone does not see it — so on this `-05:00` host the C28 test passed against the buggy line. The pin now lives in `jest.config.ts` + `test/global-setup.ts`, before the workers fork. **Operator answered Q29a / Q30a / Q31**: **D25** and **D26** proceed as decided, **D27** was never conditional, **D28 is WITHDRAWN** — a TREASURER approving their own loan is accepted fund practice, so blocking the smaller self-write would be incoherent. **m6 accepted as-is.** ⚠️ **My brief to the developer carried stale baselines** (1476/48, 617/13, from v2.2); it checked disk and used v2.6's real 1602/53 instead of matching my number. |
| 2026-09-03 | v3.1 | ✅ **PHASE 3 CLOSED — Approved with conditions. Phase 4 may start.** D1 verified closed *properly*: no member-reachable path to `role`, `identification`, or another member's `finance`. **12 conditions C28–C39**; **C28** (timezone) and **C36** (hoist the shared helpers) gate Phase 4's first controller. **M5 is the finding of the phase** — D15 and P3-D2 are each correct and together create a new class of **unresettable account**, invisible to parity because v1 cannot reach the state. **M4 was my error**: v3.0 claimed two registration rows corrected; only D22 landed. D21 now fixed **and verified on disk**. |
| 2026-09-03 | v3.0 | ✅ **PHASE 3 PARITY: PASS (round 4).** D19/D20 confirmed on the two live inactive members; D21–D24 registered. **Two registration rows corrected** — a registration that misdescribes behaviour silences a real future signal. False-green register → **fifteen**: instance #11 was wider than filed (**9 of 17 probe scripts were mode 644**, and `d1.py`'s positive control was **unsatisfiable**, printing FAILED on every correct run — a control that always fails silences exactly like one that always passes), and **three rounds reported "byte-identical" while two sequences drifted 27 → 36 → 45**. To `nestjs-reviewer`. |
| 2026-09-03 | v2.9 | **business-analyst: Aligned — register F9–F12 as D21–D24, fix none. Phase 3 does not gate on them.** New **rule 12c**: files come from `request.files`, scalars from `request.body`, **never merged** — v1's `LoanView.patch` (P4) and `FileView.post` (P8) read `obj['file']` and only work *because* of DRF's merge, which is also the exact mechanism of D23. D22/D23 are **pre-declared for Phases 4–8** so they cannot be re-filed there. D19/D20 fold into a round-4 confirmation pass (4 cells); **D11 verification moves to Phase 9**. |
| 2026-09-03 | v2.8 | **Phase 3 round 3: F1–F8 and R2.11.5 all closed and re-verified**, nothing regressed under the new middleware or the replaced parser — 2,400+ live cells, all 24 tables byte-identical at close. Four new findings **F9–F12, all pre-existing and low severity**, routed to `business-analyst` as likely registrations; **F10 and F12 will recur on every multipart endpoint in Phases 4–8**. False-green register now **twelve**; **#9 was mine** — the v2 I handed the tester pointed SQS at real AWS with no `HOST_URL_APP`, a false-*pass* generator. |
| 2026-09-03 | v2.7 | **F6 and F8 implemented, not registered.** F6's write risk confirmed as a **literal mutation** (`DELETE /api/user/13` + `Accept: application/xml` → v1 406 unchanged, v2 200 **and the row soft-deleted**), then restored. F6 had a **second failure mode nobody had reported**: `?format=` naming an undeclared format is a **404 before authentication**. F8's three rows had **one** cause — busboy vs Django's parser are not two implementations of one contract — and the honest count was **nine**. Two false-green instances added (#7, #8); **#8 was mine**. |
| 2026-09-03 | v2.5 | **Phase 3 parity round 2: F1–F5 all fixed, nothing regressed** — 280/280 F3 cells, both metadata documents byte-identical, F5's four discriminating cells correct. Still **FAIL** on two *pre-existing* findings: **F6** (v1 returns **406 before authentication and before the handler** for an unacceptable `Accept`; v2 ignores `Accept` and executes — on a write endpoint that is v1 refusing and v2 **mutating**) and **F8** (malformed multipart crosses the 400/500 line both ways). The green-test sweep found **five** false-green instances, three in the tester's own harness. §7 dump rule amended: **persistent storage, and restore from the dump**. |
| 2026-09-02 | v2.4 | **Phase 3 parity failures F1–F5 fixed; back to `manual-tester`.** All five were at the HTTP edge, as filed; nothing in the users, finance, powers, scheduler-write or mail core was touched. **F3** (medium, security) — the four password-reset routes are `django.contrib.auth` views with **no DRF layer**, so nothing authenticates them; `@Public()` was the wrong analogue (it models `permission_classes = []`, which leaves DRF's authenticators running). New `@DjangoView()`, honoured by both guards **only when the resolved URL-table entry agrees** (`view !== null && drf === null`), so every disagreement leaves authentication running. **F5** (medium, security) — Django reads `csrfmiddlewaretoken` from the body for `POST` alone; v2 read it on every unsafe method, which let a body-borne token run `PasswordResetView.post` on a `PUT`. ⚠️ **An existing green e2e cell was asserting that bug**, not v1. **F1** — the 500-header strip now asks *who built the response* (`convert_exception_to_response` vs `finalize_response`) rather than what the status is; `UserAppsView`'s caught 500 keeps `Allow` and `Vary: Accept`. **P3-D6**'s claim corrected and its scope narrowed to the uncaught 500. **F2** — `HttpResponseRedirect` carries Django's default `Content-Type`; not D13's shape. **F4** — DRF's `OPTIONS` metadata document **implemented**, not registered (two constants, 164 and 172 bytes, captured from live v1): **P1-D2 withdrawn**, and its real residual — v1 renders *every* DRF response as browsable-API HTML under `Accept: text/html` — registered as **P3-D8**. Rule 12 clause 3 rewritten. Gate: lint + typecheck clean, **1503 unit / 49 suites**, **647 e2e + 1 skipped / 13 suites**; every fix re-verified against the live v1 (`:8451`, production settings). `fondo_api_schedulertask` **626, unchanged**; `pg_dump` of it and of the seven other in-scope tables taken before the first probe, per the new §7 rule. |
| 2026-09-02 | v2.3 | **Phase 3 parity: FAIL** — five unregistered diffs, all at the HTTP edge; the substance is exact (72-cell D1 matrix, byte-identical reset pages, `SchedulerTask` payload, SES/SQS payloads, four-table rollback). **F3 and F5 are security-relevant.** ⚠️ **Fixture incident: six historical `fondo_api_schedulertask` rows for owner 13 were deleted by a probe and are unrecoverable** — the table is 626, not 632. New §7 rule: **snapshot every table a phase writes, before the first write cell.** |
| 2026-09-02 | v2.2 | ✅ **PHASE 3 IMPLEMENTED** (`feat/phase-3-users`) — users, finance, powers of attorney, password reset, plus **Phase 7a** (the `SchedulerTask` write half, pulled forward because Phase 3 and Phase 4 both write rows). **C22–C25 closed.** Ten §5 deviations implemented (**D1, D2, D5, D11, D14–D17, D19, D20**); seven new ones registered (**P3-D1–P3-D7**) in `docs/phase-3-deviations.md`. **The session question is decided: keep the redirect hop, drop the store** — the token rides an `HttpOnly` cookie and is re-validated by `check_token`, exactly as Django re-validates its session copy (P3-D3). ⚠️ **Five behaviours corrected against the live v1, one a real defect: `@parser_classes` on an `APIView` *method* is a no-op**, so `PATCH /api/user` with JSON is a 500 and not a 415 — and the same decorator is misused in `LoanView.patch` and `FileView.post`, so Phases 4 and 8 inherit the correction. Gate: lint + typecheck clean, **1476 unit / 48 suites**, **617 e2e + 1 skipped / 13 suites**. `fondodev` unchanged (94 / 1468 / 1). |
| 2026-09-02 | v2.1 | ✅ **C19, C20 and C21 closed** (`03758dc`, `7415876`, `a39049c`) — the three prerequisites for Phase 3's first controller. `ALLOWED_HOSTS` ported from the installed Django 2.2.27 and re-measured against four live-v1 configurations; `RolesGuard` bound to the view the URL table resolved, with a hard failure on disagreement; the response phase ordered by v1 `MIDDLEWARE` depth, with `skipBeforeHeadersHooks` scoped to "below me". Both `Vary` orders (`Cookie, Origin` on `/password_reset/`, `Origin, Cookie` on `/reset/<uid>/set-password/`) re-measured on live v1 and now fall out of depth alone. Consider **C5** taken with C20. Gate: 1298 unit / 38 suites, 480 e2e + 1 skipped, lint and typecheck clean. **Phase 3 is now gated on Q26/Q27 alone.** |
| 2026-09-02 | v2.1 | **C19–C21 closed** (`03758dc`, `7415876`, `9846130`) — `ALLOWED_HOSTS` ported, the guard now authorises on the resolved **v1 view** rather than Express order, and the response phase runs by **middleware depth**. **Q26 and Q27 answered → D16 and D17 decided.** **Phase 3 unblocked and started.** Two corrections of mine: the fixture content-hash was unreproducible without its query (now recorded), and C19–C21 are numbered differently in the review doc than in this plan. |
| 2026-09-02 | v2.0 | ✅ **PHASE 2 CLOSED — Approved with conditions.** Reviewer re-derived claims inside the v1 image rather than re-running suites. Nine should-fix findings → **C19–C27**, graded by deadline. Three change Phase 3's shape: **S3 is a real vulnerability** (`ALLOWED_HOSTS` dropped; Phase 3's `PasswordResetView` builds the emailed link from the request host → reset-link poisoning), **S2** (the table resolves paths not views, so `/api/user/<x>` overlaps could evaluate under the wrong view's rules), **S1** (response hooks run FIFO — the reverse of Django — and the model has no notion of depth). |
| 2026-08-31 | v1.8 | **C18/N4 closed**; Phase 2 to `nestjs-reviewer`. Two method corrections that outlive this phase: **supertest silently strips fragments**, so a supertest regression cell passes against the broken code — raw-socket helper now in `test/http-edge.e2e-spec.ts`; and **`pg_dump` md5 is not a valid fixture guard** (`synchronize_seqscans = on` rotates rows — three dumps of unmodified data gave three md5s, verified). Use the sorted content hash + `count(distinct xmin::text)` instead. |
| 2026-08-31 | v1.7 | ✅ **Phase 2 parity: PASS (round 3).** N1–N3 fixed and verified; nothing regressed across 152 sweep requests, 6 `cmp`-identical SQS bodies, the 94-row decode scan and the full role matrix. One new non-gating diff **N4** (gunicorn drops a literal `#` fragment; v2 keeps it) → C18. Two corrections folded in: **`Vary: Cookie` affects three kept routes, not one**, and `GET /reset/<uid>/<token>/` **writes a `django_session` row** — a DB side effect on a GET that v2 has no model for. Both are Phase 3 scope. |
| 2026-08-31 | v1.6 | **Phase 2 parity round-2 diffs fixed; back to `manual-tester` for round 3.** **C15/N1 closed by a split, not a swap** — v1's `APPEND_SLASH` 301 is *above* `corsheaders` and its URL-resolution 404 is *below* it, so `DjangoAppendSlashMiddleware` + `DjangoUrlResolverMiddleware` now sit either side of `DjangoCorsMiddleware`; `AppModule.configure` carries v1's whole eight-row `MIDDLEWARE` list. **C16/N2 closed** — `escape_uri_path`/`iri_to_uri`/`escape_leading_slashes` ported (`django-uri-encoding.ts`), so the 301 `Location` is the decoded-then-re-encoded path. **C17/N3 closed now rather than at the P3 gate** — the resolver re-targets Nest's router at `PATH_INFO`, which needed the middleware mount moved from `{*path}` to `/`. Rule 14 gains both sub-rules. **O1 registered** (P2-D8 residual 4) plus a new residual 5 (a non-ASCII raw request target: Node answers 400 before any middleware, gunicorn/Django serves it). ⚠️ **Phase 3 note:** `GET /password_reset/` answers `Vary: Cookie, Origin` and sets a `csrftoken` cookie — a **kept** route, so `DrfViewHeaders` must widen when the auth pages land. |
| 2026-08-31 | v1.5 | **Phase 2 parity round 2: FAIL, narrower.** F1–F5 all fixed and **nothing in the substance regressed** — 22/22 URL patterns agree both slashed and unslashed, 5 SQS bodies `cmp`-identical incl. the 35 KB / 94-row one, fixture restored byte-for-byte. But the fix round introduced **N1** (middleware order: v1 runs `CommonMiddleware` before `CorsMiddleware`, so a preflight on an `APPEND_SLASH` path is a **301** in v1 and **200** in v2) and **N2** (`Location` must be `escape_uri_path(decoded)`, not the raw target). **N3** and **O1** are pre-existing, newly found. Back to `nestjs-developer`. |
| 2026-08-31 | v1.4 | **Phase 2 parity failures fixed; back to `manual-tester`.** All five findings addressed at the HTTP edge, nothing in the mail/hstore/SQS core touched. **C14 closed** — `app.enableCors()` removed and `corsheaders 2.4.0` ported, so a bare `OPTIONS` is authenticated again (it was a 204 for anyone). **C9 closed in full, now rather than in Phase 3** — v1's 22 `url()` patterns are transcribed in `django-url-conf.ts` and resolved **before the guards**, which closes S7, P2-D5 and F2 together and is **fail-closed**: a path v1 does not serve cannot reach a v2 controller. F3 (`QueryDict` last-value) fixed; most of F4 matched, the rest registered as **P2-D8**. **P2-D4 withdrawn — its premise was false**: `remove_all_subscriptions` is live in v1 and **Phase 3 must wire it**. **P2-D5 withdrawn** (fixed, not deviated). P1-D2's v2 column corrected. Two new cross-cutting rules: **14** (the URL conf) and a third clause on rule 12 (`OPTIONS` is a real, guarded method). |
| 2026-08-31 | v1.3 | **Phase 2 parity: FAIL** (`docs/parity-phase-2.md`). The *substance* is exact — every SES payload, SQS body, hstore row and the full role matrix are byte-identical, including a 35 KB body carrying all 94 live rows. All five failures are at the **HTTP edge**, three unregistered. Returned to `nestjs-developer` per the standing pipeline. **F2 folds into C9**; **F1** is new and severe. P1-D2's v2 column corrected. **P2-D4's premise is false** — `remove_all_subscriptions` is live, which changes Phase 3. |
| 2026-08-31 | v1.2 | **Phase 2 implemented** (`feat/phase-2-notifications`): SES mail + the six Spanish templates, the hstore `NotificationSubscriptionRepository`, SQS publishing with bounded retry, and `POST /api/notification/<subscribe|unsubscribe>`. **C10–C13 closed** (C11 with one registered residual); C9 still open. Deviations P2-D1–P2-D7 registered in `docs/phase-2-deviations.md`. ⚠️ Three findings for this plan: `json.dumps` ≠ `JSON.stringify` (separators + `ensure_ascii`) is a byte-parity rule that belongs in §4 alongside 5b/5c; adding `ORDER BY id` to the subscription read would **break** parity (heap order is the wire order, verified live); and `{% host %}` has **zero** call sites in v1's templates. |
| 2026-08-31 | v1.2 | **Phase 2 implemented** (`c72cc7c`); C10–C13 closed alongside. New cross-cutting **rule 5d**: CPython `json.dumps` ≠ `JSON.stringify` (separators + `ensure_ascii`) — this diverges on *every* notification, since all v1 bodies are accented Spanish, and Phase 7 publishes through the same path. Subscription queries must emit **no `ORDER BY`** (verified: heap order ≠ id order on `fondodev`). Handed to `manual-tester`. |
| 2026-08-31 | v1.1 | **Full pipeline standing from Phase 2 to the end**: `nestjs-developer` → `manual-tester` (sign-off) → `nestjs-reviewer` (sign-off), sequential. **Phase 2 started.** |
| 2026-08-31 | v1.0 | ✅ **Phase 0 APPROVED. Phase 1 APPROVED.** Round-2 review closed C1–C8. **C9 re-ruled: fix, do not accept** — v1 has no trailing-slash *rule*, only an inconsistent table, so a blanket rule would 404 routes v1 serves. C10–C13 added (Phase 3 gate). D19/D20 register two live v1 defects; one Phase 7 timezone consequence recorded. |
| 2026-08-30 | v0.14 | **All eight review conditions C1–C8 closed** (§7). Rule 5 **re-corrected and settled**: Django sets `os.environ['TZ']` from `TIME_ZONE`, so v1's `DateField` dates are **Bogotá**, verified against the pinned stack — the BA escalation on `last_modified` is withdrawn. Rule 5b (BigInt→JSON number) and 5c (`formatDateEs` takes a `PlainDate`) implemented as Phase 0 primitives. **D18 fixed rather than deviated** — v2 owns request parsing and reproduces DRF's multipart/415/JSON-parse behaviour, including CPython's error strings. `relativedelta` ported (reviewer P5). D1's primitives now express the C8 rule ordering. ⚠️ One review condition is **untracked**: S7 (detail-route trailing slashes) appears in the review's Phase 1 gate but in no §7 row — see the note under the table. |
| 2026-08-30 | v0.12 | **Phases 0 and 1 reviewed — both Approved-with-conditions, no blocking findings.** 8 conditions tracked in §7. Cross-cutting rule 5 **corrected** (Django `DateField(auto_now)` is process-local, not tz-aware). Two new rules: BigInt→JSON (17 columns; first Phase 3 response would 500) and the date-formatting/localtime asymmetry. D18 registered for content-type divergences. Fixed a self-contradiction in §9. |
| 2026-08-30 | v0.11 | business-analyst Phase 3 note folded in (verdict: **Concerns**). D1 clarified on two points that would each have broken every ordinary member save. **D14–D17 registered**; D16/D17 need operator input. Two live v1 defects verified and recorded: personal edits to the two shared-email accounts **409 today**, and **4 of 15 members cannot reset their password**. |
| 2026-08-30 | v0.10 | **Standing review gate made explicit** (§7): `nestjs-reviewer` runs at the end of every phase and writes `docs/review-phase-<n>.md`; no phase closes without a verdict. Phases 0 and 1 under review now, retroactively. |
| 2026-08-30 | v0.9 | **Phase 1 complete and verified** (`feat/phase-1-auth`, `151314f`). ⚠️ **Corrected a false premise: `username != email` for 2 of 15 live users, and Django authenticates on `username`** — the plan's mapping would have locked them out. DRF auth bodies derived and pinned (Phase 1's open item closed). Two new cross-cutting rules (405-vs-404, DRF framework error shape). D13 registered. Role-matrix criterion corrected to 280 cells. |
| 2026-08-30 | v0.8 | **Q25a resolved — D1 fully specified.** Privileges are additive on top of universal self-service. **Phase 1 unblocked and started.** |
| 2026-08-30 | v0.7 | Q10, Q13, Q18–Q25 answered. **Phase 6 unblocked** — CAP rules now specified. D3 **withdrawn** (v1 was right); D5 decided; **D12 added** (CAP auto-close, new functionality — makes P6 depend on P7). Cutover calendar constraint **corrected and narrowed** after re-reading `create_year` — only the bulk-upload cycle genuinely constrains timing. |
| 2026-08-30 | v0.6 | **Phase 0 complete and verified** (`feat/phase-0-foundations`, `b3effab`). Eleven corrections from implementation folded back: DB-level FK facts (deferrable, no cascade), hstore write-side + key-order rules, DRF error-body gap in Phase 1, D11 registered, Prisma 7 / NestJS 12 tooling notes added as §10. |
| 2026-08-30 | v0.5 | **v1 is frozen** — no changes to the Django codebase for any reason (new constraint, §1). Q6 and Q12 reconfirmed as deliberate accepts. Phase 0 started. |
| 2026-08-30 | v0.4 | Operator answers folded in (Q1–Q9, Q12, Q14–Q17). **Phases 1 and 4 unblocked.** Dev DB reloaded to `0019` — Phase 0 prerequisite cleared. D1 refined to a concrete field-level rule; D4 changed from *validate* to *reject 400*; four new deviations (D7–D10) registered for behavior the operator asked to change. Phase 6 still blocked (Q19–Q24); Q10/Q11/Q18 still open. |
| 2026-08-30 | v0.3 | business-analyst review folded in (verdict: **Concerns**). Added §5 **Deliberate deviations register** — v1 has authorization holes the parity contract would otherwise replicate. P7 resequenced to after P4. Phase 0 gains a dev-DB prerequisite (it is at migration 0015; `power` and `savingaccount` tables are missing). Phase 2 gains four notification conditions; P3/P4/P6 gain newly surfaced rules. §9 now tracks 24 operator questions. |
| 2026-08-30 | v0.2 | Q1–Q7 answered. **ORM decision: Prisma (binding).** Cutover is a hard switch performed by the user; v2 owns the schema post-cutover. Alexa confirmed retired. CI/CD reuses CodeBuild. Password-reset token cross-compat requirement **dropped**. hstore→jsonb scheduled as v2's first owned migration. Plan moved to the v2 repo. |
| 2026-08-30 | v0.1 | Initial draft. Phase 0–9 scoped, ORM comparison drafted, cross-cutting parity rules and gate template defined. |

---

## 1. Fixed constraints (not up for re-litigation)

- **Target stack:** NestJS (latest stable), **Node 24** (`.nvmrc` = 24), TypeScript **strict** mode.
- **ORM: Prisma.** Decided in §2. **Binding** for `nestjs-developer` and `nestjs-reviewer`.
- **Database:** the existing PostgreSQL schema Django created. No schema rebuild, no data
  migration, no renames **until cutover**. v1 and v2 share one database during development
  and parity testing; in production the switch is atomic.
- **Cutover: hard switch, performed by the user.** v1 and v2 never serve production traffic
  simultaneously. This plan produces a runbook; it does not perform the cutover.
- **Schema ownership:** Django owns the schema through Phase 8. **v2 takes ownership at
  cutover** via a Prisma baseline, and owns all migrations thereafter.
- **Out of scope — delete entirely, do not port** (Alexa is confirmed retired):
  - `AlexaView` / `POST /api/alexa`
  - `AuthView` / `GET|POST /api/authorize` — Alexa account-linking only
  - everything under `fondo_api/services/alexa/`
  - `ALEXA_CLIENT_ID`, `AWS_SKILL_ID`, `templates/auth/authorize.html`
  - all of `fondo_api/tests/alexa/` (20 tests)
  - ⚠️ `PasswordResetView` lives in the same file as `AuthView` and **is in scope** — do not
    delete `views/auth.py` wholesale.
- **In scope, must reach behavioral parity:** token auth, role permissions, loans +
  amortization + refinancing + bulk TSV upload, users + finance/quota + activation + powers
  of attorney, activities per year, saving accounts (CAPs), web-push notifications via SQS,
  SES email (Spanish templates), GCS file storage, password reset, and the Celery-beat
  scheduler.
- **CI/CD:** reuse the existing AWS CodeBuild + `buildspec.yml` + SSM deploy-trigger shape.
- **v1 is frozen.** No changes to the Django codebase — not features, not refactors, not
  security patches. Every fix lands in v2 only. Two consequences to hold in view:
  1. The **D1 privilege escalation stays live in production until cutover.** It is a real,
     currently-exploitable path to ADMIN and to self-set loan quota. Accepted by the operator;
     recorded here so the decision is visible rather than forgotten. It raises the value of
     shipping Phase 1 promptly.
  2. v1 stays the parity oracle for the whole migration — it cannot drift under us, which makes
     `manual-tester`'s diffs trustworthy. This is the upside of the freeze.

---

## 2. ORM decision: **Prisma** (binding)

Scored against this project's specifics. The user delegated the call ("the one that best fits
the project's needs and design"), so this is a decision, not a recommendation.

| Criterion | Prisma | TypeORM | Weight |
|---|---|---|---|
| **Migrations, v2-owned schema** | ✅ Prisma Migrate; `migrate diff` + baselining an existing DB is a first-class, documented workflow. Declarative schema is the source of truth. | ⚠️ `migration:generate` is drift-based, noisier, and routinely needs hand-editing. | **High** |
| **`hstore` columns** (2 of them) | ❌ Not supported — [prisma#19000](https://github.com/prisma/prisma/issues/19000) open. Introspects as `Unsupported("hstore")`, which the client **cannot select**. Needs raw SQL with `::text` casts. | ✅ Native `{ type: 'hstore' }` → `Record<string,string>`. | **High**, but **time-boxed** — see below |
| **TS type safety of results** | ✅ Generated types, end to end. | ⚠️ Hand-maintained entities that drift from the DB. | **High** |
| **Externally-owned schema** (Phases 0–8) | Good `db pull`; Migrate held back until cutover via baseline. | `synchronize: false` and it simply doesn't care. | Medium |
| **Django MTI** `UserProfile(User)` → `auth_user` + `fondo_api_userprofile` | 1:1 on `user_ptr_id`; every user read needs an explicit `include`. | `@OneToOne` + `@JoinColumn`. Comparable. | Medium |
| **Decimal / BigInteger money**, `rate` Decimal(5,3) | ✅ `Decimal.js`-backed, no float drift. `BigInt` for bigints. | ⚠️ `decimal` returns **string** by default; needs a transformer. | Medium |
| **Transactions** vs `transaction.atomic()` / `set_rollback` | Interactive `$transaction(async tx => …)`. | `dataSource.transaction()` / `QueryRunner`. Both fine. | Medium |
| **Raw SQL escape hatch** (bulk TSV upserts) | `$queryRaw` / `$executeRaw`, tagged and typed. | `query()` / QueryBuilder. Both fine. | Low |

### Rationale

Two facts decide it. **v2 owns the schema after cutover and the ORM must carry migrations**
— that promotes the migration story from a footnote to a top-weight criterion, and Prisma
Migrate is clearly stronger there. And **the hstore problem is bounded and temporary**: it
touches roughly 6–8 query sites across exactly two subsystems, it is quarantined behind two
repository classes, and it **dies at cutover** when the columns become `jsonb` (§3, Phase 9).
Prisma's type safety and migration ergonomics, by contrast, are paid forward for the life of
the project. This repo's `.gitignore` already carries `/generated/prisma`.

### The trade-off, stated plainly

The raw-SQL burden lands on **notifications and the scheduler** — precisely the two
subsystems with the thinnest inherited test coverage (4 tests and 0 respectively). This is
the single largest risk the decision creates, and Phases 2 and 7 carry extra integration-test
requirements to offset it.

### hstore handling until cutover

- Model both columns as `Unsupported("hstore")` in `schema.prisma`. Prisma Migrate preserves
  them; the client cannot read them.
- **All** access goes through `NotificationSubscriptionRepository` and `SchedulerTaskRepository`.
  No `$queryRaw` touching hstore anywhere else in the codebase — reviewer enforces this.
- Reads cast to text (`subscription::text`) and parse via the Phase 0 hstore codec.
- ⚠️ **Writes need the Python encoding too** — not just reads. Django `str()`s every value before
  storing, so a nested dict becomes a Python `repr` (single quotes). If v2 wrote JSON into the
  same column, v1 and v2 rows would be encoded differently and the read-side repair would break
  on v2's own rows. The Phase 0 codec implements both directions; use it on every write.
- ⚠️ **Subscription queries must emit no `ORDER BY`.** Django emits none, so v1 serialises
  **heap order**, and on `fondodev` heap order is not id order (verified: `160, 761, 1027, 783…`
  vs `160, 677, 710, 715…`). Adding the "obvious" `ORDER BY id` would *break* parity. Note this
  sits beside — and reads like the opposite of — the key-order rule below; both are about
  reproducing an order v1 never chose deliberately.
- ⚠️ **hstore key order is part of the SQS wire format.** Postgres returns hstore keys ordered by
  key length then bytes, and v1 `json.dumps`es that dict straight through to SQS. Phase 2's
  byte-identical criterion depends on reproducing that ordering — it is not an implementation
  detail.
- The codec must reproduce v1's quirks exactly — string-only values, `json.loads` on
  `payload['user_ids']`, and the `'` → `"` repair on the push-subscription `keys` sub-object
  (a Python `repr`, not valid JSON). **Do not "fix" these** — live rows depend on them.

---

## 3. Phase sequence

```
P0 Foundations & Prisma baseline ──┐
P1 Auth + roles                  ──┤ (no domain endpoints; everything depends on these)
P2 Mail + notifications          ──┤ (users & loans both emit)
P3 Users, finance, powers, password reset
P4 Loans (the risk centre)
P7 Scheduler ── resequenced: sole delivery path for payment reminders, zero inherited tests
P5 Activities
P6 Saving accounts
P8 Files + admin
P9 Cutover (user-performed) + hstore→jsonb + decommission
```

---

> **Why this line exists (C40).** Every convention this project carried successfully had a
> *carrier* — a table, a type error, a unit assertion. Every one that slipped was a
> paragraph: the §3/§5 precedence (D4's clamp), "compare raw then coerce" (D29), "the same
> predicate" (P4-F2) — three failures in Phase 4 alone, all in the prose column. This index
> is the carrier for "which decisions does this phase owe?", so a dispatch brief can be
> checked against the register mechanically instead of by reading §3's description of v1.

### Phase 0 — Foundations, Prisma baseline, cross-cutting utilities

**§5 rows this phase owns:** **D13**. *(Plus every cross-cutting row — D21, D22, D23, D24 — which start here and apply to all later phases.)*

**Goal:** a NestJS app that boots against the real schema, with the primitives every later
phase depends on. **No business endpoints.**

✅ **Prerequisite cleared (2026-08-30):** `fondodev` reloaded from a recent snapshot and
verified at `0019_auto_20220313_1225`, with `fondo_api_power` and `fondo_api_savingaccount`
present. Phases 3 and 6 are parity-testable. Re-verify after any future DB reload — a snapshot
older than `0017` silently breaks those two phases.

**Scope**
- Nest scaffold: Node 24, TS strict, ESLint + Prettier, Jest (unit) + Supertest (e2e).
- **Prisma setup:**
  - `prisma db pull` against the Django-created schema; hand-correct the generated models.
  - Verify against `fondo_api/models.py` and migrations `0001..0019`.
  - Both hstore columns as `Unsupported("hstore")`.
  - **Baseline:** generate an initial migration via `migrate diff` and mark it applied
    (`migrate resolve --applied`) so v2's history starts from the current live schema.
    **Do not run `migrate dev` against any DB v1 still uses.**
- Config module: typed and **validated at boot**, replacing v1's scattered `os.environ`
  reads. v1 `KeyError`s at import on a missing `DEFAULT_FROM_EMAIL`; v2 must fail fast with
  a clear message.
- Cross-cutting utilities, each unit-tested against v1's expected values:
  - `days360()` US-NASD 30/360 — port from `services/utils/date.py`; tests from `test_date_utils.py`.
  - **Money helper.** v1 rounds with `int(round(float(x), 0))` — Python **banker's rounding**.
    JS `Math.round` rounds half **up**. They differ on every `.5`. Ship `roundHalfEven()` and
    use it wherever v1 uses `round`.
  - **hstore codec** (§2).
  - **Spanish locale formatting.** v1 uses `babel.dates.format_date` / `babel.numbers` with
    `ROUND_HALF_DOWN`. Node `Intl` is not byte-identical. Pin with golden-string tests taken
    from v1's email assertions.
  - Timezone: `America/Bogota`, Django `USE_TZ=True` semantics.
- Global exception filter reproducing v1's `(success, payload_or_msg)` → `{message}` + status
  convention.
- `{ list, num_pages, count }` pagination helper, including v1's behavior that a page beyond
  the last returns an **empty list, same envelope, HTTP 200** — not 404.
- CI skeleton on the existing CodeBuild shape (§7).

**Risks**
- Introspected models disagreeing with Django semantics — especially `auto_now` /
  `auto_now_add`, which Django sets **in Python**, not as DB defaults. v2 must set
  `created_at` / `last_modified` explicitly or hit NOT NULL violations.
- During parity testing both apps insert into the same tables and must share the same
  Postgres sequences. Free as long as v2 never redefines a PK column — verify explicitly.

**Gate:** every table round-trips; utility unit tests green and matching v1's values.

---

### Phase 1 — Authentication and role permissions

**§5 rows this phase owns:** **D1** (decide only — implemented in P3), **D18**.

**Goal:** a request authenticated by v1 is authenticated identically by v2, and every role
rule matches.

**Routes:** `POST /api-token-auth`.

**Scope**
- **DRF token auth.** Reuse `authtoken_token` as-is (key PK, `user_id`, `created`). Token is
  40 hex chars. Header scheme is `Token`, **not** `Bearer`. Login uses **get-or-create** —
  v1 reuses an existing token and does not rotate.
- **Django password verification.** Hashes are `pbkdf2_sha256$<iterations>$<salt>$<b64hash>`
  (Django 2.2 default 150 000 iterations). v2 must verify this format — real member passwords
  live in `auth_user`. While v1 still runs in dev/parity, v2 also **writes** that format on
  activation and reset. Rehash-on-login to argon2 is a post-cutover cleanup item, not now.
- **`UserProfile(User)` identity mapping** — `auth_user` + `fondo_api_userprofile` on
  `user_ptr_id`.
- ⚠️ **CORRECTED (v0.9) — do not trust CONTEXT.md here.** The plan previously said
  `USERNAME_FIELD = 'email'` and `username = email` everywhere. **Both halves are misleading.**
  `AUTH_USER_MODEL` is commented out (`api/settings/base.py:101`), so Django's `ModelBackend`
  uses `User.USERNAME_FIELD == 'username'`; `UserProfile.USERNAME_FIELD = 'email'` **never
  participates in authentication**. And while v1 *writes* `username = email` on create,
  **2 of the 15 users in `fondodev` have `username != email`** (verified). Login resolves
  **`auth_user.username`**. A v2 that looked up `email` would lock those members out of their
  own fund.
- **Roles guard** reproducing `APIRolePermission` (`fondo_api/permissions.py`) exactly:
  - int rule N → allow if `role <= N` (0=ADMIN, 1=PRESIDENT, 2=TREASURER, 3=MEMBER)
  - list rule → allow if `role in list`
  - **any lookup miss or exception → deny.** v1's bare `except: return False` means a route
    absent from `list_permissions` is denied, not open. v2's guard must **default-deny**, and
    a route with no explicit rule must fail closed.
- Public routes (guards cleared): `POST /api-token-auth`, `POST /api/user/activate/<id>`,
  `POST /password_reset/`. Nothing else.

**⚠️ Additional deliverable — resolve the authorization gaps before writing the role matrix.**
v1's role matrix is not a safe spec on its own; see §5. D1–D3 must be decided (port or fix)
**in this phase**, because the Phase 1 parity criteria hard-code the matrix as the contract.
A decision deferred here gets silently baked in.

**Risks**
- ⚠️ **Highest-severity phase.** A wrong guard silently widens access to member financial data.
- Deny-by-default is easy to lose when translating a dict lookup into decorators.
- ⚠️ The role matrix is **necessary but not sufficient** — v1's holes are inside the service
  layer (no ownership checks), not in the guard. A perfect guard port still leaves D1 open.

**Parity criteria**
- The same token string authenticates against both APIs.
- Valid/invalid login returns identical status and body.
- ✅ **Resolved.** All auth-failure bodies are derived and pinned in
  [`docs/phase-1-drf-auth-bodies.md`](docs/phase-1-drf-auth-bodies.md) — from the
  `djangorestframework==3.11.2` sdist *and* an independent container running v1's real settings
  and unmodified `permissions.py`. `manual-tester` cites that document rather than re-capturing.
- ✅ **The 401-vs-403 ambiguity is not real for this project.**
  `TokenAuthentication.authenticate_header()` returns a truthy `'Token'`, so DRF's coerce-to-403
  branch is dead code here. **Every authentication failure is 401** with `WWW-Authenticate: Token`;
  only `APIRolePermission` denials are 403. Stated here so nobody re-derives it.
- ⚠️ Two ordering facts that are easy to get backwards: a missing or wrong-scheme header is **not**
  an authentication error (DRF returns `None`, and `IsAuthenticated` produces a *different* body
  later); and `APIView.initial()` authenticates **before** checking permissions, so a bad token
  401s **even on a public route** — `POST /api-token-auth` with a garbage token never reaches login.
- **Full role matrix: 14 view classes × 5 methods × 4 roles = 280 cells.** Test *all five*
  methods, not only those declared in `list_permissions` — the **undeclared** ones are exactly
  where the default-deny fallthrough lives, and testing only declared methods never exercises
  it. (`DELETE /api/loan` is 403 even for ADMIN.)

---

### Phase 2 — Outbound integrations: SES mail + SQS notifications

**§5 rows this phase owns:** none. *(Verified against the register's Phase column, not assumed — the phase closed on conditions C19–C27 instead.)*

**Goal:** v2 emits byte-identical emails and SQS messages. Before users/loans because both
emit on write paths.

**Routes:** `POST /api/notification/<subscribe|unsubscribe>` (role ≤ 3).

**Scope**
- `MailService` on **`@aws-sdk/client-ses`**. Port `send_mail(template, recipients, params, bcc)`
  including: an address in **both** `recipients` and `bcc` is dropped from `bcc`; and **any
  exception returns `false`** rather than throwing — `create_user` depends on the falsy return
  to roll back.
- Port the six Spanish templates via the `EmailTemplate` enum: `USER_ACTIVATION`,
  `CHANGE_STATE_LOAN_APPROVED`, `CHANGE_STATE_LOAN_DENIED`, `POWER_APPROVED`, `TEST`,
  `PASSWORD_RESET`. Django templates → a Node engine (Handlebars/Eta). The `{% host %}`
  custom tag → a `host` template variable from config. *(Phase 2 note: `{% host %}` has **zero
  call sites** in v1 — no template uses it. The activation email receives the same value as an
  ordinary `host_url` context variable at `services/user.py:51`. Wired but unused.)*
- `NotificationSubscriptionRepository` (raw SQL, hstore — §2): storage deduped on
  `subscription__endpoint`.
- `send_notification(user_ids, message, target)` builds `{ subscriptions, message: { body, target } }`
  and publishes to **SQS** (`NOTIFICATIONS_QUEUE_URL`). The external Lambda still does the
  actual Web Push, unchanged.
- v1's Celery indirection collapses: v1 does `send_notification.delay(...)` → task → SQS; v2
  publishes directly, so `run_async` True/False converge. ✅ **Resolved (§9.1): there is no
  retry layer to lose** — `celery/tasks.py:send_notification` swallows exceptions and declares
  no `autoretry_for`, and the scheduler path already publishes inline. Four binding conditions:
  1. Add a **bounded retry with backoff** (3 attempts) around `SendMessage`. Strictly improves
     on v1; no new infrastructure.
  2. Keep v1's swallow semantics at the boundary — a publish failure must **never** fail the
     HTTP write or roll back a loan/CAP/power row.
  3. ⚠️ **Never put the SQS publish inside a Prisma interactive transaction.** All three v1
     `.delay()` sites sit *outside* `transaction.atomic()`. Moving the publish inside would
     make an SQS outage roll back loan creations — a business-visible regression the inline
     change makes easy to introduce accidentally.
  4. Pre-existing gap to carry forward knowingly: a member with zero rows in
     `notificationsubscriptions` receives **no payment reminder at all** (`send_notification`
     returns early). Not a migration defect — but do not "fix" it silently either.

**Risks**
- ⚠️ Email HTML is asserted **byte-for-byte** in v1 tests (`test_mail_service.py`, and full
  SES payloads inside the loan tests). Whitespace, Spanish dates, and currency formatting must
  match — this is where the Phase 0 formatter earns its keep.
- ⚠️ **hstore + thin coverage.** Only 4 v1 notification tests exist and this is raw-SQL
  territory. **Extra integration tests required** covering the round-trip of a real
  push-subscription payload, including the nested `keys` repair.

**Parity criteria**
- Per template: identical SES payloads (`Source`, `Destination`, `BccAddresses`, `Subject`, `Body.Html`).
- Subscribe/unsubscribe produce identical `notificationsubscriptions` rows; re-subscribing the
  same endpoint does not duplicate.
- SQS message bodies byte-identical for the same input.

---

### Phase 3 — Users, finance, powers of attorney, password reset

**§5 rows this phase owns:** **D1** (implement), **D2**, **D5**, **D11**, **D14**, **D15**, **D16**, **D17**, **D19**, **D20**. Cross-cutting **D22**, **D23**, **D24** land here first.

**Routes:** `POST|GET|PATCH /api/user`, `GET|PATCH|DELETE /api/user/<id>`,
`POST /api/user/<birthdates|power>`, `POST /api/user/activate/<id>`, `POST /password_reset/`.

**Scope**
- `create_user`: atomic — `UserProfile` (**both tables**) + `UserFinance` (zeros) +
  `UserPreference`; `key_activation` = 25 random bytes hex; activation email. **If the mail
  send returns falsy, roll the whole transaction back** and return `'Invalid email'`. Unique
  violation → `'Identification/email already exists'`.
- **⚠️ Two decisions Phase 1 surfaced and deliberately did not make:**
  1. **D1's `role` check — "field present" or "field changed"?** v1's client posts the whole
     `personal` object on every PATCH, `role` included. A literal "`role` key present and caller
     is not ADMIN → 403" would break a member editing their own name. Phase 1 shipped both
     readings as tested primitives (`field-allowlist.ts` and `changedFields()`) and chose
     neither. **Recommendation: the `changedFields` reading** — compare against the stored value
     and only 403 on an actual change. Put this to business-analyst before implementing.
  2. **`PATCH /api/user/-1` does not mean "me" in v1.** Only `UserDetailView.get` substitutes
     `request.user.id`; `.patch` and `.delete` pass `-1` straight through and 404. Looks like an
     oversight rather than a rule. `resolveUserId()` makes the choice explicit so it cannot be
     inherited by accident — decide deliberately.
- ⚠️ **The two shared-email accounts — verified live, and the hazard is not what it looked like.**
  `fondodev` has **two pairs of users sharing an email address**: ids 7 & 14
  (`criss9413@hotmail.com`) and ids 10 & 13 (`mhjc123@hotmail.com`). Ids 13 and 14 have
  birthdates in **2011 and 2020** — children enrolled under a parent's address. Because
  `auth_user.username` carries a UNIQUE index (`auth_user_username_key`),
  `user.username = obj['email']` does not silently rename them: it raises `IntegrityError`, so
  **any personal edit to Sebastián or Ainhoa returns a bare 409 today**. The silent login-name
  rotation only occurs if one of them is later given a fresh, unique email. D15 fixes the write;
  the two rows still need reconciling — see the runbook item in §9.
- `update_user` dispatch on `obj['type']` → `personal` / `finance` / `preferences`, returning
  200/404/409. Finance writes **only changed fields** and recomputes
  `available_quota = total_quota - utilized_quota`.
- ⚠️ **The `preferences` branch deletes push subscriptions** — added v1.4 after parity finding
  **F5**, which falsified P2-D4's claim that `remove_all_subscriptions` was dead code.
  `services/user.py:208-218` compares the stored `notifications` flag with the submitted one
  and, when it goes **`true → false`**, calls
  `self.__notification_service.remove_all_subscriptions(id)` — every subscription that member
  owns, on every device. Phase 2 ported the method (`NotificationService.removeAllSubscriptions`,
  two DB-backed e2e cells) but could not wire it, because this route did not exist. **Wire it
  here, on the transition only**, not on every preferences save. It is irreversible from the
  server's side (the browser only re-subscribes on service-worker activation), which the tester
  escalated to `business-analyst`.
- `activate_user`: match `(id, key_activation, identification)`, set password (Django format),
  `is_active = true`, null the key.
- `DELETE` = **soft delete** (`is_active = false`), role ≤ 0.
- `id == -1` means "me" — the URL regex deliberately allows a negative id.
- `PATCH /api/user` — multipart **TSV bulk finance update** keyed by identification.
- `handle_power_request` multiplexed on `request['type']` (`post`/`get`/`patch`); on approval,
  emails the formal Spanish power-of-attorney letter **to all users**. Two defects ride along
  (§5 D2, D5): recipients go in `ToAddresses` with an empty `Bcc`, **exposing every member's
  email address to every other member**; and `Power.objects.get(id=request['id'])` never checks
  that the caller is the requestee, so **any member can approve any power request** and trigger
  the fan-out. Decide port-or-fix before implementing.
- `birthdates` app; setting `birthdate` on a personal update schedules a **yearly** (`repeat=4`)
  `SchedulerTask` for all other users. Rows written here, consumed in Phase 7.
- `get_users_attr(attr, roles)` helper.
- **Password reset.** ✅ *Simplified by the hard-switch decision.* v2 uses its **own** token
  scheme — no need to reimplement Django's `default_token_generator` or share
  `DJANGO_SECRET_KEY`. Port the behavior, not the token format: the http/https switch on
  environment, and the **unconditional** redirect to `/password_reset/done/` (no user
  enumeration). *Runbook note: reset links issued by v1 stop working at cutover; Django's
  default timeout is 3 days, so worst case a few members re-request.*
- ⚠️ **`Vary: Cookie` is on three *kept* routes, not one** (corrected in the round-3 sweep;
  v1.6 recorded only `GET /password_reset/`). `DrfViewHeaders` in
  `src/common/http/django-url-conf.ts` must widen when these views land:

  | route | `Vary` | also |
  |---|---|---|
  | `GET /password_reset/` | `Cookie, Origin` | `Set-Cookie: csrftoken` |
  | `GET /reset/<uid>/<valid token>/` | `Origin, Cookie` | **302** → `/reset/<uid>/set-password/` |
  | `GET /reset/<uid>/set-password/` | `Origin, Cookie` | `Set-Cookie: csrftoken` |

  **The element order differs between them** — `Cookie, Origin` on the first, `Origin, Cookie`
  on the other two. Django's `patch_vary_headers` appends rather than sorts, so the order
  records which middleware ran first. Transcribe the string per route; do **not** build it by
  joining a set. (`GET /api/authorize` is also `Vary: Accept, Origin, Cookie`, but Alexa is not
  migrated — out of scope, not a fourth row.)
- ⚠️ **`GET /reset/<uid>/<token>/` writes a `django_session` row — a DB side effect on a GET,
  and a Phase 3 *design* question rather than a one-liner.** With a valid token,
  `PasswordResetConfirmView.dispatch` (Django 2.2.27, `contrib/auth/views.py:272-278`) stores
  the token in the session (`self.request.session['_password_reset_token'] = token`) and
  redirects to the same path with the token replaced by `set-password`, so `SessionMiddleware`
  persists the session and **inserts a `django_session` row before the 302**. That write is
  also where the `Cookie` in `Vary` and the `sessionid` cookie on those two routes come from.
  **v2 has no session model at all** — nothing maps `django_session`, there is no session store
  and no `sessionid`. Since v2 already uses its own token scheme (above), the open question is
  whether the token-in-session hop is reproduced with real server-side sessions or replaced by
  a signed token carrying the same state. **Decide it here; do not build it as part of the
  header work**, and put the choice to `business-analyst` if it changes the reset URL shape.

**Risks**
- MTI writes touch two tables; a partial insert corrupts login.
- The email-failure rollback is a real transactional requirement, not a nicety.
- TSV parsing: `line.decode('utf-8').strip().split("\t")`, dates `d/m/Y` → `Y-m-d`.

**Parity criteria**
- User creation produces identical rows across `auth_user`, `fondo_api_userprofile`,
  `fondo_api_userfinance`, `fondo_api_userpreference` (modulo id/timestamps).
- Mail-send failure leaves **zero** rows in all four tables.
- Same TSV → identical finance rows and `last_modified` semantics — including
  `last_modified` **not** moving when no value changed.
- Power approve/reject → identical rows and identical email recipient list.
- ⚠️ **A birthdate edit produces a byte-identical `SchedulerTask`** — `type`, `run_date`
  (local midnight, i.e. `05:00Z`), `repeat = 4`, `processed = false` and `payload::text`,
  including the **unordered** `user_ids` list, which is PostgreSQL's heap order and must not be
  sorted. Added v2.2; the scope list above did not mention this write at all (finding S9).

---

### Phase 4 — Loans

**§5 rows this phase owns:** **D4**, **D6**, **D8**, **D9**, **D10**, **D25**, **D26**, **D27**, **D29**, **D30**. **D28 is WITHDRAWN** — ported from v1 unchanged by operator Q31. ⚠️ **D10 and D25 must land together.**

**The risk centre.** Most code, most money, most tests (33 in v1).

**Routes:** `GET|POST|PATCH /api/loan`, `GET|PATCH /api/loan/<id>`,
`POST /api/loan/<id>/<paymentProjection|refinance>`.

**Scope** (from `services/loan.py`)
- **Rate table:** `≤6 → 0.015`, `7–12 → 0.020`, `13–24 → 0.022`, `25–36 → 0.025` monthly.
  `timelimit > 36` **clamped to 36** silently, before the rate lookup. Commit `a45c343`
  changed this recently — port the *current* table. ⚠️ **The clamp is v1's behaviour and is
  SUPERSEDED by D4** — operator **Q9** decided `timelimit` outside `1–36` is a **400**, so v2
  rejects `37` where v1 returns `201` with `timelimit == 36` (v1's `test_post_loan_5` asserts
  the clamp; that test is a *moved expectation*, not a spec).
- **Quota check** on create: reject if `value > available_quota`, **unless** `refinance=True`.
- On create: always web-push to roles `[0, 2]`, target `/loan/<id>`.
- **Approval (`state → 1`)**, atomic: build the HTML amortization table, create `LoanDetail`,
  set `prev_loan.state = 3` if refinancing, send `CHANGE_STATE_LOAN_APPROVED` to the borrower
  with roles `[0,2]` **BCC'd**, return the serialized `LoanDetail`.
- **Denial (`state → 2`)**: `CHANGE_STATE_LOAN_DENIED`; clear `prev_loan.refinanced_loan`.
- **Payout (`state → 3`)**: remove scheduled `payment_reminder` tasks (v1's method name
  `remove_sch_notitfications` carries a typo; v2 may rename).
- **Interest math:** `((balance * rate) / 30) * days360(from, to)`.
- `payment_projection(loan_id, to_date)`.
- `refinance_loan`: **own APPROVED loan only**; new value = `capital_balance` (+ interests if
  `includeInterests`), `payment = 2` (REFINANCED), links both directions.
- **`bulk_update_loans`** (PATCH, multipart TSV), atomic: upsert each `LoanDetail`, schedule
  **two** `payment_reminder` notifications per loan (T−5d, T−1d), then **auto-close any
  still-APPROVED loan whose id was absent from the file**. Highest-consequence implicit rule
  in the codebase — a malformed upload closes real loans.
- Listing: `page`, `state` (0–4, **4 = all**), `all_loans` (roles ≤ 2 only), `paginate`.
  Order `-created_at, -id`.
- ⚠️ **`timelimit` has no lower bound.** `timelimit = 0` is accepted at create and then crashes
  at approval with a `DivisionByZero` in `__generate_table`. Add validation (§5 D4).

**Risks**
- ⚠️ Rounding — compounds Phase 0's half-even decision over up to 36 rows.
- ⚠️ `days360` edges: last-day-of-month, the 30/31 rule, negative ranges (v1 swaps and returns
  a positive count).
- ⚠️ **Auto-close blast radius, and it is not cleanly reversible.** The candidate set is
  *every* APPROVED loan in the fund. Recovery is broken in v1: `LoanDetail.loan` is a plain
  `ForeignKey`, not `OneToOne`, so setting a wrongly-closed loan back to state 1 creates a
  **second** `LoanDetail` row, after which `LoanDetail.objects.get(loan_id=id)` raises
  `MultipleObjectsReturned` and `GET /api/loan/<id>` returns 500 **permanently**. Two sub-cases:
  a *well-formed but incomplete* file commits and closes the omitted loans; and a loan approved
  **after** the treasurer generated the file is absent by construction and gets closed.
  v2 should make `loan_id` unique on `LoanDetail` (upsert, not insert) so recovery works — §5 D6.
- Decimal `rate` (5,3) must never become a float.

**Parity criteria**
- For ≥20 loans (varying timelimit, fee type, dates spanning month/year ends): `LoanDetail`
  rows identical **field for field**, approval email HTML byte-identical.
- Same TSV → identical upserts, identical set of auto-closed ids, identical `SchedulerTask`
  rows (dates, payloads, count).
- Refinance chains: identical `prev_loan` / `refinanced_loan` linkage both directions.
- Quota rejection and the `>36` clamp match exactly.
- Pagination envelope and ordering identical, including `state=4` and out-of-range pages.

---

### Phase 5 — Activities

**§5 rows this phase owns:** **none.** Determined mechanically, not assumed: the register's `Phase` column contains **no `P5` entry** (`grep -c '| P5 |'` → 0; the column reads P0 ×1, P1 ×1, P3 ×9, P4 ×10, P6 ×2, P7 ×1, plus the four cross-cutting rows D21–D24, which apply here as everywhere). A phase brief for Phase 5 that cites a §5 row is citing something that does not exist.

**Routes:** `GET|POST /api/activity/year`, `GET|POST /api/activity/year/<id_year>`,
`GET|PATCH|DELETE /api/activity/<id>`.

**Scope**
- `POST /api/activity/year` (role ≤ 1): create the **current-year** `ActivityYear` and
  **disable the previous one**.
- `POST /api/activity/year/<id_year>` (role ≤ 1): create an activity and attach **all active
  users** via `ActivityUser` (state `0 NOT_PAID`).
- `PATCH /api/activity/<id>?patch=activity|user` — two distinct update paths.
- `DELETE` (role ≤ 1).

**Risks:** low. The active-user set must match v1's definition (`is_active = true`) exactly,
and the year-rollover disable is a once-a-year path that's easy to break and hard to notice.

**Parity criteria:** identical `activityyear` / `activity` / `activityuser` row sets;
identical previous-year `enable` flip; both `patch=` modes identical.

---

### Phase 6 — Saving accounts (CAPs)

**§5 rows this phase owns:** **D12**. **D3 is WITHDRAWN** (operator Q22/Q23).

**Routes:** `GET|POST|PUT /api/saving-account` (GET/POST role ≤ 3, PUT `[0,2]`).

**Scope**
- Create, list (`state` 0–1, `all_accounts` for privileged, `paginate`), `PUT { id, state, value }`.
- `UserFinanceSerializer.total_savingaccounts` sums **active** accounts — a Phase 3 response
  field this phase's writes feed. Re-verify the Phase 3 parity report after this lands.

**Business rules — now specified by the operator (Q19–Q24), no longer inferred:**

- A CAP is a **fixed-term deposit that earns no interest and no return** (Q19). The fund only
  tracks it. Nothing accrues; there is no rate anywhere in this module.
- `value` on `PUT` is the **new total balance**, a plain replacement — not a deposit to add
  (Q21). This matches v1.
- **Only ADMIN and TREASURER may act on CAPs** (Q22); PRESIDENT is deliberately excluded
  (Q23). v1's `[0,2]` rule is correct as written — see the withdrawn D3.
- **No member notification** on close or revalue (Q22).
- **CAP balances are purely informational** (Q24): `total_savingaccounts`
  (`serializers.py:32`) is display-only and affects **neither `total_quota` nor
  `contributions`**. State this explicitly in the v2 code — it contradicts the natural reading
  and is the kind of thing a future maintainer will "fix" by accident.
- **CAPs close automatically on `end_date`** (Q20) — see **D12**. This is the one piece of new
  functionality in the phase; v1 has the `# TODO` and never built it. It requires a scheduler
  task type, which is why this phase runs **after** Phase 7.

**Risks**
- ⚠️ **v1 has no tests for this module at all.** No `test_saving_account_views.py` exists.
- ⚠️ **D12 is new functionality, so it has no v1 behavior to be parity-checked against.**
  Everything else in this phase is a port; the auto-close must be specified and tested on its
  own terms. Confirm the intended edge cases with the operator when it is built: what happens to
  a CAP whose `end_date` is already in the past when the feature ships, and whether closing is
  driven at the 10:00 or 14:00 scheduler run (or both).
- ⚠️ Still the module with **zero inherited tests** — the rules above are the spec now, so write
  the suite from them rather than from v1's behavior alone.

**Parity criteria:** identical rows on create/update; identical list envelope and filtering;
`total_savingaccounts` identical in the user finance response after each mutation.

---

> ⚠️ **Consequence of the C4 timezone finding, recorded here because it lands in this phase:**
> `scheduler/tasks.py:15-18` compares `datetime.now()` against `run_date__year/month/day`
> lookups. Those agree **only because** Django's `tzset()` makes the process zone Bogotá. v2 must
> anchor "today" in `America/Bogota` explicitly — inheriting the host zone would make the
> scheduler silently skip or double-run tasks around midnight.

### Phase 7 — Scheduler (replacing Celery beat)

**§5 rows this phase owns:** **D7**.

> ⚠️ **Split into 7a and 7b (v2.2), because Phases 3 and 4 *write* the rows Phase 7 runs.**
> Review finding **S9**, condition **C24**. v1's call sites are
> `services/user.py:281-282` (`PATCH /api/user/<id>` — Phase 3) and `services/loan.py:107,314`
> (loan payout and bulk update — Phase 4), both of which precede this phase in the sequence.
>
> * **7a — ✅ DONE, landed with Phase 3** (`af596b0`): `SchedulerTaskRepository` (the second and
>   last raw-SQL hstore repository), `NotificationService.scheduleNotification` /
>   `removeSchNotifications`, the hstore encoding, and the same-day dedupe rule. Its parity
>   criterion is a **data** comparison against the 632 live rows, not an execution one — see
>   C24 in §7.
> * **7b — this phase**: the cron runner, the executer factory, `repeat` cloning, and the
>   multi-instance claim. Everything under *Scope* below **except** the last two bullets, which
>   7a already covers.

> **Resequenced (v0.3): run this directly after Phase 4, before Phases 5/6.** It is the sole
> delivery path for loan payment reminders, has **zero** inherited tests, is raw-SQL hstore
> territory, and fails **silently** — `scheduler/tasks.py:scheduler` marks a task `processed`
> after `executer.run()` returns while `send_notification` swallows errors, so a failed publish
> is recorded as success. Highest ratio of consequence to coverage in the migration.

**Goal:** retire the Celery worker + beat containers.

**Scope**
- Replace `celery -A api beat` with `@nestjs/schedule` (or BullMQ on the existing Redis if
  multi-instance safety is wanted — decide in this phase).
- Cron: **10:00 and 14:00 `America/Bogota`**, matching `crontab(minute=0, hour='10,14')`.
- Loop: load today's unprocessed `SchedulerTask`s → resolve executer by `type` → run → mark
  `processed = true` → `create_repeat_instance` clones the row forward by `repeat`
  (NONE/DAILY/WEEKLY/MONTHLY/YEARLY, `relativedelta` semantics — month-end arithmetic differs
  between libraries, pin it with tests).
- `NotificationExecuter` (type 0) → `send_notification(...)`. `payload['user_ids']` is
  `json.loads`-ed out of hstore's string storage (§2).
- ✅ *(7a, done)* `schedule_notification(run_date, payload, repeat)` dedupe: **skip if an
  unprocessed task with the same `owner_id` + `type` already exists that calendar day.**
  ⚠️ `run_date__year|month|day` extracts `AT TIME ZONE 'America/Bogota'` under `USE_TZ`, not
  UTC — a UTC extract defeats the dedupe for every task scheduled after 19:00 local.
- ✅ *(7a, done)* `SchedulerTaskRepository` — raw SQL for the hstore `payload` column.
  ⚠️ Its write methods take an **optional transaction client**: `__update_user_personal` calls
  both of them inside `transaction.atomic()`, so a failed profile edit must take the scheduler
  rows with it.

**Risks**
- ⚠️ **hstore + zero inherited coverage.** No v1 scheduler tests exist *and* this is raw-SQL
  territory. **Extra integration tests required** — this is the weakest-covered subsystem in
  the migration.
- Multi-instance v2 needs a lock or an atomic claim
  (`UPDATE … WHERE processed = false RETURNING`), or tasks run N times.
- `relativedelta` month/year arithmetic on the 29th–31st.
- ✅ *Double-execution across v1 and v2 is no longer a concern* — the hard switch means beat
  and the v2 scheduler never run against the same DB in production. **Keep them from
  overlapping in the shared dev DB** during parity testing: run one at a time.

**Parity criteria**
- Given seeded `SchedulerTask` rows, v2 produces the same SQS messages and the same set of
  repeat-clone rows (dates especially) as v1.
- Dedupe rule verified: a same-day, same-owner, same-type schedule is skipped.

---

### Phase 8 — Files and admin

**§5 rows this phase owns:** none of its own; inherits cross-cutting **D22**/**D23** on the file upload, and **rule 12b** (do not narrow `FileView.post`'s parsers).

**Routes:** `GET|POST /api/file` (POST role ≤ 0), `GET /api/file/<id>`, `GET /api/admin` (role ≤ 0).

**Scope**
- GCS via `@google-cloud/storage`, bucket `fonmon`, object path `<type_display>/<name lower>`.
- `save_file`: **check `blob.exists()` first — only persist the `File` row if the blob did not
  already exist.**
- `get_signed_url`: **v4** signed GET, **5-minute** expiry.
- v1's `ENVIRONMENT == 'test'` anonymous-client branch → an injected storage client.
- `GET /api/admin?type=email|notifications` — self-test send. **No v1 tests exist.**

**Risks:** low. Signed-URL version and expiry must match; `display_name` is unique.

**Parity criteria:** same upload → same object path and `file` row (and **no** duplicate row
when the blob already exists); signed URLs valid, v4, 5-minute expiry.

---

### Phase 9 — Cutover, hstore→jsonb, decommission

**§5 rows this phase owns:** **TBD** — C39 opens the `_prisma_migrations` / `django_migrations` question, and D6's physical `UNIQUE (loan_id)` is deferred here.

**The user performs the cutover.** This phase delivers the runbook and the post-switch
migrations.

**Runbook (for the user)**
1. Freeze writes to v1.
2. Stop v1 containers: `api`, `worker`, `scheduler`, `sch_work` (`scripts/run-server.sh`).
3. Deploy v2; point DNS/proxy at it.
4. Smoke-test the Phase 1 role matrix and one loan approval end to end.
5. Rollback = re-point at v1, **valid only until step 6 runs.**

**After the switch — v2 owns the schema**
6. **hstore → jsonb migration** (v2's first owned schema change; Q7). Two columns:
   `notificationsubscriptions.subscription`, `schedulertask.payload`.
   - `ALTER COLUMN … TYPE jsonb USING hstore_to_jsonb(…)`, **plus a data-repair pass** — the
     doubly-stringified values (`user_ids`, the push-subscription `keys` object) come out as
     JSON strings containing JSON and must be unwrapped. Not a one-liner.
   - Then delete the hstore codec, drop the two raw-SQL repositories to normal Prisma models,
     and simplify Phases 2 and 7. **This is the payoff for choosing Prisma — do not skip it.**
   - ⚠️ **One-way door:** Django's `HStoreField` breaks the instant this runs. Rollback to v1
     is dead after step 6. Take a backup first.

**Post-migration cleanup backlog** (not during the migration)
- `refinanced_loan` from a bare BigInteger to a real FK.
- DRF token → JWT.
- `CORS_ORIGIN_ALLOW_ALL = True` → an allowlist.
- Django pbkdf2 hashes → argon2, rehash-on-login.

**Archive v1:** keep CONTEXT.md, the Django migrations, and the test suite as the historical spec.

---

## 4. Cross-cutting parity rules

Verified in every phase's parity report, not just the phase that introduces them.

1. **Response shape.** Pagination is always `{ list, num_pages, count }`; a page beyond the
   last returns an **empty list, same envelope, HTTP 200**. **v1's *view*-level errors** are
   `{ message: "<string>" }` with v1's exact strings, in Spanish where v1 is Spanish — but
   **DRF's *framework*-level errors are `{"detail": …}`**, and that includes **405**, not just
   401/403. Two different envelopes; see `docs/phase-1-drf-auth-bodies.md`.
2. **Status codes.** v1's specific choices (`406`, `409` where a modern API would use `400`
   or `422`) are **preserved**. Do not modernize.
3. **Default deny.** Any route without an explicit role rule is denied.
4. **Money is integer whole units.** No floats on a money path. Rounding uses the Phase 0
   half-even helper.
5. **Timestamps.** `auto_now` / `auto_now_add` are application-set in v1, not DB defaults — v2
   must set them. ✅ **RESOLVED (v0.14) — the answer is Bogotá, and it was worth checking.**
   Django 2.2's `DateTimeField.pre_save` uses `timezone.now()` (a tz-aware instant), while
   **`DateField.pre_save` uses `datetime.date.today()`** — process-local, ignoring
   `settings.TIME_ZONE`. v0.12 inferred from that "so v1 probably writes UTC dates". It does
   not: `django/conf/__init__.py::Settings.__init__` ends with
   `os.environ['TZ'] = self.TIME_ZONE; time.tzset()`, so Django *makes* the process zone equal
   the setting. Verified on `Django==2.2.27` / CPython 3.9 with the container `TZ` unset (host
   zone UTC) at `2026-08-31T00:09Z` = `2026-08-30 19:09` Bogotá: `date.today()` returns
   `2026-08-31` before `django.setup()` and **`2026-08-30` after it**.
   **So `UserFinance.last_modified` and `LoanDetail.from_date` hold Bogotá dates, there are no
   next-day rows to reconcile, and the escalation to `business-analyst` is withdrawn.** v2 pins
   the zone explicitly in `todayForAutoNowDateField()` (`timezone.util.ts`) rather than
   inheriting it from the host, and uses `nowInstant()` for the `DateTimeField` half.
   ⚠️ Residual, recorded rather than guessed: v1's repo has no Dockerfile (the image is built
   by an out-of-repo `entrypoint_deploy` on the EC2 host), so the base image cannot be read
   from source. The result above holds for any image shipping tzdata — `python:3.9-slim` and
   `python:3.9-alpine` both do, both verified. Strip `/usr/share/zoneinfo` and `tzset()` cannot
   resolve the zone, Django does not raise, and `date.today()` silently falls back to UTC (also
   verified). That is the only scenario in which v1's stored dates are UTC.
5b. **Money is `BigInt` in Prisma — 17 columns — and `JSON.stringify(1n)` throws.** ✅ **Settled
   (v0.14):** a BigInt serialises as a **bare JSON number**, matching DRF's
   `IntegerField.to_representation`, via Express's `json replacer`
   (`src/common/http/json-bigint.ts`, installed by an `AppModule` provider). The reflex fix
   (`BigInt.prototype.toJSON = toString`) renders `"1000"` and is **wrong**. A value outside
   ±(2^53 − 1) throws rather than rounding. Do not re-litigate per DTO in Phase 3.
5d. ⚠️ **CPython `json.dumps` is not `JSON.stringify`.** Two differences, both live on the very
   first message: CPython uses `', '` / `': '` separators, and `ensure_ascii=True` escapes
   non-ASCII. Verified: Python emits `{"body": "…de cr\u00e9dito", "target": "/loan/1"}` where
   Node emits `{"body":"…de crédito","target":"/loan/1"}`. **Every** v1 notification body is
   accented Spanish, so this is not an edge case. Use `python-json-dumps.ts` (Phase 2) anywhere a
   payload must match v1 byte-for-byte — **Phase 7 publishes through the same path.** Same species
   as rules 5b and 5c: a plausible-looking standard-library equivalence that is not one.
5c. **Date formatting is not uniform in v1 — do not assume it is.** `LoanSerializer.get_created_at`
   calls `timezone.localtime` first (`serializers.py:88`); `UserFinanceSerializer.get_last_modified`
   does not (`:29`). A `formatDateEs()` that silently reads a `DateTime` as UTC is correct for
   `@db.Date` and wrong for `timestamptz`, and the type system does not distinguish them — so it
   yields the **next day's date for ~21% of every day**, passing in CI and failing in production
   against the byte-identical email criteria. ✅ **Done (v0.14):** `formatDateEs` accepts only a
   `PlainDate`, and the call site must choose `fromDateColumn(v)` (`@db.Date`) or
   `toBogotaDate(v)` (`timestamptz`). A `Date` is a compile error.
6. **Shared DB is a dev/parity concern only** (production is a hard switch). During parity
   testing v2 runs **no** schema migrations, and only one scheduler runs at a time.
7. **hstore values are strings.** Never write a native JSON object into an hstore column —
   until Phase 9 converts them.
8. **Side effects count as parity.** A phase passes only when DB rows, SES payloads, SQS
   messages, and `SchedulerTask` rows all match — not just the HTTP response.
9. **Idempotent under retry** where v1 was: subscription dedupe, blob-exists check, scheduler
   same-day dedupe.
10. ⚠️ **Django's `on_delete=CASCADE` is Python-side, not a DB cascade.** Verified: all 21 FKs in
    `fondodev` are `NO ACTION`. Reading `models.py` strongly suggests the opposite. **Phases 3–8
    must delete children explicitly inside the transaction** or hard deletes raise FK violations.
    The live case is `DELETE /api/activity/<id>` (Phase 5), which must remove `ActivityUser` rows
    first. Most other v1 deletes are soft (`is_active = false`), which masks this.
12c. ⚠️ **Files come from `request.files`, scalars from `request.body` — never merged.** DRF's
   `request.data` is a `QueryDict` **merged with** `FILES`, and that merge is the exact mechanism
   of **D23** (a scalar sent as a part with a `filename` is stringified to the filename). Do not
   implement the merge to "match v1". ⚠️ **But v1's `LoanView.patch` (Phase 4) and
   `FileView.post` (Phase 8) read `obj['file']` and only work *because* of it** — those handlers
   must read from `request.files` explicitly. Getting this wrong in Phase 4 breaks the bulk loan
   upload; getting it wrong the other way re-implements D23.
12b. ⚠️ **`@parser_classes(...)` on an `APIView` *method* is a no-op** — found in Phase 3 by
    probing the live v1, and it affects three handlers across three phases.
    `rest_framework.decorators.parser_classes` is written for **function**-based views: it sets
    the attribute on the decorated callable, and `APIView.dispatch` reads `self.parser_classes`
    from the **class**. So `UserView.patch` (`views/user.py:36`, Phase 3), `LoanView.patch`
    (`views/loan.py:49`, Phase 4) and `FileView.post` (`views/file.py:15`, Phase 8) all accept
    the **default** parser list, JSON included. Measured: `PATCH /api/user` with
    `application/json` is a **500** in v1 (the body parses to `{}` and `obj['file']` raises
    `KeyError`), not the 415 the decorator implies; `text/plain` is a 415 because it is outside
    the *default* list too. **Do not "restore" the narrowing in Phase 4 or 8.**

12. ⚠️ **Nest 404s where DRF 405s.** Django resolves the URL and *then* DRF raises
    `MethodNotAllowed`; Express has no route for an unmapped method at all. **Every controller in
    Phases 3–8 needs an `@All()` fallback** (`DrfException.methodNotAllowed()` is the reusable
    piece) or it will 404 where v1 405s. Note the `Allow` header lists *implemented* handlers — a
    different set from *permitted* ones.
    ⚠️ **Third clause, added v1.4 after finding F1:** `OPTIONS` is one of those methods, and on a
    DRF API it is **authenticated and permission-checked** like any other (rule 13). Express-side
    CORS helpers answer it in middleware — `app.enableCors()` answered *every* `OPTIONS` with a
    204 before the router, the guards and the `@All()` fallback, i.e. it silently disabled
    authentication on that verb. Only a **genuine preflight** (`Access-Control-Request-Method`
    present) may short-circuit. See `DjangoCorsMiddleware`.
    ⚠️ **And a corollary:** anything that shapes a response must be registered in `AppModule`,
    **never in `main.ts`** — every e2e suite builds the app from `AppModule`, so `main.ts` is
    unexercised. F1 lived behind a green test asserting the very behaviour it broke.
13. **`OPTIONS` is a real, authenticated, permission-checked method.** On a **guarded** view it
    is always a **403**: `list_permissions` has no `OPTIONS` key for any of the 14 views, so
    `APIRolePermission`'s bare `except` denies it for every role, ADMIN included. On the two
    views that clear `permission_classes` (`ObtainAuthToken`, `UserActivateView`) it reaches
    `APIView.options()` and returns `SimpleMetadata`'s four-key document — 164 and 172 bytes,
    reproduced verbatim in `src/common/http/drf-metadata.ts` (parity finding **F4**;
    deviation P1-D2 withdrawn). Authentication still runs first, so a broken token 401s there
    too. What v2 does **not** ship is the browsable API's HTML rendering under
    `Accept: text/html` — registered as **P3-D8**.
14. ⚠️ **v1's URL conf is part of the contract, and Express cannot express it.** Django resolves
    an ordered list of **anchored, case-sensitive** regexes *before* authentication; Express
    matches case-insensitively, non-strictly, and (since v5) without inline parameter patterns.
    v1's table is transcribed in `src/common/http/django-url-conf.ts` and enforced by
    `DjangoUrlResolverMiddleware` ahead of the guards. It is **fail-closed**: a path absent
    from the table cannot reach a controller.

    ⚠️ **Two sub-rules the round-2 parity run added, both cheap to reintroduce by accident:**

    * **The URL layer is two middlewares, at two depths.** `CommonMiddleware`'s `APPEND_SLASH`
      301 is 3rd in v1's `MIDDLEWARE`, *above* `corsheaders`; URL **resolution** happens in
      `BaseHandler`, *below* all eight. So a genuine preflight is a **301** on `/password_reset`
      and a **200** on `/nope/nope`. `DjangoAppendSlashMiddleware` (above
      `DjangoCorsMiddleware`) and `DjangoUrlResolverMiddleware` (below it) are that split;
      `AppModule.configure` carries v1's whole `MIDDLEWARE` list as a table and must keep it
      (finding N1).
    * **Django dispatches on the decoded `PATH_INFO`, Express on the raw target.** The resolver
      rewrites `req.url` to `escape_uri_path(PATH_INFO)` once the table has matched, so
      `POST /api%2Dtoken%2Dauth` reaches its controller as it does in v1 (finding N3). This
      requires the middleware to be mounted at `/`: under a wildcard mount Express trims and
      re-prepends the matched prefix, splicing the rewrite onto the raw path. Redirect
      `Location`s follow the same rule — `escape_uri_path(decoded)` + `iri_to_uri(query)`,
      never the request target (finding N2, `django-uri-encoding.ts`). **Adding a route in any phase means adding its v1 pattern**; a v2-only route
    (`/health`) is an explicit entry. This replaces the trailing-slash "rule" S7 asked for —
    v1 has no rule, only an inconsistent table (`^api/loan/?$` but `^api/loan/(?P<id>[0-9]+)$`,
    with `^api/activity/(?P<id>[0-9]+)/?$` the lone exception), so it is transcribed, not
    summarised.

    📋 **The full "adding a route" checklist is `docs/adding-a-route.md`** (review condition
    **C36**) — the URL-conf entry and its trailing `/?`, `@V1View`, the permission-matrix row
    and its default-deny, the `@All()` fallback and its `Allow` string, `@DrfNoRequestData()`,
    `readUploadedFile` plus rule 12c's no-merge and rule 12b's "do not narrow the parsers",
    and `DrfViewHeaders.renderers`. Each item carries a one-line why and a pointer to a
    working example. **Phases 4–8 start there.**

11. ⚠️ **All 21 FKs are `DEFERRABLE INITIALLY DEFERRED`** and Prisma cannot express it; the
    baseline SQL is hand-patched. Keep the patch on any future baseline regeneration — without it
    CI databases enforce FKs at statement time while production enforces at commit, so multi-table
    writes that pass locally fail in CI (or vice versa).

---

## 5. Deliberate deviations from v1 (the port-or-fix register)

> ⚠️ **§3 describes v1. §5 decides what v2 does. Where they disagree, §5 wins — by construction,
> because a registered deviation *is* a decision to diverge from the behaviour §3 documents.**
> A v1 unit test asserting the §3 behaviour is therefore not evidence for keeping it: under a
> deviation it becomes a **moved expectation**. This bit us on **D4** in Phase 4 — §3's "silently
> clamped to 36", v1's `test_post_loan_5`, and a paraphrase in my own dispatch brief all agreed
> with each other *against* operator **Q9**'s decided `400`. Two descriptions of v1 and a v1 test
> will always agree; that agreement carries no information about what v2 should do. **Check §5 and
> §9 before implementing anything §3 describes.**

**Why this section exists.** The parity contract in §4 says v1's behavior is the spec. Taken
literally that is wrong: the business-analyst review found authorization holes in v1 that a
faithful port would carry into a fresh codebase and re-bless as "correct". Every knowing
departure from v1 is registered here so that `manual-tester` reads a diff as **expected**, not
as a parity failure — an unregistered diff is still a failure.

**Each row needs a user decision before its phase can close.** My recommendation is in the last
column; none of these are mine to decide unilaterally, because each changes product behavior.

| # | v1 behavior | Change in v2 | Phase | Status |
|---|---|---|---|---|
| **D1** | `PATCH /api/user/<id>` is role ≤ 3 with **no ownership check**, and `__update_user_personal` writes `user.role` from the request body (`services/user.py:232`) — any member can make themselves ADMIN or set their own `total_quota`. | **Restrict** (Q15, Q25, Q25a). Rule below. | P1 decide / P3 implement | ✅ **Decided — fix** |
| **D2** | Approving a power request has no check that the caller is the requestee. | **Restrict** to the requestee (Q17). | P3 | ✅ **Decided — fix** |
| ~~**D3**~~ | ~~`SavingAccountView.PUT` is `[0,2]` with no ownership check; PRESIDENT uniquely excluded.~~ | **Withdrawn — v1 is correct.** Only ADMIN and TREASURER may act on CAPs and they legitimately manage any member's (Q22), so no ownership check is wanted; the PRESIDENT exclusion is **deliberate** (Q23). Port v1 unchanged. | P6 | ✅ **Withdrawn** |
| **D4** | `timelimit > 36` silently clamped to 36; `timelimit = 0` accepted, then `DivisionByZero` at approval. | **Reject with `400`** (Q9) — both bounds. Enforce `1 ≤ timelimit ≤ 36`; no silent clamp. | P4 | ✅ **Decided — fix** |
| **D5** | Power-approval email puts every member in `ToAddresses` with empty `Bcc`. | **Move to `Bcc`** (Q18). Recipient list stays every member (Q10) — only the disclosure is fixed. | P3 | ✅ **Decided — fix** |
| **D6** | `LoanDetail.loan` is a plain FK; re-approving a closed loan creates a second row and 500s that loan permanently. | Unique `loan_id`, upsert not insert. Now **belt-and-braces** behind D10, which blocks the transition at the source. | P4 | ✅ **Decided — fix** |
| **D7** | A payment reminder whose `run_date` has passed is **never sent** — the 5-day reminder is skipped entirely whenever the monthly file lands within 5 days of the deadline. | **Send immediately** on the next scheduler run instead of skipping (Q8). | P7 | ✅ **Decided — change** |
| **D8** | Bulk loan upload returns a bare `200` with no body. | **Return the list of auto-closed loans.** No cap on how many may be closed (Q3). ⚠️ Response-shape change — `manual-tester` must expect it. | P4 | ✅ **Decided — change** |
| **D9** | Re-approving an already-approved or closed loan is allowed and corrupts the record. | **Enforce legal state transitions** `0→1`, `0→2`, `1→3`, `1→2`; reject anything else (Q14). ⚠️ **Known asymmetry under concurrency (C51):** the transition write is a compare-and-set, so the loser of a race gets D9's 409 — which is the sequential answer for five of the six race pairs and **not** for `0→1` winning against a `0→2` loser, where sequential execution gives a **200** (from state `1`, `1→2` is legal). Registered and pinned by a unit cell, not fixed: the bounded re-read-and-retry that would close it changes behaviour on the money path. §5.1 of `docs/phase-4-deviations.md`. | P4 | ✅ **Decided — fix** |
| **D19** | `__create_birthdate_notification` (`services/user.py:269`) calls `.replace(year=today_year)` on the stored birthdate. `date(2000,2,29).replace(year=2026)` raises `ValueError`; `UserDetailView.patch` has no handler, so it **500s and `transaction.atomic()` rolls the whole edit back**. Checked 2026-08-31: **0 of 15 members have a 29 Feb birthdate**, so this is **latent** — it fires the day one is enrolled. | Clamp to 28 Feb or 1 Mar — decide which, then handle it deliberately. | P3 | ✅ **Fixed (P3)** — clamped to **28 Feb**, because `relativedelta(years=+1)` (and therefore Phase 7's own yearly clone of this task) puts it there; 1 Mar would leave the first notification a day after every repeat of itself. |
| **D21** | gunicorn 19.9.0's WSGI writer emits the **full entity body on a `HEAD` request** — verified on a raw socket on 11/11 routes, DRF and plain-Django alike, including the 404 handler. RFC 9110 §9.3.2 says a `HEAD` response MUST NOT have content, so **v1 is the non-conformant side**, and the cause is the WSGI server, not any application code. | Node's HTTP server suppresses the body. **Status is identical on 11/11 routes; `Content-Length` on 10 of 11** — the exception is the 404 handler (77 vs 23 bytes), which is **D13** — the only difference is the bytes after the headers, which every conforming client and every intermediary discards. | cross-cutting (all phases) | ✅ **Accepted — register, do not reproduce.** No fund client issues `HEAD`; reproducing it means making Node emit bytes it deliberately suppresses, to re-create a server-level RFC violation with no beneficiary. Parity finding **F9**. |
| **D22** | A **non-ASCII `boundary`** is an **uncaught 500** (**on the three POST endpoints**: gunicorn's 141-byte page, no `Allow`, no `Vary` — that page is a *double fault* via `log_response` → `get_post_parameters`. **`PATCH /api/user` differs**: Django's **27-byte** page **with `Vary: Origin`**, because Django populates `POST` only for `POST` — which is also why D24's bare-`except` scoping is correct): `MultiPartParser.__init__` does `content_type.encode('ascii')` at `multipartparser.py:69` *before* validating the boundary at `:72`, so a `UnicodeEncodeError` — not a `MultiPartParserError` — escapes DRF's exception handler. 49 cells across `/api-token-auth`, `PATCH /api/user`, `POST /api/user/activate/<id>`, `POST /api/user/power`. | **400** with DRF's parse-error detail, the same answer v2 gives for every other invalid boundary. Every **valid** boundary shape is unchanged and byte-identical (16/16, including the 201/202 length off-by-one). | cross-cutting — P3, and **P4 bulk loan upload / P8 file upload** | ✅ **Accepted — register, do not reproduce.** The request is malformed and refused on both stacks with **zero rows written on either**; only the shape of the refusal differs. No client can emit a non-ASCII boundary (the HTTP stack generates it, not the fund's code), so no member- or treasurer-facing process is affected. Reproducing it means writing a deliberately uncaught exception into v2 and alerting on it forever. **This row covers every multipart endpoint in Phases 4–8 — `manual-tester` must not re-file it there.** Parity finding **F10**. |
| **D23** | DRF's `request.data` is `QueryDict` **merged with** `FILES`, so a **scalar field sent as a part carrying a non-empty `filename`** is read as an `UploadedFile`. `create_user` reads `obj['first_name']` with no serializer (`services/user.py:31`) and Django's `CharField` stringifies the file to its **filename** — so `POST /api/user` with `first_name` as a part named `a.txt` is **201**, creates a member whose first name is `a.txt`, and **sends them the activation email**. Verified live: `auth_user` 15 → 16. | **No merge.** Files are read from `request.files`, scalar fields from `request.body`. A scalar sent as a file part is therefore *absent*, and `create_user` 500s with **no row** — which is v1's own behaviour for an absent required field (no serializer, no `KeyError` handler). The **empty-`filename`** rule (Django treats it as an ordinary field) **is** ported, and the treasurer's real TSV upload is byte-identical on both stacks. | cross-cutting — P3, and **P4 bulk loan upload / P8 file upload** | ✅ **Accepted — register, do not reproduce.** `first_name` is not an inert column: it is the activation-email greeting, the name in the fund-wide power-of-attorney letter, the birthday-notification body, and the member list. v1's row emails the fund and is repairable only by another ADMIN `PATCH`. `POST /api/user` is ADMIN-only and **no live row was ever created this way** (all 15 names are real). Implementing DRF's merge would implement the defect on purpose. **`readUploadedFile` reading `request.files` is the standing pattern for P4 and P8** — see §4 rule 12c. Parity finding **F11**. |
| **D24** | On the one Phase 3 view with a bare `except Exception` around a `request.data` read (`UserAppsView`), a `MultiPartParserError` is caught and answered as a DRF 500 — but Django's `log_response` then calls `get_post_parameters`, which re-reads `request.POST` and **re-triggers the same parser failure outside Django's exception handling**. The request never produces a Django response: gunicorn's 141-byte page is served with **no `Allow` and no `Vary`**, where the same view's other 500s carry both. Fires for the six boundary shapes v1 rejects × 12 bodies = 72 cells on `POST /api/user/power`. | The DRF caught-500 shape with `Allow: POST, OPTIONS` and `Vary: Accept, Origin` — i.e. the behaviour **F1 was fixed to produce**. Status is identical to v1 on all 208 malformed-multipart cells; only the header set on these six shapes differs. | cross-cutting — P3, and any later view with a bare `except` around a body read | ✅ **Accepted — register, do not reproduce.** `Allow`/`Vary` on an unparseable-request 500 are read by no client, and the trigger is unreachable from the fund's client. Reproducing it means porting Django's *error logger re-entering the failing parser* — a double fault that also hides the original traceback — and would partially un-fix **F1**. Residual of the **F1 / P3-D6** axis. Parity finding **F12**. |
| **D25** | `GET /api/user/<id>` is role ≤ 3 with **no ownership check** (`permissions.py:13-17`, `views/user.py:43-50`), so any member reads any other member's full `finance` block — including **`utilized_quota`** (their aggregate outstanding debt) and `total_savingaccounts` (their CAP deposits, computed in `serializers.py:32-35`). v1 hard-filters the *loan list* by role (`views/loan.py:33-41`) and returns **no** finance on the *user list* (`services/user.py:60-70`), so this by-id route is the only unscoped path to another member's money position — v1 is inconsistent with itself. | **Restrict** to the record's owner plus roles `[0,1,2]` — the **same predicate and roles as D10**. `GET /api/user/-1` is unaffected (owner branch). Profile-only lookup keeps working through the unrestricted list and `POST /api/user/birthdates`. | **P4 — must land in the same phase as D10** | ✅ **Decided — fix.** Operator **Q29a**: no client screen lets a member read another member's detail, so nothing breaks and **D10 is not reopened**. |
| **D26** | Nothing forbids `requester === requestee` on a power request (`services/user.py:165-192`). `requester` is always the caller, so no member can give away another's vote — but a member acting **alone**, with no second party's consent (which every other power requires under D2), can create then approve a power naming themselves and make the fund emit the formal power-of-attorney letter on **Fondo Montañez letterhead, addressed to the president of the assembly**, to all 15 members (blind-copied under D5). The document transfers no vote, so this is document emission, not vote manufacture. **Live 2026-09-03: 0 of 20 rows are self-directed** across six assemblies — verified. | **Refuse at creation** with **406**, matching v1's house style for a business-rule refusal on a create (`create_loan`). Refused at creation, not approval, so no row and no self-addressed push notification are produced. ⚠️ **No `(requester, meeting_date)` uniqueness rule is added.** | P4 | ✅ **Decided — fix.** Operator **Q30a**: a second request **superseding** the first is the fund's real idiom (live: member 14, rows 18 and 20, assembly 2026-01-31), so self-naming is *not* a revocation workaround and blocking it removes nothing in use. A uniqueness rule **would** break the idiom. |
| **D27** | `handle_power_request` writes `power.state` unconditionally and mails on `state == 1` (`services/user.py:193-206`), so **re-approving an already-approved power re-sends the fund-wide letter**, unbounded. Same defect class as D9 for loans; guarded in neither v1 nor the P3 port. | **Enforce legal transitions** `0 → 1` and `0 → 2`; any other transition is **409** with **no mail**. Mirrors **D9** (Q14) exactly. Re-sending a lost letter becomes an ops task, not an API state write. | P4 | ✅ **Decided — fix.** Needed no operator input. |
| **D29** | `create_loan` compares **before** coercing: `if obj['value'] > user_finance.available_quota` (`services/loan.py:27`) with `available_quota` a `BigIntegerField`. A JSON **string** `value` therefore raises `TypeError: '>' not supported between instances of 'str' and 'int'` — a **500 before any write**. Verified on both stacks: `"1000"`, `" 1000 "`, `"+1000"`, `"-1000"` are v1 500 / v2 201+row; `"30000001"` is v1 500 / v2 **406**. ⚠️ Same root cause on the **quota boundary**: v1 compares raw then coerces, so `value: 30000000.5` against a 30 000 000 quota is **406 on v1, 201 on v2**. | **Keep v2's coercion** — accepted improvement. v1's refusal is a crash, not a rule: the same string *stores* fine (`BigIntegerField.get_prep_value` is `int()`), `timelimit` is explicitly coerced on the very next line, and this is the **only** raw ordering comparison in v1's entire service layer (BA grepped every `obj[...]` comparison in `fondo_api/services/`). Porting it means writing a deliberate `TypeError` into v2. v2 gives the member the fund's real answer instead of a crash. A strict 400 was considered and rejected: `value` would become the only integer column in v2 with a non-Django contract while `fee`, `payment`, `disbursement_value`, `identification` and `total_quota` all coerce. ⚠️ **The *ordering* is a separate half and the operator decided it the other way: exact parity.** v2 now compares the **raw** value and coerces only for the write, via a new `pythonGreaterThan` beside Phase 3's `pythonNotEqual` — the sequencing `updateUserFinance` (`src/users/user.service.ts:777-781`) already used. So the fractional window is closed: `quota + 0.5` is **406 on both**. | P4 | ✅ **Decided — implemented, in two halves.** (a) **String leniency accepted** (v1's `TypeError` is a crash, not a rule): `"100"` is a 201, `"600"` the fund's real 406. Not a live defect — **277 direct creates by 13 distinct members, 2018 → 2026-08-10**, impossible if the client sent strings. (b) **Boundary ordering: exact parity**, at the operator's choice over accepting the sub-peso gap. ⚠️ The cell was **measured, not assumed**, as this row demanded: against the unfixed code, quota 500 + `value: 500.5` gave **201 with `value` stored as `500`** — v2 was not merely accepting where v1 refuses, it was writing a *different number*. Now 406, pinned in both suites. |
| **D30** | Nothing in v1 **or** v2 requires a loan `value` to be positive. As plain JSON *numbers*, `0` and `-1000` are accepted and written by **both** stacks. | **Add a lower bound at create.** Needs its own row precisely *because* v1 and v2 currently agree — without it the new 400 reads as a Phase 4 regression rather than a decision. Honestly scoped: **0 of 425** live rows have `value <= 0`, and the three smallest (ids 132, 198 at `1`; id 109 at `500`, all member 11) were **DENIED by hand**, so a floor of 1 would have caught none of them. | P4 | ✅ **Decided — implemented.** Operator: the fund has **no minimum loan amount**, so the floor is `value >= 1` as cheap insurance and nothing more. **400** `{"message": "Loan value must be greater than 0"}`, checked on the coerced value (so `0.5` → `0` is caught) after the quota gate (so an over-quota request is still v1's 406), and binding on the refinance path too. ⚠️ **This is v2 *diverging* from v1 by decision, not repairing a divergence** — both stacks accept `0` and `-1000` as plain JSON numbers today, so the cells and `docs/phase-4-deviations.md` §4.1 say "v1 accepts this, v2 refuses it by decision" in as many words, to stop a future parity round filing it as a regression. A stated fund minimum would replace `MIN_LOAN_VALUE`. ✅ **BA confirms the refinance binding needs no carve-out**: the fund would never refinance a fully-paid loan, and live data shows **148 refinances, smallest `value` 187 584**, with no APPROVED loan at `capital_balance <= 0`. 🔸 Nit for a later pass: the message `"Loan value must be greater than 0"` reads as nonsense on a route where the caller sent a **loan id**, not a value. |
| ~~**D31**~~ | ~~Allow `3 → 1` so a wrongly auto-closed loan can be re-opened through the API.~~ | ❌ **WITHDRAWN 2026-09-04 — operator declined.** D9's 409 stands: **PAID_OUT is terminal through the API**, and the fund's recovery procedure for a wrongly auto-closed loan is a **direct database repair** — now a *deliberate, recorded* procedure rather than an accident of D6 and D9 interacting. Weighed: the operator confirms an incomplete TSV has **never happened**, and the BA could find no forensic signature of a past one — `fondo_api_loan` has no `closed_at` and no state audit, and **336 of 345** PAID_OUT loans carry a positive `capital_balance` (verified), because omission from the next file *is* the normal payoff path. A closed loan still showing a balance is the norm, not a red flag. The BA recommended allowing it ADMIN-only; the operator chose the narrower option. ⚠️ The BA's rejection of `3 → 0` stands regardless and must not be revisited: re-running approval upserts `LoanDetail` at `capital_balance = loan.value`, discarding every month of TSV state and re-mailing 28 borrowers. | P4 | ❌ **Withdrawn — keep v1's terminal close** |
| ~~**D32**~~ | ~~Mail roles `[0,2]` when a TSV upload closes ≥ 1 loan.~~ | ❌ **WITHDRAWN 2026-09-04 — operator declined.** A mass close stays **silent**, exactly as v1 behaves: `update_loan` mails on state 1 and 2, and state 3 only calls `remove_sch_notitfications` (verified). The treasurer sees the closed ids in **D8's response body at the moment of upload** and nowhere else; nothing persists them. Recorded because the reviewer's m2 is right that **D8 is a capability, not a notice** — it helps only someone who reads that body — and because the operator has now chosen that knowingly. No member-facing mail either: nothing distinguishes a wrong close from a right one, so a member notice would fire on every month-end payoff. | P4 | ❌ **Withdrawn — close stays silent** |
| **D33** | ⚠️ **The partial self-heal — and with D31 withdrawn it is now the *only* thing that happens.** `__update_loan_detail` resolves by `loan_id` **alone, with no state filter** (`services/loan.py:286`), then unconditionally calls `__create_scheduled_task`. So a wrongly closed loan left in next month's TSV has its detail updated and its **T−5d / T−1d reminders re-created while it stays PAID_OUT** — the member is pushed payment reminders for a loan the fund records as paid, and still sees no balance. Separately, `refinance_loan` requires state 1 and answers a **zero-byte 400**, locking that member out of refinancing — **148 of 425 loans** are refinances (verified), a live fund process, with no explanation given. | **Ported unchanged.** v2 mirrors v1 exactly (`updateLoanDetail` resolves by `loan_id`; `scheduleNotification` fires from the TSV path only). Registered, not fixed, **because D31 was withdrawn**: with no re-open route this *is* the residual behaviour of a wrong close, and it must be findable by whoever performs the direct database repair. ⚠️ **That repair must also reconcile `SchedulerTask` rows** — `updateLoanDetail` may already have re-created reminders the close deleted. | P4 | ✅ **Registered — port; consequence of D31's withdrawal** |
| ~~**D28**~~ | ~~Block `finance` self-writes for TREASURER.~~ | ❌ **WITHDRAWN 2026-09-03 per operator Q31.** A TREASURER approving **their own loan** is accepted fund practice — `LoanDetailView.patch` is `[0,2]` and `update_loan(id, state)` never receives the actor's id (`services/loan.py:79`), so there is no ownership check to fail. Blocking the smaller self-write while the larger self-approval stays open is incoherent, and **m6 is accepted with it** (consistent with Q12). **Both port from v1 unchanged.** The accepted exposure, recorded so Phase 4 carries the cell *deliberately*: the treasurer can raise their own `available_quota`, pass `create_loan`'s check (`services/loan.py:26-28` — the fund's **only** quota enforcement), and approve the result. Live: the TREASURER is user 2 at **20 343 105 of 30 000 000** — *second*-largest borrower, not largest (user 6 holds 25 871 634; the BA note said otherwise and was wrong). See `docs/operator-q29a-q30a-q31.md`. | P4 | ❌ **Withdrawn — port v1** |
| **D20** | The same handler calls `user_ids.remove(user.id)` on a list from `get_users_attr("id")`, which filters `is_active=True`. Editing a **soft-deleted** user raises `ValueError` → 500 → full rollback. ⚠️ Checked 2026-08-31: **`fondodev` has 2 inactive users, so this is triggerable today.** | Guard the removal. | P3 | ✅ **Fixed (P3)** — the removal is guarded; an admin can now edit a soft-deleted member's profile. |
| **D18** | Request-parsing divergences found in Phase 1 review: `text/plain` → v1 **415**, v2 400. `multipart/form-data` → v1 **200**, v2 400. Malformed JSON → v1 `{"detail":"JSON parse error - …"}`, v2 Node's message. | ✅ **Fixed, all three — no deviation taken.** v2 owns request parsing (`DrfRequestParsingMiddleware` + `DrfParserInterceptor`, `bodyParser: false`): multipart parses, an unsupported media type is DRF's **415**, and a malformed JSON body returns CPython's own message and character offset (`python-json.ts`, differentially validated against CPython 3.9 over 412 structured + 3 000 fuzz cases, 0 mismatches). Parsing is deferred until **after** the guards, so DRF's authenticate-then-parse ordering is preserved. Three residuals registered in `docs/phase-1-drf-auth-bodies.md`, none client-visible. | P1 | ✅ **Fixed** |
| **D14** | `PATCH /api/user/-1` and `DELETE /api/user/-1` pass `-1` through and 404; only `GET` substitutes `request.user.id`. | **Split by verb** (BA). GET keeps "me". PATCH **adopts** "me" — v1 404s unconditionally, so no working client can depend on it; the change is inert but stops telling a member they don't exist. DELETE **rejects the sentinel**: `fondodev` has exactly **one** ADMIN, and self-soft-delete is unrecoverable through the API (`key_activation` is null for all 15 users, so `activate_user` can never restore them). | P3 | ✅ **Decided — fix** |
| **D15** | `__update_user_personal` does `user.username = obj['email']`, rotating the name the member logs in with. | **Stop writing `username` on personal updates.** Login names become stable. See the runbook item below — the live behavior is *worse and narrower* than "silent rename". | P3 | ✅ **Decided — fix** |
| **D16** | `identification` is writable by any caller on a `personal` update. | ✅ **Decided (Q26): ADMIN-only.** It is the join key of the treasurer's monthly TSV and a miss is only logged (`services/user.py:144`), so a member editing their own cédula **silently freezes their own contributions and quota** until someone notices. ⏳ **Needs operator confirmation.** | P3 | ✅ **Fixed (P3)** — ADMIN-only, gated on an actual change. |
| **D17** | `get_user_by_email` (`services/user.py:84`) uses `.get()` inside a bare `except`, so a duplicated email raises `MultipleObjectsReturned` → returns `None` → **no reset email is sent**, while `PasswordResetView` still redirects to the success page. | **Verified live: users 7, 10, 13 and 14 — 4 of 15 members — cannot reset their password and are told it worked.** v2 must handle multiplicity deliberately. ✅ **Decided (Q27): the link goes to the account whose `username` equals the email** — so `criss9413@hotmail.com` resets id 7 (the parent), not id 14 (Ainhoa); `mhjc123@hotmail.com` resets id 10, not id 13. The two child accounts are admin-assisted reset only. Fixes the current silent failure for all four members. | P3 | ✅ **Decided — fix** |
| **D13** | An unknown URL returns Django's **HTML** 404 page (`<h1>Not Found</h1>…`), not JSON. | v2 returns JSON `{message: …}`. Pre-existing since Phase 0 but was unregistered — `manual-tester` would otherwise file it. Accepted: no client depends on an HTML 404. | P0 | ✅ **Accepted** |
| **D12** | CAP auto-close was never implemented — `services/saving_account.py` carries a `# TODO: schedule task for closing CAP`. Closing is manual-only today. | **Implement it** (Q20): a CAP closes automatically on `end_date`. New functionality, not a port. Needs a `SchedulerTask` type — **so Phase 6 depends on Phase 7** (already sequenced that way). No member notification (Q22). | P6 | ✅ **Decided — build** |
| **D11** | `UserFinance.user` and `UserPreference.user` are plain FKs, not OneToOne — the same latent defect registered as D6 for `LoanDetail`. A duplicate row makes the user's finance endpoints 500 permanently. | Unique constraint on `user_id` for both; upsert not insert. | P3 | ✅ **Decided — fix, in two halves.** The application half shipped in P3 (deterministic lowest-id reads, so a duplicate row degrades to "ignored" instead of a permanent 500). ⚠️ The **physical `UNIQUE (user_id)` moves to Phase 9**: §4 rule 6 forbids v2 running migrations against a database v1 shares. Nothing in v2 can create a second row. |
| **D10** | Loan read (`GET /api/loan/<id>`, `paymentProjection`) is open to any member by id. | **Restrict** to the loan owner plus roles `[0,1,2]` (Q16). | P4 | ✅ **Decided — fix** |

**Phase-local deviations** — the ones that only exist because of how a phase was
implemented — live in that phase's `docs/phase-<n>-deviations.md`, not here. Phase 3 registered
seven (**P3-D1**–**P3-D7**), of which three change an observable response: **P3-D2** (a
duplicate email on a personal update is now a 200, not a 409 — the 409 came from the `username`
write D15 removed), **P3-D3** (no `django_session` row and no `sessionid` on the reset hop) and
**P3-D6** (a zero-byte 500 where Django renders its HTML error page — D13's species, extended).

### D1 — the authorization rule for `PATCH /api/user/<id>`

**Principle: universal self-service, with privileges added on top.** Every role may edit its own
`personal` (excluding `role`) and `preferences`. Elevated rights are additive:

| Role | Own profile | Other users | `role` field | `finance` section |
|---|---|---|---|---|
| **0 ADMIN** | ✅ | ✅ any user, any section | ✅ **only ADMIN** | ✅ any user |
| **1 PRESIDENT** | ✅ personal + preferences | ❌ | ❌ | ❌ |
| **2 TREASURER** | ✅ personal + preferences | `finance` only | ❌ | ✅ any user |
| **3 MEMBER** | ✅ personal + preferences | ❌ | ❌ | ❌ |

- PRESIDENT gets **no elevated rights** here (Q25) but keeps self-service (Q25a) — the literal
  reading would have made role 1 less capable than role 3.
- ⚠️ **Inference, flagged:** Q15 said "treasurer only can modify finance information." Applying
  the same principle that resolved Q25a, TREASURER **also keeps self-service** on their own
  personal + preferences. Without that they could not change their own email address. Say so if
  that is wrong — it is the one cell in this table the operator did not state directly.
- `role` is writable by ADMIN alone, on any user. This is the escalation path being closed.
- A `finance` write by a non-privileged caller is **403**, not a silent no-op.

**Two clarifications that each would otherwise break every ordinary member save** (BA, `docs/ba-phase-3-decisions.md`):

1. ✅ **The `role` check compares values, it does not check presence.** v1's client echoes the
   whole `personal` object back from `GET /api/user/<id>` — which includes `role` — so a
   "`role` key present and caller is not ADMIN → 403" reading would 403 **every save by all 14
   non-admin members**: 100% false positives, a signal nobody would keep. Compare the submitted
   value against the stored one and 403 only on an actual **change**. A 403 then means a real
   escalation attempt and is worth logging. Accepted side effect: a stale client submitting an
   out-of-date `role` gets a 403 — correct, since the alternative is silently demoting a freshly
   elected treasurer.
2. ✅ **Authorization keys off `body.type`, not off which sections are present.** `update_user`
   dispatches on `obj['type']` (`services/user.py:100`) and ignores the rest. Every v1 test
   fixture posts `personal` **and** `finance` in the same body, so a presence-based finance check
   would 403 every member profile save. Gate on the declared `type`.

**Explicitly confirmed as intended — port faithfully, do not "fix":**

- **Loan auto-close is a real business rule** (Q1) — absent from the monthly TSV means paid off.
  It stays **silent**: no email, no push. And no guard against closing a loan approved after the
  file was generated (Q2) — the operator accepted that risk.
- **Rate frozen at request time** (Q4), so a loan awaiting approval across a rate change is
  approved at the old rate.
- **Quota comes exclusively from the treasurer's monthly file** (Q12, reconfirmed). Loans do **not** increment
  `utilized_quota` on create or approval. ⚠️ Known and accepted consequence: a member can open
  several loans between uploads that together exceed their quota.
- **Multiple concurrent refinance requests against one loan stay allowed** (Q5), including the
  broken linkage that follows.
- **Payment reminders are best-effort** (Q6, reconfirmed) — a failed publish is marked processed and lost, with
  no retry on the next scheduler run. *Note: the in-call bounded retry (Phase 2, condition 1) is a
  different mechanism and is still planned — say so if you want that dropped too.*
- **Push only; no email fallback for reminders** (Q7). Members without a browser subscription
  receive no payment reminders — accepted.
- Also unchanged: the deny-on-lookup-miss permission fallthrough; the `406`/`409` status choices;
  the pagination envelope; the rate table itself; "attach all active users"; and CAP-balance /
  quota independence.

---

## 6. Test porting

v1 has **104 test methods** across 8 files (the 20 Alexa tests are dropped):

| v1 file | Tests | v2 destination |
|---|---|---|
| `test_date_utils.py` | 2 | Phase 0 |
| `test_models.py` | 8 | Phase 0 (model round-trip) |
| `test_mail_service.py` | 6 | Phase 2 |
| `test_notification_views.py` | 4 | Phase 2 ⚠️ thin |
| `test_user_views.py` | 31 | ✅ Phase 3 — all 31 ported (`test/user.e2e-spec.ts`, 84 cells; four expectations moved by D15/D2 and each says so) |
| `test_loan_views.py` | 33 | Phase 4 |
| `test_activity_views.py` | 12 | Phase 5 |
| `test_file_views.py` | 8 | Phase 8 |
| — | **0** | **Phase 6 (saving accounts), Phase 7 (scheduler), admin endpoint** |

- `AbstractTest` helpers (`create_user`, `create_basic_users`, `get_token`, `get_auth_header`)
  become a shared e2e fixture module.
- **3 methods are prefixed `pending_test_`** (2 in `test_models.py`, 1 in
  `test_notification_views.py`) and never run in v1. Read them for intent, then decide per
  case whether to revive or drop — do not silently port them as passing tests.
- v1 mocks external I/O at the boundary (`@patch('boto3.client')`) and asserts full SES
  payloads. Keep that shape: mock the AWS/GCS SDK clients, assert the whole payload.
- ⚠️ **Coverage debt concentrates in Phases 6 and 7** — and Phase 7 is also raw-SQL hstore
  territory. Budget extra time for both.

---

## 7. Phase gate checklist

A phase closes only when all four are green. Any ✗ re-opens the phase and revises this plan.

| # | Owner | Criterion |
|---|---|---|
| 1 | `nestjs-developer` | Endpoints, services, DTOs implemented; unit + integration tests ported and green; lint and typecheck clean. |
| 2 | `manual-tester` | Parity report **PASS** against v1 on the shared dev DB — responses, status codes, DB side effects, SES/SQS payloads, scheduler rows. |
| 3 | `nestjs-reviewer` | Code review approved, **and** the parity report reviewed for missing business scenarios. Also enforces the §2 rule that hstore raw SQL stays inside the two repositories. **Standing requirement — see below.** |
| 4 | `business-analyst` | Phase alignment note = **Aligned**. |
| 5 | *user* | Every §5 deviation owned by this phase is **decided** (port or fix) and recorded. An undecided deviation blocks the gate; an unregistered behavioral diff is a parity **failure**. |

### The full pipeline is standing, from Phase 2 to the end

Every phase from Phase 2 onward runs all three roles **in sequence**, each gating the next. A
phase does not advance on the previous role's optimism.

```
nestjs-developer  ──►  manual-tester  ──►  nestjs-reviewer  ──►  phase closed
  implements +          parity report        code + parity
  ports tests           vs v1 on the         review, explicit
                        shared fondodev      verdict
       │                     │                     │
       └── sign-off ─────────┴── sign-off ─────────┘
```

- **`manual-tester` runs before the reviewer, not after.** It exercises both APIs against the
  shared `fondodev` and reports observable differences: response bodies, status codes, DB side
  effects, SES payloads, SQS messages, scheduler rows. A **PASS** is required to proceed.
- **`nestjs-reviewer` reviews the parity report as well as the code**, hunting business scenarios
  missing from *both*. Its verdict closes the phase.
- **`business-analyst`** remains gate 4, and is also invoked on demand whenever a business rule
  is ambiguous — it has already changed this plan four times.
- A failure at any stage returns the phase to `nestjs-developer`; the sequence restarts there.

Phases 0 and 1 closed without a `manual-tester` pass (`n/a` on the board) because they ship no
business endpoints — there was nothing to compare. **Phase 2 is the first with observable
behaviour, and the first to run the full sequence.**

### The review gate is standing, not optional

**Every phase ends with a `nestjs-reviewer` pass.** No phase closes without one, including phases
that look mechanical. The reviewer:

- writes `docs/review-phase-<n>.md`, findings ordered blocking / should-fix / consider, each with
  `file:line`, what is wrong, why it matters, and what to do;
- ends with an explicit verdict: **Approved**, **Approved-with-conditions**, or
  **Changes-required**;
- reviews the `manual-tester` parity report as well as the code, looking for business scenarios
  missing from both;
- enforces §2's rule that raw SQL touching `hstore` appears **only** inside
  `NotificationSubscriptionRepository` and `SchedulerTaskRepository`.

A **Changes-required** verdict re-opens the phase. Conditions attached to an
**Approved-with-conditions** verdict are tracked to closure before the next phase's gate, not
silently carried forward.

Rationale: the two corrections that mattered most so far — the `username != email` lockout and
the Babel four-digit grouping — were both cases where a plausible-looking assumption survived
until someone read the source or the live data. That is exactly what a review pass is for, and it
is cheapest at the end of the phase that introduced it.

### Phase 2 review conditions (C19–C27)

From [`docs/review-phase-2.md`](docs/review-phase-2.md). Graded by deadline, not severity.

**Before Phase 3's first controller:**

| # | Condition |
|---|---|
| **C19** | ⚠️ **S3 — `ALLOWED_HOSTS` is dropped.** The `CommonMiddleware` port omits the one part that is not a no-op. Measured live: `Host: evil.test` → v1 **400** on every route, v2 serves. Confirmed: production sets `ALLOWED_HOSTS = [ALLOWED_HOST_DOMAIN, '127.0.0.1']` (`api/settings/production.py:13`), and Phase 3's `PasswordResetView` builds the emailed link's domain from `get_current_site(request)` (`views/auth.py:37-42`). **In Phase 3 this becomes reset-link poisoning: an attacker sets the `Host` header and the victim's reset token is delivered to a domain they control.** Fix before any Phase 3 route ships. ✅ **Closed.** `DjangoAllowedHostsMiddleware` + `django-allowed-hosts.ts` port `get_host` / `split_domain_port` / `validate_host` / `is_same_domain` from the installed Django 2.2.27 — the leading-dot wildcard, `*`, the port and trailing-dot stripping, the bracketed-IPv6 branch, the `if domain and …` guard and the `DEBUG`-with-empty-`ALLOWED_HOSTS` fallback, each pinned against a measured live-v1 status. Registered at slot 3 **above** the `APPEND_SLASH` port, where `CommonMiddleware.process_request:47` calls it, so the 400 precedes the CORS preflight, the 301 and the resolver. `ALLOWED_HOST_DOMAIN` added to `env.schema.ts` (optional and untrimmed, reproducing v1's `[None, '127.0.0.1']`). Body is `{"message":"Bad Request"}` per D13; `X-Forwarded-Host` and the `SERVER_NAME` fallback registered as **P2-D9**. 22 unit + 17 e2e regression cells. |
| **C20** | **S2 — the URL table resolves paths, never views**, and `roles.guard.ts:66` trusts Express declaration order. v1's four `/api/user/…` routes have different rules — `UserAppsView` declares only `POST` (so `DELETE` is deny-all via the bare `except`) while `UserDetailView.DELETE` is ADMIN-allowed. A mis-resolution turns a routing detail into an **authorization** decision. Bind the resolved v1 view identity, not the path. ✅ **Closed.** `DjangoUrlResolverMiddleware` now publishes the matched pattern as `request.djangoRoute`, and `RolesGuard` authorises on **that** view. `DjangoUrlPattern.view` is narrowed from `string` to `V1ViewName | UnguardedV1View | null`, so the table and `list_permissions` are linked at compile time. Three fail-closed outcomes: no `@V1View` → 403 (v1's `KeyError` path, unchanged); no resolved route → 403; **resolved ≠ declared → 500 with a loud log**, never a plausible 403 that hides a mis-ordered route. `test/v1-view-binding.e2e-spec.ts` mounts the mis-ordering deliberately and pins `DELETE /api/user/power` as a refusal for ADMIN. The 280-cell role matrix now runs through the resolver too, so it proves table+router+matrix agreement rather than the matrix alone. |
| **C21** | **S1 — response hooks run FIFO, the reverse of Django's response phase**, and the doc at `before-headers.ts:31-33` asserts the opposite. Unobservable today; Phase 3 makes it observable. The model also has no notion of **depth**, so it cannot express `/password_reset/`'s `Vary: Cookie, Origin` (view-level `csrf_protect`, below all eight slots), and `skipBeforeHeadersHooks` means "all" where Django means "below me". ✅ **Closed, as a Phase 2 defect rather than a Phase 3 design item** — the mechanism already existed, already ran backwards and already carried three hooks at three different depths while pretending they were peers. `DjangoStack` (`django-middleware-depth.ts`) gives v1's eight slots numbers, plus `VIEW = 9` for everything below them and `TRANSPORT = 0` for the un-Django Express fixups. `onBeforeHeaders(response, depth, hook)` sorts descending (explicit sequence tiebreak, no reliance on sort stability); `skipBeforeHeadersHooks(response, belowDepth)` suppresses only what is deeper, and applies to hooks registered after the call as well. `DjangoResponseHeadersMiddleware` split into its three real depths. Both measured `Vary` orders now fall out of depth alone — pinned by a unit spec and by `test/response-phase.e2e-spec.ts`, whose slot-2 probe reproduces the reviewer's requested cell; both fail against the FIFO implementation (mutation-checked). The wrong doc comments at `before-headers.ts:31-33` and `app.module.ts:97` are corrected. **What is genuinely a Phase 3 design question is the session store**, not the ordering: `GET /reset/<uid>/<token>/` writes a `django_session` row, and v2 has no session model — already recorded at `django-url-conf.ts` and unchanged by this. |

**Within Phase 3 — all closed** (`5f4120f`, `af596b0`):

| # | Condition | Outcome |
|---|---|---|
| **C22** | S4 — the SQS retry budget is **9**, not the 3 P2-D7 records, with no request timeout, now on the HTTP request thread. | ✅ **Closed.** `sqsClientConfig` / `sesClientConfig` pin `maxAttempts: 1` plus explicit connect/socket timeouts, so the publisher's own 3-attempt loop is the only retry and a publish is bounded at **~9.6 s** worst case. SES gets the same treatment (Consider #6): boto3's legacy default there is **5** attempts and `MailService` has no retry loop at all, so every one of them was invisible latency inside `create_user`'s transaction. P2-D7 corrected to state the wall-clock bound. |
| **C23** | S5 — the hstore codec fails **open** on an absent `keys`/`user_ids` where v1 raises `KeyError`. | ✅ **Closed.** Both decoders check the key's presence before iterating, with the `KeyError: '<key>'` shape `readEndpoint` already uses, and the two NULL branches now carry the exception CPython actually raises (`AttributeError` / `TypeError`, not a generic one). Four spec cells; Phase 7 inherits the `user_ids` half. |
| **C24** | S9 — plan defect: Phases 3 and 4 both write `SchedulerTask` rows that Phase 7 owns and runs *after*. | ✅ **Closed by splitting Phase 7** — see the Phase 7a/7b note in §3. **How the rows are validated before the runner exists** (C24's actual question): by *comparison*, not execution. `fondodev` holds 632 real rows, 92 of them `birthdate`, so the e2e cells transcribe row 2458 field by field — `type`, `run_date` (05:00Z = local midnight), `repeat`, `processed` and `payload::text` — and prove a v2 row is byte-identical now. Phase 7 adds the behavioural half later, on top of `nextRepeatRunDate`, which C3 already pinned against `python-dateutil==2.7.5`. |
| **C25** | S6 — `resetDatabase` is one `TEST_DATABASE_URL` away from truncating the parity fixture. | ✅ **Closed.** `assertDisposableDatabase` gates **both** `provisionTestDatabase` and `resetDatabase` on positive evidence that Django does *not* own the schema — `django_migrations` empty (fondodev has 38) and no `0_init` baseline marked applied with `applied_steps_count = 0` (fondodev has exactly that) — plus a name denylist as a weaker second line. Six e2e cells, all negative. |

**Before the next parity round:** C26 (S7 — the parity report's `pg_dump` md5 guard is not evidence), C27 (S8 — supertest also silently rewrites dot-segments, backslashes and spaces; existing cells survive but the trap is open for Phases 3–8). Both belong to `manual-tester`'s method rather than to the source tree; C25's guard is the code half of the same concern and is closed.

**Consider C5** (not a condition): the 22-pattern table is correct *only* because Django 2.2.25+ uses `re.fullmatch` for `$`-terminated patterns (the CVE-2021-44420 fix) — Python's `$` otherwise matches before a trailing newline, and `POST /…/subscribe%0A` is reachable. Correct but version-dependent and undocumented; pin it with two cells. ✅ **Done** (with C20): six cells in `django-url-conf.spec.ts` and four in `test/http-edge.e2e-spec.ts`, naming the Django version and the CVE, plus the `decodePathInfo('%0A')` step that makes the input reachable.

### ⚠️ Fixture incident — 2026-09-02, Phase 3 parity

A `PATCH /api/user/13` probe (D15/P3-D2, suggested by `docs/phase-3-deviations.md` §4.4) succeeded
against v2, and `__create_birthdate_notification` calls `remove_sch_notitfications`
**unconditionally**. **Six historical `fondo_api_schedulertask` rows for owner 13 were deleted and
are not recoverable** — no dump, no accessible WAL, the tuples already pruned.
`fondo_api_schedulertask` is now **626, was 632**; one row for owner 13 survives, regenerated with
the correct values. The six were deliberately **not** fabricated.

**Everything else is byte-identical to baseline:** `notificationsubscriptions` 94 / max id 1468 /
`count(distinct xmin::text) = 1`, `auth_user` 15, `power` 20, `django_session` 20, `loan` 425, and
all schema/constraint/index hashes.

**Impact.** `fondodev` is a snapshot of production, so nothing member-facing is lost and production
is untouched — but this table is no longer a faithful snapshot, and **`SchedulerTask` is exactly
what Phase 7 exists to test**. Recommend **re-snapshotting `fondodev` from production before Phase
7**, and re-verifying the guards afterwards.

**Rule added — this is the process failure, not the probe:** every parity round must
`pg_dump` **each table the phase writes** before its first write cell.
⚠️ **Amended after round 2:** the dump must live on **persistent storage** — round 2's went to
`/tmp`, which is **tmpfs** (verified), and the host reboot destroyed it. Use
`~/.fondo-parity-dumps/`. And **restore from the dump, never from statements the probe
reconstructs** — round 1's six rows were lost precisely because reconstruction was the only
option. Round 2 had two incidents, including a probe that **soft-deleted the only ADMIN** (after
which ~150 later cells "agreed" at 401/401); both were recovered in one command **because the
dump existed**. Phase 3 guarded
`notificationsubscriptions` (the Phase 2 fixture) and not `schedulertask`, because the brief named
the tables of the *previous* phase. Phase 4 writes `loan`, `loandetail` and `schedulertask`; Phase
5 writes `activity*`; Phase 6 writes `savingaccount`.

### False-green findings — a standing hazard, not a one-off

**Seventeen** instances found so far. Three are mine, all of the same mechanism (a scripted edit
that silently no-ops); one — #17 — is a test written to catch a timezone bug that was itself
defeated by a timezone bug. A test that passes for the wrong reason
is worse than a missing one, because it is counted as coverage.

| # | Instance | Why it passed |
|---|---|---|
| 1 | supertest strips fragments | the transport normalised the thing under test |
| 2 | `pg_dump` md5 as a fixture guard | `synchronize_seqscans` rotates rows; the value was never reproducible |
| 3 | e2e cell "PUT behaves exactly like POST" | sent the CSRF token in the **body** — asserting the very defect F5 describes |
| 4 | D1 matrix printing "72/72, 0 mismatches" | **every cell was a 401** (`is_active::text` is `true`, not `t`). A matrix asking only "did both sides agree" is satisfied by any *uniform failure*. |
| 5 | URL sweep after `DELETE /api/user/1` | the probe soft-deleted the ADMIN, so ~150 later cells agreed at 401/401 |
| 6 | round-1 SES check | compared only `Message.Body.Html.Data`, never the envelope — so it passed on a payload that is deliberately different (D5) |

| 7 | The developer's first F8 probe used `PATCH /api/user` | *every* malformed body is a 500 there whatever the parser does — the probe "agreed" on rows it was blind to. Caught before it produced a result. |
| 8 | **Mine.** I launched v2 without `ALLOWED_HOST_DOMAIN` and read a uniform **400** on every cell as a fix regression | C19's own `ALLOWED_HOSTS` port was rejecting `Host: localhost` — correct behaviour, misconfigured harness. A *uniform* result on a matrix is the signature of a broken probe, in either direction. Positive controls catch it; I had none. |

| 9 | **Mine.** The `:8450` I started and handed to the tester pointed `NOTIFICATIONS_QUEUE_URL` at **real AWS**, with no SES/SQS endpoint overrides, no `HOST_URL_APP`, no `TZ_NAME` | a false-**pass** generator: `create_user`'s rollback fires for the wrong reason, and an empty SQS capture compares "identical" to another empty one. Confirmed by inspecting both processes' environments. **Start v2 from `p3/start-v2.sh`, never by hand.** |
| 10 | A destructive `PATCH` cell ran both legs without restoring | v2's `*/*` control then ran against 0 subscriptions and "agreed" on `0 → 0`. |
| 11 | **Two harness defects still live in the repo scratchpad** — `p3/restore-all.sh` is mode 644 (fails silently when invoked directly) and `p3/r2-f3.sh` **still lacks `--path-as-is`** | round 2's dot-segment false green **re-fired in round 3**. A fix to a probe has to land *in the probe*, not only in the report that described it. |
| 12 | `POST /api/user/power` is uniformly 500 across 208 multipart cells; birthdates uniformly 200 | neither discriminates on status alone — the same blindness as instance #7, on a different endpoint. |

| 13 | `d1.py`'s positive control demanded a **403 from v1 on a route v1 has no authorisation branch for** — that absence *is* D1 | it printed `FAILED` on every correct run. **A control that always fails silences exactly like one that always passes**, because both stop carrying information. |
| 14 | **9 of 17 probe scripts were mode 644**, not the 2 named in instance #11 | they fail silently when invoked directly. The class was wider than the two instances that happened to be noticed. |
| 15 | Three consecutive rounds reported the fixture "byte-identical" while `fondo_api_userfinance_id_seq` and `fondo_api_userpreference_id_seq` **drifted 27 → 36 → 45** | `restore-all.sh` reset two sequences but not these, and `snap.sh` did not compare them. Not parity-visible — but it made a claim I repeated in three reports untrue. Sequences are now in both. |

| 16 | **Mine, third of this class.** v3.0's changelog and commit message both claimed two registration rows were corrected; `git show` touched only D22. My `.replace()` targeted the **BA document's** phrasing, not the **plan's**, so it matched nothing and reported nothing | an edit script that silently no-ops is the same failure as a test that silently passes. Earlier instances: a `sys.exit()` that aborted before the write, and an unreproducible content hash. **Every scripted edit must assert its anchor exists *and* re-read the file to confirm the change landed.** |
| 17 | **The developer's own catch, and the best of the seventeen.** Its first C28 test pinned the host zone with `process.env.TZ = 'UTC'` *inside* the spec | jest's vm context does not propagate that to V8's cached zone, so the pin did nothing. On this `-05:00` host the C28 cell **passed against the buggy line** — a test written specifically to catch a timezone bug, defeated by a timezone bug. Found by measuring it with a throwaway probe rather than trusting the green. Pin moved to `jest.config.ts` + `test/global-setup.ts`, before the workers fork; control run against the old line then produced **exactly one** failure. |
| 18 | **Mine, fourth of this class — and the first that was not a no-op.** I wrote the §3/§5 precedence note, verified it on disk, and committed it as `56e43b3` — **on `chore/c28-c36-phase-3-conditions`.** `feat/phase-4-loans` had already branched from `d164358`, which predates it, so the note was **absent from the branch all the work continues on**, while `docs/phase-4-deviations.md` §2.1 and §5.2 both told the reader it was there. Found by `business-analyst`, which went to read it and could not. | Verifying an edit on the branch you happen to be standing on says nothing about the branch the work will continue on. **`git branch --contains` before claiming a fix is in place**, and cherry-pick forward when a doc fix is written off the line of work. Earlier instances of the family: a `sys.exit()` before the write, an unreproducible hash, a `.replace()` that matched the wrong document. |
| 19 | **Mine, fifth of this family — and my *checking method* was the defect, not the edit.** `161d780`'s message claimed the C40/C41/M3/D29/D30 round complete; three required pieces were **not in its tree** — §5.1 still carried the "nothing in v2 can create a second row" claim M3 had just falsified, and §4.1 lacked the D29/D30 rows the manual tester works from. I had verified the *code* and the *gate numbers* and never opened the docs the brief required. Found by `nestjs-developer`, which checked the tree instead of believing my commit message. | ⚠️ **The grep that cleared it was line-wrapped.** The stale sentence spanned a newline, so a single-line fixed-string search counted **0** and I read absence as proof. The same blindness produced two false *alarms* earlier in this phase — pattern `*` unescaped, then an anchor split across lines. A verifier that fails in both directions is not a verifier: **match on a short distinctive fragment that cannot wrap, or normalise whitespace before searching.** And a commit message is a claim about a *tree*, so verify every item the brief listed, not the ones that were easy to check. |

**Countermeasures now required of every parity harness:** assert **positive controls** (prove the
matrix can produce a 200, not only agreement), print the **status distribution** rather than a
pass count, use `curl --path-as-is` (curl normalises dot-segments like supertest), and compare
**whole payloads**, not one field.

Applied to the F6/F8 work (2026-09-03): every e2e cell asserts the *same request* under an
acceptable `Accept` beside the 406, the write cell deletes the row under `Accept: */*` to prove
the route is not inert, the multipart cells assert the whole response body rather than the
status, the `SuspiciousOperation` cells pin the accepted boundary (exactly 1000 fields, exactly
2 MiB) as well as the rejected one, and the live matrices print their status distribution
(`200x22 400x24 401x19 404x23 405x8 406x28 301x1`, identical on both stacks) rather than a
mismatch count. A seventh instance was avoided rather than found: the first F8 probe used
`PATCH /api/user`, where **every** malformed body is a 500 whatever the parser does, so it could
not have distinguished the two stacks; re-pointing it at `POST /api-token-auth`, whose serializer
*names the fields it received*, made the parse result visible and exposed four differences the
first probe was blind to.

### Open review conditions

Tracked to closure, not carried forward silently. Source:
[`docs/review-phase-0-1.md`](docs/review-phase-0-1.md).

| # | Condition | From | Status |
|---|---|---|---|
| C1 | `formatDateEs()` must distinguish `@db.Date` from `timestamptz` at the type level (rule 5c). | P0 · S1 | ✅ **Closed** (`114d8cf`). Signature narrowed to `PlainDate`; `fromDateColumn` / `toBogotaDate` are the two named conversions; a `Date` is a compile error *and* a runtime `TypeError`. Test pins `28 mar.` vs `29 mar.` for the same instant. |
| C2 | Global BigInt→JSON strategy rendering bare numbers, not strings (rule 5b). | P0 · S2 | ✅ **Closed** (`43759e8`). Express `json replacer` installed by an `AppModule` provider; bigint → **number**, `BigIntPrecisionError` above 2^53 rather than silent loss. Unit + e2e on the raw response text. Recorded in `docs/phase-0-deviations.md` §2.10. |
| C3 | Add a `relativedelta` month-end primitive. **Phase 3's birthday task needs it, long before Phase 7 runs.** | P0 · plan gap | ✅ **Closed** (`a98c732`). `relativedelta.util.ts` + `nextRepeatRunDate`; 104 tests, every value captured from `python-dateutil==2.7.5` on CPython 3.9. Pins two v1 behaviours: a MONTHLY chain from the 31st collapses to the 28th forever, and a leap-day YEARLY task loses 29 February. |
| C4 | Verify the deployed container's `TZ` and record whether v1's `DateField` dates are UTC or Bogotá (rule 5). | P0 · S6 | ✅ **Closed** (`42eed47`). **Bogotá.** `Settings.__init__` does `os.environ['TZ'] = TIME_ZONE; time.tzset()`, verified live at 19:09 Bogotá with the host zone UTC. `todayForAutoNowDateField()` / `nowInstant()` pin each half. Escalation withdrawn; one residual recorded (v1 has no Dockerfile in-repo; conclusion holds for any image shipping tzdata, slim and alpine both verified). |
| C5 | Fix multipart and malformed-JSON request parsing to match v1 (**D18**). | P1 · S3 | ✅ **Closed** (`59700ff`). All three rows fixed, none deviated: multipart parses, unsupported media types 415 with DRF's wording, malformed JSON returns **CPython's** message and offset (`python-json.ts`, 412 structured + 3 000 fuzz cases differentially validated, 0 mismatches). Parsing deferred until after the guards, preserving DRF's authenticate-then-parse order. |
| C6 | `userPatchAllowlist` builds its allowlist from `attempt.fields`, making the "positive allowlist" a tautology. | P1 · S4 | ✅ **Closed** (`9638d2e`). Three frozen field sets transcribed from `services/user.py:208-261`; the allowlist no longer reads the payload. `identification` (D16) is parameterised and tested both ways, awaiting Q26. |
| C7 | `FieldAllowlist.none().assert([])` does not throw. | P1 · S5 | ✅ **Closed** (`5988ac0`). An empty allowlist denies any write including the empty one; a non-empty allowlist still accepts an empty change-set. |
| C8 | The `body.type` gate vs the `changedFields` gate. | P1 · escalated | ✅ **Closed** (`e4c9985`). `resolveSection` + `assertSectionWritable` + the field allowlist, applied in that order; `changedFields` normalises `bigint`/`number`, `Date`/`'YYYY-MM-DD'` and numeric strings so rule 3 cannot fire on an echo. Resolution text below unchanged. |

| C10 | The `@All()` 405 fallback and handlers that never read `request.data` must bypass the parser interceptor. Two regressions found by booting the real pipeline: `PUT /api-token-auth` with `text/plain` → **415 where v1 405s** (the interceptor fires before the fallback), and `ActivityYearView.post` / `UserAppsView.post`'s `birthdates` branch → **415 where v1 succeeds**, because those handlers never read `request.data`. One marker fixes both. | P1 · R1/R2 | ✅ **Closed in P2** (`@DrfNoRequestData()` + the exported `assertRequestDataParsable`, applied to both `@All()` fallbacks; both regressions pinned by e2e cells with a positive control). Awaiting reviewer verification. |
| C11 | `express.json({strict:false})` plus a DRF-shaped non-dict body error; correct the mislabelled parse-error branch and register the >2.5 MB JSON tightening. | P1 · R4/R5 | ✅ **Closed in P2**, with one registered residual: `strict:false` set and six e2e cells pin DRF's `Invalid data. Expected a dictionary, but got <type>.`; the parse-error message now branches on which parser ran; the >2.5 MB JSON tightening is registered. **Residual:** CPython accepts `NaN`/`Infinity` and `JSON.parse` does not — closing that needs a hand-written JSON parser, not a flag. |
| C12 | **Add `express` and `multer` to `dependencies`.** Both are phantom (transitive) today, so a hoisting change could hand the adapter and the middleware **two different Express instances** — silently unsetting C2's `json replacer`, so every money field would render `"1000"` instead of `1000`. | P1 · R7 | ✅ **Closed in P2** — `express@5.2.1` and `multer@2.2.0` added to `dependencies` at the versions platform-express resolves. |
| C13 | One e2e cell proving **403 precedes 415/400** on a guarded route. `test/role-matrix.e2e-spec.ts` builds a partial module without `AppModule`, so it keeps Nest's default parser and never exercises the DRF pipeline — acceptable, but it leaves the ordering unproven. | P1 · R8 | ✅ **Closed in P2** — `test/notification.e2e-spec.ts` → *C13*: a permission-denied caller sending `text/plain` (and separately a malformed JSON body) to `POST /api/notification/subscribe` gets **403**, plus a positive control proving the same requests are 415/400 for an allowed caller. Real guarded route, real body-reading handler. |
| C15 | **N1 — middleware order.** v1 lists `CommonMiddleware` 3rd (`base.py:41`) and `corsheaders.CorsMiddleware` 8th/last (`:46`), so `APPEND_SLASH` fires **before** CORS. `AppModule.configure` applies `DjangoCorsMiddleware` before `DjangoUrlResolverMiddleware`, so a genuine preflight on `/password_reset` is **301 in v1, 200 in v2** (verified). Fix is swapping two entries — preserving `skipBeforeHeadersHooks`, since v1's 301 carries no `Vary`/`X-Frame-Options`/`Access-Control-*`. | P2 · N1 | ✅ **Closed** — and *not* by swapping two entries: the resolver 404 and the `APPEND_SLASH` 301 sit on **opposite sides** of `corsheaders` in v1 (`BaseHandler` is below all eight middlewares), so a swap would have turned the `/nope/nope` preflight from 200 into 404. Split into `DjangoAppendSlashMiddleware` (v1's slot 3) and `DjangoUrlResolverMiddleware` (below slot 8), with `AppModule.configure` documenting all eight rows. Verified live on all four paths, with and without `Origin`: **301/301**, and the resolving and non-resolving preflights still **200/200**. `skipBeforeHeadersHooks` preserved and unit-pinned. |
| C16 | **N2 — `Location` encoding on the `APPEND_SLASH` 301.** Django emits `escape_uri_path(<decoded path>)`; v2 echoes the raw request target. Verified: `POST /password%5Freset` → v1 `Location: /password_reset/`, v2 `/password%5Freset/`. The doc comment in `django-url-resolver.middleware.ts` claiming the two agree is **false** — the routes are ASCII, the request target need not be. | P2 · N2 | ✅ **Closed** — `django-uri-encoding.ts` ports `escape_uri_path`, `iri_to_uri` and `escape_leading_slashes`; every expectation in its spec came out of the real functions in the v1 container. `Location` is now built from `PATH_INFO`. Verified live: all five encoded targets and the query cases agree byte-for-byte. The false doc comment is gone. |
| ~~C18~~ | ✅ **Closed** (`1c3f3d9`). Root cause is one layer below Django: gunicorn's `create()` (`http/wsgi.py:191-194`) copies only `req.query` and `req.path` into the environ — the fragment survives solely in `RAW_URI`, which Django never reads. Fixed in `splitQuery`, which fixes the path and the `Location` together. Two shapes beyond the original report also diverged and now match: `#frag?a=1` (the `?` is inside the fragment, so there is **no query**) and a bare trailing `#`. Verified: all five shapes identical live, `%23` control still 404/404. | P2 · N4 | ✅ |
| ~~C18-orig~~ | **N4 — a literal `#` in the request target.** gunicorn parses with `urlsplit` and drops the fragment; v2's `splitQuery` (`src/common/http/request-target.ts`) splits on `?` only. Verified: `POST /password_reset#frag` → **v1 301 `Location: /password_reset/`, v2 404**; `POST /password_reset?a=1#frag` → v1 `Location: /password_reset/?a=1`, v2 `…?a=1#frag`. Pre-existing, fail-closed, unreachable from a conforming client (RFC 9110 §7.1) — but it is the other half of rule 14's own second sub-rule. ~2-line fix. | P2 · N4 | ⬜ non-gating |
| C17 | **N3 — percent-encoded literal path segments** (pre-existing, not a regression). The URL conf decodes them correctly; **Nest's Express router does not.** `POST /api%2Dtoken%2Dauth` → v1 **400**, v2 **404** (verified) — an *implemented* Phase 1 route. Mirror image of F2 and cross-cutting for Phases 3–8. | P2 · N3 | ✅ **Closed in P2** (not carried to the P3 gate) — the resolver hands Nest's router `escape_uri_path(PATH_INFO)` once the table has matched, and `AppModule` mounts its middleware at `/` so Express cannot undo the rewrite. `POST /api%2Dtoken%2Dauth` → **400 in both**, `POST /api/%6Eotification/subscribe` → **200 + row / 401** in both. Fail-closed direction re-checked: `/%41PI/notification/subscribe` still 404s (decoding cannot smuggle a path v1 refuses). |
| C14 | ⚠️ **`app.enableCors()` terminated every `OPTIONS` with 204 before the router, guards and `@All()` fallback** — with or without an `Origin` header, so a bare `OPTIONS /api/notification/subscribe` was 401/403 in v1 and 204 in v2: **auth bypassed on that verb**. | P2 · F1 | ✅ **Closed** — `enableCors` removed; `DjangoCorsMiddleware` ports `corsheaders 2.4.0` under v1's settings and short-circuits **only** a genuine preflight (which v1 does without requiring `Origin`, and on any path). Bare `OPTIONS` now 401/403; preflight 200 with `Content-Length: 0`, `Vary: Origin`, `Max-Age: 86400`. Registered in `AppModule`, so the e2e suites exercise it. P1-D2's v2 column corrected in `docs/phase-1-deviations.md`. |
| C9 | **S7 — detail-route trailing slashes**, plus P2-D5 (the `[a-zA-Z]+` operation constraint) and F2 (case-insensitive routing): three instances of one gap, all needing a pre-guard URL layer. | P1 · S7 | ✅ **Closed in P2, in full** (see `docs/phase-2-deviations.md` §2.11 for why not in P3). All 22 v1 `url()` patterns transcribed in `django-url-conf.ts` with the line each came from; `DjangoUrlResolverMiddleware` resolves before the guards and also does `APPEND_SLASH`. **Fail-closed.** `POST /API/notification/subscribe` no longer writes a row, `/api/loan/5/` and `/api/user/5/` 404 as in v1, `POST /password_reset` 301s. 53 unit + 15 e2e cells; the whole `urls.py` swept against the live v1. |

*(C9 was raised in the first review's Phase 1 gate and lost when I transcribed the conditions
into this table. `nestjs-developer` correctly flagged it rather than acting outside its brief.)*

### C8 resolved — the two rules operate at different levels

They are not in conflict once ordered. `update_user` (`services/user.py:100`) dispatches on
`obj['type']` and **ignores every other section in the body**. So:

1. **`body.type` gates the section.** If `type == 'finance'` and the caller is neither ADMIN nor
   TREASURER → **403**, whether the `finance` object is empty, unchanged, or absent. The declared
   intent is what is refused, not the diff.
2. **A section the caller did not declare is irrelevant.** With `type == 'personal'`, a `finance`
   key in the body is ignored by v1 and must be ignored by v2 — never a 403. This is what makes
   every member's ordinary save work, since v1's client posts both sections every time.
3. **`changedFields` gates privileged *fields within* the dispatched section** — `role` (D1) and
   `identification` (D16, pending Q26). 403 only on an actual change, so echoing an unchanged
   value is fine.

Level 1 answers "may you touch this section at all", level 3 answers "may you change this field".
The reviewer's empty-`finance` case is therefore a **403** — it is a declared finance write by an
unprivileged caller — and C7's silent no-op cannot arise, because the refusal happens at the type
gate before any field comparison. `FieldAllowlist.assert()` must still fail closed on an empty
set, as defence in depth rather than as the primary control.

**Phase status board**

| Phase | Status | Dev | Tester | Reviewer | Analyst |
|---|---|---|---|---|---|
| — Prereq: dev DB at 0019 | ✅ **Cleared** | — | — | — | — |
| 0 Foundations & Prisma baseline | ✅ **CLOSED** (`b3effab` + C1–C4) | ✅ | n/a | ✅ **APPROVED** | n/a |
| 1 Auth + roles | ✅ **CLOSED** (`151314f` + C1–C8) | ✅ | ⬜ | ✅ **APPROVED** | ⬜ |
| 2 Mail + notifications | ✅ **CLOSED — APPROVED** (`fe261fc`) | ✅ | ✅ PASS r3 | ✅ **Approved w/ conditions** | ⬜ |
| 3 Users + finance | ✅ **CLOSED — APPROVED w/ conditions** | ✅ | ✅ PASS r4 | ✅ **Approved** (C28–C39) | ✅ Aligned |
| 4 Loans | 🟢 **STARTED** — C28/C36 closed (`cec6c61`); D25+D10 land together, D26, D27 | ⬜ | ⬜ | ⬜ | ✅ C29/C30 |
| 7a Scheduler *write half* | ✅ **Landed with P3** (`af596b0`) | ✅ | ⬜ | ⬜ | ⬜ |
| 7b Scheduler *runner* | ⬜ Blocked on P4 | — | — | — | — |
| 5 Activities | ⬜ Blocked on P3 | — | — | — | — |
| 6 Saving accounts | 🔴 **Blocked on Q19–Q24** — no spec to port | — | — | — | — |
| 8 Files + admin | ⬜ Blocked on P2 | — | — | — | — |
| 9 Cutover | ⬜ Blocked on P8 | — | — | — | — |

---

## 8. CI/CD (reuse the existing shape)

Adapt `buildspec.yml` rather than replacing it:

| Phase | v1 | v2 |
|---|---|---|
| `install` | Python 3.9, `pip install -r requirements.txt` | **Node 24**, `npm ci` |
| `pre_build` | `CREATE EXTENSION hstore`, `manage.py migrate` | `CREATE EXTENSION hstore` (until Phase 9), `prisma migrate deploy` |
| `build` | `coverage run manage.py test` — the suite is the gate | `npm run lint && npm run typecheck && npm test && npm run test:e2e` |
| `post_build` | `scripts/trigger-deploy.sh` → SSM → EC2 | unchanged |

- Keep the SSM deploy trigger and its `master`-branch-and-PUSH-only guard.
- Keep the `run-server.sh` container-role pattern; `worker` and `scheduler` roles collapse
  into the v2 app (or a single scheduler process) at Phase 7.
- v1 has **no lint step**. v2 adds lint + typecheck to the gate.

---

## 9. business-analyst review outcome & operator decisions

Full note: [`docs/ba-review-v0.2.md`](docs/ba-review-v0.2.md). BA verdict: **Concerns** — resolved
by the §5 register. Operator answered 13 of 24 questions on 2026-08-30.

### Answered — folded in

| Q | Topic | Answer | Effect |
|---|---|---|---|
| Q1 | Loan auto-close intent | Intended; no notification needed | Port as-is, silent |
| Q2 | Guard against post-file approvals | No, keep v1 | No guard |
| Q3 | Return closed-loan list / cap the count | Return the list; **no cap** | **D8** |
| Q4 | Rate frozen at request | Yes | Confirms v1 |
| Q5 | Concurrent refinance requests | Keep v1 | Port broken linkage |
| Q6 | Retry failed reminders next run | Keep v1 (best-effort) | No cross-run retry |
| Q7 | Email fallback for reminders | No — push only | Gap accepted |
| Q8 | Past-dated reminder | **Send immediately** | **D7** |
| Q9 | Term outside 1–36 | **Reject `400`** | **D4** |
| Q12 | Quota source | Treasurer's file only | Confirms v1; over-quota gap accepted |
| Q14 | Legal state transitions | **Enforce** | **D9** |
| Q15 | `PATCH /api/user/<id>` | **Restrict** — admin: all; treasurer: finance only | **D1** |
| Q16 | Loan read by id | **Restrict** to owner + `[0,1,2]` | **D10** |
| Q17 | Power approval | **Restrict** to requestee | **D2** |
| Q13 | Alexa users | Moot — skill retired | Closed |

### Answered 2026-08-30 (second round)

| Q | Topic | Answer | Effect |
|---|---|---|---|
| Q10 | Power letter recipients | **All members** | Confirms v1 |
| Q13 | Alexa users | None — safe to remove | Closed |
| Q18 | `To:` → `Bcc:` | **Yes** | **D5** decided |
| Q19 | What a CAP is | Fixed-term deposit, **no interest or earnings** | P6 spec |
| Q20 | When a CAP closes | **Automatically on `end_date`** | **D12** — new build |
| Q21 | `value` on `PUT` | New total balance | Confirms v1 |
| Q22 | Who may act on CAPs | **ADMIN + TREASURER only**, no notifications | Confirms v1; **D3 withdrawn** |
| Q23 | PRESIDENT and CAPs | **Not allowed** — deliberate | **D3 withdrawn** |
| Q24 | CAP ↔ quota | Purely informative | Confirms v1 |
| Q25 | PRESIDENT and `PATCH /api/user` | Not allowed — ⚠️ *scope being confirmed* | **D1** |

### Answered 2026-09-02 (third round)

| Q | Topic | Answer | Effect |
|---|---|---|---|
| Q26 | `identification` ADMIN-only? | **Yes** | **D16** decided — implemented in P3 |
| Q27 | Who gets the reset link on a shared email? | **The account whose `username` is the email** | **D17** decided — implemented in P3 |
| Q29a | Does any client screen let a MEMBER read another member's detail/finance? | **No — members only see themselves** | **D25** proceeds; **D10 not reopened** |
| Q30a | How does a member change who holds their proxy? | **A second request supersedes the first** | **D26** proceeds; ⚠️ **no uniqueness rule** |
| Q31 | May a TREASURER approve their own loan? | **Yes — normal fund practice** | **D28 withdrawn**; **m6** accepted as-is |

Q1–Q27 are answered. The only open *inference* is the TREASURER self-service cell in the D1
table (§5), flagged there.

### Open — raised by the Phase 3 implementation

| Q | Topic | Blocks |
|---|---|---|
| **Q28** | **D5's empty `To`.** The power-of-attorney letter now goes out with `ToAddresses: []` and every member in `Bcc` — the literal reading of "move them to `Bcc`". SES accepts it, but a message with no `To:` header is scored more harshly by some spam filters and this is a formal document. The alternative is `To: <DEFAULT_FROM_EMAIL>`. Confirm before the first real approval after cutover; one-line change either way. | Nothing — recorded, not blocking |

⚠️ **`DJANGO_SECRET_KEY` is now required in production.** v2 signs its own password-reset tokens
with it (**P3-D4**). It reuses the variable v1's `production.py` already reads, so no
deployment change is needed — but the boot now *fails* without it, where v1 failed later and
less clearly.

### Runbook items carried from Phase 3 findings

1. **Do not edit the profiles of user 13 (`sebastian.montanez`) or 14 (`ainhoa.montanez`) in
   frozen v1.** Any personal edit 409s (shared email + UNIQUE username). Reconcile or formally
   record those two rows before cutover — deciding whether a child member gets their own email
   address, or whether the fund keeps a parent's address with a distinct username. Telling the
   members is not sufficient: Ainhoa is five.
2. **Four members cannot reset their password** (D17: ids 7, 10, 13, 14) and are shown the
   success page. Until D17 ships in v2, those resets have to be done manually. Worth telling the
   treasurer now rather than at cutover. ✅ **Fixed at cutover for ids 7 and 10**; ids 13 and 14
   (the custodial accounts) become **admin-assisted reset only**, deliberately — they have no
   email address of their own.
3. **Reset links do not survive the switch** (P3-D4): v2 signs its own tokens, so any link v1
   issued stops working at cutover. Django's timeout is 3 days, so at worst a few members
   re-request. Nothing to do beyond knowing it.
4. **Two more `@parser_classes` misuses to leave alone.** `LoanView.patch` and `FileView.post`
   carry `@parser_classes((MultiPartParser,))` on a *method*, where it is a no-op (§ Phase 3
   findings). Phases 4 and 8 must reproduce the no-op, not the decorator's apparent intent.

### Cutover timing — corrected (Q11)

The operator pushed back on the calendar constraint, and re-reading the code they are **mostly
right**. Correcting the earlier guidance:

- ❌ **Withdrawn: "never cut over near a year boundary."** `ActivityService.create_year` is not
  automatic — it fires only on an explicit `POST /api/activity/year` (role ≤ 1). It reads
  `date.today().year`, disables the most recent other year, and is guarded by a unique
  constraint. The real caveat is much smaller: **there is no re-enable path through the API**, so
  if someone presses the year-rollover button mid-cutover and it goes wrong, fixing it needs
  manual SQL. That is "don't press that button during the switch", not a blackout window.
- ✅ **Kept, and it is the one that matters: cut over shortly after a verified monthly bulk
  upload.** Not for data-safety reasons — for **runway**. The bulk TSV upload is the riskiest
  operation in the system (fund-wide auto-close, D8/D9). Cutting over just after a good upload
  puts roughly a month between the switch and the first time v2 runs that path for real, which
  is time to rehearse it against a copy. Cutting over the day before an upload means v2's most
  dangerous code path runs in production before anyone has watched it work.
- ℹ️ **Minor:** password-reset links issued by v1 stop working at the switch (D-note, Phase 3).
  Django's default timeout is 3 days, so at worst a few members re-request.
- ℹ️ Scheduled `SchedulerTask` rows are **data in the shared DB**, not in-flight process state, so
  v2 picks up pending payment reminders across the switch with no special handling.

**Net: you can cut over on any date.** Prefer the week after a monthly upload; avoid running the
year rollover during the switch itself.

---

## 10. Phase 0 outcome — toolchain notes

Phase 0 complete on `feat/phase-0-foundations` (`b3effab`), not pushed. Gate verified
independently: lint clean, typecheck clean, **262 unit tests / 8 suites**, 19 e2e / 2 suites,
every table round-trips, and `migrate diff` is empty **in both directions**. v1 confirmed
untouched.

**Prisma baseline:** `prisma/migrations/0_init` recorded with `applied_steps_count = 0` —
marked applied, never executed. Verified against `fondodev`.

Pin these; they cost real time to rediscover:

| Item | Fact |
|---|---|
| **Prisma version** | **Pinned to `7.10.0`.** `npm i prisma@latest` installs `8.0.0-rc.12` — npm's `latest` tag points at an RC. |
| **Prisma 7 API changes** | `datasource.url` is banned in `schema.prisma` (moved to `prisma.config.ts`; `.env` no longer auto-loaded). `migrate diff` renamed `--from-schema-datamodel`→`--from-schema` and `--from-url`→`--from-config-datasource`. `PrismaClient` requires a driver adapter. |
| **NestJS 12 is ESM-only** | Jest needs `NODE_OPTIONS=--experimental-vm-modules` (wired into the npm scripts). Running `npx jest` directly fails with a confusing error. |
| **Index operator classes** | `prisma db pull` does not read them back; declaring them in the schema creates permanent phantom drift. Patched in SQL instead. |
| **`Loan.rate`** | Reads back as `0.02`, not `0.020` — Prisma Decimal normalises. `toFixed(3)` restores it. Matters wherever the rate is rendered. |

**Money formatting — three findings that will not resurface until they break an email:**

1. **The Babel expression rounds twice, not once.** `format_number(format_decimal(round(v,2), format='#'))` inside a `ROUND_HALF_DOWN` context makes `20.5001` render as `20`, not `21`. Confirmed against Babel 2.9.1 and pinned in tests.
2. **Four-digit grouping.** v1's locale is `LANGUAGE_LOCALE = 'es'` (not `es-CO`). Babel 2.9.1 renders `1000` as `1.000`; Node `Intl` for `es` renders `1000` — CLDR sets `minimumGroupingDigits=2` for `es`, which Babel 2.9.1 predates. **v2 follows Babel.** Independently verified. v1's tests never render a four-digit amount, so nothing in the inherited suite would have caught this — it would have surfaced as a wrong loan email the first time an amount crossed $1.000.
3. **Decimal precision.** Python's default context is `prec=28`; `decimal.js` defaults to `20`. Matters for `Decimal(loan.value)/fee`. Set explicitly.

Golden values were derived by installing Babel 2.9.1 in a scratch venv and running v1's exact
expressions — not invented. Full detail in [`docs/phase-0-deviations.md`](docs/phase-0-deviations.md).
