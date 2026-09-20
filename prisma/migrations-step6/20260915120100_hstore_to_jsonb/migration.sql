-- Phase 9, step 6 — hstore -> jsonb, with the data-repair pass.
--
-- 🔴 ONE-WAY DOOR. Django's HStoreField breaks the instant this commits, and so does
-- Release A of v2 (it writes `$1::hstore` and reads `subscription::text`). Rollback to v1
-- is dead from here. Take the backup first; see docs/phase-9-design.md §6 for the runbook.
--
-- ⚠️ The whole file is one transaction. Measured on Prisma 7.10.0: without BEGIN/COMMIT a
-- migration file is not atomic, and a failure after the first ALTER leaves one column jsonb
-- and the other hstore (docs/phase-9-design.md §3, M-D34-5). The cost of the wrapper is that
-- a RAISE below is reported to the operator as `ERROR: current transaction is aborted` —
-- the readable stop conditions therefore live in the preceding `_step6_preflight` migration,
-- which is deliberately unwrapped. If you see the aborted-transaction message here, nothing
-- was applied; re-run `_step6_preflight`'s checks to find out why.
--
-- What the conversion does to each value, and why:
--
--   hstore stores strings only. Django `str()`s every value on the way in, so the database
--   holds v1's Python repr, and v1 repairs it on the way out. `hstore_to_jsonb` reproduces
--   the storage exactly — every value becomes a JSON *string*, a NULL value becomes JSON
--   `null` — and the two UPDATEs below do, once and permanently, the repair v1 does on
--   every read:
--
--   | column                               | key        | v1 read path                                    |
--   |--------------------------------------|------------|-------------------------------------------------|
--   | fondo_api_schedulertask.payload      | user_ids   | json.loads(payload["user_ids"])                 |
--   | fondo_api_notificationsubscriptions  | keys       | json.loads(keys.replace("'", '"'))              |
--
--   Everything else — `owner_id` ('53'), `type`, `target`, `message`, `endpoint` — v1 reads
--   as the string it stored, so it STAYS a JSON string. `hstore_to_jsonb_loose` would turn
--   `owner_id` into the number 53 and is the wrong function here; the assertion at the end
--   of this file is what stops it.
--
-- Measured on fondodev 2026-09-15 (read-only): 626 schedulertask rows, 5 keys each, all 626
-- `user_ids` values valid JSON arrays of numbers; 94 subscription rows, 93 with
-- `expirationTime` = SQL NULL and 1 without the key at all, all 94 `keys` values parsing
-- after the quote repair into {auth, p256dh}; 0 NULL and 0 empty hstore columns.

BEGIN;

-- The v1-decoded value of every entry, computed BEFORE anything changes. The assertion at
-- the bottom compares it to what the conversion produced, row by row and key by key, inside
-- this transaction — so a conversion that changes any decoded value rolls itself back.
CREATE TEMP TABLE step6_decoded_before ON COMMIT DROP AS
  SELECT 'fondo_api_schedulertask'::text AS tbl,
         t.id::bigint                    AS row_id,
         e.key                           AS entry_key,
         CASE
           WHEN e.key = 'user_ids' AND e.value IS NOT NULL THEN e.value::jsonb
           ELSE coalesce(to_jsonb(e.value), 'null'::jsonb)
         END                             AS decoded
    FROM fondo_api_schedulertask t, each(t.payload) e
  UNION ALL
  SELECT 'fondo_api_notificationsubscriptions',
         n.id::bigint,
         e.key,
         CASE
           WHEN e.key = 'keys' AND e.value IS NOT NULL THEN replace(e.value, '''', '"')::jsonb
           ELSE coalesce(to_jsonb(e.value), 'null'::jsonb)
         END
    FROM fondo_api_notificationsubscriptions n, each(n.subscription) e;

-- Row identity, so that a dropped or added ROW is caught too. A key-wise comparison alone
-- cannot see an empty hstore row disappear: it contributes no entries to either side.
CREATE TEMP TABLE step6_rows_before ON COMMIT DROP AS
  SELECT 'fondo_api_schedulertask'::text AS tbl, id::bigint AS row_id FROM fondo_api_schedulertask
  UNION ALL
  SELECT 'fondo_api_notificationsubscriptions', id::bigint FROM fondo_api_notificationsubscriptions;

ALTER TABLE "fondo_api_schedulertask"
  ALTER COLUMN "payload" TYPE jsonb USING hstore_to_jsonb("payload");

ALTER TABLE "fondo_api_notificationsubscriptions"
  ALTER COLUMN "subscription" TYPE jsonb USING hstore_to_jsonb("subscription");

-- The data-repair pass. `jsonb_typeof(... ) = 'string'` is the precise predicate for
-- "doubly stringified": a value the conversion left as a JSON string. A key that is absent,
-- SQL NULL (now JSON null) or already structured is skipped, which also makes both
-- statements idempotent.
UPDATE "fondo_api_schedulertask"
   SET "payload" = jsonb_set("payload", '{user_ids}', ("payload" ->> 'user_ids')::jsonb, false)
 WHERE jsonb_typeof("payload" -> 'user_ids') = 'string';

UPDATE "fondo_api_notificationsubscriptions"
   SET "subscription" = jsonb_set("subscription", '{keys}', replace("subscription" ->> 'keys', '''', '"')::jsonb, false)
 WHERE jsonb_typeof("subscription" -> 'keys') = 'string';

-- >>> step6 post-conditions
DO $$
DECLARE
  mismatches bigint;
  sample text;
  missing_rows bigint;
  extra_rows bigint;
  loose_values bigint;
  left_stringified bigint;
BEGIN
  -- (a) every entry decodes to the same value it decoded to before.
  SELECT count(*), left(coalesce(string_agg(format('%s#%s.%s: %s -> %s', tbl, row_id, entry_key, bef, aft), '; '), ''), 400)
    INTO mismatches, sample
    FROM (
      SELECT coalesce(b.tbl, a.tbl) AS tbl, coalesce(b.row_id, a.row_id) AS row_id,
             coalesce(b.entry_key, a.entry_key) AS entry_key,
             b.decoded::text AS bef, a.value::text AS aft
        FROM step6_decoded_before b
        FULL OUTER JOIN (
          SELECT 'fondo_api_schedulertask'::text AS tbl, t.id::bigint AS row_id, e.key AS entry_key, e.value
            FROM fondo_api_schedulertask t, jsonb_each(t.payload) e
          UNION ALL
          SELECT 'fondo_api_notificationsubscriptions', n.id::bigint, e.key, e.value
            FROM fondo_api_notificationsubscriptions n, jsonb_each(n.subscription) e
        ) a ON a.tbl = b.tbl AND a.row_id = b.row_id AND a.entry_key = b.entry_key
       WHERE b.decoded IS DISTINCT FROM a.value
    ) d;

  IF mismatches > 0 THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6: % entry(ies) do not decode to the same value after conversion. First: %', mismatches, sample;
  END IF;

  -- (b) no row gained or lost. Catches an empty-hstore row being dropped, which (a) cannot see.
  SELECT count(*) FILTER (WHERE a.row_id IS NULL), count(*) FILTER (WHERE b.row_id IS NULL)
    INTO missing_rows, extra_rows
    FROM step6_rows_before b
    FULL OUTER JOIN (
      SELECT 'fondo_api_schedulertask'::text AS tbl, id::bigint AS row_id FROM fondo_api_schedulertask
      UNION ALL
      SELECT 'fondo_api_notificationsubscriptions', id::bigint FROM fondo_api_notificationsubscriptions
    ) a ON a.tbl = b.tbl AND a.row_id = b.row_id
   WHERE a.row_id IS NULL OR b.row_id IS NULL;

  IF missing_rows > 0 OR extra_rows > 0 THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6: row identity changed — % row(s) lost, % row(s) appeared', missing_rows, extra_rows;
  END IF;

  -- (c) nothing except the two repaired keys became a non-string. This is the assertion that
  --     fails if `hstore_to_jsonb_loose` is ever substituted for `hstore_to_jsonb`.
  SELECT count(*) INTO loose_values FROM (
    SELECT 1 FROM fondo_api_schedulertask t, jsonb_each(t.payload) e
      WHERE e.key <> 'user_ids' AND jsonb_typeof(e.value) NOT IN ('string', 'null')
    UNION ALL
    SELECT 1 FROM fondo_api_notificationsubscriptions n, jsonb_each(n.subscription) e
      WHERE e.key <> 'keys' AND jsonb_typeof(e.value) NOT IN ('string', 'null')
  ) s;

  IF loose_values > 0 THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6: % entry(ies) outside user_ids/keys are no longer JSON strings. hstore stored strings; v1 reads them as strings.', loose_values;
  END IF;

  -- (d) and the two repaired keys are no longer strings-containing-JSON.
  SELECT count(*) INTO left_stringified FROM (
    SELECT 1 FROM fondo_api_schedulertask WHERE jsonb_typeof(payload -> 'user_ids') = 'string'
    UNION ALL
    SELECT 1 FROM fondo_api_notificationsubscriptions WHERE jsonb_typeof(subscription -> 'keys') = 'string'
  ) s;

  IF left_stringified > 0 THEN
    RAISE EXCEPTION 'PHASE 9 STEP 6: % value(s) are still doubly stringified after the repair pass', left_stringified;
  END IF;
END $$;
-- <<< step6 post-conditions

COMMIT;
