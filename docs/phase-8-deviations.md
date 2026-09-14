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
| **Follow-up 2026-09-14** | Plan §5 **D46** (409) and **D47** (400) on `POST /api/file`, per operator Q40–Q42. See §4, §5.1, §6.1 rows 7–9, §7.9–§7.10, and the gate table below |

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

### Gate for the D46 / D47 follow-up (2026-09-14)

The baseline was re-measured at `76e3366` in this session, not copied. "After" was run on the
files whose hashes are listed in §5.1, and `sha256sum -c` passed both before and after the gate.

| | baseline (`76e3366`) | after (D46/D47) |
|---|---|---|
| `npm run lint` | exit 0 | **exit 0** |
| `npx tsc --noEmit` | exit 0 | **exit 0** |
| `npm test` | exit 0 — 2482 / 77 suites | **exit 0 — 2517 / 77 suites** |
| `npm run test:e2e` | exit 0 — 1297 passed + 2 skipped; 22 passed + 1 skipped of 23 | **exit 0 — 1331 passed + 2 skipped; 22 passed + 1 skipped of 23** |
| `fixture-check.sh \| diff - BASELINE-fondodev-2026-09-12.txt` | exit 0 | **exit 0** |
| control: `DB=fondo_api_test …` | exit 1 | **exit 1** |

**+35 unit and +34 e2e, all in two suites.** The per-suite counts come from each run's own
`--json` output, and no other suite changed:

| suite | baseline | after | Δ |
|---|---|---|---|
| `src/files/file.service.spec.ts` | 42 | **77** | +35 |
| `test/file.e2e-spec.ts` | 97 | **131** | +34 |

**Every baseline title that no longer appears is accounted for,** matched by case name against
the titles in the final run.

| suite | baseline titles gone | renamed only | **changed subject** (v1 behaviour → D46/D47) | **removed** |
|---|---|---|---|---|
| unit | 16 | 6: `M1-again-overwrite`, `M1-case-variant-same-path`, `M2-name-as-file`, `P-json-name-number` and `a JSON null name` (all five now also assert "not queried by D46"), and `M5-type-underscore` (now in the D47 accepted table) | 7: `M2-type-as-file`, `M5-type-abc`, `M5-type-1.0`, `P-json-type-list` (500 → 400); `M5-type-arabic3`, `M5-type-neg1` (201 → 400); `M5-type-int4-overflow` (object stored, then 500 → 400) | 3, listed below |
| e2e | 25 | 16: the 14 `G-type-*` query cells (unchanged: only their `describe` was renamed to "measurement 5 — int(), and D47 on top of it", and D47 does not apply to `?type=`), `M3-existing-row-no-blob` (Q41) and `M5-type-underscore` | 9: `M2-type-as-file`, `M2-type-scalar-and-file`, `M5-type-abc`, `M5-type-1.0`, `P-json-type-list` (500 → 400); `M5-type-arabic3`, `M5-type-neg1` (201 → 400); `M5-type-int4-overflow` (→ 400); `M3-cross-type` (500, then 201 on retry → 409 both times, with zero storage calls) | 0 |

The three removed unit cells:
* **`accepts the int4 bounds themselves`.** It asserted that `-2147483648` and `2147483647` are
  stored, which D47 now forbids. Its successor is the refused cell `int4 max`, alongside
  `M5-type-int4-overflow` and `int4 min - 1`.
* **`JSON numbers and booleans go through int() too`.** Its assertions moved into the D47 accepted
  table as `Z-json-type-float (int(1.5) is 1)` and `Z-json-type-true (int(True) is 1)`, with the
  same object paths. That table adds `JSON 0`, `JSON 1`, `JSON false` and `JSON 0.9`.
* **`M3-cross-type` (unit).** Its assertion, that the insert fails after the upload and the object
  stays, is now the `D46 window` cell. The assertion is the same, but it is framed as the losing
  side of the measured race, because a sequential cross-type upload can no longer reach the insert.

⚠️ **A pre-existing cosmetic defect, not introduced here and not fixed.** Measured on the final
run: **24** titles in `test/file.e2e-spec.ts` render `NaN`, because a `%i` placeholder receives a
string. They are the 10 `G-type-*` cells (e.g. `G-type-1: 200 with NaN files`) and the 14 body-shape
cells (e.g. `P-json-null → NaN, the view's own response`). Their assertions are correct; only the
titles are wrong. I fixed the same defect in the two cells I added, and left the baseline's cells
alone so this change stays scoped. The 5 unit titles that contain "NaN" name the value on purpose
and are not affected.

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
| `oracle-d46.py` → `oracle-d46-out.jsonl` (2026-09-14) | 18 cases for D46/D47 (8 `I-*`, 1 `N-*`, 3 `X-*`, 6 `Z-*`): the `int()` axes (`I-*`), a name holding U+0000 (`N-nul-name`), the case-variant corner (`X-*`), and measurement 2 against bad types and JSON types (`Z-*`). Same prologue, fake and recorders as `oracle.py`, `api.settings.test`, proxies set to a closed port, clone `fondodev_p8` only | single run; the clone was reset **in place** before and after (`reset-clone.sh`, hstore OID `3417907` kept both times). CPython `int()` also checked on its own in `python:3.9-slim --network none` |
| v2 Prisma probe (read-only, `fondo_api_test`) | `findUnique({ where: { display_name } })` with U+0000, and with a lone surrogate | U+0000 **throws** `22021`; a lone surrogate **resolves `null`** |

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
| `type` as a file part, alone or beside a `type` field | **500** before any storage call (`int(InMemoryUploadedFile)`) — ⚠️ **v2 since D47: 400** `Type must be 0 or 1`, still no storage call (§4) |
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

~~**Decided:** ported, in v1's statement order.~~ **Superseded 2026-09-14 by D46 (operator Q40):**
the exact cross-type name is now refused with 409 before any storage call; the retry is refused
too. `M3-existing-row-no-blob` is **kept** as v1 (Q41). `M5-type-int4-overflow` is now D47's 400.
The only partial writes left on this route are listed in `FileService.saveFile`'s table: the
same-type row with a missing object (Q41), a name with U+0000, and D46's concurrent window
(§4, measured).

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
  and pinned: `?type=٠`, `?type=0_0`, `?type=%201%20`, `type=" ٣ "`, `type=0_1`. ⚠️ Since D47 the
  body's `type=" ٣ "` is **refused (400)** — `int()` still reads it as 3, which is not 0 or 1 —
  and `type=0_1` is still accepted as 1. The query's `?type=` is untouched by D47.
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
non-ASCII boundary while an **empty** or **quoted** trailing-space boundary — not D22's subject — is
ported as **v1 500 / v2 500** (unmarked, no `Allow`; ⚠️ v1 sends no `Vary` and v2 sends `Vary: Origin`,
measured by `manual-tester`). An **unquoted** trailing space never reaches the multipart parser on
either stack — gunicorn and Node both strip it from the header — so that request succeeds **201 / 201**.
An earlier version of this paragraph did not distinguish the two, having been measured through Django's
test client, which keeps the space. Either D22's row should say that on
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

### Plan §5 deviations applied on `POST /api/file` (operator decisions Q40, Q42)

| # | v1 | v2 | decided by |
|---|---|---|---|
| **D46** | an exact `display_name` already stored under the **other** type: upload, then the insert fails → **500**, object orphaned; a retry → **201**, no row | **409** `{"message": "A file with this name already exists with a different type"}`, **zero storage calls**, no row | Q40 |
| **D47** | `type` not validated: non-integers **500** before storage; other integers **stored** (`3/…`, `-1/…`, `10/…`); past int4 → object stored, then **500** | unless v1's `int(type)` is **0** or **1**: **400** `{"message": "Type must be 0 or 1"}`, **zero storage calls**, no row | Q42 |

**Order, as implemented and pinned:** v1's presence check (its bodiless 400, unchanged) → D47 →
D46 → storage. Both refusals are `ApiException.deviation`, so `FileController` re-raises them past
v1's blanket `except` (no 500, no `Exception saving file` log line), and they render with the
view's `Allow` and `Vary: Accept` like any DRF `Response`. Cells: `D47 runs before D46 …`,
`presence runs first …` (e2e and unit).

#### D46 — what "exactly" means, and what is not refused

* **Exact** is PostgreSQL `=` on `text` (`findUnique({ where: { display_name } })`), the equality
  the `fondo_api_file_display_name_key` index uses. Not lowered, not trimmed, not normalised:
  `ACTA NÚMERO 1` and `Acta número 1 ` under the other type are **201 with a new row**, as v1
  (e2e `D46 neighbour — …`).
* **Not refused, ported as v1 (Q41, no log line):** the same name under the same type, including
  a case variant that lowers onto an existing object (`M1-again-overwrite`,
  `M1-case-variant-same-path`), and a same-type row whose object is missing — still upload then
  500, object stays (`M3-existing-row-no-blob`).
* ⚠️ **D46 refuses one case v1 did not orphan** — measured on v1 (`oracle-d46-out.jsonl`,
  `X-*`): with `Dup X` (type 0) and `DUP X` (type 1) stored, uploading `Dup X` as type 1 finds
  `presentations/dup x` (DUP X's object), **overwrites it and answers 201 with no orphan**. The
  exact predicate refuses it with 409. This is what Q40 specifies ("same `display_name`,
  different type"); the plan's gloss that this predicate is "precisely the case that orphans an
  upload" is not quite true — see §7.9. Pinned by `X-exact-t1-over-casevariant` (e2e, unit).
* **A name no row can hold is not queried**, so the predicate is false and v1's failure follows:
  - a `name` **file part** (with or without a `name` field) or a non-string JSON `name`: v1's
    **500 after `get_bucket`**, unchanged — D46 never reads a file as a scalar (D23), and never
    falls back to the `name` field (`Z-name-file-over-cross-type-name`, `M2-name-*`);
  - a name containing **U+0000**: measured on v1 (`N-nul-name`) as upload → insert fails → 500,
    object stays; measured on v2's Prisma (2026-09-14, `fondo_api_test`, read-only) that a lookup
    with U+0000 **throws** `22021 invalid byte sequence for encoding "UTF8": 0x00`. Querying it
    would have turned v1's sequence into a 500 with no storage calls. v2 matches v1
    (`N-nul-name`, e2e and unit).
  - Not handled, stated: a JSON `name` holding a **lone surrogate** is looked up (measured: Prisma
    resolves `null` rather than throwing), so it could 409 against a row literally named with the
    replacement character. A JSON body can never upload (P8-F7); no cell.

#### D46 — the concurrent window (measured)

Two uploads of one new name under types 0 and 1, held open at the upload
(`RecordingFileStorage.beforeUpload`) so both checks read an empty table:
**both pass D46; one answers 201 and writes the row; the other answers 500 after its upload —
and its object stays, an orphan.** The unique index keeps the table consistent; it does not
protect the bucket. A later identical upload is refused (409) — the cell's positive control.
e2e `D46 race — MEASURED …`. D46 therefore **narrows** P8-F1 to this window; it does not close it.
Closing it needs the check and the insert to bracket the upload under one lock — §7.10.

#### D47 — the predicate, as measured

The predicate is **"v1's own `int(data['type'])` returns 0 or 1"**. For a string that is
`parsePythonIntLiteral`, the grammar `pythonInt` uses (via `toDjangoInt`). Measured on v1
(`~/.fondo-parity-harness/p8/oracle-d46-out.jsonl`, 2026-09-14, clone `fondodev_p8`, reset in place
before and after) and on CPython 3.9.25 (`python:3.9-slim`, `--network none`):

| `type` | CPython `int()` | v1 | v2 |
|---|---|---|---|
| `' 1 '`, `'１'` (fullwidth), `'\xa01'` | 1 | 201 presentations | **201** (accepted) |
| `'+0'`, `'-0'` | 0 | 201 proceeding | **201** (accepted) |
| `'0_1'` | 1 | 201 | **201** (accepted) |
| `'1_0'` | **10** | 201, stored `10/…` | **400** |
| `'＋1'` (fullwidth plus), `'\x1c1'` | `ValueError` | 500 before storage | **400** |
| `'abc'`, `'1.0'`, `''` | `ValueError` | 500 before storage | **400** |
| `'-1'`, `' ٣ '`, `'2'` | −1, 3, 2 | 201, stored | **400** |
| `'2147483648'`, `'-2147483649'` | int | object stored, then 500 | **400**, nothing stored |
| a `type` **file part** (alone or beside a field) | `TypeError` | 500 before storage | **400** |
| JSON `null`, `[0]`, `{}`, `2` | `TypeError` / 2 | 500 | **400** |
| JSON `1.5`, `true` | 1 | 500 after `exists` (no file) | **500 after `exists`**, unchanged |

⚠️ **The file-part row is a registered consequence, not a guess.** The operator's decision is
"anything other than the integer 0 or 1 is refused"; `int()` of a file part is not the integer 0
or 1, and v1 already failed there before any storage call, so nothing but the status changes
(500 → 400). Pinned: `M2-type-as-file`, `M2-type-scalar-and-file`, `Z-type-file-name-cross`.
⚠️ **JSON `1.5` / `true` pass** because `int()` truncates them to 1, as v1 did; flagged in §7.9.

### Findings (v1 behaviour — for business-analyst / operator)

**P8-F1 — the cross-type duplicate is a self-perpetuating partial write.** ✅ **Decided (Q40):
refused before upload — D46**, above. Residual, measured: the concurrent window still orphans. One
live consequence to know before cutover still stands: a v1 upload may already have left such an
orphan in `fonmon`; nothing in the database can show it.

**P8-F2 — an upload silently replaces another row's object.** ✅ **Kept (Q41)** — ported as v1,
no refusal, no log line. Paths are lowercased; names are not. `NEW FILE` over an existing
`New file` (same type) overwrites its bytes, writes no row, answers 201, and the list keeps
showing `New file`. Measured (`M1-case-variant-same-path`).

**P8-F3 — `type` is not validated.** ✅ **Decided (Q42): refused — D47**, above.

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

### 5.1 D46 / D47 mutation controls (2026-09-14)

**Measured on the committed code — these exact files** (`mutation-targets-d46.sha256`, hashed
immediately before the run):

| file | sha256 |
|---|---|
| `src/files/file.service.ts` | `723903b852ddfc3b5fae97dd42b9f396ebf794950db5a4a994bd48112e03cdfe` |
| `src/files/file.controller.ts` | `23ccac912a73f0d627487bcb9e0ea021543191e85961f0fb677d5c9c1e57ee7f` |
| `src/files/file.service.spec.ts` | `6e6a30802b7242335c141ec7a4995af586fe9c20fe74dca51a9a95a80a15cbc6` |
| `test/file.e2e-spec.ts` | `e7fd7a57cc3d1a27ba48bf53be79bf8955283356c4f407d2f4d907b56fff42e4` |

The run went from 2026-09-14 07:07:28 to 07:13:00 (-05:00), with no edits to the tree in between.
When it finished, `sha256sum -c mutation-targets-d46.sha256` exited 0, and all four files were OK.
Anyone can check that these hashes match the commit that carries this document.

Runner `~/.fondo-parity-harness/p8/mutate-d46.py`: all **19 definitions** (17 mutants and 2 blind
controls) ran in **one run**. Raw results are in `mutants-d46-final.jsonl`, and the jest JSON for
each run is in `mutants-d46/`. The rules are the same as above. Each anchor must occur exactly
once. Every touched file is restored and hash-checked after each mutant. A suite that does not
compile, or has zero assertions, is **INVALID**. Both suites (`file.service.spec.ts`,
`test/file.e2e-spec.ts`) run for every mutant.

**Result: 17 mutants planted: 17 killed, 0 survived, 0 invalid. The 2 blind controls: both
survived, which is their expected outcome, and neither was invalid.** The blind controls are not
counted in the 17.

| # | wrong implementation | unit | e2e | named e2e cells that fail (abridged) |
|---|---|---|---|---|
| D46a | name compared case-insensitively | 35 ⚠️ | **2** | `D46 neighbour — a case variant under the other type is NOT refused`, `X-exact-t1-over-casevariant` |
| D46b | the same type refused too | 3 | 2 | `M1-again-overwrite`, `M3-existing-row-no-blob (Q41, not refused)` |
| D46c | checked after uploading | 3 | 6 | `M3-cross-type → D46`, `D46 a seeded type 0/1 row` (×2), `X-exact-…`, `a JSON body naming a cross-type file`, `D46 race` |
| D46d | checked after `get_bucket`/`blob`/`exists`, before the upload | 3 | 6 | the same six |
| D46e | the lowered name queried | 5 | 6 | the same six; unit adds `compares the name exactly as sent` |
| D46f | the U+0000 guard dropped | 1 | 1 | `N-nul-name` |
| D46g | a `name` file part read as its filename (the D23 shape) | 1 | 1 | `Z-name-part-FILENAME-is-a-cross-type-name` |
| D46h | refusal not flagged `isDeviation` (laundered into a 500) | 4 | 6 | the D46 six |
| D47a | `Number()` instead of `pythonInt` | 8 | 7 | `M5-type-1.0`, `an empty type`, `accepts M5-type-underscore`, `accepts I-fullwidth1`, `P-json-type-list`, `Z-json-type-null`, `Z-json-type-float` |
| D47b | a regex (`/^[+-]?\d+$/` on `trim()`) instead of `pythonInt` | 7 | 5 | `accepts M5-type-underscore`, `accepts I-fullwidth1`, `P-json-type-list`, `Z-json-type-float`, `Z-json-type-true` |
| D47c | runs after D46 | 22 | 3 | `D47 runs before D46 — … type=abc` / `type=5`, `Z-type-file-name-cross` |
| D47d | runs before the presence check | **0** | 3 | `presence runs first — P-mp-missing-name, with type=abc`, `… P-mp-missing-file, with type=5`, `P-json-missing-file` |
| D47e | a `type` file part parsed by its content (the D23 shape) | 3 | 3 | `M2-type-as-file`, `M2-type-scalar-and-file`, `Z-type-file-name-cross` |
| D47f | checked after `get_bucket` | 26 | 27 | every D47 400 cell, plus the D46 cells (through their storage-call counts) |
| D47g | the other reading of "parses": only strings may pass | 6 | 5 | `Z-json-type-float`, `Z-json-type-true`, `a JSON body naming a cross-type file`, `P-json-all-keys`, `P-json-name-number` |
| D47h | refusal not flagged `isDeviation` | 23 | 21 | every D47 400 cell |
| CTL | the controller's re-raise removed | **0** | 27 | every D46 and D47 refusal cell |
| D46d-blind | D46d, with every `expect(storage.calls).toEqual([])` stripped from both specs | 0 | 0 | **survived**, as expected |
| D47f-blind | D47f, stripped the same way | 0 | 0 | **survived**, as expected |

**What the blind controls show.** A check that runs after the storage **reads** (`get_bucket`,
`blob`, `exists`) but before the upload still answers the right status, writes no object and adds
no row. The storage-call count assertion is the **only** guard against it, at both layers. Without
it, D46d and D47f pass every cell.

**Where only one layer catches a mutant:**
* **D47d** and **CTL** are caught only end to end. The presence check and the re-raise live in the
  controller, and no unit spec covers the controller.
* ⚠️ **D46a's 35 unit failures are mostly an artefact, not detection.** The mutant calls
  `findFirst`, which the unit mock does not define, and 24 of the 35 fail with `findFirst is not a
  function`. The **2 e2e cells** are the real kill: they run the `mode: 'insensitive'` query
  against PostgreSQL. No unit cell is claimed for D46a.

⚠️ **Two earlier runs are superseded, and neither is evidence for this code.** Both are kept in
`~/.fondo-parity-harness/p8/mutants-d46-superseded/`.
1. **An instrument defect.** In the first run, both blind controls were **INVALID**, not
   survived. Stripping the assertion to `void 0;` left `storage` unread in some unit cells, so
   `TS6133` stopped the unit suite from compiling, and it ran zero assertions. The runner now
   strips it to `void storage.calls;`. A rerun of the two blind controls then survived.
2. **Measured on files that changed afterwards.** After both earlier runs I edited
   `file.service.ts`, `file.service.spec.ts` and `test/file.e2e-spec.ts`: two docblocks, and two
   test titles whose printf placeholders rendered `NaN`. The coordinator found the stale hashes.
   Because the pre-edit content was not kept, nothing on disk could show those edits were
   harmless, so **all 19 definitions were re-run** on the final files (above).

**How the final run compares with the superseded one,** checked per mutant, per layer, per named
cell: every mutant failed the **same number** of cells in each layer. The only differences are
the renamed titles of the two cells whose placeholders I fixed. No cell started or stopped
catching a mutant.

---

## 6. For `manual-tester`

### 6.1 Expected diffs against v1 — read these as **expected**

| # | what to expect |
|---|---|
| 1 | P8-D1: tied `created_at` rows may come back in a different relative order |
| 2 | P8-D4: uncaught 500s are zero bytes in v2, HTML in v1; status matches. ⚠️ **Headers do not all match** (measured by `manual-tester`, `docs/parity-phase-8.md` §2.4): on an init-time multipart 500, such as an empty boundary, v1 serves gunicorn's page with **no `Vary`** while v2 sends **`Vary: Origin`**. An earlier version of this row said the headers matched. |
| 3 | §3: a **non-ASCII boundary** on `POST /api/file` is **400** in v2, **500** in v1 (D22, flagged) |
| 4 | P8-F4: a name containing U+2028/U+2029 renders raw in v2, escaped in v1 |
| 5 | P8-F5: two `file` parts on `PATCH /api/user` / `PATCH /api/loan` — v2 now matches v1 (the **second** part); a Phase 3/4 baseline recorded before this commit will differ |
| 6 | P8-D3: a file part with no `Content-Type` may be stored with a guessed type |
| 7 | **D46** — an exact `display_name` stored under the **other** type: v1 **500** (object written; `M3-cross-type`) or v1 **201** (a retry, or an object already at that path — `M3-cross-type-retry`, `X-exact-t1-over-casevariant`) → v2 **409** `{"message":"A file with this name already exists with a different type"}`, **no storage call** in v2. Also a JSON body naming such a file: v1 500 → v2 409 |
| 8 | **D47** — `type` whose `int()` is not 0 or 1: v1 **201, stored** (`-1`, `3`, `' ٣ '`, `1_0`, …), v1 **500 with the object stored** (past int4), or v1 **500 before storage** (`abc`, `1.0`, `''`, `＋1`, U+001C, a `type` **file part**, JSON `null`/list) → v2 **400** `{"message":"Type must be 0 or 1"}`, **no storage call** in v2. A JSON `type` of `2` (v1 500 after `exists`) is 400 too |
| 9 | Only **D47 then D46** change a status. Where both apply, v2 answers **400** (e.g. `Acta número 1` with `type=abc`). The bodiless 400 of a **missing** key is unchanged, whatever `type` says |

### 6.2 Explicitly **unchanged** — if these differ, that IS a failure

* The D46/D47 **non-refusals**: same name + same type (overwrite, 201, no row); a same-type row
  whose object is missing (500, object written); a case variant or a trailing-space variant under
  the other type (201, new row); `type` of `' 1 '`, `'１'`, NBSP+`1`, `'+0'`, `'-0'`, `'0_1'` (201);
  a `name` **file part** — even one whose *filename* is a stored name — (500 after `get_bucket`);
  a name containing U+0000 (500 after the upload, object written); JSON `type` `1.5` / `true`
  (500 after `exists`).

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

**D22** (with the §3 note), **D23**, **D46**, **D47** (§4, with §6.1 rows 7–9), **P3-D6**, rule
**12b** (no parser narrowing — `text/plain` is a 500 here, not a 415), and P8-D1 … P8-D7,
P8-F1 … P8-F7 above. **D46's concurrent window** (§4) is a known, measured residual: an orphan
object after a v2 500 in a two-request race is not a new finding.

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

### 7.9 D46 / D47 — what the plan rows should say, and four points they leave open

The rows can move to ✅ implemented. Wording corrections, each measured (§4):

1. **D46's gloss "precisely the case that orphans an upload" is not exact, in either direction.**
   - **Wider than the orphan:** when a case variant of the name already has an object under the
     requested type (`Dup X` t0 + `DUP X` t1, then `Dup X` t1), v1 **overwrote and answered 201
     with no orphan**; D46 refuses it (409). This follows Q40's predicate as written; I did not
     narrow it. Operator: confirm that refusal is wanted (I read it as desirable: the upload
     would otherwise have silently replaced `DUP X`'s document — P8-F2's hazard).
   - **Narrower than the orphan:** two concurrent cross-type uploads still orphan (measured,
     §4 "concurrent window"). So do the cases Q41 keeps (same-type row, missing object) and a
     name with U+0000.
2. **D47's "parses with `pythonInt`" is defined only for strings.** Multipart and form values are
   always strings, so every body that can upload is covered exactly. For the rest I implemented
   "v1's own `int(type)` is 0 or 1": a `type` **file part**, JSON `null` / list / object → **400**;
   JSON `1.5` / `true` / `0.9` / `false` → **pass** (`int()` truncates), then v1's 500 at
   `.content_type`. No 201 depends on it (P8-F7). The strict alternative ("only a string may
   pass") is mutant **D47g**, and the cells that pin the choice are named in §5. Operator /
   business-analyst to confirm, or say "strings only".
3. **The file-part `type` row is a status change on a case v1 already refused before storage**
   (500 → 400). I applied D47 because `int()` of a file is not "the integer 0 or 1"; if the
   operator meant D47 to change only requests that reach storage, that one row reverts to 500.
4. **Both refusals are reached only by ADMIN** (`FileView` `POST 0`), after authentication and
   the role check, so D46's 409 is not a name-existence probe for other roles (e2e cell
   `a MEMBER is refused by the role guard (403) before D46 runs …`). Listing names is already
   `GET 3`, so the 409 discloses nothing new to anyone.

### 7.10 D46's concurrent window — if the operator wants it closed

Measured (§4): both checks pass, the loser orphans. The mechanism that would close it within one
database is to **hold a transaction-scoped advisory lock keyed on `display_name` from the check
through the insert**, with the upload inside (`pg_advisory_xact_lock(hashtext(name))` in a
`prisma.$transaction`). That keeps a connection and a transaction open for the whole upload — a
real cost on a pool — and changes the D46 unit of work, so it is a decision, not a fix I slipped
in. At the fund's volume (37 documents in about six years, one admin) the window needs two
concurrent uploads of the same name under different types. Not implemented.
