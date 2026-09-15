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
      USING HINT = 'Measured 0 of 94 rows on fondodev 2026-09-15. A double quote means the value was not written by Django''s repr path, so its decoded form has not been measured.';
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
