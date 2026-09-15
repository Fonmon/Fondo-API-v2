import { Client } from 'pg';
import { toHstoreLiteral } from '../src/common/utils/hstore.codec';
import {
  assertSchemaShape,
  REQUIRED_HSTORE_COLUMN_TYPE,
  schemaShapeSql,
  type SchemaColumnShape,
} from '../src/prisma/schema-shape.guard';
import { assertDisposableDatabase } from './shared-database-guard';
import { TEST_DATABASE_URL } from './test-database';
import {
  applyMutant,
  assertSemanticEquality,
  createStep6Schema,
  dropStep6Schema,
  readMigration,
  snapshotHstore,
  snapshotJsonb,
  STEP6_MIGRATIONS,
  STEP6_SCHEMA,
  withoutPostConditions,
  type Mutant,
} from './support/step6-harness';

/**
 * **Phase 9, step 6 — the hstore -> jsonb migration and its data-repair pass.**
 *
 * The migration is a one-way door: Django's `HStoreField` and v2's Release A both break the
 * instant it commits (measured — see `docs/phase-9-design.md` §5). So the questions this
 * suite has to answer are not "does it run" but:
 *
 *   1. does every row decode, after, to exactly what v1 decoded before — including the two
 *      doubly-stringified values, the NULLs, the rows missing a key, and the empty one;
 *   2. would a *wrong* repair pass be caught, or would it look identical?
 *
 * (2) is the point. The corpus is small and the migration is short, so a suite that only
 * asserts the happy path would be green for every plausible mistake in it. Every wrong
 * implementation enumerated in the mutation table below is applied to the real migration
 * text and scored, twice: against the shipped file (whose own in-transaction assertions
 * should abort it) and against a copy with those assertions stripped (so the external
 * equality check is what has to notice). Three blind controls are expected to survive.
 *
 * Runs against an isolated schema in the e2e database; `public` is untouched.
 */
describe('Phase 9 step 6 — hstore -> jsonb', () => {
  let client: Client;

  const PREFLIGHT = readMigration(STEP6_MIGRATIONS.preflight);
  const CONVERT = readMigration(STEP6_MIGRATIONS.convert);
  const LOAN_UNIQUE = readMigration(STEP6_MIGRATIONS.loanDetailUnique);
  const USER_UNIQUE = readMigration(STEP6_MIGRATIONS.userUnique);

  beforeAll(async () => {
    await assertDisposableDatabase(TEST_DATABASE_URL);
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    try {
      await dropStep6Schema(client);
    } finally {
      await client.end();
    }
  });

  /**
   * The corpus. Every shape measured on `fondodev` 2026-09-15, plus the shapes that are
   * absent there and would therefore never be exercised by the live data alone:
   * a missing key, a SQL NULL value, an empty hstore, an extra key, and a value carrying
   * the characters that survive a text round-trip badly.
   */
  async function seedCorpus(): Promise<void> {
    const task = async (payload: string): Promise<void> => {
      await client.query(
        `INSERT INTO fondo_api_schedulertask (type, run_date, payload, processed, repeat)
         VALUES (1, now(), $1::hstore, false, 0)`,
        [payload],
      );
    };
    const subscription = async (userId: number, sub: string): Promise<void> => {
      await client.query(
        `INSERT INTO fondo_api_notificationsubscriptions (user_id, subscription)
         VALUES ($1, $2::hstore)`,
        [userId, sub],
      );
    };

    // 1 — the canonical payment reminder, exactly as v1 writes it.
    await task(
      toHstoreLiteral({
        type: 'payment_reminder',
        owner_id: 53,
        target: '/loan/1',
        message: 'Recuerda realizar el pago de tu crédito',
        user_ids: [5, 6],
      }),
    );
    // 2 — the canonical birthday task, many recipients.
    await task(
      toHstoreLiteral({
        type: 'birthdate',
        owner_id: 9,
        target: '/',
        message: 'Hoy está cumpliendo años Nitza Marisol Montañez Herrera',
        user_ids: [2, 4, 3, 13, 5, 11, 12, 8, 6, 10, 7, 1],
      }),
    );
    // 3 — an empty recipient list.
    await task(toHstoreLiteral({ type: 'birthdate', owner_id: 1, user_ids: [] }));
    // 4 — `user_ids` holding a scalar. json.loads() accepts it; so must the repair.
    await task(`"type"=>"birthdate", "user_ids"=>"7"`);
    // 5 — no `user_ids` key at all. v1 KeyErrors on read; the migration must leave it alone.
    await task(toHstoreLiteral({ type: 'birthdate', owner_id: 3 }));
    // 6 — `user_ids` as SQL NULL (Django's None). Must become JSON null, not unwrapped.
    await task(`"type"=>"birthdate", "user_ids"=>NULL`);
    // 7 — an empty hstore. Contributes no entries, so ONLY a row-identity check sees it.
    await task('');
    // 8 — the characters a text round-trip mishandles, plus the non-ASCII v1 always writes.
    await task(
      toHstoreLiteral({
        type: 'birthdate',
        owner_id: 4,
        message: 'comillas " y \\ y salto\nde línea — áéíóú ñ',
        user_ids: [1],
      }),
    );
    // 9 — values that LOOK like JSON scalars but are strings in v1. `hstore_to_jsonb_loose`
    //     would convert these; `hstore_to_jsonb` must not.
    await task(
      `"type"=>"birthdate", "code"=>"007", "flag"=>"true", "amount"=>"1.50", "user_ids"=>"[2]"`,
    );
    // 10 — an unexpected extra key: nothing may quietly drop it.
    await task(`"type"=>"birthdate", "user_ids"=>"[3]", "extra"=>"keep me"`);

    // Subscriptions.
    await subscription(
      1,
      toHstoreLiteral({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        expirationTime: null,
        keys: { p256dh: 'BApAAA-_x', auth: 'nr8T_mWxi2BKYjbmgGfEfw' },
      }),
    );
    // No `expirationTime` key at all — 1 of the 94 live rows is like this.
    await subscription(
      2,
      toHstoreLiteral({
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz',
        keys: { p256dh: 'BBB', auth: 'CCC' },
      }),
    );
    // `keys` as SQL NULL: v1 raises AttributeError on read; the repair must skip it.
    await subscription(3, `"endpoint"=>"https://x/1", "keys"=>NULL`);
    // No `keys` key at all.
    await subscription(4, `"endpoint"=>"https://x/2"`);
    // Review finding m6 — the repair path carries a backslash, a newline and non-ASCII.
    // ⚠️ A double quote is deliberately NOT here: the preflight *stops* on one (measured 0 of
    // 94 on fondodev), and a cell below asserts that stop. What this row proves is that the
    // other three characters survive hstore -> jsonb -> the quote repair unchanged.
    await subscription(
      5,
      toHstoreLiteral({
        endpoint: 'https://x/3',
        keys: { auth: 'con\\barra y salto\nde línea — áéíóú', p256dh: 'ñÑ-_ABC' },
      }),
    );
  }

  async function freshCorpus(): Promise<void> {
    await createStep6Schema(client);
    await seedCorpus();
  }

  /**
   * Runs one migration text, reporting the SQL error rather than throwing out of the case.
   *
   * ⚠️ The `ROLLBACK` is load-bearing. The conversion and D11 migrations carry their own
   * `BEGIN; ... COMMIT;`, and PostgreSQL discards the rest of a multi-statement simple query
   * on error — including that `COMMIT`. Without this the session is left *idle in transaction
   * (aborted)*, every later statement fails with `current transaction is aborted`, and the
   * suite hangs in `afterAll` on a connection that never closes. It did, once.
   */
  async function run(sql: string): Promise<string | null> {
    try {
      await client.query(sql);
      return null;
    } catch (error) {
      await client.query('ROLLBACK');
      return error instanceof Error ? error.message : String(error);
    }
  }

  // -------------------------------------------------------------------------
  // 1. The shipped migration
  // -------------------------------------------------------------------------

  describe('the shipped migration', () => {
    it('preserves every decoded value, every row and the emitted key order', async () => {
      await freshCorpus();
      const before = await snapshotHstore(client);

      expect(await run(PREFLIGHT)).toBeNull();
      expect(await run(CONVERT)).toBeNull();

      const after = await snapshotJsonb(client);
      const result = assertSemanticEquality(before, after);
      expect(result.differences).toEqual([]);
      expect(result.equal).toBe(true);
      // The corpus is only evidence if it is actually populated, and pinning its shape is
      // what stops a seed being dropped without anyone noticing (rule 15b).
      expect(before.rows).toHaveLength(15);
      expect(before.entries).toHaveLength(41);
    });

    it('leaves both columns jsonb', async () => {
      const columns = await client.query<{ table_name: string; udt_name: string }>(
        `SELECT table_name, udt_name FROM information_schema.columns
          WHERE table_schema = $1 AND column_name IN ('payload', 'subscription')
          ORDER BY table_name`,
        [STEP6_SCHEMA],
      );
      expect(columns.rows).toEqual([
        { table_name: 'fondo_api_notificationsubscriptions', udt_name: 'jsonb' },
        { table_name: 'fondo_api_schedulertask', udt_name: 'jsonb' },
      ]);
    });

    it('unwraps user_ids and keys, and only those', async () => {
      const loose = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM (
           SELECT 1 FROM fondo_api_schedulertask t, jsonb_each(t.payload) e
             WHERE e.key <> 'user_ids' AND jsonb_typeof(e.value) NOT IN ('string', 'null')
           UNION ALL
           SELECT 1 FROM fondo_api_notificationsubscriptions n, jsonb_each(n.subscription) e
             WHERE e.key <> 'keys' AND jsonb_typeof(e.value) NOT IN ('string', 'null')
         ) s`,
      );
      expect(loose.rows[0].n).toBe('0');

      const repaired = await client.query<{ types: string }>(
        `SELECT string_agg(t, ',' ORDER BY t) AS types FROM (
           SELECT DISTINCT jsonb_typeof(payload -> 'user_ids') AS t FROM fondo_api_schedulertask
           UNION
           SELECT DISTINCT jsonb_typeof(subscription -> 'keys') FROM fondo_api_notificationsubscriptions
         ) s WHERE t IS NOT NULL`,
      );
      // array + number (the scalar row) + null (the SQL NULL row) + object (the keys) —
      // and crucially no `string`, which is what "still doubly stringified" would look like.
      expect(repaired.rows[0].types).toBe('array,null,number,object');
    });

    /**
     * **C91 — the nested `keys` member order. ✅ Ruled Q60: preserve `p256dh, auth`.**
     *
     * Before step 6, `keys` is an opaque hstore *string* holding a Python dict repr, and v1
     * `json.loads`es it into a dict whose order is the repr's — `p256dh, auth` in all 94 live
     * rows, which is the browser's own `PushSubscription.toJSON()` order. After step 6 it is a
     * jsonb *object*, and jsonb sorts members by (length, bytes), so what is **stored** becomes
     * `auth, p256dh`. The proof pins top-level key order; this is one level down, and the
     * project holds SQS bodies to a byte-identical criterion.
     *
     * The operator ruled **preserve `p256dh, auth`** (Q60). jsonb cannot hold a non-canonical
     * member order, so the conversion is unchanged and the order is pinned on the **emit**
     * side in Release B — **stage 2a**, with its own cell that fails if it flips.
     *
     * ⚠️ **Scope of this cell, stated precisely.** The 94/94 live measurement is
     * `business-analyst`'s (`docs/ba-phase-9-step6-questions.md`) and cannot run here — the
     * corpus row is seeded. What this cell pins is the pair that has to keep agreeing with it:
     * that v2's own write path (`toHstoreLiteral`, the shipped codec) stores the object in the
     * order it was given, `p256dh` first; and that the conversion then moves it. After step 6
     * the stored order does not exist anywhere, so this is asserted **now**, while the column
     * is still hstore.
     */
    it('C91: the nested `keys` member order — ruled Q60, preserve `p256dh, auth`', async () => {
      await freshCorpus();

      const before = await client.query<{ raw: string }>(
        `SELECT subscription -> 'keys' AS raw FROM fondo_api_notificationsubscriptions
          WHERE id = 1`,
      );
      // The Python repr Django wrote, in the order v1's json.loads would yield.
      const storedOrder = [...before.rows[0].raw.matchAll(/'([A-Za-z0-9_]+)':/g)].map((m) => m[1]);

      // The ruling, asserted while it is still observable.
      expect(storedOrder).toEqual(['p256dh', 'auth']);

      expect(await run(PREFLIGHT)).toBeNull();
      expect(await run(CONVERT)).toBeNull();

      const after = await client.query<{ keys: Record<string, string> }>(
        `SELECT subscription -> 'keys' AS keys FROM fondo_api_notificationsubscriptions
          WHERE id = 1`,
      );
      const storedOrderAfter = Object.keys(after.rows[0].keys);

      // What the conversion does to it — recorded, because Release B's pin exists to undo it.
      expect(storedOrderAfter).toEqual(['auth', 'p256dh']);
      expect(storedOrderAfter).not.toEqual(storedOrder);
      // Content is untouched either way; only the member order moves.
      expect(new Set(storedOrderAfter)).toEqual(new Set(storedOrder));
    });

    /**
     * The boot guard's shipped query, run against a genuinely converted schema (review M7).
     * The unit cells score `assertSchemaShape` on hand-built rows; this one proves the SQL
     * that feeds it returns what those cells assume.
     */
    it('the boot guard sees jsonb here and refuses a Release A boot', async () => {
      const rows = await client.query<SchemaColumnShape>(schemaShapeSql(`'${STEP6_SCHEMA}'`));
      expect(rows.rows).toEqual([
        { table_name: 'fondo_api_notificationsubscriptions', udt_name: 'jsonb' },
        { table_name: 'fondo_api_schedulertask', udt_name: 'jsonb' },
      ]);
      expect(() => assertSchemaShape(rows.rows, REQUIRED_HSTORE_COLUMN_TYPE)).toThrow(
        /deploy Release B instead/,
      );
    });

    it('is a one-way door for writers: an hstore write into the converted column fails', async () => {
      const message = await run(
        `UPDATE fondo_api_schedulertask SET payload = 'a=>b'::hstore WHERE id = 1`,
      );
      expect(message).toContain('is of type jsonb but expression is of type hstore');
    });
  });

  // -------------------------------------------------------------------------
  // 2. The preflight stop conditions
  // -------------------------------------------------------------------------

  describe('preflight stop conditions', () => {
    it('passes on the corpus', async () => {
      await freshCorpus();
      expect(await run(PREFLIGHT)).toBeNull();
    });

    it('refuses an unparseable user_ids, naming the row', async () => {
      await freshCorpus();
      await client.query(
        `UPDATE fondo_api_schedulertask SET payload = payload || '"user_ids"=>"not json"'::hstore WHERE id = 2`,
      );
      const message = await run(PREFLIGHT);
      expect(message).toContain("payload->'user_ids' is not valid JSON in 1 row(s)");
      expect(message).toContain('{2}');
    });

    it('refuses a keys value that does not parse after the quote repair', async () => {
      await freshCorpus();
      await client.query(
        `UPDATE fondo_api_notificationsubscriptions SET subscription = subscription || '"keys"=>"{''a'': ''b''"'::hstore WHERE id = 1`,
      );
      const message = await run(PREFLIGHT);
      expect(message).toContain('does not parse after the');
      expect(message).toContain('{1}');
    });

    it('refuses a keys value that already contains a double quote', async () => {
      await freshCorpus();
      await client.query(
        `UPDATE fondo_api_notificationsubscriptions SET subscription = subscription || hstore('keys', '{"a": "b"}') WHERE id = 2`,
      );
      const message = await run(PREFLIGHT);
      expect(message).toContain('already contains a double quote in 1 row(s)');
      expect(message).toContain('{2}');
    });

    it('refuses a user_ids that parses but is still a JSON string (M2)', async () => {
      await freshCorpus();
      await client.query(
        `UPDATE fondo_api_schedulertask SET payload = payload || hstore('user_ids', '"[1,2]"') WHERE id = 3`,
      );
      const message = await run(PREFLIGHT);
      expect(message).toContain('is a JSON string even after one unwrapping in 1 row(s)');
      expect(message).toContain('{3}');
    });

    it('accepts a scalar user_ids — json.loads does, so the port does (not a stop)', async () => {
      await freshCorpus();
      // Corpus row 4 already carries `"user_ids"=>"7"`.
      expect(await run(PREFLIGHT)).toBeNull();
    });

    it('refuses a keys value that repairs into something other than an object (M2)', async () => {
      await freshCorpus();
      await client.query(
        `UPDATE fondo_api_notificationsubscriptions SET subscription = subscription || hstore('keys', '[''a'', ''b'']') WHERE id = 2`,
      );
      const message = await run(PREFLIGHT);
      expect(message).toContain('does not repair into a JSON object in 1 row(s)');
      expect(message).toContain('{2}');
    });

    it('refuses a dependent index on a column being converted, by name (M3)', async () => {
      await freshCorpus();
      await client.query(
        `CREATE INDEX step6_dependent_probe ON fondo_api_schedulertask USING gin (payload)`,
      );
      const message = await run(PREFLIGHT);
      expect(message).toContain('dependent object(s) on the columns being converted');
      expect(message).toContain('index step6_dependent_probe on fondo_api_schedulertask.payload');
    });

    it('refuses a view that reads a column being converted, by name (M3)', async () => {
      await freshCorpus();
      await client.query(
        `CREATE VIEW step6_dependent_view AS SELECT id, payload FROM fondo_api_schedulertask`,
      );
      const message = await run(PREFLIGHT);
      expect(message).toContain('dependent object(s) on the columns being converted');
      expect(message).toContain('step6_dependent_view');
    });

    it('refuses duplicates that would block D6 and D11 — before the one-way door, not after', async () => {
      await freshCorpus();
      await client.query(`INSERT INTO fondo_api_loandetail (loan_id) VALUES (7), (7)`);
      await client.query(`INSERT INTO fondo_api_userfinance (user_id) VALUES (3), (3)`);
      const message = await run(PREFLIGHT);
      expect(message).toContain('duplicate keys block D6/D11');
      expect(message).toContain('loandetail.loan_id 1 group(s)');
      expect(message).toContain('userfinance.user_id 1 group(s)');
    });

    it('refuses to run twice — the columns are already jsonb', async () => {
      await freshCorpus();
      expect(await run(PREFLIGHT)).toBeNull();
      expect(await run(CONVERT)).toBeNull();
      const message = await run(PREFLIGHT);
      expect(message).toContain('expected both columns to still be hstore');
      expect(message).toContain('payload=jsonb');
    });
  });

  // -------------------------------------------------------------------------
  // 3. D6 and D11
  // -------------------------------------------------------------------------

  describe('the UNIQUE constraints (D6, D11)', () => {
    it('applies on clean data and then rejects a duplicate', async () => {
      await freshCorpus();
      await client.query(`INSERT INTO fondo_api_loandetail (loan_id) VALUES (1), (2)`);
      await client.query(`INSERT INTO fondo_api_userfinance (user_id) VALUES (1)`);
      await client.query(`INSERT INTO fondo_api_userpreference (user_id) VALUES (1)`);

      expect(await run(LOAN_UNIQUE)).toBeNull();
      expect(await run(USER_UNIQUE)).toBeNull();

      expect(await run(`INSERT INTO fondo_api_loandetail (loan_id) VALUES (1)`)).toContain(
        'fondo_api_loandetail_loan_id_key',
      );
      expect(await run(`INSERT INTO fondo_api_userfinance (user_id) VALUES (1)`)).toContain(
        'fondo_api_userfinance_user_id_key',
      );
      expect(await run(`INSERT INTO fondo_api_userpreference (user_id) VALUES (1)`)).toContain(
        'fondo_api_userpreference_user_id_key',
      );
    });

    it('refuses to create the loan_id constraint over a duplicate, naming the key', async () => {
      await freshCorpus();
      await client.query(`INSERT INTO fondo_api_loandetail (loan_id) VALUES (4), (4)`);
      const message = await run(LOAN_UNIQUE);
      // PostgreSQL names the index it could not build; the duplicated key itself is in the
      // error's DETAIL, which node-pg exposes separately from `message`.
      expect(message).toContain('could not create unique index "fondo_api_loandetail_loan_id_key"');
    });

    it('applies D11 to both tables or neither — the file is one transaction', async () => {
      await freshCorpus();
      await client.query(`INSERT INTO fondo_api_userfinance (user_id) VALUES (1)`);
      // The SECOND statement is the one that fails.
      await client.query(`INSERT INTO fondo_api_userpreference (user_id) VALUES (2), (2)`);
      expect(await run(USER_UNIQUE)).not.toBeNull();

      const constraints = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint c
           JOIN pg_namespace ns ON ns.oid = c.connamespace
          WHERE ns.nspname = $1 AND c.conname LIKE '%_user_id_key'`,
        [STEP6_SCHEMA],
      );
      expect(constraints.rows[0].n).toBe('0');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Mutation controls
  // -------------------------------------------------------------------------

  const UPDATE_USER_IDS = `UPDATE "fondo_api_schedulertask"
   SET "payload" = jsonb_set("payload", '{user_ids}', ("payload" ->> 'user_ids')::jsonb, false)
 WHERE jsonb_typeof("payload" -> 'user_ids') = 'string';`;

  const REPAIR_KEYS = `replace("subscription" ->> 'keys', '''', '"')::jsonb, false)`;

  const MUTANTS: readonly Mutant[] = [
    {
      id: 'MU1-no-user-ids-unwrap',
      what: 'the repair pass never unwraps user_ids — the value stays a JSON string of JSON',
      from: UPDATE_USER_IDS,
      to: '-- MU1: repair pass removed',
      expected: 'kill',
    },
    {
      id: 'MU2-unwrap-owner-id',
      what: 'unwraps a value that was never doubly stringified: owner_id "53" becomes 53',
      from: UPDATE_USER_IDS,
      to: `${UPDATE_USER_IDS}
UPDATE "fondo_api_schedulertask"
   SET "payload" = jsonb_set("payload", '{owner_id}', ("payload" ->> 'owner_id')::jsonb, false)
 WHERE jsonb_typeof("payload" -> 'owner_id') = 'string';`,
      expected: 'kill',
    },
    {
      id: 'MU3-loose-conversion',
      what: 'hstore_to_jsonb_loose: every numeric- or boolean-looking string stops being a string',
      from: 'USING hstore_to_jsonb("payload")',
      to: 'USING hstore_to_jsonb_loose("payload")',
      expected: 'kill',
    },
    {
      id: 'MU4-keys-left-as-string',
      what: 'the keys object is repaired but stored as a JSON string, not an object',
      from: REPAIR_KEYS,
      to: `to_jsonb(replace("subscription" ->> 'keys', '''', '"')), false)`,
      expected: 'kill',
    },
    {
      id: 'MU5-first-quote-only',
      what: "JavaScript's replace semantics: only the first ' becomes a \" and the JSON is invalid",
      from: REPAIR_KEYS,
      to: `regexp_replace("subscription" ->> 'keys', '''', '"')::jsonb, false)`,
      expected: 'kill',
    },
    {
      id: 'MU6-create-missing-null',
      what: 'a row with no user_ids key gains "user_ids": null',
      from: `("payload" ->> 'user_ids')::jsonb, false)
 WHERE jsonb_typeof("payload" -> 'user_ids') = 'string';`,
      to: `coalesce(("payload" ->> 'user_ids')::jsonb, 'null'::jsonb), true)
 WHERE true;`,
      expected: 'kill',
    },
    {
      id: 'MU7-drop-empty-rows',
      what: 'the empty-hstore row is dropped — invisible to any key-wise comparison',
      from: `-- The data-repair pass.`,
      to: `DELETE FROM "fondo_api_schedulertask" WHERE "payload" = '{}'::jsonb;

-- The data-repair pass.`,
      expected: 'kill',
    },
    {
      id: 'MU8-rebuild-known-keys',
      what: 'the payload is rebuilt from the five keys anyone expects, silently dropping others',
      from: UPDATE_USER_IDS,
      to: `UPDATE "fondo_api_schedulertask"
   SET "payload" = jsonb_strip_nulls(jsonb_build_object(
         'type', "payload" -> 'type',
         'owner_id', "payload" -> 'owner_id',
         'target', "payload" -> 'target',
         'message', "payload" -> 'message',
         'user_ids', ("payload" ->> 'user_ids')::jsonb));`,
      expected: 'kill',
    },
    {
      id: 'B1-redundant-predicate',
      what: 'blind control: a predicate that cannot change which rows match',
      from: `WHERE jsonb_typeof("payload" -> 'user_ids') = 'string';`,
      to: `WHERE jsonb_typeof("payload" -> 'user_ids') = 'string' AND "payload" ? 'user_ids';`,
      expected: 'survive',
    },
    {
      id: 'B2-repeat-the-repair',
      what: 'blind control: the repair pass runs twice — it is idempotent by its own predicate',
      from: UPDATE_USER_IDS,
      to: `${UPDATE_USER_IDS}
${UPDATE_USER_IDS}`,
      expected: 'survive',
    },
    {
      id: 'B3-comment-only',
      what: 'blind control: the text changes and the behaviour does not',
      from: 'BEGIN;',
      to: 'BEGIN;\n-- B3: a comment.',
      expected: 'survive',
    },
  ];

  /**
   * How each mutant died, recorded as it is scored and asserted as a whole table at the end.
   * "not null" is a weak assertion: it cannot tell a mutant caught by the migration's own
   * post-conditions from one that blew up on a syntax error, and those are different claims.
   */
  const outcomes: Array<{ id: string; guarded: string; stripped: string }> = [];

  describe('mutation controls on the data-repair pass', () => {
    it.each(MUTANTS.map((m) => [m.id, m] as const))(
      '%s — scored against the shipped migration and against the checker alone',
      async (_id, mutant) => {
        // (a) the shipped file, whose own in-transaction assertions should abort a bad one.
        await freshCorpus();
        await run(PREFLIGHT);
        const guardedError = await run(applyMutant(CONVERT, mutant));

        // (b) the same mutation with the migration's assertions stripped, so that the
        //     external equality check is the only thing left to notice.
        await freshCorpus();
        await run(PREFLIGHT);
        const before = await snapshotHstore(client);
        const strippedError = await run(applyMutant(withoutPostConditions(CONVERT), mutant));
        const equality =
          strippedError === null
            ? assertSemanticEquality(before, await snapshotJsonb(client))
            : { equal: false, differences: [`sql error: ${strippedError}`] };

        outcomes.push({
          id: mutant.id,
          guarded: guardedError === null ? 'applied' : 'aborted',
          stripped: strippedError !== null ? 'sql-error' : equality.equal ? 'identical' : 'diff',
        });

        if (mutant.expected === 'survive') {
          expect(guardedError).toBeNull();
          expect(strippedError).toBeNull();
          expect(equality.differences).toEqual([]);
        } else {
          // Killed twice, by two independent mechanisms.
          expect(guardedError).not.toBeNull();
          expect(equality.equal).toBe(false);
          expect(equality.differences.length).toBeGreaterThan(0);
        }
      },
    );

    it('kills each wrong implementation by the mechanism the design claims', () => {
      expect(outcomes).toEqual([
        // wrong implementations: aborted by the migration's own post-conditions, AND
        // rejected by the external equality check once those are stripped.
        { id: 'MU1-no-user-ids-unwrap', guarded: 'aborted', stripped: 'diff' },
        { id: 'MU2-unwrap-owner-id', guarded: 'aborted', stripped: 'diff' },
        { id: 'MU3-loose-conversion', guarded: 'aborted', stripped: 'diff' },
        { id: 'MU4-keys-left-as-string', guarded: 'aborted', stripped: 'diff' },
        // the only one PostgreSQL itself rejects: the half-repaired repr is not JSON.
        { id: 'MU5-first-quote-only', guarded: 'aborted', stripped: 'sql-error' },
        { id: 'MU6-create-missing-null', guarded: 'aborted', stripped: 'diff' },
        { id: 'MU7-drop-empty-rows', guarded: 'aborted', stripped: 'diff' },
        { id: 'MU8-rebuild-known-keys', guarded: 'aborted', stripped: 'diff' },
        // blind controls: applied cleanly, and indistinguishable from the shipped migration.
        { id: 'B1-redundant-predicate', guarded: 'applied', stripped: 'identical' },
        { id: 'B2-repeat-the-repair', guarded: 'applied', stripped: 'identical' },
        { id: 'B3-comment-only', guarded: 'applied', stripped: 'identical' },
      ]);
    });

    it('every mutant has a distinct id and at least one blind control exists', () => {
      expect(new Set(MUTANTS.map((m) => m.id)).size).toBe(MUTANTS.length);
      expect(MUTANTS.filter((m) => m.expected === 'survive').length).toBeGreaterThanOrEqual(3);
      expect(MUTANTS.filter((m) => m.expected === 'kill').length).toBeGreaterThanOrEqual(8);
    });

    it('a mutant whose anchor is missing fails loudly instead of scoring as a survivor', () => {
      expect(() =>
        applyMutant(CONVERT, {
          id: 'anchor-check',
          what: 'control on the harness itself',
          from: 'this text is not in the migration',
          to: 'x',
          expected: 'kill',
        }),
      ).toThrow(/anchor not found/);
    });
  });
});
