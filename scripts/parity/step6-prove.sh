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

read -r -d '' REVERSE_SQL <<'SQL' || true
SELECT 'count' AS kind, c.relname AS name, n.n::text AS value
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
  CROSS JOIN LATERAL (SELECT (xpath('/row/c/text()',
      query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n) n
 WHERE c.relkind = 'r'
UNION ALL
SELECT 'xmin', c.relname, x.n::text
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
  CROSS JOIN LATERAL (SELECT (xpath('/row/c/text()',
      query_to_xml(format('SELECT count(DISTINCT xmin::text) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n) x
 WHERE c.relkind = 'r'
UNION ALL
SELECT 'sequence', sequencename, coalesce(last_value::text, '<unread>')
  FROM pg_sequences WHERE schemaname = 'public'
ORDER BY 1, 2;
SQL

q() { psql -d "$1" -At -F'|' -v ON_ERROR_STOP=1 -c "$2"; }

echo "== 0. build $RUN from $PRISTINE =="
if psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$RUN'" | grep -q 1; then dropdb "$RUN"; fi
createdb -T "$PRISTINE" "$RUN"

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
DATABASE_URL="postgresql://${PGUSER:-fondouser}:${STEP6_PW}@${PGHOST:-localhost}:${PGPORT:-5432}/$RUN?schema=public" \
PRISMA_MIGRATIONS_PATH="$MIGRATIONS" \
  npx prisma migrate deploy 2>&1 | redact | grep -E 'Applying|applied|Error|error'
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
# migration itself; it is printed rather than hidden. Everything else — including the two
# converted tables' row counts, every sequence's last_value, and every table's xmin
# cardinality — must be byte-identical.
#
# ⚠️ The converted tables' xmin cardinality is deliberately NOT excused. Measured 1 -> 1:
# `ALTER TABLE ... TYPE` plus the repair UPDATEs run in one transaction, so every rewritten
# row carries that single xid. A cardinality of 2 would mean something ran outside it.
MASK='^count|_prisma_migrations|\|^xmin|_prisma_migrations|'
grep -v "$MASK" "$OUT/reverse.before" > "$OUT/reverse.before.masked"
grep -v "$MASK" "$OUT/reverse.after"  > "$OUT/reverse.after.masked"
report reverse "$OUT/reverse.before.masked" "$OUT/reverse.after.masked"
echo "  note  the migration ledger, the one table this step is supposed to change:"
grep "$MASK" "$OUT/reverse.before" | sed 's/^/          before /'
grep "$MASK" "$OUT/reverse.after"  | sed 's/^/          after  /'

# A check that can only say "nothing found" is not a check (C67). Corrupt one value in the
# migrated database and confirm the entry comparison notices.
echo "== 5. positive control — mutate one row in $RUN and re-run the entry check =="
psql -d "$RUN" -q -v ON_ERROR_STOP=1 -c \
  "UPDATE fondo_api_schedulertask SET payload = jsonb_set(payload,'{message}','\"CONTROL\"') WHERE id = (SELECT min(id) FROM fondo_api_schedulertask)"
q "$RUN" "$AFTER_ENTRIES" > "$OUT/entries.after.control"
if diff -q "$OUT/entries.before" "$OUT/entries.after.control" >/dev/null; then
  echo "  CONTROL FAILED — the entry comparison did not notice a changed value. The probe is blind."
  fail=1
else
  echo "  PASS  control: $(diff "$OUT/entries.before" "$OUT/entries.after.control" | grep -c '^[<>]') differing line(s), as expected"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "STEP6 PROOF: PASS   (artifacts in $OUT)"
else
  echo "STEP6 PROOF: FAIL   (artifacts in $OUT)"
fi
exit "$fail"
