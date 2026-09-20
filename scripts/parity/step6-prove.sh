#!/usr/bin/env bash
# step6-prove.sh — prove the Phase 9 step-6 migration on a clone, row by row.
#
#   scripts/parity/step6-prove.sh <pristine-clone-db> <scratch-run-db> [outdir]
#
# <pristine-clone-db>  an hstore-schema pg_restore clone of fondodev. NEVER modified.
# <scratch-run-db>     dropped, re-created from the pristine clone with CREATE DATABASE
#                      ... TEMPLATE, then migrated. Must be named *_run.
#
# Exit 0 only if ALL of the following hold:
#
#   1. Forward, semantic, row-by-row: for every row of both hstore tables and every key in
#      it, the value v1 decodes BEFORE equals the jsonb value stored AFTER. v1's read
#      semantics are `json.loads(payload['user_ids'])` and
#      `json.loads(subscription['keys'].replace("'", '"'))`; everything else is the string
#      hstore held, and a NULL value is JSON null.
#   2. Row identity: the same ids, and the same number of them. A key-wise check alone
#      cannot see an empty-hstore row vanish, because it contributes no keys to either side.
#   3. Key ORDER, per row. PostgreSQL emits hstore entries ordered by (key length, key
#      bytes) and v1 json.dumps()es that dict straight onto the SQS wire (plan §2), so the
#      order is part of the wire format, not a detail. jsonb sorts object keys by the same
#      rule; this check is what turns that into a measurement.
#   4. Reverse: nothing else changed — every other table's count, every sequence's
#      last_value, and every table's xmin cardinality.
#
# ⚠️ The two converted tables are EXPECTED to differ on xmin cardinality: `ALTER TABLE ...
# TYPE` rewrites every row. That expectation is stated as a value, not waved through: the
# script prints the before/after pair and only tolerates a change on those two tables.
#
# ⚠️ CREATE DATABASE ... TEMPLATE, not dropdb/createdb of the clone itself. Measured: the
# copy preserves the hstore type OID (false-green #23's mechanism — reset-clone.sh explains
# why that matters), and the pristine clone is never touched, so it stays a valid baseline
# for repeated runs.
set -euo pipefail

PRISTINE="${1:?usage: step6-prove.sh <pristine-clone-db> <scratch-run-db> [outdir]}"
RUN="${2:?usage: step6-prove.sh <pristine-clone-db> <scratch-run-db> [outdir]}"
OUT="${3:-$(mktemp -d)}"
MIGRATIONS="${PRISMA_MIGRATIONS_PATH:-prisma/migrations-step6}"

for db in "$PRISTINE" "$RUN"; do
  if [ "$db" = "fondodev" ]; then
    echo "REFUSING: $db is the shared development database." >&2; exit 5
  fi
done
case "$RUN" in
  *_run) ;;
  *) echo "REFUSING: the scratch run database must be named *_run (got '$RUN'); it is dropped." >&2; exit 5;;
esac

mkdir -p "$OUT"

# The decoded view of the hstore side: v1's read semantics, in SQL.
read -r -d '' BEFORE_ENTRIES <<'SQL' || true
SELECT tbl, row_id, entry_key, decoded::text FROM (
  SELECT 'fondo_api_schedulertask'::text AS tbl, t.id::bigint AS row_id, e.key AS entry_key,
         CASE WHEN e.key = 'user_ids' AND e.value IS NOT NULL THEN e.value::jsonb
              ELSE coalesce(to_jsonb(e.value), 'null'::jsonb) END AS decoded
    FROM fondo_api_schedulertask t, each(t.payload) e
  UNION ALL
  SELECT 'fondo_api_notificationsubscriptions', n.id::bigint, e.key,
         CASE WHEN e.key = 'keys' AND e.value IS NOT NULL THEN replace(e.value, '''', '"')::jsonb
              ELSE coalesce(to_jsonb(e.value), 'null'::jsonb) END
    FROM fondo_api_notificationsubscriptions n, each(n.subscription) e
) s ORDER BY tbl, row_id, entry_key;
SQL

read -r -d '' AFTER_ENTRIES <<'SQL' || true
SELECT tbl, row_id, entry_key, value::text FROM (
  SELECT 'fondo_api_schedulertask'::text AS tbl, t.id::bigint AS row_id, e.key AS entry_key, e.value
    FROM fondo_api_schedulertask t, jsonb_each(t.payload) e
  UNION ALL
  SELECT 'fondo_api_notificationsubscriptions', n.id::bigint, e.key, e.value
    FROM fondo_api_notificationsubscriptions n, jsonb_each(n.subscription) e
) s ORDER BY tbl, row_id, entry_key;
SQL

read -r -d '' ROWS_SQL <<'SQL' || true
SELECT 'fondo_api_schedulertask' AS tbl, id FROM fondo_api_schedulertask
UNION ALL SELECT 'fondo_api_notificationsubscriptions', id FROM fondo_api_notificationsubscriptions
ORDER BY 1, 2;
SQL

# Emitted key order, per row, as one comma-joined string.
read -r -d '' KEYORDER_BEFORE <<'SQL' || true
SELECT 'fondo_api_schedulertask' AS tbl, id,
       (SELECT string_agg(key, ',') FROM each(payload)) AS key_order
  FROM fondo_api_schedulertask
UNION ALL
SELECT 'fondo_api_notificationsubscriptions', id,
       (SELECT string_agg(key, ',') FROM each(subscription))
  FROM fondo_api_notificationsubscriptions
ORDER BY 1, 2;
SQL

read -r -d '' KEYORDER_AFTER <<'SQL' || true
SELECT 'fondo_api_schedulertask' AS tbl, id,
       (SELECT string_agg(k, ',') FROM jsonb_object_keys(payload) k) AS key_order
  FROM fondo_api_schedulertask
UNION ALL
SELECT 'fondo_api_notificationsubscriptions', id,
       (SELECT string_agg(k, ',') FROM jsonb_object_keys(subscription) k)
  FROM fondo_api_notificationsubscriptions
ORDER BY 1, 2;
SQL

# ⚠️ **Content digests, not `count(DISTINCT xmin)` — review finding M6.** xmin cardinality is
# 1 for every table straight after a `pg_restore`, and it is *still* 1 after a transaction
# rewrites the whole table, so as a "nothing else changed" probe it is nearly blind. This
# digests every row instead: `row_to_json` per row, sorted by its own text so no primary key
# is assumed, then one md5 per table. Control 3 below touches a row in an unrelated table and
# is expected to move it.
#
# The two converted tables are excluded from the digest and only counted: their content is
# *supposed* to change shape, and the entries / rows / keyorder comparisons cover it in
# detail. `_prisma_migrations` is the ledger this step writes, and is reported separately.
read -r -d '' REVERSE_SQL <<'SQL' || true
SET TIME ZONE 'UTC';
SELECT 'count' AS kind, c.relname AS name, n.n::text AS value
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
  CROSS JOIN LATERAL (SELECT (xpath('/row/c/text()',
      query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n) n
 WHERE c.relkind = 'r'
UNION ALL
SELECT 'digest', c.relname, d.h
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
  CROSS JOIN LATERAL (SELECT (xpath('/row/c/text()',
      query_to_xml(format(
        'SELECT md5(coalesce(string_agg(r, chr(10) ORDER BY r), '''')) AS c'
        ' FROM (SELECT row_to_json(t)::text AS r FROM public.%I t) s', c.relname),
        false, true, '')))[1]::text AS h) d
 WHERE c.relkind = 'r'
   AND c.relname NOT IN ('fondo_api_schedulertask', 'fondo_api_notificationsubscriptions',
                         '_prisma_migrations')
UNION ALL
SELECT 'sequence', sequencename, coalesce(last_value::text, '<unread>')
  FROM pg_sequences WHERE schemaname = 'public'
ORDER BY 1, 2;
SQL

# Recorded in the artifacts so a proof can be attributed to a server version (Q59).
read -r -d '' SERVER_SQL <<'SQL' || true
SELECT 'server_version', current_setting('server_version')
UNION ALL SELECT 'hstore_extversion', coalesce((SELECT extversion FROM pg_extension WHERE extname = 'hstore'), '<absent>')
UNION ALL SELECT 'hstore_to_jsonb', coalesce(to_regprocedure('hstore_to_jsonb(hstore)')::text, '<unresolvable>')
UNION ALL SELECT 'search_path', current_setting('search_path')
ORDER BY 1;
SQL

q() { psql -d "$1" -At -F'|' -v ON_ERROR_STOP=1 -c "$2"; }

echo "== 0. build $RUN from $PRISTINE =="
if psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$RUN'" | grep -q 1; then dropdb "$RUN"; fi
createdb -T "$PRISTINE" "$RUN"

q "$PRISTINE" "$SERVER_SQL" > "$OUT/server.txt"
echo "   target server: $(grep '^server_version|' "$OUT/server.txt" | cut -d'|' -f2)"

echo "== 1. snapshot BEFORE (from the pristine hstore clone) =="
q "$PRISTINE" "$BEFORE_ENTRIES"   > "$OUT/entries.before"
q "$PRISTINE" "$ROWS_SQL"         > "$OUT/rows.before"
q "$PRISTINE" "$KEYORDER_BEFORE"  > "$OUT/keyorder.before"
q "$PRISTINE" "$REVERSE_SQL"      > "$OUT/reverse.before"

echo "== 2. prisma migrate deploy ($MIGRATIONS) on $RUN =="
# Prisma does not read PGPASSFILE, so the URL needs the password inline. It is read from the
# same file psql uses and never echoed: the deploy output is filtered through `redact`.
step6_password() {
  if [ -n "${PGPASSWORD:-}" ]; then printf '%s' "$PGPASSWORD"; return; fi
  if [ -n "${PGPASSFILE:-}" ] && [ -f "$PGPASSFILE" ]; then
    awk -F: -v u="${PGUSER:-fondouser}" '$4 == u || $4 == "*" { print $5; exit }' "$PGPASSFILE"
    return
  fi
  echo "REFUSING: no PGPASSWORD and no usable PGPASSFILE; prisma cannot authenticate." >&2
  exit 8
}
STEP6_PW="$(step6_password)"
if [ -z "$STEP6_PW" ]; then echo "REFUSING: empty database password." >&2; exit 8; fi
redact() { sed "s/$STEP6_PW/REDACTED/g"; }

set +e
# ⚠️ `STEP6_CONFIRM` is the second half of C96's gate: a non-default ledger is refused unless
# a variable carries TODAY's date in Bogotá. It is computed here rather than hard-coded, so
# this script keeps working tomorrow and still cannot be what leaves a stale one behind.
DATABASE_URL="postgresql://${PGUSER:-fondouser}:${STEP6_PW}@${PGHOST:-localhost}:${PGPORT:-5432}/$RUN?schema=public" \
PRISMA_MIGRATIONS_PATH="$MIGRATIONS" \
STEP6_CONFIRM="$(TZ=America/Bogota date +%F)" \
  npx prisma migrate deploy 2>&1 | redact | grep -iE 'applying|applied|error|refusing|phase 9 step 6|migration name|P3[0-9]{3}'
deploy_status=${PIPESTATUS[0]}
set -e
if [ "$deploy_status" -ne 0 ]; then
  echo "STEP6 PROOF: FAIL — prisma migrate deploy exited $deploy_status" >&2
  exit "$deploy_status"
fi

echo "== 3. snapshot AFTER =="
q "$RUN" "$AFTER_ENTRIES"   > "$OUT/entries.after"
q "$RUN" "$ROWS_SQL"        > "$OUT/rows.after"
q "$RUN" "$KEYORDER_AFTER"  > "$OUT/keyorder.after"
q "$RUN" "$REVERSE_SQL"     > "$OUT/reverse.after"

fail=0
report() { # name before after
  if diff -u "$2" "$3" > "$OUT/$1.diff"; then
    echo "  PASS  $1 ($(wc -l < "$2") lines compared)"
  else
    echo "  FAIL  $1 — $(grep -c '^[+-][^+-]' "$OUT/$1.diff") differing line(s), see $OUT/$1.diff"
    head -20 "$OUT/$1.diff"
    fail=1
  fi
}

echo "== 4. results =="
report entries  "$OUT/entries.before"  "$OUT/entries.after"
report rows     "$OUT/rows.before"     "$OUT/rows.after"
report keyorder "$OUT/keyorder.before" "$OUT/keyorder.after"

# Reverse check. The ONLY table excluded is `_prisma_migrations`, whose growth is the
# migration itself; it is printed rather than hidden. Everything else — the two converted
# tables' row counts, every other table's content digest, and every sequence's last_value —
# must be byte-identical.
MASK='^count|_prisma_migrations|\|^digest|_prisma_migrations|'
grep -v "$MASK" "$OUT/reverse.before" > "$OUT/reverse.before.masked"
grep -v "$MASK" "$OUT/reverse.after"  > "$OUT/reverse.after.masked"
report reverse "$OUT/reverse.before.masked" "$OUT/reverse.after.masked"
echo "  note  the migration ledger, the one table this step is supposed to change:"
grep "$MASK" "$OUT/reverse.before" | sed 's/^/          before /'
grep "$MASK" "$OUT/reverse.after"  | sed 's/^/          after  /'

# ---------------------------------------------------------------------------
# Controls. A check that can only say "nothing found" is not a check (C67), and that applies
# to each of the four comparisons separately — review finding m1/M6. Each control below
# corrupts the migrated database in one specific way and asserts that the matching comparison
# reports it.
# ---------------------------------------------------------------------------
echo "== 5. controls — each comparison is shown to be able to fail =="

# ⚠️ Each control starts from a freshly rebuilt, freshly migrated $RUN, so a control's diff
# is caused by that control alone. Running them cumulatively was the first version, and it
# made control 4's diff include control 2's deleted row — a control whose evidence is partly
# somebody else's corruption proves less than it appears to.
rebuild_run() {
  dropdb "$RUN"
  createdb -T "$PRISTINE" "$RUN"
  DATABASE_URL="postgresql://${PGUSER:-fondouser}:${STEP6_PW}@${PGHOST:-localhost}:${PGPORT:-5432}/$RUN?schema=public" \
  PRISMA_MIGRATIONS_PATH="$MIGRATIONS" \
  STEP6_CONFIRM="$(TZ=America/Bogota date +%F)" \
    npx prisma migrate deploy > "$OUT/rebuild.log" 2>&1
}

control() { # name, sql, snapshot-sql, before-file
  local name="$1" sql="$2" snap="$3" before="$4"
  rebuild_run
  psql -d "$RUN" -q -v ON_ERROR_STOP=1 -c "$sql"
  q "$RUN" "$snap" > "$OUT/$name.control"
  if diff -q "$before" "$OUT/$name.control" >/dev/null; then
    echo "  CONTROL FAILED  $name — the comparison did not notice. The probe is blind."
    fail=1
  else
    echo "  PASS  control $name: $(diff "$before" "$OUT/$name.control" | grep -c '^[<>]') differing line(s), as expected"
  fi
}

# 1. entries — a changed value.
control entries \
  "UPDATE fondo_api_schedulertask SET payload = jsonb_set(payload,'{message}','\"CONTROL\"') WHERE id = (SELECT min(id) FROM fondo_api_schedulertask)" \
  "$AFTER_ENTRIES" "$OUT/entries.before"

# 2. rows — a deleted row. This is the one the entries comparison alone cannot see when the
#    row is an empty hstore, which is why row identity is checked separately.
control rows \
  "DELETE FROM fondo_api_schedulertask WHERE id = (SELECT max(id) FROM fondo_api_schedulertask)" \
  "$ROWS_SQL" "$OUT/rows.before"

# 3. keyorder — a key renamed to a shorter one, which moves it in jsonb's (length, bytes)
#    ordering. ⚠️ Stated as a measurement, not a claim of isolation: jsonb's key order is a
#    function of the key SET, so a pure reordering with the same keys is unconstructible, and
#    this control necessarily moves the entries comparison too. What it shows is that the
#    keyorder comparison reports a changed order rather than passing on it.
control keyorder \
  "UPDATE fondo_api_schedulertask SET payload = (payload - 'message') || jsonb_build_object('msg', payload->'message') WHERE id = (SELECT min(id) FROM fondo_api_schedulertask)" \
  "$KEYORDER_AFTER" "$OUT/keyorder.before"

# 4. reverse — a row touched in an UNRELATED table. The count does not move, so this is the
#    control the old `count(DISTINCT xmin)` probe could not pass (M6).
#    Compared against the post-migration snapshot, not the pre-migration one, so the only
#    line that may differ is the unrelated table's digest.
control reverse_digest \
  "UPDATE fondo_api_loan SET value = value + 1 WHERE id = (SELECT min(id) FROM fondo_api_loan)" \
  "$REVERSE_SQL" "$OUT/reverse.after"

# ---------------------------------------------------------------------------
# The controls have deliberately corrupted $RUN. Rebuild it so the database that is left
# behind is the one the artifacts describe — review finding m7.
# ---------------------------------------------------------------------------
echo "== 6. rebuild $RUN so it matches the artifacts again =="
set +e
rebuild_run
rebuild_status=$?
set -e
if [ "$rebuild_status" -ne 0 ]; then
  echo "  WARNING: the rebuild deploy exited $rebuild_status — $RUN does NOT match the artifacts." >&2
  fail=1
else
  q "$RUN" "$AFTER_ENTRIES" > "$OUT/entries.after.rebuilt"
  if diff -q "$OUT/entries.before" "$OUT/entries.after.rebuilt" >/dev/null; then
    echo "  PASS  $RUN rebuilt and equal to the BEFORE snapshot again"
  else
    echo "  FAIL  rebuilt $RUN does not match the BEFORE snapshot"
    fail=1
  fi
fi

echo
echo "server: $(grep '^server_version|' "$OUT/server.txt" | cut -d'|' -f2), hstore $(grep '^hstore_extversion|' "$OUT/server.txt" | cut -d'|' -f2)"
if [ "$fail" -eq 0 ]; then
  echo "STEP6 PROOF: PASS   (artifacts in $OUT)"
else
  echo "STEP6 PROOF: FAIL   (artifacts in $OUT)"
fi
exit "$fail"
