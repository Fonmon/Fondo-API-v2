# Phase 9 — step 6 design, measurements and proof (stage 1 of 2)

**Status:** stage 1. Nothing here deletes the hstore codec, converts the two raw-SQL
repositories to Prisma models, or touches C83/C90 — that is stage 2, after review. This
document, the four migrations under `prisma/migrations-step6/`, `scripts/parity/step6-prove.sh`
and `test/step6-hstore-jsonb.e2e-spec.ts` are what stage 1 delivers.

**Why two stages.** Step 6 is the one-way door. Django's `HStoreField` breaks when it runs, and
v2 must boot on the **hstore** schema at cutover (runbook step 3) and on the **jsonb** schema
after step 6. The design and the data proof get reviewed *before* the codec and the raw-SQL
repositories are removed.

**Nothing here touched production or `fondodev`.** Every measurement against `fondodev` ran with
`SET default_transaction_read_only = on`; every migration ran on a `pg_restore` clone
(`fondodev_p9`, and scratch databases created from it with `CREATE DATABASE ... TEMPLATE`) or on
`fondo_api_test`. `prisma migrate dev` was never run anywhere.

---

## 1. Measurements — `fondodev`, read-only, 2026-09-15

Source: `SET default_transaction_read_only = on` on every session. Dump for the clones:
`~/.fondo-parity-dumps/p9-20260915-054421-stage1/fondodev-full.dump` (`pg_dump -Fc`, read-only).

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
| subscription | `keys` | 94 | 0 | **doubly stringified**: 0/94 valid JSON as stored, **94/94 valid after v1's `'` → `"` repair**, all objects, all `{auth, p256dh}`, all 135 chars |

**Values that are not valid JSON where JSON is expected: none.**
- `user_ids`: 0 of 626 unparseable.
- `keys` after `replace("'", '"')`: 0 of 94 unparseable; and **0 of 94 already contain a `"`**,
  so v1's blunt replacement is lossless on every live row.

**No stop condition was hit.**

### 1.2 Duplicates that would block D6 and D11

| deviation | table.column | rows | distinct | NULLs | duplicate groups |
|---|---|---|---|---|---|
| **D6** | `fondo_api_loandetail.loan_id` | 374 | 374 | 0 | **0** |
| **D11** | `fondo_api_userfinance.user_id` | 15 | 15 | 0 | **0** |
| **D11** | `fondo_api_userpreference.user_id` | 15 | 15 | 0 | **0** |

All three columns are `integer NOT NULL`. Each already carries Django's non-unique btree index
(`…_loan_id_6a9fa8c0`, `…_user_id_9645b2bd`, `…_user_id_c39c1264`) and its primary key on `id`;
no unique constraint on the target column exists yet.

**No stop condition was hit.** ⚠️ This is a measurement at one instant, not a guarantee: v1 is
still live and can write a duplicate before cutover. The preflight migration re-runs exactly
these three checks at deploy time, **before** the hstore conversion, so a duplicate that appears
between now and then stops the run with the door still open (§4.1).

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

Extensions present: `plpgsql`, **`hstore` 1.8 (schema `public`)**, `pageinspect`.

---

## 2. D34 / C39 — what Prisma 7 actually does with an `applied_steps_count = 0` baseline

The plan's rule is *"`0_init` stays at `applied_steps_count = 0` — do not repair it to 1."* The
brief asked whether `migrate deploy` would then re-apply or refuse. **Measured, on a fresh
`pg_restore` clone of `fondodev` (`fondodev_p9`, and template copies of it), Prisma 7.10.0:**

| id | what was run | result |
|---|---|---|
| **M-D34-1** | `migrate status` + `migrate deploy` with only `0_init` in the directory | `Database schema is up to date!` / `No pending migrations to apply.` **exit 0**. The `0_init` row is byte-identical afterwards — `applied_steps_count` still **0**, `finished_at` unchanged. Table counts unchanged (626 schedulertask rows before and after). |
| **M-D34-2** | `migrate deploy` from a directory that does **not** contain `0_init`, containing one new migration | Applies the new migration, **exit 0**. `0_init` untouched at `applied_steps_count = 0`; the new row records `applied_steps_count = 1`. Prisma does **not** object to a ledger row with no file. |
| **M-D34-3** | `migrate deploy` of the four step-6 migrations (§3) | All four applied, **exit 0**, `0_init` still at 0. |

**Finding: there is no conflict with the plan.** Prisma treats a migration as applied when
`finished_at IS NOT NULL AND rolled_back_at IS NULL`; `applied_steps_count` is informational and
is not consulted. `migrate deploy` neither re-applies `0_init` nor refuses to proceed, and it
does not rewrite the row. D34 stands as written, and **C39 can close on this evidence.**

Two further measurements that change the *shape* of the migrations, and are the reason the files
look the way they do:

| id | what was run | result |
|---|---|---|
| **M-D34-4** | a migration file containing `ALTER TABLE … ADD COLUMN`, then `UPDATE`, then `SELECT 1/0` | `Error: P3018`, exit 1 — **but the added column is still there.** A Prisma migration file is **not** atomic by default. The ledger records a failed row and every later `migrate deploy` fails `P3009` until `migrate resolve` is run. |
| **M-D34-5** | the same file wrapped in `BEGIN; … COMMIT;` | exit 1 and **the column is gone** — atomic. On the success path it applies normally and records `applied_steps_count = 1`. |
| **M-D34-6** | `RAISE EXCEPTION 'STEP6 PREFLIGHT FAILED: …'` *inside* `BEGIN; … COMMIT;` | the operator sees `Error: ERROR: current transaction is aborted, commands ignored until end of transaction block` — the RAISE text is **lost**, because the trailing `COMMIT` is the statement Prisma reports. |
| **M-D34-7** | the same `RAISE` as the first statement of a file with **no** explicit transaction | `Error: P3018 … Database error code: P0001 … ERROR: STEP6 PREFLIGHT FAILED: 3 unparseable rows: {1,2,3}` — verbatim, and nothing after it ran. |

So: **assertions an operator must read go in an unwrapped migration with no writes; anything
that writes goes inside `BEGIN; … COMMIT;`.** That is exactly how §3 is split.

---

## 3. The migrations

`prisma/migrations-step6/`, four files, `migrate deploy` only:

| order | migration | contents | transaction |
|---|---|---|---|
| 1 | `20260915120000_step6_preflight` | every stop condition: both columns still `hstore`; `hstore_to_jsonb` reachable; every `user_ids` parses; every `keys` parses after the `'`→`"` repair and contains no `"`; **no duplicates for D6 or D11** | none, by design (M-D34-7) |
| 2 | `20260915120100_hstore_to_jsonb` | the two `ALTER COLUMN … TYPE jsonb USING hstore_to_jsonb(…)`, the two repair `UPDATE`s, and four in-transaction post-conditions | `BEGIN; … COMMIT;` |
| 3 | `20260915120200_loandetail_unique_loan_id` | **D6** `UNIQUE (loan_id)` | single statement |
| 4 | `20260915120300_userfinance_userpreference_unique_user_id` | **D11** `UNIQUE (user_id)` on both tables | `BEGIN; … COMMIT;` (two statements) |

### 3.1 Why they are **not** in `prisma/migrations/`

`test/test-database.ts` provisions the e2e database by running `prisma migrate deploy`, and
`buildspec.yml` does the same in CI. Putting the step-6 migrations in the default directory
converts `fondo_api_test` to jsonb on the next test run, and **Release A cannot run on jsonb**.

Measured, 2026-09-15 — the step-6 migrations applied to `fondo_api_test`, then two Release-A
suites run against it:

```
notification.e2e-spec.ts + scheduler-task.e2e-spec.ts
  25 failed, 1 skipped, 12 passed, 38 total
```

(`fondo_api_test` was dropped afterwards and re-provisioned from `prisma/migrations`.)

There is a second reason, which matters more than the first: **a one-way door in the default
directory is one `migrate deploy` away from firing.** CI's `migrate deploy` targets only the
throwaway container database, but the production deploy is an out-of-repo
`entrypoint_deploy` on the EC2 host (`scripts/trigger-deploy.sh`), and whether it runs
migrations cannot be read from this repository — **operator question Q-P9-1, §8**.

So `prisma.config.ts` now reads the migrations directory from `PRISMA_MIGRATIONS_PATH`, default
`prisma/migrations`. The step-6 runbook sets it for exactly one command. **Stage 2 moves the four
directories into `prisma/migrations/` and deletes the knob**; migration names and file contents
(and therefore checksums) are preserved by the move, so a database that already ran step 6 sees
`No pending migrations to apply` afterwards.

### 3.2 What the conversion does to each value

`hstore_to_jsonb` (strict) reproduces hstore's storage exactly: every value becomes a JSON
**string**, a SQL NULL value becomes JSON `null`. Then the repair pass unwraps, once and
permanently, the two values v1 unwraps on **every** read:

| column | key | v1 read path | after |
|---|---|---|---|
| `payload` | `user_ids` | `json.loads(payload["user_ids"])` | JSON array |
| `subscription` | `keys` | `json.loads(keys.replace("'", '"'))` | JSON object |

Everything else stays a JSON string — `owner_id` is `"53"`, not `53`, because that is what v1
reads and what the Phase 7 dedupe compares as text. `hstore_to_jsonb_loose` would convert it and
is the wrong function; post-condition (c) in the migration is what stops it, and mutant
**MU3** (§5) is the control on that.

The repair predicate is `jsonb_typeof(payload -> 'user_ids') = 'string'` — the precise meaning of
"doubly stringified". A key that is absent, SQL NULL (now JSON `null`), or already structured is
skipped, which also makes both statements idempotent (blind control **B2**).

### 3.3 The migration verifies itself

Inside the same transaction as the `ALTER`s, the conversion migration captures the v1-decoded
value of every entry **before** anything changes (`step6_decoded_before`, `ON COMMIT DROP`), and
afterwards asserts:

- **(a)** every `table#id.key` decodes to the same value — a `FULL OUTER JOIN`, so a lost or
  gained entry is a mismatch too;
- **(b)** no row lost and none gained — *a key-wise check cannot see an empty-hstore row
  disappear, because it contributes no keys to either side* (mutant **MU7**);
- **(c)** nothing outside `user_ids` / `keys` stopped being a JSON string (mutant **MU3**);
- **(d)** nothing is still doubly stringified (mutant **MU1**).

If any fires, the whole transaction rolls back and the schema is untouched. The cost is the
masked error message from M-D34-6: the operator sees `current transaction is aborted`. The
readable diagnosis is the preflight migration, which can be re-run at will because it writes
nothing.

---

## 4. The proof on a clone

`scripts/parity/step6-prove.sh <pristine-clone> <scratch-run-db> [outdir]`.

Procedure actually run, 2026-09-15:

1. `pg_dump -Fc fondodev` (read-only) → `~/.fondo-parity-dumps/p9-20260915-054421-stage1/`.
2. `scripts/parity/reset-clone.sh fondodev_p9 …/fondodev-full.dump` — in place, TRUNCATE +
   `pg_restore --data-only`; hstore OID **6905300** preserved and pinned to the sidecar. Then
   `ANALYZE`.
3. `CREATE DATABASE fondodev_p9_run TEMPLATE fondodev_p9` — measured to preserve the hstore type
   OID (6905300 in both), so false-green #23's mechanism cannot be reintroduced by the copy, and
   the pristine clone is never written to.
4. `PRISMA_MIGRATIONS_PATH=prisma/migrations-step6 prisma migrate deploy` on the copy.

### 4.1 Result

```
== 4. results ==
  PASS  entries (3411 lines compared)
  PASS  rows (720 lines compared)
  PASS  keyorder (720 lines compared)
  PASS  reverse (66 lines compared)
  note  the migration ledger, the one table this step is supposed to change:
          before count|_prisma_migrations|1
          before xmin|_prisma_migrations|1
          after  count|_prisma_migrations|5
          after  xmin|_prisma_migrations|5
== 5. positive control — mutate one row and re-run the entry check ==
  PASS  control: 2 differing line(s), as expected

STEP6 PROOF: PASS
```

- **entries** — **3411** `(table, id, key)` entries, every one byte-identical between "what v1
  decoded from hstore" and "what the jsonb column now holds". 626×5 + 94×3 − 1 (the row without
  `expirationTime`) = 3411. ✅ Row-by-row semantic equality, count, ids, and each key's decoded
  value.
- **rows** — **720** row identities (626 + 94), none lost, none gained.
- **keyorder** — **720** rows whose *emitted key order* is unchanged. This is not cosmetic:
  PostgreSQL emits hstore entries ordered by (key length, key bytes) and v1 `json.dumps`es that
  dict straight onto the SQS wire (plan §2), so the order is part of the wire format. jsonb sorts
  object keys by the same rule — **measured on all 720 rows**, not assumed.
- **reverse** — **66** lines: `count` and `xmin` cardinality for all 24 tables, plus `last_value`
  for all 20 sequences. Identical. The only excluded rows are `_prisma_migrations`' own count and
  xmin (1 → 5), printed rather than hidden. ⚠️ The two converted tables' xmin cardinality is
  **not** excused and did not change (**1 → 1**): the `ALTER`s and both repair `UPDATE`s run in
  one transaction, so every rewritten row carries that single xid. A 2 would mean something ran
  outside it.
- **control** — the script then corrupts one value in the migrated database and re-runs the entry
  comparison, which must (and does) report a difference. A check that can only say "nothing
  found" is not a check (C67).

### 4.2 A row v1 writes mid-migration

Measured on the migrated clone:

| write | result |
|---|---|
| `INSERT … payload = 'type=>"x", user_ids=>"[1]"'::hstore` (v1 / Django, and v2 Release A) | `ERROR: column "payload" is of type jsonb but expression is of type hstore` — **rejected, no row written** (count still 626) |
| `UPDATE … SET payload = 'a=>b'::hstore` | same error |
| `UPDATE … SET payload = '{"a":"b"}'::jsonb` against the **unmigrated** clone | `ERROR: column "payload" is of type hstore but expression is of type jsonb` — the mirror image |
| Release A read `SELECT payload::text` on the converted column | returns JSON text, e.g. `{"type": "birthdate", …, "user_ids": [2, 4]}`; `parseHstore` throws `SyntaxError` on it — pinned by `src/common/utils/hstore.codec.spec.ts`, *"step 6: rejects the JSON text a converted jsonb column renders"* |

So there is **no silent-corruption window**. A v1 or Release-A writer that survives into step 6
fails at the type level on its very first write; it cannot insert a half-encoded row. The
exposure is availability, not integrity.

**The step-1 freeze is still load-bearing, for a different reason.** `ALTER TABLE … TYPE` takes
`ACCESS EXCLUSIVE`, so no writer can interleave *within* the conversion; the window that matters
is between the **backup** and the conversion. A v1 write in that window is not in the backup, and
after step 6 rollback is dead, so it is unrecoverable. Runbook steps 1 and 2 (freeze writes, stop
`api`/`worker`/`scheduler`/`sch_work`) are what close it; step 6 must also stop or accept errors
from **v2 Release A**, which is by then the live writer (§6).

### 4.3 Drift, and stage 2's worklist

`migrate diff` between the checked-in `schema.prisma` (Release A) and each clone:

- against the **unmigrated** clone: `-- This is an empty migration.` — Release A is aligned.
- against the **migrated** clone: exactly five statements — `DROP INDEX` ×3 for the new unique
  constraints, and `ALTER COLUMN … SET DATA TYPE hstore` ×2.

That five-statement diff **is** stage 2's schema worklist: `payload`/`subscription` become
`Json @db.JsonB`, and `loan_id` / `user_id` gain `@unique` (index names already match Prisma's
`<table>_<column>_key` convention, so the change introduces no new drift). Keeping it out of
stage 1 is deliberate: `schema.prisma` must keep describing the schema Release A runs on.

---

## 5. Mutation controls on the data-repair pass

`test/step6-hstore-jsonb.e2e-spec.ts` (27 cells) + `test/support/step6-harness.ts`.

**How it works.** The migration SQL is **read from the migration files**, never retyped — a suite
that scores a copy proves nothing about the file the operator deploys. Each wrong implementation
is a textual mutation of that file, and `applyMutant` **throws if the anchor is missing or the
text is unchanged**, so a substitution that silently no-ops cannot masquerade as a surviving
blind control.

Each mutant is scored **twice**:

1. against the shipped migration — its own in-transaction post-conditions should abort it;
2. against the same mutation with those post-conditions *stripped* (`withoutPostConditions`, on
   markers the migration file carries) — so the **external equality check** is the only thing
   left to notice.

The equality check (`assertSemanticEquality`) is an independent implementation: it decodes the
hstore side in TypeScript through the shipped codec's `parseHstore` and `repairPythonReprToJson`,
not through the migration's SQL, and compares entries, **row identity**, and emitted key order.

**Corpus** — 14 rows: the two canonical live shapes, an empty `user_ids` list, a scalar
`user_ids`, a row with **no** `user_ids`, a row with `user_ids` as SQL NULL, an **empty hstore**,
a message containing `"` `\` newline and non-ASCII, a row of values that *look* like JSON scalars
(`007`, `true`, `1.50`) but are strings in v1, a row with an unexpected extra key, and four
subscriptions (canonical, no `expirationTime`, `keys` NULL, no `keys`). Pinned at 14 rows / 39
entries so a dropped seed fails the suite (rule 15b).

### 5.1 The table (asserted as a whole in the suite, not just "not null")

| id | wrong implementation | shipped migration | equality check alone |
|---|---|---|---|
| **MU1** | never unwraps `user_ids` — the value stays a JSON string of JSON | aborted | **diff** |
| **MU2** | unwraps a value that was never doubly stringified: `owner_id "53"` → `53` | aborted | **diff** |
| **MU3** | `hstore_to_jsonb_loose` — every numeric/boolean-looking string stops being a string | aborted | **diff** |
| **MU4** | the `keys` object is repaired but stored as a JSON *string*, not an object (mangled `keys`) | aborted | **diff** |
| **MU5** | JavaScript `replace` semantics — only the first `'` becomes `"`, the JSON is invalid | aborted | **sql-error** |
| **MU6** | `create_missing = true` with no predicate — a row with **no** `user_ids` gains `"user_ids": null` | aborted | **diff** |
| **MU7** | drops the **empty-hstore** row — invisible to any key-wise comparison | aborted | **diff** |
| **MU8** | rebuilds the payload from the five keys anyone expects, silently dropping others | aborted | **diff** |
| **B1** | *blind:* a predicate that cannot change which rows match | applied | identical |
| **B2** | *blind:* the repair pass runs twice (idempotence) | applied | identical |
| **B3** | *blind:* a comment | applied | identical |

8 killed, each by **two** independent mechanisms; 3 blind controls survive both. The suite also
asserts that a mutant with a missing anchor throws rather than scoring as a survivor.

⚠️ **One item in the brief read two ways.** *"numbers left as strings where v1 stored strings"* is
a correct implementation, not a wrong one — v1 stores `owner_id` as the string `"53"` and reads it
as a string. The wrong implementation in that direction is turning them into JSON numbers, which
is **MU3** (whole-column, via `_loose`) and **MU2** (one key, via an extra unwrap). Both are
killed. If the brief meant the opposite — that `owner_id` *should* become a number — that is a
behaviour change for the Phase 7 dedupe and the SQS payload, and it needs `business-analyst`,
not a migration (§8, Q-P9-2).

### 5.2 The preflight stop conditions are tested too

Six cells, each seeding the offending shape and asserting the RAISE text and the row ids it
names: unparseable `user_ids`, `keys` that does not parse after the repair, `keys` that already
contains a `"`, duplicates blocking D6/D11, and running the conversion twice. Plus three cells on
the unique constraints, including *"applies D11 to both tables or neither"* — which fails the
second `ALTER` and then asserts that **zero** `_user_id_key` constraints exist, i.e. the
`BEGIN/COMMIT` really is doing the work.

---

## 6. Release design and the proposed step-6 runbook

### 6.1 Release A vs Release B

|  | **Release A** — the cutover build (runbook step 3) | **Release B** — after step 6 |
|---|---|---|
| schema it runs on | **hstore** | **jsonb** |
| `schema.prisma` | `Unsupported("hstore")` ×2, no unique constraints | `Json @db.JsonB` ×2, `@unique` on `loan_id` and `user_id` ×2 |
| hstore codec | present; every read parses hstore text, every write emits a Python-repr hstore literal | **deleted** |
| the two repositories | raw SQL with `::text` / `::hstore` casts | ordinary Prisma models |
| `PRISMA_MIGRATIONS_PATH` | unset (`prisma/migrations` = `0_init` only) | unset again; the four step-6 directories have moved into `prisma/migrations` |
| what it does on the *other* schema | every hstore write is `ERROR: column … is of type jsonb but expression is of type hstore`; every read throws `SyntaxError` out of `parseHstore` (§4.2) | Prisma's `Json` writes fail with `is of type hstore but expression is of type jsonb`; reads return a string where the code expects an object |

**Release A is what this branch contains.** Its suites are green on the hstore schema (§7) and
must stay that way: A is what the cutover deploys, and rollback to v1 is alive until step 6.

### 6.2 Must Release B refuse to boot on an hstore schema? — yes

Both failure directions are loud *per request*, not at boot. Without a boot check, a Release B
deployed before the migration is a service that starts, serves every other route normally, and
500s only on notifications and the scheduler — the two subsystems with the thinnest inherited
coverage, one of which runs unattended twice a day. The same argument applies symmetrically to
Release A on a jsonb schema.

**Proposed detection (stage 2, not implemented here):** a `SchemaShapeGuard` provider whose
`onModuleInit` runs one query and throws before the app listens —

```sql
SELECT table_name, udt_name
  FROM information_schema.columns
 WHERE table_schema = current_schema()
   AND (table_name, column_name) IN (('fondo_api_schedulertask','payload'),
                                     ('fondo_api_notificationsubscriptions','subscription'));
```

Release B requires both `udt_name = 'jsonb'` and refuses otherwise, with a message naming
step 6. It belongs beside `PrismaService`, in `AppModule` (§4 rule 12's corollary: anything that
must run in e2e cannot live in `main.ts`). Deciding whether **Release A** gains the mirror-image
check (`hstore` required) is an operator call, because it is a change to the build that is about
to be cut — recommendation: **yes**, it is four lines and it converts the worst window in this
phase into a refusal to start.

### 6.3 Proposed runbook text for step 6 (plan §3, Phase 9 — for the plan owner to fold in)

> 6. **hstore → jsonb migration** (v2's first owned schema change; Q7). 🔴 **One-way door.**
>    Django's `HStoreField` breaks the instant this commits, **and so does the running v2
>    Release A** — measured: every `::hstore` write becomes
>    `ERROR: column "payload" is of type jsonb but expression is of type hstore`, and every
>    `::text` read returns JSON that `parseHstore` rejects. Rollback to v1 is dead from here.
>
>    **6.0 Backup.** `pg_dump -Fc` the whole database, verify the file restores into a scratch
>    database, and keep it off the host. This is the last restore point that can carry the
>    fund back to v1.
>
>    **6.1 Quiesce the writers.** Unset `SCHEDULER_ENABLED` on the runner and stop it; stop or
>    drain v2's API. The conversion itself takes `ACCESS EXCLUSIVE` and cannot interleave, but
>    Release A will error on every notification or scheduler write between the migration and
>    step 6.3, so this is a short, planned outage, not a rolling deploy.
>
>    **6.2 Preflight, then migrate.** From the release checkout:
>    ```bash
>    PRISMA_MIGRATIONS_PATH=prisma/migrations-step6 npx prisma migrate deploy
>    ```
>    Four migrations apply in order: `step6_preflight` (assertions only),
>    `hstore_to_jsonb` (the conversion plus its data-repair pass, in one transaction),
>    `loandetail_unique_loan_id` (**D6**), `userfinance_userpreference_unique_user_id`
>    (**D11**). Expect `applied_steps_count = 1` on each new row and **`0_init` still at 0** —
>    measured: `migrate deploy` neither re-applies nor rewrites it (**D34**, C39).
>
>    - A `P0001` error naming a row id is a **stop**: the data is a shape nobody measured, and
>      that is an operator decision, not something the migration may repair. Nothing was
>      changed; fix the row and re-run.
>    - `ERROR: current transaction is aborted` means the conversion's own post-conditions
>      failed inside its transaction. Nothing was changed either. Re-run the preflight
>      migration alone to get the readable reason.
>    - A `P3009` on a later attempt means a previous run left a failed row; resolve it with
>      `prisma migrate resolve --rolled-back <name>` **only after** confirming with §6.4's SQL
>      that the schema is untouched.
>
>    **6.3 Deploy Release B** — the build with the hstore codec removed, both repositories on
>    ordinary Prisma models, and `schema.prisma` declaring `Json @db.JsonB` plus the two
>    `@unique`s. Release B refuses to boot on an hstore schema; that refusal is the check that
>    6.2 actually ran.
>
>    **6.4 Verify, in this order:**
>    ```sql
>    -- a. both columns converted
>    SELECT table_name, column_name, udt_name FROM information_schema.columns
>     WHERE (table_name, column_name) IN (('fondo_api_schedulertask','payload'),
>                                        ('fondo_api_notificationsubscriptions','subscription'));
>    -- expect 2 rows, both jsonb
>
>    -- b. nothing is still doubly stringified, and nothing else stopped being a string
>    SELECT count(*) FILTER (WHERE jsonb_typeof(payload->'user_ids') = 'string') AS still_wrapped,
>           count(*) FILTER (WHERE jsonb_typeof(payload->'user_ids') <> 'array'
>                              AND payload ? 'user_ids')                        AS not_an_array,
>           count(*)                                                            AS rows
>      FROM fondo_api_schedulertask;                       -- expect 0 | 0 | 626
>    SELECT count(*) FILTER (WHERE jsonb_typeof(subscription->'keys') <> 'object') AS bad_keys,
>           count(*)                                                                AS rows
>      FROM fondo_api_notificationsubscriptions;           -- expect 0 | 94
>    SELECT count(*) FROM fondo_api_schedulertask t, jsonb_each(t.payload) e
>      WHERE e.key <> 'user_ids' AND jsonb_typeof(e.value) NOT IN ('string','null');  -- expect 0
>
>    -- c. the constraints exist
>    SELECT conname FROM pg_constraint
>     WHERE conname IN ('fondo_api_loandetail_loan_id_key',
>                       'fondo_api_userfinance_user_id_key',
>                       'fondo_api_userpreference_user_id_key');   -- expect 3 rows
>
>    -- d. the ledgers, in the state D34 requires
>    SELECT migration_name, applied_steps_count, finished_at IS NOT NULL AS finished
>      FROM _prisma_migrations ORDER BY started_at;
>    -- expect 0_init | 0 | t, then the four step-6 rows at 1 | t
>    SELECT count(*) FROM django_migrations;   -- expect 38, frozen, never written again
>    ```
>    Then smoke-test one subscribe/unsubscribe and one scheduler pass
>    (`grep -c 'Scheduler pass finished'`).
>
>    **6.5 Rollback is dead.** Record the time, and retire the v1 rollback instruction from the
>    incident procedure. The two ledgers now describe different schemas.

---

## 7. Gate

Baselines at `796ba2b`. Each step's own exit code, run on this branch.

| step | baseline | measured | Δ |
|---|---|---|---|
| `npm run lint` | 0 | **0** | — |
| `npm run typecheck` | 0 | **0** | — |
| `npm test` (unit) | 2590 / 80 | **2591 / 80** | **+1 cell**: `hstore.codec.spec.ts` — *"step 6: rejects the JSON text a converted jsonb column renders"* (§4.2's read-side measurement, pinned) |
| `npm run test:e2e` | 1348 + 2 skipped; 22 + 1 of 23 | **1375 + 2 skipped; 23 + 1 of 24** | **+27 cells, +1 suite**: `test/step6-hstore-jsonb.e2e-spec.ts` (§5) |
| fixture diff vs `~/.fondo-parity-harness/p8/out/BASELINE-fondodev-2026-09-12.txt` | 0 | **0** | — |
| fixture control `DB=fondo_api_test` | 1 | **1** | — |

Every delta is a cell this stage added; no existing cell changed. Commands, in order:

```bash
npm run lint && npm run typecheck && npm test && npm run test:e2e
scripts/parity/fixture-check.sh > now.txt
diff -q now.txt ~/.fondo-parity-harness/p8/out/BASELINE-fondodev-2026-09-12.txt      # exit 0
DB=fondo_api_test scripts/parity/fixture-check.sh > control.txt
diff -q control.txt ~/.fondo-parity-harness/p8/out/BASELINE-fondodev-2026-09-12.txt  # exit 1
```

⚠️ `fondo_api_test` was dropped and re-provisioned during §3.1's counter-measurement, which is
why the e2e run above is a clean provision from `prisma/migrations` — i.e. the suites are green
on the **hstore** schema, which is what Release A deploys.

---

## 8. Open questions

**For the operator**

- **Q-P9-1 — does the server-side `entrypoint_deploy` run `prisma migrate deploy`?** It is
  out-of-repo (`scripts/trigger-deploy.sh` sends an SSM command), so it cannot be read from here.
  If it does, the step-6 migrations must stay outside `prisma/migrations` until the moment of
  step 6 — which is what §3.1 already arranges — and stage 2's "move them in" must be sequenced
  *after* the migration has run in production, not before.
- **Q-P9-2 — does Release A get the mirror-image boot check** (refuse to start on a jsonb
  schema)? §6.2. It is a change to the build about to be cut; recommendation yes.
- **Q-P9-3 — the redundant indexes.** `fondo_api_loandetail_loan_id_6a9fa8c0` and the two
  `…_user_id_…` indexes become redundant once the unique constraints exist. Left in place
  deliberately; dropping them is a separate, reviewable change.
- **Q-P9-4 — production PostgreSQL version.** The migrations use only `hstore_to_jsonb`,
  `jsonb_set`, `jsonb_typeof` and PL/pgSQL, all available since 9.5, so no version gate is
  needed — but the proof ran on **18.6** (the dev container) and the production version is not
  recorded anywhere in this repository.

**For `business-analyst`**

- **Q-P9-5 — `owner_id` stays a string.** The conversion preserves v1's `"53"`. If anything
  downstream would rather have a number, that is a payload-format decision affecting the Phase 7
  dedupe and the SQS body, not a migration detail. Registering it rather than guessing (§5.1).
- **Q-P9-6 — the preflight refuses a `keys` value containing a `"`.** Measured 0 of 94 today. It
  is a stop rather than a pass-through because such a value was not written by Django's repr path
  and its decoded form has never been measured. If a row like that ever appears, the decision is
  the operator's.

---

## 9. Not in stage 1

Deleting the hstore codec, converting `NotificationSubscriptionRepository` and
`SchedulerTaskRepository` to Prisma models, the `schema.prisma` change of §4.3, the
`SchemaShapeGuard` of §6.2, moving the migrations into `prisma/migrations`, **C83** (the
path-id hoist) and **C90** (the two test nits). All stage 2, after this is reviewed.
