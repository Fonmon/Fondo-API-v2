-- Phase 9, step 6 — PREFLIGHT. Assertions only; this migration writes nothing.
--
-- ⚠️ It is a separate migration on purpose. Measured on Prisma 7.10.0 (2026-09-15,
-- `docs/phase-9-design.md` §3, measurement M-D34-5/6):
--
--   * a migration file is **NOT** atomic by default — `ALTER TABLE` survived a later
--     `SELECT 1/0` in the same file, leaving a half-applied schema and a `P3009` ledger row
--     that blocks every later deploy;
--   * wrapping the file in `BEGIN; ... COMMIT;` does make it atomic, but the operator then
--     sees `ERROR: current transaction is aborted` instead of the real error, because the
--     trailing `COMMIT` is the statement Prisma reports;
--   * a bare `DO $$ ... RAISE EXCEPTION ... $$;` as the first statement of a file with no
--     explicit transaction reports the RAISE text verbatim under `P3018`.
--
-- So every stop-condition an operator must read lives HERE, in a file with no writes and no
-- BEGIN/COMMIT, and the conversion itself lives in the next migration, wrapped.
--
-- Every check below is a stop condition, not a repair: if one fires, the data is a shape
-- nobody measured, and that is an operator question (plan §3 Phase 9, §5 D34).

-- ---------------------------------------------------------------------------
-- 1. The starting schema is the one this step was designed against.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  payload_type text;
  subscription_type text;
BEGIN
  SELECT udt_name INTO payload_type FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'fondo_api_schedulertask'
     AND column_name = 'payload';
  SELECT udt_name INTO subscription_type FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'fondo_api_notificationsubscriptions'
     AND column_name = 'subscription';

  IF payload_type IS DISTINCT FROM 'hstore' OR subscription_type IS DISTINCT FROM 'hstore' THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: expected both columns to still be hstore, found payload=% subscription=%',
      coalesce(payload_type, '<missing>'), coalesce(subscription_type, '<missing>')
      USING HINT = 'If they are already jsonb, step 6 has already run on this database.';
  END IF;

  IF to_regprocedure('hstore_to_jsonb(hstore)') IS NULL THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: hstore_to_jsonb(hstore) is not visible from search_path %', current_setting('search_path')
      USING HINT = 'The hstore extension must be installed and on the search_path for the conversion.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Every value v1 reads with json.loads() must parse.
--
--    v1: NotificationExecuter.run -> json.loads(payload["user_ids"])
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  bad bigint[] := '{}';
BEGIN
  FOR r IN
    SELECT id::bigint AS id, payload -> 'user_ids' AS v
      FROM fondo_api_schedulertask
     WHERE payload ? 'user_ids' AND payload -> 'user_ids' IS NOT NULL
  LOOP
    BEGIN
      PERFORM r.v::jsonb;
    EXCEPTION WHEN others THEN
      bad := bad || r.id;
    END;
  END LOOP;

  IF array_length(bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: fondo_api_schedulertask.payload->''user_ids'' is not valid JSON in % row(s); ids %',
      array_length(bad, 1), bad
      USING HINT = 'v1 reads this with json.loads(). A value it cannot parse is an operator decision, not something this migration may repair.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Every push-subscription `keys` value must parse AFTER v1's quote repair.
--
--    v1: subscription['keys'].replace("'", '"') then json.loads(...)
--    (a Python dict repr, never valid JSON as stored).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  bad bigint[] := '{}';
  preserialised bigint[] := '{}';
BEGIN
  FOR r IN
    SELECT id::bigint AS id, subscription -> 'keys' AS v
      FROM fondo_api_notificationsubscriptions
     WHERE subscription ? 'keys' AND subscription -> 'keys' IS NOT NULL
  LOOP
    IF strpos(r.v, '"') > 0 THEN
      preserialised := preserialised || r.id;
    END IF;
    BEGIN
      PERFORM replace(r.v, '''', '"')::jsonb;
    EXCEPTION WHEN others THEN
      bad := bad || r.id;
    END;
  END LOOP;

  IF array_length(bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: fondo_api_notificationsubscriptions.subscription->''keys'' does not parse after the '''' -> " repair in % row(s); ids %',
      array_length(bad, 1), bad
      USING HINT = 'This is exactly what v1 does before json.loads(). A row v1 cannot read is an operator decision.';
  END IF;

  IF array_length(preserialised, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: subscription->''keys'' already contains a double quote in % row(s); ids %',
      array_length(preserialised, 1), preserialised
      USING HINT = 'Measured 0 of 94 rows on fondodev 2026-09-15. Such a value cannot come from Django''s repr path, and v1''s blunt quote replace on it yields either valid-but-wrong JSON (that device silently never receives push again) or invalid JSON, which raises inside send_notification and loses the notification for EVERY recipient in the batch. STOP, inspect the row and tell the member; delete it only if the value cannot be decoded. Under Q62 the PWA subscribes on explicit opt-in only, so the browser will NOT re-register on its own. Runbook 6.10.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The two UNIQUE constraints that follow must be addable.
--
--    They are their own migrations, but their stop conditions belong BEFORE the one-way
--    door: a duplicate discovered after the hstore conversion has committed is a stop with
--    the door already shut (plan §3 Phase 6 note, §5 D6 / D11).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dup_loan bigint;
  dup_finance bigint;
  dup_preference bigint;
BEGIN
  SELECT count(*) INTO dup_loan FROM (
    SELECT loan_id FROM fondo_api_loandetail GROUP BY loan_id HAVING count(*) > 1) s;
  SELECT count(*) INTO dup_finance FROM (
    SELECT user_id FROM fondo_api_userfinance GROUP BY user_id HAVING count(*) > 1) s;
  SELECT count(*) INTO dup_preference FROM (
    SELECT user_id FROM fondo_api_userpreference GROUP BY user_id HAVING count(*) > 1) s;

  IF dup_loan > 0 OR dup_finance > 0 OR dup_preference > 0 THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: duplicate keys block D6/D11 — loandetail.loan_id % group(s), userfinance.user_id % group(s), userpreference.user_id % group(s)',
      dup_loan, dup_finance, dup_preference
      USING HINT = 'D6/D11 say which row wins is an operator decision; v2 reads the lowest id. Resolve the duplicates, then re-run.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. A value that PARSES but is still a JSON string — review finding M2.
--
--    `json.loads('"[1,2]"')` returns the *string* `[1,2]`, not a list. Such a row survives
--    check 2 and the repair pass, and the result looks structurally fine while being one
--    unwrapping short. Measured 0 of 626 on fondodev 2026-09-15 — and "0 today" is exactly
--    why it belongs here rather than in a comment: production's shapes are unmeasured.
--
--    A scalar (`json.loads('7')` -> 7) is NOT rejected: that is what v1 would hand the
--    application, and reproducing v1 is the rule. Only the still-a-string case is a stop.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  bad bigint[] := '{}';
BEGIN
  FOR r IN
    SELECT id::bigint AS id, payload -> 'user_ids' AS v
      FROM fondo_api_schedulertask
     WHERE payload ? 'user_ids' AND payload -> 'user_ids' IS NOT NULL
  LOOP
    BEGIN
      IF jsonb_typeof(r.v::jsonb) = 'string' THEN
        bad := bad || r.id;
      END IF;
    EXCEPTION WHEN others THEN
      NULL;  -- check 2 above owns the unparseable case and has already raised.
    END;
  END LOOP;

  IF array_length(bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: payload->''user_ids'' is a JSON string even after one unwrapping in % row(s); ids %',
      array_length(bad, 1), bad
      USING HINT = 'The value is stringified twice over. Unwrapping it once leaves a string where the application expects a list; how many times to unwrap is an operator decision.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. A `keys` value whose repaired form is not an object — review finding M2.
--
--    v1 does `subscription['keys'] = json.loads(...)` and then hands the result to the push
--    layer as a mapping. A repaired value that parses to an array, a string or a number is a
--    shape nothing downstream has ever seen. Measured 94 of 94 objects on fondodev.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  bad bigint[] := '{}';
BEGIN
  FOR r IN
    SELECT id::bigint AS id, subscription -> 'keys' AS v
      FROM fondo_api_notificationsubscriptions
     WHERE subscription ? 'keys' AND subscription -> 'keys' IS NOT NULL
  LOOP
    BEGIN
      IF jsonb_typeof(replace(r.v, '''', '"')::jsonb) <> 'object' THEN
        bad := bad || r.id;
      END IF;
    EXCEPTION WHEN others THEN
      NULL;  -- check 3 above owns the unparseable case and has already raised.
    END;
  END LOOP;

  IF array_length(bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: subscription->''keys'' does not repair into a JSON object in % row(s); ids %',
      array_length(bad, 1), bad
      USING HINT = 'v1 hands this to the push layer as a mapping. An array, string or number there is a shape nothing downstream has seen.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Dependent objects on the two columns — review findings M3 and **C95**.
--
--    `ALTER TABLE ... ALTER COLUMN ... TYPE` rebuilds dependent indexes and REFUSES outright
--    when a view or rule reads the column ("cannot alter type of a column used by a view or
--    rule"). Both failures land inside the wrapped conversion, where the message is masked by
--    the trailing COMMIT — which is precisely what this two-file split exists to avoid. So
--    they are detected here, by name, while the error is still readable.
--
--    ⚠️ **C95 — the first version of this check joined `pg_attribute` on
--    `a.attnum = ANY(i.indkey)` and could not see an expression index.** `indkey` holds **0**
--    for an expression column, so `CREATE INDEX ... ON fondo_api_schedulertask (akeys(payload))`
--    returned nothing here and then aborted the conversion with the masked
--    `ERROR: current transaction is aborted` — the exact failure this file exists to prevent.
--    Measured by `nestjs-reviewer` on a scratch 17 clone.
--
--    The replacement sweeps **`pg_depend`** instead: any object that depends on the column
--    itself (`refclassid = 'pg_class'`, `refobjsubid` = the column's `attnum`). That catches
--    an expression index, a *predicate* reference in a partial index, a CHECK constraint and a
--    generated column, none of which `indkey` reports. `deptype <> 'i'` drops the internal
--    self-dependency a column has on its own table.
--
--    The `pg_rewrite` branch is kept as well, purely for wording: a view or rule is reported
--    as "view/rule <name> on <table>" rather than as an anonymous rewrite rule.
--
--    Measured on fondodev 2026-09-15 (and independently by nestjs-reviewer): no index on
--    either column beyond the primary key, and no view or rule referencing them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text[] := '{}';
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT
           coalesce(
             -- a rewrite rule (a view is a rule on its own relation): name the relation.
             (SELECT 'view/rule ' || rw.rulename || ' on ' || cl.relname
                FROM pg_rewrite rw JOIN pg_class cl ON cl.oid = rw.ev_class
               WHERE d.classid = 'pg_rewrite'::regclass AND rw.oid = d.objid),
             -- anything else: its catalog and its name, via the generic description.
             pg_describe_object(d.classid, d.objid, d.objsubid)
           ) AS what
      FROM pg_depend d
      JOIN pg_attribute a
        ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE d.refclassid = 'pg_class'::regclass
       AND d.refobjid IN (to_regclass('fondo_api_schedulertask')::oid,
                          to_regclass('fondo_api_notificationsubscriptions')::oid)
       AND a.attname IN ('payload', 'subscription')
       AND d.deptype <> 'i'
       -- ⚠️ **A NOT NULL constraint is not a blocker, and PostgreSQL 18 catalogues one.**
       -- Measured 2026-09-15: on 18.6 this sweep returns
       -- `constraint fondo_api_schedulertask_payload_not_null` and
       -- `..._subscription_not_null` (`pg_constraint.contype = 'n'`, `deptype = 'a'`) for the
       -- untouched reference data, while on 17.11 it returns nothing — PG18 materialises
       -- NOT NULL in `pg_constraint` and 17 does not. `ALTER COLUMN ... TYPE` carries a NOT
       -- NULL across without complaint, so excluding `contype = 'n'` is correct rather than
       -- convenient. A CHECK constraint (`contype = 'c'`) is still reported.
       AND NOT (d.classid = 'pg_constraint'::regclass
                AND (SELECT c.contype FROM pg_constraint c WHERE c.oid = d.objid) = 'n')
  LOOP
    offenders := offenders || r.what;
  END LOOP;

  IF array_length(offenders, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6 PREFLIGHT: % dependent object(s) on the columns being converted: %',
      array_length(offenders, 1), array_to_string(offenders, ', ')
      USING HINT = 'An index is rebuilt (and an expression or hstore-opclass index cannot be); a view or rule makes ALTER COLUMN TYPE refuse outright. Drop them deliberately, then re-run.';
  END IF;
END $$;
