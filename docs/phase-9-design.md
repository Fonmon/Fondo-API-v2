# Phase 9 — step 6 design, measurements and proof

**Status:** stage 1 **approved with conditions** at `4db69fb`; the conditions (C94, C95, C96,
N3, N4, m4, m8) landed at `5d019d9`, and **stage 2a** — Release B's code — landed on top. The conversion SQL, the mutation
controls and the C39 finding stood; the runbook and the release ordering did not, and under
**Q56** they sat on the one-way door.

**Stages, renamed to match conditions C92 and C93:**

| stage | contents | when |
|---|---|---|
| **1** | measurements, the four step-6 migrations, the clone proof, the mutation controls, the Release A boot guard, this design | now |
| **2a** | ✅ **landed.** Release B's code: hstore codec deleted, the two raw-SQL repositories on Prisma models, `Json @db.JsonB` + the two `@unique`s, the guard's `jsonb` half, **C91's `p256dh, auth` pin on the SQS emit path**, **the provisioner's second `migrate deploy`** (C94); C83, C90 | **before cutover step 3** (C93) |
| **2b** | move `prisma/migrations-step6/*` into `prisma/migrations/` and delete `PRISMA_MIGRATIONS_PATH` — **that is all of stage 2b** (C94) | **after step 6 has run in production** (C92) |

**Nothing here touched production or `fondodev`.** Every measurement against `fondodev` ran
with `SET default_transaction_read_only = on`; every migration ran on a clone
(`fondodev_p9` on 18.6, `fondodev_p9_17` on 17.11, and scratch copies made from them with
`CREATE DATABASE ... TEMPLATE`) or on `fondo_api_test`. `prisma migrate dev` was never run
anywhere.

---

## 1. Measurements — `fondodev`, read-only, 2026-09-15

`SET default_transaction_read_only = on` on every session. Dump for the clones:
`~/.fondo-parity-dumps/p9-20260915-054421-stage1/`.
**Independently re-measured by `nestjs-reviewer`** on the same data: 626, 94, 626/626 arrays,
0/94 quotes, 0 duplicate groups, exactly two hstore columns in the database, and **no
dependent index or view on either column**.

### 1.1 The two hstore columns

| | `fondo_api_schedulertask.payload` | `fondo_api_notificationsubscriptions.subscription` |
|---|---|---|
| rows | **626** | **94** |
| column | `hstore NOT NULL` | `hstore NOT NULL` |
| `NULL` columns | 0 | 0 |
| empty hstore (`''`) | 0 | 0 |
| id range | 65 … 2528, all distinct | 115 … 1468, all distinct |

**Key sets.** `payload` has exactly one shape across all 626 rows:
`message, owner_id, target, type, user_ids`. `subscription` has two:
`endpoint, expirationTime, keys` (**93** rows) and `endpoint, keys` (**1** row — the key is
absent, not null).

**Per-key value shapes.**

| column | key | rows | SQL NULL values | shape |
|---|---|---|---|---|
| payload | `type` | 626 | 0 | `birthdate` (86), `payment_reminder` (540) |
| payload | `owner_id` | 626 | 0 | all `^[0-9]+$`, 1–3 chars — **a string**, not a number |
| payload | `target` | 626 | 0 | `/` or `/loan/<id>` |
| payload | `message` | 626 | 0 | 41–78 chars, **626 of 626 contain non-ASCII**; 0 contain `"`, `\`, `'` or a control character |
| payload | `user_ids` | 626 | 0 | **doubly stringified**: 626/626 parse as JSON, all `array`, 1582 elements all `number`; 626/626 match Python's list repr `[n, n, …]` |
| subscription | `endpoint` | 94 | 0 | 188–198 chars, 0 non-ASCII, 0 `"`, 0 `\` |
| subscription | `expirationTime` | 93 | **93** | SQL NULL in every row that has the key |
| subscription | `keys` | 94 | 0 | **doubly stringified**: 0/94 valid JSON as stored, **94/94 valid after v1's `'` → `"` repair**, all objects, all `{auth, p256dh}`, all 135 chars, **all stored in `p256dh, auth` order** (§5.3) |

**Values that are not valid JSON where JSON is expected: none.** `user_ids` 0 of 626
unparseable; `keys` after `replace("'", '"')` 0 of 94 unparseable and **0 of 94 already
containing a `"`**, so v1's blunt replacement is lossless on every live row.

⚠️ **These are `fondodev`'s shapes. Production's are unmeasured** — this workstation cannot
reach it — and the preflight migration (§3) is the only thing between production's data and
the one-way door. That is why every one of its checks is a stop rather than a repair.

**No stop condition was hit.**

### 1.2 Duplicates that would block D6 and D11

| deviation | table.column | rows | distinct | NULLs | duplicate groups |
|---|---|---|---|---|---|
| **D6** | `fondo_api_loandetail.loan_id` | 374 | 374 | 0 | **0** |
| **D11** | `fondo_api_userfinance.user_id` | 15 | 15 | 0 | **0** |
| **D11** | `fondo_api_userpreference.user_id` | 15 | 15 | 0 | **0** |

All three are `integer NOT NULL`, each already carrying Django's non-unique btree index
(kept — operator answer **Q58**) and its primary key on `id`; no unique constraint on the
target column exists yet.

**No stop condition was hit.** ⚠️ A measurement at one instant, not a guarantee: v1 is still
live. The preflight re-runs all three checks at deploy time, **before** the conversion.

### 1.3 The two ledgers (D34)

```
django_migrations   : 38 rows, newest applied 2022-03-13 17:54:53.438538+00
_prisma_migrations  : 1 row
  id                  9fad2d6f-aead-48a1-a635-b2bf5bc675a6
  checksum            a5d98fdb141098e620c7abde360e40253b40076eddf7c409ca5be359687c38eb
  migration_name      0_init
  started_at          2026-08-30 18:47:20.840234+00
  finished_at         2026-08-30 18:47:20.840234+00   (equal to started_at)
  rolled_back_at      NULL
  logs                NULL
  applied_steps_count 0
```

Extensions: `plpgsql`, **`hstore` 1.8**, `pageinspect`.

---

## 2. D34 / C39 — what Prisma 7 does with an `applied_steps_count = 0` baseline

The plan's rule is *"`0_init` stays at `applied_steps_count = 0` — do not repair it to 1."*
**Measured on clones, Prisma 7.10.0, on both server versions:**

| id | what was run | 18.6 | 17.11 |
|---|---|---|---|
| **M-D34-1** | `migrate status` + `migrate deploy`, only `0_init` in the directory | `Database schema is up to date!` / `No pending migrations to apply.` exit 0; the `0_init` row byte-identical afterwards | — |
| **M-D34-2** | `migrate deploy` from a directory that does **not** contain `0_init` | applies the new migration, exit 0; `0_init` untouched at 0; the new row at 1. Prisma does not object to a ledger row with no file | — |
| **M-D34-3** | `migrate deploy` of the four step-6 migrations | all four applied, exit 0, `0_init` still **0** | **same** — `0_init\|0` then four rows at `\|1` |
| **M-D34-4** | `ALTER … ADD COLUMN`, `UPDATE`, `SELECT 1/0` in one file | `P3018`, exit 1, **and the column is still there** — a migration file is **not** atomic by default; the ledger row then blocks every later deploy with `P3009` | **same** (`zz_probe_columns=1`) |
| **M-D34-5** | the same file wrapped in `BEGIN; … COMMIT;` | exit 1 and **the column is gone** — atomic | **same** (`zz_probe_columns=0`) |
| **M-D34-6** | `RAISE EXCEPTION` *inside* `BEGIN; … COMMIT;` | the operator sees `ERROR: current transaction is aborted…` — the RAISE text is **lost** | **same** |
| **M-D34-7** | the same `RAISE` as the first statement, no explicit transaction | `P3018 … P0001 … ERROR: STEP6 PREFLIGHT FAILED: 3 unparseable rows: {1,2,3}` — verbatim | **same** |
| **M-D34-8** | edit an **already-applied** migration file (append a comment) and re-run `migrate deploy` | `No pending migrations to apply.`, **exit 0** — `deploy` keys on the migration *name* and does **not** verify the checksum of an applied migration | — |

⚠️ **M-D34-8 cuts both ways.** It is why a documentation-only edit to
`_step6_preflight/migration.sql` (condition **C99**) is safe against every database that has
already applied it — measured on `fondo_api_test`, not assumed. It is also why **a change to
that file's SQL would not be noticed either**: a database that ran the old version reports
itself up to date. Before step 6 runs in production that is harmless, because no production
database has applied anything; after it, treat these four files as frozen and add a new
migration instead.

**Finding: no conflict with the plan.** Prisma treats a migration as applied when
`finished_at IS NOT NULL AND rolled_back_at IS NULL`; `applied_steps_count` is informational
and is not consulted. `migrate deploy` neither re-applies `0_init` nor rewrites it. D34 stands
as written and **C39 can close on this evidence.**

M-D34-4…7 are why the migrations are split the way they are: **assertions an operator must
read go in an unwrapped, write-free migration; anything that writes goes inside
`BEGIN; … COMMIT;`.**

---

## 3. The migrations

`prisma/migrations-step6/`, four files, `migrate deploy` only:

| order | migration | contents | transaction |
|---|---|---|---|
| 1 | `20260915120000_step6_preflight` | seven stop conditions, below | none, by design (M-D34-7) |
| 2 | `20260915120100_hstore_to_jsonb` | two `ALTER COLUMN … TYPE jsonb USING hstore_to_jsonb(…)`, two repair `UPDATE`s, four in-transaction post-conditions | `BEGIN; … COMMIT;` |
| 3 | `20260915120200_loandetail_unique_loan_id` | **D6** `UNIQUE (loan_id)` | single statement |
| 4 | `20260915120300_userfinance_userpreference_unique_user_id` | **D11** `UNIQUE (user_id)` on both tables | `BEGIN; … COMMIT;` |

**The preflight's seven checks**, each naming the offending rows or objects:

1. both columns are still `hstore` (so a second run stops rather than half-converting), and
   `hstore_to_jsonb(hstore)` resolves on the connection's `search_path`;
2. every `payload->'user_ids'` parses as JSON (`json.loads`);
3. every `subscription->'keys'` parses **after** the `'`→`"` repair, and none already contains
   a `"`;
4. no duplicates blocking **D6** or **D11** — deliberately *before* the one-way door, so a
   duplicate that appeared since §1.2 is not discovered with the door already shut;
5. **(added this round, review M2)** no `user_ids` that parses but is still a JSON *string*
   (`"\"[1,2]\""`) — unwrapping that once leaves a string where the application expects a
   list. A *scalar* (`json.loads('7') → 7`) is **not** rejected: that is what v1 hands the
   application;
6. **(added, M2)** no `keys` whose repaired value is not a JSON **object**;
7. **(added, M3; rewritten, C95)** no dependent object on either column. Both an index and a
   view/rule make `ALTER COLUMN … TYPE` fail *inside* the wrapped conversion, where M-D34-6
   masks the message; detecting them here is the whole point of the two-file split.

   ⚠️ **C95 — the first version could not see an expression index.** It joined `pg_attribute`
   on `a.attnum = ANY(i.indkey)`, and `indkey` holds **0** for an expression column, so
   `CREATE INDEX … (akeys(payload))` returned nothing from the preflight and then aborted the
   conversion with the masked message (measured by `nestjs-reviewer` on a scratch 17 clone).
   The check is now a **`pg_depend` sweep** on the column itself
   (`refclassid = 'pg_class'`, `refobjsubid = attnum`, `deptype <> 'i'`), with the `pg_rewrite`
   branch kept only so a view is named as *"view/rule X on Y"* rather than as an anonymous
   rewrite rule. Measured to catch four kinds where the old one caught one:

   | seeded object | old check | new sweep |
   |---|---|---|
   | `USING gin (payload)` — a plain column index | caught | `index step6_dependent_probe` |
   | `(akeys(payload))` — an **expression** index | **missed** | `index step6_expr_probe` |
   | `(id) WHERE payload ? 'type'` — a **predicate** reference | **missed** | `index step6_partial_probe` |
   | `CHECK (akeys(payload) IS NOT NULL)` | **missed** | `constraint step6_check_probe on table …` |
   | `CREATE VIEW … SELECT id, payload` | caught | `view/rule _RETURN on step6_view_probe` |

   ⚠️ **One deliberate exclusion, and it is version-dependent.** **PostgreSQL 18 materialises
   `NOT NULL` as a `pg_constraint` row** (`contype = 'n'`, `deptype = 'a'`) that depends on the
   column; **17 does not**. Measured 2026-09-15 on the reference clones: the unfiltered sweep
   returns `constraint fondo_api_schedulertask_payload_not_null` and the subscription one on
   **18.6**, and **nothing on 17.11**. `ALTER COLUMN … TYPE` carries a NOT NULL across without
   complaint, so `contype = 'n'` is excluded — a correct exclusion, not a convenient one, and a
   cell pins that it was not widened to "ignore constraints", which would hide the CHECK above.
   This is the first cross-version difference the 17-vs-18 work has actually turned up.

### 3.1 Where the directory lives, and why — condition C92, operator answer Q56

**`prisma/migrations-step6` stays outside `prisma/migrations` through Release B.** Step 6 is an
**operator-run `migrate deploy` against that directory**, never something a deploy performs.
The directories move in only in **stage 2b**, after step 6 has run in production — and that
move is *all* stage 2b is (C94).

Three reasons, in order of weight:

1. **Q56 — production deploys run `prisma migrate deploy`.** A one-way conversion sitting in
   the default ledger fires on the next routine deploy, unattended.
2. **A failed step-6 migration in the default ledger bricks the pipeline in both directions.**
   Measured (M-D34-4): a failure writes a `_prisma_migrations` row with `finished_at IS NULL`,
   and every later `migrate deploy` then exits `P3009` — **including a redeploy of Release A**.
   During an outage the operator would be unable to roll forward *or* back without running
   `prisma migrate resolve` by hand on production.
3. **Release A cannot run on the converted schema.** Measured, 2026-09-15: the step-6
   migrations applied to `fondo_api_test`, then two Release-A suites run against it —
   `notification.e2e-spec.ts` + `scheduler-task.e2e-spec.ts` → **25 failed, 1 skipped, 12
   passed, 38 total**. (`fondo_api_test` was dropped and re-provisioned afterwards.)

So `prisma.config.ts` resolves the ledger from `PRISMA_MIGRATIONS_PATH`, default
`prisma/migrations`, and **prints the resolved path on every invocation** so a leftover is
visible in a deploy log rather than inferable from which migrations ran.

⚠️ **A warning was not enough — condition C96.** The reviewer accepted the warn-on-non-default
shape as correct but named a residual that is real: a `PRISMA_MIGRATIONS_PATH` left behind in a
task definition or a parameter store converts **production** on a routine deploy; and because
Release A carries the step-6 directory through cutover by design, that same build's
`SchemaShapeGuard` then refuses to start. The door fires, the service is down, rollback is
dead — from a deploy nobody was watching.

A non-default ledger therefore now needs a **second** variable carrying **today's date in
Bogotá**, or the CLI refuses:

```bash
PRISMA_MIGRATIONS_PATH=prisma/migrations-step6 \
  STEP6_CONFIRM=$(TZ=America/Bogota date +%F) \
  npx prisma migrate deploy
```

Two properties, both deliberate: **a leftover goes stale at the next Bogotá midnight**, so the
failure mode is "a deploy errors tomorrow" rather than "a deploy converts production next
month"; and **the door needs two correct variables set on purpose**, one of which cannot be
copied from yesterday's runbook without editing. The zone is Bogotá for the same reason
everything else here pins it (§4 rule 5): `date +%F` on a UTC host after 19:00 Bogotá already
reads tomorrow, and the gate would refuse a correct operator.

The decision is a pure function in `src/config/step6-migrations-path.ts` — no clock, no
`process.env`, no `console` — so each refusal shape has a cell. Measured through the real CLI
against a clone:

| variables | result |
|---|---|
| neither set | `prisma migrations ledger: prisma/migrations`, exit 0 |
| `PRISMA_MIGRATIONS_PATH=prisma/migrations` (what `test-database.ts` pins) | same; **no confirmation demanded**, or every e2e run would need one |
| step-6 path, no `STEP6_CONFIRM` | `REFUSING: … STEP6_CONFIRM is not set`, exit 1, with the exact command |
| step-6 path, `STEP6_CONFIRM=2026-09-14` | `REFUSING: STEP6_CONFIRM="2026-09-14" is not today in America/Bogota (2026-09-15)`, exit 1 |
| step-6 path, malformed (`2026-9-15`, ` 2026-09-15`, `today`, `true`, …) | `REFUSING: … is not a YYYY-MM-DD date`, exit 1 |
| step-6 path + today | proceeds, with `WARNING: … confirmed for 2026-09-15 … ONE-WAY` |

`test/test-database.ts` **pins** the variable to `prisma/migrations` (review m3) rather than
inheriting it, so a developer with the step-6 path exported cannot have the e2e suite convert
`fondo_api_test`; that pin is the reason the gate exempts the default value explicitly.

⚠️ **The provisioner's second run is stage 2a, not 2b — condition C94.** When Release B's code
lands, `fondo_api_test` must be built by **two sequential `migrate deploy` runs** —
`prisma/migrations`, then `prisma/migrations-step6` — **in the same commit as the codec
deletion**, and *not* by moving the directory.

The trigger and the label have to agree, because the failure mode is specific: a developer
starting stage 2a finds **every e2e suite dying at bootstrap on `SchemaShapeError`** — Release
B's guard requires `jsonb`, and `fondo_api_test` is still provisioned from `prisma/migrations`
alone — and the shortest visible way out is `git mv prisma/migrations-step6/* prisma/migrations/`.
That re-arms the one-way door in the ledger every production deploy applies: **C92 defeated by
the document written to enforce it.** The fix is the second run, not the move.

The "until then it must NOT be added, or Release A's own suites stop passing" caveat stays, and
is exactly why it belongs in that commit rather than earlier. The note is in
`test/test-database.ts` beside the call.

### 3.2 What the conversion does to each value

`hstore_to_jsonb` (strict) reproduces hstore's storage exactly: every value becomes a JSON
**string**, a SQL NULL value becomes JSON `null`. The repair pass then unwraps, once and
permanently, the two values v1 unwraps on **every** read:

| column | key | v1 read path | after |
|---|---|---|---|
| `payload` | `user_ids` | `json.loads(payload["user_ids"])` | JSON array |
| `subscription` | `keys` | `json.loads(keys.replace("'", '"'))` | JSON object |

Everything else stays a JSON string. **`owner_id` is `"53"`, not `53`** — confirmed by
`business-analyst` (`docs/ba-phase-9-step6-questions.md`), which also corrected a premise in
the first draft of this document: `owner_id` **never reaches the SQS body** (v1's executer
publishes only `user_ids`, `message`, `target`), and it is **overloaded** — a *member* id on
the 86 birthday rows and a *loan* id on the 540 payment reminders — so a numeric type would
imply an entity it does not have. The observable cost of a mixed-type slip is member-visible
twice: a missed dedupe sends the same reminder twice in a day, and a missed delete sends
reminders for a loan already paid. `hstore_to_jsonb_loose` would convert it; post-condition (c)
stops that and mutant **MU3** is the control on the post-condition.

The repair predicate is `jsonb_typeof(payload -> 'user_ids') = 'string'` — the precise meaning
of "doubly stringified". Absent, SQL NULL (now JSON `null`) and already-structured values are
skipped, which also makes both statements idempotent (blind control **B2**).

### 3.3 The conversion verifies itself

Inside the same transaction as the `ALTER`s, it captures the v1-decoded value of every entry
**before** anything changes (`step6_decoded_before`, `ON COMMIT DROP`), and afterwards asserts:

- **(a)** every `table#id.key` decodes to the same value — a `FULL OUTER JOIN`, so a lost or
  gained entry is a mismatch too;
- **(b)** no row lost and none gained — *a key-wise check cannot see an empty-hstore row
  disappear, because it contributes no keys to either side* (mutant **MU7**);
- **(c)** nothing outside `user_ids` / `keys` stopped being a JSON string (mutant **MU3**);
- **(d)** nothing is still doubly stringified (mutant **MU1**).

Any of these rolls the whole transaction back. The cost is M-D34-6's masked message; the
readable diagnosis is the preflight, which writes nothing and can be re-run at will.

---

## 4. The proof on a clone

`scripts/parity/step6-prove.sh <pristine-clone> <scratch-run-db> [outdir]`. It never writes to
the pristine clone: the run database is `CREATE DATABASE … TEMPLATE`d from it (measured to
preserve the hstore type OID, so false-green #23's mechanism cannot re-enter through the copy).

### 4.1 What it compares

| line | content |
|---|---|
| `entries` | **3411** `(table, id, key)` entries — 626×5 + 94×3 − 1 (the row without `expirationTime`) — v1-decoded from hstore vs the jsonb now stored |
| `rows` | **720** row identities (626 + 94) |
| `keyorder` | **720** rows' *emitted* key order. PostgreSQL orders hstore entries by (key length, key bytes) and v1 `json.dumps`es that dict onto the SQS wire (plan §2); jsonb sorts object members by the same rule — **measured on all 720 rows**, not assumed. ⚠️ Top level only; the nested `keys` object is §5.3 |
| `reverse` | **65** lines: `count` for all 24 tables, a **content digest** for the 21 tables the migration must not touch, and `last_value` for all 20 sequences |

⚠️ **`reverse` is content digests, not `count(DISTINCT xmin)` — review finding M6.** xmin
cardinality is 1 for every table straight after a `pg_restore` and stays 1 when a single
transaction rewrites a whole table, so as a "nothing else changed" probe it was nearly blind.
It is now `md5` over `row_to_json` per row, sorted by its own text so no primary key is
assumed, under a fixed `TIME ZONE`. The two converted tables are counted but not digested —
their content is supposed to change shape, and `entries`/`rows`/`keyorder` cover it — and
`_prisma_migrations` is printed rather than hidden.

### 4.2 Controls — each comparison is shown to be able to fail

Four controls, **each starting from a freshly rebuilt and freshly migrated run database**, so
a control's diff is caused by that control alone. (The first version ran them cumulatively,
and control 4's diff then included control 2's deleted row — evidence that is partly somebody
else's corruption.)

| control | corruption | comparison that must notice | measured |
|---|---|---|---|
| `entries` | one `message` changed | `entries` | 2 differing lines |
| `rows` | one row deleted | `rows` | 1 differing line |
| `keyorder` | `message` renamed to the shorter `msg` | `keyorder` | 2 differing lines |
| `reverse_digest` | one row touched in the **unrelated** `fondo_api_loan` | `reverse` | 2 differing lines |

⚠️ **The `keyorder` control is stated as a measurement, not as isolation.** jsonb's member
order is a function of the key *set*, so a pure reordering with the same keys is
unconstructible; the control necessarily moves `entries` too. What it shows is that the
`keyorder` comparison reports a changed order rather than passing over it. The
`reverse_digest` control is the one the old xmin probe could not have passed — the row count
does not move.

After the controls the script **rebuilds the run database and re-deploys**, then re-compares,
so the database left behind is the one the artifacts describe (review m7).

### 4.3 Results

Both runs **PASS**, with identical numbers:

| | 18.6 (`fondodev_p9` → `fondodev_p9_run`) | 17.11 (`fondodev_p9_17` → `fondodev_p9_17_run`) |
|---|---|---|
| entries | PASS, 3411 | PASS, 3411 |
| rows | PASS, 720 | PASS, 720 |
| keyorder | PASS, 720 | PASS, 720 |
| reverse | PASS, 65 | PASS, 65 |
| ledger | `count 1 → 5` | `count 1 → 5` |
| controls | 4/4 detected | 4/4 detected |
| rebuild | PASS | PASS |

And **the artifacts are byte-identical across the two server versions**: `entries.before`,
`entries.after`, `rows.after`, `keyorder.after` and the masked `reverse.after` all `diff`
clean between the 17.11 and 18.6 runs.

### 4.4 The PostgreSQL 17 re-proof — operator answer Q59

Production is **17.x**; the first proof ran on 18.6. Re-proved on **PostgreSQL 17.11 (Debian
17.11-1.pgdg13+2)**, a local `postgres:17` container on port 5433.

**What the clone is, stated plainly:** an 18.6 `pg_dump -Fc` archive cannot be restored by a 17
`pg_restore`, so the 17 clone is **not** the same artifact as the 18 one. It was built from a
**plain-SQL** dump — `pg_dump -Fp --no-owner --no-acl` taken read-only from `fondodev` on the
18.6 server — loaded into a fresh 17 database with `psql -v ON_ERROR_STOP=1`. The load is
clean and the result matches the source: **24 tables, 626 / 94 rows, 1 `_prisma_migrations`
row, 38 `django_migrations` rows, hstore 1.8**. (Its hstore type OID differs from the 18
clone's, which is expected for a different cluster and harmless here: false-green #23 is about
a long-lived **Django** process caching the OID, and no v1 process is attached to either
clone.)

Covered on 17:

- the dump/restore path (above);
- `hstore` extension **1.8**, and `to_regprocedure('hstore_to_jsonb(hstore)')` resolves on the
  target's `search_path` (`"$user", public`) — recorded in the proof artifacts as
  `server.txt`, together with `server_version`;
- all four PASS lines plus all four corruption controls and the rebuild;
- **M-D34-3…7 re-run and identical** (§2's right-hand column). The RAISE-surfacing behaviour
  that the two-file split depends on reproduces exactly, including the `P0001` code and the
  verbatim message.

**Feature inventory — a measurement, not a claim.** The four migrations and the proof script
use, between them: `hstore` (the type, `each()`, `->`, `?`, `||`, `hstore()`),
`hstore_to_jsonb`, `jsonb`, `jsonb_set`, `jsonb_typeof`, `jsonb_each`, `jsonb_object_keys`,
`jsonb_build_object`, `jsonb_strip_nulls` (mutant only), `to_jsonb`, `to_regclass`,
`to_regprocedure`, `information_schema.columns`, `pg_index`, `pg_depend`, `pg_rewrite`,
`pg_constraint`, `pg_sequences`, PL/pgSQL `DO` blocks with per-row `BEGIN … EXCEPTION`,
`RAISE EXCEPTION … USING HINT`, `format()`, array constructors and `array_length`,
`FULL OUTER JOIN`, `ON COMMIT DROP` temp tables, `string_agg(… ORDER BY …)`, `row_to_json`,
`md5`, and — in the proof script only — `query_to_xml` / `xpath`.
**Every one of them ran, and produced identical output, on 17.11 and on 18.6** in the runs
above. That is the claim; it is not "nothing is version-sensitive", which nothing here
measures.

### 4.5 A row v1 writes mid-migration

| write | result |
|---|---|
| `INSERT … payload = 'type=>"x"…'::hstore` (v1 / Django, and v2 Release A) | `ERROR: column "payload" is of type jsonb but expression is of type hstore` — rejected, no row written (count still 626) |
| `UPDATE … SET payload = 'a=>b'::hstore` | same error |
| `UPDATE … SET payload = '{"a":"b"}'::jsonb` on the **unmigrated** clone | `ERROR: column "payload" is of type hstore but expression is of type jsonb` — the mirror image |
| Release A read `SELECT payload::text` on a converted column | returns JSON text; `parseHstore` throws `SyntaxError` — pinned in `src/common/utils/hstore.codec.spec.ts` |

**Measured on those four probes: every one is a type-level refusal, and the row count did not
move.** A writer that survives into step 6 is rejected by PostgreSQL before it can write a
half-encoded row, so on the shapes measured the exposure is availability, not integrity. (It is
written this way on purpose — rule 15. The universal *"there is no silent-corruption window"*
sat directly above the four rows that are its only evidence; four probes are not a proof about
every writer, and the two that matter — Django's `HStoreField` and v2's repositories — are
exactly the two measured.)

**The quiesce step is still load-bearing, for a different reason.** `ALTER TABLE … TYPE` takes
`ACCESS EXCLUSIVE`, so nothing can interleave *within* the conversion. The window that matters
is **between the backup and the conversion**: a write there is in no backup, and after step 6
there is no rollback. That is why §6.3 quiesces **before** taking the backup, not after
(review blocker **B1** — the first draft had it the other way round, contradicting this very
paragraph).

**Blast radius — operator answer Q61.** Nothing outside the API reads
`fondo_api_notificationsubscriptions` or `fondo_api_schedulertask` directly; the out-of-repo
Lambda only consumes the SQS queue (`business-analyst`, `docs/ba-phase-9-step6-questions.md`).
So step 6 affects **v1 and v2 alone**, and the runbook needs no step for an external reader.
This is an answer, not an assumption.

### 4.6 The verification script, exercised in both directions

`scripts/parity/step6-verify.sh` is the runbook's 6.1 and 6.4 (review finding **M4**). It was
run on the 17.11 clone in both states, from a pre-image taken on that same database:

| state | result |
|---|---|
| pre-image captured on the un-migrated clone, then `verify` **before** migrating | **exit 1**, 9 FAILs — the column types, the five content probes (which error on an hstore column and read as empty), the missing constraints and the missing ledger rows |
| the same clone after `migrate deploy` | **exit 0**, **21 PASSes, 0 FAILs** |
| the same clone after **one** post-migration write (`UPDATE … SET subscription = subscription`) | **exit 1, exactly 1 FAIL**: `xmin cardinality: fondo_api_notificationsubscriptions got 2, expected 1` — the N4 shelf life, measured rather than asserted |

So it can fail, and it fails for the right reasons (C67). The two halves must run against the
**same** database: the pre-image records `current_database()`, **`inet_server_addr()`** and the
server port, and `verify` compares all three — a verification pointed at the wrong database
fails on its first lines, which is review blocker **B3**'s failure mode caught rather than
assumed. ⚠️ The host comparison is new this round (**N3**): the pre-image captured `host` and
nothing compared it, so a same-named database on a *different* server — a restored copy, a
replica, a staging clone — passed the two identity lines that did exist.

🔴 **The two xmin checks have a shelf life — N4.** They say "one transaction wrote all of this",
which is true between the migration and the Release B rollout and **stops being true the moment
Release B serves a subscribe or runs a scheduler pass**. That rise is correct behaviour, not a
fault. The script says so at the check, and runbook §6.7 says so too, because an operator
mid-incident reads the script.

### 4.7 Drift, and stage 2a's schema worklist

`migrate diff` between the checked-in `schema.prisma` (Release A) and each clone:

- against the **unmigrated** clone: `-- This is an empty migration.` — Release A is aligned;
- against the **migrated** clone: exactly five statements — `DROP INDEX` ×3 for the new unique
  constraints, `ALTER COLUMN … SET DATA TYPE hstore` ×2.

Those five are stage 2a's `schema.prisma` change. Keeping it out of stage 1 is deliberate:
`schema.prisma` must keep describing the schema Release A runs on.

---

## 5. Mutation controls on the data-repair pass

`test/step6-hstore-jsonb.e2e-spec.ts` (34 cells) + `test/support/step6-harness.ts`.

The migration SQL is **read from the migration files**, never retyped. Each wrong
implementation is a textual mutation of that file, and `applyMutant` **throws if the anchor is
missing or the text is unchanged**, so a substitution that silently no-ops cannot masquerade
as a surviving blind control.

Each mutant is scored **twice**: against the shipped migration (its own in-transaction
post-conditions should abort it) and against the same mutation with those post-conditions
stripped (so the **external equality check** is the only thing left to notice). The equality
check decodes the hstore side in TypeScript through the shipped codec's `parseHstore` and
`repairPythonReprToJson` — not through the migration's SQL — and compares entries, row
identity and emitted key order.

**Corpus** — 15 rows, pinned at 15 rows / 41 entries so a dropped seed fails the suite (rule
15b): the two canonical live shapes, an empty `user_ids` list, a scalar `user_ids`, a row with
**no** `user_ids`, a row with `user_ids` as SQL NULL, an **empty hstore**, a message containing
`"` `\` newline and non-ASCII, a row of values that *look* like JSON scalars (`007`, `true`,
`1.50`) but are strings in v1, a row with an unexpected extra key, and five subscriptions —
canonical, no `expirationTime`, `keys` NULL, no `keys`, and (review **m6**) one whose `keys`
values carry a backslash, a newline and non-ASCII through the repair path. A `"` is
deliberately *not* in that last row: the preflight **stops** on one, and a separate cell
asserts that stop.

### 5.1 The table (asserted as a whole in the suite, not as "not null")

| id | wrong implementation | shipped migration | equality check alone |
|---|---|---|---|
| **MU1** | never unwraps `user_ids` — the value stays a JSON string of JSON | aborted | **diff** |
| **MU2** | unwraps a value that was never doubly stringified: `owner_id "53"` → `53` | aborted | **diff** |
| **MU3** | `hstore_to_jsonb_loose` — every numeric/boolean-looking string stops being a string | aborted | **diff** |
| **MU4** | the `keys` object is repaired but stored as a JSON *string* (mangled `keys`) | aborted | **diff** |
| **MU5** | JavaScript `replace` semantics — only the first `'` becomes `"`, the JSON is invalid | aborted | **sql-error** |
| **MU6** | `create_missing = true` with no predicate — a row with **no** `user_ids` gains `"user_ids": null` | aborted | **diff** |
| **MU7** | drops the **empty-hstore** row — invisible to any key-wise comparison | aborted | **diff** |
| **MU8** | rebuilds the payload from the five keys anyone expects, silently dropping others | aborted | **diff** |
| **B1** | *blind:* a predicate that cannot change which rows match | applied | identical |
| **B2** | *blind:* the repair pass runs twice (idempotence) | applied | identical |
| **B3** | *blind:* a comment | applied | identical |

8 killed, each by **two** independent mechanisms; 3 blind controls survive both. A further
cell asserts that a mutant with a missing anchor throws rather than scoring as a survivor.

⚠️ **One brief item read two ways.** *"numbers left as strings where v1 stored strings"* is the
**correct** behaviour. The wrong implementation in that direction is turning them into JSON
numbers, which is **MU3** (whole column, via `_loose`) and **MU2** (one key). Both are killed.
`business-analyst` confirmed the reading and supplied the reasons now recorded in §3.2.

### 5.2 The preflight stop conditions are tested too

Eleven cells, each seeding the offending shape and asserting the RAISE text and the row ids or
object names it prints: unparseable `user_ids`; a `user_ids` that parses but is still a JSON
string; a scalar `user_ids`, which is **accepted** (v1 accepts it); `keys` that does not parse
after the repair; `keys` that repairs into a non-object; `keys` that already contains a `"`; a
dependent **index**; a dependent **view**; duplicates blocking D6/D11; and running the
conversion twice. Plus three cells on the unique constraints, including *"applies D11 to both
tables or neither"*, which fails the second `ALTER` and then asserts that **zero**
`_user_id_key` constraints exist — i.e. the `BEGIN/COMMIT` is doing the work.

### 5.3 C91 — the nested `keys` order. ✅ **Ruled (Q60): preserve `p256dh, auth`.**

Before step 6, `keys` is an opaque hstore *string* holding a Python dict repr, and v1
`json.loads`es it into a dict whose order is the repr's — **`p256dh, auth` in all 94 live
rows**, which is the browser's own `PushSubscription.toJSON()` order. After step 6 it is a
jsonb *object*, and jsonb sorts members by (length, bytes), so what is **stored** becomes
`auth, p256dh`. The proof pins top-level key order; this is one level down, and the project
holds SQS bodies to a byte-identical criterion.

**The ruling and its consequences:**

- **The conversion is unchanged.** jsonb cannot hold a non-canonical member order, so the
  order cannot be preserved in storage. It is preserved on the **emit** side.
- **Release B pins the order where the SQS body is built** — `p256dh` first, then `auth` —
  with a cell that fails if it flips. **Implementation belongs to stage 2a**, on Release B's
  emit path; it is listed there in this document's stage table.
- ⚠️ **After step 6 the stored order no longer exists.** Today the pin can be checked against
  the database; afterwards **the pin is the only thing holding it**, and the only evidence that
  it is the right order is the measurement recorded here and in
  `docs/ba-phase-9-step6-questions.md`. That is why the ruling had to be taken before the door.
- The evidence could not settle it on its own: the consumer is an out-of-repo Lambda, and the
  analyst measured **no signature, no content hash, no FIFO dedupe and no `MessageAttributes`**
  anywhere on the SQS path in either repository, with `keys` values plain base64url. The
  operator took the no-change option at the one-way door.

The cell *"C91: the nested `keys` member order — ruled Q60, preserve `p256dh, auth`"*
**asserts** the stored order is `p256dh, auth` while it is still observable, and records that
the conversion moves it to `auth, p256dh`, so stage 2a's pin has a measured target rather than
a remembered one.

---

## 6. Release design and the step-6 runbook

### 6.1 Release A, Release B, and where the migrations live

|  | **Release A** — the cutover build (runbook step 3) | **Release B** — after step 6 |
|---|---|---|
| schema it runs on | **hstore** | **jsonb** |
| `schema.prisma` | `Unsupported("hstore")` ×2, no unique constraints | `Json @db.JsonB` ×2, `@unique` on `loan_id` and `user_id` ×2 |
| hstore codec | present | **deleted** |
| the two repositories | raw SQL with `::text` / `::hstore` casts | ordinary Prisma models |
| nested `keys` order on SQS | comes from the stored repr (`p256dh, auth`) | **pinned explicitly** (C91 / Q60) |
| boot guard | `SchemaShapeGuard`, requires **hstore** — **ships in this commit** (Q57, C93) | same guard, one constant flipped to **jsonb** |
| `prisma/migrations` holds | `0_init` only | **`0_init` only** — unchanged |
| `prisma/migrations-step6` | present, **outside** the default ledger | present, **still outside** it |
| what a production deploy migrates | nothing (`0_init` is already applied — a no-op) | nothing |
| step 6 itself | — | an **operator-run** `migrate deploy` with `PRISMA_MIGRATIONS_PATH` set inline, between A and B |

**Stage 2a** adds the second `migrate deploy` to `test/test-database.ts`, in the same commit as
the codec deletion (**C94** — its trigger is "Release B's code lands", which is 2a).
**Stage 2b**, after step 6 has run in production, moves the four directories into
`prisma/migrations` and deletes `PRISMA_MIGRATIONS_PATH` — and nothing else. Migration names
and file contents — and therefore checksums — survive the move, so production then reports
`No pending migrations to apply`.

### 6.2 The boot guard — `src/prisma/schema-shape.guard.ts`

Both failure directions (§4.5) are loud **per request**, not at boot. Without a guard, a build
on the wrong side of the door starts cleanly, serves every other route, and fails only on
notifications and on the scheduler — one of which runs unattended twice a day and is the
fund's only payment-reminder path. The operator chose the guard in **both** directions (Q57).

- It is registered in `PrismaModule`, **not `main.ts`** (§4 rule 12's corollary): every e2e
  suite builds the app from `AppModule`, so a guard installed in `main.ts` would be a guard no
  test ever boots.
- It requires **exactly the two expected rows, each of the required type**. `rows.every(...)`
  passes vacuously on an empty result — which a typo in the probe, a different `search_path`
  or a renamed table all produce — and that is the one failure mode a boot guard must not
  have. Ten unit cells: both-hstore, both-jsonb, **zero rows**, **one row**, **two rows of the
  same table**, a third unexpected row, **mixed**, a type that is neither, and both required
  directions.
- One integration cell runs the guard's **shipped SQL** against the genuinely converted scratch
  schema and feeds the result to `assertSchemaShape`, so the unit cells' assumed rows are known
  to be what the query returns.
- **Why throwing there is safe:** `onModuleInit` runs inside `app.init()`, which `app.listen()`
  awaits, and `main.ts:53-57`'s `bootstrap().catch(...)` writes the message and
  `process.exit(1)`. Nest never reaches the bootstrap phase, so
  `SchedulerOrchestrator.onApplicationBootstrap` — which is what *starts* the jobs
  `ScheduleExplorer.onModuleInit` registered — never runs,
  `GunicornHttpEdge.onApplicationBootstrap` never runs, and no port is opened.
- ⚠️ **Scope, honestly:** it bites on the **next boot**, not on a running process. Between the
  conversion and the Release B rollout a live Release A keeps serving and keeps erroring on
  those two subsystems. The guard turns a wrong-order deploy or restart into a refusal to
  start; it does not shorten the window — the quiesce step does.

### 6.3 Proposed runbook text for step 6 (plan §3, Phase 9 — for the plan owner to fold in)

> 6. **hstore → jsonb migration** (v2's first owned schema change; Q7). 🔴 **One-way door.**
>    Django's `HStoreField` breaks the instant this commits, **and so does the running v2
>    Release A** (measured: every `::hstore` write errors, every `::text` read returns JSON
>    that `parseHstore` rejects). Rollback to v1 is dead from here. Blast radius is v1 and v2
>    only — nothing outside the API reads either table (**Q61**).
>
>    ⚠️ Steps 6.1–6.3 are in this order on purpose. Any write that happens **after the backup
>    and before the conversion** is in no backup and behind a door that does not reopen.
>
>    **6.1 Quiesce, and take a pre-image.** Unset `SCHEDULER_ENABLED` on the runner and stop
>    it; stop or drain v2's API. v1 has been down since cutover step 2. **Confirm no writer is
>    left** (`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND
>    state <> 'idle'`). Then, against the production database:
>    ```bash
>    scripts/parity/step6-verify.sh preimage ~/step6-preimage.txt
>    ```
>    It records the database identity, both tables' `count(*)` and `max(id)`, both column
>    types, and `django_migrations`' row count. **6.4 compares against this file**, not against
>    literals: 626 and 94 are `fondodev` numbers and production's are unmeasured.
>
>    **6.2 Back up, and prove the backup restores.** `pg_dump -Fc` the whole database, then
>    **restore it into a scratch database and run the pre-image command against that copy** —
>    an unverified dump is not a restore point. Keep the file off the host.
>
>    **6.3 Identify the target, out loud, then migrate.** ⚠️ This repository's own `.env`
>    points at `fondodev`; the command below converts whatever the checkout's environment
>    names. Run this first and read the four values against the expected production ones:
>    ```sql
>    SELECT current_database(), inet_server_addr(), inet_server_port(),
>           current_setting('server_version');
>    ```
>    Expected: the production database name and host; `server_version` beginning **17.**
>    (**Q59** — the migrations are proved on 17.11 and 18.6). `inet_server_addr()` /
>    `inet_server_port()` report the **server's** address, so on a managed instance they are
>    the instance's, not the client's; `<local socket>` means you are on the database host.
>    ```bash
>    PRISMA_MIGRATIONS_PATH=prisma/migrations-step6 \
>    STEP6_CONFIRM=$(TZ=America/Bogota date +%F) \
>      npx prisma migrate deploy
>    ```
>    ⚠️ **Both variables, inline, on this one command.** Never in a task definition, an `.env`
>    file or a parameter store: under **Q56** every deploy runs `migrate deploy`. `STEP6_CONFIRM`
>    must be **today's date in Bogotá** or the CLI refuses and exits 1 (**C96**) — which is what
>    makes a forgotten variable stale within a day instead of dangerous for a month. If you see
>    `REFUSING: … is not today in America/Bogota`, re-read the date, do not edit the check. The
>    CLI also prints `WARNING: PRISMA_MIGRATIONS_PATH is set to …` on the successful path, so a
>    leftover shows up in the deploy log either way.
>
>    Four migrations apply in order: `step6_preflight` (assertions only), `hstore_to_jsonb`
>    (conversion + data repair, one transaction), `loandetail_unique_loan_id` (**D6**),
>    `userfinance_userpreference_unique_user_id` (**D11**). Expect `applied_steps_count = 1` on
>    each new row and **`0_init` still at 0** (**D34**, C39). If anything stops, go to **6.7**.
>
>    **6.4 Verify — with an exit code, not by eye.**
>    ```bash
>    scripts/parity/step6-verify.sh verify ~/step6-preimage.txt   # must exit 0
>    ```
>    Twenty-one checks: same database, **host** and port as the pre-image (N3); both columns `jsonb`; both tables'
>    `count(*)` and `max(id)` equal to the pre-image; nothing still doubly stringified; no
>    `user_ids` present but not an array; no `keys` that is not an object; **every `keys`
>    object's fields exactly `{auth, p256dh}`**; no non-string value outside `user_ids`/`keys`;
>    **xmin cardinality 1 on both converted tables** (the conversion and both repair `UPDATE`s
>    ran in one transaction — a higher number means something touched the table outside the
>    migration, i.e. a writer that was not quiesced); the three `UNIQUE` constraints present;
>    `0_init` still at `applied_steps_count = 0`; four step-6 rows applied; **zero failed
>    migration rows**; and `django_migrations` still at the pre-image's count.
>
>    A non-zero exit means **do not deploy Release B** — go to 6.7.
>
>    **6.5 Deploy Release B** — the build with the hstore codec removed, both repositories on
>    ordinary Prisma models, `schema.prisma` declaring `Json @db.JsonB` and the two `@unique`s,
>    `SchemaShapeGuard` requiring `jsonb`, and **C91's `p256dh, auth` pin on the SQS emit
>    path**. Its refusal to boot on an hstore schema is the check that 6.3 actually ran.
>
>    **6.6 Re-enable and smoke-test.** Set `SCHEDULER_ENABLED=true` on exactly one process and
>    confirm a pass finishes (`grep -c 'Scheduler pass finished'` ≥ 1,
>    `grep -c 'Scheduler pass failed'` = 0); smoke-test one subscribe and one unsubscribe. Then
>    record the time and **retire the v1 rollback instruction from the incident procedure**:
>    the two ledgers now describe different schemas and rollback is dead.
>
>    ---
>
>    **6.7 If it stops.** Find the state you are in and do only what that row says.
>
>    | symptom | expected state | what to do |
>    |---|---|---|
>    | `P3018` + `P0001` + `PHASE 9 STEP 6 PREFLIGHT: …` naming rows or objects | both columns still **`hstore`**; **zero** `*_key` constraints; one `_prisma_migrations` row for `…_step6_preflight` with `finished_at IS NULL` | Nothing was converted. The data is a shape nobody measured — **an operator decision, not a repair this migration may make.** See 6.10 for the `keys`-with-a-quote case specifically. Fix the rows or drop the dependent object, then 6.8, then re-run 6.3. |
>    | `ERROR: current transaction is aborted, commands ignored…` | both columns still `hstore`; the failed row is `…_hstore_to_jsonb` | The conversion's own post-conditions failed inside its transaction and the real message is masked (measured — M-D34-6). **Nothing was changed.** Get the readable reason from 6.9, then 6.8. |
>    | `could not create unique index "fondo_api_…_key"` | both columns **`jsonb`** (the conversion committed); the failed row is one of the two `unique` migrations | The door is already shut; this is not a rollback situation. Resolve the duplicate rows by hand, then 6.8, then re-run 6.3 — the applied migrations are skipped. |
>    | `P3009 … migration started at … failed` on a later attempt | whatever the previous failure left | A previous run left a failed ledger row. Confirm the schema state with 6.4's column check **before** anything else, then 6.8. |
>    | Release B refuses to boot: *"requires the step-6 columns to be jsonb"* | both columns still `hstore` | The conversion did not run. **Redeploy the Release A image** — it boots on hstore — and start again at 6.3. |
>    | Release A refuses to boot: *"already had the step-6 migration applied; deploy Release B instead"* | both columns `jsonb` | Expected. Deploy Release B; do not try to get Release A up. |
>    | `step6-verify.sh verify` FAILs **only** on the two `xmin cardinality` lines, during a later incident | both columns `jsonb`, everything else PASS | 🔴 **Not a fault — review N4.** Those two lines mean "one transaction wrote all of this", which stops being true the moment Release B serves a subscribe or runs a scheduler pass. `step6-verify.sh` is a **step 6.4 instrument**, valid between the migration and the Release B rollout. Ignore those two lines after that point; every other check still holds. |
>
>    **6.8 Clearing a failed ledger row.** Prisma blocks every later `migrate deploy` until the
>    row is resolved (`P3009`). After confirming with 6.4's column check that the schema is in
>    the state the table above says:
>    ```bash
>    PRISMA_MIGRATIONS_PATH=prisma/migrations-step6 \
>    STEP6_CONFIRM=$(TZ=America/Bogota date +%F) \
>      npx prisma migrate resolve --rolled-back 20260915120100_hstore_to_jsonb
>    ```
>    (the confirmation gate is on the config, so **every** `prisma` command against that ledger
>    needs it, `resolve` included.)
>    (substitute the migration name the error printed).
>
>    **6.9 ⚠️ A succeeded preflight is never re-run.** Prisma skips applied migrations, so a
>    retry after a *conversion* failure does **not** re-check for duplicates, dependent objects
>    or unparseable values — and v1 may have been writing right up to the quiesce. Re-run it by
>    hand before every retry. It writes nothing and is idempotent:
>    ```bash
>    psql -v ON_ERROR_STOP=1 -f prisma/migrations-step6/20260915120000_step6_preflight/migration.sql
>    ```
>    Exit 0 means every stop condition still holds.
>
>    **6.10 ⚠️ If the preflight stops on a `keys` value containing a `"`** (0 of 94 rows on the
>    reference data): **stop, inspect the row, and tell the member — do not delete it as a
>    matter of course.** Such a value cannot have come from Django's repr path, and v1's blunt
>    `'`→`"` replace on it either yields valid-but-wrong JSON (that device silently never
>    receives push again) or invalid JSON, which raises inside `send_notification` and loses the
>    notification **for every recipient in that batch**. Delete the row **only if the value
>    cannot be decoded**. Deleting is not free: under **Q62** the PWA subscribes only on
>    explicit opt-in, so **the browser will not re-register on its own** — that member stops
>    receiving push until they turn notifications on again, and nothing tells them.

---

## 7. Gate

Baselines at `de17e97`. Each step's own exit code, on this branch.

| step | baseline | measured | Δ |
|---|---|---|---|
| `npm run lint` | 0 | see §7.1 | — |
| `npm run typecheck` | 0 | see §7.1 | — |
| `npm test` (unit) | 2591 / 80 | see §7.1 | `+10 cells, +1 suite` — `src/prisma/schema-shape.guard.spec.ts` (§6.2) |
| `npm run test:e2e` | 1375 + 2 skipped; 23 + 1 of 24 | see §7.1 | `+7 cells` in `test/step6-hstore-jsonb.e2e-spec.ts`: 5 new preflight stop conditions (M2 ×2 + the scalar acceptance, M3 ×2), the C91 cell, and the guard-on-a-converted-schema cell |
| fixture diff vs `~/.fondo-parity-harness/p8/out/BASELINE-fondodev-2026-09-12.txt` | 0 | see §7.1 | — |
| fixture control `DB=fondo_api_test` | 1 | see §7.1 | — |

### 7.1 Measured — stage 1 conditions (C94–C96, N3, N4, m4, m8)

| step | baseline (`4db69fb`) | measured | Δ |
|---|---|---|---|
| `npm run lint` | 0 | **0** | — |
| `npm run typecheck` | 0 | **0** | — |
| `npm test` | 2601 / 81 | **2619 / 82** | **+18 cells, +1 suite** — `src/config/step6-migrations-path.spec.ts` (C96: 3 default-ledger, 2 missing, 2 stale, 7 malformed, 1 correct, 1 message-shape, 2 zone) |
| `npm run test:e2e` | 1382 + 2 skipped; 23 + 1 of 24 | **1386 + 2 skipped; 23 + 1 of 24** | **+4 cells** in `test/step6-hstore-jsonb.e2e-spec.ts` — C95's expression index, predicate index, CHECK constraint, and the NOT NULL non-exclusion |
| fixture diff | 0 | **0** | — |
| fixture control `DB=fondo_api_test` | 1 | **1** | — |

Every delta is a cell that round added. One existing cell changed its expected text — *"refuses
a dependent index … by name"* now expects `index step6_dependent_probe` rather than
`index step6_dependent_probe on fondo_api_schedulertask.payload`, because the `pg_depend` sweep
names objects through `pg_describe_object`. That run was on the **hstore** schema, which is what
Release A deploys.

### 7.2 Measured — stage 2a (Release B)

| step | before (`5d019d9`) | after | Δ |
|---|---|---|---|
| `npm run lint` | 0 | **0** | — |
| `npm run typecheck` | 0 | **0** | — |
| `npm test` | 2619 / 82 | **2617 / 84** | **−52, +50 cells; +3, −1 suites.** Deleted `hstore.codec.spec.ts` (**−52**). Added `django-str.spec.ts` (**+25** — the `str()`/`repr()` cells that survived the codec), `push-subscription.spec.ts` (**+15** — C91's pin, including 5 mutation controls) and `jsonb-storage.spec.ts` (**+10** — the storage rule, including 5 mutation controls). 2619 − 52 + 25 + 15 + 10 = **2617** |
| `npm run test:e2e` | 1386 + 2 skipped; 23 + 1 of 24 | **1387 + 2 skipped; 23 + 1 of 24** | **+1 cell** — *"C91: stores keys as auth,p256dh and emits them as p256dh,auth"* in `notification.e2e-spec.ts` |
| fixture diff | 0 | **0** | — |
| fixture control `DB=fondo_api_test` | 1 | **1** | — |

⚠️ **The e2e run is now on the *converted* schema**, because `test/test-database.ts` applies
both ledgers (C94). That is the point: Release B's suites exercise Release B's database. **No
existing e2e cell was deleted and none was skipped** — 24 changed what they assert, from hstore
text to jsonb members, and the list is the `->` → `->>` sweep of §9.2 plus the payload and
subscription fixtures. Against `4db69fb`, the coordinator's stated baseline, the totals are
unit **2601 → 2617** and e2e **1382 → 1387**; every step of both is in this table and §7.1.

### 7.3 🔴 The two builds cannot share a test database

**Measured by `nestjs-reviewer` while gating the Release A tag, 2026-09-15:** the first attempt
failed **1306 of 1388** e2e cells, because `fondo_api_test` still held Release B's **converted**
schema and Release A's `SchemaShapeGuard` refused to start, naming both columns.

**That is the guard doing its job, not a defect** — it is exactly the refusal Q57 asked for, and
finding it in a gate rather than in production is the point of shipping the guard before
cutover. But it has a practical consequence that costs an hour the first time it bites:

> ⚠️ **Gating either build means dropping `fondo_api_test` first** and letting that checkout's
> provisioner rebuild it. Release A builds it from `prisma/migrations` alone (hstore);
> Release B (head) builds it from both ledgers (jsonb). Whichever ran last leaves a database
> the other cannot boot on, and the failure is a wall of bootstrap errors rather than an
> assertion, so it does not read as "wrong schema" at first glance.
>
> ```bash
> dropdb fondo_api_test && npm run test:e2e      # the provisioner recreates it
> ```
>
> The same note is in `test/test-database.ts`, where someone gating a build will actually be.

**Say which shape an e2e run was on when you report it.** The counts are nearly identical
between the two (1386 on hstore at the Release A tag, 1387 on jsonb at head), so the number
alone does not say which database was under it.

---

## 8. Open questions

**Answered during this round** — Q56 (deploys run migrations → C92, §3.1), Q57 (Release A gets
the mirror guard → §6.2, shipped), Q58 (leave the redundant indexes), Q59 (production is 17.x →
§4.4), **Q60 (C91 ruled: preserve `p256dh, auth` → §5.3, implemented in stage 2a)**, Q61 (no
external reader of either table → §4.5), Q62 (the PWA subscribes only on explicit opt-in →
runbook 6.10).

Also settled by `business-analyst`, and therefore **withdrawn as open questions**: `owner_id`
stays a string (§3.2, with the correction that it never reaches the SQS body and is overloaded
across two entity kinds), and stopping on a `keys` value containing a `"` is right (§5.2,
runbook 6.10).

**Still open**

- **Production's exact 17.x minor version** is unrecorded; the proof ran on 17.11. Low risk —
  §4.4's feature inventory ran identically on 17.11 and 18.6 — but it is a measurement nobody
  has taken.
- **C91's pin is stage 2a work.** Until it lands, the byte-order guarantee on the SQS `keys`
  object rests on the stored repr, which step 6 destroys. Sequencing: the pin must be in
  Release B **before** step 6 runs, which C93 already requires for stage 2a as a whole.

---

## 9. Stage 2a — what Release B actually is

Landed in one commit, as the reviewer asked. Every item is verifiable from the tree:

| change | where | note |
|---|---|---|
| hstore codec **deleted** | `src/common/utils/hstore.codec.ts` (gone) | nothing in `src/` speaks hstore |
| Django's `str()` coercion **kept** | `src/common/utils/django-str.ts` (new) | not an encoding detail — it is the **value rule** the 720 migrated rows embody. `{"endpoint": 123}` is a 200 that stores `"123"` in v1 and still is; dropping it would either 500 that request or store a JSON number the dedupe cannot match |
| the storage rule | `src/common/utils/jsonb-storage.ts` (new) | `encodeJsonbColumn(source, nativeKeys)`: `user_ids` / `keys` keep their JSON type, everything else is `str()`-ed. **`owner_id` stays `"53"`** |
| both repositories on Prisma models | `notification-subscription.repository.ts`, `scheduler-task.repository.ts` | `create` / `delete` / `deleteMany` / `updateMany` / `findMany` / JSON `path` filters |
| `schema.prisma` | `Json @db.JsonB` ×2, `@unique` ×3 | **`migrate diff` against the migrated clone is empty** — the five statements of §4.7, resolved |
| the boot guard flipped | `REQUIRED_COLUMN_TYPE = 'jsonb'` | the Release A image is the same file with `'hstore'`; both directions, Q57 |
| **C91's pin** | `src/notifications/push-subscription.ts` (new) | `pinKeysMemberOrder`, applied where every SQS body passes |
| the provisioner's second deploy | `test/test-database.ts` | C94 — two sequential `migrate deploy` runs, with `STEP6_CONFIRM` computed, never written down |
| C83 | `loans/loan-path-id.ts`, `activities/activity-path-id.ts` | both delegate to `common/http/django-int-path-id.ts`; three implementations became one |
| C90 | `src/scheduler/zone-single-source.spec.ts` | the self-comparing line removed with its reason; the dev credential replaced by a placeholder and a non-`fondodev` name |

### 9.1 Two things that did **not** change, and why

- **`existsUnprocessedOnDay` and `findDueUnprocessed` are still raw SQL.** Not because of
  hstore — that is gone — but because both compare `run_date AT TIME ZONE 'America/Bogota'`,
  which Prisma's query API cannot express. Rewriting them as an instant-range filter is a
  behaviour-preserving change *in theory* to the fund's only reminder path, measured on the
  SQL form in Phase 7b, and it buys nothing that step 6 required. Their hstore-specific halves
  did change: `payload -> 'x'` became `payload ->> 'x'`, because on jsonb `->` yields a jsonb
  value and would compare `"53"` against `53`.
- **The hstore codec survives as `test/support/hstore-legacy.ts`.** Step 6 has not run in
  production, so `test/step6-hstore-jsonb.e2e-spec.ts` still has to build hstore fixtures and
  decode them with **v1's** semantics — scoring the conversion against its own SQL would prove
  nothing. It is deleted in **stage 2b**, with the directory move.

### 9.2 The `->` → `->>` sweep

Seven call sites, each measured by a failing cell before it was changed: the two repository
predicates, `saving-account.e2e-spec.ts`'s close-task count, `http-edge.e2e-spec.ts`'s stored
endpoints, and `scheduler-task.e2e-spec.ts`'s remaining-tasks read. On hstore `->` returned
`text`; on jsonb it returns `jsonb`, so every one of them silently matched **nothing** until
the operator was fixed. That is the single most likely mistake in this conversion and it is
why the e2e suite was run against a converted `fondo_api_test` rather than reasoned about.

---

## 10. Not in this stage

**Stage 2b**, after step 6 has run in production: move `prisma/migrations-step6/*` into
`prisma/migrations/`, delete `PRISMA_MIGRATIONS_PATH` and `src/config/step6-migrations-path.ts`,
collapse `test/test-database.ts` back to one `migrate deploy`, and delete
`test/support/hstore-legacy.ts` with the step-6 mutation suite it serves. Nothing else.
