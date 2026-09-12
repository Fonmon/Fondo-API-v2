# Phase 8 — deviations, judgment calls and findings

Companion to `MIGRATION_PLAN.md` §5, and to `docs/phase-0-deviations.md` …
`docs/phase-7b-deviations.md`.

Audience: `nestjs-reviewer` (§1–§5), `manual-tester` (§6 — everything it must read as an
**expected** diff), and whoever maintains `MIGRATION_PLAN.md` (§7 — corrections to fold back).

**Scope shipped**

| Area | Units |
|---|---|
| Routes | `GET\|POST /api/file` — `FileController` (`FileView`); `GET /api/file/<id>` — `FileDetailController` (`FileDetailView`); `GET /api/admin` — `AdminController` (`AdminView`) |
| Services | `FileService` — `save_file`, `get_files`, `get_signed_url`; `AdminService` — `test_email`, `test_notifications` |
| Serializer | `serializeFile` / `fileTypeDisplay` — `FileSerializer`, `get_type_display` |
| Storage boundary | `FILE_STORAGE` + `GcsFileStorage` (`@google-cloud/storage` **8.1.0**, new dependency) + `UnavailableFileStorage` for `ENVIRONMENT=test` |
| Shared semantics (`src/common/`) | `pythonLower` + its generated fixture (measurement 7); `drf-request-data.ts` (measurement 2, D22 subset); `parseDjangoIntPathId`; **`readUploadedFile` now takes the last part** (§4 P8-F5) |
| Tests | v1's `test_file_views.py` **8 of 8** ported under their own names; admin cells written from source + measured v1 (v1 has none) |

The four route rows in `django-url-conf.ts`, `permission-matrix.ts` and
`v1-role-matrix.fixture.ts` already existed and were **checked, not edited**: patterns
`^api/file/?$`, `^api/file/[0-9]+$`, `^api/admin/?$`; `FileView` `POST 0 / GET 3`,
`FileDetailView` `GET 3`, `AdminView` `GET 0` — identical to `fondo_api/permissions.py`.

**Gate numbers** — by **exit code**, never by reading output for silence (C67). Baseline
re-measured at `d5a3b12` in this session, not copied.

| | baseline (`d5a3b12`) | after (this tree) |
|---|---|---|
| `npm run lint` | exit 0 | **exit 0** |
| `npx tsc --noEmit` | exit 0 | **exit 0** |
| `npm test` | exit 0 — 2331 / 71 suites | **exit 0 — 2482 / 77 suites** |
| `npm run test:e2e` | exit 0 — 1177 passed + 2 skipped; 20 passed + 1 skipped of 21 | **exit 0 — 1297 passed + 2 skipped; 22 passed + 1 skipped of 23** |
| `fixture-check.sh \| diff - FINAL2-fondodev.txt` | exit 0 | **exit 0** |
| control: `DB=fondo_api_test … \| diff -q -` | exit 1 | **exit 1** |

`+151` unit and `+120` e2e. The per-suite counts come from each run's own `--json` output, not
from arithmetic, and their sums reproduce both totals exactly:

| suite | baseline | after | Δ | what it covers |
|---|---|---|---|---|
| `python-lower.spec.ts` | — | **58** | +58 | new — 53 CPython context rows, two "the fixture still separates W1/W3 on this Node" cells, the all-code-point sweep, lone surrogate, both tables used |
| `python-lower.fixture.spec.ts` | — | **8** | +8 | new — rule 15b shape of the four pinned tables + the capture sizes |
| `drf-request-data.spec.ts` | — | **28** | +28 | new — `in` / `[]` over merged precedence, init-time and D22 classification |
| `file.service.spec.ts` | — | **42** | +42 | new — call sequences per v1 case, partial writes, `int()`, `lower()`, list, signed URL |
| `file-storage.spec.ts` | — | **12** | +12 | new — the GCS adapter offline, and the `ENVIRONMENT` provider |
| `admin.service.spec.ts` | — | **3** | +3 | new |
| `django-multipart.spec.ts` | 40 | **40** | 0 | ⚠️ one cell **changed subject** — "takes the FIRST part" → "takes the LAST part" (P8-F5) |
| **unit total** | **2331** | **2482** | **+151** | |
| `file.e2e-spec.ts` | — | **97** | +97 | new — the 8 ported v1 methods + every oracle case named in §1 |
| `admin.e2e-spec.ts` | — | **23** | +23 | new — v1 has no admin tests; every cell measured |
| `health.e2e-spec.ts` | 9 | **9** | 0 | ⚠️ one cell **changed subject** — `/api/file` and `/api/admin` moved from the 404 list to a guarded 401 cell, with 404 cells beyond each pattern |
| **e2e total** | **1177 + 2 skipped** | **1297 + 2 skipped** | **+120** | |

**No cell was removed.** Two changed subject, both named above; the multipart one was
**certifying the defect** P8-F5 fixes.

---

## ⚠️ `fondodev` was never written to, and nothing reached Google, SES or SQS

* `fondodev`: `SELECT` and `pg_dump` only. `scripts/parity/fixture-check.sh | diff -
  ~/.fondo-parity-harness/p6/out/FINAL2-fondodev.txt` → **exit 0**; control against
  `fondo_api_test` → **exit 1** (the probe is not blind).
* ⚠️ **`fixture-check.sh` does not read `fondo_api_file`** — the one table this phase owns.
  Measured separately, read-only, before and after: `count 37 · max(id) 43 · count(DISTINCT
  xmin) 1`. See §7.6.
* Every v1 write went to the clone **`fondodev_p8`**, created from
  `~/.fondo-parity-dumps/p8-20260912-145049-pre/fondodev-full.dump` and reset **in place** with
  `scripts/parity/reset-clone.sh` three times (hstore OID pinned `3417907`, preserved each time).
* **GCS:** no credentials exist on this host (brief measurement 8) and none were added. Every
  v1 run replaced `storage.Client.get_bucket` with an in-memory fake, and put
  `HTTP(S)_PROXY` on a closed port as a second fence. The signing comparison used a
  **throwaway RSA key generated in the session scratchpad**, bound to no Google account,
  never committed; the unit spec generates its own per run, in memory.
* **SES / SQS:** v1 runs replaced `MailService.send_mail` / `NotificationService.send_notification`
  with recorders; v2 e2e overrides `SES_CLIENT` / `SQS_CLIENT` with capture stubs.
* No `prisma migrate dev`. No scheduler started.

---

## 1. How v1 was measured (so the reviewer can re-run it)

Everything under `~/.fondo-parity-harness/p8/`.

| instrument | what | reproducibility |
|---|---|---|
| `oracle.py` → `oracle-out2.jsonl` | 90 cases through Django's test client against `fondodev_p8`: status, body, `Allow`, `Vary`, rows added, **the ordered storage-call sequence**, sends, log lines | run twice with an in-place reset between: **88 of 90 identical**; the 2 that differed were **my recorder's bug** (`int(EmailTemplate.TEST)` — the enum is not an `IntEnum`), fixed and re-run. The first run's `A-email` "uncaught TypeError" is **not** v1 behaviour |
| gunicorn probe (`shape/`, cases `S1`–`S12`) | the real HTTP shapes of the 500s and bodiless responses, with only GCS patched (`probe/sitecustomize.py`) | single run; container removed after |
| `oracle2.py` → `oracle2-out.jsonl` | `HEAD`, `OPTIONS`, `PUT` on `AdminView`; roles 1–3; list bytes for a name with U+2028/U+2029 | single run |
| `sign.py` / `sign.js` | v1's `generate_signed_url(version="v4", expiration=5 min, method="GET")` vs this adapter's library, same key, same pinned instant, no network (`--network none` / `unshare -rn`) | **8 of 8 URLs identical** |
| `gen-lower.py`, `scripts/gen-python-lower-fixture.py` | CPython 3.9.25 `str.lower()` as data, with a self-check | see §2.4 |

---

## 2. The four measurements that needed a decision

### 2.1 Measurement 2 — presence reads the merged `request.data` → **reproduced without merging**

**Measured (v1):**

| request | v1 |
|---|---|
| `file` sent as a plain field (`M2-scalar-file`), or a `file` part with `filename=""` | **500** after `get_bucket` → `blob` → `exists`; no upload, no row |
| a `file` field **and** a `file` part, either order | the **part** is uploaded → **201** |
| two `file` parts | the **second** is uploaded → **201** |
| `name` as a file part, alone or beside a `name` field | **500** after `get_bucket` (`.lower()` on `InMemoryUploadedFile`) |
| `type` as a file part, alone or beside a `type` field | **500** before any storage call (`int(InMemoryUploadedFile)`) |
| a repeated `name` field | the **last** value |

`MultiValueDict.update` (Django 2.2.27, read in the pinned image) **appends** `FILES` after the
fields, and `__getitem__` returns `list[-1]` — so wherever a key has a file part, the file wins.

**Decided:** `common/http/drf-request-data.ts` answers the two questions v1 asks — *is the key
present in the merged view?* and *which kind of value would `data[key]` return?* — and hands the
value back **from its own source**. A file part is only ever a `DjangoUploadedFile`; a field is
only ever the body's value. `FileService` then fails exactly where v1 fails when it finds a file
where it needs a scalar, or a scalar where it needs a file.

**Why this is not D23.** D23's defect is a file part's **filename becoming a stored scalar**.
Nothing here can do that: no branch converts a file to a string. Every measured case above is
matched, including the 500 that a files-only read (rule 12c alone) would have turned into a
400. The helper has **one caller** (grep at this commit); it is not the standing pattern for
other routes, which keep `readUploadedFile` + `request.body`.

**Which source wins when a scalar and a file part share `file`:** the file, in both orders
(measured). v2 matches because it asks the file source first.

### 2.2 Measurement 3 — the cross-type duplicate → **reproduced, registered as P8-F1**

**Measured (v1), `M3-*`:** uploading `New file` as type 1 when it exists as type 0 calls
`get_bucket → blob(presentations/new file) → exists (False) → upload` and **then** the insert
fails on `fondo_api_file_display_name_key` → **500**. The object stays. A **retry** now finds
the object, overwrites it, skips the row and answers **201** — for a file no list will ever
show. The same partial write happens for a row whose object is missing
(`M3-existing-row-no-blob`) and for a `type` beyond int4 (`M5-type-int4-overflow`, `integer out
of range` after the upload).

**Decided:** ported, in v1's statement order (`FileService.saveFile` carries the table). Fixing
it means choosing between "check the name first" (changes a 201 to a 409/400 the client has
never seen) and "delete the object on failure" (a second outward write with its own failure
mode). Both are business decisions; see §7.1.

### 2.3 Measurement 6 — the `created_at` tie → **v2 adds `id` as a tie-break; registered P8-D1**

**Measured:** `fondodev` has 37 files (23 type 0, 14 type 1) and **one tie** — ids 36 and 37,
both `2024-02-06 17:11:24.95428+00`. v1 returned 36 before 37 on the clone at the time of
measurement; that is heap order, not a guarantee.

**Decided:** `ORDER BY created_at, id`. The e2e cell builds a tie, rewrites one tuple so heap
order is reversed, asserts a **positive control** (raw `ORDER BY created_at` returns heap order,
`b` then `a`) and then asserts v2 returns `a` then `b`. **No list-order parity is claimed for
tied rows.**

### 2.4 Measurement 7 — `str.lower()` drift → **ported from captured data, not registered**

**Re-measured:** Node 24.20.0 (Unicode 17.0) disagrees with CPython 3.9.25 (UCD 13.0.0) on the
single-code-point `lower()` of **95** code points (the brief's figure, reproduced) — and, a
second axis the brief did not name, on the **final-sigma context classes** of **610** code points
(e.g. U+0295 is cased only in UCD 13; U+0888 is case-ignorable only in Node's; U+1734 only in
UCD 13; U+1C89 is cased only in Node's).

**Decided:** port. `scripts/gen-python-lower-fixture.py` captures, from the pinned image with no
network, the two inputs CPython's `lower_ucs4` reads: the full lowercase mapping (1,392 simple,
1 expansion — U+0130) and `handle_capital_sigma`'s two properties, derived behaviourally (2,413
case-ignorable, 4,141 cased-and-not-ignorable code points). Before printing, it rebuilds
`lower()` from its own tables and compares with CPython's.

**Axes validated, as a measurement at generation (2026-09-12, CPython 3.9.25):** all 1,114,112
single code points; 53 context rows chosen per wrong implementation; 200,000 seeded random
strings of length 1–7 over a 198-code-point alphabet (Σ, cased, ignorable, neither, the
expansion, astral, and every drift code point named above). **CI does not re-run this** (no
CPython in CI). CI checks the tables' **shape** (`python-lower.fixture.spec.ts`, rule 15b, in
this commit) and the context rows (`python-lower.spec.ts`).

**Not validated, therefore not claimed:** `casefold()`, `upper()`, `title()`, any other
interpreter. One enumerated wrong implementation — reading the **lowered** neighbours of Σ
instead of the original ones — is an **equivalent mutant** on UCD 13: measured over all 1,393
mapped code points, the class Σ's scan lands on is identical for the original and the lowered
form, in both directions (0 differ). No row claims to catch it.

### 2.5 The other four measurements

* **1 (unconditional upload):** reproduced; `M1-*` cells, including the case-variant name that
  overwrites another row's object (P8-F2).
* **4 (admin):** reproduced and extended by measurement — see §4 P8-F6 for `HEAD`.
* **5 (`int()`):** `pythonInt` on the query, `toDjangoInt` on the body; no local regex. Measured
  and pinned: `?type=٠`, `?type=0_0`, `?type=%201%20`, `type=" ٣ "`, `type=0_1`.
* **8 (storage):** `@google-cloud/storage` 8.1.0 behind `FILE_STORAGE`. Signed URLs measured
  byte-identical (8/8) given one clock read — which the adapter now guarantees, and a spec with
  an advancing clock pins (the first version of that spec used a constant clock and could not
  have caught a second read; found by enumerating the wrong implementation first).

---

## 3. `MIGRATION_PLAN.md` §5 rows touched

### D23 — applied as written

No merge. `readUploadedFile` reads `request.files`; scalars come from `request.body`. §2.1
explains why the presence helper is not the merge.

### D22 — applied as written, and ⚠️ a conflict flagged

D22 decides a **non-ASCII boundary** is DRF's **400** parse error on "every multipart endpoint
in Phases 4–8", naming the P8 file upload. Plan precedence (§5 decides v2) was followed:
`POST /api/file` with a non-ASCII boundary answers **400** `{"detail": "Multipart form parse
error - Invalid boundary in multipart: …"}`.

**The conflict:** D22's reasoning was "the same answer v2 gives for every other invalid
boundary". On this route that is not true. `FileView.post` wraps `request.data` in `except
Exception`, so v1 answers every invalid boundary with a **500** — and measured under gunicorn it
is the **141-byte double-fault page** with no `Allow`/`Vary` (the exception is raised in
`MultiPartParser.__init__`, the view returns its 500, and Django's response handling re-reads
`request.POST` and faults again). So on this route D22 produces **v1 500 / v2 400** for a
non-ASCII boundary while an **empty** or **trailing-space** boundary — not D22's subject — is
ported as **v1 500 / v2 500** (unmarked, no `Allow`/`Vary`). Either D22's row should say that on
`POST /api/file` its pair is 500/400, or the operator may prefer 500 here for consistency with
the route's other invalid boundaries. I did not guess; §7.2.

---

## 4. Deviations and findings

### Deviations (v2 differs from v1 on purpose)

| # | v1 | v2 | why |
|---|---|---|---|
| **P8-D1** | list order within a `created_at` tie is undefined | `ORDER BY created_at, id` | stable; parity for tied rows not claimed (§2.3) |
| **P8-D2** | `ENVIRONMENT == 'test'` builds an **anonymous** GCS client that makes real unauthenticated requests | `UnavailableFileStorage` refuses every call; tests inject a fake | a test that forgets its fake must fail, not reach `fonmon`. Test environments only |
| **P8-D3** | a file part with **no** `Content-Type` uploads with `content_type=''` (`_get_content_type` tests `is None`) | the SDK treats `''` as unset and guesses from the object name | no browser sends such a part; the SDK exposes no way to send `''`. Pinned by `file-storage.spec.ts` |
| **P8-D4** | uncaught 500 pages: gunicorn's 141-byte `text/html` (init-time multipart failures), Django's 27-byte `text/html` (`?type=abc`, storage errors on detail) | zero-byte 500, same absence of `Allow` and of `Accept` in `Vary` | the existing **P3-D6** class; status and header parity kept |
| **P8-D5** | bucket literal `"fonmon"` | `GCS_BUCKET`, default `fonmon` (Phase 0 config) | one environment variable; the default is v1's literal |
| **P8-D6** | a lone surrogate in an object name raises `UnicodeEncodeError` at `blob.exists()` | refused at `blob()` (the SDK's `File` constructor would throw `URIError` there) | same outcome — 500, no request sent. Only reachable from a JSON body, which always 500s on this route anyway |
| **P8-D7** | `upload_from_file` without `size` → a resumable session | the SDK's default upload | same object; protocol not observable to a client |

### Findings (v1 behaviour, ported, not fixed — for business-analyst / operator)

**P8-F1 — the cross-type duplicate is a self-perpetuating partial write.** §2.2. One live
consequence to know before cutover: a v1 upload may already have left such an orphan in
`fonmon`; nothing in the database can show it.

**P8-F2 — an upload silently replaces another row's object.** Paths are lowercased; names are
not. `NEW FILE` over an existing `New file` overwrites its bytes, writes no row, answers 201, and
the list keeps showing `New file` — now with different content. Measured
(`M1-case-variant-same-path`).

**P8-F3 — `type` is not validated.** `type=3` and `type=-1` are stored (`3/<name>`,
`-1/<name>`) and listed with `"type_display": "3"`; `type=2147483648` stores the object and
then 500s. Measured (`M5-*`).

**P8-F4 — ⚠️ cross-phase: v2 does not escape U+2028 / U+2029 in JSON responses.** DRF 3.11.2's
`JSONRenderer` replaces both with the six-character escapes `\u2028` / `\u2029` (`renderers.py:106-109`, read in the
pinned image); measured on `GET /api/file` (`oracle2 G-u2028`). No file in `src/` escapes them
(grep at this commit), so **every** JSON response in **every** phase that can carry
user-entered text differs byte-wise when it contains either character; the parsed JSON is equal.
Not fixed here — it is shared rendering owned by an approved phase. Pinned both sides by one e2e
cell so a fix cannot land silently. §7.3.

**P8-F5 — `readUploadedFile` took the FIRST of two same-named parts; v1 takes the LAST.
Fixed.** Measured (`M2-two-file-parts`). ⚠️ This changes **approved** Phase 3 and Phase 4
routes for that request shape — `PATCH /api/user` and `PATCH /api/loan` with two `file` parts
now process the second, as v1 does. ⚠️ **An existing green cell asserted the wrong behaviour**
(`django-multipart.spec.ts`, "takes the FIRST part"); it changed subject and says so.

**P8-F6 — `HEAD` is a 403 on these views, for ADMIN too, and sends nothing.**
`list_permissions` has no `HEAD` key. Measured on `AdminView` and `FileView`
(`oracle2 A-head-*`, `F-head-list`); v2 matches (e2e). Recorded because `HEAD
/api/admin?type=email` *looks* like it would send mail.

**P8-F7 — `POST /api/file` cannot succeed with a JSON or form body.** With all three keys
present it always 500s on `.content_type`, and `text/plain` / malformed JSON are 500s, not 415 /
400 — the parse runs inside the view's `try`. Ported.

---

## 5. Mutation controls

Every cell that claims to catch a defect was checked the same way: **enumerate the plausible
wrong implementations first**, plant each one in the source, run the suites that claim to catch
it, and record which named cells failed. Runner: `~/.fondo-parity-harness/p8/mutate.py`; raw
results: `mutants-out.jsonl`, `mutants-rerun.jsonl`, per-run jest JSON in `mutants/`.

A mutant counts as **killed** only when a test **assertion** fails. A suite that fails to compile
proves nothing and counts as **invalid**. The runner asserts each anchor occurs exactly once, and
restores and hash-checks each file after each mutant.

**Result, measured 2026-09-12 on this tree: 38 planted, 38 killed, 0 survived, 0 invalid.**

| # | wrong implementation | unit failures | e2e failures |
|---|---|---|---|
| W1 | `toLowerCase()` for `lower()` | 10 | — |
| W2 | no final sigma | 24 | — |
| W3 | sigma rule over Node's `\p{Case_Ignorable}` / `\p{Cased}` | 6 | — |
| W4 | UTF-16 code units | 5 | — |
| W5 | the U+0130 expansion dropped | 5 | — |
| W6 | ignorables after Σ not skipped | 2 | — |
| W7 | context before Σ not read | 8 | — |
| W8 | "cased?" asked before "ignorable?" (overlapping tables) | 1 | — |
| S1 | simple pairs out of order | 1 | — |
| S2 | duplicate simple key | 6 | — |
| S3 | odd-length simple table | 39 | — |
| S4 | inverted ignorable range | 2 | — |
| S5 | a cased range overlapping an ignorable one | 2 | — |
| R1 | files-only presence for `file` (rule 12c alone → the 400) | 2 | 9 |
| R2 | **the D23 merge** — a file part read as its filename | 3 | 24 |
| R3 | field wins over file | 2 | 4 |
| R4 | first same-named part instead of last | 2 | 1 |
| R5 | JSON string `in` as key presence | 1 | 1 |
| R6a | init-time multipart failure never detected | 2 | 2 |
| R6b | every multipart parse error treated as init-time | 1 | 1 |
| R7 | D22 not applied to the non-ASCII boundary | — | 1 |
| C1a | `@DrfNoRequestData()` forgotten (415/400 before the view) | — | 7 |
| C1b | parse errors not raised inside the view's `try` | — | 8 |
| C8 | `Number()` for `int()` on `?type` | — | 5 |
| C2 | upload skipped when the object exists | 1 | 3 |
| C3 | row written before the upload | 3 | 4 |
| C4 | `toLowerCase()` on the upload path | 1 | 1 |
| C5 | no `id` tie-break | 1 | 1 |
| C6 | out-of-int4 `type` sent to Prisma | 3 | 3 |
| C7 | storage failure on detail swallowed into a 404 | 1 | 1 |
| G1 | two clock reads when signing | 1 | — |
| G2 | empty content type passed to the SDK | 1 | — |
| G3 | `ENVIRONMENT=test` gets the real client | 1 | — |
| A1 | empty `type` treated as missing | — | 2 |
| A2 | first query value instead of last | — | 2 |
| A3 | case-insensitive `type` | — | 1 |
| A4 | a `Bcc` added to the self-test mail | 1 | **0** |
| A5 | push to more than the caller | 1 | **0** |

**Where only one layer catches a mutant — stated, not implied:**
* **A4** is invisible end to end: `MailService` removes a `Bcc` address equal to the recipient,
  so the SES payload is unchanged. The unit cell is the only guard.
* **A5**'s extra id has no subscription in the e2e fixture, so no extra message appears. The
  unit cell is the only guard.
* **W\*** and **S\*** run at unit level only, and so do **G\***: the adapter is never exercised end
  to end, because no test may reach GCS.

**Controls on the controls.** Three defects were in my own instruments, and each was found
before any number above was recorded:
1. The first **G3** run was reported *survived*. Its suite had **failed to compile**:
   `=== 'never'` is a TypeScript no-overlap error, so there were zero assertions. The runner's
   invalid-check looked only for `testExecError` and missed it. Fixed: a suite with zero
   assertions is now invalid. The mutant was rewritten to compile, and all 51 result files
   were re-scanned; G3 was the only zero-assertion suite.
2. The first **A5** run never happened: its anchor occurred twice (once in a docblock), and the
   runner refused it, as designed. Re-anchored and re-run.
3. The adapter's signing cell first used a **constant** clock, so a second clock read would have
   passed. It was changed to an advancing clock *before* the run. G1 is the mutant that proves
   it.

⚠️ The hash snapshot I took of the target files was **concurrent with the runner's first
mutant**, so it recorded a mutated `python-lower.ts`. The evidence that the files were restored
is the runner's per-mutant assertion, together with a content check for all 8 W-mutant markers
(0 hits) — not that snapshot.

**One enumerated mutant is equivalent and is not claimed** — reading Σ's *lowered* neighbours
(§2.4, measured 0 of 1,393).

---

## 6. For `manual-tester`

### 6.1 Expected diffs against v1 — read these as **expected**

| # | what to expect |
|---|---|
| 1 | P8-D1: tied `created_at` rows may come back in a different relative order |
| 2 | P8-D4: uncaught 500s are zero bytes in v2, HTML in v1; status and headers match |
| 3 | §3: a **non-ASCII boundary** on `POST /api/file` is **400** in v2, **500** in v1 (D22, flagged) |
| 4 | P8-F4: a name containing U+2028/U+2029 renders raw in v2, escaped in v1 |
| 5 | P8-F5: two `file` parts on `PATCH /api/user` / `PATCH /api/loan` — v2 now matches v1 (the **second** part); a Phase 3/4 baseline recorded before this commit will differ |
| 6 | P8-D3: a file part with no `Content-Type` may be stored with a guessed type |

### 6.2 Explicitly **unchanged** — if these differ, that IS a failure

* Every status, `Allow`, and `Vary: Accept` presence in `oracle-out2.jsonl` and `S1`–`S12`
  except the rows above.
* The storage-call **sequence** for every `POST` case — v2's `RecordingFileStorage` records the
  same tuples as the v1 oracle's fake.
* The object path: `<type_display>/<CPython lower(name)>`, including `ΟΔΟΣ` → `οδος` and
  `XᲉ` → `xᲉ`.
* `GET /api/admin`: missing `type` → 400; any other value, `''` included → 200 and **nothing
  sent**; `email` → one mail, template `TEST`, `To` the caller only, `Bcc` empty;
  `notifications` → one SQS message with the caller's subscriptions only, `Test Notification`
  → `/`.

### 6.3 ⚠️ Data safety

* **Never point v2 at GCS with credentials.** Parity for storage is done against a fake (v2:
  `RecordingFileStorage` via `FILE_STORAGE`; v1: `probe/sitecustomize.py`). A real upload is
  outward-facing and not reversible.
* **`GET /api/admin?type=email|notifications` sends real mail and real pushes** outside a stubbed
  environment.
* File writes on a v1 oracle go to a clone, reset in place.

### 6.4 Pre-declared rows — do not re-file these

**D22** (with the §3 note), **D23**, **P3-D6**, rule **12b** (no parser narrowing — `text/plain`
is a 500 here, not a 415), and P8-D1 … P8-D7, P8-F1 … P8-F7 above.

---

## 7. To fold back into `MIGRATION_PLAN.md`

### 7.1 §3 Phase 8 *Scope* describes `save_file` incompletely

It says *"check `blob.exists()` first — only persist the `File` row if the blob did not already
exist"*. The upload is **unconditional** — the check gates only the row — and the row is written
**after** the upload, which is what makes P8-F1/F2/F3 partial writes. The *Parity criteria* line
*"no duplicate row when the blob already exists"* holds, and should gain *"and the object is
overwritten"*. P8-F1 needs an owner (business-analyst): keep, or choose a fix.

### 7.2 §5 **D22** needs a sentence for `POST /api/file`

Its pair on this route is **v1 500 (double-fault page) / v2 400**, not the pairs recorded for the
three P3 endpoints; and the "same answer as every other invalid boundary" rationale does not hold
here (§3). Decide whether D22 stands for this route.

### 7.3 P8-F4 (U+2028/U+2029) needs a cross-cutting row and an owner

It affects every JSON response, every phase. A fix is one escape step in shared rendering, but it
changes approved responses and should be decided, not slipped in.

### 7.4 Rule 12c should mention the presence helper

*"Files come from `request.files`, scalars from `request.body` — never merged"* stands. Add: *a
handler whose v1 code tests `key in request.data` observes the merge's precedence;
`common/http/drf-request-data.ts` reproduces the precedence without merging values (one caller,
`FileView.post`).*

### 7.5 P8-F5 belongs in the Phase 3 and Phase 4 notes

`readUploadedFile` now takes the last same-named part. Note it where those phases document the
bulk uploads.

### 7.6 `scripts/parity/fixture-check.sh` does not cover `fondo_api_file`

Add `count`, `maxid` and `xmin` rows for it — and re-save the baseline in the same change, or the
diff against `FINAL2-fondodev.txt` breaks.

### 7.7 Three copies of the out-of-range path-id rule

`loans/loan-path-id.ts`, `activities/activity-path-id.ts`, and now
`common/http/django-int-path-id.ts` (counted at this commit). The first two were left in their
approved phases; hoisting them onto the common one is a mechanical follow-up.

### 7.8 The board's Phase 8 row

`GET|POST /api/file`, `GET /api/file/<id>`, `GET /api/admin` implemented; v1's 8 file tests
ported; admin covered from measurement. **C71 and D39 untouched** (out of scope).
