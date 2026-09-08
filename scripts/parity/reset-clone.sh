#!/usr/bin/env bash
# Reset a parity clone to its dump, IN PLACE.
#
# ⚠️ WHY THIS DOES NOT DROP THE DATABASE — false-green #23, and it is the only instance in the
# register that manufactured a false FAILURE rather than a false pass.
#
# The Phase 6 round's first version of this script did:
#     dropdb   "$DB" && createdb "$DB" && pg_restore -d "$DB" "$DUMP"
# After that, every `POST /api/saving-account` returned v1 500 / v2 200, and v1's traceback
# pointed at `services/notification.py`:
#     subscription['keys'] = subscription['keys'].replace("'", '"')
#     TypeError: string indices must be integers
# which reads exactly like "v1 crashes on CAP create". It does not. The chain is:
#
#   1. DROP/CREATE DATABASE re-creates the `hstore` extension with a NEW type OID.
#   2. Django 2.2 caches that OID per process — `django.contrib.postgres.apps.get_hstore_oids`
#      is @lru_cache'd.
#   3. A long-lived gunicorn therefore holds a STALE OID and silently stops casting
#      `HStoreField`, handing the service a raw string instead of a dict.
#
# Nothing in v1's logs says any of this. A false alarm costs more than a hidden defect: the
# output is an escalation to the business analyst, and possibly a "bug" ported into v2 that
# never existed in v1.
#
# So: TRUNCATE + `pg_restore --data-only`, which keeps the OID stable. And restart v1 after any
# reset anyway, then take a known-good control request BEFORE the matrix runs — one POST that
# succeeded before the reset and 500s after it, with no v2 change in between, is the signature.
set -euo pipefail

DB="${1:?usage: reset-clone.sh <clone-db> <dump-dir>}"
DUMP="${2:?usage: reset-clone.sh <clone-db> <dump-dir>}"

# Never the shared development database. Same guard every parity script carries.
if [ "$DB" = "fondodev" ]; then
  echo "REFUSING: $DB is the shared development database, not a clone." >&2
  exit 5
fi

# ⚠️ The invariant is asserted BEHAVIOURALLY, on the hstore OID, not by grepping this file for
# the word "dropdb".
#
# The first version of this guard did grep its own source -- and it could not fire: `grep -q`
# writes nothing to stdout, so the `| grep -v '^#'` after it read an empty stream and always
# exited 1. Measured: silent, exit 1, every time. A check that cannot fail, committed as the
# countermeasure for a false-green about checks that cannot fail (C67, C68 -- and the fix for
# false-green #23 itself). Removing the `-q` does not save it either: the pattern then matches
# this very line, which is not a comment, so the guard would refuse to run always.
#
# The OID comparison below has neither failure mode. It fails loudly if anyone reintroduces a
# drop/create by any name or any tool, and it cannot pass by accident.
OID_BEFORE=$(psql -tAq -d "$DB" -c "SELECT oid FROM pg_type WHERE typname = 'hstore'")
if [ -z "$OID_BEFORE" ]; then
  echo "REFUSING: no hstore type in $DB -- is this the right database?" >&2
  exit 7
fi

psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  SET session_replication_role = replica;
  DO \$\$
  DECLARE t record;
  BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP EXECUTE format('TRUNCATE TABLE public.%I CASCADE', t.tablename); END LOOP;
  END \$\$;
"

pg_restore --data-only --disable-triggers --no-owner -d "$DB" "$DUMP"

OID_AFTER=$(psql -tAq -d "$DB" -c "SELECT oid FROM pg_type WHERE typname = 'hstore'")
if [ "$OID_BEFORE" != "$OID_AFTER" ]; then
  echo "REFUSING: hstore OID moved ($OID_BEFORE -> $OID_AFTER) -- false-green #23." >&2
  echo "Django 2.2 caches this OID per process; a long-lived gunicorn has just silently" >&2
  echo "stopped casting HStoreField, and v1 will now look like it crashes on hstore writes." >&2
  exit 6
fi

echo "Reset $DB in place from $DUMP. hstore OID $OID_AFTER preserved."
echo "⚠️  Restart any long-lived v1 process now, then take a control request before measuring."
